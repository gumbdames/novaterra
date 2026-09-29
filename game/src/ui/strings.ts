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
 * Hebrew-first since the roster expansion (0.1 Alpha): every string added
 * from here on is a `{ he, en }` pair, and `loc()` picks the player's
 * language (default Hebrew — see `setUiLanguage`). The older sections
 * below (menu, hud, …) are still English-only; they are migrated
 * opportunistically and left untouched by this change.
 *
 * Copy rules: very clear, short, simple — no jargon, no abbreviations the
 * player did not already see in the game.
 *
 * Pure module: no DOM, no three.js. Safe under Node/vitest.
 */

/** A player-facing string in both UI languages. Hebrew first. */
export interface LocalizedString {
  he: string;
  en: string;
}

export type UiLanguage = 'he' | 'en';

/** Current UI language. Hebrew-first default per the standing UI brief. */
let uiLanguage: UiLanguage = 'he';

/** Switch the UI language (persisted by the caller, e.g. settings). */
export function setUiLanguage(lang: UiLanguage): void {
  uiLanguage = lang;
}

export function getUiLanguage(): UiLanguage {
  return uiLanguage;
}

/** Pick the current language's text from a localized string. */
export function loc(s: LocalizedString): string {
  return uiLanguage === 'he' ? s.he : s.en;
}

/**
 * Fill `{placeholders}` in a localized template, keeping both languages.
 * Unknown placeholders are left as-is (loud, not silent).
 */
export function fill(
  template: LocalizedString,
  vars: Record<string, string | number>,
): LocalizedString {
  const sub = (text: string): string =>
    text.replace(/\{(\w+)\}/g, (_m, key: string) =>
      key in vars ? String(vars[key]) : `{${key}}`,
    );
  return { he: sub(template.he), en: sub(template.en) };
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
    /** Roster expansion: Hebrew-first language picker (he + en pair). */
    languageLabel: { he: 'שפה', en: 'Language' },
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
  // Hebrew-first sections (roster expansion). Every entry is he + en.
  // ------------------------------------------------------------------
  /** Localized display names for all 28 unit kinds (tab palettes). */
  unitNames: {
    engineer: { he: 'מהנדס', en: 'Engineer' },
    rifles: { he: 'רובאים', en: 'Rifles' },
    tank: { he: 'טנק', en: 'Main Battle Tank' },
    artillery: { he: 'תותחים', en: 'Artillery' },
    aa: { he: 'נ״מ נייד', en: 'Mobile AA' },
    hauler: { he: 'מוביל', en: 'Hauler' },
    spectre: { he: 'ספקטר', en: 'Spectre' },
    hq: { he: 'מפקדה ניידת', en: 'Mobile HQ' },
    sniperTeam: { he: 'צוות צלפים', en: 'Sniper Team' },
    combatMedic: { he: 'חובש קרבי', en: 'Combat Medic' },
    apc: { he: 'נגמ״ש', en: 'Armored Personnel Carrier' },
    tankDestroyer: { he: 'משמיד טנקים', en: 'Tank Destroyer' },
    mlrs: { he: 'משגר רקטות', en: 'MLRS' },
    fighter: { he: 'מטוס קרב', en: 'Fighter' },
    fighterBomber: { he: 'מפציץ־קרב', en: 'Fighter-Bomber' },
    attackHeli: { he: 'מסוק תקיפה', en: 'Attack Helicopter' },
    drone: { he: 'רחפן', en: 'Drone' },
    awacs: { he: 'מטוס בקרה', en: 'AWACS' },
    transport: { he: 'מטוס תובלה', en: 'Transport' },
    patrolBoat: { he: 'ספינת סיור', en: 'Patrol Boat' },
    missileBoat: { he: 'ספינת טילים', en: 'Missile Boat' },
    frigate: { he: 'פריגטה', en: 'Frigate' },
    submarine: { he: 'צוללת', en: 'Submarine' },
    destroyer: { he: 'משחתת', en: 'Destroyer' },
    carrier: { he: 'נושאת מטוסים', en: 'Carrier' },
    commandShip: { he: 'אוניית פיקוד', en: 'Command Ship' },
    transportShip: { he: 'אוניית תובלה', en: 'Transport Ship' },
    fishingBoat: { he: 'סירת דיג', en: 'Fishing Boat' },
  } as Record<UnitKind, LocalizedString>,
  /** Localized display names for all 28 building kinds (tab palettes). */
  buildingNames: {
    house: { he: 'בית', en: 'House' },
    apartment: { he: 'בניין דירות', en: 'Apartment Block' },
    school: { he: 'בית ספר', en: 'School' },
    shop: { he: 'חנות', en: 'Shop' },
    market: { he: 'שוק', en: 'Market' },
    lab: { he: 'מעבדת מחקר', en: 'Research Lab' },
    mediaCenter: { he: 'מרכז תקשורת', en: 'Media Center' },
    hospital: { he: 'בית חולים', en: 'Hospital' },
    university: { he: 'אוניברסיטה', en: 'University' },
    factory: { he: 'מפעל', en: 'Factory' },
    farm: { he: 'חווה', en: 'Farm' },
    quarry: { he: 'מחצבה', en: 'Quarry' },
    oilRefinery: { he: 'בית זיקוק', en: 'Oil Refinery' },
    recyclingCenter: { he: 'מרכז מחזור', en: 'Recycling Center' },
    barracks: { he: 'מחנה חי״ר', en: 'Barracks' },
    warFactory: { he: 'מפעל נשק', en: 'War Factory' },
    powerPlant: { he: 'תחנת כוח', en: 'Power Plant' },
    solarFarm: { he: 'חווה סולארית', en: 'Solar Farm' },
    nuclearPlant: { he: 'תחנה גרעינית', en: 'Nuclear Plant' },
    waterPump: { he: 'משאבת מים', en: 'Water Pump' },
    desalination: { he: 'מתקן התפלה', en: 'Desalination Plant' },
    shipyard: { he: 'מספנה', en: 'Shipyard' },
    navalYard: { he: 'מספנה צבאית', en: 'Naval Yard' },
    airfield: { he: 'שדה תעופה', en: 'Airfield' },
    radarStation: { he: 'תחנת מכ״ם', en: 'Radar Station' },
    monument: { he: 'אנדרטה', en: 'Monument' },
    aegisControl: { he: 'בקרת אגיס', en: 'Aegis Control' },
    stormArray: { he: 'מערך סערה', en: 'Storm Array' },
  } as Record<BuildingKind, LocalizedString>,
  /** Train-palette tab names (spec §8). */
  unitTabs: {
    infantry: { he: 'חי״ר', en: 'Infantry' },
    armor: { he: 'שריון', en: 'Armor' },
    air: { he: 'חיל אוויר', en: 'Air Force' },
    navy: { he: 'חיל ים', en: 'Navy' },
  } as Record<string, LocalizedString>,
  /** Build-palette tab names (spec §8). */
  buildingTabs: {
    housing: { he: 'מגורים', en: 'Housing' },
    commerce: { he: 'מסחר', en: 'Commerce' },
    industry: { he: 'תעשייה', en: 'Industry' },
    utilities: { he: 'תשתיות', en: 'Utilities' },
    navalAir: { he: 'ימי ואווירי', en: 'Naval & Air' },
    special: { he: 'מיוחד', en: 'Special' },
  } as Record<string, LocalizedString>,
  /** Research-panel upgrade group names. */
  upgradeGroups: {
    military: { he: 'צבאי', en: 'Military' },
    economy: { he: 'כלכלה', en: 'Economy' },
  } as Record<string, LocalizedString>,
  /** Localized age names for lock reasons ("requires the Industry age"). */
  ageNames: {
    foundation: { he: 'יסוד', en: 'Foundation' },
    connectivity: { he: 'קישוריות', en: 'Connectivity' },
    industry: { he: 'תעשייה', en: 'Industry' },
    information: { he: 'מידע', en: 'Information' },
    ascendance: { he: 'התעלות', en: 'Ascendance' },
  } as Record<Age, LocalizedString>,
  /**
   * The 12 researchable upgrades: localized name + one-line effect
   * (spec §4; effects mirror the sim's upgrade hooks, not marketing).
   */
  upgrades: {
    apRounds: {
      name: { he: 'פגזי חודרן', en: 'AP Rounds' },
      effect: { he: '+40% נזק נגד שריון כבד: טנק, משמיד טנקים, נגמ״ש', en: '+40% damage vs heavy armor: tank, tank destroyer, APC' },
    },
    compositeArmor: {
      name: { he: 'שריון מרוכב', en: 'Composite Armor' },
      effect: { he: '+30% נקודות חיים לרכבי קרב משוריינים חדשים', en: '+30% max HP for newly built armored vehicles' },
    },
    engineTuning: {
      name: { he: 'כוונון מנועים', en: 'Engine Tuning' },
      effect: { he: '+25% מהירות לרכבי קרקע', en: '+25% speed for ground vehicles' },
    },
    advancedAvionics: {
      name: { he: 'אוויוניקה מתקדמת', en: 'Advanced Avionics' },
      effect: { he: 'מטוסים: +25% ראייה, +20% נגד מטוסים; מטוס בקרה +15 ראייה', en: 'Aircraft: +25% sight, +20% vs air; AWACS +15 sight' },
    },
    sonarSuite: {
      name: { he: 'מערכת סונאר', en: 'Sonar Suite' },
      effect: { he: 'פריגטה ומשחתת חזקות יותר נגד צוללות; כל כלי השיט +8 ראייה', en: 'Frigate and destroyer hit subs harder; all sea units +8 sight' },
    },
    cruiseMissiles: {
      name: { he: 'טילי שיוט', en: 'Cruise Missiles' },
      effect: { he: 'משגר רקטות +10 טווח, תותחים +8 טווח', en: 'MLRS +10 range, artillery +8 range' },
    },
    droneOptics: {
      name: { he: 'אופטיקת רחפנים', en: 'Drone Optics' },
      effect: { he: 'רחפן +15 ראייה, ספקטר +10 ראייה', en: 'Drone +15 sight, spectre +10 sight' },
    },
    fieldMedicine: {
      name: { he: 'רפואת שדה', en: 'Field Medicine' },
      effect: { he: 'חובש מרפא 4 נק״ח לשנייה; חי״ר חדש +20 נקודות חיים', en: 'Medic heals 4 HP/s; new infantry +20 max HP' },
    },
    precisionManufacturing: {
      name: { he: 'ייצור מדויק', en: 'Precision Manufacturing' },
      effect: { he: '+25% תפוקת מפעלים', en: '+25% factory output' },
    },
    smartGrid: {
      name: { he: 'רשת חשמל חכמה', en: 'Smart Grid' },
      effect: { he: 'תחנות כוח מספקות יותר חשמל', en: 'Power plants supply more power' },
    },
    verticalFarming: {
      name: { he: 'חקלאות אנכית', en: 'Vertical Farming' },
      effect: { he: 'חווה: +50% מזון, פחות מים', en: 'Farm: +50% food, less water' },
    },
    freeTrade: {
      name: { he: 'סחר חופשי', en: 'Free Trade Policy' },
      effect: { he: 'שווקים וחנויות מרוויחים יותר כסף', en: 'Markets and shops earn more funds' },
    },
  } as Record<UpgradeId, { name: LocalizedString; effect: LocalizedString }>,
  /** Tabbed palettes, research panel, placement hints — all he + en. */
  palettes: {
    trainTitle: { he: 'אימון', en: 'Train' },
    buildTitle: { he: 'בנייה', en: 'Build' },
    researchTitle: { he: 'מחקר', en: 'Research' },
    researchVerb: { he: 'חקור', en: 'Research' },
    toolRoad: { he: 'כביש', en: 'Road' },
    toolZoneR: { he: 'אזור מגורים', en: 'Homes' },
    toolZoneC: { he: 'אזור מסחר', en: 'Shops' },
    toolZoneI: { he: 'אזור תעשייה', en: 'Industry' },
    toolDemolish: { he: 'הריסה', en: 'Demolish' },
    cancelPlacement: { he: 'ביטול (Esc)', en: 'Cancel (Esc)' },
    placeLandHint: { he: 'לחץ על המפה כדי להציב', en: 'Click the map to place' },
    placeSeaHint: { he: 'לחץ על מים במפה כדי להציב', en: 'Click WATER on the map to place' },
    trainToast: {
      he: 'הצבה: {name} — {hint}. לחיצה ימנית מבטלת.',
      en: 'Place {name}: {hint}. Right-click cancels.',
    },
    buildToast: {
      he: 'בנייה: גרור או לחץ על המפה. לחיצה ימנית מבטלת.',
      en: 'Construction: drag or click on the map. Right-click cancels.',
    },
    requiresBuilding: { he: 'נדרש: {name}', en: 'Requires: {name}' },
    requiresAge: { he: 'נדרש עידן {age}', en: 'Requires the {age} age' },
    requiresUpgrade: { he: 'נדרש שדרוג: {name}', en: 'Requires upgrade: {name}' },
    needsLab: { he: 'נדרשת מעבדת מחקר פעילה', en: 'Requires a completed Research Lab' },
    cannotAfford: { he: 'אין מספיק משאבים', en: 'Cannot afford' },
    notEnoughManpower: { he: 'אין מספיק כוח אדם', en: 'Not enough manpower' },
    alreadyResearched: { he: 'כבר נחקר', en: 'Already researched' },
    researchedTag: { he: '✓ נחקר', en: '✓ Researched' },
    navalYardCoast: {
      he: 'חובה לבנות על החוף — לפחות תא אחד צמוד למים',
      en: 'Must be built on the coast — at least one footprint cell adjacent to water',
    },
    resFunds: { he: 'כסף', en: 'funds' },
    resMaterials: { he: 'חומרים', en: 'materials' },
    resManpower: { he: 'כוח אדם', en: 'manpower' },
    resResearch: { he: 'מחקר', en: 'research' },
    hpLabel: { he: 'נק״ח', en: 'HP' },
  },
} as const;

export type Strings = typeof STRINGS;
