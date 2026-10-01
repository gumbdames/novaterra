/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of GNU Affero General Public License as published
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
 * NOVATERRA — sim/peaceful.ts — peaceful-mode status (grand-expansion
 * Phase 8, workstream A, 2026-09-30; endless revision, 2026-10-01).
 *
 * Responsibilities:
 *  - The peaceful-mode status readout as a SIM-side pure check:
 *    `peacefulStatus(world, owner)` (housed population + treasury
 *    health). Pure function of world state — no wall clock, no RNG.
 *
 * Final-review (2026-10-01): peaceful mode is ENDLESS — there is no
 * victory condition. The old builder's-race victory (`checkPeacefulVictory`
 * / `peacefulObjectiveProgress`, 8,000 residents) was removed: a
 * peaceful world never ends, it just keeps simulating. The UI shows
 * the status (population, treasury) as information, not as progress
 * toward a goal; there is no end screen, no rival race, no defeat.
 *
 * Non-goals (explicit):
 *  - No "influence" system exists in 0.1 Alpha — none is invented here.
 *  - No defeat path: with every military def locked out, conquest is
 *    unreachable in a peaceful world, so peaceful games can only be
 *    played, never won or lost (documented in the research note).
 *  - Showing the status is UI work: the UI panel consumes
 *    `peacefulStatus`; `ui/session.ts`'s conquest checks are bypassed
 *    for peaceful worlds (`getSkirmishOutcome` returns null), and
 *    `ui/game.ts` shows no end screen for them.
 *
 * Import discipline: value-imports only city.ts (`getPlayer`); city.ts
 * never imports this module, so no cycle. Pure module: no DOM, no
 * three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import { getPlayer } from './city';

/** Status view for the peaceful-mode UI panel. */
export interface PeacefulStatus {
  /** The owner's current housed population (`player.population`). */
  population: number;
  /** True when the treasury is non-negative. */
  treasuryOk: boolean;
}

/**
 * Peaceful status for one owner. Pure function of world state. A
 * missing player record (e.g. a hand-built fixture) reports zero
 * population — never throws.
 *
 * This is a STATUS readout, not a victory check: peaceful mode is
 * endless (2026-10-01) and there is no target to reach, no "achieved"
 * flag, no end screen. The panel shows how the city is doing; the
 * game never declares it finished.
 */
export function peacefulStatus(world: World, owner: number): PeacefulStatus {
  const player = getPlayer(world.city, owner);
  return {
    population: player?.population ?? 0,
    treasuryOk: (player?.funds ?? -1) >= 0,
  };
}
