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
 *  - **Per-side ages (2026-10-01, roadmap A1):** every owner advances
 *    independently — `World.ages` is a per-owner map, not one shared
 *    state. When the marshal pays for an age, only the marshal gets it;
 *    the age race is real again (the old global age was a free-rider
 *    exploit: whoever paid, everyone benefited). Every effect function
 *    takes the owner whose nation it reads.
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
import type { Command, CommandQueue } from './commands';
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

/** Age state for one owner. Plain data — snapshotted + digested. */
export interface AgeState {
  /** Current age. Starts at 'foundation'. */
  age: Age;
  /** The chosen National Program for the current age. Null in Foundation. */
  program: NationalProgram;
  /** Programs chosen for each past age (age -> program). Permanent choices. */
  programs: Partial<Record<Age, NationalProgram>>;
}

/** Per-side age states, keyed by owner id. Missing owner = Foundation (see getAgeState). */
export type PerSideAges = Record<number, AgeState>;

/** Create fresh age state: Foundation, no program chosen. */
export function initAges(): AgeState {
  return { age: 'foundation', program: null, programs: {} };
}

/**
 * The age state of one owner. Lazily creates (and stores) the Foundation
 * state for owners never seen before — the creation order follows the
 * deterministic read order, so replays stay identical. Read-only callers
 * that must never mutate (digest, snapshot encode) read `world.ages`
 * directly instead.
 */
export function getAgeState(world: World, owner: number): AgeState {
  let st = world.ages[owner];
  if (!st) {
    st = initAges();
    world.ages[owner] = st;
  }
  return st;
}

/** Get the program chosen by an owner for a specific age (null if not yet chosen). */
export function getProgramForAge(world: World, owner: number, age: Age): NationalProgram {
  const st = getAgeState(world, owner);
  if (st.age === age) return st.program;
  return st.programs[age] ?? null;
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
 * Tax income multiplier for an owner. Returns 1.25 with Fiber Grid,
 * 1.0 otherwise.
 */
export function getTaxMultiplier(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'connectivity') === 'fiberGrid') {
    return FIBER_GRID_TAX_MULTIPLIER;
  }
  return 1.0;
}

/**
 * Sight range bonus for an owner. Returns 8 with Signals Grid,
 * 0 otherwise.
 */
export function getSightBonus(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'connectivity') === 'signalsGrid') {
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
 * Factory output multiplier for an owner. Returns 1.5 with Heavy Industry, 1.0 otherwise.
 */
export function getFactoryOutputMult(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'industry') === 'heavyIndustry') {
    return HEAVY_INDUSTRY_OUTPUT_MULT;
  }
  return 1.0;
}

/**
 * Building upkeep multiplier for an owner. Returns 1.25 with Heavy Industry, 1.0 otherwise.
 */
export function getUpkeepMult(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'industry') === 'heavyIndustry') {
    return HEAVY_INDUSTRY_UPKEEP_MULT;
  }
  return 1.0;
}

/**
 * Utility demand multiplier for an owner. Returns 0.7 with Green Tech, 1.0 otherwise.
 */
export function getUtilityDemandMult(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'industry') === 'greenTech') {
    return GREEN_TECH_UTILITY_MULT;
  }
  return 1.0;
}

/**
 * Influence generation multiplier for an owner. Stacks Green Tech (1.5x) and Global Media (2.0x).
 */
export function getInfluenceMult(world: World, owner: number): number {
  let mult = 1.0;
  if (getProgramForAge(world, owner, 'industry') === 'greenTech') {
    mult *= GREEN_TECH_INFLUENCE_MULT;
  }
  if (getProgramForAge(world, owner, 'information') === 'globalMedia') {
    mult *= GLOBAL_MEDIA_INFLUENCE_MULT;
  }
  return mult;
}

/**
 * Spectre damage multiplier for an owner. Returns 1.5 with Cyber Command, 1.0 otherwise.
 */
export function getSpectreDamageMult(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'information') === 'cyberCommand') {
    return CYBER_COMMAND_SPECTRE_MULT;
  }
  return 1.0;
}

/**
 * Manpower cost multiplier for an owner. Returns 0.7 with Arsenal Program, 1.0 otherwise.
 */
export function getManpowerCostMult(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'ascendance') === 'arsenalProgram') {
    return ARSENAL_MANPOWER_MULT;
  }
  return 1.0;
}

/**
 * Military damage multiplier for an owner. Returns 1.25 with Arsenal Program, 1.0 otherwise.
 */
export function getMilitaryDamageMult(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'ascendance') === 'arsenalProgram') {
    return ARSENAL_DAMAGE_MULT;
  }
  return 1.0;
}

/**
 * Goods output multiplier for an owner. Returns 1.5 with Prosperity Program, 1.0 otherwise.
 */
export function getGoodsOutputMult(world: World, owner: number): number {
  if (getProgramForAge(world, owner, 'ascendance') === 'prosperityProgram') {
    return PROSPERITY_GOODS_MULT;
  }
  return 1.0;
}

/**
 * Extended tax multiplier for an owner: Fiber Grid (1.25x) stacks with Prosperity (1.5x).
 */
export function getTaxMultiplierFull(world: World, owner: number): number {
  let mult = getTaxMultiplier(world, owner);
  if (getProgramForAge(world, owner, 'ascendance') === 'prosperityProgram') {
    mult *= PROSPERITY_TAX_MULT;
  }
  return mult;
}

/**
 * Check if a unit kind is available at an owner's current age.
 * Used by spawn validation and the AI's spawn choices.
 */
/** Age ordering for gating: higher index = later age. */
export const AGE_ORDER: Age[] = ['foundation', 'connectivity', 'industry', 'information', 'ascendance'];

export function isUnitAvailableForAge(world: World, owner: number, minAge: Age): boolean {
  const have = AGE_ORDER.indexOf(getAgeState(world, owner).age);
  const need = AGE_ORDER.indexOf(minAge);
  return have >= need;
}

/** Register the `advanceAge` command. */
/**
 * True when an `advanceAge` command is a harmless duplicate: its payload
 * carries the `fromAge` the issuer saw at enqueue, and the OWNER has
 * already advanced strictly past it (the same owner enqueued twice on
 * one tick). Such a command fizzles at apply instead of going stale —
 * the fix for the same-tick double-advance race (Phase 9 soak finding
 * 6.1). Per-side ages (2026-10-01): the comparison is against the
 * issuing owner's age state, never a world-global age — two different
 * owners advancing on the same tick is normal play, not a duplicate.
 * A missing/invalid `fromAge` keeps the legacy strict behavior, and an
 * age equal to or behind `fromAge` is never a duplicate (ages never
 * regress, so "behind" can't happen — it falls through to the normal
 * validation, which rejects loudly as before).
 */
function isAdvanceAgeDuplicate(cmd: Command, world: World, owner: number): boolean {
  const fromAge = cmd.payload['fromAge'];
  if (typeof fromAge !== 'string') return false;
  const fromIdx = (AGE_ORDER as string[]).indexOf(fromAge);
  if (fromIdx < 0) return false;
  return (AGE_ORDER as string[]).indexOf(getAgeState(world, owner).age) > fromIdx;
}
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
      // Idempotency (Phase 9 balance pass, 2026-09-30): the same owner
      // can enqueue twice on one tick (e.g. two AI thinks, or a human
      // and a queued order). The payload may carry `fromAge` — the age
      // the issuer saw at enqueue. When the OWNER has already advanced
      // past it, this command is a harmless duplicate: it stays valid
      // and fizzles at apply (no double charge, no stale throw).
      // Without `fromAge` the legacy strict behavior applies.
      // Per-side ages (2026-10-01): each owner advances independently —
      // another owner's advancement is never a duplicate of yours.
      if (isAdvanceAgeDuplicate(cmd, world, owner)) return null;
      const st = getAgeState(world, owner);
      const prog = AGE_PROGRESSION[st.age];
      if (!prog.next) {
        return `advanceAge: already at ${st.age}, cannot advance further`;
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
      // Duplicate (see validate): the owner already advanced past the
      // issuer's `fromAge` — fizzle as a no-op WITHOUT charging. The
      // first applier already paid; a second charge would bill the same
      // advancement twice.
      const st = getAgeState(world, owner);
      if (isAdvanceAgeDuplicate(cmd, world, owner)) {
        return { age: st.age, program, stale: true };
      }
      const prog = AGE_PROGRESSION[st.age];
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
      const leavingAge = st.age;
      if (st.program) {
        st.programs[leavingAge] = st.program;
      }
      st.age = prog.next;
      st.program = program as NationalProgram;
      return { age: prog.next, program };
    },
  });
}

/**
 * Canonical JSON-safe encoding of the per-side age map for snapshots.
 * Keys are owner ids (as strings); values are the plain AgeState.
 */
export function encodeAgeState(ages: PerSideAges): unknown {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ages).sort()) {
    const st = ages[Number(key)];
    if (!st) continue;
    out[key] = { age: st.age, program: st.program, programs: { ...st.programs } };
  }
  return out;
}

/** Valid ages and programs for snapshot decoding. */
const VALID_AGES: Age[] = ['foundation', 'connectivity', 'industry', 'information', 'ascendance'];
const VALID_PROGRAMS: string[] = [
  'fiberGrid', 'signalsGrid',
  'heavyIndustry', 'greenTech',
  'cyberCommand', 'globalMedia',
  'arsenalProgram', 'prosperityProgram',
];

/** Restore one owner's age state from a snapshot payload. */
function decodeOneAgeState(data: unknown): AgeState {
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

/**
 * Restore the per-side age map from a snapshot payload (see snapshot.ts).
 * `owners` are the player ids in the decoded city — used only for the
 * legacy format (pre-2026-10-01): one world-global AgeState, which every
 * side played at, so every current owner inherits a copy (AD9 additive,
 * no version bump).
 */
export function decodeAgeState(data: unknown, owners: number[] = [0]): PerSideAges {
  const out: PerSideAges = {};
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return out;
  if (typeof (d as { age?: unknown }).age === 'string') {
    const st = decodeOneAgeState(d);
    for (const o of owners) out[o] = { age: st.age, program: st.program, programs: { ...st.programs } };
    return out;
  }
  for (const [k, v] of Object.entries(d)) {
    const o = Number(k);
    if (!Number.isInteger(o)) continue;
    out[o] = decodeOneAgeState(v);
  }
  return out;
}
