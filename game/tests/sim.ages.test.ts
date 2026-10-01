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
 * NOVATERRA — Ages tests (Phase 1, step 8).
 *
 * Covers the Foundation → Connectivity age-up with the National Program choice:
 *  - Starts in Foundation with no program chosen
 *  - Cannot advance without paying the cost (rejection)
 *  - Cannot advance without choosing a program (rejection)
 *  - Can advance to Connectivity by picking Fiber Grid OR Signals Grid
 *  - The choice is permanent (cannot switch programs, cannot re-advance)
 *  - Effects apply: Fiber Grid boosts tax income, Signals Grid boosts sight
 *  - Age-gated units (fighter) are blocked in Foundation, allowed in Connectivity
 *  - Snapshot/restore preserves age state; digest is deterministic
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
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
  registerAgeCommands,
  CONNECTIVITY_COST,
  FIBER_GRID_TAX_MULTIPLIER,
  SIGNALS_GRID_SIGHT_BONUS,
  getTaxMultiplier,
  getSightBonus,
  initAges,
} from '../src/sim/ages';
import { getVisibleEnemies } from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot, SNAPSHOT_VERSION } from '../src/sim/snapshot';
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
  // and the production buildings the roster expansion requires.
  grantAllTrainingResources(world);
  for (const p of world.city.players) {
    completeBuildings(world, p.id, ['barracks', 'warFactory', 'airfield']);
  }
  const queue = createCommandQueue();
  registerCoreCommands(queue);
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

function rejectionReason(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).reason;
  }
  throw new Error('expected a CommandRejectedError but none was thrown');
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

/** Give the player enough resources to afford the age-up. */
function fundPlayer(ctx: Ctx, owner = 0): void {
  const player = getPlayer(ctx.world.city, owner)!;
  player.funds = CONNECTIVITY_COST.funds + 1000;
  player.materials = CONNECTIVITY_COST.materials + 1000;
}

describe('initial state', () => {
  it('starts in Foundation with no program chosen', () => {
    const ctx = setup();
    expect(ctx.world.ages.age).toBe('foundation');
    expect(ctx.world.ages.program).toBeNull();
  });

  it('initAges returns Foundation with null program', () => {
    expect(initAges()).toEqual({ age: 'foundation', program: null, programs: {} });
  });

  it('snapshot version is 8 (Phase 5/6 S4: hangar slots + embark fields)', () => {
    expect(SNAPSHOT_VERSION).toBe(8);
  });
});

describe('advanceAge validation', () => {
  it('rejects without a program choice', () => {
    const ctx = setup();
    fundPlayer(ctx);
    const reason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0 } }]),
    );
    expect(reason).toMatch(/program must be/);
  });

  it('rejects with an invalid program choice', () => {
    const ctx = setup();
    fundPlayer(ctx);
    const reason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fusionPilot' } }]),
    );
    expect(reason).toMatch(/program must be/);
  });

  it('rejects when the player cannot afford the funds cost', () => {
    const ctx = setup();
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = CONNECTIVITY_COST.funds - 1;
    player.materials = CONNECTIVITY_COST.materials + 1000;
    const reason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]),
    );
    expect(reason).toMatch(/cannot afford.*funds/);
  });

  it('rejects when the player cannot afford the materials cost', () => {
    const ctx = setup();
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = CONNECTIVITY_COST.funds + 1000;
    player.materials = CONNECTIVITY_COST.materials - 1;
    const reason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]),
    );
    expect(reason).toMatch(/cannot afford.*materials/);
  });

  it('rejects for an unknown owner', () => {
    const ctx = setup();
    const reason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 999, program: 'fiberGrid' } }]),
    );
    expect(reason).toMatch(/unknown owner/);
  });
});

describe('same-tick double advance (Phase 9 soak finding 6.1)', () => {
  it('two issuers advancing on the same tick: the second fizzles, no crash, single charge', () => {
    const ctx = setup();
    fundPlayer(ctx);
    const player = getPlayer(ctx.world.city, 0)!;
    const fundsBefore = player.funds;
    const matsBefore = player.materials;
    // Two AIs (or a human and an AI) thinking on the same tick both see
    // Foundation and both enqueue the world-global advanceAge. The
    // payload carries the age each issuer saw (fromAge), so the second
    // apply fizzles instead of going stale and crashing the tick.
    ctx.queue.enqueue(ctx.world, {
      issuer: 'ai',
      kind: 'advanceAge',
      payload: { owner: 0, program: 'fiberGrid', fromAge: 'foundation' },
    });
    ctx.queue.enqueue(ctx.world, {
      issuer: 'player',
      kind: 'advanceAge',
      payload: { owner: 0, program: 'signalsGrid', fromAge: 'foundation' },
    });
    expect(() => runTicks(ctx, 1)).not.toThrow();
    expect(ctx.world.ages.age).toBe('connectivity');
    // The first applier (issuer 'ai' sorts before 'player') wins the
    // program choice; the cost is deducted exactly once.
    expect(ctx.world.ages.program).toBe('fiberGrid');
    expect(player.funds).toBeCloseTo(fundsBefore - CONNECTIVITY_COST.funds, 6);
    expect(player.materials).toBeCloseTo(matsBefore - CONNECTIVITY_COST.materials, 6);
  });

  it('a duplicate for an already-passed age fizzles even across ages', () => {
    const ctx = setup();
    fundPlayer(ctx);
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds += 100000;
    player.materials += 100000;
    // Advance to connectivity first.
    ctx.queue.enqueue(ctx.world, {
      issuer: 'ai',
      kind: 'advanceAge',
      payload: { owner: 0, program: 'fiberGrid', fromAge: 'foundation' },
    });
    runTicks(ctx, 1);
    expect(ctx.world.ages.age).toBe('connectivity');
    const fundsBefore = player.funds;
    // A late duplicate that saw foundation (e.g. enqueued long ago)
    // fizzles without charging or crashing.
    ctx.queue.enqueue(ctx.world, {
      issuer: 'ai',
      kind: 'advanceAge',
      payload: { owner: 0, program: 'fiberGrid', fromAge: 'foundation' },
    });
    expect(() => runTicks(ctx, 1)).not.toThrow();
    expect(ctx.world.ages.age).toBe('connectivity');
    expect(player.funds).toBeCloseTo(fundsBefore, 6);
  });

  it('legacy: same-tick double advance WITHOUT fromAge still throws loudly (no silent double-charge)', () => {
    const ctx = setup();
    fundPlayer(ctx);
    ctx.queue.enqueue(ctx.world, {
      issuer: 'ai',
      kind: 'advanceAge',
      payload: { owner: 0, program: 'fiberGrid' },
    });
    ctx.queue.enqueue(ctx.world, {
      issuer: 'player',
      kind: 'advanceAge',
      payload: { owner: 0, program: 'signalsGrid' },
    });
    expect(() => runTicks(ctx, 1)).toThrow(CommandRejectedError);
  });
});

describe('advancing to Connectivity', () => {
  it('advances with Fiber Grid, deducting the cost', () => {
    const ctx = setup();
    fundPlayer(ctx);
    const player = getPlayer(ctx.world.city, 0)!;
    const fundsBefore = player.funds;
    const matsBefore = player.materials;
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]);
    runTicks(ctx, 1);
    expect(ctx.world.ages.age).toBe('connectivity');
    expect(ctx.world.ages.program).toBe('fiberGrid');
    expect(player.funds).toBeCloseTo(fundsBefore - CONNECTIVITY_COST.funds, 6);
    expect(player.materials).toBeCloseTo(matsBefore - CONNECTIVITY_COST.materials, 6);
  });

  it('advances with Signals Grid', () => {
    const ctx = setup();
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]);
    runTicks(ctx, 1);
    expect(ctx.world.ages.age).toBe('connectivity');
    expect(ctx.world.ages.program).toBe('signalsGrid');
  });

  it('the choice is permanent: cannot switch programs within an age', () => {
    const ctx = setup();
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]);
    runTicks(ctx, 1);
    expect(ctx.world.ages.age).toBe('connectivity');
    // Cannot re-choose a Connectivity program (must pick an Industry program to advance).
    const reason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]),
    );
    expect(reason).toMatch(/program must be one of heavyIndustry, greenTech/);
    // Program did not change.
    expect(ctx.world.ages.program).toBe('fiberGrid');
  });
});

describe('National Program effects', () => {
  it('Fiber Grid gives a 25% tax income multiplier', () => {
    expect(FIBER_GRID_TAX_MULTIPLIER).toBe(1.25);
    const ctx = setup();
    expect(getTaxMultiplier(ctx.world)).toBe(1.0);
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]);
    runTicks(ctx, 1);
    expect(getTaxMultiplier(ctx.world)).toBe(1.25);
  });

  it('Signals Grid does not boost taxes', () => {
    const ctx = setup();
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]);
    runTicks(ctx, 1);
    expect(getTaxMultiplier(ctx.world)).toBe(1.0);
  });

  it('Signals Grid gives +8 sight bonus', () => {
    expect(SIGNALS_GRID_SIGHT_BONUS).toBe(8);
    const ctx = setup();
    expect(getSightBonus(ctx.world)).toBe(0);
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]);
    runTicks(ctx, 1);
    expect(getSightBonus(ctx.world)).toBe(8);
  });

  it('Fiber Grid does not boost sight', () => {
    const ctx = setup();
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]);
    runTicks(ctx, 1);
    expect(getSightBonus(ctx.world)).toBe(0);
  });

  it('Signals Grid extends visibility range in practice', () => {
    const ctx = setup();
    const base = findLandNear(ctx.terrain, -100, -100);
    // Spawn an observer (owner 1) and an enemy just beyond base sight.
    const observerPos = findLandNear(ctx.terrain, base.x, base.z);
    const obsId = ctx.world.nextId;
    enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'rifles', owner: 1, x: observerPos.x, z: observerPos.z } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, obsId)).toBeDefined();
    const sight = UNIT_DEFS.rifles.sight;
    // Enemy placed just outside base sight but inside sight + bonus.
    const enemyPos = findLandNear(ctx.terrain, observerPos.x + sight + 4, observerPos.z);
    const enemyId = ctx.world.nextId;
    enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'tank', owner: 0, x: enemyPos.x, z: enemyPos.z } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, enemyId)).toBeDefined();
    // Without Signals Grid: not visible.
    expect(getVisibleEnemies(ctx.world, 1).map((u) => u.id)).not.toContain(enemyId);
    // Advance to Signals Grid.
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]);
    runTicks(ctx, 1);
    // Now visible thanks to the +8 bonus.
    expect(getVisibleEnemies(ctx.world, 1).map((u) => u.id)).toContain(enemyId);
  });
});

describe('age-gated units', () => {
  it('fighter requires Connectivity in its def', () => {
    expect(UNIT_DEFS.fighter.minAge).toBe('connectivity');
  });

  it('every unit carries its spec §6 minimum age', () => {
    // Exact age assignments: the roster-expansion table
    // (docs/research/roster-expansion.md §6) extended by the
    // grand-expansion roster — Phase 5 (aircraft expansion: 16 new
    // aircraft) and Phase 6 (naval expansion). Changing a unit's age
    // is a balance decision: update this table deliberately, never to
    // make a red test green.
    const expected: Record<string, string> = {
      engineer: 'foundation', rifles: 'foundation', hauler: 'foundation',
      supplyTruck: 'foundation', fuelTruck: 'foundation',
      drone: 'foundation', spectre: 'foundation', hq: 'foundation',
      tank: 'foundation', artillery: 'foundation', aa: 'foundation',
      fishingBoat: 'foundation', transport: 'foundation',
      sniperTeam: 'connectivity', combatMedic: 'connectivity',
      apc: 'connectivity', attackHeli: 'connectivity',
      missileBoat: 'connectivity', fighter: 'connectivity',
      bus: 'connectivity', tram: 'connectivity', ferry: 'connectivity',
      reconUAV: 'connectivity', armedUAV: 'connectivity',
      reconPlane: 'connectivity', trainer: 'connectivity',
      navalFighter: 'connectivity', airliner: 'connectivity',
      regionalJet: 'connectivity', passengerHeli: 'connectivity',
      seaplane: 'connectivity', corvette: 'connectivity',
      repairShip: 'connectivity', cruiseLiner: 'connectivity',
      yacht: 'connectivity',
      patrolBoat: 'industry', transportShip: 'industry',
      destroyer: 'industry', tankDestroyer: 'industry', mlrs: 'industry',
      fighterBomber: 'industry', frigate: 'industry',
      submarine: 'industry', passengerTrain: 'industry',
      freightTrain: 'industry', gunship: 'industry', tanker: 'industry',
      militaryCargo: 'industry', jumboAirliner: 'industry',
      cargoPlane: 'industry', coastalSub: 'industry',
      heavyDestroyer: 'industry', cargoFreighter: 'industry',
      fuelTanker: 'industry', ammoShip: 'industry', minelayer: 'industry',
      navalMine: 'industry', coastGuardCutter: 'industry',
      // Civilian sea trade (Half A, 2026-10-01): the fuel barge is the
      // tanker's civilian sibling — industry age like its harbor.
      fuelBarge: 'industry',
      awacs: 'information', carrier: 'information',
      commandShip: 'information', strategicBomber: 'information',
      maritimePatrol: 'information', missileSub: 'information',
      cruiser: 'information', battleship: 'information',
      // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30).
      reconTeam: 'connectivity', spy: 'information',
      // Grand-expansion tech-level variants (PLAN §3.9, workstream D,
      // 2026-09-30): Mk II unlocks one age above its base, floored at
      // industry (foundation-base lines jump straight to industry);
      // Mk III unlocks one age above Mk II. The top of each line lands
      // in information or ascendance.
      tankMk2: 'industry', tankMk3: 'information',
      artilleryMk2: 'industry', artilleryMk3: 'information',
      aaMk2: 'industry', aaMk3: 'information',
      haulerMk2: 'industry', haulerMk3: 'information',
      apcMk2: 'industry', apcMk3: 'information',
      fighterMk2: 'industry', fighterMk3: 'information',
      attackHeliMk2: 'industry', attackHeliMk3: 'information',
      missileBoatMk2: 'industry', missileBoatMk3: 'information',
      fighterBomberMk2: 'information', fighterBomberMk3: 'ascendance',
      gunshipMk2: 'information', gunshipMk3: 'ascendance',
      destroyerMk2: 'information', destroyerMk3: 'ascendance',
      frigateMk2: 'information', frigateMk3: 'ascendance',
      submarineMk2: 'information', submarineMk3: 'ascendance',
      transportShipMk2: 'information', transportShipMk3: 'ascendance',
    };
    expect(Object.keys(UNIT_DEFS).sort()).toEqual(Object.keys(expected).sort());
    for (const [kind, age] of Object.entries(expected)) {
      expect(UNIT_DEFS[kind as UnitKind].minAge).toBe(age);
    }
  });

  it('cannot spawn a fighter in Foundation', () => {
    const ctx = setup();
    const pos = findLandNear(ctx.terrain, 0, 0);
    const reason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'fighter', owner: 0, x: pos.x, z: pos.z } }]),
    );
    expect(reason).toMatch(/requires the connectivity age/);
  });

  it('can spawn a fighter after advancing to Connectivity', () => {
    const ctx = setup();
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]);
    runTicks(ctx, 1);
    const pos = findLandNear(ctx.terrain, 0, 0);
    const id = ctx.world.nextId;
    enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'fighter', owner: 0, x: pos.x, z: pos.z } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, id)).toBeDefined();
  });

  it('can still spawn Foundation units (e.g. tank) in Foundation', () => {
    const ctx = setup();
    const pos = findLandNear(ctx.terrain, 0, 0);
    const id = ctx.world.nextId;
    enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'tank', owner: 0, x: pos.x, z: pos.z } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, id)).toBeDefined();
  });
});

describe('snapshot and digest', () => {
  it('snapshot/restore preserves age state', () => {
    const ctx = setup();
    fundPlayer(ctx);
    enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]);
    runTicks(ctx, 1);
    const snap = takeSnapshot(ctx.world);
    expect(snap.version).toBe(SNAPSHOT_VERSION);
    const restored = restoreSnapshot(snap);
    expect(restored.ages.age).toBe('connectivity');
    expect(restored.ages.program).toBe('signalsGrid');
    expect(digestWorld(restored)).toBe(digestWorld(ctx.world));
  });

  it('digest differs between ages and programs', () => {
    const dFoundation = digestWorld(setup(7).world);
    const ctxFiber = setup(7);
    fundPlayer(ctxFiber);
    enqueue(ctxFiber, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]);
    runTicks(ctxFiber, 1);
    const ctxSignals = setup(7);
    fundPlayer(ctxSignals);
    enqueue(ctxSignals, [{ kind: 'advanceAge', payload: { owner: 0, program: 'signalsGrid' } }]);
    runTicks(ctxSignals, 1);
    const dFiber = digestWorld(ctxFiber.world);
    const dSignals = digestWorld(ctxSignals.world);
    expect(dFiber).not.toBe(dFoundation);
    expect(dSignals).not.toBe(dFoundation);
    expect(dFiber).not.toBe(dSignals);
  });

  it('digest is deterministic for identical age-ups', () => {
    const run = (): number => {
      const ctx = setup(42);
      fundPlayer(ctx);
      enqueue(ctx, [{ kind: 'advanceAge', payload: { owner: 0, program: 'fiberGrid' } }]);
      runTicks(ctx, 5);
      return digestWorld(ctx.world);
    };
    expect(run()).toBe(run());
  });
});
