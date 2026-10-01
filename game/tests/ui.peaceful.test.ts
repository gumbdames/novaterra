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

// ---------------------------------------------------------------------------
// Roadmap B1 (2026-10-02): peaceful city score + milestones + best score
// ---------------------------------------------------------------------------

import { peacefulScore, PEACEFUL_MILESTONES } from '../src/sim/peaceful';
import {
  avgDesirabilityOf,
  peacefulScoreLines,
  newlyCrossedMilestones,
  milestoneToastLine,
  loadPeacefulBest,
  savePeacefulBest,
} from '../src/ui/peaceful';

describe('peaceful digest segment (ps:)', () => {
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

  it('carries the derived score in peaceful worlds', () => {
    const session = createSession({ seed: 23, peaceful: true });
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 7999);
    const digest = managementDigest(session);
    // funds default to 100: treasury = log10(1.1)/3 ≈ 0.0138, so the
    // score is round(7999 × 1.0138) = 8109 (terrain is absent in this
    // helper, so desirability reads 0 — same as the panel's fallback).
    expect(digest).toContain('ps:8109');
  });

  it('emits ps:x on the Management tab in non-peaceful worlds', () => {
    const session = createSession({ seed: 23 });
    expect(managementDigest(session)).toContain('ps:x');
  });

  it('moves when the peaceful population moves', () => {
    const session = createSession({ seed: 23, peaceful: true });
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 100);
    const before = managementDigest(session);
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 1100);
    expect(managementDigest(session)).not.toBe(before);
  });
});

describe('peacefulScoreLines', () => {
  it('renders the score and the em-dash best when none is recorded', () => {
    const session = createSession({ seed: 31, peaceful: true });
    setPeacefulInputs(session, HUMAN_PLAYER_ID, 7999);
    const lines = peacefulScoreLines(session.world, HUMAN_PLAYER_ID, undefined, null);
    expect(lines.scoreLine).toBe('City score: 8,109');
    expect(lines.bestLine).toBe('Best score: —');
  });

  it('renders a recorded best score', () => {
    const session = createSession({ seed: 31, peaceful: true });
    const lines = peacefulScoreLines(session.world, HUMAN_PLAYER_ID, undefined, 48200);
    expect(lines.bestLine).toBe('Best score: 48,200');
  });
});

describe('avgDesirabilityOf', () => {
  it('reads 0 without terrain', () => {
    const session = createSession({ seed: 31, peaceful: true });
    expect(avgDesirabilityOf(undefined, session.world, HUMAN_PLAYER_ID)).toBe(0);
    expect(avgDesirabilityOf(null, session.world, HUMAN_PLAYER_ID)).toBe(0);
  });

  it('reads within 0..100 with the session terrain', () => {
    const session = createSession({ seed: 31, peaceful: true });
    const avg = avgDesirabilityOf(session.terrain, session.world, HUMAN_PLAYER_ID);
    expect(avg).toBeGreaterThanOrEqual(0);
    expect(avg).toBeLessThanOrEqual(100);
    // The panel and the digest see the same number for the same inputs.
    expect(avgDesirabilityOf(session.terrain, session.world, HUMAN_PLAYER_ID)).toBe(avg);
  });
});

describe('newlyCrossedMilestones', () => {
  it('reports indexes crossed but not yet seen', () => {
    expect(newlyCrossedMilestones(999, new Set())).toEqual([]);
    expect(newlyCrossedMilestones(1_000, new Set())).toEqual([0]);
    expect(newlyCrossedMilestones(60_000, new Set([0, 1]))).toEqual([2]);
    expect(newlyCrossedMilestones(60_000, new Set([0, 1, 2]))).toEqual([]);
    expect(newlyCrossedMilestones(2_000_000, new Set())).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('milestoneToastLine', () => {
  it('names the milestone and the score in English', () => {
    expect(milestoneToastLine(0, 1_234)).toBe('Milestone: Town — city score 1,234!');
    expect(milestoneToastLine(2, 52_310)).toBe('Milestone: Metropolis — city score 52,310!');
    expect(milestoneToastLine(4, 1_000_000)).toBe('Milestone: Utopia — city score 1,000,000!');
  });

  it('pins five milestone names against the five sim thresholds', () => {
    expect(STRINGS.peaceful.milestoneNames.en).toEqual([
      'Town', 'City', 'Metropolis', 'Megalopolis', 'Utopia',
    ]);
    expect(PEACEFUL_MILESTONES).toHaveLength(
      STRINGS.peaceful.milestoneNames.en.length,
    );
  });
});

describe('peaceful best score storage', () => {
  function fakeStorage(): {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    store: Map<string, string>;
  } {
    const store = new Map<string, string>();
    return {
      store,
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };
  }

  it('round-trips a best score and rejects lower ones', () => {
    const s = fakeStorage();
    expect(loadPeacefulBest(s)).toBeNull();
    expect(savePeacefulBest(1234, s)).toBe(true);
    expect(loadPeacefulBest(s)).toBe(1234);
    expect(savePeacefulBest(1000, s)).toBe(false);
    expect(loadPeacefulBest(s)).toBe(1234);
    expect(savePeacefulBest(2000, s)).toBe(true);
    expect(loadPeacefulBest(s)).toBe(2000);
  });

  it('never throws on corrupt or hostile storage', () => {
    const s = fakeStorage();
    s.setItem('novaterra.peacefulBestScore', 'not json{');
    expect(loadPeacefulBest(s)).toBeNull();
    s.setItem('novaterra.peacefulBestScore', '{"score":"lots"}');
    expect(loadPeacefulBest(s)).toBeNull();
    const hostile = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(savePeacefulBest(5, hostile)).toBe(false);
    expect(loadPeacefulBest(null)).toBeNull();
  });
});
