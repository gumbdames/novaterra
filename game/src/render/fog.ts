/**
 * NOVATERRA — render/fog.ts — fog-of-war shroud (fun-audit C3, 2026-10-02).
 *
 * Render-side only: a read-only view of the sim's explored grid
 * (sim/fog.ts). One height-conforming transparent plane (64x64 quads)
 * with a 64x64 RGBA DataTexture: unexplored cells render near-black,
 * explored-but-unseen cells dim, currently visible cells transparent.
 * +1 draw call, texture repainted at fog cadence (never per frame).
 *
 * Pure helpers (`fogCellColor`, `paintFogTexture`) are Node-testable;
 * the `FogShroud` class owns the three.js objects. The class never
 * mutates sim state — it reads `world.fog` (treating a missing state
 * as fully unexplored) and `computeVisibleCells` from sim/fog.ts.
 */

import * as THREE from 'three';
import type { World } from '../sim/world';
import type { TerrainData } from '../sim/terrain';
import { rawToWorldHeight } from '../sim/terrain';
import { FOG_CELL, FOG_GRID, computeVisibleCells } from '../sim/fog';

/** RGBA bytes for one fog cell. */
export type FogCellColor = [number, number, number, number];

/** Unexplored: near-black shroud, mostly opaque. */
export const FOG_UNEXPLORED: FogCellColor = [2, 2, 8, 235];
/** Currently visible: fully transparent. */
export const FOG_VISIBLE: FogCellColor = [0, 0, 0, 0];

/**
 * Pure color lookup — the single source of truth for shroud styling.
 *
 * 2026-10-05: once the player's units or buildings have seen ground, it
 * stays fully clear — darkness never re-appears over explored terrain.
 * Only never-seen ground is shrouded. (Enemy units/buildings are still
 * hidden unless currently visible — that filter keys on the live
 * visibility sets, not the explored grid.)
 */
export function fogCellColor(explored: boolean, visible: boolean): FogCellColor {
  if (visible || explored) return FOG_VISIBLE;
  return FOG_UNEXPLORED;
}

/**
 * Paint the 64x64 RGBA shroud texture (row-major, row 0 = z = -256).
 * `visible` is the Uint8Array from `computeVisibleCells`. Pure.
 */
export function paintFogTexture(
  world: World,
  owner: number,
  visible: Uint8Array,
  out: Uint8Array,
): void {
  const explored = world.fog?.explored[owner];
  const n = FOG_GRID * FOG_GRID;
  for (let i = 0; i < n; i++) {
    const isVis = (visible[i] ?? 0) === 1;
    const isExp = !isVis && (explored?.[i] ?? 0) === 1;
    const [r, g, b, a] = fogCellColor(isExp, isVis);
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
}

/** Height-conforming shroud plane: 64x64 quads over the 512-unit map. */
export class FogShroud {
  private readonly mesh: THREE.Mesh;
  private readonly texture: THREE.DataTexture;
  private readonly paint: Uint8Array;
  private visibleFlag = true;
  private disposed = false;

  constructor(scene: THREE.Scene, terrain: TerrainData) {
    const size = terrain.size;
    const vertsPerSide = FOG_GRID + 1;
    const positions = new Float32Array(vertsPerSide * vertsPerSide * 3);
    const uvs = new Float32Array(vertsPerSide * vertsPerSide * 2);
    const tVerts = terrain.vertsPerSide;
    const tSpacing = terrain.spacing;
    let v = 0;
    for (let iz = 0; iz < vertsPerSide; iz++) {
      for (let ix = 0; ix < vertsPerSide; ix++) {
        const x = -size / 2 + ix * FOG_CELL;
        const z = -size / 2 + iz * FOG_CELL;
        // Nearest heightfield vertex; the shroud floats just above the
        // higher of terrain and water so oceans shroud correctly too.
        const vx = Math.min(tVerts - 1, Math.max(0, Math.round((x + size / 2) / tSpacing)));
        const vz = Math.min(tVerts - 1, Math.max(0, Math.round((z + size / 2) / tSpacing)));
        const raw = terrain.heights[vz * tVerts + vx] ?? 0;
        const h = rawToWorldHeight(raw);
        const y = Math.max(h, terrain.waterLevel) + 0.6;
        positions[v * 3] = x;
        positions[v * 3 + 1] = y;
        positions[v * 3 + 2] = z;
        uvs[v * 2] = ix / FOG_GRID;
        uvs[v * 2 + 1] = iz / FOG_GRID;
        v++;
      }
    }
    const indices: number[] = [];
    for (let iz = 0; iz < FOG_GRID; iz++) {
      for (let ix = 0; ix < FOG_GRID; ix++) {
        const a = iz * vertsPerSide + ix;
        const b = a + 1;
        const c = a + vertsPerSide;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    this.paint = new Uint8Array(FOG_GRID * FOG_GRID * 4);
    this.texture = new THREE.DataTexture(this.paint, FOG_GRID, FOG_GRID, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;

    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
    });
    // The shroud is cartography, not scenery: scene fog and day/night
    // exposure must not lift the black.
    mat.fog = false;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'fogShroud';
    this.mesh.renderOrder = 4; // after terrain, before entities/billboards
    this.mesh.frustumCulled = false; // spans the whole map
    scene.add(this.mesh);
  }

  /** Repaint from sim state. Called at fog cadence, never per frame. */
  update(world: World, owner: number, cells?: Uint8Array): void {
    if (this.disposed) return;
    const visible = cells ?? computeVisibleCells(world, owner);
    paintFogTexture(world, owner, visible, this.paint);
    this.texture.needsUpdate = true;
  }

  setVisible(v: boolean): void {
    this.visibleFlag = v;
    if (!this.disposed) this.mesh.visible = v;
  }

  get visible(): boolean {
    return this.visibleFlag;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.parent?.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.texture.dispose();
  }
}
