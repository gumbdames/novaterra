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
 * NOVATERRA — AI intel play tests (grand-expansion Phase 6).
 *
 * The Classic AI's virtual intel game: the parallel intel construction
 * queue (with the don't-starve gate), the virtual asset credit, spy
 * doctrine (train → move → infiltrate → steal/sabotage), the
 * counter-intel surge, virtual SIGINT detection anchored at the AI's
 * base, and snapshot/digest coverage of the new AI state.
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
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  MAP_HALF_SIZE,
  CELL_WORLD_SIZE,
  BUILDING_DEFS,
  getPlayer,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import { createEconomySystem } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { registerUnitCommands, spawnUnit } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import {
  addAIPlayer,
  createAISystem,
  intelTargetValue,
  getVisibleEnemyBuildings,
  INTEL_CONSTRUCTION_PRIORITY,
  INTEL_SPY_QUOTA,
  type AIDifficulty,
  type AIPlayerState,
} from '../src/sim/ai';
import {
  createIntelSystem,
  registerIntelCommands,
  isDetected,
  isSpyUnit,
  buildingSightCoverage,
  detectionRadiusAt,
  buildingCenterWorld,
  COUNTER_INTEL_RADIUS_BONUS,
} from '../src/sim/intel';
import { registerUpgradeCommands } from '../src/sim/upgrades';
import { digestWorld } from '../src/sim/digest';
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
  driver: TickDriver;
  base: { x: number; z: number };
  ai: AIPlayerState;
}

/**
 * Single marshal AI (owner 0) at the information age with full
 * resources — the intel game needs the information age (intelHQ,
 * signalsIntel) and the soak grants. The enemy (owner 1) owns
 * scripted physical buildings but no AI player.
 */
function setupIntelCtx(seed = 20260930, difficulty: AIDifficulty = 'marshal'): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  world.ages.age = 'information';
  const base = findLandNear(terrain, -100, 0);
  addAIPlayer(world, 0, difficulty, base.x, base.z);
  const ai = world.ai.players[0]!;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerIntelCommands(queue);
  registerUpgradeCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
      // Spy infiltration missions advance every tick (asset accrual
      // rides the economy tick) — the session system order.
      createIntelSystem(),
      createAISystem(queue),
    ],
  });
  return { terrain, world, queue, driver, base, ai };
}

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

/** Cell coordinate whose center is nearest to world (x, z). */
function worldToCell(x: number): number {
  return Math.round((x + MAP_HALF_SIZE) / CELL_WORLD_SIZE - 0.5);
}

/**
 * A completed enemy (owner 1) building near the AI's base — close
 * enough for a spy to walk to in a few game-seconds.
 */
function enemyBuildingNear(ctx: Ctx, kind: BuildingKind = 'barracks'): BuildingRecord {
  const cx = worldToCell(ctx.base.x + 24);
  const cz = worldToCell(ctx.base.z);
  completeBuilding(ctx.world, kind, 1, cx, cz);
  const last = ctx.world.city.buildings[ctx.world.city.buildings.length - 1];
  if (!last) throw new Error('completeBuilding placed no building');
  return last;
}

/** Pre-complete the AI's virtual production base (fixture shortcut). */
function completeProductionBase(ai: AIPlayerState): void {
  // The marshal's full non-coastal production priority (barracks,
  // warFactory, lab, airfield, radarStation, civilAirport) — so the
  // production queue is idle and the intel tests exercise only the
  // intel queue. (Shipyard/navalYard need a coast; the fixture is
  // landlocked, so the naval probe skips them.)
  ai.virtualBuildings.completed.push(
    'barracks',
    'warFactory',
    'lab',
    'airfield',
    'radarStation',
    'civilAirport',
  );
}

/** Run the driver for `ticks` ticks. */
function run(ctx: Ctx, ticks: number): void {
  for (let i = 0; i < ticks; i++) ctx.driver.step(ctx.world, TICK_MS);
}

// ---------------------------------------------------------------------------
// Intel construction: priority, gates, pacing
// ---------------------------------------------------------------------------

describe('AI virtual intel construction', () => {
  it('marshal builds listeningPost → intelHQ → signalsStation in order', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    // 30 s (listeningPost) + a think margin.
    run(ctx, 1100);
    expect(ctx.ai.virtualBuildings.completed).toContain('listeningPost');
    // intelHQ (55 s) is now constructing or done.
    const intelHQ = ctx.ai.virtualBuildings.completed.includes('intelHQ');
    const constructingIntelHQ = ctx.ai.intel.constructing?.kind === 'intelHQ';
    expect(intelHQ || constructingIntelHQ).toBe(true);
  });

  it('does not start before the production base is complete (no starving)', () => {
    const ctx = setupIntelCtx();
    // Fresh AI: the production queue is still working on barracks.
    run(ctx, 600);
    expect(ctx.ai.intel.constructing).toBeNull();
    expect(ctx.ai.virtualBuildings.completed).not.toContain('listeningPost');
  });

  it('does not start when the funds buffer (2x cost) is not met', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 100; // listeningPost costs 500 (needs 1000).
    // The fixture drains funds mid-run; clear commands the AI enqueued
    // in earlier thinks (a stale spawn throws at apply by design). In
    // real operation this can't happen: the per-think spend ledger
    // guarantees the AI never enqueues a batch whose sum exceeds its
    // stockpile.
    ctx.queue.clear();
    run(ctx, 600);
    expect(ctx.ai.intel.constructing).toBeNull();
    // And starts as soon as the buffer is met (abundant funds: the
    // AI's other spenders — research, trucks — may commit first, but
    // the 2× buffer is measured against uncommitted funds).
    player.funds = 1000000;
    run(ctx, 120);
    expect(ctx.ai.intel.constructing?.kind).toBe('listeningPost');
  });

  it('cadet and citizen never build intel', () => {
    for (const difficulty of ['cadet', 'citizen'] as AIDifficulty[]) {
      const ctx = setupIntelCtx(20260930, difficulty);
      completeProductionBase(ctx.ai);
      run(ctx, 900);
      expect(
        ctx.ai.intel.constructing,
        `${difficulty} constructs intel`,
      ).toBeNull();
      expect(
        ctx.ai.virtualBuildings.completed.filter((k) =>
          (INTEL_CONSTRUCTION_PRIORITY[difficulty] as string[]).includes(k),
        ),
        `${difficulty} completed intel`,
      ).toEqual([]);
      expect(INTEL_SPY_QUOTA[difficulty]).toBe(0);
    }
  });

  it('commander/general build the three-site chain; marshal adds the uplink', () => {
    expect(INTEL_CONSTRUCTION_PRIORITY.commander).toEqual([
      'listeningPost',
      'intelHQ',
      'signalsStation',
    ]);
    expect(INTEL_CONSTRUCTION_PRIORITY.general).toEqual(
      INTEL_CONSTRUCTION_PRIORITY.commander,
    );
    expect(INTEL_CONSTRUCTION_PRIORITY.marshal).toEqual([
      'listeningPost',
      'intelHQ',
      'signalsStation',
      'satelliteUplink',
    ]);
    expect(INTEL_SPY_QUOTA).toEqual({
      cadet: 0,
      citizen: 0,
      commander: 1,
      general: 2,
      marshal: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Virtual asset credit
// ---------------------------------------------------------------------------

describe('virtual intel asset credit', () => {
  it('completed virtual intel buildings accrue assets into the AI stockpile', () => {
    const ctx = setupIntelCtx();
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    const before = getPlayer(ctx.world.city, 0)!.intel.surveillance;
    run(ctx, 31);
    const after = getPlayer(ctx.world.city, 0)!.intel.surveillance;
    expect(after).toBeGreaterThan(before);
    // The marshal thinks every 30 ticks and the credit fires on the
    // tick-0 think too: 31 ticks = 2 credits (tick 0 and tick 30).
    expect(after - before).toBeCloseTo(
      BUILDING_DEFS.listeningPost.intelOutput!.surveillance! * 2,
      9,
    );
  });

  it('signalsIntel multiplies the virtual surveillance accrual', () => {
    const ctx = setupIntelCtx();
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    ctx.world.upgrades[0] = ['signalsIntel'];
    run(ctx, 31);
    const after = getPlayer(ctx.world.city, 0)!.intel.surveillance;
    // 2 credits in 31 ticks (tick-0 think + tick-30 think), ×1.5.
    expect(after).toBeCloseTo(
      BUILDING_DEFS.listeningPost.intelOutput!.surveillance! * 1.5 * 2,
      9,
    );
  });

  it('no intel buildings: no accrual', () => {
    const ctx = setupIntelCtx();
    run(ctx, 61);
    const intel = getPlayer(ctx.world.city, 0)!.intel;
    expect(intel.surveillance).toBe(0);
    expect(intel.operational).toBe(0);
    expect(intel.counterIntel).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Spy doctrine: train, move, infiltrate
// ---------------------------------------------------------------------------

describe('AI spy doctrine', () => {
  it('marshal trains a spy once intelHQ is held (under the army cap)', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost', 'intelHQ');
    run(ctx, 120);
    const spies = ctx.world.units.filter(
      (u) => u.owner === 0 && u.hp > 0 && isSpyUnit(u),
    );
    expect(spies.length).toBeGreaterThanOrEqual(1);
  });

  it('no intelHQ: no spies, even with funds', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    run(ctx, 300);
    const spies = ctx.world.units.filter(
      (u) => u.owner === 0 && u.hp > 0 && isSpyUnit(u),
    );
    expect(spies).toEqual([]);
  });

  it('a free spy walks to the highest-value enemy building and infiltrates', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost', 'intelHQ');
    const target = enemyBuildingNear(ctx, 'barracks');
    // A low-value decoy farther out: the spy must prefer the barracks.
    const farCx = worldToCell(ctx.base.x - 60);
    const farCz = worldToCell(ctx.base.z - 60);
    completeBuilding(ctx.world, 'house', 1, farCx, farCz);
    run(ctx, 1500);
    expect(ctx.ai.intel.ops.infiltrate).toBeGreaterThan(0);
    const spies = ctx.world.units.filter(
      (u) => u.owner === 0 && u.hp > 0 && isSpyUnit(u),
    );
    expect(spies.length).toBeGreaterThan(0);
    // The spy embedded in the high-value target (infiltration takes
    // 20 s; the mission may still be running at the end of the window).
    // Final-review R2-B: the marshal AI now also runs siege doctrine —
    // if the siege destroys the barracks before infiltration completes,
    // that is correct behavior (the spy tried; the army got there first).
    const embedded = spies.some((s) => s.embeddedIn === target.id);
    const infiltrating = spies.some((s) => (s.missionEndsAt ?? 0) > 0);
    const targetDestroyed = !ctx.world.city.buildings.some(
      (b) => b.id === target.id && (b.hp ?? 0) > 0,
    );
    expect(embedded || infiltrating || targetDestroyed).toBe(true);
  });

  it('target values rank intel > airports > production > depots > plants', () => {
    expect(intelTargetValue('intelHQ')).toBe(100);
    expect(intelTargetValue('signalsStation')).toBe(100);
    expect(intelTargetValue('mixedAirport')).toBe(80);
    expect(intelTargetValue('civilAirport')).toBe(80);
    expect(intelTargetValue('barracks')).toBe(70);
    expect(intelTargetValue('missilePlant')).toBe(70);
    expect(intelTargetValue('ordnanceDepot')).toBe(65);
    expect(intelTargetValue('powerPlant')).toBe(60);
    expect(intelTargetValue('house')).toBe(10);
    // An undiscovered mixed airport values as an airport — the AI knows
    // the SITE is an airport; only its true nature is hidden.
    expect(intelTargetValue('mixedAirport')).toBe(
      intelTargetValue('civilAirport'),
    );
  });

  it('getVisibleEnemyBuildings sees positions (public) but not nature', () => {
    const ctx = setupIntelCtx();
    const mixed = enemyBuildingNear(ctx, 'mixedAirport');
    const seen = getVisibleEnemyBuildings(ctx.world, 0);
    expect(seen.map((b) => b.id)).toContain(mixed.id);
    // The AI learns the nature only via its own discovery records.
    expect(mixed.discovery).toBeUndefined();
  });
});
// ---------------------------------------------------------------------------
// Embedded spies: steal tech, sabotage
// ---------------------------------------------------------------------------

describe('AI embedded spies', () => {
  /** A marshal AI with an embedded spy in an enemy barracks (fixture). */
  function setupEmbedded(seed = 20260931): Ctx & {
    spy: ReturnType<typeof spawnUnit>;
    host: BuildingRecord;
  } {
    const ctx = setupIntelCtx(seed);
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost', 'intelHQ');
    const host = enemyBuildingNear(ctx, 'barracks');
    // The spy starts embedded AND adjacent (at the host's center) so
    // the steal/sabotage adjacency validation passes.
    const c = buildingCenterWorld(host);
    const spy = spawnUnit(ctx.world, 'spy', 0, c.x, c.z);
    spy.embeddedIn = host.id;
    return { ...ctx, spy, host };
  }

  it('steals tech when surveillance >= 15 and a stealable tech exists', () => {
    const { spy, host, ...ctx } = setupEmbedded();
    const player = getPlayer(ctx.world.city, 0)!;
    player.intel.surveillance = 30;
    // The victim knows apRounds; the thief does not.
    ctx.world.upgrades[1] = ['apRounds'];
    ctx.world.upgrades[0] = [];
    const researchBefore = player.research;
    run(ctx, 120);
    expect(ctx.ai.intel.ops.steal).toBeGreaterThan(0);
    // Surveillance was spent (15 per attempt, even on failure).
    expect(player.intel.surveillance).toBeLessThan(30);
    // Either the steal landed (research granted) or the spy was burned.
    const researchGained = player.research - researchBefore;
    const burned = (spy.spottedUntil ?? 0) > ctx.world.tick;
    expect(researchGained > 0 || burned).toBe(true);
    expect(host.owner).toBe(1); // the host is still the enemy's
  });

  it('does not steal when no tech is stealable (saves its assets)', () => {
    const { ...ctx } = setupEmbedded();
    const player = getPlayer(ctx.world.city, 0)!;
    player.intel.surveillance = 30;
    ctx.world.upgrades[1] = [];
    ctx.world.upgrades[0] = [];
    run(ctx, 120);
    expect(ctx.ai.intel.ops.steal).toBe(0);
    // Surveillance is untouched by the (non-)steal; the virtual
    // listeningPost accrual only adds, never spends surveillance.
    expect(player.intel.surveillance).toBeGreaterThanOrEqual(30);
  });

  it('sabotages a high-value host when operational >= 25', () => {
    const { host, ...ctx } = setupEmbedded();
    const player = getPlayer(ctx.world.city, 0)!;
    player.intel.surveillance = 0; // no stealable path
    player.intel.operational = 30;
    ctx.world.upgrades[1] = [];
    run(ctx, 120);
    expect(ctx.ai.intel.ops.sabotage).toBeGreaterThan(0);
    expect(host.sabotagedUntil ?? 0).toBeGreaterThan(ctx.world.tick);
    expect(player.intel.operational).toBeLessThan(30);
  });

  it('does not sabotage below the 25-operational cost', () => {
    const { host, ...ctx } = setupEmbedded();
    const player = getPlayer(ctx.world.city, 0)!;
    player.intel.surveillance = 0;
    player.intel.operational = 20;
    run(ctx, 120);
    expect(ctx.ai.intel.ops.sabotage).toBe(0);
    expect(host.sabotagedUntil ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Counter-intel surge
// ---------------------------------------------------------------------------

describe('AI counter-intel surge', () => {
  it('a rival spy inside virtual SIGINT coverage latches the surge', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    // A rival spy well inside the base-anchored 60-radius coverage.
    const rival = spawnUnit(ctx.world, 'spy', 1, ctx.base.x + 20, ctx.base.z);
    expect(rival.id).toBeGreaterThan(0);
    run(ctx, 120);
    expect(ctx.ai.intel.counterIntelSurge).toBe(true);
  });

  it('the surge jumps signalsStation to the head of the intel queue', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    ctx.ai.intel.counterIntelSurge = true;
    run(ctx, 120);
    // signalsStation (900 funds) starts before intelHQ (1400) despite
    // the priority table listing intelHQ first.
    expect(ctx.ai.intel.constructing?.kind).toBe('signalsStation');
  });

  it('a discovery warning on a rival mixed airport latches the surge', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    const airport = enemyBuildingNear(ctx, 'mixedAirport');
    airport.discovery = [
      { viewer: 0, state: 'suspected', warnedTick: 0, revealedTick: 1800 },
    ];
    run(ctx, 120);
    expect(ctx.ai.intel.counterIntelSurge).toBe(true);
  });

  it('no trigger: no surge', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    run(ctx, 300);
    expect(ctx.ai.intel.counterIntelSurge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Intel research
// ---------------------------------------------------------------------------

describe('AI intel research', () => {
  it('researches signalsIntel with a listeningPost, counterIntel with a signalsStation', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.virtualBuildings.completed.push('listeningPost', 'signalsStation');
    const player = getPlayer(ctx.world.city, 0)!;
    player.research = 10000;
    run(ctx, 120);
    expect(ctx.world.upgrades[0]).toContain('signalsIntel');
    // counterIntel needs the signalsStation — held — so it follows.
    run(ctx, 120);
    expect(ctx.world.upgrades[0]).toContain('counterIntel');
  });

  it('researches nothing without the intel buildings', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    const player = getPlayer(ctx.world.city, 0)!;
    player.research = 10000;
    run(ctx, 300);
    expect(ctx.world.upgrades[0] ?? []).not.toContain('signalsIntel');
    expect(ctx.world.upgrades[0] ?? []).not.toContain('counterIntel');
  });
});

// ---------------------------------------------------------------------------
// Virtual SIGINT detection (sim/intel.ts)
// ---------------------------------------------------------------------------

describe('virtual SIGINT detection', () => {
  it('a completed virtual listeningPost detects from the AI base', () => {
    const ctx = setupIntelCtx();
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    // 30 units from the base: inside the 60-radius coverage.
    expect(detectionRadiusAt(ctx.world, 0, ctx.base.x + 30, ctx.base.z)).toBe(60);
    // 100 units out: nothing.
    expect(detectionRadiusAt(ctx.world, 0, ctx.base.x + 100, ctx.base.z)).toBe(0);
    const spy = spawnUnit(ctx.world, 'spy', 1, ctx.base.x + 30, ctx.base.z);
    expect(isDetected(spy, 0, ctx.world)).toBe(true);
    const farSpy = spawnUnit(ctx.world, 'spy', 1, ctx.base.x + 100, ctx.base.z);
    expect(isDetected(farSpy, 0, ctx.world)).toBe(false);
  });

  it('no virtual detectors: no coverage', () => {
    const ctx = setupIntelCtx();
    expect(detectionRadiusAt(ctx.world, 0, ctx.base.x + 30, ctx.base.z)).toBe(0);
    const spy = spawnUnit(ctx.world, 'spy', 1, ctx.base.x + 30, ctx.base.z);
    expect(isDetected(spy, 0, ctx.world)).toBe(false);
  });

  it('buildingSightCoverage includes the virtual SIGINT term (sees stealth)', () => {
    const ctx = setupIntelCtx();
    ctx.ai.virtualBuildings.completed.push('signalsStation');
    const coverage = buildingSightCoverage(ctx.world, 0);
    const virtual = coverage.filter(
      (c) => c.x === ctx.ai.baseX && c.z === ctx.ai.baseZ,
    );
    expect(virtual.length).toBe(1);
    expect(virtual[0]!.radius).toBe(
      BUILDING_DEFS.signalsStation.detectionRadius,
    );
    expect(virtual[0]!.seesStealth).toBe(true);
  });

  it('counterIntel widens the virtual detection radius', () => {
    const ctx = setupIntelCtx();
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    ctx.world.upgrades[0] = ['counterIntel'];
    expect(detectionRadiusAt(ctx.world, 0, ctx.base.x + 30, ctx.base.z)).toBe(
      BUILDING_DEFS.listeningPost.detectionRadius! + COUNTER_INTEL_RADIUS_BONUS,
    );
  });
});

// ---------------------------------------------------------------------------
// Persistence: snapshot round trip + digest stability
// ---------------------------------------------------------------------------

describe('AI intel state persistence', () => {
  it('save/load round-trips the intel state (AD9: no version bump)', () => {
    const ctx = setupIntelCtx();
    completeProductionBase(ctx.ai);
    ctx.ai.intel.constructing = { kind: 'intelHQ', readyTick: 1234 };
    ctx.ai.intel.counterIntelSurge = true;
    ctx.ai.intel.ops = { infiltrate: 3, sabotage: 1, steal: 2 };
    ctx.ai.virtualBuildings.completed.push('listeningPost');
    const snap = takeSnapshot(ctx.world);
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    const ai = restored.ai.players.find((p) => p.owner === 0)!;
    expect(ai.intel).toEqual(ctx.ai.intel);
    expect(digestWorld(restored)).toBe(digestWorld(ctx.world));
  });

  it('pre-Phase-6 snapshots decode to the default intel state', () => {
    const ctx = setupIntelCtx();
    const snap = takeSnapshot(ctx.world) as {
      ai: { players: { intel?: unknown }[] };
    };
    // Simulate a pre-Phase-6 save: strip the intel block.
    for (const p of snap.ai.players) delete p.intel;
    const restored = restoreSnapshot(JSON.parse(JSON.stringify(snap)));
    const ai = restored.ai.players.find((p) => p.owner === 0)!;
    expect(ai.intel).toEqual({
      constructing: null,
      counterIntelSurge: false,
      ops: { infiltrate: 0, sabotage: 0, steal: 0 },
    });
  });

  it('same seed + same script ⇒ identical digest with intel play running', () => {
    const runMatch = (seed: number): number => {
      const ctx = setupIntelCtx(seed);
      completeProductionBase(ctx.ai);
      ctx.ai.virtualBuildings.completed.push('listeningPost', 'intelHQ');
      enemyBuildingNear(ctx, 'barracks');
      const player = getPlayer(ctx.world.city, 0)!;
      player.intel.surveillance = 30;
      player.intel.operational = 30;
      ctx.world.upgrades[1] = ['apRounds'];
      run(ctx, 900);
      return digestWorld(ctx.world);
    };
    expect(runMatch(777)).toBe(runMatch(777));
  });
});


