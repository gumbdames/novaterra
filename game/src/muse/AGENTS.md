# AGENTS.md — src/muse

The Muse persona AI: the player's chief-of-staff companion (Phase 2).
Offline deterministic persona is the real deal; live LLM link is
advisory-only scaffolding marked hopefully coming in 0.1 Alpha.

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
- `live.ts` — Live Muse "hopefully coming" placeholder (0.1 Alpha): the
  `MUSE: advise: <text>` directive protocol (`parseDirectives` honors
  ONLY advise lines — a live model can never drive ticks or mutate
  state) and the `MuseDigest` builder. NO API-key flow — removed
  entirely per the 2026-09-29 user directive: no key storage, no
  endpoint, no networking, zero third-party AI API surface.
  `createLiveMuseClient().advise()` always throws `LiveMuseError` so
  callers fall back to the offline persona; the settings panel marks
  Live Muse "hopefully coming".

## Rules

- Muse never drives ticks and never mutates deterministic state.
- Line selection must stay deterministic (hash, never Math.random).
- The persona is charming, never annoying: throttle hard, prefer
  silence over chatter. `quiet` = milestones only.
