# Architecture — novaterra

Living document. Locked decisions are dated; when a decision changes, the old
one moves to the Decision Log with its superseded date — history is never
rewritten. Last updated: 2026-10-01 (final-review R4: full rewrite to match
the shipped 0.1 Alpha).

> The reversals that shaped this architecture — the 2026-09-29 Live Muse
> API-key rip-out, roads-optional, no-WASM, the commercial-title purge —
> are recorded in [`docs/REVERSALS.md`](REVERSALS.md).

## 1. What the game is

NOVATERRA (0.1 Alpha) is a 3D browser strategy game mixing city-building,
real-time strategy, and empire management, set in the modern world of 2026.
You are the President of a country: found cities, zone land, drag-paint
power/water utility networks, run a multi-resource economy, research through
technology ages, and command armies on land, sea, and air — or play a fully
peaceful no-military mode that never ends.

**Shipped roster (verified in code): 96 units / 99 buildings / 21 upgrades.**
Units: 31 land, 30 air, 35 sea (including 28 Mk II/III tech variants across
14 lines). Buildings span housing, civic, commerce, industry, utilities
(13 power/water plants), logistics (fuel/ammo chain), transport stops,
airports (14 buildings), ports, and intel (4 buildings).

## 2. Principles

1. **The sim is deterministic and decoupled from rendering.** Fixed 30 Hz
   timestep, accumulator pattern, render interpolates between ticks. No
   gameplay logic in `render/`; no rendering assumptions in `sim/`.
2. **Same-machine determinism** (single-player): identical seed + identical
   commands ⇒ identical sim. Buys replays, save/load integrity (state hash),
   reproducible bugs, testable AI. No cross-machine lockstep needed.
3. **Plain-data sim state.** Everything the sim owns is serializable plain
   data — required for snapshots, save/load, and digest hashing.
4. **Boring technology by default.** No WASM anywhere (see REVERSALS.md);
   exotic tech only on profiling evidence recorded in `docs/research/`.
5. **Perf budgets are tests.** `game/tests/perf.budgets.test.ts` fails the
   suite when a perf scenario exceeds budget.
6. **Rejections are loud.** Invalid commands throw `CommandRejectedError`
   with a plain-language reason; nothing fails silently.

## 3. Module map (`game/src/`)

```
game/src/
  sim/            # deterministic simulation — no DOM, no three.js, no Audio,
                  # no wall clock, no Math.random (rng.ts named streams only)
    tick.ts       # 30 Hz fixed-timestep driver (accumulator, catch-up cap)
    rng.ts        # mulberry32 + named streams; stream state in every snapshot
    world.ts      # the World store; owns city: CityState
    city.ts       # city grid, roads, zones, buildings, players, placement
    units.ts      # unit defs (96) + UnitRecord store, spawnUnit
                  # BUILDING_DEFS (99) lives in city.ts
    upgrades.ts   # 21 researchable upgrades + effect hooks
    ages.ts       # 5 technology ages + National Program choices
    variants.ts   # 28 Mk II/III tech-level variants (lazy getter, no new art)
    economy.ts    # 1 Hz economy: construction, upkeep, utilities, taxes, growth
    combat.ts     # deterministic combat; attackBuilding siege orders (R2)
    movement.ts   # path following, formations, separation
    pathfinding.ts# deterministic 8-dir A* + chunked Dijkstra flow fields,
                  # time-sliced coordinator (3 A* + 600 flood pops per tick)
    spatial.ts    # uniform spatial hash grid (rebuilt per tick; R1: combat grid)
    terrain.ts    # seeded mapgen, 8 map presets (regen from seed, not stored)
    utilityNetworks.ts # derived power/water topology (integer-BFS flood fill)
    desirability.ts    # derived 0–100 residential desirability + land value
    intel.ts      # intel asset economy, stealth/detection, covert ops
    veterancy.ts  # Recruit → Regular → Veteran → Elite XP system
    superweapons.ts    # Storm Engine strike + Aegis shield
    ai.ts         # Classic AI: 5 difficulties, seeded personalities, siege
                  # doctrine, intel play, peaceful dispatch
    peaceful.ts   # peaceful-mode status (endless — no victory condition)
    delegation.ts # mayors/generals/cabinet (appointed bureaucrats)
    market.ts     # fixed-rate market price list (leaf module)
    commands.ts   # tick-aligned command queue, { validate, apply } specs
    digest.ts     # FNV-1a canonical state hash (save integrity, tests)
    snapshot.ts   # versioned snapshots (v8; v5/v6/v7 still load)
    cheats.ts     # cheat command specs (issuer: 'cheat')
  render/         # read-only view of the sim; three.js only, never mutates
    renderer.ts   # WebGPURenderer primary + automatic WebGL2 fallback
    entities.ts   # EntityRenderer: syncs world → three.js views
    entityInstancing.ts # per-kind InstancedMesh pools (draw calls scale
                  # with distinct kinds, never entity count)
    models.ts / lazyModels.ts  # 101 CC0 GLB keys; 33-key boot set, rest lazy
    proceduralModels.ts # 37 hand-built gap models + surface treatments
    surfaceTextures.ts / surfaceMaterials.ts # 16 seeded procedural surfaces
    terrain.ts / nature.ts / birds.ts # terrain mesh, nature scatter, wildlife
    roads.ts / rails.ts / networks.ts # road ribbons, rail tracks (R1: wired),
                  # power-line / water-pipe overlays
    utilityOverlay.ts / logisticsOverlay.ts / airportOverlay.ts /
    desirabilityOverlay.ts # toggle-able diagnosis layers
    chevrons.ts   # veterancy chevron billboards (per-instance quaternion)
    cityLife.ts   # ambient pedestrians/cars (render-only, never sim state)
  ui/             # HUD, menus, camera, selection, orders — commands go to
                  # sim, never direct mutation
    game.ts       # game controller: renderer, camera, input, fixed-step loop
    session.ts    # canonical skirmish/campaign/sandbox/peaceful assembly
    hud.ts        # top bar, command menu (icon rail:
                  # Civilian/Military/Management + sub-tabs), selection
                  # detail view, train/build palettes, research panel,
                  # toasts
    menus.ts      # main menu, pause, settings (no API-key flow — see §8)
    palettes.ts   # headless-safe palette data + availability logic
    airports.ts / hangars.ts / intel.ts / logistics.ts / utilities.ts /
    desirability.ts / peaceful.ts # per-system UI contract modules (pure)
    musebox.ts    # Muse widget + threat meter (DOM only, offline persona)
    strings.ts    # all UI copy, English-only (LocalizedString indirection)
    icons.ts      # hand-drawn inline SVG set (icon AND text on buttons)
  audio/          # adaptive music engine (peace/war crossfade) + procedural
                  # SFX synth on raw Web Audio; observes sim, never mutates
  campaign/       # 8-mission "The First Term": mission data, objectives,
                  # director, progress/scoring/endings
  muse/           # offline Muse persona (deterministic lines, threat meter);
                  # live.ts = honest offline "hopefully coming" placeholder
  net_save/       # IndexedDB driver, save slots, version validation
  main.ts         # boot, menu wiring, save-load entry
game/tests/       # 137 files, ~2100 tests — see docs/TESTING.md
game/public/      # static assets: models/ (989 CC0 files), audio/
```

**Data flow:** `ui` → `commands.ts` (tick-aligned queue) → `sim/tick.ts` →
systems mutate plain-data world → `digest.ts` → snapshot → `render/`
interpolates. `audio/` and `ui/` observe sim events; they never mutate sim
state.

## 4. Tick design

- 30 Hz fixed step; accumulator with catch-up clamped (max 5 steps, then
  slow-motion + log — never spiral-of-death). Accumulator epsilon (1e-9 ms)
  guards float-subtraction dust.
- Inputs (player orders, AI decisions) enter a **tick-aligned command queue**;
  every command validates at enqueue AND at apply; stale commands throw
  deterministically.
- Render interpolates entity transforms between tick N−1 and N with alpha;
  UI/HUD reads the latest snapshot.
- Pause = freeze accumulator. Save = snapshot at a tick boundary (includes
  RNG state, AI brains). Load = verify state hash, resume ticking.
- Tab hidden ⇒ the accumulator drops whole ticks by design
  (determinism-safe; a long-hidden tab fast-forwards game time).

## 5. Key subsystem designs

- **Determinism contract:** no wall clock, no `Math.random` in sim — time
  enters only through `tick.step`, randomness only through named RNG streams
  (`rngBank(world).next('economy')` never shifts `'combat'`); stream state
  lives in `world.rng`, part of every snapshot and digest. Fixed system
  registration order; deterministic iteration (spawn order or sorted).
  IEEE-754 doubles are fine on one machine.
- **Pathfinding + movement:** deterministic 8-direction A* (octile heuristic,
  ties by cell index, corner-cut prevention; water blocks, roads cost ×0.5)
  for single-unit orders; chunked Dijkstra flow fields with early exit for
  groups. Time-sliced coordinator: 3 A* + 600 flood pops per tick (≤2 ms).
  Groups arrive on formation slots (concentric square rings); separation
  never fights arrival (only moving units participate; slowdown radius
  exempts pushes).
- **City + economy:** 256×256 city grid (2 world units/cell). Zones painted
  as rects; buildings validate zone + land + no-overlap at enqueue AND
  apply. **Roads are optional** (2026-09-30 user directive — see
  REVERSALS.md): no building or service may require one. Economy runs once
  per sim-second in fixed order: construction → upkeep → utility allocation
  (per-player, per-network flood fill; stranded plants feed an id-ordered
  pool fallback) → production/consumption → food → taxes (0–100% per zone,
  every 60 s) → building levels → organic growth pulses. Fixed-rate market
  (buy-then-sell returns 2/3 — a lever, not free money).
- **Utilities (Phase 2):** integer-BFS flood fill over conductors (roads
  conduct automatically, drag-painted power lines/pipes, substation/pump
  footprints). 13-plant ladder (coal → fusion); substations, pumps,
  batteries; zone hookup; map-edge export; disconnected-vs-shortage
  diagnosis overlay.
- **Logistics (Phase 3):** fuel burn by class, ammo per shot; oil wells/rigs,
  munitions/missile plants, depots; supply trucks with resupply orders;
  logistics overlay (reload-point coverage discs + low-supply rings).
  Sea half (2026-10-01): the cargo-load leg is def-driven — any supply
  unit (sea fuelTanker/ammoShip with materials holds, land trucks) loads
  at a depot; `runMobileSupply` discharges same-domain (sea ships serve
  sea units, honoring refuel/rearm toggles, nuclear exempt); navalBase
  pulls fuel and caches materials; `loadCargo`/`unloadCargo` commands
  (validate≡apply, peaceful-mode rejection); marshal AI trains the
  naval tail via `thinkNavalSupply`.
  Meltdowns are attack-triggered only (user correction 2026-09-30).
- **Transport (Phase 4):** 4 road classes (dirt/country/paved/highway,
  in-place upgrade), drag-painted rail (3 track classes), buses/trams/
  ferries pausing at stops, 7 tiered stops, 5 hubs (marinas raise land
  value), per-building occupancy, grid view (G), underground/x-ray view.
- **Airports + airlines (Phase 5):** airports as paintable zones
  (civil/military/mixed); 14 airport buildings (runways S/M/L gating
  aircraft class, hangars S/M/L, terminals, control tower, fuel farm);
  civilian airlines with paying routes + route arcs. **Hangars:** carriers
  train EMPTY; only 4 carrier-capable kinds may embark (enforced in sim +
  UI); sheltered units skip movement/combat.
- **Navy (Phase 6):** 25 sea kinds incl. nuclear missileSub (fuel-exempt
  per user rule), 4 ports, deployable naval mines, ambient airliners +
  cargo ships.
- **Intel (Phase 7):** intel asset economy (surveillance/operational/
  counter-intel), spies (infiltrate/sabotage/steal-tech), recon teams,
  listening posts/satellite uplink/signals stations, counter-intel defense,
  mixed-airport discovery (suspected → 60 s warning → revealed).
- **Civilian + peaceful (Phase 8):** richer civilian side, 5 city ordinances
  with real upkeep, desirability 0–100 + land-value tiers + migration,
  ambient city life (auto-paved zones, population-scaled pedestrians/cars).
  **Peaceful mode is endless** (2026-10-01): all military defs locked at
  the command layer, the AI rival plays peacefully, no victory or defeat
  screens ever fire — build for as long as you like.
- **Siege + endgame (final-review R2, 2026-10-01):** every building has
  structural HP (fragile houses ~200, military plants ~1000); explicit
  `attackBuilding` siege orders (never auto-fire); sieging units path to a
  passable stand cell beside the footprint. The AI escalates from
  whack-a-mole to base sieges (difficulty-scaled home guard, sticky
  targets), so elimination — and conquest victory/defeat — is reachable.
- **Ages + upgrades:** 5 technology ages with forked National Program
  choices (Fiber Grid ×1.25 tax stacks with Prosperity ×1.5 — wired in
  `runTaxes` per R1); 21 upgrades in 5 groups (Military 8, Economy 4,
  Infrastructure 6, Logistics 1, Intel 2); 28 Mk II/III variants gated by
  age + production building (AI trains the best tier unlocked).
- **Veterancy (Phase 1):** XP on kills → Recruit/Regular/Veteran/Elite
  (+10% damage/sight per level, Elite regen); Military Academy graduates
  armed units to Regular; death erases everything.
- **AI:** Classic AI, 5 difficulties (cadet→marshal) with disclosed
  handicaps at extremes. Seeded per-match personalities (aggression,
  expansion eagerness, ±30% mix jitter) from the `ai-<owner>` RNG stream —
  same seed ⇒ identical play. Fair by construction: perceives only via
  `getVisibleEnemies()` (sight + intel coverage), issues ordinary
  commands through the queue, owns no physical buildings (virtual
  construction with real costs + build times; funds via harvest credit +
  virtual tax stipend — R1). Think cadence 240/120/60/45/30 ticks.
- **Campaign:** 8-mission "The First Term" — briefings, objectives, scripted
  events, two endings (Peacemaker/Commander), every mission peacefully
  completable.
- **Muse:** the offline persona watches and comments (deterministic lines,
  threat meter, chattiness setting). **Live Muse is "hopefully coming" and
  offline-only in 0.1 Alpha** — no API-key flow, no endpoint, no
  networking, zero third-party AI surface (see REVERSALS.md).

## 6. Rendering strategy

- **Per-kind instancing** (Phase 0): one `THREE.InstancedMesh` per model
  pool key — draw calls scale with distinct kinds on screen, never entity
  count. Lazy per-key model loading + Cache-API offline; **33-key pinned
  boot set** (~4.6 MiB GLB) vs the 8 MiB gate; the 101-key CC0 set
  (Kenney + Quaternius + styloo) streams in by tab/age.
- **Art pipeline:** 989 CC0 files in `game/public/models/`
  (see THIRD_PARTY_NOTICES.md); GLB → procedural gap model → placeholder
  resolution per entity; 16 seeded procedural surface textures
  (deterministic DataTextures, zero third-party IP); procedural equirect
  env map so metals shade correctly. Base models are low-poly by
  authorship — textures make materials read, not silhouettes.
  **Entity portraits:** build-time 96px 2.5D thumbnails for all 195 kinds,
  rendered by a deterministic CPU rasterizer over the game's own processed
  geometry (`game/scripts/portrait-atlas.ts`, `npm run portraits`) and
  packed into `game/public/img/entity-atlas.png` (189KB paletted PNG,
  400KB budget) + `.json` manifest for the command-menu cards
  (`src/ui/entityPortraits.ts`); lazy-loaded, zero boot-budget cost
  (see `docs/research/menu-imagery.md`).
- **Overlays** (all digest-keyed, rebuilt only on change): roads, rail
  tracks, power lines/pipes, utility diagnosis, logistics, airports +
  airline arcs, desirability/land-value, zone tints, x-ray, terrain grid.
- **Living world:** ambient pedestrians/cars (population-scaled,
  render-only), 10 bird variants, swaying trees, flowing water — all pure
  functions of (seed, tick), never sim state.
- **Terrain:** 4×4 chunk grid, vertex-colored, 8 seeded map presets
  (5%–60% water); terrain regenerates from the map seed, never stored in
  snapshots.
- three.js r186 pinned exact; WebGPURenderer primary + automatic
  WebGL2 fallback (time-bounded, never hangs boot).

## 7. UI structure

- **Command menu** (bottom-left, rebuilt 2026-10-01): a slim icon rail
  with three tabs, each with sub-tabs — Civilian (**Tools**: road +
  class picker, power-line/water-pipe/rail networks, zone painters,
  demolish; **Build**: Housing/Civic/Commerce/Industry/Utilities/Power/
  Water/Transport/Airports tabs; **Airlines**: routes), Military
  (**Train**: orders help + TRAIN 6 tabs; **Build**: Logistics/
  Naval-Air/Special/Intel tabs; **Superweapons**: Aegis/Storm cards),
  Management (**Taxes / City focus / Cabinet / Ordinances /
  Intelligence / Trade / Research**). Selecting a unit/building shows
  a detail view (Back button, header, stat blocks, action rows).
- Game speed via top-bar pause/1×/2×/4× buttons (no keyboard shortcut).
- Camera: left-drag pan, middle-drag orbit, WASD/arrows, edge pan.
  Right-click orders (gated by the same `canTarget` rules the AI uses).
- **HUD digest registry** (`ui/paletteDigest.ts`): every panel branch
  declares its digest segments; the selection panel rebuilds only on
  digest change (clicks need stable DOM nodes). 15/15 branches covered.
- Saves: IndexedDB slots + autosave every 5 game-minutes; **snapshot v8**
  (v5/v6/v7 still load); saves record the map preset + campaign mission
  so loads regenerate the right terrain (R1). Rejected old saves get a
  plain-language toast, never a raw error.
- English-only, icon+text buttons (user directives).

## 8. Decision log

| ID | Date | Decision | Rationale |
|---|---|---|---|
| D1 | 2026-09-28 | three.js (pinned) WebGPU-primary/WebGL2-fallback | One codebase, zero-cost fallback |
| D2 | 2026-09-28 | No WASM anywhere | Measured slower on our workload; no threads on Pages. See REVERSALS.md |
| D3 | 2026-09-28 | Sim single-threaded on main thread | Workers hurt determinism/debugging; snapshot boundary makes a future move a transport change |
| D4 | 2026-09-28 | Raw Web Audio, no runtime audio lib | Bespoke lookahead scheduling |
| D5 | 2026-09-28 | Same-machine determinism; doubles OK | Single-player; fixed-point seam kept |
| D6 | 2026-09-30 | Per-kind instancing + lazy per-key loading, 33-key boot set | Draw calls scale with kinds; 8 MiB startup gate |
| D7 | 2026-09-29 | Live Muse API-key flow ripped out entirely | User directive ("rip it out entirely"). See REVERSALS.md |
| D8 | 2026-09-30 | Roads optional | User directive: no building or service may require a road. See REVERSALS.md |
| D9 | 2026-09-30 | English-only shipped game, localization indirection kept | User directive; enforced by test |
| D10 | 2026-10-01 | Buildings destructible; AI siege doctrine | Final-review R2: conquest must be reachable |
| D11 | 2026-10-01 | Peaceful mode endless (8000-pop victory removed) | Final-review R2: a race with no racer; build-for-its-own-sake |

Superseded decisions (the Phase-1-era module map, per-chunk instancing,
the 8-building roster, the Live Muse key architecture) were removed in
this rewrite — their history lives in git and in REVERSALS.md.
