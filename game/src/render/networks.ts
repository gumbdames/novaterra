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
 * NOVATERRA — render/networks.ts — utility network runs (0.1 Alpha).
 *
 * Phase 2 (utilities): the physical runs the player builds with the drag
 * tools — power lines (`city.powerLines`) and water pipes (`city.pipes`).
 * Unlike the diagnostic overlay (render/utilityOverlay.ts), these render
 * ALWAYS once built: they are city structures the player paid for, the
 * same way roads render always.
 *
 * Power lines: one wooden pole per cell (box + cross-arm) with sagging
 * wire ribbons to the E/S neighbors — pole-and-wire runs, not glowing
 * lines, so they read as infrastructure at RTS distance.
 * Water pipes: low steel-blue ribbons (pads + links), terrain-draped.
 *
 * The builders are pure functions of their input (sorted emission, so
 * same cells in any order → byte-identical geometry); the optional
 * `heightFn` drapes everything over the terrain (per-corner sampling, so
 * adjacent cells share heights and nothing cracks). Import-safe under
 * Node/vitest; fully unit-tested in tests/render.networks.test.ts.
 */

import * as THREE from 'three';

import { cellCoords, cellCenterWorld } from '../sim/city';

/** Wooden pole color. */
export const POLE_COLOR = 0x6b4f2e;
/** Wire color (dark silhouette). */
export const WIRE_COLOR = 0x23272e;
/** Water pipe color (steel blue — per-network tint vs power). */
export const PIPE_COLOR = 0x3d6e8c;
/** Pole height above the terrain (world units). */
export const POLE_HEIGHT = 3.4;
/** Wire attachment height on the pole (below the cross-arm). */
export const WIRE_HEIGHT = 3.1;
/** Wire ribbon width. */
export const WIRE_WIDTH = 0.09;
/** Wire sag at mid-span (reads as a real catenary from RTS height). */
export const WIRE_SAG = 0.35;
/** Pipe ribbon width. */
export const PIPE_WIDTH = 0.55;
/** Pipe junction pad size. */
export const PIPE_PAD = 0.75;
/** Pipe offset above the terrain. */
export const PIPE_TERRAIN_OFFSET = 0.06;

/** Minimal position+normal triangle-list emitter (shared by all builders). */
class TriList {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];

  /** Emit an axis-aligned box centered at (x, yBase + h/2, z). */
  box(x: number, yBase: number, z: number, w: number, h: number, d: number): void {
    const x0 = x - w / 2;
    const x1 = x + w / 2;
    const y0 = yBase;
    const y1 = yBase + h;
    const z0 = z - d / 2;
    const z1 = z + d / 2;
    // 8 corners.
    const v = this.positions.length / 3;
    this.positions.push(
      x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1,
      x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1,
    );
    // Flat normals per face: emit 6 faces as 12 triangles with explicit
    // per-face normals (12 corner normals would smooth the shading).
    const faces: Array<{ idx: number[]; n: [number, number, number] }> = [
      { idx: [0, 1, 2, 0, 2, 3], n: [0, -1, 0] },
      { idx: [4, 6, 5, 4, 7, 6], n: [0, 1, 0] },
      { idx: [0, 4, 5, 0, 5, 1], n: [0, 0, -1] },
      { idx: [2, 6, 7, 2, 7, 3], n: [0, 0, 1] },
      { idx: [0, 3, 7, 0, 7, 4], n: [-1, 0, 0] },
      { idx: [1, 5, 6, 1, 6, 2], n: [1, 0, 0] },
    ];
    for (const f of faces) {
      for (const i of f.idx) {
        this.normals.push(...f.n);
        this.indices.push(v + i);
      }
    }
  }

  /** Emit a flat horizontal quad (up normal) from 4 corners. */
  quad(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
  ): void {
    const v = this.positions.length / 3;
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i++) this.normals.push(0, 1, 0);
    this.indices.push(v, v + 2, v + 1, v, v + 3, v + 2);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geo.setIndex(this.indices);
    return geo;
  }

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }
}

/** A cell with grid + world coords and its terrain height. */
interface NetCell {
  cell: number;
  cx: number;
  cz: number;
  x: number;
  z: number;
  h: number;
}

function normalizeCells(
  cells: readonly number[],
  cellSize: number,
  heightFn: ((x: number, z: number) => number) | undefined,
): { list: NetCell[]; byCoord: Map<string, NetCell> } {
  const seen = new Set<number>();
  const list: NetCell[] = [];
  for (const cell of cells) {
    if (!Number.isInteger(cell) || cell < 0 || seen.has(cell)) continue;
    seen.add(cell);
    const { cx, cz } = cellCoords(cell);
    const x = cellCenterWorld(cx);
    const z = cellCenterWorld(cz);
    list.push({ cell, cx, cz, x, z, h: heightFn !== undefined ? heightFn(x, z) : 0 });
  }
  // Deterministic emission regardless of input order.
  list.sort((a, b) => (a.cz === b.cz ? a.cx - b.cx : a.cz - b.cz));
  const byCoord = new Map<string, NetCell>();
  for (const c of list) byCoord.set(`${c.cx},${c.cz}`, c);
  void cellSize;
  return { list, byCoord };
}

/**
 * Build the power-line geometry for a cell set: poles (one per cell,
 * box + cross-arm) and sagging wire ribbons to the E/S neighbors.
 * Returns the two merged geometries (poles, wires).
 */
export function buildPowerLineGeometry(
  cells: readonly number[],
  cellSize: number,
  heightFn?: (x: number, z: number) => number,
): { poles: THREE.BufferGeometry; wires: THREE.BufferGeometry } {
  const { list, byCoord } = normalizeCells(cells, cellSize, heightFn);
  const poleList = new TriList();
  const wireList = new TriList();
  for (const c of list) {
    // Pole: box + cross-arm.
    poleList.box(c.x, c.h, c.z, 0.35, POLE_HEIGHT, 0.35);
    poleList.box(c.x, c.h + POLE_HEIGHT - 0.35, c.z, 1.5, 0.14, 0.14);
    // Wires to the E and S neighbors (deduped: each pair emitted once).
    const ends = [
      { nx: c.x, nz: c.z, nh: c.h },
    ];
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const n = byCoord.get(`${c.cx + dx},${c.cz + dz}`);
      if (n === undefined) continue;
      ends.push({ nx: n.x, nz: n.z, nh: n.h });
    }
    for (let i = 1; i < ends.length; i++) {
      const a = ends[0]!;
      const b = ends[i]!;
      const ax = a.nx;
      const az = a.nz;
      const bx = b.nx;
      const bz = b.nz;
      const ah = a.nh + WIRE_HEIGHT;
      const bh = b.nh + WIRE_HEIGHT;
      // Ribbon perpendicular to the run direction (horizontal).
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz) || 1;
      const px = (-dz / len) * (WIRE_WIDTH / 2);
      const pz = (dx / len) * (WIRE_WIDTH / 2);
      // 3 segments with a sagging mid-span.
      const SEG = 3;
      let prevLeft: [number, number, number] | null = null;
      let prevRight: [number, number, number] | null = null;
      for (let s = 0; s <= SEG; s++) {
        const t = s / SEG;
        const sag = WIRE_SAG * 4 * t * (1 - t);
        const x = ax + dx * t;
        const z = az + dz * t;
        const y = ah + (bh - ah) * t - sag;
        const left: [number, number, number] = [x - px, y, z - pz];
        const right: [number, number, number] = [x + px, y, z + pz];
        if (prevLeft !== null && prevRight !== null) {
          wireList.quad(
            prevLeft[0], prevLeft[1], prevLeft[2],
            prevRight[0], prevRight[1], prevRight[2],
            right[0], right[1], right[2],
            left[0], left[1], left[2],
          );
        }
        prevLeft = left;
        prevRight = right;
      }
    }
  }
  return { poles: poleList.build(), wires: wireList.build() };
}

/**
 * Build the water-pipe geometry for a cell set: a low steel-blue ribbon
 * — a junction pad per cell plus links to the E/S neighbors, draped over
 * the terrain.
 */
export function buildPipeGeometry(
  cells: readonly number[],
  cellSize: number,
  heightFn?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const { list, byCoord } = normalizeCells(cells, cellSize, heightFn);
  const quads = new TriList();
  const off = PIPE_TERRAIN_OFFSET;
  for (const c of list) {
    const hp = PIPE_PAD / 2;
    quads.quad(
      c.x - hp, c.h + off, c.z - hp,
      c.x + hp, c.h + off, c.z - hp,
      c.x + hp, c.h + off, c.z + hp,
      c.x - hp, c.h + off, c.z + hp,
    );
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      const n = byCoord.get(`${c.cx + dx},${c.cz + dz}`);
      if (n === undefined) continue;
      // Link ribbon between cell centers, width PIPE_WIDTH.
      const ax = c.x;
      const az = c.z;
      const bx = n.x;
      const bz = n.z;
      const ddx = bx - ax;
      const ddz = bz - az;
      const len = Math.hypot(ddx, ddz) || 1;
      const px = (-ddz / len) * (PIPE_WIDTH / 2);
      const pz = (ddx / len) * (PIPE_WIDTH / 2);
      quads.quad(
        ax - px, c.h + off, az - pz,
        ax + px, c.h + off, az + pz,
        bx + px, n.h + off, bz + pz,
        bx - px, n.h + off, bz - pz,
      );
    }
  }
  return quads.build();
}

/**
 * FNV-1a digest over a cell set (order-independent: cells are sorted
 * first). Rebuilds happen only when the digest changes.
 */
export function networkDigest(cells: readonly number[]): number {
  const sorted = [...cells].sort((a, b) => a - b);
  let h = 0x811c9dc5;
  for (const c of sorted) {
    h ^= c & 0xffffffff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The always-on network overlay: power-line poles+wires and water-pipe
 * ribbons. Owned by `EntityRenderer` (created in its constructor, synced
 * in `sync()`, disposed in `dispose()`); reads `world.city.powerLines` /
 * `world.city.pipes` defensively (empty pre-sim → no meshes).
 */
export class NetworkOverlay {
  private readonly group = new THREE.Group();
  private poleMesh: THREE.Mesh | null = null;
  private wireMesh: THREE.Mesh | null = null;
  private pipeMesh: THREE.Mesh | null = null;
  private lastPowerDigest = -1;
  private lastPipeDigest = -1;
  /** Rebuild counter (test/debug hook — the node-stability proof). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'utility-networks';
    scene.add(this.group);
  }

  /**
   * Rebuild the run meshes only when the cell digests changed since the
   * last sync (static almost every frame: the common path is two integer
   * compares).
   */
  sync(
    powerLines: readonly number[] | undefined,
    pipes: readonly number[] | undefined,
    cellSize: number,
    heightFn?: (x: number, z: number) => number,
  ): void {
    const lines = powerLines ?? [];
    const pipelist = pipes ?? [];
    const powerDigest = networkDigest(lines);
    const pipeDigest = networkDigest(pipelist);
    if (powerDigest !== this.lastPowerDigest) {
      this.lastPowerDigest = powerDigest;
      this.rebuildPower(lines, cellSize, heightFn);
    }
    if (pipeDigest !== this.lastPipeDigest) {
      this.lastPipeDigest = pipeDigest;
      this.rebuildPipes(pipelist, cellSize, heightFn);
    }
  }

  private clear(mesh: THREE.Mesh | null): null {
    if (mesh !== null) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    return null;
  }

  private rebuildPower(
    lines: readonly number[],
    cellSize: number,
    heightFn: ((x: number, z: number) => number) | undefined,
  ): void {
    this.poleMesh = this.clear(this.poleMesh);
    this.wireMesh = this.clear(this.wireMesh);
    if (lines.length === 0) return;
    const { poles, wires } = buildPowerLineGeometry(lines, cellSize, heightFn);
    this.poleMesh = new THREE.Mesh(
      poles,
      new THREE.MeshLambertMaterial({ color: POLE_COLOR }),
    );
    this.wireMesh = new THREE.Mesh(
      wires,
      new THREE.MeshBasicMaterial({ color: WIRE_COLOR }),
    );
    for (const m of [this.poleMesh, this.wireMesh]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
    this.rebuilds++;
  }

  private rebuildPipes(
    pipes: readonly number[],
    cellSize: number,
    heightFn: ((x: number, z: number) => number) | undefined,
  ): void {
    this.pipeMesh = this.clear(this.pipeMesh);
    if (pipes.length === 0) return;
    this.pipeMesh = new THREE.Mesh(
      buildPipeGeometry(pipes, cellSize, heightFn),
      new THREE.MeshLambertMaterial({ color: PIPE_COLOR }),
    );
    this.pipeMesh.frustumCulled = false;
    this.group.add(this.pipeMesh);
    this.rebuilds++;
  }

  /** Test/debug hook: how many rebuilds have happened. */
  getRebuilds(): number {
    return this.rebuilds;
  }

  dispose(): void {
    this.poleMesh = this.clear(this.poleMesh);
    this.wireMesh = this.clear(this.wireMesh);
    this.pipeMesh = this.clear(this.pipeMesh);
    // Leave no trace in the scene (dispose discipline: no orphan groups).
    this.group.removeFromParent();
  }
}
