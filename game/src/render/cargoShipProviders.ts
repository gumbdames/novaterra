/**
 * cargoShipProviders.ts — grand-expansion Phase 6 (naval expansion,
 * workstream C) ambient cargo ships.
 *
 * The crowd (`render/cityLife.ts`) renders ambient container ships
 * through the `AmbientTransitProvider` contract: provider-owned
 * geometry + material, a mutable `count`, and a `poseAt(index, tick)`
 * that is pure in (index, tick) for a fixed route. This module is the
 * render-side factory plus the small pure helpers the game controller
 * uses to wire it:
 *
 *   - `cargoShipRoutePoints(world, owner)` — the immutable route
 *     snapshot a provider loops (the owner's completed civilian ports:
 *     commercialPort + containerPort — see CARGO_PORT_KINDS).
 *   - `cargoShipRouteKey(world, owner)` — a cheap change key: the game
 *     rebuilds the provider only when this moves (player actions), never
 *     on population ticks, so provider geometry is never churned.
 *   - `cargoShipVehicleCount(portCount, population)` — the live
 *     `count`: zero until the player owns a real shipping lane (≥2
 *     civilian ports — a single port is not a lane), then the same
 *     population scaling as `ambientTransitDensity` (1 ship per 800
 *     residents, capped by MAX_AMBIENT_CARGOSHIP).
 *
 * No gameplay logic here — the ships are decorative, exactly like the
 * ambient pedestrians, cars, and Phase 4 transit vehicles. The sim never
 * sees them: no unit records, no digest/snapshot presence (render-only
 * rule — see render/AGENTS.md).
 *
 * Import-safe under Node/vitest: `three` core + BufferGeometryUtils only,
 * no DOM at import time (same posture as transitProviders.ts).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { World } from '../sim/world';
import { BUILDING_DEFS, cellCenterWorld } from '../sim/city';
import { MAX_AMBIENT_CARGOSHIP, type AmbientTransitProvider } from './cityLife';

/** One route waypoint in world units (the provider loops them in order). */
export interface CargoRouteStop {
  x: number;
  z: number;
}

/** The port kinds ambient cargo ships call at (the big civilian ports). */
export const CARGO_PORT_KINDS = ['commercialPort', 'containerPort'] as const;

/** A phase-6 ambient vehicle provider: the crowd contract + route + dispose. */
export interface AmbientCargoShipProvider extends AmbientTransitProvider {
  /** The immutable route snapshot this provider loops. */
  readonly stops: readonly CargoRouteStop[];
  /** Release the provider-owned geometry/material (game-side lifecycle). */
  dispose(): void;
}

/** Cargo-ship provider options (game-side wiring). */
export interface CargoShipProviderOptions {
  /** Water surface height for the hull. */
  waterY?: number;
  /** City population, for the initial `count`. */
  population?: number;
}

/**
 * World points for the owner's completed civilian ports (the big
 * commercial/container kinds — the fishing harbor is too small for
 * container traffic). Deterministic id order (the sim returns id order;
 * kept explicit like the Phase 4 helper).
 */
export function cargoShipRoutePoints(world: World, owner: number): CargoRouteStop[] {
  const ports = world.city.buildings
    .filter(
      (b) =>
        b.owner === owner &&
        b.progress >= 1 &&
        (CARGO_PORT_KINDS as readonly string[]).includes(b.kind) &&
        BUILDING_DEFS[b.kind]?.portType === 'civilian',
    )
    .sort((a, b) => a.id - b.id);
  return ports.map((b) => ({
    x: cellCenterWorld(b.cx),
    z: cellCenterWorld(b.cz),
  }));
}

/**
 * Change key for the owner's civilian-port network: port ids + cells.
 * The game rebuilds the provider only when this moves — population
 * changes flow through the cheap mutable `count` instead, so geometry
 * is allocated at most once per player action.
 */
export function cargoShipRouteKey(world: World, owner: number): string {
  const ports = world.city.buildings
    .filter(
      (b) =>
        b.owner === owner &&
        b.progress >= 1 &&
        (CARGO_PORT_KINDS as readonly string[]).includes(b.kind),
    )
    .sort((a, b) => a.id - b.id);
  return `cargo=${ports.map((b) => `${b.id}@${b.cx},${b.cz}`).join(',')}`;
}

/**
 * Desired live count for ambient cargo ships: 0 until the player owns a
 * real shipping lane (≥2 civilian ports — a single port is not a lane),
 * then the same population scaling as `ambientTransitDensity`
 * (1 ship per 800 residents), clamped to MAX_AMBIENT_CARGOSHIP. Pure —
 * trivially testable.
 */
export function cargoShipVehicleCount(portCount: number, population: number): number {
  if (portCount < 2) return 0;
  const pop = Number.isFinite(population) && population > 0 ? Math.floor(population) : 0;
  return Math.min(MAX_AMBIENT_CARGOSHIP, Math.floor(pop / 800));
}

// ---------------------------------------------------------------------------
// Route math: closed loop through the ports, with a loading dwell at each.
// ---------------------------------------------------------------------------

interface RouteLeg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  len: number;
  yaw: number;
}

interface BakedRoute {
  stops: CargoRouteStop[];
  legs: RouteLeg[];
  totalLen: number;
}

function bakeRoute(stops: readonly CargoRouteStop[]): BakedRoute {
  const kept = stops.map((s) => ({ x: s.x, z: s.z }));
  const n = kept.length;
  const legs: RouteLeg[] = [];
  let totalLen = 0;
  for (let s = 0; s < n; s++) {
    const a = kept[s]!;
    const b = kept[(s + 1) % n]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    legs.push({
      ax: a.x,
      az: a.z,
      bx: b.x,
      bz: b.z,
      len,
      // Model-forward is +X; yaw rotates +X onto the leg direction.
      yaw: len > 0 ? Math.atan2(-dz, dx) : 0,
    });
    totalLen += len;
  }
  return { stops: kept, legs, totalLen };
}

// ---------------------------------------------------------------------------
// Procedural container-ship geometry (vertex-colored merged boxes, one
// material — the Phase 4 vehicle posture). Faces +X, waterline at y=0.
// ---------------------------------------------------------------------------

/** One box part with a flat color, for the merged ship geometry. */
interface ShipPart {
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  color: number;
}

function coloredBox(part: ShipPart): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(part.w, part.h, part.d);
  geo.translate(part.x, part.y, part.z);
  const count = geo.attributes['position']!.count;
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color(part.color);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function buildShipGeometry(parts: ShipPart[]): THREE.BufferGeometry {
  return mergeGeometries(parts.map(coloredBox), false)!;
}

/** Shared flat-shaded vertex-color material for ambient cargo ships. */
function shipMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.6,
    metalness: 0.3,
  });
}

// Container ship: dark hull, rust-red waterline band, stacked container
// rows in faded shipping colors, white bridge tower aft, funnel.
function cargoShipGeometry(): THREE.BufferGeometry {
  const hull = 0x2f3b46;
  const waterline = 0x8e3b2f;
  const bridge = 0xe8e4d8;
  const glass = 0x33454f;
  const containers = [0x7a8a4a, 0x4a6a8a, 0x8a5a3a, 0x5a7a6a, 0x8a7a3a];
  const parts: ShipPart[] = [
    { w: 26, h: 3.4, d: 6.4, x: 0, y: 1.2, z: 0, color: hull }, // hull
    { w: 26.1, h: 0.5, d: 6.45, x: 0, y: 2.6, z: 0, color: waterline }, // waterline band
    { w: 3.4, h: 3.2, d: 4.6, x: -9.5, y: 4.4, z: 0, color: bridge }, // bridge tower
    { w: 2.6, h: 0.7, d: 4.7, x: -9.5, y: 5.0, z: 0, color: glass }, // bridge windows
    { w: 1.4, h: 2.2, d: 1.4, x: -11.6, y: 4.0, z: 0, color: waterline }, // funnel
  ];
  // Container stacks: three rows, two high, faded shipping colors.
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      const color = containers[(r + c) % containers.length]!;
      parts.push({
        w: 3.6,
        h: 1.5,
        d: 1.7,
        x: -4 + c * 3.8,
        y: 3.5,
        z: -2.2 + r * 2.2,
        color,
      });
      parts.push({
        w: 3.6,
        h: 1.5,
        d: 1.7,
        x: -4 + c * 3.8,
        y: 5.0,
        z: -2.2 + r * 2.2,
        color,
      });
    }
  }
  return buildShipGeometry(parts);
}

// ---------------------------------------------------------------------------
// Provider factory.
// ---------------------------------------------------------------------------

/** World units per sim tick — container ships are slow. */
const CARGO_SHIP_SPEED = 0.12;
/** Cargo-handling pause at each port (ticks). */
const CARGO_SHIP_DWELL_TICKS = 90;

/**
 * Cargo-ship provider: loops the player's completed civilian ports in a
 * closed lane with a loading dwell at each port. `poseAt` is pure in
 * (index, tick); ships ride a tiny deterministic swell (a pure function
 * of (index, tick) — no wall clock, so replays stay deterministic).
 */
export function createCargoShipProvider(
  stops: readonly CargoRouteStop[],
  opts: CargoShipProviderOptions = {},
): AmbientCargoShipProvider {
  const route = bakeRoute(stops);
  const geometry = cargoShipGeometry();
  const material = shipMaterial();
  const n = route.stops.length;
  const cycleTicks = n === 0 ? 1 : route.totalLen / CARGO_SHIP_SPEED + CARGO_SHIP_DWELL_TICKS * n;
  const waterY = opts.waterY ?? 0;

  const provider: AmbientCargoShipProvider = {
    geometry,
    material,
    stops: route.stops,
    count: cargoShipVehicleCount(n, opts.population ?? 0),
    poseAt(index: number, tick: number) {
      if (n === 0 || provider.count <= 0) return null;
      // Evenly spaced around the cycle; deterministic in (index, tick).
      const offset = (index * cycleTicks) / Math.max(1, Math.floor(provider.count));
      const swell = 0.3 * Math.sin(tick * 0.04 + index * 1.9);
      let t = (((tick + offset) % cycleTicks) + cycleTicks) % cycleTicks;
      for (let s = 0; s < n; s++) {
        // Dwell at the port: loading cargo, facing the next leg.
        if (t < CARGO_SHIP_DWELL_TICKS) {
          const stop = route.stops[s]!;
          const leg = route.legs[s]!;
          return { x: stop.x, y: waterY + swell, z: stop.z, yaw: leg.yaw };
        }
        t -= CARGO_SHIP_DWELL_TICKS;
        const leg = route.legs[s]!;
        const legTicks = leg.len / CARGO_SHIP_SPEED;
        if (t < legTicks && leg.len > 0) {
          const f = t / legTicks;
          const x = leg.ax + (leg.bx - leg.ax) * f;
          const z = leg.az + (leg.bz - leg.az) * f;
          return { x, y: waterY + swell, z, yaw: leg.yaw };
        }
        t -= legTicks;
      }
      // Numerical safety: park at the first port.
      const stop = route.stops[0]!;
      const leg = route.legs[0]!;
      return { x: stop.x, y: waterY + swell, z: stop.z, yaw: leg.yaw };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };

  return provider;
}
