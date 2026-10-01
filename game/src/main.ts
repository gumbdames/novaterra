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
 * NOVATERRA — application entry point (0.1 Alpha).
 *
 * Responsibilities:
 *  - Create the three.js renderer (WebGPURenderer from `three/webgpu`,
 *    which auto-falls-back to a WebGL2 backend when WebGPU is unavailable —
 *    see ARCHITECTURE.md D1), the living menu demo (workstream X: a seeded
 *    sandbox world that plays itself behind the menu through the real
 *    command queue — see ui/demoDirector.ts), and the menu stub.
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
import { buildTerrainView, type TerrainView } from './render/terrain';
import { createRenderer, applyEnvironmentLighting } from './render/renderer';
import { MainMenu, loadSettings, type QualityLevel } from './ui/menus';
import { AudioEngine } from './audio/engine';
import { startGame } from './ui/game';
import type { AIDifficulty } from './sim/ai';
import { createSaveStore } from './netSave/store';
import { validateSaveVersion, saveMapPreset } from './netSave/savefile';
import { CorruptSaveError } from './sim/snapshot';
import { SaveSlotsDialog } from './ui/saveslots';
import { STRINGS } from './ui/strings';
import { getMission, type MissionDef } from './campaign/missions';
import {
  createCampaignStore,
  recordCompletion,
  type CampaignProgress,
  type CampaignStore,
} from './campaign/progress';
import { MissionSelect, MissionBriefing } from './ui/campaignUi';
import type { MissionEndResult } from './ui/game';
// Workstream X — the living menu demo: a seeded sandbox world that plays
// itself behind the menu through the real command queue. All three
// modules are side-effect-free at import (no DOM/GPU at module scope),
// keeping this file's Node-import safety for the smoke tests.
import {
  createDemoSession,
  DemoDirector,
  stepDemo,
  DEMO_FRAME_BUDGET,
} from './ui/demoDirector';
import { EntityRenderer } from './render/entities';
import {
  LazyModelStore,
  bootModelKeys,
  keysForKind,
} from './render/lazyModels';
import { MODEL_PATHS, type LoadedModel } from './render/models';

/** A running living-menu demo: director + entity views (workstream X). */
interface MenuDemo {
  director: DemoDirector;
  entities: EntityRenderer;
}

/**
 * Menu hooks for flows that leave the menu (missions, load-game): the
 * living demo must stop and drop its world/models before a game starts,
 * and a fresh demo starts on return.
 */
export interface MenuFlowHooks {
  onLeaveMenu: () => void;
  onReturnToMenu: () => void;
}

/**
 * Boot the menu experience: renderer + living menu demo (workstream X) +
 * menu overlay.
 * Async because renderer creation requires `await createRenderer(canvas)`.
 * Safe to call once; throws on unrecoverable renderer failure (the caller
 * surfaces it via showFatal()).
 *
 * Menu ↔ game flow: the menu keeps its own renderer + living backdrop.
 * Starting a skirmish stops the demo, drops its world completely (the
 * game always builds its own session via createSession — the demo can
 * never leak into a real game), and hands the #app container to the game
 * controller; exiting the game disposes it and a fresh demo starts behind
 * the menu. If the demo fails to start, the menu falls back to the old
 * static Meridian Plains terrain backdrop.
 */
export async function boot(): Promise<void> {
  const app = document.getElementById('app');
  if (app === null) {
    throw new Error('boot: #app container missing from index.html');
  }

  // Renderer: WebGPU primary, automatic WebGL2 fallback (locked stack D1).
  // createRenderer() probes the GPU channel with timeouts first, so a wedged
  // GPU can never hang boot on a blank page (see render/renderer.ts).
  const canvas = document.createElement('canvas');
  app.appendChild(canvas);

  const renderer = await createRenderer(canvas);
  renderer.setSize(window.innerWidth, window.innerHeight);
  // Cap DPR: first step of the adaptive quality governor (ARCHITECTURE.md §6).
  applyMenuQuality(renderer, loadSettings().quality);

  // Base scene: sky, fog, lights, environment. Terrain + demo attach below.
  const scene = buildMenuScene();
  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    3000,
  );

  // -- Living menu demo (workstream X) ---------------------------------
  // `demo` is non-null while the menu owns the loop. The terrain view is
  // built once (same seed ⇒ identical terrain on every restart); the
  // model store is dropped when a game starts and rebuilt on return.
  let terrainView: TerrainView | null = null;
  let water: THREE.Mesh | null = null;
  let waterLevel = 0;
  let demo: MenuDemo | null = null;
  let demoModels: LazyModelStore | null = null;

  /** Model keys the demo movie can show: the boot set + the Storm Array. */
  function demoModelKeys(): string[] {
    return [...bootModelKeys(), ...keysForKind('stormArray')];
  }

  function ensureDemoModels(): Map<string, LoadedModel> {
    if (demoModels === null) {
      demoModels = new LazyModelStore(MODEL_PATHS);
      // After first paint: keys stream into the shared map in the
      // background (Cache API: offline-capable); entity views upgrade
      // from procedural fallbacks as they arrive — never blocks the menu.
      void demoModels.requestMany(demoModelKeys()).catch((err: unknown) => {
        console.warn('[menu] demo models failed to load; fallbacks in use:', err);
      });
    }
    return demoModels.map;
  }

  function dropDemoModels(): void {
    demoModels?.dispose();
    demoModels = null;
  }

  /**
   * (Re)start the living demo. Stops any running demo first. Returns true
   * when the demo is live; false → the caller uses the static backdrop.
   * Never throws (a throwing demo must not take down the menu).
   */
  function startDemo(): boolean {
    stopDemo();
    try {
      const director = new DemoDirector(createDemoSession());
      if (terrainView === null) {
        // One terrain view for the scene's lifetime: the demo regenerates
        // identical terrain every restart (fixed seed), so reusing the
        // view avoids a rebuild and a GPU-memory churn per loop.
        terrainView = buildTerrainView(director.session.terrain);
        scene.add(terrainView.group);
        water = terrainView.water;
        waterLevel = director.session.terrain.waterLevel;
      }
      const entities = new EntityRenderer(scene, ensureDemoModels(), {
        waterLevel: director.session.terrain.waterLevel,
        // Entity views ride on the terrain (units/buildings/roads/FX).
        terrain: director.session.terrain,
        // Per-kind instanced views: draw calls scale with distinct kinds,
        // never with entity count (Phase 0 draw-call ceiling).
        instanced: true,
      });
      entities.setCamera(camera);
      demo = { director, entities };
      return true;
    } catch (err) {
      console.error('[menu] living demo failed to start; static backdrop in use:', err);
      return false;
    }
  }

  function stopDemo(): void {
    // EntityRenderer.dispose() removes every mesh it added and frees its
    // GPU resources; the model map is caller-owned and survives (reused
    // across restarts, dropped when a game starts).
    demo?.entities.dispose();
    demo = null;
  }

  // Static fallback: plain Meridian Plains terrain, no demo (only used
  // when the demo fails to start — the wide orbit below keeps it alive).
  function ensureStaticTerrain(): void {
    if (terrainView !== null) return;
    const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
    terrainView = buildTerrainView(terrain);
    scene.add(terrainView.group);
    water = terrainView.water;
    waterLevel = terrain.waterLevel;
  }

  if (!startDemo()) ensureStaticTerrain();
  // Wide orbit for the static fallback (the demo drives its own camera).
  const orbitRadius = 300;
  const orbitHeight = 185;
  camera.position.set(0, orbitHeight, orbitRadius);

  // Final-review R5 (2026-10-01): the menu owns its own AudioEngine so
  // the peace track plays behind the menu (the game builds its own
  // engine on start; the menu engine is disposed on every game entry
  // and recreated on every return to the menu). Music starts on the
  // first user gesture (autoplay policy); the ambient city bed is
  // in-game only (no city behind the menu).
  let menuAudio: AudioEngine | null = null;
  const startMenuMusic = (): void => {
    if (menuAudio !== null) return;
    try {
      menuAudio = new AudioEngine();
      menuAudio.unlock();
      menuAudio.setMusicMood('peace');
    } catch {
      menuAudio = null;
    }
  };
  const stopMenuMusic = (): void => {
    menuAudio?.dispose();
    menuAudio = null;
  };
  const unlockMenuOnce = (): void => {
    startMenuMusic();
    window.removeEventListener('pointerdown', unlockMenuOnce);
    window.removeEventListener('keydown', unlockMenuOnce);
  };
  window.addEventListener('pointerdown', unlockMenuOnce);
  window.addEventListener('keydown', unlockMenuOnce);

  const menu = new MainMenu(app, {
    onStartSkirmish: (difficulty: AIDifficulty, mapPreset: string, peaceful: boolean) => {
      menu.hide();
      renderer.setAnimationLoop(null);
      canvas.style.display = 'none';
      // Entering a game discards the demo completely: stop its loop,
      // free its entity meshes, drop its world and its models. startGame
      // always builds a fresh session via createSession().
      stopDemo();
      dropDemoModels();
      stopMenuMusic();
      const seed = (Math.random() * 0x7fffffff) | 0;
      startGame(app, {
        seed,
        aiDifficulty: difficulty,
        mapPreset,
        // Grand-expansion Phase 8 (peaceful mode, workstream B,
        // 2026-09-30): the skirmish setup's peaceful toggle.
        peaceful,
        quality: loadSettings().quality,
        onExitToMenu: () => {
          canvas.style.display = '';
          startDemo();
          renderer.setAnimationLoop(menuLoop);
          menu.show();
          // Returning to the menu: music back on (this runs on a
          // button click — a real user gesture, so unlock works).
          startMenuMusic();
        },
      }).catch(showFatal);
    },
    onShowMissions: () => {
      void showMissions(app, menu, renderer, canvas, menuLoop, {
        onLeaveMenu: () => {
          stopDemo();
          dropDemoModels();
          stopMenuMusic();
        },
        onReturnToMenu: () => {
          startDemo();
          startMenuMusic();
        },
      });
    },
    onShowLoadGame: () => {
      void showLoadGame(app, menu, renderer, canvas, menuLoop, {
        onLeaveMenu: () => {
          stopDemo();
          dropDemoModels();
          stopMenuMusic();
        },
        onReturnToMenu: () => {
          startDemo();
          startMenuMusic();
        },
      });
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

  // Menu loop: the demo sim runs on a fixed tick budget (it can never
  // stall rendering), then the entity views sync. The camera orbits the
  // director's focus on a tick-derived angle — deterministic per tick,
  // so a slow frame delays the movie but never reorders it.
  const start = performance.now();
  const menuLoop = (): void => {
    const t = (performance.now() - start) / 1000;
    if (demo !== null) {
      stepDemo(demo.director, DEMO_FRAME_BUDGET);
      if (demo.director.done) {
        // The movie played out — restart it fresh (same seed, same movie).
        startDemo();
      }
    }
    if (demo !== null) {
      const world = demo.director.session.world;
      demo.entities.sync(world);
      const focus = demo.director.focus;
      const a = world.tick * 0.0011;
      camera.position.set(
        focus.x + Math.sin(a) * 150,
        85,
        focus.z + Math.cos(a) * 150,
      );
      camera.lookAt(focus.x, 6, focus.z);
    } else {
      // Static fallback: gentle orbital drift over the terrain.
      camera.position.set(
        Math.sin(t * 0.05) * orbitRadius,
        orbitHeight,
        Math.cos(t * 0.05) * orbitRadius,
      );
      camera.lookAt(0, 4, 0);
    }
    // Subtle water shimmer; render-side only, never touches the sim.
    if (water !== null) water.position.y = waterLevel + Math.sin(t * 0.8) * 0.15;
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
 * Menu scene base: gradient sky, fog, lights, environment lighting — no
 * terrain. The living demo (or the static fallback) attaches its own
 * terrain view; entity views ride on it via EntityRenderer's `terrain`
 * option. Replaces the old buildBackdropScene's scene half (terrain moved
 * to the demo/static paths so the demo session's terrain is reused).
 */
function buildMenuScene(): THREE.Scene {
  const scene = new THREE.Scene();

  // Gradient sky baked to a canvas texture (cheap, no shader yet).
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4;
  skyCanvas.height = 256;
  const ctx = skyCanvas.getContext('2d');
  if (ctx === null) {
    throw new Error('menu scene: 2d canvas context unavailable');
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

  // Lighting: hemisphere for sky bounce + one directional "sun" (the key
  // light), plus the shared procedural environment map so PBR metals on
  // entity views shade correctly (see render/renderer.ts).
  scene.add(new THREE.HemisphereLight(0x9db8dd, 0x1c2420, 0.9));
  const sun = new THREE.DirectionalLight(0xffe0b3, 1.6);
  sun.position.set(80, 120, 40);
  scene.add(sun);
  applyEnvironmentLighting(scene);

  return scene;
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
  hooks: MenuFlowHooks,
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
        // Friendly version check: older saves can't be loaded, but that's
        // not a crash — explain it in plain language and stay in the menu.
        const versionProblem = validateSaveVersion(file);
        if (versionProblem !== null) {
          menuToast(app, versionProblem);
          return;
        }
        menu.hide();
        renderer.setAnimationLoop(null);
        canvas.style.display = 'none';
        hooks.onLeaveMenu();
        // R1-C/C4: the save's map preset is authoritative for terrain —
        // a save from any non-default map (or any campaign mission) must
        // regenerate THAT terrain, not Meridian Plains. The mission def
        // is only the fallback for saves that predate the metadata
        // field (see saveMapPreset). Note: loading a campaign save
        // restores the world and its map, but not the scripted mission
        // director — that stays a fresh-session concern by design.
        const savedMission =
          file.metadata.campaignMissionId !== undefined &&
          file.metadata.campaignMissionId !== null
            ? getMission(file.metadata.campaignMissionId)
            : undefined;
        startGame(app, {
          seed: file.metadata.seed,
          aiDifficulty: file.metadata.aiDifficulty,
          mapPreset: saveMapPreset(file, savedMission?.mapPreset),
          quality: loadSettings().quality,
          saveData: file,
          onExitToMenu: () => {
            canvas.style.display = '';
            hooks.onReturnToMenu();
            renderer.setAnimationLoop(menuLoop);
            menu.show();
          },
          // Final-review R6 (2026-10-01): a malformed-but-readable save
          // throws CorruptSaveError out of restoreSnapshot. That is not
          // a fatal boot failure — unwind the menu teardown above,
          // explain in plain language, and stay in the menu.
        }).catch((err: unknown) => {
          if (err instanceof CorruptSaveError) {
            canvas.style.display = '';
            hooks.onReturnToMenu();
            renderer.setAnimationLoop(menuLoop);
            menu.show();
            menuToast(app, STRINGS.save.corruptSave);
            return;
          }
          showFatal(err);
        });
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
  hooks: MenuFlowHooks,
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
    hooks.onLeaveMenu();
    // Mission seed: fixed per mission so every president faces the same
    // term (deterministic campaign). Replays use the same seed.
    const seed = (mission.order * 2654435761) >>> 0;
    startGame(app, {
      seed,
      aiDifficulty: mission.aiDifficulty === 'none' ? 'citizen' : mission.aiDifficulty,
      quality: loadSettings().quality,
      onExitToMenu: () => {
        canvas.style.display = '';
        hooks.onReturnToMenu();
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
