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
 * along with this program. If you did, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tests/ui.toastQueue.test.ts — sequential toast queue.
 *
 * Final-review R5 UI feel (2026-10-01): the old toast() overwrote the
 * visible message; the queue shows each message in turn.
 */

import { describe, expect, it } from 'vitest';

import { ToastQueue } from '../src/ui/toastQueue';

/** A queue driven by a manual clock. */
function makeQueue(opts: { durationMs?: number; gapMs?: number } = {}): {
  queue: ToastQueue;
  advance: (ms: number) => string | null;
} {
  let now = 0;
  const queue = new ToastQueue({
    durationMs: opts.durationMs ?? 1000,
    gapMs: opts.gapMs ?? 200,
    now: () => now,
  });
  return { queue, advance: (ms: number) => { now += ms; return queue.poll(); } };
}

describe('ToastQueue', () => {
  it('shows the first toast immediately', () => {
    const { queue } = makeQueue();
    queue.push('hello');
    expect(queue.poll()).toBe('hello');
  });

  it('returns null when empty', () => {
    const { queue } = makeQueue();
    expect(queue.poll()).toBeNull();
  });

  it('hides the toast after the duration', () => {
    const { queue, advance } = makeQueue({ durationMs: 1000 });
    queue.push('hello');
    expect(advance(0)).toBe('hello');
    expect(advance(999)).toBe('hello');
    expect(advance(1)).toBeNull();
  });

  it('shows queued messages in order, with a gap between them', () => {
    const { queue, advance } = makeQueue({ durationMs: 1000, gapMs: 200 });
    queue.push('first');
    queue.push('second');
    expect(advance(0)).toBe('first');
    // First expires at t=1000; the gap keeps the toast hidden until 1200.
    expect(advance(1000)).toBeNull();
    expect(advance(199)).toBeNull();
    expect(advance(1)).toBe('second');
    expect(queue.pendingCount).toBe(0);
  });

  it('drops exact duplicates of the visible or tail toast', () => {
    const { queue, advance } = makeQueue();
    queue.push('spam');
    queue.push('spam');
    queue.push('spam');
    expect(queue.pendingCount).toBe(1);
    expect(advance(0)).toBe('spam');
    queue.push('spam'); // duplicate of the visible toast: dropped
    expect(queue.pendingCount).toBe(0);
    queue.push('other');
    queue.push('other');
    expect(queue.pendingCount).toBe(1);
  });

  it('ignores empty messages', () => {
    const { queue } = makeQueue();
    queue.push('');
    expect(queue.pendingCount).toBe(0);
    expect(queue.poll()).toBeNull();
  });

  it('clear() drops the visible toast and the backlog', () => {
    const { queue } = makeQueue();
    queue.push('a');
    queue.push('b');
    queue.poll();
    queue.clear();
    expect(queue.poll()).toBeNull();
    expect(queue.pendingCount).toBe(0);
    expect(queue.current).toBeNull();
  });

  it('a repeated message shows again after it fully hid', () => {
    const { queue, advance } = makeQueue({ durationMs: 1000, gapMs: 200 });
    queue.push('again');
    expect(advance(0)).toBe('again');
    expect(advance(1000)).toBeNull(); // hid
    queue.push('again'); // visible is null now: accepted
    expect(advance(200)).toBe('again');
  });
});
