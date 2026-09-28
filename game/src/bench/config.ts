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
 * NOVATERRA — benchmark harness configuration (Phase 1, step 2).
 *
 * Pure module: no DOM, no three.js, no GPU. Safe to import under Node/vitest.
 *
 * URL params (read from `location.search` by the browser runner):
 *   ?bench=1                  enable the benchmark harness (else normal boot)
 *   &backend=webgpu|webgl2    requested renderer backend (default webgpu)
 *   &auto=1                   run the full sweep unattended (else one point)
 *   &count=N                  single sweep point with N buildings
 *   &shadows=0                disable the directional shadow map (default on)
 *   &dpr=X                    pixel-ratio cap override, e.g. &dpr=1 (default 2)
 *
 * Parsing is total (never throws). Anything it cannot make sense of is
 * reported in `problems` and the runner refuses to run: a benchmark that
 * silently measures the wrong configuration is worse than no benchmark.
 */

/** Building counts swept by the benchmark (each point also gets units). */
export const BENCH_SWEEP = [100, 500, 1000, 2000, 5000, 10000] as const;

/** Frames rendered before measuring (shader compile + cache warm-up). */
export const WARMUP_FRAMES = 120;

/** Frames measured per sweep point. */
export const MEASURE_FRAMES = 300;

/** Default single-point count when ?bench=1 runs without &auto=1 / &count=. */
export const DEFAULT_SINGLE_COUNT = 1000;

/**
 * Upper bound for a manual ?count= override. A typo like ?count=1000000
 * would otherwise hang the tab allocating instances.
 */
export const MAX_COUNT_OVERRIDE = 50000;

/** Renderer backend the harness can request. */
export type BenchBackend = 'webgpu' | 'webgl2';

export interface BenchParams {
  /** ?bench=1 was present. */
  enabled: boolean;
  /** Requested backend. What actually initialized is reported separately. */
  backend: BenchBackend;
  /** Run the full sweep unattended. */
  auto: boolean;
  /** Directional shadow map on/off. */
  shadows: boolean;
  /** Pixel-ratio cap (game default is min(devicePixelRatio, 2)). */
  dprCap: number;
  /** Manual single-point override, or null for the default sweep/single. */
  countOverride: number | null;
}

/**
 * Parse bench params from a URL query string. Returns the params plus a
 * list of human-readable problems; the runner treats any problem as fatal.
 */
export function parseBenchParams(search: string): {
  params: BenchParams;
  problems: string[];
} {
  const problems: string[] = [];
  const params: BenchParams = {
    enabled: false,
    backend: 'webgpu',
    auto: false,
    shadows: true,
    dprCap: 2,
    countOverride: null,
  };

  const q = new URLSearchParams(search);
  if (q.get('bench') !== '1') {
    return { params, problems };
  }
  params.enabled = true;

  const backendRaw = q.get('backend');
  if (backendRaw === null) {
    params.backend = 'webgpu';
  } else {
    const normalized = backendRaw.toLowerCase();
    if (normalized === 'webgpu' || normalized === 'webgl2') {
      params.backend = normalized;
    } else {
      problems.push(
        `unknown backend "${backendRaw}" (expected "webgpu" or "webgl2")`,
      );
    }
  }

  params.auto = q.get('auto') === '1';
  params.shadows = q.get('shadows') !== '0';

  const dprRaw = q.get('dpr');
  if (dprRaw !== null) {
    // Strict shape: "2", "1.5" — but not "1.5x" (parseFloat would
    // silently accept the prefix, hiding a typo'd config).
    const dpr = /^\d+(\.\d+)?$/.test(dprRaw) ? Number.parseFloat(dprRaw) : NaN;
    if (!Number.isFinite(dpr) || dpr <= 0 || dpr > 4) {
      problems.push(
        `invalid dpr "${dprRaw}" (expected a number in (0, 4])`,
      );
    } else {
      params.dprCap = dpr;
    }
  }

  const countRaw = q.get('count');
  if (countRaw !== null) {
    // Strict shape: digits only — "4.5" is a typo, not 4.
    const count = /^\d+$/.test(countRaw) ? Number.parseInt(countRaw, 10) : NaN;
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT_OVERRIDE) {
      problems.push(
        `invalid count "${countRaw}" ` +
          `(expected an integer in [1, ${MAX_COUNT_OVERRIDE}])`,
      );
    } else {
      params.countOverride = count;
    }
  }

  return { params, problems };
}

/** Building counts this run will measure, in sweep order. */
export function sweepCounts(params: BenchParams): number[] {
  if (params.countOverride !== null) {
    return [params.countOverride];
  }
  if (params.auto) {
    return [...BENCH_SWEEP];
  }
  return [DEFAULT_SINGLE_COUNT];
}

/**
 * Units (second instanced entity type) per sweep point. Fixed 2:1
 * buildings:units ratio keeps every sweep point comparable.
 */
export function unitsFor(buildingCount: number): number {
  return Math.floor(buildingCount / 2);
}
