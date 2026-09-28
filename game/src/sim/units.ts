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
 * NOVATERRA — sim/units.ts — the unit store.
 *
 * Responsibilities:
 *  - Plain-data records for mobile entities (units): id, owner, kind,
 *    position, speed, and order state. The full unit roster (8 land + 3 air)
 *    arrives in Phase 1 step 7; this step keeps two placeholder kinds so
 *    the movement substrate has something to move.
 *  - Unit ids come from `world.nextId` (the same counter as entities), so
 *    they are stable, never reused, and never collide with entity ids.
 *  - Movement state lives here too (`path`, `fieldId`, `destX/Z`); the
 *    pathfinding coordinator (`pathfinding.ts`) and the movement system
 *    (`movement.ts`) mutate it. `spawnUnit` is registered here; the move
 *    orders live in `movement.ts` next to the systems that serve them.
 *
 * y-position: units store x/z only; height comes from `heightAt` at
 * movement/render time, so it is never part of snapshots or digests.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { TerrainData } from './terrain';
import { isWater } from './terrain';
import { getPlayer, MAP_HALF_SIZE } from './city';
import type { CommandQueue } from './commands';

/** Placeholder kinds for Phase 1 step 6. The real roster lands in step 7. */
export const UNIT_KINDS = ['civilian', 'soldier'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Order lifecycle. `failed` always carries a `failReason` — never silent. */
export type UnitState = 'idle' | 'awaitingPath' | 'moving' | 'failed';

/** Base speed in world units per second, per kind (Phase 1 engineering choice). */
export const UNIT_BASE_SPEED: Record<UnitKind, number> = {
  civilian: 6,
  soldier: 8,
};

/** A mobile unit. Plain data — snapshot()/digest() cover it verbatim. */
export interface UnitRecord {
  /** Stable id from `world.nextId`. Never reused. */
  id: number;
  /** Kind tag, one of UNIT_KINDS for now. */
  kind: string;
  /** Owning player id (indexes `world.city.players`). */
  owner: number;
  /** Position on the ground plane. */
  x: number;
  z: number;
  /** Speed in world units/second. */
  speed: number;
  /** Order lifecycle state. */
  state: UnitState;
  /** Why the last order failed; null unless state === 'failed'. */
  failReason: string | null;
  /** Current order destination (world coords). Meaningful when moving. */
  destX: number;
  destZ: number;
  /**
   * Where THIS unit actually stops: for single-unit A* orders it equals
   * the destination; for group (flow-field) orders it's a deterministic
   * formation slot near the destination (see `slotOffset` in
   * `movement.ts`) so group members don't stack on one point. Always on
   * land, in the destination's land component.
   */
  arriveX: number;
  arriveZ: number;
  /**
   * Remaining A* waypoints as cell indices (see `pathfinding.ts`). Empty
   * when the unit follows a flow field or has no order. `pathAt` is the
   * index of the next waypoint; earlier entries are already consumed.
   */
  path: number[];
  pathAt: number;
  /** Flow-field id the unit follows (0 = none). See `pathfinding.ts`. */
  fieldId: number;
}

/** Spawn a unit into the world. Returns the new record. Caller validates. */
export function spawnUnit(world: World, kind: string, owner: number, x: number, z: number): UnitRecord {
  const speed = (UNIT_BASE_SPEED[kind as UnitKind] ?? UNIT_BASE_SPEED.civilian) as number;
  const record: UnitRecord = {
    id: world.nextId,
    kind,
    owner,
    x,
    z,
    speed,
    state: 'idle',
    failReason: null,
    destX: x,
    destZ: z,
    arriveX: x,
    arriveZ: z,
    path: [],
    pathAt: 0,
    fieldId: 0,
  };
  world.nextId += 1;
  world.units.push(record);
  return record;
}

/** Find a unit by id. Linear scan — fine until the ECS perf step. */
export function findUnit(world: World, id: number): UnitRecord | undefined {
  return world.units.find((u) => u.id === id);
}

/**
 * Clear a unit's in-flight order state (path + field reference). Queued
 * path requests are the coordinator's job — see `pathfinding.ts`.
 */
export function clearUnitOrder(unit: UnitRecord): void {
  unit.path = [];
  unit.pathAt = 0;
  unit.fieldId = 0;
}

/** Mark an order failed with a loud reason. The unit stops where it is. */
export function failUnitOrder(unit: UnitRecord, reason: string): void {
  clearUnitOrder(unit);
  unit.state = 'failed';
  unit.failReason = reason;
}

/**
 * Register the `spawnUnit` command. Takes the terrain because spawn
 * validates against water (terrain is injected, not stored in the world —
 * the same pattern as `registerCityCommands`). Move orders are registered
 * by `movement.ts`.
 */
export function registerUnitCommands(queue: CommandQueue, t: TerrainData): void {
  queue.register('spawnUnit', {
    validate(cmd, world): string | null {
      const kind = cmd.payload['kind'];
      if (typeof kind !== 'string' || !(UNIT_KINDS as readonly string[]).includes(kind)) {
        return `spawnUnit: kind must be one of ${UNIT_KINDS.join(', ')}`;
      }
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner) || !getPlayer(world.city, owner)) {
        return 'spawnUnit: unknown owner';
      }
      const x = cmd.payload['x'];
      const z = cmd.payload['z'];
      if (typeof x !== 'number' || !Number.isFinite(x)) return 'spawnUnit: payload.x must be a finite number';
      if (typeof z !== 'number' || !Number.isFinite(z)) return 'spawnUnit: payload.z must be a finite number';
      if (Math.abs(x) > MAP_HALF_SIZE || Math.abs(z) > MAP_HALF_SIZE) {
        return `spawnUnit: position (${x}, ${z}) is outside the map`;
      }
      // Terrain is static, so a validate-time water check is stable: it
      // cannot go stale between enqueue and apply.
      if (isWater(t, x, z)) return `spawnUnit: cannot spawn a land unit in water at (${x}, ${z})`;
      return null;
    },
    apply(cmd, world): unknown {
      const unit = spawnUnit(
        world,
        cmd.payload['kind'] as string,
        cmd.payload['owner'] as number,
        cmd.payload['x'] as number,
        cmd.payload['z'] as number,
      );
      return unit.id;
    },
  });
}
