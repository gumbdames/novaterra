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
 * NOVATERRA — sim/ages.ts — Ages (Foundation → Connectivity) + National Program choice.
 *
 * Design (docs/research/game-design.md §C5):
 *  - Ages are development stages of the player's nation within the fixed
 *    2026 setting, not calendar years.
 *  - Age-ups are commitment choices with real costs: advancing costs
 *    resources and leaves you vulnerable if timed poorly.
 *  - **Foundation** (Age 1): the starting age. Unlocks roads, zoning,
 *    power/water, infantry, patrol boats.
 *  - **Connectivity** (Age 2): advance by picking 1 National Program —
 *    **Fiber Grid** (economy: +bandwidth, digital firms, economic bonuses)
 *    or **Signals Grid** (intel: listening posts, recon drones, intel
 *    bonuses). Unlocks universities, trade port, fighters, destroyers.
 *    (Navy arrives in Phase 1.5 — the naval unlocks are gated behind a
 *    "not yet available" marker, not implemented here.)
 *  - The choice is permanent for the game (landmark-style decision).
 *    Both programs are viable; the tradeoff must be real, not a no-brainer.
 *
 * Effects (Phase 1 engineering choices, not locked design):
 *  - Fiber Grid: +25% tax income (funds). Rewards economic play.
 *  - Signals Grid: +8 sight range for all units. Rewards intel/scouting play.
 *
 * State is plain JSON-safe data, snapshotted (v5) and digested.
 * No RNG needed — the age-up is a pure player decision.
 *
 * Pure module: no DOM, no three.js, no wall clock, no Math.random.
 * Safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue } from './commands';
import { getPlayer } from './city';

/** Development stages of the player's nation (fixed 2026 setting). */
export type Age = 'foundation' | 'connectivity' | 'industry' | 'information' | 'ascendance';

/** The permanent National Program choice. Null until Connectivity is chosen. */
export type NationalProgram =
  | 'fiberGrid' | 'signalsGrid'
  | 'heavyIndustry' | 'greenTech'
  | 'cyberCommand' | 'globalMedia'
  | 'arsenalProgram' | 'prosperityProgram'
  | null;

/** Age state for the world. Plain data — snapshotted + digested. */
export interface AgeState {
  /** Current age. Starts at 'foundation'. */
  age: Age;
  /** The chosen National Program for the current age. Null in Foundation. */
  program: NationalProgram;
  /** Programs chosen for each past age (age -> program). Permanent choices. */
  programs: Partial<Record<Age, NationalProgram>>;
}

/** Create fresh age state: Foundation, no program chosen. */
export function initAges(): AgeState {
  return { age: 'foundation', program: null, programs: {} };
}

/** Get the program chosen for a specific age (null if not yet chosen). */
export function getProgramForAge(world: World, age: Age): NationalProgram {
  if (world.ages.age === age) return world.ages.program;
  return world.ages.programs[age] ?? null;
}

/** Cost to advance from Foundation to Connectivity (funds + materials). */
export const CONNECTIVITY_COST = {
  funds: 3000,
  materials: 1200,
} as const;

/** Fiber Grid: tax income multiplier (+25% funds from taxes). */
export const FIBER_GRID_TAX_MULTIPLIER = 1.25;

/** Signals Grid: bonus sight range for all units (+8 world units). */
export const SIGNALS_GRID_SIGHT_BONUS = 8;

/**
 * Tax income multiplier for the world. Returns 1.25 with Fiber Grid,
 * 1.0 otherwise.
 */
export function getTaxMultiplier(world: World): number {
  if (getProgramForAge(world, 'connectivity') === 'fiberGrid') {
    return FIBER_GRID_TAX_MULTIPLIER;
  }
  return 1.0;
}

/**
 * Sight range bonus for the world. Returns 8 with Signals Grid,
 * 0 otherwise.
 */
export function getSightBonus(world: World): number {
  if (getProgramForAge(world, 'connectivity') === 'signalsGrid') {
    return SIGNALS_GRID_SIGHT_BONUS;
  }
  return 0;
}

/** Industry age advancement cost. */
export const INDUSTRY_COST = {
  funds: 6000,
  materials: 2500,
  influence: 100,
} as const;

/** Heavy Industry: factory output multiplier (+50% materials/goods). */
export const HEAVY_INDUSTRY_OUTPUT_MULT = 1.5;
/** Heavy Industry: upkeep cost multiplier (+25% funds/sec). */
export const HEAVY_INDUSTRY_UPKEEP_MULT = 1.25;

/** Green Tech: utility demand multiplier (-30% power/water). */
export const GREEN_TECH_UTILITY_MULT = 0.7;
/** Green Tech: influence generation multiplier (+50%). */
export const GREEN_TECH_INFLUENCE_MULT = 1.5;

/** Information age advancement cost. */
export const INFORMATION_COST = {
  funds: 12000,
  materials: 5000,
  influence: 250,
} as const;

/** Cyber Command: spectre damage multiplier (+50%). */
export const CYBER_COMMAND_SPECTRE_MULT = 1.5;
/** Cyber Command: military sight bonus (+4). */
export const CYBER_COMMAND_SIGHT_BONUS = 4;

/** Global Media: influence generation multiplier (+100%). */
export const GLOBAL_MEDIA_INFLUENCE_MULT = 2.0;

/** Ascendance age advancement cost. */
export const ASCENDANCE_COST = {
  funds: 25000,
  materials: 10000,
  influence: 500,
} as const;

/** Arsenal Program: manpower cost multiplier (-30%). */
export const ARSENAL_MANPOWER_MULT = 0.7;
/** Arsenal Program: military damage multiplier (+25%). */
export const ARSENAL_DAMAGE_MULT = 1.25;

/** Prosperity Program: tax income multiplier (+50%). */
export const PROSPERITY_TAX_MULT = 1.5;
/** Prosperity Program: goods output multiplier (+50%). */
export const PROSPERITY_GOODS_MULT = 1.5;

/**
 * Factory output multiplier. Returns 1.5 with Heavy Industry, 1.0 otherwise.
 */
export function getFactoryOutputMult(world: World): number {
  if (getProgramForAge(world, 'industry') === 'heavyIndustry') {
    return HEAVY_INDUSTRY_OUTPUT_MULT;
  }
  return 1.0;
}

/**
 * Building upkeep multiplier. Returns 1.25 with Heavy Industry, 1.0 otherwise.
 */
export function getUpkeepMult(world: World): number {
  if (getProgramForAge(world, 'industry') === 'heavyIndustry') {
    return HEAVY_INDUSTRY_UPKEEP_MULT;
  }
  return 1.0;
}

/**
 * Utility demand multiplier. Returns 0.7 with Green Tech, 1.0 otherwise.
 */
export function getUtilityDemandMult(world: World): number {
  if (getProgramForAge(world, 'industry') === 'greenTech') {
    return GREEN_TECH_UTILITY_MULT;
  }
  return 1.0;
}

/**
 * Influence generation multiplier. Stacks Green Tech (1.5x) and Global Media (2.0x).
 */
export function getInfluenceMult(world: World): number {
  let mult = 1.0;
  if (getProgramForAge(world, 'industry') === 'greenTech') {
    mult *= GREEN_TECH_INFLUENCE_MULT;
  }
  if (getProgramForAge(world, 'information') === 'globalMedia') {
    mult *= GLOBAL_MEDIA_INFLUENCE_MULT;
  }
  return mult;
}

/**
 * Spectre damage multiplier. Returns 1.5 with Cyber Command, 1.0 otherwise.
 */
export function getSpectreDamageMult(world: World): number {
  if (getProgramForAge(world, 'information') === 'cyberCommand') {
    return CYBER_COMMAND_SPECTRE_MULT;
  }
  return 1.0;
}

/**
 * Military sight bonus. Returns 4 with Cyber Command, 0 otherwise.
 * Stacks with Signals Grid.
 */
export function getMilitarySightBonus(world: World): number {
  if (getProgramForAge(world, 'information') === 'cyberCommand') {
    return CYBER_COMMAND_SIGHT_BONUS;
  }
  return 0;
}

/**
 * Manpower cost multiplier. Returns 0.7 with Arsenal Program, 1.0 otherwise.
 */
export function getManpowerCostMult(world: World): number {
  if (getProgramForAge(world, 'ascendance') === 'arsenalProgram') {
    return ARSENAL_MANPOWER_MULT;
  }
  return 1.0;
}

/**
 * Military damage multiplier. Returns 1.25 with Arsenal Program, 1.0 otherwise.
 */
export function getMilitaryDamageMult(world: World): number {
  if (getProgramForAge(world, 'ascendance') === 'arsenalProgram') {
    return ARSENAL_DAMAGE_MULT;
  }
  return 1.0;
}

/**
 * Goods output multiplier. Returns 1.5 with Prosperity Program, 1.0 otherwise.
 */
export function getGoodsOutputMult(world: World): number {
  if (getProgramForAge(world, 'ascendance') === 'prosperityProgram') {
    return PROSPERITY_GOODS_MULT;
  }
  return 1.0;
}

/**
 * Extended tax multiplier: Fiber Grid (1.25x) stacks with Prosperity (1.5x).
 */
export function getTaxMultiplierFull(world: World): number {
  let mult = getTaxMultiplier(world);
  if (getProgramForAge(world, 'ascendance') === 'prosperityProgram') {
    mult *= PROSPERITY_TAX_MULT;
  }
  return mult;
}

/**
 * Check if a unit kind is available at the world's current age.
 * Used by spawn validation and the AI's spawn choices.
 */
/** Age ordering for gating: higher index = later age. */
export const AGE_ORDER: Age[] = ['foundation', 'connectivity', 'industry', 'information', 'ascendance'];

export function isUnitAvailableForAge(world: World, minAge: Age): boolean {
  const have = AGE_ORDER.indexOf(world.ages.age);
  const need = AGE_ORDER.indexOf(minAge);
  return have >= need;
}

/** Check if a building kind is available in the world's current age. */
export function isBuildingAvailableForAge(world: World, minAge: Age): boolean {
  return isUnitAvailableForAge(world, minAge);
}

/** Register the `advanceAge` command. */
/** Age progression: each age maps to its successor, valid programs, and cost. */
export const AGE_PROGRESSION: Record<Age, { next: Age | null; programs: string[]; cost: Record<string, number> }> = {
  foundation: { next: 'connectivity', programs: ['fiberGrid', 'signalsGrid'], cost: CONNECTIVITY_COST as unknown as Record<string, number> },
  connectivity: { next: 'industry', programs: ['heavyIndustry', 'greenTech'], cost: INDUSTRY_COST as unknown as Record<string, number> },
  industry: { next: 'information', programs: ['cyberCommand', 'globalMedia'], cost: INFORMATION_COST as unknown as Record<string, number> },
  information: { next: 'ascendance', programs: ['arsenalProgram', 'prosperityProgram'], cost: ASCENDANCE_COST as unknown as Record<string, number> },
  ascendance: { next: null, programs: [], cost: {} },
};

export function registerAgeCommands(queue: CommandQueue): void {
  queue.register('advanceAge', {
    validate(cmd, world): string | null {
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'advanceAge: payload.owner must be an integer';
      }
      const player = getPlayer(world.city, owner);
      if (!player) {
        return 'advanceAge: unknown owner';
      }
      const prog = AGE_PROGRESSION[world.ages.age];
      if (!prog.next) {
        return `advanceAge: already at ${world.ages.age}, cannot advance further`;
      }
      // Program choice is required and must match the next age.
      const program = cmd.payload['program'];
      if (typeof program !== 'string' || !prog.programs.includes(program)) {
        return `advanceAge: program must be one of ${prog.programs.join(', ')}`;
      }
      // Must afford the cost (funds, materials, and influence for ages 3+).
      for (const [res, amount] of Object.entries(prog.cost)) {
        const have = (player as unknown as Record<string, number>)[res] ?? 0;
        if (have < amount) {
          return `advanceAge: cannot afford ${amount} ${res} (have ${have.toFixed(0)})`;
        }
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = cmd.payload['owner'] as number;
      const program = cmd.payload['program'] as NationalProgram;
      const player = getPlayer(world.city, owner);
      if (!player) {
        throw new Error('advanceAge: unknown owner at apply');
      }
      const prog = AGE_PROGRESSION[world.ages.age];
      if (!prog.next) {
        throw new Error('advanceAge: already at max age at apply time');
      }
      // Re-check affordability at apply (state may have changed since enqueue).
      for (const [res, amount] of Object.entries(prog.cost)) {
        const have = (player as unknown as Record<string, number>)[res] ?? 0;
        if (have < amount) {
          throw new Error(`advanceAge: cannot afford ${res} at apply time`);
        }
      }
      for (const [res, amount] of Object.entries(prog.cost)) {
        const stocks = player as unknown as Record<string, number>;
        stocks[res] = (stocks[res] ?? 0) - amount;
      }
      // Save the program choice for the age we're leaving.
      const leavingAge = world.ages.age;
      if (world.ages.program) {
        world.ages.programs[leavingAge] = world.ages.program;
      }
      world.ages.age = prog.next!;
      world.ages.program = program as NationalProgram;
      return { age: prog.next, program };
    },
  });
}

/**
 * Canonical JSON-safe encoding of age state for snapshots and digests.
 */
export function encodeAgeState(ages: AgeState): unknown {
  return { age: ages.age, program: ages.program, programs: { ...ages.programs } };
}

/** Valid ages and programs for snapshot decoding. */
const VALID_AGES: Age[] = ['foundation', 'connectivity', 'industry', 'information', 'ascendance'];
const VALID_PROGRAMS: string[] = [
  'fiberGrid', 'signalsGrid',
  'heavyIndustry', 'greenTech',
  'cyberCommand', 'globalMedia',
  'arsenalProgram', 'prosperityProgram',
];

/** Restore age state from a snapshot payload (see snapshot.ts). */
export function decodeAgeState(data: unknown): AgeState {
  const d = data as { age: Age; program: NationalProgram; programs?: Partial<Record<Age, NationalProgram>> };
  const age = VALID_AGES.includes(d.age) ? d.age : 'foundation';
  const program = (typeof d.program === 'string' && VALID_PROGRAMS.includes(d.program))
    ? (d.program as NationalProgram) : null;
  const programs: Partial<Record<Age, NationalProgram>> = {};
  if (d.programs && typeof d.programs === 'object') {
    for (const [k, v] of Object.entries(d.programs)) {
      if (VALID_AGES.includes(k as Age) && typeof v === 'string' && VALID_PROGRAMS.includes(v)) {
        programs[k as Age] = v as NationalProgram;
      }
    }
  }
  return { age, program, programs };
}
