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
 *    netSave/ in a later step; this module is the versioned unit they
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

import type { EntityRecord, World, SkirmishVictoryKind } from './world';
import { createWorld, isSkirmishVictoryKind } from './world';
import type { RngState } from './rng';
import type { BuildingRecord, CityState, PlayerState } from './city';
import type { RailCell, RoadCell } from './city';
import { migrateRoadsV6ToV7, defaultHangarSlots, DEFAULT_TAX_RATE, BUILDING_DEFS } from './city';
import type { UnitRecord } from './units';
import type { FieldBuild, FieldRequest, FlowField, PathfindingState, PathRequest } from './pathfinding';
import { initPathfinding } from './pathfinding';
import type { AIState } from './ai';
import { encodeAIState, decodeAIState, initAI } from './ai';
import { encodeAgeState, decodeAgeState } from './ages';
import type { DelegationState } from './delegation';
import { encodeDelegationState, decodeDelegationState, initDelegation } from './delegation';
import type { SuperweaponState } from './superweapons';
import { encodeSuperweaponState, decodeSuperweaponState, initSuperweapons } from './superweapons';
import { encodeUpgrades, decodeUpgrades, encodeUpgradeLevels, decodeUpgradeLevels } from './upgrades';
import type { DiplomacyState } from './diplomacy';
import { decodeDiplomacyState } from './diplomacy';
import type { WonderCountdown, WonderRaceKind } from './wonderCountdown';
import type { FogState } from './fog';
import type { DoctrineId } from './doctrine';
import { createFogState, FOG_GRID } from './fog';

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
 * Final-review R2 (2026-10-01): BuildingRecord.hp/maxHp and
 * UnitRecord.buildingTargetId are PURELY ADDITIVE on top of v8 —
 * legacy saves decode hp to the def's full HP and buildingTargetId
 * to 0 (no siege in progress), no version bump (AD9).
 * Grand-expansion Phase 8 (peaceful mode, 2026-09-30): `peaceful` is
 * PURELY ADDITIVE on top of v8 — a plain boolean, no version bump.
 * Older saves (which predate the flag) decode to `false` via
 * `?? false`: no old save was peaceful, so the neutral default is
 * exactly the old behavior. PLAN §11's "no bump" line for this field
 * holds — no shape migration, v5/v6/v7 still load.
 * Roadmap B3 (2026-10-02): `diplomacy` is PURELY ADDITIVE on top of
 * v8 — plain data, no version bump. Older saves decode to a neutral
 * fresh state via decodeDiplomacyState: no old save had diplomacy.
 * Roadmap B25 (2026-10-02): v9 — the pathfinding section drops field
 * internals. `activeBuild` (6×65k mid-flood arrays, ~1.5MB of a typical
 * 1.88MB save) is stored as a slim {fieldId, destCell, unitIds} pending
 * build and re-queued at the FRONT of fieldQueue on restore (its units
 * are already stamped with the field id and keep waiting); each live
 * field's 65k `dirs` array is stored as {id, destCell} and rebuilt on
 * load by `rebuildFlowFields` (pathfinding.ts — a synchronous full
 * flood per field, at LOAD time where a hitch is acceptable). v5–v8
 * snapshots still load: their full internals decode verbatim (the old
 * shape is preserved, not migrated). Deterministic: the rebuild is a
 * pure function of (terrain, roads, destCell); see rebuildFlowFields
 * for the fidelity argument (no live unit can query a truncated cell).
 * Digest note: a v9-restored world digests its REBUILT fields, so
 * digestWorld(restored) can differ from digestWorld(world-at-save)
 * when flow fields were live — the old "restore preserves the digest
 * exactly" pin now holds only for worlds with no live fields/builds
 * (the common case, and every existing fixture). Save/load stays
 * deterministic: two restores of one snapshot digest identically.
 */
export const SNAPSHOT_VERSION = 9;

/** Oldest snapshot version that still loads (v5: paved roads, empty rails; v7: hangars/embark defaults). */
export const OLDEST_SUPPORTED_SNAPSHOT_VERSION = 5;

/**
 * Roadmap B25 (2026-10-02): the v9 pathfinding snapshot shape. Field
 * internals are DERIVED data — the 65k direction arrays and the mid-flood
 * build arrays are dropped here and rebuilt on load (see
 * `rebuildFlowFields` in pathfinding.ts). v8 and earlier snapshots keep
 * the full `PathfindingState` shape and decode verbatim.
 */
export interface SnapshotPathfindingV9 {
  queue: PathRequest[];
  fieldQueue: FieldRequest[];
  /**
   * The in-progress field build at save time, slimmed to its identity:
   * restored to the FRONT of fieldQueue (its units are already stamped
   * with the field id and keep waiting while it rebuilds).
   */
  pendingBuild: { fieldId: number; destCell: number; unitIds: number[] } | null;
  /**
   * Live fields as identities only — `rebuildFlowFields(world, terrain)`
   * (called by the session after restore) fills in the direction grids.
   */
  fields: Array<{ id: number; destCell: number }>;
  nextFieldId: number;
}

/** Type guard: v9+ snapshots carry the slim pathfinding shape. */
export function isSnapshotPathfindingV9(
  pf: PathfindingState | SnapshotPathfindingV9,
): pf is SnapshotPathfindingV9 {
  if (typeof pf !== 'object' || pf === null || !('pendingBuild' in pf)) return false;
  const fields = (pf as SnapshotPathfindingV9).fields;
  if (!Array.isArray(fields)) return false;
  const first: unknown = fields[0];
  return first === undefined || !('dirs' in (first as Record<string, unknown>));
}

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
  /**
   * Pathfinding coordinator state. v9+: the slim `SnapshotPathfindingV9`
   * (field internals dropped, rebuilt on load — roadmap B25). v8 and
   * earlier: the full `PathfindingState`, decoded verbatim.
   */
  pathfinding: PathfindingState | SnapshotPathfindingV9;
  ai: AIState;
  ages: Record<string, unknown>;
  delegation: DelegationState;
  superweapons: SuperweaponState;
  upgrades: Record<number, string[]>;
  /**
   * Grand-expansion Phase 8 (peaceful mode): the world's peaceful flag.
   * Added without a version bump — legacy snapshots predate the field
   * and decode to `false` (no old save was peaceful).
   */
  peaceful: boolean;
  /**
   * Roadmap B2 (2026-10-02): the skirmish victory kind. Added without
   * a version bump — legacy snapshots predate the field and decode to
   * `'conquest'` (no old save played an alternative victory).
   */
  victoryKind: SkirmishVictoryKind;
  /**
   * Roadmap B3 (2026-10-02): the diplomacy state. Added without a
   * version bump — legacy snapshots predate the field and decode to a
   * neutral fresh state (no old save had any diplomacy).
   */
  diplomacy: DiplomacyState;
  /**
   * Fun-audit B2 (2026-10-02): the wonder countdown. Added without a
   * version bump — legacy snapshots predate the field and decode to
   * null (no countdown was ever running in an old save).
   */
  wonderCountdown: WonderCountdown | null;
  /**
   * Fun-audit C3 (2026-10-02): fog-of-war explored memory. Added
   * without a version bump — legacy snapshots predate the field and
   * decode to fresh unexplored (no old save had any fog).
   */
  fog: { cell: number; explored: Record<string, number[]> };
  /**
   * Fun-audit D1 (2026-10-02): per-owner doctrines (owner -> doctrine
   * id). Added without a version bump — legacy snapshots predate the
   * field and decode to {} (no old save had doctrines; unset owners
   * play 'republic').
   */
  doctrines: Record<string, unknown>;
  /**
   * Roadmap B9 (2026-10-02): per-player repeatable-upgrade levels
   * (owner -> upgrade id -> level). Added without a version bump —
   * legacy snapshots predate the field and decode to {} (no old save
   * had any repeatable research).
   */
  upgradeLevels: Record<number, Record<string, number>>;
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

/**
 * Final-review R6 (2026-10-01): thrown when a snapshot parses (valid
 * JSON, accepted version) but its shape is unusable — truncated writes,
 * hand-edited files, or fields of the wrong type. The UI catches this
 * specifically so a broken save shows a friendly "save is broken"
 * message with a way back to the menu instead of the fatal screen.
 */
export class CorruptSaveError extends Error {
  constructor(reason: string) {
    super(`corrupt save snapshot: ${reason}`);
    this.name = 'CorruptSaveError';
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
    // Final-review R2 (2026-10-01): structural HP. ?? def.hp so legacy
    // v5/v6/v7 saves (which lack these fields) decode to full HP — no
    // version bump, stays v8 (the veterancy ?? 0 precedent).
    hp: b.hp ?? BUILDING_DEFS[b.kind].hp,
    maxHp: b.maxHp ?? BUILDING_DEFS[b.kind].hp,
    // Phase 2 utility diagnostics. ?? 'disconnected' so legacy v6 saves
    // (which lack these fields) decode to the honest pre-evaluation
    // state — no version bump, stays v6 (the veterancy ?? 0 precedent).
    powerDiag: b.powerDiag ?? 'disconnected',
    waterDiag: b.waterDiag ?? 'disconnected',
    // Phase 3 logistics stocks. ?? 0 so legacy v6 saves decode to
    // empty depots — no version bump, stays v6 (same precedent).
    ammoStock: b.ammoStock ?? 0,
    fuelStock: b.fuelStock ?? 0,
    // Sea-logistics Half B (2026-10-01): materials stock. AD9 —
    // `?? 0` decode of pre-Half-B saves, no version bump (stays v8).
    materialsStock: b.materialsStock ?? 0,
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
    // Fun-audit C1 (production queues, 2026-10-02): training queue +
    // rally state. Take is faithful (absent stays absent — the
    // discovery precedent); restore deep-copies the entries. Legacy
    // saves decode to no queue / unpaused / no rally (AD9, stays v9).
    trainQueue: b.trainQueue?.map((e) => ({ kind: e.kind, ticksLeft: e.ticksLeft })),
    trainPaused: b.trainPaused,
    rallyX: b.rallyX,
    rallyZ: b.rallyZ,
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
    // Fun-audit B3 (2026-10-02): lifetime peak population — legacy
    // saves decode to 0 (AD9, no version bump).
    peakPopulation: p.peakPopulation ?? 0,
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
    // Grand-expansion Phase 8 (civilian ordinances, workstream E,
    // 2026-09-30): policy toggles copy verbatim (key-ordered object;
    // `policies` is plain data). `fundedPolicies` is NOT copied — it is
    // derived per-tick in the economy pass; the decode side rebuilds it
    // from the next tick's funding decision. Legacy saves (no policies
    // key) decode to {}.
    policies: { ...(p.policies ?? {}) },
    fundedPolicies: [],
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
    // Fun-audit C2c (land-trade deletion, 2026-10-02): trade routes
    // are gone — legacy snapshots carrying them decode by ignoring
    // the field (extra JSON fields are skipped by the decoders).
    // Grand-expansion Phase 5 (S5, 2026-09-30): airline routes.
    // Legacy saves (no field) decode to [] / 1 — AD9 additive, no
    // version bump (stays v8).
    airlineRoutes: (city.airlineRoutes ?? []).map((r) => ({
      id: r.id, owner: r.owner, from: r.from, to: r.to,
      establishedTick: r.establishedTick,
    })),
    nextAirlineRouteId: city.nextAirlineRouteId ?? 1,
    // Civilian sea trade (Half A, 2026-10-01): sea routes. Legacy
    // saves (no field) decode to [] / 1 — AD9 additive, no version
    // bump (stays v8).
    seaRoutes: (city.seaRoutes ?? []).map((r) => ({
      id: r.id, owner: r.owner, from: r.from, to: r.to, policy: r.policy,
      establishedTick: r.establishedTick,
    })),
    nextSeaRouteId: city.nextSeaRouteId ?? 1,
  };
}

function copyUnit(u: UnitRecord): UnitRecord {
  return {
    id: u.id, kind: u.kind, owner: u.owner, x: u.x, z: u.z,
    domain: u.domain, hp: u.hp, cooldownLeft: u.cooldownLeft,
    targetId: u.targetId, chasing: u.chasing,
    // Final-review R2 (2026-10-01): siege target linkage (0 = none).
    // Preserve the field's absence when unset: the save/load
    // round-trip test deep-equals restored units against the originals,
    // and an always-present `buildingTargetId: 0` breaks that for units
    // that never had the field. Readers use `?? 0` (AD9 additive).
    // Check `!== undefined` (not falsiness): 0 is a valid "none" value
    // that must round-trip when the source has it.
    ...(u.buildingTargetId !== undefined ? { buildingTargetId: u.buildingTargetId } : {}),
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
    // Preserve absence (see buildingTargetId above).
    fuel: u.fuel ?? 0, ammo: u.ammo ?? 0,
    ...(u.supplyServices ? { supplyServices: { ...u.supplyServices } } : {}),
    // Phase 3 resupply linkage (0 = none). Preserve absence (see
    // buildingTargetId above) — starting units from some paths lack it.
    ...(u.resupplyDepotId !== undefined ? { resupplyDepotId: u.resupplyDepotId } : {}),
    // Phase 3 per-unit reservation ledger (workstream 3). ?? 0 keeps v6.
    resupplyReservedAmmo: u.resupplyReservedAmmo ?? 0,
    resupplyReservedFuel: u.resupplyReservedFuel ?? 0,
    // Phase 3 cargo holds. ?? 0 so legacy v6 saves decode to empty holds
    // — no version bump, stays v6 (AD9, same precedent as fuel/ammo).
    cargoFuel: u.cargoFuel ?? 0,
    cargoAmmo: u.cargoAmmo ?? 0,
    // Sea-logistics (2026-10-01): the materials hold. ?? 0 so legacy
    // v8 saves decode to an empty hold — no version bump, stays v8
    // (AD9, same precedent as fuel/ammo). spawnUnit always sets it, so
    // round-trips stay exact.
    cargoMaterials: u.cargoMaterials ?? 0,
    // Civilian sea trade (2026-10-01): sea-route assignment.
    // Preserve absence (see buildingTargetId above) — only assigned
    // ships carry these fields.
    ...(u.seaRouteId !== undefined ? { seaRouteId: u.seaRouteId } : {}),
    ...(u.seaRouteLeg !== undefined ? { seaRouteLeg: u.seaRouteLeg } : {}),
    // Phase 4 (S7, v7): the ferry's shipping lane. Preserve absence —
    // see buildingTargetId above (explicit `undefined` breaks the
    // save/load deep-equal).
    ...(u.route ? { route: { ...u.route } } : {}),
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

/**
 * Roadmap B25 (2026-10-02): the v9 pathfinding snapshot — field
 * internals are derived data and stay out of the save. The in-progress
 * build slimms to its identity (re-queued at the front on restore);
 * live fields slim to {id, destCell} (direction grids rebuilt on load
 * by `rebuildFlowFields`). This is what takes a typical save from
 * ~1.88MB to a few hundred KB and kills the ~57ms autosave hitch.
 */
function copyPathfindingV9(pf: PathfindingState): SnapshotPathfindingV9 {
  const build = pf.activeBuild;
  return {
    queue: pf.queue.map(copyPathRequest),
    fieldQueue: pf.fieldQueue.map(copyFieldRequest),
    pendingBuild: build
      ? { fieldId: build.fieldId, destCell: build.destCell, unitIds: [...build.unitIds] }
      : null,
    fields: pf.fields.map((f) => ({ id: f.id, destCell: f.destCell })),
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
    // Roadmap B25 (2026-10-02): v9 drops flow-field internals from the
    // snapshot — rebuilt on load (see copyPathfindingV9 +
    // rebuildFlowFields). v8 and earlier keep the full shape.
    pathfinding: copyPathfindingV9(world.pathfinding),
    ai: encodeAIState(world.ai) as AIState,
    ages: encodeAgeState(world.ages) as Record<string, unknown>,
    delegation: encodeDelegationState(world.delegation) as DelegationState,
    superweapons: encodeSuperweaponState(world.superweapons) as SuperweaponState,
    upgrades: encodeUpgrades(world.upgrades),
    // Roadmap B9: repeatable-upgrade levels (AD9 additive — older
    // snapshots decode to "nothing researched", no version bump).
    upgradeLevels: encodeUpgradeLevels(world.upgradeLevels),
    // Grand-expansion Phase 8 (peaceful mode): faithful copy of the
    // immutable tick-0 flag.
    peaceful: world.peaceful,
    // Roadmap B2: faithful copy of the immutable tick-0 victory kind.
    victoryKind: world.victoryKind,
    // Roadmap B3: faithful copy of the diplomacy state (plain data).
    diplomacy: JSON.parse(JSON.stringify(world.diplomacy)) as DiplomacyState,
    // Fun-audit B2: faithful copy of the wonder countdown (plain data,
    // null when idle).
    wonderCountdown:
      world.wonderCountdown === null || world.wonderCountdown === undefined
        ? null
        : { ...world.wonderCountdown },
    // Fun-audit C3: faithful copy of the explored grids (plain data).
    fog: encodeFogState(world.fog),
    // Fun-audit D1: faithful copy of the per-owner doctrines.
    doctrines: { ...world.doctrines },
  };
}

/**
 * Rebuild a world from a snapshot. The result shares no references with the
 * snapshot. Throws SnapshotVersionError on version mismatch. v5/v6/v7/v8
 * snapshots still load: per the spec, old saves default upgrades to {},
 * v6 roads migrate to paved RoadCells (migrateRoadsV6ToV7), rails
 * default to [], ferry routes default to undefined, and v8's hangar
 * fields decode to their AD9 defaults (legacy airfields → 6 generic
 * slots via defaultHangarSlots, other buildings → undefined, units →
 * hangarBuildingId/embarkedOn 0).
 * Grand-expansion Phase 8 (peaceful mode): the world's peaceful flag
 * decodes via `?? false` — pre-flag saves were never peaceful, so the
 * neutral default reproduces the old behavior exactly (no version bump).
 */
export function restoreSnapshot(snap: Snapshot): World {
  if (snap === null || typeof snap !== 'object') {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap);
  }
  if (snap.version !== SNAPSHOT_VERSION && snap.version !== 8 && snap.version !== 7 && snap.version !== 6 && snap.version !== 5) {
    throw new SnapshotVersionError(SNAPSHOT_VERSION, snap.version);
  }
  // Final-review R6 (2026-10-01): a malformed-but-readable snapshot
  // must surface as CorruptSaveError (graceful "save is broken" UI),
  // never as a raw TypeError escaping into the fatal screen.
  try {
    return restoreSnapshotInner(snap);
  } catch (err) {
    if (err instanceof SnapshotVersionError || err instanceof CorruptSaveError) throw err;
    throw new CorruptSaveError(err instanceof Error ? err.message : String(err));
  }
}

function restoreSnapshotInner(snap: Snapshot): World {
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
  //
  // Roadmap B25 (2026-10-02): v9 snapshots carry the slim pathfinding
  // shape (SnapshotPathfindingV9) — the in-progress build is re-queued
  // at the FRONT of fieldQueue (its units are already stamped with its
  // field id and keep waiting while it rebuilds over the next ticks),
  // and live fields restore as identities with EMPTY direction grids.
  // The session calls `rebuildFlowFields(world, terrain)` right after
  // restore (it owns the terrain) — a restored world must not tick
  // until that runs. v8 and earlier snapshots keep the full internals
  // and decode verbatim via copyPathfinding.
  if (!snap.pathfinding) {
    world.pathfinding = initPathfinding();
  } else if (snap.version >= 9 && isSnapshotPathfindingV9(snap.pathfinding)) {
    const v9 = snap.pathfinding;
    world.pathfinding = {
      queue: v9.queue.map(copyPathRequest),
      fieldQueue: [
        ...(v9.pendingBuild
          ? [
              {
                fieldId: v9.pendingBuild.fieldId,
                destCell: v9.pendingBuild.destCell,
                unitIds: [...v9.pendingBuild.unitIds],
              },
            ]
          : []),
        ...v9.fieldQueue.map(copyFieldRequest),
      ],
      activeBuild: null,
      fields: v9.fields.map((f) => ({ id: f.id, destCell: f.destCell, dirs: [] as number[] })),
      nextFieldId: v9.nextFieldId,
    };
  } else if (snap.version >= 9) {
    // Corrupt v9 pathfinding shape — init instead of crashing (the
    // hand-built snapshot precedent).
    world.pathfinding = initPathfinding();
  } else {
    world.pathfinding = copyPathfinding(snap.pathfinding as PathfindingState);
  }
  // Defensive: older snapshots lack AI state — init instead of crashing.
  world.ai = snap.ai ? decodeAIState(snap.ai) : initAI();
  // Defensive: older snapshots lack age state — init instead of crashing.
  // Per-side ages (2026-10-01, roadmap A1): the owner ids come from the
  // already-decoded city — legacy world-global snapshots assign their
  // one age state to every current owner (AD9 additive, no version bump).
  const ageOwners = world.city.players.map((pl) => pl.id);
  world.ages = snap.ages ? decodeAgeState(snap.ages, ageOwners) : {};
  // Defensive: older snapshots lack delegation state — init instead of crashing.
  world.delegation = snap.delegation ? decodeDelegationState(snap.delegation) : initDelegation();
  // Defensive: older snapshots lack superweapon state — init instead of crashing.
  world.superweapons = snap.superweapons ? decodeSuperweaponState(snap.superweapons) : initSuperweapons();
  // v5 snapshots lack upgrades — per the spec they default to {}.
  world.upgrades = decodeUpgrades(snap.upgrades ?? {});
  // Roadmap B9: pre-B9 snapshots lack upgradeLevels — decode to {}
  // (AD9 neutral default, no version bump).
  world.upgradeLevels = decodeUpgradeLevels(snap.upgradeLevels ?? {});
  // Grand-expansion Phase 8 (peaceful mode): pre-flag snapshots
  // decode to false — no old save was peaceful (AD9 neutral default,
  // no version bump). A hand-built snapshot without the field (e.g.
  // the legacy fixtures in sim.snapshot.test.ts) behaves identically.
  world.peaceful = snap.peaceful ?? false;
  // Roadmap B2: pre-kind snapshots decode to 'conquest' — no old save
  // played an alternative victory (AD9 neutral default, no version
  // bump). Defensive against corrupt values too: anything outside the
  // kind union falls back to conquest rather than crashing.
  world.victoryKind = isSkirmishVictoryKind(snap.victoryKind)
    ? snap.victoryKind
    : 'conquest';
  // Roadmap B3: pre-diplomacy snapshots decode to a neutral fresh
  // state — no old save had any diplomacy (AD9 neutral default, no
  // version bump). decodeDiplomacyState is defensive against corrupt
  // values too.
  world.diplomacy = decodeDiplomacyState(snap.diplomacy);
  // Fun-audit B2: pre-countdown snapshots decode to null — no old save
  // had a countdown running (AD9 neutral default, no version bump).
  // Defensive against corrupt values: kind must be a race kind, leader
  // a finite owner id, endsAtTick a finite tick.
  world.wonderCountdown = decodeWonderCountdown(snap.wonderCountdown);
  // Fun-audit C3: pre-fog snapshots decode to fresh unexplored — no
  // old save had any fog (AD9 neutral default, no version bump).
  world.fog = decodeFogState(snap.fog);
  // Fun-audit D1: pre-doctrine snapshots decode to {} — no old save
  // had doctrines; unset owners play 'republic' (AD9 neutral default,
  // no version bump). Defensive: only the two known ids survive.
  world.doctrines = decodeDoctrines(snap.doctrines);
  return world;
}

/**
 * Fun-audit B2 (2026-10-02): defensive decode of the wonder countdown.
 * Anything malformed (or absent) decodes to null — the countdown is
 * purely additive state.
 */
function decodeWonderCountdown(data: unknown): WonderCountdown | null {
  if (data === null || data === undefined) return null;
  if (typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const kind = d['kind'];
  if (kind !== 'economic' && kind !== 'population' && kind !== 'monument') return null;
  const leader = d['leader'];
  const endsAtTick = d['endsAtTick'];
  if (typeof leader !== 'number' || !Number.isFinite(leader)) return null;
  if (typeof endsAtTick !== 'number' || !Number.isFinite(endsAtTick)) return null;
  return {
    kind: kind as WonderRaceKind,
    leader,
    endsAtTick: Math.floor(endsAtTick),
  };
}

/**
 * Fun-audit C3 (2026-10-02): encode the fog explored grids. Plain
 * data — deep copy so the snapshot shares no references with the
 * world (the restoreSnapshot contract).
 */
function encodeFogState(fog: FogState | undefined): { cell: number; explored: Record<string, number[]> } {
  const out: Record<string, number[]> = {};
  if (fog) {
    for (const [owner, flags] of Object.entries(fog.explored)) {
      out[owner] = [...flags];
    }
  }
  return { cell: fog?.cell ?? 0, explored: out };
}

/**
 * Fun-audit C3 (2026-10-02): defensive decode of fog state. Anything
 * malformed (or absent — pre-fog snapshots) decodes to fresh
 * unexplored: a corrupt shroud must never break a load.
 */
function decodeFogState(data: unknown): FogState {
  const fresh = createFogState();
  if (data === null || data === undefined || typeof data !== 'object') return fresh;
  const d = data as Record<string, unknown>;
  const explored = d['explored'];
  if (explored === null || explored === undefined || typeof explored !== 'object') return fresh;
  const gridSize = FOG_GRID * FOG_GRID;
  for (const [ownerKey, flags] of Object.entries(explored as Record<string, unknown>)) {
    const owner = Number(ownerKey);
    if (!Number.isInteger(owner)) continue;
    if (!Array.isArray(flags) || flags.length !== gridSize) continue;
    const clean: number[] = new Array<number>(gridSize);
    let ok = true;
    for (let i = 0; i < gridSize; i++) {
      const v = flags[i];
      if (v !== 0 && v !== 1) {
        ok = false;
        break;
      }
      clean[i] = v as number;
    }
    if (ok) fresh.explored[owner] = clean;
  }
  return fresh;
}

/**
 * Fun-audit D1 (2026-10-02): defensive decode of the per-owner
 * doctrines. Anything malformed (or absent) decodes to {} — unset
 * owners play 'republic' via getDoctrine, the AD9 neutral default.
 */
function decodeDoctrines(data: unknown): Record<number, DoctrineId> {
  const out: Record<number, DoctrineId> = {};
  if (data === null || data === undefined || typeof data !== 'object') return out;
  for (const [ownerKey, id] of Object.entries(data as Record<string, unknown>)) {
    const owner = Number(ownerKey);
    if (!Number.isInteger(owner)) continue;
    if (id === 'republic' || id === 'kestrel') out[owner] = id;
  }
  return out;
}
