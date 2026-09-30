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
 * NOVATERRA — desirability overlay render tests (workstream W,
 * `render/desirabilityOverlay.ts`).
 *
 * Covers the gradient (pure: same value ⇒ byte-identical color, pinned
 * anchors red→amber→green, clamping), the pure decal-geometry builder
 * (one quad per cell, up-facing normals, per-cell vertex colors,
 * terrain drape, flat headless fallback, sorted-order determinism), the
 * overlay digest, and the overlay class (hidden by default, rebuilds
 * only when the model key changes, 0/1 draw calls).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { cellCenterWorld, cellIndex, CELL_WORLD_SIZE } from '../src/sim/city';
import {
  DESIRABILITY_OVERLAY_OPACITY,
  buildDesirabilityDecalGeometry,
  desirabilityColor,
  desirabilityOverlayDigest,
  DesirabilityOverlay,
} from '../src/render/desirabilityOverlay';
import type { DesirabilityOverlayData } from '../src/ui/desirability';
import { ZONE_DECAL_TERRAIN_OFFSET } from '../src/render/zoneOverlay';

/** Minimal overlay data: key + (cell, value) pairs. */
function data(key: string, cells: Array<[number, number, number]>): DesirabilityOverlayData {
  return {
    key,
    cells: cells.map(([cx, cz, value]) => ({ cell: cellIndex(cx, cz), value })),
  };
}

describe('desirabilityColor', () => {
  it('is pure: the same value gives a byte-identical color', () => {
    for (const v of [0, 1, 25, 50, 72, 99, 100]) {
      const a = desirabilityColor(v);
      const b = desirabilityColor(v);
      expect(a.r).toBe(b.r);
      expect(a.g).toBe(b.g);
      expect(a.b).toBe(b.b);
    }
  });

  it('pins the gradient anchors: red (0) → amber (50) → green (100)', () => {
    const red = desirabilityColor(0);
    expect(red.r).toBeCloseTo(0xd4 / 255, 6);
    expect(red.g).toBeCloseTo(0x3d / 255, 6);
    expect(red.b).toBeCloseTo(0x2a / 255, 6);
    const amber = desirabilityColor(50);
    expect(amber.r).toBeCloseTo(0xd8 / 255, 6);
    expect(amber.g).toBeCloseTo(0xa9 / 255, 6);
    expect(amber.b).toBeCloseTo(0x3c / 255, 6);
    const green = desirabilityColor(100);
    expect(green.r).toBeCloseTo(0x3f / 255, 6);
    expect(green.g).toBeCloseTo(0xae / 255, 6);
    expect(green.b).toBeCloseTo(0x5a / 255, 6);
  });

  it('interpolates linearly between the anchors', () => {
    // 25 = halfway red→amber; 75 = halfway amber→green.
    const q1 = desirabilityColor(25);
    const red = desirabilityColor(0);
    const amber = desirabilityColor(50);
    expect(q1.r).toBeCloseTo((red.r + amber.r) / 2, 9);
    expect(q1.g).toBeCloseTo((red.g + amber.g) / 2, 9);
    expect(q1.b).toBeCloseTo((red.b + amber.b) / 2, 9);
    const q3 = desirabilityColor(75);
    const green = desirabilityColor(100);
    expect(q3.r).toBeCloseTo((amber.r + green.r) / 2, 9);
    expect(q3.g).toBeCloseTo((amber.g + green.g) / 2, 9);
    expect(q3.b).toBeCloseTo((amber.b + green.b) / 2, 9);
  });

  it('clamps out-of-range values to the anchors', () => {
    const lo = desirabilityColor(-10);
    const zero = desirabilityColor(0);
    expect([lo.r, lo.g, lo.b]).toEqual([zero.r, zero.g, zero.b]);
    const hi = desirabilityColor(150);
    const hundred = desirabilityColor(100);
    expect([hi.r, hi.g, hi.b]).toEqual([hundred.r, hundred.g, hundred.b]);
  });

  it('reuses the caller-provided color object', () => {
    const out = new THREE.Color();
    expect(desirabilityColor(40, out)).toBe(out);
  });
});

describe('buildDesirabilityDecalGeometry', () => {
  it('emits one up-facing quad per cell with per-cell vertex colors', () => {
    const geo = buildDesirabilityDecalGeometry(
      data('k', [
        [0, 0, 0],
        [3, 1, 100],
      ]),
      undefined,
    );
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const col = geo.getAttribute('color');
    expect(pos.count).toBe(8);
    expect(nrm.count).toBe(8);
    expect(col.count).toBe(8);
    expect(geo.index!.count).toBe(12);

    // First quad = cell (0,0): the cell rect exactly, in world units.
    const cw = cellCenterWorld(0);
    const half = CELL_WORLD_SIZE / 2;
    expect(pos.getX(0)).toBe(cw - half);
    expect(pos.getZ(0)).toBe(cw - half);
    expect(pos.getX(1)).toBe(cw + half);
    expect(pos.getZ(3)).toBe(cw + half);

    // Up-facing normals.
    for (let i = 0; i < 8; i++) {
      expect(nrm.getX(i)).toBe(0);
      expect(nrm.getY(i)).toBe(1);
      expect(nrm.getZ(i)).toBe(0);
    }

    // Quad corners share the value's gradient color.
    const red = desirabilityColor(0);
    for (let i = 0; i < 4; i++) {
      expect(col.getX(i)).toBeCloseTo(red.r, 6);
      expect(col.getY(i)).toBeCloseTo(red.g, 6);
      expect(col.getZ(i)).toBeCloseTo(red.b, 6);
    }
    const green = desirabilityColor(100);
    for (let i = 4; i < 8; i++) {
      expect(col.getX(i)).toBeCloseTo(green.r, 6);
      expect(col.getY(i)).toBeCloseTo(green.g, 6);
      expect(col.getZ(i)).toBeCloseTo(green.b, 6);
    }
  });

  it('drapes each corner on the terrain via heightAt', () => {
    const geo = buildDesirabilityDecalGeometry(data('k', [[0, 0, 50]]), (x, z) => x + z);
    const pos = geo.getAttribute('position');
    const o = ZONE_DECAL_TERRAIN_OFFSET;
    const cw = cellCenterWorld(0);
    const half = CELL_WORLD_SIZE / 2;
    // Corners: (cw-half, cw-half), (cw+half, cw-half), (cw-half, cw+half),
    // (cw+half, cw+half) — y = x + z + offset.
    const corners = [
      [cw - half, cw - half],
      [cw + half, cw - half],
      [cw - half, cw + half],
      [cw + half, cw + half],
    ] as const;
    for (let i = 0; i < 4; i++) {
      expect(pos.getY(i)).toBeCloseTo(corners[i]![0] + corners[i]![1] + o, 4);
    }
  });

  it('stays flat without a height sampler (headless path)', () => {
    const geo = buildDesirabilityDecalGeometry(data('k', [[2, 3, 50]]), undefined);
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeCloseTo(0.05, 6);
  });

  it('emits cells in sorted order regardless of input order (deterministic geometry)', () => {
    const a = buildDesirabilityDecalGeometry(
      data('k', [
        [5, 5, 80],
        [0, 0, 20],
      ]),
      undefined,
    );
    const b = buildDesirabilityDecalGeometry(
      data('k', [
        [0, 0, 20],
        [5, 5, 80],
      ]),
      undefined,
    );
    const pa = a.getAttribute('position').array as Float32Array;
    const pb = b.getAttribute('position').array as Float32Array;
    expect(Array.from(pa)).toEqual(Array.from(pb));
    const ca = a.getAttribute('color').array as Float32Array;
    const cb = b.getAttribute('color').array as Float32Array;
    expect(Array.from(ca)).toEqual(Array.from(cb));
  });

  it('emits nothing for an empty cell list', () => {
    const geo = buildDesirabilityDecalGeometry(data('k', []), undefined);
    expect(geo.getAttribute('position').count).toBe(0);
    expect(geo.index!.count).toBe(0);
  });
});

describe('desirabilityOverlayDigest', () => {
  it('is stable for identical data and changes when a value changes', () => {
    const a = data('k', [
      [0, 0, 40],
      [1, 0, 60],
    ]);
    const b = data('k', [
      [0, 0, 40],
      [1, 0, 60],
    ]);
    expect(desirabilityOverlayDigest(a)).toBe(desirabilityOverlayDigest(b));
    const c = data('k', [
      [0, 0, 40],
      [1, 0, 61],
    ]);
    expect(desirabilityOverlayDigest(a)).not.toBe(desirabilityOverlayDigest(c));
  });
});

describe('DesirabilityOverlay', () => {
  it('is hidden by default: sync does nothing until shown', () => {
    const scene = new THREE.Scene();
    const overlay = new DesirabilityOverlay(scene);
    overlay.sync(data('k1', [[0, 0, 40]]));
    expect(overlay.rebuildCount()).toBe(0);
    expect(overlay.drawCallCount()).toBe(0);
    overlay.dispose();
  });

  it('rebuilds only when the model key changes (node-stable)', () => {
    const scene = new THREE.Scene();
    const overlay = new DesirabilityOverlay(scene);
    overlay.setVisible(true);

    overlay.sync(data('k1', [[0, 0, 40]]));
    expect(overlay.rebuildCount()).toBe(1);
    expect(overlay.drawCallCount()).toBe(1);

    // Same key, per-frame sync: no rebuild (the common path is a single
    // string compare — never per-frame geometry work).
    overlay.sync(data('k1', [[0, 0, 40]]));
    overlay.sync(data('k1', [[0, 0, 40]]));
    expect(overlay.rebuildCount()).toBe(1);
    expect(overlay.drawCallCount()).toBe(1);

    // Structural change → new key → exactly one rebuild.
    overlay.sync(data('k2', [[0, 0, 40]]));
    expect(overlay.rebuildCount()).toBe(2);
    expect(overlay.drawCallCount()).toBe(1);

    // Empty data still rebuilds (old mesh is dropped) but draws nothing.
    overlay.sync(data('k3', []));
    expect(overlay.rebuildCount()).toBe(3);
    expect(overlay.drawCallCount()).toBe(0);

    overlay.dispose();
    expect(overlay.drawCallCount()).toBe(0);
  });

  it('is translucent (0.28) so the terrain shows through', () => {
    expect(DESIRABILITY_OVERLAY_OPACITY).toBe(0.28);
  });

  it('sync while hidden skips the rebuild (re-show forces one)', () => {
    const scene = new THREE.Scene();
    const overlay = new DesirabilityOverlay(scene);
    overlay.setVisible(true);
    overlay.sync(data('k1', [[0, 0, 40]]));
    expect(overlay.rebuildCount()).toBe(1);
    overlay.setVisible(false);
    overlay.sync(data('k2', [[0, 0, 90]]));
    expect(overlay.rebuildCount()).toBe(1); // hidden: skipped
    overlay.setVisible(true); // forces a rebuild on the next sync
    overlay.sync(data('k2', [[0, 0, 90]]));
    expect(overlay.rebuildCount()).toBe(2);
    overlay.dispose();
  });
});
