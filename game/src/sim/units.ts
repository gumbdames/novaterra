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
 * NOVATERRA — sim/units.ts — the unit store.
 *
 * Responsibilities:
 *  - Plain-data records for mobile entities (units): id, owner, kind,
 *    position, speed, order state, and combat state (hp, cooldown,
 *    target). The roster is 31 land + 30 air + 35 sea (96 kinds: the 68
 *    base kinds plus the grand-expansion Phase 8 Mk II/Mk III tech-level
 *    variants, workstream D, 2026-09-30 — land gained tank/artillery/aa/
 *    apc/hauler Mk II+III, air gained fighter/fighterBomber/attackHeli/
 *    gunship Mk II+III, sea gained destroyer/frigate/submarine/
 *    missileBoat/transportShip Mk II+III; variants share the base kind's
 *    art — see `variantOf` on UnitDef and sim/variants.ts).
 *  - Unit ids come from `world.nextId` (the same counter as entities), so
 *    they are stable, never reused, and never collide with entity ids.
 *  - Movement state lives here too (`path`, `fieldId`, `destX/Z`); the
 *    pathfinding coordinator (`pathfinding.ts`) and the movement system
 *    (`movement.ts`) mutate it. `spawnUnit` is registered here; the move
 *    orders live in `movement.ts` next to the systems that serve them;
 *    combat lives in `combat.ts`.
 *
 * y-position: units store x/z only; height comes from `heightAt` at
 * movement/render time, so it is never part of snapshots or digests.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { World } from './world';
import type { TerrainData } from './terrain';
import { isWater } from './terrain';
import { getPlayer, MAP_HALF_SIZE, BUILDING_DEFS, hasProductionBuilding, cellCenterWorld, defaultHangarSlots, findBuildingHangarSlot } from './city';
import type { BuildingKind, HangarClass, ResourceKey } from './city';
import type { CommandQueue } from './commands';
import type { Age } from './ages';
import { isUnitAvailableForAge } from './ages';
import { effectiveMaxHp, effectiveSpeed } from './upgrades';

/**
 * The full 96-unit roster: the 68 base kinds (spec
 * docs/research/roster-expansion.md §2, plus Phase 3 logistics trucks,
 * Phase 4 transports, Phase 5 aircraft expansion, Phase 6 naval
 * expansion, and the grand-expansion intel roster §3.8/S6 workstream 2)
 * plus the 28 grand-expansion Phase 8 tech-level variants (workstream D,
 * 2026-09-30 — Mk II/Mk III of tank, artillery, aa, apc, hauler,
 * fighter, fighterBomber, attackHeli, gunship, destroyer, frigate,
 * submarine, missileBoat, transportShip).
 * Land (21): engineer, rifles, tank, artillery, aa, hauler, supplyTruck,
 * fuelTruck, spectre, hq, apc, tankDestroyer, mlrs, sniperTeam, combatMedic,
 * passengerTrain, freightTrain, bus, tram, spy, reconTeam.
 * Air (22): fighter, transport, drone, fighterBomber, attackHeli, awacs,
 * strategicBomber, maritimePatrol, reconUAV, armedUAV, reconPlane, gunship,
 * tanker, militaryCargo, trainer, navalFighter, airliner, jumboAirliner,
 * regionalJet, cargoPlane, passengerHeli, seaplane.
 * Sea (25): patrolBoat, destroyer, transportShip, missileBoat, frigate,
 * submarine, carrier, commandShip, fishingBoat, ferry, coastalSub, missileSub,
 * corvette, cruiser, battleship, heavyDestroyer, cargoFreighter, fuelTanker,
 * ammoShip, repairShip, minelayer, navalMine, coastGuardCutter, cruiseLiner,
 * yacht.
 */
export const UNIT_KINDS = [
  'engineer',
  'rifles',
  'tank',
  'artillery',
  'aa',
  'hauler',
  'supplyTruck',
  'fuelTruck',
  'spectre',
  'hq',
  'fighter',
  'transport',
  'drone',
  'patrolBoat',
  'destroyer',
  'transportShip',
  'sniperTeam',
  'combatMedic',
  'apc',
  'tankDestroyer',
  'mlrs',
  'fighterBomber',
  'attackHeli',
  'awacs',
  // ------------------------------------------------------------------
  // Grand-expansion Phase 5 — aircraft expansion (workstream B,
  // 2026-09-30). 16 new air kinds: 10 military (strike, patrol, recon,
  // CAS, logistics, carrier wing) + 6 civilian (airline roster —
  // routes are the sibling airport workstream's). The sea section
  // below this block belongs to the naval-expansion workstream — stay
  // in this region.
  // ------------------------------------------------------------------
  'strategicBomber',
  'maritimePatrol',
  'reconUAV',
  'armedUAV',
  'reconPlane',
  'gunship',
  'tanker',
  'militaryCargo',
  'trainer',
  'navalFighter',
  'airliner',
  'jumboAirliner',
  'regionalJet',
  'cargoPlane',
  'passengerHeli',
  'seaplane',
  'missileBoat',
  'frigate',
  'submarine',
  'carrier',
  'commandShip',
  'fishingBoat',
  // Phase 4 transport (S7, 2026-09-30): civilian transports — fare/freight
  // earners gated by their network (see `transitEarnings`, `railBound`).
  'passengerTrain',
  'freightTrain',
  'bus',
  'tram',
  'ferry',
  // ------------------------------------------------------------------
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30). 15 new sea kinds: sub variants, surface combatants,
  // logistics ships, civilian sea, the minelayer + its deployable mine,
  // and the coast-guard cutter. The air section above this block belongs
  // to the aircraft-expansion workstream — stay in this region.
  // ------------------------------------------------------------------
  'coastalSub',
  'missileSub',
  'corvette',
  'cruiser',
  'battleship',
  'heavyDestroyer',
  'cargoFreighter',
  'fuelTanker',
  'ammoShip',
  'repairShip',
  'minelayer',
  'navalMine',
  'coastGuardCutter',
  'cruiseLiner',
  'yacht',
  // ------------------------------------------------------------------
  // Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
  // 2026-09-30). Two land kinds: the spy (stealth, trained at the
  // intelHQ, acts through the sim-core workstream's infiltrate/
  // sabotage commands) and the reconTeam (the overt recon option —
  // fast, high sight, no stealth).
  // ------------------------------------------------------------------
  'spy',
  'reconTeam',
  // ------------------------------------------------------------------
  // Grand-expansion Phase 8 — tech-level variants (workstream D,
  // 2026-09-30). 28 kinds: Mk II / Mk III of the 14 workhorse kinds
  // (land: tank, artillery, aa, apc, hauler; air: fighter,
  // fighterBomber, attackHeli, gunship; sea: destroyer, frigate,
  // submarine, missileBoat, transportShip). Distinct UnitKinds sharing
  // the base kind's art via `variantOf` (§AD12 — zero new model keys);
  // gated by `minAge` (Mk II one age above the base, floored at
  // industry — foundation-base lines jump straight to industry; Mk III
  // one age above Mk II) + the base's `requiredBuilding`. See
  // sim/variants.ts for the gating helpers.
  // ------------------------------------------------------------------
  'tankMk2',
  'tankMk3',
  'artilleryMk2',
  'artilleryMk3',
  'aaMk2',
  'aaMk3',
  'apcMk2',
  'apcMk3',
  'haulerMk2',
  'haulerMk3',
  'fighterMk2',
  'fighterMk3',
  'fighterBomberMk2',
  'fighterBomberMk3',
  'attackHeliMk2',
  'attackHeliMk3',
  'gunshipMk2',
  'gunshipMk3',
  'destroyerMk2',
  'destroyerMk3',
  'frigateMk2',
  'frigateMk3',
  'submarineMk2',
  'submarineMk3',
  'missileBoatMk2',
  'missileBoatMk3',
  'transportShipMk2',
  'transportShipMk3',
] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** Which map layer a unit lives on. Air units fly over terrain and water. */
export type UnitDomain = 'land' | 'air' | 'sea';

/** How tough a unit is against incoming fire (see `vsLight/vsMedium/vsHeavy`). */
export type ArmorClass = 'light' | 'medium' | 'heavy';

/** What a weapon can be aimed at. `none` = unarmed (hauler, transport). */
export type TargetClass = 'ground' | 'air' | 'both' | 'none' | 'sea' | 'seaAir';

/** Order lifecycle. `failed` always carries a `failReason` — never silent. */
export type UnitState = 'idle' | 'awaitingPath' | 'moving' | 'failed';

/**
 * Static per-kind definition. Balance numbers are Phase 1 engineering
 * choices tuned for readable counters:
 *  - tank beats rifles (armor shrugs off light weapons; tank gun
 *    one-twos infantry),
 *  - artillery beats tank at range (outranges it, bonus vs heavy) but is
 *    helpless up close (minRange: rifles walk inside and it cannot fire),
 *  - aa beats anything that flies (large vsAir bonus),
 *  - fighter beats drone/transport (air superiority),
 *  - spectre beats soft high-value targets (bonus vs medium: artillery, aa).
 */
export interface UnitDef {
  kind: UnitKind;
  /** Display name for UI/docs. */
  name: string;
  domain: UnitDomain;
  /** Max (and spawn) hit points. */
  hp: number;
  /** Speed in world units per second. */
  speed: number;
  armor: ArmorClass;
  /** Damage per shot. 0 = unarmed. */
  damage: number;
  /** Weapon range in world units. */
  range: number;
  /** Cannot fire closer than this (artillery dead zone). */
  minRange: number;
  /** Ticks between shots (30 ticks = 1 sim-second). */
  cooldownTicks: number;
  targets: TargetClass;
  /** Damage multiplier vs each armor class (ground targets). */
  vsLight: number;
  vsMedium: number;
  vsHeavy: number;
  /** Extra multiplier when the target flies (aa, fighter). */
  vsAir: number;
  /** How far the unit notices enemies (for AI; combat fires at `range`). */
  sight: number;
  /** Minimum age required to build this unit. Fighters need Connectivity. */
  minAge: Age;
  /** Manpower cost to train (0 for civilian/unmanned units). Deducted from player.manpower. */
  manpowerCost: number;
  /**
   * Training cost in funds (spec §"The training-cost gap": training used
   * to cost only manpower). Validated at enqueue AND apply, deducted on
   * apply.
   */
  trainFunds: number;
  /** Training cost in materials. Validated at enqueue AND apply, deducted on apply. */
  trainMaterials: number;
  /**
   * Production building the owner must have completed (progress >= 1) to
   * train this kind. Undefined = trainable from the start (engineer,
   * rifles, hauler, drone, transport, patrolBoat, transportShip,
   * fishingBoat, hq). Applies on top of minAge — both must be satisfied.
   */
  requiredBuilding?: BuildingKind;
  /**
   * Phase 3 logistics. Fuel tank size in fuel units; undefined = no fuel
   * tracking (infantry, unmanned). `fuelPerSecond` burns only while the
   * unit is actually moving (see movement.ts).
   */
  fuelCapacity?: number;
  /** Fuel burned per sim-second of movement. */
  fuelPerSecond?: number;
  /**
   * Missile/ordnance magazine size; undefined = no ammo tracking.
   * `ammoPerShot` is consumed per shot in combat.ts.
   */
  ammoCapacity?: number;
  /** Ammo consumed per shot (missile weapons: 1). */
  ammoPerShot?: number;
  /**
   * 'fossil' burns fuel and must refuel; 'nuclear' is exempt from
   * refueling (missile sub, carrier — user directive 2026-09-30);
   * 'none'/undefined = no fuel system at all.
   */
  fuelType?: 'fossil' | 'nuclear' | 'none';
  /**
   * Phase 3 logistics: mobile supply holds. `cargoFuelCapacity` is how
   * much fuel the unit can carry for OTHER units (supplyTruck 100,
   * fuelTruck 220, hauler 40); `cargoAmmoCapacity` the same for ammo
   * (supplyTruck 40, hauler 20). Undefined = no hold. The live levels
   * sit on the record (`cargoFuel`/`cargoAmmo`); the resupply workstream
   * consumes them.
   */
  cargoFuelCapacity?: number;
  cargoAmmoCapacity?: number;
  /**
   * Grand-expansion Phase 5 (tanker, S2/S4 — 2026-09-30). When set, this
   * aircraft is a flying fuel station: on the economy tick it transfers
   * fuel from its cargo hold (`cargoFuel`, loaded at depots — the
   * supply-truck chain never loads aircraft) to friendly fossil-fuel
   * air units inside this radius (world units). The tanker itself keeps
   * burning from its own tank. Nuclear-fuel units are never refueled
   * (they never burn — the data-driven exemption). Set on `tanker`
   * only.
   */
  tankerRefuelRadius?: number;
  /**
   * Grand-expansion Phase 5/6, S4 (hangars + carriers). The aircraft
   * hangar class this unit parks as (`HangarClass` — matched against
   * hangar slot classes; 'generic' slots accept any class). Undefined
   * = the unit needs no hangar slot (non-aircraft). Every air def sets
   * one (assigned by the aircraft workstream). The AI's hangar-aware
   * canTrain (ai.ts) uses this to gate aircraft training on virtual
   * capacity.
   */
  hangarClass?: HangarClass;
  /**
   * Grand-expansion Phase 6 (carrier wings). True when this aircraft
   * can embark on a carrier (PLAN §3.7) — set on navalFighter (the
   * carrier multirole fighter), armedUAV/reconUAV (carrier-launched
   * strike/recon drones) and trainer (carrier qualification flights).
   * Undefined/false = not carrier-capable: the embarkAircraft command
   * rejects it loudly, and the UI never offers the order.
   */
  carrierCapable?: boolean;
  /**
   * Grand-expansion Phase 6 (carrier wings). How many aircraft this
   * unit carries (the carrier's wing — the carrier def sets 8 and
   * trains EMPTY; the wing fills only through embarkAircraft orders).
   * Undefined/0 = carries none.
   */
  wingCapacity?: number;
  /**
   * Phase 4 transport (S7). Civilian earnings rate in funds per
   * sim-second, paid by `runTransportEarnings` (economy.ts) ONLY while
   * the unit is on its network (see `isOnTransportNetwork` in city.ts).
   * Set on exactly the TRANSIT_EARNER_KINDS — the transport test pins
   * the two lists equal.
   */
  transitEarnings?: number;
  /**
   * Phase 4 transport (S7). When true the unit is rail-bound: it
   * steers along rail cells via the dedicated BFS router (rail.ts) and
   * never uses flow fields. Trains only.
   */
  railBound?: boolean;
  /**
   * Command aura: friendly attackers of `auraDomain` (or any domain when
   * undefined) within this radius get +`auraBonus` damage. Generalizes the
   * old HQ_AURA_* constants (hq: 20 / 0.25; commandShip: 24 / 0.25 sea).
   */
  auraRadius?: number;
  /** Command aura damage bonus as a fraction (0.25 = +25%). */
  auraBonus?: number;
  /** When set, the aura only buffs attackers of this domain. */
  auraDomain?: UnitDomain;
  /** Heal aura radius in world units (combatMedic: 12). */
  healRadius?: number;
  /** Heal aura rate in hp per sim-second (combatMedic: 2). */
  healPerSec?: number;
  /** Passive resource harvest per sim-second while alive (fishingBoat: food 0.6). */
  harvest?: Partial<Record<ResourceKey, number>>;
  // ------------------------------------------------------------------
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30). The S4 embark flags (hangarClass, carrierCapable,
  // wingCapacity) and record fields (embarkedOn, hangarBuildingId)
  // landed in the Phase 5/6 workstream above — they are not repeated
  // here. This block holds only the naval workstream's own flags.
  // ------------------------------------------------------------------
  /**
   * When true, this kind is never trained via `spawnUnit` — it enters
   * the world only through its own command (navalMine: `deployMine`
   * from a minelayer). The spawnUnit validator rejects it loudly, and
   * the combat fire pass skips it (its `damage` is spent by its own
   * detonation logic, not by shooting).
   */
  deployableOnly?: boolean;
  /**
   * Which domain this unit's heal aura covers (repairShip: 'sea').
   * Default 'land' — the combatMedic behavior is unchanged.
   */
  healDomain?: UnitDomain;
  // ------------------------------------------------------------------
  // Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
  // 2026-09-30). The def-side of the stealth contract: the sim-core
  // workstream's `isDetected(unit, viewerOwner, world)` (sim/intel.ts)
  // treats a stealthed unit as invisible unless it stands inside a
  // detection radius, and combat.ts `acquireTarget` skips stealthed
  // units unless detected. Set on `spy` and `spectre` (R1
  // final-review, user decision 2026-10-01 — the docs always called
  // the spectre a "stealthy raider").
  // ------------------------------------------------------------------
  /**
   * When true, this unit is invisible to enemies unless detected (see
   * `isDetected` in sim/intel.ts). Detection only — the covert-ops
   * role (infiltrate/sabotage/steal) stays kind-gated on the spy via
   * `isSpyUnit`.
   */
  stealth?: boolean;
  // ------------------------------------------------------------------
  // Grand-expansion Phase 7 (S6 intel, workstream 3, 2026-09-30): the
  // dedicated-recon flag. A living recon unit whose sight covers a
  // rival's mixed airport anchor *observes* it — the recon-overflight
  // discovery source (`airportObservedBy` in sim/intel.ts). Set on
  // reconTeam, reconUAV, reconPlane.
  // ------------------------------------------------------------------
  /**
   * When true, this unit is a dedicated recon asset: its overflight
   * can discover mixed-use airports (and it is the honest,
   * always-visible alternative to the spy). Only reconTeam, reconUAV,
   * reconPlane set this.
   */
  recon?: boolean;
  /**
   * Grand-expansion Phase 8 (peaceful mode, 2026-09-30): true when this
   * unit is a weapon of war — combat units, military logistics and
   * support (supply/fuel chains, medics, AWACS/tankers, naval fleet
   * support), and the intel/sabotage apparatus (spy). In a peaceful
   * world (`world.peaceful`), `spawnUnit` rejects military defs loudly
   * and the order never reaches the queue.
   *
   * The predicate is intentionally conservative about the civilian
   * economy: unarmed transports (transport, transportShip), the
   * engineer (the game's builder — its 5-damage sidearm is flavor, not
   * a weapon system), the hauler, the civilian sea/air earners
   * (fishingBoat, cargoFreighter, cruiseLiner, yacht, ferries, buses,
   * trains, airliners), and the unarmed pure-recon aircraft
   * (reconUAV, reconPlane) stay civilian. Note the recon aircraft
   * require an airfield (military-locked), so they are unreachable in
   * peaceful games anyway — they stay civilian so a civilian
   * airfield-style path could use them later. See
   * docs/research/phase8-civilian-peaceful.md for the full roster and
   * the judgment calls.
   */
  military?: boolean;
  // ------------------------------------------------------------------
  // Grand-expansion Phase 8 (tech levels, workstream D, 2026-09-30):
  // Mk II / Mk III tech-level variants. A variant is a DISTINCT UnitKind
  // (its own def, its own train command, its own record kind id) that
  // shares the base kind's art: `variantArtBase` in sim/variants.ts
  // resolves it to `variantOf` for the render layer, so the variant
  // reuses the base's MODEL_SOURCES entry — zero new MODEL_PATHS keys
  // (§AD12). Gating is def-driven, not code-driven: `minAge` +
  // `requiredBuilding` are checked by the existing spawnUnit validator,
  // and `military` variants are locked out in peaceful worlds by the
  // WS-A lockout. `variantTier` is 2 (Mk II) or 3 (Mk III); base kinds
  // leave both fields undefined.
  // ------------------------------------------------------------------
  /** The base kind this variant upgrades (e.g. 'tankMk2' → 'tank'). */
  variantOf?: UnitKind;
  /** Tech tier of a variant: 2 = Mk II, 3 = Mk III. */
  variantTier?: number;
}

/** Mobile HQ command aura: radius and friendly damage bonus. */
export const HQ_AURA_RADIUS = 20;
export const HQ_AURA_DAMAGE_BONUS = 0.25;

/**
 * Phase 3 logistics provisioning (S2, PLAN §3.2). Every number below is a
 * deliberate tempo choice, documented once here instead of per line:
 *
 * AMMO — only missile weapons track magazines (one shot = one missile):
 * mlrs 6 (a single rocket pod — one alpha strike, then resupply),
 * missileBoat 8 (two 4-packs), submarine 12 (a torpedo room). Guns are
 * abstracted and never tracked. The ammo gate in combat.ts holds fire
 * when the magazine can't cover a full shot.
 *
 * FUEL — every mechanized unit burns fossil fuel while displacing
 * (fuelType 'fossil'); infantry (engineer, rifles, sniperTeam,
 * combatMedic) and the spectre stay untracked (the §3.2 roster names the
 * 8 ground vehicles explicitly; spectre is special-forces, not in that
 * list). Nuclear units (submarine, carrier) never burn or refuel — user
 * directive 2026-09-30 — but the sub still tracks its 12-missile
 * magazine. capacity/rate = seconds of continuous movement:
 *  - ground ~300-500 s. A tank at speed 10 crosses the 512-wide map in
 *    ~51 s, so 400 s ≈ 8 crossings: a tempo constraint on long
 *    offensives, never starvation in normal play. The hauler gets the
 *    longest legs (500 s) — it is the logistics backbone.
 *  - air ~80-150 s. Fighters are the tightest (90 s) on purpose: air
 *    power must stage from forward airfields. The AWACS loiters (150 s);
 *    the transport hauls far (137 s).
 *  - sea ~320-520 s. Ships cross oceans; their tanks are sized for long
 *    transits with margin.
 * Thirst scales loosely with speed so ranges stay comparable inside a
 * domain instead of fast units being punished twice.
 *
 * CARGO — mobile holds feed the resupply chain: supplyTruck 100 fuel /
 * 40 ammo (≈1.5 tank refills, ≈6 MLRS reloads), fuelTruck 220 fuel /
 * no ammo (dedicated tanker, ≈3.5 tank refills), hauler 40/20 (a light
 * field carrier, ≈2/3 of a tank refill). Holds spawn EMPTY — cargo is
 * loaded at depots, never conjured (the resupply workstream's rule).
 */
export const UNIT_DEFS: Record<UnitKind, UnitDef> = {  engineer: {
    kind: 'engineer', name: 'Engineer', domain: 'land', hp: 80, speed: 6, armor: 'light',
    damage: 5, range: 10, minRange: 0, cooldownTicks: 30, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.6, vsHeavy: 0.4, vsAir: 1.0, sight: 18, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 50, trainMaterials: 0,
  },
  rifles: {
    kind: 'rifles', name: 'Rifles', domain: 'land', hp: 110, speed: 9, armor: 'light',
    damage: 9, range: 15, minRange: 0, cooldownTicks: 20, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.55, vsHeavy: 0.3, vsAir: 1.0, sight: 22, minAge: 'foundation',
    manpowerCost: 2, trainFunds: 60, trainMaterials: 0,
    military: true,
  },
  tank: {
    kind: 'tank', name: 'Main Battle Tank', domain: 'land', hp: 500, speed: 10, armor: 'heavy',
    damage: 50, range: 19, minRange: 0, cooldownTicks: 50, targets: 'ground',
    vsLight: 1.3, vsMedium: 1.0, vsHeavy: 0.9, vsAir: 1.0, sight: 26, minAge: 'foundation',
    manpowerCost: 5, trainFunds: 400, trainMaterials: 60, requiredBuilding: 'warFactory',
    fuelCapacity: 60, fuelPerSecond: 0.15, fuelType: 'fossil', // 400 s ≈ 8 map crossings
    military: true,
  },
  artillery: {
    kind: 'artillery', name: 'Artillery', domain: 'land', hp: 160, speed: 6, armor: 'medium',
    damage: 95, range: 48, minRange: 12, cooldownTicks: 100, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.4, vsHeavy: 1.6, vsAir: 1.0, sight: 30, minAge: 'foundation',
    manpowerCost: 4, trainFunds: 450, trainMaterials: 80, requiredBuilding: 'warFactory',
    fuelCapacity: 40, fuelPerSecond: 0.10, fuelType: 'fossil', // 400 s; slow gun, sips fuel
    military: true,
  },
  aa: {
    kind: 'aa', name: 'Mobile AA', domain: 'land', hp: 200, speed: 10, armor: 'medium',
    damage: 40, range: 28, minRange: 0, cooldownTicks: 25, targets: 'air',
    vsLight: 0.3, vsMedium: 0.3, vsHeavy: 0.3, vsAir: 2.2, sight: 34, minAge: 'foundation',
    manpowerCost: 4, trainFunds: 350, trainMaterials: 60, requiredBuilding: 'warFactory',
    fuelCapacity: 50, fuelPerSecond: 0.15, fuelType: 'fossil', // ~333 s
    military: true,
  },
  hauler: {
    kind: 'hauler', name: 'Hauler', domain: 'land', hp: 160, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 16, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 120, trainMaterials: 20,
    fuelCapacity: 60, fuelPerSecond: 0.12, fuelType: 'fossil', // 500 s — longest land legs
    cargoFuelCapacity: 40, cargoAmmoCapacity: 20, // light field carrier role (Phase 3)
  },
  supplyTruck: {
    kind: 'supplyTruck', name: 'Supply Truck', domain: 'land', hp: 140, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 16, minAge: 'foundation',
    // Hauler precedent: no production gate (logistics must work from the
    // start), no manpower (civilian drivers), modest funds/materials cost.
    manpowerCost: 0, trainFunds: 180, trainMaterials: 40,
    fuelCapacity: 60, fuelPerSecond: 0.15, fuelType: 'fossil', // 400 s own tank
    cargoFuelCapacity: 100, cargoAmmoCapacity: 40, // the field resupply workhorse
    military: true,
  },
  fuelTruck: {
    kind: 'fuelTruck', name: 'Fuel Truck', domain: 'land', hp: 140, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 16, minAge: 'foundation',
    // Hauler precedent, like supplyTruck; pricier for the bigger tank.
    manpowerCost: 0, trainFunds: 200, trainMaterials: 60,
    fuelCapacity: 60, fuelPerSecond: 0.15, fuelType: 'fossil', // 400 s own tank
    cargoFuelCapacity: 220, // dedicated tanker; no ammo hold
    military: true,
  },
  spectre: {
    kind: 'spectre', name: 'Spectre', domain: 'land', hp: 130, speed: 12, armor: 'light',
    damage: 75, range: 10, minRange: 0, cooldownTicks: 45, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.6, vsHeavy: 1.3, vsAir: 1.0, sight: 24, minAge: 'foundation',
    manpowerCost: 3, trainFunds: 300, trainMaterials: 20, requiredBuilding: 'barracks',
    // R1 final-review (user decision 2026-10-01): the docs always called
    // the spectre a "stealthy raider" and the user ruled the docs right —
    // the missing flag was the bug. Stealth here is the detection
    // contract only (invisible outside detection radii, see isDetected in
    // sim/intel.ts); it grants no covert-ops role — infiltrate/sabotage/
    // stealTech stay spy-only (isSpyUnit is kind-gated).
    stealth: true,
    military: true,
  },
  hq: {
    kind: 'hq', name: 'Mobile HQ', domain: 'land', hp: 400, speed: 7, armor: 'heavy',
    damage: 12, range: 13, minRange: 0, cooldownTicks: 30, targets: 'ground',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.0, sight: 28, minAge: 'foundation',
    manpowerCost: 2, trainFunds: 600, trainMaterials: 100,
    auraRadius: HQ_AURA_RADIUS, auraBonus: HQ_AURA_DAMAGE_BONUS,
    fuelCapacity: 70, fuelPerSecond: 0.18, fuelType: 'fossil', // ~389 s; heavy command vehicle
    military: true,
  },
  fighter: {
    kind: 'fighter', name: 'Fighter', domain: 'air', hp: 170, speed: 26, armor: 'light',
    damage: 32, range: 24, minRange: 0, cooldownTicks: 28, targets: 'both',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.6, sight: 40, minAge: 'connectivity',
    manpowerCost: 3, trainFunds: 800, trainMaterials: 120, requiredBuilding: 'airfield',
    fuelCapacity: 45, fuelPerSecond: 0.5, fuelType: 'fossil', // 90 s — the air tempo constraint
    hangarClass: 'medium',
    military: true,
  },
  transport: {
    kind: 'transport', name: 'Transport', domain: 'air', hp: 240, speed: 22, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'foundation',
    manpowerCost: 2, trainFunds: 500, trainMaterials: 80,
    fuelCapacity: 55, fuelPerSecond: 0.4, fuelType: 'fossil', // ~137 s; airlifter legs
    hangarClass: 'heavy',
  },
  drone: {
    kind: 'drone', name: 'Drone', domain: 'air', hp: 55, speed: 20, armor: 'light',
    damage: 9, range: 13, minRange: 0, cooldownTicks: 22, targets: 'both',
    vsLight: 0.9, vsMedium: 0.5, vsHeavy: 0.3, vsAir: 1.0, sight: 26, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 80, trainMaterials: 10,
    fuelCapacity: 25, fuelPerSecond: 0.25, fuelType: 'fossil', // 100 s; efficient, tiny tank
    hangarClass: 'light',
    military: true,
  },
  patrolBoat: {
    kind: 'patrolBoat', name: 'Patrol Boat', domain: 'sea', hp: 220, speed: 14, armor: 'light',
    damage: 18, range: 20, minRange: 0, cooldownTicks: 25, targets: 'sea',
    vsLight: 1.2, vsMedium: 0.8, vsHeavy: 0.5, vsAir: 0.8, sight: 30, minAge: 'industry',
    manpowerCost: 3, trainFunds: 250, trainMaterials: 60,
    fuelCapacity: 70, fuelPerSecond: 0.2, fuelType: 'fossil', // 350 s
    military: true,
  },
  destroyer: {
    kind: 'destroyer', name: 'Destroyer', domain: 'sea', hp: 600, speed: 11, armor: 'heavy',
    damage: 45, range: 26, minRange: 0, cooldownTicks: 40, targets: 'seaAir',
    vsLight: 1.3, vsMedium: 1.1, vsHeavy: 1.0, vsAir: 1.8, sight: 34, minAge: 'industry',
    manpowerCost: 6, trainFunds: 1500, trainMaterials: 400, requiredBuilding: 'navalYard',
    fuelCapacity: 120, fuelPerSecond: 0.25, fuelType: 'fossil', // 480 s; fleet legs
    military: true,
  },
  transportShip: {
    kind: 'transportShip', name: 'Transport Ship', domain: 'sea', hp: 350, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 22, minAge: 'industry',
    manpowerCost: 2, trainFunds: 400, trainMaterials: 100,
    fuelCapacity: 120, fuelPerSecond: 0.25, fuelType: 'fossil', // 480 s
  },
  // ------------------------------------------------------------------
  // Roster expansion (spec docs/research/roster-expansion.md §2): 14 new.
  // ------------------------------------------------------------------
  sniperTeam: {
    kind: 'sniperTeam', name: 'Sniper Team', domain: 'land', hp: 90, speed: 8, armor: 'light',
    damage: 45, range: 30, minRange: 0, cooldownTicks: 70, targets: 'ground',
    vsLight: 1.6, vsMedium: 0.8, vsHeavy: 0.4, vsAir: 1.0, sight: 36, minAge: 'connectivity',
    manpowerCost: 3, trainFunds: 200, trainMaterials: 20, requiredBuilding: 'barracks',
    military: true,
  },
  combatMedic: {
    kind: 'combatMedic', name: 'Combat Medic', domain: 'land', hp: 100, speed: 9, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    manpowerCost: 2, trainFunds: 150, trainMaterials: 10, requiredBuilding: 'barracks',
    healRadius: 12, healPerSec: 2,
    military: true,
  },
  apc: {
    kind: 'apc', name: 'Armored Personnel Carrier', domain: 'land', hp: 320, speed: 12, armor: 'medium',
    damage: 14, range: 16, minRange: 0, cooldownTicks: 25, targets: 'ground',
    vsLight: 1.3, vsMedium: 0.8, vsHeavy: 0.5, vsAir: 1.0, sight: 24, minAge: 'connectivity',
    manpowerCost: 4, trainFunds: 250, trainMaterials: 40, requiredBuilding: 'warFactory',
    fuelCapacity: 48, fuelPerSecond: 0.16, fuelType: 'fossil', // 300 s; quick battle-taxi
    military: true,
  },
  tankDestroyer: {
    kind: 'tankDestroyer', name: 'Tank Destroyer', domain: 'land', hp: 380, speed: 9, armor: 'medium',
    damage: 70, range: 24, minRange: 0, cooldownTicks: 60, targets: 'ground',
    vsLight: 0.6, vsMedium: 1.2, vsHeavy: 1.8, vsAir: 1.0, sight: 26, minAge: 'industry',
    manpowerCost: 5, trainFunds: 500, trainMaterials: 90, requiredBuilding: 'warFactory',
    fuelCapacity: 55, fuelPerSecond: 0.15, fuelType: 'fossil', // ~367 s
    military: true,
  },
  mlrs: {
    kind: 'mlrs', name: 'MLRS', domain: 'land', hp: 180, speed: 7, armor: 'medium',
    damage: 140, range: 40, minRange: 14, cooldownTicks: 160, targets: 'ground',
    vsLight: 1.6, vsMedium: 1.2, vsHeavy: 1.2, vsAir: 1.0, sight: 28, minAge: 'industry',
    manpowerCost: 5, trainFunds: 600, trainMaterials: 120, requiredBuilding: 'warFactory',
    ammoCapacity: 6, ammoPerShot: 1, // one 6-rocket pod: a single alpha strike per load
    fuelCapacity: 45, fuelPerSecond: 0.12, fuelType: 'fossil', // 375 s
    military: true,
  },
  fighterBomber: {
    kind: 'fighterBomber', name: 'Fighter-Bomber', domain: 'air', hp: 200, speed: 28, armor: 'medium',
    damage: 120, range: 20, minRange: 0, cooldownTicks: 90, targets: 'ground',
    vsLight: 0.8, vsMedium: 1.0, vsHeavy: 1.6, vsAir: 1.0, sight: 32, minAge: 'industry',
    manpowerCost: 4, trainFunds: 1000, trainMaterials: 150, requiredBuilding: 'airfield',
    fuelCapacity: 55, fuelPerSecond: 0.55, fuelType: 'fossil', // 100 s; strike needs the extra tank
    hangarClass: 'medium',
    military: true,
  },
  attackHeli: {
    kind: 'attackHeli', name: 'Attack Helicopter', domain: 'air', hp: 150, speed: 30, armor: 'light',
    damage: 60, range: 22, minRange: 0, cooldownTicks: 55, targets: 'ground',
    vsLight: 0.9, vsMedium: 1.1, vsHeavy: 1.5, vsAir: 1.0, sight: 30, minAge: 'connectivity',
    manpowerCost: 4, trainFunds: 700, trainMaterials: 100, requiredBuilding: 'airfield',
    fuelCapacity: 40, fuelPerSecond: 0.5, fuelType: 'fossil', // 80 s; helos are thirsty
    hangarClass: 'light',
    military: true,
  },
  awacs: {
    kind: 'awacs', name: 'AWACS', domain: 'air', hp: 180, speed: 24, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 65, minAge: 'information',
    manpowerCost: 3, trainFunds: 900, trainMaterials: 120, requiredBuilding: 'airfield',
    fuelCapacity: 60, fuelPerSecond: 0.4, fuelType: 'fossil', // 150 s; endurance is its job
    hangarClass: 'heavy',
    military: true,
  },
  // ------------------------------------------------------------------
  // Grand-expansion Phase 5 (aircraft expansion, S4 — 2026-09-30): 16
  // new aircraft. Every def sets `hangarClass` (S/M/L → light/medium/
  // heavy); the four carrier-capable kinds set `carrierCapable` (the
  // carrier's wing — PLAN §3.7); `strategicBomber` is the §3.2 missile
  // consumer (8-missile magazine), `armedUAV` a 4-missile hellfire-type
  // exception; `tanker`/`militaryCargo` are the S2 air-logistics pair.
  // All require the airfield (civil airports are the sibling Phase 5
  // workstream's). Balance: fighters are the ~90 s fuel-tempo baseline;
  // heavier/longer-legged frames trade speed for endurance.
  // ------------------------------------------------------------------
  strategicBomber: {
    kind: 'strategicBomber', name: 'Strategic Bomber', domain: 'air', hp: 260, speed: 24, armor: 'medium',
    damage: 200, range: 24, minRange: 0, cooldownTicks: 120, targets: 'ground',
    vsLight: 0.8, vsMedium: 1.2, vsHeavy: 1.8, vsAir: 1.0, sight: 34, minAge: 'information',
    manpowerCost: 5, trainFunds: 1800, trainMaterials: 260, requiredBuilding: 'airfield',
    ammoCapacity: 8, ammoPerShot: 1, // §3.2 missile consumer: a full heavy-ordnance bay
    fuelCapacity: 100, fuelPerSecond: 0.5, fuelType: 'fossil', // 200 s; intercontinental legs
    hangarClass: 'heavy',
    military: true,
  },
  maritimePatrol: {
    kind: 'maritimePatrol', name: 'Maritime Patrol', domain: 'air', hp: 170, speed: 27, armor: 'medium',
    damage: 70, range: 26, minRange: 0, cooldownTicks: 60, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.6, vsHeavy: 0.8, vsAir: 1.0, sight: 52, minAge: 'information',
    manpowerCost: 4, trainFunds: 1100, trainMaterials: 170, requiredBuilding: 'airfield',
    fuelCapacity: 90, fuelPerSecond: 0.5, fuelType: 'fossil', // 180 s; long ASW loiter
    hangarClass: 'medium',
    military: true,
  },
  reconUAV: {
    kind: 'reconUAV', name: 'Recon UAV', domain: 'air', hp: 45, speed: 32, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 58, minAge: 'connectivity',
    manpowerCost: 0, trainFunds: 220, trainMaterials: 30, requiredBuilding: 'airfield',
    fuelCapacity: 30, fuelPerSecond: 0.25, fuelType: 'fossil', // 120 s; cheap expendable eyes
    hangarClass: 'light', carrierCapable: true,
    recon: true, // dedicated recon asset — overflight can discover mixed airports
  },
  armedUAV: {
    kind: 'armedUAV', name: 'Armed UAV', domain: 'air', hp: 70, speed: 30, armor: 'light',
    damage: 45, range: 16, minRange: 0, cooldownTicks: 40, targets: 'ground',
    vsLight: 1.2, vsMedium: 0.9, vsHeavy: 0.5, vsAir: 1.0, sight: 40, minAge: 'connectivity',
    manpowerCost: 0, trainFunds: 450, trainMaterials: 70, requiredBuilding: 'airfield',
    ammoCapacity: 4, ammoPerShot: 1, // hellfire-type light missile rack
    fuelCapacity: 36, fuelPerSecond: 0.3, fuelType: 'fossil', // 120 s
    hangarClass: 'light', carrierCapable: true,
    military: true,
  },
  reconPlane: {
    kind: 'reconPlane', name: 'Recon Plane', domain: 'air', hp: 130, speed: 34, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 62, minAge: 'connectivity',
    manpowerCost: 2, trainFunds: 950, trainMaterials: 140, requiredBuilding: 'airfield',
    fuelCapacity: 64, fuelPerSecond: 0.4, fuelType: 'fossil', // 160 s; outruns what it can't outsee
    hangarClass: 'medium',
    recon: true, // dedicated recon asset — overflight can discover mixed airports
  },
  gunship: {
    kind: 'gunship', name: 'Gunship', domain: 'air', hp: 280, speed: 22, armor: 'medium',
    damage: 90, range: 20, minRange: 0, cooldownTicks: 55, targets: 'ground',
    vsLight: 1.5, vsMedium: 1.1, vsHeavy: 0.7, vsAir: 1.0, sight: 30, minAge: 'industry',
    manpowerCost: 4, trainFunds: 1400, trainMaterials: 210, requiredBuilding: 'airfield',
    fuelCapacity: 65, fuelPerSecond: 0.5, fuelType: 'fossil', // 130 s; heavy CAS loiter
    hangarClass: 'medium',
    military: true,
  },
  tanker: {
    kind: 'tanker', name: 'Tanker', domain: 'air', hp: 260, speed: 24, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 30, minAge: 'industry',
    manpowerCost: 2, trainFunds: 1300, trainMaterials: 190, requiredBuilding: 'airfield',
    fuelCapacity: 120, fuelPerSecond: 0.4, fuelType: 'fossil', // 300 s; its own long legs
    cargoFuelCapacity: 200, tankerRefuelRadius: 40, // flying fuel station (S2 air logistics)
    hangarClass: 'heavy',
    military: true,
  },
  militaryCargo: {
    kind: 'militaryCargo', name: 'Military Cargo', domain: 'air', hp: 300, speed: 20, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 24, minAge: 'industry',
    manpowerCost: 2, trainFunds: 1100, trainMaterials: 170, requiredBuilding: 'airfield',
    fuelCapacity: 96, fuelPerSecond: 0.4, fuelType: 'fossil', // 240 s; airlift legs
    cargoFuelCapacity: 60, cargoAmmoCapacity: 20, // air hauler for forward depots
    hangarClass: 'heavy',
    military: true,
  },
  trainer: {
    kind: 'trainer', name: 'Trainer', domain: 'air', hp: 100, speed: 28, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 34, minAge: 'connectivity',
    manpowerCost: 1, trainFunds: 350, trainMaterials: 50, requiredBuilding: 'airfield',
    fuelCapacity: 40, fuelPerSecond: 0.4, fuelType: 'fossil', // 100 s; cheap flight hours
    hangarClass: 'light', carrierCapable: true,
    military: true,
  },
  navalFighter: {
    kind: 'navalFighter', name: 'Naval Fighter', domain: 'air', hp: 190, speed: 27, armor: 'light',
    damage: 36, range: 24, minRange: 0, cooldownTicks: 28, targets: 'both',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.6, sight: 42, minAge: 'connectivity',
    manpowerCost: 3, trainFunds: 950, trainMaterials: 140, requiredBuilding: 'airfield',
    fuelCapacity: 55, fuelPerSecond: 0.5, fuelType: 'fossil', // 110 s; carrier strike range
    hangarClass: 'medium', carrierCapable: true,
    military: true,
  },
  airliner: {
    kind: 'airliner', name: 'Airliner', domain: 'air', hp: 200, speed: 26, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    manpowerCost: 2, trainFunds: 1500, trainMaterials: 200, requiredBuilding: 'airfield',
    fuelCapacity: 80, fuelPerSecond: 0.4, fuelType: 'fossil', // 200 s; scheduled legs
    hangarClass: 'heavy',
  },
  jumboAirliner: {
    kind: 'jumboAirliner', name: 'Jumbo Airliner', domain: 'air', hp: 320, speed: 24, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'industry',
    manpowerCost: 3, trainFunds: 2200, trainMaterials: 320, requiredBuilding: 'airfield',
    fuelCapacity: 96, fuelPerSecond: 0.4, fuelType: 'fossil', // 240 s; long-haul
    hangarClass: 'heavy',
  },
  regionalJet: {
    kind: 'regionalJet', name: 'Regional Jet', domain: 'air', hp: 150, speed: 30, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    manpowerCost: 1, trainFunds: 800, trainMaterials: 110, requiredBuilding: 'airfield',
    fuelCapacity: 48, fuelPerSecond: 0.3, fuelType: 'fossil', // 160 s; short hops
    hangarClass: 'medium',
  },
  cargoPlane: {
    kind: 'cargoPlane', name: 'Cargo Plane', domain: 'air', hp: 280, speed: 22, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 24, minAge: 'industry',
    manpowerCost: 1, trainFunds: 1200, trainMaterials: 200, requiredBuilding: 'airfield',
    fuelCapacity: 96, fuelPerSecond: 0.4, fuelType: 'fossil', // 240 s; freight legs
    hangarClass: 'heavy',
  },
  passengerHeli: {
    kind: 'passengerHeli', name: 'Passenger Heli', domain: 'air', hp: 90, speed: 24, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    manpowerCost: 1, trainFunds: 500, trainMaterials: 80, requiredBuilding: 'airfield',
    fuelCapacity: 36, fuelPerSecond: 0.3, fuelType: 'fossil', // 120 s; city hops
    hangarClass: 'light',
  },
  seaplane: {
    kind: 'seaplane', name: 'Seaplane', domain: 'air', hp: 80, speed: 26, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    manpowerCost: 0, trainFunds: 450, trainMaterials: 70, requiredBuilding: 'airfield',
    fuelCapacity: 42, fuelPerSecond: 0.3, fuelType: 'fossil', // 140 s; bush legs
    hangarClass: 'light',
  },
  missileBoat: {
    kind: 'missileBoat', name: 'Missile Boat', domain: 'sea', hp: 180, speed: 18, armor: 'light',
    damage: 70, range: 22, minRange: 0, cooldownTicks: 70, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.1, vsHeavy: 1.5, vsAir: 1.0, sight: 28, minAge: 'connectivity',
    manpowerCost: 4, trainFunds: 500, trainMaterials: 120, requiredBuilding: 'shipyard',
    ammoCapacity: 8, ammoPerShot: 1, // two 4-packs of anti-ship missiles
    fuelCapacity: 80, fuelPerSecond: 0.25, fuelType: 'fossil', // 320 s; fast strike craft
    military: true,
  },
  frigate: {
    kind: 'frigate', name: 'Frigate', domain: 'sea', hp: 420, speed: 13, armor: 'medium',
    damage: 30, range: 24, minRange: 0, cooldownTicks: 35, targets: 'seaAir',
    vsLight: 1.2, vsMedium: 1.6, vsHeavy: 0.8, vsAir: 1.2, sight: 32, minAge: 'industry',
    manpowerCost: 5, trainFunds: 900, trainMaterials: 220, requiredBuilding: 'navalYard',
    fuelCapacity: 110, fuelPerSecond: 0.25, fuelType: 'fossil', // 440 s
    military: true,
  },
  submarine: {
    kind: 'submarine', name: 'Submarine', domain: 'sea', hp: 300, speed: 10, armor: 'medium',
    damage: 90, range: 30, minRange: 0, cooldownTicks: 80, targets: 'sea',
    vsLight: 0.8, vsMedium: 1.5, vsHeavy: 2.0, vsAir: 1.0, sight: 26, minAge: 'industry',
    manpowerCost: 6, trainFunds: 1200, trainMaterials: 300, requiredBuilding: 'navalYard',
    ammoCapacity: 12, ammoPerShot: 1, // a torpedo room; still tracked under nuclear fuel
    fuelType: 'nuclear', // no conventional refueling — user directive 2026-09-30
    military: true,
  },
  carrier: {
    kind: 'carrier', name: 'Carrier', domain: 'sea', hp: 900, speed: 8, armor: 'heavy',
    damage: 40, range: 30, minRange: 0, cooldownTicks: 45, targets: 'seaAir',
    vsLight: 1.2, vsMedium: 1.0, vsHeavy: 0.9, vsAir: 2.0, sight: 36, minAge: 'information',
    manpowerCost: 10, trainFunds: 3500, trainMaterials: 1000, requiredBuilding: 'navalYard',
    fuelType: 'nuclear', // no conventional refueling — user directive 2026-09-30
    // Grand-expansion Phase 5/6 (S4): the carrier sails with an empty
    // 8-slot wing (PLAN §4 S4) — it trains EMPTY and the wing fills
    // only through embarkAircraft orders (carrierCapable kinds:
    // navalFighter, armedUAV, reconUAV, trainer).
    wingCapacity: 8,
    military: true,
  },
  commandShip: {
    kind: 'commandShip', name: 'Command Ship', domain: 'sea', hp: 700, speed: 9, armor: 'heavy',
    damage: 20, range: 18, minRange: 0, cooldownTicks: 40, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 40, minAge: 'information',
    manpowerCost: 6, trainFunds: 2000, trainMaterials: 500, requiredBuilding: 'navalYard',
    auraRadius: 24, auraBonus: 0.25, auraDomain: 'sea',
    fuelCapacity: 130, fuelPerSecond: 0.25, fuelType: 'fossil', // 520 s; flagship bunkers
    military: true,
  },
  fishingBoat: {
    kind: 'fishingBoat', name: 'Fishing Boat', domain: 'sea', hp: 120, speed: 12, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 18, minAge: 'foundation',
    manpowerCost: 0, trainFunds: 150, trainMaterials: 30,
    harvest: { food: 0.6 },
    fuelCapacity: 60, fuelPerSecond: 0.15, fuelType: 'fossil', // 400 s; workboat tank
  },
  // ------------------------------------------------------------------
  // Phase 4 transport (S7, grand expansion): civilian transports.
  // All unarmed (targets 'none') — they earn fares/freight while on
  // their network instead of fighting. The Classic AI never trains
  // them (documented no-op hook `thinkCivilianTransport` in ai.ts).
  // ------------------------------------------------------------------
  passengerTrain: {
    kind: 'passengerTrain', name: 'Passenger Train', domain: 'land', hp: 260, speed: 14, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'industry',
    // Needs a station to run from (rail gate).
    requiredBuilding: 'railStation',
    manpowerCost: 2, trainFunds: 900, trainMaterials: 250,
    fuelCapacity: 200, fuelPerSecond: 0.2, fuelType: 'fossil', // 1000 s; diesel consist
    railBound: true,
    transitEarnings: 1.2,
  },
  freightTrain: {
    kind: 'freightTrain', name: 'Freight Train', domain: 'land', hp: 320, speed: 10, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 18, minAge: 'industry',
    requiredBuilding: 'railStation',
    manpowerCost: 2, trainFunds: 800, trainMaterials: 300,
    fuelCapacity: 220, fuelPerSecond: 0.2, fuelType: 'fossil', // 1100 s; heavy haul
    railBound: true,
    transitEarnings: 1.0,
  },
  bus: {
    kind: 'bus', name: 'Bus', domain: 'land', hp: 100, speed: 9, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 16, minAge: 'connectivity',
    requiredBuilding: 'busDepot',
    manpowerCost: 1, trainFunds: 200, trainMaterials: 60,
    fuelCapacity: 60, fuelPerSecond: 0.15, fuelType: 'fossil', // 400 s city tank
    transitEarnings: 0.5,
  },
  tram: {
    kind: 'tram', name: 'Tram', domain: 'land', hp: 120, speed: 7, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 16, minAge: 'connectivity',
    requiredBuilding: 'busDepot',
    manpowerCost: 1, trainFunds: 250, trainMaterials: 80,
    // Diesel abstraction (like supplyTruck's 'fossil'): the streetcar
    // fleet refuels at the depot through the same logistics chain.
    fuelCapacity: 80, fuelPerSecond: 0.15, fuelType: 'fossil', // 533 s
    transitEarnings: 0.6,
  },
  ferry: {
    kind: 'ferry', name: 'Ferry', domain: 'sea', hp: 220, speed: 11, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    requiredBuilding: 'ferryTerminal',
    manpowerCost: 2, trainFunds: 400, trainMaterials: 140,
    fuelCapacity: 120, fuelPerSecond: 0.2, fuelType: 'fossil', // 600 s crossing tank
    transitEarnings: 0.8,
  },
  // ------------------------------------------------------------------
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30). 15 new sea kinds. Sea tempo: fuel tanks size ~320–560 s
  // (ship fuelPerSecond ×30 in logistics.ts — the torpedo boats burn
  // hardest). The gunfighter/destroyer split: 'destroyer' is the
  // fleet's AA escort (seaAir, vsAir 1.6); 'heavyDestroyer' is the
  // surface gunfighter (sea targets only). Missile subs are nuclear —
  // they never burn or refuel fuel (user rule 2026-09-30).
  // ------------------------------------------------------------------
  coastalSub: {
    kind: 'coastalSub', name: 'Coastal Sub', domain: 'sea', hp: 220, speed: 11, armor: 'light',
    damage: 60, range: 24, minRange: 0, cooldownTicks: 70, targets: 'sea',
    vsLight: 0.9, vsMedium: 1.4, vsHeavy: 1.8, vsAir: 1.0, sight: 24, minAge: 'industry',
    requiredBuilding: 'navalYard',
    manpowerCost: 4, trainFunds: 700, trainMaterials: 180,
    fuelCapacity: 60, fuelPerSecond: 0.15, fuelType: 'fossil', // 400 s
    ammoCapacity: 6,
    military: true,
  },
  missileSub: {
    kind: 'missileSub', name: 'Missile Sub', domain: 'sea', hp: 550, speed: 9, armor: 'heavy',
    damage: 140, range: 40, minRange: 0, cooldownTicks: 120, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.4, vsHeavy: 2.0, vsAir: 1.0, sight: 30, minAge: 'information',
    requiredBuilding: 'navalYard',
    manpowerCost: 8, trainFunds: 2500, trainMaterials: 700,
    fuelCapacity: 0, fuelPerSecond: 0, fuelType: 'nuclear', // never burns or refuels
    ammoCapacity: 16,
    military: true,
  },
  corvette: {
    kind: 'corvette', name: 'Corvette', domain: 'sea', hp: 260, speed: 15, armor: 'light',
    damage: 22, range: 22, minRange: 0, cooldownTicks: 30, targets: 'sea',
    vsLight: 1.3, vsMedium: 0.9, vsHeavy: 0.6, vsAir: 1.0, sight: 28, minAge: 'connectivity',
    requiredBuilding: 'shipyard',
    manpowerCost: 3, trainFunds: 450, trainMaterials: 110,
    fuelCapacity: 80, fuelPerSecond: 0.25, fuelType: 'fossil', // 320 s
    military: true,
  },
  cruiser: {
    kind: 'cruiser', name: 'Cruiser', domain: 'sea', hp: 650, speed: 10, armor: 'heavy',
    damage: 60, range: 28, minRange: 0, cooldownTicks: 50, targets: 'seaAir',
    vsLight: 1.2, vsMedium: 1.2, vsHeavy: 1.1, vsAir: 1.6, sight: 34, minAge: 'information',
    requiredBuilding: 'navalYard',
    manpowerCost: 7, trainFunds: 2200, trainMaterials: 600,
    fuelCapacity: 120, fuelPerSecond: 0.25, fuelType: 'fossil', // 480 s
    military: true,
  },
  battleship: {
    kind: 'battleship', name: 'Battleship', domain: 'sea', hp: 800, speed: 9, armor: 'heavy',
    damage: 110, range: 32, minRange: 0, cooldownTicks: 90, targets: 'sea',
    vsLight: 1.2, vsMedium: 1.3, vsHeavy: 1.4, vsAir: 1.0, sight: 32, minAge: 'information',
    requiredBuilding: 'navalYard',
    manpowerCost: 9, trainFunds: 3000, trainMaterials: 900,
    fuelCapacity: 140, fuelPerSecond: 0.25, fuelType: 'fossil', // 560 s
    military: true,
  },
  heavyDestroyer: {
    kind: 'heavyDestroyer', name: 'Heavy Destroyer', domain: 'sea', hp: 550, speed: 12, armor: 'medium',
    damage: 65, range: 26, minRange: 0, cooldownTicks: 45, targets: 'sea',
    vsLight: 1.4, vsMedium: 1.3, vsHeavy: 1.2, vsAir: 1.0, sight: 30, minAge: 'industry',
    requiredBuilding: 'navalYard',
    manpowerCost: 6, trainFunds: 1800, trainMaterials: 500,
    fuelCapacity: 110, fuelPerSecond: 0.25, fuelType: 'fossil', // 440 s
    military: true,
  },
  cargoFreighter: {
    kind: 'cargoFreighter', name: 'Cargo Freighter', domain: 'sea', hp: 300, speed: 8, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'industry',
    manpowerCost: 2, trainFunds: 500, trainMaterials: 150,
    fuelCapacity: 120, fuelPerSecond: 0.2, fuelType: 'fossil', // 600 s
    harvest: { funds: 0.5 }, // civilian sea income
  },
  fuelTanker: {
    kind: 'fuelTanker', name: 'Fuel Tanker', domain: 'sea', hp: 320, speed: 8, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'industry',
    manpowerCost: 2, trainFunds: 600, trainMaterials: 200,
    fuelCapacity: 140, fuelPerSecond: 0.2, fuelType: 'fossil', // 700 s
    cargoFuelCapacity: 400, // naval supply ship (Phase 3 logistics on water)
    military: true,
  },
  ammoShip: {
    kind: 'ammoShip', name: 'Ammo Ship', domain: 'sea', hp: 280, speed: 8, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'industry',
    requiredBuilding: 'shipyard',
    manpowerCost: 2, trainFunds: 700, trainMaterials: 250,
    fuelCapacity: 120, fuelPerSecond: 0.2, fuelType: 'fossil', // 600 s
    cargoAmmoCapacity: 80, // floating munitions store
    military: true,
  },
  repairShip: {
    kind: 'repairShip', name: 'Repair Ship', domain: 'sea', hp: 300, speed: 9, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 22, minAge: 'connectivity',
    requiredBuilding: 'shipyard',
    manpowerCost: 3, trainFunds: 600, trainMaterials: 200,
    fuelCapacity: 100, fuelPerSecond: 0.2, fuelType: 'fossil', // 500 s
    healRadius: 15, healPerSec: 1.5, healDomain: 'sea', // heals ships, not soldiers
    military: true,
  },
  minelayer: {
    kind: 'minelayer', name: 'Minelayer', domain: 'sea', hp: 250, speed: 10, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 24, minAge: 'industry',
    requiredBuilding: 'shipyard',
    manpowerCost: 3, trainFunds: 800, trainMaterials: 250,
    fuelCapacity: 90, fuelPerSecond: 0.2, fuelType: 'fossil', // 450 s
    military: true,
  },
  navalMine: {
    kind: 'navalMine', name: 'Naval Mine', domain: 'sea', hp: 40, speed: 0, armor: 'light',
    // damage is the detonation yield spent by combat.ts's mine pass via
    // damageMultiplier (armor counters apply); the fire pass skips
    // deployableOnly kinds so mines never "shoot".
    damage: 150, range: 8, minRange: 0, cooldownTicks: 1, targets: 'sea',
    vsLight: 1.5, vsMedium: 1.2, vsHeavy: 0.9, vsAir: 1.0, sight: 8, minAge: 'industry',
    deployableOnly: true,
    manpowerCost: 0, trainFunds: 0, trainMaterials: 0,
    fuelCapacity: 0, fuelPerSecond: 0, fuelType: 'none',
    military: true,
  },
  coastGuardCutter: {
    kind: 'coastGuardCutter', name: 'Coast Guard Cutter', domain: 'sea', hp: 180, speed: 14, armor: 'light',
    damage: 12, range: 18, minRange: 0, cooldownTicks: 25, targets: 'sea',
    vsLight: 1.4, vsMedium: 0.7, vsHeavy: 0.3, vsAir: 0.8, sight: 30, minAge: 'industry',
    manpowerCost: 2, trainFunds: 300, trainMaterials: 80,
    fuelCapacity: 70, fuelPerSecond: 0.2, fuelType: 'fossil', // 350 s
    military: true,
  },
  cruiseLiner: {
    kind: 'cruiseLiner', name: 'Cruise Liner', domain: 'sea', hp: 350, speed: 10, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'connectivity',
    manpowerCost: 2, trainFunds: 800, trainMaterials: 250,
    fuelCapacity: 120, fuelPerSecond: 0.2, fuelType: 'fossil', // 600 s
    harvest: { funds: 0.6 }, // civilian sea income
  },
  yacht: {
    kind: 'yacht', name: 'Yacht', domain: 'sea', hp: 90, speed: 13, armor: 'light',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 18, minAge: 'connectivity',
    manpowerCost: 0, trainFunds: 200, trainMaterials: 60,
    fuelCapacity: 50, fuelPerSecond: 0.15, fuelType: 'fossil', // ~333 s
    harvest: { funds: 0.15 }, // civilian sea income
  },
  // ------------------------------------------------------------------
  // Grand-expansion intel roster (§3.8 / §4 S6, workstream 2,
  // 2026-09-30). Balance rationale in docs/research/intel-roster.md.
  // ------------------------------------------------------------------
  spy: {
    kind: 'spy', name: 'Spy', domain: 'land', hp: 60, speed: 10, armor: 'light',
    // Unarmed: a spy caught in open combat is fragile by design — its
    // power is infiltrate/sabotage/steal via the sim-core workstream's
    // commands, not firepower.
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 30, minAge: 'information',
    manpowerCost: 2, trainFunds: 400, trainMaterials: 40, requiredBuilding: 'intelHQ',
    stealth: true,
    military: true,
  },
  reconTeam: {
    kind: 'reconTeam', name: 'Recon Team', domain: 'land', hp: 100, speed: 14, armor: 'light',
    // Light self-defense only — this is the overt recon option: fast,
    // high sight, no stealth (enemy players always see it coming).
    damage: 8, range: 12, minRange: 0, cooldownTicks: 30, targets: 'ground',
    vsLight: 0.8, vsMedium: 0.4, vsHeavy: 0.2, vsAir: 1.0, sight: 44, minAge: 'connectivity',
    manpowerCost: 2, trainFunds: 150, trainMaterials: 15, requiredBuilding: 'barracks',
    recon: true, // dedicated recon asset — overflight can discover mixed airports
    military: true,
  },
  // ------------------------------------------------------------------
  // Grand-expansion Phase 8 — tech-level variants (workstream D,
  // 2026-09-30). Mk II / Mk III of the 14 workhorse kinds. Each tier is
  // a REAL upgrade, not a placebo: Mk II = hp ×1.3, damage ×1.25,
  // speed ×1.1, fuel ×1.2, cost ×1.6 (manpower +1); Mk III = hp ×1.6,
  // damage ×1.5, speed ×1.2, fuel ×1.4, cost ×2.5 (manpower +2), plus
  // role-specific bumps (artillery/aa/sub range, aa/fighter vsAir,
  // missile magazines, hauler cargo). Gating: minAge one age above the
  // base for Mk II, two ages above for Mk III; the base's
  // requiredBuilding is kept (train from the same production line).
  // Art: `variantOf` routes the render layer to the base kind's model
  // (zero new MODEL_PATHS keys, §AD12). Military variants carry
  // `military: true` (peaceful lockout); hauler/transportShip variants
  // are civilian — the peaceful-mode tech progression path.
  // ------------------------------------------------------------------
  tankMk2: {
    kind: 'tankMk2', name: 'Main Battle Tank Mk II', domain: 'land', hp: 650, speed: 11, armor: 'heavy',
    damage: 63, range: 19, minRange: 0, cooldownTicks: 50, targets: 'ground',
    vsLight: 1.3, vsMedium: 1.0, vsHeavy: 0.9, vsAir: 1.0, sight: 28, minAge: 'industry',
    manpowerCost: 6, trainFunds: 640, trainMaterials: 100, requiredBuilding: 'warFactory',
    fuelCapacity: 72, fuelPerSecond: 0.15, fuelType: 'fossil',
    military: true, variantOf: 'tank', variantTier: 2,
  },
  tankMk3: {
    kind: 'tankMk3', name: 'Main Battle Tank Mk III', domain: 'land', hp: 800, speed: 12, armor: 'heavy',
    damage: 75, range: 20, minRange: 0, cooldownTicks: 50, targets: 'ground',
    vsLight: 1.3, vsMedium: 1.0, vsHeavy: 0.9, vsAir: 1.0, sight: 30, minAge: 'information',
    manpowerCost: 7, trainFunds: 1000, trainMaterials: 150, requiredBuilding: 'warFactory',
    fuelCapacity: 84, fuelPerSecond: 0.15, fuelType: 'fossil',
    military: true, variantOf: 'tank', variantTier: 3,
  },
  artilleryMk2: {
    kind: 'artilleryMk2', name: 'Artillery Mk II', domain: 'land', hp: 210, speed: 7, armor: 'medium',
    damage: 120, range: 50, minRange: 12, cooldownTicks: 100, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.4, vsHeavy: 1.6, vsAir: 1.0, sight: 32, minAge: 'industry',
    manpowerCost: 5, trainFunds: 720, trainMaterials: 130, requiredBuilding: 'warFactory',
    fuelCapacity: 48, fuelPerSecond: 0.10, fuelType: 'fossil',
    military: true, variantOf: 'artillery', variantTier: 2,
  },
  artilleryMk3: {
    kind: 'artilleryMk3', name: 'Artillery Mk III', domain: 'land', hp: 260, speed: 7, armor: 'medium',
    damage: 145, range: 52, minRange: 12, cooldownTicks: 100, targets: 'ground',
    vsLight: 1.0, vsMedium: 1.4, vsHeavy: 1.6, vsAir: 1.0, sight: 34, minAge: 'information',
    manpowerCost: 6, trainFunds: 1150, trainMaterials: 200, requiredBuilding: 'warFactory',
    fuelCapacity: 56, fuelPerSecond: 0.10, fuelType: 'fossil',
    military: true, variantOf: 'artillery', variantTier: 3,
  },
  aaMk2: {
    kind: 'aaMk2', name: 'Mobile AA Mk II', domain: 'land', hp: 260, speed: 11, armor: 'medium',
    damage: 50, range: 30, minRange: 0, cooldownTicks: 25, targets: 'air',
    vsLight: 0.3, vsMedium: 0.3, vsHeavy: 0.3, vsAir: 2.4, sight: 36, minAge: 'industry',
    manpowerCost: 5, trainFunds: 560, trainMaterials: 100, requiredBuilding: 'warFactory',
    fuelCapacity: 60, fuelPerSecond: 0.15, fuelType: 'fossil',
    military: true, variantOf: 'aa', variantTier: 2,
  },
  aaMk3: {
    kind: 'aaMk3', name: 'Mobile AA Mk III', domain: 'land', hp: 320, speed: 12, armor: 'medium',
    damage: 60, range: 32, minRange: 0, cooldownTicks: 25, targets: 'air',
    vsLight: 0.3, vsMedium: 0.3, vsHeavy: 0.3, vsAir: 2.6, sight: 38, minAge: 'information',
    manpowerCost: 6, trainFunds: 900, trainMaterials: 150, requiredBuilding: 'warFactory',
    fuelCapacity: 70, fuelPerSecond: 0.15, fuelType: 'fossil',
    military: true, variantOf: 'aa', variantTier: 3,
  },
  apcMk2: {
    kind: 'apcMk2', name: 'Armored Personnel Carrier Mk II', domain: 'land', hp: 420, speed: 13, armor: 'medium',
    damage: 18, range: 16, minRange: 0, cooldownTicks: 25, targets: 'ground',
    vsLight: 1.3, vsMedium: 0.8, vsHeavy: 0.5, vsAir: 1.0, sight: 26, minAge: 'industry',
    manpowerCost: 5, trainFunds: 400, trainMaterials: 65, requiredBuilding: 'warFactory',
    fuelCapacity: 58, fuelPerSecond: 0.16, fuelType: 'fossil',
    military: true, variantOf: 'apc', variantTier: 2,
  },
  apcMk3: {
    kind: 'apcMk3', name: 'Armored Personnel Carrier Mk III', domain: 'land', hp: 510, speed: 14, armor: 'medium',
    damage: 21, range: 17, minRange: 0, cooldownTicks: 25, targets: 'ground',
    vsLight: 1.3, vsMedium: 0.8, vsHeavy: 0.5, vsAir: 1.0, sight: 28, minAge: 'information',
    manpowerCost: 6, trainFunds: 650, trainMaterials: 100, requiredBuilding: 'warFactory',
    fuelCapacity: 67, fuelPerSecond: 0.16, fuelType: 'fossil',
    military: true, variantOf: 'apc', variantTier: 3,
  },
  haulerMk2: {
    kind: 'haulerMk2', name: 'Hauler Mk II', domain: 'land', hp: 210, speed: 10, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 18, minAge: 'industry',
    manpowerCost: 0, trainFunds: 200, trainMaterials: 35,
    fuelCapacity: 72, fuelPerSecond: 0.12, fuelType: 'fossil',
    cargoFuelCapacity: 70, cargoAmmoCapacity: 35, // bigger field holds
    variantOf: 'hauler', variantTier: 2, // civilian: the peaceful tech path
  },
  haulerMk3: {
    kind: 'haulerMk3', name: 'Hauler Mk III', domain: 'land', hp: 260, speed: 11, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 20, minAge: 'information',
    manpowerCost: 0, trainFunds: 320, trainMaterials: 60,
    fuelCapacity: 84, fuelPerSecond: 0.12, fuelType: 'fossil',
    cargoFuelCapacity: 100, cargoAmmoCapacity: 50,
    variantOf: 'hauler', variantTier: 3, // civilian: the peaceful tech path
  },
  fighterMk2: {
    kind: 'fighterMk2', name: 'Fighter Mk II', domain: 'air', hp: 220, speed: 29, armor: 'light',
    damage: 40, range: 24, minRange: 0, cooldownTicks: 28, targets: 'both',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 1.8, sight: 42, minAge: 'industry',
    manpowerCost: 4, trainFunds: 1300, trainMaterials: 190, requiredBuilding: 'airfield',
    fuelCapacity: 54, fuelPerSecond: 0.5, fuelType: 'fossil',
    hangarClass: 'medium',
    military: true, variantOf: 'fighter', variantTier: 2,
  },
  fighterMk3: {
    kind: 'fighterMk3', name: 'Fighter Mk III', domain: 'air', hp: 270, speed: 31, armor: 'light',
    damage: 48, range: 26, minRange: 0, cooldownTicks: 28, targets: 'both',
    vsLight: 1.0, vsMedium: 0.7, vsHeavy: 0.5, vsAir: 2.0, sight: 44, minAge: 'information',
    manpowerCost: 5, trainFunds: 2000, trainMaterials: 300, requiredBuilding: 'airfield',
    fuelCapacity: 63, fuelPerSecond: 0.5, fuelType: 'fossil',
    hangarClass: 'medium',
    military: true, variantOf: 'fighter', variantTier: 3,
  },
  fighterBomberMk2: {
    kind: 'fighterBomberMk2', name: 'Fighter-Bomber Mk II', domain: 'air', hp: 260, speed: 31, armor: 'medium',
    damage: 150, range: 22, minRange: 0, cooldownTicks: 90, targets: 'ground',
    vsLight: 0.8, vsMedium: 1.0, vsHeavy: 1.8, vsAir: 1.0, sight: 34, minAge: 'information',
    manpowerCost: 5, trainFunds: 1600, trainMaterials: 240, requiredBuilding: 'airfield',
    fuelCapacity: 66, fuelPerSecond: 0.55, fuelType: 'fossil',
    hangarClass: 'medium',
    military: true, variantOf: 'fighterBomber', variantTier: 2,
  },
  fighterBomberMk3: {
    kind: 'fighterBomberMk3', name: 'Fighter-Bomber Mk III', domain: 'air', hp: 320, speed: 34, armor: 'medium',
    damage: 180, range: 24, minRange: 0, cooldownTicks: 90, targets: 'ground',
    vsLight: 0.8, vsMedium: 1.0, vsHeavy: 2.0, vsAir: 1.0, sight: 36, minAge: 'ascendance',
    manpowerCost: 6, trainFunds: 2500, trainMaterials: 375, requiredBuilding: 'airfield',
    fuelCapacity: 77, fuelPerSecond: 0.55, fuelType: 'fossil',
    hangarClass: 'medium',
    military: true, variantOf: 'fighterBomber', variantTier: 3,
  },
  attackHeliMk2: {
    kind: 'attackHeliMk2', name: 'Attack Helicopter Mk II', domain: 'air', hp: 195, speed: 33, armor: 'light',
    damage: 75, range: 22, minRange: 0, cooldownTicks: 55, targets: 'ground',
    vsLight: 0.9, vsMedium: 1.1, vsHeavy: 1.6, vsAir: 1.0, sight: 32, minAge: 'industry',
    manpowerCost: 5, trainFunds: 1150, trainMaterials: 160, requiredBuilding: 'airfield',
    fuelCapacity: 48, fuelPerSecond: 0.5, fuelType: 'fossil',
    hangarClass: 'light',
    military: true, variantOf: 'attackHeli', variantTier: 2,
  },
  attackHeliMk3: {
    kind: 'attackHeliMk3', name: 'Attack Helicopter Mk III', domain: 'air', hp: 240, speed: 36, armor: 'light',
    damage: 90, range: 24, minRange: 0, cooldownTicks: 55, targets: 'ground',
    vsLight: 0.9, vsMedium: 1.1, vsHeavy: 1.8, vsAir: 1.0, sight: 34, minAge: 'information',
    manpowerCost: 6, trainFunds: 1750, trainMaterials: 250, requiredBuilding: 'airfield',
    fuelCapacity: 56, fuelPerSecond: 0.5, fuelType: 'fossil',
    hangarClass: 'light',
    military: true, variantOf: 'attackHeli', variantTier: 3,
  },
  gunshipMk2: {
    kind: 'gunshipMk2', name: 'Gunship Mk II', domain: 'air', hp: 365, speed: 24, armor: 'medium',
    damage: 115, range: 22, minRange: 0, cooldownTicks: 55, targets: 'ground',
    vsLight: 1.5, vsMedium: 1.1, vsHeavy: 0.7, vsAir: 1.0, sight: 32, minAge: 'information',
    manpowerCost: 5, trainFunds: 2250, trainMaterials: 340, requiredBuilding: 'airfield',
    fuelCapacity: 78, fuelPerSecond: 0.5, fuelType: 'fossil',
    hangarClass: 'medium',
    military: true, variantOf: 'gunship', variantTier: 2,
  },
  gunshipMk3: {
    kind: 'gunshipMk3', name: 'Gunship Mk III', domain: 'air', hp: 450, speed: 26, armor: 'medium',
    damage: 135, range: 24, minRange: 0, cooldownTicks: 55, targets: 'ground',
    vsLight: 1.5, vsMedium: 1.1, vsHeavy: 0.7, vsAir: 1.0, sight: 34, minAge: 'ascendance',
    manpowerCost: 6, trainFunds: 3500, trainMaterials: 525, requiredBuilding: 'airfield',
    fuelCapacity: 91, fuelPerSecond: 0.5, fuelType: 'fossil',
    hangarClass: 'medium',
    military: true, variantOf: 'gunship', variantTier: 3,
  },
  destroyerMk2: {
    kind: 'destroyerMk2', name: 'Destroyer Mk II', domain: 'sea', hp: 780, speed: 12, armor: 'heavy',
    damage: 56, range: 28, minRange: 0, cooldownTicks: 40, targets: 'seaAir',
    vsLight: 1.3, vsMedium: 1.1, vsHeavy: 1.0, vsAir: 2.0, sight: 36, minAge: 'information',
    manpowerCost: 7, trainFunds: 2400, trainMaterials: 640, requiredBuilding: 'navalYard',
    fuelCapacity: 144, fuelPerSecond: 0.25, fuelType: 'fossil',
    military: true, variantOf: 'destroyer', variantTier: 2,
  },
  destroyerMk3: {
    kind: 'destroyerMk3', name: 'Destroyer Mk III', domain: 'sea', hp: 960, speed: 13, armor: 'heavy',
    damage: 68, range: 30, minRange: 0, cooldownTicks: 40, targets: 'seaAir',
    vsLight: 1.3, vsMedium: 1.1, vsHeavy: 1.0, vsAir: 2.2, sight: 38, minAge: 'ascendance',
    manpowerCost: 8, trainFunds: 3750, trainMaterials: 1000, requiredBuilding: 'navalYard',
    fuelCapacity: 168, fuelPerSecond: 0.25, fuelType: 'fossil',
    military: true, variantOf: 'destroyer', variantTier: 3,
  },
  frigateMk2: {
    kind: 'frigateMk2', name: 'Frigate Mk II', domain: 'sea', hp: 550, speed: 14, armor: 'medium',
    damage: 38, range: 26, minRange: 0, cooldownTicks: 35, targets: 'seaAir',
    vsLight: 1.2, vsMedium: 1.7, vsHeavy: 0.8, vsAir: 1.2, sight: 34, minAge: 'information',
    manpowerCost: 6, trainFunds: 1450, trainMaterials: 350, requiredBuilding: 'navalYard',
    fuelCapacity: 132, fuelPerSecond: 0.25, fuelType: 'fossil',
    military: true, variantOf: 'frigate', variantTier: 2,
  },
  frigateMk3: {
    kind: 'frigateMk3', name: 'Frigate Mk III', domain: 'sea', hp: 670, speed: 16, armor: 'medium',
    damage: 45, range: 28, minRange: 0, cooldownTicks: 35, targets: 'seaAir',
    vsLight: 1.2, vsMedium: 1.8, vsHeavy: 0.8, vsAir: 1.2, sight: 36, minAge: 'ascendance',
    manpowerCost: 7, trainFunds: 2250, trainMaterials: 550, requiredBuilding: 'navalYard',
    fuelCapacity: 154, fuelPerSecond: 0.25, fuelType: 'fossil',
    military: true, variantOf: 'frigate', variantTier: 3,
  },
  submarineMk2: {
    kind: 'submarineMk2', name: 'Submarine Mk II', domain: 'sea', hp: 390, speed: 11, armor: 'medium',
    damage: 115, range: 32, minRange: 0, cooldownTicks: 80, targets: 'sea',
    vsLight: 0.8, vsMedium: 1.5, vsHeavy: 2.1, vsAir: 1.0, sight: 28, minAge: 'information',
    manpowerCost: 7, trainFunds: 1900, trainMaterials: 480, requiredBuilding: 'navalYard',
    ammoCapacity: 16, ammoPerShot: 1, // deeper torpedo room
    fuelType: 'nuclear', // nuclear exemption inherited — user directive 2026-09-30
    military: true, variantOf: 'submarine', variantTier: 2,
  },
  submarineMk3: {
    kind: 'submarineMk3', name: 'Submarine Mk III', domain: 'sea', hp: 480, speed: 12, armor: 'medium',
    damage: 135, range: 34, minRange: 0, cooldownTicks: 80, targets: 'sea',
    vsLight: 0.8, vsMedium: 1.5, vsHeavy: 2.2, vsAir: 1.0, sight: 30, minAge: 'ascendance',
    manpowerCost: 8, trainFunds: 3000, trainMaterials: 750, requiredBuilding: 'navalYard',
    ammoCapacity: 20, ammoPerShot: 1,
    fuelType: 'nuclear',
    military: true, variantOf: 'submarine', variantTier: 3,
  },
  missileBoatMk2: {
    kind: 'missileBoatMk2', name: 'Missile Boat Mk II', domain: 'sea', hp: 235, speed: 20, armor: 'light',
    damage: 88, range: 24, minRange: 0, cooldownTicks: 70, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.1, vsHeavy: 1.5, vsAir: 1.0, sight: 30, minAge: 'industry',
    manpowerCost: 5, trainFunds: 800, trainMaterials: 190, requiredBuilding: 'shipyard',
    ammoCapacity: 12, ammoPerShot: 1, // three 4-packs
    fuelCapacity: 96, fuelPerSecond: 0.25, fuelType: 'fossil',
    military: true, variantOf: 'missileBoat', variantTier: 2,
  },
  missileBoatMk3: {
    kind: 'missileBoatMk3', name: 'Missile Boat Mk III', domain: 'sea', hp: 290, speed: 22, armor: 'light',
    damage: 105, range: 26, minRange: 0, cooldownTicks: 70, targets: 'sea',
    vsLight: 1.0, vsMedium: 1.1, vsHeavy: 1.5, vsAir: 1.0, sight: 32, minAge: 'information',
    manpowerCost: 6, trainFunds: 1250, trainMaterials: 300, requiredBuilding: 'shipyard',
    ammoCapacity: 16, ammoPerShot: 1,
    fuelCapacity: 112, fuelPerSecond: 0.25, fuelType: 'fossil',
    military: true, variantOf: 'missileBoat', variantTier: 3,
  },
  transportShipMk2: {
    kind: 'transportShipMk2', name: 'Transport Ship Mk II', domain: 'sea', hp: 455, speed: 10, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 24, minAge: 'information',
    manpowerCost: 2, trainFunds: 650, trainMaterials: 160,
    fuelCapacity: 144, fuelPerSecond: 0.25, fuelType: 'fossil',
    variantOf: 'transportShip', variantTier: 2, // civilian: the peaceful tech path
  },
  transportShipMk3: {
    kind: 'transportShipMk3', name: 'Transport Ship Mk III', domain: 'sea', hp: 560, speed: 11, armor: 'medium',
    damage: 0, range: 0, minRange: 0, cooldownTicks: 30, targets: 'none',
    vsLight: 1.0, vsMedium: 1.0, vsHeavy: 1.0, vsAir: 1.0, sight: 26, minAge: 'ascendance',
    manpowerCost: 3, trainFunds: 1000, trainMaterials: 250,
    fuelCapacity: 168, fuelPerSecond: 0.25, fuelType: 'fossil',
    variantOf: 'transportShip', variantTier: 3, // civilian: the peaceful tech path
  },
};

/**
 * Phase 4 transport (S7). A ferry's shipping lane: the two world-space
 * endpoints it shuttles between. Plain data — snapshot()/digest()
 * cover it verbatim (see `copyUnit`, `canonicalUnit`).
 */
export interface FerryRoute {
  /** Endpoint A: world (x, z). */
  ax: number;
  az: number;
  /** Endpoint B: world (x, z). */
  bx: number;
  bz: number;
  /** The endpoint the ferry is currently heading TO. */
  leg: 'a' | 'b';
}

/** A mobile unit. Plain data — snapshot()/digest() cover it verbatim. */
export interface UnitRecord {  /** Stable id from `world.nextId`. Never reused. */
  id: number;
  /** Kind tag, one of UNIT_KINDS. */
  kind: string;
  /** Owning player id (indexes `world.city.players`). */
  owner: number;
  /** Position on the ground plane. */
  x: number;
  z: number;
  /** Map layer: 'land' or 'air'. From the unit def, cached for hot loops. */
  domain: UnitDomain;
  /** Speed in world units/second. */
  speed: number;
  /** Current hit points. 0 or less = dead (removed by the combat system). */
  hp: number;
  /** Ticks until the weapon can fire again (0 = ready). */
  cooldownLeft: number;
  /** Id of the unit this one is ordered to attack (0 = none). */
  targetId: number;
  /**
   * True while pursuing an explicit `attackUnit` order: the unit chases
   * its target if it moves out of range. Auto-acquired targets (opportunistic
   * fire) never chase — the unit holds position and fires when in range.
   */
  chasing: boolean;
  /** Order lifecycle state. */
  state: UnitState;
  /** Why the last order failed; null unless state === 'failed'. */
  failReason: string | null;
  /** Current order destination (world coords). Meaningful when moving. */
  destX: number;
  destZ: number;
  /**
   * Where THIS unit actually stops: for single-unit A* orders it equals
   * the destination; for group (flow-field) orders it's a deterministic
   * formation slot near the destination (see `slotOffset` in
   * `movement.ts`) so group members don't stack on one point. Always on
   * land, in the destination's land component (for land units).
   */
  arriveX: number;
  arriveZ: number;
  /**
   * Remaining A* waypoints as cell indices (see `pathfinding.ts`). Empty
   * when the unit follows a flow field or has no order. `pathAt` is the
   * index of the next waypoint; earlier entries are already consumed.
   */
  path: number[];
  pathAt: number;
  /** Flow-field id the unit follows (0 = none). See `pathfinding.ts`. */
  fieldId: number;
  /**
   * Phase 4 transport (S7). The ferry's shipping lane: two world-space
   * endpoints it shuttles between, set by `setFerryRoute`. `leg` is the
   * endpoint it is currently heading TO ('a' = heading to a, 'b' =
   * heading to b). Undefined = no route (manual orders only). This IS
   * the ferry's "network" for `isOnTransportNetwork` and the earnings
   * gate; snapshotted and digested verbatim.
   */
  route?: FerryRoute;
  /**
   * Veterancy (grand-expansion Phase 1): cumulative combat experience,
   * earned by landing killing blows (`awardKillXp` in `veterancy.ts`).
   * `vetLevel` derives from XP thresholds (200/500/1000 → Regular /
   * Veteran / Elite) and gates damage, sight, reload, max-hp, and regen
   * bonuses. A completed Military Academy trains armed units to Regular
   * (200 XP) on spawn. Death erases everything — nothing here persists
   * from a dead unit.
   */
  xp: number;
  /** Veterancy level 0..3 (see `vetLevelForXp` in `veterancy.ts`). */
  vetLevel: number;
  /**
   * Phase 3 logistics. Current fuel in the tank (fossil-fuel units) and
   * current ammo in the magazine. Full on spawn (see spawnUnit); legacy
   * v6 saves decode to 0 via `?? 0` in snapshot.ts (AD9, no version bump).
   */
  fuel: number;
  ammo: number;
  /**
   * Phase 3: per-service toggles on supply units — which field services
   * this truck/ship offers (repair / rearm / refuel). Optional: absent
   * means all services on. Reads go through `supplyServicesOf` below.
   */
  supplyServices?: { repair: boolean; rearm: boolean; refuel: boolean };
  /**
   * Phase 3: id of the depot this unit is traveling to for a `resupply`
   * order (0 = none). Set by the resupply command, cleared when the
   * refill aura fulfills it or the reservation times out.
   */
  resupplyDepotId?: number;
  /**
   * Phase 3 logistics: the exact amounts (in depot-stock units) this unit
   * reserved at its `resupplyDepotId` when the `resupply` command applied
   * (see commands.ts). Released — subtracted back from the depot's
   * `reservedAmmo`/`reservedFuel` — on fulfillment, timeout, death, or
   * depot demolition. Stored per unit (not recomputed) so concurrent
   * reservations release exactly what they took (AD6 lesson). Optional;
   * reads use `?? 0` (AD9 — the `reservedAmmo` precedent, no version bump).
   */
  resupplyReservedAmmo?: number;
  resupplyReservedFuel?: number;
  /**
   * Phase 3 logistics: live cargo-hold levels (see
   * `cargoFuelCapacity`/`cargoAmmoCapacity` on the def). Spawn EMPTY —
   * cargo is loaded at depots, never conjured. Legacy v6 saves decode to
   * 0 via `?? 0` in snapshot.ts (AD9, no version bump); digested via
   * `canonicalNumber`.
   */
  cargoFuel: number;
  cargoAmmo: number;
  /**
   * Grand-expansion Phase 5/6, S4 (hangars + carriers): the building
   * id whose hangar slot this aircraft is parked in (0 = not parked).
   * Set by the hangar system (embarkAircraft / ground parking) once
   * the aircraft workstream lands. Optional; reads use `?? 0`
   * (AD9). Snapshotted and digest-covered (PLAN §4 S4).
   */
  hangarBuildingId?: number;
  /**
   * Grand-expansion Phase 6 (carrier wings): the carrier unit id this
   * aircraft is embarked on (0 = flying / parked on land, not
   * embarked). Embarked aircraft move with the carrier (movement.ts
   * syncs position in id order), are skipped by target acquisition,
   * and die with the carrier (killUnit releases the slot / destroys
   * the wing — PLAN §4 S4). Optional; reads use `?? 0` (AD9).
   * Snapshotted and digest-covered (PLAN §4 S4).
   */
  embarkedOn?: number;
  /**
   * Grand-expansion Phase 6 (S6 intel): spy mission state. All optional;
   * reads use `?? 0` (AD9 — the fuel/ammo precedent, no version bump,
   * stays v8). Snapshotted and digest-covered (PLAN §4 S6).
   *  - `missionEndsAt`: tick when the current infiltration completes
   *    (0 = no infiltration in progress).
   *  - `missionTargetId`: building id being infiltrated (0 = none).
   *  - `infiltrationProgress`: elapsed infiltration ticks (UI progress).
   *  - `embeddedIn`: building id the spy is embedded in (0 = not
   *    embedded; required for `stealTech` against that building).
   *  - `spottedUntil`: tick until which the spy is burned — visible to
   *    everyone (set by sabotage spot checks and failed tech-steals).
   */
  missionEndsAt?: number;
  missionTargetId?: number;
  infiltrationProgress?: number;
  embeddedIn?: number;
  spottedUntil?: number;
}

/** Spawn a unit into the world. Returns the new record. Caller validates. */
export function spawnUnit(world: World, kind: string, owner: number, x: number, z: number): UnitRecord {
  const def = UNIT_DEFS[kind as UnitKind] ?? UNIT_DEFS.engineer;
  const record: UnitRecord = {
    id: world.nextId,
    kind,
    owner,
    x,
    z,
    domain: def.domain,
    // Spawn stats run through the upgrade hooks (Composite Armor hp,
    // Engine Tuning speed, Field Medicine hp) — existing units are never
    // retroactively changed, so spawn time is the only application point.
    speed: effectiveSpeed(world, owner, def),
    hp: effectiveMaxHp(world, owner, def),
    cooldownLeft: 0,
    targetId: 0,
    chasing: false,
    state: 'idle',
    failReason: null,
    destX: x,
    destZ: z,
    arriveX: x,
    arriveZ: z,
    path: [],
    pathAt: 0,
    fieldId: 0,
    xp: 0,
    vetLevel: 0,
    // Phase 3 logistics: full tanks and full magazines on spawn (S2 hook).
    // Nuclear-fuel units (fuelType 'nuclear') never burn fuel, but still
    // track ammo; 'none'/untracked kinds sit at 0/0.
    fuel: def.fuelCapacity ?? 0,
    ammo: def.ammoCapacity ?? 0,
    // Phase 3 logistics: cargo holds spawn EMPTY. Fuel/ammo are the
    // unit's own consumables (full on spawn); cargo is what it carries
    // for others and must be loaded at a depot — never conjured.
    cargoFuel: 0,
    cargoAmmo: 0,
    // Phase 3 resupply linkage: no reservation on spawn (the ledger
    // starts at zero, like the cargo holds above).
    resupplyDepotId: 0,
    resupplyReservedAmmo: 0,
    resupplyReservedFuel: 0,
    // Grand-expansion Phase 5/6 (S4): aircraft spawn unparked and
    // unembarked — parking/embarking are commands, never conjured.
    hangarBuildingId: 0,
    embarkedOn: 0,
    // Grand-expansion Phase 6 (S6 intel): spies spawn with no mission,
    // unembedded, unspotted — missions start via `infiltrateBuilding`.
    missionEndsAt: 0,
    missionTargetId: 0,
    infiltrationProgress: 0,
    embeddedIn: 0,
    spottedUntil: 0,
  };
  world.nextId += 1;
  world.units.push(record);
  // R1 final-review H1: keep the id→unit index fresh (see findUnit).
  // Identity-checked: untracked worlds (direct test pushes, snapshot
  // restore) simply rebuild lazily on the next lookup.
  const e = unitIndexByWorld.get(world);
  if (e !== undefined && e.arr === world.units) {
    e.map.set(record.id, record);
    e.n = world.units.length;
    e.last = record;
  }
  // Veterancy (Phase 1): an armed unit trained while its owner has a
  // completed Military Academy graduates as Regular — spawn XP 200, the
  // first threshold in veterancy.ts (hardcoded to keep this module from
  // importing veterancy.ts; the constant lives there). Unarmed units
  // (haulers, medics, transports) get no bonus — there is nothing to
  // drill them in. Deployable-only kinds (navalMine, Phase 6
  // workstream C) get no bonus either — mines earn no XP, they detonate.
  // `hasProductionBuilding` covers real and AI-virtual academies, like
  // every other production gate in this file.
  if (def.damage > 0 && def.deployableOnly !== true && hasProductionBuilding(world, owner, 'militaryAcademy')) {
    record.xp = 200;
    record.vetLevel = 1;
  }
  return record;
}

/**
 * id → unit index (R1 final-review H1, 2026-10-01). `findUnit` sits on
 * the hottest paths (combat target validation every tick per armed
 * unit, command validators), and the old linear scan made each call
 * O(n). The index is a per-world cache: maintained incrementally at
 * the sim's mutation points (`spawnUnit` adds; `removeUnitFromIndex` —
 * called by `killUnit` in combat.ts — deletes) and validated on every
 * read, so hand-built fixtures that push to `world.units` directly
 * (tests) or wholesale array replacement (`restoreSnapshot`) stay
 * correct via a lazy rebuild. The Map is never iterated for sim
 * logic — pure O(1) lookup, so it has no determinism footprint
 * (insertion order is never observed).
 */
interface UnitIndexEntry {
  /** The array this entry was built from (identity check). */
  arr: UnitRecord[];
  /** Length at build/maintenance time. */
  n: number;
  /** Last element at build/maintenance time (catches same-length swaps). */
  last: UnitRecord | undefined;
  map: Map<number, UnitRecord>;
}
const unitIndexByWorld = new WeakMap<World, UnitIndexEntry>();

function rebuildUnitIndex(world: World): UnitIndexEntry {
  const units = world.units;
  const map = new Map<number, UnitRecord>();
  for (const u of units) map.set(u.id, u);
  const entry: UnitIndexEntry = {
    arr: units,
    n: units.length,
    last: units[units.length - 1],
    map,
  };
  unitIndexByWorld.set(world, entry);
  return entry;
}

/** True when the cached index matches the world's current unit array. */
function unitIndexFresh(world: World, e: UnitIndexEntry): boolean {
  const units = world.units;
  return e.arr === units && e.n === units.length && e.last === units[units.length - 1];
}

/**
 * Find a unit by id. O(1) via the per-world index (see above); the
 * first call after an untracked mutation (a test fixture pushing
 * directly, a snapshot restore replacing the array) rebuilds lazily.
 */
export function findUnit(world: World, id: number): UnitRecord | undefined {
  let e = unitIndexByWorld.get(world);
  if (e === undefined || !unitIndexFresh(world, e)) e = rebuildUnitIndex(world);
  return e.map.get(id);
}

/**
 * Drop a unit id from the index. Called by `killUnit` (combat.ts)
 * after the order-preserving splice. Safe to call with a stale or
 * missing entry — the next `findUnit` rebuilds from the array.
 */
export function removeUnitFromIndex(world: World, id: number): void {
  const e = unitIndexByWorld.get(world);
  if (e === undefined || e.arr !== world.units) return;
  e.map.delete(id);
  e.n = world.units.length;
  e.last = world.units[world.units.length - 1];
}

/**
 * Phase 3 logistics: effective per-service toggles for a supply unit
 * (repair / rearm / refuel). Absent `supplyServices` means all on.
 */
export function supplyServicesOf(u: UnitRecord): { repair: boolean; rearm: boolean; refuel: boolean } {
  return u.supplyServices ?? { repair: true, rearm: true, refuel: true };
}

/**
 * Phase 3 logistics: supply level 0..1 — the minimum fraction across the
 * unit's tracked resources (fuel for fossil-fuel units, ammo for
 * magazine units). 1 = fully supplied. Nuclear-fuel units and untracked
 * kinds are always 1 (exempt from the supply system).
 */
export function supplyLevel(def: UnitDef, u: UnitRecord): number {
  let level = 1;
  if (def.fuelType === 'fossil' && (def.fuelCapacity ?? 0) > 0) {
    level = Math.min(level, u.fuel / (def.fuelCapacity as number));
  }
  if ((def.ammoCapacity ?? 0) > 0) {
    level = Math.min(level, u.ammo / (def.ammoCapacity as number));
  }
  return level;
}

/**
 * Phase 3 logistics: the ONE supply degradation curve (AD3, PLAN §13 —
 * no compounding multiplicative supply penalties). Out-of-supply
 * degrades, never hard-stops: damage ×(0.6+0.4×level), so a fully dry
 * unit still deals 60% (the ammo gate / fuel failure handle the true
 * hard cases). Applied as a single factor alongside veterancy —
 * never stacked with other supply penalties. Exempt kinds sit at level
 * 1, so the factor is exactly 1.0 for them.
 */
export function supplyDamageFactor(def: UnitDef, u: UnitRecord): number {
  return 0.6 + 0.4 * supplyLevel(def, u);
}

/**
 * Phase 3 logistics: the speed half of the single supply curve —
 * speed ×(0.7+0.3×level). A dry unit crawls at 70%, it doesn't stop
 * (stopping is the fuel system's loud 'out of fuel' failure, which is
 * an order failure, not a stat penalty — §13 non-goal).
 */
export function supplySpeedFactor(def: UnitDef, u: UnitRecord): number {
  return 0.7 + 0.3 * supplyLevel(def, u);
}

/**
 * Clear a unit's in-flight order state (path + field reference). Queued
 * path requests are the coordinator's job — see `pathfinding.ts`.
 */
export function clearUnitOrder(unit: UnitRecord): void {
  unit.path = [];
  unit.pathAt = 0;
  unit.fieldId = 0;
}

/** Mark an order failed with a loud reason. The unit stops where it is. */
export function failUnitOrder(unit: UnitRecord, reason: string): void {
  clearUnitOrder(unit);
  unit.state = 'failed';
  unit.failReason = reason;
}

/**
 * Register the `spawnUnit` command. Takes the terrain because spawn
 * validates against water for land units (air units may spawn over water).
 * Terrain is injected, not stored in the world — the same pattern as
 * `registerCityCommands`.
 */
export function registerUnitCommands(queue: CommandQueue, t: TerrainData): void {
  queue.register('spawnUnit', {
    validate(cmd, world): string | null {
      const kind = cmd.payload['kind'];
      if (typeof kind !== 'string' || !(UNIT_KINDS as readonly string[]).includes(kind)) {
        return `spawnUnit: kind must be one of ${UNIT_KINDS.join(', ')}`;
      }
      // Grand-expansion Phase 6 (workstream C): deployable-only kinds
      // (navalMine) enter the world through their own command — the
      // train path is closed loudly so no UI or AI path can conjure one.
      if (UNIT_DEFS[kind as UnitKind].deployableOnly === true) {
        return `spawnUnit: ${kind} is deployable-only (lay it with a minelayer's deployMine command)`;
      }
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner) || !getPlayer(world.city, owner)) {
        return 'spawnUnit: unknown owner';
      }
      const x = cmd.payload['x'];
      const z = cmd.payload['z'];
      if (typeof x !== 'number' || !Number.isFinite(x)) return 'spawnUnit: payload.x must be a finite number';
      if (typeof z !== 'number' || !Number.isFinite(z)) return 'spawnUnit: payload.z must be a finite number';
      if (Math.abs(x) > MAP_HALF_SIZE || Math.abs(z) > MAP_HALF_SIZE) {
        return `spawnUnit: position (${x}, ${z}) is outside the map`;
      }
      // Terrain is static, so a validate-time water check is stable: it
      // cannot go stale between enqueue and apply. Air units fly; land units
      // are blocked by water; sea units require water.
      const def = UNIT_DEFS[kind as UnitKind];
      if (def.domain === 'land' && isWater(t, x, z)) {
        return `spawnUnit: cannot spawn a land unit in water at (${x}, ${z})`;
      }
      if (def.domain === 'sea' && !isWater(t, x, z)) {
        return `spawnUnit: cannot spawn a sea unit on land at (${x}, ${z})`;
      }
      // Grand-expansion Phase 8 (peaceful mode, 2026-09-30): military
      // defs cannot be trained in a peaceful world — the rejection is
      // loud (CommandRejectedError → HUD toast), never silent. Rivals
      // keep playing: their military orders are rejected the same way
      // (the AI swallows rejections), so no attacker can ever exist.
      // The flag is immutable (set at tick 0, never toggled), so no
      // apply-time re-check is needed — enqueue-time is definitive.
      if (world.peaceful === true && def.military === true) {
        return `spawnUnit: ${def.name} is a military unit and cannot be trained in peaceful mode`;
      }
      // Age gating: units require their minimum age (or later).
      if (!isUnitAvailableForAge(world, def.minAge)) {
        return `spawnUnit: ${kind} requires the ${def.minAge} age`;
      }
      // Manpower: military units cost manpower from the player's stockpile.
      if (def.manpowerCost > 0) {
        const player = getPlayer(world.city, owner as number);
        if (!player || player.manpower < def.manpowerCost) {
          return `spawnUnit: not enough manpower (need ${def.manpowerCost})`;
        }
      }
      // Training costs (spec: the training-cost gap fix): funds + materials,
      // validated at enqueue AND at apply.
      if (def.trainFunds > 0 || def.trainMaterials > 0) {
        const player = getPlayer(world.city, owner as number);
        if (
          !player ||
          player.funds < def.trainFunds ||
          player.materials < def.trainMaterials
        ) {
          return (
            `spawnUnit: cannot afford training cost for ${kind} ` +
            `(need ${def.trainFunds} funds + ${def.trainMaterials} materials)`
          );
        }
      }
      // Production gating: advanced units need a completed production
      // building (progress >= 1) owned by the training player — real or
      // AI-virtually-constructed (hasProductionBuilding covers both).
      if (def.requiredBuilding) {
        if (!hasProductionBuilding(world, owner as number, def.requiredBuilding)) {
          const name = BUILDING_DEFS[def.requiredBuilding]?.name ?? def.requiredBuilding;
          return `spawnUnit: ${kind} requires a completed ${name}`;
        }
      }
      return null;
    },
    apply(cmd, world): unknown {
      const def = UNIT_DEFS[cmd.payload['kind'] as UnitKind];
      // Deduct manpower + training costs (validated above; re-check
      // defensively for determinism — apply runs after enqueue).
      const player = getPlayer(world.city, cmd.payload['owner'] as number);
      if (def.manpowerCost > 0 && player) {
        if (player.manpower < def.manpowerCost) {
          throw new Error(`spawnUnit: not enough manpower at apply time`);
        }
        player.manpower -= def.manpowerCost;
      }
      if ((def.trainFunds > 0 || def.trainMaterials > 0) && player) {
        if (player.funds < def.trainFunds || player.materials < def.trainMaterials) {
          throw new Error(`spawnUnit: cannot afford training cost at apply time`);
        }
        player.funds -= def.trainFunds;
        player.materials -= def.trainMaterials;
      }
      const unit = spawnUnit(
        world,
        cmd.payload['kind'] as string,
        cmd.payload['owner'] as number,
        cmd.payload['x'] as number,
        cmd.payload['z'] as number,
      );
      return unit.id;
    },
  });

  // ------------------------------------------------------------------
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30). The minelayer's deployMine command: the ONLY way a
  // navalMine enters the world (spawnUnit rejects deployableOnly
  // kinds loudly — see the validator above). The lay-down cost (50
  // funds + 10 materials per mine) is validated at enqueue AND at
  // apply, and deducted at apply. The mine spawns at the minelayer's
  // own position; the combat system's mine pass (combat.ts) arms it
  // deterministically from there.
  // ------------------------------------------------------------------
  const MINE_DEPLOY_FUNDS = 50;
  const MINE_DEPLOY_MATERIALS = 10;
  queue.register('deployMine', {
    validate(cmd, world): string | null {
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner) || !getPlayer(world.city, owner)) {
        return 'deployMine: unknown owner';
      }
      const minelayerId = cmd.payload['minelayerId'];
      if (typeof minelayerId !== 'number' || !Number.isInteger(minelayerId)) {
        return 'deployMine: payload.minelayerId must be an integer unit id';
      }
      const minelayer = findUnit(world, minelayerId);
      if (minelayer === undefined || minelayer.hp <= 0 || minelayer.owner !== owner) {
        return 'deployMine: minelayer must be a living unit owned by the issuer';
      }
      // Grand-expansion Phase 8 (peaceful mode): minelaying is a weapon
      // of war — locked out alongside every other military def. (A
      // minelayer cannot be trained in peaceful mode anyway; this is
      // defense in depth for hand-built worlds.)
      if (world.peaceful === true) {
        return 'deployMine: mine warfare is not available in peaceful mode';
      }
      if (minelayer.kind !== 'minelayer') {
        return 'deployMine: only a minelayer can deploy naval mines';
      }
      // Mines need water under the hull — terrain is static, so this
      // check is stable between enqueue and apply.
      if (!isWater(t, minelayer.x, minelayer.z)) {
        return 'deployMine: the minelayer must be on water';
      }
      const player = getPlayer(world.city, owner as number);
      if (
        !player ||
        player.funds < MINE_DEPLOY_FUNDS ||
        player.materials < MINE_DEPLOY_MATERIALS
      ) {
        return (
          `deployMine: cannot afford the lay-down cost ` +
          `(${MINE_DEPLOY_FUNDS} funds + ${MINE_DEPLOY_MATERIALS} materials)`
        );
      }
      return null;
    },
    apply(cmd, world): unknown {
      const owner = cmd.payload['owner'] as number;
      const player = getPlayer(world.city, owner);
      if (
        !player ||
        player.funds < MINE_DEPLOY_FUNDS ||
        player.materials < MINE_DEPLOY_MATERIALS
      ) {
        throw new Error('deployMine: cannot afford the lay-down cost at apply time');
      }
      player.funds -= MINE_DEPLOY_FUNDS;
      player.materials -= MINE_DEPLOY_MATERIALS;
      const minelayer = findUnit(world, cmd.payload['minelayerId'] as number);
      if (minelayer === undefined || minelayer.hp <= 0 || minelayer.owner !== owner) {
        throw new Error('deployMine: minelayer is gone at apply time');
      }
      const mine = spawnUnit(world, 'navalMine', owner, minelayer.x, minelayer.z);
      return mine.id;
    },
  });

  /**
   * Phase 4 transport (S7): assign a ferry its shipping lane. Both
   * endpoints must be water (inside the map); the route starts idle
   * with leg 'a' — the ferry loop (movement.ts) flips to 'b' and
   * dispatches on the next tick, so the ferry always sails to B first
   * after a fresh route. Re-issuing replaces the old route; a manual
   * moveUnit is a detour (the loop resumes when the ferry idles).
   */
  queue.register('setFerryRoute', {
    validate(cmd, world): string | null {
      const unitId = cmd.payload['unitId'];
      if (typeof unitId !== 'number' || !Number.isInteger(unitId)) {
        return 'setFerryRoute: payload.unitId must be an integer';
      }
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return `setFerryRoute: no unit with id ${unitId}`;
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || unit.owner !== owner) {
        return `setFerryRoute: unit ${unitId} is not owned by player ${owner}`;
      }
      if (unit.kind !== 'ferry') return `setFerryRoute: unit ${unitId} is a ${unit.kind}, not a ferry`;
      const ax = cmd.payload['ax'];
      const az = cmd.payload['az'];
      const bx = cmd.payload['bx'];
      const bz = cmd.payload['bz'];
      for (const [k, v] of [['ax', ax], ['az', az], ['bx', bx], ['bz', bz]] as const) {
        if (typeof v !== 'number' || !Number.isFinite(v)) return `setFerryRoute: payload.${k} must be a finite number`;
        if (Math.abs(v) > MAP_HALF_SIZE) return `setFerryRoute: endpoint ${k}=${v} is outside the map`;
      }
      if (!isWater(t, ax as number, az as number)) return 'setFerryRoute: endpoint A must be water';
      if (!isWater(t, bx as number, bz as number)) return 'setFerryRoute: endpoint B must be water';
      if (ax === bx && az === bz) return 'setFerryRoute: endpoints A and B must differ';
      return null;
    },
    apply(cmd, world): unknown {
      const unit = world.units.find((u) => u.id === (cmd.payload['unitId'] as number)) as UnitRecord;
      unit.route = {
        ax: cmd.payload['ax'] as number,
        az: cmd.payload['az'] as number,
        bx: cmd.payload['bx'] as number,
        bz: cmd.payload['bz'] as number,
        leg: 'a',
      };
      // Become idle so the ferry loop picks the route up next tick
      // (unless it is mid-order — then it finishes the manual detour
      // first and the loop resumes after).
      if (unit.state === 'failed') {
        unit.state = 'idle';
        unit.failReason = null;
      }
      return unit.id;
    },
  });

  // ------------------------------------------------------------------
  // Grand-expansion Phase 5 — hangars + carriers (workstream B, S4,
  // 2026-09-30). embarkAircraft (carrier wing), baseAircraft (ground
  // hangar), launchAircraft (leave either). Reservation is atomic at
  // apply time — validate≡apply agreement under contention (the
  // Phase 5 deployable test pins it). Carriers train EMPTY (their wing
  // fills only through these commands — the user requirement); only
  // carrierCapable aircraft may embark (sim gate here, UI gate in
  // ui/hangars.ts).
  // ------------------------------------------------------------------
  queue.register('embarkAircraft', {
    validate(cmd, world): string | null {
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner) || !getPlayer(world.city, owner)) {
        return 'embarkAircraft: unknown owner';
      }
      const unitId = cmd.payload['unitId'];
      if (typeof unitId !== 'number' || !Number.isInteger(unitId)) {
        return 'embarkAircraft: payload.unitId must be an integer';
      }
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return `embarkAircraft: no unit with id ${unitId}`;
      if (unit.owner !== owner) return `embarkAircraft: unit ${unitId} is not owned by player ${owner}`;
      if (unit.hp <= 0) return `embarkAircraft: unit ${unitId} is dead`;
      const def = UNIT_DEFS[unit.kind as UnitKind];
      if (!def || def.domain !== 'air') return `embarkAircraft: unit ${unitId} is not an aircraft`;
      if (def.carrierCapable !== true) {
        return `embarkAircraft: ${unit.kind} is not carrier-capable (only carrier-capable aircraft may embark)`;
      }
      if (isSheltered(unit)) return `embarkAircraft: unit ${unitId} is already parked or embarked`;
      const carrierId = cmd.payload['carrierId'];
      if (typeof carrierId !== 'number' || !Number.isInteger(carrierId)) {
        return 'embarkAircraft: payload.carrierId must be an integer';
      }
      const carrier = world.units.find((u) => u.id === carrierId);
      if (!carrier) return `embarkAircraft: no carrier with id ${carrierId}`;
      if (carrier.owner !== owner) return `embarkAircraft: carrier ${carrierId} is not owned by player ${owner}`;
      if (carrier.hp <= 0) return `embarkAircraft: carrier ${carrierId} is dead`;
      if ((UNIT_DEFS[carrier.kind as UnitKind]?.wingCapacity ?? 0) <= 0) {
        return `embarkAircraft: ${carrier.kind} has no wing capacity`;
      }
      if (findHangarSlot(world, { kind: 'carrier', id: carrierId }, def.hangarClass) < 0) {
        return `embarkAircraft: carrier ${carrierId}'s wing is full`;
      }
      const dx = unit.x - carrier.x;
      const dz = unit.z - carrier.z;
      if (dx * dx + dz * dz > EMBARK_RANGE * EMBARK_RANGE) {
        return `embarkAircraft: unit ${unitId} is out of embark range (${EMBARK_RANGE})`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const unit = world.units.find((u) => u.id === (cmd.payload['unitId'] as number)) as UnitRecord;
      const carrier = world.units.find((u) => u.id === (cmd.payload['carrierId'] as number)) as UnitRecord;
      const def = UNIT_DEFS[unit.kind as UnitKind];
      // validate≡apply: the slot is reserved atomically here — a stale
      // validate (two aircraft racing one slot) throws loudly instead
      // of double-booking.
      if (findHangarSlot(world, { kind: 'carrier', id: carrier.id }, def.hangarClass) < 0) {
        throw new Error(`embarkAircraft: carrier ${carrier.id}'s wing filled before apply`);
      }
      unit.embarkedOn = carrier.id;
      // Embarked aircraft ride the carrier: drop orders, snap to the
      // deck (the movement sync keeps them there in id order).
      unit.x = carrier.x;
      unit.z = carrier.z;
      unit.destX = carrier.x;
      unit.destZ = carrier.z;
      unit.arriveX = carrier.x;
      unit.arriveZ = carrier.z;
      unit.path = [];
      unit.fieldId = 0;
      unit.targetId = 0;
      unit.chasing = false;
      unit.state = 'idle';
      unit.failReason = null;
      return unit.id;
    },
  });

  queue.register('baseAircraft', {
    validate(cmd, world): string | null {
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner) || !getPlayer(world.city, owner)) {
        return 'baseAircraft: unknown owner';
      }
      const unitId = cmd.payload['unitId'];
      if (typeof unitId !== 'number' || !Number.isInteger(unitId)) {
        return 'baseAircraft: payload.unitId must be an integer';
      }
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return `baseAircraft: no unit with id ${unitId}`;
      if (unit.owner !== owner) return `baseAircraft: unit ${unitId} is not owned by player ${owner}`;
      if (unit.hp <= 0) return `baseAircraft: unit ${unitId} is dead`;
      const def = UNIT_DEFS[unit.kind as UnitKind];
      if (!def || def.domain !== 'air') return `baseAircraft: unit ${unitId} is not an aircraft`;
      if (isSheltered(unit)) return `baseAircraft: unit ${unitId} is already parked or embarked`;
      const buildingId = cmd.payload['buildingId'];
      if (typeof buildingId !== 'number' || !Number.isInteger(buildingId)) {
        return 'baseAircraft: payload.buildingId must be an integer';
      }
      const b = world.city.buildings.find((x) => x.id === buildingId);
      if (!b) return `baseAircraft: no building with id ${buildingId}`;
      if (b.owner !== owner) return `baseAircraft: building ${buildingId} is not owned by player ${owner}`;
      if (b.progress < 1) return `baseAircraft: building ${buildingId} is not completed`;
      if (findHangarSlot(world, { kind: 'building', id: buildingId }, def.hangarClass) < 0) {
        return `baseAircraft: building ${buildingId} has no free compatible hangar slot`;
      }
      const bx = cellCenterWorld(b.cx);
      const bz = cellCenterWorld(b.cz);
      const dx = unit.x - bx;
      const dz = unit.z - bz;
      if (dx * dx + dz * dz > HANGAR_BASE_RANGE * HANGAR_BASE_RANGE) {
        return `baseAircraft: unit ${unitId} is out of basing range (${HANGAR_BASE_RANGE})`;
      }
      return null;
    },
    apply(cmd, world): unknown {
      const unit = world.units.find((u) => u.id === (cmd.payload['unitId'] as number)) as UnitRecord;
      const b = world.city.buildings.find((x) => x.id === (cmd.payload['buildingId'] as number));
      if (!b) throw new Error(`baseAircraft: building ${cmd.payload['buildingId']} gone before apply`);
      const def = UNIT_DEFS[unit.kind as UnitKind];
      // validate≡apply: reserve the slot atomically — a stale validate
      // (two aircraft racing one slot) throws loudly.
      const slots = b.hangars ?? defaultHangarSlots(b.kind);
      const idx = findBuildingHangarSlot(slots, def.hangarClass);
      if (idx < 0 || !slots) {
        throw new Error(`baseAircraft: building ${b.id}'s hangar filled before apply`);
      }
      if (b.hangars === undefined) b.hangars = slots;
      b.hangars[idx] = { cls: (slots[idx] as { cls: HangarClass | 'generic' }).cls, occupant: unit.id };
      unit.hangarBuildingId = b.id;
      unit.targetId = 0;
      unit.chasing = false;
      unit.state = 'idle';
      unit.failReason = null;
      return unit.id;
    },
  });

  queue.register('launchAircraft', {
    validate(cmd, world): string | null {
      const owner = cmd.payload['owner'];
      if (typeof owner !== 'number' || !Number.isInteger(owner) || !getPlayer(world.city, owner)) {
        return 'launchAircraft: unknown owner';
      }
      const unitId = cmd.payload['unitId'];
      if (typeof unitId !== 'number' || !Number.isInteger(unitId)) {
        return 'launchAircraft: payload.unitId must be an integer';
      }
      const unit = world.units.find((u) => u.id === unitId);
      if (!unit) return `launchAircraft: no unit with id ${unitId}`;
      if (unit.owner !== owner) return `launchAircraft: unit ${unitId} is not owned by player ${owner}`;
      if (unit.hp <= 0) return `launchAircraft: unit ${unitId} is dead`;
      if (!isSheltered(unit)) return `launchAircraft: unit ${unitId} is not parked or embarked`;
      return null;
    },
    apply(cmd, world): unknown {
      const unit = world.units.find((u) => u.id === (cmd.payload['unitId'] as number)) as UnitRecord;
      const hid = unit.hangarBuildingId ?? 0;
      if (hid > 0) {
        // Free the ground slot (the building may be gone — demolish
        // already cleared the link; then there is nothing to free).
        const b = world.city.buildings.find((x) => x.id === hid);
        if (b?.hangars) {
          for (const s of b.hangars) {
            if (s.occupant === unit.id) s.occupant = 0;
          }
        }
        unit.hangarBuildingId = 0;
      }
      if ((unit.embarkedOn ?? 0) > 0) unit.embarkedOn = 0;
      return unit.id;
    },
  });
}

/**
 * Phase 4 transport (S7): is this unit kind rail-bound (steers along
 * rail cells via rail.ts instead of flow fields / open steering)?
 */
export function isRailBound(kind: string): boolean {
  return (UNIT_DEFS[kind as UnitKind]?.railBound ?? false) === true;
}

// ------------------------------------------------------------------
// Grand-expansion Phase 5 — hangars + carriers (workstream B, S4,
// 2026-09-30). Sheltered aircraft (parked in a ground hangar or
// embarked on a carrier) are invisible to combat and movement: they
// ride with their shelter, die with a destroyed carrier, and are
// released (alive) when a ground hangar is demolished.
// ------------------------------------------------------------------

/** Max order distance (world units) for `embarkAircraft` onto a carrier. */
export const EMBARK_RANGE = 48;
/** Max order distance (world units) for `baseAircraft` at a ground hangar. */
export const HANGAR_BASE_RANGE = 64;

/** True when the unit is sheltered: parked in a hangar or embarked on a carrier. */
export function isSheltered(u: UnitRecord): boolean {
  return (u.hangarBuildingId ?? 0) > 0 || (u.embarkedOn ?? 0) > 0;
}

/**
 * Number of living aircraft currently embarked on the carrier
 * `carrierId`. world.units is spawn (id) order, so callers iterating it
 * see the wing in id order — deterministic.
 */
export function wingOccupancy(world: World, carrierId: number): number {
  let n = 0;
  for (const u of world.units) {
    if (u.hp > 0 && (u.embarkedOn ?? 0) === carrierId) n++;
  }
  return n;
}

/**
 * The shared hangar-slot reservation (PLAN §4 S4): the free slot for
 * one aircraft of `cls` on a ground building or a carrier wing, or -1
 * when there is none.
 * - building → index into the building's hangar slots ('generic'
 *   accepts any class; otherwise the classes must match).
 * - carrier → 0 when the wing has a free slot
 *   (`wingCapacity` − `wingOccupancy` > 0), else -1.
 * Pure — the caller performs the reservation write inside apply.
 */
export function findHangarSlot(
  world: World,
  target: { kind: 'building'; id: number } | { kind: 'carrier'; id: number },
  cls: HangarClass | undefined,
): number {
  if (target.kind === 'carrier') {
    const carrier = world.units.find((u) => u.id === target.id);
    if (!carrier || carrier.hp <= 0) return -1;
    const cap = UNIT_DEFS[carrier.kind as UnitKind]?.wingCapacity ?? 0;
    return wingOccupancy(world, target.id) < cap ? 0 : -1;
  }
  const b = world.city.buildings.find((x) => x.id === target.id);
  if (!b) return -1;
  return findBuildingHangarSlot(b.hangars ?? defaultHangarSlots(b.kind), cls);
}
