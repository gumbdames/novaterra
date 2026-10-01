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
 * NOVATERRA — civilian sea trade sim tests (Half A, 2026-10-01).
 *
 * These tests pin the civilian sea-trade sim contract:
 *  - Defs: `commercialHarbor` (civilian port, NOT military, the
 *    cargoFreighter/fuelBarge gate) and `fuelBarge` (civilian fuel
 *    hauler); the freighter's new `requiredBuilding` gate and its
 *    materials hold.
 *  - `establishSeaRoute` / `cancelSeaRoute` / `assignSeaRoute` command
 *    contracts (500-fund setup, endpoint rules — own completed
 *    civilian ports only, undirected duplicates, policy validation).
 *  - `isSeaTradeShip`: the civilian-cargo-vessel predicate.
 *  - `seaVoyageIncome`: the exact per-voyage income formula.
 *  - `runSeaTradePortCall`: the three cargo policies at origin /
 *    destination.
 *  - `advanceSeaTrade` (movement): idle ships sail the route, port
 *    actions fire on arrival, legs flip, detours resume, out-of-fuel
 *    retries, dead routes release loudly.
 *  - `runEconomyTick` dead-route cleanup.
 *  - Snapshot: seaRoutes/nextSeaRouteId/cargoMaterials/seaRouteId/leg
 *    survive a v8 round trip (stays v8 — AD9 additive); digest covers
 *    the new fields.
 *
 * Command-application note: `queue.enqueue` validates immediately
 * (rejections throw there) but `apply` runs on the tick driver — the
 * fixture steps a command-only driver (`systems: []`) so route
 * establishments really land, with zero economy side effects (the
 * airports-test precedent).
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  cellCoords,
  cellIndex,
  cellIsWater,
  CITY_GRID_CELLS,
  getPlayer,
  isCoastal,
  placeBuilding,
} from '../src/sim/city';
import type { BuildingKind, SeaRoute } from '../src/sim/city';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerCityCommands } from '../src/sim/city';
import {
  SEA_ROUTE_SETUP_COST,
  clearSeaRouteAssignments,
  registerEconomyCommands,
  runEconomyTick,
} from '../src/sim/economy';
import {
  MATERIALS_EXPORT_PRICE,
  SEA_TRADE_VOYAGE_BASE,
  SEA_TRADE_VOYAGE_PER_UNIT,
  isSeaTradeShip,
  runSeaTradePortCall,
  seaVoyageIncome,
} from '../src/sim/seaTrade';
import { UNIT_DEFS, spawnUnit } from '../src/sim/units';
import type { UnitKind, UnitRecord } from '../src/sim/units';
import { createMovementSystem, harborWaterCell } from '../src/sim/movement';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import { registerUnitCommands } from '../src/sim/units';
import type { CommandQueue, NewCommand } from '../src/sim/commands';
import type { TerrainData } from '../src/sim/terrain';
import type { World } from '../src/sim/world';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { canonicalizeWorld } from '../src/sim/digest';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
}

function setup(seed = 20261001): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.tick = 150;
  world.time = 150 / 30;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  registerUnitCommands(queue, terrain);
  return { terrain, world, queue };
}

/** Step the command queue once with no systems (pure apply). */
function applyQueued(ctx: Ctx): void {
  createTickDriver({ queue: ctx.queue, systems: [] }).step(ctx.world, TICK_MS);
}

/** Step the movement system once (advanceSeaTrade lives there). */
function stepMovement(ctx: Ctx): void {
  createTickDriver({
    queue: ctx.queue,
    systems: [createMovementSystem(ctx.terrain)],
  }).step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmds: NewCommand[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, c);
  applyQueued(ctx);
}

/** Try one command; return the rejection message or null. */
function tryCmd(ctx: Ctx, cmd: NewCommand): string | null {
  try {
    ctx.queue.enqueue(ctx.world, cmd);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  applyQueued(ctx);
  return null;
}

/**
 * A w×h footprint of pure land that IS coastal (passes the port rule),
 * not overlapping any rect in `exclude` (the sim.naval.test.ts
 * precedent).
 */
function findCoastalFootprint(
  t: TerrainData,
  w: number,
  h: number,
  exclude: Array<{ cx: number; cz: number; w: number; h: number }> = [],
): { cx: number; cz: number } {
  for (let cz = 8; cz < CITY_GRID_CELLS - 8 - h; cz += 2) {
    for (let cx = 8; cx < CITY_GRID_CELLS - 8 - w; cx += 2) {
      let allLand = true;
      for (let dz = 0; dz < h && allLand; dz++) {
        for (let dx = 0; dx < w && allLand; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) allLand = false;
        }
      }
      if (!allLand) continue;
      if (!isCoastal(t, cx, cz, w, h)) continue;
      if (
        exclude.some(
          (r) =>
            cx < r.cx + r.w + 1 &&
            r.cx < cx + w + 1 &&
            cz < r.cz + r.h + 1 &&
            r.cz < cz + h + 1,
        )
      ) {
        continue;
      }
      return { cx, cz };
    }
  }
  throw new Error('no coastal footprint on MERIDIAN_PLAINS');
}

/** Directly place a completed, operational building (bypasses commands). */
function completed(
  ctx: Ctx,
  kind: BuildingKind,
  cx: number,
  cz: number,
  owner = 0,
) {
  const b = placeBuilding(ctx.world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  b.operational = true;
  b.powered = true;
  b.watered = true;
  return b;
}

/** Two completed commercialHarbors for owner 0, far apart. */
function twoHarbors(ctx: Ctx) {
  const a = findCoastalFootprint(ctx.terrain, 4, 3);
  const b = findCoastalFootprint(ctx.terrain, 4, 3, [{ ...a, w: 4, h: 3 }]);
  const ha = completed(ctx, 'commercialHarbor', a.cx, a.cz);
  const hb = completed(ctx, 'commercialHarbor', b.cx, b.cz);
  return { ha, hb };
}

/** Spawn a unit directly (bypasses commands) at a world position. */
function spawnAt(ctx: Ctx, kind: UnitKind, x: number, z: number, owner = 0): UnitRecord {
  return spawnUnit(ctx.world, kind, owner, x, z);
}

function establishRoute(
  ctx: Ctx,
  from: number,
  to: number,
  policy: string,
  owner = 0,
): string | null {
  return tryCmd(ctx, {
    kind: 'establishSeaRoute',
    issuer: 'test',
    payload: { owner, from, to, policy },
  });
}

// ---------------------------------------------------------------------------
// Defs
// ---------------------------------------------------------------------------

describe('civilian sea trade defs', () => {
  it('commercialHarbor is a civilian coastal production building', () => {
    const def = BUILDING_DEFS.commercialHarbor;
    expect(def.portType).toBe('civilian');
    expect(def.military ?? false).toBe(false);
    expect(def.reloadPoint).toBe(true);
    expect(def.fuelStorage).toBe(300);
    expect(def.costFunds).toBe(1000);
    expect(def.costMaterials).toBe(400);
    expect(def.minAge).toBe('industry');
    expect(def.jobs).toBe(25);
  });

  it('cargoFreighter is gated at the commercialHarbor and carries a materials hold', () => {
    const def = UNIT_DEFS.cargoFreighter;
    expect(def.requiredBuilding).toBe('commercialHarbor');
    expect(def.cargoMaterialsCapacity).toBe(200);
    expect(def.military ?? false).toBe(false);
  });

  it('fuelBarge is a civilian fuel hauler gated at the commercialHarbor', () => {
    const def = UNIT_DEFS.fuelBarge;
    expect(def.domain).toBe('sea');
    expect(def.military ?? false).toBe(false);
    expect(def.requiredBuilding).toBe('commercialHarbor');
    expect(def.cargoFuelCapacity).toBe(250);
    expect(def.cargoAmmoCapacity ?? 0).toBe(0);
    expect(def.minAge).toBe('industry');
  });
});

describe('isSeaTradeShip', () => {
  it('accepts civilian cargo vessels only', () => {
    expect(isSeaTradeShip('cargoFreighter')).toBe(true);
    expect(isSeaTradeShip('fuelBarge')).toBe(true);
    // Passenger vessels have no cargo holds.
    expect(isSeaTradeShip('cruiseLiner')).toBe(false);
    expect(isSeaTradeShip('yacht')).toBe(false);
    // Military hulls are never route ships (even with holds).
    expect(isSeaTradeShip('fuelTanker')).toBe(false);
    expect(isSeaTradeShip('ammoShip')).toBe(false);
    expect(isSeaTradeShip('destroyer')).toBe(false);
    // Land/air kinds are never route ships.
    expect(isSeaTradeShip('supplyTruck')).toBe(false);
    expect(isSeaTradeShip('cargoPlane')).toBe(false);
    expect(isSeaTradeShip('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// establishSeaRoute / cancelSeaRoute
// ---------------------------------------------------------------------------

describe('establishSeaRoute', () => {
  it('establishes a route between two own completed civilian ports', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    const before = getPlayer(ctx.world.city, 0)!.funds;
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const routes = ctx.world.city.seaRoutes;
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: 1,
      owner: 0,
      from: ha.id,
      to: hb.id,
      policy: 'funds',
      establishedTick: 150,
    });
    expect(ctx.world.city.nextSeaRouteId).toBe(2);
    expect(getPlayer(ctx.world.city, 0)!.funds).toBe(before - SEA_ROUTE_SETUP_COST);
  });

  it('accepts all three policies', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'fuel')).toBeNull();
    // Second route needs a third harbor (undirected-dup rule).
    const c = findCoastalFootprint(ctx.terrain, 4, 3, [
      { cx: ha.cx, cz: ha.cz, w: 4, h: 3 },
      { cx: hb.cx, cz: hb.cz, w: 4, h: 3 },
    ]);
    const hc = completed(ctx, 'commercialHarbor', c.cx, c.cz);
    expect(establishRoute(ctx, ha.id, hc.id, 'materials')).toBeNull();
    expect(ctx.world.city.seaRoutes.map((r) => r.policy)).toEqual(['fuel', 'materials']);
  });

  it('rejects bad endpoints loudly', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    // Unknown building.
    expect(establishRoute(ctx, 9999, hb.id, 'funds')).toMatch(/unknown from building/);
    // Not yours.
    const other = completed(ctx, 'commercialHarbor', hb.cx, hb.cz, 1);
    void other;
    const rival = ctx.world.city.buildings.find((b) => b.owner === 1)!;
    expect(establishRoute(ctx, rival.id, hb.id, 'funds')).toMatch(/not yours/);
    // Not completed.
    const raw = placeBuilding(ctx.world.city, {
      kind: 'commercialHarbor',
      owner: 0,
      cx: ha.cx,
      cz: ha.cz,
      facing: 0,
    });
    expect(establishRoute(ctx, raw.id, hb.id, 'funds')).toMatch(/not completed/);
    // Same harbor twice.
    expect(establishRoute(ctx, ha.id, ha.id, 'funds')).toMatch(/different harbors/);
    // Unknown policy.
    expect(establishRoute(ctx, ha.id, hb.id, 'passengers')).toMatch(/unknown policy/);
  });

  it('rejects the military navalBase as an endpoint', () => {
    const ctx = setup();
    const { ha } = twoHarbors(ctx);
    const spot = findCoastalFootprint(ctx.terrain, 4, 3, [{ cx: ha.cx, cz: ha.cz, w: 4, h: 3 }]);
    const nb = completed(ctx, 'navalBase', spot.cx, spot.cz);
    expect(establishRoute(ctx, ha.id, nb.id, 'funds')).toMatch(/not a civilian port/);
    expect(establishRoute(ctx, nb.id, ha.id, 'funds')).toMatch(/not a civilian port/);
  });

  it('rejects undirected duplicates and unaffordable setups', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    expect(establishRoute(ctx, hb.id, ha.id, 'funds')).toMatch(/already exists/);
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 1;
    const spot = findCoastalFootprint(ctx.terrain, 4, 3, [
      { cx: ha.cx, cz: ha.cz, w: 4, h: 3 },
      { cx: hb.cx, cz: hb.cz, w: 4, h: 3 },
    ]);
    const hc = completed(ctx, 'commercialHarbor', spot.cx, spot.cz);
    expect(establishRoute(ctx, ha.id, hc.id, 'funds')).toMatch(/cannot afford/);
  });
});

describe('cancelSeaRoute', () => {
  it('removes the route and releases assigned ships loudly', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    expect(
      tryCmd(ctx, {
        kind: 'assignSeaRoute',
        issuer: 'test',
        payload: { owner: 0, unitId: ship.id, routeId: 1 },
      }),
    ).toBeNull();
    expect(tryCmd(ctx, { kind: 'cancelSeaRoute', issuer: 'test', payload: { owner: 0, id: 1 } })).toBeNull();
    expect(ctx.world.city.seaRoutes).toHaveLength(0);
    expect(ship.seaRouteId).toBe(0);
    expect(ship.seaRouteLeg).toBeUndefined();
    expect(ship.failReason).toBe('sea route cancelled');
  });

  it('rejects unknown routes and other owners', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    expect(tryCmd(ctx, { kind: 'cancelSeaRoute', issuer: 'test', payload: { owner: 0, id: 77 } })).toMatch(
      /unknown route/,
    );
    expect(tryCmd(ctx, { kind: 'cancelSeaRoute', issuer: 'test', payload: { owner: 1, id: 1 } })).toMatch(
      /another player/,
    );
  });
});

// ---------------------------------------------------------------------------
// assignSeaRoute
// ---------------------------------------------------------------------------

describe('assignSeaRoute', () => {
  function assignedCtx() {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    return ctx;
  }

  it('assigns a civilian cargo vessel with leg "to"', () => {
    const ctx = assignedCtx();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    expect(
      tryCmd(ctx, {
        kind: 'assignSeaRoute',
        issuer: 'test',
        payload: { owner: 0, unitId: ship.id, routeId: 1 },
      }),
    ).toBeNull();
    expect(ship.seaRouteId).toBe(1);
    expect(ship.seaRouteLeg).toBe('to');
  });

  it('routeId 0 unassigns', () => {
    const ctx = assignedCtx();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'from';
    expect(
      tryCmd(ctx, {
        kind: 'assignSeaRoute',
        issuer: 'test',
        payload: { owner: 0, unitId: ship.id, routeId: 0 },
      }),
    ).toBeNull();
    expect(ship.seaRouteId).toBe(0);
    expect(ship.seaRouteLeg).toBeUndefined();
  });

  it('rejects bad assignments loudly', () => {
    const ctx = assignedCtx();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    const liner = spawnAt(ctx, 'cruiseLiner', 0, 0);
    // Passenger vessel: not a cargo vessel.
    expect(
      tryCmd(ctx, {
        kind: 'assignSeaRoute',
        issuer: 'test',
        payload: { owner: 0, unitId: liner.id, routeId: 1 },
      }),
    ).toMatch(/not a civilian cargo vessel/);
    // Unknown route.
    expect(
      tryCmd(ctx, {
        kind: 'assignSeaRoute',
        issuer: 'test',
        payload: { owner: 0, unitId: ship.id, routeId: 42 },
      }),
    ).toMatch(/unknown route/);
    // Unknown unit.
    expect(
      tryCmd(ctx, {
        kind: 'assignSeaRoute',
        issuer: 'test',
        payload: { owner: 0, unitId: 4242, routeId: 1 },
      }),
    ).toMatch(/unknown unit/);
    // Not yours.
    const rivalShip = spawnAt(ctx, 'cargoFreighter', 0, 0, 1);
    expect(
      tryCmd(ctx, {
        kind: 'assignSeaRoute',
        issuer: 'test',
        payload: { owner: 0, unitId: rivalShip.id, routeId: 1 },
      }),
    ).toMatch(/not yours/);
  });
});

// ---------------------------------------------------------------------------
// seaVoyageIncome
// ---------------------------------------------------------------------------

describe('seaVoyageIncome', () => {
  it('pays the base plus 0.25 per world unit of harbor distance', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const route = ctx.world.city.seaRoutes[0] as SeaRoute;
    const dx = cellCenterWorld(ha.cx) - cellCenterWorld(hb.cx);
    const dz = cellCenterWorld(ha.cz) - cellCenterWorld(hb.cz);
    const expected = SEA_TRADE_VOYAGE_BASE + Math.sqrt(dx * dx + dz * dz) * SEA_TRADE_VOYAGE_PER_UNIT;
    expect(seaVoyageIncome(ctx.world, route)).toBeCloseTo(expected, 9);
    // Deterministic: two calls agree exactly.
    expect(seaVoyageIncome(ctx.world, route)).toBe(seaVoyageIncome(ctx.world, route));
  });

  it('is 0 when an endpoint is gone', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const route = ctx.world.city.seaRoutes[0] as SeaRoute;
    ctx.world.city.buildings = ctx.world.city.buildings.filter((b) => b.id !== hb.id);
    expect(seaVoyageIncome(ctx.world, route)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// runSeaTradePortCall
// ---------------------------------------------------------------------------

describe('runSeaTradePortCall', () => {
  function portCtx(policy: 'funds' | 'fuel' | 'materials') {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, policy)).toBeNull();
    const route = ctx.world.city.seaRoutes[0] as SeaRoute;
    return { ctx, ha, hb, route };
  }

  it('funds policy: credits the voyage income at the destination, nothing at the origin', () => {
    const { ctx, ha, hb, route } = portCtx('funds');
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    const before = getPlayer(ctx.world.city, 0)!.funds;
    runSeaTradePortCall(ctx.world, ship, route, ha.id, true);
    expect(getPlayer(ctx.world.city, 0)!.funds).toBe(before);
    runSeaTradePortCall(ctx.world, ship, route, hb.id, false);
    expect(getPlayer(ctx.world.city, 0)!.funds).toBeCloseTo(before + seaVoyageIncome(ctx.world, route), 9);
  });

  it('fuel policy: loads at the origin, unloads at the destination', () => {
    const { ctx, ha, hb, route } = portCtx('fuel');
    ha.fuelStock = 500;
    const barge = spawnAt(ctx, 'fuelBarge', 0, 0);
    runSeaTradePortCall(ctx.world, barge, route, ha.id, true);
    expect(barge.cargoFuel).toBe(250); // hold-capped
    expect(ha.fuelStock).toBe(250);
    // Destination has no fuelStorage def (uncapped) — the hold empties.
    hb.fuelStock = 0;
    runSeaTradePortCall(ctx.world, barge, route, hb.id, false);
    expect(barge.cargoFuel).toBe(0);
    expect(hb.fuelStock).toBe(250);
  });

  it('fuel policy: destination unload respects the harbor fuelStorage cap', () => {
    const { ctx, ha, hb, route } = portCtx('fuel');
    const barge = spawnAt(ctx, 'fuelBarge', 0, 0);
    barge.cargoFuel = 250;
    hb.fuelStock = 200; // commercialHarbor fuelStorage is 300 → room for 100
    runSeaTradePortCall(ctx.world, barge, route, hb.id, false);
    expect(hb.fuelStock).toBe(300);
    expect(barge.cargoFuel).toBe(150);
  });

  it('materials policy: loads from the treasury at the origin, sells at the destination', () => {
    const { ctx, ha, hb, route } = portCtx('materials');
    const player = getPlayer(ctx.world.city, 0)!;
    player.materials = 1000;
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    runSeaTradePortCall(ctx.world, ship, route, ha.id, true);
    expect(ship.cargoMaterials).toBe(200); // hold-capped
    expect(player.materials).toBe(800);
    const fundsBefore = player.funds;
    runSeaTradePortCall(ctx.world, ship, route, hb.id, false);
    expect(ship.cargoMaterials).toBe(0);
    expect(player.funds).toBeCloseTo(fundsBefore + 200 * MATERIALS_EXPORT_PRICE, 9);
    expect(MATERIALS_EXPORT_PRICE).toBe(2);
  });

  it('materials load never overdraws the treasury', () => {
    const { ctx, ha, route } = portCtx('materials');
    const player = getPlayer(ctx.world.city, 0)!;
    player.materials = 50;
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    runSeaTradePortCall(ctx.world, ship, route, ha.id, true);
    expect(ship.cargoMaterials).toBe(50);
    expect(player.materials).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// advanceSeaTrade (movement)
// ---------------------------------------------------------------------------

describe('advanceSeaTrade', () => {
  function waterSpot(ctx: Ctx, b: { cx: number; cz: number; kind: BuildingKind }) {
    const cell = harborWaterCell(ctx.terrain, b);
    expect(cell).toBeGreaterThan(0);
    const { cx, cz } = cellCoords(cell);
    return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
  }

  it('dispatches an idle assigned ship toward the destination harbor', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const from = waterSpot(ctx, ha);
    const ship = spawnAt(ctx, 'cargoFreighter', from.x, from.z);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'to';
    ship.state = 'idle';
    stepMovement(ctx);
    // Dispatched: no longer idle (sailing or awaiting a path).
    expect(ship.state).not.toBe('idle');
    // Heading for the destination harbor's water cell.
    const to = waterSpot(ctx, hb);
    expect(ship.arriveX).toBeCloseTo(to.x, 6);
    expect(ship.arriveZ).toBeCloseTo(to.z, 6);
  });

  it('fires the port action on arrival and flips the leg', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const route = ctx.world.city.seaRoutes[0] as SeaRoute;
    const to = waterSpot(ctx, hb);
    const ship = spawnAt(ctx, 'cargoFreighter', to.x, to.z);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'to';
    ship.state = 'idle';
    const before = getPlayer(ctx.world.city, 0)!.funds;
    stepMovement(ctx);
    // Arrived at the destination: income credited, leg flipped to 'from',
    // and the ship re-dispatched toward the origin the same tick.
    expect(getPlayer(ctx.world.city, 0)!.funds).toBeCloseTo(
      before + seaVoyageIncome(ctx.world, route),
      9,
    );
    expect(ship.seaRouteLeg).toBe('from');
    const from = waterSpot(ctx, ha);
    expect(ship.arriveX).toBeCloseTo(from.x, 6);
    expect(ship.arriveZ).toBeCloseTo(from.z, 6);
  });

  it('loads fuel at the origin on the return leg', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'fuel')).toBeNull();
    ha.fuelStock = 400;
    const from = waterSpot(ctx, ha);
    const barge = spawnAt(ctx, 'fuelBarge', from.x, from.z);
    barge.seaRouteId = 1;
    barge.seaRouteLeg = 'from';
    barge.state = 'idle';
    stepMovement(ctx);
    expect(barge.cargoFuel).toBe(250);
    expect(ha.fuelStock).toBe(150);
    expect(barge.seaRouteLeg).toBe('to');
  });

  it('a detoured ship resumes its leg without a port action', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const route = ctx.world.city.seaRoutes[0] as SeaRoute;
    // Park the ship far from either harbor (a finished detour).
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'to';
    ship.state = 'idle';
    const before = getPlayer(ctx.world.city, 0)!.funds;
    stepMovement(ctx);
    // Resumed sailing to the destination — but no port action fired
    // (it is not at the harbor).
    expect(getPlayer(ctx.world.city, 0)!.funds).toBe(before);
    const to = waterSpot(ctx, hb);
    expect(ship.arriveX).toBeCloseTo(to.x, 6);
    expect(seaVoyageIncome(ctx.world, route)).toBeGreaterThan(0);
  });

  it('retries out-of-fuel ships every 30 ticks', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'to';
    ship.state = 'failed';
    ship.failReason = 'out of fuel';
    ctx.world.tick = 150; // 150 % 30 === 0 → retry tick
    stepMovement(ctx);
    expect(ship.state).not.toBe('failed');
    expect(ship.failReason).toBeNull();
  });

  it('releases the assignment loudly when the route vanished mid-tick', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'to';
    ship.state = 'idle';
    // Vanish the route without the cancel command (mid-tick defense).
    ctx.world.city.seaRoutes = [];
    stepMovement(ctx);
    expect(ship.seaRouteId).toBe(0);
    expect(ship.seaRouteLeg).toBeUndefined();
    expect(ship.failReason).toBe('sea route ended');
  });
});

// ---------------------------------------------------------------------------
// Dead-route cleanup
// ---------------------------------------------------------------------------

describe('sea route cleanup', () => {
  it('runEconomyTick removes routes with a dead endpoint and releases ships', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'to';
    // Demolish the destination endpoint.
    ctx.world.city.buildings = ctx.world.city.buildings.filter((b) => b.id !== hb.id);
    runEconomyTick(ctx.world, ctx.terrain);
    expect(ctx.world.city.seaRoutes).toHaveLength(0);
    expect(ship.seaRouteId).toBe(0);
    expect(ship.failReason).toBe('sea route ended');
  });

  it('clearSeaRouteAssignments releases in id order', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const s1 = spawnAt(ctx, 'cargoFreighter', 0, 0);
    const s2 = spawnAt(ctx, 'fuelBarge', 0, 0);
    s1.seaRouteId = 1;
    s2.seaRouteId = 1;
    const seen: number[] = [];
    const orig = s1.failReason;
    void orig;
    clearSeaRouteAssignments(ctx.world, 1, 'test release');
    for (const u of ctx.world.units) {
      if (u.failReason === 'test release') seen.push(u.id);
    }
    expect(seen).toEqual([s1.id, s2.id].sort((a, b) => a - b));
  });
});

// ---------------------------------------------------------------------------
// Snapshot + digest
// ---------------------------------------------------------------------------

describe('sea trade snapshots', () => {
  it('sea routes, counters, holds, and assignments survive a v8 round trip', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'materials')).toBeNull();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'from';
    ship.cargoMaterials = 123;
    const snap = takeSnapshot(ctx.world);
    const restored = restoreSnapshot(snap);
    expect(restored.city.seaRoutes).toEqual(ctx.world.city.seaRoutes);
    expect(restored.city.nextSeaRouteId).toBe(2);
    const ru = restored.units.find((u) => u.id === ship.id)!;
    expect(ru.seaRouteId).toBe(1);
    expect(ru.seaRouteLeg).toBe('from');
    expect(ru.cargoMaterials).toBe(123);
  });

  it('legacy saves without sea fields decode to empty (stays v8)', () => {
    const ctx = setup();
    const snap = takeSnapshot(ctx.world) as unknown as Record<string, unknown>;
    const city = snap['city'] as Record<string, unknown>;
    delete city['seaRoutes'];
    delete city['nextSeaRouteId'];
    const restored = restoreSnapshot(snap as never);
    expect(restored.city.seaRoutes).toEqual([]);
    expect(restored.city.nextSeaRouteId).toBe(1);
    // A legacy unit without the new fields decodes to empty hold /
    // no assignment.
    const u = restored.units[0];
    expect(u?.cargoMaterials ?? 0).toBe(0);
    expect(u?.seaRouteId ?? 0).toBe(0);
  });
});

describe('sea trade digest', () => {
  it('covers routes, the id counter, holds, and assignments', () => {
    const ctx = setup();
    const { ha, hb } = twoHarbors(ctx);
    expect(establishRoute(ctx, ha.id, hb.id, 'funds')).toBeNull();
    const ship = spawnAt(ctx, 'cargoFreighter', 0, 0);
    ship.seaRouteId = 1;
    ship.seaRouteLeg = 'to';
    ship.cargoMaterials = 77;
    const d = canonicalizeWorld(ctx.world);
    expect(d).toContain('|sea=1:0:');
    expect(d).toContain(':funds@');
    expect(d).toContain(',nextSeaId=2;');
    // The unit line carries the materials hold + assignment.
    expect(d).toContain(',77,1,to,');
  });

  it('legacy-decoded worlds digest stably', () => {
    const ctx = setup();
    const snap = takeSnapshot(ctx.world) as unknown as Record<string, unknown>;
    const city = snap['city'] as Record<string, unknown>;
    delete city['seaRoutes'];
    delete city['nextSeaRouteId'];
    const restored = restoreSnapshot(snap as never);
    const d = canonicalizeWorld(restored);
    expect(d).toContain('|sea=,nextSeaId=1;');
  });
});
