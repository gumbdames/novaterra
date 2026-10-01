# Contributing to NOVATERRA

0.1 Alpha. The short version: keep the game deterministic, keep the docs
current, keep `main` deployable.

## Setup

- Node.js ≥ 22 (`.nvmrc` — `nvm use` picks it up).
- `cd game && npm install`, then `npm run dev` for the local server.
- Read the repo [`AGENTS.md`](AGENTS.md) — it is the operating manual.
  The per-directory `AGENTS.md` files (`game/src/sim/`, `game/src/render/`,
  `game/src/ui/`, `game/tests/`) carry the module-level rules; deeper
  files win.

## Workflow

1. Work on a branch. `main` is always deployable to GitHub Pages.
2. Small, focused commits: `area: what changed` (e.g.
   `sim: fix ferry retry on failed orders`).
3. Every commit message contains `(0.1 Alpha)`.
4. Commit identity: `Gumb Dames <builder@localhost>` — no real names or
   emails anywhere in the repo.
5. **Never commit secrets, tokens, keys, or credentials.** Not in code,
   not in docs, not in history. Ever.
6. Do not push without explicit approval for this repo's workflow.

## The step gate (no exceptions)

Every change is done only when ALL of these hold:

1. Its own tests are green — and the **full** suite still is
   (`npm test`, `npm run typecheck`, `npm run build`).
2. Docs touched by the change are updated in the same change:
   `docs/grand-expansion/PLAN.md` status, `docs/ARCHITECTURE.md` if the
   architecture changed, player docs (`docs/HOW_TO_PLAY.md`,
   `docs/GAME_MECHANICS.md`) if mechanics changed — plus the repo-level
   status: this README's status line and feature list. **A stale status
   line anywhere is a bug.**
3. The game's North Star holds: no bugs, flowing game, great mechanics,
   fun to play — in that order.

## Code rules that matter most

- **The sim is deterministic and decoupled from rendering.**
  `game/src/sim/` has no DOM, no three.js, no Web Audio, no wall clock,
  no `Math.random` — randomness comes from `sim/rng.ts` named streams.
  Render (`game/src/render/`) never mutates sim state. UI
  (`game/src/ui/`) never mutates sim state directly — all input goes
  through the tick-aligned command queue (`sim/commands.ts`).
- **Rejections are loud.** Invalid commands throw `CommandRejectedError`
  with a reason; nothing fails silently.
- **English-only.** The shipped game is English and English ONLY — no
  other language's string data in `src`, `index.html`, or the bundle
  (enforced by `game/tests/ui.i18n.test.ts`). New UI copy goes through
  the `LocalizedString` indirection in `game/src/ui/strings.ts` so other
  languages can be added later. See `docs/I18N.md`.
- **No third-party AI.** Live Muse is an offline "hopefully coming"
  placeholder — no API keys, no endpoints, no networking, no AI SDKs.
  See `docs/REVERSALS.md`.
- Every module gets a header comment (purpose, responsibilities, key
  invariants). Non-obvious algorithms get explanations.

## Tests

`docs/TESTING.md` has the full guide. In short: `npm test` from `game/`,
everything headless in Node, digests pinned (a changed digest means the
sim changed — investigate, don't update blindly).

## License

AGPL-3.0-only. All contributions land under the same license.
Third-party assets are CC0 with attribution in `THIRD_PARTY_NOTICES.md`.
