/**
 * Per-building utility indicators (0.1 Alpha).
 *
 * Phase 4 RENDER workstream A (item 5): the utility overlay shows
 * network health when toggled, but on the normal map a struggling
 * building is invisible. These two ALWAYS-ON instanced billboard
 * layers fix that: a lightning bolt over every building whose power
 * diagnosis is not ok, a water drop over every building whose water
 * diagnosis is not ok (the same `buildingPowerDiag` /
 * `buildingWaterDiag` readers from `ui/utilities.ts` that the
 * selection panel shows, so the map icons and the panel text can never
 * disagree).
 *
 * Layers: exactly 2 draw calls when any indicator is up, 0 when the
 * city is fully supplied (meshes stay hidden until the first bad
 * diagnosis, like the utility overlay's lazy marker meshes).
 *
 * The sprites are deterministic 64×64 SDF rasters with the same white
 * rim treatment as `utilityOverlay.ts` (no canvas, no textures on
 * disk): same shape ⇒ byte-identical pixels, pinned by test.
 *
 * Import-safe under Node/vitest.
 */

import * as THREE from 'three';

import { cellCenterWorld } from '../sim/city';
import type { BuildingRecord } from '../sim/city';
import { buildingDiagFingerprint, buildingPowerDiag, buildingWaterDiag } from '../ui/utilities';

/** Indicator kinds in stable order (one instanced mesh each). */
export const UTILITY_INDICATOR_KINDS = ['noPower', 'noWater'] as const;
export type UtilityIndicatorKind = (typeof UTILITY_INDICATOR_KINDS)[number];

/** Sprite texture size (px). */
export const UTILITY_INDICATOR_TEX_PX = 64;
/** Indicator world size (square sprite — small, below the roofline noise). */
export const UTILITY_INDICATOR_SIZE = 1.8;
/** Lift above the building top (bottom-anchored, clears the roof). */
export const UTILITY_INDICATOR_LIFT = 1.0;
/** Horizontal separation when a building shows both icons. */
export const UTILITY_INDICATOR_SPREAD = 1.1;
/** Initial instanced-mesh capacity per indicator kind (doubles as needed). */
export const UTILITY_INDICATOR_INITIAL_CAPACITY = 64;

type RGB = [number, number, number];

/** Bolt = power yellow, drop = water blue. */
const INDICATOR_FILL: Record<UtilityIndicatorKind, RGB> = {
  noPower: [0xff, 0xd2, 0x3c],
  noWater: [0x3d, 0x8f, 0xc4],
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

/** Point-in-polygon (ray cast, +x) for the bolt's inside test. */
function pointInPolygon(x: number, y: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    // B27: no `!` — i and j are bounded by poly.length (j wraps from i).
    const pi = poly[i];
    const pj = poly[j];
    if (pi === undefined || pj === undefined) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Lightning-bolt polygon (y-down pixel space). */
const BOLT_POLY: ReadonlyArray<readonly [number, number]> = [
  [37, 5], [17, 37], [29, 37], [25, 59], [47, 27], [34, 27],
];

/** Signed distance to the indicator shape (negative = inside). */
function indicatorSDF(kind: UtilityIndicatorKind, x: number, y: number): number {
  switch (kind) {
    case 'noPower': {
      // Lightning bolt: min distance to the polygon edges, signed by
      // the inside test.
      let d = Infinity;
      for (let i = 0; i < BOLT_POLY.length; i++) {
        // B27: no `!` — i and (i+1)%length are bounded by BOLT_POLY.length.
        const pa = BOLT_POLY[i];
        const pb = BOLT_POLY[(i + 1) % BOLT_POLY.length];
        if (pa === undefined || pb === undefined) continue;
        const [ax, ay] = pa;
        const [bx, by] = pb;
        d = Math.min(d, distToSegment(x, y, ax, ay, bx, by));
      }
      return pointInPolygon(x, y, BOLT_POLY) ? -d : d;
    }
    case 'noWater': {
      // Water drop: disc + pointed top (same construction as the
      // utility overlay's fouled drop, in water blue).
      const disc = Math.hypot(x - 32, y - 38) - 16;
      const tip = Math.min(
        distToSegment(x, y, 32, 6, 20, 36),
        distToSegment(x, y, 32, 6, 44, 36),
      );
      const tipInside =
        y >= 6 && y <= 38 && Math.abs(x - 32) <= ((38 - y) / 32) * 12;
      return Math.min(disc, tipInside ? -tip : tip);
    }
  }
}

/**
 * Rasterize one indicator sprite: shape in fill color, white rim, soft
 * edge. Pure and deterministic.
 */
export function utilityIndicatorPixels(kind: UtilityIndicatorKind): Uint8ClampedArray {
  const w = UTILITY_INDICATOR_TEX_PX;
  const px = new Uint8ClampedArray(w * w * 4);
  const [r, g, b] = INDICATOR_FILL[kind];
  const edge = 2;
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const d = indicatorSDF(kind, x + 0.5, y + 0.5);
      const i = (y * w + x) * 4;
      if (d <= 0) {
        px[i] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = 255;
      } else if (d <= edge) {
        // White rim halo so the indicator reads on any terrain.
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

/** One indicator placement (building-anchored). */
export interface UtilityIndicator {
  kind: UtilityIndicatorKind;
  x: number;
  z: number;
  buildingKind: string;
}

/**
 * Pure: the indicator list for a building set. A building gets a bolt
 * when its power diagnosis is anything but ok, a drop when its water
 * diagnosis is anything but ok (same readers the selection panel
 * uses). Sorted by (kind, building id) — same input ⇒ byte-identical
 * output.
 *
 * Final-review R3 L7 (2026-10-01): single-entry memoized. `sync()`
 * runs every render frame, and the unmemoized path copied + sorted the
 * whole building array (O(n log n)) just to discover nothing changed.
 * The memo key is a one-pass FNV-1a fingerprint over the array
 * identity plus every per-building input the list depends on (id,
 * cell, kind, power/water diagnosis) — O(n) cheap reads, no
 * allocation, no sort. The returned array is cached: callers must not
 * mutate it. Render-layer only — never consulted by the sim.
 */
export function utilityIndicatorsFor(
  buildings: readonly BuildingRecord[],
): UtilityIndicator[] {
  const fp = indicatorsFingerprint(buildings);
  if (indicatorsMemo.buildings === buildings && indicatorsMemo.fingerprint === fp) {
    return indicatorsMemo.result;
  }
  const result = computeUtilityIndicators(buildings);
  indicatorsMemo.buildings = buildings;
  indicatorsMemo.fingerprint = fp;
  indicatorsMemo.result = result;
  return result;
}

interface IndicatorsMemo {
  buildings: readonly BuildingRecord[] | null;
  fingerprint: number;
  result: UtilityIndicator[];
}
const indicatorsMemo: IndicatorsMemo = { buildings: null, fingerprint: 0, result: [] };

/** One-pass fingerprint over every input `computeUtilityIndicators` reads. */
function indicatorsFingerprint(buildings: readonly BuildingRecord[]): number {
  let h = 0x811c9dc5;
  for (const b of buildings) {
    h ^= b.id;
    h = Math.imul(h, 0x01000193);
    h ^= b.cx;
    h = Math.imul(h, 0x01000193);
    h ^= b.cz;
    h = Math.imul(h, 0x01000193);
    h = mixString(h, b.kind);
    // The diagnosis pair, via the cheap raw-field fingerprint — no
    // per-building export call overhead on the steady-state path.
    h ^= buildingDiagFingerprint(b);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mixString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h;
}

/** The unmemoized indicator computation (see `utilityIndicatorsFor`). */
function computeUtilityIndicators(
  buildings: readonly BuildingRecord[],
): UtilityIndicator[] {
  const out: UtilityIndicator[] = [];
  const sorted = [...buildings].sort((a, b) => a.id - b.id);
  for (const b of sorted) {
    const x = cellCenterWorld(b.cx);
    const z = cellCenterWorld(b.cz);
    if (buildingPowerDiag(b) !== 'ok') {
      out.push({ kind: 'noPower', x, z, buildingKind: b.kind });
    }
    if (buildingWaterDiag(b) !== 'ok') {
      out.push({ kind: 'noWater', x, z, buildingKind: b.kind });
    }
  }
  return out;
}

/** FNV-1a digest over the indicator list (the rebuild key). */
export function utilityIndicatorsDigest(indicators: readonly UtilityIndicator[]): number {
  let h = 0x811c9dc5;
  for (const m of indicators) {
    const s = `${m.kind}:${m.x.toFixed(2)},${m.z.toFixed(2)};`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

export interface UtilityIndicatorsSyncOpts {
  heightFn?: (x: number, z: number) => number;
  /** Camera for billboarding (identity when headless). */
  camera?: THREE.Camera;
  /** Building-top height for a kind (indicator lift anchor). */
  buildingTop?: (kind: string) => number;
}

export class UtilityIndicators {
  private readonly group = new THREE.Group();
  private indicatorMeshes = new Map<UtilityIndicatorKind, THREE.InstancedMesh>();
  private lastDigest = -1;
  /** Rebuild counter (test/debug hook). */
  private rebuilds = 0;
  private lastCounts: Record<UtilityIndicatorKind, number> = {
    noPower: 0,
    noWater: 0,
  };

  constructor(scene: THREE.Scene) {
    this.group.name = 'utility-indicators';
    scene.add(this.group);
  }

  /**
   * Create an indicator instanced mesh on first need (lazy: a fully
   * supplied city keeps zero indicator meshes — 0 draw calls).
   */
  private ensureIndicatorMesh(kind: UtilityIndicatorKind): THREE.InstancedMesh {
    const existing = this.indicatorMeshes.get(kind);
    if (existing !== undefined) return existing;
    const tex = new THREE.DataTexture(
      utilityIndicatorPixels(kind),
      UTILITY_INDICATOR_TEX_PX,
      UTILITY_INDICATOR_TEX_PX,
    );
    tex.needsUpdate = true;
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.PlaneGeometry(UTILITY_INDICATOR_SIZE, UTILITY_INDICATOR_SIZE);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new THREE.InstancedMesh(
      geo,
      mat,
      UTILITY_INDICATOR_INITIAL_CAPACITY,
    );
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.renderOrder = 11; // above the utility overlay's markers (10)
    mesh.count = 0;
    this.indicatorMeshes.set(kind, mesh);
    this.group.add(mesh);
    return mesh;
  }

  /**
   * Rebuild the instance lists only when the indicator digest changed,
   * then re-compose every instance matrix with the current billboard
   * quaternion (the camera moves every frame, so the write pass runs on
   * every sync — this is the whole pass, there is no second phase).
   * Always on — there is no visibility toggle for these.
   */
  sync(buildings: readonly BuildingRecord[], opts: UtilityIndicatorsSyncOpts): void {
    const indicators = utilityIndicatorsFor(buildings);
    const digest = utilityIndicatorsDigest(indicators);
    const byKind = new Map<UtilityIndicatorKind, UtilityIndicator[]>();
    for (const kind of UTILITY_INDICATOR_KINDS) byKind.set(kind, []);
    for (const m of indicators) {
      // Pre-populated above; the undefined branch is unreachable.
      const list = byKind.get(m.kind);
      if (list !== undefined) list.push(m);
    }
    if (digest !== this.lastDigest) {
      this.lastDigest = digest;
      this.restructure(byKind);
      this.rebuilds++;
    }
    this.writeIndicators(byKind, opts);
  }

  /**
   * Structural pass (runs only on digest change): create, grow, and
   * hide the per-kind meshes. Never touches instance matrices — that
   * is the per-sync write pass below.
   */
  private restructure(byKind: Map<UtilityIndicatorKind, UtilityIndicator[]>): void {
    for (const kind of UTILITY_INDICATOR_KINDS) {
      // Pre-populated above; the undefined branch is unreachable.
      const list = byKind.get(kind);
      if (list === undefined) continue;
      this.lastCounts[kind] = list.length;
      if (list.length === 0) {
        // Fully supplied: hide the layer (0 draw calls).
        const mesh = this.indicatorMeshes.get(kind);
        if (mesh !== undefined) {
          mesh.visible = false;
          mesh.count = 0;
        }
        continue;
      }
      let mesh = this.ensureIndicatorMesh(kind);
      if (list.length > mesh.instanceMatrix.count / 16) {
        // Grow: rebuild the instanced mesh at double capacity. (Rare —
        // only when the indicator count crosses a power of two.)
        const grown = new THREE.InstancedMesh(
          mesh.geometry,
          mesh.material,
          Math.max(UTILITY_INDICATOR_INITIAL_CAPACITY, list.length * 2),
        );
        grown.frustumCulled = false;
        grown.renderOrder = 11;
        this.group.remove(mesh);
        mesh.dispose();
        this.indicatorMeshes.set(kind, grown);
      }
    }
  }

  /**
   * Write pass (runs every sync): compose each instance as
   * position + billboard quaternion + unit scale. The instance matrices
   * are world-space, so the mesh itself is NEVER rotated — copying the
   * camera quaternion onto the InstancedMesh (the old bug) rotated
   * every indicator around the world origin, floating sprites off
   * their buildings far from map center. Same pattern as
   * render/chevrons.ts.
   */
  private writeIndicators(
    byKind: Map<UtilityIndicatorKind, UtilityIndicator[]>,
    opts: UtilityIndicatorsSyncOpts,
  ): void {
    const heightFn = opts.heightFn;
    const buildingTop = opts.buildingTop;
    // Identity when headless (no camera): sprites face +z.
    const billboard =
      opts.camera !== undefined ? opts.camera.quaternion : this.identityQuat;
    for (const kind of UTILITY_INDICATOR_KINDS) {
      const mesh = this.indicatorMeshes.get(kind);
      if (mesh === undefined) continue;
      // Pre-populated by the caller; the undefined branch is unreachable.
      const list = byKind.get(kind);
      if (list === undefined) continue;
      if (list.length === 0) continue;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m === undefined) continue; // unreachable: i < list.length
        const ground = heightFn !== undefined ? heightFn(m.x, m.z) : 0;
        const top = buildingTop !== undefined ? buildingTop(m.buildingKind) : 4;
        // A building with both problems shows the bolt left, the drop
        // right (they share the anchor).
        const spread =
          m.kind === 'noPower'
            ? -UTILITY_INDICATOR_SPREAD / 2
            : UTILITY_INDICATOR_SPREAD / 2;
        this.scratch.position.set(
          m.x + spread,
          ground + top + UTILITY_INDICATOR_LIFT + UTILITY_INDICATOR_SIZE / 2,
          m.z,
        );
        this.scratch.quaternion.copy(billboard);
        this.scratch.scale.setScalar(1);
        this.scratch.updateMatrix();
        mesh.setMatrixAt(i, this.scratch.matrix);
      }
      mesh.count = list.length;
      mesh.visible = true;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Scratch compose target + the headless identity quaternion. */
  private readonly scratch = new THREE.Object3D();
  private readonly identityQuat = new THREE.Quaternion();

  /** Indicator counts per kind (test/debug hook). */
  debugCounts(): Record<UtilityIndicatorKind, number> {
    return { ...this.lastCounts };
  }

  /** Draw calls: 0–2 (test/debug hook). */
  drawCallCount(): number {
    let n = 0;
    for (const mesh of this.indicatorMeshes.values()) {
      if (mesh.visible && mesh.count > 0) n++;
    }
    return n;
  }

  /** Rebuild counter (test/debug hook). */
  debugRebuilds(): number {
    return this.rebuilds;
  }

  /**
   * Live instance matrices for a kind (test/debug hook). Returned
   * matrices are copies — mutating them does not affect the mesh.
   */
  debugMatrices(kind: UtilityIndicatorKind): THREE.Matrix4[] {
    const mesh = this.indicatorMeshes.get(kind);
    if (mesh === undefined) return [];
    const out: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      out.push(m.clone());
    }
    return out;
  }

  dispose(): void {
    for (const mesh of this.indicatorMeshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      ((mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
    }
    this.indicatorMeshes.clear();
  }
}
