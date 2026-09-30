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
 * NOVATERRA — ambient cargo-ship provider tests (grand-expansion
 * Phase 6, workstream C, 2026-09-30).
 *
 * `render/cargoShipProviders.ts` turns the player's completed civilian
 * ports into decorative container ships via the
 * `registerAmbientTransitProvider` contract from `render/cityLife.ts`.
 * These tests pin:
 *  - `cargoShipVehicleCount` gating: fewer than two ports → zero ships;
 *    population scaling (1 per 800 residents); the MAX_AMBIENT_CARGOSHIP
 *    cap shared with `ambientTransitDensity`.
 *  - route-key stability: identical port sets → identical key; a new
 *    port → a new key (drives provider rebuilds in the controller).
 *  - `cargoShipRoutePoints`: only completed civilian commercial/
 *    container ports, in id order (fishing harbors, naval bases,
 *    incomplete ports, and other owners' ports are excluded).
 *  - `poseAt` purity: deterministic in (index, tick); ships dwell at
 *    ports (same x/z across dwell ticks) and sail legs between them.
 *  - render-only: building the provider and posing it never touches
 *    sim state (no unit records, no digest change).
 */
import { describe, expect, it } from 'vitest';
import {
  CARGO_PORT_KINDS,
  cargoShipRouteKey,
  cargoShipRoutePoints,
  cargoShipVehicleCount,
  createCargoShipProvider,
} from '../src/render/cargoShipProviders';
import {
  ambientTransitDensity,
  MAX_AMBIENT_CARGOSHIP,
} from '../src/render/cityLife';
import { createWorld } from '../src/sim/world';
import { digestWorld } from '../src/sim/digest';

const STOPS = [
  { x: 0, z: 0 },
  { x: 100, z: 0 },
];

/** A world whose owner 0 has the given completed buildings (fixture). */
function worldWithPorts(kinds: string[], owner = 0) {
  const world = createWorld(20260930);
  for (const kind of kinds) {
    world.city.buildings.push({
      id: world.city.nextBuildingId++,
      kind: kind as never,
      owner,
      cx: 10 + world.city.buildings.length * 8,
      cz: 20,
      facing: 0,
      progress: 1,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
    });
  }
  return world;
}

describe('cargoShipVehicleCount', () => {
  it('is zero with fewer than two ports (a single port is not a lane)', () => {
    expect(cargoShipVehicleCount(0, 100000)).toBe(0);
    expect(cargoShipVehicleCount(1, 100000)).toBe(0);
  });

  it('is zero for zero/negative/non-finite population even with ports', () => {
    expect(cargoShipVehicleCount(2, 0)).toBe(0);
    expect(cargoShipVehicleCount(2, -100)).toBe(0);
    expect(cargoShipVehicleCount(2, NaN)).toBe(0);
  });

  it('scales at one ship per 800 residents', () => {
    expect(cargoShipVehicleCount(2, 799)).toBe(0);
    expect(cargoShipVehicleCount(2, 800)).toBe(1);
    expect(cargoShipVehicleCount(2, 1600)).toBe(2);
    expect(cargoShipVehicleCount(5, 1600)).toBe(2); // port count only gates
  });

  it('is capped at MAX_AMBIENT_CARGOSHIP, matching ambientTransitDensity', () => {
    expect(MAX_AMBIENT_CARGOSHIP).toBe(10);
    expect(cargoShipVehicleCount(2, 1_000_000)).toBe(10);
    expect(ambientTransitDensity(1600).cargoShip).toBe(2);
    expect(ambientTransitDensity(1_000_000).cargoShip).toBe(10);
    expect(ambientTransitDensity(0).cargoShip).toBe(0);
  });
});

describe('cargoShipRouteKey', () => {
  it('is stable for identical port sets, moves when a port is added', () => {
    const a = worldWithPorts(['commercialPort', 'containerPort']);
    const b = worldWithPorts(['commercialPort', 'containerPort']);
    expect(cargoShipRouteKey(a, 0)).toBe(cargoShipRouteKey(b, 0));
    const c = worldWithPorts(['commercialPort', 'containerPort', 'commercialPort']);
    expect(cargoShipRouteKey(c, 0)).not.toBe(cargoShipRouteKey(a, 0));
  });

  it('ignores incomplete ports (they cannot load cargo yet)', () => {
    const world = worldWithPorts(['commercialPort', 'containerPort']);
    world.city.buildings.push({
      id: world.city.nextBuildingId++,
      kind: 'commercialPort' as never,
      owner: 0,
      cx: 90,
      cz: 20,
      facing: 0,
      progress: 0.5,
      level: 1,
      operational: false,
      powered: true,
      watered: true,
    });
    const full = worldWithPorts(['commercialPort', 'containerPort', 'commercialPort']);
    // The half-built port must not move the key.
    expect(cargoShipRouteKey(world, 0)).toBe(
      cargoShipRouteKey(worldWithPorts(['commercialPort', 'containerPort']), 0),
    );
    expect(cargoShipRouteKey(full, 0)).not.toBe(cargoShipRouteKey(world, 0));
  });
});

describe('cargoShipRoutePoints', () => {
  it('returns completed civilian commercial/container ports in id order', () => {
    const world = worldWithPorts(['containerPort', 'commercialPort']);
    const pts = cargoShipRoutePoints(world, 0);
    expect(pts).toHaveLength(2);
    // Id order, not kind order: containerPort was completed first.
    expect(world.city.buildings[0]!.kind).toBe('containerPort');
    expect(pts[0]).toEqual(pts[0]); // shape {x, z}
    expect(typeof pts[0]!.x).toBe('number');
    expect(typeof pts[0]!.z).toBe('number');
  });

  it('excludes fishing harbors, naval bases, incomplete and foreign ports', () => {
    const world = worldWithPorts(['fishingHarbor', 'navalBase']);
    expect(cargoShipRoutePoints(world, 0)).toHaveLength(0);
    const foreign = worldWithPorts(['commercialPort'], 1);
    expect(cargoShipRoutePoints(foreign, 0)).toHaveLength(0);
    expect(cargoShipRoutePoints(foreign, 1)).toHaveLength(1);
  });

  it('only lists the cargo port kinds', () => {
    expect([...CARGO_PORT_KINDS].sort()).toEqual(['commercialPort', 'containerPort']);
  });
});

describe('provider poseAt (determinism + dwell)', () => {
  it('is pure in (index, tick): repeated calls agree exactly', () => {
    const p = createCargoShipProvider(STOPS, { population: 1600 });
    try {
      const a = p.poseAt(0, 12345);
      const b = p.poseAt(0, 12345);
      expect(a).toEqual(b);
      expect(a).not.toBeNull();
    } finally {
      p.dispose();
    }
  });

  it('dwells at ports: same x/z across the 90-tick loading dwell', () => {
    const p = createCargoShipProvider(STOPS, { population: 1600 });
    try {
      // Index 0 starts its cycle dwelling at stop 0.
      const t0 = p.poseAt(0, 0)!;
      const t45 = p.poseAt(0, 45)!;
      expect(t0.x).toBe(STOPS[0]!.x);
      expect(t0.z).toBe(STOPS[0]!.z);
      expect(t45.x).toBe(t0.x);
      expect(t45.z).toBe(t0.z);
    } finally {
      p.dispose();
    }
  });

  it('sails the leg after the dwell (position moves between ports)', () => {
    const p = createCargoShipProvider(STOPS, { population: 1600 });
    try {
      // Dwell is 90 ticks; the 100-unit leg at speed 0.12 takes ~833
      // ticks — mid-leg the ship is strictly between the ports.
      const mid = p.poseAt(0, 90 + 400)!;
      expect(mid.x).toBeGreaterThan(STOPS[0]!.x);
      expect(mid.x).toBeLessThan(STOPS[1]!.x);
      expect(mid.z).toBeCloseTo(0, 9);
    } finally {
      p.dispose();
    }
  });

  it('returns null when count is zero (no lane, no ships)', () => {
    const p = createCargoShipProvider(STOPS, { population: 1600 });
    try {
      expect(p.poseAt(0, 0)).not.toBeNull();
      p.count = 0;
      expect(p.poseAt(0, 0)).toBeNull();
    } finally {
      p.dispose();
    }
  });

  it('initializes count from population like the game wiring does', () => {
    const p = createCargoShipProvider(STOPS, { population: 1600 });
    try {
      expect(p.count).toBe(2);
      expect(p.stops).toHaveLength(2);
    } finally {
      p.dispose();
    }
  });
});

describe('render-only: no sim coupling', () => {
  it('building and posing the provider leaves the world digest untouched', () => {
    const world = worldWithPorts(['commercialPort', 'containerPort']);
    const before = digestWorld(world);
    const unitsBefore = world.units.length;
    const p = createCargoShipProvider(cargoShipRoutePoints(world, 0), {
      population: 1600,
    });
    try {
      for (let tick = 0; tick < 2000; tick += 37) {
        for (let i = 0; i < p.count; i++) p.poseAt(i, tick);
      }
      expect(world.units.length).toBe(unitsBefore);
      expect(digestWorld(world)).toBe(before);
    } finally {
      p.dispose();
    }
  });
});
