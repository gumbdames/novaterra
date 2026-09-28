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
 * NOVATERRA — sim/ai.ts — Classic AI (deterministic, fair).
 *
 * Three difficulty levels for the single-player skirmish opponent:
 *  - cadet:     reacts every ~8s (240 ticks), trickles a few basic units,
 *               never expands, never builds counters, never attacks.
 *  - citizen:   reacts every ~4s (120 ticks), builds a basic army, attacks
 *               visible enemies, builds simple counters (AA vs air).
 *  - commander: reacts every ~2s (60 ticks), scouts with fast units,
 *               builds a balanced force, counters visible enemy composition,
 *               and expands to a forward position.
 *
 * Fairness (no cheating, no fog-of-war omniscience):
 *  - The AI only "sees" enemy units within sight range of its own units.
 *    All decisions flow through `getVisibleEnemies()` — the AI never reads
 *    enemy positions directly.
 *  - The AI issues the same commands a human player would (spawnUnit,
 *    moveUnit, moveGroup, attackUnit) through the command queue. It does
 *    not mutate world state directly.
 *
 * Determinism:
 *  - Decisions run on a fixed tick cadence per difficulty. All randomness
 *    flows through the named 'ai' RNG stream. Iteration order is by
 *    stable unit id. AI state is plain JSON-safe data, snapshotted and
 *    digested like everything else.
 *
 * Pure module: no DOM, no three.js, no wall clock, no Math.random.
 * Safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue } from './commands';
import type { SimSystem } from './tick';
import { findUnit, UNIT_DEFS, type UnitKind, type UnitRecord } from './units';
import { rngBank } from './world';
import { canTarget } from './combat';
import { isUnitAvailableForAge, getSightBonus } from './ages';

/** Classic AI difficulty levels. */
export type AIDifficulty = 'cadet' | 'citizen' | 'commander';

/** Think cadence in ticks per difficulty (30 Hz: 240 = 8s, 120 = 4s, 60 = 2s). */
export const AI_THINK_TICKS: Record<AIDifficulty, number> = {
  cadet: 240,
  citizen: 120,
  commander: 60,
};

/** Max army sizes per difficulty (soft caps for production). */
export const AI_MAX_UNITS: Record<AIDifficulty, number> = {
  cadet: 4,
  citizen: 10,
  commander: 18,
};

/** Per-player AI state. Plain data — snapshotted + digested. */
export interface AIPlayerState {
  /** Owner id this AI controls. */
  owner: number;
  /** Difficulty level. */
  difficulty: AIDifficulty;
  /** Where new units are spawned. */
  baseX: number;
  baseZ: number;
  /** Next world.tick at which this AI thinks. */
  nextThinkTick: number;
  /** Forward position for commander expansion (null until established). */
  forwardBase: { x: number; z: number } | null;
  /** Scout waypoint index (commander cycles through waypoints). */
  scoutIndex: number;
  /** How many of each kind this AI has built (for composition logic). */
  builtCounts: Record<string, number>;
}

/** AI state for the world. Plain data — snapshotted + digested. */
export interface AIState {
  players: AIPlayerState[];
}

/** Create empty AI state. */
export function initAI(): AIState {
  return { players: [] };
}

/**
 * Register an AI player. The base position is where it spawns units.
 * Called during game setup, not during ticks.
 */
export function addAIPlayer(
  world: World,
  owner: number,
  difficulty: AIDifficulty,
  baseX: number,
  baseZ: number,
): void {
  world.ai.players.push({
    owner,
    difficulty,
    baseX,
    baseZ,
    nextThinkTick: world.tick + AI_THINK_TICKS[difficulty],
    forwardBase: null,
    scoutIndex: 0,
    builtCounts: {},
  });
}

/**
 * Enemies visible to `owner`: any enemy unit within sight range of any
 * of the owner's units. This is the ONLY way the AI perceives enemies —
 * no omniscience.
 */
export function getVisibleEnemies(world: World, owner: number): UnitRecord[] {
  const own = world.units.filter((u) => u.owner === owner && u.hp > 0);
  if (own.length === 0) return [];
  const out: UnitRecord[] = [];
  const seen = new Set<number>();
  // Signals Grid (Connectivity age) grants +sight to all units.
  const sightBonus = getSightBonus(world);
  for (const e of world.units) {
    if (e.owner === owner || e.hp <= 0) continue;
    for (const o of own) {
      const def = UNIT_DEFS[o.kind as UnitKind];
      const sight = def.sight + sightBonus;
      const dx = e.x - o.x;
      const dz = e.z - o.z;
      // Compare squared distances; sight is in world units.
      if (dx * dx + dz * dz <= sight * sight) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
        break;
      }
    }
  }
  // Deterministic order: by id.
  out.sort((a, b) => a.id - b.id);
  return out;
}

/** Count the AI's living units by kind. */
function countUnits(world: World, owner: number): Map<UnitKind, number> {
  const m = new Map<UnitKind, number>();
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    const kind = u.kind as UnitKind;
    m.set(kind, (m.get(kind) ?? 0) + 1);
  }
  return m;
}

/** Total living units for an owner. */
function totalUnits(world: World, owner: number): number {
  let n = 0;
  for (const u of world.units) {
    if (u.owner === owner && u.hp > 0) n++;
  }
  return n;
}

/** Issue a spawnUnit command through the queue. */
function spawn(
  world: World,
  queue: CommandQueue,
  owner: number,
  kind: UnitKind,
  x: number,
  z: number,
): void {
  queue.enqueue(world, { issuer: 'ai', kind: 'spawnUnit', payload: { kind, owner, x, z } });
}

/** Issue an attackUnit command through the queue. */
function attack(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitId: number,
  targetId: number,
): void {
  queue.enqueue(world, {
    issuer: 'ai',
    kind: 'attackUnit',
    payload: { unitId, targetId, owner },
  });
}

/** Issue a moveUnit command through the queue. */
function moveTo(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitId: number,
  x: number,
  z: number,
): void {
  queue.enqueue(world, {
    issuer: 'ai',
    kind: 'moveUnit',
    payload: { unitId, owner, x, z },
  });
}

/** Issue a moveGroup command through the queue. */
function moveGroupTo(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitIds: number[],
  x: number,
  z: number,
): void {
  queue.enqueue(world, {
    issuer: 'ai',
    kind: 'moveGroup',
    payload: { unitIds, owner, x, z },
  });
}

/** Cadet think: trickle basic units, never attack, never expand. */
function thinkCadet(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const n = totalUnits(world, ai.owner);
  if (n >= AI_MAX_UNITS.cadet) return;
  // Alternate rifles and tanks for a little variety. Deterministic via built counts.
  const rifles = ai.builtCounts['rifles'] ?? 0;
  const tanks = ai.builtCounts['tank'] ?? 0;
  const kind: UnitKind = rifles <= tanks ? 'rifles' : 'tank';
  // Slight spawn offset so units don't stack exactly.
  const idx = n;
  const x = ai.baseX + (idx % 3) * 4 - 4;
  const z = ai.baseZ + Math.floor(idx / 3) * 4 - 4;
  spawn(world, queue, ai.owner, kind, x, z);
  ai.builtCounts[kind] = (ai.builtCounts[kind] ?? 0) + 1;
}

/** Citizen think: build a basic army, attack visible enemies, simple counters. */
function thinkCitizen(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const visible = getVisibleEnemies(world, ai.owner);

  // Production: maintain army up to cap.
  if (n < AI_MAX_UNITS.citizen) {
    // Simple counter: if visible enemy air, prioritize AA.
    const enemyAir = visible.some((e) => UNIT_DEFS[e.kind as UnitKind].domain === 'air');
    const aa = counts.get('aa') ?? 0;
    let kind: UnitKind;
    if (enemyAir && aa < 3) {
      kind = 'aa';
    } else {
      // Mix: mostly rifles and tanks, some artillery.
      const rifles = counts.get('rifles') ?? 0;
      const tanks = counts.get('tank') ?? 0;
      const art = counts.get('artillery') ?? 0;
      if (tanks < 3) kind = 'tank';
      else if (rifles < 4) kind = 'rifles';
      else if (art < 2) kind = 'artillery';
      else kind = rifles <= tanks ? 'rifles' : 'tank';
    }
    const idx = n;
    spawn(world, queue, ai.owner, kind, ai.baseX + (idx % 4) * 4 - 6, ai.baseZ + Math.floor(idx / 4) * 4 - 6);
    ai.builtCounts[kind] = (ai.builtCounts[kind] ?? 0) + 1;
  }

  // Attack: order all combat units to attack the nearest visible enemy.
  if (visible.length > 0) {
    // Nearest to base (deterministic). The length check above guarantees [0] exists.
    let nearest: UnitRecord = visible[0]!;
    let best = Infinity;
    for (const e of visible) {
      const dx = e.x - ai.baseX;
      const dz = e.z - ai.baseZ;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        nearest = e;
      }
    }
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      const def = UNIT_DEFS[u.kind as UnitKind];
      if (def.damage <= 0) continue; // unarmed (hauler, transport)
      // Skip units whose weapons can't engage this target's domain
      // (e.g. tanks can't target air) — the attackUnit command would reject.
      if (!canTarget(def, nearest)) continue;
      // Only re-issue if not already attacking this target.
      if (u.targetId === nearest.id && u.chasing) continue;
      attack(world, queue, ai.owner, u.id, nearest.id);
    }
  }
}

/** Commander think: scout, balanced force, counters, expansion. */
function thinkCommander(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const visible = getVisibleEnemies(world, ai.owner);
  const bank = rngBank(world);

  // --- Scouting: keep a drone or fighter probing outward waypoints.
  const scouts = (counts.get('drone') ?? 0) + (counts.get('fighter') ?? 0);
  if (scouts === 0 && n < AI_MAX_UNITS.commander) {
    spawn(world, queue, ai.owner, 'drone', ai.baseX, ai.baseZ);
    ai.builtCounts['drone'] = (ai.builtCounts['drone'] ?? 0) + 1;
  } else {
    // Order existing scouts to waypoints (cycle through 4 compass points).
    const waypoints = [
      { x: ai.baseX + 120, z: ai.baseZ },
      { x: ai.baseX, z: ai.baseZ + 120 },
      { x: ai.baseX - 120, z: ai.baseZ },
      { x: ai.baseX, z: ai.baseZ - 120 },
    ];
    // Modulo guarantees a valid index.
    const wp = waypoints[ai.scoutIndex % waypoints.length]!;
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      if (u.kind !== 'drone' && u.kind !== 'fighter') continue;
      // Only redirect idle scouts (don't interrupt combat).
      if (u.state === 'idle' && u.targetId === 0) {
        moveTo(world, queue, ai.owner, u.id, wp.x, wp.z);
      }
    }
    ai.scoutIndex++;
  }

  // --- Production: balanced force with counters.
  if (n < AI_MAX_UNITS.commander) {
    const enemyAir = visible.filter((e) => UNIT_DEFS[e.kind as UnitKind].domain === 'air').length;
    const enemyHeavy = visible.filter((e) => UNIT_DEFS[e.kind as UnitKind].armor === 'heavy').length;
    const enemyInf = visible.filter((e) => UNIT_DEFS[e.kind as UnitKind].armor === 'light' && UNIT_DEFS[e.kind as UnitKind].domain === 'land').length;
    const aa = counts.get('aa') ?? 0;
    const art = counts.get('artillery') ?? 0;
    const tanks = counts.get('tank') ?? 0;
    const rifles = counts.get('rifles') ?? 0;
    const fighters = counts.get('fighter') ?? 0;

    let kind: UnitKind;
    if (enemyAir > 0 && aa < enemyAir + 1) kind = 'aa';
    else if (enemyAir > 0 && fighters < 2) kind = 'fighter';
    else if (enemyHeavy > 2 && art < 3) kind = 'artillery';
    else if (enemyInf > 3 && art < 2) kind = 'artillery';
    else if (tanks < 5) kind = 'tank';
    else if (rifles < 5) kind = 'rifles';
    else if (art < 3) kind = 'artillery';
    else if (aa < 2) kind = 'aa';
    else kind = 'tank';

    // Age gating (Step 8): the AI stays in Foundation, so if the chosen
    // unit requires Connectivity (e.g. fighter), fall back to a
    // Foundation-available counter instead of issuing a rejected command.
    if (!isUnitAvailableForAge(world, UNIT_DEFS[kind].minAge)) {
      kind = 'aa';
    }

    // Spawn at forward base if established, else at main base.
    const bx = ai.forwardBase ? ai.forwardBase.x : ai.baseX;
    const bz = ai.forwardBase ? ai.forwardBase.z : ai.baseZ;
    const idx = n;
    // Deterministic jitter via the ai RNG stream.
    const jx = Math.floor(bank.next('ai') * 5) - 2;
    const jz = Math.floor(bank.next('ai') * 5) - 2;
    spawn(world, queue, ai.owner, kind, bx + (idx % 4) * 4 - 6 + jx, bz + Math.floor(idx / 4) * 4 - 6 + jz);
    ai.builtCounts[kind] = (ai.builtCounts[kind] ?? 0) + 1;
  }

  // --- Expansion: once we have 8+ units, establish a forward base
  //     toward the nearest visible enemy (or a default direction).
  if (!ai.forwardBase && n >= 8) {
    let fx = ai.baseX + 80;
    let fz = ai.baseZ;
    if (visible.length > 0) {
      let nearest: UnitRecord = visible[0]!;
      let best = Infinity;
      for (const e of visible) {
        const dx = e.x - ai.baseX;
        const dz = e.z - ai.baseZ;
        const d = dx * dx + dz * dz;
        if (d < best) {
          best = d;
          nearest = e;
        }
      }
      // Forward base halfway toward the enemy.
      fx = (ai.baseX + nearest.x) / 2;
      fz = (ai.baseZ + nearest.z) / 2;
    }
    ai.forwardBase = { x: fx, z: fz };
    // Send a small detachment to the forward base.
    const detachment: number[] = [];
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      if (UNIT_DEFS[u.kind as UnitKind].domain !== 'land') continue;
      if (u.targetId !== 0) continue; // don't pull units already fighting
      detachment.push(u.id);
      if (detachment.length >= 4) break;
    }
    if (detachment.length > 0) {
      moveGroupTo(world, queue, ai.owner, detachment, fx, fz);
    }
  }

  // --- Attack: like citizen, but also uses fighters vs air.
  if (visible.length > 0) {
    let nearest: UnitRecord = visible[0]!;
    let best = Infinity;
    for (const e of visible) {
      const dx = e.x - ai.baseX;
      const dz = e.z - ai.baseZ;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        nearest = e;
      }
    }
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      const def = UNIT_DEFS[u.kind as UnitKind];
      if (def.damage <= 0) continue;
      if (u.kind === 'drone') continue; // scouts don't fight
      if (u.targetId === nearest.id && u.chasing) continue;
      // Fighters prefer air targets; others take the nearest.
      const targetIsAir = UNIT_DEFS[nearest.kind as UnitKind].domain === 'air';
      if (u.kind === 'fighter' && !targetIsAir) {
        const airTarget = visible.find((e) => UNIT_DEFS[e.kind as UnitKind].domain === 'air');
        if (airTarget) {
          if (u.targetId === airTarget.id && u.chasing) continue;
          // Fighters can target air; the find above guarantees domain.
          attack(world, queue, ai.owner, u.id, airTarget.id);
          continue;
        }
      }
      // Skip units whose weapons can't engage this target's domain.
      if (!canTarget(def, nearest)) continue;
      attack(world, queue, ai.owner, u.id, nearest.id);
    }
  }
}

/**
 * The AI system. Runs every tick; each AI player thinks on its own
 * cadence. Issues commands through the queue — never mutates world
 * state directly (except its own `world.ai` state, which is plain data).
 */
export function createAISystem(queue: CommandQueue): SimSystem {
  return (world: World) => {
    // Deterministic iteration: AI players in registration order.
    for (const ai of world.ai.players) {
      if (world.tick < ai.nextThinkTick) continue;
      ai.nextThinkTick = world.tick + AI_THINK_TICKS[ai.difficulty];
      switch (ai.difficulty) {
        case 'cadet':
          thinkCadet(world, queue, ai);
          break;
        case 'citizen':
          thinkCitizen(world, queue, ai);
          break;
        case 'commander':
          thinkCommander(world, queue, ai);
          break;
      }
    }
  };
}

/**
 * Canonical JSON-safe encoding of AI state for snapshots and digests.
 * Players in registration order; builtCounts keys sorted.
 */
export function encodeAIState(ai: AIState): unknown {
  return {
    players: ai.players.map((p) => ({
      owner: p.owner,
      difficulty: p.difficulty,
      baseX: p.baseX,
      baseZ: p.baseZ,
      nextThinkTick: p.nextThinkTick,
      forwardBase: p.forwardBase ? { x: p.forwardBase.x, z: p.forwardBase.z } : null,
      scoutIndex: p.scoutIndex,
      builtCounts: Object.keys(p.builtCounts).sort().reduce<Record<string, number>>(
        (acc, k) => {
          const v = p.builtCounts[k];
          if (v !== undefined) acc[k] = v;
          return acc;
        },
        {},
      ),
    })),
  };
}

/** Restore AI state from a snapshot payload (see snapshot.ts). */
export function decodeAIState(data: unknown): AIState {
  const d = data as {
    players: {
      owner: number;
      difficulty: AIDifficulty;
      baseX: number;
      baseZ: number;
      nextThinkTick: number;
      forwardBase: { x: number; z: number } | null;
      scoutIndex: number;
      builtCounts: Record<string, number>;
    }[];
  };
  return {
    players: (d.players ?? []).map((p) => ({
      owner: p.owner,
      difficulty: p.difficulty,
      baseX: p.baseX,
      baseZ: p.baseZ,
      nextThinkTick: p.nextThinkTick,
      forwardBase: p.forwardBase ? { x: p.forwardBase.x, z: p.forwardBase.z } : null,
      scoutIndex: p.scoutIndex,
      builtCounts: { ...p.builtCounts },
    })),
  };
}

// Re-export for tests that need the UnitRecord type.
export type { UnitRecord };
export { findUnit };
