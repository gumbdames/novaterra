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
import {
  BUILDING_DEFS,
  UTILITY_PENALTY,
  FOOD_PER_POP_PER_SEC,
  UTILITY_ZONE,
  getPlayer,
  isRoadAdjacent,
  runGrowth,
  type BuildingRecord,
  type CityState,
  type PlayerState,
  type ResourceKey,
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
  }
}

const RESOURCE_KEYS: ResourceKey[] = ['funds', 'materials', 'fuel', 'food', 'research'];

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
function allocateUtilities(city: CityState): UtilityAllocation {
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

    // 3. Power: supply from road-adjacent plants, demand in id order.
    let powerSupply = 0;
    for (const b of completed) {
      const def = BUILDING_DEFS[b.kind];
      if (def.powerSupply > 0 && funded.has(b.id) &&
          isRoadAdjacent(city, b.cx, b.cz, def.footprintW, def.footprintH)) {
        powerSupply += def.powerSupply;
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
    // 4. Water: same shape.
    let waterSupply = 0;
    for (const b of completed) {
      const def = BUILDING_DEFS[b.kind];
      if (def.waterSupply > 0 && funded.has(b.id) &&
          isRoadAdjacent(city, b.cx, b.cz, def.footprintW, def.footprintH)) {
        waterSupply += def.waterSupply;
      }
    }
    const waterDemanders = completed
      .filter((b) => funded.has(b.id) && BUILDING_DEFS[b.kind].waterDemand > 0)
      .sort((a, b) => a.id - b.id);
    let waterLeft = waterSupply;
    const wateredSet = new Set<number>();
    for (const b of waterDemanders) {
      const need = BUILDING_DEFS[b.kind].waterDemand;
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

/** Run production/consumption for operational buildings, in id order. */
function runProduction(city: CityState): void {
  const ordered = [...city.buildings].sort((a, b) => a.id - b.id);
  for (const b of ordered) {
    if (!b.operational || b.progress < 1) continue;
    const def = BUILDING_DEFS[b.kind];
    const player = getPlayer(city, b.owner);
    if (!player) continue;
    const penalty = (b.powered ? 1 : UTILITY_PENALTY) * (b.watered ? 1 : UTILITY_PENALTY);
    const mult = penalty * levelMult(b);
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
      const gain = (def.output[key] ?? 0) * mult;
      if (gain > 0) addStock(player, key, gain);
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
function runTaxes(city: CityState, economyTickIndex: number): void {
  if (economyTickIndex % TAX_PERIOD_ECONOMY_TICKS !== 0) return;
  for (const b of city.buildings) {
    if (b.progress < 1 || !b.operational) continue;
    const def = BUILDING_DEFS[b.kind];
    if (def.zone === UTILITY_ZONE) continue;
    const player = getPlayer(city, b.owner);
    if (!player) continue;
    const rate = player.taxRates[def.zone] as number;
    player.funds += rate * def.taxBasePerSec * levelMult(b) * TAX_PERIOD_SECONDS;
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
  runConstruction(city);
  const { powerHeadroom, waterHeadroom } = allocateUtilities(city);
  runProduction(city);
  runFood(city);
  runTaxes(city, economyTickIndex(world));
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
}
