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
import type { TerrainData } from './terrain';
import { isWater } from './terrain';
import { findUnit, UNIT_DEFS } from './units';
import type { UnitKind, UnitRecord } from './units';
import { BUILDING_DEFS, cellCenterWorld, getPlayer } from './city';
import type { BuildingRecord } from './city';
import { orderMoveTo } from './movement';

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

// ---------------------------------------------------------------------------
// Phase 3 logistics commands (workstream 3): `resupply`, `resupplyTimeout`,
// `setSupplyToggles`.
//
// A `resupply` order is a depot-stock reservation, not a physical convoy:
// at apply time (the single atomic point) the unit's need is computed,
// clamped to the depot's AVAILABLE stock (stock − reserved), added to the
// depot's reserved totals, and the unit is routed to the depot with the
// shared move internals (`orderMoveTo` — no duplicated pathfinding). The
// production workstream's refill aura fulfills the reservation on arrival;
// a self-scheduled `resupplyTimeout` (60 s) releases it if the unit never
// gets there. Death (`killUnit`, combat.ts) and demolition (city.ts)
// release through the helpers below.
// ---------------------------------------------------------------------------

/** Reservation hold: 60 s at 30 Hz before an unfulfilled resupply releases. */
export const RESUPPLY_TIMEOUT_TICKS = 1800;

/**
 * Final-review R5 UI feel (2026-10-01): `emergencyRefuel` pricing.
 * A flat funds fee for the airdropped fuel bladder, granting 30% of
 * the aircraft's tank — enough to reach a depot in most cases, never
 * a full free refill. Exported: the UI names the cost in the
 * selection-panel button's disabled reason.
 */
export const EMERGENCY_REFUEL_COST_FUNDS = 150;
export const EMERGENCY_REFUEL_FRAC = 0.3;

/** The validated outcome of an `emergencyRefuel` order. */
interface EmergencyRefuelPlan {
  unit: UnitRecord;
  def: (typeof UNIT_DEFS)[UnitKind];
  player: { funds: number };
}

/**
 * Shared validate for `emergencyRefuel` (AD6 validate≡apply): the
 * aircraft must be a living, player-owned, fossil-fuel aircraft with
 * an empty tank, and the owner must afford the bladder. Returns the
 * plan or the human-readable rejection.
 */
function checkEmergencyRefuel(
  world: World,
  unitId: unknown,
  owner: unknown,
): EmergencyRefuelPlan | string {
  if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
    return 'emergencyRefuel: payload.unitId must be a positive integer';
  }
  if (typeof owner !== 'number' || !Number.isInteger(owner)) {
    return 'emergencyRefuel: payload.owner must be an integer';
  }
  const unit = findUnit(world, unitId);
  if (!unit) return `emergencyRefuel: no unit with id ${unitId}`;
  if (unit.owner !== owner) {
    return `emergencyRefuel: unit ${unitId} is not owned by player ${owner}`;
  }
  if (unit.hp <= 0) return `emergencyRefuel: unit ${unitId} is destroyed`;
  const def = UNIT_DEFS[unit.kind as UnitKind];
  if (unit.domain !== 'air') {
    return `emergencyRefuel: unit ${unitId} (${unit.kind}) is not an aircraft`;
  }
  if (def?.fuelType !== 'fossil') {
    return `emergencyRefuel: unit ${unitId} (${unit.kind}) does not burn fossil fuel`;
  }
  if ((unit.fuel ?? 0) > 0) {
    return `emergencyRefuel: unit ${unitId} is not stranded (its tank is not empty)`;
  }
  const player = getPlayer(world.city, owner);
  if (!player) return `emergencyRefuel: no player ${owner}`;
  if (player.funds < EMERGENCY_REFUEL_COST_FUNDS) {
    return `emergencyRefuel: needs ${EMERGENCY_REFUEL_COST_FUNDS} funds`;
  }
  return { unit, def, player };
}

function findDepotBuilding(world: World, depotId: number): BuildingRecord | undefined {
  return world.city.buildings.find((b) => b.id === depotId);
}

/** The validated, fully-computed outcome of a `resupply` order. */
interface ResupplyPlan {
  unit: UnitRecord;
  depot: BuildingRecord;
  /** Depot world position (footprint center) — the route target. */
  x: number;
  z: number;
  /** Amounts to reserve (clamped to available stock). */
  ammoReserve: number;
  fuelReserve: number;
}

/**
 * Pure shared validate+compute for `resupply` (the AD6 validate≡apply
 * lesson): the enqueue-time validate and the apply-time re-validate both
 * run THIS function, so they agree by construction. Returns the rejection
 * reason, or the plan the apply must execute verbatim.
 */
function computeResupply(
  world: World,
  t: TerrainData,
  unitId: unknown,
  depotId: unknown,
  owner: unknown,
): ResupplyPlan | string {
  if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
    return 'resupply: payload.unitId must be a positive integer';
  }
  if (typeof depotId !== 'number' || !Number.isInteger(depotId) || depotId <= 0) {
    return 'resupply: payload.depotId must be a positive integer';
  }
  if (typeof owner !== 'number' || !Number.isInteger(owner)) {
    return 'resupply: payload.owner must be an integer';
  }
  const unit = findUnit(world, unitId);
  if (!unit) return `resupply: no unit with id ${unitId}`;
  if (unit.owner !== owner) return `resupply: unit ${unitId} is not owned by player ${owner}`;
  const depot = findDepotBuilding(world, depotId);
  if (!depot) return `resupply: no building with id ${depotId}`;
  if (depot.owner !== owner) return `resupply: depot ${depotId} is not owned by player ${owner}`;
  if (depot.progress < 1) return `resupply: depot ${depotId} is still under construction`;
  const bdef = BUILDING_DEFS[depot.kind];
  if (!bdef || !(bdef.reloadPoint || bdef.ammoStorage || bdef.fuelStorage)) {
    return `resupply: building ${depotId} (${depot.kind}) is not a supply depot`;
  }
  const udef = UNIT_DEFS[unit.kind as UnitKind] ?? UNIT_DEFS.engineer;
  // Nuclear-fuel units never need fuel (exempt); untracked kinds need nothing.
  const fuelCap = udef.fuelType === 'fossil' ? (udef.fuelCapacity ?? 0) : 0;
  const ammoCap = udef.ammoCapacity ?? 0;
  const fuelNeed = fuelCap > 0 ? Math.max(0, fuelCap - unit.fuel) : 0;
  const ammoNeed = ammoCap > 0 ? Math.max(0, ammoCap - unit.ammo) : 0;
  if (fuelNeed <= 0 && ammoNeed <= 0) {
    return `resupply: unit ${unitId} (${unit.kind}) needs no supply (fuel and ammo full)`;
  }
  // Availability = stock − reserved, crediting back this unit's own live
  // reservation at THIS depot: apply releases it first, so validate must
  // see the identical pool (same-tick re-issue agrees by construction).
  const ownAmmo = unit.resupplyDepotId === depotId ? (unit.resupplyReservedAmmo ?? 0) : 0;
  const ownFuel = unit.resupplyDepotId === depotId ? (unit.resupplyReservedFuel ?? 0) : 0;
  const ammoAvail = Math.max(0, (depot.ammoStock ?? 0) - (depot.reservedAmmo ?? 0) + ownAmmo);
  const fuelAvail = Math.max(0, (depot.fuelStock ?? 0) - (depot.reservedFuel ?? 0) + ownFuel);
  const ammoReserve = Math.min(ammoNeed, ammoAvail);
  const fuelReserve = Math.min(fuelNeed, fuelAvail);
  // A real need must get real stock: otherwise this is the contention
  // loser and the rejection is loud (the second unit gets the remainder,
  // or this rejection — never a silent zero-reservation).
  if ((ammoNeed <= 0 || ammoReserve <= 0) && (fuelNeed <= 0 || fuelReserve <= 0)) {
    return `resupply: depot ${depotId} has no available ammo or fuel for unit ${unitId}`;
  }
  // Final-review R1 (M18, 2026-10-01): route to the depot's FOOTPRINT
  // CENTER, not its corner cell. (cx, cz) is the footprint origin — for
  // a 3x3 depot the corner target was up to ~2 cells off, sending units
  // to the building's edge instead of its middle.
  const x = cellCenterWorld(depot.cx + (bdef.footprintW - 1) / 2);
  const z = cellCenterWorld(depot.cz + (bdef.footprintH - 1) / 2);
  const water = isWater(t, x, z);
  if (unit.domain === 'land' && water) {
    return `resupply: depot ${depotId} is on water (land units cannot reach it)`;
  }
  if (unit.domain === 'sea' && !water) {
    return `resupply: depot ${depotId} is on land (sea units cannot resupply there)`;
  }
  return { unit, depot, x, z, ammoReserve, fuelReserve };
}

/**
 * Release one unit's in-flight depot reservation back into the depot's
 * available pool and clear the unit-side linkage. Idempotent: a unit with
 * no reservation — or whose depot is already gone — is a no-op. Called
 * from `killUnit` (combat.ts), the `resupplyTimeout` apply, and the
 * `resupply` apply itself (re-issue / retarget).
 */
export function releaseUnitReservation(world: World, unit: UnitRecord): void {
  const depotId = unit.resupplyDepotId ?? 0;
  if (depotId <= 0) return;
  const depot = findDepotBuilding(world, depotId);
  if (depot) {
    depot.reservedAmmo = Math.max(0, (depot.reservedAmmo ?? 0) - (unit.resupplyReservedAmmo ?? 0));
    depot.reservedFuel = Math.max(0, (depot.reservedFuel ?? 0) - (unit.resupplyReservedFuel ?? 0));
  }
  unit.resupplyDepotId = 0;
  unit.resupplyReservedAmmo = 0;
  unit.resupplyReservedFuel = 0;
}

/**
 * Release every in-flight reservation against a depot that is going away
 * (demolished). The depot's stocks vanish with it, so there is nothing to
 * credit back — only the unit-side linkage is cleared. Called from the
 * `demolish` command (city.ts). Id-ordered, deterministic.
 */
export function releaseDepotReservations(world: World, depotId: number): void {
  for (const u of world.units) {
    if ((u.resupplyDepotId ?? 0) === depotId) {
      u.resupplyDepotId = 0;
      u.resupplyReservedAmmo = 0;
      u.resupplyReservedFuel = 0;
    }
  }
}

/** Register the Phase 3 logistics command kinds on a fresh queue. */
export function registerLogisticsCommands(queue: CommandQueue, t: TerrainData): void {
  // Self-scheduled cleanup, enqueued by the `resupply` apply. Never
  // rejects at enqueue (only the resupply apply enqueues it, always
  // well-formed) and never goes stale at apply: a dead, fulfilled, or
  // retargeted unit is a no-op, not an error — a firing timeout can never
  // break the tick.
  queue.register('resupplyTimeout', {
    validate(cmd): string | null {
      const unitId = cmd.payload['unitId'];
      const depotId = cmd.payload['depotId'];
      if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
        return 'resupplyTimeout: payload.unitId must be a positive integer';
      }
      if (typeof depotId !== 'number' || !Number.isInteger(depotId) || depotId <= 0) {
        return 'resupplyTimeout: payload.depotId must be a positive integer';
      }
      return null;
    },
    apply(cmd, world): unknown {
      const unitId = cmd.payload['unitId'] as number;
      const depotId = cmd.payload['depotId'] as number;
      const unit = findUnit(world, unitId);
      if (!unit || (unit.resupplyDepotId ?? 0) !== depotId) return 'stale';
      releaseUnitReservation(world, unit);
      return 'released';
    },
  });

  queue.register('resupply', {
    validate(cmd, world): string | null {
      const plan = computeResupply(world, t, cmd.payload['unitId'], cmd.payload['depotId'], cmd.payload['owner']);
      return typeof plan === 'string' ? plan : null;
    },
    apply(cmd, world): unknown {
      const plan = computeResupply(world, t, cmd.payload['unitId'], cmd.payload['depotId'], cmd.payload['owner']);
      if (typeof plan === 'string') throw new CommandRejectedError(plan);
      const { unit, depot, x, z, ammoReserve, fuelReserve } = plan;
      const alreadyGuarded = (unit.resupplyDepotId ?? 0) === depot.id;
      // Release any previous reservation first (re-issue and retarget both
      // land here) — validate credited it back, so apply sees the pool
      // validate saw. This is the single atomic point (AD6).
      releaseUnitReservation(world, unit);
      depot.reservedAmmo = (depot.reservedAmmo ?? 0) + ammoReserve;
      depot.reservedFuel = (depot.reservedFuel ?? 0) + fuelReserve;
      unit.resupplyDepotId = depot.id;
      unit.resupplyReservedAmmo = ammoReserve;
      unit.resupplyReservedFuel = fuelReserve;
      // Route via the shared move internals (no duplicated pathfinding).
      orderMoveTo(world, unit, x, z);
      // Self-scheduled timeout: 60 s to reach the depot. Skipped when the
      // unit already held THIS depot's reservation — the original timeout
      // still guards it, and re-issuing must not extend the hold forever.
      if (!alreadyGuarded) {
        queue.enqueue(world, {
          kind: 'resupplyTimeout',
          tick: world.tick + RESUPPLY_TIMEOUT_TICKS,
          issuer: cmd.issuer,
          payload: { unitId: unit.id, depotId: depot.id },
        });
      }
      return { unit: unit.id, depot: depot.id, ammo: ammoReserve, fuel: fuelReserve };
    },
  });

  // Final-review R5 UI feel (2026-10-01): `emergencyRefuel` — the
  // stranded-aircraft affordance. A fossil-fuel aircraft with an empty
  // tank cannot move (movement.ts `fuelGateOk` fails its orders LOUDLY),
  // and the normal `resupply` flow can't help — it requires the unit to
  // FLY to a depot. This command airdrops a fuel bladder: flat funds
  // cost, +30% tank, and the 'out of fuel' failure is cleared so the
  // aircraft accepts orders again. Nuclear-fuel aircraft never strand
  // (exempt from the fuel gate), so they are rejected here.
  queue.register('emergencyRefuel', {
    validate(cmd, world): string | null {
      const r = checkEmergencyRefuel(world, cmd.payload['unitId'], cmd.payload['owner']);
      return typeof r === 'string' ? r : null;
    },
    apply(cmd, world): unknown {
      const r = checkEmergencyRefuel(world, cmd.payload['unitId'], cmd.payload['owner']);
      if (typeof r === 'string') throw new CommandRejectedError(r);
      const { unit, def, player } = r;
      player.funds -= EMERGENCY_REFUEL_COST_FUNDS;
      unit.fuel = Math.max(
        1,
        Math.ceil((def.fuelCapacity ?? 0) * EMERGENCY_REFUEL_FRAC),
      );
      // Un-strand: a failed 'out of fuel' order becomes idle again.
      if (unit.state === 'failed' && unit.failReason === 'out of fuel') {
        unit.state = 'idle';
        unit.failReason = null;
      }
      return unit.id;
    },
  });

  queue.register('setSupplyToggles', {
    validate(cmd, world): string | null {
      const unitId = cmd.payload['unitId'];
      const owner = cmd.payload['owner'];
      if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
        return 'setSupplyToggles: payload.unitId must be a positive integer';
      }
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'setSupplyToggles: payload.owner must be an integer';
      }
      const unit = findUnit(world, unitId);
      if (!unit) return `setSupplyToggles: no unit with id ${unitId}`;
      if (unit.owner !== owner) return `setSupplyToggles: unit ${unitId} is not owned by player ${owner}`;
      // A supply kind is a kind with cargo capacity — read from the def
      // (supplyTruck / fuelTruck / hauler carry fuel/ammo for others).
      const def = UNIT_DEFS[unit.kind as UnitKind];
      if (!def || ((def.cargoFuelCapacity ?? 0) <= 0 && (def.cargoAmmoCapacity ?? 0) <= 0)) {
        return `setSupplyToggles: unit ${unitId} (${unit.kind}) is not a supply unit (no cargo capacity)`;
      }
      for (const key of ['repair', 'rearm', 'refuel'] as const) {
        if (typeof cmd.payload[key] !== 'boolean') {
          return `setSupplyToggles: payload.${key} must be a boolean`;
        }
      }
      return null;
    },
    apply(cmd, world): unknown {
      const unit = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
      unit.supplyServices = {
        repair: cmd.payload['repair'] as boolean,
        rearm: cmd.payload['rearm'] as boolean,
        refuel: cmd.payload['refuel'] as boolean,
      };
      return unit.id;
    },
  });
}
