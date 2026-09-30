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
 * NOVATERRA — UI desirability contract tests (workstream W,
 * `ui/desirability.ts`).
 *
 * Covers the selection-panel land-value line (format, tier names, the
 * residential-only gate, null-model safety) and the read-only per-frame
 * overlay view (defensive on missing inputs, sorted cells, key passthrough).
 * The sim side is pinned in tests/sim.desirability.test.ts; these tests
 * pin the UI/render contract on top of it.
 */
import { describe, expect, it } from 'vitest';

import {
  desirabilityOverlayData,
  landValueLine,
  landValueTaxMultOf,
  type DesirabilityModel,
} from '../src/ui/desirability';
import { landValueTier, getDesirabilityModel } from '../src/sim/desirability';
import { STRINGS } from '../src/ui/strings';
import {
  BUILDING_DEFS,
  cellIndex,
  cellIsWater,
  CITY_GRID_CELLS,
  ZoneType,
  type BuildingRecord,
  type CityState,
} from '../src/sim/city';
import { createWorld } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS } from '../src/sim/terrain';

/** Minimal world setup (the overlay view needs a real world + terrain). */
function setup(seed = 20260928) {
  const terrain = generateTerrain(MERIDIAN_PLAINS.seed);
  const world = createWorld(seed);
  return { terrain, world };
}

function findLandRect(t: import('../src/sim/terrain').TerrainData, w: number, h: number) {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error(`no ${w}x${h} land rect`);
}

function paintResidential(city: CityState, x0: number, z0: number, x1: number, z1: number): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.RESIDENTIAL });
    }
  }
  city.zones.sort((a, b) => a.cell - b.cell);
}

/** A hand-built derived model: exact scores, no terrain involved. */
function fakeModel(scores: Map<number, number>): DesirabilityModel {
  return { key: 'test-key', values: scores };
}

/** Minimal building record — only the fields the contract reads. */
function fakeBuilding(kind: keyof typeof BUILDING_DEFS, cx: number, cz: number): BuildingRecord {
  return { kind, owner: 0, cx, cz, facing: 0 } as BuildingRecord;
}

describe('landValueLine', () => {
  it('formats the tier, score, and tax multiplier ("Land: Nice (64) · tax ×1.3")', () => {
    // 2×2 house footprint at (10..11, 20..21), all cells scoring 64.
    const cells = new Map<number, number>();
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = 0; dx < 2; dx++) cells.set(cellIndex(10 + dx, 20 + dz), 64);
    }
    const line = landValueLine(fakeModel(cells), fakeBuilding('house', 10, 20));
    expect(line).toBe('Land: Nice (64) · tax ×1.3');
  });

  it('names every tier through STRINGS (English-only, per the locale rule)', () => {
    const expected: Record<string, string> = {
      low: 'Land: Low (10) · tax ×0.8',
      modest: 'Land: Modest (40) · tax ×1',
      nice: 'Land: Nice (64) · tax ×1.3',
      prime: 'Land: Prime (90) · tax ×1.7',
    };
    for (const [tier, score] of [['low', 10], ['modest', 40], ['nice', 64], ['prime', 90]] as const) {
      const cells = new Map<number, number>([[cellIndex(0, 0), score]]);
      const line = landValueLine(fakeModel(cells), fakeBuilding('house', 0, 0));
      expect(line).toBe(expected[tier]);
      // And the tier name really comes from STRINGS.desirability.tierNames.
      expect(line).toContain(STRINGS.desirability.tierNames[landValueTier(score).name].en);
    }
  });

  it('rounds a fractional footprint mean the way the panel shows it', () => {
    // Mean 63.5 → shown as 64, tiered as 64 (nice).
    const cells = new Map<number, number>([
      [cellIndex(0, 0), 63],
      [cellIndex(1, 0), 64],
      [cellIndex(0, 1), 64],
      [cellIndex(1, 1), 63],
    ]);
    expect(landValueLine(fakeModel(cells), fakeBuilding('house', 0, 0))).toBe(
      'Land: Nice (64) · tax ×1.3',
    );
  });

  it('returns null for non-residential buildings (land value is residential-only)', () => {
    const cells = new Map<number, number>([[cellIndex(0, 0), 90]]);
    const model = fakeModel(cells);
    expect(landValueLine(model, fakeBuilding('shop', 0, 0))).toBeNull();
    expect(landValueLine(model, fakeBuilding('factory', 0, 0))).toBeNull();
    expect(landValueLine(model, fakeBuilding('park', 0, 0))).toBeNull();
  });

  it('returns null when the model is missing (empty pre-sim)', () => {
    const house = fakeBuilding('house', 0, 0);
    expect(landValueLine(null, house)).toBeNull();
    expect(landValueLine(undefined, house)).toBeNull();
  });
});

describe('landValueTaxMultOf', () => {
  it('returns 1 when the model is missing', () => {
    const house = fakeBuilding('house', 0, 0);
    expect(landValueTaxMultOf(null, house)).toBe(1);
    expect(landValueTaxMultOf(undefined, house)).toBe(1);
  });

  it('follows the footprint tier (drives the palette digest)', () => {
    const cells = new Map<number, number>([
      [cellIndex(0, 0), 90],
      [cellIndex(1, 0), 90],
      [cellIndex(0, 1), 90],
      [cellIndex(1, 1), 90],
    ]);
    expect(landValueTaxMultOf(fakeModel(cells), fakeBuilding('house', 0, 0))).toBe(1.7);
  });
});

describe('desirabilityOverlayData', () => {
  it('is defensive: missing terrain/world yields an empty view', () => {
    expect(desirabilityOverlayData(null, null, 0)).toEqual({ key: '', cells: [] });
    expect(desirabilityOverlayData(undefined, undefined, 0)).toEqual({ key: '', cells: [] });
  });

  it('exposes every residential cell, sorted, with the model key', () => {
    const ctx = setup(41);
    const { cx, cz } = findLandRect(ctx.terrain, 10, 6);
    // Paint two disjoint blocks (deliberately unsorted insertion order
    // is impossible via paint — so shuffle the check instead).
    paintResidential(ctx.world.city, cx, cz, cx + 3, cz + 2);
    paintResidential(ctx.world.city, cx + 5, cz, cx + 8, cz + 2);
    const model = getDesirabilityModel(ctx.terrain, ctx.world, 0);
    const data = desirabilityOverlayData(ctx.terrain, ctx.world, 0);
    expect(data.key).toBe(model.key);
    expect(data.cells).toHaveLength(model.values.size);
    expect(data.cells.length).toBeGreaterThan(0);
    // Sorted by cell, values match the model exactly.
    const sorted = [...data.cells].sort((a, b) => a.cell - b.cell);
    expect(data.cells).toEqual(sorted);
    for (const c of data.cells) {
      expect(c.value).toBe(model.values.get(c.cell));
      expect(Number.isInteger(c.value)).toBe(true);
    }
  });

  it('is empty when no residential zones are painted', () => {
    const ctx = setup(42);
    const data = desirabilityOverlayData(ctx.terrain, ctx.world, 0);
    expect(data.cells).toEqual([]);
  });
});
