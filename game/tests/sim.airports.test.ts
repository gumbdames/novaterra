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
 * NOVATERRA — airport + airline sim tests (grand-expansion Phase 5,
 * workstream A, S5+S8, 2026-09-30).
 *
 * These tests pin the Phase 5 airport sim contract:
 *  - `ZoneType.AIRPORT` (3): `paintZone` accepts 3, rejects 4; airport
 *    buildings require airport zoning (and reject loudly elsewhere);
 *    non-airport buildings are rejected on airport zones.
 *  - `tryAutoDevelop` never builds on airport zones (airports are
 *    player-placed only).
 *  - `countsAs`: militaryAirbase / mixedAirport satisfy
 *    `hasProductionBuilding(world, owner, 'airfield')`.
 *  - The 4-tuple `taxRates`: legacy 3-element saves decode element 3 to
 *    DEFAULT_TAX_RATE (AD9 additive — the snapshot stays v8, pinned
 *    below); `setTaxRate` accepts zone 3; zone-3 buildings pay
 *    `taxRates[3]`.
 *  - Airline routes: the `establishAirlineRoute` / `cancelAirlineRoute`
 *    command contract (500-fund setup, endpoint rules, undirected
 *    duplicates); `airlineRouteIncome` determinism + distance/terminal
 *    scaling; `runEconomyTick` pays living routes and removes dead ones.
 *  - Snapshot: `airlineRoutes` + `nextAirlineRouteId` survive a v8
 *    round trip.
 *
 * Command-application note: `queue.enqueue` validates immediately
 * (rejections throw there) but `apply` runs on the tick driver — the
 * fixture steps a command-only driver (`systems: []`) so zone paints
 * and route establishments really land, with zero economy side effects.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { generateTerrain } from '../src/sim/terrain';
import { MERIDIAN_PLAINS } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  DEFAULT_TAX_RATE,
  ZoneType,
  cellIsWater,
  getPlayer,
  hasProductionBuilding,
  placeBuilding,
  runGrowth,
  validatePlacement,
  cellIndex,
  CITY_GRID_CELLS,
} from '../src/sim/city';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerCityCommands } from '../src/sim/city';
import {
  AIRLINE_BASE_INCOME_PER_SEC,
  AIRLINE_CARGO_TERMINAL_BONUS,
  AIRLINE_DISTANCE_INCOME_PER_UNIT,
  AIRLINE_PASSENGER_TERMINAL_BONUS,
  AIRLINE_ROUTE_SETUP_COST,
  airlineRouteIncome,
  registerEconomyCommands,
  runEconomyTick,
} from '../src/sim/economy';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import type { CommandQueue, NewCommand } from '../src/sim/commands';
import type { TerrainData } from '../src/sim/terrain';
import type { World } from '../src/sim/world';
import { cellCenterWorld } from '../src/sim/city';
import { takeSnapshot, restoreSnapshot, SNAPSHOT_VERSION } from '../src/sim/snapshot';

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

function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.tick = 150;
  world.time = 150 / 30;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  return { terrain, world, queue };
}

/** Step the command queue once with no economy systems (pure apply). */
function applyQueued(ctx: Ctx): void {
  createTickDriver({ queue: ctx.queue, systems: [] }).step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmds: NewCommand[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, c);
  applyQueued(ctx);
}

/** Find an all-land rect (for zoning / footprints). */
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

/** Directly place a completed, operational building (bypasses commands). */
function completed(ctx: Ctx, kind: keyof typeof BUILDING_DEFS, cx: number, cz: number, owner = 0) {
  const b = placeBuilding(ctx.world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  b.operational = true;
  b.powered = true;
  b.watered = true;
  return b;
}

/**
 * Paint a rectangle through the paintZone command (validated at
 * enqueue, applied via the driver). Returns the rejection or null.
 */
function paintZoneCmd(
  ctx: Ctx,
  owner: number,
  zone: number,
  cx: number,
  cz: number,
  w: number,
  h: number,
): string | null {
  try {
    ctx.queue.enqueue(ctx.world, {
      kind: 'paintZone',
      issuer: 'test',
      payload: { owner, zone, x0: cx, z0: cz, x1: cx + w - 1, z1: cz + h - 1 },
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  applyQueued(ctx);
  return null;
}

function establish(ctx: Ctx, from: number, to: number, owner = 0): string | null {
  try {
    ctx.queue.enqueue(ctx.world, {
      kind: 'establishAirlineRoute',
      issuer: 'test',
      payload: { owner, from, to },
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  applyQueued(ctx);
  return null;
}

function cancelRoute(ctx: Ctx, id: number, owner = 0): string | null {
  try {
    ctx.queue.enqueue(ctx.world, {
      kind: 'cancelAirlineRoute',
      issuer: 'test',
      payload: { owner, id },
    });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  applyQueued(ctx);
  return null;
}

// ---------------------------------------------------------------------------
// The airport zone
// ---------------------------------------------------------------------------

describe('airport zone (ZoneType.AIRPORT)', () => {
  it('is the fourth zone type with value 3', () => {
    expect(ZoneType.AIRPORT).toBe(3);
  });

  it('paintZone accepts zone 3 and rejects zone 4', () => {
    const ctx = setup();
    const rect = findLandRect(ctx.terrain, 8, 8);
    expect(paintZoneCmd(ctx, 0, 3, rect.cx, rect.cz, 8, 8)).toBeNull();
    expect(paintZoneCmd(ctx, 0, 4, rect.cx, rect.cz, 8, 8)).not.toBeNull();
    // The zone-3 paint really landed (the command applied, not just validated).
    const zone = ctx.world.city.zones.find((z) => z.cell === cellIndex(rect.cx, rect.cz));
    expect(zone?.zone).toBe(ZoneType.AIRPORT);
  });

  it('airport buildings require airport zoning and name it loudly', () => {
    const ctx = setup();
    const rect = findLandRect(ctx.terrain, 12, 12);
    const w = ctx.world.city;
    // Paint residential zoning under the footprint first.
    expect(paintZoneCmd(ctx, 0, 0, rect.cx, rect.cz, 12, 12)).toBeNull();
    const problem = validatePlacement(ctx.terrain, w, {
      kind: 'civilAirport',
      owner: 0,
      cx: rect.cx,
      cz: rect.cz,
      facing: 0,
    });
    expect(problem).toMatch(/needs airport zoning/);
  });

  it('airport buildings place on airport zones; houses are rejected there', () => {
    const ctx = setup();
    const rect = findLandRect(ctx.terrain, 12, 12);
    expect(paintZoneCmd(ctx, 0, 3, rect.cx, rect.cz, 12, 12)).toBeNull();
    const w = ctx.world.city;
    expect(
      validatePlacement(ctx.terrain, w, {
        kind: 'civilAirport',
        owner: 0,
        cx: rect.cx,
        cz: rect.cz,
        facing: 0,
      }),
    ).toBeNull();
    const houseProblem = validatePlacement(ctx.terrain, w, {
      kind: 'house',
      owner: 0,
      cx: rect.cx,
      cz: rect.cz,
      facing: 0,
    });
    expect(houseProblem).not.toBeNull();
  });

  it('tryAutoDevelop never builds on airport zones', () => {
    const ctx = setup();
    const rect = findLandRect(ctx.terrain, 16, 16);
    expect(paintZoneCmd(ctx, 0, 3, rect.cx, rect.cz, 16, 16)).toBeNull();
    const airportCells = new Set<number>();
    for (let dz = 0; dz < 16; dz++) {
      for (let dx = 0; dx < 16; dx++) airportCells.add(cellIndex(rect.cx + dx, rect.cz + dz));
    }
    // runGrowth only pulses on tick % 300 === 0; drive many pulses.
    for (let s = 0; s < 20; s++) {
      ctx.world.tick = 300 * (s + 1);
      runGrowth(ctx.terrain, ctx.world, [100000], [100000]);
    }
    // No building footprint may touch the airport zoning.
    for (const b of ctx.world.city.buildings) {
      const def = BUILDING_DEFS[b.kind];
      for (let dz = 0; dz < def.footprintH; dz++) {
        for (let dx = 0; dx < def.footprintW; dx++) {
          expect(airportCells.has(cellIndex(b.cx + dx, b.cz + dz))).toBe(false);
        }
      }
    }
    // Sanity: the zone rect is still airport-zoned.
    const zone = ctx.world.city.zones.find((z) => z.cell === cellIndex(rect.cx + 2, rect.cz + 2));
    expect(zone?.zone).toBe(ZoneType.AIRPORT);
  });

  it('militaryAirbase and mixedAirport count as airfield (countsAs)', () => {
    const ctx = setup();
    const rect = findLandRect(ctx.terrain, 20, 20);
    expect(paintZoneCmd(ctx, 0, 3, rect.cx, rect.cz, 20, 20)).toBeNull();
    expect(hasProductionBuilding(ctx.world, 0, 'airfield')).toBe(false);
    completed(ctx, 'militaryAirbase', rect.cx, rect.cz);
    expect(hasProductionBuilding(ctx.world, 0, 'airfield')).toBe(true);
  });

  it('mixedAirport also satisfies the airfield production check', () => {
    const ctx = setup();
    const rect = findLandRect(ctx.terrain, 20, 20);
    expect(paintZoneCmd(ctx, 0, 3, rect.cx, rect.cz, 20, 20)).toBeNull();
    completed(ctx, 'mixedAirport', rect.cx, rect.cz);
    expect(hasProductionBuilding(ctx.world, 0, 'airfield')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The 4-tuple tax rates
// ---------------------------------------------------------------------------

describe('taxRates 4-tuple', () => {
  it('new worlds start with a 4-element taxRates', () => {
    const ctx = setup();
    for (const p of ctx.world.city.players) {
      expect(p.taxRates.length).toBe(4);
    }
  });

  it('setTaxRate accepts zone 3 (airport) and rejects zone 4', () => {
    const ctx = setup();
    let rejected3: string | null = null;
    let rejected4: string | null = null;
    try {
      ctx.queue.enqueue(ctx.world, {
        kind: 'setTaxRate',
        issuer: 'test',
        payload: { owner: 0, zone: 3, rate: 0.15 },
      });
    } catch (e) {
      rejected3 = e instanceof Error ? e.message : String(e);
    }
    try {
      ctx.queue.enqueue(ctx.world, {
        kind: 'setTaxRate',
        issuer: 'test',
        payload: { owner: 0, zone: 4, rate: 0.15 },
      });
    } catch (e) {
      rejected4 = e instanceof Error ? e.message : String(e);
    }
    expect(rejected3).toBeNull();
    applyQueued(ctx);
    expect(getPlayer(ctx.world.city, 0)?.taxRates[3]).toBeCloseTo(0.15, 6);
    expect(rejected4).not.toBeNull();
  });

  it('legacy 3-element taxRates decode element 3 to DEFAULT_TAX_RATE (no version bump)', () => {
    expect(SNAPSHOT_VERSION).toBe(8);
    const ctx = setup();
    const snap = takeSnapshot(ctx.world);
    // Simulate an older save: 3-element rates, older version.
    snap.city.players[0]!.taxRates = [0.1, 0.12, 0.08] as never;
    snap.version = 7;
    const restored = restoreSnapshot(snap);
    const rates = getPlayer(restored.city, 0)!.taxRates;
    expect(rates.length).toBe(4);
    expect(rates[0]).toBeCloseTo(0.1, 6);
    expect(rates[3]).toBe(DEFAULT_TAX_RATE);
  });

  it('airport buildings pay taxRates[3] (the airport rate flows into tax income)', () => {
    // Two identical worlds differing only in the airport rate: the only
    // funds delta after a tax tick is the airport tax.
    const mkWorld = (rate: number): Ctx => {
      const ctx = setup();
      const rect = findLandRect(ctx.terrain, 12, 12);
      const airport = completed(ctx, 'civilAirport', rect.cx, rect.cz);
      airport.level = 3;
      getPlayer(ctx.world.city, 0)!.taxRates[3] = rate;
      // Taxes run when the economy-tick index is a multiple of 60
      // (index = tick / 30): tick 1800 → index 60.
      ctx.world.tick = 1800;
      runEconomyTick(ctx.world, ctx.terrain);
      return ctx;
    };
    const low = mkWorld(0);
    const high = mkWorld(0.5);
    const lowFunds = getPlayer(low.world.city, 0)!.funds;
    const highFunds = getPlayer(high.world.city, 0)!.funds;
    expect(highFunds).toBeGreaterThan(lowFunds);
  });
});

// ---------------------------------------------------------------------------
// Airline routes
// ---------------------------------------------------------------------------

describe('airline routes', () => {
  /** Two completed civil airports for owner 0, far apart, on small zones. */
  function twoAirports(ctx: Ctx) {
    const rect = findLandRect(ctx.terrain, 40, 40);
    expect(paintZoneCmd(ctx, 0, 3, rect.cx, rect.cz, 8, 8)).toBeNull();
    expect(paintZoneCmd(ctx, 0, 3, rect.cx + 24, rect.cz + 8, 8, 8)).toBeNull();
    const a = completed(ctx, 'civilAirport', rect.cx, rect.cz);
    const b = completed(ctx, 'civilAirport', rect.cx + 24, rect.cz + 8);
    // Construction + zoning spent the starting funds; the route tests
    // are about airline mechanics, not construction economics.
    getPlayer(ctx.world.city, 0)!.funds = 10000;
    return { a, b, rect };
  }

  it('establishing a route charges the 500-fund setup cost', () => {
    expect(AIRLINE_ROUTE_SETUP_COST).toBe(500);
    const ctx = setup();
    const { a, b } = twoAirports(ctx);
    const before = getPlayer(ctx.world.city, 0)!.funds;
    expect(establish(ctx, a.id, b.id)).toBeNull();
    expect(ctx.world.city.airlineRoutes.length).toBe(1);
    // The command-only driver ran no economy systems: the delta is
    // exactly the setup cost.
    expect(getPlayer(ctx.world.city, 0)!.funds).toBeCloseTo(before - 500, 6);
  });

  it('rejects same-endpoint, non-airport, incomplete and duplicate routes', () => {
    const ctx = setup();
    const { a, b, rect } = twoAirports(ctx);
    expect(establish(ctx, a.id, a.id)).toMatch(/different airports/);
    // A military airbase is not an airline endpoint.
    const mil = completed(ctx, 'militaryAirbase', rect.cx + 32, rect.cz + 24);
    expect(establish(ctx, a.id, mil.id)).toMatch(/not a civil or mixed airport/);
    // An incomplete airport is not an endpoint.
    const inc = placeBuilding(ctx.world.city, {
      kind: 'civilAirport',
      owner: 0,
      cx: rect.cx,
      cz: rect.cz + 24,
      facing: 0,
    });
    expect(establish(ctx, a.id, inc.id)).toMatch(/not completed/);
    // The other owner's airport is not yours.
    const rival = completed(ctx, 'civilAirport', rect.cx + 12, rect.cz + 24, 1);
    expect(establish(ctx, a.id, rival.id, 0)).toMatch(/not yours/);
    // Success, then the undirected duplicate (B→A) is rejected.
    expect(establish(ctx, a.id, b.id)).toBeNull();
    expect(establish(ctx, b.id, a.id)).toMatch(/already exists/);
  });

  it('cancelAirlineRoute removes the route; rejects unknown ids and other owners', () => {
    const ctx = setup();
    const { a, b } = twoAirports(ctx);
    expect(establish(ctx, a.id, b.id)).toBeNull();
    const id = ctx.world.city.airlineRoutes[0]!.id;
    expect(cancelRoute(ctx, id, 1)).toMatch(/another player/);
    expect(cancelRoute(ctx, 999999, 0)).toMatch(/unknown route/);
    expect(cancelRoute(ctx, id, 0)).toBeNull();
    expect(ctx.world.city.airlineRoutes.length).toBe(0);
  });

  it('airlineRouteIncome is deterministic and matches the formula', () => {
    const ctx = setup();
    const { a, b } = twoAirports(ctx);
    expect(establish(ctx, a.id, b.id)).toBeNull();
    const route = ctx.world.city.airlineRoutes[0]!;
    const first = airlineRouteIncome(ctx.world, route);
    const second = airlineRouteIncome(ctx.world, route);
    expect(second).toBe(first);
    const dx = cellCenterWorld(a.cx) - cellCenterWorld(b.cx);
    const dz = cellCenterWorld(a.cz) - cellCenterWorld(b.cz);
    const distance = Math.sqrt(dx * dx + dz * dz);
    const expected = AIRLINE_BASE_INCOME_PER_SEC + distance * AIRLINE_DISTANCE_INCOME_PER_UNIT;
    expect(first).toBeCloseTo(expected, 9);
    expect(first).toBeGreaterThan(AIRLINE_BASE_INCOME_PER_SEC);
  });

  it("airlineRouteIncome scales with the owner's completed terminals", () => {
    expect(AIRLINE_PASSENGER_TERMINAL_BONUS).toBe(0.4);
    expect(AIRLINE_CARGO_TERMINAL_BONUS).toBe(0.5);
    const ctx = setup();
    const { a, b, rect } = twoAirports(ctx);
    expect(establish(ctx, a.id, b.id)).toBeNull();
    const route = ctx.world.city.airlineRoutes[0]!;
    const base = airlineRouteIncome(ctx.world, route);
    completed(ctx, 'passengerTerminal', rect.cx, rect.cz + 24);
    completed(ctx, 'cargoTerminal', rect.cx + 8, rect.cz + 24);
    const boosted = airlineRouteIncome(ctx.world, route);
    expect(boosted).toBeCloseTo(base + 0.4 + 0.5, 9);
    // The rival's terminals do not boost your route.
    completed(ctx, 'passengerTerminal', rect.cx + 16, rect.cz + 24, 1);
    expect(airlineRouteIncome(ctx.world, route)).toBeCloseTo(boosted, 9);
  });

  it('airlineRouteIncome is 0 with a dead endpoint', () => {
    const ctx = setup();
    const { a, b } = twoAirports(ctx);
    expect(establish(ctx, a.id, b.id)).toBeNull();
    const route = ctx.world.city.airlineRoutes[0]!;
    expect(airlineRouteIncome(ctx.world, route)).toBeGreaterThan(0);
    b.progress = 0; // demolished
    expect(airlineRouteIncome(ctx.world, route)).toBe(0);
  });

  it('runEconomyTick pays living routes and removes dead ones', () => {
    const ctx = setup();
    const { a, b } = twoAirports(ctx);
    expect(establish(ctx, a.id, b.id)).toBeNull();
    const route = ctx.world.city.airlineRoutes[0]!;
    const income = airlineRouteIncome(ctx.world, route);
    expect(income).toBeGreaterThan(0);
    // A living route is still there after the tick.
    ctx.world.tick += 30;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(ctx.world.city.airlineRoutes.some((r) => r.id === route.id)).toBe(true);
    // Demolish an endpoint: the route is removed at the next economy tick.
    const endpoint = ctx.world.city.buildings.find((x) => x.id === b.id)!;
    endpoint.progress = 0;
    endpoint.operational = false;
    ctx.world.tick += 30;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(ctx.world.city.airlineRoutes.some((r) => r.id === route.id)).toBe(false);
  });

  it('routes survive a v8 snapshot round trip (additive — no version bump)', () => {
    const ctx = setup();
    const { a, b } = twoAirports(ctx);
    expect(establish(ctx, a.id, b.id)).toBeNull();
    const snap = takeSnapshot(ctx.world);
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    expect(snap.city.airlineRoutes.length).toBe(1);
    const nextId = snap.city.nextAirlineRouteId;
    const restored = restoreSnapshot(snap);
    expect(restored.city.airlineRoutes.length).toBe(1);
    const route = restored.city.airlineRoutes[0]!;
    expect(route.from).toBe(a.id);
    expect(route.to).toBe(b.id);
    expect(route.owner).toBe(0);
    expect(restored.city.nextAirlineRouteId).toBe(nextId);
    // The restored route still pays.
    expect(airlineRouteIncome(restored, route)).toBeGreaterThan(0);
  });
});
