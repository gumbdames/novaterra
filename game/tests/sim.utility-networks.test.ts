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
 * Utility networks (grand expansion, Phase 2): the integer BFS flood
 * fill over conductor tiles that replaces the Phase-1 capacity pool
 * (AD1), with the AD2 pool fallback for unreached buildings.
 *
 * These tests drive runEconomyTick directly (one call = one sim-second)
 * with hand-built cities: roads / power lines / pipes laid directly,
 * buildings placed directly. Command-level validation (costs, limits,
 * gates) lives in sim.utility-plants.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  type TerrainData,
} from '../src/sim/terrain';
import {
  ZoneType,
  bumpUtilityEpoch,
  cellIndex,
  cellIsWater,
  placeBuilding,
  type BuildingKind,
  type BuildingRecord,
  type CityState,
} from '../src/sim/city';
import { runEconomyTick, ECONOMY_TICKS } from '../src/sim/economy';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import {
  daylightFactor,
  windFactor,
  meltdownOffline,
  getUtilityModel,
  getNetworkStock,
  POWER_EXPORT_FUNDS_PER_UNIT,
} from '../src/sim/utilityNetworks';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function setup(seed = 20260930): { terrain: TerrainData; world: World } {
  const terrain = getTerrain();
  const world = createWorld(seed);
  // Rich players: upkeep funding never binds in these tests.
  world.city.players[0]!.funds = 1e9;
  world.city.players[0]!.materials = 1e9;
  world.city.players[1]!.funds = 1e9;
  world.city.players[1]!.materials = 1e9;
  return { terrain, world };
}

/** One economy second per iteration, from tick 0. */
function runSeconds(world: World, terrain: TerrainData, seconds: number): void {
  for (let s = 0; s < seconds; s++) {
    world.tick += ECONOMY_TICKS;
    world.time = world.tick / ECONOMY_TICKS;
    runEconomyTick(world, terrain);
  }
}

/** Directly place a completed building (bypasses command validation). */
function completed(
  world: World,
  kind: BuildingKind,
  owner: number,
  cx: number,
  cz: number,
): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  return b;
}

/** Directly lay conductor cells (bypasses command validation/cost). */
function lay(
  city: CityState,
  field: 'roads' | 'powerLines' | 'pipes',
  cells: number[],
): void {
  const arr = city[field];
  for (const c of cells) {
    if (!arr.includes(c)) arr.push(c);
  }
  arr.sort((a, b) => a - b);
  bumpUtilityEpoch(city);
}

/** Horizontal run of cells. */
function row(cx0: number, cz: number, len: number): number[] {
  const cells: number[] = [];
  for (let i = 0; i < len; i++) cells.push(cellIndex(cx0 + i, cz));
  return cells;
}

/** Directly paint a zone rectangle (bypasses the command). */
function paint(
  city: CityState,
  zone: ZoneType,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone });
    }
  }
  city.zones.sort((a, b) => a.cell - b.cell);
  bumpUtilityEpoch(city);
}

function findLandRect(
  t: TerrainData,
  w: number,
  h: number,
): { cx: number; cz: number } {
  // Avoid the map edge: edge-touching conductors would trigger (or
  // suppress) map-edge trade and pollute the test.
  for (let cz = 1; cz + h <= 255; cz++) {
    for (let cx = 1; cx + w <= 255; cx++) {
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

// ---------------------------------------------------------------------------
// Flood fill + reached rule
// ---------------------------------------------------------------------------

describe('utility flood fill', () => {
  it('serves buildings adjacent to a road network', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 40));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    const pump = completed(world, 'waterPump', 0, cx + 6, rz + 1);
    const h1 = completed(world, 'house', 0, cx + 10, rz - 2);
    const h2 = completed(world, 'house', 0, cx + 13, rz + 1);
    const h3 = completed(world, 'house', 0, cx + 16, rz - 2);
    runSeconds(world, terrain, 3);
    // Power demand 3*1 + 2 = 5 <= 25; water demand 3*1 + 2 = 5 <= 25.
    for (const b of [plant, pump, h1, h2, h3]) {
      expect(b.powered).toBe(true);
      expect(b.watered).toBe(true);
      expect(b.powerDiag).toBe('ok');
      expect(b.waterDiag).toBe('ok');
    }
  });

  it('reaches across a power line with no road (long-hop)', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 60, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 8));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    // House 30 cells east, hooked up by a power line across wilderness.
    // (cx+35: its footprint must orthogonally touch a line cell.)
    lay(world.city, 'powerLines', row(cx + 8, rz, 30));
    const far = completed(world, 'house', 0, cx + 35, rz - 2);
    runSeconds(world, terrain, 2);
    expect(far.powered).toBe(true);
    expect(far.powerDiag).toBe('ok');
    expect(plant.powerDiag).toBe('ok');
  });

  it('conducts through substation and pumping-station footprints', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 14);
    const rz = cz + 7;
    lay(world.city, 'roads', row(cx, rz, 12));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    const pump = completed(world, 'waterPump', 0, cx + 1, rz + 1);
    // Substation touches the road; the power house touches ONLY the
    // substation (3 cells from any road/line). Same for water with the
    // pumping station on the other side.
    completed(world, 'powerSubstation', 0, cx + 6, rz - 2);
    completed(world, 'pumpingStation', 0, cx + 6, rz + 1);
    const hPower = completed(world, 'house', 0, cx + 6, rz - 4);
    const hWater = completed(world, 'house', 0, cx + 6, rz + 3);
    runSeconds(world, terrain, 2);
    // Power flows road -> substation -> house; water cannot (the
    // substation conducts power only).
    expect(hPower.powered).toBe(true);
    expect(hPower.powerDiag).toBe('ok');
    expect(hPower.watered).toBe(false);
    expect(hPower.waterDiag).toBe('disconnected');
    // Water flows road -> pumping station -> house; power cannot.
    expect(hWater.watered).toBe(true);
    expect(hWater.waterDiag).toBe('ok');
    expect(hWater.powered).toBe(false);
    expect(hWater.powerDiag).toBe('disconnected');
    expect(plant.powerDiag).toBe('ok');
    expect(pump.waterDiag).toBe('ok');
  });

  it('serves buildings inside a served zone region (underground pipes)', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 12);
    const rz = cz + 5;
    // Road touches only the first columns of the zone region.
    lay(world.city, 'roads', row(cx, rz, 4));
    paint(world.city, ZoneType.RESIDENTIAL, cx, cz + 2, cx + 9, cz + 4);
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz + 1);
    // House deep inside the region, 4+ cells from any road cell.
    const deep = completed(world, 'house', 0, cx + 7, cz + 2);
    // Control: same distance from the road but on unzoned land.
    const far = completed(world, 'house', 0, cx + 20, cz + 2);
    runSeconds(world, terrain, 5);
    expect(deep.powered).toBe(true);
    expect(deep.powerDiag).toBe('ok');
    expect(far.powered).toBe(false);
    expect(far.powerDiag).toBe('disconnected');
    expect(plant.powerDiag).toBe('ok');
  });

  it('keeps networks isolated: supply never leaks across components', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 24);
    const rz1 = cz + 5;
    const rz2 = cz + 18;
    lay(world.city, 'roads', row(cx, rz1, 30));
    lay(world.city, 'roads', row(cx, rz2, 30));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz1 - 3);
    const f1 = completed(world, 'factory', 0, cx + 6, rz1 - 3);
    const f2 = completed(world, 'factory', 0, cx + 11, rz1 + 1);
    // Three factories on the plant-less road: no network, no pool.
    const g1 = completed(world, 'factory', 0, cx + 6, rz2 - 3);
    const g2 = completed(world, 'factory', 0, cx + 11, rz2 + 1);
    const g3 = completed(world, 'factory', 0, cx + 16, rz2 - 3);
    runSeconds(world, terrain, 2);
    expect(f1.powered).toBe(true);
    expect(f2.powered).toBe(true);
    expect(f1.powerDiag).toBe('ok');
    for (const g of [g1, g2, g3]) {
      expect(g.powered).toBe(false);
      expect(g.powerDiag).toBe('disconnected');
    }
    expect(plant.powerDiag).toBe('ok');
  });

  it('allocates within a network in (distance, building id) order', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 80, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 70));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    // Six factories (demand 5 each = 30 > 25): the five nearest draw.
    const factories: BuildingRecord[] = [];
    for (let i = 0; i < 6; i++) {
      factories.push(completed(world, 'factory', 0, cx + 8 + i * 8, rz - 3));
    }
    runSeconds(world, terrain, 2);
    const powered = factories.filter((f) => f.powered);
    expect(powered).toHaveLength(5);
    // The farthest-placed (largest distance, largest id) is the one out.
    expect(factories[5]!.powered).toBe(false);
    expect(factories[5]!.powerDiag).toBe('shortage');
    for (let i = 0; i < 5; i++) {
      expect(factories[i]!.powerDiag).toBe('ok');
    }
    expect(plant.powerDiag).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// AD2 pool fallback
// ---------------------------------------------------------------------------

describe('AD2 pool fallback', () => {
  it('serves unreached buildings from a stranded plant (legacy behavior)', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 60, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 10));
    // Plant and house far from every conductor: no networks exist.
    const plant = completed(world, 'powerPlant', 0, cx + 20, cz + 1);
    const house = completed(world, 'house', 0, cx + 30, cz + 1);
    runSeconds(world, terrain, 2);
    // The stranded plant flags itself but still feeds the pool.
    expect(plant.powerDiag).toBe('disconnected');
    expect(house.powered).toBe(true);
    expect(house.powerDiag).toBe('ok');
    // No water anywhere: honest flags.
    expect(house.watered).toBe(false);
    expect(house.waterDiag).toBe('disconnected');
  });

  it('keeps id-order allocation on pool shortage', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 60, 16);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 10));
    const plant = completed(world, 'powerPlant', 0, cx + 20, cz + 8);
    // 30 unreached houses, demand 30 > supply 25: first 25 in id order.
    const houses: BuildingRecord[] = [];
    for (let i = 0; i < 30; i++) {
      houses.push(
        completed(world, 'house', 0, cx + 20 + (i % 10) * 3, cz + 11 + Math.floor(i / 10) * 3),
      );
    }
    runSeconds(world, terrain, 2);
    for (let i = 0; i < 25; i++) {
      expect(houses[i]!.powered).toBe(true);
      expect(houses[i]!.powerDiag).toBe('ok');
    }
    for (let i = 25; i < 30; i++) {
      expect(houses[i]!.powered).toBe(false);
      expect(houses[i]!.powerDiag).toBe('disconnected');
    }
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe('network storage', () => {
  it('charges on surplus and discharges into deficit', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 80, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 70));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    const battery = completed(world, 'batteryStation', 0, cx + 5, rz + 1);
    const near: BuildingRecord[] = [];
    for (let i = 0; i < 3; i++) {
      near.push(completed(world, 'factory', 0, cx + 10 + i * 8, rz - 3));
    }
    // Phase 1: demand 3*5 = 15 < 25 -> surplus 10/s charges the battery.
    runSeconds(world, terrain, 10);
    // Phase 2: three more factories push demand to 30 > 25 (deficit 5/s).
    const far: BuildingRecord[] = [];
    for (let i = 0; i < 3; i++) {
      far.push(completed(world, 'factory', 0, cx + 34 + i * 8, rz - 3));
    }
    runSeconds(world, terrain, 5);
    // Stock (100 - 25 = 75) covers the deficit: everything still served.
    for (const f of [...near, ...far]) {
      expect(f.powered).toBe(true);
      expect(f.powerDiag).toBe('ok');
    }
    expect(battery.powered).toBe(true);
    // Phase 3: run the stock dry (75 / 5 per s = 15 s); the farthest
    // factory drops out with a shortage flag.
    runSeconds(world, terrain, 20);
    const all = [...near, ...far];
    const poweredFactories = all.filter((f) => f.powered);
    expect(poweredFactories).toHaveLength(5);
    expect(far[2]!.powered).toBe(false);
    expect(far[2]!.powerDiag).toBe('shortage');
    expect(battery.powered).toBe(true);
    expect(plant.powerDiag).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Map-edge trade
// ---------------------------------------------------------------------------

describe('map-edge trade', () => {
  it('auto-sells surplus power at the map edge', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 30));
    // Power line from the road to the map edge (cx === 0).
    lay(world.city, 'powerLines', row(0, rz, cx));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    const house = completed(world, 'house', 0, cx + 10, rz - 2);
    const player = world.city.players[0]!;
    const before = player.funds;
    runSeconds(world, terrain, 10);
    // Surplus 24/s at 0.1 funds/unit/s, minus upkeep (0.8 + 0.15)/s.
    // (Precision 4: the per-tick export accumulates float dust.)
    const expected = 10 * (24 * POWER_EXPORT_FUNDS_PER_UNIT - 0.95);
    expect(player.funds - before).toBeCloseTo(expected, 4);
    expect(plant.powerDiag).toBe('ok');
  });

  it('does not export when the network touches no edge', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 30));
    completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    completed(world, 'house', 0, cx + 10, rz - 2);
    const player = world.city.players[0]!;
    const before = player.funds;
    runSeconds(world, terrain, 10);
    // Only upkeep is charged; surplus is curtailed, not sold.
    // (Precision 4: the per-tick charges accumulate float dust.)
    expect(player.funds - before).toBeCloseTo(-0.95 * 10, 4);
  });
});

// ---------------------------------------------------------------------------
// Pure time/weather helpers
// ---------------------------------------------------------------------------

describe('daylight and wind', () => {
  it('daylightFactor follows the 240-second day', () => {
    expect(daylightFactor(0)).toBe(0); // dawn
    expect(daylightFactor(1800)).toBe(1); // noon (tick 1800 = 60 s)
    expect(daylightFactor(3600)).toBeCloseTo(0, 12); // dusk
    expect(daylightFactor(5400)).toBe(0); // midnight
    expect(daylightFactor(1800 + 30 * 240)).toBe(1); // next noon
  });

  it('windFactor stays in [0.3, 1.0] and is deterministic', () => {
    for (const seed of [1, 42, 20260930]) {
      for (let e = 0; e < 300; e++) {
        const w = windFactor(seed, e);
        expect(w).toBeGreaterThanOrEqual(0.3);
        expect(w).toBeLessThanOrEqual(1.0);
        expect(windFactor(seed, e)).toBe(w);
      }
    }
    // It actually varies (not a constant).
    const vals = new Set<number>();
    for (let e = 0; e < 300; e++) vals.add(windFactor(42, e));
    expect(vals.size).toBeGreaterThan(10);
  });

  it('solar farms produce only in daylight', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 30));
    const solar = completed(world, 'solarFarm', 0, cx + 1, rz - 3);
    const house = completed(world, 'house', 0, cx + 10, rz - 2);
    // Dawn: reached by the solar network but ~zero supply -> shortage.
    world.tick = 0;
    runSeconds(world, terrain, 1);
    expect(house.powered).toBe(false);
    expect(house.powerDiag).toBe('shortage');
    // Noon (tick 1800): full 15 output serves the house.
    world.tick = 1770;
    runSeconds(world, terrain, 1);
    expect(house.powered).toBe(true);
    expect(house.powerDiag).toBe('ok');
    expect(solar.powerDiag).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Determinism, caching, save/load
// ---------------------------------------------------------------------------

describe('determinism and caching', () => {
  function buildCity(order: 'roads-first' | 'buildings-first'): number {
    const { terrain, world } = setup(777);
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    const roads = row(cx, rz, 40);
    const placements: Array<[BuildingKind, number, number]> = [
      ['powerPlant', cx + 1, rz - 3],
      ['waterPump', cx + 6, rz + 1],
      ['house', cx + 10, rz - 2],
      ['house', cx + 13, rz + 1],
      ['shop', cx + 16, rz - 2],
    ];
    if (order === 'roads-first') {
      lay(world.city, 'roads', roads);
      for (const [kind, px, pz] of placements) completed(world, kind, 0, px, pz);
    } else {
      for (const [kind, px, pz] of placements) completed(world, kind, 0, px, pz);
      lay(world.city, 'roads', roads);
    }
    runSeconds(world, terrain, 20);
    return digestWorld(world);
  }

  it('is independent of construction order', () => {
    expect(buildCity('roads-first')).toBe(buildCity('buildings-first'));
  });

  it('replays identically from the same seed', () => {
    expect(buildCity('roads-first')).toBe(buildCity('roads-first'));
  });

  it('caches the derived model until the epoch or online set changes', () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 30));
    const plant = completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    completed(world, 'house', 0, cx + 10, rz - 2);
    // NB: the input must match what the economy tick computes, or the
    // key differs and the cache (correctly) misses. The powerPlant is a
    // fouling kind, so it joins the economy's fouler list.
    const input = {
      power: [[plant.id], []],
      water: [[], []],
      foulers: [plant.id],
      treatments: [] as number[],
    };
    const m1 = getUtilityModel(world.city, input);
    const m2 = getUtilityModel(world.city, input);
    expect(m2).toBe(m1); // cache hit: identical object
    runSeconds(world, terrain, 3);
    const m3 = getUtilityModel(world.city, input);
    expect(m3).toBe(m1); // economy ticks alone never rebuild
    lay(world.city, 'powerLines', row(cx, rz + 3, 5));
    const m4 = getUtilityModel(world.city, input);
    expect(m4).not.toBe(m1); // structural change rebuilds
    expect(m4.epoch).toBe(world.city.utilityEpoch);
  });

  it('survives save/load with identical re-simulation', () => {
    const { terrain, world } = setup(4242);
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 40));
    completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    completed(world, 'waterPump', 0, cx + 6, rz + 1);
    completed(world, 'house', 0, cx + 10, rz - 2);
    completed(world, 'house', 0, cx + 13, rz + 1);
    runSeconds(world, terrain, 10);
    const snap = takeSnapshot(world);
    const json = JSON.parse(JSON.stringify(snap));
    const restored = restoreSnapshot(json);
    runSeconds(world, terrain, 10);
    runSeconds(restored, terrain, 10);
    expect(digestWorld(restored)).toBe(digestWorld(world));
  });

  it("decodes legacy v6 saves without utility fields (AD9 defaults)", () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 40, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 30));
    completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    completed(world, 'house', 0, cx + 10, rz - 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap = JSON.parse(JSON.stringify(takeSnapshot(world))) as any;
    delete snap.city.powerLines;
    delete snap.city.pipes;
    delete snap.city.utilityEpoch;
    for (const b of snap.city.buildings) {
      delete b.powerDiag;
      delete b.waterDiag;
    }
    const restored = restoreSnapshot(snap);
    expect(restored.city.powerLines).toEqual([]);
    expect(restored.city.pipes).toEqual([]);
    expect(restored.city.utilityEpoch).toBe(0);
    for (const b of restored.city.buildings) {
      expect(b.powerDiag).toBe('disconnected');
      expect(b.waterDiag).toBe('disconnected');
    }
    // The restored world still simulates: diags recompute on the model.
    runSeconds(restored, terrain, 2);
    const plant = restored.city.buildings.find((b) => b.kind === 'powerPlant')!;
    const house = restored.city.buildings.find((b) => b.kind === 'house')!;
    expect(plant.powerDiag).toBe('ok');
    expect(house.powerDiag).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Two-player isolation
// ---------------------------------------------------------------------------

describe('player isolation', () => {
  it("one player's grid never powers the other's buildings", () => {
    const { terrain, world } = setup();
    const { cx, cz } = findLandRect(terrain, 60, 10);
    const rz = cz + 5;
    lay(world.city, 'roads', row(cx, rz, 50));
    completed(world, 'powerPlant', 0, cx + 1, rz - 3);
    // Rival house adjacent to the SAME road: still unpowered —
// networks are per player.
    const rival = completed(world, 'house', 1, cx + 10, rz - 2);
    const mine = completed(world, 'house', 0, cx + 14, rz - 2);
    runSeconds(world, terrain, 2);
    expect(mine.powered).toBe(true);
    expect(rival.powered).toBe(false);
    expect(rival.powerDiag).toBe('disconnected');
  });
});

// ---------------------------------------------------------------------------
// Performance: flood-fill cost at city scale
// ---------------------------------------------------------------------------

describe('flood-fill performance', () => {
  it('runs the economy tick with 600 buildings on a road grid in budget', () => {
    const { terrain, world } = setup(4242);
    // A road grid: horizontal roads every 8 rows, buildings adjacent.
    for (let rz = 4; rz < 256; rz += 8) {
      const cells: number[] = [];
      for (let cx = 0; cx < 256; cx++) cells.push(cellIndex(cx, rz));
      lay(world.city, 'roads', cells);
    }
    const kinds: BuildingKind[] = [
      'powerPlant',
      'waterPump',
      'factory',
      'factory',
      'house',
      'house',
      'shop',
    ];
    let placed = 0;
    for (let rz = 4; rz < 256 && placed < 600; rz += 8) {
      for (let cx = 0; cx + 4 < 256 && placed < 600; cx += 4) {
        const kind = kinds[placed % kinds.length]!;
        // Skip water cells (placeBuilding would reject).
        let ok = true;
        for (let dz = 0; dz < 2 && ok; dz++) {
          for (let dx = 0; dx < 2 && ok; dx++) {
            if (cellIsWater(terrain, cx + dx, rz - 2 + dz)) ok = false;
          }
        }
        if (!ok) continue;
        const b = placeBuilding(world.city, {
          kind,
          owner: placed % 2,
          cx,
          cz: rz - 2,
          facing: 0,
        });
        b.progress = 1;
        placed++;
      }
    }
    expect(placed).toBe(600);
    // Warm up (JIT, model cache).
    runSeconds(world, terrain, 2);
    const N = 30;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      world.tick += ECONOMY_TICKS;
      world.time = world.tick / ECONOMY_TICKS;
      runEconomyTick(world, terrain);
    }
    const avgMs = (performance.now() - t0) / N;
    console.log(
      `[perf] runEconomyTick (flood-fill) with 600 buildings: avg ${avgMs.toFixed(2)}ms over ${N} ticks`,
    );
    // Generous tripwire: catches an accidental O(n^2) without flaking.
    expect(avgMs, `economy tick took ${avgMs.toFixed(2)}ms`).toBeLessThan(250);
  });
});

// ---------------------------------------------------------------------------
// Meltdown pure function
// ---------------------------------------------------------------------------

describe('meltdownOffline', () => {  it('is a deterministic function of (seed, id, tick)', () => {
    for (const [seed, id, e] of [
      [1, 1, 0],
      [6855, 1, 5],
      [12345, 999, 777],
    ] as Array<[number, number, number]>) {
      expect(meltdownOffline(seed, id, e)).toBe(meltdownOffline(seed, id, e));
    }
  });

  it('triggers with a tiny denominator and never with a huge one', () => {
    let hits = 0;
    for (let e = 0; e < 200; e++) {
      if (meltdownOffline(42, 7, e, 7)) hits++;
      expect(meltdownOffline(42, 7, e, 2147483647)).toBe(false);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('advancedNuclear (x4 denominator) triggers a subset of meltdowns', () => {
    const seed = 999;
    const id = 3;
    let base = 0;
    let reduced = 0;
    let reducedNotBase = 0;
    for (let e = 0; e < 200000; e += 7) {
      const b = meltdownOffline(seed, id, e, 20000);
      const r = meltdownOffline(seed, id, e, 80000);
      if (b) base++;
      if (r) reduced++;
      if (r && !b) reducedNotBase++;
    }
    expect(base).toBeGreaterThan(0);
    expect(reduced).toBeLessThan(base);
    expect(reducedNotBase).toBe(0);
  });
});
