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
 * NOVATERRA — sim/snapshot.ts — versioned world snapshots.
 *
 * Responsibilities:
 *  - `takeSnapshot(world)` → plain-data `Snapshot` with a `version` field;
 *    `restoreSnapshot(data)` → a fresh, independent `World`.
 *  - Version mismatch is a hard error naming expected vs found — old saves
 *    never silently load as something else. (Migrations chain in
 *    net_save/ in a later step; this module is the versioned unit they
 *    migrate.)
 *
 * Key invariants:
 *  - Snapshots are taken at tick boundaries. The tick driver's accumulator
 *    is wall-clock-derived and intentionally NOT in the snapshot.
 *  - Snapshots are deep copies: mutating the world after taking one (or
 *    mutating the snapshot) cannot affect the other.
 *  - The snapshot is JSON-serializable: only numbers, strings, arrays, and
 *    plain objects. `JSON.parse(JSON.stringify(snap))` round-trips exactly.
 *  - Round-trip preserves the digest exactly: digest(restore(take(w)))
 *    === digest(w). This is the save/load integrity check.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { EntityRecord, World } from './world';
import { createWorld } from './world';
import type { RngState } from './rng';
import type { BuildingRecord, CityState, PlayerState } from './city';
import type { UnitRecord } from './units';
import type { FieldBuild, FieldRequest, FlowField, PathfindingState, PathRequest } from './pathfinding';
import { initPathfinding } from './pathfinding';
import type { AIState } from './ai';
import { encodeAIState, decodeAIState, initAI } from './ai';

/**
 * Snapshot format version. Bump on any breaking change to the shape below.
 * v2: city state (roads/zones/buildings/players) added (Phase 1, step 5).
 * v3: units + pathfinding coordinator state added (Phase 1, step 6).
 */
export const SNAPSHOT_VERSION = 3;

/** Plain-data snapshot of the world at a tick boundary. */
export interface Snapshot {
  version: number;
  tick: number;
  time: number;
  seed: number;
  nextId: number;
  entities: EntityRecord[];
  rng: RngState;
  city: CityState;
  units: UnitRecord[];
  pathfinding: PathfindingState;
  ai: AIState;
}

/** Thrown when a snapshot's version doesn't match. Names expected vs found. */
export class SnapshotVersionError extends Error {
  readonly expected: number;
  readonly found: unknown;
  constructor(expected: number, found: unknown) {
    super(
      `snapshot version mismatch: expected ${expected}, found ${JSON.stringify(found)}`,
    );
    this.name = 'SnapshotVersionError';
    this.expected = expected;
    this.found = found;
  }
}

function copyEntities(entities: EntityRecord[]): EntityRecord[] {
  return entities.map((e) => ({ id: e.id, kind: e.kind, x: e.x, z: e.z }));
}

function copyRng(rng: RngState): RngState {
  const out: RngState = {};
  for (const name of Object.keys(rng)) {
    out[name] = rng[name] as number;
  }
  return out;
}

function copyBuilding(b: BuildingRecord): BuildingRecord {
  return {
    id: b.id, kind: b.kind, owner: b.owner, cx: b.cx, cz: b.cz,
    facing: b.facing, progress: b.progress, level: b.level,
    operational: b.operational, powered: b.powered, watered: b.watered,
  };
}

function copyPlayer(p: PlayerState): PlayerState {
  return {
    id: p.id, name: p.name, funds: p.funds, materials: p.materials,
    fuel: p.fuel, food: p.food, research: p.research,
    taxRates: [p.taxRates[0] as number, p.taxRates[1] as number, p.taxRates[2] as number],
    population: p.population,
  };
}

function copyCity(city: CityState): CityState {
  return {
    roads: [...city.roads],
    zones: city.zones.map((z) => ({ cell: z.cell, zone: z.zone })),
    buildings: city.buildings.map(copyBuilding),
    nextBuildingId: city.nextBuildingId,
    players: city.players.map(copyPlayer),
    foodShortage: city.foodShortage,
  };
}

function copyUnit(u: UnitRecord): UnitRecord {
  return {
    id: u.id, kind: u.kind, owner: u.owner, x: u.x, z: u.z,
    domain: u.domain, hp: u.hp, cooldownLeft: u.cooldownLeft,
    targetId: u.targetId, chasing: u.chasing,
    speed: u.speed, state: u.state, failReason: u.failReason,
    destX: u.destX, destZ: u.destZ, arriveX: u.arriveX, arriveZ: u.arriveZ,
    path: [...u.path], pathAt: u.pathAt,
    fieldId: u.fieldId,
  };
}

function copyPathRequest(r: PathRequest): PathRequest {
  return { unitId: r.unitId, destCell: r.destCell };
}

function copyFieldRequest(r: FieldRequest): FieldRequest {
  return { fieldId: r.fieldId, destCell: r.destCell, unitIds: [...r.unitIds] };
}

function copyFlowField(f: FlowField): FlowField {
  return { id: f.id, destCell: f.destCell, dirs: [...f.dirs] };
}

/**
 * Deep-copy an in-progress field build. All arrays are plain JSON-safe
 * data (FLOOD_INF instead of Infinity — real Infinity would become null
 * in JSON), so the copy resumes bit-identically.
 */
function copyFieldBuild(b: FieldBuild): FieldBuild {
  return {
    fieldId: b.fieldId,
    destCell: b.destCell,
    unitIds: [...b.unitIds],
    waitMark: [...b.waitMark],
    waitingCount: b.waitingCount,
    dist: [...b.dist],
    closed: [...b.closed],
    heapCells: [...b.heapCells],
    heapPris: [...b.heapPris],
    heapTies: [...b.heapTies],
    nextTie: b.nextTie,
    earlyExit: b.earlyExit,
  };
}

function copyPathfinding(pf: PathfindingState): PathfindingState {
  return {
    queue: pf.queue.map(copyPathRequest),
    fieldQueue: pf.fieldQueue.map(copyFieldRequest),
    activeBuild: pf.activeBuild ? copyFieldBuild(pf.activeBuild) : null,
    fields: pf.fields.map(copyFlowField),
    nextFieldId: pf.nextFieldId,
  };
}

/** Deep-copy the world's sim state into a versioned, JSON-safe snapshot. */
export function takeSnapshot(world: World): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    tick: world.tick,
    time: world.time,
    seed: world.seed,
    nextId: world.nextId,
    entities: copyEntities(world.entities),
    rng: copyRng(world.rng),
    city: copyCity(world.city),
    units: world.units.map(copyUnit),
    pathfinding: copyPathfinding(world.pathfinding),
    ai: encodeAIState(world.ai) as AIState,
  };
}

/**
 * Rebuild a world from a snapshot. The result shares no references with the
 * snapshot. Throws SnapshotVersionError on version mismatch.
 */
export function restoreSnapshot(snap: Snapshot): World {
  if (snap === null || typeof snap !== 'object') {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap);
  }
  if (snap.version !== SNAPSHOT_VERSION) {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap.version);
  }
  const world = createWorld(snap.seed);
  world.tick = snap.tick;
  world.time = snap.time;
  world.nextId = snap.nextId;
  world.entities = copyEntities(snap.entities);
  world.rng = copyRng(snap.rng);
  world.city = copyCity(snap.city);
  world.units = (snap.units ?? []).map(copyUnit);
  // Defensive: a hand-built v3 snapshot might omit pathfinding state —
  // init instead of crashing on undefined.
  world.pathfinding = snap.pathfinding ? copyPathfinding(snap.pathfinding) : initPathfinding();
  // Defensive: older snapshots lack AI state — init instead of crashing.
  world.ai = snap.ai ? decodeAIState(snap.ai) : initAI();
  return world;
}
