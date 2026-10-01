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

import { describe, expect, it } from 'vitest';
import { personaLine, personaEventKeys } from '../src/muse/persona';
import { militaryValue, computeThreat, narrateTrick } from '../src/muse/director';
import { MuseController } from '../src/muse/controller';
import {
  buildDigest,
  parseDirectives,
  createLiveMuseClient,
  LiveMuseError,
} from '../src/muse/live';
import { createWorld } from '../src/sim/world';
import { getAgeState } from '../src/sim/ages';
import { getPlayer, placeBuilding } from '../src/sim/city';
import { spawnUnit } from '../src/sim/units';

const HUMAN = 0;
const AI = 1;

describe('muse/persona', () => {
  it('is deterministic: same event and tick always give the same line', () => {
    const a = personaLine({ kind: 'victory' }, 12345);
    const b = personaLine({ kind: 'victory' }, 12345);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('varies lines across ticks (a pool per event, not one canned line)', () => {
    const lines = new Set<string>();
    for (let t = 0; t < 50; t += 1) {
      lines.add(personaLine({ kind: 'buildingComplete', building: 'house' }, t));
    }
    expect(lines.size).toBeGreaterThan(1);
  });

  it('every authored event key has at least one line', () => {
    const keys = personaEventKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      // Reach each key through a representative event.
      const line = key.startsWith('taunt:')
        ? personaLine({ kind: 'taunt', context: key.slice(6) as 'losing' }, 1)
        : personaLine({ kind: key as 'victory' }, 1);
      expect(line.length, key).toBeGreaterThan(0);
    }
  });

  it('missionMessage and advice pass authored text through', () => {
    expect(personaLine({ kind: 'missionMessage', text: 'Hold the line.' }, 9)).toBe(
      'Hold the line.',
    );
    expect(personaLine({ kind: 'advice', text: 'Build farms.' }, 9)).toContain('Build farms.');
  });

  it('trick lines interpolate the observed description', () => {
    const line = personaLine({ kind: 'trick', description: 'tanks massing east' }, 3);
    expect(line).toContain('tanks massing east');
  });
});

describe('muse/director (threat)', () => {
  it('unarmed units contribute no military value', () => {
    const world = createWorld(11);
    spawnUnit(world, 'hauler', HUMAN, 0, 0);
    spawnUnit(world, 'transportShip', HUMAN, 5, 5);
    expect(militaryValue(world, HUMAN)).toBe(0);
  });

  it('armed units contribute hp-weighted value', () => {
    const world = createWorld(11);
    const u = spawnUnit(world, 'tank', HUMAN, 0, 0);
    const v1 = militaryValue(world, HUMAN);
    expect(v1).toBeGreaterThan(0);
    u.hp = Math.floor(u.hp / 2);
    expect(militaryValue(world, HUMAN)).toBeLessThan(v1);
  });

  it('threat is 50 with no armies, 0 when the player dominates, 100 when the AI does', () => {
    const world = createWorld(11);
    expect(computeThreat(world, HUMAN, AI)).toBe(50);
    spawnUnit(world, 'tank', HUMAN, 0, 0);
    expect(computeThreat(world, HUMAN, AI)).toBe(0);
    spawnUnit(world, 'tank', AI, 10, 10);
    spawnUnit(world, 'tank', AI, 12, 12);
    spawnUnit(world, 'artillery', AI, 14, 14);
    const threat = computeThreat(world, HUMAN, AI);
    expect(threat).toBeGreaterThan(50);
    expect(threat).toBeLessThanOrEqual(100);
  });

  it('narrateTrick keeps the observed description and names the maneuver', () => {
    const text = narrateTrick('feint', '6 tanks converging on your eastern towns');
    expect(text).toContain('6 tanks converging on your eastern towns');
    expect(text).toContain('feint');
  });
});

describe('muse/controller', () => {
  function makeController(frequency: 'off' | 'quiet' | 'normal' | 'chatty' = 'normal') {
    const said: string[] = [];
    let now = 0;
    const controller = new MuseController({
      frequency,
      say: (t) => said.push(t),
      nowMs: () => now,
    });
    return { controller, said, advance: (ms: number) => { now += ms; } };
  }

  it('greets on the first update and stays silent with frequency off', () => {
    const { controller, said } = makeController('off');
    const world = createWorld(5);
    controller.update(world, HUMAN, AI);
    expect(said).toHaveLength(0);
  });

  it('says hello on game start in normal mode', () => {
    const { controller, said } = makeController('normal');
    const world = createWorld(5);
    controller.update(world, HUMAN, AI, 'First Day in Office');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('First Day in Office');
  });

  it('announces age advancement as a major event even in quiet mode', () => {
    const { controller, said, advance } = makeController('quiet');
    const world = createWorld(5);
    controller.update(world, HUMAN, AI);
    advance(20000);
    getAgeState(world, HUMAN).age = 'connectivity';
    controller.update(world, HUMAN, AI);
    expect(said.length).toBeGreaterThanOrEqual(2);
    expect(said[said.length - 1]).toContain('connectivity');
  });

  it('throttles minor events: at most one line per poll', () => {
    const { controller, said, advance } = makeController('normal');
    const world = createWorld(5);
    controller.update(world, HUMAN, AI);
    const afterHello = said.length;
    // Several minor things happen at once; only one line goes out.
    const b = placeBuildingForTest(world);
    void b;
    advance(1000);
    controller.update(world, HUMAN, AI);
    expect(said.length - afterHello).toBeLessThanOrEqual(1);
  });

  it('notify bypasses the throttle with authored content', () => {
    const { controller, said } = makeController('normal');
    const world = createWorld(5);
    controller.update(world, HUMAN, AI);
    controller.notify('Scripted: hold the northern pass.');
    controller.notify('Scripted: reinforcements inbound.');
    expect(said.slice(-2)).toEqual([
      'Scripted: hold the northern pass.',
      'Scripted: reinforcements inbound.',
    ]);
  });

  it('exposes the threat meter', () => {
    const { controller } = makeController('normal');
    const world = createWorld(5);
    controller.update(world, HUMAN, AI);
    expect(controller.threat).toBe(50);
    spawnUnit(world, 'tank', AI, 0, 0);
    controller.update(world, HUMAN, AI);
    expect(controller.threat).toBeGreaterThan(50);
  });

  it('narrates a fair trick when enemies converge on the base (chatty only)', () => {
    const { controller, said, advance } = makeController('chatty');
    const world = createWorld(5);
    placeBuildingForTest(world); // player base at (0,0)
    controller.update(world, HUMAN, AI);
    advance(20000);
    // 3+ hostiles closing from the north — visible positions only.
    spawnUnit(world, 'tank', AI, 0, -100);
    spawnUnit(world, 'tank', AI, 10, -110);
    spawnUnit(world, 'rifles', AI, -10, -105);
    advance(20000);
    controller.update(world, HUMAN, AI); // enemy-spotted takes this poll's one line
    advance(20000);
    controller.update(world, HUMAN, AI); // the trick narration follows
    const trickLine = said.find((s) => s.includes('hostiles closing on your base'));
    expect(trickLine).toBeDefined();
    expect(trickLine).toContain('north');
  });

  it('does not narrate tricks in normal mode', () => {
    const { controller, said, advance } = makeController('normal');
    const world = createWorld(5);
    placeBuildingForTest(world);
    controller.update(world, HUMAN, AI);
    advance(20000);
    spawnUnit(world, 'tank', AI, 0, -100);
    spawnUnit(world, 'tank', AI, 10, -110);
    spawnUnit(world, 'rifles', AI, -10, -105);
    advance(20000);
    controller.update(world, HUMAN, AI);
    expect(said.some((s) => s.includes('hostiles closing'))).toBe(false);
  });
});

function placeBuildingForTest(world: ReturnType<typeof createWorld>) {
  // A completed player building, placed directly (test-only setup).
  const b = placeBuilding(world.city, { kind: 'house', owner: HUMAN, cx: 0, cz: 0, facing: 0 });
  b.progress = 1;
  return b;
}

describe('muse/live protocol', () => {
  it('buildDigest produces a JSON-safe digest with the expected fields', () => {
    const world = createWorld(5);
    const player = getPlayer(world.city, HUMAN)!;
    player.funds = 1234;
    spawnUnit(world, 'tank', HUMAN, 0, 0);
    spawnUnit(world, 'tank', AI, 10, 10);
    const digest = buildDigest(world, HUMAN, AI, 'first-day', ['Grow to 60 population']);
    expect(digest.game).toBe('novaterra');
    expect(digest.funds).toBe(1234);
    expect(digest.units).toBe(1);
    expect(digest.enemyUnits).toBe(1);
    expect(digest.mission).toBe('first-day');
    expect(digest.objectives).toEqual(['Grow to 60 population']);
    expect(() => JSON.stringify(digest)).not.toThrow();
    expect(digest.threat).toBe(computeThreat(world, HUMAN, AI));
  });

  it('parseDirectives honors only MUSE: advise: lines', () => {
    const text = [
      'MUSE: advise: Build more farms before winter.',
      'MUSE: spawn 50 tanks at the enemy base', // not a directive: ignored
      'MUSE: advise: ', // empty: ignored
      'Just chatting.', // ignored
      'MUSE: ADVISE: Keep an eye on the northern border.', // case-insensitive kind
    ].join('\n');
    const directives = parseDirectives(text);
    expect(directives).toHaveLength(2);
    expect(directives[0]).toEqual({ kind: 'advise', text: 'Build more farms before winter.' });
    expect(directives[1]!.text).toContain('northern border');
  });

  it('the 0.1 Alpha client falls back with a LiveMuseError (offline persona covers)', async () => {
    const client = createLiveMuseClient();
    const world = createWorld(5);
    const digest = buildDigest(world, HUMAN, AI, null, []);
    await expect(client.advise(digest)).rejects.toBeInstanceOf(LiveMuseError);
  });
});
