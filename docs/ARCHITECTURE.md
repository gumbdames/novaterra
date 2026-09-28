# Architecture — novaterra

Living document. Locked decisions are dated; when a decision changes, the old
one moves to the Decision Log with its superseded date — history is never
rewritten. Last updated: 2026-09-28 (v1, post-Phase-0-research).

## 1. Principles

1. **The sim is deterministic and decoupled from rendering.** Fixed 30 Hz
   timestep, accumulator pattern (Gaffer-on-Games), render interpolates
   between the last two ticks. No gameplay logic in `render/`; no rendering
   assumptions in `sim/`.
2. **Same-machine determinism** (single-player): identical inputs ⇒ identical
   sim. Buys us replays (command log), save/load integrity (state hash),
   reproducible bugs, testable AI. No cross-machine lockstep needed — IEEE-754
   doubles are fine; fixed-point parked behind a `sim/math.ts` seam.
3. **Plain-data sim state.** Everything the sim owns is serializable plain
   data (no class instances with behavior in hot state) — required for
   snapshots, save/load, and any future worker transport.
4. **Boring technology by default.** Exotic tech only on profiling evidence
   (recorded in `docs/research/`).
5. **Perf budgets are tests.** CI fails when a perf scenario exceeds budget.

## 2. Locked stack (2026-09-28)

| Layer | Choice | Why (one line) |
|---|---|---|
| Rendering | three.js pinned exact (`three@0.186.1`), `three/webgpu` import: **WebGPURenderer primary + automatic WebGL2 fallback**, custom shaders in pure TSL only | One codebase, one scene graph; 15–25% of users get WebGL2 free; mobile tier forces WebGL2 via runtime flag |
| Language | TypeScript 7 strict (`no-explicit-any`, `no-non-null-assertion`) | Deterministic sim needs the strictness; tsgo is fast |
| Build/test | Vite 8 + Vitest 3 | One pipeline; `vite build` emits static assets for GitHub Pages (`/novaterra/` base) |
| Audio | Raw Web Audio, own `audio/` module, no runtime library | Adaptive stem engine needs bespoke lookahead scheduling; Howler/Tone.js rejected (see `docs/research/audio.md`) |
| Music source | Tallbeard "Abstraction" CC0 loop bundle (primary) + re-verified Pixabay cinematic tracks | Content-ID-free for let's-players; ~15–25 MB shipped; licenses in `assets/audio/LICENSES.yml` |
| Save storage | IndexedDB (one compressed Blob per save, single tx) + export/import file fallback | Large late-game saves; `navigator.storage.persist()` |
| WASM | **None in Phase 1** | Evidence: wasm-bindgen slower than JS on our workload shape; no WASM threads on Pages (no COOP/COEP) |
| Threads | Sim single-threaded on main thread (Phase 1); workers only for periphery (audio decode, save serialize, asset load, seeded mapgen before tick 0) | Worker completion order is nondeterministic; clone tax; debugging tax (see Decision Log D3) |

## 3. Module map (`game/src/`)

```
game/src/
  sim/            # deterministic simulation — no DOM, no three.js, no Audio
    tick.ts       # fixed-timestep driver (accumulator, catch-up cap, slow-mo)
    rng.ts        # sim-owned mulberry32; state is part of every snapshot
    math.ts       # seam: float today, fixed-point if ever needed
    world.ts      # entity store: hand-rolled SoA for hot entities
                  # (units/citizens/projectiles), OOP for strategic layer
                  # (cities, mayors, cabinets) — prototype vs apecs first
    commands.ts   # all player/AI input as tick-aligned command structs
    systems/      # movement, combat, economy, growth, diplomacy, ai/ ...
    pathing/      # domain grids + hierarchical A*/JPS + flow fields +
                  # local steering; time-sliced request queue (≤2 ms/tick)
    spatial.ts    # uniform spatial hash grid (rebuilt per tick)
    terrain.ts    # deterministic seeded mapgen: Meridian Plains heightfield,
                  # biomes, water level, spawn placement (regen from seed;
                  # not part of World — see §5)
    digest.ts     # per-tick state hash (save integrity, desync detect, tests)
    serialize.ts  # snapshot <-> SaveFile (versioned, migrated)
  render/         # read-only view of last two sim ticks + alpha; three.js only
    scene.ts renderer.ts instancing.ts terrain.ts effects.ts lod.ts ...
  ui/             # HUD, menus, dialogs, camera, selection, orders, advisor,
                  # session assembly — commands go to sim, never direct mutation
  audio/          # adaptive music engine (lookahead scheduler, stem states
                  # PEACE→TENSION→WAR→VICTORY + MENU/DEFEAT), 32-voice SFX pool
  net_save/       # IndexedDB driver, export/import, save slots UI data
  main.ts         # boot, menu backdrop + menus, wiring (game loop lives in ui/game.ts)
game/tests/
  unit/           # sim logic tests (Vitest, headless)
  sim/            # scripted gameplay scenarios (replays via command log)
  perf/           # perf scenarios; budgets enforced in CI
game/assets/     # art/audio + manifests (LICENSES.yml for audio)
tools/           # map tooling, asset pipeline, balance spreadsheets
```

**Data flow:** `ui` → `commands.ts` (tick-aligned queue) → `sim/tick.ts` →
systems mutate plain-data world → `digest.ts` → snapshot → `render/`
interpolates prev/current with alpha. `audio/` and `ui/` observe sim events;
they never mutate sim state.

## 4. Tick design

- 30 Hz fixed step; accumulator with **catch-up clamped** (max 5 steps, then
  slow-motion + log — never spiral-of-death).
- Inputs (player orders, AI decisions) enter a **tick-aligned command queue**;
  sim consumes whole commands only at tick boundaries.
- Render interpolates entity transforms between tick N−1 and N with alpha;
  UI/HUD reads the latest snapshot.
- Tab hidden ⇒ auto-pause (freeze accumulator; rendering/UI stay alive).
- Pause = freeze accumulator. Save = snapshot at a tick boundary (includes
  RNG state, AI brains, music bar position). Load = verify state hash, then
  resume ticking.

## 5. Key subsystem decisions

- **Pathfinding + movement (step 6, implemented 2026-09-28):** the
  research's layered sketch became concrete code in
  `sim/pathfinding.ts` / `sim/movement.ts` / `sim/units.ts`.
  Deterministic 8-direction A* (octile heuristic, ties by cell index,
  corner-cut prevention — no diagonal may clip a blocked orthogonal
  pair; water blocks, roads cost ×0.5) for single-unit orders; Dijkstra
  flow fields (reverse flood from the destination, chunked at 600 pops/
  tick, early exit once every waiting unit's cell — plus a one-cell
  margin — is reached) for group orders. No JPS: measured A* on the dev
  VM is 0.1–0.7 ms for typical orders and ~2.9 ms at the 1000-expansion
  cap (which falls back to a field instead of blowing the budget); the
  full-grid flood the research assumed was "sub-millisecond" actually
  measures ~58 ms, which is exactly why it is time-sliced. All path
  requests go through a time-sliced FIFO coordinator — 3 A* + 600 flood
  pops per tick, ≤2 ms/tick — so order-spam can never break the frame
  budget; cross-component requests fail instantly (0 expansions) via the
  memoized land-component map. Movement: A* waypoint following with
  per-waypoint arrival cut (2.0), flow-field following that steers by
  derived direction (argmin of forward step cost + neighbor dist — never
  raw dist, which misguides on roads/diagonals), slowdown within 12 of
  the slot, terrain-following height, map clamp, water guard. Group
  orders land units on formation slots (concentric square rings, 2.5
  apart, one unit per slot) so armies arrive as formations, never
  stacked. Separation (radius 6, spatial-hash neighbors, id-ordered push)
  is designed not to fight arrival: only moving units participate, and
  units inside the slowdown radius ignore pushes — separation radius >
  slot spacing would otherwise deadlock docking. Systems run pathfinding
  then movement each tick; snapshot v3 + digest cover units, queues,
  fields and partial field builds. `moveUnit` / `moveGroup` / `stopUnit`
  commands validate at enqueue and at apply; unreachable destinations
  fail loudly with the unit unmoved.
- **Spatial queries:** uniform spatial hash grid (cell 16 world units,
  insert/remove/move, radius + rect queries, results always sorted by entity
  id for determinism). Serves combat, economy, steering, obstacles, render
  culling.
- **Terrain/mapgen (`sim/terrain.ts`):** Meridian Plains is *generated from a
  seed*, not stored — the 256×256 uint16 heightfield (512 world units, 2
  units/vertex) is regenerated identically on every boot and is therefore not
  part of `World` snapshots. Pipeline: 3-octave value noise (named RNG stream
  `terrain`, mulberry32) → carve one N–S river + one lake → set the water
  level at the 5th height percentile (≈5% water, tested 4–6%) → place 2
  spawns on land (nominal (−128,−128)/(128,128), nudged to dry land,
  flattened, ≥300 units apart, tested). Biome per vertex (water bed, shore,
  3 grasses, highland) is a pure function of height + moisture.
  Rendering (`render/terrain.ts`): 4×4 chunk grid, one indexed vertex-colored
  mesh per chunk + one translucent water plane = 17 draw calls, 131,074
  triangles total; chunk meshes share one material. Greedy meshing and
  worker-built terrain remain future optimizations — current totals sit well
  inside the §6 budgets.
- **City + economy (`sim/city.ts`, `sim/economy.ts`):** city grid = terrain
  grid (256×256 cells, 2 world units/cell). Roads: 5 Funds + 2 Materials
  per cell, paved cells kept sorted, 4-way connectivity BFS. Zones
  (residential/commercial/industrial) painted as rects at 1 Fund/cell;
  buildings validate zone match + road adjacency + land-only + no overlap
  at enqueue AND at apply; demolition refunds nothing and frees the
  footprint. 8-building roster (Phase 1): House (2×2, 120₣/40⛏, 10 s,
  0.15₣/s upkeep, 6 pop), Apartment (3×3, 450₣/160⛏, 30 s, 0.7₣/s, 30
  pop), Shop (2×2, 220₣/70⛏, 15 s, 0.4₣/s, +1.2₣/s income), Research Lab
  (2×2, 650₣/220⛏, 45 s, 1.2₣/s, +0.4🔬/s), Factory (3×3, 550₣/220⛏,
  40 s, 1.6₣/s, 0.4⛽→2.5⛏/s), Farm (3×3, 300₣/80⛏, 15 s, 0.6₣/s,
  +3.0🌾/s), Power Plant (3×3, 900₣/350⛏, 60 s, 0.8₣/s, 25 power, burns
  1⛽/s, needs 2 water), Water Pump (2×2, 350₣/120⛏, 20 s, 0.4₣/s,
  25 water, needs 2 power) — all figures Phase 1 engineering choices, not
  locked design. Economy runs once per sim-second inside the tick, fixed
  order per player: construction → upkeep funding (newest-first shutdown
  on shortfall) → power/water capacity pools allocated in building-id
  order (providers must be road-adjacent; unpowered ×0.25 output,
  unwatered ×0.25) → production/consumption (starved inputs = idle) →
  food (0.02/pop/s; shortage stalls growth) → taxes every 60 s
  (rate × taxBase × 60 s, utilities exempt) → building levels 1→3
  (×1.25/level for thriving buildings) → organic growth pulses every
  10 s (desirability 0.55 × tax factor, ×0.25 per missing utility
  headroom; stalled by food shortage). Taxes: per-zone 0–100% rates, the
  player's lever against growth. Market: fixed rates (Materials 2, Fuel 3,
  Food 1, Research 12 Funds) with ±20% spread — a buy-then-sell round trip
  returns 2/3 of funds, so the market is a lever, not free money
  (dynamic pricing deferred). Balance target: a sensible powered city runs
  net-positive on Materials/Food/Research and viable on Funds at moderate
  taxes, while upkeep punishes reckless sprawl (reference city verified in
  tests). Snapshots v2 include full city state; digest covers roads, zones,
  buildings (id order), players, stockpiles, tax rates, population.
- **AI:** Classic AI = decision-quality ladder across 5 levels (Cadet→Legend;
  disclosed handicaps only at extremes). **Mode 2 "Muse persona"** =
  personality-driven adaptive AI director (strategic memory, visible threat
  meter, ~150 event taunts) — a pure function of sim state with serializable
  brain (an LLM in the tick would break determinism, offline play and budget).
  Mode 2 ships in Phase 2; data model reserves the slot in Phase 1.
- **Live Muse link (online option, user-confirmed 2026-09-28):** when the
  player connects their own API key (settings screen; stored in `localStorage`
  only, never leaves the browser except to the API endpoint), the game
  exchanges compact strategic digests (~KB JSON, every 30–60 s) for directives
  + commentary. The model is a **strategic commander only**: it never blocks
  the tick and never mutates sim state directly — local systems execute
  tactically. No key / offline / API error ⇒ silent fallback to the persona
  director. Offline-first is unconditional.
- **Ages/tech:** 5 near-future ages; age-ups are costly commitments with
  landmark-style National Program choices (positive framing: bonuses, never
  lockouts). MVP: 2 ages.
- **Chain of command:** mayors/generals/cabinet are appointed bureaucrats
  with competence stats; all delegation opt-in per function, seize-back
  anytime, intent narrated before irreversible AI acts. Phase 3 UI; Phase 1
  data model reserves the slots.
- **Cheat:** `prosperity now` — typed in the cheat console, single-player
  only, flags the session (disables achievements), documented as the official
  easy mode.

## 6. Rendering strategy (summary)

One `InstancedMesh` per unit/building type per map chunk (chunking = culling
granularity); KTX2/Basis texture atlases; merged static geometry per city
block; greedy-meshed chunked heightmap terrain (built in workers);
**global zoom-tier LOD** (not per-object); 2048² directional shadow map +
instanced blob shadows + baked vertex AO (CSM high-tier only); ACES tone
mapping + bloom (no SSAO/volumetrics); day/night via sun/sky/fog; weather via
fog + GPU rain points. Touch input designed in from day one (tap/command-wheel,
no drag-select); mobile 30fps tier with adaptive quality governor — ships only
if playtests show it's fun (brief's own condition).

Perf budgets (initial; replaced by measured numbers before content scale-up):
draw calls ≤100–200 desktop / ≤60 mobile; tris ≤300k–750k / ≤400k; VRAM
≤256 MB / ≤96 MB; sim tick p95 ≤ 8 ms @30 Hz; pathfinding ≤ 2 ms/tick;
save with no visible hitch; load ≤ 3 s.

## 7. Decision log

| ID | Date | Decision | Rationale | Supersedes |
|---|---|---|---|---|
| D1 | 2026-09-28 | three.js (pinned) WebGPU-primary/WebGL2-fallback | Only option with zero-cost fallback from one codebase; 4–5× community; smallest bundle | — |
| D2 | 2026-09-28 | No WASM in Phase 1 | Measured slower on our workload shape; no threads on Pages; revisit only on ≥3× profiling evidence behind a coarse typed-array API | — |
| D3 | 2026-09-28 | Sim single-threaded on **main thread** for Phase 1 (not in a worker) | Resolves the research tension: sim-arch proved workers hurt determinism/debugging; tech-stack's worker proposal assumed render-jank protection we get cheaper via time-sliced ticks (≤8 ms p95). The sim↔render boundary is already snapshot-based, so moving the sim to a dedicated worker later is a transport change, not an architecture change. Revisit if profiling shows tick overruns. | tech-stack §7 worker split (deferred, not rejected) |
| D4 | 2026-09-28 | Raw Web Audio, no runtime audio lib | Bespoke lookahead scheduling needed; Howler stale (2023), Tone.js fights our scheduler | — |
| D5 | 2026-09-28 | Same-machine determinism; doubles OK | Single-player: no lockstep; fixed-point seam kept in `sim/math.ts` | — |
| D6 | 2026-09-28 | Hand-rolled SoA hot store + OOP strategic layer (prototype vs apecs before committing) | Must own system iteration order for the determinism contract | — |
| D7 | 2026-09-28 | Mode 2 = "Muse persona" adaptive AI director (offline default) | Persona is a pure function of sim state (serializable brain); a model in the tick would break determinism/offline/budget | — |
| D8 | 2026-09-28 | Optional "Live Muse link": user's own API key, digest↔directive protocol, strategic-commander only, silent fallback to persona | User request 2026-09-28; keeps offline-first intact; model never touches the tick, so determinism and offline play are preserved | — |
| D9 | 2026-09-28 | Tick accumulator epsilon (1e-9 ms); named RNG streams | Float subtraction of TICK_MS accumulates ~1e-13 dust per tick — without the epsilon an accumulator holding exactly N ticks' worth of time compares just below TICK_MS and loses a tick (100 ms fed only 2 ticks instead of 3). Named streams (seed = FNV-1a(master, name)) keep subsystems from shifting each other's draws; all stream states live in `world.rng`, so saves capture them | — |
| D10 | 2026-09-28 | Meridian Plains terrain: regen-from-seed, not stored in World | 256×256 uint16 heightfield regenerates identically from the map seed (5th-percentile water level ⇒ ~5% water; 2 spawns on land, ≥300 apart), so snapshots stay small and saves never store terrain. Water level is derived from the generated heights (percentile), not a tuned constant, so reseeds keep the 5% character automatically | — |

## 8. Open questions (carried into Phase 1)

1. Tick rate 30 Hz is proposed, not proven — the perf harness decides.
2. Hand-rolled ECS vs apecs: one afternoon of measurement before committing.
3. WebGPU-vs-WebGL2 default backend: benchmark our real scenes on both, early.
4. Tallbeard loops vs "modern 2026 cinematic" bar: listening test in Phase 1.
5. Mobile tier numbers: verify on physical devices before the tier ships.
6. ~~Game name and Mode-2 confirmation~~ — RESOLVED 2026-09-28: name **NOVATERRA**
   confirmed; backstory draft adopted; Mode 2 = persona director (offline
   default) + optional Live Muse link (online, user's own key).
