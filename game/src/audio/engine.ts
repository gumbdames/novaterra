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
 * NOVATERRA — audio/engine.ts — the audio engine (0.1 Alpha).
 *
 * Owns the single lazily-created AudioContext (created on the first user
 * gesture per browser autoplay policy) and three buses:
 *
 *   sfxBus ──┐
 *   musicBus ─┼─→ masterGain ─→ destination
 *
 * Slider → gain mapping is quadratic (perceived loudness is logarithmic).
 * Pause = ctx.suspend() (freezes everything, zero CPU). Settings persist
 * to localStorage. Every public method is defensive: audio must never
 * break the game, so failures degrade to silence.
 *
 * UI-layer only: never imported by sim code, never affects determinism.
 * Headless tests import only the settings helpers + pure logic modules.
 */

import { createNoiseBuffer, playSfxCue, type SfxId } from './sfx';
import { MusicDirector, moodInputFromWorld, selectMood } from './music';
import type { World } from '../sim/world';

/** Persisted audio settings (localStorage, never leaves the browser). */
export interface AudioSettings {
  /** Master volume 0..1. */
  master: number;
  /** Music volume 0..1. */
  music: number;
  /** SFX volume 0..1. */
  sfx: number;
  /** Mute everything. */
  muted: boolean;
}

const AUDIO_SETTINGS_KEY = 'novaterra.audio.v1';

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  master: 0.8,
  music: 0.7,
  sfx: 0.8,
  muted: false,
};

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Load persisted audio settings, falling back to defaults. */
export function loadAudioSettings(): AudioSettings {
  try {
    const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<AudioSettings>;
      return {
        master: p.master === undefined ? DEFAULT_AUDIO_SETTINGS.master : clamp01(p.master),
        music: p.music === undefined ? DEFAULT_AUDIO_SETTINGS.music : clamp01(p.music),
        sfx: p.sfx === undefined ? DEFAULT_AUDIO_SETTINGS.sfx : clamp01(p.sfx),
        muted: p.muted === true,
      };
    }
  } catch {
    // Corrupt or unavailable storage — fall through to defaults.
  }
  return { ...DEFAULT_AUDIO_SETTINGS };
}

/** Persist audio settings. Silent no-op when storage is unavailable. */
export function saveAudioSettings(s: AudioSettings): void {
  try {
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode etc. — settings just don't persist.
  }
}

/** Perceived-loudness mapping: slider 0..1 → gain (quadratic). */
export function sliderToGain(slider: number): number {
  const c = clamp01(slider);
  return c * c;
}

/** Base URL for audio assets (Vite `base` aware, e.g. `/novaterra/`). */
function audioBaseUrl(): string {
  try {
    const base = import.meta.env.BASE_URL as string | undefined;
    if (typeof base === 'string' && base.length > 0) return base;
  } catch {
    // import.meta unavailable (tests) — fall through.
  }
  return '/';
}

/**
 * The audio engine. Construct once per game session; call `unlock()` from
 * a user-gesture handler (menu button click) to satisfy autoplay policy.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private director: MusicDirector | null = null;
  private settings: AudioSettings = loadAudioSettings();
  private disposed = false;
  /** Simple voice cap: drop SFX when too many play in one frame. */
  private voicesThisFrame = 0;
  private lastFrameTime = 0;

  /** Current settings (a copy). */
  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  /** True once unlock() has created the AudioContext. */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /**
   * Create the AudioContext and start music. Must be called from a user
   * gesture (click/tap). Safe to call repeatedly; subsequent calls resume
   * a suspended context.
   */
  unlock(): void {
    if (this.disposed) return;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext;
        if (typeof AC !== 'function') return; // No Web Audio — stay silent.
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
        this.musicBus = this.ctx.createGain();
        this.musicBus.connect(this.masterGain);
        this.sfxBus = this.ctx.createGain();
        this.sfxBus.connect(this.masterGain);
        this.noiseBuffer = createNoiseBuffer(this.ctx);
        this.director = new MusicDirector(this.ctx, this.musicBus, audioBaseUrl());
        this.applyVolumes();
      }
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => undefined);
      }
      this.director?.start();
    } catch {
      // Audio unavailable — the game plays silent.
      this.ctx = null;
    }
  }

  /** Update volumes/mute from settings; persists. */
  updateSettings(patch: Partial<AudioSettings>): void {
    this.settings = {
      master: patch.master === undefined ? this.settings.master : clamp01(patch.master),
      music: patch.music === undefined ? this.settings.music : clamp01(patch.music),
      sfx: patch.sfx === undefined ? this.settings.sfx : clamp01(patch.sfx),
      muted: patch.muted === undefined ? this.settings.muted : patch.muted === true,
    };
    saveAudioSettings(this.settings);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    try {
      if (!this.ctx || !this.masterGain || !this.musicBus || !this.sfxBus) return;
      const t = this.ctx.currentTime;
      const m = this.settings.muted ? 0 : sliderToGain(this.settings.master);
      // setTargetAtTime avoids clicks on slider drags.
      this.masterGain.gain.setTargetAtTime(m, t, 0.02);
      this.musicBus.gain.setTargetAtTime(
        this.settings.muted ? 0 : sliderToGain(this.settings.music), t, 0.02,
      );
      this.sfxBus.gain.setTargetAtTime(
        this.settings.muted ? 0 : sliderToGain(this.settings.sfx), t, 0.02,
      );
    } catch {
      // Ignore.
    }
  }

  /** Play one SFX cue. No-op until unlock(). */
  playSfx(id: SfxId): void {
    if (this.disposed || !this.ctx || !this.sfxBus || !this.noiseBuffer) return;
    if (this.settings.muted) return;
    // Per-frame voice cap keeps pathological bursts (e.g. 50 deaths in one
    // tick) from spawning hundreds of nodes.
    const now = this.ctx.currentTime;
    if (now !== this.lastFrameTime) {
      this.lastFrameTime = now;
      this.voicesThisFrame = 0;
    }
    if (this.voicesThisFrame >= 12) return;
    this.voicesThisFrame++;
    playSfxCue(this.ctx, this.sfxBus, this.noiseBuffer, id);
  }

  /**
   * Drive the adaptive music from sim state. Call ~2×/second from the
   * game loop; cheap (one scan of the unit list).
   */
  updateMusic(world: World, playerId: number): void {
    if (this.disposed || !this.director) return;
    try {
      const mood = selectMood(moodInputFromWorld(world, playerId));
      this.director.setMood(mood);
    } catch {
      // Ignore.
    }
  }

  /** Pause: suspend the context (zero CPU, everything freezes). */
  suspend(): void {
    try {
      if (this.ctx && this.ctx.state === 'running') {
        void this.ctx.suspend().catch(() => undefined);
      }
    } catch {
      // Ignore.
    }
  }

  /** Resume after pause. */
  resume(): void {
    try {
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => undefined);
      }
    } catch {
      // Ignore.
    }
  }

  /**
   * Play a click for any button inside `root`. Call once per screen;
   * returns a cleanup function.
   */
  bindUiClicks(root: HTMLElement): () => void {
    const onClick = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('button')) this.playSfx('click');
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.director?.dispose();
      this.director = null;
      if (this.ctx) {
        void this.ctx.close().catch(() => undefined);
        this.ctx = null;
      }
    } catch {
      // Ignore.
    }
    this.masterGain = this.musicBus = this.sfxBus = null;
    this.noiseBuffer = null;
  }
}
