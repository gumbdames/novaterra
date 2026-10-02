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
 * Three moods, horizontal switching with an equal-power crossfade:
 *  - `peace` — calm city-building (Meditation Impromptu 01, CC-BY)
 *  - `tension` — enemies sighted near your forces, pre-combat
 *    (roadmap B20, 2026-10-02: a procedural pulsing drone bed —
 *    see `createTensionBedBuffer`; a licensed `tension.mp3` dropped
 *    into `public/audio/` can replace it, see audio/AGENTS.md)
 *  - `war`   — combat (Volatile Reaction, CC-BY)
 *
 * `selectMood()` is a pure function of game state — fully unit-testable.
 * `MusicDirector` owns the looping voices, routes them through the Web
 * Audio music bus (so master/music volume + mute apply), and crossfades
 * on mood changes. Files carry 2s baked fades so loop seams stay
 * inaudible; the procedural tension bed is built seamless by
 * construction (all partials complete integer cycles per loop).
 *
 * UI-layer only: never imported by sim code, never affects determinism.
 */

import type { World } from '../sim/world';
import { getVisibleEnemies } from '../sim/ai';
import { buildingCenterWorld } from '../sim/intel';

/** The three music moods in 0.1 Alpha. */
export type MusicMood = 'peace' | 'tension' | 'war';

/** Minimal game-state snapshot the mood selector reads. */
export interface MoodInput {
  /** True when any of the player's living units is in combat. */
  playerUnitsInCombat: boolean;
  /** True when sighted enemies are near player assets (pre-combat). */
  enemiesNear?: boolean;
}

/**
 * Pure mood selection: war when fighting, tension when enemies are near
 * but no fight has started, peace otherwise.
 */
export function selectMood(input: MoodInput): MusicMood {
  if (input.playerUnitsInCombat) return 'war';
  if (input.enemiesNear === true) return 'tension';
  return 'peace';
}

/**
 * Roadmap B20 (2026-10-02): the tension radius — a sighted enemy this
 * close (world units) to a player unit or building reads as "about to
 * happen". 60 world units = 30 cells: just beyond typical engagement
 * range, so the music leans in before the first shot.
 */
export const TENSION_RADIUS = 60;

/** A point with world x/z — unit positions and building centers alike. */
export interface TensionPoint {
  x: number;
  z: number;
}

/**
 * Pure proximity check: true when any enemy point is within `radius` of
 * any friendly asset point (squared-distance compares). O(enemies ×
 * assets) — the caller passes the sight-model-filtered enemy list,
 * which is tiny in practice.
 */
export function enemiesNearAssets(
  enemies: ReadonlyArray<TensionPoint>,
  assets: ReadonlyArray<TensionPoint>,
  radius: number = TENSION_RADIUS,
): boolean {
  const r2 = radius * radius;
  for (const e of enemies) {
    for (const a of assets) {
      const dx = e.x - a.x;
      const dz = e.z - a.z;
      if (dx * dx + dz * dz <= r2) return true;
    }
  }
  return false;
}

/**
 * World-level tension driver (roadmap B20): true when a VISIBLE enemy
 * unit is within TENSION_RADIUS of a living player unit or a standing
 * player building. Visibility comes from the sim's sight model — the
 * same `getVisibleEnemies` the tactical minimap uses — so the music
 * never maphacks: only enemies the player's side can actually see (and
 * that are close) raise the tension. UI layer only; the game loop feeds
 * the result into `MoodTracker` at poll cadence (~2 Hz).
 */
export function enemyProximityFromWorld(world: World, playerId: number): boolean {
  const enemies = getVisibleEnemies(world, playerId);
  if (enemies.length === 0) return false;
  const assets: TensionPoint[] = [];
  for (const u of world.units) {
    if (u.owner === playerId && u.hp > 0) assets.push(u);
  }
  for (const b of world.city.buildings) {
    if (b.owner === playerId && (b.progress ?? 1) >= 1) {
      assets.push(buildingCenterWorld(b));
    }
  }
  if (assets.length === 0) return false;
  return enemiesNearAssets(enemies, assets);
}

/**
 * One poll's worth of war-mood evidence, gathered by the game loop
 * (UI layer) from the sim world.
 */
export interface MoodObservation {
  /** Poll timestamp in milliseconds (monotonic). */
  nowMs: number;
  /** Player units currently in combat (live targets). */
  combatUnits: number;
  /**
   * Player units/buildings that took damage since the previous poll.
   * This is the blind-spot fix: being bombed while holding no target
   * still counts as war — the old selector only saw units *with*
   * targets, so a one-sided bombardment stayed on the peace track.
   */
  damageEvents: number;
  /**
   * Roadmap B20 (2026-10-02): sighted enemies near player assets —
   * the pre-combat tension driver. Optional; absent counts as false
   * (existing callers keep working).
   */
  enemyProximity?: boolean;
}

/**
 * War/tension-mood hysteresis (final-review M13/L5, 2026-10-01; tension
 * state roadmap B20, 2026-10-02).
 *
 * The old behavior flipped to war on ANY single targeting event and
 * back the moment it cleared — the music thrashed during skirmishes.
 * The tracker requires SUSTAINED activity to enter war (two
 * consecutive polls with combat or damage — a single stray targeting
 * event never flips the mood) and only leaves war after a quiet
 * window, so a fight that flickers across poll boundaries keeps one
 * continuous war track.
 *
 * Tension sits between peace and war with the same hysteresis shape:
 * sustained enemy proximity (two consecutive polls) lifts peace to
 * tension; combat still jumps straight to war from either state; war
 * drops to tension (not peace) when the quiet window elapses but
 * enemies are still near; tension relaxes to peace after its own
 * shorter quiet window with no proximity.
 *
 * Pure logic, fully unit-tested; the game loop owns one instance and
 * feeds it from `pollAudioEvents`.
 */
export class MoodTracker {
  /** Consecutive polls with qualifying activity. */
  private activePolls = 0;
  /** Timestamp of the most recent qualifying poll. */
  private lastActiveMs = 0;
  /** Consecutive polls with enemy proximity. */
  private proximityPolls = 0;
  /** Timestamp of the most recent proximity poll. */
  private lastProximityMs = 0;
  private mood: MusicMood = 'peace';

  /** Current mood (the last value returned by `update`). */
  get current(): MusicMood {
    return this.mood;
  }

  /**
   * Feed one poll observation; returns the (possibly unchanged) mood.
   * `nowMs` must be non-decreasing across calls.
   */
  update(obs: MoodObservation): MusicMood {
    const active = obs.combatUnits > 0 || obs.damageEvents > 0;
    const proximity = obs.enemyProximity === true;
    if (active) {
      this.lastActiveMs = obs.nowMs;
      // Cap the counter: a 2000-unit brawl shouldn't need a longer
      // quiet window to exit than a skirmish.
      this.activePolls = Math.min(this.activePolls + 1, WAR_ENTER_POLLS);
      if (this.activePolls >= WAR_ENTER_POLLS) {
        this.mood = 'war';
      }
    } else {
      this.activePolls = 0;
      if (
        this.mood === 'war' &&
        obs.nowMs - this.lastActiveMs >= WAR_EXIT_QUIET_MS
      ) {
        // War ends: enemies still near → tension, else peace.
        this.mood = proximity ? 'tension' : 'peace';
        if (this.mood === 'tension') this.lastProximityMs = obs.nowMs;
      }
    }
    // Tension driver — war takes precedence (handled above).
    if (this.mood !== 'war') {
      if (proximity) {
        this.lastProximityMs = obs.nowMs;
        this.proximityPolls = Math.min(
          this.proximityPolls + 1,
          TENSION_ENTER_POLLS,
        );
        if (
          this.mood === 'peace' &&
          this.proximityPolls >= TENSION_ENTER_POLLS
        ) {
          this.mood = 'tension';
        }
      } else {
        this.proximityPolls = 0;
        if (
          this.mood === 'tension' &&
          obs.nowMs - this.lastProximityMs >= TENSION_EXIT_QUIET_MS
        ) {
          this.mood = 'peace';
        }
      }
    }
    return this.mood;
  }
}

/**
 * Consecutive active polls required to enter war (hysteresis: a single
 * stray targeting event never flips the track).
 */
export const WAR_ENTER_POLLS = 2;

/**
 * Quiet window after the last combat/damage activity before the mood
 * drops back to peace (no thrash when a fight flickers across polls).
 */
export const WAR_EXIT_QUIET_MS = 20_000;

/**
 * Consecutive proximity polls required to enter tension (same
 * hysteresis shape as war: a single radar blip never flips the track).
 */
export const TENSION_ENTER_POLLS = 2;

/**
 * Quiet window with no enemy proximity before tension relaxes back to
 * peace — shorter than war's, so the all-clear feels prompt.
 */
export const TENSION_EXIT_QUIET_MS = 10_000;

/**
 * Derive the mood input from a sim world. A unit counts as "in combat"
 * when it has a live target (explicit attack order or opportunistic
 * targeting) — the same observable the combat system uses. `enemiesNear`
 * is the B20 tension driver (sighted enemies near player assets).
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
  return { playerUnitsInCombat, enemiesNear: enemyProximityFromWorld(world, playerId) };
}

/** Crossfade duration in seconds. */
const CROSSFADE_SEC = 2.0;

/**
 * Roadmap B20 (2026-10-02): the procedural tension bed — a seamless 8s
 * stereo loop rendered once into an AudioBuffer, then looped:
 *  - a low A1+E2 drone (55Hz + 82.5Hz) with a slow 3.25Hz tremolo and
 *    an 8-second swell — ominous, never loud;
 *  - a distant war-drum pulse every 2s (50Hz sine, exponential decay).
 *
 * Every partial completes an integer number of cycles per 8s loop, so
 * the loop seam is inaudible. Procedural (zero download, zero license)
 * because the shipped mp3s are not in the repo — a `tension.mp3`
 * dropped into `public/audio/` can replace this voice later (see
 * audio/AGENTS.md).
 */
function createTensionBedBuffer(ctx: AudioContext): AudioBuffer {
  const seconds = 8;
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const buffer = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const phase = ch === 0 ? 0 : Math.PI / 7; // a touch of stereo width
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const drone =
        Math.sin(2 * Math.PI * 55 * t + phase) * 0.5 +
        Math.sin(2 * Math.PI * 82.5 * t + phase * 2) * 0.28;
      const tremolo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 3.25 * t);
      const swell = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.125 * t);
      const pt = t % 2; // war-drum pulse every 2s
      const drum = Math.sin(2 * Math.PI * 50 * pt) * Math.exp(-pt * 6) * 0.9;
      data[i] = (drone * tremolo * swell * 0.35 + drum * 0.5) * 0.5;
    }
  }
  return buffer;
}

/**
 * Owns the looping music voices and crossfades between them. Peace and
 * war are `<audio>` file tracks; tension is the procedural bed above.
 * All voices run through `musicBus` so the engine's volume/mute
 * controls apply.
 *
 * Defensive: if a file fails to load, the director silently stays on
 * whichever voice works (or silence) — music must never break the game.
 */
export class MusicDirector {
  private readonly ctx: AudioContext;
  private readonly musicBus: GainNode;
  private readonly baseUrl: string;
  /** File-backed voices (peace, war). Tension is procedural. */
  private readonly tracks = new Map<MusicMood, HTMLAudioElement>();
  private readonly gains = new Map<MusicMood, GainNode>();
  /** The live tension buffer source (one-shot nodes: rebuilt per use). */
  private tensionSrc: AudioBufferSourceNode | null = null;
  private current: MusicMood = 'peace';
  private started = false;
  private fadeTimer: number | null = null;

  constructor(ctx: AudioContext, musicBus: GainNode, baseUrl: string) {
    this.ctx = ctx;
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
      // Tension: procedural bed through its own gain (starts at 0).
      const tensionGain = ctx.createGain();
      tensionGain.gain.value = 0;
      tensionGain.connect(this.musicBus);
      this.gains.set('tension', tensionGain);
    } catch {
      // Media element source failed — music stays silent, game continues.
    }
  }

  /** Begin playback (call after a user gesture; autoplay policy). */
  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.startVoice(this.current);
    } catch {
      // Ignore — music is optional.
    }
  }

  /** Start one mood's voice: file track or the procedural tension bed. */
  private startVoice(mood: MusicMood): void {
    if (mood === 'tension') {
      if (this.tensionSrc !== null) return;
      const gain = this.gains.get('tension');
      if (!gain) return;
      const src = this.ctx.createBufferSource();
      src.buffer = createTensionBedBuffer(this.ctx);
      src.loop = true;
      src.connect(gain);
      src.start();
      this.tensionSrc = src;
      return;
    }
    const track = this.tracks.get(mood);
    const play = track?.play();
    // play() returns a promise in modern browsers; swallow rejections
    // (e.g. autoplay policy still blocking).
    if (play && typeof (play as Promise<void>).catch === 'function') {
      (play as Promise<void>).catch(() => undefined);
    }
  }

  /** Stop one mood's voice (buffer sources are one-shot: drop it). */
  private stopVoice(mood: MusicMood): void {
    if (mood === 'tension') {
      try {
        this.tensionSrc?.stop();
      } catch {
        // Already stopped — fine.
      }
      try {
        this.tensionSrc?.disconnect();
      } catch {
        // Ignore.
      }
      this.tensionSrc = null;
      return;
    }
    try {
      this.tracks.get(mood)?.pause();
    } catch {
      // Ignore.
    }
  }

  /** Switch mood with an equal-power crossfade. No-op if unchanged. */
  setMood(mood: MusicMood): void {
    if (mood === this.current || !this.started) {
      // Still record the target so a later start() plays the right voice.
      this.current = mood;
      return;
    }
    const from = this.current;
    this.current = mood;
    try {
      const fromGain = this.gains.get(from);
      const toGain = this.gains.get(mood);
      if (!fromGain || !toGain) return;
      this.startVoice(mood);
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
          this.stopVoice(from);
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
    this.stopVoice('tension');
  }
}
