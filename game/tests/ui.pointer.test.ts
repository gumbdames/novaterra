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
 * NOVATERRA — pointer-gesture classification tests (0.1 Alpha).
 *
 * `classifyPointerUp` (ui/pointer.ts) decides whether a released pointer
 * gesture is a click, a drag, or ignorable. The click rule is anchored on
 * the PRESS: a primary-button press that started on the canvas and moved
 * at most CLICK_JITTER_PX is a click even when the release target is not
 * the canvas (synthetic events, sub-pixel HUD-edge drift).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyPointerUp,
  CLICK_JITTER_PX,
  type PointerUpGesture,
} from '../src/ui/pointer';

function gesture(partial: Partial<PointerUpGesture>): PointerUpGesture {
  return {
    dragStart: { x: 100, y: 100 },
    upX: 100,
    upY: 100,
    button: 0,
    targetIsCanvas: true,
    ...partial,
  };
}

describe('classifyPointerUp', () => {
  it('classifies a clean press-release on the canvas as a click', () => {
    expect(classifyPointerUp(gesture({}))).toBe('click');
  });

  it('classifies sub-jitter movement as a click (pointer jitter is not a drag)', () => {
    expect(
      classifyPointerUp(gesture({ upX: 100 + CLICK_JITTER_PX - 1, upY: 103 })),
    ).toBe('click');
    expect(
      classifyPointerUp(gesture({ upX: 100, upY: 100 - CLICK_JITTER_PX })),
    ).toBe('click');
  });

  it('classifies movement past the jitter threshold as a drag', () => {
    expect(
      classifyPointerUp(gesture({ upX: 100 + CLICK_JITTER_PX + 1, upY: 100 })),
    ).toBe('drag');
    expect(classifyPointerUp(gesture({ upX: 300, upY: 400 }))).toBe('drag');
  });

  it('counts a press as a click even when the release target is not the canvas', () => {
    // Synthetic/automated events and sub-pixel drift onto a HUD edge can
    // report a different target; the press started on the canvas, so it is
    // still a click. (This was the silent no-op: the old strict
    // `e.target === canvas` gate swallowed these.)
    expect(classifyPointerUp(gesture({ targetIsCanvas: false }))).toBe(
      'click',
    );
    expect(
      classifyPointerUp(gesture({ targetIsCanvas: false, upX: 102, upY: 99 })),
    ).toBe('click');
  });

  it('ignores a release when the press never started on the canvas', () => {
    expect(classifyPointerUp(gesture({ dragStart: null }))).toBe('ignore');
    expect(
      classifyPointerUp(gesture({ dragStart: null, targetIsCanvas: false })),
    ).toBe('ignore');
  });

  it('ignores non-primary buttons', () => {
    expect(classifyPointerUp(gesture({ button: 1 }))).toBe('ignore');
    expect(classifyPointerUp(gesture({ button: 2 }))).toBe('ignore');
  });

  it('classifies a large move with a foreign release target as a drag, not a click', () => {
    expect(
      classifyPointerUp(
        gesture({ upX: 500, upY: 500, targetIsCanvas: false }),
      ),
    ).toBe('drag');
  });
});
