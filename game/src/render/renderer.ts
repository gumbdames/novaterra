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
