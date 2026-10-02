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
 * NOVATERRA — tests/sim.doctrine.test.ts — fun-audit D1 (2026-10-02):
 * Republic / Kestrel doctrine asymmetry.
 *
 * Covers:
 *  - getDoctrine default ('republic' for unset owners) + setDoctrine;
 *  - signature-unit gates: trainUnit and spawnUnit reject the wrong
 *    doctrine loudly;
 *  - the Republic engineer training discount (spawnUnit costs);
 *  - stat overlays: Republic sight ×1.2 (effectiveSight), Kestrel
 *    armor HP ×1.25 (effectiveMaxHp), Kestrel armor damage ×1.15 and
 *    Kestrel AA vsAir ×0.7 (damageMultiplier);
 *  - the Aegis Battery interception mechanic (a living Republic
 *    Aegis Battery inside AEGIS_INTERCEPT_RADIUS of a storm strike
 *    shields its owner's assets);
 *  - doctrine-gated National Program variants (ages.ts getters);
 *  - snapshot round-trip (doctrines preserved; legacy decodes {});
 *  - digest sensitivity (doctrine change moves the digest).
 *
 * No RNG is used anywhere in this file — doctrine overlays are pure
 * functions of (world, owner, def).
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { spawnUnit, UNIT_DEFS } from '../src/sim/units';
import { effectiveSight, effectiveMaxHp } from '../src/sim/upgrades';
import { damageMultiplier } from '../src/sim/combat';
import {
  DOCTRINES,
  getDoctrine,
  setDoctrine,
  isDoctrineId,
  doctrineTrainCostMult,
} from '../src/sim/doctrine';
import { getSightBonus, getFactoryOutputMult, getTaxMultiplier } from '../src/sim/ages';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { createCommandQueue } from '../src/sim/commands';
import { registerUnitCommands } from '../src/sim/units';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';
import { AEGIS_INTERCEPT_RADIUS } from '../src/sim/superweapons';

function setup(): World {
  return createWorld(20261002);
}

/** A bare command queue with the unit commands registered (needs terrain for the water check). */
function unitQueue(world: World) {
  const queue = createCommandQueue();
  registerUnitCommands(queue, generateTerrain(MERIDIAN_PLAINS.seed));
  return queue;
}

describe('doctrine basics', () => {
  it('defaults unset owners to republic', () => {
    const world = setup();
    expect(getDoctrine(world, 0)).toBe('republic');
    expect(getDoctrine(world, 1)).toBe('republic');
  });

  it('setDoctrine sticks', () => {
    const world = setup();
    setDoctrine(world, 1, 'kestrel');
    expect(getDoctrine(world, 1)).toBe('kestrel');
    expect(getDoctrine(world, 0)).toBe('republic');
  });

  it('isDoctrineId guards untrusted values', () => {
    expect(isDoctrineId('republic')).toBe(true);
    expect(isDoctrineId('kestrel')).toBe(true);
    expect(isDoctrineId('empire')).toBe(false);
    expect(isDoctrineId(null)).toBe(false);
  });

  it('the defs table carries the two doctrines and their signature units', () => {
    expect(DOCTRINES.republic.signatureUnit).toBe('aegisBattery');
    expect(DOCTRINES.kestrel.signatureUnit).toBe('tempestCannon');
    expect(UNIT_DEFS.aegisBattery.doctrine).toBe('republic');
    expect(UNIT_DEFS.tempestCannon.doctrine).toBe('kestrel');
    expect(UNIT_DEFS.aegisBattery.artBase).toBe('aa');
    expect(UNIT_DEFS.tempestCannon.artBase).toBe('artillery');
  });
});

describe('signature-unit gates', () => {
  it('spawnUnit rejects the wrong doctrine loudly', () => {
    const world = setup();
    const queue = unitQueue(world);
    // Owner 0 defaults to republic — the Tempest Cannon is Kestrel-only.
    expect(() =>
      queue.enqueue(world, { issuer: 'player', kind: 'spawnUnit', payload: { kind: 'tempestCannon', owner: 0, x: 0, z: 0 } }),
    ).toThrow(/exclusive to the Kestrel Directorate/);
    // The Aegis Battery trains fine for the Republic default.
    setDoctrine(world, 1, 'kestrel');
    expect(() =>
      queue.enqueue(world, { issuer: 'player', kind: 'spawnUnit', payload: { kind: 'aegisBattery', owner: 1, x: 0, z: 0 } }),
    ).toThrow(/exclusive to the Republic/);
  });

  it('trainUnit rejects the wrong doctrine loudly', () => {
    const world = setup();
    const queue = unitQueue(world);
    // A completed warFactory to train at (real building, not virtual).
    world.city.buildings.push({
      id: 1, kind: 'warFactory', owner: 0, x: 10, z: 10, w: 3, h: 3,
      progress: 1, operational: true, powered: true,
    } as never);
    expect(() =>
      queue.enqueue(world, {
        issuer: 'player',
        kind: 'trainUnit',
        payload: { kind: 'tempestCannon', owner: 0, buildingId: 1 },
      }),
    ).toThrow(/exclusive to the Kestrel Directorate/);
  });
});

describe('Republic engineer discount', () => {
  it('doctrineTrainCostMult is 0.8 for Republic engineers, 1 otherwise', () => {
    const world = setup();
    expect(doctrineTrainCostMult(world, 0, 'engineer')).toBe(0.8);
    setDoctrine(world, 0, 'kestrel');
    expect(doctrineTrainCostMult(world, 0, 'engineer')).toBe(1);
    setDoctrine(world, 0, 'republic');
    expect(doctrineTrainCostMult(world, 0, 'tank')).toBe(1);
  });

  it('spawnUnit deducts the discounted cost', () => {
    const world = setup();
    const queue = unitQueue(world);
    const player = world.city.players[0]!;
    player.funds = 1000;
    queue.enqueue(world, { issuer: 'player', kind: 'spawnUnit', payload: { kind: 'engineer', owner: 0, x: 0, z: 0 } });
    queue.applyDue(world, 0);
    // Engineer trainFunds 50 × 0.8 = 40.
    expect(player.funds).toBe(960);
  });
});

describe('stat overlays', () => {
  it('Republic units see 20% further (effectiveSight)', () => {
    const world = setup();
    const def = UNIT_DEFS.tank;
    const base = effectiveSight(world, 0, def);
    setDoctrine(world, 0, 'kestrel');
    expect(effectiveSight(world, 0, def)).toBeCloseTo(base / 1.2, 8);
    setDoctrine(world, 0, 'republic');
    expect(effectiveSight(world, 0, def)).toBeCloseTo(base, 8);
  });

  it('Kestrel armor runs 25% more HP (effectiveMaxHp)', () => {
    const world = setup();
    const def = UNIT_DEFS.tank;
    setDoctrine(world, 0, 'kestrel');
    expect(effectiveMaxHp(world, 0, def)).toBeCloseTo(def.hp * 1.25, 8);
    setDoctrine(world, 0, 'republic');
    expect(effectiveMaxHp(world, 0, def)).toBe(def.hp);
  });

  it('Kestrel armor hits 15% harder, Kestrel AA is 30% weaker vs air', () => {
    const world = setup();
    setDoctrine(world, 0, 'kestrel');
    const tank = spawnUnit(world, 'tank', 0, 0, 0);
    const ground = spawnUnit(world, 'rifles', 1, 5, 0);
    const aa = spawnUnit(world, 'aa', 0, 0, 10);
    const jet = spawnUnit(world, 'fighter', 1, 5, 10);
    const tankMult = damageMultiplier(world, tank, UNIT_DEFS.tank, ground);
    const aaMult = damageMultiplier(world, aa, UNIT_DEFS.aa, jet);
    setDoctrine(world, 0, 'republic');
    const tankMultBase = damageMultiplier(world, tank, UNIT_DEFS.tank, ground);
    const aaMultBase = damageMultiplier(world, aa, UNIT_DEFS.aa, jet);
    expect(tankMult).toBeCloseTo(tankMultBase * 1.15, 8);
    expect(aaMult).toBeCloseTo(aaMultBase * 0.7, 8);
  });
});

describe('Aegis Battery interception', () => {
  it('a living Republic Aegis Battery inside the radius shields its owner from a storm strike', async () => {
    const { createSuperweaponSystem } = await import('../src/sim/superweapons');
    const world = setup();
    setDoctrine(world, 1, 'republic');
    // Victim assets at the strike point.
    const victim = spawnUnit(world, 'tank', 1, 0, 0);
    const victimHp = victim.hp;
    // The Aegis Battery well inside the intercept radius.
    spawnUnit(world, 'aegisBattery', 1, AEGIS_INTERCEPT_RADIUS - 10, 0);
    // A storm strike from owner 0, due now.
    world.superweapons.strikes.push({ owner: 0, x: 0, z: 0, atTick: world.tick });
    const sys = createSuperweaponSystem();
    sys(world, 0);
    expect(victim.hp).toBe(victimHp);
  });

  it('no battery, no interception — the strike lands', async () => {
    const { createSuperweaponSystem } = await import('../src/sim/superweapons');
    const world = setup();
    setDoctrine(world, 1, 'republic');
    const victim = spawnUnit(world, 'tank', 1, 0, 0);
    const victimHp = victim.hp;
    world.superweapons.strikes.push({ owner: 0, x: 0, z: 0, atTick: world.tick });
    const sys = createSuperweaponSystem();
    sys(world, 0);
    expect(victim.hp).toBeLessThan(victimHp);
  });

  it('a Kestrel battery does not intercept (wrong doctrine)', async () => {
    const { createSuperweaponSystem } = await import('../src/sim/superweapons');
    const world = setup();
    setDoctrine(world, 1, 'kestrel');
    const victim = spawnUnit(world, 'tank', 1, 0, 0);
    const victimHp = victim.hp;
    // Kestrel cannot field the battery at all — but even a hypothetical
    // one must not intercept (the gate is doctrine, not the unit).
    const battery = spawnUnit(world, 'aa', 1, AEGIS_INTERCEPT_RADIUS - 10, 0);
    battery.kind = 'aegisBattery' as never;
    world.superweapons.strikes.push({ owner: 0, x: 0, z: 0, atTick: world.tick });
    const sys = createSuperweaponSystem();
    sys(world, 0);
    expect(victim.hp).toBeLessThan(victimHp);
  });
});

describe('program variants', () => {
  it('Republic Signals Grid sees further (+12, not +8)', () => {
    const world = setup();
    // Grant the connectivity program directly on the age state.
    world.ages[0] = { age: 'connectivity', program: 'signalsGrid' } as never;
    expect(getSightBonus(world, 0)).toBe(12);
    setDoctrine(world, 0, 'kestrel');
    expect(getSightBonus(world, 0)).toBe(8);
  });

  it('Kestrel Heavy Industry outputs more (and upkeeps more)', () => {
    const world = setup();
    world.ages[0] = { age: 'industry', program: 'heavyIndustry' } as never;
    setDoctrine(world, 0, 'kestrel');
    expect(getFactoryOutputMult(world, 0)).toBeCloseTo(1.75, 8);
    setDoctrine(world, 0, 'republic');
    expect(getFactoryOutputMult(world, 0)).toBeCloseTo(1.5, 8);
  });

  it('Republic Fiber Grid taxes better', () => {
    const world = setup();
    world.ages[0] = { age: 'connectivity', program: 'fiberGrid' } as never;
    expect(getTaxMultiplier(world, 0)).toBeCloseTo(1.25 * 1.08, 8);
    setDoctrine(world, 0, 'kestrel');
    expect(getTaxMultiplier(world, 0)).toBeCloseTo(1.25, 8);
  });
});

describe('snapshot + digest', () => {
  it('doctrines survive a snapshot round-trip', () => {
    const world = setup();
    setDoctrine(world, 0, 'kestrel');
    setDoctrine(world, 1, 'republic');
    const snap = takeSnapshot(world);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(getDoctrine(restored, 0)).toBe('kestrel');
    expect(getDoctrine(restored, 1)).toBe('republic');
  });

  it('legacy snapshots (no doctrines) decode to {} — everyone plays republic', () => {
    const world = setup();
    setDoctrine(world, 0, 'kestrel');
    const snap = takeSnapshot(world);
    const raw = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
    delete raw['doctrines'];
    const restored = restoreSnapshot(raw as never);
    expect(getDoctrine(restored, 0)).toBe('republic');
  });

  it('malformed doctrine ids are dropped on decode', () => {
    const world = setup();
    const snap = takeSnapshot(world);
    const raw = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
    raw['doctrines'] = { '0': 'empire', '1': 'kestrel', 'x': 'republic' };
    const restored = restoreSnapshot(raw as never);
    expect(getDoctrine(restored, 0)).toBe('republic');
    expect(getDoctrine(restored, 1)).toBe('kestrel');
  });

  it('a doctrine change moves the digest', () => {
    const a = setup();
    const b = setup();
    setDoctrine(b, 0, 'kestrel');
    expect(digestWorld(a)).not.toBe(digestWorld(b));
  });
});
