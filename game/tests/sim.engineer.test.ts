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
 * Engineer triage tests (fun-audit C2a, 2026-10-02).
 *
 * The engineer's job: a living same-owner engineer within
 * ENGINEER_AURA_CELLS cells of a building doubles its construction
 * speed and slowly repairs it when damaged (sim/economy.ts
 * runConstruction). The aura is position-derived — no new sim state,
 * so no snapshot/digest changes; the progress and hp it moves are
 * already digest-covered.
 *
 * Pinned here:
 *  - construction runs at 2x with an engineer on site, 1x without;
 *  - dead engineers, rival engineers, and far-away engineers give no
 *    boost;
 *  - the repair aura restores hp (capped at maxHp) and does nothing
 *    without an engineer.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  BUILDING_DEFS,
  buildingCenterWorld,
  getPlayer,
  type BuildingRecord,
} from '../src/sim/city';
import {
  ENGINEER_AURA_CELLS,
  ENGINEER_CONSTRUCTION_MULT,
  ENGINEER_REPAIR_HP_PER_SEC,
  runEconomyTick,
} from '../src/sim/economy';
import type { UnitRecord } from '../src/sim/units';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import { HUMAN_PLAYER_ID, AI_PLAYER_ID } from '../src/ui/session';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function makeWorld(): World {
  return createWorld(5150);
}

/** A building under construction at (cx, cz). */
function addConstructingBuilding(world: World, cx = 10, cz = 10): BuildingRecord {
  const b = {
    id: world.city.nextBuildingId++,
    kind: 'house',
    owner: HUMAN_PLAYER_ID,
    cx,
    cz,
    facing: 0,
    progress: 0,
    level: 1,
    operational: false,
    powered: false,
    watered: false,
  } as BuildingRecord;
  world.city.buildings.push(b);
  return b;
}

/** A living engineer at the building's footprint center (or offset). */
function addEngineer(
  world: World,
  b: BuildingRecord,
  owner: number,
  dxCells = 0,
  hp = 80,
): UnitRecord {
  const c = buildingCenterWorld(b);
  const u = {
    id: world.nextId++,
    kind: 'engineer',
    owner,
    x: c.x + dxCells * 2,
    z: c.z,
    hp,
    domain: 'land',
  } as UnitRecord;
  world.units.push(u);
  return u;
}

function tickSecond(world: World): void {
  world.tick += 30;
  runEconomyTick(world, getTerrain());
}

describe('engineer construction aura', () => {
  it('doubles construction speed with an engineer on site', () => {
    const plain = makeWorld();
    const boosted = makeWorld();
    const bPlain = addConstructingBuilding(plain);
    const bBoosted = addConstructingBuilding(boosted);
    addEngineer(boosted, bBoosted, HUMAN_PLAYER_ID);
    tickSecond(plain);
    tickSecond(boosted);
    const def = BUILDING_DEFS['house'];
    expect(bPlain.progress).toBeCloseTo(1 / def.buildSeconds, 10);
    expect(bBoosted.progress).toBeCloseTo(
      (ENGINEER_CONSTRUCTION_MULT / def.buildSeconds),
      10,
    );
  });

  it('no boost from a dead engineer', () => {
    const world = makeWorld();
    const b = addConstructingBuilding(world);
    addEngineer(world, b, HUMAN_PLAYER_ID, 0, 0);
    tickSecond(world);
    expect(b.progress).toBeCloseTo(1 / BUILDING_DEFS['house'].buildSeconds, 10);
  });

  it('no boost from a rival engineer', () => {
    const world = makeWorld();
    const b = addConstructingBuilding(world);
    addEngineer(world, b, AI_PLAYER_ID);
    tickSecond(world);
    expect(b.progress).toBeCloseTo(1 / BUILDING_DEFS['house'].buildSeconds, 10);
  });

  it('no boost when the engineer is outside the aura', () => {
    const world = makeWorld();
    const b = addConstructingBuilding(world);
    addEngineer(world, b, HUMAN_PLAYER_ID, ENGINEER_AURA_CELLS + 2);
    tickSecond(world);
    expect(b.progress).toBeCloseTo(1 / BUILDING_DEFS['house'].buildSeconds, 10);
  });

  it('the aura constants are sane', () => {
    expect(ENGINEER_AURA_CELLS).toBe(12);
    expect(ENGINEER_CONSTRUCTION_MULT).toBe(2);
    expect(ENGINEER_REPAIR_HP_PER_SEC).toBe(1);
  });
});

describe('engineer repair aura', () => {
  function addDamagedBuilding(world: World): BuildingRecord {
    const b = addConstructingBuilding(world);
    b.progress = 1;
    b.operational = true;
    const def = BUILDING_DEFS['house'];
    b.maxHp = def.hp;
    b.hp = Math.floor(def.hp / 2);
    return b;
  }

  it('repairs a damaged completed building with an engineer nearby', () => {
    const world = makeWorld();
    const b = addDamagedBuilding(world);
    const hpBefore = b.hp ?? 0;
    addEngineer(world, b, HUMAN_PLAYER_ID);
    tickSecond(world);
    expect(b.hp).toBe(hpBefore + ENGINEER_REPAIR_HP_PER_SEC);
  });

  it('does not repair without an engineer', () => {
    const world = makeWorld();
    const b = addDamagedBuilding(world);
    const hpBefore = b.hp ?? 0;
    tickSecond(world);
    expect(b.hp).toBe(hpBefore);
  });

  it('repair never exceeds maxHp', () => {
    const world = makeWorld();
    const b = addDamagedBuilding(world);
    const def = BUILDING_DEFS['house'];
    b.hp = def.hp - 0.5;
    addEngineer(world, b, HUMAN_PLAYER_ID);
    tickSecond(world);
    expect(b.hp).toBe(def.hp);
  });

  it('does not repair buildings under construction', () => {
    const world = makeWorld();
    const b = addConstructingBuilding(world);
    const def = BUILDING_DEFS['house'];
    b.hp = Math.floor(def.hp / 2);
    addEngineer(world, b, HUMAN_PLAYER_ID);
    tickSecond(world);
    // The aura builds (progress advanced) instead of healing.
    expect(b.progress).toBeGreaterThan(0);
    expect(b.hp).toBe(Math.floor(def.hp / 2));
  });
});
