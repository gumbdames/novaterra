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
 * NOVATERRA — Phase 3 logistics: the `resupply` command (workstream 3).
 *
 * A `resupply` order is a depot-stock RESERVATION, not a convoy: at apply
 * time (the single atomic point) the unit's need is clamped to the
 * depot's available stock (stock − reserved), added to the depot's
 * reserved totals, and the unit is routed to the depot. The reservation
 * releases exactly what it took on fulfill, on the 60 s timeout, on the
 * unit's death (killUnit), or on the depot's demolition.
 *
 * Covered here:
 *  - validate/apply agreement (one shared compute — validate≡apply);
 *  - min(need, available) reservation + routing to the depot;
 *  - loud rejections: unknown unit/depot, wrong owner, under
 *    construction, non-depot building, nothing needed, empty depot,
 *    land/sea domain mismatch;
 *  - contention: the second unit gets the remainder, the third is
 *    rejected — never a silent zero-reservation;
 *  - re-issue neither stacks reservations nor timeouts;
 *  - the 60 s timeout releases unfulfilled reservations;
 *  - death and demolition release;
 *  - `setSupplyToggles` role-specializes supply units (and rejects
 *    non-supply units loudly);
 *  - snapshot/digest round-trip of the reservation ledger (AD9: no
 *    version bump).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  registerLogisticsCommands,
  RESUPPLY_TIMEOUT_TICKS,
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
  findUnit,
  registerUnitCommands,
  spawnUnit,
  type UnitKind,
} from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands, killUnit } from '../src/sim/combat';
import {
  registerCityCommands,
  cellCenterWorld,
  cellCoords,
  cellIsWater,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import { worldToCell } from '../src/sim/pathfinding';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { completeBuilding } from './sim.roster-fixtures';

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

/** Full command set incl. logistics — the UI assembly point registers the same. */
function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerLogisticsCommands(queue, terrain);
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

/** Spiral over cell indices for the nearest LAND cell (depot cell center). */
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

/** Spiral over cell indices for the nearest WATER cell (domain-mismatch tests). */
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

/** A completed depot with the given stocks (fixture bypasses construction). */
function makeDepot(
  ctx: Ctx,
  kind: BuildingKind,
  owner: number,
  ammoStock: number,
  fuelStock: number,
  onWater = false,
): BuildingRecord {
  const cell = onWater
    ? findWaterCell(ctx.terrain, -60, -60)
    : findLandCell(ctx.terrain, -60, -60);
  completeBuilding(ctx.world, kind, owner, cell.cx, cell.cz);
  const b = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
  b.ammoStock = ammoStock;
  b.fuelStock = fuelStock;
  return b;
}

/** An ammo-dry MLRS (needs 6 ammo, fuel full) near the depot area. */
function makeDryMlrs(ctx: Ctx, owner: number): ReturnType<typeof spawnUnit> {
  const p = findLandNear(ctx.terrain, -60, -60);
  const u = spawnUnit(ctx.world, 'mlrs', owner, p.x, p.z);
  u.ammo = 0;
  return u;
}

function resupply(ctx: Ctx, unitId: number, depotId: number, owner: number): void {
  enqueue(ctx, { kind: 'resupply', payload: { unitId, depotId, owner } });
}

describe('resupply — validate/apply', () => {
  it('reserves min(need, available), links the unit, and routes it to the depot', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);

    expect(depot.reservedAmmo).toBe(6); // mlrs ammoCapacity 6, need 6
    expect(depot.reservedFuel).toBe(0); // fuel full: no need, no reservation
    expect(mlrs.resupplyDepotId).toBe(depot.id);
    expect(mlrs.resupplyReservedAmmo).toBe(6);
    expect(mlrs.resupplyReservedFuel).toBe(0);
    // Routed to the depot's FOOTPRINT CENTER via the shared move
    // internals (final-review R1 M18: the corner cell was up to ~2 cells
    // off for a 3x3 depot).
    expect(mlrs.destX).toBe(cellCenterWorld(depot.cx + 1));
    expect(mlrs.destZ).toBe(cellCenterWorld(depot.cz + 1));
    // Exactly one timeout pending (the 60 s hold).
    expect(ctx.queue.pendingCount()).toBe(1);
  });

  it('reserves fuel for fuel-only consumers (tank)', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'fuelDepot', 0, 0, 100);
    const p = findLandNear(ctx.terrain, -60, -60);
    const tank = spawnUnit(ctx.world, 'tank', 0, p.x, p.z);
    tank.fuel = 10; // fuelCapacity 60 → need 50
    resupply(ctx, tank.id, depot.id, 0);
    runTicks(ctx, 1);

    expect(depot.reservedFuel).toBe(50);
    expect(tank.resupplyReservedFuel).toBe(50);
    expect(tank.resupplyReservedAmmo).toBe(0);
  });

  it('rejects loudly: unknown unit, unknown depot, wrong owner', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 1);
    expect(() => resupply(ctx, 99999, depot.id, 0)).toThrowError(/no unit with id/);
    expect(() => resupply(ctx, mlrs.id, 99999, 1)).toThrowError(/no building with id/);
    expect(() => resupply(ctx, mlrs.id, depot.id, 0)).toThrowError(/not owned by player/);
    const other = makeDepot(ctx, 'ordnanceDepot', 1, 100, 100);
    const mine = makeDryMlrs(ctx, 0);
    expect(() => resupply(ctx, mine.id, other.id, 0)).toThrowError(/not owned by player/);
  });

  it('rejects loudly: depot under construction, non-depot building, nothing needed', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    depot.progress = 0.5;
    const mlrs = makeDryMlrs(ctx, 0);
    expect(() => resupply(ctx, mlrs.id, depot.id, 0)).toThrowError(/still under construction/);
    depot.progress = 1;
    const house = makeDepot(ctx, 'house', 0, 0, 0);
    expect(() => resupply(ctx, mlrs.id, house.id, 0)).toThrowError(/is not a supply depot/);
    const full = spawnUnit(ctx.world, 'mlrs', 0, mlrs.x, mlrs.z); // ammo full
    expect(() => resupply(ctx, full.id, depot.id, 0)).toThrowError(/needs no supply/);
  });

  it('rejects loudly: depot has no available stock for the need', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 0, 0);
    const mlrs = makeDryMlrs(ctx, 0);
    expect(() => resupply(ctx, mlrs.id, depot.id, 0)).toThrowError(/no available ammo or fuel/);
  });

  it('rejects loudly: land/sea domain mismatch at the depot', () => {
    const ctx = setup();
    const waterDepot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100, true);
    const mlrs = makeDryMlrs(ctx, 0);
    expect(() => resupply(ctx, mlrs.id, waterDepot.id, 0)).toThrowError(/on water/);
    // Sea unit vs land depot: patrolBoat burns fossil fuel — drain it.
    const landDepot = makeDepot(ctx, 'fuelDepot', 0, 0, 100);
    const pw = findWaterCell(ctx.terrain, 60, 60);
    const boat = spawnUnit(
      ctx.world,
      'patrolBoat',
      0,
      cellCenterWorld(pw.cx),
      cellCenterWorld(pw.cz),
    );
    boat.fuel = 0;
    expect(() => resupply(ctx, boat.id, landDepot.id, 0)).toThrowError(/on land/);
  });

  it('validate and apply agree: a command valid at enqueue never goes stale at apply', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    // Enqueue-time validate passed (no throw); the apply re-validates
    // with the same pure compute — run the tick and assert it applied.
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(mlrs.resupplyDepotId).toBe(depot.id);
  });
});

describe('resupply — contention and re-issue', () => {
  it('the second unit gets the remainder; the third is rejected loudly', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 9, 0);
    const a = makeDryMlrs(ctx, 0);
    const b = makeDryMlrs(ctx, 0);
    const c = makeDryMlrs(ctx, 0);
    resupply(ctx, a.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(a.resupplyReservedAmmo).toBe(6);
    resupply(ctx, b.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(b.resupplyReservedAmmo).toBe(3); // the remainder
    expect(depot.reservedAmmo).toBe(9);
    expect(() => resupply(ctx, c.id, depot.id, 0)).toThrowError(/no available ammo or fuel/);
    expect(c.resupplyDepotId).toBe(0); // the loser holds nothing
  });

  it('re-issuing to the same depot neither stacks reservations nor timeouts', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(depot.reservedAmmo).toBe(6);
    expect(ctx.queue.pendingCount()).toBe(1);
    // Re-issue: releases then re-reserves the identical amount; the
    // original timeout still guards it (no second timeout).
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(depot.reservedAmmo).toBe(6);
    expect(ctx.queue.pendingCount()).toBe(1);
  });

  it('retargeting to another depot releases the first reservation', () => {
    const ctx = setup();
    const d1 = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const d2 = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    resupply(ctx, mlrs.id, d1.id, 0);
    runTicks(ctx, 1);
    expect(d1.reservedAmmo).toBe(6);
    resupply(ctx, mlrs.id, d2.id, 0);
    runTicks(ctx, 1);
    expect(d1.reservedAmmo).toBe(0); // released
    expect(d2.reservedAmmo).toBe(6);
    expect(mlrs.resupplyDepotId).toBe(d2.id);
  });
});

describe('resupply — release paths', () => {
  it('the 60 s timeout releases an unfulfilled reservation', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(depot.reservedAmmo).toBe(6);
    runTicks(ctx, RESUPPLY_TIMEOUT_TICKS + 2);
    expect(mlrs.resupplyDepotId).toBe(0);
    expect(mlrs.resupplyReservedAmmo).toBe(0);
    expect(depot.reservedAmmo).toBe(0);
    expect(ctx.queue.pendingCount()).toBe(0);
    // The depot is usable again afterwards.
    mlrs.ammo = 0;
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(depot.reservedAmmo).toBe(6);
  });

  it('death releases the reservation (killUnit); the late timeout is a no-op', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(depot.reservedAmmo).toBe(6);
    killUnit(ctx.world, mlrs);
    expect(depot.reservedAmmo).toBe(0);
    expect(findUnit(ctx.world, mlrs.id)).toBeUndefined();
    // The timeout still fires later — on a dead unit it must no-op,
    // never throw, never corrupt the depot totals.
    runTicks(ctx, RESUPPLY_TIMEOUT_TICKS + 2);
    expect(depot.reservedAmmo).toBe(0);
  });

  it('demolishing the depot clears in-flight unit linkage', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    expect(mlrs.resupplyDepotId).toBe(depot.id);
    enqueue(ctx, { kind: 'demolish', payload: { cx: depot.cx, cz: depot.cz } });
    runTicks(ctx, 1);
    expect(ctx.world.city.buildings.find((b) => b.id === depot.id)).toBeUndefined();
    expect(mlrs.resupplyDepotId).toBe(0);
    expect(mlrs.resupplyReservedAmmo).toBe(0);
  });
});

describe('setSupplyToggles', () => {
  it('role-specializes a supply unit (strict boolean payload)', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const truck = spawnUnit(ctx.world, 'supplyTruck', 0, p.x, p.z);
    enqueue(ctx, {
      kind: 'setSupplyToggles',
      payload: { unitId: truck.id, owner: 0, repair: true, rearm: true, refuel: false },
    });
    runTicks(ctx, 1);
    expect(truck.supplyServices).toEqual({ repair: true, rearm: true, refuel: false });
    // And again with a different role — toggles are rewritable.
    enqueue(ctx, {
      kind: 'setSupplyToggles',
      payload: { unitId: truck.id, owner: 0, repair: false, rearm: false, refuel: true },
    });
    runTicks(ctx, 1);
    expect(truck.supplyServices).toEqual({ repair: false, rearm: false, refuel: true });
  });

  it('rejects loudly: non-supply unit, non-boolean toggles, unknown unit, wrong owner', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const tank = spawnUnit(ctx.world, 'tank', 0, p.x, p.z);
    const truck = spawnUnit(ctx.world, 'supplyTruck', 0, p.x + 4, p.z);
    const good = { unitId: truck.id, owner: 0, repair: true, rearm: true, refuel: true };
    expect(() =>
      enqueue(ctx, { kind: 'setSupplyToggles', payload: { ...good, unitId: tank.id } }),
    ).toThrowError(/not a supply unit/);
    expect(() =>
      enqueue(ctx, { kind: 'setSupplyToggles', payload: { ...good, repair: 'yes' } }),
    ).toThrowError(/payload\.repair must be a boolean/);
    expect(() =>
      enqueue(ctx, { kind: 'setSupplyToggles', payload: { ...good, unitId: 99999 } }),
    ).toThrowError(/no unit with id/);
    expect(() =>
      enqueue(ctx, { kind: 'setSupplyToggles', payload: { ...good, owner: 1 } }),
    ).toThrowError(/not owned by player/);
  });
});

describe('resupply — save/load', () => {
  it('round-trips the reservation ledger through snapshot and digest (AD9: no version bump)', () => {
    const ctx = setup();
    const depot = makeDepot(ctx, 'ordnanceDepot', 0, 100, 100);
    const mlrs = makeDryMlrs(ctx, 0);
    resupply(ctx, mlrs.id, depot.id, 0);
    runTicks(ctx, 1);
    const before = digestWorld(ctx.world);
    const snap = takeSnapshot(ctx.world);
    const restored = restoreSnapshot(snap);
    const r = findUnit(restored, mlrs.id)!;
    expect(r.resupplyDepotId).toBe(depot.id);
    expect(r.resupplyReservedAmmo).toBe(6);
    expect(r.resupplyReservedFuel).toBe(0);
    expect(digestWorld(restored)).toBe(before);
  });

  it('decodes a pre-logistics snapshot as unreserved (missing fields default to 0)', () => {
    const ctx = setup();
    const mlrs = makeDryMlrs(ctx, 0);
    const snap = takeSnapshot(ctx.world);
    // Simulate a save written before the reservation ledger existed.
    for (const u of snap.units) {
      delete (u as unknown as Record<string, unknown>)['resupplyDepotId'];
      delete (u as unknown as Record<string, unknown>)['resupplyReservedAmmo'];
      delete (u as unknown as Record<string, unknown>)['resupplyReservedFuel'];
    }
    const restored = restoreSnapshot(snap);
    const r = findUnit(restored, mlrs.id)!;
    expect(r.resupplyDepotId ?? 0).toBe(0);
    expect(r.resupplyReservedAmmo ?? 0).toBe(0);
    expect(r.resupplyReservedFuel ?? 0).toBe(0);
  });
});
