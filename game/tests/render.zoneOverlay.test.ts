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
 * NOVATERRA — zone overlay tests (Workstream Z, `render/zoneOverlay.ts`).
 *
 * Covers the zone digest (changes when zones are painted/repainted,
 * stable when unchanged, order-independent), the pure decal-geometry
 * builder (one quad per cell, per-zone colors, per-corner terrain drape,
 * flat headless fallback), and the overlay class (rebuilds only when the
 * digest changes; zero draw calls when no zones are painted).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  CELL_WORLD_SIZE,
  ZoneType,
  cellCenterWorld,
  cellIndex,
} from '../src/sim/city';
import {
  ZONE_DECAL_COLORS,
  ZONE_DECAL_OPACITY,
  ZONE_DECAL_TERRAIN_OFFSET,
  ZONE_Y,
  buildZoneDecalGeometry,
  ZoneOverlay,
  zoneDigest,
  type ZoneAssignment,
} from '../src/render/zoneOverlay';

function paint(cells: Array<[number, number, ZoneType]>): ZoneAssignment[] {
  return cells.map(([cx, cz, zone]) => ({ cell: cellIndex(cx, cz), zone }));
}

describe('zoneDigest', () => {
  it('is stable when nothing changes', () => {
    const a = paint([
      [1, 1, ZoneType.RESIDENTIAL],
      [2, 3, ZoneType.COMMERCIAL],
    ]);
    const b = paint([
      [1, 1, ZoneType.RESIDENTIAL],
      [2, 3, ZoneType.COMMERCIAL],
    ]);
    expect(zoneDigest(a)).toBe(zoneDigest(b));
  });

  it('changes when a new cell is painted', () => {
    const before = paint([[1, 1, ZoneType.RESIDENTIAL]]);
    const after = paint([
      [1, 1, ZoneType.RESIDENTIAL],
      [2, 2, ZoneType.INDUSTRIAL],
    ]);
    expect(zoneDigest(before)).not.toBe(zoneDigest(after));
  });

  it('changes when a cell is repainted to a different zone', () => {
    const before = paint([[1, 1, ZoneType.RESIDENTIAL]]);
    const after = paint([[1, 1, ZoneType.COMMERCIAL]]);
    expect(zoneDigest(before)).not.toBe(zoneDigest(after));
  });

  it('is stable when a cell is repainted to the same zone', () => {
    const before = paint([[1, 1, ZoneType.RESIDENTIAL]]);
    const after = paint([[1, 1, ZoneType.RESIDENTIAL]]);
    expect(zoneDigest(before)).toBe(zoneDigest(after));
  });

  it('does not depend on assignment order', () => {
    const a = paint([
      [1, 1, ZoneType.RESIDENTIAL],
      [5, 5, ZoneType.INDUSTRIAL],
    ]);
    const b = paint([
      [5, 5, ZoneType.INDUSTRIAL],
      [1, 1, ZoneType.RESIDENTIAL],
    ]);
    expect(zoneDigest(a)).toBe(zoneDigest(b));
  });
});

describe('zone decal colors', () => {
  it('uses the classic green/blue/orange per zone type', () => {
    expect(ZONE_DECAL_COLORS[ZoneType.RESIDENTIAL]).toBe(0x43a047);
    expect(ZONE_DECAL_COLORS[ZoneType.COMMERCIAL]).toBe(0x1e88e5);
    expect(ZONE_DECAL_COLORS[ZoneType.INDUSTRIAL]).toBe(0xfb8c00);
  });

  it('is translucent (0.28) so the terrain shows through', () => {
    expect(ZONE_DECAL_OPACITY).toBe(0.28);
  });
});

describe('buildZoneDecalGeometry', () => {
  it('emits one up-facing quad per cell with per-zone vertex colors', () => {
    const geo = buildZoneDecalGeometry(
      paint([
        [0, 0, ZoneType.RESIDENTIAL],
        [3, 1, ZoneType.COMMERCIAL],
      ]),
      undefined,
    );
    const pos = geo.getAttribute('position');
    const col = geo.getAttribute('color');
    expect(pos.count).toBe(8);
    expect(col.count).toBe(8);
    expect(geo.index!.count).toBe(12);

    // First quad = cell (0,0): the cell rect exactly, in world units
    // (the sim grid is centered at the origin: cellCenterWorld).
    const cxw = cellCenterWorld(0);
    const half = CELL_WORLD_SIZE / 2;
    expect(pos.getX(0)).toBe(cxw - half);
    expect(pos.getZ(0)).toBe(cxw - half);
    expect(pos.getX(1)).toBe(cxw + half);
    expect(pos.getZ(3)).toBe(cxw + half);

    // Quad corners share the zone color (sRGB hex → working space).
    const green = new THREE.Color(0x43a047);
    for (let i = 0; i < 4; i++) {
      expect(col.getX(i)).toBeCloseTo(green.r, 6);
      expect(col.getY(i)).toBeCloseTo(green.g, 6);
      expect(col.getZ(i)).toBeCloseTo(green.b, 6);
    }
    const blue = new THREE.Color(0x1e88e5);
    for (let i = 4; i < 8; i++) {
      expect(col.getX(i)).toBeCloseTo(blue.r, 6);
      expect(col.getY(i)).toBeCloseTo(blue.g, 6);
      expect(col.getZ(i)).toBeCloseTo(blue.b, 6);
    }
  });

  it('drapes each corner on the terrain via heightAt', () => {
    const geo = buildZoneDecalGeometry(
      paint([[0, 0, ZoneType.RESIDENTIAL]]),
      (x, z) => x + z,
    );
    const pos = geo.getAttribute('position');
    // Corners are (cxw-1,czw-1),(cxw+1,czw-1),(cxw-1,czw+1),(cxw+1,czw+1)
    // with cxw = czw = cellCenterWorld(0) = -255: y = x + z + offset.
    const o = ZONE_DECAL_TERRAIN_OFFSET;
    const ys = [pos.getY(0), pos.getY(1), pos.getY(2), pos.getY(3)];
    const expected = [-512 + o, -510 + o, -510 + o, -508 + o];
    for (let i = 0; i < 4; i++) expect(ys[i]).toBeCloseTo(expected[i]!, 4);
  });

  it('stays flat at ZONE_Y without a height sampler (headless path)', () => {
    const geo = buildZoneDecalGeometry(
      paint([[0, 0, ZoneType.INDUSTRIAL]]),
      undefined,
    );
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeCloseTo(ZONE_Y, 6);
  });

  it('emits cells in sorted order regardless of input order', () => {
    const a = buildZoneDecalGeometry(
      paint([
        [5, 5, ZoneType.RESIDENTIAL],
        [0, 0, ZoneType.RESIDENTIAL],
      ]),
      undefined,
    );
    const b = buildZoneDecalGeometry(
      paint([
        [0, 0, ZoneType.RESIDENTIAL],
        [5, 5, ZoneType.RESIDENTIAL],
      ]),
      undefined,
    );
    const pa = a.getAttribute('position').array as Float32Array;
    const pb = b.getAttribute('position').array as Float32Array;
    expect(Array.from(pa)).toEqual(Array.from(pb));
  });

  it('emits nothing for an empty assignment list', () => {
    const geo = buildZoneDecalGeometry([], undefined);
    expect(geo.getAttribute('position').count).toBe(0);
    expect(geo.index!.count).toBe(0);
  });
});

describe('ZoneOverlay', () => {
  it('rebuilds only when the zone digest changes', () => {
    const scene = new THREE.Scene();
    const overlay = new ZoneOverlay(scene);

    overlay.sync([], undefined);
    expect(overlay.drawCallCount()).toBe(0);
    const emptyDigest = overlay.debugDigest();
    overlay.sync([], undefined);
    expect(overlay.debugRebuildCount()).toBe(1); // first sync only

    const painted = paint([
      [0, 0, ZoneType.RESIDENTIAL],
      [1, 0, ZoneType.COMMERCIAL],
    ]);
    overlay.sync(painted, undefined);
    expect(overlay.debugRebuildCount()).toBe(2);
    expect(overlay.drawCallCount()).toBe(1);
    overlay.sync(painted, undefined);
    expect(overlay.debugRebuildCount()).toBe(2); // digest stable: no rebuild

    // Repainting one cell to a different zone changes the digest.
    const repainted = paint([
      [0, 0, ZoneType.INDUSTRIAL],
      [1, 0, ZoneType.COMMERCIAL],
    ]);
    overlay.sync(repainted, undefined);
    expect(overlay.debugRebuildCount()).toBe(3);
    expect(overlay.debugDigest()).not.toBe(emptyDigest);

    overlay.dispose();
    expect(scene.children).toHaveLength(0);
    expect(overlay.drawCallCount()).toBe(0);
  });

  it('treats a missing zones list as nothing painted (minimal worlds)', () => {
    const scene = new THREE.Scene();
    const overlay = new ZoneOverlay(scene);
    expect(() => overlay.sync(undefined, undefined)).not.toThrow();
    expect(overlay.drawCallCount()).toBe(0);
    overlay.dispose();
  });
});
