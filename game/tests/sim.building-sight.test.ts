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
 * NOVATERRA — tests/sim.building-sight.test.ts — per-building sight
 * (2026-10-05, Fix 1).
 *
 * Covers:
 *  - `BuildingDef.sight`: the per-kind vision radius in city cells
 *    (houses ~8, industrial ~12, default 14, towers/sensor-ish ~20) —
 *    and that intel buildings keep their detection/radar radii;
 *  - `buildingSightCoverage` appends a sight disc for every completed,
 *    operational, unsabotaged building (radius `sight * CELL_WORLD_SIZE`
 *    world units), gated like the SIGINT/radar terms;
 *  - a building grants real vision: `getVisibleEnemies` sees enemies
 *    inside the disc and the fog rasterizer marks its cells;
 *  - the perception-hash fix: a (+17,-31) unit move no longer collides
 *    the old lossy sum, so the explored fold is not skipped forever;
 *  - AI symmetry: AI-owned buildings reveal for AI perception through
 *    the same `getSightDiscs` the player fog uses.
 *
 * No RNG is used anywhere in this file — pure geometry, so every test
 * is deterministic by construction.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { spawnUnit } from '../src/sim/units';
import {
  BUILDING_DEFS,
  CELL_WORLD_SIZE,
  DEFAULT_BUILDING_SIGHT_CELLS,
  buildingCenterWorld,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import { buildingSightCoverage } from '../src/sim/intel';
import { getSightDiscs, getVisibleEnemies } from '../src/sim/ai';
import { computeVisibleCells, fogCellIndex, isExplored, updateFog } from '../src/sim/fog';
import { completeBuilding } from './sim.roster-fixtures';

function setup(): World {
  return createWorld(20261005);
}

/** Place a completed, operational building and return its record. */
function place(world: World, kind: BuildingKind, owner: number, cx: number, cz: number): BuildingRecord {
  completeBuilding(world, kind, owner, cx, cz);
  const b = world.city.buildings[world.city.buildings.length - 1];
  if (!b || b.kind !== kind) throw new Error(`place failed for ${kind}`);
  return b;
}

// ---------------------------------------------------------------------------
// BuildingDef.sight: the per-kind scale
// ---------------------------------------------------------------------------

describe('BuildingDef.sight', () => {
  it('carries the documented per-kind scale (default 14)', () => {
    expect(DEFAULT_BUILDING_SIGHT_CELLS).toBe(14);
    // Houses / residential see the least.
    expect(BUILDING_DEFS.house.sight).toBe(8);
    expect(BUILDING_DEFS.apartment.sight).toBe(8);
    // Factories / industrial.
    expect(BUILDING_DEFS.factory.sight).toBe(12);
    expect(BUILDING_DEFS.farm.sight).toBe(12);
    expect(BUILDING_DEFS.munitionsFactory.sight).toBe(12);
    // Power plants ride the default.
    expect(BUILDING_DEFS.powerPlant.sight).toBeUndefined();
    expect(BUILDING_DEFS.nuclearPlant.sight).toBeUndefined();
    // Towers / sensor-ish see the farthest.
    expect(BUILDING_DEFS.controlTower.sight).toBe(20);
    expect(BUILDING_DEFS.waterTower.sight).toBe(20);
    expect(BUILDING_DEFS.satelliteUplink.sight).toBe(20);
  });

  it('intel buildings keep their detection/radar radii', () => {
    expect(BUILDING_DEFS.listeningPost.detectionRadius).toBe(60);
    expect(BUILDING_DEFS.signalsStation.detectionRadius).toBe(45);
    expect(BUILDING_DEFS.radarStation.radarRadius).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// buildingSightCoverage: the per-building disc + its gate
// ---------------------------------------------------------------------------

describe('buildingSightCoverage per-building sight', () => {
  it('appends a sight disc for a completed, operational, unsabotaged building', () => {
    const world = setup();
    const house = place(world, 'house', 0, 10, 10);
    const coverage = buildingSightCoverage(world, 0);
    expect(coverage).toHaveLength(1);
    const c = buildingCenterWorld(house);
    expect(coverage[0]?.x).toBe(c.x);
    expect(coverage[0]?.z).toBe(c.z);
    // 8 cells × 2 world units/cell.
    expect(coverage[0]?.radius).toBe(8 * CELL_WORLD_SIZE);
  });

  it('falls back to the 14-cell default when the def sets no sight', () => {
    const world = setup();
    place(world, 'powerPlant', 0, 10, 10);
    const coverage = buildingSightCoverage(world, 0);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]?.radius).toBe(DEFAULT_BUILDING_SIGHT_CELLS * CELL_WORLD_SIZE);
  });

  it('the completed + operational + unsabotaged gate: a dark building is blind', () => {
    const world = setup();
    const b = place(world, 'house', 0, 10, 10);
    expect(buildingSightCoverage(world, 0)).toHaveLength(1);
    // Still under construction: no vision.
    b.progress = 0.5;
    expect(buildingSightCoverage(world, 0)).toHaveLength(0);
    b.progress = 1;
    // Sabotaged: no vision.
    b.sabotagedUntil = world.tick + 1000;
    expect(buildingSightCoverage(world, 0)).toHaveLength(0);
    b.sabotagedUntil = 0;
    // Shut down: no vision.
    b.operational = false;
    expect(buildingSightCoverage(world, 0)).toHaveLength(0);
  });

  it('a building grants real vision: enemies inside the disc are seen', () => {
    const world = setup();
    const house = place(world, 'house', 0, 10, 10);
    const c = buildingCenterWorld(house);
    // House sight: 8 cells = 16 world units. No units of owner 0 — the
    // building term alone must carry it.
    const near = spawnUnit(world, 'rifles', 1, c.x + 15, c.z);
    const far = spawnUnit(world, 'rifles', 1, c.x + 17, c.z);
    const ids = getVisibleEnemies(world, 0).map((u) => u.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
  });

  it('the fog rasterizer marks the building cells visible', () => {
    const world = setup();
    const house = place(world, 'house', 0, 10, 10);
    const c = buildingCenterWorld(house);
    const vis = computeVisibleCells(world, 0);
    expect(vis[fogCellIndex(c.x, c.z)]).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// perceptionHash: the (+17,-31) collision is gone
// ---------------------------------------------------------------------------

describe('perceptionHash', () => {
  it('a (+17,-31) move changes the hash, so the explored fold is not skipped', () => {
    const world = setup();
    const u = spawnUnit(world, 'tank', 0, 0, 0); // sight 26
    const cache = new Map<number, string>();
    updateFog(world, cache);
    // (37,-31): its fog cell center (36,-28) is ~19.2 wu from (17,-31)
    // (inside tank sight 26) but ~45.6 wu from (0,0) (outside).
    expect(isExplored(world, 0, 37, -31)).toBe(false);
    // The old lossy sum (round(x)*31 + round(z)*17) was unchanged by
    // this exact move (17*31 - 31*17 = 0) and skipped the fold forever.
    u.x = 17;
    u.z = -31;
    updateFog(world, cache);
    expect(isExplored(world, 0, 37, -31)).toBe(true);
  });

  it('sabotage flips the hash (the old count stayed put and went stale)', () => {
    const world = setup();
    place(world, 'house', 0, 10, 10);
    const cache = new Map<number, string>();
    updateFog(world, cache);
    const b = world.city.buildings[world.city.buildings.length - 1];
    if (!b) throw new Error('no building');
    // Sabotaging the only vision source must change perception inputs.
    b.sabotagedUntil = world.tick + 1000;
    const before = cache.get(0);
    updateFog(world, cache);
    expect(cache.get(0)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AI symmetry: AI buildings reveal for AI perception
// ---------------------------------------------------------------------------

describe('AI building sight symmetry', () => {
  it('AI-owned buildings reveal for AI perception via getSightDiscs', () => {
    const world = setup();
    const house = place(world, 'house', 1, 10, 10);
    const discs = getSightDiscs(world, 1);
    if (discs === null) throw new Error('expected sight discs for the AI');
    const c = buildingCenterWorld(house);
    const houseDisc = discs.coverage.find((d) => d.x === c.x && d.z === c.z);
    expect(houseDisc?.radius).toBe((BUILDING_DEFS.house.sight ?? DEFAULT_BUILDING_SIGHT_CELLS) * CELL_WORLD_SIZE);
    // End to end: a player unit inside the AI house's sight is visible
    // to the AI with no AI units on the map.
    const seen = spawnUnit(world, 'rifles', 0, c.x + 10, c.z);
    const hidden = spawnUnit(world, 'rifles', 0, c.x + 30, c.z);
    const ids = getVisibleEnemies(world, 1).map((u) => u.id);
    expect(ids).toContain(seen.id);
    expect(ids).not.toContain(hidden.id);
  });
});
