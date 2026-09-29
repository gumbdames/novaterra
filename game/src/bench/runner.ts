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
 * NOVATERRA — benchmark sweep runner (Phase 1, step 2).
 *
 * Browser only. Entry: `runBench(location.search)`, dynamically imported
 * from main.ts only when `?bench=1` is present, so the normal game bundle
 * never pays for this code (Vite code-splits it into its own chunk).
 *
 * Flow per sweep point: build scene → WARMUP_FRAMES warm-up frames →
 * MEASURE_FRAMES measured frames → dispose scene. Frame time is measured
 * as the rAF-to-rAF delta (what the player feels, vsync included), not the
 * CPU time inside render(). Draw calls / triangles come from
 * `renderer.info.render` right after each render (autoReset is on, so the
 * values are per-frame).
 *
 * Results land in three places:
 *  1. `window.__novaterra_bench` — raw JSON for automated extraction.
 *  2. The devtools console — console.table + text table + verdict.
 *  3. An on-page overlay — the text table, for screenshot-friendly runs.
 */
import { GAME_VERSION } from '../config';
import {
  MEASURE_FRAMES,
  WARMUP_FRAMES,
  parseBenchParams,
  sweepCounts,
  unitsFor,
  type BenchParams,
} from './config';
import { buildBenchScene } from './scene';
import { createRenderer } from '../render/renderer';
import { FrameStats, InfoStats } from './stats';
import {
  formatSummary,
  formatTable,
  withinBudget,
  type BenchReport,
  type SweepPointResult,
} from './format';

declare global {
  interface Window {
    /** Raw benchmark report JSON, set when a run completes. */
    __novaterra_bench?: BenchReport;
  }
}

/** One slow orbit per ~40 s at 60fps — the frame is never static. */
const ORBIT_PER_FRAME = (Math.PI * 2) / (40 * 60);

/** Breather between sweep points so GC/driver stalls don't pollute the next. */
const BETWEEN_POINT_PAUSE_MS = 300;

function raf(): Promise<number> {
  return new Promise((resolve) => {
    requestAnimationFrame((t) => resolve(t));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Report which backend actually initialized. three.js swaps
 * `renderer.backend` for the WebGL fallback inside init() when WebGPU is
 * unavailable, so checking after init() is reliable. The flag read mirrors
 * what three.js itself does internally (see Background.js in three r186).
 */
function detectActualBackend(renderer: {
  backend?: unknown;
}): 'webgpu' | 'webgl2' | 'unknown' {
  const backend = renderer.backend as
    | { isWebGLBackend?: unknown; isWebGPUBackend?: unknown }
    | undefined;
  if (backend?.isWebGLBackend === true) {
    return 'webgl2';
  }
  if (backend?.isWebGPUBackend === true) {
    return 'webgpu';
  }
  return 'unknown';
}

// --- Minimal on-page HUD (self-contained; doesn't touch style.css). ---

let hudEl: HTMLElement | null = null;

function setupHud(): void {
  const style = document.createElement('style');
  style.textContent = [
    '#bench-hud { position: fixed; top: 12px; left: 12px; z-index: 10;',
    '  max-width: min(92vw, 720px); max-height: 86vh; overflow: auto;',
    '  background: rgba(8, 12, 20, 0.88); color: #cfe3ff;',
    '  font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace;',
    '  padding: 10px 14px; border: 1px solid #274b73; border-radius: 8px;',
    '  white-space: pre-wrap; }',
    '#bench-hud .err { color: #ff9d9d; }',
    '#bench-hud .ok { color: #9dffb0; }',
  ].join('\n');
  document.head.appendChild(style);

  hudEl = document.createElement('div');
  hudEl.id = 'bench-hud';
  hudEl.textContent = 'NOVATERRA benchmark: starting…';
  document.body.appendChild(hudEl);
}

function setHud(html: string, cls?: 'err' | 'ok'): void {
  if (hudEl !== null) {
    hudEl.innerHTML = html;
    hudEl.className = cls ?? '';
  }
}

/** Full-screen, human-readable failure instead of a stuck HUD. */
function showFatal(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[novaterra] bench fatal error:', error);
  setHud(
    `<span class="err">Benchmark failed: ${escapeHtml(message)}</span>`,
    'err',
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Run the benchmark from a URL query string. Resolves when the full sweep
 * (or the single point) is done and reported.
 */
export async function runBench(search: string): Promise<void> {
  setupHud();

  const { params, problems } = parseBenchParams(search);
  if (problems.length > 0) {
    setHud(
      '<span class="err">Invalid bench params:</span>\n' +
        problems.map((p) => `• ${escapeHtml(p)}`).join('\n') +
        '\n\nSee game/src/bench/config.ts for the URL format.',
      'err',
    );
    return;
  }

  try {
    await runSweep(params);
  } catch (error) {
    showFatal(error);
  }
}

async function runSweep(params: BenchParams): Promise<void> {
  const app = document.getElementById('app');
  if (app === null) {
    throw new Error('bench: #app container missing from index.html');
  }
  // The bench owns the page; the menu scaffold is not built in bench mode.
  app.innerHTML = '';
  const canvas = document.createElement('canvas');
  app.appendChild(canvas);

  setHud(`Initializing renderer (requested backend: ${params.backend})…`);

  // createRenderer() keeps the bench chunk separate from the game bundle
  // (dynamic three.js import inside) and time-bounds init so a wedged GPU
  // fails loudly instead of hanging the harness.
  // forceWebGL: the step-1 scaffold reserved this flag for exactly this —
  // the mobile tier will force WebGL2 the same way (ARCHITECTURE.md §6).
  const renderer = await createRenderer(canvas, {
    forceWebGL: params.backend === 'webgl2',
  });

  // The renderer starts its own internal rAF loop inside init(), and that
  // loop calls renderer.info.reset() on every frame while info.autoReset
  // is true (the default). Our measurement loop drives frames manually, so
  // the internal reset races us: it lands between render() and our counter
  // read and zeroes every draws/tris sample. Take over the counters per
  // the documented contract for manual animation loops — no auto-reset,
  // one explicit reset() before each measured render instead.
  renderer.info.autoReset = false;

  const actual = detectActualBackend(renderer);
  const actualLabel =
    actual === 'webgl2' && params.backend === 'webgpu'
      ? 'webgl2 (auto-fallback)'
      : actual;
  if (actual === 'unknown') {
    throw new Error('bench: could not determine the active renderer backend');
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, params.dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (params.shadows) {
    renderer.shadowMap.enabled = true;
  }

  const report: BenchReport = {
    game: 'NOVATERRA',
    version: GAME_VERSION,
    requestedBackend: params.backend,
    actualBackend: actualLabel,
    shadows: params.shadows,
    dprCap: params.dprCap,
    warmupFrames: WARMUP_FRAMES,
    measureFrames: MEASURE_FRAMES,
    userAgent: navigator.userAgent,
    startedAt: new Date().toISOString(),
    results: [],
  };

  const counts = sweepCounts(params);

  let angle = 0;
  for (let ci = 0; ci < counts.length; ci++) {
    const buildings = counts[ci];
    if (buildings === undefined) {
      continue;
    }
    const units = unitsFor(buildings);
    setHud(
      `backend: ${escapeHtml(actualLabel)} · ` +
        `point ${ci + 1}/${counts.length}: ` +
        `${buildings} buildings + ${units} units…`,
    );

    const handle = buildBenchScene(buildings, units, params.shadows);
    const frames = new FrameStats();
    const info = new InfoStats();

    let prev = await raf();
    const total = WARMUP_FRAMES + MEASURE_FRAMES;
    for (let i = 0; i < total; i++) {
      angle += ORBIT_PER_FRAME;
      handle.setOrbitAngle(angle);
      // Exact per-frame counters on both backends: reset, render, read.
      // (WebGPU accumulates across frames without the reset; the internal
      // rAF loop's reset is disabled above via info.autoReset = false.)
      renderer.info.reset();
      renderer.render(handle.scene, handle.camera);
      const now = await raf();
      if (i >= WARMUP_FRAMES) {
        frames.push(now - prev);
        info.push(
          renderer.info.render.drawCalls,
          renderer.info.render.triangles,
        );
      }
      prev = now;
    }
    handle.dispose();

    const fs = frames.summary();
    const is = info.summary();
    const point: SweepPointResult = {
      buildings,
      units,
      avgMs: fs.avgMs,
      p95Ms: fs.p95Ms,
      minMs: fs.minMs,
      maxMs: fs.maxMs,
      fps: fs.fps,
      avgDrawCalls: is.avgDrawCalls,
      avgTriangles: is.avgTriangles,
      maxTriangles: is.maxTriangles,
      withinBudget: false,
    };
    point.withinBudget = withinBudget(point);
    report.results.push(point);

    await sleep(BETWEEN_POINT_PAUSE_MS);
  }

  // 1. Machine-readable JSON for automated extraction.
  window.__novaterra_bench = report;

  // 2. Console: structured table + text table + verdict.
  console.log(
    `%c[novaterra] render benchmark — ${actualLabel}`,
    'font-weight: bold',
  );
  console.table(
    report.results.map((r) => ({
      buildings: r.buildings,
      units: r.units,
      'avg ms': Number(r.avgMs.toFixed(2)),
      'p95 ms': Number(r.p95Ms.toFixed(2)),
      fps: Number(r.fps.toFixed(1)),
      draws: Math.round(r.avgDrawCalls),
      tris: Math.round(r.avgTriangles),
      budget: r.withinBudget ? 'OK' : 'OVER',
    })),
  );
  console.log(formatTable(report));
  console.log(formatSummary(report));

  // 3. On-page overlay with the text table.
  setHud(
    `<span class="ok">Benchmark complete — ${escapeHtml(actualLabel)}.</span>\n` +
      `Raw JSON: window.__novaterra_bench (see console for the table).\n\n` +
      escapeHtml(formatTable(report)) +
      `\n\n${escapeHtml(formatSummary(report))}`,
    'ok',
  );
}
