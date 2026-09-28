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
 * NOVATERRA — deterministic benchmark scene layout (Phase 1, step 2).
 *
 * Pure module: computes per-instance transforms (position, scale, yaw,
 * color) for the benchmark's two instanced entity types. No DOM, no
 * three.js — the browser scene module turns these into InstancedMeshes.
 *
 * Determinism matters: the same (count, seed) must produce the same layout
 * on every run and every machine, so numbers are comparable across runs.
 * The PRNG is a local mulberry32 — the sim gets its own RNG in step 3;
 * the bench stays standalone.
 */

/** Ground plane extent (matches the scaffold's 600×600 placeholder). */
export const BENCH_GROUND_SIZE = 600;

/** Fixed seeds: the layout never changes between runs. */
export const BENCH_BUILDING_SEED = 1337;
export const BENCH_UNIT_SEED = 4242;

/** Per-instance transform for a unit box geometry. y is the box center. */
export interface InstanceTransform {
  x: number;
  y: number;
  z: number;
  /** Scale factors applied to the unit box. */
  sx: number;
  sy: number;
  sz: number;
  /** Yaw in radians. */
  rotY: number;
  /** RGB color, each channel 0..1. */
  color: [number, number, number];
}

/**
 * mulberry32 — tiny deterministic PRNG. Same seed ⇒ same sequence, on any
 * engine. (Step 3's sim RNG lives in src/sim/rng.ts; this one is bench-local
 * so the harness has zero sim dependencies.)
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Lay out `count` building instances on a jittered grid covering the ground
 * plane. Grid (not pure random) keeps density constant as the sweep grows —
 * otherwise large sweep points would just measure overdraw of one pile.
 * Footprints 2–5 units, heights 3–24 biased toward low (city skyline feel).
 */
export function layoutBuildings(
  count: number,
  seed: number = BENCH_BUILDING_SEED,
): InstanceTransform[] {
  const rand = mulberry32(seed);
  const half = BENCH_GROUND_SIZE / 2 - 8; // keep a margin from the plane edge
  const cols = Math.ceil(Math.sqrt(count));
  const cell = (half * 2) / cols;
  const out: InstanceTransform[] = [];

  for (let i = 0; i < count; i++) {
    const cx = i % cols;
    const cz = Math.floor(i / cols);
    const jx = (rand() - 0.5) * cell * 0.6;
    const jz = (rand() - 0.5) * cell * 0.6;
    const x = -half + (cx + 0.5) * cell + jx;
    const z = -half + (cz + 0.5) * cell + jz;
    const sx = 2 + rand() * 3;
    const sz = 2 + rand() * 3;
    const sy = 3 + rand() * rand() * 21;
    const shade = 0.55 + rand() * 0.45;
    out.push({
      x,
      y: sy / 2,
      z,
      sx,
      sy,
      sz,
      rotY: (rand() - 0.5) * 0.6,
      color: [0.35 * shade, 0.48 * shade, 0.66 * shade],
    });
  }
  return out;
}

/**
 * Lay out `count` unit instances (the second entity type — small warm boxes
 * standing in for vehicles/civilians) scattered over the same plane.
 */
export function layoutUnits(
  count: number,
  seed: number = BENCH_UNIT_SEED,
): InstanceTransform[] {
  const rand = mulberry32(seed);
  const half = BENCH_GROUND_SIZE / 2 - 8;
  const out: InstanceTransform[] = [];

  for (let i = 0; i < count; i++) {
    const x = (rand() * 2 - 1) * half;
    const z = (rand() * 2 - 1) * half;
    const s = 0.9 + rand() * 0.6;
    const shade = 0.6 + rand() * 0.4;
    out.push({
      x,
      y: 1.1 * s,
      z,
      sx: 1.2 * s,
      sy: 2.2 * s,
      sz: 1.2 * s,
      rotY: rand() * Math.PI * 2,
      color: [0.85 * shade, 0.62 * shade, 0.35 * shade],
    });
  }
  return out;
}
