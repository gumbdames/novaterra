/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This file is part of NOVATERRA. NOVATERRA is free software: you can
 * redistribute it and/or modify it under the terms of the GNU Affero General
 * Public License as published by the Free Software Foundation, either version
 * 3 of the License, or (at your option) any later version.
 *
 * NOVATERRA is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tests/sim.ai-virtual-economy.test.ts — R1 final-review C2:
 * the Classic AI's virtual economy.
 *
 * The military AI's funds-income paths in economy.ts are effectively
 * closed to it (C1, 2026-10-02: its physical forward-base buildings sit
 * in UTILITY_ZONE, which runTaxes skips, and none has a harvest; the old
 * creditVirtualEconomy only credited def.output — and the civilAirport
 * def carries no funds output at all). The C2 fix
 * credits def.harvest, adds a modest deterministic virtual tax stipend
 * scaled by difficulty (taxBasePerSec × DEFAULT_TAX_RATE ×
 * VIRTUAL_TAX_FACTOR[difficulty], mirroring runTaxes), and reinvests
 * half the stipend as materials at the fixed market rate (the industry
 * age's 2500-material cost is unreachable on the warFactory trickle).
 *
 * Covers: the stipend/harvest/materials math (exact, deterministic),
 * the cadet zero-stipend rule, and the headless marshal-vs-marshal
 * soak asserting the industry age is actually reached (the Phase 9
 * finding was "marshals reached connectivity; industry never reached").
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  registerLogisticsCommands,
} from '../src/sim/commands';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
} from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';
import {
  registerCityCommands,
  MAP_HALF_SIZE,
  getPlayer,
} from '../src/sim/city';
import { createEconomySystem, registerEconomyCommands } from '../src/sim/economy';
import { registerUnitCommands } from '../src/sim/units';
import { type BuildingKind } from '../src/sim/city';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { createIntelSystem, registerIntelCommands } from '../src/sim/intel';
import { registerUpgradeCommands } from '../src/sim/upgrades';
import { registerAgeCommands , getAgeState } from '../src/sim/ages';
import {
  createSuperweaponSystem,
  registerSuperweaponCommands,
} from '../src/sim/superweapons';
import { createMayorSystem, createGeneralSystem } from '../src/sim/delegation';
import { addAIPlayer, createAISystem } from '../src/sim/ai';
import type { AIDifficulty } from '../src/sim/ai';
import { grantAllTrainingResources } from './sim.roster-fixtures';

/** Run only the AI system's per-tick credits (no think) at tick 30. */
function runEconomyCredit(world: World, difficulty: AIDifficulty, completed: BuildingKind[]): void {
  addAIPlayer(world, 0, difficulty, 0, 0);
  const ai = world.ai.players.find((p) => p.owner === 0);
  if (!ai) throw new Error('ai-virtual-economy: AI player missing');
  ai.virtualBuildings.completed = completed;
  ai.nextThinkTick = 1000; // the think must not run — credits only
  world.tick = 30; // creditVirtualEconomy fires on the 1 Hz cadence
  const queue = createCommandQueue();
  const aiSystem = createAISystem(queue);
  aiSystem(world, 0);
}

describe('virtual tax stipend math (R1 C2)', () => {
  it('marshal: harvest + stipend + materials leg credit exactly', () => {
    const world = createWorld(11);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('ai-virtual-economy: player 0 missing');
    const before = {
      funds: player.funds,
      materials: player.materials,
      manpower: player.manpower,
      research: player.research,
      influence: player.influence,
    };
    // taxBase: barracks 4 + warFactory 6 + lab 6 + civilAirport 8 +
    // mediaCenter 7 = 31. Marshal factor 2.0 at the 10% default rate:
    // stipend = 31 × 0.10 × 2.0 = 6.2 funds/sim-second.
    runEconomyCredit(world, 'marshal', [
      'barracks',
      'warFactory',
      'lab',
      'civilAirport',
      'mediaCenter',
    ]);
    // Funds: the civilAirport landing-fee harvest (1.0) + the stipend.
    expect(player.funds - before.funds).toBeCloseTo(1.0 + 6.2, 9);
    // Materials: the warFactory output trickle (0.5) + half the stipend
    // bought at the fixed market rate (2.4 funds/material).
    expect(player.materials - before.materials).toBeCloseTo(0.5 + (6.2 * 0.5) / 2.4, 9);
    // Untouched outputs still credit exactly as before.
    expect(player.manpower - before.manpower).toBeCloseTo(0.8, 9);
    expect(player.research - before.research).toBeCloseTo(0.4, 9);
    expect(player.influence - before.influence).toBeCloseTo(0.8, 9);
  });

  it('cadet: no stipend (builds nothing, spends nothing — by design)', () => {
    const world = createWorld(12);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('ai-virtual-economy: player 0 missing');
    const before = { funds: player.funds, materials: player.materials };
    runEconomyCredit(world, 'cadet', ['civilAirport']);
    // Harvest still credits (the building exists virtually); the tax
    // stipend factor for cadet is 0.
    expect(player.funds - before.funds).toBeCloseTo(1.0, 9);
    expect(player.materials - before.materials).toBeCloseTo(0, 9);
  });

  it('peaceful AI holds no virtual buildings: the credit is a no-op', () => {
    const world = createWorld(13);
    const player = getPlayer(world.city, 0);
    if (!player) throw new Error('ai-virtual-economy: player 0 missing');
    const before = { funds: player.funds, materials: player.materials };
    runEconomyCredit(world, 'marshal', []);
    expect(player.funds - before.funds).toBe(0);
    expect(player.materials - before.materials).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Headless industry-age soak (the C2 acceptance test)
// ---------------------------------------------------------------------------

/** Nearest land cell to (x, z) — the AI needs a dry base site. */
function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 120; r += 2) {
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
  throw new Error('ai-virtual-economy: no land near requested base');
}

describe('industry-age soak (R1 C2 acceptance)', () => {
  it('marshal-vs-marshal reaches the industry age (seed 20260930)', () => {
    const seed = 20260930;
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    const world = createWorld(seed);
    const bases = [
      { x: -180, z: 80 },
      { x: -80, z: 80 },
    ];
    for (let i = 0; i < 2; i++) {
      const spot = findLandNear(t, bases[i]!.x, bases[i]!.z);
      addAIPlayer(world, i, 'marshal', spot.x, spot.z);
    }
    // Full production stack, mirroring ui/session.ts (the phase9
    // longsoak wiring).
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, t);
    registerEconomyCommands(queue);
    registerUnitCommands(queue, t);
    registerMovementCommands(queue, t);
    registerCombatCommands(queue);
    registerIntelCommands(queue);
    registerLogisticsCommands(queue, t);
    registerAgeCommands(queue);
    registerSuperweaponCommands(queue);
    registerUpgradeCommands(queue);
    const driver = createTickDriver({
      queue,
      systems: [
        createPathfindingSystem(t),
        createMovementSystem(t),
        createCombatSystem(),
        createSuperweaponSystem(),
        createEconomySystem(t),
        createIntelSystem(),
        createMayorSystem(queue, t),
        createGeneralSystem(queue),
        createAISystem(queue, t),
      ],
    });
    grantAllTrainingResources(world);
    // The Phase 9 headline config caps at 30000 ticks; industry was
    // reached at tick ~17162 when this test was written — the cap
    // leaves generous headroom without asserting an exact tick.
    for (let tick = 1; tick <= 30000; tick++) {
      driver.step(world, TICK_MS); // must never throw
    }
    // Industry, information, and ascendance all prove the age ladder
    // is no longer stuck at connectivity (the Phase 9 finding).
    expect(['industry', 'information', 'ascendance']).toContain(getAgeState(world, 0).age);
  }, 600000);
});
