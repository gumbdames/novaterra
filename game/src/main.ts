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
import { GAME_TAGLINE, GAME_TITLE, GAME_VERSION } from './config';
import { generateTerrain, MERIDIAN_PLAINS } from './sim/terrain';
import { buildTerrainView } from './render/terrain';

/**
 * Boot the menu experience: renderer + Meridian Plains backdrop scene + menu
 * overlay.
 * Async because WebGPURenderer requires `await renderer.init()`.
 * Safe to call once; throws on unrecoverable renderer failure (the caller
 * surfaces it via showFatal()).
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

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

  buildMenuOverlay(app);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Gentle orbital drift so the backdrop visibly "lives".
  // The real game loop (fixed-timestep sim + interpolated render) takes over
  // once gameplay starts (a later step wires it in); this menu loop is
  // scaffolding only.
  const start = performance.now();
  renderer.setAnimationLoop(() => {
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
  });
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

/**
 * Menu stub: title + Skirmish / Missions (disabled) / Settings + version.
 * Buttons toast a "coming soon" note — the real UI (src/ui/) wires them up
 * during the vertical slice.
 */
function buildMenuOverlay(app: HTMLElement): void {
  const menu = document.createElement('div');
  menu.id = 'menu';

  const title = document.createElement('h1');
  title.textContent = GAME_TITLE;
  menu.appendChild(title);

  const tagline = document.createElement('p');
  tagline.className = 'tagline';
  tagline.textContent = GAME_TAGLINE;
  menu.appendChild(tagline);

  const buttons = document.createElement('div');
  buttons.className = 'buttons';

  const skirmish = document.createElement('button');
  skirmish.textContent = 'Skirmish';
  skirmish.addEventListener('click', () => {
    toast('Skirmish arrives with the Phase 1 vertical slice.');
  });

  const missions = document.createElement('button');
  missions.textContent = 'Missions';
  missions.disabled = true;
  missions.title = 'The campaign ships in Phase 2.';

  const settings = document.createElement('button');
  settings.textContent = 'Settings';
  settings.addEventListener('click', () => {
    toast('Settings arrive with the vertical slice.');
  });

  buttons.append(skirmish, missions, settings);
  menu.appendChild(buttons);

  const version = document.createElement('div');
  version.className = 'version';
  version.textContent = `v${GAME_VERSION} · scaffold`;
  menu.appendChild(version);

  app.appendChild(menu);
}

/** Small transient note for stub buttons. */
function toast(message: string): void {
  let el = document.getElementById('toast');
  if (el === null) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el?.classList.remove('show'), 2200);
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
