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
  NaN camera guard. Phase 5 (airports + airline) and Phase 6 (naval
  expansion + carrier wings) delivered airport zones with their own
  tax rate, civil/military/mixed airports, runways gating aircraft
  class, hangars, paying airline routes, 16 new aircraft, the hangar/
  embark/carrier system (carriers train empty; only carrier-capable
  aircraft may embark), 15 new naval units including the nuclear
  missile sub, 4 ports, deployable naval mines, ambient airliners and
  cargo ships, the v8 snapshot migration, and hangar-aware AI that
  fills carrier wings before sailing. Phase 7 (intel + spies + recon)
  is complete: the intel sim core (asset economy, stealth, sabotage,
  tech steal), the roster (spy, recon team, 4 intel buildings,
  2 upgrades), the Intelligence panel (Management tab), mixed-airport
  discovery (observation → warning with 60-second countdown → reveal
  after 1800 ticks; radar/SIGINT/recon sight wired into AI perception),
  and the Classic AI intel play (virtual intel construction, spy
  training to quota, target-value-directed infiltration/steal/sabotage,
  counter-intel surge). Phase 8 (peaceful mode + tech levels + civilian
  deep-dive) is complete: `world.peaceful` + the def-level `military` predicate lock out all
  war apparatus at the command layer (the AI rival keeps playing
  peacefully), conquest is bypassed, and the builder's victory is
  8,000 housed residents — the skirmish-setup toggle, the hidden
  Military tab, the Management tab's live objectives section, the
  peaceful victory/defeat end screens, and the greyed-out palette
  lockout are all wired. The civilian deep-dive is in too: 99 buildings
  (museum, theater, sports stadium, botanical garden, grand market,
  bank, office tower, clinic, medicalCenter, fire station) and five
  city ordinances on the Management tab — Green Initiative, Transit
  Subsidy, Business Incentives, Nightlife Ordinance, Education Grants —
  each with real upkeep, funded after buildings from the treasury. The
  Mk II/III tech-level pass is in too: 28 variant defs across 14 unit
  lines (96 units total), gated by age + production building through the
  existing spawn validator — the AI trains the best tier it has
  unlocked and can afford, and variants share their base kind's 3D art
  (zero new model downloads). The peaceful AI rival is in too: it
  builds a civilian city (districts → utilities → factories → housing →
  civic), issues zero military orders, and never forms them — the
  `canTrain` gate and the peaceful dispatch (`thinkPeaceful`) keep the
  rival's entire play peaceful. Phase 9 (soak, balance, polish) is
  complete: long AI-vs-AI soaks to game conclusion with usage metrics
  (`game/tests/sim.phase9-longsoak.test.ts`,
  `docs/research/phase9-soak-metrics.md`) fixed an `advanceAge` race
  crash, water-sited forward bases, and the peaceful-AI death spiral,
  and tuned AI mixes (dead roster 82 → 73 kinds); polish fixed
  oversized airport terminals and undersized runway strips.
  See the live plan:
  [`docs/grand-expansion/PLAN.md`](docs/grand-expansion/PLAN.md).

## What the game has today (0.1 Alpha)

- City building with visible zoning, terrain-following roads, and
  power/water utility networks you drag-paint across the map
- 99 buildings and 96 units across land, sea, and air, with tech ages
- City ordinances (Phase 8): five city-wide policies on the Management
  tab — Green Initiative, Transit Subsidy, Business Incentives,
  Nightlife Ordinance, Education Grants — each with real per-second
  upkeep, funded from the treasury after buildings; effects apply only
  while funded
- Peaceful mode (Phase 8, sim core + UI panel in): war disabled by
  design — the full military roster (units, buildings, upgrades,
  covert ops, superweapons) is locked out at the command layer while
  the AI rival keeps playing peacefully beside you; it is a race to
  8,000 housed residents with a solvent treasury (no conquest — but the
  rival can win the race first, which ends the game in defeat)
- Unit veterancy (Recruit → Elite), a Military Academy, education and civic
  systems, land value and desirability (elevation, shoreline, clean air,
  and nearby libraries/parks/schools/museums/stadiums/parking/marinas set each block's
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
- Intel (Phase 7): 4 intel buildings generating surveillance /
  operational / counter-intel assets, the stealthy **Spy** (from the
  Intelligence Headquarters) and the overt **Recon Team**, two lab
  upgrades (Signals Intelligence, Counter-Intelligence) — plus the
  covert-op sim core: infiltrate/sabotage/tech-steal missions,
  detection coverage, burned-spy visibility, radar/SIGINT/recon
  surveillance wired into AI perception, mixed-airport discovery
  (observation → "suspicious military activity" warning with a
  60-second countdown → reveal; a mixed site reads civilian until
  discovered), and the Classic AI intel play (virtual intel
  construction, spy quotas, target-value-directed ops, counter-intel
  surge).
  Art mappings done (Phase 6 workstream 5): all 6 kinds map to vendored
  CC0 — spy as a civilian lookalike, recon SUV, HQ block + roof antenna,
  listening-post hut + roof dish, big uplink dish, signals shed +
  procedural SIGINT mast — lazy-loaded, ~0.58 MiB total, 0 boot impact
- 5 Classic AI rivals with per-match personalities, 5 difficulties, skirmish
  maps, deterministic simulation (seeded replays and saves)
- Destructible buildings and siege warfare: every building has
  structural HP (fragile houses ~200, military plants and superweapon
  bunkers ~1000) shown in the selection panel — right-click an enemy
  building with tanks or artillery selected to shell it to rubble; the
  Storm Engine strike damages buildings in its blast radius and the
  Aegis shield holds damage off yours. Conquest victory needs every
  enemy unit AND every enemy building destroyed

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
