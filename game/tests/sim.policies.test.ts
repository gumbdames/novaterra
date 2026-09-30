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
 * NOVATERRA — tests/sim.policies.test.ts — grand-expansion Phase 8
 * (civilian ordinances, workstream E, 2026-09-30): the five city-wide
 * policy toggles.
 *
 * Covers:
 *  - the `setPolicy` command: loud validation (unknown owner, unknown
 *    policy, non-0/1 `on`), the 60-second upkeep runway gate on
 *    enabling, and always-free disabling,
 *  - the funding rule: policies fund AFTER buildings, in POLICY_IDS
 *    order, from the remaining affordable funds; an unfunded policy is
 *    charged nothing and its effects do not apply,
 *  - all five effects: green (amenity +2, pollution ×0.8), transit
 *    (amenity +2, ridership ×1.25, migration pull ×1.15), business
 *    (commercial funds ×1.15), nightlife (commercial funds ×1.10,
 *    −3 desirability near commercial), education (growth bonus doubled,
 *    education research ×1.25),
 *  - toggling off stops the effects,
 *  - snapshot round-trips (toggles survive, `fundedPolicies` is
 *    re-derived, legacy saves decode to {}),
 *  - the digest `|pol…=` segment (POLICY_IDS order; toggles covered,
 *    funding not) and determinism.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  createCommandQueue,
  CommandRejectedError,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import {
  BUILDING_DEFS,
  CITY_GRID_CELLS,
  POLICY_ENABLE_RUNWAY_SECS,
  POLICIES,
  POLICY_IDS,
  ZoneType,
  cellIndex,
  cellIsWater,
  educationGrowthBonus,
  getPlayer,
  placeBuilding,
  policyFunded,
  registerCityCommands,
  type CityState,
  type Placement,
  type PlayerState,
  type PolicyId,
} from '../src/sim/city';
import {
  GREEN_AMENITY_BONUS,
  GREEN_POLLUTION_SCALE,
  NIGHTLIFE_PENALTY_MAX,
  NIGHTLIFE_RADIUS_CELLS,
  TRANSIT_MIGRATION_MULT,
  TRANSIT_SUBSIDY_AMENITY_BONUS,
  cellDesirability,
  getDesirabilityModel,
  migrationPullFor,
  nightlifePenaltyForDistance,
  pollutionPenaltyForDistance,
} from '../src/sim/desirability';
import {
  BUSINESS_INCENTIVES_COMMERCIAL_MULT,
  EDUCATION_GRANTS_RESEARCH_MULT,
  NIGHTLIFE_COMMERCIAL_MULT,
  TRANSIT_RIDERSHIP_MULT,
  addStock,
  getStock,
  runEconomyTick,
} from '../src/sim/economy';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { canonicalizeWorld, digestWorld } from '../src/sim/digest';

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

function setup(seed = 606001): { terrain: TerrainData; world: World; queue: CommandQueue } {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerCityCommands(queue, terrain);
  return { terrain, world, queue };
}

function setPolicy(
  ctx: { world: World; queue: CommandQueue },
  owner: number,
  policy: string,
  on: 0 | 1,
): void {
  const cmd: Omit<NewCommand, 'issuer'> = {
    kind: 'setPolicy',
    payload: { owner, policy, on },
  };
  ctx.queue.enqueue(ctx.world, { issuer: 'player', ...cmd });
  ctx.queue.applyDue(ctx.world, ctx.world.tick);
}

function playerOf(world: World, id: number): PlayerState {
  return getPlayer(world.city, id) as PlayerState;
}

/** Toggle a policy straight onto the player record (bypasses the runway gate). */
function toggleDirect(world: World, owner: number, id: PolicyId): void {
  playerOf(world, owner).policies[id] = true;
}

// --- local placement helpers (the same shape as tests/sim.parking.test.ts) ---

function findLandRect(t: TerrainData, w: number, h: number): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error(`no ${w}x${h} land rect`);
}

function completed(city: CityState, p: Placement) {
  const b = placeBuilding(city, p);
  b.progress = 1;
  return b;
}

function paintResidential(city: CityState, x0: number, z0: number, x1: number, z1: number): void {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      city.zones.push({ cell: cellIndex(cx, cz), zone: ZoneType.RESIDENTIAL });
    }
  }
  city.zones.sort((a, b) => a.cell - b.cell);
}

describe('setPolicy validation (loud rejects)', () => {
  it('rejects an unknown owner', () => {
    const ctx = setup();
    expect(() => setPolicy(ctx, 99, 'greenInitiative', 1)).toThrow(CommandRejectedError);
    expect(() => setPolicy(ctx, 99, 'greenInitiative', 1)).toThrow(
      'setPolicy: unknown owner',
    );
  });

  it('rejects an unknown policy id', () => {
    const ctx = setup();
    playerOf(ctx.world, 0).funds = 10_000;
    expect(() => setPolicy(ctx, 0, 'nope', 1)).toThrow(
      `setPolicy: unknown policy 'nope' (must be one of ${POLICY_IDS.join(', ')})`,
    );
  });

  it('rejects a non-0/1 `on`', () => {
    const ctx = setup();
    playerOf(ctx.world, 0).funds = 10_000;
    expect(() => setPolicy(ctx, 0, 'greenInitiative', 2 as 0 | 1)).toThrow(
      'setPolicy: on must be 0 (off) or 1 (on)',
    );
  });

  it('enabling requires a 60-second upkeep runway; disabling is always free', () => {
    const ctx = setup();
    // Green Initiative upkeep 0.6/s × 60 s = 36 funds runway.
    expect(POLICY_ENABLE_RUNWAY_SECS).toBe(60);
    const need = POLICIES.greenInitiative.upkeepFundsPerSec * POLICY_ENABLE_RUNWAY_SECS;
    expect(need).toBe(36);
    playerOf(ctx.world, 0).funds = need - 1;
    expect(() => setPolicy(ctx, 0, 'greenInitiative', 1)).toThrow(
      'setPolicy: cannot afford to enable greenInitiative',
    );
    // Broke players can still turn a policy OFF.
    toggleDirect(ctx.world, 0, 'greenInitiative');
    setPolicy(ctx, 0, 'greenInitiative', 0);
    expect(playerOf(ctx.world, 0).policies['greenInitiative']).toBeUndefined();
  });

  it('enabling works with exactly the runway, and apply toggles the record', () => {
    const ctx = setup();
    const need = POLICIES.nightlife.upkeepFundsPerSec * POLICY_ENABLE_RUNWAY_SECS;
    playerOf(ctx.world, 0).funds = need;
    setPolicy(ctx, 0, 'nightlife', 1);
    expect(playerOf(ctx.world, 0).policies['nightlife']).toBe(true);
  });
});

describe('policy funding (buildings first, POLICY_IDS order)', () => {
  it('funds affordable policies in POLICY_IDS order from the remaining funds', () => {
    const ctx = setup();
    for (const id of POLICY_IDS) toggleDirect(ctx.world, 0, id);
    // Upkeeps in POLICY_IDS order: 0.6, 0.5, 0.8, 0.3, 0.4.
    // With 1.0 funds and no buildings: green (0.6 → 0.4 left), transit
    // (0.5 — skip), business (0.8 — skip), nightlife (0.3 → 0.1 left),
    // education (0.4 — skip).
    playerOf(ctx.world, 0).funds = 1.0;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(playerOf(ctx.world, 0).fundedPolicies).toEqual(['greenInitiative', 'nightlife']);
    expect(playerOf(ctx.world, 0).funds).toBeCloseTo(0.1, 9);
  });

  it('buildings always win the funding race over policies', () => {
    const ctx = setup();
    // A completed shop (upkeep 0.4) plus the green policy (0.6).
    completed(ctx.world.city, { kind: 'shop', owner: 0, cx: 10, cz: 10, facing: 0 });
    toggleDirect(ctx.world, 0, 'greenInitiative');
    // Funds cover the shop but not the policy after it.
    playerOf(ctx.world, 0).funds = BUILDING_DEFS.shop.upkeepFundsPerSec + 0.5;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(playerOf(ctx.world, 0).fundedPolicies).toEqual([]);
    expect(policyFunded(ctx.world, 0, 'greenInitiative')).toBe(false);
    // One tick later with the policy affordable, it funds.
    playerOf(ctx.world, 0).funds = BUILDING_DEFS.shop.upkeepFundsPerSec + 0.6;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(playerOf(ctx.world, 0).fundedPolicies).toEqual(['greenInitiative']);
    expect(policyFunded(ctx.world, 0, 'greenInitiative')).toBe(true);
  });

  it('an unfunded policy is charged nothing and its effects do not apply', () => {
    const ctx = setup();
    for (const id of POLICY_IDS) toggleDirect(ctx.world, 0, id);
    playerOf(ctx.world, 0).funds = 0;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(playerOf(ctx.world, 0).fundedPolicies).toEqual([]);
    for (const id of POLICY_IDS) {
      expect(policyFunded(ctx.world, 0, id)).toBe(false);
    }
    expect(playerOf(ctx.world, 0).funds).toBe(0);
  });
});

describe('policy effects', () => {
  /** One completed shop, taxes zeroed, goods stocked — the only funds flow is production. */
  function shopWorld(seed: number): { terrain: TerrainData; world: World } {
    const terrain = getTerrain();
    const world = createWorld(seed);
    completed(world.city, { kind: 'shop', owner: 0, cx: 10, cz: 10, facing: 0 });
    const player = playerOf(world, 0);
    player.funds = 10_000;
    player.taxRates = [0, 0, 0, 0];
    addStock(player, 'goods', 100);
    return { terrain, world };
  }

  /** Production that tick = net funds delta + every upkeep charged that tick. */
  function fundsProduction(world: World, terrain: TerrainData, policyUpkeep: number): number {
    const player = playerOf(world, 0);
    const before = player.funds;
    runEconomyTick(world, terrain);
    const after = player.funds;
    return after - before + BUILDING_DEFS.shop.upkeepFundsPerSec + policyUpkeep;
  }

  it('Business Incentives ×1.15 on commercial-zone funds output', () => {
    const a = shopWorld(606011);
    const b = shopWorld(606012);
    toggleDirect(a.world, 0, 'businessIncentives');
    const prodA = fundsProduction(a.world, a.terrain, POLICIES.businessIncentives.upkeepFundsPerSec);
    const prodB = fundsProduction(b.world, b.terrain, 0);
    expect(prodB).toBeGreaterThan(0);
    expect(prodA / prodB).toBeCloseTo(BUSINESS_INCENTIVES_COMMERCIAL_MULT, 9);
    expect(BUSINESS_INCENTIVES_COMMERCIAL_MULT).toBe(1.15);
  });

  it('Nightlife Ordinance ×1.10 on commercial-zone funds output, stacking with business ×1.15', () => {
    const a = shopWorld(606021);
    const b = shopWorld(606022);
    const c = shopWorld(606023);
    toggleDirect(a.world, 0, 'nightlife');
    toggleDirect(b.world, 0, 'businessIncentives');
    toggleDirect(b.world, 0, 'nightlife');
    const prodA = fundsProduction(a.world, a.terrain, POLICIES.nightlife.upkeepFundsPerSec);
    const prodB = fundsProduction(
      b.world,
      b.terrain,
      POLICIES.businessIncentives.upkeepFundsPerSec + POLICIES.nightlife.upkeepFundsPerSec,
    );
    const prodC = fundsProduction(c.world, c.terrain, 0);
    expect(prodA / prodC).toBeCloseTo(NIGHTLIFE_COMMERCIAL_MULT, 9);
    expect(NIGHTLIFE_COMMERCIAL_MULT).toBe(1.1);
    // The two stack multiplicatively.
    expect(prodB / prodC).toBeCloseTo(
      BUSINESS_INCENTIVES_COMMERCIAL_MULT * NIGHTLIFE_COMMERCIAL_MULT,
      9,
    );
  });

  it('Education Grants ×1.25 on education research output (museum)', () => {
    const mk = (seed: number): { terrain: TerrainData; world: World } => {
      const terrain = getTerrain();
      const world = createWorld(seed);
      completed(world.city, { kind: 'museum', owner: 0, cx: 10, cz: 10, facing: 0 });
      const player = playerOf(world, 0);
      player.funds = 10_000;
      player.taxRates = [0, 0, 0, 0];
      return { terrain, world };
    };
    const a = mk(606031);
    const b = mk(606032);
    toggleDirect(a.world, 0, 'educationGrants');
    const gain = (ctx: { terrain: TerrainData; world: World }): number => {
      const before = getStock(playerOf(ctx.world, 0), 'research');
      runEconomyTick(ctx.world, ctx.terrain);
      return getStock(playerOf(ctx.world, 0), 'research') - before;
    };
    const gainA = gain(a);
    const gainB = gain(b);
    expect(gainB).toBeGreaterThan(0);
    expect(gainA / gainB).toBeCloseTo(EDUCATION_GRANTS_RESEARCH_MULT, 9);
    expect(EDUCATION_GRANTS_RESEARCH_MULT).toBe(1.25);
  });

  it('Transit Subsidy ×1.25 on ridership income', () => {
    const mk = (seed: number): { terrain: TerrainData; world: World } => {
      const terrain = getTerrain();
      const world = createWorld(seed);
      completed(world.city, { kind: 'busStop', owner: 0, cx: 10, cz: 10, facing: 0 });
      const player = playerOf(world, 0);
      player.funds = 10_000;
      player.taxRates = [0, 0, 0, 0];
      return { terrain, world };
    };
    const a = mk(606041);
    const b = mk(606042);
    toggleDirect(a.world, 0, 'transitSubsidy');
    const net = (ctx: { terrain: TerrainData; world: World }, policyUpkeep: number): number => {
      const player = playerOf(ctx.world, 0);
      const before = player.funds;
      runEconomyTick(ctx.world, ctx.terrain);
      return (
        player.funds - before + BUILDING_DEFS.busStop.upkeepFundsPerSec + policyUpkeep
      );
    };
    const netA = net(a, POLICIES.transitSubsidy.upkeepFundsPerSec);
    const netB = net(b, 0);
    expect(netB).toBeCloseTo(BUILDING_DEFS.busStop.ridershipIncome ?? 0, 9);
    expect(netA / netB).toBeCloseTo(TRANSIT_RIDERSHIP_MULT, 9);
    expect(TRANSIT_RIDERSHIP_MULT).toBe(1.25);
  });

  it('Green Initiative: +2 on park and botanical garden amenity rows', () => {
    const terrain = getTerrain();
    const world = createWorld(606051);
    const { cx, cz } = findLandRect(terrain, 34, 10);
    paintResidential(world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    completed(world.city, { kind: 'park', owner: 0, cx: cx + 16, cz: cz + 2, facing: 0 });
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    playerOf(world, 0).fundedPolicies = ['greenInitiative'];
    const green = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    expect(green - base).toBe(GREEN_AMENITY_BONUS);
    expect(GREEN_AMENITY_BONUS).toBe(2);
    // The funding flip rebuilds the cached model (the key carries the
    // funded policy ids) — dropping funding drops the bonus.
    playerOf(world, 0).fundedPolicies = [];
    const dropped = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    expect(dropped).toBe(base);
  });

  it('Green Initiative: pollution penalty ×0.8', () => {
    expect(GREEN_POLLUTION_SCALE).toBe(0.8);
    for (const d of [0, 5, 10, 14]) {
      expect(pollutionPenaltyForDistance(d, GREEN_POLLUTION_SCALE)).toBeCloseTo(
        0.8 * pollutionPenaltyForDistance(d),
        12,
      );
    }
    expect(pollutionPenaltyForDistance(15, GREEN_POLLUTION_SCALE)).toBe(0);
  });

  it('Transit Subsidy: +2 on transit-stop amenity rows', () => {
    const terrain = getTerrain();
    const world = createWorld(606061);
    const { cx, cz } = findLandRect(terrain, 34, 10);
    paintResidential(world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    completed(world.city, { kind: 'busStop', owner: 0, cx: cx + 15, cz: cz + 2, facing: 0 });
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    playerOf(world, 0).fundedPolicies = ['transitSubsidy'];
    const subsidized = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    expect(subsidized - base).toBe(TRANSIT_SUBSIDY_AMENITY_BONUS);
    expect(TRANSIT_SUBSIDY_AMENITY_BONUS).toBe(2);
  });

  it('Transit Subsidy: migration pull ×1.15 (capped at 2)', () => {
    const world = createWorld(606071);
    const plain = migrationPullFor(world, 0, 0.5);
    playerOf(world, 0).fundedPolicies = ['transitSubsidy'];
    const boosted = migrationPullFor(world, 0, 0.5);
    expect(boosted).toBeCloseTo(Math.min(2, plain * TRANSIT_MIGRATION_MULT), 12);
    expect(TRANSIT_MIGRATION_MULT).toBe(1.15);
    // The cap holds at the top end.
    expect(migrationPullFor(world, 0, 1)).toBeLessThanOrEqual(2);
  });

  it('Nightlife Ordinance: −3 desirability within 8 cells of commercial buildings', () => {
    expect(NIGHTLIFE_RADIUS_CELLS).toBe(8);
    expect(NIGHTLIFE_PENALTY_MAX).toBe(3);
    expect(nightlifePenaltyForDistance(0)).toBe(-3);
    expect(nightlifePenaltyForDistance(8)).toBe(0);
    const terrain = getTerrain();
    const world = createWorld(606081);
    const { cx, cz } = findLandRect(terrain, 34, 10);
    paintResidential(world.city, cx, cz, cx + 19, cz + 7);
    const target = cellIndex(cx + 10, cz + 3);
    // A shop 5 cells east of the target (inside the 8-cell radius).
    completed(world.city, { kind: 'shop', owner: 0, cx: cx + 15, cz: cz + 3, facing: 0 });
    const base = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    playerOf(world, 0).fundedPolicies = ['nightlife'];
    const loud = cellDesirability(getDesirabilityModel(terrain, world, 0), target);
    expect(loud - base).toBeLessThan(0);
    // Toggling off removes the penalty.
    playerOf(world, 0).fundedPolicies = [];
    expect(cellDesirability(getDesirabilityModel(terrain, world, 0), target)).toBe(base);
  });

  it('Education Grants: education growth bonus doubled (0.05→0.10, cap 0.25→0.50)', () => {
    const world = createWorld(606091);
    completed(world.city, { kind: 'school', owner: 0, cx: 10, cz: 10, facing: 0 });
    completed(world.city, { kind: 'school', owner: 0, cx: 14, cz: 10, facing: 0 });
    expect(educationGrowthBonus(world, 0)).toBeCloseTo(0.1, 12);
    playerOf(world, 0).fundedPolicies = ['educationGrants'];
    expect(educationGrowthBonus(world, 0)).toBeCloseTo(0.2, 12);
    // The caps: six schools saturate both.
    for (let i = 0; i < 4; i++) {
      completed(world.city, { kind: 'school', owner: 0, cx: 20 + i * 4, cz: 10, facing: 0 });
    }
    playerOf(world, 0).fundedPolicies = [];
    expect(educationGrowthBonus(world, 0)).toBeCloseTo(0.25, 12);
    playerOf(world, 0).fundedPolicies = ['educationGrants'];
    expect(educationGrowthBonus(world, 0)).toBeCloseTo(0.5, 12);
  });

  it('toggling a policy off stops its effects', () => {
    const ctx = setup(606101);
    playerOf(ctx.world, 0).funds = 10_000;
    setPolicy(ctx, 0, 'businessIncentives', 1);
    expect(policyFunded(ctx.world, 0, 'businessIncentives')).toBe(false); // not yet ticked
    runEconomyTick(ctx.world, ctx.terrain);
    expect(policyFunded(ctx.world, 0, 'businessIncentives')).toBe(true);
    setPolicy(ctx, 0, 'businessIncentives', 0);
    expect(playerOf(ctx.world, 0).policies['businessIncentives']).toBeUndefined();
    runEconomyTick(ctx.world, ctx.terrain);
    expect(policyFunded(ctx.world, 0, 'businessIncentives')).toBe(false);
  });
});

describe('policy snapshot round-trips', () => {
  it('toggles survive; fundedPolicies is re-derived, never snapshotted', () => {
    const ctx = setup(606111);
    playerOf(ctx.world, 0).funds = 10_000;
    setPolicy(ctx, 0, 'greenInitiative', 1);
    setPolicy(ctx, 0, 'nightlife', 1);
    runEconomyTick(ctx.world, ctx.terrain);
    expect(playerOf(ctx.world, 0).fundedPolicies).toEqual(['greenInitiative', 'nightlife']);
    const snap = takeSnapshot(ctx.world);
    const world2 = restoreSnapshot(snap);
    const p2 = playerOf(world2, 0);
    expect(p2.policies['greenInitiative']).toBe(true);
    expect(p2.policies['nightlife']).toBe(true);
    // Derived state is NOT restored — the next tick recomputes it.
    expect(p2.fundedPolicies).toEqual([]);
    p2.funds = 10_000;
    runEconomyTick(world2, ctx.terrain);
    expect(playerOf(world2, 0).fundedPolicies).toEqual(['greenInitiative', 'nightlife']);
  });

  it('legacy saves (no policies key) decode to {}', () => {
    const ctx = setup(606121);
    const snap = takeSnapshot(ctx.world);
    // Simulate a pre-ordinance save: strip the policies key.
    const legacy = JSON.parse(JSON.stringify(snap)) as typeof snap;
    for (const p of legacy.city.players) {
      delete (p as Partial<PlayerState>).policies;
    }
    const world2 = restoreSnapshot(legacy);
    expect(playerOf(world2, 0).policies).toEqual({});
    expect(playerOf(world2, 0).fundedPolicies).toEqual([]);
  });
});

describe('policy digest', () => {
  it('encodes toggles in POLICY_IDS order (not toggle order)', () => {
    const ctx = setup(606131);
    playerOf(ctx.world, 0).funds = 10_000;
    // Toggle in reverse order; the digest stays canonical.
    setPolicy(ctx, 0, 'educationGrants', 1);
    setPolicy(ctx, 0, 'greenInitiative', 1);
    const digest = canonicalizeWorld(ctx.world);
    expect(digest).toContain('|pol0=greenInitiative,educationGrants;');
  });

  it('an empty toggle set encodes as an empty segment', () => {
    const ctx = setup(606141);
    expect(canonicalizeWorld(ctx.world)).toContain('|pol0=;');
    expect(canonicalizeWorld(ctx.world)).toContain('|pol1=;');
  });

  it('toggles are digested even when unfunded (funding is derived, not digested)', () => {
    const ctx = setup(606151);
    playerOf(ctx.world, 0).funds = 10_000;
    setPolicy(ctx, 0, 'transitSubsidy', 1);
    // Broke the treasury: the toggle stands but nothing funds.
    playerOf(ctx.world, 0).funds = 0;
    runEconomyTick(ctx.world, ctx.terrain);
    expect(policyFunded(ctx.world, 0, 'transitSubsidy')).toBe(false);
    expect(canonicalizeWorld(ctx.world)).toContain('|pol0=transitSubsidy;');
  });

  it('determinism: same seed + same commands ⇒ same digest', () => {
    const run = (seed: number): number => {
      const ctx = setup(seed);
      playerOf(ctx.world, 0).funds = 10_000;
      setPolicy(ctx, 0, 'greenInitiative', 1);
      setPolicy(ctx, 0, 'businessIncentives', 1);
      runEconomyTick(ctx.world, ctx.terrain);
      return digestWorld(ctx.world);
    };
    expect(run(42)).toBe(run(42));
  });
});
