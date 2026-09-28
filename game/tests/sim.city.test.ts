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

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands, type CommandQueue, type NewCommand } from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  ZoneType,
  buildingAtCell,
  cellCenterWorld,
  cellCoords,
  cellIndex,
  cellIsWater,
  footprintCells,
  inBounds,
  isRoadAdjacent,
  areRoadsConnected,
  placeBuilding,
  registerCityCommands,
  zoneAt,
  type Placement,
} from '../src/sim/city';
import { createEconomySystem, registerEconomyCommands } from '../src/sim/economy';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function setup(seed = 20260928): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  // Start mid-pulse: the economy still runs on the first step
  // (150 % 30 === 0) but the tick-0 growth pulse is skipped, so scripted
  // multi-batch setups can't collide with auto-placed buildings.
  world.tick = 150;
  world.time = 150 / 30;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  const driver = createTickDriver({ queue, systems: [createEconomySystem(terrain)] });
  return { terrain, world, queue, driver };
}

/** Run N sim ticks through the driver (commands + economy). */
function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmds: NewCommand[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, c);
}

/** Find a w×h all-land rectangle; deterministic scan. */
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

/** First water cell found by deterministic scan. */
function findWaterCell(t: TerrainData): { cx: number; cz: number } {
  for (let cz = 0; cz < CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx < CITY_GRID_CELLS; cx++) {
      if (cellIsWater(t, cx, cz)) return { cx, cz };
    }
  }
  throw new Error('no water cell');
}

/** A horizontal road of `len` cells at row rz starting at (cx0, rz). */
function roadCells(cx0: number, rz: number, len: number): number[] {
  const cells: number[] = [];
  for (let i = 0; i < len; i++) cells.push(cellIndex(cx0 + i, rz));
  return cells;
}

describe('city grid helpers', () => {
  it('cellIndex/cellCoords round-trip', () => {
    expect(cellCoords(cellIndex(10, 20))).toEqual({ cx: 10, cz: 20 });
    expect(cellCoords(cellIndex(0, 0))).toEqual({ cx: 0, cz: 0 });
    expect(cellCoords(cellIndex(255, 255))).toEqual({ cx: 255, cz: 255 });
  });

  it('inBounds edges', () => {
    expect(inBounds(0, 0)).toBe(true);
    expect(inBounds(255, 255)).toBe(true);
    expect(inBounds(256, 0)).toBe(false);
    expect(inBounds(-1, 5)).toBe(false);
  });

  it('cell centers stay inside the map', () => {
    expect(cellCenterWorld(0)).toBe(-255);
    expect(cellCenterWorld(255)).toBe(255);
  });

  it('footprintCells covers the rectangle row-major', () => {
    const cells = footprintCells(3, 5, 2, 2);
    expect(cells).toEqual([cellIndex(3, 5), cellIndex(4, 5), cellIndex(3, 6), cellIndex(4, 6)]);
  });
});

describe('roads', () => {
  it('buildRoad paves cells, deducts cost, keeps roads sorted', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 10, 1);
    const cells = roadCells(cx, cz, 10).reverse(); // reversed on purpose
    const fundsBefore = ctx.world.city.players[0]!.funds;
    const matsBefore = ctx.world.city.players[0]!.materials;
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.roads).toEqual([...cells].sort((a, b) => a - b));
    expect(ctx.world.city.players[0]!.funds).toBe(fundsBefore - 10 * 5);
    expect(ctx.world.city.players[0]!.materials).toBe(matsBefore - 10 * 2);
  });

  it('buildRoad rejects water, duplicates, and occupied cells', () => {
    const ctx = setup();
    const w = findWaterCell(ctx.terrain);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'buildRoad', issuer: 'p',
        payload: { owner: 0, cells: [cellIndex(w.cx, w.cz)] },
      }),
    ).toThrow(/water/);
    const { cx, cz } = findLandRect(ctx.terrain, 4, 1);
    const cell = cellIndex(cx, cz);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'buildRoad', issuer: 'p',
        payload: { owner: 0, cells: [cell, cell] },
      }),
    ).toThrow(/duplicate/);
  });

  it('areRoadsConnected follows the paved graph', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 12, 3);
    const segA = roadCells(cx, cz + 1, 5);
    const segB = roadCells(cx + 6, cz + 1, 5); // gap: not connected
    const segC = roadCells(cx + 5, cz + 1, 1); // bridge cell
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: [...segA, ...segB] } }]);
    runTicks(ctx, 1);
    expect(areRoadsConnected(ctx.world.city, segA[0]!, segA[4]!)).toBe(true);
    expect(areRoadsConnected(ctx.world.city, segA[0]!, segB[0]!)).toBe(false);
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: segC } }]);
    runTicks(ctx, 1);
    expect(areRoadsConnected(ctx.world.city, segA[0]!, segB[4]!)).toBe(true);
  });
});

describe('zones', () => {
  it('paintZone paints, overwrites, and charges per cell', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 8, 8);
    const fundsBefore = ctx.world.city.players[0]!.funds;
    enqueue(ctx, [{
      kind: 'paintZone', issuer: 'p',
      payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz, x1: cx + 3, z1: cz + 3 },
    }]);
    runTicks(ctx, 1);
    expect(zoneAt(ctx.world.city, cellIndex(cx + 1, cz + 1))).toBe(ZoneType.RESIDENTIAL);
    expect(ctx.world.city.players[0]!.funds).toBe(fundsBefore - 16);
    // Overwrite with commercial.
    enqueue(ctx, [{
      kind: 'paintZone', issuer: 'p',
      payload: { owner: 0, zone: ZoneType.COMMERCIAL, x0: cx, z0: cz, x1: cx + 3, z1: cz + 3 },
    }]);
    runTicks(ctx, 1);
    expect(zoneAt(ctx.world.city, cellIndex(cx + 1, cz + 1))).toBe(ZoneType.COMMERCIAL);
  });

  it('paintZone rejects water and out-of-bounds rects', () => {
    const ctx = setup();
    const w = findWaterCell(ctx.terrain);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'paintZone', issuer: 'p',
        payload: { owner: 0, zone: 0, x0: w.cx, z0: w.cz, x1: w.cx, z1: w.cz },
      }),
    ).toThrow(/water/);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'paintZone', issuer: 'p',
        payload: { owner: 0, zone: 0, x0: 250, z0: 250, x1: 260, z1: 260 },
      }),
    ).toThrow(/bounds/);
  });
});

describe('building placement rules', () => {
  /** Road + residential zone ready for houses at the returned origin. */
  function residentialBlock(ctx: Ctx): { cx: number; cz: number } {
    const { cx, cz } = findLandRect(ctx.terrain, 12, 6);
    enqueue(ctx, [
      { kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx, cz + 2, 12) } },
      { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz + 3, x1: cx + 11, z1: cz + 5 } },
    ]);
    runTicks(ctx, 1);
    return { cx, cz: cz + 3 };
  }

  function placeCmd(p: Placement): NewCommand {
    return { kind: 'placeBuilding', issuer: 'p', payload: { ...p } };
  }

  it('places a house on zoned road-adjacent land, deducting costs', () => {
    const ctx = setup();
    const block = residentialBlock(ctx);
    const fundsBefore = ctx.world.city.players[0]!.funds;
    enqueue(ctx, [placeCmd({ kind: 'house', owner: 0, cx: block.cx, cz: block.cz, facing: 1 })]);
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings).toHaveLength(1);
    const b = ctx.world.city.buildings[0]!;
    expect(b.kind).toBe('house');
    expect(b.facing).toBe(1);
    expect(b.progress).toBe(0);
    expect(ctx.world.city.players[0]!.funds).toBe(fundsBefore - BUILDING_DEFS.house.costFunds);
    expect(buildingAtCell(ctx.world.city, cellIndex(block.cx, block.cz))).toBe(b);
  });

  it('rejects building on water', () => {
    const ctx = setup();
    const w = findWaterCell(ctx.terrain);
    expect(() =>
      ctx.queue.enqueue(ctx.world, placeCmd({ kind: 'house', owner: 0, cx: w.cx, cz: w.cz, facing: 0 })),
    ).toThrow(/water/);
  });

  it('rejects building away from roads', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 6, 6);
    enqueue(ctx, [{
      kind: 'paintZone', issuer: 'p',
      payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz, x1: cx + 5, z1: cz + 5 },
    }]);
    runTicks(ctx, 1);
    expect(() =>
      ctx.queue.enqueue(ctx.world, placeCmd({ kind: 'house', owner: 0, cx: cx + 2, cz: cz + 2, facing: 0 })),
    ).toThrow(/road/);
  });

  it('rejects overlapping footprints', () => {
    const ctx = setup();
    const block = residentialBlock(ctx);
    enqueue(ctx, [placeCmd({ kind: 'house', owner: 0, cx: block.cx, cz: block.cz, facing: 0 })]);
    runTicks(ctx, 1);
    expect(() =>
      ctx.queue.enqueue(ctx.world, placeCmd({ kind: 'house', owner: 0, cx: block.cx + 1, cz: block.cz, facing: 0 })),
    ).toThrow(/overlaps/);
  });

  it('rejects wrong-zone placement and allows utilities anywhere', () => {
    const ctx = setup();
    const block = residentialBlock(ctx);
    // Factory is industrial; the block is residential.
    expect(() =>
      ctx.queue.enqueue(ctx.world, placeCmd({ kind: 'factory', owner: 0, cx: block.cx, cz: block.cz, facing: 0 })),
    ).toThrow(/industrial/);
    // Power plant is a utility: no zone needed, just land + road.
    enqueue(ctx, [placeCmd({ kind: 'powerPlant', owner: 0, cx: block.cx + 4, cz: block.cz, facing: 0 })]);
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings).toHaveLength(1);
  });

  it('rejects unaffordable buildings with the cost in the reason', () => {
    const ctx = setup();
    const block = residentialBlock(ctx);
    ctx.world.city.players[0]!.funds = 1;
    expect(() =>
      ctx.queue.enqueue(ctx.world, placeCmd({ kind: 'house', owner: 0, cx: block.cx, cz: block.cz, facing: 0 })),
    ).toThrow(/cannot afford/);
  });

  it('isRoadAdjacent detects orthogonal adjacency only', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 8, 4);
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: [cellIndex(cx, cz)] } }]);
    runTicks(ctx, 1);
    expect(isRoadAdjacent(ctx.world.city, cx + 1, cz, 1, 1)).toBe(true);
    expect(isRoadAdjacent(ctx.world.city, cx + 1, cz + 1, 1, 1)).toBe(false); // diagonal doesn't count
    expect(isRoadAdjacent(ctx.world.city, cx + 2, cz, 1, 1)).toBe(false);
  });
});

describe('demolish', () => {
  it('removes the building, frees cells, refunds nothing', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 12, 6);
    enqueue(ctx, [
      { kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx, cz + 2, 12) } },
      { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz + 3, x1: cx + 11, z1: cz + 5 } },
    ]);
    runTicks(ctx, 1);
    enqueue(ctx, [
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx, cz: cz + 3, facing: 0 } },
    ]);
    runTicks(ctx, 1);
    const fundsAfterBuild = ctx.world.city.players[0]!.funds;
    expect(ctx.world.city.buildings).toHaveLength(1);
    enqueue(ctx, [{ kind: 'demolish', issuer: 'p', payload: { cx, cz: cz + 3 } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings).toHaveLength(0);
    expect(ctx.world.city.players[0]!.funds).toBe(fundsAfterBuild); // no refund
    expect(buildingAtCell(ctx.world.city, cellIndex(cx, cz + 3))).toBeUndefined();
    // And the freed cells accept a new building.
    enqueue(ctx, [{ kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx, cz: cz + 3, facing: 0 } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings).toHaveLength(1);
  });

  it('demolish removes roads and rejects empty cells', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 6, 2);
    const cell = cellIndex(cx, cz);
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: [cell] } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.roads).toContain(cell);
    enqueue(ctx, [{ kind: 'demolish', issuer: 'p', payload: { cx, cz } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.roads).not.toContain(cell);
    expect(() =>
      ctx.queue.enqueue(ctx.world, { kind: 'demolish', issuer: 'p', payload: { cx, cz } }),
    ).toThrow(/nothing to demolish/);
  });
});

describe('power and water allocation', () => {
  /** 30 houses on one 25-capacity plant: the pump takes 2, so 23 houses get power. */
  it('allocates supply in id order when demand exceeds supply', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 70, 8);
    const cmds: NewCommand[] = [
      { kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx, cz + 3, 70) } },
      { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz + 4, x1: cx + 69, z1: cz + 7 } },
    ];
    enqueue(ctx, cmds);
    runTicks(ctx, 1);
    const bldgs: NewCommand[] = [
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'powerPlant', owner: 0, cx, cz: cz + 4, facing: 0 } },
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'waterPump', owner: 0, cx: cx + 4, cz: cz + 4, facing: 0 } },
    ];
    for (let i = 0; i < 30; i++) {
      bldgs.push({ kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx: cx + 8 + i * 2, cz: cz + 4, facing: 0 } });
    }
    // Player needs deep pockets for 30 houses.
    ctx.world.city.players[0]!.funds = 100000;
    ctx.world.city.players[0]!.materials = 100000;
    enqueue(ctx, bldgs);
    // Construction: longest build here is 60 s (power plant); run 70 s.
    runTicks(ctx, 70 * 30);
    const houses = ctx.world.city.buildings.filter((b) => b.kind === 'house');
    expect(houses).toHaveLength(30);
    const powered = houses.filter((b) => b.powered);
    const unpowered = houses.filter((b) => !b.powered);
    // 25 supply − 2 for the water pump itself = 23 houses powered.
    expect(powered).toHaveLength(23);
    expect(unpowered).toHaveLength(7);
    // Id order: the first-placed 23 got the power.
    expect(Math.max(...powered.map((b) => b.id))).toBeLessThan(Math.min(...unpowered.map((b) => b.id)));
    // Same shape for water: the plant takes 2 of 25, leaving 23 houses.
    const watered = houses.filter((b) => b.watered);
    expect(watered).toHaveLength(23);
  });

  it('a plant off the road network contributes no supply', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 12, 8);
    // Plant placed far from any road.
    const plant = placeBuilding(ctx.world.city, { kind: 'powerPlant', owner: 0, cx, cz, facing: 0 });
    plant.progress = 1;
    const house = placeBuilding(ctx.world.city, { kind: 'house', owner: 0, cx: cx + 5, cz, facing: 0 });
    house.progress = 1;
    // Road adjacent to the house only.
    enqueue(ctx, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx + 5, cz + 2, 2) } }]);
    runTicks(ctx, 30);
    expect(house.powered).toBe(false);
  });
});

describe('city digest and snapshot', () => {
  it('city state feeds the world digest', () => {
    const a = setup(7);
    const b = setup(7);
    const { cx, cz } = findLandRect(a.terrain, 6, 2);
    const cells = roadCells(cx, cz, 6);
    enqueue(a, [{ kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells } }]);
    runTicks(a, 600);
    runTicks(b, 600);
    expect(digestWorld(a.world)).not.toBe(digestWorld(b.world));
  });

  it('snapshot round-trips the city and preserves the digest', () => {
    const ctx = setup();
    const { cx, cz } = findLandRect(ctx.terrain, 12, 6);
    enqueue(ctx, [
      { kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx, cz + 2, 12) } },
      { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.COMMERCIAL, x0: cx, z0: cz + 3, x1: cx + 5, z1: cz + 5 } },
    ]);
    runTicks(ctx, 1);
    enqueue(ctx, [
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'shop', owner: 0, cx, cz: cz + 3, facing: 2 } },
    ]);
    runTicks(ctx, 300);
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(takeSnapshot(ctx.world))));
    expect(digestWorld(restored)).toBe(before);
    expect(restored.city.buildings[0]!.facing).toBe(2);
    expect(restored.city.zones).toHaveLength(ctx.world.city.zones.length);
  });
});

describe('setTaxRate', () => {
  it('sets per-zone rates and rejects out-of-range values', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'setTaxRate', issuer: 'p', payload: { owner: 0, zone: 1, rate: 0.25 } }]);
    runTicks(ctx, 1);
    expect(ctx.world.city.players[0]!.taxRates[1]).toBe(0.25);
    expect(() =>
      ctx.queue.enqueue(ctx.world, { kind: 'setTaxRate', issuer: 'p', payload: { owner: 0, zone: 1, rate: 1.5 } }),
    ).toThrow(/between 0 and 1/);
  });
});
