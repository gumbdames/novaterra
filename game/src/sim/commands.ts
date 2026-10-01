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
import type { AIPlayerState } from './ai';
import { BUILDING_DEFS, cellCenterWorld, getPlayer, LOGISTICS_RADIUS } from './city';
import type { BuildingRecord } from './city';
import { effectiveAmmoStorage, effectiveFuelStorage } from './upgrades';
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

/**
 * Sea-logistics Half B (2026-10-01): the validated, fully-computed
 * outcome of a `loadCargo` / `unloadCargo` order. The AD6 validate≡apply
 * lesson: the enqueue-time validate and the apply-time re-validate both
 * run THIS function, so they agree by construction. Returns the loud
 * rejection reason, or the plan the apply must execute verbatim.
 */
interface CargoTransferPlan {
  unit: UnitRecord;
  depot: BuildingRecord;
  /** Amounts the apply moves verbatim (whole units; floats for fuel). */
  fuel: number;
  ammo: number;
  materials: number;
}

/**
 * Pure shared validate+compute for `loadCargo` / `unloadCargo`.
 *
 * A supply unit (any def with cargo capacity — the sea fuelTanker /
 * ammoShip, the land trucks, the depot ship) transfers cargo with a
 * friendly completed NAVAL load point: a reload point whose footprint
 * center is on water (navalYard, navalBase, ports — data-driven). The
 * unit must be inside the depot's `LOGISTICS_RADIUS` — the same radius
 * as the supply aura, so "park at the gate, then order" works. The
 * shipyard is deliberately NOT a load point: it is a dry production
 * building with no stocks (see docs/research/sea-logistics-
 * military.md §3.5). Same-side only: the defs' `military` flag must
 * match on both ends — a military hull never loads/unloads at a
 * civilian harbor and a civilian hull never draws military stocks
 * (the naval-building model's civilian/military split).
 *
 *   - loadCargo: fuel/ammo move from the depot's stocks — never from
 *     another unit's resupply reservations (the serveDepotUnit rule);
 *     materials move from the OWNER's materials stockpile (no building
 *     stocks materials — the depot is only the loading point).
 *   - unloadCargo: fuel → fuelStock (effective storage headroom),
 *     ammo → ammoStock (effective headroom), materials → materialsStock
 *     (raw def headroom — no upgrade touches materialsStorage yet).
 *
 * Partial transfers are fine (whatever fits moves); the rejection is
 * loud only when NOTHING can transfer. Peaceful worlds reject like
 * attackBuilding (combat.ts) — the supply ships are military units.
 */
function computeCargoTransfer(
  world: World,
  t: TerrainData,
  cmdName: 'loadCargo' | 'unloadCargo',
  unitId: unknown,
  buildingId: unknown,
  owner: unknown,
): CargoTransferPlan | string {
  if (world.peaceful === true) return `${cmdName}: not available in peaceful mode`;
  if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
    return `${cmdName}: payload.unitId must be a positive integer`;
  }
  if (typeof buildingId !== 'number' || !Number.isInteger(buildingId) || buildingId <= 0) {
    return `${cmdName}: payload.buildingId must be a positive integer`;
  }
  if (typeof owner !== 'number' || !Number.isInteger(owner)) {
    return `${cmdName}: payload.owner must be an integer`;
  }
  const unit = findUnit(world, unitId);
  if (!unit) return `${cmdName}: no unit with id ${unitId}`;
  if (unit.owner !== owner) return `${cmdName}: unit ${unitId} is not owned by player ${owner}`;
  const udef = UNIT_DEFS[unit.kind as UnitKind];
  const hasHold =
    (udef?.cargoFuelCapacity ?? 0) > 0 ||
    (udef?.cargoAmmoCapacity ?? 0) > 0 ||
    (udef?.cargoMaterialsCapacity ?? 0) > 0;
  if (!udef || !hasHold) {
    return `${cmdName}: unit ${unitId} (${unit.kind}) is not a supply unit (no cargo capacity)`;
  }
  const depot = findDepotBuilding(world, buildingId);
  if (!depot) return `${cmdName}: no building with id ${buildingId}`;
  if (depot.owner !== owner) return `${cmdName}: building ${buildingId} is not owned by player ${owner}`;
  if (depot.progress < 1) return `${cmdName}: building ${buildingId} is still under construction`;
  const bdef = BUILDING_DEFS[depot.kind];
  if (!bdef || !bdef.reloadPoint) {
    return `${cmdName}: building ${buildingId} (${depot.kind}) is not a naval supply point`;
  }
  // Naval-building model (2026-10-01): the civilian/military cargo
  // split. Military supply ships (fuelTanker, ammoShip) load/unload
  // ONLY at military naval points (navalYard, navalBase); civilian
  // cargo ships (fuelBarge, cargoFreighter, the depot-ship variant)
  // ONLY at civilian harbors (commercialHarbor, commercialPort). A
  // military hull at a civilian harbor — or the reverse — is a loud
  // rejection, never a silent cross-side stock transfer.
  const unitSide = !!udef.military;
  const depotSide = !!bdef.military;
  if (unitSide !== depotSide) {
    const want = unitSide ? 'military' : 'civilian';
    return (
      `${cmdName}: unit ${unitId} (${unit.kind}) is ${want} but building ` +
      `${buildingId} (${depot.kind}) is not — cargo transfers only ` +
      `between same-side ships and naval points`
    );
  }
  const x = cellCenterWorld(depot.cx + (bdef.footprintW - 1) / 2);
  const z = cellCenterWorld(depot.cz + (bdef.footprintH - 1) / 2);
  if (!isWater(t, x, z)) {
    return `${cmdName}: building ${buildingId} (${depot.kind}) is not on water (naval supply point required)`;
  }
  const dx = unit.x - x;
  const dz = unit.z - z;
  if (dx * dx + dz * dz > LOGISTICS_RADIUS * LOGISTICS_RADIUS) {
    return `${cmdName}: unit ${unitId} is out of range of building ${buildingId} (move inside its supply radius)`;
  }
  let fuel = 0;
  let ammo = 0;
  let materials = 0;
  if (cmdName === 'loadCargo') {
    const fuelNeed = Math.max(0, (udef.cargoFuelCapacity ?? 0) - unit.cargoFuel);
    if (fuelNeed > 0) {
      fuel = Math.min(fuelNeed, Math.max(0, (depot.fuelStock ?? 0) - (depot.reservedFuel ?? 0)));
    }
    const ammoNeed = Math.floor(Math.max(0, (udef.cargoAmmoCapacity ?? 0) - unit.cargoAmmo));
    if (ammoNeed >= 1) {
      ammo = Math.min(ammoNeed, Math.max(0, Math.floor((depot.ammoStock ?? 0) - (depot.reservedAmmo ?? 0))));
    }
    const matNeed = Math.floor(Math.max(0, (udef.cargoMaterialsCapacity ?? 0) - unit.cargoMaterials));
    if (matNeed >= 1) {
      const player = getPlayer(world.city, owner);
      materials = Math.min(matNeed, Math.max(0, Math.floor(player?.materials ?? 0)));
    }
    if (fuel <= 0 && ammo <= 0 && materials <= 0) {
      return `${cmdName}: nothing to load — unit ${unitId} holds are full or building ${buildingId} has no available stock`;
    }
  } else {
    const fuelRoom = Math.max(0, effectiveFuelStorage(world, owner, bdef) - (depot.fuelStock ?? 0));
    if (fuelRoom > 0 && unit.cargoFuel > 0) {
      fuel = Math.min(unit.cargoFuel, fuelRoom);
    }
    const ammoRoom = Math.max(0, effectiveAmmoStorage(world, owner, bdef) - (depot.ammoStock ?? 0));
    if (ammoRoom > 0) {
      const shells = Math.floor(unit.cargoAmmo);
      if (shells >= 1) ammo = Math.min(shells, Math.floor(ammoRoom));
    }
    const matRoom = Math.max(0, (bdef.materialsStorage ?? 0) - (depot.materialsStock ?? 0));
    if (matRoom > 0) {
      const crates = Math.floor(unit.cargoMaterials);
      if (crates >= 1) materials = Math.min(crates, Math.floor(matRoom));
    }
    if (fuel <= 0 && ammo <= 0 && materials <= 0) {
      return `${cmdName}: nothing to unload — unit ${unitId} holds are empty or building ${buildingId} has no storage headroom`;
    }
  }
  return { unit, depot, fuel, ammo, materials };
}

/** A validated `loadCargoVirtual` transfer plan. */
interface VirtualCargoPlan {
  unit: UnitRecord;
  /** The AI player record whose abstract stocks are drawn from. */
  ai: AIPlayerState;
  fuel: number;
  ammo: number;
}

/**
 * Pure shared validate+compute for `loadCargoVirtual` (A10).
 *
 * The AI's virtual docks: fuel/ammo move from the AI's abstract stocks
 * into a supply unit's holds. Mirrors computeCargoTransfer's transfer
 * economics (hold caps, stock limits, ammo floored, fuel fractional;
 * partial transfers move whatever fits, loud only when nothing can).
 * The owner must be an AI player with a completed virtual navalBase —
 * the virtual counterpart of loadCargo's naval-supply-point rule.
 */
function computeVirtualCargoLoad(
  world: World,
  cmdName: 'loadCargoVirtual',
  unitId: unknown,
  owner: unknown,
): VirtualCargoPlan | string {
  if (world.peaceful === true) return `${cmdName}: not available in peaceful mode`;
  if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
    return `${cmdName}: payload.unitId must be a positive integer`;
  }
  if (typeof owner !== 'number' || !Number.isInteger(owner)) {
    return `${cmdName}: payload.owner must be an integer`;
  }
  const unit = findUnit(world, unitId);
  if (!unit) return `${cmdName}: no unit with id ${unitId}`;
  if (unit.owner !== owner) return `${cmdName}: unit ${unitId} is not owned by player ${owner}`;
  const udef = UNIT_DEFS[unit.kind as UnitKind];
  const hasHold = (udef?.cargoFuelCapacity ?? 0) > 0 || (udef?.cargoAmmoCapacity ?? 0) > 0;
  if (!udef || !hasHold) {
    return `${cmdName}: unit ${unitId} (${unit.kind}) is not a supply unit (no cargo capacity)`;
  }
  const ai = world.ai.players.find((a) => a.owner === owner);
  if (!ai) return `${cmdName}: player ${owner} is not an AI player`;
  if (!ai.virtualBuildings.completed.includes('navalBase')) {
    return `${cmdName}: player ${owner} has no completed virtual navalBase (the AI's docks)`;
  }
  const fuelNeed = Math.max(0, (udef.cargoFuelCapacity ?? 0) - unit.cargoFuel);
  const ammoNeed = Math.max(0, Math.floor((udef.cargoAmmoCapacity ?? 0) - unit.cargoAmmo));
  let fuel = 0;
  let ammo = 0;
  if (fuelNeed > 0) fuel = Math.min(fuelNeed, ai.virtualFuelStock ?? 0);
  if (ammoNeed >= 1) ammo = Math.min(ammoNeed, Math.floor(ai.virtualAmmoStock ?? 0));
  if (fuel <= 0 && ammo <= 0) {
    return `${cmdName}: nothing to load — unit ${unitId} holds are full or player ${owner} virtual stocks are empty`;
  }
  return { unit, ai, fuel, ammo };
}

/** Register the Phase 3 logistics command kinds on a fresh queue. */
export function registerLogisticsCommands(queue: CommandQueue, t: TerrainData): void {  // Self-scheduled cleanup, enqueued by the `resupply` apply. Never
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

  // Sea-logistics Half B (2026-10-01): `loadCargo` — the player-driven
  // load side of the cargo loop. The depot aura (serveDepotUnit) loads
  // automatically when a supply ship parks in radius; this order gives
  // explicit control (e.g. load at a rear-area port, then sail to a
  // forward navalBase) and is how a ship takes materials aboard. The
  // transfer is immediate — the unit must already be inside the
  // depot's LOGISTICS_RADIUS. Validate≡apply via computeCargoTransfer
  // (AD6); loud rejections, peaceful-mode rejection like
  // attackBuilding.
  queue.register('loadCargo', {
    validate(cmd, world): string | null {
      const plan = computeCargoTransfer(
        world, t, 'loadCargo', cmd.payload['unitId'], cmd.payload['buildingId'], cmd.payload['owner'],
      );
      return typeof plan === 'string' ? plan : null;
    },
    apply(cmd, world): unknown {
      const plan = computeCargoTransfer(
        world, t, 'loadCargo', cmd.payload['unitId'], cmd.payload['buildingId'], cmd.payload['owner'],
      );
      if (typeof plan === 'string') throw new CommandRejectedError(plan);
      const { unit, depot, fuel, ammo, materials } = plan;
      if (fuel > 0) {
        depot.fuelStock = (depot.fuelStock ?? 0) - fuel;
        unit.cargoFuel += fuel;
      }
      if (ammo > 0) {
        depot.ammoStock = (depot.ammoStock ?? 0) - ammo;
        unit.cargoAmmo += ammo;
      }
      if (materials > 0) {
        const player = getPlayer(world.city, unit.owner);
        if (player) player.materials = (player.materials ?? 0) - materials;
        unit.cargoMaterials += materials;
      }
      return { unit: unit.id, depot: depot.id, fuel, ammo, materials };
    },
  });

  // Sea-logistics Half B (2026-10-01): `unloadCargo` — the player-driven
  // discharge side. Fuel → the depot's fuelStock (effective storage
  // headroom), ammo → ammoStock (effective headroom), materials →
  // materialsStock (raw def headroom — no upgrade touches
  // materialsStorage yet). Partial transfers move whatever fits; loud
  // when nothing can move. This is how a navalBase's forward caches
  // get filled: a fuelTanker/ammoShip sails in loaded and unloads.
  queue.register('unloadCargo', {
    validate(cmd, world): string | null {
      const plan = computeCargoTransfer(
        world, t, 'unloadCargo', cmd.payload['unitId'], cmd.payload['buildingId'], cmd.payload['owner'],
      );
      return typeof plan === 'string' ? plan : null;
    },
    apply(cmd, world): unknown {
      const plan = computeCargoTransfer(
        world, t, 'unloadCargo', cmd.payload['unitId'], cmd.payload['buildingId'], cmd.payload['owner'],
      );
      if (typeof plan === 'string') throw new CommandRejectedError(plan);
      const { unit, depot, fuel, ammo, materials } = plan;
      if (fuel > 0) {
        depot.fuelStock = (depot.fuelStock ?? 0) + fuel;
        unit.cargoFuel -= fuel;
      }
      if (ammo > 0) {
        depot.ammoStock = (depot.ammoStock ?? 0) + ammo;
        unit.cargoAmmo -= ammo;
      }
      if (materials > 0) {
        depot.materialsStock = (depot.materialsStock ?? 0) + materials;
        unit.cargoMaterials -= materials;
      }
      return { unit: unit.id, depot: depot.id, fuel, ammo, materials };
    },
  });

  // A10 (2026-10-01): `loadCargoVirtual` — the AI's counterpart to
  // `loadCargo`. The Classic AI owns no physical buildings, so it can
  // never park at a physical naval supply point; its completed virtual
  // navalBase is its docks. Fuel/ammo move from the AI's abstract
  // virtual stocks (credited at honest production economics — see
  // creditVirtualDepotStocks in ai.ts) into the supply ship's holds,
  // through the command queue like the player's: validated at enqueue
  // AND at apply, deterministic, loud when nothing can transfer.
  // AI-only by construction (the owner must be an AI player with a
  // completed virtual navalBase); the human path stays the physical
  // `loadCargo`. Same transfer economics as computeCargoTransfer:
  // partial transfers move whatever fits, ammo is floored, fuel is
  // fractional. Peaceful worlds reject like loadCargo.
  queue.register('loadCargoVirtual', {
    validate(cmd, world): string | null {
      const plan = computeVirtualCargoLoad(
        world, 'loadCargoVirtual', cmd.payload['unitId'], cmd.payload['owner'],
      );
      return typeof plan === 'string' ? plan : null;
    },
    apply(cmd, world): unknown {
      const plan = computeVirtualCargoLoad(
        world, 'loadCargoVirtual', cmd.payload['unitId'], cmd.payload['owner'],
      );
      if (typeof plan === 'string') throw new CommandRejectedError(plan);
      const { unit, ai, fuel, ammo } = plan;
      if (fuel > 0) {
        ai.virtualFuelStock = (ai.virtualFuelStock ?? 0) - fuel;
        unit.cargoFuel += fuel;
      }
      if (ammo > 0) {
        ai.virtualAmmoStock = (ai.virtualAmmoStock ?? 0) - ammo;
        unit.cargoAmmo += ammo;
      }
      return { unit: unit.id, fuel, ammo };
    },
  });
}
