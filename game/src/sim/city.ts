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
 *  - Placement rules (land only, road adjacency, zone matching, no
 *    overlaps, affordability) are enforced by command validation — at
 *    enqueue AND at apply time.
 *  - Power/water is a Phase-1 capacity-pool model: plants/pumps that sit on
 *    the road network contribute supply; buildings draw demand in id order
 *    until supply runs out. Unpowered/unwatered buildings still run, at a
 *    steep 25% output factor each (documented below). A true
 *    connected-component flow simulation is deferred (see D11).
 *  - Growth: zoned, road-adjacent cells auto-develop when the economy
 *    allows, with a desirability check the player steers via tax rates and
 *    utility headroom.
 *
 * Key invariants:
 *  - `roads` is always sorted ascending; `zones` is always sorted by cell.
 *    Both are maintained by the mutators — never hand-edit.
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

/** 'utility' buildings (power/water) skip the zone-matching rule. */
export const UTILITY_ZONE = 'utility' as const;

/** Phase-1 building kinds. */
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
}

export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  house: {
    kind: 'house', name: 'House', zone: ZoneType.RESIDENTIAL,
    footprintW: 2, footprintH: 2, costFunds: 120, costMaterials: 40,
    buildSeconds: 10, upkeepFundsPerSec: 0.15,
    powerDemand: 1, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: {}, input: {}, population: 6, taxBasePerSec: 1.0,
  },
  apartment: {
    kind: 'apartment', name: 'Apartment Block', zone: ZoneType.RESIDENTIAL,
    footprintW: 3, footprintH: 3, costFunds: 450, costMaterials: 160,
    buildSeconds: 30, upkeepFundsPerSec: 0.7,
    powerDemand: 3, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: {}, input: {}, population: 30, taxBasePerSec: 5.0,
  },
  shop: {
    kind: 'shop', name: 'Shop', zone: ZoneType.COMMERCIAL,
    footprintW: 2, footprintH: 2, costFunds: 220, costMaterials: 70,
    buildSeconds: 15, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { funds: 1.8 }, input: { goods: 0.5 }, population: 0, taxBasePerSec: 6.0,
  },
  lab: {
    kind: 'lab', name: 'Research Lab', zone: ZoneType.COMMERCIAL,
    footprintW: 2, footprintH: 2, costFunds: 650, costMaterials: 220,
    buildSeconds: 45, upkeepFundsPerSec: 1.2,
    powerDemand: 3, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: { research: 0.4 }, input: {}, population: 0, taxBasePerSec: 6.0,
  },
  factory: {
    kind: 'factory', name: 'Factory', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 550, costMaterials: 220,
    buildSeconds: 40, upkeepFundsPerSec: 1.6,
    powerDemand: 5, powerSupply: 0, waterDemand: 3, waterSupply: 0,
    output: { materials: 2.5, goods: 1.5 }, input: { fuel: 0.4 }, population: 0, taxBasePerSec: 8.0,
  },
  farm: {
    kind: 'farm', name: 'Farm', zone: ZoneType.INDUSTRIAL,
    footprintW: 3, footprintH: 3, costFunds: 300, costMaterials: 80,
    buildSeconds: 15, upkeepFundsPerSec: 0.6,
    powerDemand: 1, powerSupply: 0, waterDemand: 4, waterSupply: 0,
    output: { food: 3.0 }, input: {}, population: 0, taxBasePerSec: 2.5,
  },
  powerPlant: {
    kind: 'powerPlant', name: 'Power Plant', zone: UTILITY_ZONE,
    footprintW: 3, footprintH: 3, costFunds: 900, costMaterials: 350,
    buildSeconds: 60, upkeepFundsPerSec: 0.8,
    powerDemand: 0, powerSupply: 25, waterDemand: 2, waterSupply: 0,
    output: {}, input: { fuel: 1.0 }, population: 0, taxBasePerSec: 3.0,
  },
  waterPump: {
    kind: 'waterPump', name: 'Water Pump', zone: UTILITY_ZONE,
    footprintW: 2, footprintH: 2, costFunds: 350, costMaterials: 120,
    buildSeconds: 20, upkeepFundsPerSec: 0.4,
    powerDemand: 2, powerSupply: 0, waterDemand: 0, waterSupply: 25,
    output: {}, input: {}, population: 0, taxBasePerSec: 1.5,
  },
  mediaCenter: {
    kind: 'mediaCenter', name: 'Media Center', zone: ZoneType.COMMERCIAL,
    footprintW: 2, footprintH: 2, costFunds: 800, costMaterials: 300,
    buildSeconds: 45, upkeepFundsPerSec: 1.0,
    powerDemand: 4, powerSupply: 0, waterDemand: 1, waterSupply: 0,
    output: { influence: 0.8 }, input: {}, population: 0, taxBasePerSec: 7.0,
  },
  shipyard: {
    kind: 'shipyard', name: 'Shipyard', zone: UTILITY_ZONE,
    footprintW: 4, footprintH: 3, costFunds: 1200, costMaterials: 500,
    buildSeconds: 60, upkeepFundsPerSec: 1.5,
    powerDemand: 4, powerSupply: 0, waterDemand: 2, waterSupply: 0,
    output: {}, input: {}, population: 0, taxBasePerSec: 4.0,
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

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
}

/** The whole city. Lives on `World.city`; snapshotted and digested. */
export interface CityState {
  /** Paved cells, sorted ascending. */
  roads: number[];
  /** Painted cells, sorted by cell. */
  zones: Array<{ cell: number; zone: ZoneType }>;
  /** Placed buildings, placement (id) order. */
  buildings: BuildingRecord[];
  nextBuildingId: number;
  players: PlayerState[];
  /** Set by the economy tick when food demand outruns supply. */
  foodShortage: boolean;
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
  };
}

/** Fresh city: no roads, no zones, two players (0 = human, 1 = AI rival). */
export function initCity(): CityState {
  return {
    roads: [],
    zones: [],
    buildings: [],
    nextBuildingId: 1,
    players: [createPlayer(0, 'Player'), createPlayer(1, 'Rival')],
    foodShortage: false,
  };
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

/** True when any footprint cell is orthogonally adjacent to a road cell. */
export function isRoadAdjacent(city: CityState, cx: number, cz: number, w: number, h: number): boolean {
  for (let dz = 0; dz < h; dz++) {
    for (let dx = 0; dx < w; dx++) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (
        (inBounds(nx + 1, nz) && sortedHas(city.roads, cellIndex(nx + 1, nz))) ||
        (inBounds(nx - 1, nz) && sortedHas(city.roads, cellIndex(nx - 1, nz))) ||
        (inBounds(nx, nz + 1) && sortedHas(city.roads, cellIndex(nx, nz + 1))) ||
        (inBounds(nx, nz - 1) && sortedHas(city.roads, cellIndex(nx, nz - 1)))
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
  if (!isRoadAdjacent(city, p.cx, p.cz, def.footprintW, def.footprintH)) {
    return `${def.name}: must be adjacent to a road`;
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
    powered: false,
    watered: false,
  };
  city.nextBuildingId += 1;
  city.buildings.push(record);
  return record;
}

/** Remove a building by id. Frees its cells. No refund (D11). */
export function demolishBuilding(city: CityState, id: number): boolean {
  const index = city.buildings.findIndex((b) => b.id === id);
  if (index === -1) return false;
  city.buildings.splice(index, 1);
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

/** Cheapest def for a zone the player can afford, or undefined. */
function affordableDefForZone(city: CityState, zone: ZoneType, owner: number): BuildingDef | undefined {
  const player = getPlayer(city, owner) as PlayerState;
  for (const def of BUILDING_DEF_LIST) {
    if (def.zone === zone && player.funds >= def.costFunds && player.materials >= def.costMaterials) {
      return def;
    }
  }
  return undefined;
}

/**
 * Try to auto-develop one building near a zoned cell for a player.
 * Deterministic: RNG from the 'city' stream, fixed scan order.
 */
function tryAutoDevelop(t: TerrainData, world: World, owner: number, powerHeadroom: number, waterHeadroom: number): boolean {
  const city = world.city;
  const player = getPlayer(city, owner);
  if (!player || city.zones.length === 0) return false;
  const bank = rngBank(world);
  // Sample a few zoned cells; each sample is one development attempt.
  const attempts = Math.min(8, city.zones.length);
  for (let a = 0; a < attempts; a++) {
    const zi = bank.intBelow('city', city.zones.length);
    const zrec = city.zones[zi] as { cell: number; zone: ZoneType };
    const { cx, cz } = cellCoords(zrec.cell);
    if (buildingAtCell(city, zrec.cell) || sortedHas(city.roads, zrec.cell)) continue;
    if (!isRoadAdjacent(city, cx, cz, 1, 1)) continue;
    const desirability = growthDesirability(player.taxRates[zrec.zone] as number, powerHeadroom, waterHeadroom);
    if (bank.next('city') >= desirability) continue;
    const def = affordableDefForZone(city, zrec.zone, owner);
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
      return cells.length;
    },
  };

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
      if (!buildingAtCell(world.city, cell) && !sortedHas(world.city.roads, cell)) {
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
      if (b) return { removed: 'building', id: demolishBuilding(world.city, b.id) ? b.id : -1 };
      const i = world.city.roads.indexOf(cell);
      if (i !== -1) world.city.roads.splice(i, 1);
      return { removed: 'road', cell };
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

  return { buildRoad, paintZone, placeBuilding: placeBuildingSpec, demolish, setTaxRate };
}

/** Register the city-building command kinds on a queue. Needs the terrain for placement rules. */
export function registerCityCommands(queue: CommandQueue, t: TerrainData): void {
  const specs = makeSpecs(t);
  for (const kind of Object.keys(specs)) {
    queue.register(kind, specs[kind] as CommandSpec);
  }
}
