<!---
NOVATERRA — Copyright (C) 2026 Gumb Dames
Licensed under the GNU Affero General Public License v3.0.
See https://www.gnu.org/licenses/ for details.
-->

# NOVATERRA gameplay trailer — `?trailer=1` (0.1 Alpha)

A scripted, **real-gameplay** trailer: a deterministic in-game movie with
title cards and a scripted camera, recorded straight to a downloadable
`.webm`. No AI-generated video, no screen-capture software needed (though
OBS works as a fallback).

## How to shoot it

1. Open the game with the trailer flag:
   `https://gumbdames.github.io/novaterra/?trailer=1`
   (or `http://localhost:5173/?trailer=1` from a dev server).
2. The movie plays itself (~4 minutes). Recording starts automatically.
3. When it ends, a `novaterra-trailer-<seed>.webm` download is triggered
   automatically, with a manual download link + replay button as backup.

**Re-shoots:** `?trailer=1&trailerseed=12345` re-runs the same script on a
different world seed. The movie is fully deterministic per seed (same seed
→ same footage, verified by `tests/ui.trailer.test.ts`).

**Preview mode:** `?trailer=preview` plays the same movie watch-only — no
recording, no download. Just sit back and watch it.

**No audio:** the capture is video-only by design. Add music/voiceover in
post-production.

## What the trailer shows

Seven title cards over ~7,400 ticks (~4:07 at 30 ticks/s):

| Card | Ticks | Beat |
|------|-------|------|
| NOVATERRA | 0–270 | Opening |
| BUILD | 300–1040 | Zone a town, roads, houses, power/water |
| COMMAND | 1060–1560 | Barracks, war factory, army muster |
| OUTTHINK | 1580–2040 | Information age, intel HQ, spies, fighters |
| TRADE | 3240–4200 | Shipyard + trade docks, freighters on a sea route, airline |
| ENDURE | 5600–6600 | Elite army, assault on the rival, Storm Array strike |
| NOVATERRA | 7000–7400 | Closer |

The world is a **real skirmish** against a cadet AI rival (seed `0x7a11e4`):
the director issues real commands through the real command queue
(`issuer: 'trailer'`), the AI plays itself, the finale is a real battle
followed by a real Storm Array strike. The cadet AI never attacks, so the
script is safe — but everything on screen is genuine game simulation.

## Architecture

- `game/src/ui/trailerDirector.ts` — the script: 34 chapters firing on
  `world.tick`, each issuing real commands. Headless-safe; fully covered
  by tests (determinism, zero failures, world effects, schedule pinning).
- `game/src/ui/trailerCamera.ts` — pure scripted camera: 13 eased shots
  tiling the movie, anchored to live world state (town, harbor, army…).
- `game/src/ui/trailerCapture.ts` — MediaRecorder wrapper (vp9 → vp8 →
  default); returns `null` gracefully when unsupported.
- `game/src/ui/trailerMode.ts` — the `?trailer=1` DOM controller:
  renderer + scene + director + camera + title cards + recording.
  Dynamically imported by `main.ts`, so the normal game bundle never
  pays for it.
- `game/src/ui/menuScene.ts` — the shared menu sky/lighting builder
  (extracted from `main.ts` so the trailer renders the same look).

The sim is untouched: the trailer is UI-layer only, like the menu demo.

## OBS fallback

If the browser can't record (`MediaRecorder`/`captureStream` missing —
the trailer shows a note), capture the page with OBS instead:

1. Add a Window Capture of the `?trailer=1` page.
2. Record at 1080p60; the movie is 4:07, no interaction needed.
3. Mute the desktop audio or add your own track in post (the page is silent).

## For developers

- Determinism contract: `tests/ui.trailer.test.ts` runs the full movie
  twice and pins identical command logs + world digests; it also pins
  zero chapter failures, the title-card/camera schedules, and graceful
  capture degradation.
- The director's RNG is a director-owned bank seeded from the session
  seed — `world.rng` is never touched.
- To change the script, edit the chapters in `trailerDirector.ts`,
  the shots in `trailerCamera.ts` (kept gapless/overlap-free —
  `validateShots` enforces it), and the cards in `TRAILER_TITLE_CARDS`
  (kept non-overlapping). The test suite pins all three schedules.
