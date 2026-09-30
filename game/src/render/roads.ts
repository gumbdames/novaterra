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
 * NOVATERRA — render/roads.ts — connected road ribbon geometry (0.1 Alpha).
 *
 * Purpose: replace the old InstancedMesh-of-discs with real connected
 * road geometry. `buildRoadGeometry` emits one merged ribbon quad per
 * road cell (overlapping quads at junctions read as intersections —
 * same asphalt color, so the coplanar overlap has no visible z-fighting);
 * `buildRoadMarkings` emits a second merged geometry with center-line
 * dashes on straight runs (cells with exactly two opposite road
 * neighbors; junctions and dead ends get no dash).
 *
 * Both builders are pure functions of their input: same cells in any
 * order → byte-identical geometry (cells are sorted before emission),
 * so rebuilds are deterministic and don't shimmer. An optional
 * `heightAt` callback drapes the ribbon over the terrain (per-corner
 * sampling, so adjacent cells share identical corner heights and the
 * ribbon never cracks); without it the quads stay flat at ROAD_Y /
 * ROAD_DASH_Y (the legacy headless-test path).
 *
 * Rendering: one draw call per layer (asphalt mesh + dash mesh), created
 * by the caller (`render/entities.ts`) with the exported colors.
 *
 * Import-safe under Node/vitest (three.js has no DOM at import time);
 * fully unit-tested in tests/render.roads.test.ts.
 */

import * as THREE from 'three';

/** Road cells: world-space centers, or a boolean grid (grid[z][x]). */
export type RoadCellInput = Array<{ x: number; z: number }> | boolean[][];

/** Asphalt ribbon color (dark gray). */
export const ROAD_ASPHALT_COLOR = 0x2e3440;
/** Center-dash color (pale yellow). */
export const ROAD_DASH_COLOR = 0xe8d44d;
/** Ribbon height above the terrain. */
export const ROAD_Y = 0.15;
/** Dashes sit slightly above the ribbon (no z-fighting, no polygon offset). */
export const ROAD_DASH_Y = 0.18;
/**
 * Ribbon offset above the terrain surface in the terrain-draped path
 * (used when a `heightAt` callback is supplied).
 */
export const ROAD_RIBBON_TERRAIN_OFFSET = 0.08;
/**
 * Dash offset above the terrain surface in the terrain-draped path
 * (same 0.03 step above the ribbon as the flat path).
 */
export const ROAD_DASH_TERRAIN_OFFSET = 0.11;

/** Normalized cell list with an O(1) neighbor lookup. */
interface NormalizedCells {
  cells: Array<{ x: number; z: number }>;
  keys: Set<string>;
}

function cellKey(x: number, z: number): string {
  // Round to 3 decimals: world coords here are exact multiples of the
  // cell size, but the key must not depend on float dust from callers.
  return `${x.toFixed(3)},${z.toFixed(3)}`;
}

function normalizeCells(input: RoadCellInput, cellSize: number): NormalizedCells {
  const cells: Array<{ x: number; z: number }> = [];
  if (Array.isArray(input) && input.length > 0 && typeof (input[0] as { x?: number }).x === 'number') {
    for (const c of input as Array<{ x: number; z: number }>) {
      cells.push({ x: c.x, z: c.z });
    }
  } else {
    const grid = input as boolean[][];
    for (let z = 0; z < grid.length; z++) {
      const row = grid[z] as boolean[];
      if (!row) continue;
      for (let x = 0; x < row.length; x++) {
        if (row[x] === true) cells.push({ x: x * cellSize, z: z * cellSize });
      }
    }
  }
  // Dedupe (a repeated cell would double-draw and z-fight), then
  // deterministic emission order regardless of input order.
  const seen = new Set<string>();
  const unique: Array<{ x: number; z: number }> = [];
  for (const c of cells) {
    const k = cellKey(c.x, c.z);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(c);
    }
  }
  unique.sort((a, b) => (a.z === b.z ? a.x - b.x : a.z - b.z));
  const keys = new Set(unique.map((c) => cellKey(c.x, c.z)));
  return { cells: unique, keys };
}

/**
 * World-space size of one asphalt texture tile on the road ribbon.
 * The tireRubber roughness map repeats every 4 world units — large
 * enough that the grain never resolves into a visible grid, small
 * enough to break up the flat shading at RTS distance.
 */
export const ROAD_UV_WORLD_SCALE = 4;

/** Minimal quad-list mesh builder: positions + up normals + UVs + indices. */
class QuadList {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  /**
   * Box-style planar UVs for a quad's four corners, in world units
   * divided by `ROAD_UV_WORLD_SCALE` (shared by both emission paths so
   * the ribbon and its markings sample identically).
   */
  private quadUVs(x0: number, z0: number, x1: number, z1: number): void {
    const s = ROAD_UV_WORLD_SCALE;
    this.uvs.push(x0 / s, z0 / s, x1 / s, z0 / s, x0 / s, z1 / s, x1 / s, z1 / s);
  }

  /** Axis-aligned quad centered at (cx, y, cz), size (w × d). */
  quad(cx: number, y: number, cz: number, w: number, d: number): void {
    const base = this.positions.length / 3;
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - d / 2;
    const z1 = cz + d / 2;
    this.positions.push(x0, y, z0, x1, y, z0, x0, y, z1, x1, y, z1);
    for (let i = 0; i < 4; i++) this.normals.push(0, 1, 0);
    this.quadUVs(x0, z0, x1, z1);
    // Winding (a,c,b),(b,c,d): counter-clockwise seen from +y, same as
    // the terrain mesher (render/terrain.ts).
    this.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  /**
   * Axis-aligned quad centered at (cx, cz), size (w × d), draped over
   * the terrain: the height callback is sampled at the four corners
   * (plus `offset`), so adjacent cells sample their shared corners at
   * identical coordinates and the ribbon never cracks. Normals follow
   * the actual quad plane so slopes light correctly.
   */
  quadTerrain(
    cx: number,
    cz: number,
    w: number,
    d: number,
    height: (x: number, z: number) => number,
    offset: number,
  ): void {
    const base = this.positions.length / 3;
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - d / 2;
    const z1 = cz + d / 2;
    const y00 = height(x0, z0) + offset;
    const y10 = height(x1, z0) + offset;
    const y01 = height(x0, z1) + offset;
    const y11 = height(x1, z1) + offset;
    this.positions.push(x0, y00, z0, x1, y10, z0, x0, y01, z1, x1, y11, z1);
    // Face normal of triangle (a,c,b) = (c−a)×(b−a), matching the
    // emission winding above; its y component is (z1−z0)(x1−x0) > 0,
    // so it always points up.
    const dy1 = y01 - y00;
    const dy2 = y10 - y00;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(-dz * dy2, dz * dx, -dx * dy1);
    const inv = len > 0 ? 1 / len : 0;
    const nx = -dz * dy2 * inv;
    const ny = dz * dx * inv;
    const nz = -dx * dy1 * inv;
    for (let i = 0; i < 4; i++) this.normals.push(nx, ny, nz);
    this.quadUVs(x0, z0, x1, z1);
    this.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.normals), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uvs), 2));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * One merged ribbon quad per road cell. Adjacent cells share edges, so
 * straight runs read as continuous ribbons; at junctions the quads
 * overlap and read as intersections. When `heightAt` is supplied the
 * quads drape over the terrain (sampled per corner, `ROAD_Y` replaced
 * by `height + ROAD_RIBBON_TERRAIN_OFFSET`); otherwise they stay flat
 * at `ROAD_Y`.
 */
export function buildRoadGeometry(
  input: RoadCellInput,
  cellSize: number,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const { cells } = normalizeCells(input, cellSize);
  const quads = new QuadList();
  for (const c of cells) {
    if (heightAt !== undefined) {
      quads.quadTerrain(c.x, c.z, cellSize, cellSize, heightAt, ROAD_RIBBON_TERRAIN_OFFSET);
    } else {
      quads.quad(c.x, ROAD_Y, c.z, cellSize, cellSize);
    }
  }
  return quads.build();
}

/**
 * Merged center-line dashes: a thin pale strip along a cell's long axis,
 * emitted only for straight runs — cells with exactly two OPPOSITE road
 * neighbors (N+S or E+W). Junctions, dead ends, and isolated cells get
 * no dash. Drapes with the ribbon when `heightAt` is supplied (sitting
 * `ROAD_DASH_TERRAIN_OFFSET` above the terrain, i.e. the same 0.03 step
 * above the ribbon as the flat path), flat at `ROAD_DASH_Y` otherwise.
 */
export function buildRoadMarkings(
  input: RoadCellInput,
  cellSize: number,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const { cells, keys } = normalizeCells(input, cellSize);
  const quads = new QuadList();
  const dashLen = cellSize * 0.55;
  const dashWid = cellSize * 0.1;
  for (const c of cells) {
    const n = keys.has(cellKey(c.x, c.z - cellSize));
    const s = keys.has(cellKey(c.x, c.z + cellSize));
    const e = keys.has(cellKey(c.x + cellSize, c.z));
    const w = keys.has(cellKey(c.x - cellSize, c.z));
    let x0 = 0;
    let z0 = 0;
    let w0 = 0;
    let d0 = 0;
    if (n && s && !e && !w) {
      x0 = c.x;
      z0 = c.z;
      w0 = dashWid;
      d0 = dashLen;
    } else if (e && w && !n && !s) {
      x0 = c.x;
      z0 = c.z;
      w0 = dashLen;
      d0 = dashWid;
    }
    // Junctions (3-4 neighbors), dead ends (1), and isolated cells (0):
    // no dash.
    if (d0 === 0) continue;
    if (heightAt !== undefined) {
      quads.quadTerrain(x0, z0, w0, d0, heightAt, ROAD_DASH_TERRAIN_OFFSET);
    } else {
      quads.quad(x0, ROAD_DASH_Y, z0, w0, d0);
    }
  }
  return quads.build();
}
