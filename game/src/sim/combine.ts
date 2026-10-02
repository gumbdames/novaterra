/**
 * sim/combine.ts — the Vostok Combine (fun-audit Tier 4, E3, 2026-10-02).
 *
 * The fantasy: war is expensive, and somewhere offshore there's a
 * freighter full of shells that doesn't care about your politics. "A
 * Combine freighter is holding offshore. Premium prices, no questions."
 * Top up ammo before the big push — or watch the Kestrel buy too, and
 * realize what *they're* planning.
 *
 * MERCHANT-ONLY. There is deliberately NO raid in 0.1 Alpha — no raid
 * code, no raid stubs, no raid hooks (the plan's dead end §6.3). The
 * freighter is a pure merchant: it arrives, it sells, it leaves. The
 * shared `neutralNonCombatant` gate (sim/units.ts) makes it
 * untargetable and unattackable — the same one code path as the envoy
 * and the luminary guests.
 *
 * Mechanics:
 *   - `world.combine`: the visit state machine —
 *     'away' → 'inbound' → 'anchored' → 'departing' → 'away'.
 *   - Seeded schedule on the rng `combine` stream: first visit at tick
 *     14,400 ± 3,600 (~8 min ± 2), then every 21,600–32,400
 *     (12–18 min). A 60-s Muse warning + map ping fires on the inbound
 *     leg (UI-side, from the state transition).
 *   - The freighter (`combineFreighter`, sea, NEUTRAL_OWNER,
 *     `artBase: 'cargoFreighter'` — zero new art) spawns at the map
 *     edge over water, sails to an anchorage (water near the player's
 *     capital; if none exists the visit is skipped and rescheduled),
 *     and anchors for 3 min (5,400 ticks).
 *   - While anchored, the Trade panel sells (`combineBuy`):
 *     materials / fuel / food / research / ammo at 2× market rate with
 *     a ±15% seeded per-visit drift — insultingly small quantities,
 *     offensively high prices, so the Phase-3 logistics chain stays the
 *     primary economy and the Combine stays the emergency valve.
 *     Ammo (6 funds/u) fills the player's buildings' ammoStock (capped
 *     by effectiveAmmoStorage). NO sell-back — the Combine only sells.
 *   - The Combine also buys influence (`combineBuyInfluence`): 8 funds
 *     → +1 influence, cap 100 per visit — a funds/influence sink.
 *   - Anti-cheese: the Combine's 2× ask is far above the market's 1.2×
 *     buy price, and there is no sell-back, so no buy-low/sell-high
 *     loop exists (pinned by test).
 *   - The tell: while anchored, if the AI (commander+) is war-planning
 *     (offensive telegraphed or active), is ammo-starved, and has
 *     funds, it buys Combine ammo — and the UI reports it ("Kestrel
 *     logistics just bought Combine shells. Draw your own conclusions.").
 *     The AI's logistics become readable intent.
 *
 * This module value-imports from `./city`, `./units`, `./rng`,
 * `./market`, `./movement`, and `./terrain` — it joins the sim-core
 * import cycle (documented in scripts/check-import-cycles.mjs), like
 * the other ceremony systems. The per-tick system
 * (`createCombineSystem`) is registered in ui/session.ts after the
 * luminary system.
 *
 * Determinism: schedule, drift, and stock draws come from the named
 * `combine` RNG stream; deadlines are tick-based; no wall-clock; no
 * banned Math.* (only integer arithmetic and comparisons here).
 */

import { getPlayer, capitalCenter } from './city';
import { createRngBank } from './rng';
import { MARKET_PRICES, type MarketResource } from './market';
import {
  spawnUnit,
  NEUTRAL_OWNER,
} from './units';
import { orderMoveTo } from './movement';
import { isWater, type TerrainData } from './terrain';
import { detCos, detSin } from './deterministic';
import { effectiveAmmoStorage } from './upgrades';
import { BUILDING_DEFS } from './city';
import type { World } from './world';
import type { CommandQueue } from './commands';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** First visit: ~8 min (the plan's "tick + 14400 ± 3600"). */
export const COMBINE_FIRST_VISIT_TICKS = 14400;
export const COMBINE_FIRST_VISIT_JITTER = 3600;
/** Revisit interval: 12–18 min (the plan's "every 21600–32400"). */
export const COMBINE_REVISIT_MIN = 21600;
export const COMBINE_REVISIT_SPAN = 10800;
/** Anchorage duration: 3 min (the plan's "anchors 3 min"). */
export const COMBINE_ANCHORED_TICKS = 5400;
/** Warning lead: 60 s of freighter travel before arrival. */
export const COMBINE_WARNING_LEAD_TICKS = 1800;
/** Price multiplier: 2× market (the plan's "2× market rate"). */
export const COMBINE_PRICE_MULT = 2;
/** Per-visit price drift: ±15% (the plan's "±15% seeded drift"). */
export const COMBINE_DRIFT = 0.15;
/** Ammo price: flat 6 funds/u (the plan's "ammo 6 funds/u"). */
export const COMBINE_AMMO_PRICE = 6;
/** Influence price: 8 funds → +1 (the plan's "8 funds each"). */
export const COMBINE_INFLUENCE_PRICE = 8;
/** Influence cap per visit (the plan's "cap 100/visit"). */
export const COMBINE_INFLUENCE_CAP = 100;
/** Per-visit stock caps (the plan's "300/200/200/50/150"). */
export const COMBINE_STOCK_CAPS = {
  materials: 300,
  fuel: 200,
  food: 200,
  research: 50,
  ammo: 150,
} as const;
/** The AI tell: buys when virtual ammo is below this. */
export const COMBINE_AI_AMMO_LOW = 200;
/** The AI tell: how much ammo it buys (one purchase per visit). */
export const COMBINE_AI_BUY_AMOUNT = 100;
/** Map-edge inset for the freighter's entry/exit (world units). */
export const COMBINE_EDGE_INSET = 10;
/** Arrival radius: within this of the anchorage counts as anchored. */
export const COMBINE_ARRIVE_RADIUS = 12;
/** Departure watchdog: despawn even if the exit sail stalls (3 min). */
export const COMBINE_DEPART_TIMEOUT_TICKS = 5400;
/** Anchorage search radius (world units, spiral). */
export const COMBINE_ANCHOR_SEARCH_RADIUS = 120;
/** Human owner id (player-side commerce in 0.1 Alpha). */
const COMBINE_OWNER = 0;
/** AI owner id (the tell). */
const COMBINE_AI_OWNER = 1;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The visit state machine. */
export type CombineVisitState = 'away' | 'inbound' | 'anchored' | 'departing';

/** Per-visit stock (materials/fuel/food/research/ammo). */
export interface CombineStock {
  materials: number;
  fuel: number;
  food: number;
  research: number;
  ammo: number;
}

/** Plain combine state: snapshotted + digested (AD9). */
export interface CombineState {
  state: CombineVisitState;
  /** The freighter's unit id (0 when away). */
  unitId: number;
  /** world.tick at which the next visit begins. */
  nextVisitTick: number;
  /** world.tick at which the freighter anchors (0 when not inbound). */
  anchoredUntilTick: number;
  anchorX: number;
  anchorZ: number;
  /** Per-visit price drift in [-0.15, +0.15]. */
  priceDrift: number;
  stock: CombineStock;
  /** Influence sold this visit (cap 100). */
  influenceSold: number;
  /** The AI bought ammo this visit (for the tell narration). */
  aiBuy: boolean;
  /** True once the 60-s warning has fired for this visit. */
  warned: boolean;
  /** Departure deadline (watchdog). */
  departByTick: number;
}

/** Fresh combine state; the first visit is scheduled from the seed. */
export function initCombine(seed: number): CombineState {
  const bank = createRngBank(seed, {});
  const jitter = Math.floor(
    (bank.next('combine') - 0.5) * 2 * COMBINE_FIRST_VISIT_JITTER,
  );
  return {
    state: 'away',
    unitId: 0,
    nextVisitTick: Math.max(0, COMBINE_FIRST_VISIT_TICKS + jitter),
    anchoredUntilTick: 0,
    anchorX: 0,
    anchorZ: 0,
    priceDrift: 0,
    stock: { materials: 0, fuel: 0, food: 0, research: 0, ammo: 0 },
    influenceSold: 0,
    aiBuy: false,
    warned: false,
    departByTick: 0,
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** Combine resources (the market four + ammo). */
export type CombineResource = MarketResource | 'ammo';

/** All buyable resources in UI order. */
export const COMBINE_RESOURCES: CombineResource[] = [
  'materials',
  'fuel',
  'food',
  'research',
  'ammo',
];

/**
 * Funds per unit of `resource` this visit: 2× market × (1 + drift),
 * or the flat 6 for ammo. Drift is per-visit (one price level).
 */
export function combineUnitPrice(state: CombineState, resource: CombineResource): number {
  if (resource === 'ammo') return COMBINE_AMMO_PRICE;
  const market = MARKET_PRICES[resource];
  return market * COMBINE_PRICE_MULT * (1 + state.priceDrift);
}

/** Funds for `amount` units (rounded up — the Combine rounds up). */
export function combineBuyCost(state: CombineState, resource: CombineResource, amount: number): number {
  return Math.ceil(combineUnitPrice(state, resource) * amount);
}

// ---------------------------------------------------------------------------
// Visit mechanics (system)
// ---------------------------------------------------------------------------

/** Spiral-search for water near (x, z); null when none in radius. */
function siteWaterCell(
  terrain: TerrainData,
  x: number,
  z: number,
  maxRadius: number,
): { x: number; z: number } | null {
  const half = 1000; // map half-size in world units (the city.ts convention)
  const clamp = (v: number): number => Math.max(-half + 5, Math.min(half - 5, v));
  if (isWater(terrain, clamp(x), clamp(z))) return { x: clamp(x), z: clamp(z) };
  for (let r = 8; r <= maxRadius; r += 8) {
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      const wx = clamp(x + r * detCos(angle));
      const wz = clamp(z + r * detSin(angle));
      if (isWater(terrain, wx, wz)) return { x: wx, z: wz };
    }
  }
  return null;
}

/**
 * Schedule the next visit from `fromTick`: 21,600–32,400 ticks out,
 * drawn on the `combine` stream.
 */
function scheduleNextVisit(world: World, fromTick: number): void {
  const bank = createRngBank(world.seed, world.rng);
  const wait =
    COMBINE_REVISIT_MIN + Math.floor(bank.next('combine') * (COMBINE_REVISIT_SPAN + 1));
  world.combine.nextVisitTick = fromTick + wait;
}

/** Draw the per-visit price drift (±15%) on the `combine` stream. */
function drawPriceDrift(world: World): number {
  const bank = createRngBank(world.seed, world.rng);
  return (bank.next('combine') - 0.5) * 2 * COMBINE_DRIFT;
}

/** Start a visit: spawn the freighter at the map edge over water. */
function startVisit(world: World, terrain: TerrainData): void {
  const c = world.combine;
  // Anchorage: water near the player's capital. None → skip this
  // visit (reschedule) — the freighter never beaches.
  const capital = capitalCenter(world, COMBINE_OWNER);
  const anchor = siteWaterCell(terrain, capital.x, capital.z, COMBINE_ANCHOR_SEARCH_RADIUS);
  if (!anchor) {
    scheduleNextVisit(world, world.tick);
    return;
  }
  // Entry: the map edge over water nearest the anchorage (seeded pick
  // of the nearest watery edge point — deterministic).
  const half = 1000;
  const edgeX = anchor.x >= 0 ? half - COMBINE_EDGE_INSET : -half + COMBINE_EDGE_INSET;
  const spawn = siteWaterCell(terrain, edgeX, anchor.z, 200) ?? { x: edgeX, z: anchor.z };
  const unit = spawnUnit(world, 'combineFreighter', NEUTRAL_OWNER, spawn.x, spawn.z);
  orderMoveTo(world, unit, anchor.x, anchor.z);
  c.state = 'inbound';
  c.unitId = unit.id;
  c.anchorX = anchor.x;
  c.anchorZ = anchor.z;
  c.anchoredUntilTick = 0;
  c.priceDrift = drawPriceDrift(world);
  c.stock = { ...COMBINE_STOCK_CAPS };
  c.influenceSold = 0;
  c.aiBuy = false;
  c.warned = false;
  c.departByTick = 0;
}

/** Remove the freighter quietly (departure, not death). */
function removeFreighter(world: World): void {
  const c = world.combine;
  const idx = world.units.findIndex((u) => u.id === c.unitId);
  if (idx >= 0) world.units.splice(idx, 1);
  c.unitId = 0;
}

/** True when the AI is war-planning: an offensive telegraphed or active. */
function aiWarPlanning(world: World): boolean {
  const ai = world.ai?.players?.find((p) => p.owner === COMBINE_AI_OWNER);
  const off = ai?.offensive;
  if (!off) return false;
  return off.telegraphed === true || (off.activePhase ?? 0) > 0;
}

/** True when the AI's difficulty is commander or higher. */
function aiIsCommanderPlus(world: World): boolean {
  const ai = world.ai?.players?.find((p) => p.owner === COMBINE_AI_OWNER);
  return ai?.difficulty === 'commander' || ai?.difficulty === 'general' || ai?.difficulty === 'marshal';
}

/**
 * The tell: while anchored, a commander+ AI that is war-planning,
 * ammo-starved, and funded buys Combine ammo — once per visit. The
 * UI narrates `aiBuy` ("Kestrel logistics just bought Combine
 * shells. Draw your own conclusions.").
 */
function maybeAiBuy(world: World): void {
  const c = world.combine;
  if (c.aiBuy || c.stock.ammo <= 0) return;
  if (!aiIsCommanderPlus(world) || !aiWarPlanning(world)) return;
  const ai = world.ai.players.find((p) => p.owner === COMBINE_AI_OWNER);
  if (!ai) return;
  const ammoLow = (ai.virtualAmmoStock ?? 0) < COMBINE_AI_AMMO_LOW;
  if (!ammoLow) return;
  const player = getPlayer(world.city, COMBINE_AI_OWNER);
  const amount = Math.min(COMBINE_AI_BUY_AMOUNT, c.stock.ammo);
  const cost = amount * COMBINE_AMMO_PRICE;
  if (!player || player.funds < cost) return;
  player.funds -= cost;
  ai.virtualAmmoStock = (ai.virtualAmmoStock ?? 0) + amount;
  c.stock.ammo -= amount;
  c.aiBuy = true;
}

/**
 * The combine system: the visit state machine. Registered in
 * ui/session.ts after the luminary system.
 */
export function createCombineSystem(terrain: TerrainData): (world: World) => void {
  return (world: World): void => {
    const c = world.combine;
    if (!c) return;
    const unit = world.units.find((u) => u.id === c.unitId);

    if (c.state === 'away') {
      if (world.tick >= c.nextVisitTick) startVisit(world, terrain);
      return;
    }

    // The freighter is gone (shouldn't happen — neutral, unattackable)
    // → abort the visit and reschedule.
    if (!unit) {
      c.state = 'away';
      c.unitId = 0;
      scheduleNextVisit(world, world.tick);
      return;
    }

    if (c.state === 'inbound') {
      const dx = unit.x - c.anchorX;
      const dz = unit.z - c.anchorZ;
      const distSq = dx * dx + dz * dz;
      // 60-s warning: once within 60 s of travel of the anchorage.
      if (!c.warned) {
        const speed = unit.speed > 0 ? unit.speed : 1;
        const secsOut = Math.sqrt(distSq) / speed / 30;
        if (secsOut <= COMBINE_WARNING_LEAD_TICKS / 30) c.warned = true;
      }
      if (distSq <= COMBINE_ARRIVE_RADIUS * COMBINE_ARRIVE_RADIUS) {
        c.state = 'anchored';
        c.anchoredUntilTick = world.tick + COMBINE_ANCHORED_TICKS;
        c.warned = true;
      }
      return;
    }

    if (c.state === 'anchored') {
      maybeAiBuy(world);
      if (world.tick >= c.anchoredUntilTick) {
        // Depart: sail back to the map edge over water.
        const half = 1000;
        const edgeX = c.anchorX >= 0 ? half - COMBINE_EDGE_INSET : -half + COMBINE_EDGE_INSET;
        const exit = siteWaterCell(terrain, edgeX, c.anchorZ, 200) ?? { x: edgeX, z: c.anchorZ };
        orderMoveTo(world, unit, exit.x, exit.z);
        c.state = 'departing';
        c.departByTick = world.tick + COMBINE_DEPART_TIMEOUT_TICKS;
      }
      return;
    }

    if (c.state === 'departing') {
      const half = 1000;
      const out =
        Math.abs(unit.x) >= half - COMBINE_EDGE_INSET - 2 ||
        world.tick >= c.departByTick;
      if (out) {
        removeFreighter(world);
        c.state = 'away';
        scheduleNextVisit(world, world.tick);
      }
      return;
    }
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/** Validate a combine purchase (shared by combineBuy/validate). */
function validateBuy(
  world: World,
  owner: number,
  resource: unknown,
  amount: unknown,
): string | null {
  if (owner !== COMBINE_OWNER) {
    return 'combineBuy: only the player can trade with the Combine';
  }
  const c = world.combine;
  if (c.state !== 'anchored') {
    return 'combineBuy: the Combine freighter is not anchored';
  }
  if (typeof resource !== 'string' || !(COMBINE_RESOURCES as readonly string[]).includes(resource)) {
    return `combineBuy: resource must be one of ${COMBINE_RESOURCES.join(', ')}`;
  }
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    return 'combineBuy: amount must be a positive integer';
  }
  const res = resource as CombineResource;
  if ((c.stock[res] ?? 0) < amount) {
    return `combineBuy: the Combine has only ${c.stock[res] ?? 0} ${res} left this visit`;
  }
  const player = getPlayer(world.city, owner);
  if (!player) return 'combineBuy: unknown owner';
  const cost = combineBuyCost(c, res, amount);
  if (player.funds < cost) {
    return `combineBuy: cannot afford ${cost} funds (have ${Math.floor(player.funds)})`;
  }
  if (res === 'ammo') {
    // Ammo needs somewhere to go: buildings' ammoStock headroom.
    let room = 0;
    for (const b of world.city.buildings) {
      if (b.owner !== owner || b.progress < 1) continue;
      const def = BUILDING_DEFS[b.kind as keyof typeof BUILDING_DEFS];
      if (!def) continue;
      room += Math.max(0, effectiveAmmoStorage(world, owner, def) - (b.ammoStock ?? 0));
    }
    if (room < amount) {
      return `combineBuy: your depots have room for only ${room} ammo`;
    }
  }
  return null;
}

/** Register the `combineBuy` + `combineBuyInfluence` commands. */
export function registerCombineCommands(queue: CommandQueue): void {
  queue.register('combineBuy', {
    validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null) return 'combineBuy: payload.owner must be an integer';
      return validateBuy(world, owner, cmd.payload['resource'], cmd.payload['amount']);
    },
    apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
      const owner = cmd.payload['owner'] as number;
      const resource = cmd.payload['resource'] as CombineResource;
      const amount = cmd.payload['amount'] as number;
      const err = validateBuy(world, owner, resource, amount);
      if (err) throw new Error(err);
      const c = world.combine;
      const player = getPlayer(world.city, owner);
      if (!player) throw new Error('combineBuy: unknown owner at apply');
      const cost = combineBuyCost(c, resource, amount);
      player.funds -= cost;
      c.stock[resource] -= amount;
      if (resource === 'ammo') {
        // Fill depots' ammoStock headroom, id order (deterministic).
        let left = amount;
        const depots = world.city.buildings
          .filter((b) => b.owner === owner && b.progress >= 1)
          .sort((a, b) => a.id - b.id);
        for (const b of depots) {
          if (left <= 0) break;
          const def = BUILDING_DEFS[b.kind as keyof typeof BUILDING_DEFS];
          if (!def) continue;
          const room = Math.max(0, effectiveAmmoStorage(world, owner, def) - (b.ammoStock ?? 0));
          const put = Math.min(room, left);
          if (put > 0) {
            b.ammoStock = (b.ammoStock ?? 0) + put;
            left -= put;
          }
        }
      } else {
        const stocks = player as unknown as Record<string, number>;
        stocks[resource] = (stocks[resource] ?? 0) + amount;
      }
      return { resource, amount, cost };
    },
  });

  queue.register('combineBuyInfluence', {
    validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null) return 'combineBuyInfluence: payload.owner must be an integer';
      if (owner !== COMBINE_OWNER) {
        return 'combineBuyInfluence: only the player can trade with the Combine';
      }
      const c = world.combine;
      if (c.state !== 'anchored') {
        return 'combineBuyInfluence: the Combine freighter is not anchored';
      }
      const amount = cmd.payload['amount'];
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
        return 'combineBuyInfluence: amount must be a positive integer';
      }
      if (c.influenceSold + amount > COMBINE_INFLUENCE_CAP) {
        return `combineBuyInfluence: the Combine sells at most ${COMBINE_INFLUENCE_CAP} influence per visit (${c.influenceSold} sold)`;
      }
      const player = getPlayer(world.city, owner);
      if (!player) return 'combineBuyInfluence: unknown owner';
      const cost = amount * COMBINE_INFLUENCE_PRICE;
      if (player.funds < cost) {
        return `combineBuyInfluence: cannot afford ${cost} funds (have ${Math.floor(player.funds)})`;
      }
      return null;
    },
    apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
      const owner = cmd.payload['owner'] as number;
      const amount = cmd.payload['amount'] as number;
      const c = world.combine;
      const player = getPlayer(world.city, owner);
      if (!player) throw new Error('combineBuyInfluence: unknown owner at apply');
      // Re-check at apply (state may have changed since enqueue).
      if (c.state !== 'anchored') throw new Error('combineBuyInfluence: the freighter sailed at apply time');
      if (c.influenceSold + amount > COMBINE_INFLUENCE_CAP) {
        throw new Error('combineBuyInfluence: influence cap reached at apply time');
      }
      const cost = amount * COMBINE_INFLUENCE_PRICE;
      if (player.funds < cost) throw new Error('combineBuyInfluence: cannot afford at apply time');
      player.funds -= cost;
      player.influence += amount;
      c.influenceSold += amount;
      return { amount, cost };
    },
  });
}

// ---------------------------------------------------------------------------
// Snapshot + digest (AD9)
// ---------------------------------------------------------------------------

/** Canonical JSON-safe encoding for snapshots (additive — no version bump). */
export function encodeCombineState(c: CombineState): unknown {
  return {
    state: c.state,
    unitId: c.unitId,
    nextVisitTick: c.nextVisitTick,
    anchoredUntilTick: c.anchoredUntilTick,
    anchorX: c.anchorX,
    anchorZ: c.anchorZ,
    priceDrift: c.priceDrift,
    stock: { ...c.stock },
    influenceSold: c.influenceSold,
    aiBuy: c.aiBuy,
    warned: c.warned,
    departByTick: c.departByTick,
  };
}

/** Restore from a snapshot payload; legacy snapshots decode to fresh. */
export function decodeCombineState(data: unknown, seed: number): CombineState {
  const fresh = initCombine(seed);
  if (typeof data !== 'object' || data === null) return fresh;
  const d = data as Record<string, unknown>;
  const num = (v: unknown, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fb;
  const states: CombineVisitState[] = ['away', 'inbound', 'anchored', 'departing'];
  const state = d['state'];
  fresh.state = typeof state === 'string' && (states as readonly string[]).includes(state)
    ? (state as CombineVisitState)
    : 'away';
  fresh.unitId = Math.floor(num(d['unitId'], 0));
  fresh.nextVisitTick = Math.floor(num(d['nextVisitTick'], fresh.nextVisitTick));
  fresh.anchoredUntilTick = Math.floor(num(d['anchoredUntilTick'], 0));
  fresh.anchorX = num(d['anchorX'], 0);
  fresh.anchorZ = num(d['anchorZ'], 0);
  const drift = num(d['priceDrift'], 0);
  fresh.priceDrift = Math.max(-COMBINE_DRIFT, Math.min(COMBINE_DRIFT, drift));
  const stock = d['stock'];
  if (typeof stock === 'object' && stock !== null) {
    const s = stock as Record<string, unknown>;
    for (const k of COMBINE_RESOURCES) {
      const v = s[k];
      (fresh.stock as unknown as Record<string, number>)[k] =
        typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
    }
  }
  fresh.influenceSold = Math.floor(num(d['influenceSold'], 0));
  fresh.aiBuy = d['aiBuy'] === true;
  fresh.warned = d['warned'] === true;
  fresh.departByTick = Math.floor(num(d['departByTick'], 0));
  return fresh;
}
