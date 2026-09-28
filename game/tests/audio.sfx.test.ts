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
 * NOVATERRA — SFX cue definition tests (Phase 1, step 10).
 *
 * The cue patches are pure data; these tests pin the full SFX roster and
 * validate every layer's parameters are sane (positive durations, gains
 * in range, known oscillator/filter types). Actual Web Audio synthesis
 * (`playSfxCue`) is not tested here — no Web Audio in Node.
 */
import { describe, expect, it } from 'vitest';
import { ALL_SFX_IDS, SFX_CUES, type SfxId } from '../src/audio/sfx';

/** Every game event that should make a sound (0.1 Alpha roster). */
const EXPECTED_IDS: SfxId[] = [
  'click',
  'select',
  'moveOrder',
  'attackOrder',
  'place',
  'buildComplete',
  'shot',
  'explosion',
  'unitDown',
  'ageFanfare',
  'error',
  'advisorPing',
];

const VALID_WAVES = new Set(['sine', 'square', 'sawtooth', 'triangle']);
const VALID_FILTERS = new Set(['lowpass', 'highpass', 'bandpass', 'notch']);

describe('SFX cue roster', () => {
  it('defines every expected cue id exactly once', () => {
    expect([...ALL_SFX_IDS].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('keys each cue record by its own id', () => {
    for (const id of ALL_SFX_IDS) {
      expect(SFX_CUES[id].id).toBe(id);
    }
  });
});

describe('SFX cue patches', () => {
  for (const id of EXPECTED_IDS) {
    it(`'${id}' has at least one valid layer`, () => {
      const cue = SFX_CUES[id];
      expect(cue.layers.length).toBeGreaterThan(0);
      for (const layer of cue.layers) {
        expect(layer.duration).toBeGreaterThan(0);
        expect(layer.duration).toBeLessThanOrEqual(2);
        expect(layer.gain).toBeGreaterThan(0);
        expect(layer.gain).toBeLessThanOrEqual(1);
        expect(layer.delay).toBeGreaterThanOrEqual(0);
        expect(layer.freqStart).toBeGreaterThan(0);
        expect(layer.freqEnd).toBeGreaterThan(0);
        if (layer.kind === 'tone') {
          expect(VALID_WAVES.has(layer.wave ?? 'sine')).toBe(true);
        } else {
          expect(VALID_FILTERS.has(layer.filter ?? 'lowpass')).toBe(true);
        }
      }
    });
  }

  it('keeps total cue length under 2 seconds (no runaway envelopes)', () => {
    for (const id of ALL_SFX_IDS) {
      const cue = SFX_CUES[id];
      const total = Math.max(...cue.layers.map((l) => l.delay + l.duration));
      expect(total).toBeLessThanOrEqual(2);
    }
  });
});
