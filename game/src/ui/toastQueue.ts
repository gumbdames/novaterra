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
 * NOVATERRA — ui/toastQueue.ts — sequential toast queue.
 *
 * Final-review R5 UI feel (2026-10-01): the old `HUD.toast()` replaced
 * the visible message and reset a single timer, so a burst of feedback
 * ("Not enough funds" ×3, then "Research complete") showed only the
 * last one. The queue shows each message in turn for `durationMs`
 * with a short gap between them, and drops exact duplicates (a spammy
 * rejection doesn't replay five times).
 *
 * Pure: no DOM, no timers — the clock is injectable, so the whole
 * behavior is unit-tested in `tests/ui.toastQueue.test.ts`. The HUD
 * pumps it from its per-frame `update()` and owns the DOM element.
 *
 * 2026-10-05 (Fix 2): the queue also carries ONE persistent toast
 * (`persist`/`unpersist`). A persistent toast holds the toast slot
 * whenever the transient queue is idle — it survives transient
 * interruptions (they cycle through, then it returns) and stays on
 * screen until replaced or unpersisted, newest wins. Building-loss
 * and demolition feedback uses this so a lost Water Pump cannot
 * vanish in 2.2s of battle noise. It is still the same toast slot
 * (same DOM element, pointer-events:none — never blocks map input),
 * so transient feedback is never starved: any transient toast
 * displaces the persistent one for its normal duration.
 */

export interface ToastQueueOptions {
  /** How long each toast stays visible (ms). Default 2200. */
  durationMs?: number;
  /** Breathing room between toasts (ms). Default 250. */
  gapMs?: number;
  /** Clock; defaults to Date.now. Inject a fake in tests. */
  now?: () => number;
}

export class ToastQueue {
  private readonly durationMs: number;
  private readonly gapMs: number;
  private readonly now: () => number;
  private readonly pending: string[] = [];
  private visible: string | null = null;
  private visibleSince = 0;
  /** When the last toast hid (0 = never — no gap before the first). */
  private lastHideAt = 0;
  private hiddenOnce = false;
  /**
   * 2026-10-05 (Fix 2): the persistent toast — shown by poll() whenever
   * the transient queue is idle. Never times out; replaced by the next
   * persist() call, cleared by unpersist()/clear().
   */
  private persistent: string | null = null;

  constructor(opts: ToastQueueOptions = {}) {
    this.durationMs = opts.durationMs ?? 2200;
    this.gapMs = opts.gapMs ?? 250;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Enqueue a message. Exact duplicates of the tail/visible toast are dropped. */
  push(message: string): void {
    if (message === '') return;
    const tail = this.pending[this.pending.length - 1];
    if (tail === message || this.visible === message) return;
    this.pending.push(message);
  }

  /**
   * 2026-10-05 (Fix 2): pin a persistent toast. It holds the toast slot
   * whenever the transient queue is idle — surviving transient
   * interruptions and staying on screen until replaced or unpersisted.
   * Newest wins. Empty messages are ignored.
   */
  persist(message: string): void {
    if (message === '') return;
    this.persistent = message;
  }

  /** Clear the persistent toast; the slot goes back to transient-only. */
  unpersist(): void {
    this.persistent = null;
  }

  /** The currently pinned persistent toast, if any. */
  get persistentMessage(): string | null {
    return this.persistent;
  }

  /**
   * Advance the queue; call every frame. Returns the message that
   * should be visible right now, the persistent toast when the
   * transient queue is idle (2026-10-05, Fix 2), or null when the
   * toast should hide.
   */
  poll(): string | null {
    const now = this.now();
    if (this.visible !== null) {
      if (now - this.visibleSince >= this.durationMs) {
        this.visible = null;
        this.lastHideAt = now;
        this.hiddenOnce = true;
      } else {
        return this.visible;
      }
    }
    if (this.pending.length > 0) {
      const gap = this.hiddenOnce ? now - this.lastHideAt >= this.gapMs : true;
      if (gap) {
        // B27: no `!` — length > 0 above, so shift() is defined.
        const next = this.pending.shift();
        if (next === undefined) throw new Error('toastQueue: shift() on non-empty queue');
        this.visible = next;
        this.visibleSince = now;
        return this.visible;
      }
    }
    // 2026-10-05 (Fix 2): idle and a persistent toast is pinned — it
    // holds the slot (no timeout). Transient toasts displace it while
    // they run and it returns afterwards.
    return this.persistent;
  }

  /** Messages waiting behind the visible one. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** The currently visible message, if any. */
  get current(): string | null {
    return this.visible;
  }

  /** Drop everything (e.g. on game exit) — including the persistent toast. */
  clear(): void {
    this.pending.length = 0;
    this.visible = null;
    this.persistent = null;
  }
}
