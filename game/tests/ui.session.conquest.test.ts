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
  isHumanWarCoreFallen,
} from '../src/ui/session';
import type { BuildingRecord } from '../src/sim/city';
import { placeBuilding } from '../src/sim/city';
import { createWonderCountdownSystem } from '../src/sim/wonderCountdown';
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

/** A surviving player military building (the "capital" war core, B8). */
function playerMilitaryBuilding(): BuildingRecord {
  return {
    id: 9003,
    kind: 'barracks',
    owner: HUMAN_PLAYER_ID,
    cx: 12,
    cz: 12,
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

  it('is TRUE when the player keeps only civilian buildings but loses all units and the war core (B8)', () => {
    // Roadmap B8: the war-weariness short-circuit. Zero units plus a
    // destroyed capital (no military building left) ends the game even
    // when value-10 houses still stand — no more bulldozing grind.
    const world = freshWorld();
    world.units = world.units.filter((u) => u.owner !== HUMAN_PLAYER_ID);
    world.city.buildings.push(playerBuilding()); // civilian house only
    expect(checkSkirmishDefeat(world)).toBe(true);
  });

  it('is false when the player keeps a military building but loses all units (B8)', () => {
    // The war core survives: the player can still rebuild, so the game
    // honestly continues.
    const world = freshWorld();
    world.units = world.units.filter((u) => u.owner !== HUMAN_PLAYER_ID);
    world.city.buildings.push(playerMilitaryBuilding());
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

// ---------------------------------------------------------------------------
// Roadmap B2 (2026-10-02): alternative skirmish victories
// ---------------------------------------------------------------------------

import {
  ECONOMIC_VICTORY_FUNDS,
  POPULATION_VICTORY_POP,
  SKIRMISH_VICTORY_KINDS,
} from '../src/ui/session';
import type { SkirmishVictoryKind } from '../src/sim/world';
import { takeSnapshot, restoreSnapshot, type Snapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { getPlayer } from '../src/sim/city';

/** A fresh world with the given victory kind (tick 1 after starting forces). */
function victoryWorld(kind: SkirmishVictoryKind): World {
  return createSession({ seed: 4242, victoryKind: kind }).world;
}

function setFunds(world: World, owner: number, funds: number): void {
  getPlayer(world.city, owner)!.funds = funds;
}

function setPopulation(world: World, owner: number, population: number): void {
  getPlayer(world.city, owner)!.population = population;
}

function monument(owner: number, progress: number): BuildingRecord {
  return {
    ...playerBuilding(),
    id: 9100 + owner,
    kind: 'monument',
    owner,
    progress,
  };
}

describe('alternative skirmish victories (roadmap B2)', () => {
  it('defaults to conquest: the classic checks are unchanged', () => {
    const world = freshWorld();
    expect(world.victoryKind).toBe('conquest');
    expect(checkSkirmishVictory(world)).toBe(false);
    eliminate(world, AI_PLAYER_ID);
    expect(checkSkirmishVictory(world)).toBe(true);
  });

  it('resolves an unknown victory kind to conquest', () => {
    const world = createSession({
      seed: 4242,
      victoryKind: 'space-race' as SkirmishVictoryKind,
    }).world;
    expect(world.victoryKind).toBe('conquest');
  });

  it('economic: first to 100,000 funds wins, symmetric for the rival', () => {
    expect(ECONOMIC_VICTORY_FUNDS).toBe(100_000);
    const world = victoryWorld('economic');
    setFunds(world, HUMAN_PLAYER_ID, 99_999);
    expect(checkSkirmishVictory(world)).toBe(false);
    setFunds(world, HUMAN_PLAYER_ID, 100_000);
    expect(checkSkirmishVictory(world)).toBe(true);
    // Wiping the rival's army no longer wins an economic game.
    const conquestOnly = victoryWorld('economic');
    eliminate(conquestOnly, AI_PLAYER_ID);
    expect(checkSkirmishVictory(conquestOnly)).toBe(false);
    // The rival reaching the threshold first is a defeat.
    const defeat = victoryWorld('economic');
    setFunds(defeat, AI_PLAYER_ID, 100_000);
    expect(checkSkirmishDefeat(defeat)).toBe(true);
    expect(checkSkirmishVictory(defeat)).toBe(false);
  });

  it('population: first to 10,000 housed wins, symmetric for the rival', () => {
    expect(POPULATION_VICTORY_POP).toBe(10_000);
    const world = victoryWorld('population');
    setPopulation(world, HUMAN_PLAYER_ID, 9_999);
    expect(checkSkirmishVictory(world)).toBe(false);
    setPopulation(world, HUMAN_PLAYER_ID, 10_000);
    expect(checkSkirmishVictory(world)).toBe(true);
    const defeat = victoryWorld('population');
    setPopulation(defeat, AI_PLAYER_ID, 10_000);
    expect(checkSkirmishDefeat(defeat)).toBe(true);
  });

  it('monument: completion starts the countdown — survival wins, not completion', () => {
    // Fun-audit B2 (2026-10-02): the instant win on completion is
    // gone — completing the Monument starts the 5-minute countdown,
    // and surviving it wins (the game's documented design).
    const world = victoryWorld('monument');
    world.city.buildings.push(monument(HUMAN_PLAYER_ID, 0.5));
    expect(checkSkirmishVictory(world)).toBe(false);
    world.city.buildings.push(monument(HUMAN_PLAYER_ID, 1));
    expect(checkSkirmishVictory(world)).toBe(false);
    createWonderCountdownSystem()(world, 1 / 30);
    expect(world.wonderCountdown).not.toBeNull();
    expect(checkSkirmishVictory(world)).toBe(false);
    world.tick = world.wonderCountdown?.endsAtTick ?? 0;
    expect(checkSkirmishVictory(world)).toBe(true);
    // The rival's monument is the rival's win, not the player's.
    const rival = victoryWorld('monument');
    rival.city.buildings.push(monument(AI_PLAYER_ID, 1));
    expect(checkSkirmishVictory(rival)).toBe(false);
    createWonderCountdownSystem()(rival, 1 / 30);
    rival.tick = rival.wonderCountdown?.endsAtTick ?? 0;
    expect(checkSkirmishVictory(rival)).toBe(false);
    expect(checkSkirmishDefeat(rival)).toBe(true);
  });

  it('peaceful worlds ignore every victory kind (still endless)', () => {
    for (const kind of SKIRMISH_VICTORY_KINDS) {
      const world = createSession({ seed: 4242, peaceful: true, victoryKind: kind }).world;
      setFunds(world, HUMAN_PLAYER_ID, 1_000_000);
      setPopulation(world, HUMAN_PLAYER_ID, 1_000_000);
      world.city.buildings.push(monument(HUMAN_PLAYER_ID, 1));
      expect(checkSkirmishVictory(world)).toBe(false);
      expect(checkSkirmishDefeat(world)).toBe(false);
      expect(getSkirmishOutcome(world)).toBeNull();
    }
  });

  it('the kind round-trips through snapshots', () => {
    const world = victoryWorld('economic');
    const restored = restoreSnapshot(takeSnapshot(world));
    expect(restored.victoryKind).toBe('economic');
  });

  it('a legacy snapshot without the field decodes to conquest', () => {
    const world = victoryWorld('economic');
    const snap = takeSnapshot(world) as unknown as Record<string, unknown>;
    delete snap['victoryKind'];
    const restored = restoreSnapshot(snap as unknown as Snapshot);
    expect(restored.victoryKind).toBe('conquest');
  });

  it('a corrupt snapshot victory kind falls back to conquest', () => {
    const world = victoryWorld('monument');
    const snap = takeSnapshot(world) as unknown as Record<string, unknown>;
    snap['victoryKind'] = 'total-war';
    const restored = restoreSnapshot(snap as unknown as Parameters<typeof restoreSnapshot>[0]);
    expect(restored.victoryKind).toBe('conquest');
  });

  it('the kind is digest-covered: different kinds digest differently', () => {
    const a = victoryWorld('conquest');
    const b = victoryWorld('economic');
    expect(digestWorld(a)).not.toBe(digestWorld(b));
  });
});

describe('isHumanWarCoreFallen (fun-audit A4)', () => {
  /** Remove every unit belonging to the human player (army wiped out). */
  function wipeHumanArmy(world: World): void {
    world.units = world.units.filter((u) => u.owner !== HUMAN_PLAYER_ID);
  }

  it('is false while the human military still stands', () => {
    expect(isHumanWarCoreFallen(freshWorld())).toBe(false);
  });

  it('is true when the army is gone and only civilian buildings remain', () => {
    const world = freshWorld();
    // A standing civilian city...
    placeBuilding(world.city, { kind: 'house', owner: HUMAN_PLAYER_ID, cx: 10, cz: 10, facing: 0 });
    // ...but the whole army is gone and no military building was built.
    wipeHumanArmy(world);
    expect(isHumanWarCoreFallen(world)).toBe(true);
  });

  it('is false when a military building survives (the player can rebuild)', () => {
    const world = freshWorld();
    placeBuilding(world.city, { kind: 'barracks', owner: HUMAN_PLAYER_ID, cx: 10, cz: 10, facing: 0 });
    wipeHumanArmy(world);
    expect(isHumanWarCoreFallen(world)).toBe(false);
  });

  it('is always false in peaceful worlds', () => {
    const world = createSession({ seed: 7, peaceful: true }).world;
    placeBuilding(world.city, { kind: 'house', owner: HUMAN_PLAYER_ID, cx: 10, cz: 10, facing: 0 });
    wipeHumanArmy(world);
    expect(isHumanWarCoreFallen(world)).toBe(false);
  });
});
