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
 * NOVATERRA — ui/luminaries.ts — the luminary UI contract module (pure).
 *
 * Fun-audit Tier 4 (E2, 2026-10-02): the UI/render boundary for the
 * luminary ceremony (`sim/luminaries.ts`, state on `world.luminaries`).
 * The decision card (hud.ts) and the game.ts narration poll read the sim
 * only through this module — never the records directly.
 *
 * What it mirrors (single source of truth stays in the sim):
 *  - Card visibility: a pending decision for the owner.
 *  - The card id + its choices (ids only — labels/hints come from
 *    STRINGS.luminaries, keyed `cardId` / `cardId:choiceId`).
 *  - The decision countdown: whole seconds left of `deadlineTick` —
 *    the card repaints on the second boundary, not every frame.
 *  - The guest unit id (for the map ping / gold ring).
 *  - Active effect badges: streamline upkeep cut, buried/leaking
 *    cover-up, live production marks (for the Management status area).
 *
 * Defensive: every read tolerates hand-built worlds (missing or
 * malformed luminary state ⇒ null / hidden), so the contract test can
 * feed minimal fixtures.
 */
import type { World } from '../sim/world';
import { luminaryCardById } from '../sim/luminaries';

/** Everything the decision card needs for one repaint. */
export interface LuminaryCardView {
  cardId: string;
  /** Choice ids in card order. */
  choices: string[];
  /** The default choice (applied on timeout). */
  defaultChoiceId: string;
  /** Whole seconds left on the decision window. */
  secondsLeft: number;
  /** The guest unit's id (for the map ping). */
  unitId: number;
}

/**
 * The decision card view for the player, or null when no luminary
 * awaits their decision. Pure: no DOM, no sim mutation.
 */
export function luminaryCardView(world: World, owner: number): LuminaryCardView | null {
  const lum = world?.luminaries;
  const pending = lum?.pending ?? null;
  if (pending === null) return null;
  if (pending.owner !== owner) return null;
  const card = luminaryCardById(pending.cardId);
  if (!card) return null;
  const secondsLeft = Math.max(
    0,
    Math.ceil((pending.deadlineTick - world.tick) / 30),
  );
  return {
    cardId: card.id,
    choices: card.choices.map((c) => c.id),
    defaultChoiceId: card.defaultChoiceId,
    secondsLeft,
    unitId: pending.unitId,
  };
}

/** Active luminary effect badges for the status area (all optional). */
export interface LuminaryBadges {
  /** Seconds left on the Prodigy's −25% upkeep cut (null when inactive). */
  upkeepCutSecs: number | null;
  /** True while a Whistleblower cover-up is buried, awaiting the leak. */
  coverUpPending: boolean;
  /** Number of live Defector production marks. */
  productionMarks: number;
  /** Named drill instructors currently teaching. */
  instructors: string[];
}

/** The badge view for the player. Pure. */
export function luminaryBadges(world: World, owner: number): LuminaryBadges {
  const lum = world?.luminaries;
  const empty: LuminaryBadges = {
    upkeepCutSecs: null,
    coverUpPending: false,
    productionMarks: 0,
    instructors: [],
  };
  if (!lum) return empty;
  // Effects are player-side only in 0.1 Alpha (owner 0); badges for
  // another owner would be a lie.
  if (owner !== 0) return empty;
  const upkeepCutSecs =
    lum.upkeepCutUntilTick > world.tick
      ? Math.ceil((lum.upkeepCutUntilTick - world.tick) / 30)
      : null;
  return {
    upkeepCutSecs,
    coverUpPending: lum.coverUp !== null,
    productionMarks: lum.productionMarks.length,
    instructors: lum.instructors
      .filter((i) => i.owner === owner && i.name.length > 0)
      .map((i) => i.name),
  };
}
