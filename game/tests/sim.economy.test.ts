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
  CITY_GRID_CELLS,
  ZoneType,
  cellIndex,
  cellIsWater,
  placeBuilding,
  registerCityCommands,
  growthDesirability,
  runGrowth,
  type CityState,
  type Placement,
} from '../src/sim/city';
import {
  createEconomySystem,
  registerEconomyCommands,
  runEconomyTick,
} from '../src/sim/economy';
import { digestWorld } from '../src/sim/digest';

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

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmds: NewCommand[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, c);
}

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

function roadCells(cx0: number, rz: number, len: number): number[] {
  const cells: number[] = [];
  for (let i = 0; i < len; i++) cells.push(cellIndex(cx0 + i, rz));
  return cells;
}

/** Directly pave cells (tests that bypass command validation). */
function pave(city: CityState, cells: number[]): void {
  // Phase 4 (S7): roads are RoadCell[] — tests pave with the legacy
  // default class, matching the v6→v7 migration.
  for (const c of cells) {
    if (!city.roads.some((r) => r.cell === c)) city.roads.push({ cell: c, cls: 'paved' });
  }
  city.roads.sort((a, b) => a.cell - b.cell);
}

/** Directly place a completed building (bypasses command validation). */
function completed(city: CityState, p: Placement) {
  const b = placeBuilding(city, p);
  b.progress = 1;
  return b;
}

/** Advance the economy one sim-second per iteration, from a known tick. */
function runEconomySeconds(ctx: Ctx, seconds: number): void {
  ctx.world.tick = 0;
  ctx.world.time = 0;
  for (let s = 0; s < seconds; s++) {
    ctx.world.tick += 30;
    runEconomyTick(ctx.world, ctx.terrain);
  }
}

// ---------------------------------------------------------------------------
// Reference city: a sensible powered city should run resource-positive.
// ---------------------------------------------------------------------------

/** Scripted reference city: 4 houses, shop, factory, farm, plant, pump.
 * Zones are painted snug around the scripted footprints, so
 * auto-development has no room: this scenario measures pure resource
 * flow, not growth (growth has its own tests, and since 2026-09-30 it no
 * longer needs roads — a big open zone here would develop freely and
 * swamp the flow measurements). */
function buildReferenceCity(ctx: Ctx, taxRate: number): void {
  const { cx, cz } = findLandRect(ctx.terrain, 44, 16);
  const rz = cz + 7;
  enqueue(ctx, [
    { kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx, rz, 44) } },
    { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx + 0, z0: cz + 5, x1: cx + 1, z1: cz + 6 } },
    { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx + 3, z0: cz + 5, x1: cx + 4, z1: cz + 6 } },
    { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx + 6, z0: cz + 5, x1: cx + 7, z1: cz + 6 } },
    { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx + 9, z0: cz + 5, x1: cx + 10, z1: cz + 6 } },
    { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.COMMERCIAL, x0: cx + 0, z0: cz + 8, x1: cx + 1, z1: cz + 9 } },
    { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.INDUSTRIAL, x0: cx + 24, z0: cz + 4, x1: cx + 26, z1: cz + 6 } },
    { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.INDUSTRIAL, x0: cx + 28, z0: cz + 8, x1: cx + 30, z1: cz + 10 } },
  ]);
  runTicks(ctx, 1);
  enqueue(ctx, [
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx: cx + 0, cz: cz + 5, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx: cx + 3, cz: cz + 5, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx: cx + 6, cz: cz + 5, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx: cx + 9, cz: cz + 5, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'shop', owner: 0, cx: cx + 0, cz: cz + 8, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'factory', owner: 0, cx: cx + 24, cz: cz + 4, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'farm', owner: 0, cx: cx + 28, cz: cz + 8, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'powerPlant', owner: 0, cx: cx + 33, cz: cz + 4, facing: 0 } },
    { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'waterPump', owner: 0, cx: cx + 37, cz: cz + 8, facing: 0 } },
    { kind: 'setTaxRate', issuer: 'p', payload: { owner: 0, zone: 0, rate: taxRate } },
    { kind: 'setTaxRate', issuer: 'p', payload: { owner: 0, zone: 1, rate: taxRate } },
    { kind: 'setTaxRate', issuer: 'p', payload: { owner: 0, zone: 2, rate: taxRate } },
  ]);
  runTicks(ctx, 1);
}

describe('reference city resource flow', () => {
  it('materials and food flow net-positive once built', () => {
    const ctx = setup();
    buildReferenceCity(ctx, 0.2);
    runTicks(ctx, 3600); // 120 s: everything completes
    const p = ctx.world.city.players[0]!;
    const matsA = p.materials;
    const foodA = p.food;
    runTicks(ctx, 3600);
    expect(p.materials).toBeGreaterThan(matsA);
    expect(p.food).toBeGreaterThan(foodA);
  });

  it('higher taxes collect more funds over the same scripted run', () => {
    const low = setup(42);
    const high = setup(42);
    buildReferenceCity(low, 0.0);
    buildReferenceCity(high, 0.5);
    runTicks(low, 7200);
    runTicks(high, 7200);
    expect(high.world.city.players[0]!.funds).toBeGreaterThan(low.world.city.players[0]!.funds);
  });
});

describe('utility penalty', () => {
  function farmWorld(seed: number, withPower: boolean): Ctx {
    const ctx = setup(seed);
    const { cx, cz } = findLandRect(ctx.terrain, 10, 6);
    pave(ctx.world.city, roadCells(cx, cz + 2, 10));
    completed(ctx.world.city, { kind: 'farm', owner: 0, cx, cz: cz + 3, facing: 0 });
    completed(ctx.world.city, { kind: 'waterPump', owner: 0, cx: cx + 4, cz: cz + 3, facing: 0 });
    if (withPower) {
      completed(ctx.world.city, { kind: 'powerPlant', owner: 0, cx: cx + 7, cz: cz + 3, facing: 0 });
    }
    ctx.world.city.players[0]!.food = 0;
    return ctx;
  }

  it('an unpowered farm produces ~25% of a powered one', () => {
    const a = farmWorld(11, true);
    const b = farmWorld(11, false);
    runEconomySeconds(a, 120);
    runEconomySeconds(b, 120);
    const farmA = a.world.city.buildings.find((x) => x.kind === 'farm')!;
    const farmB = b.world.city.buildings.find((x) => x.kind === 'farm')!;
    expect(farmA.powered).toBe(true);
    expect(farmB.powered).toBe(false);
    expect(farmB.watered).toBe(true); // only the power penalty applies
    const foodA = a.world.city.players[0]!.food;
    const foodB = b.world.city.players[0]!.food;
    const levelMult = (level: number) => 1 + 0.25 * (level - 1);
    const expected = 0.25 * (levelMult(farmB.level) / levelMult(farmA.level));
    expect(foodB / foodA).toBeCloseTo(expected, 6);
  });
});

describe('taxes', () => {
  function houseWorld(seed: number, rate: number): Ctx {
    const ctx = setup(seed);
    const { cx, cz } = findLandRect(ctx.terrain, 6, 4);
    pave(ctx.world.city, roadCells(cx, cz + 1, 6));
    completed(ctx.world.city, { kind: 'house', owner: 0, cx, cz: cz + 2, facing: 0 });
    ctx.world.city.players[0]!.taxRates = [rate, rate, rate];
    return ctx;
  }

  it('collects exactly rate × taxBase × 60 per period', () => {
    const half = houseWorld(21, 0.5);
    const zero = houseWorld(21, 0.0);
    // 61 economy ticks → tax indices 1..61 → one collection at index 60.
    runEconomySeconds(half, 61);
    runEconomySeconds(zero, 61);
    const fundsHalf = half.world.city.players[0]!.funds;
    const fundsZero = zero.world.city.players[0]!.funds;
    expect(fundsHalf - fundsZero).toBeCloseTo(0.5 * 1.0 * 60, 6);
  });

  it('growth desirability falls with taxes and missing utility headroom', () => {
    expect(growthDesirability(0.1, 10, 10)).toBeCloseTo(0.484, 6);
    expect(growthDesirability(0.5, 10, 10)).toBeCloseTo(0.22, 6);
    expect(growthDesirability(1.0, 10, 10)).toBeCloseTo(0.055, 6);
    expect(growthDesirability(0.1, 0, 0)).toBeCloseTo(0.484 * 0.0625, 6);
    expect(growthDesirability(0.5, 0, 0)).toBeLessThan(growthDesirability(0.1, 10, 10));
  });
});

describe('food shortage stalls growth', () => {
  function growthWorld(seed: number, food: number): Ctx {
    const ctx = setup(seed);
    const { cx, cz } = findLandRect(ctx.terrain, 20, 8);
    pave(ctx.world.city, roadCells(cx, cz + 3, 20));
    // Paint a residential zone directly (no command round-trip needed).
    for (let dz = 4; dz <= 6; dz++) {
      for (let dx = 0; dx < 20; dx++) {
        ctx.world.city.zones.push({ cell: cellIndex(cx + dx, cz + dz), zone: ZoneType.RESIDENTIAL });
      }
    }
    ctx.world.city.zones.sort((a, b) => a.cell - b.cell);
    completed(ctx.world.city, { kind: 'apartment', owner: 0, cx, cz: cz + 4, facing: 0 }); // pop 30
    const p = ctx.world.city.players[0]!;
    p.food = food;
    p.funds = 100000;
    p.materials = 100000;
    return ctx;
  }

  it('no auto-development while food is short', () => {
    const ctx = growthWorld(31, 0);
    expect(ctx.world.city.buildings).toHaveLength(1);
    runEconomySeconds(ctx, 120); // many growth pulses at ticks 300, 600, …
    expect(ctx.world.city.foodShortage).toBe(true);
    expect(ctx.world.city.buildings).toHaveLength(1);
  });

  it('runGrowth early-returns on the shortage flag', () => {
    const ctx = growthWorld(31, 1000);
    ctx.world.city.foodShortage = true;
    const before = ctx.world.city.buildings.length;
    runGrowth(ctx.terrain, ctx.world, [100], [100]);
    expect(ctx.world.city.buildings).toHaveLength(before);
  });
});

describe('auto-development', () => {
  it('a funded zoned city grows organically over time', () => {
    const ctx = setup(55);
    const { cx, cz } = findLandRect(ctx.terrain, 20, 8);
    enqueue(ctx, [
      { kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx, cz + 3, 20) } },
      { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz + 4, x1: cx + 19, z1: cz + 6 } },
    ]);
    runTicks(ctx, 1);
    ctx.world.city.players[0]!.funds = 100000;
    ctx.world.city.players[0]!.materials = 100000;
    runTicks(ctx, 7200); // 240 s of growth pulses
    expect(ctx.world.city.buildings.length).toBeGreaterThan(0);
  });

  it('zoned houses auto-develop with no roads at all (user directive 2026-09-30)', () => {
    const ctx = setup(57);
    const { cx, cz } = findLandRect(ctx.terrain, 20, 8);
    enqueue(ctx, [
      { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz, x1: cx + 19, z1: cz + 7 } },
    ]);
    runTicks(ctx, 1);
    ctx.world.city.players[0]!.funds = 100000;
    ctx.world.city.players[0]!.materials = 100000;
    runTicks(ctx, 7200); // 240 s of growth pulses
    expect(ctx.world.city.roads).toHaveLength(0);
    expect(ctx.world.city.buildings.length).toBeGreaterThan(0);
  });
});

describe('market', () => {
  it('buys at +spread and sells at −spread', () => {
    const ctx = setup();
    const p = ctx.world.city.players[0]!;
    enqueue(ctx, [{ kind: 'marketTrade', issuer: 'p', payload: { owner: 0, action: 'buy', resource: 'materials', amount: 100 } }]);
    runTicks(ctx, 1);
    expect(p.materials).toBe(1500 + 100);
    expect(p.funds).toBeCloseTo(4000 - 100 * 2 * 1.2, 6);
    enqueue(ctx, [{ kind: 'marketTrade', issuer: 'p', payload: { owner: 0, action: 'sell', resource: 'materials', amount: 100 } }]);
    runTicks(ctx, 1);
    expect(p.materials).toBe(1500);
    expect(p.funds).toBeCloseTo(4000 - 240 + 160, 6);
  });

  it('a buy-then-sell round trip loses value', () => {
    const ctx = setup();
    const p = ctx.world.city.players[0]!;
    const before = p.funds;
    enqueue(ctx, [
      { kind: 'marketTrade', issuer: 'p', payload: { owner: 0, action: 'buy', resource: 'fuel', amount: 50 } },
      { kind: 'marketTrade', issuer: 'p', payload: { owner: 0, action: 'sell', resource: 'fuel', amount: 50 } },
    ]);
    runTicks(ctx, 2);
    expect(p.funds).toBeLessThan(before);
  });

  it('rejects unaffordable buys, oversized sells, and bad resources', () => {
    const ctx = setup();
    ctx.world.city.players[0]!.funds = 1;
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'marketTrade', issuer: 'p',
        payload: { owner: 0, action: 'buy', resource: 'materials', amount: 100 },
      }),
    ).toThrow(/cannot afford/);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'marketTrade', issuer: 'p',
        payload: { owner: 0, action: 'sell', resource: 'food', amount: 999999 },
      }),
    ).toThrow(/insufficient/);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        kind: 'marketTrade', issuer: 'p',
        payload: { owner: 0, action: 'sell', resource: 'funds', amount: 10 },
      }),
    ).toThrow(/resource must be/);
  });
});

describe('city/economy determinism', () => {
  function scriptedRun(seed: number, extra: boolean): number {
    const ctx = setup(seed);
    const { cx, cz } = findLandRect(ctx.terrain, 12, 8);
    const cmds: NewCommand[] = [
      { kind: 'buildRoad', issuer: 'p', payload: { owner: 0, cells: roadCells(cx, cz + 3, 12) } },
      { kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: cx, z0: cz + 4, x1: cx + 11, z1: cz + 6 } },
    ];
    if (extra) {
      cmds.push({ kind: 'paintZone', issuer: 'p', payload: { owner: 0, zone: ZoneType.COMMERCIAL, x0: cx, z0: cz, x1: cx + 3, z1: cz + 2 } });
    }
    enqueue(ctx, cmds);
    runTicks(ctx, 1);
    enqueue(ctx, [
      { kind: 'placeBuilding', issuer: 'p', payload: { kind: 'house', owner: 0, cx, cz: cz + 4, facing: 0 } },
      { kind: 'setTaxRate', issuer: 'p', payload: { owner: 0, zone: 0, rate: 0.3 } },
      { kind: 'marketTrade', issuer: 'p', payload: { owner: 0, action: 'buy', resource: 'food', amount: 20 } },
    ]);
    runTicks(ctx, 600);
    return digestWorld(ctx.world);
  }

  it('the same scripted 600-tick run produces the same digest', () => {
    expect(scriptedRun(99, false)).toBe(scriptedRun(99, false));
  });

  it('a different script produces a different digest', () => {
    expect(scriptedRun(99, true)).not.toBe(scriptedRun(99, false));
  });
});
