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
 * NOVATERRA — benchmark result formatting (Phase 1, step 2).
 *
 * Pure module: the JSON report shape exposed on `window.__novaterra_bench`,
 * the console text table, and the budget verdict. No DOM, no three.js.
 */
import type { BenchBackend } from './config';

/** One measured sweep point. */
export interface SweepPointResult {
  buildings: number;
  units: number;
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  fps: number;
  avgDrawCalls: number;
  avgTriangles: number;
  maxTriangles: number;
  withinBudget: boolean;
}

/**
 * Full benchmark report — this is the JSON shape on
 * `window.__novaterra_bench` after a run. Designed for automated
 * extraction: plain data, no class instances, stable field names.
 */
export interface BenchReport {
  game: 'NOVATERRA';
  /** game/package.json version at build time. */
  version: string;
  /** Backend requested via ?backend=. */
  requestedBackend: BenchBackend;
  /**
   * Backend that actually initialized: 'webgpu', 'webgl2', or
   * 'webgl2 (auto-fallback)' when WebGPU was requested but unavailable.
   */
  actualBackend: string;
  shadows: boolean;
  dprCap: number;
  warmupFrames: number;
  measureFrames: number;
  userAgent: string;
  /** ISO 8601 wall-clock start of the run. */
  startedAt: string;
  results: SweepPointResult[];
}

/**
 * Desktop 60fps budgets from ARCHITECTURE.md §6. A sweep point is "within
 * budget" only if all three hold. These gate content scale-up (step 12).
 */
export const BUDGET_P95_MS = 16.7;
export const BUDGET_DRAW_CALLS = 200;
export const BUDGET_TRIANGLES = 750000;

export function withinBudget(point: {
  p95Ms: number;
  avgDrawCalls: number;
  avgTriangles: number;
}): boolean {
  return (
    point.p95Ms <= BUDGET_P95_MS &&
    point.avgDrawCalls <= BUDGET_DRAW_CALLS &&
    point.avgTriangles <= BUDGET_TRIANGLES
  );
}

/** Format an integer with thousands separators (locale-independent). */
function fmtInt(n: number): string {
  const rounded = Math.round(n).toString();
  return rounded.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function padStart(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

function padEnd(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * Aligned plain-text table of the sweep results, for the console and the
 * on-page report. Example:
 *
 *   backend: webgpu (requested webgpu) · shadows on · dpr ≤ 2
 *   buildings | units | avg ms | p95 ms |  fps | draws |    tris | budget
 *         100 |    50 |    3.1 |    4.0 |  322 |     9 |  24,103 | OK
 */
export function formatTable(report: BenchReport): string {
  const lines: string[] = [];
  lines.push(
    `backend: ${report.actualBackend} (requested ${report.requestedBackend})` +
      ` · shadows ${report.shadows ? 'on' : 'off'} · dpr ≤ ${report.dprCap}`,
  );
  const header = ['buildings', 'units', 'avg ms', 'p95 ms', 'fps', 'draws', 'tris', 'budget'];
  const widths = [9, 5, 6, 6, 5, 5, 9, 6];
  lines.push(
    header.map((h, i) => padEnd(h, widths[i] ?? h.length)).join(' | '),
  );
  report.results.forEach((r) => {
    const cells = [
      padStart(fmtInt(r.buildings), 9),
      padStart(fmtInt(r.units), 5),
      padStart(r.avgMs.toFixed(1), 6),
      padStart(r.p95Ms.toFixed(1), 6),
      padStart(r.fps.toFixed(0), 5),
      padStart(r.avgDrawCalls.toFixed(0), 5),
      padStart(fmtInt(r.avgTriangles), 9),
      padEnd(r.withinBudget ? 'OK' : 'OVER', 6),
    ];
    lines.push(cells.join(' | '));
  });
  return lines.join('\n');
}

/**
 * One-paragraph verdict: how many sweep points fit the 60fps desktop
 * budget and where the first over-budget point is.
 */
export function formatSummary(report: BenchReport): string {
  const total = report.results.length;
  const ok = report.results.filter((r) => r.withinBudget).length;
  const head =
    `${report.actualBackend}: ${ok}/${total} sweep points within the ` +
    `60fps desktop budget (p95 ≤ ${BUDGET_P95_MS}ms, ` +
    `≤ ${BUDGET_DRAW_CALLS} draws, ≤ ${fmtInt(BUDGET_TRIANGLES)} tris).`;
  if (ok === total) {
    return head + ' All clear.';
  }
  const first = report.results.find((r) => !r.withinBudget);
  if (first === undefined) {
    return head;
  }
  return (
    head +
    ` First over-budget point: ${fmtInt(first.buildings)} buildings + ` +
    `${fmtInt(first.units)} units ` +
    `(p95 ${first.p95Ms.toFixed(1)}ms, ` +
    `${first.avgDrawCalls.toFixed(0)} draws, ` +
    `${fmtInt(first.avgTriangles)} tris).`
  );
}
