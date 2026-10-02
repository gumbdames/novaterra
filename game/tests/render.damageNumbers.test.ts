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
 * NOVATERRA — damage-number tests (render/damageNumbers.ts, roadmap B13).
 *
 * The canvas sprite pool can't be asserted headless, so these tests pin
 * the pure layer: digit splitting (rounding, clamping) and the
 * involvement color rule.
 */
import { describe, expect, it } from 'vitest';

import {
  splitDamageDigits,
  damageNumberColor,
  MAX_DISPLAY_DAMAGE,
} from '../src/render/damageNumbers';

describe('splitDamageDigits', () => {
  it('splits values most-significant first', () => {
    expect(splitDamageDigits(7)).toEqual([7]);
    expect(splitDamageDigits(42)).toEqual([4, 2]);
    expect(splitDamageDigits(913)).toEqual([9, 1, 3]);
  });

  it('rounds fractional damage', () => {
    expect(splitDamageDigits(12.6)).toEqual([1, 3]);
    expect(splitDamageDigits(0.4)).toEqual([0]);
  });

  it('clamps to the display maximum', () => {
    expect(splitDamageDigits(MAX_DISPLAY_DAMAGE + 5000)).toEqual(
      String(MAX_DISPLAY_DAMAGE).split('').map(Number),
    );
  });

  it('floors negative damage at zero', () => {
    expect(splitDamageDigits(-3)).toEqual([0]);
  });
});

describe('damageNumberColor', () => {
  const HUMAN = 0;
  const RIVAL = 1;

  it('paints gold when the human side dealt the damage', () => {
    expect(damageNumberColor(RIVAL, HUMAN, HUMAN)).toBe('#ffd76a');
  });

  it('paints red when the human side took the damage', () => {
    expect(damageNumberColor(HUMAN, RIVAL, HUMAN)).toBe('#ff6a5e');
  });

  it('paints white for AI-vs-AI exchanges', () => {
    expect(damageNumberColor(RIVAL, 2, HUMAN)).toBe('#ffffff');
  });
});
