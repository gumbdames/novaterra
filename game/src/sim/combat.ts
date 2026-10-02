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
 * NOVATERRA — sim/combat.ts — combat resolution and the attack order.
 *
 * Responsibilities:
 * - Opportunistic fire (units engage enemies in range each tick).
 * - The attack order (explicit player/AI targeting).
 * - Siege (units attack buildings).
 * - Death and cleanup (killUnit).
 * - Combat VFX events (B16, 2026-10-01): the `CombatEvent` stream —
 *   `world.combatEvents` accumulates visual cues (muzzle, impact,
 *   explosion) during the tick for the render layer to consume. The
 *   render layer drains it each frame; the sim clears it at the start
 *   of each tick. Not snapshotted, not digested (pure view).
 *
 *  - The combat system (`createCombatSystem`), registered AFTER movement
 *    every tick: positions are final for the tick before weapons fire.
 *  - Target acquisition: units with weapons automatically engage the
 *    nearest enemy inside their weapon range (opportunistic fire — they
 *    hold position, they don't chase). The `attackUnit` command gives an
 *    explicit target that the unit chases until it dies or a new order
 *    arrives. Acquisition runs on a per-tick dense grid (R1
 *    final-review H1): O(n) rebuild per tick, O(nearby) per query —
 *    results are exactly the legacy full scan's (order-independent
 *    nearest-with-id-tiebreak, same filters).
 *  - Damage with readable counters (see UNIT_DEFS in `units.ts`): the
 *    per-kind vsLight/vsMedium/vsHeavy/vsAir multipliers make tanks beat
 *    rifles, artillery beat tanks at range, AA beat anything that flies,
 *    and so on. A nearby friendly Mobile HQ adds a damage aura.
 *  - Buildings are destructible (final-review R2, 2026-10-01): every
 *    `BuildingDef` carries `hp` (see the scale on `BuildingDef` in
 *    city.ts) and records track `hp`/`maxHp`. The `attackBuilding`
 *    command orders an explicit siege — the unit chases the building's
 *    footprint center and fires raw weapon damage at it (no armor
 *    counters: buildings have no armor class; veterancy and supply
 *    state still scale the shot). Destroyed buildings go through
 *    `destroyBuilding` (city.ts) — the same full cleanup as the
 *    `demolish` command. Units never auto-acquire buildings:
 *    opportunistic fire is unit-vs-unit only; siege is always an
 *    explicit order (player right-click, AI siege doctrine).
 *  - Death: hp <= 0 removes the unit from `world.units` and cleans up
 *    its pathfinding requests, field membership, and everyone targeting
 *    it.
 *
 * Determinism: units fire in id order; target ties break by id; no RNG
 * in the damage formula (all variance is positional). The `combat` RNG
 * stream exists for future use (e.g. muzzle jitter) and is not consumed
 * here.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { SimSystem } from './tick';
import { TICK_DT, TICK_HZ } from './tick';
import { dist, dist2 } from './deterministic';
import type { CommandQueue } from './commands';
// Phase 3 logistics: death releases the unit's in-flight depot
// reservation (value import — the release logic lives in commands.ts).
import { releaseUnitReservation } from './commands';
import {
  findUnit,
  clearUnitOrder,
  removeUnitFromIndex,
  UNIT_DEFS,
  HQ_AURA_DAMAGE_BONUS,
  supplyDamageFactor,
  isSheltered,
  type UnitRecord,
  type UnitKind,
  type UnitDef,
} from './units';
import {
  hasUpgrade,
  effectiveRange,
  effectiveHealPerSec,
  AP_ROUNDS_KINDS,
  AP_ROUNDS_VS_HEAVY_MULT,
  AVIONICS_KINDS,
  AVIONICS_VS_AIR_MULT,
  SONAR_KINDS,
  SONAR_VS_MEDIUM_MULT,
} from './upgrades';
import {
  awardKillXp,
  vetCooldownTicks,
  vetDamageMult,
  vetAdjustedMaxHp,
  VET_MAX_LEVEL,
  VET_ELITE_REGEN_PER_SEC,
} from './veterancy';
import { orderMoveTo } from './movement';
import {
  MAP_HALF_SIZE,
  BUILDING_DEFS,
  destroyBuilding,
  buildingCenterWorld,
  cellCenterWorld,
  cellIndex,
  cellCoords,
  inBounds,
} from './city';
import type { BuildingRecord, CityState } from './city';
import type { TerrainData } from './terrain';
import { cellMoveCost } from './pathfinding';
import { isDetected } from './intel';
import { ceasefireActive, breakCeasefire, isAIOwner, isCeasefirePair } from './diplomacy';
import {
  attackMeltdownRoll,
  MELTDOWN_ATTACK_DENOMINATOR,
  MELTDOWN_OFFLINE_SECONDS,
} from './utilityNetworks';
import { runShipyardRepair } from './shipyardRepair';

/**
 * A visual combat cue for the render layer (B16, 2026-10-01).
 * The sim emits these; `render/combatVfx.ts` consumes them.
 * - `muzzle`: a weapon fired (attacker → target). Render: muzzle flash
 *   at (x,z) + tracer to (targetX,targetZ).
 * - `impact`: a shot hit without destroying the target. Render: small
 *   hit flash / spark at (x,z).
 * - `explosion`: a unit or building was destroyed. Render: explosion
 *   flash + smoke at (x,z); `large` for buildings / heavy units.
 *
 * Roadmap B13 (2026-10-02): `impact` and `explosion` also carry the
 * damage dealt and both owners, so the render layer can float damage
 * numbers (colored by whether the human side dealt or took the hit)
 * and shake the camera on explosions. Additive — B16 consumers read
 * only the fields they need.
 */
export type CombatEvent =
  | { kind: 'muzzle'; x: number; z: number; targetX: number; targetZ: number }
  | {
      kind: 'impact';
      x: number;
      z: number;
      /** Damage dealt by this hit (B13). */
      damage: number;
      /** Owner of the thing that was hit (B13). */
      victimOwner: number;
      /** Owner of the shooter (B13). */
      attackerOwner: number;
    }
  | {
      kind: 'explosion';
      x: number;
      z: number;
      large: boolean;
      /** Damage dealt by the killing blow (B13). */
      damage: number;
      /** Owner of the thing that was destroyed (B13). */
      victimOwner: number;
      /** Owner of the shooter (B13). */
      attackerOwner: number;
    };

/** Can this weapon be aimed at that target's domain? */
export function canTarget(def: UnitDef, target: UnitRecord): boolean {
  if (def.targets === 'none' || def.damage <= 0) return false;
  if (target.domain === 'air') {
    return def.targets === 'air' || def.targets === 'both' || def.targets === 'seaAir';
  }
  if (target.domain === 'sea') {
    return def.targets === 'sea' || def.targets === 'seaAir';
  }
  // Ground target (land domain).
  return def.targets === 'ground' || def.targets === 'both';
}

/**
 * Aura sources, cached per (world, tick). Scanning world.units for aura
 * emitters on every shot is O(units²) per combat tick — with a thousand
 * units that blows the tick budget. The cache is derived from world state
 * each tick, so it stays deterministic; direct damageMultiplier callers
 * outside a tick simply miss the cache and recompute.
 */
interface AuraSource {
  x: number;
  z: number;
  owner: number;
  kind: string;
  radius: number;
  bonus: number;
  domain: UnitDef['auraDomain'];
}
let auraCacheWorld: World | null = null;
let auraCacheTick = -1;
let auraCache: AuraSource[] = [];

function auraSources(world: World): AuraSource[] {
  if (auraCacheWorld === world && auraCacheTick === world.tick) return auraCache;
  auraCacheWorld = world;
  auraCacheTick = world.tick;
  auraCache = [];
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as UnitKind];
    if (def?.auraRadius === undefined) continue;
    auraCache.push({
      x: u.x, z: u.z, owner: u.owner, kind: u.kind,
      radius: def.auraRadius,
      bonus: def.auraBonus ?? HQ_AURA_DAMAGE_BONUS,
      domain: def.auraDomain,
    });
  }
  return auraCache;
}

/**
 * Damage multiplier for one shot: armor-class counter, the vsAir bonus
 * for flying targets, command auras, upgrade effects (AP Rounds,
 * Advanced Avionics, Sonar Suite), and the attacker's veterancy level
 * (Phase 1: +10% damage per level). All deterministic — no randomness.
 */
export function damageMultiplier(
  world: World,
  attacker: UnitRecord,
  def: UnitDef,
  target: UnitRecord,
): number {
  const targetDef = UNIT_DEFS[target.kind as UnitKind];
  const armor = targetDef ? targetDef.armor : 'light';
  let mult =
    armor === 'light' ? def.vsLight : armor === 'medium' ? def.vsMedium : def.vsHeavy;
  if (target.domain === 'air') mult *= def.vsAir;
  // Upgrade hooks (spec §4): AP Rounds (+40% vsHeavy for tank/TD/apc),
  // Advanced Avionics (+20% vsAir for fighters), Sonar Suite (+30%
  // vsMedium ASW for frigate/destroyer).
  if (
    armor === 'heavy' &&
    AP_ROUNDS_KINDS.includes(attacker.kind) &&
    hasUpgrade(world, attacker.owner, 'apRounds')
  ) {
    mult *= AP_ROUNDS_VS_HEAVY_MULT;
  }
  if (
    target.domain === 'air' &&
    AVIONICS_KINDS.includes(attacker.kind) &&
    hasUpgrade(world, attacker.owner, 'advancedAvionics')
  ) {
    mult *= AVIONICS_VS_AIR_MULT;
  }
  if (
    armor === 'medium' &&
    SONAR_KINDS.includes(attacker.kind) &&
    hasUpgrade(world, attacker.owner, 'sonarSuite')
  ) {
    mult *= SONAR_VS_MEDIUM_MULT;
  }
  // Command auras (spec §5.5): any unit whose def carries auraRadius
  // emits one — the Mobile HQ (radius 20, all domains) and the
  // commandShip (radius 24, sea domain only). A unit never benefits from
  // its own kind's aura; the first source in spawn order wins (no stacking).
  // Sources are cached per tick (see auraSources) to keep combat O(n).
  for (const src of auraSources(world)) {
    if (src.owner !== attacker.owner || src.kind === attacker.kind) continue;
    if (src.domain !== undefined && attacker.domain !== src.domain) continue;
    const d2 = dist2(src.x - attacker.x, src.z - attacker.z);
    if (d2 <= src.radius * src.radius) {
      mult *= 1 + src.bonus;
      break;
    }
  }
  // Veterancy (Phase 1): experienced crews hit harder. vetLevel 0
  // multiplies by exactly 1.0, so legacy behavior is unchanged. The
  // ?? 0 tolerates hand-built records (tests) that predate the field —
  // real records always carry it (spawnUnit) and legacy saves decode it
  // (snapshot.ts).
  mult *= vetDamageMult(attacker.vetLevel ?? 0);
  // Phase 3 logistics (AD3): out-of-supply degrades, never hard-stops —
  // one simple curve, damage ×(0.6+0.4×supplyLevel), applied as a single
  // factor alongside veterancy (PLAN §13: no compounding supply
  // penalties). Exempt kinds sit at level 1 ⇒ exactly ×1.0, so legacy
  // behavior is unchanged for them.
  mult *= supplyDamageFactor(def, attacker);
  return mult;
}

/**
 * Per-tick dense grid of live unit positions for target acquisition
 * (R1 final-review H1, 2026-10-01). `acquireTarget` used to scan ALL
 * units per caller — O(n²) per tick, already superlinear at 1000 units
 * (3.64 ms) and a plausible tick-budget breach at 2000.
 *
 * The grid is combat-specific (not the generic `SpatialHash`): cells
 * hold `UnitRecord`s directly under integer keys, and the query
 * reduces inline with no per-query allocation. A first version used
 * the generic hash, but profiling showed it was ~7x SLOWER than the
 * legacy scan in dense battles (200 rifles packed 3 apart: 0.81ms vs
 * 0.12ms per sweep) — the per-candidate Map lookups, string cell
 * keys, and result-array allocation dwarfed the legacy's tight array
 * loop when most units are within range of each other. The dense grid
 * keeps the sublinear scaling (query cost independent of n at
 * constant density) with a constant factor at parity with the scan.
 *
 * Cell size 16 (R3 perf, 2026-10-01 — was 64): the longest effective
 * weapon range in the roster is 62 (52 base + Cruise Missiles), so a
 * query spans at most 8x8 cells. The smaller cell keeps per-query
 * candidate counts low in dense battles — with cell 64 a short-range
 * weapon's query scanned every unit in a 128x128 area, which dominated
 * the tick in 2000-unit engagements (100ms+ per sweep on the reference
 * VM); with cell 16 the same battle sweeps in ~17ms.
 * The grid is rebuilt once per tick (O(n) inserts); each query then
 * touches only the cells intersecting the weapon-range disc. Cached
 * per (world, tick) like `auraSources` above — positions are final
 * for the tick once movement has run, and the combat pass never
 * teleports units, so the grid stays valid for the whole pass.
 * Direct `acquireTarget` callers outside a tick (tests) get a grid
 * built on first use.
 *
 * WASM seam (docs/research/sim-architecture.md §7.3): if combat ever
 * needs to move off the main thread, this grid build + the radius
 * query are the natural compiled boundary.
 */
const TARGET_CELL_SIZE = 16;
/** Integer cell key: world coords keep |cx|,|cz| << 32768. */
function targetCellKey(cx: number, cz: number): number {
  return (cx + 32768) * 65536 + (cz + 32768);
}
let targetGridWorld: World | null = null;
let targetGridTick = -1;
let targetGridCells: Map<number, UnitRecord[]> | null = null;
let targetGridUnits: UnitRecord[] | null = null;
let targetGridLength = -1;
let targetGridLast: UnitRecord | undefined;

function targetGridFor(world: World): Map<number, UnitRecord[]> {
  // The unit set is fixed during the combat pass in production
  // (spawns apply at tick starts, kills filter via hp), but tests
  // mutate world.units directly mid-tick — the same lazy validation
  // the findUnit index uses (array identity, length, last element),
  // so a stale grid can never hide a live unit.
  const units = world.units;
  const last = units.length > 0 ? units[units.length - 1] : undefined;
  if (
    targetGridWorld === world &&
    targetGridTick === world.tick &&
    targetGridCells !== null &&
    targetGridUnits === units &&
    targetGridLength === units.length &&
    targetGridLast === last
  ) {
    return targetGridCells;
  }
  targetGridWorld = world;
  targetGridTick = world.tick;
  targetGridUnits = units;
  targetGridLength = units.length;
  targetGridLast = last;
  const cells = new Map<number, UnitRecord[]>();
  for (const u of units) {
    if (u.hp <= 0) continue;
    const key = targetCellKey(
      Math.floor(u.x / TARGET_CELL_SIZE),
      Math.floor(u.z / TARGET_CELL_SIZE),
    );
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = [];
      cells.set(key, cell);
    }
    cell.push(u);
  }
  targetGridCells = cells;
  return cells;
}

/**
 * Nearest enemy this unit could hit, inside weapon range and outside
 * min range. Range runs through the upgrade hook (Cruise Missiles).
 * Ties break by lower id. Returns undefined when unarmed.
 *
 * The candidate set comes from the per-tick dense grid
 * (`targetGridFor`): units in the cells intersecting the range disc,
 * visited nearest-cell-first with exact pruning (see below). The
 * nearest-with-id-tiebreak is an order-independent argmin, so it
 * reproduces the legacy full scan's result exactly regardless of
 * visit order. Every legacy filter (sheltered, stealth/detection,
 * domain, exact range via dist() (deterministic.ts), min range) is applied per
 * candidate, unchanged — the squared-distance pre-check only skips
 * candidates dist() would also reject.
 */
export function acquireTarget(world: World, unit: UnitRecord, def: UnitDef): UnitRecord | undefined {
  if (def.damage <= 0 || def.targets === 'none') return undefined;
  const range = effectiveRange(world, unit.owner, def);
  const r2 = range * range;
  const cells = targetGridFor(world);
  const cs = TARGET_CELL_SIZE;
  const cx0 = Math.floor((unit.x - range) / cs);
  const cx1 = Math.floor((unit.x + range) / cs);
  const cz0 = Math.floor((unit.z - range) / cs);
  const cz1 = Math.floor((unit.z + range) / cs);
  // R3 perf (2026-10-01): cells nearest-first with exact pruning.
  // In a dense battle the shooter's own cell almost always holds a very
  // close enemy, so farther cells prune away without being scanned: the
  // pathological all-in-range case drops from O(candidates) toward
  // O(nearby) per query. Pruning is exact — a pruned cell's candidates
  // all sit strictly farther than bestDist + 1e-9, so none could
  // strictly improve (needs d < bestDist - 1e-9) or tie-win by lower id
  // (needs |d - bestDist| < 1e-9). Result stays the order-independent
  // argmin, identical to the legacy full scan.
  const order: { cell: UnitRecord[]; minD2: number }[] = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const cell = cells.get(targetCellKey(cx, cz));
      if (cell === undefined) continue;
      const mdx = Math.max(cx * cs - unit.x, 0, unit.x - (cx + 1) * cs);
      const mdz = Math.max(cz * cs - unit.z, 0, unit.z - (cz + 1) * cs);
      order.push({ cell, minD2: mdx * mdx + mdz * mdz });
    }
  }
  order.sort((a, b) => a.minD2 - b.minD2);
  let best: UnitRecord | undefined;
  let bestDist = Infinity;
  for (const { cell, minD2 } of order) {
    const pruneAt = bestDist + 1e-9;
    if (minD2 > pruneAt * pruneAt) break;
    for (const other of cell) {
        if (other.id === unit.id || other.owner === unit.owner || other.hp <= 0) continue;
        const dx = other.x - unit.x;
        const dz = other.z - unit.z;
        if (dx * dx + dz * dz > r2) continue;
        // Grand-expansion Phase 5 (S4): sheltered aircraft (parked in a
        // hangar or embarked on a carrier) are not valid targets — they
        // are inside the shelter, not on the battlespace.
        if (isSheltered(other)) continue;
        // Grand-expansion Phase 6 (S6 intel): stealthed units (spies) are
        // invisible unless detected — the shooter cannot acquire what its
        // side cannot see (the `isDetected` stealth contract in intel.ts).
        if (!isDetected(other, unit.owner, world)) continue;
        if (!canTarget(def, other)) continue;
        const d = dist(dx, dz);
        if (d > range || d < def.minRange) continue;
        if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) < 1e-9 && other.id < (best?.id ?? Infinity))) {
          best = other;
          bestDist = d;
        }
    }
  }
  return best;
}

/** Apply one shot from attacker to target. Returns true if the target died. */
function fireWeapon(world: World, attacker: UnitRecord, def: UnitDef, target: UnitRecord): boolean {
  // Phase 3 logistics (S2): magazine gate. A unit whose def tracks ammo
  // must have a full shot loaded, or it holds fire — the same outcome as
  // an unarmed unit: no loud failure, it simply cannot shoot this tick.
  // The weapon stays OFF cooldown so it fires the instant resupply lands
  // (the resupply fantasy: the truck arrives, the guns speak next tick).
  // Reads plain unit data only — no combat→economy import (S2 discipline).
  const perShot = def.ammoPerShot ?? 1;
  if ((def.ammoCapacity ?? 0) > 0 && (attacker.ammo ?? 0) < perShot) {
    return false;
  }
  const mult = damageMultiplier(world, attacker, def, target);
  // Veteran crews reload faster (Phase 1) — the weapon cooldown already
  // reflects the attacker's level here and in the shield-absorbed path.
  // (?? 0: see the damageMultiplier note above.)
  const cooldown = vetCooldownTicks(def, attacker.vetLevel ?? 0);
  // Phase 3: an active Aegis shield blocks all damage to the owner's units.
  // (Reads world.superweapons directly — importing superweapons.ts here
  // would cycle, since the storm system needs combat's killUnit.)
  const sw = world.superweapons.players.find((p) => p.owner === target.owner);
  if (sw && world.tick < sw.aegis.activeUntil) {
    attacker.cooldownLeft = cooldown;
    return false; // shield absorbs the shot
  }
  const dmg = def.damage * mult;
  target.hp -= dmg;
  // Phase 3 logistics (S2): the shot actually fired (past the Aegis
  // check above) — burn the magazine. The gate guarantees
  // ammo >= perShot, so no clamp is needed. (?? 0: hand-built records.)
  if ((def.ammoCapacity ?? 0) > 0) {
    attacker.ammo = (attacker.ammo ?? 0) - perShot;
  }
  attacker.cooldownLeft = cooldown;
  // B16 (2026-10-01): emit the visual cue. Muzzle always; impact if the
  // target survived, explosion if it died.
  // B13 (2026-10-02): impact/explosion also carry the damage and both
  // owners for damage numbers + screen shake.
  const died = target.hp <= 0;
  world.combatEvents.push({
    kind: 'muzzle',
    x: attacker.x,
    z: attacker.z,
    targetX: target.x,
    targetZ: target.z,
  });
  world.combatEvents.push(
    died
      ? {
          kind: 'explosion',
          x: target.x,
          z: target.z,
          large: false,
          damage: dmg,
          victimOwner: target.owner,
          attackerOwner: attacker.owner,
        }
      : {
          kind: 'impact',
          x: target.x,
          z: target.z,
          damage: dmg,
          victimOwner: target.owner,
          attackerOwner: attacker.owner,
        },
  );
  return died;
}

/**
 * Can this weapon be aimed at buildings? The ground-target branch of
 * `canTarget`: a weapon that can hit ground units can hit the
 * (stationary, land-domain) buildings. AA-only, sea-only and
 * seaAir weapons cannot — an anti-air battery has no ground-attack
 * mode in 0.1 Alpha. Exported for the AI and the UI's right-click
 * attack gate (same rule everywhere).
 */
export function canTargetBuilding(def: UnitDef): boolean {
  if (def.targets === 'none' || def.damage <= 0) return false;
  return def.targets === 'ground' || def.targets === 'both';
}

/**
 * Siege stand cell (final-review R2 follow-up, 2026-10-01). A siege
 * order's MOVE destination must be a passable cell adjacent to the
 * building footprint — pathing to the footprint center would stack the
 * unit inside the building (buildings don't block the pathfinding mask,
 * so the order would "succeed" with the unit standing in the walls).
 * Scans the one-cell ring around the footprint in fixed row-major order,
 * keeps passable cells (`cellMoveCost !== Infinity`: land, in bounds),
 * and picks the nearest to (ux, uz) with cell-index tie-break —
 * deterministic. Returns null when the building is fully surrounded;
 * callers reject loudly instead of stranding a unit.
 */
export function siegeStandCell(
  t: TerrainData,
  city: CityState,
  b: BuildingRecord,
  ux: number,
  uz: number,
): { x: number; z: number } | null {
  const def = BUILDING_DEFS[b.kind];
  let best = -1;
  let bestD = Infinity;
  for (let dz = -1; dz <= def.footprintH; dz++) {
    for (let dx = -1; dx <= def.footprintW; dx++) {
      const onRing =
        dx === -1 || dz === -1 || dx === def.footprintW || dz === def.footprintH;
      if (!onRing) continue;
      const cx = b.cx + dx;
      const cz = b.cz + dz;
      if (!inBounds(cx, cz)) continue;
      if (cellMoveCost(t, city, cx, cz) === Infinity) continue;
      const cell = cellIndex(cx, cz);
      const x = cellCenterWorld(cx);
      const z = cellCenterWorld(cz);
      const d = dist(x - ux, z - uz);
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && cell < best)) {
        best = cell;
        bestD = d;
      }
    }
  }
  if (best < 0) return null;
  const { cx, cz } = cellCoords(best);
  return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
}

/**
 * Apply attack damage to a building (final-review R2, 2026-10-01:
 * buildings are destructible — C3). Returns true when the building
 * was destroyed (removed via `destroyBuilding`, the shared demolish
 * path). Deterministic — no RNG.
 *
 * The nuclear meltdown roll lives here, per the superweapons.ts
 * contract: ANY attack damage on a completed nuclear plant rolls the
 * seeded attack-meltdown check. `attackMeltdownRoll` is a pure hash
 * of (seed, buildingId, tick), so several hits in one tick roll
 * identically — effectively one roll per tick. A plant destroyed by
 * the hit needs no meltdown: rubble produces nothing.
 */
export function damageBuilding(world: World, b: BuildingRecord, amount: number): boolean {
  const def = BUILDING_DEFS[b.kind];
  b.hp = (b.hp ?? def.hp) - amount;
  // Workstream M (user correction 2026-09-30): attacks are the ONLY
  // meltdown trigger. This path covers unit attacks; the storm strike
  // in superweapons.ts routes through here too, so every attack
  // funnels through the one roll.
  if (b.kind === 'nuclearPlant' && (b.progress ?? 0) >= 1) {
    const denom = hasUpgrade(world, b.owner, 'advancedNuclear')
      ? MELTDOWN_ATTACK_DENOMINATOR * 4
      : MELTDOWN_ATTACK_DENOMINATOR;
    if (attackMeltdownRoll(world.seed, b.id, world.tick, denom)) {
      b.meltdownUntilTick = world.tick + MELTDOWN_OFFLINE_SECONDS * TICK_HZ;
    }
  }
  if ((b.hp ?? 0) <= 0) {
    destroyBuilding(world, b);
    return true;
  }
  return false;
}

/**
 * Apply one shot from attacker to a building. Mirrors `fireWeapon`'s
 * gates (magazine, Aegis — an active shield protects the owner's
 * buildings like its units) but the damage model is deliberately
 * simpler: buildings have no armor class, so there are no armor
 * counters, no command auras, no upgrade hooks — a tank does its base
 * 50 to a house, always. Attacker-condition multipliers still apply
 * (veterancy: skilled crews siege better; supply: starving crews siege
 * worse), and ammo weapons still burn a shot per hit (logistics
 * consistency). Returns true when the building was destroyed.
 */
function fireWeaponAtBuilding(
  world: World,
  attacker: UnitRecord,
  def: UnitDef,
  b: BuildingRecord,
): boolean {
  const perShot = def.ammoPerShot ?? 1;
  if ((def.ammoCapacity ?? 0) > 0 && (attacker.ammo ?? 0) < perShot) {
    return false;
  }
  const mult = vetDamageMult(attacker.vetLevel ?? 0) * supplyDamageFactor(def, attacker);
  const cooldown = vetCooldownTicks(def, attacker.vetLevel ?? 0);
  // An active Aegis shield blocks all damage to the owner's buildings
  // (reads world.superweapons directly — importing superweapons.ts
  // here would cycle, as the fireWeapon comment notes).
  const sw = world.superweapons.players.find((p) => p.owner === b.owner);
  if (sw && world.tick < sw.aegis.activeUntil) {
    attacker.cooldownLeft = cooldown;
    return false; // shield absorbs the shot
  }
  const dmg = def.damage * mult;
  const destroyed = damageBuilding(world, b, dmg);
  if ((def.ammoCapacity ?? 0) > 0) {
    attacker.ammo = (attacker.ammo ?? 0) - perShot;
  }
  attacker.cooldownLeft = cooldown;
  // B16 (2026-10-01): visual cue. Buildings get the large explosion
  // when destroyed.
  // B13 (2026-10-02): impact/explosion also carry the damage and both
  // owners for damage numbers + screen shake.
  const c = buildingCenterWorld(b);
  world.combatEvents.push({
    kind: 'muzzle',
    x: attacker.x,
    z: attacker.z,
    targetX: c.x,
    targetZ: c.z,
  });
  world.combatEvents.push(
    destroyed
      ? {
          kind: 'explosion',
          x: c.x,
          z: c.z,
          large: true,
          damage: dmg,
          victimOwner: b.owner,
          attackerOwner: attacker.owner,
        }
      : {
          kind: 'impact',
          x: c.x,
          z: c.z,
          damage: dmg,
          victimOwner: b.owner,
          attackerOwner: attacker.owner,
        },
  );
  return destroyed;
}

/**
 * Position of `unit` in `world.units` without a linear scan (R1
 * final-review H1, 2026-10-01). `world.units` is spawn/id order — ids
 * are assigned ascending by `spawnUnit`, never reused, and every
 * removal preserves order (movement.ts documents the same invariant)
 * — so the position is a binary search, O(log n). Hand-built fixtures
 * with out-of-order ids (tests) fall back to the linear scan rather
 * than misbehave. Removal itself stays an order-preserving splice:
 * swap-remove would be O(1) but would silently change iteration order
 * for movement/render/AI loops that rely on spawn order.
 */
function unitArrayIndex(world: World, unit: UnitRecord): number {
  const units = world.units;
  let lo = 0;
  let hi = units.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const m = units[mid];
    if (m === undefined) return units.indexOf(unit);
    if (m.id === unit.id) return m === unit ? mid : units.indexOf(unit);
    if (m.id < unit.id) lo = mid + 1;
    else hi = mid - 1;
  }
  return units.indexOf(unit);
}

/**
 * Remove a dead unit: drop it from `world.units`, cancel its pathfinding
 * requests and field membership, and clear everyone targeting it. Ids are
 * never reused, so no id fix-up is needed.
 */
/**
 * Final-review R3 (perf, 2026-10-01): ids of units killed since the last
 * `flushDeadTargetRefs`, per world. `killUnit` records instead of
 * scanning for attackers (see below); the combat and superweapon systems
 * flush once per tick. Module-level, like the unit index in units.ts —
 * the flush itself walks `world.units` in id order, so there is no
 * determinism footprint.
 */
const pendingDeadTargetIds = new WeakMap<World, Set<number>>();

/** Record a killed unit's id for the end-of-system target-ref sweep. */
function recordDeadTargetId(world: World, id: number): void {
  let s = pendingDeadTargetIds.get(world);
  if (s === undefined) {
    s = new Set();
    pendingDeadTargetIds.set(world, s);
  }
  s.add(id);
}

/**
 * Clear `targetId`/`chasing` on every unit whose target died since the
 * last flush. One O(units) sweep per call; a no-op when nothing died.
 * Called at the end of the combat system and after superweapon strike
 * processing — i.e. after every in-tick kill path — so the AI (which
 * reads `targetId` as a busy flag) and the next tick observe exactly
 * the state the old per-kill eager scan produced.
 */
export function flushDeadTargetRefs(world: World): void {
  const s = pendingDeadTargetIds.get(world);
  if (s === undefined || s.size === 0) return;
  for (const u of world.units) {
    const t = u.targetId;
    if (t !== 0 && s.has(t)) {
      u.targetId = 0;
      u.chasing = false;
    }
  }
  s.clear();
}

export function killUnit(world: World, unit: UnitRecord): void {
  // Grand-expansion Phase 5 (S4): release the unit's hangar slot (a
  // parked aircraft's slot frees when it dies; the demolish path
  // already cleared the link for destroyed buildings).
  const hid = unit.hangarBuildingId ?? 0;
  if (hid > 0) {
    const b = world.city.buildings.find((x) => x.id === hid);
    if (b?.hangars) {
      for (const s of b.hangars) {
        if (s.occupant === unit.id) s.occupant = 0;
      }
    }
  }
  // Grand-expansion Phase 5/6 (S4): a destroyed carrier takes its wing
  // with it (PLAN §4 S4 — the user requirement). Recursive, wing in id
  // order (world.units is spawn order); wing aircraft award no XP
  // (ordnance lost with the ship, like a garrison).
  const def = UNIT_DEFS[unit.kind as UnitKind];
  if ((def?.wingCapacity ?? 0) > 0) {
    const wing = world.units.filter((u) => (u.embarkedOn ?? 0) === unit.id);
    for (const w of wing) killUnit(world, w);
  }
  const idx = unitArrayIndex(world, unit);
  if (idx >= 0) world.units.splice(idx, 1);
  removeUnitFromIndex(world, unit.id);
  // Phase 3 logistics: a dead unit's in-flight depot reservation returns
  // to the depot's available pool (release is idempotent).
  releaseUnitReservation(world, unit);
  // Cancel pathfinding requests (the coordinator keys them by unit id).
  const pf = world.pathfinding;
  pf.queue = pf.queue.filter((r) => r.unitId !== unit.id);
  pf.fieldQueue = pf.fieldQueue.filter((r) => !r.unitIds.includes(unit.id));
  if (pf.activeBuild && pf.activeBuild.unitIds.includes(unit.id)) {
    pf.activeBuild.unitIds = pf.activeBuild.unitIds.filter((id) => id !== unit.id);
    pf.activeBuild.waitingCount = Math.max(0, pf.activeBuild.waitingCount - 1);
  }
  // Finished fields carry no member list: units point at them via
  // `unit.fieldId`, and the coordinator prunes fields with no members.
  // Targeting references used to be cleared here with an O(units) scan
  // per kill — O(kills x units) for a mass-casualty tick (a storm strike
  // can kill 500+ units: ~52ms on the reference VM, over the 33.3ms tick
  // budget). Instead the dead id is recorded and `flushDeadTargetRefs`
  // clears every attacker's stale reference in a single O(units) sweep
  // at the end of the combat / superweapon systems (R3 perf,
  // 2026-10-01). End-of-tick state is identical to the eager scan: the
  // combat loop's own per-tick target validation already drops dead
  // targets for attackers processed after the kill.
  recordDeadTargetId(world, unit.id);
}

/**
 * Heal auras (spec §5.4): units with `healRadius`/`healPerSec` on their
 * def (combatMedic: 12 / 2 hp/s, 4 with Field Medicine) restore friendly
 * LAND units in radius. Same iteration pattern as the HQ damage aura —
 * O(sources × units), bounded by design (medics are few). Healing caps at
 * the unit's effective max hp (upgrade-aware); the dead stay dead.
 */
/**
 * Grand-expansion Phase 6 (workstream C): naval-mine trigger radius in
 * world units. Mirrors the navalMine def's `range: 8` — keep the two in
 * sync; the def field documents the radius in UI, this constant drives
 * the sim pass.
 */
export const MINE_TRIGGER_RADIUS = 8;

/**
 * Naval-mine detonation pass (grand-expansion Phase 6, workstream C).
 * Runs after heal auras, before the fire pass. Each living naval mine,
 * in id order, detonates on the nearest living enemy sea unit that is
 * not itself a mine, within MINE_TRIGGER_RADIUS (distance ascending,
 * ties break to the lowest unit id — the combat determinism contract).
 * The detonation spends the mine def's `damage` through
 * `damageMultiplier` (armor counters apply: heavy hulls shrug mines at
 * vsHeavy 0.9, light hulls eat them at vsLight 1.5), self-destructs the
 * mine (hp → 0), and leaves the target for the fire pass's dead list
 * below (mines award no XP — expendable ordnance). An active Aegis
 * shield absorbs the blast like any other incoming damage. No RNG.
 */
function applyNavalMineDetonations(world: World): void {
  const mines = world.units.filter((u) => u.hp > 0 && u.kind === 'navalMine');
  if (mines.length === 0) return;
  mines.sort((a, b) => a.id - b.id);
  const mineDef = UNIT_DEFS.navalMine;
  for (const mine of mines) {
    let nearest: UnitRecord | undefined;
    let nearestDist = MINE_TRIGGER_RADIUS;
    for (const u of world.units) {
      if (u.hp <= 0 || u.owner === mine.owner) continue;
      if (u.domain !== 'sea' || u.kind === 'navalMine') continue;
      const d = dist(u.x - mine.x, u.z - mine.z);
      if (d <= nearestDist && (nearest === undefined || d < nearestDist || u.id < nearest.id)) {
        nearest = u;
        nearestDist = d;
      }
    }
    if (nearest === undefined) continue;
    // The Aegis check mirrors fireWeapon: an active shield absorbs the
    // blast. (Reads world.superweapons directly — importing
    // superweapons.ts here would cycle, as the comment there notes.)
    const sw = world.superweapons.players.find((p) => p.owner === nearest.owner);
    mine.hp = 0; // the mine is spent whether or not the blast lands
    if (sw && world.tick < sw.aegis.activeUntil) continue;
    const mult = damageMultiplier(world, mine, mineDef, nearest);
    nearest.hp -= mineDef.damage * mult;
  }
}

function applyHealAuras(world: World): void {
  for (const medic of world.units) {
    if (medic.hp <= 0) continue;
    const mdef = UNIT_DEFS[medic.kind as UnitKind];
    const radius = mdef?.healRadius;
    if (radius === undefined || radius <= 0) continue;
    // Grand-expansion Phase 6 (workstream C): `healDomain` picks which
    // domain the aura covers (repairShip heals 'sea'; everything else
    // heals 'land' as before — the combatMedic behavior is unchanged).
    const domain = mdef.healDomain ?? 'land';
    const perSec = effectiveHealPerSec(world, medic.owner, mdef);
    if (perSec <= 0) continue;
    const amount = perSec * TICK_DT;
    for (const u of world.units) {
      if (u.hp <= 0 || u.owner !== medic.owner || u.domain !== domain) continue;
      const udef = UNIT_DEFS[u.kind as UnitKind];
      if (!udef) continue;
      // Heal cap is veterancy-aware (Phase 1): Veteran+ units are tougher
      // and medics can fill the bonus hp too.
      const maxHp = vetAdjustedMaxHp(world, u);
      if (u.hp >= maxHp) continue;
      const inHealRange = dist2(u.x - medic.x, u.z - medic.z) <= radius * radius;
      if (inHealRange) {
        u.hp = Math.min(maxHp, u.hp + amount);
      }
    }
  }
}

/**
 * The combat system. Runs after movement each tick:
 *  1. Cooldowns tick down.
 *  2. Heal auras apply (combatMedic on land, repairShip on sea),
 *     then drydock repair at production shipyards (shipyardRepair.ts).
 *  3. Naval mines detonate (grand-expansion Phase 6, workstream C).
 *  4. In id order, every armed unit with a ready weapon validates its
 *     target (or auto-acquires), fires when in range, or chases an
 *     explicit attack order (deployableOnly kinds never fire).
 *  5. The dead are removed.
 */
export function createCombatSystem(t?: TerrainData): SimSystem {
  return (world: World) => {
    // B16 (2026-10-01): clear last tick's VFX events — the render layer
    // drains them each frame; anything left at tick start is stale.
    world.combatEvents.length = 0;
    for (const u of world.units) {
      if (u.cooldownLeft > 0) u.cooldownLeft -= 1;
      // Elite (VET_MAX_LEVEL) regen (Phase 1): living Elite units regrow
      // 2 hp/s up to their veterancy-adjusted max. Deterministic,
      // float-safe: identical inputs produce identical hp.
      // (?? 0: hand-built records without the field never regen.)
      if ((u.vetLevel ?? 0) >= VET_MAX_LEVEL && u.hp > 0) {
        const maxHp = vetAdjustedMaxHp(world, u);
        if (u.hp < maxHp) {
          u.hp = Math.min(maxHp, u.hp + VET_ELITE_REGEN_PER_SEC * TICK_DT);
        }
      }
    }
    applyHealAuras(world);
    // Naval-building model (2026-10-01): shipyards build AND repair —
    // damaged same-side sea units near an operational shipyard drydock
    // back to health. Runs with the other hp-restoring passes.
    runShipyardRepair(world, TICK_DT);
    // Grand-expansion Phase 6 (workstream C): naval-mine detonation pass.
    // Deployable-only kinds never enter the fire pass below (their
    // `damage` is spent here, by their own detonation logic — never by
    // shooting). Each living mine, in id order, finds the nearest living
    // enemy sea unit (other mines excluded) within MINE_TRIGGER_RADIUS
    // and detonates on it: the armor-counter multiplier applies, the
    // mine self-destructs, and the target joins the dead list so the
    // combat pass credits/removes it in the same order as a normal
    // kill. Deterministic — no RNG, id-ordered, ties on distance break
    // to the lowest unit id. Mines award no XP (expendable ordnance).
    applyNavalMineDetonations(world);
    // Snapshot the roster: killUnit mutates world.units at the end of the
    // pass. `world.units` is always id-ascending (append-only spawns,
    // order-preserving splices — ids are never reused), so the copy alone
    // preserves the id-order determinism contract; no re-sort needed
    // (R3 perf, 2026-10-01: the sort was O(n log n) every tick).
    // XP kill crediting happens in this same pass, in id order.
    const roster = [...world.units];
    const dead: UnitRecord[] = [];
    for (const u of roster) {
      if (u.hp <= 0) {
        dead.push(u);
        continue;
      }
      // Grand-expansion Phase 5 (S4): sheltered aircraft (parked in a
      // hangar or embarked on a carrier) neither shoot nor get shot —
      // they are inside the shelter, not on the battlespace.
      if (isSheltered(u)) continue;
      const def = UNIT_DEFS[u.kind as UnitKind];
      // Deployable-only kinds (navalMine) never shoot — detonations are
      // handled by applyNavalMineDetonations above.
      if (!def || def.damage <= 0 || u.cooldownLeft > 0 || def.deployableOnly === true) continue;

      // Final-review R2 (2026-10-01): explicit building targets
      // (`attackBuilding` orders). Validated per tick like unit
      // targets: the building may have been destroyed (or demolished)
      // since the order was issued. While a valid siege target stands,
      // the unit sieges it — no opportunistic unit fire (symmetric
      // with attackUnit's chase contract: an explicit order owns the
      // unit until it resolves or is superseded).
      let siege: BuildingRecord | undefined;
      const siegeId = u.buildingTargetId ?? 0;
      if (siegeId !== 0) {
        const b = world.city.buildings.find((x) => x.id === siegeId);
        if (b && b.owner !== u.owner) {
          siege = b;
        } else {
          u.buildingTargetId = 0;
          u.chasing = false;
          if (u.state === 'moving' && !canStillMove(u)) {
            u.state = 'idle';
            clearUnitOrder(u);
          }
        }
      }

      // Validate the current target.
      let target: UnitRecord | undefined;
      if (!siege && u.targetId !== 0) {
        const t = findUnit(world, u.targetId);
        // A target that parked/embarked mid-chase leaves the
        // battlespace — drop it like a dead one.
        // Grand-expansion Phase 6 (S6 intel): a target that went
        // undetected mid-chase (the spy slipped out of detection
        // coverage, or its burn timer expired) is dropped the same
        // way — the pursuer lost sight of it.
        if (t && t.hp > 0 && t.owner !== u.owner && !isSheltered(t) && isDetected(t, u.owner, world)) {
          target = t;
        } else {
          u.targetId = 0;
          u.chasing = false;
          if (u.state === 'moving' && !canStillMove(u)) {
            u.state = 'idle';
            clearUnitOrder(u);
          }
        }
      }
      // Opportunistic fire: nearest enemy inside weapon range.
      // Roadmap B3 (2026-10-02): while a ceasefire holds, neither side
      // opportunistically acquires the other's units — the front
      // freezes instead of one side getting free kills. (Deliberate
      // attack orders still work, and break the ceasefire.) Units
      // already fighting keep their target.
      if (!siege && !target) {
        const acquired = acquireTarget(world, u, def);
        const frozen =
          acquired !== undefined &&
          ceasefireActive(world) &&
          isCeasefirePair(world, u.owner, acquired.owner);
        if (acquired && !frozen) {
          u.targetId = acquired.id;
          target = acquired;
        }
      }
      if (!siege && !target) continue;

      // Aim point: the building's footprint center for siege targets,
      // the unit's position otherwise. The fire/chase logic below is
      // shared — only the shot itself differs. (The continue above
      // guarantees exactly one of siege/target is defined here, so the
      // casts below are total.)
      const foe = target as UnitRecord;
      let aimX: number;
      let aimZ: number;
      if (siege) {
        const c = buildingCenterWorld(siege);
        aimX = c.x;
        aimZ = c.z;
      } else {
        aimX = foe.x;
        aimZ = foe.z;
      }
      const d = dist(aimX - u.x, aimZ - u.z);
      const range = effectiveRange(world, u.owner, def);
      const canFire = siege ? canTargetBuilding(def) : canTarget(def, foe);
      if (d <= range && d >= def.minRange && canFire) {
        if (siege) {
          // Structures award no XP (awardKillXp needs a UnitDef) — the
          // prize is the rubble. destroyBuilding removed the record
          // synchronously, so no dead-list bookkeeping is needed.
          fireWeaponAtBuilding(world, u, def, siege);
        } else if (fireWeapon(world, u, def, foe) && !dead.includes(foe)) {
          // Kill crediting (Phase 1): award XP BEFORE killUnit removes the
          // target below — the target record still exists here.
          awardKillXp(world, u, UNIT_DEFS[foe.kind as UnitKind]);
          dead.push(foe);
        }
      } else if (u.chasing) {
        // Explicit attack order, target out of reach: reposition.
        if (d < def.minRange) {
          // Too close for this weapon (e.g. artillery minimum range):
          // back off directly away from the target to reach minRange.
          // Deterministic: pure function of unit/target positions.
          const dx = u.x - aimX;
          const dz = u.z - aimZ;
          const dd = dist(dx, dz);
          if (dd > 1e-9) {
            const backOff = def.minRange - d + 2; // +2 buffer to clear minRange
            const m = MAP_HALF_SIZE - 0.01;
            const bx = Math.min(Math.max(u.x + (dx / dd) * backOff, -m), m);
            const bz = Math.min(Math.max(u.z + (dz / dd) * backOff, -m), m);
            const destDist2 = dist2(bx - u.destX, bz - u.destZ);
            if (u.state === 'idle' || destDist2 > 100) {
              orderMoveTo(world, u, bx, bz);
            }
          }
          // dist ~0: stacked on the target, no direction to back off; hold.
        } else {
          // Too far: chase toward the target. Re-issue only when idle
          // (arrived at a stale position) or the target has moved well
          // away from where we're headed — not every tick. Sieges chase
          // a passable stand cell beside the footprint, never the
          // building center (see siegeStandCell). Without terrain (some
          // headless tests) the center fallback preserves the old path.
          const stand = siege && t ? siegeStandCell(t, world.city, siege, u.x, u.z) : null;
          const tx = stand ? stand.x : aimX;
          const tz = stand ? stand.z : aimZ;
          const destDist2 = dist2(tx - u.destX, tz - u.destZ);
          if (u.state === 'idle' || destDist2 > 100) {
            orderMoveTo(world, u, tx, tz);
          }
        }
      }
    }
    for (const d of dead) {
      // O(1) liveness check (was `world.units.includes`, O(n) per
      // dead): ids are never reused, so the record found by id is d
      // itself iff d is still in the world — a carrier's wing may have
      // been killed already by the recursive wing kill inside killUnit.
      if (findUnit(world, d.id) === d) killUnit(world, d);
    }
    // Batched target-ref sweep for every kill this tick (see killUnit).
    flushDeadTargetRefs(world);
  };
}

/** True when the unit has no live movement order (safe to stand down). */
function canStillMove(u: UnitRecord): boolean {
  return u.state === 'moving' || u.state === 'awaitingPath';
}

/** Register the `attackUnit` command. */
export function registerCombatCommands(queue: CommandQueue, t?: TerrainData): void {
  queue.register('attackUnit', {
    validate(cmd, world): string | null {
      const attackerId = cmd.payload['unitId'];
      const targetId = cmd.payload['targetId'];
      const owner = cmd.payload['owner'];
      if (typeof attackerId !== 'number' || !Number.isInteger(attackerId) || attackerId <= 0) {
        return 'attackUnit: payload.unitId must be a positive integer';
      }
      if (typeof targetId !== 'number' || !Number.isInteger(targetId) || targetId <= 0) {
        return 'attackUnit: payload.targetId must be a positive integer';
      }
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'attackUnit: payload.owner must be an integer';
      }
      const attacker = findUnit(world, attackerId);
      if (!attacker) return `attackUnit: no unit with id ${attackerId}`;
      if (attacker.owner !== owner) return `attackUnit: unit ${attackerId} is not owned by player ${owner}`;
      // Grand-expansion Phase 5 (S4): sheltered aircraft take no attack
      // orders — launch them first. Loud, never silent.
      if (isSheltered(attacker)) return `attackUnit: unit ${attackerId} is parked or embarked (launch it first)`;
      const def = UNIT_DEFS[attacker.kind as UnitKind];
      if (!def || def.damage <= 0) return `attackUnit: unit ${attackerId} (${attacker.kind}) is unarmed`;
      const target = findUnit(world, targetId);
      if (!target) return `attackUnit: no target with id ${targetId}`;
      if (target.owner === owner) return 'attackUnit: cannot attack your own unit';
      if (isSheltered(target)) return `attackUnit: target ${targetId} is parked or embarked (not on the battlespace)`;
      // Grand-expansion Phase 6 (S6 intel): no ordering an attack on a
      // stealthed unit your side cannot see — find it first (detection
      // coverage, or burn it with a spot check). Loud, never silent.
      if (!isDetected(target, owner, world)) {
        return `attackUnit: target ${targetId} is stealthed and undetected (no valid target)`;
      }
      if (!canTarget(def, target)) {
        return `attackUnit: ${attacker.kind} cannot target ${target.domain} units`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const attacker = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
      const target = findUnit(world, cmd.payload['targetId'] as number) as UnitRecord;
      attacker.failReason = null;
      // Roadmap B3 (2026-10-02): attacking the AI rival while a
      // ceasefire holds is a betrayal — the ceasefire breaks
      // immediately (disposition −15). The AI's own orders never reach
      // here during a ceasefire (think-gated in ai.ts), so any order
      // that does is a deliberate hostile act.
      if (ceasefireActive(world) && isAIOwner(world, target.owner)) {
        breakCeasefire(world);
      }
      // orderMoveTo clears targeting (a plain move supersedes an attack),
      // so set the attack state after issuing the move.
      orderMoveTo(world, attacker, target.x, target.z);
      attacker.targetId = target.id;
      attacker.chasing = true;
      return attacker.id;
    },
  });

  /**
   * Final-review R2 (2026-10-01): the siege order — attack an enemy
   * BUILDING (C3). Same command-queue + validate/apply contract as
   * `attackUnit`: validate at enqueue AND at apply (the building may
   * have been destroyed or demolished between the two), loud
   * rejections, never silent. The combat loop chases the building's
   * footprint center and fires `fireWeaponAtBuilding` when in range.
   * Buildings are a separate id space from units, hence the separate
   * `buildingId` payload and the unit's `buildingTargetId` field.
   */
  queue.register('attackBuilding', {
    validate(cmd, world): string | null {
      // Grand-expansion Phase 8 (peaceful mode): covert-op commands
      // reject loudly in peaceful worlds as defense in depth — siege
      // orders get the same gate (no armed unit can exist there, but
      // the command layer never trusts that).
      if (world.peaceful === true) return 'attackBuilding: not available in peaceful mode';
      const unitId = cmd.payload['unitId'];
      const buildingId = cmd.payload['buildingId'];
      const owner = cmd.payload['owner'];
      if (typeof unitId !== 'number' || !Number.isInteger(unitId) || unitId <= 0) {
        return 'attackBuilding: payload.unitId must be a positive integer';
      }
      if (typeof buildingId !== 'number' || !Number.isInteger(buildingId) || buildingId <= 0) {
        return 'attackBuilding: payload.buildingId must be a positive integer';
      }
      if (typeof owner !== 'number' || !Number.isInteger(owner)) {
        return 'attackBuilding: payload.owner must be an integer';
      }
      const attacker = findUnit(world, unitId);
      if (!attacker) return `attackBuilding: no unit with id ${unitId}`;
      if (attacker.owner !== owner) return `attackBuilding: unit ${unitId} is not owned by player ${owner}`;
      // Grand-expansion Phase 5 (S4): sheltered aircraft take no attack
      // orders — launch them first. Loud, never silent.
      if (isSheltered(attacker)) return `attackBuilding: unit ${unitId} is parked or embarked (launch it first)`;
      const def = UNIT_DEFS[attacker.kind as UnitKind];
      if (!def || def.damage <= 0) return `attackBuilding: unit ${unitId} (${attacker.kind}) is unarmed`;
      if (!canTargetBuilding(def)) {
        return `attackBuilding: ${attacker.kind} cannot target buildings`;
      }
      const b = world.city.buildings.find((x) => x.id === buildingId);
      if (!b) return `attackBuilding: no building with id ${buildingId}`;
      if (b.owner === owner) return 'attackBuilding: cannot attack your own building';
      if (t && !siegeStandCell(t, world.city, b, attacker.x, attacker.z)) {
        return `attackBuilding: building ${buildingId} has no reachable adjacent cell`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const attacker = findUnit(world, cmd.payload['unitId'] as number) as UnitRecord;
      const b = world.city.buildings.find(
        (x) => x.id === (cmd.payload['buildingId'] as number),
      ) as BuildingRecord;
      attacker.failReason = null;
      // Roadmap B3 (2026-10-02): sieging the AI rival's building while
      // a ceasefire holds is a betrayal — same rule as attackUnit.
      if (ceasefireActive(world) && isAIOwner(world, b.owner)) {
        breakCeasefire(world);
      }
      // orderMoveTo clears targeting (a plain move supersedes an
      // attack), so set the siege state after issuing the move — the
      // same pattern as attackUnit's apply above. The unit walks to a
      // passable stand cell beside the footprint, not the building
      // center (siegeStandCell) — validate already guaranteed one
      // exists when terrain is available; the center fallback below is
      // unreachable defense (and the headless no-terrain behavior).
      const stand =
        t ? (siegeStandCell(t, world.city, b, attacker.x, attacker.z) ?? buildingCenterWorld(b))
          : buildingCenterWorld(b);
      orderMoveTo(world, attacker, stand.x, stand.z);
      attacker.targetId = 0;
      attacker.buildingTargetId = b.id;
      attacker.chasing = true;
      return attacker.id;
    },
  });
}
