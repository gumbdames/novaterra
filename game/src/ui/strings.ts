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
    ] as Array<[string, string]>,
  },
} as const;

export type Strings = typeof STRINGS;
