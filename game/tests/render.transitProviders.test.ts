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
 * NOVATERRA — ambient transit provider tests (0.1 Alpha, Phase 4 item 3).
 *
 * `render/transitProviders.ts` turns the player's placeable transit stops
 * into decorative crowd vehicles (buses, trams, ferries) via the
 * `registerAmbientTransitProvider` contract from `render/cityLife.ts`.
 * These tests pin:
 *  - `transitVehicleCount` gating: no stops (or one stop) → zero
 *    vehicles; population scaling matches the crowd's own density
 *    divisors (150/400/600); hard caps per type.
 *  - route-key stability: identical stop sets → identical key; a moved
 *    stop → a new key (drives provider rebuilds in the controller).
 *  - `poseAt` determinism: pure in (index, tick) — repeated calls and
 *    replay-style re-derivation agree; vehicles dwell at stops (same
 *    position across dwell ticks) and move along legs between them.
 *  - provider lifecycle: `dispose()` unregisters and frees geometry.
 */
import { describe, expect, it } from 'vitest';
import {
  createBusProvider,
  createFerryProvider,
  createTramProvider,
  transitRouteKey,
  transitVehicleCount,
} from '../src/render/transitProviders';
import { ambientTransitProviderTypes, registerAmbientTransitProvider, unregisterAmbientTransitProvider } from '../src/render/cityLife';
import { createWorld } from '../src/sim/world';
import { placeBuilding, type Placement } from '../src/sim/city';

const STOPS = [
  { x: 0, z: 0 },
  { x: 100, z: 0 },
  { x: 100, z: 60 },
];

describe('transitVehicleCount', () => {
  it('is zero when there are fewer than two stops (no route)', () => {
    expect(transitVehicleCount('bus', 0, 10000)).toBe(0);
    expect(transitVehicleCount('tram', 1, 10000)).toBe(0);
    expect(transitVehicleCount('ferry', 1, 10000)).toBe(0);
  });

  it('is zero for zero/negative/non-finite population even with stops', () => {
    expect(transitVehicleCount('bus', 3, 0)).toBe(0);
    expect(transitVehicleCount('bus', 3, -5)).toBe(0);
    expect(transitVehicleCount('bus', 3, NaN)).toBe(0);
  });

  it('scales with population on the crowd density divisors', () => {
    expect(transitVehicleCount('bus', 3, 300)).toBe(2); // 300/150
    expect(transitVehicleCount('tram', 3, 800)).toBe(2); // 800/400
    expect(transitVehicleCount('ferry', 3, 1200)).toBe(2); // 1200/600
  });

  it('is capped per type (same MAX_AMBIENT_* as the crowd)', () => {
    expect(transitVehicleCount('bus', 3, 1_000_000)).toBe(40);
    expect(transitVehicleCount('tram', 3, 1_000_000)).toBe(24);
    expect(transitVehicleCount('ferry', 3, 1_000_000)).toBe(12);
  });
});

describe('provider poseAt (determinism + dwell)', () => {
  it('is pure in (index, tick): repeated calls agree exactly', () => {
    const p = createBusProvider(STOPS, { population: 300 });
    try {
      expect(p.count).toBe(2);
      for (const index of [0, 1]) {
        for (const tick of [0, 37, 1000, 123456]) {
          const a = p.poseAt(index, tick);
          const b = p.poseAt(index, tick);
          expect(a).toEqual(b);
        }
      }
    } finally {
      p.dispose();
    }
  });

  it('dwells at stops: the first dwellTicks ticks hold the first stop', () => {
    const p = createBusProvider(STOPS, { population: 150 });
    try {
      const t0 = p.poseAt(0, 0)!;
      const t10 = p.poseAt(0, 10)!;
      expect(t0.x).toBeCloseTo(STOPS[0]!.x, 9);
      expect(t0.z).toBeCloseTo(STOPS[0]!.z, 9);
      // Within the 30-tick bus dwell the vehicle does not move.
      expect(t10.x).toBeCloseTo(t0.x, 9);
      expect(t10.z).toBeCloseTo(t0.z, 9);
      // After the dwell it is on the first leg toward the second stop.
      const t40 = p.poseAt(0, 40)!;
      expect(t40.x).toBeGreaterThan(STOPS[0]!.x);
      expect(t40.x).toBeLessThan(STOPS[1]!.x);
    } finally {
      p.dispose();
    }
  });

  it('returns null for every vehicle when count is zero', () => {
    const p = createTramProvider(STOPS, { population: 0 });
    try {
      expect(p.count).toBe(0);
      expect(p.poseAt(0, 100)).toBeNull();
    } finally {
      p.dispose();
    }
  });

  it('the ferry pose bobs deterministically (a pure function of tick)', () => {
    const p = createFerryProvider(STOPS, { population: 600, waterY: 2 });
    try {
      const a = p.poseAt(0, 100)!;
      const b = p.poseAt(0, 100)!;
      expect(a.y).toBeCloseTo(b.y, 12);
      // …but differs across ticks (the swell is not constant).
      const c = p.poseAt(0, 131)!;
      expect(Math.abs(c.y - a.y)).toBeGreaterThan(1e-6);
    } finally {
      p.dispose();
    }
  });

  it('the bus and tram geometries differ per type (distinct silhouettes)', () => {
    const bus = createBusProvider(STOPS, { population: 150 });
    const tram = createTramProvider(STOPS, { population: 400 });
    try {
      expect(bus.geometry).not.toBe(tram.geometry);
    } finally {
      bus.dispose();
      tram.dispose();
    }
  });
});

describe('provider lifecycle', () => {
  it('the game-side lifecycle (unregister + dispose) removes the type', () => {
    // The registry is global; always restore the pre-test state.
    // Contract: `dispose()` frees provider-owned geometry/material only
    // (the crowd never disposes provider assets); the GAME calls
    // `unregisterAmbientTransitProvider` — game.ts does both together.
    const before = ambientTransitProviderTypes();
    const ferry = createFerryProvider(STOPS, { population: 600 });
    registerAmbientTransitProvider('ferry', ferry);
    expect(ambientTransitProviderTypes()).toContain('ferry');
    unregisterAmbientTransitProvider('ferry');
    ferry.dispose();
    expect(ambientTransitProviderTypes()).not.toContain('ferry');
    expect(ambientTransitProviderTypes()).toEqual(before);
  });
});

describe('transitRouteKey', () => {
  /** Directly place a completed, operational stop (bypasses commands). */
  function completedStop(city: Parameters<typeof placeBuilding>[0], p: Placement) {
    const b = placeBuilding(city, p);
    b.progress = 1;
    b.operational = true;
    return b;
  }

  it('is stable for identical stops and changes when a stop moves', () => {
    const world = createWorld(99);
    const a = completedStop(world.city, { kind: 'busStop', owner: 0, cx: 10, cz: 10, facing: 0 });
    completedStop(world.city, { kind: 'busStop', owner: 0, cx: 20, cz: 10, facing: 0 });
    const key1 = transitRouteKey(world, 0);
    expect(key1).toContain('bus=');
    // Same world, no changes → identical key (no provider rebuild).
    expect(transitRouteKey(world, 0)).toBe(key1);
    // A moved stop changes the key (drives a provider rebuild).
    a.cx = 30;
    const key2 = transitRouteKey(world, 0);
    expect(key2).not.toBe(key1);
  });

  it('ignores unfinished stops (they are not a route)', () => {
    const world = createWorld(100);
    completedStop(world.city, { kind: 'tramStop', owner: 0, cx: 10, cz: 10, facing: 0 });
    const unfinished = placeBuilding(world.city, { kind: 'tramStop', owner: 0, cx: 20, cz: 10, facing: 0 });
    unfinished.progress = 0.5;
    const key = transitRouteKey(world, 0);
    expect(key).toContain('tram=');
    expect(key).not.toContain(`${unfinished.id}@`);
    // Finishing it extends the key.
    unfinished.progress = 1;
    unfinished.operational = true;
    expect(transitRouteKey(world, 0)).not.toBe(key);
  });
});
