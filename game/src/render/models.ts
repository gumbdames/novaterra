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
 *  - `MODEL_PATHS`: the key -> file mapping. Keys are UnitKind |
 *    BuildingKind for 1:1 entity models, `<kind><Piece>` for composite
 *    building pieces (farm barn/silo, power-plant building/chimney,
 *    shipyard crane/machine, aegis main block), and `prop*` for the
 *    render-only nature scatter. See `docs/research/real-models.md` for
 *    the sourcing rationale; every entry is CC0 (Kenney / Quaternius).
 *  - `loadModels`: fetch + process each GLB, bounded by a per-model
 *    timeout. After extraction it applies the model's surface treatment
 *    (`applySurfaceTreatment` in `render/entitySurfaces.ts`) once — the
 *    per-load material clones wear the shared procedural textures from
 *    then on, in every view, at zero per-frame cost. Any failure (404, timeout, parse error) records the key in
 *    `failed` and CONTINUES — a missing model must never throw and must
 *    never hang boot. Callers fall back to the procedural builders in
 *    `render/proceduralModels.ts` (then the placeholders in
 *    `render/entities.ts`) for failed/missing keys.
 *  - `loadOneModel`: the per-key pipeline behind `loadModels`, also used
 *    by the lazy loader (`render/lazyModels.ts`) so boot and lazy loads
 *    share one fetch path.
 *  - `cachedFetch`: every GLB byte travels through the Cache API
 *    (`MODEL_CACHE_NAME`, same-origin). A key fetched once is served
 *    from the cache thereafter — the game stays playable
 *    offline-after-first-load. Falls back to plain fetch where the Cache
 *    API is unavailable (Node/tests).
 *  - Pure, testable helpers: `modelBaseUrl`, `normalizeModel`,
 *    `extractModelGeometry`, `disposeModels`.
 *
 * Scale provenance: every `scale` below was computed by loading the GLB
 * with this module's own `normalizeModel` and fitting it inside the
 * game's footprint convention (`hullSizeFor` for units, footprint tiles ×
 * `CELL_WORLD_SIZE` for buildings, target heights for nature props).
 * `rotY` bakes the authored-facing → game-forward (+z) yaw correction
 * (facing measured from the geometry: tank barrel, jet nose, ship
 * superstructure, human head/pose asymmetry); `yOffset` sinks boat hulls
 * (negative) so the waterline sits partway up the hull side instead of at
 * the keel — normalizeModel rests the keel at y=0, which would leave the
 * boat sitting on top of the water like a toy.
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
import { applySurfaceTreatment } from './entitySurfaces';

/** Which GLB file to load for a model key, and how to fit it. */
export interface ModelSpec {
  /**
   * Path of the GLB relative to `game/public/models/`, e.g.
   * `'kenney-car/truck.glb'`. A redundant leading `models/` segment or
   * leading `/` is stripped.
   */
  path: string;
  /** Uniform scale applied after normalization (must be finite and > 0). */
  scale: number;
  /**
   * Optional yaw (radians) applied to the scene BEFORE normalization, so
   * the model's authored forward ends up facing the game's forward axis
   * (+z — see `render/entities.ts` movement orientation). Baked into the
   * extracted geometry; views never rotate for facing correction.
   */
  rotY?: number;
  /**
   * Optional world-units lift applied AFTER normalization (whose base
   * sits at y=0). Used for boats/ships so the waterline sits partway up
   * the hull instead of at the keel.
   */
  yOffset?: number;
}

/**
 * Key -> file mapping (0.1 Alpha). All files are CC0 (see
 * THIRD_PARTY_NOTICES.md and docs/research/real-models.md).
 *
 * Keys: UnitKind / BuildingKind for 1:1 models; `<kind><Piece>` for
 * composite-building pieces assembled in `render/entities.ts`
 * (`MODEL_SOURCES` there documents the per-piece offsets); `prop*` for
 * the render-only nature scatter (`render/nature.ts`).
 *
 * `path` is relative to `game/public/models/` (served at
 * `<import.meta.env.BASE_URL>models/<file>`).
 */
export const MODEL_PATHS: Record<string, ModelSpec> = {
  // ---- units (1:1) ----
  engineer: { path: 'quaternius/engineer.glb', scale: 0.372 },
  rifles: { path: 'quaternius/rifleman.glb', scale: 0.372 },
  // tank-2: lowest-profile of the four Quaternius variants (most MBT-like),
  // authored along x with the barrel at -x → rotY π/2 faces it to +z.
  tank: { path: 'quaternius/tank-2.glb', scale: 0.26, rotY: Math.PI / 2 },
  // Kenney trucks author the cab at -z (cargo mass toward +z) → rotY π.
  hauler: { path: 'kenney-car/truck.glb', scale: 1.538, rotY: Math.PI },
  // craft_racer nose at -z → rotY π.
  spectre: { path: 'kenney-space/craft_racer.glb', scale: 1.6, rotY: Math.PI },
  hq: { path: 'kenney-car/truck-flat.glb', scale: 1.846, rotY: Math.PI },
  // boat-speed-a bow already at +z; negative yOffset sinks the keel so
  // the waterline sits ~1/4 up the hull side (deck at ~0.6 authored).
  patrolBoat: { path: 'kenney-watercraft/boat-speed-a.glb', scale: 1.333, yOffset: -0.3 },
  // ship-cargo-a superstructure toward +z ⇒ bow at -z → rotY π; yOffset
  // sinks the keel so the waterline sits ~55% up the hull (deck ~1.4).
  transportShip: {
    path: 'kenney-watercraft/ship-cargo-a.glb',
    scale: 1.183,
    rotY: Math.PI,
    yOffset: -0.9,
  },

  // ---- buildings (1:1) ----
  house: { path: 'kenney-suburban/building-type-f.glb', scale: 2.637 },
  // Commercial variants picked per kind so every building reads distinct:
  // apartment = tall slab (g), shop = low block (a), lab = mid block (i).
  apartment: { path: 'kenney-commercial/building-g.glb', scale: 5.33 },
  shop: { path: 'kenney-commercial/building-a.glb', scale: 3.1 },
  lab: { path: 'kenney-commercial/building-i.glb', scale: 3.08 },
  factory: { path: 'kenney-industrial/building-e.glb', scale: 2.74 },
  waterPump: { path: 'kenney-industrial/water-tower.glb', scale: 1.87 },
  // aegisControl = wide slab (k) + procedural radar dish (entities.ts).
  aegisMain: { path: 'kenney-commercial/building-k.glb', scale: 2.88 },

  // ---- building composite pieces (assembled in render/entities.ts) ----
  farmBarn: { path: 'quaternius/farm-barn.glb', scale: 0.51 },
  farmSilo: { path: 'quaternius/farm-silo.glb', scale: 0.46 },
  powerPlantMain: { path: 'kenney-industrial/building-e.glb', scale: 2.5 },
  powerPlantChimney: { path: 'kenney-industrial/chimney-large.glb', scale: 2.6 },
  shipyardCrane: { path: 'kenney-factory/crane.glb', scale: 1.22 },
  shipyardMachine: { path: 'kenney-factory/machine.glb', scale: 2.0 },

  // ---- nature props (render-only scatter, render/nature.ts) ----
  // The six tree keys are Kenney GLBs ONLY as a silent fallback: at game
  // start ui/game.ts overlays the procedural textured trees from
  // render/natureTrees.ts (same keys) over these map entries, so the
  // scatter draws textured trees whenever the texture fetch succeeds.
  propTreeOak: { path: 'kenney-nature/tree_oak.glb', scale: 4.89 },
  propTreeBirch: { path: 'kenney-nature/tree_cone.glb', scale: 4.2 },
  propTreePineTall: { path: 'kenney-nature/tree_pineTallA.glb', scale: 4.58 },
  propTreePine: { path: 'kenney-nature/tree_blocks.glb', scale: 4.22 },
  propTreeOldOak: { path: 'kenney-nature/tree_detailed.glb', scale: 4.5 },
  propTreePoplar: { path: 'kenney-nature/tree_plateau.glb', scale: 4.0 },
  propRockLarge: { path: 'kenney-nature/rock_largeA.glb', scale: 1.76 },
  propRockTall: { path: 'kenney-nature/rock_tallA.glb', scale: 1.84 },
  propRockSmall: { path: 'kenney-nature/rock_smallH.glb', scale: 2.93 },
  propBushDetailed: { path: 'kenney-nature/plant_bushDetailed.glb', scale: 2.33 },
  propBushLarge: { path: 'kenney-nature/plant_bushLarge.glb', scale: 3.78 },
  // ── NOVATERRA roster-expansion units ───────────────────────────────
  // sniperTeam / combatMedic reuse the quaternius rifleman at the proven
  // rifles scale (same authored geometry ⇒ same fit scale 0.372).
  sniperTeam: { path: 'quaternius/rifleman.glb', scale: 0.372 },
  combatMedic: { path: 'quaternius/rifleman.glb', scale: 0.372 },
  // tank-1 (10.09×7.50×17.68 after rotY π/2, radio antenna to 7.50) fit
  // inside hull { 3.2, 1.5, 4.8 } ⇒ height-constrained scale 0.2.
  tankDestroyer: { path: 'quaternius/tank-1.glb', scale: 0.2, rotY: Math.PI / 2 },
  // craft_cargoA (1.60×0.80×2.45 after rotY π, same space-kit convention as
  // spectre) fit inside hull { 8.0, 2.5, 7.0 } ⇒ z-constrained scale 2.86.
  awacs: { path: 'kenney-space/craft_cargoA.glb', scale: 2.86, rotY: Math.PI },
  // boat-speed-d (2.00×1.20×3.87, bow +z) fit inside hull { 3.0, 1.8, 7.5 }
  // ⇒ scale 1.5, waterline ~1/4 up the hull like patrolBoat.
  missileBoat: { path: 'kenney-watercraft/boat-speed-d.glb', scale: 1.5, yOffset: -0.3 },
  // ship-cargo-b (3.92×3.30×10.55 after rotY π, superstructure +z ⇒ bow -z)
  // fit inside hull { 6.0, 4.0, 16.0 } ⇒ height-constrained scale 1.21,
  // waterline sunk like transportShip.
  commandShip: { path: 'kenney-watercraft/ship-cargo-b.glb', scale: 1.21, rotY: Math.PI, yOffset: -0.9 },
  // boat-fishing-small (1.78×2.60×3.87 after rotY π, cabin/mast +z ⇒ bow
  // -z) fit inside hull { 2.4, 1.6, 5.0 } ⇒ mast-constrained scale 0.615.
  fishingBoat: { path: 'kenney-watercraft/boat-fishing-small.glb', scale: 0.615, rotY: Math.PI, yOffset: -0.25 },
  // ── NOVATERRA roster-expansion building pieces ─────────────────────────
  // barracks 6×6 footprint / 5 tall: building-d (0.88×1.41×1.42) ⇒ 3.55.
  barracks: { path: 'kenney-industrial/building-d.glb', scale: 3.55 },
  // warFactory 8×6 / 7 tall: building-a (2.08×1.47×1.24) ⇒ 3.85.
  warFactoryMain: { path: 'kenney-industrial/building-a.glb', scale: 3.85 },
  // Shared smokestack piece for warFactory and oilRefinery (4.2 tall).
  industrialStack: { path: 'kenney-industrial/chimney-medium.glb', scale: 2.2 },
  // airfield 10×8 / 6 tall: large hangar (2.00×1.00×3.00) ⇒ 2.67,
  // small hangar (2.00×1.00×2.00) ⇒ 2.0.
  airfieldHangar: { path: 'kenney-space/hangar_largeA.glb', scale: 2.67 },
  airfieldHangar2: { path: 'kenney-space/hangar_smallA.glb', scale: 2.0 },
  // navalYard 10×8 / 7 tall: crane-lift (0.72×2.50×0.72) ⇒ 2.0 (5.0 tall
  // gantry), hall building-k (1.30×0.77×0.91) ⇒ 3.08.
  navalYardCrane: { path: 'kenney-factory/crane-lift.glb', scale: 2.0 },
  navalYardHall: { path: 'kenney-industrial/building-k.glb', scale: 3.08 },
  // radarStation 4×4 / 6 tall: satelliteDish_large (0.85×0.81×0.74) ⇒ 4.7.
  radarStation: { path: 'kenney-space/satelliteDish_large.glb', scale: 4.7 },
  // oilRefinery 8×6 / 8 tall: large tank (1.51×0.96×1.65) ⇒ 1.6,
  // shared small tank piece (detail-tank 0.85×0.42×0.52) ⇒ 2.4.
  oilRefineryTank: { path: 'kenney-industrial/detail-tank-large.glb', scale: 1.6 },
  industrialTank: { path: 'kenney-industrial/detail-tank.glb', scale: 2.4 },
  // recyclingCenter 6×6 / 5 tall: building-i (1.03×0.73×1.30) ⇒ 4.6.
  recyclingCenter: { path: 'kenney-industrial/building-i.glb', scale: 4.6 },
  // market 6×6 / 5 tall: commercial building-b (0.97×1.29×0.94) ⇒ 3.88.
  market: { path: 'kenney-commercial/building-b.glb', scale: 3.88 },
  // solarFarm 8×6 / 3 tall: two panel groups (1.51×0.26×0.90 and
  // 0.92×0.41×1.25) at scale 3.0 tile the footprint.
  solarFarmA: { path: 'kenney-industrial/solar-panel-landscape-group.glb', scale: 3.0 },
  solarFarmB: { path: 'kenney-industrial/solar-panel-portrait-group.glb', scale: 3.0 },
  // nuclearPlant 8×8 / 12 tall: building-f (1.79×1.92×1.28) ⇒ 4.47.
  nuclearPlantMain: { path: 'kenney-industrial/building-f.glb', scale: 4.47 },
  // desalination 6×6 / 5 tall: shared small tank + hall
  // building-s (2.12×0.84×0.92) ⇒ 1.89.
  desalinationHall: { path: 'kenney-industrial/building-s.glb', scale: 1.89 },
  // hospital 6×6 / 8 tall: commercial building-d (0.84×1.29×0.90) ⇒ 6.2.
  hospital: { path: 'kenney-commercial/building-d.glb', scale: 6.2 },
  // university 8×6 / 9 tall: commercial building-f (0.84×1.69×1.03) ⇒ 5.33.
  university: { path: 'kenney-commercial/building-f.glb', scale: 5.33 },
  // school 4×4 / 4 tall: suburban building-type-h (1.30×0.74×0.92) ⇒ 3.08.
  school: { path: 'kenney-suburban/building-type-h.glb', scale: 3.08 },
  // Workstream Z (2026-09-30): the education ladder reuses Kenney
  // suburban houses like the school does (militaryAcademy precedent):
  // kindergarten 4×4 / 2 tall: building-type-e (1.30×1.14×1.02) ⇒ 3.08.
  kindergarten: { path: 'kenney-suburban/building-type-e.glb', scale: 3.08 },
  // college 4×4 / 3 tall: building-type-j (1.38×1.04×0.92) ⇒ 2.90.
  college: { path: 'kenney-suburban/building-type-j.glb', scale: 2.9 },
  // ── NOVATERRA Phase 1 (veterancy) ──────────────────────────────────
  // militaryAcademy 3×3 footprint / 4 tall: industrial building-h
  // (1.32×0.73×1.31) ⇒ 4.54, footprint-constrained — a low parade hall
  // 3.3 tall. File is 63.6 KB (Phase 1 budget: +1 key ~80 KB) and already
  // license-manifested (THIRD_PARTY_NOTICES.md, Kenney CC0).
  militaryAcademy: { path: 'kenney-industrial/building-h.glb', scale: 4.54 },
  // ── NOVATERRA civilian pedestrians (Phase 4 RENDER workstream A) ────
  // Quaternius CC0 humans for the ambient crowd (render/people.ts). These
  // four keys are LAZY — never in the boot set (see bootModelKeys below):
  // they load on first population through the store's self-triggering
  // map, so the 8 MiB startup gate is unaffected (+1.05 MB lazy total).
  // scale: 1 — render/people.ts normalizes each variant to person height
  // itself (the four models are authored at wildly different scales).
  personCasualMan: { path: 'quaternius-civilians/civilian-man.glb', scale: 1 },
  personCasualWoman: { path: 'quaternius-civilians/civilian-woman.glb', scale: 1 },
  personWorker: { path: 'quaternius-civilians/civilian-worker.glb', scale: 1 },
  personWomanTwo: { path: 'quaternius-civilians/civilian-woman-2.glb', scale: 1 },
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

/** Join a ModelSpec path onto the models base URL. Exported for the lazy loader. */
export function modelUrl(spec: ModelSpec): string {
  let rel = spec.path.replace(/^\/+/, '');
  if (rel === 'models' || rel.startsWith('models/')) rel = rel.slice('models'.length).replace(/^\/+/, '');
  return modelBaseUrl() + rel;
}

/**
 * Cache API bucket for model GLB bytes (same-origin URLs only — every
 * model URL is built by `modelUrl` above, so this holds by construction).
 * Versioned: bump the suffix if the cache schema ever changes.
 */
export const MODEL_CACHE_NAME = 'novaterra-models-v1';

/**
 * Fetch through the Cache API: serve a cached response when present,
 * otherwise fetch from the network and stash a clone for next time.
 * A cache read/write failure never breaks the load — the network
 * response is already in hand. Where the Cache API is unavailable
 * (Node, tests, very old browsers) this is plain fetch.
 *
 * This is what makes the game playable offline-after-first-load: every
 * GLB byte the loader needs passes through here, so a key fetched once
 * is served from the cache on later visits even with no network.
 */
export async function cachedFetch(url: string): Promise<Response> {
  const cachesApi = (globalThis as { caches?: CacheStorage }).caches;
  if (cachesApi === undefined) return fetch(url);
  const cache = await cachesApi.open(MODEL_CACHE_NAME);
  const hit = await cache.match(url);
  if (hit !== undefined) return hit;
  const response = await fetch(url);
  if (response.ok) {
    try {
      // put() consumes the body — clone first. Quota or any other
      // failure must not break the load in progress.
      await cache.put(url, response.clone());
    } catch {
      /* cache write failed; the live response is still fine */
    }
  }
  return response;
}

/**
 * Minimal GLTFLoader surface the model pipeline needs. `parseAsync`
 * (bytes + resource path) is used instead of `loadAsync(url)` so the
 * GLB bytes travel through `cachedFetch` above; texture references
 * inside the GLB still resolve relative to the model's URL, exactly as
 * with `loadAsync`.
 */
export interface ModelLoader {
  parseAsync(data: ArrayBuffer, path: string): Promise<{ scene: THREE.Object3D }>;
}

/**
 * Dynamically import GLTFLoader (separate chunk — only downloaded when
 * models load, same as before). Throws if the loader module itself is
 * unavailable; callers translate that into per-key failures.
 */
export async function createModelLoader(): Promise<ModelLoader> {
  const mod = await import('three/addons/loaders/GLTFLoader.js');
  return new mod.GLTFLoader() as ModelLoader;
}

/**
 * Load, normalize, and extract ONE model key. The shared per-key
 * pipeline: `loadModels` maps over it for boot, the lazy loader
 * (`render/lazyModels.ts`) calls it per key on first use.
 *
 * Throws on any failure (404, timeout, parse error, bad scale, loader
 * unavailable) — callers record the key as failed and continue.
 */
export async function loadOneModel(
  loader: ModelLoader,
  key: string,
  spec: ModelSpec,
  timeoutMs: number = MODEL_LOAD_TIMEOUT_MS,
): Promise<LoadedModel> {
  const url = modelUrl(spec);
  const gltf = await withTimeout(
    (async () => {
      const response = await cachedFetch(url);
      if (!response.ok) {
        throw new Error(`loadOneModel(${key}): HTTP ${response.status} for ${url}`);
      }
      const bytes = await response.arrayBuffer();
      // parseAsync's `path` is STRING-concatenated (three's resolveURL does
      // `path + uri`, no URL resolution) with texture URIs inside the GLB —
      // it must be the model's DIRECTORY (trailing slash), not the GLB file
      // URL, or textures resolve to `<name>.glbTextures/...` and 404.
      const resourcePath = url.slice(0, url.lastIndexOf('/') + 1);
      return loader.parseAsync(bytes, resourcePath);
    })(),
    timeoutMs,
    `loadOneModel(${key})`,
  );
  // rotY first so normalization centers the yaw-corrected model and
  // the baked geometry faces the game's forward axis (+z).
  if (spec.rotY !== undefined && spec.rotY !== 0) {
    gltf.scene.rotateY(spec.rotY);
  }
  normalizeModel(gltf.scene, spec.scale);
  // yOffset after normalization: base rests at yOffset, not y=0
  // (boats/ships float with the waterline up the hull).
  if (spec.yOffset !== undefined && spec.yOffset !== 0) {
    gltf.scene.position.y += spec.yOffset;
    gltf.scene.updateMatrixWorld(true);
  }
  const { geometries, materials } = await extractModelGeometry(gltf.scene);
  // Layer shared procedural surfaces onto the per-load clones once
  // here — before the model is shared across views — never per-view
  // in the hot path (render/entitySurfaces.ts).
  applySurfaceTreatment(key, geometries, materials);
  disposeSourceScene(gltf.scene);
  return { geometries, materials };
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
 * Each GLB is fetched with `withTimeout(loadOneModel(...), timeoutMs)`:
 * a 404, a parse error, or a pend past the deadline records the key in
 * `failed` and the loop CONTINUES — the result carries only successes, so a
 * missing/broken model degrades to the procedural placeholder instead of
 * throwing or hanging boot. Never throws, never pends forever.
 *
 * All entries load concurrently: with dozens of models, sequential loads
 * would multiply the per-model timeouts far past any sane startup budget.
 * Concurrent fetch+parse against the same origin multiplexes fine; result
 * semantics are unchanged.
 */
export async function loadModels(
  paths: Record<string, ModelSpec>,
  opts: LoadModelsOptions = {},
): Promise<LoadModelsResult> {
  const timeoutMs = opts.timeoutMs ?? MODEL_LOAD_TIMEOUT_MS;
  const models = new Map<string, LoadedModel>();
  const failed: string[] = [];

  let loader: ModelLoader;
  try {
    loader = await createModelLoader();
  } catch (error) {
    // The loader module itself is unavailable: everything fails, loudly but
    // without throwing.
    for (const key of Object.keys(paths)) failed.push(key);
    console.warn('[models] GLTFLoader unavailable; all model loads failed:', error);
    return { models, failed };
  }

  const results = await Promise.all(
    Object.entries(paths).map(async ([key, spec]) => {
      try {
        const model = await loadOneModel(loader, key, spec, timeoutMs);
        return { key, model };
      } catch (error) {
        // 404 / timeout / parse error / bad scale: record and continue.
        failed.push(key);
        console.warn(`[models] failed to load "${key}":`, error);
        return null;
      }
    }),
  );
  for (const r of results) {
    if (r !== null) models.set(r.key, r.model);
  }
  return { models, failed };
}

/**
 * Dispose every geometry, material, and texture in a loaded-model map.
 * Textures are per-load (GLTFLoader mints one Texture per file even when
 * two GLBs share a PNG), so releasing them here is safe; the Set guards
 * against double-disposing a texture shared by several cloned materials
 * of one model.
 */
export function disposeModels(models: Map<string, LoadedModel>): void {
  const textures = new Set<THREE.Texture>();
  for (const model of models.values()) {
    for (const geometry of model.geometries) geometry.dispose();
    for (const material of model.materials) {
      collectMaterialTextures(material, textures);
      material.dispose();
    }
  }
  for (const texture of textures) texture.dispose();
}

/** Gather every Texture a material references (map, normalMap, …). */
function collectMaterialTextures(material: THREE.Material, out: Set<THREE.Texture>): void {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) out.add(value);
  }
}
