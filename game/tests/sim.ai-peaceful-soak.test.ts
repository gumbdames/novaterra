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
 * NOVATERRA — peaceful-mode AI soak tests (grand-expansion Phase 8,
 * workstream C).
 *
 * Marshal-vs-marshal on a peaceful world with the full system stack.
 * In a peaceful world the Classic AI plays a city-builder toward the
 * peaceful victory (8,000 housed residents + non-negative treasury,
 * sim/peaceful.ts): it paints districts, places real physical
 * buildings through the validated command queue, researches the
 * civilian upgrades, and never touches a military branch.
 *
 * Marshal-vs-marshal is the deliberate difficulty choice: marshal has
 * the fastest think cadence (30 ticks), so it exercises the most
 * thinks per soak — the strongest demonstration of city growth.
 *
 * Asserts:
 *  - no crashes over 3600 ticks (AI thinks + economy + city systems);
 *  - both AI cities grow real population and keep a non-negative
 *    treasury (the peaceful victory's two legs);
 *  - zero rejected AI orders of any kind — nothing goes stale at
 *    apply, and no military order is even formed (canTrain gates
 *    military defs; the peaceful dispatch in createAISystem skips every
 *    military think branch; thinkIntel/thinkSuperweapons hard-return);
 *  - digest-stable across a mid-soak save/load;
 *  - same seed ⇒ identical digest (determinism with AI city-building).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
  type CommandQueue,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  registerCityCommands,
  MAP_HALF_SIZE,
  BUILDING_DEFS,
  getPlayer,
} from '../src/sim/city';
import { registerUnitCommands } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { createEconomySystem } from '../src/sim/economy';
import { registerAgeCommands } from '../src/sim/ages';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';

interface Rejection {
  kind: string;
  reason: string;
}

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
  rejections: Rejection[];
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 60; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > MAP_HALF_SIZE - 1 || Math.abs(cz) > MAP_HALF_SIZE - 1) continue;
        if (!isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no land near ${x},${z}`);
}

/**
 * Two-marshal peaceful game. The AI rival keeps playing — peacefully
 * (ui/session.ts sets world.peaceful at tick 0 the same way; the flag
 * is set here before the first tick, never toggled mid-game).
 */
function setupPeacefulSoak(seed: number): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  world.peaceful = true;
  const baseW = findLandNear(terrain, -110, 0);
  const baseE = findLandNear(terrain, 110, 0);
  addAIPlayer(world, 0, 'marshal', baseW.x, baseW.z);
  addAIPlayer(world, 1, 'marshal', baseE.x, baseE.z);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerAgeCommands(queue);
  // Count every loud rejection the AI eats: the AI's `issue` wrapper
  // swallows CommandRejectedError, so wrap enqueue to observe them.
  // The wrapper rethrows, so `issue` still swallows exactly as in-game.
  const rejections: Rejection[] = [];
  const rawEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = ((w: World, cmd: { kind: string; issuer?: string }) => {
    try {
      rawEnqueue(w, cmd as never);
    } catch (e) {
      if (e instanceof CommandRejectedError && cmd.issuer === 'ai') {
        rejections.push({ kind: cmd.kind, reason: e.message });
      }
      throw e;
    }
  }) as typeof queue.enqueue;
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
      // The peaceful AI needs the terrain to site physical buildings.
      createAISystem(queue, terrain),
    ],
  });
  return { terrain, world, queue, driver, rejections };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

/** Population, treasury, and AI-owned building counts for one owner. */
function cityStats(world: World, owner: number): { pop: number; funds: number; buildings: number; military: number; operational: number } {
  const player = getPlayer(world.city, owner);
  let buildings = 0;
  let military = 0;
  let operational = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== owner) continue;
    buildings++;
    if (BUILDING_DEFS[b.kind].military === true) military++;
    if (b.operational && b.progress >= 1) operational++;
  }
  return { pop: player ? player.population : 0, funds: player ? player.funds : 0, buildings, military, operational };
}

// The peaceful victory needs 8,000 housed residents — a long game.
// The 3600-tick (120 sim-second) soak pins that both AI cities are
// well underway: this floor was measured, not chosen (see the
// workstream C section of docs/research/phase8-civilian-peaceful.md).
const SOAK_TICKS = 3600;
// Measured 2026-10-05 (Fix 3): the AI reaches 4-5 pop in 120s (3600
// ticks) across seeds 7/8/9. Population now comes from immigration
// (≈1/30/s × migration pull — the demand engine behind demand-gated
// housing), not from house completions. The 8000-resident victory is
// a long game (the income engine needs ~15 minutes to fund the
// housing wave); the soak verifies the AI builds a working city and
// population grows from zero via immigration, not the full victory.
// Threshold 3 keeps the test green across the measured seed variance.
const SOAK_MIN_POPULATION = 3;

describe('peaceful AI soak (marshal vs marshal)', () => {
  it('grows both cities with zero rejected AI orders', () => {
    const ctx = setupPeacefulSoak(7);
    runTicks(ctx, SOAK_TICKS);
    for (const owner of [0, 1]) {
      const s = cityStats(ctx.world, owner);
      expect(s.buildings).toBeGreaterThan(0);
      expect(s.military).toBe(0);
      expect(s.pop).toBeGreaterThan(SOAK_MIN_POPULATION);
      // Phase 9 death-spiral fix: the treasury must stay POSITIVE, not
      // just non-negative. The old code hit exactly 0 (upkeep shutoff
      // darkened the power/water, income collapsed, permanent stall).
      // The peacefulTreasuryFloor + paced fuel build keep funds > 0.
      expect(s.funds).toBeGreaterThan(0);
      // Most completed buildings stay operational (funded upkeep +
      // powered + watered). If the city is starving, buildings go dark.
      expect(s.operational).toBeGreaterThanOrEqual(Math.floor(s.buildings * 0.8));
    }
    // No military order may even be formed: canTrain gates military
    // defs and the peaceful dispatch skips every military think.
    const militaryRejections = ctx.rejections.filter(
      (r) => r.kind === 'trainUnit' || r.kind === 'spawnUnit' || /military/i.test(r.reason),
    );
    expect(militaryRejections).toEqual([]);
    // And nothing else went stale either — the per-think ledger and
    // validatePlacement pre-checks keep the whole batch clean.
    expect(ctx.rejections).toEqual([]);
  });

  it('same seed => identical digest', () => {
    const run = (seed: number): number => {
      const ctx = setupPeacefulSoak(seed);
      runTicks(ctx, SOAK_TICKS);
      return digestWorld(ctx.world);
    };
    expect(run(42)).toBe(run(42));
  });

  it('mid-soak save/load is digest-stable', () => {
    const ctx = setupPeacefulSoak(99);
    // Run 1801 ticks: marshal thinks every 30 ticks, so tick 1800 is a
    // think tick with commands queued for 1801. Snapshotting at 1800
    // would lose those queued commands (the queue isn't snapshotted).
    // One more tick applies them, so the snapshot is clean.
    runTicks(ctx, SOAK_TICKS / 2 + 1);
    const snap = takeSnapshot(ctx.world);
    runTicks(ctx, SOAK_TICKS / 2);
    const continued = digestWorld(ctx.world);

    const restored = restoreSnapshot(snap);
    expect(restored.peaceful).toBe(true);
    const queue2 = createCommandQueue();
    registerCoreCommands(queue2);
    registerCityCommands(queue2, ctx.terrain);
    registerUnitCommands(queue2, ctx.terrain);
    registerMovementCommands(queue2, ctx.terrain);
    registerCombatCommands(queue2);
    registerAgeCommands(queue2);
    const driver2 = createTickDriver({
      queue: queue2,
      systems: [
        createPathfindingSystem(ctx.terrain),
        createMovementSystem(ctx.terrain),
        createCombatSystem(),
        createEconomySystem(ctx.terrain),
        createAISystem(queue2, ctx.terrain),
      ],
    });
    for (let i = 0; i < SOAK_TICKS / 2; i++) driver2.step(restored, TICK_MS);
    expect(digestWorld(restored)).toBe(continued);
  });
});
