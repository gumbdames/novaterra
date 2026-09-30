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
 * NOVATERRA — tests/ui.policies.test.ts — grand-expansion Phase 8
 * (civilian ordinances, workstream E, 2026-09-30): the Management tab's
 * "City ordinances" section contract module (ui/policies.ts).
 *
 * Covers:
 *  - `policyRows`: five rows in POLICY_IDS order; the on/funded/
 *    unfunded state machine; upkeep matches the sim's POLICIES table;
 *    defensive null-world / unknown-owner behavior,
 *  - `policyUpkeepLine` / `policyStatusLine`: the player-facing copy,
 *  - `policiesPanelDigest`: the `oc:` UI digest segment shape (2 chars
 *    per policy in POLICY_IDS order) and its change signal.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  POLICIES,
  POLICY_IDS,
  getPlayer,
  type PlayerState,
  type PolicyId,
} from '../src/sim/city';
import {
  policiesPanelDigest,
  policyRows,
  policyStatusLine,
  policyUpkeepLine,
  type PolicyRow,
} from '../src/ui/policies';

function playerOf(world: World, id: number): PlayerState {
  return getPlayer(world.city, id) as PlayerState;
}

describe('policyRows', () => {
  it('returns five rows in POLICY_IDS order', () => {
    const world = createWorld(707001);
    const rows = policyRows(world, 0);
    expect(rows.map((r) => r.id)).toEqual([...POLICY_IDS]);
    expect(rows).toHaveLength(5);
  });

  it('a fresh world yields five off rows (nothing funded, nothing unfunded)', () => {
    const world = createWorld(707011);
    for (const row of policyRows(world, 0)) {
      expect(row.on).toBe(false);
      expect(row.funded).toBe(false);
      expect(row.unfunded).toBe(false);
    }
  });

  it('is defensive: null world and unknown owner yield five off rows', () => {
    for (const rows of [policyRows(null, 0), policyRows(undefined, 0)]) {
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.on).toBe(false);
        expect(row.funded).toBe(false);
        expect(row.unfunded).toBe(false);
      }
    }
    const world = createWorld(707021);
    expect(policyRows(world, 99)).toHaveLength(5);
    expect(policyRows(world, 99).every((r) => !r.on && !r.funded && !r.unfunded)).toBe(true);
  });

  it('distinguishes on+funded from on-but-unfunded', () => {
    const world = createWorld(707031);
    const player = playerOf(world, 0);
    player.policies['greenInitiative'] = true;
    player.policies['transitSubsidy'] = true;
    player.fundedPolicies = ['greenInitiative'];
    const rows = policyRows(world, 0);
    const green = rows.find((r) => r.id === 'greenInitiative') as PolicyRow;
    const transit = rows.find((r) => r.id === 'transitSubsidy') as PolicyRow;
    expect(green.on).toBe(true);
    expect(green.funded).toBe(true);
    expect(green.unfunded).toBe(false);
    expect(transit.on).toBe(true);
    expect(transit.funded).toBe(false);
    expect(transit.unfunded).toBe(true);
  });

  it('upkeep matches the sim POLICIES table; names and effects are non-empty English', () => {
    const world = createWorld(707041);
    for (const row of policyRows(world, 0)) {
      expect(row.upkeep).toBe(POLICIES[row.id as PolicyId].upkeepFundsPerSec);
      expect(row.name.length).toBeGreaterThan(0);
      expect(row.effect.length).toBeGreaterThan(0);
    }
    expect(policyRows(world, 0)[0]!.name).toBe('Green Initiative');
  });
});

describe('policy copy lines', () => {
  it('policyUpkeepLine renders the cost', () => {
    expect(policyUpkeepLine(0.6)).toBe('0.6 funds/s upkeep');
  });

  it('policyStatusLine: funded / unfunded / off', () => {
    const world = createWorld(707051);
    const player = playerOf(world, 0);
    player.policies['businessIncentives'] = true;
    player.fundedPolicies = ['businessIncentives'];
    player.policies['nightlife'] = true;
    const rows = policyRows(world, 0);
    const funded = rows.find((r) => r.id === 'businessIncentives') as PolicyRow;
    const unfunded = rows.find((r) => r.id === 'nightlife') as PolicyRow;
    const off = rows.find((r) => r.id === 'educationGrants') as PolicyRow;
    expect(policyStatusLine(funded)).toBe('Funded');
    expect(policyStatusLine(unfunded)).toBe('On, but unfunded — effects off');
    expect(policyStatusLine(off)).toBe('');
  });
});

describe('policiesPanelDigest', () => {
  it('encodes five 2-char states in POLICY_IDS order after the oc: label', () => {
    const world = createWorld(707061);
    expect(policiesPanelDigest(world, 0)).toBe('oc:0-,0-,0-,0-,0-');
    expect(policiesPanelDigest(null, 0)).toBe('oc:0-,0-,0-,0-,0-');
  });

  it('on=1/off=0, funded=f, on-but-unfunded=u', () => {
    const world = createWorld(707071);
    const player = playerOf(world, 0);
    // POLICY_IDS order: green, transit, business, nightlife, education.
    player.policies['greenInitiative'] = true;
    player.policies['businessIncentives'] = true;
    player.fundedPolicies = ['greenInitiative'];
    expect(policiesPanelDigest(world, 0)).toBe('oc:1f,0-,1u,0-,0-');
  });

  it('changes when a toggle or funding flips (the panel rebuild signal)', () => {
    const world = createWorld(707081);
    const before = policiesPanelDigest(world, 0);
    playerOf(world, 0).policies['nightlife'] = true;
    const toggled = policiesPanelDigest(world, 0);
    expect(toggled).not.toBe(before);
    expect(toggled).toBe('oc:0-,0-,0-,1u,0-');
    playerOf(world, 0).fundedPolicies = ['nightlife'];
    expect(policiesPanelDigest(world, 0)).toBe('oc:0-,0-,0-,1f,0-');
  });
});
