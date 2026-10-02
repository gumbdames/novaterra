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
 * NOVATERRA — muse/director.ts — threat meter + trick narration
 * (Phase 2).
 *
 * Responsibilities:
 *  - `militaryValue(world, playerId)`: deterministic combat-power score
 *    for one side — living units weighted by hp × (damage + range/10).
 *    Unarmed units (haulers, transports: damage 0) contribute nothing:
 *    the meter measures threat, not headcount.
 *  - `computeThreat(world, playerId, aiId)`: 0..100, the AI's share of
 *    total military value. 50 = parity, 100 = the AI overwhelmingly
 *    outguns the player, 0 = the player dominates. No AI player (owner
 *    has no units) reads as 0 threat.
 *  - `narrateTrick(...)`: turn an observed AI maneuver into persona
 *    flavor text. The persona never reads AI intent (fairness is
 *    structural) — it narrates *observed* movement: raiders converging
 *    on the player's base become "a feint", split forces become "a
 *    pincer". The trick is in the telling; the AI itself stays fair.
 *
 * Pure functions, no DOM, no sim mutation — safe under Node/vitest.
 */

import type { World } from '../sim/world';
import { UNIT_DEFS, type UnitKind, type UnitRecord } from '../sim/units';
import { getVisibleEnemies } from '../sim/ai';

/**
 * Deterministic military value of one player's living units.
 * Unarmed units (damage 0: haulers, transports) contribute 0.
 */
export function militaryValue(world: World, playerId: number): number {
  let value = 0;
  for (const u of world.units) {
    if (u.owner !== playerId || u.hp <= 0) continue;
    value += unitMilitaryValue(u);
  }
  return value;
}

/** Military value of a single living unit record. */
export function unitMilitaryValue(u: UnitRecord): number {
  if (u.hp <= 0) return 0;
  const def = UNIT_DEFS[u.kind as UnitKind];
  if (!def || def.damage <= 0) return 0;
  return u.hp * (def.damage + def.range / 10);
}

/**
 * Threat meter 0..100: the AI's share of combined military value.
 * 50 with no armies on either side (unknown, not safe).
 *
 * Fun-audit C3 (2026-10-02, game-feel P3): the AI term counts only
 * forces VISIBLE to the player through the sim's own sight model —
 * the meter can no longer maphack an unseen army. The player's own
 * term is unchanged (you always know your own strength). When nothing
 * of the rival is visible the meter reads low: that is the honest
 * fog-of-war answer ("no visible threat"), not safety.
 */
export function computeThreat(world: World, playerId: number, aiId: number): number {
  const mine = militaryValue(world, playerId);
  // Fun-audit C3: only forces the player can actually see count —
  // getVisibleEnemies is the sim's own sight model (units + building
  // surveillance), so the meter and the shroud never disagree.
  let theirs = 0;
  for (const u of getVisibleEnemies(world, playerId)) {
    if (u.owner !== aiId) continue;
    theirs += unitMilitaryValue(u);
  }
  const total = mine + theirs;
  if (total <= 0) return 50;
  return Math.round((theirs / total) * 100);
}

export type TrickKind = 'feint' | 'pincer' | 'raid';

/**
 * Narrate an observed AI maneuver as a dirty trick. `description` is
 * concrete and observed ("6 tanks converging on your eastern towns"),
 * built by the caller from visible unit positions — never from AI
 * internal state.
 */
export function narrateTrick(kind: TrickKind, description: string): string {
  const frames: Record<TrickKind, string> = {
    feint: `a feint — ${description}, but the real push may land elsewhere`,
    pincer: `a pincer — ${description}`,
    raid: `a raid — ${description}`,
  };
  return frames[kind];
}
