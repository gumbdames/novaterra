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
 * Five difficulty levels for the single-player skirmish opponent:
 *  - cadet:     reacts every ~8s (240 ticks), trickles basic rifles,
 *               never builds, never researches, never counters, never attacks.
 *  - citizen:   reacts every ~4s (120 ticks), virtually constructs
 *               barracks → warFactory, fields a foundation-age combined
 *               force, attacks visible enemies, simple counters (AA vs air).
 *  - commander: reacts every ~2s (60 ticks), adds a lab + upgrade
 *               research, scouts with drones, builds the full counter
 *               table, and expands to a forward position.
 *  - general:   reacts every ~1.5s (45 ticks), larger army, basic navy
 *               (fishing economy + patrol boats) on coastal maps.
 *  - marshal:   reacts every ~1s (30 ticks), largest army, advances ages,
 *               full navy on coastal maps, uses superweapons fairly.
 *
 * Production buildings (spec docs/research/roster-expansion.md §7.1):
 * the AI never paints zones or lays roads, so it *virtually* constructs
 * production buildings in priority order as funds allow: it pays the
 * full funds/materials cost upfront and the building unlocks after the
 * real build time — the exact precedent of the Phase 3 superweapon
 * facilities below. Until a building unlocks, the kinds it gates are
 * skipped in composition (the same fallback pattern as the old
 * fighter→aa fallback). Virtual buildings also yield their def.output
 * rates (the lab's research income is what funds upgrade research);
 * upkeep is waived — the AI's abstract economy has no tax loop to pay
 * it from, and charging upkeep against a fixed stockpile would punish
 * the AI for building rather than reward it.
 *
 * Fairness (no cheating, no fog-of-war omniscience):
 *  - The AI only "sees" enemy units within sight range of its own units.
 *    All decisions flow through `getVisibleEnemies()` — the AI never reads
 *    enemy positions directly.
 *  - The AI issues the same commands a human player would (spawnUnit,
 *    moveUnit, moveGroup, attackUnit, researchUpgrade) through the command
 *    queue. It does not mutate world state directly (except its own
 *    `world.ai` record and the virtual-economy credit, which mirrors what
 *    the economy system does for real buildings).
 *  - Water detection is by trial, not maphack: the AI probes for water by
 *    attempting real fishing-boat spawns around its base. Failed probes
 *    cost nothing (rejected at enqueue); a successful probe IS the first
 *    fishing boat.
 *
 * Per-match personality (seeded, deterministic — not "entirely deterministic"
 * across matches):
 *  - At `addAIPlayer` time each AI draws a small personality record from
 *    its own named RNG stream (`ai-<owner>`, derived from the world seed
 *    via rng.ts). Per-owner streams mean AI players never shift each
 *    other's draws: adding a second AI doesn't change the first's
 *    personality.
 *  - The personality holds raw traits (aggression, expansionEagerness,
 *    both 0..1) plus derived knobs: per-kind composition weight jitter
 *    (±30% on the base-mix shares — the counter table itself is
 *    untouched), a per-match order for the economy-line upgrades (the
 *    combat/support research head keeps the spec §7.4 priority),
 *    attack-timing jitter (low-aggression personalities issue attack
 *    orders every other think instead of every think), a forward-base
 *    unit threshold (6..10) plus a fallback expansion direction, and a
 *    scout waypoint rotation start. Cadet's personality is inert: cadet
 *    still trains only rifles and never builds, researches, counters,
 *    or attacks.
 *  - All draws happen once at registration; think functions only read
 *    the stored personality and draw nothing, so per-think RNG
 *    consumption is trivially deterministic (zero). Same seed + same
 *    commands ⇒ identical play; different seeds ⇒ different playstyles
 *    at the same difficulty tier. The personality is plain JSON-safe
 *    data, snapshotted and digested like the rest of the AI state.
 *
 * Determinism:
 *  - Decisions run on a fixed tick cadence per difficulty. All randomness
 *    flows through the named `ai-<owner>` RNG streams (see above).
 *    Iteration order is by stable unit id (or fixed tables). AI state is
 *    plain JSON-safe data, snapshotted and digested like everything else.
 *
 * Pure module: no DOM, no three.js, no wall clock, no Math.random.
 * Safe under Node/vitest.
 */

import type { World } from './world';
import type { CommandQueue } from './commands';
import type { SimSystem } from './tick';
import { findUnit, UNIT_DEFS, type UnitKind, type UnitRecord } from './units';
import { rngBank } from './world';
import type { RngBank } from './rng';
import { canTarget } from './combat';
import { isUnitAvailableForAge, getSightBonus, AGE_PROGRESSION } from './ages';
import { effectiveSight, hasUpgrade, registerUpgradeCommands, UPGRADE_DEFS, type UpgradeId } from './upgrades';
import { vetSightMult } from './veterancy';
import {
  getPlayer,
  hasProductionBuilding,
  isBuildingAgeMet,
  BUILDING_DEFS,
  MAP_HALF_SIZE,
  type BuildingKind,
} from './city';
import { isAegisReady, isStormReady } from './superweapons';
import { CommandRejectedError } from './commands';

/** Classic AI difficulty levels. */
export type AIDifficulty = 'cadet' | 'citizen' | 'commander' | 'general' | 'marshal';

/** Think cadence in ticks per difficulty (30 Hz: 240 = 8s, 120 = 4s, 60 = 2s). */
export const AI_THINK_TICKS: Record<AIDifficulty, number> = {
  cadet: 240,
  citizen: 120,
  commander: 60,
  general: 45,
  marshal: 30,
};

/**
 * Max army sizes per difficulty (soft caps for production).
 * Roster grew 14→28 kinds; caps grew ~40% per spec §7.5.
 * The cap counts ALL of the AI's units, so starting forces must leave
 * headroom — `ui/session.ts` gives cadet 2 starters (cap 6), everyone
 * else 6.
 */
export const AI_MAX_UNITS: Record<AIDifficulty, number> = {
  cadet: 6,
  citizen: 14,
  commander: 26,
  general: 34,
  marshal: 48,
};

/** What the AI knows about nearby water (found by probing, never maphack). */
export type AINavalStatus = 'unknown' | 'landlocked' | 'coastal';

// ---------------------------------------------------------------------------
// Per-match personality (seeded playstyle variation)
// ---------------------------------------------------------------------------

/**
 * Per-match AI personality: a small set of playstyle parameters drawn
 * once from the sim RNG when the AI player is registered. Two matches
 * with the same seed produce the same personality (deterministic
 * replay); different seeds play differently at the same difficulty.
 *
 * Difficulty keeps its meaning: personality varies HOW the AI plays, not
 * its skill tier. Think cadence, army caps, the counter table, upgrade
 * prereqs, and cadet's "rifles only, never attack" profile are all
 * untouched — personality only jitters timing, composition weights,
 * expansion eagerness, and the order of flavor-tier upgrades.
 *
 * Plain data — snapshotted + digested. Old snapshots (no personality)
 * decode to NEUTRAL_PERSONALITY, which reproduces pre-personality
 * behavior exactly.
 */
export interface AIPersonality {
  /** Raw trait 0..1: higher attacks every think, lower every other think. */
  aggression: number;
  /** Raw trait 0..1: higher establishes the forward base with fewer units. */
  expansionEagerness: number;
  /**
   * Per-kind multipliers (0.7..1.3) applied to the base-mix shares in
   * chooseUnitKind. Missing kinds count as 1. The counter table is NOT
   * jittered — counters stay exactly as designed.
   */
  mixWeights: Record<string, number>;
  /**
   * This match's order for the economy-line upgrades (the tail of
   * RESEARCH_PRIORITY). The combat/support head keeps the spec §7.4
   * priority. Empty (legacy snapshots) falls back to the default order.
   */
  researchOrder: UpgradeId[];
  /** Fallback expansion direction (radians) when no enemy is visible. */
  expansionAngle: number;
  /** Derived from aggression: attack orders every think (1) or every other think (2). */
  attackEveryNthThink: 1 | 2;
  /** Derived from expansionEagerness: units needed before the forward base (6..10). */
  expansionUnitThreshold: number;
  /** Initial scout waypoint rotation (0..3). */
  scoutStartIndex: number;
}

/** Neutral personality: reproduces pre-personality AI behavior exactly. */
export const NEUTRAL_PERSONALITY: AIPersonality = {
  aggression: 0.5,
  expansionEagerness: 0.5,
  mixWeights: {},
  researchOrder: [],
  expansionAngle: 0,
  attackEveryNthThink: 1,
  expansionUnitThreshold: 8,
  scoutStartIndex: 0,
};

/**
 * Named RNG stream for one AI player's personality draws. Per-owner (not
 * one shared stream) so AI players never shift each other's draws:
 * adding a second AI player doesn't change the first's personality.
 */
function personalityStream(owner: number): string {
  return `ai-${owner}`;
}

/** Kinds jittered by personality: the union of both base mixes. */
const MIX_JITTER_KINDS: UnitKind[] = [
  'rifles', 'tank', 'artillery', 'aa', 'spectre',
  'apc', 'sniperTeam', 'fighter', 'attackHeli',
];

/**
 * First N entries of RESEARCH_PRIORITY are the spec §7.4 combat/support
 * order (pinned by regression tests: apRounds first, …); the rest is the
 * economy line, which the personality reorders per match.
 */
const RESEARCH_HEAD_COUNT = 7;

/** Fisher-Yates shuffle of a copy, drawing from the named stream. */
function shuffled<T>(rng: RngBank, stream: string, items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.intBelow(stream, i + 1);
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

/**
 * Derive one AI player's personality from the sim RNG. Called once at
 * registration (never during ticks): draw counts are a deterministic
 * function of (owner, difficulty), and think functions draw nothing.
 */
function derivePersonality(world: World, owner: number, difficulty: AIDifficulty): AIPersonality {
  const stream = personalityStream(owner);
  const rng = rngBank(world);
  const aggression = rng.next(stream);
  const expansionEagerness = rng.next(stream);
  const p: AIPersonality = {
    aggression,
    expansionEagerness,
    mixWeights: {},
    researchOrder: [],
    expansionAngle: 0,
    attackEveryNthThink: aggression >= 0.5 ? 1 : 2,
    expansionUnitThreshold: 8,
    scoutStartIndex: 0,
  };
  // Cadet's personality is inert (it never builds/researches/counters/
  // attacks/expands): the two raw traits are still drawn so the stream
  // shape is uniform, but nothing reads them.
  if (difficulty === 'cadet') return p;
  for (const kind of MIX_JITTER_KINDS) {
    p.mixWeights[kind] = rng.range(stream, 0.7, 1.3);
  }
  if (difficulty === 'citizen') return p;
  // commander+: shuffle the economy-line research tail.
  p.researchOrder = shuffled(
    rng,
    stream,
    RESEARCH_PRIORITY.slice(RESEARCH_HEAD_COUNT).map((c) => c.id),
  );
  p.expansionAngle = rng.range(stream, 0, Math.PI * 2);
  // Inverse mapping: higher eagerness ⇒ expands with fewer units.
  p.expansionUnitThreshold = 10 - Math.floor(p.expansionEagerness * 5);
  p.scoutStartIndex = rng.intBelow(stream, 4);
  return p;
}

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
  /**
   * Phase 3 superweapon construction (Marshal only). The AI places no
   * physical buildings in 0.1 Alpha; it pays the facility's full cost
   * upfront and the facility comes online after the building's build
   * time. 0 = not built. Plain data — snapshotted + digested.
   */
  superweapons: { aegisReadyTick: number; stormReadyTick: number };
  /**
   * Virtually-constructed production buildings (spec §7.1). The AI pays
   * the full cost upfront; `constructing` completes at `readyTick`
   * (buildSeconds × 30 ticks), then joins `completed` and unlocks the
   * gated roster via `hasProductionBuilding` (city.ts). One at a time.
   */
  virtualBuildings: {
    completed: BuildingKind[];
    constructing: { kind: BuildingKind; readyTick: number } | null;
  };
  /**
   * Phase 3 logistics (workstream 3): abstract supply stocks yielded by
   * completed virtual depots. The AI owns no physical buildings in
   * 0.1 Alpha (all virtual), so its depots are virtual too — these stocks
   * are the virtual-depot abstraction its consumer units draw top-ups
   * from (thinkLogistics), exactly as `creditVirtualEconomy` credits
   * virtual-building output. Plain data — snapshotted + digested
   * (missing decodes to 0, the AD9 precedent).
   */
  virtualAmmoStock?: number;
  virtualFuelStock?: number;
  /** Water scouting result: found by probe spawns, never by maphack. */
  navalStatus: AINavalStatus;
  /** Index into the deterministic naval probe ring. */
  navalProbeIndex: number;
  /** Where the probe found water (null until coastal). Navy spawns here. */
  navalWater: { x: number; z: number } | null;
  /** Set once a submarine is ever seen — gates the Sonar Suite priority. */
  seenSubmarine: boolean;
  /**
   * Per-match personality (seeded playstyle variation). Drawn once from
   * the `ai-<owner>` RNG stream at registration; think functions read it
   * but never draw from it. Plain data — snapshotted + digested.
   */
  personality: AIPersonality;
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
  // The personality is drawn from the sim RNG here at registration
  // (setup time, never mid-tick): same seed ⇒ same personality, and the
  // draws land in world.rng so they are part of snapshots and digests.
  const personality = derivePersonality(world, owner, difficulty);
  world.ai.players.push({
    owner,
    difficulty,
    baseX,
    baseZ,
    nextThinkTick: world.tick + AI_THINK_TICKS[difficulty],
    forwardBase: null,
    scoutIndex: personality.scoutStartIndex,
    builtCounts: {},
    superweapons: { aegisReadyTick: 0, stormReadyTick: 0 },
    virtualBuildings: { completed: [], constructing: null },
    navalStatus: 'unknown',
    navalProbeIndex: 0,
    navalWater: null,
    seenSubmarine: false,
    // Phase 3 logistics (workstream 3): virtual depot stocks start empty.
    // Initialized here (not just in decode) so a fresh AI player deep-equals
    // its own save/load round trip (net_saveload).
    virtualAmmoStock: 0,
    virtualFuelStock: 0,
    personality,
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
  // Signals Grid (Connectivity age) grants +sight to all units; upgrade
  // effects (Drone Optics, Advanced Avionics, Sonar Suite) stack on top.
  // Veterancy (Phase 1) multiplies the unit's own sight — the Signals
  // Grid bonus is a network effect and stays flat.
  const sightBonus = getSightBonus(world);
  for (const e of world.units) {
    if (e.owner === owner || e.hp <= 0) continue;
    for (const o of own) {
      const def = UNIT_DEFS[o.kind as UnitKind];
      // (?? 0: hand-built records without the field count as Recruit.)
      const sight = effectiveSight(world, owner, def) * vetSightMult(o.vetLevel ?? 0) + sightBonus;
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

/**
 * Enqueue a command, swallowing rejections. A rejected enqueue (failed
 * validation, or a race at apply time) is "couldn't do it this tick" —
 * the AI must never crash the tick on a rejected command. Non-rejection
 * errors still throw: those are real bugs.
 */
function issue(world: World, queue: CommandQueue, kind: string, payload: Record<string, unknown>): void {
  try {
    queue.enqueue(world, { issuer: 'ai', kind, payload });
  } catch (e) {
    if (e instanceof CommandRejectedError) return;
    throw e;
  }
}

/**
 * Issue a spawnUnit command through the queue. Skips if the AI lacks
 * manpower or cannot afford the training cost.
 */
function spawn(
  world: World,
  queue: CommandQueue,
  owner: number,
  kind: UnitKind,
  x: number,
  z: number,
): void {
  const def = UNIT_DEFS[kind];
  const player = getPlayer(world.city, owner);
  if (!player) return;
  if (player.manpower < def.manpowerCost) return;
  if (player.funds < def.trainFunds || player.materials < def.trainMaterials) return;
  issue(world, queue, 'spawnUnit', { kind, owner, x, z });
}

/**
 * Attempt a spawn and report the outcome: null when the spawn was
 * accepted (it applies at the next tick start), otherwise the rejection
 * reason. Used by the naval probe, which must distinguish "no water
 * here" (keep searching) from "can't afford it" (try again later).
 */
function trySpawn(
  world: World,
  queue: CommandQueue,
  owner: number,
  kind: UnitKind,
  x: number,
  z: number,
): string | null {
  const def = UNIT_DEFS[kind];
  const player = getPlayer(world.city, owner);
  if (!player) return 'trySpawn: unknown owner';
  if (player.manpower < def.manpowerCost) return `spawnUnit: not enough manpower (need ${def.manpowerCost})`;
  if (player.funds < def.trainFunds || player.materials < def.trainMaterials) {
    return `spawnUnit: cannot afford training cost for ${kind}`;
  }
  try {
    queue.enqueue(world, { issuer: 'ai', kind: 'spawnUnit', payload: { kind, owner, x, z } });
  } catch (e) {
    if (e instanceof CommandRejectedError) return e.reason;
    throw e;
  }
  return null;
}

/** Issue an attackUnit command through the queue. */
function attack(
  world: World,
  queue: CommandQueue,
  owner: number,
  unitId: number,
  targetId: number,
): void {
  issue(world, queue, 'attackUnit', { unitId, targetId, owner });
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
  issue(world, queue, 'moveUnit', { unitId, owner, x, z });
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
  issue(world, queue, 'moveGroup', { unitIds, owner, x, z });
}

/**
 * True when the AI can currently train `kind`: the age gate is met and
 * any required production building is held (real or virtually
 * constructed). Composition skips anything false here — this is what
 * keeps the AI from stalling on locked kinds (the old "stuck at 6
 * units" failure: citizen kept ordering tanks it could never receive).
 */
export function canTrain(world: World, owner: number, kind: UnitKind): boolean {
  const def = UNIT_DEFS[kind];
  if (!isUnitAvailableForAge(world, def.minAge)) return false;
  if (def.requiredBuilding && !hasProductionBuilding(world, owner, def.requiredBuilding)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Virtual construction (spec §7.1)
// ---------------------------------------------------------------------------

/**
 * Construction priority per difficulty, in order. Skipped entries: kinds
 * already held (real or virtual), kinds whose minAge isn't met yet, and
 * shipyard/navalYard until water is found (no point without a coast).
 * Cadet builds nothing — consistent with its "no decisions" profile.
 */
const CONSTRUCTION_PRIORITY: Record<AIDifficulty, BuildingKind[]> = {
  cadet: [],
  citizen: ['barracks', 'warFactory'],
  commander: ['barracks', 'warFactory', 'lab'],
  general: ['barracks', 'warFactory', 'lab'],
  marshal: ['barracks', 'warFactory', 'lab', 'airfield', 'radarStation', 'shipyard', 'navalYard'],
};

/** Complete whatever finished building; start the next priority kind. */
function thinkConstruction(world: World, ai: AIPlayerState): void {
  const vb = ai.virtualBuildings;
  // Complete finished construction.
  if (vb.constructing && world.tick >= vb.constructing.readyTick) {
    vb.completed.push(vb.constructing.kind);
    vb.constructing = null;
  }
  thinkUtilityConnections(world, ai);
  // One building at a time.
  if (vb.constructing) return;
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  for (const kind of CONSTRUCTION_PRIORITY[ai.difficulty]) {
    if (vb.completed.includes(kind)) continue;
    if (hasProductionBuilding(world, ai.owner, kind)) continue;
    const def = BUILDING_DEFS[kind];
    // Age-gated kinds wait for the age (marshal may get there).
    if (!isBuildingAgeMet(world.ages.age, def.minAge)) continue;
    // Naval production only makes sense with a coast to use it from.
    if ((kind === 'shipyard' || kind === 'navalYard') && ai.navalStatus !== 'coastal') continue;
    if (player.funds < def.costFunds || player.materials < def.costMaterials) continue;
    // Pay the full cost upfront (superweapon virtual-construction precedent).
    player.funds -= def.costFunds;
    player.materials -= def.costMaterials;
    vb.constructing = { kind, readyTick: world.tick + def.buildSeconds * 30 };
    return;
  }
}

/**
 * Utility-connection sub-phase (grand-expansion Phase 2, §AD2).
 *
 * 0.1 Alpha verdict: the Classic AI owns NO physical buildings — every
 * production building is virtual (a kind name in
 * `ai.virtualBuildings.completed`, no footprint, no grid position), and
 * the AI places no physical buildings anywhere in 0.1 Alpha (see the
 * module header and game/src/sim/AGENTS.md). A "stranded plant" is a
 * physical plant touching no conductor; with no physical plants, the
 * stranded condition cannot arise for the AI, so there is nothing to
 * connect and no line order to issue.
 *
 * Virtual buildings stay on the global utility pool (the §AD2 fallback):
 * `creditVirtualEconomy` credits their def.output unconditionally, and
 * the pool allocator serves every completed funded physical plant, so
 * the AI never starves for power/water and never needs lines. This is
 * the plan's accepted outcome ("or stays on the pool fallback per §AD2
 * — explicitly tested either way", PLAN.md §9 Phase 2) — pinned by
 * game/tests/sim.ai-utilities.test.ts.
 *
 * Extension hook: if the AI ever gains physical buildings, the stranded
 * check goes here. The sim workstream's network model is
 * `sim/utilityNetworks.ts` (`getUtilityModel(city, input)` →
 * `UtilityModel`; per-player `UtilitySideModel` carries
 * `plantNetwork: Map<plantId, networkId>` and
 * `unreached: number[]` — buildings reached by no network, which the
 * sim serves from the AD2 pool fallback by design). Names verified
 * against the workstream's source 2026-09-30 — the module was still
 * uncommitted then, so re-verify before wiring. For each completed
 * AI-owned physical plant absent from `plantNetwork` (or listed in
 * `unreached`), issue a line-building order from the plant toward the
 * nearest conductor (nearest existing network cell, else the road
 * grid), one attempt per think. Constraints for that future work: think
 * cadence only (never per-tick), seeded `ai-<owner>` stream draws only
 * (never the shared streams), and no mid-tick world mutation (orders
 * through the queue like every other AI action).
 */
function thinkUtilityConnections(world: World, ai: AIPlayerState): void {
  // No-op by design in 0.1 Alpha: virtual buildings have no footprint,
  // so the pool fallback (AD2) covers the AI completely. The arguments
  // are intentionally unused — they define the hook's signature for the
  // future physical-builder work described above.
  void world;
  void ai;
}

// ---------------------------------------------------------------------------
// Phase 3 logistics (workstream 3): virtual depots, truck ratios,
// abstract resupply, ammo-dry retreats.
//
// Honest abstraction statement: the Classic AI owns NO physical buildings
// in 0.1 Alpha — every production building is virtual (a kind name in
// `ai.virtualBuildings.completed`, no footprint, no grid position). So the
// AI cannot issue physical `resupply` orders (there is no depot on the map
// to route to) and its trucks never physically shuttle. Instead:
//  - completed virtual ordnance/fuel depots yield ABSTRACT stocks
//    (`virtualAmmoStock` / `virtualFuelStock`, credited per think);
//  - the AI's consumer units draw top-ups from those stocks at think
//    cadence (thinkAbstractResupply) — the same virtual-building
//    abstraction as `creditVirtualEconomy`, which credits virtual
//    building output into the AI's resources;
//  - supply/fuel trucks are still trained at the documented ratios (they
//    count toward the army cap and get role-specialized toggles via the
//    real `setSupplyToggles` command) — they are the visible logistics
//    tail whose work the abstraction stands in for.
// This is the automated layer the Phase 3 plan calls for ("logistics via
// the automated layer (no physical builder required)"). The human
// player's path — physical depots, reservations, the refill aura — is the
// real one; the AI's never touches the map. No RNG in any of it;
// id-ordered iteration throughout.
// ---------------------------------------------------------------------------

/**
 * The AI starts depot-building once it fields this many consumers of one
 * supply type: 4 = a real squad (an MLRS section, a tank platoon), not a
 * stray or two — below that the build slot isn't worth it.
 */
export const LOGISTICS_CONSUMER_THRESHOLD = 4;
/** One supply truck per this many ammo consumers (rounded up). */
const SUPPLY_TRUCK_RATIO = 6;
/** One fuel truck per this many fuel consumers (rounded up). */
const FUEL_TRUCK_RATIO = 6;
/**
 * Abstract stock yielded per think by one completed virtual depot.
 * Balance placeholders until the production workstream's physical depot
 * rates land, sized with slack for a full section at full burn: 6 MLRS
 * firing nonstop spend ~6 ammo per 60-tick think; 6 tanks moving nonstop
 * burn ~1.8 fuel per think (0.15/s) — 12/24 covers both with headroom
 * for larger armies without ever starving in the soak.
 */
const VIRTUAL_AMMO_PER_THINK = 12;
const VIRTUAL_FUEL_PER_THINK = 24;

/**
 * Virtually construct a logistics depot through the same one-at-a-time
 * virtual-building path as production buildings: full cost upfront, online
 * after buildSeconds × 30 ticks, completing in thinkConstruction. No-op
 * when already held (real or virtual), when another construction is in
 * flight, when the def is absent, or when the age gate isn't met.
 */
function thinkVirtualDepot(world: World, ai: AIPlayerState, kind: BuildingKind): void {
  if (hasProductionBuilding(world, ai.owner, kind)) return;
  const vb = ai.virtualBuildings;
  if (vb.constructing) return;
  const def = BUILDING_DEFS[kind];
  if (!def) return;
  if (!isBuildingAgeMet(world.ages.age, def.minAge)) return;
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  if (player.funds < def.costFunds || player.materials < def.costMaterials) return;
  // Pay the full cost upfront (the virtual-construction precedent).
  player.funds -= def.costFunds;
  player.materials -= def.costMaterials;
  vb.constructing = { kind, readyTick: world.tick + def.buildSeconds * 30 };
}

/**
 * Train the logistics tail: 1 supply truck per 6 ammo consumers, 1 fuel
 * truck per 6 fuel consumers (rounded up), within the army cap. Trucks
 * already fielded get role-specialized service toggles through the real
 * `setSupplyToggles` command (supply trucks: repair+rearm; fuel trucks:
 * refuel only) — idempotent, skipped once set.
 */
function thinkSupplyTrucks(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  ammoConsumers: number,
  fuelConsumers: number,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const cap = AI_MAX_UNITS[ai.difficulty];
  const wantSupply = Math.ceil(ammoConsumers / SUPPLY_TRUCK_RATIO);
  const wantFuel = Math.ceil(fuelConsumers / FUEL_TRUCK_RATIO);
  if ((counts.get('supplyTruck') ?? 0) < wantSupply && n < cap && canTrain(world, ai.owner, 'supplyTruck')) {
    const p = spawnPoint(ai, 'supplyTruck', n);
    spawn(world, queue, ai.owner, 'supplyTruck', p.x, p.z);
    ai.builtCounts['supplyTruck'] = (ai.builtCounts['supplyTruck'] ?? 0) + 1;
  } else if ((counts.get('fuelTruck') ?? 0) < wantFuel && n < cap && canTrain(world, ai.owner, 'fuelTruck')) {
    const p = spawnPoint(ai, 'fuelTruck', n);
    spawn(world, queue, ai.owner, 'fuelTruck', p.x, p.z);
    ai.builtCounts['fuelTruck'] = (ai.builtCounts['fuelTruck'] ?? 0) + 1;
  }
  // Role-specialize via the real command (rejections — e.g. the truck
  // died between think and apply — are swallowed by issue()).
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    if (u.supplyServices !== undefined) continue;
    if (u.kind === 'supplyTruck') {
      issue(world, queue, 'setSupplyToggles', {
        unitId: u.id, owner: ai.owner, repair: true, rearm: true, refuel: false,
      });
    } else if (u.kind === 'fuelTruck') {
      issue(world, queue, 'setSupplyToggles', {
        unitId: u.id, owner: ai.owner, repair: false, rearm: false, refuel: true,
      });
    }
  }
}

/**
 * Abstract resupply: consumer units draw top-ups from the AI's virtual
 * depot stocks (id order). This is the one sanctioned exception to "the
 * AI never mutates world state directly" besides its own `world.ai`
 * record and the virtual-economy credit: it does exactly what the
 * production workstream's refill aura does for physical depots, for an AI
 * that has no physical depots to route to. No RNG.
 */
function thinkAbstractResupply(world: World, ai: AIPlayerState): void {
  let ammoStock = ai.virtualAmmoStock ?? 0;
  let fuelStock = ai.virtualFuelStock ?? 0;
  if (ammoStock <= 0 && fuelStock <= 0) return;
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def) continue;
    if (ammoStock > 0 && (def.ammoCapacity ?? 0) > 0 && u.ammo < (def.ammoCapacity as number)) {
      const take = Math.min((def.ammoCapacity as number) - u.ammo, ammoStock);
      u.ammo += take;
      ammoStock -= take;
    }
    if (
      fuelStock > 0 &&
      def.fuelType === 'fossil' &&
      (def.fuelCapacity ?? 0) > 0 &&
      u.fuel < (def.fuelCapacity as number)
    ) {
      const take = Math.min((def.fuelCapacity as number) - u.fuel, fuelStock);
      u.fuel += take;
      fuelStock -= take;
    }
  }
  ai.virtualAmmoStock = ammoStock;
  ai.virtualFuelStock = fuelStock;
}

/**
 * Ammo-dry retreats: magazine units at 0 ammo break off and fall back
 * toward the base instead of chasing enemies they cannot shoot. Called
 * from the combat thinks (citizen, commander — general/marshal inherit
 * via thinkCommander). Units already holding (idle, no target) stay put.
 * No RNG; id-ordered.
 */
function thinkAmmoRetreats(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def || (def.ammoCapacity ?? 0) <= 0) continue;
    if (u.ammo > 0) continue;
    if (u.chasing || u.targetId !== 0) {
      moveTo(world, queue, ai.owner, u.id, ai.baseX, ai.baseZ);
    }
  }
}

/**
 * Phase 4 transport (S7, grand expansion): the civilian-transport AI
 * hook — deliberately a NO-OP in 0.1 Alpha. PLAN §6 requires every new
 * unit/building to ship with its AI entry in the same change; when the
 * entry is "the AI doesn't touch this", it is documented here instead
 * of left silent.
 *
 * Why the Classic AI ignores the whole transport roster:
 * - The Classic AI is a MILITARY rival (cadet…marshal). Buses, trams,
 *   passenger/freight trains and ferries are civilian fare/freight
 *   movers with no combat role (targets 'none') — training them would
 *   burn army-cap slots for zero military value.
 * - PLAN §6 defers the civilian AI trader rival ("transport/airline/
 *   peaceful: civilian AI trader rival is a later feature"). The think
 *   function that will actually run civilian transit belongs to that
 *   future rival, not to this one.
 * - The AI owns no physical buildings, roads or rails in 0.1 Alpha
 *   (all virtual), so it cannot lay the networks civilian transport
 *   needs. railStation / busDepot / ferryTerminal / marina stay off
 *   CONSTRUCTION_PRIORITY for the same reason — and so do the seven
 *   tiered transit stops/stations (busStop, taxiStand, tramStop,
 *   ferryPier, neighborhoodStation, centralStation,
 *   airportInterchange): they are civilian passenger infrastructure
 *   with no military value, and the AI has no passengers to serve.
 * - `canTrain` already auto-skips the gated kinds (bus/tram need a
 *   busDepot, trains a railStation, ferries a ferryTerminal), so the
 *   production composition code needs no changes to stay safe.
 *
 * Exported so tests can pin the no-op (world digest unchanged across a
 * think with transport units AND transit stops present).
 */
export function thinkCivilianTransport(world: World, ai: AIPlayerState): void {
  void world;
  void ai;
}

/**
 * Per-think logistics: depot construction, truck ratios, abstract
 * resupply, ammo-dry retreats. Called from thinkCitizen and
 * thinkCommander (general/marshal inherit); cadet never calls it —
 * cadet fields rifles only, which track neither fuel nor ammo.
 */
function thinkLogistics(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  let ammoConsumers = 0;
  let fuelConsumers = 0;
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (!def) continue;
    if ((def.ammoCapacity ?? 0) > 0) ammoConsumers++;
    if (def.fuelType === 'fossil' && (def.fuelCapacity ?? 0) > 0) fuelConsumers++;
  }
  // Virtual depot construction (one-at-a-time path, shared with
  // production buildings). ordnanceDepot is industry-gated; fuelDepot is
  // foundation — the age check inside thinkVirtualDepot handles it.
  if (ammoConsumers >= LOGISTICS_CONSUMER_THRESHOLD) {
    thinkVirtualDepot(world, ai, 'ordnanceDepot');
  }
  if (fuelConsumers >= LOGISTICS_CONSUMER_THRESHOLD) {
    thinkVirtualDepot(world, ai, 'fuelDepot');
  }
  // Completed virtual depots yield abstract stocks each think.
  const completed = ai.virtualBuildings.completed;
  if (completed.includes('ordnanceDepot')) {
    ai.virtualAmmoStock = (ai.virtualAmmoStock ?? 0) + VIRTUAL_AMMO_PER_THINK;
  }
  if (completed.includes('fuelDepot')) {
    ai.virtualFuelStock = (ai.virtualFuelStock ?? 0) + VIRTUAL_FUEL_PER_THINK;
  }
  thinkSupplyTrucks(world, queue, ai, ammoConsumers, fuelConsumers);
  thinkAbstractResupply(world, ai);
  thinkAmmoRetreats(world, queue, ai);
}

/**
 * Virtual-building economy: completed virtual buildings yield their
 * def.output rates (per sim-second), credited on the 1 Hz economy
 * cadence — the same tick the economy system runs for real buildings.
 * This is what gives the AI lab research income (and the barracks /
 * warFactory trickles). Upkeep is intentionally waived (see header).
 */
function creditVirtualEconomy(world: World): void {
  if (world.tick % 30 !== 0) return;
  for (const ai of world.ai.players) {
    const player = getPlayer(world.city, ai.owner);
    if (!player) continue;
    const stocks = player as unknown as Record<string, number>;
    for (const kind of ai.virtualBuildings.completed) {
      const def = BUILDING_DEFS[kind];
      for (const [res, rate] of Object.entries(def.output)) {
        stocks[res] = (stocks[res] ?? 0) + (rate ?? 0);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Composition (spec §7.2): counters first, then base-mix shares of the cap
// ---------------------------------------------------------------------------

/** Base-mix shares of the army cap (spec §7.2), per decision level. */
const BASE_MIX: Record<'citizen' | 'commander', Array<{ kind: UnitKind; share: number }>> = {
  citizen: [
    { kind: 'rifles', share: 0.35 },
    { kind: 'tank', share: 0.25 },
    { kind: 'artillery', share: 0.15 },
    { kind: 'aa', share: 0.15 },
    { kind: 'spectre', share: 0.1 },
  ],
  commander: [
    { kind: 'rifles', share: 0.3 },
    { kind: 'tank', share: 0.2 },
    { kind: 'artillery', share: 0.1 },
    { kind: 'aa', share: 0.1 },
    { kind: 'apc', share: 0.1 },
    { kind: 'sniperTeam', share: 0.05 },
    { kind: 'spectre', share: 0.05 },
    { kind: 'fighter', share: 0.05 },
    { kind: 'attackHeli', share: 0.05 },
  ],
};

const KIND_OF = (u: UnitRecord): UnitKind => u.kind as UnitKind;
const DOMAIN_OF = (u: UnitRecord): string => UNIT_DEFS[KIND_OF(u)].domain;
const ARMOR_OF = (u: UnitRecord): string => UNIT_DEFS[KIND_OF(u)].armor;

/**
 * Pick the next unit kind to train. Counter logic (spec §7.2) runs
 * first — each branch gated by canTrain so locked kinds are skipped —
 * then the base mix fills whatever is furthest below its share.
 * Always returns a trainable kind (rifles is the un-gated backbone).
 */
function chooseUnitKind(
  world: World,
  ai: AIPlayerState,
  counts: Map<UnitKind, number>,
  visible: UnitRecord[],
): UnitKind {
  const owner = ai.owner;
  const fullCounters = ai.difficulty !== 'citizen';
  const get = (k: UnitKind): number => counts.get(k) ?? 0;

  if (visible.length > 0) {
    const enemyAir = visible.filter((e) => DOMAIN_OF(e) === 'air');
    const enemySubs = visible.filter((e) => KIND_OF(e) === 'submarine');
    const enemyCapitals = visible.filter((e) =>
      KIND_OF(e) === 'destroyer' || KIND_OF(e) === 'carrier' || KIND_OF(e) === 'commandShip',
    );
    const enemyHeavy = visible.filter(
      (e) => DOMAIN_OF(e) === 'land' && (KIND_OF(e) === 'tank' || KIND_OF(e) === 'tankDestroyer'),
    );
    const enemyLight = visible.filter(
      (e) =>
        DOMAIN_OF(e) === 'land' &&
        (KIND_OF(e) === 'rifles' || KIND_OF(e) === 'sniperTeam') &&
        ARMOR_OF(e) === 'light',
    );
    const enemyArty = visible.filter(
      (e) => KIND_OF(e) === 'artillery' || KIND_OF(e) === 'mlrs',
    );
    const enemyNavy = visible.filter((e) => DOMAIN_OF(e) === 'sea');

    // vs air: aa up to air+1, then fighters.
    if (enemyAir.length > 0 && get('aa') < enemyAir.length + 1 && canTrain(world, owner, 'aa')) {
      return 'aa';
    }
    if (fullCounters && enemyAir.length > 0 && get('fighter') < 2 && canTrain(world, owner, 'fighter')) {
      return 'fighter';
    }
    // vs subs: frigate screen, ×2 per sub.
    if (
      fullCounters &&
      enemySubs.length > 0 &&
      get('frigate') < enemySubs.length * 2 &&
      canTrain(world, owner, 'frigate')
    ) {
      return 'frigate';
    }
    // vs capitals: submarines, else a missile-boat pack.
    if (fullCounters && enemyCapitals.length > 0) {
      if (get('submarine') < 2 && canTrain(world, owner, 'submarine')) return 'submarine';
      if (get('missileBoat') < 3 && canTrain(world, owner, 'missileBoat')) return 'missileBoat';
    }
    // vs heavy armor: tank destroyers first, then artillery.
    if (fullCounters && enemyHeavy.length >= 3) {
      if (
        get('tankDestroyer') < Math.min(enemyHeavy.length, 4) &&
        canTrain(world, owner, 'tankDestroyer')
      ) {
        return 'tankDestroyer';
      }
      if (get('artillery') < 3 && canTrain(world, owner, 'artillery')) return 'artillery';
    }
    // vs light masses: apc, else mlrs, else artillery.
    if (fullCounters && enemyLight.length >= 4) {
      if (canTrain(world, owner, 'apc')) return 'apc';
      if (canTrain(world, owner, 'mlrs')) return 'mlrs';
      if (canTrain(world, owner, 'artillery')) return 'artillery';
    }
    // vs artillery parks: spectres slip inside minRange; snipers outrange
    // the crews; fighter-bombers strike from above.
    if (fullCounters && enemyArty.length >= 2) {
      if (canTrain(world, owner, 'spectre')) return 'spectre';
      if (canTrain(world, owner, 'sniperTeam')) return 'sniperTeam';
      if (canTrain(world, owner, 'fighterBomber')) return 'fighterBomber';
    }
    // vs any navy on a coastal map: a frigate screen before capitals.
    if (
      fullCounters &&
      enemyNavy.length > 0 &&
      ai.navalStatus === 'coastal' &&
      get('frigate') === 0 &&
      canTrain(world, owner, 'frigate')
    ) {
      return 'frigate';
    }
  }

  // Force multiplier: one medic per ~12 land combat units (commander+).
  if (fullCounters && canTrain(world, owner, 'combatMedic')) {
    let landCombat = 0;
    for (const [kind, n] of counts) {
      const def = UNIT_DEFS[kind];
      if (def.domain === 'land' && def.damage > 0) landCombat += n;
    }
    const want = landCombat >= 8 ? Math.max(1, Math.floor(landCombat / 12)) : 0;
    if (get('combatMedic') < want) return 'combatMedic';
  }

  // Basic navy maintenance on coastal maps (general+ only). The probe
  // itself (thinkNavalProbe) runs for commander+ so the naval counters
  // above can find water to launch from.
  if (
    (ai.difficulty === 'general' || ai.difficulty === 'marshal') &&
    ai.navalStatus === 'coastal'
  ) {
    if (get('fishingBoat') < 4 && canTrain(world, owner, 'fishingBoat')) return 'fishingBoat';
    if (get('patrolBoat') < 3 && canTrain(world, owner, 'patrolBoat')) return 'patrolBoat';
    if (get('missileBoat') < 3 && canTrain(world, owner, 'missileBoat')) return 'missileBoat';
  }

  // Base mix: the trainable kind furthest below its share of the cap.
  const mix = BASE_MIX[ai.difficulty === 'citizen' ? 'citizen' : 'commander'];
  const cap = AI_MAX_UNITS[ai.difficulty];
  let best: UnitKind | null = null;
  let bestScore = -Infinity;
  for (const { kind, share } of mix) {
    if (!canTrain(world, owner, kind)) continue;
    // Personality jitters each kind's share ±30% (missing kinds count as
    // 1): matches feel different, while the counter framework above — the
    // part that defines the difficulty's skill — is untouched.
    const weight = ai.personality.mixWeights[kind] ?? 1;
    const score = share * cap * weight - get(kind);
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }
  // Everything at share (or nothing trainable): keep building the rifles
  // backbone — the one kind that is never gated.
  if (best === null || bestScore <= 0) return 'rifles';
  return best;
}

/** Where a new unit spawns: sea kinds at the probed water, else base. */
function spawnPoint(ai: AIPlayerState, kind: UnitKind, n: number): { x: number; z: number } {
  if (UNIT_DEFS[kind].domain === 'sea' && ai.navalWater) {
    return { x: ai.navalWater.x, z: ai.navalWater.z };
  }
  const bx = ai.forwardBase ? ai.forwardBase.x : ai.baseX;
  const bz = ai.forwardBase ? ai.forwardBase.z : ai.baseZ;
  return { x: bx + (n % 4) * 4 - 6, z: bz + Math.floor(n / 4) * 4 - 6 };
}

/** Train one unit per think tick (the production step). */
function thinkProduction(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
  counts: Map<UnitKind, number>,
  n: number,
  visible: UnitRecord[],
): void {
  if (n >= AI_MAX_UNITS[ai.difficulty]) return;
  const kind = chooseUnitKind(world, ai, counts, visible);
  const p = spawnPoint(ai, kind, n);
  spawn(world, queue, ai.owner, kind, p.x, p.z);
  ai.builtCounts[kind] = (ai.builtCounts[kind] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Upgrade research (spec §7.4, commander+)
// ---------------------------------------------------------------------------

interface ResearchCandidate {
  id: UpgradeId;
  /** Extra condition beyond the def's own prereqs (force shape). */
  when: (world: World, ai: AIPlayerState, counts: Map<UnitKind, number>) => boolean;
}

const always: ResearchCandidate['when'] = () => true;
const vehiclesAtLeast =
  (n: number): ResearchCandidate['when'] =>
  (_w, _a, counts) => {
    let v = 0;
    for (const k of ['tank', 'apc', 'tankDestroyer', 'artillery', 'mlrs', 'aa'] as UnitKind[]) {
      v += counts.get(k) ?? 0;
    }
    return v >= n;
  };
const aircraftAtLeast =
  (n: number): ResearchCandidate['when'] =>
  (_w, _a, counts) => {
    let v = 0;
    for (const k of ['fighter', 'fighterBomber', 'attackHeli', 'awacs'] as UnitKind[]) {
      v += counts.get(k) ?? 0;
    }
    return v >= n;
  };

/** Research priority (spec §7.4), then the economy line by cost order. */
const RESEARCH_PRIORITY: ResearchCandidate[] = [
  { id: 'apRounds', when: always },
  { id: 'compositeArmor', when: always },
  { id: 'engineTuning', when: vehiclesAtLeast(4) },
  { id: 'sonarSuite', when: (w, ai) => ai.seenSubmarine },
  { id: 'advancedAvionics', when: aircraftAtLeast(3) },
  { id: 'droneOptics', when: always },
  {
    id: 'fieldMedicine',
    when: (_w, _a, counts) => {
      let infantry = 0;
      for (const k of ['rifles', 'sniperTeam', 'spectre'] as UnitKind[]) infantry += counts.get(k) ?? 0;
      return (counts.get('combatMedic') ?? 0) >= 1 || infantry >= 6;
    },
  },
  { id: 'precisionManufacturing', when: always },
  { id: 'smartGrid', when: always },
  { id: 'verticalFarming', when: always },
  { id: 'cruiseMissiles', when: always },
  { id: 'freeTrade', when: always },
];

/** ResearchCandidate lookup by id (for personality-ordered iteration). */
const RESEARCH_BY_ID = new Map<UpgradeId, ResearchCandidate>(
  RESEARCH_PRIORITY.map((c) => [c.id, c]),
);

/**
 * This match's research order: the spec'd combat/support head (pinned),
 * then the economy line in the AI's personality order. A legacy/empty
 * personality falls back to the default RESEARCH_PRIORITY order.
 */
function researchOrderFor(ai: AIPlayerState): ResearchCandidate[] {
  const head = RESEARCH_PRIORITY.slice(0, RESEARCH_HEAD_COUNT);
  const tailIds =
    ai.personality.researchOrder.length > 0
      ? ai.personality.researchOrder
      : RESEARCH_PRIORITY.slice(RESEARCH_HEAD_COUNT).map((c) => c.id);
  const tail: ResearchCandidate[] = [];
  for (const id of tailIds) {
    const cand = RESEARCH_BY_ID.get(id);
    if (cand) tail.push(cand);
  }
  return [...head, ...tail];
}

/** Research one upgrade per think tick, by priority, when prereqs allow. */
function thinkResearch(world: World, queue: CommandQueue, ai: AIPlayerState, counts: Map<UnitKind, number>): void {
  // Research happens at the lab (real or virtually constructed).
  if (!hasProductionBuilding(world, ai.owner, 'lab')) return;
  const player = getPlayer(world.city, ai.owner);
  if (!player) return;
  for (const { id, when } of researchOrderFor(ai)) {
    if (hasUpgrade(world, ai.owner, id)) continue;
    if (!when(world, ai, counts)) continue;
    // Mirror researchUpgrade's own validation (age, building prereqs,
    // affordability) so we only enqueue commands that should pass; the
    // enqueue is still guarded — a rejection just means "not this tick".
    const def = UPGRADE_DEFS[id];
    if (!isUnitAvailableForAge(world, def.minAge)) continue;
    let prereqsMet = true;
    for (const kind of def.requiredBuildings) {
      if (!hasProductionBuilding(world, ai.owner, kind)) {
        prereqsMet = false;
        break;
      }
    }
    if (!prereqsMet) continue;
    if (player.funds < def.costFunds || player.research < def.costResearch) continue;
    issue(world, queue, 'researchUpgrade', { owner: ai.owner, upgrade: id });
    return;
  }
}

// ---------------------------------------------------------------------------
// Naval (general+): probe for water, then work the coast
// ---------------------------------------------------------------------------

/** Deterministic probe ring: radii × 8 compass directions = 32 points. */
const PROBE_RADII = [40, 80, 140, 220];
const PROBE_DIRS = 8;
const PROBE_COUNT = PROBE_RADII.length * PROBE_DIRS;

/** Probe candidate #i around the base (deterministic, no RNG). */
function probePoint(ai: AIPlayerState, i: number): { x: number; z: number } {
  const r = PROBE_RADII[Math.floor(i / PROBE_DIRS)] ?? PROBE_RADII[PROBE_RADII.length - 1]!;
  const a = ((i % PROBE_DIRS) / PROBE_DIRS) * Math.PI * 2;
  return { x: ai.baseX + Math.round(Math.cos(a) * r), z: ai.baseZ + Math.round(Math.sin(a) * r) };
}

/**
 * Water scouting by trial (no maphack): attempt real fishing-boat
 * spawns (cheap, foundation-age, un-gated) at probe points around the
 * base, two per think. A rejection for terrain ("sea unit on land")
 * advances the probe; an economic rejection retries later; a success
 * marks the map coastal and the probe point becomes the naval base.
 */
function thinkNavalProbe(world: World, queue: CommandQueue, ai: AIPlayerState): void {
  if (ai.navalStatus !== 'unknown') return;
  for (let t = 0; t < 2 && ai.navalProbeIndex < PROBE_COUNT; t++) {
    const p = probePoint(ai, ai.navalProbeIndex);
    // Off-map candidates count as misses (deterministic).
    if (Math.abs(p.x) >= MAP_HALF_SIZE || Math.abs(p.z) >= MAP_HALF_SIZE) {
      ai.navalProbeIndex++;
      continue;
    }
    const reason = trySpawn(world, queue, ai.owner, 'fishingBoat', p.x, p.z);
    if (reason === null) {
      ai.navalStatus = 'coastal';
      ai.navalWater = { x: p.x, z: p.z };
      ai.builtCounts['fishingBoat'] = (ai.builtCounts['fishingBoat'] ?? 0) + 1;
      return;
    }
    if (reason.includes('sea unit on land')) {
      ai.navalProbeIndex++;
    }
    // Economic/age rejections: don't advance — retry the same point later.
  }
  if (ai.navalProbeIndex >= PROBE_COUNT) ai.navalStatus = 'landlocked';
}

// ---------------------------------------------------------------------------
// Per-level think functions
// ---------------------------------------------------------------------------

/**
 * Attack-timing jitter around the think cadence: low-aggression
 * personalities issue attack orders every other think instead of every
 * think. Units already chasing keep chasing via the combat system, so
 * this only staggers NEW orders — it never cancels an ongoing attack.
 * The think index is floor(tick / cadence): deterministic, no RNG draws.
 */
function attacksThisThink(world: World, ai: AIPlayerState): boolean {
  const every = ai.personality.attackEveryNthThink;
  if (every <= 1) return true;
  return Math.floor(world.tick / AI_THINK_TICKS[ai.difficulty]) % every === 0;
}

/** Cadet think: trickle rifles, never attack, never expand, never build. */
function thinkCadet(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const n = totalUnits(world, ai.owner);
  if (n >= AI_MAX_UNITS.cadet) return;
  // Rifles only: cadet builds no production buildings, so gated kinds
  // (tank, …) could never unlock — ordering them would stall the AI.
  const p = spawnPoint(ai, 'rifles', n);
  spawn(world, queue, ai.owner, 'rifles', p.x, p.z);
  ai.builtCounts['rifles'] = (ai.builtCounts['rifles'] ?? 0) + 1;
  // Phase 4 transport (S7): civilian-transport AI hook — a documented
  // no-op in 0.1 Alpha (see thinkCivilianTransport).
  thinkCivilianTransport(world, ai);
}

/** Shared per-think bookkeeping: construction, sub sightings. */
function thinkUpkeep(world: World, ai: AIPlayerState, visible: UnitRecord[]): void {
  thinkConstruction(world, ai);
  if (!ai.seenSubmarine && visible.some((e) => KIND_OF(e) === 'submarine')) {
    ai.seenSubmarine = true;
  }
}

/** Citizen think: basic army, simple counters, attacks visible enemies. */
function thinkCitizen(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const visible = getVisibleEnemies(world, ai.owner);
  thinkUpkeep(world, ai, visible);

  // Production: one unit per think, counters then base mix.
  thinkProduction(world, queue, ai, counts, n, visible);

  // Phase 3 logistics (workstream 3): virtual depots, truck ratios,
  // abstract resupply, ammo-dry retreats.
  thinkLogistics(world, queue, ai);

  // Phase 4 transport (S7): civilian-transport AI hook — a documented
  // no-op in 0.1 Alpha (see thinkCivilianTransport).
  thinkCivilianTransport(world, ai);

  // Attack: order all combat units to attack the nearest visible enemy.
  // (Personality may stagger new attack orders to every other think.)
  if (visible.length > 0 && attacksThisThink(world, ai)) {
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
      if (def.damage <= 0) continue; // unarmed (hauler, transport, medics)
      // Dry magazines don't get new attack orders — they fall back in
      // thinkAmmoRetreats instead (they can't shoot anyway).
      if ((def.ammoCapacity ?? 0) > 0 && u.ammo <= 0) continue;
      // Skip units whose weapons can't engage this target's domain
      // (e.g. tanks can't target air) — the attackUnit command would reject.
      if (!canTarget(def, nearest)) continue;
      // Only re-issue if not already attacking this target.
      if (u.targetId === nearest.id && u.chasing) continue;
      attack(world, queue, ai.owner, u.id, nearest.id);
    }
  }
}

/** Clamp a scout waypoint inside the map (off-map orders reject). */
function clampWaypoint(x: number, z: number): { x: number; z: number } {
  const lim = MAP_HALF_SIZE - 10;
  return {
    x: Math.max(-lim, Math.min(lim, x)),
    z: Math.max(-lim, Math.min(lim, z)),
  };
}

/** Commander think: scout, balanced force, full counters, expansion. */
function thinkCommander(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  const counts = countUnits(world, ai.owner);
  const n = totalUnits(world, ai.owner);
  const visible = getVisibleEnemies(world, ai.owner);
  thinkUpkeep(world, ai, visible);
  thinkResearch(world, queue, ai, counts);

  // Phase 3 logistics (workstream 3): virtual depots, truck ratios,
  // abstract resupply, ammo-dry retreats.
  thinkLogistics(world, queue, ai);

  // Phase 4 transport (S7): civilian-transport AI hook — a documented
  // no-op in 0.1 Alpha (see thinkCivilianTransport).
  thinkCivilianTransport(world, ai);

  // --- Scouting: keep one scout probing outward waypoints. At the
  // information age the awacs replaces the drone (spec §7.2).
  const scoutKind: UnitKind = canTrain(world, ai.owner, 'awacs') ? 'awacs' : 'drone';
  const scouts = (counts.get('drone') ?? 0) + (counts.get('awacs') ?? 0) + (counts.get('fighter') ?? 0);
  if (scouts === 0 && n < AI_MAX_UNITS[ai.difficulty] && canTrain(world, ai.owner, scoutKind)) {
    const p = spawnPoint(ai, scoutKind, n);
    spawn(world, queue, ai.owner, scoutKind, p.x, p.z);
    ai.builtCounts[scoutKind] = (ai.builtCounts[scoutKind] ?? 0) + 1;
  } else {
    // Order idle scouts to waypoints (cycle through 4 compass points at
    // standoff distance); skip waypoints near visible enemy clusters.
    const waypoints = [
      clampWaypoint(ai.baseX + 120, ai.baseZ),
      clampWaypoint(ai.baseX, ai.baseZ + 120),
      clampWaypoint(ai.baseX - 120, ai.baseZ),
      clampWaypoint(ai.baseX, ai.baseZ - 120),
    ];
    // Modulo guarantees a valid index.
    let wp = waypoints[ai.scoutIndex % waypoints.length]!;
    for (let tries = 0; tries < waypoints.length; tries++) {
      const crowded = visible.some((e) => {
        const dx = e.x - wp.x;
        const dz = e.z - wp.z;
        return dx * dx + dz * dz <= 50 * 50;
      });
      if (!crowded) break;
      ai.scoutIndex++;
      wp = waypoints[ai.scoutIndex % waypoints.length]!;
    }
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      if (u.kind !== 'drone' && u.kind !== 'fighter' && u.kind !== 'awacs') continue;
      // Only redirect idle scouts (don't interrupt combat).
      if (u.state === 'idle' && u.targetId === 0) {
        moveTo(world, queue, ai.owner, u.id, wp.x, wp.z);
      }
    }
    ai.scoutIndex++;
  }

  // --- Water reconnaissance: commanders and above probe for water by
  //     trial (never maphack). The probe is what lets the naval counter
  //     table (frigates vs subs, ...) function; the economic navy
  //     (fishing fleet, patrol boats) stays general+ (see chooseUnitKind).
  thinkNavalProbe(world, queue, ai);

  // --- Production: one unit per think, counters then base mix.
  thinkProduction(world, queue, ai, counts, n, visible);

  // --- Medics: attach to the land force (centroid), never attack.
  // (The attack loop below already skips damage-0 units.)
  let cx = 0;
  let cz = 0;
  let landCombat = 0;
  for (const u of world.units) {
    if (u.owner !== ai.owner || u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (def.domain === 'land' && def.damage > 0) {
      cx += u.x;
      cz += u.z;
      landCombat++;
    }
  }
  if (landCombat > 0) {
    cx /= landCombat;
    cz /= landCombat;
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0 || u.kind !== 'combatMedic') continue;
      moveTo(world, queue, ai.owner, u.id, cx, cz);
    }
  }

  // --- Expansion: once we have enough units (personality threshold
  //     6..10, was a flat 8), establish a forward base toward the
  //     nearest visible enemy — or in this match's personality direction
  //     when no enemy is visible.
  if (!ai.forwardBase && n >= ai.personality.expansionUnitThreshold) {
    let fx: number;
    let fz: number;
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
    } else {
      const a = ai.personality.expansionAngle;
      fx = ai.baseX + Math.round(Math.cos(a) * 80);
      fz = ai.baseZ + Math.round(Math.sin(a) * 80);
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

  // --- Attack: like citizen, but fighters prefer air targets and
  //     missile boats stay in their pack (group order already issued).
  //     (Personality may stagger new attack orders to every other think.)
  if (visible.length > 0 && attacksThisThink(world, ai)) {
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
      if (u.kind === 'drone' || u.kind === 'awacs') continue; // scouts don't fight
      // Dry magazines don't get new attack orders — they fall back in
      // thinkAmmoRetreats instead (they can't shoot anyway).
      if ((def.ammoCapacity ?? 0) > 0 && u.ammo <= 0) continue;
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

  // --- Capital ships (marshal, coastal): keep the command ship and
  //     carrier back with the fleet; retreat under 40% hp (spec §7.3).
  if (ai.difficulty === 'marshal' && ai.navalWater) {
    for (const u of world.units) {
      if (u.owner !== ai.owner || u.hp <= 0) continue;
      if (u.kind !== 'commandShip' && u.kind !== 'carrier') continue;
      const def = UNIT_DEFS[u.kind as UnitKind];
      const dx = u.x - ai.navalWater.x;
      const dz = u.z - ai.navalWater.z;
      const hurt = u.hp < def.hp * 0.4;
      const strayed = dx * dx + dz * dz > 60 * 60;
      if ((hurt || strayed) && u.targetId === 0) {
        moveTo(world, queue, ai.owner, u.id, ai.navalWater.x, ai.navalWater.z);
      }
    }
  }
}

/**
 * General (level 4): faster than Commander, larger army, basic navy.
 * Naval probing + fishing economy on coastal maps (spec §7.3).
 */
function thinkGeneral(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  thinkCommander(world, queue, ai);
  thinkNavalProbe(world, queue, ai);
}

/**
 * Marshal (level 5): hardest fair AI. Combined arms, naval play,
 * age advancement. Thinks fastest, fields the largest army.
 */
function thinkMarshal(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  // Start with General's behavior (includes Commander base + naval probe).
  thinkGeneral(world, queue, ai);

  // --- Age advancement: if we can afford the next age, take it.
  // Choose programs that boost military: Heavy Industry, Cyber Command, Arsenal.
  const prog = getAgeProgression(world.ages.age);
  if (prog.next && canAffordAge(world, ai.owner, prog.cost)) {
    let program: string;
    if (prog.next === 'industry') program = 'heavyIndustry';
    else if (prog.next === 'information') program = 'cyberCommand';
    else if (prog.next === 'ascendance') program = 'arsenalProgram';
    else program = prog.programs[0] ?? 'fiberGrid';
    advanceAge(world, queue, ai.owner, program);
  }

  // --- Superweapons: build the facilities, then use them fairly.
  thinkSuperweapons(world, queue, ai);
}

/**
 * Marshal-only superweapon play (Phase 3). Construction goes through the
 * `constructSuperweaponFacility` command (same cost and build time as the
 * player's buildings); firing goes through `fireAegis` / `fireStorm`.
 * Targeting uses only visible enemies — no fog cheating — and the Storm
 * needs a real cluster (3+ visible enemies) so it isn't wasted.
 */
function thinkSuperweapons(
  world: World,
  queue: CommandQueue,
  ai: AIPlayerState,
): void {
  if (world.ages.age !== 'ascendance') return;
  const enqueue = (kind: string, payload: Record<string, unknown>): void => {
    issue(world, queue, kind, payload);
  };
  // Build each facility once, storm first (offense wins games).
  if (ai.superweapons.stormReadyTick === 0) {
    enqueue('constructSuperweaponFacility', { owner: ai.owner, kind: 'storm' });
  } else if (ai.superweapons.aegisReadyTick === 0) {
    enqueue('constructSuperweaponFacility', { owner: ai.owner, kind: 'aegis' });
  }
  // Fire the Storm at the largest visible enemy cluster.
  if (isStormReady(world, ai.owner)) {
    const visible = getVisibleEnemies(world, ai.owner);
    if (visible.length >= 3) {
      let x = 0;
      let z = 0;
      for (const e of visible) {
        x += e.x;
        z += e.z;
      }
      enqueue('fireStorm', {
        owner: ai.owner,
        x: x / visible.length,
        z: z / visible.length,
      });
    }
  }
  // Raise the Aegis when the army is hurting.
  if (isAegisReady(world, ai.owner)) {
    const hurt = world.units.some((u) => {
      if (u.owner !== ai.owner || u.hp <= 0) return false;
      const def = UNIT_DEFS[u.kind as UnitKind];
      return def !== undefined && u.hp < def.hp * 0.5;
    });
    if (hurt) {
      enqueue('fireAegis', { owner: ai.owner });
    }
  }
}

/** Get age progression info for the current age. */
function getAgeProgression(age: string): { next: string | null; cost: Record<string, number>; programs: string[] } {
  const prog = (AGE_PROGRESSION as Record<string, { next: string | null; cost: Record<string, number>; programs: string[] }>)[age];
  return prog ?? { next: null, cost: {}, programs: [] };
}

/** Check if the player can afford an age advancement. */
function canAffordAge(world: World, owner: number, cost: Record<string, number>): boolean {
  const player = getPlayer(world.city, owner);
  if (!player) return false;
  for (const [res, amt] of Object.entries(cost)) {
    const have = (player as unknown as Record<string, number>)[res] ?? 0;
    if (have < amt) return false;
  }
  return true;
}

/** Issue an age advancement command. */
function advanceAge(world: World, queue: CommandQueue, owner: number, program: string): void {
  issue(world, queue, 'advanceAge', { owner, program });
}

/**
 * The AI system. Runs every tick; each AI player thinks on its own
 * cadence. Issues commands through the queue — never mutates world
 * state directly (except its own `world.ai` state, which is plain data,
 * and the virtual-building economy credit, which mirrors the economy
 * system for real buildings).
 */
export function createAISystem(queue: CommandQueue): SimSystem {
  // The AI researches upgrades via `researchUpgrade`; make sure the kind
  // is registered even if session setup hasn't wired it (registering
  // twice throws, so tolerate the already-registered case — the UI may
  // wire it independently later).
  try {
    registerUpgradeCommands(queue);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes('already registered')) throw e;
  }
  return (world: World) => {
    creditVirtualEconomy(world);
    // Deterministic iteration: AI players in fixed owner order. A sorted
    // COPY — the stored registration order is never mutated; the player
    // objects (and their nextThinkTick updates) are shared references.
    const players = [...world.ai.players].sort((a, b) => a.owner - b.owner);
    for (const ai of players) {
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
        case 'general':
          thinkGeneral(world, queue, ai);
          break;
        case 'marshal':
          thinkMarshal(world, queue, ai);
          break;
      }
    }
  };
}

/** Canonical JSON-safe encoding of one AI personality (key order fixed). */
function encodePersonality(p: AIPersonality): unknown {
  const weights = Object.keys(p.mixWeights)
    .sort()
    .reduce<Record<string, number>>((acc, k) => {
      const v = p.mixWeights[k];
      if (v !== undefined) acc[k] = v;
      return acc;
    }, {});
  return {
    aggression: p.aggression,
    expansionEagerness: p.expansionEagerness,
    mixWeights: weights,
    researchOrder: [...p.researchOrder],
    expansionAngle: p.expansionAngle,
    attackEveryNthThink: p.attackEveryNthThink,
    expansionUnitThreshold: p.expansionUnitThreshold,
    scoutStartIndex: p.scoutStartIndex,
  };
}

/**
 * Restore a personality from a snapshot payload. Missing fields (legacy
 * snapshots pre-personality) or malformed values fall back to
 * NEUTRAL_PERSONALITY, which reproduces pre-personality behavior
 * exactly — so old saves load without a snapshot version bump (the
 * step-7 precedent for AI-state additions).
 */
function decodePersonality(data: unknown): AIPersonality {
  const d = (data ?? {}) as Partial<Record<keyof AIPersonality, unknown>>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const clamp01 = (v: unknown, fallback: number): number =>
    Math.min(1, Math.max(0, num(v, fallback)));
  const mixWeights: Record<string, number> = {};
  const mw = d.mixWeights;
  if (mw !== null && typeof mw === 'object') {
    for (const [k, v] of Object.entries(mw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) mixWeights[k] = v;
    }
  }
  const validResearch = new Set<UpgradeId>(
    RESEARCH_PRIORITY.slice(RESEARCH_HEAD_COUNT).map((c) => c.id),
  );
  const researchOrder: UpgradeId[] = [];
  if (Array.isArray(d.researchOrder)) {
    for (const id of d.researchOrder) {
      if (
        typeof id === 'string' &&
        validResearch.has(id as UpgradeId) &&
        !researchOrder.includes(id as UpgradeId)
      ) {
        researchOrder.push(id as UpgradeId);
      }
    }
  }
  const eut = d.expansionUnitThreshold;
  const ssi = d.scoutStartIndex;
  return {
    aggression: clamp01(d.aggression, NEUTRAL_PERSONALITY.aggression),
    expansionEagerness: clamp01(d.expansionEagerness, NEUTRAL_PERSONALITY.expansionEagerness),
    mixWeights,
    researchOrder,
    expansionAngle: num(d.expansionAngle, NEUTRAL_PERSONALITY.expansionAngle),
    attackEveryNthThink: d.attackEveryNthThink === 2 ? 2 : 1,
    expansionUnitThreshold:
      typeof eut === 'number' && Number.isInteger(eut) && eut >= 1
        ? eut
        : NEUTRAL_PERSONALITY.expansionUnitThreshold,
    scoutStartIndex:
      typeof ssi === 'number' && Number.isInteger(ssi) && ssi >= 0
        ? ssi
        : NEUTRAL_PERSONALITY.scoutStartIndex,
  };
}

/**
 * Canonical JSON-safe encoding of AI state for snapshots and digests.
 * Players in registration order; builtCounts and mixWeights keys sorted.
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
      superweapons: {
        aegisReadyTick: p.superweapons?.aegisReadyTick ?? 0,
        stormReadyTick: p.superweapons?.stormReadyTick ?? 0,
      },
      virtualBuildings: {
        completed: [...(p.virtualBuildings?.completed ?? [])],
        constructing: p.virtualBuildings?.constructing
          ? { ...p.virtualBuildings.constructing }
          : null,
      },
      navalStatus: p.navalStatus ?? 'unknown',
      navalProbeIndex: p.navalProbeIndex ?? 0,
      navalWater: p.navalWater ? { x: p.navalWater.x, z: p.navalWater.z } : null,
      seenSubmarine: p.seenSubmarine ?? false,
      // Phase 3 logistics (workstream 3): virtual depot stocks. ?? 0 so
      // pre-logistics snapshots decode to empty — no version bump (AD9).
      virtualAmmoStock: p.virtualAmmoStock ?? 0,
      virtualFuelStock: p.virtualFuelStock ?? 0,
      personality: encodePersonality(p.personality ?? NEUTRAL_PERSONALITY),
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
      superweapons?: { aegisReadyTick: number; stormReadyTick: number };
      virtualBuildings?: {
        completed?: BuildingKind[];
        constructing?: { kind: BuildingKind; readyTick: number } | null;
      };
      navalStatus?: AINavalStatus;
      navalProbeIndex?: number;
      navalWater?: { x: number; z: number } | null;
      seenSubmarine?: boolean;
      virtualAmmoStock?: number;
      virtualFuelStock?: number;
      personality?: unknown;
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
      superweapons: {
        aegisReadyTick: p.superweapons?.aegisReadyTick ?? 0,
        stormReadyTick: p.superweapons?.stormReadyTick ?? 0,
      },
      virtualBuildings: {
        completed: [...(p.virtualBuildings?.completed ?? [])],
        constructing: p.virtualBuildings?.constructing
          ? { ...p.virtualBuildings.constructing }
          : null,
      },
      navalStatus: p.navalStatus ?? 'unknown',
      navalProbeIndex: p.navalProbeIndex ?? 0,
      navalWater: p.navalWater ? { x: p.navalWater.x, z: p.navalWater.z } : null,
      seenSubmarine: p.seenSubmarine ?? false,
      // Phase 3 logistics (workstream 3): ?? 0 keeps pre-logistics saves
      // loading with empty virtual stocks — no version bump (AD9).
      virtualAmmoStock: p.virtualAmmoStock ?? 0,
      virtualFuelStock: p.virtualFuelStock ?? 0,
      personality: decodePersonality(p.personality),
    })),
  };
}

// Re-export for tests that need the UnitRecord type.
export type { UnitRecord };
export { findUnit };
