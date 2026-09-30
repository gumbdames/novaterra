// Battle soak for unit veterancy (Phase 1): two tank platoons fight through
// the real combat tick loop; asserts XP actually accrues from kills, vet
// levels progress, nothing corrupts (no NaN), and the whole battle is
// deterministic (same seed ⇒ identical world digest).
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
import { registerUnitCommands, type UnitKind } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { createAISystem } from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
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

function setupBattle(seed: number): Ctx {
  const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
  const world = createWorld(seed);
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

/**
 * 8 tanks per side, platoons 20 apart: inside tank sight (26), so the
 * combat system closes them to firing range (19) and they fight with no
 * scripted orders — pure opportunistic engagement.
 */
function runBattle(seed: number, ticks: number): World {
  const ctx = setupBattle(seed);
  const cmds: Array<Omit<NewCommand, 'issuer'>> = [];
  for (let i = 0; i < 8; i++) {
    for (const [owner, bx] of [
      [0, -10],
      [1, 10],
    ] as Array<[number, number]>) {
      const p = findLandNear(ctx.terrain, bx + (i % 4) * 3, (Math.floor(i / 4) - 0.5) * 6);
      cmds.push({
        kind: 'spawnUnit',
        payload: { kind: 'tank' as UnitKind, owner, x: p.x, z: p.z },
      });
    }
  }
  for (const c of cmds) ctx.queue.enqueue(ctx.world, { issuer: 'player', ...c });
  for (let i = 0; i < ticks; i++) ctx.driver.step(ctx.world, TICK_MS);
  return ctx.world;
}

describe('veterancy battle soak', () => {
  it('platoon battle accrues XP, levels veterans, stays deterministic', () => {
    const TICKS = 3000;
    const world = runBattle(777, TICKS);

    // Determinism: the same seed replays to a byte-identical digest.
    const again = runBattle(777, TICKS);
    expect(digestWorld(again)).toBe(digestWorld(world));

    let nanCount = 0;
    let killers = 0;
    let aboveRecruit = 0;
    for (const u of world.units) {
      if (!Number.isFinite(u.xp) || !Number.isFinite(u.vetLevel)) nanCount++;
      if ((u.xp ?? 0) > 0) killers++;
      if ((u.vetLevel ?? 0) > 0) aboveRecruit++;
      // XP and level always agree with the locked thresholds.
      const xp = u.xp ?? 0;
      const expected = xp >= 1000 ? 3 : xp >= 500 ? 2 : xp >= 200 ? 1 : 0;
      expect(u.vetLevel ?? 0).toBe(expected);
    }
    expect(nanCount).toBe(0);
    // Real kills happened (fewer than 16 survivors) and the killers banked XP.
    expect(world.units.length).toBeLessThan(16);
    expect(killers).toBeGreaterThan(0);
    // At least one survivor climbed above Recruit (tank kill = 460 XP).
    expect(aboveRecruit).toBeGreaterThan(0);
  });
});
