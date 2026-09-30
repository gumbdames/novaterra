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
 * NOVATERRA — grand-expansion Phase 5 (workstream B): hangar/carrier
 * shelter tests (0.1 Alpha).
 *
 * Covered here:
 *  - legacy v7 airfields decode to exactly LEGACY_AIRFIELD_HANGAR_SLOTS
 *    generic slots (the documented S4 default); other legacy buildings
 *    decode to undefined ("never had hangars");
 *  - carriers train EMPTY (wing starts at 0/wingCapacity);
 *  - embark rejects non-carrier-capable aircraft at enqueue-validate AND
 *    at apply time when the world went stale between the two;
 *  - embark/launch round trip (wing occupancy + record fields);
 *  - hangar contention: two aircraft, one slot — the second is rejected
 *    at validate AND at apply (validate≡apply agreement, reservation is
 *    atomic at apply);
 *  - killing a parked aircraft releases its hangar slot;
 *  - killing a carrier destroys its wing (id order, no XP);
 *  - nuclear exemption: a moving submarine never burns fuel, a moving
 *    fighter does;
 *  - save/load + digest round-trip of embarked state (AD9, no version
 *    bump);
 *  - the movement system syncs embarked positions (id order);
 *  - acquireTarget skips sheltered candidates;
 *  - the tanker refuel aura transfers hold fuel into thirsty tanks
 *    (neediest first).
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
  EMBARK_RANGE,
  findHangarSlot,
  findUnit,
  isSheltered,
  registerUnitCommands,
  spawnUnit,
  UNIT_DEFS,
  wingOccupancy,
  type UnitKind,
  type UnitRecord,
} from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { acquireTarget, createCombatSystem, killUnit, registerCombatCommands } from '../src/sim/combat';
import { createEconomySystem } from '../src/sim/economy';
import {
  registerCityCommands,
  cellCenterWorld,
  cellCoords,
  cellIsWater,
  defaultHangarSlots,
  LEGACY_AIRFIELD_HANGAR_SLOTS,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import { worldToCell } from '../src/sim/pathfinding';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { completeBuilding, grantTrainingResources } from './sim.roster-fixtures';

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

/** Full command set — the same assembly the UI boots. */
function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerUnitCommands(queue, terrain);
  registerCombatCommands(queue);
  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(),
      createEconomySystem(terrain),
    ],
  });
  return { terrain, world, queue, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmd: Omit<NewCommand, 'issuer'>): void {
  ctx.queue.enqueue(ctx.world, { issuer: 'player', ...cmd });
}

/** Spiral over cell indices for the nearest LAND cell. */
function findLandCell(t: TerrainData, x: number, z: number): { cx: number; cz: number } {
  const { cx: cx0, cz: cz0 } = cellCoords(worldToCell(x, z));
  for (let r = 0; r < 40; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (!cellIsWater(t, cx, cz)) return { cx, cz };
      }
    }
  }
  throw new Error(`no land cell near (${x}, ${z})`);
}

/** Spiral over cell indices for the nearest WATER cell. */
function findWaterCell(t: TerrainData, x: number, z: number): { cx: number; cz: number } {
  const { cx: cx0, cz: cz0 } = cellCoords(worldToCell(x, z));
  for (let r = 0; r < 60; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (cellIsWater(t, cx, cz)) return { cx, cz };
      }
    }
  }
  throw new Error(`no water cell near (${x}, ${z})`);
}

/** Spiral out from (x, z) for the nearest land point (deterministic). */
function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 60; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
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

/** Spiral out from (x, z) for the nearest water point (deterministic). */
function findWaterNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 150; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx;
        const cz = z + dz;
        if (Math.abs(cx) > 250 || Math.abs(cz) > 250) continue;
        if (isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no water near (${x}, ${z})`);
}

/**
 * A completed building WITH its Phase 5 hangar slots (the roster
 * fixture bypasses placeBuilding, so tests that need slots set them
 * explicitly through the sim's own defaultHangarSlots).
 */
function makeHangarBuilding(
  ctx: Ctx,
  kind: BuildingKind,
  owner: number,
  nearX = -60,
  nearZ = -60,
): BuildingRecord {
  const cell = findLandCell(ctx.terrain, nearX, nearZ);
  completeBuilding(ctx.world, kind, owner, cell.cx, cell.cz);
  const b = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
  b.hangars = defaultHangarSlots(kind);
  return b;
}

/** A carrier on water near (x, z), owned by `owner`. */
function makeCarrier(ctx: Ctx, owner: number, nearX = 60, nearZ = 60): UnitRecord {
  const p = findWaterNear(ctx.terrain, nearX, nearZ);
  return spawnUnit(ctx.world, 'carrier', owner, p.x, p.z);
}

/** An aircraft on land near (x, z), owned by `owner`. */
function makeAircraft(
  ctx: Ctx,
  kind: UnitKind,
  owner: number,
  nearX = -60,
  nearZ = -60,
): UnitRecord {
  const p = findLandNear(ctx.terrain, nearX, nearZ);
  return spawnUnit(ctx.world, kind, owner, p.x, p.z);
}

/** World-space position of a building (buildings live in cell coords). */
function buildingWorld(b: BuildingRecord): { x: number; z: number } {
  return { x: cellCenterWorld(b.cx), z: cellCenterWorld(b.cz) };
}

/** An aircraft parked next to a building's world position (in basing range). */
function makeAircraftAtBuilding(
  ctx: Ctx,
  kind: UnitKind,
  owner: number,
  b: BuildingRecord,
  dx = 5,
): UnitRecord {
  const p = buildingWorld(b);
  return spawnUnit(ctx.world, kind, owner, p.x + dx, p.z);
}

/** An aircraft floating next to a carrier (in embark range). */
function makeAircraftAtCarrier(
  ctx: Ctx,
  kind: UnitKind,
  owner: number,
  carrier: UnitRecord,
  dx = 5,
): UnitRecord {
  return spawnUnit(ctx.world, kind, owner, carrier.x + dx, carrier.z);
}

function embark(ctx: Ctx, unitId: number, carrierId: number, owner: number): void {
  enqueue(ctx, { kind: 'embarkAircraft', payload: { unitId, carrierId, owner } });
}

function base(ctx: Ctx, unitId: number, buildingId: number, owner: number): void {
  enqueue(ctx, { kind: 'baseAircraft', payload: { unitId, buildingId, owner } });
}

function launch(ctx: Ctx, unitId: number, owner: number): void {
  enqueue(ctx, { kind: 'launchAircraft', payload: { unitId, owner } });
}

// ---------------------------------------------------------------------------
// Legacy decode (AD9)
// ---------------------------------------------------------------------------

describe('legacy hangar decode', () => {
  it('a v7 airfield (no hangars field) decodes to exactly 6 generic slots', () => {
    const ctx = setup();
    const airfield = makeHangarBuilding(ctx, 'airfield', 0);
    // Simulate a v7 save: strip the field the old version never wrote
    // AND stamp the version — the decode disambiguates a v8 "absent"
    // (faithful undefined) from a v7 "absent" (predates the field) by
    // version (see copyBuilding).
    const snap = takeSnapshot(ctx.world);
    snap.version = 7;
    const snapB = snap.city.buildings.find((b) => b.id === airfield.id)!;
    delete (snapB as { hangars?: unknown }).hangars;
    const restored = restoreSnapshot(snap);
    const b = restored.city.buildings.find((x) => x.id === airfield.id)!;
    expect(b.hangars).toHaveLength(LEGACY_AIRFIELD_HANGAR_SLOTS);
    expect(LEGACY_AIRFIELD_HANGAR_SLOTS).toBe(6);
    for (const s of b.hangars!) {
      expect(s.cls).toBe('generic');
      expect(s.occupant).toBe(0);
    }
  });

  it('a legacy non-airfield building decodes to undefined ("never had hangars")', () => {
    const ctx = setup();
    const cell = findLandCell(ctx.terrain, -60, -60);
    completeBuilding(ctx.world, 'barracks', 0, cell.cx, cell.cz);
    const barracks = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
    const snap = takeSnapshot(ctx.world);
    snap.version = 7;
    const snapB = snap.city.buildings.find((b) => b.id === barracks.id)!;
    delete (snapB as { hangars?: unknown }).hangars;
    const restored = restoreSnapshot(snap);
    const b = restored.city.buildings.find((x) => x.id === barracks.id)!;
    expect(b.hangars).toBeUndefined();
  });

  it('defaultHangarSlots gives hangarS/M/L their typed per-class slots', () => {
    const s = defaultHangarSlots('hangarS')!;
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.cls === 'light' && x.occupant === 0)).toBe(true);
    const m = defaultHangarSlots('hangarM')!;
    expect(m.every((x) => x.cls === 'medium')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Carriers train EMPTY
// ---------------------------------------------------------------------------

describe('carrier training', () => {
  it('a trained carrier enters the world with an empty wing', () => {
    const ctx = setup();
    ctx.world.ages.age = 'information'; // carrier minAge
    grantTrainingResources(ctx.world, 0);
    const cell = findWaterCell(ctx.terrain, 60, 60);
    completeBuilding(ctx.world, 'navalYard', 0, cell.cx, cell.cz);
    const yard = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
    yard.hangars = defaultHangarSlots('navalYard');
    const p = findWaterNear(ctx.terrain, 60, 60);
    enqueue(ctx, { kind: 'spawnUnit', payload: { kind: 'carrier', owner: 0, x: p.x, z: p.z } });
    runTicks(ctx, 2);
    const carrier = ctx.world.units.find((u) => u.kind === 'carrier');
    expect(carrier).toBeDefined();
    expect(UNIT_DEFS.carrier.wingCapacity).toBe(8);
    expect(wingOccupancy(ctx.world, carrier!.id)).toBe(0);
    expect(carrier!.embarkedOn ?? 0).toBe(0);
    expect(carrier!.hangarBuildingId ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Embark gating
// ---------------------------------------------------------------------------

describe('embarkAircraft gating', () => {
  it('rejects non-carrier-capable aircraft at enqueue-validate', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const fighter = makeAircraft(ctx, 'fighter', 0, carrier.x, carrier.z);
    // The fighter is right next to the carrier — capability is the blocker.
    fighter.x = carrier.x + 5;
    fighter.z = carrier.z;
    expect(UNIT_DEFS.fighter.carrierCapable).not.toBe(true);
    expect(() => embark(ctx, fighter.id, carrier.id, 0)).toThrowError(/not carrier-capable/);
  });

  it('rejects at apply time when the world went stale (carrier died)', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const jet = makeAircraft(ctx, 'navalFighter', 0, carrier.x, carrier.z);
    jet.x = carrier.x + 5;
    jet.z = carrier.z;
    expect(UNIT_DEFS.navalFighter.carrierCapable).toBe(true);
    embark(ctx, jet.id, carrier.id, 0); // validates: alive, capable, wing free, in range
    killUnit(ctx.world, carrier); // stale before the tick applies it
    expect(() => ctx.queue.applyDue(ctx.world, ctx.world.tick)).toThrowError(
      /stale command 'embarkAircraft'/,
    );
    expect(jet.embarkedOn ?? 0).toBe(0);
    expect(isSheltered(jet)).toBe(false);
  });

  it('rejects embarking onto a full wing', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const wing: UnitRecord[] = [];
    for (let i = 0; i < 8; i++) {
      const jet = makeAircraft(ctx, 'navalFighter', 0, carrier.x, carrier.z);
      jet.x = carrier.x + 5 + i;
      jet.z = carrier.z;
      embark(ctx, jet.id, carrier.id, 0);
      wing.push(jet);
    }
    runTicks(ctx, 1);
    expect(wingOccupancy(ctx.world, carrier.id)).toBe(8);
    const extra = makeAircraft(ctx, 'navalFighter', 0, carrier.x, carrier.z);
    extra.x = carrier.x + 5;
    extra.z = carrier.z;
    expect(() => embark(ctx, extra.id, carrier.id, 0)).toThrowError(/wing is full/);
  });

  it('rejects out-of-range embark', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const jet = makeAircraft(ctx, 'navalFighter', 0, -60, -60);
    // Far from the carrier (well beyond EMBARK_RANGE = 48).
    expect(Math.hypot(jet.x - carrier.x, jet.z - carrier.z)).toBeGreaterThan(EMBARK_RANGE);
    expect(() => embark(ctx, jet.id, carrier.id, 0)).toThrowError(/out of embark range/);
  });
});

// ---------------------------------------------------------------------------
// Embark / launch round trip
// ---------------------------------------------------------------------------

describe('embark/launch round trip', () => {
  it('embarks a carrier-capable aircraft and launches it back', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const jet = makeAircraft(ctx, 'navalFighter', 0, carrier.x, carrier.z);
    jet.x = carrier.x + 5;
    jet.z = carrier.z;
    embark(ctx, jet.id, carrier.id, 0);
    runTicks(ctx, 1);
    expect(jet.embarkedOn).toBe(carrier.id);
    expect(isSheltered(jet)).toBe(true);
    expect(wingOccupancy(ctx.world, carrier.id)).toBe(1);
    // Embarked position tracks the carrier through the movement system.
    launch(ctx, jet.id, 0);
    runTicks(ctx, 1);
    expect(jet.embarkedOn ?? 0).toBe(0);
    expect(isSheltered(jet)).toBe(false);
    expect(wingOccupancy(ctx.world, carrier.id)).toBe(0);
  });

  it('bases an aircraft in a ground hangar and launches it back', () => {
    const ctx = setup();
    const airfield = makeHangarBuilding(ctx, 'airfield', 0);
    const jet = makeAircraftAtBuilding(ctx, 'fighter', 0, airfield);
    base(ctx, jet.id, airfield.id, 0);
    runTicks(ctx, 1);
    expect(jet.hangarBuildingId).toBe(airfield.id);
    expect(isSheltered(jet)).toBe(true);
    const slot = findHangarSlot(ctx.world, { kind: 'building', id: airfield.id }, 'medium');
    // One of the 6 generic slots is taken; a medium aircraft still fits a
    // generic slot, so a free one must remain findable.
    expect(slot).toBeGreaterThanOrEqual(0);
    launch(ctx, jet.id, 0);
    runTicks(ctx, 1);
    expect(jet.hangarBuildingId ?? 0).toBe(0);
    expect(isSheltered(jet)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hangar contention (validate≡apply)
// ---------------------------------------------------------------------------

describe('hangar contention', () => {
  it('two aircraft, one slot: the second is rejected at validate AND at apply', () => {
    const ctx = setup();
    // A single light slot (a 1-slot fixture — the reservation write is
    // what is under test, not the def capacities).
    const hangar = makeHangarBuilding(ctx, 'hangarS', 0);
    hangar.hangars = [{ cls: 'light', occupant: 0 }];
    const a = makeAircraftAtBuilding(ctx, 'drone', 0, hangar, 5);
    const b = makeAircraftAtBuilding(ctx, 'drone', 0, hangar, 8);
    base(ctx, a.id, hangar.id, 0);
    // Reservation is atomic at APPLY, not at enqueue: enqueue-validate
    // still passes for b (the slot is free until the tick applies a's
    // reservation), so both commands can be in flight at once.
    base(ctx, b.id, hangar.id, 0);
    // Both apply in one tick: the first takes the slot, the second goes
    // stale and is rejected loudly — validate≡apply agreement.
    expect(() => ctx.queue.applyDue(ctx.world, ctx.world.tick)).toThrowError(
      /stale command 'baseAircraft'/,
    );
    expect(a.hangarBuildingId).toBe(hangar.id);
    expect(b.hangarBuildingId ?? 0).toBe(0);
    expect(hangar.hangars![0]!.occupant).toBe(a.id);
  });

  it('rejects a medium aircraft at a light-only hangar', () => {
    const ctx = setup();
    const hangar = makeHangarBuilding(ctx, 'hangarS', 0);
    const jet = makeAircraftAtBuilding(ctx, 'fighter', 0, hangar);
    expect(UNIT_DEFS.fighter.hangarClass).toBe('medium');
    expect(() => base(ctx, jet.id, hangar.id, 0)).toThrowError(/no free compatible hangar slot/);
  });
});

// ---------------------------------------------------------------------------
// Death releases shelter
// ---------------------------------------------------------------------------

describe('death releases shelter', () => {
  it('killing a parked aircraft frees its hangar slot', () => {
    const ctx = setup();
    const hangar = makeHangarBuilding(ctx, 'hangarS', 0);
    const drone = makeAircraftAtBuilding(ctx, 'drone', 0, hangar);
    base(ctx, drone.id, hangar.id, 0);
    runTicks(ctx, 1);
    expect(hangar.hangars!.filter((s) => s.occupant > 0)).toHaveLength(1);
    killUnit(ctx.world, drone);
    expect(hangar.hangars!.filter((s) => s.occupant > 0)).toHaveLength(0);
    expect(findHangarSlot(ctx.world, { kind: 'building', id: hangar.id }, 'light')).toBe(0);
  });

  it('killing a carrier destroys its wing in id order, with no XP', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const jets = [0, 1, 2].map((i) => {
      const j = makeAircraftAtCarrier(ctx, 'navalFighter', 0, carrier, 5 + i * 3);
      embark(ctx, j.id, carrier.id, 0);
      return j;
    });
    runTicks(ctx, 1);
    expect(wingOccupancy(ctx.world, carrier.id)).toBe(3);
    killUnit(ctx.world, carrier);
    // The wing dies with the ship: removed from the world (killUnit
    // splices; hp on the stale record is meaningless). The recursion
    // walks world.units, which is spawn (id) order.
    for (const j of jets) {
      expect(findUnit(ctx.world, j.id)).toBeUndefined();
    }
    expect(findUnit(ctx.world, carrier.id)).toBeUndefined();
    expect(wingOccupancy(ctx.world, carrier.id)).toBe(0);
  });

  it('demolishing a hangar building releases parked aircraft onto the tarmac', () => {
    const ctx = setup();
    const hangar = makeHangarBuilding(ctx, 'hangarS', 0);
    const drone = makeAircraftAtBuilding(ctx, 'drone', 0, hangar);
    base(ctx, drone.id, hangar.id, 0);
    runTicks(ctx, 1);
    expect(isSheltered(drone)).toBe(true);
    enqueue(ctx, { kind: 'demolish', payload: { cx: hangar.cx, cz: hangar.cz, owner: 0 } });
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings.find((b) => b.id === hangar.id)).toBeUndefined();
    expect(drone.hp).toBeGreaterThan(0);
    expect(isSheltered(drone)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Nuclear exemption
// ---------------------------------------------------------------------------

describe('nuclear fuel exemption', () => {
  it('a moving submarine never burns fuel; a moving fighter does', () => {
    const ctx = setup();
    const water = findWaterNear(ctx.terrain, 60, 60);
    const sub = spawnUnit(ctx.world, 'submarine', 0, water.x, water.z);
    const subDef = UNIT_DEFS.submarine;
    expect(subDef.fuelType).toBe('nuclear');
    const fighter = makeAircraft(ctx, 'fighter', 0);
    const fighterDef = UNIT_DEFS.fighter;
    expect(fighterDef.fuelType).toBe('fossil');
    const subFuel0 = sub.fuel ?? 0;
    const fighterFuel0 = fighter.fuel ?? 0;
    // Both displace for 10 sim-seconds (fuel burns only while moving).
    // Destinations must be water for the sub (a second water point).
    const subDest = findWaterNear(ctx.terrain, sub.x + 60, sub.z + 20);
    enqueue(ctx, {
      kind: 'moveUnit',
      payload: { unitId: sub.id, owner: 0, x: subDest.x, z: subDest.z },
    });
    enqueue(ctx, {
      kind: 'moveUnit',
      payload: { unitId: fighter.id, owner: 0, x: fighter.x + 100, z: fighter.z },
    });
    runTicks(ctx, 30 * 10);
    expect(sub.fuel ?? 0).toBe(subFuel0);
    expect(fighter.fuel ?? 0).toBeLessThan(fighterFuel0);
  });
});

// ---------------------------------------------------------------------------
// Snapshot + digest round-trip of embarked state
// ---------------------------------------------------------------------------

describe('embarked state persistence', () => {
  it('save/load round-trips embarked state with an identical digest', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const jet = makeAircraft(ctx, 'navalFighter', 0, carrier.x, carrier.z);
    jet.x = carrier.x + 5;
    jet.z = carrier.z;
    embark(ctx, jet.id, carrier.id, 0);
    runTicks(ctx, 1);
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(digestWorld(restored)).toBe(before);
    const rJet = findUnit(restored, jet.id)!;
    expect(rJet.embarkedOn).toBe(carrier.id);
    expect(isSheltered(rJet)).toBe(true);
    expect(wingOccupancy(restored, carrier.id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Movement syncs embarked positions (id order)
// ---------------------------------------------------------------------------

describe('embarked position sync', () => {
  it('embarked aircraft ride the carrier as it moves', () => {
    const ctx = setup();
    const carrier = makeCarrier(ctx, 0);
    const a = makeAircraftAtCarrier(ctx, 'navalFighter', 0, carrier, 5);
    const b = makeAircraftAtCarrier(ctx, 'reconUAV', 0, carrier, 6);
    // Embark out of id order (b first) — the sync still resolves in id
    // order, deterministically.
    embark(ctx, b.id, carrier.id, 0);
    embark(ctx, a.id, carrier.id, 0);
    runTicks(ctx, 1);
    // The carrier's destination must be water (sea domain).
    const dest = findWaterNear(ctx.terrain, carrier.x + 80, carrier.z + 40);
    enqueue(ctx, {
      kind: 'moveUnit',
      payload: { unitId: carrier.id, owner: 0, x: dest.x, z: dest.z },
    });
    const cx0 = carrier.x;
    const cz0 = carrier.z;
    runTicks(ctx, 30 * 5);
    expect(Math.hypot(carrier.x - cx0, carrier.z - cz0)).toBeGreaterThan(1);
    expect(a.x).toBe(carrier.x);
    expect(a.z).toBe(carrier.z);
    expect(b.x).toBe(carrier.x);
    expect(b.z).toBe(carrier.z);
  });
});

// ---------------------------------------------------------------------------
// Combat ignores sheltered units
// ---------------------------------------------------------------------------

describe('sheltered units and combat', () => {
  it('acquireTarget skips sheltered candidates', () => {
    const world = createWorld(7);
    const enemy = { id: 1, kind: 'fighter', owner: 1, x: 0, z: 0, hp: 100, domain: 'air' } as UnitRecord;
    const sheltered = {
      id: 2, kind: 'fighter', owner: 0, x: 10, z: 0, hp: 100, domain: 'air',
      hangarBuildingId: 99,
    } as UnitRecord;
    world.units.push(enemy, sheltered);
    expect(isSheltered(sheltered)).toBe(true);
    // The only candidate is parked — no target.
    expect(acquireTarget(world, enemy, UNIT_DEFS.fighter)).toBeUndefined();
    const free = { id: 3, kind: 'fighter', owner: 0, x: 12, z: 0, hp: 100, domain: 'air' } as UnitRecord;
    world.units.push(free);
    expect(acquireTarget(world, enemy, UNIT_DEFS.fighter)?.id).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Tanker refuel aura
// ---------------------------------------------------------------------------

describe('tanker refuel aura', () => {
  it('transfers hold fuel into a thirsty tank, neediest first', () => {
    const ctx = setup();
    const tanker = makeAircraft(ctx, 'tanker', 0);
    tanker.cargoFuel = 200;
    const thirsty = makeAircraft(ctx, 'fighter', 0, tanker.x, tanker.z);
    thirsty.x = tanker.x + 10;
    thirsty.z = tanker.z;
    thirsty.fuel = 5; // nearly dry
    const full = makeAircraft(ctx, 'fighter', 0, tanker.x, tanker.z);
    full.x = tanker.x + 12;
    full.z = tanker.z;
    const fullFuel0 = full.fuel ?? 0;
    runTicks(ctx, 30 * 3);
    expect(thirsty.fuel ?? 0).toBeGreaterThan(5);
    expect(tanker.cargoFuel).toBeLessThan(200);
    // The full tank was not force-fed while a thirsty one needed fuel.
    expect(full.fuel ?? 0).toBeLessThanOrEqual(fullFuel0);
  });

  it('never refuels nuclear units', () => {
    const ctx = setup();
    const tanker = makeAircraft(ctx, 'tanker', 0);
    tanker.cargoFuel = 200;
    // A nuclear unit parked next to the tanker (a sub is sea-domain;
    // the aura only serves air units anyway — this pins the exemption
    // twice over: wrong domain AND nuclear).
    const sub = spawnUnit(ctx.world, 'submarine', 0, findWaterNear(ctx.terrain, 60, 60).x, findWaterNear(ctx.terrain, 60, 60).z);
    sub.fuel = 0;
    sub.x = tanker.x + 10;
    sub.z = tanker.z;
    runTicks(ctx, 30 * 3);
    expect(tanker.cargoFuel).toBe(200);
  });
});
