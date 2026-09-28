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
 * NOVATERRA — adaptive music mood tests (Phase 1, step 10).
 *
 * `selectMood` is a pure function of game state; `moodInputFromWorld`
 * derives that state from a sim world. The Web Audio `MusicDirector`
 * (playback, crossfades) is not tested here — no Web Audio in Node.
 */
import { describe, expect, it } from 'vitest';
import { moodInputFromWorld, selectMood } from '../src/audio/music';
import { createWorld } from '../src/sim/world';
import { spawnUnit } from '../src/sim/units';

const PLAYER = 1;
const ENEMY = 2;

describe('selectMood', () => {
  it('is peace when nothing is fighting', () => {
    expect(selectMood({ playerUnitsInCombat: false })).toBe('peace');
  });

  it('is war when player units are in combat', () => {
    expect(selectMood({ playerUnitsInCombat: true })).toBe('war');
  });
});

describe('moodInputFromWorld', () => {
  it('reports no combat in a fresh world', () => {
    const world = createWorld(42);
    expect(moodInputFromWorld(world, PLAYER)).toEqual({ playerUnitsInCombat: false });
  });

  it('reports no combat when units are idle', () => {
    const world = createWorld(42);
    spawnUnit(world, 'rifles', PLAYER, 10, 10);
    spawnUnit(world, 'tank', ENEMY, 100, 100);
    expect(moodInputFromWorld(world, PLAYER).playerUnitsInCombat).toBe(false);
  });

  it('reports combat when a player unit has a live target', () => {
    const world = createWorld(42);
    const attacker = spawnUnit(world, 'rifles', PLAYER, 10, 10);
    const target = spawnUnit(world, 'rifles', ENEMY, 12, 10);
    attacker.targetId = target.id;
    expect(moodInputFromWorld(world, PLAYER).playerUnitsInCombat).toBe(true);
  });

  it('ignores dead targets', () => {
    const world = createWorld(42);
    const attacker = spawnUnit(world, 'rifles', PLAYER, 10, 10);
    const target = spawnUnit(world, 'rifles', ENEMY, 12, 10);
    target.hp = 0;
    attacker.targetId = target.id;
    expect(moodInputFromWorld(world, PLAYER).playerUnitsInCombat).toBe(false);
  });

  it('ignores combat that does not involve the player', () => {
    const world = createWorld(42);
    const a = spawnUnit(world, 'rifles', ENEMY, 10, 10);
    const b = spawnUnit(world, 'rifles', 3, 12, 10);
    a.targetId = b.id;
    expect(moodInputFromWorld(world, PLAYER).playerUnitsInCombat).toBe(false);
  });

  it('ignores dead player units', () => {
    const world = createWorld(42);
    const attacker = spawnUnit(world, 'rifles', PLAYER, 10, 10);
    const target = spawnUnit(world, 'rifles', ENEMY, 12, 10);
    attacker.hp = 0;
    attacker.targetId = target.id;
    expect(moodInputFromWorld(world, PLAYER).playerUnitsInCombat).toBe(false);
  });
});
