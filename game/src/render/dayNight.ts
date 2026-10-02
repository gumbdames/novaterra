/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3.0 of the License.
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
 * NOVATERRA — render/dayNight.ts — visual day/night rig
 * (exploration bet C7, 2026-10-02).
 *
 * The sim ALREADY runs a 4-minute day cycle (`DAY_LENGTH_SECONDS = 240`,
 * `daylightFactor(tick)` drives solar farms, `windFactor` drives wind)
 * but night was invisible — lighting was a static noon rig. This module
 * makes the visible sky follow the existing cycle. VISUAL ONLY: no
 * gameplay effect, no AI-fairness implications, no new sim fields.
 *
 * Responsibilities:
 *  - `sunParams(tick)`: pure function of the sim tick (same pattern as
 *    `daylightFactor`) returning every lerped rig parameter. Node-testable,
 *    deterministic — the same tick always yields the same sky.
 *  - `DayNightRig`: the per-scene rig (lights, stars, water dim uniform,
 *    blob-shadow strength). `createDayNightRig` builds it (+1 draw call
 *    for the star field, everything else is parameter lerps on existing
 *    objects: +0); `applyDayNight(rig, tick, targetX, targetZ)` lerps the
 *    noon rig toward the params; `disposeDayNightRig` removes the stars.
 *  - Everything derives from the sim tick, never wall-clock: pause ⇒
 *    frozen sky (tick doesn't advance); save/load ⇒ zero new fields
 *    (phase derives from the snapshotted tick).
 *  - The trailer (`?trailer=1`) pins a fixed golden-hour phase via
 *    `GOLDEN_HOUR_TICK` — ~7,400 captured ticks ≈ one full cycle, so a
 *    cycling sky would strobe through day/night mid-movie.
 *
 * Readability contract (acceptance criteria):
 *  - Never fully dark: sun floors at 0.06, hemisphere at 0.22, exposure
 *    at 0.45, and the night sky is deep blue, never black.
 *  - Emissive UI elements stay bright: gameplay-critical overlay
 *    materials (selection rings, chevrons, health bars, damage numbers,
 *    placement ghost) set `toneMapped: false` at creation — immune to
 *    the exposure lerp, zero per-frame cost.
 *  - Blob shadows fade with darkness (they're fake AO decals; full
 *    strength at night would look painted on).
 *
 * Art QA rule: every future art pass must be eyeballed at 4 times of
 * day (dawn / noon / golden hour / deep night) — the rig changes what
 * every material looks like. See src/render/AGENTS.md.
 */

import * as THREE from 'three';
import { daylightFactor, DAY_LENGTH_SECONDS } from '../sim/utilityNetworks';

/** Linear-space rgb triplet. */
export type LinearRGB = [number, number, number];

/** Every lerped parameter of the rig for one tick. */
export interface SunParams {
  /** 0..1 from daylightFactor(tick) — 0 = night, 1 = full day. */
  readonly daylight: number;
  /** Directional "sun" intensity: 2.0 (noon) → 0.06 (night). */
  readonly sunIntensity: number;
  /** Directional light color (linear). */
  readonly sunColor: LinearRGB;
  /** Hemisphere intensity: 1.1 → 0.22. */
  readonly hemiIntensity: number;
  /** Hemisphere sky/ground colors (linear). */
  readonly hemiSky: LinearRGB;
  readonly hemiGround: LinearRGB;
  /** Scene background + fog color (linear; kept equal so the horizon blends). */
  readonly sky: LinearRGB;
  readonly fog: LinearRGB;
  /** Renderer exposure: 1.0 → 0.45 (never fully dark). */
  readonly exposure: number;
  /** scene.environmentIntensity: 0.5 → 0.06. */
  readonly envIntensity: number;
  /** Star-field opacity: 0..1 (visible only in deep night). */
  readonly stars: number;
  /** Night-window emissive on the shared glass: 0..1. */
  readonly windows: number;
  /** Water TSL brighten multiplier: 1.0 → 0.5. */
  readonly waterDim: number;
  /** Blob-shadow strength multiplier: 1.0 → 0.3 (shadows fade at night). */
  readonly blobShadow: number;
}

/** sRGB hex → linear working-space triplet (matches renderer output). */
function hexToLinear(hex: number): LinearRGB {
  const c = new THREE.Color(hex); // ColorManagement: hex → linear
  return [c.r, c.g, c.b];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** Piecewise-smoothstep ramp over [daylight, value] stops. */
function stopAt(stops: ReadonlyArray<readonly [number, number]>, i: number): readonly [number, number] {
  const s = stops[i];
  if (!s) throw new Error(`dayNight: stop index ${i} out of range`);
  return s;
}
function ramp(stops: ReadonlyArray<readonly [number, number]>, d: number): number {
  if (d <= stopAt(stops, 0)[0]) return stopAt(stops, 0)[1];
  for (let i = 1; i < stops.length; i++) {
    const d0 = stopAt(stops, i - 1)[0];
    const v0 = stopAt(stops, i - 1)[1];
    const d1 = stopAt(stops, i)[0];
    const v1 = stopAt(stops, i)[1];
    if (d <= d1) return lerp(v0, v1, smooth((d - d0) / (d1 - d0)));
  }
  return stopAt(stops, stops.length - 1)[1];
}

/** Piecewise-smoothstep ramp over [daylight, sRGB hex] stops. */
function rampColor(stops: ReadonlyArray<readonly [number, number]>, d: number): LinearRGB {
  if (d <= stopAt(stops, 0)[0]) return hexToLinear(stopAt(stops, 0)[1]);
  for (let i = 1; i < stops.length; i++) {
    const d0 = stopAt(stops, i - 1)[0];
    const h0 = stopAt(stops, i - 1)[1];
    const d1 = stopAt(stops, i)[0];
    const h1 = stopAt(stops, i)[1];
    if (d <= d1) {
      const t = smooth((d - d0) / (d1 - d0));
      const c0 = hexToLinear(h0);
      const c1 = hexToLinear(h1);
      return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
    }
  }
  return hexToLinear(stopAt(stops, stops.length - 1)[1]);
}

// --- Ramps (all keyed on daylight 0..1) -----------------------------------
// The sky ramp is the art: night is deep blue (never black), dawn lifts
// through slate blue, golden hour goes warm amber, day is the existing
// noon blue (0x87a8c8 — the rig must reproduce the old noon look exactly
// at d=1 so the pre-C7 screenshots stay valid).

const SKY_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x0a1424], // deep night blue — never black
  [0.18, 0x46587a], // dawn slate
  [0.35, 0xd99a5f], // golden hour amber
  [0.6, 0x87a8c8], // day blue
  [1.0, 0x87a8c8], // noon (pre-C7 look)
];

const SUN_COLOR_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x8ea3d4], // cool moonlight
  [0.35, 0xffb066], // golden
  [1.0, 0xfff2dd], // noon (pre-C7 look)
];

const SUN_INTENSITY_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.06],
  [0.35, 1.35],
  [1.0, 2.0], // noon (pre-C7 look)
];

const HEMI_INTENSITY_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.22],
  [1.0, 1.1], // noon (pre-C7 look)
];

const HEMI_SKY_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x1e2c46],
  [1.0, 0xbfd8ff], // noon (pre-C7 look)
];

const HEMI_GROUND_STOPS: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0x0a0c0a],
  [1.0, 0x3a4a3a], // noon (pre-C7 look)
];

/**
 * Pure sun parameters for a sim tick. Deterministic: same tick ⇒ same
 * params on every engine (the only transcendental is inside
 * `daylightFactor`, which documents its determinism).
 */
export function sunParams(tick: number): SunParams {
  const d = daylightFactor(tick);
  return {
    daylight: d,
    sunIntensity: ramp(SUN_INTENSITY_STOPS, d),
    sunColor: rampColor(SUN_COLOR_STOPS, d),
    hemiIntensity: ramp(HEMI_INTENSITY_STOPS, d),
    hemiSky: rampColor(HEMI_SKY_STOPS, d),
    hemiGround: rampColor(HEMI_GROUND_STOPS, d),
    sky: rampColor(SKY_STOPS, d),
    fog: rampColor(SKY_STOPS, d),
    exposure: lerp(0.45, 1.0, smooth(d)),
    envIntensity: lerp(0.06, 0.5, smooth(d)),
    stars: 1 - smooth(d / 0.15),
    windows: 1 - smooth(d / 0.3),
    waterDim: lerp(0.5, 1.0, smooth(d / 0.5)),
    blobShadow: lerp(0.3, 1.0, smooth(d / 0.4)),
  };
}

/**
 * A sim tick pinned at golden hour (daylight ≈ 0.35). The trailer
 * director applies the rig once with this tick — ~7,400 captured ticks
 * ≈ one full 240 s cycle, so a live sky would strobe mid-movie.
 */
export const GOLDEN_HOUR_TICK = 410;

/** Ticks per full day/night cycle (30 ticks/sec × 240 s). */
export const DAY_NIGHT_TICKS = Math.round(DAY_LENGTH_SECONDS * 30);

// --- The rig ----------------------------------------------------------------

/** Minimal renderer seam the rig needs (keeps it headless-testable). */
export interface DayNightRenderer {
  toneMappingExposure: number;
}

/** Per-scene day/night rig. Created once per game/trailer scene. */
export interface DayNightRig {
  readonly scene: THREE.Scene;
  readonly renderer: DayNightRenderer;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly stars: THREE.Points;
  /** TSL day/night dim uniform on the water material (null if absent). */
  readonly waterDim: { value: number } | null;
  /** Blob-shadow strength sink (EntityRenderer). */
  readonly setBlobShadowStrength: (f: number) => void;
  /** Last tick applied (frame-dedup: paused ⇒ tick static ⇒ no work). */
  lastTick: number;
  /** Target the star dome follows (camera target x/z). */
  lastTargetX: number;
  lastTargetZ: number;
}

/** Find the key lights of a scene built by buildGameScene/buildMenuScene. */
export function findSceneLights(scene: THREE.Scene): {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
} {
  let sun: THREE.DirectionalLight | null = null;
  let hemi: THREE.HemisphereLight | null = null;
  scene.traverse((obj) => {
    if (sun === null && obj instanceof THREE.DirectionalLight) sun = obj;
    if (hemi === null && obj instanceof THREE.HemisphereLight) hemi = obj;
  });
  if (sun === null || hemi === null) {
    throw new Error('dayNight: scene has no directional + hemisphere light pair');
  }
  return { sun, hemi };
}

/** Deterministic PRNG for the star field (render-only; fixed seed). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Star count for the single THREE.Points (+1 draw call, 0 when hidden). */
export const DAY_NIGHT_STAR_COUNT = 700;
/** Star dome radius (camera far plane is 4000; map is ~2 km). */
export const DAY_NIGHT_STAR_RADIUS = 2200;

/** Build the star dome: upper-hemisphere points, fog-immune, depth-safe. */
function buildStars(): THREE.Points {
  const rand = mulberry32(1337);
  const positions = new Float32Array(DAY_NIGHT_STAR_COUNT * 3);
  for (let i = 0; i < DAY_NIGHT_STAR_COUNT; i++) {
    // Uniform on the upper hemisphere (y > 0.08 — nothing below the horizon).
    const u = rand();
    const v = rand();
    const theta = 2 * Math.PI * u;
    const y = 0.08 + 0.92 * v;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const rad = DAY_NIGHT_STAR_RADIUS * (0.85 + 0.15 * rand());
    positions[i * 3] = Math.cos(theta) * r * rad;
    positions[i * 3 + 1] = y * rad;
    positions[i * 3 + 2] = Math.sin(theta) * r * rad;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xcfe0ff,
    size: 2.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // dome spans the sky; never cull the whole thing
  points.visible = false;
  points.renderOrder = -10; // behind everything
  points.name = 'dayNightStars';
  return points;
}

export interface CreateRigOpts {
  scene: THREE.Scene;
  renderer: DayNightRenderer;
  /** The terrain view's water mesh (for the TSL dim uniform). */
  water: THREE.Object3D | null;
  setBlobShadowStrength: (f: number) => void;
}

/** Create the per-scene rig. Adds exactly one object (the star dome). */
export function createDayNightRig(opts: CreateRigOpts): DayNightRig {
  const { sun, hemi } = findSceneLights(opts.scene);
  const stars = buildStars();
  opts.scene.add(stars);
  const waterMat = (opts.water as THREE.Mesh | null)?.material as
    | THREE.MeshStandardMaterial
    | undefined;
  const waterDim =
    (waterMat?.userData?.['dayNightDim'] as { value: number } | undefined) ??
    null;
  return {
    scene: opts.scene,
    renderer: opts.renderer,
    sun,
    hemi,
    stars,
    waterDim,
    setBlobShadowStrength: opts.setBlobShadowStrength,
    lastTick: -1,
    lastTargetX: Number.NaN,
    lastTargetZ: Number.NaN,
  };
}

export interface ApplyDayNightOpts {
  /**
   * Keep the scene's baked background + fog (the trailer's sunset
   * gradient): only lights, water, windows, stars and shadows follow
   * the pinned phase.
   */
  keepBackground?: boolean;
}

/**
 * Apply the sky for a sim tick. Cheap: ~15 lerps + a few color writes;
 * no-ops entirely when the tick and camera target are unchanged (pause ⇒
 * frozen sky for free). Drives everything the brief lists: sun, hemi,
 * sky/fog, exposure, env intensity, water TSL dim, night windows, stars,
 * blob-shadow fade. +0 draw calls (the star dome is created once).
 */
export function applyDayNight(
  rig: DayNightRig,
  tick: number,
  targetX: number,
  targetZ: number,
  opts: ApplyDayNightOpts = {},
): void {
  if (
    tick === rig.lastTick &&
    targetX === rig.lastTargetX &&
    targetZ === rig.lastTargetZ
  ) {
    return;
  }
  rig.lastTick = tick;
  rig.lastTargetX = targetX;
  rig.lastTargetZ = targetZ;

  const p = sunParams(tick);

  rig.sun.intensity = p.sunIntensity;
  rig.sun.color.setRGB(...p.sunColor);
  rig.hemi.intensity = p.hemiIntensity;
  rig.hemi.color.setRGB(...p.hemiSky);
  rig.hemi.groundColor.setRGB(...p.hemiGround);

  if (!opts.keepBackground) {
    const bg = rig.scene.background;
    if (bg instanceof THREE.Color) bg.setRGB(...p.sky);
    const fog = rig.scene.fog;
    if (fog instanceof THREE.Fog) fog.color.setRGB(...p.fog);
  }

  rig.renderer.toneMappingExposure = p.exposure;
  rig.scene.environmentIntensity = p.envIntensity;

  if (rig.waterDim !== null) rig.waterDim.value = p.waterDim;
  setGlassNightGlow(p.windows);
  rig.setBlobShadowStrength(p.blobShadow);

  // Star dome follows the camera target; hidden (0 draw cost) by day.
  rig.stars.position.set(targetX, 0, targetZ);
  const starMat = rig.stars.material as THREE.PointsMaterial;
  starMat.opacity = p.stars;
  rig.stars.visible = p.stars > 0.01;
}

/** Remove the rig's scene objects (the star dome). Lights stay with the scene. */
export function disposeDayNightRig(rig: DayNightRig): void {
  rig.scene.remove(rig.stars);
  rig.stars.geometry.dispose();
  (rig.stars.material as THREE.Material).dispose();
}

// --- Night-window glass registry --------------------------------------------
// `surfaceMaterial('glassBlue', …)` clones feed this set (see
// render/entitySurfaces.ts): one entry per built model kind's glass, all
// shared — so one emissive write lights every window of that kind. +0
// draw calls. Cleared with the model map on dispose.

const glassMaterials = new Set<THREE.MeshStandardMaterial>();

/** Track a glass material for night-window glow. */
export function registerGlassMaterial(mat: THREE.MeshStandardMaterial): void {
  glassMaterials.add(mat);
}

/** Drop all tracked glass (call when the model map is disposed). */
export function clearGlassRegistry(): void {
  glassMaterials.clear();
}

/** For tests: how many glass materials are tracked. */
export function glassRegistrySize(): number {
  return glassMaterials.size;
}

/**
 * Night-window glow 0..1: warm emissive on every tracked glass material.
 * Windows read as lit at night, dark by day. The emissive is flat (no
 * per-window variation) — a 0.1 Alpha coherence pass, not a lighting sim.
 */
export function setGlassNightGlow(f: number): void {
  const g = Math.min(1, Math.max(0, f));
  for (const m of glassMaterials) {
    if (g <= 0.001) {
      m.emissive.setHex(0x000000);
      m.emissiveIntensity = 1;
    } else {
      m.emissive.setHex(0xffb45e);
      m.emissiveIntensity = g * 0.85;
    }
  }
}
