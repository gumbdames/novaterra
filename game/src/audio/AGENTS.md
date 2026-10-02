# AGENTS.md — src/audio

Adaptive music engine and SFX voice pool on raw Web Audio (no runtime audio
library — see docs/research/audio.md). Observes sim events; never mutates sim
state. Pause = ctx.suspend(); settings persist to localStorage.

## Modules (0.1 Alpha)

- `engine.ts` — `AudioEngine`: owns the single lazily-created AudioContext
  (created on first user gesture per autoplay policy). Buses:
  `sfxBus` / `musicBus` → `masterGain` → destination. Slider→gain is
  quadratic. `unlock()` / `suspend()` / `resume()` / `dispose()`;
  `updateSettings()` persists. `playSfx(id, pos?)` capped at 12
  voices/frame — positional via a per-play equal-power `PannerNode`
  when a world position is passed (UI cues stay non-positional); a
  hard drop while the context isn't running (paused-menu clicks never
  burst on resume — final-review R5 L5, 2026-10-01). `setMusicMood(mood)`
  drives the director (the game loop's `MoodTracker` owns the
  hysteresis); `updateListener(x, z)` keeps the listener on the camera
  target every frame; `startAmbientBed()` starts the procedural city
  hum under the music bus (in-game only, pause-aware, ducks under war).
  `bindUiClicks(root)` plays the click cue for any button press.
- `events.ts` — sim→audio event differ (pure, tested,
  `tests/audio.events.test.ts`). The sim never emits audio events; the
  game loop snapshots once per poll and `AudioEventTracker` diffs by
  entity id: deaths/destroyed with world positions (positional SFX),
  friend/foe flags, damage events, trained units, research completion,
  embedded spies (`snapshotForAudio(world, playerId, cellToWorld)` —
  the caller passes the cell converter so this module stays sim-free).
  Roadmap B11 (2026-10-02): `buildsComplete` — `snapshotForAudio`
  carries each building's `progress` (missing = 1 = already standing,
  so pre-B11 snapshots never false-fire) and `observe` emits one event
  per `prev.progress < 1 → now.progress >= 1` transition on standing
  buildings; game.ts plays the `buildComplete` cue positionally for
  friendly completions only.
- `music.ts` — adaptive music: `selectMood({playerUnitsInCombat,
  enemiesNear})` is a pure function (`war` when fighting, `tension`
  when sighted enemies are near but no fight has started, `peace`
  otherwise). `MusicDirector` owns the looping voices — peace/war are
  `<audio>` file tracks, tension is a procedural pulsing drone bed
  (`createTensionBedBuffer`: 8s seamless loop, low A1+E2 drone +
  distant war-drum pulse, zero download, zero license) — routed through
  the music bus, with an equal-power crossfade on mood change. File
  tracks carry baked 2s fades so loop seams stay inaudible. Both file
  tracks CC-BY Kevin MacLeod — see THIRD_PARTY_NOTICES.md.
  `MoodTracker` (final-review R5, 2026-10-01; tension state roadmap B20,
  2026-10-02) is the shipped hysteresis: 2 consecutive active polls
  (combat units OR damage events — being bombed with no live targets
  counts) to enter war, 20s quiet window to exit; the B20 tension state
  uses the same shape (2 proximity polls to enter, 10s quiet to leave):
  sustained enemy proximity lifts peace→tension, combat jumps straight
  to war from either state, war relaxes to tension (not peace) while
  enemies are still near. The proximity driver
  (`enemyProximityFromWorld`) uses the sim's sight model
  (`getVisibleEnemies` — the same call the minimap uses), so the music
  never maphacks: only enemies the player's side can actually see, and
  within `TENSION_RADIUS` (60 world units) of a player unit/building,
  raise the tension. The game loop calls
  `tracker.update({nowMs, combatUnits, damageEvents, enemyProximity})`
  then `engine.setMusicMood(mood)`.
  Licensed-track upgrade path: drop a CC-BY `tension.mp3` into
  `public/audio/`, add it to the director's `tracks` map like
  peace/war, and document it in THIRD_PARTY_NOTICES.md — the
  procedural bed is the fallback that always works.
- `sfx.ts` — procedural SFX synth: every cue is declarative data
  (`SFX_CUES: Record<SfxId, SfxCue>`, tone/noise layers), `playSfxCue`
  renders it. Zero download cost; the game is never silent on audio
  failure (all playback is try/caught). 19 cues (0.1 Alpha, R5
  2026-10-01): UI, orders, combat, economy/tech (`unitTrained`,
  `researchComplete`), kill differentiation (`unitDown` loss vs
  `foeDown` kill), `underAttack` (30s-throttled), `intelOp`,
  `victory`/`defeat` stingers. Roster pinned by `tests/audio.sfx.test.ts`.

## Who owns engines

- `main.ts` (menu): one menu-level `AudioEngine` — peace track behind
  the menu (final-review R5, 2026-10-01). Created on first gesture,
  disposed on every game entry, recreated on every return to the menu.
  The game builds its own engine; the two never coexist.
- `ui/game.ts` (game): one in-game `AudioEngine` — unlocked on first
  gesture, ambient bed started with the session. Pause =
  `ctx.suspend()`; `runGameFrame` never polls audio events while
  paused. Victory/defeat stingers fire through `EndScreen`'s `onShow`.

## Assets

- `public/audio/peace.mp3` — "Meditation Impromptu 01", Kevin MacLeod
  (incompetech.com), CC BY 4.0, 96kbps, 212s.
- `public/audio/war.mp3` — "Volatile Reaction", Kevin MacLeod
  (incompetech.com), CC BY 4.0, 128kbps, 165s.
- Served at `<base>/audio/*.mp3` via Vite `public/`; `engine.ts` resolves
  the base with `import.meta.env.BASE_URL`.

## Rules

- Audio is UI-layer only: DOM + Web Audio allowed here, but the modules
  must stay import-safe under Node for the pure-logic tests (no top-level
  `window`/`AudioContext` access — everything behind methods).
- `selectMood` / `SFX_CUES` / settings helpers are pure and fully tested.
- Never let audio break the game: every Web Audio call is defensive.
- New music/SFX assets must be documented in THIRD_PARTY_NOTICES.md with
  source URL, license, and attribution before commit.
