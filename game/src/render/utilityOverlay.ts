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
 * NOVATERRA — render/utilityOverlay.ts — utility-network diagnostic
 * overlay (0.1 Alpha).
 *
 * Phase 2 (utilities): the TOGGLEABLE overlay — off by default, flipped
 * from the top bar. It shows what the plan's §4 acceptance criteria ask
 * for: network coverage tints (served power zones, served water zones,
 * fouled water sources) plus floating icons for disconnected (red),
 * shortage (amber), stranded plants (blue flag) and fouled sources
 * (purple drop). The physical runs themselves (poles/pipes) are NOT the
 * overlay — they render always via render/networks.ts.
 *
 * Data flows in as `UtilityOverlayData` (ui/utilities.ts — a pure view
 * of sim records; the overlay never touches sim state). Sprites are
 * canvas-free `THREE.DataTexture`s rasterized from pure pixel math
 * (the chevron precedent): same marker ⇒ byte-identical pixels, pinned
 * by test. One instanced mesh per marker kind (≤4 draw calls, 0 when
 * empty), one merged decal mesh per tint set (≤3 draw calls).
 *
 * Import-safe under Node/vitest; fully unit-tested in
 * tests/render.utilityOverlay.test.ts.
 */

import * as THREE from 'three';

import { cellCoords, cellCenterWorld, CELL_WORLD_SIZE } from '../sim/city';
import type { UtilityOverlayData, UtilityMarker } from '../ui/utilities';

/** Marker kinds in stable order (one instanced mesh each). */
export const UTILITY_MARKER_KINDS = ['disconnected', 'shortage', 'stranded', 'fouled'] as const;
export type UtilityMarkerKind = (typeof UTILITY_MARKER_KINDS)[number];

/** Sprite texture size (px). */
export const UTILITY_MARKER_TEX_PX = 64;
/** Marker world size (square sprite). */
export const UTILITY_MARKER_SIZE = 2.4;
/** Lift above the building top (bottom-anchored, clears the roof). */
export const UTILITY_MARKER_LIFT = 1.2;
/** Initial instanced-mesh capacity per marker kind (doubles as needed). */
export const UTILITY_MARKER_INITIAL_CAPACITY = 32;

/** Served-power tint (warm amber, subtle). */
export const SERVED_POWER_COLOR = 0xd8a93c;
export const SERVED_POWER_OPACITY = 0.1;
/** Served-water tint (water blue, subtle). */
export const SERVED_WATER_COLOR = 0x3d8fc4;
export const SERVED_WATER_OPACITY = 0.1;
/** Fouled-source tint (warning purple, stronger). */
export const FOULED_COLOR = 0x9b4dca;
export const FOULED_OPACITY = 0.18;
/** Tint decals sit above roads (+0.08) so served/fouled reads on top. */
export const UTILITY_TINT_TERRAIN_OFFSET = 0.12;

// ---------------------------------------------------------------------------
// Pure sprite rasterizers (64×64, y-down pixel space, soft 2px edge).
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

const MARKER_FILL: Record<UtilityMarkerKind, RGB> = {
  disconnected: [0xd2, 0x3b, 0x3b],
  shortage: [0xe8, 0xa1, 0x3c],
  stranded: [0x3c, 0x78, 0xd2],
  fouled: [0x9b, 0x4d, 0xca],
};

function distToSegment(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Signed distance to the marker shape (negative = inside). */
function markerSDF(kind: UtilityMarkerKind, x: number, y: number): number {
  switch (kind) {
    case 'disconnected': {
      // Red disc.
      return Math.hypot(x - 32, y - 32) - 22;
    }
    case 'shortage': {
      // Amber triangle (pointing up).
      const d = Math.min(
        distToSegment(x, y, 32, 8, 10, 50),
        distToSegment(x, y, 32, 8, 54, 50),
        distToSegment(x, y, 10, 50, 54, 50),
      );
      // Inside test via barycentric-ish sign: use the "below the apex
      // edges and above the base" rule for this upright triangle.
      const inside = y >= 8 && y <= 50 && Math.abs(x - 32) <= ((y - 8) / 42) * 22;
      return inside ? -d : d;
    }
    case 'stranded': {
      // Blue flag: pole + waving pennant.
      const pole = distToSegment(x, y, 22, 10, 22, 54) - 3;
      const flag = Math.min(
        distToSegment(x, y, 25, 12, 50, 20),
        distToSegment(x, y, 25, 34, 50, 20),
        distToSegment(x, y, 25, 12, 25, 34),
      );
      const flagInside = x >= 25 && x <= 50 && y >= 12 + (x - 25) * (8 / 25) && y <= 34 - (x - 25) * (14 / 25);
      return Math.min(pole, flagInside ? -flag : flag);
    }
    case 'fouled': {
      // Purple drop: disc + pointed top.
      const disc = Math.hypot(x - 32, y - 38) - 16;
      const tip = distToSegment(x, y, 32, 6, 20, 36) ;
      const tip2 = distToSegment(x, y, 32, 6, 44, 36);
      const tipInside = y >= 6 && y <= 38 && Math.abs(x - 32) <= ((38 - y) / 32) * 12;
      return Math.min(disc, tipInside ? -Math.min(tip, tip2) : Math.min(tip, tip2));
    }
  }
}

/**
 * Rasterize one marker sprite: shape in fill color, white rim, soft
 * edge. Pure and deterministic.
 */
export function utilityMarkerPixels(kind: UtilityMarkerKind): Uint8ClampedArray {
  const w = UTILITY_MARKER_TEX_PX;
  const px = new Uint8ClampedArray(w * w * 4);
  const [r, g, b] = MARKER_FILL[kind];
  const edge = 2;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const d = markerSDF(kind, x + 0.5, y + 0.5);
      const i = (y * w + x) * 4;
      if (d <= 0) {
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = 255;
      } else if (d <= edge) {
        // White rim halo so the marker reads on any terrain.
        const t = 1 - d / edge;
        px[i] = 255;
        px[i + 1] = 255;
        px[i + 2] = 255;
        px[i + 3] = Math.round(255 * t * 0.9);
      }
    }
  }
  return px;
}

// ---------------------------------------------------------------------------
// Pure tint-decal geometry: one up-facing quad per cell, draped on terrain.
// ---------------------------------------------------------------------------

/**
 * Build a merged decal geometry for a cell set (sorted emission, so
 * same cells → byte-identical geometry). `yOffset` above the sampled
 * terrain height.
 */
export function buildTintDecalGeometry(
  cells: readonly number[],
  yOffset: number,
  heightFn?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const sorted = [...new Set(cells)].filter((c) => Number.isInteger(c) && c >= 0)
    .sort((a, b) => a - b);
  const positions: number[] = [];
  const indices: number[] = [];
  for (const cell of sorted) {
    const { cx, cz } = cellCoords(cell);
    const x = cellCenterWorld(cx);
    const z = cellCenterWorld(cz);
    const half = CELL_WORLD_SIZE / 2;
    const corners: Array<[number, number]> = [
      [x - half, z - half],
      [x + half, z - half],
      [x + half, z + half],
      [x - half, z + half],
    ];
    const v = positions.length / 3;
    for (const [qx, qz] of corners) {
      const y = (heightFn !== undefined ? heightFn(qx, qz) : 0) + yOffset;
      positions.push(qx, y, qz);
    }
    indices.push(v, v + 2, v + 1, v, v + 3, v + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** FNV-1a digest over the overlay data (order-independent). */
export function utilityOverlayDigest(data: UtilityOverlayData): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n & 0xffffffff;
    h = Math.imul(h, 0x01000193);
  };
  const mixCells = (cells: readonly number[]): void => {
    const sorted = [...cells].sort((a, b) => a - b);
    mix(sorted.length);
    for (const c of sorted) mix(c);
  };
  mixCells(data.servedPowerCells);
  mixCells(data.servedWaterCells);
  mixCells(data.fouledCells);
  const markers = [...data.markers].sort((a, b) =>
    a.kind === b.kind ? a.x - b.x || a.z - b.z : a.kind < b.kind ? -1 : 1,
  );
  mix(markers.length);
  for (const m of markers) {
    mix(Math.round(m.x * 1000));
    mix(Math.round(m.z * 1000));
    mix(m.kind.length * 31 + m.kind.charCodeAt(0));
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// The overlay: 3 tint meshes + 4 instanced marker meshes.
// ---------------------------------------------------------------------------

export interface UtilityOverlaySyncOpts {
  cellSize: number;
  heightFn?: (x: number, z: number) => number;
  /** Camera for billboarding (identity when headless). */
  camera?: THREE.Camera;
  /** Building-top height for a kind (marker lift anchor). */
  buildingTop?: (kind: string) => number;
}

export class UtilityOverlay {
  private readonly group = new THREE.Group();
  private tintMeshes: THREE.Mesh[] = [];
  private markerMeshes = new Map<UtilityMarkerKind, THREE.InstancedMesh>();
  private lastDigest = -1;
  private visible = false;
  /** Rebuild counter (test/debug hook). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'utility-overlay';
    this.group.visible = false;
    scene.add(this.group);
  }

  /**
   * Create a marker instanced mesh on first need (lazy: an empty scene
   * keeps zero marker meshes instead of four empty ones).
   */
  private ensureMarkerMesh(kind: UtilityMarkerKind): THREE.InstancedMesh {
    const existing = this.markerMeshes.get(kind);
    if (existing !== undefined) return existing;
    const tex = new THREE.DataTexture(
      utilityMarkerPixels(kind),
      UTILITY_MARKER_TEX_PX,
      UTILITY_MARKER_TEX_PX,
    );
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(UTILITY_MARKER_SIZE, UTILITY_MARKER_SIZE);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, UTILITY_MARKER_INITIAL_CAPACITY);
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 10;
    mesh.count = 0;
    this.markerMeshes.set(kind, mesh);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Rebuild tints + marker instance lists only when the data digest
   * changed; billboard the markers every sync (cheap quaternion copy).
   */
  sync(data: UtilityOverlayData, opts: UtilityOverlaySyncOpts): void {
    const digest = utilityOverlayDigest(data);
    if (digest !== this.lastDigest) {
      this.lastDigest = digest;
      this.rebuildTints(data, opts);
      this.rebuildMarkers(data, opts);
    }
    this.billboard(opts.camera);
  }

  private clearTints(): void {
    for (const m of this.tintMeshes) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.tintMeshes = [];
  }

  private addTint(
    cells: readonly number[],
    color: number,
    opacity: number,
    heightFn: ((x: number, z: number) => number) | undefined,
  ): void {
    if (cells.length === 0) return;
    const mesh = new THREE.Mesh(
      buildTintDecalGeometry(cells, UTILITY_TINT_TERRAIN_OFFSET, heightFn),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        depthWrite: false,
      }),
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    this.tintMeshes.push(mesh);
    this.group.add(mesh);
  }

  private rebuildTints(data: UtilityOverlayData, opts: UtilityOverlaySyncOpts): void {
    this.clearTints();
    this.addTint(data.servedPowerCells, SERVED_POWER_COLOR, SERVED_POWER_OPACITY, opts.heightFn);
    this.addTint(data.servedWaterCells, SERVED_WATER_COLOR, SERVED_WATER_OPACITY, opts.heightFn);
    this.addTint(data.fouledCells, FOULED_COLOR, FOULED_OPACITY, opts.heightFn);
    this.rebuilds++;
  }

  private rebuildMarkers(data: UtilityOverlayData, opts: UtilityOverlaySyncOpts): void {
    const byKind = new Map<UtilityMarkerKind, UtilityMarker[]>();
    for (const kind of UTILITY_MARKER_KINDS) byKind.set(kind, []);
    for (const m of data.markers) {
      if ((UTILITY_MARKER_KINDS as readonly string[]).includes(m.kind)) {
        // Pre-populated above; the undefined branch is unreachable.
        const list = byKind.get(m.kind as UtilityMarkerKind);
        if (list !== undefined) list.push(m);
      }
    }
    const dummy = new THREE.Object3D();
    for (const kind of UTILITY_MARKER_KINDS) {
      // Pre-populated above; the undefined branch is unreachable.
      const list = byKind.get(kind);
      if (list === undefined) continue;
      if (list.length === 0 && !this.markerMeshes.has(kind)) continue;
      const mesh = this.ensureMarkerMesh(kind);
      if (list.length > mesh.instanceMatrix.count / 16) {
        // Grow: rebuild the instanced mesh at double capacity. (Rare —
        // only when the marker count crosses a power of two.)
        const grown = new THREE.InstancedMesh(
          mesh.geometry,
          mesh.material,
          Math.max(UTILITY_MARKER_INITIAL_CAPACITY, list.length * 2),
        );
        grown.frustumCulled = false;
        grown.renderOrder = 10;
        this.group.remove(mesh);
        mesh.dispose();
        this.markerMeshes.set(kind, grown);
        this.writeMarkers(grown, list, opts, dummy);
        continue;
      }
      this.writeMarkers(mesh, list, opts, dummy);
    }
    this.rebuilds++;
  }

  private writeMarkers(
    mesh: THREE.InstancedMesh,
    list: UtilityMarker[],
    opts: UtilityOverlaySyncOpts,
    dummy: THREE.Object3D,
  ): void {
    const heightFn = opts.heightFn;
    const buildingTop = opts.buildingTop;
    for (let i = 0; i < list.length; i++) {
      // B27: no `!` — i is bounded by list.length.
      const m = list[i];
      if (m === undefined) continue;
      const ground = heightFn !== undefined ? heightFn(m.x, m.z) : 0;
      const top = buildingTop !== undefined ? buildingTop(m.buildingKind) : 4;
      dummy.position.set(
        m.x,
        ground + top + UTILITY_MARKER_LIFT + UTILITY_MARKER_SIZE / 2,
        m.z,
      );
      dummy.quaternion.identity();
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = list.length;
    mesh.visible = list.length > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  private billboard(camera: THREE.Camera | undefined): void {
    const q = camera !== undefined ? camera.quaternion : new THREE.Quaternion();
    for (const mesh of this.markerMeshes.values()) {
      if (!mesh.visible || mesh.count === 0) continue;
      const dummy = new THREE.Object3D();
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, dummy.matrix);
        dummy.matrix.decompose(dummy.position, dummy.quaternion, dummy.scale);
        dummy.quaternion.copy(q);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Toggle the whole overlay (top-bar button). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
  }

  /** Test/debug hook: how many rebuilds have happened. */
  getRebuilds(): number {
    return this.rebuilds;
  }

  dispose(): void {
    this.clearTints();
    for (const mesh of this.markerMeshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.markerMeshes.clear();
    // Leave no trace in the scene (dispose discipline: no orphan groups).
    this.group.removeFromParent();
  }
}
