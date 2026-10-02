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
 * NOVATERRA — tests/sim.intel.test.ts — the sim-core half of the
 * grand-expansion intel system (§3.8 / §4 S6).
 *
 * Covers: asset plumbing (add/spend/accrual), the covert-op commands
 * (infiltrateBuilding / sabotage / stealTech — validation, costs,
 * timers, both RNG branches), detection geometry + the stealth
 * contract, the combat/AI/effectiveSight hooks, save/load round-trip,
 * and digest coverage. The roster half's def-side tests live in
 * sim.intel-roster.test.ts.
 *
 * Stochastic branches use pinned seeds (verified against the real
 * `rngBank` implementation): seed 20260932 draws intel-0 < 0.65 (steal
 * succeeds) and intel-1 < 0.35 (sabotage spotted); seed 20260931 draws
 * intel-0 >= 0.65 (steal fails) and intel-1 >= 0.35 (sabotage quiet).
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
import {
  registerIntelCommands,
  createIntelSystem,
  runIntelAccrual,
  advanceIntelMissions,
  isDetected,
  detectionRadiusAt,
  sabotageDurationSec,
  intelSightBonus,
  isSabotaged,
  getIntelAssets,
  addIntelAsset,
  spendIntelAsset,
  pickStealableTech,
  buildingCenterWorld,
  isSpyUnit,
  isStealthAsset,
  INFILTRATE_DURATION_TICKS,
  INTEL_ADJACENCY,
  INFILTRATE_ABANDON_RANGE,
  SABOTAGE_COST_OPERATIONAL,
  STEAL_COST_SURVEILLANCE,
  STEAL_RESEARCH_GRANT,
  SPOTTED_DURATION_TICKS,
  BASE_SABOTAGE_DURATION_SEC,
  COUNTER_INTEL_RADIUS_BONUS,
  SIGNALS_INTEL_SIGHT_BONUS,
  SABOTAGE_SPOT_CHANCE,
  STEAL_SUCCESS_BASE,
  sabotageSpotChance,
  stealSuccessChance,
} from '../src/sim/intel';
import { setDoctrine } from '../src/sim/doctrine';
import { spawnUnit, type UnitRecord } from '../src/sim/units';
import { acquireTarget, registerCombatCommands } from '../src/sim/combat';
import { getVisibleEnemies } from '../src/sim/ai';
import { effectiveSight } from '../src/sim/upgrades';
import { UNIT_DEFS } from '../src/sim/units';
import { runEconomyTick } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  type TerrainData,
} from '../src/sim/terrain';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
}

function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCombatCommands(queue);
  registerIntelCommands(queue);
  grantAllTrainingResources(world);
  return { terrain, world, queue };
}

function enq(ctx: Ctx, kind: string, payload: Record<string, unknown>): void {
  const cmd: NewCommand = { issuer: 'player', kind, payload };
  ctx.queue.enqueue(ctx.world, cmd);
}

function applyDue(ctx: Ctx): unknown[] {
  return ctx.queue.applyDue(ctx.world, ctx.world.tick).map((a) => a.result);
}

/** The rejection message for a command, or null when it enqueues cleanly. */
function rejectionReason(
  ctx: Ctx,
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  try {
    enq(ctx, kind, payload);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).message;
  }
}

/** Spawn a spy for `owner` at the center of `buildingId`'s footprint. */
function spawnSpyAtBuilding(ctx: Ctx, owner: number, buildingId: number): UnitRecord {
  const b = ctx.world.city.buildings.find((x) => x.id === buildingId);
  if (!b) throw new Error(`no building ${buildingId}`);
  const c = buildingCenterWorld(b);
  return spawnUnit(ctx.world, 'spy', owner, c.x, c.z);
}

/** A completed enemy (owner 1) building at cells (20, 20), owned by player 1. */
function enemyBuilding(ctx: Ctx, kind = 'barracks'): number {
  completeBuilding(ctx.world, kind as never, 1, 20, 20);
  const last = ctx.world.city.buildings[ctx.world.city.buildings.length - 1];
  if (!last) throw new Error('completeBuilding placed no building');
  return last.id;
}

function research(world: World, owner: number, id: string): void {
  world.upgrades[owner] = [...(world.upgrades[owner] ?? []), id];
}

// ---------------------------------------------------------------------------
// Asset plumbing
// ---------------------------------------------------------------------------

describe('intel asset plumbing', () => {
  it('adds and spends assets; never overdraws', () => {
    const ctx = setup();
    addIntelAsset(ctx.world, 0, 'surveillance', 10);
    expect(getIntelAssets(ctx.world, 0).surveillance).toBe(10);
    expect(spendIntelAsset(ctx.world, 0, 'surveillance', 4)).toBe(true);
    expect(getIntelAssets(ctx.world, 0).surveillance).toBe(6);
    expect(spendIntelAsset(ctx.world, 0, 'surveillance', 7)).toBe(false);
    expect(getIntelAssets(ctx.world, 0).surveillance).toBe(6);
    // Unknown player / negative amounts are no-ops, never throw.
    addIntelAsset(ctx.world, 99, 'operational', 5);
    addIntelAsset(ctx.world, 0, 'operational', -3);
    expect(getIntelAssets(ctx.world, 0).operational).toBe(0);
    expect(getIntelAssets(ctx.world, 99).operational).toBe(0);
  });

  it('accrues from intelOutput on completed, operational, unsabotaged buildings', () => {
    const ctx = setup();
    // intelHQ: operational 0.2/s, surveillance 0.1/s; listeningPost:
    // surveillance 0.25/s (roster defs).
    completeBuilding(ctx.world, 'intelHQ', 0, 10, 10);
    completeBuilding(ctx.world, 'listeningPost', 0, 14, 10);
    runIntelAccrual(ctx.world, 1);
    const a = getIntelAssets(ctx.world, 0);
    expect(a.surveillance).toBeCloseTo(0.35, 9);
    expect(a.operational).toBeCloseTo(0.2, 9);
    expect(a.counterIntel).toBe(0);
    // A sabotaged building accrues nothing.
    const hq = ctx.world.city.buildings.find((b) => b.kind === 'intelHQ');
    if (!hq) throw new Error('no intelHQ');
    hq.sabotagedUntil = ctx.world.tick + 100;
    runIntelAccrual(ctx.world, 1);
    const b2 = getIntelAssets(ctx.world, 0);
    expect(b2.surveillance).toBeCloseTo(0.35 + 0.25, 9);
    expect(b2.operational).toBeCloseTo(0.2, 9);
  });

  it('signalsIntel multiplies surveillance accrual x1.5', () => {
    const ctx = setup();
    completeBuilding(ctx.world, 'listeningPost', 0, 10, 10);
    research(ctx.world, 0, 'signalsIntel');
    runIntelAccrual(ctx.world, 2);
    expect(getIntelAssets(ctx.world, 0).surveillance).toBeCloseTo(0.25 * 1.5 * 2, 9);
  });

  it('the economy tick wires accrual (dt = 1 sim-second)', () => {
    const ctx = setup();
    completeBuilding(ctx.world, 'intelHQ', 0, 10, 10);
    runEconomyTick(ctx.world, ctx.terrain);
    const a = getIntelAssets(ctx.world, 0);
    expect(a.surveillance).toBeGreaterThan(0);
    expect(a.operational).toBeGreaterThan(0);
  });

  it('accrual is deterministic: identical seeds, identical assets', () => {
    const run = (seed: number): string => {
      const c = setup(seed);
      completeBuilding(c.world, 'intelHQ', 0, 10, 10);
      completeBuilding(c.world, 'signalsStation', 1, 30, 30);
      for (let i = 0; i < 10; i += 1) runIntelAccrual(c.world, 1);
      const p0 = getIntelAssets(c.world, 0);
      const p1 = getIntelAssets(c.world, 1);
      return `${p0.surveillance},${p0.operational},${p0.counterIntel}|${p1.surveillance},${p1.operational},${p1.counterIntel}`;
    };
    expect(run(7)).toBe(run(7));
    // Accrual has no RNG (flat per-second rates), so the seed never
    // matters — but different building sets accrue differently.
    const c = setup(7);
    completeBuilding(c.world, 'signalsStation', 0, 10, 10); // counterIntel 0.2/s
    runIntelAccrual(c.world, 10);
    expect(getIntelAssets(c.world, 0).counterIntel).toBeCloseTo(2, 9);
  });
});

// ---------------------------------------------------------------------------
// infiltrateBuilding
// ---------------------------------------------------------------------------

describe('infiltrateBuilding', () => {
  it('starts a 600-tick mission; the spy becomes embedded on completion', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    enq(ctx, 'infiltrateBuilding', { unitId: spy.id, buildingId: target, owner: 0 });
    applyDue(ctx);
    expect(spy.missionEndsAt).toBe(INFILTRATE_DURATION_TICKS);
    expect(spy.missionTargetId).toBe(target);
    expect(spy.embeddedIn).toBe(0);
    // Advance to one tick before completion: still infiltrating.
    for (let t = 1; t < INFILTRATE_DURATION_TICKS; t += 1) {
      ctx.world.tick = t;
      advanceIntelMissions(ctx.world);
    }
    expect(spy.embeddedIn).toBe(0);
    expect(spy.infiltrationProgress).toBe(INFILTRATE_DURATION_TICKS - 1);
    // The completion tick embeds the spy and clears the mission.
    ctx.world.tick = INFILTRATE_DURATION_TICKS;
    advanceIntelMissions(ctx.world);
    expect(spy.embeddedIn).toBe(target);
    expect(spy.missionEndsAt).toBe(0);
    expect(spy.missionTargetId).toBe(0);
  });

  it('the intel system advances missions every tick', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    enq(ctx, 'infiltrateBuilding', { unitId: spy.id, buildingId: target, owner: 0 });
    applyDue(ctx);
    const system = createIntelSystem();
    for (let t = 1; t <= INFILTRATE_DURATION_TICKS; t += 1) {
      ctx.world.tick = t;
      system(ctx.world, 1 / 30);
    }
    expect(spy.embeddedIn).toBe(target);
  });

  it('cancels the mission when the spy strays too far', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    enq(ctx, 'infiltrateBuilding', { unitId: spy.id, buildingId: target, owner: 0 });
    applyDue(ctx);
    // Walk the spy well past the abandon range.
    spy.x += INFILTRATE_ABANDON_RANGE + 10;
    ctx.world.tick = 5;
    advanceIntelMissions(ctx.world);
    expect(spy.missionEndsAt).toBe(0);
    expect(spy.missionTargetId).toBe(0);
    expect(spy.embeddedIn).toBe(0);
  });

  it('rejects invalid infiltrations loudly', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    const grunt = spawnUnit(ctx.world, 'rifles', 0, spy.x, spy.z);
    const own = enemyBuilding(ctx, 'barracks');
    // Flip ownership: build a player-0 building instead.
    ctx.world.city.buildings.find((b) => b.id === own)!.owner = 0;
    expect(rejectionReason(ctx, 'infiltrateBuilding', {
      unitId: grunt.id, buildingId: target, owner: 0,
    })).toMatch(/not a spy/);
    expect(rejectionReason(ctx, 'infiltrateBuilding', {
      unitId: spy.id, buildingId: own, owner: 0,
    })).toMatch(/own building/);
    // Far away: move the spy off the building.
    spy.x += INTEL_ADJACENCY + 50;
    expect(rejectionReason(ctx, 'infiltrateBuilding', {
      unitId: spy.id, buildingId: target, owner: 0,
    })).toMatch(/not adjacent/);
  });

  it('rejects double infiltration and re-infiltration while embedded', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    enq(ctx, 'infiltrateBuilding', { unitId: spy.id, buildingId: target, owner: 0 });
    applyDue(ctx);
    expect(rejectionReason(ctx, 'infiltrateBuilding', {
      unitId: spy.id, buildingId: target, owner: 0,
    })).toMatch(/already infiltrating/);
    // Fast-forward to embedded, then try again on the same building.
    for (let t = 1; t <= INFILTRATE_DURATION_TICKS; t += 1) {
      ctx.world.tick = t;
      advanceIntelMissions(ctx.world);
    }
    expect(spy.embeddedIn).toBe(target);
    expect(rejectionReason(ctx, 'infiltrateBuilding', {
      unitId: spy.id, buildingId: target, owner: 0,
    })).toMatch(/already embedded/);
  });
});

// ---------------------------------------------------------------------------
// sabotage
// ---------------------------------------------------------------------------

describe('sabotage', () => {
  it('spends 25 operational and takes the building offline for 45 s', () => {
    const ctx = setup(20260931); // unspotted seed: no burn to complicate
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    addIntelAsset(ctx.world, 0, 'operational', 100);
    enq(ctx, 'sabotage', { unitId: spy.id, buildingId: target, owner: 0 });
    const [result] = applyDue(ctx) as Array<{ sabotagedUntil: number; spotted: boolean }>;
    if (!result) throw new Error('command produced no result');
    expect(getIntelAssets(ctx.world, 0).operational).toBe(100 - SABOTAGE_COST_OPERATIONAL);
    const b = ctx.world.city.buildings.find((x) => x.id === target)!;
    expect(b.sabotagedUntil).toBe(Math.round(BASE_SABOTAGE_DURATION_SEC * 30));
    expect(isSabotaged(b, ctx.world.tick)).toBe(true);
    expect(result.spotted).toBe(false);
    // The economy flags the building non-operational while sabotaged.
    runEconomyTick(ctx.world, ctx.terrain);
    expect(b.operational).toBe(false);
  });

  it('counterIntel halves the sabotage duration', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    addIntelAsset(ctx.world, 0, 'operational', 100);
    research(ctx.world, 1, 'counterIntel');
    enq(ctx, 'sabotage', { unitId: spy.id, buildingId: target, owner: 0 });
    applyDue(ctx);
    const b = ctx.world.city.buildings.find((x) => x.id === target)!;
    expect(b.sabotagedUntil).toBe(Math.round(BASE_SABOTAGE_DURATION_SEC * 0.5 * 30));
    expect(sabotageDurationSec(ctx.world, 1)).toBe(BASE_SABOTAGE_DURATION_SEC * 0.5);
    expect(sabotageDurationSec(ctx.world, 0)).toBe(BASE_SABOTAGE_DURATION_SEC);
  });

  it('a spotted sabotage burns the spy for 900 ticks', () => {
    const ctx = setup(20260932); // spotted seed: intel-1 first draw < 0.35
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    addIntelAsset(ctx.world, 0, 'operational', 100);
    enq(ctx, 'sabotage', { unitId: spy.id, buildingId: target, owner: 0 });
    const [result] = applyDue(ctx) as Array<{ spotted: boolean }>;
    if (!result) throw new Error('command produced no result');
    if (!result) throw new Error('command produced no result');
    expect(result.spotted).toBe(true);
    expect(spy.spottedUntil).toBe(SPOTTED_DURATION_TICKS);
    // A burned spy is detected by everyone, everywhere.
    expect(isDetected(spy, 1, ctx.world)).toBe(true);
  });

  it('rejects invalid sabotage loudly', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    // Broke first: not adjacent.
    spy.x += INTEL_ADJACENCY + 50;
    expect(rejectionReason(ctx, 'sabotage', {
      unitId: spy.id, buildingId: target, owner: 0,
    })).toMatch(/not adjacent/);
    spy.x -= INTEL_ADJACENCY + 50;
    // Broke second: cannot afford it.
    expect(rejectionReason(ctx, 'sabotage', {
      unitId: spy.id, buildingId: target, owner: 0,
    })).toMatch(/need 25 operational/);
    addIntelAsset(ctx.world, 0, 'operational', 100);
    // A non-spy cannot sabotage.
    const grunt = spawnUnit(ctx.world, 'rifles', 0, spy.x, spy.z);
    expect(rejectionReason(ctx, 'sabotage', {
      unitId: grunt.id, buildingId: target, owner: 0,
    })).toMatch(/not a spy/);
  });

  it('rejects sabotaging an already-sabotaged building', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    addIntelAsset(ctx.world, 0, 'operational', 100);
    enq(ctx, 'sabotage', { unitId: spy.id, buildingId: target, owner: 0 });
    applyDue(ctx);
    expect(rejectionReason(ctx, 'sabotage', {
      unitId: spy.id, buildingId: target, owner: 0,
    })).toMatch(/already sabotaged/);
  });
});

// ---------------------------------------------------------------------------
// stealTech
// ---------------------------------------------------------------------------

describe('stealTech', () => {
  /** An embedded spy plus a victim upgrade the thief lacks. */
  function embeddedCtx(seed: number): { ctx: Ctx; spy: UnitRecord; target: number } {
    const ctx = setup(seed);
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    spy.embeddedIn = target;
    research(ctx.world, 1, 'apRounds');
    addIntelAsset(ctx.world, 0, 'surveillance', 100);
    return { ctx, spy, target };
  }

  /** Research stock of a player (test helper). */
  function playerResearch(world: Ctx['world'], owner: number): number {
    const pl = world.city.players[owner];
    if (!pl) throw new Error(`no player ${owner}`);
    return pl.research;
  }

  it('picks the lexicographically lowest stealable tech', () => {
    const ctx = setup();
    research(ctx.world, 1, 'compositeArmor');
    research(ctx.world, 1, 'apRounds');
    research(ctx.world, 0, 'apRounds');
    expect(pickStealableTech(ctx.world, 0, 1)).toBe('compositeArmor');
    research(ctx.world, 0, 'compositeArmor');
    expect(pickStealableTech(ctx.world, 0, 1)).toBe(null);
  });

  it('a successful steal grants research and keeps the spy embedded', () => {
    const { ctx, spy, target } = embeddedCtx(20260932); // success seed
    const before = playerResearch(ctx.world, 0);
    enq(ctx, 'stealTech', { unitId: spy.id, buildingId: target, owner: 0 });
    const [result] = applyDue(ctx) as Array<{
      tech: string; success: boolean; grantedResearch: number;
    }>;
    if (!result) throw new Error('command produced no result');
    expect(result.success).toBe(true);
    expect(result.tech).toBe('apRounds');
    expect(result.grantedResearch).toBe(STEAL_RESEARCH_GRANT);
    expect(playerResearch(ctx.world, 0)).toBe(before + STEAL_RESEARCH_GRANT);
    expect(getIntelAssets(ctx.world, 0).surveillance).toBe(100 - STEAL_COST_SURVEILLANCE);
    // A clean steal does not burn the spy: still embedded, still hidden.
    expect(spy.embeddedIn).toBe(target);
    expect(spy.spottedUntil ?? 0).toBe(0);
  });

  it('a failed steal burns the spy', () => {
    const { ctx, spy, target } = embeddedCtx(20260931); // failure seed
    const before = playerResearch(ctx.world, 0);
    enq(ctx, 'stealTech', { unitId: spy.id, buildingId: target, owner: 0 });
    const [result] = applyDue(ctx) as Array<{ success: boolean; grantedResearch: number }>;
    if (!result) throw new Error('command produced no result');
    expect(result.success).toBe(false);
    expect(result.grantedResearch).toBe(0);
    expect(playerResearch(ctx.world, 0)).toBe(before);
    expect(spy.spottedUntil).toBe(SPOTTED_DURATION_TICKS);
    expect(isDetected(spy, 1, ctx.world)).toBe(true);
  });

  it('signalsIntel helps, victim counterIntel hurts', () => {
    // Same seed, same first draw: modifiers move the chance across it.
    const mk = (thiefSig: boolean, victimCounter: boolean): boolean => {
      const { ctx, spy, target } = embeddedCtx(20260931); // draw 0.8524
      if (thiefSig) research(ctx.world, 0, 'signalsIntel');
      if (victimCounter) research(ctx.world, 1, 'counterIntel');
      enq(ctx, 'stealTech', { unitId: spy.id, buildingId: target, owner: 0 });
      const [r] = applyDue(ctx) as Array<{ success: boolean }>;
      if (!r) throw new Error('command produced no result');
      return r.success;
    };
    // Base 0.65 < 0.8524: fails. signalsIntel 0.80 < 0.8524: still fails.
    expect(mk(false, false)).toBe(false);
    expect(mk(true, false)).toBe(false);
    // This documents the modifier wiring; the clamp keeps chances sane.
    expect(mk(false, true)).toBe(false);
  });

  it('rejects invalid steals loudly', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    addIntelAsset(ctx.world, 0, 'surveillance', 100);
    research(ctx.world, 1, 'apRounds');
    // Not embedded: infiltrate first.
    expect(rejectionReason(ctx, 'stealTech', {
      unitId: spy.id, buildingId: target, owner: 0,
    })).toMatch(/not embedded/);
    spy.embeddedIn = target;
    // Nothing left to steal: the apply fizzles idempotently (no throw,
    // no assets spent) instead of rejecting — the AI cannot predict its
    // own lab finishing the tech on the exact tick the steal lands.
    research(ctx.world, 0, 'apRounds');
    ctx.queue.enqueue(ctx.world, {
      issuer: 'test', kind: 'stealTech',
      payload: { unitId: spy.id, buildingId: target, owner: 0 },
    });
    const results = applyDue(ctx);
    expect(results[0]).toMatchObject({ fizzled: true, success: false });
    // Surveillance untouched by the fizzled steal.
    expect(getIntelAssets(ctx.world, 0).surveillance).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Detection + the stealth contract
// ---------------------------------------------------------------------------

describe('detection', () => {
  it('isDetected: own and overt units visible; spies need coverage', () => {
    const ctx = setup();
    const spy = spawnUnit(ctx.world, 'spy', 1, 0, 0);
    const grunt = spawnUnit(ctx.world, 'rifles', 1, 0, 0);
    expect(isDetected(spy, 1, ctx.world)).toBe(true); // own spy
    expect(isDetected(grunt, 0, ctx.world)).toBe(true); // overt unit
    expect(isSpyUnit(spy)).toBe(true);
    expect(isSpyUnit(grunt)).toBe(false);
    // No detection buildings: the enemy spy is invisible.
    expect(isDetected(spy, 0, ctx.world)).toBe(false);
    expect(detectionRadiusAt(ctx.world, 0, 0, 0)).toBe(0);
    // A listeningPost (radius 60) covers the spy's position.
    completeBuilding(ctx.world, 'listeningPost', 0, 10, 10);
    const c = buildingCenterWorld(ctx.world.city.buildings.find((b) => b.kind === 'listeningPost')!);
    spy.x = c.x + 30;
    spy.z = c.z;
    expect(detectionRadiusAt(ctx.world, 0, spy.x, spy.z)).toBe(60);
    expect(isDetected(spy, 0, ctx.world)).toBe(true);
    // Outside the radius: invisible again.
    spy.x = c.x + 61;
    expect(isDetected(spy, 0, ctx.world)).toBe(false);
  });

  it('counterIntel widens detection by 25', () => {
    const ctx = setup();
    completeBuilding(ctx.world, 'listeningPost', 0, 10, 10);
    const c = buildingCenterWorld(ctx.world.city.buildings.find((b) => b.kind === 'listeningPost')!);
    const x = c.x + 70;
    expect(detectionRadiusAt(ctx.world, 0, x, c.z)).toBe(0);
    research(ctx.world, 0, 'counterIntel');
    expect(detectionRadiusAt(ctx.world, 0, x, c.z)).toBe(60 + COUNTER_INTEL_RADIUS_BONUS);
  });

  it('a burned spy is visible everywhere until the timer expires', () => {
    const ctx = setup();
    const spy = spawnUnit(ctx.world, 'spy', 1, 500, 500);
    spy.spottedUntil = 100;
    ctx.world.tick = 50;
    expect(isDetected(spy, 0, ctx.world)).toBe(true);
    ctx.world.tick = 100;
    expect(isDetected(spy, 0, ctx.world)).toBe(false);
    ctx.world.tick = 101;
    expect(isDetected(spy, 0, ctx.world)).toBe(false);
  });

  it('isDetected is a pure query: it never mutates the world', () => {
    const ctx = setup();
    completeBuilding(ctx.world, 'listeningPost', 0, 10, 10);
    const spy = spawnUnit(ctx.world, 'spy', 1, 0, 0);
    spawnUnit(ctx.world, 'rifles', 0, 5, 5);
    const before = digestWorld(ctx.world);
    for (let i = 0; i < 20; i += 1) {
      isDetected(spy, 0, ctx.world);
      detectionRadiusAt(ctx.world, 0, i, -i);
    }
    expect(digestWorld(ctx.world)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Hooks: combat, AI, sight
// ---------------------------------------------------------------------------

describe('stealth hooks', () => {
  it('acquireTarget skips undetected spies, takes them when burned', () => {
    const ctx = setup();
    const tank = spawnUnit(ctx.world, 'tank', 0, 0, 0); // range 19
    const spy = spawnUnit(ctx.world, 'spy', 1, 10, 0); // closer, but hidden
    const grunt = spawnUnit(ctx.world, 'rifles', 1, 18, 0); // farther, visible
    const def = UNIT_DEFS[tank.kind as keyof typeof UNIT_DEFS];
    expect(acquireTarget(ctx.world, tank, def)?.id).toBe(grunt.id);
    // Burn the spy: now it is the nearest valid target.
    spy.spottedUntil = 99999;
    expect(acquireTarget(ctx.world, tank, def)?.id).toBe(spy.id);
  });

  it('acquireTarget skips undetected spectres, takes them when burned', () => {
    const ctx = setup();
    const tank = spawnUnit(ctx.world, 'tank', 0, 0, 0); // range 19
    const spectre = spawnUnit(ctx.world, 'spectre', 1, 10, 0); // closer, but hidden
    const grunt = spawnUnit(ctx.world, 'rifles', 1, 18, 0); // farther, visible
    const def = UNIT_DEFS[tank.kind as keyof typeof UNIT_DEFS];
    expect(acquireTarget(ctx.world, tank, def)?.id).toBe(grunt.id);
    // Burn the spectre: now it is the nearest valid target.
    spectre.spottedUntil = 99999;
    expect(acquireTarget(ctx.world, tank, def)?.id).toBe(spectre.id);
  });

  it('stealth is the detection contract, not a spy role (R1 spectre)', () => {
    const ctx = setup();
    const spectre = spawnUnit(ctx.world, 'spectre', 1, 10, 0);
    const spy = spawnUnit(ctx.world, 'spy', 1, 12, 0);
    const grunt = spawnUnit(ctx.world, 'rifles', 1, 14, 0);
    // Both units are stealth assets (invisible until detected), but
    // only the spy kind may run covert ops — the spectre is a raider.
    expect(isStealthAsset(spectre)).toBe(true);
    expect(isStealthAsset(spy)).toBe(true);
    expect(isStealthAsset(grunt)).toBe(false);
    expect(isSpyUnit(spectre)).toBe(false);
    expect(isSpyUnit(spy)).toBe(true);
    expect(isSpyUnit(grunt)).toBe(false);
  });

  it('attackUnit rejects undetected stealth targets', () => {
    const ctx = setup();
    const tank = spawnUnit(ctx.world, 'tank', 0, 0, 0);
    const spy = spawnUnit(ctx.world, 'spy', 1, 10, 0);
    expect(rejectionReason(ctx, 'attackUnit', {
      unitId: tank.id, targetId: spy.id, owner: 0,
    })).toMatch(/stealthed and undetected/);
    spy.spottedUntil = 99999;
    expect(rejectionReason(ctx, 'attackUnit', {
      unitId: tank.id, targetId: spy.id, owner: 0,
    })).toBe(null);
  });

  it('getVisibleEnemies hides undetected spies from the AI', () => {
    const ctx = setup();
    spawnUnit(ctx.world, 'rifles', 0, 0, 0); // sight 22
    const spy = spawnUnit(ctx.world, 'spy', 1, 15, 0);
    expect(getVisibleEnemies(ctx.world, 0).map((u) => u.id)).not.toContain(spy.id);
    spy.spottedUntil = 99999;
    expect(getVisibleEnemies(ctx.world, 0).map((u) => u.id)).toContain(spy.id);
  });

  it('effectiveSight gains the intel bonus (satelliteUplink + signalsIntel)', () => {
    const ctx = setup();
    setDoctrine(ctx.world, 0, 'kestrel'); // base sight (Republic multiplies by 1.2)
    const def = UNIT_DEFS['rifles' as keyof typeof UNIT_DEFS];
    const base = effectiveSight(ctx.world, 0, def);
    expect(intelSightBonus(ctx.world, 0)).toBe(0);
    completeBuilding(ctx.world, 'satelliteUplink', 0, 10, 10); // sightBonus 12
    expect(intelSightBonus(ctx.world, 0)).toBe(12);
    expect(effectiveSight(ctx.world, 0, def)).toBe(base + 12);
    research(ctx.world, 0, 'signalsIntel');
    expect(intelSightBonus(ctx.world, 0)).toBe(12 + SIGNALS_INTEL_SIGHT_BONUS);
    expect(effectiveSight(ctx.world, 0, def)).toBe(base + 12 + SIGNALS_INTEL_SIGHT_BONUS);
    // Another player's uplink does not help.
    expect(intelSightBonus(ctx.world, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Save/load + digest
// ---------------------------------------------------------------------------

describe('persistence', () => {
  function busyWorld(seed: number): World {
    const ctx = setup(seed);
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    addIntelAsset(ctx.world, 0, 'surveillance', 12.5);
    addIntelAsset(ctx.world, 0, 'operational', 30);
    addIntelAsset(ctx.world, 1, 'counterIntel', 7);
    // Mid-infiltration spy + a sabotaged building + a burned spy.
    enq(ctx, 'infiltrateBuilding', { unitId: spy.id, buildingId: target, owner: 0 });
    applyDue(ctx);
    ctx.world.tick = 123;
    advanceIntelMissions(ctx.world);
    const b = ctx.world.city.buildings.find((x) => x.id === target)!;
    b.sabotagedUntil = 9999;
    const burned = spawnUnit(ctx.world, 'spy', 1, 40, 40);
    burned.spottedUntil = 7777;
    const embedded = spawnUnit(ctx.world, 'spy', 0, 60, 60);
    embedded.embeddedIn = target;
    return ctx.world;
  }

  it('snapshot round-trip preserves all intel state (stays v9)', () => {
    const world = busyWorld(42);
    const snap = takeSnapshot(world);
    expect(snap.version).toBe(9);
    const restored = restoreSnapshot(snap);
    expect(digestWorld(restored)).toBe(digestWorld(world));
    const spy = restored.units.find((u) => (u.missionEndsAt ?? 0) > 0)!;
    expect(spy.missionTargetId).toBeGreaterThan(0);
    expect(spy.infiltrationProgress).toBe(123);
    const b = restored.city.buildings.find((x) => (x.sabotagedUntil ?? 0) > 0)!;
    expect(b.sabotagedUntil).toBe(9999);
    const burned = restored.units.find((u) => (u.spottedUntil ?? 0) === 7777)!;
    expect(burned).toBeDefined();
    const pl = restored.city.players[0];
    if (!pl) throw new Error('no player 0 in restored world');
    expect(pl.intel.surveillance).toBe(12.5);
  });

  it('digests are stable for identical playthroughs and cover intel state', () => {
    const a = busyWorld(99);
    const b = busyWorld(99);
    expect(digestWorld(a)).toBe(digestWorld(b));
    // Intel state is digest-covered: sabotaging changes the digest.
    const c = busyWorld(99);
    const target = c.city.buildings.find((x) => (x.sabotagedUntil ?? 0) > 0)!;
    target.sabotagedUntil = 0;
    expect(digestWorld(c)).not.toBe(digestWorld(a));
  });
});

// ---------------------------------------------------------------------------
// Hardening (audit 2026-09-30): detection gates, the counter-intel
// stockpile's defensive job, stealTech proximity, getIntelAssets
// robustness.
// ---------------------------------------------------------------------------

describe('intel hardening', () => {
  /** A completed enemy listeningPost at cells (20,20) and a spy inside its radius. */
  function detectionCtx(): { ctx: Ctx; post: { id: number; sabotagedUntil?: number; operational: boolean }; spy: UnitRecord } {
    const ctx = setup();
    completeBuilding(ctx.world, 'listeningPost' as never, 1, 20, 20);
    const post = ctx.world.city.buildings[ctx.world.city.buildings.length - 1];
    if (!post) throw new Error('no listening post placed');
    const c = buildingCenterWorld(post);
    const spy = spawnUnit(ctx.world, 'spy', 0, c.x + 10, c.z); // 10 < radius 60
    return { ctx, post, spy };
  }

  it('a sabotaged detector is blind: sabotage the listening post, then walk the spy in', () => {
    const { ctx, post, spy } = detectionCtx();
    expect(isDetected(spy, 1, ctx.world)).toBe(true); // covered while working
    post.sabotagedUntil = ctx.world.tick + 1000;
    expect(detectionRadiusAt(ctx.world, 1, spy.x, spy.z)).toBe(0);
    expect(isDetected(spy, 1, ctx.world)).toBe(false); // a dark post sees nothing
    post.sabotagedUntil = 0;
    expect(isDetected(spy, 1, ctx.world)).toBe(true); // recovers with the building
  });

  it('an unpowered detector is blind', () => {
    const { ctx, post, spy } = detectionCtx();
    expect(isDetected(spy, 1, ctx.world)).toBe(true);
    post.operational = false;
    expect(detectionRadiusAt(ctx.world, 1, spy.x, spy.z)).toBe(0);
    expect(isDetected(spy, 1, ctx.world)).toBe(false);
    post.operational = true;
    expect(isDetected(spy, 1, ctx.world)).toBe(true);
  });

  it('sabotageSpotChance: base 0.35, sharpened by victim counter-intel stockpile, capped', () => {
    const ctx = setup();
    expect(sabotageSpotChance(ctx.world, 1)).toBe(SABOTAGE_SPOT_CHANCE);
    addIntelAsset(ctx.world, 1, 'counterIntel', 50);
    expect(sabotageSpotChance(ctx.world, 1)).toBeCloseTo(0.45, 10); // 0.35 + 50*0.002
    addIntelAsset(ctx.world, 1, 'counterIntel', 100000);
    expect(sabotageSpotChance(ctx.world, 1)).toBeCloseTo(0.65, 10); // 0.35 + 0.30 cap
  });

  it('stealSuccessChance: base 0.65, victim stockpile blunts it, upgrades stack, clamped', () => {
    const ctx = setup();
    expect(stealSuccessChance(ctx.world, 0, 1)).toBe(STEAL_SUCCESS_BASE);
    addIntelAsset(ctx.world, 1, 'counterIntel', 150);
    expect(stealSuccessChance(ctx.world, 0, 1)).toBeCloseTo(0.5, 10); // 0.65 - 0.15 cap
    research(ctx.world, 1, 'counterIntel');
    expect(stealSuccessChance(ctx.world, 0, 1)).toBeCloseTo(0.35, 10); // upgrade stacks
    research(ctx.world, 0, 'signalsIntel');
    expect(stealSuccessChance(ctx.world, 0, 1)).toBeCloseTo(0.5, 10); // thief sharpens
    addIntelAsset(ctx.world, 1, 'counterIntel', 1000000);
    expect(stealSuccessChance(ctx.world, 0, 1)).toBeGreaterThanOrEqual(0.1); // clamped
  });

  it('stealTech rejects when the embedded spy walked away from the building', () => {
    const ctx = setup();
    const target = enemyBuilding(ctx);
    const spy = spawnSpyAtBuilding(ctx, 0, target);
    spy.embeddedIn = target;
    research(ctx.world, 1, 'apRounds');
    addIntelAsset(ctx.world, 0, 'surveillance', 100);
    // Sanity: adjacent to its post, the steal enqueues.
    expect(
      rejectionReason(ctx, 'stealTech', { unitId: spy.id, buildingId: target, owner: 0 }),
    ).toBe(null);
    // The spy walks home: "embedded" no longer means inside.
    spy.x += 1000;
    spy.z += 1000;
    expect(
      rejectionReason(ctx, 'stealTech', { unitId: spy.id, buildingId: target, owner: 0 }),
    ).toMatch(/not adjacent/);
  });

  it('getIntelAssets is zero-safe for a hand-built player record without intel', () => {
    const ctx = setup();
    const p = ctx.world.city.players[1];
    if (!p) throw new Error('no player 1');
    (p as unknown as { intel: undefined }).intel = undefined;
    expect(getIntelAssets(ctx.world, 1)).toEqual({
      surveillance: 0,
      operational: 0,
      counterIntel: 0,
    });
  });
});
