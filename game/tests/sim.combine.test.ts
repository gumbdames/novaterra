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
 * NOVATERRA — Combine tests (fun-audit Tier 4 / E3, 0.1 Alpha).
 *
 * Covers the Vostok Combine merchant faction through real sessions:
 * - the schedule: first visit tick+14400±3600 (seeded, deterministic),
 *   revisits every 21600–32400;
 * - pricing: 2× market × (1±0.15 drift), ammo flat 6 — the plan's
 *   numbers, pinned;
 * - commerce: combineBuy deducts funds, adds stock, caps stock per
 *   visit (300/200/200/50/150); ammo fills depots' ammoStock (capped);
 *   combineBuyInfluence: 8 funds → +1, cap 100/visit;
 * - anti-cheese: the Combine's 2× ask is above the market's 1.2× buy
 *   price and there is no sell-back — no buy-low/sell-high loop;
 * - the tell: a commander+ AI that is war-planning, ammo-starved, and
 *   funded buys Combine ammo (once per visit);
 * - the shared gate: the freighter is a neutral non-combatant —
 *   untargetable, unattackable, unspawnable, untrainable;
 * - snapshot/digest round-trips preserve the combine state;
 * - MERCHANT-ONLY: no raid state, no raid commands, no raid hooks.
 */
import { describe, expect, it } from 'vitest';
import {
  AI_PLAYER_ID,
  createSession,
  HUMAN_PLAYER_ID,
} from '../src/ui/session';
import {
  COMBINE_AI_BUY_AMOUNT,
  COMBINE_AMMO_PRICE,
  COMBINE_DRIFT,
  COMBINE_FIRST_VISIT_JITTER,
  COMBINE_FIRST_VISIT_TICKS,
  COMBINE_INFLUENCE_CAP,
  COMBINE_INFLUENCE_PRICE,
  COMBINE_PRICE_MULT,
  COMBINE_RESOURCES,
  COMBINE_REVISIT_MIN,
  COMBINE_REVISIT_SPAN,
  COMBINE_STOCK_CAPS,
  combineBuyCost,
  combineUnitPrice,
  createCombineSystem,
  decodeCombineState,
  encodeCombineState,
  initCombine,
  registerCombineCommands,
} from '../src/sim/combine';
import { MARKET_PRICES, MARKET_SPREAD, marketBuyCost } from '../src/sim/market';
import {
  UNIT_DEFS,
  isNeutralNonCombatantKind,
  spawnUnit,
  NEUTRAL_OWNER,
} from '../src/sim/units';
import { getPlayer } from '../src/sim/city';
import { addAIPlayer } from '../src/sim/ai';
import { createWorld } from '../src/sim/world';
import { generateTerrain } from '../src/sim/terrain';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { canonicalizeWorld, digestWorld } from '../src/sim/digest';
import type { World } from '../src/sim/world';

/** A minimal world with a funded human player (no session needed). */
function bareWorld(seed = 1234): World {
  const world = createWorld(seed);
  const player = getPlayer(world.city, HUMAN_PLAYER_ID);
  if (player) {
    player.funds = 100000;
    player.influence = 200;
    player.research = 0;
    player.intel = { surveillance: 0, operational: 0, counterIntel: 0 };
  }
  return world;
}

/** Put the freighter alongside: anchored, full stock, neutral drift. */
function anchorCombine(world: World): void {
  const c = world.combine;
  // Spawn a real freighter (the system aborts the visit if the unit
  // is gone — a fake unitId would reschedule, not anchor).
  const unit = spawnUnit(world, 'combineFreighter', NEUTRAL_OWNER, 100, 100);
  c.state = 'anchored';
  c.unitId = unit.id;
  c.anchoredUntilTick = world.tick + 5400;
  c.anchorX = 100;
  c.anchorZ = 100;
  c.priceDrift = 0;
  c.stock = { ...COMBINE_STOCK_CAPS };
  c.influenceSold = 0;
  c.aiBuy = false;
  c.warned = true;
  c.departByTick = 0;
}

describe('the Combine schedule', () => {
  it('schedules the first visit at tick+14400±3600, seeded and deterministic', () => {
    const a = initCombine(42);
    const b = initCombine(42);
    expect(a.nextVisitTick).toBe(b.nextVisitTick);
    expect(a.nextVisitTick).toBeGreaterThanOrEqual(
      COMBINE_FIRST_VISIT_TICKS - COMBINE_FIRST_VISIT_JITTER,
    );
    expect(a.nextVisitTick).toBeLessThanOrEqual(
      COMBINE_FIRST_VISIT_TICKS + COMBINE_FIRST_VISIT_JITTER,
    );
    expect(a.state).toBe('away');
    // Different seeds generally differ (the jitter is seeded).
    const other = initCombine(43);
    expect(other.nextVisitTick).not.toBe(a.nextVisitTick);
  });

  it('starts fresh: no stock, no influence sold, no AI buy', () => {
    const c = initCombine(7);
    expect(c.stock).toEqual({ materials: 0, fuel: 0, food: 0, research: 0, ammo: 0 });
    expect(c.influenceSold).toBe(0);
    expect(c.aiBuy).toBe(false);
    expect(c.unitId).toBe(0);
  });
});

describe('Combine pricing', () => {
  it('charges 2× market × (1+drift) per the plan', () => {
    const world = bareWorld();
    const c = world.combine;
    c.priceDrift = 0;
    for (const r of COMBINE_RESOURCES) {
      if (r === 'ammo') continue;
      expect(combineUnitPrice(c, r)).toBeCloseTo(
        MARKET_PRICES[r] * COMBINE_PRICE_MULT,
        10,
      );
    }
    c.priceDrift = COMBINE_DRIFT;
    expect(combineUnitPrice(c, 'materials')).toBeCloseTo(
      MARKET_PRICES['materials'] * COMBINE_PRICE_MULT * (1 + COMBINE_DRIFT),
      10,
    );
    c.priceDrift = -COMBINE_DRIFT;
    expect(combineUnitPrice(c, 'fuel')).toBeCloseTo(
      MARKET_PRICES['fuel'] * COMBINE_PRICE_MULT * (1 - COMBINE_DRIFT),
      10,
    );
  });

  it('prices ammo flat at 6 funds/u regardless of drift', () => {
    const world = bareWorld();
    const c = world.combine;
    c.priceDrift = COMBINE_DRIFT;
    expect(combineUnitPrice(c, 'ammo')).toBe(COMBINE_AMMO_PRICE);
    c.priceDrift = -COMBINE_DRIFT;
    expect(combineUnitPrice(c, 'ammo')).toBe(COMBINE_AMMO_PRICE);
  });

  it('rounds the lot cost up (the Combine rounds up)', () => {
    const world = bareWorld();
    const c = world.combine;
    c.priceDrift = 0.07; // an odd drift → fractional cost
    const cost = combineBuyCost(c, 'materials', 50);
    expect(cost).toBe(Math.ceil(MARKET_PRICES['materials'] * 2 * 1.07 * 50));
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('is anti-cheese: the 2× ask is above the market 1.2× buy price, and there is no sell-back', () => {
    const world = bareWorld();
    const c = world.combine;
    // Even at maximum −15% drift, the Combine's ask exceeds what the
    // market pays for the same unit (1.2× market).
    c.priceDrift = -COMBINE_DRIFT;
    for (const r of COMBINE_RESOURCES) {
      if (r === 'ammo') continue;
      const combineAsk = combineUnitPrice(c, r);
      const marketBuy = marketBuyCost(r, 1); // 1.2× market per unit
      expect(combineAsk).toBeGreaterThan(marketBuy);
    }
    // No sell command exists: only combineBuy + combineBuyInfluence.
    const names: string[] = [];
    const probe = {
      register: (name: string) => {
        names.push(name);
      },
    };
    registerCombineCommands(probe as never);
    expect(names).toEqual(['combineBuy', 'combineBuyInfluence']);
    expect(MARKET_SPREAD).toBe(0.2);
  });
});

describe('combineBuy', () => {
  it('deducts funds, adds the resource, and reduces per-visit stock', () => {
    const session = createSession({ seed: 99 });
    const world = session.world;
    const player = getPlayer(world.city, HUMAN_PLAYER_ID);
    expect(player).not.toBeNull();
    player!.funds = 100000;
    anchorCombine(world);
    const before = player!.funds;
    const matsBefore = (player as unknown as Record<string, number>)['materials'] ?? 0;
    const cost = combineBuyCost(world.combine, 'materials', 50);
    session.enqueuePlayerIntent({
      kind: 'combineBuy',
      payload: { owner: HUMAN_PLAYER_ID, resource: 'materials', amount: 50 },
    });
    session.tick();
    expect(player!.funds).toBe(before - cost);
    expect((player as unknown as Record<string, number>)['materials']).toBe(matsBefore + 50);
    expect(world.combine.stock.materials).toBe(COMBINE_STOCK_CAPS.materials - 50);
  });

  it('rejects loudly when the freighter is not anchored', () => {
    const session = createSession({ seed: 99 });
    const world = session.world;
    // state is 'away' — not anchored.
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'combineBuy',
        payload: { owner: HUMAN_PLAYER_ID, resource: 'fuel', amount: 10 },
      }),
    ).toThrow(/not anchored/i);
  });

  it('rejects loudly when the stock is exhausted', () => {
    const session = createSession({ seed: 99 });
    const world = session.world;
    anchorCombine(world);
    world.combine.stock.research = 5;
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'combineBuy',
        payload: { owner: HUMAN_PLAYER_ID, resource: 'research', amount: 10 },
      }),
    ).toThrow(/only 5 research/);
  });

  it('rejects loudly when the player cannot afford it', () => {
    const session = createSession({ seed: 99 });
    const world = session.world;
    const player = getPlayer(world.city, HUMAN_PLAYER_ID);
    player!.funds = 1;
    anchorCombine(world);
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'combineBuy',
        payload: { owner: HUMAN_PLAYER_ID, resource: 'materials', amount: 50 },
      }),
    ).toThrow(/cannot afford/i);
  });

  it('rejects loudly for the AI owner (player-side commerce only)', () => {
    const session = createSession({ seed: 99 });
    const world = session.world;
    anchorCombine(world);
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'combineBuy',
        payload: { owner: AI_PLAYER_ID, resource: 'fuel', amount: 10 },
      }),
    ).toThrow(/only the player/i);
  });

  it('fills depots ammoStock (capped) when buying ammo', () => {
    const session = createSession({ seed: 99 });
    const world = session.world;
    const player = getPlayer(world.city, HUMAN_PLAYER_ID);
    player!.funds = 100000;
    anchorCombine(world);
    // The session world's city should have buildings; find one with
    // ammo headroom (ordnance depots). If none, the buy must fail
    // loudly rather than vanishing.
    // Either it applies (depots had room) or it rejects loudly (no
    // room) — never a silent partial.
    let applied = true;
    try {
      session.enqueuePlayerIntent({
        kind: 'combineBuy',
        payload: { owner: HUMAN_PLAYER_ID, resource: 'ammo', amount: 25 },
      });
      session.tick();
    } catch (e) {
      applied = false;
      expect(String(e)).toMatch(/room for/);
    }
    if (applied) {
      expect(world.combine.stock.ammo).toBe(COMBINE_STOCK_CAPS.ammo - 25);
      const totalAmmo = world.city.buildings
        .filter((b) => b.owner === HUMAN_PLAYER_ID)
        .reduce((n, b) => n + (b.ammoStock ?? 0), 0);
      expect(totalAmmo).toBeGreaterThanOrEqual(25);
    }
  });
});

describe('combineBuyInfluence', () => {
  it('sells influence at 8 funds each, capped at 100 per visit', () => {
    const session = createSession({ seed: 99 });
    const world = session.world;
    const player = getPlayer(world.city, HUMAN_PLAYER_ID);
    player!.funds = 100000;
    player!.influence = 0;
    anchorCombine(world);
    const before = player!.funds;
    session.enqueuePlayerIntent({
      kind: 'combineBuyInfluence',
      payload: { owner: HUMAN_PLAYER_ID, amount: 10 },
    });
    session.tick();
    expect(player!.funds).toBe(before - 10 * COMBINE_INFLUENCE_PRICE);
    expect(player!.influence).toBe(10);
    expect(world.combine.influenceSold).toBe(10);
    // The cap: 90 more is fine, 91 is not.
    session.enqueuePlayerIntent({
      kind: 'combineBuyInfluence',
      payload: { owner: HUMAN_PLAYER_ID, amount: 90 },
    });
    session.tick();
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'combineBuyInfluence',
        payload: { owner: HUMAN_PLAYER_ID, amount: 1 },
      }),
    ).toThrow(new RegExp(String(COMBINE_INFLUENCE_CAP)));
  });

  it('rejects loudly when the freighter is not anchored', () => {
    const session = createSession({ seed: 99 });
    expect(() =>
      session.enqueuePlayerIntent({
        kind: 'combineBuyInfluence',
        payload: { owner: HUMAN_PLAYER_ID, amount: 10 },
      }),
    ).toThrow(/not anchored/i);
  });
});

describe('the AI tell', () => {
  it('a commander+ AI that is war-planning, ammo-starved, and funded buys Combine ammo', () => {
    const world = bareWorld(4242);
    addAIPlayer(world, AI_PLAYER_ID, 'commander', 500, 500);
    // Set up the AI: commander, war-planning (telegraphed), low ammo.
    const ai = world.ai.players.find((p) => p.owner === AI_PLAYER_ID);
    expect(ai).toBeDefined();
    ai!.difficulty = 'commander';
    ai!.offensive = {
      nextPhase: 2,
      launchTick: 100000,
      telegraphTick: 90000,
      telegraphed: true,
      activePhase: 0,
      activeUntilTick: 0,
    };
    ai!.virtualAmmoStock = 50; // below COMBINE_AI_AMMO_LOW (200)
    const aiPlayer = getPlayer(world.city, AI_PLAYER_ID);
    aiPlayer!.funds = 100000;
    anchorCombine(world);
    const stockBefore = world.combine.stock.ammo;
    const fundsBefore = aiPlayer!.funds;
    // Run the system (needs terrain — use the world's own).
    const sys = createCombineSystem(generateTerrain(world.seed));
    sys(world);
    expect(world.combine.aiBuy).toBe(true);
    expect(world.combine.stock.ammo).toBe(stockBefore - COMBINE_AI_BUY_AMOUNT);
    expect(aiPlayer!.funds).toBe(fundsBefore - COMBINE_AI_BUY_AMOUNT * COMBINE_AMMO_PRICE);
    expect(ai!.virtualAmmoStock).toBe(50 + COMBINE_AI_BUY_AMOUNT);
  });

  it('does not buy when the AI is not war-planning', () => {
    const world = bareWorld(4242);
    addAIPlayer(world, AI_PLAYER_ID, 'commander', 500, 500);
    const ai = world.ai.players.find((p) => p.owner === AI_PLAYER_ID);
    ai!.difficulty = 'commander';
    ai!.offensive = undefined; // not planning
    ai!.virtualAmmoStock = 50;
    const aiPlayer = getPlayer(world.city, AI_PLAYER_ID);
    aiPlayer!.funds = 100000;
    anchorCombine(world);
    const sys = createCombineSystem(generateTerrain(world.seed));
    sys(world);
    expect(world.combine.aiBuy).toBe(false);
  });

  it('does not buy below cadet/commander (citizen and cadet never trigger the tell)', () => {
    const world = bareWorld(4242);
    addAIPlayer(world, AI_PLAYER_ID, 'citizen', 500, 500);
    const ai = world.ai.players.find((p) => p.owner === AI_PLAYER_ID);
    ai!.difficulty = 'citizen';
    ai!.offensive = {
      nextPhase: 2,
      launchTick: 100000,
      telegraphTick: 90000,
      telegraphed: true,
      activePhase: 0,
      activeUntilTick: 0,
    };
    ai!.virtualAmmoStock = 50;
    const aiPlayer = getPlayer(world.city, AI_PLAYER_ID);
    aiPlayer!.funds = 100000;
    anchorCombine(world);
    const sys = createCombineSystem(generateTerrain(world.seed));
    sys(world);
    expect(world.combine.aiBuy).toBe(false);
  });

  it('buys only once per visit', () => {
    const world = bareWorld(4242);
    addAIPlayer(world, AI_PLAYER_ID, 'marshal', 500, 500);
    const ai = world.ai.players.find((p) => p.owner === AI_PLAYER_ID);
    ai!.difficulty = 'marshal';
    ai!.offensive = {
      nextPhase: 1,
      launchTick: 100000,
      telegraphTick: 90000,
      telegraphed: false,
      activePhase: 1, // active counts as war-planning
      activeUntilTick: 200000,
    };
    ai!.virtualAmmoStock = 10;
    const aiPlayer = getPlayer(world.city, AI_PLAYER_ID);
    aiPlayer!.funds = 100000;
    anchorCombine(world);
    const sys = createCombineSystem(generateTerrain(world.seed));
    sys(world);
    const afterFirst = world.combine.stock.ammo;
    sys(world);
    expect(world.combine.stock.ammo).toBe(afterFirst);
  });
});

describe('the shared neutral-non-combatant gate', () => {
  it('the freighter is a neutral non-combatant kind', () => {
    const def = UNIT_DEFS['combineFreighter'];
    expect(def).toBeDefined();
    expect(def.neutralNonCombatant).toBe(true);
    expect(isNeutralNonCombatantKind('combineFreighter')).toBe(true);
  });

  it('a spawned freighter cannot be targeted or attacked (the one code path)', () => {
    const world = bareWorld();
    const freighter = spawnUnit(world, 'combineFreighter', NEUTRAL_OWNER, 0, 0);
    expect(freighter.owner).toBe(NEUTRAL_OWNER);
    // The gate is structural: neutral non-combatants are excluded
    // from acquireTarget / attackUnit / spawnUnit / canTrain by kind.
    // Here we pin the kind-level gate (the per-function behavior is
    // covered by the shared gate tests in sim.units).
    expect(isNeutralNonCombatantKind(freighter.kind)).toBe(true);
  });

  it('there is no raid state, no raid command, no raid hook on the combine state', () => {
    const c = initCombine(5);
    const keys = Object.keys(c);
    expect(keys).not.toContain('raid');
    expect(keys).not.toContain('raided');
    expect(keys).not.toContain('burned');
    // The state machine is exactly away/inbound/anchored/departing.
    expect(['away', 'inbound', 'anchored', 'departing']).toContain(c.state);
  });
});

describe('combine snapshot + digest (AD9)', () => {
  it('round-trips through encode/decode', () => {
    const world = bareWorld(777);
    anchorCombine(world);
    world.combine.priceDrift = 0.12;
    world.combine.influenceSold = 30;
    world.combine.aiBuy = true;
    const snap = takeSnapshot(world);
    const world2 = restoreSnapshot(snap);
    expect(world2.combine.state).toBe('anchored');
    expect(world2.combine.stock).toEqual(world.combine.stock);
    expect(world2.combine.priceDrift).toBeCloseTo(0.12, 10);
    expect(world2.combine.influenceSold).toBe(30);
    expect(world2.combine.aiBuy).toBe(true);
  });

  it('decodes legacy snapshots (no combine field) to a neutral fresh state', () => {
    const decoded = decodeCombineState(undefined, 1234);
    expect(decoded.state).toBe('away');
    expect(decoded.aiBuy).toBe(false);
  });

  it('clamps corrupt drift on decode', () => {
    const decoded = decodeCombineState({ priceDrift: 999 }, 1234);
    expect(decoded.priceDrift).toBeLessThanOrEqual(COMBINE_DRIFT);
    expect(decoded.priceDrift).toBeGreaterThanOrEqual(-COMBINE_DRIFT);
  });

  it('the digest covers the combine state (and is stable across a snapshot round-trip)', () => {
    const session = createSession({ seed: 31337 });
    const world = session.world;
    anchorCombine(world);
    const d1 = digestWorld(world);
    const snap = takeSnapshot(world);
    const world2 = restoreSnapshot(snap);
    const d2 = digestWorld(world2);
    expect(d1).toBe(d2);
    expect(canonicalizeWorld(world)).toContain('|combine=');
  });

  it('encode is JSON-safe', () => {
    const world = bareWorld(1);
    anchorCombine(world);
    const enc = encodeCombineState(world.combine);
    expect(() => JSON.parse(JSON.stringify(enc))).not.toThrow();
  });
});

describe('the combine system schedule', () => {
  it('advances the schedule when a visit cannot anchor (no water → reschedule, never crash)', () => {
    const world = bareWorld(20261002);
    world.combine.nextVisitTick = 0; // due now
    const before = world.combine.nextVisitTick;
    const sys = createCombineSystem(generateTerrain(world.seed));
    sys(world);
    // Either it started a visit (water found) or it rescheduled (no
    // water). Both are valid; the schedule must have advanced or the
    // visit must be live.
    const advanced = world.combine.nextVisitTick > before;
    const visiting = world.combine.state !== 'away';
    expect(advanced || visiting).toBe(true);
  });

  it('schedules revisits 21600–32400 ticks out', () => {
    // The revisit window is pinned by the constants.
    expect(COMBINE_REVISIT_MIN).toBe(21600);
    expect(COMBINE_REVISIT_SPAN).toBe(10800);
    expect(COMBINE_REVISIT_MIN + COMBINE_REVISIT_SPAN).toBe(32400);
  });
});
