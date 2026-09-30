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
 * NOVATERRA — sim combat tests (Phase 1, step 7).
 *
 * Covers the 66-unit roster (19 land + 22 air + 25 sea), combat resolution
 * (targeting, range, cooldowns, armor/domain counters, HQ aura), the
 * attackUnit command, death cleanup, air-unit direct flight, and
 * determinism of combat via digest comparison.
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
import { MAP_HALF_SIZE } from '../src/sim/city';
import { findUnit, registerUnitCommands, UNIT_DEFS, HQ_AURA_RADIUS, type UnitKind } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import {
  createCombatSystem,
  registerCombatCommands,
  canTarget,
  damageMultiplier,
} from '../src/sim/combat';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { registerAgeCommands, CONNECTIVITY_COST } from '../src/sim/ages';
import { getPlayer } from '../src/sim/city';
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
  throw new Error(`no land near (${x}, ${z})`);
}

/** Spawn a unit and return its id. */
function spawnAt(ctx: Ctx, x: number, z: number, kind: UnitKind = 'rifles', owner = 0): number {
  const id = ctx.world.nextId;
  enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind, owner, x, z } }]);
  runTicks(ctx, 1);
  expect(findUnit(ctx.world, id)).toBeDefined();
  return id;
}

/** Advance the world to Connectivity (for tests that need age-gated units). */
function advanceToConnectivity(ctx: Ctx, owner = 0): void {
  const player = getPlayer(ctx.world.city, owner)!;
  player.funds = CONNECTIVITY_COST.funds + 1000;
  player.materials = CONNECTIVITY_COST.materials + 1000;
  enqueue(ctx, [{ kind: 'advanceAge', payload: { owner, program: 'fiberGrid' } }]);
  runTicks(ctx, 1);
  expect(ctx.world.ages.age).toBe('connectivity');
}

describe('roster', () => {
  it('has exactly the 68 kinds (21 land + 22 air + 25 sea: Phase 4 added 4 land + 1 sea transports, Phase 6 adds 15 sea, the aircraft workstream adds 16 air, the intel roster workstream adds 2 land)', () => {
    const kinds = Object.keys(UNIT_DEFS).sort();
    expect(kinds).toEqual(
      [
        'artillery', 'drone', 'engineer', 'fighter', 'hauler',
        'aa', 'hq', 'rifles', 'spectre', 'tank', 'transport',
        'patrolBoat', 'destroyer', 'transportShip',
        // Roster expansion (docs/research/roster-expansion.md §2).
        'sniperTeam', 'combatMedic', 'apc', 'tankDestroyer', 'mlrs',
        'fighterBomber', 'attackHeli', 'awacs',
        'missileBoat', 'frigate', 'submarine', 'carrier', 'commandShip',
        'fishingBoat',
        // Phase 3 workstream 3 (2026-09-30): the supply-chain trucks.
        'supplyTruck', 'fuelTruck',
        // Phase 4 (S7, 2026-09-30): civilian transport units.
        'bus', 'tram', 'passengerTrain', 'freightTrain', 'ferry',
        // Grand-expansion Phase 6 — naval expansion (workstream C,
        // 2026-09-30): the 15 new sea kinds.
        'coastalSub', 'missileSub', 'corvette', 'cruiser', 'battleship',
        'heavyDestroyer', 'cargoFreighter', 'fuelTanker', 'ammoShip',
        'repairShip', 'minelayer', 'navalMine', 'coastGuardCutter',
        'cruiseLiner', 'yacht',
        // Grand-expansion Phase 5 — aircraft expansion (workstream B,
        // 2026-09-30): the 16 new air kinds.
        'strategicBomber', 'maritimePatrol', 'reconUAV', 'armedUAV',
        'reconPlane', 'gunship', 'tanker', 'militaryCargo', 'trainer',
        'navalFighter', 'airliner', 'jumboAirliner', 'regionalJet',
        'cargoPlane', 'passengerHeli', 'seaplane',
        // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
        // the 2 new land intel kinds.
        'spy', 'reconTeam',
      ].sort(),
    );
    const land = kinds.filter((k) => UNIT_DEFS[k as UnitKind].domain === 'land');
    const air = kinds.filter((k) => UNIT_DEFS[k as UnitKind].domain === 'air');
    const sea = kinds.filter((k) => UNIT_DEFS[k as UnitKind].domain === 'sea');
    expect(land).toHaveLength(21);
    expect(air).toHaveLength(22);
    expect(sea).toHaveLength(25);
  });

  it('spawns with full hp, zero cooldown, no target', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, 0, 0);
    const id = spawnAt(ctx, p.x, p.z, 'tank', 0);
    const u = findUnit(ctx.world, id)!;
    expect(u.hp).toBe(UNIT_DEFS.tank.hp);
    expect(u.cooldownLeft).toBe(0);
    expect(u.targetId).toBe(0);
    expect(u.chasing).toBe(false);
    expect(u.domain).toBe('land');
  });

  it('rejects land spawns on water but allows air spawns over water', () => {
    const ctx = setup();
    // Find a water point.
    let wx = 0, wz = 0, found = false;
    for (let r = 0; r < 100 && !found; r += 4) {
      for (let dz = -r; dz <= r && !found; dz += 4) {
        for (let dx = -r; dx <= r && !found; dx += 4) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (isWater(ctx.terrain, dx, dz)) { wx = dx; wz = dz; found = true; }
        }
      }
    }
    expect(found).toBe(true);
    const landReason = rejectionReason(() =>
      enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'tank', owner: 0, x: wx, z: wz } }]),
    );
    expect(landReason).toMatch(/water/i);
    const airId = spawnAt(ctx, wx, wz, 'drone', 0);
    expect(findUnit(ctx.world, airId)!.domain).toBe('air');
  });
});

describe('attackUnit command', () => {
  it('validates: bad ids, ownership, unarmed, friendly, wrong domain', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const b = findLandNear(ctx.terrain, 40, 0);
    const tank = spawnAt(ctx, a.x, a.z, 'tank', 0);
    const enemy = spawnAt(ctx, b.x, b.z, 'rifles', 1);
    const friend = spawnAt(ctx, a.x + 5, a.z, 'rifles', 0);
    const hauler = spawnAt(ctx, a.x - 5, a.z, 'hauler', 0);
    const aa = spawnAt(ctx, a.x, a.z + 5, 'aa', 0);

    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: -1, targetId: enemy, owner: 0 } }])),
    ).toMatch(/positive integer/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: tank, targetId: enemy, owner: 1 } }])),
    ).toMatch(/not owned/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: hauler, targetId: enemy, owner: 0 } }])),
    ).toMatch(/unarmed/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: tank, targetId: friend, owner: 0 } }])),
    ).toMatch(/own unit/);
    // Mobile AA can only hit air.
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: aa, targetId: enemy, owner: 0 } }])),
    ).toMatch(/cannot target/);
  });

  it('sets targetId/chasing and moves the attacker toward the target', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const b = findLandNear(ctx.terrain, 60, 0);
    const tank = spawnAt(ctx, a.x, a.z, 'tank', 0);
    const enemy = spawnAt(ctx, b.x, b.z, 'rifles', 1);
    enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: tank, targetId: enemy, owner: 0 } }]);
    runTicks(ctx, 1);
    const u = findUnit(ctx.world, tank)!;
    expect(u.targetId).toBe(enemy);
    expect(u.chasing).toBe(true);
    expect(u.state).not.toBe('idle');
  });

  it('a plain move order clears an explicit attack (targetId/chasing)', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const b = findLandNear(ctx.terrain, 60, 0);
    const c = findLandNear(ctx.terrain, -40, 0);
    const tank = spawnAt(ctx, a.x, a.z, 'tank', 0);
    const enemy = spawnAt(ctx, b.x, b.z, 'rifles', 1);
    enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: tank, targetId: enemy, owner: 0 } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, tank)!.chasing).toBe(true);
    enqueue(ctx, [{ kind: 'moveUnit', payload: { unitId: tank, owner: 0, x: c.x, z: c.z } }]);
    runTicks(ctx, 1);
    const u = findUnit(ctx.world, tank)!;
    expect(u.targetId).toBe(0);
    expect(u.chasing).toBe(false);
  });
});

describe('combat resolution', () => {
  it('fires in range, applies cooldown, and kills deterministically', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    // Two tanks 10 apart: well inside tank range 19.
    const t1 = spawnAt(ctx, a.x, a.z, 'tank', 0);
    const t2 = spawnAt(ctx, a.x + 10, a.z, 'tank', 1);
    // During t2's spawn tick both tanks were in range and fired
    // opportunistically (no attack order needed).
    const u1 = findUnit(ctx.world, t1)!;
    const u2 = findUnit(ctx.world, t2)!;
    expect(u2.hp).toBeLessThan(UNIT_DEFS.tank.hp);
    expect(u1.cooldownLeft).toBeGreaterThan(0);
    expect(u1.cooldownLeft).toBe(UNIT_DEFS.tank.cooldownTicks);
    // Cooldown blocks a second shot on the next tick.
    const hpAfter = findUnit(ctx.world, t2)!.hp;
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, t2)!.hp).toBe(hpAfter);
  });

  it('tank bonus vs infantry, rifles penalty vs heavy armor', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const tankU = findUnit(ctx.world, spawnAt(ctx, a.x, a.z, 'tank', 0))!;
    const riflesU = findUnit(ctx.world, spawnAt(ctx, a.x + 5, a.z, 'rifles', 1))!;
    const tankT = findUnit(ctx.world, spawnAt(ctx, a.x + 10, a.z, 'tank', 1))!;
    const atk = UNIT_DEFS.tank;
    expect(damageMultiplier(ctx.world, tankU, atk, riflesU)).toBeGreaterThan(
      damageMultiplier(ctx.world, tankU, atk, tankT),
    );
    const rAtk = UNIT_DEFS.rifles;
    const riflesU2 = findUnit(ctx.world, spawnAt(ctx, a.x + 15, a.z, 'rifles', 0))!;
    expect(damageMultiplier(ctx.world, riflesU2, rAtk, tankT)).toBeLessThan(
      damageMultiplier(ctx.world, riflesU2, rAtk, riflesU),
    );
  });

  it('artillery cannot fire inside its minimum range', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const art = spawnAt(ctx, a.x, a.z, 'artillery', 0);
    // Enemy rifles 5 away: inside minRange 12.
    const enemy = spawnAt(ctx, a.x + 5, a.z, 'rifles', 1);
    const hpBefore = findUnit(ctx.world, enemy)!.hp;
    runTicks(ctx, 5);
    expect(findUnit(ctx.world, enemy)!.hp).toBe(hpBefore);
    // Sanity: artillery has a min range configured.
    expect(UNIT_DEFS.artillery.minRange).toBeGreaterThan(0);
  });

  it('artillery backs off to minimum range when ordered onto a close target', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const artId = spawnAt(ctx, a.x, a.z, 'artillery', 0);
    // Enemy 5 away: inside artillery minRange (12).
    const enemyId = spawnAt(ctx, a.x + 5, a.z, 'rifles', 1);
    const art = findUnit(ctx.world, artId)!;
    const enemy = findUnit(ctx.world, enemyId)!;
    const distBefore = Math.hypot(enemy.x - art.x, enemy.z - art.z);
    expect(distBefore).toBeLessThan(UNIT_DEFS.artillery.minRange);
    // Explicit attack order on the close target.
    enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: artId, owner: 0, targetId: enemyId } }]);
    runTicks(ctx, 1);
    // Artillery should be repositioning (backing off), not sitting idle.
    // 'awaitingPath' is valid: pathfinding completes on the next tick.
    const artAfter = findUnit(ctx.world, artId)!;
    expect(['moving', 'awaitingPath']).toContain(artAfter.state);
    // Its destination should be farther from the enemy than its current pos.
    const destDist = Math.hypot(enemy.x - artAfter.destX, enemy.z - artAfter.destZ);
    const currDist = Math.hypot(enemy.x - artAfter.x, enemy.z - artAfter.z);
    expect(destDist).toBeGreaterThan(currDist);
  });

  it('mobile AA only damages air (canTarget), fighter hits both', () => {
    const ctx = setup();
    // Fighter requires Connectivity (age is per-world).
    advanceToConnectivity(ctx, 0);
    const a = findLandNear(ctx.terrain, 0, 0);
    spawnAt(ctx, a.x, a.z, 'aa', 0);
    const ground = spawnAt(ctx, a.x + 10, a.z, 'rifles', 1);
    const air = spawnAt(ctx, a.x + 10, a.z + 5, 'fighter', 1);
    expect(canTarget(UNIT_DEFS.aa, findUnit(ctx.world, ground)!)).toBe(false);
    expect(canTarget(UNIT_DEFS.aa, findUnit(ctx.world, air)!)).toBe(true);
    expect(canTarget(UNIT_DEFS.fighter, findUnit(ctx.world, ground)!)).toBe(true);
    expect(canTarget(UNIT_DEFS.fighter, findUnit(ctx.world, air)!)).toBe(true);
  });

  it('HQ aura boosts nearby friendly damage', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const hq = spawnAt(ctx, a.x, a.z, 'hq', 0);
    const tankNear = spawnAt(ctx, a.x + 5, a.z, 'tank', 0);
    const tankFar = spawnAt(ctx, a.x + HQ_AURA_RADIUS + 15, a.z, 'tank', 0);
    const dummy = spawnAt(ctx, a.x + 5, a.z + 10, 'tank', 1);
    const uNear = findUnit(ctx.world, tankNear)!;
    const uFar = findUnit(ctx.world, tankFar)!;
    const tDummy = findUnit(ctx.world, dummy)!;
    const def = UNIT_DEFS.tank;
    // uNear is inside the HQ aura; uFar is outside it.
    expect(damageMultiplier(ctx.world, uNear, def, tDummy)).toBeGreaterThan(
      damageMultiplier(ctx.world, uFar, def, tDummy),
    );
    expect(hq).toBeGreaterThan(0);
  });

  it('dead units are removed and targeting references cleared', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    // Far attacker orders an explicit attack (targetId set, chasing).
    const artFar = spawnAt(ctx, a.x, a.z, 'artillery', 0);
    const b = findLandNear(ctx.terrain, 100, 0);
    const target = spawnAt(ctx, b.x, b.z, 'engineer', 1);
    enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: artFar, targetId: target, owner: 0 } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, artFar)!.targetId).toBe(target);
    expect(findUnit(ctx.world, artFar)!.chasing).toBe(true);
    // A second artillery spawns within weapon range (48) of the target and
    // kills it opportunistically during its spawn tick (95 vs 80hp).
    const c = findLandNear(ctx.terrain, b.x + 30, b.z);
    spawnAt(ctx, c.x, c.z, 'artillery', 0);
    // Target dead and removed; far attacker's refs cleared.
    expect(findUnit(ctx.world, target)).toBeUndefined();
    const attacker = findUnit(ctx.world, artFar)!;
    expect(attacker.targetId).toBe(0);
    expect(attacker.chasing).toBe(false);
  });

  it('combat is deterministic: same seed, same ticks, same digest', () => {
    const run = (seed: number): number => {
      const ctx = setup(seed);
      const a = findLandNear(ctx.terrain, 0, 0);
      const b = findLandNear(ctx.terrain, 50, 10);
      const t1 = spawnAt(ctx, a.x, a.z, 'tank', 0);
      const t2 = spawnAt(ctx, a.x + 8, a.z + 2, 'rifles', 0);
      const e1 = spawnAt(ctx, b.x, b.z, 'tank', 1);
      const e2 = spawnAt(ctx, b.x - 6, b.z, 'aa', 1);
      enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: t1, targetId: e1, owner: 0 } }]);
      enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: t2, targetId: e2, owner: 0 } }]);
      runTicks(ctx, 120);
      return digestWorld(ctx.world);
    };
    expect(run(777)).toBe(run(777));
  });

  it('snapshot round-trips combat state (hp, cooldown, targetId, chasing)', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const b = findLandNear(ctx.terrain, 60, 0);
    const t1 = spawnAt(ctx, a.x, a.z, 'tank', 0);
    const e1 = spawnAt(ctx, b.x, b.z, 'tank', 1);
    enqueue(ctx, [{ kind: 'attackUnit', payload: { unitId: t1, targetId: e1, owner: 0 } }]);
    runTicks(ctx, 30);
    const snap = takeSnapshot(ctx.world);
    const d1 = digestWorld(ctx.world);
    const world2 = restoreSnapshot(snap);
    expect(digestWorld(world2)).toBe(d1);
    // And it keeps simulating identically afterwards.
    runTicks(ctx, 30);
    const d2 = digestWorld(ctx.world);
    const ctx2q = createCommandQueue();
    const driver2 = createTickDriver({
      queue: ctx2q,
      systems: [
        createPathfindingSystem(ctx.terrain),
        createMovementSystem(ctx.terrain),
        createCombatSystem(),
      ],
    });
    for (let i = 0; i < 30; i++) driver2.step(world2, TICK_MS);
    expect(digestWorld(world2)).toBe(d2);
  });
});

describe('air movement', () => {
  it('air units fly straight, ignoring water', () => {
    const ctx = setup();
    // Find water to fly over.
    let wx = 0, wz = 0, found = false;
    for (let r = 10; r < 120 && !found; r += 4) {
      for (let dz = -r; dz <= r && !found; dz += 4) {
        for (let dx = -r; dx <= r && !found; dx += 4) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (isWater(ctx.terrain, dx, dz)) { wx = dx; wz = dz; found = true; }
        }
      }
    }
    expect(found).toBe(true);
    const f = spawnAt(ctx, wx - 30, wz, 'drone', 0);
    const u0 = findUnit(ctx.world, f)!;
    const x0 = u0.x;
    enqueue(ctx, [{ kind: 'moveUnit', payload: { unitId: f, owner: 0, x: wx + 30, z: wz } }]);
    runTicks(ctx, 60);
    const u = findUnit(ctx.world, f)!;
    // Moved substantially toward the destination (straight line over water).
    expect(u.x).toBeGreaterThan(x0 + 20);
  });

  it('moveGroup handles mixed land/air groups', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    const b = findLandNear(ctx.terrain, 80, 0);
    const tank = spawnAt(ctx, a.x, a.z, 'tank', 0);
    const fighter = spawnAt(ctx, a.x + 3, a.z, 'drone', 0);
    // Command accepted without rejection; air flies direct, ground paths.
    enqueue(ctx, [{ kind: 'moveGroup', payload: { unitIds: [tank, fighter], owner: 0, x: b.x, z: b.z } }]);
    runTicks(ctx, 1);
    // Drone always flies direct and should be moving.
    expect(findUnit(ctx.world, fighter)!.state).toBe('moving');
    // Tank got a ground order (moving if reachable, failed if the
    // destination is on another landmass — both are valid processing).
    const tankState = findUnit(ctx.world, tank)!.state;
    expect(['moving', 'failed']).toContain(tankState);
  });

  it('a unit killed early in the tick does not fire later in the same tick', () => {
    const ctx = setup();
    const a = findLandNear(ctx.terrain, 0, 0);
    // u1 (low id, acts first) has a target at 1 HP; u2 (high id) would
    // fire back if it got a turn after being killed.
    const t1 = spawnAt(ctx, a.x, a.z, 'tank', 0);
    const t2 = spawnAt(ctx, a.x + 10, a.z, 'tank', 1);
    const u1 = findUnit(ctx.world, t1)!;
    const u2 = findUnit(ctx.world, t2)!;
    // u2 dies to one tank shot. Reset cooldowns so the test doesn't depend
    // on spawn-tick opportunistic fire; record u1's HP (it may have taken
    // a hit during t2's spawn tick).
    u2.hp = 1;
    u1.cooldownLeft = 0;
    u2.cooldownLeft = 0;
    const hpBefore = u1.hp;
    runTicks(ctx, 1);
    // u2 is dead.
    expect(findUnit(ctx.world, t2)).toBeUndefined();
    // u1's HP is unchanged: u2 never got a post-death shot. The combat
    // loop's `if (u.hp <= 0) continue` skips killed units before they act.
    expect(findUnit(ctx.world, t1)!.hp).toBe(hpBefore);
  });
});
