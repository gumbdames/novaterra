/**
 * Roster-expansion feature suite (spec: docs/research/roster-expansion.md).
 *
 * Covers §12's seven new mechanics:
 *  1. Training costs (§5.1)
 *  2. Production-building gating (§5.2)
 *  3. Naval Yard coastal placement (§5.3)
 *  4. Combat-medic heal aura (§5.4)
 *  5. Command auras — HQ + Command Ship (§5.5)
 *  6. Fishing-boat food harvesting (§5.6)
 *  7. Upgrade research command (§4)
 * plus: the 28-unit / 28-building definition tables (§2/§3), age gating (§6),
 * all 12 upgrade effects (§4), snapshot v6 + canonical digest (§9), and
 * determinism of the new systems.
 *
 * Fixture policy: tests that do not exercise the economy/construction use
 * grantAllTrainingResources()/completeBuildings() directly (see
 * sim.roster-fixtures.ts) rather than playing through the economy.
 */
import { describe, it, expect } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
  type NewCommand,
} from '../src/sim/commands';
import {
  UNIT_DEFS,
  UNIT_KINDS,
  registerUnitCommands,
  type UnitKind,
  type UnitRecord,
} from '../src/sim/units';
import {
  BUILDING_DEFS,
  registerCityCommands,
  getPlayer,
  cellIsWater,
  cellIndex,
} from '../src/sim/city';
import { generateTerrain, MERIDIAN_PLAINS, isWater, type TerrainData } from '../src/sim/terrain';
import {
  registerMovementCommands,
  createPathfindingSystem,
  createMovementSystem,
} from '../src/sim/movement';
import {
  registerCombatCommands,
  createCombatSystem,
  damageMultiplier,
  acquireTarget,
} from '../src/sim/combat';
import { registerAgeCommands } from '../src/sim/ages';
import {
  UPGRADE_DEFS,
  UPGRADE_IDS,
  hasUpgrade,
  registerUpgradeCommands,
  effectiveSight,
  effectiveRange,
  effectivePowerSupply,
  effectiveWaterDemand,
  effectiveHealPerSec,
} from '../src/sim/upgrades';
import { runEconomyTick } from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld, canonicalizeWorld } from '../src/sim/digest';
import { createTickDriver } from '../src/sim/tick';
import {
  grantAllTrainingResources,
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

function setup(seed = 20260929): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue);
  registerCityCommands(queue, terrain);
  registerAgeCommands(queue);
  registerUpgradeCommands(queue);
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

/** Funded + built-out test world: training is affordable and production gates pass. */
function setupRich(seed = 20260929): Ctx {
  const ctx = setup(seed);
  grantAllTrainingResources(ctx.world);
  for (const p of ctx.world.city.players) {
    completeBuildings(ctx.world, p.id, [
      'barracks',
      'warFactory',
      'airfield',
      'shipyard',
      'navalYard',
      'lab',
      'hospital',
    ]);
  }
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

function findUnit(world: World, id: number): UnitRecord | undefined {
  return world.units.find((u) => u.id === id);
}

/** Spawn a unit through the command queue; throws if the spawn is rejected. */
function spawnNow(
  ctx: Ctx,
  kind: UnitKind,
  owner: number,
  x: number,
  z: number,
): UnitRecord {
  const id = ctx.world.nextId;
  enq(ctx, 'spawnUnit', { kind, owner, x, z });
  tick(ctx, 1);
  const u = findUnit(ctx.world, id);
  expect(u, `spawn of ${kind} should succeed`).toBeDefined();
  return u!;
}

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

/** A water point with at least a 10-world-unit water margin around it (world coords). */
function findWaterNear(
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
        if (Math.abs(cx) > 240 || Math.abs(cz) > 240) continue;
        // Require a 10-unit water margin so multi-unit sea tests fit.
        let allWater = true;
        for (let oz = -10; oz <= 10 && allWater; oz += 2) {
          for (let ox = -10; ox <= 10; ox += 2) {
            if (!isWater(t, cx + ox, cz + oz)) {
              allWater = false;
              break;
            }
          }
        }
        if (allWater) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no open water near (${x}, ${z})`);
}

/** A land footprint (w×h cells) with NO water-adjacent cell (inland). */
function findInlandFootprint(
  t: TerrainData,
  w: number,
  h: number,
): { cx: number; cz: number } | null {
  for (let cz = 1; cz < 256 - h - 1; cz += 1) {
    for (let cx = 1; cx < 256 - w - 1; cx += 1) {
      let ok = true;
      for (let z = cz - 1; z <= cz + h && ok; z += 1) {
        for (let x = cx - 1; x <= cx + w; x += 1) {
          if (cellIsWater(t, x, z)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) return { cx, cz };
    }
  }
  return null;
}

/** A land footprint (w×h cells) with at least one water-adjacent cell. */
function findCoastalFootprint(
  t: TerrainData,
  w: number,
  h: number,
): { cx: number; cz: number } | null {
  for (let cz = 1; cz < 256 - h - 1; cz += 1) {
    for (let cx = 1; cx < 256 - w - 1; cx += 1) {
      let allLand = true;
      let touchesWater = false;
      for (let z = cz; z < cz + h && allLand; z += 1) {
        for (let x = cx; x < cx + w; x += 1) {
          if (cellIsWater(t, x, z)) {
            allLand = false;
            break;
          }
          if (
            cellIsWater(t, x + 1, z) ||
            cellIsWater(t, x - 1, z) ||
            cellIsWater(t, x, z + 1) ||
            cellIsWater(t, x, z - 1)
          ) {
            touchesWater = true;
          }
        }
      }
      if (allLand && touchesWater) return { cx, cz };
    }
  }
  return null;
}

/** Push a road ring adjacent to a footprint so isRoadAdjacent passes. */
function addRoadRing(ctx: Ctx, cx: number, cz: number, w: number, h: number): void {
  for (let x = cx - 1; x <= cx + w; x += 1) {
    ctx.world.city.roads.push(cellIndex(x, cz - 1), cellIndex(x, cz + h));
  }
  ctx.world.city.roads.sort((a, b) => a - b);
}

describe('roster definitions (§2)', () => {
  it('has exactly the 28 unit kinds from the spec table', () => {
    expect(UNIT_KINDS).toHaveLength(28);
    const expected = [
      'engineer', 'rifles', 'spectre', 'sniperTeam', 'combatMedic',
      'tank', 'apc', 'tankDestroyer', 'artillery', 'mlrs', 'aa',
      'drone', 'transport', 'fighter', 'fighterBomber', 'attackHeli', 'awacs',
      'patrolBoat', 'transportShip', 'missileBoat', 'destroyer', 'frigate',
      'submarine', 'carrier', 'commandShip', 'fishingBoat',
      'hq', 'hauler',
    ];
    expect([...UNIT_KINDS].sort()).toEqual([...expected].sort());
  });

  it('defines the new land units with their exact spec stat blocks', () => {
    expect(UNIT_DEFS.sniperTeam).toMatchObject({
      hp: 90, speed: 8, armor: 'light', damage: 45, range: 30, cooldownTicks: 70,
      targets: 'ground', vsLight: 1.6, vsMedium: 0.8, vsHeavy: 0.4,
      sight: 36, minAge: 'connectivity', manpowerCost: 3,
      trainFunds: 200, trainMaterials: 20, requiredBuilding: 'barracks',
    });
    expect(UNIT_DEFS.combatMedic).toMatchObject({
      hp: 100, speed: 9, armor: 'light', damage: 0, sight: 20,
      minAge: 'connectivity', manpowerCost: 2, trainFunds: 150,
      trainMaterials: 10, requiredBuilding: 'barracks',
      healRadius: 12, healPerSec: 2,
    });
    expect(UNIT_DEFS.apc).toMatchObject({
      hp: 320, speed: 12, armor: 'medium', damage: 14, range: 16,
      cooldownTicks: 25, targets: 'ground', vsLight: 1.3, vsMedium: 0.8,
      vsHeavy: 0.5, sight: 24, minAge: 'connectivity', manpowerCost: 4,
      trainFunds: 250, trainMaterials: 40, requiredBuilding: 'warFactory',
    });
    expect(UNIT_DEFS.tankDestroyer).toMatchObject({
      hp: 380, speed: 9, armor: 'medium', damage: 70, range: 24,
      cooldownTicks: 60, targets: 'ground', vsLight: 0.6, vsMedium: 1.2,
      vsHeavy: 1.8, sight: 26, minAge: 'industry', manpowerCost: 5,
      trainFunds: 500, trainMaterials: 90, requiredBuilding: 'warFactory',
    });
    expect(UNIT_DEFS.mlrs).toMatchObject({
      hp: 180, speed: 7, armor: 'medium', damage: 140, range: 40,
      minRange: 14, cooldownTicks: 160, targets: 'ground', vsLight: 1.6,
      vsMedium: 1.2, vsHeavy: 1.2, sight: 28, minAge: 'industry',
      manpowerCost: 5, trainFunds: 600, trainMaterials: 120,
      requiredBuilding: 'warFactory',
    });
  });

  it('defines the new air units with their exact spec stat blocks', () => {
    expect(UNIT_DEFS.fighterBomber).toMatchObject({
      hp: 200, speed: 28, armor: 'medium', damage: 120, range: 20,
      cooldownTicks: 90, targets: 'ground', vsLight: 0.8, vsMedium: 1.0,
      vsHeavy: 1.6, sight: 32, minAge: 'industry', manpowerCost: 4,
      trainFunds: 1000, trainMaterials: 150, requiredBuilding: 'airfield',
    });
    expect(UNIT_DEFS.attackHeli).toMatchObject({
      hp: 150, speed: 30, armor: 'light', damage: 60, range: 22,
      cooldownTicks: 55, targets: 'ground', vsLight: 0.9, vsMedium: 1.1,
      vsHeavy: 1.5, sight: 30, minAge: 'connectivity', manpowerCost: 4,
      trainFunds: 700, trainMaterials: 100, requiredBuilding: 'airfield',
    });
    expect(UNIT_DEFS.awacs).toMatchObject({
      hp: 180, speed: 24, armor: 'light', damage: 0, sight: 65,
      minAge: 'information', manpowerCost: 3, trainFunds: 900,
      trainMaterials: 120, requiredBuilding: 'airfield',
    });
  });

  it('defines the new sea units with their exact spec stat blocks', () => {
    expect(UNIT_DEFS.missileBoat).toMatchObject({
      hp: 180, speed: 18, armor: 'light', damage: 70, range: 22,
      cooldownTicks: 70, targets: 'sea', vsLight: 1.0, vsMedium: 1.1,
      vsHeavy: 1.5, sight: 28, minAge: 'connectivity', manpowerCost: 4,
      trainFunds: 500, trainMaterials: 120, requiredBuilding: 'shipyard',
    });
    expect(UNIT_DEFS.frigate).toMatchObject({
      hp: 420, speed: 13, armor: 'medium', damage: 30, range: 24,
      cooldownTicks: 35, targets: 'seaAir', vsLight: 1.2, vsMedium: 1.6,
      vsHeavy: 0.8, vsAir: 1.2, sight: 32, minAge: 'industry',
      manpowerCost: 5, trainFunds: 900, trainMaterials: 220,
      requiredBuilding: 'navalYard',
    });
    expect(UNIT_DEFS.submarine).toMatchObject({
      hp: 300, speed: 10, armor: 'medium', damage: 90, range: 30,
      cooldownTicks: 80, targets: 'sea', vsLight: 0.8, vsMedium: 1.5,
      vsHeavy: 2.0, sight: 26, minAge: 'industry', manpowerCost: 6,
      trainFunds: 1200, trainMaterials: 300, requiredBuilding: 'navalYard',
    });
    expect(UNIT_DEFS.carrier).toMatchObject({
      hp: 900, speed: 8, armor: 'heavy', damage: 40, range: 30,
      cooldownTicks: 45, targets: 'seaAir', vsLight: 1.2, vsMedium: 1.0,
      vsHeavy: 0.9, vsAir: 2.0, sight: 36, minAge: 'information',
      manpowerCost: 10, trainFunds: 3500, trainMaterials: 1000,
      requiredBuilding: 'navalYard',
    });
    expect(UNIT_DEFS.commandShip).toMatchObject({
      hp: 700, speed: 9, armor: 'heavy', damage: 20, range: 18,
      cooldownTicks: 40, targets: 'sea', vsLight: 1.0, vsMedium: 1.0,
      vsHeavy: 1.0, sight: 40, minAge: 'information', manpowerCost: 6,
      trainFunds: 2000, trainMaterials: 500, requiredBuilding: 'navalYard',
      auraRadius: 24, auraBonus: 0.25,
    });
    expect(UNIT_DEFS.fishingBoat).toMatchObject({
      hp: 120, speed: 12, armor: 'light', damage: 0, sight: 18,
      minAge: 'foundation', manpowerCost: 0, trainFunds: 150,
      trainMaterials: 30, harvest: { food: 0.6 },
    });
    // No production building gates the civilian fishing boat (spec §5.2).
    expect(UNIT_DEFS.fishingBoat.requiredBuilding).toBeUndefined();
  });

  it('leaves existing unit stats at their spec-table values', () => {
    expect(UNIT_DEFS.tank).toMatchObject({
      hp: 500, speed: 10, armor: 'heavy', damage: 50, range: 19,
      minRange: 0, cooldownTicks: 50, targets: 'ground', vsLight: 1.3,
      vsMedium: 1.0, vsHeavy: 0.9, vsAir: 1.0, sight: 26,
      minAge: 'foundation', manpowerCost: 5, trainFunds: 400,
      trainMaterials: 60, requiredBuilding: 'warFactory',
    });
    expect(UNIT_DEFS.rifles).toMatchObject({
      hp: 110, speed: 9, armor: 'light', damage: 9, range: 15,
      minAge: 'foundation', manpowerCost: 2, trainFunds: 60,
    });
    expect(UNIT_DEFS.artillery).toMatchObject({
      hp: 160, damage: 95, range: 48, minRange: 12, minAge: 'foundation',
      trainFunds: 450, trainMaterials: 80, requiredBuilding: 'warFactory',
    });
    expect(UNIT_DEFS.hq.auraRadius).toBe(20);
    expect(UNIT_DEFS.hq.auraBonus).toBe(0.25);
    expect(UNIT_DEFS.destroyer).toMatchObject({
      minAge: 'industry', requiredBuilding: 'navalYard',
    });
    // The §5.2 basic-unit exception: no production-building requirement.
    for (const kind of ['engineer', 'rifles', 'hauler', 'drone', 'transport',
      'patrolBoat', 'transportShip', 'fishingBoat'] as UnitKind[]) {
      expect(UNIT_DEFS[kind].requiredBuilding,
        `${kind} should have no production-building requirement`).toBeUndefined();
    }
  });
});

describe('building definitions (§3)', () => {
  it('has all 16 new buildings with exact spec costs', () => {
    expect(Object.keys(BUILDING_DEFS)).toHaveLength(28);
    expect(BUILDING_DEFS.barracks).toMatchObject({
      costFunds: 700, costMaterials: 250, buildSeconds: 40, minAge: 'foundation',
    });
    expect(BUILDING_DEFS.warFactory).toMatchObject({
      costFunds: 1100, costMaterials: 450, buildSeconds: 60, minAge: 'foundation',
    });
    expect(BUILDING_DEFS.navalYard).toMatchObject({
      costFunds: 1800, costMaterials: 700, buildSeconds: 80, minAge: 'industry',
    });
    expect(BUILDING_DEFS.monument).toMatchObject({
      costFunds: 3000, costMaterials: 1200, buildSeconds: 90, minAge: 'information',
    });
    expect(BUILDING_DEFS.hospital).toMatchObject({ minAge: 'connectivity' });
    expect(BUILDING_DEFS.university).toMatchObject({ minAge: 'connectivity' });
    expect(BUILDING_DEFS.nuclearPlant).toMatchObject({ minAge: 'industry' });
  });

  it('keeps existing building defs (superweapons stay ascendance-gated)', () => {
    expect(BUILDING_DEFS.house.costFunds).toBe(120);
    expect(BUILDING_DEFS.aegisControl.minAge).toBe('ascendance');
    expect(BUILDING_DEFS.stormArray.minAge).toBe('ascendance');
  });

  it('age-gates placeBuilding (airfield needs connectivity)', () => {
    const ctx = setupRich();
    const p = { kind: 'airfield', owner: 0, cx: 0, cz: 0, facing: 0 };
    ctx.world.ages.age = 'foundation';
    expect(rejectionReason(ctx, 'placeBuilding', p)).toMatch(/connectivity/i);
    ctx.world.ages.age = 'connectivity';
    // The exact placement may fail on terrain/roads; the age gate passed.
    expect(rejectionReason(ctx, 'placeBuilding', p)).not.toMatch(/connectivity/i);
  });
});

describe('training costs — mechanic 1 (§5.1)', () => {
  it('deducts funds, materials, and manpower on spawn', () => {
    const ctx = setupRich();
    const player = getPlayer(ctx.world.city, 0)!;
    const fundsBefore = player.funds;
    const matsBefore = player.materials;
    const mpBefore = player.manpower;
    const at = findLandNear(ctx.terrain, 0, 0);
    spawnNow(ctx, 'tank', 0, at.x, at.z);
    expect(player.funds).toBe(fundsBefore - 400);
    expect(player.materials).toBe(matsBefore - 60);
    expect(player.manpower).toBe(mpBefore - 5);
  });

  it('rejects enqueue when funds are insufficient', () => {
    const ctx = setupRich();
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 10;
    const at = findLandNear(ctx.terrain, 0, 0);
    expect(
      rejectionReason(ctx, 'spawnUnit', { kind: 'tank', owner: 0, x: at.x, z: at.z }),
    ).toMatch(/cannot afford/i);
  });

  it('rejects at apply when resources drained between enqueue and tick', () => {
    const ctx = setupRich();
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 400;
    player.materials = 60;
    const at = findLandNear(ctx.terrain, 0, 0);
    const id = ctx.world.nextId;
    enq(ctx, 'spawnUnit', { kind: 'tank', owner: 0, x: at.x, z: at.z });
    // Stale state: someone else spent the funds before the tick applied.
    player.funds = 0;
    expect(() => tick(ctx, 1)).toThrow(CommandRejectedError);
    expect(findUnit(ctx.world, id)).toBeUndefined();
    expect(player.manpower).toBe(10000);
  });
});

describe('production gating — mechanic 2 (§5.2)', () => {
  it('rejects units whose production building is missing', () => {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    ctx.world.ages.age = 'connectivity';
    const at = findLandNear(ctx.terrain, 0, 0);
    expect(
      rejectionReason(ctx, 'spawnUnit', { kind: 'tank', owner: 0, x: at.x, z: at.z }),
    ).toMatch(/requires a completed War Factory/);
    expect(
      rejectionReason(ctx, 'spawnUnit', { kind: 'sniperTeam', owner: 0, x: at.x, z: at.z }),
    ).toMatch(/requires a completed Barracks/);
  });

  it('spawns gated units once the building is complete', () => {
    const ctx = setupRich();
    ctx.world.ages.age = 'connectivity';
    const at = findLandNear(ctx.terrain, 0, 0);
    const u = spawnNow(ctx, 'sniperTeam', 0, at.x, at.z);
    expect(u.kind).toBe('sniperTeam');
  });

  it('exempts basic units from the production-building requirement', () => {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    const at = findLandNear(ctx.terrain, 0, 0);
    for (const kind of ['engineer', 'rifles', 'hauler', 'drone', 'transport'] as UnitKind[]) {
      expect(
        rejectionReason(ctx, 'spawnUnit', { kind, owner: 0, x: at.x, z: at.z }),
      ).toBeNull();
      tick(ctx, 1);
    }
    // Fishing boat (foundation age) likewise needs no shipyard.
    const w = findWaterNear(ctx.terrain, 0, 0);
    expect(
      rejectionReason(ctx, 'spawnUnit', { kind: 'fishingBoat', owner: 0, x: w.x, z: w.z }),
    ).toBeNull();
  });

  it('gates the naval lineup behind the naval yard, not the shipyard', () => {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    ctx.world.ages.age = 'industry';
    completeBuildings(ctx.world, 0, ['shipyard']);
    const w = findWaterNear(ctx.terrain, 0, 0);
    expect(
      rejectionReason(ctx, 'spawnUnit', { kind: 'destroyer', owner: 0, x: w.x, z: w.z }),
    ).toMatch(/requires a completed Naval Yard/);
    // But the shipyard alone unlocks the missile boat.
    ctx.world.ages.age = 'connectivity';
    const mb = spawnNow(ctx, 'missileBoat', 0, w.x, w.z);
    expect(mb.kind).toBe('missileBoat');
  });
});

describe('naval yard coastal placement — mechanic 3 (§5.3)', () => {
  it('rejects a naval yard with no water-adjacent footprint cell', () => {
    const ctx = setupRich();
    ctx.world.ages.age = 'industry';
    const spot = findInlandFootprint(ctx.terrain, 5, 4);
    expect(spot, 'expected an inland 5x4 footprint on the test map').not.toBeNull();
    addRoadRing(ctx, spot!.cx, spot!.cz, 5, 4);
    expect(
      rejectionReason(ctx, 'placeBuilding', {
        kind: 'navalYard', owner: 0, cx: spot!.cx, cz: spot!.cz, facing: 0,
      }),
    ).toMatch(/coast/i);
  });

  it('places a naval yard on the coast', () => {
    const ctx = setupRich();
    ctx.world.ages.age = 'industry';
    const spot = findCoastalFootprint(ctx.terrain, 5, 4);
    expect(spot, 'expected a coastal 5x4 footprint on the test map').not.toBeNull();
    addRoadRing(ctx, spot!.cx, spot!.cz, 5, 4);
    const reason = rejectionReason(ctx, 'placeBuilding', {
      kind: 'navalYard', owner: 0, cx: spot!.cx, cz: spot!.cz, facing: 0,
    });
    expect(reason).toBeNull();
    tick(ctx, 1);
    const b = ctx.world.city.buildings.find((b) => b.kind === 'navalYard');
    expect(b).toBeDefined();
  });
});

describe('combat-medic heal aura — mechanic 4 (§5.4)', () => {
  function medicSetup(withFieldMedicine: boolean): { ctx: Ctx; medic: UnitRecord; patient: UnitRecord } {
    const ctx = setupRich();
    ctx.world.ages.age = 'connectivity';
    const at = findLandNear(ctx.terrain, 0, 0);
    const medic = spawnNow(ctx, 'combatMedic', 0, at.x, at.z);
    const patient = spawnNow(ctx, 'rifles', 0, at.x + 5, at.z);
    patient.hp = 60;
    if (withFieldMedicine) ctx.world.upgrades[0] = ['fieldMedicine'];
    return { ctx, medic, patient };
  }

  it('heals friendly land units at 2 HP/s, capped at max HP', () => {
    const { ctx, patient } = medicSetup(false);
    expect(effectiveHealPerSec(ctx.world, 0, UNIT_DEFS.combatMedic)).toBe(2);
    tick(ctx, 10); // 1 second
    expect(patient.hp).toBeCloseTo(62, 6);
    tick(ctx, 600); // 60 seconds
    expect(patient.hp).toBe(110); // rifles max HP, not above
    expect(patient.hp).toBeLessThanOrEqual(UNIT_DEFS.rifles.hp);
  });

  it('heals at 4 HP/s with Field Medicine', () => {
    const { ctx, patient } = medicSetup(true);
    expect(effectiveHealPerSec(ctx.world, 0, UNIT_DEFS.combatMedic)).toBe(4);
    tick(ctx, 10);
    expect(patient.hp).toBeCloseTo(64, 6);
  });

  it('does not heal sea/air units, enemies, or the dead', () => {
    const { ctx, medic } = medicSetup(false);
    const at = { x: medic.x, z: medic.z };
    const drone = spawnNow(ctx, 'drone', 0, at.x + 5, at.z + 2);
    drone.hp = 10;
    // An enemy medic (damage 0) cannot confound the test with its own fire;
    // at full hp its own aura has nothing to heal. It sits 12 from our medic
    // (inside the heal radius) but 17 from the rifles patient, outside its
    // 15-unit weapon range, so nobody shoots anybody.
    const enemyMedic = spawnNow(ctx, 'combatMedic', 1, at.x - 12, at.z);
    const fullHp = enemyMedic.hp;
    const corpse = spawnNow(ctx, 'rifles', 0, at.x + 3, at.z - 4);
    corpse.hp = 0;
    tick(ctx, 10);
    expect(drone.hp).toBe(10);
    expect(enemyMedic.hp).toBe(fullHp);
    expect(corpse.hp).toBe(0);
  });
});

describe('command auras — mechanic 5 (§5.5)', () => {
  // Note: the combat system caches aura sources per (world, tick), so each
  // scenario below builds a fresh world — mutating positions mid-tick would
  // read a stale cache.
  function auraWorld(hqPos: { x: number; z: number } | null): {
    world: World;
    land: UnitRecord;
    target: UnitRecord;
  } {
    const world = createWorld(1);
    const land = {
      id: 1, kind: 'rifles', owner: 0, x: 0, z: 0, hp: 110, domain: 'land',
    } as UnitRecord;
    const target = {
      id: 3, kind: 'rifles', owner: 1, x: 1, z: 0, hp: 110, domain: 'land',
    } as UnitRecord;
    world.units.push(land, target);
    if (hqPos) {
      world.units.push({
        id: 4, kind: 'hq', owner: 0, x: hqPos.x, z: hqPos.z, hp: 400, domain: 'land',
      } as UnitRecord);
    }
    return { world, land, target };
  }

  it('HQ grants +25% to friendly non-HQ attackers within 20', () => {
    const { world, land, target } = auraWorld({ x: 10, z: 0 });
    // Rifles vs rifles (light): 1.0 base → 1.25 with the aura.
    expect(damageMultiplier(world, land, UNIT_DEFS.rifles, target)).toBeCloseTo(1.25, 9);
  });

  it('HQ does not buff itself, the dead, enemies, or out-of-range units', () => {
    const { world, land, target } = auraWorld({ x: 10, z: 0 });
    const hq = world.units.find((u) => u.kind === 'hq')!;
    // The HQ itself is excluded from its own aura.
    expect(damageMultiplier(world, hq, UNIT_DEFS.hq, target)).toBeCloseTo(1, 9);

    // Out of range: no aura.
    const far = auraWorld({ x: 30, z: 0 });
    expect(damageMultiplier(far.world, far.land, UNIT_DEFS.rifles, far.target)).toBeCloseTo(1, 9);

    // No HQ at all: no aura.
    const none = auraWorld(null);
    expect(damageMultiplier(none.world, none.land, UNIT_DEFS.rifles, none.target)).toBeCloseTo(1, 9);
  });

  it('Command Ship grants +25% to sea attackers within 24, not land', () => {
    const world = createWorld(1);
    const sea = {
      id: 2, kind: 'destroyer', owner: 0, x: 0, z: 0, hp: 600, domain: 'sea',
    } as UnitRecord;
    const land = {
      id: 1, kind: 'rifles', owner: 0, x: 0, z: 0, hp: 110, domain: 'land',
    } as UnitRecord;
    const cs = {
      id: 5, kind: 'commandShip', owner: 0, x: 10, z: 0, hp: 700, domain: 'sea',
    } as UnitRecord;
    const seaTarget = {
      id: 6, kind: 'destroyer', owner: 1, x: 1, z: 0, hp: 600, domain: 'sea',
    } as UnitRecord;
    const landTarget = {
      id: 7, kind: 'tank', owner: 1, x: 1, z: 1, hp: 500, domain: 'land',
    } as UnitRecord;
    world.units.push(sea, land, cs, seaTarget, landTarget);
    // Destroyer vs destroyer (heavy): 1.0 base → 1.25 with the aura.
    expect(damageMultiplier(world, sea, UNIT_DEFS.destroyer, seaTarget)).toBeCloseTo(1.25, 9);
    // A land attacker next to the command ship gets nothing:
    // rifles vs tank (heavy) stays at the base 0.3.
    expect(damageMultiplier(world, land, UNIT_DEFS.rifles, landTarget)).toBeCloseTo(0.3, 9);
  });

  it('auras do not stack and ignore dead/enemy sources', () => {
    const { world, land, target } = auraWorld({ x: 10, z: 0 });
    const hq2 = { id: 5, kind: 'hq', owner: 0, x: -10, z: 0, hp: 400, domain: 'land' } as UnitRecord;
    const enemyHq = { id: 6, kind: 'hq', owner: 1, x: 5, z: 0, hp: 400, domain: 'land' } as UnitRecord;
    const deadHq = { id: 7, kind: 'hq', owner: 0, x: 3, z: 0, hp: 0, domain: 'land' } as UnitRecord;
    world.units.push(hq2, enemyHq, deadHq);
    // Still a single +25% — auras never stack.
    expect(damageMultiplier(world, land, UNIT_DEFS.rifles, target)).toBeCloseTo(1.25, 9);
  });
});

describe('fishing-boat harvest — mechanic 6 (§5.6)', () => {
  it('adds +0.6 food/s per living fishing boat', () => {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    const w = findWaterNear(ctx.terrain, 0, 0);
    const boat = spawnNow(ctx, 'fishingBoat', 0, w.x, w.z);
    const player = getPlayer(ctx.world.city, 0)!;
    const before = player.food;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(player.food - before).toBeCloseTo(0.6, 9);
    // A sunk boat harvests nothing.
    boat.hp = 0;
    const before2 = player.food;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(player.food - before2).toBeCloseTo(0, 9);
  });
});

describe('upgrade research command — mechanic 7 (§4)', () => {
  function researchSetup(): Ctx {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    completeBuildings(ctx.world, 0, ['lab']);
    ctx.world.ages.age = 'industry';
    return ctx;
  }

  function fundResearch(ctx: Ctx): void {
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 100000;
    player.research = 100000;
  }

  it('rejects without a completed lab', () => {
    const ctx = setup();
    grantAllTrainingResources(ctx.world);
    ctx.world.ages.age = 'industry';
    fundResearch(ctx);
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'engineTuning' }),
    ).toMatch(/requires a completed Research Lab/);
  });

  it('rejects when the prerequisite building is missing', () => {
    const ctx = researchSetup();
    fundResearch(ctx);
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'apRounds' }),
    ).toMatch(/requires a completed War Factory/);
  });

  it('rejects when the minimum age is not met', () => {
    const ctx = researchSetup();
    fundResearch(ctx);
    completeBuildings(ctx.world, 0, ['warFactory']);
    ctx.world.ages.age = 'connectivity';
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'apRounds' }),
    ).toMatch(/requires the industry age/);
  });

  it('rejects when funds or research are insufficient', () => {
    const ctx = researchSetup();
    completeBuildings(ctx.world, 0, ['warFactory']);
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 10;
    player.research = 1000;
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'apRounds' }),
    ).toMatch(/cannot afford/);
  });

  it('deducts costs and records the upgrade', () => {
    const ctx = researchSetup();
    completeBuildings(ctx.world, 0, ['warFactory']);
    const player = getPlayer(ctx.world.city, 0)!;
    player.funds = 5000;
    player.research = 500;
    enq(ctx, 'researchUpgrade', { owner: 0, upgrade: 'apRounds' });
    tick(ctx, 1);
    expect(player.funds).toBe(5000 - 800);
    expect(player.research).toBe(500 - 60);
    expect(hasUpgrade(ctx.world, 0, 'apRounds')).toBe(true);
    expect(ctx.world.upgrades[0]).toEqual(['apRounds']);
  });

  it('rejects duplicates and unknown ids', () => {
    const ctx = researchSetup();
    fundResearch(ctx);
    enq(ctx, 'researchUpgrade', { owner: 0, upgrade: 'engineTuning' });
    tick(ctx, 1);
    expect(hasUpgrade(ctx.world, 0, 'engineTuning')).toBe(true);
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'engineTuning' }),
    ).toMatch(/already researched/);
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'timeTravel' }),
    ).toMatch(/must be one of/);
  });

  it('enforces upgrade prerequisite chains (fieldMedicine needs hospital + barracks)', () => {
    const ctx = researchSetup();
    fundResearch(ctx);
    ctx.world.ages.age = 'connectivity';
    expect(
      rejectionReason(ctx, 'researchUpgrade', { owner: 0, upgrade: 'fieldMedicine' }),
    ).toMatch(/requires a completed Hospital/);
    completeBuildings(ctx.world, 0, ['hospital', 'barracks']);
    const reason = rejectionReason(ctx, 'researchUpgrade', {
      owner: 0, upgrade: 'fieldMedicine',
    });
    expect(reason).toBeNull();
  });
});

describe('upgrade effects (§4)', () => {
  it('defines all 12 upgrades with spec costs, ages, and prerequisites', () => {
    expect(UPGRADE_IDS).toHaveLength(12);
    expect(UPGRADE_DEFS.apRounds).toMatchObject({
      costFunds: 800, costResearch: 60, minAge: 'industry',
      requiredBuildings: ['warFactory'],
    });
    expect(UPGRADE_DEFS.advancedAvionics.requiredBuildings).toEqual([
      'airfield',
      'radarStation',
    ]);
    expect(UPGRADE_DEFS.engineTuning).toMatchObject({
      costFunds: 600, costResearch: 40, minAge: 'connectivity',
    });
    expect(UPGRADE_DEFS.cruiseMissiles.minAge).toBe('information');
    expect(UPGRADE_DEFS.freeTrade.minAge).toBe('information');
    expect(UPGRADE_DEFS.verticalFarming.minAge).toBe('industry');
  });

  it('AP Rounds: +40% vsHeavy for tank/TD/apc', () => {
    const world = createWorld(1);
    const tank = { id: 1, kind: 'tank', owner: 0, x: 0, z: 0, hp: 500, domain: 'land' } as UnitRecord;
    const target = { id: 2, kind: 'tank', owner: 1, x: 1, z: 0, hp: 500, domain: 'land' } as UnitRecord;
    world.units.push(tank, target);
    expect(damageMultiplier(world, tank, UNIT_DEFS.tank, target)).toBeCloseTo(0.9, 9);
    world.upgrades[0] = ['apRounds'];
    expect(damageMultiplier(world, tank, UNIT_DEFS.tank, target)).toBeCloseTo(0.9 * 1.4, 9);
    // Not every unit gets it: rifles stay at their base vsHeavy.
    const rifles = { id: 3, kind: 'rifles', owner: 0, x: 0, z: 0, hp: 110, domain: 'land' } as UnitRecord;
    world.units.push(rifles);
    expect(damageMultiplier(world, rifles, UNIT_DEFS.rifles, target)).toBeCloseTo(0.3, 9);
  });

  it('Composite Armor: +30% spawn HP', () => {
    const ctx = setupRich();
    const at = findLandNear(ctx.terrain, 0, 0);
    const plain = spawnNow(ctx, 'tank', 0, at.x, at.z);
    expect(plain.hp).toBe(500);
    ctx.world.upgrades[0] = ['compositeArmor'];
    const armored = spawnNow(ctx, 'tank', 0, at.x + 5, at.z);
    expect(armored.hp).toBe(650);
  });

  it('Engine Tuning: +25% speed', () => {
    const ctx = setupRich();
    const at = findLandNear(ctx.terrain, 0, 0);
    const plain = spawnNow(ctx, 'tank', 0, at.x, at.z);
    expect(plain.speed).toBe(10);
    ctx.world.upgrades[0] = ['engineTuning'];
    const tuned = spawnNow(ctx, 'tank', 0, at.x + 5, at.z);
    expect(tuned.speed).toBe(12.5);
  });

  it('Advanced Avionics: +25% fighter sight, +20% vsAir, awacs +15 sight', () => {
    const ctx = setupRich();
    ctx.world.ages.age = 'information';
    const at = findLandNear(ctx.terrain, 0, 0);
    const fighter = spawnNow(ctx, 'fighter', 0, at.x, at.z);
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.fighter)).toBe(40);
    const awacs = spawnNow(ctx, 'awacs', 0, at.x + 5, at.z);
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.awacs)).toBe(65);
    ctx.world.upgrades[0] = ['advancedAvionics'];
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.fighter)).toBe(50);
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.awacs)).toBe(80);
    const target = { id: 999, kind: 'fighter', owner: 1, x: 1, z: 0, hp: 170, domain: 'air' } as UnitRecord;
    ctx.world.units.push(target);
    // Fighter vs fighter (air): vsAir 1.6 → 1.6 * 1.2 with the upgrade.
    expect(damageMultiplier(ctx.world, fighter, UNIT_DEFS.fighter, target)).toBeCloseTo(1.92, 9);
  });

  it('Sonar Suite: frigate +30% vsMedium, sea units +8 sight', () => {
    const ctx = setupRich();
    ctx.world.ages.age = 'industry';
    const w = findWaterNear(ctx.terrain, 0, 0);
    const frigate = spawnNow(ctx, 'frigate', 0, w.x, w.z);
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.frigate)).toBe(32);
    const sub = spawnNow(ctx, 'submarine', 1, w.x + 8, w.z);
    expect(damageMultiplier(ctx.world, frigate, UNIT_DEFS.frigate, sub)).toBeCloseTo(1.6, 9);
    ctx.world.upgrades[0] = ['sonarSuite'];
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.frigate)).toBe(40);
    expect(damageMultiplier(ctx.world, frigate, UNIT_DEFS.frigate, sub)).toBeCloseTo(1.6 * 1.3, 9);
  });

  it('Cruise Missiles: mlrs 40→50 and artillery 48→56 range', () => {
    const world = createWorld(1);
    expect(effectiveRange(world, 0, UNIT_DEFS.mlrs)).toBe(40);
    world.upgrades[0] = ['cruiseMissiles'];
    expect(effectiveRange(world, 0, UNIT_DEFS.mlrs)).toBe(50);
    expect(effectiveRange(world, 0, UNIT_DEFS.artillery)).toBe(56);
  });

  it('Cruise Missiles let artillery acquire targets beyond base range', () => {
    const world = createWorld(1);
    const arty = { id: 1, kind: 'artillery', owner: 0, x: 0, z: 0, hp: 160, domain: 'land' } as UnitRecord;
    const enemy = { id: 2, kind: 'tank', owner: 1, x: 52, z: 0, hp: 500, domain: 'land' } as UnitRecord;
    world.units.push(arty, enemy);
    expect(acquireTarget(world, arty, UNIT_DEFS.artillery)).toBeUndefined();
    world.upgrades[0] = ['cruiseMissiles'];
    expect(acquireTarget(world, arty, UNIT_DEFS.artillery)?.id).toBe(2);
  });

  it('Drone Optics: drone 26→41 and spectre 24→34 sight', () => {
    const ctx = setupRich();
    const at = findLandNear(ctx.terrain, 0, 0);
    const drone = spawnNow(ctx, 'drone', 0, at.x, at.z);
    const spectre = spawnNow(ctx, 'spectre', 0, at.x + 5, at.z);
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.drone)).toBe(26);
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.spectre)).toBe(24);
    ctx.world.upgrades[0] = ['droneOptics'];
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.drone)).toBe(41);
    expect(effectiveSight(ctx.world, 0, UNIT_DEFS.spectre)).toBe(34);
  });

  it('Field Medicine: +20 HP to rifles at spawn', () => {
    const ctx = setupRich();
    const at = findLandNear(ctx.terrain, 0, 0);
    const plain = spawnNow(ctx, 'rifles', 0, at.x, at.z);
    expect(plain.hp).toBe(110);
    ctx.world.upgrades[0] = ['fieldMedicine'];
    const treated = spawnNow(ctx, 'rifles', 0, at.x + 5, at.z);
    expect(treated.hp).toBe(130);
  });

  it('Precision Manufacturing: +25% factory output', () => {
    // Minimal world: the factory is the only materials flow, so the ratio
    // is exact. Two plain ticks must agree (proves the isolation).
    const ctx = setup();
    completeBuildings(ctx.world, 0, ['factory']);
    const player = getPlayer(ctx.world.city, 0)!;
    player.fuel = 1000;
    player.taxRates = [0, 0, 0];
    const mats: number[] = [player.materials];
    for (let i = 0; i < 2; i += 1) {
      runEconomyTick(ctx.world, ctx.terrain);
      mats.push(player.materials);
    }
    const d1 = (mats[1] as number) - (mats[0] as number);
    const d2 = (mats[2] as number) - (mats[1] as number);
    expect(d1).toBeGreaterThan(0);
    expect(d2).toBe(d1);
    ctx.world.upgrades[0] = ['precisionManufacturing'];
    runEconomyTick(ctx.world, ctx.terrain);
    const d3 = player.materials - (mats[2] as number);
    expect(d3 / d1).toBeCloseTo(1.25, 9);
  });

  it('Smart Grid: power plants supply 25→35', () => {
    const world = createWorld(1);
    expect(effectivePowerSupply(world, 0, 'powerPlant', 25)).toBe(25);
    world.upgrades[0] = ['smartGrid'];
    expect(effectivePowerSupply(world, 0, 'powerPlant', 25)).toBe(35);
    expect(effectivePowerSupply(world, 0, 'solarFarm', 15)).toBe(20);
  });

  it('Vertical Farming: farm food x1.5 and water demand 4→3', () => {
    const ctx = setupRich();
    completeBuildings(ctx.world, 0, ['farm']);
    const player = getPlayer(ctx.world.city, 0)!;
    const foodBefore = player.food;
    runEconomyTick(ctx.world, ctx.terrain);
    const deltaPlain = player.food - foodBefore;
    expect(deltaPlain).toBeGreaterThan(0);
    ctx.world.upgrades[0] = ['verticalFarming'];
    const foodBefore2 = player.food;
    runEconomyTick(ctx.world, ctx.terrain);
    const deltaUpgraded = player.food - foodBefore2;
    expect(deltaUpgraded / deltaPlain).toBeCloseTo(1.5, 9);
    const world2 = createWorld(1);
    expect(effectiveWaterDemand(world2, 0, 'farm', 4)).toBe(4);
    world2.upgrades[0] = ['verticalFarming'];
    expect(effectiveWaterDemand(world2, 0, 'farm', 4)).toBe(3);
  });

  it('Free Trade: market funds x1.5', () => {
    // Minimal world: the market is the only funds producer; upkeep is the
    // only other funds flow and is constant, so with M the market's gain:
    // dUp = 1.5 * (dPlain + upkeep) - upkeep.
    const ctx = setup();
    completeBuildings(ctx.world, 0, ['market']);
    const player = getPlayer(ctx.world.city, 0)!;
    player.food = 1000;
    player.goods = 1000;
    player.taxRates = [0, 0, 0];
    const upkeep = BUILDING_DEFS.market.upkeepFundsPerSec;
    const f0 = player.funds;
    runEconomyTick(ctx.world, ctx.terrain);
    const dPlain = player.funds - f0;
    expect(dPlain + upkeep).toBeGreaterThan(0); // the market actually produces
    ctx.world.upgrades[0] = ['freeTrade'];
    const f1 = player.funds;
    runEconomyTick(ctx.world, ctx.terrain);
    const dUp = player.funds - f1;
    expect(dUp).toBeCloseTo(1.5 * (dPlain + upkeep) - upkeep, 9);
  });

  it('Free Trade: trade-route income 3→4.5 funds/s', () => {
    // Labs give both players trade capacity with no funds output of their
    // own; upkeep is constant, so the income delta is exactly 1.5.
    const ctx = setup();
    completeBuildings(ctx.world, 0, ['lab']);
    completeBuildings(ctx.world, 1, ['lab']);
    for (const p of ctx.world.city.players) p.taxRates = [0, 0, 0];
    ctx.world.city.tradeRoutes.push({ owner: 0, partner: 1, establishedTick: 0 });
    const player = getPlayer(ctx.world.city, 0)!;
    const f0 = player.funds;
    runEconomyTick(ctx.world, ctx.terrain);
    const dPlain = player.funds - f0;
    ctx.world.upgrades[0] = ['freeTrade'];
    const f1 = player.funds;
    runEconomyTick(ctx.world, ctx.terrain);
    const dUp = player.funds - f1;
    expect(dUp - dPlain).toBeCloseTo(1.5, 9);
  });
});

describe('snapshot v6 + canonical digest (§9)', () => {
  it('round-trips upgrades through a v6 snapshot', () => {
    const ctx = setupRich();
    const at = findLandNear(ctx.terrain, 0, 0);
    spawnNow(ctx, 'tank', 0, at.x, at.z);
    ctx.world.upgrades[0] = ['apRounds', 'engineTuning'];
    ctx.world.upgrades[1] = ['droneOptics'];
    const snap = takeSnapshot(ctx.world);
    expect(snap.version).toBe(6);
    const world2 = restoreSnapshot(snap);
    expect(world2.upgrades).toEqual({ 0: ['apRounds', 'engineTuning'], 1: ['droneOptics'] });
    expect(digestWorld(world2)).toBe(digestWorld(ctx.world));
  });

  it('loads a v5 snapshot with empty upgrades', () => {
    const ctx = setupRich();
    ctx.world.upgrades[0] = ['apRounds'];
    const v6 = takeSnapshot(ctx.world);
    // Simulate a v5 save: no upgrades payload.
    const v5 = { ...v6, version: 5 } as Record<string, unknown>;
    delete v5.upgrades;
    const world2 = restoreSnapshot(v5 as never);
    expect(world2.upgrades).toEqual({});
    expect(hasUpgrade(world2, 0, 'apRounds')).toBe(false);
  });

  it('encodes upgrades deterministically in the canonical digest', () => {
    const ctx = setupRich();
    const d1 = digestWorld(ctx.world);
    ctx.world.upgrades[0] = ['engineTuning', 'apRounds'];
    const d2 = digestWorld(ctx.world);
    expect(d2).not.toBe(d1);
    // Owner-sorted, id-sorted encoding is visible in the canonical form.
    ctx.world.upgrades = { 1: ['droneOptics'], 0: ['apRounds'] };
    const canon = canonicalizeWorld(ctx.world);
    expect(canon).toContain('|upg=u0:apRounds;u1:droneOptics;|');
    // Same upgrades on a fresh world → same digest.
    const ctx2 = setupRich();
    ctx2.world.upgrades = { 0: ['apRounds'], 1: ['droneOptics'] };
    expect(digestWorld(ctx2.world)).toBe(digestWorld(ctx.world));
  });
});

describe('determinism of the new systems', () => {
  it('two identical runs produce identical digests', () => {
    function runOnce(seed: number): number {
      const ctx = setupRich(seed);
      ctx.world.ages.age = 'industry';
      const at = findLandNear(ctx.terrain, 0, 0);
      const w = findWaterNear(ctx.terrain, 0, 0);
      spawnNow(ctx, 'tank', 0, at.x, at.z);
      spawnNow(ctx, 'sniperTeam', 0, at.x + 5, at.z);
      spawnNow(ctx, 'fishingBoat', 0, w.x, w.z);
      ctx.world.upgrades[0] = ['apRounds', 'engineTuning'];
      runEconomyTick(ctx.world, ctx.terrain);
      tick(ctx, 30);
      return digestWorld(ctx.world);
    }
    expect(runOnce(4242)).toBe(runOnce(4242));
  });
});
