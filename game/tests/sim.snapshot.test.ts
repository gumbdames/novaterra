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

import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_VERSION,
  SnapshotVersionError,
  restoreSnapshot,
  takeSnapshot,
} from '../src/sim/snapshot';
import type { Snapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import { createTickDriver } from '../src/sim/tick';
import { createWorld, rngBank, spawnEntity } from '../src/sim/world';

/** A lived-in world: entities, ticks, and RNG draws. */
function livedWorld() {
  const w = createWorld(2026);
  spawnEntity(w, 'settler', 10, 20);
  spawnEntity(w, 'farm', -30, 5);
  const driver = createTickDriver();
  for (let i = 0; i < 10; i++) driver.step(w, 100); // 30 ticks
  const bank = rngBank(w);
  bank.next('combat');
  bank.next('economy');
  bank.next('economy');
  return w;
}

describe('sim/snapshot', () => {
  it('round-trip preserves the digest exactly', () => {
    const w = livedWorld();
    const before = digestWorld(w);
    const restored = restoreSnapshot(takeSnapshot(w));
    expect(digestWorld(restored)).toBe(before);
  });

  it('snapshot is a deep copy: world and snapshot do not alias', () => {
    const w = livedWorld();
    const snap = takeSnapshot(w);
    const digestAtTake = digestWorld(restoreSnapshot(snap));
    // Mutate the world after taking the snapshot...
    spawnEntity(w, 'tank', 0, 0);
    rngBank(w).next('combat');
    // ...and the snapshot is unaffected.
    expect(digestWorld(restoreSnapshot(snap))).toBe(digestAtTake);
    expect(digestWorld(w)).not.toBe(digestAtTake);
    // Mutating the restored world does not affect the snapshot either.
    const restored = restoreSnapshot(snap);
    spawnEntity(restored, 'x', 0, 0);
    expect(snap.entities.length).toBe(2);
  });

  it('snapshot survives a JSON round-trip (save-file path)', () => {
    const w = livedWorld();
    const before = digestWorld(w);
    const json = JSON.stringify(takeSnapshot(w));
    const revived = restoreSnapshot(JSON.parse(json) as Snapshot);
    expect(digestWorld(revived)).toBe(before);
    expect(revived.tick).toBe(w.tick);
    expect(revived.time).toBe(w.time);
    expect(revived.seed).toBe(w.seed);
    expect(revived.nextId).toBe(w.nextId);
  });

  it('version mismatch is a hard error naming expected vs found', () => {
    const w = livedWorld();
    const tampered = { ...takeSnapshot(w), version: 999 };
    let caught: unknown;
    try {
      restoreSnapshot(tampered);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SnapshotVersionError);
    const err = caught as SnapshotVersionError;
    expect(err.expected).toBe(SNAPSHOT_VERSION);
    expect(err.found).toBe(999);
    expect(err.message).toContain(`expected ${SNAPSHOT_VERSION}`);
    expect(err.message).toContain('found 999');
  });

  it('rejects non-object snapshots', () => {
    expect(() => restoreSnapshot(null as unknown as Snapshot)).toThrow(SnapshotVersionError);
    expect(() => restoreSnapshot('nope' as unknown as Snapshot)).toThrow(SnapshotVersionError);
  });

  it('snapshot carries the current version stamp', () => {
    expect(takeSnapshot(livedWorld()).version).toBe(SNAPSHOT_VERSION);
  });

  it('restore then new commands matches a fresh run with the same history', () => {
    // Run A: tick 10, snapshot, restore, issue NEW command, tick 10 more.
    const worldA = createWorld(777);
    const driverA = createTickDriver();
    for (let i = 0; i < 10; i++) driverA.step(worldA, 100);
    const snap = takeSnapshot(worldA);
    const restoredA = restoreSnapshot(snap);
    // New command after restore: spawn an entity (simulates a player order).
    spawnEntity(restoredA, 'tank', 50, 50);
    const driverA2 = createTickDriver();
    for (let i = 0; i < 10; i++) driverA2.step(restoredA, 100);
    const digestA = digestWorld(restoredA);

    // Run B: fresh world, same seed, same tick count, same "command" at the
    // same tick (tick 10). Must produce the identical digest.
    const worldB = createWorld(777);
    const driverB = createTickDriver();
    for (let i = 0; i < 10; i++) driverB.step(worldB, 100);
    spawnEntity(worldB, 'tank', 50, 50);
    for (let i = 0; i < 10; i++) driverB.step(worldB, 100);
    const digestB = digestWorld(worldB);

    expect(digestA).toBe(digestB);
  });
});
