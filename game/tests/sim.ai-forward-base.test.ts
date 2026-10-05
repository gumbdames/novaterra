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
 * NOVATERRA — C1: AI physical forward base (2026-10-02).
 *
 * The military AI owns REAL forward-base buildings once it has
 * established its forward-base coordinates:
 *  - commander: fuelDepot
 *  - general: fuelDepot + ordnanceDepot
 *  - marshal: fuelDepot + ordnanceDepot + radarStation
 *  - cadet/citizen: none
 *
 * Pinned here:
 *  - the difficulty roster (FORWARD_DEPOT_ROSTER);
 *  - thinkForwardDepots issues real placeBuilding orders at a
 *    deterministic site near the forward base (through the command
 *    queue — validated at enqueue AND apply);
 *  - the virtual-stock anchor: stocks accrue only while the matching
 *    depot is live/complete/operational; destroying the depot zeroes
 *    the reserve (thinkForwardDepots) and creditVirtualDepotStocks
 *    yields nothing without a live depot;
 *  - rebuilds wait the 2700-tick cooldown AND the 4-unit army floor;
 *  - cadet/citizen never build;
 *  - forwardDepots is digest-covered (sensitivity) and survives a
 *    snapshot round-trip (pre-C1 snapshots decode to []).
 */

import { describe, expect, it } from 'vitest';
import {
  createCommandQueue,
  registerCoreCommands,
  type CommandQueue,
} from '../src/sim/commands';
import { MAP_HALF_SIZE, destroyBuilding, getPlayer, registerCityCommands } from '../src/sim/city';
import { createWorld, type World } from '../src/sim/world';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { registerUnitCommands, spawnUnit } from '../src/sim/units';
import {
  createMovementSystem,
  createPathfindingSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { createEconomySystem } from '../src/sim/economy';
import {
  addAIPlayer,
  createAISystem,
  creditVirtualDepotStocks,
  decodeAIState,
  encodeAIState,
  findLiveForwardDepot,
  FORWARD_DEPOT_MIN_ARMY,
  FORWARD_DEPOT_REBUILD_COOLDOWN_TICKS,
  FORWARD_DEPOT_ROSTER,
  thinkForwardDepots,
  type AIDifficulty,
  type AIPlayerState,
  type ForwardDepotKind,
} from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { getAgeState, registerAgeCommands, type Age } from '../src/sim/ages';
import {
  generateTerrain,
  isWater,
  MERIDIAN_PLAINS,
  type TerrainData,
} from '../src/sim/terrain';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';

const SEED = 20261002;

function setupForwardBase(
  difficulty: AIDifficulty,
  opts: { army?: number; funds?: number; age?: Age } = {},
): {
  world: World;
  ai: AIPlayerState;
  terrain: TerrainData;
  queue: CommandQueue;
  driver: TickDriver;
} {
  const world = createWorld(SEED);
  grantAllTrainingResources(world);
  addAIPlayer(world, 0, difficulty, 0, 0);
  const ai = world.ai.players[0]!;
  if (opts.age !== undefined) {
    getAgeState(world, 0).age = opts.age;
  }
  // The terrain's guaranteed-land spawn disc anchors the forward base —
  // the deterministic siting scan then has legal ground to work with.
  const terrain = generateTerrain(SEED);
  const spawn = terrain.spawns[0] ?? { x: 0, z: 0 };
  ai.forwardBase = { x: spawn.x, z: spawn.z };
  const queue = createCommandQueue();
  registerCityCommands(queue, terrain);
  const army = opts.army ?? FORWARD_DEPOT_MIN_ARMY;
  // 2026-10-05 (Fix 4): park the army 30 cells east of the anchor —
  // well outside the 10-cell depot site search. The gate under test is
  // the army COUNT, not its position, and buildings can no longer land
  // on units, so the army must not stand on the depot site.
  for (let i = 0; i < army; i++) {
    spawnUnit(world, 'rifles', 0, spawn.x + 60 + i * 2, spawn.z);
  }
  if (opts.funds !== undefined) {
    getPlayer(world.city, 0)!.funds = opts.funds;
  }
  const driver = createTickDriver({ queue, systems: [] });
  return { world, ai, terrain, queue, driver };
}

/** Step the driver so queued placeBuilding orders apply. */
function step(driver: TickDriver, world: World, n: number): void {
  for (let i = 0; i < n; i++) driver.step(world, TICK_MS);
}

/** AI-owned buildings of a kind (any progress). */
function aiBuildings(world: World, kind: ForwardDepotKind): number {
  return world.city.buildings.filter((b) => b.owner === 0 && b.kind === kind).length;
}

describe('FORWARD_DEPOT_ROSTER — difficulty roster', () => {
  it('commander builds a fuelDepot; general adds ordnanceDepot; marshal adds radarStation', () => {
    expect(FORWARD_DEPOT_ROSTER.commander).toEqual(['fuelDepot']);
    expect(FORWARD_DEPOT_ROSTER.general).toEqual(['fuelDepot', 'ordnanceDepot']);
    expect(FORWARD_DEPOT_ROSTER.marshal).toEqual([
      'fuelDepot',
      'ordnanceDepot',
      'radarStation',
    ]);
  });

  it('cadet and citizen build nothing — their roster is empty', () => {
    expect(FORWARD_DEPOT_ROSTER.cadet).toEqual([]);
    expect(FORWARD_DEPOT_ROSTER.citizen).toEqual([]);
  });
});

describe('thinkForwardDepots — placement', () => {
  it('a commander with a forward base, army and funds orders its fuelDepot', () => {
    const { world, ai, terrain, queue, driver } = setupForwardBase('commander');
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(1);
    step(driver, world, 2); // apply at the next tick start
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
    // The tracker adopted the placed building.
    expect(ai.forwardDepots).toHaveLength(1);
    expect(ai.forwardDepots![0]!.kind).toBe('fuelDepot');
  });

  it('a general orders fuelDepot then ordnanceDepot (roster priority order)', () => {
    // ordnanceDepot is industry-gated.
    const { world, ai, terrain, queue, driver } = setupForwardBase('general', {
      age: 'industry',
    });
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(2);
    step(driver, world, 2);
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
    expect(aiBuildings(world, 'ordnanceDepot')).toBe(1);
    expect(ai.forwardDepots!.map((e) => e.kind)).toEqual([
      'fuelDepot',
      'ordnanceDepot',
    ]);
  });

  it('a marshal orders all three roster buildings', () => {
    // ordnanceDepot is industry-gated, radarStation connectivity-gated.
    const { world, ai, terrain, queue, driver } = setupForwardBase('marshal', {
      age: 'industry',
    });
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(3);
    step(driver, world, 2);
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
    expect(aiBuildings(world, 'ordnanceDepot')).toBe(1);
    expect(aiBuildings(world, 'radarStation')).toBe(1);
  });

  it('cadet and citizen order nothing', () => {
    for (const difficulty of ['cadet', 'citizen'] as const) {
      const { world, ai, terrain, queue } = setupForwardBase(difficulty);
      thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
      expect(queue.pendingCount()).toBe(0);
    }
  });

  it('no forward base, no orders', () => {
    const { world, ai, terrain, queue } = setupForwardBase('marshal');
    ai.forwardBase = null;
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(0);
  });

  it('below the army floor, no orders — the base cannot be defended', () => {
    const { world, ai, terrain, queue } = setupForwardBase('commander', {
      army: FORWARD_DEPOT_MIN_ARMY - 1,
    });
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY - 1);
    expect(queue.pendingCount()).toBe(0);
  });

  it('without funds, no orders — affordability is ledger-guarded', () => {
    const { world, ai, terrain, queue } = setupForwardBase('commander', {
      funds: 1,
    });
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(0);
  });

  it('the age gate holds: a foundation-age general orders only the fuelDepot', () => {
    // ordnanceDepot needs industry — at foundation only the fuelDepot
    // (foundation-gated) is ordered.
    const { world, ai, terrain, queue, driver } = setupForwardBase('general');
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(1);
    step(driver, world, 2);
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
    expect(aiBuildings(world, 'ordnanceDepot')).toBe(0);
  });

  it('a standing depot is not re-ordered — one per kind', () => {
    const { world, ai, terrain, queue, driver } = setupForwardBase('commander');
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    step(driver, world, 2);
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
    // Next think: the live building is adopted, nothing new is ordered.
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(0);
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
  });

  it('adopts a pre-existing AI depot of the roster kind into the tracker', () => {
    const { world, ai, terrain, queue } = setupForwardBase('commander');
    completeBuilding(world, 'fuelDepot', 0, 30, 30);
    const placed = world.city.buildings[world.city.buildings.length - 1]!;
    placed.hp = 600;
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    // Adopted, not re-ordered.
    expect(queue.pendingCount()).toBe(0);
    expect(ai.forwardDepots).toHaveLength(1);
    expect(ai.forwardDepots![0]!.buildingId).toBe(placed.id);
  });
});

describe('thinkForwardDepots — destruction zeroes the reserve', () => {
  it('destroying the depot zeroes the matching virtual stock and stamps the cooldown', () => {
    const { world, ai, terrain, queue, driver } = setupForwardBase('marshal');
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    step(driver, world, 2);
    const depot = world.city.buildings.find(
      (b) => b.owner === 0 && b.kind === 'fuelDepot',
    )!;
    // Accrue some stock first (the depot is under construction, so
    // complete it for the anchor).
    depot.progress = 1;
    depot.operational = true;
    // The tracker adopts the placed building on the next think.
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    ai.virtualFuelStock = 123.5;
    ai.virtualAmmoStock = 77.0;
    // Destroy the fuel depot through the single destruction path.
    destroyBuilding(world, depot);
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    const entry = ai.forwardDepots!.find((e) => e.kind === 'fuelDepot')!;
    expect(entry.buildingId).toBe(0);
    expect(entry.destroyedTick).toBe(world.tick);
    // The fuel reserve is zeroed; the ammo reserve (ordnanceDepot lives)
    // is untouched.
    expect(ai.virtualFuelStock).toBe(0);
    expect(ai.virtualAmmoStock).toBe(77.0);
  });

  it('destroying the ordnanceDepot zeroes the ammo stock', () => {
    const { world, ai, terrain, queue, driver } = setupForwardBase('general', {
      age: 'industry',
    });
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    step(driver, world, 2);
    const depot = world.city.buildings.find(
      (b) => b.owner === 0 && b.kind === 'ordnanceDepot',
    )!;
    // The tracker adopts the placed building on the next think.
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    ai.virtualAmmoStock = 50;
    destroyBuilding(world, depot);
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(ai.virtualAmmoStock).toBe(0);
  });
});

describe('thinkForwardDepots — rebuild cooldown', () => {
  it('no rebuild inside the cooldown window', () => {
    const { world, ai, terrain, queue, driver } = setupForwardBase('commander');
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    step(driver, world, 2);
    const depot = world.city.buildings.find(
      (b) => b.owner === 0 && b.kind === 'fuelDepot',
    )!;
    // The tracker adopts the placed building on the next think.
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    destroyBuilding(world, depot);
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    const destroyedTick = world.tick;
    // One tick before the cooldown elapses: still nothing.
    world.tick = destroyedTick + FORWARD_DEPOT_REBUILD_COOLDOWN_TICKS - 1;
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(0);
  });

  it('rebuilds once the cooldown has elapsed', () => {
    const { world, ai, terrain, queue, driver } = setupForwardBase('commander');
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    step(driver, world, 2);
    const depot = world.city.buildings.find(
      (b) => b.owner === 0 && b.kind === 'fuelDepot',
    )!;
    // The tracker adopts the placed building on the next think.
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    destroyBuilding(world, depot);
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    const destroyedTick = world.tick;
    world.tick = destroyedTick + FORWARD_DEPOT_REBUILD_COOLDOWN_TICKS;
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    expect(queue.pendingCount()).toBe(1);
    step(driver, world, 2);
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
  });
});

describe('findLiveForwardDepot — the anchor predicate', () => {
  function setupLive(kind: ForwardDepotKind): {
    world: World;
    ai: AIPlayerState;
  } {
    const world = createWorld(SEED);
    grantAllTrainingResources(world);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    completeBuilding(world, kind, 0, 30, 30);
    const b = world.city.buildings[world.city.buildings.length - 1]!;
    b.hp = 600;
    return { world, ai };
  }

  it('a complete, operational, standing depot is live', () => {
    const { world } = setupLive('fuelDepot');
    expect(findLiveForwardDepot(world, 0, 'fuelDepot')).toBeDefined();
  });

  it('an incomplete depot is not live', () => {
    const { world } = setupLive('fuelDepot');
    world.city.buildings[0]!.progress = 0.5;
    expect(findLiveForwardDepot(world, 0, 'fuelDepot')).toBeUndefined();
  });

  it('a non-operational depot is not live', () => {
    const { world } = setupLive('fuelDepot');
    world.city.buildings[0]!.operational = false;
    expect(findLiveForwardDepot(world, 0, 'fuelDepot')).toBeUndefined();
  });

  it('a destroyed (0 hp) depot is not live', () => {
    const { world } = setupLive('fuelDepot');
    world.city.buildings[0]!.hp = 0;
    expect(findLiveForwardDepot(world, 0, 'fuelDepot')).toBeUndefined();
  });

  it('another owner\'s depot is not the AI\'s', () => {
    const { world } = setupLive('fuelDepot');
    expect(findLiveForwardDepot(world, 1, 'fuelDepot')).toBeUndefined();
  });
});

describe('creditVirtualDepotStocks — the physical anchor', () => {
  it('a non-live depot yields nothing even with a virtual stock present', () => {
    const world = createWorld(SEED);
    grantAllTrainingResources(world);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    // Depot exists but is still under construction.
    completeBuilding(world, 'ordnanceDepot', 0, 30, 30);
    const b = world.city.buildings[world.city.buildings.length - 1]!;
    b.hp = 600;
    b.progress = 0.5;
    ai.virtualAmmoStock = 10;
    creditVirtualDepotStocks(world, ai);
    expect(ai.virtualAmmoStock).toBe(10); // unchanged — no accrual
  });
});

describe('forwardDepots — digest coverage', () => {
  it('the digest changes when the forward-depot tracker changes', () => {
    const world = createWorld(SEED);
    grantAllTrainingResources(world);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    const before = digestWorld(world);
    ai.forwardDepots = [{ kind: 'fuelDepot', buildingId: 42, destroyedTick: -1 }];
    const after = digestWorld(world);
    expect(after).not.toBe(before);
  });

  it('the digest is stable when nothing changes', () => {
    const world = createWorld(SEED);
    grantAllTrainingResources(world);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    ai.forwardDepots = [{ kind: 'fuelDepot', buildingId: 42, destroyedTick: -1 }];
    expect(digestWorld(world)).toBe(digestWorld(world));
  });
});

describe('forwardDepots — snapshot round-trip', () => {
  it('encode → decode preserves the tracker', () => {
    const world = createWorld(SEED);
    grantAllTrainingResources(world);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    ai.forwardDepots = [
      { kind: 'fuelDepot', buildingId: 7, destroyedTick: -1 },
      { kind: 'ordnanceDepot', buildingId: 0, destroyedTick: 1234 },
    ];
    const decoded = decodeAIState(encodeAIState(world.ai));
    const restored = decoded.players[0]!;
    expect(restored.forwardDepots).toEqual([
      { kind: 'fuelDepot', buildingId: 7, destroyedTick: -1 },
      { kind: 'ordnanceDepot', buildingId: 0, destroyedTick: 1234 },
    ]);
  });

  it('a pre-C1 snapshot without the field decodes to [] (AD9)', () => {
    const world = createWorld(SEED);
    grantAllTrainingResources(world);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const encoded = encodeAIState(world.ai) as {
      players: Array<Record<string, unknown>>;
    };
    delete encoded.players[0]!['forwardDepots'];
    const decoded = decodeAIState(encoded);
    expect(decoded.players[0]!.forwardDepots).toEqual([]);
  });
});

describe('thinkLogistics — the forward base is wired into the think', () => {
  it('a full marshal think establishes the physical base through the queue', () => {
    const terrain = generateTerrain(SEED);
    const world = createWorld(SEED);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCityCommands(queue, terrain);
    // registerUnitCommands + the AI system need terrain for move orders;
    // the logistics path only needs the queue + terrain.
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    // The roster's age gates: industry covers ordnanceDepot + radarStation.
    getAgeState(world, 0).age = 'industry';
    const spawn = terrain.spawns[0] ?? { x: 0, z: 0 };
    ai.forwardBase = { x: spawn.x, z: spawn.z };
    // 2026-10-05 (Fix 4): park the army 30 cells east of the anchor —
    // the gate under test is the army COUNT, and buildings can no
    // longer land on units.
    for (let i = 0; i < FORWARD_DEPOT_MIN_ARMY; i++) {
      spawnUnit(world, 'rifles', 0, spawn.x + 60 + i * 2, spawn.z);
    }
    // Drive the AI system until the marshal's first think fires
    // (cadence 30) and the placeBuilding orders apply.
    const driver = createTickDriver({
      queue,
      systems: [createAISystem(queue, terrain)],
    });
    for (let i = 0; i < 40; i++) driver.step(world, TICK_MS);
    expect(aiBuildings(world, 'fuelDepot')).toBe(1);
    expect(aiBuildings(world, 'ordnanceDepot')).toBe(1);
    expect(aiBuildings(world, 'radarStation')).toBe(1);
  });
});

/**
 * Phase 9 regression (2026-10-02): the AI's seen-building latch
 * (`ai.seenBuildingIds`, the A2 intel latch) is mutated in place by
 * getKnownEnemyBuildings. encodeAIState used to capture it BY REFERENCE,
 * so a snapshot taken mid-game silently absorbed post-snapshot
 * sightings and the restored world digested differently. Latent while
 * the AI owned no physical buildings (the latch stayed empty); C1's
 * physical forward depots made the enemy AI actually see and latch
 * buildings, exposing it. Both encode and decode now copy the latch.
 */
describe('snapshot/restore — the seen-building latch is never aliased', () => {
  it('encode copies the latch: post-snapshot sightings do not leak into the snapshot', () => {
    const world = createWorld(SEED);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    ai.seenBuildingIds = [7, 9];
    const snap = takeSnapshot(world);
    ai.seenBuildingIds.push(11); // a post-snapshot sighting
    const restored = restoreSnapshot(snap);
    expect(restored.ai.players[0]!.seenBuildingIds).toEqual([7, 9]);
  });

  it('decode copies the latch: a restored world never mutates the snapshot', () => {
    const world = createWorld(SEED);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    world.ai.players[0]!.seenBuildingIds = [7, 9];
    const snap = takeSnapshot(world);
    const restored = restoreSnapshot(snap);
    restored.ai.players[0]!.seenBuildingIds.push(11);
    const restoredAgain = restoreSnapshot(snap);
    expect(restoredAgain.ai.players[0]!.seenBuildingIds).toEqual([7, 9]);
  });

  it('save/load preserves the digest across real latch growth (phase9 soak shape)', () => {
    // Two marshals on close land bases, full production stack — the
    // reduced-scale shape of the phase9 determinism soak. The AIs build
    // physical forward depots (C1) and latch sightings of each other's
    // buildings; the latch MUST grow after the snapshot (otherwise this
    // test would pass vacuously) and the restored world must still
    // digest identically.
    const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
    const landNear = (x: number, z: number): { x: number; z: number } => {
      for (let r = 0; r < 120; r += 2) {
        for (let dz = -r; dz <= r; dz += 2) {
          for (let dx = -r; dx <= r; dx += 2) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const cx = x + dx;
            const cz = z + dz;
            if (Math.abs(cx) > MAP_HALF_SIZE - 1 || Math.abs(cz) > MAP_HALF_SIZE - 1) continue;
            if (!isWater(terrain, cx, cz)) return { x: cx, z: cz };
          }
        }
      }
      throw new Error('no land near base');
    };
    const world = createWorld(90210);
    const west = landNear(-180, 80);
    const east = landNear(-80, 80);
    addAIPlayer(world, 0, 'marshal', west.x, west.z);
    addAIPlayer(world, 1, 'marshal', east.x, east.z);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    registerUnitCommands(queue, terrain);
    registerMovementCommands(queue, terrain);
    registerCombatCommands(queue);
    registerAgeCommands(queue);
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
    grantAllTrainingResources(world);
    step(driver, world, 3000);
    const midDigest = digestWorld(world);
    const midLatchLen = world.ai.players[0]!.seenBuildingIds.length;
    const mid = takeSnapshot(world);
    step(driver, world, 3000);
    // The exposure condition: the latch really did grow after the
    // snapshot, so this test exercises the old aliasing bug.
    expect(world.ai.players[0]!.seenBuildingIds.length).toBeGreaterThan(midLatchLen);
    const restored = restoreSnapshot(mid);
    expect(digestWorld(restored)).toBe(midDigest);
  }, 120000);
});
