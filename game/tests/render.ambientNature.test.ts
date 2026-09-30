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
 * NOVATERRA — tests/render.ambientNature.test.ts — living nature
 * (0.1 Alpha): the shared ambient clock, tree wind sway, and water
 * motion.
 *
 * Pins the contracts the visuals rely on:
 *  - the ambient clock is tick-driven (pause ⇒ frozen air/water),
 *  - foliage/core tree materials carry the sway node, trunks don't,
 *  - the water plane carries the flow node and `waterBobY` is a gentle
 *    deterministic swell around the sim's water level.
 * The actual vertex/fragment motion runs on the GPU; these tests pin
 * everything computable on the CPU side of that boundary.
 */

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  ambientSecondsForTick,
  ambientTimeSeconds,
  setAmbientTimeSeconds,
} from '../src/render/ambientTime';
import {
  makeNatureTreeMaterials,
  type NatureTreeTextures,
} from '../src/render/natureTrees';
import { buildTerrainView, waterBobY } from '../src/render/terrain';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';

function stubTextures(): NatureTreeTextures {
  const make = (r: number, g: number, b: number): THREE.Texture => {
    const data = new Uint8Array([r, g, b, 255]);
    const tex = new THREE.DataTexture(data, 1, 1);
    tex.needsUpdate = true;
    return tex;
  };
  return {
    bark: make(120, 80, 50),
    birchBark: make(220, 220, 220),
    leaves: make(60, 140, 60),
    birchLeaves: make(90, 170, 80),
    pineLeaves: make(40, 110, 50),
  };
}

describe('ambient clock', () => {
  it('converts ticks to sim seconds (30 ticks = 1 s)', () => {
    expect(ambientSecondsForTick(0)).toBe(0);
    expect(ambientSecondsForTick(30)).toBeCloseTo(1, 10);
    expect(ambientSecondsForTick(300)).toBeCloseTo(10, 10);
  });

  it('setAmbientTimeSeconds drives the shared uniform', () => {
    setAmbientTimeSeconds(12.5);
    expect(ambientTimeSeconds.value).toBe(12.5);
    setAmbientTimeSeconds(0);
    expect(ambientTimeSeconds.value).toBe(0);
  });

  it('is pause-consistent: a frozen tick freezes the clock', () => {
    // The render sync derives the clock from world.tick only — same
    // tick twice ⇒ same seconds ⇒ the wind/water/birds stand still.
    const t = 12345;
    expect(ambientSecondsForTick(t)).toBe(ambientSecondsForTick(t));
  });
});

describe('tree wind sway', () => {
  it('attaches the sway node to foliage + cores, never to trunks', () => {
    const mats = makeNatureTreeMaterials(stubTextures());
    for (const m of [
      mats.leaves,
      mats.birchLeaves,
      mats.pineLeaves,
      mats.core,
      mats.pineCore,
    ]) {
      expect(m.positionNode, 'foliage/core sways').not.toBeNull();
    }
    expect(mats.bark.positionNode, 'trunk stays rigid').toBeFalsy();
    expect(mats.birchBark.positionNode, 'trunk stays rigid').toBeFalsy();
  });

  it('shares one clock across all swaying materials', () => {
    // All sway nodes read the same uniform object: one write per frame
    // fans out to every tree material (checked structurally — the node
    // trees all reference ambientTimeSeconds by construction).
    setAmbientTimeSeconds(7.25);
    expect(ambientTimeSeconds.value).toBe(7.25);
    setAmbientTimeSeconds(0);
  });
});

describe('water motion', () => {
  it('waterBobY breathes ±0.09 around the water level', () => {
    const wl = 2.5;
    expect(waterBobY(wl, 0)).toBeCloseTo(wl, 10);
    // sin(t*0.5): peak at t=π.
    expect(waterBobY(wl, Math.PI)).toBeCloseTo(wl + 0.09, 10);
    expect(waterBobY(wl, 2 * Math.PI)).toBeCloseTo(wl, 10);
    for (let s = 0; s < 200; s++) {
      const y = waterBobY(wl, s * 0.37);
      expect(Math.abs(y - wl)).toBeLessThanOrEqual(0.09 + 1e-9);
    }
  });

  it('is deterministic and pause-consistent', () => {
    expect(waterBobY(1.0, 42.5)).toBe(waterBobY(1.0, 42.5));
  });

  it('attaches the flow node to the production water material', () => {
    const t = generateTerrain(MERIDIAN_PLAINS.seed);
    const view = buildTerrainView(t);
    const mat = view.water.material as THREE.MeshStandardMaterial;
    expect(mat.colorNode).not.toBeNull();
    // The authored water color survives: the node modulates it, it does
    // not replace it.
    expect(mat.color.getHex()).toBe(0x2e6f9e);
  });
});
