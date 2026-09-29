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
 * NOVATERRA — Classic AI tests (Phase 1, step 7).
 *
 * Covers the three difficulty levels (cadet/citizen/commander):
 *  - think cadence (240/120/60 ticks)
 *  - cadet: trickles units, never attacks, never expands
 *  - citizen: builds army, attacks visible enemies, builds AA vs air
 *  - commander: scouts, builds balanced force, establishes forward base
 *  - fairness: AI only sees enemies in sight range (no omniscience)
 *  - determinism: identical seeds produce identical digests
 *  - snapshot/restore preserves AI state and resumes deterministically
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
import { MAP_HALF_SIZE, getPlayer } from '../src/sim/city';
import { findUnit, registerUnitCommands, UNIT_DEFS, type UnitKind } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import {
  addAIPlayer,
  createAISystem,
  getVisibleEnemies,
  AI_THINK_TICKS,
  type AIDifficulty,
} from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
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

function setup(seed = 20260928): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  // Tests don't run the economy: grant training funds/materials/manpower
  // and the production buildings the roster expansion requires (the AI
  // builds tank/aa/artillery/fighter; the AI agent later teaches the AI
  // to construct these itself).
  grantAllTrainingResources(world);
  for (const p of world.city.players) {
    completeBuildings(world, p.id, ['barracks', 'warFactory', 'airfield']);
  }
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
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

function spawnAt(ctx: Ctx, x: number, z: number, kind: UnitKind = 'rifles', owner = 0): number {
  const land = findLandNear(ctx.terrain, x, z);
  const id = ctx.world.nextId;
  enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind, owner, x: land.x, z: land.z } }]);
  runTicks(ctx, 1);
  expect(findUnit(ctx.world, id)).toBeDefined();
  return id;
}

function countOwnerUnits(world: World, owner: number): number {
  return world.units.filter((u) => u.owner === owner && u.hp > 0).length;
}

describe('AI think cadence', () => {
  it.each([
    ['cadet', 240],
    ['citizen', 120],
    ['commander', 60],
  ] as Array<[AIDifficulty, number]>)('%s thinks every %i ticks', (diff, expected) => {
    expect(AI_THINK_TICKS[diff]).toBe(expected);
  });

  it('AI does nothing before its first think tick', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    runTicks(ctx, AI_THINK_TICKS.citizen - 1);
    expect(countOwnerUnits(ctx.world, 1)).toBe(0);
  });

  it('AI acts on its think tick', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // +2 ticks: the AI thinks during the systems phase of tick 120, and the
    // enqueued spawnUnit command applies at the start of the following tick.
    runTicks(ctx, AI_THINK_TICKS.citizen + 2);
    // Citizen should have spawned at least one unit.
    expect(countOwnerUnits(ctx.world, 1)).toBeGreaterThan(0);
  });
});

describe('cadet', () => {
  it('trickles units up to its cap and never attacks', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'cadet', base.x, base.z);
    // Spawn an enemy nearby (visible to cadet units once they exist).
    const enemyBase = findLandNear(ctx.terrain, -80, -100);
    spawnAt(ctx, enemyBase.x, enemyBase.z, 'tank', 0);
    // Run long enough for cadet to hit its cap (6 units, 240 ticks each).
    runTicks(ctx, 240 * 7 + 10);
    const n = countOwnerUnits(ctx.world, 1);
    expect(n).toBeLessThanOrEqual(6);
    expect(n).toBeGreaterThan(0);
    // Cadet never issues explicit attack orders: the `chasing` flag is set
    // only by the attackUnit command (see combat.ts). Opportunistic combat
    // targeting may set targetId, but chasing stays false.
    for (const u of ctx.world.units) {
      if (u.owner !== 1) continue;
      expect(u.chasing).toBe(false);
    }
  });
});

describe('citizen', () => {
  it('builds an army up to its cap', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // No enemies: nothing dies. 16 thinks × 1 unit, capped at 14.
    runTicks(ctx, 120 * 16 + 10);
    expect(countOwnerUnits(ctx.world, 1)).toBe(14);
  });

  it('attacks visible enemies', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // Weak enemies near the AI base: the AI should engage them.
    const enemyPos = findLandNear(ctx.terrain, -85, -100);
    const enemyId = spawnAt(ctx, enemyPos.x, enemyPos.z, 'rifles', 0);
    runTicks(ctx, 120 * 6 + 10);
    const n = countOwnerUnits(ctx.world, 1);
    expect(n).toBeGreaterThan(0);
    // At least one AI unit should be chasing the visible enemy — or the
    // enemy is already dead, which also proves the AI attacked it (the
    // only other units on the map are the AI's).
    const enemy = findUnit(ctx.world, enemyId);
    const enemyDead = !enemy || enemy.hp <= 0;
    const attackers = ctx.world.units.filter(
      (u) => u.owner === 1 && u.hp > 0 && u.targetId === enemyId && u.chasing,
    );
    expect(attackers.length > 0 || enemyDead).toBe(true);
  });

  it('builds AA when enemy air is visible', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // Enemy drone (air) near the AI base — visible once AI has units.
    // (Drone is used instead of fighter: fighter requires Connectivity.)
    const enemyPos = findLandNear(ctx.terrain, -90, -100);
    // Drones can be over water; spawn directly.
    const id = ctx.world.nextId;
    enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'drone', owner: 0, x: enemyPos.x, z: enemyPos.z } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, id)).toBeDefined();
    // Run several think cycles.
    runTicks(ctx, 120 * 8 + 10);
    const aa = ctx.world.units.filter((u) => u.owner === 1 && u.kind === 'aa' && u.hp > 0);
    expect(aa.length).toBeGreaterThan(0);
  });
});

describe('commander', () => {
  it('scouts with a drone and establishes a forward base', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    // Run enough ticks for 8+ units (60 ticks per think, ~1 unit per think).
    runTicks(ctx, 60 * 12 + 10);
    const ai = ctx.world.ai.players[0]!;
    // Should have built a drone for scouting.
    const drones = ctx.world.units.filter((u) => u.owner === 1 && u.kind === 'drone' && u.hp > 0);
    expect(drones.length).toBeGreaterThan(0);
    // Should have established a forward base after 8+ units.
    expect(ai.forwardBase).not.toBeNull();
  });

  it('builds a balanced force with counters', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    // Visible enemy heavy armor → commander should counter with artillery
    // (tankDestroyer is industry-gated, so artillery is the foundation answer).
    const enemyPos = findLandNear(ctx.terrain, -80, -100);
    spawnAt(ctx, enemyPos.x, enemyPos.z, 'tank', 0);
    spawnAt(ctx, enemyPos.x + 4, enemyPos.z, 'tank', 0);
    spawnAt(ctx, enemyPos.x - 4, enemyPos.z, 'tank', 0);
    runTicks(ctx, 60 * 14 + 10);
    // The counter decision fired (builtCounts records decisions even when
    // the counter units later die in combat against the parked tanks).
    const ai = ctx.world.ai.players[0]!;
    expect(ai.builtCounts['artillery'] ?? 0).toBeGreaterThan(0);
  });
});

describe('fairness (no omniscience)', () => {
  it('getVisibleEnemies only returns enemies in sight range', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // AI unit at base.
    const aiUnitId = spawnAt(ctx, base.x, base.z, 'rifles', 1);
    const aiUnit = findUnit(ctx.world, aiUnitId)!;
    const sight = UNIT_DEFS[aiUnit.kind as UnitKind].sight;
    // Enemy just inside sight range.
    const near = findLandNear(ctx.terrain, base.x + sight - 5, base.z);
    const nearId = spawnAt(ctx, near.x, near.z, 'tank', 0);
    // Enemy far outside sight range.
    const far = findLandNear(ctx.terrain, base.x + sight + 100, base.z);
    const farId = spawnAt(ctx, far.x, far.z, 'tank', 0);
    const visible = getVisibleEnemies(ctx.world, 1);
    const ids = visible.map((u) => u.id);
    expect(ids).toContain(nearId);
    expect(ids).not.toContain(farId);
  });

  it('AI does not attack enemies it cannot see', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // Enemy far away, out of sight.
    const far = findLandNear(ctx.terrain, 100, 100);
    const farId = spawnAt(ctx, far.x, far.z, 'tank', 0);
    runTicks(ctx, 120 * 4 + 10);
    // No AI unit should be targeting the far enemy.
    for (const u of ctx.world.units) {
      if (u.owner !== 1) continue;
      expect(u.targetId).not.toBe(farId);
    }
  });
});

describe('determinism', () => {
  it('identical seeds produce identical digests with AI active', () => {
    const run = (seed: number): number => {
      const ctx = setup(seed);
      const base = findLandNear(ctx.terrain, -100, -100);
      addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
      const enemyPos = findLandNear(ctx.terrain, -80, -100);
      spawnAt(ctx, enemyPos.x, enemyPos.z, 'tank', 0);
      runTicks(ctx, 60 * 10);
      return digestWorld(ctx.world);
    };
    expect(run(42)).toBe(run(42));
  });

  it('snapshot/restore preserves AI state and resumes deterministically', () => {
    const ctx = setup(99);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    runTicks(ctx, 120 * 3);
    const before = digestWorld(ctx.world);
    const snap = takeSnapshot(ctx.world);
    // Mutate the world, then restore.
    runTicks(ctx, 120 * 2);
    const mutated = digestWorld(ctx.world);
    expect(mutated).not.toBe(before);
    const restored = restoreSnapshot(snap);
    expect(digestWorld(restored)).toBe(before);
    // AI state survived the round trip.
    expect(restored.ai.players.length).toBe(1);
    expect(restored.ai.players[0]!.difficulty).toBe('citizen');
    expect(restored.ai.players[0]!.owner).toBe(1);
  });
});
