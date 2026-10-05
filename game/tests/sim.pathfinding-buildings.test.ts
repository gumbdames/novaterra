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
 * Building-aware pathfinding tests (2026-10-05): completed buildings are
 * pathing obstacles — A* and flow fields route around them instead of
 * clipping through. In-construction buildings do NOT block. All headless.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  type TerrainData,
} from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  cellIndex,
  cellIsWater,
  footprintCells,
  type BuildingKind,
} from '../src/sim/city';
import {
  buildingBlockMask,
  computeFlowField,
  findPath,
  FIELD_DESTINATION,
  FIELD_UNREACHABLE,
} from '../src/sim/pathfinding';
import { completeBuilding } from './sim.roster-fixtures';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (cachedTerrain === null) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** A horizontal run of `n` land cells (for deterministic test geometry). */
function landRun(terrain: TerrainData, n: number): { cx: number; cz: number } {
  for (let cz = 8; cz < 120; cz++) {
    for (let cx = 8; cx < 120 - n; cx++) {
      let ok = true;
      for (let dx = 0; dx < n; dx++) {
        if (cellIsWater(terrain, cx + dx, cz)) {
          ok = false;
          break;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error('no land run found');
}

function setup(): { terrain: TerrainData; world: World } {
  return { terrain: getTerrain(), world: createWorld(20261005) };
}

/** Place a COMPLETED building of kind at (cx, cz) for owner 0. */
function placeCompleted(world: World, kind: BuildingKind, cx: number, cz: number): void {
  completeBuilding(world, kind, 0, cx, cz);
}

function footprintSet(kind: BuildingKind, cx: number, cz: number): Set<number> {
  const def = BUILDING_DEFS[kind];
  return new Set(footprintCells(cx, cz, def.footprintW, def.footprintH));
}

describe('buildingBlockMask', () => {
  it('marks completed footprints, ignores in-construction ones', () => {
    const { world } = setup();
    const { cx, cz } = landRun(getTerrain(), 8);
    placeCompleted(world, 'house', cx, cz);
    // In-construction: push a raw record with progress < 1.
    world.city.buildings.push({
      id: world.city.nextBuildingId++,
      kind: 'house',
      owner: 0,
      cx: cx + 4,
      cz,
      facing: 0,
      progress: 0.5,
      level: 1,
      operational: false,
      powered: false,
      watered: false,
      hp: 200,
      maxHp: 200,
      powerDiag: 'disconnected',
      waterDiag: 'disconnected',
      ammoStock: 0,
      fuelStock: 0,
      materialsStock: 0,
      reservedAmmo: 0,
      reservedFuel: 0,
      reactors: 1,
    });
    const mask = buildingBlockMask(world.city);
    for (const cell of footprintSet('house', cx, cz)) {
      expect(mask[cell]).toBe(1);
    }
    for (const cell of footprintSet('house', cx + 4, cz)) {
      expect(mask[cell]).toBe(0);
    }
  });

  it('is empty with no completed buildings', () => {
    const { world } = setup();
    const mask = buildingBlockMask(world.city);
    expect(mask.every((v) => v === 0)).toBe(true);
  });
});

describe('findPath with buildings', () => {
  it('routes around a completed building', () => {
    const { terrain, world } = setup();
    const { cx, cz } = landRun(getTerrain(), 13);
    placeCompleted(world, 'house', cx + 5, cz);
    const blocked = footprintSet('house', cx + 5, cz);
    const start = cellIndex(cx, cz);
    const goal = cellIndex(cx + 12, cz);
    const { path } = findPath(terrain, world.city, start, goal);
    expect(path).not.toBeNull();
    for (const cell of path as number[]) {
      expect(blocked.has(cell)).toBe(false);
    }
  });

  it('still reaches a goal inside a footprint (attack-move exemption)', () => {
    const { terrain, world } = setup();
    const { cx, cz } = landRun(getTerrain(), 13);
    placeCompleted(world, 'house', cx + 5, cz);
    const start = cellIndex(cx, cz);
    const goal = cellIndex(cx + 5, cz); // inside the house
    const { path } = findPath(terrain, world.city, start, goal);
    expect(path).not.toBeNull();
    expect((path as number[])[(path as number[]).length - 1]).toBe(goal);
  });

  it('does not block on in-construction buildings', () => {
    const { terrain, world } = setup();
    const { cx, cz } = landRun(getTerrain(), 13);
    // Progress < 1: the straight-line path may pass through.
    world.city.buildings.push({
      id: world.city.nextBuildingId++,
      kind: 'house',
      owner: 0,
      cx: cx + 5,
      cz,
      facing: 0,
      progress: 0.5,
      level: 1,
      operational: false,
      powered: false,
      watered: false,
      hp: 200,
      maxHp: 200,
      powerDiag: 'disconnected',
      waterDiag: 'disconnected',
      ammoStock: 0,
      fuelStock: 0,
      materialsStock: 0,
      reservedAmmo: 0,
      reservedFuel: 0,
      reactors: 1,
    });
    const blocked = footprintSet('house', cx + 5, cz);
    const start = cellIndex(cx, cz);
    const goal = cellIndex(cx + 12, cz);
    const { path } = findPath(terrain, world.city, start, goal);
    expect(path).not.toBeNull();
    // Straight line is cheapest: the path goes through the site.
    expect((path as number[]).some((c) => blocked.has(c))).toBe(true);
  });
});

describe('flow fields with buildings', () => {
  it('marks other-building cells unreachable, keeps the dest cell', () => {
    const { terrain, world } = setup();
    const { cx, cz } = landRun(getTerrain(), 20);
    placeCompleted(world, 'house', cx + 5, cz); // dest inside this one
    placeCompleted(world, 'house', cx + 12, cz); // this one stays blocked
    const dest = cellIndex(cx + 5, cz);
    const field = computeFlowField(terrain, world.city, dest);
    expect(field.dirs[dest]).toBe(FIELD_DESTINATION);
    for (const cell of footprintSet('house', cx + 12, cz)) {
      expect(field.dirs[cell]).toBe(FIELD_UNREACHABLE);
    }
    // A cell outside any footprint still gets a direction.
    expect(field.dirs[cellIndex(cx, cz)]).not.toBe(FIELD_UNREACHABLE);
  });
});
