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
import {
  enemiesNearAssets,
  enemyProximityFromWorld,
  moodInputFromWorld,
  selectMood,
  TENSION_RADIUS,
} from '../src/audio/music';
import { createWorld } from '../src/sim/world';
import { spawnUnit } from '../src/sim/units';

const PLAYER = 1;
const ENEMY = 2;

describe('selectMood', () => {
  it('is peace when nothing is fighting and no enemies are near', () => {
    expect(selectMood({ playerUnitsInCombat: false })).toBe('peace');
    expect(
      selectMood({ playerUnitsInCombat: false, enemiesNear: false }),
    ).toBe('peace');
  });

  it('is war when player units are in combat', () => {
    expect(selectMood({ playerUnitsInCombat: true })).toBe('war');
    // War wins over tension.
    expect(
      selectMood({ playerUnitsInCombat: true, enemiesNear: true }),
    ).toBe('war');
  });

  it('is tension when enemies are near but no fight has started', () => {
    expect(
      selectMood({ playerUnitsInCombat: false, enemiesNear: true }),
    ).toBe('tension');
  });
});

describe('moodInputFromWorld', () => {
  it('reports no combat and no proximity in a fresh world', () => {
    const world = createWorld(42);
    expect(moodInputFromWorld(world, PLAYER)).toEqual({
      playerUnitsInCombat: false,
      enemiesNear: false,
    });
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

// Roadmap B20 (2026-10-02): the tension proximity driver.
describe('enemiesNearAssets', () => {
  it('is false with no enemies or no assets', () => {
    expect(enemiesNearAssets([], [{ x: 0, z: 0 }])).toBe(false);
    expect(enemiesNearAssets([{ x: 0, z: 0 }], [])).toBe(false);
  });

  it('detects an enemy inside the radius (boundary inclusive)', () => {
    const assets = [{ x: 0, z: 0 }];
    expect(enemiesNearAssets([{ x: TENSION_RADIUS, z: 0 }], assets)).toBe(true);
    expect(
      enemiesNearAssets([{ x: TENSION_RADIUS + 0.01, z: 0 }], assets),
    ).toBe(false);
  });

  it('checks every enemy against every asset', () => {
    const assets = [
      { x: 0, z: 0 },
      { x: 1000, z: 1000 },
    ];
    expect(
      enemiesNearAssets([{ x: 500, z: 500 }, { x: 1005, z: 1000 }], assets),
    ).toBe(true);
    expect(enemiesNearAssets([{ x: 500, z: 500 }], assets)).toBe(false);
  });
});

describe('enemyProximityFromWorld', () => {
  it('is false when the only enemy is far away', () => {
    const world = createWorld(42);
    spawnUnit(world, 'rifles', PLAYER, 10, 10);
    spawnUnit(world, 'rifles', ENEMY, 400, 400);
    expect(enemyProximityFromWorld(world, PLAYER)).toBe(false);
  });

  it('is true when a sighted enemy stands near a player unit', () => {
    const world = createWorld(42);
    spawnUnit(world, 'rifles', PLAYER, 10, 10);
    // 20 world units away: inside rifle sight and the tension radius.
    spawnUnit(world, 'rifles', ENEMY, 30, 10);
    expect(enemyProximityFromWorld(world, PLAYER)).toBe(true);
  });

  it('is false with no player assets left', () => {
    const world = createWorld(42);
    spawnUnit(world, 'rifles', ENEMY, 10, 10);
    expect(enemyProximityFromWorld(world, PLAYER)).toBe(false);
  });

  it('ignores dead enemies', () => {
    const world = createWorld(42);
    spawnUnit(world, 'rifles', PLAYER, 10, 10);
    const foe = spawnUnit(world, 'rifles', ENEMY, 12, 10);
    foe.hp = 0;
    expect(enemyProximityFromWorld(world, PLAYER)).toBe(false);
  });
});
