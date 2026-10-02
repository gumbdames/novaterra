# NOVATERRA — Testing

How tests are organized, run, and what they cover. 0.1 Alpha.

## Running the tests

From `game/` (requires Node ≥ 22 — see `.nvmrc`):

```sh
npm install        # once: installs vite, vitest, typescript, three
npm test           # full suite: npx vitest run (175 files, ~2700 tests)
npm run typecheck  # npx tsc --noEmit — must be clean
npm run build      # vite build + license stamp — must succeed
```

The full suite runs headless in Node (Vitest). No browser needed. The step
gate (repo `AGENTS.md` §2) requires the whole suite green after every change —
never just the tests you touched.

## Layout (`game/tests/`)

Test files are named `<area>.<topic>.test.ts`:

| Prefix | What it covers |
|---|---|
| `sim.*` (66 files) | Deterministic sim logic: economy, combat, AI, pathfinding, snapshots/digests, peaceful mode, siege, intel, logistics, utilities, veterancy |
| `ui.*` (29 files) | UI contract modules (pure, headless-safe): palettes, HUD digests, peaceful-mode gating, i18n enforcement, icons |
| `render.*` (30 files) | Render-side pure builders: geometry, overlays, digests, instancing, procedural models |
| `audio.*` (3 files) | Music engine, SFX synth |
| `net_*` (3 files) | Save-file format, save/load round-trips, IndexedDB store |
| `perf.budgets.test.ts` | Performance budgets — these are tests, not aspirations; exceeding a budget fails the suite |
| `playtest.skirmish.test.ts` | Scripted gameplay scenarios driven through the real sim command queue |
| `campaign.test.ts`, `muse.test.ts` | Campaign missions, Muse persona |
| `smoke.*`, `bench.*` | Boot smoke test, benchmark harness |

## Conventions

- **Sim tests are deterministic.** Same seed + same commands ⇒ identical
  state. Tests pin digests; if a digest changes, something in the sim
  changed — investigate, don't update the test blindly.
- **Boundary discipline is tested.** The sim never imports DOM/three.js/
  Web Audio; UI never mutates sim state directly (all input goes through
  the tick-aligned command queue). Headless suites import sim modules
  directly in Node — anything that needs a browser is a bug in the
  module, not the test.
- **Rejections are loud.** Command validation failures throw
  `CommandRejectedError` with a reason; tests assert the reason, never
  just that something threw.
- **No wall clock, no `Math.random` in sim code.** Time enters through
  the tick driver; randomness through `sim/rng.ts` named streams. Grep
  before committing.

## What is NOT covered

- UI modules that need a real DOM/canvas (`ui/game.ts`, `ui/menus.ts`,
  `ui/campaignui.ts`, `ui/endscreen.ts`, `ui/musebox.ts`, `ui/saveslots.ts`)
  have no test importers — they are exercised by manual playtests.
- `hud.ts` / `game.ts` are only shallowly covered. The HUD digest
  registry (`ui/paletteDigest.ts`) is contract-tested instead.
- Perf numbers are Node measurements of mostly-idle scenarios, not
  browser measurements of worst-case ticks — the 60fps claim is
  unproven at scale (see the final-review report, 2026-10-01).
