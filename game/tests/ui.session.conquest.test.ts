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
 * NOVATERRA — skirmish conquest outcome tests (0.1 Alpha).
 *
 * `checkSkirmishVictory` / `checkSkirmishDefeat` are pure functions of
 * world state; `getSkirmishOutcome` adds the grace period and the
 * mutual-elimination tiebreak (defeat takes precedence). The game
 * controller (game.ts, DOM-dependent) calls `getSkirmishOutcome` once
 * per frame and shows the end screen one-shot — that wiring is covered
 * by inspection, not by these headless tests.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PLAYER_ID,
  checkSkirmishDefeat,
  checkSkirmishVictory,
  CONQUEST_GRACE_TICKS,
  createSession,
  getSkirmishOutcome,
  HUMAN_PLAYER_ID,
} from '../src/ui/session';
import type { BuildingRecord } from '../src/sim/city';
import type { World } from '../src/sim/world';

/** A fresh two-player skirmish world (tick 1 after starting forces). */
function freshWorld(): World {
  return createSession({ seed: 4242 }).world;
}

/** Remove every unit and building belonging to `owner`. */
function eliminate(world: World, owner: number): void {
  world.units = world.units.filter((u) => u.owner !== owner);
  world.city.buildings = world.city.buildings.filter((b) => b.owner !== owner);
}

function playerBuilding(): BuildingRecord {
  return {
    id: 9001,
    kind: 'house',
    owner: HUMAN_PLAYER_ID,
    cx: 10,
    cz: 10,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  };
}

describe('checkSkirmishDefeat', () => {
  it('is false for a fresh session: the player has starting forces', () => {
    const world = freshWorld();
    expect(world.units.some((u) => u.owner === HUMAN_PLAYER_ID)).toBe(true);
    expect(checkSkirmishDefeat(world)).toBe(false);
  });

  it('is true when the player has no units and no buildings', () => {
    const world = freshWorld();
    eliminate(world, HUMAN_PLAYER_ID);
    expect(checkSkirmishDefeat(world)).toBe(true);
  });

  it('is false when the player keeps a building but loses all units', () => {
    const world = freshWorld();
    world.units = world.units.filter((u) => u.owner !== HUMAN_PLAYER_ID);
    world.city.buildings.push(playerBuilding());
    expect(checkSkirmishDefeat(world)).toBe(false);
  });

  it('is false when the player keeps a unit but loses all buildings', () => {
    const world = freshWorld();
    eliminate(world, HUMAN_PLAYER_ID);
    // Give the player one survivor back.
    const rival = freshWorld().units.find((u) => u.owner === AI_PLAYER_ID)!;
    world.units.push({ ...rival, owner: HUMAN_PLAYER_ID, id: 9002 });
    expect(checkSkirmishDefeat(world)).toBe(false);
  });
});

describe('checkSkirmishVictory', () => {
  it('is false for a fresh session: the rival has starting forces', () => {
    const world = freshWorld();
    expect(checkSkirmishVictory(world)).toBe(false);
  });

  it('is true when the rival has no units and no buildings', () => {
    const world = freshWorld();
    eliminate(world, AI_PLAYER_ID);
    expect(checkSkirmishVictory(world)).toBe(true);
    // …and the player is NOT defeated while still standing.
    expect(checkSkirmishDefeat(world)).toBe(false);
  });
});

describe('getSkirmishOutcome', () => {
  it('exposes the grace period as a named constant (30 ticks)', () => {
    expect(CONQUEST_GRACE_TICKS).toBe(30);
  });

  it('returns null during the grace period even when the player is eliminated', () => {
    const world = freshWorld();
    eliminate(world, HUMAN_PLAYER_ID);
    expect(world.tick).toBeLessThan(CONQUEST_GRACE_TICKS);
    expect(getSkirmishOutcome(world)).toBeNull();
  });

  it('returns null during the grace period even when the rival is eliminated', () => {
    const world = freshWorld();
    eliminate(world, AI_PLAYER_ID);
    expect(getSkirmishOutcome(world)).toBeNull();
  });

  it('returns defeat once past the grace period with the player eliminated', () => {
    const world = freshWorld();
    eliminate(world, HUMAN_PLAYER_ID);
    world.tick = CONQUEST_GRACE_TICKS;
    expect(getSkirmishOutcome(world)).toBe('defeat');
  });

  it('returns victory once past the grace period with the rival eliminated', () => {
    const world = freshWorld();
    eliminate(world, AI_PLAYER_ID);
    world.tick = CONQUEST_GRACE_TICKS;
    expect(getSkirmishOutcome(world)).toBe('victory');
  });

  it('returns null while both sides still hold forces', () => {
    const world = freshWorld();
    world.tick = CONQUEST_GRACE_TICKS;
    expect(getSkirmishOutcome(world)).toBeNull();
  });

  it('defeat takes precedence when both sides are eliminated on the same tick', () => {
    const world = freshWorld();
    eliminate(world, HUMAN_PLAYER_ID);
    eliminate(world, AI_PLAYER_ID);
    world.tick = CONQUEST_GRACE_TICKS;
    // Both raw checks agree both sides are gone…
    expect(checkSkirmishDefeat(world)).toBe(true);
    expect(checkSkirmishVictory(world)).toBe(true);
    // …but the combined outcome reports defeat: the player must survive
    // their victory to claim it.
    expect(getSkirmishOutcome(world)).toBe('defeat');
  });
});
