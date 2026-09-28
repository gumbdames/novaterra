# AGENTS.md — awesome-sim-game

Operating manual for everyone (human or agent) working in this repo. This file is
about *how we work here*. Game design lives in `docs/`, player docs in
`docs/HOW_TO_PLAY.md` and `docs/GAME_MECHANICS.md`.

## 1. Documentation is part of the work, not after it

- **Continuously update** every `.md` file, comment and doc as work progresses:
  research notes while researching, `PLAN.md` when the plan changes,
  `ARCHITECTURE.md` when the architecture changes, player docs when mechanics
  change. A doc that lags reality is a bug — fix it in the same change.
- Research workstreams keep notes in `docs/research/<topic>.md`, updated as
  findings evolve, with sources cited. Dead ends are documented too (what was
  tried, why it was rejected).
- Code is well-commented: every module gets a header comment (purpose,
  responsibilities, key invariants), every non-obvious algorithm gets an
  explanation, every perf-sensitive path notes its budget.
- Add an `AGENTS.md` in any subdirectory that develops its own conventions
  (e.g. `game/src/sim/AGENTS.md` once the sim takes shape).

## 2. Quality bar (the North Star)

- **No bugs, flowing game, great mechanics, fun to play.** In that order of
  operations: correctness first, then feel.
- Nothing merges untested: unit tests for sim logic, headless sim tests for
  gameplay flows, manual playtest notes for feel. See `docs/TESTING.md`.
- **Performance budget:** 60fps on a mid-range laptop with thousands of
  entities; sim tick decoupled from render; profile before optimizing, and
  record the numbers in the relevant research note.

### Step gate (every phase step, no exceptions — user directive 2026-09-28)

Each numbered step in `docs/PLAN.md` counts as done only when ALL of these hold:

1. Its own tests are green (unit + headless sim suites as applicable).
2. The full build is green and the game still boots to a working state.
3. **Regression:** every previous step's key flows still work — re-run their
   smoke tests, don't assume. "It worked before my change" is proven by
   re-running, never by memory.
4. Docs touched by the step are updated (plan status, architecture if it
   changed, player docs if mechanics changed).
5. The step is committed with a clear message; `main` stays deployable.

If any check fails, the step is not done — fix it before starting the next
one. Testing after each step is how `main` stays shippable.

## 3. Architecture rules

- The **simulation is deterministic and decoupled from rendering** (fixed
  timestep; render interpolates). No gameplay logic in the render layer, no
  rendering assumptions in the sim.
- **Modular by design:** `sim/`, `render/`, `ui/`, `audio/`, `net-save/` stay
  behind clean interfaces (documented in `docs/ARCHITECTURE.md`).
- Save/load and pause must work from day one of playable builds: serializable
  sim state, versioned save format.
- Prefer boring, proven technology. Exotic tech (WASM, WebGPU compute, workers)
  only where profiling proves it earns its complexity — the research in
  `docs/research/` is the record of those decisions.

## 4. Git hygiene

- `main` is always deployable to GitHub Pages. Small, focused commits with
  clear messages (`area: what changed`).
- **Never commit or push without explicit user approval for this repo's
  workflow.** (Standing approval exists for this project's development flow;
  anything outside it — e.g. force-push, history rewrites — needs a fresh OK.)
- Commit identity: `Gumb Dames <builder@localhost>`. No real names or emails
  anywhere in the repo.
- **No secrets, tokens, keys or credentials in the repo — ever.** Not in code,
  not in docs, not in git history. GitHub auth uses a token supplied at runtime
  via the `GH_TOKEN` environment variable only, e.g.:
  `GH_TOKEN=... git -c http.extraHeader="Authorization: Bearer $GH_TOKEN" push`.
  Never embed tokens in remote URLs.

## 5. Ask vs. decide

- Decide small things yourself and record the decision + rationale in the
  relevant doc. Ask the user about forks that change the game's direction,
  scope, or feel.
- When the user corrects something, absorb it instantly, fix the code AND the
  docs, and note the correction so it doesn't regress.
