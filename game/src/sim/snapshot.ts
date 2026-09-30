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
import type { RailCell, RoadCell } from './city';
import { migrateRoadsV6ToV7, defaultHangarSlots, DEFAULT_TAX_RATE } from './city';
import type { UnitRecord } from './units';
import type { FieldBuild, FieldRequest, FlowField, PathfindingState, PathRequest } from './pathfinding';
import { initPathfinding } from './pathfinding';
import type { AIState } from './ai';
import { encodeAIState, decodeAIState, initAI } from './ai';
import type { AgeState } from './ages';
import { encodeAgeState, decodeAgeState, initAges } from './ages';
import type { DelegationState } from './delegation';
import { encodeDelegationState, decodeDelegationState, initDelegation } from './delegation';
import type { SuperweaponState } from './superweapons';
import { encodeSuperweaponState, decodeSuperweaponState, initSuperweapons } from './superweapons';
import { encodeUpgrades, decodeUpgrades } from './upgrades';

/**
 * Snapshot format version. Bump on any breaking change to the shape below.
 * v2: city state (roads/zones/buildings/players) added (Phase 1, step 5).
 * v3: units + pathfinding coordinator state added (Phase 1, step 6).
 *     (Classic AI state was added in step 7 without a version bump.)
 * v4: Age state (Foundation → Connectivity + National Program) added (Phase 1, step 8).
 * v5: Chain-of-command state, superweapon state, city specialization and
 *     trade routes added (Phase 3).
 * v6: Per-player researched upgrades added (roster expansion, Phase 4).
 *     v5 snapshots still load: upgrades default to {} per the spec.
 *     (AI personality joined the AI state without a bump: decodeAIState
 *     defaults a missing personality to the neutral personality, which
 *     reproduces pre-personality behavior exactly — the step-7 precedent
 *     for AI-state additions.)
 * v7: Road classes (roads: number[] → RoadCell[] {cell, cls}) + the rail
 *     layer (rails: RailCell[]) + ferry routes on units (Phase 4
 *     transport, S7). v5/v6 snapshots still load: v6 roads migrate to
 *     the behavior-preserving default class 'paved' (see
 *     migrateRoadsV6ToV7 — the old flat cost and moveCost ARE paved's
 *     stats), rails default to [], ferry routes default to undefined
 *     (the AD9 additive precedent).
 * v8: Grand-expansion Phase 5/6 data contract (S4): BuildingRecord.hangars
 *     (HangarSlot[]), UnitRecord.hangarBuildingId / embarkedOn. PURELY
 *     ADDITIVE — v5/v6/v7 snapshots still load with no shape migration:
 *     v7 buildings decode hangars to defaultHangarSlots(kind) (legacy
 *     airfields get LEGACY_AIRFIELD_HANGAR_SLOTS generic slots — the
 *     documented S4 default, pinned in sim.hangars.test.ts; everything
 *     else gets undefined, "never had hangars"), v7 units decode
 *     hangarBuildingId/embarkedOn to 0 (unparked, unembarked). Note this
 *     deliberately deviates from PLAN §11's "no bump" line for these
 *     fields: the bump was ordered for Phase 5 workstream D so the
 *     hangar/airport data contract has a versioned home before workers
 *     A/B/C land their behavior; the decode defaults remain AD9-neutral
 *     so every old save still plays.
 *     (Phase 7 workstream 3, 2026-09-30: BuildingRecord.discovery is
 *     PURELY ADDITIVE on top of v8 — older saves decode to undefined,
 *     no version bump, the sabotagedUntil precedent.)
 */
export const SNAPSHOT_VERSION = 8;

/** Oldest snapshot version that still loads (v5: paved roads, empty rails; v7: hangars/embark defaults). */
export const OLDEST_SUPPORTED_SNAPSHOT_VERSION = 5;

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
  ages: AgeState;
  delegation: DelegationState;
  superweapons: SuperweaponState;
  upgrades: Record<number, string[]>;
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

/**
 * Deep-copy one building record. Shared by the take path (live world →
 * snapshot) and the restore path (snapshot → world); the two differ
 * ONLY for the v8 hangar field:
 * - Take (legacy=false): faithful copy — a live building without
 *   hangars snapshots as absent (undefined), NOT as the legacy
 *   default. Inventing defaults here broke digest-stability: a
 *   fixture-built airfield (no hangars array) would digest differently
 *   after a save/load round trip (caught by sim.ai.test.ts
 *   determinism, 2026-09-30).
 * - Restore of a pre-v8 snapshot (legacy=true): the snapshot predates
 *   the hangar field — decode to defaultHangarSlots(kind) (legacy
 *   airfields → LEGACY_AIRFIELD_HANGAR_SLOTS generic slots, everything
 *   else → undefined, AD9). The snapshot version disambiguates a v8
 *   "absent" (faithful undefined — JSON drops undefined keys) from a
 *   v7 "absent" (predates the field).
 */
function copyBuilding(b: BuildingRecord, legacy = false): BuildingRecord {
  return {
    id: b.id, kind: b.kind, owner: b.owner, cx: b.cx, cz: b.cz,
    facing: b.facing, progress: b.progress, level: b.level,
    operational: b.operational, powered: b.powered, watered: b.watered,
    // Phase 2 utility diagnostics. ?? 'disconnected' so legacy v6 saves
    // (which lack these fields) decode to the honest pre-evaluation
    // state — no version bump, stays v6 (the veterancy ?? 0 precedent).
    powerDiag: b.powerDiag ?? 'disconnected',
    waterDiag: b.waterDiag ?? 'disconnected',
    // Phase 3 logistics stocks. ?? 0 so legacy v6 saves decode to
    // empty depots — no version bump, stays v6 (same precedent).
    ammoStock: b.ammoStock ?? 0,
    fuelStock: b.fuelStock ?? 0,
    // Phase 3 resupply reservations (0 = none reserved). ?? 0 keeps v6.
    reservedAmmo: b.reservedAmmo ?? 0,
    reservedFuel: b.reservedFuel ?? 0,
    // Workstream M: attack-triggered meltdown state. ?? 0 = no meltdown
    // (legacy saves never had one — no version bump, stays v6).
    meltdownUntilTick: b.meltdownUntilTick ?? 0,
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
    // sabotage state. ?? 0 = not sabotaged (legacy saves never were —
    // no version bump, stays v8; the meltdown ?? 0 precedent).
    sabotagedUntil: b.sabotagedUntil ?? 0,
    // Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30):
    // mixed-airport discovery state. AD9 additive: legacy saves decode
    // to undefined ("no rival has looked twice") — no version bump,
    // stays v8 (the sabotagedUntil precedent). Take is faithful
    // (absent stays absent); restore deep-copies the records.
    discovery: b.discovery?.map((d) => ({ ...d })),
    // Phase 4 occupancy + variety (2026-09-30). AD9 ?? defaults: legacy
    // v6/v7 saves decode to empty buildings with the default look —
    // no version bump (the veterancy ?? 0 precedent).
    residents: b.residents ?? 0,
    workers: b.workers ?? 0,
    variant: b.variant ?? 0,
    sizeTier: b.sizeTier ?? 1,
    // v8 (grand-expansion Phase 5/6, S4): hangar slots. Take path:
    // deep-copy what's there (absent stays absent). Restore path for
    // pre-v8 snapshots: decode to defaultHangarSlots(kind) — legacy
    // airfields get LEGACY_AIRFIELD_HANGAR_SLOTS generic empty slots
    // (the documented S4 default), everything else undefined (AD9).
    hangars: b.hangars !== undefined
      ? b.hangars.map((s) => ({ cls: s.cls, occupant: s.occupant }))
      : legacy ? defaultHangarSlots(b.kind) : undefined,
  };
}

function copyPlayer(p: PlayerState): PlayerState {
  return {
    id: p.id, name: p.name, funds: p.funds, materials: p.materials,
    fuel: p.fuel, food: p.food, research: p.research,
    goods: p.goods, influence: p.influence, manpower: p.manpower,
    taxRates: [
      p.taxRates[0] as number,
      p.taxRates[1] as number,
      p.taxRates[2] as number,
      // Grand-expansion Phase 5 (S5, 2026-09-30): the airport-zone rate.
      // Older saves (3-element arrays) decode element 3 to
      // DEFAULT_TAX_RATE — AD9 additive, no version bump (stays v8).
      // Pinned by sim.airports.test.ts.
      (p.taxRates[3] as number | undefined) ?? DEFAULT_TAX_RATE,
    ],
    population: p.population,
    specialization: p.specialization,
    // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
    // per-player intel asset counters. ?? 0 per counter so legacy
    // saves decode to zero assets — no version bump, stays v8 (the
    // meltdown ?? 0 precedent).
    intel: {
      surveillance: p.intel?.surveillance ?? 0,
      operational: p.intel?.operational ?? 0,
      counterIntel: p.intel?.counterIntel ?? 0,
    },
  };
}

/**
 * Deep-copy road cells, migrating legacy v6 snapshots (roads:
 * number[]) to v7 RoadCells via migrateRoadsV6ToV7. v7 input copies
 * verbatim. Defensive against hand-built/legacy shapes — never throws.
 */
function copyRoads(roads: unknown): RoadCell[] {
  if (!Array.isArray(roads)) return [];
  if (roads.length > 0 && typeof roads[0] === 'number') {
    return migrateRoadsV6ToV7(roads as number[]);
  }
  return (roads as RoadCell[]).map((r) => ({ cell: r.cell, cls: r.cls }));
}

/** Deep-copy rail cells; legacy (v6) snapshots lack the field → []. */
function copyRails(rails: unknown): RailCell[] {
  if (!Array.isArray(rails)) return [];
  return (rails as RailCell[]).map((r) => ({ cell: r.cell, cls: r.cls }));
}

function copyCity(city: CityState, legacy = false): CityState {
  return {
    // Phase 4 (S7, v7): roads carry a class now. v6 snapshots store
    // number[] — migrate every cell to 'paved' (behavior-preserving:
    // the old flat cost/moveCost ARE paved's stats). rails is new in
    // v7 — legacy saves decode to [] (AD9 additive).
    roads: copyRoads(city.roads as unknown),
    rails: copyRails(city.rails as unknown),
    // Phase 2: utility conductors. ?? [] / ?? 0 so legacy v6 saves
    // decode to "no lines/pipes, epoch zero" — no version bump, stays v6.
    powerLines: [...(city.powerLines ?? [])],
    pipes: [...(city.pipes ?? [])],
    utilityEpoch: city.utilityEpoch ?? 0,
    zones: city.zones.map((z) => ({ cell: z.cell, zone: z.zone })),
    buildings: city.buildings.map((b) => copyBuilding(b, legacy)),
    nextBuildingId: city.nextBuildingId,
    players: city.players.map(copyPlayer),
    foodShortage: city.foodShortage,
    tradeRoutes: city.tradeRoutes.map((r) => ({
      owner: r.owner, partner: r.partner, establishedTick: r.establishedTick,
    })),
    // Grand-expansion Phase 5 (S5, 2026-09-30): airline routes.
    // Legacy saves (no field) decode to [] / 1 — AD9 additive, no
    // version bump (stays v8).
    airlineRoutes: (city.airlineRoutes ?? []).map((r) => ({
      id: r.id, owner: r.owner, from: r.from, to: r.to,
      establishedTick: r.establishedTick,
    })),
    nextAirlineRouteId: city.nextAirlineRouteId ?? 1,
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
    // Phase 1 veterancy. ?? 0 so legacy v6 saves (which lack these
    // fields) decode to Recruit — no version bump, stays v6.
    xp: u.xp ?? 0, vetLevel: u.vetLevel ?? 0,
    // Phase 3 logistics. ?? 0 so legacy v6 saves decode to empty
    // tanks/magazines — no version bump, stays v6 (same precedent).
    // supplyServices is player config; absent = all services on.
    fuel: u.fuel ?? 0, ammo: u.ammo ?? 0,
    supplyServices: u.supplyServices ? { ...u.supplyServices } : undefined,
    // Phase 3 resupply linkage (0 = none). ?? 0 keeps v6 decoding.
    resupplyDepotId: u.resupplyDepotId ?? 0,
    // Phase 3 per-unit reservation ledger (workstream 3). ?? 0 keeps v6.
    resupplyReservedAmmo: u.resupplyReservedAmmo ?? 0,
    resupplyReservedFuel: u.resupplyReservedFuel ?? 0,
    // Phase 3 cargo holds. ?? 0 so legacy v6 saves decode to empty holds
    // — no version bump, stays v6 (AD9, same precedent as fuel/ammo).
    cargoFuel: u.cargoFuel ?? 0,
    cargoAmmo: u.cargoAmmo ?? 0,
    // Phase 4 (S7, v7): the ferry's shipping lane. Undefined for legacy
    // saves and non-ferry units (AD9 additive — no bump needed for this
    // field alone; it rides the v7 roads/rails bump).
    route: u.route ? { ...u.route } : undefined,
    // v8 (grand-expansion Phase 5/6, S4): hangar parking + carrier
    // embark state (0 = unparked / unembarked). Legacy v7 saves decode
    // to 0 via ?? 0 (AD9 — the same precedent as fuel/ammo).
    hangarBuildingId: u.hangarBuildingId ?? 0,
    embarkedOn: u.embarkedOn ?? 0,
    // v8 (grand-expansion Phase 6, S6 intel): spy mission state (0 =
    // no mission / unembedded / unspotted). Legacy v7 saves decode to
    // 0 via ?? 0 (AD9 — no version bump, stays v8).
    missionEndsAt: u.missionEndsAt ?? 0,
    missionTargetId: u.missionTargetId ?? 0,
    infiltrationProgress: u.infiltrationProgress ?? 0,
    embeddedIn: u.embeddedIn ?? 0,
    spottedUntil: u.spottedUntil ?? 0,
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
    ages: encodeAgeState(world.ages) as AgeState,
    delegation: encodeDelegationState(world.delegation) as DelegationState,
    superweapons: encodeSuperweaponState(world.superweapons) as SuperweaponState,
    upgrades: encodeUpgrades(world.upgrades),
  };
}

/**
 * Rebuild a world from a snapshot. The result shares no references with the
 * snapshot. Throws SnapshotVersionError on version mismatch. v5/v6/v7
 * snapshots still load: per the spec, old saves default upgrades to {},
 * v6 roads migrate to paved RoadCells (migrateRoadsV6ToV7), rails
 * default to [], ferry routes default to undefined, and v8's hangar
 * fields decode to their AD9 defaults (legacy airfields → 6 generic
 * slots via defaultHangarSlots, other buildings → undefined, units →
 * hangarBuildingId/embarkedOn 0).
 */
export function restoreSnapshot(snap: Snapshot): World {
  if (snap === null || typeof snap !== 'object') {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap);
  }
  if (snap.version !== SNAPSHOT_VERSION && snap.version !== 7 && snap.version !== 6 && snap.version !== 5) {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap.version);
  }
  const world = createWorld(snap.seed);
  world.tick = snap.tick;
  world.time = snap.time;
  world.nextId = snap.nextId;
  world.entities = copyEntities(snap.entities);
  world.rng = copyRng(snap.rng);
  // v8 hangar decode: pre-v8 snapshots predate the hangar field, so
  // their buildings decode to the legacy default (legacy=true); v8
  // snapshots copy faithfully (see copyBuilding).
  world.city = copyCity(snap.city, snap.version < 8);
  world.units = (snap.units ?? []).map(copyUnit);
  // Defensive: a hand-built v3 snapshot might omit pathfinding state —
  // init instead of crashing on undefined.
  world.pathfinding = snap.pathfinding ? copyPathfinding(snap.pathfinding) : initPathfinding();
  // Defensive: older snapshots lack AI state — init instead of crashing.
  world.ai = snap.ai ? decodeAIState(snap.ai) : initAI();
  // Defensive: older snapshots lack age state — init instead of crashing.
  world.ages = snap.ages ? decodeAgeState(snap.ages) : initAges();
  // Defensive: older snapshots lack delegation state — init instead of crashing.
  world.delegation = snap.delegation ? decodeDelegationState(snap.delegation) : initDelegation();
  // Defensive: older snapshots lack superweapon state — init instead of crashing.
  world.superweapons = snap.superweapons ? decodeSuperweaponState(snap.superweapons) : initSuperweapons();
  // v5 snapshots lack upgrades — per the spec they default to {}.
  world.upgrades = decodeUpgrades(snap.upgrades ?? {});
  return world;
}
