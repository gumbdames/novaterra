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
 * Tests for render/lazyModels.ts — lazy per-key model loading — and for
 * the Cache-API fetch layer in render/models.ts (`cachedFetch`).
 *
 * Contract under test:
 *  - Loading-state transitions: idle → loading → loaded, and
 *    idle → loading → failed (failure resolves null, stays failed, never
 *    retries, never throws).
 *  - First use triggers the load: a `LazyModelMap.get()` miss fires the
 *    background request and returns undefined synchronously (the caller
 *    renders its fallback).
 *  - Hot-swap on arrival: once the key lands in the map, the same
 *    resolution the renderer performs serves the GLB; `onDidLoad`
 *    notifies subscribers with the arrived keys.
 *  - Cache reuse: `cachedFetch` serves a once-fetched URL from the Cache
 *    API without hitting the network again — including when the network
 *    is down (offline-after-first-load).
 *  - The boot set is exactly the foundation-age + nature-prop keys:
 *    pinned explicitly so growing the boot set is a deliberate choice.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';

import {
  MODEL_PATHS,
  cachedFetch,
  loadModels,
  type LoadedModel,
  type ModelSpec,
} from '../src/render/models';
import {
  LazyModelMap,
  LazyModelStore,
  bootModelKeys,
  collectKindKeys,
  keysForKind,
  TREE_MODEL_KEYS,
} from '../src/render/lazyModels';
import { modelSourceFor } from '../src/render/entities';

// ---------------------------------------------------------------------------
// Mock GLTFLoader for the Cache-API integration test (loadModels end to
// end through cachedFetch). Each test file gets its own module registry,
// so this does not clash with render.models.test.ts.
// ---------------------------------------------------------------------------

vi.mock('three/addons/loaders/GLTFLoader.js', () => {
  class FakeGLTFLoader {
    async parseAsync(): Promise<{ scene: THREE.Object3D }> {
      return { scene: new THREE.Group() };
    }
  }
  return { GLTFLoader: FakeGLTFLoader };
});

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Controllable promise for driving load timing precisely. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Minimal fake LoadedModel (geometry/material disposal is real). */
function makeModel(): LoadedModel {
  return {
    geometries: [new THREE.BoxGeometry(1, 1, 1)],
    materials: [new THREE.MeshStandardMaterial({ color: 0xffffff })],
  };
}

function spec(path = 'a.glb'): ModelSpec {
  return { path, scale: 1 };
}

/** Map-backed fake CacheStorage for cachedFetch tests. */
function makeFakeCaches(): {
  api: {
    open(name: string): Promise<{
      match(url: string): Promise<Response | undefined>;
      put(url: string, res: Response): Promise<void>;
    }>;
  };
  store: Map<string, Map<string, Response>>;
} {
  const store = new Map<string, Map<string, Response>>();
  const api = {
    open: async (name: string) => {
      let bucket = store.get(name);
      if (bucket === undefined) {
        bucket = new Map();
        store.set(name, bucket);
      }
      return {
        match: async (url: string) => bucket.get(url),
        put: async (url: string, res: Response) => {
          bucket.set(url, res);
        },
      };
    },
  };
  return { api, store };
}

// ---------------------------------------------------------------------------
// keysForKind / collectKindKeys / bootModelKeys
// ---------------------------------------------------------------------------

describe('kind → key resolution', () => {
  it('resolves 1:1 kinds to their own key', () => {
    expect(keysForKind('tank')).toEqual(['tank']);
    expect(keysForKind('rifles')).toEqual(['rifles']);
  });

  it('resolves composite buildings to all piece keys', () => {
    expect(keysForKind('farm')).toEqual(['farmBarn', 'farmSilo']);
    expect(keysForKind('oilRefinery')).toEqual([
      'oilRefineryTank',
      'industrialTank',
      'industrialStack',
    ]);
  });

  it('resolves procedural/placeholder/unknown kinds to no keys', () => {
    expect(keysForKind('artillery')).toEqual([]); // procedural
    expect(keysForKind('definitelyNotAKind')).toEqual([]);
  });

  it('collectKindKeys deduplicates shared keys across kinds', () => {
    // farm's two piece keys appear once even when requested twice.
    expect(collectKindKeys(['farm', 'farm'])).toEqual(['farmBarn', 'farmSilo']);
    // sniperTeam/combatMedic/rifles share one FILE but are distinct keys.
    expect(collectKindKeys(['rifles', 'sniperTeam', 'combatMedic'])).toEqual([
      'rifles',
      'sniperTeam',
      'combatMedic',
    ]);
  });
});

describe('bootModelKeys', () => {
  /** The pinned boot set: 28 keys. Growing this list costs startup
   * download, so it changes only deliberately (update this test too). */
  const EXPECTED_BOOT_KEYS = [
    // foundation-age units (1:1 keys)
    'engineer',
    'rifles',
    'tank',
    'hauler',
    'spectre',
    'hq',
    'fishingBoat',
    // foundation-age buildings
    'house',
    'apartment',
    'shop',
    'lab',
    'factory',
    'waterPump',
    'barracks',
    'school',
    // farm / powerPlant / shipyard / warFactory composite pieces
    'farmBarn',
    'farmSilo',
    'powerPlantMain',
    'powerPlantChimney',
    'shipyardCrane',
    'shipyardMachine',
    'warFactoryMain',
    'industrialStack',
    // nature scatter props (trees excepted — textured-tree fallback)
    'propRockLarge',
    'propRockTall',
    'propRockSmall',
    'propBushDetailed',
    'propBushLarge',
  ];

  it('is exactly the pinned 28-key boot set', () => {
    const keys = bootModelKeys();
    expect(keys).toHaveLength(EXPECTED_BOOT_KEYS.length);
    expect(new Set(keys)).toEqual(new Set(EXPECTED_BOOT_KEYS));
  });

  it('every boot key is a real MODEL_PATHS entry', () => {
    for (const key of bootModelKeys()) {
      expect(MODEL_PATHS[key]).toBeDefined();
    }
  });

  it('excludes later-age keys and the tree GLB fallbacks', () => {
    const keys = new Set(bootModelKeys());
    for (const late of [
      'tankDestroyer',
      'missileBoat',
      'awacs',
      'apc',
      'carrier',
      'aegisMain',
      'nuclearPlantMain',
      'airfieldHangar',
      'radarStation',
      'hospital',
    ]) {
      expect(keys.has(late)).toBe(false);
    }
    for (const tree of TREE_MODEL_KEYS) {
      expect(keys.has(tree)).toBe(false);
    }
    expect(TREE_MODEL_KEYS).toHaveLength(6);
  });

  it('is deterministic: identical across calls', () => {
    expect(bootModelKeys()).toEqual(bootModelKeys());
  });
});

// ---------------------------------------------------------------------------
// LazyModelStore: states, dedupe, failure, adopt, dispose
// ---------------------------------------------------------------------------

describe('LazyModelStore loading states', () => {
  it('transitions idle → loading → loaded, sharing one load', async () => {
    const gate = deferred<LoadedModel>();
    let calls = 0;
    const store = new LazyModelStore(
      { a: spec() },
      {
        loadOne: async () => {
          calls += 1;
          return gate.promise;
        },
      },
    );
    expect(store.status('a')).toBe('idle');
    const p1 = store.request('a');
    const p2 = store.request('a');
    expect(store.status('a')).toBe('loading');
    await Promise.resolve();
    expect(calls).toBe(1); // concurrent requests share one load
    gate.resolve(makeModel());
    const [m1, m2] = await Promise.all([p1, p2]);
    expect(m1).not.toBeNull();
    expect(m2).toBe(m1);
    expect(store.status('a')).toBe('loaded');
    expect(store.map.get('a')).toBe(m1);
    // A later request resolves immediately without reloading.
    expect(await store.request('a')).toBe(m1);
    expect(calls).toBe(1);
  });

  it('failure resolves null, stays failed, never retries, never throws', async () => {
    let calls = 0;
    const store = new LazyModelStore(
      { a: spec(), b: spec('b.glb') },
      {
        loadOne: async (key) => {
          calls += 1;
          if (key === 'a') throw new Error('404');
          return makeModel();
        },
      },
    );
    await expect(store.request('a')).resolves.toBeNull();
    expect(store.status('a')).toBe('failed');
    expect(store.map.get('a')).toBeUndefined();
    // No retry storm: a second request resolves null without reloading.
    await expect(store.request('a')).resolves.toBeNull();
    expect(calls).toBe(1);
    // Other keys are unaffected.
    expect(await store.request('b')).not.toBeNull();
    expect(store.status('b')).toBe('loaded');
  });

  it('unknown keys resolve null without calling the loader', async () => {
    let calls = 0;
    const store = new LazyModelStore(
      { a: spec() },
      {
        loadOne: async () => {
          calls += 1;
          return makeModel();
        },
      },
    );
    await expect(store.request('nope')).resolves.toBeNull();
    expect(store.status('nope')).toBe('failed');
    expect(calls).toBe(0);
  });

  it('requestMany aligns results with input order', async () => {
    const store = new LazyModelStore(
      { a: spec(), b: spec('b.glb') },
      { loadOne: async () => makeModel() },
    );
    const [a, b] = await store.requestMany(['a', 'b']);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('bounds concurrent loads', async () => {
    const gates = [deferred<LoadedModel>(), deferred<LoadedModel>(), deferred<LoadedModel>()];
    let active = 0;
    let maxActive = 0;
    const store = new LazyModelStore(
      { a: spec(), b: spec('b.glb'), c: spec('c.glb') },
      {
        concurrency: 2,
        loadOne: async (key) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            const gate = gates[key === 'a' ? 0 : key === 'b' ? 1 : 2];
            if (gate === undefined) throw new Error('test setup: bad key');
            return await gate.promise;
          } finally {
            active -= 1;
          }
        },
      },
    );
    const all = store.requestMany(['a', 'b', 'c']);
    await Promise.resolve();
    await Promise.resolve();
    expect(maxActive).toBeLessThanOrEqual(2);
    for (const g of gates) g.resolve(makeModel());
    await all;
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(store.status('c')).toBe('loaded');
  });

  it('adopt() marks a key loaded without fetching', async () => {
    let calls = 0;
    const store = new LazyModelStore(
      { propTreeOak: spec() },
      {
        loadOne: async () => {
          calls += 1;
          return makeModel();
        },
      },
    );
    const trees = makeModel();
    store.adopt('propTreeOak', trees);
    expect(store.status('propTreeOak')).toBe('loaded');
    expect(await store.request('propTreeOak')).toBe(trees);
    expect(calls).toBe(0);
  });

  it('loadBootSet loads exactly the boot keys and reports failures', async () => {
    const seen: string[] = [];
    const store = new LazyModelStore(MODEL_PATHS, {
      loadOne: async (key) => {
        seen.push(key);
        if (key === 'tank') throw new Error('boom');
        return makeModel();
      },
    });
    const { loaded, failed } = await store.loadBootSet();
    expect(new Set(seen)).toEqual(new Set(bootModelKeys()));
    expect(failed).toEqual(['tank']);
    expect(loaded).toBe(bootModelKeys().length - 1);
    expect(store.stats().loaded).toBe(bootModelKeys().length - 1);
    expect(store.stats().failed).toBe(1);
  });

  it('dispose() releases the map; in-flight arrivals are dropped cleanly', async () => {
    const gate = deferred<LoadedModel>();
    const store = new LazyModelStore(
      { a: spec() },
      { loadOne: () => gate.promise },
    );
    const adopted = makeModel();
    const adoptedGeo = adopted.geometries[0];
    if (adoptedGeo === undefined) throw new Error('test setup: no geometry');
    const disposeSpy = vi.spyOn(adoptedGeo, 'dispose');
    store.adopt('adopted', adopted);

    const pending = store.request('a');
    store.dispose();
    const late = makeModel();
    const lateGeo = late.geometries[0];
    if (lateGeo === undefined) throw new Error('test setup: no geometry');
    const lateDisposeSpy = vi.spyOn(lateGeo, 'dispose');
    gate.resolve(late);
    await expect(pending).resolves.toBeNull();
    // Adopted model released, late arrival disposed instead of inserted.
    expect(disposeSpy).toHaveBeenCalled();
    expect(lateDisposeSpy).toHaveBeenCalled();
    expect(store.map.has('a')).toBe(false);
  });
});

describe('LazyModelMap first-use trigger', () => {
  it('a get() miss fires the background request and returns undefined', async () => {
    let calls = 0;
    const store = new LazyModelStore(
      { a: spec() },
      {
        loadOne: async () => {
          calls += 1;
          return makeModel();
        },
      },
    );
    // Synchronous miss: the caller renders its fallback right away.
    expect(store.map.get('a')).toBeUndefined();
    expect(store.status('a')).toBe('loading');
    await Promise.resolve();
    expect(calls).toBe(1);
    // Once loaded, get() serves the model with no further requests.
    await store.request('a');
    expect(store.map.get('a')).not.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('a get() miss on a failed key does not re-request', async () => {
    let calls = 0;
    const store = new LazyModelStore(
      { a: spec() },
      {
        loadOne: async () => {
          calls += 1;
          throw new Error('404');
        },
      },
    );
    expect(store.map.get('a')).toBeUndefined();
    await store.request('a');
    expect(calls).toBe(1);
    expect(store.map.get('a')).toBeUndefined();
    expect(calls).toBe(1);
  });

  it('works as a plain Map for set/has/iteration (disposeModels path)', () => {
    const store = new LazyModelStore({ a: spec() }, { loadOne: async () => makeModel() });
    const m = makeModel();
    store.map.set('x', m);
    expect(store.map.has('x')).toBe(true);
    expect(store.map.get('x')).toBe(m);
    expect([...store.map.values()]).toContain(m);
  });
});

describe('hot-swap on arrival (model-resolution layer)', () => {
  /**
   * Mirrors what `EntityRenderer.createModelGroup` does with the map:
   * a GLB kind resolves when all its piece keys are present, otherwise
   * the caller renders the procedural/placeholder fallback.
   */
  function resolveKind(map: LazyModelMap, kind: string): 'glb' | 'fallback' {
    const source = modelSourceFor(kind);
    if (source.type !== 'glb') return 'fallback';
    const ok = source.pieces.every((p) => map.get(p.key) !== undefined);
    return ok ? 'glb' : 'fallback';
  }

  it('fallback while loading, GLB once the key arrives', async () => {
    const gate = deferred<LoadedModel>();
    const store = new LazyModelStore(
      { tankDestroyer: { path: 'tank-1.glb', scale: 0.2 } },
      { loadOne: () => gate.promise },
    );
    const arrived: string[][] = [];
    const unsubscribe = store.onDidLoad((keys) => arrived.push(keys));

    // First use: miss → background request, fallback renders.
    expect(resolveKind(store.map, 'tankDestroyer')).toBe('fallback');
    expect(store.status('tankDestroyer')).toBe('loading');
    // Still loading: still the fallback (never a hang, never a blank).
    expect(resolveKind(store.map, 'tankDestroyer')).toBe('fallback');

    gate.resolve(makeModel());
    await store.request('tankDestroyer');
    // Hot-swap at the resolution layer: new views get the GLB.
    expect(resolveKind(store.map, 'tankDestroyer')).toBe('glb');
    expect(arrived).toEqual([['tankDestroyer']]);

    unsubscribe();
    // A late second arrival for another key would not notify again —
    // (covered implicitly: only one load ever ran for this key).
    expect(store.status('tankDestroyer')).toBe('loaded');
  });

  it('onDidLoad listener exceptions do not break other listeners', async () => {
    const store = new LazyModelStore(
      { a: spec() },
      { loadOne: async () => makeModel() },
    );
    const seen: string[] = [];
    store.onDidLoad(() => {
      throw new Error('listener bug');
    });
    store.onDidLoad((keys) => seen.push(...keys));
    await store.request('a');
    expect(seen).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// cachedFetch: Cache API behavior incl. offline-after-first-load
// ---------------------------------------------------------------------------

describe('cachedFetch', () => {
  it('fetches once, then serves from the cache without network', async () => {
    const { api } = makeFakeCaches();
    vi.stubGlobal('caches', api);
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls += 1;
        return new Response(new ArrayBuffer(8), { status: 200 });
      }),
    );
    const first = await cachedFetch('https://x.test/models/a.glb');
    expect(first.ok).toBe(true);
    expect(fetchCalls).toBe(1);
    // Drain the body the way a loader would.
    expect((await first.arrayBuffer()).byteLength).toBe(8);
    const second = await cachedFetch('https://x.test/models/a.glb');
    expect(fetchCalls).toBe(1); // cache hit: no second network fetch
    expect((await second.arrayBuffer()).byteLength).toBe(8);
  });

  it('serves the cached key when the network is down (offline after first load)', async () => {
    const { api } = makeFakeCaches();
    vi.stubGlobal('caches', api);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })),
    );
    await cachedFetch('https://x.test/models/a.glb');
    // Network dies; the cache still answers.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const res = await cachedFetch('https://x.test/models/a.glb');
    expect(res.ok).toBe(true);
    expect((await res.arrayBuffer()).byteLength).toBe(8);
  });

  it('does not cache error responses', async () => {
    const { api, store } = makeFakeCaches();
    vi.stubGlobal('caches', api);
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls += 1;
        return new Response('nope', { status: 404 });
      }),
    );
    const first = await cachedFetch('https://x.test/models/missing.glb');
    expect(first.ok).toBe(false);
    await cachedFetch('https://x.test/models/missing.glb');
    expect(fetchCalls).toBe(2); // not cached: fetched again
    expect(store.get('novaterra-models-v1')?.size ?? 0).toBe(0);
  });

  it('a cache write failure never breaks the load', async () => {
    const failing = {
      open: async () => ({
        match: async () => undefined,
        put: async () => {
          throw new Error('quota exceeded');
        },
      }),
    };
    vi.stubGlobal('caches', failing);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ArrayBuffer(8), { status: 200 })),
    );
    const res = await cachedFetch('https://x.test/models/a.glb');
    expect(res.ok).toBe(true);
    expect((await res.arrayBuffer()).byteLength).toBe(8);
  });

  it('falls back to plain fetch where the Cache API is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls += 1;
        return new Response(new ArrayBuffer(8), { status: 200 });
      }),
    );
    const res = await cachedFetch('https://x.test/models/a.glb');
    expect(res.ok).toBe(true);
    expect(fetchCalls).toBe(1);
  });
});

describe('loadModels through the Cache API', () => {
  it('second load of the same key is served from cache (no refetch)', async () => {
    const { api } = makeFakeCaches();
    vi.stubGlobal('caches', api);
    let fetchCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        fetchCalls += 1;
        return new Response(new ArrayBuffer(16), { status: 200 });
      }),
    );
    const paths = { tank: { path: 'tank.glb', scale: 1 } };
    const first = await loadModels(paths, { timeoutMs: 1000 });
    expect(first.models.has('tank')).toBe(true);
    expect(first.failed).toEqual([]);
    expect(fetchCalls).toBe(1);
    const second = await loadModels(paths, { timeoutMs: 1000 });
    expect(second.models.has('tank')).toBe(true);
    expect(fetchCalls).toBe(1); // GLB bytes came from the Cache API
  });
});
