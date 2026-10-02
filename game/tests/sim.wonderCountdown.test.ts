/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3.0 of the License.
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
 * NOVATERRA — fun-audit B2: the wonder countdown (2026-10-02).
 *
 * Pinned here:
 *  - trigger: completed Monument, or 80% of the economic (80,000
 *    funds) / population (8,000 housed) threshold — for either side;
 *  - no trigger below 80%, in peaceful worlds, or for conquest;
 *  - the leader must defend: dropping below the trigger cancels;
 *  - expiry: the leader wins while they qualify; the rival can steal
 *    it by qualifying at expiry (e.g. their own Monument);
 *  - monument completion starts the countdown — it is NOT an instant
 *    win; economic/population keep the instant win at 100%;
 *  - the countdown is deterministic (pure functions of world state),
 *    digest-covered, and survives a snapshot round-trip (legacy
 *    snapshots decode to null).
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import { getPlayer } from '../src/sim/city';
import { canonicalizeWorld } from '../src/sim/digest';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import {
  ECONOMIC_VICTORY_FUNDS,
  POPULATION_VICTORY_POP,
  WONDER_COUNTDOWN_TICKS,
  WONDER_COUNTDOWN_FRACTION,
  meetsWonderTrigger,
  checkWonderCountdownVictory,
  createWonderCountdownSystem,
} from '../src/sim/wonderCountdown';

const HUMAN = 0;
const AI = 1;

function raceWorld(kind: 'economic' | 'population' | 'monument'): World {
  const world = createWorld(1234);
  world.victoryKind = kind;
  return world;
}

function setFunds(world: World, owner: number, funds: number): void {
  const p = getPlayer(world.city, owner);
  if (p) p.funds = funds;
}

function addMonument(world: World, owner: number, progress: number): void {
  world.city.buildings.push({
    id: world.nextId++,
    kind: 'monument',
    owner,
    x: 10,
    z: 10,
    progress,
    operational: true,
    hp: 1000,
  } as unknown as (typeof world.city.buildings)[number]);
}

describe('wonder countdown triggers', () => {
  it('starts when the human crosses 80% of the economic threshold', () => {
    const world = raceWorld('economic');
    setFunds(world, HUMAN, ECONOMIC_VICTORY_FUNDS * WONDER_COUNTDOWN_FRACTION);
    const system = createWonderCountdownSystem();
    system(world, 1 / 30);
    expect(world.wonderCountdown).not.toBeNull();
    expect(world.wonderCountdown?.kind).toBe('economic');
    expect(world.wonderCountdown?.leader).toBe(HUMAN);
    expect(world.wonderCountdown?.endsAtTick).toBe(WONDER_COUNTDOWN_TICKS);
  });

  it('does not start below 80%', () => {
    const world = raceWorld('economic');
    setFunds(world, HUMAN, ECONOMIC_VICTORY_FUNDS * WONDER_COUNTDOWN_FRACTION - 1);
    createWonderCountdownSystem()(world, 1 / 30);
    expect(world.wonderCountdown).toBeNull();
  });

  it('the richer side leads when both cross', () => {
    const world = raceWorld('economic');
    setFunds(world, HUMAN, 85_000);
    setFunds(world, AI, 90_000);
    createWonderCountdownSystem()(world, 1 / 30);
    expect(world.wonderCountdown?.leader).toBe(AI);
  });

  it('starts on a completed monument', () => {
    const world = raceWorld('monument');
    addMonument(world, AI, 1);
    createWonderCountdownSystem()(world, 1 / 30);
    expect(world.wonderCountdown?.kind).toBe('monument');
    expect(world.wonderCountdown?.leader).toBe(AI);
  });

  it('an incomplete monument does not trigger', () => {
    const world = raceWorld('monument');
    addMonument(world, HUMAN, 0.5);
    createWonderCountdownSystem()(world, 1 / 30);
    expect(world.wonderCountdown).toBeNull();
  });

  it('never triggers for conquest or peaceful worlds', () => {
    const conquest = createWorld(1);
    conquest.victoryKind = 'conquest';
    setFunds(conquest, HUMAN, 200_000);
    createWonderCountdownSystem()(conquest, 1 / 30);
    expect(conquest.wonderCountdown).toBeNull();

    const peaceful = raceWorld('economic');
    peaceful.peaceful = true;
    setFunds(peaceful, HUMAN, 200_000);
    createWonderCountdownSystem()(peaceful, 1 / 30);
    expect(peaceful.wonderCountdown).toBeNull();
  });
});

describe('wonder countdown lifecycle', () => {
  it('cancels when the leader drops below the trigger', () => {
    const world = raceWorld('economic');
    setFunds(world, HUMAN, 85_000);
    const system = createWonderCountdownSystem();
    system(world, 1 / 30);
    expect(world.wonderCountdown).not.toBeNull();
    setFunds(world, HUMAN, 10_000);
    system(world, 1 / 30);
    expect(world.wonderCountdown).toBeNull();
  });

  it('cancels when the monument falls', () => {
    const world = raceWorld('monument');
    addMonument(world, HUMAN, 1);
    const system = createWonderCountdownSystem();
    system(world, 1 / 30);
    expect(world.wonderCountdown).not.toBeNull();
    world.city.buildings.length = 0;
    system(world, 1 / 30);
    expect(world.wonderCountdown).toBeNull();
  });

  it('the leader wins at expiry while they qualify', () => {
    const world = raceWorld('economic');
    setFunds(world, HUMAN, 85_000);
    createWonderCountdownSystem()(world, 1 / 30);
    world.tick = WONDER_COUNTDOWN_TICKS;
    expect(checkWonderCountdownVictory(world)).toBe(HUMAN);
  });

  it('no verdict before expiry', () => {
    const world = raceWorld('economic');
    setFunds(world, HUMAN, 85_000);
    createWonderCountdownSystem()(world, 1 / 30);
    world.tick = WONDER_COUNTDOWN_TICKS - 1;
    expect(checkWonderCountdownVictory(world)).toBeNull();
  });

  it('the rival steals it by qualifying at expiry', () => {
    const world = raceWorld('monument');
    addMonument(world, HUMAN, 1);
    createWonderCountdownSystem()(world, 1 / 30);
    // Human monument falls, rival completes theirs on the last tick.
    world.city.buildings.length = 0;
    addMonument(world, AI, 1);
    world.tick = WONDER_COUNTDOWN_TICKS;
    expect(checkWonderCountdownVictory(world)).toBe(AI);
  });

  it('meetsWonderTrigger is a pure predicate', () => {
    const world = raceWorld('population');
    const p = getPlayer(world.city, HUMAN);
    if (p) {
      p.population = Math.ceil(POPULATION_VICTORY_POP * WONDER_COUNTDOWN_FRACTION);
      p.peakPopulation = p.population;
    }
    expect(meetsWonderTrigger(world, 'population', HUMAN)).toBe(true);
    expect(meetsWonderTrigger(world, 'population', AI)).toBe(false);
  });
});

describe('wonder countdown determinism surface', () => {
  it('is digest-covered (active vs idle differ)', () => {
    const idle = raceWorld('economic');
    const active = raceWorld('economic');
    setFunds(active, HUMAN, 85_000);
    createWonderCountdownSystem()(active, 1 / 30);
    expect(canonicalizeWorld(active)).not.toBe(canonicalizeWorld(idle));
    expect(canonicalizeWorld(active)).toContain('|wonder=economic,0,');
  });

  it('survives a snapshot round-trip', () => {
    const world = raceWorld('economic');
    setFunds(world, HUMAN, 85_000);
    createWonderCountdownSystem()(world, 1 / 30);
    world.tick = 1234;
    const restored = restoreSnapshot(takeSnapshot(world));
    expect(restored.wonderCountdown).toEqual(world.wonderCountdown);
    expect(canonicalizeWorld(restored)).toBe(canonicalizeWorld(world));
  });

  it('legacy snapshots (no field) decode to null', () => {
    const world = raceWorld('economic');
    const snap = takeSnapshot(world) as unknown as Record<string, unknown>;
    delete snap['wonderCountdown'];
    const restored = restoreSnapshot(snap as never);
    expect(restored.wonderCountdown).toBeNull();
  });

  it('corrupt countdown values decode to null', () => {
    const world = raceWorld('economic');
    const snap = takeSnapshot(world) as unknown as Record<string, unknown>;
    snap['wonderCountdown'] = { kind: 'conquest', leader: 'x', endsAtTick: NaN };
    const restored = restoreSnapshot(snap as never);
    expect(restored.wonderCountdown).toBeNull();
  });
});
