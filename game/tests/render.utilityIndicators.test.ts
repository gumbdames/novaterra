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
 * render/utilityIndicators.ts tests (Phase 4 RENDER workstream A,
 * item 5): always-on per-building utility indicators.
 *
 *  - utilityIndicatorsFor: bolt ⟸ power diag not ok, drop ⟸ water
 *    diag not ok, sorted + stable (the same readers the selection
 *    panel uses).
 *  - utilityIndicatorPixels: both sprites rasterize with opaque fill
 *    pixels, differ from each other, and are byte-identical across
 *    calls (deterministic).
 *  - UtilityIndicators: lazy meshes (0 draw calls when fully
 *    supplied), counts per kind, digest-stable rebuilds, both icons on
 *    a doubly-troubled building, disposal.
 *
 * Headless (node): no DOM, no WebGL — only sprite bytes + mesh state.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import type { BuildingRecord } from '../src/sim/city';
import {
  UtilityIndicators,
  UTILITY_INDICATOR_KINDS,
  utilityIndicatorPixels,
  utilityIndicatorsDigest,
  utilityIndicatorsFor,
} from '../src/render/utilityIndicators';

/** A minimal building record the UI layer can reason about. */
function fakeBuilding(over: Partial<BuildingRecord> = {}): BuildingRecord {
  return {
    id: 1,
    kind: 'house',
    owner: 1,
    cx: 10,
    cz: 10,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
    ...over,
  } as BuildingRecord;
}

describe('utilityIndicatorsFor', () => {
  it('is empty for a fully supplied building', () => {
    expect(
      utilityIndicatorsFor([fakeBuilding({ powerDiag: 'ok', waterDiag: 'ok' } as never)]),
    ).toEqual([]);
  });

  it('emits a bolt for power trouble, a drop for water trouble', () => {
    const out = utilityIndicatorsFor([
      fakeBuilding({ id: 1, powerDiag: 'disconnected', waterDiag: 'ok' } as never),
      fakeBuilding({ id: 2, powerDiag: 'ok', waterDiag: 'shortage' } as never),
      fakeBuilding({ id: 3, powerDiag: 'shortage', waterDiag: 'disconnected' } as never),
    ]);
    expect(out.map((m) => m.kind)).toEqual([
      'noPower', // b1
      'noWater', // b2
      'noPower', // b3
      'noWater', // b3
    ]);
  });

  it('falls back to the powered/watered booleans without sim diags', () => {
    const out = utilityIndicatorsFor([fakeBuilding({ powered: false, watered: true })]);
    expect(out.map((m) => m.kind)).toEqual(['noPower']);
  });

  it('is sorted by (kind, id): stable across input order', () => {
    const a = fakeBuilding({ id: 5, powerDiag: 'disconnected' } as never);
    const b = fakeBuilding({ id: 2, waterDiag: 'disconnected' } as never);
    const fwd = utilityIndicatorsFor([a, b]);
    const rev = utilityIndicatorsFor([b, a]);
    expect(fwd).toEqual(rev);
    expect(utilityIndicatorsDigest(fwd)).toBe(utilityIndicatorsDigest(rev));
  });
});

describe('utilityIndicatorPixels', () => {
  for (const kind of UTILITY_INDICATOR_KINDS) {
    it(`${kind}: rasterizes an opaque filled shape`, () => {
      const px = utilityIndicatorPixels(kind);
      let opaque = 0;
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] === 255) opaque++;
      }
      // A real shape: hundreds of filled pixels, not a speck or a blob.
      expect(opaque).toBeGreaterThan(200);
      expect(opaque).toBeLessThan(64 * 64);
    });

    it(`${kind}: deterministic (byte-identical across calls)`, () => {
      expect([...utilityIndicatorPixels(kind)]).toEqual([
        ...utilityIndicatorPixels(kind),
      ]);
    });
  }

  it('the bolt and the drop are visibly different sprites', () => {
    const bolt = utilityIndicatorPixels('noPower');
    const drop = utilityIndicatorPixels('noWater');
    let diff = 0;
    for (let i = 0; i < bolt.length; i++) {
      if (bolt[i] !== drop[i]) diff++;
    }
    expect(diff).toBeGreaterThan(bolt.length * 0.05);
  });
});

describe('UtilityIndicators', () => {
  it('keeps zero meshes while the city is fully supplied', () => {
    const scene = new THREE.Scene();
    const ind = new UtilityIndicators(scene);
    const ok = [fakeBuilding({ powerDiag: 'ok', waterDiag: 'ok' } as never)];
    ind.sync(ok, {});
    ind.sync(ok, {});
    expect(ind.debugCounts()).toEqual({ noPower: 0, noWater: 0 });
    expect(ind.drawCallCount()).toBe(0);
    expect(ind.debugRebuilds()).toBe(1); // first sync builds the (empty) lists
    ind.dispose();
  });

  it('shows bolt/drop layers for troubled buildings, 0-2 draw calls', () => {
    const scene = new THREE.Scene();
    const ind = new UtilityIndicators(scene);
    const buildings = [
      fakeBuilding({ id: 1, powerDiag: 'disconnected', waterDiag: 'ok' } as never),
      fakeBuilding({ id: 2, powerDiag: 'ok', waterDiag: 'shortage' } as never),
    ];
    ind.sync(buildings, {});
    expect(ind.debugCounts()).toEqual({ noPower: 1, noWater: 1 });
    expect(ind.drawCallCount()).toBe(2);
    // Recovery hides the layers again.
    ind.sync(
      [fakeBuilding({ powerDiag: 'ok', waterDiag: 'ok' } as never)],
      {},
    );
    expect(ind.debugCounts()).toEqual({ noPower: 0, noWater: 0 });
    expect(ind.drawCallCount()).toBe(0);
    ind.dispose();
  });

  it('does not rebuild when nothing changed (digest-stable)', () => {
    const scene = new THREE.Scene();
    const ind = new UtilityIndicators(scene);
    const buildings = [
      fakeBuilding({ id: 1, powerDiag: 'disconnected', waterDiag: 'ok' } as never),
    ];
    ind.sync(buildings, {});
    const rebuilds = ind.debugRebuilds();
    ind.sync(buildings, {});
    ind.sync([...buildings].reverse(), {}); // order-independent digest
    expect(ind.debugRebuilds()).toBe(rebuilds);
    ind.dispose();
  });
});
