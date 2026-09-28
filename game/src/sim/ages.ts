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
 * NOVATERRA — sim/ages.ts — Ages (Foundation → Connectivity) + National Program choice.
 *
 * Design (docs/research/game-design.md §C5):
 *  - Ages are development stages of the player's nation within the fixed
 *    2026 setting, not calendar years.
 *  - Age-ups are commitment choices with real costs (Age of Empires
 *    lineage): advancing costs resources and leaves you vulnerable if
 *    timed poorly.
 *  - **Foundation** (Age 1): the starting age. Unlocks roads, zoning,
 *    power/water, infantry, patrol boats.
 *  - **Connectivity** (Age 2): advance by picking 1 National Program —
 *    **Fiber Grid** (economy: +bandwidth, digital firms, economic bonuses)
 *    or **Signals Grid** (intel: listening posts, recon drones, intel
 *    bonuses). Unlocks universities, trade port, fighters, destroyers.
 *    (Navy arrives in Phase 1.5 — the naval unlocks are gated behind a
 *    "not yet available" marker, not implemented here.)
 *  - The choice is permanent for the game (landmark-style decision).
 *    Both programs are viable; the tradeoff must be real, not a no-brainer.
 *
 * Effects (Phase 1 engineering choices, not locked design):
 *  - Fiber Grid: +25% tax income (funds). Rewards economic play.
 *  - Signals Grid: +8 sight range for all units. Rewards intel/scouting play.
 *
 * State is plain JSON-safe data, snapshotted (v5) and digested.
 * No RNG needed — the age-up is a pure player decision.
 *
 * Pure module: no DOM, no three.js, no wall clock, no Math.random.
 * Safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue } from './commands';
import { getPlayer } from './city';

/** Development stages of the player's nation (fixed 2026 setting). */
export type Age = 'foundation' | 'connectivity';

/** The permanent National Program choice. Null until Connectivity is chosen. */
export type NationalProgram = 'fiberGrid' | 'signalsGrid' | null;

/** Age state for the world. Plain data — snapshotted + digested. */
export interface AgeState {
  /** Current age. Starts at 'foundation'. */
  age: Age;
  /** The chosen National Program. Null in Foundation. */
  program: NationalProgram;
}

/** Create fresh age state: Foundation, no program chosen. */
export function initAges(): AgeState {
  return { age: 'foundation', program: null };
}

/** Cost to advance from Foundation to Connectivity (funds + materials). */
export const CONNECTIVITY_COST = {
  funds: 3000,
  materials: 1200,
} as const;

/** Fiber Grid: tax income multiplier (+25% funds from taxes). */
export const FIBER_GRID_TAX_MULTIPLIER = 1.25;

/** Signals Grid: bonus sight range for all units (+8 world units). */
export const SIGNALS_GRID_SIGHT_BONUS = 8;

/**
 * Tax income multiplier for the world. Returns 1.25 with Fiber Grid,
 * 1.0 otherwise.
 */
export function getTaxMultiplier(world: World): number {
  const ages = world.ages;
  if (ages.age === 'connectivity' && ages.program === 'fiberGrid') {
    return FIBER_GRID_TAX_MULTIPLIER;
  }
  return 1.0;
}

/**
 * Sight range bonus for the world. Returns 8 with Signals Grid,
 * 0 otherwise.
 */
export function getSightBonus(world: World): number {
  const ages = world.ages;
  if (ages.age === 'connectivity' && ages.program === 'signalsGrid') {
    return SIGNALS_GRID_SIGHT_BONUS;
  }
  return 0;
}

/**
 * Check if a unit kind is available at the world's current age.
 * Used by spawn validation and the AI's spawn choices.
 */
export function isUnitAvailableForAge(world: World, minAge: Age): boolean {
  if (minAge === 'foundation') return true;
  return world.ages.age === 'connectivity';
}

/** Register the `advanceAge` command. */
export function registerAgeCommands(queue: CommandQueue): void {
  queue.register('advanceAge', {
    validate(cmd, world): string | null {
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'advanceAge: payload.owner must be an integer';
      }
      const player = getPlayer(world.city, owner);
      if (!player) {
        return 'advanceAge: unknown owner';
      }
      // Can only advance from Foundation (no Age 3 in Phase 1).
      if (world.ages.age !== 'foundation') {
        return `advanceAge: already at ${world.ages.age}, cannot advance further in Phase 1`;
      }
      // Program choice is required for Connectivity.
      const program = cmd.payload['program'];
      if (program !== 'fiberGrid' && program !== 'signalsGrid') {
        return "advanceAge: program must be 'fiberGrid' or 'signalsGrid'";
      }
      // Must afford the cost.
      if (player.funds < CONNECTIVITY_COST.funds) {
        return `advanceAge: cannot afford ${CONNECTIVITY_COST.funds} funds (have ${player.funds.toFixed(0)})`;
      }
      if (player.materials < CONNECTIVITY_COST.materials) {
        return `advanceAge: cannot afford ${CONNECTIVITY_COST.materials} materials (have ${player.materials.toFixed(0)})`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = cmd.payload['owner'] as number;
      const program = cmd.payload['program'] as 'fiberGrid' | 'signalsGrid';
      const player = getPlayer(world.city, owner);
      if (!player) {
        throw new Error('advanceAge: unknown owner at apply');
      }
      // Re-check affordability at apply (state may have changed since enqueue).
      if (player.funds < CONNECTIVITY_COST.funds || player.materials < CONNECTIVITY_COST.materials) {
        throw new Error('advanceAge: cannot afford the cost at apply time');
      }
      if (world.ages.age !== 'foundation') {
        throw new Error('advanceAge: already advanced at apply time');
      }
      player.funds -= CONNECTIVITY_COST.funds;
      player.materials -= CONNECTIVITY_COST.materials;
      world.ages.age = 'connectivity';
      world.ages.program = program;
      return { age: 'connectivity', program };
    },
  });
}

/**
 * Canonical JSON-safe encoding of age state for snapshots and digests.
 */
export function encodeAgeState(ages: AgeState): unknown {
  return { age: ages.age, program: ages.program };
}

/** Restore age state from a snapshot payload (see snapshot.ts). */
export function decodeAgeState(data: unknown): AgeState {
  const d = data as { age: Age; program: NationalProgram };
  return {
    age: d.age === 'connectivity' ? 'connectivity' : 'foundation',
    program: d.program === 'fiberGrid' || d.program === 'signalsGrid' ? d.program : null,
  };
}
