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
 * NOVATERRA — English-only UI tests.
 *
 * The shipped game is English and English-only (2026-09-30 directive).
 * These tests pin the default/only language and fail if Hebrew text ever
 * lands in shipped source. The localization indirection (`LocalizedString`
 * / `loc` / `fillLoc`) stays in place as the extension point for future
 * languages — see `docs/I18N.md`.
 */
import { describe, expect, it } from 'vitest';
// node builtins (ambient declarations in i18n-shim.d.ts — tsconfig has
// `types: []` and @types/node is not a dependency).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  STRINGS,
  fillLoc,
  getUiLanguage,
  loc,
  setUiLanguage,
} from '../src/ui/strings';

const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HEBREW = /[\u0590-\u05FF]/;

// Trees the no-Hebrew smoke test walks. docs/ is out of scope: docs/research
// keeps historical Hebrew-first design notes on purpose, and player docs are
// audited by hand.
const SCAN_ROOTS = ['src', 'index.html', 'package.json'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'public']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|css|html|json)$/;

function collectTextFiles(root: string, out: string[] = []): string[] {
  const st = statSync(root);
  if (!st.isDirectory()) {
    if (TEXT_EXT.test(root)) out.push(root);
    return out;
  }
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue;
    collectTextFiles(join(root, name), out);
  }
  return out;
}

describe('english-only UI', () => {
  it('defaults to English as the only shipped language', () => {
    setUiLanguage('en');
    expect(getUiLanguage()).toBe('en');
    expect(loc(STRINGS.unitNames.tank)).toBe('Main Battle Tank');
    expect(loc(STRINGS.palettes.cancelPlacement)).toBe('Cancel (Esc)');
  });

  it('fillLoc interpolates the English template', () => {
    setUiLanguage('en');
    expect(fillLoc(STRINGS.palettes.requiresAge, { age: 'Industry' })).toBe(
      'Requires the Industry age',
    );
  });

  it('shipped source contains no Hebrew text', () => {
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectTextFiles(join(GAME_DIR, root))) {
        if (HEBREW.test(readFileSync(file, 'utf8'))) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
