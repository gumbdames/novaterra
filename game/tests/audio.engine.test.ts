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
 * NOVATERRA — audio engine settings tests (Phase 1, step 10).
 *
 * Covers the pure/testable surface: slider→gain mapping, settings
 * persistence (with a localStorage stub — no DOM in these tests), and
 * defaults. The `AudioEngine` class itself needs Web Audio and is not
 * constructed here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS,
  loadAudioSettings,
  saveAudioSettings,
  sliderToGain,
} from '../src/audio/engine';

/** Minimal localStorage stub for Node. */
function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sliderToGain', () => {
  it('maps 0 → 0 and 1 → 1', () => {
    expect(sliderToGain(0)).toBe(0);
    expect(sliderToGain(1)).toBe(1);
  });

  it('is quadratic (perceived loudness)', () => {
    expect(sliderToGain(0.5)).toBeCloseTo(0.25, 10);
  });

  it('clamps out-of-range and non-finite input', () => {
    expect(sliderToGain(-0.5)).toBe(0);
    expect(sliderToGain(1.5)).toBe(1);
    expect(sliderToGain(NaN)).toBe(0);
    expect(sliderToGain(Infinity)).toBe(1);
  });
});

describe('audio settings persistence', () => {
  it('returns defaults when nothing is stored', () => {
    stubLocalStorage();
    expect(loadAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('round-trips through save/load', () => {
    stubLocalStorage();
    saveAudioSettings({ master: 0.5, music: 0.3, sfx: 0.9, muted: true });
    expect(loadAudioSettings()).toEqual({ master: 0.5, music: 0.3, sfx: 0.9, muted: true });
  });

  it('clamps invalid values on load', () => {
    const store = stubLocalStorage();
    store.set('novaterra.audio.v1', JSON.stringify({ master: 5, music: -1, sfx: NaN, muted: 'yes' }));
    const loaded = loadAudioSettings();
    expect(loaded.master).toBe(1);
    expect(loaded.music).toBe(0);
    expect(loaded.sfx).toBe(0);
    expect(loaded.muted).toBe(false);
  });

  it('falls back to defaults on corrupt JSON', () => {
    const store = stubLocalStorage();
    store.set('novaterra.audio.v1', 'not-json{{{');
    expect(loadAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
  });

  it('falls back to defaults when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(loadAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
    // save must not throw either
    expect(() => saveAudioSettings(DEFAULT_AUDIO_SETTINGS)).not.toThrow();
  });
});
