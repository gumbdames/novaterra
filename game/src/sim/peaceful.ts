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
 * NOVATERRA — sim/peaceful.ts — peaceful-mode victory (grand-expansion
 * Phase 8, workstream A, 2026-09-30).
 *
 * Responsibilities:
 *  - The peaceful victory condition as SIM-side pure checks:
 *    `checkPeacefulVictory(world, owner)` (win = reach the population
 *    target with a non-negative treasury) and
 *    `peacefulObjectiveProgress(world, owner)` (the UI panel's progress
 *    view). Pure functions of world state — no wall clock, no RNG.
 *  - Threshold constants (`PEACEFUL_VICTORY_POPULATION`,
 *    `PEACEFUL_VICTORY_MIN_TREASURY`) with the design rationale in the
 *    research note (docs/research/phase8-civilian-peaceful.md §3).
 *
 * Non-goals (explicit):
 *  - No "influence" system exists in 0.1 Alpha — none is invented here.
 *  - No defeat path: with every military def locked out, conquest is
 *    unreachable in a peaceful world, so peaceful games can only be
 *    won, never lost (documented in the research note).
 *  - Showing the victory is UI work: the UI panel consumes
 *    `peacefulObjectiveProgress`; the end screen wiring is a sibling
 *    workstream's. `ui/session.ts`'s conquest checks are bypassed for
 *    peaceful worlds (`getSkirmishOutcome` returns null), so the two
 *    victory systems never race.
 *
 * Import discipline: value-imports only city.ts (`getPlayer`); city.ts
 * never imports this module, so no cycle. Pure module: no DOM, no
 * three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import { getPlayer } from './city';

/**
 * Peaceful victory population target: 8,000 housed residents.
 *
 * Why 8,000 — a genuinely large, thriving city, not a quick milestone:
 * an apartment block houses 30 (3×3 footprint), so 8,000 ≈ 267
 * apartments ≈ 2,400 city-grid cells — under 4% of the 256×256 grid.
 * Reachable by a focused builder in a long game without painting the
 * whole map; trivially reachable numbers (1–2k) would fire on any
 * decent start and teach nothing. The housing math is pinned in
 * tests/sim.peaceful.test.ts so a def rebalance that moves the goal
 * breaks the suite loudly instead of silently re-tuning victory.
 */
export const PEACEFUL_VICTORY_POPULATION = 8000;

/**
 * Peaceful victory treasury floor: funds >= 0.
 *
 * Every funds spend path in the sim is affordability-gated
 * (validate-at-enqueue + the upkeep funding cap), so the treasury
 * cannot go negative in normal play — this is a cheap honesty guard
 * against pathological states (e.g. cheats, future debt mechanics),
 * not the binding constraint. The binding constraint is population.
 */
export const PEACEFUL_VICTORY_MIN_TREASURY = 0;

/** Progress view for the peaceful-mode UI panel (the sibling workstream's). */
export interface PeacefulObjectiveProgress {
  /** The owner's current housed population (`player.population`). */
  population: number;
  /** The victory target (`PEACEFUL_VICTORY_POPULATION`). */
  target: number;
  /** True when the treasury is at or above the floor. */
  treasuryOk: boolean;
  /** True when both conditions hold — the panel's "victory" state. */
  achieved: boolean;
}

/**
 * Peaceful objective progress for one owner. Pure function of world
 * state. A missing player record (e.g. a hand-built fixture) reports
 * zero progress — never throws.
 */
export function peacefulObjectiveProgress(world: World, owner: number): PeacefulObjectiveProgress {
  const player = getPlayer(world.city, owner);
  const population = player?.population ?? 0;
  const treasuryOk = (player?.funds ?? -1) >= PEACEFUL_VICTORY_MIN_TREASURY;
  const achieved =
    population >= PEACEFUL_VICTORY_POPULATION && treasuryOk;
  return {
    population,
    target: PEACEFUL_VICTORY_POPULATION,
    treasuryOk,
    achieved,
  };
}

/**
 * Peaceful victory check (deterministic): true when `owner` has reached
 * the population target with a non-negative treasury. Pure function of
 * world state — no wall clock, no RNG. Callers should only check when
 * `world.peaceful` is true; in non-peaceful games the conquest checks
 * own the outcome. (The check does NOT require peaceful itself — that
 * keeps the pure sim predicate testable in isolation; the UI routes
 * which victory system applies.)
 */
export function checkPeacefulVictory(world: World, owner: number): boolean {
  return peacefulObjectiveProgress(world, owner).achieved;
}
