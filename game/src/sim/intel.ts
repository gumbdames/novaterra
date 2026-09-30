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
 * NOVATERRA — sim/intel.ts — the intel asset economy, detection, and
 * covert operations.
 *
 * Grand-expansion intel roster (§3.8 / §4 S6). Two halves, one contract:
 *
 * ROSTER HALF (workstream 2, 2026-09-30) — the def-side mechanics:
 *  - `runIntelAccrual` — deterministic asset accrual from the §3.8
 *    buildings (reads `BuildingDef.intelOutput`). Wired into the
 *    economy tick by the core half (below), dt = sim-seconds elapsed.
 *  - `isDetected(unit, viewerOwner, world)` — the stealth contract:
 *    pure function of positions + the unit's burn timer, zero extra
 *    snapshot/digest cost for the geometry (PLAN §4 S6).
 *  - `detectionRadiusAt(world, owner, x, z)` — the detection-radius
 *    field the contract names.
 *  - Upgrade-effect math the core consumes: `intelSightBonus`
 *    (re-exported from upgrades.ts — see below) and
 *    `sabotageDurationSec` (counterIntel resistance).
 *  - Player state shape `world.city.players[o].intel = { surveillance,
 *    operational, counterIntel }` lives in city.ts (the exact contract
 *    names); `BuildingRecord.sabotagedUntil` likewise.
 *
 * CORE HALF (sim-core workstream, 2026-09-30) — the operations:
 *  - Asset plumbing: `addIntelAsset` (the roster seam — buildings and
 *    cheats feed assets through it), `spendIntelAsset`, `getIntelAssets`.
 *  - Covert-op commands: `infiltrateBuilding` / `sabotage` / `stealTech`
 *    (`registerIntelCommands`), with adjacency validation and asset
 *    costs.
 *  - Spy mission state on `UnitRecord` (`missionEndsAt`,
 *    `missionTargetId`, `embeddedIn`, `infiltrationProgress`,
 *    `spottedUntil`), advanced by `createIntelSystem()` every tick.
 *  - Detection jitter as ACTION rolls: sabotage and failed tech-steals
 *    may burn the spy (`spottedUntil`), drawn from named `intel-<owner>`
 *    RNG streams.
 *
 * Design rules (PLAN §13 non-goals + the deterministic-sim contract):
 *  - The asset/detection core has no dice rolls: accrual is flat
 *    per-second, detection geometry is pure, sabotage duration is a
 *    fixed number with a fixed counter-intel multiplier.
 *  - The operations half DOES roll: steal success and spot checks draw
 *    from `world.rng` named streams `intel-<owner>` (derived from the
 *    world seed like the `ai-<owner>` streams; thief rolls on the
 *    thief's stream, spot checks on the victim's). No `Math.random()`
 *    anywhere — grep for it.
 *  - No global pools: assets are per-player counters.
 *  - No hyper-lethal counter-intel: counter-intel shortens sabotage
 *    and widens detection — it never kills units by itself.
 *
 * Import discipline (R2): this module imports city/units by value and
 * commands/world/tick by TYPE only. It deliberately does NOT import
 * upgrades.ts by value: upgrades.ts consumes `intelSightBonus` (the
 * `effectiveSight` hook), so the value edge runs upgrades→intel —
 * one-directional, no cycle (units→upgrades→intel→units would close a
 * 3-cycle). Upgrade checks here go through the local `hasUpgradeId`
 * helper (identical semantics to `hasUpgrade` in upgrades.ts).
 * `intelSightBonus` is implemented in upgrades.ts next to its only
 * consumer and re-exported here so the §3.8 contract ("import it from
 * sim/intel.ts") keeps working.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under
 * Node/vitest. Deterministic: same state + same inputs ⇒ identical
 * outcomes.
 */

import type { World } from './world';
import type { SimSystem } from './tick';
import type { CommandQueue } from './commands';
import {
  BUILDING_DEFS,
  CELL_WORLD_SIZE,
  cellCenterWorld,
  getPlayer,
} from './city';
import type { BuildingRecord, IntelAssetKey, IntelAssets } from './city';
import { UNIT_DEFS, findUnit } from './units';
import type { UnitRecord } from './units';
import { rngBank } from './world';

// ---------------------------------------------------------------------------
// Upgrade checks (local — see the import-discipline note above)
// ---------------------------------------------------------------------------

/**
 * Whether `owner` has researched upgrade `id`. Identical semantics to
 * `hasUpgrade` in upgrades.ts; local so the upgrades→intel value edge
 * stays one-directional (R2 — no import cycles).
 */
function hasUpgradeId(world: World, owner: number, id: string): boolean {
  const list = world.upgrades[owner];
  return list !== undefined && list.includes(id);
}

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** signalsIntel: surveillance accrual multiplier (the intel upgrade pair). */
export const SIGNALS_INTEL_SURVEILLANCE_MULT = 1.5;
/** counterIntel: counter-intel asset accrual multiplier. */
export const COUNTER_INTEL_ASSET_MULT = 1.25;
/** counterIntel: extra detection radius (world units) on the owner's detection buildings. */
export const COUNTER_INTEL_RADIUS_BONUS = 25;
/** Base sabotage duration in sim-seconds (a real disruption, not an economy one-shot). */
export const BASE_SABOTAGE_DURATION_SEC = 45;
/** counterIntel: sabotage duration multiplier — sabotage resistance made visible. */
export const COUNTER_INTEL_SABOTAGE_DURATION_MULT = 0.5;

/** Infiltration mission length in ticks (20 sim-seconds at 30 tps). */
export const INFILTRATE_DURATION_TICKS = 600;
/**
 * How close (world units, to the building's footprint center) a spy must
 * be to start an infiltration or a sabotage.
 */
export const INTEL_ADJACENCY = 16;
/**
 * If the infiltrating spy strays farther than this (world units) from
 * the target building's center, the mission is cancelled.
 */
export const INFILTRATE_ABANDON_RANGE = 48;
/** Sabotage op cost, in operational assets. */
export const SABOTAGE_COST_OPERATIONAL = 25;
/** Tech-steal op cost, in surveillance assets. */
export const STEAL_COST_SURVEILLANCE = 15;
/** Base tech-steal success chance (before upgrade modifiers). */
export const STEAL_SUCCESS_BASE = 0.65;
/** Thief's signalsIntel: steal success bonus. */
export const STEAL_SIGNALS_INTEL_BONUS = 0.15;
/** Victim's counterIntel: steal success penalty. */
export const STEAL_COUNTER_INTEL_PENALTY = 0.15;
/** Research stock granted on a successful tech steal. */
export const STEAL_RESEARCH_GRANT = 40;
/** Chance a sabotage act burns the spy (spot check on the victim's stream). */
export const SABOTAGE_SPOT_CHANCE = 0.35;
/**
 * Victim's stockpiled counter-intel sharpens spot checks: each asset
 * adds this much burn chance, up to COUNTER_INTEL_SPOT_BONUS_CAP.
 * (The counter-intel asset's defensive job — "they're stockpiling
 * counter-intel" means your spies get caught more.)
 */
export const COUNTER_INTEL_SPOT_STOCKPILE_RATE = 0.002;
export const COUNTER_INTEL_SPOT_BONUS_CAP = 0.3;
/**
 * Victim's stockpiled counter-intel blunts tech steals: each asset
 * subtracts this much success chance, up to
 * COUNTER_INTEL_STEAL_PENALTY_CAP (stacks with the counterIntel
 * upgrade's STEAL_COUNTER_INTEL_PENALTY).
 */
export const COUNTER_INTEL_STEAL_STOCKPILE_RATE = 0.001;
export const COUNTER_INTEL_STEAL_PENALTY_CAP = 0.15;
/** How long (ticks) a burned spy stays visible to everyone. */
export const SPOTTED_DURATION_TICKS = 900;

/**
 * True while the building is sabotaged at this tick. Reads follow the
 * AD9 `?? 0` convention (0/undefined = not sabotaged).
 */
export function isSabotaged(building: BuildingRecord, tick: number): boolean {
  return (building.sabotagedUntil ?? 0) > tick;
}

/**
 * Accrue intel assets for every player over `dtSec` sim-seconds.
 *
 * Deterministic and id-ordered: players in `world.city.players` order,
 * their buildings in placement (id) order. A building accrues only when
 * completed (progress >= 1), operational (powered and watered — the same
 * "completed and working" gate the economy output path uses), and not
 * sabotaged.
 *
 * Upgrade effects (the roster workstream's half of the contract):
 *  - `signalsIntel` researched ⇒ surveillance accrual ×1.5.
 *  - `counterIntel` researched ⇒ counter-intel accrual ×1.25.
 *
 * Wiring: called from `runEconomyTick` (economy.ts) with dt = 1, after
 * the utility allocation (so `operational` flags are this tick's) and
 * before production.
 */
export function runIntelAccrual(world: World, dtSec: number): void {
  if (!(dtSec > 0) || !Number.isFinite(dtSec)) return;
  for (const player of world.city.players) {
    const owner = player.id;
    const survMult = hasUpgradeId(world, owner, 'signalsIntel')
      ? SIGNALS_INTEL_SURVEILLANCE_MULT
      : 1;
    const counterMult = hasUpgradeId(world, owner, 'counterIntel')
      ? COUNTER_INTEL_ASSET_MULT
      : 1;
    for (const b of world.city.buildings) {
      if (b.owner !== owner) continue;
      const def = BUILDING_DEFS[b.kind];
      const rates = def?.intelOutput;
      if (!rates) continue;
      if (b.progress < 1 || !b.operational) continue;
      if (isSabotaged(b, world.tick)) continue;
      const keys: IntelAssetKey[] = ['surveillance', 'operational', 'counterIntel'];
      for (const key of keys) {
        const rate = rates[key];
        if (rate === undefined || rate <= 0) continue;
        const mult = key === 'surveillance' ? survMult : key === 'counterIntel' ? counterMult : 1;
        player.intel[key] += rate * mult * dtSec;
      }
    }
  }
}

/** World-space center of a building's footprint. */
export function buildingCenterWorld(b: BuildingRecord): { x: number; z: number } {
  const def = BUILDING_DEFS[b.kind];
  const w = def?.footprintW ?? 1;
  const h = def?.footprintH ?? 1;
  return {
    x: cellCenterWorld(b.cx) + ((w - 1) * CELL_WORLD_SIZE) / 2,
    z: cellCenterWorld(b.cz) + ((h - 1) * CELL_WORLD_SIZE) / 2,
  };
}

/**
 * Detection radius covering (x, z) for `owner` — the contract's
 * `detectionRadiusAt(owner, x, z)`. Returns the largest effective
 * radius among the owner's completed buildings whose coverage reaches
 * the point, or 0 when nothing covers it.
 *
 * Coverage comes from `BuildingDef.detectionRadius` (listeningPost,
 * signalsStation); `counterIntel` researched adds
 * COUNTER_INTEL_RADIUS_BONUS to every source. A building detects only
 * while completed, operational, and not sabotaged — a dark listening
 * post is blind (same "completed and working" gate as accrual, so
 * sabotaging a detector blinds it). Pure function of
 * positions — zero snapshot/digest cost (PLAN §4 S6).
 */
export function detectionRadiusAt(world: World, owner: number, x: number, z: number): number {
  const radiusBonus = hasUpgradeId(world, owner, 'counterIntel') ? COUNTER_INTEL_RADIUS_BONUS : 0;
  let best = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== owner || b.progress < 1) continue;
    // A sabotaged or unpowered detector is blind — sabotage the
    // listening post, then walk the spy in.
    if (!b.operational || isSabotaged(b, world.tick)) continue;
    const radius = BUILDING_DEFS[b.kind]?.detectionRadius;
    if (radius === undefined || radius <= 0) continue;
    const c = buildingCenterWorld(b);
    const dx = c.x - x;
    const dz = c.z - z;
    const effective = radius + radiusBonus;
    if (dx * dx + dz * dz <= effective * effective && effective > best) {
      best = effective;
    }
  }
  return best;
}

/**
 * True when the unit is a spy — the only stealthed kind in the §3.8
 * roster (`UnitDef.stealth === true`, set on `spy` only). The
 * kind-name check is the pre-roster fallback the contract names.
 */
export function isSpyUnit(u: UnitRecord): boolean {
  const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
  return def?.stealth === true || u.kind === 'spy';
}

/** True when the unit is a stealth asset (spies, and later stealth kinds). */
export function isStealthAsset(u: UnitRecord): boolean {
  return isSpyUnit(u);
}

/**
 * The stealth contract: can `viewerOwner` see `unit`?
 *
 *  - Own units are always visible to their owner.
 *  - Non-stealthed units are always visible (overt recon, armies).
 *  - A burned spy (`spottedUntil` in the future — sabotage spot checks
 *    and failed tech-steals burn it) is visible to everyone.
 *  - Otherwise a stealthed unit (the spy) is visible only inside one
 *    of the viewer's detection radii (`detectionRadiusAt`).
 *
 * Pure function of world state — the geometry needs no stored state
 * (PLAN §4 S6); the burn timer is mission state, snapshotted like
 * `meltdownUntilTick`. Consumed by `acquireTarget` (combat.ts) and
 * `getVisibleEnemies` (ai.ts).
 */
export function isDetected(unit: UnitRecord, viewerOwner: number, world: World): boolean {
  if (unit.owner === viewerOwner) return true;
  if (!isStealthAsset(unit)) return true;
  if ((unit.spottedUntil ?? 0) > world.tick) return true;
  return detectionRadiusAt(world, viewerOwner, unit.x, unit.z) > 0;
}

/**
 * Sabotage duration in sim-seconds for a sabotage against `owner`'s
 * building. Base 45 s — long enough to hurt (a real disruption of
 * whatever the sabotage suspends), short enough to never one-shot an
 * economy. `counterIntel` researched halves it: sabotage resistance
 * the defender can see working.
 *
 * `owner` is the VICTIM's owner (their counter-intel resists).
 * Consumed by the sim-core workstream's `sabotage` command.
 */
export function sabotageDurationSec(world: World, victimOwner: number): number {
  const mult = hasUpgradeId(world, victimOwner, 'counterIntel')
    ? COUNTER_INTEL_SABOTAGE_DURATION_MULT
    : 1;
  return BASE_SABOTAGE_DURATION_SEC * mult;
}

/**
 * Standing unit-sight bonus (world units) for `owner`: the sum of
 * completed satelliteUplink `sightBonus` values plus the signalsIntel
 * upgrade bonus. Implemented in upgrades.ts next to its only consumer
 * (`effectiveSight`); re-exported here so the §3.8 contract ("import
 * it from sim/intel.ts") keeps working without closing a
 * units→upgrades→intel→units value cycle (R2).
 */
export { intelSightBonus, SIGNALS_INTEL_SIGHT_BONUS } from './upgrades';

/** Read one player's intel assets (undefined-safe for hand-built states). */
export function getIntelAssets(world: World, owner: number): IntelAssets {
  const p = getPlayer(world.city, owner);
  return {
    surveillance: p?.intel?.surveillance ?? 0,
    operational: p?.intel?.operational ?? 0,
    counterIntel: p?.intel?.counterIntel ?? 0,
  };
}

/**
 * Add intel assets to a player's stockpile — the roster seam: intel
 * buildings accrue through `runIntelAccrual`, but cheats, scenario
 * setup, and future sources feed assets through here. Amounts may be
 * fractional (accrual is per-second); negative amounts are rejected.
 */
export function addIntelAsset(world: World, owner: number, kind: IntelAssetKey, amount: number): void {
  if (!Number.isFinite(amount) || amount < 0) return;
  const p = getPlayer(world.city, owner);
  if (!p) return;
  p.intel[kind] += amount;
}

/**
 * Spend intel assets; returns false (spending nothing) when the
 * stockpile is short. Commands validate affordability first, so a
 * false return here means the world changed between validate and
 * apply — never silently overdraw.
 */
export function spendIntelAsset(world: World, owner: number, kind: IntelAssetKey, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < 0) return false;
  const p = getPlayer(world.city, owner);
  if (!p || p.intel[kind] < amount) return false;
  p.intel[kind] -= amount;
  return true;
}

/** Named RNG stream for `owner`'s intel rolls (thief rolls and spot checks). */
export function intelStreamName(owner: number): string {
  return `intel-${owner}`;
}

/**
 * Sabotage spot-check burn chance against `victimOwner`: base 0.35,
 * sharpened by their stockpiled counter-intel assets (capped). Pure —
 * the `sabotage` command rolls against this.
 */
export function sabotageSpotChance(world: World, victimOwner: number): number {
  const stockpile = getIntelAssets(world, victimOwner).counterIntel;
  const bonus = Math.min(COUNTER_INTEL_SPOT_BONUS_CAP, stockpile * COUNTER_INTEL_SPOT_STOCKPILE_RATE);
  return SABOTAGE_SPOT_CHANCE + bonus;
}

/**
 * Tech-steal success chance for `thiefOwner` against `victimOwner`:
 * base 0.65, +0.15 with the thief's signalsIntel, −0.15 with the
 * victim's counterIntel upgrade, −stockpile penalty (capped),
 * clamped to [0.1, 0.95]. Pure — the `stealTech` command rolls
 * against this.
 */
export function stealSuccessChance(world: World, thiefOwner: number, victimOwner: number): number {
  let chance = STEAL_SUCCESS_BASE;
  if (hasUpgradeId(world, thiefOwner, 'signalsIntel')) chance += STEAL_SIGNALS_INTEL_BONUS;
  if (hasUpgradeId(world, victimOwner, 'counterIntel')) chance -= STEAL_COUNTER_INTEL_PENALTY;
  const stockpile = getIntelAssets(world, victimOwner).counterIntel;
  chance -= Math.min(COUNTER_INTEL_STEAL_PENALTY_CAP, stockpile * COUNTER_INTEL_STEAL_STOCKPILE_RATE);
  return Math.min(0.95, Math.max(0.1, chance));
}

/**
 * Deterministic tech pick for a steal: the lexicographically lowest
 * upgrade id the victim has researched and the thief has not. Returns
 * null when there is nothing left to steal.
 */
export function pickStealableTech(world: World, thiefOwner: number, victimOwner: number): string | null {
  let best: string | null = null;
  for (const id of world.upgrades[victimOwner] ?? []) {
    if (hasUpgradeId(world, thiefOwner, id)) continue;
    if (best === null || id < best) best = id;
  }
  return best;
}

/**
 * Grant research stock to `owner` — the tech-steal payoff. This is the
 * `addStock(player, 'research', n)` precedent (economy.ts) inlined:
 * intel.ts cannot import economy.ts by value (economy.ts imports
 * intel.ts for `runIntelAccrual` — R2, no cycles), so it performs the
 * same single-field mutation directly.
 */
function grantResearch(world: World, owner: number, amount: number): void {
  const p = getPlayer(world.city, owner);
  if (p) p.research += amount;
}

/**
 * Advance all in-progress infiltration missions by one tick. Runs every
 * tick via `createIntelSystem` (cheap: only units with an active
 * mission do work). A mission completes when the timer expires (the spy
 * becomes embedded in the target building) or is cancelled when the
 * target is gone, changed hands to the spy's owner, or the spy strayed
 * too far (proximity is required for the whole infiltration).
 */
export function advanceIntelMissions(world: World): void {
  for (const u of world.units) {
    const endsAt = u.missionEndsAt ?? 0;
    if (endsAt <= 0) continue;
    const target = (u.missionTargetId ?? 0) > 0
      ? world.city.buildings.find((b) => b.id === (u.missionTargetId as number))
      : undefined;
    let cancelled = target === undefined || target.owner === u.owner;
    if (!cancelled && target !== undefined) {
      const c = buildingCenterWorld(target);
      const dx = c.x - u.x;
      const dz = c.z - u.z;
      if (dx * dx + dz * dz > INFILTRATE_ABANDON_RANGE * INFILTRATE_ABANDON_RANGE) {
        cancelled = true;
      }
    }
    if (cancelled || u.hp <= 0) {
      u.missionEndsAt = 0;
      u.missionTargetId = 0;
      u.infiltrationProgress = 0;
      continue;
    }
    u.infiltrationProgress = INFILTRATE_DURATION_TICKS - (endsAt - world.tick);
    if (world.tick >= endsAt) {
      // Embedded: the spy now operates from inside the target building
      // (required for `stealTech` against it).
      u.embeddedIn = target?.id ?? 0;
      u.missionEndsAt = 0;
      u.missionTargetId = 0;
      u.infiltrationProgress = 0;
    }
  }
}

/** The intel system: advances spy infiltration missions every tick. */
export function createIntelSystem(): SimSystem {
  return (world: World, _dt: number): void => {
    advanceIntelMissions(world);
  };
}

// ---------------------------------------------------------------------------
// Covert-op commands
// ---------------------------------------------------------------------------

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/** Shared spy lookup for the intel commands. */
function intelSpy(world: World, cmdKind: string, unitId: number, owner: number): { spy?: UnitRecord; error?: string } {
  const spy = findUnit(world, unitId);
  if (!spy) return { error: `${cmdKind}: no unit with id ${unitId}` };
  if (spy.owner !== owner) return { error: `${cmdKind}: unit ${unitId} is not owned by player ${owner}` };
  if (spy.hp <= 0) return { error: `${cmdKind}: unit ${unitId} is dead` };
  if (!isSpyUnit(spy)) return { error: `${cmdKind}: unit ${unitId} (${spy.kind}) is not a spy` };
  return { spy };
}

/** Shared enemy-building lookup for the intel commands. */
function intelTargetBuilding(
  world: World, cmdKind: string, buildingId: number, owner: number,
): { building?: BuildingRecord; error?: string } {
  const building = world.city.buildings.find((b) => b.id === buildingId);
  if (!building) return { error: `${cmdKind}: no building with id ${buildingId}` };
  if (building.owner === owner) return { error: `${cmdKind}: cannot target your own building ${buildingId}` };
  if (building.progress < 1) return { error: `${cmdKind}: building ${buildingId} is not completed` };
  return { building };
}

function withinAdjacency(spy: UnitRecord, building: BuildingRecord): boolean {
  const c = buildingCenterWorld(building);
  const dx = c.x - spy.x;
  const dz = c.z - spy.z;
  return dx * dx + dz * dz <= INTEL_ADJACENCY * INTEL_ADJACENCY;
}

const infiltrateSpec = {
  validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
    const unitId = payloadInt(cmd.payload, 'unitId');
    const buildingId = payloadInt(cmd.payload, 'buildingId');
    const owner = payloadInt(cmd.payload, 'owner');
    if (unitId === null || unitId <= 0) return 'infiltrateBuilding: payload.unitId must be a positive integer';
    if (buildingId === null || buildingId <= 0) return 'infiltrateBuilding: payload.buildingId must be a positive integer';
    if (owner === null) return 'infiltrateBuilding: payload.owner must be an integer';
    const { spy, error: spyError } = intelSpy(world, 'infiltrateBuilding', unitId, owner);
    if (spyError) return spyError;
    const { building, error: bError } = intelTargetBuilding(world, 'infiltrateBuilding', buildingId, owner);
    if (bError) return bError;
    if ((spy as UnitRecord).missionEndsAt !== undefined && (spy as UnitRecord).missionEndsAt as number > 0) {
      return `infiltrateBuilding: spy ${unitId} is already infiltrating building ${(spy as UnitRecord).missionTargetId}`;
    }
    if ((spy as UnitRecord).embeddedIn === buildingId) {
      return `infiltrateBuilding: spy ${unitId} is already embedded in building ${buildingId}`;
    }
    if (!withinAdjacency(spy as UnitRecord, building as BuildingRecord)) {
      return `infiltrateBuilding: spy ${unitId} is not adjacent to building ${buildingId}`;
    }
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const spy = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
    const buildingId = cmd.payload['buildingId'] as number;
    spy.failReason = null;
    // A new infiltration abandons any previous embedding.
    spy.embeddedIn = 0;
    spy.missionEndsAt = world.tick + INFILTRATE_DURATION_TICKS;
    spy.missionTargetId = buildingId;
    spy.infiltrationProgress = 0;
    return spy.id;
  },
};

const sabotageSpec = {
  validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
    const unitId = payloadInt(cmd.payload, 'unitId');
    const buildingId = payloadInt(cmd.payload, 'buildingId');
    const owner = payloadInt(cmd.payload, 'owner');
    if (unitId === null || unitId <= 0) return 'sabotage: payload.unitId must be a positive integer';
    if (buildingId === null || buildingId <= 0) return 'sabotage: payload.buildingId must be a positive integer';
    if (owner === null) return 'sabotage: payload.owner must be an integer';
    const { spy, error: spyError } = intelSpy(world, 'sabotage', unitId, owner);
    if (spyError) return spyError;
    const { building, error: bError } = intelTargetBuilding(world, 'sabotage', buildingId, owner);
    if (bError) return bError;
    if (isSabotaged(building as BuildingRecord, world.tick)) {
      return `sabotage: building ${buildingId} is already sabotaged`;
    }
    if (!withinAdjacency(spy as UnitRecord, building as BuildingRecord)) {
      return `sabotage: spy ${unitId} is not adjacent to building ${buildingId}`;
    }
    if (getIntelAssets(world, owner).operational < SABOTAGE_COST_OPERATIONAL) {
      return `sabotage: need ${SABOTAGE_COST_OPERATIONAL} operational assets`;
    }
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const spy = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
    const building = world.city.buildings.find((b) => b.id === (cmd.payload['buildingId'] as number)) as BuildingRecord;
    const owner = cmd.payload['owner'] as number;
    spy.failReason = null;
    spendIntelAsset(world, owner, 'operational', SABOTAGE_COST_OPERATIONAL);
    const durationTicks = Math.round(sabotageDurationSec(world, building.owner) * 30);
    building.sabotagedUntil = world.tick + durationTicks;
    // Detection jitter: the act may burn the spy. Rolled on the VICTIM's
    // stream — it is their counter-intelligence apparatus that spots it.
    // Their stockpiled counter-intel sharpens the check (sabotageSpotChance).
    const spotted = rngBank(world).next(intelStreamName(building.owner)) < sabotageSpotChance(world, building.owner);
    if (spotted) spy.spottedUntil = world.tick + SPOTTED_DURATION_TICKS;
    return { buildingId: building.id, sabotagedUntil: building.sabotagedUntil, spotted };
  },
};

const stealTechSpec = {
  validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
    const unitId = payloadInt(cmd.payload, 'unitId');
    const buildingId = payloadInt(cmd.payload, 'buildingId');
    const owner = payloadInt(cmd.payload, 'owner');
    if (unitId === null || unitId <= 0) return 'stealTech: payload.unitId must be a positive integer';
    if (buildingId === null || buildingId <= 0) return 'stealTech: payload.buildingId must be a positive integer';
    if (owner === null) return 'stealTech: payload.owner must be an integer';
    const { spy, error: spyError } = intelSpy(world, 'stealTech', unitId, owner);
    if (spyError) return spyError;
    const { building, error: bError } = intelTargetBuilding(world, 'stealTech', buildingId, owner);
    if (bError) return bError;
    if ((spy as UnitRecord).embeddedIn !== buildingId) {
      return `stealTech: spy ${unitId} is not embedded in building ${buildingId} (infiltrate it first)`;
    }
    // "Embedded" means inside: the spy must still be at the building to
    // work its equipment — walking home does not end the embedding, but
    // the steal itself needs proximity.
    if (!withinAdjacency(spy as UnitRecord, building as BuildingRecord)) {
      return `stealTech: spy ${unitId} is not adjacent to building ${buildingId}`;
    }
    if (pickStealableTech(world, owner, (building as BuildingRecord).owner) === null) {
      return `stealTech: nothing left to steal from player ${(building as BuildingRecord).owner}`;
    }
    if (getIntelAssets(world, owner).surveillance < STEAL_COST_SURVEILLANCE) {
      return `stealTech: need ${STEAL_COST_SURVEILLANCE} surveillance assets`;
    }
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const spy = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
    const building = world.city.buildings.find((b) => b.id === (cmd.payload['buildingId'] as number)) as BuildingRecord;
    const owner = cmd.payload['owner'] as number;
    spy.failReason = null;
    spendIntelAsset(world, owner, 'surveillance', STEAL_COST_SURVEILLANCE);
    const tech = pickStealableTech(world, owner, building.owner) as string;
    // Steal success, rolled on the THIEF's stream. signalsIntel sharpens
    // the operation; the victim's counterIntel (upgrade + stockpiled
    // assets) blunts it — see stealSuccessChance.
    const success = rngBank(world).next(intelStreamName(owner)) < stealSuccessChance(world, owner, building.owner);
    if (success) {
      // A successful steal grants research progress toward the stolen
      // tech — the thief still researches it at the lab; the op just
      // pays part of the bill (the addStock precedent).
      grantResearch(world, owner, STEAL_RESEARCH_GRANT);
    } else {
      // A failed steal burns the spy: visible to everyone for a while.
      spy.spottedUntil = world.tick + SPOTTED_DURATION_TICKS;
    }
    return { tech, success, grantedResearch: success ? STEAL_RESEARCH_GRANT : 0 };
  },
};

/**
 * Register the covert-op commands. The UI intel panel and the AI issue
 * these through the queue like any other command:
 *  - `infiltrateBuilding` { unitId, buildingId, owner } — starts a
 *    600-tick infiltration; the spy becomes embedded on completion.
 *  - `sabotage` { unitId, buildingId, owner } — adjacency + 25
 *    operational assets; the building goes offline until
 *    `sabotagedUntil` (counterIntel resistance shortens it).
 *  - `stealTech` { unitId, buildingId, owner } — requires the spy to
 *    be embedded in the building; 15 surveillance assets; success
 *    grants research, failure burns the spy.
 */
export function registerIntelCommands(queue: CommandQueue): void {
  queue.register('infiltrateBuilding', infiltrateSpec as never);
  queue.register('sabotage', sabotageSpec as never);
  queue.register('stealTech', stealTechSpec as never);
}
