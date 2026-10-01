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
 * NOVATERRA — cost-efficiency balance tests (roadmap A7, 2026-10-01).
 *
 * The spectre (pre-rebalance: 75 dmg / 45 ticks, 300 funds, 20 materials)
 * was a ~2.5x DPS-per-fund outlier: 50 DPS for ~340 funds-equiv =
 * 0.147 DPS/fund vs the tank band's 0.058. The rebalance set
 * damage 60 / trainFunds 450 (40 DPS for ~490 funds-equiv = 0.082
 * DPS/fund, ~1.4x the tank band — a fair premium for genuine stealth,
 * speed 12, and foundation-age availability).
 *
 * These tests pin the rebalanced numbers and fail loudly if a future
 * stat change re-opens the outlier gap. DPS = damage/cooldownTicks *
 * TICK_HZ; funds-equiv = trainFunds + trainMaterials * materials market
 * price (the canonical cross-resource conversion in sim/market.ts).
 */

import { describe, expect, it } from 'vitest';
import { UNIT_DEFS } from '../src/sim/units';
import { TICK_HZ } from '../src/sim/tick';
import { MARKET_PRICES } from '../src/sim/market';

function rawDps(kind: keyof typeof UNIT_DEFS): number {
  const def = UNIT_DEFS[kind];
  return (def.damage / def.cooldownTicks) * TICK_HZ;
}

function fundsEquiv(kind: keyof typeof UNIT_DEFS): number {
  const def = UNIT_DEFS[kind];
  return def.trainFunds + def.trainMaterials * MARKET_PRICES.materials;
}

function dpsPerFund(kind: keyof typeof UNIT_DEFS): number {
  return rawDps(kind) / fundsEquiv(kind);
}

describe('A7: spectre cost-efficiency rebalance', () => {
  it('pins the rebalanced spectre stats (damage 60, trainFunds 450)', () => {
    const spectre = UNIT_DEFS.spectre;
    expect(spectre.damage).toBe(60);
    expect(spectre.cooldownTicks).toBe(45);
    expect(spectre.trainFunds).toBe(450);
    expect(spectre.trainMaterials).toBe(20);
    // Identity preserved: stealthy fast foundation-age raider.
    expect(spectre.stealth).toBe(true);
    expect(spectre.speed).toBe(12);
    expect(spectre.minAge).toBe('foundation');
  });

  it('lands the spectre at ~0.082 DPS/fund, not the 0.147 outlier', () => {
    // 40 DPS for ~490 funds-equiv = 0.0816 DPS/fund.
    expect(rawDps('spectre')).toBeCloseTo(40, 6);
    expect(fundsEquiv('spectre')).toBe(490);
    expect(dpsPerFund('spectre')).toBeCloseTo(0.0816, 4);
  });

  it('stays within the tank band guard (<=1.6x the tank DPS/fund)', () => {
    const tank = dpsPerFund('tank');
    const spectre = dpsPerFund('spectre');
    // The old outlier ratio was ~2.5x (0.147/0.058); the rebalance
    // targets ~1.4x. The 1.6x ceiling gives design slack without
    // re-opening the outlier gap.
    expect(spectre).toBeLessThanOrEqual(tank * 1.6);
    // Sanity: the reference anchors are where the rebalance assumed.
    expect(tank).toBeCloseTo(0.0577, 4); // 30 DPS / 520 funds-equiv
    expect(dpsPerFund('artillery')).toBeCloseTo(0.0467, 4); // 28.5 / 610
  });
});
