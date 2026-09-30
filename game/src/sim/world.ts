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
 * NOVATERRA — sim/world.ts — the world store (plain data only).
 *
 * Responsibilities:
 *  - The single source of truth for simulation state: tick counter, sim
 *    time, entity registry, RNG state. Everything here is interfaces +
 *    factory functions — no methods on state, nothing unserializable.
 *  - Stable numeric entity ids (`nextId` counter; id 0 is reserved and never
 *    assigned, so "no entity" has a safe sentinel).
 *
 * Deterministic iteration (the determinism contract, see AGENTS.md):
 *  - `entities` is a plain array in spawn order. It is NEVER reordered;
 *    despawn uses splice so the surviving order stays spawn order.
 *  - Systems must iterate `world.entities` directly (id-ascending, since
 *    ids are assigned in spawn order). Never build a `Map`/`Set` over
 *    entities and iterate it for sim logic — iterate the array.
 *  - `despawnEntity` is O(n); acceptable until the ECS perf step (Phase 1,
 *    step 6) replaces the store with a measured design.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { RngState } from './rng';
import { createRngBank } from './rng';
import type { RngBank } from './rng';
import type { CityState } from './city';
import { initCity } from './city';
import type { UnitRecord } from './units';
import type { PathfindingState } from './pathfinding';
import { initPathfinding } from './pathfinding';
import type { AIState } from './ai';
import { initAI } from './ai';
import type { AgeState } from './ages';
import { initAges } from './ages';
import type { DelegationState } from './delegation';
import { initDelegation } from './delegation';
import type { SuperweaponState } from './superweapons';
import { initSuperweapons } from './superweapons';
import { initUpgrades } from './upgrades';

/** Minimal per-entity record. Later steps add components; the shape stays plain. */
export interface EntityRecord {
  /** Stable numeric id, assigned from `world.nextId`. Never reused. */
  id: number;
  /** Kind tag, e.g. 'settler', 'farm', 'tank'. Free-form for now. */
  kind: string;
  /** Position on the ground plane (y-up world). Plain numbers, no vectors. */
  x: number;
  z: number;
}

/** The whole simulation state. Plain data — snapshot() copies it verbatim. */
export interface World {
  /** Simulation tick counter. Advances by exactly 1 per tick. */
  tick: number;
  /** Sim time in seconds. Always `tick / TICK_HZ` — never accumulated, so no float drift. */
  time: number;
  /** Master seed: map generation + RNG stream derivation. */
  seed: number;
  /** Next entity id to assign. Id 0 is reserved (never assigned). */
  nextId: number;
  /** Entity registry in spawn order. See module docs for iteration rules. */
  entities: EntityRecord[];
  /** All RNG stream states. Part of every snapshot. */
  rng: RngState;
  /** City state: roads, zones, buildings, players. Snapshotted + digested. */
  city: CityState;
  /** Mobile units, in spawn order. Snapshotted + digested. */
  units: UnitRecord[];
  /** Pathfinding coordinator state (queues + live flow fields). Snapshotted + digested. */
  pathfinding: PathfindingState;
  /** Classic AI state (per-player difficulty, timers, strategy). Snapshotted + digested. */
  ai: AIState;
  /** Age state (Foundation → Connectivity + National Program). Snapshotted + digested. */
  ages: AgeState;
  /** Chain-of-command delegations (mayors, generals). Snapshotted + digested. */
  delegation: DelegationState;
  /** Superweapon slots, scheduled strikes, fx. Snapshotted + digested. */
  superweapons: SuperweaponState;
  /** Per-player researched upgrade ids (spec docs/research/roster-expansion.md §4). */
  upgrades: Record<number, string[]>;
  /**
   * Grand-expansion Phase 8 (peaceful mode, 2026-09-30): true when this
   * world plays peaceful — rivals exist but play peacefully; military
   * defs (units/buildings/upgrades — see the `military` def flag) and
   * covert ops are locked out at the command layer, conquest victory
   * checks are bypassed, and the peaceful victory
   * (`checkPeacefulVictory`) applies instead. Set at tick 0 from
   * `SessionOptions.peaceful` and NEVER toggled mid-game (the lockout
   * validates only at enqueue because the flag is immutable).
   * Snapshotted and digested; legacy snapshots decode to false (no
   * version bump — the AD9 neutral-default precedent).
   */
  peaceful: boolean;
}

/** First assignable entity id (0 stays reserved as the "no entity" sentinel). */
export const FIRST_ENTITY_ID = 1;

/** Create a fresh world at tick 0. */
export function createWorld(seed: number): World {
  return {
    tick: 0,
    time: 0,
    seed: seed >>> 0,
    nextId: FIRST_ENTITY_ID,
    entities: [],
    rng: {},
    city: initCity(),
    units: [],
    pathfinding: initPathfinding(),
    ai: initAI(),
    ages: initAges(),
    delegation: initDelegation(),
    superweapons: initSuperweapons(),
    upgrades: initUpgrades(),
    // Peaceful defaults to false; the session sets it from
    // SessionOptions.peaceful for fresh worlds, restoreSnapshot for saves.
    peaceful: false,
  };
}

/** Spawn an entity. Returns the new record (also appended to `world.entities`). */
export function spawnEntity(world: World, kind: string, x: number, z: number): EntityRecord {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error(`spawnEntity: kind must be a non-empty string, got ${JSON.stringify(kind)}`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error(`spawnEntity: x/z must be finite numbers, got ${x}, ${z}`);
  }
  const record: EntityRecord = { id: world.nextId, kind, x, z };
  world.nextId += 1;
  world.entities.push(record);
  return record;
}

/** Remove an entity by id. Returns true if one was removed, false if absent. */
export function despawnEntity(world: World, id: number): boolean {
  const index = world.entities.findIndex((e) => e.id === id);
  if (index === -1) return false;
  // splice (not swap-remove): survivors keep spawn order, so iteration order
  // stays a pure function of the spawn/despawn history.
  world.entities.splice(index, 1);
  return true;
}

/** Find an entity by id. Linear scan — fine until the ECS perf step. */
export function findEntity(world: World, id: number): EntityRecord | undefined {
  return world.entities.find((e) => e.id === id);
}

/**
 * A live RNG bank over this world's `rng` record. Draws mutate `world.rng`,
 * so they are automatically part of snapshots and digests. Create one per
 * tick (cheap) or per system — the underlying record is what matters.
 */
export function rngBank(world: World): RngBank {
  return createRngBank(world.seed, world.rng);
}
