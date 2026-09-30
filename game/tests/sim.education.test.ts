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
 * NOVATERRA — education tests (Workstream Z).
 *
 * The education ladder: kindergarten / school / college / university are
 * UTILITY_ZONE buildings (placeable anywhere on land) that research
 * 0.1 / 0.25 / 0.5 / 1.0 per second. Each completed kindergarten or
 * school gives its owner +0.05 residential growth desirability, additive
 * and capped at +0.25.
 */
import { describe, expect, it } from 'vitest';

import { createWorld } from '../src/sim/world';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  UTILITY_ZONE,
  ZoneType,
  cellIndex,
  cellIsWater,
  educationGrowthBonus,
  placeBuilding,
  runGrowth,
  type Placement,
} from '../src/sim/city';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';

describe('education ladder definitions', () => {
  it('researches 0.1 / 0.25 / 0.5 / 1.0 per second', () => {
    expect(BUILDING_DEFS.kindergarten.output.research).toBe(0.1);
    expect(BUILDING_DEFS.school.output.research).toBe(0.25);
    expect(BUILDING_DEFS.college.output.research).toBe(0.5);
    expect(BUILDING_DEFS.university.output.research).toBe(1.0);
  });

  it('all four are UTILITY_ZONE buildings (placeable anywhere on land)', () => {
    for (const kind of ['kindergarten', 'school', 'college', 'university'] as const) {
      expect(BUILDING_DEFS[kind].zone).toBe(UTILITY_ZONE);
    }
  });

  it('the school moved off RESIDENTIAL and the university off COMMERCIAL', () => {
    expect(BUILDING_DEFS.school.zone).not.toBe(ZoneType.RESIDENTIAL);
    expect(BUILDING_DEFS.university.zone).not.toBe(ZoneType.COMMERCIAL);
  });

  it('leaves the hospital alone (still COMMERCIAL)', () => {
    expect(BUILDING_DEFS.hospital.zone).toBe(ZoneType.COMMERCIAL);
  });

  it('defines the two new buildings with exact costs', () => {
    expect(BUILDING_DEFS.kindergarten).toMatchObject({
      costFunds: 150,
      costMaterials: 50,
      buildSeconds: 12,
      minAge: 'foundation',
    });
    expect(BUILDING_DEFS.college).toMatchObject({
      costFunds: 400,
      costMaterials: 120,
      buildSeconds: 30,
      minAge: 'foundation',
    });
  });
});

describe('educationGrowthBonus', () => {
  type TestWorld = ReturnType<typeof createWorld>;

  function completed(world: TestWorld, p: Placement): void {
    const b = placeBuilding(world.city, p);
    b.progress = 1;
  }

  it('is zero with no education buildings', () => {
    const world = createWorld(7);
    expect(educationGrowthBonus(world, 0)).toBe(0);
  });

  it('adds +0.05 per completed kindergarten/school', () => {
    const world = createWorld(7);
    completed(world, { kind: 'school', owner: 0, cx: 10, cz: 10, facing: 0 });
    expect(educationGrowthBonus(world, 0)).toBeCloseTo(0.05, 12);
    completed(world, { kind: 'kindergarten', owner: 0, cx: 20, cz: 20, facing: 0 });
    expect(educationGrowthBonus(world, 0)).toBeCloseTo(0.1, 12);
  });

  it('excludes unfinished buildings', () => {
    const world = createWorld(7);
    const b = placeBuilding(world.city, {
      kind: 'school',
      owner: 0,
      cx: 10,
      cz: 10,
      facing: 0,
    });
    b.progress = 0.5; // still under construction
    expect(educationGrowthBonus(world, 0)).toBe(0);
  });

  it('excludes other owners, and colleges/universities/hospitals', () => {
    const world = createWorld(7);
    completed(world, { kind: 'school', owner: 1, cx: 10, cz: 10, facing: 0 });
    completed(world, { kind: 'college', owner: 0, cx: 20, cz: 20, facing: 0 });
    completed(world, { kind: 'university', owner: 0, cx: 30, cz: 30, facing: 0 });
    completed(world, { kind: 'hospital', owner: 0, cx: 40, cz: 40, facing: 0 });
    expect(educationGrowthBonus(world, 0)).toBe(0);
  });

  it('caps at +0.25', () => {
    const world = createWorld(7);
    for (let i = 0; i < 6; i++) {
      completed(world, { kind: 'school', owner: 0, cx: 10 + 3 * i, cz: 10, facing: 0 });
    }
    expect(educationGrowthBonus(world, 0)).toBeCloseTo(0.25, 12);
  });
});

describe('education bonus in auto-development', () => {
  let cachedTerrain: TerrainData | null = null;
  function getTerrain(): TerrainData {
    if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
    return cachedTerrain;
  }

  function findLandRect(w: number, h: number): { cx: number; cz: number } {
    const t = getTerrain();
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

  /** One growth pulse on a max-tax city with a 10x6 residential zone. */
  function pulseWorld(schools: number) {
    const terrain = getTerrain();
    const { cx, cz } = findLandRect(20, 8);
    const world = createWorld(2);
    world.tick = 300; // growth pulse tick
    world.time = 10;
    for (let dz = 0; dz < 6; dz++) {
      for (let dx = 0; dx < 10; dx++) {
        world.city.zones.push({
          cell: cellIndex(cx + dx, cz + dz),
          zone: ZoneType.RESIDENTIAL,
        });
      }
    }
    world.city.zones.sort((a, b) => a.cell - b.cell);
    const p = world.city.players[0]!;
    p.funds = 100000;
    p.materials = 100000;
    p.taxRates = [1.0, 1.0, 1.0]; // max tax: base desirability 0.0034
    for (let i = 0; i < schools; i++) {
      const b = placeBuilding(world.city, {
        kind: 'school',
        owner: 0,
        cx: cx + 10 + 2 * i,
        cz,
        facing: 0,
      });
      b.progress = 1;
    }
    runGrowth(terrain, world, [100], [100]);
    return world;
  }

  it('five completed schools tip a pulse that stalls without them', () => {
    // Seed 2: the first 'city' growth roll is 0.2466 — above the 0.0034
    // base desirability at max tax, but below 0.0034 + 0.25 (the capped
    // education bonus). The uneducated city develops nothing; the
    // five-school city develops two houses in the pulse.
    const plain = pulseWorld(0);
    expect(plain.city.buildings).toHaveLength(0);

    const educated = pulseWorld(5);
    expect(educated.city.buildings).toHaveLength(7);
    const kinds = educated.city.buildings.map((b) => b.kind);
    expect(kinds.filter((k) => k === 'school')).toHaveLength(5);
    expect(kinds.filter((k) => k === 'house')).toHaveLength(2);
  });
});
