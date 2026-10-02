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
 * NOVATERRA — sim/market.ts tests (roadmap B24).
 *
 * market.ts is the last untested pure sim module: the fixed-price market
 * the economy and the Classic AI's virtual economy price materials, fuel,
 * food, and research through. These tests pin the price table, the
 * buy/sell spread math (a buy-then-sell round trip returns exactly 2/3),
 * and the no-arbitrage invariant that keeps the AI's virtual ledger
 * honest.
 */
import { describe, expect, it } from 'vitest';

import {
  MARKET_PRICES,
  MARKET_SPREAD,
  MarketResource,
  marketBuyCost,
  marketSellValue,
} from '../src/sim/market';

describe('sim/market price table', () => {
  it('prices every market resource (funds is the numeraire, never listed)', () => {
    expect(Object.keys(MARKET_PRICES).sort()).toEqual([
      MarketResource.FOOD,
      MarketResource.FUEL,
      MarketResource.MATERIALS,
      MarketResource.RESEARCH,
    ]);
    for (const price of Object.values(MARKET_PRICES)) {
      expect(price).toBeGreaterThan(0);
    }
  });

  it('pins the fixed Phase-1 prices', () => {
    expect(MARKET_PRICES).toEqual({
      materials: 2,
      fuel: 3,
      food: 1,
      research: 12,
    });
  });

  it('spread is 20%', () => {
    expect(MARKET_SPREAD).toBe(0.2);
  });
});

describe('marketBuyCost / marketSellValue', () => {
  it('buying costs (1 + spread) × price', () => {
    expect(marketBuyCost('materials', 10)).toBeCloseTo(10 * 2 * 1.2, 9);
    expect(marketBuyCost('fuel', 5)).toBeCloseTo(5 * 3 * 1.2, 9);
  });

  it('selling pays (1 − spread) × price', () => {
    expect(marketSellValue('materials', 10)).toBeCloseTo(10 * 2 * 0.8, 9);
    expect(marketSellValue('research', 2)).toBeCloseTo(2 * 12 * 0.8, 9);
  });

  it('a buy-then-sell round trip returns exactly 2/3 of the funds', () => {
    for (const resource of Object.keys(MARKET_PRICES) as MarketResource[]) {
      const bought = marketBuyCost(resource, 100);
      const sold = marketSellValue(resource, 100);
      expect(sold / bought).toBeCloseTo(2 / 3, 9);
    }
  });

  it('zero amount costs nothing either way', () => {
    expect(marketBuyCost('fuel', 0)).toBe(0);
    expect(marketSellValue('fuel', 0)).toBe(0);
  });
});
