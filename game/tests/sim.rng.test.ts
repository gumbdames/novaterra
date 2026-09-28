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
import { createRngBank } from '../src/sim/rng';
import type { RngState } from '../src/sim/rng';

describe('sim/rng', () => {
  it('same seed produces the same sequence', () => {
    const a = createRngBank(1234);
    const b = createRngBank(1234);
    const seqA = Array.from({ length: 50 }, () => a.next('test'));
    const seqB = Array.from({ length: 50 }, () => b.next('test'));
    expect(seqA).toEqual(seqB);
    // Sanity: the sequence is not degenerate.
    expect(new Set(seqA).size).toBeGreaterThan(40);
  });

  it('named streams are independent of each other', () => {
    const a = createRngBank(99);
    const combatA = Array.from({ length: 10 }, () => a.next('combat'));
    const economyA = Array.from({ length: 10 }, () => a.next('economy'));

    // Heavy draws from 'economy' must not shift 'combat'.
    const b = createRngBank(99);
    for (let i = 0; i < 200; i++) b.next('economy');
    const combatB = Array.from({ length: 10 }, () => b.next('combat'));
    expect(combatB).toEqual(combatA);

    // And vice versa.
    const c = createRngBank(99);
    for (let i = 0; i < 200; i++) c.next('combat');
    const economyC = Array.from({ length: 10 }, () => c.next('economy'));
    expect(economyC).toEqual(economyA);
  });

  it('different seeds produce different sequences', () => {
    const firsts = [1, 2, 3, 4, 5].map((s) => createRngBank(s).next('test'));
    expect(new Set(firsts).size).toBe(5);
  });

  it('streams are derived lazily but deterministically', () => {
    // A stream first touched late gets the same seed as one present from tick 0.
    const late = createRngBank(55);
    for (let i = 0; i < 100; i++) late.next('other');
    const early = createRngBank(55);
    expect(late.next('fresh')).toBe(early.next('fresh'));
  });

  it('intBelow stays in [0, n) and is integral', () => {
    const r = createRngBank(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.intBelow('x', 10);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(10);
    }
    expect(r.intBelow('x', 1)).toBe(0);
  });

  it('range stays in [min, max)', () => {
    const r = createRngBank(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.range('x', -5, 2.5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThan(2.5);
    }
  });

  it('invalid arguments throw', () => {
    const r = createRngBank(7);
    expect(() => r.intBelow('x', 0)).toThrow();
    expect(() => r.intBelow('x', 1.5)).toThrow();
    expect(() => r.range('x', 3, 3)).toThrow();
    expect(() => r.range('x', 4, 3)).toThrow();
  });

  it('saved state fully determines continuation (plain-data record)', () => {
    const rec: RngState = {};
    const a = createRngBank(4242, rec);
    a.next('s');
    a.next('s');
    // The record alone continues the sequence — the master seed is irrelevant
    // once a stream is initialized. This is what makes saves work.
    const saved = { ...rec };
    const b = createRngBank(777, saved);
    expect(b.next('s')).toBe(a.next('s'));
    expect(b.next('s')).toBe(a.next('s'));
    // And the bank wrote its state back into the record it was given.
    expect(typeof rec['s']).toBe('number');
  });
});
