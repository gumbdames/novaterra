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
 * NOVATERRA — screen-shake math tests (ui/camera.ts, roadmap B13).
 * The shake is render-only (no sim impact); these tests pin the trauma
 * accumulation/clamp/decay and the offset's trauma² scaling.
 */
import { describe, expect, it } from 'vitest';

import {
  addShakeTrauma,
  decayShakeTrauma,
  shakeOffset,
  SHAKE_FULL_OFFSET,
} from '../src/ui/camera';

describe('addShakeTrauma', () => {
  it('accumulates and clamps at 1', () => {
    expect(addShakeTrauma(0, 0.3)).toBeCloseTo(0.3, 9);
    expect(addShakeTrauma(0.8, 0.5)).toBe(1);
    expect(addShakeTrauma(1, 0.5)).toBe(1);
  });

  it('floors at zero', () => {
    expect(addShakeTrauma(0.1, -0.5)).toBe(0);
  });
});

describe('decayShakeTrauma', () => {
  it('decays linearly and stops at zero', () => {
    expect(decayShakeTrauma(1, 0.5)).toBeCloseTo(1 - 1.6 * 0.5, 9);
    expect(decayShakeTrauma(0.1, 10)).toBe(0);
  });
});

describe('shakeOffset', () => {
  it('is exactly zero below the epsilon', () => {
    expect(shakeOffset(0.01, 123.456)).toEqual({ dx: 0, dy: 0 });
  });

  it('scales with trauma²', () => {
    const t = 77.7;
    const half = shakeOffset(0.5, t);
    const full = shakeOffset(1, t);
    const mag = (o: { dx: number; dy: number }) =>
      Math.sqrt(o.dx * o.dx + o.dy * o.dy);
    // Same noise direction at the same instant; magnitude ratio is 4:1.
    expect(mag(full) / mag(half)).toBeCloseTo(4, 6);
  });

  it('never exceeds the full-trauma offset', () => {
    for (const t of [0, 1.3, 42.42, 999.9]) {
      const o = shakeOffset(1, t);
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(SHAKE_FULL_OFFSET);
      expect(Math.abs(o.dy)).toBeLessThanOrEqual(SHAKE_FULL_OFFSET);
    }
  });

  it('is deterministic for the same inputs', () => {
    expect(shakeOffset(0.7, 5.5)).toEqual(shakeOffset(0.7, 5.5));
  });
});
