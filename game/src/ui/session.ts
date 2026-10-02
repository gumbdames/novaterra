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
 * NOVATERRA — ui/session.ts — full game assembly (headless-safe).
 *
 * Responsibilities:
 *  - Build a playable session: terrain, world, command queue
 *    (every command kind registered), and the tick driver with the
 *    canonical system order. One function, one place — the UI game loop,
 *    headless scenario tests, and future replay/save code all assemble
 *    the game through here so the wiring cannot drift.
 *  - Seed both players' starting forces through the command queue (the
 *    same path real orders take), and register the Classic AI rival
 *    (owner 1) at a chosen difficulty. Player 0 is always the human.
 *  - Campaign missions (Phase 2): `createSession({ campaignMission })`
 *    drives map/AI/starting resources from the mission; 'none' AI means
 *    no rival player, and owner 1 is always funded for scripted raids.
 *
 * Canonical system order (fixed, data-independent):
 *    pathfinding → movement → combat → economy → AI
 * AI thinks last so it reacts to this tick's resolved state.
 *
 * Starting forces (skirmish convention, decided for the 0.1 Alpha UI):
 * each side gets 2 engineers + 4 rifles on the nearest land to their
 * map corner — engineers so the human can build immediately, rifles so
 * both sides have something to defend with.
 *
 * No DOM, no three.js, no wall clock — safe under Node/vitest. The seed
 * is chosen by the caller (UI uses a fresh seed per game; tests use fixed
 * seeds for determinism).
 */

import type { World, SkirmishVictoryKind } from '../sim/world';
import { createWorld, SKIRMISH_VICTORY_KINDS, isSkirmishVictoryKind } from '../sim/world';
import type { CommandQueue, NewCommand } from '../sim/commands';
import {
  createCommandQueue,
  registerCoreCommands,
  releaseUnitReservation,
} from '../sim/commands';
import type { TickDriver } from '../sim/tick';
import { createTickDriver, TICK_MS } from '../sim/tick';
import type { TerrainData } from '../sim/terrain';
import { generateTerrain, getMapPreset, isWater } from '../sim/terrain';
import { digestWorld } from '../sim/digest';
import { registerCityCommands, getPlayer, BUILDING_DEFS } from '../sim/city';
import { createEconomySystem, registerEconomyCommands } from '../sim/economy';
import { registerUnitCommands } from '../sim/units';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../sim/movement';
import { createCombatSystem, registerCombatCommands } from '../sim/combat';
import { createIntelSystem, registerIntelCommands } from '../sim/intel';
import { registerDiplomacyCommands } from '../sim/diplomacy';
import { registerLogisticsCommands } from '../sim/commands';
import { registerAgeCommands } from '../sim/ages';
import { registerCheatCommands } from '../sim/cheats';
import { addAIPlayer, AI_MAX_UNITS, createAISystem, type AIDifficulty } from '../sim/ai';
import {
  ECONOMIC_VICTORY_FUNDS,
  POPULATION_VICTORY_POP,
  checkWonderCountdownVictory,
  createWonderCountdownSystem,
} from '../sim/wonderCountdown';
import { restoreSnapshot, type Snapshot } from '../sim/snapshot';
import { rebuildFlowFields } from '../sim/pathfinding';
import {
  registerDelegationCommands,
  createMayorSystem,
  createGeneralSystem,
} from '../sim/delegation';
import {
  registerSuperweaponCommands,
  createSuperweaponSystem,
} from '../sim/superweapons';
import { registerUpgradeCommands } from '../sim/upgrades';
import type { OrderIntent } from './orders';
import type { MissionDef } from '../campaign/missions';

/** Player 0 is always the human. */
export const HUMAN_PLAYER_ID = 0;
/** Player 1 is always the Classic AI rival. */
export const AI_PLAYER_ID = 1;

export interface SessionOptions {
  /** Deterministic seed for the whole session (terrain + world + AI). */
  seed: number;
  /** Classic AI difficulty for the rival (default 'citizen'). */
  aiDifficulty?: AIDifficulty;
  /**
   * Map preset name (see MAP_PRESETS in sim/terrain.ts). Defaults to
   * 'Meridian Plains'. Each preset has a canonical seed, so picking a
   * map always yields the same terrain.
   */
  mapPreset?: string;
  /**
   * Restore from a saved snapshot instead of a fresh world. When set,
   * starting forces are NOT re-seeded (the snapshot already has them)
   * and the AI player is NOT re-added (its state is in the snapshot).
   */
  snapshot?: Snapshot;
  /**
   * Campaign mission setup (Phase 2). When set, the map preset, AI
   * difficulty, and starting resources come from the mission; the AI
   * rival is skipped entirely when the mission's difficulty is 'none'.
   * The AI player always gets a manpower stockpile so the campaign
   * director's scripted raids can pay the spawnUnit manpower cost.
   */
  campaignMission?: MissionDef;
  /**
   * Sandbox mode (workstream X, 2026-09-30): skip the Classic AI rival
   * entirely — a peaceful single-player world with no victory
   * condition, like campaign missions with difficulty 'none'. The menu
   * demo director uses this so it is the sole author of its movie.
   * Defaults to false; every existing caller keeps its rival.
   */
  sandbox?: boolean;
  /**
   * Peaceful mode (grand-expansion Phase 8, workstream A, 2026-09-30;
   * endless revision, 2026-10-01): the Classic AI rival EXISTS and
   * plays, but the world is peaceful — `world.peaceful` is set at
   * tick 0 (never toggled mid-game), military defs
   * (units/buildings/upgrades) and covert ops are locked out at the
   * command layer, and conquest victory/defeat checks are bypassed.
   * There is NO victory condition: peaceful mode is endless, the game
   * never declares a winner or a loser, it just keeps simulating.
   * NOT the same as `sandbox`: sandbox skips the rival entirely;
   * peaceful keeps the rival (it plays peacefully). Defaults to
   * false; every existing caller keeps its war game.
   */
  peaceful?: boolean;
  /**
   * Roadmap B2 (2026-10-02): the skirmish victory condition, chosen
   * at setup. 'conquest' (wipe the rival's units + buildings) is the
   * classic; 'economic' (first to 100,000 funds), 'population' (first
   * to 10,000 housed) and 'monument' (first to complete a Monument)
   * let a rich economy win instead of an army. Ignored in peaceful
   * worlds (endless — no victory at all) and in sandbox games (no
   * rival). Defaults to 'conquest'; an unknown value resolves to
   * conquest rather than crashing.
   */
  victoryKind?: SkirmishVictoryKind;
}

/** Everything a running game needs. Plain data + live driver/queue. */
export interface GameSession {
  /** Deterministic id: `novaterra-<seed>-<difficulty>`. */
  sessionId: string;
  seed: number;
  aiDifficulty: AIDifficulty;
  /**
   * Resolved map preset name (see MAP_PRESETS in sim/terrain.ts) that
   * generated this session's terrain. Recorded on every session —
   * including restored ones — so saves can name the exact map they
   * were played on (R1-C/C4: the load path regenerates terrain from
   * this name instead of falling back to 'Meridian Plains').
   */
  mapPreset: string;
  /**
   * Campaign mission id when this session was built from a campaign
   * mission (`SessionOptions.campaignMission`), null for skirmish /
   * sandbox / peaceful sessions. Recorded so a save knows which
   * mission's map it came from (R1-C/C4).
   */
  campaignMissionId: string | null;
  /**
   * True when a Classic AI rival (owner 1) is playing. False for sandbox
   * skirmishes and campaign missions with no rival ('none') — those have
   * no victory condition (documented as sandbox mode).
   */
  hasRival: boolean;
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
  driver: TickDriver;
  /** Run exactly one fixed sim tick (1/30 s). */
  tick(): void;
  /**
   * Enqueue a player intent; stamps `issuer: 'player'`. Throws
   * CommandRejectedError on invalid orders — the UI catches and toasts.
   */
  enqueuePlayerIntent(intent: OrderIntent): void;
  /** Deterministic digest of the current world state (for tests/sync). */
  digest(): string;
  /**
   * Set once any cheat console command runs. Recorded in save metadata
   * so a save file honestly reports it was cheated in. UI-owned, never
   * read by the sim.
   */
  cheated: boolean;
}

/** AI base corner; mirrored for the human. */
const AI_CORNER = { x: 180, z: -180 };
const HUMAN_CORNER = { x: -180, z: 180 };

/**
 * Manpower granted to the AI player (owner 1) in every fresh session so
 * the campaign director's scripted raids can pay the `spawnUnit`
 * manpower cost. Harmless in skirmish: the Classic AI spends manpower
 * on its own production anyway.
 */
const RAID_MANPOWER = 10000;

/**
 * Nearest land to (x, z) on a deterministic outward spiral. Base placement
 * is gameplay-critical: the AI's spawnUnit commands validate terrain at
 * enqueue, so a water base would silently starve the AI.
 */
function findLandNear(t: TerrainData, x: number, z: number): { x: number; z: number } {
  for (let r = 0; r <= 160; r += 4) {
    for (let a = 0; a < 8; a += 1) {
      const px = x + Math.cos((a / 8) * 2 * Math.PI) * r;
      const pz = z + Math.sin((a / 8) * 2 * Math.PI) * r;
      if (!isWater(t, px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/** Starting forces: 2 engineers + 4 rifles around a land point. */
function startingForces(
  queue: CommandQueue,
  world: World,
  terrain: TerrainData,
  owner: number,
  issuer: string,
  at: { x: number; z: number },
  maxUnits?: number,
): void {
  // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): rifles are a
  // military def and cannot spawn in a peaceful world — the opening
  // force swaps them for haulers (civilian logistics). Same count, so
  // the AI's production-cap headroom math below is unchanged.
  const peaceful = world.peaceful === true;
  const specs: Array<{ kind: string; dx: number; dz: number }> = [
    { kind: 'engineer', dx: -4, dz: -4 },
    { kind: 'engineer', dx: 4, dz: -4 },
    { kind: peaceful ? 'hauler' : 'rifles', dx: -8, dz: 4 },
    { kind: peaceful ? 'hauler' : 'rifles', dx: 0, dz: 4 },
    { kind: peaceful ? 'hauler' : 'rifles', dx: 8, dz: 4 },
    { kind: peaceful ? 'hauler' : 'rifles', dx: 0, dz: 10 },
  ];
  // The AI's production cap counts all its units: starting forces must not
  // already exceed it, or the AI would never build (cadet cap is 4).
  const list = maxUnits !== undefined ? specs.slice(0, maxUnits) : specs;
  for (const s of list) {
    // Each unit finds its own nearest land: on high-water maps the base
    // center may be land while an offset (±10) sits in water, and a
    // water spawn is a loud rejection, not a silent skip.
    const pos = findLandNear(terrain, at.x + s.dx, at.z + s.dz);
    const cmd: NewCommand = {
      kind: 'spawnUnit',
      issuer,
      payload: { kind: s.kind, owner, x: pos.x, z: pos.z },
    };
    queue.enqueue(world, cmd);
  }
}

/**
 * Roadmap B2 (2026-10-02): alternative victory thresholds.
 *
 * ECONOMIC_VICTORY_FUNDS — first side to hold this treasury wins the
 * economic game outright (25× the 4,000 starting funds: a real mid-game
 * economy, not an opening rush).
 *
 * POPULATION_VICTORY_POP — first side to house this many residents
 * wins the population game outright (a genuine city, not a hamlet).
 *
 * Monument victory needs no threshold: the first side to COMPLETE a
 * Monument (progress 1) starts the wonder countdown (fun-audit B2) —
 * survival, not the completion itself, wins.
 *
 * Canonical definitions live in sim/wonderCountdown.ts (the sim owns
 * the countdown); re-exported here so existing UI/test import sites
 * keep working.
 */
export { ECONOMIC_VICTORY_FUNDS, POPULATION_VICTORY_POP } from '../sim/wonderCountdown';

/** Re-exported so setup UI / tests import the kind from this module. */
export type { SkirmishVictoryKind };
export { SKIRMISH_VICTORY_KINDS };

/**
 * Whether one side has met an alternative (non-conquest) victory
 * condition. Pure function of world state — no wall clock, no RNG.
 */
function checkAltVictory(world: World, owner: number): boolean {
  switch (world.victoryKind) {
    case 'economic': {
      // Instant win at 100% — crossing the finish line outright ends
      // the race. The wonder countdown (fun-audit B2, 2026-10-02)
      // forces the ending when a leader stalls near it instead.
      const player = getPlayer(world.city, owner);
      if ((player?.funds ?? 0) >= ECONOMIC_VICTORY_FUNDS) return true;
      return checkWonderCountdownVictory(world) === owner;
    }
    case 'population': {
      const player = getPlayer(world.city, owner);
      if ((player?.population ?? 0) >= POPULATION_VICTORY_POP) return true;
      return checkWonderCountdownVictory(world) === owner;
    }
    case 'monument': {
      // Fun-audit B2 (2026-10-02): completion starts the countdown —
      // surviving it wins, not the completion itself.
      return checkWonderCountdownVictory(world) === owner;
    }
    case 'conquest':
    default:
      return false;
  }
}

/**
 * Conquest victory check (deterministic): true when the rival (owner 1)
 * has no units and no buildings left. Pure function of world state —
 * no wall clock, no RNG. Callers should only check when `hasRival` is
 * true; sandbox games (no rival) have no victory condition by design.
 *
 * Roadmap B2 (2026-10-02): dispatches on `world.victoryKind` — the
 * alternative victories compare the human's economy against the same
 * thresholds, so a rich economy can win the game instead of an army.
 */
export function checkSkirmishVictory(world: World): boolean {
  // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): conquest is
  // unreachable when nothing military exists — and peaceful mode is
  // endless (2026-10-01), with no victory condition at all.
  // Loud-and-clear: this returns false, never a conquest verdict.
  //
  // Final-review R2 (2026-10-01): this check needs zero rival units
  // AND zero rival buildings — reachable now that buildings are
  // destructible (C3): siege orders (`attackBuilding`) let an army
  // raze a base instead of whack-a-moling retraining units forever.
  // The AI's production is mostly virtual, but C1 (2026-10-02) gives
  // commander+ REAL forward-base buildings (fuelDepot/ordnanceDepot/
  // radarStation, all military: true) — so vs the AI conquest now
  // requires wiping its fielded army AND razing its forward base
  // (isConquestEliminated counts military buildings).
  //
  // Roadmap B8 (2026-10-02): symmetric with checkSkirmishDefeat — the
  // capital / war-weariness short-circuit (see isConquestEliminated)
  // applies to the rival too.
  if (world.peaceful === true) return false;
  if (world.victoryKind !== undefined && world.victoryKind !== 'conquest') {
    return checkAltVictory(world, HUMAN_PLAYER_ID);
  }
  return isConquestEliminated(world, AI_PLAYER_ID);
}

/**
 * Roadmap B8 (2026-10-02): capital / war-weariness elimination rule.
 *
 * Defeat = zero units AND (zero buildings OR capital destroyed).
 *
 * Design mapping (validated against the code — the item's terms have no
 * direct referent):
 * - "capital": NOVATERRA has no HQ building, so the capital is defined
 *   as the side's MILITARY building set (`BuildingDef.military`, the
 *   war-apparatus defs) — the war-making core. "Capital destroyed"
 *   means no surviving military building.
 * - "army < 25% cap": the rule only fires at zero units, and an empty
 *   army is below 25% of any cap, so the clause is implied — it is not
 *   checked separately. (Deliberate: no new cap constant, no new state.)
 *
 * Why this shortens the endgame: the old rule needed zero units AND
 * zero buildings, so a beaten side with only value-10 houses left forced
 * a bulldozing grind. Now a side with no army and no war core is done
 * even if civilian houses stand — but a side with zero units and an
 * intact barracks (or any military building) is NOT eliminated: it can
 * still rebuild, so the game honestly continues.
 *
 * Pure function of world state — no wall clock, no RNG.
 */
function isConquestEliminated(world: World, owner: number): boolean {
  let hasUnit = false;
  for (const unit of world.units) {
    if (unit.owner === owner) {
      hasUnit = true;
      break;
    }
  }
  if (hasUnit) return false;
  let hasBuilding = false;
  let hasMilitaryBuilding = false;
  for (const building of world.city.buildings) {
    if (building.owner !== owner) continue;
    hasBuilding = true;
    if (BUILDING_DEFS[building.kind]?.military === true) {
      hasMilitaryBuilding = true;
      break;
    }
  }
  return !hasBuilding || !hasMilitaryBuilding;
}

/**
 * Conquest defeat check (deterministic): true when the player (owner 0)
 * is eliminated under the B8 capital / war-weariness rule — zero units
 * AND (zero buildings OR no surviving military building). Pure function
 * of world state — no wall clock, no RNG. Mirror of
 * checkSkirmishVictory.
 */
export function checkSkirmishDefeat(world: World): boolean {
  // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): conquest
  // defeat is unreachable in peaceful worlds (nothing hostile exists)
  // — and peaceful mode is endless (2026-10-01), with no defeat
  // condition at all. Not by this conquest check, not by anything.
  //
  // Final-review R2 (2026-10-01): this check needs zero human units
  // AND zero human buildings — reachable now that buildings take
  // damage (C3): an enemy army with siege orders can raze the
  // player's base to the ground, so defeat is a live threat at every
  // difficulty for the first time.
  //
  // Roadmap B8 (2026-10-02): the war-weariness short-circuit — zero
  // units plus a destroyed war core (no military building left) ends
  // the game even when civilian houses still stand, cutting the
  // bulldoze-the-houses endgame grind. See isConquestEliminated.
  if (world.peaceful === true) return false;
  if (world.victoryKind !== undefined && world.victoryKind !== 'conquest') {
    // Roadmap B2: symmetric — the rival can win the economic race too.
    return checkAltVictory(world, AI_PLAYER_ID);
  }
  return isConquestEliminated(world, HUMAN_PLAYER_ID);
}

/**
 * Fun-audit A4 (2026-10-02): the war-weariness defeat from the player's
 * chair. Exposes the B8 elimination rule for the human side so the game
 * loop can raise the "your war core has fallen" warning BEAT before the
 * defeat screen — today the game can end while the civilian city stands,
 * which reads as "my city is fine, why did I lose?". Pure function of
 * world state, no wall clock, no RNG.
 */
export function isHumanWarCoreFallen(world: World): boolean {
  if (world.peaceful === true) return false;
  return isConquestEliminated(world, HUMAN_PLAYER_ID);
}

/**
 * Fun-audit B1 (2026-10-02): the human base position in world coords —
 * the intro camera's target. Same land-search the session assembly uses
 * for starting forces (HUMAN_CORNER), so the camera opens on the
 * player's actual base instead of empty map center.
 */
export function humanBaseWorld(terrain: TerrainData): { x: number; z: number } {
  return findLandNear(terrain, HUMAN_CORNER.x, HUMAN_CORNER.z);
}

/**
 * Ticks before conquest win/lose checks start firing. Both sides deploy
 * their starting forces on tick 0, but the grace period guards against
 * edge cases with slow or delayed spawns.
 */
export const CONQUEST_GRACE_TICKS = 30;

export type SkirmishOutcome = 'victory' | 'defeat';

/**
 * Combined conquest outcome for a skirmish with a rival. Returns null
 * during the grace period or while both sides still hold forces.
 *
 * Defeat takes precedence when both sides are eliminated on the same
 * tick: the player must survive their victory to claim it.
 *
 * Callers should only check when `hasRival` is true; sandbox games
 * (no rival) have no win/lose condition by design. Campaign missions
 * use their own director-driven outcome.
 */
export function getSkirmishOutcome(world: World): SkirmishOutcome | null {
  // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): conquest is
  // bypassed entirely in peaceful worlds — the peaceful victory check
  // (sim/peaceful.ts, driven by the UI panel) owns the outcome.
  if (world.peaceful === true) return null;
  if (world.tick < CONQUEST_GRACE_TICKS) return null;
  if (checkSkirmishDefeat(world)) return 'defeat';
  if (checkSkirmishVictory(world)) return 'victory';
  return null;
}

/**
 * Create a fresh skirmish session. Deterministic in (seed, aiDifficulty):
 * same inputs, same world, same AI behavior.
 *
 * With `campaignMission` set, the mission drives the setup: its map
 * preset, its AI difficulty ('none' = no AI rival at all), and its
 * starting-resource overrides. The AI player (owner 1) always receives
 * a manpower stockpile so the campaign director's scripted raids can
 * pay the `spawnUnit` manpower cost.
 */
export function createSession(options: SessionOptions): GameSession {
  const { seed } = options;
  const mission = options.campaignMission;
  const aiDifficulty: AIDifficulty =
    mission !== undefined
      ? mission.aiDifficulty === 'none'
        ? 'citizen' // placeholder: no AI player is added below
        : mission.aiDifficulty
      : (options.aiDifficulty ?? 'citizen');
  const preset = getMapPreset(
    mission?.mapPreset ?? options.mapPreset ?? 'Meridian Plains',
  );

  const terrain = generateTerrain(preset.seed, preset);
  // Restored games resume the exact saved world; fresh games start empty.
  const world = options.snapshot ? restoreSnapshot(options.snapshot) : createWorld(seed);
  if (options.snapshot) {
    // Roadmap B25 (2026-10-02): v9+ snapshots store flow fields as
    // identities only (direction grids are derived data, dropped to keep
    // saves small) — rebuild them now that the terrain exists. The world
    // must not tick before this runs (movement reads field.dirs).
    rebuildFlowFields(world, terrain);
    // R1-C (M2) — command queue is session-owned, never snapshotted:
    // the queue is DELIBERATELY dropped on save/load. Pending commands
    // (player/AI orders due on a later tick, plus self-scheduled
    // cleanups such as `resupplyTimeout`) do not survive a restore —
    // the restored session always starts with an empty queue, and the
    // AI re-issues its orders on its next think. The one thing that
    // must not leak is the resupply reservation ledger: a vanished
    // `resupplyTimeout` would leave the unit's `resupplyDepotId` set
    // and the depot's `reservedAmmo`/`reservedFuel` claimed until the
    // unit dies, refills, or the depot is demolished. So every restore
    // releases all in-flight resupply reservations up front: depot
    // stock returns to the available pool and the unit linkage clears.
    // Units still en route keep traveling (movement state IS
    // snapshotted); they are served from available stock on arrival,
    // and the AI/player can re-issue `resupply` if a hold is wanted.
    // Deterministic: world.units is id-ordered and releaseUnitReservation
    // is idempotent per unit.
    for (const unit of world.units) {
      if ((unit.resupplyDepotId ?? 0) > 0) releaseUnitReservation(world, unit);
    }
  }
  // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): the flag is
  // set at tick 0 from the session options and never toggled mid-game.
  // Restored sessions carry whatever the snapshot saved (restoreSnapshot
  // decodes it); fresh sessions take it from `SessionOptions.peaceful`.
  // This must run before startingForces: the opening force is civilian
  // in peaceful worlds (rifles are a military def).
  if (!options.snapshot) {
    world.peaceful = options.peaceful === true;
    // Roadmap B2 (2026-10-02): the victory kind is set at tick 0 from
    // the session options and never toggled mid-game (like peaceful).
    // Restored sessions carry whatever the snapshot saved. Unknown
    // values resolve to conquest rather than crashing.
    world.victoryKind = isSkirmishVictoryKind(options.victoryKind)
      ? options.victoryKind
      : 'conquest';
  }
  const queue = createCommandQueue();
  registerCoreCommands(queue);
  registerCityCommands(queue, terrain);
  registerEconomyCommands(queue);
  registerUnitCommands(queue, terrain);
  registerMovementCommands(queue, terrain);
  registerCombatCommands(queue, terrain);
  // Grand-expansion Phase 6 (S6 intel): the covert-op commands
  // (infiltrateBuilding / sabotage / stealTech).
  registerIntelCommands(queue);
  // Roadmap B3 (2026-10-02): the diplomacy commands
  // (sendTribute / demandTribute / proposeCeasefire).
  registerDiplomacyCommands(queue);
  // Phase 3 logistics (workstream 3): resupply + supply toggles.
  registerLogisticsCommands(queue, terrain);
  registerAgeCommands(queue);
  registerCheatCommands(queue);
  registerDelegationCommands(queue);
  registerSuperweaponCommands(queue);
  // Roster expansion: the researchUpgrade command is wired here (the sim
  // module deliberately leaves registration to the UI assembly point).
  registerUpgradeCommands(queue);

  const driver = createTickDriver({
    queue,
    systems: [
      createPathfindingSystem(terrain),
      createMovementSystem(terrain),
      createCombatSystem(terrain),
      createSuperweaponSystem(),
      createEconomySystem(terrain),
      // Fun-audit B2 (2026-10-02): the wonder countdown runs right
      // after the economy tick — funds and population are economy-tick
      // values, so the trigger reads this tick's numbers.
      createWonderCountdownSystem(),
      // Grand-expansion Phase 6 (S6 intel): spy infiltration missions
      // advance every tick (asset accrual rides the economy tick).
      createIntelSystem(),
      createMayorSystem(queue, terrain),
      // AI needs the queue to issue its orders through, and the terrain
      // so the peaceful-mode AI can site physical buildings.
      createAISystem(queue, terrain),
      // Generals issue orders like the AI does, after it.
      createGeneralSystem(queue),
    ],
  });

  const aiBase = findLandNear(terrain, AI_CORNER.x, AI_CORNER.z);
  const humanBase = findLandNear(terrain, HUMAN_CORNER.x, HUMAN_CORNER.z);
  if (!options.snapshot) {
    const hasAIRival =
      !options.sandbox &&
      (mission === undefined || mission.aiDifficulty !== 'none');
    if (hasAIRival) {
      // The AI's production cap counts all its units: starting forces must
      // leave headroom under the cap, or the AI would never build.
      // Cadet (cap 4) gets 2 starters; citizen/commander get the full 6.
      const aiStarters = aiDifficulty === 'cadet' ? 2 : AI_MAX_UNITS[aiDifficulty];
      startingForces(queue, world, terrain, AI_PLAYER_ID, 'ai-setup', aiBase, aiStarters);
      addAIPlayer(world, AI_PLAYER_ID, aiDifficulty, aiBase.x, aiBase.z);
    }
    // Scripted raids spawn for owner 1 through the command queue, which
    // validates manpower — fund the raiders even when no AI rival plays.
    const aiPlayer = world.city.players[AI_PLAYER_ID];
    if (aiPlayer !== undefined && aiPlayer.manpower < RAID_MANPOWER) {
      aiPlayer.manpower = RAID_MANPOWER;
    }
    startingForces(queue, world, terrain, HUMAN_PLAYER_ID, 'player', humanBase);

    // Apply the starting forces now (one fixed tick) so a fresh session
    // already has both armies on the field.
    driver.step(world, TICK_MS);

    if (mission?.startingResources !== undefined) {
      // Campaign funds fix: the mission's starting resources are the
      // player's OPENING stockpile, so they are granted AFTER the initial
      // spawn tick. spawnUnit now deducts training costs (funds +
      // materials), and granting before the tick left the player with
      // e.g. 4660 instead of the designed 5000 funds — the setup costs
      // were eating into the mission's opening grant. Assignment (not
      // addition) keeps the mission def as the single source of truth.
      const human = world.city.players[HUMAN_PLAYER_ID];
      if (human !== undefined) {
        for (const [key, value] of Object.entries(mission.startingResources)) {
          (human as unknown as Record<string, number>)[key] = value;
        }
      }
    }
  }
  // Restored sessions skip all of the above: units, buildings, AI state,
  // and RNG streams come back exactly as saved.

  // A rival exists when the Classic AI is registered for owner 1.
  // (Fresh sandbox/mission-'none' sessions never add one; restored
  // sessions carry whatever was saved.)
  const hasRival = world.ai.players.some((p) => p.owner === AI_PLAYER_ID);

  return {
    sessionId:
      mission !== undefined
        ? `novaterra-campaign-${mission.id}-${seed >>> 0}`
        : `novaterra-${seed >>> 0}-${aiDifficulty}`,
    seed,
    aiDifficulty,
    // The resolved preset name (getMapPreset falls back to Meridian
    // Plains for unknown names), so the save records the map that was
    // ACTUALLY generated — never the raw option (R1-C/C4).
    mapPreset: preset.name,
    campaignMissionId: mission?.id ?? null,
    hasRival,
    terrain,
    world,
    queue,
    driver,
    tick: () => {
      driver.step(world, TICK_MS);
    },
    enqueuePlayerIntent: (intent: OrderIntent) => {
      queue.enqueue(world, { ...intent, issuer: 'player' });
    },
    digest: () => String(digestWorld(world)),
    cheated: false,
  };
}
