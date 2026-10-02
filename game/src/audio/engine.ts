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
 *
 * Final-review R5 (2026-10-01): positional SFX via per-play equal-power
 * panners (the research doc's "3D positional" promise), a procedural
 * ambient city bed under the music bus, war-mood hysteresis driven by
 * the game loop's MoodTracker, and a hard drop (never queue) while the
 * context isn't running — paused-menu clicks no longer burst on resume.
 */

import { createNoiseBuffer, playSfxCue, type SfxId } from './sfx';
import { MusicDirector, type MusicMood } from './music';

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

/** Ambient bed loop length in seconds (baked crossfade at the seam). */
const AMBIENT_BED_SECONDS = 8;
/** Bed level under the peace track (subtle — garnish, not foreground). */
const AMBIENT_BED_PEACE = 0.05;
/** Bed level under the war track (ducks so combat reads). */
const AMBIENT_BED_WAR = 0.02;

/**
 * Build the ambient city bed buffer (roadmap B21, 2026-10-02: richer
 * layered bed — was mono brown noise + hum). Now stereo, three layers:
 *  - deep brown-ish rumble (distant traffic/wind) with a slow swell;
 *  - brighter airy noise ("city air") with its own independent swell —
 *    the two channels use different seeds/phases so the bed has gentle
 *    stereo movement;
 *  - the soft low sine city hum (55Hz + 110Hz), slightly detuned per
 *    channel.
 * The last second of each channel crossfades into its first so the loop
 * seam is inaudible. Deterministic fill (fixed seeds) — UI-layer only,
 * but stable behavior is free.
 */
function createAmbientBedBuffer(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * AMBIENT_BED_SECONDS);
  const buffer = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let seed = 0x51ab3c7d + ch * 0x9e3779b9;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };
    // Brown-ish noise via leaky integrators (deep + airy layers).
    let low = 0;
    let air = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      low = (low + 0.02 * rand()) / 1.02;
      air = (air + 0.09 * rand()) / 1.09;
      const swell =
        0.6 + 0.4 * Math.sin((2 * Math.PI * t) / AMBIENT_BED_SECONDS * 2 + ch * 2.1);
      const activity =
        0.5 +
        0.5 * Math.sin((2 * Math.PI * t) / AMBIENT_BED_SECONDS * 3 + ch * 1.2 + 0.7);
      const hum =
        0.15 * Math.sin(2 * Math.PI * 55 * t + ch * 0.4) +
        0.08 * Math.sin(2 * Math.PI * 110 * t + 1.3);
      data[i] = (low * 2.2 * swell + air * 0.45 * activity + hum * 0.35) * 0.8;
    }
    // Seam crossfade: blend the last second into the first.
    const fade = Math.min(rate, len);
    for (let i = 0; i < fade; i++) {
      const a = i / fade;
      const j = len - fade + i;
      // B27: no `!` — i, j < len by construction.
      const blended = (data[i] ?? 0) * a + (data[j] ?? 0) * (1 - a);
      data[j] = blended;
    }
  }
  return buffer;
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
  /** Ambient city bed nodes (started on demand, in-game only). */
  private bedSource: AudioBufferSourceNode | null = null;
  private bedGain: GainNode | null = null;

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
  playSfx(id: SfxId, pos?: { x: number; z: number }): void {
    if (this.disposed || !this.ctx || !this.sfxBus || !this.noiseBuffer) return;
    if (this.settings.muted) return;
    // Final-review L5 (2026-10-01): never queue playback while the
    // context isn't running (paused menu clicks, background tab) —
    // scheduled sources would pile up on the frozen clock and burst
    // late on resume. Drop instead.
    if (this.ctx.state !== 'running') return;
    // Per-frame voice cap keeps pathological bursts (e.g. 50 deaths in one
    // tick) from spawning hundreds of nodes.
    const now = this.ctx.currentTime;
    if (now !== this.lastFrameTime) {
      this.lastFrameTime = now;
      this.voicesThisFrame = 0;
    }
    if (this.voicesThisFrame >= 12) return;
    this.voicesThisFrame++;
    // Positional (docs/research/audio.md §3.1): an equal-power panner
    // between the cue and the sfx bus gives cheap stereo panning +
    // distance attenuation. UI cues (click/select/orders) stay
    // non-positional by passing no position.
    if (pos !== undefined) {
      const panner = this.ctx.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 60;
      panner.maxDistance = 500;
      panner.rolloffFactor = 1;
      try {
        panner.positionX.value = pos.x;
        panner.positionY.value = 0;
        panner.positionZ.value = pos.z;
      } catch {
        // Older implementations: ignore, keep the cue non-positional.
        playSfxCue(this.ctx, this.sfxBus, this.noiseBuffer, id);
        return;
      }
      panner.connect(this.sfxBus);
      playSfxCue(this.ctx, panner, this.noiseBuffer, id);
      // The one-shot sources release themselves; the panner is garbage
      // once its inputs end (no explicit disconnect needed — the graph
      // is dropped with the ended sources).
      return;
    }
    playSfxCue(this.ctx, this.sfxBus, this.noiseBuffer, id);
  }

  /**
   * Set the adaptive-music mood (driven by the game loop's MoodTracker,
   * which owns the hysteresis). The ambient bed's level follows the
   * mood: the city hum sits under peace and ducks under war.
   */
  setMusicMood(mood: MusicMood): void {
    if (this.disposed) return;
    try {
      this.director?.setMood(mood);
      if (this.bedGain && this.ctx) {
        const level = mood === 'peace' ? AMBIENT_BED_PEACE : AMBIENT_BED_WAR;
        this.bedGain.gain.setTargetAtTime(level, this.ctx.currentTime, 1.0);
      }
    } catch {
      // Ignore.
    }
  }

  /**
   * Move the audio listener to the camera target (world x/z). Called
   * per frame by the game loop; positional SFX pan/attenuate relative
   * to where the player is looking.
   */
  updateListener(x: number, z: number): void {
    if (this.disposed || !this.ctx) return;
    if (this.ctx.state !== 'running') return;
    try {
      const l = this.ctx.listener;
      // Slight height so the listener sits above the battlefield plane.
      if (l.positionX !== undefined) {
        l.positionX.value = x;
        l.positionY.value = 20;
        l.positionZ.value = z;
      } else {
        // Legacy setPosition fallback.
        (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, 20, z);
      }
    } catch {
      // Ignore.
    }
  }

  /**
   * Start the ambient city bed: a subtle looped procedural hum (shaped
   * noise + soft low partials) under the music bus, so master/music
   * volume and mute apply. Pause-aware for free — ctx.suspend() freezes
   * the loop like everything else. Call once per game session after
   * unlock(); the main menu never starts it (no city there yet).
   */
  startAmbientBed(): void {
    if (this.disposed || !this.ctx || !this.musicBus || this.bedSource !== null) return;
    try {
      const ctx = this.ctx;
      const buffer = createAmbientBedBuffer(ctx);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      const gain = ctx.createGain();
      gain.gain.value = 0; // faded in below
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.musicBus);
      src.start();
      this.bedSource = src;
      this.bedGain = gain;
      gain.gain.setTargetAtTime(AMBIENT_BED_PEACE, ctx.currentTime, 2.0);
    } catch {
      // The bed is garnish — silence is acceptable.
      this.bedSource = null;
      this.bedGain = null;
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
      try {
        this.bedSource?.stop();
      } catch {
        // Already stopped — ignore.
      }
      this.bedSource = null;
      this.bedGain = null;
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
