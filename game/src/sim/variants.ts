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
 * along with this program. If you did not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — sim/variants.ts — tech-level variant helpers (Mk II / Mk III).
 *
 * Grand-expansion Phase 8 (workstream D, 2026-09-30; PLAN §3.9, §AD12).
 *
 * A variant is a DISTINCT UnitKind (its own def, its own train command,
 * its own record kind id) that shares the base kind's ART: the def's
 * `variantOf` points at the base kind, and the render layer resolves a
 * variant to the base kind's MODEL_SOURCES entry — zero new MODEL_PATHS
 * keys (the art budget in PLAN §10 counts this phase at ~0 keys).
 *
 * Gating is def-driven, not code-driven:
 *  - `minAge` (Mk II one age above the base, floored at industry;
 *    Mk III one age above Mk II) and the
 *    base's `requiredBuilding` are checked by the existing spawnUnit
 *    validator — the same loud CommandRejectedError path WS-A used for
 *    the peaceful lockout. No new validation code was needed.
 *  - `military: true` variants are locked out in peaceful worlds by that
 *    same lockout.
 *
 * This module holds the PURE read helpers other layers consume:
 *  - `isVariantUnlocked(world, owner, kind)` — the gate, mirrored
 *    exactly from the spawnUnit validator (peaceful/military, minAge,
 *    requiredBuilding). The UI palette workstream calls this to decide
 *    whether a variant button is shown/enabled. Valid for base kinds
 *    too (a base kind is "unlocked" when it is trainable).
 *  - `chooseVariant(world, owner, kind, ledger?)` — the AI's
 *    substitution: variants are tactical tradeoffs, not ladders (M15,
 *    docs/research/mk-variants.md), so the AI picks situationally.
 *    When the owner is rich (`funds >= VARIANT_RICH_FUNDS`) it takes
 *    the top affordable tier; otherwise it takes the best
 *    combatValue/cost among the unlocked + affordable tiers at or
 *    above the input tier. Deterministic: pure reads, fixed tier
 *    order, no RNG.
 *  - `variantArtBase(kind)` — the kind whose art a unit renders with
 *    (identity for base kinds). The render layer's mapping entry point.
 *  - `variantLine(base)` / `variantTierOf(kind)` — tier ordering for
 *    UI palette grouping and tests.
 *
 * Determinism: no RNG, no wall clock, no mutation. Variant defs are
 * plain UNIT_DEFS data; unit records carry no new fields, so no
 * snapshot version bump and no digest change were required (kind ids
 * were already snapshotted and digested).
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import { UNIT_DEFS, type UnitKind } from './units';
import { getPlayer, hasProductionBuilding } from './city';
import { isUnitAvailableForAge } from './ages';

/**
 * Union of the 28 tech-level variant kind ids — every `${base}Mk2|Mk3`
 * key (no base kind matches the pattern). Lets consumers type the
 * complement (base kinds) without hand-maintaining a second union.
 */
export type VariantUnitKind = Extract<UnitKind, `${string}Mk${2 | 3}`>;

/**
 * All variant kinds (Mk II + Mk III), in UNIT_KINDS order. Derived from
 * the defs — the single source of truth is `UnitDef.variantOf`.
 *
 * Lazily derived (the pathfinding.ts `gridCells()` precedent): this
 * module sits inside the units→city→world→ai import cycle (ai.ts
 * consumes `chooseVariant`), so reading UNIT_DEFS at module-eval
 * time sees undefined when first reached through ai. The computation is
 * cached; the first call always lands after the module graph is fully
 * evaluated (no sim module calls it during evaluation).
 */
let _variantKinds: readonly VariantUnitKind[] | undefined;
export function getVariantKinds(): readonly VariantUnitKind[] {
  if (!_variantKinds) {
    _variantKinds = (Object.keys(UNIT_DEFS) as UnitKind[]).filter(
      (k): k is VariantUnitKind => UNIT_DEFS[k].variantOf !== undefined,
    );
  }
  return _variantKinds;
}

/**
 * True when `kind` is a tech-level variant (Mk II / Mk III) rather than
 * a base kind.
 */
export function isVariant(kind: UnitKind): boolean {
  return UNIT_DEFS[kind]?.variantOf !== undefined;
}

/**
 * The base kind a variant upgrades (e.g. 'tankMk2' → 'tank'). Identity
 * for base kinds. Unknown kinds pass through unchanged.
 */
export function variantBaseOf(kind: UnitKind): UnitKind {
  return UNIT_DEFS[kind]?.variantOf ?? kind;
}

/**
 * The kind whose ART a unit renders with: the base kind for variants
 * (art-shared by design — §AD12), the kind itself otherwise. This is
 * the mapping the render layer consults in `modelSourceFor`,
 * `proceduralFor`, and `hullSizeFor` so a variant resolves to the
 * base kind's MODEL_SOURCES entry — zero new MODEL_PATHS keys.
 */
export function variantArtBase(kind: UnitKind): UnitKind {
  return variantBaseOf(kind);
}

/**
 * The tech tier of a kind: 1 for base kinds, 2 for Mk II, 3 for Mk III.
 * Driven by the def's `variantTier` (base kinds leave it undefined).
 */
export function variantTierOf(kind: UnitKind): number {
  return UNIT_DEFS[kind]?.variantTier ?? 1;
}

/**
 * The full tech line for a base kind: [base, Mk II, Mk III] in tier
 * order (shorter when a base has fewer variants). The UI palette
 * workstream uses this to group a base with its variants.
 */
export function variantLine(base: UnitKind): UnitKind[] {
  const root = variantBaseOf(base);
  const line = [root];
  for (const k of getVariantKinds()) {
    if (variantBaseOf(k) === root) line.push(k);
  }
  return line.sort((a, b) => variantTierOf(a) - variantTierOf(b));
}

/**
 * True when `owner` may currently train `kind` — the exact gate the
 * spawnUnit command validator enforces, as a pure read the UI and AI
 * can consult BEFORE issuing a command:
 *
 *  1. In a peaceful world, military defs are locked out (WS-A lockout).
 *  2. The world's age must reach the def's `minAge`.
 *  3. The owner must hold the def's `requiredBuilding` (completed,
 *     real or AI-virtually-constructed — `hasProductionBuilding`
 *     covers both).
 *
 * Valid for base kinds too. Pure: no RNG, no mutation. Note the
 * deliberate omission of affordability and hangar capacity — those are
 * the issuer's problem at command time (the AI's `spawn` helper and the
 * human palette check funds separately); this function answers only
 * "is it unlocked".
 */
export function isVariantUnlocked(world: World, owner: number, kind: UnitKind): boolean {
  const def = UNIT_DEFS[kind];
  if (!def) return false;
  // Grand-expansion Phase 8 (peaceful mode, WS-A): military defs cannot
  // be trained in a peaceful world — mirrored from the spawnUnit
  // validator so the palette never offers what the command layer would
  // reject loudly.
  if (world.peaceful === true && def.military === true) return false;
  // Age gating: the owner's minAge (or later) — per-side ages (roadmap A1, 2026-10-01).
  if (!isUnitAvailableForAge(world, owner, def.minAge)) return false;
  // Production gating: the base's requiredBuilding is kept on variants,
  // so a variant trains from the same production line once unlocked.
  if (def.requiredBuilding && !hasProductionBuilding(world, owner, def.requiredBuilding)) {
    return false;
  }
  return true;
}

/** Per-think spend reservations (the AI's ThinkLedger shape, structural). */
export interface VariantLedger {
  funds: number;
  materials: number;
  manpower: number;
}

/**
 * Funds at or above which the AI is "rich" and `chooseVariant` takes
 * the top affordable tier instead of the best value/cost. Set well
 * above any single unit's price (the most expensive variant trains
 * for under 5,000 funds) but within reach of a developed economy, so
 * the value branch actually runs in real games.
 */
export const VARIANT_RICH_FUNDS = 8000;

/**
 * Rough "how much fight does this def buy": hp × DPS × a range
 * factor. Deliberately coarse — it only needs to rank tiers of the
 * SAME variant line, where the numbers are close by design (the M15
 * tradeoffs keep every tier competitive). Documented with the full
 * rationale in docs/research/mk-variants.md §3.
 */
export function combatValueOf(kind: UnitKind): number {
  const def = UNIT_DEFS[kind];
  if (!def) return 0;
  if (def.damage > 0 && def.cooldownTicks > 0) {
    return def.hp * (def.damage / def.cooldownTicks) * (1 + def.range / 50);
  }
  // Non-combat (damage 0: haulers, transports): logistics value —
  // survivability × speed × cargo moved.
  const cargo = (def.cargoFuelCapacity ?? 0) + (def.cargoAmmoCapacity ?? 0);
  return def.hp * def.speed * (1 + cargo / 100);
}

/** Training price of a kind: funds + materials (same scale). */
export function trainCostOf(kind: UnitKind): number {
  const def = UNIT_DEFS[kind];
  if (!def) return Infinity;
  return def.trainFunds + def.trainMaterials;
}

/** Combat value per unit of cost — the situational pick's score. */
export function valuePerCost(kind: UnitKind): number {
  return combatValueOf(kind) / Math.max(1, trainCostOf(kind));
}

/**
 * The Classic AI's variant substitution (PLAN §3.9 / §6: "no AI
 * capability cliff" — the AI must actually use the new content).
 *
 * Mk II/III variants are GENUINE TACTICAL TRADEOFFS, not stat ladders
 * (M15 tradeoff redesign, 2026-10-01 — see docs/research/mk-variants.md):
 * every tier is better at something and worse at something, so "highest
 * tier" is not always the right pick. Given the kind the AI's
 * composition logic chose, this returns the tier it should actually
 * train:
 *
 *  - candidates: the variant line at or above the input tier, filtered
 *    to unlocked-for-the-owner (`isVariantUnlocked`) AND affordable
 *    right now (stockpile minus the per-think ledger reservations);
 *    the input kind unchanged when nothing qualifies;
 *  - rich owners (`funds >= VARIANT_RICH_FUNDS`): the TOP tier — when
 *    money is no object, take the sharpest tool;
 *  - everyone else: the best combatValue/cost ratio — the situational
 *    pick (a slow siege gun is wasted escort money; a cheap fast base
 *    tank can be the right buy).
 *
 * Called once per train in `thinkProduction` — a substitution, not a
 * rewrite: the counter/base-mix logic above it is untouched, and the
 * existing `spawn` helper re-checks affordability through the ledger
 * before issuing, so a stale read can never produce a bad command.
 * Deterministic: pure reads, fixed tier order, no RNG.
 */
export function chooseVariant(
  world: World,
  owner: number,
  kind: UnitKind,
  ledger?: VariantLedger,
): UnitKind {
  const base = variantBaseOf(kind);
  const player = getPlayer(world.city, owner);
  if (!player) return kind;
  const funds = player.funds - (ledger?.funds ?? 0);
  const materials = player.materials - (ledger?.materials ?? 0);
  const manpower = player.manpower - (ledger?.manpower ?? 0);
  const inputTier = variantTierOf(kind);
  // Never downgrade below the input tier: a substitution may only
  // upgrade the AI's pick (an explicit Mk II request stays Mk II+).
  const candidates = variantLine(base).filter((c) => {
    if (variantTierOf(c) < inputTier) return false;
    if (!isVariantUnlocked(world, owner, c)) return false;
    const def = UNIT_DEFS[c];
    if (def.manpowerCost > manpower) return false;
    if (def.trainFunds > funds || def.trainMaterials > materials) return false;
    return true;
  });
  if (candidates.length === 0) return kind;
  if (funds >= VARIANT_RICH_FUNDS) {
    // Rich: the top tier — money is no object, take the sharpest tool.
    return candidates.reduce((a, b) => (variantTierOf(b) > variantTierOf(a) ? b : a));
  }
  // Otherwise: best combat value per cost — the situational pick.
  const firstCandidate = candidates[0];
  if (firstCandidate === undefined) {
    // B27: no `!` — the empty check above guarantees [0] exists; unreachable.
    return kind;
  }
  let best = firstCandidate;
  let bestScore = valuePerCost(best);
  for (const c of candidates.slice(1)) {
    const score = valuePerCost(c);
    if (score > bestScore + 1e-9) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}
