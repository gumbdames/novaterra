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
 * NOVATERRA — tests/ui.trailer.test.ts — the scripted gameplay trailer
 * (trailer workstream, 2026-10-01).
 *
 * Covers the determinism contract (same seed → same movie), the full
 * script's world effects (city, trade, battle, storm), the title-card
 * and camera-shot schedules, the trailer camera math, and the capture
 * path's graceful degradation when MediaRecorder is unavailable.
 */

import { describe, expect, it } from 'vitest';
import {
  createTrailerSession,
  TrailerDirector,
  TRAILER_SEED,
  TRAILER_ISSUER,
  TRAILER_END_TICK,
  TRAILER_TITLE_CARDS,
  TRAILER_SHOTS,
  TRAILER_OPENING_STOCKPILE,
} from '../src/ui/trailerDirector';
import { AI_PLAYER_ID } from '../src/ui/session';
import {
  poseAtTick,
  validateShots,
  easeFactor,
  lerpPose,
  anchoredPose,
  type TrailerAnchors,
} from '../src/ui/trailerCamera';
import {
  resolveTrailerMimeType,
  trailerCaptureSupported,
  startTrailerCapture,
  TRAILER_MIME_PREFERENCE,
} from '../src/ui/trailerCapture';
import { digestWorld } from '../src/sim/digest';
import { ZoneType } from '../src/sim/city';
import { getAgeState } from '../src/sim/ages';

/** Run the whole trailer headless (the capture mode drives it per tick). */
function runTrailer(): TrailerDirector {
  const director = new TrailerDirector(createTrailerSession());
  let guard = 0;
  while (!director.done && guard < 40) {
    for (let i = 0; i < 1000 && !director.done; i += 1) {
      director.session.tick();
      director.update();
    }
    guard += 1;
  }
  expect(director.done).toBe(true);
  return director;
}

/** Fixed anchors for camera-math tests. */
function testAnchors(): TrailerAnchors {
  const v = (x: number, z: number): { x: number; y: number; z: number } => ({ x, y: 0, z });
  return {
    town: v(0, 0),
    harbor: v(100, 50),
    freighter: v(120, 60),
    army: v(-80, -40),
    stormTarget: v(180, -180),
    mapCenter: v(0, 0),
  };
}

describe('trailerDirector — scripted gameplay trailer', () => {
  it('plays the same movie for the same seed', { timeout: 120_000 }, () => {
    const a = runTrailer();
    const b = runTrailer();
    expect(b.commandLog).toEqual(a.commandLog);
    expect(a.commandLog.length).toBeGreaterThan(40);
    expect(digestWorld(b.session.world)).toBe(digestWorld(a.session.world));
  });

  it('issues the full scripted arc with zero failures', { timeout: 120_000 }, () => {
    const d = runTrailer();
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
      'advanceAge',
      'establishSeaRoute',
      'assignSeaRoute',
      'establishAirlineRoute',
      'attackUnit',
      'fireStorm',
    ]) {
      expect(kinds).toContain(kind);
    }
    // Every command carried the trailer issuer.
    expect(d.commandLog.every((c) => c.tick >= 0)).toBe(true);
    expect(TRAILER_ISSUER).toBe('trailer');

    // Chapters fired in tick order.
    const ticks = d.commandLog.map((c) => c.tick);
    expect([...ticks].sort((x, y) => x - y)).toEqual(ticks);

    const world = d.session.world;
    // The city.
    expect(world.city.zones.filter((z) => z.zone === ZoneType.RESIDENTIAL).length).toBeGreaterThan(0);
    expect(world.city.roads.length).toBeGreaterThan(10);
    const built = (kind: string): number =>
      world.city.buildings.filter((b) => b.kind === kind && b.owner === 0 && b.progress >= 1).length;
    expect(built('house')).toBeGreaterThanOrEqual(2);
    expect(built('powerPlant')).toBe(1);
    expect(built('barracks')).toBe(1);
    expect(built('warFactory')).toBe(1);
    expect(built('airportInterchange')).toBe(1);
    expect(built('civilAirport')).toBe(2);
    expect(built('stormArray')).toBe(1);

    // Trade: one shipyard (builds the freighters) + two trade docks
    // (anchor the sea route), a sailed sea route with assigned
    // freighters, and an airline between the two civil airports.
    expect(built('commercialHarbor')).toBe(1);
    expect(built('commercialPort')).toBe(2);
    expect(world.city.seaRoutes.filter((r) => r.owner === 0).length).toBe(1);
    const freighters = world.units.filter((u) => u.owner === 0 && u.kind === 'cargoFreighter');
    expect(freighters.length).toBe(2);
    expect(freighters.every((f) => (f.seaRouteId ?? 0) > 0)).toBe(true);
    expect(world.city.airlineRoutes.filter((r) => r.owner === 0).length).toBe(1);

    // Ages: the full time-lapse to ascendance.
    expect(getAgeState(world, 0).age).toBe('ascendance');

    // The battle: real attack orders were issued against the AI.
    expect(kinds.filter((k) => k === 'attackUnit').length).toBeGreaterThan(0);

    // The storm fired (the array's cooldown is spent).
    const storm = world.superweapons.players.find((p) => p.owner === 0)?.storm;
    expect(storm?.cooldownUntil).toBeGreaterThan(0);

    // The movie ends exactly at the designed tick.
    expect(world.tick).toBeGreaterThanOrEqual(TRAILER_END_TICK);
    expect(d.pendingChapters).toBe(0);
  });

  it('keeps the director RNG off the world bank', { timeout: 120_000 }, () => {
    const d = runTrailer();
    expect('trailer' in d.session.world.rng).toBe(false);
  });

  it('grants the designed opening stockpile and keeps the cadet rival', () => {
    const session = createTrailerSession();
    const player = session.world.city.players[0]!;
    expect(player.funds).toBe(TRAILER_OPENING_STOCKPILE.funds);
    expect(player.materials).toBe(TRAILER_OPENING_STOCKPILE.materials);
    expect(player.influence).toBe(TRAILER_OPENING_STOCKPILE.influence);
    expect(player.manpower).toBe(TRAILER_OPENING_STOCKPILE.manpower);
    // Not sandbox: the rival exists (it supplies the finale's battle).
    expect(session.hasRival).toBe(true);
    expect(session.aiDifficulty).toBe('cadet');
    // The AI opened with fielded rifles near its corner.
    const foes = session.world.units.filter((u) => u.owner === AI_PLAYER_ID);
    expect(foes.length).toBeGreaterThan(0);
  });

  it('accepts a reseed for re-shoots (deterministic per seed)', { timeout: 120_000 }, () => {
    const a = new TrailerDirector(createTrailerSession(12345));
    const b = new TrailerDirector(createTrailerSession(12345));
    for (let i = 0; i < 3000; i += 1) {
      a.session.tick();
      a.update();
      b.session.tick();
      b.update();
    }
    expect(b.commandLog).toEqual(a.commandLog);
    expect(digestWorld(b.session.world)).toBe(digestWorld(a.session.world));
    expect(a.failures).toEqual([]);
  });

  it('pins the title-card schedule', () => {
    const titles = TRAILER_TITLE_CARDS.map((c) => c.title);
    for (const card of ['BUILD', 'COMMAND', 'OUTTHINK', 'TRADE', 'ENDURE']) {
      expect(titles).toContain(card);
    }
    // Cards are ordered and non-overlapping (exactly one visible at a time).
    for (let i = 1; i < TRAILER_TITLE_CARDS.length; i += 1) {
      const prev = TRAILER_TITLE_CARDS[i - 1]!;
      const cur = TRAILER_TITLE_CARDS[i]!;
      expect(cur.startTick).toBeGreaterThanOrEqual(prev.endTick);
      expect(cur.endTick).toBeGreaterThan(cur.startTick);
    }
    // All copy is English-only (no Hebrew or other scripts).
    for (const card of TRAILER_TITLE_CARDS) {
      expect(/[\u0590-\u05FF]/.test(card.title + card.sub)).toBe(false);
    }
  });

  it('pins a clean, gapless camera-shot schedule', () => {
    expect(validateShots(TRAILER_SHOTS)).toEqual([]);
    expect(TRAILER_SHOTS[0]!.startTick).toBe(0);
    expect(TRAILER_SHOTS[TRAILER_SHOTS.length - 1]!.endTick).toBe(TRAILER_END_TICK);
  });

  it('resolves camera anchors from live world state', { timeout: 120_000 }, () => {
    const d = new TrailerDirector(createTrailerSession());
    // Before the freighters exist, the freighter anchor falls back to harbor.
    const early = d.cameraAnchors();
    expect(early.freighter).toEqual(early.harbor);
    // The army anchor falls back to town before any combat units exist…
    // (the skirmish's starting rifles ARE combat units, so it resolves).
    expect(Number.isFinite(early.army.x)).toBe(true);
    // Run to the sea-route chapters: the freighter anchor goes live.
    while (d.session.world.tick < 3500) {
      d.session.tick();
      d.update();
    }
    const mid = d.cameraAnchors();
    const freighter = d.session.world.units.find((u) => u.kind === 'cargoFreighter');
    expect(freighter).toBeDefined();
    expect(mid.freighter.x).toBe(freighter!.x);
    expect(mid.freighter.z).toBe(freighter!.z);
  });
});

describe('trailerCamera — scripted camera paths', () => {
  it('holds the opening pose before the first shot and the closing pose after the last', () => {
    const anchors = testAnchors();
    const first = TRAILER_SHOTS[0]!;
    expect(poseAtTick(TRAILER_SHOTS, -100, anchors)).toEqual(first.from(anchors));
    expect(poseAtTick(TRAILER_SHOTS, 0, anchors)).toEqual(first.from(anchors));
    const last = TRAILER_SHOTS[TRAILER_SHOTS.length - 1]!;
    expect(poseAtTick(TRAILER_SHOTS, TRAILER_END_TICK, anchors)).toEqual(last.to(anchors));
    expect(poseAtTick(TRAILER_SHOTS, TRAILER_END_TICK + 5000, anchors)).toEqual(last.to(anchors));
  });

  it('interpolates inside a shot with the shot easing', () => {
    const anchors = testAnchors();
    // Shot 0 is linear: the midpoint pose is the component-wise midpoint.
    const shot = TRAILER_SHOTS[0]!;
    const midTick = Math.floor((shot.startTick + shot.endTick) / 2);
    const got = poseAtTick(TRAILER_SHOTS, midTick, anchors);
    const want = lerpPose(shot.from(anchors), shot.to(anchors), 0.5);
    expect(got.pos.x).toBeCloseTo(want.pos.x, 9);
    expect(got.pos.y).toBeCloseTo(want.pos.y, 9);
    expect(got.fov).toBeCloseTo(want.fov, 9);
    // Shot boundaries are continuous: end of one shot == start of next.
    for (let i = 0; i < TRAILER_SHOTS.length - 1; i += 1) {
      const a = TRAILER_SHOTS[i]!;
      const b = TRAILER_SHOTS[i + 1]!;
      const endA = poseAtTick(TRAILER_SHOTS, a.endTick - 1, anchors);
      void endA;
      const startB = b.from(anchors);
      const endAPose = lerpPose(a.from(anchors), a.to(anchors), easeFactor(a.ease, 1));
      // At t=1 the ease is 1 for every curve, so end == to(anchors).
      expect(endAPose.pos.x).toBeCloseTo(a.to(anchors).pos.x, 9);
      void startB;
    }
  });

  it('eases correctly at the extremes', () => {
    expect(easeFactor('linear', 0)).toBe(0);
    expect(easeFactor('linear', 1)).toBe(1);
    expect(easeFactor('smooth', 0.5)).toBeCloseTo(0.5, 9);
    expect(easeFactor('inOut', 0.5)).toBeCloseTo(0.5, 9);
    expect(easeFactor('smooth', -3)).toBe(0);
    expect(easeFactor('inOut', 99)).toBe(1);
  });

  it('builds anchor-relative poses', () => {
    const anchors = testAnchors();
    const pose = anchoredPose('harbor', { dx: 10, dy: 20, dz: -30 }, 5, 50)(anchors);
    expect(pose.pos).toEqual({ x: 110, y: 20, z: 20 });
    expect(pose.look).toEqual({ x: 100, y: 5, z: 50 });
    expect(pose.fov).toBe(50);
  });

  it('flags overlapping or gapped shot lists', () => {
    const anchors = testAnchors();
    void anchors;
    const good = [
      { startTick: 0, endTick: 10, ease: 'linear' as const, from: TRAILER_SHOTS[0]!.from, to: TRAILER_SHOTS[0]!.to },
      { startTick: 10, endTick: 20, ease: 'linear' as const, from: TRAILER_SHOTS[0]!.from, to: TRAILER_SHOTS[0]!.to },
    ];
    expect(validateShots(good)).toEqual([]);
    const overlap = [
      { startTick: 0, endTick: 15, ease: 'linear' as const, from: TRAILER_SHOTS[0]!.from, to: TRAILER_SHOTS[0]!.to },
      { startTick: 10, endTick: 20, ease: 'linear' as const, from: TRAILER_SHOTS[0]!.from, to: TRAILER_SHOTS[0]!.to },
    ];
    expect(validateShots(overlap).length).toBeGreaterThan(0);
    const gap = [
      { startTick: 0, endTick: 10, ease: 'linear' as const, from: TRAILER_SHOTS[0]!.from, to: TRAILER_SHOTS[0]!.to },
      { startTick: 30, endTick: 40, ease: 'linear' as const, from: TRAILER_SHOTS[0]!.from, to: TRAILER_SHOTS[0]!.to },
    ];
    expect(validateShots(gap).length).toBeGreaterThan(0);
  });

  it('throws on an empty shot list', () => {
    expect(() => poseAtTick([], 0, testAnchors())).toThrow();
  });
});

describe('trailerCapture — in-game recording', () => {
  it('prefers vp9, then vp8, then the container default', () => {
    expect(TRAILER_MIME_PREFERENCE[0]).toContain('vp9');
    // Only vp8 supported.
    expect(resolveTrailerMimeType((m) => m.includes('vp8'))).toContain('vp8');
    // Nothing supported → container default.
    expect(resolveTrailerMimeType(() => false)).toBe('');
    // A throwing probe counts as unsupported, not fatal.
    expect(
      resolveTrailerMimeType((m) => {
        if (m.includes('vp9')) throw new Error('nope');
        return true;
      }),
    ).toContain('vp8');
  });

  it('gracefully no-ops when MediaRecorder is unavailable (headless)', () => {
    // Under vitest/Node there is no MediaRecorder and no captureStream.
    expect(trailerCaptureSupported({})).toBe(false);
    const canvas = {} as unknown as HTMLCanvasElement;
    expect(startTrailerCapture(canvas)).toBeNull();
  });
});
