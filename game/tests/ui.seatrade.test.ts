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
 * NOVATERRA — ui/seatrade.ts tests (roadmap B24).
 *
 * seatrade.ts is the UI's read-only view over the sim's sea-trade model:
 * which buildings can anchor a route, which routes belong to the player,
 * which unit kinds are route ships, and the cargo line for the detail
 * panel. These tests pin the UI pre-checks against the sim's defs so a
 * UI/sim drift (e.g. the panel offering a harbor the sim would reject)
 * fails loudly.
 */
import { describe, expect, it } from 'vitest';

import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import type { BuildingKind, BuildingRecord, SeaRoute } from '../src/sim/city';
import type { UnitKind, UnitRecord } from '../src/sim/units';
import { seaVoyageIncome } from '../src/sim/seaTrade';
import {
  SEA_ROUTE_POLICIES,
  SEA_ROUTE_SETUP_COST,
  isSeaTradeHarbor,
  isSeaTradeShip,
  seaRouteIncomeOf,
  seaRouteOfUnit,
  seaRoutesOf,
  seaTradeCargoLine,
  seaTradeShipKinds,
} from '../src/ui/seatrade';

function makeBuilding(kind: BuildingKind, owner: number, progress: number): BuildingRecord {
  return {
    id: 0,
    kind,
    owner,
    cx: 64,
    cz: 64,
    facing: 0,
    progress,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  } as BuildingRecord;
}

function makeUnit(kind: UnitKind, seaRouteId?: number): UnitRecord {
  return {
    id: 1,
    kind,
    owner: 0,
    x: 0,
    z: 0,
    hp: 100,
    seaRouteId,
  } as UnitRecord;
}

describe('isSeaTradeHarbor', () => {
  it('accepts a completed trade dock', () => {
    expect(isSeaTradeHarbor(makeBuilding('commercialPort', 0, 1))).toBe(true);
    expect(isSeaTradeHarbor(makeBuilding('containerPort', 0, 1))).toBe(true);
  });

  it('rejects a building still under construction', () => {
    expect(isSeaTradeHarbor(makeBuilding('commercialPort', 0, 0.5))).toBe(false);
  });

  it('rejects non-trade-dock buildings even when completed', () => {
    expect(isSeaTradeHarbor(makeBuilding('house', 0, 1))).toBe(false);
    expect(isSeaTradeHarbor(makeBuilding('commercialHarbor', 0, 1))).toBe(false);
  });
});

describe('seaRoutesOf / seaRouteOfUnit', () => {
  function worldWithRoutes(): World {
    const world = createWorld(4242);
    world.city.seaRoutes = [
      { id: 1, owner: 0, from: 10, to: 11, policy: 'funds', establishedTick: 0 } as SeaRoute,
      { id: 2, owner: 1, from: 20, to: 21, policy: 'fuel', establishedTick: 0 } as SeaRoute,
      { id: 3, owner: 0, from: 12, to: 13, policy: 'materials', establishedTick: 0 } as SeaRoute,
    ];
    return world;
  }

  it('returns only the owner routes, in establishment order', () => {
    const ids = seaRoutesOf(worldWithRoutes(), 0).map((r) => r.id);
    expect(ids).toEqual([1, 3]);
  });

  it('returns an empty array for an owner with no routes', () => {
    expect(seaRoutesOf(worldWithRoutes(), 7)).toEqual([]);
  });

  it("finds the route a unit is assigned to, undefined when it's unassigned", () => {
    const world = worldWithRoutes();
    expect(seaRouteOfUnit(world, makeUnit('cargoFreighter', 3))?.id).toBe(3);
    expect(seaRouteOfUnit(world, makeUnit('cargoFreighter'))).toBeUndefined();
    expect(seaRouteOfUnit(world, makeUnit('cargoFreighter', 999))).toBeUndefined();
  });
});

describe('seaRouteIncomeOf', () => {
  it("matches the sim's seaVoyageIncome exactly", () => {
    const world = createWorld(4242);
    const a = makeBuilding('commercialPort', 0, 1);
    a.id = 10;
    a.cx = 60;
    a.cz = 64;
    const b = makeBuilding('containerPort', 0, 1);
    b.id = 11;
    b.cx = 100;
    b.cz = 64;
    world.city.buildings.push(a, b);
    const route = { id: 1, owner: 0, from: 10, to: 11, policy: 'funds', establishedTick: 0 } as SeaRoute;
    expect(seaRouteIncomeOf(world, route)).toBe(seaVoyageIncome(world, route));
    expect(seaRouteIncomeOf(world, route)).toBeGreaterThan(0);
  });
});

describe('route ships', () => {
  it('re-exports the sim setup cost and ship predicate', () => {
    expect(SEA_ROUTE_SETUP_COST).toBeGreaterThan(0);
    expect(isSeaTradeShip('cargoFreighter')).toBe(true);
    expect(isSeaTradeShip('tank')).toBe(false);
  });

  it('offers exactly the three route policies in panel order', () => {
    expect([...SEA_ROUTE_POLICIES]).toEqual(['funds', 'fuel', 'materials']);
  });

  it('lists the cargo hulls with the freighter first', () => {
    const kinds = seaTradeShipKinds();
    expect(kinds[0]).toBe('cargoFreighter');
    expect(kinds).toContain('fuelBarge');
    // Passenger hulls (liner/yacht) are not route ships.
    expect(kinds).not.toContain('cruiseLiner');
    expect(kinds).not.toContain('yacht');
  });
});

describe('seaTradeCargoLine', () => {
  it('reads "Hold: empty" for an empty hold', () => {
    expect(seaTradeCargoLine(makeUnit('cargoFreighter'))).toBe('Hold: empty');
  });

  it('shows fuel and materials against their capacities', () => {
    const fuelShip = makeUnit('fuelBarge');
    fuelShip.cargoFuel = 120;
    expect(seaTradeCargoLine(fuelShip)).toBe('Hold: 120/250 fuel');
    const matShip = makeUnit('cargoFreighter');
    matShip.cargoMaterials = 40;
    expect(seaTradeCargoLine(matShip)).toBe('Hold: 40/200 materials');
  });
});
