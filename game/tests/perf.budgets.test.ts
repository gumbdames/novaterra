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
 * Budgets below carry ~10-14x headroom over measured p95. That sounds
 * generous, but GitHub's shared CI runners showed a ~7x slowdown vs the
 * dev machine (200-unit p95 measured 2.03ms there), so ~5x headroom was
 * NOT enough to avoid flakes. These budgets still catch real
 * regressions (e.g. an accidental O(n^2) would blow any of them by
 * 10-100x); they are smoke budgets, not hardware guarantees.
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
    // Budget: 16ms p95 (measured 0.29ms on fast x86 desktop, ~5-10ms on ARM64/Pi5
    // under heavy multi-worker vitest parallel load). Must stay far below the 33.3ms tick.
    expect(tickP95(session, 60)).toBeLessThan(16);
  });

  it('500 units: p95 tick well under budget', () => {
    const session = createSession({ seed: 7, aiDifficulty: 'cadet' });
    const spawned = spawnLoad(session, 500);
    expect(spawned).toBeGreaterThan(400);
    // Budget: 12ms p95 (measured 1.29ms locally; CI runners run ~7x slower).
    expect(tickP95(session, 60)).toBeLessThan(12);
  });

  it('1000 units: p95 tick stays under the 30Hz tick budget', () => {
    const session = createSession({ seed: 7, aiDifficulty: 'cadet' });
    const spawned = spawnLoad(session, 1000);
    expect(spawned).toBeGreaterThan(800);
    // Budget: 25ms p95 (measured 3.64ms locally; CI runners run ~7x slower).
    // Hard ceiling is TICK_MS (33.3ms); the sim must never eat the whole frame.
    const p95 = tickP95(session, 60);
    expect(p95).toBeLessThan(25);
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
    expect(tickP95(session, 60)).toBeLessThan(16);
  });
});

describe('worst-case combined sim load (R3 M12)', () => {
  it('marshal AI + economy + 1000-unit combat + pathing burst: stress p95 is recorded and bounded', () => {
    // Marshal is the heaviest AI personality (full think pass); the two
    // armies engage so weapons fire every tick; the move orders land a
    // pathfinding burst on top. Economy ticks (1 Hz) and AI think passes
    // are inside the measured 60 ticks. The armies start separated (a
    // realistic worst case — not a degenerate melee blender) and close
    // under AI orders.
    const session = createSession({ seed: 7, aiDifficulty: 'marshal' });
    for (const p of session.world.city.players) {
      p.manpower = 100000;
      p.funds = 100000000;
      p.materials = 100000000;
    }
    let spawned = 0;
    let i = 0;
    const landSpots: Array<{ x: number; z: number }> = [];
    while (spawned < 1100 && i < 22000) {
      const half = spawned % 2 === 0 ? 0 : 1;
      const x = (half === 0 ? -70 : 30) + (i % 40) * 2;
      const z = -40 + Math.floor(i / 40) * 2;
      i++;
      if (isWater(session.terrain, x, z)) continue;
      try {
        session.queue.enqueue(session.world, {
          kind: 'spawnUnit',
          issuer: 'perf',
          payload: { kind: 'rifles', owner: half, x, z },
        });
        spawned++;
        landSpots.push({ x, z });
      } catch {
        // Occupied or otherwise invalid — try the next spot.
      }
    }
    session.tick(); // apply all spawns
    expect(spawned).toBeGreaterThan(900);
    // Pathing burst: a full control group of our units ordered at the
    // enemy's side (they fight their way through). Destinations reuse
    // water-validated spawn spots, so no order is rejected for water.
    const ours = session.world.units.filter((u) => u.owner === 0).slice(0, 40);
    expect(ours.length).toBe(40);
    ours.forEach((u, j) => {
      const spot = landSpots[(j * 5 + 1) % landSpots.length]!;
      session.queue.enqueue(session.world, {
        kind: 'moveUnit',
        issuer: 'perf',
        payload: { unitId: u.id, owner: 0, x: spot.x, z: spot.z },
      });
    });
    session.tick(); // apply orders
    const p95 = tickP95(session, 60);
    console.log(`[worst-case] p95 tick ${p95.toFixed(2)}ms over 60 ticks (marshal + combat + pathing)`);
    // STRESS budget, not the 30Hz frame budget: this scenario runs
    // ~1100 units — about 20x the marshal army cap (AI_MAX_UNITS = 48)
    // — and its p95 does NOT fit the 33.3ms tick on this host
    // (measured 89–136ms, Node, 2026-10-01). The sim absorbs over-budget
    // ticks via the tick driver's drop accounting (sim/tick.ts), so the
    // game slows down instead of breaking; the 33.3ms frame budget is
    // covered by the realistic-scale tests above. This assertion pins
    // the stress result so a pathological 10x regression fails loudly.
    // Per-system breakdown and follow-ups: docs/research/perf-r3.md.
    // Honest scope: Node-measured on CI hardware, not a browser frame.
    expect(p95).toBeLessThan(750);
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
