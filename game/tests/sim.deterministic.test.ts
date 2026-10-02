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

import { describe, expect, it } from 'vitest';
import { dist, dist2, detSin, detCos, detLog10 } from '../src/sim/deterministic';

describe('deterministic math (cross-engine determinism hardening)', () => {
  it('dist/dist2 are exact on small integers', () => {
    expect(dist(3, 4)).toBe(5);
    expect(dist2(3, 4)).toBe(25);
    expect(dist(0, 0)).toBe(0);
    expect(dist2(-3, -4)).toBe(25);
  });

  it('dist matches Math.hypot to < 2e-12 on game-scale values', () => {
    for (let i = 0; i < 5000; i++) {
      const a = ((i * 37.7) % 5000) - 2500;
      const b = ((i * 91.3) % 5000) - 2500;
      expect(Math.abs(dist(a, b) - Math.hypot(a, b))).toBeLessThan(2e-12);
    }
  });

  it('detSin/detCos match Math.sin/cos to < 1e-9, including large args', () => {
    for (let i = 0; i < 20000; i++) {
      const x = (i - 10000) * 0.0314159;
      expect(Math.abs(detSin(x) - Math.sin(x))).toBeLessThan(1e-9);
      expect(Math.abs(detCos(x) - Math.cos(x))).toBeLessThan(1e-9);
    }
  });

  it('detSin/detCos hit the cardinal points', () => {
    expect(detSin(0)).toBe(0);
    expect(Math.abs(detCos(0) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(detSin(Math.PI / 2) - 1)).toBeLessThan(1e-9);
    expect(Math.abs(detCos(Math.PI) + 1)).toBeLessThan(1e-9);
    // periodicity through the range-reduction path
    expect(Math.abs(detSin(123.456 + Math.PI * 4) - detSin(123.456))).toBeLessThan(1e-9);
  });

  it('detLog10 matches Math.log10 to < 1e-12 over the score-curve domain', () => {
    for (const v of [1, 1.001, 2, 9.999, 10, 999.5, 1000, 123456.789, 999000000, 1e12]) {
      expect(Math.abs(detLog10(v) - Math.log10(v))).toBeLessThan(1e-12);
    }
    expect(detLog10(1)).toBe(0);
    expect(Math.abs(detLog10(10) - 1)).toBeLessThan(1e-12);
  });

  it('detLog10 mirrors Math.log10 edge behavior', () => {
    expect(detLog10(0)).toBe(-Infinity);
    expect(detLog10(-5)).toBeNaN();
  });

  it('is bit-stable: same input, same double, every call', () => {
    for (const x of [0, 0.1, 1, 123.456, -987.654, 1e6]) {
      expect(detSin(x)).toBe(detSin(x));
      expect(detCos(x)).toBe(detCos(x));
      expect(dist(x, -x)).toBe(dist(x, -x));
    }
    expect(detLog10(999999.5)).toBe(detLog10(999999.5));
  });
});
