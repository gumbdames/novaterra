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
 * NOVATERRA — sim/movement.ts — unit movement + move orders.
 *
 * Responsibilities:
 *  - Two systems, registered in this order every tick:
 *    1. `createPathfindingSystem` — drains the time-sliced pathfinding
 *       queue (`runPathfinding`, see `pathfinding.ts`).
 *    2. `createMovementSystem` — rebuilds the spatial hash from unit
 *       positions (the research recommends a per-tick rebuild over
 *       incremental updates), then integrates every `moving` unit along
 *       its A* waypoints or flow-field direction, with local separation
 *       steering so units don't stack. Air units fly straight to their
 *       destination instead: no pathfinding, no water checks.
 *  - Move commands: `moveUnit` (one unit, A* or direct flight),
 *    `moveGroup` (many units, one shared flow field for ground; air
 *    units fly straight in formation), `stopUnit`. Validated at enqueue
 *    AND apply.
 *  - `orderMoveTo` — a low-level "move this unit to (x, z)" used by the
 *    combat system for attack-order chasing (see `combat.ts`).
 *
 * Steering model (all Phase 1 engineering choices, documented here):
 *  - Seek: velocity toward the current waypoint/field step at unit speed,
 *    slowing inside SLOW_RADIUS of the final destination (min 30%).
 *  - Separation: neighbors within SEPARATION_RADIUS push apart with a
 *    (1 - d/R) falloff; the push is added to the seek velocity and the
 *    sum is clamped to the unit's speed. Neighbors come from the spatial
 *    hash in ascending id order, so the result is deterministic.
 *  - Water guard: a step that would enter water (or leave the map) is
 *    cancelled — the unit simply doesn't move that tick. Separation can
 *    never shove a unit into the river.
 *  - Arrival: within ARRIVAL_RADIUS of the ordered destination the unit
 *    snaps to the destination and goes idle; exhausting an A* path or
 *    reaching the flow field's destination cell arrives the same way.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { TerrainData } from './terrain';
import { heightAt, isWater } from './terrain';
import { dist, dist2 } from './deterministic';
import {
  CITY_GRID_CELLS,
  MAP_HALF_SIZE,
  buildingAtCell,
  cellCenterWorld,
  cellCoords,
  cellIsWater,
  BUILDING_DEFS,
  nearestRailStation,
  railSortedHas,
} from './city';
import type { CityState, SeaRoute } from './city';
// Civilian sea trade (Half A, 2026-10-01): the movement-side sea-trade
// loop calls the port action from the seaTrade LEAF module
// (sim/seaTrade.ts) — never from economy.ts directly: economy.ts
// reads city.ts at module scope (SPEC_ZONE over ZoneType), and the
// city→…→commands→movement chain means a movement→economy value edge
// evaluates economy.ts while city.ts is still partially initialized
// (the market.ts leaf-module precedent documents the same trap for
// ai→economy).
import { runSeaTradePortCall } from './seaTrade';
import type { CommandQueue } from './commands';
import {
  DIRS,
  FIELD_DESTINATION,
  FIELD_UNREACHABLE,
  dropUnitRequests,
  findField,
  landComponents,
  requestField,
  requestPath,
  runPathfinding,
  seaComponents,
  worldToCell,
} from './pathfinding';
import type { FlowField } from './pathfinding';
import { clearUnitOrder, failUnitOrder, findUnit, UNIT_DEFS, supplySpeedFactor, isRailBound, isSheltered } from './units';
import type { UnitRecord, UnitKind } from './units';
import { findRailRoute, stationRailCells, trainTrackFactor } from './rail';
import { createSpatialHash, shInsert, shQueryRadius } from './spatial';
import type { SpatialHash } from './spatial';

/** Neighbor push-apart radius, world units (spatial cell is 16; §D10). */
export const SEPARATION_RADIUS = 6;
/** Separation velocity contribution, world units/second at zero distance. */
export const SEPARATION_FORCE = 10;
/** Snap-to-destination radius, world units. */
export const ARRIVAL_RADIUS = 2;
/** Slow down inside this distance of the final destination. */
export const SLOW_RADIUS = 8;
/** Minimum speed factor while inside the slow radius. */
const MIN_SLOW_FACTOR = 0.3;
/** Waypoint considered reached inside this distance, world units. */
const WAYPOINT_REACH = 1.2;
/** Formation slot ring spacing, world units (square rings, see slotOffset). */
const SLOT_SPACING = 2.5;
/** Max slot-rank scan when hunting a land slot (deterministic bound). */
const SLOT_SCAN_MAX = 256;

/**
 * Deterministic formation offset for the `rank`-th unit of a group (0 =
 * the destination itself). Concentric square rings: ring k ≥ 1 holds 8k
 * slots at half-side `SLOT_SPACING * k`, spaced ~SLOT_SPACING apart, so
 * arrived group members never stack. Pure integer/rational math — no
 * transcendental functions, bit-identical on every engine.
 */
export function slotOffset(rank: number): [number, number] {
  if (rank <= 0) return [0, 0];
  let k = 1;
  let r = rank - 1; // 0-based within its ring: ring 1 = ranks 1..8, ring 2 = 9..24, …
  while (r >= 8 * k) {
    r -= 8 * k;
    k += 1;
  }
  const s = SLOT_SPACING * k;
  const side = Math.floor(r / (2 * k)); // 0..3
  const along = r % (2 * k); // 0..2k-1
  const o = -s + (along / (2 * k)) * 2 * s;
  switch (side) {
    case 0: return [o, -s];
    case 1: return [s, o];
    case 2: return [-o, s];
    default: return [-s, -o];
  }
}

/** Pathfinding coordinator as a tick system. Runs before movement. */
export function createPathfindingSystem(t: TerrainData): (world: World, dt: number) => void {
  return (world: World, _dt: number) => {
    runPathfinding(world, t);
  };
}

/** Clamp a world position inside the map bounds. */
function clampToMap(x: number, z: number): [number, number] {
  const m = MAP_HALF_SIZE - 0.01;
  return [Math.min(Math.max(x, -m), m), Math.min(Math.max(z, -m), m)];
}

/** Steering target for a unit this tick, or null when it should arrive/fail. */
function steeringTarget(
  world: World,
  unit: UnitRecord,
): { x: number; z: number; arrived: boolean; fail: string | null } {
  if (unit.path.length > 0) {
    // A* waypoints.
    if (unit.pathAt >= unit.path.length) {
      return { x: unit.destX, z: unit.destZ, arrived: true, fail: null };
    }
    const cell = unit.path[unit.pathAt] as number;
    const { cx, cz } = cellCoords(cell);
    return { x: cellCenterWorld(cx), z: cellCenterWorld(cz), arrived: false, fail: null };
  }
  // Flow field.
  const field = findField(world, unit.fieldId) as FlowField | undefined;
  if (!field) {
    return { x: 0, z: 0, arrived: false, fail: 'flow field gone' };
  }
  const cell = worldToCell(unit.x, unit.z);
  const dir = field.dirs[cell] as number;
  if (dir === FIELD_DESTINATION) {
    return { x: unit.destX, z: unit.destZ, arrived: true, fail: null };
  }
  if (dir === FIELD_UNREACHABLE) {
    return { x: 0, z: 0, arrived: false, fail: 'flow field dead end' };
  }
  // DIRS order (0=E … 7=NE) is shared with pathfinding.ts.
  const [dxy, dzy] = DIRS[dir] as readonly [number, number];
  const { cx, cz } = cellCoords(cell);
  const nx = Math.min(Math.max(cx + dxy, 0), CITY_GRID_CELLS - 1);
  const nz = Math.min(Math.max(cz + dzy, 0), CITY_GRID_CELLS - 1);
  return {
    x: cellCenterWorld(nx),
    z: cellCenterWorld(nz),
    arrived: false,
    fail: null,
  };
}

/** Mark a unit arrived: snap to its slot, clear order, idle. */
function arriveUnit(unit: UnitRecord): void {
  unit.x = unit.arriveX;
  unit.z = unit.arriveZ;
  clearUnitOrder(unit);
  unit.state = 'idle';
  unit.failReason = null;
}

/**
 * Straight-line flight for air units. No waypoints, no flow fields, no
 * water checks — they fly over everything. Separation applies against
 * other air units only (ground units are below them, literally).
 */
function moveAirUnitTick(world: World, t: TerrainData, hash: SpatialHash, unit: UnitRecord, dt: number): void {
  const dxFinal = unit.arriveX - unit.x;
  const dzFinal = unit.arriveZ - unit.z;
  const distFinal = dist(dxFinal, dzFinal);
  if (distFinal < ARRIVAL_RADIUS) {
    arriveUnit(unit);
    return;
  }
  let vx = dxFinal;
  let vz = dzFinal;
  const vmag0 = dist(vx, vz);
  // Phase 3 logistics (AD3): degraded cruise speed — ×(0.7+0.3×level),
  // the speed half of the single supply curve. Also caps separation
  // pushes below, so a dry unit is slower, period. Exempt kinds: ×1.0.
  const ratedSpeed = unit.speed * supplySpeedFactor(UNIT_DEFS[unit.kind as UnitKind], unit);
  let speed = ratedSpeed;
  if (distFinal < SLOW_RADIUS) {
    const factor = Math.max(MIN_SLOW_FACTOR, distFinal / SLOW_RADIUS);
    speed *= factor;
  }
  if (vmag0 > 1e-9) {
    vx = (vx / vmag0) * speed;
    vz = (vz / vmag0) * speed;
  } else {
    vx = 0;
    vz = 0;
  }
  // Separation: air units push apart from other air units only.
  const neighbors = shQueryRadius(hash, unit.x, unit.z, SEPARATION_RADIUS);
  let sx = 0;
  let sz = 0;
  if (distFinal >= SLOW_RADIUS) {
    for (const nid of neighbors) {
      if (nid === unit.id) continue;
      const other = findUnit(world, nid);
      // Ground units only push against ground units — aircraft fly above
      // them (the air branch filters the other way).
      if (!other || other.domain !== unit.domain) continue;
      const ox = unit.x - other.x;
      const oz = unit.z - other.z;
      const d = dist(ox, oz);
      if (d >= SEPARATION_RADIUS) continue;
      if (d < 1e-9) {
        const dir = unit.id < other.id ? -1 : 1;
        sx += dir * SEPARATION_FORCE;
        continue;
      }
      const push = (1 - d / SEPARATION_RADIUS) * SEPARATION_FORCE;
      sx += (ox / d) * push;
      sz += (oz / d) * push;
    }
  }
  vx += sx;
  vz += sz;
  const vmag = dist(vx, vz);
  if (vmag > ratedSpeed && vmag > 1e-9) {
    vx = (vx / vmag) * ratedSpeed;
    vz = (vz / vmag) * ratedSpeed;
  }
  const [nx, nz] = clampToMap(unit.x + vx * dt, unit.z + vz * dt);
  // Sea units can only move on water; air units fly anywhere.
  if (unit.domain === 'sea' && !isWater(t, nx, nz)) {
    return; // hold position; the step is cancelled
  }
  unit.x = nx;
  unit.z = nz;
}

function moveUnitTick(world: World, t: TerrainData, hash: SpatialHash, unit: UnitRecord, dt: number): void {
  // Air units fly straight to their slot: no pathfinding. They fly over
  // everything and still separate (from air units) and arrive exactly
  // like ground units. Sea units use the water pathfinding flow below
  // (findSeaPath) — they must navigate around islands, not fly over them.
  if (unit.domain === 'air') {
    moveAirUnitTick(world, t, hash, unit, dt);
    return;
  }
  // 1. Arrival backstop: close enough to the unit's own slot.
  const dxFinal = unit.arriveX - unit.x;
  const dzFinal = unit.arriveZ - unit.z;
  const distFinal = dist(dxFinal, dzFinal);
  if (distFinal < ARRIVAL_RADIUS) {
    arriveUnit(unit);
    return;
  }

  // 2. Steering target (waypoint or field step).
  const target = steeringTarget(world, unit);
  if (target.fail !== null) {
    failUnitOrder(unit, target.fail);
    return;
  }
  if (target.arrived) {
    arriveUnit(unit);
    return;
  }

  // 3. Consume reached A* waypoints.
  if (unit.path.length > 0) {
    const dxw = target.x - unit.x;
    const dzw = target.z - unit.z;
    if (dist2(dxw, dzw) < WAYPOINT_REACH * WAYPOINT_REACH) {
      unit.pathAt += 1;
      if (unit.pathAt >= unit.path.length) {
        arriveUnit(unit);
        return;
      }
      // Recompute target for the new waypoint next tick; steer at the
      // reached one this tick (harmless — it's within 1.2 units).
    }
  }

  // 4. Seek velocity with arrival slowdown.
  let vx = target.x - unit.x;
  let vz = target.z - unit.z;
  const vmag0 = dist(vx, vz);
  // Phase 3 logistics (AD3): degraded cruise speed — ×(0.7+0.3×level),
  // the speed half of the single supply curve (see moveAirUnitTick).
  let ratedSpeed = unit.speed * supplySpeedFactor(UNIT_DEFS[unit.kind as UnitKind], unit);
  // Phase 4 (S7): rail-bound units run at the track class's speed
  // factor for the rail cell they sit on (standard 1.0 / electric 1.4
  // / high-speed 1.9 — TRACK_CLASS_STATS). This is the "train quality
  // gated by track class" mechanic: the same train runs faster on a
  // better main line. Applied per tick at the CURRENT cell, so a route
  // crossing mixed classes speeds up and slows down along the way.
  if (isRailBound(unit.kind)) {
    ratedSpeed *= trainTrackFactor(world.city.rails, worldToCell(unit.x, unit.z));
  }
  let speed = ratedSpeed;
  if (distFinal < SLOW_RADIUS) {
    const factor = Math.max(MIN_SLOW_FACTOR, distFinal / SLOW_RADIUS);
    speed *= factor;
  }
  if (vmag0 > 1e-9) {
    vx = (vx / vmag0) * speed;
    vz = (vz / vmag0) * speed;
  } else {
    vx = 0;
    vz = 0;
  }

  // 5. Separation: push apart from neighbors (ascending id order).
  //    A unit docking inside SLOW_RADIUS of its slot ignores pushes:
  //    formation slots sit ~2.5 apart but the separation radius is 6, so
  //    repelling near the destination would deadlock arrival (push and
  //    pull balance short of the slot). The unit stays in the hash, so it
  //    still pushes others away — it just can't be pushed off its slot.
  const neighbors = shQueryRadius(hash, unit.x, unit.z, SEPARATION_RADIUS);
  let sx = 0;
  let sz = 0;
  if (distFinal >= SLOW_RADIUS) {
    for (const nid of neighbors) {
      if (nid === unit.id) continue;
      const other = findUnit(world, nid);
      // Ground units only push against ground units — aircraft fly above
      // them (the air branch filters the other way).
      if (!other || other.domain !== unit.domain) continue;
      const ox = unit.x - other.x;
      const oz = unit.z - other.z;
      const d = dist(ox, oz);
      if (d >= SEPARATION_RADIUS) continue;
      if (d < 1e-9) {
        // Exact overlap: no direction exists to normalize. Push apart
        // along the x axis — the lower id goes -x, the higher +x — so the
        // pair separates deterministically instead of stacking forever.
        // (Combat funnels many units onto one target point; without this
        // they merge into a single visual/physical pile.)
        const dir = unit.id < other.id ? -1 : 1;
        sx += dir * SEPARATION_FORCE;
        continue;
      }
      const push = (1 - d / SEPARATION_RADIUS) * SEPARATION_FORCE;
      sx += (ox / d) * push;
      sz += (oz / d) * push;
    }
  }
  vx += sx;
  vz += sz;

  // 6. Clamp to unit speed and integrate; water/map guard.
  const vmag = dist(vx, vz);
  if (vmag > ratedSpeed && vmag > 1e-9) {
    vx = (vx / vmag) * ratedSpeed;
    vz = (vz / vmag) * ratedSpeed;
  }
  const [nx, nz] = clampToMap(unit.x + vx * dt, unit.z + vz * dt);
  const destIsWater = isWater(t, nx, nz);
  // Domain movement rules: land stays on land, sea stays on water.
  // (Air units return early via moveAirUnitTick and never reach here.)
  if (unit.domain === 'sea') {
    // Sea units cannot run aground.
    if (destIsWater) {
      unit.x = nx;
      unit.z = nz;
    }
    // else: the step is cancelled; the unit holds position this tick.
  } else {
    // Land units cannot enter water.
    if (!destIsWater) {
      unit.x = nx;
      unit.z = nz;
    }
    // else: the step is cancelled; the unit holds position this tick.
  }
}

/** Movement system: rebuild the hash, then integrate every moving unit. */
export function createMovementSystem(t: TerrainData): (world: World, dt: number) => void {
  return (world: World, dt: number) => {
    // Grand-expansion Phase 5 (S4): embarked aircraft ride their
    // carrier — sync FIRST, in unit-id order, before any displacement
    // (PLAN §4 S4: "sync position = carrier's in id order, before
    // combat").
    syncEmbarkedPositions(world);
    // Phase 4 (S7): the ferry loop runs FIRST, in unit-id order — idle
    // ferries with a route get dispatched before any displacement, so a
    // ferry that just arrived re-dispatches and sails the same tick.
    advanceFerryRoutes(world);
    // Civilian sea trade (Half A, 2026-10-01): the sea-trade loop runs
    // right after the ferry loop — same contract (idle route ships get
    // dispatched before displacement, so a ship that just arrived
    // re-dispatches and sails the same tick).
    advanceSeaTrade(world, t);
    // Only actively moving units separate: idle/failed/awaitingPath units
    // are parked (or stationary) and invisible to separation. Otherwise
    // already-parked units form a repulsion "wall" that newcomers can
    // never cross to reach their own nearby slots.
    const hash = createSpatialHash(16);
    for (const unit of world.units) {
      if (unit.state !== 'moving') continue;
      // Grand-expansion Phase 5 (S4): sheltered aircraft (parked in a
      // hangar or embarked on a carrier) never displace — they ride
      // with their shelter.
      if (isSheltered(unit)) continue;
      shInsert(hash, unit.id, unit.x, unit.z);
    }
    for (const unit of world.units) {
      if (unit.state !== 'moving') continue;
      if (isSheltered(unit)) continue;
      // Phase 3 logistics (S2): the fuel gate runs BEFORE displacement —
      // an empty tank fails the order loudly, never silently.
      if (!fuelGateOk(unit)) continue;
      const x0 = unit.x;
      const z0 = unit.z;
      moveUnitTick(world, t, hash, unit, dt);
      // Burn only for real displacement (blocked steps and zero-distance
      // ticks burn nothing). Pathing decisions are made upstream by the
      // coordinator and never read fuel — burn cannot change them.
      burnFuelForDisplacement(unit, x0, z0, dt);
    }
  };
}

/**
 * How often (ticks) the ferry loop retries a dispatch that failed on an
 * empty tank. 30 ticks = 1 sim-second: prompt enough to sail the moment a
 * tanker or depot refuels the ferry, sparse enough that a permanently
 * stranded ferry doesn't burn the pathfinding budget (PATHS_PER_TICK)
 * re-requesting a doomed route every tick. Deterministic: keyed on
 * world.tick, no new state (the digest/snapshot are untouched).
 */
export const FERRY_RETRY_TICKS = 30;

/**
 * Phase 4 (S7): the ferry loop. An idle ferry with a route (`route`
 * set by `setFerryRoute`) flips `leg` and dispatches to the other
 * endpoint via the normal sea A* (orderMoveTo) — the ferry shuttles
 * a↔b forever. Runs in unit-id order for determinism. A manual
 * moveUnit order is a DETOUR: the ferry finishes it, idles, and the
 * loop resumes from there.
 *
 * Final-review R1 (M9, 2026-10-01): failed dispatches RETRY instead of
 * killing the route. An empty tank ('out of fuel') is TRANSIENT — a
 * tanker or depot refuels the ferry — so the ferry resets to idle and
 * the loop re-dispatches the SAME leg (the failed dispatch's leg flip
 * is undone first, then re-applied by the normal path, so the net flip
 * is zero whether the failure came from the loop or a manual detour).
 * The failure stays loud while it lasts (unit.failReason). Permanent
 * failures ('no path: destination unreachable by water' — static
 * terrain, fail-fast capped sea search) are never retried: retrying
 * them could not succeed, so they stay failed loudly for the player
 * to see.
 */
function advanceFerryRoutes(world: World): void {
  const ordered = [...world.units].sort((a, b) => a.id - b.id);
  for (const unit of ordered) {
    if (unit.kind !== 'ferry' || unit.hp <= 0) continue;
    if (unit.route === undefined) continue;
    const r = unit.route;
    if (unit.state === 'failed' && unit.failReason === 'out of fuel' && world.tick % FERRY_RETRY_TICKS === 0) {
      // Transient failure: undo the failed dispatch's leg flip so the
      // normal path below re-flips to the SAME leg (retry, not skip).
      r.leg = r.leg === 'a' ? 'b' : 'a';
      unit.state = 'idle';
      unit.failReason = null;
    }
    if (unit.state !== 'idle') continue;
    r.leg = r.leg === 'a' ? 'b' : 'a';
    const tx = r.leg === 'a' ? r.ax : r.bx;
    const tz = r.leg === 'a' ? r.az : r.bz;
    orderMoveTo(world, unit, tx, tz);
  }
}

/**
 * Civilian sea trade (Half A, 2026-10-01): retry cadence for route
 * ships stuck 'out of fuel' — the ferry `FERRY_RETRY_TICKS` precedent.
 */
export const SEA_TRADE_RETRY_TICKS = 30;
/**
 * How close (world units) a route ship must be to its leg's harbor
 * water cell for the arrival port action to fire. 14 ≈ 3.5 cells —
 * generous vs the arrival snap radius (2), so a ship that drifted
 * slightly off the exact cell still docks.
 */
const SEA_TRADE_DOCK_RADIUS = 14;

/**
 * Civilian sea trade (Half A, 2026-10-01): the deterministic water
 * cell a harbor loads/unloads at — the lowest cell index in the
 * one-cell ring around the footprint that is water. The coastal
 * placement rule guarantees the ring is never waterless, but the scan
 * stays total (0 = none, the caller fails loudly). Same shape as the
 * siege `siegeStandCell` ring scan.
 */
export function harborWaterCell(t: TerrainData, b: { cx: number; cz: number; kind: string }): number {
  const def = BUILDING_DEFS[b.kind as keyof typeof BUILDING_DEFS];
  let best = 0;
  for (let dx = -1; dx <= def.footprintW; dx++) {
    for (let dz = -1; dz <= def.footprintH; dz++) {
      // Ring only: skip the footprint interior.
      if (dx >= 0 && dx < def.footprintW && dz >= 0 && dz < def.footprintH) continue;
      const cx = b.cx + dx;
      const cz = b.cz + dz;
      if (cx < 0 || cz < 0 || cx >= CITY_GRID_CELLS || cz >= CITY_GRID_CELLS) continue;
      const cell = cz * CITY_GRID_CELLS + cx;
      if (cellIsWater(t, cx, cz) && (best === 0 || cell < best)) best = cell;
    }
  }
  return best;
}

/**
 * Civilian sea trade (Half A, 2026-10-01): sail assigned cargo vessels
 * along their sea routes. Runs inside the movement system (after the
 * ferry loop — same shape): unit-id order; only idle ships are
 * dispatched (a manual `moveUnit` is a DETOUR — the ship finishes it,
 * idles, and the loop resumes from there, exactly like ferries).
 *
 * Each idle assigned ship sails to its leg's harbor water cell
 * (`harborWaterCell`). When it is within `SEA_TRADE_DOCK_RADIUS` of
 * that cell it has ARRIVED: the route policy's port action fires
 * (`runSeaTradePortCall` — load at the origin, unload/income at the
 * destination), the leg flips, and the ship sails back. A ship idle
 * elsewhere (detour ended off-harbor) just resumes sailing — no port
 * action fires away from the harbor.
 *
 * Loud failures mirror the ferry loop: 'out of fuel' retries every
 * `SEA_TRADE_RETRY_TICKS`; a route that vanished mid-tick releases
 * the assignment loudly ('sea route ended' — the economy tick owns
 * the canonical dead-route cleanup, this is the mid-tick defense).
 */
function advanceSeaTrade(world: World, t: TerrainData): void {
  const city = world.city;
  const routes = city.seaRoutes ?? [];
  // Fast path: no routes and no assigned ships → nothing to do. (The
  // mid-tick release below must still run when the routes vanished but
  // ships still carry assignments — hence the assigned-ship check, not
  // just the route count.)
  if (routes.length === 0) {
    let anyAssigned = false;
    for (const u of world.units) {
      if ((u.seaRouteId ?? 0) !== 0) {
        anyAssigned = true;
        break;
      }
    }
    if (!anyAssigned) return;
  }
  const byId = new Map<number, SeaRoute>();
  for (const r of routes) byId.set(r.id, r);
  const ordered = [...world.units].sort((a, b) => a.id - b.id);
  for (const u of ordered) {
    const routeId = u.seaRouteId ?? 0;
    if (routeId === 0 || u.hp <= 0) continue;
    const route = byId.get(routeId);
    if (!route) {
      u.seaRouteId = 0;
      u.seaRouteLeg = undefined;
      u.failReason = 'sea route ended';
      continue;
    }
    if (u.state === 'failed' && u.failReason === 'out of fuel' && world.tick % SEA_TRADE_RETRY_TICKS === 0) {
      // Transient failure (the ferry precedent): retry the dispatch.
      u.state = 'idle';
      u.failReason = null;
    }
    if (u.state !== 'idle') continue;
    const leg = u.seaRouteLeg ?? 'to';
    const targetId = leg === 'from' ? route.from : route.to;
    const harbor = city.buildings.find((b) => b.id === targetId);
    // Dead endpoint: the economy tick removes the route and releases
    // the ships; until then the ship waits (never sails at a ghost).
    if (!harbor || harbor.progress < 1 || !harbor.operational) continue;
    const cell = harborWaterCell(t, harbor);
    if (cell === 0) {
      u.failReason = 'no harbor water access';
      continue;
    }
    const { cx, cz } = cellCoords(cell);
    const wx = cellCenterWorld(cx);
    const wz = cellCenterWorld(cz);
    const dx = u.x - wx;
    const dz = u.z - wz;
    if (dx * dx + dz * dz <= SEA_TRADE_DOCK_RADIUS * SEA_TRADE_DOCK_RADIUS) {
      // Arrived: run the port action, flip the leg, sail the next leg.
      const atOrigin = leg === 'from';
      runSeaTradePortCall(world, u, route, targetId, atOrigin);
      const nextLeg = leg === 'from' ? 'to' : 'from';
      const nextId = nextLeg === 'from' ? route.from : route.to;
      const nextHarbor = city.buildings.find((b) => b.id === nextId);
      const nextCell = nextHarbor ? harborWaterCell(t, nextHarbor) : 0;
      if (nextCell === 0) {
        u.failReason = 'no harbor water access';
        continue;
      }
      u.seaRouteLeg = nextLeg;
      const nc = cellCoords(nextCell);
      orderMoveTo(world, u, cellCenterWorld(nc.cx), cellCenterWorld(nc.cz));
    } else {
      // Idle away from the harbor (detour/manual order): resume
      // sailing to the leg's harbor. No port action off-harbor.
      orderMoveTo(world, u, wx, wz);
    }
  }
}
/**
 * Grand-expansion Phase 5 (S4): embarked aircraft ride their carrier.
 * world.units is spawn (id) order, so this loop is id-ordered —
 * deterministic. Each embarked aircraft's position and destinations
 * snap to its carrier's. A carrier that vanished without killUnit
 * (defensive only — killUnit destroys the wing) releases its wing
 * instead of stranding it.
 */
function syncEmbarkedPositions(world: World): void {
  for (const u of world.units) {
    const carrierId = u.embarkedOn ?? 0;
    if (carrierId <= 0) continue;
    const carrier = world.units.find((c) => c.id === carrierId);
    if (!carrier || carrier.hp <= 0) {
      u.embarkedOn = 0;
      continue;
    }
    u.x = carrier.x;
    u.z = carrier.z;
    u.destX = carrier.x;
    u.destZ = carrier.z;
    u.arriveX = carrier.x;
    u.arriveZ = carrier.z;
  }
}

/**
 * Phase 3 logistics (S2): fossil-fuel gate. A fossil-fuel unit whose tank
 * is empty cannot displace — its order fails LOUDLY ('out of fuel'),
 * never silently. Nuclear-fuel and untracked units are exempt: no gate,
 * no failure. The unit is stranded, not destroyed (§13 non-goal: no
 * dead-instant units from empty supply — it can still fight, be
 * resupplied, or be re-tasked once refueled). Returns false when the
 * unit may not move this tick.
 */
function fuelGateOk(unit: UnitRecord): boolean {
  const def = UNIT_DEFS[unit.kind as UnitKind];
  if (def?.fuelType !== 'fossil') return true;
  if ((unit.fuel ?? 0) <= 0) {
    failUnitOrder(unit, 'out of fuel');
    return false;
  }
  return true;
}

/**
 * Phase 3 logistics (S2): burn `fuelPerSecond × dt` for actual
 * displacement this tick. Called with the pre-tick position AFTER the
 * move integration, so fuel burns ONLY while the unit really moved:
 * cancelled steps (blocked by water/land rules), zero-velocity ticks,
 * and arrival snaps of zero distance cost nothing. Deterministic float
 * comparison — exact equality is stable across identical inputs.
 */
function burnFuelForDisplacement(unit: UnitRecord, x0: number, z0: number, dt: number): void {
  if (unit.x === x0 && unit.z === z0) return;
  const def = UNIT_DEFS[unit.kind as UnitKind];
  if (def?.fuelType !== 'fossil') return;
  const rate = def.fuelPerSecond ?? 0;
  if (rate <= 0) return;
  unit.fuel = Math.max(0, (unit.fuel ?? 0) - rate * dt);
}

/**
 * Terrain-following height for a unit (world units). Units store only x/z;
 * render interpolates y from this each frame. Not part of the digest —
 * it's a pure function of terrain + position.
 */
export function unitGroundHeight(t: TerrainData, unit: UnitRecord): number {
  return heightAt(t, unit.x, unit.z);
}

// ---------------------------------------------------------------------------
// Move commands.
// ---------------------------------------------------------------------------

function payloadUnitIds(payload: Record<string, unknown>): number[] | null {
  const v = payload['unitIds'];
  if (!Array.isArray(v) || v.length === 0 || v.length > 500) return null;
  const out: number[] = [];
  for (const id of v) {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
    out.push(id);
  }
  return out;
}

function validateDestination(
  t: TerrainData,
  city: CityState,
  x: unknown,
  z: unknown,
  domain: string = 'land',
): string | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 'payload.x must be a finite number';
  if (typeof z !== 'number' || !Number.isFinite(z)) return 'payload.z must be a finite number';
  if (Math.abs(x) > MAP_HALF_SIZE || Math.abs(z) > MAP_HALF_SIZE) {
    return `destination (${x}, ${z}) is outside the map`;
  }
  // Terrain is static: a validate-time water check cannot go stale.
  // Air units fly anywhere; land units cannot enter water; sea units require water.
  const destIsWater = isWater(t, x, z);
  if (domain === 'land' && destIsWater) return `destination (${x}, ${z}) is water`;
  if (domain === 'sea' && !destIsWater) return `destination (${x}, ${z}) is land (sea units need water)`;
  // Unit/building-overlap guard (2026-10-05): land and sea units may not
  // be ordered to a destination inside a building footprint — a unit that
  // walks onto a construction site is swallowed when the building
  // completes around it (ejectUnitsFromFootprints is the backstop, this
  // is the prevention). Air units fly above the mesh: exempt.
  if (domain !== 'air') {
    const b = buildingAtCell(city, worldToCell(x, z));
    if (b !== undefined) {
      const name = BUILDING_DEFS[b.kind]?.name ?? b.kind;
      return `destination (${x}, ${z}) is inside the ${name} footprint`;
    }
  }
  return null;
}

function validateOwnedUnit(world: World, unitId: unknown, owner: unknown, kind: string): UnitRecord | string {
  if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
    return `${kind}: payload.unitId must be a positive integer`;
  }
  if (typeof owner !== 'number' || !Number.isInteger(owner)) {
    return `${kind}: payload.owner must be an integer`;
  }
  const unit = findUnit(world, unitId);
  if (!unit) return `${kind}: no unit with id ${unitId}`;
  if (unit.owner !== owner) return `${kind}: unit ${unitId} is not owned by player ${owner}`;
  // Grand-expansion Phase 5 (S4): sheltered aircraft take no move/stop
  // orders — launch them first. Loud, never silent.
  if (isSheltered(unit)) return `${kind}: unit ${unitId} is parked or embarked (launch it first)`;
  return unit;
}

/** Shared apply logic: retask one unit to (x, z) via A*. */
function retaskSingle(world: World, unit: UnitRecord, x: number, z: number): void {
  orderMoveTo(world, unit, x, z);
}

/**
 * Order a unit to (x, z) — the low-level move used by the move commands
 * and by the combat system for attack-order chasing (see `combat.ts`).
 * Ground units go through A*; air units fly straight. Clears any combat
 * targeting (a move order supersedes an attack).
 */
export function orderMoveTo(
  world: World,
  unit: UnitRecord,
  x: number,
  z: number,
  preserveAttackMove = false,
): void {
  dropUnitRequests(world, unit.id);
  clearUnitOrder(unit);
  unit.targetId = 0;
  // Final-review R2: a plain move supersedes an attack-building order
  // too (same contract as targetId above).
  unit.buildingTargetId = 0;
  unit.chasing = false;
  if (!preserveAttackMove) {
    delete unit.attackMoving;
    delete unit.attackMoveDestX;
    delete unit.attackMoveDestZ;
  }
  unit.destX = x;
  unit.destZ = z;
  unit.arriveX = x;
  unit.arriveZ = z;
  unit.failReason = null;
  if (unit.domain === 'air') {
    const arrived = dist2(x - unit.x, z - unit.z) < ARRIVAL_RADIUS * ARRIVAL_RADIUS;
    unit.state = arrived ? 'idle' : 'moving';
    return;
  }
  // Phase 4 (S7): rail-bound units (trains) never touch A*/flow fields —
  // they steer along rail cells via the dedicated BFS router (rail.ts).
  if (isRailBound(unit.kind)) {
    orderTrainMoveTo(world, unit, x, z);
    return;
  }
  if (worldToCell(x, z) === worldToCell(unit.x, unit.z)) {
    unit.state = 'idle'; // already in the destination cell
    return;
  }
  unit.state = 'awaitingPath';
  requestPath(world, unit.id, worldToCell(x, z));
}

/**
 * Phase 4 (S7): rail routing for trains.
 *
 * The destination snaps to the nearest completed, operational
 * railStation of the train's owner within RAIL_STATION_SNAP_RADIUS
 * world units (48) — loud failure when there is none ('no rail station
 * near destination'). BFS starts are the rail cells in the 3×3 under
 * the train (it is rail-bound, so it should already be on rails);
 * 'train is off the rail network' fails loudly otherwise. The routed
 * cells become `unit.path` (the existing waypoint steering follows
 * them in order); the train stops at the station's footprint center.
 */
export const RAIL_STATION_SNAP_RADIUS = 48;

export function orderTrainMoveTo(world: World, unit: UnitRecord, x: number, z: number): void {
  const city = world.city;
  const station = nearestRailStation(city, x, z, unit.owner);
  const def = station === undefined ? undefined : BUILDING_DEFS[station.kind];
  if (
    station === undefined ||
    def === undefined ||
    dist2(
      cellCenterWorld(station.cx + (def.footprintW - 1) / 2) - x,
      cellCenterWorld(station.cz + (def.footprintH - 1) / 2) - z,
    ) >
      RAIL_STATION_SNAP_RADIUS * RAIL_STATION_SNAP_RADIUS
  ) {
    failUnitOrder(unit, 'no rail station near destination');
    return;
  }
  // BFS starts: rail cells in the 3×3 around the train.
  const tc = worldToCell(unit.x, unit.z);
  const { cx: tcx, cz: tcz } = cellCoords(tc);
  const starts: number[] = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = tcx + dx;
      const nz = tcz + dz;
      if (nx < 0 || nz < 0 || nx >= CITY_GRID_CELLS || nz >= CITY_GRID_CELLS) continue;
      const c = nz * CITY_GRID_CELLS + nx;
      if (railSortedHas(city.rails, c)) starts.push(c);
    }
  }
  if (starts.length === 0) {
    failUnitOrder(unit, 'train is off the rail network');
    return;
  }
  const route = findRailRoute(city.rails, starts, stationRailCells(city.rails, station, def));
  if (route === null) {
    failUnitOrder(unit, 'no rail route');
    return;
  }
  // The route cells become the waypoint path (existing steering), the
  // destination becomes the station itself.
  unit.path = route;
  unit.pathAt = 0;
  const sx = cellCenterWorld(station.cx + (def.footprintW - 1) / 2);
  const sz = cellCenterWorld(station.cz + (def.footprintH - 1) / 2);
  unit.destX = sx;
  unit.destZ = sz;
  unit.arriveX = sx;
  unit.arriveZ = sz;
  unit.state = 'moving';
}

/**
 * Assign deterministic formation slots to group members. Units already
 * sitting in the destination cell keep rank 0..k (they stay put); waiting
 * units take the following ranks. Each candidate slot must be in-bounds,
 * land, and in the destination's land component — otherwise the next rank
 * is tried (bounded scan, deterministic). Falls back to the destination
 * itself if nothing is found (pathological).
 */
function assignGroupSlots(world: World, t: TerrainData, waiting: UnitRecord[], atDestCount: number, x: number, z: number): void {
  const destCell = worldToCell(x, z);
  const comps = landComponents(t);
  const destComp = comps[destCell] as number;
  // Id order (spawn order) — canonical and deterministic.
  const ordered = [...waiting].sort((a, b) => a.id - b.id);
  let rank = atDestCount;
  for (const unit of ordered) {
    let r = rank;
    let sx = x;
    let sz = z;
    for (let scan = 0; scan < SLOT_SCAN_MAX; scan++) {
      const [ox, oz] = slotOffset(r);
      const cx = x + ox;
      const cz = z + oz;
      const ok =
        Math.abs(cx) <= MAP_HALF_SIZE &&
        Math.abs(cz) <= MAP_HALF_SIZE &&
        !isWater(t, cx, cz) &&
        (comps[worldToCell(cx, cz)] as number) === destComp;
      if (ok) {
        sx = cx;
        sz = cz;
        break;
      }
      r += 1;
    }
    unit.arriveX = sx;
    unit.arriveZ = sz;
    rank = r + 1;
  }
}

/**
 * Formation slots for sea units: scans slotOffset rings for water cells
 * in the same sea component as the destination. Ships need water slots —
 * unlike aircraft, they cannot stack on land.
 */
function assignSeaSlots(world: World, t: TerrainData, waiting: UnitRecord[], atDestCount: number, x: number, z: number): void {
  const destCell = worldToCell(x, z);
  const comps = seaComponents(t);
  const destComp = comps[destCell] as number;
  // Id order (spawn order) — canonical and deterministic.
  const ordered = [...waiting].sort((a, b) => a.id - b.id);
  let rank = atDestCount;
  for (const unit of ordered) {
    let r = rank;
    let sx = x;
    let sz = z;
    for (let scan = 0; scan < SLOT_SCAN_MAX; scan++) {
      const [ox, oz] = slotOffset(r);
      const cx = x + ox;
      const cz = z + oz;
      const ok =
        Math.abs(cx) <= MAP_HALF_SIZE &&
        Math.abs(cz) <= MAP_HALF_SIZE &&
        isWater(t, cx, cz) &&
        (comps[worldToCell(cx, cz)] as number) === destComp;
      if (ok) {
        sx = cx;
        sz = cz;
        break;
      }
      r += 1;
    }
    unit.arriveX = sx;
    unit.arriveZ = sz;
    rank = r + 1;
  }
}

/**
 * Formation slots for air units: plain slotOffset rings, clamped to the
 * map. No terrain checks — aircraft fly over water and any terrain.
 */
function assignAirSlots(waiting: UnitRecord[], atDestCount: number, x: number, z: number): void {
  const ordered = [...waiting].sort((a, b) => a.id - b.id);
  const m = MAP_HALF_SIZE - 0.01;
  let rank = atDestCount;
  for (const unit of ordered) {
    const [ox, oz] = slotOffset(rank);
    unit.arriveX = Math.min(Math.max(x + ox, -m), m);
    unit.arriveZ = Math.min(Math.max(z + oz, -m), m);
    rank += 1;
  }
}

export function registerMovementCommands(queue: CommandQueue, t: TerrainData): void {
  queue.register('moveUnit', {
    validate(cmd, world): string | null {
      const unit = validateOwnedUnit(world, cmd.payload['unitId'], cmd.payload['owner'], 'moveUnit');
      if (typeof unit === 'string') return unit;
      // Air units fly over water; ground units can't be ordered into it.
      return validateDestination(t, world.city, cmd.payload['x'], cmd.payload['z'], unit.domain);
    },
    apply(cmd, world): unknown {
      const unit = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
      orderMoveTo(world, unit, cmd.payload['x'] as number, cmd.payload['z'] as number);
      return unit.id;
    },
  });

  queue.register('moveGroup', {
    validate(cmd, world): string | null {
      const ids = payloadUnitIds(cmd.payload);
      if (ids === null) return 'moveGroup: payload.unitIds must be a non-empty array of up to 500 positive integers';
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'moveGroup: payload.owner must be an integer';
      }
      for (const id of ids) {
        const unit = findUnit(world, id);
        if (!unit) return `moveGroup: no unit with id ${id}`;
        if (unit.owner !== owner) return `moveGroup: unit ${id} is not owned by player ${owner}`;
      }
      // Final-review R1 (M10, 2026-10-01): the same sheltered guard as
      // moveUnit (validateOwnedUnit) — a parked/embarked aircraft in the
      // group rejects the whole order loudly instead of being silently
      // retasked (and yanked out of its hangar) by apply.
      for (const id of ids) {
        const unit = findUnit(world, id) as UnitRecord;
        if (isSheltered(unit)) return `moveGroup: unit ${id} is parked or embarked (launch it first)`;
      }
      // Per-unit domain validation (like moveUnit): air flies anywhere,
      // land needs land, sea needs water. A mixed group fails if ANY
      // member cannot reach the destination.
      for (const id of ids) {
        const unit = findUnit(world, id) as UnitRecord;
        const err = validateDestination(t, world.city, cmd.payload['x'], cmd.payload['z'], unit.domain);
        if (err) return `moveGroup: unit ${id} (${err})`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const ids = cmd.payload['unitIds'] as number[];
      const x = cmd.payload['x'] as number;
      const z = cmd.payload['z'] as number;
      return executeMoveGroup(ids, x, z, world, t, false);
    },
  });

  queue.register('attackMove', {
    validate(cmd, world): string | null {
      const ids = payloadUnitIds(cmd.payload);
      if (ids === null) return 'attackMove: payload.unitIds must be a non-empty array of up to 500 positive integers';
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'attackMove: payload.owner must be an integer';
      }
      for (const id of ids) {
        const unit = findUnit(world, id);
        if (!unit) return `attackMove: no unit with id ${id}`;
        if (unit.owner !== owner) return `attackMove: unit ${id} is not owned by player ${owner}`;
        if (isSheltered(unit)) return `attackMove: unit ${id} is parked or embarked (launch it first)`;
      }
      for (const id of ids) {
        const unit = findUnit(world, id) as UnitRecord;
        const err = validateDestination(t, world.city, cmd.payload['x'], cmd.payload['z'], unit.domain);
        if (err) return `attackMove: unit ${id} (${err})`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const ids = cmd.payload['unitIds'] as number[];
      const x = cmd.payload['x'] as number;
      const z = cmd.payload['z'] as number;
      return executeMoveGroup(ids, x, z, world, t, true);
    },
  });

  queue.register('stopUnit', {
    validate(cmd, world): string | null {
      const unit = validateOwnedUnit(world, cmd.payload['unitId'], cmd.payload['owner'], 'stopUnit');
      if (typeof unit === 'string') return unit;
      return null;
    },
    apply(cmd, world): unknown {
      const unit = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
      dropUnitRequests(world, unit.id);
      clearUnitOrder(unit);
      unit.targetId = 0;
      // Final-review R2: stop cancels a siege order as well.
      unit.buildingTargetId = 0;
      unit.chasing = false;
      unit.state = 'idle';
      unit.failReason = null;
      delete unit.attackMoving;
      delete unit.attackMoveDestX;
      delete unit.attackMoveDestZ;
      return unit.id;
    },
  });
}

function executeMoveGroup(
  ids: number[],
  x: number,
  z: number,
  world: World,
  t: TerrainData,
  attackMove: boolean,
): unknown {
  const destCell = worldToCell(x, z);
  // Ground units share one flow field; air units fly straight in
  // formation (no pathfinding, no water checks); sea units get
  // individual sea paths to water formation slots.
  const groundWaiting: number[] = [];
  const groundWaitingUnits: UnitRecord[] = [];
  const airWaiting: UnitRecord[] = [];
  const seaWaitingUnits: UnitRecord[] = [];
  let atDestCount = 0;
  let airAtDestCount = 0;
  let seaAtDestCount = 0;
  for (const id of ids) {
    const unit = findUnit(world, id) as UnitRecord;
    dropUnitRequests(world, id);
    clearUnitOrder(unit);
    unit.targetId = 0;
    unit.buildingTargetId = 0;
    unit.chasing = false;
    unit.destX = x;
    unit.destZ = z;
    unit.arriveX = x; // refined to a formation slot below
    unit.arriveZ = z;
    unit.failReason = null;
    if (attackMove) {
      unit.attackMoving = true;
      unit.attackMoveDestX = x;
      unit.attackMoveDestZ = z;
    } else {
      delete unit.attackMoving;
      delete unit.attackMoveDestX;
      delete unit.attackMoveDestZ;
    }
    if (unit.domain === 'air') {
      const arrived = dist2(x - unit.x, z - unit.z) < ARRIVAL_RADIUS * ARRIVAL_RADIUS;
      if (arrived) {
        unit.state = 'idle'; // already there
        airAtDestCount += 1;
      } else {
        unit.state = 'moving';
        airWaiting.push(unit);
      }
    } else if (unit.domain === 'sea') {
      const arrived = dist2(x - unit.x, z - unit.z) < ARRIVAL_RADIUS * ARRIVAL_RADIUS;
      if (arrived) {
        unit.state = 'idle'; // already there
        seaAtDestCount += 1;
      } else {
        seaWaitingUnits.push(unit);
      }
    } else if (isRailBound(unit.kind)) {
      // Phase 4 (S7): trains never join the flow field — route each
      // one individually along the rails (loud failures per train).
      orderTrainMoveTo(world, unit, x, z);
    } else if (worldToCell(unit.x, unit.z) === destCell) {
      unit.state = 'idle'; // already there
      atDestCount += 1;
    } else {
      unit.state = 'awaitingPath';
      groundWaiting.push(id);
      groundWaitingUnits.push(unit);
    }
  }
  // Formation slots: deterministic ranks; units already at the
  // destination occupy the first ranks so nobody stacks onto them.
  // Id order keeps the assignment deterministic.
  assignGroupSlots(world, t, groundWaitingUnits, atDestCount, x, z);
  assignAirSlots(airWaiting, airAtDestCount, x, z);
  // Sea units: water formation slots, then individual sea paths.
  // (No flow fields for sea — the field system is land-only.)
  assignSeaSlots(world, t, seaWaitingUnits, seaAtDestCount, x, z);
  for (const unit of seaWaitingUnits) {
    orderMoveTo(world, unit, unit.arriveX, unit.arriveZ, attackMove);
  }
  if (groundWaiting.length === 0) return [];
  const fieldId = requestField(world, groundWaiting, destCell);
  for (const id of groundWaiting) {
    (findUnit(world, id) as UnitRecord).fieldId = fieldId;
  }
  return fieldId;
}
