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
 * NOVATERRA — select-all-military hotkey tests (roadmap B4, 0.1 Alpha).
 *
 * `militaryUnitIds` (ui/selection.ts) is the pure core of the A hotkey:
 * it returns the ids of every living unit owned by the player whose kind
 * is military. The game controller (game.ts, DOM-dependent) feeds it the
 * world's units and UNIT_DEFS and replaces the selection — that wiring is
 * covered by inspection, not by these headless tests.
 */

import { describe, expect, it } from 'vitest';
import { militaryUnitIds } from '../src/ui/selection';

const HUMAN = 0;
const AI = 1;

/** Test double for the def lookup: rifles/tank are military, engineer is not. */
const isMilitary = (kind: string): boolean => kind === 'rifles' || kind === 'tank';

function unit(id: number, kind: string, owner: number, hp: number) {
  return { id, owner, hp, kind };
}

describe('militaryUnitIds', () => {
  it('returns only living military units owned by the player', () => {
    const units = [
      unit(1, 'rifles', HUMAN, 100),
      unit(2, 'engineer', HUMAN, 100), // civilian — excluded
      unit(3, 'tank', HUMAN, 50),
      unit(4, 'rifles', AI, 100), // enemy — excluded
      unit(5, 'tank', HUMAN, 0), // dead — excluded
    ];
    expect(militaryUnitIds(units, HUMAN, isMilitary)).toEqual([1, 3]);
  });

  it('returns an empty list when the player owns no military units', () => {
    const units = [unit(1, 'engineer', HUMAN, 100), unit(2, 'rifles', AI, 100)];
    expect(militaryUnitIds(units, HUMAN, isMilitary)).toEqual([]);
  });

  it('follows input order (deterministic)', () => {
    const units = [
      unit(9, 'tank', HUMAN, 100),
      unit(4, 'rifles', HUMAN, 100),
      unit(7, 'tank', HUMAN, 100),
    ];
    expect(militaryUnitIds(units, HUMAN, isMilitary)).toEqual([9, 4, 7]);
  });

  it('does not mutate the input array', () => {
    const units = [unit(1, 'rifles', HUMAN, 100)];
    militaryUnitIds(units, HUMAN, isMilitary);
    expect(units).toHaveLength(1);
  });
});
