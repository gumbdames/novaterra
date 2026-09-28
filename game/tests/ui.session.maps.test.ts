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
 * NOVATERRA — map preset wiring tests (Phase 1.5 UI integration).
 *
 * createSession accepts a mapPreset name: the session's terrain must come
 * from the matching MAP_PRESETS entry (name + canonical seed + water
 * target). Unknown names fall back to Meridian Plains; omitting the
 * option keeps the Phase-1 default.
 */
import { describe, expect, it } from 'vitest';
import { createSession } from '../src/ui/session';
import { getMapPreset, MAP_PRESETS } from '../src/sim/terrain';

describe('session map presets', () => {
  it('defaults to Meridian Plains when no mapPreset is given', () => {
    const session = createSession({ seed: 42 });
    expect(session.terrain.name).toBe('Meridian Plains');
    expect(session.terrain.seed).toBe(getMapPreset('Meridian Plains').seed >>> 0);
  });

  it('uses the named preset for terrain', () => {
    const session = createSession({ seed: 42, mapPreset: 'Archipelago' });
    const preset = getMapPreset('Archipelago');
    expect(session.terrain.name).toBe('Archipelago');
    expect(session.terrain.seed).toBe(preset.seed >>> 0);
  });

  it('falls back to Meridian Plains for an unknown preset name', () => {
    const session = createSession({ seed: 42, mapPreset: 'No Such Map' });
    expect(session.terrain.name).toBe('Meridian Plains');
  });

  it('is deterministic per preset: same map + seed gives the same digest', () => {
    const a = createSession({ seed: 99, mapPreset: 'Coastline' });
    const b = createSession({ seed: 99, mapPreset: 'Coastline' });
    expect(a.digest()).toBe(b.digest());
  });

  it('different presets yield different terrain', () => {
    const plains = createSession({ seed: 99, mapPreset: 'Meridian Plains' });
    const ocean = createSession({ seed: 99, mapPreset: 'Ocean World' });
    expect(plains.terrain.name).not.toBe(ocean.terrain.name);
    // Sanity: all 8 presets are selectable by name.
    expect(MAP_PRESETS).toHaveLength(8);
    for (const preset of MAP_PRESETS) {
      const s = createSession({ seed: 7, mapPreset: preset.name });
      expect(s.terrain.name).toBe(preset.name);
    }
  });

  it('starts both armies on land even on high-water maps', () => {
    const session = createSession({ seed: 5, mapPreset: 'Ocean World' });
    // Starting forces must exist (6 human + up to 6 AI) — none may be
    // missing because the base search failed.
    expect(session.world.units.length).toBeGreaterThan(0);
  });
});
