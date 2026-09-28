# Audio Research — awesome-sim-game

> **Status:** complete (research concluded 2026-09-28; firm recommendation in §7).
> This note is updated continuously as findings land; decisions feed into
> `docs/PLAN.md` and `docs/ARCHITECTURE.md` once firmed up.
>
> **Owner:** audio research workstream (senior staff principal level).
> **Scope:** background music (adaptive), SFX (3D positional, UI, unit barks),
> voice management, formats, loading, sourcing/licenses. Music composition and
> sound design themselves are build-phase work; this note selects the
> *architecture* and *sourcing plan*.

## Context / requirements (from the brief)

- 3D browser RTS/city-builder (SimCity × Red Alert × Age of Empires), modern 2026
  setting. Single-player. Static site on GitHub Pages — **no server-side
  audio processing** possible.
- Adaptive background music: peaceful building vs war vs victory/defeat states.
- SFX: 3D positional (city + battlefield), UI feedback, unit barks/acknowledgments.
- Save/exit/load, pausing — audio state must survive pause/save cleanly.
- Fun on desktop; phone/tablet only if genuinely enjoyable.
- Performance budget: 60fps, thousands of entities; audio must not contend with
  sim/render for the main thread.
- Cheat for lots of resources — irrelevant to audio, noted for completeness.

---

## 1. Adaptive background music design

### 1.1 Layered stems / intensity states — how strategy games do it

Two canonical techniques, usually combined (sources: Wikipedia "Adaptive music";
[medium.com/@musicarthub.com article, Sep 2026](https://medium.com/@musicarthub.com/how-to-create-adaptive-game-music-with-ai-tools-98c9b3e10294)):

- **Vertical layering (re-orchestration):** one piece of music split into stems
  (base pad, bass, drums, lead/brass) that play simultaneously and fade in/out.
  Same music intensifies without ever restarting — seamless. E.g. *Dead Space 2*
  mixes 4 stereo stems per "fear" level from game variables.
- **Horizontal re-sequencing:** different full tracks per state, swapped at
  musically sensible moments (crossfade, or phrase/bar-locked branching). Easier
  to implement; better for genuinely different moods (menu vs battle).

A practical state machine for this game (adapted from the skill at
[eloc35/summer-engine-agent](https://github.com/eloc35/summer-engine-agent/blob/HEAD/skills/audio/adaptive-music/SKILL.md)):

```
States: PEACE (city building) → TENSION (enemy detected / alert) →
        WAR (combat) → VICTORY stinger → PEACE
        + MENU (own track), DEFEAT (own track), SKIRMISH/MISSION stingers
Transitions:
  PEACE → TENSION   on threat detected (2s crossfade, add tension stem)
  TENSION → WAR     on first damage exchanged (instant drum/percussion stem)
  WAR → VICTORY     on battle resolved (drums cut, brass swell stinger)
  VICTORY → PEACE   after ~4s
Rules: no stem state static > ~90s (bar-level variation); music ducks −6 dB
       under dialogue/barks; quantize state changes to the next bar/beat where
       possible (latency up to ~500ms/beat at 120 BPM is acceptable and
       preferable to an off-beat stab — deckwave research).
```

Decision so far: **vertical layering within a state + horizontal switching
between states** — the standard hybrid. Stems for PEACE/TENSION/WAR must be
authored in the same tempo/key/bar count; stingers are one-shots.

### 1.2 Web Audio API scheduling patterns (lookahead scheduler)

The canonical pattern is Chris Wilson's "A Tale of Two Clocks"
([web.dev](https://web.dev/articles/audio-scheduling)): a 25 ms `setInterval`
tick schedules every event falling inside a 100 ms lookahead window, placing
notes on the sample-accurate `AudioContext.currentTime` clock. Never drive
timing from `setTimeout` directly — timers jitter by tens of ms and are clamped
to ~1/s in background tabs (multiple corroborating sources: MDN advanced
techniques, dev.to rhythm-game post). Key gotchas collected:

- Create `AudioContext` lazily on first user gesture (autoplay policy);
  `latencyHint: 'interactive'`.
- `exponentialRampToValueAtTime` throws if the target is 0 — ramp to 0.001.
- Never start/stop all layers together; fade layers in/out to avoid phase drift.
- UI highlights may follow via `requestAnimationFrame`; audio must not follow UI.

### 1.3 Crossfading techniques

- Simple gain crossfade over 1.5–2.5 s (equal-power curve) for horizontal
  switches; use `setTargetAtTime` with a ~10–50 ms smoothing on volume changes
  to avoid clicks.
- For bar-locked transitions: pre-schedule the new track's `start()` at the
  next bar boundary computed from the current track's start time + tempo.
- Volume ducking: route music through a `musicBus` gain; duck −6 dB while
  dialogue/barks play, release after.

---

## 2. Libraries: Tone.js vs Howler.js vs raw Web Audio

### 2.1 Tone.js (v15.1.22, MIT)

- DAW-style: global transport, BPM scheduling, musical notation ("4n", "8t"),
  built-in synths (FM/AM/PWM), rich effects, signals with sample-accurate
  automation. Ideal for *generative/composed-in-browser* music.
- Costs: ~100 KB+ minified+gzipped; an abstraction layer on top of Web Audio
  adds CPU cost (notable on older mobile); opinionated transport we would fight
  for a custom adaptive engine (one ADR review: "we need note-on/note-off, not
  a DAW — Tone.js is ~200 kB of transport/DSP we would fight for scheduling
  determinism").

### 2.2 Howler.js (v2.2.4, MIT)

- Thin wrapper over Web Audio with `<audio>` fallback; audio sprites, fades,
  spatial audio (PannerNode via `pos()`/`orientation()`/`pannerAttr()`),
  pooling. ~7–9 KB gzipped. Handles mobile unlock automatically.
- Caveats: last release 2023 — test against current browsers rather than
  trusting old compatibility claims; one skill review warns about load/play
  error handling and teardown. We control the lifecycle, so acceptable.

### 2.3 Raw Web Audio API

- Zero dependency, full control: decode once → `AudioBuffer`, fire cheap
  one-shot `AudioBufferSourceNode`s, custom gain buses, `PannerNode`s,
  lookahead scheduler for music stems. This is what we must write *anyway*
  for the adaptive music engine (stems, buses, crossfades, ducking) — Howler's
  `Howl` abstraction does not add much there.
- Well-trodden: `source → (per-sound gain) → sfxBus / musicBus → masterGain →
  destination`. Perceived loudness is logarithmic — map 0–1 sliders with
  `gain = slider²`.

### 2.4 Tradeoff summary + recommendation (draft)

| Need | Best fit |
|---|---|
| Adaptive music engine (stems, bars, crossfades, ducking) | **Raw Web Audio** — we own the scheduler; Tone.js transport fights us |
| 3D positional SFX + voice pool + sprites | **Raw Web Audio** (~150–300 lines), or Howler if we want the unlock/sprite conveniences |
| UI one-shots | Raw Web Audio trivially, or Howler |
| Generative music prototyping | Tone.js is excellent, but **build-time only** (not shipped) |

**Draft decision:** no runtime audio library — raw Web Audio behind our own
`audio/` module interface (matches the modular architecture). Rationale:
our adaptive music engine needs bespoke scheduling anyway; Howler's value
(sprites, unlock, fades) is reimplementable in <300 lines and avoids a
2023-vintage dependency we cannot patch. Revisit only if a prototype shows
our hand-rolled unlock/fallback handling is buggy on iOS Safari. Tone.js
rejected for runtime (bundle + CPU + fighting its transport), kept as a
**composition tool** option if we go generative (see §5.3).
Dead-end note: FMOD/Wwise are native middleware — not usable in a static
GitHub Pages build. (FMOD is free under $200K revenue but ships native SDKs.)


---

## 3. 3D positional audio and performance

### 3.1 PannerNode: HRTF vs equal-power

- `PannerNode` per positional source, `AudioListener` set from camera each
  frame (`positionX/Y/Z`, `forward`, `up` vectors; one listener per
  `AudioContext`, global). [MDN / worksphere spatial manual]
- `panningModel: 'HRTF'` — convolution-based binaural, realistic elevation and
  direction over headphones, but **measurably costlier per voice**. `'equalpower'`
  — cheap stereo panning, no elevation cues.
- Recommendation: **equal-power for battlefield/city ambience voices** (many,
  distant), **HRTF only for near/important sounds** (or a settings toggle:
  "3D audio quality: high/low"). One shipped example (parallax game engine)
  uses native equal-power panners for all voices and treats HRTF as later work.

### 3.2 Voice management / source pooling

- Practical polyphony ceiling for Web Audio is **~32 simultaneous sources**
  before degradation (multiple sources; one native-engine comparison cites
  "browsers practically cap useful polyphony around 32 sources"). Our budget:
  **32 voices** for SFX + dedicated music bus (stems don't count against the
  pool).
- `AudioBufferSourceNode` is one-shot by design — create per play, release on
  `ended`; **pool the GainNode+PannerNode chains** (allocate once at init,
  reuse slots). Precompute priority: nearest/loudest wins; drop or steal
  lowest-priority when exhausted; count drops for telemetry.
- Never queue playback while context is suspended/hidden — drop instead of
  bursting on resume (parallax engine pattern).
- Per-sound gain nodes and panners: 32 pre-allocated slots, mono buffers.

### 3.3 Audio sprites

- One decoded file + named (offset, duration) regions cuts HTTP requests and
  decode overhead; play via `source.start(when, offset, duration)`. Used by
  shipped web games (e.g. tower-defense example: 26 cues in one 213 kB
  `sfx.m4a`). Plan: **UI + common one-shots in 1–2 sprite files**; long/rare
  cues (explosions, stingers) as individual files.

### 3.4 Streaming

- Long music tracks should **stream** (`<audio>` element or
  `MediaSource`) rather than decode fully into RAM — Howler's `html5: true`
  does this, but `<audio>` can't do gapless bar-locked stem starts. For stems
  (short loops, few MB), decode to `AudioBuffer` (precise scheduling);
  for long non-interactive beds (menu), `<audio>` streaming is fine.
- Chrome allows ~6 concurrent `AudioContext`s — we use exactly **one**.

---

## 4. Unit barks / acknowledgments and UI feedback: procedural vs sampled

Research verdict: **hybrid — sampled for barks, procedural as fallback/net for
UI and simple SFX.**

- **Procedural-only is a known anti-pattern for shipped feel.** An audio design
  review of a web game that went procedural-only (oscillator blips for weapons)
  rated it CRITICAL: "sounds cheap/unprofessional, no unique audio identity, no
  layering, machine-gun effect" and recommended replacing with a sample-based
  system with 3–5 variations per cue, layered (mechanical + ballistic +
  tail/reverb), and randomized containers (pitch/volume variation, multi-shot)
  so nothing sounds identical twice ([trebuchetnetwork/massive_game_server
  audio review](https://github.com/trebuchetnetwork/massive_game_server/blob/HEAD/docs/archive/reports/AUDIO_DESIGN_REVIEW.md);
  [testbee game-audio-engineer skill](https://github.com/testbeeai-ui/testbee/blob/HEAD/.cursor/skills/game-audio-engineer/SKILL.md)).
- **Procedural strengths** (keep them where they fit): zero download cost,
  parameter-driven variation (engine rumble from filtered noise; footsteps from
  surface parameters), and guaranteed availability. Good for: UI clicks,
  ambient beds (granular synthesis never loops detectably), and as a **safety
  net** — one shipped web game synthesizes every SFX as fallback ("it is why
  the project has never shipped a silent event") with sampled packs layered
  over it ([capsfan900/vibegame1 audio-engineer doc](https://github.com/capsfan900/vibegame1/blob/HEAD/.claude/agents/audio-engineer.md)).
- **Unit barks specifically (RTS ack/move/attack lines):** the industry pattern
  is *sampled short lines with pitch/rate variation*, not runtime TTS. Runtime
  TTS in the browser is rejected: latency (hundreds of ms), cost per call, and
  it breaks offline play. **Build-time AI voice generation is the practical
  path**: ElevenLabs TTS is the working default for small teams ($22–99/mo;
  `eleven_multilingual_v2` for quality), Fish Audio as backup ($11–75/mo);
  voice rights records must be kept from day one, and AI VO is best for
  supporting lines/barks/narration while leads get human review
  ([elevenlabs comparison matrix](https://github.com/bborn/rex-marks-the-spot/blob/HEAD/docs/research/ai-voice-generation.md);
  [voice-tools indie-game-voiceover workflow](https://github.com/ryviuszero/voice-tools/blob/HEAD/src/content/workflows/indie-game-voiceover.md)). Note:
  PlayHT is **shutting down Dec 2025 — do not use**.
- Plan: generate ~40–80 short barks at build time (acknowledge, move, attack,
  build-complete, under-attack, victory/defeat announcements; 2–4 unit voice
  archetypes + advisor voice), store as mono MP3/Opus in a sprite file, play
  through the positional pool with ±5% pitch and ±10% rate variation. Keep a
  procedural synth fallback per cue so the game never ships a silent event.

---

## 5. Sourcing background music

### 5.1 Requirements for candidate tracks

For the adaptive design in §1 we need, per biome/state (PEACE/TENSION/WAR ×
mission sets + MENU + VICTORY/DEFEAT stingers):

- Loops of 30–90 s with **seamless loop points** (no-gap encoding — see §6).
- Matching **tempo/key/bar count** across stems for a given state set.
- Orchestral-cinematic-modern palette (the game is set in 2026; think city
  ambience + cinematic percussion — not fantasy flutes).
- License must permit: embedding in a **free browser game** distributed via
  GitHub Pages, commercial-adjacent use (repo is public; let's-players will
  stream it — so **Content ID safety** matters), modification (cutting loops,
  ducking), no runtime attribution obligation if possible.

### 5.2 Candidate sources (verified Sept 2026)

| Source | URL | License | Cost | Verdict |
|---|---|---|---|---|
| **Tallbeard "Abstraction" FREE Music Loop Bundle** | <https://tallbeard.itch.io/music-loop-bundle> | **CC0 1.0** (public domain dedication; verified in pack's license file) | Free; donations requested | **Primary candidate for loops.** 200+ loop-ready tracks; artist confirms all music is **Content ID free** (safe for streamers). Fine for commercial use & modification. Nuance: artist "does not endorse" NFT/AI-ML projects — stated as *permitted within the license terms* (i.e. allowed, not endorsed); AI-opponent gameplay is not AI training, but note the nuance. Chiptune-leaning; audition for cinematic-modern fit. |
| **Pixabay Music** | <https://pixabay.com/music/> | Pixabay Content License: **free commercial use, no attribution, modification allowed**; **no standalone redistribution** (embedding in a game is fine); license is per-track — verify each track page, terms have changed before | Free | Strong for orchestral-cinematic tracks; large catalog, uneven quality. **Caveat:** Pixabay warns artists may have distributed the same track via commercial catalogs → **Content ID claims possible**; mitigation = per-track blacklist when claims appear. |
| **Kevin MacLeod / Incompetech** | <https://incompetech.com> | **CC BY 4.0** — free incl. commercial, attribution required on a Credits screen | Free / paid no-attribution licenses ($30/1 song) | Huge catalog, but **Content ID risk for players**: an in-game credit satisfies the license, yet streamers of the game still get claims unless they credit in their own video description (per Incompetech's own Content ID page). Use only if we accept that burden or buy no-attribution licenses. |
| **SoundImage.org (Eric Matyas)** | <https://soundimage.org> | Custom CC-BY-shaped license: commercial OK, **attribution required in the actual game** | Free; donation | Thousands of OGG loop-oriented tracks (author explicitly: "Ogg for games — loops gaplessly; MP3 discards tail data"). Good fantasy/action library; less modern-cinematic. |
| **Kenney audio** | <https://kenney.nl/assets/category:Audio> | **CC0** | Free | Music jingles only — UI/stingers, not full BGM. |
| **Sonniss GDC Game Audio Bundle** | via <https://sonniss.com> (annual) | Royalty-free, **commercial OK, no attribution** (verify license text at download — catalog: [`tmhsdigital/free-game-dev-assets`](https://github.com/TMHSDigital/Free-Game-Dev-Assets)) | Free | Professional SFX library — for SFX, not music. |
| **Artlist / Epidemic Sound / Soundstripe** | artlist.io / epidemicsound.com | Subscription ($10–25/mo); **Epidemic Sound video-game use requires Enterprise plan** — standard plans do *not* cover games | $120–300+/yr | Rejected for now: recurring cost, and standard licenses don't cover games (Epidemic). |
| **YouTube Audio Library** | studio.youtube.com | Mixed: some tracks no-attribution, some require it; clearly labeled | Free (Google account) | Decent fallback for individual tracks; license terms prohibit some redistribution forms — verify per track. |

### 5.3 Generative / adaptive composition option

- **In-browser generative (Tone.js runtime):** rejected — "AAA feel" needs
  real orchestral recordings; synth-generated loops sound cheap (§2.1), and
  generative music conflicts with the vertical-stem design (stems must share
  harmonic DNA, which needs composition, not randomness).
- **Build-time AI composition (ElevenLabs Music API, Suno/Udio-class):**
  ElevenLabs now exposes a Music API (`music.compose` with prompt + duration)
  usable at build time. Quality for orchestral-cinematic loops is plausible
  but unverified; licensing of AI-generated music for redistribution is a
  gray area, and the Tallbeard license nuance above ("does not endorse AI/ML")
  shows rights-holders are sensitive. **Recorded as experimental fallback:**
  audition once in the build phase; primary stays human-composed sourced
  tracks. Never runtime generation (latency, cost, offline).
- **Smarter middle path (recommended for the adaptive engine):** compose
  stems by *editing* sourced loops — extract/cut percussive layers from a
  WAR loop to make the TENSION stem, crossfade a filtered version of PEACE,
  add procedural percussion (taiko-ish drum synthesis at build time) over a
  sourced harmonic bed. This gets adaptive behavior from a small track budget.

### 5.4 Music sourcing plan: primary + fallback

- **Primary:** curate 6–10 loops from the **Tallbeard Abstraction bundle
  (CC0)** + 4–8 cinematic tracks from **Pixabay Music** (per-track license
  verified at curation time, Content ID blacklist maintained). Total shipped
  music target: **~15–25 MB** (see §6.3).
- **Fallback:** SoundImage.org OGG loops (attribution in credits screen) or
  Kevin MacLeod tracks with paid no-attribution licenses if a specific mood
  can't be found elsewhere. AI-generated stems only as a last resort after
  the user signs off on the rights posture.

---

## 6. File formats, compression, loading strategy

### 6.1 Codec choice

- **MP3 is the universal baseline**: decodes everywhere (Chrome, Firefox,
  Safari incl. iOS), patents expired 2017 → license-free. **AAC** is universal
  too but sits in a patent pool (Via LA) — avoid for encoding.
- **Opus** is the best quality-per-byte but Safari support is fragmented as of
  mid-2026: Safari 18.4 added Opus-in-Ogg (iOS 18.4+/macOS Sequoia+), Opus-in-MP4
  via MSE still returns false, and Safari's capability *strings* lie
  (`canPlayType`/`isTypeSupported` say yes, actual `decodeAudioData` refuses on
  some devices) — measured 2026-09-12
  ([ambisonic-box iOS-Safari doc](https://github.com/mormegil6/ambisonic-box/blob/HEAD/docs/IOS-SAFARI.md)).
  Conclusion: **never trust string probes; probe by actually decoding a 1 KB
  Opus buffer** at init, or simply ship MP3.
- **Recommendation: ship both** — author assets once, encode to **Opus-in-WebM
  (primary) + MP3 (fallback)**. Loader picks Opus only after a real decode
  probe succeeds; otherwise MP3. SFX: mono, 48–64 kbps Opus / 64–96 kbps MP3.
  Music: stereo, ~96–128 kbps Opus / 128–160 kbps MP3. WAV/FLAC only as
  build intermediates, never shipped.
- **Loop gap warning:** MP3 encoders discard tail data → audible gap on loop;
  Ogg/Opus loop gaplessly (Eric Matyas' guidance). For seamless music loops,
  prefer the Opus file when available; if MP3-only, trim encoder delay or
  accept a crossfaded loop in-engine.

### 6.2 Loading / streaming strategy

- **Preload & decode during loading screen**: `fetch → arrayBuffer →
  decodeAudioData` for the sprite + first-level stems. **Never decode on
  first play** — it causes an audible hitch (multiple sources).
- **Sprites:** UI + common SFX in 1–2 sprite files (~200–500 KB total);
  rare/long cues (explosions, stingers) as individual files.
- **Music:** stems are short loops (30–90 s, ~1–2 MB each) → decode to
  `AudioBuffer` for sample-accurate bar-locked scheduling (§1.2). Long
  non-interactive beds (menu) may stream via `<audio>` +
  `MediaElementAudioSourceNode` to save RAM.
- **Lazy load per mission/skirmish map:** fetch that map's music set when the
  map loads, release (`releaseClip`) on scene change; keep a bounded PCM cache
  (~16 MiB retained + in-flight).
- **Autoplay policy:** create the `AudioContext` lazily on the first user
  gesture (click/tap on menu), resume on `visibilitychange`. If context is
  suspended, drop playback requests instead of queueing them (no resume burst).
- **Pause/save:** pausing suspends the `AudioContext` (all audio freezes,
  zero CPU); music scheduler state (bar/beat position) is saved in the save
  file so resume restarts the stem at the right bar. Mute/volume settings
  persist.

### 6.3 Bundling / repo-size strategy

- GitHub Pages has no server-side processing and a soft repo-size pressure
  (Git repos get unwieldy past ~1 GB; Pages deploys should stay small).
  **Budget: ~40–60 MB total audio in the repo** (music ~25 MB, SFX/voice
  ~10 MB, UI ~1 MB). Encode once at the sizes above; do not commit WAV
  masters (keep them in a separate asset archive, not the repo).
- `assets/audio/LICENSES.yml` manifest per shipped file: `{ file, sha256,
  source-url, license (SPDX), author }` — a CI gate refuses undeclared assets
  (pattern from [fs.gg audio report](https://github.com/fs-gg/fs.gg.game/blob/HEAD/docs/reports/2026-07-05-game-audio-library-architecture.md)).
  This is how we stay audit-clean with CC0/CC-BY/Pixabay mixes.

---

## 7. Recommendation (firm)

### 7.1 Audio architecture

**Module `game/src/audio/` — raw Web Audio API, no runtime audio library.**

```
UI / sim events
      │  (cue queue: plain records {id, pos?, priority}; no Web Audio imports in sim/)
      ▼
┌─────────────────────────────────────────────────────────┐
│ AudioEngine (owns the single AudioContext, lazy on first │
│ gesture; latencyHint 'interactive')                      │
│  ├─ MusicDirector — lookahead scheduler (25 ms tick /    │
│  │   100 ms lookahead on ctx.currentTime); state machine │
│  │   PEACE→TENSION→WAR→VICTORY→PEACE; vertical stems +   │
│  │   bar-locked horizontal switches; −6 dB ducking under │
│  │   barks; tempo/transport owned here, not in a lib     │
│  ├─ SfxPool — 32 pre-allocated voice slots (GainNode +   │
│  │   PannerNode each); priority steal/drop + telemetry;  │
│  │   per-play AudioBufferSourceNode (one-shot is normal) │
│  ├─ Buses: sfxBus / musicBus / voiceBus / uiBus →        │
│  │   masterGain → destination; slider→gain is quadratic   │
│  ├─ SpriteLoader — decode-once sprite + per-cue offsets  │
│  └─ Settings: master/music/sfx/voice volumes, 3D-audio   │
│     quality (HRTF near-field on/off), persisted          │
└─────────────────────────────────────────────────────────┘
```

Key decisions and why:

1. **No Howler/Tone at runtime.** The adaptive music engine needs bespoke
   scheduling regardless; Howler's conveniences (sprites, unlock, fades) are
   ~300 lines of our own code and its last release is 2023. Tone.js is kept
   as a *build-time composition tool* only.
2. **32-voice SFX pool, equal-power panners by default**, HRTF for
   near-field/important cues (settings toggle). Listener follows the camera
   every frame via `.value` sets.
3. **Sampled barks + SFX with randomized containers** (pitch/volume
   variation, 3–5 variants/cue); **procedural synth as the guaranteed
   fallback** so no event is ever silent. UI sounds lean procedural to keep
   the sprite small.
4. **Opus-primary/MP3-fallback** with a real decode probe; loop-critical
   music prefers Opus (gapless).
5. **Pause = `ctx.suspend()`** (freezes everything, zero CPU); save file
   stores music bar position for clean resume.

### 7.2 Music sourcing plan

- **Primary (build phase):** curate from **Tallbeard Abstraction CC0 bundle**
  (loop-ready, Content ID free — safe for let's-players) + **Pixabay Music**
  cinematic tracks (per-track license re-verified at curation; Content ID
  blacklist maintained). Target ~15–25 MB shipped.
- **Fallback:** SoundImage.org OGG loops (in-game attribution) or paid
  no-attribution Kevin MacLeod licenses for specific moods. AI-generated
  stems only with explicit user sign-off on the rights posture.
- **Hygiene:** `assets/audio/LICENSES.yml` manifest (file, sha256,
  source-url, SPDX license, author) + CI gate; no WAV masters in the repo;
  total audio budget ~40–60 MB.

### 7.3 Open questions for later phases

- Audition: do the Tallbeard loops hit the "modern 2026 cinematic" bar, or
  do we need paid curation? (Build-phase listening test.)
- Voice archetypes: 2–4 unit voices + advisor — ElevenLabs generation at
  build time; confirm the per-bark cost and keep rights records.
- Mobile: verify the equal-power default is enough on phone speakers, and
  that the 32-voice pool doesn't contend with the sim on low-end devices
  (profile on target hardware per the testing doc).

---

## 8. Dead ends and rejected options

| Option | Why rejected |
|---|---|
| FMOD / Wwise middleware | Native SDKs; unusable in a static GitHub Pages build. |
| Tone.js at runtime | ~100 KB+ bundle, CPU overhead on mobile, and its DAW transport fights the custom adaptive scheduler we need anyway. Build-time composition only. |
| Howler.js | Thin value over raw Web Audio for our needs; last release 2023; we reimplement its useful bits (sprites, unlock) in our own module and keep full control. Revisit only if iOS unlock handling proves buggy in testing. |
| Artlist / Epidemic Sound / Soundstripe subscriptions | Recurring cost; Epidemic Sound's standard plans **exclude video games** (Enterprise only). |
| Kevin MacLeod as primary BGM | CC-BY is fine, but Content ID claims hit *players who stream the game* — an in-game credits screen doesn't protect them. Only with paid no-attribution licenses or as fallback. |
| Runtime TTS for unit barks | Latency (hundreds of ms), per-call cost, breaks offline play. Build-time generation → sampled playback instead. |
| Procedural-only SFX | Ships "cheap"; no identity, machine-gun fatigue. Procedural is the fallback layer, not the primary. |
| PlayHT for voice generation | **Shutting down Dec 2025.** |
| `<audio>` elements for SFX | High latency, limited concurrency, inconsistent mobile behavior. Web Audio for SFX; `<audio>` only for long streaming music beds. |
| Trusting `canPlayType`/`isTypeSupported` for Opus | Safari's string surfaces lie on some devices (say yes, decode refuses). Probe by actually decoding. |
| Opus-in-MP4 via MSE on Safari | `isTypeSupported` false, no roadmap signal. Don't wait on Apple. |
| WASM audio engine (e.g. custom mixer) | Unearned complexity — Web Audio already renders on its own thread; our perf risk is voice count, not mixing. Revisit only if profiling shows otherwise. |
| Runtime generative music | Conflicts with stem design (harmonic DNA needs composition), sounds cheap for "AAA feel", and costs/latency/offline problems. |

---

## 9. Sources

1. Wikipedia — "Adaptive music" (vertical orchestration / horizontal re-sequencing): <https://en.wikipedia.org/wiki/Adaptive_music>
2. "How to Create Adaptive Game Music with AI Tools" (musicarthub.com, Sep 2026): <https://medium.com/@musicarthub.com/how-to-create-adaptive-game-music-with-ai-tools-98c9b3e10294>
3. eloc35/summer-engine-agent — adaptive-music SKILL.md (stem-wiring state machine): <https://github.com/eloc35/summer-engine-agent/blob/HEAD/skills/audio/adaptive-music/SKILL.md>
4. Chris Wilson — "A Tale of Two Clocks" (lookahead scheduler): <https://web.dev/articles/audio-scheduling>
5. waypostmaster/deckwave — beat-lock research (quantization latency budgets, onset JND): <https://github.com/waypostmaster/deckwave/blob/HEAD/docs/research/beat-lock-set-construction-sonification-export.md>
6. uvucs3660/summer_2026 — audio & procedural music cheatsheet (scheduler code, gotchas): <https://github.com/uvucs3660/summer_2026/blob/HEAD/content/cs3540/2026/cheatsheets/audio-and-procedural-music.md>
7. dlaunyc/supermetronome — research.md (transport/engine boundary, standards): <https://github.com/dlaunyc/supermetronome/blob/HEAD/.doc/research.md>
8. xhuozhong/codex-game-studio-plus — tools.md (Howler 2.2.4 vs Tone 15.1.22 notes): <https://github.com/xhuozhong/codex-game-studio-plus/blob/HEAD/skills/game-audio-director/references/tools.md>
9. byterefinery/skills — howler-js 2.2.4 SKILL.md (sprites, spatial, API): <https://github.com/byterefinery/skills/blob/HEAD/.agents/skills-javascript/howler-js-2-2-4/SKILL.md>
10. adewale/keyboardia — TONEJS-COMPARISON.md (Tone.js strengths/limits): <https://github.com/adewale/keyboardia/blob/HEAD/specs/research/TONEJS-COMPARISON.md>
11. rafeez1819/meditalk — building-games/references/audio.md (buses, sprites, formats, PannerNode): <https://github.com/rafeez1819/meditalk/blob/HEAD/.MediTalk/skills/building-games/references/audio.md>
12. shaostoul/humanity — audio-engine.md (native comparison; Web Audio ~32-voice practical ceiling): <https://github.com/shaostoul/humanity/blob/HEAD/docs/history/audio-engine.md>
13. senseidukes/audio-player — SPATIAL_AUDIO_GUIDE.md (HRTF vs equal-power): <https://github.com/senseidukes/audio-player/blob/HEAD/SPATIAL_AUDIO_GUIDE.md>
14. pmeenan/parallax — spatial-audio.md (32-voice engine design, suspend/drop rules): <https://github.com/pmeenan/parallax/blob/HEAD/docs/spatial-audio.md>
15. trebuchetnetwork/massive_game_server — AUDIO_DESIGN_REVIEW.md (procedural-only anti-pattern): <https://github.com/trebuchetnetwork/massive_game_server/blob/HEAD/docs/archive/reports/AUDIO_DESIGN_REVIEW.md>
16. capsfan900/vibegame1 — audio-engineer.md (procedural fallback safety net, CC0 credits): <https://github.com/capsfan900/vibegame1/blob/HEAD/.claude/agents/audio-engineer.md>
17. testbeeai-ui/testbee — game-audio-engineer SKILL.md (randomized containers, voice stealing): <https://github.com/testbeeai-ui/testbee/blob/HEAD/.cursor/skills/game-audio-engineer/SKILL.md>
18. bborn/rex-marks-the-spot — ai-voice-generation.md (ElevenLabs/Fish Audio comparison, PlayHT shutdown): <https://github.com/bborn/rex-marks-the-spot/blob/HEAD/docs/research/ai-voice-generation.md>
19. ryviuszero/voice-tools — indie-game-voiceover.md (AI VO for barks/narration, rights records): <https://github.com/ryviuszero/voice-tools/blob/HEAD/src/content/workflows/indie-game-voiceover.md>
20. tmhsdigital/free-game-dev-assets — audio catalog (Incompetech CC-BY-4.0 + Content ID caveat; SoundImage terms; CC0 starters): <https://github.com/TMHSDigital/Free-Game-Dev-Assets>
21. Tallbeard Studios — FREE Music Loop Bundle, CC0 1.0 (Content ID free per artist): <https://tallbeard.itch.io/music-loop-bundle>
22. Pixabay Content License (commercial use, no attribution, no standalone redistribution): <https://pixabay.com/service/license-summary/> — via [genlab audio-licensing doc](https://github.com/anarchistsid/genlab-platform/blob/HEAD/docs/audio-licensing.md)
23. soundimage.org (Eric Matyas) — OGG-for-games looping guidance, custom license: <http://soundimage.org/>
24. mormegil6/ambisonic-box — IOS-SAFARI.md (Safari Opus decode surfaces disagree; probe by decoding): <https://github.com/mormegil6/ambisonic-box/blob/HEAD/docs/IOS-SAFARI.md>
25. lsgmasa33/modoki-engine — audio-plan.md (MP3 universal baseline; iOS gate): <https://github.com/lsgmasa33/modoki-engine/blob/HEAD/docs/audio-plan.md>
26. fs-gg/fs.gg.game — 2026-07-05 game-audio-library-architecture.md (LICENSES.yml manifest + CI gate): <https://github.com/fs-gg/fs.gg.game/blob/HEAD/docs/reports/2026-07-05-game-audio-library-architecture.md>
27. alexleontovych/portfolio — CREDITS.md (real-world sprite example: 26 cues in 213 kB): referenced via search, portfolio repo.
