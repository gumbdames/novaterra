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
 * NOVATERRA — A10: Marshal logistics cheat removal (2026-10-01);
 * C1: AI physical forward base (2026-10-02).
 *
 * The AI's old logistics was a hidden cheat in two parts:
 *  - completed virtual depots minted a flat 12 ammo / 24 fuel PER THINK
 *    from nothing (~6x the player's munitionsFactory rate of 2.0/s,
 *    and the physical fuelDepot/navalBase produce nothing at all);
 *  - thinkNavalSupply loaded ship holds by direct mutation
 *    (`u.cargoFuel += take`), bypassing the command queue.
 *
 * The honest model, pinned here:
 *  - creditVirtualDepotStocks: a LIVE physical ordnanceDepot (C1:
 *    complete, operational, hp > 0 — see findLiveForwardDepot) yields
 *    the munitionsFactory's effective production rate (2.0/s, Advanced
 *    Logistics x1.5) and PAYS the factory's input costs (materials 0.4/s
 *    + funds 0.6/s); a live physical fuelDepot — or the legacy virtual
 *    navalBase sea chain (unchanged) — yields the oilRefinery's rate
 *    (1.5 fuel/s) and pays its input (materials 0.3/s). Per think,
 *    scaled by the think cadence, all-or-nothing (a starved chain
 *    produces nothing), capped at the depots' effective storage.
 *    No live depot (or no virtual navalBase) ⇒ no yield, nothing
 *    minted from nothing.
 *  - `loadCargoVirtual`: the AI's counterpart to the player's `loadCargo`
 *    — its completed virtual navalBase is its docks. Fuel/ammo move from
 *    the abstract virtual stocks into supply-ship holds through the
 *    command queue (validated at enqueue AND at apply, deterministic,
 *    loud when nothing can transfer). AI-only; the human path stays the
 *    physical loadCargo.
 */

import { describe, expect, it } from 'vitest';
import {
  CommandRejectedError,
  createCommandQueue,
  registerCoreCommands,
  registerLogisticsCommands,
  type CommandQueue,
} from '../src/sim/commands';
import { createWorld, type World } from '../src/sim/world';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  findUnit,
  registerUnitCommands,
  spawnUnit,
  UNIT_DEFS,
} from '../src/sim/units';
import { getPlayer, placeBuilding } from '../src/sim/city';
import { hasUpgrade } from '../src/sim/upgrades';
import {
  addAIPlayer,
  createAISystem,
  creditVirtualDepotStocks,
  type AIDifficulty,
  type AIPlayerState,
  type ForwardDepotKind,
} from '../src/sim/ai';
import {
  generateTerrain,
  type TerrainData,
} from '../src/sim/terrain';
import { grantAllTrainingResources } from './sim.roster-fixtures';

function rejectionReason(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).reason;
  }
  throw new Error('expected a CommandRejectedError but none was thrown');
}

function grantUpgrade(world: World, owner: number, id: string): void {
  (world.upgrades[owner] ??= []).push(id);
  expect(hasUpgrade(world, owner, id)).toBe(true);
}

/** World + AI owner with generous funds/materials; no driver needed. */
function setupEconomics(seed = 20261002, difficulty: AIDifficulty = 'marshal'): {
  world: World;
  ai: AIPlayerState;
} {
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  addAIPlayer(world, 0, difficulty, 0, 0);
  const ai = world.ai.players[0]!;
  return { world, ai };
}

function playerStocks(world: World): { funds: number; materials: number } {
  const p = getPlayer(world.city, 0)!;
  return { funds: p.funds, materials: p.materials };
}

/**
 * C1 (2026-10-02): place a LIVE physical forward depot for the AI owner —
 * complete, operational, standing. This is the anchor
 * creditVirtualDepotStocks requires (findLiveForwardDepot). The direct
 * placeBuilding helper (not the command) keeps the economics tests
 * focused on the credit, not the command queue.
 */
function placeLiveDepot(world: World, kind: ForwardDepotKind, cx = 20, cz = 20): void {
  const b = placeBuilding(world.city, { kind, owner: 0, cx, cz, facing: 0 });
  b.progress = 1;
  b.operational = true;
  expect(b.hp).toBeGreaterThan(0);
}

describe('creditVirtualDepotStocks — honest production economics', () => {
  it('a live physical ordnanceDepot yields the munitionsFactory rate and pays its inputs', () => {
    const { world, ai } = setupEconomics();
    placeLiveDepot(world, 'ordnanceDepot');
    const before = playerStocks(world);
    creditVirtualDepotStocks(world, ai);
    // Marshal thinks every 30 ticks = 1 sim-second: 2.0 ammo produced,
    // 0.4 materials + 0.6 funds of input paid.
    expect(ai.virtualAmmoStock).toBe(2.0);
    expect(playerStocks(world).materials).toBeCloseTo(before.materials - 0.4, 9);
    expect(playerStocks(world).funds).toBeCloseTo(before.funds - 0.6, 9);
    // Fuel is untouched — the ammo chain makes no fuel.
    expect(ai.virtualFuelStock ?? 0).toBe(0);
  });

  it('a virtual ordnanceDepot alone yields NOTHING — the land chain is physical now (C1)', () => {
    const { world, ai } = setupEconomics();
    ai.virtualBuildings.completed.push('ordnanceDepot');
    const before = playerStocks(world);
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock ?? 0).toBe(0);
    expect(playerStocks(world)).toEqual(before);
  });

  it('the ammo chain is all-or-nothing when inputs are unaffordable', () => {
    const { world, ai } = setupEconomics();
    placeLiveDepot(world, 'ordnanceDepot');
    const p = getPlayer(world.city, 0)!;
    p.materials = 0.2; // below the 0.4/s input cost
    p.funds = 1000;
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock ?? 0).toBe(0);
    expect(p.materials).toBe(0.2);
    expect(p.funds).toBe(1000);
  });

  it('the ammo stock is capped at the depot effective storage', () => {
    const { world, ai } = setupEconomics();
    placeLiveDepot(world, 'ordnanceDepot');
    ai.virtualAmmoStock = 149;
    creditVirtualDepotStocks(world, ai);
    // ordnanceDepot ammoStorage is 150 — the +2.0 is clamped, not dropped.
    expect(ai.virtualAmmoStock).toBe(150);
  });

  it('an incomplete depot yields nothing — the anchor needs progress >= 1 (C1)', () => {
    const { world, ai } = setupEconomics();
    const b = placeBuilding(world.city, { kind: 'ordnanceDepot', owner: 0, cx: 20, cz: 20, facing: 0 });
    b.progress = 0.5; // still constructing
    b.operational = true;
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock ?? 0).toBe(0);
  });

  it('a non-operational depot yields nothing — the anchor needs operational (C1)', () => {
    const { world, ai } = setupEconomics();
    const b = placeBuilding(world.city, { kind: 'ordnanceDepot', owner: 0, cx: 20, cz: 20, facing: 0 });
    b.progress = 1;
    b.operational = false; // upkeep unfunded
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock ?? 0).toBe(0);
  });

  it('a live physical fuelDepot yields the oilRefinery rate and pays its input', () => {
    const { world, ai } = setupEconomics();
    placeLiveDepot(world, 'fuelDepot');
    const before = playerStocks(world);
    creditVirtualDepotStocks(world, ai);
    // 1.5 fuel/s produced, 0.3 materials/s of input paid.
    expect(ai.virtualFuelStock).toBe(1.5);
    expect(playerStocks(world).materials).toBeCloseTo(before.materials - 0.3, 9);
    // Ammo is untouched — the fuel chain makes no ammo.
    expect(ai.virtualAmmoStock ?? 0).toBe(0);
  });

  it('a virtual fuelDepot alone yields NOTHING — the land chain is physical now (C1)', () => {
    const { world, ai } = setupEconomics();
    ai.virtualBuildings.completed.push('fuelDepot');
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualFuelStock ?? 0).toBe(0);
  });

  it('one fuel chain even with depot + navalBase — a second source is a cache, not a refinery', () => {
    const { world, ai } = setupEconomics();
    placeLiveDepot(world, 'fuelDepot');
    ai.virtualBuildings.completed.push('navalBase');
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualFuelStock).toBe(1.5);
  });

  it('the fuel cap is the largest live fuel-capable source storage', () => {
    const { world, ai } = setupEconomics();
    placeLiveDepot(world, 'fuelDepot');
    ai.virtualBuildings.completed.push('navalBase');
    ai.virtualFuelStock = 299.5;
    creditVirtualDepotStocks(world, ai);
    // navalBase fuelStorage 300 > fuelDepot 250: clamped to 300, not 251.
    expect(ai.virtualFuelStock).toBe(300);
  });

  it('a completed navalBase alone yields no ammo — no double-dip with the land chain', () => {
    const { world, ai } = setupEconomics();
    ai.virtualBuildings.completed.push('navalBase');
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock ?? 0).toBe(0);
    expect(ai.virtualFuelStock).toBe(1.5);
  });

  it('no depots, no yield — nothing is minted from nothing', () => {
    const { world, ai } = setupEconomics();
    const before = playerStocks(world);
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock ?? 0).toBe(0);
    expect(ai.virtualFuelStock ?? 0).toBe(0);
    expect(playerStocks(world)).toEqual(before);
  });

  it('Advanced Logistics multiplies the physical ammo rate, like the physical factory', () => {
    const { world, ai } = setupEconomics();
    placeLiveDepot(world, 'ordnanceDepot');
    grantUpgrade(world, 0, 'advancedLogistics');
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock).toBe(3.0); // 2.0 x 1.5
  });

  it('the per-think yield scales with the think cadence (citizen: 4 sim-seconds)', () => {
    // C1: citizen builds no depots, so this pins the cadence scaling
    // with directly-placed physical depots (the credit is cadence-driven,
    // not roster-driven).
    const { world, ai } = setupEconomics(20261002, 'citizen');
    placeLiveDepot(world, 'ordnanceDepot', 20, 20);
    placeLiveDepot(world, 'fuelDepot', 24, 20);
    const before = playerStocks(world);
    creditVirtualDepotStocks(world, ai);
    // Citizen thinks every 120 ticks = 4 sim-seconds.
    expect(ai.virtualAmmoStock).toBe(8.0);
    expect(ai.virtualFuelStock).toBe(6.0);
    expect(playerStocks(world).materials).toBeCloseTo(before.materials - (0.4 + 0.3) * 4, 9);
    expect(playerStocks(world).funds).toBeCloseTo(before.funds - 0.6 * 4, 9);
  });
});

describe('loadCargoVirtual — the AI loads through the command queue', () => {
  let terrain: TerrainData;
  function getTerrain(): TerrainData {
    terrain ??= generateTerrain(20261002);
    return terrain;
  }

  function setupCommand(): {
    world: World;
    queue: CommandQueue;
    driver: TickDriver;
    ai: AIPlayerState;
  } {
    const terrain = getTerrain();
    const world = createWorld(20261002);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerLogisticsCommands(queue, terrain);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    ai.virtualBuildings.completed.push('navalBase');
    const driver = createTickDriver({ queue, systems: [] });
    return { world, queue, driver, ai };
  }

  function step(driver: TickDriver, world: World, n: number): void {
    for (let i = 0; i < n; i++) driver.step(world, TICK_MS);
  }

  function enqueueLoad(queue: CommandQueue, world: World, unitId: number, owner: number): void {
    queue.enqueue(world, { issuer: 'ai', kind: 'loadCargoVirtual', payload: { unitId, owner } });
  }

  it('loads fuel and ammo from the virtual stocks through enqueue → apply', () => {
    const { world, queue, driver, ai } = setupCommand();
    ai.virtualFuelStock = 100;
    ai.virtualAmmoStock = 50;
    const tanker = spawnUnit(world, 'fuelTanker', 0, 0, 0);
    const ship = spawnUnit(world, 'ammoShip', 0, 10, 0);
    enqueueLoad(queue, world, tanker.id, 0);
    enqueueLoad(queue, world, ship.id, 0);
    expect(queue.pendingCount()).toBe(2);
    // Nothing has moved yet — the transfer happens at apply, next tick.
    expect(findUnit(world, tanker.id)!.cargoFuel).toBe(0);
    step(driver, world, 2);
    expect(findUnit(world, tanker.id)!.cargoFuel).toBe(100);
    expect(findUnit(world, ship.id)!.cargoAmmo).toBe(50);
    expect(ai.virtualFuelStock).toBe(0);
    expect(ai.virtualAmmoStock).toBe(0);
  });

  it('ammo is floored, fuel stays fractional, holds are never overfilled', () => {
    const { world, queue, driver, ai } = setupCommand();
    ai.virtualFuelStock = 5.25;
    ai.virtualAmmoStock = 10.9;
    const tanker = spawnUnit(world, 'fuelTanker', 0, 0, 0);
    const ship = spawnUnit(world, 'ammoShip', 0, 10, 0);
    // Partially-filled holds: only the room moves.
    tanker.cargoFuel = 398; // hold 400
    enqueueLoad(queue, world, tanker.id, 0);
    enqueueLoad(queue, world, ship.id, 0);
    step(driver, world, 2);
    expect(findUnit(world, tanker.id)!.cargoFuel).toBe(400);
    expect(ai.virtualFuelStock).toBeCloseTo(3.25, 9);
    expect(findUnit(world, ship.id)!.cargoAmmo).toBe(10); // floored
    expect(ai.virtualAmmoStock).toBeCloseTo(0.9, 9);
  });

  it('rejects for a human owner — the player path is the physical loadCargo', () => {
    const { world, queue, ai } = setupCommand();
    ai.virtualFuelStock = 100;
    const tanker = spawnUnit(world, 'fuelTanker', 1, 0, 0);
    const reason = rejectionReason(() => enqueueLoad(queue, world, tanker.id, 1));
    expect(reason).toMatch(/not an AI player/);
  });

  it('rejects without a completed virtual navalBase — the AI needs its docks', () => {
    const { world, queue, ai } = setupCommand();
    ai.virtualBuildings.completed.length = 0;
    ai.virtualFuelStock = 100;
    const tanker = spawnUnit(world, 'fuelTanker', 0, 0, 0);
    const reason = rejectionReason(() => enqueueLoad(queue, world, tanker.id, 0));
    expect(reason).toMatch(/no completed virtual navalBase/);
  });

  it('rejects when nothing can transfer — full holds or empty stocks, loudly', () => {
    const { world, queue, ai } = setupCommand();
    const tanker = spawnUnit(world, 'fuelTanker', 0, 0, 0);
    // Empty stocks.
    const reason = rejectionReason(() => enqueueLoad(queue, world, tanker.id, 0));
    expect(reason).toMatch(/nothing to load/);
    // Full hold.
    ai.virtualFuelStock = 100;
    tanker.cargoFuel = UNIT_DEFS.fuelTanker.cargoFuelCapacity ?? 0;
    const reason2 = rejectionReason(() => enqueueLoad(queue, world, tanker.id, 0));
    expect(reason2).toMatch(/nothing to load/);
  });

  it('rejects for a non-supply unit', () => {
    const { world, queue, ai } = setupCommand();
    ai.virtualFuelStock = 100;
    const rifles = spawnUnit(world, 'rifles', 0, 0, 0);
    const reason = rejectionReason(() => enqueueLoad(queue, world, rifles.id, 0));
    expect(reason).toMatch(/not a supply unit/);
  });

  it('rejects in peaceful mode, like loadCargo', () => {
    const { world, queue, ai } = setupCommand();
    world.peaceful = true;
    ai.virtualFuelStock = 100;
    const tanker = spawnUnit(world, 'fuelTanker', 0, 0, 0);
    const reason = rejectionReason(() => enqueueLoad(queue, world, tanker.id, 0));
    expect(reason).toMatch(/peaceful/);
  });
});

describe('thinkNavalSupply — the tail loads via the queue, never by direct mutation', () => {
  it('a tanker holds nothing before the think and loads the think after, through apply', () => {
    const terrain = generateTerrain(20261002);
    const world = createWorld(20261002);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerLogisticsCommands(queue, terrain);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    ai.navalStatus = 'coastal';
    ai.navalWater = { x: 0, z: 0 };
    ai.virtualBuildings.completed.push('navalBase');
    ai.virtualFuelStock = 100;
    const tanker = spawnUnit(world, 'fuelTanker', 0, 0, 0);
    const driver = createTickDriver({
      queue,
      systems: [createAISystem(queue)],
    });
    // 29 ticks: no marshal think yet (cadence 30) — no direct mutation
    // is possible; the hold must still be empty.
    for (let i = 0; i < 29; i++) driver.step(world, TICK_MS);
    expect(findUnit(world, tanker.id)!.cargoFuel).toBe(0);
    // The think fires on the next step (systems see the pre-increment
    // tick) and its `loadCargoVirtual` applies the step after: the
    // stock also grew by the honest 1.5/s fuel-chain yield for the one
    // think (100 + 1.5), all of it loaded.
    for (let i = 0; i < 3; i++) driver.step(world, TICK_MS);
    expect(findUnit(world, tanker.id)!.cargoFuel).toBe(101.5);
    expect(ai.virtualFuelStock).toBe(0);
  });
});
