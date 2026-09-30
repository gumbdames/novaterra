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
 * render/utilityOverlay.ts tests (grand-expansion Phase 2).
 *
 * The toggleable diagnostic overlay: rasterized marker sprites (4 kinds),
 * merged coverage-tint decals, digest-keyed rebuilds, visibility control.
 *
 * Headless (node): DataTexture pixel math + BufferGeometry only — no
 * WebGL, no DOM.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import type { UtilityOverlayData } from '../src/ui/utilities';
import {
  buildTintDecalGeometry,
  UTILITY_MARKER_KINDS,
  UTILITY_MARKER_TEX_PX,
  UtilityOverlay,
  utilityMarkerPixels,
  utilityOverlayDigest,
} from '../src/render/utilityOverlay';

const CELL = 8;

function emptyData(): UtilityOverlayData {
  return {
    powerLineCells: [],
    pipeCells: [],
    markers: [],
    servedPowerCells: [],
    servedWaterCells: [],
    fouledCells: [],
  };
}

describe('utilityMarkerPixels', () => {
  it('rasterizes a non-blank, deterministic 64×64 sprite per kind', () => {
    const px = UTILITY_MARKER_TEX_PX;
    for (const kind of UTILITY_MARKER_KINDS) {
      const a = utilityMarkerPixels(kind);
      expect(a.length).toBe(px * px * 4);
      const b = utilityMarkerPixels(kind);
      expect(a).toEqual(b); // deterministic
      let lit = 0;
      for (let i = 3; i < a.length; i += 4) if (a[i]! > 0) lit++;
      expect(lit, `${kind}: blank sprite`).toBeGreaterThan(50);
      expect(lit, `${kind}: full-bleed sprite`).toBeLessThan(px * px);
    }
  });

  it('renders four visually distinct sprites', () => {
    const sigs = UTILITY_MARKER_KINDS.map((k) => {
      const p = utilityMarkerPixels(k);
      let sum = 0;
      for (let i = 0; i < p.length; i += 4) sum += p[i]! + p[i + 1]! * 2 + p[i + 2]! * 3;
      return sum;
    });
    expect(new Set(sigs).size).toBe(4);
  });
});

describe('buildTintDecalGeometry', () => {
  it('builds one quad per cell, draped on the height function', () => {
    const geo = buildTintDecalGeometry([0, 1, 65], 0.12, () => 7);
    expect((geo.getIndex()?.count ?? 0) / 6).toBe(3);
    const ys = Array.from(
      { length: geo.getAttribute('position').count },
      (_, i) => geo.getAttribute('position').getY(i),
    );
    for (const y of ys) expect(y).toBeCloseTo(7.12, 6);
  });

  it('dedupes and ignores invalid cells', () => {
    const geo = buildTintDecalGeometry([5, 5, -1, 2.5, 6], 0.1);
    expect((geo.getIndex()?.count ?? 0) / 6).toBe(2); // 5 and 6
  });

  it('builds empty geometry for an empty set', () => {
    const geo = buildTintDecalGeometry([], 0.1);
    expect(geo.getIndex()?.count ?? 0).toBe(0);
  });
});

describe('utilityOverlayDigest', () => {
  it('is stable for identical data and changes with any field', () => {
    const base = emptyData();
    const d0 = utilityOverlayDigest(base);
    expect(utilityOverlayDigest(emptyData())).toBe(d0);
    const variants: UtilityOverlayData[] = [
      { ...base, servedPowerCells: [1] },
      { ...base, servedWaterCells: [1] },
      { ...base, fouledCells: [1] },
      {
        ...base,
        markers: [{ x: 8, z: 8, kind: 'shortage', buildingKind: 'house' }],
      },
    ];
    // NOTE: powerLineCells/pipeCells are deliberately NOT in the digest —
    // this overlay never renders them (NetworkOverlay does).
    for (const v of variants) {
      expect(utilityOverlayDigest(v), 'digest blind to a field').not.toBe(d0);
    }
  });
});

describe('UtilityOverlay', () => {
  const opts = { cellSize: CELL };

  it('starts hidden and toggles visibility', () => {
    const scene = new THREE.Scene();
    const overlay = new UtilityOverlay(scene);
    const group = scene.children[0]!;
    expect(group.visible).toBe(false);
    overlay.setVisible(true);
    expect(group.visible).toBe(true);
    overlay.setVisible(false);
    expect(group.visible).toBe(false);
    overlay.dispose();
  });

  it('rebuilds exactly once per digest change', () => {
    const scene = new THREE.Scene();
    const overlay = new UtilityOverlay(scene);
    overlay.setVisible(true);
    overlay.sync(emptyData(), opts);
    const first = overlay.getRebuilds();
    overlay.sync(emptyData(), opts); // same digest: no rebuild
    expect(overlay.getRebuilds()).toBe(first);
    const data = emptyData();
    data.markers.push({ x: 8, z: 8, kind: 'disconnected', buildingKind: 'house' });
    overlay.sync(data, opts);
    // One rebuild = one tint pass + one marker pass.
    expect(overlay.getRebuilds()).toBe(first + 2);
    overlay.dispose();
  });

  it('adds a tint mesh per non-empty cell set and marker instances', () => {
    const scene = new THREE.Scene();
    const overlay = new UtilityOverlay(scene);
    overlay.setVisible(true);
    const data = emptyData();
    data.servedPowerCells = [0, 1];
    data.servedWaterCells = [2];
    data.fouledCells = [3];
    data.markers.push(
      { x: 8, z: 8, kind: 'disconnected', buildingKind: 'house' },
      { x: 16, z: 8, kind: 'stranded', buildingKind: 'coalPlant' },
    );
    overlay.sync(data, opts);
    const group = scene.children[0]!;
    // 3 tint meshes + one marker instanced mesh per kind that has markers
    // (marker meshes are created lazily — kinds with no markers add none).
    expect(group.children.length).toBe(5);
    overlay.dispose();
  });

  it('dispose removes everything it added from the scene', () => {
    const scene = new THREE.Scene();
    const overlay = new UtilityOverlay(scene);
    overlay.setVisible(true);
    overlay.sync(emptyData(), opts);
    expect(scene.children.length).toBeGreaterThan(0);
    overlay.dispose();
    expect(scene.children.length).toBe(0);
  });
});
