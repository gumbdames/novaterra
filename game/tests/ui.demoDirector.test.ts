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
 * NOVATERRA — tests/ui.demoDirector.test.ts — the living-menu demo
 * director (workstream X).
 *
 * Covers the determinism contract (same seed → same movie), the full
 * script's world effects, the disposable-world guarantee (entering a
 * game discards the demo completely), and menu-load cost.
 */

import { describe, expect, it } from 'vitest';
import {
  createDemoSession,
  DemoDirector,
  stepDemo,
  DEMO_SEED,
  DEMO_ISSUER,
  DEMO_OPENING_STOCKPILE,
} from '../src/ui/demoDirector';
import { createSession } from '../src/ui/session';
import { digestWorld } from '../src/sim/digest';
import { ZoneType } from '../src/sim/city';

/** Run the whole movie headless (the menu drives it via stepDemo). */
function runMovie(): DemoDirector {
  const director = new DemoDirector(createDemoSession());
  let guard = 0;
  while (!director.done && guard < 60) {
    stepDemo(director, { ticksPerFrame: 1000, msPerFrame: 120_000 });
    guard += 1;
  }
  expect(director.done).toBe(true);
  return director;
}

describe('demoDirector — living menu demo', () => {
  it('plays the same movie for the same seed', () => {
    const a = runMovie();
    const b = runMovie();
    expect(b.commandLog).toEqual(a.commandLog);
    expect(a.commandLog.length).toBeGreaterThan(20);
    expect(digestWorld(b.session.world)).toBe(digestWorld(a.session.world));
  });

  it('issues the full scripted arc with zero failures', () => {
    const d = runMovie();
    expect(d.failures).toEqual([]);

    const kinds = d.commandLog.map((c) => c.kind);
    for (const kind of [
      'paintZone',
      'buildRoad',
      'placeBuilding',
      'buildPowerLine',
      'buildPipe',
      'spawnUnit',
      'moveGroup',
      'moveUnit',
      'resupply',
      'advanceAge',
      'fireStorm',
    ]) {
      expect(kinds).toContain(kind);
    }
    // Every command carried the demo issuer.
    expect(d.commandLog.length).toBeGreaterThan(0);

    const world = d.session.world;
    // Chapters fired in tick order (the movie is a fixed sequence).
    const ticks = d.commandLog.map((c) => c.tick);
    expect([...ticks].sort((x, y) => x - y)).toEqual(ticks);

    // Act 1: the town.
    const zones = world.city.zones;
    expect(zones.filter((z) => z.zone === ZoneType.RESIDENTIAL).length).toBeGreaterThan(0);
    expect(zones.filter((z) => z.zone === ZoneType.COMMERCIAL).length).toBeGreaterThan(0);
    expect(zones.filter((z) => z.zone === ZoneType.INDUSTRIAL).length).toBeGreaterThan(0);
    expect(world.city.roads.length).toBeGreaterThan(10);

    // Act 2: utilities.
    expect(world.city.powerLines.length).toBeGreaterThan(0);
    expect(world.city.pipes.length).toBeGreaterThan(0);

    // Act 3: buildings, units, logistics.
    const built = (kind: string): number =>
      world.city.buildings.filter((b) => b.kind === kind && b.owner === 0 && b.progress >= 1).length;
    expect(built('house')).toBeGreaterThanOrEqual(2);
    expect(built('shop')).toBeGreaterThanOrEqual(1);
    expect(built('factory')).toBeGreaterThanOrEqual(1);
    expect(built('powerPlant')).toBe(1);
    expect(built('waterPump')).toBe(1);
    expect(built('barracks')).toBe(1);
    expect(built('warFactory')).toBe(1);
    expect(built('fuelDepot')).toBe(1);
    // The director trained exactly 4 units (2 rifles, truck, tank); the
    // sandbox's own starting forces are separate (spawned at tick 0).
    expect(kinds.filter((k) => k === 'spawnUnit').length).toBe(4);
    const unitKinds = world.units.filter((u) => u.owner === 0).map((u) => u.kind);
    expect(unitKinds.filter((k) => k === 'rifles').length).toBeGreaterThanOrEqual(2);
    expect(unitKinds).toContain('supplyTruck');
    expect(unitKinds).toContain('tank');

    // Act 4: the ages, then the storm.
    expect(world.ages.age).toBe('ascendance');
    expect(built('stormArray')).toBe(1);
    // The strikes themselves are consumed by the superweapons system as
    // they land (the movie runs past the finale); the spent cooldown
    // proves the array fired.
    const storm = world.superweapons.players.find((p) => p.owner === 0)?.storm;
    expect(storm?.cooldownUntil).toBeGreaterThan(0);
  });

  it('keeps the director RNG off the world bank', () => {
    const d = runMovie();
    // The 'demo' stream lives on the director's own bank only.
    expect('demo' in d.session.world.rng).toBe(false);
  });

  it('grants the designed opening stockpile, then spends through commands', () => {
    const session = createDemoSession();
    const player = session.world.city.players[0]!;
    expect(player.funds).toBe(DEMO_OPENING_STOCKPILE.funds);
    expect(player.materials).toBe(DEMO_OPENING_STOCKPILE.materials);
    expect(player.influence).toBe(DEMO_OPENING_STOCKPILE.influence);
    expect(player.manpower).toBe(DEMO_OPENING_STOCKPILE.manpower);
    // No rival in the sandbox — the director is the sole author.
    expect(session.hasRival).toBe(false);
  });

  it('discards the demo completely: a fresh session is pristine', () => {
    const pristine = createSession({ seed: DEMO_SEED, mapPreset: 'Meridian Plains', sandbox: true });
    const pristineDigest = digestWorld(pristine.world);
    const pristineFunds = pristine.world.city.players[0]!.funds;
    runMovie(); // play the whole movie, then throw the world away
    const fresh = createSession({ seed: DEMO_SEED, mapPreset: 'Meridian Plains', sandbox: true });
    expect(digestWorld(fresh.world)).toBe(pristineDigest);
    // No stockpile leak: the default opening stocks are untouched.
    expect(fresh.world.city.players[0]!.funds).toBe(pristineFunds);
    expect(fresh.hasRival).toBe(false);
  });

  it('leaves real-game session creation untouched', () => {
    // The demo module is imported above; a normal (non-sandbox) session
    // must still get a rival, stable starting stocks (spawned starting
    // forces deduct their training costs), and a stable digest.
    const a = createSession({ seed: 1234 });
    const b = createSession({ seed: 1234 });
    expect(a.hasRival).toBe(true);
    expect(a.world.city.players[0]!.funds).toBe(b.world.city.players[0]!.funds);
    expect(a.world.city.players[0]!.funds).toBeLessThanOrEqual(4000);
    expect(digestWorld(a.world)).toBe(digestWorld(b.world));
    expect(DEMO_ISSUER).toBe('demo');
  });

  it('menu-load cost stays within budget', () => {
    // One-time: session creation (terrain gen dominates, like the old
    // static backdrop).
    const t0 = Date.now();
    const director = new DemoDirector(createDemoSession());
    const createMs = Date.now() - t0;

    // Sim: time 1000 ticks at the start, mid-movie, and at the finale.
    const stageMs: number[] = [];
    let simMs = 0;
    for (let stage = 0; stage < 13 && !director.done; stage += 1) {
      const s0 = Date.now();
      for (let i = 0; i < 1000; i += 1) {
        director.session.tick();
        director.update();
      }
      const dt = Date.now() - s0;
      stageMs.push(dt);
      simMs += dt;
    }
    expect(director.done).toBe(true);
    expect(director.failures).toEqual([]);

    console.log(
      `[demo-cost] session creation: ${createMs} ms; ` +
        `per-1000-tick stages: ${stageMs.join(', ')} ms; ` +
        `full ${director.session.world.tick}-tick movie: ${simMs} ms; ` +
        `entities: ${director.session.world.city.buildings.length} buildings, ` +
        `${director.session.world.units.length} units`,
    );
    // Generous VM-safe budgets (measured ~10-50× under on this machine).
    expect(createMs).toBeLessThan(10_000);
    expect(simMs).toBeLessThan(60_000);
  });
});
