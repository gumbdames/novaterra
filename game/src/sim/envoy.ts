/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you are free to redistribute and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 */

/**
 * NOVATERRA — sim/envoy.ts — The Envoy at the Gates (fun-audit Tier 4
 * E1, 2026-10-02).
 *
 * The fantasy: diplomacy walks up your driveway. When the AI accepts
 * your ceasefire (or a proud AI refuses one, or a large wartime
 * tribute buys an audience), a black SUV flying the Directorate's
 * colors crosses the map to your capital, parks outside, and waits
 * sixty seconds. Accept a ceasefire and doves rise over your capital;
 * refuse and the convoy peels out.
 *
 * Mechanics:
 *   - The envoy is a scripted neutral non-combatant (`envoySUV`,
 *     owner NEUTRAL_OWNER, `neutralNonCombatant: true` on the def) —
 *     the SHARED immunity gate (see UnitDef.neutralNonCombatant):
 *     never acquired, never a valid attack target, never perceived
 *     as an enemy by the AI.
 *   - The 5-minute ceasefire clock starts when the player ANSWERS at
 *     the gates — not when the AI accepts (diplomacy.ts dispatches a
 *     `pendingEnvoyDispatch`; this system spawns the envoy on the
 *     next tick, keeping the import graph acyclic: this module
 *     value-imports diplomacy.ts, never the reverse).
 *   - `answerEnvoy(accept|decline)` through the command queue, with
 *     loud validation. Timeout applies the seeded default (an
 *     accepted offer still starts the ceasefire — no punishment for
 *     slow players).
 *   - The steelman case's explicit "war ended, recall envoy" path: if
 *     either side dies mid-ceremony, the envoy is recalled (drives
 *     off, no ceasefire).
 *
 * Player-side only in 0.1 Alpha: the envoy always visits the human
 * player (offer.owner); the AI never receives one.
 *
 * Plain data (`world.diplomacy.envoy`) — snapshotted + digested (the
 * envoy gates ceasefire timing). Ceremony VFX flows through
 * `world.ceremonyEvents` (drained like `world.combatEvents`: cleared
 * here at tick start, never snapshotted, never digested).
 *
 * Import discipline: value-imports city/units/movement/diplomacy/
 * deterministic/terrain/rng only. world.ts and commands.ts are
 * type-only. Nothing here value-imports envoy.ts except session.ts
 * (system registration + command wiring).
 */

import { getPlayer, MAP_HALF_SIZE, cellCenterWorld, capitalCenter } from './city';
import { createRngBank } from './rng';
import {
  spawnUnit,
  NEUTRAL_OWNER,
  type UnitRecord,
} from './units';
import { orderMoveTo } from './movement';
import { isWater, type TerrainData } from './terrain';
import {
  envoyActive,
  CEASEFIRE_TICKS,
  SNUB_DISPOSITION_LOSS,
  type EnvoyOffer,
  type EnvoyStatus,
  type PendingEnvoyDispatch,
} from './diplomacy';
import { killUnit } from './combat';
import type { World } from './world';
import type { CommandQueue } from './commands';

/**
 * Ceremony VFX event stream — the visual half of the envoy/combine/
 * luminary ceremonies. Drained by the render each frame (like
 * `world.combatEvents`); cleared by the envoy system at tick start;
 * NOT snapshotted, NOT digested — pure view, derived from
 * deterministic state. E2/E3 extend this union in their own commits.
 */
export type CeremonyEvent =
  | { kind: 'doveRelease'; x: number; z: number }
  | { kind: 'envoyArrived'; x: number; z: number }
  | { kind: 'envoyDeparted'; x: number; z: number };

/** The envoy waits 60 seconds for an answer (30 Hz × 60 s). */
export const ENVOY_WAIT_TICKS = 1800;
/** Arrival radius around the parking point (world units). */
export const ENVOY_PARK_RADIUS = 6;
/** Inbound watchdog: peel out if pathing never arrives (3 min). */
export const ENVOY_INBOUND_TIMEOUT_TICKS = 5400;
/** Drive-off watchdog: despawn even if the exit drive stalls (2 min). */
export const ENVOY_DEPART_TIMEOUT_TICKS = 3600;
/** How far outside the capital the envoy parks (world units). */
export const ENVOY_PARK_OFFSET = 25;
/** Map-edge inset for the envoy's entry/exit point (world units). */
export const ENVOY_EDGE_INSET = 6;
/** Seeded jitter on the entry point (world units, ±). */
export const ENVOY_ENTRY_JITTER = 20;
/** Recall-check cadence (ticks) — the liveness scan is O(units). */
const ENVOY_RECALL_EVERY_TICKS = 30;

// ---------------------------------------------------------------------------
// The capital helper lives in sim/city.ts (shared by the envoy and
// the luminary systems).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deterministic land siting (no banned transcendentals — the spiral is
// axis-aligned, not angular).
// ---------------------------------------------------------------------------

const SITE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** Clamp a world coordinate inside the playable map. */
function clampMap(v: number): number {
  const edge = MAP_HALF_SIZE - 1;
  return v < -edge ? -edge : v > edge ? edge : v;
}

/**
 * Find a land cell near (x, z): the point itself, else an expanding
 * axis-aligned spiral out to 120 units. Deterministic — pure geometry
 * over the static terrain. Falls back to the clamped point when no
 * land is found (degenerate all-water map; the caller guards).
 */
export function siteLandCell(
  terrain: TerrainData,
  x: number,
  z: number,
): { x: number; z: number } {
  const cx = clampMap(x);
  const cz = clampMap(z);
  if (!isWater(terrain, cx, cz)) return { x: cx, z: cz };
  for (let r = 4; r <= 120; r += 4) {
    for (const [dx, dz] of SITE_DIRS) {
      const px = clampMap(cx + dx * r);
      const pz = clampMap(cz + dz * r);
      if (!isWater(terrain, px, pz)) return { x: px, z: pz };
    }
  }
  return { x: cx, z: cz };
}

/**
 * The map-edge point nearest (x, z), inset by ENVOY_EDGE_INSET.
 * Pure geometry — deterministic.
 */
function nearestMapEdge(x: number, z: number): { x: number; z: number } {
  const edge = MAP_HALF_SIZE - ENVOY_EDGE_INSET;
  const dx = edge - Math.abs(x);
  const dz = edge - Math.abs(z);
  if (dx <= dz) return { x: x < 0 ? -edge : edge, z: clampMap(z) };
  return { x: clampMap(x), z: z < 0 ? -edge : edge };
}

// ---------------------------------------------------------------------------
// Dispatch + resolution.
// ---------------------------------------------------------------------------

/**
 * Spawn the envoy for a pending offer: a black SUV at the map-edge
 * land cell nearest the player's capital (seeded jitter), driving to
 * a parking point just outside the capital. Called by the envoy
 * system on the tick after diplomacy.ts records the dispatch.
 */
function dispatchEnvoy(world: World, terrain: TerrainData, offer: PendingEnvoyDispatch['offer']): void {
  const d = world.diplomacy;
  const capital = capitalCenter(world, offer.owner);
  const bank = createRngBank(world.seed, world.rng);
  const edge = nearestMapEdge(capital.x, capital.z);
  const jx = (bank.next('envoy') - 0.5) * 2 * ENVOY_ENTRY_JITTER;
  const jz = (bank.next('envoy') - 0.5) * 2 * ENVOY_ENTRY_JITTER;
  const spawn = siteLandCell(terrain, edge.x + jx, edge.z + jz);
  // Park outside the capital, on the side the envoy drove in from.
  const pdx = edge.x - capital.x;
  const pdz = edge.z - capital.z;
  const plen = Math.sqrt(pdx * pdx + pdz * pdz) || 1;
  const park = siteLandCell(
    terrain,
    capital.x + (pdx / plen) * ENVOY_PARK_OFFSET,
    capital.z + (pdz / plen) * ENVOY_PARK_OFFSET,
  );
  // Degenerate map (no land anywhere near): fizzle the ceremony rather
  // than stranding a land unit in water — never a stuck envoy.
  if (isWater(terrain, spawn.x, spawn.z) || isWater(terrain, park.x, park.z)) {
    return;
  }
  const unit = spawnUnit(world, 'envoySUV', NEUTRAL_OWNER, spawn.x, spawn.z);
  orderMoveTo(world, unit, park.x, park.z);
  d.envoy = {
    state: 'inbound',
    offer,
    unitId: unit.id,
    deadlineTick: 0,
    parkX: park.x,
    parkZ: park.z,
    exitX: edge.x,
    exitZ: edge.z,
    inboundSinceTick: world.tick,
    departByTick: 0,
    resolution: null,
    dovesPending: false,
  };
}

/**
 * True while both sides of the offer are still in the war — the
 * steelman case's explicit "war ended, recall envoy" path. Checked at
 * a 1-second cadence (the scan is O(units + buildings)).
 */
function warStillOn(world: World, offer: EnvoyOffer): boolean {
  if (!getPlayer(world.city, offer.owner) || !getPlayer(world.city, offer.aiOwner)) {
    return false;
  }
  let ownerAlive = false;
  let aiAlive = false;
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    if (u.owner === offer.owner) ownerAlive = true;
    else if (u.owner === offer.aiOwner) aiAlive = true;
    if (ownerAlive && aiAlive) return true;
  }
  for (const b of world.city.buildings) {
    if (b.owner === offer.owner) ownerAlive = true;
    else if (b.owner === offer.aiOwner) aiAlive = true;
    if (ownerAlive && aiAlive) return true;
  }
  return false;
}

/** Halt a unit via the public move API (order to its own cell idles it). */
function haltUnit(world: World, unit: UnitRecord): void {
  orderMoveTo(world, unit, unit.x, unit.z);
}

/**
 * Resolve the envoy's offer: apply the verdict, start the ceasefire
 * clock when the player accepts an accepted offer (doves rise over
 * the capital), and send the envoy home. One code path for answers,
 * timeouts, and recalls.
 */
function resolveEnvoyOffer(
  world: World,
  envoy: EnvoyStatus,
  resolution: EnvoyStatus['resolution'],
  accepted: boolean,
): void {
  const d = world.diplomacy;
  const unit = world.units.find((u) => u.id === envoy.unitId);
  // The 5-minute clock starts when the offer is accepted — by the
  // player's answer OR by the seeded timeout default (silence is
  // consent; no punishment for slow players). The `accepted` flag
  // carries that decision from the caller, so the timeout path
  // (resolution 'timedOut') starts the clock too — the resolution
  // string alone must not gate it.
  if (accepted && envoy.offer.verdict === 'accepted') {
    // The 5-minute clock starts HERE — when the envoy reaches the HQ
    // and the player answers (E1), not when the AI accepted.
    d.ceasefireUntilTick = world.tick + CEASEFIRE_TICKS;
    d.disposition = Math.min(100, d.disposition + SNUB_DISPOSITION_LOSS);
    d.lastCeasefireAsk = 'accepted';
    // The dove release is flagged, not emitted: the envoy system
    // emits it after its tick-start clear (commands apply before
    // systems in runTick, so a command-pushed event would be wiped
    // the same tick and the render would never see it).
    envoy.dovesPending = true;
  }
  envoy.state = 'departing';
  envoy.resolution = resolution;
  envoy.deadlineTick = 0;
  envoy.departByTick = world.tick + ENVOY_DEPART_TIMEOUT_TICKS;
  if (unit !== undefined && unit.hp > 0) {
    orderMoveTo(world, unit, envoy.exitX, envoy.exitZ);
  }
}

// ---------------------------------------------------------------------------
// The per-tick system.
// ---------------------------------------------------------------------------

/**
 * The envoy state machine, run every tick (registered in session.ts
 * after the movement system — the envoy drives through orderMoveTo).
 * Clears `world.ceremonyEvents` at tick start (the combatEvents
 * precedent): this system is the earliest ceremony emitter, so later
 * emitters (combine, luminaries) survive until the next tick.
 */
export function createEnvoySystem(terrain: TerrainData): (world: World) => void {
  return (world: World): void => {
    world.ceremonyEvents.length = 0;
    const d = world.diplomacy;
    // A decided-but-undispatched offer becomes a live envoy.
    if (d.pendingEnvoyDispatch !== null && d.envoy === null) {
      const offer = d.pendingEnvoyDispatch.offer;
      d.pendingEnvoyDispatch = null;
      dispatchEnvoy(world, terrain, offer);
    }
    const envoy = d.envoy;
    if (envoy === null) return;
    // The dove release is emitted here — after the tick-start clear —
    // because resolveEnvoyOffer runs in command apply (before systems
    // in runTick) and a directly-pushed event would be wiped the same
    // tick. The render drains ceremonyEvents after the tick, so the
    // release is visible for exactly one frame of sim time.
    if (envoy.dovesPending) {
      envoy.dovesPending = false;
      const capital = capitalCenter(world, envoy.offer.owner);
      world.ceremonyEvents.push({ kind: 'doveRelease', x: capital.x, z: capital.z });
    }
    const unit = world.units.find((u) => u.id === envoy.unitId);
    // The envoy is gone (unreachable through combat — the immunity
    // gate — but "no bugs" handles it anyway): the ceremony fizzles
    // with no ceasefire and no crash.
    if (unit === undefined || unit.hp <= 0) {
      d.envoy = null;
      return;
    }
    // The war ended under the ceremony (either side destroyed): recall
    // the envoy — it drives home, no offer, no ceasefire.
    if (world.tick % ENVOY_RECALL_EVERY_TICKS === 0 && !warStillOn(world, envoy.offer)) {
      resolveEnvoyOffer(world, envoy, 'recalled', false);
      return;
    }
    if (envoy.state === 'inbound') {
      // Stuck pathing (or a waterlogged spawn the siting missed):
      // peel out rather than blocking diplomacy forever.
      if (world.tick - envoy.inboundSinceTick >= ENVOY_INBOUND_TIMEOUT_TICKS) {
        resolveEnvoyOffer(world, envoy, 'recalled', false);
        return;
      }
      const dx = envoy.parkX - unit.x;
      const dz = envoy.parkZ - unit.z;
      if (dx * dx + dz * dz <= ENVOY_PARK_RADIUS * ENVOY_PARK_RADIUS) {
        haltUnit(world, unit);
        envoy.state = 'waiting';
        envoy.deadlineTick = world.tick + ENVOY_WAIT_TICKS;
        world.ceremonyEvents.push({ kind: 'envoyArrived', x: unit.x, z: unit.z });
      }
    } else if (envoy.state === 'waiting') {
      // Timeout: the seeded default — the offer stands (an accepted
      // ceasefire still starts; no punishment for slow players).
      if (world.tick >= envoy.deadlineTick) {
        const accepted = envoy.offer.verdict === 'accepted';
        resolveEnvoyOffer(world, envoy, 'timedOut', accepted);
      }
    } else {
      // Departing: despawn at the map edge (or on the watchdog).
      const dx = envoy.exitX - unit.x;
      const dz = envoy.exitZ - unit.z;
      const arrived =
        dx * dx + dz * dz <= ENVOY_PARK_RADIUS * ENVOY_PARK_RADIUS;
      if (arrived || world.tick >= envoy.departByTick) {
        killUnit(world, unit);
        world.ceremonyEvents.push({ kind: 'envoyDeparted', x: unit.x, z: unit.z });
        d.envoy = null;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/** Register the `answerEnvoy` command. */
export function registerEnvoyCommands(queue: CommandQueue): void {
  queue.register('answerEnvoy', {
    validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null) return 'answerEnvoy: payload.owner must be an integer';
      if (typeof cmd.payload['accept'] !== 'boolean') {
        return 'answerEnvoy: payload.accept must be a boolean';
      }
      const envoy = world.diplomacy.envoy;
      if (envoy === null || !envoyActive(world)) {
        return 'answerEnvoy: no envoy is at your gates';
      }
      if (envoy.state !== 'waiting') {
        return `answerEnvoy: the envoy is still ${envoy.state} (answer while it waits at your gates)`;
      }
      if (envoy.offer.owner !== owner) {
        return 'answerEnvoy: only the visited player can answer the envoy';
      }
      return null;
    },
    apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
      const envoy = world.diplomacy.envoy;
      // Re-check at apply (the ceremony may have resolved since enqueue).
      if (envoy === null || envoy.state !== 'waiting') {
        throw new Error('answerEnvoy: the envoy is gone at apply time');
      }
      const owner = cmd.payload['owner'] as number;
      if (envoy.offer.owner !== owner) {
        throw new Error('answerEnvoy: only the visited player can answer the envoy');
      }
      const accept = cmd.payload['accept'] as boolean;
      resolveEnvoyOffer(world, envoy, accept ? 'accepted' : 'declined', accept);
      return accept ? 'accepted' : 'declined';
    },
  });
}

