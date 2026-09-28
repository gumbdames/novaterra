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
 * NOVATERRA — sim/commands.ts — the command pattern (tick-aligned input).
 *
 * Responsibilities:
 *  - Player and AI intents are plain-data `Command` objects. They are
 *    validated at enqueue time, queued, and applied only at tick boundaries
 *    in a deterministic order: (tick, issuer, seq). Same seed + same command
 *    stream ⇒ same simulation, which is what makes replays possible.
 *  - Rejected commands throw `CommandRejectedError` carrying a human-readable
 *    reason — loudly, never silently. Validation runs again at apply time
 *    (state may have changed since enqueue); a stale command is a loud
 *    deterministic error, not a silent skip.
 *
 * Key invariants:
 *  - `cmd.tick` must be >= the world's current tick at enqueue (no
 *    scheduling in the past).
 *  - `seq` is issuer-local. If omitted, the queue assigns a global insertion
 *    counter so the total order is still deterministic.
 *  - The queue owns the command-kind registry (`register`). Core kinds
 *    (`spawn`, `despawn`) are registered by `registerCoreCommands`.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import { despawnEntity, findEntity, spawnEntity } from './world';

/** A player/AI intent. Plain data — safe to log, replay, and serialize. */
export interface Command {
  /** Command kind, e.g. 'spawn'. Must be registered before enqueue. */
  kind: string;
  /** Tick at whose start this command applies. */
  tick: number;
  /** Who issued it, e.g. 'player', 'ai:classic:2'. Part of the sort key. */
  issuer: string;
  /** Issuer-local sequence. Part of the sort key. */
  seq: number;
  /** Kind-specific arguments. Plain data only. */
  payload: Record<string, unknown>;
}

/** What the caller passes to `enqueue` — tick/seq/payload get defaults. */
export interface NewCommand {
  kind: string;
  tick?: number;
  issuer: string;
  seq?: number;
  payload?: Record<string, unknown>;
}

/** A command plus the value its `apply` returned (e.g. the assigned id). */
export interface AppliedCommand {
  command: Command;
  result: unknown;
}

/** Thrown when a command is invalid. `reason` is the human-readable why. */
export class CommandRejectedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`command rejected: ${reason}`);
    this.name = 'CommandRejectedError';
    this.reason = reason;
  }
}

/** Validation + application logic for one command kind. */
export interface CommandSpec {
  /** Return null when valid, or the rejection reason when not. Pure. */
  validate(cmd: Command, world: World): string | null;
  /** Mutate the world. May return a result (recorded on AppliedCommand). */
  apply(cmd: Command, world: World): unknown;
}

export interface CommandQueue {
  /** Register a command kind. Re-registering a kind throws. */
  register(kind: string, spec: CommandSpec): void;
  /** Validate + queue. Throws CommandRejectedError on any problem. */
  enqueue(world: World, cmd: NewCommand): void;
  /**
   * Apply every command with `tick <= atTick`, in (tick, issuer, seq) order.
   * Re-validates each at apply time and throws on stale commands. Returns
   * the applied commands with their results.
   */
  applyDue(world: World, atTick: number): AppliedCommand[];
  /** Number of commands still queued. */
  pendingCount(): number;
  /** Drop everything queued (used by tests, not by the game). */
  clear(): void;
}

/** Deterministic total order: tick, then issuer (lexicographic), then seq. */
function compareCommands(a: Command, b: Command): number {
  if (a.tick !== b.tick) return a.tick - b.tick;
  if (a.issuer !== b.issuer) return a.issuer < b.issuer ? -1 : 1;
  return a.seq - b.seq;
}

export function createCommandQueue(): CommandQueue {
  const specs = new Map<string, CommandSpec>();
  const pending: Command[] = [];
  let insertionCounter = 0;

  function reject(reason: string): never {
    throw new CommandRejectedError(reason);
  }

  return {
    register(kind: string, spec: CommandSpec): void {
      if (specs.has(kind)) {
        throw new Error(`command kind already registered: '${kind}'`);
      }
      specs.set(kind, spec);
    },

    enqueue(world: World, input: NewCommand): void {
      const spec = specs.get(input.kind);
      if (!spec) reject(`unknown command kind '${input.kind}'`);
      if (typeof input.issuer !== 'string' || input.issuer.length === 0) {
        reject('command issuer must be a non-empty string');
      }
      const tick = input.tick ?? world.tick;
      if (!Number.isInteger(tick) || tick < world.tick) {
        reject(`command tick must be an integer >= current tick ${world.tick}, got ${input.tick}`);
      }
      const seq = input.seq ?? insertionCounter;
      if (!Number.isInteger(seq) || seq < 0) {
        reject(`command seq must be a non-negative integer, got ${input.seq}`);
      }
      const cmd: Command = {
        kind: input.kind,
        tick,
        issuer: input.issuer,
        seq,
        payload: input.payload ?? {},
      };
      const reason = (spec as CommandSpec).validate(cmd, world);
      if (reason !== null) reject(reason);
      insertionCounter += 1;
      pending.push(cmd);
    },

    applyDue(world: World, atTick: number): AppliedCommand[] {
      const due = pending.filter((c) => c.tick <= atTick);
      // Remove the due commands before applying: a throwing apply can't
      // leave the queue in a half-drained state on retry.
      for (const c of due) {
        const i = pending.indexOf(c);
        pending.splice(i, 1);
      }
      due.sort(compareCommands); // V8 sort is stable; comparator is total.
      const applied: AppliedCommand[] = [];
      for (const cmd of due) {
        const spec = specs.get(cmd.kind) as CommandSpec;
        const reason = spec.validate(cmd, world);
        if (reason !== null) {
          reject(`stale command '${cmd.kind}' from '${cmd.issuer}' no longer valid: ${reason}`);
        }
        applied.push({ command: cmd, result: spec.apply(cmd, world) });
      }
      return applied;
    },

    pendingCount(): number {
      return pending.length;
    },

    clear(): void {
      pending.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Core command kinds (the minimal set step 3 needs; systems add their own).
// ---------------------------------------------------------------------------

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

function payloadNumber(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' ? v : null;
}

const spawnSpec: CommandSpec = {
  validate(cmd: Command, _world: World): string | null {
    const kind = payloadString(cmd.payload, 'kind');
    if (kind === null || kind.length === 0) {
      return 'spawn: payload.kind must be a non-empty string';
    }
    const x = payloadNumber(cmd.payload, 'x');
    const z = payloadNumber(cmd.payload, 'z');
    if (x === null || !Number.isFinite(x)) return `spawn: payload.x must be a finite number`;
    if (z === null || !Number.isFinite(z)) return `spawn: payload.z must be a finite number`;
    return null;
  },
  apply(cmd: Command, world: World): unknown {
    const entity = spawnEntity(
      world,
      cmd.payload['kind'] as string,
      cmd.payload['x'] as number,
      cmd.payload['z'] as number,
    );
    return entity.id;
  },
};

const despawnSpec: CommandSpec = {
  validate(cmd: Command, world: World): string | null {
    const id = payloadNumber(cmd.payload, 'id');
    if (id === null || !Number.isInteger(id) || id < 0) {
      return `despawn: payload.id must be a non-negative integer`;
    }
    if (!findEntity(world, id)) return `despawn: no entity with id ${id}`;
    return null;
  },
  apply(cmd: Command, world: World): unknown {
    return despawnEntity(world, cmd.payload['id'] as number);
  },
};

/** Register the core command kinds on a fresh queue. */
export function registerCoreCommands(queue: CommandQueue): void {
  queue.register('spawn', spawnSpec);
  queue.register('despawn', despawnSpec);
}
