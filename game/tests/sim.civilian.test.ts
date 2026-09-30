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
 * NOVATERRA — tests/sim.civilian.test.ts — grand-expansion Phase 8
 * (civilian deep-dive, workstream E, 2026-09-30): the 10 new civilian
 * buildings.
 *
 * Covers:
 *  - the workstream-A contract: every new def carries
 *    `military: false` explicitly (civilian, peaceful-buildable),
 *  - the exact def numbers (costs, timings, outputs, zones, ages),
 *  - the family orderings the user asked for (grand market = the
 *    market's 2x big brother; clinic < hospital < medicalCenter health
 *    tiers; bank/officeTower commercial finance tiers),
 *  - the new desirability amenity rows (museum/theater at the cultural
 *    +5/12 tier, sports stadium +7/17, botanical garden +6/16, fire
 *    station +3/10) — scenario-style through `getDesirabilityModel`,
 *  - the museum joining the education research set (lab and
 *    radarStation stay out),
 *  - icon + string coverage for the ten kinds.
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
  type BuildingKind,
  type CityState,
  type Placement,
} from '../src/sim/city';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  AMENITY_BONUS_PER_TYPE,
  AMENITY_RADIUS_CELLS,
  AMENITY_TABLE,
  BOTANICAL_GARDEN_BONUS,
  BOTANICAL_GARDEN_RADIUS_CELLS,
  FIRE_STATION_BONUS,
  FIRE_STATION_RADIUS_CELLS,
  SPORTS_STADIUM_BONUS,
  SPORTS_STADIUM_RADIUS_CELLS,
  cellDesirability,
  getDesirabilityModel,
} from '../src/sim/desirability';
import { EDUCATION_RESEARCH_KINDS } from '../src/sim/economy';
import { buildingIcon } from '../src/ui/icons';
import { STRINGS } from '../src/ui/strings';

const NEW_CIVILIAN: BuildingKind[] = [
  'museum',
  'theater',
  'sportsStadium',
  'botanicalGarden',
  'grandMarket',
  'bank',
  'officeTower',
  'clinic',
  'medicalCenter',
  'fireStation',
];

describe('civilian building defs (workstream E)', () => {
  it('all ten are explicitly civilian (military: false) — the workstream-A contract', () => {
    for (const kind of NEW_CIVILIAN) {
      const def = BUILDING_DEFS[kind];
      expect(def.kind).toBe(kind);
      // Explicit, not absent: the peaceful lockout keys off
      // `def.military === true`, so every new civilian def must carry
      // the false flag in the source.
      expect(def.military).toBe(false);
    }
  });

  it('culture buildings: exact costs, outputs, and ages', () => {
    const museum = BUILDING_DEFS.museum;
    expect(museum).toMatchObject({
      kind: 'museum',
      zone: 'utility',
      footprintW: 3,
      footprintH: 3,
      costFunds: 700,
      costMaterials: 250,
      buildSeconds: 40,
      upkeepFundsPerSec: 0.9,
      minAge: 'connectivity',
    });
    expect(museum.output.research).toBe(0.15);

    const theater = BUILDING_DEFS.theater;
    expect(theater).toMatchObject({
      kind: 'theater',
      zone: 'utility',
      costFunds: 900,
      costMaterials: 300,
      buildSeconds: 45,
      upkeepFundsPerSec: 1.2,
      minAge: 'connectivity',
    });
    expect(theater.output.funds).toBe(0.8);
  });

  it('sports stadium: the regional draw', () => {
    const def = BUILDING_DEFS.sportsStadium;
    expect(def).toMatchObject({
      kind: 'sportsStadium',
      zone: 'utility',
      footprintW: 4,
      footprintH: 4,
      costFunds: 2200,
      costMaterials: 900,
      buildSeconds: 80,
      upkeepFundsPerSec: 2.5,
      minAge: 'industry',
    });
    expect(def.output.funds).toBe(1.5);
    expect(def.jobs).toBe(25);
  });

  it('botanical garden: the park grown up (foundation age, no power)', () => {
    const def = BUILDING_DEFS.botanicalGarden;
    expect(def).toMatchObject({
      kind: 'botanicalGarden',
      zone: 'utility',
      footprintW: 4,
      footprintH: 4,
      costFunds: 600,
      costMaterials: 200,
      buildSeconds: 30,
      minAge: 'foundation',
      powerDemand: 0,
    });
    expect(def.output.influence).toBe(0.1);
  });

  it('grand market: the market\'s 2x big brother', () => {
    const def = BUILDING_DEFS.grandMarket;
    const market = BUILDING_DEFS.market;
    expect(def).toMatchObject({
      kind: 'grandMarket',
      zone: ZoneType.COMMERCIAL,
      footprintW: 4,
      footprintH: 4,
      minAge: 'industry',
    });
    // Exactly twice the market's funds output and inputs, on every axis
    // bigger than the market.
    expect(def.output.funds).toBe(2 * (market.output.funds ?? 0));
    expect(def.input.food).toBe(2 * (market.input.food ?? 0));
    expect(def.input.goods).toBe(2 * (market.input.goods ?? 0));
    expect(def.costFunds).toBeGreaterThan(market.costFunds);
    expect(def.taxBasePerSec).toBeGreaterThan(market.taxBasePerSec);
    expect(def.jobs).toBeGreaterThan(market.jobs ?? 0);
  });

  it('bank and office tower: the commercial finance/employment tiers', () => {
    const bank = BUILDING_DEFS.bank;
    const tower = BUILDING_DEFS.officeTower;
    expect(bank).toMatchObject({
      kind: 'bank',
      zone: ZoneType.COMMERCIAL,
      footprintW: 2,
      footprintH: 2,
      minAge: 'connectivity',
    });
    expect(bank.output.funds).toBe(1.2);
    expect(tower).toMatchObject({
      kind: 'officeTower',
      zone: ZoneType.COMMERCIAL,
      footprintW: 3,
      footprintH: 3,
      minAge: 'industry',
    });
    expect(tower.output.funds).toBe(2.0);
    // The tower is the bigger employer on every axis.
    expect(tower.jobs).toBeGreaterThan(bank.jobs ?? 0);
    expect(tower.costFunds).toBeGreaterThan(bank.costFunds);
  });

  it('health tiers: clinic < hospital < medicalCenter manpower', () => {
    const clinic = BUILDING_DEFS.clinic;
    const hospital = BUILDING_DEFS.hospital;
    const center = BUILDING_DEFS.medicalCenter;
    expect(clinic.output.manpower).toBe(0.2);
    expect(hospital.output.manpower).toBe(0.4);
    expect(center.output.manpower).toBe(1.0);
    expect(clinic.minAge).toBe('foundation');
    expect(center.minAge).toBe('industry');
    // The flagship costs strictly more than the hospital on every axis.
    expect(center.costFunds).toBeGreaterThan(hospital.costFunds);
    expect(center.jobs).toBeGreaterThan(hospital.jobs ?? 0);
  });

  it('fire station: pure amenity building (no output, foundation age)', () => {
    const def = BUILDING_DEFS.fireStation;
    expect(def).toMatchObject({
      kind: 'fireStation',
      zone: 'utility',
      footprintW: 2,
      footprintH: 2,
      costFunds: 350,
      costMaterials: 120,
      buildSeconds: 25,
      upkeepFundsPerSec: 0.4,
      minAge: 'foundation',
    });
    expect(Object.keys(def.output)).toHaveLength(0);
  });

  it('the museum joins the education research set; lab and radarStation stay out', () => {
    expect(EDUCATION_RESEARCH_KINDS.has('museum')).toBe(true);
    expect(EDUCATION_RESEARCH_KINDS.has('lab')).toBe(false);
    expect(EDUCATION_RESEARCH_KINDS.has('radarStation')).toBe(false);
  });

  it('icons and English names exist for all ten', () => {
    for (const kind of NEW_CIVILIAN) {
      expect(buildingIcon(kind)).toBeTruthy();
      expect(STRINGS.buildingNames[kind].en.length).toBeGreaterThan(0);
    }
  });
});

describe('civilian amenity rows (workstream E)', () => {
  it('museum and theater join the cultural +5/12 tier', () => {
    for (const kind of ['museum', 'theater'] as const) {
      const row = AMENITY_TABLE.find((a) => a.kind === kind);
      expect(row).toMatchObject({
        kind,
        radius: AMENITY_RADIUS_CELLS,
        bonus: AMENITY_BONUS_PER_TYPE,
      });
    }
  });

  it('stadium +7/17 (biggest civic building, one step below the central station)', () => {
    const row = AMENITY_TABLE.find((a) => a.kind === 'sportsStadium');
    expect(row).toMatchObject({
      kind: 'sportsStadium',
      radius: SPORTS_STADIUM_RADIUS_CELLS,
      bonus: SPORTS_STADIUM_BONUS,
    });
    expect(SPORTS_STADIUM_BONUS).toBe(7);
    expect(SPORTS_STADIUM_RADIUS_CELLS).toBe(17);
  });

  it('botanical garden +6/16, fire station +3/10', () => {
    const garden = AMENITY_TABLE.find((a) => a.kind === 'botanicalGarden');
    expect(garden).toMatchObject({
      kind: 'botanicalGarden',
      radius: BOTANICAL_GARDEN_RADIUS_CELLS,
      bonus: BOTANICAL_GARDEN_BONUS,
    });
    expect(BOTANICAL_GARDEN_BONUS).toBe(6);
    const fire = AMENITY_TABLE.find((a) => a.kind === 'fireStation');
    expect(fire).toMatchObject({
      kind: 'fireStation',
      radius: FIRE_STATION_RADIUS_CELLS,
      bonus: FIRE_STATION_BONUS,
    });
    expect(FIRE_STATION_BONUS).toBe(3);
    expect(FIRE_STATION_RADIUS_CELLS).toBe(10);
  });

  it('a completed museum adds exactly +5 to a nearby residential cell', () => {
    const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
    const world = createWorld(424243);
    const { cx, cz } = findLandRect(terrain, 34, 10);
    paintResidential(world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    // The museum anchor sits 7 cells east of the target — inside its
    // 12-cell cultural radius.
    completed(world.city, { kind: 'museum', owner: 0, cx: cx + 17, cz: cz + 2, facing: 0 });
    const near = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    expect(near - base).toBe(5);
  });
});

// --- local helpers (the same shape as tests/sim.parking.test.ts) ---

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
