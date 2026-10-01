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
    // Grand-expansion Phase 7 (intel, 2026-09-30): the top-bar intel
    // asset chips (built once, write-on-change like the other chips).
    intelSurveillance: 'Surveillance',
    intelOperational: 'Operational',
    intelCounterIntel: 'Counter-intel',
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
    // Final-review R2 (2026-10-01): building structural HP line for the
    // selection panel — buildings are destructible now (C3), so the
    // player reads how much damage a building has taken.
    hpLine: { en: 'HP {hp}%' },
    // Phase 4 (transport): occupancy line for the selection panel, from
    // the sim's buildingOccupancy() (city.ts).
    occupancyLine: { en: 'Residents {residents}/{residentCap} · Workers {workers}/{workerCap}' },
    // Grand-expansion Phase 5 (hangar/carrier shelter, workstream B):
    // buttons for the embark / base / launch orders on aircraft,
    // carrier, and hangar selections.
    embarkVerb: { en: 'Embark' },
    baseVerb: { en: 'Park in hangar' },
    launchVerb: { en: 'Launch' },
    /**
     * Command-menu rebuild (2026-10-01): the detail view's back button
     * returns to the tab menu (Esc and clicking empty ground do the
     * same — game.ts owns the selection).
     */
    backToMenu: { en: 'Back' },
    /** Building detail view: arm the demolish tool for the selected building. */
    demolishVerb: { en: 'Demolish' },
    demolishTitle: { en: 'Arm the demolish tool — demolition is pure loss, no refund' },
    operational: { en: 'Operational' },
    notOperational: { en: 'Not operational' },
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
    liveEnableLabel: 'Enable Live Muse (hopefully coming)',
  },
  help: {
    keys: [
      ['Left click', 'Select unit / building'],
      ['Shift + left click', 'Add / remove unit from selection'],
      ['Left drag (no tool)', 'Pan the map'],
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
    corruptSave: 'That save file is broken and could not be loaded.',
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
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30).
    spy: { en: 'Spy' },
    reconTeam: { en: 'Recon Team' },
    // Grand-expansion Phase 8 — tech-level variants (workstream D,
    // 2026-09-30): Mk II/III variants share the base kind's art and
    // read their ROLE names in palettes (M15 tradeoff redesign,
    // 2026-10-01 — each tier is a distinct tactical choice, not a
    // bigger number).
    tankMk2: { en: 'Assault Tank Mk II' },
    tankMk3: { en: 'Railgun Tank Mk III' },
    artilleryMk2: { en: 'Siege Artillery Mk II' },
    artilleryMk3: { en: 'Rocket Artillery Mk III' },
    aaMk2: { en: 'AA Gun Platform Mk II' },
    aaMk3: { en: 'Missile AA Mk III' },
    apcMk2: { en: 'IFV Mk II' },
    apcMk3: { en: 'Command APC Mk III' },
    haulerMk2: { en: 'Heavy Hauler Mk II' },
    haulerMk3: { en: 'Express Hauler Mk III' },
    fighterMk2: { en: 'Interceptor Mk II' },
    fighterMk3: { en: 'Multirole Mk III' },
    fighterBomberMk2: { en: 'Strike Bomber Mk II' },
    fighterBomberMk3: { en: 'Stealth Bomber Mk III' },
    attackHeliMk2: { en: 'Tank Hunter Mk II' },
    attackHeliMk3: { en: 'Hunter-Killer Mk III' },
    gunshipMk2: { en: 'Siege Gunship Mk II' },
    gunshipMk3: { en: 'Rapid Gunship Mk III' },
    destroyerMk2: { en: 'AA Destroyer Mk II' },
    destroyerMk3: { en: 'Missile Destroyer Mk III' },
    frigateMk2: { en: 'ASW Frigate Mk II' },
    frigateMk3: { en: 'Fast Frigate Mk III' },
    submarineMk2: { en: 'Hunter-Killer Mk II' },
    submarineMk3: { en: 'Missile Sub Mk III' },
    missileBoatMk2: { en: 'Strike Boat Mk II' },
    missileBoatMk3: { en: 'Fast Attack Mk III' },
    transportShipMk2: { en: 'Heavy Transport Mk II' },
    transportShipMk3: { en: 'Depot Ship Mk III' },
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
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30).
    intelHQ: { en: 'Intelligence Headquarters' },
    listeningPost: { en: 'Listening Post' },
    satelliteUplink: { en: 'Satellite Uplink' },
    signalsStation: { en: 'Signals Station' },
    // Grand-expansion Phase 8 (civilian deep-dive, workstream E,
    // 2026-09-30): cultural amenities, the economy ladder, health
    // tiers, and the safety amenity.
    museum: { en: 'Museum' },
    theater: { en: 'Theater' },
    sportsStadium: { en: 'Sports Stadium' },
    botanicalGarden: { en: 'Botanical Garden' },
    grandMarket: { en: 'Grand Market' },
    bank: { en: 'Bank' },
    officeTower: { en: 'Office Tower' },
    clinic: { en: 'Clinic' },
    medicalCenter: { en: 'Medical Center' },
    fireStation: { en: 'Fire Station' },
  } as Record<BuildingKind, LocalizedString>,
  /** Train-palette tab names (spec §8). */
  unitTabs: {
    infantry: { en: 'Infantry' },
    armor: { en: 'Armor' },
    air: { en: 'Air Force' },
    navy: { en: 'Navy' },
    // Grand-expansion Phase 4 S7 (2026-09-30): the civilian transports tab.
    transport: { en: 'Transport' },
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30).
    intel: { en: 'Intel' },
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
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30).
    intel: { en: 'Intel' },
  } as Record<string, LocalizedString>,
  /** Research-panel upgrade group names. */
  upgradeGroups: {
    military: { en: 'Military' },
    economy: { en: 'Economy' },
    // Grand-expansion Phase 2 (2026-09-30): the utility research ladder.
    infrastructure: { en: 'Infrastructure' },
    // Grand-expansion Phase 3 (2026-09-30): the logistics upgrade.
    logistics: { en: 'Logistics' },
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30).
    intel: { en: 'Intel' },
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
   * The 21 researchable upgrades: localized name + one-line effect
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
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
    // the intel upgrade pair.
    signalsIntel: {
      name: { en: 'Signals Intelligence' },
      effect: { en: 'Surveillance income ×1.5; all units +4 sight' },
    },
    counterIntel: {
      name: { en: 'Counter-Intelligence' },
      effect: { en: 'Counter-intel income ×1.25; +25 detection radius; sabotage lasts half as long' },
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
    /** Final-review R5 (2026-10-01): stranded-aircraft affordance. */
    emergencyRefuelVerb: { en: 'Emergency refuel' },
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
    // Command-menu rebuild (2026-10-01): the road tool + class picker
    // and the demolish tool each get their own labeled group, like the
    // Networks and Zoning groups, so the Tools sub-tab scans at a
    // glance.
    toolSectionRoads: { en: 'Roads' },
    toolSectionDemolish: { en: 'Demolish' },
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
    // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
    // the lockout reason for military defs in peaceful worlds — mirrors
    // the sim's command-layer rejection (never a dead button).
    peacefulLocked: { en: 'Not available in peaceful mode' },
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
    /**
     * Command-menu rebuild (2026-10-01): sub-tab pills inside each main
     * tab. Civilian → Tools / Build / Airlines; Military → Train /
     * Build / Superweapons; Management → Taxes / City focus / Cabinet /
     * Ordinances / Intelligence / Trade / Research.
     */
    subTools: { en: 'Tools' },
    subBuild: { en: 'Build' },
    subAirlines: { en: 'Airlines' },
    subTrain: { en: 'Train' },
    subSuperweapons: { en: 'Superweapons' },
    subTaxes: { en: 'Taxes' },
    subFocus: { en: 'City focus' },
    subCabinet: { en: 'Cabinet' },
    subOrdinances: { en: 'Ordinances' },
    subIntel: { en: 'Intelligence' },
    subTrade: { en: 'Trade' },
    subResearch: { en: 'Research' },
    /** Management → Trade: the trade-route surface (0.1 Alpha adds the
     * menu; the sim commands existed since Phase 3 with no buttons). */
    tradeTitle: { en: 'Trade routes' },
    tradeEmpty: {
      en: 'No trade routes yet. A route pays while both ends run an operating commercial building.',
    },
    tradeIncomeLine: { en: '+{income} funds/s while both ends trade' },
    tradeEstablish: { en: 'Establish route' },
    tradeEstablishTitle: { en: 'Establish a trade route ({cost} funds setup)' },
    tradeCancel: { en: 'Cancel route' },
    tradePartnerRival: { en: 'Rival nation' },
    /** Management → Research shown when the player owns no completed lab. */
    researchNeedsLab: { en: 'Build a Research Lab (Commerce tab) to unlock research.' },
  },
  /** Grand-expansion Phase 7 (intel, 2026-09-30): the intel panel, spy lines, warnings. English-only. */
  intel: {
    panelTitle: { en: 'Intelligence' },
    assetsTitle: { en: 'Intel assets' },
    surveillance: { en: 'Surveillance' },
    operational: { en: 'Operational' },
    counterIntel: { en: 'Counter-intel' },
    perSecond: { en: '/s' },
    noIntelBuildings: {
      en: 'No intel buildings yet — build a Listening Post or Intel HQ (Intel build tab) to generate assets.',
    },
    spiesTitle: { en: 'Spies' },
    noSpies: { en: 'No spies trained yet.' },
    trainSpyHint: { en: 'Train spies at the {building} — {funds} funds · {materials} materials' },
    spyHeader: { en: 'Spy {id} · at ({x}, {z})' },
    selectSpy: { en: 'Select' },
    selectSpyTitle: { en: 'Select this spy on the map' },
    /** Selected-spy / panel-row mission lines. */
    spyHidden: { en: 'Hidden — undetected' },
    spyDetected: { en: 'Inside rival detection coverage — visible to them' },
    spyExposed: { en: 'Exposed — visible to all enemies · {seconds}s left' },
    spyInfiltrating: { en: 'Infiltrating {target} · {seconds}s left' },
    spyEmbedded: { en: 'Embedded in {target} — ready to steal tech' },
    /** Covert actions. */
    actionsTitle: { en: 'Covert actions' },
    actionsHint: {
      en: 'Move a spy next to a rival building, then pick a target below. The game checks every order — a refused order explains why.',
    },
    noTargets: { en: 'No rival buildings in reach — move the spy closer.' },
    infiltrateVerb: { en: 'Infiltrate' },
    infiltrateTitle: { en: 'Start a 20s infiltration of this building (spy must stay close)' },
    sabotageVerb: { en: 'Sabotage · {cost}' },
    sabotageTitle: {
      en: 'Sabotage this building: it goes offline for a while. Costs {cost} operational assets.',
    },
    stealTechVerb: { en: 'Steal tech · {cost}' },
    stealTechTitle: {
      en: 'Steal research from the building this spy is embedded in. Costs {cost} surveillance assets.',
    },
    stealPreview: { en: 'Would steal: {tech}' },
    stealNothingLeft: { en: 'Nothing left to steal from this rival' },
    stealPayoff: { en: 'A successful steal grants {research} research' },
    /** Warnings. */
    warningsTitle: { en: 'Warnings' },
    noWarnings: { en: 'All quiet — no active warnings.' },
    secondsLeftSuffix: { en: '{seconds}s left' },
    warnExposedTitle: { en: 'Spy {id} exposed' },
    warnExposedDetail: { en: 'Visible to all enemies' },
    warnExposedNext: {
      en: 'Goes back into hiding when the timer ends — unless inside rival detection coverage.',
    },
    warnCoverageTitle: { en: 'Spy {id} inside rival detection' },
    warnCoverageDetail: { en: 'A rival listening post or signals station can see this spy right now' },
    warnCoverageNext: { en: 'Move the spy out of rival detection coverage to disappear again.' },
    warnSabotageTitle: { en: '{building} sabotaged' },
    warnSabotageDetail: { en: 'Offline' },
    warnSabotageNext: {
      en: 'Comes back online when the timer ends. Research Counter-intel to halve future sabotage.',
    },
    /** Rival airports. */
    airportsTitle: { en: 'Rival airports' },
    noAirports: { en: 'No rival airports known.' },
    airportLine: { en: '{name} ({owner}) — reads as {readAs} · {flag}' },
    airportCivilian: { en: 'civilian' },
    airportMilitary: { en: 'military' },
    airportMixed: { en: 'mixed-use' },
    airportDiscovered: { en: 'known' },
    airportUndiscovered: { en: 'UNVERIFIED — a mixed-use site reads as civilian until discovered' },
    /**
     * Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30):
     * mixed-airport discovery copy. The warning fires first ("suspicious
     * military activity"), then the grace-period countdown, then the
     * reveal — no gotchas. English-only via loc()/fillLoc().
     */
    discoveryWarnTitle: { en: 'Suspicious military activity at {name}' },
    discoveryWarnDetail: {
      en: 'Our analysts are confirming the site — {seconds}s until the assessment is complete',
    },
    discoveryWarnNext: {
      en: 'When confirmed, the site reads as mixed-use and may be treated as a military target.',
    },
    discoveryRevealedFlag: { en: 'CONFIRMED — military-capable' },
  },
  /**
   * Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
   * the skirmish-setup toggle, the peaceful objectives panel, the
   * military-tab lockout note, and the peaceful end screens.
   * English-only via loc()/fillLoc().
   */
  peaceful: {
    /** Skirmish setup: the peaceful-mode toggle label. */
    setupToggle: { en: 'Peaceful mode' },
    /** Skirmish setup: one-line explanation of what peaceful means. */
    setupExplanation: {
      en: 'No military — you and your rival build peacefully. Endless: no victory, no defeat, just build.',
    },
    /** Civilian tab note (the Military tab is hidden in peaceful games). */
    militaryHiddenNote: {
      en: 'Peaceful mode: the military is disabled. Build freely — there is no victory condition.',
    },
    /** Management tab: the peaceful status section title. */
    statusTitle: { en: 'City status' },
    /** Status panel: housed population. */
    populationLine: { en: 'Population: {pop}' },
    /** Status panel: treasury is non-negative. */
    treasuryOk: { en: 'Treasury: healthy' },
    /** Status panel: treasury is negative. */
    treasuryBad: { en: 'Treasury: negative' },
    /** Intel panel: covert ops are not offered in peaceful games. */
    covertOpsDisabled: {
      en: 'Covert operations are not available in peaceful mode.',
    },
  },
  /**
   * Grand-expansion Phase 8 (civilian ordinances, workstream E,
   * 2026-09-30): the Management tab's City ordinances section. One
   * entry per PolicyId (POLICY_IDS order): name, one-line effect, and
   * the upkeep cost line. Rejection strings from the sim are plain
   * English already — the UI wraps/displays them, never re-implements
   * validation.
   */
  policies: {
    /** Section title in the Management tab. */
    title: { en: 'City ordinances' },
    /** Section subtitle: what ordinances are. */
    subtitle: {
      en: 'City-wide policies with real upkeep. Toggle one — its effects apply only while the treasury funds its upkeep.',
    },
    /** Upkeep line: "0.6 funds/s upkeep". */
    upkeepLine: { en: '{cost} funds/s upkeep' },
    /** Effect line while funded. */
    fundedLine: { en: 'Funded' },
    /** Effect line while toggled but the treasury cannot fund it. */
    unfundedLine: { en: 'On, but unfunded — effects off' },
    greenInitiative: {
      name: { en: 'Green Initiative' },
      effect: {
        en: 'Parks and botanical gardens are worth more; pollution hurts less',
      },
    },
    transitSubsidy: {
      name: { en: 'Transit Subsidy' },
      effect: {
        en: 'Transit stops are worth more; riders bring in more; more migrants arrive',
      },
    },
    businessIncentives: {
      name: { en: 'Business Incentives' },
      effect: { en: 'Commercial buildings earn +15% funds' },
    },
    nightlife: {
      name: { en: 'Nightlife Ordinance' },
      effect: {
        en: 'Commercial buildings earn +10% funds; nearby homes lose desirability (noise)',
      },
    },
    educationGrants: {
      name: { en: 'Education Grants' },
      effect: {
        en: 'Education buildings boost growth twice as much and research +25%',
      },
    },
  },
} as const;
