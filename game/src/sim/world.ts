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
 * NOVATERRA — sim/world.ts — the world store (plain data only).
 *
 * Responsibilities:
 *  - The single source of truth for simulation state: tick counter, sim
 *    time, entity registry, RNG state. Everything here is interfaces +
 *    factory functions — no methods on state, nothing unserializable.
 *  - Stable numeric entity ids (`nextId` counter; id 0 is reserved and never
 *    assigned, so "no entity" has a safe sentinel).
 *
 * Deterministic iteration (the determinism contract, see AGENTS.md):
 *  - `entities` is a plain array in spawn order. It is NEVER reordered;
 *    despawn uses splice so the surviving order stays spawn order.
 *  - Systems must iterate `world.entities` directly (id-ascending, since
 *    ids are assigned in spawn order). Never build a `Map`/`Set` over
 *    entities and iterate it for sim logic — iterate the array.
 *  - `despawnEntity` is O(n); acceptable until the ECS perf step (Phase 1,
 *    step 6) replaces the store with a measured design.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { RngState } from './rng';
import { createRngBank } from './rng';
import type { RngBank } from './rng';
import type { CityState } from './city';
import { initCity } from './city';
import type { UnitRecord } from './units';
import type { PathfindingState } from './pathfinding';
import { initPathfinding } from './pathfinding';
import type { AIState } from './ai';
import { initAI } from './ai';
import type { PerSideAges } from './ages';
import type { DelegationState } from './delegation';
import { initDelegation } from './delegation';
import type { DiplomacyState } from './diplomacy';
import { initDiplomacy } from './diplomacy';
import type { CeremonyEvent } from './envoy';
import type { LuminariesState } from './luminaries';
import { initLuminaries } from './luminaries';
import type { CombineState } from './combine';
import { initCombine } from './combine';
import type { WonderCountdown } from './wonderCountdown';
import type { DoctrineId } from './doctrine';
import type { FogState } from './fog';
import { createFogState } from './fog';
import type { SuperweaponState } from './superweapons';
import { initSuperweapons } from './superweapons';
import { initUpgrades, initUpgradeLevels } from './upgrades';

/** Minimal per-entity record. Later steps add components; the shape stays plain. */
export interface EntityRecord {
  /** Stable numeric id, assigned from `world.nextId`. Never reused. */
  id: number;
  /** Kind tag, e.g. 'settler', 'farm', 'tank'. Free-form for now. */
  kind: string;
  /** Position on the ground plane (y-up world). Plain numbers, no vectors. */
  x: number;
  z: number;
}

/** The whole simulation state. Plain data — snapshot() copies it verbatim. */
export interface World {
  /** Simulation tick counter. Advances by exactly 1 per tick. */
  tick: number;
  /** Sim time in seconds. Always `tick / TICK_HZ` — never accumulated, so no float drift. */
  time: number;
  /** Master seed: map generation + RNG stream derivation. */
  seed: number;
  /** Next entity id to assign. Id 0 is reserved (never assigned). */
  nextId: number;
  /** Entity registry in spawn order. See module docs for iteration rules. */
  entities: EntityRecord[];
  /** All RNG stream states. Part of every snapshot. */
  rng: RngState;
  /** City state: roads, zones, buildings, players. Snapshotted + digested. */
  city: CityState;
  /** Mobile units, in spawn order. Snapshotted + digested. */
  units: UnitRecord[];
  /** Pathfinding coordinator state (queues + live flow fields). Snapshotted + digested. */
  pathfinding: PathfindingState;
  /** Classic AI state (per-player difficulty, timers, strategy). Snapshotted + digested. */
  ai: AIState;
  /**
   * Per-side age states (Foundation → Ascendance + National Program),
   * keyed by owner id. Per-side since 2026-10-01 (roadmap A1): each
   * nation advances and pays independently — the age race is real.
   * Missing owner = Foundation (see getAgeState in ages.ts).
   * Snapshotted + digested.
   */
  ages: PerSideAges;
  /** Chain-of-command delegations (mayors, generals). Snapshotted + digested. */
  delegation: DelegationState;
  /** Superweapon slots, scheduled strikes, fx. Snapshotted + digested. */
  superweapons: SuperweaponState;
  /** Per-player researched upgrade ids (spec docs/research/roster-expansion.md §4). */
  upgrades: Record<number, string[]>;
  /**
   * Roadmap B9 (2026-10-02): per-player levels of REPEATABLE upgrades
   * (currently only 'advancedResearch'): owner -> upgrade id -> level.
   * One-shot upgrades live in `upgrades`; repeatable ones live HERE so
   * the id list keeps its "researched set" meaning and save/digest code
   * stays simple. Snapshotted + digested like `upgrades`.
   */
  upgradeLevels: Record<number, Record<string, number>>;
  /**
   * Roadmap B10 (2026-10-02): smoothed per-player net flow rates of the
   * stockpiles (units/second, EWMA over economy ticks): owner ->
   * resource -> rate. Display data only — NOT snapshotted, NOT
   * digested, never read by the sim. A save/load restarts the averages
   * at 0; they converge within ~10 seconds of play.
   */
  economyFlows: Record<number, Partial<Record<string, number>>>;
  /**
   * Grand-expansion Phase 8 (peaceful mode, 2026-09-30): true when this
   * world plays peaceful — rivals exist but play peacefully; military
   * defs (units/buildings/upgrades — see the `military` def flag) and
   * covert ops are locked out at the command layer, and conquest
   * victory checks are bypassed. There is NO victory condition:
   * peaceful mode is endless (2026-10-01) — the game never declares
   * a winner or a loser. Set at tick 0 from `SessionOptions.peaceful`
   * and NEVER toggled mid-game (the lockout validates only at enqueue
   * because the flag is immutable). Snapshotted and digested; legacy
   * snapshots decode to false (no version bump — the AD9
   * neutral-default precedent).
   */
  peaceful: boolean;
  /**
   * Roadmap B2 (2026-10-02): the skirmish victory condition, chosen at
   * setup. 'conquest' is the classic wipe-the-rival win; the others let
   * a rich economy win the game instead of an army. Set at tick 0 from
   * `SessionOptions.victoryKind` and NEVER toggled mid-game (like
   * `peaceful`). Snapshotted; legacy snapshots decode to 'conquest'
   * (no version bump — the AD9 neutral-default precedent). Peaceful
   * worlds ignore it (endless, no victory at all).
   */
  victoryKind: SkirmishVictoryKind;
  /**
   * Roadmap B3 (2026-10-02): the bilateral diplomacy state (tribute,
   * demands, ceasefires) between the player and the AI rival. Plain
   * data; snapshotted (legacy snapshots decode to a neutral fresh
   * state, no version bump — the AD9 neutral-default precedent) and
   * digested.
   */
  diplomacy: DiplomacyState;
  /**
   * Fun-audit B2 (2026-10-02): the wonder countdown — when any side
   * completes a Monument or crosses 80% of the economic/population
   * threshold, a 5-minute global countdown starts (see
   * sim/wonderCountdown.ts). Null when no countdown runs. Snapshotted
   * (AD9 neutral-default null) and digest-covered.
   */
  wonderCountdown: WonderCountdown | null;
  /**
   * Fun-audit D1 (2026-10-02): doctrine asymmetry — per-owner doctrine
   * ('republic' | 'kestrel'). Set at tick 0 from session setup, never
   * toggled mid-game. Snapshotted (AD9: missing decodes to {}) and
   * digest-covered (doctrine changes damage, sight, HP, and costs).
   * Unset owners play 'republic' (the narrative default).
   */
  doctrines: Record<number, DoctrineId>;
  /**
   * Fun-audit C3 (2026-10-02): player fog of war — per-owner explored
   * cell grids (see sim/fog.ts). Snapshotted (save/load keeps the
   * shroud; legacy snapshots decode to fresh unexplored, no version
   * bump — AD9) but NOT digested: nothing in the sim reads explored,
   * so it cannot affect behavior (the economyFlows display-data
   * precedent).
   */
  fog: FogState;
  /**
   * Combat VFX event stream (B16, 2026-10-01): visual cues the sim
   * emits during the tick for the render layer. Drained by the render
   * each frame, cleared by the sim at tick start. NOT snapshotted,
   * NOT digested — pure view, derived from deterministic state.
   */
  combatEvents: import('./combat').CombatEvent[];
  /**
   * Fun-audit Tier 4 (E1/E2/E3, 2026-10-02): ceremony VFX event stream
   * (envoy/combine/luminary moments — doves, arrivals, departures).
   * Drained by the render each frame, cleared by the envoy system at
   * tick start (the combatEvents precedent — the envoy system is the
   * earliest ceremony emitter; see sim/envoy.ts). NOT snapshotted,
   * NOT digested — pure view, derived from deterministic state.
   */
  ceremonyEvents: CeremonyEvent[];
  /**
   * Fun-audit Tier 4 (E2, 2026-10-02): the luminary state — the pending
   * presidential decision, Defector production marks, the Whistleblower
   * cover-up, the Prodigy's upkeep cut, and retired drill instructors.
   * Plain data: snapshotted + digested (AD9).
   */
  luminaries: LuminariesState;
  /**
   * Fun-audit Tier 4 (E3, 2026-10-02): the Vostok Combine — the
   * merchant visit state machine. Plain data: snapshotted + digested
   * (AD9). MERCHANT-ONLY: no raid state exists.
   */
  combine: CombineState;
}

/**
 * Roadmap B2 (2026-10-02): skirmish victory conditions. Defined in
 * sim/world.ts (not ui/session.ts) so the World type and the snapshot
 * codec can use it without a sim→ui import (ui/session.ts owns the
 * checks and re-exports the type).
 */
export type SkirmishVictoryKind = 'conquest' | 'economic' | 'population' | 'monument';

/** All victory kinds, in setup-UI order. */
export const SKIRMISH_VICTORY_KINDS: SkirmishVictoryKind[] = [
  'conquest',
  'economic',
  'population',
  'monument',
];

/**
 * Roadmap B2 (2026-10-02): narrows an unknown snapshot value to a
 * victory kind. Anything outside the union (corrupt saves, future
 * kinds) falls back to conquest rather than crashing.
 */
export function isSkirmishVictoryKind(value: unknown): value is SkirmishVictoryKind {
  return (
    value === 'conquest' ||
    value === 'economic' ||
    value === 'population' ||
    value === 'monument'
  );
}

/** First assignable entity id (0 stays reserved as the "no entity" sentinel). */
export const FIRST_ENTITY_ID = 1;

/** Create a fresh world at tick 0. */
export function createWorld(seed: number): World {
  return {
    tick: 0,
    time: 0,
    seed: seed >>> 0,
    nextId: FIRST_ENTITY_ID,
    entities: [],
    rng: {},
    city: initCity(),
    units: [],
    pathfinding: initPathfinding(),
    ai: initAI(),
    ages: {} as PerSideAges,
    delegation: initDelegation(),
    superweapons: initSuperweapons(),
    upgrades: initUpgrades(),
    upgradeLevels: initUpgradeLevels(),
    // Roadmap B10: flow rates start empty and are filled by the first
    // economy tick; never snapshotted (derived display data).
    economyFlows: {},
    // Peaceful defaults to false; the session sets it from
    // SessionOptions.peaceful for fresh worlds, restoreSnapshot for saves.
    peaceful: false,
    // Roadmap B2: conquest default; the session overrides from
    // SessionOptions.victoryKind for fresh worlds, restoreSnapshot for saves.
    victoryKind: 'conquest',
    // Roadmap B3: neutral diplomacy; restoreSnapshot for saves.
    diplomacy: initDiplomacy(),
    // Fun-audit B2: no countdown on a fresh world; restoreSnapshot for saves.
    wonderCountdown: null,
    // Fun-audit D1: doctrines are set by session setup (player pick +
    // seeded AI); unset owners default to 'republic'.
    doctrines: {},
    // Fun-audit C3: fog starts unexplored; the fog system's priming
    // pass explores the starting base on the first tick.
    fog: createFogState(),
    // Combat VFX stream starts empty (B16).
    combatEvents: [],
    // Fun-audit Tier 4 (E1/E2/E3, 2026-10-02): ceremony VFX stream
    // starts empty; the envoy system clears it at tick start.
    ceremonyEvents: [],
    // Fun-audit Tier 4 (E2, 2026-10-02): the luminary state starts fresh.
    luminaries: initLuminaries(),
    // Fun-audit Tier 4 (E3, 2026-10-02): the Combine's first visit is
    // scheduled from the seed (merchant-only; no raid state).
    combine: initCombine(seed >>> 0),
  };
}

/** Spawn an entity. Returns the new record (also appended to `world.entities`). */
export function spawnEntity(world: World, kind: string, x: number, z: number): EntityRecord {
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new Error(`spawnEntity: kind must be a non-empty string, got ${JSON.stringify(kind)}`);
  }
  if (!Number.isFinite(x) || !Number.isFinite(z)) {
    throw new Error(`spawnEntity: x/z must be finite numbers, got ${x}, ${z}`);
  }
  const record: EntityRecord = { id: world.nextId, kind, x, z };
  world.nextId += 1;
  world.entities.push(record);
  return record;
}

/** Remove an entity by id. Returns true if one was removed, false if absent. */
export function despawnEntity(world: World, id: number): boolean {
  const index = world.entities.findIndex((e) => e.id === id);
  if (index === -1) return false;
  // splice (not swap-remove): survivors keep spawn order, so iteration order
  // stays a pure function of the spawn/despawn history.
  world.entities.splice(index, 1);
  return true;
}

/** Find an entity by id. Linear scan — fine until the ECS perf step. */
export function findEntity(world: World, id: number): EntityRecord | undefined {
  return world.entities.find((e) => e.id === id);
}

/**
 * A live RNG bank over this world's `rng` record. Draws mutate `world.rng`,
 * so they are automatically part of snapshots and digests. Create one per
 * tick (cheap) or per system — the underlying record is what matters.
 */
export function rngBank(world: World): RngBank {
  return createRngBank(world.seed, world.rng);
}
