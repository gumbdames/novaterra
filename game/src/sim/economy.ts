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
import { getTaxMultiplier, getFactoryOutputMult, getInfluenceMult, getGoodsOutputMult, getTaxMultiplierFull } from './ages';
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
import { createSpatialHash, shInsert, shQueryRadius } from './spatial';
import { buildingTaxMultiplier, getDesirabilityModel } from './desirability';
import {
  BUILDING_DEFS,
  UTILITY_PENALTY,
  FOOD_PER_POP_PER_SEC,
  UTILITY_ZONE,
  ZoneType,
  cellCenterWorld,
  getPlayer,
  isOnTransportNetwork,
  runGrowth,
  type BuildingRecord,
  type CitySpecialization,
  type CityState,
  type PlayerState,
  type ResourceKey,
  type TradeRoute,
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

/** Market resources (funds is the numeraire, never traded directly). */
export const MarketResource = {
  MATERIALS: 'materials',
  FUEL: 'fuel',
  FOOD: 'food',
  RESEARCH: 'research',
} as const;
export type MarketResource = (typeof MarketResource)[keyof typeof MarketResource];

/** Fixed funds-per-unit prices (Phase 1; dynamic pricing deferred). */
export const MARKET_PRICES: Record<MarketResource, number> = {
  materials: 2,
  fuel: 3,
  food: 1,
  research: 12,
};

/**
 * Spread: buying costs (1 + spread) × price, selling pays (1 − spread) ×
 * price. A buy-then-sell round trip returns (1−s)/(1+s) = 2/3 of the funds.
 */
export const MARKET_SPREAD = 0.2;

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

/** Funds to buy `amount` units of a market resource. */
export function marketBuyCost(resource: MarketResource, amount: number): number {
  return amount * MARKET_PRICES[resource] * (1 + MARKET_SPREAD);
}

/** Funds received for selling `amount` units of a market resource. */
export function marketSellValue(resource: MarketResource, amount: number): number {
  return amount * MARKET_PRICES[resource] * (1 - MARKET_SPREAD);
}

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
      b.operational = funded.has(b.id);
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
    player.funds += rate;
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
}

/** Population eats; shortage stalls growth (flag read by runGrowth). */
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
  // Fiber Grid (Connectivity age) boosts tax income by 25%.
  const mult = getTaxMultiplier(world);
  // Workstream W: land value — the derived desirability model (rebuilt
  // only on structural change; the cached instance is free here).
  const desirModel = getDesirabilityModel(t, world);
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
    const landMult = def.zone === ZoneType.RESIDENTIAL ? buildingTaxMultiplier(desirModel, b) : 1;
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

/** Slow development levels for thriving buildings (1→3). */
function runLevels(world: World): void {
  const bank = rngBank(world);
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
  runFood(city);
  runTaxes(world, economyTickIndex(world), t);
  runTradeRoutes(world, city);
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
