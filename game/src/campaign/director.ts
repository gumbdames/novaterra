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
 * NOVATERRA — campaign/director.ts — mission runtime director (Phase 2).
 *
 * Responsibilities:
 *  - `MissionRunState`: per-mission UI-side state — kill/loss counters,
 *    fired events, pending raid moves. UI-owned, never sim state (like
 *    `session.cheated`): it observes the sim and issues commands, exactly
 *    as the audio engine observes without mutating.
 *  - `updateMissionRun(...)`: check scripted event triggers, fire them
 *    (messages become directives; raids enqueue `spawnUnit` commands
 *    through the normal queue with issuer 'mission'), detect victory
 *    (any path complete) and defeat (player wiped out).
 *  - Raid movement is two-phase: spawn commands enqueue at fire time;
 *    on the next update the fresh unit ids (>= the recorded `nextId`)
 *    are found and ordered toward the player's base with `moveGroup`.
 *    This keeps every sim change on the tick-aligned command path.
 *
 * Determinism: given the same world ticks, the director issues the same
 * commands at the same ticks. It never reads wall clock or Math.random.
 * No DOM — safe under Node/vitest. The game controller (ui/game.ts)
 * calls `updateMissionRun` ~2×/sec and renders the directives.
 */

import type { World } from '../sim/world';
import type { CommandQueue, NewCommand } from '../sim/commands';
import type { TerrainData } from '../sim/terrain';
import { isWater } from '../sim/terrain';
import { getAgeState } from '../sim/ages';
import { MAP_HALF_SIZE, getPlayer, type BuildingKind } from '../sim/city';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import {
  checkPath,
  playerAlive,
  type ObjectiveProgress,
} from './objectives';
import type {
  MissionDef,
  MissionEventDef,
  MissionPath,
  RaidDirection,
} from './missions';

/** UI-side per-mission state. Never enters the sim. */
export interface MissionRunState {
  missionId: string;
  /** Unit ids seen on the last update, with owners (for kill/loss detection). */
  knownUnits: Map<number, number>;
  /** Enemy units destroyed (cumulative). */
  kills: number;
  /** Player units lost (cumulative). */
  unitsLost: number;
  /** Event ids already fired. */
  eventsFired: Set<string>;
  /** Last seen age (for onAgeAdvanced). */
  lastAge: string;
  /** Building-kind counts at mission start (for onFirstBuilding). */
  initialBuildingCounts: Map<BuildingKind, number>;
  /** Raids waiting for their spawned units to appear. */
  pendingRaids: PendingRaid[];
  /** Set once victory/defeat is reported (directives fire exactly once). */
  finished: boolean;
  /** The winning path, if victory was achieved. */
  wonPath: MissionPath | null;
}

interface PendingRaid {
  /** world.nextId at spawn time: fresh units have id >= this. */
  minUnitId: number;
  owner: number;
  destX: number;
  destZ: number;
  /** Ticks left before giving up on finding the raiders. */
  ttl: number;
}

export type MissionDirective =
  | { kind: 'message'; text: string }
  | { kind: 'objectiveComplete'; pathName: string; label: string }
  | { kind: 'victory'; path: MissionPath }
  | { kind: 'defeat'; reason: string };

/** Fresh run state. Call right after the mission session is created. */
export function createMissionRun(mission: MissionDef, world: World): MissionRunState {
  const knownUnits = new Map<number, number>();
  for (const u of world.units) knownUnits.set(u.id, u.owner);
  const initialBuildingCounts = new Map<BuildingKind, number>();
  for (const b of world.city.buildings) {
    initialBuildingCounts.set(b.kind, (initialBuildingCounts.get(b.kind) ?? 0) + 1);
  }
  return {
    missionId: mission.id,
    knownUnits,
    kills: 0,
    unitsLost: 0,
    eventsFired: new Set(),
    lastAge: getAgeState(world, MISSION_HUMAN_ID).age, // per-side ages: the mission player's own age
    initialBuildingCounts,
    pendingRaids: [],
    finished: false,
    wonPath: null,
  };
}

/** Player and AI ids for a mission session (same convention as skirmish). */
export const MISSION_HUMAN_ID = 0;
export const MISSION_AI_ID = 1;

/**
 * Advance the mission director. Enqueues raid commands as needed and
 * returns UI directives (messages, victory, defeat). Idempotent per
 * tick: events fire once, victory/defeat report once.
 */
export function updateMissionRun(
  run: MissionRunState,
  mission: MissionDef,
  world: World,
  queue: CommandQueue,
  terrain: TerrainData,
): MissionDirective[] {
  const directives: MissionDirective[] = [];
  if (run.finished) return directives;

  // --- Track unit losses (kills vs losses by owner). ---
  const seen = new Set<number>();
  for (const u of world.units) {
    seen.add(u.id);
    if (!run.knownUnits.has(u.id)) run.knownUnits.set(u.id, u.owner);
  }
  for (const [id, owner] of run.knownUnits) {
    if (!seen.has(id)) {
      if (owner === MISSION_AI_ID) run.kills += 1;
      else if (owner === MISSION_HUMAN_ID) run.unitsLost += 1;
      run.knownUnits.delete(id);
    }
  }

  // --- Fire scripted events. ---
  for (const event of mission.events) {
    if (run.eventsFired.has(event.id)) continue;
    if (eventTriggered(run, event, world)) {
      run.eventsFired.add(event.id);
      directives.push({ kind: 'message', text: event.message });
      if (event.raid) {
        fireRaid(run, event, world, queue, terrain);
      }
    }
  }

  // --- Move pending raids once their units exist. ---
  resolvePendingRaids(run, world, queue);

  // --- Defeat: the president has nothing left (grace period for setup). ---
  if (!run.finished && world.tick > 60 && !playerAlive(world, MISSION_HUMAN_ID)) {
    run.finished = true;
    directives.push({ kind: 'defeat', reason: 'All of your forces were destroyed.' });
    return directives;
  }

  // --- Victory: every objective of any one path complete. ---
  if (!run.finished) {
    for (const path of mission.paths) {
      const { complete } = checkPath(world, MISSION_HUMAN_ID, MISSION_AI_ID, path, run.kills);
      if (complete) {
        run.finished = true;
        run.wonPath = path;
        directives.push({ kind: 'victory', path });
        return directives;
      }
    }
  }

  run.lastAge = getAgeState(world, MISSION_HUMAN_ID).age;
  return directives;
}

/**
 * Current per-objective progress for the HUD panel. Pure read of world
 * state — cheap enough to call every UI refresh.
 */
export function missionProgress(
  run: MissionRunState,
  mission: MissionDef,
  world: World,
): Array<{ path: MissionPath; complete: boolean; objectives: ObjectiveProgress[] }> {
  return mission.paths.map((path) => {
    const { complete, objectives } = checkPath(
      world,
      MISSION_HUMAN_ID,
      MISSION_AI_ID,
      path,
      run.kills,
    );
    return { path, complete, objectives };
  });
}

function eventTriggered(
  run: MissionRunState,
  event: MissionEventDef,
  world: World,
): boolean {
  const t = event.trigger;
  switch (t.kind) {
    case 'atTick':
      return world.tick >= t.tick;
    case 'onFirstBuilding': {
      const now = world.city.buildings.filter(
        (b) => b.owner === MISSION_HUMAN_ID && b.kind === t.building && b.progress >= 1,
      ).length;
      return now > (run.initialBuildingCounts.get(t.building) ?? 0);
    }
    case 'onFirstCombat':
      return run.kills + run.unitsLost > 0;
    case 'onAgeAdvanced':
      return getAgeState(world, MISSION_HUMAN_ID).age === t.age && run.lastAge !== t.age;
    case 'onLowFunds': {
      const player = getPlayer(world.city, MISSION_HUMAN_ID);
      return (player?.funds ?? 0) < 200;
    }
  }
}

/** Player base centroid (fallback: map center) — raid destination. */
function playerBase(world: World): { x: number; z: number } {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== MISSION_HUMAN_ID) continue;
    sx += b.cx;
    sz += b.cz;
    n += 1;
  }
  if (n > 0) return { x: sx / n, z: sz / n };
  for (const u of world.units) {
    if (u.owner !== MISSION_HUMAN_ID) continue;
    sx += u.x;
    sz += u.z;
    n += 1;
  }
  if (n > 0) return { x: sx / n, z: sz / n };
  return { x: 0, z: 0 };
}

/** Edge spawn point for a raid direction, snapped to land/water per domain. */
function raidSpawn(
  terrain: TerrainData,
  from: RaidDirection,
  index: number,
  total: number,
  domain: 'land' | 'sea' | 'air',
): { x: number; z: number } {
  const m = MAP_HALF_SIZE - 30;
  const spread = (index - (total - 1) / 2) * 24;
  let x = 0;
  let z = 0;
  switch (from) {
    case 'north': x = spread; z = -m; break;
    case 'south': x = spread; z = m; break;
    case 'east': x = m; z = spread; break;
    case 'west': x = -m; z = spread; break;
  }
  // Spiral outward until the cell suits the domain (mirrors
  // ui/session.ts findLandNear; duplicated to avoid a ui→campaign import).
  for (let r = 0; r <= 120; r += 6) {
    for (let a = 0; a < 8; a += 1) {
      const px = x + Math.cos((a / 8) * 2 * Math.PI) * r;
      const pz = z + Math.sin((a / 8) * 2 * Math.PI) * r;
      const water = isWater(terrain, px, pz);
      if (domain === 'sea' ? water : !water) return { x: px, z: pz };
    }
  }
  return { x, z };
}

function fireRaid(
  run: MissionRunState,
  event: MissionEventDef,
  world: World,
  queue: CommandQueue,
  terrain: TerrainData,
): void {
  const raid = event.raid;
  if (!raid) return;
  const dest = playerBase(world);
  const minUnitId = world.nextId;
  const kinds: UnitKind[] = [];
  for (let i = 0; i < raid.count; i += 1) {
    kinds.push(raid.kinds[i % raid.kinds.length]!);
  }
  kinds.forEach((kind, i) => {
    const domain = UNIT_DEFS[kind].domain;
    const pos = raidSpawn(terrain, raid.from, i, kinds.length, domain);
    const cmd: NewCommand = {
      kind: 'spawnUnit',
      issuer: 'mission',
      payload: { kind, owner: MISSION_AI_ID, x: pos.x, z: pos.z },
    };
    try {
      queue.enqueue(world, cmd);
    } catch {
      // A rejected raid spawn (e.g. no water on a land map edge) is a
      // loud-enough signal in tests; in game the raid is simply smaller.
    }
  });
  run.pendingRaids.push({ minUnitId, owner: MISSION_AI_ID, destX: dest.x, destZ: dest.z, ttl: 300 });
}

function resolvePendingRaids(
  run: MissionRunState,
  world: World,
  queue: CommandQueue,
): void {
  const remaining: PendingRaid[] = [];
  for (const pending of run.pendingRaids) {
    const fresh = world.units.filter(
      (u) => u.owner === pending.owner && u.id >= pending.minUnitId && u.hp > 0,
    );
    if (fresh.length > 0) {
      const cmd: NewCommand = {
        kind: 'moveGroup',
        issuer: 'mission',
        payload: {
          unitIds: fresh.map((u) => u.id),
          owner: pending.owner,
          x: pending.destX,
          z: pending.destZ,
        },
      };
      try {
        queue.enqueue(world, cmd);
      } catch {
        // If the destination is unreachable the raiders hold position;
        // opportunistic combat still engages anything in range.
      }
    } else if (pending.ttl > 0) {
      pending.ttl -= 1;
      remaining.push(pending);
    }
    // ttl exhausted or units ordered: drop the pending raid.
  }
  run.pendingRaids = remaining;
}
