# Plan — awesome-sim-game (working title: NOVATERRA)

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

1. Scaffold: Vite + TS strict + pinned three.js, Pages deploy (`/awesome-sim-game/` base), dev loop, CI
2. Render micro-benchmarks on both backends (gating before content scale-up)
3. Sim core: tick driver, RNG, world store, commands, digest, snapshot/serialize
4. Terrain + Meridian Plains map; spatial hash grid
5. City building (roads, 3 zones, power/water, 6–8 buildings) + economy tick (Funds, Materials, Fuel, Food, Research) + market/taxes
6. Time-sliced pathfinding + movement; hand-rolled ECS vs apecs measurement
7. Units (8 land + 3 air) + combat with counters + Classic AI 1–3
8. Ages (Foundation → Connectivity) + 1 National Program choice
9. UI: HUD, camera, selection, orders, advisor, menus, settings
10. Audio v1: adaptive engine + sourced music + SFX pool
11. Save/exit/resume, pause, speed controls, cheat console, IndexedDB
12. Perf pass (budgets as tests), playtest loop, bugfix; write `HOW_TO_PLAY.md` + `GAME_MECHANICS.md`

Exit criteria: fun, bug-free skirmish loop; 60fps mid-range laptop with
thousands of entities; save/resume/pause verified; docs current.

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
4. Repo visibility: stays **private** for now; user will flip to public if
   needed. At Pages deploy time, verify private-repo Pages works for the org;
   if not, tell the user — it's their call.
