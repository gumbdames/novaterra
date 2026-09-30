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
import { getTaxMultiplier, getFactoryOutputMult, getInfluenceMult, getGoodsOutputMult, getUpkeepMult, getUtilityDemandMult, getTaxMultiplierFull } from './ages';
import {
  hasUpgrade,
  effectivePowerSupply,
  effectiveWaterDemand,
  PRECISION_MANUFACTURING_MULT,
  VERTICAL_FARMING_FOOD_MULT,
  FREE_TRADE_MARKET_MULT,
  FREE_TRADE_SHOP_MULT,
  FREE_TRADE_TRADE_ROUTE_INCOME,
} from './upgrades';
import { UNIT_DEFS } from './units';
import {
  BUILDING_DEFS,
  UTILITY_PENALTY,
  FOOD_PER_POP_PER_SEC,
  UTILITY_ZONE,
  ZoneType,
  getPlayer,
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
 * Fund upkeep and allocate power/water per player. Mutates building
 * operational/powered/watered flags. Deterministic: id-ordered.
 */
function allocateUtilities(world: World, city: CityState): UtilityAllocation {
  const powerHeadroom: number[] = [];
  const waterHeadroom: number[] = [];
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

    // 3. Power: supply from every completed, funded plant — no road
    // requirement (user directive 2026-09-30). Demand in id order.
    // Smart Grid raises plant supply (powerPlant 25->35, solarFarm
    // 15->20, nuclearPlant 60->75).
    let powerSupply = 0;
    for (const b of completed) {
      const def = BUILDING_DEFS[b.kind];
      if (def.powerSupply > 0 && funded.has(b.id)) {
        powerSupply += effectivePowerSupply(world, b.owner, b.kind, def.powerSupply);
      }
    }
    const powerDemanders = completed
      .filter((b) => funded.has(b.id) && BUILDING_DEFS[b.kind].powerDemand > 0)
      .sort((a, b) => a.id - b.id);
    let powerLeft = powerSupply;
    const poweredSet = new Set<number>();
    for (const b of powerDemanders) {
      const need = BUILDING_DEFS[b.kind].powerDemand;
      if (powerLeft >= need) {
        powerLeft -= need;
        poweredSet.add(b.id);
      }
    }
    // 4. Water: same shape — every completed, funded pump counts.
    let waterSupply = 0;
    for (const b of completed) {
      const def = BUILDING_DEFS[b.kind];
      if (def.waterSupply > 0 && funded.has(b.id)) {
        waterSupply += def.waterSupply;
      }
    }
    const waterDemanders = completed
      .filter((b) => funded.has(b.id) && BUILDING_DEFS[b.kind].waterDemand > 0)
      .sort((a, b) => a.id - b.id);
    let waterLeft = waterSupply;
    const wateredSet = new Set<number>();
    for (const b of waterDemanders) {
      // Vertical Farming trims the farm's water demand (4->3).
      const need = effectiveWaterDemand(world, b.owner, b.kind, BUILDING_DEFS[b.kind].waterDemand);
      if (waterLeft >= need) {
        waterLeft -= need;
        wateredSet.add(b.id);
      }
    }

    for (const b of completed) {
      const def = BUILDING_DEFS[b.kind];
      b.powered = def.powerDemand === 0 || poweredSet.has(b.id);
      b.watered = def.waterDemand === 0 || wateredSet.has(b.id);
      b.operational = funded.has(b.id);
    }
    powerHeadroom[player.id] = powerLeft;
    waterHeadroom[player.id] = waterLeft;
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
function runTaxes(world: World, economyTickIndex: number): void {
  if (economyTickIndex % TAX_PERIOD_ECONOMY_TICKS !== 0) return;
  const city = world.city;
  // Fiber Grid (Connectivity age) boosts tax income by 25%.
  const mult = getTaxMultiplier(world);
  for (const b of city.buildings) {
    if (b.progress < 1 || !b.operational) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def.zone === UTILITY_ZONE) continue;
    const player = getPlayer(city, b.owner);
    if (!player) continue;
    const rate = player.taxRates[def.zone] as number;
    player.funds += rate * def.taxBasePerSec * levelMult(b) * TAX_PERIOD_SECONDS * mult;
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

/** Recount population from completed residential buildings. */
function recountPopulation(city: CityState): void {
  for (const player of city.players) player.population = 0;
  for (const b of city.buildings) {
    if (b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def.population > 0) {
      const player = getPlayer(city, b.owner);
      if (player) player.population += def.population;
    }
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
  recountPopulation(city);
  generateManpower(city);
  runConstruction(city);
  const { powerHeadroom, waterHeadroom } = allocateUtilities(world, city);
  runProduction(world, city);
  runHarvest(world, city);
  runFood(city);
  runTaxes(world, economyTickIndex(world));
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
