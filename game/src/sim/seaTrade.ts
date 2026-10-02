/**
 * sim/seaTrade.ts — civilian sea-trade route mechanics (grand-expansion
 * civilian Half A, 2026-10-01).
 *
 * This module is deliberately a LEAF: it value-imports only from
 * `./city`, `./units`, and `./routeLifecycle` (the shared
 * cargo-transfer kernel — which keeps type-only imports, so the leaf
 * stays a leaf), none of which imports it back. The
 * per-tick movement loop (`advanceSeaTrade` in movement.ts) calls
 * `runSeaTradePortCall` every tick, and movement.ts already sits
 * downstream of commands.ts (`commands.ts` value-imports `orderMoveTo`
 * from movement.ts) — so the port-call logic cannot live in economy.ts:
 * a movement→economy value edge evaluates economy.ts while city.ts is
 * still partially initialized and crashes module load
 * (`ZoneType.INDUSTRIAL` of undefined). The command specs
 * (establish/cancel/assign) stay in economy.ts; the per-tick-callable
 * mechanics live here.
 *
 * Design: docs/research/sea-logistics.md. Routes anchor at the owner's
 * completed trade docks only (the no-blur rule, 2026-10-01 — the
 * civilian shipyard builds ships, it never trades); ships physically
 * sail the ferry loop; policies are funds/fuel/materials
 * (SeaRoutePolicy in city.ts).
 */

import {
  BUILDING_DEFS,
  cellCenterWorld,
  getPlayer,
  type SeaRoute,
} from './city';
import { UNIT_DEFS, type UnitRecord } from './units';
import type { World } from './world';
// Roadmap B22 (2026-10-02): the shared cargo-transfer kernel. This
// stays a leaf: routeLifecycle.ts value-imports only from ./city,
// so no new module-init edge is opened.
import { cargoTransferAmount } from './routeLifecycle';

/**
 * Per-voyage income for a `funds`-policy route: flat base + per-world-
 * unit of dock distance. Balance (docs/research/sea-logistics.md
 * §4): a 200-unit voyage pays 90 funds; at freighter speed 8 the
 * round trip takes ~50 s ⇒ ~1.8 funds/s per ship — below the airline
 * route's 2.5/s and the partner route's 3.0/s, because sea trade
 * stacks per ship (two freighters ≈ 3.6/s) while costing hulls, fuel,
 * and harbor upkeep. Sea wins on bulk/long distance (the per-unit
 * term dominates past ~150 units); air wins on speed-to-income with
 * no hulls to lose. Trucks stay the short-haul answer (no harbor).
 */
export const SEA_TRADE_VOYAGE_BASE = 40;
export const SEA_TRADE_VOYAGE_PER_UNIT = 0.25;
/**
 * Funds to establish one sea route (airline parity). Lives in this
 * leaf module — not economy.ts — so the AI (sim/ai.ts) can read it
 * without opening an ai→economy→city module cycle (economy.ts
 * evaluates ZoneType-keyed tables at top level; importing it from
 * ai.ts crashes the portrait build — 2026-10-01).
 */
export const SEA_ROUTE_SETUP_COST = 500;
/**
 * Materials-policy export price (funds per unit): the mid-market
 * price, no spread. Beats the instant marketSellValue (1.6) by 25% —
 * the "slow but better rate" bulk identity — while staying below the
 * buy price (2.4), so no buy→export arbitrage loop exists.
 */
export const MATERIALS_EXPORT_PRICE = 2;

/**
 * The per-voyage funds income a `funds`-policy route pays on arrival
 * at the destination harbor. The exact number the sim credits — the
 * UI shows this (never a reimplementation).
 */
export function seaVoyageIncome(world: World, route: SeaRoute): number {
  const city = world.city;
  const from = city.buildings.find((b) => b.id === route.from);
  const to = city.buildings.find((b) => b.id === route.to);
  if (!from || !to) return 0;
  const dx = cellCenterWorld(from.cx) - cellCenterWorld(to.cx);
  const dz = cellCenterWorld(from.cz) - cellCenterWorld(to.cz);
  const distance = Math.sqrt(dx * dx + dz * dz);
  return SEA_TRADE_VOYAGE_BASE + distance * SEA_TRADE_VOYAGE_PER_UNIT;
}

/**
 * Which unit kinds may be assigned to a sea route: civilian sea cargo
 * vessels. The def-level predicate (not a kind list): domain sea, not
 * military, and a cargo hold of some kind (fuel / materials / ammo —
 * ammo never occurs on civilian hulls, but the predicate stays
 * future-proof). cruiseLiner/yacht are passenger vessels with passive
 * harvest income — not route ships.
 */
export function isSeaTradeShip(kind: string): boolean {
  const def = UNIT_DEFS[kind as keyof typeof UNIT_DEFS];
  if (!def || def.domain !== 'sea' || def.military === true) return false;
  return (
    (def.cargoFuelCapacity ?? 0) > 0 ||
    (def.cargoMaterialsCapacity ?? 0) > 0 ||
    (def.cargoAmmoCapacity ?? 0) > 0
  );
}

/**
 * Run one sea-trade port call: the ship has arrived at `harborId` and
 * the route policy's port action fires. `atOrigin` = the harbor is the
 * route's `from` (load) rather than `to` (unload/income).
 *
 * - funds: on arrival at the destination, credit
 *   `seaVoyageIncome(world, route)` to the owner. Nothing happens at
 *   the origin (the general-freight leg is just sailing).
 * - fuel: at the origin, pump the harbor's `fuelStock` into the
 *   ship's cargo hold (capacity-capped); at the destination, dump the
 *   hold into the destination's `fuelStock` (capped by the harbor
 *   def's `fuelStorage`; harbors with no storage def are uncapped).
 * - materials: at the origin, load the owner's materials stock into
 *   the hold (capacity-capped — the treasury can go negative nowhere;
 *   `Math.min` against the stock); at the destination, sell the hold
 *   at `MATERIALS_EXPORT_PRICE` funds/unit.
 *
 * Called from the movement tick (`advanceSeaTrade` in movement.ts);
 * all quantities here are digest-covered via the sim digest.
 */
export function runSeaTradePortCall(
  world: World,
  unit: UnitRecord,
  route: SeaRoute,
  harborId: number,
  atOrigin: boolean,
): void {
  const city = world.city;
  const player = getPlayer(city, unit.owner);
  const harbor = city.buildings.find((b) => b.id === harborId);
  if (!player || !harbor) return;
  const def = UNIT_DEFS[unit.kind as keyof typeof UNIT_DEFS];
  if (route.policy === 'funds') {
    if (!atOrigin) player.funds += seaVoyageIncome(world, route);
    return;
  }
  if (route.policy === 'fuel') {
    if (atOrigin) {
      const room = (def.cargoFuelCapacity ?? 0) - unit.cargoFuel;
      // Roadmap B22: the shared cargo-transfer kernel.
      const load = cargoTransferAmount(room, harbor.fuelStock ?? 0);
      if (load > 0) {
        harbor.fuelStock = (harbor.fuelStock ?? 0) - load;
        unit.cargoFuel += load;
      }
    } else {
      const cap = BUILDING_DEFS[harbor.kind].fuelStorage ?? Number.POSITIVE_INFINITY;
      const room = Math.max(0, cap - (harbor.fuelStock ?? 0));
      const give = cargoTransferAmount(unit.cargoFuel, room);
      if (give > 0) {
        harbor.fuelStock = (harbor.fuelStock ?? 0) + give;
        unit.cargoFuel -= give;
      }
    }
    return;
  }
  // materials policy.
  if (atOrigin) {
    const room = (def.cargoMaterialsCapacity ?? 0) - (unit.cargoMaterials ?? 0);
    const load = cargoTransferAmount(room, player.materials);
    if (load > 0) {
      player.materials -= load;
      unit.cargoMaterials = (unit.cargoMaterials ?? 0) + load;
    }
  } else {
    const sale = unit.cargoMaterials ?? 0;
    if (sale > 0) {
      player.funds += sale * MATERIALS_EXPORT_PRICE;
      unit.cargoMaterials = 0;
    }
  }
}
