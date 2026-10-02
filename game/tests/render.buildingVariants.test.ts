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
 * NOVATERRA — building variant / size-tier tests (0.1 Alpha, Phase 4 item 4).
 *
 * `render/buildingVariants.ts` gives every building silhouette variety
 * (variants 0..3) and readable size (tiers 1..3) through the existing
 * lazy-model pipeline — no new download at boot. These tests pin:
 *  - the boot gate: no variant key ever appears in `bootModelKeys()`
 *    (the ~8 MiB boot-download budget is pinned by a test elsewhere).
 *  - `sizeTierScale`: 0.88/1.0/1.14 with a safe fallback for bad input
 *    (never 0/NaN — a broken scale collapses the mesh).
 *  - `variantExtraFor`: one distinct cached prop per variant 1..3,
 *    none for variant 0; pool keys are variant-owned, never boot keys.
 *
 * Note (roadmap B19, 2026-10-02): the `_v1.._v3` GLB variant-key
 * scaffolding (`variantModelKey` / `isVariantModelKey`) was dead — never
 * called by game code — and was deleted. Variant identity now comes from
 * the rooftop props + size tiers (+ the B19 hull tint), not suffixed
 * model keys.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILDING_VARIANT_COUNT,
  sizeTierScale,
  variantExtraFor,
  variantExtraPoolKey,
  variantExtraTop,
} from '../src/render/buildingVariants';
import { bootModelKeys } from '../src/render/lazyModels';
import { BUILDING_DEFS } from '../src/sim/city';
describe('boot gate: variant keys never enter the boot set', () => {
  it('no variant key for any building def appears in bootModelKeys()', () => {
    const boot = new Set(bootModelKeys());
    const kinds = Object.keys(BUILDING_DEFS);
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      for (let v = 1; v < BUILDING_VARIANT_COUNT; v++) {
        // The old `_vN` suffixed-key shape (deleted in B19): the shape
        // must still never appear in the boot set.
        expect(boot.has(`${kind}_v${v}`)).toBe(false);
        expect(boot.has(variantExtraPoolKey(v))).toBe(false);
      }
    }
  });
});

describe('sizeTierScale', () => {
  it('tiers 1/2/3 map to 0.88/1.0/1.14', () => {
    expect(sizeTierScale(1)).toBeCloseTo(0.88, 9);
    expect(sizeTierScale(2)).toBe(1);
    expect(sizeTierScale(3)).toBeCloseTo(1.14, 9);
  });

  it('out-of-range input falls back to tier 2 (never 0, never NaN)', () => {
    for (const bad of [0, -1, 4, 99, NaN]) {
      const s = sizeTierScale(bad);
      expect(s).toBe(1);
      expect(Number.isFinite(s)).toBe(true);
    }
  });
});

describe('variantExtraFor (procedural rooftop props)', () => {
  it('variant 0 has no prop; variants 1..3 each have a distinct cached prop', () => {
    expect(variantExtraFor(0)).toBeUndefined();
    const props = [1, 2, 3].map((v) => variantExtraFor(v));
    for (const p of props) expect(p).toBeDefined();
    expect(new Set(props).size).toBe(3);
    // Cached: the same object comes back on repeat calls.
    expect(variantExtraFor(1)).toBe(props[0]);
    expect(variantExtraFor(2)).toBe(props[1]);
    expect(variantExtraFor(3)).toBe(props[2]);
  });

  it('out-of-range variants have no prop', () => {
    expect(variantExtraFor(-1)).toBeUndefined();
    expect(variantExtraFor(4)).toBeUndefined();
  });

  it('variantExtraTop is positive for propped variants, 0 for the base', () => {
    expect(variantExtraTop(0)).toBe(0);
    for (const v of [1, 2, 3]) {
      expect(variantExtraTop(v)).toBeGreaterThan(0);
    }
  });

  it('pool keys are variant-owned (never boot-model keys)', () => {
    expect(variantExtraPoolKey(1)).toBe('variantExtra:v1');
    expect(variantExtraPoolKey(2)).toBe('variantExtra:v2');
    expect(variantExtraPoolKey(3)).toBe('variantExtra:v3');
    // The old `_vN` suffixed-key shape (deleted in B19): extra pool keys
    // never looked like it.
    expect(/_v[1-9]\d*$/.test(variantExtraPoolKey(1))).toBe(false);
  });
});
