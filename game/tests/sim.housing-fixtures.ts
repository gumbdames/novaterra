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
 * Shared fixtures for Fix-3 (demand + utility-gated housing) tests
 * (NOT a test suite — no `.test.ts` suffix, so vitest never runs it
 * directly).
 *
 * Since Fix 3 (2026-10-05), tryAutoDevelop gates residential growth on
 * three conditions: demand (`player.unhousedPopulation > 0`), the
 * sampled cell's zone region being served by the owner's power AND
 * water networks, and positive utility headroom. Tests that exercise
 * organic growth therefore need a *served* region. serveRegionForTest
 * builds one deterministically: a power line + power plant and a water
 * pipe + water pump placed beside the zone's edge, so each plant
 * touches the conductor graph (networked/online) and a region cell
 * sits adjacent to a conductor (served). It returns the derived
 * UtilityModel for runGrowth's model parameter. `which` serves only
 * the power or water half (default 'both') — for tests that pin the
 * gate's AND semantics.
 *
 * Geometry (west side shown; mirrored east when the zone hugs the west
 * map edge). R is the zone's westernmost cell:
 *
 *   [powerPlant 3x3][line] R [pipe]
 *                           [waterPump 2x2, its north cell adjacent
 *                            to the pipe]
 *
 * The plant footprints never overlap the zone (they sit west/east of
 * its edge column), so growth sampling is unaffected. The pipe sits on
 * a zone cell — conductors under zones are normal.
 */
import type { World } from '../src/sim/world';
import {
  cellCoords,
  cellIndex,
  getPlayer,
  inBounds,
  placeBuilding,
  ZoneType,
  type BuildingKind,
} from '../src/sim/city';
import {
  getUtilityModel,
  type UtilityModel,
  type UtilityModelInput,
} from '../src/sim/utilityNetworks';

/** Insert into a sorted number array, keeping it sorted (no dupes). */
function sortedInsert(arr: number[], v: number): void {
  let i = 0;
  while (i < arr.length && (arr[i] as number) < v) i++;
  if (arr[i] !== v) arr.splice(i, 0, v);
}

function placeCompleted(
  world: World,
  kind: BuildingKind,
  owner: number,
  cx: number,
  cz: number,
): number {
  const record = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  record.progress = 1;
  record.operational = true;
  return record.id;
}

/**
 * Serve the zone region(s) containing `zoneCells` for `owner`'s power
 * and water networks and return the derived UtilityModel for
 * runGrowth. Bumps `city.utilityEpoch` (the region/zone cache key) and
 * leaves both plants completed, operational, and online.
 *
 * The same two plants stay online under the real economy tick too
 * (completed + funded + no cross-utility hook), so full-tick tests can
 * rely on the region staying served without calling this again — but
 * note the returned model is a snapshot: direct runGrowth callers must
 * pass it explicitly.
 */
export function serveRegionForTest(
  world: World,
  owner: number,
  zoneCells: number[],
  // 'power' | 'water' serve only that half (for gate-AND tests).
  which: 'both' | 'power' | 'water' = 'both',
): UtilityModel {
  if (zoneCells.length === 0) throw new Error('serveRegionForTest: no zone cells');
  const city = world.city;
  const player = getPlayer(city, owner);
  if (!player) throw new Error(`serveRegionForTest: unknown owner ${owner}`);

  let west: { cx: number; cz: number } | null = null;
  let east: { cx: number; cz: number } | null = null;
  for (const c of zoneCells) {
    const { cx, cz } = cellCoords(c);
    // The plant sits a row north of the edge cell, the pump two rows
    // south — the edge cell needs cz in [1, 253].
    if (cz < 1 || cz > 253) continue;
    if (west === null || cx < west.cx) west = { cx, cz };
    if (east === null || cx > east.cx) east = { cx, cz };
  }
  if (west === null || east === null) throw new Error('serveRegionForTest: no usable edge cell');
  // Infrastructure goes west of the zone; mirror east when the zone
  // hugs the west map edge.
  const R = west.cx >= 4 ? west : east;
  const s = west.cx >= 4 ? -1 : 1;

  const line = { x: R.cx + s, z: R.cz };
  const pipe = { x: R.cx, z: R.cz + 1 };
  // powerPlant 3x3 with a footprint cell adjacent to the line.
  const plant = s === -1
    ? { x: R.cx - 4, z: R.cz - 1 }
    : { x: R.cx - 2, z: R.cz - 1 };
  // waterPump 2x2 with a footprint cell adjacent to the pipe.
  const pump = s === -1
    ? { x: R.cx - 2, z: R.cz + 1 }
    : { x: R.cx + 1, z: R.cz + 1 };
  for (const p of [line, pipe, plant, pump]) {
    if (!inBounds(p.x, p.z)) throw new Error('serveRegionForTest: out of bounds');
  }

  sortedInsert(city.powerLines, cellIndex(line.x, line.z));
  sortedInsert(city.pipes, cellIndex(pipe.x, pipe.z));
  let plantId = -1;
  let pumpId = -1;
  if (which === 'both' || which === 'power') {
    plantId = placeCompleted(world, 'powerPlant', owner, plant.x, plant.z);
  }
  if (which === 'both' || which === 'water') {
    pumpId = placeCompleted(world, 'waterPump', owner, pump.x, pump.z);
  }

  // Region/zone caches key on utilityEpoch — the structural mutation
  // above must invalidate them (the real tick does this in
  // allocateUtilities).
  city.utilityEpoch++;

  const input: UtilityModelInput = {
    power: city.players.map(() => []),
    water: city.players.map(() => []),
    foulers: [],
    treatments: [],
  };
  const pi = city.players.findIndex((p) => p.id === owner);
  const pp = input.power[pi];
  const wp = input.water[pi];
  if (pp === undefined || wp === undefined) throw new Error('serveRegionForTest: owner vanished');
  if (plantId !== -1) pp.push(plantId);
  if (pumpId !== -1) wp.push(pumpId);
  return getUtilityModel(city, input);
}

/**
 * Inject housing demand directly (Fix 3): the organic gate reads
 * `player.unhousedPopulation`, so tests that skip the economy tick
 * set it outright instead of waiting for immigration.
 */
export function injectDemand(world: World, owner: number, unhoused: number): void {
  const player = getPlayer(world.city, owner);
  if (!player) throw new Error(`injectDemand: unknown owner ${owner}`);
  player.unhousedPopulation = unhoused;
}

/**
 * Empty utility model: no plants online, no region served. For tests
 * that call runGrowth directly where the served gate must block (or
 * where growth is already blocked by an earlier gate).
 */
export function emptyUtilityModel(world: World): UtilityModel {
  return getUtilityModel(world.city, {
    power: world.city.players.map(() => []),
    water: world.city.players.map(() => []),
    foulers: [],
    treatments: [],
  });
}

/**
 * Paint a residential zone rectangle directly (Fix 3): records carry
 * `by: owner` (the painter attribution paintZone applies), so
 * immigration attributes the demand to the right owner. Returns the
 * painted cell list for serveRegionForTest.
 */
export function paintResidentialForTest(
  world: World,
  owner: number,
  x0: number,
  z0: number,
  x1: number,
  z1: number,
): number[] {
  const cells: number[] = [];
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const cell = cellIndex(cx, cz);
      cells.push(cell);
      const zi = world.city.zones.findIndex((z) => z.cell === cell);
      if (zi !== -1) world.city.zones.splice(zi, 1);
      world.city.zones.push({ cell, zone: ZoneType.RESIDENTIAL, by: owner });
    }
  }
  world.city.zones.sort((a, b) => a.cell - b.cell);
  return cells;
}
