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

import type { UnitKind } from '../sim/units';
import type { BuildingKind } from '../sim/city';
import type { UpgradeId } from '../sim/upgrades';
import type { Age } from '../sim/ages';

/**
 * NOVATERRA — ui/strings.ts — player-facing text.
 *
 * English-only since the 2026-09-30 directive: the shipped game carries no
 * other language's string data. The `LocalizedString` / `UiLanguage` /
 * `loc()` / `fill()` / `fillLoc()` machinery below is kept on purpose as the
 * extension point — English-only data flows through it now, and a future
 * locale adds a field to `LocalizedString` plus a case in `loc()` (see
 * `docs/I18N.md`). The older sections below (menu, hud, …) were always
 * English-only and were never localized.
 *
 * Copy rules: very clear, short, simple — no jargon, no abbreviations the
 * player did not already see in the game.
 *
 * Pure module: no DOM, no three.js. Safe under Node/vitest.
 */

/**
 * A player-facing string, ready for future locales. English is the only
 * shipped language — a future locale adds its field here (e.g. `he: string`)
 * and a case in `loc()`.
 */
export interface LocalizedString {
  en: string;
}

/** UI languages the shipped game supports. Only English in 0.1 Alpha. */
export type UiLanguage = 'en';

/** Current UI language. English-only in 0.1 Alpha (see docs/I18N.md). */
let uiLanguage: UiLanguage = 'en';

/** Switch the UI language (persisted by the caller, e.g. settings). */
export function setUiLanguage(lang: UiLanguage): void {
  uiLanguage = lang;
}

export function getUiLanguage(): UiLanguage {
  return uiLanguage;
}

/**
 * Pick the current language's text from a localized string. Only 'en'
 * ships; future locales add a field to `LocalizedString` and a case here.
 */
export function loc(s: LocalizedString): string {
  switch (uiLanguage) {
    case 'en':
      return s.en;
  }
}

/**
 * Fill `{placeholders}` in a localized template, keeping every shipped
 * language. Unknown placeholders are left as-is (loud, not silent).
 */
export function fill(
  template: LocalizedString,
  vars: Record<string, string | number>,
): LocalizedString {
  const sub = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (_m, key: string) =>
      key in vars ? String(vars[key]) : `{${key}}`,
    );
  return { en: sub(template.en) };
}

/** Fill a template and pick the current language in one step. */
export function fillLoc(
  template: LocalizedString,
  vars: Record<string, string | number>,
): string {
  return loc(fill(template, vars));
}

export const STRINGS = {
  menu: {
    title: 'NOVATERRA',
    tagline: 'Build the nation. Command its future.',
    skirmish: 'Skirmish',
    loadGame: 'Load game',
    missions: 'Missions',
    settings: 'Settings',
    chooseMission: 'The First Term — choose your mission',
    chooseDifficulty: 'Choose your rival',
    difficultyCadet: 'Cadet — learns the ropes',
    difficultyCitizen: 'Citizen — a fair fight',
    difficultyCommander: 'Commander — no mercy',
    difficultyGeneral: 'General — combined arms',
    difficultyMarshal: 'Marshal — all-out war',
    chooseMap: 'Choose your map',
    start: 'Start game',
    back: 'Back',
    version: 'v0.1 Alpha',
  },
  hud: {
    funds: 'Funds',
    materials: 'Materials',
    food: 'Food',
    fuel: 'Fuel',
    goods: 'Goods',
    influence: 'Influence',
    manpower: 'Manpower',
    population: 'Population',
    ageFoundation: 'Foundation',
    ageConnectivity: 'Connectivity',
    ageIndustry: 'Industry',
    ageInformation: 'Information',
    ageAscendance: 'Ascendance',
    programFiber: 'Fiber Grid',
    programSignals: 'Signals Grid',
    programHeavyIndustry: 'Heavy Industry',
    programGreenTech: 'Green Tech',
    programCyberCommand: 'Cyber Command',
    programGlobalMedia: 'Global Media',
    programArsenal: 'Arsenal Program',
    programProsperity: 'Prosperity Program',
    advanceAge: 'Advance age',
    pause: 'Pause',
    resume: 'Resume',
    speed1: '1×',
    speed2: '2×',
    speed4: '4×',
    menu: 'Menu',
  },
  selection: {
    noSelection: 'Nothing selected',
    unitsSelected: (n: number) => `${n} unit${n === 1 ? '' : 's'} selected`,
    stop: 'Stop',
    train: 'Train',
    build: 'Build',
    /** Selected building's crew training level (economy.ts levels 1→3). */
    levelLine: { en: 'Level {level}/3' },
    // Phase 4 (transport): occupancy line for the selection panel, from
    // the sim's buildingOccupancy() (city.ts).
    occupancyLine: { en: 'Residents {residents}/{residentCap} · Workers {workers}/{workerCap}' },
    // Grand-expansion Phase 5 (hangar/carrier shelter, workstream B):
    // buttons for the embark / base / launch orders on aircraft,
    // carrier, and hangar selections.
    embarkVerb: { en: 'Embark' },
    baseVerb: { en: 'Park in hangar' },
    launchVerb: { en: 'Launch' },
  },
  /** Veterancy display (grand-expansion Phase 1). English-only. */
  veterancy: {
    /** Rank names per vetLevel 0..3 — must match sim/veterancy.ts VET_RANK_NAMES. */
    ranks: [
      { en: 'Recruit' },
      { en: 'Regular' },
      { en: 'Veteran' },
      { en: 'Elite' },
    ],
    /** "{rank} · {xp}/{next} XP", e.g. "Veteran ▲▲ · 700/1000 XP". */
    xpProgress: { en: '{rank} · {xp}/{next} XP' },
    /** Elite has no next threshold: "{rank} · {xp} XP". */
    xpElite: { en: '{rank} · {xp} XP' },
  },
  orders: {
    moveFailed: 'Cannot move there.',
    attackFailed: 'Cannot attack that target.',
    cannotTarget: 'None of your selected units can hit that target.',
    trainFailed: 'Cannot train here.',
    buildFailed: 'Cannot build there.',
    zoneNeedsDrag: 'Zones are painted by dragging a rectangle on the map.',
    ageAdvanced: 'Age advanced: Connectivity.',
  },
  advisor: {
    title: 'Advisor',
    fundsCritical: 'Treasury almost empty',
    fundsCriticalDetail: 'Raise taxes or build more commercial zones.',
    materialsLow: 'Materials running low',
    materialsLowDetail: 'Build factories and warehouses.',
    foodShortage: 'Food shortage',
    foodShortageDetail: 'Build more farms.',
    unitsDamaged: 'Units taking damage',
    unitsDamagedDetail: 'Pull damaged units back or send repairs.',
    noEngineers: 'No engineers in the field',
    noEngineersDetail: 'Train engineers to build roads and buildings.',
    ageAffordable: 'Age advance affordable',
    ageAffordableDetail: 'Pick a National Program to reach Connectivity.',
    allClear: 'All clear. Expand or advance.',
  },
  pause: {
    title: 'Paused',
    resume: 'Resume',
    settings: 'Settings',
    saveGame: 'Save game',
    exitToMenu: 'Exit to menu',
  },
  settings: {
    title: 'Settings',
    quality: 'Graphics quality',
    qualityLow: 'Low',
    qualityMedium: 'Medium',
    qualityHigh: 'High',
    close: 'Close',
    keysTitle: 'Controls',
    audioTitle: 'Audio',
    masterVolume: 'Master volume',
    musicVolume: 'Music volume',
    sfxVolume: 'Sound effects volume',
    mute: 'Mute all',
    museTitle: 'Muse — your chief of staff',
    museFrequency: 'Chattiness',
    museOff: 'Off — Muse stays silent',
    museQuiet: 'Quiet — milestones only',
    museNormal: 'Normal — events and updates',
    museChatty: 'Chatty — taunts and commentary',
    liveMuseTitle: 'Live Muse (hopefully coming)',
    liveMuseNote:
      'Point Muse at a live language model for strategic advice. The live model is advisory only — it can never drive the game. Not wired yet in 0.1 Alpha; the offline Muse covers you meanwhile.',
    liveKeyLabel: 'API key',
    liveKeyPlaceholder: 'Stored only in this browser',
    liveEnableLabel: 'Enable Live Muse (hopefully coming)',
  },
  help: {
    keys: [
      ['Left click', 'Select unit / building'],
      ['Drag', 'Select many units'],
      ['Right click', 'Move / attack'],
      ['S', 'Stop selected units'],
      ['Space', 'Pause / resume'],
      ['Esc', 'Deselect / close'],
      ['W A S D / arrows', 'Move camera'],
      ['Mouse wheel', 'Zoom'],
      ['Q / E', 'Rotate camera'],
      ['`', 'Cheat console'],
    ] as Array<[string, string]>,
  },
  save: {
    saveTitle: 'Save game',
    loadTitle: 'Load game',
    slotEmpty: 'Empty slot',
    cancel: 'Cancel',
    gameSaved: 'Game saved.',
    saveFailed: 'Could not save. Storage unavailable.',
    loadFailed: 'Could not load that save.',
    noSaves: 'No saved games yet.',
    cheatedTag: 'cheated',
    memoryBackendHint: 'Saves will not persist after closing (private mode).',
    slotSummary: '{name} — {date} — tick {tick} — {age} — rival: {difficulty}{cheated}',
    exitConfirmTitle: 'Exit to menu?',
    exitConfirmDetail: 'Unsaved progress will be lost.',
    saveAndExit: 'Save and exit',
    exitWithoutSaving: 'Exit without saving',
  },
  cheats: {
    placeholder: 'Type a cheat… (`help` lists them)',
    welcome: 'Cheat console. Type `help` for commands. Using cheats marks the save.',
    helpGrant: 'prosperity now — grants funds, materials, food and fuel',
    helpBuild: 'fast build — finishes all your buildings under construction',
    helpReveal: 'reveal — no fog of war in 0.1 Alpha; nothing to reveal',
    helpWin: 'win — show the victory screen (testing)',
    helpLose: 'lose — show the defeat screen (testing)',
    unknownCommand: 'Unknown cheat. Type `help`.',
    grantedMsg: 'Prosperity! Resources granted.',
    buildMsg: 'All construction finished.',
    revealMsg: 'No fog of war in 0.1 Alpha — the whole map is visible.',
    failedMsg: 'Cheat failed.',
  },
  end: {
    victoryTitle: 'Victory!',
    victoryDetail: 'Your nation stands triumphant. (Shown via the `win` cheat in 0.1 Alpha.)',
    defeatTitle: 'Defeat',
    defeatDetail: 'Your nation has fallen. (Shown via the `lose` cheat in 0.1 Alpha.)',
    keepPlaying: 'Keep playing',
    exitToMenu: 'Exit to menu',
  },
  // ------------------------------------------------------------------
  // English-only sections (roster expansion). Every entry is en-only,
  // flowing through the LocalizedString indirection (see docs/I18N.md).
  // ------------------------------------------------------------------
  /** Localized display names for all 66 unit kinds (tab palettes). */
  unitNames: {
    engineer: { en: 'Engineer' },
    rifles: { en: 'Rifles' },
    tank: { en: 'Main Battle Tank' },
    artillery: { en: 'Artillery' },
    aa: { en: 'Mobile AA' },
    hauler: { en: 'Hauler' },
    // Phase 3 SIM workstream (2026-09-30): provisional names for the two
    // new logistics trucks — the UI workstream owns final copy/palettes.
    supplyTruck: { en: 'Supply Truck' },
    fuelTruck: { en: 'Fuel Truck' },
    spectre: { en: 'Spectre' },
    hq: { en: 'Mobile HQ' },
    sniperTeam: { en: 'Sniper Team' },
    combatMedic: { en: 'Combat Medic' },
    apc: { en: 'Armored Personnel Carrier' },
    tankDestroyer: { en: 'Tank Destroyer' },
    mlrs: { en: 'MLRS' },
    fighter: { en: 'Fighter' },
    fighterBomber: { en: 'Fighter-Bomber' },
    attackHeli: { en: 'Attack Helicopter' },
    drone: { en: 'Drone' },
    awacs: { en: 'AWACS' },
    transport: { en: 'Transport' },
    // Grand-expansion Phase 5 — aircraft expansion (workstream B, 2026-09-30).
    strategicBomber: { en: 'Strategic Bomber' },
    maritimePatrol: { en: 'Maritime Patrol' },
    reconUAV: { en: 'Recon UAV' },
    armedUAV: { en: 'Armed UAV' },
    reconPlane: { en: 'Recon Plane' },
    gunship: { en: 'Gunship' },
    tanker: { en: 'Tanker' },
    militaryCargo: { en: 'Military Cargo' },
    trainer: { en: 'Trainer' },
    navalFighter: { en: 'Naval Fighter' },
    airliner: { en: 'Airliner' },
    jumboAirliner: { en: 'Jumbo Airliner' },
    regionalJet: { en: 'Regional Jet' },
    cargoPlane: { en: 'Cargo Plane' },
    passengerHeli: { en: 'Passenger Heli' },
    seaplane: { en: 'Seaplane' },
    patrolBoat: { en: 'Patrol Boat' },
    missileBoat: { en: 'Missile Boat' },
    frigate: { en: 'Frigate' },
    submarine: { en: 'Submarine' },
    destroyer: { en: 'Destroyer' },
    carrier: { en: 'Carrier' },
    commandShip: { en: 'Command Ship' },
    transportShip: { en: 'Transport Ship' },
    fishingBoat: { en: 'Fishing Boat' },
    // Phase 4 SIM workstream (2026-09-30): provisional names for the
    // five civilian transports — the UI workstream owns final copy.
    passengerTrain: { en: 'Passenger Train' },
    freightTrain: { en: 'Freight Train' },
    bus: { en: 'Bus' },
    tram: { en: 'Tram' },
    ferry: { en: 'Ferry' },
    // Grand-expansion Phase 6 — naval expansion (workstream C,
    // 2026-09-30): the 15 new sea kinds.
    coastalSub: { en: 'Coastal Sub' },
    missileSub: { en: 'Missile Sub' },
    corvette: { en: 'Corvette' },
    cruiser: { en: 'Cruiser' },
    battleship: { en: 'Battleship' },
    heavyDestroyer: { en: 'Heavy Destroyer' },
    cargoFreighter: { en: 'Cargo Freighter' },
    fuelTanker: { en: 'Fuel Tanker' },
    ammoShip: { en: 'Ammo Ship' },
    repairShip: { en: 'Repair Ship' },
    minelayer: { en: 'Minelayer' },
    navalMine: { en: 'Naval Mine' },
    coastGuardCutter: { en: 'Coast Guard Cutter' },
    cruiseLiner: { en: 'Cruise Liner' },
    yacht: { en: 'Yacht' },
  } as Record<UnitKind, LocalizedString>,
  /** Localized display names for all building kinds (tab palettes). */
  buildingNames: {
    house: { en: 'House' },
    apartment: { en: 'Apartment Block' },
    school: { en: 'School' },
    // Workstream Z (2026-09-30): the education ladder.
    kindergarten: { en: 'Kindergarten' },
    college: { en: 'College' },
    // Workstream W (2026-09-30): civic amenities (desirability drivers).
    library: { en: 'Library' },
    park: { en: 'Park' },
    // Workstream P (ambient city life, 2026-09-30): civic parking
    // (desirability drivers — convenience amenities).
    parkingLot: { en: 'Parking Lot' },
    parkingGarage: { en: 'Parking Garage' },
    shop: { en: 'Shop' },
    market: { en: 'Market' },
    lab: { en: 'Research Lab' },
    mediaCenter: { en: 'Media Center' },
    hospital: { en: 'Hospital' },
    university: { en: 'University' },
    factory: { en: 'Factory' },
    farm: { en: 'Farm' },
    quarry: { en: 'Quarry' },
    oilRefinery: { en: 'Oil Refinery' },
    recyclingCenter: { en: 'Recycling Center' },
    barracks: { en: 'Barracks' },
    warFactory: { en: 'War Factory' },
    militaryAcademy: { en: 'Military Academy' },
    powerPlant: { en: 'Power Plant' },
    solarFarm: { en: 'Solar Farm' },
    nuclearPlant: { en: 'Nuclear Plant' },
    waterPump: { en: 'Water Pump' },
    desalination: { en: 'Desalination Plant' },
    shipyard: { en: 'Shipyard' },
    navalYard: { en: 'Naval Yard' },
    airfield: { en: 'Airfield' },
    radarStation: { en: 'Radar Station' },
    monument: { en: 'Monument' },
    aegisControl: { en: 'Aegis Control' },
    stormArray: { en: 'Storm Array' },
    // Grand-expansion Phase 2 (2026-09-30): the 13 utility buildings.
    coalPlant: { en: 'Coal Plant' },
    gasPlant: { en: 'Gas Plant' },
    windFarm: { en: 'Wind Farm' },
    hydroDam: { en: 'Hydro Dam' },
    geothermalPlant: { en: 'Geothermal Plant' },
    fusionPlant: { en: 'Fusion Plant' },
    waterWell: { en: 'Water Well' },
    waterTower: { en: 'Water Tower' },
    waterTreatment: { en: 'Water Treatment' },
    reservoir: { en: 'Reservoir' },
    powerSubstation: { en: 'Power Substation' },
    pumpingStation: { en: 'Pumping Station' },
    batteryStation: { en: 'Battery Station' },
    // Grand-expansion Phase 4 S7 (2026-09-30): the transport hubs
    // (provisional names — the UI workstream owns final copy).
    railStation: { en: 'Rail Station' },
    busDepot: { en: 'Bus Depot' },
    ferryTerminal: { en: 'Ferry Terminal' },
    marina: { en: 'Marina' },
    marinaLarge: { en: 'Large Marina' },
    // Phase 4 tiered transit stops/stations (2026-09-30, provisional
    // names — the UI workstream owns final copy).
    busStop: { en: 'Bus Stop' },
    taxiStand: { en: 'Taxi Stand' },
    tramStop: { en: 'Tram Stop' },
    ferryPier: { en: 'Ferry Pier' },
    neighborhoodStation: { en: 'Neighborhood Station' },
    centralStation: { en: 'Central Station' },
    airportInterchange: { en: 'Airport Interchange' },
    // Grand-expansion Phase 3 (2026-09-30): the logistics roster.
    oilWell: { en: 'Oil Well' },
    oilRig: { en: 'Offshore Oil Rig' },
    munitionsFactory: { en: 'Munitions Factory' },
    missilePlant: { en: 'Missile Plant' },
    missileSilo: { en: 'Missile Silo' },
    ordnanceDepot: { en: 'Ordnance Depot' },
    fuelDepot: { en: 'Fuel Depot' },
    // Grand-expansion Phase 6 — naval expansion (workstream C,
    // 2026-09-30): the four ports.
    commercialPort: { en: 'Commercial Port' },
    containerPort: { en: 'Container Port' },
    fishingHarbor: { en: 'Fishing Harbor' },
    navalBase: { en: 'Naval Base' },
    // Grand-expansion Phase 5 — airports (workstream A, S5+S8,
    // 2026-09-30): the 14 airport kinds.
    civilAirport: { en: 'Civil Airport' },
    militaryAirbase: { en: 'Military Airbase' },
    mixedAirport: { en: 'Mixed Airport' },
    passengerTerminal: { en: 'Passenger Terminal' },
    cargoTerminal: { en: 'Cargo Terminal' },
    controlTower: { en: 'Control Tower' },
    hangarS: { en: 'Hangar (Light)' },
    hangarM: { en: 'Hangar (Medium)' },
    hangarL: { en: 'Hangar (Heavy)' },
    fuelFarm: { en: 'Fuel Farm' },
    maintenanceHangar: { en: 'Maintenance Hangar' },
    runwayS: { en: 'Runway (Light)' },
    runwayM: { en: 'Runway (Medium)' },
    runwayL: { en: 'Runway (Heavy)' },
  } as Record<BuildingKind, LocalizedString>,
  /** Train-palette tab names (spec §8). */
  unitTabs: {
    infantry: { en: 'Infantry' },
    armor: { en: 'Armor' },
    air: { en: 'Air Force' },
    navy: { en: 'Navy' },
    // Grand-expansion Phase 4 S7 (2026-09-30): the civilian transports tab.
    transport: { en: 'Transport' },
  } as Record<string, LocalizedString>,
  /** Build-palette tab names (spec §8). */
  buildingTabs: {
    housing: { en: 'Housing' },
    // Workstream Z (2026-09-30): the civic tab (education buildings).
    civic: { en: 'Civic' },
    commerce: { en: 'Commerce' },
    industry: { en: 'Industry' },
    utilities: { en: 'Utilities' },
    navalAir: { en: 'Naval & Air' },
    special: { en: 'Special' },
    // Phase 2 (utilities): extra tabs for the new plant/water roster.
    power: { en: 'Power' },
    waterNet: { en: 'Water' },
    // Grand-expansion Phase 3 (2026-09-30): the logistics roster tab.
    logistics: { en: 'Logistics' },
    // Grand-expansion Phase 4 S7 (2026-09-30): the transport hubs tab.
    transport: { en: 'Transport' },
    // Grand-expansion Phase 5 (S5+S8, 2026-09-30): the airport roster tab.
    airports: { en: 'Airports' },
  } as Record<string, LocalizedString>,
  /** Research-panel upgrade group names. */
  upgradeGroups: {
    military: { en: 'Military' },
    economy: { en: 'Economy' },
    // Grand-expansion Phase 2 (2026-09-30): the utility research ladder.
    infrastructure: { en: 'Infrastructure' },
    // Grand-expansion Phase 3 (2026-09-30): the logistics upgrade.
    logistics: { en: 'Logistics' },
  } as Record<string, LocalizedString>,
  /** Localized age names for lock reasons ("requires the Industry age"). */
  ageNames: {
    foundation: { en: 'Foundation' },
    connectivity: { en: 'Connectivity' },
    industry: { en: 'Industry' },
    information: { en: 'Information' },
    ascendance: { en: 'Ascendance' },
  } as Record<Age, LocalizedString>,
  /**
   * The 19 researchable upgrades: localized name + one-line effect
   * (spec §4; effects mirror the sim's upgrade hooks, not marketing).
   */
  upgrades: {
    apRounds: {
      name: { en: 'AP Rounds' },
      effect: { en: '+40% damage vs heavy armor: tank, tank destroyer, APC' },
    },
    compositeArmor: {
      name: { en: 'Composite Armor' },
      effect: { en: '+30% max HP for newly built armored vehicles' },
    },
    engineTuning: {
      name: { en: 'Engine Tuning' },
      effect: { en: '+25% speed for ground vehicles' },
    },
    advancedAvionics: {
      name: { en: 'Advanced Avionics' },
      effect: { en: 'Aircraft: +25% sight, +20% vs air; AWACS +15 sight' },
    },
    sonarSuite: {
      name: { en: 'Sonar Suite' },
      effect: { en: 'Frigate and destroyer hit subs harder; all sea units +8 sight' },
    },
    cruiseMissiles: {
      name: { en: 'Cruise Missiles' },
      effect: { en: 'MLRS +10 range, artillery +8 range' },
    },
    droneOptics: {
      name: { en: 'Drone Optics' },
      effect: { en: 'Drone +15 sight, spectre +10 sight' },
    },
    fieldMedicine: {
      name: { en: 'Field Medicine' },
      effect: { en: 'Medic heals 4 HP/s; new infantry +20 max HP' },
    },
    precisionManufacturing: {
      name: { en: 'Precision Manufacturing' },
      effect: { en: '+25% factory output' },
    },
    smartGrid: {
      name: { en: 'Smart Grid' },
      effect: { en: 'Power plants supply more power' },
    },
    verticalFarming: {
      name: { en: 'Vertical Farming' },
      effect: { en: 'Farm: +50% food, less water' },
    },
    freeTrade: {
      name: { en: 'Free Trade Policy' },
      effect: { en: 'Markets and shops earn more funds' },
    },
    // Grand-expansion Phase 2 (2026-09-30): the utility research ladder.
    combustionTech: {
      name: { en: 'Combustion Tech' },
      effect: { en: 'Unlocks the Coal Plant and Gas Plant' },
    },
    advancedNuclear: {
      name: { en: 'Advanced Nuclear' },
      effect: { en: 'Nuclear meltdowns 4× rarer; unlocks Fusion Research' },
    },
    fusionResearch: {
      name: { en: 'Fusion Research' },
      effect: { en: 'Unlocks the Fusion Plant' },
    },
    groundwaterSurvey: {
      name: { en: 'Groundwater Survey' },
      effect: { en: 'Unlocks the Water Well' },
    },
    desalinationTech: {
      name: { en: 'Desalination Tech' },
      effect: { en: 'Desalination Plant water output ×1.5' },
    },
    gridStorage: {
      name: { en: 'Grid Storage' },
      effect: { en: 'Unlocks the Water Tower, Reservoir, and Battery Station' },
    },
    // Grand-expansion Phase 3 (2026-09-30): the logistics upgrade.
    advancedLogistics: {
      name: { en: 'Advanced Logistics' },
      effect: { en: 'Depot ammo/fuel storage ×1.5; ammo production ×1.5' },
    },
  } as Record<UpgradeId, { name: LocalizedString; effect: LocalizedString }>,
  /** Utility networks (grand-expansion Phase 2). English-only. */
  utilities: {
    /** Overlay toggle label (top bar). */
    overlayToggle: { en: 'Utilities' },
    /** Diagnosis names for the selection panel. */
    powerLabel: { en: 'Power' },
    waterLabel: { en: 'Water' },
    diagOk: { en: 'OK' },
    diagShortage: { en: 'Shortage' },
    diagDisconnected: { en: 'Disconnected' },
    /** Shown on palette entries whose sim def has not landed yet. */
    notYetAvailable: { en: 'Requires the Phase 2 utility sim (not yet active)' },
    /** Hint for the drag-paint network tools (click paints one cell). */
    dragHint: { en: 'Drag on the map to run a line; click paints one cell.' },
    /** Overlay legend (title attribute of the toggle). */
    overlayLegend: {
      en: 'Show utility networks: yellow = power lines, blue = water pipes. Red icon = disconnected, amber = shortage, flag = stranded plant, purple ring = fouled water source.',
    },
  },
  /** Logistics (grand-expansion Phase 3). English-only. */
  logistics: {
    /** Overlay toggle label (top bar). */
    overlayToggle: { en: 'Logistics' },
    /** Overlay legend (title attribute of the toggle). */
    overlayLegend: {
      en: 'Show reload-point coverage (olive discs) and low-supply units (amber rings).',
    },
    /** Selection-panel labels. */
    fuelLabel: { en: 'Fuel' },
    ammoLabel: { en: 'Ammo' },
    cargoLabel: { en: 'Cargo' },
    stockLabel: { en: 'Stock' },
    servicesLabel: { en: 'Field services' },
    repairToggle: { en: 'Repair' },
    rearmToggle: { en: 'Rearm' },
    refuelToggle: { en: 'Refuel' },
    resupplyVerb: { en: 'Resupply' },
    lowSupplyWarning: { en: 'Low supply — resupply soon' },
    resupplyingTo: { en: 'Resupplying at depot' },
    noDepotReason: { en: 'No depot with available stock in range' },
  },
  /** Desirability / land value / migration (workstream W, grand expansion). English-only. */
  desirability: {
    /** Overlay toggle label (top bar). */
    overlayToggle: { en: 'Land value' },
    /** Overlay legend (title attribute of the toggle). */
    overlayLegend: {
      en: 'Show residential desirability as a ground tint (red = low, green = prime).',
    },
    /** Land-value tier display names (the sim tier ids are lowercase). */
    tierNames: {
      low: { en: 'Low' },
      modest: { en: 'Modest' },
      nice: { en: 'Nice' },
      prime: { en: 'Prime' },
    },
    /** Selection-panel land-value line for residential buildings. */
    landValueLine: { en: 'Land: {tier} ({score}) · tax ×{mult}' },
  },
  /** Airport overlay (grand-expansion Phase 5, S5+S8). English-only. */
  airportsOverlay: {
    /** Overlay toggle label (top bar). */
    overlayToggle: { en: 'Airports' },
    /** Overlay legend (title attribute of the toggle). */
    overlayLegend: {
      en: 'Show airport sites (rings by type) and airline routes (arcs).',
    },
  },
  /** Underground/x-ray view (Phase 4 RENDER workstream A, item 1). English-only. */
  xray: {
    /** Overlay toggle label (top bar). */
    overlayToggle: { en: 'X-ray' },
    /** Overlay legend (title attribute of the toggle). */
    overlayLegend: {
      en: 'Ghost the terrain to see buried water pipes (bright blue lines). Turns on automatically while the water-pipe tool is armed.',
    },
  },
  /** Terrain grid overlay (Phase 4 RENDER workstream A, follow-up B). English-only. */
  grid: {
    /** Toggle label (top bar). */
    toggle: { en: 'Grid' },
    /** Toggle legend (title attribute). */
    legend: {
      en: 'Show a subtle survey grid draped on the terrain (G key).',
    },
  },
  /** Tabbed palettes, research panel, placement hints — all en-only. */
  palettes: {
    trainTitle: { en: 'Train' },
    buildTitle: { en: 'Build' },
    researchTitle: { en: 'Research' },
    researchVerb: { en: 'Research' },
    toolRoad: { en: 'Road' },
    // Phase 4 (transport): the road tool paints the selected class; the
    // picker sits next to the road button in the Civilian tools row.
    roadClassDirt: { en: 'Dirt' },
    roadClassCountry: { en: 'Country' },
    roadClassPaved: { en: 'Paved' },
    roadClassHighway: { en: 'Highway' },
    roadClassCost: { en: '{funds} funds + {materials} materials per cell' },
    // Phase 4 (transport): the rail drag-paint tool.
    toolRail: { en: 'Rail' },
    // Phase 2 (utilities): drag-paint network tools.
    toolPowerLine: { en: 'Power line' },
    toolWaterPipe: { en: 'Water pipe' },
    // Workstream Z (2026-09-30): zone tools say what they paint.
    toolZoneR: { en: 'Zone: Homes' },
    toolZoneC: { en: 'Zone: Shops' },
    toolZoneI: { en: 'Zone: Industry' },
    // Grand-expansion Phase 5 (S5): the airport zone tool.
    toolZoneA: { en: 'Zone: Airports' },
    toolSectionZoning: { en: 'Zoning' },
    // Phase 2 (utilities): the drag-paint network tools sit together.
    toolSectionNetworks: { en: 'Networks' },
    toolDemolish: { en: 'Demolish' },
    cancelPlacement: { en: 'Cancel (Esc)' },
    placeLandHint: { en: 'Click the map to place' },
    placeSeaHint: { en: 'Click WATER on the map to place' },
    trainToast: { en: 'Place {name}: {hint}. Right-click cancels.' },
    buildToast: { en: 'Construction: drag or click on the map. Right-click cancels.' },
    requiresBuilding: { en: 'Requires: {name}' },
    requiresAge: { en: 'Requires the {age} age' },
    requiresUpgrade: { en: 'Requires upgrade: {name}' },
    needsLab: { en: 'Requires a completed Research Lab' },
    cannotAfford: { en: 'Cannot afford' },
    notEnoughManpower: { en: 'Not enough manpower' },
    alreadyResearched: { en: 'Already researched' },
    researchedTag: { en: '✓ Researched' },
    navalYardCoast: { en: 'Must be built on the coast — at least one footprint cell adjacent to water' },
    // Grand-expansion Phase 6 — naval expansion (workstream C,
    // 2026-09-30): naval mines are never trained directly — the
    // minelayer lays them with its deployMine command.
    deployedByMinelayer: { en: 'Deployed by a Minelayer — select a Minelayer to lay mines' },
    resFunds: { en: 'funds' },
    resMaterials: { en: 'materials' },
    resManpower: { en: 'manpower' },
    resResearch: { en: 'research' },
    hpLabel: { en: 'HP' },
  },
  /** Workstream Y (2026-09-30): the three main menu tabs. English-only. */
  menuTabs: {
    civilian: { en: 'Civilian' },
    military: { en: 'Military' },
    management: { en: 'Management' },
    /** Military tab: the unit-orders help block. */
    ordersTitle: { en: 'Orders' },
    attackHint: { en: 'Attack — right-click an enemy unit' },
    moveHint: { en: 'Move — right-click open ground' },
    stopHint: { en: 'Stop — select units, then S or the Stop button' },
    /** Military tab: superweapons live here now (was the Command panel). */
    superTitle: { en: 'Superweapons' },
    fireAegis: { en: 'Fire Aegis' },
    aegisTitle: { en: 'Raise the Aegis shield (Ascendance + Aegis Control)' },
    stormTarget: { en: 'Storm Target' },
    stormTitle: { en: 'Enter Storm targeting mode, then click the map (Ascendance + Storm Array)' },
    /** Management tab: taxes. */
    taxesTitle: { en: 'Taxes' },
    taxZoneNames: {
      0: { en: 'Homes' },
      1: { en: 'Shops' },
      2: { en: 'Industry' },
      // Grand-expansion Phase 5 (S5, 2026-09-30): the airport zone rate.
      3: { en: 'Airports' },
    },
    mayorSetsRates: { en: 'Mayor sets the rates ({policy})' },
    /** Management tab: city specialization (was the Command panel). */
    focusTitle: { en: 'City focus' },
    /** Management tab: the cabinet — mayor + general (was the Command panel). */
    cabinetTitle: { en: 'Cabinet' },
    noMayor: { en: 'No mayor appointed' },
    noGeneral: { en: 'No general appointed' },
    dismissVerb: { en: 'Dismiss' },
    mayorBuildsLabel: { en: 'Mayor builds:' },
    /** Civilian tab: the airline panel (grand-expansion Phase 5, S5). */
    airlineTitle: { en: 'Airlines' },
    airlineEmpty: { en: 'No airline routes yet — build two civil airports, then link them.' },
    newAirlineRoute: { en: 'New route…' },
    airlineRouteArmed: { en: 'Click a second civil or mixed airport to complete the route' },
    airlinePickFirst: { en: 'Click one of your completed civil or mixed airports' },
    airlineNotEndpoint: { en: 'Airline routes need completed civil or mixed airports' },
    airlineSameAirport: { en: 'Pick a different airport for the route\u2019s other end' },
    airlineNeedsOwner: { en: 'Airline routes only connect your own airports' },
    cancelAirlineRoute: { en: 'Cancel route' },
    airlineNeedsTwo: { en: 'Needs two completed civil or mixed airports' },
    /** Runway class labels (§AD7 — the build UI shows what each runway serves). */
    runwayServes: { en: 'Serves: {classes}' },
    aircraftClassLight: { en: 'Light' },
    aircraftClassMedium: { en: 'Medium' },
    aircraftClassHeavy: { en: 'Heavy' },
  },
} as const;

export type Strings = typeof STRINGS;
