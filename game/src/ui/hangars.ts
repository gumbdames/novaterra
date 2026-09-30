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
 * NOVATERRA — ui/hangars.ts — the UI/render contract for grand-expansion
 * Phase 5 hangar/carrier shelter (0.1 Alpha).
 *
 * The Phase 2/3 `ui/utilities.ts` / `ui/logistics.ts` precedent: a pure,
 * headless-safe module that reads the sim's hangar fields defensively
 * (every read `?? 0` / optional-chained, so a world without the Phase 5
 * fields yields an empty view instead of a crash) and never writes sim
 * state. The HUD selection panel reads through this module — never the
 * sim records directly.
 *
 * Sim surface used (read-only):
 * - `UnitDef`: `carrierCapable`, `hangarClass`, `domain`, `fuelType`.
 * - `UnitRecord`: `embarkedOn`, `hangarBuildingId`, `x`, `z`, `owner`,
 *   `hp`, `fuel`.
 * - `BuildingRecord`: `hangars`, `progress`, `owner`, `kind`.
 * - `isSheltered(u)`, `findHangarSlot(world, target, cls)`,
 *   `wingOccupancy(world, carrierId)`, `EMBARK_RANGE`,
 *   `HANGAR_BASE_RANGE` (sim/units.ts).
 * - `HANGAR_CLASSES` / `HangarClass` (sim/city.ts).
 *
 * Order contracts (ui/orders.ts builders emit these; sim/units.ts
 * `registerUnitCommands` validates/applies them):
 * - `embarkAircraft`: payload `{ unitId, carrierId, owner }` — parks a
 *   carrier-capable aircraft in the carrier's wing. Carriers train
 *   EMPTY; only carrierCapable aircraft may embark (the user
 *   requirement — enforced by the sim AND mirrored by `canEmbarkUI`).
 * - `baseAircraft`: payload `{ unitId, buildingId, owner }` — parks an
 *   aircraft in a completed building's hangar.
 * - `launchAircraft`: payload `{ unitId, owner }` — frees the wing or
 *   hangar slot the aircraft occupies.
 */

// ---------------------------------------------------------------------------
// Constants (single source: never invent radii here — these are the sim's)
// ---------------------------------------------------------------------------

export {
  EMBARK_RANGE,
  HANGAR_BASE_RANGE,
  isSheltered,
} from '../sim/units';
import {
  findHangarSlot,
  isSheltered,
  UNIT_DEFS,
  wingOccupancy,
  EMBARK_RANGE,
  HANGAR_BASE_RANGE,
} from '../sim/units';
import type { UnitDef, UnitRecord } from '../sim/units';
import { cellCenterWorld, type BuildingRecord } from '../sim/city';
import type { World } from '../sim/world';

// ---------------------------------------------------------------------------
// Aircraft eligibility
// ---------------------------------------------------------------------------

/** The sim def for a unit record, or undefined for an unknown kind. */
export function unitDefOf(u: UnitRecord): UnitDef | undefined {
  return UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
}

/**
 * UI gate: the aircraft is allowed to embark at all — alive, air domain,
 * carrier-capable, and not already sheltered. Mirrors the sim's
 * `embarkAircraft` validate gate; the sim still validates at enqueue AND
 * apply time.
 */
export function canEmbarkUI(u: UnitRecord): boolean {
  if (u.hp <= 0) return false;
  const def = unitDefOf(u);
  if (!def || def.domain !== 'air') return false;
  if (def.carrierCapable !== true) return false;
  if (isSheltered(u)) return false;
  return true;
}

/** True when the aircraft is alive and not already sheltered (base-able). */
export function canBaseUI(u: UnitRecord): boolean {
  if (u.hp <= 0) return false;
  const def = unitDefOf(u);
  if (!def || def.domain !== 'air') return false;
  return !isSheltered(u);
}

/** True when the aircraft is currently parked or embarked (launch-able). */
export function canLaunchUI(u: UnitRecord): boolean {
  return u.hp > 0 && isSheltered(u);
}

// ---------------------------------------------------------------------------
// Block reasons (HUD shows these instead of a dead button)
// ---------------------------------------------------------------------------

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Why `u` cannot embark on `carrier` right now, or null when the order
 * is legal. Every reason the sim's `embarkAircraft` validate can raise,
 * in the same order — the HUD shows this string verbatim.
 */
export function embarkBlockReason(
  world: World,
  u: UnitRecord,
  carrier: UnitRecord,
): string | null {
  const def = unitDefOf(u);
  if (!def || def.domain !== 'air') return 'Not an aircraft';
  if (def.carrierCapable !== true) return 'Not carrier-capable';
  if (isSheltered(u)) return 'Already parked or embarked';
  if (carrier.owner !== u.owner) return 'Not your carrier';
  if (carrier.hp <= 0) return 'Carrier destroyed';
  const capacity = UNIT_DEFS[carrier.kind as keyof typeof UNIT_DEFS]?.wingCapacity ?? 0;
  if (wingOccupancy(world, carrier.id) >= capacity) return 'Wing is full';
  if (dist2(u.x, u.z, carrier.x, carrier.z) > EMBARK_RANGE) {
    return 'Too far from the carrier';
  }
  return null;
}

/**
 * Why `u` cannot park in `building`'s hangar right now, or null when the
 * order is legal. Mirrors the sim's `baseAircraft` validate.
 */
export function baseBlockReason(
  world: World,
  u: UnitRecord,
  building: BuildingRecord,
): string | null {
  const def = unitDefOf(u);
  if (!def || def.domain !== 'air') return 'Not an aircraft';
  if (isSheltered(u)) return 'Already parked or embarked';
  if (building.owner !== u.owner) return 'Not your building';
  if (building.progress < 1) return 'Building not completed';
  const slots = building.hangars;
  if (!slots || slots.length === 0) return 'No hangars here';
  if (findHangarSlot(world, { kind: 'building', id: building.id }, def.hangarClass) < 0) {
    return 'No free hangar of that size';
  }
  // Buildings live in cell coordinates; units in world coordinates.
  if (dist2(u.x, u.z, cellCenterWorld(building.cx), cellCenterWorld(building.cz)) > HANGAR_BASE_RANGE) {
    return 'Too far from the airfield';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Display lines
// ---------------------------------------------------------------------------

/**
 * Carrier wing occupancy line, e.g. "Wing 3/8". Empty when the carrier
 * has no wing capacity (not a carrier kind).
 */
export function wingLine(world: World, carrier: UnitRecord): string {
  const capacity = UNIT_DEFS[carrier.kind as keyof typeof UNIT_DEFS]?.wingCapacity ?? 0;
  if (capacity <= 0) return '';
  return `Wing ${wingOccupancy(world, carrier.id)}/${capacity}`;
}

/**
 * Building hangar occupancy line, e.g. "Hangars 4/6". Empty when the
 * building has no hangars (never had them, or a legacy record that
 * predates Phase 5).
 */
export function hangarLine(building: BuildingRecord): string {
  const slots = building.hangars;
  if (!slots || slots.length === 0) return '';
  const used = slots.filter((s) => s.occupant > 0).length;
  return `Hangars ${used}/${slots.length}`;
}

/**
 * Nearest friendly living carrier within EMBARK_RANGE of the aircraft,
 * or null. The UI proposes the target (the resupply nearestDepot
 * precedent); the sim validates the actual order.
 */
export function nearestCarrier(world: World, u: UnitRecord): UnitRecord | null {
  let best: UnitRecord | null = null;
  let bestD = EMBARK_RANGE;
  for (const c of world.units) {
    if (c.owner !== u.owner || c.hp <= 0) continue;
    const cap = UNIT_DEFS[c.kind as keyof typeof UNIT_DEFS]?.wingCapacity ?? 0;
    if (cap <= 0) continue;
    const d = dist2(u.x, u.z, c.x, c.z);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Nearest friendly completed building with a free compatible hangar
 * slot within HANGAR_BASE_RANGE of the aircraft, or null. Slot
 * compatibility is per the aircraft's hangar class — the UI never
 * proposes a building that has no fitting slot.
 */
export function nearestHangarBuilding(world: World, u: UnitRecord): BuildingRecord | null {
  const def = unitDefOf(u);
  if (!def || def.domain !== 'air') return null;
  let best: BuildingRecord | null = null;
  let bestD = HANGAR_BASE_RANGE;
  for (const b of world.city.buildings) {
    if (b.owner !== u.owner || b.progress < 1) continue;
    if (!b.hangars || b.hangars.length === 0) continue;
    if (findHangarSlot(world, { kind: 'building', id: b.id }, def.hangarClass) < 0) continue;
    // Buildings live in cell coordinates; units in world coordinates.
    const d = dist2(u.x, u.z, cellCenterWorld(b.cx), cellCenterWorld(b.cz));
    if (d <= bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

/**
 * Aircraft parked in a building's hangar (id order — deterministic).
 * The building's selection panel lists these with Launch buttons; the
 * bh: digest segment carries their ids so the panel repaints exactly
 * when the parked set changes.
 */
export function parkedAircraft(world: World, buildingId: number): UnitRecord[] {
  return world.units
    .filter((u) => (u.hangarBuildingId ?? 0) === buildingId && u.hp > 0)
    .sort((a, b) => a.id - b.id);
}

/**
 * Aircraft embarked on a carrier (id order — deterministic). The
 * carrier's selection panel lists these with Launch buttons; the ew:
 * digest segment carries their ids.
 */
export function embarkedAircraft(world: World, carrierId: number): UnitRecord[] {
  return world.units
    .filter((u) => (u.embarkedOn ?? 0) === carrierId && u.hp > 0)
    .sort((a, b) => a.id - b.id);
}
/**
 * Where the aircraft is sheltered, for the selection panel:
 * "Embarked on carrier" / "Parked in hangar" / "" when flying free.
 */
export function shelterLine(world: World, u: UnitRecord): string {
  const embarkedOn = u.embarkedOn ?? 0;
  if (embarkedOn > 0) {
    const carrier = world.units.find((x) => x.id === embarkedOn);
    if (carrier) {
      return `Embarked on ${carrier.kind}`;
    }
    return 'Embarked on carrier';
  }
  if ((u.hangarBuildingId ?? 0) > 0) return 'Parked in hangar';
  return '';
}
