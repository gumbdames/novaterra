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
 * NOVATERRA — benchmark statistics (Phase 1, step 2).
 *
 * Pure module: frame-time aggregation (avg/p95/min/max/fps) and per-frame
 * renderer.info aggregation (draw calls, triangles). No DOM, no three.js.
 * The browser runner feeds these; the numbers are reported via format.ts.
 */

/**
 * Nearest-rank percentile over a sample array (the array is NOT sorted by
 * this function; a sorted copy is made internally). p is clamped to
 * [0, 100]. Returns 0 for an empty sample set.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const clamped = Math.min(Math.max(p, 0), 100);
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: the smallest value with at least p% of samples ≤ it.
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  const value = sorted[idx];
  return value === undefined ? 0 : value;
}

export interface FrameSummary {
  count: number;
  avgMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  /** 1000 / avgMs — the headline fps number. */
  fps: number;
}

const EMPTY_FRAME_SUMMARY: FrameSummary = {
  count: 0,
  avgMs: 0,
  p95Ms: 0,
  minMs: 0,
  maxMs: 0,
  fps: 0,
};

/** Collects per-frame times (ms) and summarizes them. */
export class FrameStats {
  private readonly samples: number[] = [];

  /** Record one frame time. Non-finite/negative values are ignored. */
  push(dtMs: number): void {
    if (Number.isFinite(dtMs) && dtMs >= 0) {
      this.samples.push(dtMs);
    }
  }

  get count(): number {
    return this.samples.length;
  }

  summary(): FrameSummary {
    if (this.samples.length === 0) {
      return { ...EMPTY_FRAME_SUMMARY };
    }
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const s of this.samples) {
      sum += s;
      if (s < min) min = s;
      if (s > max) max = s;
    }
    const avg = sum / this.samples.length;
    return {
      count: this.samples.length,
      avgMs: avg,
      p95Ms: percentile(this.samples, 95),
      minMs: min,
      maxMs: max,
      fps: avg > 0 ? 1000 / avg : 0,
    };
  }
}

export interface InfoSummary {
  samples: number;
  avgDrawCalls: number;
  avgTriangles: number;
  maxTriangles: number;
}

/**
 * Collects per-frame `renderer.info.render` snapshots (draw calls and
 * triangles of the current frame) and summarizes them.
 */
export class InfoStats {
  private readonly draws: number[] = [];
  private readonly tris: number[] = [];

  /** Record one frame's info snapshot. Non-finite values are ignored. */
  push(drawCalls: number, triangles: number): void {
    if (Number.isFinite(drawCalls) && Number.isFinite(triangles)) {
      this.draws.push(drawCalls);
      this.tris.push(triangles);
    }
  }

  get count(): number {
    return this.draws.length;
  }

  summary(): InfoSummary {
    if (this.draws.length === 0) {
      return { samples: 0, avgDrawCalls: 0, avgTriangles: 0, maxTriangles: 0 };
    }
    let drawSum = 0;
    let triSum = 0;
    let triMax = 0;
    for (let i = 0; i < this.draws.length; i++) {
      const d = this.draws[i];
      const t = this.tris[i];
      // push() only appends finite pairs, so these are always defined;
      // the guards below satisfy noUncheckedIndexedAccess.
      if (d !== undefined) drawSum += d;
      if (t !== undefined) {
        triSum += t;
        if (t > triMax) triMax = t;
      }
    }
    return {
      samples: this.draws.length,
      avgDrawCalls: drawSum / this.draws.length,
      avgTriangles: triSum / this.tris.length,
      maxTriangles: triMax,
    };
  }
}
