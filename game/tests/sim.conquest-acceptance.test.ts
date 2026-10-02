/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3.0 of the License.
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
 * NOVATERRA — fun-audit B7: C1 acceptance — the AI is physically
 * beatable (2026-10-02).
 *
 * The explicit acceptance check the plan demands: C1's forward base
 * must make the AI's base PHYSICAL, DESTRUCTIBLE, and REQUIRED for
 * elimination — conquest has to be winnable by physical action, never
 * virtual-only. If this fails, the plan-documented fallback is
 * base-zone supremacy (hold the AI's base zone uncontested with its
 * field army destroyed).
 *
 * Pinned here, per difficulty (commander / general / marshal):
 *  - the AI establishes its real forward-base buildings through the
 *    real think path (thinkForwardDepots → placeBuilding orders);
 *  - with the AI's army AND base intact, checkSkirmishVictory is false;
 *  - destroying the field army alone is NOT enough — the standing
 *    forward base keeps the AI alive (the base must be razed);
 *  - razing every forward-base building (destroyBuilding, the same
 *    path siege orders use) with the army gone → checkSkirmishVictory
 *    is true. Conquest is winnable by physical action.
 *  - the AI with no forward base at all (cadet roster, or never
 *    established) is still beatable: zero units + zero buildings
 *    eliminates.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  type CommandQueue,
} from '../src/sim/commands';
import {
  destroyBuilding,
  getPlayer,
  registerCityCommands,
  type BuildingRecord,
} from '../src/sim/city';
import { spawnUnit } from '../src/sim/units';
import { getAgeState } from '../src/sim/ages';
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import { generateTerrain, type TerrainData } from '../src/sim/terrain';
import {
  addAIPlayer,
  thinkForwardDepots,
  findLiveForwardDepot,
  FORWARD_DEPOT_ROSTER,
  FORWARD_DEPOT_MIN_ARMY,
  type AIDifficulty,
  type AIPlayerState,
  type ForwardDepotKind,
} from '../src/sim/ai';
import { checkSkirmishVictory } from '../src/ui/session';
import { grantAllTrainingResources } from './sim.roster-fixtures';

const SEED = 20261002;
const HUMAN = 0;
const AI = 1;

function setupRival(difficulty: AIDifficulty): {
  world: World;
  ai: AIPlayerState;
  terrain: TerrainData;
  queue: CommandQueue;
  driver: TickDriver;
} {
  const world = createWorld(SEED);
  world.victoryKind = 'conquest';
  grantAllTrainingResources(world);
  addAIPlayer(world, AI, difficulty, 0, 0);
  const ai = world.ai.players.find((p) => p.owner === AI)!;
  // Ordnance depots are industry-gated, radar stations
  // connectivity-gated — industry satisfies both, so the acceptance
  // sees the full roster.
  getAgeState(world, AI).age = 'industry';
  const terrain = generateTerrain(SEED);
  const spawn = terrain.spawns[1] ?? terrain.spawns[0] ?? { x: 0, z: 0 };
  ai.forwardBase = { x: spawn.x, z: spawn.z };
  const queue = createCommandQueue();
  registerCityCommands(queue, terrain);
  for (let i = 0; i < FORWARD_DEPOT_MIN_ARMY; i++) {
    spawnUnit(world, 'rifles', AI, spawn.x + i * 2, spawn.z);
  }
  const driver = createTickDriver({ queue, systems: [] });
  return { world, ai, terrain, queue, driver };
}

/** Run the think path until the full roster is placed and completed. */
function establishForwardBase(
  world: World,
  ai: AIPlayerState,
  terrain: TerrainData,
  queue: CommandQueue,
  driver: TickDriver,
  difficulty: AIDifficulty,
): BuildingRecord[] {
  for (let attempt = 0; attempt < 4; attempt++) {
    thinkForwardDepots(world, queue, ai, terrain, FORWARD_DEPOT_MIN_ARMY);
    for (let i = 0; i < 3; i++) driver.step(world, TICK_MS);
    // Complete whatever got placed (construction takes many ticks;
    // the acceptance is about the razing, not the build time).
    for (const b of world.city.buildings) {
      if (b.owner === AI && (FORWARD_DEPOT_ROSTER[difficulty] as string[]).includes(b.kind)) {
        b.progress = 1;
        b.operational = true;
        if ((b.hp ?? 0) <= 0) b.hp = 1000;
      }
    }
  }
  return world.city.buildings.filter(
    (b) => b.owner === AI && (FORWARD_DEPOT_ROSTER[difficulty] as string[]).includes(b.kind),
  );
}

/** Wipe the AI's field army (the human won the field battle). */
function wipeArmy(world: World): void {
  world.units = world.units.filter((u) => u.owner !== AI);
}

/** Raze every building of the AI's forward-base roster. */
function razeForwardBase(world: World, difficulty: AIDifficulty): void {
  const roster = FORWARD_DEPOT_ROSTER[difficulty] as string[];
  for (const b of [...world.city.buildings]) {
    if (b.owner === AI && roster.includes(b.kind)) {
      destroyBuilding(world, b);
    }
  }
}

describe('B7 acceptance — the AI is physically beatable', () => {
  for (const difficulty of ['commander', 'general', 'marshal'] as AIDifficulty[]) {
    it(`${difficulty}: razing the physical forward base wins conquest`, () => {
      const { world, ai, terrain, queue, driver } = setupRival(difficulty);
      const depots = establishForwardBase(world, ai, terrain, queue, driver, difficulty);
      // The full roster stands, live and physical.
      expect(depots.length).toBe(FORWARD_DEPOT_ROSTER[difficulty].length);
      for (const kind of FORWARD_DEPOT_ROSTER[difficulty] as ForwardDepotKind[]) {
        expect(findLiveForwardDepot(world, AI, kind)).toBeDefined();
      }

      // Army + base intact: no victory.
      expect(checkSkirmishVictory(world)).toBe(false);

      // Win the field battle: army gone, base standing — still no
      // victory. The base must be razed; the AI is not virtually dead.
      wipeArmy(world);
      expect(checkSkirmishVictory(world)).toBe(false);

      // Raze the physical forward base: conquest completes by
      // physical action.
      razeForwardBase(world, difficulty);
      expect(checkSkirmishVictory(world)).toBe(true);
    });
  }

  it('cadet (no forward base): zero army + zero buildings still eliminates', () => {
    const { world } = setupRival('cadet');
    expect(FORWARD_DEPOT_ROSTER.cadet).toEqual([]);
    expect(checkSkirmishVictory(world)).toBe(false);
    wipeArmy(world);
    expect(checkSkirmishVictory(world)).toBe(true);
  });

  it('a single surviving depot holds the AI alive (no virtual elimination)', () => {
    const { world, ai, terrain, queue, driver } = setupRival('marshal');
    establishForwardBase(world, ai, terrain, queue, driver, 'marshal');
    wipeArmy(world);
    // Raze two of three — the last standing depot is still a
    // physical, military base: the AI survives.
    const roster = FORWARD_DEPOT_ROSTER.marshal as string[];
    const standing = world.city.buildings.filter(
      (b) => b.owner === AI && roster.includes(b.kind),
    );
    expect(standing.length).toBe(3);
    destroyBuilding(world, standing[0]!);
    destroyBuilding(world, standing[1]!);
    expect(checkSkirmishVictory(world)).toBe(false);
    destroyBuilding(world, standing[2]!);
    expect(checkSkirmishVictory(world)).toBe(true);
  });
});
