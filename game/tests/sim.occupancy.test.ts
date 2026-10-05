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
 * NOVATERRA — tests/sim.occupancy.test.ts — Phase 4 per-building
 * occupancy (grand expansion, 2026-09-30): residents/workers vs
 * capacity on every building, for the selection panel.
 *
 * Design: no per-individual simulation — the economy tick fills
 * headcounts (`recomputeOccupancy` in economy.ts); the panel reads
 * them via `buildingOccupancy(world, id)`. Invariants pinned here:
 * residents = def.population when completed; workers fill jobs in
 * building-id order capped by the owner's population; Σresidents ==
 * player.population; Σworkers <= player.population.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  buildingOccupancy,
  getPlayer,
  placeBuilding,
  type BuildingRecord,
} from '../src/sim/city';
import { runEconomyTick } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** A completed, operational building placed without validation (test-only). */
function built(world: World, kind: keyof typeof BUILDING_DEFS, owner: number): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx: 10 + world.city.buildings.length * 5, cz: 10, facing: 0 }, world.seed);
  b.progress = 1;
  b.operational = true;
  return b;
}

function richWorld(seed = 4242): { world: World; terrain: TerrainData } {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const p = getPlayer(world.city, 0)!;
  p.funds = 1e9;
  p.materials = 1e9;
  return { world, terrain };
}

describe('per-building occupancy', () => {
  it('completed housing gets residents = def.population; construction sites get 0', () => {
    const { world, terrain } = richWorld();
    const house = built(world, 'house', 0);
    const apt = built(world, 'apartment', 0);
    const site = placeBuilding(world.city, { kind: 'house', owner: 0, cx: 60, cz: 60, facing: 0 }, world.seed);
    // Fix 3: occupancy distributes the demand pool (player.population).
    // Inject demand so the houses fill.
    getPlayer(world.city, 0)!.population = 100;
    runEconomyTick(world, terrain);
    expect(house.residents).toBe(BUILDING_DEFS.house.population); // 6
    expect(apt.residents).toBe(BUILDING_DEFS.apartment.population); // 30
    expect(site.residents).toBe(0);
    expect(site.workers).toBe(0);
    // The spillover is unhoused; the invariant holds.
    expect(getPlayer(world.city, 0)!.unhousedPopulation).toBe(100 - 6 - 30);
  });

  it('Σresidents == player.population after the tick', () => {
    const { world, terrain } = richWorld();
    built(world, 'house', 0);
    built(world, 'house', 0);
    built(world, 'apartment', 0);
    built(world, 'factory', 0); // no residents
    // Fix 3: inject the demand pool; capacity exactly covers it.
    getPlayer(world.city, 0)!.population = 6 + 6 + 30;
    runEconomyTick(world, terrain);
    const pop = getPlayer(world.city, 0)!.population;
    const sum = world.city.buildings
      .filter((b) => b.owner === 0)
      .reduce((s, b) => s + (b.residents ?? 0), 0);
    expect(pop).toBe(6 + 6 + 30);
    expect(sum).toBe(pop);
  });

  it('workers fill jobs in building-id order, capped by population', () => {
    const { world, terrain } = richWorld();
    built(world, 'house', 0); // 6 residents
    const factory = built(world, 'factory', 0); // jobs 25
    const shop = built(world, 'shop', 0); // jobs 4
    // Fix 3: inject demand so the house fills.
    getPlayer(world.city, 0)!.population = 6;
    runEconomyTick(world, terrain);
    // Population is 6: factory (lower id) takes all 6, shop gets none.
    expect(factory.workers).toBe(6);
    expect(shop.workers).toBe(0);
    const totalWorkers = world.city.buildings.reduce((s, b) => s + (b.workers ?? 0), 0);
    expect(totalWorkers).toBeLessThanOrEqual(getPlayer(world.city, 0)!.population);
  });

  it('a bigger city fills every job: workers(b) <= jobs(def)', () => {
    const { world, terrain } = richWorld();
    for (let i = 0; i < 4; i++) built(world, 'apartment', 0); // 120 residents
    const factory = built(world, 'factory', 0); // jobs 25
    const shop = built(world, 'shop', 0); // jobs 4
    // Fix 3: inject the demand pool so housing fills.
    getPlayer(world.city, 0)!.population = 120;
    runEconomyTick(world, terrain);
    expect(factory.workers).toBe(25);
    expect(shop.workers).toBe(4);
    for (const b of world.city.buildings) {
      expect(b.workers ?? 0).toBeLessThanOrEqual(BUILDING_DEFS[b.kind].jobs ?? 0);
    }
  });

  it('shut-down buildings keep residents but get no workers', () => {
    const { world, terrain } = richWorld();
    // A broke player: upkeep can't be funded, so the factory shuts down.
    const p = getPlayer(world.city, 0)!;
    p.funds = 0;
    p.materials = 1e9;
    const house = built(world, 'house', 0);
    const factory = built(world, 'factory', 0);
    // Fix 3: inject the demand pool so the house fills.
    p.population = 6;
    runEconomyTick(world, terrain);
    runEconomyTick(world, terrain);
    expect(factory.operational).toBe(false);
    expect(factory.workers).toBe(0);
    // People still live in their homes when the factory closes.
    expect(house.residents).toBe(6);
  });

  it('buildingOccupancy returns caps + actuals; null for unknown ids', () => {
    const { world, terrain } = richWorld();
    const apt = built(world, 'apartment', 0);
    const factory = built(world, 'factory', 0);
    // Fix 3: inject the demand pool so the apartment fills.
    getPlayer(world.city, 0)!.population = 30;
    runEconomyTick(world, terrain);
    const occ = buildingOccupancy(world, apt.id)!;
    expect(occ).toEqual({
      residents: 30,
      residentCap: BUILDING_DEFS.apartment.population,
      workers: 0, // apartments have no jobs
      workerCap: 0,
    });
    const focc = buildingOccupancy(world, factory.id)!;
    expect(focc.workerCap).toBe(BUILDING_DEFS.factory.jobs);
    expect(focc.workers).toBeLessThanOrEqual(focc.workerCap);
    expect(buildingOccupancy(world, 999999)).toBeNull();
  });

  it('occupancy is deterministic: same seed → same digest after ticks', () => {
    const mk = (seed: number) => {
      const { world, terrain } = richWorld(seed);
      built(world, 'house', 0);
      built(world, 'apartment', 0);
      built(world, 'factory', 0);
      for (let i = 0; i < 5; i++) runEconomyTick(world, terrain);
      return digestWorld(world);
    };
    expect(mk(777)).toBe(mk(777));
  });

  it('snapshot round-trips residents/workers/variant/sizeTier with an identical digest', () => {
    const { world, terrain } = richWorld(9001);
    built(world, 'house', 0);
    built(world, 'factory', 0);
    runEconomyTick(world, terrain);
    const before = digestWorld(world);
    const world2 = restoreSnapshot(takeSnapshot(world));
    expect(digestWorld(world2)).toBe(before);
    const b2 = world2.city.buildings.find((b) => b.kind === 'factory')!;
    const b1 = world.city.buildings.find((b) => b.kind === 'factory')!;
    expect(b2.residents).toBe(b1.residents);
    expect(b2.workers).toBe(b1.workers);
    expect(b2.variant).toBe(b1.variant);
    expect(b2.sizeTier).toBe(b1.sizeTier);
  });
});
