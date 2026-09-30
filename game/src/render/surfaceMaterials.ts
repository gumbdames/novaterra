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
 * Shared surface materials (0.1 Alpha).
 *
 * One `THREE.MeshStandardMaterial` per surface category, built on the
 * procedural textures from `surfaceTextures.ts`, exported as the
 * `SURFACE_MATERIALS` record. The record is created ONCE at import time and
 * the instances are shared across every entity mesh in the game — there are
 * no per-instance material clones in the hot path (perf: shared materials
 * let three.js batch state changes and keep program/shader count at 16).
 *
 * ## Team-color contract (read before tinting)
 *
 * `material.color` MULTIPLIES the diffuse map. The surfaces are therefore
 * split into two groups:
 *
 * - **Tint-friendly** (`tintable: true` in `SURFACE_SPECS`): the diffuse map
 *   is luminance-biased — near-white with detail, no strong hue
 *   (`paintedMetal`, `hullGray`, `canvasFabric`, `concrete`, `roofGravel`).
 *   Setting `material.color` to a team color reads cleanly.
 * - **Authored-color** (`tintable: false`): the map carries the intended hue
 *   (camos, `glassBlue`, `brickRed`, `hazardStripes`, `rustMetal`,
 *   `woodPlank`, `tireRubber`, `gunmetal`, `sandbag`). Use these with
 *   `color = white`; tinting them tints the authored hue.
 *
 * Rules for the integration worker (`entities.ts`):
 * 1. NEVER mutate `SURFACE_MATERIALS[cat].color` (or any other property) —
 *    the instance is shared by every mesh using that surface.
 * 2. To apply a team tint, CLONE the shared material once per team
 *    (`SURFACE_MATERIALS.paintedMetal.clone()`, then set `.color`), and
 *    cache the clone per team — do not clone per entity.
 * 3. The game's current team identity (stripe/pennant meshes in
 *    `entities.ts`) works unchanged alongside these materials.
 */
import * as THREE from 'three';

import {
  SURFACE_CATEGORIES,
  surfaceRoughnessTexture,
  surfaceTexture,
  type SurfaceCategory,
} from './surfaceTextures';

export interface SurfaceMaterialSpec {
  /** Scalar multiplier; per-pixel detail comes from the roughness map. */
  metalness: number;
  roughness: number;
  /** True when the diffuse map is luminance-biased and safe to tint. */
  tintable: boolean;
  /** Extra specular pop for glass/metal (default 1.0). */
  envMapIntensity: number;
}

/** Tuned per surface: metals reflective, rubber/fabric/concrete matte. */
export const SURFACE_SPECS: Record<SurfaceCategory, SurfaceMaterialSpec> = {
  paintedMetal: { metalness: 0.55, roughness: 1.0, tintable: true, envMapIntensity: 1.0 },
  camoGreen: { metalness: 0.25, roughness: 1.0, tintable: false, envMapIntensity: 0.8 },
  camoDesert: { metalness: 0.25, roughness: 1.0, tintable: false, envMapIntensity: 0.8 },
  camoNavy: { metalness: 0.3, roughness: 1.0, tintable: false, envMapIntensity: 0.9 },
  gunmetal: { metalness: 0.85, roughness: 1.0, tintable: false, envMapIntensity: 1.2 },
  tireRubber: { metalness: 0.0, roughness: 1.0, tintable: false, envMapIntensity: 0.4 },
  concrete: { metalness: 0.0, roughness: 1.0, tintable: true, envMapIntensity: 0.5 },
  glassBlue: { metalness: 0.15, roughness: 1.0, tintable: false, envMapIntensity: 1.6 },
  brickRed: { metalness: 0.0, roughness: 1.0, tintable: false, envMapIntensity: 0.5 },
  woodPlank: { metalness: 0.0, roughness: 1.0, tintable: false, envMapIntensity: 0.5 },
  canvasFabric: { metalness: 0.0, roughness: 1.0, tintable: true, envMapIntensity: 0.4 },
  hullGray: { metalness: 0.6, roughness: 1.0, tintable: true, envMapIntensity: 1.1 },
  rustMetal: { metalness: 0.35, roughness: 1.0, tintable: false, envMapIntensity: 0.7 },
  hazardStripes: { metalness: 0.2, roughness: 1.0, tintable: false, envMapIntensity: 0.8 },
  roofGravel: { metalness: 0.0, roughness: 1.0, tintable: true, envMapIntensity: 0.4 },
  sandbag: { metalness: 0.0, roughness: 1.0, tintable: false, envMapIntensity: 0.4 },
};

function buildSurfaceMaterials(): Record<SurfaceCategory, THREE.MeshStandardMaterial> {
  const out = {} as Record<SurfaceCategory, THREE.MeshStandardMaterial>;
  for (const category of SURFACE_CATEGORIES) {
    const spec = SURFACE_SPECS[category];
    out[category] = new THREE.MeshStandardMaterial({
      map: surfaceTexture(category),
      roughnessMap: surfaceRoughnessTexture(category),
      color: 0xffffff,
      metalness: spec.metalness,
      roughness: spec.roughness,
      envMapIntensity: spec.envMapIntensity,
    });
  }
  return out;
}

/**
 * The shared material library: one instance per surface, reused by every
 * mesh. See the team-color contract in the module header before tinting.
 */
export const SURFACE_MATERIALS: Record<SurfaceCategory, THREE.MeshStandardMaterial> =
  buildSurfaceMaterials();
