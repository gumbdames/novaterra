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
 * Map preset tests (Phase 1.5, component 4/5).
 *
 * Covers: 8 deterministic presets, water coverage variance (5%–60%),
 * seed determinism, and preset lookup.
 */

import { describe, expect, it } from 'vitest';
import {
  MAP_PRESETS,
  getMapPreset,
  generateTerrain,
  isWater,
  heightAt,
} from '../src/sim/terrain';

describe('map presets', () => {
  it('has exactly 8 presets', () => {
    expect(MAP_PRESETS).toHaveLength(8);
  });

  it('water coverage spans 5% to 60%', () => {
    const fractions = MAP_PRESETS.map((p) => p.waterTargetFraction);
    expect(Math.min(...fractions)).toBe(0.05);
    expect(Math.max(...fractions)).toBe(0.60);
  });

  it('all presets have unique names and seeds', () => {
    const names = new Set(MAP_PRESETS.map((p) => p.name));
    const seeds = new Set(MAP_PRESETS.map((p) => p.seed));
    expect(names.size).toBe(8);
    expect(seeds.size).toBe(8);
  });

  it('getMapPreset finds by name, defaults to Meridian Plains', () => {
    expect(getMapPreset('Archipelago').name).toBe('Archipelago');
    expect(getMapPreset('Nonexistent').name).toBe('Meridian Plains');
  });

  it('generating the same preset twice is deterministic', () => {
    const preset = getMapPreset('Lake Country');
    const t1 = generateTerrain(preset.seed, preset);
    const t2 = generateTerrain(preset.seed, preset);
    // Sample a few heights; they must match exactly.
    for (const [x, z] of [[0, 0], [100, -50], [-200, 150]] as const) {
      expect(heightAt(t1, x, z)).toBe(heightAt(t2, x, z));
    }
  });

  it('higher water presets produce more water cells', () => {
    const low = getMapPreset('Meridian Plains');
    const high = getMapPreset('Ocean World');
    const tLow = generateTerrain(low.seed, low);
    const tHigh = generateTerrain(high.seed, high);
    // Count water in a coarse grid sample.
    let lowWater = 0;
    let highWater = 0;
    const samples = 50;
    for (let i = 0; i < samples; i++) {
      for (let j = 0; j < samples; j++) {
        const x = -256 + (512 * i) / samples;
        const z = -256 + (512 * j) / samples;
        if (isWater(tLow, x, z)) lowWater++;
        if (isWater(tHigh, x, z)) highWater++;
      }
    }
    // Ocean World (60%) should have substantially more water than Meridian (5%).
    expect(highWater).toBeGreaterThan(lowWater * 3);
  });
});
