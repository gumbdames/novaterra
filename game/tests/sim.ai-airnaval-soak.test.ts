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
 * NOVATERRA — air/naval AI-vs-AI soak (grand-expansion Phase 5/6,
 * workstream D).
 *
 * The Classic AI is a military rival with new air/naval responsibilities:
 * hangar-aware training (canTrain gates aircraft on virtual hangar
 * slots), carrier wings (filled before sailing — never sails empty),
 * carrier escorts, and civil airports on the marshal's build list.
 * This soak runs the full marshal-vs-general match with scripted
 * air/naval content — physical airfields (real hangar slots), carriers
 * with empty wings, carrier-capable aircraft, and a naval screen — to
 * prove nothing in the new AI paths crashes, corrupts funds, breaks
 * seed-determinism, or loses hangar/embark state across save/load.
 *
 * Mirrors sim.ai-soak.test.ts (setupSoak pattern, 3600 ticks).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
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
  MAP_HALF_SIZE,
  placeBuilding,
  type BuildingKind,
  type Placement,
  type ResourceKey,
} from '../src/sim/city';
import { createEconomySystem } from '../src/sim/economy';
import { registerUnitCommands, spawnUnit } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import {
  addAIPlayer,
  createAISystem,
  isEmptyWingCarrier,
} from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
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

function makeDriver(terrain: TerrainData, queue: CommandQueue): TickDriver {
  return createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
      createAISystem(queue),
    ],
  });
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

function findWaterNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 120; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > MAP_HALF_SIZE - 1 || Math.abs(cz) > MAP_HALF_SIZE - 1) continue;
        if (isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no water near ${x},${z}`);
}

/**
 * Script air/naval content for `owner`: a completed physical airfield
 * (real hangar slots — 6 generic), a carrier with an empty wing on
 * nearby water, two carrier-capable navalFighters parked next to it
 * (in embark range so thinkCarrierWings can actually embark them), a
 * frigate + submarine screen, and a civil-airport-less start (the
 * marshal builds its own via the construction priority).
 * Direct state scripting — the soak exercises the AI + sim layers,
 * not command validation (covered in sim.ai-airnaval.test.ts).
 */
function scriptAirNaval(world: World, terrain: TerrainData, owner: number, gx: number, gz: number): void {
  const land = findLandNear(terrain, gx, gz);
  const airfield: Placement = { kind: 'airfield', owner, cx: land.x, cz: land.z, facing: 0 };
  const b = placeBuilding(world.city, airfield);
  b.progress = 1;
  // Naval group on the nearest water.
  const sea = findWaterNear(terrain, gx, gz);
  const carrier = spawnUnit(world, 'carrier', owner, sea.x, sea.z);
  // Two carrier-capable aircraft next to the carrier (in embark range).
  spawnUnit(world, 'navalFighter', owner, sea.x + 3, sea.z);
  spawnUnit(world, 'navalFighter', owner, sea.x - 3, sea.z);
  // Escort screen: frigate + submarine + missile boat.
  spawnUnit(world, 'frigate', owner, sea.x + 8, sea.z + 4);
  spawnUnit(world, 'submarine', owner, sea.x - 8, sea.z - 4);
  spawnUnit(world, 'missileBoat', owner, sea.x + 4, sea.z - 8);
  // A couple of land aircraft at the airfield for the hangar paths.
  spawnUnit(world, 'fighter', owner, land.x + 6, land.z);
  spawnUnit(world, 'attackHeli', owner, land.x - 6, land.z);
  void carrier;
}

/** Marshal (west) vs general (east) with scripted air/naval content. */
function setupAirNavalSoak(seed: number): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const baseW = findLandNear(terrain, -110, 0);
  const baseE = findLandNear(terrain, 110, 0);
  addAIPlayer(world, 0, 'marshal', baseW.x, baseW.z);
  addAIPlayer(world, 1, 'general', baseE.x, baseE.z);
  scriptAirNaval(world, terrain, 0, -90, 40);
  scriptAirNaval(world, terrain, 1, 90, -40);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  const driver = makeDriver(terrain, queue);
  return { terrain, world, queue, driver };
}

const RESOURCES: ResourceKey[] = [
  'funds',
  'materials',
  'fuel',
  'food',
  'research',
  'goods',
  'influence',
  'manpower',
];

/** 2 game-minutes of AI-vs-AI. */
const SOAK_TICKS = 3600;

/**
 * Soak timeout: the shared tree is mid-flight (parallel workstreams
 * landing per-tick changes — tick cost drifted ~2x in 10 minutes on
 * 2026-09-30). The gate here is correctness/determinism, not speed;
 * perf budgets are pinned separately in perf.budgets.test.ts.
 */
const SOAK_TEST_TIMEOUT = 120000;

describe('air/naval AI-vs-AI soak (marshal vs general, economy on)', () => {
  it('runs 3600 ticks with scripted air/naval content: no crashes, sane economies', () => {
    const ctx = setupAirNavalSoak(20260930);
    expect(() => {
      for (let i = 0; i < SOAK_TICKS; i++) ctx.driver.step(ctx.world, TICK_MS);
    }).not.toThrow();
    for (const p of ctx.world.city.players) {
      for (const r of RESOURCES) {
        const v = p[r];
        expect(Number.isFinite(v), `${r} finite for player ${p.id}`).toBe(true);
        expect(v, `${r} non-negative for player ${p.id}`).toBeGreaterThanOrEqual(0);
        expect(v, `${r} bounded for player ${p.id}`).toBeLessThan(1e12);
      }
    }
    // Both AIs actually played: units on the field (scripted + trained).
    const units0 = ctx.world.units.filter((u) => u.owner === 0 && u.hp > 0).length;
    const units1 = ctx.world.units.filter((u) => u.owner === 1 && u.hp > 0).length;
    expect(units0).toBeGreaterThan(0);
    expect(units1).toBeGreaterThan(0);
  }, SOAK_TEST_TIMEOUT);

  it('carriers with unfilled wings never sail into combat', () => {
    const ctx = setupAirNavalSoak(20260930);
    for (let i = 0; i < SOAK_TICKS; i++) {
      ctx.driver.step(ctx.world, TICK_MS);
      // Spot-check every 10 game-seconds: no chasing carrier may have
      // an empty wing (the attack loops skip them).
      if (ctx.world.tick % 300 !== 0) continue;
      for (const u of ctx.world.units) {
        if (u.kind !== 'carrier' || u.hp <= 0 || !u.chasing) continue;
        expect(
          isEmptyWingCarrier(ctx.world, u),
          `carrier ${u.id} chasing with an empty wing at tick ${ctx.world.tick}`,
        ).toBe(false);
      }
    }
  }, SOAK_TEST_TIMEOUT);

  it('hangar slots survive the match on scripted airfields', () => {
    const ctx = setupAirNavalSoak(20260930);
    for (let i = 0; i < SOAK_TICKS; i++) ctx.driver.step(ctx.world, TICK_MS);
    const airfields = ctx.world.city.buildings.filter((b) => b.kind === 'airfield');
    expect(airfields.length).toBe(2);
    for (const a of airfields) {
      // placeBuilding initialized 6 generic slots; the sim never
      // removes the building's hangar array (parking only flips
      // occupant ids).
      expect(a.hangars).toHaveLength(6);
      for (const s of a.hangars!) {
        expect(s.cls).toBe('generic');
        expect(typeof s.occupant).toBe('number');
      }
    }
  }, SOAK_TEST_TIMEOUT);

  it('same seed ⇒ identical digest after the full soak', () => {
    const a = setupAirNavalSoak(424242);
    const b = setupAirNavalSoak(424242);
    for (let i = 0; i < SOAK_TICKS; i++) {
      a.driver.step(a.world, TICK_MS);
      b.driver.step(b.world, TICK_MS);
    }
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
  }, SOAK_TEST_TIMEOUT);

  it('save/load mid-soak preserves the match (hangar + embark state included)', () => {
    const a = setupAirNavalSoak(777);
    for (let i = 0; i < SOAK_TICKS / 2; i++) a.driver.step(a.world, TICK_MS);
    const snap = takeSnapshot(a.world);
    const bWorld = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    const bQueue = createCommandQueue();
    registerCoreCommands(bQueue);
    registerUnitCommands(bQueue, a.terrain);
    registerMovementCommands(bQueue, a.terrain);
    registerCombatCommands(bQueue);
    const bDriver = makeDriver(a.terrain, bQueue);
    // The restored airfields carry their hangar slots through the
    // snapshot (v8). Final-review R2-B: siege doctrine may destroy
    // an airfield during the soak — assert at least one survives with
    // hangars intact, rather than an exact count.
    const airfields = bWorld.city.buildings.filter((x) => x.kind === 'airfield');
    expect(airfields.length).toBeGreaterThanOrEqual(1);
    for (const f of airfields) expect(f.hangars).toHaveLength(6);
    for (let i = 0; i < SOAK_TICKS / 2; i++) {
      a.driver.step(a.world, TICK_MS);
      bDriver.step(bWorld, TICK_MS);
    }
    expect(digestWorld(bWorld)).toBe(digestWorld(a.world));
  }, SOAK_TEST_TIMEOUT);
});
