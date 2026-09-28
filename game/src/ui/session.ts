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
 * NOVATERRA — ui/session.ts — full game assembly (headless-safe).
 *
 * Responsibilities:
 *  - Build a playable skirmish session: terrain, world, command queue
 *    (every command kind registered), and the tick driver with the
 *    canonical system order. One function, one place — the UI game loop,
 *    headless scenario tests, and future replay/save code all assemble
 *    the game through here so the wiring cannot drift.
 *  - Seed both players' starting forces through the command queue (the
 *    same path real orders take), and register the Classic AI rival
 *    (owner 1) at a chosen difficulty. Player 0 is always the human.
 *
 * Canonical system order (fixed, data-independent):
 *    pathfinding → movement → combat → economy → AI
 * AI thinks last so it reacts to this tick's resolved state.
 *
 * Starting forces (skirmish convention, decided for the 0.1 Alpha UI):
 * each side gets 2 engineers + 4 rifles on the nearest land to their
 * map corner — engineers so the human can build immediately, rifles so
 * both sides have something to defend with.
 *
 * No DOM, no three.js, no wall clock — safe under Node/vitest. The seed
 * is chosen by the caller (UI uses a fresh seed per game; tests use fixed
 * seeds for determinism).
 */

import type { World } from '../sim/world';
import { createWorld } from '../sim/world';
import type { CommandQueue, NewCommand } from '../sim/commands';
import {
  createCommandQueue,
  registerCoreCommands,
} from '../sim/commands';
import type { TickDriver } from '../sim/tick';
import { createTickDriver, TICK_MS } from '../sim/tick';
import type { TerrainData } from '../sim/terrain';
import { generateTerrain, isWater, MERIDIAN_PLAINS } from '../sim/terrain';
import { digestWorld } from '../sim/digest';
import { registerCityCommands } from '../sim/city';
import { createEconomySystem, registerEconomyCommands } from '../sim/economy';
import { registerUnitCommands } from '../sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../sim/movement';
import { createCombatSystem, registerCombatCommands } from '../sim/combat';
import { registerAgeCommands } from '../sim/ages';
import { addAIPlayer, createAISystem, type AIDifficulty } from '../sim/ai';
import type { OrderIntent } from './orders';

/** Player 0 is always the human. */
export const HUMAN_PLAYER_ID = 0;
/** Player 1 is always the Classic AI rival. */
export const AI_PLAYER_ID = 1;

export interface SessionOptions {
  /** Deterministic seed for the whole session (terrain + world + AI). */
  seed: number;
  /** Classic AI difficulty for the rival (default 'citizen'). */
  aiDifficulty?: AIDifficulty;
}

/** Everything a running game needs. Plain data + live driver/queue. */
export interface GameSession {
  /** Deterministic id: `novaterra-<seed>-<difficulty>`. */
  sessionId: string;
  seed: number;
  aiDifficulty: AIDifficulty;
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
  /** Run exactly one fixed sim tick (1/30 s). */
  tick(): void;
  /**
   * Enqueue a player intent; stamps `issuer: 'player'`. Throws
   * CommandRejectedError on invalid orders — the UI catches and toasts.
   */
  enqueuePlayerIntent(intent: OrderIntent): void;
  /** Deterministic digest of the current world state (for tests/sync). */
  digest(): string;
}

/** AI base corner; mirrored for the human. */
const AI_CORNER = { x: 180, z: -180 };
const HUMAN_CORNER = { x: -180, z: 180 };

/**
 * Nearest land to (x, z) on a deterministic outward spiral. Base placement
 * is gameplay-critical: the AI's spawnUnit commands validate terrain at
 * enqueue, so a water base would silently starve the AI.
 */
function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r <= 160; r += 4) {
    for (let a = 0; a < 8; a += 1) {
      const px = x + Math.cos((a / 8) * 2 * Math.PI) * r;
      const pz = z + Math.sin((a / 8) * 2 * Math.PI) * r;
      if (!isWater(t, px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/** Starting forces: 2 engineers + 4 rifles around a land point. */
function startingForces(
  queue: CommandQueue,
  world: World,
  owner: number,
  issuer: string,
  at: { x: number; z: number },
): void {
  const specs: Array<{ kind: string; dx: number; dz: number }> = [
    { kind: 'engineer', dx: -4, dz: -4 },
    { kind: 'engineer', dx: 4, dz: -4 },
    { kind: 'rifles', dx: -8, dz: 4 },
    { kind: 'rifles', dx: 0, dz: 4 },
    { kind: 'rifles', dx: 8, dz: 4 },
    { kind: 'rifles', dx: 0, dz: 10 },
  ];
  for (const s of specs) {
    const cmd: NewCommand = {
      kind: 'spawnUnit',
      issuer,
      payload: { kind: s.kind, owner, x: at.x + s.dx, z: at.z + s.dz },
    };
    queue.enqueue(world, cmd);
  }
}

/**
 * Create a fresh skirmish session. Deterministic in (seed, aiDifficulty):
 * same inputs, same world, same AI behavior.
 */
export function createSession(options: SessionOptions): GameSession {
  const { seed } = options;
  const aiDifficulty: AIDifficulty = options.aiDifficulty ?? 'citizen';

  const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
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
      createEconomySystem(terrain),
      // AI needs the queue to issue its orders through.
      createAISystem(queue),
    ],
  });

  const aiBase = findLandNear(terrain, AI_CORNER.x, AI_CORNER.z);
  const humanBase = findLandNear(terrain, HUMAN_CORNER.x, HUMAN_CORNER.z);
  startingForces(queue, world, AI_PLAYER_ID, 'ai-setup', aiBase);
  startingForces(queue, world, HUMAN_PLAYER_ID, 'player', humanBase);
  addAIPlayer(world, AI_PLAYER_ID, aiDifficulty, aiBase.x, aiBase.z);

  // Apply the starting forces now (one fixed tick) so a fresh session
  // already has both armies on the field.
  driver.step(world, TICK_MS);

  return {
    sessionId: `novaterra-${seed >>> 0}-${aiDifficulty}`,
    seed,
    aiDifficulty,
    terrain,
    world,
    queue,
    driver,
    tick: () => {
      driver.step(world, TICK_MS);
    },
    enqueuePlayerIntent: (intent: OrderIntent) => {
      queue.enqueue(world, { ...intent, issuer: 'player' });
    },
    digest: () => String(digestWorld(world)),
  };
}
