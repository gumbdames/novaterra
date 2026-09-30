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
 * NOVATERRA — ui/peaceful.ts — peaceful-mode UI contract (pure, tested).
 *
 * The UI-side mirror of the sim's peaceful system (sim/peaceful.ts,
 * grand-expansion Phase 8, workstream B, 2026-09-30):
 *  - which main menu tabs render in a peaceful world (Military hidden),
 *  - the Management tab's peaceful-objectives display lines
 *    (`peacefulObjectiveProgress` → player-facing copy),
 *  - the end-screen outcome helper (`peacefulOutcome`) and its copy
 *    (`peacefulEndCopy`).
 *
 * Pure module: no DOM, no three.js, no wall clock, no RNG. Safe under
 * Node/vitest. It reads sim state defensively (a missing player record
 * reports zero progress — never throws) and never writes sim state.
 *
 * Import discipline: value-imports sim/peaceful.ts (pure) and
 * ui/session.ts (AI_PLAYER_ID only — session.ts imports only sim, so no
 * cycle). The MenuTabId type import from ui/palettes is type-only.
 */

import type { World } from '../sim/world';
import {
  checkPeacefulVictory,
  peacefulObjectiveProgress,
  PEACEFUL_VICTORY_POPULATION,
} from '../sim/peaceful';
import { AI_PLAYER_ID } from './session';
import type { MenuTabId } from './palettes';
import { STRINGS, loc, fillLoc } from './strings';

/**
 * The main menu tabs a world shows. Peaceful games hide the Military
 * tab entirely (cleaner than a disabled tab — nothing military exists
 * to manage); the Civilian tab carries the one-line note. Pure so the
 * tab-bar logic is headless-testable (hud.ts renders from this).
 */
export function menuTabsForWorld(peaceful: boolean): MenuTabId[] {
  return peaceful
    ? ['civilian', 'management']
    : ['civilian', 'military', 'management'];
}

/**
 * Thousands-separated integer formatting — deterministic and
 * locale-independent (no `toLocaleString`, whose output varies by
 * runtime ICU data).
 */
export function formatCount(n: number): string {
  const neg = n < 0;
  const digits = String(Math.abs(Math.trunc(n)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg ? `-${grouped}` : grouped;
}

/** Display lines for the Management tab's peaceful-objectives section. */
export interface PeacefulObjectiveLines {
  /** e.g. "Population: 3,412 / 8,000". */
  populationLine: string;
  /** e.g. "Treasury: healthy" / "Treasury: negative". */
  treasuryLine: string;
  /** e.g. "Rival: 5,201 / 8,000" — null when the rival isn't playing. */
  rivalLine: string | null;
  /** True when the owner's victory conditions both hold. */
  achieved: boolean;
}

/**
 * Player-facing peaceful-objective lines for one owner, from the sim's
 * `peacefulObjectiveProgress`. The rival line is included because the
 * rival can win first (an AI rival that hits the target first is the
 * peaceful defeat) — the player needs to see the race.
 */
export function peacefulObjectiveLines(
  world: World,
  owner: number,
  rivalId: number = AI_PLAYER_ID,
): PeacefulObjectiveLines {
  const p = STRINGS.peaceful;
  const prog = peacefulObjectiveProgress(world, owner);
  const rival = peacefulObjectiveProgress(world, rivalId);
  // A missing rival REGISTRATION (sandbox skirmishes have no AI
  // player) renders no rival line — never a "0 / 8,000" phantom racer.
  // The signal is world.ai.players, not the city player record: the
  // city always creates both Player records (a dormant 'Rival' shell
  // funds scripted raids in sandbox), while addAIPlayer only runs when
  // a rival actually plays.
  const rivalPlays = world.ai.players.some((p) => p.owner === rivalId);
  const rivalLine =
    rivalPlays
      ? fillLoc(p.rivalLine, {
          pop: formatCount(rival.population),
          target: formatCount(prog.target),
        })
      : null;
  return {
    populationLine: fillLoc(p.populationLine, {
      pop: formatCount(prog.population),
      target: formatCount(prog.target),
    }),
    treasuryLine: loc(prog.treasuryOk ? p.treasuryOk : p.treasuryBad),
    rivalLine,
    achieved: prog.achieved,
  };
}

/** The peaceful end-screen outcome for a world. */
export type PeacefulOutcome = 'victory' | 'defeat' | null;

/**
 * Which end screen a peaceful world shows, if any. The player is
 * checked first, so a same-tick tie goes to the player (the peaceful
 * race is a builder's race, not a survival check — the opposite of the
 * conquest tiebreak, where defeat takes precedence).
 *
 * Only the sim's `checkPeacefulVictory` decides; the UI never
 * re-implements the threshold. Pure and headless-testable — game.ts's
 * `maybeShowConquestOutcome` calls this for peaceful worlds.
 */
export function peacefulOutcome(
  world: World,
  owner: number,
  rivalId: number = AI_PLAYER_ID,
): PeacefulOutcome {
  if (checkPeacefulVictory(world, owner)) return 'victory';
  if (checkPeacefulVictory(world, rivalId)) return 'defeat';
  return null;
}

/**
 * End-screen title + detail copy for a peaceful outcome. Pure so the
 * copy is headless-testable; game.ts passes it into the existing
 * `EndScreen.showVictory()` / `showDefeat()` path.
 */
export function peacefulEndCopy(
  world: World,
  owner: number,
  outcome: 'victory' | 'defeat',
): { title: string; detail: string } {
  const p = STRINGS.peaceful;
  const pop = formatCount(peacefulObjectiveProgress(world, owner).population);
  return outcome === 'victory'
    ? { title: loc(p.victoryTitle), detail: fillLoc(p.victoryDetail, { pop }) }
    : { title: loc(p.defeatTitle), detail: fillLoc(p.defeatDetail, { pop }) };
}

/** Re-exported for UI call sites that quote the target. */
export { PEACEFUL_VICTORY_POPULATION };
