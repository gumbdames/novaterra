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
 * render/rails.ts tests (grand-expansion Phase 4 transport, S7; C8
 * wire-up): rail track geometry builders + the RailOverlay.
 *
 *  - railCellsToVisual: sim cell indices → world-space visuals.
 *  - railOverlayDigest: order-independent, class-sensitive rebuild key.
 *  - buildRailGeometry: deterministic across input order; orientation
 *    follows neighbors (x-run vs z-run); track classes render
 *    distinctly (wood vs concrete ties, high-speed slab).
 *  - buildRailCatenary: empty for non-electrified track; posts + wire
 *    for electric/high-speed.
 *  - RailOverlay: 0 draw calls with no rails, 1-2 with rails,
 *    digest-stable rebuilds, class upgrades rebuild, disposal.
 *
 * Headless (node): no DOM, no WebGL — geometry bytes + mesh state.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import { cellCenterWorld, cellIndex } from '../src/sim/city';
import {
  RailOverlay,
  RAIL_SLAB,
  RAIL_TIE_CONCRETE,
  RAIL_TIE_WOOD,
  buildRailCatenary,
  buildRailGeometry,
  railCellsToVisual,
  railColorLinear,
  railOverlayDigest,
  type RailCellVisual,
  type SimRailCell,
} from '../src/render/rails';

const CELL = 2; // sim world units per cell

/** Extract a color attribute as [r, g, b] triples. */
function colorsOf(geo: THREE.BufferGeometry): Array<[number, number, number]> {
  const attr = geo.getAttribute('color') as THREE.BufferAttribute;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < attr.count; i++) {
    out.push([attr.getX(i), attr.getY(i), attr.getZ(i)]);
  }
  return out;
}

/** Position attribute as [x, y, z] triples. */
function positionsOf(geo: THREE.BufferGeometry): Array<[number, number, number]> {
  const attr = geo.getAttribute('position') as THREE.BufferAttribute;
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < attr.count; i++) {
    out.push([attr.getX(i), attr.getY(i), attr.getZ(i)]);
  }
  return out;
}

function colorNear(
  triples: Array<[number, number, number]>,
  hex: number,
): boolean {
  const [r, g, b] = railColorLinear(hex);
  return triples.some(
    ([tr, tg, tb]) =>
      Math.abs(tr - r) < 1e-6 && Math.abs(tg - g) < 1e-6 && Math.abs(tb - b) < 1e-6,
  );
}

/** Axis span of vertices painted one color. */
function colorSpan(
  geo: THREE.BufferGeometry,
  hex: number,
  axis: 0 | 1 | 2,
): number {
  const [r, g, b] = railColorLinear(hex);
  const attr = geo.getAttribute('color') as THREE.BufferAttribute;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < attr.count; i++) {
    if (
      Math.abs(attr.getX(i) - r) < 1e-6 &&
      Math.abs(attr.getY(i) - g) < 1e-6 &&
      Math.abs(attr.getZ(i) - b) < 1e-6
    ) {
      const v = axis === 0 ? pos.getX(i) : axis === 1 ? pos.getY(i) : pos.getZ(i);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return hi - lo;
}

const RAIL_STEEL = 0x8f979e;

function railCell(cx: number, cz: number, cls: SimRailCell['cls'] = 'standard'): SimRailCell {
  return { cell: cellIndex(cx, cz), cls };
}

describe('railCellsToVisual', () => {
  it('maps sim cell indices to world-space centers', () => {
    const v = railCellsToVisual([railCell(10, 20, 'electric')]);
    expect(v).toHaveLength(1);
    expect(v[0]!.x).toBeCloseTo(cellCenterWorld(10), 9);
    expect(v[0]!.z).toBeCloseTo(cellCenterWorld(20), 9);
    expect(v[0]!.cls).toBe('electric');
  });
});

describe('railOverlayDigest', () => {
  it('is order-independent but class-sensitive', () => {
    const a = [railCell(1, 1), railCell(2, 1), railCell(3, 1, 'electric')];
    const b = [railCell(3, 1, 'electric'), railCell(1, 1), railCell(2, 1)];
    expect(railOverlayDigest(a)).toBe(railOverlayDigest(b));
    const upgraded = [railCell(1, 1, 'electric'), railCell(2, 1), railCell(3, 1, 'electric')];
    expect(railOverlayDigest(upgraded)).not.toBe(railOverlayDigest(a));
    expect(railOverlayDigest([])).toBe(railOverlayDigest([]));
  });
});

describe('buildRailGeometry', () => {
  const cells = (v: RailCellVisual[]) => v;

  it('is deterministic: same cells in any order → byte-identical geometry', () => {
    const visuals = railCellsToVisual([
      railCell(5, 5),
      railCell(6, 5, 'electric'),
      railCell(7, 5, 'high-speed'),
    ]);
    const g1 = buildRailGeometry(visuals, CELL);
    const g2 = buildRailGeometry([...visuals].reverse(), CELL);
    const p1 = g1.getAttribute('position') as THREE.BufferAttribute;
    const p2 = g2.getAttribute('position') as THREE.BufferAttribute;
    expect(p1.count).toBe(p2.count);
    for (let i = 0; i < p1.count; i++) {
      expect(p1.getX(i)).toBe(p2.getX(i));
      expect(p1.getY(i)).toBe(p2.getY(i));
      expect(p1.getZ(i)).toBe(p2.getZ(i));
    }
    g1.dispose();
    g2.dispose();
  });

  it('runs rails along x for x-neighbors, along z for z-neighbors', () => {
    // Steel rails are long along travel (≈ cell length) and narrow across.
    const xRun = buildRailGeometry(
      cells(railCellsToVisual([railCell(0, 0), railCell(1, 0)])),
      CELL,
    );
    expect(colorSpan(xRun, RAIL_STEEL, 0)).toBeGreaterThan(1.5);
    expect(colorSpan(xRun, RAIL_STEEL, 2)).toBeLessThan(1.0);
    const zRun = buildRailGeometry(
      cells(railCellsToVisual([railCell(0, 0), railCell(0, 1)])),
      CELL,
    );
    expect(colorSpan(zRun, RAIL_STEEL, 2)).toBeGreaterThan(1.5);
    expect(colorSpan(zRun, RAIL_STEEL, 0)).toBeLessThan(1.0);
    xRun.dispose();
    zRun.dispose();
  });

  it('uses wooden ties for standard, concrete for electric, a slab for high-speed', () => {
    const std = buildRailGeometry(cells(railCellsToVisual([railCell(0, 0, 'standard')])), CELL);
    const stdColors = colorsOf(std);
    expect(colorNear(stdColors, RAIL_TIE_WOOD)).toBe(true);
    expect(colorNear(stdColors, RAIL_TIE_CONCRETE)).toBe(false);
    expect(colorNear(stdColors, RAIL_SLAB)).toBe(false);
    const el = buildRailGeometry(cells(railCellsToVisual([railCell(0, 0, 'electric')])), CELL);
    expect(colorNear(colorsOf(el), RAIL_TIE_CONCRETE)).toBe(true);
    const hs = buildRailGeometry(cells(railCellsToVisual([railCell(0, 0, 'high-speed')])), CELL);
    const hsColors = colorsOf(hs);
    expect(colorNear(hsColors, RAIL_SLAB)).toBe(true);
    expect(colorNear(hsColors, RAIL_TIE_CONCRETE)).toBe(true);
    std.dispose();
    el.dispose();
    hs.dispose();
  });

  it('drapes on the terrain via heightFn, stays flat headless', () => {
    const flat = buildRailGeometry(cells(railCellsToVisual([railCell(0, 0)])), CELL);
    const flatPos = positionsOf(flat);
    expect(Math.min(...flatPos.map((p) => p[1]))).toBeGreaterThanOrEqual(-0.01);
    const draped = buildRailGeometry(
      cells(railCellsToVisual([railCell(0, 0)])),
      CELL,
      () => 5,
    );
    const drapedPos = positionsOf(draped);
    expect(Math.min(...drapedPos.map((p) => p[1]))).toBeGreaterThan(4.9);
    flat.dispose();
    draped.dispose();
  });
});

describe('buildRailCatenary', () => {
  it('is empty for non-electrified track, posts + wire for electric/high-speed', () => {
    const none = buildRailCatenary(
      railCellsToVisual([railCell(0, 0, 'standard'), railCell(1, 0, 'standard')]),
      CELL,
    );
    expect((none.getAttribute('position') as THREE.BufferAttribute).count).toBe(0);
    const el = buildRailCatenary(railCellsToVisual([railCell(0, 0, 'electric')]), CELL);
    expect((el.getAttribute('position') as THREE.BufferAttribute).count).toBeGreaterThan(0);
    const hs = buildRailCatenary(railCellsToVisual([railCell(0, 0, 'high-speed')]), CELL);
    expect((hs.getAttribute('position') as THREE.BufferAttribute).count).toBeGreaterThan(0);
    none.dispose();
    el.dispose();
    hs.dispose();
  });
});

describe('RailOverlay', () => {
  it('draws nothing with no rails; 1 draw call for track, 2 with catenary', () => {
    const scene = new THREE.Scene();
    const overlay = new RailOverlay(scene);
    overlay.sync([], CELL);
    expect(overlay.drawCallCount()).toBe(0);
    expect(overlay.debugRebuilds()).toBe(1);
    overlay.sync([railCell(0, 0, 'standard')], CELL);
    expect(overlay.drawCallCount()).toBe(1);
    overlay.sync([railCell(0, 0, 'electric')], CELL);
    expect(overlay.drawCallCount()).toBe(2);
    overlay.dispose();
  });

  it('rebuilds only on digest change; teardown clears all draw calls', () => {
    const scene = new THREE.Scene();
    const overlay = new RailOverlay(scene);
    const rails = [railCell(0, 0, 'standard'), railCell(1, 0, 'standard')];
    overlay.sync(rails, CELL);
    const rebuilds = overlay.debugRebuilds();
    overlay.sync(rails, CELL);
    overlay.sync([...rails].reverse(), CELL); // order-independent digest
    expect(overlay.debugRebuilds()).toBe(rebuilds);
    // A track-class upgrade changes the digest → rebuild, catenary appears.
    overlay.sync([railCell(0, 0, 'electric'), railCell(1, 0, 'standard')], CELL);
    expect(overlay.debugRebuilds()).toBe(rebuilds + 1);
    expect(overlay.drawCallCount()).toBe(2);
    // Rail removal hides everything again.
    overlay.sync([], CELL);
    expect(overlay.drawCallCount()).toBe(0);
    overlay.dispose();
  });
});
