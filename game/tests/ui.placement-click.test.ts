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
 * NOVATERRA — placement click resolution tests (ui/placement.ts).
 *
 * The map-click path must never fail silently: every placement click
 * resolves to either an order (the exact struct the controller enqueues)
 * or a human-readable hint (toasted with an error cue). These tests pin
 * that contract — in particular the cases the old inline click handler
 * swallowed without feedback: zone-tool clicks, off-grid clicks, and
 * sky clicks in placement mode.
 *
 * Headless-safe: no DOM, no three.js.
 */

import { describe, expect, it } from 'vitest';

import { CITY_GRID_CELLS } from '../src/sim/city';
import { STRINGS } from '../src/ui/strings';
import {
  resolveBuildToolClick,
  resolveTrainClick,
} from '../src/ui/placement';

describe('resolveBuildToolClick', () => {
  it('road tool → a buildRoad order for the clicked cell', () => {
    const r = resolveBuildToolClick('road', 0, { cx: 10, cz: 20 });
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.intent.kind).toBe('buildRoad');
    expect(r.intent.payload).toMatchObject({
      owner: 0,
      cells: [20 * CITY_GRID_CELLS + 10],
    });
  });

  it('building tool → a placeBuilding order with the right kind/cell', () => {
    const r = resolveBuildToolClick('building:house', 0, { cx: 7, cz: 9 });
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.intent.kind).toBe('placeBuilding');
    expect(r.intent.payload).toMatchObject({ kind: 'house', owner: 0, cx: 7, cz: 9 });
  });

  it('demolish tool → a demolish order for the clicked cell', () => {
    const r = resolveBuildToolClick('demolish', 0, { cx: 3, cz: 4 });
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.intent.kind).toBe('demolish');
    expect(r.intent.payload).toMatchObject({ owner: 0, cx: 3, cz: 4 });
  });

  it('zone tool click → a drag hint, never a silent no-op', () => {
    for (const tool of ['zoneR', 'zoneC', 'zoneI'] as const) {
      const r = resolveBuildToolClick(tool, 0, { cx: 5, cz: 5 });
      expect(r.kind).toBe('hint');
      if (r.kind !== 'hint') continue;
      expect(r.message).toBe(STRINGS.orders.zoneNeedsDrag);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('off-grid click (null cell) → a build-failed hint, never silent', () => {
    for (const tool of ['road', 'demolish', 'building:house', 'zoneR'] as const) {
      const r = resolveBuildToolClick(tool, 0, null);
      expect(r.kind).toBe('hint');
      if (r.kind !== 'hint') continue;
      expect(r.message.length).toBeGreaterThan(0);
    }
    const r = resolveBuildToolClick('building:house', 0, null);
    expect(r.kind).toBe('hint');
    if (r.kind === 'hint') expect(r.message).toBe(STRINGS.orders.buildFailed);
  });
});

describe('resolveTrainClick', () => {
  it('ground point → a spawnUnit order with the right kind/position', () => {
    const r = resolveTrainClick('rifles', 0, { x: 12.5, z: -40.25 });
    expect(r.kind).toBe('order');
    if (r.kind !== 'order') return;
    expect(r.intent.kind).toBe('spawnUnit');
    expect(r.intent.payload).toMatchObject({ kind: 'rifles', owner: 0, x: 12.5, z: -40.25 });
  });

  it('sky click (null point) → a train-failed hint, never silent', () => {
    const r = resolveTrainClick('rifles', 0, null);
    expect(r.kind).toBe('hint');
    if (r.kind !== 'hint') return;
    expect(r.message).toBe(STRINGS.orders.trainFailed);
  });
});
