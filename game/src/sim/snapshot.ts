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
 * NOVATERRA — sim/snapshot.ts — versioned world snapshots.
 *
 * Responsibilities:
 *  - `takeSnapshot(world)` → plain-data `Snapshot` with a `version` field;
 *    `restoreSnapshot(data)` → a fresh, independent `World`.
 *  - Version mismatch is a hard error naming expected vs found — old saves
 *    never silently load as something else. (Migrations chain in
 *    net_save/ in a later step; this module is the versioned unit they
 *    migrate.)
 *
 * Key invariants:
 *  - Snapshots are taken at tick boundaries. The tick driver's accumulator
 *    is wall-clock-derived and intentionally NOT in the snapshot.
 *  - Snapshots are deep copies: mutating the world after taking one (or
 *    mutating the snapshot) cannot affect the other.
 *  - The snapshot is JSON-serializable: only numbers, strings, arrays, and
 *    plain objects. `JSON.parse(JSON.stringify(snap))` round-trips exactly.
 *  - Round-trip preserves the digest exactly: digest(restore(take(w)))
 *    === digest(w). This is the save/load integrity check.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { EntityRecord, World } from './world';
import { createWorld } from './world';
import type { RngState } from './rng';

/** Snapshot format version. Bump on any breaking change to the shape below. */
export const SNAPSHOT_VERSION = 1;

/** Plain-data snapshot of the world at a tick boundary. */
export interface Snapshot {
  version: number;
  tick: number;
  time: number;
  seed: number;
  nextId: number;
  entities: EntityRecord[];
  rng: RngState;
}

/** Thrown when a snapshot's version doesn't match. Names expected vs found. */
export class SnapshotVersionError extends Error {
  readonly expected: number;
  readonly found: unknown;
  constructor(expected: number, found: unknown) {
    super(
      `snapshot version mismatch: expected ${expected}, found ${JSON.stringify(found)}`,
    );
    this.name = 'SnapshotVersionError';
    this.expected = expected;
    this.found = found;
  }
}

function copyEntities(entities: EntityRecord[]): EntityRecord[] {
  return entities.map((e) => ({ id: e.id, kind: e.kind, x: e.x, z: e.z }));
}

function copyRng(rng: RngState): RngState {
  const out: RngState = {};
  for (const name of Object.keys(rng)) {
    out[name] = rng[name] as number;
  }
  return out;
}

/** Deep-copy the world's sim state into a versioned, JSON-safe snapshot. */
export function takeSnapshot(world: World): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    tick: world.tick,
    time: world.time,
    seed: world.seed,
    nextId: world.nextId,
    entities: copyEntities(world.entities),
    rng: copyRng(world.rng),
  };
}

/**
 * Rebuild a world from a snapshot. The result shares no references with the
 * snapshot. Throws SnapshotVersionError on version mismatch.
 */
export function restoreSnapshot(snap: Snapshot): World {
  if (snap === null || typeof snap !== 'object') {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap);
  }
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap.version);
  }
  const world = createWorld(snap.seed);
  world.tick = snap.tick;
  world.time = snap.time;
  world.nextId = snap.nextId;
  world.entities = copyEntities(snap.entities);
  world.rng = copyRng(snap.rng);
  return world;
}
