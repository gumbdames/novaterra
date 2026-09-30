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
 * NOVATERRA — render/zoneOverlay.ts — zone-tint ground decals (Workstream Z).
 *
 * Purpose: zoning was invisible on the map (`src/render/` never read
 * `city.zones`). This overlay paints one translucent ground decal per
 * zoned cell in the classic readable colors — green residential, blue
 * commercial, orange industrial — so painted zones read at a glance.
 *
 * Design:
 * - One merged geometry with per-vertex colors → a single draw call no
 *   matter how many cells are zoned (empty ⇒ the mesh is hidden ⇒ 0).
 * - Decals drape over the terrain per-vertex (the roads.ts pattern:
 *   adjacent cells sample their shared corners at identical coordinates
 *   so the wash never cracks); flat at `ZONE_Y` without terrain
 *   (the headless-test path).
 * - Node-stable rebuilds: `zoneDigest` (FNV-1a over cell+zone pairs)
 *   skips the rebuild when nothing changed — the paletteDigest.ts
 *   discipline (rebuilding every tick broke real clicks; the same
 *   discipline applies to geometry rebuilds).
 *
 * Render-side only, no sim logic. Deterministic: same zone assignments
 * ⇒ byte-identical geometry on every machine.
 *
 * Import-safe under Node/vitest (`three` core has no DOM at import;
 * `sim/city` is headless-safe).
 */

import * as THREE from 'three';
import {
  CELL_WORLD_SIZE,
  cellCoords,
  cellCenterWorld,
  ZoneType,
} from '../sim/city';

/** Zone → decal tint (classic city-painter colors). */
export const ZONE_DECAL_COLORS: Record<ZoneType, number> = {
  [ZoneType.RESIDENTIAL]: 0x43a047, // green
  [ZoneType.COMMERCIAL]: 0x1e88e5, // blue
  [ZoneType.INDUSTRIAL]: 0xfb8c00, // orange
  // Grand-expansion Phase 5 (S8, 2026-09-30): airport zones — violet,
  // distinct from the three classic tints at a glance.
  [ZoneType.AIRPORT]: 0x9c27b0, // violet
};

/** Decal transparency: a translucent wash — the terrain reads through. */
export const ZONE_DECAL_OPACITY = 0.28;
/**
 * Decal offset above the terrain surface (the draped path). Sits below
 * the road ribbon (+0.08) so roads stay readable on top of zones.
 */
export const ZONE_DECAL_TERRAIN_OFFSET = 0.05;
/** Flat decal height when the renderer has no terrain (headless). */
export const ZONE_Y = 0.05;

/** The zone-assignment shape the overlay reads (`city.zones` records). */
export interface ZoneAssignment {
  cell: number;
  zone: ZoneType;
}

/**
 * Cheap digest over zone assignments: FNV-1a over (cell, zone) pairs in
 * array order. Changes when a cell is painted, repainted to a different
 * zone, or removed; stable when nothing changed. `city.zones` is kept
 * sorted by cell, so identical assignments always hash identical.
 */
/** Shared empty assignment list (avoids allocating on every headless sync). */
const EMPTY_ZONES: ReadonlyArray<ZoneAssignment> = [];

/**
 * Pure zone digest (FNV-1a over cell+zone pairs). Order-independent: the
 * sim keeps `city.zones` sorted by cell, but the digest sorts defensively
 * so any caller order gives the same value. The overlay rebuilds only
 * when this changes.
 */
export function zoneDigest(zones: ReadonlyArray<ZoneAssignment>): number {
  const sorted = [...zones].sort((a, b) => a.cell - b.cell);
  let digest = 2166136261;
  for (const z of sorted) {
    digest ^= z.cell as number;
    digest = Math.imul(digest, 16777619);
    digest ^= z.zone as number;
    digest = Math.imul(digest, 16777619);
  }
  return digest;
}

/** Minimal quad-list mesh builder: positions + up-ish normals + colors + indices. */
class DecalQuadList {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  /**
   * Axis-aligned decal quad for one zone cell, centered at (cx, cz).
   * Corners drape on the height callback (+ offset) — adjacent cells
   * share exact corner coordinates, so the wash never cracks. Without
   * the callback the quad stays flat at `ZONE_Y`.
   */
  quad(cx: number, cz: number, color: THREE.Color, heightAt?: (x: number, z: number) => number): void {
    const base = this.positions.length / 3;
    const half = CELL_WORLD_SIZE / 2;
    const x0 = cx - half;
    const x1 = cx + half;
    const z0 = cz - half;
    const z1 = cz + half;
    const y00 = heightAt !== undefined ? heightAt(x0, z0) + ZONE_DECAL_TERRAIN_OFFSET : ZONE_Y;
    const y10 = heightAt !== undefined ? heightAt(x1, z0) + ZONE_DECAL_TERRAIN_OFFSET : ZONE_Y;
    const y01 = heightAt !== undefined ? heightAt(x0, z1) + ZONE_DECAL_TERRAIN_OFFSET : ZONE_Y;
    const y11 = heightAt !== undefined ? heightAt(x1, z1) + ZONE_DECAL_TERRAIN_OFFSET : ZONE_Y;
    this.positions.push(x0, y00, z0, x1, y10, z0, x0, y01, z1, x1, y11, z1);
    // Flat up normals — the decals are a translucent wash, so slope
    // lighting would only add noise; constant normals keep the tint even.
    for (let i = 0; i < 4; i++) {
      this.normals.push(0, 1, 0);
      this.colors.push(color.r, color.g, color.b);
    }
    // Winding (a,c,b),(b,c,d): counter-clockwise seen from +y, same as
    // the terrain mesher and the road ribbons.
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
 * One merged decal quad per zoned cell, colored per zone type. Pure:
 * same assignments (in any caller order — emission is sorted by cell)
 * ⇒ byte-identical geometry.
 */
export function buildZoneDecalGeometry(
  zones: ReadonlyArray<ZoneAssignment>,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry {
  const quads = new DecalQuadList();
  const scratch = new THREE.Color();
  const ordered = [...zones].sort((a, b) => a.cell - b.cell);
  for (const z of ordered) {
    const { cx, cz } = cellCoords(z.cell);
    scratch.setHex(ZONE_DECAL_COLORS[z.zone] as number);
    quads.quad(cellCenterWorld(cx), cellCenterWorld(cz), scratch, heightAt);
  }
  return quads.build();
}

/**
 * The zone-decal overlay. Owned by `EntityRenderer` (created in its
 * constructor, synced in `sync()`, disposed in `dispose()`); reads
 * `world.city.zones` directly, independent of the entity-body render
 * path. Visible by default — zoning should read at a glance. A missing
 * zones list (minimal/headless worlds) is treated as "nothing painted".
 */
export class ZoneOverlay {
  private readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lastDigest = -1;
  /** Rebuild counter (test/debug hook — the node-stability proof). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'zones';
    scene.add(this.group);
  }

  /**
   * Rebuild the decal mesh when the zone digest changed; skip otherwise
   * (node-stable: painted zones are static almost every frame, so the
   * common path is a single integer compare).
   */
  /**
   * Rebuild the decal mesh only when the zone digest changed since the
   * last sync. A missing zones list (minimal/headless worlds) counts
   * as "no zones painted".
   */
  sync(zones: ReadonlyArray<ZoneAssignment> | undefined, heightAt?: (x: number, z: number) => number): void {
    const list = zones ?? EMPTY_ZONES;
    const digest = zoneDigest(list);
    if (digest === this.lastDigest) return;
    this.lastDigest = digest;
    this.rebuilds += 1;
    if (this.mesh !== null) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    if (list.length === 0) return;
    const geo = buildZoneDecalGeometry(list, heightAt);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: ZONE_DECAL_OPACITY,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    // Decals hug the terrain: never let three.js cull the merged mesh
    // on stale bounds, and draw after the opaque terrain.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.group.add(this.mesh);
  }

  /** Visible decal meshes = draw calls this frame (0 or 1). */
  drawCallCount(): number {
    return this.mesh !== null ? 1 : 0;
  }

  /** Rebuilds since construction (test hook). */
  debugRebuildCount(): number {
    return this.rebuilds;
  }

  /** Last digest synced (test hook). */
  debugDigest(): number {
    return this.lastDigest;
  }

  dispose(): void {
    if (this.mesh !== null) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    this.group.parent?.remove(this.group);
  }
}
