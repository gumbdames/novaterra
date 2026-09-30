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
 * NOVATERRA — render/cityLife.ts — ambient city life (workstream P,
 * grand expansion, 0.1 Alpha).
 *
 * Purpose: make a living city feel alive with ZERO gameplay impact.
 * Three pieces, all render-side only:
 *
 *  1. `PavingOverlay` — painting a zone auto-paves its tiles with a
 *     concrete/pavement ground treatment (terrain-draped decal, one draw
 *     call; roads still build on top, above the paving layer).
 *  2. `AmbientCrowd` — purely visual pedestrians wandering paved zone
 *     tiles and simple cars driving on roads. Density scales with the
 *     city's population: a booming residential area visibly bustles,
 *     an empty zone does not. Pedestrians stream toward commercial and
 *     industrial tiles (direction bias by zone type — cosmetic only).
 *     Nothing for the player to manage, ever.
 *  3. Ambient transit hooks — population-scaled target counts for
 *     buses, trams, ferries, and airliners. Phases 4–6 wire real
 *     vehicle providers into `registerAmbientTransitProvider`; the
 *     density targets and the render path are already here (see
 *     "Transit hooks" below and PLAN.md §9 Phases 4–6).
 *
 * HARD RULES (pinned by tests in game/tests/render.cityLife.test.ts):
 *  - Render-side ONLY: no sim state, no commands, no unit/building
 *    records, never selectable, never in the digest or snapshot.
 *    Poses are pure functions of (seed, agent index, tick) — no
 *    per-agent state, so pause/seek/rebuild can never desync them.
 *  - Deterministic: same seed ⇒ same bustle, byte-identical poses.
 *  - No Math.random, no Date.now anywhere. All variation comes from
 *    32-bit integer hashes (the render/nature.ts pattern).
 *  - Draw calls: paving 0–1, pedestrians 0–1 (capsules) or 0–4 (one
 *    per civilian person variant once their GLBs lazy-load —
 *    render/people.ts), cars 0–1, one per registered transit type
 *    (0 until a phase registers a provider).
 *    Per-frame CPU is O(agents) matrix writes (capped; measured below).
 *
 * Import-safe under Node/vitest (`three` core has no DOM at import;
 * `sim/city` is headless-safe).
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import {
  BUILDING_DEFS,
  CELL_WORLD_SIZE,
  ZoneType,
  cellCenterWorld,
  cellCoords,
  cellIndex,
} from '../sim/city';
import { ROAD_CLASS_ORDER } from '../sim/city';
import type { RoadCell } from '../sim/city';
import type { World } from '../sim/world';
import { surfaceTexture } from './surfaceTextures';
import { zoneDigest, type ZoneAssignment } from './zoneOverlay';
import {
  PERSON_MODEL_KEYS,
  PERSON_VARIANT_CAPACITY,
  buildPersonVariantGeometry,
  personVariantForIndex,
} from './people';
import type { LoadedModel } from './models';

// ---------------------------------------------------------------------------
// Deterministic hashing (the nature.ts pattern: integer math, [0, 1))
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-bit hash → [0, 1). Pure function of
 * (seed, index, salt); identical inputs give identical outputs on every
 * platform (all ops are 32-bit integer math).
 */
export function ambientHash(seed: number, index: number, salt: number): number {
  let h = (seed >>> 0) ^ Math.imul(index | 0, 374761393) ^ Math.imul(salt | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------
// 1. Auto-paved zones
// ---------------------------------------------------------------------------

/**
 * Paving offset above the terrain surface (the draped path). Sits above
 * the zone decals (+0.05) so the pavement treatment reads over the zone
 * wash, and below the road ribbons (+0.08) so roads stay readable when
 * built on top of zones.
 */
export const PAVING_TERRAIN_OFFSET = 0.07;
/** Paving decal transparency — the zone tint shows through. */
export const PAVING_OPACITY = 0.4;
/** UV tiling: one concrete texture tile per this many world units. */
export const PAVING_UV_WORLD_SCALE = 0.25;
/** Flat paving height when the renderer has no terrain (headless). */
export const PAVING_Y = 0.07;

/** Minimal quad-list mesh builder: positions + up normals + uvs + indices. */
class PavingQuadList {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  /**
   * Axis-aligned paving quad for one zone cell, centered at (cx, cz).
   * Corners drape on the height callback (+ offset) — adjacent cells
   * share exact corner coordinates, so the wash never cracks (the
   * zoneOverlay.ts pattern). Without the callback the quad stays flat
   * at `PAVING_Y`. UVs are in texture-tile units (world * scale) with
   * RepeatWrapping on the shared concrete texture.
   */
  quad(cx: number, cz: number, heightAt?: (x: number, z: number) => number): void {
    const base = this.positions.length / 3;
    const half = CELL_WORLD_SIZE / 2;
    const x0 = cx - half;
    const x1 = cx + half;
    const z0 = cz - half;
    const z1 = cz + half;
    const y00 = heightAt !== undefined ? heightAt(x0, z0) + PAVING_TERRAIN_OFFSET : PAVING_Y;
    const y10 = heightAt !== undefined ? heightAt(x1, z0) + PAVING_TERRAIN_OFFSET : PAVING_Y;
    const y01 = heightAt !== undefined ? heightAt(x0, z1) + PAVING_TERRAIN_OFFSET : PAVING_Y;
    const y11 = heightAt !== undefined ? heightAt(x1, z1) + PAVING_TERRAIN_OFFSET : PAVING_Y;
    this.positions.push(x0, y00, z0, x1, y10, z0, x0, y01, z1, x1, y11, z1);
    for (let i = 0; i < 4; i++) this.normals.push(0, 1, 0);
    this.uvs.push(
      x0 * PAVING_UV_WORLD_SCALE, z0 * PAVING_UV_WORLD_SCALE,
      x1 * PAVING_UV_WORLD_SCALE, z0 * PAVING_UV_WORLD_SCALE,
      x0 * PAVING_UV_WORLD_SCALE, z1 * PAVING_UV_WORLD_SCALE,
      x1 * PAVING_UV_WORLD_SCALE, z1 * PAVING_UV_WORLD_SCALE,
    );
    // Winding (a,c,b),(b,c,d): counter-clockwise seen from +y, same as
    // the terrain mesher and the zone decals.
    this.indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.positions), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.normals), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uvs), 2));
    geo.setIndex(this.indices);
    geo.computeBoundingSphere();
    return geo;
  }
}

/**
 * One merged paving quad per zoned cell (all three zone types are
 * paved). Pure: same assignments (in any caller order — emission is
 * sorted by cell) ⇒ byte-identical geometry.
 */
export function buildPavingGeometry(
  zones: ReadonlyArray<ZoneAssignment>,
  heightAt?: (x: number, z: number) => number,
): THREE.BufferGeometry | null {
  const quads = new PavingQuadList();
  const ordered = [...zones].sort((a, b) => a.cell - b.cell);
  for (const z of ordered) {
    const { cx, cz } = cellCoords(z.cell);
    quads.quad(cellCenterWorld(cx), cellCenterWorld(cz), heightAt);
  }
  if (quads.positions.length === 0) return null;
  return quads.build();
}

const EMPTY_ZONES: ReadonlyArray<ZoneAssignment> = [];

/**
 * The auto-paving overlay. Owned by `EntityRenderer` (created in its
 * constructor, synced in `sync()`, disposed in `dispose()`); reads
 * `world.city.zones` directly. Rebuilds ONLY when the zone digest
 * changes — paving is static almost every frame, so the common path is
 * a single integer compare. Visible by default (painting a zone paves
 * it — that is the whole point).
 */
export class PavingOverlay {
  private readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private lastDigest = -1;
  /** Rebuild counter (test/debug hook — the node-stability proof). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene) {
    this.group.name = 'paving';
    scene.add(this.group);
  }

  /** Rebuild the paving mesh only when the zone digest changed. */
  sync(zones: ReadonlyArray<ZoneAssignment> | undefined, heightAt?: (x: number, z: number) => number): void {
    const list = zones ?? EMPTY_ZONES;
    const digest = zoneDigest(list);
    if (digest === this.lastDigest) return;
    this.lastDigest = digest;
    this.rebuilds += 1;
    if (this.mesh !== null) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    if (list.length === 0) return;
    const geo = buildPavingGeometry(list, heightAt);
    if (geo === null) return; // unreachable (list is non-empty), keeps TS honest
    const mat = new THREE.MeshBasicMaterial({
      map: surfaceTexture('concrete'),
      transparent: true,
      opacity: PAVING_OPACITY,
      depthWrite: false,
      // Belt-and-braces against z-fighting with the zone-tint decal
      // below (renderOrder 2 already draws paving after it).
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    // Shared concrete texture is caller-owned (cached in
    // surfaceTextures.ts) — only the geometry and this material are
    // released in dispose().
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.group.add(this.mesh);
  }

  /** Visible paving meshes = draw calls this frame (0 or 1). */
  drawCallCount(): number {
    return this.mesh !== null ? 1 : 0;
  }

  /** Rebuilds since construction (test hook). */
  debugRebuildCount(): number {
    return this.rebuilds;
  }

  /** Last digest synced (test hook). */
  debugDigest(): number {
    return this.lastDigest;
  }

  /** The live material (test hook — ownership stays with the overlay). */
  materialForTests(): THREE.MeshBasicMaterial | null {
    return this.mesh !== null ? (this.mesh.material as THREE.MeshBasicMaterial) : null;
  }

  dispose(): void {
    if (this.mesh !== null) {
      this.group.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
      this.mesh = null;
    }
    this.group.parent?.remove(this.group);
  }
}

// ---------------------------------------------------------------------------
// 2. Population-driven ambient density
// ---------------------------------------------------------------------------

/**
 * The city's population: residents housed by completed residential
 * buildings (def.population on houses/apartment blocks). Read-only —
 * the render layer never writes this, it only reads it to size the
 * bustle. Under-construction housing is not occupied.
 */
export function ambientCityPopulation(world: World): number {
  let pop = 0;
  for (const b of world.city.buildings) {
    if (b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def === undefined) continue;
    if (def.zone === ZoneType.RESIDENTIAL) pop += def.population;
  }
  return pop;
}

/** Hard cap: ambient pedestrians never exceed this (frame budget). */
export const MAX_AMBIENT_PEDESTRIANS = 500;
/** Hard cap: ambient cars never exceed this (frame budget). */
export const MAX_AMBIENT_CARS = 150;
/** One ambient walker per this many housed residents. */
export const PEDS_PER_PERSON = 4;
/** One ambient car per this many housed residents. */
export const CARS_PER_PERSON = 20;

/**
 * Pedestrian count for a city population. Linear in population up to
 * the cap: a booming residential area visibly bustles, an empty zone
 * shows nobody. Pure and deterministic.
 */
export function ambientPedestrianCount(cityPop: number): number {
  if (!Number.isFinite(cityPop) || cityPop <= 0) return 0;
  return Math.min(MAX_AMBIENT_PEDESTRIANS, Math.floor(cityPop / PEDS_PER_PERSON));
}

/**
 * Ambient car count for a city population. Linear in population up to
 * the cap. Zero when there is no population (or no roads — see the
 * model builder, which drops cars whose segment scan finds no road).
 */
export function ambientCarCount(cityPop: number): number {
  if (!Number.isFinite(cityPop) || cityPop <= 0) return 0;
  return Math.min(MAX_AMBIENT_CARS, Math.floor(cityPop / CARS_PER_PERSON));
}

// ---------------------------------------------------------------------------
// The ambient agent model (pure builders; poses are pure in (agent, tick))
// ---------------------------------------------------------------------------

/** A paved tile (zone cell center, world coords) walkers can use. */
interface AmbientTile {
  cell: number;
  x: number;
  z: number;
  zone: ZoneType;
}

/**
 * One ambient pedestrian: a ping-pong stroll between a home tile and a
 * target tile. The target is biased by zone type (residential walkers
 * stream toward commercial tiles, commercial walkers toward industrial
 * ones — cosmetic direction bias, no sim meaning). All fields are
 * derived at model build from (seed, index); poses are then a pure
 * function of the tick — the crowd holds NO per-agent state.
 */
export interface PedAgent {
  /** Home tile (grid cell) this walker starts from. */
  cell: number;
  /** Target tile (grid cell); equals `cell` when the walker stays put. */
  targetCell: number;
  homeX: number;
  homeZ: number;
  /** Normalized home→target direction (0,0 when the walker stays put). */
  dirX: number;
  dirZ: number;
  /** Home→target distance (world units); 0 = wanders in place. */
  dist: number;
  /** Tick offset so walkers desynchronize. */
  phase: number;
  /** World units per tick. */
  speed: number;
  /** Side-step sway: amplitude (world), angular freq (rad/tick), phase. */
  wobbleAmp: number;
  wobbleFreq: number;
  wobblePhase: number;
  /** Coat-color palette index (instance color, set at rebuild). */
  coat: number;
}

/** One ambient car: a ping-pong drive along a straight road segment. */
export interface CarAgent {
  /** Segment start (world coords). */
  ax: number;
  az: number;
  /** Normalized start→end direction. */
  dirX: number;
  dirZ: number;
  /** Segment length (world units), always > 0. */
  dist: number;
  /** Tick offset so cars desynchronize. */
  phase: number;
  /** World units per tick. */
  speed: number;
  /** Paint palette index (instance color, set at rebuild). */
  paint: number;
}

export interface AmbientModel {
  /** Rebuild key (zone digest + roads + completed-building ids + seed). */
  digest: number;
  seed: number;
  peds: PedAgent[];
  cars: CarAgent[];
}

/** Pedestrian tile weight by zone: residential streets are the busiest. */
function tileWeight(zone: ZoneType): number {
  if (zone === ZoneType.RESIDENTIAL) return 3;
  if (zone === ZoneType.COMMERCIAL) return 2;
  return 1;
}

/** Destination pool for a walker's home zone (the direction bias). */
function destinationZone(homeZone: ZoneType): ZoneType {
  if (homeZone === ZoneType.RESIDENTIAL) return ZoneType.COMMERCIAL;
  if (homeZone === ZoneType.COMMERCIAL) return ZoneType.INDUSTRIAL;
  return ZoneType.INDUSTRIAL;
}

/** Max home→target stroll reach (Chebyshev cells). */
const PED_TARGET_RADIUS_CELLS = 30;
/** Max straight road scan per car (cells). */
const CAR_SEGMENT_CELLS = 14;
/** Walker speed: ~1.4 world units per sim-second (30 ticks). */
const PED_SPEED_PER_TICK = 1.4 / 30;
/** Car speed: ~6 world units per sim-second. */
const CAR_SPEED_PER_TICK = 6 / 30;

/**
 * Muted coat colors for pedestrians (instance colors — variety without
 * extra draw calls).
 */
export const PED_COAT_COLORS = [
  0x5a6a7a, 0x7a5a4a, 0x4a5a6a, 0x8a8a7a, 0x6a4a5a, 0x9a7a5a, 0x3a4a5a, 0x7a6a8a,
] as const;

/** Muted car paints (instance colors). */
export const CAR_PAINT_COLORS = [
  0x7a8a99, 0xa33b32, 0x3f6ea5, 0xc8c8c8, 0x2f3a45, 0x8a6a3a, 0x5a7a5a,
] as const;

/**
 * Build the ambient agent model: pure function of (zones, roads, seed,
 * population). Deterministic — same inputs ⇒ identical agents. Rebuilt
 * only when the digest changes (zone painted, road built, building
 * completed/demolished); the caller computes that digest with
 * `ambientModelDigest` and stores it on the returned model.
 */
export function buildAmbientModel(
  zones: ReadonlyArray<ZoneAssignment>,
  roads: ReadonlyArray<RoadCell>,
  seed: number,
  cityPop: number,
): AmbientModel {
  // Tile lookup: only the three classic zone types are paved-walkable.
  const tileByCell = new Map<number, AmbientTile>();
  const poolByZone = new Map<ZoneType, AmbientTile[]>();
  const weightedHomes: AmbientTile[] = [];
  for (const z of zones) {
    if (
      z.zone !== ZoneType.RESIDENTIAL &&
      z.zone !== ZoneType.COMMERCIAL &&
      z.zone !== ZoneType.INDUSTRIAL
    ) {
      continue;
    }
    const { cx, cz } = cellCoords(z.cell);
    const tile: AmbientTile = { cell: z.cell, x: cellCenterWorld(cx), z: cellCenterWorld(cz), zone: z.zone };
    tileByCell.set(z.cell, tile);
    let pool = poolByZone.get(z.zone);
    if (pool === undefined) {
      pool = [];
      poolByZone.set(z.zone, pool);
    }
    pool.push(tile);
    const w = tileWeight(z.zone);
    for (let k = 0; k < w; k++) weightedHomes.push(tile);
  }
  const poolCellsByZone = new Map<ZoneType, Set<number>>();
  for (const [zone, pool] of poolByZone) {
    poolCellsByZone.set(zone, new Set(pool.map((t) => t.cell)));
  }

  const peds: PedAgent[] = [];
  const pedCount = ambientPedestrianCount(cityPop);
  for (let i = 0; i < pedCount; i++) {
    if (weightedHomes.length === 0) break;
    const home = weightedHomes[Math.floor(ambientHash(seed, i, 101) * weightedHomes.length)] as AmbientTile;
    // Direction bias: pick a target tile of the destination zone type
    // within PED_TARGET_RADIUS_CELLS of home (window scan, Chebyshev).
    // Falls back to a same-zone tile, then to home itself.
    let targetZone = destinationZone(home.zone);
    let target = pickTargetTile(home, targetZone, tileByCell, poolCellsByZone, seed, i);
    if (target === null) {
      targetZone = home.zone;
      target = pickTargetTile(home, targetZone, tileByCell, poolCellsByZone, seed, i);
    }
    const tx = target !== null ? target.x : home.x;
    const tz = target !== null ? target.z : home.z;
    const dx = tx - home.x;
    const dz = tz - home.z;
    const dist = Math.hypot(dx, dz);
    const speed = PED_SPEED_PER_TICK * (0.8 + 0.5 * ambientHash(seed, i, 104));
    peds.push({
      cell: home.cell,
      targetCell: target !== null ? target.cell : home.cell,
      homeX: home.x,
      homeZ: home.z,
      dirX: dist > 0 ? dx / dist : 0,
      dirZ: dist > 0 ? dz / dist : 0,
      dist,
      phase: ambientHash(seed, i, 102) * 10000,
      speed,
      wobbleAmp: 0.25 + 0.25 * ambientHash(seed, i, 105),
      // wobbleFreq is a transcendental input — documented per the sim
      // AGENTS.md convention (deterministic: same inputs, same value).
      wobbleFreq: 0.02 + 0.03 * ambientHash(seed, i, 106),
      wobblePhase: ambientHash(seed, i, 107) * Math.PI * 2,
      coat: Math.floor(ambientHash(seed, i, 108) * PED_COAT_COLORS.length),
    });
  }

  const cars: CarAgent[] = [];
  const carCount = ambientCarCount(cityPop);
  // Phase 4 (S7): roads are RoadCell[] now — project to cells (ambient
  // cars drive every class the same way).
  const roadCells = roads.map((r) => r.cell);
  const roadSet = new Set<number>(roadCells);
  const sortedRoads = [...roadCells].sort((a, b) => a - b);
  for (let i = 0; i < carCount; i++) {
    if (sortedRoads.length === 0) break;
    const anchor = sortedRoads[Math.floor(ambientHash(seed, i, 201) * sortedRoads.length)] as number;
    // Scan all four directions and drive the longest straight run: a
    // car always has a road to drive on (deterministic tie-break by
    // direction order). Only a lone road cell yields no run at all.
    let best: { ax: number; az: number; bx: number; bz: number } | null = null;
    let bestDist = -1;
    for (let dirIdx = 0; dirIdx < 4; dirIdx++) {
      const seg = scanRoadSegment(anchor, dirIdx, roadSet);
      if (seg === null) continue;
      const d = Math.hypot(seg.bx - seg.ax, seg.bz - seg.az);
      if (d > bestDist) {
        bestDist = d;
        best = seg;
      }
    }
    if (best === null || bestDist <= 0.5) continue; // lone road cell: skip this car
    const seg = best;
    const dx = seg.bx - seg.ax;
    const dz = seg.bz - seg.az;
    const dist = Math.hypot(dx, dz);
    cars.push({
      ax: seg.ax,
      az: seg.az,
      dirX: dx / dist,
      dirZ: dz / dist,
      dist,
      phase: ambientHash(seed, i, 203) * 10000,
      speed: CAR_SPEED_PER_TICK * (0.85 + 0.35 * ambientHash(seed, i, 204)),
      paint: Math.floor(ambientHash(seed, i, 205) * CAR_PAINT_COLORS.length),
    });
  }

  return { digest: 0, seed: seed >>> 0, peds, cars };
}

/**
 * Pick a target tile of `targetZone` within PED_TARGET_RADIUS_CELLS
 * (Chebyshev) of `home`. Window scan over the destination pool's cell
 * set; the hash picks uniformly among in-window candidates. Returns
 * null when no candidate is in reach (caller falls back).
 */
function pickTargetTile(
  home: AmbientTile,
  targetZone: ZoneType,
  tileByCell: Map<number, AmbientTile>,
  poolCellsByZone: Map<ZoneType, Set<number>>,
  seed: number,
  index: number,
): AmbientTile | null {
  const poolCells = poolCellsByZone.get(targetZone);
  if (poolCells === undefined || poolCells.size === 0) return null;
  const { cx: hx, cz: hz } = cellCoords(home.cell);
  const R = PED_TARGET_RADIUS_CELLS;
  const candidates: AmbientTile[] = [];
  for (let dz = -R; dz <= R; dz++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx === 0 && dz === 0) continue;
      const cell = cellIndex(hx + dx, hz + dz);
      if (!poolCells.has(cell)) continue;
      const tile = tileByCell.get(cell);
      if (tile !== undefined) candidates.push(tile);
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(ambientHash(seed, index, 103) * candidates.length)] as AmbientTile;
}

/**
 * Scan a straight road segment from `anchor` in one of four cardinal
 * directions (0=+x, 1=−x, 2=+z, 3=−z), up to CAR_SEGMENT_CELLS cells.
 * Returns the segment endpoints in world coords, or null when the
 * anchor is not a road cell.
 */
function scanRoadSegment(
  anchor: number,
  dirIdx: number,
  roadSet: Set<number>,
): { ax: number; az: number; bx: number; bz: number } | null {
  if (!roadSet.has(anchor)) return null;
  const { cx: ax, cz: az } = cellCoords(anchor);
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const [ddx, ddz] = dirs[dirIdx % 4] as readonly [number, number];
  let bx = ax;
  let bz = az;
  for (let k = 1; k <= CAR_SEGMENT_CELLS; k++) {
    const nx = ax + ddx * k;
    const nz = az + ddz * k;
    if (!roadSet.has(cellIndex(nx, nz))) break;
    bx = nx;
    bz = nz;
  }
  return {
    ax: cellCenterWorld(ax),
    az: cellCenterWorld(az),
    bx: cellCenterWorld(bx),
    bz: cellCenterWorld(bz),
  };
}

/** Pose of one agent on its ping-pong track (shared by peds and cars). */
export interface AgentPose {
  x: number;
  z: number;
  /** Yaw: 0 faces +z (the three.js convention); atan2 of travel dir. */
  yaw: number;
}

/**
 * Pose of a pedestrian at sim tick `tick`. Pure: same (agent, tick) ⇒
 * same pose, forever. The walker ping-pongs home→target→home with a
 * sinusoidal side-step sway (transcendental use, deterministic).
 */
export function pedPoseAt(ped: PedAgent, tick: number): AgentPose {
  if (ped.dist < 0.001) {
    // No target in reach: the walker strolls in place (gentle sway).
    const w = ped.wobbleAmp * Math.sin(tick * ped.wobbleFreq + ped.wobblePhase);
    return { x: ped.homeX + w, z: ped.homeZ, yaw: ped.wobblePhase };
  }
  const cycle = 2 * ped.dist;
  let s = (tick * ped.speed + ped.phase) % cycle;
  if (s < 0) s += cycle;
  const outbound = s < ped.dist;
  const d = outbound ? s : cycle - s;
  const fwd = outbound ? 1 : -1;
  const w = ped.wobbleAmp * Math.sin(tick * ped.wobbleFreq + ped.wobblePhase);
  return {
    x: ped.homeX + ped.dirX * d + -ped.dirZ * w,
    z: ped.homeZ + ped.dirZ * d + ped.dirX * w,
    yaw: Math.atan2(ped.dirX * fwd, ped.dirZ * fwd),
  };
}

/**
 * Pose of a car at sim tick `tick`. Pure: same (agent, tick) ⇒ same
 * pose, forever. Ping-pongs along its road segment, yaw flipping at
 * the turnarounds.
 */
export function carPoseAt(car: CarAgent, tick: number): AgentPose {
  const cycle = 2 * car.dist;
  let s = (tick * car.speed + car.phase) % cycle;
  if (s < 0) s += cycle;
  const outbound = s < car.dist;
  const d = outbound ? s : cycle - s;
  const fwd = outbound ? 1 : -1;
  return {
    x: car.ax + car.dirX * d,
    z: car.az + car.dirZ * d,
    yaw: Math.atan2(car.dirX * fwd, car.dirZ * fwd),
  };
}

/**
 * Rebuild key for the ambient model: zone assignments (the zone
 * digest), road cells, completed-building ids (placement order), and
 * the map seed. Changes when a zone is painted, a road is built or
 * demolished, or a building is placed/completed/demolished; stable
 * otherwise — the crowd rebuilds only on structural change.
 */
export function ambientModelDigest(
  zones: ReadonlyArray<ZoneAssignment>,
  roads: ReadonlyArray<RoadCell>,
  completedBuildingIds: ReadonlyArray<number>,
  seed: number,
): number {
  let h = zoneDigest(zones) | 0;
  for (const c of roads) {
    // Phase 4 (S7): digest the cell AND the class index — a road upgrade
    // changes the ambient layer's rebuild key like any structural change.
    h ^= c.cell | 0;
    h = Math.imul(h, 16777619);
    h ^= ROAD_CLASS_ORDER.indexOf(c.cls) | 0;
    h = Math.imul(h, 16777619);
  }
  for (const id of completedBuildingIds) {
    h ^= id | 0;
    h = Math.imul(h, 16777619);
  }
  h ^= seed | 0;
  h = Math.imul(h, 16777619);
  return h | 0;
}

// ---------------------------------------------------------------------------
// 3. Ambient transit hooks (Phases 4–6 wire the providers in)
// ---------------------------------------------------------------------------

/**
 * Ambient transit types. `bus`/`tram`/`ferry` arrive with Phase 4
 * (transport variety); `airliner` with Phase 5 (airports + airline).
 */
export type AmbientTransitType = 'bus' | 'tram' | 'ferry' | 'airliner';

/** Population-scaled target counts for ambient transit vehicles. */
export interface AmbientTransitDensity {
  bus: number;
  tram: number;
  ferry: number;
  airliner: number;
}

/** Hard caps per transit type (frame budget — same instancing discipline). */
export const MAX_AMBIENT_BUS = 40;
export const MAX_AMBIENT_TRAM = 24;
export const MAX_AMBIENT_FERRY = 12;
export const MAX_AMBIENT_AIRLINER = 8;

/**
 * Desired ambient transit counts for a city population. More people ⇒
 * more ambient transit — buses first, then trams, then ferries, then
 * airliners. Pure and deterministic. The per-type divisor is a Phase-1
 * engineering choice — tune it, keep the tests green.
 *
 * NOTE for Phases 4–6: this function only sizes the bustle. The
 * vehicles themselves come from providers registered via
 * `registerAmbientTransitProvider` (a phase may gate on its own state —
 * e.g. trams only when a tram network exists, ferries only when ferry
 * routes exist, airliners only when a civil airport is built — by
 * returning `count: 0` / `poseAt: () => null` until its conditions hold).
 */
export function ambientTransitDensity(cityPop: number): AmbientTransitDensity {
  const p = Number.isFinite(cityPop) && cityPop > 0 ? Math.floor(cityPop) : 0;
  return {
    bus: Math.min(MAX_AMBIENT_BUS, Math.floor(p / 150)),
    tram: Math.min(MAX_AMBIENT_TRAM, Math.floor(p / 400)),
    ferry: Math.min(MAX_AMBIENT_FERRY, Math.floor(p / 600)),
    airliner: Math.min(MAX_AMBIENT_AIRLINER, Math.floor(p / 2000)),
  };
}

/**
 * A Phase 4+ vehicle provider: renders `count` ambient vehicles of one
 * transit type. Geometry and material are provider-owned (the crowd
 * never disposes them); poses are pure functions of (index, tick) —
 * the same zero-state contract as pedestrians and cars.
 */
export interface AmbientTransitProvider {
  /** Vehicle geometry (shared; the crowd owns only instance attributes). */
  geometry: THREE.BufferGeometry;
  /** Vehicle material (shared). */
  material: THREE.Material;
  /** Desired live count (may gate on the phase's own state). */
  count: number;
  /**
   * Pose of vehicle `index` at sim tick, or null to hide it this frame.
   * Pure in (index, tick) — no state, deterministic.
   */
  poseAt(index: number, tick: number): { x: number; y: number; z: number; yaw: number } | null;
}

const transitProviders = new Map<AmbientTransitType, AmbientTransitProvider>();

/**
 * Register a Phase 4+ ambient transit provider (render-side; the sim
 * never sees these vehicles). Re-registering a type replaces the old
 * provider. See PLAN.md §9 Phase 4/5/6 for the wiring checklist.
 */
export function registerAmbientTransitProvider(
  type: AmbientTransitType,
  provider: AmbientTransitProvider,
): void {
  transitProviders.set(type, provider);
}

/** Remove a transit provider (its instances vanish next sync). */
export function unregisterAmbientTransitProvider(type: AmbientTransitType): void {
  transitProviders.delete(type);
}

/** Registered providers (read-only — test/debug hook). */
export function ambientTransitProviderTypes(): AmbientTransitType[] {
  return [...transitProviders.keys()];
}

// ---------------------------------------------------------------------------
// The ambient crowd (instanced pedestrians + cars + transit providers)
// ---------------------------------------------------------------------------

/** Reusable scratch (no allocation on the per-frame write path). */
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _e = new THREE.Euler();
const _c = new THREE.Color();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

const EMPTY_ASSIGNMENTS: ReadonlyArray<ZoneAssignment> = [];

/** Pedestrian body: a capsule, base at y=0 after the translate. */
function buildPedGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CapsuleGeometry(0.18, 0.6, 3, 8);
  geo.translate(0, 0.48, 0);
  return geo;
}

/** Ambient car: body + cabin merged, base at y=0, forward = +z. */
function buildCarGeometry(): THREE.BufferGeometry {
  const body = new THREE.BoxGeometry(1.6, 0.5, 3.2);
  body.translate(0, 0.45, 0);
  const cabin = new THREE.BoxGeometry(1.4, 0.45, 1.6);
  cabin.translate(0, 0.9, -0.2);
  const merged = mergeGeometries([body, cabin], false);
  body.dispose();
  cabin.dispose();
  if (merged === null) throw new Error('cityLife: car geometry merge failed');
  return merged;
}

/**
 * The ambient crowd: instanced pedestrians and cars, plus one
 * instanced layer per registered transit provider. Owned by
 * `EntityRenderer` (created in its constructor, synced in `sync()`,
 * disposed in `dispose()`).
 *
 * Render-side only: it reads `world.city.zones`, `world.city.roads`,
 * `world.city.buildings`, `world.seed`, and `world.tick` — and writes
 * NOTHING back. Not selectable, not in any entity list, never in the
 * digest/snapshot.
 */
export class AmbientCrowd {
  private readonly group = new THREE.Group();
  private pedMesh: THREE.InstancedMesh | null = null;
  private carMesh: THREE.InstancedMesh | null = null;
  /** One instanced layer per person variant (empty until the GLBs arrive). */
  private personMeshes: THREE.InstancedMesh[] = [];
  private personMat: THREE.MeshStandardMaterial | null = null;
  private transitMeshes = new Map<AmbientTransitType, THREE.InstancedMesh>();
  private model: AmbientModel | null = null;
  private readonly models: Map<string, LoadedModel> | null;
  private lastDigest = -1;
  /** Rebuild counter (test/debug hook). */
  private rebuilds = 0;

  constructor(scene: THREE.Scene, models?: Map<string, LoadedModel>) {
    this.group.name = 'ambient';
    this.models = models ?? null;
    scene.add(this.group);
  }

  /**
   * Rebuild the agent model when the digest changed; every sync,
   * rewrite instance matrices from the tick-derived poses. The world
   * is read-only here — this method never mutates sim state.
   */
  sync(world: World, heightAt?: (x: number, z: number) => number): void {
    const city = world.city;
    const zones = city.zones ?? EMPTY_ASSIGNMENTS;
    const roads = city.roads ?? [];
    const pop = ambientCityPopulation(world);
    const completedIds: number[] = [];
    for (const b of city.buildings) {
      if (b.progress >= 1) completedIds.push(b.id);
    }
    const seed = world.seed >>> 0;
    const digest = ambientModelDigest(zones, roads, completedIds, seed);
    if (digest !== this.lastDigest) {
      this.lastDigest = digest;
      this.rebuilds += 1;
      const model = buildAmbientModel(zones, roads, seed, pop);
      model.digest = digest;
      this.model = model;
      this.applyAgentColors();
    }
    this.maybeBuildPersonLayers();
    this.writePedInstances(world.tick, heightAt);
    this.writeCarInstances(world.tick, heightAt);
    this.writeTransitInstances(world.tick);
  }

  /**
   * Build the per-variant person layers once all four civilian GLBs have
   * lazy-loaded. The map's `get` self-triggers the load on a
   * `LazyModelMap` (production); on a plain `Map` (tests) the keys stay
   * absent and pedestrians keep their capsule fallback forever.
   * All-or-nothing: a partially loaded set keeps capsules — mixing
   * capsules and people would read as a rendering bug.
   */
  private maybeBuildPersonLayers(): void {
    if (this.models === null || this.personMeshes.length > 0) return;
    if (this.model === null || this.model.peds.length === 0) return;
    const geos: THREE.BufferGeometry[] = [];
    for (const key of PERSON_MODEL_KEYS) {
      const loaded = this.models.get(key);
      if (loaded === undefined) return; // still loading (or failed) — retry next sync
      const geo = buildPersonVariantGeometry(loaded);
      if (geo === null) {
        for (const g of geos) g.dispose();
        return; // unusable variant — stay on capsules
      }
      geos.push(geo);
    }
    this.personMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.9,
      metalness: 0,
    });
    // Round-robin assignment ⇒ variant v holds every 4th ped (see
    // PERSON_VARIANT_CAPACITY for the sizing math).
    for (const geo of geos) {
      const mesh = new THREE.InstancedMesh(geo, this.personMat, PERSON_VARIANT_CAPACITY);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.personMeshes.push(mesh);
    }
    // Capsules retire: the crowd is people now. (Crowd-owned geometry —
    // safe to release; the map keeps the source models.)
    this.disposeMesh(this.pedMesh, true);
    this.pedMesh = null;
  }

  /** Visible instance layers = draw calls this frame. */
  drawCallCount(): number {
    let n = 0;
    if (this.pedMesh !== null && this.pedMesh.count > 0) n += 1;
    for (const mesh of this.personMeshes) {
      if (mesh.count > 0) n += 1;
    }
    if (this.carMesh !== null && this.carMesh.count > 0) n += 1;
    for (const mesh of this.transitMeshes.values()) {
      if (mesh.count > 0) n += 1;
    }
    return n;
  }

  /** Rebuilds since construction (test hook). */
  debugRebuildCount(): number {
    return this.rebuilds;
  }

  /** Person variant layers built (test hook). */
  debugPersonLayers(): number {
    return this.personMeshes.length;
  }

  /** Live agent counts (test hook). */
  debugAgentCounts(): { peds: number; cars: number } {
    return {
      peds: this.model !== null ? this.model.peds.length : 0,
      cars: this.model !== null ? this.model.cars.length : 0,
    };
  }

  /** Last digest synced (test hook). */
  debugDigest(): number {
    return this.lastDigest;
  }

  dispose(): void {
    this.disposeMesh(this.pedMesh, true);
    this.pedMesh = null;
    this.disposeMesh(this.carMesh, true);
    this.carMesh = null;
    for (const mesh of this.personMeshes) {
      // Person geometries + the shared vertex-color material are
      // crowd-owned (baked from the map's models at build time).
      this.disposeMesh(mesh, true);
    }
    this.personMeshes = [];
    if (this.personMat !== null) {
      this.personMat.dispose();
      this.personMat = null;
    }
    for (const mesh of this.transitMeshes.values()) {
      // Transit geometry/material are provider-owned — release only
      // the instance attributes.
      this.disposeMesh(mesh, false);
    }
    this.transitMeshes.clear();
    this.group.parent?.remove(this.group);
  }

  /** Instance attributes always; crowd-owned geo/mat only when owned. */
  private disposeMesh(mesh: THREE.InstancedMesh | null, owned: boolean): void {
    if (mesh === null) return;
    this.group.remove(mesh);
    mesh.dispose();
    if (owned) {
      mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) {
        for (const m of mat) m.dispose();
      } else {
        mat.dispose();
      }
    }
  }

  /** Ensure the ped/car meshes exist with capacity for the model. */
  private ensureMeshes(): void {
    const model = this.model;
    if (model === null) return;
    if (model.peds.length > 0 && this.pedMesh === null) {
      const geo = buildPedGeometry();
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
      this.pedMesh = new THREE.InstancedMesh(geo, mat, Math.max(1, model.peds.length));
      this.pedMesh.frustumCulled = false;
      this.group.add(this.pedMesh);
    }
    if (model.cars.length > 0 && this.carMesh === null) {
      const geo = buildCarGeometry();
      const mat = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.4 });
      this.carMesh = new THREE.InstancedMesh(geo, mat, Math.max(1, model.cars.length));
      this.carMesh.frustumCulled = false;
      this.group.add(this.carMesh);
    }
  }

  /** Per-instance coat/paint colors (set at rebuild — they never change). */
  private applyAgentColors(): void {
    const model = this.model;
    if (model === null) return;
    this.ensureMeshes();
    if (this.pedMesh !== null) {
      for (let i = 0; i < model.peds.length; i++) {
        const ped = model.peds[i] as PedAgent;
        _c.setHex(PED_COAT_COLORS[ped.coat % PED_COAT_COLORS.length] as number);
        this.pedMesh.setColorAt(i, _c);
      }
      if (this.pedMesh.instanceColor !== null) this.pedMesh.instanceColor.needsUpdate = true;
    }
    if (this.carMesh !== null) {
      for (let i = 0; i < model.cars.length; i++) {
        const car = model.cars[i] as CarAgent;
        _c.setHex(CAR_PAINT_COLORS[car.paint % CAR_PAINT_COLORS.length] as number);
        this.carMesh.setColorAt(i, _c);
      }
      if (this.carMesh.instanceColor !== null) this.carMesh.instanceColor.needsUpdate = true;
    }
  }

  private writePedInstances(tick: number, heightAt?: (x: number, z: number) => number): void {
    const model = this.model;
    if (model === null) return;
    if (this.personMeshes.length > 0) {
      this.writePersonInstances(tick, heightAt);
      return;
    }
    if (this.pedMesh === null) return;
    const n = model.peds.length;
    this.pedMesh.count = n;
    for (let i = 0; i < n; i++) {
      const ped = model.peds[i] as PedAgent;
      const pose = pedPoseAt(ped, tick);
      const y = heightAt !== undefined ? heightAt(pose.x, pose.z) + 0.02 : 0.02;
      _p.set(pose.x, y, pose.z);
      _e.set(0, pose.yaw, 0);
      _q.setFromEuler(_e);
      const s = 0.9 + 0.25 * ambientHash(model.seed, i, 109);
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      this.pedMesh.setMatrixAt(i, _m);
    }
    this.pedMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Person-variant instance writes: ped `i` renders in variant
   * `personVariantForIndex(i)` at slot `floor(i / 4)`. The authored
   * clothing/skin colors carry the variety (no per-instance tint), and
   * each walker gets a stepping bob — pure in (ped, tick), twice the
   * sway frequency so it reads as footfalls.
   */
  private writePersonInstances(tick: number, heightAt?: (x: number, z: number) => number): void {
    const model = this.model;
    if (model === null) return;
    const n = model.peds.length;
    const variantCount = this.personMeshes.length;
    const slots = new Array<number>(variantCount).fill(0);
    for (let i = 0; i < n; i++) {
      const ped = model.peds[i] as PedAgent;
      const v = personVariantForIndex(i) % variantCount;
      const mesh = this.personMeshes[v] as THREE.InstancedMesh;
      const slot = slots[v] as number;
      slots[v] = slot + 1;
      if (slot >= PERSON_VARIANT_CAPACITY) continue; // capacity guard — never drops the sim, just the sprite
      const pose = pedPoseAt(ped, tick);
      const bob = 0.04 * Math.abs(Math.sin(tick * ped.wobbleFreq * 2 + ped.wobblePhase));
      const y = (heightAt !== undefined ? heightAt(pose.x, pose.z) : 0) + 0.02 + bob;
      _p.set(pose.x, y, pose.z);
      _e.set(0, pose.yaw, 0);
      _q.setFromEuler(_e);
      const s = 0.9 + 0.25 * ambientHash(model.seed, i, 109);
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      mesh.setMatrixAt(slot, _m);
    }
    for (let v = 0; v < variantCount; v++) {
      const mesh = this.personMeshes[v] as THREE.InstancedMesh;
      mesh.count = slots[v] as number;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private writeCarInstances(tick: number, heightAt?: (x: number, z: number) => number): void {
    const model = this.model;
    if (model === null || this.carMesh === null) return;
    const n = model.cars.length;
    this.carMesh.count = n;
    for (let i = 0; i < n; i++) {
      const car = model.cars[i] as CarAgent;
      const pose = carPoseAt(car, tick);
      const y = heightAt !== undefined ? heightAt(pose.x, pose.z) + 0.1 : 0.1;
      _p.set(pose.x, y, pose.z);
      _e.set(0, pose.yaw, 0);
      _q.setFromEuler(_e);
      const s = 0.95 + 0.15 * ambientHash(model.seed, i, 206);
      _s.set(s, s, s);
      _m.compose(_p, _q, _s);
      this.carMesh.setMatrixAt(i, _m);
    }
    this.carMesh.instanceMatrix.needsUpdate = true;
  }

  private writeTransitInstances(tick: number): void {
    // Drop meshes whose provider unregistered.
    for (const [type, mesh] of this.transitMeshes) {
      if (!transitProviders.has(type)) {
        this.disposeMesh(mesh, false);
        this.transitMeshes.delete(type);
      }
    }
    for (const [type, provider] of transitProviders) {
      const count = Math.max(0, Math.floor(provider.count));
      let mesh = this.transitMeshes.get(type);
      if (mesh === undefined && count > 0) {
        mesh = new THREE.InstancedMesh(provider.geometry, provider.material, count);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.transitMeshes.set(type, mesh);
      }
      if (mesh === undefined) continue;
      if (count === 0) {
        mesh.count = 0;
        continue;
      }
      if (mesh.instanceMatrix.count < count) {
        // Provider raised its count: rebuild the mesh at the new size.
        this.disposeMesh(mesh, false);
        mesh = new THREE.InstancedMesh(provider.geometry, provider.material, count);
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.transitMeshes.set(type, mesh);
      }
      mesh.count = count;
      for (let i = 0; i < count; i++) {
        const pose = provider.poseAt(i, tick);
        if (pose === null) {
          mesh.setMatrixAt(i, _zero);
        } else {
          _p.set(pose.x, pose.y, pose.z);
          _e.set(0, pose.yaw, 0);
          _q.setFromEuler(_e);
          _s.set(1, 1, 1);
          _m.compose(_p, _q, _s);
          mesh.setMatrixAt(i, _m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}
