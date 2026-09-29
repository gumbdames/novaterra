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
 * Tests for render/roads.ts — the pure, deterministic road ribbon and
 * center-dash builders. Quad counts, dash rules (straight runs only),
 * input-order independence, and the boolean[][] input form.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  buildRoadGeometry,
  buildRoadMarkings,
  ROAD_ASPHALT_COLOR,
  ROAD_DASH_COLOR,
  ROAD_DASH_Y,
  ROAD_Y,
} from '../src/render/roads';

const CELL = 4;

/** Number of quads in a built geometry (indexed, 6 indices per quad). */
function quadCount(geo: THREE.BufferGeometry): number {
  const index = geo.getIndex();
  expect(index).not.toBeNull();
  return (index?.count ?? 0) / 6;
}

/** All vertex y values are (nearly) equal to the expected layer height. */
function expectFlat(geo: THREE.BufferGeometry, y: number): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    expect(pos.getY(i)).toBeCloseTo(y, 6);
  }
  const normal = geo.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < normal.count; i++) {
    expect(normal.getY(i)).toBeCloseTo(1, 6);
  }
}

describe('buildRoadGeometry', () => {
  it('emits one quad per road cell', () => {
    const cells = [
      { x: 0, z: 0 },
      { x: CELL, z: 0 },
      { x: 2 * CELL, z: 0 },
    ];
    const geo = buildRoadGeometry(cells, CELL);
    expect(quadCount(geo)).toBe(3);
    expectFlat(geo, ROAD_Y);
  });

  it('is empty for no roads', () => {
    const geo = buildRoadGeometry([], CELL);
    expect(quadCount(geo)).toBe(0);
  });

  it('is deterministic and independent of input order', () => {
    const a = [
      { x: 0, z: 0 },
      { x: CELL, z: 0 },
      { x: CELL, z: CELL },
    ];
    const b = [
      { x: CELL, z: CELL },
      { x: 0, z: 0 },
      { x: CELL, z: 0 },
    ];
    const ga = buildRoadGeometry(a, CELL);
    const gb = buildRoadGeometry(b, CELL);
    const pa = ga.getAttribute('position') as THREE.BufferAttribute;
    const pb = gb.getAttribute('position') as THREE.BufferAttribute;
    expect(pa.count).toBe(pb.count);
    for (let i = 0; i < pa.count; i++) {
      expect(pa.getX(i)).toBe(pb.getX(i));
      expect(pa.getY(i)).toBe(pb.getY(i));
      expect(pa.getZ(i)).toBe(pb.getZ(i));
    }
  });

  it('accepts a boolean[][] grid', () => {
    const grid = [
      [true, false],
      [true, true],
    ];
    const geo = buildRoadGeometry(grid, CELL);
    expect(quadCount(geo)).toBe(3);
  });

  it('dedupes repeated cells', () => {
    const cells = [
      { x: 0, z: 0 },
      { x: 0, z: 0 },
    ];
    expect(quadCount(buildRoadGeometry(cells, CELL))).toBe(1);
  });
});

describe('buildRoadMarkings', () => {
  it('emits no dash for an isolated cell', () => {
    expect(quadCount(buildRoadMarkings([{ x: 0, z: 0 }], CELL))).toBe(0);
  });

  it('dashes only the straight-through cell of a 3-run', () => {
    const cells = [
      { x: 0, z: 0 },
      { x: CELL, z: 0 },
      { x: 2 * CELL, z: 0 },
    ];
    const geo = buildRoadMarkings(cells, CELL);
    // Middle cell has exactly two opposite (E+W) neighbors; the ends
    // have one neighbor each → no dash.
    expect(quadCount(geo)).toBe(1);
    expectFlat(geo, ROAD_DASH_Y);
  });

  it('dashes N+S straight runs along z', () => {
    const cells = [
      { x: 0, z: 0 },
      { x: 0, z: CELL },
      { x: 0, z: 2 * CELL },
    ];
    expect(quadCount(buildRoadMarkings(cells, CELL))).toBe(1);
  });

  it('emits no dash at corners (two adjacent neighbors)', () => {
    const cells = [
      { x: 0, z: 0 },
      { x: CELL, z: 0 },
      { x: CELL, z: CELL },
    ];
    expect(quadCount(buildRoadMarkings(cells, CELL))).toBe(0);
  });

  it('emits no dash at junctions (3+ neighbors)', () => {
    // Plus shape: center has 4 neighbors, arms have 1 each.
    const cells = [
      { x: 0, z: 0 },
      { x: CELL, z: 0 },
      { x: -CELL, z: 0 },
      { x: 0, z: CELL },
      { x: 0, z: -CELL },
    ];
    expect(quadCount(buildRoadMarkings(cells, CELL))).toBe(0);
    expect(quadCount(buildRoadGeometry(cells, CELL))).toBe(5);
  });

  it('accepts a boolean[][] grid', () => {
    const grid = [[true, true, true]];
    expect(quadCount(buildRoadMarkings(grid, CELL))).toBe(1);
  });
});

describe('road layer constants', () => {
  it('dashes render above the asphalt ribbon', () => {
    expect(ROAD_DASH_Y).toBeGreaterThan(ROAD_Y);
  });

  it('uses distinct asphalt and dash colors', () => {
    expect(ROAD_ASPHALT_COLOR).not.toBe(ROAD_DASH_COLOR);
  });
});
