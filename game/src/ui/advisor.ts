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
 * NOVATERRA — ui/advisor.ts — "worst problems first".
 *
 * Responsibilities:
 *  - Read the player's slice of world state and return a prioritized list
 *    of advisor items: critical problems first, then warnings, then
 *    informational opportunities. The design rule (game-design.md A1):
 *    sessions must never become "hunt the map for what's wrong" — the
 *    advisor surfaces it.
 *  - Pure function of (world, playerId): no timers, no DOM, no memory of
 *    past evaluations. The caller decides how often to re-evaluate
 *    (every ~2 seconds is plenty; nothing here changes per tick).
 *  - Copy comes from ui/strings.ts so advisors never hardcode text.
 *
 * Thresholds are Phase 1 engineering choices, not locked design — tune
 * them, but keep the tests' trigger boundaries green.
 *
 * Pure module: safe under Node/vitest.
 */

import type { World } from '../sim/world';
import { getPlayer } from '../sim/city';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { CONNECTIVITY_COST } from '../sim/ages';
import { STRINGS } from './strings';

/** How urgently the player should look at this. */
export type AdvisorSeverity = 'critical' | 'warning' | 'info';

/** One advisor line: title + one short actionable detail. */
export interface AdvisorItem {
  severity: AdvisorSeverity;
  title: string;
  detail: string;
}

/** Severity rank for sorting (lower = worse = first). */
function severityRank(s: AdvisorSeverity): number {
  return s === 'critical' ? 0 : s === 'warning' ? 1 : 2;
}

/** Funds below this are a critical emergency. */
export const ADVISOR_FUNDS_CRITICAL = 300;
/** Materials below this trigger a warning. */
export const ADVISOR_MATERIALS_LOW = 200;
/** A unit below this hp fraction counts as "taking damage". */
export const ADVISOR_DAMAGED_FRACTION = 0.5;

/**
 * Evaluate the player's situation, worst problems first. Returns an empty
 * array only when everything is fine — callers show the "all clear" line
 * from strings in that case.
 */
export function evaluateAdvisor(world: World, playerId: number): AdvisorItem[] {
  const items: AdvisorItem[] = [];
  const player = getPlayer(world.city, playerId);
  if (!player) return items;
  const s = STRINGS.advisor;

  // Money: critical when nearly broke (can't train or build).
  if (player.funds < ADVISOR_FUNDS_CRITICAL) {
    items.push({
      severity: 'critical',
      title: s.fundsCritical,
      detail: s.fundsCriticalDetail,
    });
  }

  // Materials gate construction.
  if (player.materials < ADVISOR_MATERIALS_LOW) {
    items.push({
      severity: 'warning',
      title: s.materialsLow,
      detail: s.materialsLowDetail,
    });
  }

  // Food shortage stalls growth (set by the economy tick).
  if (world.city.foodShortage) {
    items.push({
      severity: 'critical',
      title: s.foodShortage,
      detail: s.foodShortageDetail,
    });
  }

  // Damaged units: the player is under attack or fought recently.
  const damaged = world.units.filter((u) => {
    if (u.owner !== playerId || u.hp <= 0) return false;
    const def = UNIT_DEFS[u.kind as UnitKind];
    return def !== undefined && u.hp < def.hp * ADVISOR_DAMAGED_FRACTION;
  }).length;
  if (damaged > 0) {
    items.push({
      severity: 'warning',
      title: s.unitsDamaged,
      detail: `${damaged} damaged — ${s.unitsDamagedDetail}`,
    });
  }

  // No engineers means no construction capacity.
  const engineers = world.units.filter(
    (u) => u.owner === playerId && u.hp > 0 && u.kind === 'engineer',
  ).length;
  if (engineers === 0) {
    items.push({
      severity: 'warning',
      title: s.noEngineers,
      detail: s.noEngineersDetail,
    });
  }

  // Opportunity: the age advance is affordable (informational only).
  if (
    world.ages.age === 'foundation' &&
    player.funds >= CONNECTIVITY_COST.funds &&
    player.materials >= CONNECTIVITY_COST.materials
  ) {
    items.push({
      severity: 'info',
      title: s.ageAffordable,
      detail: s.ageAffordableDetail,
    });
  }

  // Worst first; stable for equal severity (insertion order = priority).
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => severityRank(a.item.severity) - severityRank(b.item.severity) || a.index - b.index)
    .map((e) => e.item);
}
