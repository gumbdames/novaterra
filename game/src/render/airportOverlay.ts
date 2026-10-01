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
 * NOVATERRA — render/airportOverlay.ts — the airport overlay (0.1 Alpha).
 *
 * Grand-expansion Phase 5 (S5+S8): the TOGGLEABLE overlay — off by
 * default, flipped from the top bar ("Airports" button). It shows the
 * two things an airline player needs at a glance:
 *
 * 1. Airport sites: one ground ring per completed airport anchor,
 *    colored by what the viewer reads it as — sky blue for civilian,
 *    red for military, violet for mixed (the mixed rule lives in
 *    ui/airports.ts `airportDisplayType`: rivals see your mixed sites
 *    as civilian). One merged mesh, 1 draw call, 0 when empty.
 * 2. Airline routes: one elevated quadratic-bezier arc per route
 *    (endpoints on the ground, apex ~6–10 world units up) in gold.
 *    One merged LineSegments, 1 draw call, 0 when empty.
 *
 * Data flows in as `AirportOverlayData` (ui/airports.ts — a pure view of
 * sim records; the overlay never touches sim state). Geometry is built by
 * pure functions (Node-testable); both meshes rebuild ONLY when
 * `airportOverlayDigest` changes.
 *
 * Import-safe under Node/vitest; unit-tested in
 * tests/render.airportOverlay.test.ts.
 */

import * as THREE from 'three';

import type { AirportOverlayData } from '../ui/airports';
import { airportOverlayDigest } from '../ui/airports';

/** Ring color per display type (linear-space hex; material is vertex-colored). */
export const AIRPORT_RING_COLORS = {
  civilian: 0x4fc3f7,
  military: 0xef5350,
  mixed: 0xb388ff,
} as const;
/** Ring opacity — the terrain shows through. */
export const AIRPORT_RING_OPACITY = 0.85;
/** Route-arc color (gold — the "money route" read). */
export const AIRPORT_ROUTE_COLOR = 0xffd54f;
/** Route-arc opacity. */
export const AIRPORT_ROUTE_OPACITY = 0.7;
/** Rings sit above the logistics rings (+0.18) so the airport layer reads on top. */
export const AIRPORT_RING_TERRAIN_OFFSET = 0.22;
/** Ring segments per airport marker. */
export const AIRPORT_RING_SEGMENTS = 32;
/** Ground-ring inner/outer radius factor (× the datum radius). */
export const AIRPORT_RING_INNER = 0.92;
export const AIRPORT_RING_OUTER = 1.08;
/** Route-arc polyline segments. */
export const AIRLINE_ARC_SEGMENTS = 24;
/** Arc endpoint lift above the terrain. */
export const AIRLINE_ARC_LIFT = 1.2;
/** Arc apex: base height + distance × factor. */
export const AIRLINE_ARC_APEX = 6;
export const AIRLINE_ARC_APEX_PER_DIST = 0.04;

export interface AirportOverlaySyncOpts {
  /** Terrain height sampler (drapes rings); undefined = flat headless path. */
  heightFn?: (x: number, z: number) => number;
}

// ---------------------------------------------------------------------------
// Pure geometry builders (Node-testable)
// ---------------------------------------------------------------------------

export interface RingGeometryData {
  positions: Float32Array;
  normals: Float32Array;
  /** Per-vertex linear-space RGB (one color per airport). */
  colors: Float32Array;
  indices: number[];
}

/**
 * Merged ground annuli, one per airport, vertex-colored by display type,
 * draped on the terrain. Counter-clockwise winding when viewed from
 * above (up-facing).
 */
export function buildAirportRingGeometry(
  data: AirportOverlayData,
  heightFn?: (x: number, z: number) => number,
): RingGeometryData {
  const segs = AIRPORT_RING_SEGMENTS;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const yOf = (x: number, z: number): number =>
    (heightFn !== undefined ? heightFn(x, z) : 0) + AIRPORT_RING_TERRAIN_OFFSET;
  for (const a of data.airports) {
    const base = positions.length / 3;
    const inner = a.radius * AIRPORT_RING_INNER;
    const outer = a.radius * AIRPORT_RING_OUTER;
    const hex = AIRPORT_RING_COLORS[a.display];
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    for (let i = 0; i <= segs; i++) {
      const ang = (i / segs) * Math.PI * 2;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      for (const rad of [inner, outer]) {
        const x = a.x + ca * rad;
        const z = a.z + sa * rad;
        positions.push(x, yOf(x, z), z);
        normals.push(0, 1, 0);
        colors.push(r, g, b);
      }
    }
    for (let i = 0; i < segs; i++) {
      const v0 = base + i * 2;
      // Up-facing (counter-clockwise from above): inner[i] → outer[i+1] →
      // outer[i] and inner[i] → inner[i+1] → outer[i+1].
      indices.push(v0, v0 + 3, v0 + 1, v0, v0 + 2, v0 + 3);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices,
  };
}

export interface LineGeometryData {
  positions: Float32Array;
}

/**
 * Merged elevated route arcs as line-segment pairs: a quadratic bezier
 * from each route's endpoints with an apex that grows with distance.
 * Pure in (data, heightFn) — no wall clock, no RNG.
 */
export function buildAirlineRouteGeometry(
  data: AirportOverlayData,
  heightFn?: (x: number, z: number) => number,
): LineGeometryData {
  const positions: number[] = [];
  const yOf = (x: number, z: number): number =>
    (heightFn !== undefined ? heightFn(x, z) : 0) + AIRLINE_ARC_LIFT;
  for (const r of data.routes) {
    const dist = Math.hypot(r.toX - r.fromX, r.toZ - r.fromZ);
    const apex = AIRLINE_ARC_APEX + dist * AIRLINE_ARC_APEX_PER_DIST;
    const y0 = yOf(r.fromX, r.fromZ);
    const y1 = yOf(r.toX, r.toZ);
    let px = r.fromX;
    let py = y0;
    let pz = r.fromZ;
    for (let i = 1; i <= AIRLINE_ARC_SEGMENTS; i++) {
      const t = i / AIRLINE_ARC_SEGMENTS;
      const mt = 1 - t;
      const x = mt * mt * r.fromX + 2 * mt * t * ((r.fromX + r.toX) / 2) + t * t * r.toX;
      const z = mt * mt * r.fromZ + 2 * mt * t * ((r.fromZ + r.toZ) / 2) + t * t * r.toZ;
      // Height bezier: ground endpoints → apex at the middle.
      const y = mt * mt * y0 + 2 * mt * t * (Math.max(y0, y1) + apex) + t * t * y1;
      positions.push(px, py, pz, x, y, z);
      px = x;
      py = y;
      pz = z;
    }
  }
  return { positions: new Float32Array(positions) };
}

// ---------------------------------------------------------------------------
// The overlay
// ---------------------------------------------------------------------------

export class AirportOverlay {
  private readonly group = new THREE.Group();
  private ringMesh: THREE.Mesh | null = null;
  private routeLines: THREE.LineSegments | null = null;
  private lastDigest = -1;
  /** Rebuild counter (test/debug hook). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'airport-overlay';
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Number of geometry rebuilds so far (tests assert digest stability). */
  get rebuildCount(): number {
    return this.rebuilds;
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  isVisible(): boolean {
    return this.group.visible;
  }

  /** Sync from the ui/airports.ts view; rebuilds only on digest change. */
  sync(data: AirportOverlayData, opts: AirportOverlaySyncOpts = {}): void {
    const digest = airportOverlayDigest(data);
    if (digest === this.lastDigest) return;
    this.lastDigest = digest;
    this.rebuilds += 1;
    this.setRings(buildAirportRingGeometry(data, opts.heightFn));
    this.setRoutes(buildAirlineRouteGeometry(data, opts.heightFn));
  }

  private setRings(data: RingGeometryData): void {
    const empty = data.indices.length === 0;
    if (empty) {
      this.ringMesh?.removeFromParent();
      this.ringMesh?.geometry.dispose();
      (this.ringMesh?.material as THREE.Material | undefined)?.dispose();
      this.ringMesh = null;
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(data.indices);
    if (this.ringMesh === null) {
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: AIRPORT_RING_OPACITY,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.ringMesh = new THREE.Mesh(geo, mat);
      this.ringMesh.renderOrder = 4;
      this.group.add(this.ringMesh);
    } else {
      this.ringMesh.geometry.dispose();
      this.ringMesh.geometry = geo;
    }
  }

  private setRoutes(data: LineGeometryData): void {
    const empty = data.positions.length === 0;
    if (empty) {
      this.routeLines?.removeFromParent();
      this.routeLines?.geometry.dispose();
      (this.routeLines?.material as THREE.Material | undefined)?.dispose();
      this.routeLines = null;
      return;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    if (this.routeLines === null) {
      const mat = new THREE.LineBasicMaterial({
        color: AIRPORT_ROUTE_COLOR,
        transparent: true,
        opacity: AIRPORT_ROUTE_OPACITY,
      });
      this.routeLines = new THREE.LineSegments(geo, mat);
      this.group.add(this.routeLines);
    } else {
      this.routeLines.geometry.dispose();
      this.routeLines.geometry = geo;
    }
  }

  dispose(): void {
    this.ringMesh?.removeFromParent();
    this.ringMesh?.geometry.dispose();
    (this.ringMesh?.material as THREE.Material | undefined)?.dispose();
    this.ringMesh = null;
    this.routeLines?.removeFromParent();
    this.routeLines?.geometry.dispose();
    (this.routeLines?.material as THREE.Material | undefined)?.dispose();
    this.routeLines = null;
    this.group.removeFromParent();
  }
}
