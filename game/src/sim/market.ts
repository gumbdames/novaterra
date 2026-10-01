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
 * NOVATERRA — sim/market.ts — the fixed-rate market price list.
 *
 * A LEAF module: no sim imports, pure data + pure functions. It exists
 * so that non-economy consumers (the Classic AI's virtual economy in
 * ai.ts) can price materials without importing economy.ts — economy.ts
 * reads city.ts at module scope (SPEC_ZONE over ZoneType), and an
 * ai→economy value import completes the ai→economy→city→world→ai
 * evaluation cycle that breaks module init (final-review R1, 2026-10-01).
 * economy.ts re-exports everything here, so its public API is unchanged.
 */

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

/** Funds to buy `amount` units of a market resource. */
export function marketBuyCost(resource: MarketResource, amount: number): number {
  return amount * MARKET_PRICES[resource] * (1 + MARKET_SPREAD);
}

/** Funds received for selling `amount` units of a market resource. */
export function marketSellValue(resource: MarketResource, amount: number): number {
  return amount * MARKET_PRICES[resource] * (1 - MARKET_SPREAD);
}
