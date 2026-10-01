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
 * NOVATERRA — civilian sea-trade AI soak tests (Half A, 2026-10-01).
 *
 * A peaceful marshal AI on a coastal map, with the full system stack.
 * The AI's `thinkPeacefulSeaTrade` should:
 *  - Phase 1: build 2 commercialHarbors (when rich)
 *  - Phase 2: establish 1 funds sea route between them
 *  - Phase 3: train 2 cargoFreighters and assign them to the route
 *
 * Asserts:
 *  - the AI reaches the full sea-trade state (2 harbors, 1 route,
 *    2 assigned freighters) within the tick budget;
 *  - zero rejected AI sea-trade orders (establishSeaRoute, spawnUnit,
 *    assignSeaRoute, placeBuilding for the harbors);
 *  - same seed ⇒ identical digest (determinism with AI sea trade).
 *
 * Headless (no DOM/three.js). Deterministic: no wall clock, no Math.random.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
  type CommandQueue,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  registerCityCommands,
  MAP_HALF_SIZE,
  getPlayer,
} from '../src/sim/city';
import { registerUnitCommands } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { createEconomySystem, registerEconomyCommands } from '../src/sim/economy';
import { registerAgeCommands } from '../src/sim/ages';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { grantAllTrainingResources } from './sim.roster-fixtures';

interface Ctx {
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
  rejections: string[];
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/**
 * Find a land cell that has water within the AI's harbor-site sweep
 * radius (PEACEFUL_SEA_SITE_RADIUS = 30 cells). The AI sweeps a
 * 30-cell rect around its base for coastal commercialHarbor sites.
 */
function findCoastalBase(t: TerrainData): { x: number; z: number } {
  for (let z = -MAP_HALF_SIZE + 40; z < MAP_HALF_SIZE - 40; z += 4) {
    for (let x = -MAP_HALF_SIZE + 40; x < MAP_HALF_SIZE - 40; x += 4) {
      if (isWater(t, x, z)) continue;
      // Check for water within 25 cells (inside the 30-cell sweep).
      let nearWater = false;
      for (let dz = -25; dz <= 25 && !nearWater; dz += 5) {
        for (let dx = -25; dx <= 25; dx += 5) {
          if (isWater(t, x + dx, z + dz)) { nearWater = true; break; }
        }
      }
      if (nearWater) return { x, z };
    }
  }
  throw new Error('no coastal base site found');
}

function setupSeaTradeSoak(seed: number): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.peaceful = true;
  // The commercialHarbor (and cargoFreighter/fuelBarge) are industry-age.
  // Start at industry so the sea-trade think isn't age-gated — the test
  // is about the sea-trade phases, not the age climb.
  world.ages.age = 'industry';
  const base = findCoastalBase(terrain);
  addAIPlayer(world, 0, 'marshal', base.x, base.z);
  // Make the AI rich immediately: thinkPeacefulSeaTrade needs
  // funds >= 2000 (PEACEFUL_HOUSING_FUNDS) for harbors + route.
  grantAllTrainingResources(world, 1_000_000);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerEconomyCommands(queue);
  registerAgeCommands(queue);
  const rejections: string[] = [];
  const rawEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = ((w: World, cmd: { kind: string; issuer?: string }) => {
    try {
      rawEnqueue(w, cmd as never);
    } catch (e) {
      if (e instanceof CommandRejectedError && cmd.issuer === 'ai') {
        rejections.push(`${cmd.kind}: ${e.message}`);
      }
      throw e;
    }
  }) as typeof queue.enqueue;
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
      createAISystem(queue, terrain),
    ],
  });
  return { world, queue, driver, rejections };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

interface SeaTradeState {
  harbors: number;
  completedHarbors: number;
  routes: number;
  freighters: number;
  assignedFreighters: number;
}

function seaTradeState(world: World, owner: number): SeaTradeState {
  const harbors = world.city.buildings.filter(
    (b) => b.owner === owner && b.kind === 'commercialHarbor',
  );
  const routes = (world.city.seaRoutes ?? []).filter((r) => r.owner === owner);
  const freighters = world.units.filter(
    (u) => u.owner === owner && u.kind === 'cargoFreighter',
  );
  const routeId = routes[0]?.id ?? 0;
  return {
    harbors: harbors.length,
    completedHarbors: harbors.filter((b) => b.progress >= 1).length,
    routes: routes.length,
    freighters: freighters.length,
    assignedFreighters: freighters.filter((u) => (u.seaRouteId ?? 0) === routeId && routeId !== 0).length,
  };
}

// Marshal thinks every 30 ticks. Harbor construction + 2 harbors
// + route + 2 freighters needs a few hundred ticks; 3600 (120s)
// matches the peaceful-soak budget and is ample.
const SOAK_TICKS = 3600;

describe('civilian sea-trade AI soak (peaceful marshal, coastal)', () => {
  it('builds 2 harbors, 1 funds route, and 2 assigned freighters', () => {
    const ctx = setupSeaTradeSoak(7);
    runTicks(ctx, SOAK_TICKS);
    const s = seaTradeState(ctx.world, 0);
    expect(s.harbors).toBe(2);
    expect(s.completedHarbors).toBe(2);
    expect(s.routes).toBe(1);
    expect(s.freighters).toBeGreaterThanOrEqual(2);
    expect(s.assignedFreighters).toBeGreaterThanOrEqual(2);
    // The route is a funds route (the AI's policy choice).
    const route = (ctx.world.city.seaRoutes ?? []).find((r) => r.owner === 0);
    expect(route?.policy).toBe('funds');
    // No sea-trade order was rejected at apply.
    const seaRejections = ctx.rejections.filter((r) =>
      r.startsWith('establishSeaRoute') || r.startsWith('assignSeaRoute') ||
      (r.startsWith('spawnUnit') && r.includes('cargoFreighter')) ||
      (r.startsWith('placeBuilding') && r.includes('commercialHarbor')),
    );
    expect(seaRejections).toEqual([]);
  });

  it('is deterministic: same seed gives the same digest', () => {
    const a = setupSeaTradeSoak(11);
    runTicks(a, SOAK_TICKS);
    const b = setupSeaTradeSoak(11);
    runTicks(b, SOAK_TICKS);
    expect(digestWorld(b.world)).toBe(digestWorld(a.world));
    // And the sea-trade state matches too.
    expect(seaTradeState(b.world, 0)).toEqual(seaTradeState(a.world, 0));
  });
});
