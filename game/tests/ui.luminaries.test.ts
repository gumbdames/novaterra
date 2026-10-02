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
 * NOVATERRA — luminary UI contract tests (fun-audit Tier 4 / E2, 0.1 Alpha).
 *
 * Covers the pure card-view contract (`ui/luminaries.ts`): hidden when no
 * luminary awaits, the card id + choices + default, the whole-seconds
 * decision countdown, the owner gate, the effect badges, and defensive
 * reads on malformed worlds.
 */
import { describe, expect, it } from 'vitest';
import { luminaryCardView, luminaryBadges } from '../src/ui/luminaries';
import type { World } from '../src/sim/world';
import type { PendingLuminaryDecision } from '../src/sim/luminaries';

const HUMAN = 0;

function pending(over: Partial<PendingLuminaryDecision> = {}): PendingLuminaryDecision {
  return {
    cardId: 'defector',
    unitId: 42,
    owner: HUMAN,
    deadlineTick: 100 + 5400,
    ...over,
  };
}

function worldWith(pendingDecision: PendingLuminaryDecision | null, tick = 100): World {
  return {
    tick,
    luminaries: {
      pending: pendingDecision,
      productionMarks: [],
      coverUp: null,
      upkeepCutUntilTick: 0,
      instructors: [],
      lastCoverUpOutcome: null,
    },
  } as unknown as World;
}

describe('luminaryCardView', () => {
  it('is null when no luminary awaits', () => {
    expect(luminaryCardView(worldWith(null), HUMAN)).toBeNull();
  });

  it('is null for another owner (player-side only)', () => {
    const world = worldWith(pending({ owner: 1 }));
    expect(luminaryCardView(world, HUMAN)).toBeNull();
    expect(luminaryCardView(world, 1)).not.toBeNull();
  });

  it('returns the card id, choices, and default', () => {
    const view = luminaryCardView(worldWith(pending({ cardId: 'warHero' })), HUMAN)!;
    expect(view.cardId).toBe('warHero');
    expect(view.choices).toEqual(['retire', 'keep']);
    expect(view.defaultChoiceId).toBe('keep');
    expect(view.unitId).toBe(42);
  });

  it('counts down whole seconds (30 ticks/sec)', () => {
    const world = worldWith(pending({ deadlineTick: 100 + 90 }), 100);
    expect(luminaryCardView(world, HUMAN)!.secondsLeft).toBe(3);
  });

  it('clamps the countdown at zero past the deadline', () => {
    const world = worldWith(pending({ deadlineTick: 50 }), 100);
    expect(luminaryCardView(world, HUMAN)!.secondsLeft).toBe(0);
  });

  it('is null for an unknown card id (defensive)', () => {
    const world = worldWith(pending({ cardId: 'nope' as never }));
    expect(luminaryCardView(world, HUMAN)).toBeNull();
  });

  it('tolerates malformed worlds (defensive)', () => {
    expect(luminaryCardView({} as World, HUMAN)).toBeNull();
    expect(luminaryCardView({ luminaries: null } as unknown as World, HUMAN)).toBeNull();
  });
});

describe('luminaryBadges', () => {
  it('is empty with no effects active', () => {
    const badges = luminaryBadges(worldWith(null), HUMAN);
    expect(badges).toEqual({
      upkeepCutSecs: null,
      coverUpPending: false,
      productionMarks: 0,
      instructors: [],
    });
  });

  it('reports the upkeep cut countdown', () => {
    const world = worldWith(null, 100);
    world.luminaries.upkeepCutUntilTick = 100 + 300;
    expect(luminaryBadges(world, HUMAN).upkeepCutSecs).toBe(10);
  });

  it('reports the cover-up and live marks', () => {
    const world = worldWith(null, 100);
    world.luminaries.coverUp = { leakAtTick: 9999 };
    world.luminaries.productionMarks = [
      { buildingId: 1, untilTick: 9999 },
      { buildingId: 2, untilTick: 9999 },
    ];
    const badges = luminaryBadges(world, HUMAN);
    expect(badges.coverUpPending).toBe(true);
    expect(badges.productionMarks).toBe(2);
  });

  it('names the drill instructors', () => {
    const world = worldWith(null, 100);
    world.luminaries.instructors = [
      { unitId: 1, owner: HUMAN, name: 'A. Reyes' },
      { unitId: 2, owner: 1, name: 'B. Other' },
    ];
    expect(luminaryBadges(world, HUMAN).instructors).toEqual(['A. Reyes']);
  });

  it('is empty for another owner', () => {
    const world = worldWith(null, 100);
    world.luminaries.upkeepCutUntilTick = 9999;
    const badges = luminaryBadges(world, 1);
    expect(badges.upkeepCutSecs).toBeNull();
  });
});
