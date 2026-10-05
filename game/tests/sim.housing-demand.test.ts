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
 * Fix 3 (demand + utility-gated housing) tests (2026-10-05).
 *
 * Residential growth is gated on three conditions: unhoused demand
 * (`player.unhousedPopulation > 0`), the sampled cell's zone region
 * being served by the owner's power AND water networks, and positive
 * utility headroom. Immigration (≈1 person / 30 sim-s at pull 1.0)
 * feeds the demand pool; arrivals fill free residential capacity
 * first and the overflow becomes unhoused. The peaceful AI's housing
 * is demand-gated the same way.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS, isWater, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  ZoneType,
  cellIndex,
  cellIsWater,
  getPlayer,
  registerCityCommands,
  runGrowth,
} from '../src/sim/city';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import { createEconomySystem, runEconomyTick } from '../src/sim/economy';
import { type UtilityModel } from '../src/sim/utilityNetworks';
import { digestWorld } from '../src/sim/digest';
import {
  addAIPlayer,
  createAISystem,
  thinkPeacefulConstruction,
  type AIPlayerState,
} from '../src/sim/ai';
import { completeBuilding } from './sim.roster-fixtures';
import {
  emptyUtilityModel,
  injectDemand,
  paintResidentialForTest,
  serveRegionForTest,
} from './sim.housing-fixtures';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
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

interface GrowthCtx {
  terrain: TerrainData;
  world: World;
  zoneCells: number[];
  model: UtilityModel;
}

/** Funded city, residential zone painted (by owner 0), region served. */
function growthCtx(seed: number): GrowthCtx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const { cx, cz } = findLandRect(terrain, 20, 8);
  const zoneCells = paintResidentialForTest(world, 0, cx, cz, cx + 19, cz + 7);
  const p = getPlayer(world.city, 0);
  if (!p) throw new Error('no player 0');
  p.funds = 100000;
  p.materials = 100000;
  const model = serveRegionForTest(world, 0, zoneCells);
  return { terrain, world, zoneCells, model };
}

/** Residential buildings owned by owner 0 (excludes the fixture plants). */
function residentialOf(world: World, owner: number): number {
  return world.city.buildings.filter(
    (b) => b.owner === owner && BUILDING_DEFS[b.kind].zone === ZoneType.RESIDENTIAL,
  ).length;
}

function runPulses(ctx: GrowthCtx, n: number, headroom: number): void {
  for (let i = 0; i < n; i++) {
    ctx.world.tick += 300;
    runGrowth(ctx.terrain, ctx.world, [headroom], [headroom], ctx.model);
  }
}

describe('demand-gated housing (Fix 3)', () => {
  it('(1) a house auto-develops on a served residential cell with unhoused demand', () => {
    const ctx = growthCtx(101);
    injectDemand(ctx.world, 0, 50);
    runPulses(ctx, 5, 100);
    expect(residentialOf(ctx.world, 0)).toBeGreaterThan(0);
  });

  it('(2) NO growth with unhoused = 0 despite a served region and funds', () => {
    const ctx = growthCtx(102);
    // Same served, funded setup as (1) — the ONLY difference is demand.
    // unhousedPopulation starts at 0 (AD9 default).
    runPulses(ctx, 5, 100);
    expect(residentialOf(ctx.world, 0)).toBe(0);
  });

  it('(3) NO growth on a region unserved by power or water despite demand', () => {
    const terrain = getTerrain();
    const world = createWorld(103);
    const { cx, cz } = findLandRect(terrain, 20, 8);
    paintResidentialForTest(world, 0, cx, cz, cx + 19, cz + 7);
    const p = getPlayer(world.city, 0);
    if (!p) throw new Error('no player 0');
    p.funds = 100000;
    p.materials = 100000;
    injectDemand(world, 0, 50);
    const model = emptyUtilityModel(world);
    for (let i = 0; i < 5; i++) {
      world.tick += 300;
      runGrowth(terrain, world, [100], [100], model);
    }
    expect(residentialOf(world, 0)).toBe(0);
  });

  it('(3b) NO growth when the region is served by power but NOT water', () => {
    const terrain = getTerrain();
    const world = createWorld(113);
    const { cx, cz } = findLandRect(terrain, 20, 8);
    const zoneCells = paintResidentialForTest(world, 0, cx, cz, cx + 19, cz + 7);
    const p = getPlayer(world.city, 0);
    if (!p) throw new Error('no player 0');
    p.funds = 100000;
    p.materials = 100000;
    injectDemand(world, 0, 50);
    // Power only: the AND in the gate must still block.
    const model = serveRegionForTest(world, 0, zoneCells, 'power');
    for (let i = 0; i < 5; i++) {
      world.tick += 300;
      runGrowth(terrain, world, [100], [100], model);
    }
    expect(residentialOf(world, 0)).toBe(0);
  });

  it('(4) NO growth when headroom is zero despite demand and a served region', () => {
    const ctx = growthCtx(104);
    injectDemand(ctx.world, 0, 50);
    runPulses(ctx, 5, 0);
    expect(residentialOf(ctx.world, 0)).toBe(0);
  });

  it('(5) zero-road growth STILL works on a served region (standing directive 2026-09-30)', () => {
    const ctx = growthCtx(105);
    injectDemand(ctx.world, 0, 50);
    runPulses(ctx, 8, 100);
    // No roads were ever laid — the region rule conducts without them.
    expect(ctx.world.city.roads).toHaveLength(0);
    expect(residentialOf(ctx.world, 0)).toBeGreaterThan(0);
  });

  it('(6) the digest is sensitive to unhousedPopulation and immigrationCarry', () => {
    const world = createWorld(106);
    const p = getPlayer(world.city, 0);
    if (!p) throw new Error('no player 0');
    p.unhousedPopulation = 10;
    p.immigrationCarry = 0.5;
    const before = digestWorld(world);
    p.unhousedPopulation = 11;
    expect(digestWorld(world)).not.toBe(before);
    p.unhousedPopulation = 10;
    p.immigrationCarry = 0.6;
    expect(digestWorld(world)).not.toBe(before);
  });

  it('(7) immigration fills free capacity first; the overflow becomes unhoused', () => {
    const terrain = getTerrain();
    const world = createWorld(107);
    const { cx, cz } = findLandRect(terrain, 20, 8);
    // Painted but deliberately UNSERVED: growth stays blocked, so the
    // only thing moving population is immigration + occupancy.
    paintResidentialForTest(world, 0, cx, cz, cx + 19, cz + 7);
    // One completed house (capacity 6), 4 residents → 2 free beds.
    completeBuilding(world, 'house', 0, cx + 10, cz + 10);
    const p = getPlayer(world.city, 0);
    if (!p) throw new Error('no player 0');
    p.funds = 100000;
    p.materials = 100000;
    p.food = 100000;
    p.population = 4;
    // ~240 sim-seconds of economy ticks: immigration ≈ 240/30 × pull.
    for (let s = 0; s < 240; s++) {
      world.tick += 30;
      runEconomyTick(world, terrain);
    }
    expect(p.population).toBeGreaterThan(4);
    const house = world.city.buildings.find((b) => b.kind === 'house' && b.owner === 0);
    if (!house) throw new Error('house vanished');
    // Free capacity filled first…
    expect(house.residents).toBe(6);
    // …the overflow is unhoused, and the invariant holds.
    expect(p.unhousedPopulation).toBe(p.population - 6);
    expect(p.unhousedPopulation).toBeGreaterThan(0);
  });
});

function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 60; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > 255 || Math.abs(cz) > 255) continue;
        if (!isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no land near ${x},${z}`);
}

describe('peaceful AI demand-gated housing', () => {
  /** Minimal harness: the peaceful AI needs a queue + economy + AI. */
  function peacefulCtx(seed: number): { terrain: TerrainData; world: World; ai: AIPlayerState } {
    const terrain = getTerrain();
    const world = createWorld(seed);
    world.peaceful = true;
    const base = findLandNear(terrain, -110, 0);
    addAIPlayer(world, 0, 'marshal', base.x, base.z, 'classic');
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    const driver = createTickDriver({
      queue,
      systems: [createEconomySystem(terrain), createAISystem(queue, terrain)],
    });
    // Run long enough for the AI to paint districts and think a few
    // times (marshal thinks every 30 ticks).
    for (let i = 0; i < 600; i++) driver.step(world, TICK_MS);
    const ai = world.ai.players.find((a) => a.owner === 0);
    if (!ai) throw new Error('no AI player 0');
    // Complete the AI's engine: the house branch needs engineDone and
    // we don't want to wait out full build times. Mark them
    // operational too, or peacefulNeedKinds keeps ordering replacement
    // utilities instead of housing. (The AI builds its own 2 factories
    // in 600 ticks — no need to add more.)
    for (const b of world.city.buildings) {
      if (b.owner === 0) {
        b.progress = 1;
        b.operational = true;
        b.powered = true;
        b.watered = true;
      }
    }
    return { terrain, world, ai };
  }

  it('(8a) the AI builds NO house without unhoused demand', () => {
    const { terrain, world, ai } = peacefulCtx(108);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('no player 0');
    player.funds = 100000;
    player.materials = 100000;
    player.unhousedPopulation = 0;
    // The AI painted its own residential district during peacefulCtx —
    // the gate, not siting, must block. (It may still build non-house
    // kinds for its needs; only houses are demand-gated.)
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    thinkPeacefulConstruction(world, queue, ai, terrain);
    queue.applyDue(world, world.tick);
    const houses = world.city.buildings.filter(
      (b) => b.owner === 0 && b.kind === 'house',
    ).length;
    expect(houses).toBe(0);
  });

  it('(8b) the AI builds a house when unhoused demand exists', () => {
    const { terrain, world, ai } = peacefulCtx(109);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('no player 0');
    player.funds = 100000;
    player.materials = 100000;
    player.unhousedPopulation = 20;
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    thinkPeacefulConstruction(world, queue, ai, terrain);
    queue.applyDue(world, world.tick);
    const houses = world.city.buildings.filter(
      (b) => b.owner === 0 && b.kind === 'house',
    ).length;
    expect(houses).toBeGreaterThan(0);
  });

  it('(8c) soak: the peaceful AI grows population via immigration (demand-gated)', () => {
    const terrain = getTerrain();
    const world = createWorld(110);
    world.peaceful = true;
    const base = findLandNear(terrain, -110, 0);
    addAIPlayer(world, 0, 'marshal', base.x, base.z, 'classic');
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    const driver = createTickDriver({
      queue,
      systems: [createEconomySystem(terrain), createAISystem(queue, terrain)],
    });
    // 7200 ticks = 240 sim-seconds: districts painted, immigration
    // accumulates (~240/30 × pull arrivals).
    for (let i = 0; i < 7200; i++) driver.step(world, TICK_MS);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('no player 0');
    // Immigration gave it population (the classic AI stays at 0).
    expect(player.population).toBeGreaterThan(0);
    // Fund it: the opening build leaves the treasury thin, and the
    // demand gate needs funds ≥ 500 to fire. This isolates the gate
    // from the AI's (slow) income ramp.
    player.funds = 100000;
    player.materials = 100000;
    for (let i = 0; i < 600; i++) driver.step(world, TICK_MS);
    // The demand gate fired: houses exist for the demand…
    const houses = world.city.buildings.filter(
      (b) => b.owner === 0 && (b.kind === 'house' || b.kind === 'apartment'),
    ).length;
    expect(houses).toBeGreaterThan(0);
    // …and the housed + unhoused invariant holds.
    const housed = world.city.buildings
      .filter((b) => b.owner === 0)
      .reduce((sum, b) => sum + (b.residents ?? 0), 0);
    expect(housed + player.unhousedPopulation).toBe(player.population);
  });
});
