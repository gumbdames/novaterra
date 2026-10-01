/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of GNU Affero General Public License as published
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
 * NOVATERRA — sim/peaceful.ts — peaceful-mode status (grand-expansion
 * Phase 8, workstream A, 2026-09-30; endless revision, 2026-10-01).
 *
 * Responsibilities:
 *  - The peaceful-mode status readout as a SIM-side pure check:
 *    `peacefulStatus(world, owner)` (housed population + treasury
 *    health). Pure function of world state — no wall clock, no RNG.
 *
 * Final-review (2026-10-01): peaceful mode is ENDLESS — there is no
 * victory condition. The old builder's-race victory (`checkPeacefulVictory`
 * / `peacefulObjectiveProgress`, 8,000 residents) was removed: a
 * peaceful world never ends, it just keeps simulating. The UI shows
 * the status (population, treasury) as information, not as progress
 * toward a goal; there is no end screen, no rival race, no defeat.
 *
 * Non-goals (explicit):
 *  - No "influence" system exists in 0.1 Alpha — none is invented here.
 *  - No defeat path: with every military def locked out, conquest is
 *    unreachable in a peaceful world, so peaceful games can only be
 *    played, never won or lost (documented in the research note).
 *  - Showing the status is UI work: the UI panel consumes
 *    `peacefulStatus`; `ui/session.ts`'s conquest checks are bypassed
 *    for peaceful worlds (`getSkirmishOutcome` returns null), and
 *    `ui/game.ts` shows no end screen for them.
 *
 * Import discipline: value-imports only city.ts (`getPlayer`); city.ts
 * never imports this module, so no cycle. Pure module: no DOM, no
 * three.js, no wall clock. Safe under Node/vitest.
 *
 * Roadmap B1 (2026-10-02): `peacefulScore` (derived city score —
 * population × prosperity: treasury, employment, desirability,
 * ridership) + `PEACEFUL_MILESTONES` / `milestonesReached`. The score
 * is information only — peaceful mode stays ENDLESS, no victory
 * condition. Milestone toasts + the localStorage high score are
 * UI-side (ui/peaceful.ts); the sim stays stateless.
 */

import type { World } from './world';
import { BUILDING_DEFS, getPlayer } from './city';

/** Status view for the peaceful-mode UI panel. */
export interface PeacefulStatus {
  /** The owner's current housed population (`player.population`). */
  population: number;
  /** True when the treasury is non-negative. */
  treasuryOk: boolean;
}

/**
 * Peaceful status for one owner. Pure function of world state. A
 * missing player record (e.g. a hand-built fixture) reports zero
 * population — never throws.
 *
 * This is a STATUS readout, not a victory check: peaceful mode is
 * endless (2026-10-01) and there is no target to reach, no "achieved"
 * flag, no end screen. The panel shows how the city is doing; the
 * game never declares it finished.
 */
export function peacefulStatus(world: World, owner: number): PeacefulStatus {
  const player = getPlayer(world.city, owner);
  return {
    population: player?.population ?? 0,
    treasuryOk: (player?.funds ?? -1) >= 0,
  };
}

/**
 * Roadmap B1 (2026-10-02): peaceful-mode city score.
 *
 * Peaceful mode is ENDLESS — this is explicitly NOT a victory
 * condition, just a derived number that gives endless builders
 * something to watch grow (and to beat: the UI keeps a localStorage
 * high score). Formula, all components 0..1 unless noted:
 *
 *   score = round(population × (1 + treasury + employment + desirability + ridership))
 *
 *  - treasury: log-scaled funds (1M funds ≈ 1.0), 0 when negative.
 *  - employment: filled jobs / job capacity across the owner's
 *    completed buildings (0 when there are no jobs).
 *  - desirability: average residential desirability / 100 — passed in
 *    because it needs the terrain-derived model; 0 when unknown.
 *  - ridership: total transit ridership income (funds/sec) scaled so
 *    ~2 funds/sec of network ≈ 1.0.
 *
 * Pure function of world state (+ the one passed-in average) — no wall
 * clock, no RNG, safe under Node/vitest. A missing player record
 * scores 0, never throws.
 */
export interface PeacefulScore {
  /** The derived score (rounded integer). */
  score: number;
  /** Housed population (the score's base). */
  population: number;
  /** Treasury component 0..1. */
  treasury: number;
  /** Employment component 0..1. */
  employmentRate: number;
  /** Desirability component 0..1 (the input average was 0..100). */
  desirabilityRate: number;
  /** Ridership component 0..1. */
  ridershipRate: number;
}

export function peacefulScore(
  world: World,
  owner: number,
  avgDesirability = 0,
): PeacefulScore {
  const player = getPlayer(world.city, owner);
  const population = player?.population ?? 0;
  const funds = player?.funds ?? 0;
  const treasury =
    funds >= 0 ? Math.min(1, Math.log10(1 + funds / 1000) / 3) : 0;
  let workers = 0;
  let jobs = 0;
  let ridershipIncome = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== owner || b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    const cap = def.jobs ?? 0;
    if (cap > 0) {
      jobs += cap;
      workers += Math.min(b.workers ?? 0, cap);
    }
    if (b.operational) ridershipIncome += def.ridershipIncome ?? 0;
  }
  const employmentRate = jobs > 0 ? workers / jobs : 0;
  const ridershipRate = Math.min(1, ridershipIncome / 2);
  const desirabilityRate =
    Math.max(0, Math.min(100, avgDesirability)) / 100;
  const score = Math.round(
    population * (1 + treasury + employmentRate + desirabilityRate + ridershipRate),
  );
  return {
    score,
    population,
    treasury,
    employmentRate,
    desirabilityRate,
    ridershipRate,
  };
}

/**
 * Roadmap B1 (2026-10-02): score milestones. Crossing a threshold
 * fires a one-time UI toast (the UI tracks which indexes it already
 * toasted — the sim stays stateless). Milestone NAMES live in
 * STRINGS.peaceful.milestoneNames, keyed by index.
 */
export interface PeacefulMilestone {
  /** Score at which the milestone fires. */
  threshold: number;
}

export const PEACEFUL_MILESTONES: PeacefulMilestone[] = [
  { threshold: 1_000 },
  { threshold: 10_000 },
  { threshold: 50_000 },
  { threshold: 250_000 },
  { threshold: 1_000_000 },
];

/**
 * How many milestones a score has reached (0..PEACEFUL_MILESTONES.length).
 * Pure — the UI diffs this against its toasted set.
 */
export function milestonesReached(score: number): number {
  let n = 0;
  for (const m of PEACEFUL_MILESTONES) {
    if (score >= m.threshold) n++;
  }
  return n;
}
