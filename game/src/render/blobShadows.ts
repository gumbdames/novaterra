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
 * along with this program. If you did, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — render/blobShadows.ts — one-draw-call blob shadows.
 *
 * Final-review R5 visual lift (2026-10-01): the scene has no shadow
 * maps (a directional cascade over a 2 km map would cost more than it
 * buys), so every unit and building gets a cheap ground blob instead —
 * a single `THREE.InstancedMesh` of soft radial-gradient quads, one
 * instance per entity, laid flat on the terrain/water beneath it.
 *
 * Cost: exactly 1 draw call; per frame O(entities) matrix writes
 * (the same order of work the entity instancer already does), one
 * 64x64 RGBA texture (16 KB, generated once). Aircraft shadow the
 * ground *beneath* them (classic blob behavior — the hover gap is
 * what sells the altitude); sea units shadow the waterline.
 *
 * Headless-safe: `three` core only (no DOM at import, no WebGPU),
 * pure typed-array texture generation. `sync()` is a pure function
 * of the world + height sampler, so the layout math is unit-tested
 * in `tests/render.blobShadows.test.ts` without constructing a mesh.
 */

import * as THREE from 'three';
import type { World } from '../sim/world';
import { BUILDING_DEFS, CELL_WORLD_SIZE, cellCenterWorld } from '../sim/city';
import { groundYAt } from './terrainHeight';
import type { TerrainData } from '../sim/terrain';
import { hullSizeFor } from './entities';

/** Shadow instances the single InstancedMesh can hold (units + buildings). */
export const BLOB_SHADOW_CAPACITY = 4096;
/** Lift above the ground plane so quads never z-fight the terrain. */
export const BLOB_SHADOW_LIFT = 0.25;
/** Softness of the radial falloff (0 = hard disc, 1 = fully soft). */
const BLOB_SOFTNESS = 0.65;
/** Quad diameter = hull footprint × this (the blob is smaller than the hull). */
const BLOB_HULL_SCALE = 1.1;
/** Quad diameter = building footprint × this. */
const BLOB_BUILDING_SCALE = 1.05;
/** Texture resolution (px, square). */
const BLOB_TEX_SIZE = 64;

/** One shadow entry: world position + quad diameter. Pure data. */
export interface BlobShadowEntry {
  x: number;
  y: number;
  z: number;
  diameter: number;
}

/**
 * Collect this frame's shadow entries from the world: every living
 * unit plus every building. Pure — no three.js, no mutation — so
 * tests can assert the layout without a renderer.
 *
 * `heightAt` maps (x, z, domain) → ground Y; pass `groundYAt` bound
 * to the scene's terrain/waterLevel in the game, or a stub in tests.
 */
export function collectBlobShadows(
  world: World,
  heightAt: (x: number, z: number, domain: 'land' | 'air' | 'sea') => number,
  maxEntries: number = BLOB_SHADOW_CAPACITY,
): BlobShadowEntry[] {
  const out: BlobShadowEntry[] = [];
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    if (out.length >= maxEntries) break;
    const hull = hullSizeFor(u.kind);
    const diameter = Math.max(hull.x, hull.z, 1) * BLOB_HULL_SCALE;
    out.push({
      x: u.x,
      y: heightAt(u.x, u.z, u.domain as 'land' | 'air' | 'sea') + BLOB_SHADOW_LIFT,
      z: u.z,
      diameter,
    });
  }
  for (const b of world.city.buildings) {
    if (out.length >= maxEntries) break;
    const def = BUILDING_DEFS[b.kind];
    const footprint = def ? Math.max(def.footprintW, def.footprintH) * CELL_WORLD_SIZE : 4;
    out.push({
      x: cellCenterWorld(b.cx),
      y: heightAt(cellCenterWorld(b.cx), cellCenterWorld(b.cz), 'land') + BLOB_SHADOW_LIFT,
      z: cellCenterWorld(b.cz),
      diameter: footprint * BLOB_BUILDING_SCALE,
    });
  }
  return out;
}

/** Radial-gradient alpha texture (white core → transparent edge). */
export function makeBlobShadowTexture(): THREE.DataTexture {
  const size = BLOB_TEX_SIZE;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy) * 2; // 0 center → 1 edge
      // Solid-ish core, soft falloff to the rim.
      const inner = Math.max(0, 1 - dist / (1 - BLOB_SOFTNESS * 0.5));
      const alpha = Math.max(0, Math.min(1, inner * inner * (3 - 2 * inner)));
      const i = (y * size + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.needsUpdate = true;
  return tex;
}

/**
 * The one-draw-call shadow layer. Owns its InstancedMesh; call
 * `sync(world)` once per frame (usually from `EntityRenderer.sync`).
 */
export class BlobShadowSystem {
  private readonly mesh: THREE.InstancedMesh;
  private readonly terrain: TerrainData | null;
  private readonly waterLevel: number;
  private readonly dummy = new THREE.Object3D();
  private disposed = false;

  constructor(scene: THREE.Scene, terrain: TerrainData | null, waterLevel: number) {
    this.terrain = terrain;
    this.waterLevel = waterLevel;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2); // lie flat; instance matrices then only position + scale
    const mat = new THREE.MeshBasicMaterial({
      map: makeBlobShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.34,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, BLOB_SHADOW_CAPACITY);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // instances span the whole map
    mesh.renderOrder = 2; // after terrain, before billboards
    mesh.count = 0;
    mesh.name = 'blobShadows';
    scene.add(mesh);
    this.mesh = mesh;
  }

  /** Rewrite this frame's shadow instances from the world. */
  sync(world: World): void {
    if (this.disposed) return;
    const heightAt = (x: number, z: number, domain: 'land' | 'air' | 'sea') =>
      groundYAt(this.terrain, this.waterLevel, domain, x, z);
    const entries = collectBlobShadows(world, heightAt);
    const n = Math.min(entries.length, BLOB_SHADOW_CAPACITY);
    for (let i = 0; i < n; i++) {
      // B27: no `!` — i < n <= entries.length by loop bound.
      const e = entries[i];
      if (e === undefined) continue;
      this.dummy.position.set(e.x, e.y, e.z);
      this.dummy.scale.set(e.diameter, 1, e.diameter);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    ((this.mesh.material as THREE.MeshBasicMaterial).map as THREE.Texture | null)?.dispose();
  }

  /**
   * Exploration bet C7 (2026-10-02): blob shadows fade with darkness
   * (fake AO decals at full strength would look painted on at night).
   * `f` is 1.0 by day, ~0.3 at deep night (see sunParams().blobShadow).
   */
  setStrength(f: number): void {
    if (this.disposed) return;
    (this.mesh.material as THREE.MeshBasicMaterial).opacity =
      0.34 * Math.min(1, Math.max(0, f));
  }
}
