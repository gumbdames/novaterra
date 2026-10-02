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
 * NOVATERRA — fun-audit B8: rival age-ups as announced global events
 * (2026-10-02).
 *
 * Age advancement used to happen silently for the rival. Now the game
 * loop narrates every rival age-up — toast + Muse line + threat-meter
 * nudge + ping at the rival base — and the copy says the strategic
 * part out loud (they sank thousands into tech instead of army: a
 * window of opportunity).
 *
 * Pinned here:
 *  - rivalAgeUpOf (ui/session.ts): pure transition detector — null on
 *    first sighting and when nothing changed, { age, program }
 *    otherwise; never mutates sim state;
 *  - programDisplayName (ui/strings.ts): the single program-name map —
 *    all 8 programs, null → '', unknown ids pass through;
 *  - the rivalAgeUp persona event: deterministic, non-empty, carries
 *    the age and program.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { AI_PLAYER_ID, rivalAgeUpOf } from '../src/ui/session';
import { programDisplayName } from '../src/ui/strings';
import { personaLine } from '../src/muse/persona';

const SEED = 20261002;

function worldWithRivalAge(age: string, program: string | null): World {
  const world = createWorld(SEED);
  world.ages[AI_PLAYER_ID] = {
    age: age as 'industry',
    program: program as 'heavyIndustry',
    programs: {},
  };
  return world;
}

describe('rivalAgeUpOf (ui/session.ts)', () => {
  it('returns null on first sighting (no retroactive announcement)', () => {
    const world = worldWithRivalAge('industry', 'heavyIndustry');
    expect(rivalAgeUpOf(world, null)).toBeNull();
  });
  it('returns null when the rival age has not changed', () => {
    const world = worldWithRivalAge('industry', 'heavyIndustry');
    expect(rivalAgeUpOf(world, 'industry')).toBeNull();
  });
  it('detects the transition with the new age and program', () => {
    const world = worldWithRivalAge('industry', 'heavyIndustry');
    expect(rivalAgeUpOf(world, 'foundation')).toEqual({
      age: 'industry',
      program: 'heavyIndustry',
    });
  });
  it('defaults a missing rival entry to foundation (no event)', () => {
    const world = createWorld(SEED);
    expect(rivalAgeUpOf(world, 'foundation')).toBeNull();
    expect(rivalAgeUpOf(world, null)).toBeNull();
  });
  it('does not mutate sim state (no lazy age-state creation)', () => {
    const world = createWorld(SEED);
    rivalAgeUpOf(world, null);
    rivalAgeUpOf(world, 'foundation');
    expect(world.ages[AI_PLAYER_ID]).toBeUndefined();
  });
});

describe('programDisplayName (ui/strings.ts)', () => {
  it('names all eight programs', () => {
    expect(programDisplayName('fiberGrid')).toBe('Fiber Grid');
    expect(programDisplayName('signalsGrid')).toBe('Signals Grid');
    expect(programDisplayName('heavyIndustry')).toBe('Heavy Industry');
    expect(programDisplayName('greenTech')).toBe('Green Tech');
    expect(programDisplayName('cyberCommand')).toBe('Cyber Command');
    expect(programDisplayName('globalMedia')).toBe('Global Media');
    expect(programDisplayName('arsenalProgram')).toBe('Arsenal Program');
    expect(programDisplayName('prosperityProgram')).toBe('Prosperity Program');
  });
  it('null gives empty; unknown ids pass through (never blank)', () => {
    expect(programDisplayName(null)).toBe('');
    expect(programDisplayName('mysteryProgram')).toBe('mysteryProgram');
  });
});

describe('rivalAgeUp persona event', () => {
  it('is deterministic and carries the age and program', () => {
    const a = personaLine({ kind: 'rivalAgeUp', age: 'Industry', program: 'Heavy Industry' }, 4242);
    const b = personaLine({ kind: 'rivalAgeUp', age: 'Industry', program: 'Heavy Industry' }, 4242);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toContain('Industry');
    expect(a).toContain('Heavy Industry');
  });
  it('works without a program (no dangling separator)', () => {
    const line = personaLine({ kind: 'rivalAgeUp', age: 'Industry', program: '' }, 4242);
    expect(line).toContain('Industry');
    expect(line).not.toContain('()');
  });
});
