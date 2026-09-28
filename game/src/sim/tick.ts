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
 * NOVATERRA — sim/tick.ts — fixed-timestep driver (the Glenn Fiedler
 * accumulator, per docs/research/sim-architecture.md §1).
 *
 * Responsibilities:
 *  - Advance the simulation in exact 1/30 s slices, decoupled from the
 *    render frame rate. One tick = apply due commands → run systems in a
 *    fixed order → tick++.
 *  - The clock is injected: `step(world, frameMs)` takes elapsed
 *    milliseconds from the caller. No `Date.now()` / `performance.now()`
 *    in here — the driver is fully testable and the game loop owns time.
 *  - Catch-up is capped at MAX_CATCHUP_TICKS per step (no spiral of death).
 *    Whole ticks beyond the cap are dropped and counted (`droppedTicks`,
 *    `droppedMs`); the fractional remainder carries over. Dropping time is
 *    a performance signal (slow-motion under load), never a correctness
 *    failure.
 *
 * Pause = don't call step(). The accumulator, systems, and queue are
 * unaffected by a pause, so the command stream is identical with or without
 * one — pause/resume is determinism-neutral by construction.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue } from './commands';

/** Simulation frequency. 30 Hz: the RTS sweet spot (research §10.3). */
export const TICK_HZ = 30;
/** Exact tick duration in seconds, passed to systems. */
export const TICK_DT = 1 / TICK_HZ;
/** Exact tick duration in milliseconds, for the accumulator. */
export const TICK_MS = 1000 / TICK_HZ;
/**
 * Max ticks executed per step() call. Beyond this the game slows down
 * instead of freezing — the dropped ticks are counted, not simulated.
 */
export const MAX_CATCHUP_TICKS = 5;

/**
 * Epsilon for the accumulator comparison, in milliseconds. Repeated float
 * subtraction of TICK_MS accumulates ~1e-13 of dust per tick; without this,
 * an accumulator holding exactly N ticks' worth of time can compare just
 * *below* TICK_MS and lose a tick (e.g. feeding 100 ms would run 2 ticks
 * instead of 3). 1e-9 ms is far above the dust and far below anything
 * observable — and the comparison stays a pure function of the inputs, so
 * determinism is unaffected.
 */
const ACCUMULATOR_EPSILON_MS = 1e-9;

/** A simulation system: reads the world, mutates it, runs every tick. */
export type SimSystem = (world: World, dt: number) => void;

export interface TickDriverOptions {
  /** Systems run in array order, every tick. Fixed, data-independent order. */
  systems?: SimSystem[];
  /** Optional command queue; due commands apply at each tick's start. */
  queue?: CommandQueue;
}

export interface TickDriver {
  readonly systems: SimSystem[];
  readonly queue: CommandQueue | undefined;
  /** Unprocessed sim time, in ms. Wall-clock-derived — never snapshotted. */
  accumulator: number;
  /** Whole ticks dropped by the catch-up cap, lifetime. */
  droppedTicks: number;
  /** Dropped time in ms, lifetime. */
  droppedMs: number;
  /**
   * Advance the sim by `frameMs` of wall time. Returns ticks executed.
   * Negative input is clamped to 0.
   */
  step(world: World, frameMs: number): number;
  /** Clear accumulator and drop counters (not the world). */
  reset(): void;
}

function runTick(driver: TickDriver, world: World): void {
  // 1. Tick-aligned input: commands due at (or before) this tick apply first,
  //    in deterministic (tick, issuer, seq) order.
  driver.queue?.applyDue(world, world.tick);
  // 2. Systems, in the fixed registration order.
  for (const system of driver.systems) {
    system(world, TICK_DT);
  }
  // 3. Advance the clock. time is derived from tick (no float drift).
  world.tick += 1;
  world.time = world.tick / TICK_HZ;
}

export function createTickDriver(options?: TickDriverOptions): TickDriver {
  const driver: TickDriver = {
    systems: options?.systems ?? [],
    queue: options?.queue,
    accumulator: 0,
    droppedTicks: 0,
    droppedMs: 0,

    step(world: World, frameMs: number): number {
      this.accumulator += Math.max(0, frameMs);
      let ran = 0;
      while (this.accumulator + ACCUMULATOR_EPSILON_MS >= TICK_MS && ran < MAX_CATCHUP_TICKS) {
        runTick(this, world);
        this.accumulator -= TICK_MS;
        ran += 1;
      }
      if (this.accumulator >= TICK_MS) {
        // Over the cap: drop whole ticks, keep the fractional remainder so
        // the next step resumes cleanly. Counted, never silently lost.
        const dropped = Math.floor(this.accumulator / TICK_MS);
        this.droppedTicks += dropped;
        this.droppedMs += dropped * TICK_MS;
        this.accumulator -= dropped * TICK_MS;
      }
      return ran;
    },

    reset(): void {
      this.accumulator = 0;
      this.droppedTicks = 0;
      this.droppedMs = 0;
    },
  };
  return driver;
}
