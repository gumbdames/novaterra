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
 * NOVATERRA — tests/sim.placement.test.ts — buildings can't land on
 * units (2026-10-05, Fix 4).
 *
 * Covers:
 *  - `validatePlacement` rejects loudly (`<name>: footprint occupied
 *    by a unit`) when a unit stands on any footprint cell;
 *  - the rejection is a no-op state-wise (nothing is placed, no funds
 *    move) and omitting the units param keeps the legacy behavior;
 *  - the `placeBuilding` command spec threads units through (enqueue
 *    rejects with the loud reason);
 *  - `tryAutoDevelop` (via the exported `runGrowth`) never builds on
 *    a unit-occupied site: with a unit on every candidate cell nothing
 *    is placed; with the units moved away growth resumes.
 *
 * No snapshot/digest changes: rejection is a pure no-op.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { spawnUnit } from '../src/sim/units';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  ZoneType,
  cellCenterWorld,
  cellIndex,
  cellIsWater,
  getPlayer,
  registerCityCommands,
  runGrowth,
  validatePlacement,
  type Placement,
} from '../src/sim/city';
import type { UtilityModel } from '../src/sim/utilityNetworks';
import { injectDemand, serveRegionForTest } from './sim.housing-fixtures';
import {
  CommandRejectedError,
  createCommandQueue,
} from '../src/sim/commands';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** A 2x2 all-land block, deterministically found. */
function findLandBlock(terrain: TerrainData): { cx: number; cz: number } {
  for (let cz = 10; cz < 100; cz++) {
    for (let cx = 10; cx < 100; cx++) {
      let ok = true;
      for (let dz = 0; dz < 2 && ok; dz++) {
        for (let dx = 0; dx < 2 && ok; dx++) {
          if (cellIsWater(terrain, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error('no 2x2 land block found');
}

function setup(): { terrain: TerrainData; world: World; bx: number; bz: number } {
  const terrain = getTerrain();
  const world = createWorld(20261005);
  const { cx: bx, cz: bz } = findLandBlock(terrain);
  // Residential zoning over the block (a house needs it).
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      world.city.zones.push({ cell: cellIndex(bx + dx, bz + dz), zone: ZoneType.RESIDENTIAL });
    }
  }
  const player = getPlayer(world.city, 0);
  if (!player) throw new Error('no player 0');
  player.funds = 100000;
  player.materials = 100000;
  return { terrain, world, bx, bz };
}

/**
 * Fix 3: demand + served region for the growth test. The zone records
 * gain `by: 0` (painter attribution) and the region is served via the
 * fixture plants. Returns the utility model for runGrowth.
 */
function setupGrowth(world: World, bx: number, bz: number): UtilityModel {
  const zoneCells: number[] = [];
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      const cell = cellIndex(bx + dx, bz + dz);
      zoneCells.push(cell);
      const z = world.city.zones.find((zz) => zz.cell === cell);
      if (z) z.by = 0;
    }
  }
  injectDemand(world, 0, 50);
  return serveRegionForTest(world, 0, zoneCells);
}

/** Park one unit on each cell of the 2x2 block. */
function occupyBlock(world: World, bx: number, bz: number): void {
  for (let dz = 0; dz < 2; dz++) {
    for (let dx = 0; dx < 2; dx++) {
      spawnUnit(world, 'rifles', 0, cellCenterWorld(bx + dx), cellCenterWorld(bz + dz));
    }
  }
}

describe('validatePlacement unit occupancy', () => {
  it('rejects loudly when a unit stands on a footprint cell', () => {
    const { terrain, world, bx, bz } = setup();
    occupyBlock(world, bx, bz);
    const p: Placement = { kind: 'house', owner: 0, cx: bx, cz: bz, facing: 0 };
    expect(validatePlacement(terrain, world.city, p, world.units)).toBe(
      'House: footprint occupied by a unit',
    );
  });

  it('accepts once the unit moves away', () => {
    const { terrain, world, bx, bz } = setup();
    occupyBlock(world, bx, bz);
    const p: Placement = { kind: 'house', owner: 0, cx: bx, cz: bz, facing: 0 };
    expect(validatePlacement(terrain, world.city, p, world.units)).not.toBeNull();
    for (const u of world.units) {
      u.x = 200;
      u.z = 200;
    }
    expect(validatePlacement(terrain, world.city, p, world.units)).toBeNull();
  });

  it('omitting the units param keeps the legacy behavior', () => {
    const { terrain, world, bx, bz } = setup();
    occupyBlock(world, bx, bz);
    const p: Placement = { kind: 'house', owner: 0, cx: bx, cz: bz, facing: 0 };
    // No units passed: the unit check is skipped entirely.
    expect(validatePlacement(terrain, world.city, p)).toBeNull();
  });

  it('rejection is a pure no-op: no building, no spend', () => {
    const { terrain, world, bx, bz } = setup();
    occupyBlock(world, bx, bz);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('no player 0');
    const fundsBefore = player.funds;
    const p: Placement = { kind: 'house', owner: 0, cx: bx, cz: bz, facing: 0 };
    expect(validatePlacement(terrain, world.city, p, world.units)).not.toBeNull();
    expect(world.city.buildings).toHaveLength(0);
    expect(player.funds).toBe(fundsBefore);
  });
});

describe('placeBuilding command unit occupancy', () => {
  it('enqueue rejects loudly when a unit stands on the footprint', () => {
    const { terrain, world, bx, bz } = setup();
    occupyBlock(world, bx, bz);
    const queue = createCommandQueue();
    registerCityCommands(queue, terrain);
    let reason: string | null = null;
    try {
      queue.enqueue(world, {
        issuer: 'player',
        kind: 'placeBuilding',
        payload: { kind: 'house', owner: 0, cx: bx, cz: bz, facing: 0 },
      });
    } catch (e) {
      expect(e).toBeInstanceOf(CommandRejectedError);
      reason = (e as CommandRejectedError).reason;
    }
    expect(reason).toBe('House: footprint occupied by a unit');
    expect(world.city.buildings).toHaveLength(0);
  });
});

describe('tryAutoDevelop unit occupancy (via runGrowth)', () => {
  it('never builds on a unit-occupied site; growth resumes when units leave', () => {
    const { terrain, world, bx, bz } = setup();
    // Fix 3: the positive control needs demand + a served region.
    const model = setupGrowth(world, bx, bz);
    // The fixture's two utility plants are buildings too — count only
    // residential growth below.
    const residentialCount = (): number =>
      world.city.buildings.filter((b) => BUILDING_DEFS[b.kind].zone === ZoneType.RESIDENTIAL).length;
    occupyBlock(world, bx, bz);
    world.tick = 300;
    runGrowth(terrain, world, [100], [100], model);
    expect(residentialCount()).toBe(0);
    // Positive control: with the units moved away, organic growth
    // places something within a few pulses.
    for (const u of world.units) {
      u.x = 200;
      u.z = 200;
    }
    for (let t = 0; t < 5 && residentialCount() === 0; t++) {
      world.tick += 300;
      runGrowth(terrain, world, [100], [100], model);
    }
    expect(residentialCount()).toBeGreaterThan(0);
  });
});
