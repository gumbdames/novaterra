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
 * NOVATERRA — audio/sfx.ts — procedural sound-effect synthesizer (0.1 Alpha).
 *
 * All SFX are synthesized with raw Web Audio (oscillators + filtered noise):
 * zero download cost, guaranteed availability, and full parameter control.
 * Each cue is a small declarative "patch" — a list of tone/noise layers —
 * so the definitions below are pure data and fully unit-testable. The
 * actual synthesis (`playSfxCue`) is the only part that touches Web Audio.
 *
 * UI-layer only: never imported by sim code, never affects determinism.
 */

/** Every playable sound effect in the game. */
export type SfxId =
  | 'click' // UI button press
  | 'select' // unit/building selected
  | 'moveOrder' // move order acknowledged
  | 'attackOrder' // attack order acknowledged
  | 'place' // building/road/zone placed
  | 'buildComplete' // construction finished
  | 'shot' // distant weapon fire
  | 'explosion' // building/unit destroyed
  | 'unitDown' // a player unit dies
  | 'ageFanfare' // age advancement
  | 'error' // invalid action / rejection
  | 'advisorPing'; // advisor has a new top problem

/** One synthesized layer inside a cue. */
export interface SfxLayer {
  /** 'tone' = oscillator, 'noise' = filtered white noise. */
  kind: 'tone' | 'noise';
  /** Oscillator type (tone only). */
  wave?: OscillatorType;
  /** Start frequency in Hz (tone: oscillator freq; noise: filter freq). */
  freqStart: number;
  /** End frequency in Hz (exponential ramp; use same value for constant). */
  freqEnd: number;
  /** Peak gain 0..1. */
  gain: number;
  /** Total duration in seconds. */
  duration: number;
  /** Delay before the layer starts, in seconds. */
  delay: number;
  /** Filter type for noise layers. */
  filter?: BiquadFilterType;
}

/** A complete SFX cue: one or more layers played together. */
export interface SfxCue {
  id: SfxId;
  layers: SfxLayer[];
}

/** Declarative patch for every SFX. Pure data — safe to import in tests. */
export const SFX_CUES: Record<SfxId, SfxCue> = {
  click: {
    id: 'click',
    layers: [
      { kind: 'tone', wave: 'sine', freqStart: 880, freqEnd: 660, gain: 0.25, duration: 0.05, delay: 0 },
    ],
  },
  select: {
    id: 'select',
    layers: [
      { kind: 'tone', wave: 'sine', freqStart: 660, freqEnd: 660, gain: 0.22, duration: 0.06, delay: 0 },
      { kind: 'tone', wave: 'sine', freqStart: 880, freqEnd: 880, gain: 0.22, duration: 0.08, delay: 0.06 },
    ],
  },
  moveOrder: {
    id: 'moveOrder',
    layers: [
      { kind: 'tone', wave: 'triangle', freqStart: 520, freqEnd: 520, gain: 0.28, duration: 0.09, delay: 0 },
    ],
  },
  attackOrder: {
    id: 'attackOrder',
    layers: [
      { kind: 'tone', wave: 'square', freqStart: 440, freqEnd: 440, gain: 0.16, duration: 0.07, delay: 0 },
      { kind: 'tone', wave: 'square', freqStart: 330, freqEnd: 330, gain: 0.16, duration: 0.09, delay: 0.07 },
    ],
  },
  place: {
    id: 'place',
    layers: [
      { kind: 'tone', wave: 'sine', freqStart: 130, freqEnd: 90, gain: 0.4, duration: 0.14, delay: 0 },
      { kind: 'noise', filter: 'lowpass', freqStart: 500, freqEnd: 200, gain: 0.2, duration: 0.1, delay: 0 },
    ],
  },
  buildComplete: {
    id: 'buildComplete',
    layers: [
      { kind: 'tone', wave: 'sine', freqStart: 880, freqEnd: 880, gain: 0.25, duration: 0.25, delay: 0 },
      { kind: 'tone', wave: 'sine', freqStart: 1318, freqEnd: 1318, gain: 0.2, duration: 0.35, delay: 0.1 },
    ],
  },
  shot: {
    id: 'shot',
    layers: [
      { kind: 'noise', filter: 'highpass', freqStart: 1800, freqEnd: 1200, gain: 0.22, duration: 0.09, delay: 0 },
      { kind: 'tone', wave: 'square', freqStart: 180, freqEnd: 90, gain: 0.12, duration: 0.06, delay: 0 },
    ],
  },
  explosion: {
    id: 'explosion',
    layers: [
      { kind: 'noise', filter: 'lowpass', freqStart: 2800, freqEnd: 90, gain: 0.5, duration: 0.7, delay: 0 },
      { kind: 'tone', wave: 'sine', freqStart: 70, freqEnd: 38, gain: 0.45, duration: 0.6, delay: 0 },
    ],
  },
  unitDown: {
    id: 'unitDown',
    layers: [
      { kind: 'tone', wave: 'sawtooth', freqStart: 420, freqEnd: 110, gain: 0.2, duration: 0.32, delay: 0 },
    ],
  },
  ageFanfare: {
    id: 'ageFanfare',
    layers: [
      { kind: 'tone', wave: 'triangle', freqStart: 523, freqEnd: 523, gain: 0.3, duration: 0.16, delay: 0 },
      { kind: 'tone', wave: 'triangle', freqStart: 659, freqEnd: 659, gain: 0.3, duration: 0.16, delay: 0.14 },
      { kind: 'tone', wave: 'triangle', freqStart: 784, freqEnd: 784, gain: 0.3, duration: 0.16, delay: 0.28 },
      { kind: 'tone', wave: 'triangle', freqStart: 1046, freqEnd: 1046, gain: 0.34, duration: 0.4, delay: 0.42 },
    ],
  },
  error: {
    id: 'error',
    layers: [
      { kind: 'tone', wave: 'square', freqStart: 150, freqEnd: 130, gain: 0.18, duration: 0.18, delay: 0 },
    ],
  },
  advisorPing: {
    id: 'advisorPing',
    layers: [
      { kind: 'tone', wave: 'sine', freqStart: 1244, freqEnd: 1174, gain: 0.2, duration: 0.22, delay: 0 },
    ],
  },
};

/** All SFX ids, for iteration and tests. */
export const ALL_SFX_IDS = Object.keys(SFX_CUES) as SfxId[];

/**
 * Play one cue through `bus`. Creates one-shot nodes per layer; everything
 * is released automatically when the envelopes finish. Defensive: any
 * Web Audio failure is swallowed — the game must never break on audio.
 *
 * `noiseBuffer` is a shared 1-second white-noise buffer owned by the engine.
 */
export function playSfxCue(
  ctx: AudioContext,
  bus: GainNode,
  noiseBuffer: AudioBuffer,
  id: SfxId,
): void {
  const cue = SFX_CUES[id];
  if (!cue) return;
  try {
    const t0 = ctx.currentTime;
    for (const layer of cue.layers) {
      const when = t0 + layer.delay;
      const env = ctx.createGain();
      // Fast attack, exponential decay to near-silence.
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(Math.max(layer.gain, 0.0001), when + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, when + layer.duration);
      env.connect(bus);

      if (layer.kind === 'tone') {
        const osc = ctx.createOscillator();
        osc.type = layer.wave ?? 'sine';
        osc.frequency.setValueAtTime(Math.max(layer.freqStart, 1), when);
        if (layer.freqEnd !== layer.freqStart) {
          osc.frequency.exponentialRampToValueAtTime(Math.max(layer.freqEnd, 1), when + layer.duration);
        }
        osc.connect(env);
        osc.start(when);
        osc.stop(when + layer.duration + 0.05);
      } else {
        const src = ctx.createBufferSource();
        src.buffer = noiseBuffer;
        src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = layer.filter ?? 'lowpass';
        filter.frequency.setValueAtTime(Math.max(layer.freqStart, 10), when);
        if (layer.freqEnd !== layer.freqStart) {
          filter.frequency.exponentialRampToValueAtTime(Math.max(layer.freqEnd, 10), when + layer.duration);
        }
        src.connect(filter);
        filter.connect(env);
        src.start(when);
        src.stop(when + layer.duration + 0.05);
      }
    }
  } catch {
    // Audio must never break the game.
  }
}

/**
 * Create a shared 1-second white-noise buffer for noise layers.
 * Called once by the engine; cheap (48k samples).
 */
export function createNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const len = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Deterministic fill is unnecessary here (UI-layer only), but a fixed
  // seed keeps behavior stable across sessions for the same device.
  let seed = 0x2f6e2b1;
  for (let i = 0; i < len; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    data[i] = (seed / 0xffffffff) * 2 - 1;
  }
  return buffer;
}
