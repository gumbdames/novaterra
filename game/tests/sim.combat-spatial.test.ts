/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This file is part of NOVATERRA. NOVATERRA is free software: you can
 * redistribute it and/or modify it under the terms of the GNU Affero General
 * Public License as published by the Free Software Foundation, either version
 * 3 of the License, or (at your option) any later version.
 *
 * NOVATERRA is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tests/sim.combat-spatial.test.ts — R1 final-review H1:
 * combat targeting performance.
 *
 * acquireTarget used to be a full O(n) scan per armed unit per tick
 * (O(n^2) per battle); it now queries a per-(world, tick) spatial hash
 * (cell 64, covering the max effective range of 62) and applies exactly
 * the same filters as the legacy scan, so results are identical.
 *
 * Covers: result identity against an in-test copy of the legacy scan
 * (seeded, mixed kinds/owners, ties, min-range, stealth), the 2000-unit
 * tick-budget assertion, and sublinear scaling relative to the old
 * quadratic (constant density: old ~16x for 4x units, new ~4x).
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import { UNIT_DEFS, spawnUnit, isSheltered } from '../src/sim/units';
import type { UnitKind, UnitRecord, UnitDef } from '../src/sim/units';
import {
  acquireTarget,
  canTarget,
} from '../src/sim/combat';
import { effectiveRange } from '../src/sim/upgrades';
import { isDetected } from '../src/sim/intel';
import { createRngBank } from '../src/sim/rng';

/**
 * The pre-H1 implementation, kept as the behavioral reference: a full
 * world scan with the exact legacy filter chain and tie-break.
 */
function legacyAcquireTarget(
  world: World,
  unit: UnitRecord,
  def: UnitDef,
): UnitRecord | undefined {
  if (def.damage <= 0 || def.targets === 'none') return undefined;
  const range = effectiveRange(world, unit.owner, def);
  let best: UnitRecord | undefined;
  let bestDist = Infinity;
  for (const other of world.units) {
    if (other.id === unit.id || other.owner === unit.owner || other.hp <= 0) continue;
    if (isSheltered(other)) continue;
    if (!isDetected(other, unit.owner, world)) continue;
    if (!canTarget(def, other)) continue;
    const d = Math.hypot(other.x - unit.x, other.z - unit.z);
    if (d > range || d < def.minRange) continue;
    if (
      d < bestDist - 1e-9 ||
      (Math.abs(d - bestDist) < 1e-9 && other.id < (best?.id ?? Infinity))
    ) {
      best = other;
      bestDist = d;
    }
  }
  return best;
}

const SHOOTERS: UnitKind[] = ['rifles', 'tank', 'gunship', 'cruiser'];
const TARGETS: UnitKind[] = ['rifles', 'tank', 'gunship', 'cruiser', 'combatMedic', 'spectre'];

/** Scatter `count` units of mixed kinds over a square of `area`. */
function scatterUnits(world: World, seed: number, count: number, area: number): UnitRecord[] {
  const rng = createRngBank(seed);
  const stream = `scatter-${seed}`;
  const out: UnitRecord[] = [];
  for (let i = 0; i < count; i++) {
    const kinds = i % 4 === 0 ? SHOOTERS : TARGETS;
    const kind = kinds[rng.intBelow(stream, kinds.length)]!;
    const owner = i % 3 === 2 ? 1 : 0; // owners 0 and 1, every third unit hostile
    const u = spawnUnit(world, kind, owner, rng.range(stream, -area / 2, area / 2), rng.range(stream, -area / 2, area / 2));
    // Some stealthed spectres are burned (spotted), most are not — the
    // identity test must cover both sides of the detection filter.
    if (kind === 'spectre' && i % 5 === 0) u.spottedUntil = 99999;
    out.push(u);
  }
  return out;
}

describe('acquireTarget identity vs legacy scan (R1 H1)', () => {
  it('returns the identical target across seeded mixed configurations', () => {
    for (const seed of [101, 202, 303]) {
      const world = createWorld(seed);
      const units = scatterUnits(world, seed * 7 + 1, 220, 800);
      for (const u of units) {
        const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
        const got = acquireTarget(world, u, def);
        const want = legacyAcquireTarget(world, u, def);
        expect(got?.id, `seed ${seed} shooter ${u.id} (${u.kind})`).toBe(want?.id);
      }
    }
  });

  it('breaks exact distance ties by lower id, like the legacy scan', () => {
    const world = createWorld(404);
    const shooter = spawnUnit(world, 'rifles', 0, 0, 0);
    // Two hostile tanks at exactly the same distance, spawned in
    // reverse id order so the tie-break (not spawn order) decides.
    const far = spawnUnit(world, 'tank', 1, 10, 0);
    const near = spawnUnit(world, 'tank', 1, -10, 0);
    expect(near.id).toBeGreaterThan(far.id);
    const def = UNIT_DEFS[shooter.kind as keyof typeof UNIT_DEFS];
    expect(acquireTarget(world, shooter, def)?.id).toBe(far.id);
    expect(legacyAcquireTarget(world, shooter, def)?.id).toBe(far.id);
  });
});

describe('acquireTarget performance (R1 H1)', () => {
  /** Sweep every armed unit once; returns wall ms. */
  function sweepMs(world: World): number {
    // Warm up (JIT + the per-tick hash build path).
    for (const u of world.units) acquireTarget(world, u, UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS]);
    const t0 = performance.now();
    for (const u of world.units) acquireTarget(world, u, UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS]);
    return performance.now() - t0;
  }

  it('2000 units sweep well under the 33.3ms tick budget', () => {
    const world = createWorld(505);
    // Constant density as in the scaling test: the 2000-unit field
    // covers 4x the area of the 500-unit field.
    scatterUnits(world, 606, 2000, 1600);
    const ms = sweepMs(world);
    console.log(`[perf] acquireTarget sweep, 2000 units: ${ms.toFixed(2)}ms`);
    // Generous tripwire: the new code runs in low single-digit ms;
    // the tick budget (33.3ms) is the requirement, with headroom for
    // slow shared VMs.
    expect(ms, `acquireTarget sweep of 2000 units took ${ms.toFixed(2)}ms`).toBeLessThan(33.3);
  });

  // Timing-sensitive: under full-suite parallel load a single run can
  // catch worker contention. Retry + best-of-5 keeps the signal
  // (2x vs 16x scaling) while discarding contended runs.
  it('scales sublinearly vs the old quadratic (constant density)', { retry: 2 }, () => {
    const small = createWorld(707);
    scatterUnits(small, 808, 500, 800);
    const big = createWorld(909);
    scatterUnits(big, 1010, 2000, 1600); // 4x units, same density
    // Microbenchmarks on a shared VM see GC pauses and worker
    // contention — take the minimum of 5 sweeps so slow runs cannot
    // fail the test.
    const sweep = (world: ReturnType<typeof createWorld>, fn: typeof acquireTarget): number => {
      let best = Infinity;
      for (let r = 0; r < 5; r++) {
        const t = performance.now();
        for (const u of world.units) fn(world, u, UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS]);
        best = Math.min(best, performance.now() - t);
      }
      return best;
    };
    const newSmallMs = sweep(small, acquireTarget);
    const newBigMs = sweep(big, acquireTarget);
    // Reference: the legacy scan on the same fields (kept small so the
    // O(n^2) reference stays fast).
    const oldSmallMs = sweep(small, legacyAcquireTarget);
    const oldBigMs = sweep(big, legacyAcquireTarget);
    const newRatio = newBigMs / Math.max(newSmallMs, 1e-6);
    const oldRatio = oldBigMs / Math.max(oldSmallMs, 1e-6);
    console.log(
      `[perf] acquireTarget scaling 500->2000 (constant density): ` +
        `new ${newRatio.toFixed(2)}x vs legacy ${oldRatio.toFixed(2)}x`,
    );
    // The legacy scan is quadratic in n (~16x for 4x units); the hash
    // query cost per shooter is independent of n at constant density.
    // Assert the new code scales strictly better than the old — a
    // relative comparison (not an absolute threshold) so it survives
    // timer noise and GC pressure on shared VMs.
    expect(newRatio).toBeLessThan(oldRatio);
    // And at 2000 units the hash is absolutely faster than the scan:
    // the per-query cost no longer grows with the army.
    expect(newBigMs).toBeLessThan(oldBigMs);
  });
});
