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
 * NOVATERRA — minimal diplomacy tests (roadmap B3, 0.1 Alpha).
 *
 * Covers the three commands (sendTribute / demandTribute /
 * proposeCeasefire) through real sessions: funds transfer, disposition
 * math, deterministic AI verdicts by difficulty/personality, the
 * ceasefire's suppression of AI attacks (no new orders, frozen
 * opportunistic fire), betrayal breaking the ceasefire, peaceful-mode
 * lockout, snapshot round-trips, and digest coverage.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PLAYER_ID,
  createSession,
  HUMAN_PLAYER_ID,
} from '../src/ui/session';
import {
  buildDemandTributeOrder,
  buildProposeCeasefireOrder,
  buildSendTributeOrder,
} from '../src/ui/orders';
import {
  CEASEFIRE_TICKS,
  CEASEFIRE_INFLUENCE_COST,
  DEMAND_TRIBUTE_INFLUENCE_COST,
  ceasefireAccepted,
  ceasefireActive,
  demandAccepted,
  initDiplomacy,
} from '../src/sim/diplomacy';
import type { AIStanding } from '../src/sim/diplomacy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { canonicalizeWorld, digestWorld } from '../src/sim/digest';
import { getPlayer } from '../src/sim/city';
import type { World } from '../src/sim/world';

const HUMAN = HUMAN_PLAYER_ID;
const AI = AI_PLAYER_ID;

function funds(world: World, owner: number): number {
  return getPlayer(world.city, owner)?.funds ?? NaN;
}

function influence(world: World, owner: number): number {
  return getPlayer(world.city, owner)?.influence ?? NaN;
}

/**
 * Fun-audit C2b (influence triage, 2026-10-02): demands and ceasefires
 * cost influence — the pre-cost tests grant a stockpile first (the
 * game starts at 0; influence comes from cultural buildings).
 */
function grantInfluence(world: World, owner: number, amount = 1000): void {
  const p = getPlayer(world.city, owner);
  if (p) p.influence = amount;
}

/** A gentle AI: low pride, middling aggression, rich treasury. */
function gentleAI(): AIStanding {
  return { difficulty: 'cadet', aggression: 0.5, funds: 100000 };
}

/** A proud AI: high pride, high aggression. */
function proudAI(): AIStanding {
  return { difficulty: 'marshal', aggression: 0.9, funds: 100000 };
}

describe('diplomacy verdicts (pure, deterministic)', () => {
  it('a small demand of a gentle AI at warm disposition is accepted', () => {
    expect(demandAccepted(70, gentleAI(), 1000)).toBe(true);
  });

  it('the same demand of a proud AI is refused (difficulty pride)', () => {
    expect(demandAccepted(70, proudAI(), 1000)).toBe(false);
  });

  it('a demand the AI cannot afford is refused regardless of disposition', () => {
    expect(demandAccepted(100, gentleAI(), 1000000)).toBe(false);
  });

  it('a ceasefire ask of a gentle AI at warm disposition is accepted', () => {
    expect(ceasefireAccepted(60, gentleAI())).toBe(true);
  });

  it('a ceasefire ask of a proud AI at cold disposition is declined', () => {
    expect(ceasefireAccepted(0, proudAI())).toBe(false);
  });

  it('verdicts are pure: identical inputs give identical answers', () => {
    const ai = { difficulty: 'commander', aggression: 0.37, funds: 4321 } as AIStanding;
    expect(demandAccepted(63, ai, 777)).toBe(demandAccepted(63, ai, 777));
    expect(ceasefireAccepted(63, ai)).toBe(ceasefireAccepted(63, ai));
  });
});

describe('sendTribute', () => {
  it('transfers funds and warms disposition (+1 per 500, capped at +20)', () => {
    const session = createSession({ seed: 777 });
    const { world } = session;
    const humanBefore = funds(world, HUMAN);
    const aiBefore = funds(world, AI);
    session.enqueuePlayerIntent(buildSendTributeOrder(HUMAN, AI, 2000));
    session.tick();
    expect(funds(world, HUMAN)).toBe(humanBefore - 2000);
    expect(funds(world, AI)).toBe(aiBefore + 2000);
    expect(world.diplomacy.disposition).toBe(54);
    expect(world.diplomacy.totalTributeSent).toBe(2000);
  });

  it('caps the disposition gain at +20 for huge gifts', () => {
    const session = createSession({ seed: 777 });
    const { world } = session;
    // Give the human enough funds for the gift.
    getPlayer(world.city, HUMAN)!.funds = 100000;
    session.enqueuePlayerIntent(buildSendTributeOrder(HUMAN, AI, 50000));
    session.tick();
    expect(world.diplomacy.disposition).toBe(70);
  });

  it('rejects when the sender cannot afford it', () => {
    const session = createSession({ seed: 777 });
    expect(() =>
      session.enqueuePlayerIntent(buildSendTributeOrder(HUMAN, AI, 999999999)),
    ).toThrow();
  });

  it('works in peaceful mode (a pure funds transfer)', () => {
    const session = createSession({ seed: 777, peaceful: true });
    session.enqueuePlayerIntent(buildSendTributeOrder(HUMAN, AI, 500));
    session.tick();
    expect(session.world.diplomacy.totalTributeSent).toBe(500);
  });
});

describe('demandTribute', () => {
  it('an accepted demand transfers funds and is recorded', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    world.diplomacy.disposition = 100;
    grantInfluence(world, HUMAN);
    const humanBefore = funds(world, HUMAN);
    const aiBefore = funds(world, AI);
    const influenceBefore = influence(world, HUMAN);
    session.enqueuePlayerIntent(buildDemandTributeOrder(HUMAN, AI, 500));
    session.tick();
    expect(world.diplomacy.lastDemand).toBe('accepted');
    expect(world.diplomacy.lastDemandAmount).toBe(500);
    expect(funds(world, HUMAN)).toBe(humanBefore + 500);
    expect(funds(world, AI)).toBe(aiBefore - 500);
    expect(world.diplomacy.totalTributeReceived).toBe(500);
    expect(world.diplomacy.demandsRefused).toBe(0);
    // Fun-audit C2b: the demand spent influence.
    expect(influence(world, HUMAN)).toBe(influenceBefore - DEMAND_TRIBUTE_INFLUENCE_COST);
  });

  it('a refused demand sours relations and counts the refusal', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'marshal' });
    const { world } = session;
    world.diplomacy.disposition = 10;
    grantInfluence(world, HUMAN);
    const influenceBefore = influence(world, HUMAN);
    session.enqueuePlayerIntent(buildDemandTributeOrder(HUMAN, AI, 500));
    session.tick();
    expect(world.diplomacy.lastDemand).toBe('refused');
    expect(world.diplomacy.disposition).toBe(5);
    expect(world.diplomacy.demandsRefused).toBe(1);
    // Fun-audit C2b: the ask spends influence even when refused.
    expect(influence(world, HUMAN)).toBe(influenceBefore - DEMAND_TRIBUTE_INFLUENCE_COST);
  });

  it('rejects loudly in peaceful mode', () => {
    const session = createSession({ seed: 777, peaceful: true });
    expect(() =>
      session.enqueuePlayerIntent(buildDemandTributeOrder(HUMAN, AI, 500)),
    ).toThrow(/peaceful/);
  });

  it('rejects loudly without enough influence (fun-audit C2b)', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    world.diplomacy.disposition = 100;
    grantInfluence(world, HUMAN, DEMAND_TRIBUTE_INFLUENCE_COST - 1);
    expect(() =>
      session.enqueuePlayerIntent(buildDemandTributeOrder(HUMAN, AI, 500)),
    ).toThrow(/influence/);
    expect(world.diplomacy.lastDemand).toBeNull();
  });
});

describe('proposeCeasefire', () => {
  it('an accepted ceasefire holds fire for the full window', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'citizen' });
    const { world } = session;
    world.diplomacy.disposition = 100;
    grantInfluence(world, HUMAN);
    const influenceBefore = influence(world, HUMAN);
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    expect(world.diplomacy.lastCeasefireAsk).toBe('accepted');
    expect(ceasefireActive(world)).toBe(true);
    // The command applies at the tick boundary, so one tick has elapsed.
    expect(world.diplomacy.ceasefireUntilTick - world.tick).toBe(CEASEFIRE_TICKS - 1);
    // Fun-audit C2b: the ask spent influence.
    expect(influence(world, HUMAN)).toBe(influenceBefore - CEASEFIRE_INFLUENCE_COST);
  });

  it('a declined ceasefire sours relations', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'marshal' });
    const { world } = session;
    world.diplomacy.disposition = 0;
    grantInfluence(world, HUMAN);
    const influenceBefore = influence(world, HUMAN);
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    expect(world.diplomacy.lastCeasefireAsk).toBe('declined');
    expect(ceasefireActive(world)).toBe(false);
    expect(world.diplomacy.disposition).toBe(0); // floored at 0
    // Fun-audit C2b: the ask spends influence even when declined.
    expect(influence(world, HUMAN)).toBe(influenceBefore - CEASEFIRE_INFLUENCE_COST);
  });

  it('rejects while a ceasefire is already active', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'citizen' });
    const { world } = session;
    world.diplomacy.disposition = 100;
    grantInfluence(world, HUMAN);
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    expect(() =>
      session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI)),
    ).toThrow(/already in effect/);
  });

  it('rejects loudly without enough influence (fun-audit C2b)', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'citizen' });
    const { world } = session;
    world.diplomacy.disposition = 100;
    grantInfluence(world, HUMAN, CEASEFIRE_INFLUENCE_COST - 1);
    expect(() =>
      session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI)),
    ).toThrow(/influence/);
    expect(world.diplomacy.lastCeasefireAsk).toBeNull();
  });

  it('rejects loudly in peaceful mode', () => {
    const session = createSession({ seed: 777, peaceful: true });
    expect(() =>
      session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI)),
    ).toThrow(/peaceful/);
  });

  it('attacking the rival breaks the ceasefire (betrayal)', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'citizen' });
    const { world } = session;
    world.diplomacy.disposition = 100;
    grantInfluence(world, HUMAN);
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    expect(ceasefireActive(world)).toBe(true);
    const attacker = world.units.find((u) => u.owner === HUMAN)!;
    const target = world.units.find((u) => u.owner === AI)!;
    // Walk the target into range: non-stealth units are always detected.
    target.x = attacker.x + 5;
    target.z = attacker.z;
    const dispBefore = world.diplomacy.disposition;
    session.enqueuePlayerIntent({
      kind: 'attackUnit',
      payload: { unitId: attacker.id, targetId: target.id, owner: HUMAN },
    });
    session.tick();
    expect(ceasefireActive(world)).toBe(false);
    expect(world.diplomacy.lastCeasefireAsk).toBe('broken');
    expect(world.diplomacy.disposition).toBe(dispBefore - 15);
  });

  it('neither side opportunistically acquires the other while frozen', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'citizen' });
    const { world } = session;
    const human = world.units.find((u) => u.owner === HUMAN)!;
    const rival = world.units.find((u) => u.owner === AI)!;
    rival.x = human.x + 5;
    rival.z = human.z;
    // Freeze the front directly (bypasses the verdict for determinism).
    world.diplomacy.parties = { owner: HUMAN, aiOwner: AI };
    world.diplomacy.ceasefireUntilTick = world.tick + 30;
    for (let i = 0; i < 3; i++) session.tick();
    expect(human.targetId ?? 0).toBe(0);
    expect(rival.targetId ?? 0).toBe(0);
    // After expiry the freeze lifts: someone acquires someone.
    world.diplomacy.ceasefireUntilTick = world.tick;
    for (let i = 0; i < 5; i++) session.tick();
    const acquired = (human.targetId ?? 0) !== 0 || (rival.targetId ?? 0) !== 0;
    expect(acquired).toBe(true);
  });
});

describe('diplomacy snapshots and digests', () => {
  it('diplomacy state round-trips through snapshots', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'citizen' });
    const { world } = session;
    world.diplomacy.disposition = 100;
    // Fun-audit C2b: the diplomatic moves cost influence.
    grantInfluence(world, HUMAN);
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    session.enqueuePlayerIntent(buildDemandTributeOrder(HUMAN, AI, 500));
    session.tick();
    const restored = restoreSnapshot(takeSnapshot(world));
    expect(restored.diplomacy.disposition).toBe(world.diplomacy.disposition);
    expect(restored.diplomacy.ceasefireUntilTick).toBe(
      world.diplomacy.ceasefireUntilTick,
    );
    expect(restored.diplomacy.lastDemand).toBe('accepted');
    expect(restored.diplomacy.lastDemandAmount).toBe(500);
    expect(restored.diplomacy.parties).toEqual({ owner: HUMAN, aiOwner: AI });
  });

  it('legacy snapshots without the field decode to a neutral state', () => {
    const world = createSession({ seed: 777 }).world;
    const snap = takeSnapshot(world) as unknown as Record<string, unknown>;
    delete snap['diplomacy'];
    const restored = restoreSnapshot(takeSnapshot(world));
    const legacy = restoreSnapshot(snap as never);
    expect(legacy.diplomacy).toEqual(initDiplomacy());
    expect(restored.diplomacy).toEqual(initDiplomacy());
  });

  it('diplomacy is digest-covered: disposition changes the digest', () => {
    const a = createSession({ seed: 777 }).world;
    const b = createSession({ seed: 777 }).world;
    expect(digestWorld(a)).toBe(digestWorld(b));
    b.diplomacy.disposition = 80;
    expect(digestWorld(a)).not.toBe(digestWorld(b));
    expect(canonicalizeWorld(b)).toContain('|diplomacy=');
  });
});
