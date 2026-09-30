# novaterra

**A 3D city-builder × RTS hybrid for the browser** — build cities and run the
economy, wage war or play skirmishes, and advance your nation through ages of
new technology. Set in the modern world of 2026. You are the President:
found cities, grow the economy, research through the ages, command armies on
land, sea and air — or play a fully peaceful game with war disabled.

**Version:** 0.1 Alpha (this name stays until announced otherwise).

- **Play:** https://gumbdames.github.io/novaterra/ (deploys from `main`)
- **Status:** the grand expansion is underway. Phases 0–4 complete and live,
  plus the desirability/migration workstream (land value, migration,
  library + park), the 3-tab menu restructure (Civilian / Military /
  Management bottom-left menu), and the living menu demo (a seeded world
  plays itself behind the main menu through the real command queue);
  follow-ups queued (menu polish). Phase 4 (transport) delivered road
  classes with in-place upgrades, the rail drag tool, ambient buses/
  trams/ferries over player-placed stops, building variants + size
  tiers, the occupancy line in the selection panel, marinas raising
  nearby land value, and the NaN camera guard. See the live plan:
  [`docs/grand-expansion/PLAN.md`](docs/grand-expansion/PLAN.md).

## What the game has today (0.1 Alpha)

- City building with visible zoning, terrain-following roads, and
  power/water utility networks you drag-paint across the map
- 55 buildings and 30 units across land, sea, and air, with tech ages
- Unit veterancy (Recruit → Elite), a Military Academy, education and civic
  systems, land value and desirability (elevation, shoreline, clean air,
  and nearby libraries/parks/schools/parking/marinas set each block's
  0–100 score; homes pay tax on their land value, people migrate toward
  nicer areas)
- Ambient city life: painted zones auto-pave, and completed homes fill
  the streets with pedestrians and cars — pure decoration, nothing to
  manage
- Transport (Phase 4): four road classes (dirt → highway) with in-place
  upgrades, drag-painted rail, placeable bus/tram/ferry stops with
  ambient vehicles running your routes, building variants + size tiers,
  marinas that raise nearby land value, and the occupancy line
  (residents/workers) in the selection panel
- Missile/fuel logistics: fuel burn, ammo magazines, depots, supply trucks,
  resupply orders, reload-point aura
- 5 Classic AI rivals with per-match personalities, 5 difficulties, skirmish
  maps, deterministic simulation (seeded replays and saves)

## Documentation map

| Doc | What it is |
|---|---|
| [`docs/grand-expansion/PLAN.md`](docs/grand-expansion/PLAN.md) | **The live plan** — 10-phase grand expansion, current statuses |
| [`docs/grand-expansion/RESEARCH.md`](docs/grand-expansion/RESEARCH.md) | Research synthesis behind the plan |
| [`docs/GAME_MECHANICS.md`](docs/GAME_MECHANICS.md) | How the game works (player-facing, kept current) |
| [`docs/HOW_TO_PLAY.md`](docs/HOW_TO_PLAY.md) | Controls and getting started |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Locked architecture |
| [`docs/I18N.md`](docs/I18N.md) | English-only today, structured for later languages |
| [`docs/PLAN.md`](docs/PLAN.md) | Original pre-expansion plan (superseded by the grand-expansion plan) |
| [`docs/research/`](docs/research/) | Research notes from each workstream |

## Repo layout

| Path | What lives here |
|---|---|
| `game/` | The game itself (engine, sim, UI, assets, audio) |
| `game/src/` | TypeScript source, organized by module |
| `game/src/sim/` | Deterministic simulation (economy, combat, AI) |
| `game/src/render/` | Rendering layer (scene, instancing, effects) |
| `game/src/ui/` | HUD, menus, dialogs |
| `game/src/audio/` | Adaptive music + SFX |
| `game/assets/` | Art/audio assets and the asset manifest |
| `game/tests/` | Automated tests (unit + headless sim) |
| `docs/` | Plans, architecture, design docs, player docs |
| `tools/` | Build, map and asset tooling |

## Working conventions

Read `AGENTS.md` before touching anything in this repo. The short version:

- **Docs stay current.** Every `.md`, comment and doc is updated continuously as
  work progresses — research notes, plans, architecture, player docs, **and this
  README** (including the status line and phase statuses above). Every phase
  completion refreshes them; stale status lines are treated as bugs.
- **Quality bar:** no bugs, flowing gameplay, great mechanics, 60fps. Nothing
  ships untested.
- **No secrets in the repo.** Ever. Tokens are used transiently via environment
  variables and never written to disk or committed.
- **Performance is a feature.** The sim is fixed-timestep and decoupled from
  rendering; hot paths are profiled, not guessed.

## License

NOVATERRA is free software: you can redistribute it and/or modify it under the
terms of the **GNU Affero General Public License v3.0 only**, as published by
the Free Software Foundation. See [LICENSE](LICENSE) for the full text.
Copyright (C) 2026 Gumb Dames.

Third-party packages are listed with their licenses in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
