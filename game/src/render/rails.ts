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
 * NOVATERRA — render/rails.ts — rail track geometry (0.1 Alpha).
 *
 * Grand-expansion Phase 4 (transport, S7): the visible rail network.
 * `buildRailGeometry` emits one merged mesh per sync: wooden/concrete
 * sleepers + twin steel rails for every rail cell, on a concrete slab
 * for high-speed track. `buildRailCatenary` emits the second merged
 * mesh: catenary posts + contact wire for electrified track classes
 * (electric, high-speed). Track classes render distinctly at a glance:
 *  - standard: brown wooden sleepers, plain twin rails.
 *  - electric: gray concrete sleepers, twin rails, catenary posts +
 *    a contact wire overhead.
 *  - high-speed: full concrete slab bed, twin rails, catenary posts +
 *    contact wire.
 *
 * Both builders are pure functions of their input: same cells in any
 * order → byte-identical geometry (cells are sorted before emission).
 * An optional `heightAt` callback drapes the track over the terrain
 * (sampled at the cell center — track pieces are small enough that
 * per-corner sampling buys nothing); without it the geometry stays
 * flat (the headless-test path).
 *
 * Rendering: the `RailOverlay` class owns the two merged meshes (one
 * draw call for track + sleepers, one for catenary on electrified
 * classes, 0 when the map has no rails) and rebuilds only when the
 * (cell, class) digest changes; `EntityRenderer` constructs it in its
 * constructor, syncs it in `sync()` from `world.city.rails`, and
 * disposes it in `dispose()`.
 *
 * Import-safe under Node/vitest (three.js has no DOM at import time);
 * unit-tested in tests/render.rails.test.ts.
 */

import * as THREE from 'three';

import { cellCoords, cellCenterWorld } from '../sim/city';

/**
 * One sim rail cell (structural — mirrors sim/city.ts `RailCell` without
 * importing sim values beyond the cell math, the same boundary
 * networks.ts keeps).
 */
export interface SimRailCell {
  cell: number;
  cls: TrackClassId;
}

/**
 * Pure: sim rail cells → world-space visuals for the builders.
 * Deterministic: same cells in any order → same list order after the
 * builders' own normalization.
 */
export function railCellsToVisual(rails: readonly SimRailCell[]): RailCellVisual[] {
  const out: RailCellVisual[] = [];
  for (const r of rails) {
    const { cx, cz } = cellCoords(r.cell);
    out.push({ x: cellCenterWorld(cx), z: cellCenterWorld(cz), cls: r.cls });
  }
  return out;
}

/** FNV-1a digest over (cell, class) pairs — the rebuild key. */
export function railOverlayDigest(rails: readonly SimRailCell[]): number {
  const sorted = [...rails].sort((a, b) => a.cell - b.cell);
  let h = 0x811c9dc5;
  for (const r of sorted) {
    const s = `${r.cell}:${r.cls};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

/**
 * Track class ids (mirrors sim/city.ts `TrackClass`; plain strings so
 * this module never imports sim values).
 */
export type TrackClassId = 'standard' | 'electric' | 'high-speed';

/** One rail cell: world-space center plus its track class. */
export interface RailCellVisual {
  x: number;
  z: number;
  cls: TrackClassId;
}

/** Track sits slightly above road ribbons so level crossings read. */
export const RAIL_TERRAIN_OFFSET = 0.12;
/** Catenary contact-wire height above the rail head. */
export const RAIL_WIRE_HEIGHT = 2.3;
/** Catenary post height. */
export const RAIL_POST_HEIGHT = 2.7;

/** sRGB hex → linear-space RGB triple for vertex colors. */
export function railColorLinear(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Colors (sRGB): */
export const RAIL_TIE_WOOD = 0x6b4e2e;
export const RAIL_TIE_CONCRETE = 0x9aa0a6;
export const RAIL_STEEL = 0x8f979e;
export const RAIL_SLAB = 0xb0b4b8;
export const RAIL_POST = 0x4a4f55;
export const RAIL_WIRE = 0x2c2f33;

/** Normalized cells with neighbor lookup + orientation. */
interface NormalizedRails {
  cells: Array<{ x: number; z: number; cls: TrackClassId }>;
  keys: Set<string>;
}

function cellKey(x: number, z: number): string {
  return `${x.toFixed(3)},${z.toFixed(3)}`;
}

function normalizeRails(
  input: RailCellVisual[],
  cellSize: number,
): NormalizedRails {
  const seen = new Set<string>();
  const cells: Array<{ x: number; z: number; cls: TrackClassId }> = [];
  for (const c of input) {
    const k = cellKey(c.x, c.z);
    if (seen.has(k)) continue;
    seen.add(k);
    cells.push({ x: c.x, z: c.z, cls: c.cls });
  }
  cells.sort((a, b) => (a.z === b.z ? a.x - b.x : a.z - b.z));
  return { cells, keys: new Set(cells.map((c) => cellKey(c.x, c.z))) };
}

/**
 * Track orientation per cell: 'x' (rails run east-west) or 'z'
 * (north-south), from orthogonal neighbors; diagonal neighbors break
 * ties toward the axis with more of them; isolated cells default to
 * 'x'. Deterministic.
 */
function cellOrientation(
  c: { x: number; z: number },
  keys: Set<string>,
  cellSize: number,
): 'x' | 'z' {
  const n = keys.has(cellKey(c.x, c.z - cellSize)) ? 1 : 0;
  const s = keys.has(cellKey(c.x, c.z + cellSize)) ? 1 : 0;
  const e = keys.has(cellKey(c.x + cellSize, c.z)) ? 1 : 0;
  const w = keys.has(cellKey(c.x - cellSize, c.z)) ? 1 : 0;
  if (n + s > 0 && e + w === 0) return 'z';
  if (e + w > 0 && n + s === 0) return 'x';
  if (n + s === 0 && e + w === 0) {
    // Diagonal neighbors only (or isolated): count diagonal axes.
    const ne = keys.has(cellKey(c.x + cellSize, c.z - cellSize)) ? 1 : 0;
    const sw = keys.has(cellKey(c.x - cellSize, c.z + cellSize)) ? 1 : 0;
    const nw = keys.has(cellKey(c.x - cellSize, c.z - cellSize)) ? 1 : 0;
    const se = keys.has(cellKey(c.x + cellSize, c.z + cellSize)) ? 1 : 0;
    if (ne + sw > nw + se) return 'z';
    if (nw + se > ne + sw) return 'x';
    return 'x';
  }
  // Junction-ish cells (both axes): follow the majority axis.
  return n + s >= e + w ? 'z' : 'x';
}

/**
 * Minimal colored-box list: positions + face normals + vertex colors +
 * indices. Boxes are axis-aligned in local (u, v) track space; the
 * caller maps (u, v) → world (x, z) by the cell orientation.
 */
class BoxList {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  /**
   * Add an axis-aligned box centered at (x, y, z) with size
   * (sx, sy, sz), painted `color` (sRGB hex → linear vertex colors).
   */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, color: number): void {
    const [r, g, b] = railColorLinear(color);
    const hx = sx / 2;
    const hy = sy / 2;
    const hz = sz / 2;
    // 6 faces × 4 verts: [corners, normal].
    const faces: Array<{ v: Array<[number, number, number]>; n: [number, number, number] }> = [
      {
        v: [
          [x - hx, y - hy, z + hz],
          [x + hx, y - hy, z + hz],
          [x - hx, y + hy, z + hz],
          [x + hx, y + hy, z + hz],
        ],
        n: [0, 0, 1],
      },
      {
        v: [
          [x + hx, y - hy, z - hz],
          [x - hx, y - hy, z - hz],
          [x + hx, y + hy, z - hz],
          [x - hx, y + hy, z - hz],
        ],
        n: [0, 0, -1],
      },
      {
        v: [
          [x + hx, y - hy, z + hz],
          [x + hx, y - hy, z - hz],
          [x + hx, y + hy, z + hz],
          [x + hx, y + hy, z - hz],
        ],
        n: [1, 0, 0],
      },
      {
        v: [
          [x - hx, y - hy, z - hz],
          [x - hx, y - hy, z + hz],
          [x - hx, y + hy, z - hz],
          [x - hx, y + hy, z + hz],
        ],
        n: [-1, 0, 0],
      },
      {
        v: [
          [x - hx, y + hy, z + hz],
          [x + hx, y + hy, z + hz],
          [x - hx, y + hy, z - hz],
          [x + hx, y + hy, z - hz],
        ],
        n: [0, 1, 0],
      },
      {
        v: [
          [x - hx, y - hy, z - hz],
          [x + hx, y - hy, z - hz],
          [x - hx, y - hy, z + hz],
          [x + hx, y - hy, z + hz],
        ],
        n: [0, -1, 0],
      },
    ];
    for (const f of faces) {
      const base = this.positions.length / 3;
      for (const [vx, vy, vz] of f.v) {
        this.positions.push(vx, vy, vz);
        this.normals.push(f.n[0], f.n[1], f.n[2]);
        this.colors.push(r, g, b);
      }
      // (a,c,b),(b,c,d): counter-clockwise seen from outside.
      this.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.normals), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.colors), 3));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    return geo;
  }

  get isEmpty(): boolean {
    return this.positions.length === 0;
  }
}

/** Track dimensions, in fractions of the cell size. */
const TIE_COUNT = 4;
const TIE_SPACING = 0.22; // along travel, in cell fractions
const TIE_W = 0.09; // tie width along travel
const TIE_LEN = 0.62; // tie length across travel
const TIE_H = 0.09;
const GAUGE = 0.34; // rail separation, cell fractions
const RAIL_W = 0.045;
const RAIL_H = 0.11;
const SLAB_W = 0.72; // high-speed slab width, cell fractions
const SLAB_H = 0.1;

/**
 * Emit one cell's track into the box list: sleepers across the travel
 * direction, twin rails along it, and (high-speed) a concrete slab
 * bed. `y0` is the terrain height at the cell center.
 */
function emitTrackCell(
  list: BoxList,
  c: { x: number; z: number; cls: TrackClassId },
  orient: 'x' | 'z',
  cellSize: number,
  y0: number,
): void {
  const alongX = orient === 'x';
  const tieColor = c.cls === 'standard' ? RAIL_TIE_WOOD : RAIL_TIE_CONCRETE;
  // High-speed slab first (the bed everything sits on).
  if (c.cls === 'high-speed') {
    const sw = cellSize * SLAB_W;
    const sh = SLAB_H;
    if (alongX) list.box(c.x, y0 + sh / 2, c.z, cellSize * 0.98, sh, sw, RAIL_SLAB);
    else list.box(c.x, y0 + sh / 2, c.z, sw, sh, cellSize * 0.98, RAIL_SLAB);
  }
  const baseY = y0 + (c.cls === 'high-speed' ? SLAB_H : 0);
  // Sleepers: spaced along travel, long across.
  for (let i = 0; i < TIE_COUNT; i++) {
    const t = (i - (TIE_COUNT - 1) / 2) * TIE_SPACING * cellSize;
    const tw = TIE_W * cellSize;
    const tl = TIE_LEN * cellSize;
    const th = TIE_H;
    if (alongX) list.box(c.x + t, baseY + th / 2, c.z, tw, th, tl, tieColor);
    else list.box(c.x, baseY + th / 2, c.z + t, tl, th, tw, tieColor);
  }
  // Twin rails along travel, at ±gauge/2 across.
  const railY = baseY + TIE_H + RAIL_H / 2;
  const railLen = cellSize * 0.98;
  const rw = RAIL_W * cellSize;
  const g = (GAUGE * cellSize) / 2;
  for (const s of [-1, 1]) {
    if (alongX) list.box(c.x, railY, c.z + s * g, railLen, RAIL_H, rw, RAIL_STEEL);
    else list.box(c.x + s * g, railY, c.z, rw, RAIL_H, railLen, RAIL_STEEL);
  }
}

/**
 * One merged track mesh: sleepers + rails (+ slab for high-speed).
 * Drapes on the terrain via `heightAt` (sampled at cell centers) or
 * stays flat at y=0 in the headless path.
 */
export function buildRailGeometry(
  input: RailCellVisual[],
  cellSize: number,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const { cells, keys } = normalizeRails(input, cellSize);
  const list = new BoxList();
  for (const c of cells) {
    const orient = cellOrientation(c, keys, cellSize);
    const y0 = (heightAt !== undefined ? heightAt(c.x, c.z) : 0) + RAIL_TERRAIN_OFFSET;
    emitTrackCell(list, c, orient, cellSize, y0);
  }
  return list.build();
}

/**
 * The catenary layer: one post per electrified cell (alternating
 * sides, deterministic) with a cross-arm, plus a contact wire along
 * the travel direction at RAIL_WIRE_HEIGHT. Empty geometry when no
 * cell is electric/high-speed (the caller skips the mesh then).
 */
export function buildRailCatenary(
  input: RailCellVisual[],
  cellSize: number,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const { cells, keys } = normalizeRails(input, cellSize);
  const list = new BoxList();
  const postW = 0.09;
  const armLen = cellSize * 0.5;
  const wireW = 0.03;
  let postIndex = 0;
  for (const c of cells) {
    if (c.cls !== 'electric' && c.cls !== 'high-speed') continue;
    const orient = cellOrientation(c, keys, cellSize);
    const alongX = orient === 'x';
    const y0 = (heightAt !== undefined ? heightAt(c.x, c.z) : 0) + RAIL_TERRAIN_OFFSET;
    // Alternate the post side per electrified cell (deterministic in
    // emission order) so the line doesn't lean one way forever.
    const side = postIndex % 2 === 0 ? 1 : -1;
    postIndex++;
    const px = alongX ? c.x : c.x + side * cellSize * 0.42;
    const pz = alongX ? c.z + side * cellSize * 0.42 : c.z;
    const ph = RAIL_POST_HEIGHT;
    list.box(px, y0 + ph / 2, pz, postW, ph, postW, RAIL_POST);
    // Cross-arm reaching over the track center.
    if (alongX) list.box(c.x, y0 + ph - 0.15, c.z + (side * cellSize * 0.21), armLen, 0.07, 0.07, RAIL_POST);
    else list.box(c.x + (side * cellSize * 0.21), y0 + ph - 0.15, c.z, 0.07, 0.07, armLen, RAIL_POST);
    // Contact wire along the travel direction.
    const wy = y0 + RAIL_WIRE_HEIGHT;
    const wl = cellSize * 0.98;
    if (alongX) list.box(c.x, wy, c.z, wl, wireW, wireW, RAIL_WIRE);
    else list.box(c.x, wy, c.z, wireW, wireW, wl, RAIL_WIRE);
  }
  return list.build();
}

/**
 * The rail-track overlay (C8, 0.1 Alpha): the always-on visible rail
 * network. Reads the sim's `city.rails` (cell indices + track class)
 * every sync and rebuilds its two merged meshes only when the
 * (cell, class) digest changes — static almost every frame.
 *
 * Rendering: 1 draw call for the track mesh (sleepers + rails + slab)
 * + 1 for the catenary mesh (posts + contact wire on electrified
 * classes), 0 when the map has no rails. Owned by `EntityRenderer`:
 * constructed in its constructor, synced in `sync()` from
 * `world.city.rails`, disposed in `dispose()`. Import-safe under
 * Node/vitest.
 */
export class RailOverlay {
  private readonly group = new THREE.Group();
  private trackMesh: THREE.Mesh | null = null;
  private catenaryMesh: THREE.Mesh | null = null;
  private lastDigest = -1;
  /** Rebuild counter (test/debug hook). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'rail-tracks';
    scene.add(this.group);
  }

  /**
   * Rebuild the track + catenary meshes only when the rail digest
   * changed since the last sync (the common path is one integer
   * compare). `cellSize` is the sim's world units per cell;
   * `heightFn` drapes the track on the terrain (flat at y=0 headless).
   */
  sync(
    rails: readonly SimRailCell[],
    cellSize: number,
    heightFn?: (x: number, z: number) => number,
  ): void {
    const digest = railOverlayDigest(rails);
    if (digest === this.lastDigest) return;
    this.lastDigest = digest;
    this.rebuild(rails, cellSize, heightFn);
    this.rebuilds++;
  }

  private clear(mesh: THREE.Mesh | null): null {
    if (mesh !== null) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    return null;
  }

  private rebuild(
    rails: readonly SimRailCell[],
    cellSize: number,
    heightFn: ((x: number, z: number) => number) | undefined,
  ): void {
    this.trackMesh = this.clear(this.trackMesh);
    this.catenaryMesh = this.clear(this.catenaryMesh);
    if (rails.length === 0) return;
    const visuals = railCellsToVisual(rails);
    const trackGeo = buildRailGeometry(visuals, cellSize, heightFn);
    this.trackMesh = new THREE.Mesh(
      trackGeo,
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    this.trackMesh.frustumCulled = false;
    this.trackMesh.renderOrder = 1;
    this.group.add(this.trackMesh);
    // Catenary only on electrified classes (empty geometry ⇒ no mesh).
    if (visuals.some((v) => v.cls === 'electric' || v.cls === 'high-speed')) {
      const catGeo = buildRailCatenary(visuals, cellSize, heightFn);
      this.catenaryMesh = new THREE.Mesh(
        catGeo,
        new THREE.MeshLambertMaterial({ vertexColors: true }),
      );
      this.catenaryMesh.frustumCulled = false;
      this.catenaryMesh.renderOrder = 1;
      this.group.add(this.catenaryMesh);
    }
  }

  /** Visible meshes = draw calls this frame (0..2). */
  drawCallCount(): number {
    let n = 0;
    if (this.trackMesh !== null) n++;
    if (this.catenaryMesh !== null) n++;
    return n;
  }

  /** Rebuild counter (test/debug hook). */
  debugRebuilds(): number {
    return this.rebuilds;
  }

  dispose(): void {
    this.trackMesh = this.clear(this.trackMesh);
    this.catenaryMesh = this.clear(this.catenaryMesh);
  }
}
