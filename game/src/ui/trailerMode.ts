/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — ui/trailerMode.ts — the ?trailer=1 capture mode
 * (trailer workstream, 2026-10-01).
 *
 * Responsibilities:
 *  - Entry point for the scripted gameplay trailer: opened with
 *    `?trailer=1` (optional `&trailerseed=<n>` to re-shoot with a
 *    different seed — determinism still holds per seed).
 *    `?trailer=preview` plays the same movie watch-only: no recording,
 *    no download — just the film. Builds the
 *    renderer, the shared menu scene, the trailer session, terrain +
 *    entity views, and runs the `TrailerDirector` with the scripted
 *    trailer camera — no menu, no HUD, no player input.
 *  - Real-time pacing: the sim advances on a wall-clock accumulator at
 *    30 ticks/sec (capped catch-up so a slow machine slows the movie
 *    instead of spiraling). The movie is deterministic per tick, so the
 *    footage is identical regardless of frame rate.
 *  - Recording: starts a `MediaRecorder` capture of the render canvas
 *    automatically; when the director finishes, the recording stops and
 *    a `novaterra-trailer-<seed>.webm` download is triggered, with a
 *    manual download link + replay button as fallback. When capture is
 *    unsupported, an OBS-capture note is shown instead (see
 *    docs/trailer.md).
 *  - Title cards: the `TRAILER_TITLE_CARDS` schedule renders as styled
 *    in-game HUD overlays with CSS fade in/out.
 *
 * DOM + three.js + MediaRecorder; never imported by headless tests (it
 * is dynamically imported by main.ts only when ?trailer=1 is present).
 * No audio: the capture is video-only by design (see docs/trailer.md).
 */

import * as THREE from 'three';
import { buildMenuScene } from './menuScene';
import { createRenderer } from '../render/renderer';
import { buildTerrainView } from '../render/terrain';
import { EntityRenderer } from '../render/entities';
import { LazyModelStore, bootModelKeys, keysForKind } from '../render/lazyModels';
import { MODEL_PATHS } from '../render/models';
import {
  TrailerDirector,
  createTrailerSession,
  TRAILER_SEED,
  TRAILER_TITLE_CARDS,
  TRAILER_SHOTS,
  TRAILER_END_TICK,
} from './trailerDirector';
import { poseAtTick } from './trailerCamera';
import {
  createDayNightRig,
  applyDayNight,
  GOLDEN_HOUR_TICK,
} from '../render/dayNight';
import {
  startTrailerCapture,
  downloadTrailerRecording,
  type TrailerCapture,
} from './trailerCapture';

/** Sim ticks per wall-clock second: the movie plays in real time. */
const TRAILER_TICKS_PER_SECOND = 30;
/** Max sim ticks per frame: a slow machine slows the movie, never spirals. */
const TRAILER_MAX_TICKS_PER_FRAME = 4;

/** Model keys the trailer movie can show (boot set + trailer-specific). */
function trailerModelKeys(): string[] {
  return [
    ...bootModelKeys(),
    ...keysForKind('stormArray'),
    ...keysForKind('commercialHarbor'),
    ...keysForKind('cargoFreighter'),
    ...keysForKind('airportInterchange'),
    ...keysForKind('intelHQ'),
  ];
}

/**
 * Run the trailer capture mode. Takes over #app completely: renderer +
 * trailer session + director + scripted camera + title cards +
 * automatic recording. Resolves when the end overlay is shown (the
 * recording download has been triggered by then).
 */
export async function runTrailerMode(search: string): Promise<void> {
  const params = new URLSearchParams(search);
  const seedParam = params.get('trailerseed');
  const seed = seedParam !== null && seedParam !== '' ? Number(seedParam) >>> 0 : TRAILER_SEED;
  /** Preview mode: watch the movie, record nothing, download nothing. */
  const preview = params.get('trailer') === 'preview';

  const app = document.getElementById('app');
  if (app === null) {
    throw new Error('trailer: #app container missing from index.html');
  }
  const root: HTMLElement = app;
  root.innerHTML = '';

  const canvas = document.createElement('canvas');
  root.appendChild(canvas);
  const renderer = await createRenderer(canvas);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = buildMenuScene();
  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    3000,
  );

  // The trailer session: a fixed seed unless &trailerseed= overrides it
  // (still fully deterministic per seed).
  const director = new TrailerDirector(createTrailerSession(seed));

  const terrainView = buildTerrainView(director.session.terrain);
  scene.add(terrainView.group);
  const water = terrainView.water;
  const waterLevel = director.session.terrain.waterLevel;

  const models = new LazyModelStore(MODEL_PATHS);
  void models.requestMany(trailerModelKeys()).catch((err: unknown) => {
    console.warn('[trailer] models failed to load; fallbacks in use:', err);
  });
  const entities = new EntityRenderer(scene, models.map, {
    waterLevel,
    terrain: director.session.terrain,
    instanced: true,
  });
  entities.setCamera(camera);

  // Exploration bet C7 (2026-10-02): pin a fixed golden-hour phase.
  // ~7,400 captured ticks ≈ one full 240 s day cycle — a live sky would
  // strobe through day/night mid-movie. `keepBackground` preserves the
  // menu scene's baked sunset gradient; lights, water, windows and
  // shadows still take the golden-hour grade.
  const dayNightRig = createDayNightRig({
    scene,
    renderer,
    water: terrainView.water,
    setBlobShadowStrength: (f) => entities.setBlobShadowStrength(f),
  });
  applyDayNight(dayNightRig, GOLDEN_HOUR_TICK, 0, 0, { keepBackground: true });

  // Title-card overlay (in-game HUD, styled via style.css).
  const cardsEl = document.createElement('div');
  cardsEl.id = 'trailer-cards';
  const cardEls = TRAILER_TITLE_CARDS.map((card) => {
    const el = document.createElement('div');
    el.className = 'trailer-card';
    const title = document.createElement('div');
    title.className = 'trailer-card-title';
    title.textContent = card.title;
    const sub = document.createElement('div');
    sub.className = 'trailer-card-sub';
    sub.textContent = card.sub;
    el.appendChild(title);
    el.appendChild(sub);
    cardsEl.appendChild(el);
    return el;
  });
  root.appendChild(cardsEl);

  // Recording starts automatically — unless this is preview mode, where
  // the movie is watch-only. When unsupported, the OBS note covers the
  // fallback (docs/trailer.md has the full instructions).
  let capture: TrailerCapture | null = null;
  let captureNote: HTMLElement | null = null;
  if (preview) {
    captureNote = document.createElement('div');
    captureNote.id = 'trailer-capture-note';
    captureNote.textContent =
      'Preview mode — nothing is recorded. Use ?trailer=1 to shoot the trailer.';
    root.appendChild(captureNote);
  } else {
    capture = startTrailerCapture(canvas);
    if (capture === null) {
      captureNote = document.createElement('div');
      captureNote.id = 'trailer-capture-note';
      captureNote.textContent =
        'Recording is not supported in this browser — capture this page with OBS instead (see docs/trailer.md).';
      root.appendChild(captureNote);
    }
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let lastWall = performance.now();
  let acc = 0;
  let finished = false;
  const bootWall = performance.now();

  /** End-of-trailer: stop the loop, save the recording, show the outro. */
  function finish(): void {
    if (finished) return;
    finished = true;
    renderer.setAnimationLoop(null);
    const outro = document.createElement('div');
    outro.id = 'trailer-outro';
    const heading = document.createElement('div');
    heading.className = 'trailer-outro-title';
    heading.textContent = 'Trailer complete';
    outro.appendChild(heading);
    const finishRecording = async (): Promise<void> => {
      if (capture !== null) {
        try {
          const blob = await capture.stop();
          const url = downloadTrailerRecording(blob, `novaterra-trailer-${seed >>> 0}.webm`);
          const link = document.createElement('a');
          link.href = url;
          link.download = `novaterra-trailer-${seed >>> 0}.webm`;
          link.textContent = 'Download the recording again';
          link.className = 'trailer-outro-link';
          outro.appendChild(link);
          const size = document.createElement('div');
          size.className = 'trailer-outro-note';
          size.textContent = `Recorded ${(blob.size / 1048576).toFixed(1)} MB — check your downloads.`;
          outro.appendChild(size);
        } catch (err) {
          console.error('[trailer] failed to save the recording:', err);
        }
      }
      const replay = document.createElement('button');
      replay.textContent = 'Replay the trailer';
      replay.className = 'trailer-outro-button';
      replay.addEventListener('click', () => window.location.reload());
      outro.appendChild(replay);
    };
    if (captureNote !== null) {
      const note = document.createElement('div');
      note.className = 'trailer-outro-note';
      note.textContent = preview
        ? 'That was preview mode — nothing was recorded. Use ?trailer=1 to shoot the trailer.'
        : 'No recording was captured (unsupported browser) — use OBS next time.';
      outro.appendChild(note);
    }
    root.appendChild(outro);
    void finishRecording();
  }

  const trailerLoop = (): void => {
    if (finished) return;
    // Real-time pacing: wall-clock accumulator at 30 ticks/sec. The
    // movie is deterministic per tick — frame rate only changes how
    // smoothly the camera interpolates, never the script.
    const now = performance.now();
    const dt = Math.min(0.25, (now - lastWall) / 1000);
    lastWall = now;
    acc += dt * TRAILER_TICKS_PER_SECOND;
    let ticks = Math.floor(acc);
    if (ticks > TRAILER_MAX_TICKS_PER_FRAME) ticks = TRAILER_MAX_TICKS_PER_FRAME;
    acc -= ticks;
    const session = director.session;
    for (let i = 0; i < ticks; i += 1) {
      session.tick();
      director.update();
      if (director.done) break;
    }

    entities.sync(session.world);

    // Scripted camera: pose is a pure function of (tick, anchors).
    const anchors = director.cameraAnchors();
    const pose = poseAtTick(TRAILER_SHOTS, session.world.tick, anchors);
    camera.position.set(pose.pos.x, pose.pos.y, pose.pos.z);
    camera.lookAt(pose.look.x, pose.look.y, pose.look.z);
    if (Math.abs(camera.fov - pose.fov) > 0.01) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }

    // Title cards: exactly one visible at a time (schedules don't overlap).
    const tick = session.world.tick;
    for (let i = 0; i < TRAILER_TITLE_CARDS.length; i += 1) {
      // B27: no `!` — the loop bound keeps i in range; unreachable.
      const card = TRAILER_TITLE_CARDS[i];
      if (card === undefined) continue;
      const visible = tick >= card.startTick && tick < card.endTick;
      // B27: no `!` — cardEls is built in parallel with TRAILER_TITLE_CARDS; unreachable.
      const cardEl = cardEls[i];
      if (cardEl === undefined) continue;
      cardEl.classList.toggle('visible', visible);
    }

    // Subtle water shimmer; render-side only, never touches the sim.
    const t = (performance.now() - bootWall) / 1000;
    if (water !== null) water.position.y = waterLevel + Math.sin(t * 0.8) * 0.15;

    renderer.render(scene, camera);

    if (director.done || tick >= TRAILER_END_TICK) finish();
  };
  renderer.setAnimationLoop(trailerLoop);
}
