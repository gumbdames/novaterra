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
 * grand-expansion Phase 8, workstream B, 2026-09-30; endless revision,
 * 2026-10-01):
 *  - which main menu tabs render in a peaceful world (Military hidden),
 *  - the Management tab's peaceful-status display lines
 *    (`peacefulStatus` → player-facing copy).
 *
 * Peaceful mode is ENDLESS (2026-10-01): there is no victory
 * condition, no end screen, no rival race. The Management tab shows
 * the city's status (population, treasury health) as information —
 * not as progress toward a goal. The old builder's-race victory
 * (`peacefulOutcome` / `peacefulEndCopy`, 8,000 residents) was
 * removed; `ui/game.ts` shows no end screen for peaceful worlds.
 *
 * Pure module: no DOM, no three.js, no wall clock, no RNG. Safe under
 * Node/vitest. It reads sim state defensively (a missing player record
 * reports zero population — never throws) and never writes sim state.
 *
 * Import discipline: value-imports sim/peaceful.ts (pure). The
 * MenuTabId type import from ui/palettes is type-only.
 */

import type { World } from '../sim/world';
import { peacefulStatus } from '../sim/peaceful';
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

/** Display lines for the Management tab's peaceful-status section. */
export interface PeacefulStatusLines {
  /** e.g. "Population: 3,412". */
  populationLine: string;
  /** e.g. "Treasury: healthy" / "Treasury: negative". */
  treasuryLine: string;
}

/**
 * Player-facing peaceful-status lines for one owner, from the sim's
 * `peacefulStatus`. There is no rival line: peaceful mode is endless
 * (2026-10-01) and there is no builder's race to report — the panel
 * shows how the player's own city is doing, nothing more.
 */
export function peacefulStatusLines(world: World, owner: number): PeacefulStatusLines {
  const p = STRINGS.peaceful;
  const status = peacefulStatus(world, owner);
  return {
    populationLine: fillLoc(p.populationLine, {
      pop: formatCount(status.population),
    }),
    treasuryLine: loc(status.treasuryOk ? p.treasuryOk : p.treasuryBad),
  };
}
