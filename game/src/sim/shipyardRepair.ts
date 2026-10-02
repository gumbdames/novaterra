/**
 * sim/shipyardRepair.ts — drydock repair at production shipyards.
 *
 * User-approved naval-building model (2026-10-01): shipyards BUILD and
 * REPAIR; docks are the logistics interface and do NOT repair. A damaged
 * sea unit of the same side (civilian/military) whose owner holds an
 * operational shipyard within SHIPYARD_REPAIR_RADIUS regains
 * SHIPYARD_REPAIR_PER_SEC hp/s, capped at the veterancy-adjusted max —
 * the same cap the heal auras use, so a repaired ship never exceeds what
 * a medic could fill.
 *
 * Side matching keys on the defs' `military` flag: the civilian
 * commercialHarbor repairs civilian hulls; the military shipyard and
 * navalYard repair military hulls. Docks (commercialPort, containerPort,
 * fishingHarbor, navalBase) are deliberately excluded — production vs.
 * logistics stays unblurred per the approved model.
 *
 * Determinism: buildings iterate in id order, units in id order, no RNG.
 * Repair is derived from positions each tick — no new unit/building
 * fields, so the snapshot format and digest registry are untouched.
 * `isShipUnderRepair` is the UI's read path (unit detail panel's repair
 * badge) so the UI never duplicates the sim's eligibility logic.
 */
import { BUILDING_DEFS, buildingCenterWorld, type BuildingKind } from './city';
import { UNIT_DEFS, type UnitKind, type UnitRecord } from './units';
import { vetAdjustedMaxHp } from './veterancy';
import { dist2 } from './deterministic';
import type { World } from './world';

/** Drydock aura radius, world units (heal-aura scale: medic 12, repairShip 15). */
export const SHIPYARD_REPAIR_RADIUS = 14;
/**
 * Drydock repair rate, hp/s. Faster than field repair (repairShip 1.5/s,
 * combatMedic 2/s) — a drydock is the real thing — but slow enough that
 * dragging a crippled freighter home is a decision, not a reflex
 * (a 300-hp freighter at half health takes ~50 s to refill).
 */
export const SHIPYARD_REPAIR_PER_SEC = 3;
/**
 * Building keys that count as drydocks. KEYS, never user-facing names —
 * renames don't affect this set and old saves keep working.
 */
export const SHIPYARD_REPAIR_KINDS: ReadonlySet<string> = new Set([
  'commercialHarbor', // civilian shipyard (builds + repairs civilian ships)
  'shipyard', // military shipyard (light/support craft)
  'navalYard', // military shipyard (heavy combatants)
]);

interface Drydock {
  owner: number;
  military: boolean;
  x: number;
  z: number;
}

/** Live, operational drydocks in id order. Exported for tests. */
export function liveDrydocks(world: World): Drydock[] {
  const docks: Drydock[] = [];
  // city.buildings is spawn-ordered in practice, but the determinism
  // contract wants it proven: sort by id (the economy.ts precedent).
  const ordered = [...world.city.buildings].sort((a, b) => a.id - b.id);
  for (const b of ordered) {
    if (!SHIPYARD_REPAIR_KINDS.has(b.kind)) continue;
    if (!b.operational || (b.hp ?? 0) <= 0) continue;
    const bdef = BUILDING_DEFS[b.kind as BuildingKind];
    if (!bdef) continue;
    const c = buildingCenterWorld(b);
    docks.push({ owner: b.owner, military: !!bdef.military, x: c.x, z: c.z });
  }
  return docks;
}

/**
 * Per-tick drydock repair pass. Called from the combat system right after
 * the heal auras (same "restore hp" family, same determinism contract).
 */
export function runShipyardRepair(world: World, dt: number): void {
  if (dt <= 0) return;
  const docks = liveDrydocks(world);
  if (docks.length === 0) return;
  const amount = SHIPYARD_REPAIR_PER_SEC * dt;
  for (const u of world.units) {
    if (u.hp <= 0 || u.domain !== 'sea') continue;
    const udef = UNIT_DEFS[u.kind as UnitKind];
    if (!udef) continue;
    const maxHp = vetAdjustedMaxHp(world, u);
    if (u.hp >= maxHp) continue;
    const unitMilitary = !!udef.military;
    for (const d of docks) {
      if (d.owner !== u.owner || d.military !== unitMilitary) continue;
      const inDrydockRange = dist2(u.x - d.x, u.z - d.z) <= SHIPYARD_REPAIR_RADIUS * SHIPYARD_REPAIR_RADIUS;
      if (inDrydockRange) {
        u.hp = Math.min(maxHp, u.hp + amount);
        break; // one drydock is enough; no stacking
      }
    }
  }
}

/**
 * UI read path: is this unit currently gaining hp from a drydock?
 * Same eligibility as the pass, without mutating anything.
 */
export function isShipUnderRepair(world: World, unit: UnitRecord): boolean {
  if (unit.hp <= 0 || unit.domain !== 'sea') return false;
  const udef = UNIT_DEFS[unit.kind as UnitKind];
  if (!udef) return false;
  if (unit.hp >= vetAdjustedMaxHp(world, unit)) return false;
  const unitMilitary = !!udef.military;
  for (const d of liveDrydocks(world)) {
    if (d.owner !== unit.owner || d.military !== unitMilitary) continue;
    if (dist2(unit.x - d.x, unit.z - d.z) <= SHIPYARD_REPAIR_RADIUS * SHIPYARD_REPAIR_RADIUS) return true;
  }
  return false;
}
