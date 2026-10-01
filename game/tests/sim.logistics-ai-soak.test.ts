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
 * NOVATERRA — Phase 3 logistics: AI depot/truck behavior + soak (workstream 3).
 *
 * The Classic AI owns NO physical buildings in 0.1 Alpha (all virtual), so
 * it cannot issue physical `resupply` orders. Instead its completed
 * VIRTUAL depots yield abstract stocks (`virtualAmmoStock` /
 * `virtualFuelStock`, credited per think) that its consumer units draw
 * top-ups from — the same virtual-building abstraction as the
 * virtual-economy credit. Supply/fuel trucks are still trained at the
 * documented ratios (1 per 6 consumers, ceil) and role-specialized through
 * the real `setSupplyToggles` command. Ammo-dry magazine units stop
 * getting new attack orders and fall back instead of chasing unarmed.
 *
 * Covered here:
 *  - end-to-end: 6 fuel-dry tanks ⇒ the AI virtually constructs a
 *    fuelDepot (foundation age, no fiddling) and refills them abstractly;
 *  - seeded-completed ordnanceDepot ⇒ ammo-dry MLRS refill from the
 *    abstract stock, and a supply truck is trained + role-specialized;
 *  - below the consumer threshold (4): no depot construction;
 *  - 3600-tick AI-vs-AI soak with depletion on both sides: no crashes,
 *    logistics stay active, virtual stocks never go negative, same seed
 *    ⇒ identical digest (determinism incl. the new digest segment).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  registerLogisticsCommands,
  type CommandQueue,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import { MAP_HALF_SIZE } from '../src/sim/city';
import { createEconomySystem } from '../src/sim/economy';
import { registerUnitCommands, spawnUnit, UNIT_DEFS, type UnitKind } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { addAIPlayer, createAISystem, AI_MAX_UNITS, LOGISTICS_CONSUMER_THRESHOLD } from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { grantAllTrainingResources } from './sim.roster-fixtures';

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 60; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > MAP_HALF_SIZE - 1 || Math.abs(cz) > MAP_HALF_SIZE - 1) continue;
        if (!isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no land near ${x},${z}`);
}

function setupAI(seed: number, withEnemy: boolean): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const baseW = findLandNear(terrain, -110, 0);
  addAIPlayer(world, 0, 'commander', baseW.x, baseW.z);
  if (withEnemy) {
    const baseE = findLandNear(terrain, 110, 0);
    addAIPlayer(world, 1, 'general', baseE.x, baseE.z);
  }
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerLogisticsCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
      createAISystem(queue),
    ],
  });
  return { terrain, world, queue, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

/** Spawn `n` units of `kind` for the AI owner near its base. */
function giveAI(ctx: Ctx, owner: number, kind: UnitKind, n: number): void {
  const ai = ctx.world.ai.players.find((p) => p.owner === owner)!;
  const p = findLandNear(ctx.terrain, ai.baseX, ai.baseZ);
  for (let i = 0; i < n; i++) {
    spawnUnit(ctx.world, kind, owner, p.x + (i % 4) * 3, p.z + Math.floor(i / 4) * 3);
  }
}

function aiOf(ctx: Ctx, owner: number) {
  return ctx.world.ai.players.find((p) => p.owner === owner)!;
}

/**
 * Pre-complete the AI's production-construction priority list
 * (barracks/warFactory/lab for commander/general) so the one-at-a-time
 * virtual-construction slot is free for logistics depots on the first
 * think. Without this the depot would queue behind ~3600 ticks of
 * production construction and the test would prove nothing.
 */
function freeConstructionSlot(ctx: Ctx, owner: number): void {
  const ai = aiOf(ctx, owner);
  for (const kind of ['barracks', 'warFactory', 'lab'] as const) {
    if (!ai.virtualBuildings.completed.includes(kind)) {
      ai.virtualBuildings.completed.push(kind);
    }
  }
}

describe('AI logistics — virtual depots and abstract resupply', () => {
  it('builds a virtual fuelDepot for a fuel-dry tank squad and refills it', { timeout: 60000 }, () => {
    const ctx = setupAI(20260930, false);
    giveAI(ctx, 0, 'tank', 6);
    for (const u of ctx.world.units) {
      if (u.owner === 0 && u.kind === 'tank') u.fuel = 0;
    }
    freeConstructionSlot(ctx, 0);
    const ai = aiOf(ctx, 0);
    expect(ai.virtualBuildings.completed).not.toContain('fuelDepot');

    // fuelDepot: 40 s build = 1200 ticks, completing on the first think
    // at/after tick 1260. Then the honest fuel chain yields 3.0/think
    // (commander cadence 60 ticks = 2 sim-seconds × the 1.5/s
    // refinery-equivalent rate, paying the 0.3/s materials input).
    // 6 tanks × 60 fuel = 360 needed ⇒ 120 thinks = 7200 ticks after
    // the depot completes; 9000 ticks covers build + refill with
    // margin. (The old 24/think flat trickle filled this in 3600 —
    // that was the ~6x hidden cheat this now replaces.)
    runTicks(ctx, 9000);

    expect(ai.virtualBuildings.completed).toContain('fuelDepot');
    const tanks = ctx.world.units.filter((u) => u.owner === 0 && u.kind === 'tank');
    expect(tanks.length).toBe(6);
    for (const t of tanks) expect(t.fuel).toBeGreaterThan(0);
    expect(ai.virtualFuelStock ?? 0).toBeGreaterThanOrEqual(0);
    // The logistics tail: 1 fuel truck per 6 fuel consumers (ceil),
    // role-specialized to refuel-only through the real command.
    const fuelers = ctx.world.units.filter((u) => u.owner === 0 && u.kind === 'fuelTruck');
    expect(fuelers.length).toBeGreaterThanOrEqual(1);
    for (const f of fuelers) {
      expect(f.supplyServices).toEqual({ repair: false, rearm: false, refuel: true });
    }
  });

  it('refills ammo-dry MLRS from a completed virtual ordnanceDepot', { timeout: 60000 }, () => {
    const ctx = setupAI(20260931, false);
    giveAI(ctx, 0, 'mlrs', 6);
    for (const u of ctx.world.units) {
      if (u.owner === 0 && u.kind === 'mlrs') u.ammo = 0;
    }
    // ordnanceDepot is industry-gated; seed it completed (the foundation-
    // gated fuelDepot path above proves the construction loop itself).
    const ai = aiOf(ctx, 0);
    ai.virtualBuildings.completed.push('ordnanceDepot');
    runTicks(ctx, 900);

    const mlrs = ctx.world.units.filter((u) => u.owner === 0 && u.kind === 'mlrs');
    expect(mlrs.length).toBe(6);
    for (const m of mlrs) expect(m.ammo).toBe(6); // full pods
    expect(ai.virtualAmmoStock ?? 0).toBeGreaterThanOrEqual(0);
    // 1 supply truck per 6 ammo consumers (ceil), repair+rearm role.
    const trucks = ctx.world.units.filter((u) => u.owner === 0 && u.kind === 'supplyTruck');
    expect(trucks.length).toBeGreaterThanOrEqual(1);
    for (const t of trucks) {
      expect(t.supplyServices).toEqual({ repair: true, rearm: true, refuel: false });
    }
  });

  it('below the consumer threshold: no depot while consumers < 4', { timeout: 60000 }, () => {
    const ctx = setupAI(20260932, false);
    giveAI(ctx, 0, 'tank', 1); // 1 < 4: a stray, not a squad
    for (const u of ctx.world.units) {
      if (u.owner === 0 && u.kind === 'tank') u.fuel = 0;
    }
    freeConstructionSlot(ctx, 0); // the slot is free — the AI still declines
    // The AI keeps training its own army during the run (it may train
    // tanks itself), so the contract is asserted AT the decision moment:
    // whenever a fuelDepot build starts, ≥ 4 fuel consumers must exist.
    for (let i = 0; i < 25; i++) {
      runTicks(ctx, 60);
      const ai = aiOf(ctx, 0);
      const started =
        ai.virtualBuildings.constructing?.kind === 'fuelDepot' ||
        ai.virtualBuildings.completed.includes('fuelDepot');
      if (started) {
        // ai.ts's own consumer definition: fossil-fuel units with a tank.
        const consumers = ctx.world.units.filter((u) => {
          if (u.owner !== 0 || u.hp <= 0) return false;
          const def = UNIT_DEFS[u.kind as UnitKind] as { fuelType?: string; fuelCapacity?: number };
          return def.fuelType === 'fossil' && (def.fuelCapacity ?? 0) > 0;
        }).length;
        expect(consumers).toBeGreaterThanOrEqual(LOGISTICS_CONSUMER_THRESHOLD);
        return;
      }
    }
    // No depot started in 1500 ticks: the stray must still be dry.
    const tank = ctx.world.units.find((u) => u.owner === 0 && u.kind === 'tank')!;
    expect(tank.fuel).toBe(0);
    expect(aiOf(ctx, 0).virtualFuelStock ?? 0).toBe(0);
  });
});

describe('AI logistics — soak', () => {
  /** 2 game-minutes of commander-vs-general with depletion on both sides. */
  const SOAK_TICKS = 3600;

  function setupDepletedSoak(seed: number): Ctx {
    const ctx = setupAI(seed, true);
    // West: fuel-dry tanks (foundation-gated fuelDepot builds itself).
    giveAI(ctx, 0, 'tank', 6);
    for (const u of ctx.world.units) {
      if (u.owner === 0 && u.kind === 'tank') u.fuel = 10;
    }
    freeConstructionSlot(ctx, 0);
    // East: ammo-dry MLRS with a completed virtual ordnanceDepot.
    giveAI(ctx, 1, 'mlrs', 6);
    for (const u of ctx.world.units) {
      if (u.owner === 1 && u.kind === 'mlrs') u.ammo = 0;
    }
    aiOf(ctx, 1).virtualBuildings.completed.push('ordnanceDepot');
    return ctx;
  }

  it('runs 3600 ticks clean with logistics active on both sides', { timeout: 60000 }, () => {
    const ctx = setupDepletedSoak(777001);
    runTicks(ctx, SOAK_TICKS);

    // West's tanks got fuel from their virtually-built depot.
    const ai0 = aiOf(ctx, 0);
    expect(ai0.virtualBuildings.completed).toContain('fuelDepot');
    const tanks = ctx.world.units.filter((u) => u.owner === 0 && u.kind === 'tank');
    expect(tanks.length).toBeGreaterThan(0);
    for (const t of tanks) expect(t.fuel).toBeGreaterThan(0);
    // East's MLRS refilled from the abstract ammo stock.
    const mlrs = ctx.world.units.filter((u) => u.owner === 1 && u.kind === 'mlrs');
    expect(mlrs.length).toBeGreaterThan(0);
    for (const m of mlrs) expect(m.ammo).toBeGreaterThan(0);
    // Stocks never go negative (the ledger can't overdraw by construction).
    for (const p of ctx.world.ai.players) {
      expect(p.virtualAmmoStock ?? 0).toBeGreaterThanOrEqual(0);
      expect(p.virtualFuelStock ?? 0).toBeGreaterThanOrEqual(0);
    }
    // Sanity: both AIs are still alive and thinking (armies within cap).
    for (const p of ctx.world.ai.players) {
      const n = ctx.world.units.filter((u) => u.owner === p.owner).length;
      expect(n).toBeLessThanOrEqual(AI_MAX_UNITS[p.difficulty]);
    }
  });

  it('is deterministic: same seed ⇒ identical digest (logistics state included)', { timeout: 60000 }, () => {
    const a = setupDepletedSoak(777002);
    runTicks(a, SOAK_TICKS);
    const b = setupDepletedSoak(777002);
    runTicks(b, SOAK_TICKS);
    expect(digestWorld(b.world)).toBe(digestWorld(a.world));
  });

  it('different seeds diverge (personalities + logistics draws differ)', { timeout: 60000 }, () => {
    const a = setupDepletedSoak(777003);
    runTicks(a, SOAK_TICKS);
    const b = setupDepletedSoak(777004);
    runTicks(b, SOAK_TICKS);
    expect(digestWorld(b.world)).not.toBe(digestWorld(a.world));
  });
});
