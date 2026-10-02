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
 * NOVATERRA — construction-dressing tests (render/constructionDressing.ts,
 * roadmap B17). Pins the pure layer: the membership key (scaffold mesh
 * rebuilds only on membership change), the footprint-scaled scaffold
 * height, and the scaffold frame geometry.
 */
import { describe, expect, it } from 'vitest';

import {
  constructionKey,
  scaffoldHeight,
  scaffoldSegments,
} from '../src/render/constructionDressing';
import type { BuildingRecord } from '../src/sim/city';

function building(id: number, progress: number): BuildingRecord {
  return {
    id,
    kind: 'farm',
    owner: 0,
    cx: 10,
    cz: 10,
    facing: 0,
    progress,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  } as BuildingRecord;
}

describe('constructionKey', () => {
  it('includes only buildings with progress < 1, sorted', () => {
    const key = constructionKey([
      building(5, 1),
      building(3, 0.2),
      building(9, 0),
      building(1, 0.99),
    ]);
    expect(key).toBe('1,3,9');
  });

  it('is empty when nothing is under construction', () => {
    expect(constructionKey([building(1, 1)])).toBe('');
    expect(constructionKey([])).toBe('');
  });

  it('is order-independent', () => {
    const a = constructionKey([building(2, 0.5), building(1, 0.1)]);
    const b = constructionKey([building(1, 0.1), building(2, 0.5)]);
    expect(a).toBe(b);
  });
});

describe('scaffoldHeight', () => {
  it('grows with the footprint', () => {
    const small = scaffoldHeight(2, 2);
    const big = scaffoldHeight(6, 4);
    expect(big).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(0);
  });
});

describe('scaffoldSegments', () => {
  it('emits 4 poles + 12 frame bars (16 segments)', () => {
    const positions: number[] = [];
    scaffoldSegments(0, 0, 6, 4, 12, positions);
    // 16 segments × 2 endpoints × 3 coords.
    expect(positions.length).toBe(16 * 2 * 3);
  });

  it('raises poles from the ground to the frame height at the corners', () => {
    const positions: number[] = [];
    scaffoldSegments(10, 20, 6, 4, 12, positions);
    // First segment = first corner pole: (10,0,20) → (10,12,20).
    expect(positions.slice(0, 6)).toEqual([10, 0, 20, 10, 12, 20]);
  });

  it('frames the top at full height', () => {
    const positions: number[] = [];
    scaffoldSegments(0, 0, 6, 4, 12, positions);
    // Last level (y=12) bars: check the first top bar's endpoints.
    // Segments 0-3 are poles; 4-7 are y=4; 8-11 are y=8; 12-15 are y=12.
    const topBar = positions.slice(12 * 6, 12 * 6 + 6);
    expect(topBar[1]).toBe(12);
    expect(topBar[4]).toBe(12);
    expect(topBar[0]).toBe(0);
    expect(topBar[3]).toBe(6);
  });
});
