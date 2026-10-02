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
 * NOVATERRA — sim/routeLifecycle.ts — the shared endpoint-route
 * abstraction (roadmap B22, 2026-10-02).
 *
 * Airline routes and sea-trade routes grew as three near-parallel
 * implementations: the dead-route sweep (`runAirlineIncome` vs
 * `runSeaRouteCleanup`), the endpoint validators
 * (`airlineEndpointProblem` vs `seaRouteEndpointProblem`), and the
 * establish/cancel command specs. This module holds the shared shapes
 * so the two implementations cannot drift.
 *
 * The abstraction: an **endpoint route** is `{id, owner, from, to,
 * establishedTick}` — two owned, completed endpoint buildings — with a
 * per-kind hooks object specializing:
 *  - the kind-specific endpoint rule (civil/mixed airport vs trade dock),
 *  - the route list + id counter it lives in,
 *  - per-kind extras (sea: the cargo policy; sea: assigned ships),
 *  - per-kind economics (airline per-second income vs sea per-voyage
 *    port calls — those stay in economy.ts / seaTrade.ts; only the
 *    lifecycle is shared).
 *
 * A third route kind (rail freight?) needs only a record type extending
 * `EndpointRoute` plus a hooks object — establish, cancel, duplicate
 * suppression, and the dead-endpoint sweep come free.
 *
 * Also home to `cargoTransferAmount`, the shared cargo-transfer kernel
 * (B22): the load/unload commands (commands.ts), the AI virtual loads,
 * and the sea-trade port calls (seaTrade.ts) all move "up to need from
 * available stock, capped on both sides, never negative" — one
 * function, three call sites, no drift.
 *
 * Import discipline: type-imports only (`./city`, `./world`) — the
 * player lookup is injected through `RouteKindHooks.getPlayer`, so this
 * module opens no value edges and can never join a module cycle.
 */

import type { BuildingRecord, CityState, PlayerState } from './city';
import type { World } from './world';

/** The shared endpoint-route record (airline + sea; rail freight later). */
export interface EndpointRoute {
  /** Route id (the kind's next-id counter, assigned at establishment). */
  id: number;
  /** Route owner (pays the setup cost, collects the income). */
  owner: number;
  /** Origin endpoint building id. */
  from: number;
  /** Destination endpoint building id. */
  to: number;
  /** Sim tick when the route was established. */
  establishedTick: number;
}

/**
 * Per-kind hooks specializing the shared lifecycle. All validation
 * errors are prefixed with the command name, exactly as the old
 * per-kind validators wrote them.
 */
export interface RouteKindHooks<R extends EndpointRoute> {
  /** 'establishAirlineRoute' — prefixes establish validation errors. */
  establishCommand: string;
  /** 'cancelAirlineRoute' — prefixes cancel validation errors. */
  cancelCommand: string;
  /** Human noun for the distinct-endpoints error ('airports'/'docks'). */
  endpointNoun: string;
  /** Funds charged at establishment. */
  setupCost: number;
  /**
   * The kind-specific endpoint rule, checked AFTER the shared
   * unknown / not-yours / not-completed checks. Receives the resolved
   * building so hooks never re-scan; return null when the endpoint is
   * legal for this kind.
   */
  endpointKindProblem: (
    building: BuildingRecord,
    which: 'from' | 'to',
    command: string,
  ) => string | null;
  /** Read the kind's route list from the city. */
  routesOf: (city: CityState) => R[];
  /** Replace the kind's route list (after removals). */
  setRoutes: (city: CityState, routes: R[]) => void;
  /** Allocate the next route id (bumps the kind's counter). */
  allocRouteId: (city: CityState) => number;
  /**
   * Build the full route record from the validated establish payload.
   * Carries per-kind extras (sea: the cargo policy).
   */
  makeRoute: (base: EndpointRoute, payload: Record<string, unknown>) => R;
  /**
   * Extra establish-time validation (sea: the cargo policy). Runs
   * before the endpoint checks, exactly where the old per-kind spec
   * ran it. Return an error string or null.
   */
  extraValidate?: (payload: Record<string, unknown>) => string | null;
  /**
   * After a route is removed (cancel or dead sweep): release per-kind
   * attachments (sea: unassign ships, stamping `reason` loudly).
   * Optional — airlines have no attachments.
   */
  afterRemove?: (world: World, routeId: number, reason: string) => void;
  /** `reason` passed to afterRemove on cancel (sea: 'sea route cancelled'). */
  cancelReason: string;
  /** `reason` passed to afterRemove on dead sweep (sea: 'sea route ended'). */
  sweepReason: string;
  /**
   * Player lookup, injected so this module keeps type-only imports
   * (never joins a module cycle). The sim's `getPlayer`.
   */
  getPlayer: (city: CityState, owner: number) => PlayerState | undefined;
}

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/**
 * Shared endpoint validation: unknown building → not yours → not
 * completed → the kind-specific rule. Exactly the old per-kind
 * validator shape, with the kind rule injected.
 */
export function validateRouteEndpoint<R extends EndpointRoute>(
  world: World,
  owner: number,
  id: number,
  which: 'from' | 'to',
  hooks: RouteKindHooks<R>,
): string | null {
  const cmd = hooks.establishCommand;
  const b = world.city.buildings.find((x) => x.id === id);
  if (!b) return `${cmd}: unknown ${which} building #${id}`;
  if (b.owner !== owner) return `${cmd}: ${which} building #${id} is not yours`;
  if ((b.progress ?? 1) < 1) return `${cmd}: ${which} building #${id} is not completed`;
  return hooks.endpointKindProblem(b, which, cmd);
}

/**
 * True when either endpoint is dead: missing, incomplete, or
 * non-operational. The exact predicate both sweeps shared.
 */
export function routeEndpointsDead(world: World, route: EndpointRoute): boolean {
  const city = world.city;
  const from = city.buildings.find((b) => b.id === route.from);
  const to = city.buildings.find((b) => b.id === route.to);
  return (
    !from ||
    !to ||
    (from.progress ?? 1) < 1 ||
    !from.operational ||
    (to.progress ?? 1) < 1 ||
    !to.operational
  );
}

/**
 * Undirected duplicate check (A↔B == B↔A), owner's routes only.
 * Returns the duplicate, if any.
 */
export function findDuplicateRoute<R extends EndpointRoute>(
  routes: R[],
  owner: number,
  from: number,
  to: number,
): R | undefined {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  return routes.find(
    (r) => r.owner === owner && Math.min(r.from, r.to) === a && Math.max(r.from, r.to) === b,
  );
}

/**
 * Shared establish validation: owner → ids → distinct → per-kind
 * extras → endpoint problems → undirected duplicate → affordability.
 * Returns null when the route may be established.
 */
export function validateEstablishRoute<R extends EndpointRoute>(
  world: World,
  payload: Record<string, unknown>,
  hooks: RouteKindHooks<R>,
): string | null {
  const cmd = hooks.establishCommand;
  const city = world.city;
  const owner = payloadInt(payload, 'owner');
  if (owner === null || !hooks.getPlayer(city, owner)) {
    return `${cmd}: unknown owner`;
  }
  const from = payloadInt(payload, 'from');
  const to = payloadInt(payload, 'to');
  if (from === null || to === null) {
    return `${cmd}: from/to must be building ids`;
  }
  if (from === to) {
    return `${cmd}: from and to must be different ${hooks.endpointNoun}`;
  }
  if (hooks.extraValidate) {
    const problem = hooks.extraValidate(payload);
    if (problem) return problem;
  }
  const problem =
    validateRouteEndpoint(world, owner, from, 'from', hooks) ??
    validateRouteEndpoint(world, owner, to, 'to', hooks);
  if (problem) return problem;
  // Routes are undirected for duplication (A↔B == B↔A).
  if (findDuplicateRoute(hooks.routesOf(city), owner, from, to)) {
    return `${cmd}: route already exists`;
  }
  const player = hooks.getPlayer(city, owner);
  if (player && player.funds < hooks.setupCost) {
    return `${cmd}: cannot afford ${hooks.setupCost} funds setup`;
  }
  return null;
}

/**
 * Shared establish apply: deduct the setup cost, push the route with
 * the kind's next id. Returns the new record (the spec maps it to the
 * legacy result shape).
 */
export function applyEstablishRoute<R extends EndpointRoute>(
  world: World,
  payload: Record<string, unknown>,
  hooks: RouteKindHooks<R>,
): R {
  const city = world.city;
  const owner = payloadInt(payload, 'owner') as number;
  const from = payloadInt(payload, 'from') as number;
  const to = payloadInt(payload, 'to') as number;
  const player = hooks.getPlayer(city, owner);
  if (player) player.funds -= hooks.setupCost;
  const route = hooks.makeRoute(
    {
      id: hooks.allocRouteId(city),
      owner,
      from,
      to,
      establishedTick: world.tick,
    },
    payload,
  );
  hooks.routesOf(city).push(route);
  return route;
}

/**
 * Shared cancel validation: owner → route exists → owned by the caller.
 */
export function validateCancelRoute<R extends EndpointRoute>(
  world: World,
  payload: Record<string, unknown>,
  hooks: RouteKindHooks<R>,
): string | null {
  const cmd = hooks.cancelCommand;
  const owner = payloadInt(payload, 'owner');
  if (owner === null || !hooks.getPlayer(world.city, owner)) {
    return `${cmd}: unknown owner`;
  }
  const id = payloadInt(payload, 'id');
  const route = hooks.routesOf(world.city).find((r) => r.id === id);
  if (!route) return `${cmd}: unknown route`;
  if (route.owner !== owner) return `${cmd}: route belongs to another player`;
  return null;
}

/**
 * Shared cancel apply: remove the route, then release per-kind
 * attachments (sea: ships unassigned with the cancel reason).
 * Returns the legacy `{ id }` result.
 */
export function applyCancelRoute<R extends EndpointRoute>(
  world: World,
  payload: Record<string, unknown>,
  hooks: RouteKindHooks<R>,
): { id: number } {
  const id = payloadInt(payload, 'id') as number;
  const city = world.city;
  hooks.setRoutes(
    city,
    hooks.routesOf(city).filter((r) => r.id !== id),
  );
  hooks.afterRemove?.(world, id, hooks.cancelReason);
  return { id };
}

/**
 * Shared dead-route sweep: remove every route with a dead endpoint
 * (missing, incomplete, or non-operational building), then release
 * per-kind attachments in id order. Deterministic: id order, no RNG.
 * Returns the removed route ids, sorted.
 */
export function sweepDeadRoutes<R extends EndpointRoute>(
  world: World,
  hooks: RouteKindHooks<R>,
): number[] {
  const city = world.city;
  const routes = hooks.routesOf(city);
  if (routes.length === 0) return [];
  const dead = routes.filter((r) => routeEndpointsDead(world, r));
  if (dead.length === 0) return [];
  const deadIds = new Set(dead.map((r) => r.id));
  hooks.setRoutes(
    city,
    routes.filter((r) => !deadIds.has(r.id)),
  );
  const sorted = [...deadIds].sort((a, b) => a - b);
  for (const id of sorted) {
    hooks.afterRemove?.(world, id, hooks.sweepReason);
  }
  return sorted;
}

/**
 * The shared cargo-transfer kernel (B22): move up to `need` units from
 * `available` stock. Capped on both sides, never negative. The
 * load/unload commands (commands.ts), the AI virtual loads, and the
 * sea-trade port calls (seaTrade.ts) all share these economics — each
 * site supplies its own need/available from its own stock fields, and
 * applies the returned amount to its own records.
 */
export function cargoTransferAmount(need: number, available: number): number {
  return Math.max(0, Math.min(need, available));
}
