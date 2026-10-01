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
 * NOVATERRA — sea-logistics Half B: military naval logistics tests
 * (2026-10-01).
 *
 * Covers the Half-B sim work:
 * - Defs: fuelTanker / ammoShip are mobile supply stations
 *   (tankerRefuelRadius 30, materials holds); navalBase carries
 *   materialsStorage 200; cargo holds spawn empty.
 * - Depot aura (serveDepotUnit): def-driven cargo loading — any supply
 *   unit in LOGISTICS_RADIUS loads fuel/ammo from depot stocks and
 *   materials from the owner's stockpile (the old tanker-flag gate is
 *   gone; land trucks load too).
 * - runMobileSupply: same-domain discharge — the sea fuelTanker refuels
 *   friendly sea units, the ammoShip rearms them, honoring the
 *   refuel/rearm service toggles; the air tanker is unchanged; nuclear
 *   units are never refueled.
 * - navalBase joins the forward fuel pull (fuelDepot gate extended).
 * - loadCargo / unloadCargo: validate≡apply, partial transfers, loud
 *   rejections (out of range, not a supply unit, not on water,
 *   nothing to transfer, peaceful mode).
 * - Snapshot/digest round-trip of cargoMaterials + materialsStock;
 *   legacy v8 decode → 0 (AD9, no version bump); digest distinguishes
 *   materials levels.
 * - thinkNavalSupply: marshal on coastal maps trains the tail
 *   (1 fuelTanker / 6 sea combat units), loads holds from the virtual
 *   stocks through the `loadCargoVirtual` command, and rallies idle
 *   ships to the fleet.
 * - Naval-building model (2026-10-01): the civilian/military cargo
 *   split — loadCargo/unloadCargo reject cross-side transfers loudly
 *   (military hulls only at navalYard/navalBase, civilian hulls only
 *   at civilian harbors); the depot aura's cargo legs are side-gated
 *   for sea units (land/air keep the legacy side-blind behavior).
 *   The marshal builds a virtual navalBase on its construction
 *   priority (right after the navalYard, coastal-gated); the completed
 *   base feeds the fleet's fuel chain (honest refinery economics) and
 *   is the AI's virtual docks for `loadCargoVirtual` — covered by a
 *   soak test through to real discharge at sea.
 */
import { describe, expect, it } from 'vitest';
// NOTE (2026-09-30): pathfinding MUST be the first sim import in this file
// (the NaN-GRID_CELLS cycle guard — see sim.logistics-core.test.ts).
import { worldToCell } from '../src/sim/pathfinding';
import { createWorld, type World } from '../src/sim/world';
import { getAgeState } from '../src/sim/ages';
import {
  createCommandQueue,
  registerCoreCommands,
  registerLogisticsCommands,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { createEconomySystem, LOGISTICS_RADIUS } from '../src/sim/economy';
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
  type UnitKind,
} from '../src/sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  cellCoords,
  getPlayer,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import { registerCityCommands } from '../src/sim/city';
import { addAIPlayer, createAISystem, CONSTRUCTION_PRIORITY } from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot, SNAPSHOT_VERSION } from '../src/sim/snapshot';
import { completeBuilding, grantAllTrainingResources } from './sim.roster-fixtures';

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

/** Full harness: pathfinding + movement + combat + economy (the aura). */
function setup(seed = 20261001): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  grantAllTrainingResources(world);
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
      createEconomySystem(terrain),
    ],
  });
  return { terrain, world, queue, driver };
}

/**
 * Bare harness: no economy system. The depot aura and the forward fuel
 * pull both live in the economy tick (which fires at tick 0, before the
 * first command batch) — they would reload a tanker in the same tick as
 * an unloadCargo, so command validate/apply tests use this harness to
 * observe the command in isolation.
 */
function setupBare(seed = 20261001): Ctx {
  const ctx = setup(seed);
  const driver = createTickDriver({
    queue: ctx.queue,
    systems: [
      createPathfindingSystem(ctx.terrain),
      createMovementSystem(ctx.terrain),
      createCombatSystem(),
    ],
  });
  return { ...ctx, driver };
}

function runTicks(ctx: Ctx, n: number): void {
  for (let i = 0; i < n; i++) ctx.driver.step(ctx.world, TICK_MS);
}

function enqueue(ctx: Ctx, cmd: Omit<NewCommand, 'issuer'>): void {
  ctx.queue.enqueue(ctx.world, { issuer: 'player', ...cmd });
}

/** Spiral for a cell whose navalBase footprint CENTER is on water. */
function findNavalBaseCell(t: TerrainData, x: number, z: number): { cx: number; cz: number } {
  const bdef = BUILDING_DEFS.navalBase;
  const { cx: cx0, cz: cz0 } = cellCoords(worldToCell(x, z));
  for (let r = 0; r < 60; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        const wx = cellCenterWorld(cx + (bdef.footprintW - 1) / 2);
        const wz = cellCenterWorld(cz + (bdef.footprintH - 1) / 2);
        if (isWater(t, wx, wz)) return { cx, cz };
      }
    }
  }
  throw new Error(`no naval-base water cell near (${x}, ${z})`);
}

/** Spiral for the nearest water world-point (unit spawns). */
function findWaterNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r < 120; r += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let dx = -r; dx <= r; dx += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const wx = x + dx;
        const wz = z + dz;
        if (isWater(t, wx, wz)) return { x: wx, z: wz };
      }
    }
  }
  throw new Error(`no water near (${x}, ${z})`);
}

/** Spiral for the nearest LAND cell (building placement). */
function findLandCell(t: TerrainData, x: number, z: number): { cx: number; cz: number } {
  const { cx: cx0, cz: cz0 } = cellCoords(worldToCell(x, z));
  for (let r = 0; r < 60; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = cx0 + dx;
        const cz = cz0 + dz;
        if (!isWater(t, cellCenterWorld(cx), cellCenterWorld(cz))) return { cx, cz };
      }
    }
  }
  throw new Error(`no land cell near (${x}, ${z})`);
}

/** A completed navalBase on water with the given stocks. */
function makeNavalBase(
  ctx: Ctx,
  owner: number,
  fuelStock: number,
  ammoStock: number,
): { base: BuildingRecord; x: number; z: number } {
  const cell = findNavalBaseCell(ctx.terrain, -60, -60);
  completeBuilding(ctx.world, 'navalBase', owner, cell.cx, cell.cz);
  const base = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
  base.fuelStock = fuelStock;
  base.ammoStock = ammoStock;
  base.materialsStock = 0;
  const bdef = BUILDING_DEFS.navalBase;
  const x = cellCenterWorld(cell.cx + (bdef.footprintW - 1) / 2);
  const z = cellCenterWorld(cell.cz + (bdef.footprintH - 1) / 2);
  return { base, x, z };
}

function loadCargo(ctx: Ctx, unitId: number, buildingId: number, owner: number): void {
  enqueue(ctx, { kind: 'loadCargo', payload: { unitId, buildingId, owner } });
}

function unloadCargo(ctx: Ctx, unitId: number, buildingId: number, owner: number): void {
  enqueue(ctx, { kind: 'unloadCargo', payload: { unitId, buildingId, owner } });
}

describe('defs', () => {
  it('fuelTanker is a sea supply station with fuel + materials holds', () => {
    const def = UNIT_DEFS.fuelTanker;
    expect(def.tankerRefuelRadius).toBe(30);
    expect(def.cargoFuelCapacity).toBe(400);
    expect(def.cargoMaterialsCapacity).toBe(200);
    expect(def.cargoAmmoCapacity ?? 0).toBe(0);
  });

  it('ammoShip is a sea supply station with ammo + materials holds', () => {
    const def = UNIT_DEFS.ammoShip;
    expect(def.tankerRefuelRadius).toBe(30);
    expect(def.cargoAmmoCapacity).toBe(80);
    expect(def.cargoMaterialsCapacity).toBe(100);
    expect(def.cargoFuelCapacity ?? 0).toBe(0);
  });

  it('navalBase carries the forward dry-stores cache', () => {
    expect(BUILDING_DEFS.navalBase.materialsStorage).toBe(200);
    expect(BUILDING_DEFS.navalBase.reloadPoint).toBe(true);
    expect(BUILDING_DEFS.navalBase.fuelStorage).toBe(300);
    expect(BUILDING_DEFS.navalBase.ammoStorage).toBe(100);
  });

  it('cargo holds spawn empty (never conjured)', () => {
    const ctx = setup();
    const p = findWaterNear(ctx.terrain, -60, -60);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, p.x, p.z);
    const ship = spawnUnit(ctx.world, 'ammoShip', 0, p.x, p.z);
    expect(tanker.cargoFuel).toBe(0);
    expect(tanker.cargoMaterials).toBe(0);
    expect(ship.cargoAmmo).toBe(0);
    expect(ship.cargoMaterials).toBe(0);
  });
});

describe('depot aura — def-driven cargo loading', () => {
  it('a fuelTanker in radius loads fuel + materials from the navalBase aura', () => {
    const ctx = setup();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    const player = getPlayer(ctx.world.city, 0)!;
    player.fuel = 0; // neutralize the forward pull — the aura loads the 250 stock exactly
    const materialsBefore = player.materials;
    runTicks(ctx, 90); // 3 economy ticks
    // Fuel: own tank was already full on spawn, so the 250-stock went
    // to the 400-hold (partial — stock-limited).
    expect(tanker.cargoFuel).toBe(250);
    expect(base.fuelStock).toBe(0);
    // Materials: 200-hold loaded from the owner's stockpile.
    expect(tanker.cargoMaterials).toBe(200);
    expect(player.materials).toBe(materialsBefore - 200);
  });

  it('an ammoShip in radius loads ammo from the navalBase aura', () => {
    const ctx = setup();
    const { base, x, z } = makeNavalBase(ctx, 0, 0, 60);
    const ship = spawnUnit(ctx.world, 'ammoShip', 0, x, z);
    runTicks(ctx, 90);
    // 80-hold, 60 in stock → partial load of 60 whole shells.
    expect(ship.cargoAmmo).toBe(60);
    expect(base.ammoStock).toBe(0);
  });

  it('cargo never eats resupply reservations', () => {
    const ctx = setup();
    const { base, x, z } = makeNavalBase(ctx, 0, 100, 0);
    base.reservedFuel = 100; // another unit's in-flight reservation
    getPlayer(ctx.world.city, 0)!.fuel = 0; // neutralize the forward pull
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    runTicks(ctx, 90);
    expect(tanker.cargoFuel).toBe(0);
    expect(base.fuelStock).toBe(100);
    expect(base.reservedFuel).toBe(100);
  });

  it('land trucks load through the same def-driven leg (old tanker-only gate is gone)', () => {
    const ctx = setup();
    // A land fuelDepot with stock; supplyTruck has no tankerRefuelRadius.
    const cell = findLandCell(ctx.terrain, -120, -120);
    const depot = ((): BuildingRecord => {
      completeBuilding(ctx.world, 'fuelDepot', 0, cell.cx, cell.cz);
      const b = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
      b.fuelStock = 90;
      b.ammoStock = 30;
      return b;
    })();
    const px = cellCenterWorld(cell.cx);
    const pz = cellCenterWorld(cell.cz);
    const truck = spawnUnit(ctx.world, 'supplyTruck', 0, px, pz);
    expect(UNIT_DEFS.supplyTruck.tankerRefuelRadius ?? 0).toBe(0);
    getPlayer(ctx.world.city, 0)!.fuel = 0; // neutralize the forward pull
    runTicks(ctx, 90);
    // supplyTruck: 100 fuel + 40 ammo holds; depot had 90/30.
    expect(truck.cargoFuel).toBe(90);
    expect(truck.cargoAmmo).toBe(30);
    expect(depot.fuelStock).toBe(0);
    expect(depot.ammoStock).toBe(0);
  });
});

describe('runMobileSupply — same-domain discharge', () => {
  it('a loaded fuelTanker refuels a nearby sea unit (no depot involved)', () => {
    const ctx = setup();
    const p = findWaterNear(ctx.terrain, 40, 40);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, p.x, p.z);
    tanker.cargoFuel = 400;
    const boat = spawnUnit(ctx.world, 'patrolBoat', 0, p.x + 10, p.z);
    boat.fuel = 10; // patrolBoat capacity 70
    runTicks(ctx, 60); // 2 economy ticks
    expect(boat.fuel).toBe(70);
    expect(tanker.cargoFuel).toBe(340);
  });

  it('an ammoShip rearms a nearby missile boat', () => {
    const ctx = setup();
    const p = findWaterNear(ctx.terrain, 40, 40);
    const ship = spawnUnit(ctx.world, 'ammoShip', 0, p.x, p.z);
    ship.cargoAmmo = 80;
    const mlb = spawnUnit(ctx.world, 'missileBoat', 0, p.x + 10, p.z);
    mlb.ammo = 0; // missileBoat capacity 8
    runTicks(ctx, 60);
    expect(mlb.ammo).toBe(8);
    expect(ship.cargoAmmo).toBe(72);
  });

  it('the air tanker still refuels air units only (unchanged behavior)', () => {
    const ctx = setup();
    const p = findWaterNear(ctx.terrain, 40, 40);
    const tanker = spawnUnit(ctx.world, 'tanker', 0, p.x, p.z);
    tanker.cargoFuel = 200;
    // A sea unit inside the air tanker's radius must NOT be refueled.
    const boat = spawnUnit(ctx.world, 'patrolBoat', 0, p.x + 10, p.z);
    boat.fuel = 10;
    runTicks(ctx, 60);
    expect(boat.fuel).toBe(10);
    expect(tanker.cargoFuel).toBe(200);
  });

  it('nuclear units are never refueled (user directive 2026-09-30)', () => {
    const ctx = setup();
    expect(UNIT_DEFS.missileSub.fuelType).toBe('nuclear');
    const p = findWaterNear(ctx.terrain, 40, 40);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, p.x, p.z);
    tanker.cargoFuel = 400;
    const sub = spawnUnit(ctx.world, 'missileSub', 0, p.x + 10, p.z);
    sub.fuel = 0; // artificial — nuclear units never burn
    runTicks(ctx, 60);
    expect(sub.fuel).toBe(0);
    expect(tanker.cargoFuel).toBe(400);
  });

  it('the refuel toggle gates the fuel leg', () => {
    const ctx = setup();
    const p = findWaterNear(ctx.terrain, 40, 40);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, p.x, p.z);
    tanker.cargoFuel = 400;
    const boat = spawnUnit(ctx.world, 'patrolBoat', 0, p.x + 10, p.z);
    boat.fuel = 10;
    enqueue(ctx, {
      kind: 'setSupplyToggles',
      payload: { unitId: tanker.id, owner: 0, repair: false, rearm: false, refuel: false },
    });
    runTicks(ctx, 60);
    expect(boat.fuel).toBe(10);
    expect(tanker.cargoFuel).toBe(400);
  });

  it('the rearm toggle gates the ammo leg', () => {
    const ctx = setup();
    const p = findWaterNear(ctx.terrain, 40, 40);
    const ship = spawnUnit(ctx.world, 'ammoShip', 0, p.x, p.z);
    ship.cargoAmmo = 80;
    const mlb = spawnUnit(ctx.world, 'missileBoat', 0, p.x + 10, p.z);
    mlb.ammo = 0;
    enqueue(ctx, {
      kind: 'setSupplyToggles',
      payload: { unitId: ship.id, owner: 0, repair: false, rearm: false, refuel: true },
    });
    runTicks(ctx, 60);
    expect(mlb.ammo).toBe(0);
    expect(ship.cargoAmmo).toBe(80);
  });
});

describe('navalBase forward fuel pull', () => {
  it('the navalBase draws fuel from the owner stockpile like a fuelDepot', () => {
    const ctx = setup();
    const { base } = makeNavalBase(ctx, 0, 0, 0);
    const player = getPlayer(ctx.world.city, 0)!;
    player.fuel = 1000;
    // The economy tick fires at tick 0 and then every 30 ticks, so 90
    // steps = 3 pulls × 5/s.
    runTicks(ctx, 90);
    expect(base.fuelStock).toBe(15);
    expect(player.fuel).toBe(985);
  });
});

describe('loadCargo / unloadCargo', () => {
  it('loadCargo transfers fuel + materials immediately (validate≡apply)', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 40);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    const player = getPlayer(ctx.world.city, 0)!;
    const materialsBefore = player.materials;
    loadCargo(ctx, tanker.id, base.id, 0);
    runTicks(ctx, 1);
    // Fuel: 400-hold, 250 in stock → 250. Materials: 200-hold from the
    // owner stockpile → 200. Ammo: fuelTanker has no ammo hold → 0.
    expect(tanker.cargoFuel).toBe(250);
    expect(tanker.cargoAmmo).toBe(0);
    expect(tanker.cargoMaterials).toBe(200);
    expect(base.fuelStock).toBe(0);
    expect(base.ammoStock).toBe(40); // untouched — no ammo hold
    expect(player.materials).toBe(materialsBefore - 200);
  });

  it('loadCargo on an ammoShip transfers ammo', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 0, 60);
    const ship = spawnUnit(ctx.world, 'ammoShip', 0, x, z);
    loadCargo(ctx, ship.id, base.id, 0);
    runTicks(ctx, 1);
    expect(ship.cargoAmmo).toBe(60);
    expect(base.ammoStock).toBe(0);
  });

  it('unloadCargo fills the navalBase forward caches (partial at the caps)', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 0, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    tanker.cargoFuel = 400;
    tanker.cargoMaterials = 200;
    unloadCargo(ctx, tanker.id, base.id, 0);
    runTicks(ctx, 1);
    // fuelStorage 300 → 300 unloaded, 100 stays aboard.
    expect(base.fuelStock).toBe(300);
    expect(tanker.cargoFuel).toBe(100);
    // materialsStorage 200 → all 200 unloaded.
    expect(base.materialsStock).toBe(200);
    expect(tanker.cargoMaterials).toBe(0);
  });

  it('unloadCargo respects remaining headroom (partial transfer)', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    tanker.cargoFuel = 400;
    unloadCargo(ctx, tanker.id, base.id, 0);
    runTicks(ctx, 1);
    expect(base.fuelStock).toBe(300); // 250 + 50 headroom
    expect(tanker.cargoFuel).toBe(350);
  });

  it('rejects loudly: out of range', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 0);
    const far = findWaterNear(ctx.terrain, x + 200, z);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, far.x, far.z);
    expect(() => loadCargo(ctx, tanker.id, base.id, 0)).toThrowError(/out of range/);
  });

  it('rejects loudly: not a supply unit', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 0);
    const boat = spawnUnit(ctx.world, 'patrolBoat', 0, x, z);
    expect(() => loadCargo(ctx, boat.id, base.id, 0)).toThrowError(/not a supply unit/);
  });

  it('rejects loudly: building not on water', () => {
    const ctx = setupBare();
    const cell = findLandCell(ctx.terrain, -120, -120);
    completeBuilding(ctx.world, 'fuelDepot', 0, cell.cx, cell.cz);
    const depot = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
    depot.fuelStock = 100;
    const px = cellCenterWorld(cell.cx);
    const pz = cellCenterWorld(cell.cz);
    const truck = spawnUnit(ctx.world, 'supplyTruck', 0, px, pz);
    expect(() => loadCargo(ctx, truck.id, depot.id, 0)).toThrowError(/not on water/);
  });

  it('rejects loudly: nothing to load / nothing to unload', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 0, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    tanker.cargoFuel = 400;
    tanker.cargoMaterials = 200;
    const player = getPlayer(ctx.world.city, 0)!;
    player.materials = 0;
    // Holds full + depot empty + stockpile empty → nothing to load.
    expect(() => loadCargo(ctx, tanker.id, base.id, 0)).toThrowError(/nothing to load/);
    // Depot stocks full-headroom... empty holds case: fresh tanker.
    const fresh = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    expect(() => unloadCargo(ctx, fresh.id, base.id, 0)).toThrowError(/nothing to unload/);
  });

  it('rejects in peaceful mode like attackBuilding', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    ctx.world.peaceful = true;
    expect(() => loadCargo(ctx, tanker.id, base.id, 0)).toThrowError(/peaceful mode/);
    expect(() => unloadCargo(ctx, tanker.id, base.id, 0)).toThrowError(/peaceful mode/);
  });

  it('loadCargo never touches resupply reservations', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 100, 0);
    base.reservedFuel = 100;
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    const player = getPlayer(ctx.world.city, 0)!;
    player.materials = 0; // isolate the fuel leg
    expect(() => loadCargo(ctx, tanker.id, base.id, 0)).toThrowError(/nothing to load/);
    expect(base.fuelStock).toBe(100);
    expect(base.reservedFuel).toBe(100);
  });
});

describe('the civilian/military cargo split (naval-building model, 2026-10-01)', () => {
  /** A completed load-point building of any kind on water with the given stocks. */
  function makeLoadPoint(
    ctx: Ctx,
    kind: BuildingKind,
    owner: number,
    fuelStock: number,
    ammoStock: number,
  ): { building: BuildingRecord; x: number; z: number } {
    const bdef = BUILDING_DEFS[kind];
    const { cx: cx0, cz: cz0 } = cellCoords(worldToCell(-60, -60));
    for (let r = 0; r < 60; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = cx0 + dx;
          const cz = cz0 + dz;
          const wx = cellCenterWorld(cx + (bdef.footprintW - 1) / 2);
          const wz = cellCenterWorld(cz + (bdef.footprintH - 1) / 2);
          if (!isWater(ctx.terrain, wx, wz)) continue;
          completeBuilding(ctx.world, kind, owner, cx, cz);
          const building = ctx.world.city.buildings[ctx.world.city.buildings.length - 1]!;
          building.fuelStock = fuelStock;
          building.ammoStock = ammoStock;
          return { building, x: wx, z: wz };
        }
      }
    }
    throw new Error(`no water-center cell for ${kind} near (-60,-60)`);
  }

  it('the defs pin the sides: tankers military, barge civilian, docks split', () => {
    expect(UNIT_DEFS.fuelTanker.military).toBe(true);
    expect(UNIT_DEFS.ammoShip.military).toBe(true);
    expect(UNIT_DEFS.fuelBarge.military ?? false).toBe(false);
    expect(BUILDING_DEFS.navalBase.military).toBe(true);
    expect(BUILDING_DEFS.navalYard.military).toBe(true);
    expect(BUILDING_DEFS.commercialPort.military ?? false).toBe(false);
    expect(BUILDING_DEFS.commercialHarbor.military ?? false).toBe(false);
  });

  it('rejects loudly: a military fuelTanker cannot loadCargo at a civilian dock', () => {
    const ctx = setupBare();
    const { building, x, z } = makeLoadPoint(ctx, 'commercialPort', 0, 250, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    expect(() => loadCargo(ctx, tanker.id, building.id, 0)).toThrowError(
      /same-side ships and naval points/,
    );
    expect(tanker.cargoFuel).toBe(0);
    expect(building.fuelStock).toBe(250);
  });

  it('rejects loudly: a civilian fuel barge cannot loadCargo at a navalBase', () => {
    const ctx = setupBare();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 0);
    const barge = spawnUnit(ctx.world, 'fuelBarge', 0, x, z);
    expect(() => loadCargo(ctx, barge.id, base.id, 0)).toThrowError(
      /same-side ships and naval points/,
    );
    expect(barge.cargoFuel).toBe(0);
    expect(base.fuelStock).toBe(250);
  });

  it('rejects loudly: cross-side unloadCargo', () => {
    const ctx = setupBare();
    const { building, x, z } = makeLoadPoint(ctx, 'commercialPort', 0, 0, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    tanker.cargoFuel = 400;
    expect(() => unloadCargo(ctx, tanker.id, building.id, 0)).toThrowError(
      /same-side ships and naval points/,
    );
    expect(tanker.cargoFuel).toBe(400);
    expect(building.fuelStock).toBe(0);
  });

  it('same-side civilian transfers still work (the gate does not over-block)', () => {
    const ctx = setupBare();
    const { building, x, z } = makeLoadPoint(ctx, 'commercialPort', 0, 250, 0);
    const barge = spawnUnit(ctx.world, 'fuelBarge', 0, x, z);
    loadCargo(ctx, barge.id, building.id, 0);
    runTicks(ctx, 1);
    // fuelBarge: 250-hold, 250 in stock → full load.
    expect(barge.cargoFuel).toBe(250);
    expect(building.fuelStock).toBe(0);
  });

  it('the depot aura never cross-loads cargo: military tanker at a civilian dock', () => {
    const ctx = setup();
    const { building, x, z } = makeLoadPoint(ctx, 'commercialPort', 0, 250, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    getPlayer(ctx.world.city, 0)!.fuel = 0; // neutralize any forward pull
    const materialsBefore = getPlayer(ctx.world.city, 0)!.materials;
    runTicks(ctx, 90); // 3 economy ticks
    expect(tanker.cargoFuel).toBe(0);
    expect(tanker.cargoMaterials).toBe(0);
    expect(building.fuelStock).toBe(250);
    expect(getPlayer(ctx.world.city, 0)!.materials).toBe(materialsBefore);
  });

  it('the depot aura never cross-loads cargo: civilian barge at a navalBase', () => {
    const ctx = setup();
    const { base, x, z } = makeNavalBase(ctx, 0, 250, 0);
    const barge = spawnUnit(ctx.world, 'fuelBarge', 0, x, z);
    barge.fuel = UNIT_DEFS.fuelBarge.fuelCapacity ?? 100; // own tank full — isolate the cargo legs
    getPlayer(ctx.world.city, 0)!.fuel = 0; // neutralize the forward pull
    runTicks(ctx, 90); // 3 economy ticks
    expect(barge.cargoFuel).toBe(0);
    expect(base.fuelStock).toBe(250);
  });
});

describe('snapshot / digest', () => {
  it('round-trips cargoMaterials and materialsStock', () => {
    expect(SNAPSHOT_VERSION).toBe(8); // AD9 — no version bump for the new fields
    const ctx = setup();
    const { base, x, z } = makeNavalBase(ctx, 0, 50, 20);
    base.materialsStock = 77;
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    tanker.cargoMaterials = 123;
    tanker.cargoFuel = 45;
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    const rTanker = findUnit(restored, tanker.id)!;
    expect(rTanker.cargoMaterials).toBe(123);
    expect(rTanker.cargoFuel).toBe(45);
    const rBase = restored.city.buildings.find((b) => b.id === base.id)!;
    expect(rBase.materialsStock).toBe(77);
    expect(digestWorld(restored)).toBe(before);
  });

  it('decodes a snapshot without the new fields as zeros (AD9 neutral decode)', () => {
    const ctx = setup();
    const { base, x, z } = makeNavalBase(ctx, 0, 0, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    tanker.cargoMaterials = 123;
    base.materialsStock = 77;
    const snap = takeSnapshot(ctx.world);
    // Strip the new fields to simulate a save written before they existed.
    for (const u of snap.units) {
      delete (u as unknown as Record<string, unknown>).cargoMaterials;
    }
    for (const b of snap.city.buildings) {
      delete (b as unknown as Record<string, unknown>).materialsStock;
    }
    const restored = restoreSnapshot(snap);
    expect(findUnit(restored, tanker.id)!.cargoMaterials).toBe(0);
    expect(
      restored.city.buildings.find((b) => b.id === base.id)!.materialsStock,
    ).toBe(0);
  });

  it('the digest distinguishes materials levels (behavior-affecting state)', () => {
    const ctx = setup();
    const { x, z } = makeNavalBase(ctx, 0, 0, 0);
    const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
    const d0 = digestWorld(ctx.world);
    tanker.cargoMaterials = 200;
    const d1 = digestWorld(ctx.world);
    expect(d1).not.toBe(d0);
    // Deterministic: same state → same digest.
    expect(digestWorld(ctx.world)).toBe(d1);
  });

  it('determinism: identical scripted scenarios produce identical digests', () => {
    const scenario = (): number => {
      const ctx = setup(777);
      const { base, x, z } = makeNavalBase(ctx, 0, 250, 40);
      const tanker = spawnUnit(ctx.world, 'fuelTanker', 0, x, z);
      const boat = spawnUnit(ctx.world, 'patrolBoat', 0, x + 10, z);
      boat.fuel = 10;
      loadCargo(ctx, tanker.id, base.id, 0);
      runTicks(ctx, 90);
      return digestWorld(ctx.world);
    };
    expect(scenario()).toBe(scenario());
  });
});

describe('thinkNavalSupply', () => {
  function setupAI(seed = 20261001): {
    world: World;
    queue: CommandQueue;
    driver: TickDriver;
  } {
    const terrain = getTerrain();
    const world = createWorld(seed);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerLogisticsCommands(queue, terrain);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    ai.navalStatus = 'coastal';
    const water = findWaterNear(terrain, 0, 0);
    ai.navalWater = water;
    getAgeState(world, 0).age = 'industry';
    for (let i = 0; i < 6; i++) {
      spawnUnit(world, 'patrolBoat', 0, water.x + i * 4, water.z);
    }
    const driver = createTickDriver({
      queue,
      systems: [
        createPathfindingSystem(terrain),
        createMovementSystem(terrain),
        createCombatSystem(),
        createAISystem(queue),
      ],
    });
    return { world, queue, driver };
  }

  function runAITicks(world: World, driver: TickDriver, n: number): void {
    for (let i = 0; i < n; i++) driver.step(world, TICK_MS);
  }

  it('the marshal trains a fuelTanker for a 6-boat fleet (1 per 6 sea combat units)', () => {
    const { world, driver } = setupAI();
    runAITicks(world, driver, 300); // marshal thinks every 30 ticks
    const tankers = world.units.filter(
      (u) => u.kind === 'fuelTanker' && u.owner === 0,
    );
    expect(tankers.length).toBeGreaterThanOrEqual(1);
  });

  it('the marshal loads a trained fuelTanker from the virtual stock through the command queue', () => {
    const { world, driver } = setupAI();
    const ai = world.ai.players[0]!;
    // The AI's virtual docks: without a completed virtual navalBase the
    // `loadCargoVirtual` command (like the player's `loadCargo` without
    // a physical naval supply point) rejects.
    ai.virtualBuildings.completed.push('navalBase');
    ai.virtualFuelStock = 150;
    runAITicks(world, driver, 300);
    const tankers = world.units.filter(
      (u) => u.kind === 'fuelTanker' && u.owner === 0,
    );
    expect(tankers.length).toBeGreaterThanOrEqual(1);
    // The preset stock plus the honest per-think fuel-chain yield all
    // reached the hold through `loadCargoVirtual` — never by direct
    // mutation. Upper bound: nothing can enter the hold except through
    // the command, and the stocks are bounded (preset + 9 thinks × the
    // honest 1.5/s refinery-equivalent yield).
    const hold = tankers[0]!.cargoFuel;
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThanOrEqual(150 + 9 * 1.5);
    expect(ai.virtualFuelStock).toBeLessThanOrEqual(9 * 1.5);
  });

  it('idle supply ships rally to the fleet centroid', () => {
    const { world, driver } = setupAI();
    const water = findWaterNear(getTerrain(), 0, 0);
    // A loaded tanker far from the 6-boat fleet (all parked near `water`).
    const tanker = spawnUnit(world, 'fuelTanker', 0, water.x + 400, water.z);
    tanker.cargoFuel = 400;
    tanker.state = 'idle';
    runAITicks(world, driver, 120);
    const after = findUnit(world, tanker.id)!;
    // A moveTo toward the fleet was issued (destination or motion).
    const moved =
      after.state !== 'idle' ||
      after.destX !== 0 ||
      after.destZ !== 0 ||
      Math.abs(after.x - (water.x + 400)) > 1;
    expect(moved).toBe(true);
  });

  it('navalBase sits on the marshal build order right after the navalYard', () => {
    const order = CONSTRUCTION_PRIORITY.marshal;
    expect(order).toContain('navalBase');
    expect(order.indexOf('navalBase')).toBe(order.indexOf('navalYard') + 1);
  });

  it('soak: virtual navalBase → abstract stocks → tanker fill → discharge at sea', () => {
    const terrain = getTerrain();
    const world = createWorld(20261001);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerLogisticsCommands(queue, terrain);
    addAIPlayer(world, 0, 'marshal', 0, 0);
    const ai = world.ai.players[0]!;
    ai.navalStatus = 'coastal';
    const water = findWaterNear(terrain, 0, 0);
    ai.navalWater = water;
    getAgeState(world, 0).age = 'industry';
    for (let i = 0; i < 6; i++) {
      spawnUnit(world, 'patrolBoat', 0, water.x + i * 4, water.z);
    }
    // A mature marshal: the priority queue has worked down to the
    // navalBase, whose virtual construction is just finishing
    // (readyTick at the current tick — this soak exercises the
    // completion path in thinkConstruction, not the 2700-tick wait).
    ai.virtualBuildings.completed.push(
      'barracks',
      'warFactory',
      'lab',
      'airfield',
      'radarStation',
      'shipyard',
      'navalYard',
    );
    ai.virtualBuildings.constructing = { kind: 'navalBase', readyTick: world.tick };
    // A boat with the fleet — the discharge target in Phase 2 (starved
    // there; it sails full until then so Phase 1's honest fuel trickle
    // isn't drunk by a 65-fuel deficit before the tanker can load).
    const boat = spawnUnit(world, 'patrolBoat', 0, water.x + 8, water.z + 4);
    const driver = createTickDriver({
      queue,
      systems: [
        createPathfindingSystem(terrain),
        createMovementSystem(terrain),
        createCombatSystem(),
        createEconomySystem(terrain),
        createAISystem(queue),
      ],
    });
    // Phase 1: the navalBase completes, the honest fuel chain yields
    // (1.5/s at refinery economics — never minted from nothing), the
    // marshal trains a fuelTanker and fills its hold through the
    // `loadCargoVirtual` command. (The land abstract-resupply draws
    // first each think, per the documented order — the tail fills from
    // the remainder.)
    let tankerId = 0;
    for (let round = 0; round < 20 && tankerId === 0; round++) {
      for (let i = 0; i < 30; i++) driver.step(world, TICK_MS); // one marshal think
      if (ai.virtualBuildings.completed.includes('navalBase')) {
        const t = world.units.find(
          (u) => u.kind === 'fuelTanker' && u.owner === 0 && u.cargoFuel > 0,
        );
        if (t) tankerId = t.id;
      }
    }
    expect(ai.virtualBuildings.completed).toContain('navalBase');
    expect(tankerId).toBeGreaterThan(0);
    // Phase 2: freeze the AI (no more thinks, no abstract resupply, no
    // re-credit) and watch the filled tanker discharge for real at sea
    // through runMobileSupply.
    const tanker = findUnit(world, tankerId)!;
    const noAIDriver = createTickDriver({
      queue,
      systems: [
        createPathfindingSystem(terrain),
        createMovementSystem(terrain),
        createCombatSystem(),
        createEconomySystem(terrain),
      ],
    });
    const starved = findUnit(world, boat.id)!;
    starved.fuel = 5;
    tanker.x = starved.x + 10; // inside the 30-radius discharge ring
    tanker.z = starved.z;
    tanker.state = 'idle';
    ai.virtualFuelStock = 0; // belt and braces — no AI think runs now
    const cf0 = tanker.cargoFuel;
    expect(cf0).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++) noAIDriver.step(world, TICK_MS); // 2 economy ticks
    expect(findUnit(world, boat.id)!.fuel).toBeGreaterThan(5);
    expect(findUnit(world, tankerId)!.cargoFuel).toBeLessThan(cf0);
  });
});
