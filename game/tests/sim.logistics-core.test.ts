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
 * NOVATERRA — Phase 3 logistics core tests (SIM workstream 1, S2/AD3).
 *
 * Covers the sim-side logistics foundation: UNIT_DEFS fuel/ammo/cargo
 * provisioning (§3.2 roster), spawn-full semantics, fossil-fuel burn
 * while displacing with the loud 'out of fuel' order failure, burn
 * order-stability (fuel never changes pathing decisions), the combat
 * ammo gate (hold fire like an unarmed unit, decrement per shot),
 * nuclear exemption (submarine/carrier never burn or fail), the single
 * supply degradation curve (damage ×(0.6+0.4L), speed ×(0.7+0.3L)),
 * cargo-hold snapshot/digest round-trip, and legacy v6 decode of the
 * cargo fields (no version bump, AD9).
 *
 * The resupply command, depot production chains, and the refill aura
 * belong to sibling Phase 3 workstreams and are NOT tested here.
 */
import { describe, expect, it } from 'vitest';
// NOTE (2026-09-30): pathfinding MUST be the first sim import in this file.
// A sibling Phase 3 workstream added a value import city.ts -> commands.ts,
// which closes the cycle city->commands->movement->pathfinding->city: with a
// world-first entry, pathfinding's module body reads CITY_GRID_CELLS before
// city.ts assigns it, GRID_CELLS becomes NaN, and every grid allocation
// breaks (findPath always null / RangeError in beginFieldBuild). Importing
// pathfinding first forces city.ts to finish before pathfinding's module
// body runs. The sibling workstream owns the real fix (break the
// city->commands value import).
import { landComponents, seaComponents, worldToCell } from '../src/sim/pathfinding';
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
  findUnit,
  registerUnitCommands,
  spawnUnit,
  UNIT_DEFS,
  UNIT_KINDS,
  supplyLevel,
  supplyDamageFactor,
  supplySpeedFactor,
  type UnitKind,
  type UnitRecord,
} from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
  orderMoveTo,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands, damageMultiplier } from '../src/sim/combat';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot, SNAPSHOT_VERSION } from '../src/sim/snapshot';

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

/** Minimal harness: pathfinding + movement + combat, no economy/AI. */
function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCoreCommands(queue);
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
        if (Math.abs(cx) > 250 || Math.abs(cz) > 250) continue;
        if (!isWater(t, cx, cz)) return { x: cx, z: cz };
      }
    }
  }
  throw new Error(`no land near (${x}, ${z})`);
}

/** First land point at distance [minD, maxD] from (x, z) on the same
 *  landmass (deterministic). Orders to a different land component fail
 *  with 'no path: destination unreachable', so fuel tests need this. */
function findLandInRange(
  t: TerrainData,
  x: number,
  z: number,
  minD: number,
  maxD: number,
): { x: number; z: number } {
  const comps = landComponents(t);
  const home = comps[worldToCell(x, z)];
  for (let r = minD; r <= maxD; r += 4) {
    for (let a = 0; a < 16; a++) {
      const cx = x + r * Math.cos((a * Math.PI) / 8);
      const cz = z + r * Math.sin((a * Math.PI) / 8);
      if (Math.abs(cx) > 250 || Math.abs(cz) > 250) continue;
      if (isWater(t, cx, cz)) continue;
      if (comps[worldToCell(cx, cz)] !== home) continue;
      return { x: cx, z: cz };
    }
  }
  throw new Error(`no land in [${minD}, ${maxD}] of (${x}, ${z}) on the same landmass`);
}

/** First water point at distance [minD, maxD] in the same sea component. */
function findWaterInRange(
  t: TerrainData,
  x: number,
  z: number,
  minD: number,
  maxD: number,
): { x: number; z: number } {
  const comps = seaComponents(t);
  const home = comps[worldToCell(x, z)];
  for (let r = minD; r <= maxD; r += 4) {
    for (let a = 0; a < 16; a++) {
      const cx = x + r * Math.cos((a * Math.PI) / 8);
      const cz = z + r * Math.sin((a * Math.PI) / 8);
      if (Math.abs(cx) > 250 || Math.abs(cz) > 250) continue;
      if (!isWater(t, cx, cz)) continue;
      if (comps[worldToCell(cx, cz)] !== home) continue;
      return { x: cx, z: cz };
    }
  }
  throw new Error(`no water in [${minD}, ${maxD}] of (${x}, ${z}) in the same sea`);
}

/** Spiral out from (x, z) for the nearest water point (deterministic). */
function findWaterNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 120; r += 4) {
    for (let dz = -r; dz <= r; dz += 4) {
      for (let dx = -r; dx <= r; dx += 4) {
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

describe('Phase 3 logistics core — roster provisioning (units.ts)', () => {
  it('has the 30-unit roster with the two new logistics trucks', () => {
    expect(UNIT_KINDS).toHaveLength(30);
    expect(UNIT_KINDS).toContain('supplyTruck');
    expect(UNIT_KINDS).toContain('fuelTruck');
    const kinds = Object.keys(UNIT_DEFS).sort();
    expect(kinds).toHaveLength(30);
    const land = kinds.filter((k) => UNIT_DEFS[k as UnitKind].domain === 'land');
    expect(land).toHaveLength(15);
  });

  it('provisions ammo only on the missile units (§3.2)', () => {
    expect(UNIT_DEFS.mlrs.ammoCapacity).toBe(6);
    expect(UNIT_DEFS.mlrs.ammoPerShot).toBe(1);
    expect(UNIT_DEFS.missileBoat.ammoCapacity).toBe(8);
    expect(UNIT_DEFS.missileBoat.ammoPerShot).toBe(1);
    expect(UNIT_DEFS.submarine.ammoCapacity).toBe(12);
    expect(UNIT_DEFS.submarine.ammoPerShot).toBe(1);
    // Gun units never track magazines — the abstraction stays abstract.
    for (const k of ['tank', 'artillery', 'fighter', 'destroyer', 'carrier'] as UnitKind[]) {
      expect(UNIT_DEFS[k].ammoCapacity).toBeUndefined();
    }
  });

  it('provisions fossil fuel on every mechanized unit', () => {
    const fossil: UnitKind[] = [
      'tank', 'apc', 'tankDestroyer', 'artillery', 'mlrs', 'aa', 'hq', 'hauler',
      'fighter', 'fighterBomber', 'attackHeli', 'drone', 'awacs', 'transport',
      'patrolBoat', 'missileBoat', 'frigate', 'destroyer', 'commandShip',
      'transportShip', 'fishingBoat', 'supplyTruck', 'fuelTruck',
    ];
    for (const k of fossil) {
      const def = UNIT_DEFS[k];
      expect(def.fuelType).toBe('fossil');
      expect(def.fuelCapacity).toBeGreaterThan(0);
      expect(def.fuelPerSecond).toBeGreaterThan(0);
    }
    // Infantry stays untracked; the spectre is not in the §3.2
    // mechanized list either.
    for (const k of ['engineer', 'rifles', 'sniperTeam', 'combatMedic', 'spectre'] as UnitKind[]) {
      const def = UNIT_DEFS[k];
      expect(def.fuelType).toBeUndefined();
      expect(def.fuelCapacity).toBeUndefined();
    }
  });

  it('marks submarine and carrier nuclear (no conventional refueling)', () => {
    expect(UNIT_DEFS.submarine.fuelType).toBe('nuclear');
    expect(UNIT_DEFS.carrier.fuelType).toBe('nuclear');
    expect(UNIT_DEFS.submarine.fuelCapacity).toBeUndefined();
    expect(UNIT_DEFS.carrier.fuelCapacity).toBeUndefined();
    // …but the missile sub still tracks its magazine.
    expect(UNIT_DEFS.submarine.ammoCapacity).toBe(12);
  });

  it('sizes fuel tanks as tempo constraints, not starvation', () => {
    // capacity/rate = seconds of continuous movement.
    const seconds = (k: UnitKind): number =>
      (UNIT_DEFS[k].fuelCapacity as number) / (UNIT_DEFS[k].fuelPerSecond as number);
    expect(seconds('tank')).toBeCloseTo(400, 9); // the task's anchor number
    expect(seconds('fighter')).toBeCloseTo(90, 9); // the task's anchor number
    // Ground: long offensives possible; air: fighters are the tightest;
    // sea: sized for long transits.
    for (const k of ['tank', 'apc', 'artillery', 'hauler', 'supplyTruck'] as UnitKind[]) {
      expect(seconds(k)).toBeGreaterThanOrEqual(300);
    }
    for (const k of ['fighter', 'fighterBomber', 'attackHeli', 'drone', 'awacs', 'transport'] as UnitKind[]) {
      expect(seconds(k)).toBeGreaterThanOrEqual(80);
    }
    for (const k of ['patrolBoat', 'frigate', 'destroyer', 'transportShip'] as UnitKind[]) {
      expect(seconds(k)).toBeGreaterThanOrEqual(300);
    }
  });

  it('gives the trucks their cargo holds (hauler precedent for cost/gate)', () => {
    expect(UNIT_DEFS.supplyTruck.cargoFuelCapacity).toBe(100);
    expect(UNIT_DEFS.supplyTruck.cargoAmmoCapacity).toBe(40);
    expect(UNIT_DEFS.fuelTruck.cargoFuelCapacity).toBe(220);
    expect(UNIT_DEFS.fuelTruck.cargoAmmoCapacity).toBeUndefined(); // dedicated tanker
    expect(UNIT_DEFS.hauler.cargoFuelCapacity).toBe(40);
    expect(UNIT_DEFS.hauler.cargoAmmoCapacity).toBe(20);
    // Hauler precedent: no production gate, no manpower — logistics must
    // work from the start of a match.
    for (const k of ['supplyTruck', 'fuelTruck'] as UnitKind[]) {
      expect(UNIT_DEFS[k].requiredBuilding).toBeUndefined();
      expect(UNIT_DEFS[k].manpowerCost).toBe(0);
      expect(UNIT_DEFS[k].domain).toBe('land');
      expect(UNIT_DEFS[k].damage).toBe(0); // unarmed
    }
  });

  it('spawns units with full tanks/magazines and empty cargo holds', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const tank = spawnUnit(ctx.world, 'tank', 0, p.x, p.z);
    expect(tank.fuel).toBe(60);
    expect(tank.ammo).toBe(0);
    const mlrs = spawnUnit(ctx.world, 'mlrs', 0, p.x + 4, p.z);
    expect(mlrs.ammo).toBe(6);
    const truck = spawnUnit(ctx.world, 'supplyTruck', 0, p.x + 8, p.z);
    expect(truck.fuel).toBe(60);
    expect(truck.cargoFuel).toBe(0);
    expect(truck.cargoAmmo).toBe(0);
    const fueler = spawnUnit(ctx.world, 'fuelTruck', 0, p.x + 12, p.z);
    expect(fueler.fuel).toBe(60);
    expect(fueler.cargoFuel).toBe(0);
    expect(fueler.cargoAmmo).toBe(0);
    const wp = findWaterNear(ctx.terrain, 60, 60);
    const sub = spawnUnit(ctx.world, 'submarine', 0, wp.x, wp.z);
    expect(sub.fuel).toBe(0); // nuclear: no tank
    expect(sub.ammo).toBe(12); // …but the magazine is full
    const rifles = spawnUnit(ctx.world, 'rifles', 0, p.x + 16, p.z);
    expect(rifles.fuel).toBe(0);
    expect(rifles.ammo).toBe(0);
    expect(rifles.cargoFuel).toBe(0);
    expect(rifles.cargoAmmo).toBe(0);
  });

  it('trains the new trucks through the spawnUnit command (no gate)', () => {
    const ctx = setup();
    // No production buildings completed anywhere: the hauler precedent
    // says logistics trucks must still train.
    const p = findLandNear(ctx.terrain, -60, -60);
    const id = ctx.world.nextId;
    enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind: 'supplyTruck', owner: 0, x: p.x, z: p.z } }]);
    runTicks(ctx, 1);
    const u = findUnit(ctx.world, id);
    expect(u).toBeDefined();
    expect(u!.kind).toBe('supplyTruck');
    expect(u!.fuel).toBe(60);
  });
});
describe('Phase 3 logistics core — fuel burn and the loud out-of-fuel failure', () => {
  it('burns fossil fuel only while actually displacing', () => {
    const ctx = setup();
    // Air units displace immediately on order (no pathfinding wait), so the
    // burn count is exact: 0.5/s × 2 s = 1.0.
    const f1 = spawnUnit(ctx.world, 'fighter', 0, -200, -50);
    const f2 = spawnUnit(ctx.world, 'fighter', 0, -200, 50);
    orderMoveTo(ctx.world, f1, 200, -50);
    orderMoveTo(ctx.world, f2, 200, 50);
    runTicks(ctx, 60); // 2 s
    expect(f1.fuel).toBeCloseTo(44, 9);
    expect(f2.fuel).toBeCloseTo(44, 9);
    expect(f1.state).toBe('moving');
  });

  it('does not burn fuel while idle', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const tank = spawnUnit(ctx.world, 'tank', 0, p.x, p.z);
    runTicks(ctx, 300); // 10 s of sitting still
    expect(tank.fuel).toBe(60);
    expect(tank.state).toBe('idle');
  });

  it('fails the order loudly on an empty tank and never destroys the unit', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const d = findLandInRange(ctx.terrain, p.x, p.z, 120, 200);
    const tank = spawnUnit(ctx.world, 'tank', 0, p.x, p.z);
    tank.fuel = 0;
    orderMoveTo(ctx.world, tank, d.x, d.z);
    // The 120-unit trip exceeds the A* cap, so delivery goes through the
    // chunked flow-field build — poll until the fuel gate fires.
    for (let i = 0; i < 900 && tank.state !== 'failed'; i++) {
      ctx.driver.step(ctx.world, TICK_MS);
    }
    expect(tank.state).toBe('failed');
    expect(tank.failReason).toBe('out of fuel');
    // The unit is stranded, not destroyed (§13 non-goal: no fuel-death).
    expect(tank.hp).toBeGreaterThan(0);
    expect(tank.x).toBeCloseTo(p.x, 6);
    expect(tank.z).toBeCloseTo(p.z, 6);
  });

  it('runs dry mid-route, stops where it is, and stays alive', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const d = findLandInRange(ctx.terrain, p.x, p.z, 150, 220);
    const tank = spawnUnit(ctx.world, 'tank', 0, p.x, p.z);
    tank.fuel = 0.05; // ~10 ticks of movement
    orderMoveTo(ctx.world, tank, d.x, d.z);
    runTicks(ctx, 900);
    expect(tank.state).toBe('failed');
    expect(tank.failReason).toBe('out of fuel');
    expect(tank.fuel).toBe(0);
    expect(tank.hp).toBeGreaterThan(0);
    // It displaced before running dry (it didn't fail at the origin).
    const moved = Math.hypot(tank.x - p.x, tank.z - p.z);
    expect(moved).toBeGreaterThan(1);
    // …and it never reached the destination.
    const remaining = Math.hypot(tank.x - d.x, tank.z - d.z);
    expect(remaining).toBeGreaterThan(1);
  });

  it('keeps fuel out of the pathing decision (burn never reroutes)', () => {
    // Same seed, two worlds; one tank has a full tank, the other almost
    // none. The pathing decision must be identical (§13 order-stability).
    const mk = (): Ctx => setup();
    const a = mk();
    const b = mk();
    const p = findLandNear(a.terrain, -150, -150);
    const d = findLandInRange(a.terrain, p.x, p.z, 150, 220);
    const tankA = spawnUnit(a.world, 'tank', 0, p.x, p.z);
    const tankB = spawnUnit(b.world, 'tank', 0, p.x, p.z);
    tankB.fuel = 2; // ~13 s of movement: enough to get a path, then dry
    orderMoveTo(a.world, tankA, d.x, d.z);
    orderMoveTo(b.world, tankB, d.x, d.z);
    for (let i = 0; i < 120 && (tankA.state !== 'moving' || tankB.state !== 'moving'); i++) {
      a.driver.step(a.world, TICK_MS);
      b.driver.step(b.world, TICK_MS);
    }
    expect(tankA.state).toBe('moving');
    expect(tankB.state).toBe('moving');
    expect(tankB.path).toEqual(tankA.path);
    expect(tankB.fieldId).toBe(tankA.fieldId);
    expect(tankB.arriveX).toBe(tankA.arriveX);
    expect(tankB.arriveZ).toBe(tankA.arriveZ);
    // Keep burning B until it strands; A keeps its exact route.
    const originalPath = tankA.path.slice();
    for (let i = 0; i < 1200 && tankB.state !== 'failed'; i++) {
      a.driver.step(a.world, TICK_MS);
      b.driver.step(b.world, TICK_MS);
    }
    expect(tankB.state).toBe('failed');
    expect(tankB.failReason).toBe('out of fuel');
    expect(tankA.path).toEqual(originalPath);
  });
});

describe('Phase 3 logistics core — ammo gate (combat.ts)', () => {
  it('holds fire on an empty magazine, then fires per shot once reloaded', () => {
    const ctx = setup();
    const l1 = findLandNear(ctx.terrain, -60, -60);
    const l2 = findLandInRange(ctx.terrain, l1.x, l1.z, 20, 35);
    // Inside the mlrs envelope (14..40), outside the tank's reach (19).
    const mlrs = spawnUnit(ctx.world, 'mlrs', 0, l1.x, l1.z);
    const tank = spawnUnit(ctx.world, 'tank', 1, l2.x, l2.z);
    mlrs.ammo = 0;
    runTicks(ctx, 200);
    // No shot fired: the tank is untouched, the launcher never cooled down
    // (it was ready to fire the instant a round arrived).
    expect(tank.hp).toBe(500);
    expect(mlrs.ammo).toBe(0);
    expect(mlrs.cooldownLeft).toBe(0);
    // Reload one magazine and the next tick's fire consumes exactly one
    // round: 140 × vsHeavy 1.2 = 168 damage through a full supply factor.
    mlrs.ammo = 6;
    runTicks(ctx, 30);
    expect(mlrs.ammo).toBe(5);
    expect(tank.hp).toBeCloseTo(500 - 140 * 1.2, 6);
    expect(mlrs.cooldownLeft).toBeGreaterThan(0);
  });
});

describe('Phase 3 logistics core — nuclear exemption', () => {
  it('never burns fuel and never fails out of fuel', () => {
    const ctx = setup();
    const w1 = findWaterNear(ctx.terrain, -80, -80);
    const w2 = findWaterInRange(ctx.terrain, w1.x, w1.z, 16, 60);
    const sub = spawnUnit(ctx.world, 'submarine', 0, w1.x, w1.z);
    const boat = spawnUnit(ctx.world, 'patrolBoat', 0, w1.x + 6, w1.z);
    // The fossil boat is dry: it must strand loudly. The nuclear sub has
    // no tank at all: it must sail through the same gate untouched.
    boat.fuel = 0;
    orderMoveTo(ctx.world, sub, w2.x, w2.z);
    orderMoveTo(ctx.world, boat, w2.x, w2.z);
    runTicks(ctx, 300);
    expect(boat.state).toBe('failed');
    expect(boat.failReason).toBe('out of fuel');
    expect(sub.fuel).toBe(0);
    expect(sub.state === 'failed' && sub.failReason === 'out of fuel').toBe(false);
  });

  it('exempts the carrier from fuel even on long transits', () => {
    const ctx = setup();
    const w1 = findWaterNear(ctx.terrain, 80, 80);
    const w2 = findWaterInRange(ctx.terrain, w1.x, w1.z, 30, 80);
    const carrier = spawnUnit(ctx.world, 'carrier', 0, w1.x, w1.z);
    orderMoveTo(ctx.world, carrier, w2.x, w2.z);
    runTicks(ctx, 900);
    expect(carrier.fuel).toBe(0);
    expect(carrier.state === 'failed' && carrier.failReason === 'out of fuel').toBe(false);
  });
});

describe('Phase 3 logistics core — the supply degradation curve', () => {
  const tankDef = UNIT_DEFS.tank;
  const subDef = UNIT_DEFS.submarine;

  it('computes the exact single-curve values (0.6+0.4L damage, 0.7+0.3L speed)', () => {
    const as = (fuel: number): UnitRecord => ({ fuel }) as UnitRecord;
    expect(supplyLevel(tankDef, as(60))).toBe(1);
    expect(supplyLevel(tankDef, as(30))).toBe(0.5);
    expect(supplyLevel(tankDef, as(0))).toBe(0);
    expect(supplyDamageFactor(tankDef, as(60))).toBe(1);
    expect(supplyDamageFactor(tankDef, as(30))).toBe(0.8);
    expect(supplyDamageFactor(tankDef, as(0))).toBe(0.6);
    expect(supplySpeedFactor(tankDef, as(60))).toBe(1);
    expect(supplySpeedFactor(tankDef, as(30))).toBe(0.85);
    expect(supplySpeedFactor(tankDef, as(0))).toBe(0.7);
    // Untracked kinds are always full strength.
    const rifles = ({ fuel: 0 }) as UnitRecord;
    expect(supplyLevel(UNIT_DEFS.rifles, rifles)).toBe(1);
    expect(supplyDamageFactor(UNIT_DEFS.rifles, rifles)).toBe(1);
    expect(supplySpeedFactor(UNIT_DEFS.rifles, rifles)).toBe(1);
  });

  it('degrades nuclear units on their magazine, never on fuel', () => {
    const full = { fuel: 0, ammo: 12 } as UnitRecord;
    const half = { fuel: 0, ammo: 6 } as UnitRecord;
    expect(supplyLevel(subDef, full)).toBe(1);
    expect(supplyLevel(subDef, half)).toBe(0.5);
    expect(supplyDamageFactor(subDef, half)).toBe(0.8);
    expect(supplySpeedFactor(subDef, half)).toBe(0.85);
  });

  it('scales damage through damageMultiplier at exactly the curve value', () => {
    const world = createWorld(1);
    const riflesDef = UNIT_DEFS.rifles;
    const target = { kind: 'rifles', owner: 1, vetLevel: 0 } as UnitRecord;
    const full = { kind: 'tank', owner: 0, vetLevel: 0, fuel: 60 } as UnitRecord;
    const half = { kind: 'tank', owner: 0, vetLevel: 0, fuel: 30 } as UnitRecord;
    const mFull = damageMultiplier(world, full, tankDef, target);
    const mHalf = damageMultiplier(world, half, tankDef, target);
    expect(mFull).toBe(1.3); // vsLight, full supply, recruit
    expect(mHalf / mFull).toBeCloseTo(0.8, 9);
  });

  it('flies slower when the tank runs low (integration)', () => {
    const ctx = setup();
    // Two fighters, same heading, 50 apart (no separation pushes).
    const a = spawnUnit(ctx.world, 'fighter', 0, -200, -50);
    const b = spawnUnit(ctx.world, 'fighter', 0, -200, 50);
    b.fuel = 22.5; // half tank
    orderMoveTo(ctx.world, a, 200, -50);
    orderMoveTo(ctx.world, b, 200, 50);
    runTicks(ctx, 60); // 2 s
    const da = Math.hypot(a.x + 200, a.z + 50);
    const db = Math.hypot(b.x + 200, b.z - 50);
    // Full tank: ~rated speed. Not exact, because the fighter burns 1.0
    // fuel over the 2 s and the curve degrades speed as the level drops
    // (average factor ≈ 0.9967) — that drift is the curve working.
    expect(da).toBeGreaterThan(51.5);
    expect(da).toBeLessThanOrEqual(52);
    // Half tank: ~0.85 of rated speed (drifts slightly as it burns).
    expect(db).toBeLessThan(da);
    expect(db / da).toBeGreaterThan(0.82);
    expect(db / da).toBeLessThan(0.88);
  });
});

describe('Phase 3 logistics core — cargo holds in save/load', () => {
  it('round-trips cargoFuel/cargoAmmo through snapshot and digest', () => {
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const truck = spawnUnit(ctx.world, 'supplyTruck', 0, p.x, p.z);
    const fueler = spawnUnit(ctx.world, 'fuelTruck', 0, p.x + 8, p.z);
    truck.cargoFuel = 77;
    truck.cargoAmmo = 33;
    fueler.cargoFuel = 199;
    const before = digestWorld(ctx.world);
    const snap = takeSnapshot(ctx.world);
    const restored = restoreSnapshot(snap);
    const rTruck = findUnit(restored, truck.id)!;
    const rFueler = findUnit(restored, fueler.id)!;
    expect(rTruck.cargoFuel).toBe(77);
    expect(rTruck.cargoAmmo).toBe(33);
    expect(rFueler.cargoFuel).toBe(199);
    expect(rFueler.cargoAmmo).toBe(0);
    expect(digestWorld(restored)).toBe(before);
  });

  it('decodes a legacy v6 snapshot without cargo fields as empty holds', () => {
    expect(SNAPSHOT_VERSION).toBe(6); // AD9: no version bump
    const ctx = setup();
    const p = findLandNear(ctx.terrain, -60, -60);
    const truck = spawnUnit(ctx.world, 'supplyTruck', 0, p.x, p.z);
    truck.cargoFuel = 77;
    truck.cargoAmmo = 33;
    const snap = takeSnapshot(ctx.world);
    // Strip the cargo fields to simulate a v6 save written before the
    // cargo holds existed.
    for (const u of snap.units) {
      delete (u as unknown as Record<string, unknown>).cargoFuel;
      delete (u as unknown as Record<string, unknown>).cargoAmmo;
    }
    const restored = restoreSnapshot(snap);
    const rTruck = findUnit(restored, truck.id)!;
    expect(rTruck.cargoFuel).toBe(0);
    expect(rTruck.cargoAmmo).toBe(0);
  });
});
