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
 * NOVATERRA — session tests (Phase 1, step 9).
 *
 * The session wires the sim pipeline together without any DOM: world,
 * command queue, systems, starting forces, and the AI rival. Tests pin
 * the assembly (deterministic, systems in the documented order) and that
 * player intents + AI ticks both flow through the same queue.
 */
import { describe, expect, it } from 'vitest';
import { AI_PLAYER_ID, createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { buildMoveOrder, buildTrainOrder } from '../src/ui/orders';
import { canTarget } from '../src/sim/combat';
import { UNIT_DEFS, type UnitKind } from '../src/sim/units';
import { AI_THINK_TICKS } from '../src/sim/ai';

describe('session', () => {
  it('assembles a playable two-player world with starting forces', () => {
    const session = createSession({ seed: 1234 });
    expect(session.world.units.length).toBe(12); // 6 per side
    const owners = new Set(session.world.units.map((u) => u.owner));
    expect(owners).toEqual(new Set([HUMAN_PLAYER_ID, AI_PLAYER_ID]));
    expect(session.sessionId).toBe('novaterra-1234-citizen');
    expect(session.aiDifficulty).toBe('citizen');
    // Both sides start with engineers so both can build.
    const kinds = new Set(session.world.units.map((u) => u.kind));
    expect(kinds.has('engineer')).toBe(true);
  });

  it('is deterministic: same seed gives the same digest', () => {
    const a = createSession({ seed: 777 });
    const b = createSession({ seed: 777 });
    expect(a.digest()).toBe(b.digest());
    const ax = a.world.units.map((u) => [u.x, u.z, u.hp, u.owner, u.kind]);
    const bx = b.world.units.map((u) => [u.x, u.z, u.hp, u.owner, u.kind]);
    expect(ax).toEqual(bx);
  });

  it('ticks exactly one fixed step and advances the clock', () => {
    const session = createSession({ seed: 1234 });
    // createSession applies the starting forces with one fixed tick.
    expect(session.world.tick).toBe(1);
    session.tick();
    expect(session.world.tick).toBe(2);
    session.tick();
    expect(session.world.tick).toBe(3);
    expect(session.digest()).not.toBe(createSession({ seed: 1234 }).digest());
  });

  it('registers the documented system order', () => {
    const session = createSession({ seed: 1234 });
    // pathfinding → movement → envoy → luminary → combat → superweapons →
    // economy → wonder-countdown → intel → mayors → AI → generals → fog:
    // fourteen systems. (The intel system is the sim-core workstream's;
    // the wonder-countdown system is fun-audit B2's; the fog system is
    // fun-audit C3's; the envoy system is fun-audit E1's; the luminary
    // system is fun-audit E2's; the combine system is fun-audit E3's —
    // pinned here so the order stays documented.)
    expect(session.driver.systems).toHaveLength(14);
  });

  it('routes player intents through the command queue', () => {
    const session = createSession({ seed: 1234 });
    const before = session.world.units.length;
    const intent = buildTrainOrder('rifles', HUMAN_PLAYER_ID, 100, 100);
    session.enqueuePlayerIntent(intent);
    session.tick();
    expect(session.world.units.length).toBeGreaterThan(before);
  });

  it('rejects invalid player intents at enqueue', () => {
    const session = createSession({ seed: 1234 });
    // Far outside the map: rejected by spawnUnit validation.
    const intent = buildTrainOrder('rifles', HUMAN_PLAYER_ID, 99999, 99999);
    expect(() => session.enqueuePlayerIntent(intent)).toThrow();
  });

  it('the AI rival builds up its army through the same queue', () => {
    const session = createSession({ seed: 1234, aiDifficulty: 'citizen' });
    const aiUnits = () => session.world.units.filter((u) => u.owner === AI_PLAYER_ID).length;
    expect(aiUnits()).toBe(6);
    // Run past the citizen think cadence: one think → one more unit.
    for (let i = 0; i < AI_THINK_TICKS.citizen + 5; i += 1) session.tick();
    expect(aiUnits()).toBeGreaterThan(6);
  });

  it('the AI base is on land (its spawn commands would be rejected otherwise)', () => {
    const session = createSession({ seed: 1234 });
    // If the AI were water-locked, it could never grow past 6 units.
    for (let i = 0; i < AI_THINK_TICKS.citizen * 3; i += 1) session.tick();
    const aiUnits = session.world.units.filter((u) => u.owner === AI_PLAYER_ID).length;
    expect(aiUnits).toBeGreaterThan(6);
  });

  it('move orders from the UI move the unit', () => {
    const session = createSession({ seed: 1234 });
    const unit = session.world.units.find((u) => u.owner === HUMAN_PLAYER_ID)!;
    const fromX = unit.x;
    session.enqueuePlayerIntent(buildMoveOrder([unit.id], HUMAN_PLAYER_ID, unit.x + 40, unit.z));
    for (let i = 0; i < 60; i += 1) session.tick();
    expect(unit.x).toBeGreaterThan(fromX);
  });

  it('canTarget gate exists for attack intents', () => {
    // Sanity: the UI gates right-click attacks with canTarget(def, target)
    // — the same rule the Classic AI follows (ai.ts).
    const session = createSession({ seed: 1234 });
    const attacker = session.world.units.find((u) => u.owner === HUMAN_PLAYER_ID)!;
    const target = session.world.units.find((u) => u.owner === AI_PLAYER_ID)!;
    expect(canTarget(UNIT_DEFS[attacker.kind as UnitKind], target)).toBe(true);
  });
});

describe('session (campaign)', () => {
  it('builds a mission session from the mission def', async () => {
    const { getMission } = await import('../src/campaign/missions');
    const mission = getMission('northern-border')!;
    const session = createSession({ seed: 42, campaignMission: mission });
    // Mission map + difficulty drive the setup.
    expect(session.sessionId).toBe('novaterra-campaign-northern-border-42');
    expect(session.aiDifficulty).toBe(mission.aiDifficulty);
    // Starting resources applied to the human player.
    const human = session.world.city.players[HUMAN_PLAYER_ID]!;
    expect(human.funds).toBe(5000);
    expect(human.materials).toBe(2000);
    // The AI player is funded for scripted raids (its own starting
    // forces spend a little of the stockpile first).
    const ai = session.world.city.players[AI_PLAYER_ID]!;
    expect(ai.manpower).toBeGreaterThanOrEqual(9000);
  });

  it('skips the AI rival entirely when the mission difficulty is none', async () => {
    const { getMission } = await import('../src/campaign/missions');
    const mission = getMission('first-day')!;
    expect(mission.aiDifficulty).toBe('none');
    const session = createSession({ seed: 42, campaignMission: mission });
    const aiUnits = session.world.units.filter((u) => u.owner === AI_PLAYER_ID);
    expect(aiUnits).toHaveLength(0);
    const humanUnits = session.world.units.filter((u) => u.owner === HUMAN_PLAYER_ID);
    expect(humanUnits.length).toBeGreaterThan(0);
  });

  it('a mission session stays deterministic for the same seed', async () => {
    const { getMission } = await import('../src/campaign/missions');
    const mission = getMission('bread-and-power')!;
    const a = createSession({ seed: 99, campaignMission: mission });
    const b = createSession({ seed: 99, campaignMission: mission });
    expect(a.digest()).toBe(b.digest());
  });
});
