/**
 * buildingVariants.ts — Phase 4 (transport) building visual variety.
 *
 * The sim assigns every placed building a visual `variant` (0..3) and a
 * `sizeTier` (1..3) at placement time, from a pure hash of the building
 * id — no RNG draws, digest-covered (`sim/city.ts`
 * `buildingVariantSeed`). This module is the render-side mapping:
 *
 *   - `variantModelKey(kind, variant)` → `${kind}_v${variant}` for
 *     variants 1..3 (variant 0 is the base model, keyed by `kind`
 *     itself — the sim's comment at city.ts:1799 names this shape).
 *     Variant keys NEVER enter the boot model set: they resolve
 *     through the lazy model pipeline (`render/lazyModels.ts`) like
 *     every other non-boot key, so the ~8 MiB startup gate is untouched
 *     (pinned by test).
 *   - `sizeTierScale(tier)` → 0.88 / 1.0 / 1.14: the whole building is
 *     uniformly scaled, so a size-3 house reads bigger than a size-1
 *     one without any new geometry.
 *   - `variantExtraFor(variant)` → a tiny cached procedural rooftop prop
 *     (1 = chimney, 2 = roof water tank, 3 = solar array), generic
 *     across kinds. `entities.ts` appends it as an extra piece at the
 *     base model's top (`pool: 'variantExtra:v<N>'`), so variant 1..3
 *     get distinct silhouettes even where no `_v<N>` GLB exists yet.
 *
 * No gameplay logic here — purely how buildings look. Deterministic:
 * the same (kind, variant, sizeTier) always resolves identically.
 *
 * Import-safe under Node/vitest: `three` core + BufferGeometryUtils
 * only, no DOM at import time.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { LoadedModel } from './models';

/** How many visual variants a building kind can have (sim: 0..3). */
export const BUILDING_VARIANT_COUNT = 4;

/** The default variant: the base model, no extras. */
export const BUILDING_VARIANT_BASE = 0;

/**
 * The lazy-model key for a building variant. Variant 0 resolves to the
 * kind itself (the boot-set key); variants 1..3 get suffixed keys that
 * travel the lazy pipeline — never the boot set.
 */
export function variantModelKey(kind: string, variant: number): string {
  if (!Number.isInteger(variant) || variant <= BUILDING_VARIANT_BASE) return kind;
  return `${kind}_v${variant}`;
}

/** True for the suffixed variant keys (the ones the lazy pipeline serves). */
export function isVariantModelKey(key: string): boolean {
  return /_v[1-9]\d*$/.test(key);
}

/**
 * Uniform scale for a size tier: tier 1 reads small, tier 2 is the
 * authored size, tier 3 reads large. Out-of-range input falls back to
 * tier 2 (never NaN, never 0 — a broken scale would collapse the mesh).
 */
export function sizeTierScale(tier: number): number {
  switch (tier) {
    case 1:
      return 0.88;
    case 3:
      return 1.14;
    case 2:
    default:
      return 1.0;
  }
}

// ---------------------------------------------------------------------------
// Variant extras: one small procedural rooftop prop per variant (1..3),
// shared across all kinds. Cached — one copy per variant for the session.
// ---------------------------------------------------------------------------

interface PropPart {
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  color: number;
  /** Cylinder instead of a box (radius = w/2, height = h). */
  cylinder?: boolean;
}

function propPartGeometry(part: PropPart): THREE.BufferGeometry {
  const geo = part.cylinder
    ? new THREE.CylinderGeometry(part.w / 2, part.w / 2, part.h, 10)
    : new THREE.BoxGeometry(part.w, part.h, part.d);
  geo.translate(part.x, part.y, part.z);
  return geo;
}

function buildPropModel(parts: PropPart[]): LoadedModel {
  const byColor = new Map<number, THREE.BufferGeometry[]>();
  for (const part of parts) {
    const list = byColor.get(part.color) ?? [];
    list.push(propPartGeometry(part));
    byColor.set(part.color, list);
  }
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const [color, geos] of byColor) {
    geometries.push(mergeGeometries(geos, false)!);
    materials.push(
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.75,
        metalness: 0.15,
        flatShading: true,
      }),
    );
  }
  return { geometries, materials };
}

/** Variant 1: a brick chimney with a dark cap. Base at y=0 (the roof). */
function chimneyModel(): LoadedModel {
  return buildPropModel([
    { w: 1.1, h: 2.6, d: 1.1, x: 0, y: 1.3, z: 0, color: 0x9a5b42 },
    { w: 1.4, h: 0.3, d: 1.4, x: 0, y: 2.75, z: 0, color: 0x3a3a3e },
    { w: 0.7, h: 0.4, d: 0.7, x: 0, y: 3.0, z: 0, color: 0x222226 },
  ]);
}

/** Variant 2: a roof water tank on legs. Base at y=0 (the roof). */
function waterTankModel(): LoadedModel {
  const wood = 0x8a6f4d;
  const dark = 0x4a3d2c;
  return buildPropModel([
    { w: 1.8, h: 1.8, d: 1.8, x: 0, y: 2.1, z: 0, color: wood, cylinder: true },
    { w: 1.9, h: 0.25, d: 1.9, x: 0, y: 3.1, z: 0, color: dark, cylinder: true },
    { w: 0.22, h: 1.3, d: 0.22, x: 0.7, y: 0.65, z: 0.7, color: dark },
    { w: 0.22, h: 1.3, d: 0.22, x: -0.7, y: 0.65, z: 0.7, color: dark },
    { w: 0.22, h: 1.3, d: 0.22, x: 0.7, y: 0.65, z: -0.7, color: dark },
    { w: 0.22, h: 1.3, d: 0.22, x: -0.7, y: 0.65, z: -0.7, color: dark },
  ]);
}

/** Variant 3: a tilted solar array on a frame. Base at y=0 (the roof). */
function solarArrayModel(): LoadedModel {
  const panel = 0x27436b;
  const frame = 0x9aa2ab;
  return buildPropModel([
    // Frame legs.
    { w: 0.18, h: 0.9, d: 0.18, x: 1.1, y: 0.45, z: 0.8, color: frame },
    { w: 0.18, h: 0.9, d: 0.18, x: -1.1, y: 0.45, z: 0.8, color: frame },
    { w: 0.18, h: 1.5, d: 0.18, x: 1.1, y: 0.75, z: -0.8, color: frame },
    { w: 0.18, h: 1.5, d: 0.18, x: -1.1, y: 0.75, z: -0.8, color: frame },
    // The panel itself, tilted toward the sun.
    { w: 2.8, h: 0.12, d: 2.0, x: 0, y: 1.35, z: 0, color: panel },
  ]);
}

const extraCache = new Map<number, LoadedModel>();

/**
 * The cached procedural rooftop prop for a variant (1..3). Variant 0
 * (the base look) has no prop — returns undefined. The models' bases
 * sit at y=0; `entities.ts` places them at the base model's top.
 */
export function variantExtraFor(variant: number): LoadedModel | undefined {
  if (variant <= BUILDING_VARIANT_BASE || variant >= BUILDING_VARIANT_COUNT) {
    return undefined;
  }
  let model = extraCache.get(variant);
  if (model === undefined) {
    model =
      variant === 1 ? chimneyModel() : variant === 2 ? waterTankModel() : solarArrayModel();
    extraCache.set(variant, model);
  }
  return model;
}

/**
 * Height of a variant's rooftop prop (base y=0 → top). Measured once
 * per variant so the pennant anchor can sit above it. 0 for the base
 * variant (no prop).
 */
export function variantExtraTop(variant: number): number {
  const model = variantExtraFor(variant);
  if (model === undefined) return 0;
  let top = 0;
  for (const geo of model.geometries) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    if (bb !== null && bb.max.y > top) top = bb.max.y;
  }
  return top;
}

/** Pool keys this module introduces (never boot-model keys). */
export function variantExtraPoolKey(variant: number): string {
  return `variantExtra:v${variant}`;
}
