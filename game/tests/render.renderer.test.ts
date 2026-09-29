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
 * Tests for render/renderer.ts — the hang-proof renderer factory.
 *
 * The whole point of the module is bounding promises that may pend forever
 * (wedged GPU channel: navigator.gpu.requestAdapter() never settles). The
 * tests pin the timeout behavior with short deadlines and prove the module
 * stays import-safe under Node (no DOM/GPU at import time).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  ADAPTER_PROBE_TIMEOUT_MS,
  RENDERER_INIT_TIMEOUT_MS,
  RendererInitTimeoutError,
  webgpuAdapterReachable,
  withTimeout,
} from '../src/render/renderer';

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {
    /* pends forever, like requestAdapter() on a wedged GPU channel */
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('withTimeout', () => {
  it('resolves with the promise value when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, 'stage')).resolves.toBe(42);
  });

  it('rejects with RendererInitTimeoutError when the promise pends past the deadline', async () => {
    const err = await withTimeout(neverSettles<number>(), 20, 'requestAdapter()').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RendererInitTimeoutError);
    expect((err as Error).name).toBe('RendererInitTimeoutError');
    expect((err as Error).message).toContain('requestAdapter()');
    expect((err as Error).message).toContain('20ms');
  });

  it('propagates the underlying rejection instead of timing out', async () => {
    const boom = new Error('adapter exploded');
    const err = await withTimeout(Promise.reject(boom), 1000, 'stage').catch(
      (e: unknown) => e,
    );
    expect(err).toBe(boom);
  });

  it('does not pin the process: a timed-out race settles promptly', async () => {
    const start = Date.now();
    await withTimeout(neverSettles<void>(), 30, 'stage').catch(() => undefined);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('webgpuAdapterReachable', () => {
  it('returns false when there is no WebGPU (Node has navigator but no gpu)', async () => {
    // Node 21+ exposes a global navigator (userAgent etc.) but no WebGPU.
    expect((navigator as unknown as { gpu?: unknown }).gpu).toBeUndefined();
    await expect(webgpuAdapterReachable(20)).resolves.toBe(false);
  });

  it('returns false when navigator.gpu is absent', async () => {
    vi.stubGlobal('navigator', {});
    await expect(webgpuAdapterReachable(20)).resolves.toBe(false);
  });

  it('returns false when requestAdapter rejects', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: () => Promise.reject(new Error('nope')) },
    });
    await expect(webgpuAdapterReachable(20)).resolves.toBe(false);
  });

  it('returns false when requestAdapter resolves null (no adapter)', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: () => Promise.resolve(null) },
    });
    await expect(webgpuAdapterReachable(20)).resolves.toBe(false);
  });

  it('returns true when requestAdapter settles with an adapter', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: () => Promise.resolve({ features: new Set() }) },
    });
    await expect(webgpuAdapterReachable(50)).resolves.toBe(true);
  });

  it('returns false when requestAdapter pends past the deadline (wedged GPU)', async () => {
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: () => neverSettles() },
    });
    const start = Date.now();
    await expect(webgpuAdapterReachable(30)).resolves.toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('renderer timeout constants', () => {
  it('probe and init deadlines are bounded and sane', () => {
    // Generous for slow first-time GPU init, but finite: the whole point
    // is that boot can never hang forever.
    expect(ADAPTER_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ADAPTER_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(30000);
    expect(RENDERER_INIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RENDERER_INIT_TIMEOUT_MS).toBeLessThanOrEqual(60000);
  });
});
