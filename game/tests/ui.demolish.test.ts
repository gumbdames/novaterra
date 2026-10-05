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
 * NOVATERRA — tests/ui.demolish.test.ts — building-loss toasts
 * (2026-10-05, Fix 2), headless-testable parts.
 *
 * Covers:
 *  - `isSingleUseOrderKind`: the demolish tool disarms after one
 *    successful click; every other order kind keeps its tool armed;
 *  - the new toast strings exist and render through the localization
 *    indirection (`fillLoc`), English-only, never hardcoded;
 *  - end to end through a real session: place → demolish → the drained
 *    command result carries the kind → the toast copy names the lost
 *    building ("Demolished House (no refund).").
 *
 * The DOM half (hud.toast, the controller's placeResolution wiring) is
 * browser-only; the frame wiring (pollDemolishResults runs every frame)
 * is pinned in tests/ui.gameLoop.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { STRINGS, fillLoc } from '../src/ui/strings';
import { buildingName } from '../src/ui/palettes';
import { isSingleUseOrderKind } from '../src/ui/placement';
import { buildDemolishOrder } from '../src/ui/orders';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { completeBuilding } from './sim.roster-fixtures';

describe('isSingleUseOrderKind', () => {
  it('demolish disarms after one successful click', () => {
    expect(isSingleUseOrderKind('demolish')).toBe(true);
  });

  it('other order kinds keep their tool armed', () => {
    for (const kind of ['placeBuilding', 'buildRoad', 'trainUnit', 'paintZone', 'spawnUnit']) {
      expect(isSingleUseOrderKind(kind), kind).toBe(false);
    }
  });
});

describe('building-loss toast strings', () => {
  it('buildingDestroyed names the lost building', () => {
    const copy = fillLoc(STRINGS.toasts.buildingDestroyed, { name: 'Water Pump' });
    expect(copy).toBe('Water Pump destroyed.');
  });

  it('demolishedBuilding names the demolition with the no-refund note', () => {
    const copy = fillLoc(STRINGS.toasts.demolishedBuilding, { name: buildingName('house') });
    expect(copy).toBe('Demolished House (no refund).');
  });

  it('both strings go through the localization indirection', () => {
    expect(STRINGS.toasts.buildingDestroyed.en).toContain('{name}');
    expect(STRINGS.toasts.demolishedBuilding.en).toContain('{name}');
  });
});

describe('demolish result → toast copy (session end to end)', () => {
  it('the drained demolish result names the building for the toast', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    completeBuilding(world, 'house', HUMAN_PLAYER_ID, 10, 10);
    const before = world.city.buildings.length;
    session.enqueuePlayerIntent(buildDemolishOrder(HUMAN_PLAYER_ID, 10, 10));
    session.tick();
    expect(world.city.buildings.length).toBe(before - 1);
    const drained = session.queue.drainResults();
    const demolish = drained.find((a) => a.command.kind === 'demolish');
    if (!demolish) throw new Error('no demolish result drained');
    const result = demolish.result as { removed?: string; id?: number; kind?: string };
    expect(result.removed).toBe('building');
    expect(result.kind).toBe('house');
    // The exact copy the controller toasts.
    const copy = fillLoc(STRINGS.toasts.demolishedBuilding, {
      name: buildingName(result.kind ?? 'unknown'),
    });
    expect(copy).toBe('Demolished House (no refund).');
  });
});
