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
 * NOVATERRA — sim/utilityNetworks.ts — utility connectivity (grand
 * expansion, Phase 2): integer BFS flood fill over conductor tiles.
 *
 * Responsibilities:
 *  - The derived utility-network model: per player, per utility (power /
 *    water), the conductor flood fill that replaces the Phase-1 global
 *    capacity pool (AD1). Power conductors = roads + powerLines (+
 *    powerSubstation footprints); water conductors = roads + pipes (+
 *    pumpingStation footprints). Plants seed the fill; each connected
 *    component holding at least one online plant is a network with an
 *    id, BFS distance-from-plant per tile, and map-edge contact.
 *  - The "reached" rule: a building is reached when any footprint cell
 *    is a network tile or orthogonally adjacent to one, OR it sits in a
 *    zone region where any region tile is a network tile / adjacent
 *    (zone served → every building inside gets utilities automatically —
 *    the "underground pipes" rule).
 *  - Pollution → water fouling: completed+funded fouling plants
 *    (coal/gas/oil) foul orthogonally-adjacent water sources; each
 *    completed+funded+powered waterTreatment scrubs the nearest fouled
 *    source. Binary, positional, no hidden pressure sim.
 *  - Pure time-of-day / weather helpers: `daylightFactor` (240 sim-second
 *    day; solar is day-only) and `windFactor` (seeded smooth wobble;
 *    wind farms are intermittent). `meltdownOffline` is the tiny seeded
 *    nuclear-meltdown check (pure function of tick+seed+building id).
 *
 * Key invariants:
 *  - DERIVED DATA ONLY — never snapshotted. `getUtilityModel` caches per
 *    (city object identity, utilityEpoch, online-plant key) and rebuilds
 *    deterministically after load. Storage stocks ride on the model keyed
 *    by each network's plant set, so unrelated rebuilds keep their
 *    charge; a save/load resets stocks to 0 (documented limitation).
 *  - Recompute happens on structural change (utilityEpoch, bumped by
 *    every structural command in city.ts) or when the online-plant set
 *    changes (funding, meltdown, cross-utility hooks) — never per tick.
 *  - Deterministic iteration everywhere: sorted arrays, id-ordered
 *    plants, binary search on conductor sets. No RNG draws — the only
 *    "randomness" is the seeded pure meltdown/wind functions.
 *  - This module never imports economy.ts or upgrades.ts (economy owns
 *    the allocation pass and calls in here). No cycles.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import {
  BUILDING_DEFS,
  cellCoords,
  cellIndex,
  footprintCells,
  inBounds,
  zoneAt,
  type BuildingRecord,
  type CityState,
  type ZoneType,
} from './city';

// ---------------------------------------------------------------------------
// Time-of-day / weather / meltdown — pure functions of (tick, seed, id)
// ---------------------------------------------------------------------------

/** One full day/night cycle in sim-seconds (solar output follows this). */
export const DAY_LENGTH_SECONDS = 240;

/**
 * Daylight factor 0..1 for a sim tick. Smooth dawn/dusk: the sine is
 * positive for the day half of the 240-second cycle, clamped to 0 at
 * night. Day starts at dawn (tick 0 = sunrise). The solarFarm's supply
 * is multiplied by this each economy tick.
 * (Transcendental use: Math.sin on a pure function of tick — same input
 * ⇒ same double on every engine, so determinism holds.)
 */
export function daylightFactor(tick: number): number {
  const phase = (tick / 30 / DAY_LENGTH_SECONDS) % 1;
  return Math.max(0, Math.sin(phase * Math.PI * 2));
}

/**
 * Wind factor 0.3..1.0 for an economy-tick index. A seeded smooth
 * wobble (period ~97 sim-seconds, phase from the world seed): wind
 * farms are weak and intermittent, never still, never full blast for
 * long. Pure function of (seed, tick) — no RNG stream is drawn.
 * (Transcendental use documented like daylightFactor above.)
 */
export function windFactor(seed: number, economyTickIndex: number): number {
  const phase = ((seed % 360) * Math.PI) / 180;
  const w = 0.65 + 0.35 * Math.sin((economyTickIndex / 97) * Math.PI * 2 + phase);
  return Math.min(1, Math.max(0.3, w));
}

/** 32-bit integer hash of (seed, buildingId, economyTickIndex). */
function hash32(seed: number, id: number, tick: number): number {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (id >>> 0), 0x85ebca6b);
  h = Math.imul(h ^ (tick >>> 0), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Workstream M (user correction 2026-09-30): nuclear meltdowns happen
 * ONLY when a nuclear plant is attacked — the old per-tick seeded
 * random trigger is gone. When a plant takes attack damage (today: a
 * Storm Engine strike; tomorrow: the building-damage path in combat),
 * call `attackMeltdownRoll`: a seeded hash roll (no RNG draw, fully
 * deterministic). A 1/20 chance per attack keeps meltdowns possible
 * but rare — never a surprise, always earned by the attacker.
 */
export const MELTDOWN_ATTACK_DENOMINATOR = 20;
/** Sim-seconds a melted-down plant stays offline. */
export const MELTDOWN_OFFLINE_SECONDS = 180;

/**
 * True when an attack on this plant triggers a meltdown. Pure function
 * of (seed, building id, tick) — seeded-reproducible, no RNG draws.
 * `advancedNuclear` research quarters the risk (denominator × 4).
 */
export function attackMeltdownRoll(
  seed: number,
  buildingId: number,
  tick: number,
  denominator: number = MELTDOWN_ATTACK_DENOMINATOR,
): boolean {
  return hash32(seed, buildingId, tick) % denominator === 0;
}

/**
 * True while the plant is in a meltdown outage: `meltdownUntilTick` is
 * set by the attack path above; the economy treats the plant as offline
 * until that tick passes. Stored on the building record (snapshotted,
 * digested) — no derived state.
 */
export function isMeltedDown(meltdownUntilTick: number | undefined, tick: number): boolean {
  return tick < (meltdownUntilTick ?? 0);
}

// ---------------------------------------------------------------------------
// Map-edge trade rates (documented engineering choices)
// ---------------------------------------------------------------------------

/** Funds per sim-second per surplus power unit sold at the map edge. */
export const POWER_EXPORT_FUNDS_PER_UNIT = 0.1;
/** Funds per sim-second per surplus water unit sold at the map edge. */
export const WATER_EXPORT_FUNDS_PER_UNIT = 0.08;

// ---------------------------------------------------------------------------
// Model types
// ---------------------------------------------------------------------------

/** Which utility a side model describes. */
export type UtilityKind = 'power' | 'water';

/** One connected network: the unit of supply allocation (AD1). */
export interface NetworkInfo {
  /** Deterministic id: discovery order = lowest seed-plant id first. */
  id: number;
  /** Online plant building ids seeding this network, id order. */
  plantIds: number[];
  /** True when any network tile touches the map edge (auto-export). */
  touchesEdge: boolean;
}

/** How a building is reached by its network. */
export interface ReachedInfo {
  networkId: number;
  /** BFS distance from the nearest seed plant (+1 per adjacency step). */
  distance: number;
}

/** One network member, in draw order (distance, then building id). */
export interface NetworkMember {
  buildingId: number;
  distance: number;
}

/** Per-player, per-utility derived topology. */
export interface UtilitySideModel {
  networks: NetworkInfo[];
  /** buildingId -> reached info, for every completed building of the player. */
  reached: Map<number, ReachedInfo>;
  /** networkId -> members in (distance, buildingId) draw order. */
  networkMembers: Map<number, NetworkMember[]>;
  /** plantId -> networkId, for online plants that joined a network. */
  plantNetwork: Map<number, number>;
  /**
   * Completed demand-building ids reached by NO network, id order —
   * these use the AD2 pool fallback (existing pool allocator).
   */
  unreached: number[];
  /** Online plant ids in no network, id order — the pool's suppliers. */
  poolPlants: number[];
}

/** The full derived model for one city state. */
export interface UtilityModel {
  epoch: number;
  players: Array<{ power: UtilitySideModel; water: UtilitySideModel }>;
  /** Water source building ids fouled after treatment scrubbing, id order. */
  fouledSources: number[];
  /**
   * Storage stocks, keyed `${owner}|${utility}|${plantIdsKey}` where
   * plantIdsKey is the network's sorted seed-plant ids. Keying by plant
   * set (not network id) carries charge across rebuilds whose plant
   * membership is unchanged. Integer units (floored on write).
   */
  stocks: Map<string, number>;
}

/**
 * Per-tick input to the model builder. economy.ts computes the online
 * sets (completion, upkeep funding, cross-utility hooks, meltdown);
 * this module does the topology.
 */
export interface UtilityModelInput {
  /** Per player id: online power-plant building ids, id order. */
  power: number[][];
  /** Per player id: online water-plant building ids, id order. */
  water: number[][];
  /** Completed+funded fouling plant ids (any owner). */
  foulers: number[];
  /** Completed+funded+powered waterTreatment ids (scrub one source each). */
  treatments: number[];
}

// ---------------------------------------------------------------------------
// Sorted-array helpers (same discipline as city.ts)
// ---------------------------------------------------------------------------

function sortedHas(sorted: number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = sorted[mid] as number;
    if (v === value) return true;
    if (v < value) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Merge sorted arrays into one sorted, deduplicated array. */
function mergeSorted(arrays: number[][]): number[] {
  const out: number[] = [];
  const idx = arrays.map(() => 0);
  for (;;) {
    let best = -1;
    let bestVal = 0;
    for (let a = 0; a < arrays.length; a++) {
      const arr = arrays[a] as number[];
      const i = idx[a] as number;
      if (i < arr.length) {
        const v = arr[i] as number;
        if (best === -1 || v < bestVal) {
          best = a;
          bestVal = v;
        }
      }
    }
    if (best === -1) break;
    if (out.length === 0 || out[out.length - 1] !== bestVal) out.push(bestVal);
    idx[best] = (idx[best] as number) + 1;
  }
  return out;
}

/** Orthogonal neighbor cells of a cell (in-bounds only). */
function orthogonalNeighbors(cell: number): number[] {
  const { cx, cz } = cellCoords(cell);
  const out: number[] = [];
  if (cx > 0) out.push(cell - 1);
  if (cx < 255) out.push(cell + 1);
  if (cz > 0) out.push(cell - 256);
  if (cz < 255) out.push(cell + 256);
  return out;
}

/** True when the cell touches the map edge. */
function isEdgeCell(cell: number): boolean {
  const { cx, cz } = cellCoords(cell);
  return cx === 0 || cz === 0 || cx === 255 || cz === 255;
}

// ---------------------------------------------------------------------------
// Zone regions (structural; cached per utilityEpoch)
// ---------------------------------------------------------------------------

interface ZoneRegion {
  zone: ZoneType;
  cells: number[];
}

let regionCache: {
  city: CityState;
  epoch: number;
  regions: ZoneRegion[];
  cellToRegion: Map<number, number>;
} | null = null;

/**
 * Connected components of same-type painted cells (4-way). A region is
 * "served" when any of its cells is a network tile or adjacent to one —
 * then every building inside gets utilities automatically (the
 * "underground pipes" rule). Cached per utilityEpoch: paint commands are
 * the only writers.
 */
function getZoneRegions(city: CityState): {
  regions: ZoneRegion[];
  cellToRegion: Map<number, number>;
} {
  if (regionCache && regionCache.city === city && regionCache.epoch === city.utilityEpoch) {
    return regionCache;
  }
  const regions: ZoneRegion[] = [];
  const cellToRegion = new Map<number, number>();
  const visited = new Set<number>();
  for (const zrec of city.zones) {
    if (visited.has(zrec.cell)) continue;
    const cells: number[] = [];
    const queue: number[] = [zrec.cell];
    visited.add(zrec.cell);
    while (queue.length > 0) {
      const c = queue.pop() as number;
      cells.push(c);
      for (const n of orthogonalNeighbors(c)) {
        if (visited.has(n)) continue;
        if (zoneAt(city, n) === zrec.zone) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    cells.sort((a, b) => a - b);
    const idx = regions.length;
    for (const c of cells) cellToRegion.set(c, idx);
    regions.push({ zone: zrec.zone, cells });
  }
  regionCache = { city, epoch: city.utilityEpoch, regions, cellToRegion };
  return regionCache;
}

// ---------------------------------------------------------------------------
// Model builder
// ---------------------------------------------------------------------------

let modelCache: { city: CityState; key: string; model: UtilityModel } | null = null;

/** Cache key: everything the builder reads that the epoch doesn't cover. */
function modelKey(city: CityState, input: UtilityModelInput): string {
  const parts: string[] = [`e${city.utilityEpoch}`];
  for (let p = 0; p < city.players.length; p++) {
    parts.push(`p${p}=${(input.power[p] ?? []).join(',')}`);
    parts.push(`w${p}=${(input.water[p] ?? []).join(',')}`);
  }
  parts.push(`f=${input.foulers.join(',')}`);
  parts.push(`t=${input.treatments.join(',')}`);
  // Completed substation/pumping-station footprints conduct; completion
  // advances per tick (not per command), so their ids join the key.
  const conductorIds: number[] = [];
  for (const b of city.buildings) {
    if (b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def.conductsPower || def.conductsWater) conductorIds.push(b.id);
  }
  parts.push(`c=${conductorIds.join(',')}`);
  return parts.join(';');
}

/**
 * The derived utility-network model for a city. Cached per (city,
 * utilityEpoch, online-plant key); rebuilt deterministically on miss
 * (including after save/load, which swaps the CityState object).
 * Storage stocks carry over across rebuilds via plant-set keys.
 */
export function getUtilityModel(city: CityState, input: UtilityModelInput): UtilityModel {
  const key = modelKey(city, input);
  if (modelCache && modelCache.city === city && modelCache.key === key) {
    return modelCache.model;
  }
  const model = buildModel(city, input);
  // Carry storage stocks across the rebuild: keys are plant-set based,
  // so networks with unchanged membership keep their charge.
  if (modelCache && modelCache.city === city) {
    for (const [k, v] of modelCache.model.stocks) {
      if (!model.stocks.has(k)) model.stocks.set(k, v);
    }
  }
  modelCache = { city, key, model };
  return model;
}

function buildModel(city: CityState, input: UtilityModelInput): UtilityModel {
  const { regions, cellToRegion } = getZoneRegions(city);
  const players: Array<{ power: UtilitySideModel; water: UtilitySideModel }> = [];
  for (let p = 0; p < city.players.length; p++) {
    players.push({
      power: buildSide(city, p, 'power', input.power[p] ?? [], regions, cellToRegion),
      water: buildSide(city, p, 'water', input.water[p] ?? [], regions, cellToRegion),
    });
  }
  return {
    epoch: city.utilityEpoch,
    players,
    fouledSources: computeFouledSources(city, input.foulers, input.treatments),
    stocks: new Map(),
  };
}

/** Footprint cells of completed conductor buildings for a utility. */
function conductorFootprints(city: CityState, utility: UtilityKind): number[] {
  const cells: number[] = [];
  for (const b of city.buildings) {
    if (b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    if ((utility === 'power' && def.conductsPower) || (utility === 'water' && def.conductsWater)) {
      cells.push(...footprintCells(b.cx, b.cz, def.footprintW, def.footprintH));
    }
  }
  cells.sort((a, b) => a - b);
  return cells;
}

function buildSide(
  city: CityState,
  owner: number,
  utility: UtilityKind,
  onlinePlantIds: number[],
  regions: ZoneRegion[],
  cellToRegion: Map<number, number>,
): UtilitySideModel {
  // 1. Conductor tiles: roads + lines/pipes + substation/pumping footprints.
  // Phase 4 (S7): roads are RoadCell[] now — project to cells (every
  // road class conducts, like before; still sorted by cell).
  const conductors = mergeSorted([
    city.roads.map((r) => r.cell),
    utility === 'power' ? city.powerLines : city.pipes,
    conductorFootprints(city, utility),
  ]);

  const byId = new Map<number, BuildingRecord>();
  for (const b of city.buildings) byId.set(b.id, b);

  // 2. Networked plants: online plants touching the conductor graph
  // (footprint cell is a conductor, or orthogonally adjacent to one).
  // Unfunded plants dropped out before the flood (they're not online).
  const networked: BuildingRecord[] = [];
  for (const pid of onlinePlantIds) {
    const b = byId.get(pid);
    if (!b) continue;
    const def = BUILDING_DEFS[b.kind];
    const cells = footprintCells(b.cx, b.cz, def.footprintW, def.footprintH);
    let touches = false;
    for (const c of cells) {
      if (sortedHas(conductors, c)) {
        touches = true;
        break;
      }
      for (const n of orthogonalNeighbors(c)) {
        if (sortedHas(conductors, n)) {
          touches = true;
          break;
        }
      }
      if (touches) break;
    }
    if (touches) networked.push(b);
  }

  // 3. Flood fill: components over (conductors ∪ networked-plant
  // footprints), discovered in plant-id order for deterministic ids.
  const walkable = new Set<number>(conductors);
  for (const b of networked) {
    const def = BUILDING_DEFS[b.kind];
    for (const c of footprintCells(b.cx, b.cz, def.footprintW, def.footprintH)) walkable.add(c);
  }
  const visited = new Set<number>();
  const networks: NetworkInfo[] = [];
  // tile -> { networkId, distance-from-nearest-seed-plant }
  const tileInfo = new Map<number, { networkId: number; distance: number }>();
  const plantNetwork = new Map<number, number>();
  for (const seed of networked) {
    const def = BUILDING_DEFS[seed.kind];
    const seedCells = footprintCells(seed.cx, seed.cz, def.footprintW, def.footprintH);
    if (seedCells.every((c) => visited.has(c))) continue;
    // Pass 1: collect the component and its member plants.
    const tiles: number[] = [];
    const memberPlants: BuildingRecord[] = [];
    const queue: number[] = [];
    for (const c of seedCells) {
      if (!visited.has(c) && walkable.has(c)) {
        visited.add(c);
        queue.push(c);
      }
    }
    while (queue.length > 0) {
      const c = queue.pop() as number;
      tiles.push(c);
      for (const n of orthogonalNeighbors(c)) {
        if (!visited.has(n) && walkable.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    const tileSet = new Set(tiles);
    for (const b of networked) {
      const bdef = BUILDING_DEFS[b.kind];
      const bcells = footprintCells(b.cx, b.cz, bdef.footprintW, bdef.footprintH);
      if (bcells.some((c) => tileSet.has(c))) memberPlants.push(b);
    }
    // Pass 2: multi-source BFS from all member plants' footprints for
    // true distance-from-nearest-plant.
    const dist = new Map<number, number>();
    const dqueue: number[] = [];
    for (const b of memberPlants) {
      const bdef = BUILDING_DEFS[b.kind];
      for (const c of footprintCells(b.cx, b.cz, bdef.footprintW, bdef.footprintH)) {
        if (tileSet.has(c) && !dist.has(c)) {
          dist.set(c, 0);
          dqueue.push(c);
        }
      }
    }
    let head = 0;
    while (head < dqueue.length) {
      const c = dqueue[head++] as number;
      const d = dist.get(c) as number;
      for (const n of orthogonalNeighbors(c)) {
        if (tileSet.has(n) && !dist.has(n)) {
          dist.set(n, d + 1);
          dqueue.push(n);
        }
      }
    }
    const id = networks.length;
    let touchesEdge = false;
    for (const c of tiles) {
      tileInfo.set(c, { networkId: id, distance: dist.get(c) as number });
      if (!touchesEdge && isEdgeCell(c)) touchesEdge = true;
    }
    const plantIds = memberPlants.map((b) => b.id); // id order (networked is id-ordered)
    for (const pid of plantIds) plantNetwork.set(pid, id);
    networks.push({ id, plantIds, touchesEdge });
  }

  // 4. Per-region best network: the region is served when any region
  // cell is a network tile or adjacent to one.
  const regionBest: Array<{ networkId: number; distance: number } | null> = regions.map(() => null);
  const distToSide = (cell: number): { networkId: number; distance: number } | null => {
    const t = tileInfo.get(cell);
    if (t) return t;
    let best: { networkId: number; distance: number } | null = null;
    for (const n of orthogonalNeighbors(cell)) {
      const nt = tileInfo.get(n);
      if (!nt) continue;
      const cand = { networkId: nt.networkId, distance: nt.distance + 1 };
      if (!best || cand.networkId < best.networkId ||
        (cand.networkId === best.networkId && cand.distance < best.distance)) {
        best = cand;
      }
    }
    return best;
  };
  regions.forEach((region, ri) => {
    let best: { networkId: number; distance: number } | null = null;
    for (const c of region.cells) {
      const cand = distToSide(c);
      if (!cand) continue;
      if (!best || cand.networkId < best.networkId ||
        (cand.networkId === best.networkId && cand.distance < best.distance)) {
        best = cand;
      }
    }
    regionBest[ri] = best;
  });

  // 5. Reached rule per completed building: footprint on/adjacent to a
  // network tile, or inside a served zone region. Joins the lowest
  // network id that reaches it (deterministic).
  const reached = new Map<number, ReachedInfo>();
  const networkMembers = new Map<number, NetworkMember[]>();
  const unreached: number[] = [];
  const demandOf = (b: BuildingRecord): number => {
    const def = BUILDING_DEFS[b.kind];
    return utility === 'power' ? def.powerDemand : def.waterDemand;
  };
  for (const b of city.buildings) {
    if (b.owner !== owner || b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    const cells = footprintCells(b.cx, b.cz, def.footprintW, def.footprintH);
    let bestNetworkId = -1;
    let bestDistance = Infinity;
    // (Written as property updates on locals rather than a reassigned
    // object so TypeScript's flow analysis — which does not see through
    // the closure — keeps the types usable at the use site.)
    const consider = (cand: { networkId: number; distance: number } | null): void => {
      if (!cand) return;
      if (bestNetworkId === -1 ||
        cand.networkId < bestNetworkId ||
        (cand.networkId === bestNetworkId && cand.distance < bestDistance)) {
        bestNetworkId = cand.networkId;
        bestDistance = cand.distance;
      }
    };
    for (const c of cells) consider(distToSide(c));
    // Zone rule: any footprint cell in a served region serves the building.
    for (const c of cells) {
      const ri = cellToRegion.get(c);
      if (ri === undefined) continue;
      const rb = regionBest[ri];
      if (rb) consider({ networkId: rb.networkId, distance: rb.distance + 1 });
    }
    if (bestNetworkId !== -1) {
      const info = { networkId: bestNetworkId, distance: bestDistance };
      reached.set(b.id, info);
      const list = networkMembers.get(bestNetworkId) ?? [];
      list.push({ buildingId: b.id, distance: bestDistance });
      networkMembers.set(bestNetworkId, list);
    } else if (demandOf(b) > 0) {
      unreached.push(b.id);
    }
  }
  // Members in draw order: (distance, buildingId) — no ties possible.
  for (const list of networkMembers.values()) {
    list.sort((a, b) => a.distance - b.distance || a.buildingId - b.buildingId);
  }

  const inNetwork = new Set<number>();
  for (const n of networks) for (const pid of n.plantIds) inNetwork.add(pid);
  const poolPlants = onlinePlantIds.filter((pid) => !inNetwork.has(pid));

  return { networks, reached, networkMembers, plantNetwork, unreached, poolPlants };
}

// ---------------------------------------------------------------------------
// Pollution → water fouling
// ---------------------------------------------------------------------------

/**
 * Binary fouling: completed fouling plants (coal/gas/oil) foul
 * orthogonally-adjacent water sources (foulable). Each treatment
 * (completed+funded+powered, id order) scrubs its nearest fouled
 * source — nearest by Manhattan footprint distance, ties to the lower
 * source id. Returns fouled source ids in id order. No hidden pressure
 * sim: the flag is positional and shown in overlay data.
 */
function computeFouledSources(
  city: CityState,
  foulers: number[],
  treatments: number[],
): number[] {
  const byId = new Map<number, BuildingRecord>();
  for (const b of city.buildings) byId.set(b.id, b);
  // Fouler footprint cells (completed+funded guaranteed by the caller).
  const foulerCells = new Set<number>();
  for (const fid of foulers) {
    const b = byId.get(fid);
    if (!b) continue;
    const def = BUILDING_DEFS[b.kind];
    for (const c of footprintCells(b.cx, b.cz, def.footprintW, def.footprintH)) foulerCells.add(c);
  }
  if (foulerCells.size === 0) return [];
  interface Source { id: number; cells: number[] }
  const sources: Source[] = [];
  for (const b of city.buildings) {
    if (b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    if (!def.foulable || def.waterSupply <= 0) continue;
    const cells = footprintCells(b.cx, b.cz, def.footprintW, def.footprintH);
    let fouled = false;
    for (const c of cells) {
      for (const n of orthogonalNeighbors(c)) {
        if (foulerCells.has(n)) {
          fouled = true;
          break;
        }
      }
      if (fouled) break;
    }
    if (fouled) sources.push({ id: b.id, cells });
  }
  // Scrub: each treatment takes its nearest fouled source (id order).
  const fouledIds = new Set(sources.map((s) => s.id));
  const manhattan = (a: number[], bCells: number[]): number => {
    let best = Infinity;
    for (const ca of a) {
      const { cx: ax, cz: az } = cellCoords(ca);
      for (const cb of bCells) {
        const { cx: bx, cz: bz } = cellCoords(cb);
        const d = Math.abs(ax - bx) + Math.abs(az - bz);
        if (d < best) best = d;
      }
    }
    return best;
  };
  for (const tid of treatments) {
    const t = byId.get(tid);
    if (!t) continue;
    const tdef = BUILDING_DEFS[t.kind];
    const tcells = footprintCells(t.cx, t.cz, tdef.footprintW, tdef.footprintH);
    let bestId = -1;
    let bestDist = Infinity;
    for (const s of sources) {
      if (!fouledIds.has(s.id)) continue;
      const d = manhattan(tcells, s.cells);
      if (d < bestDist || (d === bestDist && s.id < bestId)) {
        bestDist = d;
        bestId = s.id;
      }
    }
    if (bestId !== -1) fouledIds.delete(bestId);
  }
  return [...fouledIds].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Storage accessors (integer stocks on the derived model)
// ---------------------------------------------------------------------------

function stockKey(owner: number, utility: UtilityKind, plantIds: number[]): string {
  return `${owner}|${utility}|${plantIds.join(',')}`;
}

/** Current integer stock of a network (0 when never charged). */
export function getNetworkStock(model: UtilityModel, owner: number, utility: UtilityKind, network: NetworkInfo): number {
  return model.stocks.get(stockKey(owner, utility, network.plantIds)) ?? 0;
}

/**
 * Set a network's integer stock (floored, clamped at 0). Capacity is
 * enforced by the caller (economy tick) from reached storage buildings.
 */
export function setNetworkStock(
  model: UtilityModel,
  owner: number,
  utility: UtilityKind,
  network: NetworkInfo,
  stock: number,
): void {
  model.stocks.set(stockKey(owner, utility, network.plantIds), Math.max(0, Math.floor(stock)));
}

/**
 * Storage capacity of a network: sum of storageCapacity over completed,
 * funded storage buildings of the matching kind reached by the network.
 * `funded` is the economy tick's funded-id set.
 */
export function networkStorageCapacity(
  city: CityState,
  side: UtilitySideModel,
  utility: UtilityKind,
  networkId: number,
  funded: Set<number>,
): number {
  let capacity = 0;
  const members = side.networkMembers.get(networkId) ?? [];
  for (const m of members) {
    if (!funded.has(m.buildingId)) continue;
    const b = city.buildings.find((x) => x.id === m.buildingId);
    if (!b || b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def.storageKind === utility && def.storageCapacity) capacity += def.storageCapacity;
  }
  return capacity;
}
