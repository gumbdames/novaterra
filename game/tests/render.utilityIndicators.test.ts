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
 * A real PerspectiveCamera (non-trivial quaternion, off-center
 * buildings) covers the billboard path: per-instance quaternions must
 * match the camera while the meshes stay unrotated and indicators
 * stay glued to their buildings (C5 regression).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import type { BuildingRecord } from '../src/sim/city';
import { cellCenterWorld } from '../src/sim/city';
import {
  UtilityIndicators,
  UTILITY_INDICATOR_KINDS,
  UTILITY_INDICATOR_LIFT,
  UTILITY_INDICATOR_SIZE,
  UTILITY_INDICATOR_SPREAD,
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

/**
 * Final-review R3 L7: the single-entry memo must never serve a stale
 * list. Each case below mutates one input the fingerprint covers and
 * requires the result to follow it.
 */
describe('utilityIndicatorsFor memo', () => {
  it('returns identical content on repeat calls (memo hit)', () => {
    const buildings = [
      fakeBuilding({ id: 1, powerDiag: 'disconnected' } as never),
      fakeBuilding({ id: 2, waterDiag: 'shortage' } as never),
    ];
    const first = utilityIndicatorsFor(buildings);
    expect(utilityIndicatorsFor(buildings)).toEqual(first);
    expect(utilityIndicatorsFor(buildings)).toEqual(first);
  });

  it('follows a diagnosis change on the same array (no staleness)', () => {
    const b = fakeBuilding({ id: 7, powerDiag: 'ok', waterDiag: 'ok' } as never);
    const buildings = [b];
    expect(utilityIndicatorsFor(buildings)).toEqual([]);
    (b as unknown as { powerDiag: string }).powerDiag = 'shortage';
    expect(utilityIndicatorsFor(buildings).map((m) => m.kind)).toEqual(['noPower']);
  });

  it('follows a removed building on the same array', () => {
    const buildings = [fakeBuilding({ id: 8, powerDiag: 'disconnected' } as never)];
    expect(utilityIndicatorsFor(buildings)).toHaveLength(1);
    buildings.pop();
    expect(utilityIndicatorsFor(buildings)).toEqual([]);
  });

  it('recomputes for a replaced buildings array', () => {
    const a = [fakeBuilding({ id: 9, waterDiag: 'disconnected' } as never)];
    expect(utilityIndicatorsFor(a).map((m) => m.kind)).toEqual(['noWater']);
    const b = [fakeBuilding({ id: 9, waterDiag: 'ok' } as never)];
    expect(utilityIndicatorsFor(b)).toEqual([]);
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

  it('billboards per instance with a camera: indicators stay glued to their buildings', () => {
    const scene = new THREE.Scene();
    const ind = new UtilityIndicators(scene);
    // Far from the map origin — the old mesh-level quaternion bug
    // rotated every instance around the world origin, so these two
    // floated far from their buildings.
    const buildings = [
      fakeBuilding({ id: 1, cx: 200, cz: 60, powerDiag: 'disconnected', waterDiag: 'ok' } as never),
      fakeBuilding({ id: 2, cx: 40, cz: 210, powerDiag: 'ok', waterDiag: 'shortage' } as never),
    ];
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(120, 90, 60);
    camera.lookAt(60, 0, -40); // non-trivial quaternion
    camera.updateMatrixWorld();
    ind.sync(buildings, { camera });
    scene.updateMatrixWorld(true);

    // The meshes themselves must never carry a rotation: instance
    // matrices are world-space (the C5 regression).
    const group = scene.getObjectByName('utility-indicators')!;
    const identity = new THREE.Quaternion();
    for (const child of group.children) {
      if (!(child instanceof THREE.InstancedMesh) || !child.visible) continue;
      expect(child.quaternion.angleTo(identity)).toBeCloseTo(0, 6);
    }

    // Each indicator stays at its building anchor: the bolt (noPower)
    // left of the shared anchor, the drop (noWater) right of it.
    const anchorY = 0 + 4 + UTILITY_INDICATOR_LIFT + UTILITY_INDICATOR_SIZE / 2;
    const pos = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const bolt = ind.debugMatrices('noPower');
    expect(bolt).toHaveLength(1);
    bolt[0]!.decompose(pos, q, scl);
    expect(pos.x).toBeCloseTo(cellCenterWorld(200) - UTILITY_INDICATOR_SPREAD / 2, 3);
    expect(pos.y).toBeCloseTo(anchorY, 3);
    expect(pos.z).toBeCloseTo(cellCenterWorld(60), 3);
    const drop = ind.debugMatrices('noWater');
    expect(drop).toHaveLength(1);
    drop[0]!.decompose(pos, q, scl);
    expect(pos.x).toBeCloseTo(cellCenterWorld(40) + UTILITY_INDICATOR_SPREAD / 2, 3);
    expect(pos.y).toBeCloseTo(anchorY, 3);
    expect(pos.z).toBeCloseTo(cellCenterWorld(210), 3);

    // Per-instance rotation is the camera quaternion — the sprites
    // face the camera without moving off their buildings. (Precision
    // 3: the matrix round-trips through float32 instance memory.)
    expect(q.angleTo(camera.quaternion)).toBeCloseTo(0, 3);

    // Stable across syncs with the same camera (precision 3: the
    // matrix round-trips through float32 instance memory).
    ind.sync(buildings, { camera });
    ind.debugMatrices('noPower')[0]!.decompose(pos, q, scl);
    expect(pos.x).toBeCloseTo(cellCenterWorld(200) - UTILITY_INDICATOR_SPREAD / 2, 3);
    ind.dispose();
  });
});
