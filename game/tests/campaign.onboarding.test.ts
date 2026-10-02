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
 * NOVATERRA — tests/campaign.onboarding.test.ts — fun-audit C4
 * (2026-10-02): onboarding that teaches verbs and the economic mental
 * model.
 *
 * Covers:
 *  - the "fix a disconnected building" beat: `preplacedBuildings`
 *    support in session setup (refunded, complete, unpowered),
 *    the `onUnpoweredBuilding` / `onBuildingPowered` trigger kinds,
 *    and `requiresEvent` gating;
 *  - the M1 data: the dark house, the warning/payoff events, and the
 *    economy-literacy moment;
 *  - the skirmish right-click verbs hint string.
 *
 * No RNG: mission events are pure world-state checks, so every test is
 * deterministic by construction.
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCommandQueue } from '../src/sim/commands';
import { generateTerrain, getMapPreset } from '../src/sim/terrain';
import { getPlayer, placeBuilding, BUILDING_DEFS } from '../src/sim/city';
import {
  getMission,
  type MissionDef,
  type MissionEventDef,
} from '../src/campaign/missions';
import {
  createMissionRun,
  updateMissionRun,
  MISSION_HUMAN_ID,
} from '../src/campaign/director';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { STRINGS } from '../src/ui/strings';

/** Minimal mission carrying only the events under test. */
function miniMission(events: MissionEventDef[]): MissionDef {
  const base = getMission('first-day')!;
  return { ...base, id: 'test-mini', events };
}

function setup(events: MissionEventDef[]) {
  const mission = miniMission(events);
  const world = createWorld(20261002);
  const queue = createCommandQueue();
  const preset = getMapPreset(mission.mapPreset);
  const terrain = generateTerrain(preset.seed, preset);
  const run = createMissionRun(mission, world);
  return { mission, world, queue, terrain, run };
}

/** A complete player-owned house; powered by default. */
function completeHouse(world: ReturnType<typeof createWorld>, powered = true) {
  const b = placeBuilding(world.city, {
    kind: 'house',
    owner: MISSION_HUMAN_ID,
    cx: 10,
    cz: 10,
    facing: 0,
  });
  b.progress = 1;
  b.operational = true;
  b.powered = powered;
  return b;
}

describe('requiresEvent', () => {
  it('gates an event on another event having fired', () => {
    const { mission, world, queue, terrain, run } = setup([
      { id: 'first', trigger: { kind: 'atTick', tick: 10 }, message: 'first' },
      {
        id: 'second',
        trigger: { kind: 'atTick', tick: 10 },
        requiresEvent: 'first',
        message: 'second',
      },
    ]);
    world.tick = 10;
    // Both triggers are true at tick 10 and events are checked in
    // array order: 'first' fires, then 'second' sees it fired.
    const d = updateMissionRun(run, mission, world, queue, terrain);
    const texts = d.filter((x) => x.kind === 'message').map((x) => (x as { text: string }).text);
    expect(texts).toEqual(['first', 'second']);
  });

  it('withholds the event until the required one fires', () => {
    const { mission, world, queue, terrain, run } = setup([
      { id: 'first', trigger: { kind: 'atTick', tick: 100 }, message: 'first' },
      {
        id: 'second',
        trigger: { kind: 'atTick', tick: 10 },
        requiresEvent: 'first',
        message: 'second',
      },
    ]);
    world.tick = 10;
    const d1 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d1.some((d) => d.kind === 'message')).toBe(false);
    world.tick = 100;
    const d2 = updateMissionRun(run, mission, world, queue, terrain);
    const texts = d2.filter((x) => x.kind === 'message').map((x) => (x as { text: string }).text);
    expect(texts).toEqual(['first', 'second']);
  });
});

describe('onUnpoweredBuilding / onBuildingPowered', () => {
  const warning: MissionEventDef = {
    id: 'dark',
    trigger: { kind: 'onUnpoweredBuilding' },
    message: 'dark',
  };
  const payoff: MissionEventDef = {
    id: 'lit',
    trigger: { kind: 'onBuildingPowered' },
    requiresEvent: 'dark',
    message: 'lit',
  };

  it('fires the warning for a dark building, then the payoff when lit', () => {
    const { mission, world, queue, terrain, run } = setup([warning, payoff]);
    const b = completeHouse(world, false);
    const d1 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d1.some((d) => d.kind === 'message' && (d as { text: string }).text === 'dark')).toBe(true);
    expect(run.sawUnpowered).toBe(true);
    // Still dark: no payoff.
    const d2 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d2.some((d) => d.kind === 'message' && (d as { text: string }).text === 'lit')).toBe(false);
    // Player connects power: the payoff fires exactly once.
    b.powered = true;
    const d3 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d3.some((d) => d.kind === 'message' && (d as { text: string }).text === 'lit')).toBe(true);
    const d4 = updateMissionRun(run, mission, world, queue, terrain);
    expect(d4.some((d) => d.kind === 'message')).toBe(false);
  });

  it('ignores buildings still under construction', () => {
    const { mission, world, queue, terrain, run } = setup([warning]);
    const b = placeBuilding(world.city, {
      kind: 'house',
      owner: MISSION_HUMAN_ID,
      cx: 10,
      cz: 10,
      facing: 0,
    });
    b.powered = false; // unfinished and unpowered: not "dark", just unfinished
    const d = updateMissionRun(run, mission, world, queue, terrain);
    expect(d.some((x) => x.kind === 'message')).toBe(false);
  });

  it('the payoff never fires without the warning', () => {
    const { mission, world, queue, terrain, run } = setup([payoff]);
    completeHouse(world, true);
    const d = updateMissionRun(run, mission, world, queue, terrain);
    expect(d.some((x) => x.kind === 'message')).toBe(false);
  });
});

describe('M1 onboarding data', () => {
  it('pre-places one dark house and wires the beat events', () => {
    const m1 = getMission('first-day')!;
    expect(m1.preplacedBuildings).toEqual([{ kind: 'house', dx: 14, dz: -10 }]);
    const byId = new Map(m1.events.map((e) => [e.id, e]));
    const disconnected = byId.get('m1-disconnected')!;
    expect(disconnected.trigger).toEqual({ kind: 'onUnpoweredBuilding' });
    expect(disconnected.requiresEvent).toBe('m1-welcome');
    const reconnected = byId.get('m1-reconnected')!;
    expect(reconnected.trigger).toEqual({ kind: 'onBuildingPowered' });
    expect(reconnected.requiresEvent).toBe('m1-disconnected');
    const economy = byId.get('m1-economy')!;
    expect(economy.trigger.kind).toBe('atTick');
    // The economy moment teaches the four-resource mental model.
    for (const word of ['FUNDS', 'MATERIALS', 'MANPOWER', 'FOOD']) {
      expect(economy.message).toContain(word);
    }
  });

  it('preplaced building kinds are real building kinds', () => {
    for (const m of [getMission('first-day')!]) {
      for (const pb of m.preplacedBuildings ?? []) {
        expect(BUILDING_DEFS[pb.kind], `${m.id} preplaced ${pb.kind}`).toBeDefined();
      }
    }
  });
});

describe('session preplaced buildings', () => {
  it('M1 starts with a refunded, complete, unpowered house', () => {
    const m1 = getMission('first-day')!;
    const session = createSession({ seed: 4242, campaignMission: m1 });
    const world = session.world;
    const houses = world.city.buildings.filter(
      (b) => b.owner === HUMAN_PLAYER_ID && b.kind === 'house' && b.progress >= 1,
    );
    expect(houses.length).toBeGreaterThanOrEqual(1);
    const dark = houses.find((b) => b.powered !== true);
    expect(dark).toBeDefined();
    expect(dark!.operational).toBe(true);
    // Refunded: the same seed without the preplaced building leaves
    // the exact same opening stockpile (the mission grant is free).
    const bare = createSession({
      seed: 4242,
      campaignMission: { ...m1, id: 'bare', preplacedBuildings: undefined },
    });
    const withFunds = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    const bareFunds = getPlayer(bare.world.city, HUMAN_PLAYER_ID)!;
    expect(withFunds.funds).toBe(bareFunds.funds);
    expect(withFunds.materials).toBe(bareFunds.materials);
    // The dark house sits near the player's base corner (-180, 180):
    // cell coords * 2 = world units, within a short walk of the base.
    const hx = dark!.cx * 2 - 256;
    const hz = dark!.cz * 2 - 256;
    const dist2 = (hx + 180) * (hx + 180) + (hz - 180) * (hz - 180);
    expect(dist2).toBeLessThan(80 * 80);
  });
});

describe('skirmish verbs hint', () => {
  it('names the three right-click verbs', () => {
    const hint = STRINGS.verbsHint.hint.en;
    expect(hint).toContain('move');
    expect(hint).toContain('attack');
    expect(hint).toContain('siege');
    expect(hint).toContain('Right-click');
  });
});
