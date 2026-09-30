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

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  cellIndex,
  cellIsWater,
  getPlayer,
  placeBuilding,
  type BuildingKind,
  type BuildingRecord,
  type PlayerState,
} from '../src/sim/city';
import {
  FUEL_DEPOT_PULL_RATE_PER_SEC,
  LOGISTICS_RADIUS,
  runEconomyTick,
} from '../src/sim/economy';
import { UNIT_DEFS, spawnUnit, type UnitRecord } from '../src/sim/units';
import {
  ADVANCED_LOGISTICS_PRODUCTION_MULT,
  ADVANCED_LOGISTICS_STORAGE_MULT,
  effectiveAmmoProduction,
  effectiveAmmoStorage,
  effectiveFuelStorage,
} from '../src/sim/upgrades';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';

interface Ctx {
  world: World;
  terrain: TerrainData;
}

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function setup(seed = 703001): Ctx {
  return { world: createWorld(seed), terrain: getTerrain() };
}

function playerOf(ctx: Ctx, id: number): PlayerState {
  return getPlayer(ctx.world.city, id) as PlayerState;
}

/** Place a completed, fully serviced building directly (test helper). */
function place(ctx: Ctx, kind: BuildingKind, owner = 0): BuildingRecord {
  const t = ctx.terrain;
  const city = ctx.world.city;
  const one = (k: BuildingKind): BuildingRecord => {
    const def = BUILDING_DEFS[k];
    const foot = Math.max(def.footprintW, def.footprintH);
    for (let cz = 2; cz < 56; cz++) {
      for (let cx = 2; cx < 56; cx++) {
        let ok = true;
        for (let dz = 0; dz < foot && ok; dz++) {
          for (let dx = 0; dx < foot && ok; dx++) {
            if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
          }
        }
        if (!ok) continue;
        try {
          const b = placeBuilding(city, { kind: k, owner, cx, cz, facing: 0 });
          b.progress = 1;
          b.operational = true;
          b.powered = true;
          b.watered = true;
          return b;
        } catch {
          continue;
        }
      }
    }
    throw new Error(`no placement found for ${k}`);
  };
  // Utilities first so allocateUtilities really powers/waters the building.
  one('powerPlant');
  one('waterPump');
  const b = one(kind);
  // Keep the owner solvent: placement + upkeep deduct straight from funds.
  const p = playerOf(ctx, owner);
  p.funds = 20000;
  p.materials = 20000;
  return b;
}

/** World-space center of a placed building. */
function buildingCenter(b: BuildingRecord): { x: number; z: number } {
  const def = BUILDING_DEFS[b.kind];
  return {
    x: cellCenterWorld(b.cx + (def.footprintW - 1) / 2),
    z: cellCenterWorld(b.cz + (def.footprintH - 1) / 2),
  };
}

/** Spawn an MLRS (fuel + ammo tracked) at a world position. */
function spawnMlrs(ctx: Ctx, x: number, z: number, owner = 0): UnitRecord {
  return spawnUnit(ctx.world, 'mlrs', owner, x, z);
}

describe('logistics roster (Phase 3 workstream 2)', () => {
  it('adds the 7 logistics buildings with the specified numbers', () => {
    const defs = BUILDING_DEFS;
    // Oil well: the foundation fuel producer.
    expect(defs.oilWell.costFunds).toBe(300);
    expect(defs.oilWell.costMaterials).toBe(120);
    expect(defs.oilWell.buildSeconds).toBe(25);
    expect(defs.oilWell.output.fuel).toBe(0.6);
    // Offshore rig: the industry fuel producer (materials input).
    expect(defs.oilRig.costFunds).toBe(1400);
    expect(defs.oilRig.costMaterials).toBe(600);
    expect(defs.oilRig.buildSeconds).toBe(60);
    expect(defs.oilRig.output.fuel).toBe(2.5);
    expect(defs.oilRig.input.materials).toBe(0.2);
    // Munitions factory: general ammo.
    expect(defs.munitionsFactory.ammoProduction).toBe(2.0);
    expect(defs.munitionsFactory.ammoStorage).toBe(60);
    // Missile plant: specialized ordnance, gated on the general line.
    expect(defs.missilePlant.ammoProduction).toBe(5.0);
    expect(defs.missilePlant.ammoStorage).toBe(100);
    expect(defs.missilePlant.requiredBuilding).toBe('munitionsFactory');
    // Depots.
    expect(defs.missileSilo.ammoStorage).toBe(400);
    expect(defs.ordnanceDepot.ammoStorage).toBe(150);
    expect(defs.fuelDepot.fuelStorage).toBe(250);
  });

  it('marks exactly the 9 reload points', () => {
    const reloadPoints = (Object.keys(BUILDING_DEFS) as BuildingKind[]).filter(
      (k) => BUILDING_DEFS[k].reloadPoint,
    );
    expect(reloadPoints.sort()).toEqual(
      [
        'airfield',
        'barracks',
        'fuelDepot',
        'missilePlant',
        'missileSilo',
        'munitionsFactory',
        'navalYard',
        'ordnanceDepot',
        'warFactory',
      ].sort(),
    );
  });

  it('registers the Advanced Logistics upgrade', () => {
    expect(ADVANCED_LOGISTICS_STORAGE_MULT).toBe(1.5);
    expect(ADVANCED_LOGISTICS_PRODUCTION_MULT).toBe(1.5);
  });
});

describe('ammo production', () => {
  it('munitionsFactory fills its own ammoStock at 2.0/s', () => {
    const ctx = setup();
    const b = place(ctx, 'munitionsFactory');
    expect(b.ammoStock ?? 0).toBe(0);
    for (let i = 0; i < 10; i++) runEconomyTick(ctx.world, ctx.terrain);
    expect(b.ammoStock ?? 0).toBeCloseTo(20, 9);
  });

  it('ammo production caps at the effective ammo storage', () => {
    const ctx = setup();
    const b = place(ctx, 'munitionsFactory');
    b.ammoStock = 59;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(b.ammoStock ?? 0).toBe(60);
    runEconomyTick(ctx.world, ctx.terrain);
    expect(b.ammoStock ?? 0).toBe(60);
  });

  it('a starved factory produces nothing', () => {
    const ctx = setup();
    const b = place(ctx, 'munitionsFactory');
    const p = playerOf(ctx, 0);
    p.materials = 0; // input needs materials 0.4/s
    p.funds = 20000;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(b.ammoStock ?? 0).toBe(0);
  });

  it('missilePlant produces 5.0/s once its prerequisite exists', () => {
    const ctx = setup();
    place(ctx, 'munitionsFactory');
    const b = place(ctx, 'missilePlant');
    for (let i = 0; i < 4; i++) runEconomyTick(ctx.world, ctx.terrain);
    expect(b.ammoStock ?? 0).toBeCloseTo(20, 9);
  });

  it('Advanced Logistics multiplies production and storage by 1.5', () => {
    const ctx = setup();
    const def = BUILDING_DEFS.munitionsFactory;
    expect(effectiveAmmoProduction(ctx.world, 0, def)).toBe(2.0);
    expect(effectiveAmmoStorage(ctx.world, 0, def)).toBe(60);
    ctx.world.upgrades[0] = [...(ctx.world.upgrades[0] ?? []), 'advancedLogistics'];
    expect(effectiveAmmoProduction(ctx.world, 0, def)).toBe(
      2.0 * ADVANCED_LOGISTICS_PRODUCTION_MULT,
    );
    expect(effectiveAmmoStorage(ctx.world, 0, def)).toBe(60 * ADVANCED_LOGISTICS_STORAGE_MULT);
    expect(effectiveFuelStorage(ctx.world, 0, BUILDING_DEFS.fuelDepot)).toBe(
      250 * ADVANCED_LOGISTICS_STORAGE_MULT,
    );
  });

  it('Advanced Logistics raises the production cap in the live tick', () => {
    const ctx = setup();
    ctx.world.upgrades[0] = [...(ctx.world.upgrades[0] ?? []), 'advancedLogistics'];
    const b = place(ctx, 'munitionsFactory');
    b.ammoStock = 89;
    runEconomyTick(ctx.world, ctx.terrain);
    // Cap is 90 now (60 * 1.5); production 3.0/s fills to the cap.
    expect(b.ammoStock ?? 0).toBe(90);
  });
});

describe('fuel production and depot pull', () => {
  it('oilWell adds 0.6 fuel/s to the owner stockpile', () => {
    const ctx = setup();
    place(ctx, 'oilWell');
    const p = playerOf(ctx, 0);
    p.fuel = 100;
    runEconomyTick(ctx.world, ctx.terrain);
    // +0.6 from the well, -1.0 burned by the helper's powerPlant.
    expect(p.fuel).toBeCloseTo(99.6, 9);
  });

  it('fuelDepot caches the stockpile forward at 5/s', () => {
    expect(FUEL_DEPOT_PULL_RATE_PER_SEC).toBe(5);
    const ctx = setup();
    const b = place(ctx, 'fuelDepot');
    const p = playerOf(ctx, 0);
    p.fuel = 1000;
    for (let i = 0; i < 10; i++) runEconomyTick(ctx.world, ctx.terrain);
    expect(b.fuelStock ?? 0).toBeCloseTo(50, 9);
    // 50 pulled + 10 burned by the helper's powerPlant (1.0/s fuel input).
    expect(p.fuel).toBeCloseTo(940, 9);
  });

  it('fuelDepot pull caps at the effective fuel storage', () => {
    const ctx = setup();
    const b = place(ctx, 'fuelDepot');
    const p = playerOf(ctx, 0);
    p.fuel = 10000;
    b.fuelStock = 248;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(b.fuelStock ?? 0).toBe(250);
  });

  it('fuelDepot pull never drives the player stockpile negative', () => {
    const ctx = setup();
    const b = place(ctx, 'fuelDepot');
    const p = playerOf(ctx, 0);
    p.fuel = 3;
    runEconomyTick(ctx.world, ctx.terrain);
    // The helper's powerPlant (lower id, runs first) burns 1; the depot
    // then pulls at most the remaining 2. Nothing goes negative.
    expect(b.fuelStock ?? 0).toBeCloseTo(2, 9);
    expect(p.fuel).toBe(0);
  });
});

describe('refill aura', () => {
  it('refills an MLRS magazine from a stocked ordnance depot', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 100;
    const c = buildingCenter(depot);
    const u = spawnMlrs(ctx, c.x, c.z);
    u.ammo = 0;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(u.ammo).toBe(UNIT_DEFS.mlrs.ammoCapacity); // 6
    expect(depot.ammoStock).toBe(94);
  });

  it('tops up fuel from a fuel depot (exact fractional)', () => {
    const ctx = setup();
    const depot = place(ctx, 'fuelDepot');
    depot.fuelStock = 250;
    // Keep the depot full so the pull does not refill mid-test.
    const p = playerOf(ctx, 0);
    p.fuel = 0;
    const c = buildingCenter(depot);
    const u = spawnMlrs(ctx, c.x, c.z);
    u.fuel = 10;
    u.ammo = UNIT_DEFS.mlrs.ammoCapacity ?? 0; // no ammo need
    runEconomyTick(ctx.world, ctx.terrain);
    expect(u.fuel).toBeCloseTo(UNIT_DEFS.mlrs.fuelCapacity ?? 0, 9); // 45
    expect(depot.fuelStock ?? 0).toBeCloseTo(250 - 35, 9);
  });

  it('ignores units outside the logistics radius', () => {
    expect(LOGISTICS_RADIUS).toBe(18);
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 100;
    const c = buildingCenter(depot);
    const u = spawnMlrs(ctx, c.x + LOGISTICS_RADIUS + 12, c.z);
    u.ammo = 0;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(u.ammo).toBe(0);
    expect(depot.ammoStock).toBe(100);
  });

  it('never serves enemy units', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 100;
    const c = buildingCenter(depot);
    const u = spawnMlrs(ctx, c.x, c.z, 1);
    u.ammo = 0;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(u.ammo).toBe(0);
    expect(depot.ammoStock).toBe(100);
  });

  it('serves the lowest supply level first (deterministic)', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 6; // only enough for one magazine
    const c = buildingCenter(depot);
    const needy = spawnMlrs(ctx, c.x, c.z);
    needy.ammo = 0; // supply level 0
    const partial = spawnMlrs(ctx, c.x + 1, c.z);
    partial.ammo = 5; // supply level 5/6
    runEconomyTick(ctx.world, ctx.terrain);
    expect(needy.ammo).toBe(6);
    expect(partial.ammo).toBe(5);
    expect(depot.ammoStock).toBe(0);
  });

  it('reserved units are served first and may draw on the full stock', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 10;
    depot.reservedAmmo = 10; // everything reserved for the ordered unit
    const c = buildingCenter(depot);
    const ordered = spawnMlrs(ctx, c.x, c.z);
    ordered.ammo = 0;
    ordered.resupplyDepotId = depot.id;
    const walkup = spawnMlrs(ctx, c.x + 1, c.z);
    walkup.ammo = 0;
    runEconomyTick(ctx.world, ctx.terrain);
    // The ordered unit draws on the full stock despite the reservation.
    expect(ordered.ammo).toBe(6);
    expect(ordered.resupplyDepotId).toBe(0);
    // The walk-up unit sees stock minus reserved = 0 and gets nothing.
    expect(walkup.ammo).toBe(0);
    expect(depot.ammoStock).toBe(4);
    expect(depot.reservedAmmo).toBe(4); // released exactly what was handed over
  });

  it('walk-up units see stock minus reservations', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 10;
    depot.reservedAmmo = 6;
    const c = buildingCenter(depot);
    const u = spawnMlrs(ctx, c.x, c.z);
    u.ammo = 0;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(u.ammo).toBe(4);
    expect(depot.ammoStock).toBe(6);
    expect(depot.reservedAmmo).toBe(6); // untouched — not this unit's order
  });

  it('a dry depot keeps the resupply order outstanding', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 0;
    const c = buildingCenter(depot);
    const u = spawnMlrs(ctx, c.x, c.z);
    u.ammo = 0;
    u.resupplyDepotId = depot.id;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(u.ammo).toBe(0);
    expect(u.resupplyDepotId).toBe(depot.id);
  });

  it('is deterministic: identical setups digest identically', () => {
    const run = (seed: number): number => {
      const ctx = setup(seed);
      const depot = place(ctx, 'ordnanceDepot');
      depot.ammoStock = 37;
      const c = buildingCenter(depot);
      const a = spawnMlrs(ctx, c.x, c.z);
      a.ammo = 1;
      const b = spawnMlrs(ctx, c.x + 2, c.z);
      b.ammo = 2;
      b.resupplyDepotId = depot.id;
      for (let i = 0; i < 5; i++) runEconomyTick(ctx.world, ctx.terrain);
      return digestWorld(ctx.world);
    };
    expect(run(91001)).toBe(run(91001));
  });
});

describe('logistics snapshot round-trip', () => {
  it('stocks and reservations survive save/load', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 77;
    depot.reservedAmmo = 12;
    const fuel = place(ctx, 'fuelDepot');
    fuel.fuelStock = 123.5;
    fuel.reservedFuel = 40;
    const c = buildingCenter(depot);
    const u = spawnMlrs(ctx, c.x, c.z);
    u.ammo = 2;
    u.fuel = 11.25;
    u.cargoFuel = 30;
    u.cargoAmmo = 5;
    u.resupplyDepotId = depot.id;
    const before = digestWorld(ctx.world);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    expect(digestWorld(restored)).toBe(before);
    const rd = restored.city.buildings.find((b) => b.id === depot.id)!;
    expect(rd.ammoStock).toBe(77);
    expect(rd.reservedAmmo).toBe(12);
    const rf = restored.city.buildings.find((b) => b.id === fuel.id)!;
    expect(rf.fuelStock).toBe(123.5);
    expect(rf.reservedFuel).toBe(40);
    const ru = restored.units.find((x) => x.id === u.id)!;
    expect(ru.ammo).toBe(2);
    expect(ru.fuel).toBe(11.25);
    expect(ru.cargoFuel).toBe(30);
    expect(ru.cargoAmmo).toBe(5);
    expect(ru.resupplyDepotId).toBe(depot.id);
  });

  it('legacy snapshots (without the new fields) decode with safe defaults', () => {
    const ctx = setup();
    const depot = place(ctx, 'ordnanceDepot');
    depot.ammoStock = 77;
    const u = spawnMlrs(ctx, 0, 0);
    const snap = takeSnapshot(ctx.world) as unknown as Record<string, unknown>;
    const city = snap['city'] as { buildings: Record<string, unknown>[] };
    for (const b of city.buildings) {
      delete b['ammoStock'];
      delete b['fuelStock'];
      delete b['reservedAmmo'];
      delete b['reservedFuel'];
    }
    const su = snap['units'] as Record<string, unknown>[];
    for (const rec of su) {
      delete rec['fuel'];
      delete rec['ammo'];
      delete rec['cargoFuel'];
      delete rec['cargoAmmo'];
      delete rec['resupplyDepotId'];
    }
    const restored = restoreSnapshot(snap as never);
    const rd = restored.city.buildings.find((b) => b.id === depot.id)!;
    expect(rd.ammoStock ?? 0).toBe(0);
    expect(rd.fuelStock ?? 0).toBe(0);
    expect(rd.reservedAmmo ?? 0).toBe(0);
    expect(rd.reservedFuel ?? 0).toBe(0);
    const ru = restored.units.find((x) => x.id === u.id)!;
    expect(ru.fuel ?? 0).toBe(0);
    expect(ru.ammo ?? 0).toBe(0);
    expect(ru.cargoFuel ?? 0).toBe(0);
    expect(ru.cargoAmmo ?? 0).toBe(0);
    expect(ru.resupplyDepotId ?? 0).toBe(0);
  });
});
