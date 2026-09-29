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
 * NOVATERRA — ui/pointer.ts — pointer-gesture classification (pure).
 *
 * The game controller's `pointerup` handler (game.ts `bindInput`) funnels
 * through `classifyPointerUp` to decide whether the released gesture was a
 * click (map action: select / place / context order), a drag (box-select or
 * road/zone paint), or something to ignore (no press started on the canvas,
 * non-primary button).
 *
 * The click rule is deliberately anchored on the PRESS, not the release:
 * a press that started on the canvas with the primary button and moved no
 * more than CLICK_JITTER_PX counts as a click even if the release event's
 * target is not the canvas (synthetic/automated events, sub-pixel drift
 * onto a HUD edge). The release-target check this replaces silently
 * swallowed real clicks in some environments; a ≤6px press-release can
 * never meaningfully land on a HUD control anyway.
 *
 * Headless-safe: no DOM, no three.js. Fully unit-tested.
 */

/** Max pointer travel (client px) that still counts as a click, not a drag. */
export const CLICK_JITTER_PX = 6;

export interface PointerUpGesture {
  /** Press origin in client px; null when the press never started on the canvas. */
  dragStart: { x: number; y: number } | null;
  /** Release position in client px. */
  upX: number;
  upY: number;
  /** Mouse button at release: 0 = primary. */
  button: number;
  /** True when the release event's target was the game canvas. */
  targetIsCanvas: boolean;
}

export type PointerUpClass = 'click' | 'drag' | 'ignore';

/**
 * Classify a released pointer gesture. Pure: no DOM access, no side effects.
 *
 * - 'ignore': the press didn't start on the canvas (dragStart null — e.g.
 *   the press began on a HUD panel) or the button isn't the primary one.
 * - 'drag': the pointer travelled past CLICK_JITTER_PX — the controller's
 *   box-select / road-drag paths own this gesture (checked before this).
 * - 'click': a clean primary-button press-release on the map.
 */
export function classifyPointerUp(g: PointerUpGesture): PointerUpClass {
  if (g.dragStart === null) return 'ignore';
  if (g.button !== 0) return 'ignore';
  const moved = Math.hypot(g.upX - g.dragStart.x, g.upY - g.dragStart.y);
  if (moved > CLICK_JITTER_PX) return 'drag';
  return 'click';
}
