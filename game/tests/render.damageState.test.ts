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
 * NOVATERRA — building damage-state tests (render/damageState.ts,
 * roadmap B13). Pins the pure layer: which buildings earn an HP bar and
 * the bar's color ramp.
 */
import { describe, expect, it } from 'vitest';

import { buildingHpFraction, hpBarColor } from '../src/render/damageState';
import { BUILDING_DEFS, type BuildingRecord } from '../src/sim/city';

function building(over: Partial<BuildingRecord> = {}): BuildingRecord {
  return {
    id: 1,
    kind: 'farm',
    owner: 0,
    cx: 10,
    cz: 10,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
    ...over,
  } as BuildingRecord;
}

describe('buildingHpFraction', () => {
  it('returns null at full health (no bar)', () => {
    const max = BUILDING_DEFS.farm.hp;
    expect(buildingHpFraction(building({ hp: max, maxHp: max }))).toBeNull();
  });

  it('returns the fraction while damaged', () => {
    const max = BUILDING_DEFS.farm.hp;
    expect(
      buildingHpFraction(building({ hp: max / 2, maxHp: max })),
    ).toBeCloseTo(0.5, 9);
  });

  it('floors at zero for a destroyed building', () => {
    const max = BUILDING_DEFS.farm.hp;
    expect(buildingHpFraction(building({ hp: 0, maxHp: max }))).toBe(0);
  });

  it('falls back to the def when hp fields are missing (AD9)', () => {
    const b = building();
    delete (b as Partial<BuildingRecord>).hp;
    delete (b as Partial<BuildingRecord>).maxHp;
    expect(buildingHpFraction(b)).toBeNull();
  });
});

describe('hpBarColor', () => {
  it('ramps green → yellow → red', () => {
    expect(hpBarColor(0.9)).toBe('#58d858');
    expect(hpBarColor(0.4)).toBe('#e8c832');
    expect(hpBarColor(0.1)).toBe('#e04848');
  });
});
