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
 * NOVATERRA — small-juice tests (roadmap B21, 2026-10-02).
 *
 * - `wrapAngle` / `bankForTurn` / `bobPhase` / `shipBob` (pure juice
 *   math in render/entityInstancing.ts): determinism, ranges, the
 *   bank-into-the-turn sign convention.
 * - `wakeTextureData` (render/shipWakes.ts): deterministic, foam
 *   streak shape (bright head, fading tail, soft edges).
 * - `ShipWakes`: moving sea units grow wakes, stopped units fade them,
 *   land units never wake, the pool caps at MAX_WAKES.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';

import {
  bankForTurn,
  bobPhase,
  MAX_BANK,
  shipBob,
  wrapAngle,
} from '../src/render/entityInstancing';
import {
  MAX_WAKES,
  ShipWakes,
  wakeTextureData,
  WAKE_MIN_SPEED,
} from '../src/render/shipWakes';
import { createWorld } from '../src/sim/world';
import { spawnUnit } from '../src/sim/units';

describe('wrapAngle', () => {
  it('leaves small angles alone', () => {
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 10);
    expect(wrapAngle(-0.5)).toBeCloseTo(-0.5, 10);
  });

  it('wraps past ±π', () => {
    expect(wrapAngle(Math.PI + 0.5)).toBeCloseTo(-Math.PI + 0.5, 10);
    expect(wrapAngle(-Math.PI - 0.5)).toBeCloseTo(Math.PI - 0.5, 10);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 10);
  });
});

describe('bankForTurn', () => {
  it('is level when flying straight', () => {
    expect(bankForTurn(0)).toBeCloseTo(0, 10);
  });

  it('banks into the turn: right turn → negative roll (right wing down)', () => {
    expect(bankForTurn(0.2)).toBeLessThan(0);
    expect(bankForTurn(-0.2)).toBeGreaterThan(0);
  });

  it('caps at MAX_BANK', () => {
    expect(bankForTurn(10)).toBe(-MAX_BANK);
    expect(bankForTurn(-10)).toBe(MAX_BANK);
    expect(MAX_BANK).toBeGreaterThan(0);
  });
});

describe('bobPhase', () => {
  it('is deterministic and spans the circle', () => {
    expect(bobPhase(7)).toBe(bobPhase(7));
    const phases = new Set<number>();
    for (let id = 1; id <= 50; id++) {
      const p = bobPhase(id);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(Math.PI * 2);
      phases.add(Math.round(p * 1000));
    }
    // Golden-angle spacing: 50 ids → 50 distinct phases.
    expect(phases.size).toBe(50);
  });
});

describe('shipBob', () => {
  it('is deterministic in (t, phase)', () => {
    expect(shipBob(1.5, 0.7)).toEqual(shipBob(1.5, 0.7));
  });

  it('stays in its gentle ranges', () => {
    for (let i = 0; i < 100; i++) {
      const b = shipBob(i * 0.37, bobPhase(i));
      expect(Math.abs(b.lift)).toBeLessThanOrEqual(0.35);
      expect(Math.abs(b.pitch)).toBeLessThanOrEqual(0.03);
      expect(Math.abs(b.roll)).toBeLessThanOrEqual(0.04);
    }
  });

  it('actually moves (not a flat zero)', () => {
    const lifts = new Set<number>();
    for (let i = 0; i < 20; i++) lifts.add(Math.round(shipBob(i * 0.5, 0.3).lift * 100));
    expect(lifts.size).toBeGreaterThan(5);
  });
});

describe('wakeTextureData', () => {
  it('is deterministic', () => {
    expect(wakeTextureData(16)).toEqual(wakeTextureData(16));
  });

  it('fades head→tail with soft across-width edges', () => {
    const size = 64;
    const d = wakeTextureData(size);
    const alpha = (x: number, y: number): number => d[(y * size + x) * 4 + 3]!;
    // Head-center is bright, tail-center is transparent.
    expect(alpha(32, 2)).toBeGreaterThan(alpha(32, 60));
    expect(alpha(32, 60)).toBeLessThan(20);
    // Across-width edges are soft.
    expect(alpha(0, 8)).toBeLessThan(alpha(32, 8));
    expect(alpha(63, 8)).toBeLessThan(alpha(32, 8));
  });
});

describe('ShipWakes', () => {
  function movingWorld() {
    const world = createWorld(7);
    const ship = spawnUnit(world, 'patrolBoat', 0, 0, 0);
    return { world, ship };
  }

  it('grows a wake for a moving ship, none for a still one', () => {
    const scene = new THREE.Scene();
    const wakes = new ShipWakes(scene, 0);
    const { world, ship } = movingWorld();
    const dt = 1 / 60;
    wakes.sync(world, dt); // first sighting: no speed yet
    expect(wakes.wakeCount).toBe(0);
    ship.x = 10; // 600 u/s — well above WAKE_MIN_SPEED
    wakes.sync(world, dt);
    expect(wakes.wakeCount).toBe(1);
    wakes.dispose();
  });

  it('fades the wake after the ship stops', () => {
    const scene = new THREE.Scene();
    const wakes = new ShipWakes(scene, 0);
    const { world, ship } = movingWorld();
    const dt = 1 / 60;
    wakes.sync(world, dt);
    ship.x = 10;
    wakes.sync(world, dt);
    expect(wakes.wakeCount).toBe(1);
    // Hold still: the wake shrinks away within WAKE_FADE_SEC.
    for (let i = 0; i < 70; i++) wakes.sync(world, dt);
    expect(wakes.wakeCount).toBe(0);
    wakes.dispose();
  });

  it('ignores land units and slow ships', () => {
    const scene = new THREE.Scene();
    const wakes = new ShipWakes(scene, 0);
    const world = createWorld(7);
    const tank = spawnUnit(world, 'tank', 0, 0, 0);
    const ship = spawnUnit(world, 'patrolBoat', 0, 100, 100);
    const dt = 1 / 60;
    wakes.sync(world, dt);
    tank.x = 50; // fast, but land — no wake
    // Barely moving ship: below WAKE_MIN_SPEED.
    ship.x = 100 + WAKE_MIN_SPEED * dt * 0.5;
    wakes.sync(world, dt);
    expect(wakes.wakeCount).toBe(0);
    wakes.dispose();
  });

  it('caps the pool at MAX_WAKES', () => {
    const scene = new THREE.Scene();
    const wakes = new ShipWakes(scene, 0);
    const world = createWorld(7);
    const ships = [];
    for (let i = 0; i < MAX_WAKES + 6; i++) {
      ships.push(spawnUnit(world, 'patrolBoat', 0, i * 10, i * 10));
    }
    const dt = 1 / 60;
    wakes.sync(world, dt);
    for (const s of ships) s.x += 10;
    wakes.sync(world, dt);
    expect(wakes.wakeCount).toBe(MAX_WAKES);
    wakes.dispose();
  });
});
