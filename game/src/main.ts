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
 * NOVATERRA — application entry point (Phase 1 scaffold).
 *
 * Responsibilities:
 *  - Create the three.js renderer (WebGPURenderer from `three/webgpu`,
 *    which auto-falls-back to a WebGL2 backend when WebGPU is unavailable —
 *    see ARCHITECTURE.md D1), the Meridian Plains backdrop scene, and the
 *    menu stub.
 *  - Nothing else. Game systems (sim/render/ui/audio) arrive in later steps
 *    behind the module boundaries in ARCHITECTURE.md §3.
 *
 * Import-safety: this module must stay importable in Node (vitest runs the
 * smoke tests with no DOM and no GPU). The `three/webgpu` renderer is
 * therefore imported *dynamically inside boot()*, and boot() itself only
 * runs when a real `document` exists. Static imports at the top are limited
 * to side-effect-free modules.
 *
 * The `?bench=1` URL branch (Phase 1, step 2 render benchmark) dynamically
 * imports `./bench/runner` instead of boot() — the normal boot path behaves
 * exactly as before and never loads the bench chunk.
 */

import * as THREE from 'three';
import './style.css';
import { generateTerrain, MERIDIAN_PLAINS } from './sim/terrain';
import { buildTerrainView } from './render/terrain';
import { MainMenu, loadSettings, type QualityLevel } from './ui/menus';
import { startGame } from './ui/game';
import type { AIDifficulty } from './sim/ai';
import { createSaveStore } from './net_save/store';
import { SaveSlotsDialog } from './ui/saveslots';
import { STRINGS } from './ui/strings';
import type { MissionDef } from './campaign/missions';
import {
  createCampaignStore,
  recordCompletion,
  type CampaignProgress,
  type CampaignStore,
} from './campaign/progress';
import { MissionSelect, MissionBriefing } from './ui/campaignui';
import type { MissionEndResult } from './ui/game';

/**
 * Boot the menu experience: renderer + Meridian Plains backdrop scene + menu
 * overlay.
 * Async because WebGPURenderer requires `await renderer.init()`.
 * Safe to call once; throws on unrecoverable renderer failure (the caller
 * surfaces it via showFatal()).
 *
 * Menu ↔ game flow: the menu keeps its own renderer + orbital backdrop.
 * Starting a skirmish hides the menu canvas (loop stopped) and hands the
 * #app container to the game controller; exiting the game disposes it and
 * the menu backdrop resumes.
 */
export async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (app === null) {
    throw new Error('boot: #app container missing from index.html');
  }

  // Renderer: WebGPU primary, automatic WebGL2 fallback (locked stack D1).
  // Dynamic import keeps this module import-safe under Node/vitest.
  const { WebGPURenderer } = await import('three/webgpu');
  const canvas = document.createElement('canvas');
  app.appendChild(canvas);

  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Cap DPR: first step of the adaptive quality governor (ARCHITECTURE.md §6).
  applyMenuQuality(renderer, loadSettings().quality);

  const { scene, water, waterLevel } = buildBackdropScene();
  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    3000,
  );
  // Wide orbit over the 512-unit map so the menu sits over living terrain.
  const orbitRadius = 300;
  const orbitHeight = 185;
  camera.position.set(0, orbitHeight, orbitRadius);

  const menu = new MainMenu(app, {
    onStartSkirmish: (difficulty: AIDifficulty, mapPreset: string) => {
      menu.hide();
      renderer.setAnimationLoop(null);
      canvas.style.display = 'none';
      const seed = (Math.random() * 0x7fffffff) | 0;
      startGame(app, {
        seed,
        aiDifficulty: difficulty,
        mapPreset,
        quality: loadSettings().quality,
        onExitToMenu: () => {
          canvas.style.display = '';
          renderer.setAnimationLoop(menuLoop);
          menu.show();
        },
      }).catch(showFatal);
    },
    onShowMissions: () => {
      void showMissions(app, menu, renderer, canvas, menuLoop);
    },
    onShowLoadGame: () => {
      void showLoadGame(app, menu, renderer, canvas, menuLoop);
    },
    onResume: () => undefined,
    onExitToMenu: () => undefined,
    onQualityChange: (q: QualityLevel) => applyMenuQuality(renderer, q),
  });
  menu.show();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Gentle orbital drift so the backdrop visibly "lives".
  const start = performance.now();
  const menuLoop = (): void => {
    const t = (performance.now() - start) / 1000;
    camera.position.set(
      Math.sin(t * 0.05) * orbitRadius,
      orbitHeight,
      Math.cos(t * 0.05) * orbitRadius,
    );
    camera.lookAt(0, 4, 0);
    // Subtle water shimmer; render-side only, never touches the sim.
    water.position.y = waterLevel + Math.sin(t * 0.8) * 0.15;
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(menuLoop);
}

/** Pixel-ratio cap for the menu backdrop, matching the game governor. */
function applyMenuQuality(
  renderer: { setPixelRatio(n: number): void },
  quality: QualityLevel,
): void {
  const cap = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
}

/**
 * Menu backdrop: gradient sky, fog, lights, and the real Meridian Plains
 * terrain (16 chunk meshes + water plane) generated deterministically from
 * the map seed. Replaces the step-1 placeholder diorama; the menu overlay
 * behavior is unchanged.
 *
 * Returns the scene plus the water mesh and level so the animation loop can
 * bob the water without re-querying the scene graph.
 */
function buildBackdropScene(): {
  scene: THREE.Scene;
  water: THREE.Mesh;
  waterLevel: number;
} {
  const scene = new THREE.Scene();

  // Gradient sky baked to a canvas texture (cheap, no shader yet).
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4;
  skyCanvas.height = 256;
  const ctx = skyCanvas.getContext('2d');
  if (ctx === null) {
    throw new Error('backdrop scene: 2d canvas context unavailable');
  }
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0.0, '#0b1e3a'); // zenith
  gradient.addColorStop(0.55, '#274b73'); // horizon glow
  gradient.addColorStop(0.62, '#d8a35f'); // sunset band
  gradient.addColorStop(1.0, '#1a2230'); // below horizon
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 256);
  const skyTexture = new THREE.CanvasTexture(skyCanvas);
  skyTexture.colorSpace = THREE.SRGBColorSpace;
  scene.background = skyTexture;
  scene.fog = new THREE.Fog(0x1a2230, 320, 1150);

  // Lighting: hemisphere for sky bounce + one directional "sun".
  scene.add(new THREE.HemisphereLight(0x9db8dd, 0x1c2420, 0.9));
  const sun = new THREE.DirectionalLight(0xffe0b3, 1.6);
  sun.position.set(80, 120, 40);
  scene.add(sun);

  // Real terrain: deterministic Meridian Plains, 16 chunks, water plane.
  // Generation is synchronous (~66k heightfield vertices of value noise +
  // meshing ≈ 150 ms one-time cost measured in Node on this VM's class of
  // machine; the browser number will differ). Acceptable for the boot path;
  // seeded mapgen-before-tick-0 is the sanctioned worker candidate later
  // (ARCHITECTURE.md §2).
  const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
  const view = buildTerrainView(terrain);
  scene.add(view.group);

  return { scene, water: view.water, waterLevel: terrain.waterLevel };
}

/** Full-screen, human-readable failure instead of a blank page. */
function showFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // Log the failure for diagnostics, then show the human-readable overlay.
  console.error('[novaterra] fatal boot error:', error);
  const el = document.createElement('div');
  el.id = 'fatal';
  el.textContent =
    `NOVATERRA could not start: ${message}. ` +
    'Please try a browser with WebGL2 or WebGPU support.';
  document.body.appendChild(el);
}

/** Tiny transient message on the main menu (no HUD there). */
function menuToast(root: HTMLElement, message: string): void {
  const el = document.createElement('div');
  el.className = 'menu-toast';
  el.textContent = message;
  root.appendChild(el);
  window.setTimeout(() => el.remove(), 3000);
}

/**
 * Main-menu "Load game": list saves, resume the picked one.
 * The menu backdrop stays alive behind the dialog; on load it hands
 * #app to the game controller exactly like a fresh skirmish.
 */
async function showLoadGame(
  app: HTMLElement,
  menu: MainMenu,
  renderer: { setAnimationLoop(cb: ((time: number) => void) | null): void },
  canvas: HTMLCanvasElement,
  menuLoop: () => void,
): Promise<void> {
  const store = await createSaveStore();
  const saves = await store.list();
  if (saves.length === 0) {
    menuToast(app, STRINGS.save.noSaves);
    return;
  }
  new SaveSlotsDialog(app, 'load', saves, {
    onPickSlot: (slotId) => {
      void (async () => {
        const file = await store.read(slotId);
        if (file === null) {
          menuToast(app, STRINGS.save.loadFailed);
          return;
        }
        menu.hide();
        renderer.setAnimationLoop(null);
        canvas.style.display = 'none';
        startGame(app, {
          seed: file.metadata.seed,
          aiDifficulty: file.metadata.aiDifficulty,
          quality: loadSettings().quality,
          saveData: file,
          onExitToMenu: () => {
            canvas.style.display = '';
            renderer.setAnimationLoop(menuLoop);
            menu.show();
          },
        }).catch(showFatal);
      })();
    },
    onClose: () => undefined,
  }).show();
}

/**
 * Phase 2 — "The First Term" campaign flow.
 *
 * Mission select → briefing → startGame (with campaign opts) → debrief.
 * Progress lives in memory for the session and persists to IndexedDB
 * (with memory fallback) on every mission end. `onMissionEnd` updates
 * the in-memory progress synchronously (the debrief needs it for the
 * final-mission ending) and saves asynchronously.
 */
async function showMissions(
  app: HTMLElement,
  menu: MainMenu,
  renderer: { setAnimationLoop(cb: ((time: number) => void) | null): void },
  canvas: HTMLCanvasElement,
  menuLoop: () => void,
): Promise<void> {
  const store: CampaignStore = await createCampaignStore();
  let progress: CampaignProgress = await store.load();
  const select = new MissionSelect(app, {
    onSelect: (mission: MissionDef) => {
      select.hide();
      new MissionBriefing(app, {
        onStart: (m: MissionDef) => startMission(m),
        onBack: () => select.show(progress),
      }).show(mission);
    },
    onBack: () => {
      select.hide();
      menu.show();
    },
  });

  function startMission(mission: MissionDef): void {
    menu.hide();
    renderer.setAnimationLoop(null);
    canvas.style.display = 'none';
    // Mission seed: fixed per mission so every president faces the same
    // term (deterministic campaign). Replays use the same seed.
    const seed = (mission.order * 2654435761) >>> 0;
    startGame(app, {
      seed,
      aiDifficulty: mission.aiDifficulty === 'none' ? 'citizen' : mission.aiDifficulty,
      quality: loadSettings().quality,
      onExitToMenu: () => {
        canvas.style.display = '';
        renderer.setAnimationLoop(menuLoop);
        select.show(progress);
      },
      campaign: {
        mission,
        onMissionEnd: (result: MissionEndResult): CampaignProgress => {
          if (result.victory) {
            progress = recordCompletion(progress, result.mission.id, result.kills, result.unitsLost);
            // Async save; the in-memory progress is already current for
            // the debrief screen.
            void store.save(progress);
          }
          return progress;
        },
      },
    }).catch(showFatal);
  }

  select.show(progress);
}

// Auto-boot only in a real browser. Under vitest (Node, no document) the
// module simply exports boot() for the smoke tests — see tests/smoke.test.ts.
if (typeof document !== 'undefined') {
  const benchRequested =
    new URLSearchParams(window.location.search).get('bench') === '1';
  if (benchRequested) {
    // Render benchmark harness (Phase 1, step 2). Dynamically imported so the
    // normal game bundle never pays for it: Vite code-splits src/bench into
    // a separate chunk that is only fetched with ?bench=1. See
    // game/src/bench/AGENTS.md for the URL params.
    import('./bench/runner')
      .then((mod) => mod.runBench(window.location.search))
      .catch(showFatal);
  } else {
    boot().catch(showFatal);
  }
}
