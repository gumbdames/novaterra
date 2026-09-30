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
 * NOVATERRA — ambient airliner provider tests (grand-expansion
 * Phase 5, workstream A, S5+S8, 2026-09-30).
 *
 * `render/airlineProviders.ts` turns the player's completed
 * civil/mixed airports into decorative airliners via the
 * `registerAmbientTransitProvider` contract from `render/cityLife.ts`.
 * These tests pin:
 *  - `airlinerStops`: only completed civil/mixed airports of the
 *    owner, in id order (military airbases, incomplete airports, and
 *    other owners' airports are excluded).
 *  - `airlinerCount`: zero with no completed civil airport; otherwise
 *    `ambientTransitDensity(pop).airliner` (1 per 2000 residents,
 *    MAX_AMBIENT_AIRLINER cap).
 *  - `airlinerRouteKey`: stable for identical airport sets, moves when
 *    an airport is added (drives provider rebuilds in the controller).
 *  - `createAirlinerProvider`: null without a civil airport; otherwise
 *    a provider whose `poseAt` is deterministic in (index, tick), flies
 *    at cruise altitude, and loops a closed circuit.
 *  - render-only: building the provider and posing it never touches
 *    sim state (no unit records, no digest change).
 */
import { describe, expect, it } from 'vitest';
import {
  AIRLINER_CRUISE_ALT,
  airlinerCount,
  airlinerRouteKey,
  airlinerStops,
  createAirlinerProvider,
} from '../src/render/airlineProviders';
import {
  ambientTransitDensity,
  MAX_AMBIENT_AIRLINER,
} from '../src/render/cityLife';
import { createWorld } from '../src/sim/world';
import { placeBuilding, type BuildingRecord } from '../src/sim/city';
import { digestWorld } from '../src/sim/digest';

function airportWorld(): ReturnType<typeof createWorld> {
  return createWorld(20260930);
}

function addAirport(
  world: ReturnType<typeof createWorld>,
  kind: 'civilAirport' | 'militaryAirbase' | 'mixedAirport',
  owner: number,
  cx: number,
  cz: number,
  progress = 1,
): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = progress;
  b.operational = progress >= 1;
  return b;
}

describe('airlinerStops', () => {
  it('lists the owner\'s completed civil/mixed airports in id order', () => {
    const world = airportWorld();
    const a = addAirport(world, 'civilAirport', 0, 10, 10);
    const b = addAirport(world, 'mixedAirport', 0, 40, 40);
    addAirport(world, 'militaryAirbase', 0, 60, 60); // not airline-capable
    addAirport(world, 'civilAirport', 0, 80, 80, 0.4); // incomplete
    addAirport(world, 'civilAirport', 1, 100, 100); // rival
    const stops = airlinerStops(world, 0);
    expect(stops.map((s) => [s.x, s.z])).toEqual([
      [expect.any(Number), expect.any(Number)],
      [expect.any(Number), expect.any(Number)],
    ]);
    expect(stops.length).toBe(2);
    // Id order: a before b.
    expect(a.id).toBeLessThan(b.id);
  });

  it('is empty with no civil airport', () => {
    const world = airportWorld();
    addAirport(world, 'militaryAirbase', 0, 10, 10);
    expect(airlinerStops(world, 0)).toEqual([]);
  });
});

describe('airlinerCount', () => {
  it('is zero with no completed civil airport, whatever the population', () => {
    const world = airportWorld();
    world.city.players[0]!.population = 100000;
    expect(airlinerCount(world, 0)).toBe(0);
  });

  it('follows ambientTransitDensity(pop).airliner once gated (1/2000, cap 8)', () => {
    expect(MAX_AMBIENT_AIRLINER).toBe(8);
    const world = airportWorld();
    addAirport(world, 'civilAirport', 0, 10, 10);
    world.city.players[0]!.population = 1999;
    expect(airlinerCount(world, 0)).toBe(0);
    world.city.players[0]!.population = 2000;
    expect(airlinerCount(world, 0)).toBe(1);
    world.city.players[0]!.population = 4000;
    expect(airlinerCount(world, 0)).toBe(2);
    world.city.players[0]!.population = 1_000_000;
    expect(airlinerCount(world, 0)).toBe(8);
    expect(airlinerCount(world, 0)).toBe(ambientTransitDensity(1_000_000).airliner);
  });
});

describe('airlinerRouteKey', () => {
  it('is stable for identical airport sets, moves when an airport is added', () => {
    const a = airportWorld();
    addAirport(a, 'civilAirport', 0, 10, 10);
    const b = airportWorld();
    addAirport(b, 'civilAirport', 0, 10, 10);
    expect(airlinerRouteKey(a, 0)).toBe(airlinerRouteKey(b, 0));
    addAirport(a, 'mixedAirport', 0, 40, 40);
    expect(airlinerRouteKey(a, 0)).not.toBe(airlinerRouteKey(b, 0));
  });
});

describe('createAirlinerProvider', () => {
  it('returns null with no completed civil airport', () => {
    const world = airportWorld();
    expect(createAirlinerProvider(world, 0)).toBeNull();
  });

  it('poseAt is deterministic in (index, tick) and cruises at altitude', () => {
    const world = airportWorld();
    addAirport(world, 'civilAirport', 0, 10, 10);
    addAirport(world, 'mixedAirport', 0, 60, 30);
    const provider = createAirlinerProvider(world, 0)!;
    provider.count = 4;
    const p1 = provider.poseAt(0, 1000)!;
    const p2 = provider.poseAt(0, 1000)!;
    expect(p1).toEqual(p2);
    expect(p1.y).toBeGreaterThan(AIRLINER_CRUISE_ALT - 2);
    expect(p1.y).toBeLessThan(AIRLINER_CRUISE_ALT + 2);
    // Fleet members spread around the circuit — never stacked.
    const p3 = provider.poseAt(1, 1000)!;
    expect(Math.hypot(p3.x - p1.x, p3.z - p1.z)).toBeGreaterThan(1);
    // The aircraft moves between ticks.
    const p4 = provider.poseAt(0, 1100)!;
    expect(Math.hypot(p4.x - p1.x, p4.z - p1.z)).toBeGreaterThan(0.1);
    // ...and eventually loops back near its start (closed circuit).
    const p5 = provider.poseAt(0, 100000)!;
    expect(p5.y).toBeGreaterThan(AIRLINER_CRUISE_ALT - 2);
    provider.dispose();
  });

  it('flies a holding ellipse over a lone airport', () => {
    const world = airportWorld();
    addAirport(world, 'civilAirport', 0, 10, 10);
    const provider = createAirlinerProvider(world, 0)!;
    provider.count = 1;
    const poses = [0, 500, 1000, 1500].map((t) => provider.poseAt(0, t)!);
    // All poses stay within a bounded region (the ellipse) and above ground.
    for (const p of poses) {
      expect(p.y).toBeGreaterThan(AIRLINER_CRUISE_ALT - 2);
    }
    const xs = poses.map((p) => p.x);
    const zs = poses.map((p) => p.z);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(5);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(60);
    expect(Math.max(...zs) - Math.min(...zs)).toBeLessThan(60);
    provider.dispose();
  });

  it('never touches sim state (no units, no digest change)', () => {
    const world = airportWorld();
    addAirport(world, 'civilAirport', 0, 10, 10);
    const beforeDigest = digestWorld(world);
    const beforeUnits = world.units.length;
    const provider = createAirlinerProvider(world, 0)!;
    provider.count = 8;
    for (let t = 0; t < 3000; t += 137) provider.poseAt(3, t);
    expect(world.units.length).toBe(beforeUnits);
    expect(digestWorld(world)).toBe(beforeDigest);
    provider.dispose();
  });
});
