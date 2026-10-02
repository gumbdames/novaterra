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
 * NOVATERRA — Classic AI per-match personality tests.
 *
 * The Classic AI draws a seeded personality at registration (aggression,
 * expansion eagerness, composition weight jitter, economy-upgrade order,
 * attack cadence, expansion threshold/direction, scout rotation) from its
 * own named RNG stream (`ai-<owner>`). Think functions read the stored
 * personality and draw nothing. These tests prove:
 *  1. same seed ⇒ byte-identical AI decisions (determinism preserved)
 *  2. different seeds ⇒ divergent personalities AND divergent decisions
 *  3. difficulty bounds hold across seeds (cadet stays harmless, citizen
 *     still counters, marshal still advances ages)
 *  4. save → snapshot → JSON round-trip → restore mid-game continues
 *     identically, with the personality intact
 *  5. per-owner streams are independent (a 2nd AI doesn't shift the 1st)
 *  6. legacy snapshots (no personality) decode to the neutral personality
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import { MAP_HALF_SIZE } from '../src/sim/city';
import { findUnit, registerUnitCommands, type UnitKind } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { registerAgeCommands , getAgeState } from '../src/sim/ages';
import {
  addAIPlayer,
  createAISystem,
  encodeAIState,
  NEUTRAL_PERSONALITY,
  type AIDifficulty,
  type AIPersonality,
} from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { rebuildFlowFields } from '../src/sim/pathfinding';
import {
  grantAllTrainingResources,
  completeBuildings,
} from './sim.roster-fixtures';

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
  // Production buildings for every player (mirrors sim.ai.test.ts): the
  // roster gates gated kinds behind completed buildings, and tests spawn
  // enemy tanks/drones directly.
  for (const p of world.city.players) {
    completeBuildings(world, p.id, ['barracks', 'warFactory', 'airfield']);
  }
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerAgeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createAISystem(queue),
    ],
  });
  return { terrain, world, queue, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

/** Run a bare world (no Ctx) with a fresh driver — for restored worlds. */
function runWorldTicks(world: World, driver: TickDriver, n: number): void {
  for (let i = 0; i < n; i++) driver.step(world, TICK_MS);
}

function enqueue(ctx: Ctx, cmds: Array<Omit<NewCommand, 'issuer'>>): void {
  for (const c of cmds) {
    ctx.queue.enqueue(ctx.world, { issuer: 'player', ...c });
  }
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

function countOwnerUnits(world: World, owner: number): number {
  return world.units.filter((u) => u.owner === owner && u.hp > 0).length;
}

/** The 5 economy-line upgrade ids (the personality-shuffled research tail). */
const ECONOMY_TAIL = [
  'precisionManufacturing',
  'smartGrid',
  'verticalFarming',
  'cruiseMissiles',
  'freeTrade',
];

function personalityOf(world: World, owner = 1): AIPersonality {
  const ai = world.ai.players.find((p) => p.owner === owner);
  expect(ai).toBeDefined();
  return ai!.personality;
}

describe('personality derivation', () => {
  it('draws bounded, well-formed personalities from the ai-<owner> stream', () => {
    const ctx = setup(4242);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    const p = personalityOf(ctx.world);
    expect(p.aggression).toBeGreaterThanOrEqual(0);
    expect(p.aggression).toBeLessThan(1);
    expect(p.expansionEagerness).toBeGreaterThanOrEqual(0);
    expect(p.expansionEagerness).toBeLessThan(1);
    expect(Object.keys(p.mixWeights).length).toBeGreaterThan(0);
    for (const w of Object.values(p.mixWeights)) {
      expect(w).toBeGreaterThanOrEqual(0.7);
      expect(w).toBeLessThan(1.3);
    }
    // The research tail is a permutation of the 5 economy upgrades.
    expect([...p.researchOrder].sort()).toEqual([...ECONOMY_TAIL].sort());
    expect([1, 2]).toContain(p.attackEveryNthThink);
    expect(p.expansionUnitThreshold).toBeGreaterThanOrEqual(6);
    expect(p.expansionUnitThreshold).toBeLessThanOrEqual(10);
    expect(p.scoutStartIndex).toBeGreaterThanOrEqual(0);
    expect(p.scoutStartIndex).toBeLessThan(4);
    expect(p.expansionAngle).toBeGreaterThanOrEqual(0);
    expect(p.expansionAngle).toBeLessThan(Math.PI * 2);
    // The stream left its mark in world.rng (snapshot/digest coverage).
    expect(typeof ctx.world.rng['ai-1']).toBe('number');
  });

  it('cadet personality is inert: no mix weights, no research order', () => {
    const ctx = setup(4242);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'cadet', base.x, base.z);
    const p = personalityOf(ctx.world);
    expect(p.mixWeights).toEqual({});
    expect(p.researchOrder).toEqual([]);
  });

  it('per-owner streams are independent: a 2nd AI never shifts the 1st', () => {
    const ctx = setup(777);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    const before = JSON.stringify(personalityOf(ctx.world, 1));
    addAIPlayer(ctx.world, 2, 'marshal', -base.x, -base.z);
    expect(JSON.stringify(personalityOf(ctx.world, 1))).toBe(before);
    // ...and the two AIs play differently from each other.
    expect(JSON.stringify(personalityOf(ctx.world, 2))).not.toBe(before);
  });

  it('think functions draw nothing: the ai-<owner> stream is frozen after init', () => {
    const ctx = setup(4242);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    const afterInit = ctx.world.rng['ai-1'];
    runTicks(ctx, 60 * 10 + 1);
    expect(ctx.world.rng['ai-1']).toBe(afterInit);
  });
});

describe('determinism preserved', () => {
  it('same seed ⇒ byte-identical AI decisions over N ticks', () => {
    const mk = () => {
      const ctx = setup(4242);
      const base = findLandNear(ctx.terrain, -100, -100);
      // setup() already completed barracks/warFactory/airfield; the lab
      // unlocks upgrade research so the research-order jitter is exercised.
      for (const p of ctx.world.city.players) {
        completeBuildings(ctx.world, p.id, ['lab']);
      }
      addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
      runTicks(ctx, 60 * 30);
      return ctx.world;
    };
    const a = mk();
    const b = mk();
    expect(digestWorld(a)).toBe(digestWorld(b));
    expect(JSON.stringify(encodeAIState(a.ai))).toBe(JSON.stringify(encodeAIState(b.ai)));
    expect(JSON.stringify(personalityOf(a))).toBe(JSON.stringify(personalityOf(b)));
  });
});

describe('per-match variety', () => {
  it('different seeds ⇒ divergent personalities and divergent decisions', () => {
    const mk = (seed: number) => {
      const ctx = setup(seed);
      const base = findLandNear(ctx.terrain, -100, -100);
      // setup() already completed barracks/warFactory/airfield; the lab
      // unlocks upgrade research so the research-order jitter is exercised.
      for (const p of ctx.world.city.players) {
        completeBuildings(ctx.world, p.id, ['lab']);
      }
      addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
      runTicks(ctx, 60 * 40);
      return ctx.world;
    };
    const a = mk(101);
    const b = mk(202);
    const pa = personalityOf(a);
    const pb = personalityOf(b);
    // Personalities differ (and the digest covers them).
    expect(pa).not.toEqual(pb);
    expect(digestWorld(a)).not.toBe(digestWorld(b));
    // Composition decisions differ: the mix-weight jitter changes what
    // gets built within the same counter framework.
    expect(a.ai.players[0]!.builtCounts).not.toEqual(b.ai.players[0]!.builtCounts);
    // Expansion differs: threshold and/or fallback direction vary.
    expect(a.ai.players[0]!.forwardBase).not.toEqual(b.ai.players[0]!.forwardBase);
  });
});

describe('difficulty bounds hold across seeds', () => {
  it.each([11, 22, 33])(
    'cadet (seed %i) still trains only rifles and never attacks/researches',
    (seed) => {
      const ctx = setup(seed);
      const base = findLandNear(ctx.terrain, -100, -100);
      addAIPlayer(ctx.world, 1, 'cadet', base.x, base.z);
      // Visible enemy: cadet must still not attack it.
      const enemyBase = findLandNear(ctx.terrain, -80, -100);
      const id = ctx.world.nextId;
      enqueue(ctx, [
        { kind: 'spawnUnit', payload: { kind: 'tank', owner: 0, x: enemyBase.x, z: enemyBase.z } },
      ]);
      runTicks(ctx, 1);
      expect(findUnit(ctx.world, id)).toBeDefined();
      runTicks(ctx, 240 * 8 + 10);
      const n = countOwnerUnits(ctx.world, 1);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThanOrEqual(6);
      // Never attacks: chasing is only set by the attackUnit command.
      for (const u of ctx.world.units) {
        if (u.owner !== 1) continue;
        expect(u.chasing).toBe(false);
      }
      // Never researches/upgrades/counters: rifles only.
      expect(Object.keys(ctx.world.ai.players[0]!.builtCounts)).toEqual(['rifles']);
      expect(ctx.world.upgrades[1] ?? []).toEqual([]);
    },
  );

  it.each([11, 22, 33])('citizen (seed %i) still counters air with AA', (seed) => {
    const ctx = setup(seed);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    const enemyPos = findLandNear(ctx.terrain, -90, -100);
    const id = ctx.world.nextId;
    enqueue(ctx, [
      { kind: 'spawnUnit', payload: { kind: 'drone', owner: 0, x: enemyPos.x, z: enemyPos.z } },
    ]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, id)).toBeDefined();
    runTicks(ctx, 120 * 8 + 10);
    const aa = ctx.world.units.filter((u) => u.owner === 1 && u.kind === 'aa' && u.hp > 0);
    expect(aa.length).toBeGreaterThan(0);
  });

  it.each([11, 22, 33])('marshal (seed %i) still advances ages', (seed) => {
    const ctx = setup(seed);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'marshal', base.x, base.z);
    runTicks(ctx, 30 * 12 + 2);
    expect(getAgeState(ctx.world, 1).age).not.toBe('foundation');
  });
});

describe('save / resume with personality', () => {
  it('snapshot → JSON round-trip → restore mid-game continues identically', () => {
    const mkCtx = (seed: number) => {
      const ctx = setup(seed);
      const base = findLandNear(ctx.terrain, -100, -100);
      addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
      return ctx;
    };
    const ctxA = mkCtx(5555);
    // Branch at tick 602: commander thinks on multiples of 60, so the
    // command queue is empty here (nothing pending that the snapshot
    // wouldn't carry — the queue itself is not snapshotted).
    runTicks(ctxA, 602);
    const personalityBefore = JSON.parse(JSON.stringify(personalityOf(ctxA.world)));
    const snap = takeSnapshot(ctxA.world);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    rebuildFlowFields(restored, ctxA.terrain); // B25: v9 restores field identities; the session rebuilds dirs on load
    // B25 (v9): live flow fields are rebuilt, not restored bit-identical,
    // so the immediate digest can differ when fields are live. The v9
    // contract is deterministic restore: two restores digest identically.
    const restored2 = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    rebuildFlowFields(restored2, ctxA.terrain);
    expect(digestWorld(restored2)).toBe(digestWorld(restored));
    // The personality survived the round-trip exactly.
    expect(restored.ai.players[0]!.personality).toEqual(personalityBefore);
    // The restored world continues deterministically for 600 more ticks.
    const ctxB = mkCtx(5555);
    runWorldTicks(restored, ctxB.driver, 600);
    const ctxC = mkCtx(5555);
    runWorldTicks(restored2, ctxC.driver, 600);
    expect(digestWorld(restored2)).toBe(digestWorld(restored));
  });

  it('legacy snapshots without a personality decode to the neutral personality', () => {
    const ctx = setup(5555);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    runTicks(ctx, 120);
    const snap = takeSnapshot(ctx.world) as unknown as Record<string, unknown>;
    const aiState = snap['ai'] as { players: Record<string, unknown>[] };
    for (const p of aiState.players) delete p['personality'];
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    // Neutral personality: reproduces pre-personality behavior exactly.
    expect(restored.ai.players[0]!.personality).toEqual(NEUTRAL_PERSONALITY);
    // ...and two restores of the same legacy snapshot continue
    // deterministically: identical digests after 120 more ticks each.
    const restored2 = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    const ctx2 = setup(5555);
    runWorldTicks(restored, ctx2.driver, 120);
    const ctx3 = setup(5555);
    runWorldTicks(restored2, ctx3.driver, 120);
    expect(digestWorld(restored)).toBe(digestWorld(restored2));
  });
});
