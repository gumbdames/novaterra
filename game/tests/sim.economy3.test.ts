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

