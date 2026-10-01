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
 * Roadmap B9 (repeatable research, 2026-10-02): 'advancedResearch' is
 * the first repeatable upgrade — the endgame research sink. Each level
 * costs 200×level research and adds +2% factory output. Levels live on
 * `world.upgradeLevels` (owner -> id -> level), never in the
 * `world.upgrades` id list.
 *
 * Covers: the def, the level-scaled cost helper, the researchUpgrade
 * command flow (no duplicate rejection, per-level deduction), the
 * factory-output multiplier (pure + economy integration), snapshot
 * round-trip, digest sensitivity, and the UI mirrors (availability,
 * display name, cost line).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { getAgeState } from '../src/sim/ages';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  CITY_GRID_CELLS,
  cellIndex,
  cellIsWater,
  getPlayer,
  placeBuilding,
  registerCityCommands,
  type CityState,
  type Placement,
} from '../src/sim/city';
import {
  UPGRADE_DEFS,
  UPGRADE_IDS,
  hasUpgrade,
  registerUpgradeCommands,
  repeatableUpgradeLevel,
  upgradeResearchCost,
  advancedResearchFactoryMult,
  ADVANCED_RESEARCH_RESEARCH_PER_LEVEL,
  ADVANCED_RESEARCH_FACTORY_OUTPUT_PER_LEVEL,
} from '../src/sim/upgrades';
import {
  createEconomySystem,
  registerEconomyCommands,
  runEconomyTick,
} from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot, type Snapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { addAIPlayer, createAISystem, initAI } from '../src/sim/ai';
import { registerAgeCommands } from '../src/sim/ages';
import { registerUnitCommands } from '../src/sim/units';
import {
  upgradeAvailability,
  upgradeDisplayName,
  formatResearchCostFor,
} from '../src/ui/palettes';
import { completeBuilding } from './sim.roster-fixtures';

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

function setup(seed = 20261002): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.tick = 150;
  world.time = 150 / 30;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  registerUpgradeCommands(queue);
  const driver = createTickDriver({ queue, systems: [createEconomySystem(terrain)] });
  return { terrain, world, queue, driver };
}

function enq(ctx: Ctx, kind: string, payload: Record<string, unknown>): void {
  const cmd: NewCommand = { issuer: 'player', kind, payload };
  ctx.queue.enqueue(ctx.world, cmd);
}

function rejectionReason(
  ctx: Ctx,
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  try {
    enq(ctx, kind, payload);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).message;
  }
}

/** Lab + information age + deep pockets: the repeatable-research fixture. */
function researchCtx(): Ctx {
  const ctx = setup();
  completeBuilding(ctx.world, 'lab', 0, 10, 10);
  getAgeState(ctx.world, 0).age = 'information';
  const player = getPlayer(ctx.world.city, 0)!;
  player.funds = 100000;
  player.research = 100000;
  return ctx;
}

function tick(ctx: Ctx, n = 1): void {
  for (let i = 0; i < n; i += 1) ctx.driver.step(ctx.world, TICK_MS);
}

describe('advancedResearch def', () => {
  it('is the registered repeatable, civilian, information-age research sink', () => {
    expect(UPGRADE_IDS).toContain('advancedResearch');
    const def = UPGRADE_DEFS.advancedResearch;
    expect(def.repeatable).toBe(true);
    expect(def.military).toBeUndefined();
    expect(def.minAge).toBe('information');
    // The only repeatable upgrade in the roster.
    for (const id of UPGRADE_IDS) {
      if (id === 'advancedResearch') continue;
      expect(UPGRADE_DEFS[id].repeatable ?? false).toBe(false);
    }
  });
});

describe('upgradeResearchCost (level-scaled pricing)', () => {
  it('prices the next level at 200×level research, zero funds', () => {
    const ctx = researchCtx();
    expect(ADVANCED_RESEARCH_RESEARCH_PER_LEVEL).toBe(200);
    expect(upgradeResearchCost(ctx.world, 0, 'advancedResearch')).toEqual({
      costFunds: 0,
      costResearch: 200,
    });
    ctx.world.upgradeLevels[0] = { advancedResearch: 2 };
    expect(upgradeResearchCost(ctx.world, 0, 'advancedResearch')).toEqual({
      costFunds: 0,
      costResearch: 600,
    });
  });

  it('returns the static def cost for one-shot upgrades', () => {
    const ctx = researchCtx();
    expect(upgradeResearchCost(ctx.world, 0, 'apRounds')).toEqual({
      costFunds: 800,
      costResearch: 60,
    });
  });
});

describe('researchUpgrade command — repeatable flow', () => {
  it('researches level after level with no duplicate rejection, deducting 200×level', () => {
    const ctx = researchCtx();
    const player = getPlayer(ctx.world.city, 0)!;
    tick(ctx, 1); // absorb the one economy pulse (lab research income)
    const base = player.research;
    enq(ctx, 'researchUpgrade', { owner: 0, upgrade: 'advancedResearch' });
    tick(ctx, 1);
    expect(repeatableUpgradeLevel(ctx.world, 0, 'advancedResearch')).toBe(1);
    expect(player.research).toBe(base - 200);
    // hasUpgrade never covers repeatable upgrades; the id list is untouched.
    expect(hasUpgrade(ctx.world, 0, 'advancedResearch')).toBe(false);
    expect(ctx.world.upgrades[0] ?? []).not.toContain('advancedResearch');
    // Second level: no "already researched" rejection, costs 400.
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'advancedResearch' }),
    ).toBeNull();
    tick(ctx, 1);
    expect(repeatableUpgradeLevel(ctx.world, 0, 'advancedResearch')).toBe(2);
    expect(player.research).toBe(base - 200 - 400);
  });

  it('rejects when research cannot cover the next level', () => {
    const ctx = researchCtx();
    ctx.world.upgradeLevels[0] = { advancedResearch: 2 }; // next: 600
    const player = getPlayer(ctx.world.city, 0)!;
    player.research = 599;
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'advancedResearch' }),
    ).toMatch(/cannot afford/);
    player.research = 600;
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'advancedResearch' }),
    ).toBeNull();
  });

  it('still requires a completed lab and the information age', () => {
    const ctx = setup();
    getAgeState(ctx.world, 0).age = 'information';
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 100000;
    player.research = 100000;
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'advancedResearch' }),
    ).toMatch(/requires a completed Research Lab/);
    completeBuilding(ctx.world, 'lab', 0, 10, 10);
    getAgeState(ctx.world, 0).age = 'industry';
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'advancedResearch' }),
    ).toMatch(/requires the information age/);
  });
});

describe('advancedResearchFactoryMult', () => {
  it('is 1 + 2% per level', () => {
    expect(ADVANCED_RESEARCH_FACTORY_OUTPUT_PER_LEVEL).toBe(0.02);
    const ctx = researchCtx();
    expect(advancedResearchFactoryMult(ctx.world, 0)).toBe(1);
    ctx.world.upgradeLevels[0] = { advancedResearch: 1 };
    expect(advancedResearchFactoryMult(ctx.world, 0)).toBeCloseTo(1.02, 12);
    ctx.world.upgradeLevels[0] = { advancedResearch: 5 };
    expect(advancedResearchFactoryMult(ctx.world, 0)).toBeCloseTo(1.1, 12);
  });
});

describe('economy integration — factory output scales with the level', () => {
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

  /** Powered + watered factory on a road-fed cluster; fuel stocked. */
  function factoryWorld(seed: number, level: number): Ctx {
    const ctx = setup(seed);
    const { cx, cz } = findLandRect(ctx.terrain, 14, 8);
    for (let i = 0; i < 14; i++) {
      const cell = cellIndex(cx + i, cz + 4);
      if (!ctx.world.city.roads.some((r) => r.cell === cell)) {
        ctx.world.city.roads.push({ cell, cls: 'paved' });
      }
    }
    const place = (kind: 'factory' | 'powerPlant' | 'waterPump', dx: number): void => {
      const b = placeBuilding(ctx.world.city, { kind, owner: 0, cx: cx + dx, cz: cz + 5, facing: 0 });
      b.progress = 1;
    };
    place('factory', 0);
    place('powerPlant', 4);
    place('waterPump', 9);
    const player = getPlayer(ctx.world.city, 0)!;
    player.fuel = 100000;
    player.goods = 0;
    if (level > 0) ctx.world.upgradeLevels[0] = { advancedResearch: level };
    return ctx;
  }

  function runEconomySeconds(ctx: Ctx, seconds: number): void {
    ctx.world.tick = 0;
    ctx.world.time = 0;
    for (let s = 0; s < seconds; s++) {
      ctx.world.tick += 30;
      runEconomyTick(ctx.world, ctx.terrain);
    }
  }

  it('a level-5 factory makes exactly 10% more goods than a level-0 one', () => {
    const plain = factoryWorld(77, 0);
    const boosted = factoryWorld(77, 5);
    runEconomySeconds(plain, 120);
    runEconomySeconds(boosted, 120);
    const factoryPlain = plain.world.city.buildings.find((b) => b.kind === 'factory')!;
    expect(factoryPlain.powered).toBe(true);
    expect(factoryPlain.watered).toBe(true);
    const goodsPlain = getPlayer(plain.world.city, 0)!.goods;
    const goodsBoosted = getPlayer(boosted.world.city, 0)!.goods;
    expect(goodsPlain).toBeGreaterThan(0);
    // Identical setups differ only in the upgrade level: the ratio is
    // exactly the multiplier ratio (1.10 / 1.00).
    expect(goodsBoosted / goodsPlain).toBeCloseTo(1.1, 6);
  });
});

describe('AI takes Advanced Research as the fixed-last sink', () => {
  const ONE_SHOTS = UPGRADE_IDS.filter((id) => UPGRADE_DEFS[id].repeatable !== true);

  /** Commander AI, information age, virtual lab, deep research stockpile. */
  function aiSinkWorld(seed: number): { world: World; queue: CommandQueue } {
    const world = createWorld(seed);
    world.ai = initAI();
    addAIPlayer(world, 1, 'commander', 100, 100);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerAgeCommands(queue);
    const terrain = generateTerrain(seed);
    registerUnitCommands(queue, terrain);
    registerUpgradeCommands(queue);
    const player = getPlayer(world.city, 1)!;
    player.funds = 1_000_000;
    player.research = 1_000_000;
    getAgeState(world, 1).age = 'information';
    const ai = world.ai.players[0]!;
    ai.virtualBuildings.completed.push('lab');
    return { world, queue };
  }

  function runOneThink(world: World, queue: CommandQueue): void {
    const ai = world.ai.players[0]!;
    ai.nextThinkTick = 0;
    world.tick = 0;
    createAISystem(queue)(world, 1 / 30);
    queue.applyDue(world, 0);
  }

  it('is excluded from the personality research shuffle', () => {
    const { world } = aiSinkWorld(4242);
    const order = world.ai.players[0]!.personality.researchOrder;
    expect(order).not.toContain('advancedResearch');
    // The tail stays a permutation of the 5 economy upgrades.
    expect(order.length).toBe(5);
    for (const id of order) {
      expect(UPGRADE_DEFS[id].repeatable ?? false).toBe(false);
    }
  });

  it('researches level 1 once all 21 one-shots are done', () => {
    const { world, queue } = aiSinkWorld(4242);
    world.upgrades[1] = [...ONE_SHOTS];
    runOneThink(world, queue);
    expect(repeatableUpgradeLevel(world, 1, 'advancedResearch')).toBe(1);
    // The id list is untouched — the sink never pollutes the researched set.
    expect(world.upgrades[1]).toEqual([...ONE_SHOTS]);
  });

  it('never takes the sink while one-shots remain', () => {
    const { world, queue } = aiSinkWorld(4242);
    runOneThink(world, queue);
    expect(repeatableUpgradeLevel(world, 1, 'advancedResearch')).toBe(0);
    expect((world.upgrades[1] ?? []).length).toBe(1);
  });
});

describe('snapshot + digest', () => {
  it('round-trips repeatable levels through save/restore', () => {
    const ctx = researchCtx();
    ctx.world.upgradeLevels[0] = { advancedResearch: 3 };
    ctx.world.upgradeLevels[1] = { advancedResearch: 1 };
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(repeatableUpgradeLevel(restored, 0, 'advancedResearch')).toBe(3);
    expect(repeatableUpgradeLevel(restored, 1, 'advancedResearch')).toBe(1);
    expect(repeatableUpgradeLevel(restored, 2, 'advancedResearch')).toBe(0);
  });

  it('drops malformed levels defensively (unknown ids, non-repeatable ids, junk)', () => {
    const ctx = setup();
    const snap = takeSnapshot(ctx.world);
    const tampered = {
      ...snap,
      upgradeLevels: {
        0: { advancedResearch: 2, apRounds: 1, nope: 3, advancedResearch2: -1 },
      },
    } as Snapshot;
    const restored = restoreSnapshot(tampered);
    expect(repeatableUpgradeLevel(restored, 0, 'advancedResearch')).toBe(2);
    expect(Object.keys(restored.upgradeLevels[0] ?? {})).toEqual(['advancedResearch']);
  });

  it('is digest-sensitive to the level and stable for equal levels', () => {
    const a = researchCtx();
    const b = researchCtx();
    a.world.upgradeLevels[0] = { advancedResearch: 4 };
    b.world.upgradeLevels[0] = { advancedResearch: 4 };
    const c = researchCtx();
    c.world.upgradeLevels[0] = { advancedResearch: 5 };
    expect(digestWorld(b.world)).toBe(digestWorld(a.world));
    expect(digestWorld(c.world)).not.toBe(digestWorld(a.world));
  });
});

describe('UI mirrors (palettes.ts)', () => {
  function uiWorld(level: number, research: number): World {
    const world = createWorld(20261002);
    completeBuilding(world, 'lab', 0, 10, 10);
    getAgeState(world, 0).age = 'information';
    const player = getPlayer(world.city, 0)!;
    player.funds = 100000;
    player.research = research;
    if (level > 0) world.upgradeLevels[0] = { advancedResearch: level };
    return world;
  }

  it('availability is ready at every level — never "researched"', () => {
    expect(upgradeAvailability(uiWorld(0, 100000), 0, 'advancedResearch').state).toBe('ready');
    const lvl2 = upgradeAvailability(uiWorld(2, 100000), 0, 'advancedResearch');
    expect(lvl2.state).toBe('ready');
    expect(lvl2.reason).toBe('');
  });

  it('locks when research cannot cover the next level', () => {
    const st = upgradeAvailability(uiWorld(2, 599), 0, 'advancedResearch');
    expect(st.state).toBe('locked');
    expect(st.reason.length).toBeGreaterThan(0);
  });

  it('shows the level in the display name', () => {
    expect(upgradeDisplayName(uiWorld(0, 0), 0, 'advancedResearch')).toBe('Advanced Research');
    expect(upgradeDisplayName(uiWorld(2, 0), 0, 'advancedResearch')).toBe('Advanced Research · Lv 2');
  });

  it('shows the level-scaled cost line', () => {
    expect(formatResearchCostFor(uiWorld(0, 0), 0, 'advancedResearch')).toBe('200 research');
    expect(formatResearchCostFor(uiWorld(2, 0), 0, 'advancedResearch')).toBe('600 research');
  });
});
