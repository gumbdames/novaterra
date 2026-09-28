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
 * NOVATERRA — sim/spatial.ts — uniform spatial hash grid for entity queries.
 *
 * Responsibilities:
 *  - O(1) insert/remove/move of point entities; radius and rectangle
 *    queries for combat ("who's in weapon range?"), economy ("nearest
 *    depot?"), selection, and steering neighbors (see
 *    docs/research/sim-architecture.md §6.1).
 *  - Deterministic results: queries always return entity ids sorted
 *    ascending, regardless of cell layout or insertion history. The internal
 *    `Map`s are never iterated for query logic — query rectangles compute
 *    their cell range directly.
 *
 * Cell size (locked by this step; rationale in ARCHITECTURE.md D10):
 *  - 16 world units ≈ the largest common query radius expected for Phase 1
 *    units (weapon ranges 10–30 lock in step 7; steering radius ~6–10).
 *    A radius-16 query touches at most 3×3 = 9 cells. Revisit in step 7
 *    when weapon ranges are locked.
 *
 * Notes:
 *  - Entities are points for now (no footprint); multi-cell registration
 *    arrives with unit footprints in step 7.
 *  - The research recommends rebuilding the dynamic grid each tick rather
 *    than incremental updates; that rebuild loop lands in step 6/7 — this
 *    module is the structure it rebuilds into.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

/** Uniform spatial hash. Owns entity positions so queries are self-contained. */
export interface SpatialHash {
  /** World units per cell side. Fixed at creation. */
  readonly cellSize: number;
  /** cellKey → entity ids (insertion order; never iterated for logic). */
  readonly cells: Map<string, number[]>;
  /** entity id → cellKey. */
  readonly index: Map<number, string>;
  /** entity id → position. */
  readonly positions: Map<number, { x: number; z: number }>;
}

function checkFinite(value: number, what: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`spatial: ${what} must be a finite number, got ${value}`);
  }
}

function cellKey(cx: number, cz: number): string {
  return `${cx}:${cz}`;
}

function cellOf(sh: SpatialHash, x: number, z: number): [number, number] {
  return [Math.floor(x / sh.cellSize), Math.floor(z / sh.cellSize)];
}

/** Create an empty hash with the given cell size (must be finite and > 0). */
export function createSpatialHash(cellSize: number): SpatialHash {
  checkFinite(cellSize, 'cellSize');
  if (cellSize <= 0) {
    throw new Error(`spatial: cellSize must be > 0, got ${cellSize}`);
  }
  return {
    cellSize,
    cells: new Map<string, number[]>(),
    index: new Map<number, string>(),
    positions: new Map<number, { x: number; z: number }>(),
  };
}

/** Number of entities currently in the hash. */
export function shCount(sh: SpatialHash): number {
  return sh.index.size;
}

/** True if the id is registered. */
export function shHas(sh: SpatialHash, id: number): boolean {
  return sh.index.has(id);
}

/**
 * Insert a point entity. Throws if the id is already present (loud
 * rejections — use shMove for updates).
 */
export function shInsert(sh: SpatialHash, id: number, x: number, z: number): void {
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`spatial: id must be a non-negative integer, got ${id}`);
  }
  checkFinite(x, 'x');
  checkFinite(z, 'z');
  if (sh.index.has(id)) {
    throw new Error(`spatial: shInsert: id ${id} is already present`);
  }
  const [cx, cz] = cellOf(sh, x, z);
  const key = cellKey(cx, cz);
  let cell = sh.cells.get(key);
  if (cell === undefined) {
    cell = [];
    sh.cells.set(key, cell);
  }
  cell.push(id);
  sh.index.set(id, key);
  sh.positions.set(id, { x, z });
}

/**
 * Remove an entity. Returns true if one was present, false if unknown.
 * Emptied cells are dropped so the map never grows stale entries.
 */
export function shRemove(sh: SpatialHash, id: number): boolean {
  const key = sh.index.get(id);
  if (key === undefined) return false;
  const cell = sh.cells.get(key);
  if (cell === undefined) {
    throw new Error(`spatial: shRemove: internal inconsistency for id ${id}`);
  }
  const at = cell.indexOf(id);
  if (at === -1) {
    throw new Error(`spatial: shRemove: internal inconsistency for id ${id}`);
  }
  cell.splice(at, 1);
  if (cell.length === 0) sh.cells.delete(key);
  sh.index.delete(id);
  sh.positions.delete(id);
  return true;
}

/** Move a registered entity. Throws if the id is unknown. */
export function shMove(sh: SpatialHash, id: number, x: number, z: number): void {
  checkFinite(x, 'x');
  checkFinite(z, 'z');
  const key = sh.index.get(id);
  if (key === undefined) {
    throw new Error(`spatial: shMove: unknown id ${id}`);
  }
  const [cx, cz] = cellOf(sh, x, z);
  if (cellKey(cx, cz) === key) {
    // Same cell: positions update only, no structural change.
    sh.positions.set(id, { x, z });
    return;
  }
  // Cross-cell move: remove + reinsert (keeps one code path for indexing).
  const removed = shRemove(sh, id);
  if (!removed) {
    throw new Error(`spatial: shMove: internal inconsistency for id ${id}`);
  }
  shInsert(sh, id, x, z);
}

/**
 * Ids within distance `r` of (x, z), sorted ascending. Distance is
 * inclusive (<= r). Throws on negative radius.
 */
export function shQueryRadius(
  sh: SpatialHash,
  x: number,
  z: number,
  r: number,
): number[] {
  checkFinite(x, 'x');
  checkFinite(z, 'z');
  checkFinite(r, 'r');
  if (r < 0) {
    throw new Error(`spatial: shQueryRadius: r must be >= 0, got ${r}`);
  }
  const r2 = r * r;
  const [cx0, cz0] = cellOf(sh, x - r, z - r);
  const [cx1, cz1] = cellOf(sh, x + r, z + r);
  const out: number[] = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const cell = sh.cells.get(cellKey(cx, cz));
      if (cell === undefined) continue;
      for (const id of cell) {
        const p = sh.positions.get(id);
        if (p === undefined) {
          throw new Error(`spatial: query: internal inconsistency for id ${id}`);
        }
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz <= r2) out.push(id);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Ids inside the inclusive rectangle [x0,x1]×[z0,z1], sorted ascending.
 * Throws if the rectangle is inverted.
 */
export function shQueryRect(
  sh: SpatialHash,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number[] {
  checkFinite(x0, 'x0');
  checkFinite(z0, 'z0');
  checkFinite(x1, 'x1');
  checkFinite(z1, 'z1');
  if (x0 > x1 || z0 > z1) {
    throw new Error(
      `spatial: shQueryRect: inverted rectangle (${x0},${z0})-(${x1},${z1})`,
    );
  }
  const [cx0, cz0] = cellOf(sh, x0, z0);
  const [cx1, cz1] = cellOf(sh, x1, z1);
  const out: number[] = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const cell = sh.cells.get(cellKey(cx, cz));
      if (cell === undefined) continue;
      for (const id of cell) {
        const p = sh.positions.get(id);
        if (p === undefined) {
          throw new Error(`spatial: query: internal inconsistency for id ${id}`);
        }
        if (p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1) out.push(id);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}
