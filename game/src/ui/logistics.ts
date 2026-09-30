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
 * NOVATERRA — ui/logistics.ts — the UI/render contract for grand-expansion
 * Phase 3 logistics (0.1 Alpha).
 *
 * The Phase 2 `ui/utilities.ts` precedent: a pure, headless-safe module
 * that reads the sim's logistics fields defensively (every read `?? 0` /
 * optional-chained, so a world without the Phase 3 fields yields an empty
 * view instead of a crash) and never writes sim state. The render overlay
 * (`render/logisticsOverlay.ts`) and the HUD selection panel both read
 * through this module — never the sim records directly.
 *
 * Sim surface used (read-only):
 * - `BuildingDef`: `ammoStorage`, `fuelStorage`, `reloadPoint`.
 * - `BuildingRecord`: `ammoStock`, `fuelStock`, `reservedAmmo`,
 *   `reservedFuel`, `cx`, `cz`, `progress`, `owner`.
 * - `UnitDef`: `fuelCapacity`, `ammoCapacity`, `fuelType`,
 *   `cargoFuelCapacity`, `cargoAmmoCapacity`.
 * - `UnitRecord`: `fuel`, `ammo`, `cargoFuel`, `cargoAmmo`,
 *   `supplyServices`, `resupplyDepotId`, `x`, `z`, `owner`.
 * - `LOGISTICS_RADIUS` (sim/economy.ts): the refill-aura radius the
 *   overlay draws; the UI never invents its own.
 * - `supplyLevel(def, u)` / `supplyServicesOf(u)` (sim/units.ts).
 *
 * Order contracts (ui/orders.ts builders emit these; sim/commands.ts
 * `registerLogisticsCommands` validates/applies them):
 * - `resupply`: payload `{ unitId, depotId, owner }` — reserves depot
 *   stock for the unit and routes it to the depot.
 * - `setSupplyToggles`: payload `{ unitId, owner, repair, rearm, refuel }`
 *   (flat booleans) — which field services a cargo-carrying unit offers.
 */

import { BUILDING_DEFS, cellCenterWorld } from '../sim/city';
import type { BuildingKind, BuildingRecord } from '../sim/city';
import { LOGISTICS_RADIUS } from '../sim/economy';
import { UNIT_DEFS, supplyLevel, supplyServicesOf } from '../sim/units';
import type { UnitDef, UnitKind, UnitRecord } from '../sim/units';
import type { World } from '../sim/world';

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * Every building the sim marks as a reload point — derived from
 * BUILDING_DEFS (never a second hand-maintained list, so it cannot
 * drift when the sim adds producers, ports, or harbors in later phases).
 * The sim's canonical list (see the `reloadPoint` doc in sim/city.ts):
 * the four production bases (barracks, warFactory, airfield, navalYard),
 * the two ammo producers (munitionsFactory, missilePlant), the three
 * purpose-built depots (missileSilo, ordnanceDepot, fuelDepot), and —
 * Phase 4 S7 — the three transport hubs (railStation, busDepot,
 * ferryTerminal), where civilian units refuel/rearm.
 */
export const RELOAD_POINT_KINDS: readonly BuildingKind[] = (
  Object.keys(BUILDING_DEFS) as BuildingKind[]
).filter((k) => BUILDING_DEFS[k]?.reloadPoint === true);

/** True when the building def marks a reload point (ammo/fuel refill). */
export function isReloadPointKind(kind: string): boolean {
  const def = BUILDING_DEFS[kind as BuildingKind];
  return def !== undefined && def.reloadPoint === true;
}

/**
 * Every unit with a cargo hold — derived from UNIT_DEFS (the sim's
 * `setSupplyToggles` accepts any cargo-carrying unit: the two dedicated
 * Phase 3 trucks plus the hauler's light field-carrier role).
 */
export const SUPPLY_UNIT_KINDS: readonly UnitKind[] = (
  Object.keys(UNIT_DEFS) as UnitKind[]
).filter((k) => {
  const d = UNIT_DEFS[k];
  return (
    d !== undefined &&
    ((d.cargoFuelCapacity ?? 0) > 0 || (d.cargoAmmoCapacity ?? 0) > 0)
  );
});

/**
 * Supply level below which a unit counts as "low" for the overlay marker
 * and the selection-panel warning (0 = dry, 1 = full). UI-side threshold:
 * the sim degrades gracefully at any level, but the player needs a
 * call-to-action point — 30% leaves time to route a resupply.
 */
export const LOGISTICS_LOW_SUPPLY = 0.3;

/**
 * True when the unit def carries cargo for others (supplyTruck /
 * fuelTruck / hauler). This is the sim's `setSupplyToggles` eligibility
 * rule, mirrored so the panel only offers toggles that will validate.
 */
export function isSupplyUnit(def: { cargoFuelCapacity?: number; cargoAmmoCapacity?: number } | undefined): boolean {
  if (!def) return false;
  return (def.cargoFuelCapacity ?? 0) > 0 || (def.cargoAmmoCapacity ?? 0) > 0;
}

/** True when the unit's own tanks/magazines are tracked by the sim. */
export function isTrackedUnit(def: { fuelCapacity?: number; ammoCapacity?: number; fuelType?: string } | undefined): boolean {
  if (!def) return false;
  return (def.fuelType === 'fossil' && (def.fuelCapacity ?? 0) > 0) || (def.ammoCapacity ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Defensive stock / level readers (AD9: `?? 0`, never a crash)
// ---------------------------------------------------------------------------

/** Live ammo stock on a depot building (0 for non-depots). */
export function ammoStockOf(b: BuildingRecord): number {
  return b.ammoStock ?? 0;
}

/** Live fuel stock on a depot building (0 for non-depots). */
export function fuelStockOf(b: BuildingRecord): number {
  return b.fuelStock ?? 0;
}

/** Live cargo-fuel hold on a unit (0 when the sim field is absent). */
export function cargoFuelOf(u: UnitRecord): number {
  return u.cargoFuel ?? 0;
}

/** Live cargo-ammo hold on a unit (0 when the sim field is absent). */
export function cargoAmmoOf(u: UnitRecord): number {
  return u.cargoAmmo ?? 0;
}

/** Unit's own fuel tank level 0..1 (1 when untracked/exempt). */
export function fuelFracOf(def: { fuelCapacity?: number; fuelType?: string } | undefined, u: UnitRecord): number {
  if (!def || def.fuelType !== 'fossil' || (def.fuelCapacity ?? 0) <= 0) return 1;
  return Math.max(0, Math.min(1, (u.fuel ?? 0) / (def.fuelCapacity as number)));
}

/** Unit's own ammo magazine level 0..1 (1 when untracked). */
export function ammoFracOf(def: { ammoCapacity?: number } | undefined, u: UnitRecord): number {
  if (!def || (def.ammoCapacity ?? 0) <= 0) return 1;
  return Math.max(0, Math.min(1, (u.ammo ?? 0) / (def.ammoCapacity as number)));
}

// ---------------------------------------------------------------------------
// Overlay data (render/logisticsOverlay.ts consumes this)
// ---------------------------------------------------------------------------

/** One reload-point coverage disc. */
export interface LogisticsDepotDisc {
  x: number;
  z: number;
  /** Depot radius — always the sim's LOGISTICS_RADIUS (kept per-disc so a
   * future per-kind radius needs no shape change). */
  radius: number;
}

/** One low-supply unit marker. */
export interface LogisticsLowUnit {
  x: number;
  z: number;
}

/** Read-only per-frame view for the logistics overlay. */
export interface LogisticsOverlayData {
  depots: LogisticsDepotDisc[];
  lowUnits: LogisticsLowUnit[];
}

/**
 * Build the overlay view: completed same-faction-agnostic reload points
 * (the overlay shows every player's coverage — positioning intel, like
 * the utility overlay shows every network) plus living units whose
 * supply level dropped below LOGISTICS_LOW_SUPPLY.
 */
export function logisticsOverlayData(world: World): LogisticsOverlayData {
  const depots: LogisticsDepotDisc[] = [];
  for (const b of world.city.buildings) {
    if (b.progress < 1) continue;
    if (!isReloadPointKind(b.kind)) continue;
    depots.push({
      x: cellCenterWorld(b.cx),
      z: cellCenterWorld(b.cz),
      radius: LOGISTICS_RADIUS,
    });
  }
  const lowUnits: LogisticsLowUnit[] = [];
  for (const u of world.units) {
    if ((u.hp ?? 1) <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!isTrackedUnit(def)) continue;
    if (isLowSupply(def, u)) {
      lowUnits.push({ x: u.x, z: u.z });
    }
  }
  return { depots, lowUnits };
}

/**
 * Low-supply predicate (the sim's `supplyLevel` against the UI threshold)
 * — shared by the overlay marker set and the selection-panel warning so
 * the two can never disagree.
 */
export function isLowSupply(def: UnitDef | undefined, u: UnitRecord): boolean {
  return (
    isTrackedUnit(def) && def !== undefined && supplyLevel(def, u) < LOGISTICS_LOW_SUPPLY
  );
}

/** FNV-1a digest of the overlay data — the rebuild key. */
export function logisticsOverlayDigest(data: LogisticsOverlayData): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(data.depots.length);
  for (const d of data.depots) {
    mix(Math.round(d.x * 4));
    mix(Math.round(d.z * 4));
    mix(Math.round(d.radius));
  }
  mix(data.lowUnits.length);
  for (const m of data.lowUnits) {
    // Markers drift with their units: quantize to whole world units so
    // the mesh rebuilds only when a marker visibly moved.
    mix(Math.round(m.x));
    mix(Math.round(m.z));
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Depot targeting (the Resupply button)
// ---------------------------------------------------------------------------

/**
 * Whether a building can serve as a resupply depot for anyone: the exact
 * rule `resupply` validates (reload point or any storage), completed.
 */
export function isDepotBuilding(b: BuildingRecord): boolean {
  if (b.progress < 1) return false;
  const def = BUILDING_DEFS[b.kind as BuildingKind];
  return (
    def !== undefined &&
    (def.reloadPoint === true || (def.ammoStorage ?? 0) > 0 || (def.fuelStorage ?? 0) > 0)
  );
}

/**
 * Available (unreserved) ammo at a depot, in depot-stock units. Mirrors
 * the sim's availability computation (stock − reserved), crediting back
 * the querying unit's own live reservation at THIS depot so a re-issue
 * sees the same pool the `resupply` command will.
 */
export function availableAmmo(b: BuildingRecord, unit: UnitRecord): number {
  const own = (unit.resupplyDepotId ?? 0) === b.id ? (unit.resupplyReservedAmmo ?? 0) : 0;
  return Math.max(0, (b.ammoStock ?? 0) - (b.reservedAmmo ?? 0) + own);
}

/** Available fuel — see `availableAmmo`. */
export function availableFuel(b: BuildingRecord, unit: UnitRecord): number {
  const own = (unit.resupplyDepotId ?? 0) === b.id ? (unit.resupplyReservedFuel ?? 0) : 0;
  return Math.max(0, (b.fuelStock ?? 0) - (b.reservedFuel ?? 0) + own);
}

/**
 * Nearest same-owner completed depot with available stock of something
 * the unit actually needs (fuel need for fossil tanks, ammo need for
 * magazines). Distance is Euclidean from the unit's live position.
 * Returns null when no depot can help — the Resupply button then says so
 * instead of issuing a doomed order.
 */
export function nearestDepot(world: World, unit: UnitRecord): BuildingRecord | null {
  const udef = UNIT_DEFS[unit.kind as UnitKind];
  const fuelNeed =
    udef !== undefined && udef.fuelType === 'fossil' && (udef.fuelCapacity ?? 0) > 0
      ? Math.max(0, (udef.fuelCapacity as number) - (unit.fuel ?? 0))
      : 0;
  const ammoNeed =
    udef !== undefined && (udef.ammoCapacity ?? 0) > 0
      ? Math.max(0, (udef.ammoCapacity as number) - (unit.ammo ?? 0))
      : 0;
  if (fuelNeed <= 0 && ammoNeed <= 0) return null;
  let best: BuildingRecord | null = null;
  let bestD2 = Infinity;
  for (const b of world.city.buildings) {
    if (b.owner !== unit.owner) continue;
    if (!isDepotBuilding(b)) continue;
    const canFuel = fuelNeed > 0 && availableFuel(b, unit) > 0;
    const canAmmo = ammoNeed > 0 && availableAmmo(b, unit) > 0;
    if (!canFuel && !canAmmo) continue;
    const dx = cellCenterWorld(b.cx) - unit.x;
    const dz = cellCenterWorld(b.cz) - unit.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = b;
    }
  }
  return best;
}

/**
 * Human reason a unit cannot resupply right now (for the button's
 * disabled tooltip / toast). Null when a depot can serve the unit.
 * Takes the depot the panel already found (avoids a second scan).
 */
export function resupplyBlockReason(
  world: World,
  unit: UnitRecord,
  depot: BuildingRecord | null,
): string | null {
  const udef = UNIT_DEFS[unit.kind as UnitKind];
  if (!isTrackedUnit(udef)) return 'not tracked by the supply system';
  if (depot !== null) return null;
  const fuelNeed =
    udef !== undefined && udef.fuelType === 'fossil' && (udef.fuelCapacity ?? 0) > 0
      ? Math.max(0, (udef.fuelCapacity as number) - (unit.fuel ?? 0))
      : 0;
  const ammoNeed =
    udef !== undefined && (udef.ammoCapacity ?? 0) > 0
      ? Math.max(0, (udef.ammoCapacity as number) - (unit.ammo ?? 0))
      : 0;
  if (fuelNeed <= 0 && ammoNeed <= 0) return 'tanks and magazines full';
  const own = world.city.buildings.some((b) => b.owner === unit.owner && isDepotBuilding(b));
  return own ? 'no depot has available stock' : 'no depot built yet';
}

// ---------------------------------------------------------------------------
// Selection-panel formatting
// ---------------------------------------------------------------------------

/** The unit's current field-service toggles (absent = all on). */
export function serviceTogglesOf(u: UnitRecord): { repair: boolean; rearm: boolean; refuel: boolean } {
  return supplyServicesOf(u);
}

/**
 * Depot stock line for the selection panel, e.g.
 * "Ammo 42/150 · Fuel 200/250". Only the storages the def has appear.
 */
export function depotStockLine(b: BuildingRecord): string {
  const def = BUILDING_DEFS[b.kind as BuildingKind];
  const parts: string[] = [];
  if (def !== undefined && (def.ammoStorage ?? 0) > 0) {
    parts.push(`Ammo ${Math.floor(ammoStockOf(b))}/${def.ammoStorage as number}`);
  }
  if (def !== undefined && (def.fuelStorage ?? 0) > 0) {
    parts.push(`Fuel ${Math.floor(fuelStockOf(b))}/${def.fuelStorage as number}`);
  }
  return parts.join(' · ');
}

/**
 * Cargo line for supply units, e.g. "Cargo: 60 fuel · 20 ammo".
 * Only the holds the def has appear.
 */
export function cargoLine(u: UnitRecord): string {
  const def = UNIT_DEFS[u.kind as UnitKind];
  const parts: string[] = [];
  if (def !== undefined && (def.cargoFuelCapacity ?? 0) > 0) {
    parts.push(`${Math.floor(cargoFuelOf(u))} fuel`);
  }
  if (def !== undefined && (def.cargoAmmoCapacity ?? 0) > 0) {
    parts.push(`${Math.floor(cargoAmmoOf(u))} ammo`);
  }
  return parts.length > 0 ? `Cargo: ${parts.join(' · ')}` : '';
}
