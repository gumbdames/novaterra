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
 * NOVATERRA — intel panel UI tests (ui/intel.ts, grand-expansion Phase 7).
 *
 * Covers the intel UI contract module: asset counters + accrual rates
 * (mirroring the sim's runIntelAccrual), spy display states, warnings
 * (countdowns + what-happens-next — the no-gotcha rule), rival airports
 * (discovered/undiscovered), op targets, the steal preview, the static
 * action copy (costs come from the sim constants), the digest segments,
 * and the player-facing language rules (English-only, no sim-internals
 * leakage). Determinism: same state ⇒ same lines, twice.
 */
import { describe, expect, it } from 'vitest';

import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { cellCenterWorld, type BuildingKind, type BuildingRecord } from '../src/sim/city';
import { spawnUnit, type UnitRecord } from '../src/sim/units';
import {
  AIRPORT_DISCOVERY_GRACE_TICKS,
  INFILTRATE_DURATION_TICKS,
  INTEL_ADJACENCY,
  SPOTTED_DURATION_TICKS,
  runAirportDiscovery,
  runIntelAccrual,
} from '../src/sim/intel';
import {
  buildingLabel,
  hasIntelBuildings,
  infiltrateLabel,
  intelAirportsDigest,
  intelAssetLines,
  intelAssetsDigest,
  intelAccrualRatesOf,
  intelChipValues,
  intelRatesDigest,
  intelSpiesDigest,
  intelWarnings,
  intelWarningsDigest,
  opTargetsOf,
  playerSpies,
  rivalAirportLine,
  rivalAirports,
  sabotageLabel,
  spyDisplayState,
  spyHeader,
  spyMissionLine,
  spyStateCode,
  spyUnitDigest,
  stealPayoffLine,
  stealPreviewTechId,
  stealTechLabel,
  trainSpyHint,
  warningLine,
} from '../src/ui/intel';

const RIVAL = 1;

function addBuilding(
  world: ReturnType<typeof createSession>['world'],
  kind: BuildingKind,
  owner: number,
  cx = 64,
  cz = 64,
): BuildingRecord {
  const b: BuildingRecord = {
    id: world.city.nextBuildingId++,
    kind,
    owner,
    cx,
    cz,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  };
  world.city.buildings.push(b);
  return b;
}

/** World position next to a building (inside INTEL_ADJACENCY). */
function nearBuilding(b: BuildingRecord): { x: number; z: number } {
  return { x: cellCenterWorld(b.cx) + 4, z: cellCenterWorld(b.cz) };
}

describe('intel asset counters + accrual rates', () => {
  it('rates mirror the sim accrual exactly', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID); // surveillance 0.25
    addBuilding(world, 'intelHQ', HUMAN_PLAYER_ID); // operational 0.2, surveillance 0.1
    const rates = intelAccrualRatesOf(world, HUMAN_PLAYER_ID);
    expect(rates.surveillance).toBeCloseTo(0.35, 9);
    expect(rates.operational).toBeCloseTo(0.2, 9);
    expect(rates.counterIntel).toBeCloseTo(0, 9);
    // The sim's own accrual over 10s lands exactly on the mirrored rates.
    runIntelAccrual(world, 10);
    const assets = world.city.players[HUMAN_PLAYER_ID]!.intel;
    expect(assets.surveillance).toBeCloseTo(rates.surveillance * 10, 9);
    expect(assets.operational).toBeCloseTo(rates.operational * 10, 9);
  });

  it('signalsIntel multiplies surveillance x1.5, counterIntel x1.25 on counter-intel', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID);
    addBuilding(world, 'signalsStation', HUMAN_PLAYER_ID); // counterIntel 0.2
    world.upgrades[HUMAN_PLAYER_ID] = ['signalsIntel', 'counterIntel'];
    const rates = intelAccrualRatesOf(world, HUMAN_PLAYER_ID);
    expect(rates.surveillance).toBeCloseTo(0.25 * 1.5, 9);
    expect(rates.counterIntel).toBeCloseTo(0.2 * 1.25, 9);
  });

  it('incomplete, non-operational, and sabotaged buildings accrue nothing', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const b = addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID);
    b.progress = 0.5;
    expect(intelAccrualRatesOf(world, HUMAN_PLAYER_ID).surveillance).toBe(0);
    b.progress = 1;
    b.operational = false;
    expect(intelAccrualRatesOf(world, HUMAN_PLAYER_ID).surveillance).toBe(0);
    b.operational = true;
    b.sabotagedUntil = world.tick + 100;
    expect(intelAccrualRatesOf(world, HUMAN_PLAYER_ID).surveillance).toBe(0);
    b.sabotagedUntil = 0;
    expect(intelAccrualRatesOf(world, HUMAN_PLAYER_ID).surveillance).toBeCloseTo(0.25, 9);
  });

  it('asset lines and chip values render floored counters with rates', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID);
    world.city.players[HUMAN_PLAYER_ID]!.intel.surveillance = 12.7;
    const lines = intelAssetLines(world, HUMAN_PLAYER_ID);
    expect(lines[0]).toBe('Surveillance 12 (+0.3/s)');
    expect(lines[1]).toBe('Operational 0 (+0.0/s)');
    expect(lines[2]).toBe('Counter-intel 0 (+0.0/s)');
    expect(intelChipValues(world, HUMAN_PLAYER_ID)).toEqual(['12', '0', '0']);
  });

  it('hasIntelBuildings is false before the first intel building', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    expect(hasIntelBuildings(world, HUMAN_PLAYER_ID)).toBe(false);
    addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID);
    expect(hasIntelBuildings(world, HUMAN_PLAYER_ID)).toBe(true);
  });
});

describe('spy display state', () => {
  function spyWorld() {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, 0, 0) as UnitRecord;
    return { world, spy };
  }

  it('a fresh spy is hidden', () => {
    const { world, spy } = spyWorld();
    expect(spyDisplayState(world, spy)).toEqual({ kind: 'hidden' });
    expect(spyMissionLine(world, spy)).toBe('Hidden — undetected');
  });

  it('a burned spy is exposed with a 30s countdown', () => {
    const { world, spy } = spyWorld();
    spy.spottedUntil = world.tick + SPOTTED_DURATION_TICKS;
    const state = spyDisplayState(world, spy);
    expect(state).toEqual({ kind: 'burned', secondsLeft: 30 });
    expect(spyMissionLine(world, spy)).toBe('Exposed — visible to all enemies · 30s left');
  });

  it('an infiltrating spy shows target + countdown', () => {
    const { world, spy } = spyWorld();
    const target = addBuilding(world, 'powerPlant', RIVAL, 200, 200);
    spy.missionEndsAt = world.tick + INFILTRATE_DURATION_TICKS;
    spy.missionTargetId = target.id;
    const state = spyDisplayState(world, spy);
    expect(state.kind).toBe('infiltrating');
    if (state.kind === 'infiltrating') {
      expect(state.secondsLeft).toBe(20);
      expect(state.targetLabel).toBe('Power Plant');
    }
    expect(spyMissionLine(world, spy)).toBe('Infiltrating Power Plant · 20s left');
  });

  it('an embedded spy is ready to steal tech', () => {
    const { world, spy } = spyWorld();
    const target = addBuilding(world, 'powerPlant', RIVAL, 200, 200);
    spy.embeddedIn = target.id;
    expect(spyDisplayState(world, spy)).toEqual({
      kind: 'embedded',
      targetId: target.id,
      targetLabel: 'Power Plant',
    });
    expect(spyMissionLine(world, spy)).toBe('Embedded in Power Plant — ready to steal tech');
  });

  it('a spy inside rival detection coverage is flagged detected', () => {
    const { world, spy } = spyWorld();
    // Rival listeningPost (detectionRadius 60) at (64,64); the spy
    // stands on its doorstep.
    const post = addBuilding(world, 'listeningPost', RIVAL);
    const near = nearBuilding(post);
    spy.x = near.x;
    spy.z = near.z;
    const state = spyDisplayState(world, spy);
    expect(state.kind).toBe('detected');
    expect(spyMissionLine(world, spy)).toBe(
      'Inside rival detection coverage — visible to them',
    );
  });

  it('burned takes precedence over an active mission', () => {
    const { world, spy } = spyWorld();
    const target = addBuilding(world, 'powerPlant', RIVAL, 200, 200);
    spy.missionEndsAt = world.tick + INFILTRATE_DURATION_TICKS;
    spy.missionTargetId = target.id;
    spy.spottedUntil = world.tick + SPOTTED_DURATION_TICKS;
    expect(spyDisplayState(world, spy).kind).toBe('burned');
  });

  it('spyHeader names the spy and its position', () => {
    const { world, spy } = spyWorld();
    spy.x = 120.6;
    spy.z = 340.2;
    expect(spyHeader(spy)).toBe(`Spy ${spy.id} · at (121, 340)`);
  });
});

describe('intel warnings (no gotcha UX)', () => {
  it('a burned spy raises an exposure warning with countdown + what-next', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, 0, 0) as UnitRecord;
    spy.spottedUntil = world.tick + SPOTTED_DURATION_TICKS;
    const warnings = intelWarnings(world, HUMAN_PLAYER_ID);
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    expect(w.kind).toBe('exposure');
    expect(w.secondsLeft).toBe(30);
    expect(w.whatNext.length).toBeGreaterThan(0);
    const line = warningLine(w);
    expect(line).toContain(`Spy ${spy.id} exposed`);
    expect(line).toContain('30s left');
    expect(line).toContain(w.whatNext);
  });

  it('a spy inside rival coverage raises a detection-risk warning (no timer)', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const post = addBuilding(world, 'listeningPost', RIVAL);
    const near = nearBuilding(post);
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, near.x, near.z) as UnitRecord;
    const warnings = intelWarnings(world, HUMAN_PLAYER_ID);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.kind).toBe('detection-risk');
    expect(warnings[0]!.secondsLeft).toBeNull();
    expect(warnings[0]!.whatNext).toContain('Move the spy');
  });

  it('a sabotaged player building raises a sabotage warning with countdown', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const b = addBuilding(world, 'powerPlant', HUMAN_PLAYER_ID);
    b.sabotagedUntil = world.tick + 1350; // 45s
    const warnings = intelWarnings(world, HUMAN_PLAYER_ID);
    expect(warnings).toHaveLength(1);
    const w = warnings[0]!;
    expect(w.kind).toBe('sabotage');
    expect(w.id).toBe(`sabotage-${b.id}`);
    expect(w.secondsLeft).toBe(45);
    expect(whatLine(w)).toContain('Power Plant sabotaged');
    expect(whatLine(w)).toContain('45s left');
    expect(whatLine(w)).toContain('Comes back online');
    function whatLine(x: typeof w): string {
      return warningLine(x);
    }
  });

  it('no warnings when all is quiet', () => {
    const session = createSession({ seed: 4242 });
    expect(intelWarnings(session.world, HUMAN_PLAYER_ID)).toEqual([]);
  });

  it('warning lines never reference sim internals', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, 0, 0) as UnitRecord;
    spy.spottedUntil = world.tick + SPOTTED_DURATION_TICKS;
    const b = addBuilding(world, 'powerPlant', HUMAN_PLAYER_ID);
    b.sabotagedUntil = world.tick + 100;
    for (const w of intelWarnings(world, HUMAN_PLAYER_ID)) {
      const line = warningLine(w);
      for (const internal of ['spottedUntil', 'sabotagedUntil', 'missionEndsAt', 'intel-']) {
        expect(line).not.toContain(internal);
      }
    }
    expect(spyMissionLine(world, spy)).not.toContain('spottedUntil');
  });
});

describe('rival airports (discovered / undiscovered)', () => {
  it('military airbases are known, mixed airports are UNVERIFIED', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    addBuilding(world, 'militaryAirbase', RIVAL);
    addBuilding(world, 'mixedAirport', RIVAL);
    addBuilding(world, 'civilAirport', RIVAL);
    const airports = rivalAirports(world, HUMAN_PLAYER_ID);
    expect(airports).toHaveLength(3);
    const byKind = new Map(airports.map((a) => [a.kind, a]));
    expect(byKind.get('militaryAirbase')!.discovered).toBe(true);
    expect(byKind.get('militaryAirbase')!.display).toBe('military');
    expect(byKind.get('mixedAirport')!.discovered).toBe(false);
    expect(byKind.get('mixedAirport')!.display).toBe('civilian');
    expect(byKind.get('civilAirport')!.discovered).toBe(true);
    const mixedLine = rivalAirportLine(byKind.get('mixedAirport')!);
    expect(mixedLine).toContain('Mixed Airport');
    expect(mixedLine).toContain('UNVERIFIED');
    expect(mixedLine).toContain('reads as civilian until discovered');
    const militaryLine = rivalAirportLine(byKind.get('militaryAirbase')!);
    expect(militaryLine).toContain('known');
    expect(militaryLine).not.toContain('UNVERIFIED');
  });

  it("the player's own airports are not listed", () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    addBuilding(world, 'civilAirport', HUMAN_PLAYER_ID);
    expect(rivalAirports(world, HUMAN_PLAYER_ID)).toEqual([]);
  });
});

describe('mixed-airport discovery lifecycle (warning → grace → reveal)', () => {
  function discoveryWorld() {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const a = addBuilding(world, 'mixedAirport', RIVAL, 200, 200);
    // The viewer's intel net (a listeningPost, detection radius 60)
    // covers the airport → observed by SIGINT.
    addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID, 200, 202);
    return { world, a };
  }

  it('first observation raises the warning; the display still reads civilian', () => {
    const { world, a } = discoveryWorld();
    runAirportDiscovery(world);
    const warnings = intelWarnings(world, HUMAN_PLAYER_ID);
    const dw = warnings.find((w) => w.kind === 'discovery');
    expect(dw).toBeDefined();
    // 1800 ticks at 30 ticks/sec = 60s grace, quantized to whole seconds.
    expect(dw!.secondsLeft).toBe(60);
    expect(dw!.whatNext.length).toBeGreaterThan(0);
    const line = warningLine(dw!);
    expect(line).toContain('Suspicious military activity');
    expect(line).toContain('60s left');
    expect(line).toContain(dw!.whatNext);
    const info = rivalAirports(world, HUMAN_PLAYER_ID).find((x) => x.id === a.id)!;
    expect(info.display).toBe('civilian');
    expect(info.discovered).toBe(false);
    expect(info.discoveryState).toBe('suspected');
    expect(rivalAirportLine(info)).toContain('UNVERIFIED');
    // The airport digest still reads civilian — the reveal is what
    // flips it (AD11: the panel repaints exactly when the value does).
    expect(intelAirportsDigest(world, HUMAN_PLAYER_ID)).toContain(`ig:${a.id}.civilian`);
    expect(intelWarningsDigest(world, HUMAN_PLAYER_ID)).toContain(
      `iw:discovery-${a.id}.discovery.60`,
    );
  });

  it('after the grace period the airport is confirmed mixed and the warning ends', () => {
    const { world, a } = discoveryWorld();
    runAirportDiscovery(world);
    world.tick += AIRPORT_DISCOVERY_GRACE_TICKS;
    runAirportDiscovery(world);
    const info = rivalAirports(world, HUMAN_PLAYER_ID).find((x) => x.id === a.id)!;
    expect(info.discoveryState).toBe('revealed');
    expect(info.discovered).toBe(true);
    expect(info.display).toBe('mixed');
    expect(rivalAirportLine(info)).toContain('CONFIRMED');
    // The warning is gone — suspicion latched into the reveal; the
    // digest moves to the confirmed display.
    expect(
      intelWarnings(world, HUMAN_PLAYER_ID).some((w) => w.kind === 'discovery'),
    ).toBe(false);
    expect(intelAirportsDigest(world, HUMAN_PLAYER_ID)).toContain(`ig:${a.id}.mixed`);
  });

  it('no observation, no warning, no records', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const a = addBuilding(world, 'mixedAirport', RIVAL, 200, 200);
    runAirportDiscovery(world);
    expect(a.discovery ?? []).toEqual([]);
    expect(intelWarnings(world, HUMAN_PLAYER_ID)).toEqual([]);
  });
});

describe('covert-action targets + steal preview', () => {
  it('opTargetsOf lists adjacent enemy completed buildings in id order', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const near1 = addBuilding(world, 'powerPlant', RIVAL, 64, 64);
    const near2 = addBuilding(world, 'barracks', RIVAL, 65, 64);
    addBuilding(world, 'powerPlant', RIVAL, 200, 200); // far away
    const own = addBuilding(world, 'powerPlant', HUMAN_PLAYER_ID, 64, 66);
    const pos = nearBuilding(near1);
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, pos.x, pos.z) as UnitRecord;
    const targets = opTargetsOf(world, spy);
    expect(targets.map((b) => b.id)).toEqual([near1.id, near2.id]);
    expect(targets).not.toContainEqual(own);
    // Incomplete buildings are not targets.
    near2.progress = 0.5;
    expect(opTargetsOf(world, spy).map((b) => b.id)).toEqual([near1.id]);
  });

  it('opTargetsOf respects INTEL_ADJACENCY exactly', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const b = addBuilding(world, 'powerPlant', RIVAL);
    const c = { x: cellCenterWorld(b.cx), z: cellCenterWorld(b.cz) };
    const inside = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, c.x + INTEL_ADJACENCY - 1, c.z);
    expect(opTargetsOf(world, inside).map((x) => x.id)).toEqual([b.id]);
    const outside = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, c.x + INTEL_ADJACENCY + 5, c.z);
    expect(opTargetsOf(world, outside)).toEqual([]);
  });

  it('stealPreviewTechId picks the deterministic stealable tech', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    world.upgrades[RIVAL] = ['compositeArmor', 'apRounds'];
    world.upgrades[HUMAN_PLAYER_ID] = ['apRounds'];
    expect(stealPreviewTechId(world, HUMAN_PLAYER_ID, RIVAL)).toBe('compositeArmor');
    world.upgrades[HUMAN_PLAYER_ID] = ['apRounds', 'compositeArmor'];
    expect(stealPreviewTechId(world, HUMAN_PLAYER_ID, RIVAL)).toBeNull();
  });
});

describe('covert-action copy (costs from the sim constants)', () => {
  it('labels carry the sim costs', () => {
    expect(infiltrateLabel()).toBe('Infiltrate');
    expect(sabotageLabel()).toBe('Sabotage · 25');
    expect(stealTechLabel()).toBe('Steal tech · 15');
    expect(stealPayoffLine()).toBe('A successful steal grants 40 research');
  });

  it('trainSpyHint names the Intelligence HQ and the sim train costs', () => {
    const hint = trainSpyHint();
    expect(hint).toContain('Intelligence Headquarters');
    expect(hint).toContain('400');
    expect(hint).toContain('40');
  });

  it('buildingLabel falls back gracefully', () => {
    expect(buildingLabel(undefined)).toBe('?');
  });
});

describe('intel digest segments (AD11)', () => {
  it('ia:/ir: carry floored counters and 2-decimal rates', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    expect(intelAssetsDigest(world, HUMAN_PLAYER_ID)).toBe('ia:0:0:0');
    expect(intelRatesDigest(world, HUMAN_PLAYER_ID)).toBe('ir:0.00:0.00:0.00');
    addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID);
    world.city.players[HUMAN_PLAYER_ID]!.intel.surveillance = 7.9;
    expect(intelAssetsDigest(world, HUMAN_PLAYER_ID)).toBe('ia:7:0:0');
    expect(intelRatesDigest(world, HUMAN_PLAYER_ID)).toBe('ir:0.25:0.00:0.00');
  });

  it('is: codes every spy state; iu: codes the selected unit', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    expect(intelSpiesDigest(world, HUMAN_PLAYER_ID)).toBe('is:');
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, 0, 0) as UnitRecord;
    expect(intelSpiesDigest(world, HUMAN_PLAYER_ID)).toBe(`is:${spy.id}:h`);
    expect(spyStateCode(world, spy)).toBe('h');
    expect(spyUnitDigest(world, spy.id, spy, HUMAN_PLAYER_ID)).toBe(`iu:${spy.id}:h`);
    // A non-spy selection digests x (the panel renders no intel line).
    const rifles = world.units.find((u) => u.owner === HUMAN_PLAYER_ID && u.kind === 'rifles')!;
    expect(spyUnitDigest(world, rifles.id, rifles, HUMAN_PLAYER_ID)).toBe(`iu:${rifles.id}:x`);
    // An enemy spy the player somehow selected also digests x (no line rendered).
    const enemy = spawnUnit(world, 'spy', RIVAL, 500, 500) as UnitRecord;
    expect(spyUnitDigest(world, enemy.id, enemy, HUMAN_PLAYER_ID)).toBe(`iu:${enemy.id}:x`);
    // Unknown selection id digests x with the selection's id.
    expect(spyUnitDigest(world, 99999, undefined, HUMAN_PLAYER_ID)).toBe('iu:99999:x');
    // Mission states move the code.
    spy.spottedUntil = world.tick + SPOTTED_DURATION_TICKS;
    expect(spyStateCode(world, spy)).toBe('b30');
    expect(intelSpiesDigest(world, HUMAN_PLAYER_ID)).toBe(`is:${spy.id}:b30`);
    expect(spyUnitDigest(world, spy.id, spy, HUMAN_PLAYER_ID)).toBe(`iu:${spy.id}:b30`);
  });

  it('iw: codes warnings; ig: codes rival airports', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    expect(intelWarningsDigest(world, HUMAN_PLAYER_ID)).toBe('iw:');
    expect(intelAirportsDigest(world, HUMAN_PLAYER_ID)).toBe('ig:');
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, 0, 0) as UnitRecord;
    spy.spottedUntil = world.tick + 900;
    expect(intelWarningsDigest(world, HUMAN_PLAYER_ID)).toBe(
      `iw:burned-${spy.id}.exposure.30`,
    );
    const a = addBuilding(world, 'mixedAirport', RIVAL);
    expect(intelAirportsDigest(world, HUMAN_PLAYER_ID)).toBe(`ig:${a.id}.civilian`);
  });

  it('deterministic: same state renders the same lines twice', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    addBuilding(world, 'listeningPost', HUMAN_PLAYER_ID);
    const spy = spawnUnit(world, 'spy', HUMAN_PLAYER_ID, 10, 10) as UnitRecord;
    spy.spottedUntil = world.tick + 450;
    const once = [
      intelAssetLines(world, HUMAN_PLAYER_ID).join('|'),
      spyMissionLine(world, spy),
      intelWarnings(world, HUMAN_PLAYER_ID).map(warningLine).join('|'),
      intelAssetsDigest(world, HUMAN_PLAYER_ID),
      intelSpiesDigest(world, HUMAN_PLAYER_ID),
      intelWarningsDigest(world, HUMAN_PLAYER_ID),
    ].join('||');
    const twice = [
      intelAssetLines(world, HUMAN_PLAYER_ID).join('|'),
      spyMissionLine(world, spy),
      intelWarnings(world, HUMAN_PLAYER_ID).map(warningLine).join('|'),
      intelAssetsDigest(world, HUMAN_PLAYER_ID),
      intelSpiesDigest(world, HUMAN_PLAYER_ID),
      intelWarningsDigest(world, HUMAN_PLAYER_ID),
    ].join('||');
    expect(twice).toBe(once);
  });
});
