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
 * NOVATERRA — Classic AI production / research / naval tests
 * (roster-expansion checkpoint).
 *
 * Covers the expanded AI:
 *  - virtual production-building construction (cost, build time, unlock)
 *  - the "stuck at 6 units" regression: ungated fallback while building
 *  - cadet: builds/researches nothing, trains only rifles
 *  - upgrade research priorities (commander+)
 *  - expanded counter table (frigates vs subs, spectres vs artillery)
 *  - naval probing: coastal detection, fishing fleet, landlocked maps
 *  - marshal age advancement
 *  - snapshot round-trip of the new AI state
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
  MAP_PRESETS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import { MAP_HALF_SIZE, getPlayer, hasProductionBuilding } from '../src/sim/city';
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
  canTrain,
  type AIDifficulty,
} from '../src/sim/ai';
import { hasUpgrade } from '../src/sim/upgrades';
import { variantBaseOf } from '../src/sim/variants';
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
  if (!cachedTerrain) cachedTerrain = generateTerrain(MAP_PRESETS[0]!.seed, MAP_PRESETS[0]);
  return cachedTerrain;
}

let cachedArchipelago: TerrainData | null = null;
function getArchipelago(): TerrainData {
  if (!cachedArchipelago) {
    cachedArchipelago = generateTerrain(MAP_PRESETS[4]!.seed, MAP_PRESETS[4]);
  }
  return cachedArchipelago;
}

/** AI test context WITHOUT pre-placed production buildings (default). */
function setupAI(seed = 20260928, terrain?: TerrainData): Ctx {
  const t = terrain ?? getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, t);
  registerMovementCommands(queue, t);
  registerCombatCommands(queue);
  registerAgeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(t),
      createMovementSystem(t),
      createCombatSystem(),
      createAISystem(queue),
    ],
  });
  return { terrain: t, world, queue, driver };
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

/** Find land with water within `radius` (for coast/sub tests). Deterministic. */
function findCoast(t: TerrainData, radius: number): { base: { x: number; z: number }; water: { x: number; z: number } } {
  for (let gz = -200; gz <= 200; gz += 5) {
    for (let gx = -200; gx <= 200; gx += 5) {
      if (isWater(t, gx, gz)) continue;
      for (let dz = -radius; dz <= radius; dz += 5) {
        for (let dx = -radius; dx <= radius; dx += 5) {
          if (Math.abs(gx + dx) > MAP_HALF_SIZE - 1 || Math.abs(gz + dz) > MAP_HALF_SIZE - 1) continue;
          if (isWater(t, gx + dx, gz + dz)) {
            return { base: { x: gx, z: gz }, water: { x: gx + dx, z: gz + dz } };
          }
        }
      }
    }
  }
  throw new Error('no coast found');
}

/**
 * Naval probe ring, mirroring ai.ts (radii × 8 compass directions).
 * Kept in sync by the landlocked/coastal tests failing loudly if it drifts.
 */
const PROBE_RADII = [40, 80, 140, 220];
function probePoint(bx: number, bz: number, i: number): { x: number; z: number } {
  const r = PROBE_RADII[Math.floor(i / 8)]!;
  const a = ((i % 8) / 8) * Math.PI * 2;
  return { x: bx + Math.round(Math.cos(a) * r), z: bz + Math.round(Math.sin(a) * r) };
}

/** Land base where the earliest probe-ring point is water (fast coastal test). */
function findProbeBase(t: TerrainData, nearWaterRadius = 0): { x: number; z: number } {
  let best: { x: number; z: number } | null = null;
  let bestIdx = Infinity;
  for (let gz = -200; gz <= 200; gz += 8) {
    for (let gx = -200; gx <= 200; gx += 8) {
      if (isWater(t, gx, gz)) continue;
      if (nearWaterRadius > 0 && !findWaterWithin(t, gx, gz, nearWaterRadius)) continue;
      for (let i = 0; i < 32; i++) {
        const p = probePoint(gx, gz, i);
        if (Math.abs(p.x) >= MAP_HALF_SIZE - 1 || Math.abs(p.z) >= MAP_HALF_SIZE - 1) continue;
        if (isWater(t, p.x, p.z)) {
          if (i < bestIdx) {
            bestIdx = i;
            best = { x: gx, z: gz };
          }
          break;
        }
      }
    }
  }
  if (!best) throw new Error('no probe base found');
  return best;
}

/** Land base where every probe-ring point is land (landlocked test). */
function findLandlockedBase(t: TerrainData): { x: number; z: number } {
  for (let gz = -160; gz <= 160; gz += 8) {
    for (let gx = -160; gx <= 160; gx += 8) {
      if (isWater(t, gx, gz)) continue;
      let allLand = true;
      for (let i = 0; i < 32; i++) {
        const p = probePoint(gx, gz, i);
        if (Math.abs(p.x) >= MAP_HALF_SIZE - 1 || Math.abs(p.z) >= MAP_HALF_SIZE - 1) continue;
        if (isWater(t, p.x, p.z)) {
          allLand = false;
          break;
        }
      }
      if (allLand) return { x: gx, z: gz };
    }
  }
  throw new Error('no landlocked base found');
}

/** Nearest water point within `maxDist` of (x, z), or null. Deterministic. */
function findWaterWithin(
  t: TerrainData,
  x: number,
  z: number,
  maxDist: number,
): { x: number; z: number } | null {
  for (let r = 0; r <= maxDist; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > MAP_HALF_SIZE - 1 || Math.abs(cz) > MAP_HALF_SIZE - 1) continue;
        if (isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  return null;
}

/** Set exact stockpiles for the AI player (white-box test control). */
function setStocks(ctx: Ctx, owner: number, funds: number, materials: number): void {
  const p = getPlayer(ctx.world.city, owner)!;
  p.funds = funds;
  p.materials = materials;
  p.manpower = 10000;
  p.research = 10000;
}

function countOwnerUnits(world: World, owner: number): number {
  return world.units.filter((u) => u.owner === owner && u.hp > 0).length;
}

/** Advance both sides' ages via the real advanceAge command. The fixture
 * stages a scenario (not the age race): per-side ages (roadmap A1,
 * 2026-10-01) mean both the AI side and the staged enemy side need the
 * age for their gates (research, unit spawns). */
function advanceAge(ctx: Ctx, program: string): void {
  // Later ages cost influence; the fixture tops it up (test control).
  for (const owner of [0, 1]) {
    const p = getPlayer(ctx.world.city, owner)!;
    p.influence = Math.max(p.influence, 100000);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner, program } }]);
  }
  runTicks(ctx, 2);
}

describe('virtual construction', () => {
  it('citizen constructs barracks first, paying the full cost upfront', () => {
    const ctx = setupAI();
    setStocks(ctx, 1, 5000, 2000);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    runTicks(ctx, 120 + 2);
    const ai = ctx.world.ai.players[0]!;
    // Barracks: 700 funds / 250 materials / 40s build time.
    expect(ai.virtualBuildings.constructing?.kind).toBe('barracks');
    expect(ai.virtualBuildings.constructing?.readyTick).toBe(120 + 40 * 30);
    const p = getPlayer(ctx.world.city, 1)!;
    // 5000 - 700 (barracks) - 60 (the first fallback rifles).
    expect(p.funds).toBe(4240);
    expect(p.materials).toBe(1750);
  });

  it('barracks completes after its build time, then warFactory starts', () => {
    const ctx = setupAI();
    setStocks(ctx, 1, 20000, 20000);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // Barracks ready at tick 1320; the think at 1320 completes it and
    // starts the warFactory (1100 funds / 450 materials / 60s).
    runTicks(ctx, 1320 + 120 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.virtualBuildings.completed).toContain('barracks');
    expect(ai.virtualBuildings.constructing?.kind).toBe('warFactory');
  });

  it('warFactory completion unlocks tanks: the mix shifts once it is done', () => {
    const ctx = setupAI();
    setStocks(ctx, 1, 20000, 20000);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    // WarFactory ready at tick 3120. Before that, only rifles are trainable.
    runTicks(ctx, 120 * 10);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.virtualBuildings.completed).not.toContain('warFactory');
    expect(ai.builtCounts['tank'] ?? 0).toBe(0);
    expect(canTrain(ctx.world, 1, 'tank')).toBe(false);
    // Free some cap room (white-box kills) after the factory completes so
    // the new mix has somewhere to go.
    runTicks(ctx, 3120 - 120 * 10 + 240);
    expect(ai.virtualBuildings.completed).toContain('warFactory');
    expect(canTrain(ctx.world, 1, 'tank')).toBe(true);
    for (const u of ctx.world.units) {
      if (u.owner === 1 && u.kind === 'rifles') u.hp = 0;
    }
    runTicks(ctx, 120 * 6 + 2);
    // With tanks unlocked and rifles below their share, the mix builds tanks.
    expect(ai.builtCounts['tank'] ?? 0).toBeGreaterThan(0);
  });

  it('construction never exceeds one building at a time and never duplicates real buildings', () => {
    const ctx = setupAI();
    setStocks(ctx, 1, 20000, 20000);
    // The human-equivalent real buildings already exist: the AI must not
    // virtually duplicate them.
    completeBuildings(ctx.world, 1, ['barracks', 'warFactory']);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    runTicks(ctx, 120 * 6 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.virtualBuildings.completed).toEqual([]);
    // Phase 3 logistics (2026-09-30): the slot may hold a logistics depot
    // (the citizen trains tanks → ≥4 fuel consumers → fuelDepot), but never
    // a production building — the no-duplication invariant is about the
    // production path, and the one-at-a-time slot is still respected.
    const constructing = ai.virtualBuildings.constructing?.kind ?? null;
    expect(['barracks', 'warFactory', 'lab']).not.toContain(constructing);
    expect(constructing === null || constructing === 'fuelDepot' || constructing === 'ordnanceDepot').toBe(true);
    // ...but the gated units are still trainable via the real buildings.
    expect(canTrain(ctx.world, 1, 'tank')).toBe(true);
  });
});

describe('stuck-at-6 regression', () => {
  it('citizen with no production buildings grows past 6 on the rifles fallback', () => {
    const ctx = setupAI();
    // Enough for barracks + a rifles fallback force, but warFactory is
    // still 1200 ticks away: the AI must not stall waiting for tanks.
    setStocks(ctx, 1, 3000, 1000);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    runTicks(ctx, 120 * 10 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(countOwnerUnits(ctx.world, 1)).toBeGreaterThan(6);
    // No gated kinds were built while locked.
    expect(ai.builtCounts['tank'] ?? 0).toBe(0);
    expect(ai.builtCounts['artillery'] ?? 0).toBe(0);
    const kinds = new Set(
      ctx.world.units.filter((u) => u.owner === 1 && u.hp > 0).map((u) => u.kind),
    );
    expect([...kinds]).toEqual(['rifles']);
  });
});

describe('cadet', () => {
  it('constructs nothing, researches nothing, trains only rifles', () => {
    const ctx = setupAI();
    setStocks(ctx, 1, 20000, 20000);
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'cadet', base.x, base.z);
    runTicks(ctx, 240 * 8 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.virtualBuildings.completed).toEqual([]);
    expect(ai.virtualBuildings.constructing).toBeNull();
    expect(Object.keys(ai.builtCounts)).toEqual(['rifles']);
    // Funds went only to rifles (60 each): no 700-funds barracks payment.
    const p = getPlayer(ctx.world.city, 1)!;
    expect(p.funds).toBe(20000 - (ai.builtCounts['rifles'] ?? 0) * 60);
    for (const id of [
      'apRounds',
      'compositeArmor',
      'engineTuning',
      'droneOptics',
      'precisionManufacturing',
    ] as const) {
      expect(hasUpgrade(ctx.world, 1, id)).toBe(false);
    }
  });
});

describe('research priorities', () => {
  it('commander researches apRounds first, then compositeArmor, at industry', () => {
    const ctx = setupAI();
    completeBuildings(ctx.world, 1, ['barracks', 'warFactory', 'lab']);
    getPlayer(ctx.world.city, 1)!.research = 100000;
    advanceAge(ctx, 'fiberGrid');
    advanceAge(ctx, 'heavyIndustry');
    expect(getAgeState(ctx.world, 0).age).toBe('industry');
    expect(getAgeState(ctx.world, 1).age).toBe('industry');
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    runTicks(ctx, 60 * 2 + 2);
    expect(hasUpgrade(ctx.world, 1, 'apRounds')).toBe(true);
    expect(hasUpgrade(ctx.world, 1, 'compositeArmor')).toBe(true);
    // engineTuning is connectivity-gated: not yet, even with priority.
    expect(hasUpgrade(ctx.world, 1, 'engineTuning')).toBe(false);
  });

  it('engineTuning waits for 4+ vehicles, then is researched', () => {
    const ctx = setupAI();
    completeBuildings(ctx.world, 1, ['barracks', 'warFactory', 'lab']);
    getPlayer(ctx.world.city, 1)!.research = 100000;
    advanceAge(ctx, 'fiberGrid');
    expect(getAgeState(ctx.world, 0).age).toBe('connectivity');
    expect(getAgeState(ctx.world, 1).age).toBe('connectivity');
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    // At connectivity with no vehicles: droneOptics researches (always),
    // but engineTuning waits for its 4-vehicle condition.
    runTicks(ctx, 60 * 3 + 2);
    expect(hasUpgrade(ctx.world, 1, 'engineTuning')).toBe(false);
    expect(hasUpgrade(ctx.world, 1, 'droneOptics')).toBe(true);
    // Field 4 tanks for the AI, then it picks up engineTuning.
    for (let i = 0; i < 4; i++) {
      const spot = findLandNear(ctx.terrain, base.x + 10 + i * 3, base.z);
      const id = ctx.world.nextId;
      enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'tank', owner: 1, x: spot.x, z: spot.z } }]);
      runTicks(ctx, 1);
      expect(findUnit(ctx.world, id)).toBeDefined();
    }
    runTicks(ctx, 60 * 2 + 2);
    expect(hasUpgrade(ctx.world, 1, 'engineTuning')).toBe(true);
  });

  it('sonarSuite is prioritized once a submarine is seen', () => {
    const ctx = setupAI();
    completeBuildings(ctx.world, 1, ['barracks', 'warFactory', 'lab', 'navalYard']);
    // The enemy trains through the same production gate.
    completeBuildings(ctx.world, 0, ['navalYard']);
    getPlayer(ctx.world.city, 1)!.research = 100000;
    advanceAge(ctx, 'fiberGrid');
    advanceAge(ctx, 'heavyIndustry');
    expect(getAgeState(ctx.world, 0).age).toBe('industry');
    expect(getAgeState(ctx.world, 1).age).toBe('industry');
    const coast = findCoast(ctx.terrain, 12);
    // Enemy submarine in the water, inside rifles sight of the AI base.
    const id = ctx.world.nextId;
    enqueue(ctx, [
      { kind: 'spawnUnit', payload: { kind: 'submarine', owner: 0, x: coast.water.x, z: coast.water.z } },
    ]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, id)).toBeDefined();
    addAIPlayer(ctx.world, 1, 'commander', coast.base.x, coast.base.z);
    runTicks(ctx, 60 * 4 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.seenSubmarine).toBe(true);
    // Priority order at industry: apRounds, compositeArmor, sonarSuite
    // (engineTuning is connectivity-gated and correctly skipped).
    expect(hasUpgrade(ctx.world, 1, 'sonarSuite')).toBe(true);
  });
});

describe('expanded counters', () => {
  it('commander answers submarines with frigates', () => {
    const ctx = setupAI(20260928, getArchipelago());
    // Frigates require a navalYard (industry); the counter skips otherwise.
    completeBuildings(ctx.world, 1, ['barracks', 'warFactory', 'navalYard']);
    // The enemy trains through the same production gate.
    completeBuildings(ctx.world, 0, ['navalYard']);
    advanceAge(ctx, 'fiberGrid');
    advanceAge(ctx, 'heavyIndustry');
    // Base with early probe water; the enemy sub lurks in nearby water,
    // inside the sight of the AI's first units.
    const base = findProbeBase(ctx.terrain, 24);
    const subWater = findWaterWithin(ctx.terrain, base.x, base.z, 24);
    expect(subWater).not.toBeNull();
    const id = ctx.world.nextId;
    enqueue(ctx, [
      { kind: 'spawnUnit', payload: { kind: 'submarine', owner: 0, x: subWater!.x, z: subWater!.z } },
    ]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, id)).toBeDefined();
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    runTicks(ctx, 60 * 10 + 2);
    const ai = ctx.world.ai.players[0]!;
    // The probe found the coast, the sub was seen, and the counter fired:
    // frigates (sea units) launch from the probed water.
    expect(ai.navalStatus).toBe('coastal');
    expect(ai.seenSubmarine).toBe(true);
    // B6 (commander age advancement) + M15 (variant substitution): the
    // commander advances to ascendance during the run and the counter
    // then trains the best frigate available (frigateMk3), not the base
    // kind — builtCounts is keyed by the trained kind, so count the
    // whole frigate family via variantBaseOf.
    const frigatesBuilt = Object.entries(ai.builtCounts)
      .filter(([kind]) => variantBaseOf(kind as UnitKind) === 'frigate')
      .reduce((sum, [, n]) => sum + n, 0);
    expect(frigatesBuilt).toBeGreaterThan(0);
  });

  it('commander answers artillery parks with spectres', () => {
    const ctx = setupAI();
    completeBuildings(ctx.world, 1, ['barracks', 'warFactory']);
    // The enemy trains through the same production gate.
    completeBuildings(ctx.world, 0, ['barracks', 'warFactory']);
    const base = findLandNear(ctx.terrain, -100, -100);
    const enemyPos = findLandNear(ctx.terrain, -85, -100);
    for (const dx of [0, 6]) {
      const id = ctx.world.nextId;
      enqueue(ctx, [
        { kind: 'spawnUnit', payload: { kind: 'artillery', owner: 0, x: enemyPos.x + dx, z: enemyPos.z } },
      ]);
      runTicks(ctx, 1);
      expect(findUnit(ctx.world, id)).toBeDefined();
    }
    addAIPlayer(ctx.world, 1, 'commander', base.x, base.z);
    runTicks(ctx, 60 * 8 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.builtCounts['spectre'] ?? 0).toBeGreaterThan(0);
  });
});

describe('naval', () => {
  it('general probes and finds water on a coastal map', () => {
    const ctx = setupAI(20260928, getArchipelago());
    const base = findProbeBase(ctx.terrain);
    addAIPlayer(ctx.world, 1, 'general', base.x, base.z);
    runTicks(ctx, 45 * 6 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.navalStatus).toBe('coastal');
    expect(ai.navalWater).not.toBeNull();
    // The successful probe IS a fishing boat (it costs the normal price).
    const boats = ctx.world.units.filter(
      (u) => u.owner === 1 && u.kind === 'fishingBoat' && u.hp > 0,
    );
    expect(boats.length).toBeGreaterThan(0);
  });

  it('coastal general works up a fishing fleet', () => {
    const ctx = setupAI(20260928, getArchipelago());
    const base = findProbeBase(ctx.terrain);
    addAIPlayer(ctx.world, 1, 'general', base.x, base.z);
    runTicks(ctx, 45 * 14 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.navalStatus).toBe('coastal');
    expect(ai.builtCounts['fishingBoat'] ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('general concludes landlocked when no probe finds water', () => {
    const ctx = setupAI();
    const base = findLandlockedBase(ctx.terrain);
    addAIPlayer(ctx.world, 1, 'general', base.x, base.z);
    // 32 probe points, 2 per think → 16 thinks to exhaust the ring.
    runTicks(ctx, 45 * 20 + 2);
    const ai = ctx.world.ai.players[0]!;
    expect(ai.navalStatus).toBe('landlocked');
    expect(ai.builtCounts['fishingBoat'] ?? 0).toBe(0);
    // ...and it never probes again.
    const idx = ai.navalProbeIndex;
    runTicks(ctx, 45 * 4);
    expect(ai.navalProbeIndex).toBe(idx);
    expect(ai.navalStatus).toBe('landlocked');
  });
});

describe('marshal', () => {
  it('advances ages when it can afford to', () => {
    const ctx = setupAI();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'marshal', base.x, base.z);
    runTicks(ctx, 30 * 12 + 2);
    expect(getAgeState(ctx.world, 1).age).not.toBe('foundation');
  });

  it('marshal constructs production buildings in priority order', () => {
    const ctx = setupAI();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'marshal', base.x, base.z);
    runTicks(ctx, 30 * 6 + 2);
    const ai = ctx.world.ai.players[0]!;
    // Barracks first (or already completed); never two at once.
    const seen = [...ai.virtualBuildings.completed];
    if (ai.virtualBuildings.constructing) seen.push(ai.virtualBuildings.constructing.kind);
    expect(seen[0]).toBe('barracks');
  });
});

describe('AI state snapshot', () => {
  it('round-trips virtual buildings and naval state', () => {
    const ctx = setupAI();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, 'citizen', base.x, base.z);
    runTicks(ctx, 120 + 2);
    const before = digestWorld(ctx.world);
    const snap = takeSnapshot(ctx.world);
    const restored = restoreSnapshot(snap);
    expect(digestWorld(restored)).toBe(before);
    const ai = restored.ai.players[0]!;
    expect(ai.virtualBuildings.constructing?.kind).toBe('barracks');
    expect(ai.navalStatus).toBe('unknown');
    expect(ai.seenSubmarine).toBe(false);
    // Old snapshots (without the new fields) decode with safe defaults.
    const legacy = takeSnapshot(ctx.world) as unknown as Record<string, unknown>;
    const aiState = legacy['ai'] as { players: Record<string, unknown>[] };
    for (const p of aiState.players) {
      delete p['virtualBuildings'];
      delete p['navalStatus'];
      delete p['navalProbeIndex'];
      delete p['navalWater'];
      delete p['seenSubmarine'];
    }
    const restoredLegacy = restoreSnapshot(legacy as never);
    const lai = restoredLegacy.ai.players[0]!;
    expect(lai.virtualBuildings.completed).toEqual([]);
    expect(lai.virtualBuildings.constructing).toBeNull();
    expect(lai.navalStatus).toBe('unknown');
    expect(lai.seenSubmarine).toBe(false);
  });
});

describe('composition caps', () => {
  it.each([
    ['cadet', 6],
    ['citizen', 14],
    ['commander', 26],
    ['general', 34],
    ['marshal', 48],
  ] as Array<[AIDifficulty, number]>)('%s never exceeds its %i-unit cap', (diff, cap) => {
    const ctx = setupAI();
    const base = findLandNear(ctx.terrain, -100, -100);
    addAIPlayer(ctx.world, 1, diff, base.x, base.z);
    // Run long enough to hit any cap (marshal: 48 units at ~1-3/think).
    runTicks(ctx, 30 * 60 + 2);
    expect(countOwnerUnits(ctx.world, 1)).toBeLessThanOrEqual(cap);
  });
});
