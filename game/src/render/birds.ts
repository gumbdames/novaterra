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
 * NOVATERRA — render/birds.ts — decorative bird flyovers (living nature,
 * 0.1 Alpha).
 *
 * Occasional flocks cross the map on seeded curved paths, wings flapping.
 * Purely decorative: render-side only, zero sim state, never selectable,
 * never in any digest or snapshot.
 *
 * Design:
 *  - 10 procedural variants (silhouette via wingspan/chord/sweep/tail,
 *    plumage via vertex colors), ~22 tris each. One shared material with
 *    `vertexColors`; the wing flap is a vertex-shader TSL node driven by
 *    the shared ambient clock with a per-instance phase — zero CPU per
 *    frame however many birds are aloft.
 *  - One `InstancedMesh` per variant (capacity `BIRD_FLOCK_BIRDS`), all
 *    hidden when no flock is active → 0 draw calls most of the time,
 *    ≤10 while a flyover crosses.
 *  - The schedule is a pure function of the sim tick: flock k spawns at
 *    a seeded tick, flies a quadratic bezier edge-to-edge over
 *    `BIRD_FLOCK_DURATION_TICKS`, then despawns. Bird poses are pure
 *    functions of (flock, bird, tick) — pause/seek/rebuild exact, and
 *    identical on every machine for the same seed.
 *
 * Budgets: ≤ 2 flocks × 6 birds = 12 birds alive; ≤12 matrix composes
 * per frame (microseconds); ≤10 draw calls only during a flyover.
 * Import-safe under Node/vitest (`three` core + `three/tsl` touch no DOM
 * at import time).
 */

import * as THREE from 'three';
import { attribute, hash, instanceIndex, positionLocal, sin, vec3 } from 'three/tsl';

import { ambientTimeSeconds } from './ambientTime';

/** Pure deterministic 32-bit integer hash → [0, 1). */
export function hash01(n: number): number {
  let h = (Math.imul(n | 0, 374761393) + 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** A flyover roughly every 50 s (30 ticks/s). */
export const BIRD_FLOCK_INTERVAL_TICKS = 1500;
/** A crossing takes 45 s — flocks occasionally overlap. */
export const BIRD_FLOCK_DURATION_TICKS = 1350;
/** Birds per flock (V-ish cluster). */
export const BIRD_FLOCK_BIRDS = 6;
/** Max simultaneously active flocks (schedule bound). */
export const BIRD_MAX_FLOCKS = 2;

/** Procedural bird variant spec: silhouette params + plumage colors. */
export interface BirdVariantSpec {
  name: string;
  /** Body length / radius (world units). */
  bodyLen: number;
  bodyR: number;
  /** Wingspan, root chord, tip sweep-back. */
  wingspan: number;
  chord: number;
  sweep: number;
  /** Tail length / fan width. */
  tailLen: number;
  tailSpread: number;
  /** Plumage hex colors: body, wing, wingtip. */
  body: number;
  wing: number;
  tip: number;
}

/** The 10 visually distinct flyover variants. */
export const BIRD_VARIANTS: readonly BirdVariantSpec[] = [
  { name: 'swift', bodyLen: 0.9, bodyR: 0.14, wingspan: 2.6, chord: 0.34, sweep: 0.55, tailLen: 0.5, tailSpread: 0.22, body: 0x2b2f36, wing: 0x3a4048, tip: 0x1c2026 },
  { name: 'gull', bodyLen: 1.1, bodyR: 0.17, wingspan: 2.8, chord: 0.5, sweep: 0.25, tailLen: 0.45, tailSpread: 0.34, body: 0xe8ecef, wing: 0xd4d9de, tip: 0x4a5058 },
  { name: 'crow', bodyLen: 1.0, bodyR: 0.16, wingspan: 2.4, chord: 0.52, sweep: 0.2, tailLen: 0.5, tailSpread: 0.4, body: 0x17181c, wing: 0x1e2026, tip: 0x0c0d10 },
  { name: 'hawk', bodyLen: 1.2, bodyR: 0.2, wingspan: 3.0, chord: 0.62, sweep: 0.22, tailLen: 0.55, tailSpread: 0.5, body: 0x5c4632, wing: 0x6e5640, tip: 0x3a2d20 },
  { name: 'heron', bodyLen: 1.4, bodyR: 0.18, wingspan: 3.2, chord: 0.55, sweep: 0.18, tailLen: 0.4, tailSpread: 0.3, body: 0x8a94a0, wing: 0x9aa4b0, tip: 0x5c646e },
  { name: 'sparrow', bodyLen: 0.7, bodyR: 0.12, wingspan: 1.7, chord: 0.34, sweep: 0.3, tailLen: 0.4, tailSpread: 0.26, body: 0x7a6248, wing: 0x8a7256, tip: 0x4c3d2a },
  { name: 'duck', bodyLen: 1.1, bodyR: 0.19, wingspan: 2.5, chord: 0.48, sweep: 0.3, tailLen: 0.4, tailSpread: 0.3, body: 0x2e5c46, wing: 0x4a6e58, tip: 0x1e3c2e },
  { name: 'goose', bodyLen: 1.5, bodyR: 0.22, wingspan: 3.4, chord: 0.58, sweep: 0.25, tailLen: 0.45, tailSpread: 0.34, body: 0x6e6a62, wing: 0x7e7a72, tip: 0x3c3a36 },
  { name: 'tern', bodyLen: 0.85, bodyR: 0.13, wingspan: 2.4, chord: 0.32, sweep: 0.5, tailLen: 0.6, tailSpread: 0.2, body: 0xf0f2f4, wing: 0xdde2e6, tip: 0x2b2f36 },
  { name: 'eagle', bodyLen: 1.35, bodyR: 0.21, wingspan: 3.6, chord: 0.66, sweep: 0.2, tailLen: 0.6, tailSpread: 0.55, body: 0x3d2f22, wing: 0x4d3d2c, tip: 0x241a12 },
];

/** Wing-flap weight attribute: 0 on body/tail, 0→1 root→tip on wings. */
export const BIRD_FLAP_ATTRIBUTE = 'aFlap';

interface BirdPart {
  positions: number[];
  colors: number[];
  flaps: number[];
  indices: number[];
}

function pushTri(
  part: BirdPart,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  color: THREE.Color,
  flapA: number,
  flapB: number,
  flapC: number,
): void {
  const base = part.positions.length / 3;
  part.positions.push(...a, ...b, ...c);
  for (let i = 0; i < 3; i++) part.colors.push(color.r, color.g, color.b);
  part.flaps.push(flapA, flapB, flapC);
  part.indices.push(base, base + 1, base + 2);
}

function pushQuad(
  part: BirdPart,
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
  color: THREE.Color,
  flaps: [number, number, number, number],
): void {
  pushTri(part, a, b, c, color, flaps[0], flaps[1], flaps[2]);
  pushTri(part, a, c, d, color, flaps[0], flaps[2], flaps[3]);
}

/**
 * Build one variant's geometry (faces +z). Body = stretched octahedron,
 * tail = flat fan, wings = 3 tapered swept quads per side. Deterministic:
 * plain float math, no RNG.
 */
export function buildBirdGeometry(spec: BirdVariantSpec): THREE.BufferGeometry {
  const part: BirdPart = { positions: [], colors: [], flaps: [], indices: [] };
  const bodyC = new THREE.Color(spec.body);
  const wingC = new THREE.Color(spec.wing);
  const tipC = new THREE.Color(spec.tip);
  const hl = spec.bodyLen / 2;

  // Body: octahedron stretched along z.
  const px: [number, number, number] = [spec.bodyR, 0, 0];
  const nx: [number, number, number] = [-spec.bodyR, 0, 0];
  const py: [number, number, number] = [0, spec.bodyR * 0.75, 0];
  const ny: [number, number, number] = [0, -spec.bodyR * 0.75, 0];
  const pz: [number, number, number] = [0, 0, hl];
  const nz: [number, number, number] = [0, 0, -hl];
  const zc = bodyC;
  pushTri(part, pz, px, py, zc, 0, 0, 0);
  pushTri(part, pz, py, nx, zc, 0, 0, 0);
  pushTri(part, pz, nx, ny, zc, 0, 0, 0);
  pushTri(part, pz, ny, px, zc, 0, 0, 0);
  pushTri(part, nz, py, px, zc, 0, 0, 0);
  pushTri(part, nz, nx, py, zc, 0, 0, 0);
  pushTri(part, nz, ny, nx, zc, 0, 0, 0);
  pushTri(part, nz, px, ny, zc, 0, 0, 0);

  // Tail fan: flat quad behind the body, slight downward tilt.
  const tailC = bodyC.clone().multiplyScalar(0.8);
  const tz0 = -hl;
  const tz1 = -hl - spec.tailLen;
  const tw = spec.tailSpread / 2;
  pushQuad(
    part,
    [-tw * 0.4, 0.01, tz0], [tw * 0.4, 0.01, tz0],
    [tw, -0.06, tz1], [-tw, -0.06, tz1],
    tailC, [0, 0, 0, 0],
  );

  // Wings: 3 tapered, swept quads per side; flap weight grows to the tip.
  const segs = 3;
  for (const side of [-1, 1]) {
    for (let j = 0; j < segs; j++) {
      const f0 = j / segs;
      const f1 = (j + 1) / segs;
      const x0 = side * (spec.bodyR * 0.5 + f0 * (spec.wingspan / 2 - spec.bodyR * 0.5));
      const x1 = side * (spec.bodyR * 0.5 + f1 * (spec.wingspan / 2 - spec.bodyR * 0.5));
      const chord0 = spec.chord * (1 - 0.28 * f0);
      const chord1 = spec.chord * (1 - 0.28 * f1);
      const sweep0 = -spec.sweep * Math.pow(f0, 1.5) * spec.wingspan * 0.4;
      const sweep1 = -spec.sweep * Math.pow(f1, 1.5) * spec.wingspan * 0.4;
      const w0 = Math.abs(x0) / (spec.wingspan / 2);
      const w1 = Math.abs(x1) / (spec.wingspan / 2);
      // Per-vertex colors: lerp wing→tip across the segment.
      const seg: BirdPart = { positions: [], colors: [], flaps: [], indices: [] };
      const ca = wingC.clone().lerp(tipC, f0);
      const cb = wingC.clone().lerp(tipC, f1);
      pushQuad(
        seg,
        [x0, 0, sweep0 + chord0 / 2], [x1, 0, sweep1 + chord1 / 2],
        [x1, 0, sweep1 - chord1 / 2], [x0, 0, sweep0 - chord0 / 2],
        ca, [w0, w1, w1, w0],
      );
      // Recolor the tip-side verts toward the tip color.
      for (let vi = 0; vi < 4; vi++) {
        const cc = vi === 1 || vi === 2 ? cb : ca;
        seg.colors[vi * 3] = cc.r;
        seg.colors[vi * 3 + 1] = cc.g;
        seg.colors[vi * 3 + 2] = cc.b;
      }
      const base = part.positions.length / 3;
      part.positions.push(...seg.positions);
      part.colors.push(...seg.colors);
      part.flaps.push(...seg.flaps);
      for (const ix of seg.indices) part.indices.push(base + ix);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(part.positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(part.colors), 3));
  geo.setAttribute(BIRD_FLAP_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(part.flaps), 1));
  geo.setIndex(part.indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * The shared bird material: vertex-colored, double-sided (wings are
 * single quads), and the wing flap as a vertex-shader node — per-bird
 * phase + per-bird flap rate from the instance id, zero CPU per frame.
 */
export function makeBirdMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const phase = hash(instanceIndex).mul(Math.PI * 2);
  const rate = hash(instanceIndex.mul(3).add(1)).mul(6).add(14);
  const bend = attribute(BIRD_FLAP_ATTRIBUTE, 'float');
  const lift = sin(ambientTimeSeconds.mul(rate).add(phase)).mul(bend).mul(0.32);
  mat.positionNode = positionLocal.add(vec3(0, lift, 0));
  return mat;
}

/** First tick flock k is airborne. */
export function flockSpawnTick(k: number): number {
  return k * BIRD_FLOCK_INTERVAL_TICKS + Math.floor(hash01(k * 7 + 1) * 600);
}

/** Flight param u ∈ [0, 1] of flock k at tick, or null when not airborne. */
export function flockU(k: number, tick: number): number | null {
  const spawn = flockSpawnTick(k);
  if (tick < spawn || tick >= spawn + BIRD_FLOCK_DURATION_TICKS) return null;
  return (tick - spawn) / BIRD_FLOCK_DURATION_TICKS;
}

export interface BirdPose {
  x: number;
  y: number;
  z: number;
  /** Yaw facing the direction of travel (bird geometry faces +z). */
  yaw: number;
  /** Variant index into BIRD_VARIANTS. */
  variant: number;
}

interface Vec2 { x: number; z: number; }

/** Quadratic bezier edge-to-edge path for flock k (seeded, pure). */
function flockPath(k: number, mapHalf: number): { p0: Vec2; c: Vec2; p1: Vec2 } {
  const edge = mapHalf + 12;
  const a0 = hash01(k * 13 + 2) * Math.PI * 2;
  // Roughly across the map: the exit edge opposes the entry edge.
  const a1 = a0 + Math.PI + (hash01(k * 13 + 3) - 0.5) * 1.4;
  const p0 = { x: Math.cos(a0) * edge, z: Math.sin(a0) * edge };
  const p1 = { x: Math.cos(a1) * edge, z: Math.sin(a1) * edge };
  // Bowed control point: the path arcs over the map, never through corners.
  const bow = (hash01(k * 13 + 4) - 0.5) * mapHalf * 1.2;
  const mx = (p0.x + p1.x) / 2;
  const mz = (p0.z + p1.z) / 2;
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dz) || 1;
  const c = { x: mx + (-dz / len) * bow, z: mz + (dx / len) * bow };
  return { p0, c, p1 };
}

function bez(p0: Vec2, c: Vec2, p1: Vec2, u: number): Vec2 {
  const v = 1 - u;
  return {
    x: v * v * p0.x + 2 * v * u * c.x + u * u * p1.x,
    z: v * v * p0.z + 2 * v * u * c.z + u * u * p1.z,
  };
}

function bezTangent(p0: Vec2, c: Vec2, p1: Vec2, u: number): Vec2 {
  return {
    x: 2 * (1 - u) * (c.x - p0.x) + 2 * u * (p1.x - c.x),
    z: 2 * (1 - u) * (c.z - p0.z) + 2 * u * (p1.z - c.z),
  };
}

/**
 * Pose of bird i in flock k at tick (null when the flock is not
 * airborne). Birds trail the leader along the path with lateral
 * offsets; altitude arcs gently. Pure — same (k, i, tick) ⇒ same pose.
 */
export function birdPoseAt(
  k: number,
  i: number,
  tick: number,
  mapHalf: number,
): BirdPose | null {
  const u = flockU(k, tick);
  if (u === null) return null;
  const { p0, c, p1 } = flockPath(k, mapHalf);
  const ui = Math.min(1, Math.max(0, u - i * 0.012));
  const p = bez(p0, c, p1, ui);
  const tan = bezTangent(p0, c, p1, ui);
  const tlen = Math.hypot(tan.x, tan.z) || 1;
  // Lateral V offset, alternating sides behind the leader.
  const side = i === 0 ? 0 : i % 2 === 0 ? 1 : -1;
  const lateral = side * Math.ceil(i / 2) * 2.4;
  const x = p.x + (-tan.z / tlen) * lateral;
  const z = p.z + (tan.x / tlen) * lateral;
  const altitude = 30 + hash01(k * 13 + 5) * 14 + Math.sin(ui * Math.PI) * 5;
  const y = altitude + Math.sin(tick * 0.12 + i * 2.1 + k) * 0.8;
  return {
    x,
    y,
    z,
    yaw: Math.atan2(tan.x, tan.z),
    variant: (k * 5 + i * 3) % BIRD_VARIANTS.length,
  };
}

/**
 * Instanced flyover renderer: one InstancedMesh per variant sharing the
 * flapping material; meshes are created lazily on the first active
 * flyover (an empty sky keeps zero bird meshes — this keeps the
 * instancing draw-call counts honest, same rule as the utility-overlay
 * markers) and hidden when empty (0 draw calls between flyovers). Owns
 * no sim state — `sync` is a pure function of the tick.
 */
export class BirdFlocks {
  private readonly scene: THREE.Scene;
  private readonly material: THREE.MeshStandardMaterial;
  private meshes: THREE.InstancedMesh[] | null = null;
  private readonly dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.material = makeBirdMaterial();
  }

  /** Build the 10 variant meshes on first use (idempotent). */
  private ensureMeshes(): THREE.InstancedMesh[] {
    let meshes = this.meshes;
    if (meshes === null) {
      meshes = [];
      for (const spec of BIRD_VARIANTS) {
        const mesh = new THREE.InstancedMesh(
          buildBirdGeometry(spec),
          this.material,
          BIRD_FLOCK_BIRDS,
        );
        mesh.frustumCulled = false; // flocks cross the whole map
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.visible = false;
        mesh.name = `birds-${spec.name}`;
        this.scene.add(mesh);
        meshes.push(mesh);
      }
      this.meshes = meshes;
    }
    return meshes;
  }

  /** Advance the flyovers to `tick`. Deterministic: pure f(tick). */
  sync(tick: number, mapHalf: number): void {
    const poses: BirdPose[][] = BIRD_VARIANTS.map(() => []);
    const k0 = Math.floor(tick / BIRD_FLOCK_INTERVAL_TICKS);
    let active = 0;
    for (let k = k0 - BIRD_MAX_FLOCKS; k <= k0 + 1; k++) {
      if (k < 0) continue;
      for (let i = 0; i < BIRD_FLOCK_BIRDS; i++) {
        const pose = birdPoseAt(k, i, tick, mapHalf);
        if (pose !== null) {
          const bucket = poses[pose.variant];
          if (bucket !== undefined) {
            bucket.push(pose);
            active++;
          }
        }
      }
    }
    if (active === 0) {
      // No flyover: hide without ever creating the meshes.
      const meshes = this.meshes;
      if (meshes !== null) {
        for (const mesh of meshes) {
          mesh.count = 0;
          mesh.visible = false;
        }
      }
      return;
    }
    const meshes = this.ensureMeshes();
    for (let v = 0; v < meshes.length; v++) {
      const mesh = meshes[v] as THREE.InstancedMesh;
      const list = poses[v] as BirdPose[];
      for (let i = 0; i < list.length; i++) {
        const p = list[i] as BirdPose;
        this.dummy.position.set(p.x, p.y, p.z);
        this.dummy.rotation.set(0, p.yaw, 0);
        this.dummy.scale.setScalar(1.6); // readable at RTS distance
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
      }
      mesh.count = list.length;
      mesh.visible = list.length > 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    const meshes = this.meshes;
    if (meshes !== null) {
      for (const mesh of meshes) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
      }
      this.meshes = null;
    }
    this.material.dispose();
  }
}
