/**
 * NOVATERRA — tests/sim.parking.test.ts — workstream P (ambient city
 * life, grand expansion, 2026-09-30): the two civic parking buildings.
 *
 * Covers:
 *  - the BUILDING_DEFS entries (exact costs, build time, upkeep, power,
 *    tax base, zone, foundation) and the "garage costs more than lot"
 *    ordering,
 *  - the desirability amenity rows (lot +3 within 8 cells, garage +4
 *    within 10) and how they play within the +20 cap alongside the
 *    workstream W amenities (scenario-style, through
 *    `getDesirabilityModel` — the same contract as sim.desirability.test.ts),
 *  - the civic-tab palette membership (stable tab order),
 *  - icon + string coverage (compile-enforced, pinned at 55 here too),
 *  - the 55-kind agreement across palettes, defs, icons, and strings.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  ZoneType,
  cellIndex,
  cellIsWater,
  placeBuilding,
  type CityState,
  type Placement,
} from '../src/sim/city';
import { buildingIcon } from '../src/ui/icons';
import { STRINGS } from '../src/ui/strings';
import { BUILD_TABS } from '../src/ui/palettes';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  AMENITY_BONUS_CAP,
  AMENITY_TABLE,
  cellDesirability,
  getDesirabilityModel,
  type AmenityDef,
} from '../src/sim/desirability';
import type { BuildingKind } from '../src/sim/city';

const PARKING: BuildingKind[] = ['parkingLot', 'parkingGarage'];

describe('parking building defs', () => {
  it('both are civic, UTILITY_ZONE, foundation-age buildings', () => {
    for (const kind of PARKING) {
      const def = BUILDING_DEFS[kind];
      expect(def.zone).toBe('utility');
      expect(def.kind).toBe(kind);
      // Foundation age = available from the start, like the park/library.
      expect(def.minAge).toBe('foundation');
    }
  });

  it('parking lot: exact costs and timings', () => {
    const def = BUILDING_DEFS.parkingLot;
    expect(def.costFunds).toBe(180);
    expect(def.costMaterials).toBe(60);
    expect(def.buildSeconds).toBe(15);
    expect(def.upkeepFundsPerSec).toBe(0.15);
    expect(def.powerDemand).toBe(1);
    expect(def.taxBasePerSec).toBe(1.0);
  });

  it('parking garage: exact costs and timings (bigger lot)', () => {
    const def = BUILDING_DEFS.parkingGarage;
    expect(def.costFunds).toBe(450);
    expect(def.costMaterials).toBe(180);
    expect(def.buildSeconds).toBe(30);
    expect(def.upkeepFundsPerSec).toBe(0.5);
    expect(def.powerDemand).toBe(3);
    expect(def.taxBasePerSec).toBe(2.5);
    // The garage costs strictly more than the lot on every axis.
    const lot = BUILDING_DEFS.parkingLot;
    for (const key of ['costFunds', 'costMaterials', 'buildSeconds', 'upkeepFundsPerSec', 'powerDemand', 'taxBasePerSec'] as const) {
      expect(def[key]).toBeGreaterThan(lot[key]);
    }
  });

  it('neither houses people nor demands water', () => {
    for (const kind of PARKING) {
      const def = BUILDING_DEFS[kind];
      expect(def.population).toBe(0);
      expect(def.waterDemand).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Desirability (scenario-style, via the derived model like W's tests)
// ---------------------------------------------------------------------------

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
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

function zoneWorld(): { terrain: TerrainData; world: World; target: number } {
  const terrain = getTerrain();
  const world = createWorld(424242);
  const { cx, cz } = findLandRect(terrain, 34, 10);
  paintResidential(world.city, cx, cz, cx + 19, cz + 7);
  return { terrain, world, target: cellIndex(cx + 10, cz + 3) };
}

describe('parking desirability amenities', () => {
  it('amenity rows: lot +3 within 8 cells, garage +4 within 10 cells', () => {
    const lot: AmenityDef | undefined = AMENITY_TABLE.find((a) => a.kind === 'parkingLot');
    const garage: AmenityDef | undefined = AMENITY_TABLE.find((a) => a.kind === 'parkingGarage');
    expect(lot).toMatchObject({ kind: 'parkingLot', radius: 8, bonus: 3 });
    expect(garage).toMatchObject({ kind: 'parkingGarage', radius: 10, bonus: 4 });
    // Deliberately below the +5/12 cultural types (convenience, not beloved).
    // Phase 4 tiered transit: the four small stops sit at the same +3/8
    // convenience tier as the lot (street furniture, not destinations).
    // Grand-expansion Phase 8 (civilian, workstream E): the fire station
    // is the same story — a +3/10 convenience-tier safety amenity
    // (reassuring, not beloved), so it is excluded from the strict
    // below-everything comparison like the small stops are.
    const SMALL_STOPS = new Set(['busStop', 'taxiStand', 'tramStop', 'ferryPier']);
    const CONVENIENCE_TIER = new Set(['fireStation']);
    for (const row of AMENITY_TABLE) {
      if (row.kind !== 'parkingLot' && row.kind !== 'parkingGarage' && !row.waterfront && row.kind !== undefined && !SMALL_STOPS.has(row.kind) && !CONVENIENCE_TIER.has(row.kind)) {
        expect(lot!.bonus).toBeLessThan(row.bonus);
        expect(garage!.bonus).toBeLessThan(row.bonus);
      }
    }
  });

  it('an adjacent completed lot adds exactly +3', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    // Re-find the same rect; the amenity scan measures from the
    // building's anchor cell, so the lot anchor sits 7 cells east of
    // the target — inside the lot's 8-cell radius.
    const t = getTerrain();
    const { cx: zx, cz: zz } = findLandRect(t, 34, 10);
    completed(world.city, { kind: 'parkingLot', owner: 0, cx: zx + 17, cz: zz + 2, facing: 0 });
    const near = cellDesirability(getDesirabilityModel(t, world, 0), target);
    expect(near - base).toBe(3);
  });

  it('a completed garage adds exactly +4; outside its 10-cell radius it adds nothing', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    const { cx: zx, cz: zz } = findLandRect(getTerrain(), 34, 10);
    // Garage anchor 8 east of the target: inside the 10-cell radius.
    completed(world.city, { kind: 'parkingGarage', owner: 0, cx: zx + 18, cz: zz + 2, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(after - base).toBe(4);
    // A second garage 15 cells east: outside the radius, no change.
    completed(world.city, { kind: 'parkingGarage', owner: 0, cx: zx + 25, cz: zz + 2, facing: 0 });
    const far = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(far).toBe(after);
  });

  it('unfinished parking and non-parking buildings add nothing', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    const { cx: zx, cz: zz } = findLandRect(getTerrain(), 34, 10);
    // The half-built lot sits INSIDE its radius — completion gates it.
    const half = placeBuilding(world.city, { kind: 'parkingLot', owner: 0, cx: zx + 17, cz: zz + 2, facing: 0 });
    half.progress = 0.5; // still constructing
    completed(world.city, { kind: 'house', owner: 0, cx: zx + 17, cz: zz + 6, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(after).toBe(base);
  });

  it('parking types stack with the W amenities toward the same +20 cap', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    const { cx: zx, cz: zz } = findLandRect(getTerrain(), 34, 10);
    // Four +5 cultural types (20) + lot (+3) + garage (+4) = 27 → cap.
    // Every anchor sits inside its type's radius of the target.
    completed(world.city, { kind: 'park', owner: 0, cx: zx + 20, cz: zz + 1, facing: 0 });
    completed(world.city, { kind: 'library', owner: 0, cx: zx + 21, cz: zz + 1, facing: 0 });
    completed(world.city, { kind: 'school', owner: 0, cx: zx + 20, cz: zz + 4, facing: 0 });
    completed(world.city, { kind: 'kindergarten', owner: 0, cx: zx + 21, cz: zz + 4, facing: 0 });
    completed(world.city, { kind: 'parkingLot', owner: 0, cx: zx + 17, cz: zz + 1, facing: 0 });
    completed(world.city, { kind: 'parkingGarage', owner: 0, cx: zx + 18, cz: zz + 5, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(after - base).toBe(AMENITY_BONUS_CAP);
  });
});

// ---------------------------------------------------------------------------
// UI coverage
// ---------------------------------------------------------------------------

describe('parking UI coverage', () => {
  it('icons: hand-made glyphs, distinct from each other', () => {
    const lotGlyph = buildingIcon('parkingLot');
    const garageGlyph = buildingIcon('parkingGarage');
    expect(lotGlyph).toBeTruthy();
    expect(garageGlyph).toBeTruthy();
    expect(lotGlyph).not.toBe(garageGlyph);
    // Both read as civic buildings: they differ from the park glyph too.
    expect(lotGlyph).not.toBe(buildingIcon('park'));
    expect(garageGlyph).not.toBe(buildingIcon('park'));
  });

  it('strings: English names', () => {
    expect(STRINGS.buildingNames.parkingLot.en).toBe('Parking Lot');
    expect(STRINGS.buildingNames.parkingGarage.en).toBe('Parking Garage');
  });

  it('civic tab holds the two parking buildings after the W amenities', () => {
    const civic = BUILD_TABS.find((t) => t.id === 'civic');
    expect(civic).toBeDefined();
    const idx = (k: BuildingKind) => civic!.kinds.indexOf(k);
    expect(idx('parkingLot')).toBeGreaterThan(-1);
    expect(idx('parkingGarage')).toBeGreaterThan(-1);
    // Tab order is stable: education, then W amenities, then parking.
    expect(idx('parkingLot')).toBeGreaterThan(idx('park'));
    expect(idx('parkingGarage')).toBeGreaterThan(idx('parkingLot'));
  });

  it('100 building kinds across palettes, icons, strings, and defs', () => {
    const kinds = Object.keys(BUILDING_DEFS) as BuildingKind[];
    // Grand-expansion Phase 8 (civilian, workstream E, 2026-09-30): 89 +
    // the 10 new civilian kinds (museum, theater, sportsStadium,
    // botanicalGarden, grandMarket, bank, officeTower, clinic,
    // medicalCenter, fireStation).
    // Civilian sea trade (Half A, 2026-10-01): + the commercialHarbor.
    expect(kinds).toHaveLength(100);
    const paletteKinds = new Set(BUILD_TABS.flatMap((t) => t.kinds));
    // NOTE (workstream E): the 10 new kinds land in BUILD_TABS with the
    // palettes-owning workstream's tab integration (ui/palettes.ts is
    // sibling-owned). Until then this assertion fails on the new kinds
    // — that is a cross-workstream handoff, not a sim regression.
    expect(paletteKinds.size).toBe(100);
    for (const kind of kinds) {
      expect(paletteKinds.has(kind)).toBe(true);
      expect(buildingIcon(kind)).toBeTruthy();
      expect(STRINGS.buildingNames[kind].en.length).toBeGreaterThan(0);
    }
  });
});
