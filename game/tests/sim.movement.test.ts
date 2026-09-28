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
 * NOVATERRA — sim movement tests (Phase 1, step 6).
 *
 * Covers deterministic pathfinding (A* with corner-cut prevention, water
 * blocking, road costs; chunked Dijkstra flow fields with early exit;
 * time-sliced request processing) and unit movement (waypoint following,
 * arrival slowdown + formation slots, spatial-hash separation, water
 * guard), plus the moveUnit/moveGroup/stopUnit commands, snapshot
 * round-trips of pending/active movement, and digest determinism.
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
import { createTickDriver, TICK_MS, type TickDriver } from '../src/sim/tick';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  heightAt,
  isWater,
  type TerrainData,
} from '../src/sim/terrain';
import {
  MAP_HALF_SIZE,
  cellCoords,
  cellIndex,
  cellIsWater,
} from '../src/sim/city';
import { findUnit, registerUnitCommands } from '../src/sim/units';
import {
  computeFlowField,
  beginFieldBuild,
  stepFieldBuild,
  finishFieldBuild,
  cellMoveCost,
  findPath,
  landComponents,
  fieldReachable,
  passabilityMask,
  worldToCell,
  FIELD_POPS_PER_TICK,
  PATHS_PER_TICK,
} from '../src/sim/pathfinding';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
  slotOffset,
  unitGroundHeight,
  ARRIVAL_RADIUS,
} from '../src/sim/movement';
import { digestWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';

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

function setup(seed = 20260928): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  // Grant manpower for unit spawning (tests don't run the economy).
  for (const p of world.city.players) p.manpower = 100000;
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  const driver = createTickDriver({
    queue,
    systems: [createPathfindingSystem(terrain), createMovementSystem(terrain)],
  });
  return { terrain, world, queue, driver };
}

/** Run N sim ticks through the driver (commands + pathfinding + movement). */
function runTicks(ctx: Ctx, n: number): void {
  stepWorld(ctx.driver, ctx.world, n);
}

function stepWorld(driver: TickDriver, world: World, n: number): void {
  for (let i = 0; i < n; i++) driver.step(world, TICK_MS);
}

/** A fresh driver (empty queue) for a restored world. Shares the terrain. */
function freshDriver(t: TerrainData): TickDriver {
  return createTickDriver({
    queue: createCommandQueue(),
    systems: [createPathfindingSystem(t), createMovementSystem(t)],
  });
}

function enqueue(ctx: Ctx, cmds: Array<Omit<NewCommand, 'issuer'>>): void {
  for (const c of cmds) {
    const full: NewCommand = { issuer: 'player', ...c };
    ctx.queue.enqueue(ctx.world, full);
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
function spawnAt(ctx: Ctx, x: number, z: number, kind = 'rifles', owner = 1): number {
  const id = ctx.world.nextId;
  enqueue(ctx, [{ kind: 'spawnUnit', payload: { kind, owner, x, z } }]);
  runTicks(ctx, 1);
  expect(findUnit(ctx.world, id)).toBeDefined();
  return id;
}

/** All-land clone of a terrain (for synthetic routing tests). */
function flatTerrain(src: TerrainData): TerrainData {
  return {
    ...src,
    name: 'flat-test',
    heights: new Uint16Array(src.heights.length).fill(45000),
  };
}

/** Turn city cells into water by dropping their corner vertices. */
function makeWaterCells(t: TerrainData, cells: Array<[number, number]>): void {
  const V = t.vertsPerSide;
  for (const [cx, cz] of cells) {
    const corners: Array<[number, number]> = [
      [cx, cz],
      [cx + 1, cz],
      [cx, cz + 1],
      [cx + 1, cz + 1],
    ];
    for (const [vx, vz] of corners) {
      (t.heights as Uint16Array)[vz * V + vx] = 0;
    }
  }
}

/** Total path cost under the live cost model (roads + √2 diagonals). */
/** Water test for a cell index (cellIsWater takes coords). */
function cellIdxIsWater(t: TerrainData, cell: number): boolean {
  const { cx, cz } = cellCoords(cell);
  return cellIsWater(t, cx, cz);
}

function pathCost(t: TerrainData, city: { roads: number[] }, path: number[]): number {
  let cost = 0;
  for (let i = 1; i < path.length; i++) {
    const a = cellCoords(path[i - 1] as number);
    const b = cellCoords(path[i] as number);
    const diag = a.cx !== b.cx && a.cz !== b.cz;
    cost += (cellMoveCost(t, city as never, b.cx, b.cz) as number) * (diag ? Math.SQRT2 : 1);
  }
  return cost;
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

describe('moveUnit basics', () => {
  it('moves a unit to its destination and idles', () => {
    const ctx = setup();
    const t = ctx.terrain;
    const start = findLandNear(t, -200, -200);
    const id = spawnAt(ctx, start.x, start.z);
    const dest = findLandNear(t, start.x + 40, start.z + 10);
    const comps = landComponents(t);
    expect(comps[worldToCell(start.x, start.z)]).toBe(comps[worldToCell(dest.x, dest.z)]);
    enqueue(ctx, [{ kind: 'moveUnit', payload: { unitId: id, owner: 1, x: dest.x, z: dest.z } }]);
    runTicks(ctx, 500);
    const u = findUnit(ctx.world, id);
    expect(u?.state).toBe('idle');
    // Snapped exactly to its arrival slot (= destination for single orders).
    expect(u?.x).toBe(dest.x);
    expect(u?.z).toBe(dest.z);
    expect(u?.failReason).toBeNull();
    // Terrain-following height is derived from the heightfield.
    expect(unitGroundHeight(t, u!)).toBe(heightAt(t, u!.x, u!.z));
  });

  it('rejects invalid move orders loudly', () => {
    const ctx = setup();
    const t = ctx.terrain;
    const start = findLandNear(t, -200, -200);
    const id = spawnAt(ctx, start.x, start.z);
    // Water destination.
    let water = { x: 0, z: 0 };
    outer: for (let z = -50; z < 50; z += 4) {
      for (let x = -50; x < 50; x += 4) {
        if (isWater(t, x, z)) { water = { x, z }; break outer; }
      }
    }
    expect(isWater(t, water.x, water.z)).toBe(true);
    expect(
      rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, { issuer: 'player',
          kind: 'moveUnit', payload: { unitId: id, owner: 1, x: water.x, z: water.z },
        }),
      ),
    ).toContain('water');
    // Unknown unit.
    expect(
      rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, { issuer: 'player',
          kind: 'moveUnit', payload: { unitId: 99999, owner: 1, x: start.x, z: start.z },
        }),
      ),
    ).toContain('no unit');
    // Wrong owner.
    expect(
      rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, { issuer: 'player',
          kind: 'moveUnit', payload: { unitId: id, owner: 2, x: start.x, z: start.z },
        }),
      ),
    ).toContain('not owned');
    // Out of map.
    expect(
      rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, { issuer: 'player',
          kind: 'moveUnit', payload: { unitId: id, owner: 1, x: 9999, z: 0 },
        }),
      ),
    ).toContain('outside the map');
  });

  it('stopUnit freezes a moving unit', () => {
    const ctx = setup();
    const t = ctx.terrain;
    const start = findLandNear(t, -200, -200);
    const id = spawnAt(ctx, start.x, start.z);
    const dest = findLandNear(t, start.x + 120, start.z);
    const comps = landComponents(t);
    expect(comps[worldToCell(start.x, start.z)]).toBe(comps[worldToCell(dest.x, dest.z)]);
    enqueue(ctx, [{ kind: 'moveUnit', payload: { unitId: id, owner: 1, x: dest.x, z: dest.z } }]);
    runTicks(ctx, 30);
    const moving = findUnit(ctx.world, id)!;
    expect(moving.state).toBe('moving');
    expect(dist2(moving.x, moving.z, start.x, start.z)).toBeGreaterThan(1);
    enqueue(ctx, [{ kind: 'stopUnit', payload: { unitId: id, owner: 1 } }]);
    runTicks(ctx, 1);
    const stopped = findUnit(ctx.world, id)!;
    expect(stopped.state).toBe('idle');
    const px = stopped.x;
    const pz = stopped.z;
    runTicks(ctx, 60);
    expect(stopped.x).toBe(px);
    expect(stopped.z).toBe(pz);
  });

  it('a later moveUnit replaces an earlier order', () => {
    const ctx = setup();
    const t = ctx.terrain;
    const start = findLandNear(t, -200, -200);
    const id = spawnAt(ctx, start.x, start.z);
    const destA = findLandNear(t, start.x + 40, start.z);
    const destB = findLandNear(t, start.x, start.z + 40);
    enqueue(ctx, [
      { kind: 'moveUnit', payload: { unitId: id, owner: 1, x: destA.x, z: destA.z } },
      { kind: 'moveUnit', payload: { unitId: id, owner: 1, x: destB.x, z: destB.z } },
    ]);
    runTicks(ctx, 500);
    const u = findUnit(ctx.world, id)!;
    expect(u.state).toBe('idle');
    expect(u.x).toBe(destB.x);
    expect(u.z).toBe(destB.z);
  });
});

describe('unreachable orders fail loudly', () => {
  it('a cross-river order fails without moving', () => {
    const ctx = setup();
    const t = ctx.terrain;
    const comps = landComponents(t);
    const start = findLandNear(t, -200, -200);
    const id = spawnAt(ctx, start.x, start.z);
    const dest = findLandNear(t, 200, 100);
    // Self-validating: the test only makes sense across the river.
    expect(comps[worldToCell(start.x, start.z)] as number).not.toBe(
      comps[worldToCell(dest.x, dest.z)] as number,
    );
    enqueue(ctx, [{ kind: 'moveUnit', payload: { unitId: id, owner: 1, x: dest.x, z: dest.z } }]);
    runTicks(ctx, 30);
    const u = findUnit(ctx.world, id)!;
    expect(u.state).toBe('failed');
    expect(u.failReason).toContain('unreachable');
    expect(u.x).toBe(start.x);
    expect(u.z).toBe(start.z);
  });

  it('unreachable group members fail while reachable ones arrive', () => {
    const ctx = setup();
    const t = ctx.terrain;
    const comps = landComponents(t);
    const west = findLandNear(t, -200, -200);
    const east = findLandNear(t, 200, 100);
    expect(comps[worldToCell(west.x, west.z)] as number).not.toBe(
      comps[worldToCell(east.x, east.z)] as number,
    );
    const w1 = spawnAt(ctx, west.x, west.z);
    const w2 = spawnAt(ctx, west.x + 4, west.z);
    const e1 = spawnAt(ctx, east.x, east.z);
    const dest = findLandNear(t, west.x + 40, west.z);
    expect(comps[worldToCell(dest.x, dest.z)]).toBe(comps[worldToCell(west.x, west.z)]);
    enqueue(ctx, [{
      kind: 'moveGroup',
      payload: { unitIds: [w1, w2, e1], owner: 1, x: dest.x, z: dest.z },
    }]);
    runTicks(ctx, 600);
    expect(findUnit(ctx.world, w1)?.state).toBe('idle');
    expect(findUnit(ctx.world, w2)?.state).toBe('idle');
    const stranded = findUnit(ctx.world, e1)!;
    expect(stranded.state).toBe('failed');
    expect(stranded.failReason).toContain('unreachable');
    expect(stranded.x).toBe(east.x);
    expect(stranded.z).toBe(east.z);
  });

  it('moveGroup validates every unit id and owner', () => {
    const ctx = setup();
    const t = ctx.terrain;
    const start = findLandNear(t, -200, -200);
    const id = spawnAt(ctx, start.x, start.z);
    const dest = findLandNear(t, start.x + 20, start.z);
    expect(
      rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, { issuer: 'player',
          kind: 'moveGroup', payload: { unitIds: [id, 424242], owner: 1, x: dest.x, z: dest.z },
        }),
      ),
    ).toContain('no unit');
    expect(
      rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, { issuer: 'player',
          kind: 'moveGroup', payload: { unitIds: [id], owner: 2, x: dest.x, z: dest.z },
        }),
      ),
    ).toContain('not owned');
    expect(
      rejectionReason(() =>
        ctx.queue.enqueue(ctx.world, { issuer: 'player',
          kind: 'moveGroup', payload: { unitIds: [], owner: 1, x: dest.x, z: dest.z },
        }),
      ),
    ).toContain('non-empty');
  });
});

describe('group movement on one flow field', () => {
  it('shares a single field and arrives on deterministic slots without stacking', () => {
    const ctx = setup(777);
    const t = ctx.terrain;
    const comps = landComponents(t);
    const base = findLandNear(t, -200, -200);
    const ids: number[] = [];
    // Tight cluster: 12 civilians on a 4×3 grid, 2 units apart.
    for (let gz = 0; gz < 3; gz++) {
      for (let gx = 0; gx < 4; gx++) {
        const p = findLandNear(t, base.x + gx * 2, base.z + gz * 2);
        ids.push(spawnAt(ctx, p.x, p.z));
      }
    }
    const dest = findLandNear(t, base.x + 60, base.z + 20);
    expect(comps[worldToCell(base.x, base.z)]).toBe(comps[worldToCell(dest.x, dest.z)]);
    enqueue(ctx, [{ kind: 'moveGroup', payload: { unitIds: ids, owner: 1, x: dest.x, z: dest.z } }]);
    // While the field is live, every moving unit references the same one.
    runTicks(ctx, 40);
    const fieldIds = new Set(ids.map((id) => findUnit(ctx.world, id)?.fieldId ?? -1));
    expect(fieldIds.size).toBe(1);
    const fieldId = [...fieldIds][0] as number;
    expect(fieldId).toBeGreaterThan(0);
    expect(ctx.world.pathfinding.fields.length).toBe(1);
    // Let everyone arrive (field build + ~65 units at 6 u/s + slowdown).
    runTicks(ctx, 900);
    const units = ids.map((id) => findUnit(ctx.world, id)!);
    for (const u of units) expect(u.state).toBe('idle');
    // Deterministic slots: exact arrival positions, no stacking.
    let minDist = Infinity;
    for (let i = 0; i < units.length; i++) {
      for (let j = i + 1; j < units.length; j++) {
        minDist = Math.min(minDist, dist2(units[i]!.x, units[i]!.z, units[j]!.x, units[j]!.z));
      }
    }
    expect(minDist).toBeGreaterThan(2.0);
    // Nobody ended up in water, and everyone is near the destination.
    for (const u of units) {
      expect(isWater(t, u.x, u.z)).toBe(false);
      expect(dist2(u.x, u.z, dest.x, dest.z)).toBeLessThan(12);
    }
    // The field is pruned once nobody references it.
    expect(ctx.world.pathfinding.fields.length).toBe(0);
  });

  it('formation slots are a deterministic square spiral', () => {
    // Rank 0 = destination; ring 1 holds 8 slots ~2.5 apart; ring 2 holds 16.
    expect(slotOffset(0)).toEqual([0, 0]);
    const ring1 = [1, 2, 3, 4, 5, 6, 7, 8].map(slotOffset);
    for (const [ox, oz] of ring1) {
      expect(Math.max(Math.abs(ox), Math.abs(oz))).toBeCloseTo(2.5, 9);
    }
    let minDist = Infinity;
    for (let i = 0; i < ring1.length; i++) {
      for (let j = i + 1; j < ring1.length; j++) {
        const [ax, az] = ring1[i] as [number, number];
        const [bx, bz] = ring1[j] as [number, number];
        minDist = Math.min(minDist, dist2(ax, az, bx, bz));
      }
    }
    expect(minDist).toBeCloseTo(2.5, 9);
    const ring2 = [9, 10, 11, 12].map(slotOffset);
    for (const [ox, oz] of ring2) {
      expect(Math.max(Math.abs(ox), Math.abs(oz))).toBeCloseTo(5, 9);
    }
  });
});

describe('separation at exact overlap', () => {
  it('pushes exactly-overlapping units apart instead of stacking them', () => {
    const ctx = setup(4242);
    const t = ctx.terrain;
    const comps = landComponents(t);
    const base = findLandNear(t, -200, -200);
    const dest = findLandNear(t, base.x + 80, base.z);
    expect(comps[worldToCell(base.x, base.z)]).toBe(comps[worldToCell(dest.x, dest.z)]);
    // Two units on the exact same point — the Step 6 gap this covers:
    // combat funnels units onto one target point, and a zero-distance
    // neighbor used to be skipped, stacking them forever. moveGroup is
    // used (not two moveUnits) so both units share one flow field and
    // start moving on the same tick, at exact overlap.
    const idA = spawnAt(ctx, base.x, base.z);
    const idB = spawnAt(ctx, base.x, base.z);
    const lo = Math.min(idA, idB);
    const hi = Math.max(idA, idB);
    enqueue(ctx, [
      { kind: 'moveGroup', payload: { unitIds: [idA, idB], owner: 1, x: dest.x, z: dest.z } },
    ]);
    // Step until both units are moving (shared field => same tick).
    let bothMoving = false;
    for (let i = 0; i < 500 && !bothMoving; i++) {
      runTicks(ctx, 1);
      bothMoving =
        findUnit(ctx.world, lo)?.state === 'moving' &&
        findUnit(ctx.world, hi)?.state === 'moving';
    }
    expect(bothMoving).toBe(true);
    const a = findUnit(ctx.world, lo)!;
    const b = findUnit(ctx.world, hi)!;
    // Separated on the very first shared moving tick — deterministically:
    // lower id toward -x, higher toward +x.
    expect(dist2(a.x, a.z, b.x, b.z)).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(base.x);
    expect(b.x).toBeGreaterThan(base.x);
  });

  it('resolves the overlap identically on repeated runs', () => {
    const runOnce = (): [number, number, number, number] => {
      const ctx = setup(4242);
      const base = findLandNear(ctx.terrain, -200, -200);
      const dest = findLandNear(ctx.terrain, base.x + 80, base.z);
      const idA = spawnAt(ctx, base.x, base.z);
      const idB = spawnAt(ctx, base.x, base.z);
      enqueue(ctx, [
        { kind: 'moveGroup', payload: { unitIds: [idA, idB], owner: 1, x: dest.x, z: dest.z } },
      ]);
      let bothMoving = false;
      for (let i = 0; i < 500 && !bothMoving; i++) {
        runTicks(ctx, 1);
        bothMoving =
          findUnit(ctx.world, idA)?.state === 'moving' &&
          findUnit(ctx.world, idB)?.state === 'moving';
      }
      expect(bothMoving).toBe(true);
      const a = findUnit(ctx.world, idA)!;
      const b = findUnit(ctx.world, idB)!;
      return [a.x, a.z, b.x, b.z];
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

describe('time-sliced request processing', () => {
  it('drains 200 queued path requests within a deterministic bound', () => {
    const ctx = setup(4242);
    const t = ctx.terrain;
    const comps = landComponents(t);
    const comp = comps[worldToCell(-128, -128)] as number;
    // 200 land spawn points on a grid around spawn A (flattened land).
    const spots: Array<{ x: number; z: number }> = [];
    for (let gz = 0; gz < 16 && spots.length < 200; gz++) {
      for (let gx = 0; gx < 16 && spots.length < 200; gx++) {
        const x = -160 + gx * 4;
        const z = -160 + gz * 4;
        if (!isWater(t, x, z) && comps[worldToCell(x, z)] === comp) spots.push({ x, z });
      }
    }
    expect(spots.length).toBe(200);
    // spawnUnit assigns world.nextId sequentially at apply time, in
    // command order — so the ids are firstId .. firstId+199.
    const firstId = ctx.world.nextId;
    for (const s of spots) {
      ctx.queue.enqueue(ctx.world, { issuer: 'player', kind: 'spawnUnit', payload: { kind: 'rifles', owner: 1, x: s.x, z: s.z } });
    }
    runTicks(ctx, 1);
    const ids = spots.map((_, i) => firstId + i);
    for (const id of ids) expect(findUnit(ctx.world, id)).toBeDefined();
    // Every unit gets a nearby same-component destination (~24 units).
    const moves: Array<Omit<NewCommand, 'issuer'>> = ids.map((unitId, i) => {
      const s = spots[i] as { x: number; z: number };
      const d = findLandNear(t, s.x + 24, s.z);
      expect(comps[worldToCell(d.x, d.z)]).toBe(comp);
      return { kind: 'moveUnit', payload: { unitId, owner: 1, x: d.x, z: d.z } };
    });
    enqueue(ctx, moves);
    // PATHS_PER_TICK=3 → 200 requests need 67 ticks; movement ~24u at 6u/s.
    runTicks(ctx, 300);
    expect(ctx.world.pathfinding.queue.length).toBe(0);
    expect(ctx.world.pathfinding.activeBuild).toBeNull();
    for (const id of ids) {
      const u = findUnit(ctx.world, id)!;
      expect(u.state).toBe('idle');
      expect(u.failReason).toBeNull();
    }
  });
});

describe('A* path quality', () => {
  it('avoids water and never cuts corners', () => {
    const t = flatTerrain(getTerrain());
    const city = { roads: [] as number[] };
    makeWaterCells(t, [[10, 10]]);
    const { path } = findPath(t, city as never, cellIndex(8, 8), cellIndex(12, 12));
    expect(path).not.toBeNull();
    // Start (8,8) → goal (12,12); the water cell (10,10) sits on the diagonal.
    for (const cell of path!) {
      expect(cellIdxIsWater(t, cell)).toBe(false);
    }
    // No diagonal step may cut a water corner.
    for (let i = 1; i < path!.length; i++) {
      const a = cellCoords(path![i - 1] as number);
      const b = cellCoords(path![i] as number);
      const dx = b.cx - a.cx;
      const dz = b.cz - a.cz;
      if (Math.abs(dx) === 1 && Math.abs(dz) === 1) {
        expect(cellIsWater(t, a.cx + dx, a.cz)).toBe(false);
        expect(cellIsWater(t, a.cx, a.cz + dz)).toBe(false);
      }
    }
  });

  it('prefers roads: paved route costs less and a road detour wins', () => {
    const t = flatTerrain(getTerrain());
    const city = { roads: [] as number[] };
    const start = cellIndex(20, 25);
    const goal = cellIndex(50, 25);
    const straight = findPath(t, city as never, start, goal).path!;
    expect(straight).not.toBeNull();
    expect(pathCost(t, city, straight)).toBe(30);
    // Pave the straight row: cost halves.
    for (let cx = 20; cx <= 50; cx++) city.roads.push(cellIndex(cx, 25));
    city.roads.sort((a, b) => a - b);
    const paved = findPath(t, city as never, start, goal).path!;
    expect(pathCost(t, city, paved)).toBe(15);
    // Now unpave it and pave a parallel row 5 cells south: the detour wins.
    city.roads.length = 0;
    for (let cx = 20; cx <= 50; cx++) city.roads.push(cellIndex(cx, 30));
    city.roads.sort((a, b) => a - b);
    const detour = findPath(t, city as never, start, goal).path!;
    expect(detour).not.toBeNull();
    // 5 south + 30 east + 5 north = 40 road cells × 0.5 = 20 < 30.
    expect(pathCost(t, city, detour)).toBeLessThan(30);
    const maxDev = Math.max(...detour.map((c) => Math.abs(cellCoords(c).cz - 25)));
    expect(maxDev).toBeGreaterThanOrEqual(4);
  });

  it('cross-component searches fail fast without expanding', () => {
    const t = getTerrain();
    const city = { roads: [] as number[] };
    const comps = landComponents(t);
    const west = worldToCell(-200, -200);
    const east = worldToCell(200, 100);
    expect(comps[west]).not.toBe(comps[east]);
    const start = Date.now();
    const { path, expanded } = findPath(t, city as never, west, east);
    expect(path).toBeNull();
    expect(expanded).toBe(0);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe('chunked flow-field builds', () => {
  it('matches the synchronous flood cell-for-cell', () => {
    const t = flatTerrain(getTerrain());
    const city = { roads: [] as number[] };
    const mask = passabilityMask(t);
    const roads = city.roads;
    const comps = landComponents(t);
    const dest = cellIndex(100, 100);
    expect(comps[dest]).toBeGreaterThanOrEqual(0); // land (components are 0-indexed)
    // Full build in 600-pop chunks.
    const build = beginFieldBuild(1, dest, [], [], mask, roads, comps, false);
    let guard = 0;
    while (!stepFieldBuild(build, mask, roads, FIELD_POPS_PER_TICK) && guard++ < 1000);
    const field = finishFieldBuild(build, mask, roads);
    const sync = computeFlowField(t, city as never, dest);
    expect([...field.dirs]).toEqual([...sync.dirs]);
  });

  it('early exit reaches every waiting unit with identical directions', () => {
    const t = getTerrain();
    const city = { roads: [] as number[] };
    const mask = passabilityMask(t);
    const roads = city.roads;
    const comps = landComponents(t);
    const dest = worldToCell(-100, -200);
    const startA = worldToCell(-200, -200);
    const startB = worldToCell(-210, -190);
    expect(comps[dest]).toBe(comps[startA]);
    expect(comps[dest]).toBe(comps[startB]);
    const build = beginFieldBuild(1, dest, [7, 8], [startA, startB], mask, roads, comps, true);
    let guard = 0;
    while (!stepFieldBuild(build, mask, roads, FIELD_POPS_PER_TICK) && guard++ < 1000);
    const field = finishFieldBuild(build, mask, roads);
    const sync = computeFlowField(t, city as never, dest);
    for (let c = 0; c < field.dirs.length; c++) {
      if (fieldReachable(field, c)) {
        expect(field.dirs[c]).toBe(sync.dirs[c]);
      }
    }
    expect(fieldReachable(field, startA)).toBe(true);
    expect(fieldReachable(field, startB)).toBe(true);
  });
});

describe('snapshots of movement', () => {
  it('round-trips queued path requests through JSON exactly', () => {
    const ctxA = setup(31337);
    const t = ctxA.terrain;
    const base = findLandNear(t, -200, -200);
    // 10 orders, 1 tick: PATHS_PER_TICK=3 completes 3, 7 stay queued.
    const ids: number[] = [];
    for (let i = 0; i < 10; i++) {
      const p = findLandNear(t, base.x + i * 3, base.z);
      ids.push(spawnAt(ctxA, p.x, p.z));
    }
    enqueue(ctxA, ids.map((unitId, i) => {
      const d = findLandNear(t, base.x + 40 + i * 2, base.z + 10);
      return { kind: 'moveUnit', payload: { unitId, owner: 1, x: d.x, z: d.z } };
    }));
    runTicks(ctxA, 1);
    expect(ctxA.world.pathfinding.queue.length).toBe(7);
    const snap = JSON.parse(JSON.stringify(takeSnapshot(ctxA.world))) as never;
    const worldB = restoreSnapshot(snap);
    expect(worldB.pathfinding.queue.length).toBe(7);
    const driverB = freshDriver(t);
    stepWorld(ctxA.driver, ctxA.world, 600);
    stepWorld(driverB, worldB, 600);
    expect(digestWorld(ctxA.world)).toBe(digestWorld(worldB));
    for (const id of ids) expect(findUnit(ctxA.world, id)?.state).toBe('idle');
  });

  it('resumes a mid-field-build identically', () => {
    const ctxA = setup(60606);
    const t = ctxA.terrain;
    const base = findLandNear(t, -200, -200);
    const ids = [0, 1, 2, 3].map((i) => {
      const p = findLandNear(t, base.x + i * 2, base.z);
      return spawnAt(ctxA, p.x, p.z);
    });
    // Long same-component trek so the flood needs many 600-pop chunks.
    const dest = findLandNear(t, base.x + 160, base.z + 40);
    const comps = landComponents(t);
    expect(comps[worldToCell(base.x, base.z)]).toBe(comps[worldToCell(dest.x, dest.z)]);
    enqueue(ctxA, [{ kind: 'moveGroup', payload: { unitIds: ids, owner: 1, x: dest.x, z: dest.z } }]);
    runTicks(ctxA, 6);
    expect(ctxA.world.pathfinding.activeBuild).not.toBeNull();
    const snap = JSON.parse(JSON.stringify(takeSnapshot(ctxA.world))) as never;
    const worldB = restoreSnapshot(snap);
    expect(worldB.pathfinding.activeBuild).not.toBeNull();
    const driverB = freshDriver(t);
    stepWorld(ctxA.driver, ctxA.world, 1200);
    stepWorld(driverB, worldB, 1200);
    expect(digestWorld(ctxA.world)).toBe(digestWorld(worldB));
    for (const id of ids) expect(findUnit(ctxA.world, id)?.state).toBe('idle');
  });
});

describe('determinism', () => {
  it('a 600-tick scripted scenario digests identically', () => {
    function scenario(seed: number): number {
      const ctx = setup(seed);
      const t = ctx.terrain;
      const base = findLandNear(t, -200, -200);
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) {
        const p = findLandNear(t, base.x + i * 3, base.z + (i % 2) * 3);
        ids.push(spawnAt(ctx, p.x, p.z, i % 2 === 0 ? 'rifles' : 'tank'));
      }
      const d1 = findLandNear(t, base.x + 50, base.z);
      const d2 = findLandNear(t, base.x + 10, base.z + 50);
      enqueue(ctx, [
        { kind: 'moveUnit', payload: { unitId: ids[0], owner: 1, x: d1.x, z: d1.z } },
        { kind: 'moveUnit', payload: { unitId: ids[1], owner: 1, x: d2.x, z: d2.z } },
        { kind: 'moveGroup', payload: { unitIds: [ids[2], ids[3], ids[4]], owner: 1, x: d1.x, z: d1.z } },
      ]);
      runTicks(ctx, 120);
      enqueue(ctx, [{ kind: 'stopUnit', payload: { unitId: ids[0], owner: 1 } }]);
      runTicks(ctx, 480);
      return digestWorld(ctx.world);
    }
    const a = scenario(20260928);
    const b = scenario(20260928);
    expect(a).toBe(b);
    expect(scenario(1)).not.toBe(a); // different seed, different world
  });

  it('movement never teleports into water', () => {
    const ctx = setup(99);
    const t = ctx.terrain;
    const base = findLandNear(t, -200, -200);
    const id = spawnAt(ctx, base.x, base.z);
    const dest = findLandNear(t, base.x + 80, base.z + 30);
    enqueue(ctx, [{ kind: 'moveUnit', payload: { unitId: id, owner: 1, x: dest.x, z: dest.z } }]);
    for (let i = 0; i < 500; i++) {
      runTicks(ctx, 1);
      const u = findUnit(ctx.world, id)!;
      expect(isWater(t, u.x, u.z)).toBe(false);
      if (u.state === 'idle') break;
    }
    expect(findUnit(ctx.world, id)?.state).toBe('idle');
  });
});
