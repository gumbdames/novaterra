/**
 * AI siege doctrine (final-review R2-B, 2026-10-01).
 *
 * When the AI has destroyed the visible enemy army, wars used to stall:
 * the attack loop only chased visible units, so a rival with no army
 * but intact buildings could never be finished. The siege doctrine
 * escalates to infrastructure: after N consecutive thinks with no
 * visible enemy units (N scales by difficulty; cadet never sieges),
 * the AI picks the highest-value known enemy building (sticky target)
 * and orders a siege force onto it via the REAL `attackBuilding`
 * command (R2-A, final-review C3 — registered by
 * `registerCombatCommands`), keeping a difficulty-scaled home guard
 * back to defend its base.
 *
 * These tests use R2-A's real command and real combat damage — no
 * stubs. The end-to-end soak verifies the whole chain the review
 * asked for: army destroyed -> siege -> buildings razed ->
 * `checkSkirmishDefeat` fires -> `getSkirmishOutcome` reports defeat.
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
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  MAP_HALF_SIZE,
  placeBuilding,
  cellCoords,
  type BuildingKind,
} from '../src/sim/city';
import { worldToCell } from '../src/sim/pathfinding';
import { findUnit, registerUnitCommands, type UnitKind } from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import {
  createCombatSystem,
  registerCombatCommands,
  damageBuilding,
} from '../src/sim/combat';
import {
  addAIPlayer,
  createAISystem,
  siegeTargetValue,
  siegeGuardCount,
  AI_THINK_TICKS,
  type AIDifficulty,
  type AIPlayerState,
} from '../src/sim/ai';
import { checkSkirmishDefeat, getSkirmishOutcome } from '../src/ui/session';
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
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function setup(seed = 20261001): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  // The AI (owner 1) gets the production buildings it needs to train
  // its own army on top of the scripted siege force.
  completeBuildings(world, 1, ['barracks', 'warFactory', 'airfield']);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  // R2-A's real attackBuilding command (final-review C3).
  registerCombatCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createAISystem(queue),
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

function spawnAt(ctx: Ctx, x: number, z: number, kind: UnitKind = 'rifles', owner = 0): number {
  const land = findLandNear(ctx.terrain, x, z);
  const id = ctx.world.nextId;
  enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind, owner, x: land.x, z: land.z } }]);
  runTicks(ctx, 1);
  expect(findUnit(ctx.world, id)).toBeDefined();
  return id;
}

function buildAt(ctx: Ctx, kind: BuildingKind, x: number, z: number, owner = 0): number {
  const land = findLandNear(ctx.terrain, x, z);
  // Placement.cx/cz are GRID CELLS, not world coords (see scriptCity in
  // sim.ai-soak.test.ts) — convert, or buildingCenterWorld (used by
  // R2-A's attackBuilding chase and fire) aims off-map.
  const { cx, cz } = cellCoords(worldToCell(land.x, land.z));
  const b = placeBuilding(ctx.world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  return b.id;
}

function aiState(ctx: Ctx, owner = 1): AIPlayerState {
  const p = ctx.world.ai.players.find((pl) => pl.owner === owner);
  expect(p).toBeDefined();
  return p as AIPlayerState;
}

function buildingTargetOf(ctx: Ctx, unitId: number): number {
  const u = findUnit(ctx.world, unitId);
  expect(u).toBeDefined();
  return (u as { buildingTargetId?: number }).buildingTargetId ?? 0;
}

/** Run `thinks` full AI thinks for `difficulty`, plus a tick for the orders to apply. */
function runThinks(ctx: Ctx, difficulty: AIDifficulty, thinks: number): void {
  runTicks(ctx, AI_THINK_TICKS[difficulty] * thinks + 2);
}

/** Run `difficulty` thinks until the siege starts (bounded; the citizen's
 * attack-think stagger means the siege may not fire on the exact
 * threshold think). Returns the number of thinks run. */
function runUntilSiege(ctx: Ctx, difficulty: AIDifficulty, maxThinks = 8): number {
  for (let i = 0; i < maxThinks; i++) {
    runThinks(ctx, difficulty, 1);
    if (aiState(ctx).siegeTargetBuildingId !== 0) return i + 1;
  }
  throw new Error(`siege never started for ${difficulty}`);
}

describe('siegeTargetValue', () => {
  it('ranks military above labs above utilities above storage above depots above civilian', () => {
    expect(siegeTargetValue('barracks')).toBe(100);
    expect(siegeTargetValue('lab')).toBe(90);
    expect(siegeTargetValue('powerPlant')).toBe(70);
    expect(siegeTargetValue('waterPump')).toBe(70);
    expect(siegeTargetValue('batteryStation')).toBe(60);
    expect(siegeTargetValue('house')).toBe(10);
    expect(siegeTargetValue('barracks')).toBeGreaterThan(siegeTargetValue('lab'));
    expect(siegeTargetValue('lab')).toBeGreaterThan(siegeTargetValue('powerPlant'));
    expect(siegeTargetValue('powerPlant')).toBeGreaterThan(siegeTargetValue('batteryStation'));
    expect(siegeTargetValue('batteryStation')).toBeGreaterThan(siegeTargetValue('house'));
  });

  it('treats military intel buildings and military depots as military', () => {
    // Every intel building and every depot in the current roster is
    // military:true, so they score 100; the intelOutput 85 and depot
    // 55 tiers stand ready for civilian intel/logistics buildings.
    expect(siegeTargetValue('listeningPost')).toBe(100);
    expect(siegeTargetValue('intelHQ')).toBe(100);
    expect(siegeTargetValue('ordnanceDepot')).toBe(100);
    expect(siegeTargetValue('fuelDepot')).toBe(100);
  });

  it('values every military production building equally', () => {
    for (const kind of ['barracks', 'warFactory', 'airfield', 'navalYard', 'missileSilo'] as BuildingKind[]) {
      expect(siegeTargetValue(kind)).toBe(100);
    }
  });
});

describe('siege quiet counting and difficulty thresholds', () => {
  function siegeScenario(difficulty: AIDifficulty): { ctx: Ctx; barracksId: number; tankIds: number[] } {
    const ctx = setup();
    const aiBase = findLandNear(ctx.terrain, 100, 0);
    addAIPlayer(ctx.world, 1, difficulty, aiBase.x, aiBase.z);
    // Victim base (owner 0): one barracks, no units — the "army
    // destroyed" precondition holds from the first think.
    const barracksId = buildAt(ctx, 'barracks', -112, -4, 0);
    // Scripted siege force parked next to the victim base.
    const tankIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      tankIds.push(spawnAt(ctx, -100 + (i - 2) * 4, 12, 'tank', 1));
    }
    return { ctx, barracksId, tankIds };
  }

  it('marshal sieges after 1 quiet think; citizen needs 3', () => {
    // Marshal (threshold 1): orders go out on the first think.
    {
      const { ctx, barracksId, tankIds } = siegeScenario('marshal');
      runThinks(ctx, 'marshal', 1);
      expect(aiState(ctx).siegeQuietThinks).toBe(1);
      expect(aiState(ctx).siegeTargetBuildingId).toBe(barracksId);
      const sieging = tankIds.filter((id) => buildingTargetOf(ctx, id) === barracksId);
      expect(sieging.length).toBeGreaterThan(0);
    }
    // Citizen (threshold 3): quiet but patient for two thinks, then sieges
    // on its next attack think (personality may stagger attacks).
    {
      const { ctx, barracksId, tankIds } = siegeScenario('citizen');
      runThinks(ctx, 'citizen', 2);
      expect(aiState(ctx).siegeQuietThinks).toBe(2);
      expect(aiState(ctx).siegeTargetBuildingId).toBe(0);
      for (const id of tankIds) expect(buildingTargetOf(ctx, id)).toBe(0);
      const thinks = runUntilSiege(ctx, 'citizen');
      expect(aiState(ctx).siegeQuietThinks).toBeGreaterThanOrEqual(3);
      expect(aiState(ctx).siegeTargetBuildingId).toBe(barracksId);
      const sieging = tankIds.filter((id) => buildingTargetOf(ctx, id) === barracksId);
      expect(sieging.length).toBeGreaterThan(0);
      expect(thinks).toBeLessThanOrEqual(8);
    }
  });

  it('visible enemies reset the quiet counter (no siege while an army stands)', () => {
    const { ctx, tankIds } = siegeScenario('marshal');
    // A surviving victim rifle squad in sight: the enemy army is NOT
    // destroyed. Ten rifles (110 hp each) survive two thinks of tank
    // fire (6 tanks × 2 volleys × 65 dmg ≈ 6 kills), so the quiet
    // counter must stay at zero throughout.
    for (let i = 0; i < 10; i++) {
      spawnAt(ctx, -102 + (i % 5) * 2, -8 - Math.floor(i / 5) * 2, 'rifles', 0);
    }
    runThinks(ctx, 'marshal', 2);
    const survivors = ctx.world.units.filter((u) => u.owner === 0 && u.hp > 0).length;
    expect(survivors).toBeGreaterThan(0);
    expect(aiState(ctx).siegeQuietThinks).toBe(0);
    expect(aiState(ctx).siegeTargetBuildingId).toBe(0);
    for (const id of tankIds) expect(buildingTargetOf(ctx, id)).toBe(0);
  });

  it('cadet never sieges (passive difficulty)', () => {
    const { ctx, tankIds } = siegeScenario('cadet');
    runThinks(ctx, 'cadet', 5);
    expect(aiState(ctx).siegeQuietThinks).toBe(0);
    expect(aiState(ctx).siegeTargetBuildingId).toBe(0);
    for (const id of tankIds) expect(buildingTargetOf(ctx, id)).toBe(0);
  });
});

describe('siege target selection', () => {
  function twoBuildingScenario(difficulty: AIDifficulty): {
    ctx: Ctx;
    barracksId: number;
    houseId: number;
    tankIds: number[];
  } {
    const ctx = setup();
    const aiBase = findLandNear(ctx.terrain, 100, 0);
    addAIPlayer(ctx.world, 1, difficulty, aiBase.x, aiBase.z);
    // Barracks (value 100) far from the tanks; house (value 10) near.
    const barracksId = buildAt(ctx, 'barracks', -112, -4, 0);
    const houseId = buildAt(ctx, 'house', -92, 4, 0);
    const tankIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      tankIds.push(spawnAt(ctx, -100 + (i - 2) * 4, 12, 'tank', 1));
    }
    return { ctx, barracksId, houseId, tankIds };
  }

  it('marshal picks the highest-value building; citizen picks the nearest', () => {
    {
      const { ctx, barracksId, tankIds } = twoBuildingScenario('marshal');
      runThinks(ctx, 'marshal', 1);
      expect(aiState(ctx).siegeTargetBuildingId).toBe(barracksId);
      const sieging = tankIds.filter((id) => buildingTargetOf(ctx, id) === barracksId);
      expect(sieging.length).toBeGreaterThan(0);
    }
    {
      const { ctx, houseId, tankIds } = twoBuildingScenario('citizen');
      runUntilSiege(ctx, 'citizen');
      expect(aiState(ctx).siegeTargetBuildingId).toBe(houseId);
      const sieging = tankIds.filter((id) => buildingTargetOf(ctx, id) === houseId);
      expect(sieging.length).toBeGreaterThan(0);
    }
  });

  it('retargets to the next-best building after the target is destroyed', () => {
    const { ctx, barracksId, houseId, tankIds } = twoBuildingScenario('marshal');
    runThinks(ctx, 'marshal', 1);
    expect(aiState(ctx).siegeTargetBuildingId).toBe(barracksId);
    // Destroy the barracks through the real damage path (R2-A).
    const barracks = ctx.world.city.buildings.find((b) => b.id === barracksId);
    expect(barracks).toBeDefined();
    damageBuilding(ctx.world, barracks as NonNullable<typeof barracks>, 99999);
    expect(ctx.world.city.buildings.find((b) => b.id === barracksId)).toBeUndefined();
    // Next think: the sticky target is gone, so the siege moves on.
    runThinks(ctx, 'marshal', 1);
    expect(aiState(ctx).siegeTargetBuildingId).toBe(houseId);
    const sieging = tankIds.filter((id) => buildingTargetOf(ctx, id) === houseId);
    expect(sieging.length).toBeGreaterThan(0);
  });
});

describe('siege force / home guard split', () => {
  it('siegeGuardCount: difficulty fraction, never more than n-1', () => {
    expect(siegeGuardCount(1, 'marshal')).toBe(0); // lone unit still sieges
    expect(siegeGuardCount(2, 'marshal')).toBe(1);
    expect(siegeGuardCount(6, 'marshal')).toBe(2); // ceil(6*0.2)
    expect(siegeGuardCount(6, 'citizen')).toBe(3); // ceil(6*0.5)
    expect(siegeGuardCount(10, 'commander')).toBe(4); // ceil(10*0.4)
    expect(siegeGuardCount(10, 'general')).toBe(3); // ceil(10*0.3)
  });

  it('marshal keeps 20% home (first ids), sieges with the rest', () => {
    const ctx = setup();
    const aiBase = findLandNear(ctx.terrain, 100, 0);
    addAIPlayer(ctx.world, 1, 'marshal', aiBase.x, aiBase.z);
    const barracksId = buildAt(ctx, 'barracks', -112, -4, 0);
    const tankIds: number[] = [];
    for (let i = 0; i < 6; i++) {
      tankIds.push(spawnAt(ctx, -100 + (i - 2) * 4, 12, 'tank', 1));
    }
    runThinks(ctx, 'marshal', 1);
    // Guard = ceil(7 * 0.2) = 2 (6 scripted + 1 trained), the two
    // lowest ids — both scripted; the other four scripted tanks siege.
    const guardIds = tankIds.slice(0, 2);
    const siegeIds = tankIds.slice(2);
    for (const id of guardIds) expect(buildingTargetOf(ctx, id)).toBe(0);
    for (const id of siegeIds) expect(buildingTargetOf(ctx, id)).toBe(barracksId);
  });
});

describe('siege snapshot round-trip', () => {
  it('siege state survives save/load and resumes deterministically', () => {
    const ctx = setup(4242);
    const aiBase = findLandNear(ctx.terrain, 100, 0);
    addAIPlayer(ctx.world, 1, 'marshal', aiBase.x, aiBase.z);
    const barracksId = buildAt(ctx, 'barracks', -112, -4, 0);
    for (let i = 0; i < 6; i++) spawnAt(ctx, -100 + (i - 2) * 4, 12, 'tank', 1);
    runThinks(ctx, 'marshal', 2);
    const before = aiState(ctx);
    expect(before.siegeQuietThinks).toBe(2);
    expect(before.siegeTargetBuildingId).toBe(barracksId);
    const beforeDigest = digestWorld(ctx.world);

    const snap = takeSnapshot(ctx.world);
    const restoredWorld = restoreSnapshot(snap);
    const after = restoredWorld.ai.players.find((p) => p.owner === 1) as AIPlayerState;
    expect(after.siegeQuietThinks).toBe(2);
    expect(after.siegeTargetBuildingId).toBe(barracksId);
    expect(digestWorld(restoredWorld)).toBe(beforeDigest);
  });
});

describe('end-to-end: the AI finishes a rival whose army is gone', () => {
  /**
   * Marshal (owner 1) vs a passive victim (owner 0): 2 rifles guarding
   * a real base (barracks + warFactory + house + powerPlant). The
   * marshal's scripted tanks kill the rifles through the normal
   * attack-unit path, the quiet counter trips the siege doctrine, and
   * the tanks raze the base through R2-A's real building damage —
   * until `checkSkirmishDefeat` fires for owner 0.
   */
  function soakSetup(seed: number): { ctx: Ctx; victimBuildingIds: number[] } {
    const ctx = setup(seed);
    const aiBase = findLandNear(ctx.terrain, 100, 0);
    addAIPlayer(ctx.world, 1, 'marshal', aiBase.x, aiBase.z);
    // Victim base: military production + a house + power.
    const victimBuildingIds = [
      buildAt(ctx, 'barracks', -112, -4, 0),
      buildAt(ctx, 'warFactory', -104, -10, 0),
      buildAt(ctx, 'house', -92, 4, 0),
      buildAt(ctx, 'powerPlant', -96, -14, 0),
    ];
    // The victim's last army: 2 rifles next to the marshal's tanks.
    spawnAt(ctx, -101, -8, 'rifles', 0);
    spawnAt(ctx, -99, -8, 'rifles', 0);
    // The marshal's expeditionary force, clustered in tank range (19)
    // of every victim building — R2-A's attackBuilding orders a move
    // to the building center (inside the blocked footprint), so the
    // force must already be in firing range; the cross-map chase is
    // R2-A's command behavior, not the doctrine's. Fourteen tanks:
    // the marshal trains to its cap of 48 and the 20% home guard
    // takes the lowest ids, so 14 guarantees scripted tanks remain
    // in the siege force even at cap (14-10=4).
    const spots: Array<readonly [number, number]> = [];
    for (const tz of [-6, -4, -2]) {
      for (const tx of [-105, -103, -101, -99, -97]) {
        spots.push([tx, tz] as const);
      }
    }
    for (let i = 0; i < 14; i++) {
      const [tx, tz] = spots[i] as readonly [number, number];
      spawnAt(ctx, tx, tz, 'tank', 1);
    }
    return { ctx, victimBuildingIds };
  }

  function runSoak(seed: number): {
    ticks: number;
    buildingKills: number;
    siegeObserved: boolean;
    defeat: boolean;
    outcome: unknown;
    digest: number;
  } {
    const { ctx, victimBuildingIds } = soakSetup(seed);
    let siegeObserved = false;
    let ticks = 0;
    const maxTicks = 4000;
    for (; ticks < maxTicks; ticks += 30) {
      runTicks(ctx, 30);
      for (const u of ctx.world.units) {
        if (u.owner === 1 && (u.buildingTargetId ?? 0) !== 0) {
          siegeObserved = true;
          break;
        }
      }
      if (checkSkirmishDefeat(ctx.world)) break;
    }
    const remaining = victimBuildingIds.filter((id) =>
      ctx.world.city.buildings.some((b) => b.id === id),
    ).length;
    const defeat = checkSkirmishDefeat(ctx.world);
    return {
      ticks,
      buildingKills: victimBuildingIds.length - remaining,
      siegeObserved,
      defeat,
      outcome: getSkirmishOutcome(ctx.world),
      digest: digestWorld(ctx.world),
    };
  }

  it('razes the victim base and triggers the defeat path', () => {
    const r = runSoak(777);
    expect(r.siegeObserved).toBe(true);
    expect(r.buildingKills).toBe(4);
    expect(r.defeat).toBe(true);
    expect(r.outcome).toBe('defeat');
    expect(r.ticks).toBeLessThan(4000);
  });

  it('is deterministic: the same seed razes the same way', () => {
    const a = runSoak(777);
    const b = runSoak(777);
    expect(b.digest).toBe(a.digest);
    expect(b.buildingKills).toBe(a.buildingKills);
    expect(b.defeat).toBe(true);
  });
});
