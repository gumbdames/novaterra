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
 * NOVATERRA — render/airlineProviders.ts — ambient airliner provider
 * (0.1 Alpha).
 *
 * Grand-expansion Phase 5 (S5): the decorative airliners. Once the
 * player has at least one completed civil/mixed airport, airliners fly a
 * closed circuit through the player's airline-capable airports (a
 * holding ellipse over a lone airport). The crowd's
 * `ambientTransitDensity(pop).airliner` (1 per 2000 residents, cap 8)
 * sizes the fleet; with no completed civil airport the count is 0.
 *
 * The Phase 4 `AmbientVehicleProvider` contract
 * (render/transitProviders.ts): provider-owned geometry/material (the
 * crowd never disposes them — game.ts owns the lifecycle), a mutable
 * `count`, and poses pure in (index, tick) — no wall clock, no RNG.
 * Cruise altitude is ~25 world units with a small deterministic bob.
 *
 * Import-safe under Node/vitest; unit-tested in
 * tests/render.airlineProviders.test.ts.
 */

import * as THREE from 'three';

import { cellCenterWorld, getPlayer } from '../sim/city';
import type { World } from '../sim/world';
import type { AmbientVehicleProvider } from './transitProviders';
import { ambientTransitDensity } from './cityLife';
import { isAirlineEndpoint } from '../ui/airports';

/** Cruise altitude (world units) + deterministic bob amplitude. */
export const AIRLINER_CRUISE_ALT = 25;
export const AIRLINER_BOB_AMPLITUDE = 1.2;
/** World units per tick along the circuit. */
export const AIRLINER_SPEED = 0.28;
/** Holding-ellipse radii over a lone airport. */
export const AIRLINER_HOLD_RX = 14;
export const AIRLINER_HOLD_RZ = 9;

export interface AirlinerStop {
  x: number;
  z: number;
}

/**
 * The player's airline-capable airports (completed civil/mixed), in
 * deterministic id order. Empty when the player has no completed civil
 * airport — the provider gates on this.
 */
export function airlinerStops(world: World, owner: number): AirlinerStop[] {
  return world.city.buildings
    .filter((b) => b.owner === owner && isAirlineEndpoint(b))
    .sort((a, b) => a.id - b.id)
    .map((b) => ({ x: cellCenterWorld(b.cx), z: cellCenterWorld(b.cz) }));
}

/**
 * Rebuild key: the provider's circuit is an immutable snapshot, so
 * game.ts rebuilds it only when this changes (player builds/demolishes
 * an airport).
 */
export function airlinerRouteKey(world: World, owner: number): string {
  return world.city.buildings
    .filter((b) => b.owner === owner && isAirlineEndpoint(b))
    .sort((a, b) => a.id - b.id)
    .map((b) => `${b.id}@${b.cx},${b.cz}`)
    .join(';');
}

/** Fleet size for the provider's `count` (game.ts refreshes it per frame). */
export function airlinerCount(world: World, owner: number): number {
  if (airlinerStops(world, owner).length === 0) return 0;
  const pop = getPlayer(world.city, owner)?.population ?? 0;
  return ambientTransitDensity(pop).airliner;
}

/**
 * A small vertex-colored jet for the ambient fleet (provider-owned).
 * Fuselage + swept wings + tailplane + fin, ~nose toward +z.
 */
export function buildAirlinerModel(): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const geos: THREE.BufferGeometry[] = [];
  const white = new THREE.Color(0xe8edf2);
  const accent = new THREE.Color(0x2e6fb7);
  const add = (
    geo: THREE.BufferGeometry,
    color: THREE.Color,
    x: number,
    y: number,
    z: number,
    ry = 0,
  ): void => {
    geo.rotateY(ry);
    geo.translate(x, y, z);
    const n = geo.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geos.push(geo);
  };
  // Fuselage: stretched octahedron-ish (cylinder with few segments).
  add(new THREE.CylinderGeometry(0.55, 0.35, 4.6, 8), white, 0, 0, 0.3, Math.PI / 2);
  // Nose cone.
  add(new THREE.ConeGeometry(0.55, 1.2, 8), white, 0, 0, 3.0, Math.PI / 2);
  // Swept wings.
  for (const s of [-1, 1]) {
    const wing = new THREE.BoxGeometry(3.4, 0.12, 1.1);
    wing.rotateY(s * 0.35);
    add(wing, accent, s * 1.9, 0.05, -0.3);
    // Tailplane.
    const tail = new THREE.BoxGeometry(1.6, 0.1, 0.7);
    tail.rotateY(s * 0.4);
    add(tail, accent, s * 0.9, 0.25, -2.2);
  }
  // Fin.
  add(new THREE.BoxGeometry(0.12, 1.4, 1.0), accent, 0, 0.8, -2.2);
  // Engines under the wings.
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.28, 0.28, 1.4, 8), white, s * 1.6, -0.35, 0.1, Math.PI / 2);
  }
  // Merge into one geometry.
  let offset = 0;
  for (const g of geos) offset += g.getAttribute('position').count;
  const positions = new Float32Array(offset * 3);
  const normals = new Float32Array(offset * 3);
  const colors = new Float32Array(offset * 3);
  let o = 0;
  for (const g of geos) {
    const n = g.getAttribute('position').count;
    positions.set(g.getAttribute('position').array as Float32Array, o * 3);
    normals.set(g.getAttribute('normal').array as Float32Array, o * 3);
    colors.set(g.getAttribute('color').array as Float32Array, o * 3);
    o += n;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 });
  return { geometry: merged, material };
}

/**
 * Create the airliner provider for the player's current airport set.
 * Returns null when the player has no completed civil/mixed airport
 * (game.ts registers nothing then). `stops` is the immutable circuit
 * snapshot; `count` is refreshed per frame by game.ts.
 */
export function createAirlinerProvider(
  world: World,
  owner: number,
): AmbientVehicleProvider | null {
  const stops = airlinerStops(world, owner);
  if (stops.length === 0) return null;
  const { geometry, material } = buildAirlinerModel();

  // Closed circuit through the stops (waypoint list + segment lengths).
  // B27: no `!` — stops.length === 1 above, so stops[0] is defined.
  const first = stops[0];
  if (first === undefined) throw new Error('airlineProviders: no stops');
  const waypoints: AirlinerStop[] = stops.length === 1
    ? holdingEllipse(first)
    : stops;
  const segLens: number[] = [];
  let total = 0;
  for (let i = 0; i < waypoints.length; i++) {
    // B27: no `!` — i < waypoints.length by loop bound.
    const a = waypoints[i];
    const b = waypoints[(i + 1) % waypoints.length];
    if (a === undefined || b === undefined) continue;
    const len = Math.max(0.001, Math.hypot(b.x - a.x, b.z - a.z));
    segLens.push(len);
    total += len;
  }

  /** Position + yaw at circuit distance d (pure in d). */
  const poseAtDistance = (d: number): { x: number; z: number; yaw: number } => {
    let rem = ((d % total) + total) % total;
    for (let i = 0; i < waypoints.length; i++) {
      // B27: no `!` — i < waypoints.length by loop bound.
      const len = segLens[i] ?? 0;
      if (rem <= len) {
        const a = waypoints[i];
        const b = waypoints[(i + 1) % waypoints.length];
        if (a === undefined || b === undefined) continue;
        const t = len === 0 ? 0 : rem / len;
        return {
          x: a.x + (b.x - a.x) * t,
          z: a.z + (b.z - a.z) * t,
          yaw: Math.atan2(b.x - a.x, b.z - a.z),
        };
      }
      rem -= len;
    }
    // B27: no `!` — waypoints is non-empty (holdingEllipse or stops).
    const last = waypoints[waypoints.length - 1];
    if (last === undefined) return { x: 0, z: 0, yaw: 0 };
    return { x: last.x, z: last.z, yaw: 0 };
  };

  return {
    geometry,
    material,
    count: 0,
    stops,
    poseAt(index: number, tick: number) {
      // Fleet spacing: airliners spread evenly around the circuit so
      // they never stack on one waypoint.
      const spacing = this.count > 0 ? total / this.count : total;
      const d = tick * AIRLINER_SPEED + index * spacing;
      const p = poseAtDistance(d);
      // Deterministic bob — phase per index, never the wall clock.
      const bob = Math.sin(tick * 0.02 + index * 2.1) * AIRLINER_BOB_AMPLITUDE;
      return { x: p.x, y: AIRLINER_CRUISE_ALT + bob, z: p.z, yaw: p.yaw };
    },
    dispose() {
      geometry.dispose();
      (material as THREE.Material).dispose();
    },
  };
}

/** A 12-point holding ellipse over a lone airport (the circuit). */
function holdingEllipse(center: AirlinerStop): AirlinerStop[] {
  const pts: AirlinerStop[] = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    pts.push({
      x: center.x + Math.cos(a) * AIRLINER_HOLD_RX,
      z: center.z + Math.sin(a) * AIRLINER_HOLD_RZ,
    });
  }
  return pts;
}
