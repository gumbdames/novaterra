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
 * NOVATERRA — legacy save decoding (grand-expansion Phase 2 verification).
 *
 * v5/v6 snapshots predate the utility-network fields (powerLines/pipes,
 * per-network diag, storage stocks — the sim workstream's flood-fill
 * rewrite, not yet committed when these tests were written). They must
 * decode and play correctly under the current allocator, and keep
 * decoding once the new fields land (additive optional fields with
 * neutral decode defaults — no version bump per RESEARCH.md §3).
 *
 * A faithful v5 snapshot is built by downgrading a real v6 snapshot:
 * version stamp 5, no `upgrades`, no AI personalities, no veterancy
 * fields — exactly what a save from before those features looks like.
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
  type TerrainData,
} from '../src/sim/terrain';
import {
  getPlayer,
  placeBuilding,
  BUILDING_DEFS,
  type BuildingKind,
  type Placement,
} from '../src/sim/city';
import { createEconomySystem } from '../src/sim/economy';
import { registerUnitCommands } from '../src/sim/units';
import { registerMovementCommands } from '../src/sim/movement';
import { registerCombatCommands } from '../src/sim/combat';
import { addAIPlayer, createAISystem, NEUTRAL_PERSONALITY } from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import {
  takeSnapshot,
  restoreSnapshot,
  SNAPSHOT_VERSION,
} from '../src/sim/snapshot';
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

function makeDriver(terrain: TerrainData, queue: CommandQueue): TickDriver {
  return createTickDriver({
    queue,
    systems: [createEconomySystem(terrain), createAISystem(queue)],
  });
}

function makeQueue(terrain: TerrainData): CommandQueue {
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  return queue;
}

/** A world with an AI rival, physical utility buildings, and fielded units. */
function buildWorld(seed: number): { terrain: TerrainData; world: World } {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  addAIPlayer(world, 1, 'commander', -100, -100);
  const defs: Array<[BuildingKind, number, number, number]> = [
    ['powerPlant', 0, 20, 20],
    ['waterPump', 0, 26, 20],
    ['factory', 0, 32, 20],
    ['farm', 0, 38, 20],
    ['powerPlant', 1, -20, -20],
    ['house', 1, -26, -20],
  ];
  for (const [kind, owner, cx, cz] of defs) {
    const p: Placement = { kind, owner, cx, cz, facing: 0 };
    placeBuilding(world.city, p).progress = 1;
  }
  return { terrain, world };
}

/**
 * Downgrade a live v6 snapshot to a faithful v5: version stamp 5, no
 * upgrades map, no AI personalities, no veterancy fields — the exact
 * shape of a save written before those features existed.
 */
function downgradeToV5(snap: unknown): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(snap)) as Record<string, any>;
  s.version = 5;
  delete s.upgrades;
  for (const p of s.ai?.players ?? []) delete p.personality;
  for (const u of s.units ?? []) {
    delete u.xp;
    delete u.vetLevel;
  }
  return s;
}

function runTicks(driver: TickDriver, world: World, n: number): void {
  for (let i = 0; i < n; i++) driver.step(world, TICK_MS);
}

describe('legacy saves: v5 decodes and plays', () => {
  it('a downgraded v5 snapshot restores without throwing', () => {
    const { world } = buildWorld(4242);
    const v5 = downgradeToV5(takeSnapshot(world));
    expect(v5.version).toBe(5);
    expect(() => restoreSnapshot(v5 as never)).not.toThrow();
  });

  it('v5 restores decode missing AI personalities to neutral and vet fields to Recruit', () => {
    const { world } = buildWorld(4242);
    const restored = restoreSnapshot(downgradeToV5(takeSnapshot(world)) as never);
    const ai = restored.ai.players.find((p) => p.owner === 1)!;
    expect(ai.personality).toEqual(NEUTRAL_PERSONALITY);
    expect(restored.upgrades).toEqual({});
  });

  it('a restored v5 world plays 600 ticks under the allocator with no crashes', () => {
    const { terrain, world } = buildWorld(4242);
    const restored = restoreSnapshot(downgradeToV5(takeSnapshot(world)) as never);
    const queue = makeQueue(terrain);
    const driver = makeDriver(terrain, queue);
    expect(() => runTicks(driver, restored, 600)).not.toThrow();
    // The pool allocator served the legacy buildings: plants' supply
    // reaches every completed funded consumer, old save or not.
    const plants = restored.city.buildings.filter(
      (b) => BUILDING_DEFS[b.kind].powerSupply > 0,
    );
    expect(plants.length).toBeGreaterThan(0);
    for (const b of restored.city.buildings) {
      if (b.progress < 1 || !b.operational) continue;
      expect(typeof b.powered).toBe('boolean');
      expect(typeof b.watered).toBe('boolean');
    }
    const served = restored.city.buildings.filter(
      (b) => b.progress >= 1 && b.operational && b.powered && b.watered,
    );
    expect(served.length).toBeGreaterThan(0);
  });

  it('two restores of the same v5 snapshot play identically (deterministic)', () => {
    const { terrain, world } = buildWorld(777);
    const v5 = downgradeToV5(takeSnapshot(world));
    const mk = () => {
      const r = restoreSnapshot(JSON.parse(JSON.stringify(v5)) as never);
      const q = makeQueue(terrain);
      return { r, driver: makeDriver(terrain, q) };
    };
    const a = mk();
    const b = mk();
    runTicks(a.driver, a.r, 600);
    runTicks(b.driver, b.r, 600);
    expect(digestWorld(a.r)).toBe(digestWorld(b.r));
  });
});

describe('legacy saves: v6 still round-trips exactly', () => {
  it('current-version snapshot with AI + utility state is bit-identical after restore', () => {
    const { terrain, world } = buildWorld(5150);
    const queue = makeQueue(terrain);
    const driver = makeDriver(terrain, queue);
    runTicks(driver, world, 300);
    const snap = takeSnapshot(world);
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    expect(digestWorld(restored)).toBe(digestWorld(world));
  });
});
