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
 * NOVATERRA — audio/music.ts — adaptive background music (0.1 Alpha).
 *
 * Two moods, horizontal switching with an equal-power crossfade:
 *  - `peace` — calm city-building (Meditation Impromptu 01, CC-BY)
 *  - `war`   — combat (Volatile Reaction, CC-BY)
 *
 * `selectMood()` is a pure function of game state — fully unit-testable.
 * `MusicDirector` owns the two looping `<audio>` elements, routes them
 * through the Web Audio music bus (so master/music volume + mute apply),
 * and crossfades on mood changes. Files carry 2s baked fades so loop
 * seams stay inaudible.
 *
 * UI-layer only: never imported by sim code, never affects determinism.
 */

import type { World } from '../sim/world';

/** The two music moods in 0.1 Alpha. */
export type MusicMood = 'peace' | 'war';

/** Minimal game-state snapshot the mood selector reads. */
export interface MoodInput {
  /** True when any of the player's living units is in combat. */
  playerUnitsInCombat: boolean;
}

/**
 * Pure mood selection: war whenever the player's forces are fighting,
 * peace otherwise. (A `tension` pre-combat state arrives in a later phase.)
 */
export function selectMood(input: MoodInput): MusicMood {
  return input.playerUnitsInCombat ? 'war' : 'peace';
}

/**
 * Derive the mood input from a sim world. A unit counts as "in combat"
 * when it has a live target (explicit attack order or opportunistic
 * targeting) — the same observable the combat system uses.
 */
export function moodInputFromWorld(world: World, playerId: number): MoodInput {
  const liveIds = new Set<number>();
  for (const u of world.units) {
    if (u.hp > 0) liveIds.add(u.id);
  }
  let playerUnitsInCombat = false;
  for (const u of world.units) {
    if (u.owner !== playerId || u.hp <= 0) continue;
    if (u.targetId !== 0 && liveIds.has(u.targetId)) {
      playerUnitsInCombat = true;
      break;
    }
  }
  return { playerUnitsInCombat };
}

/** Crossfade duration in seconds. */
const CROSSFADE_SEC = 2.0;

/**
 * Owns the two looping tracks and crossfades between them. All audio runs
 * through `musicBus` so the engine's volume/mute controls apply.
 *
 * Defensive: if a file fails to load, the director silently stays on
 * whichever track works (or silence) — music must never break the game.
 */
export class MusicDirector {
  private readonly musicBus: GainNode;
  private readonly baseUrl: string;
  private readonly tracks = new Map<MusicMood, HTMLAudioElement>();
  private readonly gains = new Map<MusicMood, GainNode>();
  private current: MusicMood = 'peace';
  private started = false;
  private fadeTimer: number | null = null;

  constructor(ctx: AudioContext, musicBus: GainNode, baseUrl: string) {
    this.musicBus = musicBus;
    this.baseUrl = baseUrl;
    try {
      for (const mood of ['peace', 'war'] as MusicMood[]) {
        const audio = new Audio();
        audio.src = `${baseUrl}audio/${mood}.mp3`;
        audio.loop = true;
        audio.preload = 'auto';
        const src = ctx.createMediaElementSource(audio);
        const gain = ctx.createGain();
        gain.gain.value = mood === 'peace' ? 1 : 0;
        src.connect(gain);
        gain.connect(this.musicBus);
        this.tracks.set(mood, audio);
        this.gains.set(mood, gain);
      }
    } catch {
      // Media element source failed — music stays silent, game continues.
    }
  }

  /** Begin playback (call after a user gesture; autoplay policy). */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      const play = this.tracks.get(this.current)?.play();
      // play() returns a promise in modern browsers; swallow rejections
      // (e.g. autoplay policy still blocking).
      if (play && typeof (play as Promise<void>).catch === 'function') {
        (play as Promise<void>).catch(() => undefined);
      }
      // Warm the other track so the first crossfade is instant.
      const other = this.tracks.get(this.current === 'peace' ? 'war' : 'peace');
      const otherPlay = other?.play();
      if (otherPlay && typeof (otherPlay as Promise<void>).catch === 'function') {
        (otherPlay as Promise<void>).catch(() => undefined);
      }
      // Keep the non-current track paused until needed; it resumes on switch.
      other?.pause();
    } catch {
      // Ignore — music is optional.
    }
  }

  /** Switch mood with an equal-power crossfade. No-op if unchanged. */
  setMood(mood: MusicMood): void {
    if (mood === this.current || !this.started) {
      // Still record the target so a later start() plays the right track.
      this.current = mood;
      return;
    }
    const from = this.current;
    this.current = mood;
    try {
      const fromGain = this.gains.get(from);
      const toGain = this.gains.get(mood);
      const toTrack = this.tracks.get(mood);
      if (!fromGain || !toGain || !toTrack) return;
      const play = toTrack.play();
      if (play && typeof (play as Promise<void>).catch === 'function') {
        (play as Promise<void>).catch(() => undefined);
      }
      // Interval-driven crossfade (~60fps steps); equal-power curve.
      if (this.fadeTimer !== null) window.clearInterval(this.fadeTimer);
      const steps = Math.max(1, Math.round((CROSSFADE_SEC * 1000) / 16));
      let i = 0;
      this.fadeTimer = window.setInterval(() => {
        i++;
        const t = Math.min(1, i / steps);
        // Equal-power: cos/sin of quarter circle.
        const outLevel = Math.cos((t * Math.PI) / 2);
        const inLevel = Math.sin((t * Math.PI) / 2);
        fromGain.gain.value = outLevel;
        toGain.gain.value = inLevel;
        if (t >= 1 && this.fadeTimer !== null) {
          window.clearInterval(this.fadeTimer);
          this.fadeTimer = null;
          this.tracks.get(from)?.pause();
        }
      }, 16);
    } catch {
      // Ignore — music is optional.
    }
  }

  get mood(): MusicMood {
    return this.current;
  }

  dispose(): void {
    if (this.fadeTimer !== null) {
      window.clearInterval(this.fadeTimer);
      this.fadeTimer = null;
    }
    for (const track of this.tracks.values()) {
      try {
        track.pause();
        track.src = '';
      } catch {
        // Ignore.
      }
    }
    this.tracks.clear();
    this.gains.clear();
  }
}
