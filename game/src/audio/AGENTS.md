# AGENTS.md — src/audio

Adaptive music engine and SFX voice pool on raw Web Audio (no runtime audio
library — see docs/research/audio.md). Observes sim events; never mutates sim
state. Pause = ctx.suspend(); settings persist to localStorage.

## Modules (0.1 Alpha)

- `engine.ts` — `AudioEngine`: owns the single lazily-created AudioContext
  (created on first user gesture per autoplay policy). Buses:
  `sfxBus` / `musicBus` → `masterGain` → destination. Slider→gain is
  quadratic. `unlock()` / `suspend()` / `resume()` / `dispose()`;
  `updateSettings()` persists. `playSfx()` capped at 12 voices/frame.
  `updateMusic(world, playerId)` drives the director ~2×/sec.
  `bindUiClicks(root)` plays the click cue for any button press.
- `music.ts` — adaptive music: `selectMood({playerUnitsInCombat})` is a pure
  function (`war` iff any player unit has a live target). `MusicDirector`
  owns two looping `<audio>` tracks (peace/war) routed through the music
  bus, with an equal-power crossfade on mood change. Files carry baked 2s
  fades so loop seams stay inaudible. Both tracks CC-BY Kevin MacLeod —
  see THIRD_PARTY_NOTICES.md.
- `sfx.ts` — procedural SFX synth: every cue is declarative data
  (`SFX_CUES: Record<SfxId, SfxCue>`, tone/noise layers), `playSfxCue`
  renders it. Zero download cost; the game is never silent on audio
  failure (all playback is try/caught).

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
