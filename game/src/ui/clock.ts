/**
 * Game-time clock (2026-10-05) — pure tick → time-of-day helpers for the
 * HUD topbar chip.
 *
 * Time model (matches `daylightFactor` in sim/utilityNetworks.ts): 30
 * ticks per sim-second, one full day/night cycle every 240 sim-seconds,
 * tick 0 = dawn. The 240 sim-seconds map onto a 24-hour clock face, so
 * one game-hour is 10 sim-seconds and a full in-game day is 4 real
 * minutes at 1x speed.
 *
 * UI display only — never feeds the sim, so no determinism constraints
 * beyond staying a pure function of the tick.
 */
import { DAY_LENGTH_SECONDS } from '../sim/utilityNetworks.js';

/** Ticks per sim-second (the literal 30 used across the sim). */
export const TICKS_PER_SIM_SECOND = 30;

export interface GameClock {
  /** 1-based day number. */
  day: number;
  /** Hour of the game day, 0-23. */
  hour: number;
  /** Minute of the game hour, 0-59. */
  minute: number;
  /** True during the day half of the cycle (dawn → dusk). */
  isDay: boolean;
  /** Sim-seconds until the next dawn/dusk transition. */
  untilTransitionSec: number;
}

/** Pure game-clock reading for a sim tick. */
export function gameClock(tick: number): GameClock {
  const simSeconds = tick / TICKS_PER_SIM_SECOND;
  const dayTime = simSeconds % DAY_LENGTH_SECONDS;
  const day = Math.floor(simSeconds / DAY_LENGTH_SECONDS) + 1;
  // Dawn reads as 06:00, dusk as 18:00 — a natural clock face.
  const hoursFloat = (6 + (dayTime / DAY_LENGTH_SECONDS) * 24) % 24;
  const hour = Math.floor(hoursFloat);
  const minute = Math.floor((hoursFloat - hour) * 60);
  const isDay = dayTime < DAY_LENGTH_SECONDS / 2;
  const untilTransitionSec = Math.ceil(
    isDay ? DAY_LENGTH_SECONDS / 2 - dayTime : DAY_LENGTH_SECONDS - dayTime,
  );
  return { day, hour, minute, isDay, untilTransitionSec };
}

/** Compact countdown: "45s", "1m 05s". */
export function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
