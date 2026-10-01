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
 * NOVATERRA — peaceful-mode UI tests (grand-expansion Phase 8,
 * workstream B).
 * Headless coverage for the peaceful UI contract module
 * (game/src/ui/peaceful.ts) plus the peaceful gates it drives:
 *  - the skirmish-setup toggle end-to-end: `createSession({ peaceful:
 *    true })` sets `world.peaceful` (default sessions are not peaceful),
 *  - `menuTabsForWorld` hides the Military tab in peaceful worlds,
 *  - the status lines render the live values (population, treasury
 *    status) — no target, no rival line, no end-screen outcome:
 *    peaceful mode is endless (2026-10-01),
 *  - the research-group no-drift invariant: the military-flag partition
 *    over UPGRADE_GROUPS never drifts silently (the peaceful lockout is
 *    keyed off the def flag, never the visual group),
 *  - the palette availability lockout: military defs grey out with
 *    "Not available in peaceful mode" in peaceful worlds and behave
 *    exactly as before when the world is not peaceful,
 *  - the digest `po:` segment on the Management tab: present with the
 *    live numbers in peaceful worlds, `po:x` otherwise, and moving when
 *    the population moves.
 *
 * DOM rendering itself (hud.ts) cannot run under node; these tests pin
 * the pure helpers the DOM code is built on, so a regression in the
 * values shows up here first.
 */
import { describe, expect, it } from 'vitest';

import { createSession, HUMAN_PLAYER_ID, AI_PLAYER_ID } from '../src/ui/session';
import { createSelection } from '../src/ui/selection';
import { getPlayer } from '../src/sim/city';
import { UPGRADE_DEFS, type UpgradeId } from '../src/sim/upgrades';
import {
  menuTabsForWorld,
  formatCount,
  peacefulStatusLines,
} from '../src/ui/peaceful';
import {
  UPGRADE_GROUPS,
  upgradeIsMilitary,
  unitAvailability,
  buildingAvailability,
  upgradeAvailability,
} from '../src/ui/palettes';
import { STRINGS, loc } from '../src/ui/strings';
import { selectionDigest } from '../src/ui/paletteDigest';

const NO_SEL = createSelection();
const PEACEFUL_LOCKED = loc(STRINGS.palettes.peacefulLocked);

/** Set the builder's-victory inputs on a player's record directly. */
function setPeacefulInputs(
  session: ReturnType<typeof createSession>,
  owner: number,
  population: number,
  funds = 100,
): void {
  const player = getPlayer(session.world.city, owner)!;
  player.population = population;
  player.funds = funds;
}

describe('peaceful toggle end-to-end', () => {
  it('createSession({ peaceful: true }) sets world.peaceful', () => {
    const session = createSession({ seed: 7, peaceful: true });
    expect(session.world.peaceful).toBe(true);
  });

  it('default sessions are not peaceful', () => {
    const session = createSession({ seed: 7 });
    expect(session.world.peaceful).not.toBe(true);
  });
});

describe('menuTabsForWorld', () => {
  it('hides the Military tab in peaceful worlds', () => {
    expect(menuTabsForWorld(true)).toEqual(['civilian', 'management']);
  });

  it('keeps all three tabs in non-peaceful worlds', () => {
    expect(menuTabsForWorld(false)).toEqual([
      'civilian',
      'military',
      'management',
    ]);
  });
});

describe('formatCount', () => {
  it('uses deterministic thousands separators (no toLocaleString)', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(7999)).toBe('7,999');
    expect(formatCount(8000)).toBe('8,000');
    expect(formatCount(12345678)).toBe('12,345,678');
  });
});

describe('peacefulStatusLines', () => {
  it('renders population and treasury status (no target, no rival)', () => {
    const session = createSession({ seed: 11, peaceful: true });
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 7999, -5);
    setPeacefulInputs(session, AI_PLAYER_ID, 1234);
    const lines = peacefulStatusLines(session.world, HUMAN_PLAYER_ID);
    expect(lines.populationLine).toContain('7,999');
    // No victory target to measure against — endless mode.
    expect(lines.populationLine).not.toContain('8,000');
    expect(lines.populationLine).not.toContain('/');
    expect(lines.treasuryLine).toContain(
      loc(STRINGS.peaceful.treasuryBad),
    );
    // No rival line: there is no builder's race in endless mode.
    expect('rivalLine' in lines).toBe(false);
    expect('achieved' in lines).toBe(false);
  });

  it('shows the treasury-ok line when funds are non-negative', () => {
    const session = createSession({ seed: 11, peaceful: true });
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 100, 0);
    const lines = peacefulStatusLines(session.world, HUMAN_PLAYER_ID);
    expect(lines.treasuryLine).toContain(
      loc(STRINGS.peaceful.treasuryOk),
    );
  });
});

describe('research-group military no-drift invariant', () => {
  // The peaceful lockout keys off the def flag (`upgradeIsMilitary`),
  // never the visual group — but the groups must never drift away from
  // the flags either, or the research panel would show military-looking
  // upgrades as civilian (and vice versa). The war-apparatus groups are
  // military / logistics / intel; economy / infrastructure are civilian.
  const WAR_GROUPS = new Set(['military', 'logistics', 'intel']);

  it('partitions every military-flagged upgrade into the war-apparatus groups', () => {
    const seen = new Map<UpgradeId, string>();
    for (const group of UPGRADE_GROUPS) {
      for (const id of group.ids) {
        expect(seen.has(id), `upgrade ${id} appears in two groups`).toBe(
          false,
        );
        seen.set(id, group.id);
        const flagged = upgradeIsMilitary(id);
        if (WAR_GROUPS.has(group.id)) {
          expect(flagged, `${id} in ${group.id} must be military-flagged`).toBe(
            true,
          );
        } else {
          expect(
            flagged,
            `${id} in ${group.id} must NOT be military-flagged`,
          ).toBe(false);
        }
      }
    }
    const allIds = Object.keys(UPGRADE_DEFS) as UpgradeId[];
    expect(seen.size).toBe(allIds.length);
    for (const id of allIds) {
      expect(seen.has(id), `${id} is missing from UPGRADE_GROUPS`).toBe(true);
    }
  });

  it('upgradeIsMilitary agrees with the sim def flags', () => {
    expect(upgradeIsMilitary('apRounds')).toBe(true);
    expect(upgradeIsMilitary('advancedLogistics')).toBe(true);
    expect(upgradeIsMilitary('signalsIntel')).toBe(true);
    expect(upgradeIsMilitary('precisionManufacturing')).toBe(false);
  });
});

describe('peaceful palette availability lockout', () => {
  it('locks military defs in peaceful worlds with the peaceful reason', () => {
    const session = createSession({ seed: 19, peaceful: true });
    const world = session.world;
    const unit = unitAvailability(world, HUMAN_PLAYER_ID, 'rifles');
    expect(unit.ok).toBe(false);
    expect(unit.reason).toBe(PEACEFUL_LOCKED);
    const building = buildingAvailability(world, HUMAN_PLAYER_ID, 'barracks');
    expect(building.ok).toBe(false);
    expect(building.reason).toBe(PEACEFUL_LOCKED);
    const upgrade = upgradeAvailability(world, HUMAN_PLAYER_ID, 'apRounds');
    expect(upgrade.state).toBe('locked');
    expect(upgrade.reason).toBe(PEACEFUL_LOCKED);
  });

  it('leaves civilian defs untouched in peaceful worlds', () => {
    const session = createSession({ seed: 19, peaceful: true });
    const world = session.world;
    expect(
      unitAvailability(world, HUMAN_PLAYER_ID, 'hauler').reason,
    ).not.toBe(PEACEFUL_LOCKED);
    expect(
      buildingAvailability(world, HUMAN_PLAYER_ID, 'house').reason,
    ).not.toBe(PEACEFUL_LOCKED);
    expect(
      upgradeAvailability(world, HUMAN_PLAYER_ID, 'precisionManufacturing')
        .reason,
    ).not.toBe(PEACEFUL_LOCKED);
  });

  it('changes nothing in non-peaceful worlds', () => {
    const session = createSession({ seed: 19 });
    const world = session.world;
    expect(unitAvailability(world, HUMAN_PLAYER_ID, 'rifles').reason).not.toBe(
      PEACEFUL_LOCKED,
    );
    expect(
      buildingAvailability(world, HUMAN_PLAYER_ID, 'barracks').reason,
    ).not.toBe(PEACEFUL_LOCKED);
    expect(
      upgradeAvailability(world, HUMAN_PLAYER_ID, 'apRounds').reason,
    ).not.toBe(PEACEFUL_LOCKED);
  });
});

describe('peaceful digest segment (po:)', () => {
  function managementDigest(
    session: ReturnType<typeof createSession>,
  ): string {
    return selectionDigest(
      session.world,
      NO_SEL,
      'infantry',
      'housing',
      undefined,
      'management',
    );
  }

  it('carries the live numbers in peaceful worlds', () => {
    const session = createSession({ seed: 23, peaceful: true });
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 7999);
    setPeacefulInputs(session, AI_PLAYER_ID, 1234);
    const digest = managementDigest(session);
    // Endless mode: player population + treasury flag only — no rival,
    // no target.
    expect(digest).toContain('po:7999:1');
    expect(digest).not.toContain('po:7999:1:1234');
  });

  it('emits po:x on the Management tab in non-peaceful worlds', () => {
    const session = createSession({ seed: 23 });
    expect(managementDigest(session)).toContain('po:x');
  });

  it('moves when the peaceful population moves', () => {
    const session = createSession({ seed: 23, peaceful: true });
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 100);
    const before = managementDigest(session);
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 101);
    expect(managementDigest(session)).not.toBe(before);
  });
});
