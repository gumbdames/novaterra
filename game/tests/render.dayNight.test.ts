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
 * NOVATERRA — exploration bet C7 (2026-10-02): visual day/night rig.
 *
 * Covers:
 *  - `sunParams(tick)` purity: deterministic (same tick ⇒ same params),
 *    phase math (dawn → noon → dusk → night over the 240 s cycle),
 *    noon reproduction (the pre-C7 look at d=1), and the readability
 *    floors (never fully dark).
 *  - The rig (headless three.js): creation adds exactly one object (the
 *    star dome, +1 draw call — everything else is parameter lerps, +0);
 *    applying params drives sun/hemi/sky/fog/exposure/env/water/stars/
 *    blob shadows; pause invariance (same tick twice ⇒ same result);
 *    save/load invariance (phase is a pure function of tick — zero new
 *    fields); the trailer's `keepBackground` pin.
 *  - Night-window glass: registry + glow writes.
 *  - Water: the TSL dim uniform exists on the built water material.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  sunParams,
  createDayNightRig,
  applyDayNight,
  disposeDayNightRig,
  GOLDEN_HOUR_TICK,
  DAY_NIGHT_TICKS,
  DAY_NIGHT_STAR_COUNT,
  registerGlassMaterial,
  setGlassNightGlow,
  clearGlassRegistry,
  glassRegistrySize,
} from '../src/render/dayNight';
import { daylightFactor } from '../src/sim/utilityNetworks';
import { buildTerrainView } from '../src/render/terrain';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';

/** Production terrain (same as the terrain view test): 16 chunks + water. */
function prodTerrain() {
  return generateTerrain(MERIDIAN_PLAINS.seed);
}

/** A noon-rig scene like ui/game.ts buildGameScene. */
function noonScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a8c8);
  scene.fog = new THREE.Fog(0x87a8c8, 380, 1400);
  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x3a4a3a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
  sun.position.set(120, 180, 60);
  scene.add(sun);
  return scene;
}

/** Field-wise float-tolerant comparison of two SunParams. */
function expectSunParamsClose(
  a: ReturnType<typeof sunParams>,
  b: ReturnType<typeof sunParams>,
): void {
  const numKeys = [
    'daylight',
    'sunIntensity',
    'hemiIntensity',
    'exposure',
    'envIntensity',
    'waterDim',
    'blobShadow',
    'stars',
    'windows',
  ] as const;
  for (const k of numKeys) expect(a[k]).toBeCloseTo(b[k], 12);
  const arrKeys = ['sky', 'sunColor', 'fog'] as const;
  for (const k of arrKeys) {
    expect(a[k]).toHaveLength(b[k].length);
    a[k].forEach((v, i) => {
      // B27: no `!` — the lengths match, so the cast documents it.
      expect(v).toBeCloseTo(b[k][i] as number, 12);
    });
  }
}

describe('sunParams(tick) — pure', () => {
  it('is deterministic: same tick, same params', () => {
    for (const tick of [0, 410, 1800, 3600, 5400, 123456]) {
      expect(sunParams(tick)).toEqual(sunParams(tick));
    }
  });
  it('follows the 240 s cycle: dawn → noon → dusk → night', () => {
    // tick 0 = sunrise (daylight 0), quarter cycle = full day,
    // half cycle = sunset, three-quarter = deep night.
    expect(sunParams(0).daylight).toBeCloseTo(0, 6);
    expect(sunParams(DAY_NIGHT_TICKS / 4).daylight).toBeCloseTo(1, 6);
    expect(sunParams(DAY_NIGHT_TICKS / 2).daylight).toBeCloseTo(0, 6);
    expect(sunParams((3 * DAY_NIGHT_TICKS) / 4).daylight).toBeCloseTo(0, 6);
    // Full period: identical sky (to float tolerance — the sim's
    // daylightFactor reduces the raw tick on a slightly different float
    // path, so the two evaluations can differ at the 1e-16 level).
    expectSunParamsClose(sunParams(1234), sunParams(1234 + DAY_NIGHT_TICKS));
  });

  it('reproduces the pre-C7 noon look exactly at full daylight', () => {
    const p = sunParams(DAY_NIGHT_TICKS / 4);
    expect(p.sunIntensity).toBeCloseTo(2.0, 6);
    expect(p.hemiIntensity).toBeCloseTo(1.1, 6);
    expect(p.exposure).toBeCloseTo(1.0, 6);
    expect(p.envIntensity).toBeCloseTo(0.5, 6);
    expect(p.waterDim).toBeCloseTo(1.0, 6);
    expect(p.blobShadow).toBeCloseTo(1.0, 6);
    expect(p.stars).toBeCloseTo(0, 6);
    expect(p.windows).toBeCloseTo(0, 6);
    // Sky = the old noon blue (linear).
    const noon = new THREE.Color(0x87a8c8);
    expect(p.sky[0]).toBeCloseTo(noon.r, 4);
    expect(p.sky[1]).toBeCloseTo(noon.g, 4);
    expect(p.sky[2]).toBeCloseTo(noon.b, 4);
  });

  it('never goes fully dark: readability floors hold at deep night', () => {
    const p = sunParams((3 * DAY_NIGHT_TICKS) / 4);
    // Floors raised 2026-10-05 (the old 0.06/0.22/0.45 night was
    // unreadably dark on real displays).
    expect(p.sunIntensity).toBeGreaterThanOrEqual(0.18);
    expect(p.hemiIntensity).toBeGreaterThanOrEqual(0.45);
    expect(p.exposure).toBeGreaterThanOrEqual(0.62);
    expect(p.envIntensity).toBeGreaterThanOrEqual(0.06);
    // Night sky is deep blue, never black.
    const lum = 0.2126 * p.sky[0] + 0.7152 * p.sky[1] + 0.0722 * p.sky[2];
    expect(lum).toBeGreaterThan(0.005);
    // …but clearly night: stars out, windows lit, water dimmed.
    expect(p.stars).toBeCloseTo(1, 6);
    expect(p.windows).toBeCloseTo(1, 6);
    expect(p.waterDim).toBeLessThan(1.0);
    expect(p.blobShadow).toBeLessThan(1.0);
  });

  it('golden-hour tick sits in the warm part of the ramp', () => {
    const d = daylightFactor(GOLDEN_HOUR_TICK);
    expect(d).toBeGreaterThan(0.2);
    expect(d).toBeLessThan(0.5);
    const p = sunParams(GOLDEN_HOUR_TICK);
    expect(p.stars).toBeCloseTo(0, 6); // no stars at golden hour
    expect(p.sunIntensity).toBeGreaterThan(0.18);
    expect(p.sunIntensity).toBeLessThan(2.0);
  });

  it('ramps are smooth: no jumps between adjacent ticks', () => {
    let prev = sunParams(0);
    for (let t = 60; t <= DAY_NIGHT_TICKS; t += 60) {
      const p = sunParams(t);
      expect(Math.abs(p.sunIntensity - prev.sunIntensity)).toBeLessThan(0.35);
      expect(Math.abs(p.exposure - prev.exposure)).toBeLessThan(0.2);
      prev = p;
    }
  });
});

describe('DayNightRig — headless three.js', () => {
  function setup() {
    const scene = noonScene();
    const renderer = { toneMappingExposure: 1.0 };
    const view = buildTerrainView(prodTerrain());
    scene.add(view.group);
    const setBlobShadowStrength = vi.fn();
    const before = scene.children.length;
    const rig = createDayNightRig({
      scene,
      renderer,
      water: view.water,
      setBlobShadowStrength,
    });
    return { scene, renderer, rig, view, setBlobShadowStrength, before };
  }

  it('creation adds exactly one object (the star dome): +1 draw call', () => {
    const { scene, before, rig } = setup();
    expect(scene.children.length).toBe(before + 1);
    expect(rig.stars).toBeInstanceOf(THREE.Points);
    const pos = rig.stars.geometry.getAttribute('position') as THREE.BufferAttribute;
    expect(pos.count).toBe(DAY_NIGHT_STAR_COUNT);
    disposeDayNightRig(rig);
    expect(scene.children.length).toBe(before);
  });

  it('applies deep-night params from the tick', () => {
    const { rig, renderer, setBlobShadowStrength } = setup();
    const nightTick = (3 * DAY_NIGHT_TICKS) / 4;
    applyDayNight(rig, nightTick, 0, 0);
    expect(rig.sun.intensity).toBeCloseTo(0.18, 4);
    expect(rig.hemi.intensity).toBeCloseTo(0.45, 4);
    expect(renderer.toneMappingExposure).toBeCloseTo(0.62, 4);
    const p = sunParams(nightTick);
    expect(rig.scene.environmentIntensity).toBeCloseTo(p.envIntensity, 6);
    expect((rig.stars.material as THREE.PointsMaterial).opacity).toBeCloseTo(1, 4);
    expect(rig.stars.visible).toBe(true);
    expect(setBlobShadowStrength).toHaveBeenCalledWith(expect.closeTo(p.blobShadow, 4));
    // Water TSL dim uniform driven.
    expect(rig.waterDim).not.toBeNull();
    expect(rig.waterDim!.value).toBeCloseTo(p.waterDim, 6);
    disposeDayNightRig(rig);
  });

  it('applies noon params from the tick (sky + fog follow)', () => {
    const { rig, scene, renderer } = setup();
    applyDayNight(rig, DAY_NIGHT_TICKS / 4, 0, 0);
    expect(rig.sun.intensity).toBeCloseTo(2.0, 6);
    expect(renderer.toneMappingExposure).toBeCloseTo(1.0, 6);
    const bg = scene.background as THREE.Color;
    const noon = new THREE.Color(0x87a8c8);
    expect(bg.r).toBeCloseTo(noon.r, 4);
    const fog = scene.fog as THREE.Fog;
    expect(fog.color.r).toBeCloseTo(noon.r, 4);
    expect(rig.stars.visible).toBe(false); // 0 draw cost by day
    disposeDayNightRig(rig);
  });

  it('pause invariance: same tick twice applies identically (and dedups)', () => {
    const { rig, setBlobShadowStrength } = setup();
    applyDayNight(rig, 999, 10, 20);
    const sunI = rig.sun.intensity;
    const calls = setBlobShadowStrength.mock.calls.length;
    applyDayNight(rig, 999, 10, 20); // paused: tick + target static
    expect(rig.sun.intensity).toBe(sunI);
    expect(setBlobShadowStrength.mock.calls.length).toBe(calls); // no-op
    disposeDayNightRig(rig);
  });

  it('star dome follows the camera target', () => {
    const { rig } = setup();
    applyDayNight(rig, 0, 500, -300);
    expect(rig.stars.position.x).toBe(500);
    expect(rig.stars.position.z).toBe(-300);
    disposeDayNightRig(rig);
  });

  it('keepBackground preserves a baked sky (trailer pin)', () => {
    const { rig, scene } = setup();
    const bg = scene.background as THREE.Color;
    const beforeR = bg.r;
    applyDayNight(rig, GOLDEN_HOUR_TICK, 0, 0, { keepBackground: true });
    expect(bg.r).toBe(beforeR); // untouched
    // …but the lights still take the golden-hour grade.
    expect(rig.sun.intensity).toBeCloseTo(sunParams(GOLDEN_HOUR_TICK).sunIntensity, 6);
    disposeDayNightRig(rig);
  });

  it('save/load invariance: phase is a pure function of tick (zero new fields)', () => {
    // A "restored" rig on a fresh scene derives the identical sky from
    // the snapshotted tick alone — no persisted phase needed.
    const tick = 4321;
    const a = setup();
    applyDayNight(a.rig, tick, 0, 0);
    const snap = {
      sun: a.rig.sun.intensity,
      hemi: a.rig.hemi.intensity,
      exposure: a.renderer.toneMappingExposure,
      water: a.rig.waterDim!.value,
    };
    disposeDayNightRig(a.rig);
    const b = setup(); // fresh rig, same tick (as after a load)
    applyDayNight(b.rig, tick, 0, 0);
    expect(b.rig.sun.intensity).toBe(snap.sun);
    expect(b.rig.hemi.intensity).toBe(snap.hemi);
    expect(b.renderer.toneMappingExposure).toBe(snap.exposure);
    expect(b.rig.waterDim!.value).toBe(snap.water);
    disposeDayNightRig(b.rig);
  });
});

describe('night-window glass', () => {
  it('registry tracks glass; glow writes warm emissive, clears by day', () => {
    clearGlassRegistry();
    expect(glassRegistrySize()).toBe(0);
    const m1 = new THREE.MeshStandardMaterial({ color: 0x18242e });
    const m2 = new THREE.MeshStandardMaterial({ color: 0x141e28 });
    registerGlassMaterial(m1);
    registerGlassMaterial(m2);
    expect(glassRegistrySize()).toBe(2);

    setGlassNightGlow(1);
    for (const m of [m1, m2]) {
      expect(m.emissive.getHex()).toBe(0xffb45e);
      expect(m.emissiveIntensity).toBeCloseTo(0.85, 6);
    }
    setGlassNightGlow(0.5);
    expect(m1.emissiveIntensity).toBeCloseTo(0.425, 6);
    // Day: emissive restored to black (no glow leak).
    setGlassNightGlow(0);
    for (const m of [m1, m2]) {
      expect(m.emissive.getHex()).toBe(0x000000);
    }
    clearGlassRegistry();
    expect(glassRegistrySize()).toBe(0);
  });
});

describe('water TSL day/night dim', () => {
  it('the built water material carries the dayNightDim uniform (default 1)', () => {
    const view = buildTerrainView(prodTerrain());
    const mat = view.water.material as THREE.MeshStandardMaterial;
    const dim = (mat.userData as Record<string, unknown>)['dayNightDim'] as
      | { value: number }
      | undefined;
    expect(dim).toBeDefined();
    expect(dim!.value).toBe(1);
  });
});
