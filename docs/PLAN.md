# Plan — awesome-sim-game

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

## Phases

### Phase 0 — Deep research (IN PROGRESS, started 2026-09-28)

Four parallel workstreams, each writing to `docs/research/`:

| Workstream | Owner focus | Output |
|---|---|---|
| Tech stack & rendering | Engine choice, perf budgets, art pipeline | `docs/research/tech-stack.md` |
| Sim architecture | Determinism, save/load, pathfinding, WASM | `docs/research/sim-architecture.md` |
| Audio | Adaptive music, SFX, sourcing | `docs/research/audio.md` |
| Game design | Pillars, economy, ages, missions, backstory, name | `docs/research/game-design.md` |

Exit criteria: firm, cited recommendations for engine, sim architecture, audio
approach and the design pillars; open questions listed with owners.

### Phase 1 — Core engine + skirmish (not started)

- Project scaffold, build, dev loop, GitHub Pages deploy
- Fixed-timestep deterministic sim: terrain, resources, city building, economy tick
- Ages/tech progression, unit roster (land/sea/air, civil + military, special ops)
- Combat, pathfinding, AI (classic mode) + Muse-persona AI framework
- Skirmish mode: map framework + 8 maps (big, varied water), win/lose, difficulty levels
- Save/load/resume, pause, settings, cheat code
- HUD/UI, camera, selection, orders; adaptive music + SFX v1
- Player docs: `HOW_TO_PLAY.md`, `GAME_MECHANICS.md` (written alongside)

Exit criteria: fun, bug-free skirmish loop on at least 2 maps; 60fps with
thousands of entities; save/resume/pause verified.

### Phase 2 — Missions (not started)

8 story missions with briefing/debriefing, objectives, scripted events, backstory
woven in. Peaceful-builder variants where requested.

### Phase 3 — Depth + polish (not started)

Chain of command (mayors, generals, cabinet) delegation UX, entrepreneurs,
advanced economy paths, touch/mobile support **only if playtests show it's fun**,
accessibility, localization groundwork.

## Open questions

- Mode 2 "play against Muse": live opponent is infeasible in an offline browser
  game → designing the "Muse persona" adaptive AI instead (user to confirm).
- Build order within Phase 1 (engine-first vs vertical slice) — leaning
  vertical slice: one map, full loop, then expand.
- Game name + final backstory — design workstream to propose options.
