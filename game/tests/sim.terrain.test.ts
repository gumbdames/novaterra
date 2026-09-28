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
 * NOVATERRA — sim/terrain tests (headless).
 *
 * Covers: determinism (same seed ⇒ identical digest; different seed ⇒
 * different terrain), bilinear height lookup against hand-computed values,
 * water mask agreement, ~5% water coverage, river continuity (flood fill
 * from the north edge reaches the south edge), a separate lake component,
 * and spawn placement (on land, separated, in bounds).
 */
import { describe, expect, it } from 'vitest';
import {
  Biome,
  digestTerrain,
  generateTerrain,
  heightAt,
  isWater,
  MERIDIAN_PLAINS,
  rawToWorldHeight,
  waterFraction,
  worldToRawHeight,
} from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';
import { createRngBank } from '../src/sim/rng';

/** Tiny hand-built 3×3 heightfield: world coords run -10..10, spacing 10. */
function tinyTerrain(): TerrainData {
  const heights = new Uint16Array([
    worldToRawHeight(0),
    worldToRawHeight(5),
    worldToRawHeight(10),
    worldToRawHeight(5),
    worldToRawHeight(10),
    worldToRawHeight(15),
    worldToRawHeight(10),
    worldToRawHeight(15),
    worldToRawHeight(20),
  ]);
  return {
    name: 'tiny',
    seed: 1,
    size: 20,
    vertsPerSide: 3,
    spacing: 10,
    heights,
    biomes: new Uint8Array(9).fill(Biome.GRASS),
    waterLevel: 5,
    spawns: [
      { x: -5, z: -5 },
      { x: 5, z: 5 },
    ],
  };
}

/** 4-connected water components over the vertex grid (for river/lake tests). */
function waterComponents(t: TerrainData): number[][] {
  const V = t.vertsPerSide;
  const seen = new Uint8Array(V * V);
  const comps: number[][] = [];
  const isWet = (i: number): boolean =>
    rawToWorldHeight(t.heights[i] as number) < t.waterLevel;
  for (let s = 0; s < V * V; s++) {
    if (seen[s] === 1 || !isWet(s)) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      comp.push(cur);
      const cx = cur % V;
      const cz = Math.floor(cur / V);
      const neighbors: number[] = [];
      if (cx > 0) neighbors.push(cur - 1);
      if (cx < V - 1) neighbors.push(cur + 1);
      if (cz > 0) neighbors.push(cur - V);
      if (cz < V - 1) neighbors.push(cur + V);
      for (const nb of neighbors) {
        if (seen[nb] === 0 && isWet(nb)) {
          seen[nb] = 1;
          stack.push(nb);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

describe('sim/terrain', () => {
  it('is deterministic: same seed ⇒ identical digest', () => {
    const a = generateTerrain(MERIDIAN_PLAINS.seed);
    const b = generateTerrain(MERIDIAN_PLAINS.seed);
    expect(digestTerrain(a)).toBe(digestTerrain(b));
    expect(a.waterLevel).toBe(b.waterLevel);
    expect(a.spawns).toEqual(b.spawns);
  });

  it('different seeds produce different terrain', () => {
    const a = generateTerrain(MERIDIAN_PLAINS.seed);
    const b = generateTerrain(MERIDIAN_PLAINS.seed + 1);
    expect(digestTerrain(a)).not.toBe(digestTerrain(b));
    let diff = 0;
    for (let i = 0; i < a.heights.length; i += 97) {
      if (a.heights[i] !== b.heights[i]) diff++;
    }
    expect(diff).toBeGreaterThan(0);
  });

  it('heightAt matches hand-computed bilinear values on a synthetic field', () => {
    const t = tinyTerrain();
    // Vertex-exact (modulo uint16 quantization dust).
    expect(heightAt(t, -10, -10)).toBeCloseTo(0, 2);
    expect(heightAt(t, 0, 0)).toBeCloseTo(10, 2);
    expect(heightAt(t, 10, 10)).toBeCloseTo(20, 2);
    // Bilinear: center of the (-10,-10)..(0,0) cell averages 0,5,5,10.
    expect(heightAt(t, -5, -5)).toBeCloseTo(5, 2);
    // Edge midpoint: average of the 5 and 10 vertices.
    expect(heightAt(t, 5, -10)).toBeCloseTo(7.5, 2);
  });

  it('heightAt clamps to the map bounds', () => {
    const t = tinyTerrain();
    expect(heightAt(t, -1000, -1000)).toBeCloseTo(heightAt(t, -10, -10), 9);
    expect(heightAt(t, 1000, 1000)).toBeCloseTo(heightAt(t, 10, 10), 9);
  });

  it('isWater agrees with the height < waterLevel mask', () => {
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    const rng = createRngBank(777);
    for (let i = 0; i < 300; i++) {
      const x = rng.range('test', -256, 256);
      const z = rng.range('test', -256, 256);
      expect(isWater(t, x, z)).toBe(heightAt(t, x, z) < t.waterLevel);
    }
  });

  it('water covers ~5% of the map (locked Meridian Plains character)', () => {
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    const frac = waterFraction(t);
    expect(frac).toBeGreaterThanOrEqual(0.04);
    expect(frac).toBeLessThanOrEqual(0.06);
  });

  it('the river runs continuously from the north edge to the south edge', () => {
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    const V = t.vertsPerSide;
    const comps = waterComponents(t);
    // Some water component touches both the north (vz=0) and south (vz=V-1) edges.
    const river = comps.some(
      (c) => c.some((i) => i < V) && c.some((i) => i >= V * (V - 1)),
    );
    expect(river).toBe(true);
  });

  it('has a separate lake component besides the river', () => {
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    const comps = waterComponents(t);
    expect(comps.length).toBeGreaterThanOrEqual(2);
  });

  it('spawn points are on land, well separated, and inside the map', () => {
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    expect(t.spawns.length).toBe(2);
    const [a, b] = t.spawns as [{ x: number; z: number }, { x: number; z: number }];
    for (const s of [a, b]) {
      expect(isWater(t, s.x, s.z)).toBe(false);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(256);
      expect(Math.abs(s.z)).toBeLessThanOrEqual(256);
    }
    const dist = Math.hypot(a.x - b.x, a.z - b.z);
    // Generous, peaceful-play separation on a 512-unit map.
    expect(dist).toBeGreaterThanOrEqual(300);
  });

  it('height encoding round-trips within half a quantization step', () => {
    for (const h of [-10, -3.25, 0, 6.5, 17.75, 30]) {
      const rt = rawToWorldHeight(worldToRawHeight(h));
      expect(Math.abs(rt - h)).toBeLessThanOrEqual(40 / 65535);
    }
  });

  it('map metadata matches the locked design', () => {
    expect(MERIDIAN_PLAINS.name).toBe('Meridian Plains');
    expect(MERIDIAN_PLAINS.size).toBe(512);
    expect(MERIDIAN_PLAINS.waterTargetFraction).toBe(0.05);
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    expect(t.vertsPerSide).toBe(257);
    expect(t.heights.length).toBe(257 * 257);
    expect(t.biomes.length).toBe(257 * 257);
  });
});
