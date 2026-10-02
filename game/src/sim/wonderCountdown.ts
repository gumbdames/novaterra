/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3.0 of the License.
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
 * NOVATERRA — sim/wonderCountdown.ts — the wonder countdown (fun-audit
 * B2, 2026-10-02).
 *
 * The game's own documented design (C6: "complete the Monument wonder
 * and survive the countdown," RA2 superweapon pacing) that was dropped
 * in implementation: when any side completes a Monument — or crosses
 * 80% of the economic/population victory threshold — a 5-minute global
 * countdown starts with escalating warnings. The rival gets a
 * last-stand window; the leader must defend. A run needs a forced
 * ending to feel like a run.
 *
 * Rules (all deterministic, all pure functions of world state):
 * - Only for race victory kinds ('economic' | 'population' |
 *   'monument'); conquest and peaceful worlds never start one.
 * - Trigger: a completed Monument (progress >= 1), or funds >= 80% of
 *   ECONOMIC_VICTORY_FUNDS, or housed population >= 80% of
 *   POPULATION_VICTORY_POP. First side to trigger leads; ties break to
 *   the human (owner 0).
 * - While active, the leader must keep meeting the trigger — a
 *   destroyed Monument / a treasury or population dip below 80%
 *   cancels the countdown (the rival broke it).
 * - At expiry the leader wins if they still qualify; otherwise the
 *   rival wins if THEY qualify (e.g. they finished their own Monument
 *   mid-countdown). Otherwise the countdown simply lapses.
 * - Economic/population keep their instant win at 100% — crossing the
 *   finish line outright ends the race; the countdown only forces the
 *   ending when a leader stalls near it. Monument has no instant win:
 *   completion starts the countdown, survival wins it.
 *
 * State lives on the world (`wonderCountdown`, null when idle):
 * snapshotted (AD9 neutral-default null) and digest-covered
 * (behavior-affecting). Warnings (Muse lines, toasts, HUD) are UI-side
 * in game.ts — the sim only owns the clock.
 */

import type { World } from './world';
import { getPlayer } from './city';
import { TICK_HZ } from './tick';
import type { SimSystem } from './tick';

/** First side to hold this treasury wins the economic race outright. */
export const ECONOMIC_VICTORY_FUNDS = 100_000;
/** First side to house this many residents wins the population race outright. */
export const POPULATION_VICTORY_POP = 10_000;

/**
 * The 5-minute global countdown, in ticks. TICK_HZ is 30: 5 × 60 × 30.
 */
export const WONDER_COUNTDOWN_TICKS = 5 * 60 * TICK_HZ;

/**
 * Fraction of the economic/population victory threshold that starts
 * the countdown (80% → 80,000 funds / 8,000 housed).
 */
export const WONDER_COUNTDOWN_FRACTION = 0.8;

/** The race kinds a countdown can run for (never conquest). */
export type WonderRaceKind = 'economic' | 'population' | 'monument';

/**
 * The live countdown. `leader` is the triggering side's owner id;
 * `endsAtTick` is the tick the countdown resolves on.
 */
export interface WonderCountdown {
  kind: WonderRaceKind;
  leader: number;
  endsAtTick: number;
}

/**
 * Owner ids. The canonical HUMAN_PLAYER_ID / AI_PLAYER_ID live in
 * ui/session.ts; the sim hardcodes the pair (0 = human, 1 = AI) —
 * sim modules never import from ui/.
 */
const SKIRMISH_OWNERS = [0, 1] as const;

/** The trigger threshold for a race kind (funds / housed / n/a). */
export function wonderTriggerThreshold(kind: WonderRaceKind): number {
  switch (kind) {
    case 'economic':
      return ECONOMIC_VICTORY_FUNDS * WONDER_COUNTDOWN_FRACTION;
    case 'population':
      return POPULATION_VICTORY_POP * WONDER_COUNTDOWN_FRACTION;
    case 'monument':
      return 1;
  }
}

/**
 * Whether `owner` currently meets the countdown trigger for `kind`.
 * Pure function of world state.
 */
export function meetsWonderTrigger(
  world: World,
  kind: WonderRaceKind,
  owner: number,
): boolean {
  switch (kind) {
    case 'economic':
      return (getPlayer(world.city, owner)?.funds ?? 0) >= wonderTriggerThreshold(kind);
    case 'population':
      return (getPlayer(world.city, owner)?.population ?? 0) >= wonderTriggerThreshold(kind);
    case 'monument':
      for (const b of world.city.buildings) {
        if (b.owner === owner && b.kind === 'monument' && (b.progress ?? 0) >= 1) {
          return true;
        }
      }
      return false;
  }
}

/**
 * The countdown leader for a fresh trigger: the side meeting the
 * trigger with the better score (funds / housed; completion order for
 * monuments — human first on a shared tick). Null when nobody does.
 */
function pickWonderLeader(world: World, kind: WonderRaceKind): number | null {
  const human = meetsWonderTrigger(world, kind, SKIRMISH_OWNERS[0]);
  const ai = meetsWonderTrigger(world, kind, SKIRMISH_OWNERS[1]);
  if (!human && !ai) return null;
  if (kind === 'monument') return human ? SKIRMISH_OWNERS[0] : SKIRMISH_OWNERS[1];
  const score = (owner: number): number =>
    kind === 'economic'
      ? (getPlayer(world.city, owner)?.funds ?? 0)
      : (getPlayer(world.city, owner)?.population ?? 0);
  if (human && ai) {
    return score(SKIRMISH_OWNERS[0]) >= score(SKIRMISH_OWNERS[1])
      ? SKIRMISH_OWNERS[0]
      : SKIRMISH_OWNERS[1];
  }
  return human ? SKIRMISH_OWNERS[0] : SKIRMISH_OWNERS[1];
}

/**
 * The countdown winner, if the countdown has resolved: the leader if
 * they still qualify at expiry, else the rival if they do. Null while
 * the countdown runs, when idle, or when it lapsed unclaimed. Pure
 * function of world state — the victory checks call this.
 */
export function checkWonderCountdownVictory(world: World): number | null {
  const cd = world.wonderCountdown ?? null;
  if (cd === null || world.peaceful === true) return null;
  if (world.tick < cd.endsAtTick) return null;
  if (meetsWonderTrigger(world, cd.kind, cd.leader)) return cd.leader;
  const rival = cd.leader === SKIRMISH_OWNERS[0] ? SKIRMISH_OWNERS[1] : SKIRMISH_OWNERS[0];
  if (meetsWonderTrigger(world, cd.kind, rival)) return rival;
  return null;
}

/** Ticks of countdown remaining (<= 0 once resolved). */
export function wonderCountdownRemaining(world: World): number {
  const cd = world.wonderCountdown ?? null;
  if (cd === null) return 0;
  return cd.endsAtTick - world.tick;
}

/**
 * The per-tick system: starts the countdown on a fresh trigger,
 * cancels it when the leader stops qualifying. Expiry needs no state
 * change — `checkWonderCountdownVictory` resolves it purely, and the
 * game ends on the verdict. Runs after the economy system (funds and
 * population are economy-tick values).
 */
export function createWonderCountdownSystem(): SimSystem {
  return (world: World): void => {
    if (world.peaceful === true) return;
    const kind = world.victoryKind;
    if (kind !== 'economic' && kind !== 'population' && kind !== 'monument') return;
    const cd = world.wonderCountdown ?? null;
    if (cd === null) {
      const leader = pickWonderLeader(world, kind);
      if (leader !== null) {
        world.wonderCountdown = {
          kind,
          leader,
          endsAtTick: world.tick + WONDER_COUNTDOWN_TICKS,
        };
      }
      return;
    }
    // The victory kind is immutable, so a kind mismatch can't happen —
    // but a corrupt or hand-built world shouldn't wedge the system.
    if (cd.kind !== kind) {
      world.wonderCountdown = null;
      return;
    }
    // The leader must defend: lose the trigger, lose the countdown.
    if (!meetsWonderTrigger(world, cd.kind, cd.leader)) {
      world.wonderCountdown = null;
    }
  };
}
