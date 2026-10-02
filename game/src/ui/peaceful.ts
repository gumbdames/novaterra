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
 * Roadmap B1 (2026-10-02): the peaceful city score
 * (`peacefulScoreLines` — population × prosperity: treasury,
 * employment, desirability, ridership) with milestone helpers
 * (`newlyCrossedMilestones`, `milestoneToastLine`) and the
 * localStorage high score (`loadPeacefulBest` / `savePeacefulBest`).
 * The score is information only — endless mode has no victory
 * condition; the game.ts poll toasts milestones and records the best.
 *
 * Import discipline: value-imports sim/peaceful.ts (pure). The
 * MenuTabId type import from ui/palettes is type-only.
 */

import type { World } from '../sim/world';
import type { TerrainData } from '../sim/terrain';
import {
  peacefulStatus,
  peacefulScore,
  milestonesReached,
  PEACEFUL_MILESTONES,
} from '../sim/peaceful';
import { desirabilityOverlayData } from './desirability';
import type { MenuTabId } from './palettes';
import { STRINGS, loc, fillLoc, fill } from './strings';

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
 * Roadmap B18 (2026-10-02): per-tab color-identity class for the menu
 * rail buttons and the menu shell (`tab-civilian` green, `tab-military`
 * red, `tab-management` violet — the CSS `--tab-accent` hues). Pure so
 * the tab→class mapping stays headless-testable (hud.ts renders from
 * this).
 */
export function menuTabColorClass(id: MenuTabId): string {
  return id === 'civilian'
    ? 'tab-civilian'
    : id === 'military'
      ? 'tab-military'
      : 'tab-management';
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

/**
 * Roadmap B1 (2026-10-02): average residential desirability 0..100 for
 * the city score, from the cached derived model (the same data the
 * desirability overlay renders). 0 when there is no terrain (e.g.
 * headless tests) — the score treats it as "unknown", not "bad".
 */
export function avgDesirabilityOf(
  t: TerrainData | null | undefined,
  world: World,
  owner: number,
): number {
  const data = desirabilityOverlayData(t, world, owner);
  if (data.cells.length === 0) return 0;
  let sum = 0;
  for (const c of data.cells) sum += c.value;
  return sum / data.cells.length;
}

/** Display lines for the Management tab's peaceful score section. */
export interface PeacefulScoreLines {
  /** e.g. "City score: 12,450". */
  scoreLine: string;
  /** e.g. "Best score: 48,200" or "Best score: —". */
  bestLine: string;
}

/**
 * Player-facing peaceful score lines for one owner. The score is
 * information only — peaceful mode is endless (2026-10-01) and never
 * declares a winner; the "best" is the localStorage high score.
 */
export function peacefulScoreLines(
  world: World,
  owner: number,
  t: TerrainData | null | undefined,
  best: number | null,
): PeacefulScoreLines {
  const p = STRINGS.peaceful;
  const s = peacefulScore(world, owner, avgDesirabilityOf(t, world, owner));
  return {
    scoreLine: fillLoc(p.scoreLine, { score: formatCount(s.score) }),
    bestLine:
      best === null
        ? loc(p.bestNone)
        : fillLoc(p.bestLine, { score: formatCount(best) }),
  };
}

/**
 * Roadmap B1 (2026-10-02): which milestone indexes (into
 * PEACEFUL_MILESTONES / STRINGS.peaceful.milestoneNames) a score has
 * newly crossed, given the set the UI already toasted. Pure — the
 * controller holds the seen set per session.
 */
export function newlyCrossedMilestones(
  score: number,
  seen: ReadonlySet<number>,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < PEACEFUL_MILESTONES.length; i++) {
    // B27: no `!` — the loop bound keeps i in range; unreachable.
    const milestone = PEACEFUL_MILESTONES[i];
    if (milestone === undefined) continue;
    if (score >= milestone.threshold && !seen.has(i)) out.push(i);
  }
  return out;
}

/** The milestone toast line for a crossed milestone index. */
export function milestoneToastLine(index: number, score: number): string {
  const p = STRINGS.peaceful;
  const names = p.milestoneNames.en;
  // B27: no `!` — index is range-checked, so the access is defined; the
  // `??` keeps the `#n` fallback for out-of-range indexes, same as before.
  const name = names[index] ?? `#${index + 1}`;
  return fillLoc(p.milestoneToast, { name, score: formatCount(score) });
}

/** How many milestones exist — the UI-facing count of `milestonesReached`. */
export function milestoneCount(): number {
  return PEACEFUL_MILESTONES.length;
}

export { milestonesReached };

/**
 * Roadmap B1 (2026-10-02): the localStorage high score. Stored as JSON
 * `{ score, at }` under `novaterra.peacefulBestScore`. The storage is
 * injectable (tests) and guarded (no localStorage under Node) — never
 * throws.
 */
const PEACEFUL_BEST_KEY = 'novaterra.peacefulBestScore';

interface BestStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): BestStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** The recorded best score, or null when none is recorded yet. */
export function loadPeacefulBest(storage?: BestStorage | null): number | null {
  const s = storage ?? defaultStorage();
  if (s === null) return null;
  try {
    const raw = s.getItem(PEACEFUL_BEST_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { score?: unknown }).score === 'number'
    ) {
      const score = (parsed as { score: number }).score;
      return Number.isFinite(score) && score >= 0 ? Math.floor(score) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Record a score; returns true when it is a new best (and was stored).
 * Never throws — a full or hostile storage degrades to "no best".
 */
export function savePeacefulBest(
  score: number,
  storage?: BestStorage | null,
): boolean {
  const s = storage ?? defaultStorage();
  if (s === null) return false;
  const prev = loadPeacefulBest(s);
  if (prev !== null && score <= prev) return false;
  try {
    s.setItem(
      PEACEFUL_BEST_KEY,
      JSON.stringify({ score: Math.floor(score), at: new Date().toISOString() }),
    );
    return true;
  } catch {
    return false;
  }
}
