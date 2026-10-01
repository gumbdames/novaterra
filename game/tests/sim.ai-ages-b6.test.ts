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
 * NOVATERRA — commander/general age advancement tests (roadmap B6).
 *
 * Age advancement was marshal-only, so below marshal ~40% of the roster
 * stayed unreachable behind age gates (the AI's age never moved past
 * foundation). These tests pin the shared thinkMilitaryAges helper:
 * commander, general, and marshal all advance their (per-side, A1) age
 * when the ledger says they can afford it; cadet (which builds and
 * spends nothing, by design) never does.
 */
import { describe, expect, it } from 'vitest';

import { addAIPlayer, createAISystem, initAI } from '../src/sim/ai';
import { getAgeState } from '../src/sim/ages';
import { getPlayer } from '../src/sim/city';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerAgeCommands } from '../src/sim/ages';
import { registerUnitCommands } from '../src/sim/units';
import { generateTerrain } from '../src/sim/terrain';
import { createWorld } from '../src/sim/world';

function setupAiAgeWorld(difficulty: 'cadet' | 'commander' | 'general' | 'marshal', seed: number) {
  const world = createWorld(seed);
  world.ai = initAI();
  addAIPlayer(world, 1, difficulty, 100, 100);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerAgeCommands(queue);
  const terrain = generateTerrain(seed);
  registerUnitCommands(queue, terrain);
  // Plenty of everything: the ledger gate, not the wallet, is what's
  // being pinned.
  const player = getPlayer(world.city, 1);
  player.funds = 1_000_000;
  player.materials = 1_000_000;
  player.influence = 10_000;
  const system = createAISystem(queue);
  // The think is scheduled at tick + AI_THINK_TICKS[difficulty]; force it
  // to fire on this tick.
  world.ai.players[0]!.nextThinkTick = 0;
  world.tick = 0;
  system(world, 1 / 30);
  // Age commands apply at the next tick start; apply them now so the
  // test reads the post-think age directly.
  queue.applyDue(world, 0);
  return world;
}

describe('military age advancement (B6)', () => {
  it('commander advances to connectivity when affordable', () => {
    const world = setupAiAgeWorld('commander', 111);
    expect(getAgeState(world, 1).age).toBe('connectivity');
  });

  it('general advances to connectivity when affordable', () => {
    const world = setupAiAgeWorld('general', 222);
    expect(getAgeState(world, 1).age).toBe('connectivity');
  });

  it('marshal still advances to connectivity when affordable', () => {
    const world = setupAiAgeWorld('marshal', 333);
    expect(getAgeState(world, 1).age).toBe('connectivity');
  });

  it('cadet never advances ages (builds and spends nothing, by design)', () => {
    const world = setupAiAgeWorld('cadet', 444);
    expect(getAgeState(world, 1).age).toBe('foundation');
  });

  it('commander picks the military-flavored connectivity program', () => {
    const world = setupAiAgeWorld('commander', 555);
    const state = getAgeState(world, 1);
    expect(state.age).toBe('connectivity');
    expect(state.program).toBe('fiberGrid');
  });
});
