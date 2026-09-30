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
 * NOVATERRA — sim/desirability.ts — residential desirability, land value,
 * and migration pulls (workstream W, grand expansion, 0.1 Alpha).
 *
 * Responsibilities:
 *  - Compute a 0–100 desirability score for every residential-zone cell,
 *    from five drivers (see "Drivers" below).
 *  - Map desirability to land-value tiers, which multiply residential tax
 *    income (economy.ts `runTaxes`).
 *  - Provide the migration pull used by the organic-growth loop (city.ts
 *    `tryAutoDevelop`): a strong pull toward nicer cells and a weaker
 *    pull toward cheaper land, so nice-but-affordable cells grow fastest.
 *
 * Drivers (all distances in Chebyshev cells — max(|dx|, |dz|), ~1 cell =
 * 2 world units):
 *  - Base 40: a featureless cell is "modest" (tax ×1.0) — the multiplier
 *    is neutral unless a driver moves it.
 *  - Elevation: +0..10, linear in height above the water level, full at
 *    +20 world units (`heightAt`).
 *  - Pollution: −0..25 around completed buildings whose def carries the
 *    `fouling` flag (the Phase 2 water-fouling flag: coal/gas/oil plants),
 *    linear decay to zero at 15 cells.
 *  - Water proximity: +0..15 near ANY water cell — shoreline, lakes and
 *    rivers all count because all are water cells (user directive
 *    2026-09-30). Full bonus within 6 cells, linear decay to zero at
 *    20 cells.
 *  - Amenities: +5 per amenity TYPE within 12 cells (park, library,
 *    school, kindergarten, college, university), +3/+4 for the two
 *    parking types within 8/10 cells (workstream P — convenience scores
 *    below the cultural types), capped at +20 total.
 *    Defs carrying `waterfrontAmenity` (the Phase 4 marina hook — Phase 4
 *    just sets the flag, no desirability code changes then) count as a
 *    waterfront amenity: +10 within 15 cells, toward the same +20 cap.
 *
 * Key invariants:
 *  - DERIVED DATA ONLY — never snapshotted. `getDesirabilityModel` caches
 *    per (city, epoch key) and rebuilds ONLY on structural change
 *    (building placed/demolished/completed, zone painted — the epoch plus
 *    the completed-building id list; see `desirabilityKey`). It is never
 *    rebuilt per tick: callers hold the returned model.
 *  - Deterministic: integer scores (Math.round), sorted inputs, no RNG,
 *    no wall clock. Same city + same terrain ⇒ byte-identical model.
 *  - Distances are Chebyshev on the city grid; the model builder runs one
 *    bounded multi-source BFS for water (O(bounding box)) plus small
 *    window rasters for the (usually few) pollution/amenity sources —
 *    structural-change-only cost, never per-tick.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { TerrainData } from './terrain';
import { heightAt } from './terrain';
import type { World } from './world';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  ZoneType,
  cellCenterWorld,
  cellCoords,
  cellIndex,
  cellIsWater,
  footprintCells,
  inBounds,
  type BuildingKind,
  type BuildingRecord,
  type CityState,
} from './city';

// ---------------------------------------------------------------------------
// Tuning constants (the final numbers — also reported in GAME_MECHANICS.md)
// ---------------------------------------------------------------------------

/** Neutral score: a featureless cell lands in the "modest" tier (tax ×1.0). */
export const BASE_DESIRABILITY = 40;
/** Desirability range. */
export const DESIRABILITY_MIN = 0;
export const DESIRABILITY_MAX = 100;

/** Elevation: full bonus at this height above the water level (world units). */
export const ELEVATION_FULL_HEIGHT = 20;
/** Elevation: maximum bonus points. */
export const ELEVATION_BONUS_MAX = 10;

/** Pollution: penalty decays to zero at this Chebyshev distance (cells). */
export const POLLUTION_RADIUS_CELLS = 15;
/** Pollution: maximum penalty (at the source's own cell). */
export const POLLUTION_PENALTY_MAX = 25;

/** Water proximity: full bonus within this many cells of any water cell. */
export const WATER_FULL_RADIUS_CELLS = 6;
/** Water proximity: bonus decays to zero at this many cells. */
export const WATER_DECAY_RADIUS_CELLS = 20;
/** Water proximity: maximum bonus points. */
export const WATER_BONUS_MAX = 15;

/** Amenities: radius (cells) for the per-type +5 amenity bonus. */
export const AMENITY_RADIUS_CELLS = 12;
/** Amenities: bonus per amenity TYPE present within radius. */
export const AMENITY_BONUS_PER_TYPE = 5;
/** Amenities: total amenity bonus cap (waterfront included). */
export const AMENITY_BONUS_CAP = 20;
/** Waterfront (marina hook): radius (cells) for the +10 bonus. */
export const WATERFRONT_RADIUS_CELLS = 15;
/** Waterfront (marina hook): bonus points. */
export const WATERFRONT_BONUS = 10;
/**
 * Phase 4 tiered transit stops/stations (2026-09-30). Small stops are
 * convenience amenities at the parking-lot tier (+3 within 8 cells);
 * the neighborhood station is a neighborhood asset at the cultural
 * tier (+5 within 12); the central station is the downtown strategic
 * decision (+8 within 18 — the biggest non-waterfront row); the
 * airport interchange is the premier gateway (+10 within 20). All
 * toward the same AMENITY_BONUS_CAP.
 */
export const TRANSIT_STOP_RADIUS_CELLS = 8;
export const TRANSIT_STOP_BONUS = 3;
export const NEIGHBORHOOD_STATION_RADIUS_CELLS = 12;
export const NEIGHBORHOOD_STATION_BONUS = 5;
export const CENTRAL_STATION_RADIUS_CELLS = 18;
export const CENTRAL_STATION_BONUS = 8;
export const AIRPORT_INTERCHANGE_RADIUS_CELLS = 20;
export const AIRPORT_INTERCHANGE_BONUS = 10;

// ---------------------------------------------------------------------------
// Amenity table
// ---------------------------------------------------------------------------

/**
 * One amenity type. A residential cell gains `bonus` desirability when a
 * completed source building is within `radius` cells (Chebyshev).
 *
 * EXTENSIBILITY (proven by workstream P, 2026-09-30): parking
 * lots/garages plugged in here as two rows — no other desirability
 * code changes were needed. Future amenity kinds (the Phase 4 marina
 * uses the `waterfront` row) add one row to AMENITY_TABLE. The table
 * is data; the scan below is generic over it.
 */
export interface AmenityDef {
  /** Building kind that counts as this amenity (completed buildings only). */
  kind?: BuildingKind;
  /**
   * When true, ANY def with `waterfrontAmenity: true` counts (the Phase 4
   * marina hook — PLAN.md §9 Phase 4: setting the flag on the marina def
   * is the entire integration).
   */
  waterfront?: boolean;
  /** Radius in Chebyshev cells. */
  radius: number;
  /** Desirability bonus points. */
  bonus: number;
}

/**
 * The amenity table. Six civic/education types at +5/12 cells, two civic
 * parking types (workstream P: lot +3/8, garage +4/10 — convenience
 * amenities score below the cultural/education types), the waterfront
 * hook at +10/15 cells, and the seven Phase 4 tiered transit stops/
 * stations (four small stops +3/8, neighborhood station +5/12, central
 * station +8/18, airport interchange +10/20). Total amenity
 * contribution is capped at AMENITY_BONUS_CAP (see `amenityBonusFor`).
 */
export const AMENITY_TABLE: readonly AmenityDef[] = [
  { kind: 'park', radius: AMENITY_RADIUS_CELLS, bonus: AMENITY_BONUS_PER_TYPE },
  { kind: 'library', radius: AMENITY_RADIUS_CELLS, bonus: AMENITY_BONUS_PER_TYPE },
  { kind: 'school', radius: AMENITY_RADIUS_CELLS, bonus: AMENITY_BONUS_PER_TYPE },
  { kind: 'kindergarten', radius: AMENITY_RADIUS_CELLS, bonus: AMENITY_BONUS_PER_TYPE },
  { kind: 'college', radius: AMENITY_RADIUS_CELLS, bonus: AMENITY_BONUS_PER_TYPE },
  { kind: 'university', radius: AMENITY_RADIUS_CELLS, bonus: AMENITY_BONUS_PER_TYPE },
  // Workstream P (ambient city life, 2026-09-30): civic parking is its
  // own two amenity TYPES (they stack with each other and with the
  // cultural types toward the same +20 cap). The lot is the small
  // convenience amenity (+3 within 8 cells); the multi-deck garage
  // serves more cars, so it reaches a little farther and scores a
  // little higher (+4 within 10 cells). Both sit deliberately below the
  // +5 cultural/education types — parking is convenient, not beloved.
  { kind: 'parkingLot', radius: 8, bonus: 3 },
  { kind: 'parkingGarage', radius: 10, bonus: 4 },
  // Phase 4 marina hook: any def with waterfrontAmenity: true. Worth +10
  // within 15 cells — toward the same +20 amenity cap, not on top of it.
  { waterfront: true, radius: WATERFRONT_RADIUS_CELLS, bonus: WATERFRONT_BONUS },
  // Phase 4 tiered transit stops/stations (2026-09-30): one row per
  // stop/station kind (each is its own amenity TYPE, so a bus stop and
  // a tram stop stack like parkingLot+parkingGarage do, toward the
  // same +20 cap). Small stops score as convenience amenities
  // (+3/8 — the parking-lot tier); the neighborhood station as a
  // cultural-tier asset (+5/12); the central station is the downtown
  // strategic decision (+8/18); the airport interchange is the premier
  // gateway (+10/20). Adding a future stop kind = one row here.
  { kind: 'busStop', radius: TRANSIT_STOP_RADIUS_CELLS, bonus: TRANSIT_STOP_BONUS },
  { kind: 'taxiStand', radius: TRANSIT_STOP_RADIUS_CELLS, bonus: TRANSIT_STOP_BONUS },
  { kind: 'tramStop', radius: TRANSIT_STOP_RADIUS_CELLS, bonus: TRANSIT_STOP_BONUS },
  { kind: 'ferryPier', radius: TRANSIT_STOP_RADIUS_CELLS, bonus: TRANSIT_STOP_BONUS },
  { kind: 'neighborhoodStation', radius: NEIGHBORHOOD_STATION_RADIUS_CELLS, bonus: NEIGHBORHOOD_STATION_BONUS },
  { kind: 'centralStation', radius: CENTRAL_STATION_RADIUS_CELLS, bonus: CENTRAL_STATION_BONUS },
  { kind: 'airportInterchange', radius: AIRPORT_INTERCHANGE_RADIUS_CELLS, bonus: AIRPORT_INTERCHANGE_BONUS },
];

// ---------------------------------------------------------------------------
// Land-value tiers
// ---------------------------------------------------------------------------

/** Land-value tier: desirability band + residential tax multiplier. */
export interface LandValueTier {
  /** Tier name (English; localized via ui/desirability.ts). */
  name: 'low' | 'modest' | 'nice' | 'prime';
  /** Inclusive desirability bounds. */
  min: number;
  max: number;
  /** Multiplies the residential building's tax take. */
  taxMultiplier: number;
}

/** The four tiers, in ascending order. */
export const LAND_VALUE_TIERS: readonly LandValueTier[] = [
  { name: 'low', min: 0, max: 25, taxMultiplier: 0.8 },
  { name: 'modest', min: 26, max: 50, taxMultiplier: 1.0 },
  { name: 'nice', min: 51, max: 75, taxMultiplier: 1.3 },
  { name: 'prime', min: 76, max: 100, taxMultiplier: 1.7 },
];

/** Tier for a 0–100 desirability score. */
export function landValueTier(desirability: number): LandValueTier {
  const d = Math.max(DESIRABILITY_MIN, Math.min(DESIRABILITY_MAX, desirability));
  for (const tier of LAND_VALUE_TIERS) {
    if (d >= tier.min && d <= tier.max) return tier;
  }
  return LAND_VALUE_TIERS[1] as LandValueTier; // unreachable; keeps tsc honest
}

/** Residential tax multiplier for a desirability score. */
export function landValueTaxMultiplier(desirability: number): number {
  return landValueTier(desirability).taxMultiplier;
}

// ---------------------------------------------------------------------------
// Migration pull
// ---------------------------------------------------------------------------

/**
 * Migration pull for the organic-growth loop (city.ts `tryAutoDevelop`,
 * residential samples only): multiplies the base development probability.
 *
 * Two pulls, per the brief:
 *  - strong pull toward higher desirability: +1.45 × d01;
 *  - weak pull toward affordability: land in the "prime" tier is pricey,
 *    so the pull fades −0.55 across the prime band (d01 0.72 → 1.0).
 * The peak sits at the top of the "nice" tier (d01 = 0.72 → ×1.594):
 * nice-but-affordable cells grow fastest. Clamped to [0.1, 2] so it can
 * never zero out growth or more than double it. Pure and deterministic.
 */
export function migrationPull(d01: number): number {
  // Non-finite input is a caller bug — map it to d=0 (never NaN-poison
  // the growth roll: NaN >= roll is false, which would develop always).
  const d = Number.isFinite(d01) ? Math.max(0, Math.min(1, d01)) : 0;
  let pull = 0.55 + 1.45 * d;
  if (d > 0.72) pull -= 0.55 * ((d - 0.72) / 0.28);
  return Math.max(0.1, Math.min(2, pull));
}

// ---------------------------------------------------------------------------
// Pure driver helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Clamp a number to [0, 1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Chebyshev distance between two cells (in cells). */
export function chebyshevCells(a: number, b: number): number {
  const ca = cellCoords(a);
  const cb = cellCoords(b);
  return Math.max(Math.abs(ca.cx - cb.cx), Math.abs(ca.cz - cb.cz));
}

/**
 * Elevation driver: +0..ELEVATION_BONUS_MAX, linear in height above the
 * water level, full at ELEVATION_FULL_HEIGHT world units above it.
 */
export function elevationBonus(t: TerrainData, cell: number): number {
  const { cx, cz } = cellCoords(cell);
  const h = heightAt(t, cellCenterWorld(cx), cellCenterWorld(cz));
  return ELEVATION_BONUS_MAX * clamp01((h - t.waterLevel) / ELEVATION_FULL_HEIGHT);
}

/**
 * Water-proximity driver: +0..WATER_BONUS_MAX for the Chebyshev distance
 * `d` (cells) to the nearest water cell. Full within WATER_FULL_RADIUS_CELLS,
 * linear decay to zero at WATER_DECAY_RADIUS_CELLS.
 */
export function waterBonusForDistance(d: number): number {
  if (d <= WATER_FULL_RADIUS_CELLS) return WATER_BONUS_MAX;
  if (d >= WATER_DECAY_RADIUS_CELLS) return 0;
  return (
    WATER_BONUS_MAX * ((WATER_DECAY_RADIUS_CELLS - d) / (WATER_DECAY_RADIUS_CELLS - WATER_FULL_RADIUS_CELLS))
  );
}

/**
 * Pollution driver: −0..POLLUTION_PENALTY_MAX for the Chebyshev distance
 * `d` (cells) to the nearest completed `fouling` building. Linear decay
 * to zero at POLLUTION_RADIUS_CELLS.
 */
export function pollutionPenaltyForDistance(d: number): number {
  if (d >= POLLUTION_RADIUS_CELLS) return 0;
  return -POLLUTION_PENALTY_MAX * (1 - d / POLLUTION_RADIUS_CELLS);
}

// ---------------------------------------------------------------------------
// The derived model
// ---------------------------------------------------------------------------

/**
 * Derived desirability data. NEVER snapshotted — rebuilt deterministically
 * from city + terrain on structural change (see `desirabilityKey`).
 */
export interface DesirabilityModel {
  /** Cache key this model was built for. */
  key: string;
  /** Residential-zone cell → desirability (integer 0–100). */
  values: Map<number, number>;
}

let modelCache: { city: CityState; key: string; model: DesirabilityModel } | null = null;

/**
 * Cache key: everything the builder reads. `utilityEpoch` covers building
 * place/demolish and zone paint (all bump it); the completed-building id
 * list covers construction completions, which advance per economy tick
 * (the utilityNetworks.ts precedent — completion is a structural change
 * for every derived model).
 */
function desirabilityKey(city: CityState): string {
  const completedIds: number[] = [];
  for (const b of city.buildings) {
    if (b.progress >= 1) completedIds.push(b.id);
  }
  // buildings are in placement (id) order, so the list is already sorted.
  return `e${city.utilityEpoch ?? 0};c${completedIds.join(',')}`;
}

/** Residential-zone cells, sorted ascending. */
function residentialCells(city: CityState): number[] {
  const cells: number[] = [];
  for (const z of city.zones) {
    if (z.zone === ZoneType.RESIDENTIAL) cells.push(z.cell);
  }
  cells.sort((a, b) => a - b);
  return cells;
}

/**
 * Multi-source BFS (8-neighborhood = Chebyshev metric) over the bounding
 * box of the residential cells expanded by WATER_DECAY_RADIUS_CELLS, seeded
 * from every water cell inside the box. Returns a map of cell → Chebyshev
 * distance to the nearest water cell (only cells within the decay radius
 * are reached). O(box cells) — structural-change-only cost.
 */
function waterDistanceMap(t: TerrainData, cells: number[]): Map<number, number> {
  const dist = new Map<number, number>();
  if (cells.length === 0) return dist;
  let minCx = Infinity;
  let maxCx = -Infinity;
  let minCz = Infinity;
  let maxCz = -Infinity;
  for (const cell of cells) {
    const { cx, cz } = cellCoords(cell);
    if (cx < minCx) minCx = cx;
    if (cx > maxCx) maxCx = cx;
    if (cz < minCz) minCz = cz;
    if (cz > maxCz) maxCz = cz;
  }
  const R = WATER_DECAY_RADIUS_CELLS;
  const maxCell = CITY_GRID_CELLS - 1;
  const x0 = Math.max(0, minCx - R);
  const x1 = Math.min(maxCell, maxCx + R);
  const z0 = Math.max(0, minCz - R);
  const z1 = Math.min(maxCell, maxCz + R);
  // Seed from every water cell in the box.
  const queue: number[] = [];
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (cellIsWater(t, cx, cz)) {
        const cell = cellIndex(cx, cz);
        dist.set(cell, 0);
        queue.push(cell);
      }
    }
  }
  // 8-neighborhood flood: first visit is the Chebyshev distance.
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head] as number;
    const d = dist.get(cell) as number;
    if (d >= R) continue;
    const { cx, cz } = cellCoords(cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (!inBounds(nx, nz)) continue;
        const ncell = cellIndex(nx, nz);
        if (dist.has(ncell)) continue;
        dist.set(ncell, d + 1);
        queue.push(ncell);
      }
    }
  }
  return dist;
}

/**
 * Window-rasterized nearest-source distances: for each source anchor cell,
 * stamp a (2*radius+1)² window with the Chebyshev distance, keeping the
 * minimum per cell. Sources are few (polluters, amenity buildings), so
 * the raster is cheap. Returns cell → nearest source distance.
 */
function sourceDistanceMap(sources: number[], radius: number): Map<number, number> {
  const dist = new Map<number, number>();
  for (const src of sources) {
    const { cx: sx, cz: sz } = cellCoords(src);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = sx + dx;
        const nz = sz + dz;
        if (!inBounds(nx, nz)) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dz));
        const cell = cellIndex(nx, nz);
        const prev = dist.get(cell);
        if (prev === undefined || d < prev) dist.set(cell, d);
      }
    }
  }
  return dist;
}

/** Completed buildings matching an amenity-table row, by anchor cell. */
function amenitySources(city: CityState, row: AmenityDef): number[] {
  const sources: number[] = [];
  for (const b of city.buildings) {
    if (b.progress < 1) continue;
    if (row.kind !== undefined) {
      if (b.kind === row.kind) sources.push(cellIndex(b.cx, b.cz));
    } else if (row.waterfront === true) {
      // The Phase 4 marina hook: any def carrying waterfrontAmenity.
      if (BUILDING_DEFS[b.kind].waterfrontAmenity === true) {
        sources.push(cellIndex(b.cx, b.cz));
      }
    }
  }
  return sources;
}

/** Completed buildings whose def carries the `fouling` flag, by anchor cell. */
function pollutionSources(city: CityState): number[] {
  const sources: number[] = [];
  for (const b of city.buildings) {
    if (b.progress < 1) continue;
    if (BUILDING_DEFS[b.kind].fouling === true) sources.push(cellIndex(b.cx, b.cz));
  }
  return sources;
}

function buildModel(t: TerrainData, city: CityState): DesirabilityModel {
  const cells = residentialCells(city);
  const values = new Map<number, number>();
  if (cells.length === 0) {
    return { key: desirabilityKey(city), values };
  }
  const waterDist = waterDistanceMap(t, cells);
  const pollDist = sourceDistanceMap(pollutionSources(city), POLLUTION_RADIUS_CELLS);
  // Amenity rows are independent: one distance map per row, then sum the
  // bonuses that apply (capped). The table stays small by design.
  const amenityDists = AMENITY_TABLE.map((row) => ({
    row,
    dist: sourceDistanceMap(amenitySources(city, row), row.radius),
  }));
  for (const cell of cells) {
    let v = BASE_DESIRABILITY;
    v += elevationBonus(t, cell);
    const wd = waterDist.get(cell);
    v += waterBonusForDistance(wd === undefined ? Infinity : wd);
    const pd = pollDist.get(cell);
    if (pd !== undefined) v += pollutionPenaltyForDistance(pd);
    let amenity = 0;
    for (const { row, dist } of amenityDists) {
      const ad = dist.get(cell);
      if (ad !== undefined && ad <= row.radius) amenity += row.bonus;
    }
    v += Math.min(AMENITY_BONUS_CAP, amenity);
    values.set(cell, Math.max(DESIRABILITY_MIN, Math.min(DESIRABILITY_MAX, Math.round(v))));
  }
  return { key: desirabilityKey(city), values };
}

/**
 * The derived desirability model for a world. Cached per (city, key);
 * rebuilt ONLY on structural change (building placed/demolished/
 * completed, zone painted) — never per tick. Callers that need the
 * model every frame (the overlay) get the cached instance back.
 */
export function getDesirabilityModel(t: TerrainData, world: World): DesirabilityModel {
  const city = world.city;
  const key = desirabilityKey(city);
  if (modelCache && modelCache.city === city && modelCache.key === key) {
    return modelCache.model;
  }
  const model = buildModel(t, city);
  modelCache = { city, key, model };
  return model;
}

/**
 * Desirability (0–100) of one residential-zone cell. Falls back to
 * BASE_DESIRABILITY for cells the model doesn't cover (never happens for
 * residential cells, but keeps callers total).
 */
export function cellDesirability(model: DesirabilityModel, cell: number): number {
  return model.values.get(cell) ?? BASE_DESIRABILITY;
}

/**
 * Land value of a building: the mean desirability over its footprint
 * cells (placement validation guarantees zoned buildings sit fully on
 * their zone). Falls back to BASE_DESIRABILITY when no footprint cell
 * has a value.
 */
export function buildingLandValue(model: DesirabilityModel, b: BuildingRecord): number {
  const def = BUILDING_DEFS[b.kind];
  const cells = footprintCells(b.cx, b.cz, def.footprintW, def.footprintH);
  let sum = 0;
  let n = 0;
  for (const cell of cells) {
    const v = model.values.get(cell);
    if (v !== undefined) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : BASE_DESIRABILITY;
}

/** Residential tax multiplier for a building (via its land value). */
export function buildingTaxMultiplier(model: DesirabilityModel, b: BuildingRecord): number {
  return landValueTaxMultiplier(buildingLandValue(model, b));
}
