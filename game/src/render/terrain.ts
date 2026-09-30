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
 * NOVATERRA — render/terrain.ts — Meridian Plains terrain meshing.
 *
 * Responsibilities:
 *  - Turn sim-side `TerrainData` into three.js geometry: one mesh per map
 *    chunk (chunking = culling granularity, per tech-stack.md §3), vertex
 *    colors from biomes, a simple animated water plane at the water level.
 *  - Read-only view of sim data: no gameplay logic here, ever.
 *
 * Structure (worker-ready by design):
 *  - `buildChunkMeshData` is a pure function of (terrain, chunk origin,
 *    verts per side) returning plain typed arrays. It has no three.js
 *    dependency and is unit-tested on the data level. When meshing moves to
 *    a worker (deferred — ARCHITECTURE.md D10), this function moves with
 *    only a serialization seam.
 *  - `buildTerrainView` wraps the pure output in BufferGeometries. That is
 *    the only three.js-coupled part.
 *
 * Budgets (locked rendering tier, ARCHITECTURE.md §6):
 *  - 16 chunks → 16 draw calls + 1 water plane = 17 draw calls.
 *  - 16 × 8,192 + 2 = 131,074 triangles — well inside the ≤750k budget.
 *
 * Import-safe under Node/vitest (three.js has no DOM dependency at import
 * time); geometry construction only happens inside buildTerrainView().
 */

import * as THREE from 'three';
import type { TerrainData } from '../sim/terrain';
import { materialColor, positionLocal, sin } from 'three/tsl';
import {
  Biome,
  MERIDIAN_PLAINS,
  rawToWorldHeight,
} from '../sim/terrain';
import { ambientTimeSeconds } from './ambientTime';

/**
 * Water surface Y at a sim-time instant: the plane breathes ±0.09 world
 * units on a ~12.6 s swell around the sim's water level. Pure —
 * deterministic and pause-consistent (frozen tick ⇒ frozen swell).
 */
export function waterBobY(waterLevel: number, tickSeconds: number): number {
  return waterLevel + Math.sin(tickSeconds * 0.5) * 0.09;
}

/**
 * Attach the living-water flow to the water material: two slow
 * brightness bands drift across the plane in the fragment shader
 * (vertex colors would need a subdivided plane; this costs a few ALU
 * per water pixel on 2 triangles — the cheapest moving water there is).
 * Shore foam is deliberately skipped: without a shoreline distance
 * field it would need a texture or per-frame CPU pass, neither of
 * which is cheap.
 */
function attachWaterFlow(mat: THREE.MeshStandardMaterial): void {
  const t = ambientTimeSeconds;
  const bandA = sin(positionLocal.x.mul(0.045).sub(t.mul(0.28)));
  const bandB = sin(
    positionLocal.z.mul(0.06).add(positionLocal.x.mul(0.023)).add(t.mul(0.21)),
  );
  const brighten = bandA.mul(bandB).mul(0.05).add(1);
  mat.colorNode = materialColor.mul(brighten);
}

/** Plain-array chunk mesh: positions/colors/indices, no three.js types. */
export interface ChunkMeshData {
  /** xyz triplets, y-up world units. */
  positions: Float32Array;
  /** rgb triplets in linear working space (matches renderer output). */
  colors: Float32Array;
  /** Triangle indices into the vertex arrays. */
  indices: Uint32Array;
}

/** Biome palette in sRGB hex; converted to linear at module load. */
const PALETTE_SRGB: Record<number, number> = {
  [Biome.WATER_BED]: 0x1d3a4a,
  [Biome.SHORE]: 0xc2a878,
  [Biome.GRASS_LOW]: 0x4f7a3a,
  [Biome.GRASS]: 0x5d8a42,
  [Biome.GRASS_DRY]: 0x7d9a4e,
  [Biome.HIGHLAND]: 0x8a8a7a,
};

const PALETTE_LINEAR: Array<[number, number, number]> = Object.keys(PALETTE_SRGB).map(
  (k) => {
    const hex = PALETTE_SRGB[Number(k)] as number;
    const c = new THREE.Color(hex); // ColorManagement: hex → linear working space
    return [c.r, c.g, c.b] as [number, number, number];
  },
);

/**
 * Linear-space rgb for a biome id. Throws on unknown ids (loud, not silent
 * default colors — a bad biome is a data bug).
 */
export function biomeLinearColor(biome: number): [number, number, number] {
  const c = PALETTE_LINEAR[biome];
  if (c === undefined) {
    throw new Error(`render/terrain: unknown biome id ${biome}`);
  }
  return c;
}

/**
 * Build one chunk's mesh data from the heightfield. Pure: no three.js,
 * no allocation beyond the output arrays, deterministic.
 *
 * @param t terrain data
 * @param vx0 vertex-grid origin column of the chunk
 * @param vz0 vertex-grid origin row of the chunk
 * @param vertsPerSide vertices per chunk side (production: chunkCells + 1)
 */
export function buildChunkMeshData(
  t: TerrainData,
  vx0: number,
  vz0: number,
  vertsPerSide: number,
): ChunkMeshData {
  if (!Number.isInteger(vx0) || !Number.isInteger(vz0) || !Number.isInteger(vertsPerSide)) {
    throw new Error('render/terrain: chunk origin/size must be integers');
  }
  if (vertsPerSide < 2) {
    throw new Error('render/terrain: vertsPerSide must be >= 2');
  }
  if (vx0 < 0 || vz0 < 0 || vx0 + vertsPerSide > t.vertsPerSide || vz0 + vertsPerSide > t.vertsPerSide) {
    throw new Error(
      `render/terrain: chunk [${vx0},${vz0}]+${vertsPerSide} exceeds ${t.vertsPerSide}² heightfield`,
    );
  }
  const n = vertsPerSide;
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const cells = n - 1;
  const indices = new Uint32Array(cells * cells * 6);
  const V = t.vertsPerSide;

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const vx = vx0 + i;
      const vz = vz0 + j;
      const vi = j * n + i;
      const gi = vz * V + vx;
      positions[vi * 3] = vx * t.spacing - t.size / 2;
      positions[vi * 3 + 1] = rawToWorldHeight(t.heights[gi] as number);
      positions[vi * 3 + 2] = vz * t.spacing - t.size / 2;
      const [r, g, b] = biomeLinearColor(t.biomes[gi] as number);
      colors[vi * 3] = r;
      colors[vi * 3 + 1] = g;
      colors[vi * 3 + 2] = b;
    }
  }

  // Winding (a,c,b),(b,c,d): counter-clockwise seen from +y, so with the
  // default CCW front face the terrain faces up.
  let k = 0;
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * n + i;
      const b = j * n + i + 1;
      const c = (j + 1) * n + i;
      const d = (j + 1) * n + i + 1;
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }

  return { positions, colors, indices };
}

/** The built terrain view: chunk meshes + water plane. */
export interface TerrainView {
  /** Group holding the chunk meshes and the water plane. */
  group: THREE.Group;
  /** Water plane mesh (caller animates it, e.g. gentle bobbing). */
  water: THREE.Mesh;
  /**
   * The single vertex-color material shared by all chunk meshes
   * (exposed so the x-ray view in `render/xrayView.ts` can ghost it).
   */
  terrainMaterial: THREE.Material;
  /** Number of chunk meshes (draw calls for terrain). */
  chunkCount: number;
  /** Total triangles: chunks + water plane. */
  triangles: number;
}

/**
 * Build the full Meridian Plains view: one mesh per chunk sharing a single
 * vertex-color material, plus a translucent water plane at the water level.
 */
export function buildTerrainView(t: TerrainData): TerrainView {
  const P = MERIDIAN_PLAINS;
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });

  const vertsPerChunk = P.chunkCells + 1;
  let triangles = 0;
  for (let cz = 0; cz < P.chunksPerSide; cz++) {
    for (let cx = 0; cx < P.chunksPerSide; cx++) {
      const data = buildChunkMeshData(t, cx * P.chunkCells, cz * P.chunkCells, vertsPerChunk);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
      geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geo.computeVertexNormals();
      geo.computeBoundingSphere(); // correct per-chunk bounds ⇒ frustum culling works
      group.add(new THREE.Mesh(geo, material));
      triangles += data.indices.length / 3;
    }
  }

  const waterGeo = new THREE.PlaneGeometry(t.size, t.size);
  waterGeo.rotateX(-Math.PI / 2);
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2e6f9e,
    transparent: true,
    opacity: 0.72,
    roughness: 0.3,
    metalness: 0,
  });
  // Living nature: the water visibly flows (fragment-shader drift bands)
  // and breathes (the caller bobs `water.position.y` via `waterBobY`).
  attachWaterFlow(waterMat);
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.position.y = t.waterLevel;
  group.add(water);
  triangles += 2;

  return {
    group,
    water,
    terrainMaterial: material,
    chunkCount: P.chunksPerSide * P.chunksPerSide,
    triangles,
  };
}
