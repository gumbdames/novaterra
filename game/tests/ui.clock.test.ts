/**
 * Game-time clock tests (2026-10-05) — pure tick → time-of-day math.
 * Time model: 30 ticks/sim-second, 240 sim-seconds per day/night cycle,
 * tick 0 = dawn. All headless.
 */
import { describe, expect, it } from 'vitest';
import { formatCountdown, gameClock } from '../src/ui/clock';

describe('gameClock', () => {
  it('tick 0 is dawn of day 1', () => {
    const c = gameClock(0);
    expect(c.day).toBe(1);
    expect(c.hour).toBe(6);
    expect(c.minute).toBe(0);
    expect(c.isDay).toBe(true);
    // 120 sim-seconds of daylight remain.
    expect(c.untilTransitionSec).toBe(120);
  });

  it('maps the cycle onto a natural clock face', () => {
    // Noon = halfway through the day half = 60 sim-seconds in.
    const noon = gameClock(60 * 30);
    expect(noon.hour).toBe(12);
    expect(noon.minute).toBe(0);
    expect(noon.isDay).toBe(true);
    // Dusk = end of the day half = 120 sim-seconds in = 18:00.
    const dusk = gameClock(120 * 30);
    expect(dusk.hour).toBe(18);
    expect(dusk.minute).toBe(0);
    expect(dusk.isDay).toBe(false);
    expect(dusk.untilTransitionSec).toBe(120);
    // Midnight = 180 sim-seconds in.
    expect(gameClock(180 * 30).hour).toBe(0);
  });

  it('advances the day counter each full cycle', () => {
    const c = gameClock(240 * 30);
    expect(c.day).toBe(2);
    expect(c.hour).toBe(6);
    expect(c.isDay).toBe(true);
  });

  it('counts down to the next transition', () => {
    // 30 sim-seconds into the night: 90 remain until dawn.
    const night = gameClock(150 * 30);
    expect(night.isDay).toBe(false);
    expect(night.untilTransitionSec).toBe(90);
    // 100 sim-seconds into the day: 20 remain until dusk.
    const day = gameClock(100 * 30);
    expect(day.isDay).toBe(true);
    expect(day.untilTransitionSec).toBe(20);
  });
});

describe('formatCountdown', () => {
  it('formats seconds and minutes compactly', () => {
    expect(formatCountdown(45)).toBe('45s');
    expect(formatCountdown(65)).toBe('1m 05s');
    expect(formatCountdown(0)).toBe('0s');
  });
});
