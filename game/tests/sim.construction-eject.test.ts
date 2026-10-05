/**
 * Unit/building-overlap regression suite (2026-10-05).
 *
 * Covers the construction-window hole: validatePlacement only checked
 * unit occupancy at placement time, so units that walked onto a site
 * during the 10–100+ sim-second build were swallowed when the building
 * completed around them. Fixes: eject-on-completion (Fix A),
 * footprint-checked move destinations (Fix B), footprint-aware train
 * spawns + rally points, mission preplaced validation, and load-time
 * repair of pre-fix saves.
 *
 * All headless — no DOM, no canvas, no wall clock.
 */
import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import {
  createCommandQueue,
  registerCoreCommands,
  CommandRejectedError,
} from '../src/sim/commands';
import { registerCityCommands } from '../src/sim/city';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  cellIndex,
  cellIsWater,
  footprintCells,
  placeBuilding,
  validatePlacement,
  findFreeSpawnPoint,
  findFreeFootprintAnchor,
  unitsOnFootprint,
  type BuildingKind,
  type Placement,
} from '../src/sim/city';
import { runEconomyTick } from '../src/sim/economy';
import { spawnUnit } from '../src/sim/units';
import { runTraining } from '../src/sim/units';
import { registerUnitCommands } from '../src/sim/units';
import {
  createMovementSystem,
  createPathfindingSystem,
  registerMovementCommands,
  orderMoveTo,
} from '../src/sim/movement';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';
import type { TerrainData } from '../src/sim/terrain';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { createSession } from '../src/ui/session';
import { MISSIONS } from '../src/campaign/missions';
import { grantAllTrainingResources } from './sim.roster-fixtures';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function findLand(terrain: TerrainData, fromCx: number, fromCz: number): { cx: number; cz: number } {
  for (let r = 0; r < 40; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = fromCx + dx;
        const cz = fromCz + dz;
        if (!cellIsWater(terrain, cx, cz)) return { cx, cz };
      }
    }
  }
  throw new Error('no land');
}

function unitCellOf(u: { x: number; z: number }): number {
  const cx = Math.floor((u.x + 256) / 2);
  const cz = Math.floor((u.z + 256) / 2);
  return cellIndex(cx, cz);
}

function footprintSet(b: { cx: number; cz: number }, kind: BuildingKind): Set<number> {
  const def = BUILDING_DEFS[kind];
  return new Set(footprintCells(b.cx, b.cz, def.footprintW, def.footprintH));
}

describe('construction eject (Fix A)', () => {
  it('a unit that walks onto a construction site is ejected when the building completes', () => {
    const terrain = getTerrain();
    const world = createWorld(42);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    const driver = createTickDriver({
      queue,
      systems: [createPathfindingSystem(terrain), createMovementSystem(terrain)],
    });

    const site = findLand(terrain, 120, 120);
    const eng = spawnUnit(world, 'engineer', 0, cellCenterWorld(site.cx + 6), cellCenterWorld(site.cz));
    expect(eng).toBeDefined();

    const p: Placement = { kind: 'house', owner: 0, cx: site.cx, cz: site.cz, facing: 0 };
    const b = placeBuilding(world.city, p, 42);
    expect(b.progress).toBeLessThan(1);

    // Order the engineer onto the CENTER of the construction footprint.
    // (Direct orderMoveTo, bypassing the command layer — Fix B guards
    // the commands; this test exercises the Fix A backstop.)
    const def = BUILDING_DEFS['house' as BuildingKind];
    const fcx = site.cx + Math.floor(def.footprintW / 2);
    const fcz = site.cz + Math.floor(def.footprintH / 2);
    orderMoveTo(world, eng!, cellCenterWorld(fcx), cellCenterWorld(fcz));

    // Realistic cadence: economy ticks are 1 Hz. The engineer arrives
    // well before the 10s build finishes.
    let completedAt = -1;
    for (let tick = 0; tick < 30 * 300; tick++) {
      driver.step(world, TICK_MS);
      if (tick % 30 === 0) runEconomyTick(world, terrain);
      if (b.progress >= 1 && completedAt < 0) completedAt = tick;
      if (completedAt >= 0 && tick > completedAt + 30 * 10) break;
    }
    expect(completedAt).toBeGreaterThanOrEqual(0);

    // The unit must be OUTSIDE the finished footprint and stopped.
    const cells = footprintSet(b, 'house' as BuildingKind);
    expect(cells.has(unitCellOf(eng!))).toBe(false);
    expect(eng!.state).toBe('idle');
    expect(eng!.hp).toBeGreaterThan(0);
  });
});

describe('move destination footprint guard (Fix B)', () => {
  function setup() {
    const terrain = getTerrain();
    const world = createWorld(43);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    registerMovementCommands(queue, terrain);
    const site = findLand(terrain, 100, 100);
    const b = placeBuilding(
      world.city,
      { kind: 'house', owner: 0, cx: site.cx, cz: site.cz, facing: 0 },
      43,
    );
    b.progress = 1;
    const def = BUILDING_DEFS['house' as BuildingKind];
    const fx = cellCenterWorld(site.cx + Math.floor(def.footprintW / 2));
    const fz = cellCenterWorld(site.cz + Math.floor(def.footprintH / 2));
    return { world, queue, fx, fz };
  }

  it('moveUnit rejects a destination inside a building footprint', () => {
    const { world, queue, fx, fz } = setup();
    const eng = spawnUnit(world, 'engineer', 0, fx + 20, fz);
    expect(() =>
      queue.enqueue(world, { issuer: 'player', kind: 'moveUnit', payload: { unitId: eng!.id, owner: 0, x: fx, z: fz } }),
    ).toThrow(CommandRejectedError);
  });

  it('moveGroup and attackMove reject footprint destinations too', () => {
    const { world, queue, fx, fz } = setup();
    const e1 = spawnUnit(world, 'engineer', 0, fx + 20, fz);
    const e2 = spawnUnit(world, 'engineer', 0, fx + 24, fz);
    const ids = [e1!.id, e2!.id];
    expect(() =>
      queue.enqueue(world, { issuer: 'player', kind: 'moveGroup', payload: { unitIds: ids, owner: 0, x: fx, z: fz } }),
    ).toThrow(CommandRejectedError);
    expect(() =>
      queue.enqueue(world, { issuer: 'player', kind: 'attackMove', payload: { unitIds: ids, owner: 0, x: fx, z: fz } }),
    ).toThrow(CommandRejectedError);
  });

  it('air units may still fly over footprints', () => {
    const { world, queue, fx, fz } = setup();
    const jet = spawnUnit(world, 'fighter', 0, fx + 40, fz);
    expect(() =>
      queue.enqueue(world, { issuer: 'player', kind: 'moveUnit', payload: { unitId: jet!.id, owner: 0, x: fx, z: fz } }),
    ).not.toThrow();
  });

  it('destinations outside footprints are unaffected', () => {
    const { world, queue, fx, fz } = setup();
    const eng = spawnUnit(world, 'engineer', 0, fx + 20, fz);
    expect(() =>
      queue.enqueue(world, { issuer: 'player', kind: 'moveUnit', payload: { unitId: eng!.id, owner: 0, x: fx + 20, z: fz + 20 } }),
    ).not.toThrow();
  });
});

describe('train spawn + rally footprint guards', () => {
  it('trained units spawn outside the production footprint, even for large buildings', () => {
    const terrain = getTerrain();
    const world = createWorld(44);
    const site = findLand(terrain, 90, 90);
    // Barracks is 3×3: ring 1 of the old scan sat inside its own mesh.
    const b = placeBuilding(
      world.city,
      { kind: 'barracks', owner: 0, cx: site.cx, cz: site.cz, facing: 0 },
      44,
    );
    b.progress = 1;
    b.operational = true;
    b.trainQueue = [{ kind: 'rifles', ticksLeft: 0 }];
    const before = world.units.length;
    runTraining(world, terrain);
    expect(world.units.length).toBe(before + 1);
    const spawned = world.units[world.units.length - 1]!;
    const cells = footprintSet(b, 'barracks' as BuildingKind);
    expect(cells.has(unitCellOf(spawned))).toBe(false);
  });

  it('setRallyPoint rejects a rally inside a building footprint', () => {
    const terrain = getTerrain();
    const world = createWorld(45);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerCityCommands(queue, terrain);
    registerUnitCommands(queue, terrain);
    const site = findLand(terrain, 80, 80);
    const b = placeBuilding(
      world.city,
      { kind: 'barracks', owner: 0, cx: site.cx, cz: site.cz, facing: 0 },
      45,
    );
    b.progress = 1;
    const def = BUILDING_DEFS['barracks' as BuildingKind];
    const fx = cellCenterWorld(site.cx + Math.floor(def.footprintW / 2));
    const fz = cellCenterWorld(site.cz + Math.floor(def.footprintH / 2));
    expect(() =>
      queue.enqueue(world, {
        issuer: 'player',
        kind: 'setRallyPoint',
        payload: { owner: 0, buildingId: b.id, x: fx, z: fz },
      }),
    ).toThrow(CommandRejectedError);
  });
});

describe('load-time repair (Optional 2)', () => {
  it('restoreSnapshot ejects units entombed in footprints when terrain is provided', () => {
    const terrain = getTerrain();
    const world = createWorld(46);
    const site = findLand(terrain, 70, 70);
    const b = placeBuilding(
      world.city,
      { kind: 'house', owner: 0, cx: site.cx, cz: site.cz, facing: 0 },
      46,
    );
    b.progress = 1;
    const def = BUILDING_DEFS['house' as BuildingKind];
    const fx = cellCenterWorld(site.cx + Math.floor(def.footprintW / 2));
    const fz = cellCenterWorld(site.cz + Math.floor(def.footprintH / 2));
    const eng = spawnUnit(world, 'engineer', 0, fx, fz);
    const cells = footprintSet(b, 'house' as BuildingKind);
    expect(cells.has(unitCellOf(eng!))).toBe(true); // entombed, pre-fix style

    const snap = takeSnapshot(world);
    const restored = restoreSnapshot(snap, terrain);
    const reng = restored.units.find((u) => u.id === eng!.id)!;
    expect(cells.has(unitCellOf(reng))).toBe(false);
    expect(reng.state).toBe('idle');
  });
});

describe('mission preplaced validation (Optional 1)', () => {
  it('M1 preplaced buildings do not entomb starting units', () => {
    const m1 = MISSIONS.find((m) => m.id === 'first-day');
    expect(m1).toBeDefined();
    const session = createSession({ seed: 4242, campaignMission: m1! });
    const { world } = session;
    for (const b of world.city.buildings) {
      const cells = footprintSet(b, b.kind as BuildingKind);
      for (const u of world.units) {
        expect(cells.has(unitCellOf(u))).toBe(false);
      }
    }
  });

  it('validatePlacement rejects unit-occupied footprints (the t=0 guard)', () => {
    const terrain = getTerrain();
    const world = createWorld(47);
    const site = findLand(terrain, 60, 60);
    // powerPlant is UTILITY_ZONE: skips the zoning gate so the test
    // reaches the unit-occupancy check.
    const def = BUILDING_DEFS['powerPlant' as BuildingKind];
    const fx = cellCenterWorld(site.cx + Math.floor(def.footprintW / 2));
    const fz = cellCenterWorld(site.cz + Math.floor(def.footprintH / 2));
    spawnUnit(world, 'engineer', 0, fx, fz);
    const err = validatePlacement(
      terrain,
      world.city,
      { kind: 'powerPlant', owner: 0, cx: site.cx, cz: site.cz, facing: 0 },
      world.units,
    );
    expect(err).toContain('footprint occupied by a unit');
  });
});

describe('spawnUnit footprint nudge (Fix 5)', () => {
  function setupSpawn() {
    const terrain = getTerrain();
    const world = createWorld(48);
    grantAllTrainingResources(world);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    const driver = createTickDriver({ queue, systems: [] });
    return { terrain, world, queue, driver };
  }

  it('a spawn requested inside a building footprint is nudged outside it', () => {
    const { terrain, world, queue, driver } = setupSpawn();
    const site = findLand(terrain, 90, 90);
    const b = placeBuilding(
      world.city,
      { kind: 'barracks', owner: 0, cx: site.cx, cz: site.cz, facing: 0 },
      48,
    );
    b.progress = 1;
    // Barracks is 3×3: its center sits inside its own footprint.
    const def = BUILDING_DEFS['barracks' as BuildingKind];
    const fx = cellCenterWorld(site.cx + Math.floor(def.footprintW / 2));
    const fz = cellCenterWorld(site.cz + Math.floor(def.footprintH / 2));
    queue.enqueue(world, {
      issuer: 'player',
      kind: 'spawnUnit',
      payload: { kind: 'engineer', owner: 0, x: fx, z: fz },
    });
    driver.step(world, TICK_MS);
    const spawned = world.units[world.units.length - 1]!;
    const cells = footprintSet(b, 'barracks' as BuildingKind);
    expect(cells.has(unitCellOf(spawned))).toBe(false);
  });

  it('a spawn on a free cell keeps its exact coordinates (no digest churn)', () => {
    const { world, queue, driver } = setupSpawn();
    const terrain = getTerrain();
    const site = findLand(terrain, 90, 90);
    const x = cellCenterWorld(site.cx) + 0.25;
    const z = cellCenterWorld(site.cz) - 0.5;
    queue.enqueue(world, {
      issuer: 'player',
      kind: 'spawnUnit',
      payload: { kind: 'engineer', owner: 0, x, z },
    });
    driver.step(world, TICK_MS);
    const spawned = world.units[world.units.length - 1]!;
    expect(spawned.x).toBe(x);
    expect(spawned.z).toBe(z);
  });
});

describe('findFreeSpawnPoint (Fix 5)', () => {
  /** A dry cell adjacent to water (for the domain water-rule tests). */
  function findCoast(terrain: TerrainData): { cx: number; cz: number; wx: number; wz: number } {
    for (let cz = 60; cz < 200; cz++) {
      for (let cx = 60; cx < 200; cx++) {
        if (cellIsWater(terrain, cx, cz)) continue;
        const wet: Array<[number, number]> = [
          [cx + 1, cz],
          [cx - 1, cz],
          [cx, cz + 1],
          [cx, cz - 1],
        ];
        for (const [wx, wz] of wet) {
          if (cellIsWater(terrain, wx, wz)) return { cx, cz, wx, wz };
        }
      }
    }
    throw new Error('no coast');
  }

  function spotCell(terrain: TerrainData, spot: { x: number; z: number }): { cx: number; cz: number; wet: boolean } {
    const cx = Math.floor((spot.x + 256) / 2);
    const cz = Math.floor((spot.z + 256) / 2);
    return { cx, cz, wet: cellIsWater(terrain, cx, cz) };
  }

  it('nudges a land spawn off water onto dry land', () => {
    const terrain = getTerrain();
    const world = createWorld(49);
    const coast = findCoast(terrain);
    const spot = findFreeSpawnPoint(
      world.city,
      cellCenterWorld(coast.wx),
      cellCenterWorld(coast.wz),
      (x, z) => cellIsWater(terrain, x, z),
      'land',
    );
    expect(spot).not.toBeNull();
    expect(spotCell(terrain, spot!).wet).toBe(false);
  });

  it('keeps a sea spawn on water (never beaches the ship)', () => {
    const terrain = getTerrain();
    const world = createWorld(50);
    const coast = findCoast(terrain);
    const spot = findFreeSpawnPoint(
      world.city,
      cellCenterWorld(coast.cx),
      cellCenterWorld(coast.cz),
      (x, z) => cellIsWater(terrain, x, z),
      'sea',
    );
    expect(spot).not.toBeNull();
    expect(spotCell(terrain, spot!).wet).toBe(true);
  });

  it('nudges a spawn out of a building footprint', () => {
    const terrain = getTerrain();
    const world = createWorld(51);
    const site = findLand(terrain, 90, 90);
    const b = placeBuilding(
      world.city,
      { kind: 'barracks', owner: 0, cx: site.cx, cz: site.cz, facing: 0 },
      51,
    );
    b.progress = 1;
    const def = BUILDING_DEFS['barracks' as BuildingKind];
    const fx = cellCenterWorld(site.cx + Math.floor(def.footprintW / 2));
    const fz = cellCenterWorld(site.cz + Math.floor(def.footprintH / 2));
    const spot = findFreeSpawnPoint(
      world.city,
      fx,
      fz,
      (x, z) => cellIsWater(terrain, x, z),
      'land',
    );
    expect(spot).not.toBeNull();
    const cells = footprintSet(b, 'barracks' as BuildingKind);
    const sc = spotCell(terrain, spot!);
    expect(cells.has(cellIndex(sc.cx, sc.cz))).toBe(false);
  });

  it('returns the exact requested position when its cell is already free', () => {
    const terrain = getTerrain();
    const world = createWorld(52);
    const site = findLand(terrain, 90, 90);
    const x = cellCenterWorld(site.cx) + 0.25;
    const z = cellCenterWorld(site.cz) - 0.5;
    const spot = findFreeSpawnPoint(
      world.city,
      x,
      z,
      (x2, z2) => cellIsWater(terrain, x2, z2),
      'land',
    );
    expect(spot).toEqual({ x, z });
  });

  it('returns null when no free cell exists (the caller keeps the request)', () => {
    const world = createWorld(53);
    const spot = findFreeSpawnPoint(world.city, 0, 0, () => true, 'land');
    expect(spot).toBeNull();
  });
});

describe('findFreeFootprintAnchor unit-awareness (Fix 6)', () => {
  it('the anchor search never lands a nudged building on another unit', () => {
    const terrain = getTerrain();
    const world = createWorld(54);
    const site = findLand(terrain, 40, 40);
    const def = BUILDING_DEFS['house' as BuildingKind]; // 2×2
    // Unit A sits on the original anchor (the nudge trigger); unit B
    // stands one cell east — the old spiral's first ring-1 candidate
    // (cx+1, cz) would have entombed B.
    spawnUnit(world, 'engineer', 0, cellCenterWorld(site.cx), cellCenterWorld(site.cz));
    spawnUnit(world, 'engineer', 0, cellCenterWorld(site.cx + 1), cellCenterWorld(site.cz));
    expect(unitsOnFootprint(world.units, site.cx, site.cz, def.footprintW, def.footprintH)).toBe(true);
    const anchor = findFreeFootprintAnchor(
      world.city,
      site.cx,
      site.cz,
      def.footprintW,
      def.footprintH,
      (x, z) => cellIsWater(terrain, x, z),
      world.units,
    );
    expect(anchor).not.toBeNull();
    // The anchor moved off the occupied original...
    expect(anchor!.cx !== site.cx || anchor!.cz !== site.cz).toBe(true);
    // ...and no living unit stands inside the nudged footprint.
    const cells = new Set(footprintCells(anchor!.cx, anchor!.cz, def.footprintW, def.footprintH));
    for (const u of world.units) {
      expect(cells.has(unitCellOf(u))).toBe(false);
    }
  });

  it('without units the search behaves as before (the param is optional)', () => {
    const terrain = getTerrain();
    const world = createWorld(55);
    const site = findLand(terrain, 40, 40);
    const def = BUILDING_DEFS['house' as BuildingKind];
    const anchor = findFreeFootprintAnchor(
      world.city,
      site.cx,
      site.cz,
      def.footprintW,
      def.footprintH,
      (x, z) => cellIsWater(terrain, x, z),
    );
    expect(anchor).toEqual({ cx: site.cx, cz: site.cz });
  });
});
