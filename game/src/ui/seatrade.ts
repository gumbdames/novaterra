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
 * NOVATERRA — ui/seatrade.ts — the UI contract for civilian sea trade
 * (grand-expansion civilian Half A, 2026-10-01).
 *
 * The Phase 5 `ui/airports.ts` precedent: a pure, headless-safe module
 * that reads the sim's sea-trade fields defensively (every read `??` /
 * optional-chained, so a world without the Half-A fields yields an
 * empty view instead of a crash) and never writes sim state. The HUD
 * sea-trade panel (Management → Trade), the harbor/ship detail
 * panels, and the sea-route click resolver all read through this
 * module — never the sim records directly.
 *
 * Sim surface used (read-only):
 * - `BuildingDef.portType` ('civilian' anchors sea routes; the
 *   military navalBase cannot).
 * - `BuildingRecord`: `kind`, `owner`, `progress`, `operational`,
 *   `fuelStock`.
 * - `UnitRecord`: `seaRouteId`, `seaRouteLeg`, `cargoFuel`,
 *   `cargoMaterials`.
 * - `CityState.seaRoutes` / `establishSeaRoute` / `cancelSeaRoute` /
 *   `assignSeaRoute` (sim/economy.ts); `seaVoyageIncome` /
 *   `isSeaTradeShip` / `runSeaTradePortCall` (sim/seaTrade.ts) — the
 *   UI shows exactly what the sim pays.
 *
 * Order contracts (ui/orders.ts builders emit these; sim/economy.ts
 * `registerEconomyCommands` validates/applies them):
 * - `establishSeaRoute`: payload `{ owner, from, to, policy }`
 *   (building ids + a SeaRoutePolicy) — both endpoints must be the
 *   owner's completed civilian ports; 500 funds setup.
 * - `cancelSeaRoute`: payload `{ owner, id }` (route id).
 * - `assignSeaRoute`: payload `{ owner, unitId, routeId }` (routeId 0
 *   = unassign).
 */

import { BUILDING_DEFS } from '../sim/city';
import type { BuildingRecord, SeaRoute, SeaRoutePolicy } from '../sim/city';
import { SEA_ROUTE_SETUP_COST, isSeaTradeShip, seaVoyageIncome } from '../sim/seaTrade';
import { UNIT_DEFS } from '../sim/units';
import type { UnitKind, UnitRecord } from '../sim/units';
import type { World } from '../sim/world';

/** Re-exported for the UI's setup-cost labels (single source of truth). */
export { SEA_ROUTE_SETUP_COST };

/** Re-exported so the HUD trains exactly the sim's route ships. */
export { isSeaTradeShip };

/**
 * Whether a building can anchor a sea route: completed, and a
 * civilian port (the military navalBase can't take trade routes —
 * the airline rule, port-side). The sim's `establishSeaRoute`
 * validation is authoritative; this is the UI's pre-check for
 * enabling the "New sea route…" button and the click resolver.
 */
export function isSeaTradeHarbor(b: BuildingRecord): boolean {
  if (b.progress < 1) return false;
  return BUILDING_DEFS[b.kind]?.portType === 'civilian';
}

/** The owner's sea routes, in establishment order. */
export function seaRoutesOf(world: World, owner: number): SeaRoute[] {
  return (world.city.seaRoutes ?? []).filter((r) => r.owner === owner);
}

/**
 * The per-voyage funds income the sim credits on a `funds`-policy
 * route's destination arrival (the exact `seaVoyageIncome`).
 */
export function seaRouteIncomeOf(world: World, route: SeaRoute): number {
  return seaVoyageIncome(world, route);
}

/** The three route policies, in the order the panel offers them. */
export const SEA_ROUTE_POLICIES: readonly SeaRoutePolicy[] = [
  'funds',
  'fuel',
  'materials',
];

/**
 * Unit kinds the player can train for sea trade: the sim's route-ship
 * predicate over the roster, in a stable order (freight first — the
 * general-purpose hull — then the fuel specialist).
 */
export function seaTradeShipKinds(): UnitKind[] {
  const kinds: UnitKind[] = [];
  for (const kind of Object.keys(UNIT_DEFS) as UnitKind[]) {
    if (isSeaTradeShip(kind)) kinds.push(kind);
  }
  // Deterministic order: cargoFreighter before fuelBarge (the def
  // order happens to be alphabetical here, but the panel must not
  // depend on that).
  kinds.sort((a, b) => {
    if (a === 'cargoFreighter') return -1;
    if (b === 'cargoFreighter') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return kinds;
}

/** The route a unit is assigned to (undefined when unassigned). */
export function seaRouteOfUnit(world: World, u: UnitRecord): SeaRoute | undefined {
  const id = u.seaRouteId ?? 0;
  if (id === 0) return undefined;
  return (world.city.seaRoutes ?? []).find((r) => r.id === id);
}

/**
 * Human-readable cargo line for a route ship's detail panel —
 * e.g. "Hold: 120/250 fuel". Empty holds read "Hold: empty" rather
 * than a row of zeroes.
 */
export function seaTradeCargoLine(u: UnitRecord): string {
  const def = UNIT_DEFS[u.kind as UnitKind];
  const parts: string[] = [];
  const fuelCap = def?.cargoFuelCapacity ?? 0;
  if (fuelCap > 0) parts.push(`${u.cargoFuel}/${fuelCap} fuel`);
  const matCap = def?.cargoMaterialsCapacity ?? 0;
  if (matCap > 0) parts.push(`${u.cargoMaterials ?? 0}/${matCap} materials`);
  if (parts.length === 0) return 'Hold: empty';
  return `Hold: ${parts.join(' · ')}`;
}
