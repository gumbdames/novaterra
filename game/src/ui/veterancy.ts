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
 * NOVATERRA — ui/veterancy.ts — veterancy display helpers (Phase 1).
 *
 * Responsibilities:
 *  - Player-facing veterancy text for the selection panel: rank name +
 *    chevron glyphs + XP progress toward the next threshold, e.g.
 *    "Veteran ▲▲ · 320/500 XP".
 *  - All copy flows through the `loc()` / `fillLoc()` machinery in
 *    ui/strings.ts (English-only in 0.1 Alpha, localizable later).
 *
 * The XP thresholds are the sim's `VET_XP_THRESHOLDS`
 * (sim/veterancy.ts) — the single source of truth; this module only
 * formats. Rank-name copy lives in `STRINGS.veterancy.ranks` and is
 * pinned equal to the sim's `VET_RANK_NAMES` by test.
 *
 * Pure module: no DOM, no three.js. Safe under Node/vitest.
 */

import { VET_XP_THRESHOLDS } from '../sim/veterancy';
import type { UnitRecord } from '../sim/units';
import { STRINGS, fillLoc, loc } from './strings';

/** Clamp a raw level to the 0..3 band the display knows. */
export function clampVetLevel(level: number): number {
  return Math.max(0, Math.min(3, Math.floor(level)));
}

/** Rank display name for a veterancy level (0..3), via the loc machinery. */
export function vetRankLabel(level: number): string {
  return loc(STRINGS.veterancy.ranks[clampVetLevel(level)]!);
}

/** Chevron glyphs for a level: '▲'.repeat(level) ('' for Recruit). */
export function vetChevronGlyphs(level: number): string {
  return '▲'.repeat(clampVetLevel(level));
}

/**
 * One-line veterancy summary for a selected unit:
 * "Veteran ▲▲ · 320/500 XP". Elite (no next threshold) shows the total:
 * "Elite ▲▲▲ · 1240 XP".
 */
export function vetXpLine(u: UnitRecord): string {
  const level = clampVetLevel(u.vetLevel ?? 0);
  const xp = Math.max(0, Math.round(u.xp ?? 0));
  const rank = vetRankLabel(level);
  const chevrons = vetChevronGlyphs(level);
  // No chevrons at Recruit: "Recruit · 0/200 XP", not "Recruit  · …".
  const rankPart = chevrons.length > 0 ? `${rank} ${chevrons}` : rank;
  if (level >= VET_XP_THRESHOLDS.length) {
    return fillLoc(STRINGS.veterancy.xpElite, { rank: rankPart, xp });
  }
  const next = VET_XP_THRESHOLDS[level]!;
  return fillLoc(STRINGS.veterancy.xpProgress, { rank: rankPart, xp, next });
}
