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
 *    position, speed, order state, and combat state (hp, cooldown,
 *    target). The Phase-1 MVP roster is 8 land + 3 air (see C12 in
 *    docs/research/game-design.md).
 *  - Unit ids come from `world.nextId` (the same counter as entities), so
 *    they are stable, never reused, and never collide with entity ids.
 *  - Movement state lives here too (`path`, `fieldId`, `destX/Z`); the
 *    pathfinding coordinator (`pathfinding.ts`) and the movement system
 *    (`movement.ts`) mutate it. `spawnUnit` is registered here; the move
 *    orders live in `movement.ts` next to the systems that serve them;
 *    combat lives in `combat.ts`.
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
import type { Age } from './ages';

/**
 * The Phase-1 MVP roster (C12): 8 land + 3 air. Land: engineer (utility),
 * rifles (infantry), tank (MBT), artillery (long-range fire support), aa
 * (mobile air defense), hauler (logistics), spectre (special ops sabotage),
 * hq (mobile command). Air: fighter (multirole), transport (airlift),
 * drone (cheap expendable swarm).
 */
export const UNIT_KINDS = [
  'engineer',
  'rifles',
  'tank',
  'artillery',
  'aa',
  'hauler',
  'spectre',
  'hq',
  'fighter',
  'transport',
  'drone',
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Which map layer a unit lives on. Air units fly over terrain and water. */
export type UnitDomain = 'land' | 'air';

/** How tough a unit is against incoming fire (see `vsLight/vsMedium/vsHeavy`). */
export type ArmorClass = 'light' | 'medium' | 'heavy';

/** What a weapon can be aimed at. `none` = unarmed (hauler, transport). */
export type TargetClass = 'ground' | 'air' | 'both' | 'none';

/** Order lifecycle. `failed` always carries a `failReason` — never silent. */
export type UnitState = 'idle' | 'awaitingPath' | 'moving' | 'failed';

/**
 * Static per-kind definition. Balance numbers are Phase 1 engineering
 * choices tuned for readable counters:
 *  - tank beats rifles (armor shrugs off light weapons; tank gun
 *    one-twos infantry),
 *  - artillery beats tank at range (outranges it, bonus vs heavy) but is
 *    helpless up close (minRange: rifles walk inside and it cannot fire),
 *  - aa beats anything that flies (large vsAir bonus),
 *  - fighter beats drone/transport (air superiority),
 *  - spectre beats soft high-value targets (bonus vs medium: artillery, aa).
 */
export interface UnitDef {
  kind: UnitKind;
  /** Display name for UI/docs. */
  name: string;
  domain: UnitDomain;
  /** Max (and spawn) hit points. */
  hp: number;
  /** Speed in world units per second. */
  speed: number;
  armor: ArmorClass;
  /** Damage per shot. 0 = unarmed. */
  damage: number;
  /** Weapon range in world units. */
  range: number;
  /** Cannot fire closer than this (artillery dead zone). */
  minRange: number;
  /** Ticks between shots (30 ticks = 1 sim-second). */
  cooldownTicks: number;
  targets: TargetClass;
  /** Damage multiplier vs each armor class (ground targets). */
  vsLight: number;
  vsMedium: number;
  vsHeavy: number;
  /** Extra multiplier when the target flies (aa, fighter). */
  vsAir: number;
  /** How far the unit notices enemies (for AI; combat fires at `range`). */
  sight: number;
  /** Minimum age required to build this unit. Fighters need Connectivity. */
  minAge: Age;
}

export const UNIT_DEFS: Record<UnitKind, UnitDef> = {
  engineer: {
    kind: 'engineer', name: 'Engineer', domain: 'land', hp: 80, speed: 6, armor: 'light',
    damage: 5, range: 10, minRange: 0, cooldownTicks: 30, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.6, vsHeavy: 0.4, vsAir: 1.0, sight: 18, minAge: 'foundation',
  },
  rifles: {
    kind: 'rifles', name: 'Rifles', domain: 'land', hp: 110, speed: 9, armor: 'light',
    damage: 9, range: 15, minRange: 0, cooldownTicks: 20, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.55, vsHeavy: 0.3, vsAir: 1.0, sight: 22, minAge: 'foundation',
  },
  tank: {
    kind: 'tank', name: 'Main Battle Tank', domain: 'land', hp: 500, speed: 10, armor: 'heavy',
    damage: 50, range: 19, minRange: 0, cooldownTicks: 50, targets: 'ground',
    vsLight: 1.3, vsMedium: 1.0, vsHeavy: 0.9, vsAir: 1.0, sight: 26, minAge: 'foundation',
  },
  artillery: {
    kind: 'artillery', name: 'Artillery', domain: 'land', hp: 160, speed: 6, armor: 'medium',
    damage: 95, range: 48, minRange: 12, cooldownTicks: 100, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.4, vsHeavy: 1.6, vsAir: 1.0, sight: 30, minAge: 'foundation',
  },
  aa: {
    kind: 'aa', name: 'Mobile AA', domain: 'land', hp: 200, speed: 10, armor: 'medium',
    damage: 40, range: 28, minRange: 0, cooldownTicks: 25, targets: 'air',
    vsLight: 0.3, vsMedium: 0.3, vsHeavy: 0.3, vsAir: 2.2, sight: 34, minAge: 'foundation',
  },
  hauler: {
    kind: 'hauler', name: 'Hauler', domain: 'land', hp: 160, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 16, minAge: 'foundation',
  },
  spectre: {
    kind: 'spectre', name: 'Spectre', domain: 'land', hp: 130, speed: 12, armor: 'light',
    damage: 75, range: 10, minRange: 0, cooldownTicks: 45, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.6, vsHeavy: 1.3, vsAir: 1.0, sight: 24, minAge: 'foundation',
  },
  hq: {
    kind: 'hq', name: 'Mobile HQ', domain: 'land', hp: 400, speed: 7, armor: 'heavy',
    damage: 12, range: 13, minRange: 0, cooldownTicks: 30, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.0, sight: 28, minAge: 'foundation',
  },
  fighter: {
    kind: 'fighter', name: 'Fighter', domain: 'air', hp: 170, speed: 26, armor: 'light',
    damage: 32, range: 24, minRange: 0, cooldownTicks: 28, targets: 'both',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.6, sight: 40, minAge: 'connectivity',
  },
  transport: {
    kind: 'transport', name: 'Transport', domain: 'air', hp: 240, speed: 22, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'foundation',
  },
  drone: {
    kind: 'drone', name: 'Drone', domain: 'air', hp: 55, speed: 20, armor: 'light',
    damage: 9, range: 13, minRange: 0, cooldownTicks: 22, targets: 'both',
    vsLight: 0.9, vsMedium: 0.5, vsHeavy: 0.3, vsAir: 1.0, sight: 26, minAge: 'foundation',
  },
};

/** Mobile HQ command aura: radius and friendly damage bonus. */
export const HQ_AURA_RADIUS = 20;
export const HQ_AURA_DAMAGE_BONUS = 0.25;

/** A mobile unit. Plain data — snapshot()/digest() cover it verbatim. */
export interface UnitRecord {
  /** Stable id from `world.nextId`. Never reused. */
  id: number;
  /** Kind tag, one of UNIT_KINDS. */
  kind: string;
  /** Owning player id (indexes `world.city.players`). */
  owner: number;
  /** Position on the ground plane. */
  x: number;
  z: number;
  /** Map layer: 'land' or 'air'. From the unit def, cached for hot loops. */
  domain: UnitDomain;
  /** Speed in world units/second. */
  speed: number;
  /** Current hit points. 0 or less = dead (removed by the combat system). */
  hp: number;
  /** Ticks until the weapon can fire again (0 = ready). */
  cooldownLeft: number;
  /** Id of the unit this one is ordered to attack (0 = none). */
  targetId: number;
  /**
   * True while pursuing an explicit `attackUnit` order: the unit chases
   * its target if it moves out of range. Auto-acquired targets (opportunistic
   * fire) never chase — the unit holds position and fires when in range.
   */
  chasing: boolean;
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
   * land, in the destination's land component (for land units).
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
  const def = UNIT_DEFS[kind as UnitKind] ?? UNIT_DEFS.engineer;
  const record: UnitRecord = {
    id: world.nextId,
    kind,
    owner,
    x,
    z,
    domain: def.domain,
    speed: def.speed,
    hp: def.hp,
    cooldownLeft: 0,
    targetId: 0,
    chasing: false,
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
 * validates against water for land units (air units may spawn over water).
 * Terrain is injected, not stored in the world — the same pattern as
 * `registerCityCommands`.
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
      // cannot go stale between enqueue and apply. Air units fly, so only
      // land units are blocked by water.
      const def = UNIT_DEFS[kind as UnitKind];
      if (def.domain === 'land' && isWater(t, x, z)) {
        return `spawnUnit: cannot spawn a land unit in water at (${x}, ${z})`;
      }
      // Age gating: units requiring Connectivity can't be built in Foundation.
      if (def.minAge === 'connectivity' && world.ages.age !== 'connectivity') {
        return `spawnUnit: ${kind} requires the Connectivity age`;
      }
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
