/**
 * sim/luminaries.ts — the Luminary system (fun-audit Tier 4, E2, 2026-10-02).
 *
 * The fantasy: once per age, someone remarkable walks into your capital and
 * asks for an audience — a defecting scientist, a war hero, a whistleblower,
 * a tycoon with a suspicious charter, a logistics prodigy, a cartographer.
 * A real unit with a gold ring, and a presidential call with costs on both
 * sides. The drama engine the peaceful endless mode needs.
 *
 * Mechanics:
 *   - A DATA DECK of 6 event cards (`LUMINARY_DECK`). Writers add cards by
 *     adding data + a case in `applyLuminaryChoice` + an eligibility
 *     predicate — the sim logic for drawing, spawning, deadlines, and
 *     resolution never changes.
 *   - Trigger: hooked into `ages.ts` — on age advance (human owner only in
 *     0.1 Alpha), filter the deck by pure `eligibility` predicates; if none
 *     is eligible, no luminary that age (scarcity is a feature). Otherwise
 *     draw one from the rng `events` stream and spawn it as a neutral
 *     non-combatant civilian (`luminary`, owner NEUTRAL_OWNER) at the
 *     capital via `capitalCenter` (sim/envoy.ts).
 *   - `world.luminaries.pending = { cardId, unitId, deadlineTick }` —
 *     3 min (5,400 ticks) to answer via the `resolveLuminary` command;
 *     the deadline applies the card's seeded default (no punishment for
 *     slow players).
 *   - Card effects live in `applyLuminaryChoice` (the one switch writers
 *     extend). Persistent effect state (`productionMarks`, `coverUp`,
 *     `upkeepCutUntilTick`, `instructors`) is plain snapshot-covered data
 *     (AD9) and digest-covered (behavior-affecting).
 *
 * This module is deliberately a LEAF: it value-imports only from `./city`,
 * `./units`, and `./rng`, none of which imports it back. (`capitalCenter`
 * lives in city.ts, shared with the envoy system, so no luminaries→envoy
 * edge exists.) The per-tick system (`createLuminarySystem`) is
 * registered in ui/session.ts; the `advanceAge` hook in ages.ts calls
 * `maybeDrawLuminary` (ages → luminaries is acyclic).
 *
 * Determinism: card draws and the War Hero's name come from the named
 * `events` RNG stream; deadlines are tick-based; no wall-clock; no
 * banned Math.* (only integer arithmetic and comparisons here).
 */

import { getPlayer, capitalCenter, type BuildingKind } from './city';
import { createRngBank } from './rng';
import {
  spawnUnit,
  canProduceAt,
  UNIT_DEFS,
  NEUTRAL_OWNER,
  type UnitKind,
  type UnitRecord,
} from './units';
import type { World } from './world';
import type { CommandQueue } from './commands';

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/** Decision window: 3 minutes (the plan's "3 min = 5,400 ticks"). */
export const LUMINARY_DECISION_TICKS = 5400;
/** Defector "turn": enemy production stays marked for 90 s. */
export const DEFECTOR_MARK_TICKS = 2700;
/** Whistleblower cover-up: the leak lands 5 minutes after the choice. */
export const COVERUP_LEAK_TICKS = 9000;
/** Logistics Prodigy "streamline": upkeep cut lasts 5 minutes. */
export const UPKEEP_CUT_TICKS = 9000;
/** Streamline multiplier: −25% building upkeep. */
export const UPKEEP_CUT_MULT = 0.75;
/** Drill instructor's XP aura radius (world units). */
export const DRILL_AURA_RADIUS = 20;
/** Drill instructor's XP multiplier: +50% kill XP in the aura. */
export const DRILL_XP_MULT = 1.5;
/** Max enemy production buildings marked by one Defector turning. */
export const DEFECTOR_MAX_MARKS = 6;
/** Human owner id (city.ts convention: 0 = human, 1 = AI rival). Player-side only in 0.1 Alpha. */
const LUMINARY_OWNER = 0;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Card ids — the data deck's primary keys. */
export type LuminaryCardId =
  | 'defector'
  | 'warHero'
  | 'whistleblower'
  | 'tycoon'
  | 'logisticsProdigy'
  | 'cartographer';

/** One pending presidential decision. */
export interface PendingLuminaryDecision {
  cardId: LuminaryCardId;
  /** The spawned guest unit (kind `luminary`, NEUTRAL_OWNER). */
  unitId: number;
  /** The visited player (0 in 0.1 Alpha). */
  owner: number;
  /** world.tick at which the card's default choice applies. */
  deadlineTick: number;
}

/** An enemy production building revealed by a turned Defector. */
export interface ProductionMark {
  buildingId: number;
  untilTick: number;
}

/** A buried Whistleblower story, waiting to leak (or not). */
export interface LuminaryCoverUp {
  leakAtTick: number;
}

/** A retired war hero, now teaching. */
export interface DrillInstructor {
  unitId: number;
  owner: number;
  name: string;
}

/** How the last Whistleblower cover-up ended (null = none yet). */
export type CoverUpOutcome = 'buried' | 'leaked';

/** Plain luminary state: snapshotted + digested (AD9). */
export interface LuminariesState {
  pending: PendingLuminaryDecision | null;
  productionMarks: ProductionMark[];
  coverUp: LuminaryCoverUp | null;
  /** world.tick until which building upkeep is cut (0 = no cut). */
  upkeepCutUntilTick: number;
  instructors: DrillInstructor[];
  /** Outcome of the most recent cover-up leak (for narration). */
  lastCoverUpOutcome: CoverUpOutcome | null;
}

/** Fresh luminary state. */
export function initLuminaries(): LuminariesState {
  return {
    pending: null,
    productionMarks: [],
    coverUp: null,
    upkeepCutUntilTick: 0,
    instructors: [],
    lastCoverUpOutcome: null,
  };
}

// ---------------------------------------------------------------------------
// The data deck
// ---------------------------------------------------------------------------

/**
 * One choice on a card. `id` is the command payload value; the human-
 * readable label/hint live in ui/strings.ts (English-only, loc
 * indirection) keyed by `cardId:choiceId`.
 */
export interface LuminaryChoiceDef {
  id: string;
}

/**
 * One event card. `eligibility` is a pure predicate on (world, owner) —
 * each card needs its own headless test with a constructed world (the
 * plan's steelman warning). Writers add a card here + a case in
 * `applyLuminaryChoice`; nothing else changes.
 */
export interface LuminaryCardDef {
  id: LuminaryCardId;
  eligibility: (world: World, owner: number) => boolean;
  choices: LuminaryChoiceDef[];
  /** Applied when the 3-minute deadline passes unanswered. */
  defaultChoiceId: string;
}

/** True while the owner is at war (not peaceful, no ceasefire holding). */
function isAtWar(world: World): boolean {
  if (world.peaceful) return false;
  return world.diplomacy.ceasefireUntilTick <= world.tick;
}

/** True when the owner fields a Veteran+ (vetLevel ≥ 2) unit. */
function hasVeteran(world: World, owner: number): boolean {
  for (const u of world.units) {
    if (u.owner === owner && u.hp > 0 && (u.vetLevel ?? 0) >= 2) return true;
  }
  return false;
}

/** True when the owner holds at least 4 completed buildings. */
function hasBuildings(world: World, owner: number, n: number): boolean {
  let count = 0;
  for (const b of world.city.buildings) {
    if (b.owner === owner && b.progress >= 1 && ++count >= n) return true;
  }
  return false;
}

/**
 * The 6-card deck for 0.1 Alpha. Order is fixed (data, not draw order —
 * the draw picks by index from the eligible subset).
 */
export const LUMINARY_DECK: LuminaryCardDef[] = [
  {
    id: 'defector',
    eligibility: (world) => isAtWar(world),
    choices: [{ id: 'turn' }, { id: 'interrogate' }, { id: 'trial' }],
    defaultChoiceId: 'interrogate',
  },
  {
    id: 'warHero',
    eligibility: (world, owner) => hasVeteran(world, owner),
    choices: [{ id: 'retire' }, { id: 'keep' }],
    defaultChoiceId: 'keep',
  },
  {
    id: 'whistleblower',
    eligibility: (world, owner) => (getPlayer(world.city, owner)?.funds ?? 0) >= 500,
    choices: [{ id: 'transparency' }, { id: 'coverUp' }],
    defaultChoiceId: 'coverUp',
  },
  {
    id: 'tycoon',
    eligibility: (world, owner) => (getPlayer(world.city, owner)?.funds ?? 0) < 8000,
    choices: [{ id: 'sign' }, { id: 'expose' }],
    defaultChoiceId: 'expose',
  },
  {
    id: 'logisticsProdigy',
    eligibility: (world, owner) => hasBuildings(world, owner, 4),
    choices: [{ id: 'streamline' }, { id: 'publish' }],
    defaultChoiceId: 'streamline',
  },
  {
    id: 'cartographer',
    // The fallback card: always eligible, so the peaceful endless mode
    // gets its heartbeat (once per age at most — still scarce).
    eligibility: () => true,
    choices: [{ id: 'chart' }, { id: 'sell' }],
    defaultChoiceId: 'chart',
  },
];

/** Look up a card by id (undefined for unknown — defensive, like the UI). */
export function luminaryCardById(id: string): LuminaryCardDef | undefined {
  return LUMINARY_DECK.find((c) => c.id === id);
}

/**
 * Seeded name list for retired war heroes turned drill instructors.
 * Drawn from the `events` stream when the "retire" choice applies.
 */
export const LUMINARY_NAMES = [
  'A. Reyes', 'D. Okafor', 'M. Haddad', 'S. Petrova', 'J. Lindqvist',
  'K. Tanaka', 'R. Alvarez', 'T. Novak', 'E. Cohen', 'L. Ferrari',
  'N. Hassan', 'P. Kowalski', 'Y. Sato', 'G. Papadopoulos', 'F. Ndiaye',
  'H. Johansson', 'C. Mbeki', 'V. Sokolov', 'I. Goldstein', 'B. Adebayo',
];

// ---------------------------------------------------------------------------
// Draw (called from the advanceAge hook)
// ---------------------------------------------------------------------------

/**
 * Maybe draw a luminary for `owner` on age advance. Player-side only in
 * 0.1 Alpha (owner 0); at most one pending decision at a time; if no
 * card is eligible, no luminary that age — scarcity is a feature.
 * The draw comes from the rng `events` stream (seeded, deterministic).
 */
export function maybeDrawLuminary(world: World, owner: number): void {
  if (owner !== LUMINARY_OWNER) return;
  const lum = world.luminaries;
  if (!lum || lum.pending !== null) return;
  const eligible = LUMINARY_DECK.filter((c) => {
    try {
      return c.eligibility(world, owner);
    } catch {
      return false;
    }
  });
  if (eligible.length === 0) return;
  const bank = createRngBank(world.seed, world.rng);
  const pick = eligible[Math.floor(bank.next('events') * eligible.length)];
  if (!pick) return; // unreachable: eligible is non-empty and the index is in range
  // Spawn the guest at the capital — a neutral non-combatant civilian.
  // (spawnUnit's command-layer validator rejects neutral kinds, but the
  // direct call is the scripted-spawn path, like the envoy's.)
  const capital = capitalCenter(world, owner);
  const unit = spawnUnit(world, 'luminary', NEUTRAL_OWNER, capital.x + 4, capital.z + 4);
  lum.pending = {
    cardId: pick.id,
    unitId: unit.id,
    owner,
    deadlineTick: world.tick + LUMINARY_DECISION_TICKS,
  };
}

// ---------------------------------------------------------------------------
// Choice effects (the one switch writers extend)
// ---------------------------------------------------------------------------

/** Remove a unit by id without death effects (departure, retirement). */
function removeUnitQuietly(world: World, unitId: number): void {
  const idx = world.units.findIndex((u) => u.id === unitId);
  if (idx >= 0) world.units.splice(idx, 1);
}

/** Find a unit by id (undefined when gone). */
function findUnit(world: World, unitId: number): UnitRecord | undefined {
  return world.units.find((u) => u.id === unitId);
}

/**
 * Enemy production buildings: completed, enemy-owned, able to produce
 * at least one unit kind. Capped and id-ordered (deterministic).
 */
function enemyProductionBuildings(world: World, owner: number): { id: number }[] {
  const out: { id: number }[] = [];
  for (const b of world.city.buildings) {
    if (b.owner === owner || b.owner === NEUTRAL_OWNER || b.progress < 1) continue;
    if (isProductionKind(b.kind)) out.push({ id: b.id });
  }
  out.sort((a, b) => a.id - b.id);
  return out.slice(0, DEFECTOR_MAX_MARKS);
}

/** True when a building kind can train at least one unit kind. */
const productionKindCache = new Map<string, boolean>();
function isProductionKind(buildingKind: string): boolean {
  const cached = productionKindCache.get(buildingKind);
  if (cached !== undefined) return cached;
  let result = false;
  for (const kind of Object.keys(UNIT_DEFS)) {
    const def = UNIT_DEFS[kind as UnitKind];
    if (def && canProduceAt(buildingKind as BuildingKind, def)) {
      result = true;
      break;
    }
  }
  productionKindCache.set(buildingKind, result);
  return result;
}

/**
 * Apply one luminary choice. Called by the `resolveLuminary` command and
 * by the deadline path — one code path for answer/timeout (the envoy
 * precedent). All amounts are the plan's §4 numbers.
 */
export function applyLuminaryChoice(world: World, cardId: LuminaryCardId, choiceId: string): void {
  const lum = world.luminaries;
  const owner = lum.pending?.owner ?? LUMINARY_OWNER;
  const player = getPlayer(world.city, owner);
  const bank = createRngBank(world.seed, world.rng);

  switch (cardId) {
    case 'defector': {
      if (choiceId === 'turn') {
        if (player) player.intel.surveillance += 200;
        const untilTick = world.tick + DEFECTOR_MARK_TICKS;
        for (const b of enemyProductionBuildings(world, owner)) {
          lum.productionMarks.push({ buildingId: b.id, untilTick });
        }
      } else if (choiceId === 'interrogate') {
        if (player) player.research += 150;
      } else if (choiceId === 'trial') {
        if (player) player.influence += 100;
        world.diplomacy.disposition = Math.max(0, world.diplomacy.disposition - 10);
      }
      break;
    }
    case 'warHero': {
      if (choiceId === 'retire') {
        // The most decorated veteran retires (highest vetLevel, tie: lowest id).
        let vet: UnitRecord | undefined;
        for (const u of world.units) {
          if (u.owner !== owner || u.hp <= 0 || (u.vetLevel ?? 0) < 2) continue;
          if (!vet || (u.vetLevel ?? 0) > (vet.vetLevel ?? 0)) vet = u;
        }
        if (vet) {
          removeUnitQuietly(world, vet.id);
          const capital = capitalCenter(world, owner);
          const instructor = spawnUnit(world, 'drillInstructor', owner, capital.x - 4, capital.z - 4);
          const nameIdx = Math.floor(bank.next('events') * LUMINARY_NAMES.length);
          const name = LUMINARY_NAMES[nameIdx] ?? 'A. Reyes';
          lum.instructors.push({ unitId: instructor.id, owner, name });
        }
      } else if (choiceId === 'keep') {
        if (player) player.influence += 50;
      }
      break;
    }
    case 'whistleblower': {
      if (choiceId === 'transparency') {
        if (player) {
          player.funds = Math.max(0, player.funds - 500);
          player.influence += 150;
        }
      } else if (choiceId === 'coverUp') {
        lum.coverUp = { leakAtTick: world.tick + COVERUP_LEAK_TICKS };
      }
      break;
    }
    case 'tycoon': {
      if (choiceId === 'sign') {
        if (player) {
          player.funds += 3000;
          player.influence = Math.max(0, player.influence - 15);
        }
      } else if (choiceId === 'expose') {
        if (player) player.influence += 120;
        world.diplomacy.disposition = Math.min(100, world.diplomacy.disposition + 5);
      }
      break;
    }
    case 'logisticsProdigy': {
      if (choiceId === 'streamline') {
        lum.upkeepCutUntilTick = world.tick + UPKEEP_CUT_TICKS;
      } else if (choiceId === 'publish') {
        if (player) player.research += 150;
      }
      break;
    }
    case 'cartographer': {
      if (choiceId === 'chart') {
        if (player) player.intel.surveillance += 120;
      } else if (choiceId === 'sell') {
        if (player) player.funds += 800;
      }
      break;
    }
  }
}

/**
 * Building upkeep multiplier for `owner` from the Prodigy's streamline
 * (1.0 when no cut is active). Read by economy.ts in the upkeep
 * funding + charge passes.
 */
export function getLuminaryUpkeepMult(world: World, owner: number): number {
  const lum = world.luminaries;
  if (!lum || owner !== LUMINARY_OWNER) return 1.0;
  return world.tick < lum.upkeepCutUntilTick ? UPKEEP_CUT_MULT : 1.0;
}

/**
 * Kill-XP multiplier for `owner`'s unit at (x, z): 1.5 while a living
 * drill instructor of that owner is in aura range, else 1.0. Read by
 * veterancy.ts `awardKillXp`.
 */
export function getDrillInstructorXpMult(world: World, owner: number, x: number, z: number): number {
  const lum = world.luminaries;
  if (!lum || lum.instructors.length === 0) return 1.0;
  const r2 = DRILL_AURA_RADIUS * DRILL_AURA_RADIUS;
  for (const ins of lum.instructors) {
    if (ins.owner !== owner) continue;
    const u = findUnit(world, ins.unitId);
    if (!u || u.hp <= 0) continue;
    const dx = u.x - x;
    const dz = u.z - z;
    if (dx * dx + dz * dz <= r2) return DRILL_XP_MULT;
  }
  return 1.0;
}

/** Resolve a pending decision: apply the choice, dismiss the guest. */
function resolvePending(world: World, choiceId: string): void {
  const lum = world.luminaries;
  const pending = lum.pending;
  if (!pending) return;
  applyLuminaryChoice(world, pending.cardId, choiceId);
  removeUnitQuietly(world, pending.unitId);
  lum.pending = null;
}

// ---------------------------------------------------------------------------
// Per-tick system
// ---------------------------------------------------------------------------

/**
 * The luminary system: deadline → seeded default; cover-up leak
 * resolution; prune expired production marks and dead instructors.
 * Registered in ui/session.ts after the envoy system (both are
 * ceremony systems; order between them is irrelevant — they touch
 * disjoint state).
 */
export function createLuminarySystem(): (world: World) => void {
  return (world: World): void => {
    const lum = world.luminaries;
    if (!lum) return;
    // 1. Answer deadline → the card's default choice.
    const pending = lum.pending;
    if (pending !== null && world.tick >= pending.deadlineTick) {
      const card = luminaryCardById(pending.cardId);
      resolvePending(world, card?.defaultChoiceId ?? 'chart');
    }
    // 2. Cover-up leak: counter-intel > 100 buries it, else −200 influence.
    //    (The check runs at leak time so building counter-intel after the
    //    choice still saves you — the card teaches the stockpile's value.)
    const coverUp = lum.coverUp;
    if (coverUp !== null && world.tick >= coverUp.leakAtTick) {
      lum.coverUp = null;
      const player = getPlayer(world.city, LUMINARY_OWNER);
      const counterIntel = player?.intel?.counterIntel ?? 0;
      if (counterIntel <= 100 && player) {
        player.influence = Math.max(0, player.influence - 200);
        lum.lastCoverUpOutcome = 'leaked';
      } else {
        lum.lastCoverUpOutcome = 'buried';
      }
    }
    // 3. Prune expired production marks (id-ordered, deterministic).
    if (lum.productionMarks.length > 0) {
      lum.productionMarks = lum.productionMarks.filter((m) => {
        if (world.tick >= m.untilTick) return false;
        // Drop marks whose building is gone (id reuse never happens —
        // building ids come from world.nextId, like units).
        return world.city.buildings.some((b) => b.id === m.buildingId);
      });
    }
    // 4. Prune instructors whose unit is gone.
    if (lum.instructors.length > 0) {
      lum.instructors = lum.instructors.filter((ins) => {
        const u = findUnit(world, ins.unitId);
        return u !== undefined && u.hp > 0;
      });
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

/** Register the `resolveLuminary` command. */
export function registerLuminaryCommands(queue: CommandQueue): void {
  queue.register('resolveLuminary', {
    validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
      const owner = payloadInt(cmd.payload, 'owner');
      if (owner === null) return 'resolveLuminary: payload.owner must be an integer';
      const choiceId = cmd.payload['choiceId'];
      if (typeof choiceId !== 'string' || choiceId.length === 0) {
        return 'resolveLuminary: payload.choiceId must be a non-empty string';
      }
      const pending = world.luminaries.pending;
      if (pending === null) return 'resolveLuminary: no luminary awaits your decision';
      if (pending.owner !== owner) {
        return 'resolveLuminary: only the visited player can answer the luminary';
      }
      const card = luminaryCardById(pending.cardId);
      if (!card) return 'resolveLuminary: unknown luminary card';
      if (!card.choices.some((c) => c.id === choiceId)) {
        return `resolveLuminary: ${pending.cardId} has no choice '${choiceId}'`;
      }
      return null;
    },
    apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
      const pending = world.luminaries.pending;
      // Re-check at apply (the decision may have resolved since enqueue).
      if (pending === null) {
        throw new Error('resolveLuminary: the luminary is gone at apply time');
      }
      const owner = cmd.payload['owner'] as number;
      if (pending.owner !== owner) {
        throw new Error('resolveLuminary: only the visited player can answer the luminary');
      }
      const choiceId = cmd.payload['choiceId'] as string;
      resolvePending(world, choiceId);
      return { cardId: pending.cardId, choiceId };
    },
  });
}

// ---------------------------------------------------------------------------
// Snapshot + digest (AD9)
// ---------------------------------------------------------------------------

/** Canonical JSON-safe encoding for snapshots (additive — no version bump). */
export function encodeLuminariesState(lum: LuminariesState): unknown {
  return {
    pending: lum.pending ? { ...lum.pending } : null,
    productionMarks: lum.productionMarks.map((m) => ({ ...m })),
    coverUp: lum.coverUp ? { ...lum.coverUp } : null,
    upkeepCutUntilTick: lum.upkeepCutUntilTick,
    instructors: lum.instructors.map((i) => ({ ...i })),
    lastCoverUpOutcome: lum.lastCoverUpOutcome,
  };
}

/** Restore from a snapshot payload; legacy snapshots decode to fresh. */
export function decodeLuminariesState(data: unknown): LuminariesState {
  const fresh = initLuminaries();
  if (typeof data !== 'object' || data === null) return fresh;
  const d = data as Record<string, unknown>;
  const num = (v: unknown, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fb;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  if (typeof d['pending'] === 'object' && d['pending'] !== null) {
    const p = d['pending'] as Record<string, unknown>;
    const card = luminaryCardById(str(p['cardId']));
    if (card) {
      fresh.pending = {
        cardId: card.id,
        unitId: num(p['unitId'], 0),
        owner: num(p['owner'], LUMINARY_OWNER),
        deadlineTick: num(p['deadlineTick'], 0),
      };
    }
  }
  if (Array.isArray(d['productionMarks'])) {
    for (const m of d['productionMarks']) {
      if (typeof m === 'object' && m !== null) {
        const mm = m as Record<string, unknown>;
        fresh.productionMarks.push({
          buildingId: num(mm['buildingId'], 0),
          untilTick: num(mm['untilTick'], 0),
        });
      }
    }
  }
  if (typeof d['coverUp'] === 'object' && d['coverUp'] !== null) {
    fresh.coverUp = {
      leakAtTick: num((d['coverUp'] as Record<string, unknown>)['leakAtTick'], 0),
    };
  }
  fresh.upkeepCutUntilTick = num(d['upkeepCutUntilTick'], 0);
  const outcome = d['lastCoverUpOutcome'];
  fresh.lastCoverUpOutcome = outcome === 'buried' || outcome === 'leaked' ? outcome : null;
  if (Array.isArray(d['instructors'])) {
    for (const i of d['instructors']) {
      if (typeof i === 'object' && i !== null) {
        const ii = i as Record<string, unknown>;
        fresh.instructors.push({
          unitId: num(ii['unitId'], 0),
          owner: num(ii['owner'], LUMINARY_OWNER),
          name: str(ii['name']),
        });
      }
    }
  }
  return fresh;
}
