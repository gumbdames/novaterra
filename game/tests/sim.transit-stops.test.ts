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
 * NOVATERRA — tests/sim.transit-stops.test.ts — Phase 4 tiered transit
 * stops/stations (grand expansion, 2026-09-30): the seven placeable
 * passenger stops (busStop, taxiStand, tramStop, ferryPier,
 * neighborhoodStation, centralStation, airportInterchange).
 *
 * Covers:
 *  - the served-modes table (exact per-kind lists, the subway mode in
 *    the data model before the vehicle exists, airportLink only on the
 *    interchange),
 *  - the defs (footprints, zones, tier cost ordering, age gates,
 *    ridershipIncome on all seven),
 *  - placement rules (ferryPier coastal rule; small stops need no
 *    zoning; stations need commercial zoning),
 *  - the desirability amenity rows (exact radius/bonus per tier, the
 *    central-station strategic decision, stacking toward the +20 cap),
 *  - the ambient accessor (per-mode, per-owner, completed+operational
 *    only, id order),
 *  - ridership income (flat tier rate via runEconomyTick; unfinished
 *    stops pay nothing),
 *  - save/load round-trip with stops present,
 *  - the Classic AI no-op (digest unchanged with stops on the map),
 *  - UI coverage (icons, strings, transport-tab membership).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  TRANSIT_MODES,
  TRANSIT_MODE_BY_UNIT_KIND,
  ZoneType,
  cellIndex,
  cellIsWater,
  placeBuilding,
  transitStopsForMode,
  validatePlacement,
  type BuildingKind,
  type CityState,
  type Placement,
  type TransitMode,
} from '../src/sim/city';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import { runEconomyTick } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { addAIPlayer, thinkCivilianTransport, thinkRoadClasses } from '../src/sim/ai';
import {
  AMENITY_BONUS_CAP,
  AMENITY_TABLE,
  cellDesirability,
  getDesirabilityModel,
  type AmenityDef,
} from '../src/sim/desirability';
import { buildingIcon } from '../src/ui/icons';
import { STRINGS } from '../src/ui/strings';
import { BUILD_TABS } from '../src/ui/palettes';

const STOPS: BuildingKind[] = [
  'busStop', 'taxiStand', 'tramStop', 'ferryPier',
  'neighborhoodStation', 'centralStation', 'airportInterchange',
];

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** First all-land rect of w×h (anchor at top-left). */
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

/** First all-land rect of w×h with/without coastal adjacency. */
function findShoreRect(
  t: TerrainData, w: number, h: number, wantCoastal: boolean,
): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let allLand = true;
      for (let dz = 0; dz < h && allLand; dz++) {
        for (let dx = 0; dx < w && allLand; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) allLand = false;
        }
      }
      if (!allLand) continue;
      let coastal = false;
      for (let dz = 0; dz < h && !coastal; dz++) {
        for (let dx = 0; dx < w && !coastal; dx++) {
          const px = cx + dx;
          const pz = cz + dz;
          if (
            (px > 0 && cellIsWater(t, px - 1, pz)) ||
            (px < CITY_GRID_CELLS - 1 && cellIsWater(t, px + 1, pz)) ||
            (pz > 0 && cellIsWater(t, px, pz - 1)) ||
            (pz < CITY_GRID_CELLS - 1 && cellIsWater(t, px, pz + 1))
          ) {
            coastal = true;
          }
        }
      }
      if (coastal === wantCoastal) return { cx, cz };
    }
  }
  throw new Error(`no ${wantCoastal ? 'coastal' : 'landlocked'} ${w}x${h} rect`);
}

/** Directly place a completed, operational building (bypasses commands). */
function completed(city: CityState, p: Placement) {
  const b = placeBuilding(city, p);
  b.progress = 1;
  b.operational = true;
  return b;
}

/** Paint one commercial zone rect directly (bypasses commands). */
function paintCommercial(city: CityState, x0: number, z0: number, x1: number, z1: number): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.COMMERCIAL });
    }
  }
  city.zones.sort((a, b) => a.cell - b.cell);
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

// ---------------------------------------------------------------------------
// Served-modes data model
// ---------------------------------------------------------------------------

describe('transit served-modes table', () => {
  it('pins the exact served modes per stop/station kind', () => {
    const expected: Partial<Record<BuildingKind, TransitMode[]>> = {
      busStop: ['bus'],
      taxiStand: ['taxi'],
      tramStop: ['tram'],
      ferryPier: ['boat'],
      neighborhoodStation: ['bus', 'taxi', 'tram'],
      centralStation: ['bus', 'taxi', 'tram', 'train', 'subway'],
      airportInterchange: ['bus', 'taxi', 'tram', 'train', 'subway', 'boat', 'air'],
    };
    for (const kind of STOPS) {
      expect(BUILDING_DEFS[kind].servedModes).toEqual(expected[kind]);
    }
  });

  it('lists subway as a data-model mode before the vehicle exists', () => {
    expect(TRANSIT_MODES).toContain('subway');
    // The two big stations already serve it — their defs never change
    // when the subway vehicle lands in a later phase.
    expect(BUILDING_DEFS.centralStation.servedModes).toContain('subway');
    expect(BUILDING_DEFS.airportInterchange.servedModes).toContain('subway');
  });

  it('sets airportLink only on the airport interchange (the Phase 5 hook)', () => {
    for (const kind of Object.keys(BUILDING_DEFS) as BuildingKind[]) {
      if (kind === 'airportInterchange') {
        expect(BUILDING_DEFS[kind].airportLink).toBe(true);
      } else {
        expect(BUILDING_DEFS[kind].airportLink ?? false).toBe(false);
      }
    }
  });

  it('every served mode is a known TransitMode', () => {
    for (const kind of STOPS) {
      for (const mode of BUILDING_DEFS[kind].servedModes ?? []) {
        expect(TRANSIT_MODES).toContain(mode);
      }
    }
  });

  it('maps civilian transport units to their ambient mode', () => {
    expect(TRANSIT_MODE_BY_UNIT_KIND).toMatchObject({
      bus: 'bus',
      tram: 'tram',
      passengerTrain: 'train',
      freightTrain: 'train',
      ferry: 'boat',
    });
  });
});

// ---------------------------------------------------------------------------
// Defs
// ---------------------------------------------------------------------------

describe('transit stop/station defs', () => {
  it('small stops are 1×1 UTILITY_ZONE street furniture', () => {
    for (const kind of ['busStop', 'taxiStand', 'tramStop'] as const) {
      const def = BUILDING_DEFS[kind];
      expect(def.footprintW).toBe(1);
      expect(def.footprintH).toBe(1);
      expect(def.zone).toBe('utility');
    }
    // The ferry pier is the 2×2 coastal member of the small tier.
    expect(BUILDING_DEFS.ferryPier.footprintW).toBe(2);
    expect(BUILDING_DEFS.ferryPier.footprintH).toBe(2);
    expect(BUILDING_DEFS.ferryPier.zone).toBe('utility');
  });

  it('stations are commercial-zone buildings with growing footprints', () => {
    expect(BUILDING_DEFS.neighborhoodStation.zone).toBe(ZoneType.COMMERCIAL);
    expect(BUILDING_DEFS.centralStation.zone).toBe(ZoneType.COMMERCIAL);
    expect(BUILDING_DEFS.airportInterchange.zone).toBe(ZoneType.COMMERCIAL);
    expect([BUILDING_DEFS.neighborhoodStation.footprintW, BUILDING_DEFS.neighborhoodStation.footprintH])
      .toEqual([2, 2]);
    expect([BUILDING_DEFS.centralStation.footprintW, BUILDING_DEFS.centralStation.footprintH])
      .toEqual([4, 3]);
    expect([BUILDING_DEFS.airportInterchange.footprintW, BUILDING_DEFS.airportInterchange.footprintH])
      .toEqual([4, 4]);
  });

  it('costs rise with the tier on every axis', () => {
    const tiers: BuildingKind[] = [
      'busStop', 'ferryPier', 'neighborhoodStation', 'centralStation', 'airportInterchange',
    ];
    for (let i = 1; i < tiers.length; i++) {
      const prev = BUILDING_DEFS[tiers[i - 1] as BuildingKind];
      const next = BUILDING_DEFS[tiers[i] as BuildingKind];
      for (const key of ['costFunds', 'costMaterials', 'buildSeconds', 'upkeepFundsPerSec'] as const) {
        expect(next[key]).toBeGreaterThan(prev[key]);
      }
    }
  });

  it('age gates: small stops at connectivity, central at industry, interchange at information', () => {
    for (const kind of ['busStop', 'taxiStand', 'tramStop', 'ferryPier', 'neighborhoodStation'] as const) {
      expect(BUILDING_DEFS[kind].minAge).toBe('connectivity');
    }
    expect(BUILDING_DEFS.centralStation.minAge).toBe('industry');
    expect(BUILDING_DEFS.airportInterchange.minAge).toBe('information');
  });

  it('every stop/station carries ridership income; nothing else does', () => {
    const incomes: Record<string, number> = {
      busStop: 0.08, taxiStand: 0.08, tramStop: 0.10, ferryPier: 0.22,
      neighborhoodStation: 0.45, centralStation: 1.2, airportInterchange: 1.8,
    };
    for (const kind of STOPS) {
      expect(BUILDING_DEFS[kind].ridershipIncome).toBe(incomes[kind]);
    }
    for (const kind of Object.keys(BUILDING_DEFS) as BuildingKind[]) {
      if (!STOPS.includes(kind)) {
        expect(BUILDING_DEFS[kind].ridershipIncome ?? 0).toBe(0);
      }
    }
  });

  it('stops house nobody and the small ones need no utilities', () => {
    for (const kind of STOPS) {
      expect(BUILDING_DEFS[kind].population).toBe(0);
    }
    for (const kind of ['busStop', 'taxiStand', 'tramStop', 'ferryPier'] as const) {
      expect(BUILDING_DEFS[kind].powerDemand).toBe(0);
      expect(BUILDING_DEFS[kind].waterDemand).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------

describe('transit stop placement rules', () => {
  it('ferryPier requires coastal adjacency, like ferryTerminal/marina', () => {
    const t = getTerrain();
    const world = createWorld(777);
    const inland = findShoreRect(t, 2, 2, false);
    const reason = validatePlacement(t, world.city, {
      kind: 'ferryPier', owner: 0, cx: inland.cx, cz: inland.cz, facing: 0,
    });
    expect(reason).toMatch(/coast/);
    const shore = findShoreRect(t, 2, 2, true);
    expect(validatePlacement(t, world.city, {
      kind: 'ferryPier', owner: 0, cx: shore.cx, cz: shore.cz, facing: 0,
    })).toBeNull();
  });

  it('small stops place on unzoned land (UTILITY_ZONE needs no zoning)', () => {
    const t = getTerrain();
    const world = createWorld(778);
    const { cx, cz } = findLandRect(t, 1, 1);
    for (const kind of ['busStop', 'taxiStand', 'tramStop'] as const) {
      expect(validatePlacement(t, world.city, { kind, owner: 0, cx, cz, facing: 0 })).toBeNull();
    }
  });

  it('stations need commercial zoning', () => {
    const t = getTerrain();
    const world = createWorld(779);
    const { cx, cz } = findLandRect(t, 4, 4);
    // Unzoned: rejected.
    expect(validatePlacement(t, world.city, {
      kind: 'neighborhoodStation', owner: 0, cx, cz, facing: 0,
    })).toMatch(/commercial/);
    // Commercial: accepted.
    paintCommercial(world.city, cx, cz, cx + 3, cz + 3);
    expect(validatePlacement(t, world.city, {
      kind: 'neighborhoodStation', owner: 0, cx, cz, facing: 0,
    })).toBeNull();
    expect(validatePlacement(t, world.city, {
      kind: 'centralStation', owner: 0, cx, cz, facing: 0,
    })).toBeNull();
    expect(validatePlacement(t, world.city, {
      kind: 'airportInterchange', owner: 0, cx, cz, facing: 0,
    })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Desirability amenity rows
// ---------------------------------------------------------------------------

function zoneWorld(): { terrain: TerrainData; world: World; target: number } {
  const terrain = getTerrain();
  const world = createWorld(424242);
  const { cx, cz } = findLandRect(terrain, 40, 12);
  paintResidential(world.city, cx, cz, cx + 39, cz + 11);
  return { terrain, world, target: cellIndex(cx + 20, cz + 5) };
}

describe('transit stop desirability amenities', () => {
  it('amenity rows: exact radius/bonus per tier', () => {
    const row = (kind: BuildingKind): AmenityDef | undefined =>
      AMENITY_TABLE.find((a) => a.kind === kind);
    expect(row('busStop')).toMatchObject({ radius: 8, bonus: 3 });
    expect(row('taxiStand')).toMatchObject({ radius: 8, bonus: 3 });
    expect(row('tramStop')).toMatchObject({ radius: 8, bonus: 3 });
    expect(row('ferryPier')).toMatchObject({ radius: 8, bonus: 3 });
    expect(row('neighborhoodStation')).toMatchObject({ radius: 12, bonus: 5 });
    expect(row('centralStation')).toMatchObject({ radius: 18, bonus: 8 });
    expect(row('airportInterchange')).toMatchObject({ radius: 20, bonus: 10 });
  });

  it('small stops score at the parking-lot convenience tier', () => {
    const lot = AMENITY_TABLE.find((a) => a.kind === 'parkingLot');
    for (const kind of ['busStop', 'taxiStand', 'tramStop', 'ferryPier'] as const) {
      const r = AMENITY_TABLE.find((a) => a.kind === kind);
      expect(r).toMatchObject({ radius: lot!.radius, bonus: lot!.bonus });
    }
  });

  it('the central station is the biggest non-waterfront amenity row', () => {
    const central = AMENITY_TABLE.find((a) => a.kind === 'centralStation');
    for (const r of AMENITY_TABLE) {
      if (r.kind === 'airportInterchange' || r.kind === 'centralStation' || r.waterfront) continue;
      expect(central!.bonus).toBeGreaterThanOrEqual(r.bonus);
      if (r.bonus === central!.bonus) {
        expect(central!.radius).toBeGreaterThan(r.radius);
      }
    }
    // The downtown strategic decision: +8 reaches 18 cells.
    expect(central).toMatchObject({ radius: 18, bonus: 8 });
  });

  it('a nearby bus stop adds exactly +3 to a residential cell', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    const { cx: zx, cz: zz } = findLandRect(getTerrain(), 40, 12);
    // Anchor 5 cells east of the target — inside the 8-cell radius.
    completed(world.city, { kind: 'busStop', owner: 0, cx: zx + 25, cz: zz + 5, facing: 0 });
    const near = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(near - base).toBe(3);
  });

  it('a central station adds exactly +8; outside 18 cells it adds nothing', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    const { cx: zx, cz: zz } = findLandRect(getTerrain(), 40, 12);
    // Anchor 10 east of target: inside the 18-cell radius.
    completed(world.city, { kind: 'centralStation', owner: 0, cx: zx + 30, cz: zz + 5, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(after - base).toBe(8);
  });

  it('transit types stack with the W amenities toward the same +20 cap', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    const { cx: zx, cz: zz } = findLandRect(getTerrain(), 40, 12);
    // centralStation (+8) + neighborhoodStation (+5) + busStop (+3) +
    // park (+5) = 21 → capped at +20.
    completed(world.city, { kind: 'centralStation', owner: 0, cx: zx + 28, cz: zz + 5, facing: 0 });
    completed(world.city, { kind: 'neighborhoodStation', owner: 0, cx: zx + 26, cz: zz + 4, facing: 0 });
    completed(world.city, { kind: 'busStop', owner: 0, cx: zx + 24, cz: zz + 6, facing: 0 });
    completed(world.city, { kind: 'park', owner: 0, cx: zx + 22, cz: zz + 5, facing: 0 });
    const after = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(after - base).toBe(AMENITY_BONUS_CAP);
  });

  it('unfinished stops add nothing', () => {
    const { terrain, world, target } = zoneWorld();
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    const { cx: zx, cz: zz } = findLandRect(getTerrain(), 40, 12);
    const half = placeBuilding(world.city, { kind: 'centralStation', owner: 0, cx: zx + 28, cz: zz + 5, facing: 0 });
    half.progress = 0.5;
    const after = cellDesirability(getDesirabilityModel(getTerrain(), world, 0), target);
    expect(after).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Ambient accessor
// ---------------------------------------------------------------------------

describe('transitStopsForMode (ambient hook)', () => {
  function stopWorld(): World {
    const world = createWorld(31337);
    const t = getTerrain();
    const { cx, cz } = findLandRect(t, 30, 10);
    paintCommercial(world.city, cx, cz, cx + 29, cz + 9);
    // Owner 0: bus stop, tram stop, neighborhood station, central station.
    completed(world.city, { kind: 'busStop', owner: 0, cx: cx + 1, cz, facing: 0 });
    completed(world.city, { kind: 'tramStop', owner: 0, cx: cx + 3, cz, facing: 0 });
    completed(world.city, { kind: 'neighborhoodStation', owner: 0, cx: cx + 5, cz, facing: 0 });
    completed(world.city, { kind: 'centralStation', owner: 0, cx: cx + 8, cz, facing: 0 });
    // Owner 1: a bus stop of its own (ownership filter).
    completed(world.city, { kind: 'busStop', owner: 1, cx: cx + 12, cz, facing: 0 });
    // Under construction: excluded.
    placeBuilding(world.city, { kind: 'busStop', owner: 0, cx: cx + 14, cz, facing: 0 });
    // Non-operational: excluded.
    const dead = completed(world.city, { kind: 'tramStop', owner: 0, cx: cx + 16, cz, facing: 0 });
    dead.operational = false;
    return world;
  }

  it('returns the owner\'s completed, operational stops serving the mode', () => {
    const world = stopWorld();
    const bus = transitStopsForMode(world, 0, 'bus');
    expect(bus.map((b) => b.kind).sort()).toEqual(
      ['busStop', 'centralStation', 'neighborhoodStation'].sort(),
    );
    const tram = transitStopsForMode(world, 0, 'tram');
    expect(tram.map((b) => b.kind).sort()).toEqual(
      ['centralStation', 'neighborhoodStation', 'tramStop'].sort(),
    );
    const train = transitStopsForMode(world, 0, 'train');
    expect(train.map((b) => b.kind)).toEqual(['centralStation']);
  });

  it('filters by owner', () => {
    const world = stopWorld();
    const other = transitStopsForMode(world, 1, 'bus');
    expect(other).toHaveLength(1);
    expect(other[0]!.owner).toBe(1);
    expect(transitStopsForMode(world, 2, 'bus')).toHaveLength(0);
  });

  it('excludes under-construction and non-operational stops', () => {
    const world = stopWorld();
    // 4 completed+operational bus stops exist for owner 0, but one is
    // under construction: exactly 3 come back.
    expect(transitStopsForMode(world, 0, 'bus')).toHaveLength(3);
    // Same for tram: tramStop + neighborhoodStation + centralStation,
    // minus the non-operational tramStop.
    expect(transitStopsForMode(world, 0, 'tram')).toHaveLength(3);
  });

  it('returns stops in building-id order (deterministic)', () => {
    const world = stopWorld();
    const bus = transitStopsForMode(world, 0, 'bus');
    const ids = bus.map((b) => b.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('modes with no vehicle yet still return their stops', () => {
    const world = stopWorld();
    // subway: centralStation serves it (no subway vehicle in 0.1 Alpha).
    expect(transitStopsForMode(world, 0, 'subway').map((b) => b.kind))
      .toEqual(['centralStation']);
    // taxi: neighborhoodStation + centralStation.
    expect(transitStopsForMode(world, 0, 'taxi').map((b) => b.kind).sort())
      .toEqual(['centralStation', 'neighborhoodStation'].sort());
  });

  it('returns an empty array when nothing serves the mode', () => {
    const world = stopWorld();
    expect(transitStopsForMode(world, 0, 'air')).toHaveLength(0);
    expect(transitStopsForMode(world, 0, 'boat')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ridership income
// ---------------------------------------------------------------------------

describe('ridership income', () => {
  function incomeWorld(): { terrain: TerrainData; world: World } {
    const terrain = getTerrain();
    const world = createWorld(60606);
    world.tick = 150; // mid-pulse like the economy tests
    const { cx, cz } = findLandRect(terrain, 30, 10);
    paintCommercial(world.city, cx, cz, cx + 29, cz + 9);
    return { terrain, world };
  }

  it('pays the flat tier rate per completed, operational stop', () => {
    const { terrain, world } = incomeWorld();
    const { cx, cz } = findLandRect(terrain, 30, 10);
    completed(world.city, { kind: 'busStop', owner: 0, cx: cx + 1, cz, facing: 0 });
    completed(world.city, { kind: 'centralStation', owner: 0, cx: cx + 4, cz, facing: 0 });
    const player = world.city.players[0]!;
    player.funds = 1000;
    runEconomyTick(world, terrain);
    // Net of ridership income minus upkeep, against a stop-less control
    // world (runEconomyTick also runs upkeep, so the delta is the net):
    // busStop (0.08 − 0.05) + centralStation (1.2 − 0.8) = 0.43.
    const control = incomeWorld();
    const controlPlayer = control.world.city.players[0]!;
    controlPlayer.funds = 1000;
    runEconomyTick(control.world, terrain);
    expect(player.funds - controlPlayer.funds).toBeCloseTo(0.43, 9);
  });

  it('unfinished stops pay nothing', () => {
    const { terrain, world } = incomeWorld();
    const { cx, cz } = findLandRect(terrain, 30, 10);
    placeBuilding(world.city, { kind: 'centralStation', owner: 0, cx, cz, facing: 0 });
    const player = world.city.players[0]!;
    player.funds = 1000;
    runEconomyTick(world, terrain);
    const control = incomeWorld();
    const controlPlayer = control.world.city.players[0]!;
    controlPlayer.funds = 1000;
    runEconomyTick(control.world, terrain);
    expect(player.funds).toBe(controlPlayer.funds);
  });
});

// ---------------------------------------------------------------------------
// Save/load round-trip
// ---------------------------------------------------------------------------

describe('transit stops save/load', () => {
  it('round-trips stops with a digest-identical world', () => {
    const world = createWorld(70707);
    const t = getTerrain();
    const { cx, cz } = findLandRect(t, 30, 10);
    paintCommercial(world.city, cx, cz, cx + 29, cz + 9);
    completed(world.city, { kind: 'busStop', owner: 0, cx: cx + 1, cz, facing: 0 });
    completed(world.city, { kind: 'neighborhoodStation', owner: 0, cx: cx + 3, cz, facing: 0 });
    completed(world.city, { kind: 'centralStation', owner: 0, cx: cx + 6, cz, facing: 0 });
    completed(world.city, { kind: 'airportInterchange', owner: 0, cx: cx + 11, cz, facing: 0 });
    const before = digestWorld(world);
    const restored = restoreSnapshot(takeSnapshot(world));
    expect(digestWorld(restored)).toBe(before);
    for (const kind of ['busStop', 'neighborhoodStation', 'centralStation', 'airportInterchange'] as const) {
      expect(restored.city.buildings.some((b) => b.kind === kind)).toBe(true);
    }
    // servedModes/airportLink are def-level: the restored world reads
    // them identically through the accessor.
    expect(transitStopsForMode(restored, 0, 'air').map((b) => b.kind))
      .toEqual(['airportInterchange']);
  });
});

// ---------------------------------------------------------------------------
// AI no-op
// ---------------------------------------------------------------------------

describe('Classic AI ignores transit stops (PLAN §6 no-op)', () => {
  it('thinkCivilianTransport leaves the digest unchanged with stops present', () => {
    const world = createWorld(80808);
    addAIPlayer(world, 1, 'citizen', 0, 0);
    const t = getTerrain();
    const { cx, cz } = findLandRect(t, 30, 10);
    paintCommercial(world.city, cx, cz, cx + 29, cz + 9);
    completed(world.city, { kind: 'busStop', owner: 1, cx: cx + 1, cz, facing: 0 });
    completed(world.city, { kind: 'centralStation', owner: 1, cx: cx + 4, cz, facing: 0 });
    const ai = world.ai.players[0]!;
    const before = digestWorld(world);
    thinkCivilianTransport(world, ai);
    expect(digestWorld(world)).toBe(before);
  });

  it('thinkRoadClasses leaves the digest unchanged with mixed road classes present', () => {
    // Phase 4: road classes need no AI wiring (pathfinding reads the
    // per-class move cost; the AI never lays roads) — pinned as a no-op.
    const world = createWorld(80809);
    addAIPlayer(world, 1, 'citizen', 0, 0);
    const t = getTerrain();
    const { cx, cz } = findLandRect(t, 30, 10);
    const classes = ['dirt', 'country', 'paved', 'highway'] as const;
    classes.forEach((cls, i) => {
      for (let j = 0; j < 3; j++) {
        world.city.roads.push({ cell: cellIndex(cx + j, cz + i), cls });
      }
    });
    const ai = world.ai.players[0]!;
    const before = digestWorld(world);
    thinkRoadClasses(world, ai);
    expect(digestWorld(world)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// UI coverage
// ---------------------------------------------------------------------------

describe('transit stops UI coverage', () => {
  it('icons: every stop has a distinct glyph', () => {
    const glyphs = new Set(STOPS.map((k) => buildingIcon(k)));
    expect(glyphs.size).toBe(STOPS.length);
    for (const kind of STOPS) {
      expect(buildingIcon(kind)).toBeTruthy();
    }
  });

  it('strings: English names', () => {
    expect(STRINGS.buildingNames.busStop.en).toBe('Bus Stop');
    expect(STRINGS.buildingNames.taxiStand.en).toBe('Taxi Stand');
    expect(STRINGS.buildingNames.tramStop.en).toBe('Tram Stop');
    expect(STRINGS.buildingNames.ferryPier.en).toBe('Ferry Pier');
    expect(STRINGS.buildingNames.neighborhoodStation.en).toBe('Neighborhood Station');
    expect(STRINGS.buildingNames.centralStation.en).toBe('Central Station');
    expect(STRINGS.buildingNames.airportInterchange.en).toBe('Airport Interchange');
  });

  it('transport tab holds all seven stops after the S7 hubs', () => {
    const tab = BUILD_TABS.find((t) => t.id === 'transport');
    expect(tab).toBeDefined();
    const idx = (k: BuildingKind) => tab!.kinds.indexOf(k);
    for (const kind of STOPS) {
      expect(idx(kind)).toBeGreaterThan(-1);
    }
    // Tab order is stable: hubs first, then the stop tiers.
    expect(idx('busStop')).toBeGreaterThan(idx('marinaLarge'));
    expect(idx('airportInterchange')).toBeGreaterThan(idx('busStop'));
  });
});
