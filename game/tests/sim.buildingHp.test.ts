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
 * NOVATERRA — final-review R2 building-HP tests (2026-10-01).
 *
 * Buildings are destructible (C3): every `BuildingDef` carries `hp`,
 * records track `hp`/`maxHp` (AD9 additive — the snapshot stays v8),
 * the `attackBuilding` command orders explicit sieges, `damageBuilding`
 * is the one attack-damage path (unit shots AND the storm strike; the
 * nuclear attack-meltdown roll lives there), and the conquest
 * victory/defeat checks in ui/session.ts are reachable for the first
 * time.
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
import { createTickDriver, TICK_MS, TICK_HZ, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  buildingCenterWorld,
  MAP_HALF_SIZE,
  CELL_WORLD_SIZE,
  ZoneType,
  type BuildingKind,
} from '../src/sim/city';
import {
  findUnit,
  registerUnitCommands,
  UNIT_DEFS,
  type UnitKind,
} from '../src/sim/units';
import { registerCityCommands } from '../src/sim/city';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import {
  createCombatSystem,
  registerCombatCommands,
  canTargetBuilding,
  damageBuilding,
  siegeStandCell,
} from '../src/sim/combat';
import {
  createSuperweaponSystem,
  registerSuperweaponCommands,
  getPlayerSuperweapons,
  STORM_DAMAGE,
} from '../src/sim/superweapons';
import {
  attackMeltdownRoll,
  MELTDOWN_ATTACK_DENOMINATOR,
  MELTDOWN_OFFLINE_SECONDS,
} from '../src/sim/utilityNetworks';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import {
  checkSkirmishVictory,
  checkSkirmishDefeat,
  getSkirmishOutcome,
} from '../src/ui/session';
import {
  grantAllTrainingResources,
  completeBuilding,
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
  // Production buildings both sides need so tanks can spawn.
  completeBuildings(world, 0, ['warFactory'], 10, 10);
  completeBuildings(world, 1, ['warFactory'], 60, 60);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue, terrain);
  registerSuperweaponCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(terrain),
      createSuperweaponSystem(),
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

/** World coords of a cell's top-left corner. */
function cellWorld(cx: number, cz: number): { x: number; z: number } {
  return { x: cx * CELL_WORLD_SIZE - MAP_HALF_SIZE, z: cz * CELL_WORLD_SIZE - MAP_HALF_SIZE };
}

/** Canonical footprint center of a placed building. */
function buildingCenter(ctx: Ctx, buildingId: number): { x: number; z: number } {
  const b = ctx.world.city.buildings.find((x) => x.id === buildingId)!;
  return buildingCenterWorld(b);
}

/**
 * Place an enemy building via fixture and return its id. The building
 * record is pushed without hp/maxHp (like a legacy v7 record) — the
 * digest and snapshot paths must treat it as full HP (AD9).
 */
function enemyBuilding(ctx: Ctx, kind: BuildingKind, cx: number, cz: number, owner = 1): number {
  completeBuilding(ctx.world, kind, owner, cx, cz);
  return ctx.world.city.nextBuildingId - 1;
}

/** Run ticks until the building is gone (or fail after the cap). */
function runUntilDestroyed(ctx: Ctx, buildingId: number, cap = 2000): void {
  for (let i = 0; i < cap; i++) {
    runTicks(ctx, 30);
    if (!ctx.world.city.buildings.some((b) => b.id === buildingId)) return;
  }
  throw new Error(`building ${buildingId} still standing after ${cap} ticks`);
}

describe('BuildingDef.hp scale', () => {
  it('all 100 defs carry positive integer hp', () => {
    const kinds = Object.keys(BUILDING_DEFS);
    expect(kinds).toHaveLength(100);
    for (const kind of kinds) {
      const hp = BUILDING_DEFS[kind as BuildingKind].hp;
      expect(Number.isInteger(hp), `${kind}.hp`).toBe(true);
      expect(hp, `${kind}.hp`).toBeGreaterThan(0);
    }
  });

  it('matches the documented scale tiers', () => {
    // Fragile civilian fabric: 150–250.
    expect(BUILDING_DEFS.house.hp).toBe(200);
    expect(BUILDING_DEFS.busStop.hp).toBeGreaterThanOrEqual(150);
    expect(BUILDING_DEFS.busStop.hp).toBeLessThanOrEqual(250);
    // Ordinary civilian/industrial: 300–450.
    expect(BUILDING_DEFS.factory.hp).toBeGreaterThanOrEqual(300);
    expect(BUILDING_DEFS.factory.hp).toBeLessThanOrEqual(450);
    // Hardened infrastructure: 500–700.
    expect(BUILDING_DEFS.nuclearPlant.hp).toBeGreaterThanOrEqual(500);
    expect(BUILDING_DEFS.nuclearPlant.hp).toBeLessThanOrEqual(700);
    // Military production + superweapon bunkers: 800–1000 (the siege targets).
    for (const kind of ['barracks', 'warFactory', 'airfield', 'navalYard', 'missilePlant', 'stormArray', 'aegisControl'] as BuildingKind[]) {
      expect(BUILDING_DEFS[kind].hp, kind).toBeGreaterThanOrEqual(800);
      expect(BUILDING_DEFS[kind].hp, kind).toBeLessThanOrEqual(1000);
    }
    // Calibrated siege math: a lone tank (50 dmg / 50-tick cooldown =
    // 30 dps) cracks a house in ~7 s and needs ~half a minute on a
    // hardened military plant.
    expect(Math.ceil(BUILDING_DEFS.house.hp / 30)).toBeLessThanOrEqual(8);
    expect(Math.ceil(BUILDING_DEFS.warFactory.hp / 30)).toBeGreaterThanOrEqual(25);
  });
});

describe('canTargetBuilding', () => {
  it('armed ground/both weapons can; AA-only, sea-only, unarmed cannot', () => {
    expect(canTargetBuilding(UNIT_DEFS.tank)).toBe(true); // ground
    expect(canTargetBuilding(UNIT_DEFS.artillery)).toBe(true); // ground
    expect(canTargetBuilding(UNIT_DEFS.rifles)).toBe(true); // ground
    expect(canTargetBuilding(UNIT_DEFS.drone)).toBe(true); // both
    expect(canTargetBuilding(UNIT_DEFS.aa)).toBe(false); // air only
    expect(canTargetBuilding(UNIT_DEFS.destroyer)).toBe(false); // seaAir only
    expect(canTargetBuilding(UNIT_DEFS.hauler)).toBe(false); // unarmed
    expect(canTargetBuilding(UNIT_DEFS.combatMedic)).toBe(false); // unarmed
  });
});

describe('damageBuilding', () => {
  it('reduces hp and destroys at zero through the shared demolish path', () => {
    const ctx = setup();
    const id = enemyBuilding(ctx, 'house', 70, 70);
    const b = ctx.world.city.buildings.find((x) => x.id === id)!;
    // Legacy-style record (no hp fields): reads as full HP (AD9).
    expect(damageBuilding(ctx.world, b, 50)).toBe(false);
    expect(b.hp).toBe(150);
    expect(damageBuilding(ctx.world, b, 150)).toBe(true);
    expect(ctx.world.city.buildings.some((x) => x.id === id)).toBe(false);
  });

  it('the nuclear attack-meltdown roll routes through damageBuilding', () => {
    const ctx = setup();
    const id = enemyBuilding(ctx, 'nuclearPlant', 70, 70);
    const b = ctx.world.city.buildings.find((x) => x.id === id)!;
    const tick = ctx.world.tick;
    const expected = attackMeltdownRoll(
      ctx.world.seed, id, tick, MELTDOWN_ATTACK_DENOMINATOR,
    );
    damageBuilding(ctx.world, b, 10);
    // Pure hash ⇒ deterministic: meltdown iff the roll says so.
    expect(b.meltdownUntilTick ?? 0).toBe(
      expected ? tick + MELTDOWN_OFFLINE_SECONDS * TICK_HZ : 0,
    );
    // The plant survives a scratch (600 HP) — a destroyed plant needs
    // no meltdown.
    expect(ctx.world.city.buildings.some((x) => x.id === id)).toBe(true);
  });
});

describe('attackBuilding command', () => {
  it('validates: bad ids, ownership, unarmed, wrong domain, own/unknown building, peaceful', () => {
    const ctx = setup();
    const house = cellWorld(70, 70);
    const land = findLandNear(ctx.terrain, house.x, house.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    const aa = spawnAt(ctx, land.x + 5, land.z, 'aa', 0);
    const hauler = spawnAt(ctx, land.x - 5, land.z, 'hauler', 0);
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const ownId = enemyBuilding(ctx, 'house', 74, 74, 0);

    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: -1, buildingId: bId, owner: 0 } }])),
    ).toMatch(/positive integer/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 1 } }])),
    ).toMatch(/not owned/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: hauler, buildingId: bId, owner: 0 } }])),
    ).toMatch(/unarmed/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: aa, buildingId: bId, owner: 0 } }])),
    ).toMatch(/cannot target buildings/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: ownId, owner: 0 } }])),
    ).toMatch(/your own building/);
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: 999999, owner: 0 } }])),
    ).toMatch(/no building with id/);

    ctx.world.peaceful = true;
    expect(
      rejectionReason(() => enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }])),
    ).toMatch(/not available in peaceful mode/);
    ctx.world.peaceful = false;
  });

  it('apply sets the siege linkage (buildingTargetId + chasing, clears targetId)', () => {
    const ctx = setup();
    const house = cellWorld(70, 70);
    const land = findLandNear(ctx.terrain, house.x, house.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
    runTicks(ctx, 1);
    const u = findUnit(ctx.world, tank)!;
    expect(u.buildingTargetId).toBe(bId);
    expect(u.chasing).toBe(true);
    expect(u.targetId).toBe(0);
  });

  it('a lone tank sieges a house to rubble over ticks', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const c = buildingCenter(ctx, bId);
    const land = findLandNear(ctx.terrain, c.x + 15, c.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
    runTicks(ctx, 100);
    // The siege is underway: hp dropping, linkage intact. (A tank does
    // 50/hit at a 50-tick cooldown — 100 ticks is mid-siege.)
    const mid = ctx.world.city.buildings.find((x) => x.id === bId);
    expect(mid).toBeDefined();
    expect(mid!.hp ?? BUILDING_DEFS.house.hp).toBeLessThan(BUILDING_DEFS.house.hp);
    expect(findUnit(ctx.world, tank)!.buildingTargetId).toBe(bId);
    runUntilDestroyed(ctx, bId);
    // Next-tick validation clears the linkage (building gone). Note the
    // validation sits behind the cooldown gate — like attackUnit's
    // targetId, the linkage stays stale until the firing cooldown
    // expires (50 ticks for a tank), then clears.
    runTicks(ctx, 60);
    const u = findUnit(ctx.world, tank)!;
    expect(u.buildingTargetId ?? 0).toBe(0);
    expect(u.chasing).toBe(false);
  });

  it('buildings never take opportunistic fire — siege needs an explicit order', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const c = buildingCenter(ctx, bId);
    const land = findLandNear(ctx.terrain, c.x + 15, c.z);
    spawnAt(ctx, land.x, land.z, 'tank', 0);
    runTicks(ctx, 300);
    const b = ctx.world.city.buildings.find((x) => x.id === bId)!;
    expect(b.hp ?? BUILDING_DEFS.house.hp).toBe(BUILDING_DEFS.house.hp);
  });

  it('a move order supersedes a siege (orderMoveTo clears buildingTargetId)', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const c = buildingCenter(ctx, bId);
    const land = findLandNear(ctx.terrain, c.x + 15, c.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
    runTicks(ctx, 1);
    expect(findUnit(ctx.world, tank)!.buildingTargetId).toBe(bId);
    enqueue(ctx, [{ kind: 'moveUnit', payload: { unitId: tank, owner: 0, x: land.x + 50, z: land.z } }]);
    runTicks(ctx, 1);
    const u = findUnit(ctx.world, tank)!;
    expect(u.buildingTargetId ?? 0).toBe(0);
    expect(u.chasing).toBe(false);
  });

  it('placeBuilding spawns at full HP', () => {
    const ctx = setup();
    const before = ctx.world.city.nextBuildingId;
    // Residential zoning for the house, then a real placement.
    enqueue(ctx, [{
      kind: 'paintZone',
      payload: { owner: 0, zone: ZoneType.RESIDENTIAL, x0: 20, z0: 20, x1: 23, z1: 23 },
    }]);
    runTicks(ctx, 1);
    enqueue(ctx, [{
      kind: 'placeBuilding',
      payload: { kind: 'house', owner: 0, cx: 20, cz: 20, facing: 0 },
    }]);
    runTicks(ctx, 1);
    const b = ctx.world.city.buildings.find((x) => x.id === before);
    expect(b).toBeDefined();
    expect(b!.hp).toBe(BUILDING_DEFS.house.hp);
    expect(b!.maxHp).toBe(BUILDING_DEFS.house.hp);
  });
});

describe('siegeStandCell (final-review R2 follow-up)', () => {
  it('returns a passable land cell adjacent to the footprint, nearest the unit', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const b = ctx.world.city.buildings.find((x) => x.id === bId)!;
    const def = BUILDING_DEFS.house;
    const unit = { x: -1000, z: -1000 }; // far SW — nearest ring cell is the SW corner
    const stand = siegeStandCell(ctx.terrain, ctx.world.city, b, unit.x, unit.z)!;
    expect(stand).not.toBeNull();
    // Adjacent to the footprint: within the one-cell ring.
    const cx = Math.floor((stand.x + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
    const cz = Math.floor((stand.z + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
    expect(cx).toBeGreaterThanOrEqual(b.cx - 1);
    expect(cx).toBeLessThanOrEqual(b.cx + def.footprintW);
    expect(cz).toBeGreaterThanOrEqual(b.cz - 1);
    expect(cz).toBeLessThanOrEqual(b.cz + def.footprintH);
    // On the ring, not inside the footprint.
    const inside =
      cx >= b.cx && cx < b.cx + def.footprintW && cz >= b.cz && cz < b.cz + def.footprintH;
    expect(inside).toBe(false);
    // The SW corner of the ring is the nearest to a SW unit.
    expect(cx).toBe(b.cx - 1);
    expect(cz).toBe(b.cz - 1);
    // Deterministic: same inputs, same cell.
    const again = siegeStandCell(ctx.terrain, ctx.world.city, b, unit.x, unit.z)!;
    expect(again.x).toBe(stand.x);
    expect(again.z).toBe(stand.z);
  });

  it('attackBuilding walks the unit to the stand cell, not the building center', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const b = ctx.world.city.buildings.find((x) => x.id === bId)!;
    const c = buildingCenterWorld(b);
    const land = findLandNear(ctx.terrain, c.x + 40, c.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    const u0 = findUnit(ctx.world, tank)!;
    const stand = siegeStandCell(ctx.terrain, ctx.world.city, b, u0.x, u0.z)!;
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
    runTicks(ctx, 1);
    const u = findUnit(ctx.world, tank)!;
    // The move destination is the stand cell, not the footprint center.
    expect(u.destX).toBeCloseTo(stand.x, 6);
    expect(u.destZ).toBeCloseTo(stand.z, 6);
    expect(Math.hypot(u.destX - c.x, u.destZ - c.z)).toBeGreaterThan(1);
  });
});

describe('storm strike vs buildings', () => {
  it('damages every enemy building in the blast radius', () => {
    const ctx = setup();
    ctx.world.ages.age = 'ascendance';
    completeBuilding(ctx.world, 'stormArray', 0, 10, 10);
    const plantId = enemyBuilding(ctx, 'warFactory', 14, 12);
    const plant = ctx.world.city.buildings.find((x) => x.id === plantId)!;
    const c = buildingCenterWorld(plant);
    enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: c.x, z: c.z } }]);
    runTicks(ctx, 1);
    const applyTick = ctx.world.tick;
    // One strike interval: exactly one strike has landed.
    runTicks(ctx, 35);
    const after = ctx.world.city.buildings.find((x) => x.id === plantId)!;
    expect(after.hp).toBe(BUILDING_DEFS.warFactory.hp - STORM_DAMAGE);
    void applyTick;
  });

  it('razes fragile buildings and still rolls the nuclear meltdown', () => {
    const ctx = setup();
    ctx.world.ages.age = 'ascendance';
    completeBuilding(ctx.world, 'stormArray', 0, 10, 10);
    const houseId = enemyBuilding(ctx, 'house', 14, 12);
    const plantId = enemyBuilding(ctx, 'nuclearPlant', 15, 12);
    const house = ctx.world.city.buildings.find((x) => x.id === houseId)!;
    const c = buildingCenterWorld(house);
    enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: c.x, z: c.z } }]);
    runTicks(ctx, 1);
    const strikeTick = ctx.world.tick + 30;
    // Two strikes = 240 damage > the house's 200 HP.
    runTicks(ctx, 75);
    expect(ctx.world.city.buildings.some((x) => x.id === houseId)).toBe(false);
    // The nuclear plant survived (600 HP) — the first strike's meltdown
    // roll routed through damageBuilding, exactly as the direct path.
    const plant = ctx.world.city.buildings.find((x) => x.id === plantId)!;
    const rolled = attackMeltdownRoll(
      ctx.world.seed, plantId, strikeTick, MELTDOWN_ATTACK_DENOMINATOR,
    );
    expect(plant.hp).toBe(BUILDING_DEFS.nuclearPlant.hp - 2 * STORM_DAMAGE);
    expect(plant.meltdownUntilTick ?? 0).toBe(
      rolled ? strikeTick + MELTDOWN_OFFLINE_SECONDS * TICK_HZ : 0,
    );
  });

  it('an active Aegis shield holds the strike off buildings', () => {
    const ctx = setup();
    ctx.world.ages.age = 'ascendance';
    completeBuilding(ctx.world, 'stormArray', 0, 10, 10);
    const houseId = enemyBuilding(ctx, 'house', 14, 12);
    const house = ctx.world.city.buildings.find((x) => x.id === houseId)!;
    const c = buildingCenterWorld(house);
    // Raise the rival's Aegis directly (the fireAegis command needs its
    // own facility; the shield state is plain data).
    const sw = getPlayerSuperweapons(ctx.world, 1);
    sw.aegis.activeUntil = ctx.world.tick + 100000;
    enqueue(ctx, [{ kind: 'fireStorm', payload: { owner: 0, x: c.x, z: c.z } }]);
    runTicks(ctx, 300);
    const after = ctx.world.city.buildings.find((x) => x.id === houseId)!;
    expect(after.hp ?? BUILDING_DEFS.house.hp).toBe(BUILDING_DEFS.house.hp);
  });
});

describe('snapshot + digest (AD9 additive, stays v8)', () => {
  it('damaged buildings survive a save/load round-trip digest-identically', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const b = ctx.world.city.buildings.find((x) => x.id === bId)!;
    damageBuilding(ctx.world, b, 50);
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(digestWorld(restored)).toBe(before);
    const rb = restored.city.buildings.find((x) => x.id === bId)!;
    expect(rb.hp).toBe(150);
    expect(rb.maxHp).toBe(BUILDING_DEFS.house.hp);
  });

  it('legacy records without hp decode to full HP (AD9 neutral default)', () => {
    const ctx = setup();
    // completeBuilding pushes a record with no hp fields — exactly what
    // a pre-R2 snapshot decodes to.
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const raw = ctx.world.city.buildings.find((x) => x.id === bId)!;
    expect(raw.hp).toBeUndefined();
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    const rb = restored.city.buildings.find((x) => x.id === bId)!;
    expect(rb.hp).toBe(BUILDING_DEFS.house.hp);
    expect(rb.maxHp).toBe(BUILDING_DEFS.house.hp);
    // And the digest of the decoded world is stable (no NaN/undefined).
    expect(typeof digestWorld(restored)).toBe('number');
  });

  it('the digest covers hp and buildingTargetId', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const c = buildingCenter(ctx, bId);
    const land = findLandNear(ctx.terrain, c.x + 15, c.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    const d0 = digestWorld(ctx.world);
    // Issuing the siege changes behavior ⇒ the digest must move.
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
    runTicks(ctx, 1);
    expect(digestWorld(ctx.world)).not.toBe(d0);
    // Damaging the building changes behavior ⇒ the digest must move.
    const d1 = digestWorld(ctx.world);
    const b = ctx.world.city.buildings.find((x) => x.id === bId)!;
    damageBuilding(ctx.world, b, 10);
    expect(digestWorld(ctx.world)).not.toBe(d1);
  });

  it('identical sieges digest identically across runs (determinism)', () => {
    const run = (seed: number): number => {
      const ctx = setup(seed);
      const bId = enemyBuilding(ctx, 'house', 70, 70);
      const c = buildingCenter(ctx, bId);
      const land = findLandNear(ctx.terrain, c.x + 15, c.z);
      const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
      enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
      runTicks(ctx, 400);
      return digestWorld(ctx.world);
    };
    expect(run(777)).toBe(run(777));
  });

  it('a siege in flight survives save/load and keeps sieging', () => {
    const ctx = setup();
    const bId = enemyBuilding(ctx, 'house', 70, 70);
    const c = buildingCenter(ctx, bId);
    const land = findLandNear(ctx.terrain, c.x + 15, c.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
    runTicks(ctx, 100);
    // Restore into a fresh driver sharing the queue/systems shape, then
    // run the same ticks on both — digests must match.
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    const ctx2 = setup(20261001);
    ctx2.world = restored;
    const d1 = digestWorld(ctx.world);
    const d2 = digestWorld(restored);
    expect(d2).toBe(d1);
    runTicks(ctx, 200);
    runTicks(ctx2, 200);
    expect(digestWorld(ctx2.world)).toBe(digestWorld(ctx.world));
  });
});

describe('conquest is reachable (ui/session.ts checks)', () => {
  function scenario(): Ctx {
    // Minimal world: no stray units or buildings on either side.
    const terrain = getTerrain();
    const world = createWorld(424242);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    registerUnitCommands(queue, terrain);
    registerMovementCommands(queue, terrain);
    registerCombatCommands(queue);
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

  it('an enemy army razing the player base triggers DEFEAT', () => {
    const ctx = scenario();
    completeBuilding(ctx.world, 'house', 0, 10, 10);
    const bId = ctx.world.city.nextBuildingId - 1;
    completeBuildings(ctx.world, 1, ['warFactory'], 60, 60);
    const c = buildingCenter(ctx, bId);
    const land = findLandNear(ctx.terrain, c.x + 15, c.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 1);
    expect(checkSkirmishDefeat(ctx.world)).toBe(false);
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 1 } }]);
    runUntilDestroyed(ctx, bId);
    // The tank survives (owner 1 still has forces) — the PLAYER has
    // nothing left: defeat.
    expect(checkSkirmishDefeat(ctx.world)).toBe(true);
    expect(checkSkirmishVictory(ctx.world)).toBe(false);
    expect(getSkirmishOutcome(ctx.world)).toBe('defeat');
  });

  it('razing the rival base triggers VICTORY', () => {
    const ctx = scenario();
    completeBuildings(ctx.world, 0, ['warFactory'], 10, 10);
    completeBuilding(ctx.world, 'house', 1, 70, 70);
    const bId = ctx.world.city.nextBuildingId - 1;
    const c = buildingCenter(ctx, bId);
    const land = findLandNear(ctx.terrain, c.x + 15, c.z);
    const tank = spawnAt(ctx, land.x, land.z, 'tank', 0);
    expect(checkSkirmishVictory(ctx.world)).toBe(false);
    enqueue(ctx, [{ kind: 'attackBuilding', payload: { unitId: tank, buildingId: bId, owner: 0 } }]);
    runUntilDestroyed(ctx, bId);
    // The player's own tank + warFactory survive — the RIVAL has
    // nothing left: victory.
    expect(checkSkirmishVictory(ctx.world)).toBe(true);
    expect(checkSkirmishDefeat(ctx.world)).toBe(false);
    expect(getSkirmishOutcome(ctx.world)).toBe('victory');
  });

  it('getSkirmishOutcome returns null during the grace period', () => {
    const ctx = scenario();
    // A fresh world has no units/buildings on either side, so both
    // checks fire — but the grace period suppresses the outcome.
    expect(ctx.world.tick).toBeLessThan(30);
    expect(getSkirmishOutcome(ctx.world)).toBeNull();
  });
});
