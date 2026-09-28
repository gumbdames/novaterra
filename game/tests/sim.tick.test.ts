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
  MAX_CATCHUP_TICKS,
  TICK_DT,
  TICK_HZ,
  TICK_MS,
  createTickDriver,
} from '../src/sim/tick';
import { createWorld } from '../src/sim/world';
import type { SimSystem } from '../src/sim/tick';

describe('sim/tick', () => {
  it('tick constants are the locked 30 Hz design', () => {
    expect(TICK_HZ).toBe(30);
    expect(TICK_DT).toBeCloseTo(1 / 30, 12);
    expect(TICK_MS).toBeCloseTo(1000 / 30, 12);
    expect(MAX_CATCHUP_TICKS).toBe(5);
  });

  it('1000ms of fed time yields exactly 30 ticks', () => {
    const w = createWorld(1);
    const driver = createTickDriver();
    for (let i = 0; i < 10; i++) {
      expect(driver.step(w, 100)).toBe(3);
    }
    expect(w.tick).toBe(30);
    expect(w.time).toBe(1);
  });

  it('fractional remainder carries over to the next step', () => {
    const w = createWorld(1);
    const driver = createTickDriver();
    expect(driver.step(w, 50)).toBe(1); // 1.5 ticks worth
    expect(driver.step(w, 50)).toBe(2); // remainder + 1.5 = 3 total
    expect(w.tick).toBe(3);
    expect(w.time).toBeCloseTo(0.1, 12);
  });

  it('a 5-second stall caps catch-up and counts dropped time (no hang)', () => {
    const w = createWorld(1);
    const driver = createTickDriver();
    const ran = driver.step(w, 5000);
    expect(ran).toBe(MAX_CATCHUP_TICKS);
    // 5000ms holds 150 whole ticks; 5 ran, 145 dropped.
    expect(driver.droppedTicks).toBe(145);
    expect(driver.droppedMs).toBeCloseTo(145 * TICK_MS, 9);
    expect(w.tick).toBe(5);
    // The fractional remainder (< 1 tick) survives the drop.
    expect(driver.accumulator).toBeGreaterThanOrEqual(0);
    expect(driver.accumulator).toBeLessThan(TICK_MS);
  });

  it('systems run every tick in fixed registration order with TICK_DT', () => {
    const w = createWorld(1);
    const order: string[] = [];
    const dts: number[] = [];
    const a: SimSystem = (_world, dt) => {
      order.push('a');
      dts.push(dt);
    };
    const b: SimSystem = (_world, dt) => {
      order.push('b');
      dts.push(dt);
    };
    const driver = createTickDriver({ systems: [a, b] });
    driver.step(w, 100); // 3 ticks
    expect(order).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    expect(dts.every((d) => d === TICK_DT)).toBe(true);
  });

  it('negative frame time is clamped to zero', () => {
    const w = createWorld(1);
    const driver = createTickDriver();
    expect(driver.step(w, -100)).toBe(0);
    expect(w.tick).toBe(0);
  });

  it('world.time never drifts (derived from tick, not accumulated)', () => {
    const w = createWorld(1);
    const driver = createTickDriver();
    for (let i = 0; i < 200; i++) driver.step(w, 100); // 600 ticks
    expect(w.tick).toBe(600);
    expect(w.time).toBe(20); // exactly 600/30 — no float accumulation
  });

  it('reset clears the accumulator and drop counters', () => {
    const w = createWorld(1);
    const driver = createTickDriver();
    driver.step(w, 5000);
    driver.reset();
    expect(driver.accumulator).toBe(0);
    expect(driver.droppedTicks).toBe(0);
    expect(driver.droppedMs).toBe(0);
  });
});
