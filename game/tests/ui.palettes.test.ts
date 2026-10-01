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
 * NOVATERRA — tabbed palette + research panel tests (roster expansion).
 *
 * ui/palettes.ts is pure and headless-safe: these tests pin the tab
 * groupings (every kind in exactly one tab), the English-only string
 * coverage, the grey-out logic (mirrors of the sim's spawnUnit /
 * researchUpgrade validation), and the researchUpgrade command behavior
 * through the session queue (which ui/session.ts wires up).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { UNIT_DEFS, type UnitKind } from '../src/sim/units';
import { BUILDING_DEFS, type BuildingKind, getPlayer } from '../src/sim/city';
import { UPGRADE_IDS, type UpgradeId } from '../src/sim/upgrades';
import { CommandRejectedError } from '../src/sim/commands';
import {
  createSession,
  HUMAN_PLAYER_ID,
} from '../src/ui/session';
import {
  TRAIN_TABS,
  BUILD_TABS,
  UPGRADE_GROUPS,
  unitAvailability,
  buildingAvailability,
  upgradeAvailability,
  playerHasCompletedLab,
  formatTrainCost,
  formatBuildCost,
  formatResearchCost,
  unitName,
  buildingName,
  upgradeName,
  upgradeEffect,
} from '../src/ui/palettes';
import { STRINGS, setUiLanguage } from '../src/ui/strings';
import type { World } from '../src/sim/world';

afterEach(() => {
  // Language is global module state — never leak it between tests.
  // English is the only shipped language (see docs/I18N.md).
  setUiLanguage('en');
});

function sortedKinds(kinds: Iterable<string>): string[] {
  return [...kinds].sort();
}

describe('train tabs', () => {
  it('covers every unit kind exactly once', () => {
    const seen = new Map<string, number>();
    for (const tab of TRAIN_TABS) {
      for (const kind of tab.kinds) {
        seen.set(kind, (seen.get(kind) ?? 0) + 1);
      }
    }
    // The Phase 3 supply trucks ride the armor tab (UI workstream,
    // 2026-09-30) — covered here like every other kind.
    const expected = Object.keys(UNIT_DEFS);
    expect(sortedKinds(seen.keys())).toEqual(sortedKinds(expected));
    for (const [kind, count] of seen) {
      expect(count, `${kind} in ${count} tabs`).toBe(1);
    }
  });

  it('matches the spec §8 grouping', () => {
    const byId = new Map(TRAIN_TABS.map((t) => [t.id, [...t.kinds]]));
    expect(byId.get('infantry')).toEqual([
      'engineer',
      'rifles',
      'sniperTeam',
      'spectre',
      'combatMedic',
      'hauler',
      // Grand-expansion Phase 8 (tech levels, 2026-09-30): the hauler's
      // Mk II/III civilian tech path.
      'haulerMk2',
      'haulerMk3',
    ]);
    expect(byId.get('armor')).toEqual([
      'tank',
      // Phase 8 (tech levels): variants sit next to their base kinds.
      'tankMk2',
      'tankMk3',
      'apc',
      'apcMk2',
      'apcMk3',
      'tankDestroyer',
      'artillery',
      'artilleryMk2',
      'artilleryMk3',
      'mlrs',
      'aa',
      'aaMk2',
      'aaMk3',
      'hq',
      // Phase 3 (logistics, UI workstream 2026-09-30): the supply trucks
      // ride with the land vehicles — no production gate, like the hauler.
      'supplyTruck',
      'fuelTruck',
    ]);
    expect(byId.get('air')).toEqual([
      'fighter',
      'fighterMk2',
      'fighterMk3',
      'fighterBomber',
      'fighterBomberMk2',
      'fighterBomberMk3',
      'attackHeli',
      'attackHeliMk2',
      'attackHeliMk3',
      'drone',
      'awacs',
      'transport',
      // Grand-expansion Phase 5 — aircraft expansion (workstream B,
      // 2026-09-30): the 16 new air kinds.
      'strategicBomber',
      'maritimePatrol',
      'reconUAV',
      'armedUAV',
      'reconPlane',
      'gunship',
      // Phase 8 (tech levels): the gunship's Mk II/III.
      'gunshipMk2',
      'gunshipMk3',
      'tanker',
      'militaryCargo',
      'trainer',
      'navalFighter',
      'airliner',
      'jumboAirliner',
      'regionalJet',
      'cargoPlane',
      'passengerHeli',
      'seaplane',
    ]);
    expect(byId.get('navy')).toEqual([
      'patrolBoat',
      'missileBoat',
      'missileBoatMk2',
      'missileBoatMk3',
      'frigate',
      'frigateMk2',
      'frigateMk3',
      'submarine',
      'submarineMk2',
      'submarineMk3',
      'destroyer',
      'destroyerMk2',
      'destroyerMk3',
      'carrier',
      'commandShip',
      'transportShip',
      // Phase 8 (tech levels): the transport ship's civilian Mk II/III.
      'transportShipMk2',
      'transportShipMk3',
      'fishingBoat',
      // Grand-expansion Phase 6 — naval expansion (workstream C,
      // 2026-09-30): the 15 new sea kinds.
      'coastalSub',
      'missileSub',
      'corvette',
      'cruiser',
      'battleship',
      'heavyDestroyer',
      'cargoFreighter',
      'fuelTanker',
      // Civilian sea trade (Half A, 2026-10-01; renamed the Civilian
      // Shipyard, 2026-10-01): the civilian fuel barge trains at the
      // commercialHarbor kind, alongside the freighter.
      'fuelBarge',
      'ammoShip',
      'repairShip',
      'minelayer',
      'navalMine',
      'coastGuardCutter',
      'cruiseLiner',
      'yacht',
    ]);
  });

  it('every tab has an English name', () => {
    for (const tab of TRAIN_TABS) {
      const entry = STRINGS.unitTabs[tab.id];
      expect(entry, `unitTabs.${tab.id}`).toBeDefined();
      expect(entry!.en.length).toBeGreaterThan(0);
    }
  });
});

describe('build tabs', () => {
  it('covers every building kind exactly once', () => {
    const seen = new Map<string, number>();
    for (const tab of BUILD_TABS) {
      for (const kind of tab.kinds) {
        seen.set(kind, (seen.get(kind) ?? 0) + 1);
      }
    }
    expect(sortedKinds(seen.keys())).toEqual(sortedKinds(Object.keys(BUILDING_DEFS)));
    for (const [kind, count] of seen) {
      expect(count, `${kind} in ${count} tabs`).toBe(1);
    }
  });

  it('matches the spec §8 grouping', () => {
    const byId = new Map(BUILD_TABS.map((t) => [t.id, [...t.kinds]]));
    expect(byId.get('housing')).toEqual(['house', 'apartment']);
    // Workstream Z (2026-09-30): the civic tab — the four education
    // buildings together; the hospital stays in Commerce.
    // Workstream W (2026-09-30): the two civic amenities (library/park).
    // Workstream P (ambient city life, 2026-09-30): civic parking.
    // Grand-expansion Phase 8 (civilian deep-dive, workstream E,
    // 2026-09-30): museum/theater/stadium/botanical garden + fire
    // station join the civic amenities.
    expect(byId.get('civic')).toEqual(['kindergarten', 'school', 'college', 'university', 'library', 'park', 'parkingLot', 'parkingGarage', 'museum', 'theater', 'sportsStadium', 'botanicalGarden', 'fireStation']);
    expect(byId.get('commerce')).toEqual([
      'shop',
      'market',
      // Phase 8 (workstream E): the market's tech-level step, the bank,
      // the office tower, and the clinic → medical center health ladder.
      'grandMarket',
      'bank',
      'officeTower',
      'lab',
      'mediaCenter',
      'hospital',
      'clinic',
      'medicalCenter',
    ]);
    expect(byId.get('industry')).toEqual([
      'factory',
      'farm',
      'quarry',
      'oilRefinery',
      'recyclingCenter',
      'barracks',
      'warFactory',
      // Phase 1 (veterancy) roster addition; the spec §8 grouping predates it.
      'militaryAcademy',
    ]);
    expect(byId.get('utilities')).toEqual([
      'powerPlant',
      'solarFarm',
      'nuclearPlant',
      'waterPump',
      'desalination',
    ]);
    expect(byId.get('navalAir')).toEqual([
      'shipyard',
      'navalYard',
      'airfield',
      'radarStation',
      // Grand-expansion Phase 6 — naval expansion (workstream C,
      // 2026-09-30): the four ports.
      'commercialPort',
      'containerPort',
      'fishingHarbor',
      'navalBase',
    ]);
    expect(byId.get('special')).toEqual(['monument', 'aegisControl', 'stormArray']);
    // Phase 3 workstream 2 (2026-09-30): the logistics tab — production
    // (oil, munitions, missiles) followed by the depots.
    expect(byId.get('logistics')).toEqual([
      'oilWell',
      'oilRig',
      'munitionsFactory',
      'missilePlant',
      'missileSilo',
      'ordnanceDepot',
      'fuelDepot',
    ]);
  });

  it('every tab has an English name', () => {
    for (const tab of BUILD_TABS) {
      const entry = STRINGS.buildingTabs[tab.id];
      expect(entry, `buildingTabs.${tab.id}`).toBeDefined();
      expect(entry!.en.length).toBeGreaterThan(0);
    }
  });
});

describe('research groups', () => {
  it('covers every upgrade exactly once', () => {
    const seen = new Map<string, number>();
    for (const group of UPGRADE_GROUPS) {
      for (const id of group.ids) {
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
    }
    expect(sortedKinds(seen.keys())).toEqual(sortedKinds(UPGRADE_IDS));
    for (const [id, count] of seen) {
      expect(count, `${id} in ${count} groups`).toBe(1);
    }
  });

  it('groups are Military (8), Economy (4), Infrastructure (6), Logistics (1), and Intel (2)', () => {
    const byId = new Map(UPGRADE_GROUPS.map((g) => [g.id, [...g.ids]]));
    expect(byId.get('military')).toHaveLength(8);
    expect(byId.get('economy')).toEqual([
      'precisionManufacturing',
      'smartGrid',
      'verticalFarming',
      'freeTrade',
    ]);
    // Grand-expansion Phase 2: the utility research ladder.
    expect(byId.get('infrastructure')).toEqual([
      'combustionTech',
      'advancedNuclear',
      'fusionResearch',
      'groundwaterSurvey',
      'desalinationTech',
      'gridStorage',
    ]);
    // Phase 3 workstream 2 (2026-09-30): the logistics group.
    expect(byId.get('logistics')).toEqual(['advancedLogistics']);
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
    // the intel group.
    expect(byId.get('intel')).toEqual(['signalsIntel', 'counterIntel']);
  });
});

describe('localized names', () => {
  it('every unit kind has an English name', () => {
    for (const kind of Object.keys(UNIT_DEFS) as UnitKind[]) {
      const entry = STRINGS.unitNames[kind];
      expect(entry, `unitNames.${kind}`).toBeDefined();
      expect(entry.en.length, `${kind}.en`).toBeGreaterThan(0);
    }
  });

  it('every building kind has an English name', () => {
    for (const kind of Object.keys(BUILDING_DEFS) as BuildingKind[]) {
      const entry = STRINGS.buildingNames[kind];
      expect(entry, `buildingNames.${kind}`).toBeDefined();
      expect(entry.en.length, `${kind}.en`).toBeGreaterThan(0);
    }
  });

  it('every upgrade has an English name and effect', () => {
    for (const id of UPGRADE_IDS) {
      const entry = STRINGS.upgrades[id];
      expect(entry, `upgrades.${id}`).toBeDefined();
      expect(entry.name.en.length).toBeGreaterThan(0);
      expect(entry.effect.en.length).toBeGreaterThan(0);
    }
  });

  it('name helpers fall back to the raw kind id', () => {
    expect(unitName('nope')).toBe('nope');
    expect(buildingName('nope')).toBe('nope');
  });

  it('every name resolves in English (the only shipped language)', () => {
    setUiLanguage('en');
    expect(unitName('tank')).toBe('Main Battle Tank');
    expect(buildingName('lab')).toBe('Research Lab');
    expect(upgradeName('apRounds')).toBe('AP Rounds');
    expect(upgradeEffect('apRounds')).toContain('+40%');
  });
});

describe('unitAvailability (grey-out logic)', () => {
  it('basic units are trainable in a fresh session', () => {
    const session = createSession({ seed: 7 });
    expect(unitAvailability(session.world, HUMAN_PLAYER_ID, 'engineer')).toEqual({
      ok: true,
      reason: '',
    });
  });

  it('age-locked units name the required age', () => {
    const session = createSession({ seed: 7 });
    // Fresh sessions start in Foundation; fighter needs Connectivity.
    const av = unitAvailability(session.world, HUMAN_PLAYER_ID, 'fighter');
    expect(av.ok).toBe(false);
    expect(av.reason.length).toBeGreaterThan(0);
    setUiLanguage('en');
    const en = unitAvailability(session.world, HUMAN_PLAYER_ID, 'fighter');
    expect(en.reason).toContain('Connectivity');
  });

  it('production-gated units name the required building', () => {
    const session = createSession({ seed: 7 });
    // Tank needs a completed warFactory (age is fine in Foundation).
    const av = unitAvailability(session.world, HUMAN_PLAYER_ID, 'tank');
    expect(av.ok).toBe(false);
    setUiLanguage('en');
    const en = unitAvailability(session.world, HUMAN_PLAYER_ID, 'tank');
    expect(en.reason).toContain('War Factory');
  });

  it('unaffordable units grey out', () => {
    const session = createSession({ seed: 7 });
    const human = getPlayer(session.world.city, HUMAN_PLAYER_ID)!;
    human.funds = 0;
    expect(unitAvailability(session.world, HUMAN_PLAYER_ID, 'engineer').ok).toBe(false);
  });

  it('manpower shortage greys out military units', () => {
    const session = createSession({ seed: 7 });
    const human = getPlayer(session.world.city, HUMAN_PLAYER_ID)!;
    human.manpower = 0;
    const av = unitAvailability(session.world, HUMAN_PLAYER_ID, 'rifles');
    expect(av.ok).toBe(false);
    expect(av.reason.length).toBeGreaterThan(0);
  });
});

describe('buildingAvailability (grey-out logic)', () => {
  it('ready when the age is met and the cost is affordable', () => {
    const session = createSession({ seed: 7 });
    expect(buildingAvailability(session.world, HUMAN_PLAYER_ID, 'house').ok).toBe(true);
  });

  it('locked with a localized age reason when the building needs a later age', () => {
    const session = createSession({ seed: 7 });
    session.world.ages.age = 'foundation';
    const st = buildingAvailability(session.world, HUMAN_PLAYER_ID, 'navalYard');
    expect(st.ok).toBe(false);
    // The industry age name appears in the reason.
    expect(st.reason).toContain('Industry');
    setUiLanguage('en');
    const en = buildingAvailability(session.world, HUMAN_PLAYER_ID, 'navalYard');
    expect(en.reason).toContain('Industry');
  });

  it('locked with an affordability reason when broke', () => {
    const session = createSession({ seed: 7 });
    const human = getPlayer(session.world.city, HUMAN_PLAYER_ID)!;
    human.funds = 0;
    human.materials = 0;
    const st = buildingAvailability(session.world, HUMAN_PLAYER_ID, 'house');
    expect(st.ok).toBe(false);
    expect(st.reason).toBe(STRINGS.palettes.cannotAfford.en);
  });

  it('the age gate wins over affordability', () => {
    const session = createSession({ seed: 7 });
    session.world.ages.age = 'foundation';
    const human = getPlayer(session.world.city, HUMAN_PLAYER_ID)!;
    human.funds = 0;
    human.materials = 0;
    const st = buildingAvailability(session.world, HUMAN_PLAYER_ID, 'navalYard');
    expect(st.ok).toBe(false);
    expect(st.reason).toContain('Industry');
  });
});

describe('upgradeAvailability (grey-out logic)', () => {
  /** A world with a completed lab, industry age, and full coffers. */
  function researchReadyWorld(): { session: ReturnType<typeof createSession>; world: World } {
    const session = createSession({ seed: 7 });
    const world = session.world;
    world.city.buildings.push({
      id: 9001,
      kind: 'lab',
      owner: HUMAN_PLAYER_ID,
      cx: 0,
      cz: 0,
      facing: 0,
      progress: 1,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
    });
    world.ages.age = 'industry';
    const human = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    human.funds = 100000;
    human.research = 10000;
    return { session, world };
  }

  it('needs a completed lab first', () => {
    const session = createSession({ seed: 7 });
    expect(playerHasCompletedLab(session.world, HUMAN_PLAYER_ID)).toBe(false);
    const av = upgradeAvailability(session.world, HUMAN_PLAYER_ID, 'apRounds');
    expect(av.state).toBe('locked');
    expect(av.reason.length).toBeGreaterThan(0);
  });

  it('ready when lab, age, prereqs and funds all hold', () => {
    const { world } = researchReadyWorld();
    // apRounds: warFactory + industry. Add the factory.
    world.city.buildings.push({
      id: 9002,
      kind: 'warFactory',
      owner: HUMAN_PLAYER_ID,
      cx: 5,
      cz: 5,
      facing: 0,
      progress: 1,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
    });
    expect(upgradeAvailability(world, HUMAN_PLAYER_ID, 'apRounds')).toEqual({
      state: 'ready',
      reason: '',
    });
  });

  it('missing prerequisite building locks with its name', () => {
    const { world } = researchReadyWorld();
    // advancedAvionics needs airfield + radarStation (and information age,
    // but the building check comes first per validate order — set the age
    // so the test isolates the building reason).
    world.ages.age = 'information';
    const av = upgradeAvailability(world, HUMAN_PLAYER_ID, 'advancedAvionics');
    expect(av.state).toBe('locked');
    setUiLanguage('en');
    const en = upgradeAvailability(world, HUMAN_PLAYER_ID, 'advancedAvionics');
    expect(en.reason).toContain('Airfield');
  });

  it('age-gated upgrades name the required age', () => {
    const { world } = researchReadyWorld();
    // freeTrade needs the market AND information age; industry age here.
    world.city.buildings.push({
      id: 9003,
      kind: 'market',
      owner: HUMAN_PLAYER_ID,
      cx: 5,
      cz: 5,
      facing: 0,
      progress: 1,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
    });
    const av = upgradeAvailability(world, HUMAN_PLAYER_ID, 'freeTrade');
    expect(av.state).toBe('locked');
    setUiLanguage('en');
    expect(upgradeAvailability(world, HUMAN_PLAYER_ID, 'freeTrade').reason).toContain(
      'Information',
    );
  });

  it('unaffordable upgrades lock', () => {
    const { world } = researchReadyWorld();
    const human = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    human.research = 0;
    expect(upgradeAvailability(world, HUMAN_PLAYER_ID, 'engineTuning').state).toBe('locked');
  });
});

describe('researchUpgrade through the session queue', () => {
  it('rejects loudly without a completed lab', () => {
    const session = createSession({ seed: 7 });
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'researchUpgrade',
        payload: { owner: HUMAN_PLAYER_ID, upgrade: 'apRounds' },
      }),
    ).toThrow(CommandRejectedError);
  });

  it('researches, deducts funds + research, and blocks duplicates', () => {
    const session = createSession({ seed: 7 });
    const world = session.world;
    world.city.buildings.push({
      id: 9001,
      kind: 'lab',
      owner: HUMAN_PLAYER_ID,
      cx: 0,
      cz: 0,
      facing: 0,
      progress: 1,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
    });
    world.city.buildings.push({
      id: 9002,
      kind: 'warFactory',
      owner: HUMAN_PLAYER_ID,
      cx: 5,
      cz: 5,
      facing: 0,
      progress: 1,
      level: 1,
      operational: true,
      powered: true,
      watered: true,
    });
    world.ages.age = 'industry';
    const human = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    human.funds = 100000;
    human.research = 10000;
    const fundsBefore = human.funds;
    const researchBefore = human.research;

    session.enqueuePlayerIntent({
      kind: 'researchUpgrade',
      payload: { owner: HUMAN_PLAYER_ID, upgrade: 'apRounds' },
    });
    session.tick();

    expect(world.upgrades[HUMAN_PLAYER_ID]).toContain('apRounds');
    expect(human.funds).toBe(fundsBefore - 800);
    expect(human.research).toBe(researchBefore - 60);
    expect(upgradeAvailability(world, HUMAN_PLAYER_ID, 'apRounds').state).toBe('researched');

    // A duplicate research is a loud rejection, not a silent no-op.
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'researchUpgrade',
        payload: { owner: HUMAN_PLAYER_ID, upgrade: 'apRounds' },
      }),
    ).toThrow(CommandRejectedError);
  });
});

describe('cost display', () => {
  it('train costs show funds + materials + manpower', () => {
    setUiLanguage('en');
    const cost = formatTrainCost('tank');
    expect(cost).toContain('400');
    expect(cost).toContain('60');
    expect(cost).toContain('5');
  });

  it('build costs show funds + materials', () => {
    setUiLanguage('en');
    const cost = formatBuildCost('warFactory');
    expect(cost).toContain('1100');
    expect(cost).toContain('450');
  });

  it('research costs show funds + research points', () => {
    setUiLanguage('en');
    const cost = formatResearchCost('cruiseMissiles');
    expect(cost).toContain('1500');
    expect(cost).toContain('150');
  });

  it('zero-cost parts are omitted', () => {
    setUiLanguage('en');
    // Engineer: 50 funds, no materials, no manpower.
    expect(formatTrainCost('engineer')).toBe('50 funds');
  });

  it('an unknown upgrade id falls back gracefully', () => {
    expect(upgradeName('not-a-real-upgrade' as UpgradeId)).toBe('not-a-real-upgrade');
  });
});
