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
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tests/sim.digest-stability.test.ts — final-review R3:
 * digest stability under spawn/kill churn and save/load round-trips.
 *
 * R1/R3 replaced the hot lookup paths with index machinery that must be
 * digest-invisible:
 *  - `findUnit` sits on a per-world id→unit Map (units.ts), maintained
 *    incrementally at spawn/kill and rebuilt lazily after untracked
 *    mutations (test fixtures, snapshot restore);
 *  - `killUnit` removes via an order-preserving splice (binary-search
 *    position; swap-remove would silently reorder iteration for
 *    movement/render/AI loops) and records dead ids for the batched
 *    `flushDeadTargetRefs` sweep instead of scanning attackers per kill.
 *
 * The audit (R3, 2026-10-01): `world.units` is append-only spawn order
 * plus order-preserving splices — ids ascending, never reused — and no
 * sim code iterates the index or the pending-dead Set for logic, so
 * neither structure can leak into the digest. These tests pin the
 * observable contract:
 *  1. heavy spawn/kill churn (incl. carrier wing recursion and the
 *     batched target-ref flush) keeps the roster id-ascending and the
 *     digest deterministic across identical runs;
 *  2. a JSON save/load round-trip after the churn restores the identical
 *     digest (the index rebuilds lazily; no stale entries);
 *  3. churn AFTER the restore stays digest-identical to the same churn
 *     applied pre-save (the index machinery behaves identically on a
 *     restored world).
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import { spawnUnit, findUnit } from '../src/sim/units';
import type { UnitKind, UnitRecord } from '../src/sim/units';
import { killUnit, flushDeadTargetRefs } from '../src/sim/combat';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';

const CHURN_KINDS: UnitKind[] = [
  'rifles',
  'tank',
  'gunship',
  'hauler',
  'cruiser',
  'combatMedic',
];

/** world.units must stay id-ascending (the order invariant the digest and every loop rely on). */
function expectIdAscending(world: World): void {
  const units = world.units;
  for (let i = 1; i < units.length; i++) {
    expect(units[i]!.id).toBeGreaterThan(units[i - 1]!.id);
  }
}

/**
 * Spawn 600 mixed units + one carrier with an embarked 4-plane wing,
 * wire target refs between neighbours, then kill ~2/3 of the roster
 * through the production kill path (batched flush at the end, like the
 * combat system does).
 */
function churn(world: World): void {
  let i = 0;
  for (const kind of CHURN_KINDS) {
    for (let k = 0; k < 100; k++) {
      spawnUnit(world, kind, i % 2, ((i * 37) % 400) - 200, ((i * 91) % 400) - 200);
      i++;
    }
  }
  // Carrier wing: killing the carrier recursively kills the wing
  // (killUnit's recursive path, id-ordered).
  const carrier = spawnUnit(world, 'carrier', 0, 0, 0);
  const wing: UnitRecord[] = [];
  for (let k = 0; k < 4; k++) {
    const w = spawnUnit(world, 'navalFighter', 0, 10 + k, 10);
    w.embarkedOn = carrier.id;
    wing.push(w);
  }
  expect(wing).toHaveLength(4);

  // Heavy findUnit traffic first (builds the index), then wire
  // targetId refs so the batched flush has real work to do.
  const units = world.units;
  for (const u of units) {
    expect(findUnit(world, u.id)).toBe(u);
  }
  for (let k = 0; k + 1 < units.length; k += 2) {
    units[k]!.targetId = units[k + 1]!.id;
    units[k]!.chasing = true;
  }

  // Kill every 3rd unit in roster order — a mass-casualty pattern —
  // plus the carrier (wing recursion).
  const victims = units.filter((_, idx) => idx % 3 === 0);
  for (const v of victims) {
    if (findUnit(world, v.id) === v) killUnit(world, v);
  }
  killUnit(world, carrier);
  flushDeadTargetRefs(world);

  // No stale refs: nobody targets a dead unit; the wing died with
  // the carrier; the roster is still id-ascending.
  const live = new Set(world.units.map((u) => u.id));
  for (const u of world.units) {
    if (u.targetId !== 0) expect(live.has(u.targetId)).toBe(true);
  }
  expect(world.units.some((u) => u.kind === 'carrier')).toBe(false);
  expect(world.units.some((u) => (u.embarkedOn ?? 0) === carrier.id)).toBe(false);
  expectIdAscending(world);
}

/** Faithful save/load: JSON round-trip like the real savefile path. */
function roundTrip(world: World): World {
  const json = JSON.parse(JSON.stringify(takeSnapshot(world)));
  return restoreSnapshot(json);
}

describe('sim/digest stability under spawn/kill churn (R3)', () => {
  it('identical churn runs produce identical digests', () => {
    const a = createWorld(424242);
    churn(a);
    const b = createWorld(424242);
    churn(b);
    expect(digestWorld(a)).toBe(digestWorld(b));
  });

  it('save/load round-trip after heavy churn restores the identical digest', () => {
    const world = createWorld(777);
    churn(world);
    const before = digestWorld(world);
    const restored = roundTrip(world);
    expect(digestWorld(restored)).toBe(before);
    // The index rebuilt lazily on the restored world: every unit
    // resolves to its own record.
    for (const u of restored.units) {
      expect(findUnit(restored, u.id)).toBe(u);
    }
    expect(findUnit(restored, -1)).toBeUndefined();
    expectIdAscending(restored);
  });

  it('churn after restore matches the same churn applied pre-save', () => {
    const pre = createWorld(31337);
    churn(pre);
    churn(pre); // second churn wave on the live world
    const dPre = digestWorld(pre);

    const world = createWorld(31337);
    churn(world);
    const restored = roundTrip(world);
    churn(restored); // same second wave on the restored world
    expect(digestWorld(restored)).toBe(dPre);
  });

  it('mass kill of the whole roster leaves a consistent empty world', () => {
    const world = createWorld(99);
    churn(world);
    for (const u of [...world.units]) killUnit(world, u);
    flushDeadTargetRefs(world);
    expect(world.units).toHaveLength(0);
    expect(findUnit(world, 1)).toBeUndefined();
    const restored = roundTrip(world);
    expect(digestWorld(restored)).toBe(digestWorld(world));
    // An identical fresh run reaches the same empty-world digest.
    const again = createWorld(99);
    churn(again);
    for (const u of [...again.units]) killUnit(again, u);
    flushDeadTargetRefs(again);
    expect(digestWorld(again)).toBe(digestWorld(world));
  });
});
