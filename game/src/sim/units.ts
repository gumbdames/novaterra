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
 *    target). The roster is 13 land + 6 air + 9 sea (spec
 *    docs/research/roster-expansion.md §2).
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
import { getPlayer, MAP_HALF_SIZE, BUILDING_DEFS, hasProductionBuilding } from './city';
import type { BuildingKind, ResourceKey } from './city';
import type { CommandQueue } from './commands';
import type { Age } from './ages';
import { isUnitAvailableForAge } from './ages';
import { effectiveMaxHp, effectiveSpeed } from './upgrades';

/**
 * The full 28-unit roster (spec docs/research/roster-expansion.md §2).
 * Land (13): engineer, rifles, tank, artillery, aa, hauler, spectre, hq,
 * apc, tankDestroyer, mlrs, sniperTeam, combatMedic.
 * Air (6): fighter, transport, drone, fighterBomber, attackHeli, awacs.
 * Sea (9): patrolBoat, destroyer, transportShip, missileBoat, frigate,
 * submarine, carrier, commandShip, fishingBoat.
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
  'patrolBoat',
  'destroyer',
  'transportShip',
  'sniperTeam',
  'combatMedic',
  'apc',
  'tankDestroyer',
  'mlrs',
  'fighterBomber',
  'attackHeli',
  'awacs',
  'missileBoat',
  'frigate',
  'submarine',
  'carrier',
  'commandShip',
  'fishingBoat',
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Which map layer a unit lives on. Air units fly over terrain and water. */
export type UnitDomain = 'land' | 'air' | 'sea';

/** How tough a unit is against incoming fire (see `vsLight/vsMedium/vsHeavy`). */
export type ArmorClass = 'light' | 'medium' | 'heavy';

/** What a weapon can be aimed at. `none` = unarmed (hauler, transport). */
export type TargetClass = 'ground' | 'air' | 'both' | 'none' | 'sea' | 'seaAir';

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
  /** Manpower cost to train (0 for civilian/unmanned units). Deducted from player.manpower. */
  manpowerCost: number;
  /**
   * Training cost in funds (spec §"The training-cost gap": training used
   * to cost only manpower). Validated at enqueue AND apply, deducted on
   * apply.
   */
  trainFunds: number;
  /** Training cost in materials. Validated at enqueue AND apply, deducted on apply. */
  trainMaterials: number;
  /**
   * Production building the owner must have completed (progress >= 1) to
   * train this kind. Undefined = trainable from the start (engineer,
   * rifles, hauler, drone, transport, patrolBoat, transportShip,
   * fishingBoat, hq). Applies on top of minAge — both must be satisfied.
   */
  requiredBuilding?: BuildingKind;
  /**
   * Command aura: friendly attackers of `auraDomain` (or any domain when
   * undefined) within this radius get +`auraBonus` damage. Generalizes the
   * old HQ_AURA_* constants (hq: 20 / 0.25; commandShip: 24 / 0.25 sea).
   */
  auraRadius?: number;
  /** Command aura damage bonus as a fraction (0.25 = +25%). */
  auraBonus?: number;
  /** When set, the aura only buffs attackers of this domain. */
  auraDomain?: UnitDomain;
  /** Heal aura radius in world units (combatMedic: 12). */
  healRadius?: number;
  /** Heal aura rate in hp per sim-second (combatMedic: 2). */
  healPerSec?: number;
  /** Passive resource harvest per sim-second while alive (fishingBoat: food 0.6). */
  harvest?: Partial<Record<ResourceKey, number>>;
}

/** Mobile HQ command aura: radius and friendly damage bonus. */
export const HQ_AURA_RADIUS = 20;
export const HQ_AURA_DAMAGE_BONUS = 0.25;

export const UNIT_DEFS: Record<UnitKind, UnitDef> = {  engineer: {
    kind: 'engineer', name: 'Engineer', domain: 'land', hp: 80, speed: 6, armor: 'light',
    damage: 5, range: 10, minRange: 0, cooldownTicks: 30, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.6, vsHeavy: 0.4, vsAir: 1.0, sight: 18, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 50, trainMaterials: 0,
  },
  rifles: {
    kind: 'rifles', name: 'Rifles', domain: 'land', hp: 110, speed: 9, armor: 'light',
    damage: 9, range: 15, minRange: 0, cooldownTicks: 20, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.55, vsHeavy: 0.3, vsAir: 1.0, sight: 22, minAge: 'foundation',
    manpowerCost: 2, trainFunds: 60, trainMaterials: 0,
  },
  tank: {
    kind: 'tank', name: 'Main Battle Tank', domain: 'land', hp: 500, speed: 10, armor: 'heavy',
    damage: 50, range: 19, minRange: 0, cooldownTicks: 50, targets: 'ground',
    vsLight: 1.3, vsMedium: 1.0, vsHeavy: 0.9, vsAir: 1.0, sight: 26, minAge: 'foundation',
    manpowerCost: 5, trainFunds: 400, trainMaterials: 60, requiredBuilding: 'warFactory',
  },
  artillery: {
    kind: 'artillery', name: 'Artillery', domain: 'land', hp: 160, speed: 6, armor: 'medium',
    damage: 95, range: 48, minRange: 12, cooldownTicks: 100, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.4, vsHeavy: 1.6, vsAir: 1.0, sight: 30, minAge: 'foundation',
    manpowerCost: 4, trainFunds: 450, trainMaterials: 80, requiredBuilding: 'warFactory',
  },
  aa: {
    kind: 'aa', name: 'Mobile AA', domain: 'land', hp: 200, speed: 10, armor: 'medium',
    damage: 40, range: 28, minRange: 0, cooldownTicks: 25, targets: 'air',
    vsLight: 0.3, vsMedium: 0.3, vsHeavy: 0.3, vsAir: 2.2, sight: 34, minAge: 'foundation',
    manpowerCost: 4, trainFunds: 350, trainMaterials: 60, requiredBuilding: 'warFactory',
  },
  hauler: {
    kind: 'hauler', name: 'Hauler', domain: 'land', hp: 160, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 16, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 120, trainMaterials: 20,
  },
  spectre: {
    kind: 'spectre', name: 'Spectre', domain: 'land', hp: 130, speed: 12, armor: 'light',
    damage: 75, range: 10, minRange: 0, cooldownTicks: 45, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.6, vsHeavy: 1.3, vsAir: 1.0, sight: 24, minAge: 'foundation',
    manpowerCost: 3, trainFunds: 300, trainMaterials: 20, requiredBuilding: 'barracks',
  },
  hq: {
    kind: 'hq', name: 'Mobile HQ', domain: 'land', hp: 400, speed: 7, armor: 'heavy',
    damage: 12, range: 13, minRange: 0, cooldownTicks: 30, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.0, sight: 28, minAge: 'foundation',
    manpowerCost: 2, trainFunds: 600, trainMaterials: 100,
    auraRadius: HQ_AURA_RADIUS, auraBonus: HQ_AURA_DAMAGE_BONUS,
  },
  fighter: {
    kind: 'fighter', name: 'Fighter', domain: 'air', hp: 170, speed: 26, armor: 'light',
    damage: 32, range: 24, minRange: 0, cooldownTicks: 28, targets: 'both',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.6, sight: 40, minAge: 'connectivity',
    manpowerCost: 3, trainFunds: 800, trainMaterials: 120, requiredBuilding: 'airfield',
  },
  transport: {
    kind: 'transport', name: 'Transport', domain: 'air', hp: 240, speed: 22, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'foundation',
    manpowerCost: 2, trainFunds: 500, trainMaterials: 80,
  },
  drone: {
    kind: 'drone', name: 'Drone', domain: 'air', hp: 55, speed: 20, armor: 'light',
    damage: 9, range: 13, minRange: 0, cooldownTicks: 22, targets: 'both',
    vsLight: 0.9, vsMedium: 0.5, vsHeavy: 0.3, vsAir: 1.0, sight: 26, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 80, trainMaterials: 10,
  },
  patrolBoat: {
    kind: 'patrolBoat', name: 'Patrol Boat', domain: 'sea', hp: 220, speed: 14, armor: 'light',
    damage: 18, range: 20, minRange: 0, cooldownTicks: 25, targets: 'sea',
    vsLight: 1.2, vsMedium: 0.8, vsHeavy: 0.5, vsAir: 0.8, sight: 30, minAge: 'industry',
    manpowerCost: 3, trainFunds: 250, trainMaterials: 60,
  },
  destroyer: {
    kind: 'destroyer', name: 'Destroyer', domain: 'sea', hp: 600, speed: 11, armor: 'heavy',
    damage: 45, range: 26, minRange: 0, cooldownTicks: 40, targets: 'seaAir',
    vsLight: 1.3, vsMedium: 1.1, vsHeavy: 1.0, vsAir: 1.8, sight: 34, minAge: 'industry',
    manpowerCost: 6, trainFunds: 1500, trainMaterials: 400, requiredBuilding: 'navalYard',
  },
  transportShip: {
    kind: 'transportShip', name: 'Transport Ship', domain: 'sea', hp: 350, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 22, minAge: 'industry',
    manpowerCost: 2, trainFunds: 400, trainMaterials: 100,
  },
  // ------------------------------------------------------------------
  // Roster expansion (spec docs/research/roster-expansion.md §2): 14 new.
  // ------------------------------------------------------------------
  sniperTeam: {
    kind: 'sniperTeam', name: 'Sniper Team', domain: 'land', hp: 90, speed: 8, armor: 'light',
    damage: 45, range: 30, minRange: 0, cooldownTicks: 70, targets: 'ground',
    vsLight: 1.6, vsMedium: 0.8, vsHeavy: 0.4, vsAir: 1.0, sight: 36, minAge: 'connectivity',
    manpowerCost: 3, trainFunds: 200, trainMaterials: 20, requiredBuilding: 'barracks',
  },
  combatMedic: {
    kind: 'combatMedic', name: 'Combat Medic', domain: 'land', hp: 100, speed: 9, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    manpowerCost: 2, trainFunds: 150, trainMaterials: 10, requiredBuilding: 'barracks',
    healRadius: 12, healPerSec: 2,
  },
  apc: {
    kind: 'apc', name: 'Armored Personnel Carrier', domain: 'land', hp: 320, speed: 12, armor: 'medium',
    damage: 14, range: 16, minRange: 0, cooldownTicks: 25, targets: 'ground',
    vsLight: 1.3, vsMedium: 0.8, vsHeavy: 0.5, vsAir: 1.0, sight: 24, minAge: 'connectivity',
    manpowerCost: 4, trainFunds: 250, trainMaterials: 40, requiredBuilding: 'warFactory',
  },
  tankDestroyer: {
    kind: 'tankDestroyer', name: 'Tank Destroyer', domain: 'land', hp: 380, speed: 9, armor: 'medium',
    damage: 70, range: 24, minRange: 0, cooldownTicks: 60, targets: 'ground',
    vsLight: 0.6, vsMedium: 1.2, vsHeavy: 1.8, vsAir: 1.0, sight: 26, minAge: 'industry',
    manpowerCost: 5, trainFunds: 500, trainMaterials: 90, requiredBuilding: 'warFactory',
  },
  mlrs: {
    kind: 'mlrs', name: 'MLRS', domain: 'land', hp: 180, speed: 7, armor: 'medium',
    damage: 140, range: 40, minRange: 14, cooldownTicks: 160, targets: 'ground',
    vsLight: 1.6, vsMedium: 1.2, vsHeavy: 1.2, vsAir: 1.0, sight: 28, minAge: 'industry',
    manpowerCost: 5, trainFunds: 600, trainMaterials: 120, requiredBuilding: 'warFactory',
  },
  fighterBomber: {
    kind: 'fighterBomber', name: 'Fighter-Bomber', domain: 'air', hp: 200, speed: 28, armor: 'medium',
    damage: 120, range: 20, minRange: 0, cooldownTicks: 90, targets: 'ground',
    vsLight: 0.8, vsMedium: 1.0, vsHeavy: 1.6, vsAir: 1.0, sight: 32, minAge: 'industry',
    manpowerCost: 4, trainFunds: 1000, trainMaterials: 150, requiredBuilding: 'airfield',
  },
  attackHeli: {
    kind: 'attackHeli', name: 'Attack Helicopter', domain: 'air', hp: 150, speed: 30, armor: 'light',
    damage: 60, range: 22, minRange: 0, cooldownTicks: 55, targets: 'ground',
    vsLight: 0.9, vsMedium: 1.1, vsHeavy: 1.5, vsAir: 1.0, sight: 30, minAge: 'connectivity',
    manpowerCost: 4, trainFunds: 700, trainMaterials: 100, requiredBuilding: 'airfield',
  },
  awacs: {
    kind: 'awacs', name: 'AWACS', domain: 'air', hp: 180, speed: 24, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 65, minAge: 'information',
    manpowerCost: 3, trainFunds: 900, trainMaterials: 120, requiredBuilding: 'airfield',
  },
  missileBoat: {
    kind: 'missileBoat', name: 'Missile Boat', domain: 'sea', hp: 180, speed: 18, armor: 'light',
    damage: 70, range: 22, minRange: 0, cooldownTicks: 70, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.1, vsHeavy: 1.5, vsAir: 1.0, sight: 28, minAge: 'connectivity',
    manpowerCost: 4, trainFunds: 500, trainMaterials: 120, requiredBuilding: 'shipyard',
  },
  frigate: {
    kind: 'frigate', name: 'Frigate', domain: 'sea', hp: 420, speed: 13, armor: 'medium',
    damage: 30, range: 24, minRange: 0, cooldownTicks: 35, targets: 'seaAir',
    vsLight: 1.2, vsMedium: 1.6, vsHeavy: 0.8, vsAir: 1.2, sight: 32, minAge: 'industry',
    manpowerCost: 5, trainFunds: 900, trainMaterials: 220, requiredBuilding: 'navalYard',
  },
  submarine: {
    kind: 'submarine', name: 'Submarine', domain: 'sea', hp: 300, speed: 10, armor: 'medium',
    damage: 90, range: 30, minRange: 0, cooldownTicks: 80, targets: 'sea',
    vsLight: 0.8, vsMedium: 1.5, vsHeavy: 2.0, vsAir: 1.0, sight: 26, minAge: 'industry',
    manpowerCost: 6, trainFunds: 1200, trainMaterials: 300, requiredBuilding: 'navalYard',
  },
  carrier: {
    kind: 'carrier', name: 'Carrier', domain: 'sea', hp: 900, speed: 8, armor: 'heavy',
    damage: 40, range: 30, minRange: 0, cooldownTicks: 45, targets: 'seaAir',
    vsLight: 1.2, vsMedium: 1.0, vsHeavy: 0.9, vsAir: 2.0, sight: 36, minAge: 'information',
    manpowerCost: 10, trainFunds: 3500, trainMaterials: 1000, requiredBuilding: 'navalYard',
  },
  commandShip: {
    kind: 'commandShip', name: 'Command Ship', domain: 'sea', hp: 700, speed: 9, armor: 'heavy',
    damage: 20, range: 18, minRange: 0, cooldownTicks: 40, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 40, minAge: 'information',
    manpowerCost: 6, trainFunds: 2000, trainMaterials: 500, requiredBuilding: 'navalYard',
    auraRadius: 24, auraBonus: 0.25, auraDomain: 'sea',
  },
  fishingBoat: {
    kind: 'fishingBoat', name: 'Fishing Boat', domain: 'sea', hp: 120, speed: 12, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 18, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 150, trainMaterials: 30,
    harvest: { food: 0.6 },
  },
};

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
    // Spawn stats run through the upgrade hooks (Composite Armor hp,
    // Engine Tuning speed, Field Medicine hp) — existing units are never
    // retroactively changed, so spawn time is the only application point.
    speed: effectiveSpeed(world, owner, def),
    hp: effectiveMaxHp(world, owner, def),
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
      // cannot go stale between enqueue and apply. Air units fly; land units
      // are blocked by water; sea units require water.
      const def = UNIT_DEFS[kind as UnitKind];
      if (def.domain === 'land' && isWater(t, x, z)) {
        return `spawnUnit: cannot spawn a land unit in water at (${x}, ${z})`;
      }
      if (def.domain === 'sea' && !isWater(t, x, z)) {
        return `spawnUnit: cannot spawn a sea unit on land at (${x}, ${z})`;
      }
      // Age gating: units require their minimum age (or later).
      if (!isUnitAvailableForAge(world, def.minAge)) {
        return `spawnUnit: ${kind} requires the ${def.minAge} age`;
      }
      // Manpower: military units cost manpower from the player's stockpile.
      if (def.manpowerCost > 0) {
        const player = getPlayer(world.city, owner as number);
        if (!player || player.manpower < def.manpowerCost) {
          return `spawnUnit: not enough manpower (need ${def.manpowerCost})`;
        }
      }
      // Training costs (spec: the training-cost gap fix): funds + materials,
      // validated at enqueue AND at apply.
      if (def.trainFunds > 0 || def.trainMaterials > 0) {
        const player = getPlayer(world.city, owner as number);
        if (
          !player ||
          player.funds < def.trainFunds ||
          player.materials < def.trainMaterials
        ) {
          return (
            `spawnUnit: cannot afford training cost for ${kind} ` +
            `(need ${def.trainFunds} funds + ${def.trainMaterials} materials)`
          );
        }
      }
      // Production gating: advanced units need a completed production
      // building (progress >= 1) owned by the training player — real or
      // AI-virtually-constructed (hasProductionBuilding covers both).
      if (def.requiredBuilding) {
        if (!hasProductionBuilding(world, owner as number, def.requiredBuilding)) {
          const name = BUILDING_DEFS[def.requiredBuilding]?.name ?? def.requiredBuilding;
          return `spawnUnit: ${kind} requires a completed ${name}`;
        }
      }
      return null;
    },
    apply(cmd, world): unknown {
      const def = UNIT_DEFS[cmd.payload['kind'] as UnitKind];
      // Deduct manpower + training costs (validated above; re-check
      // defensively for determinism — apply runs after enqueue).
      const player = getPlayer(world.city, cmd.payload['owner'] as number);
      if (def.manpowerCost > 0 && player) {
        if (player.manpower < def.manpowerCost) {
          throw new Error(`spawnUnit: not enough manpower at apply time`);
        }
        player.manpower -= def.manpowerCost;
      }
      if ((def.trainFunds > 0 || def.trainMaterials > 0) && player) {
        if (player.funds < def.trainFunds || player.materials < def.trainMaterials) {
          throw new Error(`spawnUnit: cannot afford training cost at apply time`);
        }
        player.funds -= def.trainFunds;
        player.materials -= def.trainMaterials;
      }
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
