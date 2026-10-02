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
import { BUILDING_DEFS, getPlayer } from '../sim/city';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { CONNECTIVITY_COST, getAgeState } from '../sim/ages';
import { isSabotaged, isSpyUnit } from '../sim/intel';
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
/** Fuel below this triggers the fuel diagnosis (B14). */
export const ADVISOR_FUEL_LOW = 100;

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

  // Roadmap B14 (2026-10-02): fuel diagnosis — not just "fuel is low"
  // but WHY. Root causes in order: nothing produces fuel (no working
  // refinery), refineries exist but are unpowered, or demand simply
  // outstrips refining (power plants burn fuel too).
  if (player.fuel < ADVISOR_FUEL_LOW) {
    const refineries = world.city.buildings.filter(
      (b) =>
        b.owner === playerId &&
        b.progress >= 1 &&
        (BUILDING_DEFS[b.kind].output?.fuel ?? 0) > 0,
    );
    const working = refineries.filter(
      (b) =>
        b.operational &&
        b.powerDiag !== 'shortage' &&
        b.powerDiag !== 'disconnected',
    );
    const cause =
      refineries.length === 0
        ? s.fuelNoRefinery
        : working.length === 0
          ? s.fuelRefineryUnpowered
          : s.fuelDemandHigh;
    items.push({
      severity: 'warning',
      title: s.fuelLow,
      detail: `${Math.max(0, Math.floor(player.fuel))} fuel — ${cause}`,
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

  // Power: completed buildings without power work at reduced strength.
  // (Tutorial A3, 2026-10-01: M1 promises "watch the advisor for
  // shortages" — the advisor must actually cover utilities.)
  // Roadmap B14 (2026-10-02): root-cause detail — when no plant works
  // at all, say so instead of just pointing at the wires.
  const unpowered = world.city.buildings.filter((b) => {
    if (b.owner !== playerId || !b.operational) return false;
    return b.powerDiag === 'shortage' || b.powerDiag === 'disconnected';
  }).length;
  if (unpowered > 0) {
    const plants = world.city.buildings.filter(
      (b) =>
        b.owner === playerId &&
        b.progress >= 1 &&
        b.operational &&
        BUILDING_DEFS[b.kind].powerSupply > 0,
    ).length;
    items.push({
      severity: 'warning',
      title: s.powerShortage,
      detail: `${unpowered} buildings — ${plants === 0 ? s.powerNoPlantDetail : s.powerShortageDetail}`,
    });
  }

  // Water: completed buildings without water work at reduced strength.
  // B14: same root-cause treatment as power.
  const unwatered = world.city.buildings.filter((b) => {
    if (b.owner !== playerId || !b.operational) return false;
    return b.waterDiag === 'shortage' || b.waterDiag === 'disconnected';
  }).length;
  if (unwatered > 0) {
    const pumps = world.city.buildings.filter(
      (b) =>
        b.owner === playerId &&
        b.progress >= 1 &&
        b.operational &&
        BUILDING_DEFS[b.kind].waterSupply > 0,
    ).length;
    items.push({
      severity: 'warning',
      title: s.waterShortage,
      detail: `${unwatered} buildings — ${pumps === 0 ? s.waterNoPumpDetail : s.waterShortageDetail}`,
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

  // Roadmap B14 (2026-10-02): stranded aircraft — a fossil-fuel plane
  // with an empty tank goes nowhere on its own. Critical, because the
  // plane is effectively lost without action, and nothing else points
  // at Emergency Refuel (the R5 order that saves it).
  const stranded = world.units.filter((u) => {
    if (u.owner !== playerId || u.hp <= 0 || u.domain !== 'air') return false;
    const def = UNIT_DEFS[u.kind as UnitKind];
    return def?.fuelType === 'fossil' && (u.fuel ?? 0) <= 0;
  }).length;
  if (stranded > 0) {
    items.push({
      severity: 'critical',
      title: s.aircraftStranded,
      detail: `${stranded} stranded — ${s.aircraftStrandedDetail}`,
    });
  }

  // Roadmap B14 (2026-10-02): sabotage — the building stops working and
  // the cause is invisible on the map. Name it and point at the counter.
  const sabotaged = world.city.buildings.filter(
    (b) => b.owner === playerId && isSabotaged(b, world.tick),
  ).length;
  if (sabotaged > 0) {
    items.push({
      severity: 'warning',
      title: s.sabotageActive,
      detail: `${sabotaged} ${sabotaged === 1 ? 'building' : 'buildings'} — ${s.sabotageActiveDetail}`,
    });
  }

  // Roadmap B14 (2026-10-02): burned spy — a spotted spy reports nothing
  // and will be captured; the player should extract or replace it.
  const burned = world.units.filter(
    (u) =>
      u.owner === playerId &&
      u.hp > 0 &&
      isSpyUnit(u) &&
      (u.spottedUntil ?? 0) > world.tick,
  ).length;
  if (burned > 0) {
    items.push({
      severity: 'warning',
      title: s.spyBurned,
      detail: `${burned} ${burned === 1 ? 'spy' : 'spies'} — ${s.spyBurnedDetail}`,
    });
  }

  // Opportunity: the age advance is affordable (informational only).
  if (
    getAgeState(world, playerId).age === 'foundation' &&
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
