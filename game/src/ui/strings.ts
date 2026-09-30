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
  /** Localized display names for all 28 unit kinds (tab palettes). */
  unitNames: {
    engineer: { en: 'Engineer' },
    rifles: { en: 'Rifles' },
    tank: { en: 'Main Battle Tank' },
    artillery: { en: 'Artillery' },
    aa: { en: 'Mobile AA' },
    hauler: { en: 'Hauler' },
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
    patrolBoat: { en: 'Patrol Boat' },
    missileBoat: { en: 'Missile Boat' },
    frigate: { en: 'Frigate' },
    submarine: { en: 'Submarine' },
    destroyer: { en: 'Destroyer' },
    carrier: { en: 'Carrier' },
    commandShip: { en: 'Command Ship' },
    transportShip: { en: 'Transport Ship' },
    fishingBoat: { en: 'Fishing Boat' },
  } as Record<UnitKind, LocalizedString>,
  /** Localized display names for all 28 building kinds (tab palettes). */
  buildingNames: {
    house: { en: 'House' },
    apartment: { en: 'Apartment Block' },
    school: { en: 'School' },
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
  } as Record<BuildingKind, LocalizedString>,
  /** Train-palette tab names (spec §8). */
  unitTabs: {
    infantry: { en: 'Infantry' },
    armor: { en: 'Armor' },
    air: { en: 'Air Force' },
    navy: { en: 'Navy' },
  } as Record<string, LocalizedString>,
  /** Build-palette tab names (spec §8). */
  buildingTabs: {
    housing: { en: 'Housing' },
    commerce: { en: 'Commerce' },
    industry: { en: 'Industry' },
    utilities: { en: 'Utilities' },
    navalAir: { en: 'Naval & Air' },
    special: { en: 'Special' },
  } as Record<string, LocalizedString>,
  /** Research-panel upgrade group names. */
  upgradeGroups: {
    military: { en: 'Military' },
    economy: { en: 'Economy' },
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
   * The 12 researchable upgrades: localized name + one-line effect
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
  } as Record<UpgradeId, { name: LocalizedString; effect: LocalizedString }>,
  /** Tabbed palettes, research panel, placement hints — all en-only. */
  palettes: {
    trainTitle: { en: 'Train' },
    buildTitle: { en: 'Build' },
    researchTitle: { en: 'Research' },
    researchVerb: { en: 'Research' },
    toolRoad: { en: 'Road' },
    toolZoneR: { en: 'Homes' },
    toolZoneC: { en: 'Shops' },
    toolZoneI: { en: 'Industry' },
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
    resFunds: { en: 'funds' },
    resMaterials: { en: 'materials' },
    resManpower: { en: 'manpower' },
    resResearch: { en: 'research' },
    hpLabel: { en: 'HP' },
  },
} as const;

export type Strings = typeof STRINGS;
