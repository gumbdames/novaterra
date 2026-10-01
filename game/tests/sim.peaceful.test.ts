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
 * NOVATERRA — peaceful-mode sim-foundation tests (grand-expansion Phase 8,
 * workstream A, 2026-09-30).
 *
 * Covers the sibling contracts:
 *  - `world.peaceful` exists, defaults to false, and round-trips through
 *    snapshots (a legacy snapshot that predates the field decodes to
 *    false — the AD9 neutral-default precedent, no version bump).
 *  - The command lockout: military defs are LOUDLY rejected in peaceful
 *    worlds on all four paths (spawnUnit, placeBuilding,
 *    researchUpgrade, the three covert ops) plus the superweapon path
 *    (constructSuperweaponFacility / fireStorm / fireAegis); civilian
 *    defs still enqueue cleanly.
 *  - Roster pinning: every unit/building/upgrade kind is classified by
 *    its `military` def flag, matching the pinned sets (a def rebalance
 *    that moves a kind breaks the suite loudly instead of silently
 *    re-tuning the lockout).
 *  - Conquest is bypassed in peaceful worlds (checkSkirmishVictory /
 *    checkSkirmishDefeat / getSkirmishOutcome return false/null) — and
 *    peaceful mode is ENDLESS (2026-10-01): there is no victory
 *    condition at all, so a peaceful world never declares a winner.
 *  - The peaceful status reports housed population + treasury health
 *    (`peacefulStatus`) — a status readout, not a victory check.
 *  - Regression: past the OLD 8,000-resident victory threshold, no
 *    victory fires and the sim keeps ticking (endless).
 *  - Determinism: same seed + peaceful ⇒ identical digest across runs,
 *    and the flag itself is digest-covered.
 *
 * Headless (no DOM/three.js). Deterministic: no wall clock, no Math.random.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  CommandRejectedError,
  createCommandQueue,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { registerUnitCommands, UNIT_DEFS, spawnUnit } from '../src/sim/units';
import {
  BUILDING_DEFS,
  getPlayer,
  ZoneType,
  cellIsWater,
  cellCenterWorld,
  cellIndex,
  CITY_GRID_CELLS,
  type BuildingRecord,
} from '../src/sim/city';
import { registerCityCommands } from '../src/sim/city';
import { registerUpgradeCommands, UPGRADE_DEFS } from '../src/sim/upgrades';
import { registerIntelCommands } from '../src/sim/intel';
import { registerSuperweaponCommands } from '../src/sim/superweapons';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { peacefulStatus, peacefulScore, milestonesReached, PEACEFUL_MILESTONES } from '../src/sim/peaceful';
import { TICK_MS } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  type TerrainData,
} from '../src/sim/terrain';
import {
  createSession,
  checkSkirmishVictory,
  checkSkirmishDefeat,
  getSkirmishOutcome,
  CONQUEST_GRACE_TICKS,
  HUMAN_PLAYER_ID,
  AI_PLAYER_ID,
} from '../src/ui/session';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

/** A peaceful world with all command families registered. */
function peacefulSetup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  // The session sets this at tick 0 from SessionOptions.peaceful; tests
  // set it before any command, exactly like the session does.
  world.peaceful = true;
  const queue = createCommandQueue();
  registerUnitCommands(queue, terrain);
  registerCityCommands(queue, terrain);
  registerUpgradeCommands(queue);
  registerIntelCommands(queue);
  registerSuperweaponCommands(queue);
  grantAllTrainingResources(world);
  return { terrain, world, queue };
}

/** The same fixture with the flag left at its createWorld default. */
function warSetup(seed = 20260930): Ctx {
  const ctx = peacefulSetup(seed);
  ctx.world.peaceful = false;
  return ctx;
}

function enq(ctx: Ctx, kind: string, payload: Record<string, unknown>): void {
  const cmd: NewCommand = { kind, payload, issuer: 'player' };
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

/** Find an all-land rect (for zoning / footprints / spawn points). */
function findLandRect(t: TerrainData, w: number, h: number): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error(`no ${w}x${h} land rect`);
}

/** A peaceful-session world (the UI assembly path), tick 1. */
function peacefulSessionWorld(): World {
  return createSession({ seed: 4242, peaceful: true }).world;
}

// ---------------------------------------------------------------------------
// Pinned rosters — the full classification of every def.
// A def rebalance that moves a kind across the line must update these
// sets deliberately; that is the point of pinning them here.
// ---------------------------------------------------------------------------

/** The 71 military unit kinds (every other unit def is civilian). */
const MILITARY_UNITS = new Set([
  'aa',
  'aaMk2',
  'aaMk3',
  'ammoShip',
  'apc',
  'apcMk2',
  'apcMk3',
  'armedUAV',
  'artillery',
  'artilleryMk2',
  'artilleryMk3',
  'attackHeli',
  'attackHeliMk2',
  'attackHeliMk3',
  'awacs',
  'battleship',
  'carrier',
  'coastGuardCutter',
  'coastalSub',
  'combatMedic',
  'commandShip',
  'corvette',
  'cruiser',
  'destroyer',
  'destroyerMk2',
  'destroyerMk3',
  'drone', // armed scout drone (damage 9) — not the unarmed reconUAV/reconPlane
  'fighter',
  'fighterBomber',
  'fighterBomberMk2',
  'fighterBomberMk3',
  'fighterMk2',
  'fighterMk3',
  'frigate',
  'frigateMk2',
  'frigateMk3',
  'fuelTanker',
  'fuelTruck',
  'gunship',
  'gunshipMk2',
  'gunshipMk3',
  'heavyDestroyer',
  'hq',
  'maritimePatrol',
  'militaryCargo',
  'minelayer',
  'missileBoat',
  'missileBoatMk2',
  'missileBoatMk3',
  'missileSub',
  'mlrs',
  'navalFighter',
  'navalMine',
  'patrolBoat',
  'reconTeam',
  'repairShip',
  'rifles',
  'sniperTeam',
  'spectre',
  'spy',
  'strategicBomber',
  'submarine',
  'submarineMk2',
  'submarineMk3',
  'supplyTruck',
  'tank',
  'tankDestroyer',
  'tankMk2',
  'tankMk3',
  'tanker',
  'trainer',
]);

/** The 21 military building kinds (every other building def is civilian). */
const MILITARY_BUILDINGS = new Set([
  'aegisControl',
  'stormArray',
  'barracks',
  'warFactory',
  'militaryAcademy',
  'airfield',
  'navalYard',
  'shipyard',
  'radarStation',
  'munitionsFactory',
  'missilePlant',
  'missileSilo',
  'ordnanceDepot',
  'fuelDepot',
  'intelHQ',
  'listeningPost',
  'satelliteUplink',
  'signalsStation',
  'militaryAirbase',
  'mixedAirport',
  'navalBase',
]);

/** The 11 military upgrade kinds (every other upgrade is civilian). */
const MILITARY_UPGRADES = new Set([
  'apRounds',
  'compositeArmor',
  'engineTuning',
  'advancedAvionics',
  'sonarSuite',
  'cruiseMissiles',
  'droneOptics',
  'fieldMedicine',
  'advancedLogistics',
  'signalsIntel',
  'counterIntel',
]);

// ---------------------------------------------------------------------------
// world.peaceful flag
// ---------------------------------------------------------------------------

describe('world.peaceful flag', () => {
  it('defaults to false in createWorld', () => {
    expect(createWorld(1).peaceful).toBe(false);
  });

  it('round-trips true through snapshot/restore', () => {
    const world = createWorld(7);
    world.peaceful = true;
    const restored = restoreSnapshot(takeSnapshot(world));
    expect(restored.peaceful).toBe(true);
  });

  it('round-trips false through snapshot/restore', () => {
    const restored = restoreSnapshot(takeSnapshot(createWorld(7)));
    expect(restored.peaceful).toBe(false);
  });

  it('a legacy snapshot that predates the field decodes to false (no version bump)', () => {
    const snap = takeSnapshot(createWorld(7)) as unknown as Record<string, unknown>;
    delete snap.peaceful;
    expect(restoreSnapshot(snap as never).peaceful).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Command lockout
// ---------------------------------------------------------------------------

describe('peaceful command lockout', () => {
  it('spawnUnit rejects military units loudly and accepts civilian ones', () => {
    const ctx = peacefulSetup();
    const { cx, cz } = findLandRect(ctx.terrain, 4, 4);
    const x = cellCenterWorld(cx);
    const z = cellCenterWorld(cz);
    const reason = rejectionReason(ctx, 'spawnUnit', { kind: 'rifles', owner: 0, x, z });
    expect(reason).toMatch(/peaceful mode/);
    expect(reason).toContain('Rifles');
    // Civilian: the engineer trains fine.
    expect(rejectionReason(ctx, 'spawnUnit', { kind: 'engineer', owner: 0, x, z })).toBeNull();
  });

  it('spawnUnit still accepts military units when the world is not peaceful', () => {
    const ctx = warSetup();
    const { cx, cz } = findLandRect(ctx.terrain, 4, 4);
    const x = cellCenterWorld(cx);
    const z = cellCenterWorld(cz);
    // The barracks gate is the only blocker — the peaceful gate is off.
    completeBuilding(ctx.world, 'barracks', 0, cx, cz);
    expect(
      rejectionReason(ctx, 'spawnUnit', { kind: 'rifles', owner: 0, x, z }),
    ).toBeNull();
  });

  it('placeBuilding rejects military buildings loudly and accepts civilian ones', () => {
    const ctx = peacefulSetup();
    const reason = rejectionReason(ctx, 'placeBuilding', {
      kind: 'barracks',
      owner: 0,
      cx: 10,
      cz: 10,
      facing: 0,
    });
    expect(reason).toMatch(/peaceful mode/);
    expect(reason).toContain('Barracks');
    // Civilian: a house on zoned residential land places fine.
    const { cx, cz } = findLandRect(ctx.terrain, 8, 8);
    enq(ctx, 'buildRoad', {
      owner: 0,
      cells: [
        cellIndex(cx, cz),
        cellIndex(cx + 1, cz),
        cellIndex(cx + 2, cz),
        cellIndex(cx + 3, cz),
      ],
    });
    enq(ctx, 'paintZone', {
      owner: 0,
      zone: ZoneType.RESIDENTIAL,
      x0: cx,
      z0: cz + 1,
      x1: cx + 3,
      z1: cz + 2,
    });
    ctx.queue.applyDue(ctx.world, ctx.world.tick);
    expect(
      rejectionReason(ctx, 'placeBuilding', { kind: 'house', owner: 0, cx, cz: cz + 1, facing: 0 }),
    ).toBeNull();
  });

  it('researchUpgrade rejects military upgrades loudly and accepts civilian ones', () => {
    const ctx = peacefulSetup();
    completeBuilding(ctx.world, 'lab', 0, 10, 10);
    const player = getPlayer(ctx.world.city, 0);
    if (!player) throw new Error('no player 0');
    player.research = 1_000_000;
    const reason = rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'apRounds' });
    expect(reason).toMatch(/peaceful mode/);
    // Civilian: the utility ladder researches fine (foundation age, no
    // building gate — the honest civilian counterpart).
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'groundwaterSurvey' }),
    ).toBeNull();
  });

  it('covert ops are locked out in peaceful worlds', () => {
    const ctx = warSetup();
    // Spy training is military-locked, so the spy is trained before the
    // world goes peaceful — the only honest way to test the op gate.
    const spy = spawnUnit(ctx.world, 'spy', 0, 100, 100);
    completeBuilding(ctx.world, 'house', 1, 20, 20);
    const target = ctx.world.city.buildings[ctx.world.city.buildings.length - 1];
    if (!target) throw new Error('no target building');
    ctx.world.peaceful = true;
    for (const kind of ['infiltrateBuilding', 'sabotage', 'stealTech'] as const) {
      const reason = rejectionReason(ctx, kind, {
        unitId: spy.id,
        buildingId: target.id,
        owner: 0,
      });
      expect(reason).toMatch(/peaceful mode/);
    }
  });

  it('the superweapon path is locked out in peaceful worlds', () => {
    const ctx = peacefulSetup();
    // Marshal-only construction (the AI path that bypasses placeBuilding).
    expect(
      rejectionReason(ctx, 'constructSuperweaponFacility', { owner: 0, kind: 'storm' }),
    ).toMatch(/peaceful mode/);
    // Firing gates too — defense in depth on top of the build lockout.
    expect(rejectionReason(ctx, 'fireStorm', { owner: 0, x: 100, z: 100 })).toMatch(
      /peaceful mode/,
    );
    expect(rejectionReason(ctx, 'fireAegis', { owner: 0 })).toMatch(/peaceful mode/);
  });
});

// ---------------------------------------------------------------------------
// Roster pinning
// ---------------------------------------------------------------------------

describe('military def classification (roster pinning)', () => {
  it('classifies every one of the 97 unit defs', () => {
    const kinds = Object.keys(UNIT_DEFS);
    expect(kinds).toHaveLength(97);
    const military = kinds.filter((k) => UNIT_DEFS[k as keyof typeof UNIT_DEFS].military === true);
    expect(military).toHaveLength(71);
    expect(new Set(military)).toEqual(MILITARY_UNITS);
    // The complement is civilian: the flag is absent or explicitly false.
    for (const k of kinds) {
      const def = UNIT_DEFS[k as keyof typeof UNIT_DEFS];
      expect(def.military === true).toBe(MILITARY_UNITS.has(k));
    }
  });

  it('classifies every one of the 100 building defs', () => {
    const kinds = Object.keys(BUILDING_DEFS);
    // Grand-expansion Phase 8 (civilian, workstream E, 2026-09-30): 89 +
    // the 10 new civilian kinds — all military: false, so the military
    // count stays 21.
    // Civilian sea trade (Half A, 2026-10-01; renamed the Civilian
    // Shipyard, 2026-10-01): + the commercialHarbor kind — civilian
    // too, so the military count still stays 21.
    expect(kinds).toHaveLength(100);
    const military = kinds.filter(
      (k) => BUILDING_DEFS[k as keyof typeof BUILDING_DEFS].military === true,
    );
    expect(military).toHaveLength(21);
    expect(new Set(military)).toEqual(MILITARY_BUILDINGS);
    for (const k of kinds) {
      const def = BUILDING_DEFS[k as keyof typeof BUILDING_DEFS];
      expect(def.military === true).toBe(MILITARY_BUILDINGS.has(k));
    }
  });

  it('classifies every one of the 21 upgrade defs', () => {
    const kinds = Object.keys(UPGRADE_DEFS);
    expect(kinds).toHaveLength(21);
    const military = kinds.filter(
      (k) => UPGRADE_DEFS[k as keyof typeof UPGRADE_DEFS].military === true,
    );
    expect(military).toHaveLength(11);
    expect(new Set(military)).toEqual(MILITARY_UPGRADES);
    for (const k of kinds) {
      const def = UPGRADE_DEFS[k as keyof typeof UPGRADE_DEFS];
      expect(def.military === true).toBe(MILITARY_UPGRADES.has(k));
    }
  });
});

// ---------------------------------------------------------------------------
// Conquest bypass
// ---------------------------------------------------------------------------

/** Remove every unit and building belonging to `owner`. */
function eliminate(world: World, owner: number): void {
  world.units = world.units.filter((u) => u.owner !== owner);
  world.city.buildings = world.city.buildings.filter((b) => b.owner !== owner);
}

describe('conquest bypass in peaceful worlds', () => {
  it('a peaceful session still has a rival and civilian starting forces', () => {
    const world = peacefulSessionWorld();
    expect(world.peaceful).toBe(true);
    expect(world.units.some((u) => u.owner === AI_PLAYER_ID)).toBe(true);
    // No rifles: the opening force swapped them for haulers.
    expect(world.units.some((u) => u.kind === 'rifles')).toBe(false);
    expect(world.units.some((u) => u.owner === HUMAN_PLAYER_ID && u.kind === 'hauler')).toBe(
      true,
    );
  });

  it('checkSkirmishVictory is false even with the rival eliminated', () => {
    const world = peacefulSessionWorld();
    eliminate(world, AI_PLAYER_ID);
    expect(checkSkirmishVictory(world)).toBe(false);
  });

  it('checkSkirmishDefeat is false even with the player eliminated', () => {
    const world = peacefulSessionWorld();
    eliminate(world, HUMAN_PLAYER_ID);
    expect(checkSkirmishDefeat(world)).toBe(false);
  });

  it('getSkirmishOutcome is null past the grace period with the rival eliminated', () => {
    const world = peacefulSessionWorld();
    world.tick = CONQUEST_GRACE_TICKS + 1;
    eliminate(world, AI_PLAYER_ID);
    expect(getSkirmishOutcome(world)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Peaceful victory
// ---------------------------------------------------------------------------

/** Set the owner's housed population and treasury directly. */
function setCensus(world: World, owner: number, population: number, funds: number): void {
  const player = getPlayer(world.city, owner);
  if (!player) throw new Error(`no player ${owner}`);
  player.population = population;
  player.funds = funds;
}

describe('peacefulStatus', () => {
  it('reports population and treasury health', () => {
    const world = createWorld(3);
    setCensus(world, 0, 4500, 5000);
    expect(peacefulStatus(world, 0)).toEqual({
      population: 4500,
      treasuryOk: true,
    });
  });

  it('flags a negative treasury without throwing', () => {
    const world = createWorld(3);
    setCensus(world, 0, 9000, -50);
    const s = peacefulStatus(world, 0);
    expect(s.population).toBe(9000);
    expect(s.treasuryOk).toBe(false);
  });

  it('reports zero population for a missing player', () => {
    const world = createWorld(3);
    expect(peacefulStatus(world, 99)).toEqual({
      population: 0,
      treasuryOk: false,
    });
  });

  it('has no victory threshold: past the old 8,000 mark it is still just a status', () => {
    const world = createWorld(3);
    setCensus(world, 0, 12_000, 1_000_000);
    const s = peacefulStatus(world, 0);
    expect(s.population).toBe(12_000);
    expect(s.treasuryOk).toBe(true);
    // No 'achieved' flag, no target — the shape is status-only.
    expect('achieved' in s).toBe(false);
    expect('target' in s).toBe(false);
  });
});

describe('peaceful is endless (no victory condition)', () => {
  it('past the old 8,000 threshold, no victory fires and the sim keeps ticking', () => {
    const session = createSession({ seed: 99, peaceful: true });
    const world = session.world;
    // Push well past the removed 8,000-resident victory threshold.
    setCensus(world, 0, 15_000, 1_000_000);
    setCensus(world, 1, 15_000, 1_000_000);
    // The old victory check is gone; the conquest checks stay bypassed.
    expect(peacefulStatus(world, 0).population).toBeGreaterThan(8000);
    expect(getSkirmishOutcome(world)).toBeNull();
    const tickBefore = world.tick;
    // The sim keeps simulating: advance ticks and confirm the world
    // is still alive and still outcome-less. (The economy recounts
    // housed population from actual residents each tick, so the
    // directly-set census does not survive — that is fine; the point
    // is no victory ever fires.)
    for (let i = 0; i < 300; i++) session.driver.step(world, TICK_MS);
    expect(world.tick).toBeGreaterThan(tickBefore);
    expect(getSkirmishOutcome(world)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('peaceful determinism', () => {
  it('same seed + peaceful ⇒ identical digest across runs', () => {
    const a = createSession({ seed: 99, peaceful: true }).world;
    const b = createSession({ seed: 99, peaceful: true }).world;
    expect(digestWorld(a)).toBe(digestWorld(b));
  });

  it('the flag is digest-covered: peaceful and war digests differ', () => {
    const peaceful = createSession({ seed: 99, peaceful: true }).world;
    const war = createSession({ seed: 99 }).world;
    expect(digestWorld(peaceful)).not.toBe(digestWorld(war));
  });
});

// ---------------------------------------------------------------------------
// Roadmap B1 (2026-10-02): peaceful city score
// ---------------------------------------------------------------------------

/**
 * A minimal building record for score tests — the sim's pure score
 * reads only kind/owner/progress/operational/workers, so the literal
 * stays small (optional fields omitted).
 */
function scoreBuilding(
  id: number,
  kind: 'house' | 'factory' | 'busStop',
  owner: number,
  opts: { workers?: number; operational?: boolean; progress?: number } = {},
): BuildingRecord {
  return {
    id,
    kind,
    owner,
    cx: id * 10,
    cz: 5,
    facing: 0,
    progress: opts.progress ?? 1,
    level: 1,
    operational: opts.operational ?? true,
    powered: true,
    watered: true,
    workers: opts.workers ?? 0,
  };
}

describe('peacefulScore (roadmap B1)', () => {
  it('is population alone when every prosperity component is zero', () => {
    const ctx = peacefulSetup();
    const player = getPlayer(ctx.world.city, 0)!;
    player.population = 500;
    player.funds = 0;
    const s = peacefulScore(ctx.world, 0);
    expect(s.population).toBe(500);
    expect(s.score).toBe(500);
    expect(s.treasury).toBe(0);
    expect(s.employmentRate).toBe(0);
    expect(s.desirabilityRate).toBe(0);
    expect(s.ridershipRate).toBe(0);
  });

  it('scales employment off filled job capacity (completed buildings only)', () => {
    const ctx = peacefulSetup();
    const player = getPlayer(ctx.world.city, 0)!;
    player.population = 1000;
    player.funds = 0;
    // factory has 25 jobs; 10 filled => employment 0.4.
    ctx.world.city.buildings.push(
      scoreBuilding(1, 'factory', 0, { workers: 10 }),
    );
    // An incomplete factory contributes nothing.
    ctx.world.city.buildings.push(
      scoreBuilding(2, 'factory', 0, { workers: 25, progress: 0.5 }),
    );
    const s = peacefulScore(ctx.world, 0);
    expect(s.employmentRate).toBeCloseTo(0.4, 10);
    expect(s.score).toBe(1400); // 1000 × (1 + 0 + 0.4 + 0 + 0)
  });

  it('caps employment at full jobs and counts only the owner', () => {
    const ctx = peacefulSetup();
    const player = getPlayer(ctx.world.city, 0)!;
    player.population = 1000;
    player.funds = 0;
    ctx.world.city.buildings.push(
      scoreBuilding(1, 'factory', 0, { workers: 25 }),
      // Rival buildings never count toward the owner's score.
      scoreBuilding(2, 'factory', 1, { workers: 25 }),
    );
    const s = peacefulScore(ctx.world, 0);
    expect(s.employmentRate).toBe(1);
    expect(s.score).toBe(2000);
  });

  it('scales the treasury off log10 funds and zeroes it when negative', () => {
    const ctx = peacefulSetup();
    const player = getPlayer(ctx.world.city, 0)!;
    player.population = 1000;
    player.funds = 999_000; // log10(1 + 999) / 3 = 1
    const rich = peacefulScore(ctx.world, 0);
    expect(rich.treasury).toBeCloseTo(1, 10);
    expect(rich.score).toBe(2000);
    player.funds = -50;
    const broke = peacefulScore(ctx.world, 0);
    expect(broke.treasury).toBe(0);
    expect(broke.score).toBe(1000);
  });

  it('folds desirability (0..100) and ridership income into the score', () => {
    const ctx = peacefulSetup();
    const player = getPlayer(ctx.world.city, 0)!;
    player.population = 1000;
    player.funds = 0;
    // busStop has ridershipIncome 0.08; 25 of them => 2.0 => rate 1.
    for (let i = 0; i < 25; i++) {
      ctx.world.city.buildings.push(scoreBuilding(100 + i, 'busStop', 0));
    }
    const s = peacefulScore(ctx.world, 0, 60);
    expect(s.ridershipRate).toBe(1);
    expect(s.desirabilityRate).toBe(0.6);
    expect(s.score).toBe(2600); // 1000 × (1 + 0 + 0 + 0.6 + 1)
  });

  it('clamps out-of-range desirability and never throws on a missing player', () => {
    const ctx = peacefulSetup();
    const s = peacefulScore(ctx.world, 0, 140);
    expect(s.desirabilityRate).toBe(1);
    const missing = peacefulScore(ctx.world, 99, -10);
    expect(missing.score).toBe(0);
    expect(missing.desirabilityRate).toBe(0);
  });
});

describe('milestonesReached (roadmap B1)', () => {
  it('counts thresholds at or below the score', () => {
    expect(milestonesReached(0)).toBe(0);
    expect(milestonesReached(999)).toBe(0);
    expect(milestonesReached(1_000)).toBe(1);
    expect(milestonesReached(9_999)).toBe(1);
    expect(milestonesReached(10_000)).toBe(2);
    expect(milestonesReached(50_000)).toBe(3);
    expect(milestonesReached(250_000)).toBe(4);
    expect(milestonesReached(1_000_000)).toBe(5);
    expect(milestonesReached(9_999_999)).toBe(5);
  });

  it('the milestone list has five entries matching the UI names', () => {
    expect(PEACEFUL_MILESTONES).toHaveLength(5);
    expect(PEACEFUL_MILESTONES.map((m) => m.threshold)).toEqual([
      1_000, 10_000, 50_000, 250_000, 1_000_000,
    ]);
  });
});
