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
 * NOVATERRA — render/terrain tests (data level, headless).
 *
 * Covers: chunk mesh vertex/index counts and layout, vertex positions and
 * biome colors against hand-computed values, pinned triangle winding
 * (up-facing), loud rejections, and the production view totals (16 chunks,
 * draw calls, triangles — the render budget line).
 */
import { describe, expect, it } from 'vitest';
import {
  biomeLinearColor,
  buildChunkMeshData,
  buildTerrainView,
  WATER_FLOW,
  waterFlowBrightness,
  waterRippleTilt,
} from '../src/render/terrain';
import {
  Biome,
  generateTerrain,
  MERIDIAN_PLAINS,
  rawToWorldHeight,
  worldToRawHeight,
} from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';

/** Synthetic 5×5 heightfield: world coords -20..20, spacing 10. */
function tinyTerrain(): TerrainData {
  const heights = new Uint16Array(25);
  const biomes = new Uint8Array(25);
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) {
      heights[j * 5 + i] = worldToRawHeight(i * 5 + j); // hand-computable
      biomes[j * 5 + i] = (i + j) % 2 === 0 ? Biome.GRASS : Biome.SHORE;
    }
  }
  return {
    name: 'tiny',
    seed: 1,
    size: 40,
    vertsPerSide: 5,
    spacing: 10,
    heights,
    biomes,
    waterLevel: -100, // nothing is water here
    spawns: [{ x: 0, z: 0 }],
  };
}

describe('render/terrain', () => {
  it('builds the expected vertex/index counts for a 3×3 chunk', () => {
    const t = tinyTerrain();
    const m = buildChunkMeshData(t, 0, 0, 3);
    expect(m.positions.length).toBe(3 * 3 * 3);
    expect(m.colors.length).toBe(3 * 3 * 3);
    // 2×2 cells × 2 triangles × 3 indices.
    expect(m.indices.length).toBe(2 * 2 * 2 * 3);
  });

  it('places vertices at the right world positions with biome colors', () => {
    const t = tinyTerrain();
    const m = buildChunkMeshData(t, 1, 1, 3);
    // Chunk vertex (i=2, j=1) → grid (vx=3, vz=2) → world (10, ?, 0).
    const vi = 1 * 3 + 2;
    expect(m.positions[vi * 3]).toBeCloseTo(10, 9);
    expect(m.positions[vi * 3 + 2]).toBeCloseTo(0, 9);
    // Height: synthetic field stores i*5 + j = 3*5 + 2 = 17.
    expect(m.positions[vi * 3 + 1]).toBeCloseTo(
      rawToWorldHeight(worldToRawHeight(17)),
      6,
    );
    // Biome at grid (3,2): (3+2) odd → SHORE. Colors are stored as float32,
    // so compare against float32-rounded expectations.
    const [r, g, b] = biomeLinearColor(Biome.SHORE);
    expect(m.colors[vi * 3]).toBeCloseTo(r, 6);
    expect(m.colors[vi * 3 + 1]).toBeCloseTo(g, 6);
    expect(m.colors[vi * 3 + 2]).toBeCloseTo(b, 6);
  });

  it('pins the triangle winding (up-facing)', () => {
    const t = tinyTerrain();
    const m = buildChunkMeshData(t, 0, 0, 3);
    // Cell (0,0): a=0, b=1, c=3, d=4 → (a,c,b),(b,c,d) faces +y.
    expect(Array.from(m.indices.slice(0, 6))).toEqual([0, 3, 1, 1, 3, 4]);
  });

  it('rejects out-of-range chunks and bad sizes loudly', () => {
    const t = tinyTerrain();
    expect(() => buildChunkMeshData(t, 3, 3, 3)).toThrow(); // exceeds 5²
    expect(() => buildChunkMeshData(t, -1, 0, 3)).toThrow();
    expect(() => buildChunkMeshData(t, 0, 0, 1)).toThrow();
    expect(() => buildChunkMeshData(t, 0.5, 0, 3)).toThrow();
  });

  it('biomeLinearColor throws on unknown biomes', () => {
    expect(() => biomeLinearColor(999)).toThrow();
    const c = biomeLinearColor(Biome.GRASS);
    expect(c.length).toBe(3);
    for (const v of c) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('production view: 16 chunks, 17 draw calls, ~131k triangles', () => {
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    const view = buildTerrainView(t);
    expect(view.chunkCount).toBe(16);
    expect(view.group.children.length).toBe(17); // 16 chunks + water
    // 16 chunks × (64×64 cells × 2 tris) + 2 water tris.
    expect(view.triangles).toBe(16 * 64 * 64 * 2 + 2);
    expect(view.water.position.y).toBeCloseTo(t.waterLevel, 9);
  });
});

/**
 * Water-flow regression pins (0.1 Alpha). The actual pixels run in the
 * fragment shader, which no unit test can see — so these pin the
 * CPU-side contract instead: the JS mirrors of the shader math stay in
 * their designed ranges, the pattern provably moves over time and
 * space (the bug was invisible water: ±5% bands drifting ~22 s/cycle),
 * and the tuning constants stay in the sane regime documented in
 * `WATER_FLOW` (visible structure at map scale, no strobing).
 */
describe('water flow', () => {
  const F = WATER_FLOW;
  const TAU = Math.PI * 2;

  it('brightness stays in [1-contrast, 1+contrast] over the whole plane and time', () => {
    for (let x = -256; x <= 256; x += 16) {
      for (let z = -256; z <= 256; z += 16) {
        for (let t = 0; t <= 20; t += 1) {
          const b = waterFlowBrightness(x, z, t);
          expect(b).toBeGreaterThanOrEqual(1 - F.contrast - 1e-12);
          expect(b).toBeLessThanOrEqual(1 + F.contrast + 1e-12);
        }
      }
    }
  });

  it('the bands actually travel: brightness at a fixed point swings over seconds', () => {
    // Sample a few points over two full drift cycles; a visible effect
    // needs a large fraction of the ±contrast swing within ~10 s.
    let maxSwing = 0;
    for (const [x, z] of [[0, 0], [120, -80], [-200, 150]] as const) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let t = 0; t <= 20; t += 0.25) {
        const b = waterFlowBrightness(x, z, t);
        lo = Math.min(lo, b);
        hi = Math.max(hi, b);
      }
      maxSwing = Math.max(maxSwing, hi - lo);
    }
    expect(maxSwing).toBeGreaterThan(F.contrast * 1.5); // ≥ ±15% swing
  });

  it('the bands have spatial structure (not a whole-plane wash)', () => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let x = -256; x <= 256; x += 8) {
      for (let z = -256; z <= 256; z += 8) {
        const b = waterFlowBrightness(x, z, 0);
        lo = Math.min(lo, b);
        hi = Math.max(hi, b);
      }
    }
    expect(hi - lo).toBeGreaterThan(F.contrast * 1.5);
  });

  it('ripple tilt is modest everywhere and nonzero somewhere', () => {
    let maxMag = 0;
    for (let x = -256; x <= 256; x += 16) {
      for (let z = -256; z <= 256; z += 16) {
        for (let t = 0; t <= 10; t += 0.5) {
          const [tx, tz] = waterRippleTilt(x, z, t);
          expect(Number.isFinite(tx)).toBe(true);
          expect(Number.isFinite(tz)).toBe(true);
          const mag = Math.hypot(tx, tz);
          // atan(0.2) ≈ 11°: the shimmer must never tilt past that.
          expect(mag).toBeLessThanOrEqual(0.2);
          maxMag = Math.max(maxMag, mag);
        }
      }
    }
    expect(maxMag).toBeGreaterThan(0.05); // not a degenerate flat plane
  });

  it('the ripple travels over time', () => {
    let maxSwing = 0;
    for (const [x, z] of [[30, 40], [-150, 90]] as const) {
      let loX = Infinity;
      let hiX = -Infinity;
      for (let t = 0; t <= 10; t += 0.25) {
        const [tx] = waterRippleTilt(x, z, t);
        loX = Math.min(loX, tx);
        hiX = Math.max(hiX, tx);
      }
      maxSwing = Math.max(maxSwing, hiX - loX);
    }
    expect(maxSwing).toBeGreaterThan(0.05);
  });

  it('tuning constants stay in the designed visible-but-not-strobing regime', () => {
    expect(F.contrast).toBeGreaterThanOrEqual(0.1); // visible at a glance
    expect(F.contrast).toBeLessThanOrEqual(0.3); // not garish
    const waves = [
      { kx: F.bandAKx, kz: F.bandAKz, w: F.bandAW },
      { kx: F.bandBKx, kz: F.bandBKz, w: F.bandBW },
      { kx: F.ripple1K, kz: 0, w: F.ripple1W },
      { kx: F.ripple2Kx, kz: F.ripple2Kz, w: F.ripple2W },
    ];
    for (const wave of waves) {
      const wavelength = TAU / Math.hypot(wave.kx, wave.kz);
      const period = TAU / wave.w;
      // 15–120 world units on a 512-unit plane: several waves across it.
      expect(wavelength).toBeGreaterThanOrEqual(15);
      expect(wavelength).toBeLessThanOrEqual(120);
      // 2–20 s cycles: clearly moving, far from 60 fps strobing.
      expect(period).toBeGreaterThanOrEqual(2);
      expect(period).toBeLessThanOrEqual(20);
    }
    // Peak slope from the constants must match the tilt bound above:
    // c1 and c2 can hit ±1 together, so tiltX ≤ 0.1+0.063, tiltZ ≤ 0.084.
    const peakSlope = Math.hypot(
      Math.abs(F.ripple1Slope) + Math.abs(F.ripple2SlopeX),
      Math.abs(F.ripple2SlopeZ),
    );
    expect(peakSlope).toBeLessThanOrEqual(0.2);
  });
});
