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
 * NOVATERRA — sim/combat.ts — combat resolution and the attack order.
 *
 * Responsibilities:
 *  - The combat system (`createCombatSystem`), registered AFTER movement
 *    every tick: positions are final for the tick before weapons fire.
 *  - Target acquisition: units with weapons automatically engage the
 *    nearest enemy inside their weapon range (opportunistic fire — they
 *    hold position, they don't chase). The `attackUnit` command gives an
 *    explicit target that the unit chases until it dies or a new order
 *    arrives.
 *  - Damage with readable counters (see UNIT_DEFS in `units.ts`): the
 *    per-kind vsLight/vsMedium/vsHeavy/vsAir multipliers make tanks beat
 *    rifles, artillery beat tanks at range, AA beat anything that flies,
 *    and so on. A nearby friendly Mobile HQ adds a damage aura.
 *  - Death: hp <= 0 removes the unit from `world.units` and cleans up
 *    its pathfinding requests, field membership, and everyone targeting
 *    it.
 *
 * Determinism: units fire in id order; target ties break by id; no RNG
 * in the damage formula (all variance is positional). The `combat` RNG
 * stream exists for future use (e.g. muzzle jitter) and is not consumed
 * here.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { SimSystem } from './tick';
import type { CommandQueue } from './commands';
import {
  findUnit,
  clearUnitOrder,
  UNIT_DEFS,
  HQ_AURA_RADIUS,
  HQ_AURA_DAMAGE_BONUS,
  type UnitRecord,
  type UnitKind,
  type UnitDef,
} from './units';
import { orderMoveTo } from './movement';

/** Can this weapon be aimed at that target's domain? */
export function canTarget(def: UnitDef, target: UnitRecord): boolean {
  if (def.targets === 'none' || def.damage <= 0) return false;
  if (target.domain === 'air') return def.targets === 'air' || def.targets === 'both';
  return def.targets === 'ground' || def.targets === 'both';
}

/**
 * Damage multiplier for one shot: armor-class counter, the vsAir bonus
 * for flying targets, and the Mobile HQ command aura for the attacker.
 * All deterministic — no randomness.
 */
export function damageMultiplier(
  world: World,
  attacker: UnitRecord,
  def: UnitDef,
  target: UnitRecord,
): number {
  const targetDef = UNIT_DEFS[target.kind as UnitKind];
  const armor = targetDef ? targetDef.armor : 'light';
  let mult =
    armor === 'light' ? def.vsLight : armor === 'medium' ? def.vsMedium : def.vsHeavy;
  if (target.domain === 'air') mult *= def.vsAir;
  // Mobile HQ aura: +damage for friendly non-HQ units in radius.
  if (attacker.kind !== 'hq') {
    for (const u of world.units) {
      if (u.kind === 'hq' && u.owner === attacker.owner && u.hp > 0) {
        const d = Math.hypot(u.x - attacker.x, u.z - attacker.z);
        if (d <= HQ_AURA_RADIUS) {
          mult *= 1 + HQ_AURA_DAMAGE_BONUS;
          break;
        }
      }
    }
  }
  return mult;
}

/**
 * Nearest enemy this unit could hit, inside weapon range and outside
 * min range. Ties break by lower id. Returns undefined when unarmed.
 */
export function acquireTarget(world: World, unit: UnitRecord, def: UnitDef): UnitRecord | undefined {
  if (def.damage <= 0 || def.targets === 'none') return undefined;
  let best: UnitRecord | undefined;
  let bestDist = Infinity;
  for (const other of world.units) {
    if (other.id === unit.id || other.owner === unit.owner || other.hp <= 0) continue;
    if (!canTarget(def, other)) continue;
    const d = Math.hypot(other.x - unit.x, other.z - unit.z);
    if (d > def.range || d < def.minRange) continue;
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) < 1e-9 && other.id < (best?.id ?? Infinity))) {
      best = other;
      bestDist = d;
    }
  }
  return best;
}

/** Apply one shot from attacker to target. Returns true if the target died. */
function fireWeapon(world: World, attacker: UnitRecord, def: UnitDef, target: UnitRecord): boolean {
  const mult = damageMultiplier(world, attacker, def, target);
  target.hp -= def.damage * mult;
  attacker.cooldownLeft = def.cooldownTicks;
  return target.hp <= 0;
}

/**
 * Remove a dead unit: drop it from `world.units`, cancel its pathfinding
 * requests and field membership, and clear anyone targeting it. Ids are
 * never reused, so no id fix-up is needed.
 */
export function killUnit(world: World, unit: UnitRecord): void {
  const idx = world.units.indexOf(unit);
  if (idx >= 0) world.units.splice(idx, 1);
  // Cancel pathfinding requests (the coordinator keys them by unit id).
  const pf = world.pathfinding;
  pf.queue = pf.queue.filter((r) => r.unitId !== unit.id);
  pf.fieldQueue = pf.fieldQueue.filter((r) => !r.unitIds.includes(unit.id));
  if (pf.activeBuild && pf.activeBuild.unitIds.includes(unit.id)) {
    pf.activeBuild.unitIds = pf.activeBuild.unitIds.filter((id) => id !== unit.id);
    pf.activeBuild.waitingCount = Math.max(0, pf.activeBuild.waitingCount - 1);
  }
  // Finished fields carry no member list: units point at them via
  // `unit.fieldId`, and the coordinator prunes fields with no members.
  // Clear targeting references.
  for (const u of world.units) {
    if (u.targetId === unit.id) {
      u.targetId = 0;
      u.chasing = false;
    }
  }
}

/**
 * The combat system. Runs after movement each tick:
 *  1. Cooldowns tick down.
 *  2. In id order, every armed unit with a ready weapon validates its
 *     target (or auto-acquires), fires when in range, or chases an
 *     explicit attack order.
 *  3. The dead are removed.
 */
export function createCombatSystem(): SimSystem {
  return (world: World) => {
    for (const u of world.units) {
      if (u.cooldownLeft > 0) u.cooldownLeft -= 1;
    }
    // Snapshot the roster: killUnit mutates world.units mid-loop.
    const roster = [...world.units].sort((a, b) => a.id - b.id);
    const dead: UnitRecord[] = [];
    for (const u of roster) {
      if (u.hp <= 0) {
        dead.push(u);
        continue;
      }
      const def = UNIT_DEFS[u.kind as UnitKind];
      if (!def || def.damage <= 0 || u.cooldownLeft > 0) continue;

      // Validate the current target.
      let target: UnitRecord | undefined;
      if (u.targetId !== 0) {
        const t = findUnit(world, u.targetId);
        if (t && t.hp > 0 && t.owner !== u.owner) {
          target = t;
        } else {
          u.targetId = 0;
          u.chasing = false;
          if (u.state === 'moving' && !canStillMove(u)) {
            u.state = 'idle';
            clearUnitOrder(u);
          }
        }
      }
      // Opportunistic fire: nearest enemy inside weapon range.
      if (!target) {
        const acquired = acquireTarget(world, u, def);
        if (acquired) {
          u.targetId = acquired.id;
          target = acquired;
        }
      }
      if (!target) continue;

      const d = Math.hypot(target.x - u.x, target.z - u.z);
      if (d <= def.range && d >= def.minRange && canTarget(def, target)) {
        if (fireWeapon(world, u, def, target) && !dead.includes(target)) {
          dead.push(target);
        }
      } else if (u.chasing) {
        // Explicit attack order, target out of reach: chase it. Re-issue
        // only when idle (arrived at a stale position) or the target has
        // moved well away from where we're headed — not every tick.
        const destDist = Math.hypot(target.x - u.destX, target.z - u.destZ);
        if (u.state === 'idle' || destDist > 10) {
          orderMoveTo(world, u, target.x, target.z);
        }
      }
    }
    for (const d of dead) {
      if (world.units.includes(d)) killUnit(world, d);
    }
  };
}

/** True when the unit has no live movement order (safe to stand down). */
function canStillMove(u: UnitRecord): boolean {
  return u.state === 'moving' || u.state === 'awaitingPath';
}

/** Register the `attackUnit` command. */
export function registerCombatCommands(queue: CommandQueue): void {
  queue.register('attackUnit', {
    validate(cmd, world): string | null {
      const attackerId = cmd.payload['unitId'];
      const targetId = cmd.payload['targetId'];
      const owner = cmd.payload['owner'];
      if (typeof attackerId !== 'number' || !Number.isInteger(attackerId) || attackerId <= 0) {
        return 'attackUnit: payload.unitId must be a positive integer';
      }
      if (typeof targetId !== 'number' || !Number.isInteger(targetId) || targetId <= 0) {
        return 'attackUnit: payload.targetId must be a positive integer';
      }
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'attackUnit: payload.owner must be an integer';
      }
      const attacker = findUnit(world, attackerId);
      if (!attacker) return `attackUnit: no unit with id ${attackerId}`;
      if (attacker.owner !== owner) return `attackUnit: unit ${attackerId} is not owned by player ${owner}`;
      const def = UNIT_DEFS[attacker.kind as UnitKind];
      if (!def || def.damage <= 0) return `attackUnit: unit ${attackerId} (${attacker.kind}) is unarmed`;
      const target = findUnit(world, targetId);
      if (!target) return `attackUnit: no target with id ${targetId}`;
      if (target.owner === owner) return 'attackUnit: cannot attack your own unit';
      if (!canTarget(def, target)) {
        return `attackUnit: ${attacker.kind} cannot target ${target.domain} units`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const attacker = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
      const target = findUnit(world, cmd.payload['targetId'] as number) as UnitRecord;
      attacker.failReason = null;
      // orderMoveTo clears targeting (a plain move supersedes an attack),
      // so set the attack state after issuing the move.
      orderMoveTo(world, attacker, target.x, target.z);
      attacker.targetId = target.id;
      attacker.chasing = true;
      return attacker.id;
    },
  });
}
