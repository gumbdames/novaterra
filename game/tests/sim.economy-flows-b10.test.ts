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
 * Roadmap B10 (economy legibility, 2026-10-02): per-resource net flow
 * rates. The sim boundary-diffs stockpiles across each economy tick and
 * smooths the deltas (EWMA); the UI shows the rates on the topbar chips
 * (formatFlowRate) and in the Management → Economy overview (ec:
 * digest segment).
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import { placeBuilding, type BuildingKind, type BuildingRecord } from '../src/sim/city';
import {
  runEconomyTick,
  ECONOMY_TICKS,
  FLOW_RESOURCES,
  flowRate,
  type FlowResource,
} from '../src/sim/economy';
import { formatFlowRate } from '../src/ui/palettes';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { selectionDigest } from '../src/ui/paletteDigest';
import { createSelection } from '../src/ui/selection';

let cachedTerrain: TerrainData | undefined;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** One economy second per iteration (no driver). */
function runSeconds(world: World, seconds: number): void {
  for (let s = 0; s < seconds; s++) {
    world.tick += ECONOMY_TICKS;
    world.time = world.tick / ECONOMY_TICKS;
    runEconomyTick(world, getTerrain());
  }
}

/** Directly place a completed building (bypasses command validation). */
function completed(
  world: World,
  kind: BuildingKind,
  owner: number,
  cx: number,
  cz: number,
): BuildingRecord {
  const b = placeBuilding(world.city, { kind, owner, cx, cz, facing: 0 });
  b.progress = 1;
  return b;
}

describe('flowRate (sim)', () => {
  it('is 0 (never NaN) before the first economy tick and for unknown owners', () => {
    const world = createWorld(101);
    for (const r of FLOW_RESOURCES) {
      expect(flowRate(world, 0, r)).toBe(0);
      expect(flowRate(world, 999, r)).toBe(0);
      expect(Number.isNaN(flowRate(world, 999, r))).toBe(false);
    }
  });

  it('a farm shows a positive food rate after a few ticks', () => {
    const world = createWorld(102);
    completed(world, 'farm', 0, 10, 10);
    runSeconds(world, 30);
    expect(flowRate(world, 0, 'food')).toBeGreaterThan(0);
  });

  it('a factory shows a negative fuel rate (fuel input burned each tick)', () => {
    const world = createWorld(103);
    completed(world, 'factory', 0, 10, 10);
    runSeconds(world, 30);
    expect(flowRate(world, 0, 'fuel')).toBeLessThan(0);
  });

  it('converges on the true per-tick delta (EWMA, ~10s memory)', () => {
    const world = createWorld(104);
    completed(world, 'farm', 0, 10, 10);
    runSeconds(world, 60);
    // Measure the true last-tick delta directly around one more tick.
    const p = world.city.players[0]!;
    const before = p.food;
    world.tick += ECONOMY_TICKS;
    world.time = world.tick / ECONOMY_TICKS;
    runEconomyTick(world, getTerrain());
    const delta = p.food - before;
    const rate = flowRate(world, 0, 'food');
    // After 60+ ticks the EWMA has ~0.2% memory of the first ticks; the
    // food delta is near-constant (farm output is flat), so the rate
    // must track it within 5%.
    expect(Math.abs(rate - delta)).toBeLessThan(Math.abs(delta) * 0.05 + 1e-9);
  });

  it('is per-owner: a rival with no production reads ~0', () => {
    const world = createWorld(105);
    completed(world, 'farm', 0, 10, 10);
    runSeconds(world, 30);
    expect(flowRate(world, 0, 'food')).toBeGreaterThan(0);
    // Rival id 1 exists in the default world; give it no buildings.
    expect(Math.abs(flowRate(world, 1, 'food'))).toBeLessThan(0.05);
  });

  it('FLOW_RESOURCES covers the eight stockpiles (and nothing else)', () => {
    expect([...FLOW_RESOURCES].sort()).toEqual(
      ['food', 'fuel', 'funds', 'goods', 'influence', 'manpower', 'materials', 'research'].sort(),
    );
  });
});

describe('formatFlowRate (ui mirror)', () => {
  it('signs, rounds to one decimal, and appends /s', () => {
    expect(formatFlowRate(2.34)).toBe('+2.3/s');
    expect(formatFlowRate(-5)).toBe('−5.0/s');
    expect(formatFlowRate(0.06)).toBe('+0.1/s');
  });
  it('stays quiet at rest (0, negligible, NaN, infinite)', () => {
    expect(formatFlowRate(0)).toBe('');
    expect(formatFlowRate(0.04)).toBe('');
    expect(formatFlowRate(-0.04)).toBe('');
    expect(formatFlowRate(NaN)).toBe('');
    expect(formatFlowRate(Infinity)).toBe('');
  });
});

describe('economy overview digest (ec:)', () => {
  const NO_SEL = createSelection();
  it('is emitted under the management tab, with one entry per flow resource', () => {
    const session = createSession({ seed: 777 });
    const digest = selectionDigest(session.world, NO_SEL, 'infantry', 'housing', undefined, 'management');
    expect(digest).toContain('ec:');
    const seg = digest.split('|').find((s) => s.startsWith('ec:'))!;
    expect(seg.slice(3).split(',')).toHaveLength(FLOW_RESOURCES.length);
  });
  it('moves when production changes the rates', () => {
    const session = createSession({ seed: 778 });
    const before = selectionDigest(session.world, NO_SEL, 'infantry', 'housing', undefined, 'management');
    completed(session.world, 'farm', HUMAN_PLAYER_ID, 10, 10);
    runSeconds(session.world, 30);
    const after = selectionDigest(session.world, NO_SEL, 'infantry', 'housing', undefined, 'management');
    expect(after).not.toBe(before);
    expect(after).toContain('ec:');
  });
  it('is absent on other tabs (the overview does not render there)', () => {
    const session = createSession({ seed: 779 });
    const digest = selectionDigest(session.world, NO_SEL, 'infantry', 'housing', undefined, 'civilian');
    expect(digest).not.toContain('ec:');
  });
});
