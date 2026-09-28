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
 *  - Build a playable session: terrain, world, command queue
 *    (every command kind registered), and the tick driver with the
 *    canonical system order. One function, one place — the UI game loop,
 *    headless scenario tests, and future replay/save code all assemble
 *    the game through here so the wiring cannot drift.
 *  - Seed both players' starting forces through the command queue (the
 *    same path real orders take), and register the Classic AI rival
 *    (owner 1) at a chosen difficulty. Player 0 is always the human.
 *  - Campaign missions (Phase 2): `createSession({ campaignMission })`
 *    drives map/AI/starting resources from the mission; 'none' AI means
 *    no rival player, and owner 1 is always funded for scripted raids.
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
import { generateTerrain, getMapPreset, isWater } from '../sim/terrain';
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
import { registerCheatCommands } from '../sim/cheats';
import { addAIPlayer, AI_MAX_UNITS, createAISystem, type AIDifficulty } from '../sim/ai';
import { restoreSnapshot, type Snapshot } from '../sim/snapshot';
import type { OrderIntent } from './orders';
import type { MissionDef } from '../campaign/missions';

/** Player 0 is always the human. */
export const HUMAN_PLAYER_ID = 0;
/** Player 1 is always the Classic AI rival. */
export const AI_PLAYER_ID = 1;

export interface SessionOptions {
  /** Deterministic seed for the whole session (terrain + world + AI). */
  seed: number;
  /** Classic AI difficulty for the rival (default 'citizen'). */
  aiDifficulty?: AIDifficulty;
  /**
   * Map preset name (see MAP_PRESETS in sim/terrain.ts). Defaults to
   * 'Meridian Plains'. Each preset has a canonical seed, so picking a
   * map always yields the same terrain.
   */
  mapPreset?: string;
  /**
   * Restore from a saved snapshot instead of a fresh world. When set,
   * starting forces are NOT re-seeded (the snapshot already has them)
   * and the AI player is NOT re-added (its state is in the snapshot).
   */
  snapshot?: Snapshot;
  /**
   * Campaign mission setup (Phase 2). When set, the map preset, AI
   * difficulty, and starting resources come from the mission; the AI
   * rival is skipped entirely when the mission's difficulty is 'none'.
   * The AI player always gets a manpower stockpile so the campaign
   * director's scripted raids can pay the spawnUnit manpower cost.
   */
  campaignMission?: MissionDef;
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
  /**
   * Set once any cheat console command runs. Recorded in save metadata
   * so a save file honestly reports it was cheated in. UI-owned, never
   * read by the sim.
   */
  cheated: boolean;
}

/** AI base corner; mirrored for the human. */
const AI_CORNER = { x: 180, z: -180 };
const HUMAN_CORNER = { x: -180, z: 180 };

/**
 * Manpower granted to the AI player (owner 1) in every fresh session so
 * the campaign director's scripted raids can pay the `spawnUnit`
 * manpower cost. Harmless in skirmish: the Classic AI spends manpower
 * on its own production anyway.
 */
const RAID_MANPOWER = 10000;

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
  terrain: TerrainData,
  owner: number,
  issuer: string,
  at: { x: number; z: number },
  maxUnits?: number,
): void {
  const specs: Array<{ kind: string; dx: number; dz: number }> = [
    { kind: 'engineer', dx: -4, dz: -4 },
    { kind: 'engineer', dx: 4, dz: -4 },
    { kind: 'rifles', dx: -8, dz: 4 },
    { kind: 'rifles', dx: 0, dz: 4 },
    { kind: 'rifles', dx: 8, dz: 4 },
    { kind: 'rifles', dx: 0, dz: 10 },
  ];
  // The AI's production cap counts all its units: starting forces must not
  // already exceed it, or the AI would never build (cadet cap is 4).
  const list = maxUnits !== undefined ? specs.slice(0, maxUnits) : specs;
  for (const s of list) {
    // Each unit finds its own nearest land: on high-water maps the base
    // center may be land while an offset (±10) sits in water, and a
    // water spawn is a loud rejection, not a silent skip.
    const pos = findLandNear(terrain, at.x + s.dx, at.z + s.dz);
    const cmd: NewCommand = {
      kind: 'spawnUnit',
      issuer,
      payload: { kind: s.kind, owner, x: pos.x, z: pos.z },
    };
    queue.enqueue(world, cmd);
  }
}

/**
 * Create a fresh skirmish session. Deterministic in (seed, aiDifficulty):
 * same inputs, same world, same AI behavior.
 *
 * With `campaignMission` set, the mission drives the setup: its map
 * preset, its AI difficulty ('none' = no AI rival at all), and its
 * starting-resource overrides. The AI player (owner 1) always receives
 * a manpower stockpile so the campaign director's scripted raids can
 * pay the `spawnUnit` manpower cost.
 */
export function createSession(options: SessionOptions): GameSession {
  const { seed } = options;
  const mission = options.campaignMission;
  const aiDifficulty: AIDifficulty =
    mission !== undefined
      ? mission.aiDifficulty === 'none'
        ? 'citizen' // placeholder: no AI player is added below
        : mission.aiDifficulty
      : (options.aiDifficulty ?? 'citizen');
  const preset = getMapPreset(
    mission?.mapPreset ?? options.mapPreset ?? 'Meridian Plains',
  );

  const terrain = generateTerrain(preset.seed, preset);
  // Restored games resume the exact saved world; fresh games start empty.
  const world = options.snapshot ? restoreSnapshot(options.snapshot) : createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerAgeCommands(queue);
  registerCheatCommands(queue);

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
  if (!options.snapshot) {
    const hasAIRival = mission === undefined || mission.aiDifficulty !== 'none';
    if (hasAIRival) {
      // The AI's production cap counts all its units: starting forces must
      // leave headroom under the cap, or the AI would never build.
      // Cadet (cap 4) gets 2 starters; citizen/commander get the full 6.
      const aiStarters = aiDifficulty === 'cadet' ? 2 : AI_MAX_UNITS[aiDifficulty];
      startingForces(queue, world, terrain, AI_PLAYER_ID, 'ai-setup', aiBase, aiStarters);
      addAIPlayer(world, AI_PLAYER_ID, aiDifficulty, aiBase.x, aiBase.z);
    }
    // Scripted raids spawn for owner 1 through the command queue, which
    // validates manpower — fund the raiders even when no AI rival plays.
    const aiPlayer = world.city.players[AI_PLAYER_ID];
    if (aiPlayer !== undefined && aiPlayer.manpower < RAID_MANPOWER) {
      aiPlayer.manpower = RAID_MANPOWER;
    }
    startingForces(queue, world, terrain, HUMAN_PLAYER_ID, 'player', humanBase);
    if (mission?.startingResources !== undefined) {
      const human = world.city.players[HUMAN_PLAYER_ID];
      if (human !== undefined) {
        for (const [key, value] of Object.entries(mission.startingResources)) {
          (human as unknown as Record<string, number>)[key] = value;
        }
      }
    }

    // Apply the starting forces now (one fixed tick) so a fresh session
    // already has both armies on the field.
    driver.step(world, TICK_MS);
  }
  // Restored sessions skip all of the above: units, buildings, AI state,
  // and RNG streams come back exactly as saved.

  return {
    sessionId:
      mission !== undefined
        ? `novaterra-campaign-${mission.id}-${seed >>> 0}`
        : `novaterra-${seed >>> 0}-${aiDifficulty}`,
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
    cheated: false,
  };
}
