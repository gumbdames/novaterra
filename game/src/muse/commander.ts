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
 * NOVATERRA — muse/commander.ts — Muse Commander rival controller.
 *
 * UI-owned (not part of the sim): once per cadence interval it builds a
 * compact fog-filtered battle digest (`muse/digest.ts`), POSTs it to the
 * player's own Anthropic API key, and turns the model's `MUSE:`
 * directives into ordinary validated game commands through the
 * `CommandQueue` (`muse/live.ts`).
 *
 * Structural guarantees:
 *  - Muse never touches `world` directly — every decision becomes a
 *    normal queued command, validated at enqueue and at apply like any
 *    other order.
 *  - The network is fully off-tick: at most one request is in flight,
 *    and resolved directives are buffered, then applied at the next
 *    `update()` call — the controlled application point — never inside
 *    the Promise callback (which can fire mid-frame). The sim never
 *    waits on the API.
 *  - Failure is silent and seamless: no key, timeout, 401/429/5xx,
 *    network error, or malformed output simply means "no directives
 *    this round" — the Classic Commander brain inside the sim keeps
 *    playing at full strength the whole time. A 401 latches the key:
 *    it is never retried until the stored key changes.
 *
 * All async/network state lives here, outside `World`, so snapshots
 * and digests stay deterministic and key-free.
 */

import type { World } from '../sim/world';
import type { CommandQueue } from '../sim/commands';
import { buildCommanderDigest } from './digest';
import {
  createLiveMuseClient,
  directivesToCommands,
  getLiveKey,
  getLiveCadenceSec,
  LiveMuseError,
  type LiveMuseClient,
  type CommanderDirective,
} from './live';

export interface MuseCommanderOptions {
  /** The shared command queue (directives become normal commands). */
  queue: CommandQueue;
  /** Owner id the Muse rival commands (the AI player). */
  owner: number;
  /** Rival base position (world units) — spawn/defend anchor. */
  baseX: number;
  baseZ: number;
  /** Map metadata for the digest. */
  mapSize: number;
  waterPct: number;
  /** Called when the "Muse is thinking…" indicator should show/hide. */
  onThinkingChange?: (thinking: boolean) => void;
  /** Optional flavor: surfaces `MUSE: advise:` lines from the model. */
  say?: (text: string) => void;
  /** Injectable client factory (tests). */
  createClient?: () => LiveMuseClient;
}

/**
 * The live rival commander. Call `update(world)` every frame; it fires
 * at most one API call per cadence interval and never blocks the sim.
 */
export class MuseCommander {
  private readonly opts: MuseCommanderOptions;
  private readonly createClient: () => LiveMuseClient;
  private inFlight = false;
  private lastCallTick = 0;
  private disposed = false;
  /**
   * The key value that last got a 401. While the stored key is unchanged
   * we never call the API again — no aggressive retries against a key
   * the server already rejected. Clears the moment the key changes.
   */
  private invalidKeyFor: string | null = null;
  /**
   * Directives resolved by the in-flight API call, waiting for the next
   * controlled application point (the next `update()`).
   */
  private pendingDirectives: CommanderDirective[] | null = null;

  constructor(opts: MuseCommanderOptions) {
    this.opts = opts;
    this.createClient = opts.createClient ?? createLiveMuseClient;
  }

  /**
   * Frame tick (UI loop). Fires one API call per cadence interval when a
   * key is set; otherwise does nothing and the Classic AI plays alone.
   * Also the controlled application point: directives resolved by an
   * earlier async call are applied here, never inside the Promise
   * callback. Never throws.
   */
  update(world: World): void {
    if (this.disposed) return;
    this.applyPending(world);
    if (this.inFlight) return;
    let cadenceTicks: number;
    try {
      cadenceTicks = getLiveCadenceSec() * 30;
    } catch {
      return;
    }
    if (world.tick - this.lastCallTick < cadenceTicks) return;
    let key: string;
    try {
      key = getLiveKey();
    } catch {
      return;
    }
    if (key.length === 0) return; // No key → Classic Commander fallback only.
    // 401 latch: a rejected key is never retried until the player changes it.
    if (this.invalidKeyFor !== null && this.invalidKeyFor === key) return;

    this.lastCallTick = world.tick;
    this.inFlight = true;
    this.notifyThinking(true);
    const digest = buildCommanderDigest(world, this.opts.owner, {
      size: this.opts.mapSize,
      waterPct: this.opts.waterPct,
    });
    let client: LiveMuseClient;
    try {
      client = this.createClient();
    } catch {
      this.finishFlight();
      return;
    }
    client.command(digest).then(
      (directives: CommanderDirective[]) => {
        // Buffer only. Application happens at the next update() — the
        // controlled point — against the CURRENT world then.
        if (!this.disposed) this.pendingDirectives = directives;
      },
      (err: unknown) => {
        // Silent fallback: the Classic Commander keeps playing. A 401
        // latches the key so we never hammer a rejected key.
        if (err instanceof LiveMuseError && err.code === 'invalid_key') {
          this.invalidKeyFor = key;
        }
      },
    ).finally(() => {
      this.finishFlight();
    });
  }

  /** Stop: in-flight results and buffered directives are discarded. */
  dispose(): void {
    this.disposed = true;
    this.pendingDirectives = null;
  }

  /**
   * Apply buffered directives through the command queue. Runs at the
   * start of every update() — the one controlled application point.
   */
  private applyPending(world: World): void {
    const directives = this.pendingDirectives;
    if (!directives) return;
    this.pendingDirectives = null;
    // Apply to the CURRENT world (ticks passed while the request was in
    // flight); validation uses current state, as always.
    try {
      directivesToCommands(directives, {
        world,
        queue: this.opts.queue,
        owner: this.opts.owner,
        baseX: this.opts.baseX,
        baseZ: this.opts.baseZ,
      });
      for (const d of directives) {
        if (d.kind === 'advise') this.opts.say?.(d.text);
      }
    } catch {
      // A directive bug must never break the frame loop.
    }
  }

  private finishFlight(): void {
    this.inFlight = false;
    if (!this.disposed) this.notifyThinking(false);
  }

  private notifyThinking(thinking: boolean): void {
    try {
      this.opts.onThinkingChange?.(thinking);
    } catch {
      // Indicator failure must never break the commander.
    }
  }
}
