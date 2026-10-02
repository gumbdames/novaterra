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
 * NOVATERRA — tests/sim.networks.test.ts — fun-audit D2 (2026-10-02):
 * quantitative networks (power-line capacity, road-adjacency
 * throughput, adjacency synergies).
 *
 * Covers:
 *  - power-line capacity: POWER_LINE_CAPACITY is positive; early nets
 *    (a plant + buildings on a handful of line cells) never hit the
 *    cap — the cap only binds late-game mega-networks;
 *  - road-adjacency: isRoadAdjacent is true when a road cell touches
 *    the footprint, false otherwise (no road = no bonus, no penalty);
 *  - adjacency synergies: adjacencySynergyMult is 1.25 for each
 *    documented pair (oilRefinery↔oilWell, factory↔quarry,
 *    recyclingCenter↔factory) when footprints touch, 1 otherwise.
 *
 * No RNG is used anywhere in this file.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { BUILDING_DEFS, roadSortedInsert, type BuildingKind, type BuildingRecord } from '../src/sim/city';
import {
  POWER_LINE_CAPACITY,
  ROAD_ADJACENCY_BONUS,
  isRoadAdjacent,
  adjacencySynergyMult,
} from '../src/sim/economy';

function setup(): World {
  return createWorld(20261002);
}

/** A completed, operational building owned by player 0. */
function addBuilding(world: World, kind: BuildingKind, cx: number, cz: number, id: number): BuildingRecord {
  const def = BUILDING_DEFS[kind];
  const b = {
    id,
    kind,
    owner: 0,
    cx,
    cz,
    w: def.footprintW,
    h: def.footprintH,
    progress: 1,
    operational: true,
    powered: true,
    watered: true,
  } as unknown as BuildingRecord;
  world.city.buildings.push(b);
  return b;
}

/** A road cell at (cx, cz), keeping the roads array sorted. */
function addRoad(world: World, cx: number, cz: number): void {
  roadSortedInsert(world.city.roads, { cell: cz * 256 + cx, cls: 'paved' });
}

describe('power-line capacity', () => {
  it('POWER_LINE_CAPACITY is a positive constant', () => {
    expect(POWER_LINE_CAPACITY).toBeGreaterThan(0);
  });

  it('early nets never hit the cap', () => {
    // A coal plant's supply vs. 5 line cells of capacity: the cap is
    // orders of magnitude above early-game supply, so early nets are
    // unaffected (the plan's tuning requirement).
    const plantSupply = BUILDING_DEFS.coalPlant.powerSupply;
    expect(5 * POWER_LINE_CAPACITY).toBeGreaterThan(plantSupply * 2);
  });
});

describe('road-adjacency throughput', () => {
  it('ROAD_ADJACENCY_BONUS is 1.25', () => {
    expect(ROAD_ADJACENCY_BONUS).toBe(1.25);
  });

  it('isRoadAdjacent is false with no roads (no penalty, just no bonus)', () => {
    const world = setup();
    const factory = addBuilding(world, 'factory', 20, 20, 1);
    expect(world.city.roads).toHaveLength(0);
    expect(isRoadAdjacent(world.city, factory)).toBe(false);
  });

  it('isRoadAdjacent is true when a road cell touches the footprint', () => {
    const world = setup();
    // Factory at (20, 20), footprint 3×3 → cells x∈[20,22], z∈[20,22].
    const factory = addBuilding(world, 'factory', 20, 20, 1);
    // Road at (23, 21): orthogonally adjacent to footprint cell (22, 21).
    addRoad(world, 23, 21);
    expect(isRoadAdjacent(world.city, factory)).toBe(true);
  });

  it('isRoadAdjacent is false when the road is two cells away', () => {
    const world = setup();
    const factory = addBuilding(world, 'factory', 20, 20, 1);
    // Road at (24, 21): two cells from the footprint edge (22, 21).
    addRoad(world, 24, 21);
    expect(isRoadAdjacent(world.city, factory)).toBe(false);
  });
});

describe('adjacency synergies', () => {
  it('oilRefinery next to oilWell gets 1.25x', () => {
    const world = setup();
    // oilWell at (30, 30), oilRefinery adjacent at (33, 30).
    // (Footprints are 3×3; well covers x∈[30,32], refinery x∈[33,35] —
    // cell (32,30) touches (33,30).)
    addBuilding(world, 'oilWell', 30, 30, 1);
    const refinery = addBuilding(world, 'oilRefinery', 32, 30, 2);
    expect(adjacencySynergyMult(world.city, refinery)).toBe(1.25);
  });

  it('factory next to quarry gets 1.25x', () => {
    const world = setup();
    addBuilding(world, 'quarry', 40, 40, 1);
    const factory = addBuilding(world, 'factory', 43, 40, 2);
    expect(adjacencySynergyMult(world.city, factory)).toBe(1.25);
  });

  it('recyclingCenter next to factory gets 1.25x', () => {
    const world = setup();
    addBuilding(world, 'factory', 50, 50, 1);
    const recycling = addBuilding(world, 'recyclingCenter', 53, 50, 2);
    expect(adjacencySynergyMult(world.city, recycling)).toBe(1.25);
  });

  it('no synergy when the provider is far away', () => {
    const world = setup();
    addBuilding(world, 'oilWell', 30, 30, 1);
    const refinery = addBuilding(world, 'oilRefinery', 60, 60, 2);
    expect(adjacencySynergyMult(world.city, refinery)).toBe(1);
  });

  it('the provider does not get the bonus (directional)', () => {
    const world = setup();
    addBuilding(world, 'oilRefinery', 32, 30, 2);
    const well = addBuilding(world, 'oilWell', 30, 30, 1);
    // The well is the provider, not the receiver.
    expect(adjacencySynergyMult(world.city, well)).toBe(1);
  });

  it('unrelated buildings get no synergy', () => {
    const world = setup();
    addBuilding(world, 'house', 30, 30, 1);
    const factory = addBuilding(world, 'factory', 33, 30, 2);
    expect(adjacencySynergyMult(world.city, factory)).toBe(1);
  });
});
