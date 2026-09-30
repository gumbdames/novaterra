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
 * render/xrayView.ts tests (Phase 4 RENDER workstream A, item 1):
 * the underground/x-ray view.
 *
 *  - ghostMaterialForXray / restoreMaterial: state save + apply +
 *    exact restoration (pure, no renderer needed).
 *  - XrayView: toggling ghosts terrain + water and drives the pipe
 *    callback; idempotent; safe with no materials bound; rebinding
 *    materials while visible restores the old pair and ghosts the new.
 *  - NetworkOverlay.setXray: flag + pipe treatment, surviving pipe
 *    rebuilds (treatment re-applied to the fresh material).
 *
 * Headless (node): no DOM, no WebGL — only material/flag state.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  XrayView,
  XRAY_TERRAIN_OPACITY,
  XRAY_WATER_OPACITY,
  ghostMaterialForXray,
  restoreMaterial,
} from '../src/render/xrayView';
import { NetworkOverlay } from '../src/render/networks';

describe('ghostMaterialForXray / restoreMaterial', () => {
  it('ghosts a material and restores it exactly', () => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x88aa66,
      transparent: false,
      opacity: 1,
      depthWrite: true,
    });
    const saved = ghostMaterialForXray(mat, 0.25);
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.25);
    expect(mat.depthWrite).toBe(false);
    restoreMaterial(mat, saved);
    expect(mat.transparent).toBe(false);
    expect(mat.opacity).toBeCloseTo(1);
    expect(mat.depthWrite).toBe(true);
  });

  it('restores non-default original state', () => {
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    const saved = ghostMaterialForXray(mat, 0.1);
    expect(mat.opacity).toBeCloseTo(0.1);
    restoreMaterial(mat, saved);
    expect(mat.transparent).toBe(true);
    expect(mat.opacity).toBeCloseTo(0.6);
    expect(mat.depthWrite).toBe(false);
  });
});

describe('XrayView', () => {
  function make() {
    const calls: boolean[] = [];
    const terrain = new THREE.MeshStandardMaterial({ color: 0x88aa66 });
    const water = new THREE.MeshStandardMaterial({
      color: 0x3366aa,
      transparent: true,
      opacity: 0.72,
    });
    const view = new XrayView((on) => calls.push(on));
    view.setTerrainMaterials(terrain, water);
    return { view, calls, terrain, water };
  }

  it('starts off and idles through redundant toggles', () => {
    const { view, calls } = make();
    expect(view.visible).toBe(false);
    view.setVisible(false);
    view.setVisible(false);
    expect(calls).toEqual([]); // no-op ⇒ no pipe callback
  });

  it('enabling ghosts terrain + water and lights the pipes', () => {
    const { view, calls, terrain, water } = make();
    view.setVisible(true);
    expect(view.visible).toBe(true);
    expect(terrain.transparent).toBe(true);
    expect(terrain.opacity).toBeCloseTo(XRAY_TERRAIN_OPACITY);
    expect(terrain.depthWrite).toBe(false);
    expect(water.opacity).toBeCloseTo(XRAY_WATER_OPACITY);
    expect(calls).toEqual([true]);
  });

  it('disabling restores terrain + water exactly', () => {
    const { view, calls, terrain, water } = make();
    view.setVisible(true);
    view.setVisible(false);
    expect(view.visible).toBe(false);
    expect(terrain.transparent).toBe(false);
    expect(terrain.opacity).toBeCloseTo(1);
    expect(terrain.depthWrite).toBe(true);
    expect(water.transparent).toBe(true); // water was transparent before
    expect(water.opacity).toBeCloseTo(0.72);
    expect(calls).toEqual([true, false]);
  });

  it('works with no materials bound (pipe callback still fires)', () => {
    const calls: boolean[] = [];
    const view = new XrayView((on) => calls.push(on));
    view.setVisible(true);
    expect(view.visible).toBe(true);
    expect(calls).toEqual([true]);
    view.setVisible(false);
    expect(calls).toEqual([true, false]);
  });

  it('rebinding materials while visible restores the old pair', () => {
    const { view, terrain, water } = make();
    view.setVisible(true);
    const terrain2 = new THREE.MeshStandardMaterial({ color: 0x999999 });
    const water2 = new THREE.MeshStandardMaterial({ color: 0x222222 });
    view.setTerrainMaterials(terrain2, water2);
    // Old materials restored to their pre-x-ray state…
    expect(terrain.transparent).toBe(false);
    expect(terrain.opacity).toBeCloseTo(1);
    expect(water.opacity).toBeCloseTo(0.72);
    // …and the new pair is ghosted, still visible.
    expect(view.visible).toBe(true);
    expect(terrain2.opacity).toBeCloseTo(XRAY_TERRAIN_OPACITY);
    expect(water2.opacity).toBeCloseTo(XRAY_WATER_OPACITY);
  });
});

describe('NetworkOverlay.setXray', () => {
  const heightFn = () => 0;

  it('flags the pipe treatment and survives pipe rebuilds', () => {
    const overlay = new NetworkOverlay(new THREE.Scene());
    expect(overlay.debugPipeXray()).toBe(false);
    overlay.sync([], [1, 2, 3], 4, heightFn); // pipes, no power lines
    overlay.setXray(true);
    expect(overlay.debugPipeXray()).toBe(true);
    // Rebuild with a different pipe set: the fresh material keeps the
    // treatment (emissive-bright, no depth test, drawn after terrain).
    overlay.sync([], [1, 2, 3, 4], 4, heightFn);
    expect(overlay.debugPipeXray()).toBe(true);
    overlay.setXray(false);
    expect(overlay.debugPipeXray()).toBe(false);
  });

  it('is a no-op with no pipes built', () => {
    const overlay = new NetworkOverlay(new THREE.Scene());
    overlay.setXray(true); // no pipe mesh — must not throw
    expect(overlay.debugPipeXray()).toBe(true);
    overlay.sync([], [7], 4, heightFn); // pipes appear later, treated
    overlay.setXray(false);
  });
});
