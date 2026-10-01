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
 * NOVATERRA — sim/superweapons.ts — Aegis and Storm Engine.
 *
 * Design (Phase 3):
 *  - Two Ascendance-age superweapons, each requiring a special building:
 *      Aegis:        needs an Aegis Control building. Firing raises a
 *                    city-wide energy shield that blocks ALL damage to the
 *                    owner's units for 60 seconds.
 *      Storm Engine: needs a Storm Array building. Firing calls down 8
 *                    lightning strikes over ~8 seconds around a target
 *                    point (120 damage each in a radius of 10, small
 *                    deterministic scatter).
 *  - Both are expensive with a 10-minute cooldown: game-changing, not
 *    game-breaking. Firing goes through the command queue (loud
 *    validation: age, building, cooldown).
 *  - The Marshal Classic AI can build them too: it has no physical city
 *    (the AI doesn't place buildings in 0.1 Alpha), so it pays the same
 *    building cost upfront and waits the same build time — tracked as a
 *    deterministic construction project on its AI state — then fires
 *    through the same commands, aiming only at visible enemies (fair).
 *  - Aegis is honored in combat.ts's fireWeapon (which reads
 *    world.superweapons directly — importing this module there would
 *    create a combat ⇄ superweapons cycle, since the storm system needs
 *    combat's killUnit).
 *  - Visual effects are deterministic sim state (`fx` entries with expiry
 *    ticks): the renderer draws them, the sim owns their timing.
 *
 * State is plain JSON-safe data, snapshotted (v5) and digested.
 *
 * Pure module: no DOM, no three.js, no wall clock, no Math.random.
 * Safe under Node/vitest.
 */

import type { World } from './world';
import { rngBank } from './world';
import type { CommandQueue, CommandSpec } from './commands';
import type { SimSystem } from './tick';
import { BUILDING_DEFS, getPlayer, buildingCenterWorld, cellCenterWorld } from './city';
import { killUnit, damageBuilding, flushDeadTargetRefs } from './combat';
import { getAgeState } from './ages';

/** Aegis shield duration: 60 seconds at 30 Hz. */
export const AEGIS_DURATION_TICKS = 1800;
/** Cooldown after firing either superweapon: 10 game-minutes. */
export const SUPERWEAPON_COOLDOWN_TICKS = 18000;
/** Storm Engine: number of lightning strikes per firing. */
export const STORM_STRIKE_COUNT = 8;
/** Ticks between storm strikes (~1 second). */
export const STORM_STRIKE_INTERVAL_TICKS = 30;
/** Damage per storm strike. */
export const STORM_DAMAGE = 120;
/** Damage radius per strike (world units). */
export const STORM_RADIUS = 10;
/** Deterministic scatter of each strike around the target point. */
export const STORM_SCATTER = 3;
/** Ticks a storm flash stays visible to the renderer. */
export const STORM_FX_TICKS = 45;

/** Cooldown + active window for one superweapon of one player. */
export interface SuperweaponSlot {
  /** Tick when the weapon may next fire. */
  cooldownUntil: number;
  /** Aegis only: tick when the shield drops (0 = no shield up). */
  activeUntil: number;
}

/** Both superweapon slots for one player. */
export interface PlayerSuperweapons {
  owner: number;
  aegis: SuperweaponSlot;
  storm: SuperweaponSlot;
}

/** A scheduled Storm Engine lightning strike. */
export interface StormStrike {
  owner: number;
  x: number;
  z: number;
  atTick: number;
}

/** A deterministic visual effect for the renderer (expires by tick). */
export interface WeaponFx {
  kind: 'storm' | 'aegis';
  x: number;
  z: number;
  untilTick: number;
}

/** Superweapon state. Plain data — snapshotted + digested. */
export interface SuperweaponState {
  players: PlayerSuperweapons[];
  /** Pending storm strikes, in scheduled order. */
  strikes: StormStrike[];
  /** Recent effects for the renderer (deterministic expiry). */
  fx: WeaponFx[];
}

/** Fresh superweapon state: nothing built, nothing scheduled. */
export function initSuperweapons(): SuperweaponState {
  return { players: [], strikes: [], fx: [] };
}

function freshSlot(): SuperweaponSlot {
  return { cooldownUntil: 0, activeUntil: 0 };
}

/** Find a player's superweapon slots (no creation — pure read). */
export function findPlayerSuperweapons(world: World, owner: number): PlayerSuperweapons | undefined {
  return world.superweapons.players.find((p) => p.owner === owner);
}

/** Get a player's superweapon slots, creating them on first use. */
export function getPlayerSuperweapons(world: World, owner: number): PlayerSuperweapons {
  let p = findPlayerSuperweapons(world, owner);
  if (!p) {
    p = { owner, aegis: freshSlot(), storm: freshSlot() };
    world.superweapons.players.push(p);
  }
  return p;
}

/** True while the owner's Aegis shield is up. */
export function isAegisActive(world: World, owner: number): boolean {
  const p = findPlayerSuperweapons(world, owner);
  return !!p && world.tick < p.aegis.activeUntil;
}

/**
 * A completed, operating Aegis Control building for this owner — or a
 * completed Marshal-AI construction project (the AI builds no physical
 * city in 0.1 Alpha; it pays the same cost and waits the same build time).
 */
export function hasAegisFacility(world: World, owner: number): boolean {
  for (const b of world.city.buildings) {
    if (b.owner === owner && b.kind === 'aegisControl' && b.progress >= 1 && b.operational) {
      return true;
    }
  }
  const ai = world.ai.players.find((p) => p.owner === owner);
  return !!ai && ai.difficulty === 'marshal' && world.tick >= ai.superweapons.aegisReadyTick && ai.superweapons.aegisReadyTick > 0;
}

/** Same as hasAegisFacility, for the Storm Array. */
export function hasStormFacility(world: World, owner: number): boolean {
  for (const b of world.city.buildings) {
    if (b.owner === owner && b.kind === 'stormArray' && b.progress >= 1 && b.operational) {
      return true;
    }
  }
  const ai = world.ai.players.find((p) => p.owner === owner);
  return !!ai && ai.difficulty === 'marshal' && world.tick >= ai.superweapons.stormReadyTick && ai.superweapons.stormReadyTick > 0;
}

/** Aegis can fire: Ascendance + facility + cooldown elapsed + no shield up. */
export function isAegisReady(world: World, owner: number): boolean {
  if (getAgeState(world, owner).age !== 'ascendance') return false; // per-side ages: the owner's own age
  if (!hasAegisFacility(world, owner)) return false;
  const p = findPlayerSuperweapons(world, owner);
  if (!p) return true; // no slot yet = never fired
  return world.tick >= p.aegis.cooldownUntil && !isAegisActive(world, owner);
}

/** Storm Engine can fire: Ascendance + facility + cooldown elapsed. */
export function isStormReady(world: World, owner: number): boolean {
  if (getAgeState(world, owner).age !== 'ascendance') return false; // per-side ages: the owner's own age
  if (!hasStormFacility(world, owner)) return false;
  const p = findPlayerSuperweapons(world, owner);
  if (!p) return true;
  return world.tick >= p.storm.cooldownUntil;
}

/**
 * World-unit centroid of an owner's completed buildings (dome anchor;
 * 0,0 when none). Final-review R1 (M18, 2026-10-01): the average is over
 * building CELL coordinates, so each term must be converted to world
 * units — pushing raw cell indices into the fx record (which the
 * renderer positions in world space) put the dome near the map origin
 * instead of over the base.
 */
function ownerBaseCentroid(world: World, owner: number): { x: number; z: number } {
  let x = 0;
  let z = 0;
  let n = 0;
  for (const b of world.city.buildings) {
    if (b.owner === owner && b.progress >= 1) {
      x += cellCenterWorld(b.cx);
      z += cellCenterWorld(b.cz);
      n += 1;
    }
  }
  return n === 0 ? { x: 0, z: 0 } : { x: x / n, z: z / n };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function payloadNum(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function payloadStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

const fireAegisSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) return 'fireAegis: unknown owner';
    // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): superweapons
    // are military apparatus — the Aegis Control building itself is a
    // military def. Loud rejection, never silent. Defense in depth on
    // top of the placeBuilding lockout: a facility can never be built
    // in a peaceful world, but this gate closes the fire path even if
    // one somehow existed (e.g. a future save migration edge).
    if (world.peaceful === true) return 'fireAegis: superweapons are not available in peaceful mode';
    if (getAgeState(world, owner).age !== 'ascendance') return 'fireAegis: requires the Ascendance age';
    if (!hasAegisFacility(world, owner)) {
      return 'fireAegis: requires a completed Aegis Control building';
    }
    const p = findPlayerSuperweapons(world, owner);
    if (p) {
      if (world.tick < p.aegis.cooldownUntil) {
        return `fireAegis: cooling down (${p.aegis.cooldownUntil - world.tick} ticks left)`;
      }
      if (world.tick < p.aegis.activeUntil) return 'fireAegis: shield already up';
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const p = getPlayerSuperweapons(world, owner);
    p.aegis.activeUntil = world.tick + AEGIS_DURATION_TICKS;
    p.aegis.cooldownUntil = world.tick + SUPERWEAPON_COOLDOWN_TICKS;
    const base = ownerBaseCentroid(world, owner);
    world.superweapons.fx.push({
      kind: 'aegis', x: base.x, z: base.z, untilTick: p.aegis.activeUntil,
    });
    return { owner, activeUntil: p.aegis.activeUntil };
  },
};

const fireStormSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) return 'fireStorm: unknown owner';
    // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): the Storm
    // Array is a military def and the strike is the game's only attack
    // path (also the only meltdown trigger). Locked out loudly in
    // peaceful worlds — this is the gate that keeps "meltdowns are
    // impossible in peaceful mode" true even for the Marshal AI's
    // virtual-construction path, whose `constructSuperweaponFacility`
    // validate carries the same gate below.
    if (world.peaceful === true) return 'fireStorm: superweapons are not available in peaceful mode';
    if (getAgeState(world, owner).age !== 'ascendance') return 'fireStorm: requires the Ascendance age';
    if (!hasStormFacility(world, owner)) {
      return 'fireStorm: requires a completed Storm Array building';
    }
    const x = payloadNum(cmd.payload, 'x');
    const z = payloadNum(cmd.payload, 'z');
    if (x === null || z === null) return 'fireStorm: payload needs finite x and z';
    const p = findPlayerSuperweapons(world, owner);
    if (p && world.tick < p.storm.cooldownUntil) {
      return `fireStorm: cooling down (${p.storm.cooldownUntil - world.tick} ticks left)`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const x = payloadNum(cmd.payload, 'x') as number;
    const z = payloadNum(cmd.payload, 'z') as number;
    const p = getPlayerSuperweapons(world, owner);
    p.storm.cooldownUntil = world.tick + SUPERWEAPON_COOLDOWN_TICKS;
    for (let i = 0; i < STORM_STRIKE_COUNT; i += 1) {
      world.superweapons.strikes.push({
        owner, x, z, atTick: world.tick + (i + 1) * STORM_STRIKE_INTERVAL_TICKS,
      });
    }
    return { owner, x, z, strikes: STORM_STRIKE_COUNT };
  },
};

/**
 * Marshal-AI construction: pays the building cost now, facility comes
 * online after the building's build time. The AI places no physical
 * buildings in 0.1 Alpha; cost and timing match the player's exactly.
 */
const constructFacilitySpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) {
      return 'constructSuperweaponFacility: unknown owner';
    }
    const kind = payloadStr(cmd.payload, 'kind');
    if (kind !== 'aegis' && kind !== 'storm') {
      return "constructSuperweaponFacility: kind must be 'aegis' or 'storm'";
    }
    const ai = world.ai.players.find((a) => a.owner === owner);
    // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): the facility
    // kind is a military def (stormArray / aegisControl) — rejected for
    // everyone, before the difficulty check. The Marshal AI's `issue`
    // wrapper already swallows the rejection, so it keeps playing
    // peacefully without stalling or crashing.
    if (world.peaceful === true) {
      return 'constructSuperweaponFacility: superweapons are not available in peaceful mode';
    }
    if (!ai || ai.difficulty !== 'marshal') {
      return 'constructSuperweaponFacility: only a Marshal AI builds this way';
    }
    if (getAgeState(world, ai.owner).age !== 'ascendance') { // per-side ages: the AI's own age
      return 'constructSuperweaponFacility: requires the Ascendance age';
    }
    const sw = ai.superweapons;
    const readyTick = kind === 'aegis' ? sw.aegisReadyTick : sw.stormReadyTick;
    if (readyTick > 0) return `constructSuperweaponFacility: ${kind} already built or building`;
    const def = BUILDING_DEFS[kind === 'aegis' ? 'aegisControl' : 'stormArray'];
    const player = getPlayer(world.city, owner);
    if (!player) return 'constructSuperweaponFacility: unknown owner';
    if (player.funds < def.costFunds || player.materials < def.costMaterials) {
      return `constructSuperweaponFacility: cannot afford ${def.name}`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const kind = payloadStr(cmd.payload, 'kind') as 'aegis' | 'storm';
    const def = BUILDING_DEFS[kind === 'aegis' ? 'aegisControl' : 'stormArray'];
    const player = getPlayer(world.city, owner);
    if (!player) throw new Error('constructSuperweaponFacility: unknown owner at apply');
    const ai = world.ai.players.find((a) => a.owner === owner);
    if (!ai) throw new Error('constructSuperweaponFacility: no AI player at apply');
    player.funds -= def.costFunds;
    player.materials -= def.costMaterials;
    const readyTick = world.tick + def.buildSeconds * 30;
    if (kind === 'aegis') ai.superweapons.aegisReadyTick = readyTick;
    else ai.superweapons.stormReadyTick = readyTick;
    return { owner, kind, readyTick };
  },
};

/** Register the superweapon command kinds on a queue. */
export function registerSuperweaponCommands(queue: CommandQueue): void {
  queue.register('fireAegis', fireAegisSpec);
  queue.register('fireStorm', fireStormSpec);
  queue.register('constructSuperweaponFacility', constructFacilitySpec);
}

// ---------------------------------------------------------------------------
// Snapshot encoding
// ---------------------------------------------------------------------------

/** Canonical JSON-safe encoding for snapshots and digests. */
export function encodeSuperweaponState(sw: SuperweaponState): unknown {
  return {
    players: sw.players.map((p) => ({
      owner: p.owner,
      aegis: { cooldownUntil: p.aegis.cooldownUntil, activeUntil: p.aegis.activeUntil },
      storm: { cooldownUntil: p.storm.cooldownUntil, activeUntil: p.storm.activeUntil },
    })),
    strikes: sw.strikes.map((s) => ({ owner: s.owner, x: s.x, z: s.z, atTick: s.atTick })),
    fx: sw.fx.map((f) => ({ kind: f.kind, x: f.x, z: f.z, untilTick: f.untilTick })),
  };
}

function isFxKind(k: unknown): k is 'storm' | 'aegis' {
  return k === 'storm' || k === 'aegis';
}

/** Restore superweapon state from a snapshot payload. */
export function decodeSuperweaponState(data: unknown): SuperweaponState {
  const d = data as {
    players?: { owner: unknown; aegis?: { cooldownUntil: unknown; activeUntil: unknown }; storm?: { cooldownUntil: unknown; activeUntil: unknown } }[];
    strikes?: { owner: unknown; x: unknown; z: unknown; atTick: unknown }[];
    fx?: { kind: unknown; x: unknown; z: unknown; untilTick: unknown }[];
  };
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const players: PlayerSuperweapons[] = [];
  for (const p of d?.players ?? []) {
    if (typeof p.owner !== 'number' || !Number.isInteger(p.owner)) continue;
    players.push({
      owner: p.owner,
      aegis: { cooldownUntil: num(p.aegis?.cooldownUntil), activeUntil: num(p.aegis?.activeUntil) },
      storm: { cooldownUntil: num(p.storm?.cooldownUntil), activeUntil: num(p.storm?.activeUntil) },
    });
  }
  const strikes: StormStrike[] = [];
  for (const s of d?.strikes ?? []) {
    if (typeof s.owner !== 'number' || !Number.isInteger(s.owner)) continue;
    if (typeof s.atTick !== 'number' || !Number.isInteger(s.atTick)) continue;
    strikes.push({ owner: s.owner, x: num(s.x), z: num(s.z), atTick: s.atTick });
  }
  const fx: WeaponFx[] = [];
  for (const f of d?.fx ?? []) {
    if (!isFxKind(f.kind)) continue;
    if (typeof f.untilTick !== 'number' || !Number.isInteger(f.untilTick)) continue;
    fx.push({ kind: f.kind, x: num(f.x), z: num(f.z), untilTick: f.untilTick });
  }
  return { players, strikes, fx };
}

// ---------------------------------------------------------------------------
// System: resolve storm strikes, expire fx
// ---------------------------------------------------------------------------

/**
 * Superweapon system: resolves due storm strikes (deterministic scatter
 * from the 'superweapon' RNG stream, Aegis-aware damage, kills via
 * combat's killUnit) and expires renderer fx entries by tick.
 */
export function createSuperweaponSystem(): SimSystem {
  return (world: World, _dt: number): void => {
    const sw = world.superweapons;
    if (sw.strikes.length > 0) {
      const bank = rngBank(world);
      const due = sw.strikes.filter((s) => s.atTick <= world.tick);
      for (const strike of due) {
        const sx = strike.x + (bank.next('superweapon') * 2 - 1) * STORM_SCATTER;
        const sz = strike.z + (bank.next('superweapon') * 2 - 1) * STORM_SCATTER;
        // Copy: killUnit splices world.units during iteration.
        for (const unit of [...world.units]) {
          if (unit.owner === strike.owner || unit.hp <= 0) continue;
          if (Math.hypot(unit.x - sx, unit.z - sz) > STORM_RADIUS) continue;
          if (isAegisActive(world, unit.owner)) continue; // shield holds
          unit.hp -= STORM_DAMAGE;
          if (unit.hp <= 0) killUnit(world, unit);
        }
        // Final-review R2 (2026-10-01): buildings have HP now, so the
        // strike damages every enemy building in the blast radius
        // (STORM_DAMAGE each, through damageBuilding — the one attack
        // path). The nuclear meltdown roll moved into damageBuilding,
        // so a strike on a nuclear plant still rolls for meltdown
        // exactly as before. An active Aegis shield holds. Copy: the
        // damage path splices world.city.buildings on destruction.
        for (const b of [...world.city.buildings]) {
          if (b.owner === strike.owner) continue;
          if (isAegisActive(world, b.owner)) continue; // shield holds
          const c = buildingCenterWorld(b);
          if (Math.hypot(c.x - sx, c.z - sz) > STORM_RADIUS) continue;
          damageBuilding(world, b, STORM_DAMAGE);
        }
        sw.fx.push({ kind: 'storm', x: sx, z: sz, untilTick: world.tick + STORM_FX_TICKS });
      }
      sw.strikes = sw.strikes.filter((s) => s.atTick > world.tick);
      // R3 perf (2026-10-01): one batched target-ref sweep for every
      // kill this strike batch caused — killUnit defers its per-kill
      // O(units) attacker scan (see combat.ts).
      flushDeadTargetRefs(world);
    }
    if (sw.fx.length > 0) {
      sw.fx = sw.fx.filter((f) => f.untilTick > world.tick);
    }
  };
}
