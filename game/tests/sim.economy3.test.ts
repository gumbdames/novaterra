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
import {
  createCommandQueue,
  CommandRejectedError,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  cellIndex,
  cellIsWater,
  getPlayer,
  placeBuilding,
  registerCityCommands,
  ZoneType,
  type CityState,
  type PlayerState,
} from '../src/sim/city';
import {
  createEconomySystem,
  registerEconomyCommands,
  runEconomyTick,
  specializationMult,
  SPECIALIZATION_OUTPUT_BONUS,
  SPECIALIZATION_OUTPUT_PENALTY,
  TRADE_ROUTE_SETUP_COST,
  TRADE_ROUTE_INCOME_PER_SEC,
} from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
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

function setup(seed = 505001): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  const driver = createTickDriver({ queue, systems: [createEconomySystem(terrain)] });
  return { terrain, world, queue, driver };
}

function enqueue(ctx: Ctx, cmds: Omit<NewCommand, 'issuer'>[]): void {
  for (const c of cmds) ctx.queue.enqueue(ctx.world, { issuer: 'player', ...c });
}

function playerOf(ctx: Ctx, id: number): PlayerState {
  return getPlayer(ctx.world.city, id) as PlayerState;
}

/** Place a completed, fully serviced building directly (test helper). */
function completed(ctx: Ctx, kind: 'shop' | 'factory' | 'house', owner: number): void {
  const t = getTerrain();
  const city = ctx.world.city;
  const place = (k: 'shop' | 'factory' | 'house' | 'powerPlant' | 'waterPump'): void => {
    const foot = k === 'factory' || k === 'powerPlant' ? 3 : 2;
    for (let cz = 2; cz < 60; cz++) {
      for (let cx = 2; cx < 60; cx++) {
        let ok = true;
        for (let dz = 0; dz < foot && ok; dz++) {
          for (let dx = 0; dx < foot && ok; dx++) {
            if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
          }
        }
        if (!ok) continue;
        const roadCell = cellIndex(cx - 1, cz);
        // Phase 4 (S7): roads are RoadCell[].
        if (!city.roads.some((r) => r.cell === roadCell)) {
          city.roads.push({ cell: roadCell, cls: 'paved' });
          city.roads.sort((a, b) => a.cell - b.cell);
        }
        try {
          const b = placeBuilding(city, { kind: k, owner, cx, cz, facing: 0 });
          b.progress = 1;
          b.operational = true;
          b.powered = true;
          b.watered = true;
          return;
        } catch {
          continue;
        }
      }
    }
    throw new Error('no placement found');
  };
  // Utilities first so allocateUtilities really powers/waters the building.
  place('powerPlant');
  place('waterPump');
  place(kind);
  // Keep the owner solvent: placement deducts costs straight from funds.
  const p = getPlayer(city, owner) as { funds: number; materials: number };
  p.funds = 20000;
  p.materials = 20000;
}

describe('sim/economy — specialization', () => {
  it('setSpecialization validates and stores the focus', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'setSpecialization', payload: { owner: 0, specialization: 'industrial' } }]);
    ctx.driver.step(ctx.world, TICK_MS);
    expect(playerOf(ctx, 0).specialization).toBe('industrial');
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'setSpecialization',
        payload: { owner: 0, specialization: 'martian' },
      }),
    ).toThrow(CommandRejectedError);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'setSpecialization',
        payload: { owner: 99, specialization: 'industrial' },
      }),
    ).toThrow(CommandRejectedError);
  });

  it('specializationMult: bonus for matching zone, penalty otherwise, utility untouched', () => {
    const ctx = setup();
    const p = playerOf(ctx, 0);
    expect(specializationMult(p, ZoneType.INDUSTRIAL)).toBe(1); // balanced
    p.specialization = 'industrial';
    expect(specializationMult(p, ZoneType.INDUSTRIAL)).toBe(SPECIALIZATION_OUTPUT_BONUS);
    expect(specializationMult(p, ZoneType.COMMERCIAL)).toBe(SPECIALIZATION_OUTPUT_PENALTY);
    expect(specializationMult(p, ZoneType.RESIDENTIAL)).toBe(SPECIALIZATION_OUTPUT_PENALTY);
    expect(specializationMult(p, 'utility')).toBe(1);
  });

  it('industrial focus boosts factory materials output over one economy tick', () => {
    const run = (spec: 'balanced' | 'industrial'): number => {
      const ctx = setup(606);
      playerOf(ctx, 0).specialization = spec;
      completed(ctx, 'factory', 0);
      const before = playerOf(ctx, 0).materials;
      ctx.world.tick = 30; // skip growth (tick%300) and taxes (index%60) for exact amounts
      runEconomyTick(ctx.world, ctx.terrain);
      return playerOf(ctx, 0).materials - before;
    };
    const balanced = run('balanced');
    const industrial = run('industrial');
    // Factory outputs 2.5 materials/sec; industrial focus adds 25%.
    expect(industrial).toBeCloseTo(balanced * SPECIALIZATION_OUTPUT_BONUS, 9);
    expect(balanced).toBeCloseTo(2.5, 9);
  });
});

describe('sim/economy — trade routes', () => {
  it('establishTradeRoute charges setup and pays income when both ends trade', () => {
    const ctx = setup();
    completed(ctx, 'shop', 0);
    completed(ctx, 'shop', 1);
    playerOf(ctx, 0).goods = 1000; // shops consume goods; avoid starvation
    const fundsBefore = playerOf(ctx, 0).funds;
    enqueue(ctx, [{ kind: 'establishTradeRoute', payload: { owner: 0, partner: 1 } }]);
    ctx.world.tick = 1; // keep the tick-0 economy (taxes) out of exact-amount checks
    ctx.driver.step(ctx.world, TICK_MS);
    expect(ctx.world.city.tradeRoutes).toHaveLength(1);
    expect(playerOf(ctx, 0).funds).toBeCloseTo(fundsBefore - TRADE_ROUTE_SETUP_COST, 9);
    const afterSetup = playerOf(ctx, 0).funds;
    ctx.world.tick = 30; // skip growth (tick%300) and taxes (index%60) for exact amounts
    runEconomyTick(ctx.world, ctx.terrain);
    // +3.0 trade income, +1.8 shop output, −1.6 upkeep (shop+plant+pump).
    expect(playerOf(ctx, 0).funds).toBeCloseTo(
      afterSetup + TRADE_ROUTE_INCOME_PER_SEC + 1.8 - 1.6,
      9,
    );
  });

  it('no income when the partner has no commercial building', () => {
    const ctx = setup();
    completed(ctx, 'shop', 0);
    playerOf(ctx, 0).goods = 1000;
    // Player 1 has no commercial buildings.
    enqueue(ctx, [{ kind: 'establishTradeRoute', payload: { owner: 0, partner: 1 } }]);
    ctx.world.tick = 1; // keep the tick-0 economy (taxes) out of exact-amount checks
    ctx.driver.step(ctx.world, TICK_MS);
    const afterSetup = playerOf(ctx, 0).funds;
    ctx.world.tick = 30; // skip growth (tick%300) and taxes (index%60) for exact amounts
    runEconomyTick(ctx.world, ctx.terrain);
    // Only the shop's own output minus upkeep — no trade bonus.
    expect(playerOf(ctx, 0).funds).toBeCloseTo(afterSetup + 1.8 - 1.6, 9);
  });

  it('cancelTradeRoute ends the income; validation is loud', () => {
    const ctx = setup();
    enqueue(ctx, [{ kind: 'establishTradeRoute', payload: { owner: 0, partner: 1 } }]);
    ctx.world.tick = 1; // keep the tick-0 economy (taxes) out of exact-amount checks
    ctx.driver.step(ctx.world, TICK_MS);
    expect(ctx.world.city.tradeRoutes).toHaveLength(1);
    enqueue(ctx, [{ kind: 'cancelTradeRoute', payload: { owner: 0, partner: 1 } }]);
    ctx.driver.step(ctx.world, TICK_MS);
    expect(ctx.world.city.tradeRoutes).toHaveLength(0);
    // Cancelling again: no such route.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'cancelTradeRoute', payload: { owner: 0, partner: 1 },
      }),
    ).toThrow(/no such route/);
    // Self-trade, duplicates, unknown players, and poverty are rejected.
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'establishTradeRoute', payload: { owner: 0, partner: 0 },
      }),
    ).toThrow(/yourself/);
    enqueue(ctx, [{ kind: 'establishTradeRoute', payload: { owner: 0, partner: 1 } }]);
    ctx.driver.step(ctx.world, TICK_MS);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'establishTradeRoute', payload: { owner: 0, partner: 1 },
      }),
    ).toThrow(/already exists/);
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'establishTradeRoute', payload: { owner: 0, partner: 99 },
      }),
    ).toThrow(/unknown partner/);
    playerOf(ctx, 1).funds = 0;
    expect(() =>
      ctx.queue.enqueue(ctx.world, {
        issuer: 'player', kind: 'establishTradeRoute', payload: { owner: 1, partner: 0 },
      }),
    ).toThrow(/cannot afford/);
  });

  it('snapshot round-trip preserves specialization and trade routes', () => {
    const ctx = setup();
    completed(ctx, 'shop', 0);
    completed(ctx, 'shop', 1);
    enqueue(ctx, [
      { kind: 'setSpecialization', payload: { owner: 0, specialization: 'commercial' } },
      { kind: 'establishTradeRoute', payload: { owner: 0, partner: 1 } },
    ]);
    ctx.driver.step(ctx.world, TICK_MS);
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(digestWorld(restored)).toBe(before);
    expect((getPlayer(restored.city, 0) as PlayerState).specialization).toBe('commercial');
    expect(restored.city.tradeRoutes).toHaveLength(1);
  });

  it('determinism: same trade setup, same digest', () => {
    const run = (): number => {
      const ctx = setup(70707);
      completed(ctx, 'shop', 0);
      completed(ctx, 'shop', 1);
      enqueue(ctx, [
        { kind: 'setSpecialization', payload: { owner: 0, specialization: 'commercial' } },
        { kind: 'establishTradeRoute', payload: { owner: 0, partner: 1 } },
      ]);
      for (let i = 0; i < 90; i++) ctx.driver.step(ctx.world, TICK_MS);
      return digestWorld(ctx.world);
    };
    expect(run()).toBe(run());
  });
});
