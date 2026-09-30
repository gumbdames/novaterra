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
 * NOVATERRA — render/logisticsOverlay.ts — logistics diagnosis overlay
 * (0.1 Alpha).
 *
 * Grand-expansion Phase 3 (logistics): the TOGGLEABLE overlay — off by
 * default, flipped from the top bar ("Logistics" button, next to the
 * Phase 2 "Utilities" toggle). It shows the two things a logistics
 * player needs at a glance:
 *
 * 1. Reload-point coverage: one translucent disc per completed reload
 *    point (munitions factory / missile plant / missile silo / ordnance
 *    depot / fuel depot), radius = the sim's LOGISTICS_RADIUS (read from
 *    sim/economy.ts via ui/logistics.ts — the overlay never invents a
 *    radius). One merged mesh, 1 draw call.
 * 2. Low-supply units: an amber ground ring under every living unit
 *    whose supply level dropped below LOGISTICS_LOW_SUPPLY (ui/logistics
 *    threshold). Ground rings, not floating sprites — they stay glued to
 *    the unit's x/z for every domain (air units hover +14; a sprite
 *    would detach). One merged mesh, 1 draw call, 0 when empty.
 *
 * Data flows in as `LogisticsOverlayData` (ui/logistics.ts — a pure view
 * of sim records; the overlay never touches sim state). Geometry is
 * built by pure functions (Node-testable); both meshes rebuild ONLY when
 * `logisticsOverlayDigest` changes.
 *
 * Import-safe under Node/vitest; fully unit-tested in
 * tests/render.logistics.test.ts.
 */

import * as THREE from 'three';

import type { LogisticsOverlayData } from '../ui/logistics';
import { logisticsOverlayDigest } from '../ui/logistics';

/** Reload-coverage tint (supply olive, subtle — distinct from the utility overlay's amber/blue/purple). */
export const LOGISTICS_COVERAGE_COLOR = 0x9fb84a;
export const LOGISTICS_COVERAGE_OPACITY = 0.13;
/** Low-supply ring color (amber — the "needs supply" read). */
export const LOGISTICS_LOW_COLOR = 0xe8a13c;
export const LOGISTICS_LOW_OPACITY = 0.85;
/** Coverage discs sit above the utility tints (+0.12) so the logistics layer reads on top. */
export const LOGISTICS_TINT_TERRAIN_OFFSET = 0.14;
/** Low-supply rings sit above the coverage discs. */
export const LOGISTICS_RING_TERRAIN_OFFSET = 0.18;
/** Flat-decal Y when no terrain sampler is available (headless path). */
export const LOGISTICS_FLAT_Y = 0.2;
/** Triangle-fan segments per coverage disc. */
export const LOGISTICS_DISC_SEGMENTS = 40;
/** Ring segments per low-supply marker. */
export const LOGISTICS_RING_SEGMENTS = 24;
/** Ground-ring inner/outer radius (world units). */
export const LOGISTICS_RING_INNER = 1.2;
export const LOGISTICS_RING_OUTER = 1.7;

export interface LogisticsOverlaySyncOpts {
  /** Terrain height sampler (drapes decals); undefined = flat headless path. */
  heightFn?: (x: number, z: number) => number;
}

// ---------------------------------------------------------------------------
// Pure geometry builders (Node-testable)
// ---------------------------------------------------------------------------

export interface DecalGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  indices: number[];
}

/**
 * Merged triangle-fan discs, one per depot, draped on the terrain.
 * Counter-clockwise winding when viewed from above (up-facing).
 */
export function buildCoverageDiscGeometry(
  depots: ReadonlyArray<{ x: number; z: number; radius: number }>,
  heightFn?: (x: number, z: number) => number,
): DecalGeometryData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const yOf = (x: number, z: number): number =>
    heightFn !== undefined ? heightFn(x, z) + LOGISTICS_TINT_TERRAIN_OFFSET : LOGISTICS_FLAT_Y;
  for (const d of depots) {
    const base = positions.length / 3;
    const cy = yOf(d.x, d.z);
    positions.push(d.x, cy, d.z);
    normals.push(0, 1, 0);
    for (let i = 0; i <= LOGISTICS_DISC_SEGMENTS; i++) {
      const a = (i / LOGISTICS_DISC_SEGMENTS) * Math.PI * 2;
      const x = d.x + Math.cos(a) * d.radius;
      const z = d.z + Math.sin(a) * d.radius;
      positions.push(x, yOf(x, z), z);
      normals.push(0, 1, 0);
    }
    for (let i = 1; i <= LOGISTICS_DISC_SEGMENTS; i++) {
      // CCW from above: center, current, next (angle grows CCW in xz).
      indices.push(base, base + i + 1, base + i);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices,
  };
}

/**
 * Merged flat ground rings, one per low-supply unit, draped on the
 * terrain. Counter-clockwise winding when viewed from above.
 */
export function buildLowSupplyRingGeometry(
  units: ReadonlyArray<{ x: number; z: number }>,
  heightFn?: (x: number, z: number) => number,
): DecalGeometryData {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const yOf = (x: number, z: number): number =>
    heightFn !== undefined ? heightFn(x, z) + LOGISTICS_RING_TERRAIN_OFFSET : LOGISTICS_FLAT_Y;
  for (const u of units) {
    const base = positions.length / 3;
    for (let i = 0; i <= LOGISTICS_RING_SEGMENTS; i++) {
      const a = (i / LOGISTICS_RING_SEGMENTS) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const ix = u.x + c * LOGISTICS_RING_INNER;
      const iz = u.z + s * LOGISTICS_RING_INNER;
      const ox = u.x + c * LOGISTICS_RING_OUTER;
      const oz = u.z + s * LOGISTICS_RING_OUTER;
      positions.push(ix, yOf(ix, iz), iz, ox, yOf(ox, oz), oz);
      normals.push(0, 1, 0, 0, 1, 0);
    }
    for (let i = 0; i < LOGISTICS_RING_SEGMENTS; i++) {
      const i0 = base + i * 2;
      const o0 = base + i * 2 + 1;
      const i1 = base + (i + 1) * 2;
      const o1 = base + (i + 1) * 2 + 1;
      // Two CCW triangles per quad (inner0, outer0, outer1) / (inner0, outer1, inner1).
      indices.push(i0, o1, o0, i0, i1, o1);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices,
  };
}

function toBufferGeometry(data: DecalGeometryData): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geo.setIndex(data.indices);
  return geo;
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

/**
 * Toggleable logistics diagnosis overlay. Owned by `EntityRenderer`:
 * constructed in its constructor, synced at the end of `sync()` from
 * `ui/logistics.ts` `logisticsOverlayData(…)`, flipped by
 * `setLogisticsOverlayVisible(v)`, disposed in `dispose()`.
 */
export class LogisticsOverlay {
  private readonly group = new THREE.Group();
  private coverageMesh: THREE.Mesh | null = null;
  private ringMesh: THREE.Mesh | null = null;
  private lastDigest = -1;
  /** Rebuild counter (test/debug hook). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'logistics-overlay';
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Number of geometry rebuilds so far (tests assert digest stability). */
  get rebuildCount(): number {
    return this.rebuilds;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  isVisible(): boolean {
    return this.group.visible;
  }

  /** Replace a mesh's geometry, creating the mesh on first need. */
  private setMesh(
    slot: 'coverage' | 'ring',
    data: DecalGeometryData,
    color: number,
    opacity: number,
  ): void {
    const empty = data.indices.length === 0;
    if (slot === 'coverage') {
      if (empty) {
        this.coverageMesh?.removeFromParent();
        this.coverageMesh?.geometry.dispose();
        (this.coverageMesh?.material as THREE.Material | undefined)?.dispose();
        this.coverageMesh = null;
        return;
      }
      const geo = toBufferGeometry(data);
      if (this.coverageMesh === null) {
        this.coverageMesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: false,
          }),
        );
        this.coverageMesh.renderOrder = 11;
        this.group.add(this.coverageMesh);
      } else {
        this.coverageMesh.geometry.dispose();
        this.coverageMesh.geometry = geo;
      }
    } else {
      if (empty) {
        this.ringMesh?.removeFromParent();
        this.ringMesh?.geometry.dispose();
        (this.ringMesh?.material as THREE.Material | undefined)?.dispose();
        this.ringMesh = null;
        return;
      }
      const geo = toBufferGeometry(data);
      if (this.ringMesh === null) {
        this.ringMesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        this.ringMesh.renderOrder = 12;
        this.group.add(this.ringMesh);
      } else {
        this.ringMesh.geometry.dispose();
        this.ringMesh.geometry = geo;
      }
    }
  }

  /**
   * Rebuild coverage + ring meshes only when the data digest changed;
   * an unchanged sync is a no-op (the overlay is static almost every
   * frame — depots rarely move and markers quantize to whole units).
   */
  sync(data: LogisticsOverlayData, opts: LogisticsOverlaySyncOpts = {}): void {
    const digest = logisticsOverlayDigest(data);
    if (digest === this.lastDigest) return;
    this.lastDigest = digest;
    this.rebuilds += 1;
    this.setMesh(
      'coverage',
      buildCoverageDiscGeometry(data.depots, opts.heightFn),
      LOGISTICS_COVERAGE_COLOR,
      LOGISTICS_COVERAGE_OPACITY,
    );
    this.setMesh(
      'ring',
      buildLowSupplyRingGeometry(data.lowUnits, opts.heightFn),
      LOGISTICS_LOW_COLOR,
      LOGISTICS_LOW_OPACITY,
    );
  }

  dispose(): void {
    for (const m of [this.coverageMesh, this.ringMesh]) {
      if (m !== null) {
        m.removeFromParent();
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    }
    this.coverageMesh = null;
    this.ringMesh = null;
    this.group.removeFromParent();
  }
}
