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
 * NOVATERRA — render/nature.ts — decorative nature scatter (0.1 Alpha).
 *
 * Purpose: scatter nature props (procedural textured trees from
 * render/natureTrees.ts, Kenney rock/bush GLBs) over land
 * that has no building, road, or unit — pure decoration, zero sim
 * impact. Render-only: the sim never knows these props exist.
 *
 * Determinism: placement is a pure function of (cell, seed) through an
 * integer hash — no RNG state, no per-frame updates, so props never
 * shimmer or pop between frames. Built once per game in `ui/game.ts`.
 *
 * Density: sparse — a land cell has an ~8% chance of a prop. Each prop
 * kind renders as one InstancedMesh per geometry (shared geometry +
 * material from the loaded model map; the view owns only the instance
 * attributes).
 *
 * Known limitation: props are placed once at game start. A road or
 * building placed later can overlap a prop (the prop pokes through) —
 * decorative only, no gameplay effect.
 *
 * Import-safe under Node/vitest (three.js has no DOM at import time).
 */

import * as THREE from 'three';

import type { LoadedModel } from './models';
import type { TerrainData } from '../sim/terrain';
import { heightAt, isWater } from '../sim/terrain';

/** Weighted prop pick list: [model key, weight]. */
const PROP_TABLE: Array<readonly [string, number]> = [
  ['propTreeOak', 0.14],
  ['propTreeBirch', 0.1],
  ['propTreePineTall', 0.1],
  ['propTreePine', 0.07],
  ['propTreeOldOak', 0.07],
  ['propTreePoplar', 0.07],
  ['propRockLarge', 0.07],
  ['propRockTall', 0.07],
  ['propRockSmall', 0.06],
  ['propBushDetailed', 0.13],
  ['propBushLarge', 0.12],
];

/** Scatter cell size in world units. */
const SCATTER_STEP = 4;
/** Chance a land cell gets a prop. */
const PROP_DENSITY = 0.08;
/** Props stay this far above the waterline (avoids beach clipping). */
const SHORE_MARGIN = 0.4;

/**
 * Deterministic 2D integer hash → [0, 1). Pure function of
 * (cellX, cellZ, seed, salt); identical inputs give identical outputs
 * on every platform (all ops are 32-bit integer math).
 */
export function hashCell(cellX: number, cellZ: number, seed: number, salt: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (cellX | 0), 374761393);
  h = Math.imul(h ^ (cellZ | 0), 668265263);
  h = Math.imul(h ^ (salt | 0), 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface NatureScatterOptions {
  terrain: TerrainData;
  /** Loaded prop models (keys from PROP_TABLE); missing keys are skipped. */
  models: Map<string, LoadedModel>;
  /** World-space occupancy test: buildings, roads, units at build time. */
  isOccupied: (x: number, z: number) => boolean;
  /** Map seed — decorrelates scatter between games. */
  seed: number;
}

export interface NatureView {
  group: THREE.Group;
  /** Releases instance attributes (shared geo/mat stay with the models map). */
  dispose(): void;
}

interface Placement {
  key: string;
  geoIndex: number;
  matrix: THREE.Matrix4;
}

/**
 * Build the decorative scatter for one game. Returns null when no prop
 * model loaded (or no land cells qualify) — the game plays fine without
 * decoration.
 */
export function buildNatureView(opts: NatureScatterOptions): NatureView | null {
  const { terrain, models, isOccupied, seed } = opts;
  const half = terrain.size / 2;
  const n = Math.floor(terrain.size / SCATTER_STEP);
  const placements: Placement[] = [];
  const dummy = new THREE.Object3D();

  // Cumulative weights for the kind pick.
  const totalWeight = PROP_TABLE.reduce((a, [, w]) => a + w, 0);

  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      if (hashCell(cx, cz, seed, 1) >= PROP_DENSITY) continue;
      const x = -half + (cx + 0.5) * SCATTER_STEP;
      const z = -half + (cz + 0.5) * SCATTER_STEP;
      if (isWater(terrain, x, z)) continue;
      const y = heightAt(terrain, x, z);
      if (y < terrain.waterLevel + SHORE_MARGIN) continue;
      if (isOccupied(x, z)) continue;

      // Weighted kind pick.
      const roll = hashCell(cx, cz, seed, 2) * totalWeight;
      let acc = 0;
      let key: string | null = null;
      for (const [k, w] of PROP_TABLE) {
        acc += w;
        if (roll < acc) {
          key = k;
          break;
        }
      }
      if (key === null) continue;
      const model = models.get(key);
      if (model === undefined || model.geometries.length === 0) continue;

      const s = 0.8 + hashCell(cx, cz, seed, 3) * 0.5;
      dummy.position.set(x, y - 0.05, z);
      dummy.rotation.set(0, hashCell(cx, cz, seed, 4) * Math.PI * 2, 0);
      dummy.scale.setScalar(s);
      dummy.updateMatrix();
      for (let gi = 0; gi < model.geometries.length; gi++) {
        placements.push({ key, geoIndex: gi, matrix: dummy.matrix.clone() });
      }
    }
  }

  if (placements.length === 0) return null;

  const group = new THREE.Group();
  group.name = 'nature';
  const meshes: THREE.InstancedMesh[] = [];
  // Group placements by (key, geoIndex) → one InstancedMesh each.
  const byKind = new Map<string, Placement[]>();
  for (const p of placements) {
    const k = `${p.key}:${p.geoIndex}`;
    const arr = byKind.get(k);
    if (arr !== undefined) arr.push(p);
    else byKind.set(k, [p]);
  }
  for (const list of byKind.values()) {
    const first = list[0] as Placement;
    const model = models.get(first.key) as LoadedModel;
    const geo = model.geometries[first.geoIndex] as THREE.BufferGeometry;
    const mat = model.materials[first.geoIndex] as THREE.Material;
    const inst = new THREE.InstancedMesh(geo, mat, list.length);
    for (let i = 0; i < list.length; i++) {
      inst.setMatrixAt(i, (list[i] as Placement).matrix);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false; // one mesh spans the map; cull per chunk later
    group.add(inst);
    meshes.push(inst);
  }

  return {
    group,
    dispose(): void {
      for (const m of meshes) {
        group.remove(m);
        m.dispose(); // instance attributes only; geo/mat are shared
      }
    },
  };
}
