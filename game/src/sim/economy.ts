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
 * NOVATERRA — sim/economy.ts — the economy tick: production, upkeep,
 * power/water allocation, food, taxes, and the market.
 *
 * Responsibilities:
 *  - `createEconomySystem(terrain)` builds the per-tick `SimSystem`. It does
 *    real work once per sim-second (`ECONOMY_TICKS = 30`); other ticks are
 *    a modulo check. All rates in `city.ts` are per sim-second.
 *  - Tick order per player: construction → upkeep funding → power/water
 *    allocation → production/consumption → food → taxes (every 60 s) →
 *    growth → population recount. Fixed order, id-ordered allocation —
 *    fully deterministic.
 *  - Phase 3 logistics (grand expansion): `runProduction` also fills
 *    ammo-producer stocks (capped at the def's `ammoStorage`, boosted by
 *    the Advanced Logistics upgrade) and pulls fuel from the owner's
 *    stockpile into fuelDepots (rate-limited); `runSupplyAura` (after
 *    harvest) refills owner units inside `LOGISTICS_RADIUS` of each
 *    completed reloadPoint in building-id order, honoring resupply
 *    reservations before serving by lowest `supplyLevel`.
 *  - The market exchanges any stockpile for funds at fixed rates with a
 *    spread (buy at +20%, sell at −20%): a round trip always loses value,
 *    so the market is a lever, not free money. Dynamic pricing is a later
 *    step (see D11).
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under Node/vitest.
 */

import type { TerrainData } from './terrain';
import type { World } from './world';
import { rngBank } from './world';
import type { SimSystem } from './tick';
import type { CommandQueue, CommandSpec } from './commands';
import { getFactoryOutputMult, getInfluenceMult, getGoodsOutputMult, getTaxMultiplierFull } from './ages';
import {
  hasUpgrade,
  effectivePowerSupply,
  effectiveWaterSupply,
  effectiveWaterDemand,
  effectiveAmmoProduction,
  effectiveAmmoStorage,
  effectiveFuelStorage,
  PRECISION_MANUFACTURING_MULT,
  VERTICAL_FARMING_FOOD_MULT,
  FREE_TRADE_MARKET_MULT,
  FREE_TRADE_SHOP_MULT,
  FREE_TRADE_TRADE_ROUTE_INCOME,
} from './upgrades';
import {
  getUtilityModel,
  getNetworkStock,
  setNetworkStock,
  networkStorageCapacity,
  daylightFactor,
  windFactor,
  isMeltedDown,
  POWER_EXPORT_FUNDS_PER_UNIT,
  WATER_EXPORT_FUNDS_PER_UNIT,
  type UtilityKind,
  type UtilityModel,
  type UtilitySideModel,
} from './utilityNetworks';
import { UNIT_DEFS, supplyLevel, type UnitRecord } from './units';
import { runIntelAccrual, isSabotaged } from './intel';
import { createSpatialHash, shInsert, shQueryRadius } from './spatial';
import { buildingTaxMultiplier, getDesirabilityModel, type DesirabilityModel } from './desirability';
import {
  BUILDING_DEFS,
  POLICIES,
  POLICY_IDS,
  UTILITY_PENALTY,
  FOOD_PER_POP_PER_SEC,
  UTILITY_ZONE,
  ZoneType,
  bumpSightBonusCache,
  cellCenterWorld,
  getPlayer,
  isOnTransportNetwork,
  policyFunded,
  runGrowth,
  type BuildingKind,
  type BuildingRecord,
  type CitySpecialization,
  type CityState,
  type PlayerState,
  type PolicyId,
  type ResourceKey,
  type TradeRoute,
  type AirlineRoute,
} from './city';

/** Economy ticks run once per sim-second (30 sim ticks). */
export const ECONOMY_TICKS = 30;
/** Tax collection every 60 economy ticks (60 sim-seconds). */
export const TAX_PERIOD_ECONOMY_TICKS = 60;
/** Seconds in one tax period (for the taxBase rates). */
export const TAX_PERIOD_SECONDS = 60;

/**
 * Phase 3 logistics: how far (world units) a reload point's refill aura
 * reaches. 18 ≈ 9 cells — the depot plus its immediate surroundings.
 * Rationale: smaller than command auras (HQ 20, Command Ship 24) so
 * supply stays a positioning decision rather than a map-wide buff, but
 * larger than the biggest depot footprint (4x3 cells = 8x6 world units)
 * so units parked at the gate are always in range.
 */
export const LOGISTICS_RADIUS = 18;

/**
 * Phase 3 logistics: fuel a single fuelDepot may pull from the owner's
 * player-level stockpile per sim-second. 5/s fills the 250-cap depot in
 * 50 s; even four depots together drain at most 20/s, so one depot can
 * never empty the empire's stockpile instantly (refinery output is
 * ~1.5/s for scale). Rate-limited pulls also keep the tick cost flat —
 * no per-unit iteration, just one min() per depot.
 */
export const FUEL_DEPOT_PULL_RATE_PER_SEC = 5;

/**
 * Fixed-rate market price list (R1 final-review, 2026-10-01): moved to
 * the leaf module sim/market.ts (no sim imports) so non-economy
 * consumers can price materials without importing economy.ts — an
 * ai→economy value import completes the ai→economy→city→world→ai
 * evaluation cycle that breaks module init. Re-exported here unchanged
 * so this module's public API is stable.
 */
export {
  MarketResource,
  MARKET_PRICES,
  MARKET_SPREAD,
  marketBuyCost,
  marketSellValue,
} from './market';
import {
  MarketResource,
  MARKET_PRICES,
  MARKET_SPREAD,
  marketBuyCost,
  marketSellValue,
} from './market';

/** Read a player's stockpile. */
export function getStock(player: PlayerState, resource: ResourceKey): number {
  switch (resource) {
    case 'funds': return player.funds;
    case 'materials': return player.materials;
    case 'fuel': return player.fuel;
    case 'food': return player.food;
    case 'research': return player.research;
    case 'goods': return player.goods;
    case 'influence': return player.influence;
    case 'manpower': return player.manpower;
  }
}

/** Add (or remove, when negative) to a player's stockpile. */
export function addStock(player: PlayerState, resource: ResourceKey, amount: number): void {
  switch (resource) {
    case 'funds': player.funds += amount; break;
    case 'materials': player.materials += amount; break;
    case 'fuel': player.fuel += amount; break;
    case 'food': player.food += amount; break;
    case 'research': player.research += amount; break;
    case 'goods': player.goods += amount; break;
    case 'influence': player.influence += amount; break;
    case 'manpower': player.manpower += amount; break;
  }
}

const RESOURCE_KEYS: ResourceKey[] = ['funds', 'materials', 'fuel', 'food', 'research', 'goods', 'influence', 'manpower'];

// ---------------------------------------------------------------------------
// The economy tick
// ---------------------------------------------------------------------------

interface UtilityAllocation {
  powerHeadroom: number[];
  waterHeadroom: number[];
}

/**
 * Fund upkeep and allocate power/water per player (Phase 2 network model,
 * grand expansion AD1/AD2). Mutates building operational / powered /
 * watered / powerDiag / waterDiag flags. Deterministic: id-ordered
 * plants, (network id, BFS distance, building id)-ordered consumers.
 *
 * Tick order per player:
 *  1. Upkeep funding (unchanged): newest buildings shut down first on
 *     shortfall; the funded set is charged.
 *  2. Online-set computation: completed+funded plants, minus
 *     cross-utility outages and meltdowns. Cross-utility hooks read the
 *     PREVIOUS tick's powered/watered flags (1-tick bootstrap,
 *     deterministic): desalination and waterTreatment supply only when
 *     powered; nuclearPlant supplies only when watered. Meltdowns are a
 *     pure seeded hash of (seed, building id, tick) — no RNG draws.
 *  3. Derived network model (utilityNetworks.getUtilityModel): per
 *     player, per utility, the conductor flood fill. Recomputed on
 *     structural change (utilityEpoch) or online-set change — never
 *     per tick.
 *  4. Per-network allocation: storage discharges into deficit first,
 *     then supply meets demand in (BFS distance, building id) order,
 *     then surplus recharges storage and any remainder exports at the
 *     map edge (auto-sell; shortage import is deferred — see D11).
 *  5. Pool fallback (AD2): unreached buildings use the legacy id-order
 *     pool allocator verbatim, so the Classic AI and old saves work.
 *  6. Diagnostics: reached+served -> 'ok'; reached+unserved ->
 *     'shortage'; unreached+pool-served -> 'ok'; unreached+unserved ->
 *     'disconnected'. Stranded online plants -> 'disconnected';
 *     meltdown-offline plants -> 'shortage'.
 */
function allocateUtilities(world: World, city: CityState): UtilityAllocation {
  const powerHeadroom: number[] = [];
  const waterHeadroom: number[] = [];
  const eIdx = economyTickIndex(world);

  // -- Pass 1: upkeep funding + online-set computation per player. ----
  interface PlayerPass {
    player: PlayerState;
    completed: BuildingRecord[];
    funded: Set<number>;
    onlinePower: number[];
    onlineWater: number[];
    meltedDown: Set<number>;
  }
  const passes: PlayerPass[] = [];
  const foulers: number[] = [];
  const treatments: number[] = [];
  for (const player of city.players) {
    // 1. Construction is done only in runEconomyTick; here consider completed.
    const completed = city.buildings.filter((b) => b.owner === player.id && b.progress >= 1);
    // 2. Upkeep funding: newest buildings shut down first on shortfall.
    const byIdDesc = [...completed].sort((a, b) => b.id - a.id);
    let affordable = player.funds;
    const funded = new Set<number>();
    for (const b of byIdDesc) {
      const upkeep = BUILDING_DEFS[b.kind].upkeepFundsPerSec;
      if (affordable >= upkeep) {
        affordable -= upkeep;
        funded.add(b.id);
      }
    }
    // Charge the upkeep of funded buildings.
    let charged = 0;
    for (const b of completed) {
      if (funded.has(b.id)) charged += BUILDING_DEFS[b.kind].upkeepFundsPerSec;
    }
    // Grand-expansion Phase 8 (civilian ordinances, workstream E):
    // policies fund AFTER buildings (buildings always win the funding
    // race), in POLICY_IDS order, from whatever affordable funds remain.
    // An unfunded policy is charged nothing and its effects do not
    // apply — `fundedPolicies` carries the decision for the rest of
    // the tick (DERIVED per-tick state: never snapshotted/digested).
    const fundedPolicies: PolicyId[] = [];
    for (const pid of POLICY_IDS) {
      if (player.policies[pid] !== true) continue;
      const cost = POLICIES[pid].upkeepFundsPerSec;
      if (affordable >= cost) {
        affordable -= cost;
        fundedPolicies.push(pid);
      }
    }
    player.fundedPolicies = fundedPolicies;
    for (const pid of fundedPolicies) charged += POLICIES[pid].upkeepFundsPerSec;
    player.funds -= charged;

    // 3. Online sets: completed + funded plants, minus hook/meltdown
    // outages. Foulers/scrubbers are collected globally (any owner).
    const onlinePower: number[] = [];
    const onlineWater: number[] = [];
    const meltedDown = new Set<number>();
    for (const b of completed) {
      if (!funded.has(b.id)) continue;
      const def = BUILDING_DEFS[b.kind];
      if (def.fouling) foulers.push(b.id);
      if (b.kind === 'waterTreatment' && b.powered) treatments.push(b.id);
      // Workstream M (user correction 2026-09-30): meltdowns are
      // attack-triggered only — no random per-tick trigger. A melted-down
      // plant supplies nothing until its outage window passes.
      if (b.kind === 'nuclearPlant' && isMeltedDown(b.meltdownUntilTick, world.tick)) {
        meltedDown.add(b.id);
        continue;
      }
      // Grand-expansion Phase 6 (S6 intel): a sabotaged building is
      // offline — it supplies nothing until its sabotage window
      // passes (the meltdown precedent directly above).
      if (isSabotaged(b, world.tick)) {
        continue;
      }
      // Cross-utility hooks (previous-tick flags — 1-tick bootstrap).
      if (b.kind === 'nuclearPlant' && !b.watered) continue;
      if ((b.kind === 'desalination' || b.kind === 'waterTreatment') && !b.powered) continue;
      if (def.powerSupply > 0) onlinePower.push(b.id);
      if (def.waterSupply > 0) onlineWater.push(b.id);
    }
    passes.push({ player, completed, funded, onlinePower, onlineWater, meltedDown });
  }

  // -- Pass 2: the derived network model (cached; rebuilds on epoch or
  //    online-set change). -------------------------------------------
  const model: UtilityModel = getUtilityModel(city, {
    power: passes.map((p) => p.onlinePower),
    water: passes.map((p) => p.onlineWater),
    foulers,
    treatments,
  });
  const fouled = new Set(model.fouledSources);

  // -- Pass 3: allocate per player, per utility. -----------------------
  passes.forEach((pass, pi) => {
    const { player, completed, funded } = pass;
    const byId = new Map<number, BuildingRecord>();
    for (const b of completed) byId.set(b.id, b);

    // Per-plant supply and per-building demand for both utilities.
    const powerSupplyOf = (b: BuildingRecord): number => {
      const def = BUILDING_DEFS[b.kind];
      let s = effectivePowerSupply(world, player.id, b.kind, def.powerSupply);
      // Solar is day-only (240-second day); wind is a seeded wobble.
      if (b.kind === 'solarFarm') s *= daylightFactor(world.tick);
      if (b.kind === 'windFarm') s *= windFactor(world.seed, eIdx);
      return s;
    };
    const waterSupplyOf = (b: BuildingRecord): number => {
      const def = BUILDING_DEFS[b.kind];
      let s = effectiveWaterSupply(world, player.id, b.kind, def.waterSupply);
      // Fouled sources (unscrubbed) output halved, floored.
      if (fouled.has(b.id)) s = Math.floor(s / 2);
      return s;
    };
    const powerDemandOf = (b: BuildingRecord): number => BUILDING_DEFS[b.kind].powerDemand;
    const waterDemandOf = (b: BuildingRecord): number =>
      effectiveWaterDemand(world, player.id, b.kind, BUILDING_DEFS[b.kind].waterDemand);

    const allocateSide = (utility: UtilityKind, side: UtilitySideModel): number => {
      const supplyOf = utility === 'power' ? powerSupplyOf : waterSupplyOf;
      const demandOf = utility === 'power' ? powerDemandOf : waterDemandOf;
      const setFlag = (b: BuildingRecord, ok: boolean): void => {
        if (utility === 'power') b.powered = ok;
        else b.watered = ok;
      };
      const setDiag = (b: BuildingRecord, diag: 'ok' | 'shortage' | 'disconnected'): void => {
        if (utility === 'power') b.powerDiag = diag;
        else b.waterDiag = diag;
      };
      let headroom = 0;

      // Per-network allocation: storage discharges into deficit, demand
      // draws in (distance, building id) order, surplus recharges
      // storage then exports at the map edge. Unfunded buildings are
      // shut down: they neither draw supply nor charge storage (their
      // flags/diags are set in the final loop below).
      for (const net of side.networks) {
        let supply = 0;
        for (const pid of net.plantIds) {
          const pb = byId.get(pid);
          if (pb) supply += supplyOf(pb);
        }
        const members = side.networkMembers.get(net.id) ?? [];
        let demand = 0;
        for (const m of members) {
          if (!funded.has(m.buildingId)) continue;
          const mb = byId.get(m.buildingId);
          if (mb) demand += demandOf(mb);
        }
        const capacity = networkStorageCapacity(city, side, utility, net.id, funded);
        let stock = getNetworkStock(model, player.id, utility, net);
        const deficit = demand - supply;
        if (deficit > 0 && stock > 0) {
          const use = Math.min(stock, deficit);
          stock -= use;
          supply += use;
        }
        let left = supply;
        const served = new Set<number>();
        for (const m of members) {
          if (!funded.has(m.buildingId)) continue;
          const mb = byId.get(m.buildingId);
          if (!mb) continue;
          const need = demandOf(mb);
          if (need <= 0) {
            served.add(m.buildingId);
          } else if (left >= need) {
            left -= need;
            served.add(m.buildingId);
          }
        }
        const surplus = left;
        const charge = Math.min(surplus, Math.max(0, capacity - stock));
        stock += charge;
        setNetworkStock(model, player.id, utility, net, stock);
        const exportUnits = surplus - charge;
        if (exportUnits > 0 && net.touchesEdge) {
          player.funds +=
            exportUnits * (utility === 'power' ? POWER_EXPORT_FUNDS_PER_UNIT : WATER_EXPORT_FUNDS_PER_UNIT);
        }
        headroom += surplus;
        for (const m of members) {
          if (!funded.has(m.buildingId)) continue;
          const mb = byId.get(m.buildingId);
          if (!mb) continue;
          const need = demandOf(mb);
          const ok = need <= 0 || served.has(m.buildingId);
          setFlag(mb, ok);
          setDiag(mb, need <= 0 ? 'ok' : ok ? 'ok' : 'shortage');
        }
      }

      // AD2 pool fallback: unreached buildings use the legacy id-order
      // allocator verbatim (poolPlants supply, unreached demand).
      let poolSupply = 0;
      for (const pid of side.poolPlants) {
        const pb = byId.get(pid);
        if (pb) poolSupply += supplyOf(pb);
      }
      let poolLeft = poolSupply;
      const poolServed = new Set<number>();
      for (const bid of side.unreached) {
        if (!funded.has(bid)) continue;
        const b = byId.get(bid);
        if (!b) continue;
        const need = demandOf(b);
        if (poolLeft >= need) {
          poolLeft -= need;
          poolServed.add(bid);
        }
      }
      headroom += poolLeft;
      for (const bid of side.unreached) {
        if (!funded.has(bid)) continue;
        const b = byId.get(bid);
        if (!b) continue;
        const ok = poolServed.has(bid);
        setFlag(b, ok);
        setDiag(b, ok ? 'ok' : 'disconnected');
      }
      return headroom;
    };

    powerHeadroom[player.id] = allocateSide('power', model.players[pi]?.power as UtilitySideModel);
    waterHeadroom[player.id] = allocateSide('water', model.players[pi]?.water as UtilitySideModel);

    // Flags + diags for every completed building.
    for (const b of completed) {
      const def = BUILDING_DEFS[b.kind];
      // Grand-expansion Phase 6 (S6 intel): sabotage takes the building
      // offline even when funded — the same gate the utility online
      // sets use above (the meltdown precedent).
      b.operational = funded.has(b.id) && !isSabotaged(b, world.tick);
      if (!funded.has(b.id)) {
        // Shut down: not participating. Flags keep the legacy
        // demand-zero semantics; diag mirrors the legacy decode.
        b.powered = def.powerDemand === 0;
        b.watered = def.waterDemand === 0;
        b.powerDiag = 'disconnected';
        b.waterDiag = 'disconnected';
        continue;
      }
      // Plants: diag on the supply utility reflects network state.
      // Demand-zero flags: the allocation branches only visit network
      // members and unreached demanders, so a funded demand-zero building
      // (e.g. a plant on the power side) would otherwise keep a stale
      // flag. Legacy semantics: demand-zero ⇒ served when funded.
      if (def.powerDemand === 0) b.powered = true;
      if (def.waterDemand === 0) b.watered = true;
      const isPowerPlant = def.powerSupply > 0;
      const isWaterPlant = def.waterSupply > 0;
      if (isPowerPlant) {
        if (pass.meltedDown.has(b.id)) b.powerDiag = 'shortage';
        else if (model.players[pi]?.power.plantNetwork.has(b.id)) b.powerDiag = 'ok';
        else if (pass.onlinePower.includes(b.id)) b.powerDiag = 'disconnected'; // stranded
        else b.powerDiag = 'shortage'; // hook outage (unpowered desalination etc. N/A here)
      }
      if (isWaterPlant) {
        if (model.players[pi]?.water.plantNetwork.has(b.id)) b.waterDiag = 'ok';
        else if (pass.onlineWater.includes(b.id)) b.waterDiag = 'disconnected'; // stranded
        else b.waterDiag = 'shortage'; // hook outage
      }
    }
  });

  // Under-construction buildings: not participating yet.
  for (const b of city.buildings) {
    if (b.progress < 1) {
      b.powerDiag = 'disconnected';
      b.waterDiag = 'disconnected';
    }
  }
  return { powerHeadroom, waterHeadroom };
}

/** Level multiplier: level 1 → 1.0, 2 → 1.25, 3 → 1.5. */
function levelMult(b: BuildingRecord): number {
  return 1 + 0.25 * (b.level - 1);
}

/**
 * Phase 3 city specialization multiplier. A focused city gets +25% output
 * from buildings in the matching zone, −10% from other zoned buildings;
 * 'balanced' and utility-zone buildings are unaffected.
 */
export const SPECIALIZATION_OUTPUT_BONUS = 1.25;

/**
 * Grand-expansion Phase 8 (civilian ordinances, workstream E,
 * 2026-09-30): the five ordinance effects that ride the economy tick.
 * The upkeep costs live in city.ts POLICIES (charged in
 * `allocateUtilities` before production runs, so the effects here are
 * always backed by real spend). Business Incentives and Nightlife both
 * lift commercial funds output and stack multiplicatively (+1.15 ×
 * +1.10 — the fun pair: a louder city that pays for itself). Transit
 * Subsidy lifts ridership income ×1.25. Education Grants lifts research
 * from the education/culture buildings (kindergarten, school, college,
 * university, library, museum) ×1.25 — the research output that the
 * education ladder and the museum produce; everything else researches
 * nothing.
 */
export const BUSINESS_INCENTIVES_COMMERCIAL_MULT = 1.15;
export const NIGHTLIFE_COMMERCIAL_MULT = 1.1;
export const TRANSIT_RIDERSHIP_MULT = 1.25;
export const EDUCATION_GRANTS_RESEARCH_MULT = 1.25;
/** Building kinds whose research output the Education Grants lift. */
export const EDUCATION_RESEARCH_KINDS: ReadonlySet<BuildingKind> = new Set([
  'kindergarten',
  'school',
  'college',
  'university',
  'library',
  'museum',
]);
export const SPECIALIZATION_OUTPUT_PENALTY = 0.9;

const SPEC_ZONE: Record<Exclude<CitySpecialization, 'balanced'>, number> = {
  industrial: ZoneType.INDUSTRIAL,
  commercial: ZoneType.COMMERCIAL,
  residential: ZoneType.RESIDENTIAL,
};

export function specializationMult(player: PlayerState, zone: number | string): number {
  if (player.specialization === 'balanced' || zone === UTILITY_ZONE) return 1;
  return SPEC_ZONE[player.specialization] === zone
    ? SPECIALIZATION_OUTPUT_BONUS
    : SPECIALIZATION_OUTPUT_PENALTY;
}

/** Run production/consumption for operational buildings, in id order. */
function runProduction(world: World, city: CityState): void {
  const factoryMult = getFactoryOutputMult(world);
  const influenceMult = getInfluenceMult(world);
  const goodsMult = getGoodsOutputMult(world);
  const ordered = [...city.buildings].sort((a, b) => a.id - b.id);
  for (const b of ordered) {
    if (!b.operational || b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    const player = getPlayer(city, b.owner);
    if (!player) continue;
    const penalty = (b.powered ? 1 : UTILITY_PENALTY) * (b.watered ? 1 : UTILITY_PENALTY);
    let mult = penalty * levelMult(b);
    // Heavy Industry boosts factory output.
    if (b.kind === 'factory') mult *= factoryMult;
    // Precision Manufacturing: factory output +25% (stacks multiplicatively
    // with Heavy Industry's 1.5x — the boom path).
    if (b.kind === 'factory' && hasUpgrade(world, b.owner, 'precisionManufacturing')) {
      mult *= PRECISION_MANUFACTURING_MULT;
    }
    // Phase 3: city specialization boosts/penalizes zoned output.
    mult *= specializationMult(player, def.zone);
    // Inputs first: a building starved of fuel sits idle this tick.
    let starved = false;
    for (const key of RESOURCE_KEYS) {
      const need = (def.input[key] ?? 0) * mult;
      if (need > 0 && getStock(player, key) < need) {
        starved = true;
        break;
      }
    }
    if (starved) continue;
    for (const key of RESOURCE_KEYS) {
      const need = (def.input[key] ?? 0) * mult;
      if (need > 0) addStock(player, key, -need);
    }
    for (const key of RESOURCE_KEYS) {
      let gain = (def.output[key] ?? 0) * mult;
      // Apply age program multipliers to specific resources.
      if (key === 'influence') gain *= influenceMult;
      if (key === 'goods') gain *= goodsMult;
      // Vertical Farming: farm food output x1.5 (water demand trimmed in
      // allocateUtilities).
      if (key === 'food' && b.kind === 'farm' && hasUpgrade(world, b.owner, 'verticalFarming')) {
        gain *= VERTICAL_FARMING_FOOD_MULT;
      }
      // Free Trade: market funds x1.5, shop funds x1.25.
      if (key === 'funds' && hasUpgrade(world, b.owner, 'freeTrade')) {
        if (b.kind === 'market') gain *= FREE_TRADE_MARKET_MULT;
        else if (b.kind === 'shop') gain *= FREE_TRADE_SHOP_MULT;
      }
      // Grand-expansion Phase 8 (civilian ordinances, workstream E):
      // Business Incentives ×1.15 and Nightlife Ordinance ×1.10 on
      // commercial-zone funds output (they stack multiplicatively).
      if (key === 'funds' && def.zone === ZoneType.COMMERCIAL) {
        if (policyFunded(world, b.owner, 'businessIncentives')) {
          gain *= BUSINESS_INCENTIVES_COMMERCIAL_MULT;
        }
        if (policyFunded(world, b.owner, 'nightlife')) {
          gain *= NIGHTLIFE_COMMERCIAL_MULT;
        }
      }
      // Grand-expansion Phase 8 (civilian ordinances, workstream E):
      // Education Grants ×1.25 on research from the education/culture
      // buildings (the education ladder + library + museum).
      if (key === 'research' && EDUCATION_RESEARCH_KINDS.has(b.kind)) {
        if (policyFunded(world, b.owner, 'educationGrants')) {
          gain *= EDUCATION_GRANTS_RESEARCH_MULT;
        }
      }
      if (gain > 0) addStock(player, key, gain);
    }
    // Phase 3 logistics: ammo production fills the producer's own stock
    // (per sim-second, same mult as output — utility penalty, level,
    // specialization — plus the Advanced Logistics +50% production
    // bonus). Capped at the effective ammo storage; every producer def
    // carries ammoStorage, so production is never silently dropped.
    // Runs after the input loop above: a factory starved of
    // materials/funds (the `continue`) produces nothing this tick.
    const ammoRate = effectiveAmmoProduction(world, b.owner, def);
    if (ammoRate > 0) {
      const cap = effectiveAmmoStorage(world, b.owner, def);
      if (cap > 0) {
        const cur = b.ammoStock ?? 0;
        b.ammoStock = Math.min(cap, cur + ammoRate * mult);
      }
    }
    // Phase 3 logistics: fuel depots cache the owner's fuel stockpile
    // forward. Rate-limited (FUEL_DEPOT_PULL_RATE_PER_SEC) and capped
    // at the effective fuel storage; never drives the player stockpile
    // negative (pulled <= player.fuel). Not gated on powered/watered —
    // it is a logistics transfer, not production.
    if (b.kind === 'fuelDepot') {
      const cap = effectiveFuelStorage(world, b.owner, def);
      const cur = b.fuelStock ?? 0;
      const headroom = cap - cur;
      if (headroom > 0) {
        const pulled = Math.min(headroom, FUEL_DEPOT_PULL_RATE_PER_SEC, player.fuel);
        if (pulled > 0) {
          b.fuelStock = cur + pulled;
          player.fuel -= pulled;
        }
      }
    }
  }
}

/**
 * Passive harvest (spec §5.6): living units whose def carries `harvest`
 * (fishingBoat: +0.6 food/s) add to their owner's stockpile each economy
 * tick. O(units), once per sim-second — negligible.
 */
function runHarvest(world: World, city: CityState): void {
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
    if (!def?.harvest) continue;
    const player = getPlayer(city, u.owner);
    if (!player) continue;
    for (const key of RESOURCE_KEYS) {
      const rate = def.harvest[key] ?? 0;
      if (rate > 0) addStock(player, key, rate);
    }
  }
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30): buildings with a def `harvest` (the civilian ports)
  // pay it too — once per economy tick, in building-id order, for
  // completed, operational buildings only. The fishingBoat precedent:
  // static and simple, no simulation of the trade itself. Unit harvest
  // (above) and building harvest (here) share the per-resource loop.
  for (const b of city.buildings) {
    if (b.progress < 1 || !b.operational) continue;
    const def = BUILDING_DEFS[b.kind as keyof typeof BUILDING_DEFS];
    if (!def?.harvest) continue;
    const player = getPlayer(city, b.owner);
    if (!player) continue;
    for (const key of RESOURCE_KEYS) {
      const rate = def.harvest[key] ?? 0;
      if (rate > 0) addStock(player, key, rate);
    }
  }
}

/**
 * Phase 4 transport (S7, grand expansion): civilian transport
 * earnings. Once per economy tick, after runHarvest, every living
 * civilian transport unit (a def with `transitEarnings`) that is ON
 * its network right now (`isOnTransportNetwork` — bus/tram on a road
 * cell, trains on a rail cell, ferries with a set route) pays
 * `transitEarnings` funds/sec to its owner — the fares/freight fees
 * of PLAN S7.
 *
 * Pure position check, no stored flag: a bus parked in a field earns
 * nothing the moment it leaves the road, and there is no stale state
 * to snapshot or digest. Deterministic: world.units is id-ordered,
 * the rate is a def constant.
 */
function runTransportEarnings(world: World, city: CityState): void {
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
    const rate = def?.transitEarnings ?? 0;
    if (rate <= 0) continue;
    if (!isOnTransportNetwork(city, u.kind, u.x, u.z, u.route !== undefined)) continue;
    const player = getPlayer(city, u.owner);
    if (!player) continue;
    player.funds += rate;
  }
}

/**
 * Phase 4 tiered transit stops/stations (2026-09-30): ridership
 * income — the ONE extra effect the tier brief asked for (the other
 * effect is the desirability amenity rows). Once per economy tick,
 * after runTransportEarnings, every completed, operational stop/
 * station (a def with `ridershipIncome`) pays its flat tier rate in
 * funds/sec to its owner, in building-id order. Deliberately flat —
 * no passenger simulation: fares scale with the tier, and the
 * population side of the story is already told by the desirability
 * rows (higher nearby land value → higher residential tax take).
 * Deterministic: def constants, id-ordered iteration.
 */
function runRidershipIncome(world: World, city: CityState): void {
  for (const b of city.buildings) {
    if (b.progress < 1 || !b.operational) continue;
    const def = BUILDING_DEFS[b.kind];
    const rate = def.ridershipIncome ?? 0;
    if (rate <= 0) continue;
    const player = getPlayer(city, b.owner);
    if (!player) continue;
    // Grand-expansion Phase 8 (civilian ordinances, workstream E):
    // the Transit Subsidy ordinance boosts ridership income ×1.25
    // (subsidized fares, more riders) — the ordinance's payoff side.
    player.funds += rate * (policyFunded(world, b.owner, 'transitSubsidy')
      ? TRANSIT_RIDERSHIP_MULT
      : 1);
  }
}

/**
 * Phase 3 logistics: the supply refill aura (PLAN S2 — "supply aura
 * auto-refill in runHarvest order"). Once per economy tick, after
 * production/harvest, every completed (`progress >= 1`, operational)
 * reloadPoint building, in building-id order, refills the owner's
 * living units inside LOGISTICS_RADIUS (unit-id order) from its stocks.
 *
 * Priority per depot: (1) units whose `resupplyDepotId` is this depot
 * (outstanding resupply orders — set by the resupply command, another
 * workstream), in id order; then (2) all other owner units, lowest
 * `supplyLevel` first (id tiebreak) — the emptiest tanks/magazines
 * drink first.
 *
 * Reservation accounting: a unit with a resupply order at this depot
 * draws on the FULL stock — its reservation is honored first because
 * it is served before anyone else at this depot. Every other unit sees
 * `stock - reserved`: reserved stock is never touched except to
 * fulfill a reservation. Fulfillment = any positive transfer: the
 * unit's `resupplyDepotId` clears and exactly the transferred amount
 * is released from the reservation pool (clamped; the resupply
 * command's timeout sweeps residue). A dry depot transfers nothing and
 * the order flag stays — the unit keeps waiting.
 *
 * Ammo transfers are whole units (ordnance is discrete); fuel
 * transfers are exact (fuel is a fluid, burn is fractional
 * per-second). Nuclear-fuel units never burn fuel and 'none'/
 * untracked kinds have zero capacity, so both are naturally excluded
 * from fuel service; units with no ammo capacity skip the ammo leg.
 *
 * Determinism: building-id order, unit-id order within a depot,
 * supplyLevel sort with id tiebreak, no RNG. Cost: one spatial-hash
 * build over living units per economy tick (1 Hz) plus one radius
 * query per depot — the movement.ts precedent at a thirtieth of the
 * cadence.
 */
function runSupplyAura(world: World, city: CityState): void {
  const depots: BuildingRecord[] = [];
  for (const b of city.buildings) {
    if (b.progress < 1 || !b.operational) continue;
    if (!BUILDING_DEFS[b.kind].reloadPoint) continue;
    depots.push(b);
  }
  if (depots.length === 0) return;
  // city.buildings is id-ordered by construction; sort defensively so
  // the service order never depends on insertion accidents.
  depots.sort((a, b) => a.id - b.id);

  const hash = createSpatialHash(16);
  const byId = new Map<number, UnitRecord>();
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    byId.set(u.id, u);
    shInsert(hash, u.id, u.x, u.z);
  }

  for (const d of depots) {
    const def = BUILDING_DEFS[d.kind];
    const dx = cellCenterWorld(d.cx + (def.footprintW - 1) / 2);
    const dz = cellCenterWorld(d.cz + (def.footprintH - 1) / 2);
    // shQueryRadius returns ids ascending — deterministic.
    const ids = shQueryRadius(hash, dx, dz, LOGISTICS_RADIUS);
    if (ids.length === 0) continue;
    const mine: UnitRecord[] = [];
    for (const id of ids) {
      const u = byId.get(id);
      // Depots serve their owner's units only — enemy units parked at
      // the gate get nothing.
      if (u !== undefined && u.owner === d.owner) mine.push(u);
    }
    const ordered: UnitRecord[] = [];
    const rest: UnitRecord[] = [];
    for (const u of mine) {
      if ((u.resupplyDepotId ?? 0) === d.id) ordered.push(u);
      else rest.push(u);
    }
    rest.sort((a, b) => {
      const la = supplyLevel(UNIT_DEFS[a.kind as keyof typeof UNIT_DEFS], a);
      const lb = supplyLevel(UNIT_DEFS[b.kind as keyof typeof UNIT_DEFS], b);
      return la !== lb ? la - lb : a.id - b.id;
    });
    for (const u of ordered) serveDepotUnit(d, u, true);
    for (const u of rest) serveDepotUnit(d, u, false);
  }
}

/**
 * Transfer ammo/fuel from depot `d` to unit `u`. `isReserved` = the
 * unit holds an outstanding resupply order at this depot (served
 * first, may draw on the full stock — see runSupplyAura).
 */
function serveDepotUnit(d: BuildingRecord, u: UnitRecord, isReserved: boolean): void {
  const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
  if (!def) return;
  let gaveAmmo = 0;
  let gaveFuel = 0;
  // Ammo: discrete shells — whole units only, never below 1 when the
  // need and the stock both cover it.
  const ammoNeed = Math.floor((def.ammoCapacity ?? 0) - u.ammo);
  if (ammoNeed >= 1) {
    const stock = d.ammoStock ?? 0;
    const reserved = d.reservedAmmo ?? 0;
    const avail = Math.floor(isReserved ? stock : stock - reserved);
    const give = Math.min(ammoNeed, Math.max(0, avail));
    if (give > 0) {
      d.ammoStock = stock - give;
      u.ammo += give;
      gaveAmmo = give;
    }
  }
  // Fuel: exact fractional top-up. fossil only — nuclear-fuel units are
  // exempt from refueling and untracked kinds have no capacity.
  if (def.fuelType === 'fossil') {
    const fuelNeed = (def.fuelCapacity ?? 0) - u.fuel;
    if (fuelNeed > 0) {
      const stock = d.fuelStock ?? 0;
      const reserved = d.reservedFuel ?? 0;
      const avail = isReserved ? stock : stock - reserved;
      const give = Math.min(fuelNeed, Math.max(0, avail));
      if (give > 0) {
        d.fuelStock = stock - give;
        u.fuel += give;
        gaveFuel = give;
      }
    }
  }
  // Fulfillment: any positive transfer completes the resupply order —
  // clear the flag and release exactly what was handed over from the
  // reservation pool (clamped at zero). A dry depot transfers nothing
  // and the order stays outstanding.
  if (isReserved && (gaveAmmo > 0 || gaveFuel > 0)) {
    u.resupplyDepotId = 0;
    d.reservedAmmo = Math.max(0, (d.reservedAmmo ?? 0) - gaveAmmo);
    d.reservedFuel = Math.max(0, (d.reservedFuel ?? 0) - gaveFuel);
  }
  // Grand-expansion Phase 5 (tanker, S2/S4): flying fuel stations load
  // their cargo hold at depots — gated on the def flag, so no existing
  // truck behavior changes. The cargo hold is what the tanker gives
  // away through its refuel aura (runTankerRefuel); its own tank fills
  // through the normal fossil leg above.
  if ((def.tankerRefuelRadius ?? 0) > 0) {
    const cargoCap = def.cargoFuelCapacity ?? 0;
    const need = cargoCap - u.cargoFuel;
    if (need > 0) {
      const stock = d.fuelStock ?? 0;
      const reserved = d.reservedFuel ?? 0;
      const avail = isReserved ? stock : stock - reserved;
      const give = Math.min(need, Math.max(0, avail));
      if (give > 0) {
        d.fuelStock = stock - give;
        u.cargoFuel += give;
      }
    }
  }
}

/** Population eats; shortage stalls growth (flag read by runGrowth). */
/**
 * Grand-expansion Phase 5 (tanker, S2/S4 — 2026-09-30): flying fuel
 * stations. Each living tanker, in id order, transfers fuel from its
 * cargo hold (loaded at depots — see serveDepotUnit) to friendly
 * fossil-fuel air units inside `tankerRefuelRadius`: neediest first
 * (fuel fraction ascending, ties break to the lowest unit id), until
 * the hold is dry. Nuclear-fuel units never burn fuel, so they are
 * never refueled (the data-driven exemption — user directive
 * 2026-09-30); the tanker's own tank is untouched (it burns from it).
 * Runs on the economy tick, after the depot aura (tankers load, then
 * give). Deterministic: id-ordered tankers, sorted recipients, no RNG.
 */
function runTankerRefuel(world: World): void {
  const tankers = world.units.filter(
    (u) => u.hp > 0 && (UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS]?.tankerRefuelRadius ?? 0) > 0,
  );
  if (tankers.length === 0) return;
  // world.units is spawn (id) order; sort defensively so the service
  // order never depends on insertion accidents.
  tankers.sort((a, b) => a.id - b.id);
  for (const t of tankers) {
    const tdef = UNIT_DEFS[t.kind as keyof typeof UNIT_DEFS];
    const radius = tdef?.tankerRefuelRadius ?? 0;
    let hold = t.cargoFuel;
    if (hold <= 0 || radius <= 0) continue;
    const r2 = radius * radius;
    const needy: UnitRecord[] = [];
    for (const u of world.units) {
      if (u.hp <= 0 || u.id === t.id || u.owner !== t.owner) continue;
      const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
      if (!def || def.domain !== 'air' || def.fuelType !== 'fossil') continue;
      const cap = def.fuelCapacity ?? 0;
      if (cap <= 0 || u.fuel >= cap) continue;
      const dx = u.x - t.x;
      const dz = u.z - t.z;
      if (dx * dx + dz * dz <= r2) needy.push(u);
    }
    // Neediest first: fuel fraction ascending, ties break to lowest id.
    needy.sort((a, b) => {
      const da = UNIT_DEFS[a.kind as keyof typeof UNIT_DEFS];
      const db = UNIT_DEFS[b.kind as keyof typeof UNIT_DEFS];
      const fa = a.fuel / (da?.fuelCapacity ?? 1);
      const fb = b.fuel / (db?.fuelCapacity ?? 1);
      return fa !== fb ? fa - fb : a.id - b.id;
    });
    for (const u of needy) {
      if (hold <= 0) break;
      const def = UNIT_DEFS[u.kind as keyof typeof UNIT_DEFS];
      const give = Math.min((def?.fuelCapacity ?? 0) - u.fuel, hold);
      if (give > 0) {
        u.fuel += give;
        hold -= give;
      }
    }
    t.cargoFuel = hold;
  }
}
function runFood(city: CityState): void {
  let shortage = false;
  for (const player of city.players) {
    const need = player.population * FOOD_PER_POP_PER_SEC;
    if (player.food < need) {
      player.food = 0;
      shortage = true;
    } else {
      player.food -= need;
    }
  }
  city.foodShortage = shortage;
}

/** Collect taxes every tax period. Utilities are not taxed (D11). */
function runTaxes(world: World, economyTickIndex: number, t: TerrainData): void {
  if (economyTickIndex % TAX_PERIOD_ECONOMY_TICKS !== 0) return;
  const city = world.city;
  // Final-review R1 (C7, 2026-10-01): the FULL program stack. Fiber
  // Grid (Connectivity age) boosts tax income by 25% and the Ascendance
  // Prosperity Program adds a further 50% — the stacked multiplier
  // (1.25 × 1.5 = 1.875) is what the program advertises. Using the
  // fiber-only multiplier here silently dropped the Prosperity bonus.
  const mult = getTaxMultiplierFull(world);
  // Workstream W: land value — the derived desirability model (rebuilt
  // only on structural change; the cached instance is free here).
  // Workstream W: land value — the derived desirability model (rebuilt
  // only on structural change; the cached instance is free here).
  // Grand-expansion Phase 8 (civilian ordinances, workstream E): the
  // model is per-owner — green/transit/nightlife ordinances reshape
  // each owner's land values, so rebuild the owner's model for the
  // building's owner (cache hit when nothing changed since last time).
  let desirModel: DesirabilityModel | null = null;
  let desirOwner = -1;
  for (const b of city.buildings) {
    if (b.progress < 1 || !b.operational) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def.zone === UTILITY_ZONE) continue;
    const player = getPlayer(city, b.owner);
    if (!player) continue;
    const rate = player.taxRates[def.zone] as number;
    // Workstream W: residential buildings pay tax on their land value —
    // low ×0.8, modest ×1.0, nice ×1.3, prime ×1.7 (see
    // LAND_VALUE_TIERS in sim/desirability.ts). Commercial/industrial
    // buildings pay the flat rate (land value is a residential concept).
    let landMult = 1;
    if (def.zone === ZoneType.RESIDENTIAL) {
      if (b.owner !== desirOwner) {
        desirModel = getDesirabilityModel(t, world, b.owner);
        desirOwner = b.owner;
      }
      landMult = buildingTaxMultiplier(desirModel as DesirabilityModel, b);
    }
    player.funds += rate * def.taxBasePerSec * levelMult(b) * TAX_PERIOD_SECONDS * mult * landMult;
  }
}

/** Funds to establish one trade route. */
export const TRADE_ROUTE_SETUP_COST = 500;
/** Funds per sim-second paid to the route owner while the route is active. */
export const TRADE_ROUTE_INCOME_PER_SEC = 3;

/**
 * Phase 3 trade routes. A route is active while both ends operate at
 * least one completed commercial-zone building (shops, media centers);
 * the owner collects the income each economy tick. Routes are
 * unilateral — no partner consent needed (like trading with neutrals).
 */
function hasTradeCapacity(city: CityState, owner: number): boolean {
  for (const b of city.buildings) {
    if (b.owner !== owner || b.progress < 1 || !b.operational) continue;
    if (BUILDING_DEFS[b.kind].zone === ZoneType.COMMERCIAL) return true;
  }
  return false;
}

function runTradeRoutes(world: World, city: CityState): void {
  for (const route of city.tradeRoutes) {
    const owner = getPlayer(city, route.owner);
    if (!owner) continue;
    if (!getPlayer(city, route.partner)) continue;
    if (hasTradeCapacity(city, route.owner) && hasTradeCapacity(city, route.partner)) {
      // Free Trade lifts route income 3 -> 4.5/s.
      owner.funds += hasUpgrade(world, route.owner, 'freeTrade')
        ? FREE_TRADE_TRADE_ROUTE_INCOME
        : TRADE_ROUTE_INCOME_PER_SEC;
    }
  }
}

/** Funds to establish one airline route. */
export const AIRLINE_ROUTE_SETUP_COST = 500;
/** Base funds per sim-second per active airline route. */
export const AIRLINE_BASE_INCOME_PER_SEC = 1.5;
/** Extra funds per sim-second per world-unit of route distance. */
export const AIRLINE_DISTANCE_INCOME_PER_UNIT = 0.005;
/** Extra funds per sim-second per completed passenger terminal (owner's). */
export const AIRLINE_PASSENGER_TERMINAL_BONUS = 0.4;
/** Extra funds per sim-second per completed cargo terminal (owner's). */
export const AIRLINE_CARGO_TERMINAL_BONUS = 0.5;

/**
 * Grand-expansion Phase 5 (S5, 2026-09-30): civilian airline routes.
 * Pure route income (§3.5): base + distance × per-unit + the owner's
 * completed passenger/cargo terminal bonuses. Exported so the UI's
 * airline panel shows exactly what the sim pays (no duplicated
 * formula). Returns 0 when an endpoint is dead (missing, incomplete,
 * or non-operational) — `runAirlineIncome` removes dead routes after
 * paying the living ones. Deterministic: building-id order, no RNG;
 * Math.sqrt is IEEE-754 correctly rounded (same engine ⇒ same bits).
 */
export function airlineRouteIncome(world: World, route: AirlineRoute): number {
  const city = world.city;
  const from = city.buildings.find((b) => b.id === route.from);
  const to = city.buildings.find((b) => b.id === route.to);
  if (!from || !to || from.progress < 1 || !from.operational || to.progress < 1 || !to.operational) {
    return 0;
  }
  const dx = cellCenterWorld(from.cx) - cellCenterWorld(to.cx);
  const dz = cellCenterWorld(from.cz) - cellCenterWorld(to.cz);
  const distance = Math.sqrt(dx * dx + dz * dz);
  let terminalBonus = 0;
  for (const b of city.buildings) {
    if (b.owner !== route.owner || b.progress < 1) continue;
    if (b.kind === 'passengerTerminal') terminalBonus += AIRLINE_PASSENGER_TERMINAL_BONUS;
    else if (b.kind === 'cargoTerminal') terminalBonus += AIRLINE_CARGO_TERMINAL_BONUS;
  }
  return AIRLINE_BASE_INCOME_PER_SEC + distance * AIRLINE_DISTANCE_INCOME_PER_UNIT + terminalBonus;
}

/** Pay living routes, remove dead ones (demolished endpoint) — id order, no RNG. */
function runAirlineIncome(world: World, city: CityState): void {
  const dead = new Set<number>();
  for (const route of city.airlineRoutes) {
    const owner = getPlayer(city, route.owner);
    const income = airlineRouteIncome(world, route);
    if (!owner || income <= 0) {
      dead.add(route.id);
      continue;
    }
    owner.funds += income;
  }
  if (dead.size > 0) {
    city.airlineRoutes = city.airlineRoutes.filter((r) => !dead.has(r.id));
  }
}

/** An airline endpoint must be the owner's completed civil/mixed airport. */
function airlineEndpointProblem(world: World, owner: number, id: number, which: string): string | null {
  const b = world.city.buildings.find((x) => x.id === id);
  if (!b) return `establishAirlineRoute: unknown ${which} building #${id}`;
  if (b.owner !== owner) return `establishAirlineRoute: ${which} building #${id} is not yours`;
  if (b.progress < 1) return `establishAirlineRoute: ${which} building #${id} is not completed`;
  const type = BUILDING_DEFS[b.kind].airportType;
  if (type !== 'civilian' && type !== 'mixed') {
    return `establishAirlineRoute: ${which} building #${id} is not a civil or mixed airport`;
  }
  return null;
}

const establishAirlineRouteSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) {
      return 'establishAirlineRoute: unknown owner';
    }
    const from = payloadInt(cmd.payload, 'from');
    const to = payloadInt(cmd.payload, 'to');
    if (from === null || to === null) {
      return 'establishAirlineRoute: from/to must be building ids';
    }
    if (from === to) return 'establishAirlineRoute: from and to must be different airports';
    const problem = airlineEndpointProblem(world, owner, from, 'from')
      ?? airlineEndpointProblem(world, owner, to, 'to');
    if (problem) return problem;
    // Routes are undirected for duplication (A↔B == B↔A).
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    const dup = world.city.airlineRoutes.some(
      (r) => r.owner === owner && Math.min(r.from, r.to) === a && Math.max(r.from, r.to) === b,
    );
    if (dup) return 'establishAirlineRoute: route already exists';
    const player = getPlayer(world.city, owner) as PlayerState;
    if (player.funds < AIRLINE_ROUTE_SETUP_COST) {
      return `establishAirlineRoute: cannot afford ${AIRLINE_ROUTE_SETUP_COST} funds setup`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const from = payloadInt(cmd.payload, 'from') as number;
    const to = payloadInt(cmd.payload, 'to') as number;
    const player = getPlayer(world.city, owner) as PlayerState;
    player.funds -= AIRLINE_ROUTE_SETUP_COST;
    const route: AirlineRoute = {
      id: world.city.nextAirlineRouteId++,
      owner,
      from,
      to,
      establishedTick: world.tick,
    };
    world.city.airlineRoutes.push(route);
    return { id: route.id, from, to };
  },
};

const cancelAirlineRouteSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) {
      return 'cancelAirlineRoute: unknown owner';
    }
    const id = payloadInt(cmd.payload, 'id');
    const route = world.city.airlineRoutes.find((r) => r.id === id);
    if (!route) return 'cancelAirlineRoute: unknown route';
    if (route.owner !== owner) return 'cancelAirlineRoute: route belongs to another player';
    return null;
  },
  apply(cmd, world): unknown {
    const id = payloadInt(cmd.payload, 'id') as number;
    world.city.airlineRoutes = world.city.airlineRoutes.filter((r) => r.id !== id);
    return { id };
  },
};

/** Slow development levels for thriving buildings (1→3). */
function runLevels(world: World): void {  const bank = rngBank(world);
  for (const b of world.city.buildings) {
    if (b.progress >= 1 && b.operational && b.powered && b.watered && b.level < 3) {
      if (bank.next('city') < 0.002) b.level += 1;
    }
  }
}

/**
 * Phase 4 occupancy (2026-09-30): per-building headcounts. Runs right
 * after construction (so newly-completed buildings move in this tick)
 * and BEFORE recountPopulation — population is the sum of residents,
 * not a second loop over defs.
 *
 * - `residents` = def.population when completed (progress >= 1), else 0.
 *   Housing keeps everyone: residents never leave a completed home.
 * - `workers`: each player's population is their workforce. It fills
 *   jobs in building-id order (deterministic — city.buildings is
 *   id-ordered) across the owner's completed, operational buildings
 *   with `jobs > 0`, capped per building. Leftover population is the
 *   non-working population (children, retirees) — it still counts in
 *   `player.population` and still pays taxes.
 *
 * Invariants: sum(residents of owner's buildings) == player.population;
 * sum(workers) <= player.population; workers(b) <= jobs(def).
 * No per-individual simulation — the selection panel only needs
 * headcounts, so headcounts are what we store.
 */
function recomputeOccupancy(city: CityState): void {
  for (const b of city.buildings) {
    const def = BUILDING_DEFS[b.kind];
    b.residents = b.progress >= 1 ? def.population : 0;
    b.workers = 0;
  }
  // Workforce pool per player = THIS tick's resident sum (fresh — the
  // pre-recount player.population lags one tick on the first tick, when
  // a city is founded and nobody is counted yet).
  const residentsByOwner = new Map<number, number>();
  for (const b of city.buildings) {
    const r = b.residents ?? 0;
    if (r <= 0) continue;
    residentsByOwner.set(b.owner, (residentsByOwner.get(b.owner) ?? 0) + r);
  }
  for (const player of city.players) {
    let pool = residentsByOwner.get(player.id) ?? 0;
    if (pool <= 0) continue;
    for (const b of city.buildings) {
      if (pool <= 0) break;
      if (b.owner !== player.id || b.progress < 1 || !b.operational) continue;
      const jobs = BUILDING_DEFS[b.kind].jobs ?? 0;
      if (jobs <= 0) continue;
      const w = Math.min(jobs, pool);
      b.workers = w;
      pool -= w;
    }
  }
}

/**
 * Recount population from completed residential buildings. Sums the
 * per-building `residents` filled by recomputeOccupancy (run first) —
 * one source of truth for who lives where.
 */
function recountPopulation(city: CityState): void {
  for (const player of city.players) player.population = 0;
  for (const b of city.buildings) {
    const r = b.residents ?? 0;
    if (r <= 0) continue;
    const player = getPlayer(city, b.owner);
    if (player) player.population += r;
  }
}

/** Manpower trickles in from population: 2% of population per sim-second. */
export const MANPOWER_PER_POP_PER_SEC = 0.02;

/** Add manpower from population (called after recountPopulation each economy tick). */
function generateManpower(city: CityState): void {
  for (const player of city.players) {
    player.manpower += player.population * MANPOWER_PER_POP_PER_SEC;
  }
}

/** Advance construction progress by one economy tick (one sim-second). */
function runConstruction(city: CityState): void {
  for (const b of city.buildings) {
    if (b.progress < 1) {
      const def = BUILDING_DEFS[b.kind];
      b.progress = Math.min(1, b.progress + 1 / def.buildSeconds);
      // Final-review R3 L7: a completion crossing can change the intel
      // building-sight sum (satelliteUplink) — invalidate its cache.
      // Completions are rare, so the bump costs one O(buildings)
      // recompute on the next sight query, not per query.
      if (b.progress >= 1) bumpSightBonusCache(city);
    }
  }
}

/** Count of economy ticks elapsed (world.tick is a multiple of 30 here). */
function economyTickIndex(world: World): number {
  return Math.floor(world.tick / 30);
}

/**
 * One full economy tick. Public for tests; the system wrapper below
 * calls it once per sim-second.
 */
export function runEconomyTick(world: World, t: TerrainData): void {
  const city = world.city;
  runConstruction(city);
  const { powerHeadroom, waterHeadroom } = allocateUtilities(world, city);
  // Phase 4 occupancy (2026-09-30): after construction AND the utility
  // allocation, so workers see this tick's operational flags (no
  // one-tick lag); before the population recount (which sums residents)
  // and manpower (which scales with population).
  recomputeOccupancy(city);
  recountPopulation(city);
  generateManpower(city);
  // Grand-expansion Phase 6 (S6 intel): asset accrual rides the economy
  // tick (1 Hz ⇒ dt = 1 sim-second). Placement is deliberate: after
  // the utility allocation (so `operational` flags are this tick's)
  // and before production (a sabotaged building accrues nothing AND
  // produces nothing — one consistent offline gate).
  runIntelAccrual(world, 1);
  runProduction(world, city);
  runHarvest(world, city);
  // Phase 4 transport (S7): civilian fare/freight earnings ride right
  // after harvest — same shape (living units × def rate), gated on the
  // network check instead of always-on.
  runTransportEarnings(world, city);
  // Phase 4 tiered transit stops/stations (2026-09-30): ridership
  // income — completed, operational stops pay their flat tier rate
  // (same shape as harvest: buildings × def rate, id order).
  runRidershipIncome(world, city);
  // Phase 3 logistics: the refill aura runs after production/harvest so
  // it sees this tick's fresh producer stocks (PLAN S2).
  runSupplyAura(world, city);
  // Grand-expansion Phase 5 (tanker, S2/S4): the flying fuel stations
  // distribute after the depot aura (tankers load, then give).
  runTankerRefuel(world);
  runFood(city);
  runTaxes(world, economyTickIndex(world), t);
  runTradeRoutes(world, city);
  // Grand-expansion Phase 5 (S5, 2026-09-30): airline route income —
  // same position as trade routes (after taxes, before growth).
  runAirlineIncome(world, city);
  runLevels(world);
  runGrowth(t, world, powerHeadroom, waterHeadroom);
}

/** SimSystem wrapper: runs the economy once per sim-second. */
export function createEconomySystem(t: TerrainData): SimSystem {
  return (world: World, _dt: number): void => {
    if (world.tick % 30 !== 0) return;
    runEconomyTick(world, t);
  };
}

// ---------------------------------------------------------------------------
// Market command
// ---------------------------------------------------------------------------

function payloadStr(payload: Record<string, unknown>, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' ? v : null;
}

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function isMarketResource(r: string): r is MarketResource {
  return r === 'materials' || r === 'fuel' || r === 'food' || r === 'research';
}

const marketTradeSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) return 'marketTrade: unknown owner';
    const action = payloadStr(cmd.payload, 'action');
    if (action !== 'buy' && action !== 'sell') return "marketTrade: action must be 'buy' or 'sell'";
    const resource = payloadStr(cmd.payload, 'resource');
    if (resource === null || !isMarketResource(resource)) {
      return 'marketTrade: resource must be materials, fuel, food or research';
    }
    const amount = payloadInt(cmd.payload, 'amount');
    if (amount === null || amount < 1) return 'marketTrade: amount must be a positive integer';
    const player = getPlayer(world.city, owner) as PlayerState;
    if (action === 'buy') {
      const cost = marketBuyCost(resource, amount);
      if (player.funds < cost) return `marketTrade: cannot afford ${cost.toFixed(2)} funds`;
    } else {
      if (getStock(player, resource) < amount) return `marketTrade: insufficient ${resource}`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const action = payloadStr(cmd.payload, 'action') as 'buy' | 'sell';
    const resource = payloadStr(cmd.payload, 'resource') as MarketResource;
    const amount = payloadInt(cmd.payload, 'amount') as number;
    const player = getPlayer(world.city, owner) as PlayerState;
    if (action === 'buy') {
      player.funds -= marketBuyCost(resource, amount);
      addStock(player, resource, amount);
    } else {
      addStock(player, resource, -amount);
      player.funds += marketSellValue(resource, amount);
    }
    return { action, resource, amount, funds: player.funds };
  },
};

/** Register the market command kind on a queue. */
export function registerEconomyCommands(queue: CommandQueue): void {
  queue.register('marketTrade', marketTradeSpec);
  queue.register('establishTradeRoute', establishTradeRouteSpec);
  queue.register('cancelTradeRoute', cancelTradeRouteSpec);
  // Grand-expansion Phase 5 (S5, 2026-09-30): civilian airline routes.
  queue.register('establishAirlineRoute', establishAirlineRouteSpec);
  queue.register('cancelAirlineRoute', cancelAirlineRouteSpec);
}

const establishTradeRouteSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) {
      return 'establishTradeRoute: unknown owner';
    }
    const partner = payloadInt(cmd.payload, 'partner');
    if (partner === null || !getPlayer(world.city, partner)) {
      return 'establishTradeRoute: unknown partner';
    }
    if (partner === owner) return 'establishTradeRoute: cannot trade with yourself';
    const dup = world.city.tradeRoutes.some(
      (r) => r.owner === owner && r.partner === partner,
    );
    if (dup) return 'establishTradeRoute: route already exists';
    const player = getPlayer(world.city, owner) as PlayerState;
    if (player.funds < TRADE_ROUTE_SETUP_COST) {
      return `establishTradeRoute: cannot afford ${TRADE_ROUTE_SETUP_COST} funds setup`;
    }
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const partner = payloadInt(cmd.payload, 'partner') as number;
    const player = getPlayer(world.city, owner) as PlayerState;
    player.funds -= TRADE_ROUTE_SETUP_COST;
    const route: TradeRoute = { owner, partner, establishedTick: world.tick };
    world.city.tradeRoutes.push(route);
    return { owner, partner };
  },
};

const cancelTradeRouteSpec: CommandSpec = {
  validate(cmd, world): string | null {
    const owner = payloadInt(cmd.payload, 'owner');
    if (owner === null || !getPlayer(world.city, owner)) {
      return 'cancelTradeRoute: unknown owner';
    }
    const partner = payloadInt(cmd.payload, 'partner');
    if (partner === null || !getPlayer(world.city, partner)) {
      return 'cancelTradeRoute: unknown partner';
    }
    const i = world.city.tradeRoutes.findIndex(
      (r) => r.owner === owner && r.partner === partner,
    );
    if (i === -1) return 'cancelTradeRoute: no such route';
    return null;
  },
  apply(cmd, world): unknown {
    const owner = payloadInt(cmd.payload, 'owner') as number;
    const partner = payloadInt(cmd.payload, 'partner') as number;
    const i = world.city.tradeRoutes.findIndex(
      (r) => r.owner === owner && r.partner === partner,
    );
    world.city.tradeRoutes.splice(i, 1);
    return { owner, partner };
  },
};
