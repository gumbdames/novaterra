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
 * NOVATERRA — shared endpoint-route lifecycle tests (roadmap B22,
 * 2026-10-02: sim/routeLifecycle.ts).
 *
 * The shared shapes (validate/apply establish + cancel, the
 * dead-endpoint sweep, the undirected duplicate check, the
 * cargo-transfer kernel) are exercised through a fake third route kind
 * ("rail freight") — proving the abstraction really does make a new
 * kind cheap. The airline/sea behavior-parity is pinned by the
 * existing suites (sim.airports.test.ts, sim.seatrade.test.ts), which
 * drive the real command specs that now run through this module.
 */
import { describe, expect, it } from 'vitest';

import {
  applyCancelRoute,
  applyEstablishRoute,
  cargoTransferAmount,
  findDuplicateRoute,
  routeEndpointsDead,
  sweepDeadRoutes,
  validateCancelRoute,
  validateEstablishRoute,
  validateRouteEndpoint,
  type EndpointRoute,
  type RouteKindHooks,
} from '../src/sim/routeLifecycle';
import { createWorld } from '../src/sim/world';
import {
  getPlayer,
  placeBuilding,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import type { World } from '../src/sim/world';

/** A fake third route kind — the "rail freight?" from the roadmap. */
interface RailRoute extends EndpointRoute {
  gauge: string;
}

function railHooks() {
  const routes: RailRoute[] = [];
  const removed: Array<{ id: number; reason: string }> = [];
  let nextId = 1;
  const hooks: RouteKindHooks<RailRoute> = {
    establishCommand: 'establishRailRoute',
    cancelCommand: 'cancelRailRoute',
    endpointNoun: 'stations',
    setupCost: 300,
    endpointKindProblem: (b: BuildingRecord, which, cmd) =>
      b.kind === 'house'
        ? null
        : `${cmd}: ${which} building #${b.id} is not a rail station`,
    routesOf: () => routes,
    setRoutes: (_city, r) => {
      routes.length = 0;
      routes.push(...r);
    },
    allocRouteId: () => nextId++,
    makeRoute: (base) => ({ ...base, gauge: 'standard' }),
    afterRemove: (_world, routeId, reason) => {
      removed.push({ id: routeId, reason });
    },
    cancelReason: 'rail route cancelled',
    sweepReason: 'rail route ended',
    getPlayer,
  };
  return { hooks, routes, removed };
}

function station(world: World, cx: number, cz: number, owner = 0): BuildingRecord {
  const b = placeBuilding(world.city, {
    kind: 'house' as BuildingKind,
    owner,
    cx,
    cz,
    facing: 0,
  });
  b.progress = 1;
  b.operational = true;
  return b;
}

function fundedWorld(): World {
  const world = createWorld(99);
  const player = getPlayer(world.city, 0);
  player!.funds = 10_000;
  return world;
}

describe('validateRouteEndpoint', () => {
  it('rejects unknown / foreign / incomplete endpoints before the kind rule', () => {
    const { hooks } = railHooks();
    const world = fundedWorld();
    expect(validateRouteEndpoint(world, 0, 4242, 'from', hooks)).toBe(
      'establishRailRoute: unknown from building #4242',
    );
    const foe = station(world, 5, 5, 1);
    expect(validateRouteEndpoint(world, 0, foe.id, 'to', hooks)).toBe(
      `establishRailRoute: to building #${foe.id} is not yours`,
    );
    const half = station(world, 6, 6, 0);
    half.progress = 0.5;
    expect(validateRouteEndpoint(world, 0, half.id, 'from', hooks)).toBe(
      `establishRailRoute: from building #${half.id} is not completed`,
    );
  });

  it('applies the kind-specific rule last', () => {
    const { hooks } = railHooks();
    const world = fundedWorld();
    const ok = station(world, 5, 5, 0);
    expect(validateRouteEndpoint(world, 0, ok.id, 'from', hooks)).toBeNull();
    const wrong = placeBuilding(world.city, {
      kind: 'farm' as BuildingKind,
      owner: 0,
      cx: 7,
      cz: 7,
      facing: 0,
    });
    wrong.progress = 1;
    wrong.operational = true;
    expect(validateRouteEndpoint(world, 0, wrong.id, 'to', hooks)).toBe(
      `establishRailRoute: to building #${wrong.id} is not a rail station`,
    );
  });
});

describe('routeEndpointsDead', () => {
  it('detects missing / incomplete / non-operational endpoints', () => {
    const world = fundedWorld();
    const a = station(world, 5, 5, 0);
    const b = station(world, 50, 50, 0);
    const route: EndpointRoute = { id: 1, owner: 0, from: a.id, to: b.id, establishedTick: 0 };
    expect(routeEndpointsDead(world, route)).toBe(false);
    b.progress = 0.5;
    expect(routeEndpointsDead(world, route)).toBe(true);
    b.progress = 1;
    b.operational = false;
    expect(routeEndpointsDead(world, route)).toBe(true);
    b.operational = true;
    expect(
      routeEndpointsDead(world, { ...route, to: 99999 }),
    ).toBe(true);
  });
});

describe('findDuplicateRoute', () => {
  it('treats routes as undirected and owner-scoped', () => {
    const routes: EndpointRoute[] = [
      { id: 1, owner: 0, from: 10, to: 20, establishedTick: 0 },
      { id: 2, owner: 1, from: 10, to: 20, establishedTick: 0 },
    ];
    expect(findDuplicateRoute(routes, 0, 20, 10)?.id).toBe(1);
    expect(findDuplicateRoute(routes, 0, 10, 30)).toBeUndefined();
    expect(findDuplicateRoute(routes, 1, 20, 10)?.id).toBe(2);
  });
});

describe('establish lifecycle', () => {
  it('validates owner, ids, distinctness, endpoints, duplicates, funds — in order', () => {
    const { hooks } = railHooks();
    const world = fundedWorld();
    expect(
      validateEstablishRoute(world, { owner: 99, from: 1, to: 2 }, hooks),
    ).toBe('establishRailRoute: unknown owner');
    expect(
      validateEstablishRoute(world, { owner: 0, from: 'x', to: 2 }, hooks),
    ).toBe('establishRailRoute: from/to must be building ids');
    const a = station(world, 5, 5, 0);
    expect(
      validateEstablishRoute(world, { owner: 0, from: a.id, to: a.id }, hooks),
    ).toBe('establishRailRoute: from and to must be different stations');
    expect(
      validateEstablishRoute(world, { owner: 0, from: a.id, to: 99999 }, hooks),
    ).toBe('establishRailRoute: unknown to building #99999');
    const b = station(world, 50, 50, 0);
    expect(
      validateEstablishRoute(world, { owner: 0, from: a.id, to: b.id }, hooks),
    ).toBeNull();
  });

  it('rejects duplicates and unaffordable routes', () => {
    const { hooks, routes } = railHooks();
    const world = fundedWorld();
    const a = station(world, 5, 5, 0);
    const b = station(world, 50, 50, 0);
    routes.push({ id: 1, owner: 0, from: a.id, to: b.id, establishedTick: 0, gauge: 'standard' });
    expect(
      validateEstablishRoute(world, { owner: 0, from: b.id, to: a.id }, hooks),
    ).toBe('establishRailRoute: route already exists');
    const c = station(world, 60, 60, 0);
    getPlayer(world.city, 0)!.funds = 10;
    expect(
      validateEstablishRoute(world, { owner: 0, from: a.id, to: c.id }, hooks),
    ).toBe('establishRailRoute: cannot afford 300 funds setup');
  });

  it('apply deducts the setup cost and records the route', () => {
    const { hooks, routes } = railHooks();
    const world = fundedWorld();
    world.tick = 77;
    const a = station(world, 5, 5, 0);
    const b = station(world, 50, 50, 0);
    const before = getPlayer(world.city, 0)!.funds;
    const route = applyEstablishRoute(
      world,
      { owner: 0, from: a.id, to: b.id },
      hooks,
    );
    expect(route).toMatchObject({
      id: 1,
      owner: 0,
      from: a.id,
      to: b.id,
      establishedTick: 77,
      gauge: 'standard',
    });
    expect(routes).toHaveLength(1);
    expect(getPlayer(world.city, 0)!.funds).toBe(before - 300);
  });
});

describe('cancel lifecycle', () => {
  it('validates and removes, releasing attachments with the cancel reason', () => {
    const { hooks, routes, removed } = railHooks();
    const world = fundedWorld();
    routes.push(
      { id: 1, owner: 0, from: 10, to: 20, establishedTick: 0, gauge: 'standard' },
      { id: 2, owner: 1, from: 30, to: 40, establishedTick: 0, gauge: 'standard' },
    );
    expect(validateCancelRoute(world, { owner: 0, id: 99 }, hooks)).toBe(
      'cancelRailRoute: unknown route',
    );
    expect(validateCancelRoute(world, { owner: 0, id: 2 }, hooks)).toBe(
      'cancelRailRoute: route belongs to another player',
    );
    expect(validateCancelRoute(world, { owner: 0, id: 1 }, hooks)).toBeNull();
    expect(applyCancelRoute(world, { owner: 0, id: 1 }, hooks)).toEqual({ id: 1 });
    expect(routes.map((r) => r.id)).toEqual([2]);
    expect(removed).toEqual([{ id: 1, reason: 'rail route cancelled' }]);
  });
});

describe('sweepDeadRoutes', () => {
  it('removes endpoint-dead routes in id order, releasing attachments', () => {
    const { hooks, routes, removed } = railHooks();
    const world = fundedWorld();
    const a = station(world, 5, 5, 0);
    const b = station(world, 50, 50, 0);
    const c = station(world, 60, 60, 0);
    // id 2 first in the list on purpose — removal order must still be id order.
    routes.push(
      { id: 2, owner: 0, from: a.id, to: c.id, establishedTick: 0, gauge: 'standard' },
      { id: 1, owner: 0, from: a.id, to: b.id, establishedTick: 0, gauge: 'standard' },
    );
    b.operational = false; // kills route 1
    c.progress = 0.2; // kills route 2
    expect(sweepDeadRoutes(world, hooks)).toEqual([1, 2]);
    expect(routes).toHaveLength(0);
    expect(removed).toEqual([
      { id: 1, reason: 'rail route ended' },
      { id: 2, reason: 'rail route ended' },
    ]);
  });

  it('is a no-op with no routes or no dead routes', () => {
    const { hooks, routes } = railHooks();
    const world = fundedWorld();
    expect(sweepDeadRoutes(world, hooks)).toEqual([]);
    const a = station(world, 5, 5, 0);
    const b = station(world, 50, 50, 0);
    routes.push({ id: 1, owner: 0, from: a.id, to: b.id, establishedTick: 0, gauge: 'standard' });
    expect(sweepDeadRoutes(world, hooks)).toEqual([]);
    expect(routes).toHaveLength(1);
  });
});

describe('cargoTransferAmount', () => {
  it('caps on both sides and never goes negative', () => {
    expect(cargoTransferAmount(10, 4)).toBe(4);
    expect(cargoTransferAmount(4, 10)).toBe(4);
    expect(cargoTransferAmount(0, 10)).toBe(0);
    expect(cargoTransferAmount(-5, 10)).toBe(0);
    expect(cargoTransferAmount(10, -5)).toBe(0);
  });
});
