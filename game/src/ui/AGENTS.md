# AGENTS.md — src/ui

HUD, menus, dialogs, camera, selection and orders. UI emits tick-aligned
command structs to sim/commands.ts — it never mutates sim state directly.

## Modules (0.1 Alpha)

- `session.ts` — canonical skirmish assembly (terrain, world, queue,
  driver, 5 systems in fixed order, starting forces, AI rival). The one
  place the full game is wired; headless-safe (no DOM/three.js).
  `createSession({ snapshot })` restores a saved game: no re-seeded
  starting forces, no duplicate AI player. `session.cheated` is UI-owned
  metadata (never sim state), stamped into save files.
- `game.ts` — the game controller: renderer, daylight scene, camera
  input, selection, placement modes, fixed-timestep loop, pause menu.
  DOM + three.js; never imported by headless tests.
  Step 11: owns the save store, the cheat console (backtick), the end
  screen, and autosave (every 5 game-minutes, tick-based).
- `cheatconsole.ts` — the cheat console overlay. `parseCheatCommand` is
  pure and tested (case/whitespace-tolerant); the `CheatConsole` class is
  DOM-only and emits parsed actions to the controller. Sim-affecting
  cheats go through the command queue with `issuer: 'cheat'`; `reveal`,
  `win`, `lose`, `help` are UI-only.
- `endscreen.ts` — victory/defeat overlay (the hook a future conquest
  system will call; in 0.1 Alpha only the `win`/`lose` cheats show it).
- `saveslots.ts` — save/load slot picker dialog + pure
  `formatSaveSummary`.
- `hud.ts` — top bar, advisor panel, selection panel, train/build
  palettes, toasts. Calls back into the controller; never touches sim.
- `menus.ts` — main menu (difficulty select), pause overlay, settings
  (quality, key list). Quality persists in localStorage.
- `camera.ts` / `selection.ts` — pure state + transitions, fully tested.
- `orders.ts` — gesture → `OrderIntent` (`NewCommand` minus issuer);
  the controller stamps `issuer: 'player'` at enqueue.
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
