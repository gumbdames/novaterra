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
import { fnv1a32 } from './rng';
import type { CommandQueue, CommandSpec } from './commands';
import type { Age } from './ages';
import {
  cellDesirability,
  getDesirabilityModel,
  landValueTier,
  migrationPullFor,
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
// Phase 4 transport (S7, grand expansion): road classes + rail layer.
// ---------------------------------------------------------------------------

/**
 * Road classes, cheapest → best (PLAN §3.4 order). A road cell's class
 * sets its build cost and its movement-cost factor in `cellMoveCost`
 * (pathfinding.ts) — the class's speed factor expressed as a cost, so
 * the flow-field A* routes fast traffic onto better roads.
 */
export type RoadClass = 'dirt' | 'country' | 'paved' | 'highway';

/** Upgrade order for `upgradeRoad` (index compare = strictly better). */
export const ROAD_CLASS_ORDER: readonly RoadClass[] = ['dirt', 'country', 'paved', 'highway'];

/** One road cell: its grid index plus its class. Sorted by `cell`. */
export interface RoadCell {
  cell: number;
  cls: RoadClass;
}

/**
 * Per-class build cost and movement factor. `moveCost` is the
 * `cellMoveCost` factor for entering the cell (lower = faster):
 *  - dirt 1.0 — no faster than open ground; the cheap way to mark a
 *    route (and every road class still conducts power/water, so dirt
 *    doubles as the cheapest utility conductor).
 *  - country 0.75 — a mild upgrade for rural links.
 *  - paved 0.5 — the legacy flat road: ROAD_COST (5 funds + 2
 *    materials) and the old ROAD_COST_FACTOR (0.5) ARE paved's stats,
 *    so the v6→v7 migration (default class `paved`) is
 *    behavior-preserving.
 *  - highway 0.35 — ~43% faster than paved at 2× the build cost, the
 *    endgame logistics corridor.
 */
export const ROAD_CLASS_STATS: Record<
  RoadClass,
  { costFunds: number; costMaterials: number; moveCost: number }
> = {
  dirt: { costFunds: 2, costMaterials: 1, moveCost: 1.0 },
  country: { costFunds: 4, costMaterials: 2, moveCost: 0.75 },
  paved: { costFunds: 5, costMaterials: 2, moveCost: 0.5 },
  highway: { costFunds: 10, costMaterials: 5, moveCost: 0.35 },
};

/**
 * Rail track classes, cheapest → best (PLAN §3.4 order). Unlike roads
 * (whose class is a movement COST), a track class is a train SPEED
 * factor: the same train runs faster on better track
 * (`trainTrackFactor` in rail.ts). This is the "train quality gated by
 * track class" mechanic — standard → electric → high-speed.
 */
export type TrackClass = 'standard' | 'electric' | 'high-speed';

/** One rail cell: its grid index plus its track class. Sorted by `cell`. */
export interface RailCell {
  cell: number;
  cls: TrackClass;
}

/**
 * Per-class rail build cost and train speed factor:
 *  - standard 1.0 — diesel roadbed, the baseline.
 *  - electric 1.4 — catenary; +40% train speed.
 *  - high-speed 1.9 — slab track, near-double speed: the reason to
 *    upgrade a busy main line (see `upgradeRail`… — 0.1 Alpha ships
 *    buildRail only; rail upgrades arrive with the bridges/tunnels
 *    tool, PLAN §3.4).
 * Rail is pricier than road per cell: a dedicated corridor, not a
 * shared street.
 */
export const TRACK_CLASS_STATS: Record<
  TrackClass,
  { costFunds: number; costMaterials: number; speedFactor: number }
> = {
  standard: { costFunds: 8, costMaterials: 4, speedFactor: 1.0 },
  electric: { costFunds: 14, costMaterials: 8, speedFactor: 1.4 },
  'high-speed': { costFunds: 25, costMaterials: 15, speedFactor: 1.9 },
};

/** Binary search for a cell in a sorted RoadCell[]. */
export function roadSortedHas(roads: RoadCell[], cell: number): boolean {
  let lo = 0;
  let hi = roads.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = (roads[mid] as RoadCell).cell;
    if (v === cell) return true;
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Insert a RoadCell keeping the array sorted by cell. No-op if the cell is present. */
export function roadSortedInsert(roads: RoadCell[], rec: RoadCell): void {
  let lo = 0;
  let hi = roads.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((roads[mid] as RoadCell).cell < rec.cell) lo = mid + 1;
    else hi = mid;
  }
  if ((roads[lo] as RoadCell | undefined)?.cell !== rec.cell) roads.splice(lo, 0, rec);
}

/** The road class at a cell, or undefined when the cell has no road. */
export function roadClassAt(roads: RoadCell[], cell: number): RoadClass | undefined {
  let lo = 0;
  let hi = roads.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = roads[mid] as RoadCell;
    if (r.cell === cell) return r.cls;
    if (r.cell < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** Binary search for a cell in a sorted RailCell[]. */
export function railSortedHas(rails: RailCell[], cell: number): boolean {
  let lo = 0;
  let hi = rails.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = (rails[mid] as RailCell).cell;
    if (v === cell) return true;
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Insert a RailCell keeping the array sorted by cell. No-op if the cell is present. */
export function railSortedInsert(rails: RailCell[], rec: RailCell): void {
  let lo = 0;
  let hi = rails.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((rails[mid] as RailCell).cell < rec.cell) lo = mid + 1;
    else hi = mid;
  }
  if ((rails[lo] as RailCell | undefined)?.cell !== rec.cell) rails.splice(lo, 0, rec);
}

/**
 * v6→v7 snapshot migration for roads (PLAN §4 S7, AD9).
 *
 * v6 stored `roads: number[]` — every cell implicitly a paved road at
 * the old flat cost (5 funds + 2 materials, moveCost 0.5). v7 stores
 * `RoadCell[]` `{cell, cls}`.
 *
 * Default class: 'paved'. This is the behavior-preserving choice: the
 * old ROAD_COST_FUNDS/MATERIALS and the old ROAD_COST_FACTOR ARE
 * paved's stats (see ROAD_CLASS_STATS), so pathfinding costs, build
 * costs, and utility conduction are identical before and after
 * migration. Sorted order is preserved (map is order-preserving).
 * Pinned by game/tests/sim.transport.test.ts.
 */
export function migrateRoadsV6ToV7(roads: number[]): RoadCell[] {
  return roads.map((cell) => ({ cell, cls: 'paved' as RoadClass }));
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

/** The four zone types. Stored as small ints in zone records. */
export const ZoneType = {
  RESIDENTIAL: 0,
  COMMERCIAL: 1,
  INDUSTRIAL: 2,
  /**
   * Grand-expansion Phase 5 (S8, 2026-09-30): airport zones. Player-painted
   * like the other zones (a fourth zone paint tool); airport buildings
   * (zone: AIRPORT) require it, and tryAutoDevelop never builds on it —
   * airports are player-placed infrastructure only.
   */
  AIRPORT: 3,
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

/**
 * Grand-expansion Phase 5 (S5, 2026-09-30): one civilian airline route.
 * `from`/`to` are building ids of the owner's completed airports
 * (civil or mixed — military airbases can't take airline routes).
 * Income is paid per economy tick while BOTH endpoints are completed
 * and operational (see `airlineRouteIncome` in economy.ts); a dead
 * endpoint removes the route at the economy tick. Plain data —
 * snapshotted (decode default `[]`) and digest-covered.
 */
export interface AirlineRoute {
  /** Route id (city.nextAirlineRouteId, assigned at establishment). */
  id: number;
  /** Route owner (pays the setup cost, collects the income). */
  owner: number;
  /** Origin airport building id. */
  from: number;
  /** Destination airport building id. */
  to: number;
  /** Sim tick when the route was established. */
  establishedTick: number;
}

/** Sea-route cargo policy: what assigned ships do on the run. */
export const SeaRoutePolicy = {
  /** General freight: earn funds per completed voyage. */
  FUNDS: 'funds',
  /** Ferry fuel between the harbors' fuel stocks (Phase 3 depot rails). */
  FUEL: 'fuel',
  /** Export run: load the owner's materials at the origin, sell at the
   * destination at the mid-market price. */
  MATERIALS: 'materials',
} as const;
export type SeaRoutePolicy =
  (typeof SeaRoutePolicy)[keyof typeof SeaRoutePolicy];

/**
 * Civilian sea trade (Half A, 2026-10-01; naval-building model,
 * 2026-10-01): one dock-to-dock trade route. `from`/`to` are building
 * ids of the owner's completed trade docks (`tradeDock: true` —
 * commercialPort, containerPort, fishingHarbor; the civilian shipyard
 * (commercialHarbor) is NOT a trade dock — it builds ships, it doesn't
 * trade — and the military navalBase is rejected, mirroring the airline
 * rule that bars military airbases). Unlike airline routes (passive
 * per-tick income), sea routes are SAILED: the owner assigns cargo
 * vessels (`assignSeaRoute`) and they shuttle dock↔dock through the
 * normal sea A*, earning per voyage (funds policy) or hauling
 * fuel/materials per the route's `policy`. Dead endpoints are removed
 * at the economy tick (the `runAirlineIncome` dead-set shape). Plain
 * data — snapshotted (decode default `[]`) and digest-covered.
 */
export interface SeaRoute {
  /** Route id (city.nextSeaRouteId, assigned at establishment). */
  id: number;
  /** Route owner (pays the setup cost, collects the income). */
  owner: number;
  /** Origin harbor building id. */
  from: number;
  /** Destination harbor building id. */
  to: number;
  /** Cargo policy for assigned ships. */
  policy: SeaRoutePolicy;
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
  // Workstream P (ambient city life, 2026-09-30): civic parking.
  // Parking lots/garages plug into the desirability amenity table
  // (sim/desirability.ts) as their own types — nearby houses/shops
  // get a small land-value boost.
  PARKING_LOT: 'parkingLot',
  PARKING_GARAGE: 'parkingGarage',
  // Grand-expansion Phase 8 (civilian deep-dive, workstream E,
  // 2026-09-30): the civilian roster gaps — cultural amenities (the
  // user loves parks/libraries/schools, so the family grows), the
  // economy's "versions of everything" ladder (market → grandMarket,
  // bank, officeTower), and civic health tiers (clinic < hospital <
  // medicalCenter) plus the fire station. Every def carries
  // `military: false` explicitly (the workstream-A contract). All plug
  // into EXISTING systems only (amenity rows, output/input, jobs,
  // taxBase) — no new sim currencies, no placebo mechanics.
  /** Cultural amenity: +5/12 row, small research output. */
  MUSEUM: 'museum',
  /** Cultural amenity: +5/12 row, ticket income. */
  THEATER: 'theater',
  /** Regional draw: +8/18 amenity row, the biggest cultural building. */
  SPORTS_STADIUM: 'sportsStadium',
  /** Green leisure: +6/16 amenity row, tourism influence. */
  BOTANICAL_GARDEN: 'botanicalGarden',
  /** The market's big brother: 2x market output at industry age. */
  GRAND_MARKET: 'grandMarket',
  /** Commercial finance: flat funds income, strong tax base. */
  BANK: 'bank',
  /** Tall commercial: the big employer, industry age. */
  OFFICE_TOWER: 'officeTower',
  /** Small/cheap health: manpower output, foundation age. */
  CLINIC: 'clinic',
  /** The hospital's big brother: 2.5x manpower, industry age. */
  MEDICAL_CENTER: 'medicalCenter',
  /** Civic safety: +3/10 desirability row ("feels safe"). */
  FIRE_STATION: 'fireStation',
  // Phase 4 transport (S7, 2026-09-30): civilian transport hubs. The
  // railStation / busDepot / ferryTerminal are reload points (fuel) for
  // the matching transport units, exactly like the navalYard is for
  // ships; ferryTerminal and both marinas use the coastal rule
  // (validatePlacement) and the marinas plug into the desirability
  // amenity table as waterfront leisure.
  RAIL_STATION: 'railStation',
  BUS_DEPOT: 'busDepot',
  FERRY_TERMINAL: 'ferryTerminal',
  MARINA: 'marina',
  MARINA_LARGE: 'marinaLarge',
  // Phase 4 tiered transit stops/stations (2026-09-30): placeable
  // passenger stops, no route/schedule micromanagement. Four small
  // single-mode stops (bus/taxi/tram/boat), then the multi-mode
  // neighborhood station, the train+subway central station, and the
  // all-modes airport interchange (airportLink: true — the Phase 5
  // airport-zone hook). Each def carries servedModes; the desirability
  // amenity rows and ridership income scale with the tier.
  BUS_STOP: 'busStop',
  TAXI_STAND: 'taxiStand',
  TRAM_STOP: 'tramStop',
  FERRY_PIER: 'ferryPier',
  NEIGHBORHOOD_STATION: 'neighborhoodStation',
  CENTRAL_STATION: 'centralStation',
  AIRPORT_INTERCHANGE: 'airportInterchange',
  // Grand-expansion Phase 5 (S5+S8, 2026-09-30): the airport roster —
  // airport ZONES (ZoneType.AIRPORT = 3) hold these buildings. The three
  // site anchors (civilAirport / militaryAirbase / mixedAirport) are the
  // big placeable airports; the existing `airfield` stays the military
  // production building and is NOT zone-gated (leave-airfield-alone —
  // the AI's virtual construction still keys on it). Terminals, the
  // control tower, hangars (per aircraft class, §AD6), the fuel farm,
  // the maintenance hangar, and the three runway modules are the
  // build-out pieces. All defs live in the "Phase 5 airports" region of
  // BUILDING_DEFS below. (Port defs are another worker's — they own
  // their own region of this file.)
  CIVIL_AIRPORT: 'civilAirport',
  MILITARY_AIRBASE: 'militaryAirbase',
  MIXED_AIRPORT: 'mixedAirport',
  PASSENGER_TERMINAL: 'passengerTerminal',
  CARGO_TERMINAL: 'cargoTerminal',
  CONTROL_TOWER: 'controlTower',
  HANGAR_S: 'hangarS',
  HANGAR_M: 'hangarM',
  HANGAR_L: 'hangarL',
  FUEL_FARM: 'fuelFarm',
  MAINTENANCE_HANGAR: 'maintenanceHangar',
  RUNWAY_S: 'runwayS',
  RUNWAY_M: 'runwayM',
  RUNWAY_L: 'runwayL',
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30): the four ports. civilian/military/mixed via
  // `portType` on the def; all require coastline (the placement rule in
  // validatePlacement keys on def.portType — no per-kind list).
  COMMERCIAL_PORT: 'commercialPort',
  CONTAINER_PORT: 'containerPort',
  FISHING_HARBOR: 'fishingHarbor',
  NAVAL_BASE: 'navalBase',
  /**
   * Civilian sea trade (Half A, 2026-10-01): the civilian shipyard —
   * NON-military (peaceful-buildable), `portType: 'civilian'` (coastal
   * rule automatic), and the `requiredBuilding` gate for the civilian
   * cargo vessels (cargoFreighter, fuelBarge). The production
   * counterpart to the income-oriented commercialPort.
   */
  COMMERCIAL_HARBOR: 'commercialHarbor',
  // Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
  // 2026-09-30): the four intel buildings. The intelHQ trains spies
  // and generates operational assets; listeningPost / signalsStation
  // are detection-radius sources (def.detectionRadius) generating
  // surveillance / counter-intel assets; satelliteUplink is the late-age
  // surveillance + sight-bonus building. All zone: UTILITY_ZONE.
  INTEL_HQ: 'intelHQ',
  LISTENING_POST: 'listeningPost',
  SATELLITE_UPLINK: 'satelliteUplink',
  SIGNALS_STATION: 'signalsStation',
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
  /**
   * Structural hit points (final-review R2, 2026-10-01: buildings are
   * destructible — C3). The HP scale, calibrated so a lone tank
   * (~30 dps) cracks a house in ~7 s and needs ~half a minute on a
   * hardened military plant:
   *  - 150–250: fragile civilian fabric — stops, parking lots, houses,
   *    farms, substations, wells. Houses sit at 200 (low, per the
   *    design brief).
   *  - 300–450: ordinary civilian/industrial buildings — apartments,
   *    shops, factories, power/water plants, ports, airport pieces,
   *    intel outposts.
   *  - 500–700: hardened infrastructure — stadiums, dams, nuclear and
   *    fusion plants, naval bases, intel HQ.
   *  - 800–1000: military production and superweapon bunkers — the
   *    siege targets (high, per the design brief): barracks, war
   *    factories, airfields, naval yards, missile plants, storm
   *    arrays, aegis controls.
   * Every def carries an explicit value (tsc-enforced required field).
   */
  hp: number;
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
   * Sea-logistics Half B (2026-10-01). Max construction materials
   * storable at this building when completed — the forward dry-stores
   * cache. Only `navalBase` sets it in 0.1 Alpha. Stock lives on
   * `BuildingRecord.materialsStock` (snapshotted, AD9). There is no
   * spend path yet (forward construction still draws the global
   * stockpile) — the stock is delivered by `unloadCargo` and read by
   * the depot UI; a future workstream may let forward construction draw
   * it.
   */
  materialsStorage?: number;
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
   * gate from the producer's own stock), the three purpose-built
   * depots (missileSilo, ordnanceDepot, fuelDepot), and the three
   * Phase 4 transport hubs (railStation, busDepot, ferryTerminal —
   * fuel only, stocked by the supply-truck chain via fuelStorage), the
   * Phase 5 airports (their terminal/fuel-farm pieces), and the Phase 6
   * ports (commercialPort — fuel stocked by the supply chain; navalBase —
   * fuel + ammo, the fleet's forward depot). Container ports and fishing
   * harbors are pure economy — no reload point.
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
  /**
   * Phase 4 occupancy (2026-09-30): workforce capacity — how many
   * people can work here. Unset/0 = nobody works here (housing,
   * unstaffed street furniture). The economy tick fills jobs from the
   * owner's population in building-id order (`recomputeOccupancy` in
   * economy.ts); the per-building headcount lives on the record
   * (`workers`), the cap here on the def. Read via `buildingOccupancy`.
   */
  jobs?: number;
  /**
   * Phase 4 tiered transit stops/stations (2026-09-30). The transit
   * modes this building serves (`TransitMode`) — the ambient hook
   * `transitStopsForMode` matches buildings to vehicles through this
   * list, and workstream P's decorative transit pauses vehicles at
   * stops serving their mode. Only the seven stop/station kinds set
   * this; depots/terminals (railStation, busDepot, ferryTerminal) are
   * production/reload buildings, not passenger stops.
   */
  servedModes?: TransitMode[];
  /**
   * Phase 4 tiered transit (2026-09-30): Phase 5 hook. When true,
   * Phase 5's airport zones treat this building as their
   * ground-transport interchange. Only airportInterchange sets it;
   * Phase 5 reads the flag — no Phase 5 code exists in 0.1 Alpha.
   */
  airportLink?: boolean;
  /**
   * Phase 4 tiered transit (2026-09-30): ridership income, funds/sec,
   * paid to the owner's treasury once per economy tick for each
   * completed, operational stop/station (`runRidershipIncome` in
   * economy.ts — the runHarvest shape). Deliberately flat per tier
   * (no passenger simulation): the population side of the story is
   * already told by the desirability amenity rows these buildings
   * also carry.
   */
  ridershipIncome?: number;
  /**
   * Grand-expansion Phase 5 (S5, 2026-09-30): airport designation.
   * - 'civilian' — civil airports (airline routes + ambient airliners).
   * - 'military' — military airbases (combat aircraft).
   * - 'mixed' — mixed-use airports: military-capable, but they DISPLAY
   *   as civilian in UI until discovered (intel is Phase 7 — see
   *   `airportDisplayType` in ui/airports.ts for the display rule and
   *   the Phase-7 hook).
   * Unset for non-airport buildings.
   */
  airportType?: 'civilian' | 'military' | 'mixed';
  /**
   * Grand-expansion Phase 5 (S5, 2026-09-30): production kinds this
   * building also counts as for `hasProductionBuilding` gates. A mixed
   * airport counts as an airfield, so military aircraft can train from
   * it without changing `hasProductionBuilding(world, owner, kind)`'s
   * signature — the mixed site satisfies the any-of production gate.
   * (Grand-expansion Phase 6, workstream C: the ports use the same
   * mechanism — commercialPort counts as shipyard, navalBase as
   * navalYard.)
   */
  countsAs?: BuildingKind[];
  /**
   * Grand-expansion Phase 6 — naval expansion (workstream C,
   * 2026-09-30): port designation, the S5 civilian/military/mixed
   * axis for harbors. Unset for non-port buildings. `validatePlacement`
   * requires coastline for every def with a portType — one rule for
   * all ports, no per-kind list.
   */
  portType?: 'civilian' | 'military' | 'mixed';
  /**
   * Naval-building model (2026-10-01): the trade-dock flag — the
   * no-blur rule. When true, a completed building can anchor a sea
   * trade route (`establishSeaRoute` in economy.ts rejects endpoints
   * without it, loudly). Set on exactly the three civilian docks —
   * commercialPort, containerPort, fishingHarbor — and on nothing
   * else: the civilian shipyard (commercialHarbor) BUILDS ships, the
   * docks TRADE with them, and the military navalBase is barred from
   * civilian trade routes. Old saves grandfather: routes store building
   * ids, and nothing re-validates a route's endpoints after
   * establishment, so pre-flag routes keep sailing untouched.
   */
  tradeDock?: boolean;
  /**
   * Grand-expansion Phase 6 — naval expansion (workstream C,
   * 2026-09-30): passive resource income in resource-units per
   * sim-second for a completed, operational building (commercialPort:
   * funds 1.5, containerPort: funds 2.5, fishingHarbor: food 1.2).
   * Paid by `runHarvest` (economy.ts) in building-id order — the
   * runRidershipIncome shape, deliberately flat (no simulation). Unit
   * harvest (fishingBoat and friends) is separate and stays in units.ts.
   */
  harvest?: Partial<Record<ResourceKey, number>>;
  /**
   * Grand-expansion Phase 5 (§AD6, 2026-09-30): aircraft class this
   * building stores — one of HangarClass, or 'generic' (any class —
   * the legacy airfield default). Set on hangarS/hangarM/hangarL (one
   * class each) and the airfield ('generic'). Drives `findHangarSlot`.
   */
  hangarClass?: HangarClass | 'generic';
  /**
   * Grand-expansion Phase 5 (§AD6): hangar slot count for the class in
   * `hangarClass`. `placeBuilding` initializes `BuildingRecord.hangars`
   * with this many empty slots; legacy saves decode via
   * `defaultHangarSlots` (snapshot.ts v8 — the exact default is pinned
   * by test). Requires `hangarClass`.
   */
  hangarCapacity?: number;
  /**
   * Grand-expansion Phase 5 (§AD7, 2026-09-30): runway class. A runway
   * module of class C serves aircraft of class ≤ C in the
   * light < medium < heavy order (a 'light' runway serves light
   * aircraft only; 'medium' serves light+medium; 'heavy' serves
   * everything). The build UI shows the served classes so the runway
   * choice gates aircraft class pre-purchase. Set on
   * runwayS/runwayM/runwayL only.
   */
  runwayClass?: AircraftClass;
  // ------------------------------------------------------------------
  // Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
  // 2026-09-30). The def-side of the intel interface contract: the
  // sim-core workstream owns the mechanics (infiltrate/sabotage
  // commands, acquireTarget + getVisibleEnemies hooks, the intel panel)
  // and consumes these fields plus sim/intel.ts.
  // ------------------------------------------------------------------
  /**
   * Intel assets generated per sim-second by a completed, operational
   * building (intelHQ: operational; listeningPost: surveillance;
   * signalsStation: counterIntel; satelliteUplink: surveillance).
   * Accrued by `runIntelAccrual` (sim/intel.ts) — NOT by the generic
   * economy output path, because these are plain per-player asset
   * counters, not tradeable resources.
   */
  intelOutput?: Partial<Record<IntelAssetKey, number>>;
  /**
   * Detection radius in world units. A completed building contributes
   * this radius (centered on its footprint center) to its owner's
   * `detectionRadiusAt` — stealthed enemy units inside are detected
   * (see `isDetected` in sim/intel.ts). Set on listeningPost and
   * signalsStation only.
   */
  detectionRadius?: number;
  /**
   * Unit sight bonus in world units. A completed building adds this to
   * its owner's unit sight (consumed by the sim-core workstream's
   * effectiveSight hook). Set on satelliteUplink only.
   */
  sightBonus?: number;
  /**
   * Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30):
   * conventional radar coverage in world units. A completed,
   * operational, unsabotaged building reveals NON-stealthed enemy units
   * inside this radius (centered on its footprint center) to its
   * owner's AI perception (`getVisibleEnemies` in sim/ai.ts) — the
   * "radar sight term". Unlike `detectionRadius` (SIGINT — catches
   * spies), radar never detects stealthed units: the counter-spy
   * monopoly stays with the listeningPost / signalsStation. Set on
   * radarStation only.
   */
  radarRadius?: number;
  /**
   * Grand-expansion Phase 8 (peaceful mode, 2026-09-30): true when this
   * building is war apparatus — military production (barracks,
   * warFactory, militaryAcademy, airfield, navalYard, shipyard,
   * radarStation), military logistics (munitionsFactory, missilePlant,
   * missileSilo, ordnanceDepot, fuelDepot), superweapons (aegisControl,
   * stormArray), the intel roster (intelHQ, listeningPost,
   * satelliteUplink, signalsStation), military aviation
   * (militaryAirbase, mixedAirport), and the naval base. In a peaceful
   * world (`world.peaceful`), `placeBuilding` rejects military defs
   * loudly and the order never reaches the queue.
   *
   * Judgment calls: `shipyard` is military because every unit it gates
   * (missileBoat, ammoShip, repairShip, minelayer) is military — the
   * civilian sea units need no production building. `mixedAirport` is
   * military because it hosts combat aircraft. The civilian airport
   * pieces (civilAirport, terminals, hangars, runways...) and the
   * civilian ports stay available in peaceful games. See
   * docs/research/phase8-civilian-peaceful.md.
   */
  military?: boolean;
}

/**
 * Intel asset kinds (grand-expansion §3.8 / §4 S6, workstream 2,
 * 2026-09-30). Per-player counters on `PlayerState.intel` — the
 * interface contract with the sim-core workstream (exact names):
 * - `surveillance` — earned by listening posts / satellite uplinks;
 *   feeds recon value and the signalsIntel upgrade line.
 * - `operational` — earned by the intel HQ; spent by the
 *   `infiltrateBuilding` / `sabotage` commands (tech steal via
 *   `addStock`).
 * - `counterIntel` — earned by signals stations; spent on defensive
 *   posture and boosts detection (the visible answer to spies).
 * Plain numbers, snapshotted and digested (PLAN §4 S6).
 */
export type IntelAssetKey = 'surveillance' | 'operational' | 'counterIntel';

/** One player's intel asset counters. */
export interface IntelAssets {
  surveillance: number;
  operational: number;
  counterIntel: number;
}

/** Fresh intel counters — zero assets, no posture. */
export const ZERO_INTEL_ASSETS: IntelAssets = {
  surveillance: 0,
  operational: 0,
  counterIntel: 0,
};

// ---------------------------------------------------------------------------
// Grand-expansion Phase 8 — civilian ordinances (workstream E, 2026-09-30).
//
// City-wide policy toggles (the Management tab's "Ordinances" section).
// Each policy has a REAL upkeep cost (funds/sec, charged in the economy
// tick's upkeep pass — see economy.ts `allocateUtilities`) and REAL
// effects on existing systems (desirability rows, production
// multipliers, growth bonuses). No per-building micromanagement: one
// toggle per city. No free lunch: every bonus is paid for — the
// balance reasoning lives in docs/research/phase8-civilian-peaceful.md
// §"Workstream E".
//
// Funding rule (the building-upkeep precedent): policies fund AFTER
// buildings in the upkeep pass, in POLICY_IDS order, from whatever
// affordable funds remain. An unfunded policy is charged nothing and
// its effects do NOT apply that tick — `fundedPolicies` on the player
// record carries the per-tick funding decision (DERIVED, never
// snapshotted/digested — the desirability-model precedent). The
// `setPolicy` command's validate requires a 60-second upkeep runway to
// turn a policy ON (loud rejection when broke); turning OFF is always
// free. Effects are deterministic functions of (toggles, funding).
// ---------------------------------------------------------------------------

/** City-wide ordinance ids. */
export type PolicyId =
  | 'greenInitiative'
  | 'transitSubsidy'
  | 'businessIncentives'
  | 'nightlife'
  | 'educationGrants';

/** One ordinance's static definition. */
export interface PolicyDef {
  id: PolicyId;
  /** English display name (the game is English-only, 0.1 Alpha). */
  name: string;
  /** Funds/sec charged while the policy is funded (see funding rule). */
  upkeepFundsPerSec: number;
  /** One-line player-facing summary of the effects. */
  summary: string;
}

/** The ordinance table. Effects are documented per consuming module. */
export const POLICIES: Record<PolicyId, PolicyDef> = {
  greenInitiative: {
    id: 'greenInitiative',
    name: 'Green Initiative',
    upkeepFundsPerSec: 0.6,
    summary: '+2 desirability on park/garden amenity rows; pollution penalty ×0.8',
  },
  transitSubsidy: {
    id: 'transitSubsidy',
    name: 'Transit Subsidy',
    upkeepFundsPerSec: 0.5,
    summary: '+2 desirability on transit-stop rows; ridership income ×1.25; migration pull ×1.15',
  },
  businessIncentives: {
    id: 'businessIncentives',
    name: 'Business Incentives',
    upkeepFundsPerSec: 0.8,
    summary: 'Commercial funds output ×1.15',
  },
  nightlife: {
    id: 'nightlife',
    name: 'Nightlife Ordinance',
    upkeepFundsPerSec: 0.3,
    summary: 'Commercial funds output ×1.10; −3 desirability within 8 cells of commercial buildings',
  },
  educationGrants: {
    id: 'educationGrants',
    name: 'Education Grants',
    upkeepFundsPerSec: 0.4,
    summary: 'Education growth bonus doubled; education research output ×1.25',
  },
};

/**
 * Fixed ordinance order — the funding order, the UI order, and the
 * digest order. Fixed (not object key order) so the canonical encoding
 * in digest.ts is stable.
 */
export const POLICY_IDS: readonly PolicyId[] = [
  'greenInitiative',
  'transitSubsidy',
  'businessIncentives',
  'nightlife',
  'educationGrants',
];

/**
 * Turning a policy ON requires this many seconds of its upkeep as a
 * funds runway (the `setPolicy` validate gate). Loud rejection when
 * the treasury can't cover it — no silent toggles.
 */
export const POLICY_ENABLE_RUNWAY_SECS = 60;

/**
 * True when `owner`'s policy is BOTH toggled on and funded this economy
 * tick. All policy effects read this (never the raw toggle) — an
 * unfunded policy is charged nothing and does nothing.
 */
export function policyFunded(world: World, owner: number, id: PolicyId): boolean {
  const player = getPlayer(world.city, owner);
  if (!player) return false;
  return (player.fundedPolicies ?? []).includes(id);
}

export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  house: {
    kind: 'house', name: 'House', zone: ZoneType.RESIDENTIAL,
    hp: 200,
    footprintW: 2, footprintH: 2, costFunds: 120, costMaterials: 40,
    buildSeconds: 10, upkeepFundsPerSec: 0.15,
    powerDemand: 1, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 6, taxBasePerSec: 1.0,
    minAge: 'foundation',
  },
  apartment: {
    kind: 'apartment', name: 'Apartment Block', zone: ZoneType.RESIDENTIAL,
    hp: 300,
    footprintW: 3, footprintH: 3, costFunds: 450, costMaterials: 160,
    buildSeconds: 30, upkeepFundsPerSec: 0.7,
    powerDemand: 3, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 30, taxBasePerSec: 5.0,
    minAge: 'foundation',
  },
  shop: {
    kind: 'shop', name: 'Shop', zone: ZoneType.COMMERCIAL,
    hp: 250,
    footprintW: 2, footprintH: 2, costFunds: 220, costMaterials: 70,
    buildSeconds: 15, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { funds: 1.8 }, input: { goods: 0.5 }, population: 0, taxBasePerSec: 6.0,
    minAge: 'foundation',
    jobs: 4,
  },
  lab: {
    kind: 'lab', name: 'Research Lab', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 2, footprintH: 2, costFunds: 650, costMaterials: 220,
    buildSeconds: 45, upkeepFundsPerSec: 1.2,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { research: 0.4 }, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'foundation',
    jobs: 20,
  },
  factory: {
    kind: 'factory', name: 'Factory', zone: ZoneType.INDUSTRIAL,
    hp: 450,
    footprintW: 3, footprintH: 3, costFunds: 550, costMaterials: 220,
    buildSeconds: 40, upkeepFundsPerSec: 1.6,
    powerDemand: 5, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { materials: 2.5, goods: 1.5 }, input: { fuel: 0.4 }, population: 0, taxBasePerSec: 8.0,
    minAge: 'foundation',
    jobs: 25,
  },
  farm: {
    kind: 'farm', name: 'Farm', zone: ZoneType.INDUSTRIAL,
    hp: 250,
    footprintW: 3, footprintH: 3, costFunds: 300, costMaterials: 80,
    buildSeconds: 15, upkeepFundsPerSec: 0.6,
    powerDemand: 1, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: { food: 3.0 }, input: {}, population: 0, taxBasePerSec: 2.5,
    minAge: 'foundation',
    jobs: 10,
  },
  powerPlant: {
    kind: 'powerPlant', name: 'Power Plant', zone: UTILITY_ZONE,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 60, upkeepFundsPerSec: 0.8,
    powerDemand: 0, powerSupply: 25, waterDemand: 2, waterSupply: 0,
    output: {}, input: { fuel: 1.0 }, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
    // Phase 2: the oil burner fouls adjacent water sources (like coal/gas).
    fouling: true,
    jobs: 12,
  },
  waterPump: {
    kind: 'waterPump', name: 'Water Pump', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 25,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'foundation',
    // Phase 2: industrial neighbors can foul this source (halved output).
    foulable: true,
    jobs: 4,
  },
  mediaCenter: {
    kind: 'mediaCenter', name: 'Media Center', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 2, footprintH: 2, costFunds: 800, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 1.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { influence: 0.8 }, input: {}, population: 0, taxBasePerSec: 7.0,
    minAge: 'foundation',
    jobs: 15,
  },
  // Naval-building model (2026-10-01): the MILITARY shipyard — builds
  // AND repairs military light/support craft (missile boats, corvettes,
  // ammo ships, repair ships, minelayers). The heavy combatants
  // (destroyers, frigates, carriers, ...) belong to the navalYard. Dry
  // production only: it carries no stocks and is NOT a cargo load point
  // (see computeCargoTransfer in commands.ts). Renamed to "Naval
  // Shipyard" to distinguish it from the civilian shipyard; the key
  // ('shipyard') is unchanged so old saves keep loading.
  shipyard: {
    kind: 'shipyard', name: 'Naval Shipyard', zone: UTILITY_ZONE,
    hp: 800,
    footprintW: 4, footprintH: 3, costFunds: 1200, costMaterials: 500,
    buildSeconds: 60, upkeepFundsPerSec: 1.5,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'foundation',
    jobs: 20,
    military: true,
  },
  aegisControl: {
    kind: 'aegisControl', name: 'Aegis Control', zone: UTILITY_ZONE,
    hp: 1000,
    footprintW: 3, footprintH: 3, costFunds: 5000, costMaterials: 2000,
    buildSeconds: 120, upkeepFundsPerSec: 5.0,
    powerDemand: 10, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'ascendance',
    jobs: 10,
    military: true,
  },
  stormArray: {
    kind: 'stormArray', name: 'Storm Array', zone: UTILITY_ZONE,
    hp: 1000,
    footprintW: 4, footprintH: 4, costFunds: 6000, costMaterials: 2500,
    buildSeconds: 150, upkeepFundsPerSec: 6.0,
    powerDemand: 12, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'ascendance',
    jobs: 8,
    military: true,
  },
  barracks: {
    kind: 'barracks', name: 'Barracks', zone: ZoneType.INDUSTRIAL,
    hp: 900,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 250,
    buildSeconds: 40, upkeepFundsPerSec: 1.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { manpower: 0.8 }, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'foundation',
    // Phase 3: army bases are reload points — units resupply here
    // (stocks arrive via the supply-truck chain; see reloadPoint doc).
    reloadPoint: true,
    jobs: 30,
    military: true,
  },
  militaryAcademy: {
    kind: 'militaryAcademy', name: 'Military Academy', zone: ZoneType.INDUSTRIAL,
    hp: 900,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 0.8,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'foundation', requiredBuilding: 'barracks',
    jobs: 15,
    military: true,
  },
  warFactory: {
    kind: 'warFactory', name: 'War Factory', zone: ZoneType.INDUSTRIAL,
    hp: 1000,
    footprintW: 4, footprintH: 3, costFunds: 1100, costMaterials: 450,
    buildSeconds: 60, upkeepFundsPerSec: 1.8,
    powerDemand: 6, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { materials: 0.5 }, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'foundation',
    // Phase 3: army bases are reload points (see barracks note).
    reloadPoint: true,
    jobs: 30,
    military: true,
  },
  airfield: {
    kind: 'airfield', name: 'Airfield', zone: UTILITY_ZONE,
    hp: 900,
    footprintW: 5, footprintH: 4, costFunds: 1500, costMaterials: 600,
    buildSeconds: 75, upkeepFundsPerSec: 2.0,
    powerDemand: 5, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'connectivity',
    // Phase 3: the airport is a reload point for aircraft (and any
    // land unit parked on the field).
    reloadPoint: true,
    // Grand-expansion Phase 5 (hangars, S4 — 2026-09-30): the legacy
    // airfield predates per-class hangar buildings, so it keeps
    // 'generic' slots (any class parks here) — exactly
    // LEGACY_AIRFIELD_HANGAR_SLOTS of them, the decode default pinned
    // in sim.hangars.test.ts. `defaultHangarSlots` reads this pair.
    hangarClass: 'generic', hangarCapacity: 6,
    jobs: 20,
    military: true,
  },
  navalYard: {
    kind: 'navalYard', name: 'Naval Yard', zone: UTILITY_ZONE,
    hp: 1000,
    footprintW: 5, footprintH: 4, costFunds: 1800, costMaterials: 700,
    buildSeconds: 80, upkeepFundsPerSec: 2.2,
    powerDemand: 6, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'industry',
    // Naval-building model (2026-10-01): the navalYard builds AND
    // repairs the HEAVY military combatants (destroyers, frigates,
    // submarines, carriers, ...), while the (naval) shipyard handles
    // light/support craft. The reloadPoint makes it a cargo load point
    // for military supply ships — production + logistics in one, the
    // military mirror of the civilian commercialHarbor.
    // Phase 3: the naval yard is a reload point for ships.
    reloadPoint: true,
    jobs: 25,
    military: true,
  },
  // Phase 4 transport (S7, grand expansion): civilian transport hubs.
  railStation: {
    kind: 'railStation', name: 'Rail Station', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 200,
    buildSeconds: 45, upkeepFundsPerSec: 0.6,
    powerDemand: 3, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'industry',
    // Rail hub: the train reload point (fuel) and the anchor the rail
    // router routes between (see rail.ts stationRailCells). fuelStorage
    // so the supply-truck chain stocks it (Phase 3 precedent).
    fuelStorage: 120,
    reloadPoint: true,
    jobs: 25,
  },
  busDepot: {
    kind: 'busDepot', name: 'Bus Depot', zone: ZoneType.INDUSTRIAL,
    hp: 300,
    footprintW: 3, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 35, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    // Bus/tram reload point (fuel); fuelStorage so the supply-truck
    // chain stocks it.
    fuelStorage: 120,
    reloadPoint: true,
    jobs: 15,
  },
  ferryTerminal: {
    kind: 'ferryTerminal', name: 'Ferry Terminal', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 500, costMaterials: 180,
    buildSeconds: 40, upkeepFundsPerSec: 0.5,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.5,
    minAge: 'connectivity',
    // Coastal (validatePlacement). Ferry reload point (fuel);
    // fuelStorage so the supply-truck chain stocks it.
    fuelStorage: 120,
    reloadPoint: true,
    jobs: 20,
  },
  marina: {
    kind: 'marina', name: 'Marina', zone: ZoneType.COMMERCIAL,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 100,
    buildSeconds: 30, upkeepFundsPerSec: 0.3,
    powerDemand: 1, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    // Coastal (validatePlacement). Waterfront amenity: nearby houses and
    // shops gain desirability via the desirability.ts amenity table —
    // no desirability-code changes needed (the hook reads this flag).
    waterfrontAmenity: true,
    jobs: 6,
  },
  marinaLarge: {
    kind: 'marinaLarge', name: 'Grand Marina', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 4, footprintH: 4, costFunds: 900, costMaterials: 350,
    buildSeconds: 60, upkeepFundsPerSec: 0.9,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'information',
    // Coastal (validatePlacement). Bigger waterfront amenity footprint.
    waterfrontAmenity: true,
    jobs: 15,
  },
  // Phase 4 tiered transit stops/stations (2026-09-30): placeable
  // passenger stops — no routes, no schedules, no micromanagement.
  // The four small stops are 1×1 street furniture on UTILITY_ZONE
  // (anywhere on land, like the Phase 2 network buildings); the three
  // stations are commercial-zone buildings. Tiers scale in cost,
  // servedModes, desirability amenity rows (see AMENITY_TABLE), and
  // ridershipIncome (funds/sec, runRidershipIncome in economy.ts).
  busStop: {
    kind: 'busStop', name: 'Bus Stop', zone: UTILITY_ZONE,
    hp: 150,
    footprintW: 1, footprintH: 1, costFunds: 40, costMaterials: 10,
    buildSeconds: 10, upkeepFundsPerSec: 0.05,
    powerDemand: 0, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 0.2,
    minAge: 'connectivity',
    servedModes: ['bus'],
    ridershipIncome: 0.08,
  },
  taxiStand: {
    kind: 'taxiStand', name: 'Taxi Stand', zone: UTILITY_ZONE,
    hp: 150,
    footprintW: 1, footprintH: 1, costFunds: 40, costMaterials: 10,
    buildSeconds: 10, upkeepFundsPerSec: 0.05,
    powerDemand: 0, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 0.2,
    minAge: 'connectivity',
    servedModes: ['taxi'],
    ridershipIncome: 0.08,
  },
  tramStop: {
    kind: 'tramStop', name: 'Tram Stop', zone: UTILITY_ZONE,
    hp: 150,
    footprintW: 1, footprintH: 1, costFunds: 50, costMaterials: 15,
    buildSeconds: 12, upkeepFundsPerSec: 0.06,
    powerDemand: 0, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 0.2,
    minAge: 'connectivity',
    servedModes: ['tram'],
    ridershipIncome: 0.10,
  },
  ferryPier: {
    kind: 'ferryPier', name: 'Ferry Pier', zone: UTILITY_ZONE,
    hp: 200,
    footprintW: 2, footprintH: 2, costFunds: 120, costMaterials: 40,
    buildSeconds: 20, upkeepFundsPerSec: 0.15,
    powerDemand: 0, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 0.5,
    minAge: 'connectivity',
    // Coastal (validatePlacement) — same rule as ferryTerminal/marina.
    servedModes: ['boat'],
    ridershipIncome: 0.22,
  },
  neighborhoodStation: {
    kind: 'neighborhoodStation', name: 'Neighborhood Station', zone: ZoneType.COMMERCIAL,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 250, costMaterials: 80,
    buildSeconds: 30, upkeepFundsPerSec: 0.3,
    powerDemand: 1, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'connectivity',
    // The three street modes in one building.
    servedModes: ['bus', 'taxi', 'tram'],
    ridershipIncome: 0.45,
    jobs: 10,
  },
  centralStation: {
    kind: 'centralStation', name: 'Central Station', zone: ZoneType.COMMERCIAL,
    hp: 500,
    footprintW: 4, footprintH: 3, costFunds: 800, costMaterials: 300,
    buildSeconds: 60, upkeepFundsPerSec: 0.8,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'industry',
    // Trains join here; subway is listed now but the subway vehicle
    // arrives in a later phase (see the TransitMode doc).
    servedModes: ['bus', 'taxi', 'tram', 'train', 'subway'],
    ridershipIncome: 1.2,
    jobs: 40,
  },
  airportInterchange: {
    kind: 'airportInterchange', name: 'Airport Interchange', zone: ZoneType.COMMERCIAL,
    hp: 500,
    footprintW: 4, footprintH: 4, costFunds: 1200, costMaterials: 450,
    buildSeconds: 80, upkeepFundsPerSec: 1.2,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'information',
    // All modes, and the Phase 5 hook: airport zones read airportLink.
    servedModes: ['bus', 'taxi', 'tram', 'train', 'subway', 'boat', 'air'],
    airportLink: true,
    ridershipIncome: 1.8,
    jobs: 60,
  },
  radarStation: {
    kind: 'radarStation', name: 'Radar Station', zone: UTILITY_ZONE,
    hp: 500,
    footprintW: 2, footprintH: 2, costFunds: 600, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 0.8,
    powerDemand: 3, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.5 }, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'connectivity',
    jobs: 8,
    // Phase 7 (S6 intel, workstream 3): conventional early-warning
    // radar — reveals non-stealthed enemies in a 90-unit radius to the
    // owner's AI perception (the getVisibleEnemies sight term). Blind
    // to spies by design (see radarRadius on BuildingDef): a cheap
    // Connectivity-age radar must not obsolete the Information-age
    // SIGINT counter-spy game.
    radarRadius: 90,
    military: true,
  },
  quarry: {
    kind: 'quarry', name: 'Quarry', zone: ZoneType.INDUSTRIAL,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 350, costMaterials: 100,
    buildSeconds: 25, upkeepFundsPerSec: 0.7,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { materials: 2.0 }, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
    jobs: 15,
  },
  oilRefinery: {
    kind: 'oilRefinery', name: 'Oil Refinery', zone: ZoneType.INDUSTRIAL,
    hp: 500,
    footprintW: 4, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 50, upkeepFundsPerSec: 1.4,
    powerDemand: 4, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { fuel: 1.5 }, input: { materials: 0.3 }, population: 0, taxBasePerSec: 6.0,
    minAge: 'connectivity',
    jobs: 20,
  },
  recyclingCenter: {
    kind: 'recyclingCenter', name: 'Recycling Center', zone: ZoneType.INDUSTRIAL,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 500, costMaterials: 180,
    buildSeconds: 35, upkeepFundsPerSec: 0.9,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { materials: 1.0 }, input: { goods: 0.5 }, population: 0, taxBasePerSec: 4.0,
    minAge: 'connectivity',
    jobs: 12,
  },
  market: {
    kind: 'market', name: 'Market', zone: ZoneType.COMMERCIAL,
    hp: 350,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 1.0,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { funds: 2.5 }, input: { food: 0.5, goods: 0.5 }, population: 0, taxBasePerSec: 10.0,
    minAge: 'connectivity',
    jobs: 12,
  },
  solarFarm: {
    kind: 'solarFarm', name: 'Solar Farm', zone: UTILITY_ZONE,
    hp: 350,
    footprintW: 4, footprintH: 3, costFunds: 700, costMaterials: 250,
    buildSeconds: 35, upkeepFundsPerSec: 0.5,
    powerDemand: 0, powerSupply: 15, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    jobs: 4,
  },
  nuclearPlant: {
    kind: 'nuclearPlant', name: 'Nuclear Plant', zone: UTILITY_ZONE,
    hp: 700,
    footprintW: 4, footprintH: 4, costFunds: 2500, costMaterials: 1000,
    buildSeconds: 100, upkeepFundsPerSec: 2.5,
    powerDemand: 0, powerSupply: 60, waterDemand: 6, waterSupply: 0,
    output: {}, input: { fuel: 0.5 }, population: 0, taxBasePerSec: 8.0,
    minAge: 'industry',
    jobs: 15,
  },
  desalination: {
    kind: 'desalination', name: 'Desalination Plant', zone: UTILITY_ZONE,
    hp: 450,
    footprintW: 3, footprintH: 3, costFunds: 800, costMaterials: 300,
    buildSeconds: 40, upkeepFundsPerSec: 1.0,
    powerDemand: 6, powerSupply: 0, waterDemand: 0, waterSupply: 40,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'industry',
    jobs: 8,
  },
  hospital: {
    kind: 'hospital', name: 'Hospital', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 800, costMaterials: 280,
    buildSeconds: 40, upkeepFundsPerSec: 1.2,
    powerDemand: 4, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { manpower: 0.4 }, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'connectivity',
    jobs: 30,
  },
  university: {
    kind: 'university', name: 'University', zone: UTILITY_ZONE,
    hp: 400,
    footprintW: 4, footprintH: 3, costFunds: 1400, costMaterials: 500,
    buildSeconds: 60, upkeepFundsPerSec: 1.8,
    powerDemand: 5, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { research: 1.0 }, input: {}, population: 0, taxBasePerSec: 8.0,
    minAge: 'connectivity',
    jobs: 25,
  },
  school: {
    kind: 'school', name: 'School', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 250, costMaterials: 80,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.25 }, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'foundation',
    jobs: 12,
  },
  // Workstream Z (2026-09-30): the education research ladder. Kindergarten
  // (0.1/s) < school (0.25/s) < college (0.5/s) < university (1.0/s).
  // Completed kindergartens/schools also boost residential growth
  // (see `educationGrowthBonus`).
  kindergarten: {
    kind: 'kindergarten', name: 'Kindergarten', zone: UTILITY_ZONE,
    hp: 250,
    footprintW: 2, footprintH: 2, costFunds: 150, costMaterials: 50,
    buildSeconds: 12, upkeepFundsPerSec: 0.2,
    powerDemand: 1, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.1 }, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'foundation',
    jobs: 6,
  },
  college: {
    kind: 'college', name: 'College', zone: UTILITY_ZONE,
    hp: 350,
    footprintW: 2, footprintH: 2, costFunds: 400, costMaterials: 120,
    buildSeconds: 30, upkeepFundsPerSec: 0.8,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { research: 0.5 }, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
    jobs: 18,
  },
  // Workstream W (2026-09-30): civic amenities. Library and park are
  // placeable anywhere on land (UTILITY_ZONE, like the education
  // buildings); each completed one counts as an amenity TYPE in the
  // desirability model (+5 within 12 cells, toward the +20 amenity cap —
  // see the amenity table in sim/desirability.ts).
  library: {
    kind: 'library', name: 'Library', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 200, costMaterials: 60,
    buildSeconds: 20, upkeepFundsPerSec: 0.3,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { research: 0.15 }, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'foundation',
    jobs: 6,
  },
  park: {
    kind: 'park', name: 'Park', zone: UTILITY_ZONE,
    hp: 200,
    footprintW: 3, footprintH: 3, costFunds: 250, costMaterials: 80,
    buildSeconds: 15, upkeepFundsPerSec: 0.2,
    powerDemand: 0, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 0.5,
    minAge: 'foundation',
    jobs: 2,
  },
  // Workstream P (ambient city life, 2026-09-30): civic parking.
  // Placeable anywhere on land (UTILITY_ZONE, like park/library); each
  // completed one counts as an amenity TYPE in the desirability model
  // (parkingLot +3 within 8 cells, parkingGarage +4 within 10 cells,
  // toward the same +20 amenity cap — see the amenity table in
  // sim/desirability.ts; convenience amenities score below the +5
  // cultural/education types). The garage costs more but serves more
  // cars, hence the stronger/longer-reaching bonus.
  parkingLot: {
    kind: 'parkingLot', name: 'Parking Lot', zone: UTILITY_ZONE,
    hp: 150,
    footprintW: 3, footprintH: 3, costFunds: 180, costMaterials: 60,
    buildSeconds: 15, upkeepFundsPerSec: 0.15,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'foundation',
    jobs: 1,
  },
  parkingGarage: {
    kind: 'parkingGarage', name: 'Parking Garage', zone: UTILITY_ZONE,
    hp: 250,
    footprintW: 3, footprintH: 3, costFunds: 450, costMaterials: 180,
    buildSeconds: 30, upkeepFundsPerSec: 0.5,
    powerDemand: 3, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.5,
    minAge: 'foundation',
    jobs: 2,
  },
  monument: {
    kind: 'monument', name: 'Monument', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 3, footprintH: 3, costFunds: 3000, costMaterials: 1200,
    buildSeconds: 90, upkeepFundsPerSec: 2.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { influence: 1.0 }, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'information',
    jobs: 2,
  },
  // ------------------------------------------------------------------
  // Grand-expansion Phase 8 (civilian deep-dive, workstream E,
  // 2026-09-30): the civilian roster gaps. Balance notes (full
  // reasoning in docs/research/phase8-civilian-peaceful.md):
  // - Cultural amenities (museum/theater/stadium/botanicalGarden) are
  //   the park/library family grown up: each completed one is its own
  //   amenity TYPE in the desirability model (see the amenity table in
  //   sim/desirability.ts) AND earns a small real income/output, so
  //   each is a building you'd place even ignoring desirability.
  // - The economy ladder ("versions of everything"): grandMarket is
  //   the market's 2x big brother at industry age; bank and officeTower
  //   are the commercial finance/employment tier the roster lacked.
  // - Health tiers: clinic (cheap, foundation) < hospital < medicalCenter
  //   (flagship, industry) — manpower output scales 0.2 → 0.4 → 1.0.
  // - fireStation is the safety amenity: its own +3/10 desirability row.
  // Every def carries `military: false` explicitly (the workstream-A
  // contract — all ten are civilian, peaceful-buildable).
  // ------------------------------------------------------------------
  museum: {
    kind: 'museum', name: 'Museum', zone: UTILITY_ZONE,
    hp: 350,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 250,
    buildSeconds: 40, upkeepFundsPerSec: 0.9,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { research: 0.15 }, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'connectivity',
    military: false,
    jobs: 8,
  },
  theater: {
    kind: 'theater', name: 'Theater', zone: UTILITY_ZONE,
    hp: 350,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 1.2,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { funds: 0.8 }, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'connectivity',
    military: false,
    jobs: 10,
  },
  sportsStadium: {
    kind: 'sportsStadium', name: 'Sports Stadium', zone: UTILITY_ZONE,
    hp: 500,
    footprintW: 4, footprintH: 4, costFunds: 2200, costMaterials: 900,
    buildSeconds: 80, upkeepFundsPerSec: 2.5,
    powerDemand: 6, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: { funds: 1.5 }, input: {}, population: 0, taxBasePerSec: 10.0,
    minAge: 'industry',
    military: false,
    jobs: 25,
  },
  botanicalGarden: {
    kind: 'botanicalGarden', name: 'Botanical Garden', zone: UTILITY_ZONE,
    hp: 250,
    footprintW: 4, footprintH: 4, costFunds: 600, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 0.5,
    powerDemand: 0, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: { influence: 0.1 }, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'foundation',
    military: false,
    jobs: 6,
  },
  grandMarket: {
    kind: 'grandMarket', name: 'Grand Market', zone: ZoneType.COMMERCIAL,
    hp: 450,
    footprintW: 4, footprintH: 4, costFunds: 1500, costMaterials: 600,
    buildSeconds: 60, upkeepFundsPerSec: 2.2,
    powerDemand: 6, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: { funds: 5.0 }, input: { food: 1.0, goods: 1.0 }, population: 0,
    taxBasePerSec: 22.0,
    minAge: 'industry',
    military: false,
    jobs: 30,
  },
  bank: {
    kind: 'bank', name: 'Bank', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 2, footprintH: 2, costFunds: 500, costMaterials: 180,
    buildSeconds: 30, upkeepFundsPerSec: 0.8,
    powerDemand: 3, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { funds: 1.2 }, input: {}, population: 0, taxBasePerSec: 8.0,
    minAge: 'connectivity',
    military: false,
    jobs: 10,
  },
  officeTower: {
    kind: 'officeTower', name: 'Office Tower', zone: ZoneType.COMMERCIAL,
    hp: 450,
    footprintW: 3, footprintH: 3, costFunds: 1200, costMaterials: 450,
    buildSeconds: 55, upkeepFundsPerSec: 1.8,
    powerDemand: 6, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { funds: 2.0 }, input: {}, population: 0, taxBasePerSec: 12.0,
    minAge: 'industry',
    military: false,
    jobs: 40,
  },
  clinic: {
    kind: 'clinic', name: 'Clinic', zone: ZoneType.COMMERCIAL,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 100,
    buildSeconds: 20, upkeepFundsPerSec: 0.5,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { manpower: 0.2 }, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
    military: false,
    jobs: 10,
  },
  medicalCenter: {
    kind: 'medicalCenter', name: 'Medical Center', zone: ZoneType.COMMERCIAL,
    hp: 400,
    footprintW: 4, footprintH: 4, costFunds: 2000, costMaterials: 800,
    buildSeconds: 75, upkeepFundsPerSec: 3.0,
    powerDemand: 8, powerSupply: 0, waterDemand: 5, waterSupply: 0,
    output: { manpower: 1.0 }, input: {}, population: 0, taxBasePerSec: 10.0,
    minAge: 'industry',
    military: false,
    jobs: 60,
  },
  fireStation: {
    kind: 'fireStation', name: 'Fire Station', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 25, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'foundation',
    military: false,
    jobs: 6,
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
    hp: 450,
    footprintW: 3, footprintH: 3, costFunds: 500, costMaterials: 200,
    buildSeconds: 40, upkeepFundsPerSec: 0.9,
    powerDemand: 0, powerSupply: 30, waterDemand: 3, waterSupply: 0,
    output: {}, input: { fuel: 0.8 }, population: 0, taxBasePerSec: 3.0,
    minAge: 'industry', requiredUpgrade: 'combustionTech', fouling: true,
    jobs: 10,
  },
  gasPlant: {
    kind: 'gasPlant', name: 'Gas Plant', zone: UTILITY_ZONE,
    hp: 450,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 280,
    buildSeconds: 45, upkeepFundsPerSec: 1.0,
    powerDemand: 0, powerSupply: 35, waterDemand: 2, waterSupply: 0,
    output: {}, input: { fuel: 1.0 }, population: 0, taxBasePerSec: 3.5,
    minAge: 'industry', requiredUpgrade: 'combustionTech', fouling: true,
    jobs: 10,
  },
  windFarm: {
    kind: 'windFarm', name: 'Wind Farm', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 3, footprintH: 3, costFunds: 450, costMaterials: 150,
    buildSeconds: 30, upkeepFundsPerSec: 0.4,
    powerDemand: 0, powerSupply: 8, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'connectivity',
    jobs: 8,
  },
  hydroDam: {
    kind: 'hydroDam', name: 'Hydro Dam', zone: UTILITY_ZONE,
    hp: 550,
    footprintW: 4, footprintH: 2, costFunds: 1200, costMaterials: 500,
    buildSeconds: 70, upkeepFundsPerSec: 1.0,
    powerDemand: 0, powerSupply: 45, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'industry',
    jobs: 10,
  },
  geothermalPlant: {
    kind: 'geothermalPlant', name: 'Geothermal Plant', zone: UTILITY_ZONE,
    hp: 500,
    footprintW: 3, footprintH: 3, costFunds: 1600, costMaterials: 600,
    buildSeconds: 80, upkeepFundsPerSec: 1.2,
    powerDemand: 0, powerSupply: 40, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'information',
    jobs: 10,
  },
  fusionPlant: {
    kind: 'fusionPlant', name: 'Fusion Plant', zone: UTILITY_ZONE,
    hp: 700,
    footprintW: 4, footprintH: 4, costFunds: 4000, costMaterials: 1500,
    buildSeconds: 120, upkeepFundsPerSec: 3.0,
    powerDemand: 0, powerSupply: 120, waterDemand: 4, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 8.0,
    minAge: 'ascendance', requiredUpgrade: 'fusionResearch',
    jobs: 12,
  },
  waterWell: {
    kind: 'waterWell', name: 'Water Well', zone: UTILITY_ZONE,
    hp: 250,
    footprintW: 2, footprintH: 2, costFunds: 200, costMaterials: 60,
    buildSeconds: 15, upkeepFundsPerSec: 0.2,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 10,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'foundation', requiredUpgrade: 'groundwaterSurvey', foulable: true,
    jobs: 2,
  },
  waterTower: {
    kind: 'waterTower', name: 'Water Tower', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 25, upkeepFundsPerSec: 0.3,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', requiredUpgrade: 'gridStorage',
    storageKind: 'water', storageCapacity: 200,
    jobs: 2,
  },
  waterTreatment: {
    kind: 'waterTreatment', name: 'Water Treatment Plant', zone: UTILITY_ZONE,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 50, upkeepFundsPerSec: 1.2,
    powerDemand: 5, powerSupply: 0, waterDemand: 0, waterSupply: 20,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.5,
    minAge: 'industry',
    jobs: 8,
  },
  reservoir: {
    kind: 'reservoir', name: 'Reservoir', zone: UTILITY_ZONE,
    hp: 400,
    footprintW: 4, footprintH: 4, costFunds: 800, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 0.5,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'industry', requiredUpgrade: 'gridStorage',
    storageKind: 'water', storageCapacity: 800,
    jobs: 3,
  },
  powerSubstation: {
    kind: 'powerSubstation', name: 'Power Substation', zone: UTILITY_ZONE,
    hp: 250,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 100,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', conductsPower: true,
    jobs: 3,
  },
  pumpingStation: {
    kind: 'pumpingStation', name: 'Pumping Station', zone: UTILITY_ZONE,
    hp: 250,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 100,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', conductsWater: true,
    jobs: 3,
  },
  batteryStation: {
    kind: 'batteryStation', name: 'Battery Station', zone: UTILITY_ZONE,
    hp: 300,
    footprintW: 2, footprintH: 2, costFunds: 500, costMaterials: 180,
    buildSeconds: 30, upkeepFundsPerSec: 0.4,
    powerDemand: 0, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity', requiredUpgrade: 'gridStorage',
    storageKind: 'power', storageCapacity: 300,
    jobs: 2,
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
    hp: 350,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 120,
    buildSeconds: 25, upkeepFundsPerSec: 0.5,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: { fuel: 0.6 }, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'foundation',
    jobs: 6,
  },
  oilRig: {
    kind: 'oilRig', name: 'Offshore Oil Rig', zone: UTILITY_ZONE,
    hp: 450,
    footprintW: 3, footprintH: 3, costFunds: 1400, costMaterials: 600,
    buildSeconds: 60, upkeepFundsPerSec: 2.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: { fuel: 2.5 }, input: { materials: 0.2 }, population: 0,
    taxBasePerSec: 4.0,
    minAge: 'industry',
    jobs: 12,
  },
  munitionsFactory: {
    kind: 'munitionsFactory', name: 'Munitions Factory', zone: ZoneType.INDUSTRIAL,
    hp: 800,
    footprintW: 4, footprintH: 3, costFunds: 1200, costMaterials: 500,
    buildSeconds: 55, upkeepFundsPerSec: 1.6,
    powerDemand: 6, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: { materials: 0.4, funds: 0.6 }, population: 0,
    taxBasePerSec: 6.0,
    minAge: 'industry',
    ammoProduction: 2.0, ammoStorage: 60, reloadPoint: true,
    jobs: 20,
    military: true,
  },
  missilePlant: {
    kind: 'missilePlant', name: 'Missile Plant', zone: ZoneType.INDUSTRIAL,
    hp: 900,
    footprintW: 4, footprintH: 3, costFunds: 2200, costMaterials: 900,
    buildSeconds: 80, upkeepFundsPerSec: 2.5,
    powerDemand: 10, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: {}, input: { materials: 0.8, funds: 1.0 }, population: 0,
    taxBasePerSec: 8.0,
    minAge: 'industry', requiredBuilding: 'munitionsFactory',
    ammoProduction: 5.0, ammoStorage: 100, reloadPoint: true,
    jobs: 25,
    military: true,
  },
  missileSilo: {
    kind: 'missileSilo', name: 'Missile Silo', zone: UTILITY_ZONE,
    hp: 800,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 700,
    buildSeconds: 50, upkeepFundsPerSec: 1.2,
    powerDemand: 3, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'industry',
    ammoStorage: 400, reloadPoint: true,
    jobs: 6,
    military: true,
  },
  ordnanceDepot: {
    kind: 'ordnanceDepot', name: 'Ordnance Depot', zone: UTILITY_ZONE,
    hp: 600,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 400,
    buildSeconds: 40, upkeepFundsPerSec: 1.0,
    powerDemand: 3, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'industry',
    ammoStorage: 150, reloadPoint: true,
    jobs: 8,
    military: true,
  },
  fuelDepot: {
    kind: 'fuelDepot', name: 'Fuel Depot', zone: UTILITY_ZONE,
    hp: 600,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 300,
    buildSeconds: 40, upkeepFundsPerSec: 0.8,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'foundation',
    fuelStorage: 250, reloadPoint: true,
    jobs: 6,
    military: true,
  },
  // ------------------------------------------------------------------
  // Grand-expansion Phase 5 — airports (workstream A, S5+S8,
  // 2026-09-30): the airport roster. All fourteen kinds require
  // ZoneType.AIRPORT (the fourth zone type); `validatePlacement`
  // enforces it and `tryAutoDevelop` never builds here — airports are
  // player-placed infrastructure only. The three site anchors
  // (civilAirport / militaryAirbase / mixedAirport) are the big
  // placeable airports: the civil one anchors civilian airline routes
  // (§3.5 income) and ambient airliners, the military one is a
  // zone-gated alternative to the utility-zone airfield for the
  // military air arm, and the mixed one does both while DISPLAYING as
  // civilian to other players (intel is Phase 7 — the display rule
  // lives in ui/airports.ts `airportDisplayType`). Terminals drive
  // §3.5 income directly (harvest funds, runHarvest) and boost airline
  // route income (economy.ts `airlineRouteIncome`); the control tower
  // is neutral ops flavor; hangarS/M/L are the per-class aircraft
  // storage of §AD6 (light/medium/heavy — `hangarCapacity` slot counts
  // × `hangarClass` feed the hangar workstream's `defaultHangarSlots`);
  // the fuel farm is the airside fuel-logistics hook (fuelStorage 500
  // × reloadPoint, same refill path as the depots); the maintenance
  // hangar is repair flavor (jobs); runwayS/M/L are the §AD7 tier
  // modules — a runway of class C serves aircraft of class ≤ C, shown
  // in the build UI so the choice gates aircraft class pre-purchase.
  // (Port defs are workstream C's own region below — same S5
  // civilian/military/mixed axis via `portType`, `countsAs`, and
  // `harvest`, but zone UTILITY_ZONE + coastline, not airport zones.)
  // ------------------------------------------------------------------
  civilAirport: {
    kind: 'civilAirport', name: 'Civil Airport', zone: ZoneType.AIRPORT,
    hp: 600,
    footprintW: 6, footprintH: 5, costFunds: 2000, costMaterials: 800,
    buildSeconds: 90, upkeepFundsPerSec: 2.5,
    powerDemand: 8, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 8.0,
    minAge: 'connectivity',
    airportType: 'civilian',
    harvest: { funds: 1.0 }, // landing fees (economy runHarvest)
    reloadPoint: true,
    jobs: 40,
  },
  militaryAirbase: {
    kind: 'militaryAirbase', name: 'Military Airbase', zone: ZoneType.AIRPORT,
    hp: 800,
    footprintW: 6, footprintH: 5, costFunds: 1800, costMaterials: 700,
    buildSeconds: 80, upkeepFundsPerSec: 2.0,
    powerDemand: 7, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'connectivity',
    airportType: 'military',
    countsAs: ['airfield'], // trains military aircraft like an airfield
    reloadPoint: true,
    jobs: 35,
    military: true,
  },
  mixedAirport: {
    kind: 'mixedAirport', name: 'Mixed Airport', zone: ZoneType.AIRPORT,
    hp: 700,
    footprintW: 7, footprintH: 6, costFunds: 2600, costMaterials: 1000,
    buildSeconds: 110, upkeepFundsPerSec: 3.0,
    powerDemand: 10, powerSupply: 0, waterDemand: 5, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 10.0,
    minAge: 'connectivity',
    airportType: 'mixed', // displays civilian to others (ui/airports.ts)
    countsAs: ['airfield'], // military-capable: trains like an airfield
    harvest: { funds: 1.2 }, // landing fees + military contracts
    reloadPoint: true,
    jobs: 50,
    military: true,
  },
  passengerTerminal: {
    kind: 'passengerTerminal', name: 'Passenger Terminal', zone: ZoneType.AIRPORT,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 300,
    buildSeconds: 50, upkeepFundsPerSec: 0.9,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'connectivity',
    harvest: { funds: 0.8 }, // §3.5 passenger income (economy runHarvest)
    jobs: 25,
  },
  cargoTerminal: {
    kind: 'cargoTerminal', name: 'Cargo Terminal', zone: ZoneType.AIRPORT,
    hp: 400,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 50, upkeepFundsPerSec: 0.9,
    powerDemand: 4, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'connectivity',
    harvest: { funds: 0.6 }, // §3.5 cargo income (economy runHarvest)
    jobs: 20,
  },
  controlTower: {
    kind: 'controlTower', name: 'Control Tower', zone: ZoneType.AIRPORT,
    hp: 350,
    footprintW: 2, footprintH: 2, costFunds: 500, costMaterials: 200,
    buildSeconds: 30, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    jobs: 8,
  },
  hangarS: {
    kind: 'hangarS', name: 'Hangar (Light)', zone: ZoneType.AIRPORT,
    hp: 400,
    footprintW: 2, footprintH: 2, costFunds: 300, costMaterials: 120,
    buildSeconds: 25, upkeepFundsPerSec: 0.3,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity',
    hangarClass: 'light', hangarCapacity: 2, // §AD6 per-class storage
    jobs: 4,
  },
  hangarM: {
    kind: 'hangarM', name: 'Hangar (Medium)', zone: ZoneType.AIRPORT,
    hp: 500,
    footprintW: 3, footprintH: 2, costFunds: 450, costMaterials: 180,
    buildSeconds: 30, upkeepFundsPerSec: 0.4,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'connectivity',
    hangarClass: 'medium', hangarCapacity: 2, // §AD6 per-class storage
    jobs: 5,
  },
  hangarL: {
    kind: 'hangarL', name: 'Hangar (Heavy)', zone: ZoneType.AIRPORT,
    hp: 600,
    footprintW: 3, footprintH: 3, costFunds: 700, costMaterials: 280,
    buildSeconds: 40, upkeepFundsPerSec: 0.6,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    hangarClass: 'heavy', hangarCapacity: 1, // §AD6 per-class storage
    jobs: 6,
  },
  fuelFarm: {
    kind: 'fuelFarm', name: 'Fuel Farm', zone: ZoneType.AIRPORT,
    hp: 450,
    footprintW: 3, footprintH: 3, costFunds: 600, costMaterials: 250,
    buildSeconds: 40, upkeepFundsPerSec: 0.7,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    fuelStorage: 500, reloadPoint: true, // airside fuel-logistics hook
    jobs: 8,
  },
  maintenanceHangar: {
    kind: 'maintenanceHangar', name: 'Maintenance Hangar', zone: ZoneType.AIRPORT,
    hp: 450,
    footprintW: 3, footprintH: 2, costFunds: 500, costMaterials: 200,
    buildSeconds: 35, upkeepFundsPerSec: 0.5,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    jobs: 10,
  },
  runwayS: {
    kind: 'runwayS', name: 'Runway (Light)', zone: ZoneType.AIRPORT,
    hp: 300,
    footprintW: 5, footprintH: 1, costFunds: 400, costMaterials: 150,
    buildSeconds: 30, upkeepFundsPerSec: 0.3,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.0,
    minAge: 'connectivity',
    runwayClass: 'light', // §AD7: serves light aircraft
    jobs: 0,
  },
  runwayM: {
    kind: 'runwayM', name: 'Runway (Medium)', zone: ZoneType.AIRPORT,
    hp: 350,
    footprintW: 7, footprintH: 1, costFunds: 700, costMaterials: 250,
    buildSeconds: 40, upkeepFundsPerSec: 0.5,
    powerDemand: 1, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
    minAge: 'connectivity',
    runwayClass: 'medium', // §AD7: serves light + medium aircraft
    jobs: 0,
  },
  runwayL: {
    kind: 'runwayL', name: 'Runway (Heavy)', zone: ZoneType.AIRPORT,
    hp: 400,
    footprintW: 9, footprintH: 1, costFunds: 1100, costMaterials: 400,
    buildSeconds: 55, upkeepFundsPerSec: 0.8,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    runwayClass: 'heavy', // §AD7: serves all aircraft classes
    jobs: 0,
  },
  // ------------------------------------------------------------------
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30): the three civilian docks + the military naval base
  // (S5). All require coastline — the validatePlacement rule keys on
  // def.portType (one rule, no per-kind list). Naval-building model
  // (2026-10-01): the three civilian kinds carry `tradeDock: true` —
  // they are the trade-dock interface where sea routes anchor; the
  // civilian shipyard (commercialHarbor, below) builds ships and never
  // trades. commercialPort counts as a shipyard and navalBase as a
  // navalYard for production gates (S5 `countsAs`), so a fleet can be
  // built from a mixed-use port town. Ports are the navy-side reload
  // infrastructure: commercialPort stocks fuel, navalBase stocks fuel
  // + ammo (the fleet's forward depot, via fuelStorage/ammoStorage —
  // the supply-chain refill path is the same as the depots').
  // ------------------------------------------------------------------
  commercialPort: {
    kind: 'commercialPort', name: 'Commercial Docks', zone: UTILITY_ZONE,
    hp: 500,
    footprintW: 4, footprintH: 3, costFunds: 800, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 0.8,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 8.0,
    minAge: 'connectivity',
    portType: 'civilian',
    // The civilian shipping interface: the general-cargo trade dock
    // where sea routes anchor (funds harvest).
    tradeDock: true,
    countsAs: ['shipyard'],
    harvest: { funds: 1.5 }, // civilian sea-trade income (economy runHarvest)
    reloadPoint: true,
    fuelStorage: 200,
    jobs: 30,
  },
  containerPort: {
    kind: 'containerPort', name: 'Container Port', zone: UTILITY_ZONE,
    hp: 550,
    footprintW: 5, footprintH: 4, costFunds: 1500, costMaterials: 600,
    buildSeconds: 70, upkeepFundsPerSec: 1.5,
    powerDemand: 6, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 12.0,
    minAge: 'industry',
    portType: 'civilian',
    // The bulk-cargo trade dock: heavy sea-trade income.
    tradeDock: true,
    harvest: { funds: 2.5 }, // heavy sea-trade income (economy runHarvest)
    jobs: 40,
  },
  fishingHarbor: {
    kind: 'fishingHarbor', name: 'Fishing Harbor', zone: UTILITY_ZONE,
    hp: 400,
    footprintW: 3, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 25, upkeepFundsPerSec: 0.35,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'foundation',
    portType: 'civilian',
    // The food trade dock: the dockside catch (food harvest).
    tradeDock: true,
    harvest: { food: 1.2 }, // the dockside catch (economy runHarvest)
    jobs: 12,
  },
  navalBase: {
    kind: 'navalBase', name: 'Naval Base', zone: UTILITY_ZONE,
    hp: 700,
    footprintW: 5, footprintH: 4, costFunds: 2000, costMaterials: 800,
    buildSeconds: 90, upkeepFundsPerSec: 2.0,
    powerDemand: 6, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'industry',
    portType: 'military',
    countsAs: ['navalYard'],
    // Naval-building model (2026-10-01): the military shipping
    // interface — the docks where military transports load/unload fuel,
    // ammunition, and materials for forward operations. It builds
    // nothing and repairs nothing (production vs. logistics stays
    // unblurred: shipyards build/repair, docks move cargo). The primary
    // forward logistics point for the fuelTanker / ammoShip pair
    // (see computeCargoTransfer in commands.ts).
    reloadPoint: true,
    fuelStorage: 300,
    ammoStorage: 100,
    // Sea-logistics Half B (2026-10-01): the forward dry-stores cache —
    // military transports unload construction materials here via
    // `unloadCargo` (200 ≈ one fuelTanker's full materials hold).
    materialsStorage: 200,
    jobs: 35,
    military: true,
  },
  // ------------------------------------------------------------------
  // Civilian sea trade (Half A, 2026-10-01): the civilian shipyard —
  // the civilian production building. NON-military (no `military` flag
  // ⇒ peaceful-buildable, the whole point: peaceful players get a sea
  // production building), `portType: 'civilian'` (coastline required,
  // the navalYard precedent — no per-kind placement rule), and the
  // requiredBuilding gate for cargoFreighter + fuelBarge (units.ts).
  // Naval-building model (2026-10-01): it builds AND repairs civilian
  // ships (repair arrives free via sim/shipyardRepair.ts — the
  // drydock rule matches production shipyards by side), but it is NOT
  // a trade dock (`tradeDock` stays unset): sea routes anchor only at
  // the three civilian docks above — shipyards build, docks trade.
  // A forward fuel depot too: reloadPoint + fuelStorage, so the
  // supply-truck chain stocks it and fuel barges load where they are
  // built (ships fuel at the yard that built them — not trade blur).
  // Balance vs shipyard (1200/500, upkeep 1.5, 20 jobs, military) and
  // commercialPort (800/300, upkeep 0.8, 30 jobs, 1.5 funds/s
  // harvest): cheaper than the shipyard (unarmed hulls only), pricier
  // than the docks (it is a production building, not an income
  // building — no harvest).
  // ------------------------------------------------------------------
  commercialHarbor: {
    kind: 'commercialHarbor', name: 'Civilian Shipyard', zone: UTILITY_ZONE,
    hp: 500,
    footprintW: 4, footprintH: 3, costFunds: 1000, costMaterials: 400,
    buildSeconds: 50, upkeepFundsPerSec: 1.0,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 6.0,
    minAge: 'industry',
    portType: 'civilian',
    reloadPoint: true,
    fuelStorage: 300,
    jobs: 25,
  },
  // ------------------------------------------------------------------
  // Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
  // 2026-09-30). All four zone: UTILITY_ZONE (placeable anywhere on
  // land, like the radarStation) and accrue their assets through
  // `runIntelAccrual` (sim/intel.ts). Balance rationale lives in
  // docs/research/intel-roster.md; art keys are the art workstream's
  // (render falls back to placeholders for unmapped kinds, so the
  // 8 MiB boot gate is untouched).
  // ------------------------------------------------------------------
  intelHQ: {
    kind: 'intelHQ', name: 'Intelligence Headquarters', zone: UTILITY_ZONE,
    hp: 600,
    footprintW: 3, footprintH: 3, costFunds: 1400, costMaterials: 450,
    buildSeconds: 55, upkeepFundsPerSec: 1.2,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
    minAge: 'information',
    // Trains spies (units.ts `spy.requiredBuilding`) and generates the
    // operational assets missions spend, plus a trickle of analysis
    // (surveillance) from its own desks.
    intelOutput: { operational: 0.2, surveillance: 0.1 },
    jobs: 12,
    military: true,
  },
  listeningPost: {
    kind: 'listeningPost', name: 'Listening Post', zone: UTILITY_ZONE,
    hp: 400,
    footprintW: 2, footprintH: 2, costFunds: 500, costMaterials: 150,
    buildSeconds: 30, upkeepFundsPerSec: 0.6,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 2.0,
    minAge: 'connectivity',
    // The early SIGINT building: steady surveillance income and the
    // first detection-radius source (stealthed units inside are seen).
    intelOutput: { surveillance: 0.25 },
    detectionRadius: 60,
    jobs: 6,
    military: true,
  },
  satelliteUplink: {
    kind: 'satelliteUplink', name: 'Satellite Uplink', zone: UTILITY_ZONE,
    hp: 500,
    footprintW: 3, footprintH: 3, costFunds: 2500, costMaterials: 900,
    buildSeconds: 90, upkeepFundsPerSec: 2.0,
    powerDemand: 8, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 5.0,
    minAge: 'ascendance',
    // Late-age: the big surveillance earner, plus a standing sight
    // bonus for the owner's units (consumed by the sim-core
    // workstream's effectiveSight hook).
    intelOutput: { surveillance: 0.6 },
    sightBonus: 12,
    jobs: 8,
    military: true,
  },
  signalsStation: {
    kind: 'signalsStation', name: 'Signals Station', zone: UTILITY_ZONE,
    hp: 500,
    footprintW: 2, footprintH: 2, costFunds: 900, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 1.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 3.0,
    minAge: 'information',
    // Counter-intel asset generation and the second detection-radius
    // source — the visible answer to enemy spies.
    intelOutput: { counterIntel: 0.2 },
    detectionRadius: 45,
    jobs: 10,
    military: true,
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
/** Road cost per cell (the `paved` class — see ROAD_CLASS_STATS). */
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
/**
 * Phase 3 logistics: how far (world units) a reload point's refill aura
 * reaches. 18 ≈ 9 cells — the depot plus its immediate surroundings.
 * Rationale: smaller than command auras (HQ 20, Command Ship 24) so
 * supply stays a positioning decision rather than a map-wide buff, but
 * larger than the biggest depot footprint (4x3 cells = 8x6 world units)
 * so units parked at the gate are always in range.
 *
 * Lives here (not economy.ts) so commands.ts can value-import it
 * without an economy↔commands cycle — the `loadCargo`/`unloadCargo`
 * orders use the same radius as the aura (sea-logistics Half B,
 * 2026-10-01). Re-exported from economy.ts for existing importers.
 */
export const LOGISTICS_RADIUS = 18;

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
/**
 * Grand-expansion Phase 5 (hangars, S4 — 2026-09-30): aircraft size
 * class. 'light' = small (drones, trainers, light helos), 'medium' =
 * medium (fighters, patrol aircraft, gunships), 'heavy' = large
 * (bombers, airliners, tankers, heavy lift). Matches PLAN §3.5's
 * hangarS/M/L (hangarS stores light-class aircraft, etc.) and §AD6.
 * Set on every air UnitDef (`hangarClass`); the legacy airfield's
 * generic slots accept any class.
 */
export type HangarClass = 'light' | 'medium' | 'heavy';
/**
 * TEMPORARY ALIAS (2026-09-30, airport workstream): the hangar
 * workstream is mid-rename from `HangarClass` to `AircraftClass`
 * (the taxonomy classifies aircraft, hangar slots AND runways —
 * `HangarSlot.cls` and `findBuildingHangarSlot` already say
 * `AircraftClass`). This alias keeps the tree compiling until they
 * land the rename; the hangar workstream owns the final name and
 * should delete this alias when it does. Do not branch new code on
 * the difference — the two names are identical by construction.
 */
export type AircraftClass = HangarClass;

/**
 * One parked-aircraft slot: `cls` is the aircraft class the slot
 * accepts ('generic' = any class — the pre-class-system legacy
 * default); `occupant` is the parked aircraft's unit id (0 = empty).
 * Snapshotted and digest-covered (PLAN §4 S4).
 */
export interface HangarSlot {
  cls: HangarClass | 'generic';
  occupant: number;
}

/**
 * How many generic hangar slots a legacy (v7) airfield decodes to —
 * and how many a freshly placed airfield gets. The pre-Phase-5
 * airfield had no class system — any aircraft could park there — so
 * the slots are 'generic'. Pinned in sim.hangars.test.ts: change the
 * number and the test (and this doc) must change with it (PLAN §4 S4:
 * "document the exact default, pin in test").
 */
export const LEGACY_AIRFIELD_HANGAR_SLOTS = 6;

/**
 * Hangar slots for a building kind when no slots are stored: legacy v7
 * saves (via snapshot.ts v8) and fresh `placeBuilding` records share
 * this definition. 'airfield' → LEGACY_AIRFIELD_HANGAR_SLOTS generic
 * empty slots; a def-declared `hangarCapacity` with a typed
 * `hangarClass` (hangarS/M/L, one class each) → that many typed slots;
 * everything else → undefined ("never had hangars", distinct from
 * "hangars removed" — AD9). Exported so the AI's virtual-capacity
 * logic (ai.ts) shares one definition.
 */
export function defaultHangarSlots(kind: BuildingKind): HangarSlot[] | undefined {
  const def = BUILDING_DEFS[kind];
  if (
    def?.hangarCapacity !== undefined &&
    def?.hangarClass !== undefined &&
    def.hangarClass !== 'generic'
  ) {
    const slots: HangarSlot[] = [];
    for (let i = 0; i < def.hangarCapacity; i++) {
      slots.push({ cls: def.hangarClass, occupant: 0 });
    }
    return slots;
  }
  if (kind === 'airfield') {
    const slots: HangarSlot[] = [];
    for (let i = 0; i < LEGACY_AIRFIELD_HANGAR_SLOTS; i++) {
      slots.push({ cls: 'generic', occupant: 0 });
    }
    return slots;
  }
  return undefined;
}

/**
 * Index of a free slot compatible with `cls` in `slots`, or -1. A
 * 'generic' slot accepts any class; otherwise the classes must match.
 * Pure — the reservation write belongs to the caller (the shared
 * `findHangarSlot` in sim/units.ts, inside `registerUnitCommands` —
 * PLAN §4 S4).
 */
export function findBuildingHangarSlot(
  slots: HangarSlot[] | undefined,
  cls: HangarClass | undefined,
): number {
  if (!slots) return -1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i] as HangarSlot;
    if (s.occupant !== 0) continue;
    if (s.cls === 'generic' || cls === undefined || s.cls === cls) return i;
  }
  return -1;
}

/**
 * Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30): one
 * viewer's discovery state for a mixed-use airport anchor. Only ever
 * set on buildings whose def has `airportType === 'mixed'`; the owner
 * never appears as a viewer of their own airport (they know what they
 * built).
 *
 * Lifecycle (advanced by `runAirportDiscovery` in sim/intel.ts):
 *  - `suspected`: a rival's observation (embedded spy, SIGINT coverage,
 *    or recon overflight) fired the warning at `warnedTick` — the
 *    discovering side is told "suspicious military activity", but the
 *    airport still displays civilian to them. Suspicion latches: the
 *    photos exist, analysis is inevitable (a documented fairness
 *    choice — the grace period is the analysis window, not a second
 *    observation gate).
 *  - `revealed`: at `warnedTick + AIRPORT_DISCOVERY_GRACE_TICKS` the
 *    true type flips visible — the airport displays as mixed (its true
 *    type) to this viewer from now on, and the discovering side's AI
 *    may treat it as a military target.
 *
 * Plain data (JSON-safe): snapshotted (v8, AD9 additive — no version
 * bump) and digest-covered (PLAN §11 — display-affecting). The UI seam
 * for the intel panel: read `building.discovery` (or
 * `discoveryStateOf` in ui/airports.ts) for the viewing owner.
 */
export interface AirportDiscoveryState {
  /** The discovering owner (never the airport's owner). */
  viewer: number;
  state: 'suspected' | 'revealed';
  /** World tick the warning fired (observation tick). */
  warnedTick: number;
  /** warnedTick + grace; 0 until revealed. */
  revealedTick: number;
}

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
   * Final-review R2 (2026-10-01): structural hit points. `maxHp` is the
   * def's `hp` at placement (repairs/refits never raise it in 0.1
   * Alpha); `hp` drops under attack and the building is destroyed at
   * 0 via `destroyBuilding`. Optional so pre-R2 record literals keep
   * compiling; every read uses `?? BUILDING_DEFS[b.kind].hp` (AD9 —
   * the veterancy `?? 0` precedent). Snapshotted (v8, additive — no
   * version bump) and digest-covered (destruction is
   * behavior-affecting, PLAN §11).
   */
  hp?: number;
  maxHp?: number;
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
   * Sea-logistics Half B (2026-10-01): forward construction-materials
   * cache (see `materialsStorage`). Delivered by the `unloadCargo`
   * command; no spend path in 0.1 Alpha. Optional, reads use `?? 0`
   * (AD9), snapshotted and digested like the other stocks.
   */
  materialsStock?: number;
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
  /**
   * Phase 4 occupancy (2026-09-30): people living/working here right
   * now. Recomputed every economy tick by `recomputeOccupancy`
   * (economy.ts) — never simulated per-individual:
   * `residents` = def.population when completed (progress >= 1),
   * `workers` = filled jobs (id-order from the owner's population).
   * Optional so pre-Phase-4 record literals keep compiling; every read
   * uses `?? 0` (AD9 — the veterancy precedent). Snapshotted and
   * digest-covered (the selection panel refreshes on digest change).
   */
  residents?: number;
  workers?: number;
  /**
   * Phase 4 building variety (2026-09-30): visual variant 0..3 and
   * size tier 1..3, assigned at placement from a pure hash of
   * (worldSeed, anchorCell, kind) — same seed + same cell = same
   * street, no RNG draws. The render worker maps variant → alternate
   * facade/props through the lazy-loading pipeline (variant model keys
   * are NEVER in the boot set — see the contract on
   * BUILDING_VARIANT_COUNT). Optional for AD9 (`?? 0` / `?? 1`);
   * snapshotted and digest-covered.
   */
  variant?: number;
  sizeTier?: 1 | 2 | 3;
  /**
   * Grand-expansion Phase 5/6, S4 (hangars + carriers): the aircraft
   * parking slots this building offers (`HangarSlot`, defined with the
   * hangar system — `cls` + `occupant`, 0 = empty). Optional; reads
   * use `?? defaultHangarSlots(kind)` (AD9). v7 snapshots predate the
   * field — legacy airfields decode to LEGACY_AIRFIELD_HANGAR_SLOTS
   * generic slots (the documented S4 default, pinned in
   * sim.hangars.test.ts); every other legacy building decodes to
   * undefined ("never had hangars", distinct from "hangars removed").
   * Snapshotted (v8) and digest-covered.
   */
  hangars?: HangarSlot[];
  /**
   * Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
   * 2026-09-30): world tick until which this building stays sabotaged
   * (the interface contract — exact name). While sabotaged the
   * building accrues no intel assets; the wider sabotage effect (how
   * much it hurts) is the sim-core workstream's `sabotage` command
   * design — set ONLY on that path, never by a timer. 0/undefined =
   * not sabotaged (the meltdown `?? 0` precedent). Snapshotted (v8,
   * AD9 additive — no version bump) and digest-covered.
   */
  sabotagedUntil?: number;
  /**
   * Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30):
   * per-viewer mixed-airport discovery state (`AirportDiscoveryState`,
   * above). Undefined/empty = no rival has observed this airport twice.
   * Set ONLY by `runAirportDiscovery` (sim/intel.ts), never by a
   * command; demolishing the building deletes the records with it.
   * Optional so pre-Phase-7 record literals keep compiling; every read
   * uses `?? []` (AD9). Snapshotted (v8, additive — no version bump)
   * and digest-covered (display-affecting, PLAN §11).
   */
  discovery?: AirportDiscoveryState[];
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
  /**
   * Tax rates 0..1 for [residential, commercial, industrial, airport].
   * The 4th element (airport zones) is grand-expansion Phase 5 (S5,
   * 2026-09-30): older saves decode it to DEFAULT_TAX_RATE via
   * `?? DEFAULT_TAX_RATE` in snapshot.ts `copyPlayer` (AD9 additive —
   * no snapshot version bump; the exact default is pinned by
   * sim.airports.test.ts). `runTaxes` indexes by zone so airport-zone
   * buildings are taxed at the airport rate.
   */
  taxRates: [number, number, number, number];
  /** Derived each economy tick from residential capacity. */
  population: number;
  /**
   * Phase 3 city specialization: 'balanced' (no modifiers) or a focus
   * that boosts matching-zone building output by 25% at a 10% penalty
   * to other zoned buildings. Set via the `setSpecialization` command.
   */
  specialization: CitySpecialization;
  /**
   * Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
   * 2026-09-30): per-player intel asset counters (the interface
   * contract — exact shape `world.city.players[o].intel`). Plain
   * numbers; snapshotted and digested. Accrued by `runIntelAccrual`
   * (sim/intel.ts); spent by the sim-core workstream's
   * `infiltrateBuilding` / `sabotage` commands.
   */
  intel: IntelAssets;
  /**
   * Grand-expansion Phase 8 (civilian ordinances, workstream E,
   * 2026-09-30): the player's city-wide policy toggles (true = on).
   * Set via the `setPolicy` command; snapshotted verbatim and
   * digest-encoded in POLICY_IDS order (see snapshot.ts `copyPlayer`,
   * digest.ts). Absent/legacy saves decode to {}.
   */
  policies: Partial<Record<PolicyId, boolean>>;
  /**
   * DERIVED, per-tick funding decision — which toggled policies the
   * last economy tick's upkeep pass actually funded (see
   * `allocateUtilities` in economy.ts). Effects read
   * `policyFunded()`, never this array directly. NEVER snapshotted
   * (decode resets to []) and never in the digest — it is a pure
   * function of (funds, toggles, buildings), so digest coverage of
   * the inputs covers it (the desirability-model precedent).
   */
  fundedPolicies: PolicyId[];
}

/** The whole city. Lives on `World.city`; snapshotted and digested. */
export interface CityState {
  /**
   * Phase 4 (S7): road cells with their class, sorted by cell.
   * `{cell, cls}` with cls ∈ dirt | country | paved | highway.
   * v6 snapshots carry `number[]` — see `migrateRoadsV6ToV7`.
   */
  roads: RoadCell[];
  /**
   * Phase 4 (S7): rail cells with their track class, sorted by cell.
   * `{cell, cls}` with cls ∈ standard | electric | high-speed.
   * New in v7 — legacy saves decode to [] (AD9 additive).
   * Rails are NOT utility conductors (roads/lines/pipes are).
   */
  rails: RailCell[];
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
  /**
   * Grand-expansion Phase 5 (S5, 2026-09-30): active civilian airline
   * routes (established via the `establishAirlineRoute` command).
   * Additive — legacy saves decode to [] (snapshot.ts, no version
   * bump); digest-covered (route income is behavior-affecting).
   */
  airlineRoutes: AirlineRoute[];
  /** Next airline route id (starts at 1; 0 = none). */
  nextAirlineRouteId: number;
  /**
   * Civilian sea trade (Half A, 2026-10-01): active harbor-to-harbor
   * sea routes (established via the `establishSeaRoute` command).
   * Additive — legacy saves decode to [] (snapshot.ts, no version
   * bump); digest-covered (per-voyage income is behavior-affecting).
   */
  seaRoutes: SeaRoute[];
  /** Next sea route id (starts at 1; 0 = none). */
  nextSeaRouteId: number;
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
    taxRates: [DEFAULT_TAX_RATE, DEFAULT_TAX_RATE, DEFAULT_TAX_RATE, DEFAULT_TAX_RATE],
    population: 0,
    specialization: 'balanced',
    // Grand-expansion intel roster (workstream 2, 2026-09-30): every
    // player starts with zero intel assets.
    intel: { ...ZERO_INTEL_ASSETS },
    // Grand-expansion Phase 8 (civilian ordinances, workstream E,
    // 2026-09-30): no policies on at game start; nothing funded yet.
    policies: {},
    fundedPolicies: [],
  };
}

/** Fresh city: no roads, no rails, no zones, two players (0 = human, 1 = AI rival). */
export function initCity(): CityState {
  return {
    roads: [],
    rails: [],
    powerLines: [],
    pipes: [],
    utilityEpoch: 0,
    zones: [],
    buildings: [],
    nextBuildingId: 1,
    players: [createPlayer(0, 'Player'), createPlayer(1, 'Rival')],
    foodShortage: false,
    tradeRoutes: [],
    airlineRoutes: [],
    nextAirlineRouteId: 1,
    seaRoutes: [],
    nextSeaRouteId: 1,
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

/**
 * Intel building-sight cache version (final-review R3 L7, 2026-10-01).
 * `intelSightBonus` (upgrades.ts) sums `sightBonus` over completed
 * buildings per owner — O(buildings) per call, and it is called per
 * sight query (O(buildings×units)/tick in the AI recon loop). The sum
 * is cached per (city, owner) and validated by:
 *  - the buildings array identity + length + last element (catches
 *    placements, demolitions, direct fixture pushes, and wholesale
 *    replacement — snapshot restore builds a fresh CityState, so the
 *    WeakMap starts empty), and
 *  - this version counter, bumped by `bumpSightBonusCache` at the one
 *    mutation the array check cannot see: a building's `progress`
 *    crossing to 1 (construction completion in economy.ts).
 * Direct `b.progress` writes in test fixtures bypass the bump — such
 * fixtures must call `bumpSightBonusCache` themselves.
 */
const sightBonusCacheVersion = new WeakMap<CityState, number>();

/** Invalidate the cached intel building-sight term for this city. */
export function bumpSightBonusCache(city: CityState): void {
  sightBonusCacheVersion.set(city, (sightBonusCacheVersion.get(city) ?? 0) + 1);
}

/** Current cache version for `intelBuildingSightBonus` (upgrades.ts). */
export function sightBonusCacheVersionOf(city: CityState): number {
  return sightBonusCacheVersion.get(city) ?? 0;
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
  if (!roadSortedHas(city.roads, a) || !roadSortedHas(city.roads, b)) return false;
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
      if (!visited.has(n) && roadSortedHas(city.roads, n)) {
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
    if (roadSortedHas(city.roads, cell)) return `${def.name}: footprint overlaps a road`;
    const other = buildingAtCell(city, cell);
    if (other) return `${def.name}: footprint overlaps building #${other.id}`;
    if (def.zone !== UTILITY_ZONE) {
      const z = zoneAt(city, cell);
      if (z !== def.zone) {
        // Grand-expansion Phase 5 (S5, 2026-09-30): the fourth zone
        // type gets its own label — airport buildings (zone: AIRPORT)
        // reject loudly anywhere but airport zoning.
        const want = def.zone === ZoneType.RESIDENTIAL ? 'residential' : def.zone === ZoneType.COMMERCIAL ? 'commercial' : def.zone === ZoneType.AIRPORT ? 'airport' : 'industrial';
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
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30): every port needs the coast — one rule keyed on
  // def.portType, no per-kind list (the navalYard isCoastal precedent).
  if (def.portType !== undefined && !isCoastal(t, p.cx, p.cz, def.footprintW, def.footprintH)) {
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
  // Phase 4 (S7): ferries need a shoreline terminal and marinas are
  // waterfront leisure — the navalYard isCoastal precedent. Tiered
  // transit (2026-09-30): the ferry pier is the small coastal stop.
  if (
    (p.kind === 'ferryTerminal' || p.kind === 'marina' || p.kind === 'marinaLarge' || p.kind === 'ferryPier') &&
    !isCoastal(t, p.cx, p.cz, def.footprintW, def.footprintH)
  ) {
    return `${def.name}: must be built on the coast (adjacent to water)`;
  }
  const player = getPlayer(city, p.owner) as PlayerState;
  if (player.funds < def.costFunds || player.materials < def.costMaterials) {
    return `${def.name}: cannot afford (needs ${def.costFunds} funds + ${def.costMaterials} materials)`;
  }
  return null;
}

/**
 * Phase 4 building variety (2026-09-30): visual variants per building
 * kind. The render worker resolves `variant` through the existing
 * lazy model pipeline (e.g. a `${kind}_v${variant}` key); variant keys
 * are resolved on demand and MUST NOT be added to the boot set — the
 * model budget stays flat (same lazy cache, no new downloads at
 * startup). The sim only stores the index.
 */
export const BUILDING_VARIANT_COUNT = 4;
/** Size tiers: 1 = small, 2 = medium, 3 = large (within-kind scale). */
export const BUILDING_SIZE_TIERS = 3;

/**
 * Phase 4 building variety (2026-09-30): pure variant/size selection.
 * FNV-1a over (seed, anchorCell, kind, salt) — deterministic, no RNG
 * stream consumed, stable across save/load (seed and cell are
 * snapshot-stable). Different salts decorrelate variant from sizeTier.
 */
export function buildingVariantSeed(seed: number, cell: number, kind: string, salt: string): number {
  return fnv1a32(`${seed >>> 0}:${cell}:${kind}:${salt}`);
}

/** Place a validated building. Deducts costs, creates the record. */
export function placeBuilding(city: CityState, p: Placement, seed = 0): BuildingRecord {
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
    // Final-review R2 (2026-10-01): buildings are destructible — fresh
    // buildings start at full structural HP (def.hp).
    hp: def.hp,
    maxHp: def.hp,
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
    // Sea-logistics Half B: materialsStock starts empty too (AD9).
    ammoStock: 0,
    fuelStock: 0,
    materialsStock: 0,
    // Phase 4 building variety: hash-picked at placement (see
    // buildingVariantSeed). Occupancy starts at zero; the first
    // economy tick fills residents/workers.
    variant: buildingVariantSeed(seed, cellIndex(p.cx, p.cz), p.kind, 'variant') % BUILDING_VARIANT_COUNT,
    sizeTier: (buildingVariantSeed(seed, cellIndex(p.cx, p.cz), p.kind, 'size') % BUILDING_SIZE_TIERS + 1) as 1 | 2 | 3,
    residents: 0,
    workers: 0,
    // Phase 5 hangars (S4): fresh buildings get their kind's hangar
    // slots now (airfield → LEGACY_AIRFIELD_HANGAR_SLOTS generic;
    // hangarS/M/L → typed slots; everything else → undefined).
    hangars: defaultHangarSlots(p.kind),
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
  // Final-review R3 L7: removing a (possibly completed, sight-granting)
  // building changes the intel building-sight sum — invalidate its cache.
  // This is the single removal path: destroyBuilding (combat kills, the
  // storm strike) and the demolish command both funnel through here.
  bumpSightBonusCache(city);
  return true;
}

/**
 * Destroy a building in combat (final-review R2, 2026-10-01): the full
 * demolish cleanup — resupply reservations against the building are
 * released and parked aircraft's hangar links cleared — then the record
 * is removed via `demolishBuilding`. This is the single destruction
 * path: the `demolish` command and combat's `damageBuilding` both call
 * it (the loops used to be inlined in the demolish command; the manual
 * mirror was a sync hazard — see the AGENTS.md note on the
 * city→commands import-cycle reason they can't live in commands.ts).
 * Returns true when a building was removed.
 */
export function destroyBuilding(world: World, b: BuildingRecord): boolean {
  // Phase 3 logistics: release in-flight resupply reservations against
  // the destroyed depot. This loop mirrors releaseDepotReservations
  // (commands.ts) inline on purpose: a static city→commands import
  // would close a city→commands→movement→pathfinding cycle that
  // evaluates pathfinding while city is still initializing (GRID_CELLS
  // NaN under the SSR transform — caught by sim.ai-soak). If the
  // release semantics ever change, update both.
  for (const u of world.units) {
    if ((u.resupplyDepotId ?? 0) === b.id) {
      u.resupplyDepotId = 0;
      u.resupplyReservedAmmo = 0;
      u.resupplyReservedFuel = 0;
    }
  }
  // Phase 5 hangars (S4): parked aircraft survive on the tarmac —
  // clear their hangar link (the slots die with the building).
  // Mirrored inline for the same city→commands import-cycle reason
  // as the loop above.
  for (const u of world.units) {
    if ((u.hangarBuildingId ?? 0) === b.id) u.hangarBuildingId = 0;
  }
  return demolishBuilding(world.city, b.id);
}

/**
 * World-space center of a building's footprint. Buildings live in cell
 * coords; units (and weapon ranges) live in world coords — range checks
 * against buildings go through here.
 */
export function buildingCenterWorld(b: BuildingRecord): { x: number; z: number } {
  const def = BUILDING_DEFS[b.kind];
  return {
    x: (b.cx + def.footprintW / 2) * CELL_WORLD_SIZE - MAP_HALF_SIZE,
    z: (b.cz + def.footprintH / 2) * CELL_WORLD_SIZE - MAP_HALF_SIZE,
  };
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
 * Grand-expansion Phase 8 (civilian ordinances, workstream E,
 * 2026-09-30): the education growth lever, doubled by the Education
 * Grants ordinance. Each completed (progress >= 1) kindergarten or
 * school owned by `owner` adds +0.05 (+0.10 with the grants funded)
 * residential growth desirability, additive and capped at +0.25
 * (+0.50 with grants). Unfinished or demolished buildings contribute
 * nothing. Pure and deterministic — used in `tryAutoDevelop`
 * (residential samples only).
 */
export function educationGrowthBonus(world: World, owner: number): number {
  let count = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== owner) continue;
    if (b.kind !== 'kindergarten' && b.kind !== 'school') continue;
    if ((b.progress ?? 0) < 1) continue;
    count += 1;
  }
  if (policyFunded(world, owner, 'educationGrants')) {
    return Math.min(0.5, 0.1 * count);
  }
  return Math.min(0.25, 0.05 * count);
}

// ---------------------------------------------------------------------------
// Phase 4 transport (S7): the civilian transport network check.
// ---------------------------------------------------------------------------

/**
 * Phase 4 tiered transit stops/stations (2026-09-30). The modes a
 * stop/station building can serve, via the def's `servedModes` list.
 * `subway` is a first-class mode in the data model NOW, but the subway
 * vehicle itself arrives in a later phase — centralStation and
 * airportInterchange already list it so their defs never change when
 * the vehicle lands. `boat` is the ferry mode; `air` is the airport
 * link (Phase 5 airport zones read `airportLink`, not this).
 */
export type TransitMode = 'bus' | 'taxi' | 'tram' | 'train' | 'subway' | 'boat' | 'air';

/** All transit modes, in UI-display order. */
export const TRANSIT_MODES: readonly TransitMode[] = [
  'bus', 'taxi', 'tram', 'train', 'subway', 'boat', 'air',
];

/**
 * Which transit mode each civilian transport UNIT drives. The ambient
 * hook (`transitStopsForMode`) is keyed by mode; the render side maps
 * a vehicle to its mode through this table instead of hard-coding it.
 */
export const TRANSIT_MODE_BY_UNIT_KIND: Record<string, TransitMode> = {
  bus: 'bus',
  tram: 'tram',
  passengerTrain: 'train',
  freightTrain: 'train',
  ferry: 'boat',
};

/**
 * Kind strings of the civilian transport units (mirrors the defs with
 * `transitEarnings` in units.ts — the transport test pins the two lists
 * equal). Kind strings, not UnitDef values, because city.ts must not
 * value-import units.ts (the documented import-cycle trap in
 * sim/AGENTS.md).
 */
export const TRANSIT_EARNER_KINDS: readonly string[] = [
  'bus', 'tram', 'passengerTrain', 'freightTrain', 'ferry',
];

/** Growth desirability per on-network transit unit, and the cap. */
export const TRANSIT_GROWTH_PER_UNIT = 0.03;
export const TRANSIT_GROWTH_CAP = 0.15;

/**
 * Grid cell index for a world position. Mirrors
 * pathfinding.worldToCell (including the clamp); city.ts owns its copy
 * so the network check stays cycle-free.
 */
function cellAtWorld(x: number, z: number): number {
  const cx = Math.floor((x + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
  const cz = Math.floor((z + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
  const qx = Math.min(Math.max(cx, 0), CITY_GRID_CELLS - 1);
  const qz = Math.min(Math.max(cz, 0), CITY_GRID_CELLS - 1);
  return cellIndex(qx, qz);
}

/**
 * Phase 4 (S7): is this civilian transport unit ON its network right
 * now? A pure function of current position — no stored flag, so it
 * can never go stale and needs no digest coverage:
 *  - bus/tram: standing on a road cell (any class).
 *  - passengerTrain/freightTrain: standing on a rail cell (any class).
 *  - ferry: has a set route (`setFerryRoute`) — its "network" is the
 *    shipping lane it shuttles.
 *
 * Gates BOTH civilian earnings (runTransportEarnings in economy.ts)
 * and the growth bonus (transitGrowthBonus below) — a bus parked in a
 * field earns nothing and attracts nobody.
 */
export function isOnTransportNetwork(
  city: CityState,
  kind: string,
  x: number,
  z: number,
  hasRoute: boolean,
): boolean {
  if (kind === 'bus' || kind === 'tram') {
    return roadSortedHas(city.roads, cellAtWorld(x, z));
  }
  if (kind === 'passengerTrain' || kind === 'freightTrain') {
    return railSortedHas(city.rails, cellAtWorld(x, z));
  }
  if (kind === 'ferry') return hasRoute;
  return false;
}

/**
 * Phase 4 (S7): the transit growth bonus feeding the zone-growth
 * demand loop (PLAN S7 — "their fares/fees feed the growth loop").
 * Each on-network civilian transport unit of `owner` adds
 * TRANSIT_GROWTH_PER_UNIT to ALL zones' growth desirability, capped
 * at TRANSIT_GROWTH_CAP (5 units saturate it). Wired into
 * tryAutoDevelop next to the education bonus. Counts living
 * (`hp > 0`) units only.
 */
export function transitGrowthBonus(world: World, owner: number): number {
  let count = 0;
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    if (!TRANSIT_EARNER_KINDS.includes(u.kind)) continue;
    if (isOnTransportNetwork(world.city, u.kind, u.x, u.z, u.route !== undefined)) count++;
  }
  return Math.min(TRANSIT_GROWTH_CAP, TRANSIT_GROWTH_PER_UNIT * count);
}

/**
 * Phase 4 (S7): nearest completed, operational railStation of `owner`
 * to the world position (x, z), or undefined. Footprint-center
 * distance; id-order tiebreak (buildings are id-ordered), so
 * deterministic. Used by the train branch of orderMoveTo to snap a
 * destination onto the rail network.
 */
export function nearestRailStation(
  city: CityState,
  x: number,
  z: number,
  owner: number,
): BuildingRecord | undefined {
  let best: BuildingRecord | undefined;
  let bestD2 = Infinity;
  for (const b of city.buildings) {
    if (b.kind !== 'railStation' || b.owner !== owner || b.progress < 1 || !b.operational) continue;
    const def = BUILDING_DEFS[b.kind];
    const bx = cellCenterWorld(b.cx + (def.footprintW - 1) / 2);
    const bz = cellCenterWorld(b.cz + (def.footprintH - 1) / 2);
    const d2 = (bx - x) * (bx - x) + (bz - z) * (bz - z);
    if (d2 < bestD2) {
      bestD2 = d2;
      best = b;
    }
  }
  return best;
}

/**
 * Phase 4 tiered transit stops/stations (2026-09-30): the ambient
 * hook for workstream P (`render/cityLife.ts`). Every completed,
 * operational stop/station of `owner` whose def `servedModes` includes
 * `mode`, in building-id order (buildings are id-ordered, so
 * deterministic). Pure query — no state, nothing to snapshot or
 * digest.
 *
 * The render side maps a vehicle to its mode through
 * `TRANSIT_MODE_BY_UNIT_KIND` (bus→bus, tram→tram, trains→train,
 * ferry→boat) and pauses the decorative vehicle at the returned
 * stops' footprint centers (anchor (cx, cz) + the def's footprint —
 * same center math as `nearestRailStation` above). Modes with no
 * vehicle yet (taxi, subway, air) still return their stops: the
 * ambient cars of a later phase will use them, and the data model
 * never changes when the vehicle lands.
 */
export function transitStopsForMode(
  world: World,
  owner: number,
  mode: TransitMode,
): BuildingRecord[] {
  const out: BuildingRecord[] = [];
  for (const b of world.city.buildings) {
    if (b.owner !== owner || b.progress < 1 || !b.operational) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def.servedModes !== undefined && def.servedModes.includes(mode)) out.push(b);
  }
  return out;
}

/**
 * Phase 4 occupancy (2026-09-30): how many people live/work in a
 * building vs its maximum capacity. Read-only — the economy tick owns
 * the numbers (`recomputeOccupancy` in economy.ts).
 *
 * RENDER/UI CONTRACT (selection panel): call this per selected
 * building; `residents`/`workers` are digest-covered, so refresh the
 * panel whenever the world digest changes. Caps come from the def
 * (`population` = residentCap, `jobs` = workerCap); actuals from the
 * record. Returns null for an unknown building id.
 */
export interface BuildingOccupancy {
  residents: number;
  residentCap: number;
  workers: number;
  workerCap: number;
}

export function buildingOccupancy(world: World, buildingId: number): BuildingOccupancy | null {
  const b = world.city.buildings.find((x) => x.id === buildingId);
  if (!b) return null;
  const def = BUILDING_DEFS[b.kind];
  return {
    residents: b.residents ?? 0,
    residentCap: def.population,
    workers: b.workers ?? 0,
    workerCap: def.jobs ?? 0,
  };
}

/**
 * Can `owner` afford AND build this def right now (funds, materials,
 * prerequisite building, research gate)? Shared by the auto-grow
 * pickers below — same rules as manual placement.
 *
 * Final-review R1 (C1, 2026-10-01): mirrors the placeBuilding command's
 * peaceful lockout. tryAutoDevelop calls placeBuilding() directly,
 * bypassing command validation — without this gate, industrial zones in
 * a peaceful game would auto-build barracks/warFactory/munitionsFactory/
 * militaryAcademy/missilePlant (all ZoneType.INDUSTRIAL, military: true):
 * dead weight the player never ordered, breaking peaceful mode's core
 * invariant. A peaceful game can NEVER auto-develop a military def.
 * Exported for the peaceful-lockout regression test (final-review R1 C1).
 */
export function canAutoDevelop(world: World, owner: number, def: BuildingDef): boolean {
  const city = world.city;
  const player = getPlayer(city, owner) as PlayerState;
  if (world.peaceful === true && def.military === true) return false;
  if (player.funds < def.costFunds || player.materials < def.costMaterials) return false;
  if (def.requiredBuilding && !hasProductionBuilding(world, owner, def.requiredBuilding)) return false;
  if (def.requiredUpgrade && !((world.upgrades[owner] ?? []) as string[]).includes(def.requiredUpgrade)) return false;
  return true;
}

/**
 * Phase 9 balance pass (peaceful death-spiral fix): the minimum treasury
 * a peaceful city keeps before NEW construction may spend it — via the
 * AI's placePeaceful or via organic growth (tryAutoDevelop).
 *
 * Why: upkeep funding shuts down the NEWEST buildings first on a
 * shortfall, so the OLDEST buildings — the power plant and water pump
 * the whole city depends on — are the first to go dark when the
 * treasury hits zero. No power → factories stop → no goods → shops
 * earn nothing → zero income → the treasury never recovers (permanent
 * stall, confirmed in the Phase 9 soak). The floor keeps `floorSeconds`
 * of the city's current upkeep in reserve, so a building spree can
 * never spend the city into that trap. Deliberately counts buildings
 * still under construction (they will charge upkeep soon).
 *
 * 30 seconds (not 90): the original 90s floor starved the city a
 * second way — it left no headroom to buy the oilWells that keep the
 * fuel (and hence the power) on. Thirty seconds rides out a temporary
 * income dip; the goods stockpile covers longer gaps.
 *
 * This gates only *new* construction: the human player's explicit
 * placeBuilding orders are unaffected (their choice, their risk).
 */
export const PEACEFUL_TREASURY_FLOOR_MIN = 200;
export const PEACEFUL_TREASURY_FLOOR_SECONDS = 30;

export function peacefulTreasuryFloor(world: World, owner: number): number {
  let upkeep = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== owner) continue;
    upkeep += BUILDING_DEFS[b.kind].upkeepFundsPerSec;
  }
  return Math.max(PEACEFUL_TREASURY_FLOOR_MIN, upkeep * PEACEFUL_TREASURY_FLOOR_SECONDS);
}

/** Cheapest def for a zone the player can afford AND has unlocked, or undefined. */
function affordableDefForZone(world: World, zone: ZoneType, owner: number): BuildingDef | undefined {
  for (const def of BUILDING_DEF_LIST) {
    if (def.zone !== zone) continue;
    if (!canAutoDevelop(world, owner, def)) continue;
    return def;
  }
  return undefined;
}

/**
 * Phase 4 building variety (2026-09-30): desirability-driven density.
 * Nicer cells grow dense (apartments, labs); modest cells grow modest
 * (houses, shops). The land-value tier of the sampled cell decides —
 * 'nice'/'prime' (desirability 51+) want density, 'low'/'modest' stay
 * modest. Falls back down the density ladder when the dense pick is
 * unaffordable (an apartment the treasury can't afford becomes a
 * house). Industrial zones keep the old first-affordable rule.
 * Deterministic: pure function of (world, cell) — no RNG consumed.
 */
export function densityDefForZone(
  world: World,
  zone: ZoneType,
  owner: number,
  cell: number,
  desirModel: Parameters<typeof cellDesirability>[0],
): BuildingDef | undefined {
  if (zone !== ZoneType.RESIDENTIAL && zone !== ZoneType.COMMERCIAL) {
    return affordableDefForZone(world, zone, owner);
  }
  const tier = landValueTier(cellDesirability(desirModel, cell));
  const dense = tier.name === 'nice' || tier.name === 'prime';
  const ladder: BuildingKind[] =
    zone === ZoneType.RESIDENTIAL
      ? dense ? ['apartment', 'house'] : ['house', 'apartment']
      : dense ? ['lab', 'shop'] : ['shop', 'lab'];
  for (const kind of ladder) {
    const def = BUILDING_DEFS[kind];
    if (canAutoDevelop(world, owner, def)) return def;
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
  // Phase 4 (S7): on-network civilian transports lift ALL zones'
  // growth demand — computed once per pulse like the education bonus.
  const transitBonus = transitGrowthBonus(world, owner);
  // Workstream W: the derived desirability model (rebuilt only on
  // structural change — never per tick). Residential samples get a
  // migration pull toward nicer cells, with a weak affordability pull
  // so nice-but-affordable cells grow fastest (see `migrationPull`).
  // Grand-expansion Phase 8 (civilian ordinances, workstream E): the
  // model is per-owner — the owner's funded ordinances (green /
  // transit / nightlife) shape their own desirability map.
  const desirModel = getDesirabilityModel(t, world, owner);
  // Sample a few zoned cells; each sample is one development attempt.
  const attempts = Math.min(8, city.zones.length);
  for (let a = 0; a < attempts; a++) {
    const zi = bank.intBelow('city', city.zones.length);
    const zrec = city.zones[zi] as { cell: number; zone: ZoneType };
    const { cx, cz } = cellCoords(zrec.cell);
    if (buildingAtCell(city, zrec.cell) || roadSortedHas(city.roads, zrec.cell)) continue;
    // Grand-expansion Phase 5 (S8, 2026-09-30): airport zones never
    // auto-develop — airports are player-placed infrastructure only.
    // (Without this, `affordableDefForZone` could match an airport def
    // to zone 3 and the growth pulse would plop runways on its own.)
    if (zrec.zone === ZoneType.AIRPORT) continue;
    // No road gate (user directive 2026-09-30): zoned houses develop with
    // or without roads; the desirability roll below is the only filter.
    let desirability = growthDesirability(player.taxRates[zrec.zone] as number, powerHeadroom, waterHeadroom);
    // Phase 4 (S7): transit bonus applies to every zone — houses near
    // a bus line, shops by the station, factories by the freight yard.
    desirability += transitBonus;
    // Workstream Z: education bonus applies to residential growth only.
    // Workstream W: migration — layer the desirability/land-value pulls
    // onto the existing demand loop (multiply, never replace).
    if (zrec.zone === ZoneType.RESIDENTIAL) {
      desirability += eduBonus;
      const d01 = cellDesirability(desirModel, zrec.cell) / 100;
      // Grand-expansion Phase 8 (civilian ordinances, workstream E):
      // the Transit Subsidy ordinance multiplies the migration pull.
      desirability = Math.min(1, desirability * migrationPullFor(world, owner, d01));
    }
    if (bank.next('city') >= desirability) continue;
    // Phase 4 building variety: desirability picks the density
    // (apartments/labs in nice areas, houses/shops in modest ones).
    const def = densityDefForZone(world, zrec.zone, owner, zrec.cell, desirModel);
    if (!def) return false; // broke: can't afford anything in this zone
    // Phase 9 balance pass (peaceful death-spiral fix): organic growth
    // never spends the treasury below the peaceful floor. Upkeep shuts
    // down the newest buildings first, so spending the last funds kills
    // the oldest — the power/water the city runs on — and the city can
    // never earn its way back. (The human's explicit orders are
    // unaffected: this gates only automatic growth.)
    if (world.peaceful === true) {
      const player = getPlayer(city, owner) as PlayerState;
      if (player.funds - def.costFunds < peacefulTreasuryFloor(world, owner)) continue;
    }
    // Anchor the footprint so it covers the sampled cell; scan origins
    // deterministically and take the first legal placement.
    for (let oz = cz - def.footprintH + 1; oz <= cz; oz++) {
      for (let ox = cx - def.footprintW + 1; ox <= cx; ox++) {
        const placement: Placement = { kind: def.kind, owner, cx: ox, cz: oz, facing: 0 };
        if (validatePlacement(t, city, placement) === null) {
          // Phase 4 building variety: variant/sizeTier hash from the
          // world seed + anchor cell (same seed + same cell = same look).
          placeBuilding(city, placement, world.seed);
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

/** Parse a road-class payload (buildRoad/upgradeRoad). Omitted → 'paved' (legacy default). */
function payloadRoadClass(payload: Record<string, unknown>): RoadClass | null {
  const v = payload['cls'];
  if (v === undefined) return 'paved';
  if (typeof v !== 'string') return null;
  return (ROAD_CLASS_ORDER as readonly string[]).includes(v) ? (v as RoadClass) : null;
}

/** Track-class order, cheapest → best (mirrors ROAD_CLASS_ORDER for rails). */
export const TRACK_CLASS_ORDER: readonly TrackClass[] = ['standard', 'electric', 'high-speed'];

/** Parse a track-class payload (buildRail). Omitted → 'standard'. */
function payloadTrackClass(payload: Record<string, unknown>): TrackClass | null {
  const v = payload['cls'];
  if (v === undefined) return 'standard';
  if (typeof v !== 'string') return null;
  return (TRACK_CLASS_ORDER as readonly string[]).includes(v) ? (v as TrackClass) : null;
}

/** Binary search for a road RECORD (used when mutating `cls` in place). */
export function findRoadRec(roads: RoadCell[], cell: number): RoadCell | undefined {
  let lo = 0;
  let hi = roads.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = roads[mid] as RoadCell;
    if (r.cell === cell) return r;
    if (r.cell < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** Binary search for a road record's INDEX (used by demolish). -1 when absent. */
export function findRoadIdx(roads: RoadCell[], cell: number): number {
  let lo = 0;
  let hi = roads.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = (roads[mid] as RoadCell).cell;
    if (v === cell) return mid;
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Binary search for a rail record's INDEX (used by demolish). -1 when absent. */
export function findRailIdx(rails: RailCell[], cell: number): number {
  let lo = 0;
  let hi = rails.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = (rails[mid] as RailCell).cell;
    if (v === cell) return mid;
    if (v < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Validate a rail drag (buildRail): cell array ≤512, in range, no
 * duplicates, on land (bridges are a later tool — PLAN §3.4), not on a
 * building, not already railed. Roads are allowed (level crossings).
 */
function validateRailCells(t: TerrainData, city: CityState, cells: number[]): string | null {
  if (cells.length === 0) return 'buildRail: cells must be a non-empty array';
  if (cells.length > 512) return 'buildRail: at most 512 cells per command';
  const seen = new Set<number>();
  for (const cell of cells) {
    if (cell < 0 || cell >= CITY_GRID_CELLS * CITY_GRID_CELLS) return `buildRail: cell ${cell} out of range`;
    if (seen.has(cell)) return `buildRail: duplicate cell ${cell}`;
    seen.add(cell);
    const { cx, cz } = cellCoords(cell);
    if (cellIsWater(t, cx, cz)) return `buildRail: cell ${cell} is water (bridges are not built yet)`;
    if (buildingAtCell(city, cell)) return `buildRail: cell ${cell} has a building`;
    if (railSortedHas(city.rails, cell)) return `buildRail: cell ${cell} already has rail`;
  }
  return null;
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
    if (roadSortedHas(city.roads, cell)) return `buildRoad: cell ${cell} already paved`;
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
    if (b.owner === owner && b.progress >= 1 && (b.kind === kind || countsAsProduction(b.kind, kind))) {
      return true;
    }
  }
  // AI virtual construction (see sim/ai.ts): completed virtual buildings
  // live on the AI player's state, not on the city grid.
  const ai = world.ai.players.find((p) => p.owner === owner);
  return ai !== undefined && ai.virtualBuildings.completed.includes(kind);
}

/**
 * Grand-expansion Phase 5/6 (S5): whether a building of `buildingKind`
 * satisfies a production gate for `gateKind` via its def's `countsAs`
 * (a mixed airport counts as an airfield; commercialPort counts as
 * shipyard, navalBase as navalYard — see the S5 field doc on
 * `BuildingDef.countsAs`).
 */
function countsAsProduction(buildingKind: BuildingKind, gateKind: BuildingKind): boolean {
  const def = BUILDING_DEFS[buildingKind];
  return def?.countsAs?.includes(gateKind) === true;
}

function makeSpecs(t: TerrainData): Record<string, CommandSpec> {
  /**
   * Phase 4 (S7): buildRoad takes a class payload (`cls`, one of
   * dirt | country | paved | highway — PLAN §3.4 order). Omitted cls
   * defaults to 'paved', the legacy flat road, so every pre-Phase-4
   * caller keeps its behavior and cost. Per-class cost from
   * ROAD_CLASS_STATS; the class also sets the cellMoveCost factor.
   */
  const buildRoad: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'buildRoad: unknown owner';
      const cells = payloadCells(cmd.payload);
      if (cells === null) return 'buildRoad: payload.cells must be an array of integers';
      const cls = payloadRoadClass(cmd.payload);
      if (cls === null) return `buildRoad: payload.cls must be one of ${ROAD_CLASS_ORDER.join(', ')}`;
      const reason = validateRoadCells(t, world.city, cells);
      if (reason) return reason;
      const player = getPlayer(world.city, owner) as PlayerState;
      const stats = ROAD_CLASS_STATS[cls];
      const costF = cells.length * stats.costFunds;
      const costM = cells.length * stats.costMaterials;
      if (player.funds < costF || player.materials < costM) {
        return `buildRoad: cannot afford (needs ${costF} funds + ${costM} materials)`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const cells = payloadCells(cmd.payload) as number[];
      const cls = payloadRoadClass(cmd.payload) as RoadClass;
      const stats = ROAD_CLASS_STATS[cls];
      const player = getPlayer(world.city, owner) as PlayerState;
      player.funds -= cells.length * stats.costFunds;
      player.materials -= cells.length * stats.costMaterials;
      for (const cell of cells) roadSortedInsert(world.city.roads, { cell, cls });
      bumpUtilityEpoch(world.city);
      return cells.length;
    },
  };

  /**
   * Phase 4 (S7): upgradeRoad changes a road cell's class IN PLACE
   * (the sorted-by-cell order never moves — only `cls` mutates) and
   * charges the per-cell cost DIFFERENCE between the new and old
   * class. Strictly upward only (ROAD_CLASS_ORDER): downgrades and
   * same-class "upgrades" reject loudly — demolition + rebuild is the
   * downgrade path, and it is deliberately pure loss (D11).
   */
  const upgradeRoad: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'upgradeRoad: unknown owner';
      const cells = payloadCells(cmd.payload);
      if (cells === null) return 'upgradeRoad: payload.cells must be an array of integers';
      if (cells.length === 0) return 'upgradeRoad: cells must be a non-empty array';
      if (cells.length > 512) return 'upgradeRoad: at most 512 cells per command';
      const cls = payloadRoadClass(cmd.payload);
      if (cls === null) return `upgradeRoad: payload.cls must be one of ${ROAD_CLASS_ORDER.join(', ')}`;
      const newIdx = ROAD_CLASS_ORDER.indexOf(cls);
      let costF = 0;
      let costM = 0;
      const seen = new Set<number>();
      for (const cell of cells) {
        if (cell < 0 || cell >= CITY_GRID_CELLS * CITY_GRID_CELLS) return `upgradeRoad: cell ${cell} out of range`;
        if (seen.has(cell)) return `upgradeRoad: duplicate cell ${cell}`;
        seen.add(cell);
        const old = roadClassAt(world.city.roads, cell);
        if (old === undefined) return `upgradeRoad: cell ${cell} has no road`;
        const oldIdx = ROAD_CLASS_ORDER.indexOf(old);
        if (newIdx <= oldIdx) {
          return `upgradeRoad: cell ${cell} is already ${old} (cannot upgrade to ${cls})`;
        }
        const oldStats = ROAD_CLASS_STATS[old];
        const newStats = ROAD_CLASS_STATS[cls];
        costF += newStats.costFunds - oldStats.costFunds;
        costM += newStats.costMaterials - oldStats.costMaterials;
      }
      const player = getPlayer(world.city, owner) as PlayerState;
      if (player.funds < costF || player.materials < costM) {
        return `upgradeRoad: cannot afford (needs ${costF} funds + ${costM} materials)`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const cells = payloadCells(cmd.payload) as number[];
      const cls = payloadRoadClass(cmd.payload) as RoadClass;
      const player = getPlayer(world.city, owner) as PlayerState;
      for (const cell of cells) {
        const rec = findRoadRec(world.city.roads, cell) as RoadCell;
        const oldStats = ROAD_CLASS_STATS[rec.cls];
        const newStats = ROAD_CLASS_STATS[cls];
        player.funds -= newStats.costFunds - oldStats.costFunds;
        player.materials -= newStats.costMaterials - oldStats.costMaterials;
        rec.cls = cls; // in place — the cell (sort key) never changes
      }
      bumpUtilityEpoch(world.city);
      return cells.length;
    },
  };

  /**
   * Phase 4 (S7): buildRail mirrors buildRoad — a drag-painted cell
   * array (≤512) with a track-class payload (`cls`, one of
   * standard | electric | high-speed; omitted defaults to 'standard').
   * Per-class cost from TRACK_CLASS_STATS. Rails may cross roads
   * (level crossings) but not water (bridges are a later tool, PLAN
   * §3.4) and not buildings or existing rails. Rails are NOT utility
   * conductors, so no epoch bump.
   */
  const buildRail: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'buildRail: unknown owner';
      const cells = payloadCells(cmd.payload);
      if (cells === null) return 'buildRail: payload.cells must be an array of integers';
      const cls = payloadTrackClass(cmd.payload);
      if (cls === null) return `buildRail: payload.cls must be one of ${TRACK_CLASS_ORDER.join(', ')}`;
      const reason = validateRailCells(t, world.city, cells);
      if (reason) return reason;
      const player = getPlayer(world.city, owner) as PlayerState;
      const stats = TRACK_CLASS_STATS[cls];
      const costF = cells.length * stats.costFunds;
      const costM = cells.length * stats.costMaterials;
      if (player.funds < costF || player.materials < costM) {
        return `buildRail: cannot afford (needs ${costF} funds + ${costM} materials)`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const cells = payloadCells(cmd.payload) as number[];
      const cls = payloadTrackClass(cmd.payload) as TrackClass;
      const stats = TRACK_CLASS_STATS[cls];
      const player = getPlayer(world.city, owner) as PlayerState;
      player.funds -= cells.length * stats.costFunds;
      player.materials -= cells.length * stats.costMaterials;
      for (const cell of cells) railSortedInsert(world.city.rails, { cell, cls });
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
      // Grand-expansion Phase 5 (S8, 2026-09-30): zone 3 is the airport
      // zone — painted like the others, owns the airport roster.
      if (zone === null || (zone !== 0 && zone !== 1 && zone !== 2 && zone !== 3)) {
        return 'paintZone: zone must be 0 (residential), 1 (commercial), 2 (industrial) or 3 (airport)';
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
      // minAge: 'ascendance' defs. (Reads world.ages inline below instead of
      // importing ages.ts — that module imports getPlayer from here, so an
      // import would be a cycle. Per-side ages: the issuing owner's own
      // age state, missing = Foundation.)
      const bdef = BUILDING_DEFS[kind];
      // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): military
      // defs cannot be placed in a peaceful world — loud rejection
      // (CommandRejectedError → HUD toast), never silent. The flag is
      // immutable (set at tick 0, never toggled), so no apply-time
      // re-check is needed — enqueue-time is definitive.
      if (world.peaceful === true && bdef.military === true) {
        return `placeBuilding: ${bdef.name} is a military building and cannot be placed in peaceful mode`;
      }
      // Per-side ages (2026-10-01, roadmap A1): the issuing owner's own
      // age state. city.ts must NOT import ages.ts (ages.ts imports
      // getPlayer from this module — an import would cycle), so read
      // the state inline: missing entry = Foundation.
      if (!isBuildingAgeMet((world.ages[owner as number]?.age ?? 'foundation'), bdef.minAge)) {
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
      // Phase 4 building variety: same seed contract as auto-grow.
      return placeBuilding(world.city, { kind, owner, cx, cz, facing }, world.seed).id;
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
        !roadSortedHas(world.city.roads, cell) &&
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
        // Final-review R2: the full destroy path (resupply-release +
        // hangar-link cleanup) lives in destroyBuilding now — the
        // demolish command and combat destruction share it.
        return { removed: 'building', id: destroyBuilding(world, b) ? b.id : -1 };
      }
      // demolishBuilding bumps the epoch for buildings; cell removal
      // below bumps it for conductors (Phase 2 structural changes).
      // Rails are not conductors (Phase 4, S7) — no epoch bump.
      const i = findRoadIdx(world.city.roads, cell);
      if (i !== -1) {
        world.city.roads.splice(i, 1);
        bumpUtilityEpoch(world.city);
        return { removed: 'road', cell };
      }
      const ri = findRailIdx(world.city.rails, cell);
      if (ri !== -1) {
        world.city.rails.splice(ri, 1);
        return { removed: 'rail', cell };
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
      // Grand-expansion Phase 5 (S5, 2026-09-30): zone 3 is the airport
      // zone — it has its own tax rate (the 4th taxRates element).
      if (zone === null || (zone !== 0 && zone !== 1 && zone !== 2 && zone !== 3)) {
        return 'setTaxRate: zone must be 0, 1, 2 or 3';
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

  /**
   * Grand-expansion Phase 8 (civilian ordinances, workstream E,
   * 2026-09-30): toggle a city-wide policy. The AI workstream's clean
   * seam: `setPolicy` is a plain CommandSpec (registered with the rest
   * of the city commands), so the AI issues it exactly like it issues
   * `setSpecialization` — `{ kind: 'setPolicy', payload: { owner,
   * policy, on: 1 | 0 } }`. Validate is loud: unknown owner, unknown
   * policy id, or a non-0/1 `on` all reject with a plain-English
   * reason. Turning ON additionally requires a 60-second upkeep
   * runway in the treasury (POLICY_ENABLE_RUNWAY_SECS) — a broke
   * player is rejected loudly instead of silently arming a policy
   * that can never fund. Turning OFF is always free. Peaceful games:
   * ordinances are civilian city management — never locked out.
   */
  const setPolicy: CommandSpec = {
    validate(cmd, world): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null || !getPlayer(world.city, owner)) return 'setPolicy: unknown owner';
      const policy = payloadStr(cmd.payload, 'policy');
      if (typeof policy !== 'string' || !(policy in POLICIES)) {
        return `setPolicy: unknown policy '${policy}' (must be one of ${POLICY_IDS.join(', ')})`;
      }
      const on = payloadInt(cmd.payload, 'on');
      if (on !== 0 && on !== 1) return 'setPolicy: on must be 0 (off) or 1 (on)';
      if (on === 1) {
        const player = getPlayer(world.city, owner) as PlayerState;
        const need = POLICIES[policy as PolicyId].upkeepFundsPerSec * POLICY_ENABLE_RUNWAY_SECS;
        if (player.funds < need) {
          return `setPolicy: cannot afford to enable ${policy} (needs ${need} funds runway, treasury holds ${player.funds})`;
        }
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = payloadInt(cmd.payload, 'owner') as number;
      const policy = payloadStr(cmd.payload, 'policy') as PolicyId;
      const on = payloadInt(cmd.payload, 'on') as number;
      const player = getPlayer(world.city, owner) as PlayerState;
      if (on === 1) player.policies[policy] = true;
      else delete player.policies[policy];
      return on;
    },
  };

  return { buildRoad, upgradeRoad, buildRail, buildPowerLine, buildPipe, paintZone, placeBuilding: placeBuildingSpec, demolish, setTaxRate, setSpecialization, setPolicy };
}

/** Register the city-building command kinds on a queue. Needs the terrain for placement rules. */

/** Register the city-building command kinds on a queue. Needs the terrain for placement rules. */
export function registerCityCommands(queue: CommandQueue, t: TerrainData): void {
  const specs = makeSpecs(t);
  for (const kind of Object.keys(specs)) {
    queue.register(kind, specs[kind] as CommandSpec);
  }
}
