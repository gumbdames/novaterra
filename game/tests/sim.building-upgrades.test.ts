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
 * NOVATERRA — tests/sim.building-upgrades.test.ts — building upgrades
 * (2026-10-05): nuclear reactor upgrades.
 *
 * Covers: the `upgradeBuilding` command's validation (rejects at max
 * reactors, when broke, for non-nuclear kinds, mid-upgrade re-issue,
 * while still constructing, and for other owners' buildings), the
 * reactor power/water math (60/105/150/195 power, 6/9/12/15 water),
 * upgrade progress completing after 40s of game time with the plant
 * staying operational throughout, snapshot round-trip fidelity,
 * digest coverage, and the fair-AI upgrade rule.
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import { createCommandQueue, CommandRejectedError } from '../src/sim/commands';
import type { CommandQueue } from '../src/sim/commands';
import { registerCoreCommands } from '../src/sim/commands';
import {
  BUILDING_DEFS,
  NUCLEAR_MAX_REACTORS,
  NUCLEAR_REACTOR_POWER_MW,
  NUCLEAR_REACTOR_WATER_DEMAND,
  NUCLEAR_UPGRADE_COST_FUNDS,
  NUCLEAR_UPGRADE_COST_MATERIALS,
  NUCLEAR_UPGRADE_SECONDS,
  getPlayer,
  placeBuilding,
  reactorPowerBonus,
  reactorWaterDemandBonus,
  registerCityCommands,
} from '../src/sim/city';
import type { BuildingKind, BuildingRecord, Placement, PlayerState } from '../src/sim/city';
import { runEconomyTick } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { addAIPlayer, thinkNuclearUpgrades } from '../src/sim/ai';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';
import { grantAllTrainingResources } from './sim.roster-fixtures';

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function setup(seed: number): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  return { terrain, world, queue };
}

/** Directly place a completed physical building (bypasses validation). */
function completed(world: World, kind: BuildingKind, owner: number, cx: number, cz: number): BuildingRecord {
  const p: Placement = { kind, owner, cx, cz, facing: 0 };
  const b = placeBuilding(world.city, p);
  b.progress = 1;
  b.operational = true;
  return b;
}

function playerOf(world: World, owner: number): PlayerState {
  const p = getPlayer(world.city, owner);
  if (p === undefined) throw new Error(`no player ${owner}`);
  return p;
}

function aiOf(world: World, owner = 1) {
  const ai = world.ai.players.find((p) => p.owner === owner);
  if (ai === undefined) throw new Error(`no AI player ${owner}`);
  return ai;
}

function upgradeCmd(owner: number, buildingId: number) {
  return { kind: 'upgradeBuilding', issuer: 'test', payload: { owner, buildingId } };
}

function rejectionReason(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).reason;
  }
  throw new Error('expected a CommandRejectedError but none was thrown');
}

function richen(world: World, owner: number): void {
  const p = playerOf(world, owner);
  p.funds = 100000;
  p.materials = 100000;
}

describe('upgradeBuilding command validation', () => {
  it('accepts a valid upgrade, deducts the cost, and starts progress at 0', () => {
    const ctx = setup(101);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    richen(ctx.world, 0);
    const p = playerOf(ctx.world, 0);
    const fundsBefore = p.funds;
    const matsBefore = p.materials;
    ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id));
    ctx.queue.applyDue(ctx.world, 0);
    expect(b.upgradeProgress).toBe(0);
    expect(b.reactors ?? 1).toBe(1);
    expect(p.funds).toBe(fundsBefore - NUCLEAR_UPGRADE_COST_FUNDS);
    expect(p.materials).toBe(matsBefore - NUCLEAR_UPGRADE_COST_MATERIALS);
  });

  it('rejects at max reactors', () => {
    const ctx = setup(102);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    b.reactors = NUCLEAR_MAX_REACTORS;
    richen(ctx.world, 0);
    const reason = rejectionReason(() => ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id)));
    expect(reason).toMatch(/maximum/);
  });

  it('rejects when the owner cannot afford it', () => {
    const ctx = setup(103);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    const p = playerOf(ctx.world, 0);
    p.funds = NUCLEAR_UPGRADE_COST_FUNDS - 1;
    p.materials = NUCLEAR_UPGRADE_COST_MATERIALS;
    const reason = rejectionReason(() => ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id)));
    expect(reason).toMatch(/afford/);
  });

  it('rejects non-nuclear kinds', () => {
    const ctx = setup(104);
    const b = completed(ctx.world, 'powerPlant', 0, 10, 10);
    richen(ctx.world, 0);
    const reason = rejectionReason(() => ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id)));
    expect(reason).toMatch(/only nuclearPlant/);
  });

  it('rejects a second upgrade while one is in progress', () => {
    const ctx = setup(105);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    richen(ctx.world, 0);
    ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id));
    ctx.queue.applyDue(ctx.world, 0);
    expect(b.upgradeProgress).toBe(0);
    const reason = rejectionReason(() => ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id)));
    expect(reason).toMatch(/already in progress/);
  });

  it('rejects while the plant is still under construction', () => {
    const ctx = setup(106);
    const p: Placement = { kind: 'nuclearPlant', owner: 0, cx: 10, cz: 10, facing: 0 };
    const b = placeBuilding(ctx.world.city, p);
    expect(b.progress).toBe(0);
    richen(ctx.world, 0);
    const reason = rejectionReason(() => ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id)));
    expect(reason).toMatch(/finish construction/);
  });

  it("rejects upgrading another owner's building", () => {
    const ctx = setup(107);
    const b = completed(ctx.world, 'nuclearPlant', 1, 10, 10);
    richen(ctx.world, 0);
    const reason = rejectionReason(() => ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id)));
    expect(reason).toMatch(/your own/);
  });

  it('rejects an unknown building id', () => {
    const ctx = setup(108);
    richen(ctx.world, 0);
    const reason = rejectionReason(() => ctx.queue.enqueue(ctx.world, upgradeCmd(0, 99999)));
    expect(reason).toMatch(/no building/);
  });
});

describe('reactor economy math', () => {
  it('power bonus is +45 per reactor beyond the first', () => {
    expect(reactorPowerBonus(1)).toBe(0);
    expect(reactorPowerBonus(2)).toBe(NUCLEAR_REACTOR_POWER_MW);
    expect(reactorPowerBonus(3)).toBe(2 * NUCLEAR_REACTOR_POWER_MW);
    expect(reactorPowerBonus(4)).toBe(3 * NUCLEAR_REACTOR_POWER_MW);
    expect(NUCLEAR_REACTOR_POWER_MW).toBe(45);
  });

  it('water demand bonus is +3 per reactor beyond the first', () => {
    expect(reactorWaterDemandBonus(1)).toBe(0);
    expect(reactorWaterDemandBonus(2)).toBe(NUCLEAR_REACTOR_WATER_DEMAND);
    expect(reactorWaterDemandBonus(4)).toBe(3 * NUCLEAR_REACTOR_WATER_DEMAND);
    expect(NUCLEAR_REACTOR_WATER_DEMAND).toBe(3);
  });

  it('totals are 60/105/150/195 power and 6/9/12/15 water', () => {
    const def = BUILDING_DEFS.nuclearPlant;
    expect(def.powerSupply).toBe(60);
    expect(def.waterDemand).toBe(6);
    const powers = [1, 2, 3, 4].map((r) => def.powerSupply + reactorPowerBonus(r));
    const waters = [1, 2, 3, 4].map((r) => def.waterDemand + reactorWaterDemandBonus(r));
    expect(powers).toEqual([60, 105, 150, 195]);
    expect(waters).toEqual([6, 9, 12, 15]);
  });

  it('an upgraded plant keeps more consumers powered (integration)', () => {
    const mk = (reactors: number) => {
      const ctx = setup(200 + reactors);
      const plant = completed(ctx.world, 'nuclearPlant', 0, 0, 0);
      plant.reactors = reactors;
      // Factories demand 5 power each: 20 factories = 100 demand, more
      // than 1 reactor's 60 but less than 4 reactors' 195.
      const consumers: BuildingRecord[] = [];
      for (let i = 0; i < 20; i++) {
        const c = completed(ctx.world, 'factory', 0, 20 + i * 3, 0);
        consumers.push(c);
      }
      runEconomyTick(ctx.world, ctx.terrain);
      return consumers.filter((c) => c.powered).length;
    };
    const one = mk(1);
    const four = mk(4);
    // 1 reactor (60 power) cannot run all 20 factories; 4 (195) can.
    expect(one).toBeLessThan(20);
    expect(four).toBe(20);
    expect(four).toBeGreaterThan(one);
  });
});

describe('upgrade progress over game time', () => {
  it('completes after 40s and adds the reactor', () => {
    const ctx = setup(300);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    richen(ctx.world, 0);
    ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id));
    ctx.queue.applyDue(ctx.world, 0);
    expect(b.upgradeProgress).toBe(0);
    for (let i = 0; i < NUCLEAR_UPGRADE_SECONDS; i++) {
      runEconomyTick(ctx.world, ctx.terrain);
    }
    expect(b.reactors ?? 1).toBe(2);
    expect(b.upgradeProgress).toBeUndefined();
  });

  it('the plant stays operational at full progress throughout', () => {
    const ctx = setup(301);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    richen(ctx.world, 0);
    ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id));
    ctx.queue.applyDue(ctx.world, 0);
    for (let i = 0; i < NUCLEAR_UPGRADE_SECONDS; i++) {
      runEconomyTick(ctx.world, ctx.terrain);
      expect(b.progress).toBe(1);
      expect(b.operational).toBe(true);
    }
  });

  it('a second upgrade can be issued after the first completes', () => {
    const ctx = setup(302);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    richen(ctx.world, 0);
    for (let r = 1; r < NUCLEAR_MAX_REACTORS; r++) {
      ctx.queue.enqueue(ctx.world, upgradeCmd(0, b.id));
      ctx.queue.applyDue(ctx.world, 0);
      for (let i = 0; i < NUCLEAR_UPGRADE_SECONDS; i++) {
        runEconomyTick(ctx.world, ctx.terrain);
      }
      expect(b.reactors ?? 1).toBe(r + 1);
    }
    expect(b.reactors ?? 1).toBe(NUCLEAR_MAX_REACTORS);
  });
});

describe('snapshot and digest', () => {
  it('snapshot round-trip preserves reactors and in-progress upgrades', () => {
    const ctx = setup(400);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    b.reactors = 3;
    b.upgradeProgress = 0.5;
    const snap = takeSnapshot(ctx.world);
    const world2 = restoreSnapshot(snap);
    const b2 = world2.city.buildings.find((x) => x.id === b.id);
    expect(b2).toBeDefined();
    expect(b2!.reactors ?? 1).toBe(3);
    expect(b2!.upgradeProgress).toBeCloseTo(0.5, 6);
  });

  it('legacy-style records decode to 1 reactor and no upgrade', () => {
    const ctx = setup(401);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    delete b.reactors;
    delete b.upgradeProgress;
    const snap = takeSnapshot(ctx.world);
    const world2 = restoreSnapshot(snap);
    const b2 = world2.city.buildings.find((x) => x.id === b.id);
    expect(b2!.reactors ?? 1).toBe(1);
    expect(b2!.upgradeProgress).toBeUndefined();
  });

  it('the digest changes when reactors change', () => {
    const ctx = setup(402);
    const b = completed(ctx.world, 'nuclearPlant', 0, 10, 10);
    const d1 = digestWorld(ctx.world);
    b.reactors = 2;
    const d2 = digestWorld(ctx.world);
    expect(d2).not.toBe(d1);
    b.upgradeProgress = 0.25;
    const d3 = digestWorld(ctx.world);
    expect(d3).not.toBe(d2);
  });
});

describe('fair-AI reactor upgrades', () => {
  it('a rich AI upgrades its nuclear plant', () => {
    const ctx = setup(500);
    addAIPlayer(ctx.world, 1, 'commander', -100, -100);
    const b = completed(ctx.world, 'nuclearPlant', 1, -90, -90);
    const p = playerOf(ctx.world, 1);
    p.funds = 10000;
    p.materials = 10000;
    thinkNuclearUpgrades(ctx.world, ctx.queue, aiOf(ctx.world));
    ctx.queue.applyDue(ctx.world, 0);
    expect(b.upgradeProgress).toBe(0);
  });

  it('a poor AI does not upgrade', () => {
    const ctx = setup(501);
    addAIPlayer(ctx.world, 1, 'commander', -100, -100);
    const b = completed(ctx.world, 'nuclearPlant', 1, -90, -90);
    const p = playerOf(ctx.world, 1);
    p.funds = 100;
    p.materials = 100;
    thinkNuclearUpgrades(ctx.world, ctx.queue, aiOf(ctx.world));
    ctx.queue.applyDue(ctx.world, 0);
    expect(b.upgradeProgress).toBeUndefined();
  });

  it('the AI skips maxed plants and in-progress upgrades', () => {
    const ctx = setup(502);
    addAIPlayer(ctx.world, 1, 'commander', -100, -100);
    const maxed = completed(ctx.world, 'nuclearPlant', 1, -90, -90);
    maxed.reactors = NUCLEAR_MAX_REACTORS;
    const busy = completed(ctx.world, 'nuclearPlant', 1, -80, -90);
    busy.upgradeProgress = 0.3;
    const p = playerOf(ctx.world, 1);
    p.funds = 10000;
    p.materials = 10000;
    thinkNuclearUpgrades(ctx.world, ctx.queue, aiOf(ctx.world));
    ctx.queue.applyDue(ctx.world, 0);
    // No eligible plant: nothing was enqueued (no new upgrade started).
    expect(maxed.upgradeProgress).toBeUndefined();
    expect(busy.upgradeProgress).toBeCloseTo(0.3, 6);
  });
});
