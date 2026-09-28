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
 * NOVATERRA — sim/rng.ts — seeded RNG for the deterministic simulation.
 *
 * Responsibilities:
 *  - mulberry32 generator (locked in by docs/research/sim-architecture.md
 *    §3.2: one uint32 of state, tiny, fast, good enough for gameplay).
 *  - Named, independent streams (`rng.next('combat')`): each stream is a
 *    separate mulberry32 instance whose seed is derived from
 *    (master seed, stream name). Drawing from one stream can never shift
 *    another stream's sequence — subsystems can't desync each other.
 *
 * Key invariants:
 *  - The state record (`RngState`) is plain data and lives inside the world
 *    (`world.rng`); the bank is just a live view over it. Saving the world
 *    saves every stream's state — nothing hidden.
 *  - Streams are derived lazily but deterministically: a stream first used
 *    at tick N gets the same seed as if it had existed since tick 0, so the
 *    *set of used streams* never affects any sequence.
 *  - Never `Math.random()` in the sim — grep for it. All randomness flows
 *    through here.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

/** Plain-data RNG state: one uint32 per named stream. Serialized verbatim. */
export interface RngState {
  [stream: string]: number;
}

const MULBERRY_INCREMENT = 0x6d2b79f5;

/** One mulberry32 step. Returns the new state and a float in [0, 1). */
function mulberry32Step(state: number): { value: number; state: number } {
  // `| 0` keeps every intermediate in int32 range; Math.imul is exact.
  let t = (state + MULBERRY_INCREMENT) | 0;
  let z = Math.imul(t ^ (t >>> 15), t | 1);
  z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
  const value = ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  return { value, state: t };
}

/** FNV-1a 32-bit hash — used to derive per-stream seeds from the master seed. */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Derive a stream's initial uint32 state from (masterSeed, streamName). */
function deriveStreamSeed(masterSeed: number, stream: string): number {
  // `>>> 0` normalizes any numeric seed (negative, float) to a uint32.
  return fnv1a32(`${masterSeed >>> 0}:${stream}`);
}

/** Live view over a plain-data `RngState` record. */
export interface RngBank {
  /** Float in [0, 1) from the named stream. */
  next(stream: string): number;
  /** Integer in [0, n) from the named stream. Requires n >= 1. */
  intBelow(stream: string, n: number): number;
  /** Float in [min, max) from the named stream. */
  range(stream: string, min: number, max: number): number;
}

/**
 * Create a bank over `state` (defaults to a fresh record). The bank holds no
 * state of its own — every draw reads/writes `state[stream]`, so the record
 * can be snapshotted, serialized, and restored at any time. Pass the world's
 * `world.rng` record and the bank's draws become part of the save.
 */
export function createRngBank(masterSeed: number, state?: RngState): RngBank {
  const record: RngState = state ?? {};

  function ensureStream(stream: string): number {
    const existing = record[stream];
    if (existing === undefined) {
      const derived = deriveStreamSeed(masterSeed, stream);
      record[stream] = derived;
      return derived;
    }
    return existing;
  }

  function draw(stream: string): number {
    const stepped = mulberry32Step(ensureStream(stream));
    record[stream] = stepped.state;
    return stepped.value;
  }

  return {
    next(stream: string): number {
      return draw(stream);
    },
    intBelow(stream: string, n: number): number {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`rng.intBelow: n must be an integer >= 1, got ${n}`);
      }
      return Math.floor(draw(stream) * n);
    },
    range(stream: string, min: number, max: number): number {
      if (!(min < max) || !Number.isFinite(min) || !Number.isFinite(max)) {
        throw new Error(`rng.range: need finite min < max, got ${min}, ${max}`);
      }
      return min + draw(stream) * (max - min);
    },
  };
}
