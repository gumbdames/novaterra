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
 * External 3D model loading infrastructure (0.1 Alpha).
 *
 * Purpose: load CC0 GLB model packs at boot, normalize them into the game's
 * footprint convention (centered horizontally on the origin, base resting at
 * y=0, uniform scale applied), and hand the render layer merged,
 * per-material geometry + cloned materials that callers can tint safely.
 *
 * Responsibilities:
 *  - `MODEL_PATHS`: the stub key -> file mapping. Keys will be UnitKind |
 *    BuildingKind | prop names once the model-research step fills them in.
 *  - `loadModels`: fetch + process each GLB, bounded by a per-model
 *    timeout. Any failure (404, timeout, parse error) records the key in
 *    `failed` and CONTINUES — a missing model must never throw and must
 *    never hang boot. Callers fall back to the procedural placeholders in
 *    `render/entities.ts` for failed/missing keys.
 *  - Pure, testable helpers: `modelBaseUrl`, `normalizeModel`,
 *    `extractModelGeometry`, `disposeModels`.
 *
 * Invariants:
 *  - The module stays import-safe under Node/vitest: `three` core is a
 *    static import (no DOM at import time), while `GLTFLoader` and
 *    `BufferGeometryUtils` are loaded via DYNAMIC import (same pattern as
 *    `render/renderer.ts`).
 *  - World transforms are baked into geometry (`matrixWorld` applied), so
 *    the returned geometries are in model-local space and renderable with
 *    an identity parent.
 *  - Returned materials are CLONES of the GLB's materials; the source
 *    scene's geometries/materials are disposed after extraction.
 */

import * as THREE from 'three';

import { withTimeout } from './renderer';

/** Which GLB file to load for a model key, and how to fit it. */
export interface ModelSpec {
  /**
   * Path of the GLB relative to `game/public/models/`, e.g. `'tank.glb'`.
   * A redundant leading `models/` segment or leading `/` is stripped.
   */
  path: string;
  /** Uniform scale applied after normalization (must be finite and > 0). */
  scale: number;
}

/**
 * Stub key -> file mapping (0.1 Alpha).
 *
 * RESEARCH PENDING — filled by the model-integration step (sibling agent's
 * CC0 pack research). Keys will be UnitKind | BuildingKind | prop names;
 * `path` is relative to `game/public/models/` (served at
 * `<import.meta.env.BASE_URL>models/<file>`).
 */
export const MODEL_PATHS: Record<string, ModelSpec> = {
  tank: { path: 'tank.glb', scale: 1 },
  house: { path: 'house.glb', scale: 1 },
  tree: { path: 'tree.glb', scale: 1 },
};

/** One successfully loaded + normalized model. */
export interface LoadedModel {
  /** Merged geometries, one per distinct material, model-local space. */
  geometries: THREE.BufferGeometry[];
  /** Cloned materials matching `geometries` 1:1 — safe for callers to tint. */
  materials: THREE.Material[];
}

export interface LoadModelsOptions {
  /** Per-model deadline for the GLB fetch+parse. Default 15000ms. */
  timeoutMs?: number;
}

export interface LoadModelsResult {
  /** Only the models that loaded successfully, keyed by MODEL_PATHS key. */
  models: Map<string, LoadedModel>;
  /** Keys that failed (404, timeout, parse error, loader unavailable). */
  failed: string[];
}

/** Default per-model deadline: generous for first-load, but finite. */
export const MODEL_LOAD_TIMEOUT_MS = 15000;

/**
 * Base URL models are served from: `<import.meta.env.BASE_URL>models/`.
 * Vite's `base` is `/novaterra/` (GitHub Pages project site). Falls back
 * to `/models/` when `import.meta.env` is unavailable (plain Node).
 */
export function modelBaseUrl(): string {
  let base = '/';
  try {
    const b = import.meta.env.BASE_URL as string | undefined;
    if (typeof b === 'string' && b.length > 0) base = b;
  } catch {
    // import.meta unavailable (plain Node) — fall through to '/'.
  }
  if (!base.endsWith('/')) base += '/';
  return `${base}models/`;
}

/** Join a ModelSpec path onto the models base URL. */
function modelUrl(spec: ModelSpec): string {
  let rel = spec.path.replace(/^\/+/, '');
  if (rel === 'models' || rel.startsWith('models/')) rel = rel.slice('models'.length).replace(/^\/+/, '');
  return modelBaseUrl() + rel;
}

/**
 * Normalize a model's scene root in place: center the content horizontally
 * (x/z) on the origin, rest its base at y=0, and apply the uniform `scale`.
 *
 * Works for any pre-existing root transform (the normalization is
 * premultiplied onto the root's world matrix, so it is parent-independent).
 * A root with no geometry is left untouched. Throws on a non-finite or
 * non-positive scale — fail fast here so a bad mapping is loud at
 * integration time, not silent in-game.
 */
export function normalizeModel(root: THREE.Object3D, scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`normalizeModel: scale must be finite and > 0, got ${scale}`);
  }
  root.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return; // No geometry — nothing to normalize.
  const center = box.getCenter(new THREE.Vector3());
  // norm = T * S: scale about the world origin, then shift the scaled box
  // so its horizontal center is at x=z=0 and its base at y=0.
  const norm = new THREE.Matrix4()
    .makeTranslation(-scale * center.x, -scale * box.min.y, -scale * center.z)
    .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
  // world' = norm * world  =>  local' = parentWorld^-1 * norm * parentWorld * local
  // (clone before inverting: invert() mutates in place and the original is
  // still needed below.)
  const parentWorld = new THREE.Matrix4();
  if (root.parent !== null) parentWorld.copy(root.parent.matrixWorld);
  const newLocal = parentWorld
    .clone()
    .invert()
    .multiply(norm)
    .multiply(parentWorld)
    .multiply(root.matrix);
  newLocal.decompose(root.position, root.quaternion, root.scale);
  root.updateMatrixWorld(true);
}

/** Typed-array constructor helper for geometry slicing. */
type TypedArrayCtor = new (length: number) => {
  set(source: ArrayLike<number>, offset?: number): void;
  subarray(begin: number, end?: number): { [index: number]: number; length: number };
  slice(begin?: number, end?: number): { [index: number]: number; length: number };
};

/**
 * Slice `[start, start+count)` vertices (indexed) or elements (non-indexed)
 * out of a geometry into a fresh BufferGeometry. Used to split
 * multi-material meshes along their geometry groups.
 */
function sliceGeometry(
  geom: THREE.BufferGeometry,
  start: number,
  count: number,
): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  const index = geom.getIndex();
  if (index !== null) {
    // Indexed: slice the index range, then compact to the used vertices.
    const srcIndex = index.array as unknown as { [i: number]: number; length: number };
    const used = new Map<number, number>();
    const remapped: number[] = [];
    for (let i = 0; i < count; i++) {
      const v = srcIndex[start + i];
      if (v === undefined) continue;
      let nv = used.get(v);
      if (nv === undefined) {
        nv = used.size;
        used.set(v, nv);
      }
      remapped.push(nv);
    }
    const IndexCtor = (
      index.array instanceof Uint32Array ? Uint32Array : Uint16Array
    ) as unknown as TypedArrayCtor & {
      from(values: number[]): { [index: number]: number; length: number };
    };
    const newIndex = IndexCtor.from(remapped);
    for (const name of Object.keys(geom.attributes)) {
      const attr = geom.getAttribute(name) as THREE.BufferAttribute; // GLB meshes use plain attributes, not interleaved.
      const Ctor = attr.array.constructor as unknown as TypedArrayCtor;
      const dst = new Ctor(used.size * attr.itemSize);
      for (const [oldI, newI] of used) {
        const src = attr.array as unknown as { subarray(b: number, e: number): ArrayLike<number> };
        dst.set(src.subarray(oldI * attr.itemSize, (oldI + 1) * attr.itemSize), newI * attr.itemSize);
      }
      out.setAttribute(name, new THREE.BufferAttribute(dst as unknown as THREE.TypedArray, attr.itemSize));
    }
    out.setIndex(new THREE.BufferAttribute(newIndex as unknown as THREE.TypedArray, 1));
  } else {
    for (const name of Object.keys(geom.attributes)) {
      const attr = geom.getAttribute(name) as THREE.BufferAttribute; // GLB meshes use plain attributes, not interleaved.
      const Ctor = attr.array.constructor as unknown as TypedArrayCtor;
      const dst = new Ctor(count * attr.itemSize);
      const src = attr.array as unknown as { subarray(b: number, e: number): ArrayLike<number> };
      dst.set(src.subarray(start * attr.itemSize, (start + count) * attr.itemSize));
      out.setAttribute(name, new THREE.BufferAttribute(dst as unknown as THREE.TypedArray, attr.itemSize));
    }
  }
  return out;
}

/**
 * Traverse a (normalized) model root, bake each mesh's world transform into
 * its geometry, group pieces by material, and merge each group into a single
 * geometry. Multi-material meshes are split along their geometry groups so
 * every piece lands in its material's bucket.
 *
 * Returns merged geometries with 1:1 cloned materials. The caller owns the
 * returned geometries/materials; intermediate clones are disposed.
 */
export async function extractModelGeometry(
  root: THREE.Object3D,
): Promise<{ geometries: THREE.BufferGeometry[]; materials: THREE.Material[] }> {
  const { mergeGeometries } = await import(
    'three/addons/utils/BufferGeometryUtils.js'
  );
  root.updateMatrixWorld(true);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const push = (geom: THREE.BufferGeometry, material: THREE.Material): void => {
    const arr = buckets.get(material);
    if (arr !== undefined) arr.push(geom);
    else buckets.set(material, [geom]);
  };
  root.traverse((obj: THREE.Object3D) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const geom = mesh.geometry as THREE.BufferGeometry;
    if (geom === undefined) return;
    const material = mesh.material as THREE.Material | THREE.Material[];
    const mats = Array.isArray(material) ? material : [material];
    if (mats.length === 1) {
      const single = mats[0];
      if (single === undefined) return;
      push(geom.clone().applyMatrix4(mesh.matrixWorld), single);
    } else {
      // Multi-material: split along geometry groups by material index.
      for (const group of geom.groups) {
        const m = mats[group.materialIndex ?? 0] ?? mats[0];
        if (m === undefined) continue;
        push(
          sliceGeometry(geom, group.start, group.count).applyMatrix4(mesh.matrixWorld),
          m,
        );
      }
    }
  });
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const [material, pieces] of buckets) {
    const merged = mergeGeometries(pieces, false);
    if (merged !== null) {
      for (const piece of pieces) piece.dispose();
      geometries.push(merged);
    } else {
      // Attribute mismatch across pieces (shouldn't happen for GLB meshes
      // sharing a material): keep the baked pieces unmerged instead of
      // dropping the model.
      for (const piece of pieces) geometries.push(piece);
    }
    materials.push(material.clone());
  }
  return { geometries, materials };
}

/** Dispose a loaded GLB source scene after extraction (frees CPU memory). */
function disposeSourceScene(root: THREE.Object3D): void {
  root.traverse((obj: THREE.Object3D) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const geom = mesh.geometry as THREE.BufferGeometry | undefined;
    if (geom !== undefined) geom.dispose();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (material === undefined) return;
    for (const m of Array.isArray(material) ? material : [material]) m.dispose();
  });
}

/**
 * Load every model in `paths` (normally `MODEL_PATHS`).
 *
 * Each GLB is fetched with `withTimeout(loader.loadAsync(url), timeoutMs)`:
 * a 404, a parse error, or a pend past the deadline records the key in
 * `failed` and the loop CONTINUES — the result carries only successes, so a
 * missing/broken model degrades to the procedural placeholder instead of
 * throwing or hanging boot. Never throws, never pends forever.
 */
export async function loadModels(
  paths: Record<string, ModelSpec>,
  opts: LoadModelsOptions = {},
): Promise<LoadModelsResult> {
  const timeoutMs = opts.timeoutMs ?? MODEL_LOAD_TIMEOUT_MS;
  const models = new Map<string, LoadedModel>();
  const failed: string[] = [];

  let GLTFLoaderCtor: new () => { loadAsync(url: string): Promise<{ scene: THREE.Object3D }> };
  try {
    const mod = await import('three/addons/loaders/GLTFLoader.js');
    GLTFLoaderCtor = mod.GLTFLoader;
  } catch (error) {
    // The loader module itself is unavailable: everything fails, loudly but
    // without throwing.
    for (const key of Object.keys(paths)) failed.push(key);
    console.warn('[models] GLTFLoader unavailable; all model loads failed:', error);
    return { models, failed };
  }
  const loader = new GLTFLoaderCtor();

  for (const [key, spec] of Object.entries(paths)) {
    try {
      const url = modelUrl(spec);
      const gltf = await withTimeout(
        loader.loadAsync(url),
        timeoutMs,
        `loadModels(${key})`,
      );
      normalizeModel(gltf.scene, spec.scale);
      const { geometries, materials } = await extractModelGeometry(gltf.scene);
      disposeSourceScene(gltf.scene);
      models.set(key, { geometries, materials });
    } catch (error) {
      // 404 / timeout / parse error / bad scale: record and continue.
      failed.push(key);
      console.warn(`[models] failed to load "${key}":`, error);
    }
  }
  return { models, failed };
}

/** Dispose every geometry and material in a loaded-model map. */
export function disposeModels(models: Map<string, LoadedModel>): void {
  for (const model of models.values()) {
    for (const geometry of model.geometries) geometry.dispose();
    for (const material of model.materials) material.dispose();
  }
}
