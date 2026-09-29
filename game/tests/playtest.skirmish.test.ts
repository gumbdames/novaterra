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
 * NOVATERRA — automated skirmish playtest (Phase 1, step 12).
 *
 * A headless smoke test for the whole game loop: sim + Classic AI + ages +
 * economy running together for a full game-minute. Asserts the game does not
 * crash, does not produce NaNs, the AI actually plays (builds units), and
 * resources stay sane. This is the closest CI gets to "is it fun and
 * bug-free" without a human.
 */
import { describe, expect, it } from 'vitest';

import type { World } from '../src/sim/world';
import { createSession } from '../src/ui/session';

/** Walk the world and collect every numeric value that must never be NaN. */
function findNaNs(world: World): string[] {
  const bad: string[] = [];
  const check = (path: string, v: unknown): void => {
    if (typeof v === 'number' && Number.isNaN(v)) bad.push(path);
  };

  for (const u of world.units) {
    check(`unit#${u.id}.x`, u.x);
    check(`unit#${u.id}.z`, u.z);
    check(`unit#${u.id}.hp`, u.hp);
    check(`unit#${u.id}.speed`, u.speed);
    check(`unit#${u.id}.cooldownLeft`, u.cooldownLeft);
  }
  for (const p of world.city.players) {
    check(`player#${p.id}.funds`, p.funds);
    check(`player#${p.id}.materials`, p.materials);
    check(`player#${p.id}.fuel`, p.fuel);
    check(`player#${p.id}.food`, p.food);
    check(`player#${p.id}.research`, p.research);
  }
  check('world.tick', world.tick);
  check('world.time', world.time);
  return bad;
}

/**
 * Run a full skirmish vs the given AI difficulty for `ticks` ticks.
 * Returns the session for assertions.
 */
function runSkirmish(seed: number, ticks: number) {
  const session = createSession({ seed, aiDifficulty: 'cadet' });
  for (let t = 0; t < ticks; t++) {
    session.tick();
  }
  return session;
}

describe('automated skirmish playtest (vs cadet)', () => {
  it('runs 60 game-seconds without crashing or producing NaNs', () => {
    const session = runSkirmish(1234, 1800); // 1800 ticks = 60s at 30Hz
    const world = session.world;

    // The game advanced.
    expect(world.tick).toBe(1801); // +1 from the setup tick in createSession

    // No NaNs anywhere in the critical state.
    expect(findNaNs(world)).toEqual([]);

    // Both armies still exist (cadet is passive; nothing should have died
    // en masse, and the AI should have built more).
    const humanUnits = world.units.filter((u) => u.owner === 0);
    const aiUnits = world.units.filter((u) => u.owner === 1);
    expect(humanUnits.length).toBeGreaterThan(0);
    expect(aiUnits.length).toBeGreaterThan(0);
  });

  it('the cadet AI actually plays: it builds units over time', () => {
    const session = createSession({ seed: 1234, aiDifficulty: 'cadet' });
    const before = session.world.units.filter((u) => u.owner === 1).length;
    // Cadet starts with 2 units (below its cap of 4) so it has room to build.
    expect(before).toBe(2);

    for (let t = 0; t < 1800; t++) session.tick();

    const aiPlayer = session.world.ai.players.find((p) => p.owner === 1);
    expect(aiPlayer).toBeDefined();
    const built = Object.values(aiPlayer!.builtCounts).reduce((s, n) => s + n, 0);
    // Cadet trickles units up to its cap (6) on a 240-tick cadence:
    // 1800 ticks = ~7 think cycles, starting from 2 units.
    expect(built).toBeGreaterThan(0);
    const after = session.world.units.filter((u) => u.owner === 1).length;
    expect(after).toBeGreaterThan(before);
    expect(after).toBeLessThanOrEqual(6);
  });

  it('resources stay sane: no negative stockpiles, no runaway inflation', () => {
    const session = runSkirmish(1234, 1800);
    for (const p of session.world.city.players) {
      expect(p.funds).toBeGreaterThanOrEqual(0);
      expect(p.materials).toBeGreaterThanOrEqual(0);
      expect(p.fuel).toBeGreaterThanOrEqual(0);
      expect(p.food).toBeGreaterThanOrEqual(0);
      // Sanity cap: nothing should 100x the starting stockpile in 60s.
      expect(p.funds).toBeLessThan(4000 * 100);
      expect(p.materials).toBeLessThan(1500 * 100);
    }
  });

  it('the full loop is deterministic: same seed, same digest', () => {
    const a = runSkirmish(999, 900);
    const b = runSkirmish(999, 900);
    expect(a.digest()).toBe(b.digest());
  });

  it('a longer 3-minute game stays healthy (AI, economy, combat together)', () => {
    // 5400 ticks = 3 game-minutes. Slower test, but exercises the AI's
    // full decision ladder and the economy over a realistic session slice.
    const session = runSkirmish(777, 5400);
    const world = session.world;

    expect(findNaNs(world)).toEqual([]);
    expect(world.units.length).toBeGreaterThan(0);

    // The cadet AI should have built up to its cap (6) by now.
    const aiUnits = world.units.filter((u) => u.owner === 1);
    expect(aiUnits.length).toBeGreaterThan(2);
    expect(aiUnits.length).toBeLessThanOrEqual(6);

    for (const p of world.city.players) {
      expect(p.funds).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.funds)).toBe(true);
    }
  });
});
