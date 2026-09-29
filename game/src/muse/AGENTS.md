# AGENTS.md — src/muse

The Muse persona AI: the player's chief-of-staff companion (Phase 2).
The live LLM link is wired in 0.1 Alpha two ways: advisory flavor for
the persona, and the **Muse Commander** rival (player's own API key
drives the enemy commander through ordinary queued commands).

## Modules

- `persona.ts` — `PersonaEvent` → `personaLine(event, tick)`. Line
  selection is an FNV-1a hash of (event key + tick): the same game
  stream always hears the same Muse. Pure data + pure functions.
- `director.ts` — `militaryValue` (deterministic combat-power score;
  unarmed units count 0) and `computeThreat` (AI's share of combined
  military value, 0..100). `narrateTrick` turns *observed* enemy
  movement into persona flavor — the persona never reads AI intent, so
  fairness is structural. Pure functions.
- `controller.ts` — `MuseController`: polls the world ~1×/sec, diffs
  snapshots, and emits persona events through a `say` callback.
  Frequency setting (`off`/`quiet`/`normal`/`chatty`, localStorage
  `novaterra.muse.frequency`): quiet = milestones only; majors
  (victory/defeat/age/program) always go through; minors throttled to
  one line per 9s, taunts (chatty only) at most 1/min when the threat
  meter swings past 75/25. `notify(text)` injects authored content
  (campaign messages, live-Muse advice) bypassing throttle.
  UI-owned: never mutates sim state.
- `digest.ts` — `buildCommanderDigest(world, ownerId, map)`: the
  compact (< 2 KB JSON), JSON-safe battle digest sent to the API.
  Owner's full state + **fog-filtered** enemies only (units via
  `getVisibleEnemies`, buildings via `isVisibleTo` — the exact sight
  rule the Classic AI plays by). `computeWaterPct(terrain)` estimates
  water coverage once per game. Pure: no DOM/fetch/clock/randomness.
- `live.ts` — the live link. Settings storage (key/model/cadence,
  localStorage only — key never logged, never in errors, sent only as
  the `x-api-key` header to api.anthropic.com; models: Sonnet 4.6/4.5,
  Haiku 4.5). `parseDirectives` parses the `MUSE:` line protocol
  (`build`/`train`, `construct`, `attack`, `defend`, `advance-age`,
  `advise`) with canonical case-insensitive kind resolution
  (`patrolBoat`, `signalsGrid` survive any model casing);
  malformed/unknown lines are ignored, never thrown (`advise` stays
  backward compatible). `directivesToCommands` turns directives into
  ordinary validated queue commands (never touches `world` directly;
  loud rejections swallowed per directive). `createLiveMuseClient` POSTs
  to the Anthropic Messages API (30 s timeout, `LiveMuseError` with a
  machine-readable `code`: 401 → `invalid_key` with an "Invalid API key"
  message); `testLiveConnection` powers the Settings button.
- `commander.ts` — `MuseCommander`: UI-owned rival controller. One API
  call per cadence interval (30/60/120 game-seconds), at most one in
  flight, resolved directives buffered and applied at the next
  `update()` — the controlled application point, never inside the
  Promise callback. Any failure (no key, timeout, 401/429/5xx, network,
  malformed output) is silent: the Classic Commander brain inside the
  sim keeps playing. A 401 latches the key — no retries until the
  stored key changes. All network/async state lives here — never in
  `World` (snapshots stay deterministic and key-free).

## Rules

- Muse never drives ticks and never mutates deterministic state — the
  commander path goes through `CommandQueue` like any other order.
- Line selection must stay deterministic (hash, never Math.random).
- The persona is charming, never annoying: throttle hard, prefer
  silence over chatter. `quiet` = milestones only.
- The digest must never leak hidden enemies: fog filtering is tested
  structurally (`tests/muse.commander.test.ts`), not just promised.
