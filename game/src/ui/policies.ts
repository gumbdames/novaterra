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
 * NOVATERRA — ui/policies.ts — workstream E UI contract
 * (pure, headless-safe).
 *
 * Responsibilities:
 *  - The single choke point between the UI layer and the sim's civilian
 *    ordinances (sim/city.ts PolicyId / POLICIES / POLICY_IDS /
 *    policyFunded): the Management tab's "City ordinances" section —
 *    one row per policy with its upkeep cost, effect line, on/off state,
 *    and whether the treasury is actually funding it this tick.
 *  - Reads every sim field defensively (empty pre-sim → empty view),
 *    never writes sim state. Toggles are emitted as `setPolicy` orders
 *    via orders.ts `buildSetPolicyOrder` — the UI never re-implements
 *    sim validation; the sim's plain-English rejection strings are
 *    wrapped/displayed.
 *
 * SIM CONTRACT (workstream E sim workstream — VERIFIED 2026-09-30
 * against the sim's committed code; names match exactly):
 *  - `POLICY_IDS: readonly PolicyId[]` (fixed order: greenInitiative,
 *    transitSubsidy, businessIncentives, nightlife, educationGrants).
 *  - `POLICIES: Record<PolicyId, PolicyDef>` — `{ upkeepFundsPerSec }`.
 *  - `PlayerState.policies: Partial<Record<PolicyId, boolean>>`
 *    (snapshotted; absent/legacy → `{}`).
 *  - `PlayerState.fundedPolicies: PolicyId[]` — DERIVED per-tick
 *    (economy `allocateUtilities` pass 1), never snapshotted/digested.
 *  - `policyFunded(world, owner, id)` — the single effect gate.
 *  - `STRINGS.policies` carries the section title/subtitle, per-policy
 *    name + effect lines, the upkeep line template, and the
 *    funded/unfunded status lines.
 */

import type { World } from '../sim/world';
import {
  POLICIES,
  POLICY_IDS,
  getPlayer,
  type PolicyId,
} from '../sim/city';
import { STRINGS, fillLoc, loc } from './strings';

/** One row of the Management tab's "City ordinances" section. */
export interface PolicyRow {
  /** The sim's PolicyId (POLICY_IDS order). */
  id: PolicyId;
  /** Display name, e.g. "Green Initiative". */
  name: string;
  /** One-line effect description. */
  effect: string;
  /** Upkeep cost in funds/sec (the sim's POLICIES table). */
  upkeep: number;
  /** The toggle is on (the player's stated intent). */
  on: boolean;
  /**
   * The treasury funded this policy this tick (effects actually apply).
   * `false` when the toggle is off OR the treasury could not afford it.
   */
  funded: boolean;
  /**
   * True when the toggle is on but the treasury is not funding it —
   * the panel's "on, but unfunded" warning.
   */
  unfunded: boolean;
}

/**
 * The five ordinance rows for one owner, in POLICY_IDS order.
 * Defensive: unknown owners and legacy/absent policy maps yield five
 * off rows (the panel renders; nothing breaks pre-sim).
 */
export function policyRows(world: World | null | undefined, owner: number): PolicyRow[] {
  const player = world === null || world === undefined ? undefined : getPlayer(world.city, owner);
  const toggles = player?.policies ?? {};
  const funded = player?.fundedPolicies ?? [];
  const fundedSet = new Set<PolicyId>(funded);
  return POLICY_IDS.map((id) => {
    const strings = STRINGS.policies[id];
    const on = toggles[id] === true;
    const isFunded = fundedSet.has(id);
    return {
      id,
      name: loc(strings.name),
      effect: loc(strings.effect),
      upkeep: POLICIES[id].upkeepFundsPerSec,
      on,
      funded: isFunded,
      unfunded: on && !isFunded,
    };
  });
}

/** The upkeep cost line for one row, e.g. "0.6 funds/s upkeep". */
export function policyUpkeepLine(upkeep: number): string {
  return fillLoc(STRINGS.policies.upkeepLine, { cost: upkeep });
}

/**
 * The status line for one row: "Funded" while the treasury funds it,
 * "On, but unfunded — effects off" when the toggle is on and the
 * treasury cannot afford it, and the empty string when the toggle is
 * off (the toggle itself says enough).
 */
export function policyStatusLine(row: PolicyRow): string {
  if (row.funded) return loc(STRINGS.policies.fundedLine);
  if (row.unfunded) return loc(STRINGS.policies.unfundedLine);
  return '';
}

/**
 * The AD11 UI digest segment for the ordinances section: `oc:` +
 * per-policy on/off + funded/unfunded letters in POLICY_IDS order.
 * Always present (5 × 2 chars: on=1/off=0, funded=f/unfunded=u/off=-),
 * e.g. `oc:1f,0-,1u,0-,0-` — the panel rebuilds when any of it changes.
 * (`po:` was already claimed by workstream B's peaceful-objectives
 * section — ordinances are "city ordinances", hence `oc:`.)
 */
export function policiesPanelDigest(
  world: World | null | undefined,
  owner: number,
): string {
  return (
    'oc:' +
    policyRows(world, owner)
      .map((r) => (r.on ? '1' : '0') + (r.funded ? 'f' : r.unfunded ? 'u' : '-'))
      .join(',')
  );
}
