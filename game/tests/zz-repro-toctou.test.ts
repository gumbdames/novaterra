/*!
 * TEMPORARY REPRO — unit swallowed by building during construction (TOCTOU).
 * DELETE AFTER DIAGNOSIS.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCommandQueue } from '../src/sim/commands';
import { registerCoreCommands } from '../src/sim/commands';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  cellIndex,
  cellIsWater,
  footprintCells,
  getPlayer,
  placeBuilding,
  registerCityCommands,
} from '../src/sim/city';
import type { BuildingKind, Placement } from '../src/sim/city';
import { runEconomyTick } from '../src/sim/economy';
import { spawnUnit } from '../src/sim/units';
import { createMovementSystem, createPathfindingSystem, orderMoveTo } from '../src/sim/movement';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';
import { grantAllTrainingResources } from './sim.roster-fixtures';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function findLand(terrain: TerrainData, fromCx: number, fromCz: number): { cx: number; cz: number } {
  for (let r = 0; r < 40; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = fromCx + dx;
        const cz = fromCz + dz;
        if (!cellIsWater(terrain, cx, cz)) return { cx, cz };
      }
    }
  }
  throw new Error('no land');
}

function unitCellOf(world: any, u: any): number {
  const cx = Math.floor((u.x + 256) / 2);
  const cz = Math.floor((u.z + 256) / 2);
  return cellIndex(cx, cz);
}

describe('TOCTOU repro: unit walks onto construction site', () => {
  it('unit ordered onto an in-construction footprint ends up inside the completed building', () => {
    const terrain = getTerrain();
    const world = createWorld(42);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    const driver = createTickDriver({
      queue,
      systems: [createPathfindingSystem(terrain), createMovementSystem(terrain)],
    });

    // Land site for the house.
    const site = findLand(terrain, 120, 120);
    // Spawn engineer a few cells away (NOT on the footprint).
    const eng = spawnUnit(world, 'engineer', 0, cellCenterWorld(site.cx + 6), cellCenterWorld(site.cz));
    expect(eng).toBeDefined();

    // Place house under construction directly (progress 0).
    const p: Placement = { kind: 'house', owner: 0, cx: site.cx, cz: site.cz, facing: 0 };
    const b = placeBuilding(world.city, p, 42);
    expect(b.progress).toBeLessThan(1);

    // Order the engineer to walk to the CENTER of the construction footprint.
    const def = BUILDING_DEFS['house' as BuildingKind];
    const fcx = site.cx + Math.floor(def.footprintW / 2);
    const fcz = site.cz + Math.floor(def.footprintH / 2);
    orderMoveTo(world, eng!, cellCenterWorld(fcx), cellCenterWorld(fcz));

    // Run until construction completes (house buildSeconds ~ ?; run plenty).
    let completedAt = -1;
    for (let tick = 0; tick < 30 * 300; tick++) {
      driver.step(world, TICK_MS);
      runEconomyTick(world, terrain);
      if (b.progress >= 1 && completedAt < 0) completedAt = tick;
      if (completedAt >= 0 && tick > completedAt + 30 * 10) break;
    }
    expect(completedAt).toBeGreaterThanOrEqual(0);

    const cells = new Set(footprintCells(b.cx, b.cz, def.footprintW, def.footprintH));
    const inside = cells.has(unitCellOf(world, eng));
    console.log(
      `construction completed at tick ${completedAt}, engineer state=${eng!.state}, ` +
        `engineer inside footprint=${inside}, eng pos=(${eng!.x.toFixed(1)},${eng!.z.toFixed(1)})`,
    );
    // We EXPECT inside === true (the bug). This documents the mechanism.
    expect(inside).toBe(true);
  });
});
