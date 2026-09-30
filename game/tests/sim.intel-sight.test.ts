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
 * NOVATERRA — tests/sim.intel-sight.test.ts — grand-expansion Phase 7
 * (S6 intel, workstream 3, 2026-09-30): the building sight term in
 * `getVisibleEnemies` + the mixed-airport discovery lifecycle.
 *
 * Covers:
 *  - `buildingSightCoverage`: SIGINT (listeningPost 60, signalsStation
 *    45) sees everything including spies; radarStation (90) sees
 *    non-stealthed enemies only; the completed + operational +
 *    unsabotaged gate; satelliteUplink contributes through the
 *    effectiveSight hook (pinned — no geometric term of its own).
 *  - `getVisibleEnemies`: the building term reveals enemies beyond
 *    every unit's sight; recon units (reconTeam/reconUAV/reconPlane)
 *    see through their high platform sight; combat's `acquireTarget`
 *    stays think-cadence-only — a building-only contact is known to
 *    the AI but never auto-engaged.
 *  - Mixed-airport discovery: the warning → grace → reveal lifecycle
 *    (suspected at first observation, revealed after exactly
 *    AIRPORT_DISCOVERY_GRACE_TICKS), the three observation sources
 *    (embedded unburned spy, SIGINT coverage, recon overflight),
 *    suspicion latching, the display-rule flip (civilian while
 *    suspected, true type when revealed), no false discoveries, the
 *    intel-system wiring, save/load round-trip, digest coverage +
 *    determinism, and the UI seam (discoveryStateOf /
 *    airportDisplayType / discoveryWarnings / rivalAirports).
 *
 * No RNG is used anywhere in this file: discovery is pure geometry +
 * fixed timers, so every test is deterministic by construction.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  AIRPORT_DISCOVERY_GRACE_TICKS,
  airportObservedBy,
  buildingCenterWorld,
  buildingSightCoverage,
  createIntelSystem,
  isMixedAirportAnchor,
  isReconUnit,
  runAirportDiscovery,
} from '../src/sim/intel';
import { spawnUnit, UNIT_DEFS, type UnitKind } from '../src/sim/units';
import { acquireTarget } from '../src/sim/combat';
import { getVisibleEnemies } from '../src/sim/ai';
import { effectiveSight } from '../src/sim/upgrades';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { BUILDING_DEFS, type BuildingRecord } from '../src/sim/city';
import { airportDisplayType, discoveryStateOf } from '../src/ui/airports';
import { discoveryWarnings, rivalAirports, rivalAirportLine } from '../src/ui/intel';
import { completeBuilding } from './sim.roster-fixtures';

function setup(): World {
  return createWorld(20260930);
}

/** Place a completed, operational building and return its record. */
function place(world: World, kind: string, owner: number, cx: number, cz: number): BuildingRecord {
  completeBuilding(world, kind, owner, cx, cz);
  const b = world.city.buildings[world.city.buildings.length - 1];
  if (!b || b.kind !== kind) throw new Error(`place failed for ${kind}`);
  return b;
}

/** Advance the discovery simulation to `tick` (inclusive). */
function runTo(world: World, tick: number): void {
  for (let t = 0; t <= tick; t += 1) {
    world.tick = t;
    runAirportDiscovery(world);
  }
}

/** A mixed-airport anchor owned by 0, watched by nobody. */
function setupAnchor(): { world: World; anchor: BuildingRecord; center: { x: number; z: number } } {
  const world = setup();
  const anchor = place(world, 'mixedAirport', 0, 10, 10);
  return { world, anchor, center: buildingCenterWorld(anchor) };
}

// ---------------------------------------------------------------------------
// buildingSightCoverage: SIGINT sees everything, radar sees the overt
// ---------------------------------------------------------------------------

describe('buildingSightCoverage', () => {
  it('listeningPost (60) reveals an enemy beyond every unit sight', () => {
    const world = setup();
    const post = place(world, 'listeningPost', 0, 10, 10);
    const c = buildingCenterWorld(post);
    const enemy = spawnUnit(world, 'rifles', 1, c.x + 55, c.z);
    // No units of owner 0 at all: the building term alone must carry it.
    expect(getVisibleEnemies(world, 0).map((u) => u.id)).toContain(enemy.id);
  });

  it('signalsStation (45) covers its smaller radius', () => {
    const world = setup();
    const station = place(world, 'signalsStation', 0, 10, 10);
    const c = buildingCenterWorld(station);
    const near = spawnUnit(world, 'rifles', 1, c.x + 40, c.z);
    const far = spawnUnit(world, 'rifles', 1, c.x + 50, c.z);
    const ids = getVisibleEnemies(world, 0).map((u) => u.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
    expect(buildingSightCoverage(world, 0)).toHaveLength(1);
    expect(buildingSightCoverage(world, 0)[0]!.radius).toBe(45);
  });

  it('radarStation (90) reveals non-stealthed enemies but never spies', () => {
    const world = setup();
    const radar = place(world, 'radarStation', 0, 10, 10);
    const c = buildingCenterWorld(radar);
    const tank = spawnUnit(world, 'tank', 1, c.x + 80, c.z);
    const spy = spawnUnit(world, 'spy', 1, c.x + 70, c.z);
    const ids = getVisibleEnemies(world, 0).map((u) => u.id);
    // 80 < 90: the tank is a radar contact (far beyond rifles sight 18).
    expect(ids).toContain(tank.id);
    // 70 < 90 but stealthed: radar never sees spies — the counter-spy
    // monopoly stays with SIGINT (the documented §7 rationale).
    expect(ids).not.toContain(spy.id);
    // Control: the same geometry through a listeningPost DOES see the
    // spy — SIGINT sees everything inside its detection radius.
    const post = place(world, 'listeningPost', 0, 30, 10);
    const pc = buildingCenterWorld(post);
    spy.x = pc.x + 50;
    spy.z = pc.z;
    expect(getVisibleEnemies(world, 0).map((u) => u.id)).toContain(spy.id);
    expect(radar).toBeDefined();
  });

  it('the completed + operational + unsabotaged gate: a dead building is blind', () => {
    const world = setup();
    const c = (kind: string, cx: number): { x: number; z: number } =>
      buildingCenterWorld(place(world, kind, 0, cx, 10));
    const c1 = c('listeningPost', 10);
    const c2 = c('listeningPost', 30);
    const c3 = c('listeningPost', 50);
    const e1 = spawnUnit(world, 'rifles', 1, c1.x + 55, c1.z);
    const e2 = spawnUnit(world, 'rifles', 1, c2.x + 55, c2.z);
    const e3 = spawnUnit(world, 'rifles', 1, c3.x + 55, c3.z);
    const [b1, b2, b3] = world.city.buildings.slice(-3);
    b1!.sabotagedUntil = world.tick + 1000; // sabotaged: outage
    b2!.operational = false; // powered down / shut off
    b3!.progress = 0.5; // still under construction
    const ids = getVisibleEnemies(world, 0).map((u) => u.id);
    expect(ids).not.toContain(e1.id);
    expect(ids).not.toContain(e2.id);
    expect(ids).not.toContain(e3.id);
    expect(buildingSightCoverage(world, 0)).toHaveLength(0);
  });

  it('satelliteUplink contributes through the effectiveSight hook (no geometric term)', () => {
    const world = setup();
    const def = UNIT_DEFS['rifles' as UnitKind];
    const base = effectiveSight(world, 0, def);
    place(world, 'satelliteUplink', 0, 10, 10);
    // +12 intelSightBonus, the existing hook — pinned, unchanged.
    expect(effectiveSight(world, 0, def)).toBe(base + 12);
    // And no coverage entry: the uplink never becomes a geometric
    // "sees everything" disc.
    expect(buildingSightCoverage(world, 0)).toHaveLength(0);
  });

  it('recon units see through their high platform sight on the unit path', () => {
    const world = setup();
    expect(UNIT_DEFS.reconTeam.sight).toBe(44);
    // isReconUnit is a pure kind predicate — plain records keep the
    // geometry clean (no extra observers on the map).
    expect(isReconUnit({ kind: 'reconTeam' } as never)).toBe(true);
    expect(isReconUnit({ kind: 'reconUAV' } as never)).toBe(true);
    expect(isReconUnit({ kind: 'reconPlane' } as never)).toBe(true);
    expect(isReconUnit({ kind: 'rifles' } as never)).toBe(false);
    expect(isReconUnit({ kind: 'spy' } as never)).toBe(false);
    const team = spawnUnit(world, 'reconTeam', 0, 0, 0);
    const near = spawnUnit(world, 'rifles', 1, 40, 0);
    const far = spawnUnit(world, 'rifles', 1, 50, 0);
    const ids = getVisibleEnemies(world, 0).map((u) => u.id);
    expect(ids).toContain(near.id);
    expect(ids).not.toContain(far.id);
    expect(team).toBeDefined();
  });

  it('combat stays think-cadence-only: a building-only contact is never auto-engaged', () => {
    const world = setup();
    const post = place(world, 'listeningPost', 0, 10, 10);
    const c = buildingCenterWorld(post);
    const gunner = spawnUnit(world, 'rifles', 0, c.x, c.z);
    // 55: inside the listeningPost's 60 coverage, beyond rifles sight
    // (18) and weapon range (12).
    const enemy = spawnUnit(world, 'rifles', 1, c.x + 55, c.z);
    // The AI's picture (think cadence) knows about the contact…
    expect(getVisibleEnemies(world, 0).map((u) => u.id)).toContain(enemy.id);
    // …but combat (per-tick) cannot acquire what the unit itself can't
    // reach: the building term never enters acquireTarget.
    expect(acquireTarget(world, gunner, UNIT_DEFS['rifles' as UnitKind])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Mixed-airport discovery: warning → grace → reveal
// ---------------------------------------------------------------------------

describe('mixed-airport discovery', () => {
  it('isMixedAirportAnchor matches exactly the completed mixed airport', () => {
    const world = setup();
    const mixed = place(world, 'mixedAirport', 0, 10, 10);
    const civil = place(world, 'civilAirport', 0, 30, 10);
    const military = place(world, 'militaryAirbase', 0, 50, 10);
    expect(isMixedAirportAnchor(mixed)).toBe(true);
    expect(isMixedAirportAnchor(civil)).toBe(false);
    expect(isMixedAirportAnchor(military)).toBe(false);
    // Unfinished or non-airport buildings never anchor discovery.
    mixed.progress = 0.5;
    expect(isMixedAirportAnchor(mixed)).toBe(false);
  });

  it('a recon overflight warns first, reveals exactly at tick + 1800', () => {
    const { world, anchor, center } = setupAnchor();
    spawnUnit(world, 'reconTeam', 1, center.x + 30, center.z); // 30 < 44: overhead
    world.tick = 0;
    runAirportDiscovery(world);
    // The warning: a suspected record, display STILL civilian.
    const rec = discoveryStateOf(anchor, 1)!;
    expect(rec).toBeDefined();
    expect(rec.state).toBe('suspected');
    expect(rec.warnedTick).toBe(0);
    expect(rec.revealedTick).toBe(0);
    expect(airportDisplayType(anchor, 1)).toBe('civilian');
    expect(airportDisplayType(anchor, 0)).toBe('mixed'); // owner always sees truth
    // Suspicion is live through the whole grace window…
    world.tick = AIRPORT_DISCOVERY_GRACE_TICKS - 1;
    runAirportDiscovery(world);
    expect(discoveryStateOf(anchor, 1)!.state).toBe('suspected');
    // …and the reveal lands on the exact grace tick, no sooner.
    world.tick = AIRPORT_DISCOVERY_GRACE_TICKS;
    runAirportDiscovery(world);
    const revealed = discoveryStateOf(anchor, 1)!;
    expect(revealed.state).toBe('revealed');
    expect(revealed.revealedTick).toBe(AIRPORT_DISCOVERY_GRACE_TICKS);
    expect(airportDisplayType(anchor, 1)).toBe('mixed');
  });

  it('suspicion latches: the observer can leave, the reveal still lands', () => {
    const { world, anchor, center } = setupAnchor();
    const team = spawnUnit(world, 'reconTeam', 1, center.x + 30, center.z);
    world.tick = 0;
    runAirportDiscovery(world);
    expect(discoveryStateOf(anchor, 1)!.state).toBe('suspected');
    // The recon team leaves the area entirely…
    team.x = center.x + 500;
    runTo(world, AIRPORT_DISCOVERY_GRACE_TICKS);
    // …but the grace period was an analysis window, not a second
    // observation gate: the reveal still happens.
    expect(discoveryStateOf(anchor, 1)!.state).toBe('revealed');
  });

  it('no false discovery: out-of-range recon, and civilian/military anchors never', () => {
    const world = setup();
    // Anchors 60 cells (120 world units) apart: no recon asset parked
    // over one anchor can observe another (recon sight 44).
    const mixed = place(world, 'mixedAirport', 0, 10, 10);
    const civil = place(world, 'civilAirport', 0, 70, 10);
    const military = place(world, 'militaryAirbase', 0, 130, 10);
    const mc = buildingCenterWorld(mixed);
    const cc = buildingCenterWorld(civil);
    const milc = buildingCenterWorld(military);
    // Recon over each anchor — but beyond sight range of the mixed one.
    spawnUnit(world, 'reconTeam', 1, mc.x + 50, mc.z); // 50 > 44: too far
    spawnUnit(world, 'reconTeam', 1, cc.x, cc.z); // overhead the civil one
    spawnUnit(world, 'reconTeam', 1, milc.x, milc.z); // overhead the military one
    runTo(world, 5000);
    expect(mixed.discovery).toBeUndefined();
    expect(civil.discovery).toBeUndefined();
    expect(military.discovery).toBeUndefined();
  });

  it('an embedded unburned spy observes from inside', () => {
    const { world, anchor } = setupAnchor();
    const spy = spawnUnit(world, 'spy', 1, 0, 0);
    spy.embeddedIn = anchor.id;
    world.tick = 0;
    runAirportDiscovery(world);
    expect(discoveryStateOf(anchor, 1)!.state).toBe('suspected');
  });

  it('a burned spy does not observe', () => {
    const { world, anchor } = setupAnchor();
    const spy = spawnUnit(world, 'spy', 1, 0, 0);
    spy.embeddedIn = anchor.id;
    spy.spottedUntil = world.tick + 1000; // burned: its reports are tainted
    runTo(world, 500);
    expect(anchor.discovery).toBeUndefined();
  });

  it('SIGINT coverage of the airport observes without any unit nearby', () => {
    const { world, anchor, center } = setupAnchor();
    // A listeningPost of viewer 1 whose 60-unit coverage reaches the
    // anchor center. No recon units, no spies anywhere.
    const post = place(world, 'listeningPost', 1, 10, 30);
    const pc = buildingCenterWorld(post);
    expect(Math.hypot(center.x - pc.x, center.z - pc.z)).toBeLessThan(60);
    world.tick = 0;
    runAirportDiscovery(world);
    expect(discoveryStateOf(anchor, 1)!.state).toBe('suspected');
  });

  it('the owner never discovers their own airport', () => {
    const { world, anchor, center } = setupAnchor();
    spawnUnit(world, 'reconTeam', 0, center.x + 30, center.z);
    const spy = spawnUnit(world, 'spy', 0, 0, 0);
    spy.embeddedIn = anchor.id;
    runTo(world, 5000);
    expect(anchor.discovery).toBeUndefined();
  });

  it('airportObservedBy composes the three sources directly', () => {
    const { world, anchor, center } = setupAnchor();
    const team = spawnUnit(world, 'reconTeam', 1, center.x + 30, center.z);
    const spy = spawnUnit(world, 'spy', 1, 0, 0);
    spy.embeddedIn = anchor.id;
    // Recon overflight alone observes…
    expect(airportObservedBy(world, 1, anchor, [], [team])).toBe(true);
    // …as does an embedded unburned spy alone…
    expect(airportObservedBy(world, 1, anchor, [spy], [])).toBe(true);
    // …but a burned spy reports nothing.
    spy.spottedUntil = world.tick + 1000;
    expect(airportObservedBy(world, 1, anchor, [spy], [])).toBe(false);
    spy.spottedUntil = 0;
    // And a non-recon unit overhead is not a recon overflight.
    const grunt = spawnUnit(world, 'rifles', 1, center.x + 30, center.z);
    expect(airportObservedBy(world, 1, anchor, [], [grunt])).toBe(false);
    expect(airportObservedBy(world, 1, anchor, [], [])).toBe(false);
  });

  it('the intel system runs discovery every tick (the wiring pin)', () => {
    const { world, anchor, center } = setupAnchor();
    spawnUnit(world, 'reconTeam', 1, center.x + 30, center.z);
    const system = createIntelSystem();
    for (let t = 0; t < 5; t += 1) {
      world.tick = t;
      system(world, 1 / 30);
    }
    // Discovery ran on tick 0 without any direct call.
    expect(discoveryStateOf(anchor, 1)!.state).toBe('suspected');
    expect(discoveryStateOf(anchor, 1)!.warnedTick).toBe(0);
  });

  it('records are viewer-sorted and idempotent across ticks', () => {
    const { world, anchor } = setupAnchor();
    world.city.players.push({ ...world.city.players[0]!, id: 2, name: 'Rival2' });
    const spy1 = spawnUnit(world, 'spy', 1, 0, 0);
    spy1.embeddedIn = anchor.id;
    const spy2 = spawnUnit(world, 'spy', 2, 0, 0);
    spy2.embeddedIn = anchor.id;
    world.tick = 0;
    runAirportDiscovery(world);
    world.tick = 1;
    runAirportDiscovery(world);
    // One record per viewer, viewer order, no duplicates from rerunning.
    expect(anchor.discovery!.map((d) => d.viewer)).toEqual([1, 2]);
    runTo(world, AIRPORT_DISCOVERY_GRACE_TICKS + 100);
    expect(anchor.discovery!.every((d) => d.state === 'revealed')).toBe(true);
    expect(airportDisplayType(anchor, 2)).toBe('mixed');
  });

  it('the UI seam: warnings countdown, the rival list flips on reveal', () => {
    const { world, anchor } = setupAnchor();
    spawnUnit(world, 'reconTeam', 1, 0, 0);
    const team = world.units[world.units.length - 1]!;
    team.x = buildingCenterWorld(anchor).x + 30;
    team.z = buildingCenterWorld(anchor).z;
    world.tick = 0;
    runAirportDiscovery(world);
    // While suspected: one warning with the full 60s countdown, the
    // rival list shows the site as civilian / unverified.
    const warnings = discoveryWarnings(world, 1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.id).toBe(`discovery-${anchor.id}`);
    expect(warnings[0]!.kind).toBe('discovery');
    expect(warnings[0]!.secondsLeft).toBe(60);
    const before = rivalAirports(world, 1);
    expect(before).toHaveLength(1);
    expect(before[0]!.display).toBe('civilian');
    expect(before[0]!.discovered).toBe(false);
    expect(before[0]!.discoveryState).toBe('suspected');
    expect(rivalAirportLine(before[0]!)).toContain('UNVERIFIED');
    // After the reveal: no warning (nothing left to warn about), the
    // list reads mixed and confirmed.
    runTo(world, AIRPORT_DISCOVERY_GRACE_TICKS);
    expect(discoveryWarnings(world, 1)).toHaveLength(0);
    const after = rivalAirports(world, 1);
    expect(after[0]!.display).toBe('mixed');
    expect(after[0]!.discovered).toBe(true);
    expect(after[0]!.discoveryState).toBe('revealed');
    expect(rivalAirportLine(after[0]!)).toContain('CONFIRMED');
  });

  it('survives the save/load round-trip and stays digest-stable', () => {
    const { world, anchor, center } = setupAnchor();
    spawnUnit(world, 'reconTeam', 1, center.x + 30, center.z);
    runTo(world, 100); // suspected
    const digestSuspected = digestWorld(world);
    const snap1 = takeSnapshot(world);
    const back1 = restoreSnapshot(snap1);
    expect(discoveryStateOf(back1.city.buildings.find((b) => b.id === anchor.id)!, 1)!.state)
      .toBe('suspected');
    expect(digestWorld(back1)).toBe(digestSuspected);
    runTo(world, AIRPORT_DISCOVERY_GRACE_TICKS); // revealed
    const digestRevealed = digestWorld(world);
    expect(digestRevealed).not.toBe(digestSuspected); // the segment covers discovery
    const snap2 = takeSnapshot(world);
    const back2 = restoreSnapshot(snap2);
    const anchor2 = back2.city.buildings.find((b) => b.id === anchor.id)!;
    const rec2 = discoveryStateOf(anchor2, 1)!;
    expect(rec2.state).toBe('revealed');
    expect(rec2.warnedTick).toBe(0);
    expect(rec2.revealedTick).toBe(AIRPORT_DISCOVERY_GRACE_TICKS);
    expect(digestWorld(back2)).toBe(digestRevealed);
  });

  it('is seed-stable: the same script always digests identically', () => {
    const script = (): string => {
      const { world, center } = setupAnchor();
      spawnUnit(world, 'reconTeam', 1, center.x + 30, center.z);
      runTo(world, 2500);
      return digestWorld(world);
    };
    expect(script()).toBe(script());
  });

  it('mixed defs read civilian to others until discovered (the def-level pin)', () => {
    expect(BUILDING_DEFS.mixedAirport.airportType).toBe('mixed');
    const { world, anchor } = setupAnchor();
    // Fresh anchor: no records anywhere, every viewer sees civilian.
    expect(anchor.discovery).toBeUndefined();
    expect(airportDisplayType(anchor, 1)).toBe('civilian');
  });
});
