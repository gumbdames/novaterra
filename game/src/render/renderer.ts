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
 * Hang-proof three.js renderer creation (0.1 Alpha).
 *
 * The hazard: `WebGPURenderer.init()` awaits `navigator.gpu.requestAdapter()`
 * (and then `adapter.requestDevice()`), and three.js r186 puts NO timeout on
 * either call. three.js only falls back to its WebGL2 backend when the
 * request *rejects* — but when the browser's GPU process is wedged (seen in
 * shared/automated Chromium profiles), `requestAdapter()` neither resolves
 * nor rejects: it pends forever. A bare `await renderer.init()` then hangs
 * the boot path forever on a blank page with zero feedback.
 *
 * This module adds two layers of defense, both bounded:
 *  1. Probe `navigator.gpu.requestAdapter()` with a timeout first. If the
 *     probe hangs or fails, construct the renderer with `forceWebGL: true`
 *     so three.js never touches the dead WebGPU channel at all. The hung
 *     probe promise is simply abandoned — no renderer, canvas, or animation
 *     loop is ever attached to it.
 *  2. Race the full `renderer.init()` against a second timeout. If init
 *     still hangs (narrow window: probe passed but `requestDevice()` later
 *     stalled), retry once on the same canvas with forced WebGL2, then give
 *     up with a clear error the caller surfaces via showFatal().
 *
 * Render-side only: no sim state, no gameplay logic. The returned renderer
 * honors the caller's explicit `forceWebGL` choice (used by ?bench=1) by
 * skipping the probe.
 */

import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';

/** How long the WebGPU adapter probe may pend before we give up on WebGPU. */
export const ADAPTER_PROBE_TIMEOUT_MS = 8000;
/** How long a full renderer.init() may pend before we retry / give up. */
export const RENDERER_INIT_TIMEOUT_MS = 20000;

/** Rejection reason when a renderer-stage promise pends past its deadline. */
export class RendererInitTimeoutError extends Error {
  constructor(stage: string, timeoutMs: number) {
    super(
      `Renderer init timed out: ${stage} pended longer than ${timeoutMs}ms. ` +
        'The browser GPU may be unavailable or wedged.',
    );
    this.name = 'RendererInitTimeoutError';
  }
}

export interface CreateRendererOptions {
  /**
   * Skip the WebGPU probe and force a backend. `true` always uses WebGL2;
   * `false` always tries WebGPU first. When omitted, the probe decides.
   */
  forceWebGL?: boolean;
}

/**
 * Race a promise against a deadline. The timer is cleared as soon as the
 * race settles; unref'd where available so a hung promise can't pin a
 * Node/vitest process open.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RendererInitTimeoutError(stage, timeoutMs)),
      timeoutMs,
    );
    // Don't pin Node open on the hang path (browsers ignore unref).
    const t = timer as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * True when `navigator.gpu.requestAdapter()` settles with an adapter inside
 * the timeout. False when WebGPU is absent, when the request rejects or
 * returns null, or when it pends past the deadline (wedged GPU channel).
 * Never throws.
 */
export async function webgpuAdapterReachable(
  timeoutMs: number = ADAPTER_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined') return false;
    const gpu = navigator.gpu;
    if (!gpu) return false;
    const adapter = await withTimeout(
      gpu.requestAdapter(),
      timeoutMs,
      'navigator.gpu.requestAdapter()',
    );
    return adapter !== null;
  } catch {
    return false;
  }
}

/**
 * Create and initialize a three.js renderer for the given canvas.
 *
 * WebGPU first (unless `opts.forceWebGL`), with automatic, time-bounded
 * fallback to WebGL2 when the GPU channel hangs or fails. Throws
 * `RendererInitTimeoutError` (or the underlying init error) only when every
 * path is exhausted — the caller's `.catch(showFatal)` turns that into the
 * fatal-error overlay instead of a silent blank page.
 *
 * Dynamic import keeps this module import-safe under Node/vitest (three.js
 * WebGPU touches browser globals at import time).
 */
export async function createRenderer(
  canvas: HTMLCanvasElement,
  opts: CreateRendererOptions = {},
): Promise<WebGPURenderer> {
  const { WebGPURenderer } = await import('three/webgpu');

  // Layer 1: probe the adapter channel before three.js can hang on it.
  const forceWebGL =
    opts.forceWebGL ?? !(await webgpuAdapterReachable());

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL,
  });
  try {
    await withTimeout(
      renderer.init(),
      RENDERER_INIT_TIMEOUT_MS,
      'renderer.init()',
    );
    return renderer;
  } catch (error) {
    // Layer 2: the probe passed but init() still hung (e.g. requestDevice()
    // stalled). One last resort on the same canvas with forced WebGL2.
    // (The hung renderer is abandoned: its canvas was never given a GPU
    // context, so reusing the canvas is safe.)
    if (!forceWebGL && error instanceof RendererInitTimeoutError) {
      const fallback = new WebGPURenderer({
        canvas,
        antialias: true,
        forceWebGL: true,
      });
      await withTimeout(
        fallback.init(),
        RENDERER_INIT_TIMEOUT_MS,
        'renderer.init() (WebGL2 fallback)',
      );
      return fallback;
    }
    throw error;
  }
}

/**
 * Attach a lightweight procedural environment map to a scene.
 *
 * The entity library leans on metalness for painted metal, hulls, and
 * glass — but a scene with no `scene.environment` shades every metal as
 * near-black (metals reflect the environment, not the lights). This
 * assigns a small procedural equirect texture (sky gradient, ground, soft
 * sun blob at the game's sun azimuth); the unified renderer
 * PMREM-processes equirect environment maps internally per backend
 * (three r186 `PMREMNode`), so roughness-correct reflections work on
 * both WebGPU and WebGL2 with no manual PMREM pass. (The legacy
 * `THREE.PMREMGenerator` from `three` core is WebGLRenderer-only and
 * crashes on the unified renderer — do not use it here.)
 *
 * `environmentIntensity` (0.5) keeps it a subtle fill — the game's own
 * sun/hemi lights stay the key light.
 *
 * The texture is shared process-wide (64x32, 8 KB) and must NOT be
 * disposed per scene. Synchronous and import-safe under Node/vitest
 * (DataTexture needs no DOM, same as the surface library).
 */
export function applyEnvironmentLighting(
  scene: THREE.Scene,
  intensity = 0.5,
): void {
  scene.environment = getEnvironmentTexture();
  scene.environmentIntensity = intensity;
}

let sharedEnvironmentTexture: THREE.DataTexture | null = null;

/** Process-shared equirect environment texture (see above). */
export function getEnvironmentTexture(): THREE.DataTexture {
  if (sharedEnvironmentTexture === null) {
    const px = generateEnvironmentPixels();
    const tex = new THREE.DataTexture(px.data, px.width, px.height);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    sharedEnvironmentTexture = tex;
  }
  return sharedEnvironmentTexture;
}

/**
 * 64x32 equirect: bright zenith fading to a pale horizon, dark ground
 * below, and a soft sun blob. The last row is the zenith: DataTexture
 * uploads with flipY=false, so texture v=1 is row y=height-1, which the
 * shader's equirectUv maps to the +y direction.
 */
function generateEnvironmentPixels(): {
  data: Uint8Array;
  width: number;
  height: number;
} {
  const width = 64;
  const height = 32;
  const data = new Uint8Array(width * height * 4);
  // The game's sun shines from (120, 180, 60) (ui/game.ts buildGameScene);
  // three's equirectUv uses u = atan2(dir.z, dir.x)/2PI + 0.5,
  // v = asin(dir.y)/PI + 0.5.
  const sunDir = new THREE.Vector3(120, 180, 60).normalize();
  const sunU = Math.atan2(sunDir.z, sunDir.x) / (Math.PI * 2) + 0.5;
  const sunV = (Math.asin(sunDir.y) / Math.PI) + 0.5;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      let r: number;
      let g: number;
      let b: number;
      if (v > 0.5) {
        // Sky: zenith (v=1) -> horizon (v=0.5).
        const t = (1 - v) / 0.5;
        r = 111 + (207 - 111) * t;
        g = 135 + (216 - 135) * t;
        b = 184 + (230 - 184) * t;
      } else {
        // Ground: dark soil, darker with depth.
        const t = v / 0.5;
        r = 60 + 30 * t;
        g = 54 + 28 * t;
        b = 42 + 24 * t;
      }
      // Soft sun blob (widened in u for the equirect stretch).
      const du = Math.min(Math.abs(u - sunU), 1 - Math.abs(u - sunU));
      const dv = v - sunV;
      const d = Math.hypot(du * 2, dv);
      const glow = Math.max(0, 1 - d / 0.18);
      const sun = glow * glow * 255;
      r += sun;
      g += sun * 0.95;
      b += sun * 0.85;
      const i = (y * width + x) * 4;
      data[i] = Math.min(255, r);
      data[i + 1] = Math.min(255, g);
      data[i + 2] = Math.min(255, b);
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}
