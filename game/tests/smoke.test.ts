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
 * NOVATERRA — scaffold smoke tests.
 *
 * These prove the two things Phase 1 step 1 must guarantee:
 *  1. The entry module imports cleanly with no DOM and no GPU (vitest runs
 *     in Node) — i.e. renderer creation is correctly deferred to boot().
 *  2. Game identity constants are present and well-formed.
 *
 * Per the repo step gate (AGENTS.md §2), every later step re-runs these.
 */
import { describe, expect, it } from 'vitest';

import { GAME_TAGLINE, GAME_TITLE, GAME_VERSION } from '../src/config';
import { boot } from '../src/main';

describe('scaffold smoke', () => {
  it('exposes game identity constants', () => {
    expect(GAME_TITLE).toBe('NOVATERRA');
    expect(GAME_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(GAME_TAGLINE.length).toBeGreaterThan(0);
  });

  it('main module imports cleanly under Node and exports boot', () => {
    // If the static import graph touched the DOM or GPU, this import
    // itself would have thrown before we got here.
    expect(typeof boot).toBe('function');
  });
});
