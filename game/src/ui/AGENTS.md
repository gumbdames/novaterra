# AGENTS.md — src/ui

HUD, menus, dialogs, camera, selection and orders. UI emits tick-aligned
command structs to sim/commands.ts — it never mutates sim state directly.

## Modules (0.1 Alpha)

- `session.ts` — canonical skirmish assembly (terrain, world, queue,
  driver, 5 systems in fixed order, starting forces, AI rival). The one
  place the full game is wired; headless-safe (no DOM/three.js).
  `createSession({ snapshot })` restores a saved game: no re-seeded
  starting forces, no duplicate AI player. `createSession({ mapPreset })`
  selects a MAP_PRESETS entry by name (default 'Meridian Plains'; unknown
  names fall back). Starting forces find land per-unit (not just at the
  base center) so high-water maps never reject spawns. `session.cheated`
  is UI-owned metadata (never sim state), stamped into save files.
  `session.aiBase` exposes the fresh rival base position (null on
  restore — callers fall back to the AI player's snapshotted base).
- `game.ts` — the game controller: renderer, daylight scene, camera
  input, selection, placement modes, fixed-timestep loop, pause menu.
  DOM + three.js; never imported by headless tests.
  Step 11: owns the save store, the cheat console (backtick), the end
  screen, and autosave (every 5 game-minutes, tick-based). Also owns the
  `MuseCommander` rival when the "Muse" difficulty is picked (off-tick
  API cadence, "Muse is thinking…" badge, silent Classic fallback) —
  network state stays in the controller, never in `World`.
- `cheatconsole.ts` — the cheat console overlay. `parseCheatCommand` is
  pure and tested (case/whitespace-tolerant); the `CheatConsole` class is
  DOM-only and emits parsed actions to the controller. Sim-affecting
  cheats go through the command queue with `issuer: 'cheat'`; `reveal`,
  `win`, `lose`, `help` are UI-only.
- `endscreen.ts` — victory/defeat overlay. Skirmish conquest victory
  (rival has no units/buildings) calls `showVictory()` and conquest
  defeat (player has no units/buildings) calls `showDefeat()`, both via
  `checkSkirmishVictory()` / `checkSkirmishDefeat()` in `session.ts`;
  `getSkirmishOutcome()` adds the 30-tick grace period and the
  mutual-elimination tiebreak (defeat takes precedence). The
  `win`/`lose` cheats also use it. No-rival skirmishes are sandbox
  (no win/lose condition).
- `saveslots.ts` — save/load slot picker dialog + pure
  `formatSaveSummary`.
- `hud.ts` — top bar, advisor panel, selection panel, train/build
  palettes, toasts. Calls back into the controller; never touches sim.
  Train panel lists all TRAIN_ORDER units, age-gated by
  `isUnitAvailableForAge` (the same rule as spawn validation); sea units
  get a "click WATER" placement hint. Build palette includes Shipyard
  and Media Center (the latter is the only influence source — required
  for age advancement).
- `menus.ts` — main menu (skirmish setup: map picker + difficulty picker),
  pause overlay, settings (quality, key list). Quality persists in
  localStorage. Skirmish setup shows all 8 MAP_PRESETS (name + water %)
  and all 6 AI difficulties (incl. Muse — no-key confirm dialog routes
  to Classic fallback instead of a broken game);
  `onStartSkirmish(difficulty, mapPreset)`. Settings → Live Muse: API
  key, model selector, cadence selector (30/60/120 s), Test connection
  button.
- `camera.ts` / `selection.ts` — pure state + transitions, fully tested.
- `orders.ts` — gesture → `OrderIntent` (`NewCommand` minus issuer);
  the controller stamps `issuer: 'player'` at enqueue.
- `campaignui.ts` — campaign screens (Phase 2): `MissionSelect`
  (locked/unlocked/done), `MissionBriefing` (paths with 🕊/⚔ markers),
  `MissionDebrief` (debrief copy + diplomat/commander score + the two
  campaign endings), `MissionPanel` (in-HUD objective tracker).
- `musebox.ts` — the Muse widget: portrait, speech bubble, threat
  meter. Pure DOM; `MuseController` decides what to say.
- `session.ts` also assembles campaign missions:
  `createSession({ campaignMission })` — map/AI/starting resources from
  the mission, no AI rival when difficulty is 'none', owner 1 always
  funded with manpower for scripted raids.
- `game.ts` (Phase 2): owns the mission run + `MuseController` +
  `MuseBox` + `MissionPanel`; polls the campaign director ~2×/sec and
  Muse ~1×/sec in the game loop. Victory/defeat → debrief overlay →
  `onMissionEnd` records progress. Muse settings (frequency + live key)
  live in the settings panel, live-applied in game.
- `advisor.ts` — pure `evaluateAdvisor(world, playerId)`, worst-first.
- `strings.ts` — all UI copy in one place (English now, Hebrew later).
- Audio: `game.ts` owns an `AudioEngine` (see `src/audio/AGENTS.md`) —
  unlocked on first pointer/key gesture, `updateMusic(world, playerId)`
  polled ~2×/sec, SFX on select/orders/placement/age-advance/rejections/
  deaths/buildings/advisor changes, pause = `audio.suspend()`.
  `menus.ts` SettingsPanel has master/music/SFX sliders + mute (persisted,
  live-applied in game).

## Rules

- Right-click attacks are gated by `canTarget(def, target)` — the same
  rule the Classic AI follows. Never order an impossible attack.
- Rejected commands toast loudly (`CommandRejectedError`); nothing fails
  silently.
- `S` is Stop, never camera-back. Camera back is ArrowDown.
- Starting forces live in `session.ts`, not in the controller.
