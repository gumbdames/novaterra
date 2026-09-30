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
 * NOVATERRA — render/desirabilityOverlay.ts — residential desirability
 * overlay (workstream W, grand expansion, 0.1 Alpha).
 *
 * The TOGGLEABLE overlay — off by default, flipped from the top bar
 * ("Land value"). It shows every residential-zone cell as a ground tint
 * colored by its 0–100 desirability: red (low) → amber (modest) →
 * green (prime). One merged decal mesh (1 draw call, 0 when empty),
 * rebuilt only when the sim model's cache key changes (structural
 * change — never per frame).
 *
 * Data flows in as `DesirabilityOverlayData` (ui/desirability.ts — a pure
 * view of the sim's derived model; the overlay never touches sim state).
 * Decals drape on the terrain per corner (the zoneOverlay.ts precedent).
 *
 * Import-safe under Node/vitest; fully unit-tested in
 * tests/render.desirability.test.ts.
 */

import * as THREE from 'three';

import { cellCoords, cellCenterWorld, CELL_WORLD_SIZE } from '../sim/city';
import { ZONE_DECAL_TERRAIN_OFFSET } from './zoneOverlay';
import type { DesirabilityOverlayData } from '../ui/desirability';

/** Overlay tint opacity (subtle wash, like the zone decals). */
export const DESIRABILITY_OVERLAY_OPACITY = 0.28;

/**
 * Desirability → tint color: red (0) → amber (50) → green (100).
 * Pure: same value ⇒ byte-identical color, pinned by test.
 */
export function desirabilityColor(value: number, out = new THREE.Color()): THREE.Color {
  const v = Math.max(0, Math.min(100, value)) / 100;
  // Two-stop gradient: red → amber → green.
  const r = v < 0.5 ? 0xd4 + (0xd8 - 0xd4) * (v / 0.5) : 0xd8 + (0x3f - 0xd8) * ((v - 0.5) / 0.5);
  const g = v < 0.5 ? 0x3d + (0xa9 - 0x3d) * (v / 0.5) : 0xa9 + (0xae - 0xa9) * ((v - 0.5) / 0.5);
  const b = v < 0.5 ? 0x2a + (0x3c - 0x2a) * (v / 0.5) : 0x3c + (0x5a - 0x3c) * ((v - 0.5) / 0.5);
  out.setRGB(r / 255, g / 255, b / 255);
  return out;
}

/** Minimal quad-list mesh builder (positions + up normals + colors). */
class DecalQuadList {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  /**
   * Axis-aligned decal quad for one cell, centered at world (x, z).
   * Corners drape on the height callback (+ offset) — adjacent cells
   * share exact corner coordinates, so the wash never cracks.
   */
  quad(x: number, z: number, color: THREE.Color, heightAt?: (x: number, z: number) => number): void {
    const base = this.positions.length / 3;
    const half = CELL_WORLD_SIZE / 2;
    const x0 = x - half;
    const x1 = x + half;
    const z0 = z - half;
    const z1 = z + half;
    const y00 = heightAt !== undefined ? heightAt(x0, z0) + ZONE_DECAL_TERRAIN_OFFSET : 0.05;
    const y10 = heightAt !== undefined ? heightAt(x1, z0) + ZONE_DECAL_TERRAIN_OFFSET : 0.05;
    const y01 = heightAt !== undefined ? heightAt(x0, z1) + ZONE_DECAL_TERRAIN_OFFSET : 0.05;
    const y11 = heightAt !== undefined ? heightAt(x1, z1) + ZONE_DECAL_TERRAIN_OFFSET : 0.05;
    this.positions.push(x0, y00, z0, x1, y10, z0, x0, y01, z1, x1, y11, z1);
    for (let i = 0; i < 4; i++) {
      this.normals.push(0, 1, 0);
      this.colors.push(color.r, color.g, color.b);
    }
    // Winding (a,c,b),(b,c,d): counter-clockwise seen from +y, same as
    // the terrain mesher, road ribbons, and zone decals.
    this.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.normals), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.colors), 3));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * One merged decal quad per residential-zone cell, colored by
 * desirability. Pure: same cells (in any caller order — emission is
 * sorted by cell) ⇒ byte-identical geometry.
 */
export function buildDesirabilityDecalGeometry(
  data: DesirabilityOverlayData,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const quads = new DecalQuadList();
  const scratch = new THREE.Color();
  const ordered = [...data.cells].sort((a, b) => a.cell - b.cell);
  for (const c of ordered) {
    const { cx, cz } = cellCoords(c.cell);
    desirabilityColor(c.value, scratch);
    quads.quad(cellCenterWorld(cx), cellCenterWorld(cz), scratch, heightAt);
  }
  return quads.build();
}

/** FNV-1a digest of overlay data (the zoneOverlay.ts zoneDigest precedent). */
export function desirabilityOverlayDigest(data: DesirabilityOverlayData): number {
  let digest = 2166136261;
  for (const c of data.cells) {
    digest ^= c.cell;
    digest = Math.imul(digest, 16777619);
    digest ^= c.value;
    digest = Math.imul(digest, 16777619);
  }
  return digest;
}

export interface DesirabilityOverlaySyncOpts {
  heightAt?: (x: number, z: number) => number;
}

/**
 * The desirability overlay. Owned by `EntityRenderer` (created in its
 * constructor, synced in `sync()`, disposed in `dispose()`); hidden by
 * default, flipped from the top bar. A missing/empty data set counts as
 * "nothing to tint".
 */
export class DesirabilityOverlay {
  private readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private visible = false;
  private lastKey: string | null = null;
  /** Rebuild counter (test/debug hook — the node-stability proof). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'desirability';
    this.group.visible = false;
    scene.add(this.group);
  }

  /**
   * Rebuild the decal mesh only when the model's cache key changed since
   * the last sync (structural change). The common path is a single
   * string compare.
   */
  sync(data: DesirabilityOverlayData, opts: DesirabilityOverlaySyncOpts = {}): void {
    if (!this.visible) return;
    if (data.key === this.lastKey) return;
    this.lastKey = data.key;
    this.rebuilds += 1;
    if (this.mesh !== null) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    if (data.cells.length === 0) return;
    const geo = buildDesirabilityDecalGeometry(data, opts.heightAt);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: DESIRABILITY_OVERLAY_OPACITY,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    // Decals hug the terrain: never let three.js cull the merged mesh
    // on stale bounds, and draw after the opaque terrain.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.group.add(this.mesh);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.group.visible = visible;
    // Forcing a rebuild on re-show keeps the tint honest even if the
    // model changed while hidden (the key compare would skip it, since
    // lastKey is only written on sync — this reset is belt and braces
    // for data swapped wholesale, e.g. after a load).
    if (visible) this.lastKey = null;
  }

  /** Visible decal meshes = draw calls this frame (0 or 1). */
  drawCallCount(): number {
    return this.mesh !== null ? 1 : 0;
  }

  /** Test/debug hook: how many times the mesh was rebuilt. */
  rebuildCount(): number {
    return this.rebuilds;
  }

  dispose(): void {
    if (this.mesh !== null) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
  }
}
