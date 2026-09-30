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
 * NOVATERRA — render/chevrons.ts — veterancy chevron overlay (Phase 1).
 *
 * Responsibilities:
 *  - Floating chevron strips above veteran units (vetLevel 1..3): the
 *    classic at-a-glance readability cue — 1/2/3 gold chevrons for
 *    Regular / Veteran / Elite.
 *  - Exactly three `THREE.InstancedMesh` (one per level), so the overlay
 *    costs at most 3 draw calls no matter how many veterans are on the
 *    field (meshes with zero instances are hidden: 0 draw calls when no
 *    veteran is alive). It reads `world.units` directly, so it works
 *    identically whether unit bodies render through the Phase 0 instanced
 *    path or the legacy per-view path — zero shader work, and no
 *    regression of the draw-call budget.
 *
 * Layout math (`chevronTexturePixels`, `chevronUnits`, `chevronAnchor`)
 * is pure and headless-testable; the `ChevronOverlay` class is the thin
 * three.js shell (billboarded instance matrices from the camera
 * quaternion, refreshed per sync).
 *
 * Import-safe under Node/vitest: `three` core has no DOM at import time,
 * and the textures are `THREE.DataTexture`s rasterized from pure pixel
 * functions (no canvas) — deterministic: same level ⇒ byte-identical
 * pixels on every machine.
 */

import * as THREE from 'three';
import type { UnitRecord } from '../sim/units';
import type { TerrainData } from '../sim/terrain';
import { groundYAt, unitHoverY, type HeightDomain } from './terrainHeight';

/** Veterancy levels that earn chevrons (0 = Recruit, no strip). */
export const CHEVRON_LEVELS = [1, 2, 3] as const;

/** Texture pixels per chevron cell (square cells, stacked vertically). */
export const CHEVRON_TEX_PX = 64;
/** World-unit width of a chevron strip. */
export const CHEVRON_STRIP_W = 1.5;
/** World-unit height of one chevron cell. */
export const CHEVRON_CELL_H = 0.85;
/**
 * Strip bottom above the model top. The legacy health-bar band sits at
 * modelTop + 1.1 (±0.25); 1.6 clears it so a damaged veteran never shows
 * the bar crossing its chevrons.
 */
export const CHEVRON_BASE_OFFSET = 1.6;
/** Initial instance capacity per level mesh (grows by doubling). */
export const CHEVRON_INITIAL_CAPACITY = 64;

/** Chevron gold (sRGB). */
const CHEVRON_R = 255;
const CHEVRON_G = 210;
const CHEVRON_B = 63;

/**
 * Rasterize a chevron strip texture: `level` upward chevrons stacked
 * vertically, gold with a soft glow. Pure and deterministic — same level
 * always yields byte-identical pixels.
 *
 * Each cell is 64×64 px; the chevron is two thick segments forming a
 * "∧" (apex (32,12), feet (8,52) and (56,52)), filled within a
 * half-width of 8 px, with a 6 px quadratic-falloff glow outside it.
 */
export function chevronTexturePixels(level: 1 | 2 | 3): Uint8ClampedArray {
  const w = CHEVRON_TEX_PX;
  const h = CHEVRON_TEX_PX * level;
  const px = new Uint8ClampedArray(w * h * 4);
  const halfWidth = 8;
  const glow = 6;
  // Chevron segments within one cell, y-down pixel space.
  const ax = 8;
  const ay = 52;
  const bx = 32;
  const by = 12;
  const cx = 56;
  const cy = 52;
  for (let cell = 0; cell < level; cell++) {
    const yOff = cell * CHEVRON_TEX_PX;
    for (let y = 0; y < CHEVRON_TEX_PX; y++) {
      for (let x = 0; x < w; x++) {
        const pxX = x + 0.5;
        const pxY = yOff + y + 0.5;
        const d = Math.min(
          distToSegment(pxX, pxY, ax, yOff + ay, bx, yOff + by),
          distToSegment(pxX, pxY, bx, yOff + by, cx, yOff + cy),
        );
        const i = (yOff + y) * w * 4 + x * 4;
        if (d <= halfWidth) {
          px[i] = CHEVRON_R;
          px[i + 1] = CHEVRON_G;
          px[i + 2] = CHEVRON_B;
          px[i + 3] = 255;
        } else if (d <= halfWidth + glow) {
          const t = 1 - (d - halfWidth) / glow;
          px[i] = CHEVRON_R;
          px[i + 1] = CHEVRON_G;
          px[i + 2] = CHEVRON_B;
          px[i + 3] = Math.round(255 * t * t);
        }
        // Elsewhere: alpha 0 (transparent).
      }
    }
  }
  return px;
}

/** Distance from a point to a line segment (pure helper). */
function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

/** World-unit height of a level's strip (cells stacked). */
export function chevronStripHeight(level: number): number {
  return CHEVRON_CELL_H * Math.max(1, Math.min(3, level));
}

/**
 * Units that earn a chevron strip: living units at vetLevel 1..3.
 * (Dead units are gone from the world anyway; hp<=0 is belt-and-braces
 * for mid-sync records. Levels outside 1..3 are clamped by the caller.)
 */
export function chevronUnits(units: readonly UnitRecord[]): UnitRecord[] {
  const out: UnitRecord[] = [];
  for (const u of units) {
    const level = u.vetLevel ?? 0;
    if (level >= 1 && level <= 3 && u.hp > 0) out.push(u);
  }
  return out;
}

/**
 * World-space anchor (strip CENTER) for a unit's chevrons: terrain
 * ground under the unit (water level for sea) + hover lift + model top
 * + base offset + half the strip height (bottom-anchored so every
 * level's strip starts at the same height above the model).
 */
export function chevronAnchor(
  u: UnitRecord,
  terrain: TerrainData | null,
  waterLevel: number,
  modelTop: number,
): { x: number; y: number; z: number } {
  const domain = u.domain as HeightDomain;
  const ground = groundYAt(terrain, waterLevel, domain, u.x, u.z);
  const level = Math.max(1, Math.min(3, u.vetLevel ?? 0));
  return {
    x: u.x,
    y:
      ground +
      unitHoverY(domain, u.kind) +
      modelTop +
      CHEVRON_BASE_OFFSET +
      chevronStripHeight(level) / 2,
    z: u.z,
  };
}

// Scratch objects for the per-sync matrix writes (no per-frame alloc).
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);

/**
 * The three-instanced-mesh chevron overlay. Owned by `EntityRenderer`
 * (created in its constructor, synced in `sync()`, disposed in
 * `dispose()`); reads `world.units` directly so it is independent of the
 * unit-body render path.
 */
export class ChevronOverlay {
  private readonly group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];

  constructor(scene: THREE.Scene) {
    this.group.name = 'chevrons';
    for (const level of CHEVRON_LEVELS) {
      const tex = new THREE.DataTexture(
        chevronTexturePixels(level),
        CHEVRON_TEX_PX,
        CHEVRON_TEX_PX * level,
      );
      tex.needsUpdate = true;
      tex.colorSpace = THREE.SRGBColorSpace;
      const geo = new THREE.PlaneGeometry(CHEVRON_STRIP_W, chevronStripHeight(level));
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      });
      const mesh = new THREE.InstancedMesh(geo, mat, CHEVRON_INITIAL_CAPACITY);
      // Instances spread across the map: never let three.js cull the
      // whole mesh on the plane's local bounds.
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 10;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    scene.add(this.group);
  }

  /**
   * Rebuild the per-level instance lists from the live units. Billboard
   * rotation comes from the camera quaternion (identity when no camera —
   * headless); each instance is translation-only otherwise.
   */
  sync(
    units: readonly UnitRecord[],
    terrain: TerrainData | null,
    waterLevel: number,
    modelTopFor: (kind: string) => number,
    camera: THREE.Camera | null,
  ): void {
    const byLevel: UnitRecord[][] = [[], [], []];
    for (const u of chevronUnits(units)) {
      const level = Math.max(1, Math.min(3, u.vetLevel ?? 0));
      byLevel[level - 1]!.push(u);
    }
    const billboard = camera !== null ? camera.quaternion : _q.identity();
    for (let i = 0; i < this.meshes.length; i++) {
      let mesh = this.meshes[i]!;
      const list = byLevel[i]!;
      if (list.length > mesh.instanceMatrix.count) {
        mesh = this.grow(mesh, i, list.length);
      }
      for (let j = 0; j < list.length; j++) {
        const u = list[j]!;
        const a = chevronAnchor(u, terrain, waterLevel, modelTopFor(u.kind));
        _m.compose(_p.set(a.x, a.y, a.z), billboard, _s);
        mesh.setMatrixAt(j, _m);
      }
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      // Zero instances ⇒ hidden ⇒ zero draw calls for this level.
      mesh.visible = list.length > 0;
    }
  }

  /** Visible (non-empty) level meshes = draw calls this frame (0..3). */
  drawCallCount(): number {
    let n = 0;
    for (const m of this.meshes) if (m.visible) n++;
    return n;
  }

  /** Instance counts per level (level 1..3 order). Test/debug hook. */
  levelCounts(): [number, number, number] {
    return [this.meshes[0]!.count, this.meshes[1]!.count, this.meshes[2]!.count];
  }

  /** Read back one instance matrix (test hook). */
  debugMatrix(level: 1 | 2 | 3, index: number): THREE.Matrix4 {
    const out = new THREE.Matrix4();
    this.meshes[level - 1]!.getMatrixAt(index, out);
    return out;
  }

  /** Replace a level mesh with a larger-capacity one (same geo/mat). */
  private grow(mesh: THREE.InstancedMesh, levelIdx: number, needed: number): THREE.InstancedMesh {
    let capacity = mesh.instanceMatrix.count;
    while (capacity < needed) capacity *= 2;
    const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity);
    grown.frustumCulled = false;
    grown.visible = mesh.visible;
    grown.renderOrder = mesh.renderOrder;
    grown.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.remove(mesh);
    this.group.add(grown);
    this.meshes[levelIdx] = grown;
    return grown;
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material;
      const tex = (mat as THREE.MeshBasicMaterial).map;
      if (tex) tex.dispose();
      mat.dispose();
      mesh.dispose();
    }
    this.meshes = [];
    this.group.parent?.remove(this.group);
  }
}
