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
 * render/networks.ts tests (grand-expansion Phase 2).
 *
 * Pure geometry builders for the always-on utility runs:
 *  - power lines: a pole + cross-arm per cell, sagging wire ribbons to
 *    the east/south neighbors (matches the sim's road-join rule);
 *  - water pipes: a pad + link per cell, terrain-draped.
 *
 * Headless (node): no DOM, no WebGL — only BufferGeometry math.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  buildPipeGeometry,
  buildPowerLineGeometry,
  networkDigest,
  NetworkOverlay,
} from '../src/render/networks';

const CELL = 8;

function quadCount(geo: THREE.BufferGeometry): number {
  return (geo.getIndex()?.count ?? 0) / 6;
}

describe('buildPowerLineGeometry', () => {
  it('builds one pole + cross-arm per cell', () => {
    const { poles, wires } = buildPowerLineGeometry([0, 1, 65], CELL);
    // Poles: 3 cells × (1 pole shaft box + 1 cross-arm) = plenty of quads.
    expect(quadCount(poles)).toBeGreaterThanOrEqual(3);
    expect(wires).toBeDefined();
  });

  it('links 8-connected neighbors with wires, growing with connectivity', () => {
    // A 2×2 block has more neighbor links than two diagonal cells.
    const block = buildPowerLineGeometry([0, 1, 64, 65], CELL);
    const diagonal = buildPowerLineGeometry([0, 65], CELL);
    expect(quadCount(block.wires)).toBeGreaterThan(quadCount(diagonal.wires));
  });

  it('is deterministic for the same input', () => {
    const a = buildPowerLineGeometry([3, 9, 70], CELL);
    const b = buildPowerLineGeometry([3, 9, 70], CELL);
    expect(a.poles.getAttribute('position').array).toEqual(
      b.poles.getAttribute('position').array,
    );
  });

  it('draps poles on the terrain height function', () => {
    const heightFn = (x: number, _z: number): number => x;
    const { poles } = buildPowerLineGeometry([0, 1], CELL, heightFn);
    const ys = Array.from(
      { length: poles.getAttribute('position').count },
      (_, i) => poles.getAttribute('position').getY(i),
    );
    // Second pole sits 8 world units higher (cell (1,0) at x=8).
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5);
  });

  it('builds empty geometry for an empty cell set', () => {
    const { poles, wires } = buildPowerLineGeometry([], CELL);
    expect(quadCount(poles)).toBe(0);
    expect(quadCount(wires)).toBe(0);
  });
});

describe('buildPipeGeometry', () => {
  it('builds a pad per cell plus neighbor links', () => {
    const mesh = buildPipeGeometry([0, 1, 2], CELL);
    expect(quadCount(mesh)).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic and terrain-draped', () => {
    const a = buildPipeGeometry([5], CELL, () => 3);
    const b = buildPipeGeometry([5], CELL);
    const ya = a.getAttribute('position').getY(0);
    const yb = b.getAttribute('position').getY(0);
    expect(ya - yb).toBeCloseTo(3, 6);
  });

  it('builds empty geometry for an empty cell set', () => {
    expect(quadCount(buildPipeGeometry([], CELL))).toBe(0);
  });
});

describe('networkDigest', () => {
  it('is order-independent (cells are sorted first)', () => {
    expect(networkDigest([3, 1, 2])).toBe(networkDigest([1, 2, 3]));
  });

  it('changes when the set changes', () => {
    const base = networkDigest([1, 2]);
    expect(networkDigest([1, 3])).not.toBe(base);
    expect(networkDigest([1])).not.toBe(base);
  });
});

describe('NetworkOverlay', () => {
  it('rebuilds exactly once per digest change', () => {
    const scene = new THREE.Scene();
    const overlay = new NetworkOverlay(scene);
    overlay.sync([0, 1], [10], CELL);
    const first = overlay.getRebuilds();
    expect(first).toBe(2); // one power rebuild + one pipe rebuild
    overlay.sync([1, 0], [10], CELL); // same digests: no rebuild
    expect(overlay.getRebuilds()).toBe(first);
    overlay.sync([0, 1, 2], [10], CELL); // power changed only
    expect(overlay.getRebuilds()).toBe(first + 1);
    overlay.dispose();
  });

  it('adds meshes to the scene only for non-empty sets', () => {
    const scene = new THREE.Scene();
    const overlay = new NetworkOverlay(scene);
    const meshCount = (): number => {
      let n = 0;
      scene.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) n++;
      });
      return n;
    };
    overlay.sync([], [], CELL);
    expect(meshCount()).toBe(0);
    overlay.sync([0], [10], CELL);
    expect(meshCount()).toBe(3); // pole + wire + pipe meshes
    overlay.sync([], [], CELL);
    expect(meshCount()).toBe(0);
    overlay.dispose();
  });

  it('dispose removes everything it added from the scene', () => {
    const scene = new THREE.Scene();
    const overlay = new NetworkOverlay(scene);
    overlay.sync([0, 1], [10], CELL);
    expect(scene.children.length).toBeGreaterThan(0);
    overlay.dispose();
    expect(scene.children.length).toBe(0);
  });
});
