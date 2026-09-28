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
  CommandRejectedError,
  createCommandQueue,
  registerCoreCommands,
} from '../src/sim/commands';
import { createTickDriver } from '../src/sim/tick';
import { FIRST_ENTITY_ID, createWorld } from '../src/sim/world';

function rejectionReason(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).reason;
  }
  throw new Error('expected a CommandRejectedError but none was thrown');
}

describe('sim/commands', () => {
  it('applies in (tick, issuer, seq) order regardless of insertion order', () => {
    const w = createWorld(1);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    // Inserted scrambled; must apply: tick 3 first, then tick 5 by issuer.
    queue.enqueue(w, {
      kind: 'spawn', tick: 5, issuer: 'b', seq: 2,
      payload: { kind: 'third', x: 0, z: 0 },
    });
    queue.enqueue(w, {
      kind: 'spawn', tick: 3, issuer: 'z', seq: 0,
      payload: { kind: 'first', x: 0, z: 0 },
    });
    queue.enqueue(w, {
      kind: 'spawn', tick: 5, issuer: 'a', seq: 1,
      payload: { kind: 'second', x: 0, z: 0 },
    });
    const driver = createTickDriver({ queue });
    driver.step(w, 100); // 3 ticks -> tick 3
    driver.step(w, 100); // 3 ticks -> tick 6
    expect(w.entities.map((e) => e.kind)).toEqual(['first', 'second', 'third']);
    expect(queue.pendingCount()).toBe(0);
  });

  it('invalid commands are rejected loudly with a reason', () => {
    const w = createWorld(1);
    const queue = createCommandQueue();
    registerCoreCommands(queue);

    expect(rejectionReason(() =>
      queue.enqueue(w, { kind: 'nope', issuer: 'player', payload: {} }),
    )).toContain('unknown command kind');

    expect(rejectionReason(() =>
      queue.enqueue(w, { kind: 'spawn', issuer: 'player', payload: { kind: 'x', x: NaN, z: 0 } }),
    )).toContain('payload.x');

    expect(rejectionReason(() =>
      queue.enqueue(w, { kind: 'spawn', issuer: 'player', payload: { kind: '', x: 0, z: 0 } }),
    )).toContain('payload.kind');

    expect(rejectionReason(() =>
      queue.enqueue(w, { kind: 'despawn', issuer: 'player', payload: { id: 4242 } }),
    )).toContain('no entity with id 4242');

    expect(rejectionReason(() =>
      queue.enqueue(w, { kind: 'spawn', issuer: '', payload: { kind: 'x', x: 0, z: 0 } }),
    )).toContain('issuer');
  });

  it('rejects commands scheduled in the past', () => {
    const w = createWorld(1);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    const driver = createTickDriver({ queue });
    driver.step(w, 100); // -> tick 3
    driver.step(w, 100); // -> tick 6
    expect(rejectionReason(() =>
      queue.enqueue(w, { kind: 'spawn', tick: 3, issuer: 'player', payload: { kind: 'x', x: 0, z: 0 } }),
    )).toContain('>= current tick 6');
  });

  it('queues across ticks: future commands wait their turn', () => {
    const w = createWorld(1);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    queue.enqueue(w, { kind: 'spawn', tick: 2, issuer: 'player', payload: { kind: 'early', x: 0, z: 0 } });
    queue.enqueue(w, { kind: 'spawn', tick: 5, issuer: 'player', payload: { kind: 'late', x: 0, z: 0 } });
    const driver = createTickDriver({ queue });
    driver.step(w, 100); // -> tick 3
    expect(w.entities.map((e) => e.kind)).toEqual(['early']);
    expect(queue.pendingCount()).toBe(1);
    driver.step(w, 100); // -> tick 6
    expect(w.entities.map((e) => e.kind)).toEqual(['early', 'late']);
    expect(queue.pendingCount()).toBe(0);
  });

  it('a command without a tick applies at the next tick boundary', () => {
    const w = createWorld(1);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    queue.enqueue(w, { kind: 'spawn', issuer: 'player', payload: { kind: 'x', x: 1, z: 2 } });
    expect(w.entities.length).toBe(0); // not applied yet
    const driver = createTickDriver({ queue });
    driver.step(w, 40); // 1 tick
    expect(w.entities.length).toBe(1);
    expect(w.entities[0]?.x).toBe(1);
  });

  it('applyDue reports per-command results (spawn returns the assigned id)', () => {
    const w = createWorld(1);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    queue.enqueue(w, { kind: 'spawn', issuer: 'player', payload: { kind: 'x', x: 0, z: 0 } });
    const applied = queue.applyDue(w, 0);
    expect(applied.length).toBe(1);
    expect(applied[0]?.result).toBe(FIRST_ENTITY_ID);
  });

  it('a command that goes stale before its tick fails loudly at apply time', () => {
    const w = createWorld(1);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    queue.enqueue(w, { kind: 'spawn', tick: 0, issuer: 'player', payload: { kind: 'x', x: 0, z: 0 } });
    queue.applyDue(w, 0);
    const id = FIRST_ENTITY_ID;
    // Two despawns for the same entity, same tick: the second is stale.
    queue.enqueue(w, { kind: 'despawn', tick: 2, issuer: 'a', payload: { id } });
    queue.enqueue(w, { kind: 'despawn', tick: 2, issuer: 'b', payload: { id } });
    expect(rejectionReason(() => queue.applyDue(w, 2))).toContain('no longer valid');
    expect(w.entities.length).toBe(0); // the first despawn did apply
  });

  it('re-registering a kind throws', () => {
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    expect(() => registerCoreCommands(queue)).toThrow();
  });
});
