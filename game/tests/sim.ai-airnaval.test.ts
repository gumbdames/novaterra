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
 * NOVATERRA — Classic AI air/naval work (grand-expansion Phase 5/6,
 * workstream D).
 *
 * Covers the AI side of the hangar + carrier + airport + naval
 * expansion:
 * - canTrain is hangar-aware: aircraft with a `hangarClass` train only
 *   while the AI has a free virtual hangar slot (PLAN §6: "virtual
 *   airfields get virtual capacity"); unknown unit kinds return false
 *   instead of crashing on `def.minAge`.
 * - The counter table's sub/capital sets include the §3.6 roster
 *   (coastalSub, missileSub, cruiser, battleship, heavyDestroyer).
 * - thinkCarrierWings / thinkCarrierEscorts / thinkAirlineRoutes /
 *   thinkNavalMines are callable and inert until the sibling
 *   workstreams' defs land (no crash, no commands, digest-neutral).
 * - isEmptyWingCarrier: a fresh carrier (empty 8-slot wing) is skipped
 *   by the attack loops — carriers never sail empty.
 * - Marshal construction priority lists civilAirport; the def-guard in
 *   thinkConstruction skips it until the airport workstream's def
 *   lands (no crash, no stall).
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { getAgeState } from '../src/sim/ages';
import {
  addAIPlayer,
  canTrain,
  thinkAirlineRoutes,
  thinkCarrierWings,
  thinkCarrierEscorts,
  thinkNavalMines,
  isEmptyWingCarrier,
  pickWingAircraftKind,
  SUB_KINDS,
  CAPITAL_KINDS,
  ESCORT_KINDS,
  CONSTRUCTION_PRIORITY,
} from '../src/sim/ai';
import { createCommandQueue } from '../src/sim/commands';
import { spawnUnit, UNIT_DEFS, type UnitKind } from '../src/sim/units';
import { BUILDING_DEFS } from '../src/sim/city';
import { digestWorld } from '../src/sim/digest';
import { grantAllTrainingResources } from './sim.roster-fixtures';

function makeWorldWithAI(seed: number, difficulty: 'commander' | 'marshal' = 'commander'): World {
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  addAIPlayer(world, 0, difficulty, 0, 0);
  return world;
}

describe('hangar-aware canTrain', () => {
  it('returns false for unknown kinds instead of crashing', () => {
    const world = makeWorldWithAI(11);
    expect(canTrain(world, 0, 'notARealKind' as UnitKind)).toBe(false);
  });

  it('gates aircraft with a hangarClass on free virtual slots', () => {
    const world = makeWorldWithAI(12);
    // navalFighter: hangarClass 'medium', requiredBuilding 'airfield',
    // minAge 'connectivity' (the aircraft workstream's real defs).
    getAgeState(world, 0).age = 'connectivity';
    const ai = world.ai.players[0]!;
    // No virtual airfield → no production building and no virtual
    // slots → cannot train.
    ai.virtualBuildings.completed = [];
    expect(canTrain(world, 0, 'navalFighter')).toBe(false);
    // A virtual airfield unlocks training and yields 6 generic virtual
    // slots (the legacy decode default) → room for one aircraft.
    ai.virtualBuildings.completed = ['airfield'];
    expect(canTrain(world, 0, 'navalFighter')).toBe(true);
    // Fill all 6 slots with parked navalFighters → no room left.
    for (let i = 0; i < 6; i++) spawnUnit(world, 'navalFighter', 0, 10 + i, 10);
    expect(canTrain(world, 0, 'navalFighter')).toBe(false);
  });

  it('embarked aircraft do not consume hangar slots', () => {
    const world = makeWorldWithAI(13);
    getAgeState(world, 0).age = 'connectivity';
    const ai = world.ai.players[0]!;
    ai.virtualBuildings.completed = ['airfield'];
    // Six navalFighters, all embarked on a carrier → all 6 virtual
    // slots still free.
    for (let i = 0; i < 6; i++) {
      const d = spawnUnit(world, 'navalFighter', 0, 10 + i, 10);
      d.embarkedOn = 999;
    }
    expect(canTrain(world, 0, 'navalFighter')).toBe(true);
  });
});

describe('counter-table kind sets', () => {
  it('SUB_KINDS covers the §3.6 submarine roster', () => {
    expect(SUB_KINDS.has('submarine')).toBe(true);
    expect(SUB_KINDS.has('coastalSub')).toBe(true);
    expect(SUB_KINDS.has('missileSub')).toBe(true);
    expect(SUB_KINDS.has('destroyer')).toBe(false);
  });

  it('CAPITAL_KINDS covers the §3.6 capital roster', () => {
    for (const k of ['destroyer', 'carrier', 'commandShip', 'cruiser', 'battleship', 'heavyDestroyer']) {
      expect(CAPITAL_KINDS.has(k)).toBe(true);
    }
    expect(CAPITAL_KINDS.has('submarine')).toBe(false);
  });

  it('ESCORT_KINDS is cheapest-first and def-guarded', () => {
    // Every entry either exists in the roster or is a future §3.6
    // kind; the pool filters through UNIT_DEFS at use.
    expect(ESCORT_KINDS[0]).toBe('frigate');
    expect(ESCORT_KINDS).toContain('corvette');
  });
});

describe('carrier / airline / mines thinks (pre-def inertness)', () => {
  it('thinkAirlineRoutes is digest-neutral (documented no-op hook)', () => {
    const world = makeWorldWithAI(21, 'marshal');
    const before = digestWorld(world);
    const queue = createCommandQueue();
    const ai = world.ai.players[0]!;
    thinkAirlineRoutes(world, ai);
    expect(digestWorld(world)).toBe(before);
    expect(queue).toBeDefined();
  });

  it('thinkCarrierWings is inert with no carrier-capable defs (no crash, no units)', () => {
    const world = makeWorldWithAI(22);
    const queue = createCommandQueue();
    const ai = world.ai.players[0]!;
    const unitsBefore = world.units.length;
    thinkCarrierWings(world, queue, ai);
    expect(world.units.length).toBe(unitsBefore);
  });

  it('thinkCarrierEscorts is inert with no carriers (no crash)', () => {
    const world = makeWorldWithAI(23);
    const queue = createCommandQueue();
    const ai = world.ai.players[0]!;
    const unitsBefore = world.units.length;
    thinkCarrierEscorts(world, queue, ai);
    expect(world.units.length).toBe(unitsBefore);
  });

  it('thinkNavalMines is a documented no-op (minesweeping deferred)', () => {
    const world = makeWorldWithAI(24);
    const before = digestWorld(world);
    thinkNavalMines(world, world.ai.players[0]!);
    expect(digestWorld(world)).toBe(before);
  });

  it('isEmptyWingCarrier: a fresh carrier never sails empty', () => {
    const world = makeWorldWithAI(25);
    const carrier = spawnUnit(world, 'carrier', 0, 50, 50);
    // The carrier def carries an empty 8-slot wing (workstream C) and
    // the roster has carrier-capable kinds (workstream B) → a fresh
    // carrier IS an empty-wing carrier, so the attack loops skip it
    // until thinkCarrierWings fills the wing.
    expect(UNIT_DEFS.carrier.wingCapacity).toBe(8);
    expect(isEmptyWingCarrier(world, carrier)).toBe(true);
    // Non-carriers are never empty-wing carriers.
    const tank = spawnUnit(world, 'tank', 0, 60, 60);
    expect(isEmptyWingCarrier(world, tank)).toBe(false);
  });
});

describe('marshal airport construction', () => {
  it('civilAirport is on the marshal priority list', () => {
    expect(CONSTRUCTION_PRIORITY.marshal).toContain('civilAirport');
  });

  it('the civilAirport def landed (airport workstream): civilian anchor with landing-fee income', () => {
    // The def-guard era is over — the airport workstream landed the
    // def, so this pins what the AI builds: a civilian airport whose
    // income flows through the economy (tax base + landing fees), the
    // static-airline-income half of PLAN §6's AI airport work.
    const def = BUILDING_DEFS.civilAirport;
    expect(def).toBeDefined();
    expect(def.airportType).toBe('civilian');
    expect(def.minAge).toBe('connectivity');
    // Marshal reaches connectivity (ages.ts advance path), so the
    // priority entry is live, not aspirational.
    expect(CONSTRUCTION_PRIORITY.marshal.indexOf('civilAirport')).toBeGreaterThan(-1);
  });
});

describe('carrier wing composition (final-review R5 H3)', () => {
  /** All four carrier-capable kinds, in def order. */
  const CAP_KINDS: UnitKind[] = ['reconUAV', 'armedUAV', 'trainer', 'navalFighter'].filter(
    (k): k is UnitKind => k in UNIT_DEFS,
  ) as UnitKind[];

  function wingWorld(): { world: World; carrierId: number } {
    const world = createWorld(99);
    const carrier = spawnUnit(world, 'carrier', 0, 100, 100);
    return { world, carrierId: carrier.id };
  }

  it('prefers armed kinds over unarmed ones (armed-first)', () => {
    const { world, carrierId } = wingWorld();
    const kind = pickWingAircraftKind(world, 0, carrierId, CAP_KINDS);
    // armedUAV (damage 45) must come before reconUAV/trainer even
    // though reconUAV is first in def order.
    expect(kind).toBe('armedUAV');
    expect((UNIT_DEFS[kind!] as { damage: number }).damage).toBeGreaterThan(0);
  });

  it('caps spotters at one per wing (embarked or converging)', () => {
    const { world, carrierId } = wingWorld();
    // A reconUAV already embarked on the carrier...
    const spotter = spawnUnit(world, 'reconUAV', 0, 100, 100);
    spotter.embarkedOn = carrierId;
    // ...and another converging (idle, no target, not embarked).
    const converging = spawnUnit(world, 'reconUAV', 0, 200, 200);
    expect(converging.state).toBe('idle');
    const kind = pickWingAircraftKind(world, 0, carrierId, CAP_KINDS);
    expect(kind).not.toBe('reconUAV');
    expect(kind).toBe('armedUAV');
  });

  it('returns null when the only kinds left are blocked spotters', () => {
    const { world, carrierId } = wingWorld();
    const spotter = spawnUnit(world, 'reconUAV', 0, 100, 100);
    spotter.embarkedOn = carrierId;
    expect(pickWingAircraftKind(world, 0, carrierId, ['reconUAV'])).toBeNull();
  });

  it('falls back to unarmed kinds when no armed kind is offered', () => {
    const { world, carrierId } = wingWorld();
    // Trainer is unarmed but a legitimate wing member (not a spotter).
    expect(pickWingAircraftKind(world, 0, carrierId, ['trainer'])).toBe('trainer');
  });

  it('is deterministic: same world state gives the same pick', () => {
    const a = wingWorld();
    const b = wingWorld();
    spawnUnit(a.world, 'armedUAV', 0, 100, 100).embarkedOn = a.carrierId;
    spawnUnit(b.world, 'armedUAV', 0, 100, 100).embarkedOn = b.carrierId;
    expect(pickWingAircraftKind(a.world, 0, a.carrierId, CAP_KINDS)).toBe(
      pickWingAircraftKind(b.world, 0, b.carrierId, CAP_KINDS),
    );
  });
});
