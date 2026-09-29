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
 * NOVATERRA — performance budget tests (Phase 1, step 12).
 *
 * Budgets are tests, not aspirations: CI fails when a perf scenario exceeds
 * its budget. The sim runs at a fixed 30Hz (33.3ms per tick); the sim must
 * use only a fraction of that so rendering has headroom on a mid-range
 * laptop.
 *
 * Measured baselines (2026-09-29, this VM):
 *   ~12 units:   p95 = 0.09ms
 *   ~200 units:  p95 = 0.29ms
 *   ~500 units:  p95 = 1.29ms
 *   ~1000 units: p95 = 3.64ms
 *
 * Budgets below carry ~5x headroom over measured p95 to avoid flakiness
 * while still catching real regressions (e.g. an accidental O(n^2)).
 */
import { describe, expect, it } from 'vitest';

import {
  BUDGET_DRAW_CALLS,
  BUDGET_P95_MS,
  BUDGET_TRIANGLES,
} from '../src/bench/format';
import { isWater } from '../src/sim/terrain';
import { TICK_MS } from '../src/sim/tick';
import { createSession } from '../src/ui/session';

/** Spawn `count` land units on valid terrain, skipping rejected spots. */
function spawnLoad(session: ReturnType<typeof createSession>, count: number): number {
  // Grant abundant manpower AND training funds/materials: perf tests spawn
  // hundreds of units without an economy (training costs are mandatory
  // since the roster expansion).
  for (const p of session.world.city.players) {
    p.manpower = 100000;
    p.funds = 100000000;
    p.materials = 100000000;
  }
  let spawned = 0;
  let i = 0;
  while (spawned < count && i < count * 20) {
    const x = -120 + (i % 80) * 3;
    const z = 120 - Math.floor(i / 80) * 3;
    i++;
    if (isWater(session.terrain, x, z)) continue;
    try {
      session.queue.enqueue(session.world, {
        kind: 'spawnUnit',
        issuer: 'perf',
        payload: { kind: 'rifles', owner: 0, x, z },
      });
      spawned++;
    } catch {
      // Occupied or otherwise invalid — try the next spot.
    }
  }
  session.tick(); // apply all spawns
  return spawned;
}

function tickP95(session: ReturnType<typeof createSession>, ticks: number): number {
  const times: number[] = [];
  for (let t = 0; t < ticks; t++) {
    const start = performance.now();
    session.tick();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] ?? 0;
  return p95;
}

describe('sim tick performance budgets', () => {
  it('200 units: p95 tick well under budget', () => {
    const session = createSession({ seed: 7, aiDifficulty: 'cadet' });
    const spawned = spawnLoad(session, 200);
    expect(spawned).toBeGreaterThan(150);
    // Budget: 2ms p95 (measured 0.29ms). Must stay far below the 33.3ms tick.
    expect(tickP95(session, 60)).toBeLessThan(2);
  });

  it('500 units: p95 tick well under budget', () => {
    const session = createSession({ seed: 7, aiDifficulty: 'cadet' });
    const spawned = spawnLoad(session, 500);
    expect(spawned).toBeGreaterThan(400);
    // Budget: 8ms p95 (measured 1.29ms).
    expect(tickP95(session, 60)).toBeLessThan(8);
  });

  it('1000 units: p95 tick stays under the 30Hz tick budget', () => {
    const session = createSession({ seed: 7, aiDifficulty: 'cadet' });
    const spawned = spawnLoad(session, 1000);
    expect(spawned).toBeGreaterThan(800);
    // Budget: 20ms p95 (measured 3.64ms). Hard ceiling is TICK_MS (33.3ms);
    // the sim must never eat the whole frame.
    const p95 = tickP95(session, 60);
    expect(p95).toBeLessThan(20);
    expect(p95).toBeLessThan(TICK_MS);
  });

  it('combat at scale does not blow the tick budget', () => {
    const session = createSession({ seed: 7, aiDifficulty: 'cadet' });
    // Grant abundant manpower AND training funds/materials for the
    // 200-unit combat scenario (training costs are mandatory since the
    // roster expansion).
    for (const p of session.world.city.players) {
      p.manpower = 100000;
      p.funds = 100000000;
      p.materials = 100000000;
    }
    // Two opposing forces in range so weapons actually fire every tick.
    let spawned = 0;
    let i = 0;
    while (spawned < 200 && i < 4000) {
      const x = -40 + (i % 40) * 2;
      const z = -40 + Math.floor(i / 40) * 2;
      i++;
      if (isWater(session.terrain, x, z)) continue;
      try {
        session.queue.enqueue(session.world, {
          kind: 'spawnUnit',
          issuer: 'perf',
          payload: {
            kind: 'rifles',
            owner: spawned % 2 === 0 ? 0 : 1,
            x,
            z,
          },
        });
        spawned++;
      } catch {
        // Skip invalid spots.
      }
    }
    session.tick();
    expect(spawned).toBeGreaterThan(150);
    // Combat resolution (targeting, damage, death) at ~200 fighting units.
    expect(tickP95(session, 60)).toBeLessThan(10);
  });
});

describe('render budget constants are not silently inflated', () => {
  it('draw call / triangle / frame budgets match the validated benchmark', () => {
    // These are the budgets the Step 2 benchmark validated on real hardware
    // (8 draws / 5,587 tris at 100 buildings / 50 units, vsync-aware).
    // Raising them weakens the guarantee — do it deliberately, in the
    // benchmark config, not by accident here.
    expect(BUDGET_P95_MS).toBe(16.7);
    expect(BUDGET_DRAW_CALLS).toBe(200);
    expect(BUDGET_TRIANGLES).toBe(750000);
  });
});
