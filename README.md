# novaterra

**A 3D city-builder × RTS hybrid for the browser** — SimCity-style city building and
economy, Red Alert-style warfare and skirmish, Age of Empires-style ages and
technology progression. Set in the modern world of 2026. You are the President:
found cities, grow the economy, research through the ages, command armies on land,
sea and air — or play a fully peaceful game with war disabled.

- **Play:** https://gumbdames.github.io/novaterra/ (deploys from `main`)
- **Status:** Phase 0 research complete; Phase 1 (core engine + skirmish MVP) scoped in `docs/PLAN.md`, awaiting go-ahead
- **Working title:** NOVATERRA (proposed — see `docs/research/game-design.md`)
- **Design docs:** `docs/` · **Research notes:** `docs/research/`

## Repo layout

| Path | What lives here |
|---|---|
| `docs/` | Plans, architecture, design docs, player docs |
| `docs/research/` | Research notes from each workstream (kept current) |
| `game/` | The game itself (engine, sim, UI, assets, audio) |
| `game/src/` | TypeScript source, organized by module |
| `game/src/sim/` | Deterministic simulation (economy, combat, AI) |
| `game/src/render/` | Rendering layer (scene, instancing, effects) |
| `game/src/ui/` | HUD, menus, dialogs |
| `game/src/audio/` | Adaptive music + SFX |
| `game/assets/` | Art/audio assets and the asset manifest |
| `game/tests/` | Automated tests (unit + headless sim) |
| `tools/` | Build, map and asset tooling |

## Working conventions

Read `AGENTS.md` before touching anything in this repo. The short version:

- **Docs stay current.** Every `.md`, comment and doc is updated continuously as
  work progresses — research notes, plans, architecture, player docs.
- **Quality bar:** no bugs, flowing gameplay, great mechanics, 60fps. Nothing
  ships untested (see `docs/TESTING.md` once written).
- **No secrets in the repo.** Ever. Tokens are used transiently via environment
  variables and never written to disk or committed.
- **Performance is a feature.** The sim is fixed-timestep and decoupled from
  rendering; hot paths are profiled, not guessed.

## Roadmap (summary)

- **Phase 0** — Deep research: tech stack, sim architecture, audio, game design
- **Phase 1** — Core engine + skirmish mode (economy, ages, combat, maps)
- **Phase 2** — 8 story missions
- **Phase 3** — Chain of command depth, polish, mobile/touch if it earns it

Full detail: [`docs/PLAN.md`](docs/PLAN.md).
