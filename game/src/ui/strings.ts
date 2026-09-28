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
 * NOVATERRA — ui/strings.ts — player-facing text.
 *
 * All UI copy lives here, in English for 0.1 Alpha. The nested structure
 * mirrors the UI areas so a future Hebrew localization can swap this module
 * (or one shaped exactly like it) without touching UI logic. Copy rules:
 * very clear, short, simple — no jargon, no abbreviations the player did
 * not already see in the game.
 *
 * Pure module: no DOM, no three.js. Safe under Node/vitest.
 */

export const STRINGS = {
  menu: {
    title: 'NOVATERRA',
    tagline: 'Build the nation. Command its future.',
    skirmish: 'Skirmish',
    loadGame: 'Load game',
    missions: 'Missions',
    settings: 'Settings',
    missionsLocked: 'The campaign ships in Phase 2.',
    chooseDifficulty: 'Choose your rival',
    difficultyCadet: 'Cadet — learns the ropes',
    difficultyCitizen: 'Citizen — a fair fight',
    difficultyCommander: 'Commander — no mercy',
    start: 'Start game',
    back: 'Back',
    version: 'v0.1 Alpha',
  },
  hud: {
    funds: 'Funds',
    materials: 'Materials',
    food: 'Food',
    fuel: 'Fuel',
    population: 'Population',
    ageFoundation: 'Foundation',
    ageConnectivity: 'Connectivity',
    programFiber: 'Fiber Grid',
    programSignals: 'Signals Grid',
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
} as const;

export type Strings = typeof STRINGS;
