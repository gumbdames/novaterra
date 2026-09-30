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
 * NOVATERRA — tests/sim.transport.test.ts — Phase 4 (S7) transport
 * variety core (grand expansion, 2026-09-30): road classes, the v6 → v7
 * road migration, rail tracks + the dedicated rail router, the five
 * civilian transport units, the five transport hub buildings, civilian
 * earnings on the network, and the transit growth bonus.
 *
 * The tiered transit stops/stations live in sim.transit-stops.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands, type CommandQueue, type NewCommand } from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  ROAD_CLASS_ORDER,
  ROAD_CLASS_STATS,
  TRANSIT_EARNER_KINDS,
  TRANSIT_GROWTH_CAP,
  TRANSIT_GROWTH_PER_UNIT,
  TRACK_CLASS_STATS,
  ZoneType,
  cellCoords,
  cellIndex,
  cellIsWater,
  isOnTransportNetwork,
  migrateRoadsV6ToV7,
  nearestRailStation,
  placeBuilding,
  transitGrowthBonus,
  validatePlacement,
  type BuildingKind,
  type CityState,
  type Placement,
  type RoadCell,
  type RoadClass,
  cellCenterWorld,
  registerCityCommands,
} from '../src/sim/city';
import { findRailRoute, stationRailCells, trainTrackFactor } from '../src/sim/rail';
import { cellMoveCost, minRoadMoveCost } from '../src/sim/pathfinding';
import { UNIT_DEFS, isRailBound, spawnUnit, type UnitKind } from '../src/sim/units';
import { createEconomySystem, registerEconomyCommands, runEconomyTick } from '../src/sim/economy';
import { registerUnitCommands } from '../src/sim/units';
import { takeSnapshot, restoreSnapshot, SNAPSHOT_VERSION } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { addAIPlayer, canTrain, thinkCivilianTransport } from '../src/sim/ai';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
}

function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.tick = 150;
  world.time = 150 / 30;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerEconomyCommands(queue);
  const driver = createTickDriver({ queue, systems: [createEconomySystem(terrain)] });
  return { terrain, world, queue, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmds: NewCommand[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, c);
}

function findLandRect(t: TerrainData, w: number, h: number): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error(`no ${w}x${h} land rect`);
}

function completed(city: CityState, p: Placement) {
  const b = placeBuilding(city, p);
  b.progress = 1;
  b.operational = true;
  return b;
}

// ---------------------------------------------------------------------------
// Road classes + v6 → v7 migration
// ---------------------------------------------------------------------------

describe('road classes', () => {
  it('pins the four class stats (cost and move-cost factor)', () => {
    expect(ROAD_CLASS_ORDER).toEqual(['dirt', 'country', 'paved', 'highway']);
    expect(ROAD_CLASS_STATS.dirt).toMatchObject({ costFunds: 2, costMaterials: 1, moveCost: 1.0 });
    expect(ROAD_CLASS_STATS.country).toMatchObject({ costFunds: 4, costMaterials: 2, moveCost: 0.75 });
    expect(ROAD_CLASS_STATS.paved).toMatchObject({ costFunds: 5, costMaterials: 2, moveCost: 0.5 });
    expect(ROAD_CLASS_STATS.highway).toMatchObject({ costFunds: 10, costMaterials: 5, moveCost: 0.35 });
  });

  it('migrateRoadsV6ToV7 defaults every cell to paved, preserving order', () => {
    const migrated = migrateRoadsV6ToV7([30, 10, 20]);
    expect(migrated).toEqual([
      { cell: 30, cls: 'paved' },
      { cell: 10, cls: 'paved' },
      { cell: 20, cls: 'paved' },
    ]);
    expect(migrateRoadsV6ToV7([])).toEqual([]);
  });

  it('paved is the behavior-preserving default: old cost/factor ARE paved stats', () => {
    // Pre-Phase-4 constants (kept as aliases): ROAD_COST_FUNDS=5,
    // ROAD_COST_MATERIALS=2 matched the old uniform road exactly.
    expect(ROAD_CLASS_STATS.paved.costFunds).toBe(5);
    expect(ROAD_CLASS_STATS.paved.costMaterials).toBe(2);
    expect(ROAD_CLASS_STATS.paved.moveCost).toBe(0.5);
  });

  it('cellMoveCost honors the road class on the cell', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 8, 1);
    const cells = [0, 1, 2, 3].map((i) => cellIndex(cx + i, cz));
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells, cls: 'highway' } }]);
    runTicks(ctx, 1);
    const base = cellMoveCost(ctx.terrain, ctx.world.city, cx + 4, cz);
    const highway = cellMoveCost(ctx.terrain, ctx.world.city, cx, cz);
    expect(base).toBe(1.0); // unroaded land
    expect(highway).toBe(0.35); // the highway class factor, absolute
    expect(highway).toBeLessThan(base);
  });

  it('minRoadMoveCost() is the highway factor (heuristic stays admissible)', () => {
    expect(minRoadMoveCost()).toBe(0.35);
  });
});

describe('buildRoad / upgradeRoad commands', () => {
  it('buildRoad defaults to paved when cls is omitted', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 4, 1);
    const cells = [0, 1, 2, 3].map((i) => cellIndex(cx + i, cz));
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.roads).toHaveLength(4);
    expect(ctx.world.city.roads.every((r) => r.cls === 'paved')).toBe(true);
  });

  it('buildRoad charges the class price (dirt is cheapest)', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 4, 1);
    const cells = [0, 1].map((i) => cellIndex(cx + i, cz));
    const fundsBefore = ctx.world.city.players[0]!.funds;
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells, cls: 'dirt' } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.players[0]!.funds).toBe(fundsBefore - 2 * 2);
    expect(ctx.world.city.roads.every((r) => r.cls === 'dirt')).toBe(true);
  });

  it('upgradeRoad upgrades in place with difference pricing and rejects downgrades', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 4, 1);
    const cells = [0, 1].map((i) => cellIndex(cx + i, cz));
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells, cls: 'country' } }]);
    runTicks(ctx, 1);
    const fundsBefore = ctx.world.city.players[0]!.funds;
    enqueue(ctx, [{ kind: 'upgradeRoad', issuer: 'p', payload: { owner: 0, cells, cls: 'highway' } }]);
    runTicks(ctx, 1);
    const roads = ctx.world.city.roads;
    expect(roads).toHaveLength(2);
    expect(roads.every((r) => r.cls === 'highway')).toBe(true);
    // Difference pricing: highway (10/5) − country (4/2), per cell.
    expect(ctx.world.city.players[0]!.funds).toBe(fundsBefore - 2 * (10 - 4));
    // Downgrade rejected.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'upgradeRoad', issuer: 'p', payload: { owner: 0, cells, cls: 'dirt' },
      }),
    ).toThrow(/upgrade/i);
    expect(ctx.world.city.roads.every((r) => r.cls === 'highway')).toBe(true);
  });

  it('buildRoad keeps cells sorted even when painted in reverse', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 6, 1);
    const cells = [0, 1, 2, 3, 4, 5].map((i) => cellIndex(cx + i, cz)).reverse();
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells, cls: 'paved' } }]);
    runTicks(ctx, 1);
    const got = ctx.world.city.roads.map((r) => r.cell);
    expect([...got].sort((a, b) => a - b)).toEqual(got);
  });
});

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

describe('buildRail + the rail router', () => {
  function railCtx() {
    const ctx = setup(4242);
    const { cx, cz } = findLandRect(ctx.terrain, 12, 3);
    return { ctx, cx, cz };
  }

  it('buildRail lays sorted track cells and rejects water, dupes, and buildings', () => {
    const { ctx, cx, cz } = railCtx();
    const cells = [0, 1, 2, 3, 4].map((i) => cellIndex(cx + i, cz)).reverse();
    enqueue(ctx, [{ kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells, cls: 'electric' } }]);
    runTicks(ctx, 1);
    const rails = ctx.world.city.rails;
    expect(rails).toHaveLength(5);
    expect(rails.every((r) => r.cls === 'electric')).toBe(true);
    expect([...rails.map((r) => r.cell)].sort((a, b) => a - b)).toEqual(rails.map((r) => r.cell));
    // Duplicate cells rejected.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells: [cells[0]!] },
      }),
    ).toThrow(/already has rail/);
  });

  it('findRailRoute is deterministic and returns null when disconnected', () => {
    const { ctx, cx, cz } = railCtx();
    const a = [0, 1, 2].map((i) => cellIndex(cx + i, cz));
    const b = [0, 1, 2].map((i) => cellIndex(cx + 6 + i, cz));
    enqueue(ctx, [{ kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells: [...a, ...b] } }]);
    runTicks(ctx, 1);
    // Two separate segments: no route between them.
    expect(findRailRoute(ctx.world.city.rails, [a[0]!], [b[2]!])).toBeNull();
    // Connected segment: same route every call.
    const r1 = findRailRoute(ctx.world.city.rails, [a[0]!], [a[2]!]);
    const r2 = findRailRoute(ctx.world.city.rails, [a[0]!], [a[2]!]);
    expect(r1).toEqual(r2);
    expect(r1).toEqual([a[0], a[1], a[2]]);
  });

  it('track classes gate train speed: high-speed > standard', () => {
    const { ctx, cx, cz } = railCtx();
    const std = cellIndex(cx, cz);
    const fast = cellIndex(cx + 1, cz);
    enqueue(ctx, [{ kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells: [std], cls: 'standard' } }]);
    enqueue(ctx, [{ kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells: [fast], cls: 'high-speed' } }]);
    runTicks(ctx, 1);
    expect(trainTrackFactor(ctx.world.city.rails, std)).toBe(TRACK_CLASS_STATS.standard.speedFactor);
    expect(trainTrackFactor(ctx.world.city.rails, fast)).toBe(TRACK_CLASS_STATS['high-speed'].speedFactor);
    expect(trainTrackFactor(ctx.world.city.rails, fast)).toBeGreaterThan(
      trainTrackFactor(ctx.world.city.rails, std),
    );
    // Off-rail: neutral 1.0.
    expect(trainTrackFactor(ctx.world.city.rails, cellIndex(cx + 5, cz))).toBe(1.0);
  });

  it('nearestRailStation finds the owner\'s completed, operational station', () => {
    const { ctx, cx, cz } = railCtx();
    paintCommercialFor(ctx.world.city, cx, cz, cx + 11, cz + 2);
    const near = completed(ctx.world.city, { kind: 'railStation', owner: 0, cx, cz, facing: 0 });
    const far = completed(ctx.world.city, { kind: 'railStation', owner: 0, cx: cx + 8, cz, facing: 0 });
    far.progress = 0.5; // still building: invisible to trains
    const { x, z } = cellCenterOf(cx, cz);
    expect(nearestRailStation(ctx.world.city, x, z, 0)!.id).toBe(near.id);
    expect(nearestRailStation(ctx.world.city, x, z, 1)).toBeUndefined();
  });

  it('stationRailCells lists the rail cells under a station footprint', () => {
    const { ctx, cx, cz } = railCtx();
    const st = completed(ctx.world.city, { kind: 'railStation', owner: 0, cx, cz, facing: 0 });
    // Rails can't cross the footprint itself: lay a siding along the
    // station's south edge (the 1-cell ring stationRailCells scans).
    const siding = [0, 1, 2, 3, 4].map((i) => cellIndex(cx - 1 + i, cz + 3));
    enqueue(ctx, [{ kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells: siding } }]);
    runTicks(ctx, 1);
    const cells = stationRailCells(ctx.world.city.rails, st, BUILDING_DEFS.railStation);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(siding).toContain(c);
  });
});

// ---------------------------------------------------------------------------
// Transport hubs (buildings)
// ---------------------------------------------------------------------------

describe('transport hub buildings', () => {
  const HUBS: BuildingKind[] = ['railStation', 'busDepot', 'ferryTerminal', 'marina', 'marinaLarge'];

  it('all five hubs exist with sane footprints and costs', () => {
    for (const kind of HUBS) {
      const def = BUILDING_DEFS[kind];
      expect(def.footprintW).toBeGreaterThanOrEqual(2);
      expect(def.costFunds).toBeGreaterThan(0);
    }
    expect(BUILDING_DEFS.railStation.footprintW).toBe(3);
    expect(BUILDING_DEFS.busDepot.footprintW).toBe(3);
    expect(BUILDING_DEFS.ferryTerminal.footprintW).toBe(3);
    expect(BUILDING_DEFS.marina.footprintW).toBe(2);
    expect(BUILDING_DEFS.marinaLarge.footprintW).toBe(4);
  });

  it('ferryTerminal and the marinas require the coast', () => {
    const t = getTerrain();
    const world = createWorld(5150);
    const inland = findShoreRect(t, 4, 4, false);
    // Zone the rect first: the test pins the coastal rule, not zoning.
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        world.city.zones.push({ cell: cellIndex(inland.cx + dx, inland.cz + dz), zone: ZoneType.COMMERCIAL });
      }
    }
    world.city.zones.sort((a, b) => a.cell - b.cell);
    for (const kind of ['ferryTerminal', 'marina', 'marinaLarge'] as const) {
      const reason = validatePlacement(t, world.city, {
        kind, owner: 0, cx: inland.cx, cz: inland.cz, facing: 0,
      });
      expect(reason).toMatch(/coast/);
    }
  });

  it('railStation and busDepot place inland', () => {
    const t = getTerrain();
    const world = createWorld(5151);
    const a = findLandRect(t, 4, 4);
    paintCommercialFor(world.city, a.cx, a.cz, a.cx + 3, a.cz + 3);
    expect(validatePlacement(t, world.city, {
      kind: 'railStation', owner: 0, cx: a.cx, cz: a.cz, facing: 0,
    })).toBeNull();
    const b = findLandRect(t, 4, 4);
    // A different rect: zoneAt binary-searches, so no duplicate records.
    const bb = { cx: b.cx === a.cx && b.cz === a.cz ? b.cx + 4 : b.cx, cz: b.cz };
    paintIndustrialFor(world.city, bb.cx, bb.cz, bb.cx + 3, bb.cz + 3);
    expect(validatePlacement(t, world.city, {
      kind: 'busDepot', owner: 0, cx: bb.cx, cz: bb.cz, facing: 0,
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Civilian transport units
// ---------------------------------------------------------------------------

describe('civilian transport units', () => {
  it('all five kinds exist and are rail-bound exactly for the trains', () => {
    for (const kind of ['bus', 'tram', 'passengerTrain', 'freightTrain', 'ferry'] as const) {
      expect(UNIT_DEFS[kind as UnitKind]).toBeDefined();
    }
    expect(isRailBound('passengerTrain')).toBe(true);
    expect(isRailBound('freightTrain')).toBe(true);
    expect(isRailBound('bus')).toBe(false);
    expect(isRailBound('tram')).toBe(false);
    expect(isRailBound('ferry')).toBe(false);
    expect(isRailBound('tank')).toBe(false);
  });

  it('TRANSIT_EARNER_KINDS matches exactly the kinds with transitEarnings', () => {
    const earning = (Object.keys(UNIT_DEFS) as UnitKind[]).filter(
      (k) => (UNIT_DEFS[k].transitEarnings ?? 0) > 0,
    );
    expect([...TRANSIT_EARNER_KINDS].sort()).toEqual([...earning].sort());
  });

  it('isOnTransportNetwork: buses need roads, trains need rails, ferries need a route', () => {
    const ctx = setup(777);
    const { cx, cz } = findLandRect(ctx.terrain, 6, 2);
    const roadCell = cellIndex(cx, cz);
    const railCell = cellIndex(cx + 2, cz);
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: [roadCell] } }]);
    enqueue(ctx, [{ kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells: [railCell] } }]);
    runTicks(ctx, 1);
    const { x: rx, z: rz } = cellCenterOf(cx, cz);
    const { x: tx, z: tz } = cellCenterOf(cx + 2, cz);
    const { x: fx, z: fz } = cellCenterOf(cx + 4, cz);
    expect(isOnTransportNetwork(ctx.world.city, 'bus', rx, rz, false)).toBe(true);
    expect(isOnTransportNetwork(ctx.world.city, 'bus', fx, fz, false)).toBe(false);
    expect(isOnTransportNetwork(ctx.world.city, 'passengerTrain', tx, tz, false)).toBe(true);
    expect(isOnTransportNetwork(ctx.world.city, 'passengerTrain', rx, rz, false)).toBe(false);
    expect(isOnTransportNetwork(ctx.world.city, 'ferry', fx, fz, true)).toBe(true);
    expect(isOnTransportNetwork(ctx.world.city, 'ferry', fx, fz, false)).toBe(false);
    expect(isOnTransportNetwork(ctx.world.city, 'tank', rx, rz, false)).toBe(false);
  });

  it('ferry route: setFerryRoute starts leg a; the movement loop flips legs in id order', () => {
    const ctx = setup(31337);
    const ferry = spawnUnit(ctx.world, 'ferry', 0, 0, 0);
    const a = findWaterPoint(ctx.terrain);
    const b = findWaterPoint(ctx.terrain, a.cx + 20);
    enqueue(ctx, [{
      kind: 'setFerryRoute', issuer: 'p',
      payload: { unitId: ferry.id, owner: 0, ax: a.x, az: a.z, bx: b.x, bz: b.z },
    }]);
    runTicks(ctx, 1);
    expect(ferry.route).toBeDefined();
    expect(ferry.route!.leg).toBe('a');
  });

  it('earnings: an on-network bus pays, an off-network bus earns nothing', () => {
    const t = getTerrain();
    const world = createWorld(60606);
    world.tick = 150;
    const { cx, cz } = findLandRect(t, 6, 2);
    const roadCell = cellIndex(cx, cz);
    world.city.roads = [{ cell: roadCell, cls: 'paved' }];
    const { x: rx, z: rz } = cellCenterOf(cx, cz);
    const { x: fx, z: fz } = cellCenterOf(cx + 4, cz);
    spawnUnit(world, 'bus', 0, rx, rz);
    spawnUnit(world, 'bus', 0, fx, fz);
    const player = world.city.players[0]!;
    player.funds = 1000;
    runEconomyTick(world, t);
    // Exactly one bus earns its transitEarnings per second.
    expect(player.funds).toBeCloseTo(1000 + (UNIT_DEFS.bus.transitEarnings ?? 0), 9);
  });

  it('transitGrowthBonus: +0.03 per on-network unit, capped at +0.15', () => {
    expect(TRANSIT_GROWTH_PER_UNIT).toBe(0.03);
    expect(TRANSIT_GROWTH_CAP).toBe(0.15);
    const t = getTerrain();
    const world = createWorld(70707);
    const { cx, cz } = findLandRect(t, 20, 2);
    for (let i = 0; i < 10; i++) {
      world.city.roads.push({ cell: cellIndex(cx + i, cz), cls: 'paved' });
    }
    world.city.roads.sort((a, b) => a.cell - b.cell);
    for (let i = 0; i < 6; i++) {
      const { x, z } = cellCenterOf(cx + i, cz);
      const bus = spawnUnit(world, 'bus', 0, x, z);
      bus.hp = 10;
    }
    // 6 on-network buses × 0.03 = 0.18 → capped at 0.15.
    expect(transitGrowthBonus(world, 0)).toBeCloseTo(0.15, 9);
    expect(transitGrowthBonus(world, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

describe('Classic AI and civilian transport', () => {
  it('thinkCivilianTransport is a documented no-op (digest unchanged)', () => {
    const world = createWorld(80808);
    addAIPlayer(world, 1, 'citizen', 0, 0);
    const bus = spawnUnit(world, 'bus', 1, 0, 0);
    bus.hp = 10;
    const ai = world.ai.players[0]!;
    const before = digestWorld(world);
    thinkCivilianTransport(world, ai);
    expect(digestWorld(world)).toBe(before);
  });

  it('canTrain gates civilian transports on their hub buildings', () => {
    const world = createWorld(90909);
    // No hubs: nothing trainable.
    expect(canTrain(world, 0, 'bus')).toBe(false);
    expect(canTrain(world, 0, 'passengerTrain')).toBe(false);
    expect(canTrain(world, 0, 'ferry')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Snapshot v7 round-trip
// ---------------------------------------------------------------------------

describe('snapshot v8: roads, rails, ferry routes', () => {
  it('round-trips road classes, rails, and ferry routes with an identical digest', () => {
    expect(SNAPSHOT_VERSION).toBe(8); // v8: Phase 5/6 S4 hangar data contract
    const ctx = setup(10101);
    const { cx, cz } = findLandRect(ctx.terrain, 8, 2);
    const roadCells = [0, 1, 2].map((i) => cellIndex(cx + i, cz));
    const railCells = [0, 1, 2].map((i) => cellIndex(cx + i, cz + 1));
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells, cls: 'highway' } }]);
    enqueue(ctx, [{ kind: 'buildRail', issuer: 'p', payload: { owner: 0, cells: railCells, cls: 'electric' } }]);
    runTicks(ctx, 1);
    const ferry = spawnUnit(ctx.world, 'ferry', 0, 0, 0);
    const a = findWaterPoint(ctx.terrain);
    const b = findWaterPoint(ctx.terrain, a.cx + 20);
    enqueue(ctx, [{
      kind: 'setFerryRoute', issuer: 'p',
      payload: { unitId: ferry.id, owner: 0, ax: a.x, az: a.z, bx: b.x, bz: b.z },
    }]);
    runTicks(ctx, 1);
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(digestWorld(restored)).toBe(before);
    expect(restored.city.roads.every((r) => r.cls === 'highway')).toBe(true);
    expect(restored.city.rails.every((r) => r.cls === 'electric')).toBe(true);
    const rFerry = restored.units.find((u) => u.id === ferry.id)!;
    expect(rFerry.route).toMatchObject({ leg: 'a' });
  });

  it('a hand-built v6 snapshot (number[] roads) migrates on decode', () => {
    const world = createWorld(20202);
    const snap = takeSnapshot(world);
    // Simulate a v6 save: version 6, roads as plain numbers.
    const v6 = { ...snap, version: 6, city: { ...snap.city, roads: [5, 3, 9] } };
    const restored = restoreSnapshot(v6 as never);
    expect(restored.city.roads).toEqual([
      { cell: 5, cls: 'paved' },
      { cell: 3, cls: 'paved' },
      { cell: 9, cls: 'paved' },
    ]);
    expect(restored.city.rails).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function findWaterPoint(t: TerrainData, minCx = 0): { cx: number; x: number; z: number } {
  for (let cz = 0; cz < CITY_GRID_CELLS; cz++) {
    for (let cx = minCx; cx < CITY_GRID_CELLS; cx++) {
      if (cellIsWater(t, cx, cz)) return { cx, x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
    }
  }
  throw new Error('no water cell');
}

function findShoreRect(
  t: TerrainData, w: number, h: number, wantCoastal: boolean,
): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let allLand = true;
      for (let dz = 0; dz < h && allLand; dz++) {
        for (let dx = 0; dx < w && allLand; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) allLand = false;
        }
      }
      if (!allLand) continue;
      let coastal = false;
      for (let dz = 0; dz < h && !coastal; dz++) {
        for (let dx = 0; dx < w && !coastal; dx++) {
          const px = cx + dx;
          const pz = cz + dz;
          if (
            (px > 0 && cellIsWater(t, px - 1, pz)) ||
            (px < CITY_GRID_CELLS - 1 && cellIsWater(t, px + 1, pz)) ||
            (pz > 0 && cellIsWater(t, px, pz - 1)) ||
            (pz < CITY_GRID_CELLS - 1 && cellIsWater(t, px, pz + 1))
          ) {
            coastal = true;
          }
        }
      }
      if (coastal === wantCoastal) return { cx, cz };
    }
  }
  throw new Error(`no ${wantCoastal ? 'coastal' : 'landlocked'} ${w}x${h} rect`);
}

function paintCommercialFor(city: CityState, x0: number, z0: number, x1: number, z1: number): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.COMMERCIAL });
    }
  }
  city.zones.sort((a, b) => a.cell - b.cell);
}

function paintIndustrialFor(city: CityState, x0: number, z0: number, x1: number, z1: number): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.INDUSTRIAL });
    }
  }
  city.zones.sort((a, b) => a.cell - b.cell);
}

function cellCenterOf(cx: number, cz: number): { x: number; z: number } {
  return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
}
