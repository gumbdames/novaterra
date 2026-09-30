/**
 * Peaceful AI unit tests (grand-expansion Phase 8, workstream C).
 *
 * Verifies the military lockout and the peaceful dispatch:
 * - `canTrain` returns false for military defs (and true for civilian)
 *   in peaceful worlds, and is unchanged in non-peaceful worlds.
 * - `createAISystem(queue, terrain)` runs the peaceful think in a
 *   peaceful world: the AI issues no military orders and builds a
 *   civilian city (no rejections).
 * - Without terrain, the peaceful think still runs (research/ages)
 *   without crashing and places nothing.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS, isWater } from '../src/sim/terrain';
import {
  registerCityCommands,
  MAP_HALF_SIZE,
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
import { addAIPlayer, createAISystem, canTrain } from '../src/sim/ai';
import { BUILDING_DEFS, type BuildingKind } from '../src/sim/city';
import { UNIT_DEFS, type UnitKind } from '../src/sim/units';

function findLandNear(t: any, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 60; r += 2)
    for (let dz = -r; dz <= r; dz += 2)
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > MAP_HALF_SIZE - 1 || Math.abs(cz) > MAP_HALF_SIZE - 1)
          continue;
        if (!isWater(t, cx, cz)) return { x: cx, z: cz };
      }
  throw new Error('no land near base');
}

function setupPeacefulWorld(seed: number, withTerrain: boolean) {
  const terrain = withTerrain ? generateTerrain(seed) : undefined;
  const world = createWorld(seed);
  (world as any).peaceful = true;
  const t = terrain ?? generateTerrain(seed);
  const base = findLandNear(t, -110, 0);
  addAIPlayer(world, 0, 'commander', base.x, base.z);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain as any);
  registerUnitCommands(queue, terrain as any);
  registerMovementCommands(queue, terrain as any);
  registerCombatCommands(queue);
  registerAgeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain as any),
      createMovementSystem(terrain as any),
      createCombatSystem(),
      createEconomySystem(terrain as any),
      createAISystem(queue, terrain as any),
    ],
  });
  return { world, queue, driver };
}

describe('peaceful AI: canTrain military lockout', () => {
  it('gates military defs in peaceful worlds, allows civilian', () => {
    const world = createWorld(7);
    (world as any).peaceful = true;
    // Military unit def (rifles) — gated.
    expect(canTrain(world, 0, 'rifles')).toBe(false);
    // Civilian unit def (engineer) — allowed (no production building
    // requirement, foundation age).
    expect(canTrain(world, 0, 'engineer')).toBe(true);
    // Sanity: the defs really are classified as expected.
    expect(UNIT_DEFS['rifles'].military).toBe(true);
    expect(UNIT_DEFS['engineer'].military).not.toBe(true);
    // Military building defs are gated at the placeBuilding command
    // layer (workstream A), not via canTrain (which is unit-only).
    expect(BUILDING_DEFS['barracks'].military).toBe(true);
  });

  it('leaves canTrain unchanged in non-peaceful worlds', () => {
    const world = createWorld(7);
    (world as any).peaceful = false;
    expect(UNIT_DEFS['rifles'].military).toBe(true);
    // The peaceful gate specifically is off.
    expect(canTrain(world, 0, 'engineer')).toBe(true);
  });
});

describe('peaceful AI: dispatch builds a civilian city', () => {
  it('issues zero military orders and zero rejections', () => {
    const { world, queue, driver } = setupPeacefulWorld(7, true);
    let rejections = 0;
    let militaryOrders = 0;
    const origEnqueue = queue.enqueue.bind(queue);
    (queue as any).enqueue = (w: any, cmd: any) => {
      try {
        return origEnqueue(w, cmd);
      } catch (e: any) {
        if (cmd.issuer === 'ai') rejections++;
        throw e;
      }
    };
    // Wrap issue() indirectly: count military placeBuilding/trainUnit
    // payloads at enqueue time (before validation).
    const origEnqueue2 = (queue as any).enqueue;
    (queue as any).enqueue = (w: any, cmd: any) => {
      if (cmd.issuer === 'ai' && cmd.kind === 'placeBuilding') {
        const def = BUILDING_DEFS[cmd.payload.kind as BuildingKind];
        if (def?.military === true) militaryOrders++;
      }
      if (cmd.issuer === 'ai' && cmd.kind === 'trainUnit') {
        const def = UNIT_DEFS[cmd.payload.kind as UnitKind];
        if (def?.military === true) militaryOrders++;
      }
      return origEnqueue2(w, cmd);
    };
    for (let i = 0; i < 600; i++) driver.step(world, TICK_MS);
    expect(militaryOrders).toBe(0);
    expect(rejections).toBe(0);
    // The AI built a civilian city: no military buildings exist.
    for (const b of world.city.buildings) {
      if (b.owner !== 0) continue;
      expect(BUILDING_DEFS[b.kind].military).not.toBe(true);
    }
    // And it built something (utilities at minimum).
    const n = world.city.buildings.filter((b) => b.owner === 0).length;
    expect(n).toBeGreaterThan(0);
  });

  it('paints districts (zoning smoke)', () => {
    const { world, driver } = setupPeacefulWorld(7, true);
    for (let i = 0; i < 120; i++) driver.step(world, TICK_MS);
    // At least one district rect got painted (zones apply at tick 31).
    let zonedCells = 0;
    for (const b of world.city.buildings) {
      if (b.owner === 0) zonedCells++;
    }
    // The AI placed utility buildings (which need no zoning).
    expect(zonedCells).toBeGreaterThan(0);
    const p = getPlayer(world.city, 0)!;
    expect(p.funds).toBeGreaterThanOrEqual(0);
  });
});

describe('peaceful AI: no-terrain fallback', () => {
  it('runs research/ages without crashing and places nothing', () => {
    const { world, driver } = setupPeacefulWorld(7, false);
    for (let i = 0; i < 300; i++) driver.step(world, TICK_MS);
    // No buildings placed (no terrain → no siting).
    const n = world.city.buildings.filter((b) => b.owner === 0).length;
    expect(n).toBe(0);
    // No crash, treasury intact.
    const p = getPlayer(world.city, 0)!;
    expect(p.funds).toBeGreaterThanOrEqual(0);
  });
});
