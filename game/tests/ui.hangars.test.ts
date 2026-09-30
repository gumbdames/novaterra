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
 * NOVATERRA — grand-expansion Phase 5 (workstream B): the ui/hangars.ts
 * contract module tests (0.1 Alpha).
 *
 * The module is pure and headless-safe: it reads the sim's hangar
 * fields defensively and never writes sim state. These tests pin the
 * UI gates (carriers train EMPTY + only carrier-capable aircraft may
 * embark — the user requirement) and the display lines / block reasons
 * the HUD renders.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import {
  isSheltered,
  spawnUnit,
  UNIT_DEFS,
  type UnitRecord,
} from '../src/sim/units';
import { defaultHangarSlots, cellCenterWorld, type BuildingRecord } from '../src/sim/city';
import {
  baseBlockReason,
  canBaseUI,
  canEmbarkUI,
  canLaunchUI,
  embarkBlockReason,
  embarkedAircraft,
  hangarLine,
  nearestCarrier,
  nearestHangarBuilding,
  parkedAircraft,
  shelterLine,
  wingLine,
} from '../src/ui/hangars';
import {
  buildBaseOrder,
  buildEmbarkOrder,
  buildLaunchOrder,
} from '../src/ui/orders';

function makeWorld() {
  const world = createWorld(4242);
  return world;
}

function addBuilding(world: ReturnType<typeof createWorld>, kind: 'airfield' | 'hangarS'): BuildingRecord {
  // Place at the cell whose center is nearest the origin, so spawned
  // aircraft at small world coords are in basing range.
  const cx = 64;
  const cz = 64;
  const b: BuildingRecord = {
    id: world.city.nextBuildingId++,
    kind,
    owner: 0,
    cx,
    cz,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
    hangars: defaultHangarSlots(kind),
  };
  world.city.buildings.push(b);
  return b;
}

/** World position near a test building (for spawning in-range aircraft). */
function nearBuilding(b: BuildingRecord): { x: number; z: number } {
  return { x: cellCenterWorld(b.cx) + 5, z: cellCenterWorld(b.cz) };
}

describe('embark UI gate', () => {
  it('canEmbarkUI: only living, free, carrier-capable aircraft', () => {
    const world = makeWorld();
    const jet = spawnUnit(world, 'navalFighter', 0, 0, 0);
    expect(UNIT_DEFS.navalFighter.carrierCapable).toBe(true);
    expect(canEmbarkUI(jet)).toBe(true);
    // Not carrier-capable.
    const fighter = spawnUnit(world, 'fighter', 0, 10, 0);
    expect(canEmbarkUI(fighter)).toBe(false);
    // Not an aircraft.
    const tank = spawnUnit(world, 'tank', 0, 20, 0);
    expect(canEmbarkUI(tank)).toBe(false);
    // Dead.
    const dead = spawnUnit(world, 'navalFighter', 0, 30, 0);
    dead.hp = 0;
    expect(canEmbarkUI(dead)).toBe(false);
    // Already sheltered.
    jet.embarkedOn = 999;
    expect(isSheltered(jet)).toBe(true);
    expect(canEmbarkUI(jet)).toBe(false);
  });

  it('embarkBlockReason names the blocker in sim-validate order', () => {
    const world = makeWorld();
    const carrier = spawnUnit(world, 'carrier', 0, 100, 100);
    const jet = spawnUnit(world, 'navalFighter', 0, 0, 0);
    // Too far.
    expect(embarkBlockReason(world, jet, carrier)).toBe('Too far from the carrier');
    // In range: legal.
    jet.x = 105;
    jet.z = 100;
    expect(embarkBlockReason(world, jet, carrier)).toBeNull();
    // Non-carrier-capable.
    const fighter = spawnUnit(world, 'fighter', 0, 105, 100);
    expect(embarkBlockReason(world, fighter, carrier)).toBe('Not carrier-capable');
    // Wrong owner.
    const enemy = spawnUnit(world, 'navalFighter', 1, 105, 100);
    expect(embarkBlockReason(world, enemy, carrier)).toBe('Not your carrier');
  });

  it('nearestCarrier proposes the closest friendly carrier in range', () => {
    const world = makeWorld();
    const far = spawnUnit(world, 'carrier', 0, 500, 500);
    const near = spawnUnit(world, 'carrier', 0, 30, 0);
    const jet = spawnUnit(world, 'navalFighter', 0, 0, 0);
    expect(nearestCarrier(world, jet)?.id).toBe(near.id);
    expect(nearestCarrier(world, jet)?.id).not.toBe(far.id);
    // No carrier in range at all.
    const lone = spawnUnit(world, 'navalFighter', 0, -400, -400);
    expect(nearestCarrier(world, lone)).toBeNull();
  });
});

describe('base UI gate', () => {
  it('canBaseUI: living, free aircraft; canLaunchUI: sheltered only', () => {
    const world = makeWorld();
    const jet = spawnUnit(world, 'fighter', 0, 0, 0);
    expect(canBaseUI(jet)).toBe(true);
    expect(canLaunchUI(jet)).toBe(false);
    jet.hangarBuildingId = 42;
    expect(canBaseUI(jet)).toBe(false);
    expect(canLaunchUI(jet)).toBe(true);
  });

  it('baseBlockReason names the blocker', () => {
    const world = makeWorld();
    const airfield = addBuilding(world, 'airfield');
    const bp = nearBuilding(airfield);
    const jet = spawnUnit(world, 'fighter', 0, bp.x, bp.z);
    expect(baseBlockReason(world, jet, airfield)).toBeNull();
    // Incomplete building.
    airfield.progress = 0.5;
    expect(baseBlockReason(world, jet, airfield)).toBe('Building not completed');
    airfield.progress = 1;
    // No compatible free slot (light-only slots vs a medium aircraft).
    const light = addBuilding(world, 'hangarS');
    expect(baseBlockReason(world, jet, light)).toBe('No free hangar of that size');
    // A light aircraft fits the light hangar.
    const lp = nearBuilding(light);
    const drone = spawnUnit(world, 'drone', 0, lp.x, lp.z);
    expect(baseBlockReason(world, drone, light)).toBeNull();
    // Too far.
    const far = spawnUnit(world, 'drone', 0, 1000, 1000);
    expect(baseBlockReason(world, far, light)).toBe('Too far from the airfield');
  });

  it('nearestHangarBuilding only proposes buildings with a fitting free slot', () => {
    const world = makeWorld();
    addBuilding(world, 'hangarS'); // light-only
    const lp = nearBuilding(world.city.buildings[0]!);
    const jet = spawnUnit(world, 'fighter', 0, lp.x, lp.z); // medium
    expect(nearestHangarBuilding(world, jet)).toBeNull();
    const drone = spawnUnit(world, 'drone', 0, lp.x, lp.z); // light
    expect(nearestHangarBuilding(world, drone)).not.toBeNull();
  });
});

describe('display lines', () => {
  it('wingLine shows occupancy over the def capacity', () => {
    const world = makeWorld();
    const carrier = spawnUnit(world, 'carrier', 0, 0, 0);
    expect(wingLine(world, carrier)).toBe('Wing 0/8');
    const jet = spawnUnit(world, 'navalFighter', 0, 0, 0);
    jet.embarkedOn = carrier.id;
    expect(wingLine(world, carrier)).toBe('Wing 1/8');
    // Non-carriers render no wing line.
    const tank = spawnUnit(world, 'tank', 0, 0, 0);
    expect(wingLine(world, tank)).toBe('');
  });

  it('hangarLine shows used/total slots', () => {
    const world = makeWorld();
    const airfield = addBuilding(world, 'airfield');
    expect(hangarLine(airfield)).toBe('Hangars 0/6');
    airfield.hangars![0]!.occupant = 7;
    airfield.hangars![3]!.occupant = 9;
    expect(hangarLine(airfield)).toBe('Hangars 2/6');
    const barracks: BuildingRecord = {
      id: 99, kind: 'barracks', owner: 0, cx: 0, cz: 0, facing: 0,
      progress: 1, level: 1, operational: true, powered: true, watered: true,
    };
    expect(hangarLine(barracks)).toBe('');
  });

  it('shelterLine names where the aircraft is sheltered', () => {
    const world = makeWorld();
    const jet = spawnUnit(world, 'fighter', 0, 0, 0);
    expect(shelterLine(world, jet)).toBe('');
    jet.hangarBuildingId = 11;
    expect(shelterLine(world, jet)).toBe('Parked in hangar');
    jet.hangarBuildingId = 0;
    const carrier = spawnUnit(world, 'carrier', 0, 0, 0);
    jet.embarkedOn = carrier.id;
    expect(shelterLine(world, jet)).toBe('Embarked on carrier');
  });

  it('parkedAircraft / embarkedAircraft list in id order', () => {
    const world = makeWorld();
    const airfield = addBuilding(world, 'airfield');
    const carrier = spawnUnit(world, 'carrier', 0, 0, 0);
    const c = spawnUnit(world, 'drone', 0, 0, 0);
    const a = spawnUnit(world, 'drone', 0, 0, 0);
    const b = spawnUnit(world, 'drone', 0, 0, 0);
    c.hangarBuildingId = airfield.id;
    a.hangarBuildingId = airfield.id;
    b.embarkedOn = carrier.id;
    expect(parkedAircraft(world, airfield.id).map((u: UnitRecord) => u.id)).toEqual(
      [c.id, a.id].sort((x, y) => x - y),
    );
    expect(embarkedAircraft(world, carrier.id).map((u: UnitRecord) => u.id)).toEqual([b.id]);
  });
});

describe('order builders', () => {
  it('shape the three hangar command payloads exactly', () => {
    expect(buildEmbarkOrder(3, 7, 0)).toEqual({
      kind: 'embarkAircraft',
      payload: { unitId: 3, carrierId: 7, owner: 0 },
    });
    expect(buildBaseOrder(3, 9, 0)).toEqual({
      kind: 'baseAircraft',
      payload: { unitId: 3, buildingId: 9, owner: 0 },
    });
    expect(buildLaunchOrder(3, 0)).toEqual({
      kind: 'launchAircraft',
      payload: { unitId: 3, owner: 0 },
    });
  });
});
