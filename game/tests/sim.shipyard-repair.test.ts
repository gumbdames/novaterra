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
 * NOVATERRA — drydock repair sim tests (naval-building model, 2026-10-01).
 *
 * Pins the "shipyards build AND repair" half of the user-approved naval
 * model:
 *  - A damaged same-side sea unit within SHIPYARD_REPAIR_RADIUS of an
 *    operational shipyard regains SHIPYARD_REPAIR_PER_SEC hp/s, capped
 *    at the veterancy-adjusted max (no overheal, the dead stay dead).
 *  - Side matching: the civilian commercialHarbor repairs civilian hulls
 *    only; the military shipyard / navalYard repair military hulls only.
 *  - Docks (commercialPort) do NOT repair — production vs. logistics
 *    stays unblurred.
 *  - Non-operational (still constructing / unfunded) shipyards repair
 *    nothing; land units are untouched.
 *  - `isShipUnderRepair` mirrors the pass exactly (the UI read path).
 *  - Repair is position-derived: no new unit/building fields, so the
 *    snapshot format and digest registry are untouched by this module.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  buildingCenterWorld,
  cellIsWater,
  CITY_GRID_CELLS,
  isCoastal,
  placeBuilding,
  type BuildingKind,
  type BuildingRecord,
} from '../src/sim/city';
import { spawnUnit, UNIT_DEFS, type UnitKind, type UnitRecord } from '../src/sim/units';
import { vetAdjustedMaxHp } from '../src/sim/veterancy';
import {
  isShipUnderRepair,
  runShipyardRepair,
  SHIPYARD_REPAIR_PER_SEC,
  SHIPYARD_REPAIR_RADIUS,
} from '../src/sim/shipyardRepair';
import type { World } from '../src/sim/world';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) {
    cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  }
  return cachedTerrain;
}

function setup(seed = 7101): World {
  return createWorld(seed);
}

/** A w×h footprint of pure land that IS coastal (the sim.seatrade.test.ts precedent). */
function findCoastalFootprint(
  t: TerrainData,
  w: number,
  h: number,
  exclude: Array<{ cx: number; cz: number; w: number; h: number }> = [],
): { cx: number; cz: number } {
  for (let cz = 8; cz < CITY_GRID_CELLS - 8 - h; cz += 2) {
    for (let cx = 8; cx < CITY_GRID_CELLS - 8 - w; cx += 2) {
      let allLand = true;
      for (let dz = 0; dz < h && allLand; dz++) {
        for (let dx = 0; dx < w && allLand; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) allLand = false;
        }
      }
      if (!allLand) continue;
      if (!isCoastal(t, cx, cz, w, h)) continue;
      if (
        exclude.some(
          (r) =>
            cx < r.cx + r.w + 1 &&
            r.cx < cx + w + 1 &&
            cz < r.cz + r.h + 1 &&
            r.cz < cz + h + 1,
        )
      ) {
        continue;
      }
      return { cx, cz };
    }
  }
  throw new Error('no coastal footprint on MERIDIAN_PLAINS');
}

/** Directly place a completed, operational building (bypasses commands). */
function completed(
  world: World,
  kind: BuildingKind,
  cx: number,
  cz: number,
  owner = 0,
): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  b.operational = true;
  b.powered = true;
  b.watered = true;
  return b;
}

/** Spawn a damaged sea unit right at the building's center (well inside the aura). */
function damagedAt(
  world: World,
  kind: UnitKind,
  b: BuildingRecord,
  hp: number,
  owner = 0,
): UnitRecord {
  const c = buildingCenterWorld(b);
  const u = spawnUnit(world, kind, owner, c.x, c.z);
  u.hp = hp;
  return u;
}

describe('shipyardRepair', () => {
  it('a damaged civilian freighter repairs at the civilian commercialHarbor', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const harbor = completed(world, 'commercialHarbor', f.cx, f.cz);
    const maxHp = UNIT_DEFS.cargoFreighter.hp;
    const u = damagedAt(world, 'cargoFreighter', harbor, maxHp - 30);
    runShipyardRepair(world, 1);
    expect(u.hp).toBeCloseTo(maxHp - 30 + SHIPYARD_REPAIR_PER_SEC, 9);
    expect(isShipUnderRepair(world, u)).toBe(true);
  });

  it('repair caps at the veterancy-adjusted max (no overheal)', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const harbor = completed(world, 'commercialHarbor', f.cx, f.cz);
    const u = damagedAt(world, 'cargoFreighter', harbor, 1);
    const maxHp = vetAdjustedMaxHp(world, u);
    runShipyardRepair(world, 1000); // far more than needed
    expect(u.hp).toBe(maxHp);
    expect(isShipUnderRepair(world, u)).toBe(false); // full hp ⇒ not "under repair"
  });

  it('side mismatch: civilian hull at a military shipyard does not repair', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const yard = completed(world, 'shipyard', f.cx, f.cz);
    const maxHp = UNIT_DEFS.cargoFreighter.hp;
    const u = damagedAt(world, 'cargoFreighter', yard, maxHp - 30);
    runShipyardRepair(world, 1);
    expect(u.hp).toBe(maxHp - 30);
    expect(isShipUnderRepair(world, u)).toBe(false);
  });

  it('side mismatch: military hull at the civilian harbor does not repair', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const harbor = completed(world, 'commercialHarbor', f.cx, f.cz);
    const maxHp = UNIT_DEFS.missileBoat.hp;
    const u = damagedAt(world, 'missileBoat', harbor, maxHp - 30);
    runShipyardRepair(world, 1);
    expect(u.hp).toBe(maxHp - 30);
  });

  it('military hulls repair at the military shipyard and navalYard', () => {
    const t = getTerrain();
    for (const kind of ['shipyard', 'navalYard'] as const) {
      const world = setup();
      const bdef = BUILDING_DEFS[kind];
      const f = findCoastalFootprint(t, bdef.footprintW, bdef.footprintH);
      const yard = completed(world, kind, f.cx, f.cz);
      const maxHp = UNIT_DEFS.missileBoat.hp;
      const u = damagedAt(world, 'missileBoat', yard, maxHp - 30);
      runShipyardRepair(world, 1);
      expect(u.hp).toBeCloseTo(maxHp - 30 + SHIPYARD_REPAIR_PER_SEC, 9);
    }
  });

  it('docks do not repair: commercialPort is logistics-only', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const port = completed(world, 'commercialPort', f.cx, f.cz);
    const maxHp = UNIT_DEFS.cargoFreighter.hp;
    const u = damagedAt(world, 'cargoFreighter', port, maxHp - 30);
    runShipyardRepair(world, 1);
    expect(u.hp).toBe(maxHp - 30);
    expect(isShipUnderRepair(world, u)).toBe(false);
  });

  it('a non-operational shipyard repairs nothing', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const harbor = placeBuilding(world.city, { kind: 'commercialHarbor', owner: 0, cx: f.cx, cz: f.cz, facing: 0 });
    harbor.operational = false; // unfunded / still constructing
    const maxHp = UNIT_DEFS.cargoFreighter.hp;
    const u = damagedAt(world, 'cargoFreighter', harbor, maxHp - 30);
    runShipyardRepair(world, 1);
    expect(u.hp).toBe(maxHp - 30);
  });

  it('out-of-range and foreign-owner ships are untouched', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const harbor = completed(world, 'commercialHarbor', f.cx, f.cz);
    const c = buildingCenterWorld(harbor);
    const maxHp = UNIT_DEFS.cargoFreighter.hp;
    const far = spawnUnit(world, 'cargoFreighter', 0, c.x + SHIPYARD_REPAIR_RADIUS + 5, c.z);
    far.hp = maxHp - 30;
    const foe = spawnUnit(world, 'cargoFreighter', 1, c.x, c.z);
    foe.hp = maxHp - 30;
    runShipyardRepair(world, 1);
    expect(far.hp).toBe(maxHp - 30);
    expect(foe.hp).toBe(maxHp - 30);
  });

  it('land units and dead ships are never repaired', () => {
    const t = getTerrain();
    const world = setup();
    const f = findCoastalFootprint(t, 4, 3);
    const harbor = completed(world, 'commercialHarbor', f.cx, f.cz);
    const c = buildingCenterWorld(harbor);
    const truck = spawnUnit(world, 'hauler', 0, c.x, c.z);
    truck.hp = UNIT_DEFS.hauler.hp - 10;
    const wreck = spawnUnit(world, 'cargoFreighter', 0, c.x, c.z);
    wreck.hp = 0;
    runShipyardRepair(world, 1);
    expect(truck.hp).toBe(UNIT_DEFS.hauler.hp - 10);
    expect(wreck.hp).toBe(0);
    expect(isShipUnderRepair(world, wreck)).toBe(false);
  });

  it('repair is deterministic: same script, same hp', () => {
    const t = getTerrain();
    const run = (): number => {
      const world = setup(4242);
      const f = findCoastalFootprint(t, 4, 3);
      const harbor = completed(world, 'commercialHarbor', f.cx, f.cz);
      const u = damagedAt(world, 'cargoFreighter', harbor, 100);
      for (let i = 0; i < 90; i++) runShipyardRepair(world, 1 / 30);
      return u.hp;
    };
    expect(run()).toBe(run());
  });
});
