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
 * NOVATERRA — Luminary tests (fun-audit Tier 4 / E2, 0.1 Alpha).
 *
 * Covers the six-card data deck and the full luminary lifecycle through
 * real sessions:
 * - the deck: 6 cards, pure eligibility predicates (each with a headless
 *   constructed-world test — the plan's steelman warning);
 * - the draw: on age advance (human only), seeded `events` stream, none
 *   eligible ⇒ no luminary, already-pending ⇒ no second draw;
 * - the guest: spawns as a neutral non-combatant `luminary` at the
 *   capital (the shared gate: never targeted, never trainable);
 * - resolveLuminary: every card's every choice applies the plan's §4
 *   numbers; loud validation; the deadline applies the default;
 * - the Whistleblower cover-up: leaks in 5 min unless counter-intel >
 *   100 at leak time (checked at leak, not at choice);
 * - the Prodigy streamline: −25% upkeep for 5 min via the economy hook;
 * - the War Hero retire: the most decorated veteran becomes a named
 *   drill instructor with a +50% XP aura;
 * - snapshot/digest round-trips preserve the luminary state.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PLAYER_ID,
  createSession,
  HUMAN_PLAYER_ID,
} from '../src/ui/session';
import { buildResolveLuminaryOrder } from '../src/ui/orders';
import {
  LUMINARY_DECK,
  LUMINARY_DECISION_TICKS,
  LUMINARY_NAMES,
  applyLuminaryChoice,
  decodeLuminariesState,
  encodeLuminariesState,
  getDrillInstructorXpMult,
  getLuminaryUpkeepMult,
  initLuminaries,
  luminaryCardById,
  maybeDrawLuminary,
} from '../src/sim/luminaries';
import { isNeutralNonCombatantKind } from '../src/sim/units';
import { getPlayer } from '../src/sim/city';
import { createWorld } from '../src/sim/world';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { canonicalizeWorld, digestWorld } from '../src/sim/digest';
import type { World } from '../src/sim/world';

/** A minimal world with a funded human player (no session needed). */
function bareWorld(seed = 1234): World {
  const world = createWorld(seed);
  const player = getPlayer(world.city, HUMAN_PLAYER_ID);
  if (player) {
    player.funds = 10000;
    player.influence = 200;
    player.research = 0;
    player.intel = { surveillance: 0, operational: 0, counterIntel: 0 };
  }
  return world;
}

describe('the data deck', () => {
  it('ships exactly 6 cards', () => {
    expect(LUMINARY_DECK).toHaveLength(6);
    expect(LUMINARY_DECK.map((c) => c.id).sort()).toEqual(
      ['cartographer', 'defector', 'logisticsProdigy', 'tycoon', 'warHero', 'whistleblower'].sort(),
    );
  });

  it('every card has a valid default choice and non-empty choices', () => {
    for (const card of LUMINARY_DECK) {
      expect(card.choices.length).toBeGreaterThanOrEqual(2);
      expect(card.choices.some((c) => c.id === card.defaultChoiceId)).toBe(true);
    }
  });

  it('luminaryCardById resolves and returns undefined for unknown', () => {
    expect(luminaryCardById('defector')?.id).toBe('defector');
    expect(luminaryCardById('nope')).toBeUndefined();
  });

  it('the luminary kind passes through the shared neutral gate', () => {
    expect(isNeutralNonCombatantKind('luminary')).toBe(true);
    expect(isNeutralNonCombatantKind('drillInstructor')).toBe(false);
  });

  it('the seeded name list is non-empty and deterministic to sample', () => {
    expect(LUMINARY_NAMES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(LUMINARY_NAMES).size).toBe(LUMINARY_NAMES.length);
  });
});

describe('eligibility (pure predicates, constructed worlds)', () => {
  it('defector: at war only (not peaceful, not under ceasefire)', () => {
    const war = bareWorld();
    war.peaceful = false;
    expect(luminaryCardById('defector')!.eligibility(war, HUMAN_PLAYER_ID)).toBe(true);
    const peaceful = bareWorld();
    peaceful.peaceful = true;
    expect(luminaryCardById('defector')!.eligibility(peaceful, HUMAN_PLAYER_ID)).toBe(false);
    const ceasefire = bareWorld();
    ceasefire.peaceful = false;
    ceasefire.diplomacy.ceasefireUntilTick = ceasefire.tick + 1000;
    expect(luminaryCardById('defector')!.eligibility(ceasefire, HUMAN_PLAYER_ID)).toBe(false);
  });

  it('warHero: needs a Veteran+ (vetLevel >= 2) unit', () => {
    const world = bareWorld();
    const card = luminaryCardById('warHero')!;
    expect(card.eligibility(world, HUMAN_PLAYER_ID)).toBe(false);
    world.units.push({
      id: 1, kind: 'tank', owner: HUMAN_PLAYER_ID, x: 0, z: 0,
      domain: 'land', speed: 10, hp: 100, cooldownLeft: 0, targetId: 0,
      chasing: false, state: 'idle', failReason: null, destX: 0, destZ: 0,
      arriveX: 0, arriveZ: 0, path: [], pathAt: 0, fieldId: 0,
      xp: 600, vetLevel: 2,
    } as never);
    expect(card.eligibility(world, HUMAN_PLAYER_ID)).toBe(true);
  });

  it('whistleblower: funds >= 500; tycoon: funds < 8000', () => {
    const world = bareWorld();
    const player = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    const wb = luminaryCardById('whistleblower')!;
    const ty = luminaryCardById('tycoon')!;
    player.funds = 10000;
    expect(wb.eligibility(world, HUMAN_PLAYER_ID)).toBe(true);
    expect(ty.eligibility(world, HUMAN_PLAYER_ID)).toBe(false);
    player.funds = 400;
    expect(wb.eligibility(world, HUMAN_PLAYER_ID)).toBe(false);
    expect(ty.eligibility(world, HUMAN_PLAYER_ID)).toBe(true);
    player.funds = 1000;
    expect(wb.eligibility(world, HUMAN_PLAYER_ID)).toBe(true);
    expect(ty.eligibility(world, HUMAN_PLAYER_ID)).toBe(true);
  });

  it('logisticsProdigy: needs 4 completed buildings', () => {
    const world = bareWorld();
    const card = luminaryCardById('logisticsProdigy')!;
    expect(card.eligibility(world, HUMAN_PLAYER_ID)).toBe(false);
    for (let i = 0; i < 4; i++) {
      world.city.buildings.push({
        id: 100 + i, kind: 'house', owner: HUMAN_PLAYER_ID,
        cx: i, cz: 0, progress: 1,
      } as never);
    }
    expect(card.eligibility(world, HUMAN_PLAYER_ID)).toBe(true);
  });

  it('cartographer: always eligible (the peaceful heartbeat fallback)', () => {
    const world = bareWorld();
    world.peaceful = true;
    expect(luminaryCardById('cartographer')!.eligibility(world, HUMAN_PLAYER_ID)).toBe(true);
  });
});

describe('the draw', () => {
  it('is deterministic: same seed draws the same card', () => {
    const a = bareWorld(42);
    const b = bareWorld(42);
    maybeDrawLuminary(a, HUMAN_PLAYER_ID);
    maybeDrawLuminary(b, HUMAN_PLAYER_ID);
    expect(a.luminaries.pending?.cardId).toBe(b.luminaries.pending?.cardId);
    expect(a.luminaries.pending).not.toBeNull();
  });

  it('spawns a neutral non-combatant guest at the capital', () => {
    const world = bareWorld(42);
    maybeDrawLuminary(world, HUMAN_PLAYER_ID);
    const pending = world.luminaries.pending!;
    expect(pending.owner).toBe(HUMAN_PLAYER_ID);
    expect(pending.deadlineTick).toBe(world.tick + LUMINARY_DECISION_TICKS);
    const guest = world.units.find((u) => u.id === pending.unitId)!;
    expect(guest.kind).toBe('luminary');
    expect(guest.owner).toBe(-1);
    expect(isNeutralNonCombatantKind(guest.kind)).toBe(true);
  });

  it('never draws for the AI owner (player-side only in 0.1 Alpha)', () => {
    const world = bareWorld();
    maybeDrawLuminary(world, AI_PLAYER_ID);
    expect(world.luminaries.pending).toBeNull();
  });

  it('never draws while one is pending', () => {
    const world = bareWorld(7);
    maybeDrawLuminary(world, HUMAN_PLAYER_ID);
    const first = world.luminaries.pending?.cardId;
    maybeDrawLuminary(world, HUMAN_PLAYER_ID);
    expect(world.luminaries.pending?.cardId).toBe(first);
    expect(world.units.filter((u) => u.kind === 'luminary')).toHaveLength(1);
  });

  it('a bare peaceful world still draws (cartographer fallback)', () => {
    const world = bareWorld(99);
    world.peaceful = true;
    const player = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    player.funds = 100000; // tycoon ineligible, whistleblower eligible
    maybeDrawLuminary(world, HUMAN_PLAYER_ID);
    expect(world.luminaries.pending).not.toBeNull();
  });
});

describe('resolveLuminary', () => {
  it('rejects loudly with no pending luminary', () => {
    const session = createSession({ seed: 1 });
    expect(() =>
      session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'chart')),
    ).toThrow(/no luminary/i);
  });

  it('rejects an unknown choice for the drawn card', () => {
    const session = createSession({ seed: 42 });
    maybeDrawLuminary(session.world, HUMAN_PLAYER_ID);
    expect(() =>
      session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'nope')),
    ).toThrow(/has no choice/i);
  });

  it('defector turn: +200 surveillance and marks enemy production', () => {
    const session = createSession({ seed: 11 });
    const world = session.world;
    // Give the AI a production building to mark.
    world.city.buildings.push({
      id: 9001, kind: 'barracks', owner: AI_PLAYER_ID, cx: 10, cz: 10, progress: 1,
    } as never);
    world.luminaries.pending = {
      cardId: 'defector', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: world.tick + LUMINARY_DECISION_TICKS,
    };
    const before = getPlayer(world.city, HUMAN_PLAYER_ID)!.intel.surveillance;
    session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'turn'));
    session.tick();
    const player = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    expect(player.intel.surveillance).toBe(before + 200);
    expect(world.luminaries.productionMarks.length).toBe(1);
    expect(world.luminaries.productionMarks[0]!.buildingId).toBe(9001);
    expect(world.luminaries.pending).toBeNull();
  });

  it('defector interrogate: +150 research; trial: +100 influence, -10 disposition', () => {
    const s1 = createSession({ seed: 11 });
    s1.world.luminaries.pending = {
      cardId: 'defector', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s1.world.tick + LUMINARY_DECISION_TICKS,
    };
    const r0 = getPlayer(s1.world.city, HUMAN_PLAYER_ID)!.research;
    s1.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'interrogate'));
    s1.tick();
    expect(getPlayer(s1.world.city, HUMAN_PLAYER_ID)!.research).toBe(r0 + 150);

    const s2 = createSession({ seed: 11 });
    s2.world.diplomacy.disposition = 50;
    s2.world.luminaries.pending = {
      cardId: 'defector', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s2.world.tick + LUMINARY_DECISION_TICKS,
    };
    const i0 = getPlayer(s2.world.city, HUMAN_PLAYER_ID)!.influence;
    s2.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'trial'));
    s2.tick();
    expect(getPlayer(s2.world.city, HUMAN_PLAYER_ID)!.influence).toBe(i0 + 100);
    expect(s2.world.diplomacy.disposition).toBe(40);
  });

  it('warHero retire: the most decorated veteran becomes a named instructor', () => {
    const session = createSession({ seed: 21 });
    const world = session.world;
    const mk = (id: number, vet: number) =>
      world.units.push({
        id, kind: 'tank', owner: HUMAN_PLAYER_ID, x: id * 10, z: 0,
        domain: 'land', speed: 10, hp: 100, cooldownLeft: 0, targetId: 0,
        chasing: false, state: 'idle', failReason: null, destX: 0, destZ: 0,
        arriveX: 0, arriveZ: 0, path: [], pathAt: 0, fieldId: 0,
        xp: vet * 300, vetLevel: vet,
      } as never);
    mk(5001, 2);
    mk(5002, 3);
    world.luminaries.pending = {
      cardId: 'warHero', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: world.tick + LUMINARY_DECISION_TICKS,
    };
    session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'retire'));
    session.tick();
    // The vet-3 (id 5002) retired; the vet-2 remains.
    expect(world.units.some((u) => u.id === 5002)).toBe(false);
    expect(world.units.some((u) => u.id === 5001)).toBe(true);
    const instructor = world.units.find((u) => u.kind === 'drillInstructor')!;
    expect(instructor.owner).toBe(HUMAN_PLAYER_ID);
    expect(world.luminaries.instructors).toHaveLength(1);
    expect(world.luminaries.instructors[0]!.unitId).toBe(instructor.id);
    expect(LUMINARY_NAMES).toContain(world.luminaries.instructors[0]!.name);
    // The aura: +50% XP next to the instructor.
    expect(getDrillInstructorXpMult(world, HUMAN_PLAYER_ID, instructor.x, instructor.z)).toBe(1.5);
    expect(getDrillInstructorXpMult(world, HUMAN_PLAYER_ID, instructor.x + 1000, instructor.z)).toBe(1.0);
  });

  it('warHero keep: +50 influence', () => {
    const session = createSession({ seed: 21 });
    session.world.luminaries.pending = {
      cardId: 'warHero', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: session.world.tick + LUMINARY_DECISION_TICKS,
    };
    const i0 = getPlayer(session.world.city, HUMAN_PLAYER_ID)!.influence;
    session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'keep'));
    session.tick();
    expect(getPlayer(session.world.city, HUMAN_PLAYER_ID)!.influence).toBe(i0 + 50);
  });

  it('whistleblower transparency: -500 funds, +150 influence', () => {
    const session = createSession({ seed: 31 });
    const player = getPlayer(session.world.city, HUMAN_PLAYER_ID)!;
    player.funds = 1000;
    session.world.luminaries.pending = {
      cardId: 'whistleblower', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: session.world.tick + LUMINARY_DECISION_TICKS,
    };
    session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'transparency'));
    session.tick();
    expect(player.funds).toBe(500);
    expect(player.influence).toBeGreaterThanOrEqual(150);
  });

  it('whistleblower cover-up: leaks in 5 min unless counter-intel > 100 at leak time', () => {
    const session = createSession({ seed: 31 });
    const world = session.world;
    const player = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    player.influence = 500;
    player.intel.counterIntel = 0;
    world.luminaries.pending = {
      cardId: 'whistleblower', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: world.tick + LUMINARY_DECISION_TICKS,
    };
    session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'coverUp'));
    session.tick();
    expect(world.luminaries.coverUp).not.toBeNull();
    // Fast-forward to the leak with no counter-intel: −200 influence.
    for (let t = 0; t < 9100; t++) session.tick();
    expect(world.luminaries.coverUp).toBeNull();
    expect(player.influence).toBe(300);

    // Again, but build counter-intel before the leak: buried, no loss.
    const s2 = createSession({ seed: 31 });
    const p2 = getPlayer(s2.world.city, HUMAN_PLAYER_ID)!;
    p2.influence = 500;
    s2.world.luminaries.pending = {
      cardId: 'whistleblower', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s2.world.tick + LUMINARY_DECISION_TICKS,
    };
    s2.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'coverUp'));
    s2.tick();
    p2.intel.counterIntel = 150; // built AFTER the choice — still saves you
    for (let t = 0; t < 9100; t++) s2.tick();
    expect(s2.world.luminaries.coverUp).toBeNull();
    expect(p2.influence).toBe(500);
  });

  it('tycoon sign: +3000 funds, -15 influence; expose: +120 influence', () => {
    const s1 = createSession({ seed: 41 });
    const p1 = getPlayer(s1.world.city, HUMAN_PLAYER_ID)!;
    p1.funds = 1000;
    p1.influence = 100;
    s1.world.luminaries.pending = {
      cardId: 'tycoon', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s1.world.tick + LUMINARY_DECISION_TICKS,
    };
    s1.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'sign'));
    s1.tick();
    expect(p1.funds).toBe(4000);
    expect(p1.influence).toBe(85);

    const s2 = createSession({ seed: 41 });
    const p2 = getPlayer(s2.world.city, HUMAN_PLAYER_ID)!;
    s2.world.diplomacy.disposition = 50;
    s2.world.luminaries.pending = {
      cardId: 'tycoon', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s2.world.tick + LUMINARY_DECISION_TICKS,
    };
    const i0 = p2.influence;
    s2.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'expose'));
    s2.tick();
    expect(p2.influence).toBe(i0 + 120);
    expect(s2.world.diplomacy.disposition).toBe(55);
  });

  it('logisticsProdigy streamline: -25% upkeep for 5 min; publish: +150 research', () => {
    const session = createSession({ seed: 51 });
    const world = session.world;
    world.luminaries.pending = {
      cardId: 'logisticsProdigy', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: world.tick + LUMINARY_DECISION_TICKS,
    };
    session.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'streamline'));
    session.tick();
    expect(getLuminaryUpkeepMult(world, HUMAN_PLAYER_ID)).toBe(0.75);
    expect(getLuminaryUpkeepMult(world, AI_PLAYER_ID)).toBe(1.0);

    const s2 = createSession({ seed: 51 });
    s2.world.luminaries.pending = {
      cardId: 'logisticsProdigy', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s2.world.tick + LUMINARY_DECISION_TICKS,
    };
    const r0 = getPlayer(s2.world.city, HUMAN_PLAYER_ID)!.research;
    s2.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'publish'));
    s2.tick();
    expect(getPlayer(s2.world.city, HUMAN_PLAYER_ID)!.research).toBe(r0 + 150);
  });

  it('cartographer chart: +120 surveillance; sell: +800 funds', () => {
    const s1 = createSession({ seed: 61 });
    s1.world.luminaries.pending = {
      cardId: 'cartographer', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s1.world.tick + LUMINARY_DECISION_TICKS,
    };
    const surv0 = getPlayer(s1.world.city, HUMAN_PLAYER_ID)!.intel.surveillance;
    s1.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'chart'));
    s1.tick();
    expect(getPlayer(s1.world.city, HUMAN_PLAYER_ID)!.intel.surveillance).toBe(surv0 + 120);

    const s2 = createSession({ seed: 61 });
    const p2 = getPlayer(s2.world.city, HUMAN_PLAYER_ID)!;
    s2.world.luminaries.pending = {
      cardId: 'cartographer', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: s2.world.tick + LUMINARY_DECISION_TICKS,
    };
    s2.enqueuePlayerIntent(buildResolveLuminaryOrder(HUMAN_PLAYER_ID, 'sell'));
    s2.tick();
    expect(p2.funds).toBeGreaterThanOrEqual(800);
  });

  it('the deadline applies the card default (no punishment for slow players)', () => {
    const session = createSession({ seed: 61 });
    const world = session.world;
    const player = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    world.luminaries.pending = {
      cardId: 'cartographer', unitId: 0, owner: HUMAN_PLAYER_ID,
      deadlineTick: world.tick + 5,
    };
    const surv0 = player.intel.surveillance;
    for (let t = 0; t < 10; t++) session.tick();
    // cartographer default = chart (+120 surveillance).
    expect(world.luminaries.pending).toBeNull();
    expect(player.intel.surveillance).toBe(surv0 + 120);
  });

  it('applyLuminaryChoice is directly testable per card (writers\' unit test)', () => {
    const world = bareWorld();
    applyLuminaryChoice(world, 'defector', 'interrogate');
    expect(getPlayer(world.city, HUMAN_PLAYER_ID)!.research).toBe(150);
  });
});

describe('snapshot + digest (AD9)', () => {
  it('round-trips the full luminary state', () => {
    const session = createSession({ seed: 77 });
    const world = session.world;
    world.luminaries.pending = {
      cardId: 'tycoon', unitId: 4242, owner: HUMAN_PLAYER_ID,
      deadlineTick: 99999,
    };
    world.luminaries.productionMarks.push({ buildingId: 7, untilTick: 12345 });
    world.luminaries.coverUp = { leakAtTick: 54321 };
    world.luminaries.upkeepCutUntilTick = 11111;
    world.luminaries.instructors.push({ unitId: 31337, owner: HUMAN_PLAYER_ID, name: 'A. Reyes' });
    const snap = takeSnapshot(world);
    const restored = restoreSnapshot(snap);
    expect(restored.luminaries).toEqual(world.luminaries);
  });

  it('legacy snapshots (no luminaries field) decode to fresh', () => {
    const decoded = decodeLuminariesState(undefined);
    expect(decoded).toEqual(initLuminaries());
    expect(decodeLuminariesState({ nope: 1 })).toEqual(initLuminaries());
  });

  it('the digest covers the luminary state and is deterministic', () => {
    const a = createSession({ seed: 88 });
    const b = createSession({ seed: 88 });
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
    expect(canonicalizeWorld(a.world)).toContain('|luminaries=');
    maybeDrawLuminary(a.world, HUMAN_PLAYER_ID);
    expect(digestWorld(a.world)).not.toBe(digestWorld(b.world));
  });
});
