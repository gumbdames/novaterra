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
 * Stylesheet content tests (no live browser is available to the agent,
 * so the CSS contract is pinned by reading the source).
 *
 *  - `.hud-selection` (the 3-tab menu panel) is wide enough for its
 *    content but can never cause a horizontal scrollbar: it is capped
 *    to the viewport width with a narrow-screen media query.
 *  - `#menu .buttons` keeps its vertical-scroll rule (the skirmish
 *    setup must stay clickable on short viewports) — no regression.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'style.css'),
  'utf8',
);

/** Extract the declaration block for a selector (first match). */
function blockFor(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', idx);
  const close = css.indexOf('}', open);
  expect(open).toBeGreaterThan(idx);
  expect(close).toBeGreaterThan(open);
  return css.slice(open + 1, close);
}

describe('menu panel width', () => {
  it('.hud-selection is widened but viewport-capped (no h-scroll)', () => {
    const block = blockFor('.hud-selection');
    expect(block).toMatch(/width:\s*360px/);
    expect(block).toMatch(/max-width:\s*calc\(100vw - 24px\)/);
    expect(block).toMatch(/overflow-y:\s*auto/);
  });

  it('a narrow-viewport media query keeps the panel on-screen', () => {
    expect(css).toMatch(/@media\s*\(max-width:\s*700px\)/);
    const mq = css.slice(css.indexOf('@media (max-width: 700px)'));
    expect(mq).toMatch(/\.hud-selection/);
    expect(mq).toMatch(/max-width:\s*calc\(100vw - 16px\)/);
  });

  it('#menu .buttons keeps its vertical scroll (no regression)', () => {
    const block = blockFor('#menu .buttons');
    expect(block).toMatch(/overflow-y:\s*auto/);
  });
});
