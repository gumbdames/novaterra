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
 * NOVATERRA — airport UI contract tests (grand-expansion Phase 5,
 * workstream A, S5+S8, 2026-09-30).
 *
 * `ui/airports.ts` is pure and headless-safe: it reads sim records
 * defensively and never writes sim state. These tests pin:
 *  - `airportDisplayType`: the owner sees the truth (mixed → mixed);
 *    everyone else sees mixed → civilian (the Phase 7 intel hook sits
 *    on this function's signature); non-anchors → undefined.
 *  - `servedAircraftClasses`: runway S/M/L serve light / light+medium /
 *    all.
 *  - `isAirlineEndpoint`: completed civil/mixed only (no military, no
 *    incomplete, no terminals).
 *  - `resolveAirlineClick`: the two-click gesture (arm → order,
 *    re-click armed → disarm, wrong targets → hints).
 *  - `airportOverlayData` / `airportOverlayDigest`: the pure view the
 *    airport overlay renders, and its rebuild key (stable on identical
 *    input, moves on any change).
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { BUILDING_DEFS, placeBuilding, cellCenterWorld, type BuildingRecord } from '../src/sim/city';
import type { World } from '../src/sim/world';
import {
  airportDisplayType,
  airportOverlayData,
  airportOverlayDigest,
  airlineRoutesOf,
  isAirlineEndpoint,
  servedAircraftClasses,
} from '../src/ui/airports';
import { resolveAirlineClick } from '../src/ui/placement';

function airportWorld(): World {
  const world = createWorld(20260930);
  return world;
}

function addBuilding(
  world: World,
  kind: keyof typeof BUILDING_DEFS,
  owner: number,
  cx: number,
  cz: number,
  progress = 1,
): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = progress;
  b.operational = progress >= 1;
  return b;
}

describe('airportDisplayType', () => {
  it('shows the owner the truth, rivals see mixed as civilian', () => {
    const world = airportWorld();
    const mixed = addBuilding(world, 'mixedAirport', 0, 10, 10);
    expect(airportDisplayType(mixed, 0)).toBe('mixed');
    expect(airportDisplayType(mixed, 1)).toBe('civilian');
    const civil = addBuilding(world, 'civilAirport', 0, 20, 20);
    expect(airportDisplayType(civil, 0)).toBe('civilian');
    expect(airportDisplayType(civil, 1)).toBe('civilian');
    const mil = addBuilding(world, 'militaryAirbase', 0, 30, 30);
    expect(airportDisplayType(mil, 0)).toBe('military');
    expect(airportDisplayType(mil, 1)).toBe('military');
  });

  it('is undefined for non-anchor buildings', () => {
    const world = airportWorld();
    const terminal = addBuilding(world, 'passengerTerminal', 0, 10, 10);
    expect(airportDisplayType(terminal, 0)).toBeUndefined();
    const house = addBuilding(world, 'house', 0, 20, 20);
    expect(airportDisplayType(house, 0)).toBeUndefined();
  });
});

describe('servedAircraftClasses', () => {
  it('runway light serves light, medium serves light+medium, heavy serves all', () => {
    expect(servedAircraftClasses('light')).toEqual(['light']);
    expect(servedAircraftClasses('medium')).toEqual(['light', 'medium']);
    expect(servedAircraftClasses('heavy')).toEqual(['light', 'medium', 'heavy']);
  });
});

describe('isAirlineEndpoint', () => {
  it('accepts completed civil/mixed, rejects military, incomplete and terminals', () => {
    const world = airportWorld();
    expect(isAirlineEndpoint(addBuilding(world, 'civilAirport', 0, 10, 10))).toBe(true);
    expect(isAirlineEndpoint(addBuilding(world, 'mixedAirport', 0, 20, 20))).toBe(true);
    expect(isAirlineEndpoint(addBuilding(world, 'militaryAirbase', 0, 30, 30))).toBe(false);
    expect(isAirlineEndpoint(addBuilding(world, 'civilAirport', 0, 40, 40, 0.5))).toBe(false);
    expect(isAirlineEndpoint(addBuilding(world, 'passengerTerminal', 0, 50, 50))).toBe(false);
  });
});

describe('resolveAirlineClick', () => {
  it('arms on first airport click, orders on a different endpoint, disarms on re-click', () => {
    const world = airportWorld();
    const a = addBuilding(world, 'civilAirport', 0, 10, 10);
    const b = addBuilding(world, 'mixedAirport', 0, 30, 30);
    const arm = resolveAirlineClick(0, null, a);
    expect(arm.kind).toBe('arm');
    if (arm.kind === 'arm') expect(arm.id).toBe(a.id);
    const order = resolveAirlineClick(0, a.id, b);
    expect(order.kind).toBe('order');
    if (order.kind === 'order') {
      expect(order.intent.kind).toBe('establishAirlineRoute');
    }
    const disarm = resolveAirlineClick(0, a.id, a);
    expect(disarm.kind).toBe('disarm');
  });

  it('hints on misses, wrong owners and non-endpoints', () => {
    const world = airportWorld();
    const a = addBuilding(world, 'civilAirport', 0, 10, 10);
    const rival = addBuilding(world, 'civilAirport', 1, 30, 30);
    const mil = addBuilding(world, 'militaryAirbase', 0, 40, 40);
    expect(resolveAirlineClick(0, null, null).kind).toBe('hint');
    expect(resolveAirlineClick(0, a.id, null).kind).toBe('hint');
    expect(resolveAirlineClick(0, null, rival).kind).toBe('hint');
    expect(resolveAirlineClick(0, a.id, mil).kind).toBe('hint');
    // Clicking the armed airport's partner onto itself is not an order.
    expect(resolveAirlineClick(0, a.id, a).kind).toBe('disarm');
  });
});

describe('airportOverlayData / airportOverlayDigest', () => {
  it('lists completed anchors with display types and routes', () => {
    const world = airportWorld();
    const a = addBuilding(world, 'civilAirport', 0, 10, 10);
    const m = addBuilding(world, 'mixedAirport', 1, 30, 30);
    addBuilding(world, 'militaryAirbase', 0, 50, 50, 0.3); // incomplete → skipped
    world.city.airlineRoutes.push({
      id: 1,
      owner: 0,
      from: a.id,
      to: a.id,
      establishedTick: 0,
    });
    const data = airportOverlayData(world, 1);
    expect(data.airports.length).toBe(2);
    const byId = new Map(data.airports.map((x) => [x.id, x]));
    expect(byId.get(a.id)!.display).toBe('civilian');
    expect(byId.get(m.id)!.display).toBe('mixed'); // viewer 1 owns m: truth
    expect(byId.get(a.id)!.x).toBe(cellCenterWorld(a.cx));
    expect(byId.get(a.id)!.radius).toBeGreaterThan(0);
    expect(data.routes.length).toBe(1);
    expect(data.routes[0]!.id).toBe(1);
    // The rival (viewer 0) sees the mixed airport as civilian.
    const rivalView = airportOverlayData(world, 0);
    expect(rivalView.airports.find((x) => x.id === m.id)!.display).toBe('civilian');
    expect(rivalView.airports.find((x) => x.id === a.id)!.display).toBe('civilian');
  });

  it('is empty pre-sim and never throws on sparse worlds', () => {
    const world = createWorld(7);
    const data = airportOverlayData(world, 0);
    expect(data.airports).toEqual([]);
    expect(data.routes).toEqual([]);
    expect(airportOverlayDigest(data)).toBe(airportOverlayDigest({ airports: [], routes: [] }));
  });

  it('digest is stable on identical input and moves on any change', () => {
    const world = airportWorld();
    const a = addBuilding(world, 'civilAirport', 0, 10, 10);
    const d1 = airportOverlayDigest(airportOverlayData(world, 0));
    expect(airportOverlayDigest(airportOverlayData(world, 0))).toBe(d1);
    addBuilding(world, 'militaryAirbase', 0, 30, 30);
    expect(airportOverlayDigest(airportOverlayData(world, 0))).not.toBe(d1);
    // A new route also moves the digest.
    const d2 = airportOverlayDigest(airportOverlayData(world, 0));
    world.city.airlineRoutes.push({ id: 1, owner: 0, from: a.id, to: a.id, establishedTick: 0 });
    expect(airportOverlayDigest(airportOverlayData(world, 0))).not.toBe(d2);
  });

  it('skips routes whose endpoints vanished (defensive)', () => {
    const world = airportWorld();
    world.city.airlineRoutes.push({ id: 1, owner: 0, from: 424242, to: 434343, establishedTick: 0 });
    expect(airportOverlayData(world, 0).routes).toEqual([]);
  });
});

describe('airlineRoutesOf', () => {
  it('returns only the owner\'s routes', () => {
    const world = airportWorld();
    world.city.airlineRoutes.push(
      { id: 1, owner: 0, from: 1, to: 2, establishedTick: 0 },
      { id: 2, owner: 1, from: 3, to: 4, establishedTick: 0 },
    );
    expect(airlineRoutesOf(world, 0).map((r) => r.id)).toEqual([1]);
    expect(airlineRoutesOf(world, 1).map((r) => r.id)).toEqual([2]);
  });
});
