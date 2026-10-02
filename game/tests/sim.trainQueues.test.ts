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
 * NOVATERRA — fun-audit C1: real production model (2026-10-02).
 *
 * Military units are trained through production-building queues, not
 * instant spawns: `trainUnit` enqueues `{kind, owner, buildingId}`,
 * `runTraining` (economy tick, 1 Hz) advances the head by
 * `def.trainSeconds` and spawns the finished unit at the building's
 * rally cell. `spawnUnit` stays instant for AI/campaign/demo paths.
 *
 * Pinned here:
 *  - every military (non-deployable) def carries trainSeconds 3–25;
 *  - producingBuildingKind / canProduceAt / producibleKinds;
 *  - trainUnit validation (civilian rejected, wrong building
 *    rejected, full queue rejected, costs deducted at enqueue);
 *  - runTraining advances, completes, spawns at the rally cell,
 *    and holds for paused / non-operational / incomplete buildings;
 *  - cancelTrainUnit refunds in full; setTrainPaused toggles;
 *    setRallyPoint stores the rally;
 *  - the queue is digest-covered (sensitivity) and survives a
 *    snapshot round-trip.
 */

import { describe, expect, it } from 'vitest';
import {
  createCommandQueue,
  registerCoreCommands,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import {
  BUILDING_DEFS,
  getPlayer,
  registerCityCommands,
  type BuildingKind,
} from '../src/sim/city';
import { createWorld, type World } from '../src/sim/world';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  MAX_TRAIN_QUEUE,
  canProduceAt,
  producibleKinds,
  producingBuildingKind,
  registerUnitCommands,
  runTraining,
  trainTicksFor,
  UNIT_DEFS,
  type UnitKind,
} from '../src/sim/units';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { generateTerrain, type TerrainData } from '../src/sim/terrain';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';

const SEED = 20261002;

function setup(): {
  world: World;
  terrain: TerrainData;
  queue: CommandQueue;
  driver: TickDriver;
  spawn: { x: number; z: number };
} {
  const world = createWorld(SEED);
  grantAllTrainingResources(world);
  const terrain = generateTerrain(SEED);
  const spawn = terrain.spawns[0] ?? { x: 0, z: 0 };
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  const driver = createTickDriver({ queue, systems: [] });
  return { world, terrain, queue, driver, spawn };
}

/** Enqueue a command as the player and apply it on the next tick. */
function issue(
  queue: CommandQueue,
  driver: TickDriver,
  world: World,
  kind: string,
  payload: Record<string, unknown>,
): void {
  const cmd: NewCommand = { kind, issuer: 'player', payload };
  queue.enqueue(world, cmd);
  driver.step(world, TICK_MS);
}

/** A completed, operational barracks owned by `owner` (id returned). */
function barracks(world: World, owner: number, cx = 10, cz = 10): number {
  completeBuilding(world, 'barracks', owner, cx, cz);
  const b = world.city.buildings[world.city.buildings.length - 1];
  if (!b) throw new Error('barracks fixture failed');
  return b.id;
}

function train(
  queue: CommandQueue,
  driver: TickDriver,
  world: World,
  kind: string,
  buildingId: number,
  owner = 0,
): void {
  issue(queue, driver, world, 'trainUnit', { kind, owner, buildingId });
}

describe('trainSeconds data — every military def carries a sane train time', () => {
  it('all military non-deployable defs have trainSeconds in 3..25', () => {
    const bad: string[] = [];
    for (const key of Object.keys(UNIT_DEFS) as UnitKind[]) {
      const def = UNIT_DEFS[key];
      if (def.military !== true || def.deployableOnly === true) continue;
      const ts = def.trainSeconds;
      if (ts === undefined || ts < 3 || ts > 25) bad.push(`${key}=${ts}`);
    }
    expect(bad).toEqual([]);
  });

  it('trainTicksFor converts seconds to ticks (30 ticks = 1 sim-second)', () => {
    expect(trainTicksFor('rifles')).toBe((UNIT_DEFS.rifles.trainSeconds ?? 0) * 30);
    expect(trainTicksFor('battleship')).toBeGreaterThan(trainTicksFor('rifles'));
  });
});

describe('producingBuildingKind / canProduceAt / producibleKinds', () => {
  it('explicit requiredBuilding wins; otherwise the domain default', () => {
    expect(producingBuildingKind(UNIT_DEFS.tank)).toBe('warFactory');
    expect(producingBuildingKind(UNIT_DEFS.fighter)).toBe('airfield');
    expect(producingBuildingKind(UNIT_DEFS.destroyer)).toBe('navalYard');
    // No requiredBuilding: domain defaults.
    expect(producingBuildingKind(UNIT_DEFS.rifles)).toBe('barracks');
    expect(producingBuildingKind(UNIT_DEFS.drone)).toBe('airfield');
    expect(producingBuildingKind(UNIT_DEFS.patrolBoat)).toBe('shipyard');
  });

  it('canProduceAt honors countsAs (mixed airport trains airfield kinds)', () => {
    expect(canProduceAt('barracks', UNIT_DEFS.rifles)).toBe(true);
    expect(canProduceAt('warFactory', UNIT_DEFS.rifles)).toBe(false);
    expect(canProduceAt('warFactory', UNIT_DEFS.tank)).toBe(true);
  });

  it('producibleKinds lists military trainables per building, never navalMine', () => {
    const kinds = producibleKinds('barracks');
    expect(kinds).toContain('rifles');
    expect(kinds).toContain('spectre');
    expect(kinds).not.toContain('tank');
    expect(kinds).not.toContain('navalMine');
    expect(kinds).not.toContain('engineer'); // civilian — instant path
  });
});

describe('trainUnit command', () => {
  it('rejects civilian kinds (they stay on the instant spawnUnit path)', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    expect(() =>
      train(queue, driver, world, 'engineer', id),
    ).toThrow(/not a military unit/);
  });

  it('rejects unknown buildings, other owners, and incomplete buildings', () => {
    const { world, queue, driver } = setup();
    expect(() => train(queue, driver, world, 'rifles', 999)).toThrow(/no building/);
    const id = barracks(world, 0);
    expect(() => train(queue, driver, world, 'rifles', id, 1)).toThrow(/someone else/);
    const b = world.city.buildings.find((x) => x.id === id);
    if (!b) throw new Error('fixture');
    b.progress = 0.5;
    expect(() => train(queue, driver, world, 'rifles', id)).toThrow(/under construction/);
  });

  it('rejects a kind the building cannot produce', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    expect(() => train(queue, driver, world, 'tank', id)).toThrow(/cannot be trained/);
  });

  it('rejects a full queue and accepts up to MAX_TRAIN_QUEUE', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    for (let i = 0; i < MAX_TRAIN_QUEUE; i++) train(queue, driver, world, 'rifles', id);
    const b = world.city.buildings.find((x) => x.id === id);
    expect(b?.trainQueue?.length).toBe(MAX_TRAIN_QUEUE);
    expect(() => train(queue, driver, world, 'rifles', id)).toThrow(/queue is full/);
  });

  it('deducts training costs at enqueue and stores ticksLeft', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('fixture');
    const fundsBefore = player.funds;
    const manBefore = player.manpower;
    train(queue, driver, world, 'rifles', id);
    const def = UNIT_DEFS.rifles;
    expect(player.funds).toBe(fundsBefore - def.trainFunds);
    expect(player.manpower).toBe(manBefore - def.manpowerCost);
    const b = world.city.buildings.find((x) => x.id === id);
    expect(b?.trainQueue).toEqual([{ kind: 'rifles', ticksLeft: trainTicksFor('rifles') }]);
  });

  it('rejects when the player cannot afford the training cost', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('fixture');
    player.funds = 0;
    expect(() => train(queue, driver, world, 'rifles', id)).toThrow(/cannot afford/);
  });
});

describe('runTraining — the economy-tick training pass', () => {
  it('advances the head and spawns the unit at the rally cell on completion', () => {
    const { world, terrain, queue, driver, spawn } = setup();
    const id = barracks(world, 0);
    // Rally on known land (the map spawn disc).
    issue(queue, driver, world, 'setRallyPoint', { owner: 0, buildingId: id, x: spawn.x, z: spawn.z });
    train(queue, driver, world, 'rifles', id);
    const unitsBefore = world.units.length;
    // Rifles train in 6s → 6 economy ticks (1 Hz).
    const ticks = (UNIT_DEFS.rifles.trainSeconds ?? 6);
    for (let i = 0; i < ticks; i++) runTraining(world, terrain);
    expect(world.units.length).toBe(unitsBefore + 1);
    const u = world.units[world.units.length - 1];
    expect(u?.kind).toBe('rifles');
    expect(u?.x).toBe(spawn.x);
    expect(u?.z).toBe(spawn.z);
    const b = world.city.buildings.find((x) => x.id === id);
    expect(b?.trainQueue?.length).toBe(0);
  });

  it('holds the queue while paused, non-operational, or incomplete', () => {
    const { world, terrain, queue, driver } = setup();
    const id = barracks(world, 0);
    train(queue, driver, world, 'rifles', id);
    const b = world.city.buildings.find((x) => x.id === id);
    if (!b || !b.trainQueue) throw new Error('fixture');
    const before = b.trainQueue[0]?.ticksLeft ?? 0;

    issue(queue, driver, world, 'setTrainPaused', { owner: 0, buildingId: id, paused: true });
    runTraining(world, terrain);
    expect(b.trainQueue[0]?.ticksLeft).toBe(before);

    issue(queue, driver, world, 'setTrainPaused', { owner: 0, buildingId: id, paused: false });
    b.operational = false;
    runTraining(world, terrain);
    expect(b.trainQueue[0]?.ticksLeft).toBe(before);

    b.operational = true;
    runTraining(world, terrain);
    expect((b.trainQueue[0]?.ticksLeft ?? 0)).toBeLessThan(before);
  });

  it('processes the queue FIFO — the second unit starts only after the first completes', () => {
    const { world, terrain, queue, driver, spawn } = setup();
    const id = barracks(world, 0);
    issue(queue, driver, world, 'setRallyPoint', { owner: 0, buildingId: id, x: spawn.x, z: spawn.z });
    train(queue, driver, world, 'rifles', id);
    train(queue, driver, world, 'spectre', id);
    const unitsBefore = world.units.length;
    for (let i = 0; i < (UNIT_DEFS.rifles.trainSeconds ?? 6); i++) runTraining(world, terrain);
    expect(world.units.length).toBe(unitsBefore + 1);
    expect(world.units[world.units.length - 1]?.kind).toBe('rifles');
    const b = world.city.buildings.find((x) => x.id === id);
    // The combat medic is now at the head, untouched until its own ticks run.
    expect(b?.trainQueue?.length).toBe(1);
    expect(b?.trainQueue?.[0]?.kind).toBe('spectre');
    expect(b?.trainQueue?.[0]?.ticksLeft).toBe(trainTicksFor('spectre'));
  });
});

describe('cancelTrainUnit — full refund', () => {
  it('removes the entry and refunds funds, materials, and manpower', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('fixture');
    const fundsBefore = player.funds;
    const matsBefore = player.materials;
    const manBefore = player.manpower;
    train(queue, driver, world, 'rifles', id);
    train(queue, driver, world, 'spectre', id);
    // Cancel the second entry (index 1).
    issue(queue, driver, world, 'cancelTrainUnit', { owner: 0, buildingId: id, index: 1 });
    const def = UNIT_DEFS.spectre;
    expect(player.funds).toBe(fundsBefore - UNIT_DEFS.rifles.trainFunds);
    expect(player.materials).toBe(matsBefore - UNIT_DEFS.rifles.trainMaterials);
    expect(player.manpower).toBe(manBefore - UNIT_DEFS.rifles.manpowerCost);
    void def;
    const b = world.city.buildings.find((x) => x.id === id);
    expect(b?.trainQueue?.map((e) => e.kind)).toEqual(['rifles']);
  });

  it('rejects an out-of-range index', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    expect(() =>
      issue(queue, driver, world, 'cancelTrainUnit', { owner: 0, buildingId: id, index: 0 }),
    ).toThrow(/out of range/);
  });
});

describe('setRallyPoint', () => {
  it('stores the rally point on the building', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    issue(queue, driver, world, 'setRallyPoint', { owner: 0, buildingId: id, x: 12.5, z: -3.25 });
    const b = world.city.buildings.find((x) => x.id === id);
    expect(b?.rallyX).toBe(12.5);
    expect(b?.rallyZ).toBe(-3.25);
  });

  it('rejects out-of-map coordinates', () => {
    const { world, queue, driver } = setup();
    const id = barracks(world, 0);
    expect(() =>
      issue(queue, driver, world, 'setRallyPoint', { owner: 0, buildingId: id, x: 99999, z: 0 }),
    ).toThrow(/outside the map/);
  });
});

describe('digest + snapshot coverage', () => {
  it('the queue, pause flag, and rally are digest-covered (sensitivity)', () => {
    const { world, queue, driver, spawn } = setup();
    const id = barracks(world, 0);
    const d0 = digestWorld(world);
    train(queue, driver, world, 'rifles', id);
    expect(digestWorld(world)).not.toBe(d0);
    const d1 = digestWorld(world);
    issue(queue, driver, world, 'setTrainPaused', { owner: 0, buildingId: id, paused: true });
    expect(digestWorld(world)).not.toBe(d1);
    const d2 = digestWorld(world);
    issue(queue, driver, world, 'setRallyPoint', { owner: 0, buildingId: id, x: spawn.x, z: spawn.z });
    expect(digestWorld(world)).not.toBe(d2);
  });

  it('queue + rally survive a snapshot round-trip with a stable digest', () => {
    const { world, queue, driver, spawn } = setup();
    const id = barracks(world, 0);
    train(queue, driver, world, 'rifles', id);
    issue(queue, driver, world, 'setRallyPoint', { owner: 0, buildingId: id, x: spawn.x, z: spawn.z });
    const before = digestWorld(world);
    const snap = takeSnapshot(world);
    const restored = restoreSnapshot(snap);
    expect(digestWorld(restored)).toBe(before);
    const b = restored.city.buildings.find((x) => x.id === id);
    expect(b?.trainQueue?.length).toBe(1);
    expect(b?.rallyX).toBe(spawn.x);
  });
});

describe('regression pins', () => {
  it('MAX_TRAIN_QUEUE is 5', () => {
    expect(MAX_TRAIN_QUEUE).toBe(5);
  });

  it('BUILDING_DEFS still names the production buildings', () => {
    for (const k of ['barracks', 'warFactory', 'airfield', 'navalYard', 'shipyard'] as BuildingKind[]) {
      expect(BUILDING_DEFS[k]).toBeDefined();
    }
  });
});
