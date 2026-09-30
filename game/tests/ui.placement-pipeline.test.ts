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
 * NOVATERRA — placement pipeline regression test (ui/orders → session →
 * command queue → sim apply).
 *
 * Guards the core gameplay loop the player uses every session: click the
 * train/build palette, click the map, and get a unit / building / road with
 * the costs deducted. Drives the exact same builders the click path calls
 * (`buildTrainOrder`, `buildPlaceBuildingOrder`, `buildRoadOrder`) through
 * `session.enqueuePlayerIntent` (which is what the game controller calls)
 * and `session.tick()` (which applies due commands), then asserts the
 * sim-side outcome: order accepted, entity under construction/spawned,
 * funds and manpower deducted.
 *
 * Also asserts that invalid placements are LOUD: the queue throws
 * `CommandRejectedError` with a human-readable reason (the controller
 * turns this into an error toast — nothing fails silently).
 *
 * Headless-safe: no DOM, no three.js.
 */

import { describe, expect, it } from 'vitest';

import { CommandRejectedError } from '../src/sim/commands';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  cellIsWater,
  CITY_GRID_CELLS,
  ROAD_COST_FUNDS,
  ROAD_COST_MATERIALS,
} from '../src/sim/city';
import { UNIT_DEFS } from '../src/sim/units';
import {
  buildPlaceBuildingOrder,
  buildRoadOrder,
  buildTrainOrder,
  buildZoneOrder,
} from '../src/ui/orders';
import { createSession, HUMAN_PLAYER_ID, type GameSession } from '../src/ui/session';

function freshSession(): GameSession {
  // Cadet AI keeps the session cheap; the rival never touches player 0.
  return createSession({ seed: 424242, aiDifficulty: 'cadet' });
}

function playerOf(session: GameSession) {
  const p = session.world.city.players[HUMAN_PLAYER_ID];
  if (!p) throw new Error('test setup: human player missing');
  return p;
}

/** First land cell found scanning from the map center outward. */
function findLandCell(session: GameSession): { cx: number; cz: number } {
  const mid = Math.floor(CITY_GRID_CELLS / 2);
  for (let r = 0; r < mid; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = mid + dx;
        const cz = mid + dz;
        if (!cellIsWater(session.terrain, cx, cz)) return { cx, cz };
      }
    }
  }
  throw new Error('test setup: no land cell found');
}

/**
 * A valid house site: a 2x2 all-land block with an adjacent all-land road
 * cell, far from any existing building. Returns { bx, bz } (footprint
 * origin) and the adjacent road cell.
 */
function findHouseSite(session: GameSession): {
  bx: number;
  bz: number;
  road: { cx: number; cz: number };
} {
  const mid = Math.floor(CITY_GRID_CELLS / 2);
  for (let bz = 4; bz < CITY_GRID_CELLS - 6; bz++) {
    for (let bx = 4; bx < CITY_GRID_CELLS - 6; bx++) {
      const block = [
        { cx: bx, cz: bz },
        { cx: bx + 1, cz: bz },
        { cx: bx, cz: bz + 1 },
        { cx: bx + 1, cz: bz + 1 },
      ];
      if (block.some((c) => cellIsWater(session.terrain, c.cx, c.cz))) continue;
      const road = { cx: bx - 1, cz: bz };
      if (cellIsWater(session.terrain, road.cx, road.cz)) continue;
      // Keep clear of starting forces (corners) — center-ish is fine.
      if (Math.hypot(bx - mid, bz - mid) > 60) continue;
      return { bx, bz, road };
    }
  }
  throw new Error('test setup: no house site found');
}

/** World-space center of a city cell (what the click path feeds the sim). */
function cellWorld(session: GameSession, cx: number, cz: number): { x: number; z: number } {
  void session;
  return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
}

describe('placement pipeline: train unit', () => {
  it('spawnUnit order → unit on the field, funds + manpower deducted', () => {
    const session = freshSession();
    const player = playerOf(session);
    const cell = findLandCell(session);
    const { x, z } = cellWorld(session, cell.cx, cell.cz);

    const fundsBefore = player.funds;
    const manpowerBefore = player.manpower;
    const unitsBefore = session.world.units.length;

    // Exactly what GameController.handleLeftClick calls in train mode.
    expect(() =>
      session.enqueuePlayerIntent(buildTrainOrder('rifles', HUMAN_PLAYER_ID, x, z)),
    ).not.toThrow();
    session.tick();

    expect(session.world.units.length).toBe(unitsBefore + 1);
    const spawned = session.world.units[session.world.units.length - 1];
    expect(spawned).toBeDefined();
    expect(spawned!.kind).toBe('rifles');
    expect(spawned!.owner).toBe(HUMAN_PLAYER_ID);
    expect(Math.hypot(spawned!.x - x, spawned!.z - z)).toBeLessThan(4);
    expect(player.funds).toBe(fundsBefore - (UNIT_DEFS.rifles.trainFunds ?? 0));
    expect(player.manpower).toBe(manpowerBefore - UNIT_DEFS.rifles.manpowerCost);
  });
});

describe('placement pipeline: build road', () => {
  it('buildRoad order → road cell added, funds + materials deducted', () => {
    const session = freshSession();
    const player = playerOf(session);
    const cell = findLandCell(session);
    const idx = cell.cz * CITY_GRID_CELLS + cell.cx;

    const fundsBefore = player.funds;
    const materialsBefore = player.materials;

    // Exactly what the road tool calls on a map click.
    expect(() =>
      session.enqueuePlayerIntent(buildRoadOrder(HUMAN_PLAYER_ID, [idx])),
    ).not.toThrow();
    session.tick();

    expect(session.world.city.roads.map((r) => r.cell)).toContain(idx);
    expect(player.funds).toBe(fundsBefore - ROAD_COST_FUNDS);
    expect(player.materials).toBe(materialsBefore - ROAD_COST_MATERIALS);
  });
});

describe('placement pipeline: place building', () => {
  it('zone + road + placeBuilding orders → building under construction, costs deducted', () => {
    const session = freshSession();
    const player = playerOf(session);
    const site = findHouseSite(session);
    const roadIdx = site.road.cz * CITY_GRID_CELLS + site.road.cx;

    // Prep the site exactly like a player would: paint residential zone,
    // pave the adjacent road cell.
    session.enqueuePlayerIntent(
      buildZoneOrder(HUMAN_PLAYER_ID, 0, site.bx, site.bz, site.bx + 1, site.bz + 1),
    );
    session.enqueuePlayerIntent(buildRoadOrder(HUMAN_PLAYER_ID, [roadIdx]));
    session.tick();
    expect(session.world.city.roads.map((r) => r.cell)).toContain(roadIdx);

    const fundsBefore = player.funds;
    const materialsBefore = player.materials;
    const buildingsBefore = session.world.city.buildings.length;

    // Exactly what GameController.handleBuildClick calls for the house tool.
    expect(() =>
      session.enqueuePlayerIntent(
        buildPlaceBuildingOrder('house', HUMAN_PLAYER_ID, site.bx, site.bz),
      ),
    ).not.toThrow();
    session.tick();

    expect(session.world.city.buildings.length).toBe(buildingsBefore + 1);
    const built = session.world.city.buildings[session.world.city.buildings.length - 1];
    expect(built).toBeDefined();
    expect(built!.kind).toBe('house');
    expect(built!.owner).toBe(HUMAN_PLAYER_ID);
    // Under construction: progress starts at 0, not operational yet.
    expect(built!.progress).toBeLessThan(1);
    expect(built!.operational).toBe(false);
    expect(player.funds).toBe(fundsBefore - BUILDING_DEFS.house.costFunds);
    expect(player.materials).toBe(materialsBefore - BUILDING_DEFS.house.costMaterials);
  });
});

describe('placement pipeline: invalid placements are loud', () => {
  it('placing a house on water throws a readable rejection (not silent)', () => {
    const session = freshSession();
    // Find a water cell to guarantee a validation failure.
    let water: { cx: number; cz: number } | null = null;
    const mid = Math.floor(CITY_GRID_CELLS / 2);
    outer: for (let r = 0; r < mid; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const cx = mid + dx;
          const cz = mid + dz;
          if (cellIsWater(session.terrain, cx, cz)) {
            water = { cx, cz };
            break outer;
          }
        }
      }
    }
    if (!water) throw new Error('test setup: no water cell found');
    expect(() =>
      session.enqueuePlayerIntent(
        buildPlaceBuildingOrder('house', HUMAN_PLAYER_ID, water.cx, water.cz),
      ),
    ).toThrowError(CommandRejectedError);
    try {
      session.enqueuePlayerIntent(
        buildPlaceBuildingOrder('house', HUMAN_PLAYER_ID, water.cx, water.cz),
      );
      expect.unreachable('expected a rejection');
    } catch (e) {
      expect(e).toBeInstanceOf(CommandRejectedError);
      expect((e as CommandRejectedError).reason).toMatch(/water/i);
    }
  });
});
