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
 * NOVATERRA — ui/airports.ts — the UI/render contract for grand-expansion
 * Phase 5 airports + airlines (0.1 Alpha).
 *
 * The Phase 2 `ui/utilities.ts` / Phase 3 `ui/logistics.ts` precedent: a
 * pure, headless-safe module that reads the sim's airport fields
 * defensively (every read `??` / optional-chained, so a world without the
 * Phase 5 fields yields an empty view instead of a crash) and never
 * writes sim state. The HUD airline panel, the airport overlay
 * (`render/airportOverlay.ts`), and the airliner provider
 * (`render/airlineProviders.ts`) all read through this module — never the
 * sim records directly.
 *
 * Sim surface used (read-only):
 * - `BuildingDef`: `zone` (=== ZoneType.AIRPORT), `airportType`,
 *   `hangarClass`, `hangarCapacity`, `runwayClass`.
 * - `BuildingRecord`: `kind`, `owner`, `cx`, `cz`, `progress`,
 *   `operational`, `discovery` (the Phase 7 mixed-airport discovery
 *   records — `discoveryStateOf` is the panel's read seam).
 * - `UnitDef`: `hangarClass` (the aircraft workstream assigns these;
 *   unassigned ⇒ undefined ⇒ "unclassified" in the UI).
 * - `CityState.airlineRoutes` / `establishAirlineRoute` /
 *   `cancelAirlineRoute` (sim/economy.ts); `airlineRouteIncome`
 *   (sim/economy.ts) — the UI shows exactly what the sim pays.
 *
 * Order contracts (ui/orders.ts builders emit these; sim/economy.ts
 * `registerEconomyCommands` validates/applies them):
 * - `establishAirlineRoute`: payload `{ owner, from, to }` (building
 *   ids) — both endpoints must be the owner's completed civil/mixed
 *   airports; 500 funds setup.
 * - `cancelAirlineRoute`: payload `{ owner, id }` (route id).
 */

import { BUILDING_DEFS, ZoneType, cellCenterWorld } from '../sim/city';
import type {
  AircraftClass,
  AirportDiscoveryState,
  BuildingKind,
  BuildingRecord,
} from '../sim/city';
import { AIRLINE_ROUTE_SETUP_COST, airlineRouteIncome } from '../sim/economy';
import { UNIT_DEFS } from '../sim/units';
import type { UnitKind } from '../sim/units';
import type { World } from '../sim/world';

// ---------------------------------------------------------------------------
// Roster (derived from the sim defs — never hand-maintained)
// ---------------------------------------------------------------------------

/**
 * Every building kind the sim zones for airports — derived from
 * `BUILDING_DEFS` (zone === ZoneType.AIRPORT), in def order.
 */
export const AIRPORT_BUILDING_KINDS: readonly BuildingKind[] = (
  Object.keys(BUILDING_DEFS) as BuildingKind[]
).filter((k) => BUILDING_DEFS[k].zone === ZoneType.AIRPORT);

/**
 * The three site anchors (defs with an `airportType`) — the big
 * placeable airports. Terminals/tower/hangars/runways are build-out
 * pieces, not anchors.
 */
export const AIRPORT_ANCHOR_KINDS: readonly BuildingKind[] =
  AIRPORT_BUILDING_KINDS.filter((k) => BUILDING_DEFS[k].airportType !== undefined);

/** True when the building is one of the three airport anchors. */
export function isAirportAnchor(b: BuildingRecord): boolean {
  return BUILDING_DEFS[b.kind]?.airportType !== undefined;
}

// ---------------------------------------------------------------------------
// Display type (the mixed-airport rule + the Phase 7 intel hook)
// ---------------------------------------------------------------------------

/**
 * The viewer's discovery record for a mixed airport anchor, or
 * undefined when this viewer has never observed it twice. Defensive:
 * pre-Phase-7 buildings have no `discovery` array. This is the UI seam
 * for the intel panel (workstream 3 owns the sim state; the panel owns
 * the presentation).
 */
export function discoveryStateOf(
  b: BuildingRecord,
  viewerOwner: number,
): AirportDiscoveryState | undefined {
  return (b.discovery ?? []).find((d) => d.viewer === viewerOwner);
}

/**
 * What an airport READS AS to `viewerOwner`. The owner always sees the
 * true `airportType`; everyone else sees a mixed airport as civilian —
 * a mixed site is military-capable but looks like a civil airport until
 * discovered. Phase 7 (intelligence, workstream 3) wires the hook: once
 * the viewer's discovery record is `revealed` (warning fired, grace
 * period elapsed — see `runAirportDiscovery` in sim/intel.ts), the
 * display flips to the true type ('mixed'). A merely `suspected`
 * airport still reads civilian — the warning is not the reveal.
 */
export function airportDisplayType(
  b: BuildingRecord,
  viewerOwner: number,
): 'civilian' | 'military' | 'mixed' | undefined {
  const type = BUILDING_DEFS[b.kind]?.airportType;
  if (type === undefined) return undefined;
  if (b.owner === viewerOwner) return type;
  if (type === 'mixed' && discoveryStateOf(b, viewerOwner)?.state === 'revealed') {
    return 'mixed';
  }
  return type === 'mixed' ? 'civilian' : type;
}

// ---------------------------------------------------------------------------
// Runway gating (§AD7)
// ---------------------------------------------------------------------------

/** Aircraft-class order: a runway serves its class and everything below. */
const AIRCRAFT_CLASS_ORDER: readonly AircraftClass[] = ['light', 'medium', 'heavy'];

/**
 * Which aircraft classes a runway module of `runwayClass` serves:
 * light → light; medium → light+medium; heavy → all. Shown in the build
 * UI so the runway choice gates aircraft class pre-purchase.
 */
export function servedAircraftClasses(runwayClass: AircraftClass): AircraftClass[] {
  const idx = AIRCRAFT_CLASS_ORDER.indexOf(runwayClass);
  return idx < 0 ? [] : AIRCRAFT_CLASS_ORDER.slice(0, idx + 1);
}

/** The aircraft class a unit kind parks as (undefined = unclassified). */
export function aircraftClassOf(kind: UnitKind): AircraftClass | undefined {
  return UNIT_DEFS[kind]?.hangarClass ?? undefined;
}

// ---------------------------------------------------------------------------
// Airline routes
// ---------------------------------------------------------------------------

/** Re-exported for the UI's setup-cost labels (single source of truth). */
export { AIRLINE_ROUTE_SETUP_COST };

/**
 * Whether a building can anchor an airline route: completed, and a
 * civil or mixed airport (military airbases can't take airline routes).
 * The sim's `establishAirlineRoute` validation is authoritative; this is
 * the UI's pre-check for enabling the "New route…" button.
 */
export function isAirlineEndpoint(b: BuildingRecord): boolean {
  if (b.progress < 1) return false;
  const type = BUILDING_DEFS[b.kind]?.airportType;
  return type === 'civilian' || type === 'mixed';
}

/** The owner's airline routes, in establishment order. */
export function airlineRoutesOf(world: World, owner: number) {
  return (world.city.airlineRoutes ?? []).filter((r) => r.owner === owner);
}

/** The per-route income the sim pays (the exact `airlineRouteIncome`). */
export function airlineRouteIncomeOf(
  world: World,
  route: { id: number; owner: number; from: number; to: number; establishedTick: number },
): number {
  return airlineRouteIncome(world, route);
}

/** World position of a building's anchor cell (for route polylines). */
export function buildingAnchorXZ(b: BuildingRecord): { x: number; z: number } {
  return { x: cellCenterWorld(b.cx), z: cellCenterWorld(b.cz) };
}

// ---------------------------------------------------------------------------
// Airport overlay data (render/airportOverlay.ts consumes this)
// ---------------------------------------------------------------------------

/** One ring marker datum per completed airport anchor. */
export interface AirportOverlayAirport {
  id: number;
  x: number;
  z: number;
  /** Ring radius (world units) — the anchor's footprint plus a margin. */
  radius: number;
  /** What the viewer reads this airport as (the mixed rule applied). */
  display: 'civilian' | 'military' | 'mixed';
}

/** One route arc datum per airline route. */
export interface AirportOverlayRoute {
  id: number;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
}

export interface AirportOverlayData {
  airports: AirportOverlayAirport[];
  routes: AirportOverlayRoute[];
}

/**
 * The read-only per-frame view the AirportOverlay renders: completed
 * airport anchors (rings, colored by display type) and airline routes
 * (arcs). Reads every sim field defensively (empty pre-sim → empty
 * view), never writes sim state.
 */
export function airportOverlayData(world: World, viewerOwner: number): AirportOverlayData {
  const airports: AirportOverlayAirport[] = [];
  const byId = new Map<number, BuildingRecord>();
  for (const b of world.city.buildings ?? []) {
    byId.set(b.id, b);
    if (!isAirportAnchor(b) || b.progress < 1) continue;
    const display = airportDisplayType(b, viewerOwner);
    if (display === undefined) continue;
    const def = BUILDING_DEFS[b.kind];
    airports.push({
      id: b.id,
      x: cellCenterWorld(b.cx),
      z: cellCenterWorld(b.cz),
      radius: Math.max(def?.footprintW ?? 3, def?.footprintH ?? 3) * 0.5 + 1.2,
      display,
    });
  }
  const routes: AirportOverlayRoute[] = [];
  for (const r of world.city.airlineRoutes ?? []) {
    const from = byId.get(r.from);
    const to = byId.get(r.to);
    if (from === undefined || to === undefined) continue;
    routes.push({
      id: r.id,
      fromX: cellCenterWorld(from.cx),
      fromZ: cellCenterWorld(from.cz),
      toX: cellCenterWorld(to.cx),
      toZ: cellCenterWorld(to.cz),
    });
  }
  return { airports, routes };
}

/** FNV-1a rebuild key over the airport + route data. */
export function airportOverlayDigest(data: AirportOverlayData): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(data.airports.length);
  for (const a of data.airports) {
    mix(a.id);
    mix(Math.round(a.x * 4));
    mix(Math.round(a.z * 4));
    mix(a.display === 'civilian' ? 1 : a.display === 'military' ? 2 : 3);
  }
  mix(data.routes.length);
  for (const r of data.routes) {
    mix(r.id);
    mix(Math.round(r.fromX * 4));
    mix(Math.round(r.fromZ * 4));
    mix(Math.round(r.toX * 4));
    mix(Math.round(r.toZ * 4));
  }
  return h >>> 0;
}
