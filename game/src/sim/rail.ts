/**
 * NOVATERRA — sim/rail.ts — the rail network model (0.1 Alpha).
 *
 * Phase 4 transport (S7, grand expansion).
 *
 * Trains are RAIL-BOUND: they steer along rail cells, never across open
 * ground (the flow-field A* in pathfinding.ts would take them off the
 * tracks, so trains get their own dedicated 1-D BFS router here).
 *
 * Module-cycle discipline: this module imports ONLY TYPES from the sim
 * (RailCell, BuildingRecord, …). city.ts must stay value-import-free of
 * units/commands/movement, and movement.ts (the consumer) already
 * imports city + units — so rail.ts sits below all of them and imports
 * no values at all. See sim/AGENTS.md.
 */

import type { RailCell, TrackClass, BuildingRecord } from './city';
import { TRACK_CLASS_STATS } from './city';

/** 8-connectivity offsets in a FIXED order (deterministic BFS tie-breaks). */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],   // 0 east
  [1, 1],   // 1 south-east
  [0, 1],   // 2 south
  [-1, 1],  // 3 south-west
  [-1, 0],  // 4 west
  [-1, -1], // 5 north-west
  [0, -1],  // 6 north
  [1, -1],  // 7 north-east
];

/** Grid width (cells) — must match CITY_GRID_CELLS in city.ts. */
const GRID_W = 256;

function cxOf(cell: number): number {
  return cell % GRID_W;
}
function czOf(cell: number): number {
  return Math.floor(cell / GRID_W);
}
function at(cx: number, cz: number): number {
  return cz * GRID_W + cx;
}

/**
 * The rail cells a station "owns": the rail cells overlapping its
 * footprint, plus the rail cells orthogonally adjacent to the
 * footprint (the platform siding — trains don't have to thread the
 * station building itself).
 *
 * `def` is the station's BuildingDef (footprintW/footprintH) passed by
 * value-shape so this module never imports BUILDING_DEFS.
 */
export function stationRailCells(
  rails: RailCell[],
  station: BuildingRecord,
  def: { footprintW: number; footprintH: number },
): number[] {
  const cells: number[] = [];
  for (let dz = -1; dz <= def.footprintH; dz++) {
    for (let dx = -1; dx <= def.footprintW; dx++) {
      const cx = station.cx + dx;
      const cz = station.cz + dz;
      if (cx < 0 || cz < 0 || cx >= GRID_W || cz >= GRID_W) continue;
      // The loop covers the footprint plus a 1-cell ring; skip the
      // ring's diagonal corners (a train can't board through the
      // station's corner — boarding is orthogonal).
      const onEdgeX = dx === -1 || dx === def.footprintW;
      const onEdgeZ = dz === -1 || dz === def.footprintH;
      if (onEdgeX && onEdgeZ) continue;
      const cell = at(cx, cz);
      if (railSortedHasLocal(rails, cell)) cells.push(cell);
    }
  }
  cells.sort((a, b) => a - b);
  return cells;
}

/** Local binary search (rail.ts must not value-import city.ts helpers — keep this module self-contained). */
function railSortedHasLocal(rails: RailCell[], cell: number): boolean {
  let lo = 0;
  let hi = rails.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = (rails[mid] as RailCell).cell;
    if (v === cell) return true;
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * Dedicated 1-D BFS rail router.
 *
 * Finds a rail-cell path from ANY of `starts` (the rail cells under/near
 * the train — a train should already be sitting on rails) to ANY rail
 * cell of `stationCells` (see `stationRailCells`). 8-connectivity over
 * rail cells only, in the fixed DIRS order — deterministic: same
 * network + same endpoints = same route, every time.
 *
 * Returns the cell list from start to goal INCLUSIVE, or null when no
 * rail connection exists. `starts` SHOULD be sorted ascending for
 * determinism; the function sorts a copy defensively.
 */
export function findRailRoute(
  rails: RailCell[],
  starts: number[],
  stationCells: number[],
): number[] | null {
  if (starts.length === 0 || stationCells.length === 0) return null;
  const goals = new Set<number>(stationCells);
  const ordered = [...starts].sort((a, b) => a - b);
  // Immediate success: the train is already at the destination station.
  for (const s of ordered) {
    if (goals.has(s)) return [s];
  }
  const parent = new Map<number, number>();
  const queue: number[] = [];
  for (const s of ordered) {
    if (parent.has(s)) continue;
    parent.set(s, -1);
    queue.push(s);
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++] as number;
    const ccx = cxOf(cur);
    const ccz = czOf(cur);
    for (const [dx, dz] of DIRS) {
      const nx = ccx + dx;
      const nz = ccz + dz;
      if (nx < 0 || nz < 0 || nx >= GRID_W || nz >= GRID_W) continue;
      const n = at(nx, nz);
      if (!railSortedHasLocal(rails, n) || parent.has(n)) continue;
      parent.set(n, cur);
      if (goals.has(n)) {
        // Reconstruct: goal → … → start, then reverse.
        const route: number[] = [n];
        let p = cur;
        while (p !== -1) {
          route.push(p);
          p = parent.get(p) as number;
        }
        route.reverse();
        return route;
      }
      queue.push(n);
    }
  }
  return null;
}

/** Track class at a cell, or undefined when the cell has no rail. */
export function trackClassAt(rails: RailCell[], cell: number): TrackClass | undefined {
  let lo = 0;
  let hi = rails.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = rails[mid] as RailCell;
    if (r.cell === cell) return r.cls;
    if (r.cell < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * The speed multiplier for a rail-bound unit sitting on `cell`:
 * the track class's speedFactor (standard 1.0 / electric 1.4 /
 * high-speed 1.9 — TRACK_CLASS_STATS). A train on a non-rail cell
 * (shouldn't happen — trains never leave rails) keeps 1.0.
 */
export function trainTrackFactor(rails: RailCell[], cell: number): number {
  const cls = trackClassAt(rails, cell);
  return cls === undefined ? 1.0 : TRACK_CLASS_STATS[cls].speedFactor;
}
