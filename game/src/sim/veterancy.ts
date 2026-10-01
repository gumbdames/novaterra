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
 * NOVATERRA — sim/veterancy.ts — unit veterancy (grand-expansion Phase 1).
 *
 * Responsibilities:
 *  - XP accounting per unit: `xp` grows on kills, `vetLevel` derives from
 *    cumulative thresholds (300 / 800 / 1600 → Regular / Veteran / Elite).
 *    (Roadmap B5, 2026-10-02: softened from 200 / 500 / 1000 — the old curve
 *    promoted a unit after ~2 tank kills, so the first-engagement winner
 *    nearly doubled in power with no catch-up.)
 *  - Level bonuses: +10%/level damage, +10%/level sight, −10%/level
 *    reload cooldown (min 1 tick), +15% max hp at L2 and +30% at L3,
 *    +2 hp/s regen at L3.
 *  - Overflow: a maxed (Elite) killer shares its kill XP with nearby
 *    friendly non-maxed units instead of losing it.
 *  - Death erases everything — XP lives on the UnitRecord and dies with it.
 *
 * Determinism: pure functions only; overflow splits are ordered by unit id,
 * no RNG is consumed. Imported by combat.ts (awards, bonuses), ai.ts
 * (sight), and units.ts (academy spawn bonus). This module imports world
 * state only — no combat/city imports, so it cannot create cycles.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { UnitRecord } from './units';
import { UNIT_DEFS, type UnitDef, type UnitKind } from './units';
import { effectiveMaxHp } from './upgrades';

/** Max veterancy level. XP above it overflows to nearby allies. */
export const VET_MAX_LEVEL = 3;

/**
 * Cumulative XP thresholds for levels 1..3. A unit at `xp` has level
 * equal to the number of thresholds it has reached.
 *
 * (Roadmap B5, 2026-10-02: 300 / 800 / 1600, softened from 200 / 500 /
 * 1000. The old curve promoted after ~2 tank kills — ~1.86× DPS plus
 * regen with no catch-up for the loser. The new curve needs ~4 tank
 * kills for Regular, ~9 for Veteran, ~17 for Elite.)
 */
export const VET_XP_THRESHOLDS = [300, 800, 1600] as const;

/** Rank names shown to the player, indexed by level 0..3. */
export const VET_RANK_NAMES = ['Recruit', 'Regular', 'Veteran', 'Elite'] as const;

/** World distance within which a maxed killer shares XP with allies. */
export const VET_OVERFLOW_RADIUS = 40;

/** Regen rate for Elite (L3) units, in hp per sim-second. */
export const VET_ELITE_REGEN_PER_SEC = 2;

/** Per-level cumulative damage multiplier: ×(1 + 0.10·level). */
export function vetDamageMult(level: number): number {
  return 1 + 0.1 * level;
}

/** Per-level cumulative sight multiplier: ×(1 + 0.10·level). */
export function vetSightMult(level: number): number {
  return 1 + 0.1 * level;
}

/**
 * Reload cooldown in ticks for a veterancy level: the base ticks
 * ×(1 − 0.10·level), floored at 1 tick so weapons never fire instantly.
 * Level 0 reproduces the def value exactly (unchanged legacy behavior).
 */
export function vetCooldownTicks(def: UnitDef, level: number): number {
  if (level <= 0) return def.cooldownTicks;
  return Math.max(1, Math.round(def.cooldownTicks * (1 - 0.1 * level)));
}

/**
 * Max-hp multiplier from veterancy: none at L0/L1, +15% at L2, +30% at L3.
 * (L1 crews shoot better and see farther but are no tougher — toughness
 * comes with the Veteran and Elite bands.)
 */
export function vetMaxHpMult(level: number): number {
  return 1 + 0.15 * Math.max(0, level - 1);
}

/**
 * Veterancy level for a cumulative XP total: the count of thresholds
 * reached (299→0, 300→1, 800→2, 1600→3). Capped at VET_MAX_LEVEL.
 */
export function vetLevelForXp(xp: number): number {
  let level = 0;
  for (const t of VET_XP_THRESHOLDS) {
    if (xp >= t) level += 1;
    else break;
  }
  return Math.min(VET_MAX_LEVEL, level);
}

/** Rank display name for a level 0..3 (clamped). */
export function vetRankName(level: number): string {
  const clamped = Math.max(0, Math.min(VET_MAX_LEVEL, level));
  return VET_RANK_NAMES[clamped] ?? 'Recruit';
}

/**
 * XP value of a kill: the target's training cost in funds + materials.
 * (e.g. rifles 60+0=60, tank 400+60=460). Unarmed civilians still teach
 * the killer what their cost was — the table is flat, no exceptions.
 */
export function xpForKillValue(def: UnitDef): number {
  return def.trainFunds + def.trainMaterials;
}

/**
 * Apply veterancy HP bonus to a living unit's max hp: upgrade-aware base
 * (`effectiveMaxHp`) times the vet multiplier. Dead units get the plain
 * base — veterancy toughness dies with the unit (death erases everything,
 * and the dead are never healed).
 */
export function vetAdjustedMaxHp(world: World, unit: UnitRecord): number {
  const def = UNIT_DEFS[unit.kind as UnitKind];
  const base = def ? effectiveMaxHp(world, unit.owner, def) : 0;
  if (unit.hp <= 0) return base;
  // (?? 0: hand-built records without the field count as Recruit.)
  return base * vetMaxHpMult(unit.vetLevel ?? 0);
}

/**
 * Award kill XP to the killer and handle level-ups. Called by the combat
 * system at the moment a kill lands, BEFORE the target is removed.
 *
 * Overflow: when the killer is already maxed (Elite), the award is split
 * among friendly living non-maxed units within VET_OVERFLOW_RADIUS:
 * id order, each gets floor(xp / n), and the remainder r adds +1 XP to
 * the first r in id order. With no eligible allies the XP is lost.
 *
 * Determinism: iteration is over spawn-ordered `world.units` with explicit
 * id-ordered recipient lists; no RNG. XP is an integer — all splits use
 * integer floor arithmetic.
 */
export function awardKillXp(world: World, killer: UnitRecord, targetDef: UnitDef): void {
  const award = xpForKillValue(targetDef);
  if (award <= 0) return;

  const setLevel = (u: UnitRecord, xp: number): void => {
    u.xp = xp;
    u.vetLevel = vetLevelForXp(xp);
  };

  if ((killer.vetLevel ?? 0) < VET_MAX_LEVEL) {
    setLevel(killer, (killer.xp ?? 0) + award);
    return;
  }

  // Killer is maxed: split among friendly living non-maxed units in range.
  const allies: UnitRecord[] = [];
  for (const u of world.units) {
    if (u.id === killer.id || u.owner !== killer.owner || u.hp <= 0) continue;
    if ((u.vetLevel ?? 0) >= VET_MAX_LEVEL) continue;
    const dx = u.x - killer.x;
    const dz = u.z - killer.z;
    if (dx * dx + dz * dz <= VET_OVERFLOW_RADIUS * VET_OVERFLOW_RADIUS) allies.push(u);
  }
  allies.sort((a, b) => a.id - b.id);
  if (allies.length === 0) return; // XP lost — nobody to teach.

  // The award is split among the allies; the maxed killer gains nothing
  // further (its level is already capped).
  const share = Math.floor(award / allies.length);
  const remainder = award - share * allies.length;
  let i = 0;
  for (const ally of allies) {
    // The remainder goes +1 XP to the first `remainder` allies in id order.
    const extra = i < remainder ? 1 : 0;
    setLevel(ally, (ally.xp ?? 0) + share + extra);
    i += 1;
  }
}
