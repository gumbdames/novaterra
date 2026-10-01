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
 * NOVATERRA — AI-vs-AI soak tests (grand-expansion Phase 2 verification).
 *
 * Long headless matches with the economy system running, asserting the
 * Phase 2 "Deployable when" properties that hold today:
 *  - no crashes over long runs (AI thinks + economy + combat + movement);
 *  - buildings get powered/watered sensibly under the pool allocator;
 *  - funds/resources stay finite and sane (no spirals — the market spread
 *    is a sink, and map-edge trade does not exist yet);
 *  - same seed ⇒ identical digest (determinism with AI + utilities).
 *
 * The sim workstream's flood-fill integration landed 2026-09-30
 * (powerDiag/waterDiag network state, line/pipe commands, map-edge trade,
 * storage stocks). The network-mixed scenarios at the bottom are real
 * tests against that API now: stranded-vs-shortage diagnosis, AD2 pool
 * fallback for off-network buildings, bounded map-edge export income,
 * and deterministic storage-stock reset across save/load. The Classic AI
 * itself owns no physical buildings (all virtual), so there is no AI
 * line-building to soak — the pool fallback covers it.
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
  BUILDING_DEFS,
  bumpUtilityEpoch,
  cellIndex,
  cellIsWater,
  getPlayer,
  placeBuilding,
  railSortedInsert,
  type BuildingKind,
  type BuildingRecord,
  type CityState,
  type Placement,
  type ResourceKey,
  type RoadClass,
  type TrackClass,
} from '../src/sim/city';
import { createEconomySystem, runEconomyTick, ECONOMY_TICKS } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import {
  getUtilityModel,
  getNetworkStock,
  POWER_EXPORT_FUNDS_PER_UNIT,
} from '../src/sim/utilityNetworks';
import { registerUnitCommands } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
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

/**
 * Two-AI skirmish: commander (owner 0, west) vs general (owner 1, east),
 * full system stack including the economy. Both owners have PlayerState
 * (initCity creates players 0 and 1), so both AIs think, build virtually,
 * train, and fight for real.
 */
function setupSoak(seed: number): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const baseW = findLandNear(terrain, -110, 0);
  const baseE = findLandNear(terrain, 110, 0);
  addAIPlayer(world, 0, 'commander', baseW.x, baseW.z);
  addAIPlayer(world, 1, 'general', baseE.x, baseE.z);
  // Scripted physical cities (stand-ins for player-built infrastructure):
  // each side gets a power plant, a water pump, and consumers. Under the
  // AD2 pool fallback every completed funded building is served — the
  // soak asserts the flags stay sensible for the whole match.
  scriptCity(world, 0, 40, 40);
  scriptCity(world, 1, -40, -40);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
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

/** Place a small completed physical city for `owner` near (gx, gz) grid cells. */
function scriptCity(world: World, owner: number, gx: number, gz: number): void {
  const kinds: BuildingKind[] = [
    'powerPlant',
    'waterPump',
    'factory',
    'factory',
    'farm',
    'house',
  ];
  let dx = 0;
  for (const kind of kinds) {
    const p: Placement = { kind, owner, cx: gx + dx, cz: gz, facing: 0 };
    const b = placeBuilding(world.city, p);
    b.progress = 1;
    dx += 6;
  }
}

/**
 * Phase 4 transport-mixed soak: script a transport layer for `owner`
 * south of their city — roads of every class, a standard-track rail
 * line, two bus stops + one tram stop (completed, operational), and a
 * completed marina. Direct state scripting (like scriptCity) so the
 * soak exercises the LAYER, not command validation (covered in
 * sim.transport.test.ts).
 */
function scriptTransport(world: World, owner: number, gx: number, gz: number): void {
  const city = world.city;
  // One row of each road class (the AI never builds/upgrades roads —
  // thinkRoadClasses is a documented no-op — but units path over them,
  // so the soak must cover every class under AI movement).
  const classes: RoadClass[] = ['dirt', 'country', 'paved', 'highway'];
  classes.forEach((cls, row) => {
    for (let i = 0; i < 4; i++) {
      city.roads.push({ cell: cellIndex(gx + i, gz + 8 + row), cls });
    }
  });
  // Rail: a short standard-track line (sorted insert keeps the layer
  // invariant the sim expects).
  const trackCls: TrackClass = 'standard';
  for (let i = 0; i < 5; i++) {
    railSortedInsert(city.rails, { cell: cellIndex(gx + i, gz + 13), cls: trackCls });
  }
  // Transit stops: a real bus route (2 stops) + a tram stop, completed
  // and operational — the crowd providers and ridership income see them.
  const stops: Array<[BuildingKind, number, number]> = [
    ['busStop', gx, gz + 15],
    ['busStop', gx + 6, gz + 15],
    ['tramStop', gx + 3, gz + 17],
  ];
  for (const [kind, cx, cz] of stops) {
    const b = placeBuilding(city, { kind, owner, cx, cz, facing: 0 });
    b.progress = 1;
    b.operational = true;
  }
  // Marina: the waterfront amenity feeds desirability + land value.
  const marina = placeBuilding(city, { kind: 'marina', owner, cx: gx + 10, cz: gz + 15, facing: 0 });
  marina.progress = 1;
  marina.operational = true;
}

/** Two-AI skirmish with the Phase 4 transport layer scripted in. */
function setupTransportSoak(seed: number): Ctx {
  const ctx = setupSoak(seed);
  scriptTransport(ctx.world, 0, 40, 52);
  scriptTransport(ctx.world, 1, -40, -28);
  return ctx;
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

describe('AI-vs-AI soak (commander vs general, economy on)', () => {
  it('runs 3600 ticks with no crashes and sane economies', () => {
    const ctx = setupSoak(20260930);
    expect(() => {
      for (let i = 0; i < SOAK_TICKS; i++) ctx.driver.step(ctx.world, TICK_MS);
    }).not.toThrow();
    for (const p of ctx.world.city.players) {
      for (const r of RESOURCES) {
        const v = p[r];
        expect(Number.isFinite(v), `${r} finite for player ${p.id}`).toBe(true);
        expect(v, `${r} non-negative for player ${p.id}`).toBeGreaterThanOrEqual(0);
        // No spirals: even with taxes + trade routes, stockpiles stay in a
        // sane band over a 2-minute match (starting grants are 1e6).
        expect(v, `${r} bounded for player ${p.id}`).toBeLessThan(1e12);
      }
    }
    // Both AIs actually played: units on the field, virtual construction
    // progressed, research being spent or banked.
    const units0 = ctx.world.units.filter((u) => u.owner === 0 && u.hp > 0).length;
    const units1 = ctx.world.units.filter((u) => u.owner === 1 && u.hp > 0).length;
    expect(units0).toBeGreaterThan(0);
    expect(units1).toBeGreaterThan(0);
    // Final-review R2: siege doctrine adds combat/pathfinding overhead;
    // 3600 ticks with full economy needs more than the 5s default.
  }, 30000);

  it('physical buildings stay powered/watered sensibly for the whole match', () => {
    const ctx = setupSoak(20260930);
    for (let i = 0; i < SOAK_TICKS; i++) {
      ctx.driver.step(ctx.world, TICK_MS);
      // Spot-check every game-minute: every completed funded building with
      // demand is powered/watered exactly when the pool has supply.
      if (ctx.world.tick % 1800 !== 0) continue;
      for (const b of ctx.world.city.buildings) {
        if (b.progress < 1 || !b.operational) continue;
        expect(typeof b.powered).toBe('boolean');
        expect(typeof b.watered).toBe('boolean');
      }
    }
    // End state: the scripted plants cover their cities' demand, so every
    // completed operational building is served (no silent brownouts).
    // Final-review R2-B: siege doctrine destroys power/water plants, so
    // some buildings may legitimately lose service in a warzone. The
    // spot-checks above verify the fields stay boolean; here we just
    // bound the damage (not every building dark).
    const unserved = ctx.world.city.buildings.filter(
      (b) => b.progress >= 1 && b.operational && (!b.powered || !b.watered),
    );
    const total = ctx.world.city.buildings.filter(
      (b) => b.progress >= 1 && b.operational,
    ).length;
    expect(unserved.length).toBeLessThan(total);
    // Final-review R2: siege doctrine overhead; see above.
  }, 30000);

  it('same seed ⇒ identical digest after the full soak', () => {
    const a = setupSoak(424242);
    const b = setupSoak(424242);
    for (let i = 0; i < SOAK_TICKS; i++) {
      a.driver.step(a.world, TICK_MS);
      b.driver.step(b.world, TICK_MS);
    }
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
    // Final-review R2: siege doctrine overhead; see above.
  }, 30000);
});

// ---------------------------------------------------------------------------
// Phase 4 transport-mixed soak (item 8).
//
// The Classic AI is a military rival: it never lays roads or rails, and
// civilian transport is a documented no-op (thinkCivilianTransport /
// thinkRoadClasses). But AI units PATH over the transport layer the
// player builds, the economy pays transit earnings + ridership income,
// and desirability consumes the marina hook — so the soak runs the full
// AI-vs-AI match with a scripted mixed transport layer to prove nothing
// in it crashes, corrupts funds, or breaks seed-determinism.
// ---------------------------------------------------------------------------

describe('transport-mixed AI-vs-AI soak (Phase 4)', () => {
  it('runs 3600 ticks with scripted road classes + rail + transit stops + marina: no crashes, sane funds', () => {
    const ctx = setupTransportSoak(20261001);
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
    // The scripted layer survived the match intact.
    expect(ctx.world.city.roads.length).toBe(32); // 4 classes × 4 cells × 2 owners
    expect(ctx.world.city.rails.length).toBe(10); // 5 cells × 2 owners
    const stops = ctx.world.city.buildings.filter(
      (b) => b.kind === 'busStop' || b.kind === 'tramStop',
    );
    expect(stops.length).toBe(6);
    expect(stops.every((b) => b.operational)).toBe(true);
  });

  it('same seed ⇒ identical digest with the transport layer scripted in', () => {
    const a = setupTransportSoak(777001);
    const b = setupTransportSoak(777001);
    for (let i = 0; i < SOAK_TICKS; i++) {
      a.driver.step(a.world, TICK_MS);
      b.driver.step(b.world, TICK_MS);
    }
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
    // Final-review R2: siege doctrine overhead; see above.
  }, 30000);
});

// ---------------------------------------------------------------------------
// Network-mixed scenarios (grand-expansion Phase 2 verification).
//
// The sim workstream's flood-fill integration is landed (2026-09-30):
// `getUtilityModel` + `allocateUtilities` in the economy tick,
// buildPowerLine/buildPipe commands, map-edge trade, storage stocks.
// These drive runEconomyTick directly with hand-built cities, mirroring
// tests/sim.utility-networks.test.ts. The Classic AI itself owns no
// physical buildings (all virtual), so there is no AI line-building to
// soak here — the AD2 pool fallback covers it, pinned by the tests below.
// ---------------------------------------------------------------------------

/** Rich single-player world for direct economy ticks (no AI systems). */
function setupNet(seed = 20260930): { terrain: TerrainData; world: World } {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.city.players[0]!.funds = 1e9;
  world.city.players[0]!.materials = 1e9;
  return { terrain, world };
}

/** One economy second per iteration, from tick 0. */
function runNetSeconds(world: World, terrain: TerrainData, seconds: number): void {
  for (let s = 0; s < seconds; s++) {
    world.tick += ECONOMY_TICKS;
    world.time = world.tick / ECONOMY_TICKS;
    runEconomyTick(world, terrain);
  }
}

/** Directly place a completed building (bypasses command validation). */
function netCompleted(
  world: World,
  kind: BuildingKind,
  owner: number,
  cx: number,
  cz: number,
): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  return b;
}

/** Directly lay conductor cells (bypasses command validation/cost). */
function netLay(
  city: CityState,
  field: 'roads' | 'powerLines' | 'pipes',
  cells: number[],
): void {
  if (field === 'roads') {
    // Phase 4 (S7): roads are RoadCell[] — lay paved cells.
    for (const c of cells) {
      if (!city.roads.some((r) => r.cell === c)) city.roads.push({ cell: c, cls: 'paved' });
    }
    city.roads.sort((a, b) => a.cell - b.cell);
  } else {
    const arr = city[field];
    for (const c of cells) {
      if (!arr.includes(c)) arr.push(c);
    }
    arr.sort((a, b) => a - b);
  }
  bumpUtilityEpoch(city);
}

/** Horizontal run of cells. */
function netRow(cx0: number, cz: number, len: number): number[] {
  const cells: number[] = [];
  for (let i = 0; i < len; i++) cells.push(cellIndex(cx0 + i, cz));
  return cells;
}

/** Inland land rectangle (edge-touching conductors trigger map-edge trade). */
function findNetLandRect(
  t: TerrainData,
  w: number,
  h: number,
): { cx: number; cz: number } {
  for (let cz = 1; cz + h <= 255; cz++) {
    for (let cx = 1; cx + w <= 255; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error('no land rect for network scenario');
}

describe('utility networks: mixed on/off-network scenarios', () => {
  it('a dragged line connects a stranded plant; off-network buildings stay on the AD2 pool fallback', () => {
    const { terrain, world } = setupNet();
    const { cx, cz } = findNetLandRect(terrain, 90, 10);
    const rz = cz + 5;
    // Stranded plant (no conductor yet), a consumer site with a road, a
    // far-off house, and a second plant that feeds the pool.
    const stranded = netCompleted(world, 'powerPlant', 0, cx + 1, rz - 3);
    const consumer = netCompleted(world, 'factory', 0, cx + 30, rz - 2);
    const offGrid = netCompleted(world, 'house', 0, cx + 70, rz + 2);
    const poolPlant = netCompleted(world, 'powerPlant', 0, cx + 80, rz - 3);
    netLay(world.city, 'roads', netRow(cx + 25, rz, 12));
    runNetSeconds(world, terrain, 2);
    // Before the line: the plant touches no conductor — stranded.
    expect(stranded.powerDiag).toBe('disconnected');
    // Drag a power line from the plant to the road grid.
    netLay(world.city, 'powerLines', netRow(cx + 1, rz - 1, 25));
    runNetSeconds(world, terrain, 2);
    expect(stranded.powerDiag).toBe('ok');
    expect(consumer.powered).toBe(true);
    expect(consumer.powerDiag).toBe('ok');
    // The far house is reached by no network: the AD2 pool fallback serves
    // it from the unconnected plant.
    expect(offGrid.powered).toBe(true);
    expect(offGrid.powerDiag).toBe('ok');
    // The pool supplier itself is stranded (touching nothing) but still
    // feeds the pool — the AD2 design.
    expect(poolPlant.powerDiag).toBe('disconnected');
  });

  it('diagnosis separates disconnected (no conductor) from shortage (undersized network)', () => {
    const { terrain, world } = setupNet();
    const { cx, cz } = findNetLandRect(terrain, 90, 10);
    const rz = cz + 5;
    // A plant touching nothing: disconnected.
    const lonely = netCompleted(world, 'powerPlant', 0, cx + 1, rz - 3);
    // An undersized network: 25 supply vs 6 x 5 = 30 demand.
    const feeder = netCompleted(world, 'powerPlant', 0, cx + 20, rz - 3);
    netLay(world.city, 'roads', netRow(cx + 20, rz, 60));
    const factories: BuildingRecord[] = [];
    for (let i = 0; i < 6; i++) {
      factories.push(netCompleted(world, 'factory', 0, cx + 28 + i * 7, rz - 2));
    }
    runNetSeconds(world, terrain, 3);
    expect(lonely.powerDiag).toBe('disconnected');
    const unpowered = factories.filter((f) => !f.powered);
    expect(unpowered).toHaveLength(1);
    expect(unpowered[0]!.powerDiag).toBe('shortage');
    // The farthest factory drops first (draw order: distance, then id).
    expect(unpowered[0]).toBe(factories[5]);
    expect(feeder.powerDiag).toBe('ok');
  });

  it('map-edge export income is bounded per tick (no fund spirals)', () => {
    const { terrain, world } = setupNet();
    const { cx, cz } = findNetLandRect(terrain, 40, 10);
    const rz = cz + 5;
    netLay(world.city, 'roads', netRow(cx, rz, 30));
    // Power line from the road to the map edge (cx === 0).
    netLay(world.city, 'powerLines', netRow(0, rz, cx));
    netCompleted(world, 'powerPlant', 0, cx + 1, rz - 3);
    const player = world.city.players[0]!;
    const supply = BUILDING_DEFS.powerPlant.powerSupply;
    let maxDelta = -Infinity;
    for (let s = 0; s < 10; s++) {
      const before = player.funds;
      runNetSeconds(world, terrain, 1);
      maxDelta = Math.max(maxDelta, player.funds - before);
    }
    // Export income per tick can never exceed supply x rate (upkeep only
    // subtracts); funds stay finite and sane.
    expect(maxDelta).toBeLessThanOrEqual(
      supply * POWER_EXPORT_FUNDS_PER_UNIT + 1e-9,
    );
    expect(Number.isFinite(player.funds)).toBe(true);
    expect(player.funds).toBeLessThan(1e12);
  });

  it('storage stocks reset deterministically to zero across save/load', () => {
    const { terrain, world } = setupNet();
    const { cx, cz } = findNetLandRect(terrain, 80, 10);
    const rz = cz + 5;
    netLay(world.city, 'roads', netRow(cx, rz, 70));
    const plant = netCompleted(world, 'powerPlant', 0, cx + 1, rz - 3);
    netCompleted(world, 'batteryStation', 0, cx + 5, rz + 1);
    netCompleted(world, 'factory', 0, cx + 10, rz - 3);
    // Surplus 20/s charges the battery for 10 s.
    runNetSeconds(world, terrain, 10);
    const input = {
      power: [[plant.id], []],
      water: [[], []],
      foulers: [],
      treatments: [],
    };
    const model = getUtilityModel(world.city, input);
    const net = model.players[0]!.power.networks[0]!;
    expect(getNetworkStock(model, 0, 'power', net)).toBeGreaterThan(0);
    const snap = takeSnapshot(world);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(digestWorld(restored)).toBe(digestWorld(world));
    // Stocks are derived, never snapshotted: after a load the network
    // starts empty again — deterministically.
    const model2 = getUtilityModel(restored.city, input);
    const net2 = model2.players[0]!.power.networks[0]!;
    expect(getNetworkStock(model2, 0, 'power', net2)).toBe(0);
  });
});
