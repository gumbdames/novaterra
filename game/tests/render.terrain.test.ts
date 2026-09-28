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
