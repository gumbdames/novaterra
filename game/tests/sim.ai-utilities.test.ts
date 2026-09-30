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
 * NOVATERRA — Classic AI + utility networks (grand-expansion Phase 2).
 *
 * Pins the Phase 2 "Deployable when" AI verdict (§AD2): the Classic AI
 * owns NO physical buildings in 0.1 Alpha — every production building is
 * virtual (a kind name in `ai.virtualBuildings.completed`, no footprint,
 * no grid position) — so a "stranded plant" can never arise for it and
 * there is nothing to connect with lines. The AI therefore stays on the
 * global utility pool: virtual-building output is credited
 * unconditionally by `creditVirtualEconomy`, and the pool allocator
 * (`allocateUtilities`) serves every completed funded physical plant
 * regardless of owner or network state.
 *
 * The sim workstream's flood-fill rewrite (powerDiag/waterDiag network
 * state) was not yet committed when these tests were written, so the
 * stranded-plant heuristic could not be wired without inventing field
 * names — explicitly forbidden. `thinkUtilityConnections` (ai.ts) is the
 * documented no-op hook for that future work. These tests pin the
 * fallback behavior it relies on:
 *  - virtual buildings produce output with no networks/lines present;
 *  - the pool allocator is owner-blind (AI-owned physical buildings get
 *    power/water exactly like anyone's);
 *  - the utility sub-phase draws no RNG and changes no AI state;
 *  - same seed ⇒ identical digest with utilities + AI in play;
 *  - save/load round-trips preserve powered/watered + AI state exactly.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
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
  MAP_HALF_SIZE,
  getPlayer,
  placeBuilding,
  BUILDING_DEFS,
  type BuildingKind,
  type Placement,
} from '../src/sim/city';
import {
  createEconomySystem,
  runEconomyTick,
  marketBuyCost,
  marketSellValue,
} from '../src/sim/economy';
import { registerUnitCommands } from '../src/sim/units';
import { registerMovementCommands } from '../src/sim/movement';
import { registerCombatCommands } from '../src/sim/combat';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { grantAllTrainingResources } from './sim.roster-fixtures';

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

function setup(seed: number): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [createEconomySystem(terrain), createAISystem(queue)],
  });
  return { terrain, world, queue, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

/** Spiral out from (x, z) for the nearest land point (deterministic). */
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

/** Directly place a completed physical building (bypasses validation). */
function completed(world: World, kind: BuildingKind, owner: number, cx: number, cz: number) {
  const p: Placement = { kind, owner, cx, cz, facing: 0 };
  const b = placeBuilding(world.city, p);
  b.progress = 1;
  return b;
}

function aiOf(world: World, owner = 1) {
  const ai = world.ai.players.find((p) => p.owner === owner);
  expect(ai).toBeDefined();
  return ai!;
}

describe('AD2 fallback: virtual buildings need no network', () => {
  it('a completed virtual lab yields research income with no lines/networks present', () => {
    const mk = (withLab: boolean) => {
      const ctx = setup(4242);
      const base = findLandNear(ctx.terrain, -100, -100);
      // Cadet never researches upgrades, so research is never spent —
      // the delta below is exactly the virtual lab's output.
      addAIPlayer(ctx.world, 1, 'cadet', base.x, base.z);
      if (withLab) aiOf(ctx.world).virtualBuildings.completed.push('lab');
      return ctx;
    };
    const labRate = BUILDING_DEFS.lab.output.research ?? 0;
    expect(labRate).toBeGreaterThan(0);
    const a = mk(true);
    const b = mk(false);
    const r0a = getPlayer(a.world.city, 1)!.research;
    const r0b = getPlayer(b.world.city, 1)!.research;
    // 30 sim-seconds of economy (cadet thinks twice in this window; both
    // worlds think identically, so growth/taxes cancel out in the delta).
    runTicks(a, 900);
    runTicks(b, 900);
    const gained =
      getPlayer(a.world.city, 1)!.research - r0a -
      (getPlayer(b.world.city, 1)!.research - r0b);
    expect(gained).toBeCloseTo(labRate * 30, 9);
  });

  it('the pool allocator is owner-blind: AI-owned physical buildings get power/water', () => {
    const ctx = setup(777);
    // The pool is per-player: each owner needs their own plant. The pin
    // is that the allocator applies identical rules to every owner.
    const aiPlant = completed(ctx.world, 'powerPlant', 1, 10, 10);
    const aiFactory = completed(ctx.world, 'factory', 1, 14, 10);
    const humanPlant = completed(ctx.world, 'powerPlant', 0, 20, 20);
    const humanFactory = completed(ctx.world, 'factory', 0, 24, 10);
    expect(BUILDING_DEFS.powerPlant.powerSupply).toBeGreaterThan(
      BUILDING_DEFS.factory.powerDemand,
    );
    runEconomyTick(ctx.world, ctx.terrain);
    expect(aiPlant.powered).toBe(true);
    expect(humanPlant.powered).toBe(true);
    // The AI's factory is powered exactly like the human's — no network
    // membership, no road, no line required (the AD2 pool fallback).
    expect(aiFactory.powered).toBe(true);
    expect(aiFactory.powered).toBe(humanFactory.powered);
  });

  it('shortage still allocates in id order with no networks (brownout is local, not AI-specific)', () => {
    const ctx = setup(778);
    // powerPlant is steady output; solarFarm is day-only since the
    // Phase 2 network model (intermittency), which would couple this
    // id-order pin to the time of day. One plant, six hungry factories:
    // 25 supply < 30 demand.
    completed(ctx.world, 'powerPlant', 1, 10, 10);
    const f1 = completed(ctx.world, 'factory', 1, 14, 10);
    const f2 = completed(ctx.world, 'factory', 1, 18, 10);
    const f3 = completed(ctx.world, 'factory', 1, 22, 10);
    const f4 = completed(ctx.world, 'factory', 1, 26, 10);
    const f5 = completed(ctx.world, 'factory', 1, 30, 10);
    const f6 = completed(ctx.world, 'factory', 1, 34, 10);
    const supply = BUILDING_DEFS.powerPlant.powerSupply;
    const demand = BUILDING_DEFS.factory.powerDemand;
    expect(supply).toBeLessThan(6 * demand);
    expect(supply).toBeGreaterThanOrEqual(5 * demand);
    runEconomyTick(ctx.world, ctx.terrain);
    const factories = [f1, f2, f3, f4, f5, f6];
    const powered = factories.filter((f) => f.powered).length;
    expect(powered).toBe(Math.floor(supply / demand));
    // Id order: the lowest-id demanders win, deterministically.
    const ids = factories.map((f) => f.id).sort((x, y) => x - y);
    const winners = factories.filter((f) => f.powered).map((f) => f.id);
    expect(winners).toEqual(ids.slice(0, winners.length));
  });
});

describe('thinkUtilityConnections: the documented no-op', () => {
  it('the AI owns no physical buildings after a long run (the verdict premise)', () => {
    const ctx = setup(4242);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    runTicks(ctx, 3600);
    const physical = ctx.world.city.buildings.filter((b) => b.owner === 1);
    expect(physical).toEqual([]);
    // ...but it did build virtually (construction still progresses).
    expect(aiOf(ctx.world).virtualBuildings.completed.length).toBeGreaterThan(0);
  });

  it('the utility sub-phase draws no RNG and mutates no AI state by itself', () => {
    const ctx = setup(4242);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    const rngBefore = ctx.world.rng['ai-1'];
    const aiBefore = JSON.stringify(ctx.world.ai.players[0]);
    // 1500 ticks: the commander's first virtual barracks completes at
    // tick 1260 (40s build time), so construction visibly progresses.
    runTicks(ctx, 1500);
    // Thinks ran (commander cadence 60), yet the named stream is frozen —
    // think functions, including the utility sub-phase, draw nothing.
    expect(ctx.world.rng['ai-1']).toBe(rngBefore);
    // AI state changed only through the normal construction path
    // (virtualBuildings), never through utility decisions.
    const aiAfter = ctx.world.ai.players[0]!;
    expect(aiAfter.virtualBuildings.completed).not.toEqual(
      JSON.parse(aiBefore).virtualBuildings.completed,
    );
  });
});

describe('determinism with utilities + AI', () => {
  function build(seed: number): Ctx {
    const ctx = setup(seed);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    // A physical city for the human slot exercises the pool allocator
    // alongside the AI's virtual economy.
    completed(ctx.world, 'powerPlant', 0, 20, 20);
    completed(ctx.world, 'waterPump', 0, 26, 20);
    completed(ctx.world, 'factory', 0, 32, 20);
    completed(ctx.world, 'farm', 0, 38, 20);
    return ctx;
  }
  it('same seed ⇒ bit-identical digest over 1500 ticks', () => {
    const a = build(20260930);
    const b = build(20260930);
    runTicks(a, 1500);
    runTicks(b, 1500);
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
  });
  it('different seeds ⇒ different digests (the run is not degenerate)', () => {
    const a = build(20260930);
    const b = build(20260931);
    runTicks(a, 1500);
    runTicks(b, 1500);
    expect(digestWorld(a.world)).not.toBe(digestWorld(b.world));
  });
});

describe('save/load with utility + AI state', () => {
  it('round-trip preserves powered/watered flags and AI virtual buildings exactly', () => {
    const ctx = setup(5150);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    aiOf(ctx.world).virtualBuildings.completed.push('lab', 'warFactory');
    const plant = completed(ctx.world, 'powerPlant', 0, 20, 20);
    const factory = completed(ctx.world, 'factory', 0, 26, 20);
    runTicks(ctx, 600);
    expect(plant.powered).toBe(true);
    expect(factory.powered).toBe(true);
    // The command queue is driver-level state, intentionally not
    // snapshotted: drain it so the snapshot captures the full future.
    // (queue.clear is the test-only API for exactly this.)
    ctx.queue.clear();
    expect(ctx.queue.pendingCount()).toBe(0);
    const snap = takeSnapshot(ctx.world);
    const json = JSON.parse(JSON.stringify(snap));
    const restored = restoreSnapshot(json);
    expect(digestWorld(restored)).toBe(digestWorld(ctx.world));
    // The restored world continues identically to the uninterrupted one.
    // NOTE: the AI system must share the driver's queue instance —
    // commands the AI issues have to be applied by the same driver.
    const queue2 = createCommandQueue();
    registerCoreCommands(queue2);
    registerUnitCommands(queue2, ctx.terrain);
    registerMovementCommands(queue2, ctx.terrain);
    registerCombatCommands(queue2);
    const driver2 = createTickDriver({
      queue: queue2,
      systems: [createEconomySystem(ctx.terrain), createAISystem(queue2)],
    });
    for (let i = 0; i < 300; i++) {
      ctx.driver.step(ctx.world, TICK_MS);
      driver2.step(restored, TICK_MS);
    }
    expect(digestWorld(restored)).toBe(digestWorld(ctx.world));
  });
});

describe('market: no fund spirals (map-edge trade arrives in Phase 2; the market must not print money)', () => {
  it('a buy-then-sell round trip always loses funds (the spread is a sink)', () => {
    const ctx = setup(99);
    const p = getPlayer(ctx.world.city, 0)!;
    p.funds = 100000;
    const before = p.funds;
    const cost = marketBuyCost('materials', 100);
    p.funds -= cost;
    p.materials += 100;
    const proceeds = marketSellValue('materials', 100);
    p.materials -= 100;
    p.funds += proceeds;
    expect(p.funds).toBeLessThan(before);
    // The spread is the sink: selling back returns exactly (1−s)/(1+s)
    // = 0.8/1.2 = 2/3 of the buy price. No printing, no spiral.
    expect(proceeds / cost).toBeCloseTo(2 / 3, 9);
    expect(before - p.funds).toBeCloseTo(cost - proceeds, 9);
  });
});

describe('utility allocation performance (baseline for the flood-fill work)', () => {
  it('reports ms per economy tick with 600 buildings (no flood fill yet — pool baseline)', () => {
    const ctx = setup(4242);
    for (const p of ctx.world.city.players) {
      p.funds = 1e9;
      p.materials = 1e9;
    }
    const kinds: BuildingKind[] = [
      'powerPlant',
      'waterPump',
      'factory',
      'factory',
      'house',
      'farm',
      'shop',
    ];
    for (let i = 0; i < 600; i++) {
      const kind = kinds[i % kinds.length] as BuildingKind;
      completed(ctx.world, kind, i % 2, i, i);
    }
    // Warm up (JIT, growth caches).
    runEconomyTick(ctx.world, ctx.terrain);
    const N = 30;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) runEconomyTick(ctx.world, ctx.terrain);
    const avgMs = (performance.now() - t0) / N;
    // Vitest prints console output per test file on failure only when
    // silent=false; also leave the number in the assertion message.
    console.log(
      `[perf] runEconomyTick (incl. allocateUtilities) with 600 buildings: ` +
        `avg ${avgMs.toFixed(2)}ms over ${N} economy ticks`,
    );
    // Generous tripwire (~2 orders of magnitude above the expected few
    // ms): catches an accidental O(n^2) without flaking on shared VMs.
    expect(avgMs, `economy tick with 600 buildings took ${avgMs.toFixed(2)}ms`).toBeLessThan(
      250,
    );
  });
});
