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
 * NOVATERRA — veterancy chevron overlay tests (render/chevrons.ts).
 *
 * Covers the Phase 1 readability cue: deterministic canvas-free texture
 * rasterization (same level ⇒ byte-identical pixels), the veteran
 * filter, the pure anchor math (terrain ground + hover + model top +
 * offset), and the headless-safe overlay class (3 draw calls max, hidden
 * when empty, billboarded to the camera, capacity growth).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { UnitRecord } from '../src/sim/units';
import {
  CHEVRON_TEX_PX,
  CHEVRON_CELL_H,
  CHEVRON_BASE_OFFSET,
  ChevronOverlay,
  chevronAnchor,
  chevronTexturePixels,
  chevronUnits,
} from '../src/render/chevrons';

function fakeUnit(over: Partial<UnitRecord> & { id: number }): UnitRecord {
  return {
    kind: 'rifles',
    owner: 1,
    x: 10,
    z: 20,
    domain: 'land',
    hp: 100,
    xp: 0,
    vetLevel: 0,
    ...over,
  } as UnitRecord;
}

function litPixelCount(px: Uint8ClampedArray): number {
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if ((px[i] ?? 0) > 0) n++;
  return n;
}

describe('chevronTexturePixels', () => {
  it('is deterministic: same level yields byte-identical pixels', () => {
    for (const level of [1, 2, 3] as const) {
      expect(chevronTexturePixels(level)).toEqual(chevronTexturePixels(level));
    }
  });

  it('sizes the texture as one 64px cell per chevron', () => {
    for (const level of [1, 2, 3] as const) {
      const px = chevronTexturePixels(level);
      expect(px.length).toBe(CHEVRON_TEX_PX * CHEVRON_TEX_PX * level * 4);
    }
  });

  it('draws more chevrons per level (lit pixels grow with level)', () => {
    const counts = [1, 2, 3].map(
      (l) => litPixelCount(chevronTexturePixels(l as 1 | 2 | 3)),
    );
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(counts[0]!);
    expect(counts[2]).toBeGreaterThan(counts[1]!);
  });

  it('is horizontally symmetric (chevrons point straight up)', () => {
    const px = chevronTexturePixels(2);
    const w = CHEVRON_TEX_PX;
    const h = CHEVRON_TEX_PX * 2;
    for (let y = 0; y < h; y += 7) {
      for (let x = 0; x < w / 2; x += 5) {
        const a = (y * w + x) * 4;
        const b = (y * w + (w - 1 - x)) * 4;
        expect(px[a + 3], `alpha at (${x},${y})`).toBe(px[b + 3]);
      }
    }
  });
});

describe('chevronUnits', () => {
  it('keeps living veterans, drops recruits and the dead', () => {
    const units = [
      fakeUnit({ id: 1, vetLevel: 0, xp: 50 }),
      fakeUnit({ id: 2, vetLevel: 1, xp: 200 }),
      fakeUnit({ id: 3, vetLevel: 2, xp: 600 }),
      fakeUnit({ id: 4, vetLevel: 3, xp: 1500 }),
      fakeUnit({ id: 5, vetLevel: 2, xp: 600, hp: 0 }),
    ];
    expect(chevronUnits(units).map((u) => u.id)).toEqual([2, 3, 4]);
  });
});

describe('chevronAnchor', () => {
  it('stacks ground + hover + model top + base offset + half strip (null terrain)', () => {
    // rifles: land hover 0.15; level 2 strip is 2 cells tall.
    const u = fakeUnit({ id: 1, vetLevel: 2, xp: 500 });
    const a = chevronAnchor(u, null, 0, 2.5);
    expect(a.x).toBe(10);
    expect(a.z).toBe(20);
    expect(a.y).toBeCloseTo(0 + 0.15 + 2.5 + CHEVRON_BASE_OFFSET + (CHEVRON_CELL_H * 2) / 2, 10);
  });

  it('bottom-anchors every level (strip bottom at the same height)', () => {
    const top = 2.5;
    const bottoms = [1, 2, 3].map((level) => {
      const a = chevronAnchor(fakeUnit({ id: level, vetLevel: level }), null, 0, top);
      return a.y - (CHEVRON_CELL_H * level) / 2;
    });
    expect(bottoms[0]).toBeCloseTo(bottoms[1]!, 10);
    expect(bottoms[1]).toBeCloseTo(bottoms[2]!, 10);
    expect(bottoms[0]).toBeCloseTo(0.15 + top + CHEVRON_BASE_OFFSET, 10);
  });
});

describe('ChevronOverlay', () => {
  it('adds no draw calls when no veteran is alive', () => {
    const scene = new THREE.Scene();
    const overlay = new ChevronOverlay(scene);
    const units = [fakeUnit({ id: 1 }), fakeUnit({ id: 2, vetLevel: 1, hp: 0 })];
    overlay.sync(units, null, 0, () => 2.5, null);
    expect(overlay.drawCallCount()).toBe(0);
    expect(overlay.levelCounts()).toEqual([0, 0, 0]);
    overlay.dispose();
  });

  it('uses one draw call per non-empty level (3 max)', () => {
    const scene = new THREE.Scene();
    const overlay = new ChevronOverlay(scene);
    const units = [
      fakeUnit({ id: 1, vetLevel: 1, xp: 200 }),
      fakeUnit({ id: 2, vetLevel: 1, xp: 250 }),
      fakeUnit({ id: 3, vetLevel: 3, xp: 1200 }),
    ];
    overlay.sync(units, null, 0, () => 2.5, null);
    expect(overlay.drawCallCount()).toBe(2);
    expect(overlay.levelCounts()).toEqual([2, 0, 1]);
    overlay.dispose();
  });

  it('places instances at the pure anchor position', () => {
    const scene = new THREE.Scene();
    const overlay = new ChevronOverlay(scene);
    const u = fakeUnit({ id: 7, vetLevel: 2, xp: 600, x: 33, z: -12 });
    overlay.sync([u], null, 0, () => 3, null);
    const m = overlay.debugMatrix(2, 0);
    const pos = new THREE.Vector3().setFromMatrixPosition(m);
    const expected = chevronAnchor(u, null, 0, 3);
    expect(pos.x).toBeCloseTo(expected.x, 6);
    expect(pos.y).toBeCloseTo(expected.y, 6);
    expect(pos.z).toBeCloseTo(expected.z, 6);
    overlay.dispose();
  });

  it('billboards instances to the camera quaternion', () => {
    const scene = new THREE.Scene();
    const overlay = new ChevronOverlay(scene);
    const camera = new THREE.PerspectiveCamera();
    camera.quaternion.setFromEuler(new THREE.Euler(0.3, 1.1, 0));
    const u = fakeUnit({ id: 7, vetLevel: 1, xp: 200 });
    overlay.sync([u], null, 0, () => 3, camera);
    const m = overlay.debugMatrix(1, 0);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    expect(q.angleTo(camera.quaternion)).toBeCloseTo(0, 6);
    overlay.dispose();
  });

  it('grows capacity past the initial 64 per level', () => {
    const scene = new THREE.Scene();
    const overlay = new ChevronOverlay(scene);
    const units = Array.from({ length: 70 }, (_, i) =>
      fakeUnit({ id: 100 + i, vetLevel: 1, xp: 200 }),
    );
    overlay.sync(units, null, 0, () => 2.5, null);
    expect(overlay.levelCounts()[0]).toBe(70);
    expect(overlay.drawCallCount()).toBe(1);
    overlay.dispose();
  });
});
