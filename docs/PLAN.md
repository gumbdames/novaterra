# Plan — novaterra

Living plan. Updated whenever reality changes. Last updated: 2026-09-28.

## Vision

A 3D browser game mixing SimCity (city building, economy, civil life), Red Alert
(warfare, skirmish, special ops) and Age of Empires (ages, tech progression).
Modern 2026 setting. You are the President: build cities, run the economy,
advance through ages, wage war — or disable war entirely and play pure builder.
Save/exit/resume, pause, 5 difficulties × 2 AI modes (classic AI vs the
"Muse persona" adaptive AI), 8 missions + skirmish with 8 maps, full air/sea/land
roster, chain of command (mayors, generals, cabinet), deep economy with many
resources and income paths, cheat code for easy mode.

Locked architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Phases

### Phase 0 — Deep research (COMPLETE 2026-09-28)

Four workstreams, all delivered to `docs/research/` with cited sources:

| Workstream | Outcome |
|---|---|
| Tech stack & rendering | three.js pinned (WebGPU primary, WebGL2 fallback), TS 7 strict, Vite 8 + Vitest 3, instancing/LOD/shadow strategy, hybrid art pipeline |
| Sim architecture | Fixed 30 Hz deterministic sim, plain-data state, time-sliced layered pathfinding, spatial hash grid, no WASM/workers in Phase 1, perf budgets as CI tests |
| Audio | Raw Web Audio adaptive stem engine, 32-voice SFX pool, Tallbeard CC0 music primary |
| Game design | 9 pillars, NOVATERRA name (proposed), backstory draft, 8-resource model, 5 ages, 8 missions, 8 skirmish maps, ruthless MVP cut |

### Phase 1 — Core engine + skirmish MVP (APPROVED 2026-09-28; step 1 starting)

The ruthless cut: **one big skirmish map (Meridian Plains), Classic AI levels
1–3, land + air, city building + 5-resource economy, 2 ages, Conquest only,
save/load/pause, cheat `prosperity now`** — the complete core loop, genuinely
fun in 30–60 minute sessions. Build order:

1. Scaffold: Vite + TS strict + pinned three.js, Pages deploy (`/novaterra/` base — repo rename user-confirmed 2026-09-28) via `gh-pages` branch pushes (no Actions workflow — token lacks `workflow` scope; deploys are explicit, verified steps), dev loop — **COMPLETE 2026-09-28** (three 0.186.1, TS 7.0.2, Vite 8.3.1, Vitest 3.2.7; typecheck/test/build green; preview verified serving `/novaterra/`)
2. Render micro-benchmarks on both backends (gating before content scale-up) — **COMPLETE 2026-09-28** (three 0.186.1, TS 7.0.2, Vite 8.3.1, Vitest 3.2.7; harness in `game/src/bench/`: `?bench=1&auto=1&backend=webgpu|webgl2`, 120-frame warm-up + 300-frame measurement per sweep point [100→10000 buildings, 2:1 units], orbiting camera, results as console table + `window.__novaterra_bench` JSON; budget verdict vs ARCHITECTURE.md §6; 27 new unit tests, smoke/typecheck/build green; measured numbers still to be recorded in `docs/research/tech-stack.md` §3 on real hardware) — **counter fix 2026-09-28**: root-caused the zero draws/tris — `renderer.init()` starts three's internal rAF loop, which resets `renderer.info` every frame and raced the manual measurement loop (reset landed between `render()` and the counter read). Fix: `info.autoReset = false` + explicit `info.reset()` before each measured render ⇒ exact per-frame counts on both backends (validated: 8 draws / 5,587 tris per frame on the 100-building point, identical on webgpu and webgl2); verdict made vsync-aware (p95 ≤ 16.7ms + 1.0ms slack counts as within budget, so a healthy 60Hz frame isn't marked OVER)
3. Sim core: tick driver, RNG, world store, commands, digest, snapshot/serialize — **COMPLETE 2026-09-28** (`game/src/sim/`: `rng.ts` mulberry32 + named streams, `world.ts` plain-data store, `tick.ts` 30 Hz accumulator driver, `commands.ts` tick-aligned queue, `digest.ts` FNV-1a state hash, `snapshot.ts` versioned snapshots; 43 new tests, 72/72 green; typecheck/build green)
4. Terrain + Meridian Plains map; spatial hash grid — **COMPLETE 2026-09-28**
   (`game/src/sim/terrain.ts`: deterministic seeded mapgen — 512×512 world
   units, 256×256 heightfield cells, 3-octave value noise + carved river and
   lake, 5th-percentile water level ⇒ ~5% water, 2 spawns on land ≥300 units
   apart; `game/src/sim/spatial.ts`: uniform spatial hash, cell 16, sorted
   queries; `game/src/render/terrain.ts`: 16 chunk meshes + 1 water plane =
   17 draw calls, 131,074 triangles; normal boot now shows the live map.
   23 new tests, 95/95 green; typecheck/build green; AGPL stamps verified.)
5. City building (roads, 3 zones, power/water, 6–8 buildings) + economy tick (Funds, Materials, Fuel, Food, Research) + market/taxes — **COMPLETE 2026-09-28**
   (`game/src/sim/city.ts`: city grid = terrain grid (256×256 cells);
   roads cost 5 Funds + 2 Materials/cell, kept sorted, 4-way connectivity;
   3 zone types (residential/commercial/industrial) painted as rects at
   1 Fund/cell; 8 buildings — House, Apartment, Shop, Research Lab,
   Factory, Farm, Power Plant, Water Pump — with costs, build times
   (10–60 s) and upkeep (Funds/s); placement validates land-only,
   road-adjacency, zone match, no overlap at enqueue AND at apply;
   demolition refunds nothing. `game/src/sim/economy.ts`: economy runs
   once per sim-second — construction → upkeep funding (newest-first
   shutdown on shortfall) → power/water capacity pools allocated in
   building-id order (unpowered ×0.25 output, unwatered ×0.25) →
   production/consumption → food (0.02/pop/s; shortage stalls growth) →
   taxes every 60 s → building levels 1→3 (×1.25/level) → organic growth
   pulses every 10 s (desirability falls with taxes and missing utility
   headroom). Fixed-rate market with ±20% spread (round trips lose value);
   per-zone tax rates 0–100%. Snapshot v2 + city digest. 36 new tests,
   131/131 green; typecheck/build green; AGPL stamps verified. All exact
   numbers are Phase 1 engineering choices, not locked design.)
6. Time-sliced pathfinding + movement; hand-rolled ECS vs apecs measurement — **COMPLETE 2026-09-28**
   (`game/src/sim/units.ts`: stable-id unit store, `civilian` 6 u/s /
   `soldier` 8 u/s placeholders for the step-7 roster, `spawnUnit`;
   `game/src/sim/pathfinding.ts`: deterministic 8-dir A* — octile
   heuristic, corner-cut prevention, water blocking, roads ×0.5,
   cross-component instant fail via memoized land components; capped at
   1000 expansions (≈2.9 ms dev VM) with fallback to chunked reverse-
   Dijkstra flow fields (600 pops/tick ≈ 0.5 ms, early exit at a
   one-cell margin around waiting units); time-sliced FIFO coordinator:
   3 A*/tick + 600 flood pops/tick, ≤2 ms/tick budget;
   `game/src/sim/movement.ts`: pathfinding-then-movement systems per
   tick, A* waypoint following + field following with derived directions
   (argmin forward step cost + neighbor dist), arrival slowdown within
   12 of slot, terrain-following height, spatial-hash separation
   (radius 6, only moving units participate, units inside the slowdown
   radius ignore pushes so separation never deadlocks arrival);
   `moveUnit` / `moveGroup` (formation slots: concentric square rings,
   2.5 apart, one unit per slot — groups arrive as formations, never
   stacked) / `stopUnit`; unreachable destinations fail loudly, unit
   unmoved. Snapshot v3 + digest cover units, queues, fields, partial
   field builds. No JPS: measured A* (0.1–0.7 ms typical) made it
   unnecessary; the ~58 ms full-grid flood the research assumed was
   sub-millisecond is why fields are chunked (see ARCHITECTURE.md §5).
   19 new tests, 150/150 green; typecheck/build green; AGPL stamps
   verified. Hand-rolled ECS vs apecs: units stay a plain spawn-ordered
   array (linear scan "fine until the ECS perf step") — the ECS choice
   itself is still an open measurement for the perf pass in step 12.)
   Deferred from step-6 review (non-blocking; file as work items for step 7
   or the step-12 perf pass): digest doesn't canonically encode active-build
   `waitMark`/`closed`/heap state (snapshot does); `moveGroup` accepts
   duplicate ids; exact-overlap separation skips zero-distance neighbors;
   same-cell `moveUnit` stops silently instead of docking to the exact point;
   `finishFieldBuild` publishes directions for unclosed frontier cells in
   early-exit builds; live `city.roads` is read during multi-tick field
   builds (frozen vs. invalidation semantics TBD).
7. Units (8 land + 3 air) + combat with counters + Classic AI 1–3 — **COMPLETE 2026-09-28** (0.1 Alpha; `game/src/sim/`: `units.ts` 11-unit MVP roster with combat stats, `combat.ts` deterministic resolution with armor/domain counters + HQ aura, `ai.ts` Classic AI cadet/citizen/commander — deterministic, fair via `getVisibleEnemies()`, think cadence 240/120/60 ticks; AI state in `world.ai`, snapshot v4, canonical digest; 16 combat tests + 14 AI tests, 183/183 green; typecheck/build green)
8. Ages (Foundation → Connectivity) + 1 National Program choice — **COMPLETE 2026-09-28** (0.1 Alpha; `game/src/sim/ages.ts`: `AgeState` on `World.ages`, `advanceAge` command with cost validation (3000 funds + 1200 materials), permanent fiberGrid/signalsGrid choice; Fiber Grid ×1.25 tax income, Signals Grid +8 sight; `UnitDef.minAge` — fighter requires Connectivity, gated in `spawnUnit`; AI spawn choices filtered by age (commander falls back to AA); snapshot v4 + digest cover ages; 24 new tests, 207/207 green; typecheck/build green)
9. UI: HUD, camera, selection, orders, advisor, menus, settings
10. Audio v1: adaptive engine + sourced music + SFX pool
11. Save/exit/resume, pause, speed controls, cheat console, IndexedDB
12. Perf pass (budgets as tests), playtest loop, bugfix; write `HOW_TO_PLAY.md` + `GAME_MECHANICS.md`

Exit criteria: fun, bug-free skirmish loop; 60fps mid-range laptop with
thousands of entities; save/resume/pause verified; docs current.

**Step gate:** each numbered step above is complete only after its own tests
pass, the build is green, and all previous steps' smoke tests still pass
(see `AGENTS.md` §2 — no step starts until the previous one is verified).

### Phase 1.5 — Skirmish complete

Navy + sea gameplay, remaining 7 maps (5%→60% water variance), Classic AI
levels 4–5, remaining resources (Goods, Influence, Manpower), ages 3–5.

### Phase 2 — Campaign + Mode 2

8-mission campaign "The First Term" (briefings, objectives, scripted events,
peaceful variants, two endings) + "Muse persona" adaptive AI director
(commentary, taunts, threat meter, dirty tricks) + optional **Live Muse link**
(online: user connects their own API key; strategic digest↔directive protocol;
offline fallback to persona).

### Phase 3 — Depth + polish

Chain-of-command UI (mayors, generals, cabinet — opt-in delegation),
entrepreneurs as agents, advanced economy paths, superweapons (Aegis /
Storm Engine), touch/mobile **only if playtests show it's fun**, accessibility.

## Decisions (resolved with user 2026-09-28)

1. Mode 2 = "Muse persona" adaptive AI director (offline default) + optional
   "Live Muse link" when online (user connects their own Muse API key in
   settings; key in `localStorage` only, never leaves the browser except to
   the API endpoint; strategic-commander protocol that never blocks the tick;
   silent fallback to persona when offline). Offline-first is unconditional.
2. Game name: **NOVATERRA**. Backstory draft adopted.
3. Build order: vertical slice as above — approved.
4. Repo visibility: **public** since 2026-09-28 (user flipped it; was
   private before). GitHub Pages deploys from the `gh-pages` branch.
