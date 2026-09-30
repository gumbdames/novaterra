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
 * NOVATERRA — zone-tool clarity tests (Workstream Z).
 *
 * The zone tools say what they paint ("Zone: Homes" / "Zone: Shops" /
 * "Zone: Industry"), and the build palette groups them under a static
 * "Zoning" section header.
 */
import { describe, expect, it } from 'vitest';

import { STRINGS, loc, setUiLanguage } from '../src/ui/strings';

describe('zone tools', () => {
  it('labels say what they paint', () => {
    setUiLanguage('en');
    expect(loc(STRINGS.palettes.toolZoneR)).toBe('Zone: Homes');
    expect(loc(STRINGS.palettes.toolZoneC)).toBe('Zone: Shops');
    expect(loc(STRINGS.palettes.toolZoneI)).toBe('Zone: Industry');
  });

  it('exposes the "Zoning" section header string', () => {
    setUiLanguage('en');
    expect(loc(STRINGS.palettes.toolSectionZoning)).toBe('Zoning');
  });
});
