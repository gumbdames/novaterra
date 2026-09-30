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
import { TICK_DT } from './tick';
import type { CommandQueue } from './commands';
import {
  findUnit,
  clearUnitOrder,
  UNIT_DEFS,
  HQ_AURA_DAMAGE_BONUS,
  supplyDamageFactor,
  type UnitRecord,
  type UnitKind,
  type UnitDef,
} from './units';
import {
  hasUpgrade,
  effectiveRange,
  effectiveHealPerSec,
  AP_ROUNDS_KINDS,
  AP_ROUNDS_VS_HEAVY_MULT,
  AVIONICS_KINDS,
  AVIONICS_VS_AIR_MULT,
  SONAR_KINDS,
  SONAR_VS_MEDIUM_MULT,
} from './upgrades';
import {
  awardKillXp,
  vetCooldownTicks,
  vetDamageMult,
  vetAdjustedMaxHp,
  VET_MAX_LEVEL,
  VET_ELITE_REGEN_PER_SEC,
} from './veterancy';
import { orderMoveTo } from './movement';
import { MAP_HALF_SIZE } from './city';

/** Can this weapon be aimed at that target's domain? */
export function canTarget(def: UnitDef, target: UnitRecord): boolean {
  if (def.targets === 'none' || def.damage <= 0) return false;
  if (target.domain === 'air') {
    return def.targets === 'air' || def.targets === 'both' || def.targets === 'seaAir';
  }
  if (target.domain === 'sea') {
    return def.targets === 'sea' || def.targets === 'seaAir';
  }
  // Ground target (land domain).
  return def.targets === 'ground' || def.targets === 'both';
}

/**
 * Aura sources, cached per (world, tick). Scanning world.units for aura
 * emitters on every shot is O(units²) per combat tick — with a thousand
 * units that blows the tick budget. The cache is derived from world state
 * each tick, so it stays deterministic; direct damageMultiplier callers
 * outside a tick simply miss the cache and recompute.
 */
interface AuraSource {
  x: number;
  z: number;
  owner: number;
  kind: string;
  radius: number;
  bonus: number;
  domain: UnitDef['auraDomain'];
}
let auraCacheWorld: World | null = null;
let auraCacheTick = -1;
let auraCache: AuraSource[] = [];

function auraSources(world: World): AuraSource[] {
  if (auraCacheWorld === world && auraCacheTick === world.tick) return auraCache;
  auraCacheWorld = world;
  auraCacheTick = world.tick;
  auraCache = [];
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (def?.auraRadius === undefined) continue;
    auraCache.push({
      x: u.x, z: u.z, owner: u.owner, kind: u.kind,
      radius: def.auraRadius,
      bonus: def.auraBonus ?? HQ_AURA_DAMAGE_BONUS,
      domain: def.auraDomain,
    });
  }
  return auraCache;
}

/**
 * Damage multiplier for one shot: armor-class counter, the vsAir bonus
 * for flying targets, command auras, upgrade effects (AP Rounds,
 * Advanced Avionics, Sonar Suite), and the attacker's veterancy level
 * (Phase 1: +10% damage per level). All deterministic — no randomness.
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
  // Upgrade hooks (spec §4): AP Rounds (+40% vsHeavy for tank/TD/apc),
  // Advanced Avionics (+20% vsAir for fighters), Sonar Suite (+30%
  // vsMedium ASW for frigate/destroyer).
  if (
    armor === 'heavy' &&
    AP_ROUNDS_KINDS.includes(attacker.kind) &&
    hasUpgrade(world, attacker.owner, 'apRounds')
  ) {
    mult *= AP_ROUNDS_VS_HEAVY_MULT;
  }
  if (
    target.domain === 'air' &&
    AVIONICS_KINDS.includes(attacker.kind) &&
    hasUpgrade(world, attacker.owner, 'advancedAvionics')
  ) {
    mult *= AVIONICS_VS_AIR_MULT;
  }
  if (
    armor === 'medium' &&
    SONAR_KINDS.includes(attacker.kind) &&
    hasUpgrade(world, attacker.owner, 'sonarSuite')
  ) {
    mult *= SONAR_VS_MEDIUM_MULT;
  }
  // Command auras (spec §5.5): any unit whose def carries auraRadius
  // emits one — the Mobile HQ (radius 20, all domains) and the
  // commandShip (radius 24, sea domain only). A unit never benefits from
  // its own kind's aura; the first source in spawn order wins (no stacking).
  // Sources are cached per tick (see auraSources) to keep combat O(n).
  for (const src of auraSources(world)) {
    if (src.owner !== attacker.owner || src.kind === attacker.kind) continue;
    if (src.domain !== undefined && attacker.domain !== src.domain) continue;
    const d = Math.hypot(src.x - attacker.x, src.z - attacker.z);
    if (d <= src.radius) {
      mult *= 1 + src.bonus;
      break;
    }
  }
  // Veterancy (Phase 1): experienced crews hit harder. vetLevel 0
  // multiplies by exactly 1.0, so legacy behavior is unchanged. The
  // ?? 0 tolerates hand-built records (tests) that predate the field —
  // real records always carry it (spawnUnit) and legacy saves decode it
  // (snapshot.ts).
  mult *= vetDamageMult(attacker.vetLevel ?? 0);
  // Phase 3 logistics (AD3): out-of-supply degrades, never hard-stops —
  // one simple curve, damage ×(0.6+0.4×supplyLevel), applied as a single
  // factor alongside veterancy (PLAN §13: no compounding supply
  // penalties). Exempt kinds sit at level 1 ⇒ exactly ×1.0, so legacy
  // behavior is unchanged for them.
  mult *= supplyDamageFactor(def, attacker);
  return mult;
}

/**
 * Nearest enemy this unit could hit, inside weapon range and outside
 * min range. Range runs through the upgrade hook (Cruise Missiles).
 * Ties break by lower id. Returns undefined when unarmed.
 */
export function acquireTarget(world: World, unit: UnitRecord, def: UnitDef): UnitRecord | undefined {
  if (def.damage <= 0 || def.targets === 'none') return undefined;
  const range = effectiveRange(world, unit.owner, def);
  let best: UnitRecord | undefined;
  let bestDist = Infinity;
  for (const other of world.units) {
    if (other.id === unit.id || other.owner === unit.owner || other.hp <= 0) continue;
    if (!canTarget(def, other)) continue;
    const d = Math.hypot(other.x - unit.x, other.z - unit.z);
    if (d > range || d < def.minRange) continue;
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) < 1e-9 && other.id < (best?.id ?? Infinity))) {
      best = other;
      bestDist = d;
    }
  }
  return best;
}

/** Apply one shot from attacker to target. Returns true if the target died. */
function fireWeapon(world: World, attacker: UnitRecord, def: UnitDef, target: UnitRecord): boolean {
  // Phase 3 logistics (S2): magazine gate. A unit whose def tracks ammo
  // must have a full shot loaded, or it holds fire — the same outcome as
  // an unarmed unit: no loud failure, it simply cannot shoot this tick.
  // The weapon stays OFF cooldown so it fires the instant resupply lands
  // (the resupply fantasy: the truck arrives, the guns speak next tick).
  // Reads plain unit data only — no combat→economy import (S2 discipline).
  const perShot = def.ammoPerShot ?? 1;
  if ((def.ammoCapacity ?? 0) > 0 && (attacker.ammo ?? 0) < perShot) {
    return false;
  }
  const mult = damageMultiplier(world, attacker, def, target);
  // Veteran crews reload faster (Phase 1) — the weapon cooldown already
  // reflects the attacker's level here and in the shield-absorbed path.
  // (?? 0: see the damageMultiplier note above.)
  const cooldown = vetCooldownTicks(def, attacker.vetLevel ?? 0);
  // Phase 3: an active Aegis shield blocks all damage to the owner's units.
  // (Reads world.superweapons directly — importing superweapons.ts here
  // would cycle, since the storm system needs combat's killUnit.)
  const sw = world.superweapons.players.find((p) => p.owner === target.owner);
  if (sw && world.tick < sw.aegis.activeUntil) {
    attacker.cooldownLeft = cooldown;
    return false; // shield absorbs the shot
  }
  target.hp -= def.damage * mult;
  // Phase 3 logistics (S2): the shot actually fired (past the Aegis
  // check above) — burn the magazine. The gate guarantees
  // ammo >= perShot, so no clamp is needed. (?? 0: hand-built records.)
  if ((def.ammoCapacity ?? 0) > 0) {
    attacker.ammo = (attacker.ammo ?? 0) - perShot;
  }
  attacker.cooldownLeft = cooldown;
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
 * Heal auras (spec §5.4): units with `healRadius`/`healPerSec` on their
 * def (combatMedic: 12 / 2 hp/s, 4 with Field Medicine) restore friendly
 * LAND units in radius. Same iteration pattern as the HQ damage aura —
 * O(sources × units), bounded by design (medics are few). Healing caps at
 * the unit's effective max hp (upgrade-aware); the dead stay dead.
 */
function applyHealAuras(world: World): void {
  for (const medic of world.units) {
    if (medic.hp <= 0) continue;
    const mdef = UNIT_DEFS[medic.kind as UnitKind];
    const radius = mdef?.healRadius;
    if (radius === undefined || radius <= 0) continue;
    const perSec = effectiveHealPerSec(world, medic.owner, mdef);
    if (perSec <= 0) continue;
    const amount = perSec * TICK_DT;
    for (const u of world.units) {
      if (u.hp <= 0 || u.owner !== medic.owner || u.domain !== 'land') continue;
      const udef = UNIT_DEFS[u.kind as UnitKind];
      if (!udef) continue;
      // Heal cap is veterancy-aware (Phase 1): Veteran+ units are tougher
      // and medics can fill the bonus hp too.
      const maxHp = vetAdjustedMaxHp(world, u);
      if (u.hp >= maxHp) continue;
      const d = Math.hypot(u.x - medic.x, u.z - medic.z);
      if (d <= radius) {
        u.hp = Math.min(maxHp, u.hp + amount);
      }
    }
  }
}

/**
 * The combat system. Runs after movement each tick:
 *  1. Cooldowns tick down.
 *  2. Heal auras apply (combatMedic).
 *  3. In id order, every armed unit with a ready weapon validates its
 *     target (or auto-acquires), fires when in range, or chases an
 *     explicit attack order.
 *  4. The dead are removed.
 */
export function createCombatSystem(): SimSystem {
  return (world: World) => {
    for (const u of world.units) {
      if (u.cooldownLeft > 0) u.cooldownLeft -= 1;
      // Elite (VET_MAX_LEVEL) regen (Phase 1): living Elite units regrow
      // 2 hp/s up to their veterancy-adjusted max. Deterministic,
      // float-safe: identical inputs produce identical hp.
      // (?? 0: hand-built records without the field never regen.)
      if ((u.vetLevel ?? 0) >= VET_MAX_LEVEL && u.hp > 0) {
        const maxHp = vetAdjustedMaxHp(world, u);
        if (u.hp < maxHp) {
          u.hp = Math.min(maxHp, u.hp + VET_ELITE_REGEN_PER_SEC * TICK_DT);
        }
      }
    }
    applyHealAuras(world);
    // Snapshot the roster: killUnit mutates world.units mid-loop. Id order
    // (ascending) is the determinism contract — XP kill crediting happens
    // in this same pass, so kills credit in id order too.
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
      const range = effectiveRange(world, u.owner, def);
      if (d <= range && d >= def.minRange && canTarget(def, target)) {
        if (fireWeapon(world, u, def, target) && !dead.includes(target)) {
          // Kill crediting (Phase 1): award XP BEFORE killUnit removes the
          // target below — the target record still exists here.
          awardKillXp(world, u, UNIT_DEFS[target.kind as UnitKind]);
          dead.push(target);
        }
      } else if (u.chasing) {
        // Explicit attack order, target out of reach: reposition.
        if (d < def.minRange) {
          // Too close for this weapon (e.g. artillery minimum range):
          // back off directly away from the target to reach minRange.
          // Deterministic: pure function of unit/target positions.
          const dx = u.x - target.x;
          const dz = u.z - target.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 1e-9) {
            const backOff = def.minRange - d + 2; // +2 buffer to clear minRange
            const m = MAP_HALF_SIZE - 0.01;
            const bx = Math.min(Math.max(u.x + (dx / dist) * backOff, -m), m);
            const bz = Math.min(Math.max(u.z + (dz / dist) * backOff, -m), m);
            const destDist = Math.hypot(bx - u.destX, bz - u.destZ);
            if (u.state === 'idle' || destDist > 10) {
              orderMoveTo(world, u, bx, bz);
            }
          }
          // dist ~0: stacked on the target, no direction to back off; hold.
        } else {
          // Too far: chase toward the target. Re-issue only when idle
          // (arrived at a stale position) or the target has moved well
          // away from where we're headed — not every tick.
          const destDist = Math.hypot(target.x - u.destX, target.z - u.destZ);
          if (u.state === 'idle' || destDist > 10) {
            orderMoveTo(world, u, target.x, target.z);
          }
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
