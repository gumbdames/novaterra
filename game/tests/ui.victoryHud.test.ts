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
 * NOVATERRA — fun-audit B4 (2026-10-02) tests: the rival-watch strip's
 * pure progress builder. The DOM widget is browser-only; the builder
 * carries the logic (per-kind progress, intel-flavored "~" rival
 * estimates, peaceful → null).
 */
import { describe, expect, it } from 'vitest';
import { victoryProgressOf } from '../src/ui/victoryHud';
import {
  AI_PLAYER_ID,
  createSession,
  ECONOMIC_VICTORY_FUNDS,
  HUMAN_PLAYER_ID,
  POPULATION_VICTORY_POP,
} from '../src/ui/session';
import { getPlayer, placeBuilding } from '../src/sim/city';
import type { World } from '../src/sim/world';

function worldWithKind(kind: 'conquest' | 'economic' | 'population' | 'monument'): World {
  return createSession({ seed: 4242, victoryKind: kind }).world;
}

describe('victoryProgressOf (fun-audit B4)', () => {
  it('returns null for peaceful worlds (endless — no race to report)', () => {
    const world = createSession({ seed: 7, peaceful: true }).world;
    expect(victoryProgressOf(world)).toBeNull();
  });

  it('reports the economic race: mine exact, rival as a "~" intel estimate', () => {
    const world = worldWithKind('economic');
    getPlayer(world.city, HUMAN_PLAYER_ID)!.funds = 25000;
    getPlayer(world.city, AI_PLAYER_ID)!.funds = 8000;
    const p = victoryProgressOf(world)!;
    expect(p.kind).toBe('economic');
    expect(p.mine).toContain('25,000');
    expect(p.mine).toContain('100,000');
    expect(p.rival).toMatch(/^~/);
    expect(p.rival).toContain('8,000');
    expect(p.mineFrac).toBeCloseTo(25000 / ECONOMIC_VICTORY_FUNDS);
    expect(p.rivalFrac).toBeCloseTo(8000 / ECONOMIC_VICTORY_FUNDS);
    expect(p.objective).toContain('100,000');
  });

  it('reports the population race against the 10k housed target', () => {
    const world = worldWithKind('population');
    const p = victoryProgressOf(world)!;
    expect(p.kind).toBe('population');
    expect(p.mine).toContain('10,000');
    expect(p.rival).toMatch(/^~/);
    expect(p.mineFrac).toBeGreaterThanOrEqual(0);
    expect(p.mineFrac).toBeLessThanOrEqual(1);
  });

  it('reports monument progress per side', () => {
    const world = worldWithKind('monument');
    const mine = placeBuilding(world.city, { kind: 'monument', owner: HUMAN_PLAYER_ID, cx: 5, cz: 5, facing: 0 });
    mine.progress = 0.5;
    const p = victoryProgressOf(world)!;
    expect(p.kind).toBe('monument');
    expect(p.mine).toBe('50%');
    expect(p.mineFrac).toBeCloseTo(0.5);
    // Rival has no monument: unknown, not "0%".
    expect(p.rival).toContain('unknown');
  });

  it('reports the balance of forces for conquest (no fake finish line)', () => {
    const world = worldWithKind('conquest');
    const p = victoryProgressOf(world)!;
    expect(p.kind).toBe('conquest');
    expect(p.mine).toContain('units');
    expect(p.rival).toMatch(/^~/);
    // Fractions are shares of combined military value.
    expect(p.mineFrac + p.rivalFrac).toBeCloseTo(1);
  });

  it('never throws on a bare world (defensive reads)', () => {
    const world = worldWithKind('economic');
    world.city.buildings = [];
    world.units = [];
    const p = victoryProgressOf(world);
    expect(p).not.toBeNull();
    expect(p!.mineFrac).toBeGreaterThanOrEqual(0);
    expect(p!.mineFrac).toBeLessThanOrEqual(1);
  });

  it('population threshold matches the session constant', () => {
    expect(POPULATION_VICTORY_POP).toBe(10000);
  });
});

describe('victoryProgressOf countdown (fun-audit B2)', () => {
  it('carries the live countdown when one runs', () => {
    const world = worldWithKind('economic');
    getPlayer(world.city, HUMAN_PLAYER_ID)!.funds = 85_000;
    // Run the session's tick driver once so the wonder system fires.
    // createSession's driver is internal; emulate one system tick here.
    world.wonderCountdown = { kind: 'economic', leader: HUMAN_PLAYER_ID, endsAtTick: 9000 };
    world.tick = 100;
    const p = victoryProgressOf(world)!;
    expect(p.countdown).toBeDefined();
    expect(p.countdown!.remainingTicks).toBe(8900);
    expect(p.countdown!.leaderIsMine).toBe(true);
  });

  it('no countdown field when idle', () => {
    const world = worldWithKind('economic');
    const p = victoryProgressOf(world)!;
    expect(p.countdown).toBeUndefined();
  });

  it('reports the rival leading when they triggered', () => {
    const world = worldWithKind('monument');
    world.wonderCountdown = { kind: 'monument', leader: AI_PLAYER_ID, endsAtTick: 9000 };
    world.tick = 0;
    const p = victoryProgressOf(world)!;
    expect(p.countdown!.leaderIsMine).toBe(false);
  });
});
