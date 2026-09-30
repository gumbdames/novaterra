/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — sim/pathfinding.ts — grid pathfinding + time-sliced coordinator.
 *
 * Responsibilities:
 *  - Movement cost model over the 256×256 city grid: water is blocked,
 *    roads are cheap (`ROAD_COST_FACTOR`), everything else costs 1.
 *  - Plain 8-directional A* with a binary heap for single-unit paths.
 *    Corner cutting is prevented (a diagonal step needs both orthogonal
 *    neighbors passable). JPS was deliberately NOT used: on a 65k-cell
 *    grid plain A* is already far under the per-tick budget (measured in
 *    tests), and JPS's jump rules are a classic source of subtle,
 *    hard-to-test corner bugs. Revisit if profiling ever says otherwise
 *    (hierarchical routing is the step-7+ answer for bigger maps).
 *  - Dijkstra flow fields for group moves: one flood fill from the
 *    destination, every cell points at its best next step. O(grid) per
 *    field regardless of unit count — the research's recommended pattern
 *    (see docs/research/sim-architecture.md §5). The flood is chunked
 *    across ticks (`FIELD_POPS_PER_TICK` heap pops/tick) and stops early
 *    once every requesting unit's cell is reached, so a group order never
 *    blocks a tick; the build state is plain snapshot-safe data.
 *  - Time-sliced coordinator: two fixed per-tick budgets (never
 *    wall-clock, so determinism holds) — up to `PATHS_PER_TICK`
 *    synchronous A* searches, plus `FIELD_POPS_PER_TICK` flood pops on the
 *    single active field build. Units wait in `awaitingPath`; a completed
 *    request either hands the unit a path / field (→ `moving`) or fails
 *    it loudly (→ `failed`). No partial paths ever reach the movement
 *    system. A* searches that exceed `ASTAR_MAX_EXPANDED` expansions fall
 *    back to a chunked field instead of blowing the budget.
 *
 * Measured costs (dev VM, Meridian Plains 256×256 — NOT the
 * "sub-millisecond" the research assumed; see §5.5 notes): short A*
 * ~0.1–0.7 ms; full-component Dijkstra flood ~58 ms unchunked
 * (~34k pops); 600 pops ≈ 1 ms. Land/water is memoized per terrain
 * (`passabilityMask`, `landComponents`) so searches never do height math.
 *
 * Determinism: heap orders are total — A* breaks f-score ties by cell
 * index, field builds by insertion sequence (preserved across snapshots
 * via `nextTie`); neighbor iteration follows the fixed `DIRS` order;
 * Dijkstra direction ties pick the lowest direction index. Same world +
 * same requests ⇒ same paths, on any engine.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { TerrainData } from './terrain';
import type { CityState } from './city';
import {
  CITY_GRID_CELLS,
  CELL_WORLD_SIZE,
  MAP_HALF_SIZE,
  cellCoords,
  cellIndex,
  cellIsWater,
  inBounds,
} from './city';
import { clearUnitOrder, failUnitOrder, findUnit } from './units';

/** Road cells cost this × the base cost (Phase 1 engineering choice). */
export const ROAD_COST_FACTOR = 0.5;

/**
 * Synchronous A* searches completed per tick (FIFO). Measured on the dev VM
 * (Meridian Plains, 256×256): a typical short A* (tens of cells) costs
 * ~0.1–0.7 ms, so 3/tick keeps the common case inside the 2 ms pathfinding
 * budget. Searches that exceed ASTAR_MAX_EXPANDED expansions fall back to
 * a chunked flow field (see completePathRequest), so no single search can
 * blow the tick budget; cross-component queries return instantly via
 * `landComponents`.
 */
export const PATHS_PER_TICK = 3;

/**
 * A* gives up after this many expansions and the request falls back to a
 * chunked flow field instead. ~1000 expansions ≈ 2.9 ms on the dev VM
 * (vitest, warmed) — beyond that the synchronous search would break the
 * tick budget, while the field machinery handles long range in bounded
 * slices.
 */
export const ASTAR_MAX_EXPANDED = 1000;

/**
 * Dijkstra heap pops per tick for the active flow-field build (FIFO across
 * builds). Measured on the dev VM: a full-component flood is ~34k pops in
 * ~58 ms (≈1.7 µs/pop), so 600 pops ≈ 1 ms of flood progress per tick —
 * half the 2 ms pathfinding budget, the rest reserved for the A* slice.
 */
export const FIELD_POPS_PER_TICK = 600;

/** Fixed neighbor order (also the flow-field direction encoding 0–7). */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],   // 0 east
  [1, 1],   // 1 south-east
  [0, 1],   // 2 south
  [-1, 1],  // 3 south-west
  [-1, 0],  // 4 west
  [-1, -1], // 5 north-west
  [0, -1],  // 6 north
  [1, -1],  // 7 north-east
];

/** Flow-field cell value: 0–7 = step that way, 8 = unreachable, 9 = destination. */
export const FIELD_UNREACHABLE = 8;
export const FIELD_DESTINATION = 9;

/** World (x, z) → containing cell index. Clamps to the grid. */
export function worldToCell(x: number, z: number): number {
  const cx = Math.floor((x + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
  const cz = Math.floor((z + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
  const qx = Math.min(Math.max(cx, 0), CITY_GRID_CELLS - 1);
  const qz = Math.min(Math.max(cz, 0), CITY_GRID_CELLS - 1);
  return cellIndex(qx, qz);
}

/** Binary search over a sorted number array (roads are sorted ascending). */
function sortedHas(sorted: number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] as number;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Static land/water mask for a terrain, memoized per terrain object.
 * The terrain never changes, so the mask is a pure function of it — the
 * cache only avoids recomputing 65k bilinear height lookups on every
 * search. 1 = passable land, 0 = water.
 */
const maskCache = new WeakMap<TerrainData, Uint8Array>();
export function passabilityMask(t: TerrainData): Uint8Array {
  let mask = maskCache.get(t);
  if (!mask) {
    mask = new Uint8Array(gridCells());
    for (let cz = 0; cz < CITY_GRID_CELLS; cz++) {
      for (let cx = 0; cx < CITY_GRID_CELLS; cx++) {
        mask[cellIndex(cx, cz)] = cellIsWater(t, cx, cz) ? 0 : 1;
      }
    }
    maskCache.set(t, mask);
  }
  return mask;
}

/** Sea passability mask: 1 = water (passable for ships), 0 = land. */
const seaMaskCache = new WeakMap<TerrainData, Uint8Array>();
export function seaPassabilityMask(t: TerrainData): Uint8Array {
  let mask = seaMaskCache.get(t);
  if (!mask) {
    mask = new Uint8Array(gridCells());
    for (let cz = 0; cz < CITY_GRID_CELLS; cz++) {
      for (let cx = 0; cx < CITY_GRID_CELLS; cx++) {
        mask[cellIndex(cx, cz)] = cellIsWater(t, cx, cz) ? 1 : 0;
      }
    }
    seaMaskCache.set(t, mask);
  }
  return mask;
}

/**
 * Cost of ENTERING a cell: Infinity for water/out-of-bounds, 0.5 on roads,
 * 1.0 otherwise. Hot path — pure array lookups, no height math.
 */
function moveCost(mask: Uint8Array, roads: number[], cx: number, cz: number): number {
  if (!inBounds(cx, cz)) return Infinity;
  const cell = cellIndex(cx, cz);
  if ((mask[cell] as number) === 0) return Infinity;
  return sortedHas(roads, cell) ? ROAD_COST_FACTOR : 1;
}

/**
 * Cost of ENTERING a cell (public form, takes terrain + city).
 * Prefer the mask-based internals in hot loops.
 */
export function cellMoveCost(t: TerrainData, city: CityState, cx: number, cz: number): number {
  return moveCost(passabilityMask(t), city.roads, cx, cz);
}

/**
 * Large finite stand-in for infinity in flood distances. Must be
 * JSON-safe: real Infinity does not survive JSON snapshots (it becomes
 * null), and the chunked field-build state below IS snapshotted. The
 * largest real route cost is bounded by 65536 cells × √2 < 1e5.
 */
export const FLOOD_INF = 1e18;

/**
 * Connected land components of the terrain: 8-connectivity with the same
 * corner-cut rule movement uses (a diagonal step needs both orthogonal
 * neighbors passable). Static per terrain, memoized in a WeakMap (pure
 * function of the terrain — outcome-neutral cache).
 *
 * Used to short-circuit impossible queries: A* across components returns
 * null without exploring, and field builds skip units that sit in a
 * different component than the destination (they fail 'unreachable').
 */
const componentCache = new WeakMap<TerrainData, Int32Array>();
export function landComponents(t: TerrainData): Int32Array {
  let comp = componentCache.get(t);
  if (!comp) {
    const mask = passabilityMask(t);
    comp = new Int32Array(gridCells()).fill(-1);
    const stack: number[] = [];
    let nextId = 0;
    for (let cell = 0; cell < gridCells(); cell++) {
      if ((mask[cell] as number) === 0 || (comp[cell] as number) !== -1) continue;
      comp[cell] = nextId;
      stack.push(cell);
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        const cc = cellCoords(cur);
        for (let d = 0; d < 8; d++) {
          const [dx, dz] = DIRS[d] as readonly [number, number];
          const nx = cc.cx + dx;
          const nz = cc.cz + dz;
          if (!inBounds(nx, nz)) continue;
          const ncell = cellIndex(nx, nz);
          if ((mask[ncell] as number) === 0 || (comp[ncell] as number) !== -1) continue;
          if (dx !== 0 && dz !== 0) {
            if (
              (mask[cellIndex(cc.cx + dx, cc.cz)] as number) === 0 ||
              (mask[cellIndex(cc.cx, cc.cz + dz)] as number) === 0
            ) {
              continue;
            }
          }
          comp[ncell] = nextId;
          stack.push(ncell);
        }
      }
      nextId++;
    }
    componentCache.set(t, comp);
  }
  return comp;
}

// ---------------------------------------------------------------------------
// Sea pathfinding: ships navigate water with A* on the sea mask.
// ---------------------------------------------------------------------------

/**
 * Connected water components of the terrain: 8-connectivity with the same
 * corner-cut rule movement uses. Static per terrain, memoized in a WeakMap.
 * 1 = water cell in a component, -1 = land (impassable for ships).
 *
 * Used to short-circuit impossible queries: A* across components returns
 * null without exploring (a ship in one bay cannot reach another bay
 * separated by land).
 */
const seaComponentCache = new WeakMap<TerrainData, Int32Array>();
export function seaComponents(t: TerrainData): Int32Array {
  let comp = seaComponentCache.get(t);
  if (!comp) {
    const mask = seaPassabilityMask(t);
    comp = new Int32Array(gridCells()).fill(-1);
    const stack: number[] = [];
    let nextId = 0;
    for (let cell = 0; cell < gridCells(); cell++) {
      if ((mask[cell] as number) === 0 || (comp[cell] as number) !== -1) continue;
      comp[cell] = nextId;
      stack.push(cell);
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        const cc = cellCoords(cur);
        for (let d = 0; d < 8; d++) {
          const [dx, dz] = DIRS[d] as readonly [number, number];
          const nx = cc.cx + dx;
          const nz = cc.cz + dz;
          if (!inBounds(nx, nz)) continue;
          const ncell = cellIndex(nx, nz);
          if ((mask[ncell] as number) === 0 || (comp[ncell] as number) !== -1) continue;
          if (dx !== 0 && dz !== 0) {
            if (
              (mask[cellIndex(cc.cx + dx, cc.cz)] as number) === 0 ||
              (mask[cellIndex(cc.cx, cc.cz + dz)] as number) === 0
            ) {
              continue;
            }
          }
          comp[ncell] = nextId;
          stack.push(ncell);
        }
      }
      nextId++;
    }
    seaComponentCache.set(t, comp);
  }
  return comp;
}

/**
 * Cost of ENTERING a water cell: Infinity for land/out-of-bounds, 1.0
 * otherwise. Ships don't use roads.
 */
function seaMoveCost(mask: Uint8Array, cx: number, cz: number): number {
  if (!inBounds(cx, cz)) return Infinity;
  return (mask[cellIndex(cx, cz)] as number) === 0 ? Infinity : 1;
}

/**
 * A* for sea units on the water mask. Mirrors `findPath` but ships sail
 * on water (no roads, no land). Returns null path when the destination
 * is unreachable by water — callers must fail loudly, never hold forever.
 */
export function findSeaPath(
  t: TerrainData,
  start: number,
  goal: number,
  maxExpanded: number = Infinity,
): { path: number[] | null; expanded: number; capped: boolean } {
  if (start === goal) return { path: [start], expanded: 0, capped: false };
  const mask = seaPassabilityMask(t);
  // Cross-component queries are impossible — answer without exploring.
  if (seaComponents(t)[start] !== seaComponents(t)[goal]) {
    return { path: null, expanded: 0, capped: false };
  }
  const goalCoords = cellCoords(goal);
  if (seaMoveCost(mask, goalCoords.cx, goalCoords.cz) === Infinity) {
    return { path: null, expanded: 0, capped: false };
  }
  const startCoords = cellCoords(start);
  if (seaMoveCost(mask, startCoords.cx, startCoords.cz) === Infinity) {
    return { path: null, expanded: 0, capped: false };
  }

  const gScore = new Float64Array(gridCells()).fill(Infinity);
  const cameFrom = new Int32Array(gridCells()).fill(-1);
  const closed = new Uint8Array(gridCells());
  const open = new BinaryHeap();
  gScore[start] = 0;
  open.push(start, heuristic(start, goal));

  let expanded = 0;
  while (open.size > 0) {
    const current = open.pop();
    if (closed[current] === 1) continue;
    closed[current] = 1;
    expanded++;
    if (expanded > maxExpanded) {
      return { path: null, expanded, capped: true };
    }
    if (current === goal) {
      const path: number[] = [];
      let c: number = goal;
      while (c !== -1) {
        path.push(c);
        c = cameFrom[c] as number;
      }
      path.reverse();
      return { path, expanded, capped: false };
    }
    const { cx, cz } = cellCoords(current);
    const gCurrent = gScore[current] as number;
    for (let d = 0; d < 8; d++) {
      const [dx, dz] = DIRS[d] as readonly [number, number];
      const nx = cx + dx;
      const nz = cz + dz;
      const stepBase = seaMoveCost(mask, nx, nz);
      if (stepBase === Infinity) continue;
      // No corner cutting: both orthogonal neighbors must be water.
      if (dx !== 0 && dz !== 0) {
        if (
          seaMoveCost(mask, cx + dx, cz) === Infinity ||
          seaMoveCost(mask, cx, cz + dz) === Infinity
        ) {
          continue;
        }
      }
      const stepCost = dx !== 0 && dz !== 0 ? stepBase * SQRT2 : stepBase;
      const neighbor = cellIndex(nx, nz);
      const tentative = gCurrent + stepCost;
      if (tentative < (gScore[neighbor] as number)) {
        gScore[neighbor] = tentative;
        cameFrom[neighbor] = current;
        open.push(neighbor, tentative + heuristic(neighbor, goal));
      }
    }
  }
  return { path: null, expanded, capped: false };
}

// ---------------------------------------------------------------------------
// Binary heap with a total deterministic order (priority, then cell index).
// ---------------------------------------------------------------------------

class BinaryHeap {
  private cells: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.cells.length;
  }

  push(cell: number, prio: number): void {
    const cells = this.cells;
    const prios = this.prios;
    cells.push(cell);
    prios.push(prio);
    let i = cells.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(prios[i] as number, cells[i] as number, prios[parent] as number, cells[parent] as number)) {
        swap(cells, prios, i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): number {
    const cells = this.cells;
    const prios = this.prios;
    const top = cells[0] as number;
    const lastCell = cells.pop() as number;
    const lastPrio = prios.pop() as number;
    if (cells.length > 0) {
      cells[0] = lastCell;
      prios[0] = lastPrio;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (
          left < cells.length &&
          less(prios[left] as number, cells[left] as number, prios[smallest] as number, cells[smallest] as number)
        ) {
          smallest = left;
        }
        if (
          right < cells.length &&
          less(prios[right] as number, cells[right] as number, prios[smallest] as number, cells[smallest] as number)
        ) {
          smallest = right;
        }
        if (smallest === i) break;
        swap(cells, prios, i, smallest);
        i = smallest;
      }
    }
    return top;
  }
}

function less(prioA: number, cellA: number, prioB: number, cellB: number): boolean {
  return prioA < prioB || (prioA === prioB && cellA < cellB);
}

function swap(cells: number[], prios: number[], i: number, j: number): void {
  const tc = cells[i] as number;
  cells[i] = cells[j] as number;
  cells[j] = tc;
  const tp = prios[i] as number;
  prios[i] = prios[j] as number;
  prios[j] = tp;
}

// ---------------------------------------------------------------------------
// A* (8-directional, no corner cutting).
// ---------------------------------------------------------------------------

/**
 * Total cells in the pathfinding grid. Computed lazily, NOT at module
 * scope: this module sits in the city → world → pathfinding → city
 * import cycle, so a module-level `CITY_GRID_CELLS * CITY_GRID_CELLS`
 * reads an uninitialized binding (NaN) whenever pathfinding is first
 * reached through city — e.g. from a new entry point like the menu
 * demo — and the first move order then dies with
 * `RangeError: Invalid array length`. Every call site runs at sim time,
 * long after all modules are initialized.
 */
function gridCells(): number {
  return CITY_GRID_CELLS * CITY_GRID_CELLS;
}
const SQRT2 = Math.SQRT2;

/** Admissible octile heuristic scaled by the minimum cell cost (0.5). */
function heuristic(cell: number, goal: number): number {
  const a = cellCoords(cell);
  const b = cellCoords(goal);
  const dx = Math.abs(a.cx - b.cx);
  const dz = Math.abs(a.cz - b.cz);
  const diag = Math.min(dx, dz);
  const straight = Math.max(dx, dz) - diag;
  return ROAD_COST_FACTOR * (straight + diag * SQRT2);
}

/**
 * Shortest path as cell indices from `start` to `goal` (inclusive), or
 * null when unreachable. `expanded` counts popped cells (perf signal).
 * When `maxExpanded` is exceeded the search stops and reports
 * `capped: true` — the coordinator falls back to a chunked flow field
 * for the request instead of blocking the tick.
 */
export function findPath(
  t: TerrainData,
  city: CityState,
  start: number,
  goal: number,
  maxExpanded: number = Infinity,
): { path: number[] | null; expanded: number; capped: boolean } {
  if (start === goal) return { path: [start], expanded: 0, capped: false };
  // Mask lookup (no height math) in the hot loop; terrain is static.
  const mask = passabilityMask(t);
  const roads = city.roads;
  // Cross-component queries are impossible — answer without exploring.
  // (Both cells are land here in practice; water has component -1.)
  if (landComponents(t)[start] !== landComponents(t)[goal]) {
    return { path: null, expanded: 0, capped: false };
  }
  const goalCoords = cellCoords(goal);
  if (moveCost(mask, roads, goalCoords.cx, goalCoords.cz) === Infinity) {
    return { path: null, expanded: 0, capped: false };
  }
  const startCoords = cellCoords(start);
  if (moveCost(mask, roads, startCoords.cx, startCoords.cz) === Infinity) {
    return { path: null, expanded: 0, capped: false };
  }

  const gScore = new Float64Array(gridCells()).fill(Infinity);
  const cameFrom = new Int32Array(gridCells()).fill(-1);
  const closed = new Uint8Array(gridCells());
  const open = new BinaryHeap();
  gScore[start] = 0;
  open.push(start, heuristic(start, goal));

  let expanded = 0;
  while (open.size > 0) {
    const current = open.pop();
    if (closed[current] === 1) continue;
    closed[current] = 1;
    expanded++;
    if (expanded > maxExpanded) {
      return { path: null, expanded, capped: true };
    }
    if (current === goal) {
      const path: number[] = [];
      let c: number = goal;
      while (c !== -1) {
        path.push(c);
        c = cameFrom[c] as number;
      }
      path.reverse();
      return { path, expanded, capped: false };
    }
    const { cx, cz } = cellCoords(current);
    const gCurrent = gScore[current] as number;
    for (let d = 0; d < 8; d++) {
      const [dx, dz] = DIRS[d] as readonly [number, number];
      const nx = cx + dx;
      const nz = cz + dz;
      const stepBase = moveCost(mask, roads, nx, nz);
      if (stepBase === Infinity) continue;
      // No corner cutting: both orthogonal neighbors must be passable.
      if (dx !== 0 && dz !== 0) {
        if (
          moveCost(mask, roads, cx + dx, cz) === Infinity ||
          moveCost(mask, roads, cx, cz + dz) === Infinity
        ) {
          continue;
        }
      }
      const stepCost = dx !== 0 && dz !== 0 ? stepBase * SQRT2 : stepBase;
      const neighbor = cellIndex(nx, nz);
      const tentative = gCurrent + stepCost;
      if (tentative < (gScore[neighbor] as number)) {
        gScore[neighbor] = tentative;
        cameFrom[neighbor] = current;
        open.push(neighbor, tentative + heuristic(neighbor, goal));
      }
    }
  }
  return { path: null, expanded, capped: false };
}

// ---------------------------------------------------------------------------
// Flow fields: Dijkstra from the destination, chunked across ticks.
// ---------------------------------------------------------------------------

/** One flow field: every cell's best next step toward `destCell`. */
export interface FlowField {
  /** Id from `PathfindingState.nextFieldId` (0 is reserved = "none"). */
  id: number;
  destCell: number;
  /** Per-cell direction: 0–7 step that way, 8 unreachable, 9 destination. */
  dirs: number[];
}

/**
 * In-progress flow-field build. Every array is plain JSON-safe data (no
 * Infinity — see FLOOD_INF — and no Maps/Sets), so a build can be
 * snapshotted mid-flood and resume bit-identically: the heap's
 * (priority, tie) order is preserved verbatim and new pushes continue
 * the tie sequence from `nextTie`.
 */
export interface FieldBuild {
  fieldId: number;
  destCell: number;
  /** Requesting unit ids (re-tasked units are filtered out at finish). */
  unitIds: number[];
  /** 1 = a requesting unit stands on this cell and the flood hasn't reached it. */
  waitMark: number[];
  waitingCount: number;
  /** Best-known distance from destCell (FLOOD_INF = not yet reached). */
  dist: number[];
  /** 1 = popped — distance is final. */
  closed: number[];
  /** Binary min-heap on (priority, insertion tie) as parallel arrays. */
  heapCells: number[];
  heapPris: number[];
  heapTies: number[];
  nextTie: number;
  /**
   * When true, the flood stops as soon as every waiting unit cell is
   * reached. Correct because Dijkstra pops cells in nondecreasing
   * distance order: once the last waiting cell pops at distance D, every
   * cell a unit could ever step on (strictly closer to the destination
   * than D) is final, and each of those cells has a strictly-closer
   * neighbor that is final too — so the argmin that derives directions
   * below is exact.
   */
  earlyExit: boolean;
}

function heapLess(b: FieldBuild, a: number, c: number): boolean {
  const pa = b.heapPris[a] as number;
  const pc = b.heapPris[c] as number;
  if (pa !== pc) return pa < pc;
  return (b.heapTies[a] as number) < (b.heapTies[c] as number);
}

function heapSwap(b: FieldBuild, a: number, c: number): void {
  let tmp = b.heapCells[a] as number;
  b.heapCells[a] = b.heapCells[c] as number;
  b.heapCells[c] = tmp;
  tmp = b.heapPris[a] as number;
  b.heapPris[a] = b.heapPris[c] as number;
  b.heapPris[c] = tmp;
  tmp = b.heapTies[a] as number;
  b.heapTies[a] = b.heapTies[c] as number;
  b.heapTies[c] = tmp;
}

function heapPush(b: FieldBuild, cell: number, pri: number): void {
  b.heapCells.push(cell);
  b.heapPris.push(pri);
  b.heapTies.push(b.nextTie);
  b.nextTie += 1;
  let c = b.heapCells.length - 1;
  while (c > 0) {
    const p = (c - 1) >> 1;
    if (heapLess(b, c, p)) {
      heapSwap(b, c, p);
      c = p;
    } else {
      break;
    }
  }
}

/** Pops the min cell; returns -1 when the heap is empty. */
function heapPop(b: FieldBuild): number {
  const n = b.heapCells.length;
  if (n === 0) return -1;
  const top = b.heapCells[0] as number;
  const last = n - 1;
  b.heapCells[0] = b.heapCells[last] as number;
  b.heapPris[0] = b.heapPris[last] as number;
  b.heapTies[0] = b.heapTies[last] as number;
  b.heapCells.pop();
  b.heapPris.pop();
  b.heapTies.pop();
  let p = 0;
  for (;;) {
    const l = p * 2 + 1;
    const r = l + 1;
    let m = p;
    if (l < b.heapCells.length && heapLess(b, l, m)) m = l;
    if (r < b.heapCells.length && heapLess(b, r, m)) m = r;
    if (m === p) break;
    heapSwap(b, p, m);
    p = m;
  }
  return top;
}

/**
 * Start a flow-field build. `unitCells` are the requesting units' cells;
 * only units in the destination's land component can ever be reached, so
 * the rest are left out of the wait set (their field entries stay
 * UNREACHABLE and the units fail loudly at finish).
 */
export function beginFieldBuild(
  fieldId: number,
  destCell: number,
  unitIds: number[],
  unitCells: number[],
  mask: Uint8Array,
  roads: number[],
  comps: Int32Array,
  earlyExit: boolean,
): FieldBuild {
  const build: FieldBuild = {
    fieldId,
    destCell,
    unitIds: [...unitIds],
    waitMark: new Array<number>(gridCells()).fill(0),
    waitingCount: 0,
    dist: new Array<number>(gridCells()).fill(FLOOD_INF),
    closed: new Array<number>(gridCells()).fill(0),
    heapCells: [],
    heapPris: [],
    heapTies: [],
    nextTie: 0,
    earlyExit,
  };
  const dc = cellCoords(destCell);
  if (moveCost(mask, roads, dc.cx, dc.cz) === Infinity) {
    return build; // destination blocked: finishes immediately, all unreachable
  }
  build.dist[destCell] = 0;
  heapPush(build, destCell, 0);
  const destComp = comps[destCell] as number;
  for (const cell of unitCells) {
    if ((comps[cell] as number) === destComp && build.waitMark[cell] === 0) {
      build.waitMark[cell] = 1;
      build.waitingCount += 1;
    }
  }
  return build;
}

/**
 * Run up to `popsBudget` Dijkstra pops. Returns true when the build is
 * finished (every waiting cell reached, or the heap ran dry). Deterministic:
 * fixed neighbor order with (priority, tie) heap order.
 */
export function stepFieldBuild(
  build: FieldBuild,
  mask: Uint8Array,
  roads: number[],
  popsBudget: number,
): boolean {
  // Nothing to wait for (e.g. every unit was cross-component and got
  // filtered out of the wait set): finish without flooding.
  if (build.earlyExit && build.waitingCount === 0) return true;
  let pops = 0;
  while (pops < popsBudget && build.heapCells.length > 0) {
    const cell = heapPop(build);
    pops += 1;
    if (build.closed[cell] === 1) continue; // stale heap entry
    build.closed[cell] = 1;
    if (build.waitMark[cell] === 1) {
      build.waitMark[cell] = 0;
      build.waitingCount -= 1;
      if (build.earlyExit && build.waitingCount === 0) return true;
    }
    const cc = cellCoords(cell);
    const dCurrent = build.dist[cell] as number;
    // Reverse Dijkstra: dist[neighbor] is the FORWARD cost neighbor→dest
    // via `cell`, i.e. dist[cell] + the cost of ENTERING `cell` (node-entry
    // costs) in the forward direction — not the cost of entering the
    // neighbor, which would charge the reverse edge instead.
    const enterCurrent = moveCost(mask, roads, cc.cx, cc.cz);
    for (let d = 0; d < 8; d++) {
      const [dx, dz] = DIRS[d] as readonly [number, number];
      const nx = cc.cx + dx;
      const nz = cc.cz + dz;
      // The neighbor itself must be enterable (bounds + land); its own
      // move cost is irrelevant to this edge.
      if (moveCost(mask, roads, nx, nz) === Infinity) continue;
      if (dx !== 0 && dz !== 0) {
        if (
          moveCost(mask, roads, cc.cx + dx, cc.cz) === Infinity ||
          moveCost(mask, roads, cc.cx, cc.cz + dz) === Infinity
        ) {
          continue;
        }
      }
      const stepCost = dx !== 0 && dz !== 0 ? enterCurrent * SQRT2 : enterCurrent;
      const neighbor = cellIndex(nx, nz);
      const tentative = dCurrent + stepCost;
      if (tentative < (build.dist[neighbor] as number)) {
        build.dist[neighbor] = tentative;
        heapPush(build, neighbor, tentative);
      }
    }
  }
  // NOTE: when earlyExit is off (synchronous full flood) the build is done
  // only when the heap runs dry — waitingCount starts at 0 there.
  return build.heapCells.length === 0;
}

/**
 * Derive per-cell directions from a finished build. Each reached cell
 * points along the optimal first step toward the destination: the neighbor
 * minimizing (forward step cost + neighbor distance), i.e. the argmin of
 * the Bellman equation the flood just solved. Minimizing the neighbor
 * distance alone would be wrong with non-uniform costs (roads): a road
 * neighbor one cell farther can still be the cheaper first step, and the
 * same holds for diagonal vs orthogonal steps. Ties keep the lowest
 * direction index (deterministic). Diagonal candidates must pass the same
 * corner-cut rule as the flood and A*. Unreached cells are UNREACHABLE,
 * the destination is DESTINATION.
 */
export function finishFieldBuild(build: FieldBuild, mask: Uint8Array, roads: number[]): FlowField {
  const dirs = new Array<number>(gridCells());
  for (let cz = 0; cz < CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx < CITY_GRID_CELLS; cx++) {
      const cell = cz * CITY_GRID_CELLS + cx;
      if (cell === build.destCell) {
        dirs[cell] = FIELD_DESTINATION;
        continue;
      }
      const dHere = build.dist[cell] as number;
      if (dHere >= FLOOD_INF / 2) {
        dirs[cell] = FIELD_UNREACHABLE;
        continue;
      }
      let best = -1;
      let bestTotal = Infinity;
      for (let d = 0; d < 8; d++) {
        const [dx, dz] = DIRS[d] as readonly [number, number];
        const nx = cx + dx;
        const nz = cz + dz;
        if (!inBounds(nx, nz)) continue;
        const enterCost = moveCost(mask, roads, nx, nz);
        if (enterCost === Infinity) continue;
        if (dx !== 0 && dz !== 0) {
          if (
            moveCost(mask, roads, cx + dx, cz) === Infinity ||
            moveCost(mask, roads, cx, cz + dz) === Infinity
          ) {
            continue;
          }
        }
        const dNext = build.dist[nz * CITY_GRID_CELLS + nx] as number;
        if (dNext >= FLOOD_INF / 2) continue;
        const total = (dx !== 0 && dz !== 0 ? enterCost * SQRT2 : enterCost) + dNext;
        // Strictly better; ties keep the lowest direction index.
        if (total < bestTotal) {
          bestTotal = total;
          best = d;
        }
      }
      dirs[cell] = best === -1 ? FIELD_UNREACHABLE : best;
    }
  }
  return { id: build.fieldId, destCell: build.destCell, dirs };
}

/**
 * Synchronous full-grid flow field (no early exit). Used by tests and
 * benchmarks; the live game uses the chunked begin/step/finish path
 * through the coordinator below.
 */
export function computeFlowField(t: TerrainData, city: CityState, destCell: number): FlowField {
  const mask = passabilityMask(t);
  const build = beginFieldBuild(0, destCell, [], [], mask, city.roads, landComponents(t), false);
  stepFieldBuild(build, mask, city.roads, Number.MAX_SAFE_INTEGER);
  return finishFieldBuild(build, mask, city.roads);
}


/** True when the field gives the cell a usable direction (or it IS the destination). */
export function fieldReachable(field: FlowField, cell: number): boolean {
  return (field.dirs[cell] as number) !== FIELD_UNREACHABLE;
}

// ---------------------------------------------------------------------------
// Time-sliced coordinator state (lives in the world; snapshotted).
// ---------------------------------------------------------------------------

/** One pending single-unit path computation. */
export interface PathRequest {
  unitId: number;
  destCell: number;
}

/** One pending group flow-field computation. */
export interface FieldRequest {
  fieldId: number;
  destCell: number;
  unitIds: number[];
}

export interface PathfindingState {
  /** FIFO single-path requests. */
  queue: PathRequest[];
  /** FIFO flow-field requests (not yet started). */
  fieldQueue: FieldRequest[];
  /** The one field build currently progressing, chunked across ticks. */
  activeBuild: FieldBuild | null;
  /** Live flow fields (pruned when no unit references them). */
  fields: FlowField[];
  /** Next flow-field id. 0 is reserved ("no field"). */
  nextFieldId: number;
}

export function initPathfinding(): PathfindingState {
  return { queue: [], fieldQueue: [], activeBuild: null, fields: [], nextFieldId: 1 };
}

/** Queue an A* computation for a unit (unit must be `awaitingPath`). */
export function requestPath(world: World, unitId: number, destCell: number): void {
  dropUnitRequests(world, unitId);
  world.pathfinding.queue.push({ unitId, destCell });
}

/**
 * Queue a flow-field computation for a group. Returns the field id;
 * callers stamp it on the units before/while they wait.
 */
export function requestField(world: World, unitIds: number[], destCell: number): number {
  for (const id of unitIds) dropUnitRequests(world, id);
  const fieldId = world.pathfinding.nextFieldId;
  world.pathfinding.nextFieldId += 1;
  world.pathfinding.fieldQueue.push({ fieldId, destCell, unitIds: [...unitIds] });
  return fieldId;
}

/**
 * Remove every pending request mentioning `unitId` (retask/stop paths).
 * Field requests left with no units are dropped outright — no point
 * computing a field nobody will follow. (An already-started build is
 * filtered at finish instead; see finishFieldRequest.)
 */
export function dropUnitRequests(world: World, unitId: number): void {
  const pf = world.pathfinding;
  pf.queue = pf.queue.filter((r) => r.unitId !== unitId);
  const kept: FieldRequest[] = [];
  for (const r of pf.fieldQueue) {
    const units = r.unitIds.filter((id) => id !== unitId);
    if (units.length > 0) kept.push({ fieldId: r.fieldId, destCell: r.destCell, unitIds: units });
  }
  pf.fieldQueue = kept;
}

function completePathRequest(world: World, t: TerrainData, req: PathRequest): void {
  const unit = findUnit(world, req.unitId);
  // Stale request (unit retasked/stopped without dropping — defensive).
  if (!unit || unit.state !== 'awaitingPath' || unit.fieldId !== 0) return;
  const startCell = worldToCell(unit.x, unit.z);
  if (startCell === req.destCell) {
    clearUnitOrder(unit);
    unit.state = 'idle';
    unit.failReason = null;
    return;
  }
  const { path, capped } =
    unit.domain === 'sea'
      ? findSeaPath(t, startCell, req.destCell, ASTAR_MAX_EXPANDED)
      : findPath(t, world.city, startCell, req.destCell, ASTAR_MAX_EXPANDED);
  if (capped) {
    if (unit.domain === 'sea') {
      // Sea units don't use flow fields (land-only system): a capped sea
      // search fails loudly rather than falling back to a wrong-domain field.
      failUnitOrder(unit, 'no path: destination unreachable by water');
      return;
    }
    // Long-range request: a synchronous search would blow the tick budget.
    // Fall back to a chunked flow field; the unit keeps waiting.
    const fieldId = requestField(world, [unit.id], req.destCell);
    unit.fieldId = fieldId;
    return;
  }
  if (path === null) {
    failUnitOrder(
      unit,
      unit.domain === 'sea'
        ? 'no path: destination unreachable by water'
        : 'no path: destination unreachable',
    );
    return;
  }
  unit.path = path;
  unit.pathAt = 1; // path[0] is the cell the unit already stands in
  unit.state = 'moving';
  unit.failReason = null;
}

/**
 * Begin the next queued field build, or null when none of its units still
 * wants it (all re-tasked/stopped while queued).
 */
function beginFieldRequest(world: World, t: TerrainData, req: FieldRequest): FieldBuild | null {
  const live: number[] = [];
  const cells: number[] = [];
  for (const id of req.unitIds) {
    const unit = findUnit(world, id);
    if (unit && unit.state === 'awaitingPath' && unit.fieldId === req.fieldId) {
      live.push(id);
      // The unit's cell plus a one-cell margin: separation can nudge a
      // unit across a cell boundary while the field builds, and early
      // exit must not leave such a cell unreached (that would be a
      // 'flow field dead end' for a properly ordered unit). Duplicates
      // are deduped by waitMark in beginFieldBuild.
      const { cx, cz } = cellCoords(worldToCell(unit.x, unit.z));
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const nz = cz + dz;
          if (nx < 0 || nz < 0 || nx >= CITY_GRID_CELLS || nz >= CITY_GRID_CELLS) continue;
          cells.push(cellIndex(nx, nz));
        }
      }
    }
  }
  if (live.length === 0) return null;
  const mask = passabilityMask(t);
  return beginFieldBuild(
    req.fieldId, req.destCell, live, cells, mask, world.city.roads, landComponents(t), true,
  );
}

/** True when at least one unit still waits on this build. */
function buildStillWanted(world: World, build: FieldBuild): boolean {
  return build.unitIds.some((id) => {
    const unit = findUnit(world, id);
    return !!unit && unit.state === 'awaitingPath' && unit.fieldId === build.fieldId;
  });
}

/** Publish a finished build: store the field, move reachable units, fail the rest. */
function finishFieldRequest(world: World, t: TerrainData, build: FieldBuild): void {
  const field = finishFieldBuild(build, passabilityMask(t), world.city.roads);
  world.pathfinding.fields.push(field);
  for (const id of build.unitIds) {
    const unit = findUnit(world, id);
    if (!unit || unit.state !== 'awaitingPath' || unit.fieldId !== build.fieldId) continue;
    const cell = worldToCell(unit.x, unit.z);
    if (!fieldReachable(field, cell)) {
      failUnitOrder(unit, 'no path: unreachable by flow field');
      continue;
    }
    unit.state = 'moving';
    unit.failReason = null;
  }
}

/** Drop flow fields no living unit references anymore. */
function pruneFields(world: World): void {
  const pf = world.pathfinding;
  pf.fields = pf.fields.filter((f) => world.units.some((u) => u.fieldId === f.id));
}

/**
 * Time-sliced pathfinding, two fixed budgets per tick (deterministic —
 * never wall-clock):
 *  1. up to PATHS_PER_TICK synchronous A* searches (FIFO);
 *  2. up to FIELD_POPS_PER_TICK Dijkstra pops on the single active field
 *     build (FIFO across builds).
 * Then unreferenced fields are pruned. Runs as a system before movement
 * each tick. Overflow waits for the next tick — units stay `awaitingPath`
 * until their computation completes.
 */
export function runPathfinding(world: World, t: TerrainData): void {
  const pf = world.pathfinding;
  let n = 0;
  while (n < PATHS_PER_TICK && pf.queue.length > 0) {
    const req = pf.queue.shift() as PathRequest;
    completePathRequest(world, t, req);
    n += 1;
  }
  if (!pf.activeBuild && pf.fieldQueue.length > 0) {
    const req = pf.fieldQueue.shift() as FieldRequest;
    pf.activeBuild = beginFieldRequest(world, t, req);
  }
  if (pf.activeBuild) {
    const build = pf.activeBuild;
    if (!buildStillWanted(world, build)) {
      pf.activeBuild = null; // everyone re-tasked/stopped mid-build
    } else {
      const mask = passabilityMask(t);
      const done = stepFieldBuild(build, mask, world.city.roads, FIELD_POPS_PER_TICK);
      if (done) {
        finishFieldRequest(world, t, build);
        pf.activeBuild = null;
      }
    }
  }
  pruneFields(world);
}

/** Look up a live flow field by id. */
export function findField(world: World, fieldId: number): FlowField | undefined {
  return world.pathfinding.fields.find((f) => f.id === fieldId);
}


