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
 * NOVATERRA — veterancy display tests (ui/veterancy.ts, Phase 1).
 *
 * The selection panel shows rank + chevrons + XP progress per selected
 * unit, e.g. "Veteran ▲▲ · 320/800 XP". These tests pin the format
 * (including the Elite no-next-threshold form) and pin the UI rank-name
 * copy to the sim's VET_RANK_NAMES so the two cannot drift.
 */
import { describe, expect, it } from 'vitest';

import type { UnitRecord } from '../src/sim/units';
import { VET_RANK_NAMES, VET_XP_THRESHOLDS } from '../src/sim/veterancy';
import { STRINGS } from '../src/ui/strings';
import { vetChevronGlyphs, vetRankLabel, vetXpLine } from '../src/ui/veterancy';

function fakeUnit(xp: number, vetLevel: number): UnitRecord {
  return { xp, vetLevel } as UnitRecord;
}

describe('vetXpLine', () => {
  it('shows rank, no chevrons, and progress to the first threshold for recruits', () => {
    expect(vetXpLine(fakeUnit(0, 0))).toBe('Recruit · 0/300 XP');
    expect(vetXpLine(fakeUnit(120, 0))).toBe('Recruit · 120/300 XP');
  });

  it('shows the example format for a mid-band veteran', () => {
    // Veteran (level 2) works toward the Elite threshold: 700/1600 XP.
    expect(vetXpLine(fakeUnit(700, 2))).toBe('Veteran ▲▲ · 700/1600 XP');
  });

  it('shows one chevron for Regular with progress to 800', () => {
    expect(vetXpLine(fakeUnit(300, 1))).toBe('Regular ▲ · 300/800 XP');
  });

  it('shows total XP with no next threshold for Elite', () => {
    expect(vetXpLine(fakeUnit(1240, 3))).toBe('Elite ▲▲▲ · 1240 XP');
    expect(vetXpLine(fakeUnit(1600, 3))).toBe('Elite ▲▲▲ · 1600 XP');
  });

  it('uses the sim thresholds (300/800/1600 cumulative)', () => {
    expect([...VET_XP_THRESHOLDS]).toEqual([300, 800, 1600]);
    expect(vetXpLine(fakeUnit(299, 0))).toContain('/300 XP');
    expect(vetXpLine(fakeUnit(799, 1))).toContain('/800 XP');
    expect(vetXpLine(fakeUnit(1599, 2))).toContain('/1600 XP');
  });
});

describe('vetRankLabel / vetChevronGlyphs', () => {
  it('labels ranks 0..3', () => {
    expect([0, 1, 2, 3].map(vetRankLabel)).toEqual([
      'Recruit',
      'Regular',
      'Veteran',
      'Elite',
    ]);
  });

  it('keeps UI rank copy identical to the sim VET_RANK_NAMES', () => {
    expect(STRINGS.veterancy.ranks.map((r) => r.en)).toEqual([...VET_RANK_NAMES]);
  });

  it('draws one ▲ per level (none for Recruit)', () => {
    expect([0, 1, 2, 3].map(vetChevronGlyphs)).toEqual(['', '▲', '▲▲', '▲▲▲']);
  });
});
