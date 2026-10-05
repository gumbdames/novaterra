# novaterra

**A 3D city-builder × RTS hybrid for the browser** — build cities and run the
economy, wage war or play skirmishes, and advance your nation through ages of
new technology. Set in the modern world of 2026. You are the President:
found cities, grow the economy, research through the ages, command armies on
land, sea and air — or play a fully peaceful game with war disabled.

**Version:** 0.1 Alpha (this name stays until announced otherwise).

- **Play:** https://gumbdames.github.io/novaterra/ (deploys from `main`)
- **Status:** Final comprehensive review and release polish complete. Full RTS
  command suite (Control Groups 1–9 with double-tap camera focus, double-click
  type selection on screen, Attack-Move advance mode, and Generals in Cabinet
  with theatre assignments — Northern, Southern, Naval, Central — supported
  in the sim; player UI for assigning theatres is not in 0.1 Alpha yet).
  Dual AI Modes
  (Mode 1 Classic Engine vs Mode 2 Muse Engine with live tactical
  taunts, commentary, and dialogue across all 5 difficulties). AAA visual polish
  (cinematic war room holographic menu hero backdrop, 8 mission briefing tactical
  reconnaissance maps, 8 skirmish preview cards (maps 1–3 high-resolution
  art, maps 4–8 procedural terrain thumbnails), realistic Muse
  advisor portrait). Audio overhaul (punchy multi-layered weapon concussion & shockwave
  rumble, plus tactical radio mic clicks, affirmative chirps, and under-fire squelches).
  The entire grand expansion is live and fully verified across all 103 units, 100
  buildings, 8 missions, 8 skirmish maps, and 5 ages. Phase 7 (intel + spies + recon)
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
  peacefully), conquest is bypassed, and peaceful mode is endless
  (2026-10-01) — no victory condition, no end screen, just build —
  the skirmish-setup toggle, the hidden Military tab, the Management
  tab's live status section, and the greyed-out palette lockout are
  all wired. The civilian deep-dive is in too: 100 buildings
  (museum, theater, sports stadium, botanical garden, grand market,
  bank, office tower, clinic, medicalCenter, fire station) and five
  city ordinances on the Management tab — Green Initiative, Transit
  Subsidy, Business Incentives, Nightlife Ordinance, Education Grants —
  each with real upkeep, funded after buildings from the treasury. The
  Mk II/III tech-level pass is in too: 28 variant defs across 14 unit
  lines, gated by age + production building through the
  existing spawn validator — the AI picks the tier that fits the situation
  (each variant trades something away: firepower for speed, range for
  armor, etc.), and variants share their base kind's 3D art
  (zero new model downloads). The roster is 103 units total. The peaceful AI rival is in too: it
  builds a civilian city (districts → utilities → factories → housing →
  civic), issues zero military orders, and never forms them — the
  `canTrain` gate and the peaceful dispatch (`thinkPeaceful`) keep the
  rival's entire play peaceful. Phase 9 (soak, balance, polish) is
  complete: long AI-vs-AI soaks to game conclusion with usage metrics
  (`game/tests/sim.phase9-longsoak.test.ts`,
  `docs/research/phase9-soak-metrics.md`) fixed an `advanceAge` race
  crash, water-sited forward bases, and the peaceful-AI death spiral,
  and tuned AI mixes (dead roster 82 → 73 kinds); polish fixed
  oversized airport terminals and undersized runway strips. The
  final-review feel pass (2026-10-01) is in too: Mk II/III variants are
  tactical tradeoffs (not stat ladders), blob shadows + ACES tone mapping,
  three procedural civilian models (sports stadium, botanical garden,
  fire station), duplicate-coalescing toast notifications, the Storm tool
  firing at the drag-release point, the Marshal AI aiming its Storm at
  the largest visible enemy cluster, and **Emergency refuel** for
  stranded fossil-fuel aircraft (+30% tank for 150 funds, airdropped —
  Resupply can't reach an aircraft that can't fly to a depot).
  Civilian sea trade (Half A, 2026-10-01) is in too: the
  **Civilian Shipyard** (Industry age — builds and repairs civilian
  ships: the cargo freighter and the new fuel barge; reloads ships,
  stores fuel) plus civilian **trade docks** (Commercial Docks,
  Container Port, Fishing Harbor) and **sea-trade routes** like the
  airline system (500 funds to establish dock-to-dock — the no-blur
  rule, routes never anchor at the shipyard; funds / materials / fuel
  policies; ships sail the route automatically). The peaceful AI builds
  a shipyard and two docks, establishes a funds route, and assigns
  freighters on its own. The military half wired the naval supply chain the docs had
  promised, under the naval-building model (2026-10-01): the
  **Naval Shipyard** (renamed from Shipyard) builds and repairs
  light/support ships, the **Naval Yard** keeps the heavy warships,
  and the **Naval Base** is the military dock. The fuel tanker (400
  fuel + 200 materials) and ammo ship (80 shells + 100 materials)
  load only at military naval points — one side per dock, so civilian
  hulls can never draw military stocks and vice versa — and serve
  friendly ships at sea; the naval base pulls fuel and caches
  materials forward, Load/Unload orders move cargo by hand, damaged
  ships at a friendly yard show **Under repair** while the drydock
  works, and the marshal AI builds its own naval base and loads its
  supply tail from it.
  The scripted gameplay trailer (2026-10-01) is in too: `?trailer=1`
  plays a deterministic ~4-minute in-game movie — a real skirmish vs a
  cadet AI with title cards and a scripted camera — recorded straight
  to a downloadable `.webm` (see `docs/trailer.md`).
  Exploration bet C6 (2026-10-02) is in too: illustrated victory/defeat
  end screens — six AI-generated illustrations (one per victory kind +
  annihilation vs lost-the-race defeat), lazy-loaded so they never enter
  the boot payload, with a slow cinematic camera drift over the final
  battlefield while the overlay is up (your camera is restored exactly
  on dismiss). Provenance in `THIRD_PARTY_NOTICES.md`.
  Exploration bet C7 (2026-10-02) is in too: the visible day/night cycle
  — the sim always ran a 4-minute day (`daylightFactor(tick)`) and now
  the sky follows it: sun, sky/fog, exposure, water and windows all grade
  from dawn gold through noon blue to a readable deep-blue night with
  stars. Visual only, driven by the sim tick (pause freezes the sky;
  saves carry no new fields).
  Exploration bet C1 (2026-10-02) is in too: the AI physical forward
  base — commander+ now owns real forward-base buildings (commander a
  fuel depot, general + an ordnance depot, marshal + a radar station;
  cadet/citizen build none), and its virtual supply stocks are anchored
  to them: stocks accrue only while the matching depot stands complete
  and operational, and destroying a depot zeroes its reserve. Conquest
  now requires razing the forward base too.
  Fun-audit Tier 4 / E1 (2026-10-02) is in too: **the Envoy at the
  Gates** — when the rival accepts your ceasefire (or a 2,000+ tribute
  at war impresses it, or a proud rival declines), a neutral envoy
  drives a black SUV to your gates instead of an instant answer. The
  shared `neutralNonCombatant` gate makes it untargetable and
  unattackable; a banner offers Accept/Decline with a 60-second
  countdown (silence accepts); accepting starts the 5-minute ceasefire
  clock with a dove release over your capital.
  Fun-audit Tier 4 / E2 (2026-10-02) is in too: **the six Luminary
  cards** — once per age, a remarkable guest (gold ring on the map)
  asks for an audience at your capital: the Defector, the War Hero,
  the Whistleblower, the Tycoon, the Logistics Prodigy, and the
  Cartographer. Each card is a presidential call with costs on both
  sides (3 minutes to decide; silence applies the default) — the
  story engine of the peaceful endless mode.
  Fun-audit Tier 4 / E3 (2026-10-02) is in too: the **Vostok
  Combine** — a merchant-only neutral freighter that visits every
  12–18 minutes and anchors off your capital for 3 minutes, selling
  emergency materials, fuel, food, research (at 2× market), ammo
  into depot storage, and influence (8 funds / +1, capped) — no
  sell-back, and no raid in 0.1 Alpha. Watch the manifest: if a
  commander+ AI is war-planning and ammo-starved while the freighter
  is anchored, it buys shells too, and the game tells you.
  Fun-audit Phases 1–2 and the determinism hardening (2026-10-02)
  are in too: correct age toasts, named Muse announcements for
  units/buildings/research, a war-core warning before defeat, an
  opening camera sweep with an objective, a rival victory-progress
  strip, off-screen event pings; the 5-minute wonder countdown
  (Monument or 80% of the economic/population targets — the leader
  must defend it); endgame statistics on the end screen and in the
  campaign debrief; the sim now runs on `sim/deterministic.ts`
  (no `Math.hypot`/sin/cos/log in sim code, lint-guarded).
  Fun-audit Phase 4 Tiers 1–3 (2026-10-02) are in too: scheduled
  escalating telegraphed AI offensives (probe ~8 min, offensive
  ~15 min, all-in ~25 min, with 1-minute warnings; ceasefires delay
  waves, never cancel them), rival age-ups as announced global events
  with a vulnerability window, real production queues (per-unit train
  times of 5–20 seconds, pause, cancel with full refund, rally
  flags), the engineer's construction/repair aura, influence-cost
  diplomacy (tribute 20, ceasefire 40 — paid win or lose), genuine
  player fog of war (shroud / dimmed / clear, using the AI's own
  sight model), onboarding that teaches the game's verbs and the
  economy's mental model, Republic/Kestrel doctrine asymmetry
  (Republic: better sensors, stronger engineers, Aegis Battery
  missile shield; Kestrel: tougher armor/artillery, the
  very-long-range Tempest Cannon, weaker AA), and quantitative
  utility networks (power-line capacity, ×1.25 road-frontage
  throughput bonus, data-driven adjacency synergies — roads stay
  purely optional).
  Building upgrades (2026-10-05) are in too: nuclear plants are built
  with 1 reactor and can be upgraded to 4 via **Add Reactor** (1,200
  funds + 500 materials, 40s; +45 power and +3 water demand per extra
  reactor — 195 power at 4 reactors, plant stays online during the
  upgrade), and the AI upgrades its own plants when rich.
  See the live plan:
  [`docs/grand-expansion/PLAN.md`](docs/grand-expansion/PLAN.md).

## What the game has today (0.1 Alpha)

- City building with visible zoning, terrain-following roads, and
  power/water utility networks you drag-paint across the map
- 100 buildings and 103 units across land, sea, and air, with tech ages
- Command menu (rebuilt 2026-10-01): a slim icon rail with three tabs
  — **Civilian** (Tools / Build / Airlines), **Military** (Train /
  Build / Superweapons), **Management** (Taxes / City focus / Cabinet /
  Ordinances / Intelligence / Trade / Research) — each with sub-tabs;
  selecting a unit or building shows a detail view with its stats and
  action buttons; trade routes are established from Management →
  Trade
- Entity portraits (2026-10-01): the command-menu cards (train / build /
  superweapon) and the selection detail "dossier photo" show the real
  model portrait from a generated sprite atlas (203 sprites), with the
  hand-drawn icon glyph as the fallback — lazy-loaded, zero boot cost
- City ordinances (Phase 8): five city-wide policies on the Management
  tab — Green Initiative, Transit Subsidy, Business Incentives,
  Nightlife Ordinance, Education Grants — each with real per-second
  upkeep, funded from the treasury after buildings; effects apply only
  while funded
- Peaceful mode (Phase 8, sim core + UI panel in): war disabled by
  design — the full military roster (units, buildings, upgrades,
  covert ops, superweapons) is locked out at the command layer while
  the AI rival keeps playing peacefully beside you; it is endless
  (2026-10-01) — no victory, no defeat, no end screen, just build
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
  resupply orders, reload-point aura, and **Emergency refuel** for
  stranded fossil-fuel aircraft (150 funds, +30% tank, airdropped)
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
- Scripted gameplay trailer (2026-10-01): `?trailer=1` plays a
  deterministic ~4-minute in-game movie — a real skirmish vs a cadet AI
  (title cards, scripted camera) — recorded straight to a downloadable
  `.webm`; `&trailerseed=<n>` re-shoots on another seed (see
  `docs/trailer.md`)

## Building from source

Prerequisites: **Node.js ≥ 22** (see `.nvmrc`; `nvm use` picks it up).

```sh
cd game
npm install     # installs vite, vitest, typescript, three
npm run dev     # local dev server with hot reload
npm test        # full test suite (vitest, headless)
npm run typecheck  # tsc --noEmit
npm run build   # production build into game/dist/ (+ license stamp)
```

`npm run build` emits plain static assets. The live site
(https://gumbdames.github.io/novaterra/) is deployed from `main` to
GitHub Pages by pushing the `dist` output to the `gh-pages` branch.

New contributors: read [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
repo [`AGENTS.md`](AGENTS.md) first — docs freshness and the step gate
are part of every change.

## Documentation map

| Doc | What it is |
|---|---|
| [`docs/grand-expansion/PLAN.md`](docs/grand-expansion/PLAN.md) | **The live plan** — 10-phase grand expansion, current statuses |
| [`docs/grand-expansion/RESEARCH.md`](docs/grand-expansion/RESEARCH.md) | Research synthesis behind the plan |
| [`docs/GAME_MECHANICS.md`](docs/GAME_MECHANICS.md) | How the game works (player-facing, kept current) |
| [`docs/HOW_TO_PLAY.md`](docs/HOW_TO_PLAY.md) | Controls and getting started |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Locked architecture |
| [`docs/REVERSALS.md`](docs/REVERSALS.md) | Decisions reversed or deliberately not taken |
| [`docs/TESTING.md`](docs/TESTING.md) | Test layout, commands, conventions |
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
| `game/public/` | Static assets served as-is: `models/` (989 CC0 GLBs + textures), `audio/` |
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
