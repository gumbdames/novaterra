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
import {
  MISSIONS,
  getMission,
  missionsInOrder,
  type MissionDef,
} from '../src/campaign/missions';
import {
  checkObjective,
  checkPath,
  playerAlive,
} from '../src/campaign/objectives';
import {
  createMissionRun,
  updateMissionRun,
  missionProgress,
  MISSION_HUMAN_ID,
  MISSION_AI_ID,
} from '../src/campaign/director';
import {
  emptyProgress,
  scoreMission,
  recordCompletion,
  isMissionUnlocked,
  campaignEnding,
  createCampaignStore,
} from '../src/campaign/progress';
import { createWorld } from '../src/sim/world';
import { createCommandQueue } from '../src/sim/commands';
import { generateTerrain, getMapPreset, MAP_PRESETS } from '../src/sim/terrain';
import { placeBuilding, getPlayer } from '../src/sim/city';
import { spawnUnit, registerUnitCommands } from '../src/sim/units';
import { registerMovementCommands } from '../src/sim/movement';
import { UNIT_DEFS } from '../src/sim/units';
import { BUILDING_DEFS } from '../src/sim/city';
import { AGE_ORDER } from '../src/sim/ages';

const PRESET_NAMES = new Set(MAP_PRESETS.map((p) => p.name));

describe('campaign/missions data', () => {
  it('has exactly 8 missions in orders 1..8 with unique ids', () => {
    expect(MISSIONS).toHaveLength(8);
    const orders = missionsInOrder().map((m) => m.order);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const ids = MISSIONS.map((m) => m.id);
    expect(new Set(ids).size).toBe(8);
  });

  it('mission 1 is the tutorial with no AI rival', () => {
    const m1 = getMission('first-day')!;
    expect(m1.order).toBe(1);
    expect(m1.aiDifficulty).toBe('none');
  });

  it('every mission has at least one path and at least one peaceful path', () => {
    for (const m of MISSIONS) {
      expect(m.paths.length, `${m.id} paths`).toBeGreaterThan(0);
      expect(
        m.paths.some((p) => p.peaceful),
        `${m.id} peaceful path`,
      ).toBe(true);
      for (const p of m.paths) {
        expect(p.objectives.length, `${m.id}/${p.id} objectives`).toBeGreaterThan(0);
      }
    }
  });

  it('every mission references a real map preset', () => {
    for (const m of MISSIONS) {
      expect(PRESET_NAMES.has(m.mapPreset), `${m.id} map ${m.mapPreset}`).toBe(true);
    }
  });

  it('every mission references valid ages in reachAge objectives', () => {
    const ages = new Set<string>(AGE_ORDER);
    for (const m of MISSIONS) {
      for (const p of m.paths) {
        for (const o of p.objectives) {
          if (o.kind === 'reachAge') {
            expect(ages.has(o.age), `${m.id} age ${o.age}`).toBe(true);
          }
        }
      }
    }
  });

  it('every raid references real unit kinds with a positive count', () => {
    for (const m of MISSIONS) {
      for (const e of m.events) {
        if (!e.raid) continue;
        expect(e.raid.count, `${m.id}/${e.id} count`).toBeGreaterThan(0);
        expect(e.raid.kinds.length, `${m.id}/${e.id} kinds`).toBeGreaterThan(0);
        for (const k of e.raid.kinds) {
          expect(UNIT_DEFS[k] !== undefined, `${m.id}/${e.id} unit ${k}`).toBe(true);
        }
      }
    }
  });

  it('every build/train objective references real buildings and units', () => {
    for (const m of MISSIONS) {
      for (const p of m.paths) {
        for (const o of p.objectives) {
          if (o.kind === 'build') {
            expect(BUILDING_DEFS[o.building] !== undefined, `${m.id} building ${o.building}`).toBe(true);
          }
          if (o.kind === 'train') {
            expect(UNIT_DEFS[o.unit] !== undefined, `${m.id} unit ${o.unit}`).toBe(true);
          }
          if (o.kind === 'onFirstBuilding' as never) throw new Error('unreachable');
        }
      }
      for (const e of m.events) {
        if (e.trigger.kind === 'onFirstBuilding') {
          expect(
            BUILDING_DEFS[e.trigger.building] !== undefined,
            `${m.id}/${e.id} building ${e.trigger.building}`,
          ).toBe(true);
        }
      }
    }
  });

  it('briefings, debriefs, and labels are non-empty', () => {
    for (const m of MISSIONS) {
      expect(m.briefing.length, `${m.id} briefing`).toBeGreaterThan(0);
      expect(m.briefing.every((s) => s.length > 0), `${m.id} briefing text`).toBe(true);
      expect(m.debriefWin.length, `${m.id} debriefWin`).toBeGreaterThan(0);
      expect(m.debriefLose.length, `${m.id} debriefLose`).toBeGreaterThan(0);
      for (const p of m.paths) {
        expect(p.name.length, `${m.id}/${p.id} name`).toBeGreaterThan(0);
        for (const o of p.objectives) {
          expect(o.label.length, `${m.id} label`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('getMission returns undefined for unknown ids', () => {
    expect(getMission('nope')).toBeUndefined();
  });
});

describe('campaign/objectives', () => {
  function setup() {
    const world = createWorld(42);
    const player = getPlayer(world.city, MISSION_HUMAN_ID)!;
    return { world, player };
  }

  it('population objective completes at the threshold', () => {
    const { world, player } = setup();
    player.population = 59;
    let r = checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, {
      kind: 'population', count: 60, label: 'x',
    }, 0);
    expect(r.complete).toBe(false);
    player.population = 60;
    r = checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, {
      kind: 'population', count: 60, label: 'x',
    }, 0);
    expect(r.complete).toBe(true);
  });

  it('stockpile objective reads the named resource', () => {
    const { world, player } = setup();
    player.food = 1499;
    const obj = { kind: 'stockpile' as const, resource: 'food' as const, count: 1500, label: 'x' };
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 0).complete).toBe(false);
    player.food = 1500;
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 0).complete).toBe(true);
  });

  it('build objective counts completed player buildings of the kind', () => {
    const { world } = setup();
    const obj = { kind: 'build' as const, building: 'house' as const, count: 2, label: 'x' };
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 0).complete).toBe(false);
    const b1 = placeBuilding(world.city, { kind: 'house', owner: MISSION_HUMAN_ID, cx: 0, cz: 0, facing: 0 });
    b1.progress = 1;
    const b2 = placeBuilding(world.city, { kind: 'house', owner: MISSION_HUMAN_ID, cx: 10, cz: 10, facing: 0 });
    b2.progress = 0.5; // under construction: does not count
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 0).complete).toBe(false);
    b2.progress = 1;
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 0).complete).toBe(true);
  });

  it('train objective counts living player units of the kind', () => {
    const { world } = setup();
    spawnUnit(world, 'rifles', MISSION_HUMAN_ID, 0, 0);
    spawnUnit(world, 'rifles', MISSION_HUMAN_ID, 5, 5);
    spawnUnit(world, 'tank', MISSION_HUMAN_ID, 10, 10);
    const obj = { kind: 'train' as const, unit: 'rifles' as const, count: 2, label: 'x' };
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 0).complete).toBe(true);
    const obj2 = { kind: 'train' as const, unit: 'tank' as const, count: 2, label: 'x' };
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj2, 0).complete).toBe(false);
  });

  it('destroyUnits objective uses the kill counter', () => {
    const { world } = setup();
    const obj = { kind: 'destroyUnits' as const, count: 3, label: 'x' };
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 2).complete).toBe(false);
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 3).complete).toBe(true);
  });

  it('destroyAllEnemy requires zero enemy units and buildings', () => {
    const { world } = setup();
    spawnUnit(world, 'rifles', MISSION_AI_ID, 0, 0);
    const obj = { kind: 'destroyAllEnemy' as const, label: 'x' };
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 99).complete).toBe(false);
    world.units.length = 0;
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, obj, 99).complete).toBe(true);
  });

  it('reachAge and survive objectives', () => {
    const { world } = setup();
    spawnUnit(world, 'engineer', MISSION_HUMAN_ID, 0, 0);
    world.ages.age = 'connectivity';
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, {
      kind: 'reachAge', age: 'connectivity', label: 'x',
    }, 0).complete).toBe(true);
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, {
      kind: 'reachAge', age: 'ascendance', label: 'x',
    }, 0).complete).toBe(false);
    world.tick = 30 * 60 - 1;
    const survive = { kind: 'survive' as const, ticks: 30 * 60, label: 'x' };
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, survive, 0).complete).toBe(false);
    world.tick = 30 * 60;
    expect(checkObjective(world, MISSION_HUMAN_ID, MISSION_AI_ID, survive, 0).complete).toBe(true);
  });

  it('checkPath requires every objective', () => {
    const { world, player } = setup();
    player.population = 100;
    const mission = getMission('first-day')!;
    const path = mission.paths[0]!;
    const result = checkPath(world, MISSION_HUMAN_ID, MISSION_AI_ID, path, 0);
    expect(result.complete).toBe(false); // buildings missing
    expect(result.objectives).toHaveLength(path.objectives.length);
  });

  it('playerAlive is false only when nothing remains', () => {
    const { world } = setup();
    expect(playerAlive(world, MISSION_HUMAN_ID)).toBe(false);
    spawnUnit(world, 'engineer', MISSION_HUMAN_ID, 0, 0);
    expect(playerAlive(world, MISSION_HUMAN_ID)).toBe(true);
  });
});

describe('campaign/director', () => {
  function setup(missionId: string) {
    const mission = getMission(missionId)!;
    const world = createWorld(7);
    const queue = createCommandQueue();
    const preset = getMapPreset(mission.mapPreset);
    const terrain = generateTerrain(preset.seed, preset);
    registerUnitCommands(queue, terrain);
    registerMovementCommands(queue, terrain);
    // Mission setup grants the AI a manpower stockpile so scripted raids
    // can pay the manpower cost that spawnUnit validation requires.
    getPlayer(world.city, MISSION_AI_ID)!.manpower = 10000;
    const run = createMissionRun(mission, world);
    return { mission, world, queue, terrain, run };
  }

  it('fires an atTick event exactly once with a message directive', () => {
    const { mission, world, queue, terrain, run } = setup('first-day');
    const event = mission.events.find((e) => e.trigger.kind === 'atTick')!;
    world.tick = event.trigger.kind === 'atTick' ? event.trigger.tick : 0;
    spawnUnit(world, 'engineer', MISSION_HUMAN_ID, 0, 0);
    const d1 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d1.some((d) => d.kind === 'message')).toBe(true);
    const d2 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d2.filter((d) => d.kind === 'message')).toHaveLength(0);
  });

  it('onFirstBuilding fires when the player completes that building', () => {
    const { mission, world, queue, terrain, run } = setup('first-day');
    spawnUnit(world, 'engineer', MISSION_HUMAN_ID, 0, 0);
    world.tick = 1000; // past atTick events too
    updateMissionRun(run, mission, world, queue, terrain);
    const before = run.eventsFired.size;
    const b = placeBuilding(world.city, { kind: 'house', owner: MISSION_HUMAN_ID, cx: 0, cz: 0, facing: 0 });
    b.progress = 1;
    const directives = updateMissionRun(run, mission, world, queue, terrain);
    expect(run.eventsFired.size).toBeGreaterThan(before);
    expect(directives.some((d) => d.kind === 'message')).toBe(true);
  });

  it('a raid spawns AI units via the command queue and orders them next update', () => {
    const { mission, world, queue, terrain, run } = setup('northern-border');
    spawnUnit(world, 'engineer', MISSION_HUMAN_ID, 0, 0);
    const raidEvent = mission.events.find((e) => e.raid)!;
    world.tick = raidEvent.trigger.kind === 'atTick' ? raidEvent.trigger.tick : 0;
    const aiBefore = world.units.filter((u) => u.owner === MISSION_AI_ID).length;
    updateMissionRun(run, mission, world, queue, terrain);
    expect(queue.pendingCount()).toBeGreaterThan(0);
    queue.applyDue(world, world.tick);
    const aiAfter = world.units.filter((u) => u.owner === MISSION_AI_ID).length;
    expect(aiAfter - aiBefore).toBe(raidEvent.raid!.count);
    // Next update: the director finds the fresh units and moveGroups them.
    updateMissionRun(run, mission, world, queue, terrain);
    expect(queue.pendingCount()).toBeGreaterThan(0);
  });

  it('reports victory when a path completes, exactly once', () => {
    const { mission, world, queue, terrain, run } = setup('first-day');
    const player = getPlayer(world.city, MISSION_HUMAN_ID)!;
    player.population = 1000;
    // Complete every objective of the first path: build 2 houses + power plant.
    for (const [i, kind] of (['house', 'house', 'powerPlant'] as const).entries()) {
      const b = placeBuilding(world.city, { kind, owner: MISSION_HUMAN_ID, cx: i * 12, cz: 0, facing: 0 });
      b.progress = 1;
    }
    const d1 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d1.some((d) => d.kind === 'victory')).toBe(true);
    expect(run.wonPath).not.toBeNull();
    const d2 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d2).toHaveLength(0);
  });

  it('reports defeat when the player is wiped out, exactly once', () => {
    const { mission, world, queue, terrain, run } = setup('northern-border');
    world.tick = 120;
    const d1 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d1.some((d) => d.kind === 'defeat')).toBe(true);
    const d2 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d2).toHaveLength(0);
  });

  it('missionProgress reports per-path objective states', () => {
    const { mission, world, run } = setup('first-day');
    const progress = missionProgress(run, mission, world);
    expect(progress).toHaveLength(mission.paths.length);
    for (const p of progress) {
      expect(p.objectives).toHaveLength(p.path.objectives.length);
    }
  });

  it('kill/loss counters track unit disappearance by owner', () => {
    const { mission, world, queue, terrain, run } = setup('northern-border');
    const enemy = spawnUnit(world, 'rifles', MISSION_AI_ID, 0, 0);
    const mine = spawnUnit(world, 'rifles', MISSION_HUMAN_ID, 10, 10);
    world.tick = 61; // past the defeat grace period setup
    updateMissionRun(run, mission, world, queue, terrain);
    // Kill the enemy unit: remove it from the world.
    world.units.splice(world.units.findIndex((u) => u.id === enemy.id), 1);
    updateMissionRun(run, mission, world, queue, terrain);
    expect(run.kills).toBe(1);
    expect(run.unitsLost).toBe(0);
    world.units.splice(world.units.findIndex((u) => u.id === mine.id), 1);
    updateMissionRun(run, mission, world, queue, terrain);
    expect(run.unitsLost).toBe(1);
  });
});

describe('campaign/progress', () => {
  it('scoreMission rewards bloodless and lossless play, and combat', () => {
    expect(scoreMission(0, 0)).toEqual({ diplomat: 3, commander: 0 });
    expect(scoreMission(0, 2)).toEqual({ diplomat: 2, commander: 0 });
    expect(scoreMission(10, 0)).toEqual({ diplomat: 1, commander: 1 });
    expect(scoreMission(40, 5)).toEqual({ diplomat: 0, commander: 2 });
  });

  it('recordCompletion accumulates points and dedupes mission ids', () => {
    let p = emptyProgress();
    p = recordCompletion(p, 'first-day', 0, 0);
    expect(p.completed).toEqual(['first-day']);
    expect(p.diplomat).toBe(3);
    p = recordCompletion(p, 'first-day', 0, 0); // replay: points still count, id not duplicated
    expect(p.completed).toEqual(['first-day']);
    expect(p.diplomat).toBe(6);
  });

  it('unlocks mission 1 always; later missions after the previous completes', () => {
    const p = emptyProgress();
    const ordered = missionsInOrder();
    expect(isMissionUnlocked(p, ordered[0]!)).toBe(true);
    expect(isMissionUnlocked(p, ordered[1]!)).toBe(false);
    const p2 = recordCompletion(p, ordered[0]!.id, 0, 0);
    expect(isMissionUnlocked(p2, ordered[1]!)).toBe(true);
    expect(isMissionUnlocked(p2, ordered[2]!)).toBe(false);
  });

  it('campaignEnding picks peacemaker on ties', () => {
    expect(campaignEnding(emptyProgress())).toBe('peacemaker');
    expect(campaignEnding({ completed: [], diplomat: 5, commander: 5 })).toBe('peacemaker');
    expect(campaignEnding({ completed: [], diplomat: 4, commander: 6 })).toBe('commander');
  });

  it('memory store round-trips progress and resets', async () => {
    const store = await createCampaignStore();
    expect(store.backend === 'indexeddb' || store.backend === 'memory').toBe(true);
    const fresh = await store.load();
    expect(fresh).toEqual(emptyProgress());
    const p = recordCompletion(emptyProgress(), 'first-day', 3, 0);
    expect(await store.save(p)).toBe(true);
    const loaded = await store.load();
    expect(loaded).toEqual(p);
    expect(await store.reset()).toBe(true);
    expect(await store.load()).toEqual(emptyProgress());
  });
});
