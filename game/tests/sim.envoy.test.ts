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
 * NOVATERRA — Envoy at the Gates tests (fun-audit Tier 4 / E1, 0.1 Alpha).
 *
 * Covers the shared `neutralNonCombatant` gate and the full envoy visit
 * lifecycle through real sessions:
 * - the gate: AI and targeting ignore neutral non-combatants; attackUnit /
 *   spawnUnit reject them loudly; canTrain refuses them;
 * - proposeCeasefire on AI accept dispatches an envoy (no ceasefire yet);
 * - the envoy drives to the capital park point and waits for the player's
 *   answer; answering starts the ceasefire clock (accept) or ends the
 *   visit (decline); silence for 60 s defaults to accepting the offer;
 * - a big tribute at war can summon an envoy (seeded); a proud AI's
 *   refusal arrives as an envoy too; the envoy recalls when the war
 *   ends under it; snapshot/digest round-trips preserve it.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PLAYER_ID,
  createSession,
  HUMAN_PLAYER_ID,
} from '../src/ui/session';
import { buildAnswerEnvoyOrder } from '../src/ui/orders';
import { buildProposeCeasefireOrder, buildSendTributeOrder } from '../src/ui/orders';
import { buildAttackOrders } from '../src/ui/orders';
import {
  CEASEFIRE_TICKS,
  ENVOY_TRIBUTE_THRESHOLD,
  ceasefireActive,
  envoyActive,
  initDiplomacy,
} from '../src/sim/diplomacy';
import {
  ENVOY_WAIT_TICKS,
} from '../src/sim/envoy';
import { NEUTRAL_OWNER, UNIT_DEFS, isNeutralNonCombatant, isNeutralNonCombatantKind } from '../src/sim/units';
import type { UnitKind } from '../src/sim/units';
import { acquireTarget } from '../src/sim/combat';
import { canTrain } from '../src/sim/ai';
import { getVisibleEnemies } from '../src/sim/ai';
import { CommandRejectedError } from '../src/sim/commands';
import { getPlayer } from '../src/sim/city';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { canonicalizeWorld, digestWorld } from '../src/sim/digest';
import type { World } from '../src/sim/world';
import { spawnUnit } from '../src/sim/units';

const HUMAN = HUMAN_PLAYER_ID;
const AI = AI_PLAYER_ID;

function grantInfluence(world: World, owner: number, amount = 1000): void {
  const p = getPlayer(world.city, owner);
  if (p) p.influence = amount;
}

/** Tick the session until the envoy reaches 'waiting' (or the cap). */
function driveToWaiting(session: ReturnType<typeof createSession>): void {
  const { world } = session;
  for (let i = 0; i < 3000; i++) {
    if (world.diplomacy.envoy?.state === 'waiting') return;
    session.tick();
  }
  throw new Error('envoy never reached waiting');
}

/** Remove every AI unit and building from the world (headless war end). */
function wipeAI(world: World): void {
  world.units = world.units.filter((u) => u.owner !== AI);
  world.city.buildings = world.city.buildings.filter(
    (b) => (b as { owner?: number }).owner !== AI,
  );
}

describe('the shared neutralNonCombatant gate', () => {
  it('marks envoySUV as a neutral non-combatant kind', () => {
    expect(isNeutralNonCombatantKind('envoySUV')).toBe(true);
    expect(isNeutralNonCombatantKind('rifles')).toBe(false);
  });

  it('the AI never perceives the envoy as an enemy (getVisibleEnemies)', () => {
    const session = createSession({ seed: 4242 });
    const { world } = session;
    const parked = spawnUnit(world, 'envoySUV', 60, 60, NEUTRAL_OWNER);
    const aiUnit = world.units.find((u) => u.owner === AI);
    expect(aiUnit).toBeDefined();
    expect(isNeutralNonCombatant(parked)).toBe(true);
    const seen = getVisibleEnemies(world, AI);
    expect(seen.some((s) => s.id === parked.id)).toBe(false);
  });

  it('targeting never acquires the envoy (acquireTarget gate)', () => {
    const session = createSession({ seed: 4242 });
    const { world } = session;
    const parked = spawnUnit(world, 'envoySUV', 60, 60, NEUTRAL_OWNER);
    const aiUnit = world.units.find((u) => u.owner === AI);
    expect(aiUnit).toBeDefined();
    aiUnit!.x = parked.x + 1;
    aiUnit!.z = parked.z + 1;
    const target = acquireTarget(world, aiUnit!, UNIT_DEFS[aiUnit!.kind as UnitKind]);
    expect(target?.id ?? 0).not.toBe(parked.id);
  });

  it('attackUnit against the envoy is rejected loudly', () => {
    const session = createSession({ seed: 4242 });
    const { world } = session;
    const parked = spawnUnit(world, 'envoySUV', 60, 60, NEUTRAL_OWNER);
    const humanUnit = world.units.find((u) => u.owner === HUMAN);
    expect(humanUnit).toBeDefined();
    expect(() =>
      session.enqueuePlayerIntent(
        buildAttackOrders([humanUnit!.id], HUMAN, parked.id)[0]!,
      ),
    ).toThrow(CommandRejectedError);
  });

  it('canTrain refuses neutral kinds', () => {
    const session = createSession({ seed: 4242 });
    const { world } = session;
    expect(canTrain(world, HUMAN, 'envoySUV')).toBe(false);
  });
});

describe('the envoy visit lifecycle', () => {
  it('an accepted ceasefire ask dispatches an envoy and starts no clock', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    grantInfluence(world, HUMAN);
    world.diplomacy.disposition = 100; // a gentle AI says yes
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    // No ceasefire yet — the clock starts at the player's answer.
    expect(ceasefireActive(world)).toBe(false);
    expect(world.diplomacy.envoy?.state).toBe('inbound');
    expect(world.diplomacy.envoy?.offer.verdict).toBe('accepted');
    expect(isNeutralNonCombatantKind('envoySUV')).toBe(true);
  });

  it('proposeCeasefire while an envoy is pending/active is rejected loudly', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    grantInfluence(world, HUMAN, 10000);
    world.diplomacy.disposition = 100;
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    expect(world.diplomacy.envoy?.state).toBe('inbound');
    expect(() =>
      session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI)),
    ).toThrow(CommandRejectedError);
  });

  it('the envoy parks at the capital and waits; accept starts the ceasefire', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    grantInfluence(world, HUMAN);
    world.diplomacy.disposition = 100;
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    driveToWaiting(session);
    const envoy = world.diplomacy.envoy!;
    expect(Math.abs(envoy.deadlineTick - world.tick - ENVOY_WAIT_TICKS)).toBeLessThanOrEqual(1);
    session.enqueuePlayerIntent(buildAnswerEnvoyOrder(HUMAN, true));
    session.tick();
    // The ceremony resolved: the clock runs, the envoy drives home.
    expect(world.diplomacy.envoy?.state).toBe('departing');
    expect(ceasefireActive(world)).toBe(true);
    expect(world.diplomacy.disposition).toBeGreaterThan(100 - 5);
    const doves = (world.ceremonyEvents ?? []).filter((e) => e.kind === 'doveRelease');
    expect(doves.length).toBe(1);
    // Force the drive-home watchdog: the visit fully clears.
    world.diplomacy.envoy!.departByTick = world.tick;
    session.tick();
    expect(world.diplomacy.envoy).toBeNull();
  });

  it('declining the envoy ends the visit with no ceasefire', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    grantInfluence(world, HUMAN);
    world.diplomacy.disposition = 100;
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    driveToWaiting(session);
    session.enqueuePlayerIntent(buildAnswerEnvoyOrder(HUMAN, false));
    session.tick();
    expect(world.diplomacy.envoy?.state).toBe('departing');
    expect(ceasefireActive(world)).toBe(false);
  });

  it('silence defaults to the offer: the clock starts on timeout', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    grantInfluence(world, HUMAN);
    world.diplomacy.disposition = 100;
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    driveToWaiting(session);
    // Force the deadline into the past, then tick.
    world.diplomacy.envoy!.deadlineTick = world.tick - 1;
    session.tick();
    expect(world.diplomacy.envoy?.state).toBe('departing');
    expect(ceasefireActive(world)).toBe(true);
    // Force the drive-home watchdog: the visit fully clears.
    world.diplomacy.envoy!.departByTick = world.tick;
    session.tick();
    expect(world.diplomacy.envoy).toBeNull();
  });

  it('a proud AI answers refusal — delivered by a refusal envoy', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'marshal' });
    const { world } = session;
    grantInfluence(world, HUMAN);
    world.diplomacy.disposition = 0;
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    expect(ceasefireActive(world)).toBe(false);
    expect(world.diplomacy.envoy?.offer.verdict).toBe('declined');
    driveToWaiting(session);
    // The player can only read it, not negotiate it.
    session.enqueuePlayerIntent(buildAnswerEnvoyOrder(HUMAN, false));
    session.tick();
    expect(world.diplomacy.envoy?.state).toBe('departing');
    expect(ceasefireActive(world)).toBe(false);
  });

  it('the envoy recalls when the war ends under it', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    grantInfluence(world, HUMAN);
    world.diplomacy.disposition = 100;
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    driveToWaiting(session);
    wipeAI(world);
    // The recall check runs on world.tick % 30 === 0 — tick into it.
    for (let i = 0; i < 35 && world.diplomacy.envoy?.state !== 'departing'; i++) {
      session.tick();
    }
    expect(world.diplomacy.envoy?.state).toBe('departing');
    expect(ceasefireActive(world)).toBe(false);
  });

  it('a big tribute at war can summon a seeded envoy (disposition 100: always)', () => {
    const session = createSession({ seed: 4242, aiDifficulty: 'cadet' });
    const { world } = session;
    getPlayer(world.city, HUMAN)!.funds = 100000;
    world.diplomacy.disposition = 100;
    session.enqueuePlayerIntent(
      buildSendTributeOrder(HUMAN, AI, ENVOY_TRIBUTE_THRESHOLD),
    );
    session.tick();
    expect(world.diplomacy.envoy?.state).toBe('inbound');
    expect(world.diplomacy.envoy?.offer.verdict).toBe('accepted');
  });

  it('a big tribute at disposition 0 never summons an envoy (seeded draw)', () => {
    const session = createSession({ seed: 4242, aiDifficulty: 'cadet' });
    const { world } = session;
    getPlayer(world.city, HUMAN)!.funds = 100000;
    world.diplomacy.disposition = 0;
    session.enqueuePlayerIntent(
      buildSendTributeOrder(HUMAN, AI, ENVOY_TRIBUTE_THRESHOLD),
    );
    session.tick();
    expect(world.diplomacy.envoy).toBeNull();
  });

  it('the envoy survives a snapshot round-trip', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
    const { world } = session;
    grantInfluence(world, HUMAN);
    world.diplomacy.disposition = 100;
    session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
    session.tick();
    driveToWaiting(session);
    const snap = takeSnapshot(world);
    const before = JSON.stringify(world.diplomacy.envoy);
    const restored = restoreSnapshot(snap);
    expect(JSON.stringify(restored.diplomacy.envoy)).toBe(before);
  });

  it('the envoy is covered by the world digest (deterministic)', () => {
    const mk = () => {
      const session = createSession({ seed: 777, aiDifficulty: 'cadet' });
      const { world } = session;
      grantInfluence(world, HUMAN);
      world.diplomacy.disposition = 100;
      session.enqueuePlayerIntent(buildProposeCeasefireOrder(HUMAN, AI));
      session.tick();
      return world;
    };
    const a = mk();
    const b = mk();
    expect(digestWorld(a)).toBe(digestWorld(b));
    // Canonical form changes while the envoy lives.
    const plain = createSession({ seed: 777, aiDifficulty: 'cadet' }).world;
    expect(digestWorld(a)).not.toBe(digestWorld(plain));
    void canonicalizeWorld;
  });
});
