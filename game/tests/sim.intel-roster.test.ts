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
 * Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
 * def-side tests for the intel interface contract (sim/intel.ts).
 *
 * This file covers the intel WORKSTREAM's half only: defs, the
 * intelHQ-trains-spy gate, asset accrual, the detection geometry,
 * upgrade math, and snapshot/digest coverage. The mechanics the
 * sim-core workstream owns (infiltrateBuilding / sabotage commands,
 * the acquireTarget + getVisibleEnemies hooks, economy-tick wiring)
 * are NOT tested here — their commands don't exist yet; the test
 * would be asserting against a placeholder.
 */
import { describe, expect, it } from 'vitest';
import {
  createWorld,
  type World,
} from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
  type NewCommand,
} from '../src/sim/commands';
import {
  BUILDING_DEFS,
  BuildingKind,
  cellCenterWorld,
  getPlayer,
  registerCityCommands,
} from '../src/sim/city';
import {
  UNIT_DEFS,
  UNIT_KINDS,
  registerUnitCommands,
  spawnUnit,
  type UnitKind,
} from '../src/sim/units';
import {
  UPGRADE_DEFS,
  hasUpgrade,
  registerUpgradeCommands,
} from '../src/sim/upgrades';
import { registerAgeCommands } from '../src/sim/ages';
import {
  runIntelAccrual,
  detectionRadiusAt,
  isDetected,
  sabotageDurationSec,
  intelSightBonus,
  isSabotaged,
  getIntelAssets,
  SIGNALS_INTEL_SURVEILLANCE_MULT,
  COUNTER_INTEL_ASSET_MULT,
  COUNTER_INTEL_RADIUS_BONUS,
  SIGNALS_INTEL_SIGHT_BONUS,
  BASE_SABOTAGE_DURATION_SEC,
  COUNTER_INTEL_SABOTAGE_DURATION_MULT,
} from '../src/sim/intel';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { createTickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  grantAllTrainingResources,
  completeBuilding,
  completeBuildings,
} from './sim.roster-fixtures';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: ReturnType<typeof createCommandQueue>;
  driver: ReturnType<typeof createTickDriver>;
}

function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerCityCommands(queue, terrain);
  registerAgeCommands(queue);
  registerUpgradeCommands(queue);
  const driver = createTickDriver({ queue, systems: [] });
  return { terrain, world, queue, driver };
}

/** Funded test world with the intel buildings for owner 0. */
function setupIntel(seed = 20260930): Ctx {
  const ctx = setup(seed);
  grantAllTrainingResources(ctx.world);
  completeBuildings(ctx.world, 0, [
    'intelHQ',
    'listeningPost',
    'signalsStation',
    'satelliteUplink',
  ]);
  // Age gate for spy training + intelHQ placement (def tests bypass the
  // construction game; the age mechanic itself is covered in
  // sim.ages.test.ts).
  ctx.world.ages.age = 'information';
  return ctx;
}

function tick(ctx: Ctx, n = 1): void {
  for (let i = 0; i < n; i += 1) ctx.driver.step(ctx.world, 100);
}

function enq(ctx: Ctx, kind: string, payload: Record<string, unknown>): void {
  const cmd: NewCommand = { issuer: 'player', kind, payload };
  ctx.queue.enqueue(ctx.world, cmd);
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

/** A land spawn point near the map center (deterministic per seed). */
function findLandNear(
  t: TerrainData,
  x: number,
  z: number,
): { x: number; z: number } {
  for (let r = 0; r < 200; r += 4) {
    for (let dz = -r; dz <= r; dz += 4) {
      for (let dx = -r; dx <= r; dx += 4) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > 250 || Math.abs(cz) > 250) continue;
        if (!isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no land near (${x}, ${z})`);
}

/** Grant an upgrade directly (bypasses research — the command is covered elsewhere). */
function grantUpgrade(world: World, owner: number, id: string): void {
  (world.upgrades[owner] ??= []).push(id);
  expect(hasUpgrade(world, owner, id)).toBe(true);
}

// ---------------------------------------------------------------------------
// Def validity.
// ---------------------------------------------------------------------------

describe('intel roster defs (§3.8/S6)', () => {
  it('registers the four intel buildings with sane costs and gates', () => {
    for (const [enumKey, kind] of [
      ['INTEL_HQ', 'intelHQ'],
      ['LISTENING_POST', 'listeningPost'],
      ['SATELLITE_UPLINK', 'satelliteUplink'],
      ['SIGNALS_STATION', 'signalsStation'],
    ] as const) {
      expect(BuildingKind[enumKey as keyof typeof BuildingKind]).toBe(kind);
      const def = BUILDING_DEFS[kind];
      expect(def).toBeDefined();
      expect(def.costFunds).toBeGreaterThan(0);
      expect(def.costMaterials).toBeGreaterThan(0);
      expect(def.buildSeconds).toBeGreaterThan(0);
      expect(def.zone).toBe('utility'); // UTILITY_ZONE (city.ts constant)
    }
    // The §3.8 tech ladder reads bottom-to-top.
    expect(BUILDING_DEFS.listeningPost.minAge).toBe('connectivity');
    expect(BUILDING_DEFS.intelHQ.minAge).toBe('information');
    expect(BUILDING_DEFS.signalsStation.minAge).toBe('information');
    expect(BUILDING_DEFS.satelliteUplink.minAge).toBe('ascendance');
    // Asset outputs: exactly the §3.8 per-building rates.
    expect(BUILDING_DEFS.intelHQ.intelOutput).toEqual({
      surveillance: 0.1,
      operational: 0.2,
    });
    expect(BUILDING_DEFS.listeningPost.intelOutput).toEqual({
      surveillance: 0.25,
    });
    expect(BUILDING_DEFS.satelliteUplink.intelOutput).toEqual({
      surveillance: 0.6,
    });
    expect(BUILDING_DEFS.signalsStation.intelOutput).toEqual({
      counterIntel: 0.2,
    });
    // Detection geometry comes from the defs.
    expect(BUILDING_DEFS.listeningPost.detectionRadius).toBe(60);
    expect(BUILDING_DEFS.signalsStation.detectionRadius).toBe(45);
    expect(BUILDING_DEFS.intelHQ.detectionRadius).toBeUndefined();
    expect(BUILDING_DEFS.satelliteUplink.sightBonus).toBe(12);
  });

  it('registers the spy and reconTeam units with the stealth marker and gates', () => {
    expect(UNIT_KINDS).toContain('spy');
    expect(UNIT_KINDS).toContain('reconTeam');
    expect(UNIT_DEFS.spy).toMatchObject({
      hp: 60,
      speed: 10,
      armor: 'light',
      damage: 0,
      sight: 30,
      minAge: 'information',
      requiredBuilding: 'intelHQ',
      stealth: true,
      trainFunds: 400,
      trainMaterials: 40,
    });
    expect(UNIT_DEFS.reconTeam).toMatchObject({
      hp: 100,
      speed: 14,
      armor: 'light',
      damage: 8,
      range: 12,
      sight: 44,
      minAge: 'connectivity',
      requiredBuilding: 'barracks',
      trainFunds: 150,
      trainMaterials: 15,
    });
    // R1 final-review (user decision 2026-10-01): stealth is the
    // detection contract consumed by isDetected — set on the spy (the
    // covert-ops role) AND the spectre (the "stealthy raider" the
    // player docs always described). The role stays spy-only: see
    // isSpyUnit in sim/intel.ts (kind-gated, never def-gated).
    const stealthed = (Object.keys(UNIT_DEFS) as UnitKind[]).filter(
      (k) => UNIT_DEFS[k].stealth === true,
    );
    expect([...stealthed].sort()).toEqual(['spectre', 'spy']);
  });

  it('registers the two intel upgrades with building prerequisites', () => {
    expect(UPGRADE_DEFS.signalsIntel).toMatchObject({
      costFunds: 1000,
      costResearch: 100,
      minAge: 'information',
      requiredBuildings: ['listeningPost'],
    });
    expect(UPGRADE_DEFS.counterIntel).toMatchObject({
      costFunds: 900,
      costResearch: 90,
      minAge: 'information',
      requiredBuildings: ['signalsStation'],
    });
  });

  it('starts every player with zero intel assets', () => {
    const ctx = setup();
    for (const p of ctx.world.city.players) {
      expect(p.intel).toEqual({
        surveillance: 0,
        operational: 0,
        counterIntel: 0,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Training gates.
// ---------------------------------------------------------------------------

describe('intel unit training gates', () => {
  it('trains the spy only from a completed intelHQ', () => {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    ctx.world.ages.age = 'information';
    const at = findLandNear(ctx.terrain, 0, 0);
    // No intelHQ anywhere: the gate rejects with the building's name.
    const reason = rejectionReason(ctx, 'spawnUnit', {
      kind: 'spy',
      owner: 0,
      x: at.x,
      z: at.z,
    });
    expect(reason).toContain('requires a completed');
    expect(reason).toContain('Intelligence Headquarters');
    // A completed intelHQ opens the gate — the spy trains.
    completeBuilding(ctx.world, 'intelHQ', 0);
    expect(
      rejectionReason(ctx, 'spawnUnit', {
        kind: 'spy',
        owner: 0,
        x: at.x,
        z: at.z,
      }),
    ).toBeNull();
    tick(ctx);
    const spies = ctx.world.units.filter((u) => u.kind === 'spy');
    expect(spies).toHaveLength(1);
    expect(spies[0]!.owner).toBe(0);
    // Training cost was deducted (400 funds + 40 materials).
    expect(getPlayer(ctx.world.city, 0)!.funds).toBe(1_000_000 - 400);
    expect(getPlayer(ctx.world.city, 0)!.materials).toBe(1_000_000 - 40);
  });

  it('trains the reconTeam from the barracks (no intel gate)', () => {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    ctx.world.ages.age = 'connectivity';
    completeBuilding(ctx.world, 'barracks', 0);
    const at = findLandNear(ctx.terrain, 0, 0);
    expect(
      rejectionReason(ctx, 'spawnUnit', {
        kind: 'reconTeam',
        owner: 0,
        x: at.x,
        z: at.z,
      }),
    ).toBeNull();
    tick(ctx);
    expect(
      ctx.world.units.filter((u) => u.kind === 'reconTeam'),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Asset accrual.
// ---------------------------------------------------------------------------

describe('intel asset accrual (runIntelAccrual)', () => {
  it('accrues the §3.8 per-building rates per sim-second', () => {
    const ctx = setupIntel();
    // All four buildings, 100 sim-seconds:
    //   intelHQ:       0.1 surveillance + 0.2 operational
    //   listeningPost: 0.25 surveillance
    //   satelliteUplink: 0.6 surveillance
    //   signalsStation: 0.2 counterIntel
    runIntelAccrual(ctx.world, 100);
    const intel = getIntelAssets(ctx.world, 0);
    expect(intel.surveillance).toBeCloseTo((0.1 + 0.25 + 0.6) * 100, 9);
    expect(intel.operational).toBeCloseTo(0.2 * 100, 9);
    expect(intel.counterIntel).toBeCloseTo(0.2 * 100, 9);
    // Other players are untouched.
    for (const p of ctx.world.city.players) {
      if (p.id === 0) continue;
      expect(getIntelAssets(ctx.world, p.id)).toEqual({
        surveillance: 0,
        operational: 0,
        counterIntel: 0,
      });
    }
  });

  it('skips under-construction, non-operational, and foreign buildings', () => {
    const ctx = setupIntel();
    // Under construction: progress < 1 accrues nothing.
    ctx.world.city.buildings.push({
      id: ctx.world.city.nextBuildingId++,
      kind: 'listeningPost',
      owner: 0,
      cx: 40,
      cz: 40,
      facing: 0,
      progress: 0.5,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
    });
    runIntelAccrual(ctx.world, 100);
    // Exactly the four completed buildings' output — the half-built one
    // contributes zero.
    expect(getIntelAssets(ctx.world, 0).surveillance).toBeCloseTo(
      (0.1 + 0.25 + 0.6) * 100,
      9,
    );
  });

  it('sabotaged buildings accrue nothing (and recover when the sabotage expires)', () => {
    const ctx = setupIntel();
    const hq = ctx.world.city.buildings.find((b) => b.kind === 'intelHQ')!;
    // sabotagedUntil is tick-space (the core converts sabotageDurationSec
    // sim-seconds → ticks when it sets this).
    hq.sabotagedUntil = 1000;
    expect(isSabotaged(hq, ctx.world.tick)).toBe(true);
    runIntelAccrual(ctx.world, 100);
    const intel = getIntelAssets(ctx.world, 0);
    // No intelHQ output (0.1 surveillance + 0.2 operational missing).
    expect(intel.surveillance).toBeCloseTo((0.25 + 0.6) * 100, 9);
    expect(intel.operational).toBe(0);
    // After the sabotage expires the building accrues again.
    ctx.world.tick = 1001;
    expect(isSabotaged(hq, ctx.world.tick)).toBe(false);
    runIntelAccrual(ctx.world, 100);
    expect(getIntelAssets(ctx.world, 0).operational).toBeCloseTo(
      0.2 * 100,
      9,
    );
  });

  it('signalsIntel ×1.5 surveillance and counterIntel ×1.25 counter-intel', () => {
    const ctx = setupIntel();
    grantUpgrade(ctx.world, 0, 'signalsIntel');
    grantUpgrade(ctx.world, 0, 'counterIntel');
    runIntelAccrual(ctx.world, 100);
    const intel = getIntelAssets(ctx.world, 0);
    expect(intel.surveillance).toBeCloseTo(
      (0.1 + 0.25 + 0.6) * 100 * SIGNALS_INTEL_SURVEILLANCE_MULT,
      9,
    );
    // operational is never multiplied.
    expect(intel.operational).toBeCloseTo(0.2 * 100, 9);
    expect(intel.counterIntel).toBeCloseTo(
      0.2 * 100 * COUNTER_INTEL_ASSET_MULT,
      9,
    );
  });

  it('is deterministic: identical states accrue identically', () => {
    const a = setupIntel(7);
    const b = setupIntel(7);
    runIntelAccrual(a.world, 37);
    runIntelAccrual(b.world, 37);
    expect(getIntelAssets(a.world, 0)).toEqual(getIntelAssets(b.world, 0));
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
  });
});

// ---------------------------------------------------------------------------
// Detection geometry.
// ---------------------------------------------------------------------------

describe('detection geometry (detectionRadiusAt / isDetected)', () => {
  /**
   * Owner 1 gets their own detection net (a listeningPost + a
   * signalsStation 6 cells away, so their radii overlap) — the tests
   * view owner 0's spies through owner 1's eyes.
   */
  function setupDetection(): Ctx {
    const ctx = setupIntel();
    completeBuilding(ctx.world, 'listeningPost', 1, 40, 40);
    completeBuilding(ctx.world, 'signalsStation', 1, 46, 40);
    return ctx;
  }

  /** World-space center of an owner's listeningPost footprint. */
  function postCenter(world: World, owner: number): { x: number; z: number } {
    const b = world.city.buildings.find(
      (bd) => bd.kind === 'listeningPost' && bd.owner === owner,
    )!;
    return {
      x: cellCenterWorld(b.cx),
      z: cellCenterWorld(b.cz),
    };
  }

  it('sees non-stealthed units everywhere and own units always', () => {
    const ctx = setup();
    const at = findLandNear(ctx.terrain, 0, 0);
    const tank = spawnUnit(ctx.world, 'tank', 0, at.x, at.z);
    // No detection buildings at all: overt units are still visible.
    expect(isDetected(tank, 1, ctx.world)).toBe(true);
    // Own units are always visible to their owner.
    const spy = spawnUnit(ctx.world, 'spy', 1, at.x, at.z);
    expect(isDetected(spy, 1, ctx.world)).toBe(true);
  });

  it('hides the spy outside detection radii, reveals it inside', () => {
    const ctx = setupDetection();
    const c = postCenter(ctx.world, 1);
    const spy = spawnUnit(ctx.world, 'spy', 0, c.x, c.z);
    // Sitting on the listeningPost: inside the 60-unit radius.
    expect(detectionRadiusAt(ctx.world, 1, c.x, c.z)).toBe(60);
    expect(isDetected(spy, 1, ctx.world)).toBe(true);
    // 500 units away: outside every radius.
    spy.x = c.x + 500;
    expect(detectionRadiusAt(ctx.world, 1, spy.x, spy.z)).toBe(0);
    expect(isDetected(spy, 1, ctx.world)).toBe(false);
  });

  it('returns the largest covering radius when radii overlap', () => {
    const ctx = setupDetection();
    const c = postCenter(ctx.world, 1);
    // The listeningPost (60) dwarfs the signalsStation (45) here.
    expect(detectionRadiusAt(ctx.world, 1, c.x, c.z)).toBe(60);
    // Just past the signalsStation's radius: still covered by the post.
    expect(detectionRadiusAt(ctx.world, 1, c.x + 50, c.z)).toBe(60);
  });

  it('counterIntel adds +25 detection radius to every source', () => {
    const ctx = setupDetection();
    grantUpgrade(ctx.world, 1, 'counterIntel');
    const c = postCenter(ctx.world, 1);
    expect(detectionRadiusAt(ctx.world, 1, c.x, c.z)).toBe(
      60 + COUNTER_INTEL_RADIUS_BONUS,
    );
    // A spy 70 units out is invisible without the bonus, visible with it.
    const spy = spawnUnit(ctx.world, 'spy', 0, c.x + 70, c.z);
    expect(isDetected(spy, 1, ctx.world)).toBe(true);
  });

  it('ignores other owners and under-construction detectors', () => {
    const ctx = setupIntel();
    const c = postCenter(ctx.world, 0);
    // Owner 2 has no detection buildings: sees nothing stealthed.
    const spy = spawnUnit(ctx.world, 'spy', 0, c.x, c.z);
    expect(isDetected(spy, 2, ctx.world)).toBe(false);
    // An under-construction post does not detect.
    completeBuilding(ctx.world, 'listeningPost', 2, 30, 30);
    const half = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
    half.progress = 0.5;
    expect(
      detectionRadiusAt(ctx.world, 2, cellCenterWorld(30), cellCenterWorld(30)),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Upgrade math: sabotage duration + sight bonus.
// ---------------------------------------------------------------------------

describe('intel upgrade math', () => {
  it('sabotages last 45 sim-seconds, halved by counterIntel', () => {
    const ctx = setup();
    expect(sabotageDurationSec(ctx.world, 0)).toBe(BASE_SABOTAGE_DURATION_SEC);
    expect(BASE_SABOTAGE_DURATION_SEC).toBe(45);
    grantUpgrade(ctx.world, 0, 'counterIntel');
    expect(sabotageDurationSec(ctx.world, 0)).toBe(
      45 * COUNTER_INTEL_SABOTAGE_DURATION_MULT,
    );
    expect(sabotageDurationSec(ctx.world, 0)).toBe(22.5);
    // The victim's counter-intel resists — the attacker's upgrades are
    // irrelevant.
    expect(sabotageDurationSec(ctx.world, 1)).toBe(45);
  });

  it('satelliteUplink sightBonus sums, signalsIntel adds +4', () => {
    const ctx = setupIntel();
    expect(intelSightBonus(ctx.world, 0)).toBe(12);
    grantUpgrade(ctx.world, 0, 'signalsIntel');
    expect(intelSightBonus(ctx.world, 0)).toBe(12 + SIGNALS_INTEL_SIGHT_BONUS);
    expect(intelSightBonus(ctx.world, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Save/load round-trip + digest coverage.
// ---------------------------------------------------------------------------

describe('intel persistence (§3.8/S6)', () => {
  it('round-trips intel assets and sabotagedUntil through v8 snapshots', () => {
    const ctx = setupIntel();
    runIntelAccrual(ctx.world, 100);
    const hq = ctx.world.city.buildings.find((b) => b.kind === 'intelHQ')!;
    hq.sabotagedUntil = 4242;
    const snap = takeSnapshot(ctx.world);
    const fresh = restoreSnapshot(snap);
    expect(getIntelAssets(fresh, 0)).toEqual(getIntelAssets(ctx.world, 0));
    const freshHq = fresh.city.buildings.find((b) => b.kind === 'intelHQ')!;
    expect(freshHq.sabotagedUntil).toBe(4242);
    expect(isSabotaged(freshHq, fresh.tick)).toBe(
      isSabotaged(hq, ctx.world.tick),
    );
    // The snapshot format is unchanged (v8 — the meltdown ?? 0 precedent).
    expect(snap.version).toBe(8);
  });

  it('accrual changes the digest (intel assets are behavior-affecting)', () => {
    const a = setupIntel(11);
    const b = setupIntel(11);
    runIntelAccrual(a.world, 50);
    expect(digestWorld(a.world)).not.toBe(digestWorld(b.world));
    runIntelAccrual(b.world, 50);
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
  });

  it('legacy-style states without intel fields decode to zero (AD9)', () => {
    const ctx = setupIntel();
    // Simulate a legacy save: strip the intel block from a player.
    const p = getPlayer(ctx.world.city, 0)!;
    delete (p as { intel?: unknown }).intel;
    const snap = takeSnapshot(ctx.world);
    const fresh = restoreSnapshot(snap);
    expect(getIntelAssets(fresh, 0)).toEqual({
      surveillance: 0,
      operational: 0,
      counterIntel: 0,
    });
    // Buildings without sabotagedUntil decode to 0 = not sabotaged.
    const b = fresh.city.buildings.find((bd) => bd.kind === 'listeningPost')!;
    delete (b as { sabotagedUntil?: unknown }).sabotagedUntil;
    const snap2 = takeSnapshot(fresh);
    const fresh2 = restoreSnapshot(snap2);
    const b2 = fresh2.city.buildings.find((bd) => bd.kind === 'listeningPost')!;
    expect(b2.sabotagedUntil).toBe(0);
    expect(isSabotaged(b2, fresh2.tick)).toBe(false);
  });
});
