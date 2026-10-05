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
 * NOVATERRA — tests/audio.events.test.ts (0.1 Alpha).
 *
 * Final-review R5 (2026-10-01): the sim→audio event differ
 * (`src/audio/events.ts`) and the war-mood hysteresis tracker
 * (`MoodTracker` in `src/audio/music.ts`). Pure logic — no Web Audio,
 * no DOM — so these run headless.
 */

import { describe, expect, it } from 'vitest';
import {
  AudioEventTracker,
  snapshotForAudio,
  type AudioWorldSnapshot,
} from '../src/audio/events';
import {
  MoodTracker,
  TENSION_ENTER_POLLS,
  TENSION_EXIT_QUIET_MS,
  WAR_ENTER_POLLS,
  WAR_EXIT_QUIET_MS,
} from '../src/audio/music';

const PLAYER = 0;
const RIVAL = 1;
/** Test cell→world converter: 10 world units per cell. */
const cellToWorld = (c: number): number => c * 10 + 5;

function unit(
  id: number,
  owner: number,
  x: number,
  z: number,
  overrides: Partial<{ hp: number; targetId: number; embeddedIn: number }> = {},
) {
  return {
    id,
    owner,
    hp: 100,
    x,
    z,
    targetId: 0,
    embeddedIn: 0,
    ...overrides,
  };
}

function building(
  id: number,
  owner: number,
  cx: number,
  cz: number,
  overrides: Partial<{ hp: number; progress: number; kind: string }> = {},
) {
  return { id, owner, cx, cz, hp: 500, ...overrides };
}

function worldLike(parts: {
  units?: ReturnType<typeof unit>[];
  buildings?: ReturnType<typeof building>[];
  upgrades?: Record<number, string[]>;
}) {
  return {
    units: parts.units ?? [],
    city: { buildings: parts.buildings ?? [] },
    upgrades: parts.upgrades ?? { [PLAYER]: [] },
  };
}

function snapshot(parts: Parameters<typeof worldLike>[0]): AudioWorldSnapshot {
  return snapshotForAudio(worldLike(parts), PLAYER, cellToWorld);
}

describe('snapshotForAudio', () => {
  it('skips dead units/buildings (hp <= 0)', () => {
    const snap = snapshot({
      units: [unit(1, PLAYER, 10, 20), unit(2, RIVAL, 30, 40, { hp: 0 })],
      buildings: [building(1, PLAYER, 2, 3), building(2, RIVAL, 4, 5, { hp: 0 })],
    });
    expect([...snap.units.keys()]).toEqual([1]);
    expect([...snap.buildings.keys()]).toEqual([1]);
  });

  it('converts building cell coords to world coords with the converter', () => {
    const snap = snapshot({ buildings: [building(7, PLAYER, 2, 3)] });
    const b = snap.buildings.get(7)!;
    expect(b.x).toBe(25); // 2*10+5
    expect(b.z).toBe(35); // 3*10+5
  });

  it('counts researched upgrades and embedded spies for the player', () => {
    const snap = snapshot({
      units: [
        unit(1, PLAYER, 0, 0, { embeddedIn: 9 }),
        unit(2, PLAYER, 0, 0, { embeddedIn: 9 }),
        unit(3, RIVAL, 0, 0, { embeddedIn: 9 }),
      ],
      upgrades: { [PLAYER]: ['econ1', 'mil2'], [RIVAL]: ['x'] },
    });
    expect(snap.researchedCount).toBe(2);
    expect(snap.embeddedSpies).toBe(2);
  });

  it('flags units with a live target as in combat', () => {
    const snap = snapshot({
      units: [unit(1, PLAYER, 0, 0, { targetId: 5 }), unit(2, PLAYER, 0, 0)],
    });
    expect(snap.units.get(1)!.inCombat).toBe(true);
    expect(snap.units.get(2)!.inCombat).toBe(false);
  });

  it('carries the building kind for the building-loss toast (Fix 2)', () => {
    const snap = snapshot({
      buildings: [{ ...building(7, PLAYER, 2, 3), kind: 'waterPump' }],
    });
    expect(snap.buildings.get(7)?.kind).toBe('waterPump');
  });
});

describe('AudioEventTracker', () => {
  it('emits no events on the first poll (baseline only)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    const events = tracker.observe(
      snapshot({ units: [unit(1, PLAYER, 10, 20)] }),
    );
    expect(events.deaths).toEqual([]);
    expect(events.destroyed).toEqual([]);
    expect(events.trained).toBe(0);
    expect(events.researchDone).toBe(false);
    expect(events.damageEvents).toBe(0);
    expect(events.combatUnits).toBe(0);
    expect(events.intelOpComplete).toBe(false);
  });

  it('reports deaths with positions and friend/foe flags', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({
        units: [unit(1, PLAYER, 10, 20), unit(2, RIVAL, 30, 40)],
      }),
    );
    const events = tracker.observe(snapshot({ units: [] }));
    expect(events.deaths).toHaveLength(2);
    const friendly = events.deaths.find((d) => d.friendly)!;
    const foe = events.deaths.find((d) => !d.friendly)!;
    expect(friendly.x).toBe(10);
    expect(friendly.z).toBe(20);
    expect(foe.x).toBe(30);
    expect(foe.z).toBe(40);
  });

  it('reports destroyed buildings with positions', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({ buildings: [building(1, PLAYER, 2, 3)] }));
    const events = tracker.observe(snapshot({ buildings: [] }));
    expect(events.destroyed).toHaveLength(1);
    expect(events.destroyed[0]!.friendly).toBe(true);
    expect(events.destroyed[0]!.x).toBe(25);
  });

  it('destroyed events carry kind + id for the building-loss toast (Fix 2)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({ buildings: [{ ...building(7, PLAYER, 2, 3), kind: 'waterPump' }] }),
    );
    const events = tracker.observe(snapshot({ buildings: [] }));
    expect(events.destroyed).toHaveLength(1);
    expect(events.destroyed[0]?.kind).toBe('waterPump');
    expect(events.destroyed[0]?.id).toBe(7);
    expect(events.destroyed[0]?.friendly).toBe(true);
  });

  it('unit deaths leave kind/id unset', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({ units: [unit(1, PLAYER, 10, 20)] }));
    const events = tracker.observe(snapshot({ units: [] }));
    expect(events.deaths).toHaveLength(1);
    expect(events.deaths[0]?.kind).toBeUndefined();
    expect(events.deaths[0]?.id).toBeUndefined();
  });

  it('counts damage events only for the player (under-attack cue)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({
        units: [unit(1, PLAYER, 0, 0), unit(2, RIVAL, 0, 0)],
        buildings: [building(1, PLAYER, 0, 0)],
      }),
    );
    const events = tracker.observe(
      snapshot({
        units: [
          unit(1, PLAYER, 0, 0, { hp: 50 }),
          unit(2, RIVAL, 0, 0, { hp: 50 }),
        ],
        buildings: [building(1, PLAYER, 0, 0, { hp: 400 })],
      }),
    );
    // 1 damaged player unit + 1 damaged player building; the rival's
    // damage does not count.
    expect(events.damageEvents).toBe(2);
  });

  it('counts newly appearing player units as trained', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({ units: [unit(1, PLAYER, 0, 0)] }));
    const events = tracker.observe(
      snapshot({
        units: [
          unit(1, PLAYER, 0, 0),
          unit(2, PLAYER, 0, 0),
          unit(3, RIVAL, 0, 0),
        ],
      }),
    );
    expect(events.trained).toBe(1);
  });

  it('reports which upgrades finished (fun-audit A3: the toast names it)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({ upgrades: { [PLAYER]: ['concrete'] } }));
    const events = tracker.observe(
      snapshot({ upgrades: { [PLAYER]: ['concrete', 'gunpowder'] } }),
    );
    expect(events.researchDone).toBe(true);
    expect(events.newResearchIds).toEqual(['gunpowder']);
  });

  it('carries friendly damage positions for event pings (fun-audit B5)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({ units: [unit(1, PLAYER, 10, 20)] }));
    const events = tracker.observe(
      snapshot({ units: [unit(1, PLAYER, 10, 20, { hp: 50 })] }),
    );
    expect(events.damageEvents).toBe(1);
    expect(events.damagePositions).toEqual([{ x: 10, z: 20 }]);
  });

  it('carries friendly trained-unit positions for event pings (fun-audit B5)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({ units: [unit(1, PLAYER, 10, 20)] }));
    const events = tracker.observe(
      snapshot({
        units: [unit(1, PLAYER, 10, 20), unit(2, PLAYER, 40, 50), unit(3, RIVAL, 0, 0)],
      }),
    );
    expect(events.trained).toBe(1);
    expect(events.trainedPositions).toEqual([{ x: 40, z: 50 }]);
  });

  it('fires researchDone and intelOpComplete on count increases', () => {    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({}));
    const same = tracker.observe(snapshot({}));
    expect(same.researchDone).toBe(false);
    expect(same.intelOpComplete).toBe(false);

    const tracker2 = new AudioEventTracker(PLAYER);
    tracker2.observe(snapshot({}));
    const events = tracker2.observe(
      snapshot({
        units: [unit(1, PLAYER, 0, 0, { embeddedIn: 9 })],
        upgrades: { [PLAYER]: ['econ1'] },
      }),
    );
    expect(events.researchDone).toBe(true);
    expect(events.intelOpComplete).toBe(true);
  });

  it('counts player combat units right now', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({}));
    const events = tracker.observe(
      snapshot({
        units: [
          unit(1, PLAYER, 0, 0, { targetId: 9 }),
          unit(2, PLAYER, 0, 0),
          unit(3, RIVAL, 0, 0, { targetId: 1 }),
        ],
      }),
    );
    expect(events.combatUnits).toBe(1);
  });

  it('does not double-report the same state across polls', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(snapshot({ units: [unit(1, PLAYER, 0, 0)] }));
    const first = tracker.observe(snapshot({ units: [unit(1, PLAYER, 0, 0)] }));
    expect(first.trained).toBe(0);
    expect(first.damageEvents).toBe(0);
  });

  // Roadmap B11 (2026-10-02): construction-complete transitions —
  // `prev.progress < 1 → now.progress >= 1` on a standing building
  // emits buildsComplete (the game loop plays the 'buildComplete' cue
  // for friendly completions).
  it('fires buildsComplete on the 0..1 → 1 progress transition', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 0.5 })] }),
    );
    const events = tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 1 })] }),
    );
    expect(events.buildsComplete).toHaveLength(1);
    expect(events.buildsComplete[0]).toEqual({
      x: cellToWorld(2),
      z: cellToWorld(3),
      friendly: true,
    });
  });

  it('does not fire while construction is still under way', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 0.5 })] }),
    );
    const events = tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 0.8 })] }),
    );
    expect(events.buildsComplete).toEqual([]);
  });

  it('does not fire for buildings that already stood at progress 1', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 1 })] }),
    );
    const events = tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 1 })] }),
    );
    expect(events.buildsComplete).toEqual([]);
  });

  it('does not fire a false completion for pre-B11 snapshots (no progress tracked)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    // building() carries no progress unless the override is passed —
    // snapshotForAudio treats that as 1 (already standing).
    tracker.observe(snapshot({ buildings: [building(1, PLAYER, 2, 3)] }));
    const events = tracker.observe(snapshot({ buildings: [building(1, PLAYER, 2, 3)] }));
    expect(events.buildsComplete).toEqual([]);
  });

  it('reports destroyed-in-progress buildings as destroyed, not completed', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 0.5 })] }),
    );
    const events = tracker.observe(snapshot({ buildings: [] }));
    expect(events.buildsComplete).toEqual([]);
    expect(events.destroyed).toHaveLength(1);
  });

  it('marks rival completions as foe (game loop keeps them silent)', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({ buildings: [building(1, RIVAL, 4, 5, { progress: 0.2 })] }),
    );
    const events = tracker.observe(
      snapshot({ buildings: [building(1, RIVAL, 4, 5, { progress: 1 })] }),
    );
    expect(events.buildsComplete).toHaveLength(1);
    expect(events.buildsComplete[0]!.friendly).toBe(false);
  });

  it('fires each completion exactly once', () => {
    const tracker = new AudioEventTracker(PLAYER);
    tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 0.5 })] }),
    );
    const first = tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 1 })] }),
    );
    expect(first.buildsComplete).toHaveLength(1);
    const second = tracker.observe(
      snapshot({ buildings: [building(1, PLAYER, 2, 3, { progress: 1 })] }),
    );
    expect(second.buildsComplete).toEqual([]);
  });
});

describe('MoodTracker', () => {
  it('starts in peace', () => {
    const tracker = new MoodTracker();
    expect(tracker.current).toBe('peace');
  });

  it('needs sustained activity to enter war (no single-stray flip)', () => {
    const tracker = new MoodTracker();
    // One active poll alone never flips the mood.
    expect(tracker.update({ nowMs: 1000, combatUnits: 1, damageEvents: 0 })).toBe('peace');
    // A quiet poll resets the streak...
    expect(tracker.update({ nowMs: 2000, combatUnits: 0, damageEvents: 0 })).toBe('peace');
    expect(tracker.update({ nowMs: 3000, combatUnits: 1, damageEvents: 0 })).toBe('peace');
    // ...but WAR_ENTER_POLLS consecutive active polls flip it.
    expect(tracker.update({ nowMs: 4000, combatUnits: 1, damageEvents: 0 })).toBe('war');
    expect(WAR_ENTER_POLLS).toBe(2);
  });

  it('damage alone (being bombed with no targets) counts as war', () => {
    const tracker = new MoodTracker();
    tracker.update({ nowMs: 1000, combatUnits: 0, damageEvents: 3 });
    expect(tracker.update({ nowMs: 2000, combatUnits: 0, damageEvents: 1 })).toBe('war');
  });

  it('stays in war through flickers and exits only after the quiet window', () => {
    const tracker = new MoodTracker();
    tracker.update({ nowMs: 0, combatUnits: 2, damageEvents: 0 });
    tracker.update({ nowMs: 1000, combatUnits: 2, damageEvents: 0 });
    expect(tracker.current).toBe('war');
    // A flicker below the quiet window keeps war.
    expect(
      tracker.update({ nowMs: 1000 + WAR_EXIT_QUIET_MS - 1, combatUnits: 0, damageEvents: 0 }),
    ).toBe('war');
    // The full quiet window exits to peace.
    expect(
      tracker.update({ nowMs: 1000 + WAR_EXIT_QUIET_MS, combatUnits: 0, damageEvents: 0 }),
    ).toBe('peace');
  });

  // Roadmap B20 (2026-10-02): the tension state.
  it('needs sustained proximity to enter tension (no single-blip flip)', () => {
    const tracker = new MoodTracker();
    expect(
      tracker.update({ nowMs: 1000, combatUnits: 0, damageEvents: 0, enemyProximity: true }),
    ).toBe('peace');
    // A quiet poll resets the streak...
    expect(
      tracker.update({ nowMs: 2000, combatUnits: 0, damageEvents: 0, enemyProximity: false }),
    ).toBe('peace');
    expect(
      tracker.update({ nowMs: 3000, combatUnits: 0, damageEvents: 0, enemyProximity: true }),
    ).toBe('peace');
    // ...but TENSION_ENTER_POLLS consecutive proximity polls flip it.
    expect(
      tracker.update({ nowMs: 4000, combatUnits: 0, damageEvents: 0, enemyProximity: true }),
    ).toBe('tension');
    expect(TENSION_ENTER_POLLS).toBe(2);
  });

  it('jumps from tension straight to war when combat starts', () => {
    const tracker = new MoodTracker();
    tracker.update({ nowMs: 1000, combatUnits: 0, damageEvents: 0, enemyProximity: true });
    tracker.update({ nowMs: 2000, combatUnits: 0, damageEvents: 0, enemyProximity: true });
    expect(tracker.current).toBe('tension');
    tracker.update({ nowMs: 3000, combatUnits: 1, damageEvents: 0, enemyProximity: true });
    expect(
      tracker.update({ nowMs: 4000, combatUnits: 1, damageEvents: 0, enemyProximity: true }),
    ).toBe('war');
  });

  it('war relaxes to tension (not peace) while enemies are still near', () => {
    const tracker = new MoodTracker();
    tracker.update({ nowMs: 0, combatUnits: 2, damageEvents: 0 });
    tracker.update({ nowMs: 1000, combatUnits: 2, damageEvents: 0 });
    expect(tracker.current).toBe('war');
    // Quiet window elapses with proximity: tension, not peace.
    expect(
      tracker.update({
        nowMs: 1000 + WAR_EXIT_QUIET_MS,
        combatUnits: 0,
        damageEvents: 0,
        enemyProximity: true,
      }),
    ).toBe('tension');
  });

  it('tension relaxes to peace after its own quiet window', () => {
    const tracker = new MoodTracker();
    tracker.update({ nowMs: 1000, combatUnits: 0, damageEvents: 0, enemyProximity: true });
    tracker.update({ nowMs: 2000, combatUnits: 0, damageEvents: 0, enemyProximity: true });
    expect(tracker.current).toBe('tension');
    // Proximity clears: still tension inside the window...
    expect(
      tracker.update({
        nowMs: 2000 + TENSION_EXIT_QUIET_MS - 1,
        combatUnits: 0,
        damageEvents: 0,
        enemyProximity: false,
      }),
    ).toBe('tension');
    // ...peace once the window elapses.
    expect(
      tracker.update({
        nowMs: 2000 + TENSION_EXIT_QUIET_MS,
        combatUnits: 0,
        damageEvents: 0,
        enemyProximity: false,
      }),
    ).toBe('peace');
  });
});
