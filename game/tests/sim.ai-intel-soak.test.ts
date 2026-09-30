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
 * NOVATERRA — AI intel play soak (grand-expansion Phase 7, AI intel play).
 *
 * Marshal-vs-marshal, 3600 ticks (120 sim-seconds), intel enabled:
 *  - both AIs start at the information age with a complete virtual
 *    production base and virtual intel buildings (listeningPost,
 *    intelHQ), plus granted intel assets (30 operational / 30
 *    surveillance / 20 counter-intel) so covert ops can run from the
 *    first think (from-scratch accrual pacing is unit-tested in
 *    sim.ai-intel.test.ts);
 *  - enemy buildings are placed near each base so spies have
 *    infiltration targets in pathing range.
 *
 * Asserts the Phase 7 "Deployable when" properties:
 *  - no crashes over the long run (AI thinks + intel system + combat +
 *    movement + economy, with the per-think spend ledger active);
 *  - the intel ops counters move (spies trained, infiltrations,
 *    steals/sabotages attempted);
 *  - same seed ⇒ identical digest (determinism with the intel play);
 *  - mid-soak save/load ⇒ identical digest (snapshot covers the intel
 *    state — AD9 additive, no version bump).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  type CommandQueue,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import { getPlayer, MAP_HALF_SIZE, CELL_WORLD_SIZE } from '../src/sim/city';
import { createEconomySystem } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { registerUnitCommands } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import {
  createIntelSystem,
  registerIntelCommands,
} from '../src/sim/intel';
import { registerUpgradeCommands } from '../src/sim/upgrades';
import {
  addAIPlayer,
  createAISystem,
  type AIDifficulty,
  type AIPlayerState,
} from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';

interface SoakCtx {
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
  ai0: AIPlayerState;
  ai1: AIPlayerState;
  terrain: TerrainData;
}

/** Cell coordinate whose center is nearest to world x. */
function worldToCell(x: number): number {
  return Math.round((x + MAP_HALF_SIZE) / CELL_WORLD_SIZE - 0.5);
}

/** Marshal-vs-marshal intel soak fixture. */
function setupIntelSoak(seed: number): SoakCtx {
  const terrain: TerrainData = generateTerrain(MERIDIAN_PLAINS.seed);
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  world.ages.age = 'information';
  // Two bases on opposite sides of the map.
  addAIPlayer(world, 0, 'marshal' as AIDifficulty, -120, 0);
  addAIPlayer(world, 1, 'marshal' as AIDifficulty, 120, 0);
  const ai0 = world.ai.players[0]!;
  const ai1 = world.ai.players[1]!;
  for (const ai of [ai0, ai1]) {
    // Complete virtual production base (marshal, non-coastal) + the
    // intel buildings the doctrine needs.
    ai.virtualBuildings.completed.push(
      'barracks',
      'warFactory',
      'lab',
      'airfield',
      'radarStation',
      'civilAirport',
      'listeningPost',
      'intelHQ',
    );
    const player = getPlayer(world.city, ai.owner)!;
    // Granted assets so covert ops run from the first think.
    player.intel.operational = 30;
    player.intel.surveillance = 30;
    player.intel.counterIntel = 20;
  }
  // Give each side a unique upgrade so steal has a stealable tech:
  // pickStealableTech needs the victim to own something the thief lacks.
  world.upgrades[0] = ['compositeArmor'];
  world.upgrades[1] = ['apRounds'];

  // Enemy buildings near each base: infiltration targets in pathing
  // range (a barracks and a lab each — high-value steal/sabotage
  // targets per intelTargetValue). completeBuilding takes cell coords;
  // convert from world coords near each base.
  const b0x = -120;
  const b1x = 120;
  completeBuilding(world, 'barracks', 1, worldToCell(b0x + 24), worldToCell(10));
  completeBuilding(world, 'lab', 1, worldToCell(b0x + 30), worldToCell(-10));
  completeBuilding(world, 'barracks', 0, worldToCell(b1x - 24), worldToCell(-10));
  completeBuilding(world, 'lab', 0, worldToCell(b1x - 30), worldToCell(10));
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerIntelCommands(queue);
  registerUpgradeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
      createIntelSystem(),
      createAISystem(queue),
    ],
  });
  return { world, queue, driver, ai0, ai1, terrain };
}

/** Fresh driver+queue for a restored world (never share a queue across worlds). */
function freshDriver(terrain: TerrainData) {
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerIntelCommands(queue);
  registerUpgradeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
      createIntelSystem(),
      createAISystem(queue),
    ],
  });
  return { queue, driver };
}

/** Run the soak for `ticks` ticks; returns the ops counters. */
function runSoak(ctx: SoakCtx, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    ctx.driver.step(ctx.world, TICK_MS);
  }
}

describe('AI intel play soak (marshal vs marshal, 3600 ticks)', () => {
  it('runs 3600 ticks with no crash and the intel ops counters move', () => {
    const ctx = setupIntelSoak(20260930);
    runSoak(ctx, 3600);
    const ops0 = ctx.ai0.intel.ops;
    const ops1 = ctx.ai1.intel.ops;
    const infiltrate = ops0.infiltrate + ops1.infiltrate;
    const steal = ops0.steal + ops1.steal;
    const sabotage = ops0.sabotage + ops1.sabotage;
    // Spies were trained (the quota is 3 per marshal; some may have
    // died in the fighting).
    const spies0 = ctx.world.units.filter(
      (u) => u.owner === 0 && u.kind === 'spy' && u.hp > 0,
    ).length;
    const spies1 = ctx.world.units.filter(
      (u) => u.owner === 1 && u.kind === 'spy' && u.hp > 0,
    ).length;
    console.log(
      `[intel soak] infiltrate=${infiltrate} steal=${steal} sabotage=${sabotage} ` +
        `spiesAlive=${spies0 + spies1}`,
    );
    expect(infiltrate).toBeGreaterThan(0);
    // At least one covert op (steal or sabotage) fired.
    expect(steal + sabotage).toBeGreaterThan(0);
    expect(spies0 + spies1).toBeGreaterThan(0);
  });

  it('same seed + same script ⇒ identical digest with the intel play soaking', () => {
    const runMatch = (seed: number): number => {
      const ctx = setupIntelSoak(seed);
      runSoak(ctx, 3600);
      return digestWorld(ctx.world);
    };
    expect(runMatch(777)).toBe(runMatch(777));
  });

  it('mid-soak save/load ⇒ identical digest (intel state survives)', () => {
    const ctx = setupIntelSoak(4242);
    runSoak(ctx, 1800);
    const snap = takeSnapshot(ctx.world);
    const restored = restoreSnapshot(
      JSON.parse(JSON.stringify(snap)) as ReturnType<typeof takeSnapshot>,
    );
    // Fresh driver+queue for the restored world — never share a queue
    // across worlds (pending commands would cross-contaminate).
    const { driver: driver2 } = freshDriver(ctx.terrain);
    // Continue the restored world to 3600.
    const rai0 = restored.ai.players.find((p) => p.owner === 0)!;
    const rai1 = restored.ai.players.find((p) => p.owner === 1)!;
    for (let i = 0; i < 1800; i++) {
      driver2.step(restored, TICK_MS);
    }
    runSoak(ctx, 1800); // uninterrupted to 3600
    expect(digestWorld(restored)).toBe(digestWorld(ctx.world));
    // The intel ops counters survived the round-trip.
    expect(rai0.intel.ops.infiltrate).toBe(ctx.ai0.intel.ops.infiltrate);
    expect(rai1.intel.ops.infiltrate).toBe(ctx.ai1.intel.ops.infiltrate);
  });
});
