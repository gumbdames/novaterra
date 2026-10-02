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
 * NOVATERRA — fun-audit B3: end-of-game statistics (2026-10-02).
 *
 * Pinned here:
 *  - mm:ss duration formatting from sim ticks;
 *  - the builder counts completed player buildings, reads the
 *    sim-tracked peak population, and names the age reached;
 *  - the six stat lines render through the STRINGS.endStats templates
 *    (localized DOM text, never baked into art).
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { getPlayer } from '../src/sim/city';
import {
  formatDuration,
  endGameStatsOf,
  endStatsLines,
} from '../src/ui/endStats';

describe('formatDuration', () => {
  it('formats 0 ticks as 0:00', () => {
    expect(formatDuration(0)).toBe('0:00');
  });
  it('formats one second (30 ticks) as 0:01', () => {
    expect(formatDuration(30)).toBe('0:01');
  });
  it('formats 41:23', () => {
    expect(formatDuration((41 * 60 + 23) * 30)).toBe('41:23');
  });
  it('pads single-digit seconds', () => {
    expect(formatDuration(90 * 30 + 5 * 30)).toBe('1:35');
  });
});

describe('endGameStatsOf', () => {
  it('counts completed player buildings and reads the peak population', () => {
    const world = createWorld(7);
    world.tick = 3600;
    const p = getPlayer(world.city, 0);
    if (p) {
      p.population = 500;
      p.peakPopulation = 1204;
    }
    const mk = (owner: number, progress: number): void => {
      world.city.buildings.push({
        id: world.nextId++,
        kind: 'house',
        owner,
        x: 0,
        z: 0,
        progress,
        operational: true,
        hp: 100,
      } as unknown as (typeof world.city.buildings)[number]);
    };
    mk(0, 1);
    mk(0, 1);
    mk(0, 0.5); // under construction — not raised
    mk(1, 1); // rival's — not ours
    const stats = endGameStatsOf(world, 0, 27, 11);
    expect(stats.durationTicks).toBe(3600);
    expect(stats.kills).toBe(27);
    expect(stats.losses).toBe(11);
    expect(stats.buildingsRaised).toBe(2);
    expect(stats.peakPopulation).toBe(1204);
    expect(typeof stats.ageName).toBe('string');
    expect(stats.ageName.length).toBeGreaterThan(0);
  });

  it('falls back to current population when no peak was tracked', () => {
    const world = createWorld(7);
    const p = getPlayer(world.city, 0);
    if (p) p.population = 42;
    const stats = endGameStatsOf(world, 0, 0, 0);
    expect(stats.peakPopulation).toBe(42);
  });

  it('never throws on a partial world', () => {
    const world = createWorld(7);
    expect(() => endGameStatsOf(world, 0, 0, 0)).not.toThrow();
  });
});

describe('endStatsLines', () => {
  it('renders six localized lines', () => {
    const lines = endStatsLines({
      durationTicks: (41 * 60 + 23) * 30,
      kills: 27,
      losses: 11,
      buildingsRaised: 38,
      peakPopulation: 1204,
      ageName: 'Industry',
    });
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('27');
    expect(lines[1]).toContain('11');
    expect(lines[2]).toBe('41:23');
    expect(lines[3]).toContain('38');
    expect(lines[4]).toContain('1,204');
    expect(lines[5]).toContain('Industry');
  });
});
