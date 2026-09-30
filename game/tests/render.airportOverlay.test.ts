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
 * NOVATERRA — airport overlay tests (grand-expansion Phase 5,
 * workstream A, S5+S8, 2026-09-30).
 *
 * `render/airportOverlay.ts` draws airport-site rings (colored by the
 * display type) and airline-route arcs. These tests pin:
 *  - `buildAirportRingGeometry`: one annulus per airport with
 *    vertex colors matching the display type, counter-clockwise winding
 *    from above (up-facing), terrain drape vs flat headless fallback,
 *    empty for no airports.
 *  - `buildAirlineRouteGeometry`: one elevated arc per route, ending at
 *    the endpoints' ground positions, empty for no routes.
 *  - `AirportOverlay`: starts hidden, toggles visibility, rebuilds only
 *    when the digest changes (digest stability).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  AIRPORT_RING_COLORS,
  AIRLINE_ARC_SEGMENTS,
  AirportOverlay,
  buildAirportRingGeometry,
  buildAirlineRouteGeometry,
} from '../src/render/airportOverlay';
import type { AirportOverlayData } from '../src/ui/airports';

const DATA: AirportOverlayData = {
  airports: [
    { id: 1, x: 10, z: 20, radius: 3, display: 'civilian' },
    { id: 2, x: 40, z: 50, radius: 4, display: 'military' },
  ],
  routes: [{ id: 1, fromX: 10, fromZ: 20, toX: 40, toZ: 50 }],
};

const EMPTY: AirportOverlayData = { airports: [], routes: [] };

describe('buildAirportRingGeometry', () => {
  it('emits one ring per airport between the inner/outer radii', () => {
    const geo = buildAirportRingGeometry(DATA);
    // Two rings: each ring contributes (segments+1)*2 vertices.
    expect(geo.positions.length / 3).toBe(2 * 33 * 2);
    expect(geo.indices.length).toBe(2 * 32 * 6);
    // First ring's center of mass is ~the airport position (the
    // duplicated angle-0 vertex biases the mean slightly).
    let sx = 0;
    let sz = 0;
    const n = 33 * 2;
    for (let i = 0; i < n; i++) {
      sx += geo.positions[i * 3]!;
      sz += geo.positions[i * 3 + 2]!;
    }
    expect(sx / n).toBeCloseTo(10, 0);
    expect(sz / n).toBeCloseTo(20, 0);
    // Ring radii lie between 0.92× and 1.08× the datum radius.
    for (let i = 0; i < n; i++) {
      const dx = geo.positions[i * 3]! - 10;
      const dz = geo.positions[i * 3 + 2]! - 20;
      const r = Math.hypot(dx, dz);
      expect(r).toBeGreaterThanOrEqual(3 * 0.92 - 1e-6);
      expect(r).toBeLessThanOrEqual(3 * 1.08 + 1e-6);
    }
  });

  it('vertex-colors match the display type', () => {
    const geo = buildAirportRingGeometry(DATA);
    const n = 33 * 2;
    // First ring = civilian sky blue.
    const hex = AIRPORT_RING_COLORS.civilian;
    expect(geo.colors[0]).toBeCloseTo(((hex >> 16) & 0xff) / 255, 6);
    expect(geo.colors[1]).toBeCloseTo(((hex >> 8) & 0xff) / 255, 6);
    expect(geo.colors[2]).toBeCloseTo((hex & 0xff) / 255, 6);
    // Second ring = military red.
    const mhex = AIRPORT_RING_COLORS.military;
    const o = n * 3;
    expect(geo.colors[o]).toBeCloseTo(((mhex >> 16) & 0xff) / 255, 6);
    expect(geo.colors[o + 1]).toBeCloseTo(((mhex >> 8) & 0xff) / 255, 6);
    expect(geo.colors[o + 2]).toBeCloseTo((mhex & 0xff) / 255, 6);
  });

  it('winds counter-clockwise from above (up-facing)', () => {
    const geo = buildAirportRingGeometry(DATA);
    // First quad: v0 (inner, ang 0), v1 (outer, ang 0), v3 (outer, ang d).
    // Up-facing means the triangle normal has positive y.
    const p = (i: number): [number, number, number] => [
      geo.positions[i * 3]!,
      geo.positions[i * 3 + 1]!,
      geo.positions[i * 3 + 2]!,
    ];
    const a = p(geo.indices[0]!);
    const b = p(geo.indices[1]!);
    const c = p(geo.indices[2]!);
    const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const ac: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const ny = ab[2] * ac[0] - ab[0] * ac[2];
    expect(ny).toBeGreaterThan(0);
  });

  it('drapes on the terrain sampler, else uses the flat headless path', () => {
    const draped = buildAirportRingGeometry(DATA, () => 7.5);
    expect(draped.positions[1]).toBeCloseTo(7.5 + 0.22, 6);
    const flat = buildAirportRingGeometry(DATA);
    expect(flat.positions[1]).toBeCloseTo(0.22, 6);
  });

  it('emits nothing for no airports', () => {
    const geo = buildAirportRingGeometry(EMPTY);
    expect(geo.positions.length).toBe(0);
    expect(geo.indices.length).toBe(0);
  });
});

describe('buildAirlineRouteGeometry', () => {
  it('emits one elevated arc per route as segment pairs', () => {
    const geo = buildAirlineRouteGeometry(DATA);
    // 24 segments × 2 endpoints × 3 components per route.
    expect(geo.positions.length).toBe(AIRLINE_ARC_SEGMENTS * 2 * 3);
    // The arc starts at the from-endpoint's ground position.
    expect(geo.positions[0]).toBeCloseTo(10, 6);
    expect(geo.positions[2]).toBeCloseTo(20, 6);
    expect(geo.positions[1]).toBeCloseTo(1.2, 6);
    // The arc ends at the to-endpoint.
    const n = geo.positions.length;
    expect(geo.positions[n - 3]).toBeCloseTo(40, 6);
    expect(geo.positions[n - 1]).toBeCloseTo(50, 6);
    expect(geo.positions[n - 2]).toBeCloseTo(1.2, 6);
    // The middle of the arc is elevated (apex above cruise lift).
    let maxY = 0;
    for (let i = 0; i < n / 3; i++) maxY = Math.max(maxY, geo.positions[i * 3 + 1]!);
    expect(maxY).toBeGreaterThan(5);
  });

  it('arc height grows with distance', () => {
    const short: AirportOverlayData = {
      airports: [],
      routes: [{ id: 1, fromX: 0, fromZ: 0, toX: 10, toZ: 0 }],
    };
    const long: AirportOverlayData = {
      airports: [],
      routes: [{ id: 1, fromX: 0, fromZ: 0, toX: 200, toZ: 0 }],
    };
    const maxYOf = (g: { positions: Float32Array }): number => {
      let m = 0;
      for (let i = 0; i < g.positions.length / 3; i++) {
        m = Math.max(m, g.positions[i * 3 + 1]!);
      }
      return m;
    };
    expect(maxYOf(buildAirlineRouteGeometry(long))).toBeGreaterThan(
      maxYOf(buildAirlineRouteGeometry(short)),
    );
  });

  it('emits nothing for no routes', () => {
    expect(buildAirlineRouteGeometry(EMPTY).positions.length).toBe(0);
  });
});

describe('AirportOverlay', () => {
  function overlay(): { ov: AirportOverlay; scene: THREE.Scene } {
    const scene = new THREE.Scene();
    const ov = new AirportOverlay(scene);
    return { ov, scene };
  }

  it('starts hidden and toggles visibility', () => {
    const { ov } = overlay();
    expect(ov.isVisible()).toBe(false);
    ov.setVisible(true);
    expect(ov.isVisible()).toBe(true);
    ov.setVisible(false);
    expect(ov.isVisible()).toBe(false);
    ov.dispose();
  });

  it('rebuilds only when the digest changes', () => {
    const { ov } = overlay();
    ov.sync(DATA);
    expect(ov.rebuildCount).toBe(1);
    ov.sync(DATA);
    expect(ov.rebuildCount).toBe(1);
    ov.sync({ ...DATA, airports: [...DATA.airports] });
    expect(ov.rebuildCount).toBe(1); // identical data → same digest
    ov.sync(EMPTY);
    expect(ov.rebuildCount).toBe(2);
    ov.dispose();
  });

  it('handles empty data without meshes', () => {
    const { ov, scene } = overlay();
    ov.sync(EMPTY);
    expect(ov.rebuildCount).toBe(1);
    // Only the group was added to the scene — no meshes.
    expect(scene.children.length).toBe(1);
    ov.dispose();
  });
});
