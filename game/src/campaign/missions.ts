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
 * NOVATERRA — campaign/missions.ts — "The First Term" mission definitions
 * (Phase 2).
 *
 * Responsibilities:
 *  - The 8 campaign missions as JSON-safe data: id, name, briefing,
 *    victory paths (each path is an alternative objective set — a mission
 *    is won by completing every objective of ANY one path, so every
 *    mission has a peaceful path), scripted events, map preset, AI
 *    difficulty, and starting resources.
 *  - Pure data + lookup helpers. No DOM, no sim mutation — safe under
 *    Node/vitest. Objective *checking* lives in objectives.ts; event
 *    *firing* lives in director.ts.
 *
 * Design notes:
 *  - The setting is fixed in 2026; you are the newly inaugurated
 *    President after the 2024 Federation fracture. No aliens, no space.
 *  - Mission 1 is a tutorial (movement, building, training).
 *  - Warfare is optional: every mission is completable without combat.
 *  - Two campaign endings ("The Peacemaker" / "The Commander") are
 *    decided by diplomat vs commander points (see progress.ts).
 */

import type { AIDifficulty } from '../sim/ai';
import type { Age } from '../sim/ages';
import type { BuildingKind, ResourceKey } from '../sim/city';
import type { UnitKind } from '../sim/units';

/** One win condition. `label` is shown in the objectives panel. */
export type ObjectiveDef =
  | { kind: 'population'; count: number; label: string }
  | { kind: 'stockpile'; resource: ResourceKey; count: number; label: string }
  | { kind: 'build'; building: BuildingKind; count: number; label: string }
  | { kind: 'train'; unit: UnitKind; count: number; label: string }
  | { kind: 'destroyUnits'; count: number; label: string }
  | { kind: 'destroyAllEnemy'; label: string }
  | { kind: 'reachAge'; age: Age; label: string }
  | { kind: 'survive'; ticks: number; label: string };

/** One alternative way to win a mission. */
export interface MissionPath {
  id: string;
  /** Shown in the objectives panel, e.g. "Peaceful: Endure". */
  name: string;
  /** True when this path needs no combat. Every mission has one. */
  peaceful: boolean;
  objectives: ObjectiveDef[];
}

export type RaidDirection = 'north' | 'south' | 'east' | 'west';

export type MissionEventTrigger =
  | { kind: 'atTick'; tick: number }
  | { kind: 'onFirstBuilding'; building: BuildingKind }
  | { kind: 'onFirstCombat' }
  | { kind: 'onAgeAdvanced'; age: Age }
  | { kind: 'onLowFunds' };

export interface MissionEventDef {
  id: string;
  trigger: MissionEventTrigger;
  /** Shown through the Muse box / toast when the event fires. */
  message: string;
  /**
   * Optional scripted raid: spawn enemy units at a map edge and order
   * them toward the player's base. Deterministic: positions derive from
   * the mission seed, spawns go through the normal `spawnUnit` command.
   */
  raid?: { count: number; kinds: UnitKind[]; from: RaidDirection };
}

export interface MissionDef {
  id: string;
  /** 1-based order in the campaign. */
  order: number;
  name: string;
  /** Briefing paragraphs shown before the mission. */
  briefing: string[];
  paths: MissionPath[];
  events: MissionEventDef[];
  mapPreset: string;
  /** 'none' = no AI rival (tutorial / purely economic missions). */
  aiDifficulty: AIDifficulty | 'none';
  /** Override starting stocks for the human player (partial). */
  startingResources?: Partial<Record<ResourceKey, number>>;
  debriefWin: string;
  debriefLose: string;
}

const M1_BRIEFING = [
  'January 2026. You take the oath of office as the Federation fractures ' +
    'into rival blocs. Your first task is humble: prove the new republic ' +
    'can keep its people housed, fed, and hopeful.',
  'Your engineers are waiting for orders. Build homes, raise a power ' +
    'plant, and grow the capital to 60 souls. No one will bother you ' +
    'today — this one is about learning the ropes.',
];

const M2_BRIEFING = [
  'The honeymoon is over: winter is coming and the granaries are thin. ' +
    'A friendly neighbor, President Ada of Riverlands, watches to see ' +
    'if your republic can feed itself.',
  'Grow the capital to 200 people, stockpile 1,500 food, and keep the ' +
    'water flowing. Ada will not attack — but hunger is its own enemy.',
];

const M3_BRIEFING = [
  'Separatist militias are probing the northern border. The generals ' +
    'want a show of force; your advisors whisper that a republic which ' +
    'outlasts its enemies never has to outgun them.',
  'Destroy 15 raiders — or endure: survive 12 minutes and grow to 250 ' +
    'citizens while the raids break against your towns.',
];

const M4_BRIEFING = [
  'The Archipelago straits carry half the continent\u2019s trade, and ' +
    'pirates have noticed. The navy exists mostly on paper. Time to ' +
    'change that.',
  'Build a shipyard and put 3 warships to sea — or corner the market: ' +
    'stockpile 2,500 goods and let the merchants win this one.',
];

const M5_BRIEFING = [
  'The old copper telephone grid is dying. Your science advisors say ' +
    'the nation that wires itself first will own the next decade.',
  'Reach the Connectivity age and choose a National Program. Out-tech ' +
    'Commander Voss — no shots required, though he will not make it easy.',
];

const M6_BRIEFING = [
  'General Ilsa Karr has studied your playbook and found it wanting. ' +
    'Her forces are massing on two fronts, east and west, and her ' +
    'propaganda calls you a caretaker, not a leader.',
  'Break 40 of her units — or make her propaganda look foolish by ' +
    'reaching the Information age while her armies march in circles.',
];

const M7_BRIEFING = [
  'The Continental Summit convenes in six months. The blocs will follow ' +
    'whichever nation speaks with the most authority — and authority, ' +
    'in 2026, is broadcast.',
  'Build media centers and accumulate 400 influence to dominate the ' +
    'Summit — or settle it the old way against General Karr\u2019s veterans.',
];

const M8_BRIEFING = [
  'Four years. One term. Marshal Dain, the fracture\u2019s most brilliant ' +
    'and ruthless commander, has united the remaining separatists for ' +
    'one final push. Everything you built will be tested at once.',
  'Destroy his forces entirely — or ascend: reach the Ascendance age ' +
    'and render his war obsolete. History will remember which you chose.',
];

/**
 * The full "First Term" campaign. Missions reference real map presets,
 * unit kinds, building kinds, ages, and resources — the missions test
 * validates every reference.
 */
export const MISSIONS: readonly MissionDef[] = [
  {
    id: 'first-day',
    order: 1,
    name: 'First Day in Office',
    briefing: M1_BRIEFING,
    paths: [
      {
        id: 'learn',
        name: 'Tutorial: Build the capital',
        peaceful: true,
        objectives: [
          { kind: 'build', building: 'house', count: 2, label: 'Build 2 houses' },
          { kind: 'build', building: 'powerPlant', count: 1, label: 'Build 1 power plant' },
          { kind: 'population', count: 60, label: 'Grow to 60 population' },
        ],
      },
    ],
    events: [
      {
        id: 'm1-welcome',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          // C9 (2026-10-01): the real selection model — left-drag with no
          // tool armed is grab-pan (game.ts pressDragKind), never
          // box-select, so the tutorial must not teach a drag-box.
          'Welcome, President. Left-click an engineer to select it ' +
          '(Shift + left-click selects more), then right-click to move ' +
          'them. Left-drag pans the map — it never selects.',
      },
      {
        id: 'm1-menu',
        trigger: { kind: 'atTick', tick: 600 },
        message:
          // Command-menu rebuild (2026-10-01): teach the new menu —
          // the icon rail's three tabs and their sub-tabs.
          'Everything is built from the command menu, bottom-left. The ' +
          'Civilian tab holds the tools and buildings, the Military tab ' +
          'trains units, and the Management tab runs taxes and research — ' +
          'each tab has sub-tabs along the top. Clicking a unit or ' +
          'building shows its details; Esc or the Back button returns ' +
          'to the menu.',
      },
      {
        id: 'm1-build',
        trigger: { kind: 'onFirstBuilding', building: 'house' },
        message:
          'A roof over heads! Houses attract citizens — citizens pay ' +
          'taxes. Keep building.',
      },
      {
        id: 'm1-power',
        trigger: { kind: 'onFirstBuilding', building: 'powerPlant' },
        message:
          'The lights are on. Buildings need power and water to work at ' +
          'full strength — watch the advisor for shortages.',
      },
    ],
    mapPreset: 'Meridian Plains',
    aiDifficulty: 'none',
    debriefWin:
      'The capital hums. Sixty citizens, warm homes, lit streets — ' +
      'the republic works. The hard part starts now.',
    debriefLose:
      'The capital stalled before it began. Every president gets one ' +
      'mulligan — try again.',
  },
  {
    id: 'bread-and-power',
    order: 2,
    name: 'Bread and Power',
    briefing: M2_BRIEFING,
    paths: [
      {
        id: 'feed',
        name: 'Peaceful: Feed the nation',
        peaceful: true,
        objectives: [
          { kind: 'population', count: 200, label: 'Grow to 200 population' },
          { kind: 'stockpile', resource: 'food', count: 1500, label: 'Stockpile 1,500 food' },
          { kind: 'build', building: 'waterPump', count: 1, label: 'Build 1 water pump' },
        ],
      },
    ],
    events: [
      {
        id: 'm2-ada',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          'President Ada sends her regards — and a warning: her farmers ' +
          'report a lean season. Stockpile food early.',
      },
      {
        id: 'm2-farm',
        trigger: { kind: 'onFirstBuilding', building: 'farm' },
        message:
          'Farms turn workers into wheat. Pair them with houses nearby ' +
          'and watch the granaries fill.',
      },
      {
        id: 'm2-hungry',
        trigger: { kind: 'onLowFunds' },
        message:
          'The treasury is thin, President. Raise taxes carefully — or ' +
          'sell surplus on the market. (Press ` for the console if you ' +
          'must… I saw nothing.)',
      },
    ],
    mapPreset: 'Riverlands',
    aiDifficulty: 'cadet',
    debriefWin:
      'Full granaries, full bellies. Ada toasts your republic at the ' +
      'harvest festival — the first ally of the new era.',
    debriefLose:
      'Hunger toppled the plan. A president who cannot feed her people ' +
      'cannot keep them. Regroup and try again.',
  },
  {
    id: 'northern-border',
    order: 3,
    name: 'The Northern Border',
    briefing: M3_BRIEFING,
    paths: [
      {
        id: 'repel',
        name: 'Military: Repel the raiders',
        peaceful: false,
        objectives: [{ kind: 'destroyUnits', count: 15, label: 'Destroy 15 raiders' }],
      },
      {
        id: 'endure',
        name: 'Peaceful: Outlast them',
        peaceful: true,
        objectives: [
          { kind: 'survive', ticks: 21600, label: 'Survive 12 minutes' },
          { kind: 'population', count: 250, label: 'Grow to 250 population' },
        ],
      },
    ],
    events: [
      {
        id: 'm3-warning',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          'Border sensors are quiet… too quiet. The generals advise ' +
          'training rifles now, before the storm.',
      },
      {
        id: 'm3-raid1',
        trigger: { kind: 'atTick', tick: 5400 },
        message: 'Northern border breached! Raiders incoming from the north!',
        raid: { count: 4, kinds: ['rifles', 'rifles', 'rifles', 'rifles'], from: 'north' },
      },
      {
        id: 'm3-raid2',
        trigger: { kind: 'atTick', tick: 12600 },
        message: 'A second wave! They mean to burn the border towns.',
        raid: { count: 6, kinds: ['rifles', 'rifles', 'rifles', 'rifles', 'tank', 'tank'], from: 'north' },
      },
    ],
    mapPreset: 'Meridian Plains',
    aiDifficulty: 'citizen',
    startingResources: { funds: 5000, materials: 2000 },
    debriefWin:
      'The border holds. Whether by rifle or by resolve, the separatists ' +
      'learned the republic does not break.',
    debriefLose:
      'The northern towns fell silent. The republic will mourn — and ' +
      'then it will rebuild. Try a different strategy.',
  },
  {
    id: 'crossing-the-water',
    order: 4,
    name: 'Crossing the Water',
    briefing: M4_BRIEFING,
    paths: [
      {
        id: 'naval',
        name: 'Military: Rule the straits',
        peaceful: false,
        objectives: [
          { kind: 'build', building: 'shipyard', count: 1, label: 'Build 1 shipyard' },
          { kind: 'train', unit: 'patrolBoat', count: 3, label: 'Float 3 patrol boats' },
        ],
      },
      {
        id: 'trade',
        name: 'Peaceful: Corner the market',
        peaceful: true,
        objectives: [
          { kind: 'stockpile', resource: 'goods', count: 2500, label: 'Stockpile 2,500 goods' },
        ],
      },
    ],
    events: [
      {
        id: 'm4-pirates',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          'Pirate skiffs were spotted near the straits. A shipyard on ' +
          'the coast and patrol boats on the water will end that.',
      },
      {
        id: 'm4-yard',
        trigger: { kind: 'onFirstBuilding', building: 'shipyard' },
        message:
          'The yard is open! Select it and train ships — then click ' +
          'WATER on the map to launch them.',
      },
      {
        id: 'm4-raid',
        trigger: { kind: 'atTick', tick: 9000 },
        message: 'Pirates raid the outer islands! Your boats are needed.',
        raid: { count: 3, kinds: ['patrolBoat', 'patrolBoat', 'patrolBoat'], from: 'east' },
      },
    ],
    mapPreset: 'Archipelago',
    aiDifficulty: 'citizen',
    startingResources: { funds: 6000, materials: 2500 },
    debriefWin:
      'The straits are safe — or profitable, which amounts to the same ' +
      'thing. Trade flows, and the flag flies over every island.',
    debriefLose:
      'The pirates grew bold and the merchants grew nervous. The sea ' +
      'does not forgive unprepared presidents.',
  },
  {
    id: 'the-grid-choice',
    order: 5,
    name: 'The Grid Choice',
    briefing: M5_BRIEFING,
    paths: [
      {
        id: 'wired',
        name: 'Peaceful: Win the wire race',
        peaceful: true,
        objectives: [
          { kind: 'reachAge', age: 'connectivity', label: 'Reach the Connectivity age' },
          { kind: 'stockpile', resource: 'materials', count: 2000, label: 'Stockpile 2,000 materials' },
        ],
      },
    ],
    events: [
      {
        id: 'm5-voss',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          'Commander Voss is laying fiber of his own. The National ' +
          'Program choice is permanent, President — choose wisely.',
      },
      {
        id: 'm5-program',
        trigger: { kind: 'onAgeAdvanced', age: 'connectivity' },
        message:
          'Connectivity achieved! Fiber Grid multiplies your taxes; ' +
          'Signals Grid sharpens every eye you have.',
      },
      {
        id: 'm5-raid',
        trigger: { kind: 'atTick', tick: 10800 },
        message: 'Voss probes your grid with a sabotage team!',
        raid: { count: 4, kinds: ['spectre', 'spectre', 'rifles', 'rifles'], from: 'west' },
      },
    ],
    mapPreset: 'Lake Country',
    aiDifficulty: 'commander',
    startingResources: { funds: 8000, materials: 3000 },
    debriefWin:
      'The nation is wired. Data flows like water, and Voss\u2019s ' +
      'cables look like string by comparison.',
    debriefLose:
      'Voss wired his bloc first. The future arrived — just not for you. ' +
      'Rewind the term and try again.',
  },
  {
    id: 'two-fronts',
    order: 6,
    name: 'Two Fronts',
    briefing: M6_BRIEFING,
    paths: [
      {
        id: 'break',
        name: 'Military: Break her armies',
        peaceful: false,
        objectives: [{ kind: 'destroyUnits', count: 40, label: 'Destroy 40 enemy units' }],
      },
      {
        id: 'outthink',
        name: 'Peaceful: Out-think her',
        peaceful: true,
        objectives: [{ kind: 'reachAge', age: 'information', label: 'Reach the Information age' }],
      },
    ],
    events: [
      {
        id: 'm6-karr',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          'General Karr\u2019s doctrine: hit everywhere at once. Watch ' +
          'both horizons, President.',
      },
      {
        id: 'm6-east',
        trigger: { kind: 'atTick', tick: 7200 },
        message: 'Eastern front! Karr\u2019s armor is rolling!',
        raid: { count: 6, kinds: ['tank', 'tank', 'tank', 'rifles', 'rifles', 'artillery'], from: 'east' },
      },
      {
        id: 'm6-west',
        trigger: { kind: 'atTick', tick: 14400 },
        message: 'Western front! A second column — she committed everything.',
        raid: { count: 6, kinds: ['tank', 'tank', 'rifles', 'rifles', 'rifles', 'aa'], from: 'west' },
      },
    ],
    mapPreset: 'Coastline',
    aiDifficulty: 'general',
    startingResources: { funds: 10000, materials: 4000, manpower: 60 },
    debriefWin:
      'Karr\u2019s two fronts became two defeats — or two irrelevancies. ' +
      'The caretaker, it turns out, was keeping the whole house.',
    debriefLose:
      'Two fronts were one too many. Karr dictates the terms this ' +
      'time — but terms can be renegotiated.',
  },
  {
    id: 'the-summit',
    order: 7,
    name: 'The Summit',
    briefing: M7_BRIEFING,
    paths: [
      {
        id: 'voice',
        name: 'Peaceful: Win the Summit',
        peaceful: true,
        objectives: [
          { kind: 'build', building: 'mediaCenter', count: 2, label: 'Build 2 media centers' },
          { kind: 'stockpile', resource: 'influence', count: 400, label: 'Accumulate 400 influence' },
        ],
      },
      {
        id: 'silence',
        name: 'Military: Silence the doubters',
        peaceful: false,
        objectives: [{ kind: 'destroyUnits', count: 30, label: 'Destroy 30 enemy units' }],
      },
    ],
    events: [
      {
        id: 'm7-summit',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          'Six months to the Summit. Influence is the currency of ' +
          'nations now — media centers mint it.',
      },
      {
        id: 'm7-media',
        trigger: { kind: 'onFirstBuilding', building: 'mediaCenter' },
        message:
          'On air! Influence grows with every broadcast. Spend it ' +
          'wisely — the blocs are watching.',
      },
      {
        id: 'm7-spoiler',
        trigger: { kind: 'atTick', tick: 12600 },
        message: 'Karr\u2019s spoilers move to disrupt the Summit preparations!',
        raid: { count: 5, kinds: ['spectre', 'spectre', 'tank', 'rifles', 'rifles'], from: 'south' },
      },
    ],
    mapPreset: 'Riverlands',
    aiDifficulty: 'general',
    startingResources: { funds: 12000, materials: 5000, manpower: 80 },
    debriefWin:
      'At the Summit, every delegation hung on your words — or feared ' +
      'your armies. Either way: the republic leads.',
    debriefLose:
      'The Summit chose another voice. History is written by the ' +
      'persistent, President — persist.',
  },
  {
    id: 'the-first-term',
    order: 8,
    name: 'The First Term',
    briefing: M8_BRIEFING,
    paths: [
      {
        id: 'victory',
        name: 'Military: End the war',
        peaceful: false,
        objectives: [{ kind: 'destroyAllEnemy', label: 'Destroy all enemy forces' }],
      },
      {
        id: 'ascend',
        name: 'Peaceful: Render war obsolete',
        peaceful: true,
        objectives: [{ kind: 'reachAge', age: 'ascendance', label: 'Reach the Ascendance age' }],
      },
    ],
    events: [
      {
        id: 'm8-dain',
        trigger: { kind: 'atTick', tick: 30 },
        message:
          'Marshal Dain does not bluff and does not forgive. This is ' +
          'the term, President. All of it.',
      },
      {
        id: 'm8-wave1',
        trigger: { kind: 'atTick', tick: 9000 },
        message: 'Dain\u2019s vanguard strikes from the east!',
        raid: { count: 8, kinds: ['tank', 'tank', 'tank', 'rifles', 'rifles', 'rifles', 'artillery', 'aa'], from: 'east' },
      },
      {
        id: 'm8-wave2',
        trigger: { kind: 'atTick', tick: 18000 },
        message: 'The main assault — from the north, in force!',
        raid: {
          count: 10,
          kinds: ['tank', 'tank', 'tank', 'tank', 'rifles', 'rifles', 'rifles', 'rifles', 'artillery', 'spectre'],
          from: 'north',
        },
      },
      {
        id: 'm8-sea',
        trigger: { kind: 'atTick', tick: 27000 },
        message: 'Dain lands marines from the sea! Guard the coast!',
        raid: { count: 4, kinds: ['destroyer', 'destroyer', 'transportShip', 'patrolBoat'], from: 'south' },
      },
    ],
    mapPreset: 'Inland Sea',
    aiDifficulty: 'marshal',
    startingResources: { funds: 15000, materials: 6000, manpower: 100 },
    debriefWin:
      'Four years, eight trials. The fracture is healing — by treaty ' +
      'or by triumph, the republic stands unbroken.',
    debriefLose:
      'Dain prevails — this time. But terms end, and presidents get ' +
      'second terms. History is not finished with you.',
  },
];

/** Look up a mission by id. */
export function getMission(id: string): MissionDef | undefined {
  return MISSIONS.find((m) => m.id === id);
}

/** Missions in campaign order. */
export function missionsInOrder(): MissionDef[] {
  return [...MISSIONS].sort((a, b) => a.order - b.order);
}
