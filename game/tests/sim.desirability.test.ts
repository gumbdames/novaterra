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
 * NOVATERRA — tests/sim.desirability.test.ts — workstream W (grand
 * expansion, 2026-09-30): residential desirability, land-value tiers,
 * and the migration pull.
 *
 * Covers:
 *  - the pure drivers (elevation / water / pollution / amenities) with
 *    their radii and caps,
 *  - the land-value tier boundaries and tax multipliers,
 *  - the migration-pull curve (peak at the top of "nice", fade in
 *    "prime", clamps),
 *  - the derived-model cache contract: same reference across ticks
 *    (never recomputed per tick), rebuilt on structural change only
 *    (place / demolish / zone paint / construction completion),
 *  - scenario wiring: amenity types counted once each, the +20 cap,
 *    completion-gating, pollution source gating, water proximity,
 *    non-residential cells unscored,
 *  - the land-value tax multiplier in runTaxes (residential only),
 *  - migration: a park-adjacent residential zone develops at least as
 *    much as the identical bare zone (paired seeds),
 *  - snapshot v6 / digest contract: desirability is derived, never
 *    snapshotted or digested; the new kinds round-trip.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands, type CommandQueue } from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, heightAt, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  ZoneType,
  bumpUtilityEpoch,
  cellCenterWorld,
  cellIndex,
  cellIsWater,
  demolishBuilding,
  placeBuilding,
  registerCityCommands,
  type CityState,
  type Placement,
} from '../src/sim/city';
import {
  createEconomySystem,
  registerEconomyCommands,
  runEconomyTick,
} from '../src/sim/economy';
import { digestWorld } from '../src/sim/digest';
import { SNAPSHOT_VERSION, takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import {
  AMENITY_BONUS_CAP,
  AMENITY_BONUS_PER_TYPE,
  AMENITY_RADIUS_CELLS,
  AMENITY_TABLE,
  BASE_DESIRABILITY,
  ELEVATION_BONUS_MAX,
  ELEVATION_FULL_HEIGHT,
  WATER_BONUS_MAX,
  WATER_DECAY_RADIUS_CELLS,
  WATER_FULL_RADIUS_CELLS,
  buildingLandValue,
  buildingTaxMultiplier,
  cellDesirability,
  elevationBonus,
  getDesirabilityModel,
  landValueTier,
  migrationPull,
  pollutionPenaltyForDistance,
  waterBonusForDistance,
  WATERFRONT_BONUS,
} from '../src/sim/desirability';

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function setup(seed = 20260928): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  // Start mid-pulse: the economy still runs on the first step
  // (150 % 30 === 0) but the tick-0 growth pulse is skipped, so scripted
  // multi-batch setups can't collide with auto-placed buildings.
  world.tick = 150;
  world.time = 150 / 30;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  const driver = createTickDriver({ queue, systems: [createEconomySystem(terrain)] });
  return { terrain, world, queue, driver };
}

function findLandRect(t: TerrainData, w: number, h: number): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error(`no ${w}x${h} land rect`);
}

/** Directly place a completed building (bypasses command validation). */
function completed(city: CityState, p: Placement) {
  const b = placeBuilding(city, p);
  b.progress = 1;
  return b;
}

/** Paint one residential zone rect directly (bypasses commands). */
function paintResidential(city: CityState, x0: number, z0: number, x1: number, z1: number): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.RESIDENTIAL });
    }
  }
  city.zones.sort((a, b) => a.cell - b.cell);
}

/** Advance the economy one sim-second per iteration, from a known tick. */
function runEconomySeconds(ctx: Ctx, seconds: number): void {
  ctx.world.tick = 0;
  ctx.world.time = 0;
  for (let s = 0; s < seconds; s++) {
    ctx.world.tick += 30;
    runEconomyTick(ctx.world, ctx.terrain);
  }
}

// ---------------------------------------------------------------------------
// Pure drivers
// ---------------------------------------------------------------------------

describe('desirability drivers (pure)', () => {
  it('elevation: reads terrain height above water level, +10 at +20, clamped', () => {
    const ctx = setup(30);
    const t = ctx.terrain;
    const { cx, cz } = findLandRect(t, 4, 4);
    const cell = cellIndex(cx, cz);
    const h = heightAt(t, cellCenterWorld(cx), cellCenterWorld(cz));
    const expected =
      ELEVATION_BONUS_MAX *
      Math.max(0, Math.min(1, (h - t.waterLevel) / ELEVATION_FULL_HEIGHT));
    expect(elevationBonus(t, cell)).toBeCloseTo(expected, 9);
    // The documented anchors: full bonus at +20, none at/below water.
    expect(ELEVATION_FULL_HEIGHT).toBe(20);
    expect(ELEVATION_BONUS_MAX).toBe(10);
  });

  it('water: +15 within 6 cells, linear decay to 0 at 20', () => {
    expect(WATER_FULL_RADIUS_CELLS).toBe(6);
    expect(WATER_DECAY_RADIUS_CELLS).toBe(20);
    expect(WATER_BONUS_MAX).toBe(15);
    expect(waterBonusForDistance(0)).toBe(15);
    expect(waterBonusForDistance(6)).toBe(15);
    expect(waterBonusForDistance(13)).toBeCloseTo(7.5, 9);
    expect(waterBonusForDistance(20)).toBe(0);
    expect(waterBonusForDistance(30)).toBe(0);
  });

  it('pollution: −25 adjacent, linear decay to 0 at 15 cells', () => {
    expect(pollutionPenaltyForDistance(0)).toBe(-25);
    expect(pollutionPenaltyForDistance(7)).toBeCloseTo(-25 * (1 - 7 / 15), 9);
    expect(pollutionPenaltyForDistance(15)).toBe(0);
    expect(pollutionPenaltyForDistance(40)).toBe(0);
  });

  it('amenity table: six +5 types at 12 cells, waterfront +10 at 15, cap +20', () => {
    expect(AMENITY_RADIUS_CELLS).toBe(12);
    expect(AMENITY_BONUS_PER_TYPE).toBe(5);
    expect(AMENITY_BONUS_CAP).toBe(20);
    const byKind = new Map(
      AMENITY_TABLE.filter((r) => r.kind !== undefined).map((r) => [r.kind as string, r] as const),
    );
    for (const kind of ['library', 'park', 'school', 'kindergarten', 'college', 'university']) {
      const row = byKind.get(kind);
      expect(row, `amenity row for ${kind}`).toBeDefined();
      expect(row!.bonus).toBe(5);
      expect(row!.radius).toBe(12);
    }
    const waterfront = AMENITY_TABLE.find((r) => r.waterfront === true)!;
    expect(waterfront.bonus).toBe(10);
    expect(waterfront.radius).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Land-value tiers
// ---------------------------------------------------------------------------

describe('land-value tiers', () => {
  it('boundaries and tax multipliers', () => {
    const tierOf = (d: number) => {
      const t = landValueTier(d);
      return [t.name, t.taxMultiplier] as const;
    };
    expect(tierOf(0)).toEqual(['low', 0.8]);
    expect(tierOf(25)).toEqual(['low', 0.8]);
    expect(tierOf(26)).toEqual(['modest', 1.0]);
    expect(tierOf(40)).toEqual(['modest', 1.0]);
    expect(tierOf(50)).toEqual(['modest', 1.0]);
    expect(tierOf(51)).toEqual(['nice', 1.3]);
    expect(tierOf(75)).toEqual(['nice', 1.3]);
    expect(tierOf(76)).toEqual(['prime', 1.7]);
    expect(tierOf(100)).toEqual(['prime', 1.7]);
  });

  it('the base cell is modest (tax ×1.0 — neutral vs the pre-W rate)', () => {
    expect(landValueTier(BASE_DESIRABILITY).taxMultiplier).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Migration pull
// ---------------------------------------------------------------------------

describe('migrationPull', () => {
  it('anchors: 0.55 at d=0, 1.45 at d=1', () => {
    expect(migrationPull(0)).toBeCloseTo(0.55, 9);
    expect(migrationPull(1)).toBeCloseTo(1.45, 9);
  });

  it('peaks at ×1.594 at the top of "nice" (d=0.72)', () => {
    // 0.55 + 1.45×0.72 = 1.594 — the documented peak: nice-but-affordable
    // cells grow fastest.
    expect(migrationPull(0.72)).toBeCloseTo(1.594, 9);
  });

  it('rises through modest/nice, then fades through prime (affordability)', () => {
    expect(migrationPull(0.4)).toBeCloseTo(0.55 + 1.45 * 0.4, 9);
    expect(migrationPull(0.5)).toBeLessThan(migrationPull(0.72));
    expect(migrationPull(0.85)).toBeLessThan(migrationPull(0.72));
    expect(migrationPull(0.85)).toBeGreaterThan(migrationPull(1));
    expect(migrationPull(0.99)).toBeGreaterThan(migrationPull(1));
  });

  it('clamps the input to [0, 1] and the pull to [0.1, 2]', () => {
    // Out-of-range inputs behave like the nearest valid input.
    expect(migrationPull(-3)).toBe(migrationPull(0));
    expect(migrationPull(99)).toBe(migrationPull(1));
    expect(migrationPull(NaN)).toBe(migrationPull(0));
    for (let i = 0; i <= 100; i++) {
      const p = migrationPull(i / 100);
      expect(p).toBeGreaterThanOrEqual(0.1);
      expect(p).toBeLessThanOrEqual(2);
    }
  });
});

// ---------------------------------------------------------------------------
// Derived-model cache contract
// ---------------------------------------------------------------------------

describe('desirability model caching', () => {
  it('returns the same cached instance when nothing changed', () => {
    const ctx = setup();
    const a = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    const b = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    expect(b).toBe(a);
  });

  it('is NOT recomputed per tick (structural change only)', () => {
    const ctx = setup();
    const before = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    // 120 economy ticks with no structural change: no rebuild.
    // (No zones painted → tryAutoDevelop exits early; nothing completes.)
    runEconomySeconds(ctx, 120);
    expect(getDesirabilityModel(ctx.terrain, ctx.world, 0)).toBe(before);
  });

  it('rebuilds on placeBuilding (utility epoch)', () => {
    const ctx = setup();
    const before = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    const { cx, cz } = findLandRect(ctx.terrain, 4, 4);
    placeBuilding(ctx.world.city, { kind: 'house', owner: 0, cx, cz, facing: 0 });
    expect(getDesirabilityModel(ctx.terrain, ctx.world, 0)).not.toBe(before);
  });

  it('rebuilds when a construction completes (completed-id set changes)', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 4, 4);
    const b = placeBuilding(ctx.world.city, { kind: 'house', owner: 0, cx, cz, facing: 0 });
    const before = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    b.progress = 1;
    expect(getDesirabilityModel(ctx.terrain, ctx.world, 0)).not.toBe(before);
  });

  it('rebuilds on demolish and on zone paint (epoch)', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 8, 8);
    const b = completed(ctx.world.city, { kind: 'house', owner: 0, cx, cz, facing: 0 });
    const before = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    demolishBuilding(ctx.world.city, b.id);
    const afterDemolish = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    expect(afterDemolish).not.toBe(before);
    // Zone paint: the paintZone command bumps the epoch, so the new
    // cells get scored on the next build. (paintResidential bypasses the
    // command — no bump, no rebuild — then we bump like the command.)
    paintResidential(ctx.world.city, cx, cz, cx + 3, cz + 3);
    expect(getDesirabilityModel(ctx.terrain, ctx.world, 0)).toBe(afterDemolish);
    bumpUtilityEpoch(ctx.world.city);
    const afterPaint = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    expect(afterPaint).not.toBe(afterDemolish);
    expect(afterPaint.values.size).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// Scenario wiring
// ---------------------------------------------------------------------------

describe('desirability scenarios', () => {
  it('a nearby completed park and library each add +5', () => {
    const ctx = setup(31);
    const { cx, cz } = findLandRect(ctx.terrain, 30, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    const base = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    // Park 3×3 and library 2×2 just east of the zone, both completed and
    // both within 12 cells of the target.
    completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 21, cz: cz + 2, facing: 0 });
    completed(ctx.world.city, { kind: 'library', owner: 0, cx: cx + 21, cz: cz + 6, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    expect(after - base).toBe(10);
  });

  it('amenity types count once each and cap at +20', () => {
    const ctx = setup(32);
    const { cx, cz } = findLandRect(ctx.terrain, 26, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 9, cz + 7);
    const target = cellIndex(cx + 7, cz + 3);
    const base = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    // Six amenity types clustered east of the zone, all within 12 cells
    // of the target (6 × +5 = 30 → cap 20). A second park must NOT
    // double-count its type.
    completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 11, cz: cz + 1, facing: 0 });
    completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 11, cz: cz + 5, facing: 0 });
    completed(ctx.world.city, { kind: 'library', owner: 0, cx: cx + 15, cz: cz + 1, facing: 0 });
    completed(ctx.world.city, { kind: 'school', owner: 0, cx: cx + 15, cz: cz + 4, facing: 0 });
    completed(ctx.world.city, { kind: 'kindergarten', owner: 0, cx: cx + 18, cz: cz + 1, facing: 0 });
    completed(ctx.world.city, { kind: 'college', owner: 0, cx: cx + 18, cz: cz + 4, facing: 0 });
    completed(ctx.world.city, { kind: 'university', owner: 0, cx: cx + 18, cz: cz + 6, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    expect(after - base).toBe(20);
  });

  it('unfinished amenities and non-amenity buildings add nothing', () => {
    const ctx = setup(33);
    const { cx, cz } = findLandRect(ctx.terrain, 30, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    const base = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    // A half-built park and a completed shop (not an amenity type).
    const park = placeBuilding(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 21, cz: cz + 2, facing: 0 });
    park.progress = 0.5;
    completed(ctx.world.city, { kind: 'shop', owner: 0, cx: cx + 24, cz: cz + 2, facing: 0 });
    expect(cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target)).toBe(base);
  });

  it('a completed coal plant penalizes nearby cells (−25 at the fence)', () => {
    const ctx = setup(34);
    const t = ctx.terrain;
    const { cx, cz } = findLandRect(t, 30, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 19, cz + 7);
    const tx = cx + 10;
    const tz = cz + 3;
    const target = cellIndex(tx, tz);
    // Coal plant 2×2 just east of the zone: the anchor cell is
    // (cx+21, cz+2); target (cx+10, cz+3) is 11 cells away (Chebyshev).
    completed(ctx.world.city, { kind: 'coalPlant', owner: 0, cx: cx + 21, cz: cz + 2, facing: 0 });
    const got = cellDesirability(getDesirabilityModel(t, ctx.world, 0), target);
    // Independent expectation: base + elevation + brute-force water
    // distance + the distance-11 pollution penalty (no amenities here).
    let wd = Infinity;
    for (let dz = -20; dz <= 20; dz++) {
      for (let dx = -20; dx <= 20; dx++) {
        const nx = tx + dx;
        const nz = tz + dz;
        if (nx < 0 || nz < 0 || nx >= CITY_GRID_CELLS || nz >= CITY_GRID_CELLS) continue;
        if (cellIsWater(t, nx, nz)) wd = Math.min(wd, Math.max(Math.abs(dx), Math.abs(dz)));
      }
    }
    const expected = Math.round(
      BASE_DESIRABILITY +
        elevationBonus(t, target) +
        waterBonusForDistance(wd) +
        pollutionPenaltyForDistance(11),
    );
    expect(got).toBe(expected);
    // And the penalty clearly bites (not a rounding artifact).
    expect(expected).toBeLessThan(Math.round(BASE_DESIRABILITY + elevationBonus(t, target) + waterBonusForDistance(wd)) - 5);
  });

  it('an unfinished coal plant does not pollute', () => {
    const ctx = setup(35);
    const { cx, cz } = findLandRect(ctx.terrain, 30, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    const base = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    const plant = placeBuilding(ctx.world.city, { kind: 'coalPlant', owner: 0, cx: cx + 21, cz: cz + 2, facing: 0 });
    plant.progress = 0.9;
    expect(cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target)).toBe(base);
  });

  it('water proximity: a shoreline cell beats the base by the water bonus', () => {
    const ctx = setup(36);
    const t = ctx.terrain;
    // Find a water cell, then a land cell within 10 cells of it.
    let wx = -1;
    let wz = -1;
    outer: for (let z = 0; z < CITY_GRID_CELLS; z++) {
      for (let x = 0; x < CITY_GRID_CELLS; x++) {
        if (cellIsWater(t, x, z)) { wx = x; wz = z; break outer; }
      }
    }
    expect(wx).toBeGreaterThanOrEqual(0);
    let lx = -1;
    let lz = -1;
    outer2: for (let z = Math.max(0, wz - 10); z <= Math.min(CITY_GRID_CELLS - 1, wz + 10); z++) {
      for (let x = Math.max(0, wx - 10); x <= Math.min(CITY_GRID_CELLS - 1, wx + 10); x++) {
        if (!cellIsWater(t, x, z)) { lx = x; lz = z; break outer2; }
      }
    }
    expect(lx).toBeGreaterThanOrEqual(0);
    paintResidential(ctx.world.city, lx, lz, lx, lz);
    const cell = cellIndex(lx, lz);
    const got = cellDesirability(getDesirabilityModel(t, ctx.world, 0), cell);
    // Independent expectation: brute-force the true nearest-water
    // distance. No amenities or pollution exist in this fresh world.
    let wd = Infinity;
    for (let dz = -20; dz <= 20; dz++) {
      for (let dx = -20; dx <= 20; dx++) {
        const nx = lx + dx;
        const nz = lz + dz;
        if (nx < 0 || nz < 0 || nx >= CITY_GRID_CELLS || nz >= CITY_GRID_CELLS) continue;
        if (cellIsWater(t, nx, nz)) wd = Math.min(wd, Math.max(Math.abs(dx), Math.abs(dz)));
      }
    }
    expect(wd).toBeLessThanOrEqual(10);
    const expected = Math.round(BASE_DESIRABILITY + elevationBonus(t, cell) + waterBonusForDistance(wd));
    expect(got).toBe(expected);
  });

  it('non-residential cells are unscored (baseline 40)', () => {
    const ctx = setup(37);
    const { cx, cz } = findLandRect(ctx.terrain, 10, 10);
    // Commercial zone + a completed park right next to it: the park must
    // not lift the commercial cell (desirability is residential-only).
    for (let dz = 0; dz < 4; dz++) {
      for (let dx = 0; dx < 4; dx++) {
        ctx.world.city.zones.push({ cell: cellIndex(cx + dx, cz + dz), zone: ZoneType.COMMERCIAL });
      }
    }
    ctx.world.city.zones.sort((a, b) => a.cell - b.cell);
    completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 5, cz, facing: 0 });
    const model = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    expect(model.values.size).toBe(0);
    expect(cellDesirability(model, cellIndex(cx, cz))).toBe(BASE_DESIRABILITY);
  });
});

// ---------------------------------------------------------------------------
// Land-value tax multiplier
// ---------------------------------------------------------------------------

describe('land-value tax multiplier', () => {
  it('buildingTaxMultiplier follows the tier of the footprint mean', () => {
    const ctx = setup(38);
    const { cx, cz } = findLandRect(ctx.terrain, 30, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 5, cz + 5);
    // Lift the block into "nice" with three amenity types (+15), on top
    // of whatever elevation/water the terrain gives.
    completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 8, cz, facing: 0 });
    completed(ctx.world.city, { kind: 'library', owner: 0, cx: cx + 8, cz: cz + 4, facing: 0 });
    completed(ctx.world.city, { kind: 'school', owner: 0, cx: cx + 8, cz: cz + 7, facing: 0 });
    const house = completed(ctx.world.city, { kind: 'house', owner: 0, cx, cz, facing: 0 });
    const model = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    const value = buildingLandValue(model, house);
    expect(value).toBeGreaterThan(50);
    expect(buildingTaxMultiplier(model, house)).toBe(landValueTier(Math.round(value)).taxMultiplier);
  });

  it('runTaxes applies the multiplier to residential buildings only', () => {
    // Two identical worlds: a house on a small residential zone (all
    // zone cells occupied → no auto-development noise), tax 50% vs 0%.
    // The funds difference is exactly the tax bill incl. land value.
    function taxedWorld(rate: number): Ctx {
      const ctx = setup(21);
      const { cx, cz } = findLandRect(ctx.terrain, 6, 4);
      paintResidential(ctx.world.city, cx, cz + 2, cx + 1, cz + 3);
      completed(ctx.world.city, { kind: 'house', owner: 0, cx, cz: cz + 2, facing: 0 });
      ctx.world.city.players[0]!.taxRates = [rate, rate, rate, rate];
      return ctx;
    }
    const half = taxedWorld(0.5);
    const zero = taxedWorld(0.0);
    const house = half.world.city.buildings.find((b) => b.kind === 'house')!;
    const landMult = buildingTaxMultiplier(
      getDesirabilityModel(half.terrain, half.world, 0),
      house,
    );
    // 61 economy ticks → one collection at index 60 (the sim.economy
    // pattern); level 1 → levelMult 1, no Fiber Grid → fiber mult 1.
    runEconomySeconds(half, 61);
    runEconomySeconds(zero, 61);
    const fundsHalf = half.world.city.players[0]!.funds;
    const fundsZero = zero.world.city.players[0]!.funds;
    const taxBase = BUILDING_DEFS.house.taxBasePerSec;
    expect(fundsHalf - fundsZero).toBeCloseTo(0.5 * taxBase * 60 * landMult, 6);
  });

  it('commercial buildings pay the flat rate (no land-value multiplier)', () => {
    // Two identical worlds, tax 50% vs 0%. The shop sits on a 2×2
    // residential zone it fully occupies (no auto-development noise), in
    // a spot the amenities lift to "nice" or better — so the pure
    // buildingTaxMultiplier is well above 1. runTaxes must still bill the
    // shop flat, because the land-value gate is on the building's
    // COMMERCIAL def zone, not the zone paint under it.
    function taxedWorld(rate: number): Ctx {
      const ctx = setup(22);
      const { cx, cz } = findLandRect(ctx.terrain, 30, 10);
      paintResidential(ctx.world.city, cx, cz, cx + 1, cz + 1);
      completed(ctx.world.city, { kind: 'shop', owner: 0, cx, cz, facing: 0 });
      completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 3, cz: cz - 1, facing: 0 });
      completed(ctx.world.city, { kind: 'library', owner: 0, cx: cx + 3, cz: cz + 3, facing: 0 });
      completed(ctx.world.city, { kind: 'school', owner: 0, cx: cx + 6, cz: cz + 1, facing: 0 });
      ctx.world.city.players[0]!.taxRates = [rate, rate, rate, rate];
      return ctx;
    }
    const half = taxedWorld(0.5);
    const zero = taxedWorld(0.0);
    const shop = half.world.city.buildings.find((b) => b.kind === 'shop')!;
    const model = getDesirabilityModel(half.terrain, half.world, 0);
    // The footprint really is valuable land — the multiplier WOULD bite.
    expect(buildingLandValue(model, shop)).toBeGreaterThan(50);
    expect(buildingTaxMultiplier(model, shop)).toBeGreaterThan(1);
    // 61 economy ticks → one collection at index 60; upkeep and all other
    // flows are identical across the two worlds, so the funds difference
    // is exactly the flat tax bill (no land multiplier).
    runEconomySeconds(half, 61);
    runEconomySeconds(zero, 61);
    const fundsHalf = half.world.city.players[0]!.funds;
    const fundsZero = zero.world.city.players[0]!.funds;
    const taxBase = BUILDING_DEFS.shop.taxBasePerSec;
    expect(fundsHalf - fundsZero).toBeCloseTo(0.5 * taxBase * 60, 6);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('migration', () => {
  it('a park-adjacent zone develops at least as much as the identical bare zone (paired seeds)', () => {
    let parkTotal = 0;
    let bareTotal = 0;
    for (let seed = 1; seed <= 12; seed++) {
      for (const withPark of [false, true]) {
        const ctx = setup(1000 + seed);
        // 28-wide land rect: the park at cx+21 sits on guaranteed land.
        const { cx, cz } = findLandRect(ctx.terrain, 28, 8);
        paintResidential(ctx.world.city, cx, cz, cx + 19, cz + 7);
        if (withPark) {
          completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 21, cz: cz + 2, facing: 0 });
        }
        ctx.world.city.players[0]!.funds = 100000;
        ctx.world.city.players[0]!.materials = 100000;
        for (let i = 0; i < 7200; i++) ctx.driver.step(ctx.world, TICK_MS);
        const n = ctx.world.city.buildings.filter(
          (b) => b.kind === 'house' || b.kind === 'apartment',
        ).length;
        if (withPark) parkTotal += n;
        else bareTotal += n;
      }
    }
    // The pull is strictly >1 near the park (d≈0.45 → ×1.2); the bare
    // zone never out-develops it.
    expect(parkTotal).toBeGreaterThanOrEqual(bareTotal);
  });
});

// ---------------------------------------------------------------------------
// Snapshot v6 / digest contract
// ---------------------------------------------------------------------------

describe('snapshot/digest contract', () => {
  it('stays v7: desirability is derived, never snapshotted', () => {
    const ctx = setup(40);
    const { cx, cz } = findLandRect(ctx.terrain, 10, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 5, cz + 5);
    completed(ctx.world.city, { kind: 'library', owner: 0, cx, cz, facing: 0 });
    completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 6, cz, facing: 0 });
    // Building the model must not touch the snapshot at all.
    const before = takeSnapshot(ctx.world);
    getDesirabilityModel(ctx.terrain, ctx.world, 0);
    const after = takeSnapshot(ctx.world);
    expect(before.version).toBe(SNAPSHOT_VERSION);
    expect(after.version).toBe(8); // v8: Phase 5/6 S4 hangar data contract
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('digestWorld is unchanged by the workstream (derived from digested inputs)', () => {
    const ctx = setup(41);
    const { cx, cz } = findLandRect(ctx.terrain, 10, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 5, cz + 5);
    completed(ctx.world.city, { kind: 'library', owner: 0, cx, cz, facing: 0 });
    const d1 = digestWorld(ctx.world);
    // Building the derived model adds no digest fields.
    getDesirabilityModel(ctx.terrain, ctx.world, 0);
    expect(digestWorld(ctx.world)).toBe(d1);
  });

  it('the new kinds round-trip through snapshot encode/decode', () => {
    const ctx = setup(42);
    const { cx, cz } = findLandRect(ctx.terrain, 10, 10);
    const lib = completed(ctx.world.city, { kind: 'library', owner: 0, cx, cz, facing: 0 });
    const park = completed(ctx.world.city, { kind: 'park', owner: 0, cx: cx + 4, cz, facing: 0 });
    const snap = takeSnapshot(ctx.world);
    const world2 = restoreSnapshot(snap);
    const lib2 = world2.city.buildings.find((b) => b.id === lib.id)!;
    const park2 = world2.city.buildings.find((b) => b.id === park.id)!;
    expect(lib2.kind).toBe('library');
    expect(park2.kind).toBe('park');
    expect(BUILDING_DEFS[lib2.kind].name).toBe('Library');
    expect(BUILDING_DEFS[park2.kind].name).toBe('Park');
  });
});

// ---------------------------------------------------------------------------
// New building defs
// ---------------------------------------------------------------------------

describe('library/park defs', () => {
  it('are civic UTILITY_ZONE buildings placeable from the foundation age', () => {
    const lib = BUILDING_DEFS.library;
    const park = BUILDING_DEFS.park;
    expect(lib.zone).toBe('utility');
    expect(park.zone).toBe('utility');
    expect(lib.minAge).toBe('foundation');
    expect(park.minAge).toBe('foundation');
    expect(lib.footprintW).toBe(2);
    expect(park.footprintW).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: marina waterfront amenity (item 6)
// ---------------------------------------------------------------------------

describe('marina waterfront amenity (Phase 4)', () => {
  it('a completed marina raises nearby residential desirability by the waterfront bonus, through the hook, with zero desirability-code changes', () => {
    const ctx = setup(41);
    const { cx, cz } = findLandRect(ctx.terrain, 30, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    const base = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    // Marina 2×2 just east of the zone, completed, within the 15-cell
    // waterfront radius of the target (distance 11, Chebyshev).
    completed(ctx.world.city, { kind: 'marina', owner: 0, cx: cx + 21, cz: cz + 2, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    expect(after - base).toBe(WATERFRONT_BONUS);
  });

  it('a half-built marina adds nothing (the hook needs a completed building)', () => {
    const ctx = setup(42);
    const { cx, cz } = findLandRect(ctx.terrain, 30, 10);
    paintResidential(ctx.world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    const base = cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target);
    const marina = placeBuilding(ctx.world.city, { kind: 'marina', owner: 0, cx: cx + 21, cz: cz + 2, facing: 0 });
    marina.progress = 0.5;
    expect(cellDesirability(getDesirabilityModel(ctx.terrain, ctx.world, 0), target)).toBe(base);
  });

  it('a house near the marina gains land value while an identical far house does not', () => {
    const ctx = setup(43);
    const { cx, cz } = findLandRect(ctx.terrain, 44, 12);
    paintResidential(ctx.world.city, cx, cz, cx + 33, cz + 9);
    // Two identical completed houses: one close to the marina site, one
    // well outside the 15-cell waterfront radius.
    const near = completed(ctx.world.city, { kind: 'house', owner: 0, cx: cx + 2, cz: cz + 2, facing: 0 });
    const far = completed(ctx.world.city, { kind: 'house', owner: 0, cx: cx + 29, cz: cz + 2, facing: 0 });
    const before = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    const nearBase = buildingLandValue(before, near);
    const farBase = buildingLandValue(before, far);
    // Marina 2×2 next to the near house (anchor distance 4); the far
    // house is 25 cells away — outside the radius.
    completed(ctx.world.city, { kind: 'marina', owner: 0, cx: cx + 6, cz: cz + 2, facing: 0 });
    const after = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    const nearAfter = buildingLandValue(after, near);
    const farAfter = buildingLandValue(after, far);
    expect(nearAfter).toBeGreaterThan(nearBase);
    expect(farAfter).toBe(farBase);
    // The full waterfront bonus lands on the near house's footprint.
    expect(nearAfter - nearBase).toBe(WATERFRONT_BONUS);
  });
});
