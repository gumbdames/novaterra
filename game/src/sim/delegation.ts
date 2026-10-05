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
 * NOVATERRA — sim/delegation.ts — chain of command (opt-in delegation).
 *
 * Design (Phase 3):
 *  - Nothing is automated by default. The player explicitly assigns a
 *    mayor or a general; dismissal returns full manual control.
 *  - Mayors auto-manage tax rates within a player-chosen policy
 *    (balanced / growth / revenue). Applied once per economy tick.
 *  - Mayors also place buildings per a player-chosen build policy
 *    (housing / industry / balanced), one building every 10 sim-seconds,
 *    using the same placement validation as the player. When no zoned
 *    spot is free they paint a matching zone block first.
 *  - Generals command an army group (an explicit unit list) under a
 *    player-chosen stance:
 *      aggressive — chase the nearest visible enemy each unit can hit;
 *      defensive  — engage enemies near the group's position, else hold;
 *      hold       — stop all movement/chasing (units still fire back when
 *                   attacked: opportunistic fire is combat's job, not the
 *                   general's).
 *  - Generals are fair like the Classic AI: they only see enemies via
 *    `getVisibleEnemies()` (sight-based, no fog cheating).
 *  - Orders go through the normal command queue (issuer `general:<owner>`),
 *    so they validate exactly like player orders and apply at tick
 *    boundaries. A general never mutates unit state directly.
 *  - The cabinet is UI-only (ui/hud.ts reuses evaluateAdvisor with
 *    minister attribution) — no sim state needed.
 *
 * State is plain JSON-safe data, snapshotted (v5) and digested.
 *
 * Pure module: no DOM, no three.js, no wall clock, no Math.random.
 * Safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue, CommandSpec } from './commands';
import { CommandRejectedError } from './commands';
import type { SimSystem } from './tick';
import {
  getPlayer,
  validatePlacement,
  BUILDING_DEFS,
  ZoneType,
  UTILITY_ZONE,
  type BuildingKind,
} from './city';
import type { TerrainData } from './terrain';
import { rngBank } from './world';
import { UNIT_DEFS, findUnit, type UnitKind, type UnitRecord } from './units';
import { canTarget } from './combat';
import { getVisibleEnemies } from './ai';
import { dist, dist2 } from './deterministic';

/** Mayor tax policy: the player picks the goal, the mayor sets the rates. */
export type MayorPolicy = 'balanced' | 'growth' | 'revenue';
export const MAYOR_POLICIES: MayorPolicy[] = ['balanced', 'growth', 'revenue'];

/**
 * Tax rates [residential, commercial, industrial, airport] a mayor
 * enforces. Balanced: steady income. Growth: low taxes to attract
 * population. Revenue: squeeze every fund out of the city.
 * Grand-expansion Phase 5 (S5, 2026-09-30): the 4th element is the
 * airport-zone rate — the mayor sets it like the others (airport
 * policy mirrors industrial: airports are production-adjacent
 * infrastructure, taxed for growth or revenue the same way).
 */
export const MAYOR_POLICY_RATES: Record<MayorPolicy, [number, number, number, number]> = {
  balanced: [0.15, 0.15, 0.15, 0.15],
  growth: [0.08, 0.1, 0.08, 0.08],
  revenue: [0.25, 0.22, 0.25, 0.25],
};

/**
 * Mayor build policy: the player picks the priority, the mayor places
 * the buildings. Housing → homes/apartments; industry → factories/farms;
 * balanced → whatever the city lacks most (shops included).
 */
export type MayorBuildPolicy = 'housing' | 'industry' | 'balanced';
export const MAYOR_BUILD_POLICIES: MayorBuildPolicy[] = ['housing', 'industry', 'balanced'];

/** General's standing orders for the assigned army group. */
export type GeneralStance = 'aggressive' | 'defensive' | 'hold';
export const GENERAL_STANCES: GeneralStance[] = ['aggressive', 'defensive', 'hold'];

/** One mayor assignment: at most one per owner. */
export interface MayorAssignment {
  owner: number;
  policy: MayorPolicy;
  /** What the mayor builds: housing, industry, or balanced. */
  buildPolicy: MayorBuildPolicy;
}

/** Theatres of command (Prompt 1 chain of command). */
export type TheatreCommand = 'northern' | 'southern' | 'naval' | 'central';
export const THEATRE_COMMANDS: TheatreCommand[] = ['northern', 'southern', 'naval', 'central'];

/** One general assignment: at most one per owner. */
export interface GeneralAssignment {
  owner: number;
  /** Stable unit ids under this general's command (pruned when units die). */
  unitIds: number[];
  stance: GeneralStance;
  theatre?: TheatreCommand;
}

/** Chain-of-command state. Plain data — snapshotted + digested. */
export interface DelegationState {
  mayors: MayorAssignment[];
  generals: GeneralAssignment[];
}

/** Fresh delegation state: nobody delegated, nothing automated. */
export function initDelegation(): DelegationState {
  return { mayors: [], generals: [] };
}

/** Find a player's mayor, if one is assigned. */
export function getMayor(world: World, owner: number): MayorAssignment | undefined {
  return world.delegation.mayors.find((m) => m.owner === owner);
}

/** Find a player's general, if one is assigned. */
export function getGeneral(world: World, owner: number): GeneralAssignment | undefined {
  return world.delegation.generals.find((g) => g.owner === owner);
}

/** Canonical JSON-safe encoding for snapshots and digests. */
export function encodeDelegationState(d: DelegationState): unknown {
  return {
    mayors: d.mayors.map((m) => ({ owner: m.owner, policy: m.policy, buildPolicy: m.buildPolicy })),
    generals: d.generals.map((g) => ({
      owner: g.owner,
      unitIds: [...g.unitIds],
      stance: g.stance,
      theatre: g.theatre,
    })),
  };
}

function isMayorPolicy(p: unknown): p is MayorPolicy {
  return p === 'balanced' || p === 'growth' || p === 'revenue';
}

function isMayorBuildPolicy(p: unknown): p is MayorBuildPolicy {
  return p === 'housing' || p === 'industry' || p === 'balanced';
}

function isGeneralStance(s: unknown): s is GeneralStance {
  return s === 'aggressive' || s === 'defensive' || s === 'hold';
}

export function isTheatreCommand(t: unknown): t is TheatreCommand {
  return t === 'northern' || t === 'southern' || t === 'naval' || t === 'central';
}

/** Restore delegation state from a snapshot payload. */
export function decodeDelegationState(data: unknown): DelegationState {
  const d = data as { mayors?: unknown[]; generals?: unknown[] };
  const mayors: MayorAssignment[] = [];
  for (const m of d?.mayors ?? []) {
    const r = m as { owner: unknown; policy: unknown; buildPolicy: unknown };
    if (typeof r.owner === 'number' && Number.isInteger(r.owner) && isMayorPolicy(r.policy)) {
      // buildPolicy is new in the polish pass; older snapshots default it.
      mayors.push({
        owner: r.owner,
        policy: r.policy,
        buildPolicy: isMayorBuildPolicy(r.buildPolicy) ? r.buildPolicy : 'balanced',
      });
    }
  }
  const generals: GeneralAssignment[] = [];
  for (const g of d?.generals ?? []) {
    const r = g as { owner: unknown; unitIds: unknown; stance: unknown; theatre?: unknown };
    if (
      typeof r.owner === 'number' && Number.isInteger(r.owner) &&
      Array.isArray(r.unitIds) && isGeneralStance(r.stance)
    ) {
      const unitIds = (r.unitIds as unknown[]).filter(
        (id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0,
      );
      generals.push({
        owner: r.owner,
        unitIds,
        stance: r.stance,
        theatre: isTheatreCommand(r.theatre) ? r.theatre : undefined,
      });
    }
  }
  return { mayors, generals };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function payloadStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

function validateOwner(world: World, payload: Record<string, unknown>): number | string {
  const owner = payloadInt(payload, 'owner');
  if (owner === null || !getPlayer(world.city, owner)) return 'unknown owner';
  return owner;
}

const assignMayorSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = validateOwner(world, cmd.payload);
    if (typeof owner === 'string') return `assignMayor: ${owner}`;
    const policy = payloadStr(cmd.payload, 'policy');
    if (!isMayorPolicy(policy)) {
      return `assignMayor: policy must be one of ${MAYOR_POLICIES.join(', ')}`;
    }
    const buildPolicy = cmd.payload['buildPolicy'];
    if (buildPolicy !== undefined && !isMayorBuildPolicy(buildPolicy)) {
      return `assignMayor: buildPolicy must be one of ${MAYOR_BUILD_POLICIES.join(', ')}`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const policy = payloadStr(cmd.payload, 'policy') as MayorPolicy;
    const buildPolicy = isMayorBuildPolicy(cmd.payload['buildPolicy'])
      ? (cmd.payload['buildPolicy'] as MayorBuildPolicy)
      : 'balanced';
    const existing = getMayor(world, owner);
    if (existing) {
      existing.policy = policy;
      existing.buildPolicy = buildPolicy;
      return { owner, policy, buildPolicy, updated: true };
    }
    world.delegation.mayors.push({ owner, policy, buildPolicy });
    return { owner, policy, buildPolicy, updated: false };
  },
};

const setMayorBuildPolicySpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = validateOwner(world, cmd.payload);
    if (typeof owner === 'string') return `setMayorBuildPolicy: ${owner}`;
    if (!getMayor(world, owner)) return `setMayorBuildPolicy: player ${owner} has no mayor`;
    const buildPolicy = payloadStr(cmd.payload, 'buildPolicy');
    if (!isMayorBuildPolicy(buildPolicy)) {
      return `setMayorBuildPolicy: buildPolicy must be one of ${MAYOR_BUILD_POLICIES.join(', ')}`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const buildPolicy = payloadStr(cmd.payload, 'buildPolicy') as MayorBuildPolicy;
    (getMayor(world, owner) as MayorAssignment).buildPolicy = buildPolicy;
    return { owner, buildPolicy };
  },
};

const dismissMayorSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = validateOwner(world, cmd.payload);
    if (typeof owner === 'string') return `dismissMayor: ${owner}`;
    if (!getMayor(world, owner)) return `dismissMayor: player ${owner} has no mayor`;
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const i = world.delegation.mayors.findIndex((m) => m.owner === owner);
    world.delegation.mayors.splice(i, 1);
    return { owner };
  },
};

const assignGeneralSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = validateOwner(world, cmd.payload);
    if (typeof owner === 'string') return `assignGeneral: ${owner}`;
    const stance = payloadStr(cmd.payload, 'stance');
    if (!isGeneralStance(stance)) {
      return `assignGeneral: stance must be one of ${GENERAL_STANCES.join(', ')}`;
    }
    const raw = cmd.payload['unitIds'];
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) {
      return 'assignGeneral: unitIds must be a non-empty array of up to 500 unit ids';
    }
    const theatre = cmd.payload['theatre'];
    if (theatre !== undefined && !isTheatreCommand(theatre)) {
      return `assignGeneral: theatre must be one of ${THEATRE_COMMANDS.join(', ')}`;
    }
    for (const id of raw) {
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
        return 'assignGeneral: unitIds must be positive integers';
      }
      const unit = findUnit(world, id);
      if (!unit) return `assignGeneral: no unit with id ${id}`;
      if (unit.owner !== owner) return `assignGeneral: unit ${id} is not owned by player ${owner}`;
      if (unit.hp <= 0) return `assignGeneral: unit ${id} is dead`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const stance = payloadStr(cmd.payload, 'stance') as GeneralStance;
    const theatre = isTheatreCommand(cmd.payload['theatre']) ? cmd.payload['theatre'] : undefined;
    const unitIds = (cmd.payload['unitIds'] as number[]).slice();
    const existing = getGeneral(world, owner);
    if (existing) {
      existing.unitIds = unitIds;
      existing.stance = stance;
      existing.theatre = theatre;
      return { owner, stance, theatre, units: unitIds.length, updated: true };
    }
    world.delegation.generals.push({ owner, unitIds, stance, theatre });
    return { owner, stance, theatre, units: unitIds.length, updated: false };
  },
};

const dismissGeneralSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = validateOwner(world, cmd.payload);
    if (typeof owner === 'string') return `dismissGeneral: ${owner}`;
    if (!getGeneral(world, owner)) return `dismissGeneral: player ${owner} has no general`;
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const i = world.delegation.generals.findIndex((g) => g.owner === owner);
    world.delegation.generals.splice(i, 1);
    return { owner };
  },
};

const setGeneralStanceSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = validateOwner(world, cmd.payload);
    if (typeof owner === 'string') return `setGeneralStance: ${owner}`;
    if (!getGeneral(world, owner)) return `setGeneralStance: player ${owner} has no general`;
    const stance = payloadStr(cmd.payload, 'stance');
    if (!isGeneralStance(stance)) {
      return `setGeneralStance: stance must be one of ${GENERAL_STANCES.join(', ')}`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const stance = payloadStr(cmd.payload, 'stance') as GeneralStance;
    (getGeneral(world, owner) as GeneralAssignment).stance = stance;
    return { owner, stance };
  },
};

/** Register the chain-of-command command kinds on a queue. */
export function registerDelegationCommands(queue: CommandQueue): void {
  queue.register('assignMayor', assignMayorSpec);
  queue.register('dismissMayor', dismissMayorSpec);
  queue.register('setMayorBuildPolicy', setMayorBuildPolicySpec);
  queue.register('assignGeneral', assignGeneralSpec);
  queue.register('dismissGeneral', dismissGeneralSpec);
  queue.register('setGeneralStance', setGeneralStanceSpec);
}

// ---------------------------------------------------------------------------
// Systems
// ---------------------------------------------------------------------------

/**
 * Mayor system: once per economy tick (30 ticks), each assigned mayor
 * sets its player's tax rates to the policy's rates. No mayor, no change —
 * manual rates are untouched.
 *
 * Building automation: every MAYOR_BUILD_TICKS, each mayor places one
 * building per its build policy (opt-in: only when a mayor is assigned).
 * The mayor picks the kind from the policy, finds a valid spot via the
 * same validatePlacement the player uses, and issues a normal
 * placeBuilding command. If no zoned spot exists, it paints a zone block
 * first and builds there next cycle. Deterministic: candidate order
 * derives from the 'city' RNG stream.
 */
export function createMayorSystem(queue: CommandQueue, terrain: TerrainData): SimSystem {
  return (world: World, _dt: number): void => {
    if (world.tick % 30 === 0) {
      for (const mayor of world.delegation.mayors) {
        const player = getPlayer(world.city, mayor.owner);
        if (!player) continue;
        const rates = MAYOR_POLICY_RATES[mayor.policy];
        player.taxRates[0] = rates[0];
        player.taxRates[1] = rates[1];
        player.taxRates[2] = rates[2];
        // Grand-expansion Phase 5 (S5): the mayor sets the airport rate too.
        player.taxRates[3] = rates[3];
      }
    }
    if (world.tick % MAYOR_BUILD_TICKS !== 0) return;
    for (const mayor of world.delegation.mayors) {
      mayorBuildStep(queue, terrain, world, mayor);
    }
  };
}

/** A mayor places one building every 10 sim-seconds. */
export const MAYOR_BUILD_TICKS = 300;
/** How many candidate spots the mayor tries before giving up for the cycle. */
const MAYOR_PLACEMENT_TRIES = 40;

/** Building kinds a mayor considers, per build policy (in preference order). */
const MAYOR_BUILD_CHOICES: Record<MayorBuildPolicy, BuildingKind[]> = {
  housing: ['house', 'apartment', 'house'],
  industry: ['factory', 'farm', 'factory'],
  balanced: ['house', 'shop', 'factory'],
};

/**
 * Pick what to build: the policy's preference list, but for 'balanced'
 * prefer the kind the city has fewest of (so the city rounds out).
 */
function pickMayorBuilding(world: World, mayor: MayorAssignment): BuildingKind {
  const choices = MAYOR_BUILD_CHOICES[mayor.buildPolicy];
  if (mayor.buildPolicy !== 'balanced') {
    // Housing/industry: build the first kind the player can afford.
    const player = getPlayer(world.city, mayor.owner);
    for (const kind of choices) {
      const def = BUILDING_DEFS[kind];
      if (player && player.funds >= def.costFunds && player.materials >= def.costMaterials) {
        return kind;
      }
    }
    return choices[0] as BuildingKind;
  }
  // Balanced: count existing buildings per kind, build the scarcest.
  const counts = new Map<BuildingKind, number>();
  for (const b of world.city.buildings) {
    if (b.owner !== mayor.owner) continue;
    counts.set(b.kind, (counts.get(b.kind) ?? 0) + 1);
  }
  let best = choices[0] as BuildingKind;
  let bestCount = Infinity;
  for (const kind of choices) {
    const c = counts.get(kind) ?? 0;
    if (c < bestCount) {
      best = kind;
      bestCount = c;
    }
  }
  return best;
}

/** Centroid of an owner's buildings (the mayor builds outward from here). */
function mayorBaseCentroid(world: World, owner: number): { x: number; z: number } {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const b of world.city.buildings) {
    if (b.owner === owner) {
      x += b.cx;
      z += b.cz;
      n += 1;
    }
  }
  return n === 0 ? { x: 32, z: 32 } : { x: x / n, z: z / n };
}

/**
 * One mayor build step: try to place the policy's building near the base.
 * Falls back to painting a matching zone block when nothing valid exists.
 */
function mayorBuildStep(
  queue: CommandQueue,
  terrain: TerrainData,
  world: World,
  mayor: MayorAssignment,
): void {
  const issuer = `mayor:${mayor.owner}`;
  const kind = pickMayorBuilding(world, mayor);
  const def = BUILDING_DEFS[kind];
  const base = mayorBaseCentroid(world, mayor.owner);
  const bank = rngBank(world);
  // Deterministic candidate scan: a square spiral around the base, starting
  // at a stream-derived offset so successive cycles don't retry identically.
  // Same seed + same state => same placements.
  const startDx = Math.floor(bank.next('city') * 5) - 2;
  const startDz = Math.floor(bank.next('city') * 5) - 2;
  let tried = 0;
  for (let ring = 0; ring < 12 && tried < MAYOR_PLACEMENT_TRIES; ring += 1) {
    for (let dx = -ring; dx <= ring && tried < MAYOR_PLACEMENT_TRIES; dx += 1) {
      for (let dz = -ring; dz <= ring && tried < MAYOR_PLACEMENT_TRIES; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        tried += 1;
        const cx = Math.round(base.x + startDx + dx);
        const cz = Math.round(base.z + startDz + dz);
        const err = validatePlacement(
          terrain,
          world.city,
          {
            kind,
            owner: mayor.owner,
            cx,
            cz,
            facing: 0,
          },
          // 2026-10-05 (Fix 4): the spiral must agree with the
          // placeBuilding command's unit check — otherwise it burns a
          // try on a site the command rejects at enqueue.
          world.units,
        );
        if (err === null) {
          tryOrder(queue, world, issuer, {
            kind: 'placeBuilding',
            payload: { kind, owner: mayor.owner, cx, cz, facing: 0 },
          });
          return;
        }
      }
    }
  }
  // No valid spot: zone a fresh block for this building's zone type so the
  // next cycle has somewhere to build. Center it on a deterministic offset.
  if (def.zone === UTILITY_ZONE) return;
  const zone = def.zone as number;
  const zx = Math.round(base.x + (bank.next('city') * 2 - 1) * 20);
  const zz = Math.round(base.z + (bank.next('city') * 2 - 1) * 20);
  tryOrder(queue, world, issuer, {
    kind: 'paintZone',
    payload: { owner: mayor.owner, zone, x0: zx - 4, z0: zz - 4, x1: zx + 4, z1: zz + 4 },
  });
}

/** How often a general reassesses the battlefield (2 sim-seconds). */
export const GENERAL_THINK_TICKS = 60;
/** Defensive stance: engage enemies this close (world units) to the group. */
export const GENERAL_DEFENSIVE_RADIUS = 45;

/**
 * Living units of a general's group, in id order. Prunes dead units from
 * the assignment so it never grows stale.
 */
function livingGroupUnits(world: World, general: GeneralAssignment): UnitRecord[] {
  const out: UnitRecord[] = [];
  const kept: number[] = [];
  const ids = [...general.unitIds].sort((a, b) => a - b);
  for (const id of ids) {
    const unit = findUnit(world, id);
    if (unit && unit.hp > 0 && unit.owner === general.owner) {
      out.push(unit);
      kept.push(id);
    }
  }
  general.unitIds = kept;
  return out;
}

/**
 * Nearest enemy this unit can actually hit (domain check), by distance
 * with stable-id tiebreak. `enemies` must already be sight-filtered
 * (getVisibleEnemies) — the general never sees through fog.
 */
function nearestHittable(
  unit: UnitRecord,
  enemies: UnitRecord[],
): UnitRecord | undefined {
  const def = UNIT_DEFS[unit.kind as UnitKind];
  if (!def || def.damage <= 0) return undefined;
  let best: UnitRecord | undefined;
  let bestDist = Infinity;
  for (const e of enemies) {
    if (!canTarget(def, e)) continue;
    const d = dist(e.x - unit.x, e.z - unit.z);
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) < 1e-9 && e.id < (best?.id ?? Infinity))) {
      best = e;
      bestDist = d;
    }
  }
  return best;
}

/** Enqueue an order; a rejection (stale target etc.) skips that unit. */
function tryOrder(
  queue: CommandQueue,
  world: World,
  issuer: string,
  cmd: { kind: string; payload: Record<string, unknown> },
): void {
  try {
    queue.enqueue(world, { kind: cmd.kind, issuer, payload: cmd.payload });
  } catch (e) {
    if (!(e instanceof CommandRejectedError)) throw e;
    // Stale between think and enqueue (target died, unit died): the next
    // think tick reassesses. Never crash the tick on a general's order.
  }
}

/**
 * General system: every 60 ticks each assigned general issues orders
 * through the command queue, per its stance. Deterministic: group units
 * in id order, enemies from the fair sight check, stable tiebreaks.
 */
export function createGeneralSystem(queue: CommandQueue): SimSystem {
  return (world: World, _dt: number): void => {
    if (world.tick % GENERAL_THINK_TICKS !== 0) return;
    for (const general of world.delegation.generals) {
      const issuer = `general:${general.owner}`;
      const group = livingGroupUnits(world, general);
      if (group.length === 0) continue;
      let visible = getVisibleEnemies(world, general.owner);
      if (general.theatre === 'northern') {
        const north = visible.filter((e) => e.z <= 0);
        if (north.length > 0) visible = north;
      } else if (general.theatre === 'southern') {
        const south = visible.filter((e) => e.z >= 0);
        if (south.length > 0) visible = south;
      } else if (general.theatre === 'naval') {
        const naval = visible.filter((e) => e.domain === 'sea');
        if (naval.length > 0) visible = naval;
      }
      if (general.stance === 'hold') {
        for (const unit of group) {
          if (unit.chasing || unit.state === 'moving' || unit.state === 'awaitingPath') {
            tryOrder(queue, world, issuer, {
              kind: 'stopUnit',
              payload: { unitId: unit.id, owner: general.owner },
            });
          }
        }
        continue;
      }
      if (general.stance === 'aggressive') {
        for (const unit of group) {
          const enemy = nearestHittable(unit, visible);
          if (!enemy) continue;
          if (unit.chasing && unit.targetId === enemy.id) continue; // already on it
          tryOrder(queue, world, issuer, {
            kind: 'attackUnit',
            payload: { unitId: unit.id, targetId: enemy.id, owner: general.owner },
          });
        }
        continue;
      }
      // Defensive: hold the group's ground; engage only enemies close by.
      let cx = 0;
      let cz = 0;
      for (const unit of group) {
        cx += unit.x;
        cz += unit.z;
      }
      cx /= group.length;
      cz /= group.length;
      const near = visible.filter(
        (e) => dist2(e.x - cx, e.z - cz) <= GENERAL_DEFENSIVE_RADIUS * GENERAL_DEFENSIVE_RADIUS,
      );
      for (const unit of group) {
        const enemy = nearestHittable(unit, near);
        if (enemy) {
          if (unit.chasing && unit.targetId === enemy.id) continue;
          tryOrder(queue, world, issuer, {
            kind: 'attackUnit',
            payload: { unitId: unit.id, targetId: enemy.id, owner: general.owner },
          });
        } else if (unit.chasing) {
          // Threat left the perimeter: stand down, don't pursue.
          tryOrder(queue, world, issuer, {
            kind: 'stopUnit',
            payload: { unitId: unit.id, owner: general.owner },
          });
        }
      }
    }
  };
}
