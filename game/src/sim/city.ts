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
 * NOVATERRA — sim/city.ts — city building: roads, zones, buildings,
 * power/water coverage, and organic growth.
 *
 * Responsibilities:
 *  - The city grid reuses the terrain heightfield cells (256×256, 2 world
 *    units per cell): roads are paved cells, zones are painted cells,
 *    buildings occupy footprint rectangles. Everything is plain data on
 *    `World.city`, so snapshots and the digest cover the whole city.
 *  - Placement rules (land only, zone matching, no overlaps,
 *    affordability) are enforced by command validation — at enqueue AND
 *    at apply time. Roads are purely optional: they cost money and will
 *    serve a future traffic system, but no building or service requires
 *    one (user directive 2026-09-30).
 *  - Power/water is a Phase-2 network model (grand expansion): integer
 *    BFS flood fill over conductor tiles (roads conduct both utilities
 *    automatically; drag-painted power lines / water pipes are the
 *    long-hop tool), recomputed on structural change only
 *    (`utilityEpoch`). Per-network supply sums; consumers draw in fixed
 *    (network id, BFS distance, building id) order; demand counts only
 *    reached buildings. Unreached buildings fall back to the legacy
 *    capacity pool (AD2) so the Classic AI and old saves keep working.
 *    Unpowered/unwatered buildings still run, at a steep 25% output
 *    factor each (documented below). See sim/utilityNetworks.ts.
 *  - Growth: zoned cells auto-develop when the economy allows, with a
 *    desirability check the player steers via tax rates and utility
 *    headroom.
 *
 * Key invariants:
 *  - `roads`, `powerLines` and `pipes` are always sorted ascending;
 *    `zones` is always sorted by cell. All are maintained by the
 *    mutators — never hand-edit.
 *  - `utilityEpoch` is bumped by every structural mutator; the derived
 *    utility model (utilityNetworks.ts) caches on it.
 *  - `buildings` is in placement (id) order, never reordered; demolish
 *    uses splice like the entity registry.
 *  - All randomness flows through the world's 'city' RNG stream.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 * The renderer reads `kind`, footprint, cell position and `facing` per
 * building (see `buildingWorldRect`).
 */

import type { TerrainData } from './terrain';
import { isWater } from './terrain';
import type { World } from './world';
import { rngBank } from './world';
import type { CommandQueue, CommandSpec } from './commands';
import type { Age } from './ages';
import {
  cellDesirability,
  getDesirabilityModel,
  migrationPull,
} from './desirability';

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/** City grid cells per side — matches the terrain heightfield exactly. */
export const CITY_GRID_CELLS = 256;
/** World units per cell side. */
export const CELL_WORLD_SIZE = 2;
/** World coordinates run [-MAP_HALF_SIZE, +MAP_HALF_SIZE). */
export const MAP_HALF_SIZE = 256;

/** Cell index for (cx, cz). Row-major, matches terrain vertex layout. */
export function cellIndex(cx: number, cz: number): number {
  return cz * CITY_GRID_CELLS + cx;
}

/** Cell coordinates for an index. */
export function cellCoords(cell: number): { cx: number; cz: number } {
  return { cx: cell % CITY_GRID_CELLS, cz: Math.floor(cell / CITY_GRID_CELLS) };
}

/** True when (cx, cz) is a valid cell coordinate. */
export function inBounds(cx: number, cz: number): boolean {
  return cx >= 0 && cz >= 0 && cx < CITY_GRID_CELLS && cz < CITY_GRID_CELLS;
}

/** World coordinate of a cell's center along one axis. */
export function cellCenterWorld(c: number): number {
  return -MAP_HALF_SIZE + c * CELL_WORLD_SIZE + CELL_WORLD_SIZE / 2;
}

/** True when the cell's center is under water. */
export function cellIsWater(t: TerrainData, cx: number, cz: number): boolean {
  return isWater(t, cellCenterWorld(cx), cellCenterWorld(cz));
}

/** All cell indices of a footprint rectangle. Row-major (cz outer). */
export function footprintCells(cx: number, cz: number, w: number, h: number): number[] {
  const cells: number[] = [];
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      cells.push(cellIndex(cx + dx, cz + dz));
    }
  }
  return cells;
}

/** Binary search on a sorted number array. */
function sortedHas(sorted: number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] as number;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Insert while keeping the array sorted ascending. No-op if present. */
function sortedInsert(sorted: number[], value: number): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  if (sorted[lo] !== value) sorted.splice(lo, 0, value);
}

// ---------------------------------------------------------------------------
// Resources, zones, building roster
// ---------------------------------------------------------------------------

/** The Phase-1 stockpile resources plus Phase-1.5 additions (goods, influence, manpower). */
export const ResourceKey = {
  FUNDS: 'funds',
  MATERIALS: 'materials',
  FUEL: 'fuel',
  FOOD: 'food',
  RESEARCH: 'research',
  GOODS: 'goods',
  INFLUENCE: 'influence',
  MANPOWER: 'manpower',
} as const;
export type ResourceKey = (typeof ResourceKey)[keyof typeof ResourceKey];

/** The three zone types. Stored as small ints in zone records. */
export const ZoneType = {
  RESIDENTIAL: 0,
  COMMERCIAL: 1,
  INDUSTRIAL: 2,
} as const;
export type ZoneType = (typeof ZoneType)[keyof typeof ZoneType];

/** 'utility' buildings (power/water AND civic infrastructure like schools)
 * skip the zone-matching rule — they are placeable anywhere on land. */
export const UTILITY_ZONE = 'utility' as const;

/** Phase 3: city specialization focus. Plain string — snapshot-safe. */
export type CitySpecialization = 'balanced' | 'industrial' | 'commercial' | 'residential';
export const CITY_SPECIALIZATIONS: CitySpecialization[] = [
  'balanced', 'industrial', 'commercial', 'residential',
];

/** A trade route between two players: bonus funds while both ends trade. */
export interface TradeRoute {
  /** Route owner (pays the setup cost, collects the income). */
  owner: number;
  /** Trading partner: another player id. */
  partner: number;
  /** Sim tick when the route was established. */
  establishedTick: number;
}

/** Phase-1 building kinds, plus Phase 3 superweapon facilities, plus the roster-expansion set. */
export const BuildingKind = {
  HOUSE: 'house',
  APARTMENT: 'apartment',
  SHOP: 'shop',
  LAB: 'lab',
  FACTORY: 'factory',
  FARM: 'farm',
  POWER_PLANT: 'powerPlant',
  WATER_PUMP: 'waterPump',
  MEDIA_CENTER: 'mediaCenter',
  SHIPYARD: 'shipyard',
  /** Phase 3: Aegis superweapon control building (Ascendance only). */
  AEGIS_CONTROL: 'aegisControl',
  /** Phase 3: Storm Engine superweapon array (Ascendance only). */
  STORM_ARRAY: 'stormArray',
  // Roster expansion (spec docs/research/roster-expansion.md §3): the four
  // production buildings (military tech tree made physical) + economy.
  BARRACKS: 'barracks',
  WAR_FACTORY: 'warFactory',
  /** Phase 1 (veterancy): trains armed units to Regular on spawn. */
  MILITARY_ACADEMY: 'militaryAcademy',
  AIRFIELD: 'airfield',
  NAVAL_YARD: 'navalYard',
  RADAR_STATION: 'radarStation',
  QUARRY: 'quarry',
  OIL_REFINERY: 'oilRefinery',
  RECYCLING_CENTER: 'recyclingCenter',
  MARKET: 'market',
  SOLAR_FARM: 'solarFarm',
  NUCLEAR_PLANT: 'nuclearPlant',
  DESALINATION: 'desalination',
  HOSPITAL: 'hospital',
  UNIVERSITY: 'university',
  SCHOOL: 'school',
  /** Workstream Z (2026-09-30): education ladder — early childhood. */
  KINDERGARTEN: 'kindergarten',
  /** Workstream Z (2026-09-30): education ladder — tertiary. */
  COLLEGE: 'college',
  /**
   * Workstream W (2026-09-30): civic amenity — a library raises nearby
   * residential desirability (see the amenity table in sim/desirability.ts).
   */
  LIBRARY: 'library',
  /**
   * Workstream W (2026-09-30): civic amenity — a park raises nearby
   * residential desirability (see the amenity table in sim/desirability.ts).
   */
  PARK: 'park',
  MONUMENT: 'monument',
  // Phase 2 (grand expansion, 2026-09-30): the utility plant ladder —
  // power plants across tech levels, water sources, storage, and the
  // network buildings that tie grids together. All zone: UTILITY_ZONE.
  COAL_PLANT: 'coalPlant',
  GAS_PLANT: 'gasPlant',
  WIND_FARM: 'windFarm',
  HYDRO_DAM: 'hydroDam',
  GEOTHERMAL_PLANT: 'geothermalPlant',
  FUSION_PLANT: 'fusionPlant',
  WATER_WELL: 'waterWell',
  WATER_TOWER: 'waterTower',
  WATER_TREATMENT: 'waterTreatment',
  RESERVOIR: 'reservoir',
  POWER_SUBSTATION: 'powerSubstation',
  PUMPING_STATION: 'pumpingStation',
  BATTERY_STATION: 'batteryStation',
  // Phase 3 (grand expansion, 2026-09-30): the logistics roster
  // (PLAN §3.2) — crude extraction, ammo production (general vs
  // specialized), and the depot/storage reload points. The four
  // production bases (barracks/warFactory/airfield/navalYard) are
  // marked `reloadPoint` in their defs below rather than here.
  OIL_WELL: 'oilWell',
  OIL_RIG: 'oilRig',
  MUNITIONS_FACTORY: 'munitionsFactory',
  MISSILE_PLANT: 'missilePlant',
  MISSILE_SILO: 'missileSilo',
  ORDNANCE_DEPOT: 'ordnanceDepot',
  FUEL_DEPOT: 'fuelDepot',
} as const;
export type BuildingKind = (typeof BuildingKind)[keyof typeof BuildingKind];

/**
 * Static definition of one building kind. All rates are per sim-second and
 * apply on the economy tick (every 30 ticks). See docs/ARCHITECTURE.md D11
 * for the balance rationale behind these numbers.
 */
export interface BuildingDef {
  kind: BuildingKind;
  name: string;
  /** Zone the footprint must sit in, or 'utility' for anywhere-on-land. */
  zone: ZoneType | typeof UTILITY_ZONE;
  footprintW: number;
  footprintH: number;
  costFunds: number;
  costMaterials: number;
  /** Seconds of construction before the building operates. */
  buildSeconds: number;
  /** Funds per second, always charged in full once funded. */
  upkeepFundsPerSec: number;
  powerDemand: number;
  /** Power plants supply instead of demanding. */
  powerSupply: number;
  waterDemand: number;
  /** Water pumps supply instead of demanding. */
  waterSupply: number;
  /** Per-second production when fully serviced (scaled by penalty). */
  output: Partial<Record<ResourceKey, number>>;
  /** Per-second consumption (scaled by the same penalty as output). */
  input: Partial<Record<ResourceKey, number>>;
  /** Residents housed (residential only). */
  population: number;
  /** Taxable value in funds/sec (zoned buildings only). */
  taxBasePerSec: number;
  /** Minimum age required to place this building (spec §6). */
  minAge: Age;
  /**
   * Production building the owner must have completed (progress >= 1) to
   * place this kind. Undefined = no prerequisite. Enforced in
   * `placeBuilding` validation (real or AI-virtually-constructed, via
   * `hasProductionBuilding`). First use: Military Academy requires a
   * completed Barracks.
   */
  requiredBuilding?: BuildingKind;
  /**
   * Phase 2 (grand expansion): research upgrade the owner must have
   * researched to place this kind. Plain string (not upgrades.ts's
   * UpgradeId — that module imports this one, so sharing the type would
   * be a cycle). Enforced in the `placeBuilding` command spec alongside
   * the age and requiredBuilding gates. First uses: the utility plant
   * ladder (combustionTech gates coal/gas, groundwaterSurvey gates
   * water wells, gridStorage gates storage buildings).
   */
  requiredUpgrade?: string;
  /**
   * Phase 2: per-building storage for the utility networks. Only one of
   * power/water per building (batteryStation stores power; waterTower and
   * reservoir store water). Network storage capacity is the sum over the
   * completed, funded storage buildings reached by that network; the
   * integer stock itself lives in the derived utility model
   * (utilityNetworks.ts), never in the snapshot.
   */
  storageKind?: 'power' | 'water';
  /** Storage capacity in utility units (requires `storageKind`). */
  storageCapacity?: number;
  /**
   * Phase 2: when true, the completed building's footprint tiles act as
   * conductors for the named utility even with no lines/pipes painted —
   * powerSubstation injects a power line onto the road grid, pumpingStation
   * does the same for water pipes.
   */
  conductsPower?: boolean;
  conductsWater?: boolean;
  /**
   * Phase 2: pollution → water fouling (research §1.8). A completed,
   * funded plant with `fouling` fouls orthogonally-adjacent water
   * sources (`foulable`), halving their output until a waterTreatment
   * scrubs them.
   */
  fouling?: boolean;
  foulable?: boolean;
  /**
   * Phase 3 logistics. Max ammo (missiles/ordnance) storable at this
   * building when completed — depots, silos, factories. The integer
   * stock lives on `BuildingRecord.ammoStock` (snapshotted, AD9).
   */
  ammoStorage?: number;
  /**
   * Phase 3 logistics. Max forward vehicle fuel storable — fuel depots
   * cache the owner's fuel stockpile near the front. Stock lives on
   * `BuildingRecord.fuelStock` (snapshotted, AD9).
   */
  fuelStorage?: number;
  /**
   * Phase 3 logistics. Ammo produced per sim-second when completed and
   * operational — munitionsFactory (general) and missilePlant
   * (specialized heavy ordnance). Consumed inputs stay on
   * `input`/`output` like every other production building.
   */
  ammoProduction?: number;
  /**
   * Phase 3 logistics. When true, a completed building is a reload
   * point: units inside its logistics radius draw ammo/fuel from its
   * stocks (depots, bases, naval bases, ports, airports).
   *
   * The full reload-point list (kept in sync here — grep `reloadPoint:
   * true` to audit): the four production bases (barracks, warFactory,
   * airfield, navalYard — valid resupply-order targets; their stocks
   * arrive via the supply-truck chain), the two ammo producers
   * (munitionsFactory, missilePlant — units resupply at the factory
   * gate from the producer's own stock), and the three purpose-built
   * depots (missileSilo, ordnanceDepot, fuelDepot). No port-like
   * building exists in 0.1 Alpha — civilian ports/military harbors
   * join this list when they land (Phases 5–6).
   */
  reloadPoint?: boolean;
  /**
   * Workstream W (2026-09-30): the Phase 4 marina hook. When true, a
   * completed building counts as a waterfront amenity in the
   * desirability model (+10 within 15 cells, toward the +20 amenity cap
   * — see `AMENITY_TABLE` in sim/desirability.ts). The marina building
   * kind (Phase 4) sets this flag; NO desirability code changes are
   * needed then — the amenity scan already keys off this flag.
   */
  waterfrontAmenity?: boolean;
}

export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  house: {
    kind: 'house', name: 'House', zone: ZoneType.RESIDENTIAL,
    footprintW: 2, footprintH: 2, costFunds: 120, costMaterials: 40,
    buildSeconds: 10, upkeepFundsPerSec: 0.15,
    powerDemand: 1, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 6, taxBasePerSec: 1.0,
    minAge: 'foundation',
  },
  apartment: {
    kind: 'apartment', name: 'Apartment Block', zone: ZoneType.RESIDENTIAL,
    footprintW: 3, footprintH: 3, costFunds: 450, costMaterials: 160,
    buildSeconds: 30, upkeepFundsPerSec: 0.7,
    powerDemand: 3, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 30, taxBasePerSec: 5.0,
    minAge: 'foundation',
  },
  shop: {
    kind: 'shop', name: 'Shop', zone: ZoneType.COMMERCIAL,
    footprintW: 2, footprintH: 2, costFunds: 220, costMaterials: 70,
    buildSeconds: 15, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { funds: 1.8 }, input: { goods: 0.5 }, population: 0, taxBasePerSec: 6.0,
    minAge: 'foundation',
  },
  lab: {
    kind: 'lab', name: 'Research Lab', zone: ZoneType.COMMERCIAL,
    footprintW: 2, footprintH: 2, costFunds: 650, costMaterials: 220,
    buildSeconds: 45, upkeepFundsPerSec: 1.2,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { research: 0.4 }, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'foundation',
  },
  factory: {
    kind: 'factory', name: 'Factory', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 550, costMaterials: 220,
    buildSeconds: 40, upkeepFundsPerSec: 1.6,
    powerDemand: 5, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { materials: 2.5, goods: 1.5 }, input: { fuel: 0.4 }, population: 0, taxBasePerSec: 8.0,
    minAge: 'foundation',
  },
  farm: {
    kind: 'farm', name: 'Farm', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 300, costMaterials: 80,
    buildSeconds: 15, upkeepFundsPerSec: 0.6,
    powerDemand: 1, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: { food: 3.0 }, input: {}, population: 0, taxBasePerSec: 2.5,
    minAge: 'foundation',
  },
  powerPlant: {
    kind: 'powerPlant', name: 'Power Plant', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 60, upkeepFundsPerSec: 0.8,
    powerDemand: 0, powerSupply: 25, waterDemand: 2, waterSupply: 0,
    output: {}, input: { fuel: 1.0 }, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
    // Phase 2: the oil burner fouls adjacent water sources (like coal/gas).
    fouling: true,
  },
  waterPump: {
    kind: 'waterPump', name: 'Water Pump', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 25,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'foundation',
    // Phase 2: industrial neighbors can foul this source (halved output).
    foulable: true,
  },
  mediaCenter: {
    kind: 'mediaCenter', name: 'Media Center', zone: ZoneType.COMMERCIAL,
    footprintW: 2, footprintH: 2, costFunds: 800, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 1.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { influence: 0.8 }, input: {}, population: 0, taxBasePerSec: 7.0,
    minAge: 'foundation',
  },
  shipyard: {
    kind: 'shipyard', name: 'Shipyard', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 3, costFunds: 1200, costMaterials: 500,
    buildSeconds: 60, upkeepFundsPerSec: 1.5,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'foundation',
  },
  aegisControl: {
    kind: 'aegisControl', name: 'Aegis Control', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 5000, costMaterials: 2000,
    buildSeconds: 120, upkeepFundsPerSec: 5.0,
    powerDemand: 10, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'ascendance',
  },
  stormArray: {
    kind: 'stormArray', name: 'Storm Array', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 4, costFunds: 6000, costMaterials: 2500,
    buildSeconds: 150, upkeepFundsPerSec: 6.0,
    powerDemand: 12, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'ascendance',
  },
  barracks: {
    kind: 'barracks', name: 'Barracks', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 250,
    buildSeconds: 40, upkeepFundsPerSec: 1.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { manpower: 0.8 }, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'foundation',
    // Phase 3: army bases are reload points — units resupply here
    // (stocks arrive via the supply-truck chain; see reloadPoint doc).
    reloadPoint: true,
  },
  militaryAcademy: {
    kind: 'militaryAcademy', name: 'Military Academy', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 0.8,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'foundation', requiredBuilding: 'barracks',
  },
  warFactory: {
    kind: 'warFactory', name: 'War Factory', zone: ZoneType.INDUSTRIAL,
    footprintW: 4, footprintH: 3, costFunds: 1100, costMaterials: 450,
    buildSeconds: 60, upkeepFundsPerSec: 1.8,
    powerDemand: 6, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { materials: 0.5 }, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'foundation',
    // Phase 3: army bases are reload points (see barracks note).
    reloadPoint: true,
  },
  airfield: {
    kind: 'airfield', name: 'Airfield', zone: UTILITY_ZONE,
    footprintW: 5, footprintH: 4, costFunds: 1500, costMaterials: 600,
    buildSeconds: 75, upkeepFundsPerSec: 2.0,
    powerDemand: 5, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'connectivity',
    // Phase 3: the airport is a reload point for aircraft (and any
    // land unit parked on the field).
    reloadPoint: true,
  },
  navalYard: {
    kind: 'navalYard', name: 'Naval Yard', zone: UTILITY_ZONE,
    footprintW: 5, footprintH: 4, costFunds: 1800, costMaterials: 700,
    buildSeconds: 80, upkeepFundsPerSec: 2.2,
    powerDemand: 6, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'industry',
    // Phase 3: the naval base is a reload point for ships.
    reloadPoint: true,
  },
  radarStation: {
    kind: 'radarStation', name: 'Radar Station', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 600, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 0.8,
    powerDemand: 3, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.5 }, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'connectivity',
  },
  quarry: {
    kind: 'quarry', name: 'Quarry', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 350, costMaterials: 100,
    buildSeconds: 25, upkeepFundsPerSec: 0.7,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { materials: 2.0 }, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
  },
  oilRefinery: {
    kind: 'oilRefinery', name: 'Oil Refinery', zone: ZoneType.INDUSTRIAL,
    footprintW: 4, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 50, upkeepFundsPerSec: 1.4,
    powerDemand: 4, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { fuel: 1.5 }, input: { materials: 0.3 }, population: 0, taxBasePerSec: 6.0,
    minAge: 'connectivity',
  },
  recyclingCenter: {
    kind: 'recyclingCenter', name: 'Recycling Center', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 500, costMaterials: 180,
    buildSeconds: 35, upkeepFundsPerSec: 0.9,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { materials: 1.0 }, input: { goods: 0.5 }, population: 0, taxBasePerSec: 4.0,
    minAge: 'connectivity',
  },
  market: {
    kind: 'market', name: 'Market', zone: ZoneType.COMMERCIAL,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 1.0,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { funds: 2.5 }, input: { food: 0.5, goods: 0.5 }, population: 0, taxBasePerSec: 10.0,
    minAge: 'connectivity',
  },
  solarFarm: {
    kind: 'solarFarm', name: 'Solar Farm', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 3, costFunds: 700, costMaterials: 250,
    buildSeconds: 35, upkeepFundsPerSec: 0.5,
    powerDemand: 0, powerSupply: 15, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
  },
  nuclearPlant: {
    kind: 'nuclearPlant', name: 'Nuclear Plant', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 4, costFunds: 2500, costMaterials: 1000,
    buildSeconds: 100, upkeepFundsPerSec: 2.5,
    powerDemand: 0, powerSupply: 60, waterDemand: 6, waterSupply: 0,
    output: {}, input: { fuel: 0.5 }, population: 0, taxBasePerSec: 8.0,
    minAge: 'industry',
  },
  desalination: {
    kind: 'desalination', name: 'Desalination Plant', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 800, costMaterials: 300,
    buildSeconds: 40, upkeepFundsPerSec: 1.0,
    powerDemand: 6, powerSupply: 0, waterDemand: 0, waterSupply: 40,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'industry',
  },
  hospital: {
    kind: 'hospital', name: 'Hospital', zone: ZoneType.COMMERCIAL,
    footprintW: 3, footprintH: 3, costFunds: 800, costMaterials: 280,
    buildSeconds: 40, upkeepFundsPerSec: 1.2,
    powerDemand: 4, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { manpower: 0.4 }, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'connectivity',
  },
  university: {
    kind: 'university', name: 'University', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 3, costFunds: 1400, costMaterials: 500,
    buildSeconds: 60, upkeepFundsPerSec: 1.8,
    powerDemand: 5, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { research: 1.0 }, input: {}, population: 0, taxBasePerSec: 8.0,
    minAge: 'connectivity',
  },
  school: {
    kind: 'school', name: 'School', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 250, costMaterials: 80,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.25 }, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'foundation',
  },
  // Workstream Z (2026-09-30): the education research ladder. Kindergarten
  // (0.1/s) < school (0.25/s) < college (0.5/s) < university (1.0/s).
  // Completed kindergartens/schools also boost residential growth
  // (see `educationGrowthBonus`).
  kindergarten: {
    kind: 'kindergarten', name: 'Kindergarten', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 150, costMaterials: 50,
    buildSeconds: 12, upkeepFundsPerSec: 0.2,
    powerDemand: 1, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.1 }, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'foundation',
  },
  college: {
    kind: 'college', name: 'College', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 400, costMaterials: 120,
    buildSeconds: 30, upkeepFundsPerSec: 0.8,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { research: 0.5 }, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
  },
  // Workstream W (2026-09-30): civic amenities. Library and park are
  // placeable anywhere on land (UTILITY_ZONE, like the education
  // buildings); each completed one counts as an amenity TYPE in the
  // desirability model (+5 within 12 cells, toward the +20 amenity cap —
  // see the amenity table in sim/desirability.ts).
  library: {
    kind: 'library', name: 'Library', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 200, costMaterials: 60,
    buildSeconds: 20, upkeepFundsPerSec: 0.3,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.15 }, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'foundation',
  },
  park: {
    kind: 'park', name: 'Park', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 250, costMaterials: 80,
    buildSeconds: 15, upkeepFundsPerSec: 0.2,
    powerDemand: 0, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 0.5,
    minAge: 'foundation',
  },
  monument: {
    kind: 'monument', name: 'Monument', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 3000, costMaterials: 1200,
    buildSeconds: 90, upkeepFundsPerSec: 2.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { influence: 1.0 }, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'information',
  },
  // ------------------------------------------------------------------
  // Phase 2 (grand expansion, 2026-09-30): the utility plant ladder.
  // All zone: UTILITY_ZONE (placeable anywhere on land). Balance notes:
  // coal/gas are cheap and strong but foul adjacent water sources and
  // need combustionTech; wind/solar are the clean baseline (wind is
  // intermittent on a seeded cycle, solar is day-only); hydro needs a
  // river/coast adjacency; geothermal is steady but late; fusion is the
  // ascendance ultimate behind fusionResearch. Water: wells are cheap
  // and weak (groundwaterSurvey), treatment adds system capacity and
  // scrubs fouled sources, towers/reservoirs buffer intermittency
  // (gridStorage). Substations/pumping stations inject lines/pipes
  // onto the road grid.
  // ------------------------------------------------------------------
  coalPlant: {
    kind: 'coalPlant', name: 'Coal Plant', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 500, costMaterials: 200,
    buildSeconds: 40, upkeepFundsPerSec: 0.9,
    powerDemand: 0, powerSupply: 30, waterDemand: 3, waterSupply: 0,
    output: {}, input: { fuel: 0.8 }, population: 0, taxBasePerSec: 3.0,
    minAge: 'industry', requiredUpgrade: 'combustionTech', fouling: true,
  },
  gasPlant: {
    kind: 'gasPlant', name: 'Gas Plant', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 280,
    buildSeconds: 45, upkeepFundsPerSec: 1.0,
    powerDemand: 0, powerSupply: 35, waterDemand: 2, waterSupply: 0,
    output: {}, input: { fuel: 1.0 }, population: 0, taxBasePerSec: 3.5,
    minAge: 'industry', requiredUpgrade: 'combustionTech', fouling: true,
  },
  windFarm: {
    kind: 'windFarm', name: 'Wind Farm', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 450, costMaterials: 150,
    buildSeconds: 30, upkeepFundsPerSec: 0.4,
    powerDemand: 0, powerSupply: 8, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'connectivity',
  },
  hydroDam: {
    kind: 'hydroDam', name: 'Hydro Dam', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 2, costFunds: 1200, costMaterials: 500,
    buildSeconds: 70, upkeepFundsPerSec: 1.0,
    powerDemand: 0, powerSupply: 45, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'industry',
  },
  geothermalPlant: {
    kind: 'geothermalPlant', name: 'Geothermal Plant', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 1600, costMaterials: 600,
    buildSeconds: 80, upkeepFundsPerSec: 1.2,
    powerDemand: 0, powerSupply: 40, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'information',
  },
  fusionPlant: {
    kind: 'fusionPlant', name: 'Fusion Plant', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 4, costFunds: 4000, costMaterials: 1500,
    buildSeconds: 120, upkeepFundsPerSec: 3.0,
    powerDemand: 0, powerSupply: 120, waterDemand: 4, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 8.0,
    minAge: 'ascendance', requiredUpgrade: 'fusionResearch',
  },
  waterWell: {
    kind: 'waterWell', name: 'Water Well', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 200, costMaterials: 60,
    buildSeconds: 15, upkeepFundsPerSec: 0.2,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 10,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'foundation', requiredUpgrade: 'groundwaterSurvey', foulable: true,
  },
  waterTower: {
    kind: 'waterTower', name: 'Water Tower', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 25, upkeepFundsPerSec: 0.3,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', requiredUpgrade: 'gridStorage',
    storageKind: 'water', storageCapacity: 200,
  },
  waterTreatment: {
    kind: 'waterTreatment', name: 'Water Treatment Plant', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 50, upkeepFundsPerSec: 1.2,
    powerDemand: 5, powerSupply: 0, waterDemand: 0, waterSupply: 20,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.5,
    minAge: 'industry',
  },
  reservoir: {
    kind: 'reservoir', name: 'Reservoir', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 4, costFunds: 800, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 0.5,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'industry', requiredUpgrade: 'gridStorage',
    storageKind: 'water', storageCapacity: 800,
  },
  powerSubstation: {
    kind: 'powerSubstation', name: 'Power Substation', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 100,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', conductsPower: true,
  },
  pumpingStation: {
    kind: 'pumpingStation', name: 'Pumping Station', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 100,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', conductsWater: true,
  },
  batteryStation: {
    kind: 'batteryStation', name: 'Battery Station', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 500, costMaterials: 180,
    buildSeconds: 30, upkeepFundsPerSec: 0.4,
    powerDemand: 0, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', requiredUpgrade: 'gridStorage',
    storageKind: 'power', storageCapacity: 300,
  },
  // ------------------------------------------------------------------
  // Phase 3 (grand expansion): the logistics roster (PLAN §3.2).
  // Number rationale (all rates per sim-second, D11 conventions):
  //  - oilWell vs oilRefinery (1.5 fuel/s at 900F/350M, 50 s build):
  //    the well is the cheap primitive — 0.6 fuel/s (40% of the
  //    refinery) at ~1/3 the cost, foundation age so the fuel economy
  //    starts with the first tanks.
  //  - oilRig: offshore (coastal gate, the navalYard/hydroDam
  //    isCoastal precedent). 2.5 fuel/s ≈ 1.7× the refinery at
  //    industry age, with a small materials upkeep (maintenance).
  //  - munitionsFactory (general ammo): 2.0 ammo/s from materials +
  //    funds inputs (gated by the existing starved-input path in
  //    runProduction). ammoStorage 60 = 30 s of output — a working
  //    buffer, not a stockpile (that is the silo's job).
  //  - missilePlant (specialized heavy ordnance): 2.5× the general
  //    rate at ~1.8× the funds cost and a munitionsFactory
  //    prerequisite — the specialized line builds on the general one.
  //    General-vs-specialized is ECONOMIC, not tracked per-shell:
  //    both fill the same integer ammoStock pool (itemized per-shell
  //    inventory is an explicit non-goal, PLAN §13).
  //  - missileSilo: 400 ammo = ~80 s of missilePlant output (5/s) —
  //    the strategic reserve. Materials-heavy (hardened).
  //  - ordnanceDepot: 150 ammo = 75 s of munitionsFactory output —
  //    the cheap forward buffer (~2.7× smaller than the silo).
  //    (Supply trucks shuttle producer→depot in a later workstream.)
  //  - fuelDepot: 250 fuel ≈ 2.5 vehicle tankfuls, cached forward
  //    from the owner's stockpile by the economy tick (rate-limited).
  // Every ammo producer carries ammoStorage in its def — production
  // is never silently dropped (economy.ts runProduction contract).
  // The two producers are reloadPoint: true as well: units resupply
  // at the factory gate straight from the producer's own stock.
  // ------------------------------------------------------------------
  oilWell: {
    kind: 'oilWell', name: 'Oil Well', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 120,
    buildSeconds: 25, upkeepFundsPerSec: 0.5,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: { fuel: 0.6 }, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'foundation',
  },
  oilRig: {
    kind: 'oilRig', name: 'Offshore Oil Rig', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 1400, costMaterials: 600,
    buildSeconds: 60, upkeepFundsPerSec: 2.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: { fuel: 2.5 }, input: { materials: 0.2 }, population: 0,
    taxBasePerSec: 4.0,
    minAge: 'industry',
  },
  munitionsFactory: {
    kind: 'munitionsFactory', name: 'Munitions Factory', zone: ZoneType.INDUSTRIAL,
    footprintW: 4, footprintH: 3, costFunds: 1200, costMaterials: 500,
    buildSeconds: 55, upkeepFundsPerSec: 1.6,
    powerDemand: 6, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: { materials: 0.4, funds: 0.6 }, population: 0,
    taxBasePerSec: 6.0,
    minAge: 'industry',
    ammoProduction: 2.0, ammoStorage: 60, reloadPoint: true,
  },
  missilePlant: {
    kind: 'missilePlant', name: 'Missile Plant', zone: ZoneType.INDUSTRIAL,
    footprintW: 4, footprintH: 3, costFunds: 2200, costMaterials: 900,
    buildSeconds: 80, upkeepFundsPerSec: 2.5,
    powerDemand: 10, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: {}, input: { materials: 0.8, funds: 1.0 }, population: 0,
    taxBasePerSec: 8.0,
    minAge: 'industry', requiredBuilding: 'munitionsFactory',
    ammoProduction: 5.0, ammoStorage: 100, reloadPoint: true,
  },
  missileSilo: {
    kind: 'missileSilo', name: 'Missile Silo', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 700,
    buildSeconds: 50, upkeepFundsPerSec: 1.2,
    powerDemand: 3, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'industry',
    ammoStorage: 400, reloadPoint: true,
  },
  ordnanceDepot: {
    kind: 'ordnanceDepot', name: 'Ordnance Depot', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 400,
    buildSeconds: 40, upkeepFundsPerSec: 1.0,
    powerDemand: 3, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'industry',
    ammoStorage: 150, reloadPoint: true,
  },
  fuelDepot: {
    kind: 'fuelDepot', name: 'Fuel Depot', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 300,
    buildSeconds: 40, upkeepFundsPerSec: 0.8,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'foundation',
    fuelStorage: 250, reloadPoint: true,
  },
};

/** Defs in a fixed order (cheapest funds cost first) — used by growth. */
export const BUILDING_DEF_LIST: BuildingDef[] = [
  BUILDING_DEFS.house,
  BUILDING_DEFS.shop,
  BUILDING_DEFS.farm,
  BUILDING_DEFS.waterPump,
  BUILDING_DEFS.apartment,
  BUILDING_DEFS.factory,
  BUILDING_DEFS.militaryAcademy,
  BUILDING_DEFS.lab,
  BUILDING_DEFS.powerPlant,
];

/** Output multiplier for a building missing power or water (each). */
export const UTILITY_PENALTY = 0.25;
/** Food eaten per resident per sim-second. */
export const FOOD_PER_POP_PER_SEC = 0.02;
/** Road cost per cell. */
export const ROAD_COST_FUNDS = 5;
export const ROAD_COST_MATERIALS = 2;
/** Zone paint cost per cell. */
export const ZONE_COST_FUNDS_PER_CELL = 1;
/** Power-line cost per cell (cheaper than road: just wire, no paving). */
export const POWER_LINE_COST_FUNDS = 3;
export const POWER_LINE_COST_MATERIALS = 1;
/** Water-pipe cost per cell. */
export const PIPE_COST_FUNDS = 3;
export const PIPE_COST_MATERIALS = 1;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Phase 2 (grand expansion): per-utility diagnosis for a building.
 * 'ok' = demand fully met; 'shortage' = on a network (or pool) whose
 * supply ran out before it; 'disconnected' = no network reaches it and
 * the pool fallback couldn't serve it (or it is a plant touching no
 * conductor — the "stranded generator" self-flag). `powered`/`watered`
 * stay the effective booleans the economy and UI already read.
 */
export type UtilityDiag = 'ok' | 'shortage' | 'disconnected';

/** One placed building. Plain data — the renderer draws kind/footprint/pos/facing. */
export interface BuildingRecord {
  id: number;
  kind: BuildingKind;
  owner: number;
  /** Footprint origin cell. */
  cx: number;
  cz: number;
  facing: 0 | 1 | 2 | 3;
  /** Construction progress 0..1. Operates only at 1. */
  progress: number;
  /** Development level 1..3 — multiplies output and tax base. */
  level: number;
  /** False when unfunded (upkeep shortfall) or still constructing. */
  operational: boolean;
  powered: boolean;
  watered: boolean;
  /**
   * Phase 2: per-utility diagnosis (see UtilityDiag). Optional so
   * pre-Phase-2 record literals keep compiling; every read uses
   * `?? 'disconnected'` (AD9 — the veterancy `?? 0` precedent).
   */
  powerDiag?: UtilityDiag;
  waterDiag?: UtilityDiag;
  /**
   * Phase 3 logistics stocks (integer units). `ammoStock` = missiles /
   * ordnance produced by munitions factories and missile plants;
   * `fuelStock` = forward vehicle fuel cached from the owner's fuel
   * stockpile. Optional so pre-Phase-3 record literals keep compiling;
   * every read uses `?? 0` (AD9 — the veterancy `?? 0` precedent).
   */
  ammoStock?: number;
  fuelStock?: number;
  /**
   * Workstream M (user correction 2026-09-30): world tick until which a
   * nuclear plant stays offline after an attack-triggered meltdown.
   * 0/undefined = no meltdown. Set ONLY by the attack path
   * (`attackMeltdownRoll` in utilityNetworks.ts, called from building
   * damage); never by a timer. Snapshotted, digested (AD9).
   */
  meltdownUntilTick?: number;
  /**
   * Phase 3: stock reserved by in-flight `resupply` orders (see
   * commands.ts). Reservations are atomic at apply time and released on
   * fulfillment or timeout — validate≡apply agreement (AD6 lesson).
   * Optional, reads use `?? 0`.
   */
  reservedAmmo?: number;
  reservedFuel?: number;
}

/** One player's stockpiles and policy. */
export interface PlayerState {
  id: number;
  name: string;
  funds: number;
  materials: number;
  fuel: number;
  food: number;
  research: number;
  goods: number;
  influence: number;
  manpower: number;
  /** Tax rates 0..1 for [residential, commercial, industrial]. */
  taxRates: [number, number, number];
  /** Derived each economy tick from residential capacity. */
  population: number;
  /**
   * Phase 3 city specialization: 'balanced' (no modifiers) or a focus
   * that boosts matching-zone building output by 25% at a 10% penalty
   * to other zoned buildings. Set via the `setSpecialization` command.
   */
  specialization: CitySpecialization;
}

/** The whole city. Lives on `World.city`; snapshotted and digested. */
export interface CityState {
  /** Paved cells, sorted ascending. */
  roads: number[];
  /**
   * Phase 2: power-line cells, sorted ascending. Conduct power; the
   * long-hop tool for plant→grid hookup and reaching far zones.
   */
  powerLines: number[];
  /** Phase 2: water-pipe cells, sorted ascending. Conduct water. */
  pipes: number[];
  /**
   * Phase 2: structural-change counter. Incremented by every structural
   * command (build/demolish road/line/pipe/building/zone) — the derived
   * utility-network model (utilityNetworks.ts) recomputes only when this
   * changes. Plain data: snapshotted, digested, defaults to 0 on legacy
   * saves (no version bump — additive field, neutral default).
   */
  utilityEpoch: number;
  /** Painted cells, sorted by cell. */
  zones: Array<{ cell: number; zone: ZoneType }>;
  /** Placed buildings, placement (id) order. */
  buildings: BuildingRecord[];
  nextBuildingId: number;
  players: PlayerState[];
  /** Set by the economy tick when food demand outruns supply. */
  foodShortage: boolean;
  /** Phase 3: active trade routes (established via command). */
  tradeRoutes: TradeRoute[];
}

/** Starting stockpiles for a fresh player. */
export const STARTING_STOCKS = {
  funds: 4000,
  materials: 1500,
  fuel: 400,
  food: 500,
  research: 0,
  goods: 0,
  influence: 0,
  manpower: 20,
} as const;

/** Default tax rate per zone (10%). */
export const DEFAULT_TAX_RATE = 0.1;

function createPlayer(id: number, name: string): PlayerState {
  return {
    id,
    name,
    funds: STARTING_STOCKS.funds,
    materials: STARTING_STOCKS.materials,
    fuel: STARTING_STOCKS.fuel,
    food: STARTING_STOCKS.food,
    research: STARTING_STOCKS.research,
    goods: STARTING_STOCKS.goods,
    influence: STARTING_STOCKS.influence,
    manpower: STARTING_STOCKS.manpower,
    taxRates: [DEFAULT_TAX_RATE, DEFAULT_TAX_RATE, DEFAULT_TAX_RATE],
    population: 0,
    specialization: 'balanced',
  };
}

/** Fresh city: no roads, no zones, two players (0 = human, 1 = AI rival). */
export function initCity(): CityState {
  return {
    roads: [],
    powerLines: [],
    pipes: [],
    utilityEpoch: 0,
    zones: [],
    buildings: [],
    nextBuildingId: 1,
    players: [createPlayer(0, 'Player'), createPlayer(1, 'Rival')],
    foodShortage: false,
    tradeRoutes: [],
  };
}

/**
 * Phase 2: bump the structural-change counter. Called by every mutator
 * that changes the utility topology: road/line/pipe build/demolish,
 * building place/demolish, zone paint. The derived utility-network
 * model keys its cache on this value and recomputes only on change.
 * Workstream W: the derived desirability model shares the same key
 * (see sim/desirability.ts `desirabilityCacheKey`) — amenities and
 * completed-building sets only change here.
 */
export function bumpUtilityEpoch(city: CityState): void {
  city.utilityEpoch += 1;
}

/** Player record or undefined for a bad id. */
export function getPlayer(city: CityState, id: number): PlayerState | undefined {
  return city.players[id];
}

/** World-space rectangle of a building footprint (for the renderer). */
export function buildingWorldRect(b: BuildingRecord): { x0: number; z0: number; x1: number; z1: number } {
  const def = BUILDING_DEFS[b.kind];
  return {
    x0: -MAP_HALF_SIZE + b.cx * CELL_WORLD_SIZE,
    z0: -MAP_HALF_SIZE + b.cz * CELL_WORLD_SIZE,
    x1: -MAP_HALF_SIZE + (b.cx + def.footprintW) * CELL_WORLD_SIZE,
    z1: -MAP_HALF_SIZE + (b.cz + def.footprintH) * CELL_WORLD_SIZE,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Zone painted on a cell, or undefined. Binary search over sorted zones. */
export function zoneAt(city: CityState, cell: number): ZoneType | undefined {
  let lo = 0;
  let hi = city.zones.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rec = city.zones[mid] as { cell: number; zone: ZoneType };
    if (rec.cell === cell) return rec.zone;
    if (rec.cell < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** Building covering a cell, or undefined. Linear — fine at Phase-1 scale. */
export function buildingAtCell(city: CityState, cell: number): BuildingRecord | undefined {
  const { cx, cz } = cellCoords(cell);
  for (const b of city.buildings) {
    const def = BUILDING_DEFS[b.kind];
    if (cx >= b.cx && cx < b.cx + def.footprintW && cz >= b.cz && cz < b.cz + def.footprintH) {
      return b;
    }
  }
  return undefined;
}

/** True when any footprint cell is orthogonally adjacent to a water cell. */
export function isCoastal(t: TerrainData, cx: number, cz: number, w: number, h: number): boolean {
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (
        (inBounds(nx + 1, nz) && cellIsWater(t, nx + 1, nz)) ||
        (inBounds(nx - 1, nz) && cellIsWater(t, nx - 1, nz)) ||
        (inBounds(nx, nz + 1) && cellIsWater(t, nx, nz + 1)) ||
        (inBounds(nx, nz - 1) && cellIsWater(t, nx, nz - 1))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Road connectivity: are two cells linked through paved cells (4-way)?
 * BFS over the road set — for later traffic/service systems.
 */
export function areRoadsConnected(city: CityState, a: number, b: number): boolean {
  if (!sortedHas(city.roads, a) || !sortedHas(city.roads, b)) return false;
  if (a === b) return true;
  const visited = new Set<number>([a]);
  const queue: number[] = [a];
  while (queue.length > 0) {
    const cur = queue.pop() as number;
    const { cx, cz } = cellCoords(cur);
    const neighbors: Array<[number, number]> = [
      [cx + 1, cz],
      [cx - 1, cz],
      [cx, cz + 1],
      [cx, cz - 1],
    ];
    for (const [nx, nz] of neighbors) {
      if (!inBounds(nx, nz)) continue;
      const n = cellIndex(nx, nz);
      if (n === b) return true;
      if (!visited.has(n) && sortedHas(city.roads, n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Placement validation (shared by commands and growth)
// ---------------------------------------------------------------------------

export interface Placement {
  kind: BuildingKind;
  owner: number;
  cx: number;
  cz: number;
  facing: 0 | 1 | 2 | 3;
}

/**
 * Validate a building placement. Returns null when legal, else the reason.
 * Pure — does not mutate. Used at command enqueue AND apply time.
 */
export function validatePlacement(t: TerrainData, city: CityState, p: Placement): string | null {
  const def = BUILDING_DEFS[p.kind];
  if (!def) return `unknown building kind '${p.kind}'`;
  if (!Number.isInteger(p.owner) || !getPlayer(city, p.owner)) {
    return `unknown owner player ${p.owner}`;
  }
  if (p.facing < 0 || p.facing > 3) return `facing must be 0..3, got ${p.facing}`;
  if (!inBounds(p.cx, p.cz) || !inBounds(p.cx + def.footprintW - 1, p.cz + def.footprintH - 1)) {
    return `${def.name}: footprint out of map bounds`;
  }
  const cells = footprintCells(p.cx, p.cz, def.footprintW, def.footprintH);
  for (const cell of cells) {
    const { cx, cz } = cellCoords(cell);
    if (cellIsWater(t, cx, cz)) return `${def.name}: cannot build on water`;
    if (sortedHas(city.roads, cell)) return `${def.name}: footprint overlaps a road`;
    const other = buildingAtCell(city, cell);
    if (other) return `${def.name}: footprint overlaps building #${other.id}`;
    if (def.zone !== UTILITY_ZONE) {
      const z = zoneAt(city, cell);
      if (z !== def.zone) {
        const want = def.zone === ZoneType.RESIDENTIAL ? 'residential' : def.zone === ZoneType.COMMERCIAL ? 'commercial' : 'industrial';
        return `${def.name}: needs ${want} zoning`;
      }
    }
  }
  // Roads are optional (user directive 2026-09-30): buildings place
  // wherever otherwise legal, and plants/pumps supply without them.
  // Roster expansion: the naval yard is coastal construction — at least one
  // footprint cell must touch water (makes coastline valuable).
  if (p.kind === 'navalYard' && !isCoastal(t, p.cx, p.cz, def.footprintW, def.footprintH)) {
    return `${def.name}: must be built on the coast (adjacent to water)`;
  }
  // Phase 2: hydro dams need a river or coastline — at least one
  // footprint cell orthogonally adjacent to water.
  if (p.kind === 'hydroDam' && !isCoastal(t, p.cx, p.cz, def.footprintW, def.footprintH)) {
    return `${def.name}: must be built adjacent to water (river or coast)`;
  }
  // Phase 3: oil rigs are offshore — at least one footprint cell
  // orthogonally adjacent to water (the navalYard/hydroDam isCoastal
  // precedent; desalination carries no adjacency gate in 0.1 Alpha).
  if (p.kind === 'oilRig' && !isCoastal(t, p.cx, p.cz, def.footprintW, def.footprintH)) {
    return `${def.name}: must be built adjacent to water (offshore)`;
  }
  const player = getPlayer(city, p.owner) as PlayerState;
  if (player.funds < def.costFunds || player.materials < def.costMaterials) {
    return `${def.name}: cannot afford (needs ${def.costFunds} funds + ${def.costMaterials} materials)`;
  }
  return null;
}

/** Place a validated building. Deducts costs, creates the record. */
export function placeBuilding(city: CityState, p: Placement): BuildingRecord {
  const player = getPlayer(city, p.owner) as PlayerState;
  const def = BUILDING_DEFS[p.kind];
  player.funds -= def.costFunds;
  player.materials -= def.costMaterials;
  const record: BuildingRecord = {
    id: city.nextBuildingId,
    kind: p.kind,
    owner: p.owner,
    cx: p.cx,
    cz: p.cz,
    facing: p.facing,
    progress: 0,
    level: 1,
    operational: false,
    // 1-tick bootstrap for the cross-utility hooks (economy.ts): a
    // hooked plant (nuclearPlant needs water, desalination needs power)
    // reads the PREVIOUS tick's flags, so a fresh building starts
    // assumed-served — otherwise a grid of only hooked plants could
    // never prime itself. The first economy tick recomputes the real
    // flags before anything else reads them.
    powered: true,
    watered: true,
    // Phase 2: the economy tick recomputes these; 'disconnected' is the
    // honest pre-first-tick state (nothing evaluated yet).
    powerDiag: 'disconnected',
    waterDiag: 'disconnected',
    // Phase 3 logistics: depots start empty; the economy tick fills
    // producer stocks and shuttles fuel from the owner's stockpile.
    ammoStock: 0,
    fuelStock: 0,
  };
  city.nextBuildingId += 1;
  city.buildings.push(record);
  // A new footprint can change the utility topology (plants seed
  // networks, substations conduct) — invalidate the derived model.
  bumpUtilityEpoch(city);
  return record;
}

/** Remove a building by id. Frees its cells. No refund (D11). */
export function demolishBuilding(city: CityState, id: number): boolean {
  const index = city.buildings.findIndex((b) => b.id === id);
  if (index === -1) return false;
  city.buildings.splice(index, 1);
  bumpUtilityEpoch(city);
  return true;
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

/**
 * Desirability of developing one more building: 0..1. The player's levers
 * are the tax rate (linear penalty, floored at 10%) and utility headroom.
 */
export function growthDesirability(taxRate: number, powerHeadroom: number, waterHeadroom: number): number {
  const taxFactor = Math.max(0.1, 1 - taxRate * 1.2);
  const powerFactor = powerHeadroom > 0 ? 1 : 0.25;
  const waterFactor = waterHeadroom > 0 ? 1 : 0.25;
  return 0.55 * taxFactor * powerFactor * waterFactor;
}

/**
 * Workstream Z (2026-09-30): the education growth lever. Each completed
 * (progress >= 1) kindergarten or school owned by `owner` adds +0.05
 * residential growth desirability, additive and capped at +0.25.
 * Unfinished or demolished buildings contribute nothing. Pure and
 * deterministic — used in `tryAutoDevelop` (residential samples only).
 */
export function educationGrowthBonus(world: World, owner: number): number {
  let count = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== owner) continue;
    if (b.kind !== 'kindergarten' && b.kind !== 'school') continue;
    if ((b.progress ?? 0) < 1) continue;
    count += 1;
  }
  return Math.min(0.25, 0.05 * count);
}

/** Cheapest def for a zone the player can afford AND has unlocked, or undefined. */
function affordableDefForZone(world: World, zone: ZoneType, owner: number): BuildingDef | undefined {
  const city = world.city;
  const player = getPlayer(city, owner) as PlayerState;
  for (const def of BUILDING_DEF_LIST) {
    if (def.zone !== zone || player.funds < def.costFunds || player.materials < def.costMaterials) continue;
    // Prerequisite buildings (e.g. Military Academy needs a Barracks)
    // gate auto-growth exactly like manual placement.
    if (def.requiredBuilding && !hasProductionBuilding(world, owner, def.requiredBuilding)) continue;
    // Phase 2: research-gated kinds (plant ladder) never auto-develop
    // before their upgrade is researched — same rule as manual placement.
    if (def.requiredUpgrade && !((world.upgrades[owner] ?? []) as string[]).includes(def.requiredUpgrade)) continue;
    return def;
  }
  return undefined;
}

/**
 * Try to auto-develop one building near a zoned cell for a player.
 * Deterministic: RNG from the 'city' stream, fixed scan order.
 */
function tryAutoDevelop(
  t: TerrainData,
  world: World,
  owner: number,
  powerHeadroom: number,
  waterHeadroom: number,
): boolean {
  const city = world.city;
  const player = getPlayer(city, owner);
  if (!player || city.zones.length === 0) return false;
  const bank = rngBank(world);
  // Workstream Z: completed kindergartens/schools make residential zones
  // more attractive to organic growth (computed once per pulse, not per
  // attempt — it only changes when a building completes or is demolished).
  const eduBonus = educationGrowthBonus(world, owner);
  // Workstream W: the derived desirability model (rebuilt only on
  // structural change — never per tick). Residential samples get a
  // migration pull toward nicer cells, with a weak affordability pull
  // so nice-but-affordable cells grow fastest (see `migrationPull`).
  const desirModel = getDesirabilityModel(t, world);
  // Sample a few zoned cells; each sample is one development attempt.
  const attempts = Math.min(8, city.zones.length);
  for (let a = 0; a < attempts; a++) {
    const zi = bank.intBelow('city', city.zones.length);
    const zrec = city.zones[zi] as { cell: number; zone: ZoneType };
    const { cx, cz } = cellCoords(zrec.cell);
    if (buildingAtCell(city, zrec.cell) || sortedHas(city.roads, zrec.cell)) continue;
    // No road gate (user directive 2026-09-30): zoned houses develop with
    // or without roads; the desirability roll below is the only filter.
    let desirability = growthDesirability(player.taxRates[zrec.zone] as number, powerHeadroom, waterHeadroom);
    // Workstream Z: education bonus applies to residential growth only.
    // Workstream W: migration — layer the desirability/land-value pulls
    // onto the existing demand loop (multiply, never replace).
    if (zrec.zone === ZoneType.RESIDENTIAL) {
      desirability += eduBonus;
      const d01 = cellDesirability(desirModel, zrec.cell) / 100;
      desirability = Math.min(1, desirability * migrationPull(d01));
    }
    if (bank.next('city') >= desirability) continue;
    const def = affordableDefForZone(world, zrec.zone, owner);
    if (!def) return false; // broke: can't afford anything in this zone
    // Anchor the footprint so it covers the sampled cell; scan origins
    // deterministically and take the first legal placement.
    for (let oz = cz - def.footprintH + 1; oz <= cz; oz++) {
      for (let ox = cx - def.footprintW + 1; ox <= cx; ox++) {
        const placement: Placement = { kind: def.kind, owner, cx: ox, cz: oz, facing: 0 };
        if (validatePlacement(t, city, placement) === null) {
          placeBuilding(city, placement);
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Organic growth step, called by the economy tick. Growth pulses every 10
 * sim-seconds (not every second — a building every few seconds is the
 * genre's pace); each pulse allows up to two developments per player while
 * food isn't short.
 */
export function runGrowth(t: TerrainData, world: World, powerHeadroom: number[], waterHeadroom: number[]): void {
  if (world.tick % 300 !== 0) return;
  const city = world.city;
  if (city.foodShortage) return;
  for (const player of city.players) {
    const ph = powerHeadroom[player.id] as number;
    const wh = waterHeadroom[player.id] as number;
    for (let n = 0; n < 2; n++) {
      if (!tryAutoDevelop(t, world, player.id, ph, wh)) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function payloadCells(payload: Record<string, unknown>): number[] | null {
  const v = payload['cells'];
  if (!Array.isArray(v)) return null;
  const cells: number[] = [];
  for (const c of v) {
    if (typeof c !== 'number' || !Number.isInteger(c)) return null;
    cells.push(c);
  }
  return cells;
}

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function payloadNum(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function payloadStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

function validateRoadCells(t: TerrainData, city: CityState, cells: number[]): string | null {
  if (cells.length === 0) return 'buildRoad: cells must be a non-empty array';
  if (cells.length > 512) return 'buildRoad: at most 512 cells per command';
  const seen = new Set<number>();
  for (const cell of cells) {
    if (cell < 0 || cell >= CITY_GRID_CELLS * CITY_GRID_CELLS) return `buildRoad: cell ${cell} out of range`;
    if (seen.has(cell)) return `buildRoad: duplicate cell ${cell}`;
    seen.add(cell);
    const { cx, cz } = cellCoords(cell);
    if (cellIsWater(t, cx, cz)) return 'buildRoad: cannot pave water';
    if (sortedHas(city.roads, cell)) return `buildRoad: cell ${cell} already paved`;
    if (buildingAtCell(city, cell)) return `buildRoad: cell ${cell} occupied by a building`;
  }
  return null;
}

/**
 * Phase 2: validate power-line / water-pipe cells. Unlike roads, lines
 * and pipes MAY cross water (the long-hop tool for reaching across
 * rivers); they may overlap roads but not buildings or their own kind.
 */
function validateConductorCells(
  city: CityState,
  cells: number[],
  existing: number[],
  label: string,
): string | null {
  if (cells.length === 0) return `${label}: cells must be a non-empty array`;
  if (cells.length > 512) return `${label}: at most 512 cells per command`;
  const seen = new Set<number>();
  for (const cell of cells) {
    if (cell < 0 || cell >= CITY_GRID_CELLS * CITY_GRID_CELLS) return `${label}: cell ${cell} out of range`;
    if (seen.has(cell)) return `${label}: duplicate cell ${cell}`;
    seen.add(cell);
    if (sortedHas(existing, cell)) return `${label}: cell ${cell} already has ${label === 'buildPowerLine' ? 'a power line' : 'a pipe'}`;
    if (buildingAtCell(city, cell)) return `${label}: cell ${cell} occupied by a building`;
  }
  return null;
}

/** Age order for minAge gating. Local copy of AGE_ORDER (ages.ts) —
// city.ts cannot import ages.ts (that module imports getPlayer from here),
// so the order is mirrored with a comment instead of shared. */
const AGE_ORDER_LOCAL: readonly Age[] = [
  'foundation',
  'connectivity',
  'industry',
  'information',
  'ascendance',
];

/** True when the world's current age meets a building's minimum age. */
export function isBuildingAgeMet(currentAge: Age, minAge: Age): boolean {
  return AGE_ORDER_LOCAL.indexOf(currentAge) >= AGE_ORDER_LOCAL.indexOf(minAge);
}

/**
 * True when the owner holds a completed production building of `kind` —
 * either a real one on the city grid (progress >= 1) or one the Classic
 * AI virtually constructed (spec docs/research/roster-expansion.md §7.1:
 * the AI pays the full funds/materials cost and waits the full build
 * time, but owns no physical footprint — it paints no zones and lays no
 * roads). Human players never have virtual buildings, so for them this
 * is exactly the real-building check.
 *
 * Shared by `spawnUnit` production gating (units.ts) and `researchUpgrade`
 * building prerequisites (upgrades.ts) so the AI's virtual construction
 * unlocks the same roster a physical building would.
 */
export function hasProductionBuilding(world: World, owner: number, kind: BuildingKind): boolean {
  for (const b of world.city.buildings) {
    if (b.owner === owner && b.kind === kind && b.progress >= 1) return true;
  }
  // AI virtual construction (see sim/ai.ts): completed virtual buildings
  // live on the AI player's state, not on the city grid.
  const ai = world.ai.players.find((p) => p.owner === owner);
  return ai !== undefined && ai.virtualBuildings.completed.includes(kind);
}

function makeSpecs(t: TerrainData): Record<string, CommandSpec> {
  const buildRoad: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'buildRoad: unknown owner';
      const cells = payloadCells(cmd.payload);
      if (cells === null) return 'buildRoad: payload.cells must be an array of integers';
      const reason = validateRoadCells(t, world.city, cells);
      if (reason) return reason;
      const player = getPlayer(world.city, owner) as PlayerState;
      const costF = cells.length * ROAD_COST_FUNDS;
      const costM = cells.length * ROAD_COST_MATERIALS;
      if (player.funds < costF || player.materials < costM) {
        return `buildRoad: cannot afford (needs ${costF} funds + ${costM} materials)`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const cells = payloadCells(cmd.payload) as number[];
      const player = getPlayer(world.city, owner) as PlayerState;
      player.funds -= cells.length * ROAD_COST_FUNDS;
      player.materials -= cells.length * ROAD_COST_MATERIALS;
      for (const cell of cells) sortedInsert(world.city.roads, cell);
      bumpUtilityEpoch(world.city);
      return cells.length;
    },
  };

  /**
   * Phase 2 (grand expansion): drag-painted utility conductors.
   * buildPowerLine / buildPipe mirror buildRoad (cell arrays ≤512,
   * per-cell funds+materials cost, sortedInsert) but conduct only their
   * own utility and may cross water. They are the long-hop tool:
   * plant→grid hookup, crossing wilderness/water, reaching a far zone
   * without a road. Roads keep conducting both utilities automatically.
   */
  function makeConductorSpec(
    label: 'buildPowerLine' | 'buildPipe',
    target: (city: CityState) => number[],
    costFunds: number,
    costMaterials: number,
  ): CommandSpec {
    return {
      validate(cmd, world): string | null {
        const owner = payloadInt(cmd.payload, 'owner');
        if (owner === null || !getPlayer(world.city, owner)) return `${label}: unknown owner`;
        const cells = payloadCells(cmd.payload);
        if (cells === null) return `${label}: payload.cells must be an array of integers`;
        const reason = validateConductorCells(world.city, cells, target(world.city), label);
        if (reason) return reason;
        const player = getPlayer(world.city, owner) as PlayerState;
        const needF = cells.length * costFunds;
        const needM = cells.length * costMaterials;
        if (player.funds < needF || player.materials < needM) {
          return `${label}: cannot afford (needs ${needF} funds + ${needM} materials)`;
        }
        return null;
      },
      apply(cmd, world): unknown {
        const owner = payloadInt(cmd.payload, 'owner') as number;
        const cells = payloadCells(cmd.payload) as number[];
        const player = getPlayer(world.city, owner) as PlayerState;
        player.funds -= cells.length * costFunds;
        player.materials -= cells.length * costMaterials;
        const arr = target(world.city);
        for (const cell of cells) sortedInsert(arr, cell);
        bumpUtilityEpoch(world.city);
        return cells.length;
      },
    };
  }

  const buildPowerLine = makeConductorSpec(
    'buildPowerLine', (city) => city.powerLines, POWER_LINE_COST_FUNDS, POWER_LINE_COST_MATERIALS,
  );
  const buildPipe = makeConductorSpec(
    'buildPipe', (city) => city.pipes, PIPE_COST_FUNDS, PIPE_COST_MATERIALS,
  );

  const paintZone: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'paintZone: unknown owner';
      const zone = payloadInt(cmd.payload, 'zone');
      if (zone === null || (zone !== 0 && zone !== 1 && zone !== 2)) {
        return 'paintZone: zone must be 0 (residential), 1 (commercial) or 2 (industrial)';
      }
      const x0 = payloadInt(cmd.payload, 'x0');
      const z0 = payloadInt(cmd.payload, 'z0');
      const x1 = payloadInt(cmd.payload, 'x1');
      const z1 = payloadInt(cmd.payload, 'z1');
      if (x0 === null || z0 === null || x1 === null || z1 === null) {
        return 'paintZone: payload needs integer x0, z0, x1, z1';
      }
      const ax0 = Math.min(x0, x1);
      const ax1 = Math.max(x0, x1);
      const az0 = Math.min(z0, z1);
      const az1 = Math.max(z0, z1);
      if (!inBounds(ax0, az0) || !inBounds(ax1, az1)) return 'paintZone: rectangle out of map bounds';
      const w = ax1 - ax0 + 1;
      const h = az1 - az0 + 1;
      if (w * h > 4096) return 'paintZone: at most 4096 cells per command';
      for (let cz = az0; cz <= az1; cz++) {
        for (let cx = ax0; cx <= ax1; cx++) {
          if (cellIsWater(t, cx, cz)) return 'paintZone: cannot zone water';
        }
      }
      const player = getPlayer(world.city, owner) as PlayerState;
      const cost = w * h * ZONE_COST_FUNDS_PER_CELL;
      if (player.funds < cost) return `paintZone: cannot afford ${cost} funds`;
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const zone = payloadInt(cmd.payload, 'zone') as ZoneType;
      const ax0 = Math.min(payloadInt(cmd.payload, 'x0') as number, payloadInt(cmd.payload, 'x1') as number);
      const ax1 = Math.max(payloadInt(cmd.payload, 'x0') as number, payloadInt(cmd.payload, 'x1') as number);
      const az0 = Math.min(payloadInt(cmd.payload, 'z0') as number, payloadInt(cmd.payload, 'z1') as number);
      const az1 = Math.max(payloadInt(cmd.payload, 'z0') as number, payloadInt(cmd.payload, 'z1') as number);
      const player = getPlayer(world.city, owner) as PlayerState;
      let painted = 0;
      for (let cz = az0; cz <= az1; cz++) {
        for (let cx = ax0; cx <= ax1; cx++) {
          const cell = cellIndex(cx, cz);
          const existing = zoneAt(world.city, cell);
          if (existing === zone) continue;
          player.funds -= ZONE_COST_FUNDS_PER_CELL;
          painted++;
          // Keep zones sorted by cell: remove then sorted-insert.
          const zi = world.city.zones.findIndex((z) => z.cell === cell);
          if (zi !== -1) world.city.zones.splice(zi, 1);
          const rec = { cell, zone };
          let lo = 0;
          let hi = world.city.zones.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if ((world.city.zones[mid] as { cell: number; zone: ZoneType }).cell < cell) lo = mid + 1;
            else hi = mid;
          }
          world.city.zones.splice(lo, 0, rec);
        }
      }
      // Zone paint changes the served-zone topology — invalidate the
      // derived utility model (Phase 2).
      if (painted > 0) bumpUtilityEpoch(world.city);
      return painted;
    },
  };

  const placeBuildingSpec: CommandSpec = {
    validate(cmd, world): string | null {
      const kind = payloadStr(cmd.payload, 'kind') as BuildingKind | null;
      const owner = payloadInt(cmd.payload, 'owner');
      const cx = payloadInt(cmd.payload, 'cx');
      const cz = payloadInt(cmd.payload, 'cz');
      const facing = payloadInt(cmd.payload, 'facing') ?? 0;
      if (kind === null || !BUILDING_DEFS[kind]) return `placeBuilding: unknown kind '${cmd.payload['kind']}'`;
      if (owner === null || cx === null || cz === null) {
        return 'placeBuilding: payload needs kind, owner, cx, cz (facing optional)';
      }
      // Age gating: each building kind has a minimum age (spec §6). The old
      // aegisControl/stormArray Ascendance special-case is subsumed by their
      // minAge: 'ascendance' defs. (Reads world.ages directly instead of
      // importing ages.ts — that module imports getPlayer from here, so an
      // import would be a cycle.)
      const bdef = BUILDING_DEFS[kind];
      if (!isBuildingAgeMet(world.ages.age, bdef.minAge)) {
        return `placeBuilding: ${bdef.name} requires the ${bdef.minAge} age`;
      }
      // Prerequisite building (e.g. Military Academy requires a completed
      // Barracks) — real or AI-virtually-constructed, like unit training.
      if (bdef.requiredBuilding && !hasProductionBuilding(world, owner as number, bdef.requiredBuilding)) {
        const need = BUILDING_DEFS[bdef.requiredBuilding]?.name ?? bdef.requiredBuilding;
        return `placeBuilding: ${bdef.name} requires a completed ${need}`;
      }
      // Phase 2: research gate for the plant ladder (e.g. Coal Plant
      // requires combustionTech). Read world.upgrades directly instead
      // of importing upgrades.ts — that module imports this one.
      if (bdef.requiredUpgrade && !((world.upgrades[owner as number] ?? []) as string[]).includes(bdef.requiredUpgrade)) {
        return `placeBuilding: ${bdef.name} requires the ${bdef.requiredUpgrade} upgrade`;
      }
      if (facing < 0 || facing > 3) return 'placeBuilding: facing must be 0..3';
      return validatePlacement(t, world.city, { kind, owner, cx, cz, facing: facing as 0 | 1 | 2 | 3 });
    },
    apply(cmd, world): unknown {
      const kind = payloadStr(cmd.payload, 'kind') as BuildingKind;
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const cx = payloadInt(cmd.payload, 'cx') as number;
      const cz = payloadInt(cmd.payload, 'cz') as number;
      const facing = (payloadInt(cmd.payload, 'facing') ?? 0) as 0 | 1 | 2 | 3;
      return placeBuilding(world.city, { kind, owner, cx, cz, facing }).id;
    },
  };

  const demolish: CommandSpec = {
    validate(cmd, world): string | null {
      const cx = payloadInt(cmd.payload, 'cx');
      const cz = payloadInt(cmd.payload, 'cz');
      if (cx === null || cz === null || !inBounds(cx, cz)) {
        return 'demolish: payload needs in-bounds integer cx, cz';
      }
      const cell = cellIndex(cx, cz);
      // Phase 2: demolish works cell-wise on buildings, roads, power
      // lines and pipes alike.
      if (
        !buildingAtCell(world.city, cell) &&
        !sortedHas(world.city.roads, cell) &&
        !sortedHas(world.city.powerLines, cell) &&
        !sortedHas(world.city.pipes, cell)
      ) {
        return 'demolish: nothing to demolish at that cell';
      }
      return null;
    },
    apply(cmd, world): unknown {
      const cx = payloadInt(cmd.payload, 'cx') as number;
      const cz = payloadInt(cmd.payload, 'cz') as number;
      const cell = cellIndex(cx, cz);
      const b = buildingAtCell(world.city, cell);
      // No refund (D11): demolition is pure loss, like the genre standard.
      if (b) {
        // Phase 3 logistics: release in-flight resupply reservations
        // against the demolished depot. This loop mirrors
        // releaseDepotReservations (commands.ts) inline on purpose: a
        // static city→commands import would close a
        // city→commands→movement→pathfinding cycle that evaluates
        // pathfinding while city is still initializing (GRID_CELLS NaN
        // under the SSR transform — caught by sim.ai-soak). If the
        // release semantics ever change, update both.
        for (const u of world.units) {
          if ((u.resupplyDepotId ?? 0) === b.id) {
            u.resupplyDepotId = 0;
            u.resupplyReservedAmmo = 0;
            u.resupplyReservedFuel = 0;
          }
        }
        return { removed: 'building', id: demolishBuilding(world.city, b.id) ? b.id : -1 };
      }
      // demolishBuilding bumps the epoch for buildings; cell removal
      // below bumps it for conductors (Phase 2 structural changes).
      const i = world.city.roads.indexOf(cell);
      if (i !== -1) {
        world.city.roads.splice(i, 1);
        bumpUtilityEpoch(world.city);
        return { removed: 'road', cell };
      }
      const li = world.city.powerLines.indexOf(cell);
      if (li !== -1) {
        world.city.powerLines.splice(li, 1);
        bumpUtilityEpoch(world.city);
        return { removed: 'powerLine', cell };
      }
      const pi = world.city.pipes.indexOf(cell);
      if (pi !== -1) {
        world.city.pipes.splice(pi, 1);
        bumpUtilityEpoch(world.city);
        return { removed: 'pipe', cell };
      }
      return { removed: 'none', cell };
    },
  };

  const setTaxRate: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'setTaxRate: unknown owner';
      const zone = payloadInt(cmd.payload, 'zone');
      if (zone === null || (zone !== 0 && zone !== 1 && zone !== 2)) {
        return 'setTaxRate: zone must be 0, 1 or 2';
      }
      const rate = payloadNum(cmd.payload, 'rate');
      if (rate === null || rate < 0 || rate > 1) return 'setTaxRate: rate must be between 0 and 1';
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const zone = payloadInt(cmd.payload, 'zone') as ZoneType;
      const rate = payloadNum(cmd.payload, 'rate') as number;
      (getPlayer(world.city, owner) as PlayerState).taxRates[zone] = rate;
      return rate;
    },
  };

  const setSpecialization: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'setSpecialization: unknown owner';
      const spec = payloadStr(cmd.payload, 'specialization');
      if (typeof spec !== 'string' || !CITY_SPECIALIZATIONS.includes(spec as CitySpecialization)) {
        return `setSpecialization: specialization must be one of ${CITY_SPECIALIZATIONS.join(', ')}`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const spec = payloadStr(cmd.payload, 'specialization') as CitySpecialization;
      (getPlayer(world.city, owner) as PlayerState).specialization = spec;
      return spec;
    },
  };

  return { buildRoad, buildPowerLine, buildPipe, paintZone, placeBuilding: placeBuildingSpec, demolish, setTaxRate, setSpecialization };
}

/** Register the city-building command kinds on a queue. Needs the terrain for placement rules. */

/** Register the city-building command kinds on a queue. Needs the terrain for placement rules. */
export function registerCityCommands(queue: CommandQueue, t: TerrainData): void {
  const specs = makeSpecs(t);
  for (const kind of Object.keys(specs)) {
    queue.register(kind, specs[kind] as CommandSpec);
  }
}
