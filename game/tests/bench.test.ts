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
 * NOVATERRA — benchmark harness unit tests (Phase 1, step 2).
 *
 * Everything testable under Node: URL param parsing/validation, sweep
 * config, deterministic layout, stats math (avg/p95), and result
 * formatting. The WebGL/WebGPU parts (scene.ts, runner.ts) cannot run
 * headless by design — they are structured so all pure logic lives here
 * in the tested modules.
 */
import { describe, expect, it } from 'vitest';

import {
  BENCH_SWEEP,
  DEFAULT_SINGLE_COUNT,
  MAX_COUNT_OVERRIDE,
  MEASURE_FRAMES,
  WARMUP_FRAMES,
  parseBenchParams,
  sweepCounts,
  unitsFor,
} from '../src/bench/config';
import {
  BENCH_GROUND_SIZE,
  layoutBuildings,
  layoutUnits,
} from '../src/bench/layout';
import { FrameStats, InfoStats, percentile } from '../src/bench/stats';
import {
  BUDGET_DRAW_CALLS,
  BUDGET_P95_MS,
  BUDGET_P95_SLACK_MS,
  BUDGET_TRIANGLES,
  formatSummary,
  formatTable,
  withinBudget,
  type BenchReport,
} from '../src/bench/format';

describe('bench config: URL parsing', () => {
  it('is disabled without ?bench=1', () => {
    const { params, problems } = parseBenchParams('');
    expect(params.enabled).toBe(false);
    expect(problems).toEqual([]);
  });

  it('parses a minimal ?bench=1 with defaults', () => {
    const { params, problems } = parseBenchParams('?bench=1');
    expect(problems).toEqual([]);
    expect(params.enabled).toBe(true);
    expect(params.backend).toBe('webgpu');
    expect(params.auto).toBe(false);
    expect(params.shadows).toBe(true);
    expect(params.dprCap).toBe(2);
    expect(params.countOverride).toBeNull();
  });

  it('accepts backend=webgl2 (case-insensitive)', () => {
    expect(parseBenchParams('?bench=1&backend=webgl2').params.backend).toBe(
      'webgl2',
    );
    expect(parseBenchParams('?bench=1&backend=WEBGL2').params.backend).toBe(
      'webgl2',
    );
    expect(parseBenchParams('?bench=1&backend=webgpu').params.backend).toBe(
      'webgpu',
    );
  });

  it('flags an unknown backend instead of silently mis-measuring', () => {
    const { params, problems } = parseBenchParams('?bench=1&backend=vulkan');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('vulkan');
    // Falls back to a safe default, but the runner refuses to run on problems.
    expect(params.backend).toBe('webgpu');
  });

  it('parses auto, shadows, dpr and count flags', () => {
    const { params, problems } = parseBenchParams(
      '?bench=1&auto=1&shadows=0&dpr=1&count=500',
    );
    expect(problems).toEqual([]);
    expect(params.auto).toBe(true);
    expect(params.shadows).toBe(false);
    expect(params.dprCap).toBe(1);
    expect(params.countOverride).toBe(500);
  });

  it('rejects garbage dpr values', () => {
    for (const bad of ['abc', '0', '-1', '8']) {
      const { problems } = parseBenchParams(`?bench=1&dpr=${bad}`);
      expect(problems.length).toBe(1);
    }
    expect(parseBenchParams('?bench=1&dpr=1.5').params.dprCap).toBe(1.5);
  });

  it('rejects garbage count values', () => {
    for (const bad of ['abc', '0', '-5', `${MAX_COUNT_OVERRIDE + 1}`, '4.5']) {
      const { problems } = parseBenchParams(`?bench=1&count=${bad}`);
      expect(problems.length).toBe(1);
    }
    expect(
      parseBenchParams(`?bench=1&count=${MAX_COUNT_OVERRIDE}`).problems,
    ).toEqual([]);
  });
});

describe('bench config: sweep selection', () => {
  it('auto runs the full configured sweep', () => {
    const { params } = parseBenchParams('?bench=1&auto=1');
    expect(sweepCounts(params)).toEqual([...BENCH_SWEEP]);
    expect(BENCH_SWEEP).toEqual([100, 500, 1000, 2000, 5000, 10000]);
  });

  it('count override wins over auto and defaults', () => {
    const { params } = parseBenchParams('?bench=1&auto=1&count=750');
    expect(sweepCounts(params)).toEqual([750]);
  });

  it('non-auto without count runs one default point', () => {
    const { params } = parseBenchParams('?bench=1');
    expect(sweepCounts(params)).toEqual([DEFAULT_SINGLE_COUNT]);
  });

  it('uses a 120-frame warm-up and 300-frame measurement window', () => {
    expect(WARMUP_FRAMES).toBe(120);
    expect(MEASURE_FRAMES).toBe(300);
  });

  it('derives units at a fixed 2:1 buildings:units ratio', () => {
    expect(unitsFor(100)).toBe(50);
    expect(unitsFor(101)).toBe(50);
    expect(unitsFor(10000)).toBe(5000);
  });
});

describe('bench layout: deterministic placement', () => {
  it('produces exactly the requested building count', () => {
    expect(layoutBuildings(100)).toHaveLength(100);
    expect(layoutBuildings(2500)).toHaveLength(2500);
  });

  it('is deterministic for the same seed', () => {
    expect(layoutBuildings(500, 42)).toEqual(layoutBuildings(500, 42));
    expect(layoutUnits(250, 42)).toEqual(layoutUnits(250, 42));
  });

  it('differs across seeds', () => {
    expect(layoutBuildings(500, 1)).not.toEqual(layoutBuildings(500, 2));
  });

  it('keeps buildings inside the ground plane with positive volume', () => {
    const half = BENCH_GROUND_SIZE / 2;
    for (const b of layoutBuildings(1000)) {
      expect(Math.abs(b.x)).toBeLessThanOrEqual(half);
      expect(Math.abs(b.z)).toBeLessThanOrEqual(half);
      expect(b.sx).toBeGreaterThan(0);
      expect(b.sy).toBeGreaterThan(0);
      expect(b.sz).toBeGreaterThan(0);
      expect(b.y).toBeCloseTo(b.sy / 2, 10);
      for (const c of b.color) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps units inside the ground plane with positive volume', () => {
    const half = BENCH_GROUND_SIZE / 2;
    for (const u of layoutUnits(500)) {
      expect(Math.abs(u.x)).toBeLessThanOrEqual(half);
      expect(Math.abs(u.z)).toBeLessThanOrEqual(half);
      expect(u.sy).toBeGreaterThan(0);
    }
  });
});

describe('bench stats: frame aggregation', () => {
  it('computes avg/p95/min/max/fps over known samples', () => {
    const s = new FrameStats();
    for (const dt of [10, 20, 30, 40, 50]) {
      s.push(dt);
    }
    const r = s.summary();
    expect(r.count).toBe(5);
    expect(r.avgMs).toBe(30);
    // Nearest-rank p95 of 5 samples = the max.
    expect(r.p95Ms).toBe(50);
    expect(r.minMs).toBe(10);
    expect(r.maxMs).toBe(50);
    expect(r.fps).toBeCloseTo(1000 / 30, 10);
  });

  it('returns zeros when empty', () => {
    const r = new FrameStats().summary();
    expect(r).toEqual({
      count: 0,
      avgMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      fps: 0,
    });
  });

  it('ignores non-finite and negative samples', () => {
    const s = new FrameStats();
    s.push(10);
    s.push(Number.NaN);
    s.push(Number.POSITIVE_INFINITY);
    s.push(-5);
    expect(s.count).toBe(1);
    expect(s.summary().avgMs).toBe(10);
  });

  it('percentile() handles edges', () => {
    expect(percentile([], 95)).toBe(0);
    // 1..100 → p95 is 95 by nearest rank.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 50)).toBe(50);
    // p is clamped to [0, 100].
    expect(percentile(samples, 1000)).toBe(100);
    expect(percentile(samples, -5)).toBe(1);
  });
});

describe('bench stats: renderer.info aggregation', () => {
  it('averages draw calls and tracks triangle max', () => {
    const s = new InfoStats();
    s.push(10, 1000);
    s.push(12, 1500);
    s.push(11, 1200);
    const r = s.summary();
    expect(r.samples).toBe(3);
    expect(r.avgDrawCalls).toBe(11);
    expect(r.avgTriangles).toBeCloseTo(1233.333, 2);
    expect(r.maxTriangles).toBe(1500);
  });

  it('returns zeros when empty', () => {
    expect(new InfoStats().summary()).toEqual({
      samples: 0,
      avgDrawCalls: 0,
      avgTriangles: 0,
      maxTriangles: 0,
    });
  });
});

describe('bench format: budgets and tables', () => {
  it('applies the ARCHITECTURE.md §6 desktop budgets', () => {
    expect(BUDGET_P95_MS).toBe(16.7);
    expect(BUDGET_P95_SLACK_MS).toBe(1.0);
    expect(BUDGET_DRAW_CALLS).toBe(200);
    expect(BUDGET_TRIANGLES).toBe(750000);
    const ok = { p95Ms: 10, avgDrawCalls: 50, avgTriangles: 100000 };
    expect(withinBudget(ok)).toBe(true);
    expect(withinBudget({ ...ok, p95Ms: 17.71 })).toBe(false);
    expect(withinBudget({ ...ok, avgDrawCalls: 201 })).toBe(false);
    expect(withinBudget({ ...ok, avgTriangles: 750001 })).toBe(false);
  });

  it('is vsync-aware: 60Hz timer slop is not a dropped frame', () => {
    const ok = { p95Ms: 10, avgDrawCalls: 50, avgTriangles: 100000 };
    // A healthy 60Hz frame reports ~16.7ms; slop to ~17.7ms is fine.
    expect(withinBudget({ ...ok, p95Ms: 16.7 })).toBe(true);
    expect(withinBudget({ ...ok, p95Ms: 16.75 })).toBe(true);
    expect(withinBudget({ ...ok, p95Ms: 17.7 })).toBe(true);
    // A dropped frame lands at ~33.3ms — well above the slack.
    expect(withinBudget({ ...ok, p95Ms: 33.3 })).toBe(false);
    expect(withinBudget({ ...ok, p95Ms: 25.0 })).toBe(false);
  });

  function makeReport(): BenchReport {
    return {
      game: 'NOVATERRA',
      version: '0.1.0',
      requestedBackend: 'webgpu',
      actualBackend: 'webgpu',
      shadows: true,
      dprCap: 2,
      warmupFrames: 120,
      measureFrames: 300,
      userAgent: 'test-agent',
      startedAt: '2026-09-28T00:00:00.000Z',
      results: [
        {
          buildings: 100,
          units: 50,
          avgMs: 3.14,
          p95Ms: 4.02,
          minMs: 2.5,
          maxMs: 6.1,
          fps: 318.5,
          avgDrawCalls: 9,
          avgTriangles: 24103,
          maxTriangles: 24500,
          withinBudget: true,
        },
        {
          buildings: 10000,
          units: 5000,
          avgMs: 25.0,
          p95Ms: 31.2,
          minMs: 20.0,
          maxMs: 45.0,
          fps: 40.0,
          avgDrawCalls: 9,
          avgTriangles: 2400000,
          maxTriangles: 2450000,
          withinBudget: false,
        },
      ],
    };
  }

  it('formatTable renders headers, rows and the budget verdict', () => {
    const table = formatTable(makeReport());
    expect(table).toContain('buildings');
    expect(table).toContain('p95 ms');
    expect(table).toContain('100');
    expect(table).toContain('10,000');
    expect(table).toContain('24,103');
    expect(table).toContain('OK');
    expect(table).toContain('OVER');
    expect(table).toContain('webgpu');
  });

  it('formatSummary counts in-budget points and names the first failure', () => {
    const summary = formatSummary(makeReport());
    expect(summary).toContain('1/2');
    expect(summary).toContain('10,000 buildings');
    expect(summary).toContain('5,000 units');
  });

  it('formatSummary reports all-clear when everything fits', () => {
    const report = makeReport();
    report.results.forEach((r) => {
      r.withinBudget = true;
    });
    expect(formatSummary(report)).toContain('2/2');
    expect(formatSummary(report)).toContain('All clear');
  });
});
