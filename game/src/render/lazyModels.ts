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
 * Lazy per-key 3D model loading (0.1 Alpha).
 *
 * Purpose: keep the startup download under the 8 MiB gate as the roster
 * grows. Boot loads only the keys needed for the opening minutes of a
 * game (the boot set); every other key loads in the background on its
 * FIRST USE, with the existing GLB → procedural → placeholder fallback
 * chain (`render/entities.ts` `createModelGroup`) as the loading state.
 * When a key arrives it is set into the shared map, so every view
 * created from then on resolves the real GLB (hot-swap at the model-
 * resolution layer).
 *
 * Responsibilities:
 *  - `LazyModelStore`: owns the caller-owned model map (the same
 *    ownership contract as `loadModels`: the EntityRenderer borrows the
 *    map, `ui/game.ts` disposes it via `disposeModels`). Per-key load
 *    states (`idle → loading → loaded | failed`), idempotent `request()`
 *    (concurrent requests for one key share a single load), a bounded
 *    number of simultaneous GLB fetches, and `onDidLoad` arrival
 *    notifications.
 *  - `LazyModelMap`: the `Map` the renderer borrows. `get()` on a
 *    missing key fires the background request and returns `undefined`
 *    (fallback renders) — this is the "first use" trigger, so neither
 *    the renderer nor the UI needs any lazy-loading call sites.
 *  - `bootModelKeys()`: the boot policy — model keys for foundation-age
 *    units/buildings plus the nature-scatter props. Everything a new
 *    game shows in its first minutes; later ages stream in as they are
 *    first used. New roster keys are lazy by DEFAULT: only add a key to
 *    the boot set when it must be on screen at game start.
 *  - `keysForKind()` / `collectKindKeys()`: kind → model-key resolution
 *    for prefetching (used for loaded save games: their kinds are
 *    requested before the renderer is built).
 *
 * Offline-after-first-load: every GLB byte travels through
 * `cachedFetch` (`render/models.ts`, Cache API `novaterra-models-v1`,
 * same-origin). A key fetched once is served from the cache on later
 * visits even with no network. Where the Cache API is unavailable the
 * fetch falls back to plain network fetch.
 *
 * Determinism: loading is asynchronous and timing-dependent, but it is
 * strictly render-side — the sim never reads the store or the map, no
 * RNG is drawn anywhere in this module, and load completion never feeds
 * back into sim state. `onDidLoad` listeners must be render-side too.
 *
 * Hot-swap scope: arrival upgrades the map, so subsequently created
 * views get the GLB. Views created during the loading window keep
 * their fallback art — upgrading a live view needs a per-view rebuild
 * hook in `EntityRenderer` (a follow-up for the render workstream;
 * `onDidLoad` already emits exactly the payload such a hook needs).
 * In practice the window is tiny: prefetches (boot set, save-game
 * scan) cover everything visible at start, and later keys are usually
 * requested well before their first view is built.
 *
 * Invariants:
 *  - A miss never throws and never blocks: `get()` returns `undefined`
 *    synchronously and the request proceeds in the background.
 *  - A failed key stays failed for the session (no retry storm); the
 *    fallback renders instead, exactly like a boot-time load failure.
 *  - The module stays import-safe under Node/vitest.
 */

import {
  MODEL_PATHS,
  MODEL_LOAD_TIMEOUT_MS,
  createModelLoader,
  disposeModels,
  loadOneModel,
  type LoadedModel,
  type ModelLoader,
  type ModelSpec,
} from './models';
import { modelSourceFor } from './entities';
import { NATURE_TREE_KINDS } from './natureTrees';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { BUILDING_DEFS, type BuildingKind } from '../sim/city';

/** Per-key load state. `failed` is terminal for the session. */
export type ModelLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

/**
 * The six nature-tree GLB keys. They are NOT in the boot set: at game
 * start `loadNatureTreeModels()` overlays textured procedural trees on
 * these keys, and the Kenney GLBs are only the silent fallback. If the
 * textured-tree load fails, `ui/game.ts` requests these keys before the
 * nature scatter is built, so the fallback still works.
 */
export const TREE_MODEL_KEYS: readonly string[] = NATURE_TREE_KINDS;

/** Default cap on simultaneous GLB fetches (browser per-origin limit). */
export const LAZY_LOAD_CONCURRENCY = 6;

export interface LazyModelStoreOptions {
  /**
   * Override the per-key load pipeline (tests). Defaults to the real
   * GLB pipeline (`createModelLoader` + `loadOneModel`, Cache API
   * backed, per-key timeout).
   */
  loadOne?: (key: string, spec: ModelSpec) => Promise<LoadedModel>;
  /** Max concurrent GLB loads. Default `LAZY_LOAD_CONCURRENCY`. */
  concurrency?: number;
  /** Keys awaited at boot. Default `bootModelKeys()`. */
  bootKeys?: string[];
}

/**
 * The map the EntityRenderer borrows. A `get()` miss kicks off the
 * background load for that key (idempotent — one load per key per
 * session) and returns `undefined` so the caller renders its fallback.
 * Fire-and-forget by design: a miss must never throw or block the
 * render loop.
 */
export class LazyModelMap extends Map<string, LoadedModel> {
  private readonly onMiss: (key: string) => void;

  constructor(onMiss: (key: string) => void) {
    super();
    this.onMiss = onMiss;
  }

  override get(key: string): LoadedModel | undefined {
    const hit = super.get(key);
    if (hit === undefined) {
      try {
        this.onMiss(key);
      } catch {
        /* request() never throws; belt and suspenders */
      }
    }
    return hit;
  }
}

/** Tiny counting semaphore for bounding concurrent GLB fetches. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.permits -= 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.permits += 1;
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }
}

/**
 * Model keys for an entity kind (GLB piece keys; empty for procedural /
 * placeholder kinds and unknown kinds). Single source of truth is
 * `modelSourceFor` in `render/entities.ts`.
 */
export function keysForKind(
  kind: string,
  paths: Record<string, ModelSpec> = MODEL_PATHS,
): string[] {
  const source = modelSourceFor(kind);
  if (source.type !== 'glb') return [];
  const keys: string[] = [];
  for (const piece of source.pieces) {
    if (paths[piece.key] !== undefined && !keys.includes(piece.key)) {
      keys.push(piece.key);
    }
  }
  return keys;
}

/** Model keys for a set of entity kinds, deduplicated, stable order. */
export function collectKindKeys(
  kinds: Iterable<string>,
  paths: Record<string, ModelSpec> = MODEL_PATHS,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const kind of kinds) {
    for (const key of keysForKind(kind, paths)) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/**
 * The boot set: model keys for every foundation-age unit/building kind
 * plus the nature-scatter prop keys (trees excepted — see
 * `TREE_MODEL_KEYS`). This is everything a fresh game can show in its
 * first minutes: starting forces, the foundation palette, and the
 * scatter built once at game start. Later ages' keys load on first use.
 *
 * Deterministic: insertion order is fixed (units, then buildings, then
 * props), independent of timing or platform.
 */
export function bootModelKeys(
  paths: Record<string, ModelSpec> = MODEL_PATHS,
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const add = (key: string): void => {
    if (paths[key] !== undefined && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  };
  for (const kind of Object.keys(UNIT_DEFS)) {
    const def = UNIT_DEFS[kind as UnitKind];
    // Fun-audit Tier 4 (E1/E2, 2026-10-02): scripted-only kinds spawn
    // mid-game through their own systems — never in the starting
    // forces. Neutral non-combatants (envoy SUV, luminary guest) via
    // the shared immunity gate, plus the drill instructor (from the
    // War Hero "retire" choice). Their models load lazily on first
    // spawn, keeping the boot set lean.
    if (
      def?.minAge === 'foundation' &&
      def?.neutralNonCombatant !== true &&
      kind !== 'drillInstructor'
    ) {
      for (const key of keysForKind(kind, paths)) add(key);
    }
  }
  for (const kind of Object.keys(BUILDING_DEFS)) {
    if (BUILDING_DEFS[kind as BuildingKind]?.minAge === 'foundation') {
      for (const key of keysForKind(kind, paths)) add(key);
    }
  }
  for (const key of Object.keys(paths)) {
    if (key.startsWith('prop') && !TREE_MODEL_KEYS.includes(key)) add(key);
  }
  return keys;
}

/**
 * Lazy model loading coordinator. Owns the caller-owned model map;
 * render-side only (see the module header for the determinism and
 * offline story).
 */
export class LazyModelStore {
  /** The map the EntityRenderer borrows (self-triggering on miss). */
  readonly map: LazyModelMap;
  /** Keys awaited at boot (default `bootModelKeys()`). */
  readonly bootKeys: string[];

  private readonly paths: Record<string, ModelSpec>;
  private readonly loadOne: (key: string, spec: ModelSpec) => Promise<LoadedModel>;
  private readonly semaphore: Semaphore;
  private readonly states = new Map<string, ModelLoadStatus>();
  private readonly inflight = new Map<string, Promise<LoadedModel | null>>();
  private readonly listeners = new Set<(keys: string[]) => void>();
  private loaderPromise: Promise<ModelLoader> | null = null;
  private disposed = false;

  constructor(
    paths: Record<string, ModelSpec> = MODEL_PATHS,
    opts: LazyModelStoreOptions = {},
  ) {
    this.paths = paths;
    this.semaphore = new Semaphore(opts.concurrency ?? LAZY_LOAD_CONCURRENCY);
    const injected = opts.loadOne;
    this.loadOne =
      injected ?? ((key, spec) => this.defaultLoadOne(key, spec));
    this.bootKeys = opts.bootKeys ?? bootModelKeys(paths);
    this.map = new LazyModelMap((key) => {
      void this.request(key);
    });
  }

  /** Current load state of a key (`idle` when never requested). */
  status(key: string): ModelLoadStatus {
    return this.states.get(key) ?? 'idle';
  }

  /** Counts per load state (for diagnostics/tests). */
  stats(): Record<ModelLoadStatus, number> {
    const counts: Record<ModelLoadStatus, number> = {
      idle: 0,
      loading: 0,
      loaded: 0,
      failed: 0,
    };
    for (const key of Object.keys(this.paths)) {
      counts[this.status(key)] += 1;
    }
    return counts;
  }

  /**
   * Request a key's model, idempotently: concurrent requests share one
   * load; an already-loaded key resolves immediately; a failed key
   * resolves `null` without retrying. Never throws — failures resolve
   * `null` and the caller renders its fallback.
   */
  request(key: string): Promise<LoadedModel | null> {
    const state = this.states.get(key) ?? 'idle';
    if (state === 'loaded') {
      return Promise.resolve(superGet(this.map, key));
    }
    if (state === 'loading') {
      return this.inflight.get(key) ?? Promise.resolve(null);
    }
    if (state === 'failed') {
      return Promise.resolve(null);
    }
    const spec = this.paths[key];
    if (spec === undefined) {
      // Not a known model key (shouldn't happen — piece keys come from
      // MODEL_SOURCES): stay on the fallback, loudly but without
      // throwing, and don't retry.
      console.warn(`[lazyModels] no model spec for key "${key}"; using fallback`);
      this.states.set(key, 'failed');
      return Promise.resolve(null);
    }
    this.states.set(key, 'loading');
    const pending = this.loadGuarded(key, spec);
    this.inflight.set(key, pending);
    return pending;
  }

  /** Request several keys; results align with the input order. */
  requestMany(keys: readonly string[]): Promise<Array<LoadedModel | null>> {
    return Promise.all(keys.map((key) => this.request(key)));
  }

  /**
   * Load the boot set (bounded per key by `MODEL_LOAD_TIMEOUT_MS`).
   * Returns the keys that failed so the caller can log them — same
   * "failed list" contract as `loadModels`.
   */
  async loadBootSet(): Promise<{ loaded: number; failed: string[] }> {
    const results = await this.requestMany(this.bootKeys);
    const failed: string[] = [];
    let loaded = 0;
    for (let i = 0; i < this.bootKeys.length; i++) {
      const key = this.bootKeys[i] as string;
      if (results[i] !== null) loaded += 1;
      else failed.push(key);
    }
    return { loaded, failed };
  }

  /**
   * Adopt an externally built model (the textured nature trees from
   * `loadNatureTreeModels`, which overlay the tree GLB keys). Marks the
   * key loaded without fetching.
   */
  adopt(key: string, model: LoadedModel): void {
    this.map.set(key, model);
    this.states.set(key, 'loaded');
    this.inflight.delete(key);
  }

  /**
   * Subscribe to key arrivals (render-side only). Called with the keys
   * that just arrived — the payload a future per-view hot-swap hook in
   * `EntityRenderer` would need. Returns an unsubscribe function.
   */
  onDidLoad(listener: (keys: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Release every geometry/material/texture in the map. After this the
   * store must not be used; in-flight loads dispose their models on
   * arrival instead of inserting them.
   */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.inflight.clear();
    disposeModels(this.map);
    this.map.clear();
  }

  /** The real per-key pipeline: shared GLTFLoader, Cache API fetch. */
  private async defaultLoadOne(key: string, spec: ModelSpec): Promise<LoadedModel> {
    if (this.loaderPromise === null) {
      this.loaderPromise = createModelLoader();
    }
    const loader = await this.loaderPromise;
    return loadOneModel(loader, key, spec, MODEL_LOAD_TIMEOUT_MS);
  }

  /** One guarded load: bounded concurrency, failure recorded, never throws. */
  private async loadGuarded(key: string, spec: ModelSpec): Promise<LoadedModel | null> {
    const release = await this.semaphore.acquire();
    try {
      const model = await this.loadOne(key, spec);
      if (this.disposed) {
        // Raced with dispose(): drop the fresh model cleanly instead of
        // inserting it into a disposed map. Mark failed so any later
        // request resolves null without retrying a dead store.
        disposeModels(new Map([[key, model]]));
        this.states.set(key, 'failed');
        return null;
      }
      this.map.set(key, model);
      this.states.set(key, 'loaded');
      this.notify([key]);
      return model;
    } catch (error) {
      // 404 / timeout / parse error: record and stay on the fallback,
      // exactly like a boot-time load failure.
      console.warn(`[lazyModels] failed to load "${key}" (fallback in use):`, error);
      this.states.set(key, 'failed');
      return null;
    } finally {
      this.inflight.delete(key);
      release();
    }
  }

  private notify(keys: string[]): void {
    for (const listener of this.listeners) {
      try {
        listener(keys);
      } catch (error) {
        console.warn('[lazyModels] onDidLoad listener threw:', error);
      }
    }
  }
}

/**
 * Read without triggering a lazy load (the store's own resolved-path
 * read). `LazyModelMap.get` fires the miss hook; the store must bypass
 * it when it already knows the state.
 */
function superGet(map: LazyModelMap, key: string): LoadedModel | null {
  return Map.prototype.get.call(map, key) ?? null;
}
