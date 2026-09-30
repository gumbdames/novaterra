/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 */

# Lazy model loading — download budget mechanism (Phase 0, workstream 2)

**Status:** implemented (0.1 Alpha) — `game/src/render/lazyModels.ts`,
`game/src/render/models.ts` (Cache-API fetch path), `game/src/ui/game.ts`
(boot region only). Decided 2026-09-30.

## 1. Measurements

Per-key download sizes measured from `game/public/models/` (2026-09-30).
58 keys → 55 unique files (3 keys share files: `rifleman.glb` ×3,
`building-e.glb` ×2 — each key still fetches independently today).

| Key | File | Size |
|---|---|---|
| tank | quaternius/tank-2.glb | 320.2 KiB |
| tankDestroyer | quaternius/tank-1.glb | 266.5 KiB |
| aegisMain | kenney-commercial/building-k.glb | 241.2 KiB |
| lab | kenney-commercial/building-i.glb | 204.8 KiB |
| hq | kenney-car/truck-flat.glb | 202.6 KiB |
| farmBarn | quaternius/farm-barn.glb | 182.9 KiB |
| warFactoryMain | kenney-industrial/building-a.glb | 173.2 KiB |
| hauler | kenney-car/truck.glb | 172.2 KiB |
| apartment | kenney-commercial/building-g.glb | 162.5 KiB |
| university | kenney-commercial/building-f.glb | 145.5 KiB |
| house | kenney-suburban/building-type-f.glb | 135.3 KiB |
| nuclearPlantMain | kenney-industrial/building-f.glb | 131.8 KiB |
| factory / powerPlantMain | kenney-industrial/building-e.glb | 126.4 KiB ×2 |
| rifles / sniperTeam / combatMedic | quaternius/rifleman.glb | 115.1 KiB ×3 |
| engineer | quaternius/engineer.glb | 113.1 KiB |
| shop | kenney-commercial/building-a.glb | 106.4 KiB |
| market | kenney-commercial/building-b.glb | 103.9 KiB |
| barracks | kenney-industrial/building-d.glb | 98.4 KiB |
| transportShip | kenney-watercraft/ship-cargo-a.glb | 95.8 KiB |
| hospital | kenney-commercial/building-d.glb | 92.9 KiB |
| waterPump | kenney-industrial/water-tower.glb | 91.6 KiB |
| solarFarmA / solarFarmB | kenney-industrial/solar-panel-*-group.glb | 79.9 KiB ×2 |
| desalinationHall | kenney-industrial/building-s.glb | 79.3 KiB |
| commandShip | kenney-watercraft/ship-cargo-b.glb | 78.0 KiB |
| recyclingCenter | kenney-industrial/building-i.glb | 72.1 KiB |
| farmSilo | quaternius/farm-silo.glb | 67.6 KiB |
| navalYardHall | kenney-industrial/building-k.glb | 63.9 KiB |
| school | kenney-suburban/building-type-h.glb | 63.8 KiB |
| shipyardCrane | kenney-factory/crane.glb | 52.1 KiB |
| oilRefineryTank | kenney-industrial/detail-tank-large.glb | 46.3 KiB |
| navalYardCrane | kenney-factory/crane-lift.glb | 31.1 KiB |
| industrialTank | kenney-industrial/detail-tank.glb | 30.7 KiB |
| propTreeOldOak | kenney-nature/tree_detailed.glb | 30.7 KiB |
| shipyardMachine | kenney-factory/machine.glb | 25.0 KiB |
| airfieldHangar | kenney-space/hangar_largeA.glb | 24.7 KiB |
| missileBoat | kenney-watercraft/boat-speed-d.glb | 23.0 KiB |
| fishingBoat | kenney-watercraft/boat-fishing-small.glb | 22.4 KiB |
| powerPlantChimney | kenney-industrial/chimney-large.glb | 20.4 KiB |
| spectre | kenney-space/craft_racer.glb | 18.8 KiB |
| awacs | kenney-space/craft_cargoA.glb | 18.5 KiB |
| airfieldHangar2 | kenney-space/hangar_smallA.glb | 18.4 KiB |
| patrolBoat | kenney-watercraft/boat-speed-a.glb | 16.1 KiB |
| propTreePoplar | kenney-nature/tree_plateau.glb | 15.9 KiB |
| industrialStack | kenney-industrial/chimney-medium.glb | 14.7 KiB |
| propTreeOak | kenney-nature/tree_oak.glb | 14.3 KiB |
| radarStation | kenney-space/satelliteDish_large.glb | 13.6 KiB |
| propRockTall | kenney-nature/rock_tallA.glb | 11.8 KiB |
| propTreeBirch | kenney-nature/tree_cone.glb | 10.7 KiB |
| propBushDetailed | kenney-nature/plant_bushDetailed.glb | 9.9 KiB |
| propTreePine | kenney-nature/tree_blocks.glb | 9.9 KiB |
| propRockLarge | kenney-nature/rock_largeA.glb | 7.4 KiB |
| propTreePineTall | kenney-nature/tree_pineTallA.glb | 7.0 KiB |
| propBushLarge | kenney-nature/plant_bushLarge.glb | 6.3 KiB |
| propRockSmall | kenney-nature/rock_smallH.glb | 6.1 KiB |

**Totals (measured):**

| Bucket | Size |
|---|---|
| 58 keys (per-key sum) | 4729.4 KiB ≈ **4.62 MiB** |
| 55 unique files | 4372.7 KiB ≈ 4.27 MiB |
| Kenney colormap textures (6 packs, fetched alongside) | 66.2 KiB |
| Quaternius nature-tree textures | ~820 KiB ≈ 0.80 MiB |
| **Current boot download total** | **≈ 5.48 MiB** (of the 8 MiB gate) |
| **Boot set (28 keys, lazy boot)** | 2657.4 KiB ≈ 2.60 MiB |
| **New boot download total** | **≈ 3.46 MiB** (2.60 + 0.06 + 0.80) |
| Deferred to first use (30 keys) | ≈ 2.02 MiB |
| Projected ~80 new keys (~80 KiB avg, plan §10) | ≈ 6.4 MiB — does NOT fit at boot |

The distribution is heavy-tailed: the 10 largest keys are ~45% of the
bytes. New keys skew smaller than the current average (AD12:
procedural-first infrastructure, art-shared variants, spares-pool
mining before new sourcing).

## 2. Decision: lazy-load on first use (not meshopt compression)

**Chosen: lazy per-key loading.** Boot awaits only the 28-key boot
set (foundation-age unit/building keys + nature props); every other
key loads in the background on first use, with the existing
GLB → procedural → placeholder fallback chain as the loading state.
When a key arrives it lands in the shared model map, so every view
created from then on resolves the real GLB (hot-swap at the
model-resolution layer).

**Rejected: meshopt-style compression via gltf-transform.** Considered
because `docs/research/tech-stack.md` already names it as a future
build-time optimization. Rejected for Phase 0:

1. **It doesn't fix the structural problem.** Even an optimistic 50%
   shrink leaves ~3.2 MiB of new keys against ~2.5 MiB of headroom —
   borderline today, broken again at the next roster addition. Lazy
   loading keeps startup ~constant no matter how large the roster
   grows; the per-session total grows with use, served from cache.
2. **Pipeline cost.** Re-encoding 942 vendored files, bundling the
   meshopt decoder, and preserving the per-file license evidence is a
   heavy build change for a one-time gain. (It composes with lazy
   loading later — compress the long tail *as well* if ever needed.)
3. **gltf-transform isn't installed** and adds a Node build dependency
   the project doesn't otherwise need.

Lazy loading also matches the plan's own framing (§9 Phase 0:
"per-tab/per-age lazy loading and/or gltf-transform optimize") — the
"and/or" is now decided: lazy first, compression optional later.

## 3. How it works

**`game/src/render/lazyModels.ts`** (new):

- `LazyModelStore` owns the caller-owned model map (same contract as
  before: `EntityRenderer` borrows it, `ui/game.ts` disposes it via
  `disposeModels`). Per-key states `idle → loading → loaded | failed`;
  `request()` is idempotent (concurrent requests share one load); at
  most `LAZY_LOAD_CONCURRENCY` (6) simultaneous GLB fetches; failures
  resolve `null`, stay failed for the session (no retry storm), and
  never throw.
- `LazyModelMap extends Map` — the "first use" trigger with zero call
  sites: `get()` on a missing key fires the background request and
  returns `undefined` synchronously, so the renderer (unmodified)
  renders its fallback. Every existing `.get()` call site
  (`entities.ts` view creation, `nature.ts` scatter) becomes a prefetch
  point for free.
- `bootModelKeys()` — the boot policy, pinned by test: keys for all
  14 foundation-age buildings + 11 foundation-age units + 5
  nature props = 28 keys. New roster keys are lazy by DEFAULT; a key
  joins the boot set only if it must be on screen at game start.
- `keysForKind()` / `collectKindKeys()` — kind → key resolution via
  `modelSourceFor` (single source of truth, shared with the renderer).
- `onDidLoad(cb)` — arrival notifications with the arrived keys: the
  payload a future per-view hot-swap hook needs.
- `adopt()` — for externally built models (textured nature trees
  overlay the tree GLB keys without fetching them).

**`game/src/render/models.ts`** — the fetch path now goes through
`cachedFetch` (Cache API `novaterra-models-v1`, same-origin): cache
hit → serve; miss → network fetch + `cache.put` of a clone; write
failures never break the load; no Cache API (Node/tests) → plain
fetch. `loadModels` is refactored onto the shared per-key pipeline
`loadOneModel` (fetch → `parseAsync` → rotY/normalize/yOffset →
extract → surface treatment), so boot and lazy loads share one path
and one contract (never throws, never pends, `{models, failed}`).

**`game/src/ui/game.ts`** (boot region only): `loadEntityModels`
creates the store, awaits the boot set + a kind-scan of the loaded
world (save games / campaign missions pre-request their kinds before
the renderer is built), then overlays the textured trees (or requests
the 6 tree-GLB fallbacks if the texture load failed — previously those
88.5 KiB were downloaded unconditionally and then discarded). The 20s
overall budget and the failure warnings keep their exact shape.

## 4. Requirement coverage

- **(a) Offline-after-first-load.** Every GLB byte passes through
  `cachedFetch`. A key fetched once is served from the Cache API on
  later visits even with no network (pinned by test: cache hit with a
  throwing fetch still resolves). Boot models get this too, since boot
  uses the same pipeline. Known boundary, documented honestly: the 6
  shared Kenney colormap PNGs travel through GLTFLoader's internal
  texture path (browser HTTP cache, warmed at boot), not the Cache
  API — three.js offers no fetch hook there. A future service worker
  for the app shell would close the loop entirely.
- **(b) Deterministic.** Render-side only: the sim never reads the
  store or the map, no RNG is drawn, and load timing/completion order
  never feeds back into sim state. `onDidLoad` listeners must be
  render-side (documented in the module header).
- **(c) No boot regression.** The boot set covers everything a fresh
  game shows in its first minutes (starting forces, foundation
  palette, nature scatter) and is awaited before the first frame
  exactly like the old full load; the 20s budget, failure warnings,
  and empty-map degradation are unchanged. `?bench=1` still calls
  `loadModels(MODEL_PATHS)` directly (all keys, same contract).

## 5. Known limitation: per-view hot-swap

Arrival upgrades the map, so views created *after* arrival get the
GLB. A view created *during* the loading window keeps its fallback
art for its lifetime — upgrading it needs a per-view rebuild hook in
`EntityRenderer`, which is outside this workstream's file ownership
(the render workstream owns `entities.ts`). The window is small in
practice (boot set + save-game scan cover everything visible at
start; later keys are usually requested well before their first view
is built), and the fallback is the designed placeholder art, not a
blank. `onDidLoad` already emits the key list such a hook needs.

## 6. Tests

`game/tests/render.lazyModels.test.ts` (27 tests): boot-set pinning
(exact 28 keys, exclusions, determinism), kind→key resolution,
state transitions (idle→loading→loaded / →failed), request dedupe,
failure-no-retry, unknown keys, concurrency bound, `adopt()`,
dispose semantics (late arrival after dispose is dropped cleanly),
`LazyModelMap` first-use trigger, hot-swap at the resolution layer
(fallback while loading → GLB after arrival, `onDidLoad` payload),
`cachedFetch` (cache reuse, offline-after-first-load, no caching of
errors, write-failure tolerance, no-Cache-API fallback), and
`loadModels`-through-cache (no refetch on second load).
`game/tests/render.models.test.ts` mock updated for the
`parseAsync`+fetch path (22 tests).

Results 2026-09-30: 49/49 green in isolation; `npx tsc --noEmit`
clean; `npm run build` clean (license stamps applied). Full suite:
917/921 — the 4 failures were the sibling render worker's
mid-edit `entities.ts` state (3 instancing tests, since fixed and
green in isolation) and flaky sim-tick perf budgets on a busy VM
(`sim/` untouched by this change; the same tests pass/fail
nondeterministically across runs).

## 7. What changes for later phases

- **New keys are lazy by default.** Phase 1+ model work adds entries
  to `MODEL_PATHS` (+ `MODEL_SOURCES` pieces in `entities.ts`) and
  does nothing else — first use loads them. Only add a key to the boot
  set if it must render in the opening minutes (update the pinned test
  deliberately).
- **Prefetch triggers are the next lever** if the first-use window
  ever shows: palette tab switches and age advancement are the natural
  prefetch points (both outside this workstream's files).
- **Per-view hot-swap** needs the one-method `EntityRenderer` hook
  (§5); `onDidLoad` is the subscription point.
- **Meshopt stays an option** for shrinking the long tail later; it is
  no longer load-bearing for the budget.
- Download-budget accounting for phase plans: startup ≈ 3.5 MiB
  today; a late-game session that touches every key approaches
  ~5.5 MiB + new keys, all cache-served after first fetch.
