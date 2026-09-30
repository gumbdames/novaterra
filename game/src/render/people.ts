/**
 * Civilian pedestrian variants for the ambient crowd (0.1 Alpha).
 *
 * The crowd's pedestrians used to be plain capsules (`render/cityLife.ts`
 * `buildPedGeometry`). These four Quaternius CC0 human models
 * (see `game/public/models/quaternius-civilians/SOURCING.md`) replace the
 * capsules once they lazy-load: each variant's per-material parts are
 * baked into ONE vertex-colored geometry (authored clothing/skin colors
 * become the `color` attribute), so the whole crowd renders as at most 4
 * instanced meshes — one draw call per variant.
 *
 * The models arrive via the lazy pipeline (`MODEL_PATHS` keys
 * `personCasualMan`, `personCasualWoman`, `personWorker`,
 * `personWomanTwo` — never in the boot set); `buildPersonVariantGeometry`
 * is pure and Node-testable. Pedestrian assignment is round-robin
 * (`personVariantForIndex`), a pure function of the ped index, so the
 * crowd's zero-state pose contract is preserved.
 *
 * Import-safe under Node/vitest (`three` core has no DOM at import).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { LoadedModel } from './models';

/**
 * `MODEL_PATHS` keys for the four civilian variants, in fixed
 * round-robin order: two men, two women, all civilian dress.
 */
export const PERSON_MODEL_KEYS = [
  'personCasualMan',
  'personCasualWoman',
  'personWorker',
  'personWomanTwo',
] as const;

/** Target person height in world units (applied uniformly, base stays at y=0). */
export const PERSON_HEIGHT = 1.7;

/**
 * InstancedMesh capacity per person variant. Round-robin assignment puts
 * every 4th ped in one variant; 128 covers the 500-ped cap (125 max per
 * variant) with headroom.
 */
export const PERSON_VARIANT_CAPACITY = 128;

/** Which variant renders pedestrian `index` (round-robin — pure). */
export function personVariantForIndex(index: number): number {
  return ((index % PERSON_MODEL_KEYS.length) + PERSON_MODEL_KEYS.length) % PERSON_MODEL_KEYS.length;
}

/**
 * Bake one loaded person model into a single vertex-colored geometry:
 * every per-material part gets a `color` attribute from its material's
 * base color, parts merge into one indexed geometry, and the result is
 * uniformly scaled so the person stands `PERSON_HEIGHT` tall (base at
 * y=0 — `LoadedModel`s arrive normalized that way).
 *
 * Returns null when the model has no usable parts (caller keeps the
 * capsule fallback). Never mutates the input geometries.
 */
export function buildPersonVariantGeometry(loaded: LoadedModel): THREE.BufferGeometry | null {
  const parts: THREE.BufferGeometry[] = [];
  const n = Math.min(loaded.geometries.length, loaded.materials.length);
  for (let i = 0; i < n; i++) {
    const src = loaded.geometries[i] as THREE.BufferGeometry;
    const mat = loaded.materials[i] as THREE.Material;
    if (src === undefined || mat === undefined) continue;
    if (src.attributes['position'] === undefined) continue;
    const part = new THREE.BufferGeometry();
    // Keep exactly position + normal + index: UVs (if any) are dead
    // weight for an untextured vertex-colored crowd mesh, and a uniform
    // attribute set is what mergeGeometries requires.
    part.setAttribute('position', src.attributes['position'].clone());
    if (src.attributes['normal'] !== undefined) {
      part.setAttribute('normal', src.attributes['normal'].clone());
    }
    if (src.index !== null) part.setIndex(src.index.clone());
    const color = materialBaseColor(mat);
    const posAttr = part.attributes['position'] as THREE.BufferAttribute;
    const count = posAttr.count;
    const colors = new Float32Array(count * 3);
    for (let v = 0; v < count; v++) {
      colors[v * 3] = color.r;
      colors[v * 3 + 1] = color.g;
      colors[v * 3 + 2] = color.b;
    }
    part.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(part);
  }
  if (parts.length === 0) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (merged === null) return null;
  // Normalize to person height (uniform scale — the base stays at y=0).
  merged.computeBoundingBox();
  const box = merged.boundingBox as THREE.Box3;
  const height = box.max.y - box.min.y;
  if (!Number.isFinite(height) || height <= 0) {
    merged.dispose();
    return null;
  }
  const s = PERSON_HEIGHT / height;
  merged.scale(s, s, s);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Base color of a material (white fallback for exotic materials). */
function materialBaseColor(mat: THREE.Material): THREE.Color {
  const maybe = mat as THREE.Material & { color?: unknown };
  if (maybe.color instanceof THREE.Color) return maybe.color;
  return new THREE.Color(0xffffff);
}
