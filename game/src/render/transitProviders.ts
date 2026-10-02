/**
 * transitProviders.ts — Phase 4 (transport) ambient transit vehicles.
 *
 * The crowd (`render/cityLife.ts`) renders ambient buses, trams, and
 * ferries through the `AmbientTransitProvider` contract: provider-owned
 * geometry + material, a mutable `count`, and a `poseAt(index, tick)`
 * that is pure in (index, tick) for a fixed route. This module is the
 * render-side factory for those three providers plus the small pure
 * helpers the game controller uses to wire them:
 *
 *   - `transitRoutePoints(world, owner, mode)` — the immutable route
 *     snapshot a provider loops (operational stop/station buildings
 *     serving the mode, via the sim's `transitStopsForMode`).
 *   - `transitRouteKey(world, owner)` — a cheap change key: the game
 *     rebuilds providers only when this moves (player actions), never
 *     on population ticks, so provider geometry is never churned.
 *   - `transitVehicleCount(type, stopCount, population)` — the live
 *     `count`: zero until the player owns a real route (≥2 stops), then
 *     the same population scaling as `ambientTransitDensity`.
 *
 * No gameplay logic here — vehicles are decorative, exactly like the
 * ambient pedestrians and cars. The sim never sees them.
 *
 * Import-safe under Node/vitest: `three` core + BufferGeometryUtils only,
 * no DOM at import time (same posture as proceduralModels.ts).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import type { World } from '../sim/world';
import {
  cellCenterWorld,
  transitStopsForMode,
  type TransitMode,
} from '../sim/city';
import {
  MAX_AMBIENT_BUS,
  MAX_AMBIENT_FERRY,
  MAX_AMBIENT_TRAM,
  type AmbientTransitProvider,
} from './cityLife';

/** One route waypoint in world units (the provider loops them in order). */
export interface TransitRouteStop {
  x: number;
  z: number;
}

/**
 * A phase-4 ambient vehicle provider: the crowd contract plus the route
 * snapshot and a `dispose()` the game calls when the route changes (the
 * crowd never disposes provider assets — see cityLife.ts).
 */
export interface AmbientVehicleProvider extends AmbientTransitProvider {
  /** The immutable route snapshot this provider loops. */
  readonly stops: readonly TransitRouteStop[];
  /** Release the provider-owned geometry/material (game-side lifecycle). */
  dispose(): void;
}

/** The transit type key the crowd registers each provider under. */
export type TransitProviderType = 'bus' | 'tram' | 'ferry';

/** World points for the player's operational stops serving a mode. */
export function transitRoutePoints(
  world: World,
  owner: number,
  mode: TransitMode,
): TransitRouteStop[] {
  const stops = transitStopsForMode(world, owner, mode);
  // Deterministic order (the sim returns id order; keep it explicit).
  stops.sort((a, b) => a.id - b.id);
  return stops.map((b) => ({
    x: cellCenterWorld(b.cx),
    z: cellCenterWorld(b.cz),
  }));
}

/**
 * Change key for the player's transit networks: stop ids + cells per
 * mode. The game rebuilds providers only when this moves — population
 * changes flow through the cheap mutable `count` instead, so geometry
 * is allocated at most once per player action.
 */
export function transitRouteKey(world: World, owner: number): string {
  const modes: TransitMode[] = ['bus', 'tram', 'boat'];
  return modes
    .map((mode) => {
      const stops = transitStopsForMode(world, owner, mode);
      stops.sort((a, b) => a.id - b.id);
      return `${mode}=${stops.map((b) => `${b.id}@${b.cx},${b.cz}`).join(',')}`;
    })
    .join(';');
}

/**
 * Desired live count for a transit type: 0 until the player owns a real
 * route (≥2 operational stops — a single stop is not a loop), then the
 * same population scaling as `ambientTransitDensity` (cityLife.ts),
 * clamped to the per-type cap. Pure — trivially testable.
 */
export function transitVehicleCount(
  type: TransitProviderType,
  stopCount: number,
  population: number,
): number {
  if (stopCount < 2) return 0;
  const pop = Number.isFinite(population) && population > 0 ? Math.floor(population) : 0;
  switch (type) {
    case 'bus':
      return Math.min(MAX_AMBIENT_BUS, Math.floor(pop / 150));
    case 'tram':
      return Math.min(MAX_AMBIENT_TRAM, Math.floor(pop / 400));
    case 'ferry':
      return Math.min(MAX_AMBIENT_FERRY, Math.floor(pop / 600));
  }
}

// ---------------------------------------------------------------------------
// Route math: closed loop through the stops, with a dwell pause at each.
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
  stops: TransitRouteStop[];
  legs: RouteLeg[];
  totalLen: number;
}

function bakeRoute(stops: readonly TransitRouteStop[]): BakedRoute {
  const kept = stops.map((s) => ({ x: s.x, z: s.z }));
  const n = kept.length;
  const legs: RouteLeg[] = [];
  let totalLen = 0;
  for (let s = 0; s < n; s++) {
    // B27: no `!` — s and (s+1)%n are bounded by kept.length (= n > 0 here).
    const a = kept[s];
    const b = kept[(s + 1) % n];
    if (a === undefined || b === undefined) continue;
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
// Procedural vehicle geometry (vertex-colored merged boxes, one material).
// ---------------------------------------------------------------------------

/** One box part with a flat color, for the merged vehicle geometry. */
interface VehiclePart {
  w: number;
  h: number;
  d: number;
  x: number;
  y: number;
  z: number;
  color: number;
}

function coloredBox(part: VehiclePart): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(part.w, part.h, part.d);
  geo.translate(part.x, part.y, part.z);
  // B27: no `!` — a BoxGeometry always carries a position attribute;
  // its absence is a loud build error, never silent.
  const posAttr = geo.attributes['position'];
  if (posAttr === undefined) {
    throw new Error('transitProviders: BoxGeometry missing position attribute');
  }
  const count = posAttr.count;
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

function buildVehicleGeometry(parts: VehiclePart[]): THREE.BufferGeometry {
  const merged = mergeGeometries(
    parts.map(coloredBox),
    false,
  );
  // B27: no `!` — a null merge is a loud build error, never silent.
  if (merged === null) throw new Error('buildVehicleGeometry: mergeGeometries failed');
  return merged;
}

/** Shared flat-shaded vertex-color material for ambient vehicles. */
function vehicleMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.65,
    metalness: 0.2,
  });
}

// City-bus amber, dark window band, wheels — faces +X, origin at ground.
function busGeometry(): THREE.BufferGeometry {
  const amber = 0xd8912a;
  const glass = 0x2b3a44;
  const dark = 0x1e1e22;
  return buildVehicleGeometry([
    { w: 9, h: 2.2, d: 2.8, x: 0, y: 1.6, z: 0, color: amber },
    { w: 7.6, h: 0.7, d: 2.86, x: -0.2, y: 2.1, z: 0, color: glass },
    { w: 0.9, h: 1.4, d: 2.5, x: 4.6, y: 1.5, z: 0, color: glass }, // windshield
    { w: 1.1, h: 0.9, d: 1.1, x: 2.9, y: 0.45, z: 1.15, color: dark },
    { w: 1.1, h: 0.9, d: 1.1, x: 2.9, y: 0.45, z: -1.15, color: dark },
    { w: 1.1, h: 0.9, d: 1.1, x: -2.9, y: 0.45, z: 1.15, color: dark },
    { w: 1.1, h: 0.9, d: 1.1, x: -2.9, y: 0.45, z: -1.15, color: dark },
    { w: 9.1, h: 0.25, d: 2.9, x: 0, y: 2.85, z: 0, color: 0xb06f1f }, // roof
  ]);
}

// Tram: longer red body, pantograph — faces +X, origin at ground.
function tramGeometry(): THREE.BufferGeometry {
  const red = 0xb03a2e;
  const glass = 0x2b3a44;
  const dark = 0x222226;
  return buildVehicleGeometry([
    { w: 12, h: 2.3, d: 2.6, x: 0, y: 1.75, z: 0, color: red },
    { w: 10.6, h: 0.8, d: 2.66, x: 0, y: 2.25, z: 0, color: glass },
    { w: 0.8, h: 1.5, d: 2.3, x: 6.1, y: 1.6, z: 0, color: glass }, // cab window
    { w: 2.2, h: 0.5, d: 2.2, x: 3.6, y: 0.55, z: 0, color: dark }, // bogies
    { w: 2.2, h: 0.5, d: 2.2, x: -3.6, y: 0.55, z: 0, color: dark },
    { w: 0.18, h: 1.1, d: 0.18, x: 0, y: 3.4, z: 0, color: dark }, // pantograph mast
    { w: 1.8, h: 0.12, d: 0.9, x: 0, y: 3.95, z: 0, color: dark }, // pantograph arm
  ]);
}

// Ferry: hull + cabin, waterline at y=0 — faces +X.
function ferryGeometry(): THREE.BufferGeometry {
  const white = 0xe9e5da;
  const glass = 0x33454f;
  const stripe = 0x2e6f8e;
  return buildVehicleGeometry([
    { w: 11, h: 1.7, d: 3.8, x: 0, y: 0.75, z: 0, color: white }, // hull
    { w: 11.1, h: 0.35, d: 3.85, x: 0, y: 1.45, z: 0, color: stripe }, // waterline stripe
    { w: 5.5, h: 1.7, d: 2.9, x: -0.8, y: 2.5, z: 0, color: white }, // cabin
    { w: 4.6, h: 0.6, d: 2.96, x: -0.8, y: 2.8, z: 0, color: glass }, // windows
    { w: 0.9, h: 1.6, d: 0.9, x: -3.6, y: 3.6, z: 0, color: stripe }, // funnel
    { w: 2.2, h: 0.5, d: 0.5, x: 4.4, y: 1.9, z: 0, color: stripe }, // bow rail
  ]);
}

// ---------------------------------------------------------------------------
// Provider factory.
// ---------------------------------------------------------------------------

interface VehicleSpec {
  type: TransitProviderType;
  speed: number; // world units per sim tick
  dwellTicks: number; // pause at each stop
  geometry: () => THREE.BufferGeometry;
  bob: boolean; // ferries ride a tiny deterministic swell
}

const VEHICLE_SPECS: Record<TransitProviderType, VehicleSpec> = {
  bus: { type: 'bus', speed: 0.25, dwellTicks: 30, geometry: busGeometry, bob: false },
  tram: { type: 'tram', speed: 0.35, dwellTicks: 30, geometry: tramGeometry, bob: false },
  ferry: { type: 'ferry', speed: 0.15, dwellTicks: 60, geometry: ferryGeometry, bob: true },
};

export interface TransitProviderOptions {
  /** Ground height lookup for road vehicles (buses/trams). */
  groundY?: (x: number, z: number) => number;
  /** Water surface height for ferries. */
  waterY?: number;
  /** City population, for the initial `count`. */
  population?: number;
}

function createProvider(
  spec: VehicleSpec,
  stops: readonly TransitRouteStop[],
  opts: TransitProviderOptions = {},
): AmbientVehicleProvider {
  const route = bakeRoute(stops);
  const geometry = spec.geometry();
  const material = vehicleMaterial();
  const n = route.stops.length;
  const cycleTicks =
    n === 0 ? 1 : route.totalLen / spec.speed + spec.dwellTicks * n;
  const groundY = opts.groundY;
  const waterY = opts.waterY ?? 0;

  const provider: AmbientVehicleProvider = {
    geometry,
    material,
    stops: route.stops,
    count: transitVehicleCount(spec.type, n, opts.population ?? 0),
    poseAt(index: number, tick: number) {
      if (n === 0 || provider.count <= 0) return null;
      // Evenly spaced around the cycle; deterministic in (index, tick).
      const offset = (index * cycleTicks) / Math.max(1, Math.floor(provider.count));
      // The ferry swell phase: a pure function of (index, tick) — no wall
      // clock, so replays and snapshots stay deterministic.
      const swell = spec.bob ? 0.25 * Math.sin(tick * 0.05 + index * 1.7) : 0;
      const yAt = (x: number, z: number): number =>
        spec.bob ? waterY + swell : groundY !== undefined ? groundY(x, z) : 0;
      let t = (((tick + offset) % cycleTicks) + cycleTicks) % cycleTicks;
      for (let s = 0; s < n; s++) {
        // Dwell at the stop: parked, facing the next leg.
        if (t < spec.dwellTicks) {
          // B27: no `!` — s is bounded by n = route.stops.length = route.legs.length.
          const stop = route.stops[s];
          const leg = route.legs[s];
          if (stop === undefined || leg === undefined) continue;
          return { x: stop.x, y: yAt(stop.x, stop.z), z: stop.z, yaw: leg.yaw };
        }
        t -= spec.dwellTicks;
        // B27: no `!` — same bound as above.
        const leg = route.legs[s];
        if (leg === undefined) continue;
        const legTicks = leg.len / spec.speed;
        if (t < legTicks && leg.len > 0) {
          const f = t / legTicks;
          const x = leg.ax + (leg.bx - leg.ax) * f;
          const z = leg.az + (leg.bz - leg.az) * f;
          return { x, y: yAt(x, z), z, yaw: leg.yaw };
        }
        t -= legTicks;
      }
      // Numerical safety: park at the first stop.
      // B27: no `!` — poseAt returns null up front when n === 0, so the
      // first stop and leg always exist here.
      const stop = route.stops[0];
      const leg = route.legs[0];
      if (stop === undefined || leg === undefined) return null;
      return { x: stop.x, y: yAt(stop.x, stop.z), z: stop.z, yaw: leg.yaw };
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };

  return provider;
}

/** Bus provider: loops the player's operational bus-served stops. */
export function createBusProvider(
  stops: readonly TransitRouteStop[],
  opts: TransitProviderOptions = {},
): AmbientVehicleProvider {
  return createProvider(VEHICLE_SPECS.bus, stops, opts);
}

/** Tram provider: loops the player's operational tram-served stops. */
export function createTramProvider(
  stops: readonly TransitRouteStop[],
  opts: TransitProviderOptions = {},
): AmbientVehicleProvider {
  return createProvider(VEHICLE_SPECS.tram, stops, opts);
}

/** Ferry provider: loops the player's operational boat-served stops. */
export function createFerryProvider(
  stops: readonly TransitRouteStop[],
  opts: TransitProviderOptions = {},
): AmbientVehicleProvider {
  return createProvider(VEHICLE_SPECS.ferry, stops, opts);
}
