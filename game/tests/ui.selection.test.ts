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
 * NOVATERRA — selection tests (Phase 1, step 9).
 *
 * Pure selection state + picking helpers: box select filters, click
 * tolerance, shift-toggle, pruning dead ids. Raycasting itself lives in
 * ui/game.ts (needs three.js) and is not tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  boxSelectUnits,
  clearSelection,
  createSelection,
  isSelectionEmpty,
  nearestUnit,
  pruneSelection,
  resolveClickPick,
  selectBuilding,
  selectUnits,
  toggleUnit,
  type PickableUnit,
} from '../src/ui/selection';

function unit(id: number, x: number, z: number, owner = 0, hp = 100): PickableUnit {
  return { id, owner, x, z, hp };
}

describe('selection state', () => {
  it('starts empty', () => {
    expect(isSelectionEmpty(createSelection())).toBe(true);
    expect(isSelectionEmpty(clearSelection())).toBe(true);
  });

  it('selectUnits replaces the selection and clears buildings', () => {
    const s = selectUnits([1, 2, 3]);
    expect(s.unitIds).toEqual([1, 2, 3]);
    expect(s.buildingId).toBeNull();
    expect(isSelectionEmpty(s)).toBe(false);
  });

  it('selectBuilding clears units', () => {
    const s = selectBuilding(42);
    expect(s.buildingId).toBe(42);
    expect(s.unitIds).toEqual([]);
  });

  it('toggleUnit adds and removes (shift-click)', () => {
    let s = selectUnits([1]);
    s = toggleUnit(s, 2);
    expect(s.unitIds).toEqual([1, 2]);
    s = toggleUnit(s, 1);
    expect(s.unitIds).toEqual([2]);
    // Toggling clears any building selection.
    s = toggleUnit(selectBuilding(9), 5);
    expect(s.buildingId).toBeNull();
    expect(s.unitIds).toEqual([5]);
  });
});

describe('boxSelectUnits', () => {
  const units = [unit(1, 0, 0), unit(2, 5, 5), unit(3, 50, 50, 1), unit(4, 2, 2, 0, 0)];

  it('selects owned living units inside the rect', () => {
    expect(boxSelectUnits(units, -1, -1, 10, 10, 0)).toEqual([1, 2]);
  });

  it('accepts corners in any order', () => {
    expect(boxSelectUnits(units, 10, 10, -1, -1, 0)).toEqual([1, 2]);
  });

  it('excludes enemies and the dead', () => {
    // id 3 is enemy-owned, id 4 is dead.
    expect(boxSelectUnits(units, -100, -100, 100, 100, 0)).toEqual([1, 2]);
    expect(boxSelectUnits(units, -100, -100, 100, 100, 1)).toEqual([3]);
  });

  it('follows input order deterministically', () => {
    const shuffled = [unit(2, 5, 5), unit(1, 0, 0)];
    expect(boxSelectUnits(shuffled, -1, -1, 10, 10, 0)).toEqual([2, 1]);
  });
});

describe('nearestUnit', () => {
  const units = [unit(1, 0, 0), unit(2, 10, 0), unit(3, 3, 0, 0, 0)];

  it('picks the closest unit within tolerance', () => {
    expect(nearestUnit(units, 2.9, 0, 5)?.id).toBe(1);
    expect(nearestUnit(units, 9, 0, 5)?.id).toBe(2);
  });

  it('returns null outside tolerance', () => {
    expect(nearestUnit(units, 100, 100, 5)).toBeNull();
  });

  it('skips dead units and breaks ties by lowest id', () => {
    // id 3 is dead at (3,0); id 1 at (0,0) wins over id 2 at equal distance.
    const tied = [unit(2, 4, 0), unit(1, 0, 0)];
    expect(nearestUnit(tied, 2, 0, 10)?.id).toBe(1);
  });
});

describe('pruneSelection', () => {
  it('drops dead units and demolished buildings', () => {
    const sel = { unitIds: [1, 2, 3], buildingId: 7 };
    const pruned = pruneSelection(sel, new Set([1, 3]), new Set<number>());
    expect(pruned.unitIds).toEqual([1, 3]);
    expect(pruned.buildingId).toBeNull();
  });

  it('keeps live buildings', () => {
    const pruned = pruneSelection(selectBuilding(7), new Set(), new Set([7]));
    expect(pruned.buildingId).toBe(7);
  });

  it('does not mutate the input', () => {
    const sel = selectUnits([1, 2]);
    pruneSelection(sel, new Set([1]), new Set());
    expect(sel.unitIds).toEqual([1, 2]);
  });
});

describe('multi-cell building selection hit-testing', () => {
  it('every cell inside a multi-cell building footprint resolves to the building id', async () => {
    const { initCity, buildingAtCell, cellIndex, BUILDING_DEFS } = await import('../src/sim/city');
    const city = initCity();
    const def = BUILDING_DEFS.hospital; // 3x3 footprint
    const hospital = {
      id: 99,
      kind: 'hospital',
      cx: 10,
      cz: 10,
      footprintW: def.footprintW,
      footprintH: def.footprintH,
      owner: 0,
      hp: 100,
      maxHp: 100,
      active: true,
      builtAtTick: 0,
    };
    city.buildings.push(hospital as any);

    // Verify all 9 tiles of the 3x3 footprint resolve to building id 99
    for (let dz = 0; dz < def.footprintH; dz++) {
      for (let dx = 0; dx < def.footprintW; dx++) {
        const found = buildingAtCell(city, cellIndex(10 + dx, 10 + dz));
        expect(found?.id).toBe(99);
      }
    }

    // Verify adjacent outside cells do not resolve to the hospital
    expect(buildingAtCell(city, cellIndex(9, 10))).toBeUndefined();
    expect(buildingAtCell(city, cellIndex(13, 10))).toBeUndefined();
    expect(buildingAtCell(city, cellIndex(10, 13))).toBeUndefined();
  });
});


describe('resolveClickPick (2026-10-05 building-first priority)', () => {
  // Building id 7 covers the point (100, 100); nothing covers (0, 0).
  const buildingIdAt = (x: number, z: number): number | null =>
    Math.abs(x - 100) < 2 && Math.abs(z - 100) < 2 ? 7 : null;
  const TOL = 4;

  it('prefers the building when a unit loiters within tolerance', () => {
    const units = [unit(3, 101, 101)]; // 1.4 world units from the click
    const pick = resolveClickPick(units, buildingIdAt, 100, 100, TOL);
    expect(pick).toEqual({ kind: 'building', id: 7 });
  });

  it('selects a unit in the open normally', () => {
    const units = [unit(3, 10, 10)];
    const pick = resolveClickPick(units, buildingIdAt, 10, 10, TOL);
    expect(pick?.kind).toBe('unit');
    if (pick?.kind === 'unit') expect(pick.unit.id).toBe(3);
  });

  it('returns null on empty ground', () => {
    expect(resolveClickPick([], buildingIdAt, 0, 0, TOL)).toBeNull();
    expect(resolveClickPick([unit(3, 50, 50)], buildingIdAt, 0, 0, TOL)).toBeNull();
  });

  it('ignores dead units', () => {
    const units = [unit(3, 10, 10, 0, 0)];
    expect(resolveClickPick(units, buildingIdAt, 10, 10, TOL)).toBeNull();
  });
});
