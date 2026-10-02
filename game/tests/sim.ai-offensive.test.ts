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
 * NOVATERRA — fun-audit B6: scheduled, escalating, telegraphed AI
 * offensives (2026-10-02).
 *
 * The AI runs a visible war schedule independent of contact — border
 * probes ~8 min, a genuine offensive ~15 min, an all-in ~25 min —
 * each telegraphed ~60 s ahead (the UI narrates the `telegraphed`
 * flag) and then committing an escalating force fraction through the
 * existing sight-gated siege machinery.
 *
 * Pinned here:
 *  - the schedule constants (launch ticks, telegraph lead, duration);
 *  - per-difficulty max phase (cadet: none, citizen: probes only);
 *  - telegraph flag timing (fires at launch − lead, not before);
 *  - launch sets the active phase and schedules the next telegraph;
 *  - a ceasefire DELAYS a phase (deadlines move forward, telegraph
 *    resets) but never cancels the schedule;
 *  - offensiveCommitOf: 0 when idle/expired, escalating fractions
 *    while active;
 *  - the schedule is digest-covered (sensitivity + stability) and
 *    survives a snapshot round-trip (pre-B6 snapshots re-init).
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  addAIPlayer,
  decodeAIState,
  encodeAIState,
  OFFENSIVE_COMMIT_FRACTION,
  OFFENSIVE_DURATION_TICKS,
  OFFENSIVE_MAX_PHASE,
  OFFENSIVE_PHASE_LAUNCH_TICKS,
  OFFENSIVE_TELEGRAPH_LEAD_TICKS,
  offensiveCommitOf,
  thinkOffensive,
  type AIDifficulty,
  type AIPlayerState,
} from '../src/sim/ai';
import { digestWorld } from '../src/sim/digest';

const SEED = 20261002;

function setupAI(difficulty: AIDifficulty): { world: World; ai: AIPlayerState } {
  const world = createWorld(SEED);
  addAIPlayer(world, 0, difficulty, 0, 0);
  const ai = world.ai.players[0];
  if (!ai) throw new Error('test: AI player missing');
  return { world, ai };
}

describe('B6 schedule constants', () => {
  it('launches at ~8/15/25 min on the 30 Hz tick', () => {
    expect(OFFENSIVE_PHASE_LAUNCH_TICKS[0]).toBe(8 * 60 * 30);
    expect(OFFENSIVE_PHASE_LAUNCH_TICKS[1]).toBe(15 * 60 * 30);
    expect(OFFENSIVE_PHASE_LAUNCH_TICKS[2]).toBe(25 * 60 * 30);
  });
  it('telegraphs a full minute ahead; phases push for five minutes', () => {
    expect(OFFENSIVE_TELEGRAPH_LEAD_TICKS).toBe(60 * 30);
    expect(OFFENSIVE_DURATION_TICKS).toBe(5 * 60 * 30);
  });
  it('cadet never schedules; citizen probes only', () => {
    expect(OFFENSIVE_MAX_PHASE['cadet']).toBe(0);
    expect(OFFENSIVE_MAX_PHASE['citizen']).toBe(1);
    expect(OFFENSIVE_MAX_PHASE['commander']).toBe(3);
    expect(OFFENSIVE_MAX_PHASE['general']).toBe(3);
    expect(OFFENSIVE_MAX_PHASE['marshal']).toBe(3);
  });
  it('commit fraction escalates per phase', () => {
    expect(OFFENSIVE_COMMIT_FRACTION[1]).toBeLessThan(OFFENSIVE_COMMIT_FRACTION[2] ?? 1);
    expect(OFFENSIVE_COMMIT_FRACTION[2]).toBeLessThan(OFFENSIVE_COMMIT_FRACTION[3] ?? 1);
    expect(OFFENSIVE_COMMIT_FRACTION[3]).toBeLessThanOrEqual(1);
  });
});

describe('thinkOffensive scheduling', () => {
  it('initializes the schedule on the first think', () => {
    const { world, ai } = setupAI('commander');
    expect(ai.offensive).toBeUndefined();
    thinkOffensive(world, ai);
    expect(ai.offensive).toMatchObject({
      nextPhase: 1,
      launchTick: 8 * 60 * 30,
      telegraphTick: 8 * 60 * 30 - 60 * 30,
      telegraphed: false,
      activePhase: 0,
    });
  });
  it('cadet never gets a schedule', () => {
    const { world, ai } = setupAI('cadet');
    world.tick = 100000;
    thinkOffensive(world, ai);
    expect(ai.offensive).toBeUndefined();
  });
  it('fires the telegraph exactly at launch − lead', () => {
    const { world, ai } = setupAI('commander');
    thinkOffensive(world, ai);
    const o = ai.offensive;
    if (!o) throw new Error('test: schedule missing');
    world.tick = o.telegraphTick - 1;
    thinkOffensive(world, ai);
    expect(ai.offensive?.telegraphed).toBe(false);
    world.tick = o.telegraphTick;
    thinkOffensive(world, ai);
    expect(ai.offensive?.telegraphed).toBe(true);
    // Still not launched.
    expect(ai.offensive?.activePhase).toBe(0);
  });
  it('launches the phase at its tick and schedules the next telegraph', () => {
    const { world, ai } = setupAI('commander');
    thinkOffensive(world, ai);
    world.tick = 8 * 60 * 30;
    thinkOffensive(world, ai);
    const o = ai.offensive;
    if (!o) throw new Error('test: schedule missing');
    expect(o.activePhase).toBe(1);
    expect(o.activeUntilTick).toBe(world.tick + OFFENSIVE_DURATION_TICKS);
    expect(o.nextPhase).toBe(2);
    expect(o.launchTick).toBe(15 * 60 * 30);
    expect(o.telegraphTick).toBe(15 * 60 * 30 - OFFENSIVE_TELEGRAPH_LEAD_TICKS);
    expect(o.telegraphed).toBe(false);
  });
  it('expires the active phase after its duration', () => {
    const { world, ai } = setupAI('commander');
    thinkOffensive(world, ai);
    world.tick = 8 * 60 * 30;
    thinkOffensive(world, ai);
    expect(ai.offensive?.activePhase).toBe(1);
    const until = ai.offensive?.activeUntilTick ?? 0;
    world.tick = until;
    thinkOffensive(world, ai);
    expect(ai.offensive?.activePhase).toBe(0);
  });
  it('exhausts the citizen schedule after its single probe', () => {
    const { world, ai } = setupAI('citizen');
    thinkOffensive(world, ai);
    world.tick = 8 * 60 * 30;
    thinkOffensive(world, ai);
    expect(ai.offensive?.activePhase).toBe(1);
    expect(ai.offensive?.nextPhase).toBe(4);
    // No further telegraphs or launches, even far in the future.
    world.tick = 100000;
    thinkOffensive(world, ai);
    expect(ai.offensive?.telegraphed).toBe(false);
    expect(ai.offensive?.activePhase).toBe(0);
  });
  it('a ceasefire delays the phase but never cancels the schedule', () => {
    const { world, ai } = setupAI('commander');
    thinkOffensive(world, ai);
    const before = { ...(ai.offensive as object) } as {
      launchTick: number;
      telegraphTick: number;
    };
    // Jump to the launch tick first, THEN hold a ceasefire: deadlines
    // move forward, nothing launches.
    world.tick = before.launchTick;
    world.diplomacy.ceasefireUntilTick = world.tick + 5000;
    thinkOffensive(world, ai);
    const o = ai.offensive;
    if (!o) throw new Error('test: schedule missing');
    expect(o.launchTick).toBeGreaterThan(before.launchTick);
    expect(o.telegraphTick).toBe(o.launchTick - OFFENSIVE_TELEGRAPH_LEAD_TICKS);
    expect(o.telegraphed).toBe(false);
    expect(o.activePhase).toBe(0);
    expect(o.nextPhase).toBe(1); // still pending — delayed, not cancelled
  });
  it('the delayed phase still telegraphs and launches after the ceasefire', () => {
    const { world, ai } = setupAI('commander');
    thinkOffensive(world, ai);
    world.tick = 8 * 60 * 30; // the launch tick...
    world.diplomacy.ceasefireUntilTick = world.tick + 5000; // ...but a ceasefire holds
    thinkOffensive(world, ai);
    expect(ai.offensive?.activePhase).toBe(0); // delayed, not launched
    // Ceasefire over: the pushed deadlines still fire in order.
    world.diplomacy.ceasefireUntilTick = 0;
    const o = ai.offensive;
    if (!o) throw new Error('test: schedule missing');
    world.tick = o.telegraphTick;
    thinkOffensive(world, ai);
    expect(ai.offensive?.telegraphed).toBe(true);
    world.tick = o.launchTick;
    thinkOffensive(world, ai);
    expect(ai.offensive?.activePhase).toBe(1);
  });
});

describe('offensiveCommitOf', () => {
  it('is 0 with no schedule, and 0 after the phase expires', () => {
    const { world, ai } = setupAI('commander');
    expect(offensiveCommitOf(world, ai)).toBe(0);
    thinkOffensive(world, ai);
    world.tick = 8 * 60 * 30;
    thinkOffensive(world, ai);
    const until = ai.offensive?.activeUntilTick ?? 0;
    expect(offensiveCommitOf(world, ai)).toBeGreaterThan(0);
    world.tick = until;
    expect(offensiveCommitOf(world, ai)).toBe(0);
  });
  it('returns the escalating per-phase fraction while active', () => {
    const { world, ai } = setupAI('commander');
    thinkOffensive(world, ai);
    for (const phase of [1, 2, 3] as const) {
      const o = ai.offensive;
      if (!o) throw new Error('test: schedule missing');
      o.activePhase = phase;
      o.activeUntilTick = world.tick + 1000;
      expect(offensiveCommitOf(world, ai)).toBe(OFFENSIVE_COMMIT_FRACTION[phase]);
    }
  });
});

describe('B6 digest + snapshot coverage', () => {
  it('is digest-sensitive: schedule state changes the digest', () => {
    const a = setupAI('commander');
    const b = setupAI('commander');
    thinkOffensive(a.world, a.ai);
    thinkOffensive(b.world, b.ai);
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
    a.world.tick = 8 * 60 * 30;
    thinkOffensive(a.world, a.ai);
    expect(digestWorld(a.world)).not.toBe(digestWorld(b.world));
  });
  it('survives an encode/decode round-trip; pre-B6 snapshots re-init', () => {
    const { world, ai } = setupAI('commander');
    world.tick = 8 * 60 * 30;
    thinkOffensive(world, ai);
    thinkOffensive(world, ai);
    const encoded = encodeAIState(world.ai) as {
      players: Array<Record<string, unknown>>;
    };
    const decoded = decodeAIState(encoded);
    const ai2 = decoded.players[0];
    if (!ai2) throw new Error('test: decoded AI missing');
    expect(ai2.offensive).toMatchObject({
      nextPhase: 2,
      activePhase: 1,
      telegraphed: false,
    });
    // The decoded schedule is a copy, not an alias (phase9 lesson).
    (ai2.offensive as { nextPhase: number }).nextPhase = 99;
    expect(ai.offensive?.nextPhase).toBe(2);

    // Pre-B6 snapshot: no offensive field → undefined → re-inits.
    const { ai: ai3 } = setupAI('commander');
    const encoded3 = encodeAIState({ players: [ai3] }) as {
      players: Array<Record<string, unknown>>;
    };
    delete encoded3.players[0]!['offensive'];
    const decoded3 = decodeAIState(encoded3);
    const ai4 = decoded3.players[0];
    if (!ai4) throw new Error('test: decoded AI missing');
    expect(ai4.offensive).toBeUndefined();
    // ...and the schedule (re)initializes on the next think.
    world.tick = 0;
    thinkOffensive(world, ai4);
    expect(ai4.offensive?.nextPhase).toBe(1);
  });
});
