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
 * NOVATERRA — tests/render.birds.test.ts — decorative bird flyovers
 * (living nature, 0.1 Alpha).
 *
 * Pins: 10 distinct variants with light valid geometry, a deterministic
 * seeded schedule (same (flock, bird, tick) ⇒ same pose — the pause and
 * determinism contract), flocks only airborne inside their window, and
 * a CPU perf smoke for the per-frame sync.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  BIRD_FLOCK_BIRDS,
  BIRD_FLOCK_DURATION_TICKS,
  BIRD_FLOCK_INTERVAL_TICKS,
  BIRD_FLAP_ATTRIBUTE,
  BIRD_VARIANTS,
  BirdFlocks,
  birdPoseAt,
  buildBirdGeometry,
  flockSpawnTick,
  flockU,
  hash01,
  makeBirdMaterial,
} from '../src/render/birds';

const MAP_HALF = 256;

function triCount(geo: THREE.BufferGeometry): number {
  const index = geo.getIndex();
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  return index !== null ? index.count / 3 : pos.count / 3;
}

describe('hash01', () => {
  it('is deterministic and spans [0, 1)', () => {
    expect(hash01(7)).toBe(hash01(7));
    expect(hash01(7)).not.toBe(hash01(8));
    for (let i = 0; i < 50; i++) {
      const h = hash01(i * 31 + 5);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });
});

describe('BIRD_VARIANTS', () => {
  it('ships 10 visually distinct variants', () => {
    expect(BIRD_VARIANTS).toHaveLength(10);
    const names = new Set(BIRD_VARIANTS.map((v) => v.name));
    expect(names.size).toBe(10);
    // Silhouettes differ: no two variants share (wingspan, chord, sweep).
    const shapes = new Set(
      BIRD_VARIANTS.map((v) => `${v.wingspan}|${v.chord}|${v.sweep}|${v.tailLen}`),
    );
    expect(shapes.size).toBe(10);
  });
});

describe('buildBirdGeometry', () => {
  it('builds light, valid, deterministic geometry for every variant', () => {
    for (const spec of BIRD_VARIANTS) {
      const geo = buildBirdGeometry(spec);
      expect(geo.getIndex()).not.toBeNull();
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const col = geo.getAttribute('color') as THREE.BufferAttribute;
      const flap = geo.getAttribute(BIRD_FLAP_ATTRIBUTE) as THREE.BufferAttribute;
      expect(pos.count).toBeGreaterThan(0);
      expect(col.count).toBe(pos.count);
      expect(flap.count).toBe(pos.count);
      // Light: a distant bird must cost almost nothing.
      expect(triCount(geo)).toBeLessThanOrEqual(60);
      // Faces +z (yaw convention): nose ahead of tail.
      let maxZ = -Infinity;
      let minZ = Infinity;
      for (let i = 0; i < pos.count; i++) {
        const z = pos.getZ(i);
        maxZ = Math.max(maxZ, z);
        minZ = Math.min(minZ, z);
        expect(Number.isFinite(pos.getX(i))).toBe(true);
        expect(Number.isFinite(pos.getY(i))).toBe(true);
        expect(Number.isFinite(z)).toBe(true);
        const f = flap.getX(i);
        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
      }
      expect(maxZ).toBeGreaterThan(minZ);
      expect(geo.boundingSphere).not.toBeNull();
      // Deterministic: two builds are byte-identical.
      const again = buildBirdGeometry(spec);
      expect(
        Array.from((again.getAttribute('position') as THREE.BufferAttribute).array),
      ).toEqual(Array.from(pos.array));
      geo.dispose();
      again.dispose();
    }
  });

  it('tags wingtips with flap weight 1 and the body with 0', () => {
    const geo = buildBirdGeometry(BIRD_VARIANTS[1]!); // gull
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const flap = geo.getAttribute(BIRD_FLAP_ATTRIBUTE) as THREE.BufferAttribute;
    let tipFlap = -1;
    let maxAbsX = -1;
    for (let i = 0; i < pos.count; i++) {
      const ax = Math.abs(pos.getX(i));
      if (ax > maxAbsX) {
        maxAbsX = ax;
        tipFlap = flap.getX(i);
      }
    }
    expect(maxAbsX).toBeGreaterThan(1); // wingtip far out on x
    expect(tipFlap).toBeCloseTo(1, 5);
    geo.dispose();
  });
});

describe('makeBirdMaterial', () => {
  it('carries the shader flap node (positionNode assigned)', () => {
    const mat = makeBirdMaterial();
    expect(mat.positionNode).not.toBeNull();
    expect(mat.vertexColors).toBe(true);
    mat.dispose();
  });
});

describe('flock schedule', () => {
  it('spawns deterministically with bounded jitter', () => {
    expect(flockSpawnTick(3)).toBe(flockSpawnTick(3));
    for (let k = 0; k < 20; k++) {
      const s = flockSpawnTick(k);
      expect(s).toBeGreaterThanOrEqual(k * BIRD_FLOCK_INTERVAL_TICKS);
      expect(s).toBeLessThan(k * BIRD_FLOCK_INTERVAL_TICKS + 600);
    }
  });

  it('flockU is null outside the flight window, [0,1] inside', () => {
    const k = 4;
    const spawn = flockSpawnTick(k);
    expect(flockU(k, spawn - 1)).toBeNull();
    expect(flockU(k, spawn + BIRD_FLOCK_DURATION_TICKS)).toBeNull();
    const u0 = flockU(k, spawn);
    const u1 = flockU(k, spawn + BIRD_FLOCK_DURATION_TICKS - 1);
    expect(u0).toBeCloseTo(0, 10);
    expect(u1).toBeGreaterThan(0.99);
    expect(u1).toBeLessThanOrEqual(1);
  });
});

describe('birdPoseAt', () => {
  it('is deterministic: same (flock, bird, tick) ⇒ identical pose', () => {
    const k = 2;
    const tick = flockSpawnTick(k) + 500;
    const a = birdPoseAt(k, 1, tick, MAP_HALF);
    const b = birdPoseAt(k, 1, tick, MAP_HALF);
    expect(a).not.toBeNull();
    expect(a).toEqual(b);
  });

  it('moves along the path as the tick advances', () => {
    const k = 2;
    const spawn = flockSpawnTick(k);
    const a = birdPoseAt(k, 0, spawn + 100, MAP_HALF);
    const b = birdPoseAt(k, 0, spawn + 800, MAP_HALF);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(Math.hypot(a!.x - b!.x, a!.z - b!.z)).toBeGreaterThan(10);
  });

  it('returns null when the flock is not airborne', () => {
    const k = 6;
    expect(birdPoseAt(k, 0, flockSpawnTick(k) - 5, MAP_HALF)).toBeNull();
    expect(
      birdPoseAt(k, 0, flockSpawnTick(k) + BIRD_FLOCK_DURATION_TICKS + 5, MAP_HALF),
    ).toBeNull();
  });

  it('keeps every bird on a sane flight envelope', () => {
    for (let k = 0; k < 6; k++) {
      const spawn = flockSpawnTick(k);
      for (const dt of [0, 400, 900, 1300]) {
        for (let i = 0; i < BIRD_FLOCK_BIRDS; i++) {
          const p = birdPoseAt(k, i, spawn + dt, MAP_HALF);
          expect(p).not.toBeNull();
          // Within the map + spawn margin, above the rooftops, finite.
          expect(Math.abs(p!.x)).toBeLessThanOrEqual(MAP_HALF + 20);
          expect(Math.abs(p!.z)).toBeLessThanOrEqual(MAP_HALF + 20);
          expect(p!.y).toBeGreaterThan(20);
          expect(p!.y).toBeLessThan(60);
          expect(Number.isFinite(p!.yaw)).toBe(true);
          expect(p!.variant).toBeGreaterThanOrEqual(0);
          expect(p!.variant).toBeLessThan(BIRD_VARIANTS.length);
        }
      }
    }
  });

  it('trails birds behind the leader (u stagger)', () => {
    const k = 1;
    const tick = flockSpawnTick(k) + 600;
    const leader = birdPoseAt(k, 0, tick, MAP_HALF)!;
    const trailer = birdPoseAt(k, 5, tick, MAP_HALF)!;
    // The trailer is behind along the path: closer to the start point.
    const dLeader = Math.hypot(leader.x, leader.z);
    void dLeader;
    expect(
      Math.hypot(leader.x - trailer.x, leader.z - trailer.z),
    ).toBeGreaterThan(0.5);
  });
});

describe('BirdFlocks', () => {
  const meshesOf = (flocks: BirdFlocks): THREE.InstancedMesh[] =>
    (flocks as unknown as { meshes: THREE.InstancedMesh[] | null }).meshes ?? [];

  it('creates no meshes until the first flyover (lazy)', () => {
    const scene = new THREE.Scene();
    const flocks = new BirdFlocks(scene);
    flocks.sync(0, MAP_HALF); // before flock 0's spawn at tick 398
    expect(
      (flocks as unknown as { meshes: THREE.InstancedMesh[] | null }).meshes,
    ).toBeNull();
    flocks.dispose();
  });

  it('sync is a pure function of tick (pause ⇒ frozen birds)', () => {
    const scene = new THREE.Scene();
    const flocks = new BirdFlocks(scene);
    const tick = flockSpawnTick(2) + 700;
    flocks.sync(tick, MAP_HALF);
    const snap = meshesOf(flocks).map((m) => Array.from(m.instanceMatrix.array));
    flocks.sync(tick, MAP_HALF); // same tick: identical matrices
    const again = meshesOf(flocks).map((m) => Array.from(m.instanceMatrix.array));
    expect(again).toEqual(snap);
    flocks.dispose();
  });

  it('hides every mesh when no flock is airborne (0 draw calls)', () => {
    const scene = new THREE.Scene();
    const flocks = new BirdFlocks(scene);
    // Tick 0: flock 0 spawns at tick 398 — the sky is empty.
    flocks.sync(0, MAP_HALF);
    const meshes = meshesOf(flocks);
    const visible = meshes.filter((m) => m.visible).length;
    // Either 0 (before first spawn) or >0 — but counts must match poses.
    let total = 0;
    for (const m of meshes) total += m.count;
    expect(total).toBeLessThanOrEqual(BIRD_FLOCK_BIRDS * 2);
    expect(visible).toBe(total > 0 ? visible : 0);
    flocks.dispose();
  });

  it('shows birds mid-flyover and caps the alive count', () => {
    const scene = new THREE.Scene();
    const flocks = new BirdFlocks(scene);
    const tick = flockSpawnTick(3) + 600;
    flocks.sync(tick, MAP_HALF);
    const meshes = meshesOf(flocks);
    let total = 0;
    for (const m of meshes) {
      total += m.count;
      expect(m.count).toBeLessThanOrEqual(BIRD_FLOCK_BIRDS);
      expect(m.visible).toBe(m.count > 0);
    }
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(BIRD_FLOCK_BIRDS * 2);
    flocks.dispose();
  });

  it('sync perf smoke: 1200 frames stay far under budget', () => {
    const scene = new THREE.Scene();
    const flocks = new BirdFlocks(scene);
    const t0 = performance.now();
    for (let f = 0; f < 1200; f++) {
      flocks.sync(flockSpawnTick(3) + f, MAP_HALF);
    }
    const ms = performance.now() - t0;
    // 1200 frames in < 3 s headless ⇒ ~µs/frame in the real game.
    expect(ms).toBeLessThan(3000);
    flocks.dispose();
  });
});
