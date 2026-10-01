/**
 * sim/diplomacy.ts — minimal two-player diplomacy (roadmap B3, 2026-10-02).
 *
 * Skirmish had zero diplomacy: the only way to talk to the AI was war.
 * This module adds the smallest negotiable surface —
 *
 *   - `sendTribute`    — gift funds to the AI (warms relations);
 *   - `demandTribute`  — demand funds from the AI (it accepts or refuses);
 *   - `proposeCeasefire` — ask the AI to stop attacking for a fixed
 *     window (it accepts or declines; your next attack breaks it).
 *
 * The AI answers per personality and difficulty: prouder difficulties
 * (commander+) and aggressive personalities refuse demands and decline
 * ceasefires more often; a warm disposition (built with tribute)
 * softens both. The verdicts are PURE functions of sim state — no RNG
 * draws, so replays and the deterministic contract are untouched.
 *
 * Ceasefire semantics (what "pauses AI attacks" means here):
 *   - the AI think issues no NEW attackUnit/attackBuilding orders
 *     (gated in `attacksThisThink`, ai.ts) and AI units stop
 *     opportunistically acquiring the rival's units (gated in the
 *     combat loop) while the ceasefire holds;
 *   - units already fighting finish their engagement — the engine never
 *     cancels an ongoing attack, and the ceasefire doesn't either;
 *   - a deliberate attackUnit/attackBuilding order against the rival
 *     BREAKS the ceasefire (betrayal: disposition −15).
 * Covert ops are outside the ceasefire (documented, not gated).
 *
 * Demand/ceasefire are war-game concepts: both reject loudly in
 * peaceful worlds. Sending tribute is a pure funds transfer and works
 * in peaceful games too (the disposition it builds has no military
 * effect there).
 *
 * Plain data — snapshotted + digested. One bilateral pair per world
 * (skirmish); a second pair is rejected loudly rather than silently
 * merged.
 *
 * Import discipline (R2): this module imports city by value and
 * commands/world/tick/ai by TYPE only for the type surface plus the
 * TICK_MS value. ai.ts value-imports `ceasefireActive` from here and
 * combat.ts value-imports `ceasefireActive`/`breakCeasefire`/`isAIOwner`
 * — both one-directional (nothing here value-imports ai.ts or
 * combat.ts), so no cycle.
 */
import { getPlayer } from './city';
import type { World } from './world';
import type { CommandQueue } from './commands';
import type { AIDifficulty } from './ai';
import { TICK_MS } from './tick';

/** The two sides of the tracked relationship. Set by the first command. */
export interface DiplomacyParties {
  owner: number;
  aiOwner: number;
}

/** Last AI answer, for the UI to display. */
export type DemandResult = 'accepted' | 'refused';
export type CeasefireAskResult = 'accepted' | 'declined' | 'broken';

/**
 * Plain diplomacy state. Snapshotted + digested. Legacy snapshots
 * (predating the field) decode to a neutral fresh state.
 */
export interface DiplomacyState {
  /** The tracked pair, or null before the first diplomacy command. */
  parties: DiplomacyParties | null;
  /** 0..100 warmth of the AI toward the player. 50 = neutral. */
  disposition: number;
  /** world.tick until which the AI holds fire. 0 = no ceasefire. */
  ceasefireUntilTick: number;
  /** Lifetime funds gifted player → AI. */
  totalTributeSent: number;
  /** Lifetime funds extracted AI → player via accepted demands. */
  totalTributeReceived: number;
  /** Consecutive refused demands (resets on an accepted one). */
  demandsRefused: number;
  lastDemand: DemandResult | null;
  /** Amount of the most recent demand (for the UI's answer line). */
  lastDemandAmount: number;
  lastCeasefireAsk: CeasefireAskResult | null;
}

/** Create a fresh (neutral) diplomacy state. */
export function initDiplomacy(): DiplomacyState {
  return {
    parties: null,
    disposition: 50,
    ceasefireUntilTick: 0,
    totalTributeSent: 0,
    totalTributeReceived: 0,
    demandsRefused: 0,
    lastDemand: null,
    lastDemandAmount: 0,
    lastCeasefireAsk: null,
  };
}

/** Tolerant decode: legacy/missing fields fall back to neutral values. */
export function decodeDiplomacyState(data: unknown): DiplomacyState {
  const fresh = initDiplomacy();
  if (typeof data !== 'object' || data === null) return fresh;
  const d = data as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const parties = d['parties'];
  return {
    parties:
      typeof parties === 'object' && parties !== null &&
      typeof (parties as Record<string, unknown>)['owner'] === 'number' &&
      typeof (parties as Record<string, unknown>)['aiOwner'] === 'number'
        ? {
            owner: (parties as Record<string, unknown>)['owner'] as number,
            aiOwner: (parties as Record<string, unknown>)['aiOwner'] as number,
          }
        : null,
    disposition: Math.min(100, Math.max(0, num(d['disposition'], 50))),
    ceasefireUntilTick: Math.max(0, Math.floor(num(d['ceasefireUntilTick'], 0))),
    totalTributeSent: Math.max(0, num(d['totalTributeSent'], 0)),
    totalTributeReceived: Math.max(0, num(d['totalTributeReceived'], 0)),
    demandsRefused: Math.max(0, Math.floor(num(d['demandsRefused'], 0))),
    lastDemand: d['lastDemand'] === 'accepted' || d['lastDemand'] === 'refused' ? d['lastDemand'] : null,
    lastDemandAmount: Math.max(0, num(d['lastDemandAmount'], 0)),
    lastCeasefireAsk:
      d['lastCeasefireAsk'] === 'accepted' ||
      d['lastCeasefireAsk'] === 'declined' ||
      d['lastCeasefireAsk'] === 'broken'
        ? d['lastCeasefireAsk']
        : null,
  };
}

/** Ceasefire length: 5 minutes of sim time. */
export const CEASEFIRE_MINUTES = 5;
/** Ceasefire length in ticks (TICK_HZ = 30 ⇒ 9000 ticks). */
export const CEASEFIRE_TICKS = Math.round((CEASEFIRE_MINUTES * 60 * 1000) / TICK_MS);

/** Disposition gained per 500 funds of tribute (+1/500, capped). */
export const TRIBUTE_DISPOSITION_PER_500 = 1;
export const MAX_TRIBUTE_DISPOSITION_GAIN = 20;
/** Disposition lost when the AI refuses a demand / declines a ceasefire. */
export const SNUB_DISPOSITION_LOSS = 5;
/** Disposition lost when YOU break a ceasefire by attacking. */
export const BETRAYAL_DISPOSITION_LOSS = 15;
/** Disposition lost when the AI pays a demand (tribute under duress). */
export const DEMAND_PAID_DISPOSITION_LOSS = 10;

/** Pride penalty per difficulty, subtracted from AI willingness. */
const DIFFICULTY_PRIDE: Record<AIDifficulty, number> = {
  cadet: 0,
  citizen: 10,
  commander: 20,
  general: 30,
  marshal: 40,
};

/** What the AI brings to a verdict: difficulty, personality, treasury. */
export interface AIStanding {
  difficulty: AIDifficulty;
  /** Raw 0..1 aggression trait from the AI's seeded personality. */
  aggression: number;
  funds: number;
}

/** Read the AI side of a verdict. Null when the target isn't an AI player. */
export function readAIStanding(world: World, aiOwner: number): AIStanding | null {
  const ai = world.ai.players.find((p) => p.owner === aiOwner);
  const player = getPlayer(world.city, aiOwner);
  if (!ai || !player) return null;
  return {
    difficulty: ai.difficulty,
    aggression: ai.personality.aggression,
    funds: player.funds,
  };
}

/** True when the owner is a registered Classic AI player. */
export function isAIOwner(world: World, owner: number): boolean {
  return world.ai.players.some((p) => p.owner === owner);
}

/**
 * Pure demand verdict: does the AI pay `amount`? Pricier demands relative
 * to its treasury, prouder difficulties, and aggressive personalities
 * all refuse more. Deterministic — no RNG.
 */
export function demandAccepted(
  disposition: number,
  ai: AIStanding,
  amount: number,
): boolean {
  if (ai.funds < amount) return false;
  const burden = (amount / Math.max(1, ai.funds)) * 120;
  const willingness =
    disposition - burden - DIFFICULTY_PRIDE[ai.difficulty] - ai.aggression * 25;
  return willingness >= 50;
}

/**
 * Pure ceasefire verdict: does the AI hold fire for CEASEFIRE_MINUTES?
 * Warm relations persuade; aggression and pride resist. Deterministic.
 */
export function ceasefireAccepted(disposition: number, ai: AIStanding): boolean {
  const willingness =
    disposition - ai.aggression * 30 - DIFFICULTY_PRIDE[ai.difficulty] / 2;
  return willingness >= 45;
}

/** True while a ceasefire is in force. */
export function ceasefireActive(world: World): boolean {
  return world.diplomacy.ceasefireUntilTick > world.tick;
}

/**
 * True when owners a and b are the two sides of the tracked ceasefire
 * pair (order-independent). Used by the combat loop to freeze
 * opportunistic fire between the two sides while a ceasefire holds.
 */
export function isCeasefirePair(world: World, a: number, b: number): boolean {
  const parties = world.diplomacy.parties;
  if (!parties) return false;
  return (
    (a === parties.owner && b === parties.aiOwner) ||
    (a === parties.aiOwner && b === parties.owner)
  );
}

/** Ticks of ceasefire remaining (0 when none). */
export function ceasefireTicksLeft(world: World): number {
  return Math.max(0, world.diplomacy.ceasefireUntilTick - world.tick);
}

/**
 * Break an active ceasefire (betrayal). Called when an attackUnit /
 * attackBuilding order lands on the rival while the ceasefire holds.
 * No-op when no ceasefire is active.
 */
export function breakCeasefire(world: World): void {
  const d = world.diplomacy;
  if (!ceasefireActive(world)) return;
  d.ceasefireUntilTick = 0;
  d.disposition = Math.max(0, d.disposition - BETRAYAL_DISPOSITION_LOSS);
  d.lastCeasefireAsk = 'broken';
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function payloadInt(payload: Record<string, unknown>, key: string): number | null {
  const v = payload[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

interface PartiesCheck {
  owner: number;
  aiOwner: number;
  error: string | null;
}

/** Shared parties validation for all three commands. */
function checkParties(
  cmdName: string,
  payload: Record<string, unknown>,
  world: World,
): PartiesCheck {
  const bad = (error: string): PartiesCheck => ({ owner: 0, aiOwner: 0, error });
  const owner = payloadInt(payload, 'owner');
  const aiOwner = payloadInt(payload, 'targetOwner');
  if (owner === null) return bad(`${cmdName}: payload.owner must be an integer`);
  if (aiOwner === null) return bad(`${cmdName}: payload.targetOwner must be an integer`);
  if (owner === aiOwner) return bad(`${cmdName}: cannot negotiate with yourself`);
  if (!getPlayer(world.city, owner)) return bad(`${cmdName}: no player ${owner}`);
  if (!isAIOwner(world, aiOwner)) {
    return bad(`${cmdName}: player ${aiOwner} is not an AI rival`);
  }
  const parties = world.diplomacy.parties;
  if (parties !== null && (parties.owner !== owner || parties.aiOwner !== aiOwner)) {
    return bad(`${cmdName}: diplomacy is already tracked with another rival`);
  }
  return { owner, aiOwner, error: null };
}

/** Stamp the tracked pair on first use. */
function ensureParties(world: World, owner: number, aiOwner: number): void {
  if (world.diplomacy.parties === null) {
    world.diplomacy.parties = { owner, aiOwner };
  }
}

function payloadAmount(
  cmdName: string,
  payload: Record<string, unknown>,
): { amount: number; error: string | null } {
  const amount = payloadInt(payload, 'amount');
  if (amount === null || amount <= 0) {
    return { amount: 0, error: `${cmdName}: payload.amount must be a positive integer` };
  }
  return { amount, error: null };
}

const sendTributeSpec = {
  validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
    const parties = checkParties('sendTribute', cmd.payload, world);
    if (parties.error) return parties.error;
    const { amount, error } = payloadAmount('sendTribute', cmd.payload);
    if (error) return error;
    const sender = getPlayer(world.city, parties.owner);
    if (sender && sender.funds < amount) {
      return `sendTribute: player ${parties.owner} has ${Math.floor(sender.funds)} funds, needs ${amount}`;
    }
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const owner = cmd.payload['owner'] as number;
    const aiOwner = cmd.payload['targetOwner'] as number;
    const amount = Math.min(
      cmd.payload['amount'] as number,
      getPlayer(world.city, owner)?.funds ?? 0,
    );
    ensureParties(world, owner, aiOwner);
    const d = world.diplomacy;
    const sender = getPlayer(world.city, owner);
    const receiver = getPlayer(world.city, aiOwner);
    if (sender && receiver && amount > 0) {
      sender.funds -= amount;
      receiver.funds += amount;
      d.totalTributeSent += amount;
    }
    const gain = Math.min(
      MAX_TRIBUTE_DISPOSITION_GAIN,
      Math.floor(amount / 500) * TRIBUTE_DISPOSITION_PER_500,
    );
    d.disposition = Math.min(100, d.disposition + gain);
    return amount;
  },
};

const demandTributeSpec = {
  validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
    // Demands are war-game leverage — not offered in peaceful worlds.
    if (world.peaceful === true) {
      return 'demandTribute: tribute demands are not available in peaceful mode';
    }
    const parties = checkParties('demandTribute', cmd.payload, world);
    if (parties.error) return parties.error;
    const { error } = payloadAmount('demandTribute', cmd.payload);
    if (error) return error;
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const owner = cmd.payload['owner'] as number;
    const aiOwner = cmd.payload['targetOwner'] as number;
    const amount = cmd.payload['amount'] as number;
    ensureParties(world, owner, aiOwner);
    const d = world.diplomacy;
    const ai = readAIStanding(world, aiOwner);
    const accepted = ai !== null && demandAccepted(d.disposition, ai, amount);
    d.lastDemandAmount = amount;
    if (accepted) {
      const payer = getPlayer(world.city, aiOwner);
      const receiver = getPlayer(world.city, owner);
      const paid = Math.min(amount, payer?.funds ?? 0);
      if (payer && receiver && paid > 0) {
        payer.funds -= paid;
        receiver.funds += paid;
        d.totalTributeReceived += paid;
      }
      d.disposition = Math.max(0, d.disposition - DEMAND_PAID_DISPOSITION_LOSS);
      d.demandsRefused = 0;
      d.lastDemand = 'accepted';
    } else {
      d.disposition = Math.max(0, d.disposition - SNUB_DISPOSITION_LOSS);
      d.demandsRefused += 1;
      d.lastDemand = 'refused';
    }
    return d.lastDemand;
  },
};

const proposeCeasefireSpec = {
  validate(cmd: { payload: Record<string, unknown> }, world: World): string | null {
    // A ceasefire pauses a war — meaningless where no war can happen.
    if (world.peaceful === true) {
      return 'proposeCeasefire: ceasefires are not available in peaceful mode';
    }
    const parties = checkParties('proposeCeasefire', cmd.payload, world);
    if (parties.error) return parties.error;
    if (ceasefireActive(world)) {
      return 'proposeCeasefire: a ceasefire is already in effect';
    }
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const owner = cmd.payload['owner'] as number;
    const aiOwner = cmd.payload['targetOwner'] as number;
    ensureParties(world, owner, aiOwner);
    const d = world.diplomacy;
    const ai = readAIStanding(world, aiOwner);
    const accepted = ai !== null && ceasefireAccepted(d.disposition, ai);
    if (accepted) {
      d.ceasefireUntilTick = world.tick + CEASEFIRE_TICKS;
      d.disposition = Math.min(100, d.disposition + SNUB_DISPOSITION_LOSS);
      d.lastCeasefireAsk = 'accepted';
    } else {
      d.disposition = Math.max(0, d.disposition - SNUB_DISPOSITION_LOSS);
      d.lastCeasefireAsk = 'declined';
    }
    return d.lastCeasefireAsk;
  },
};

/** Register the diplomacy commands on a command queue. */
export function registerDiplomacyCommands(queue: CommandQueue): void {
  queue.register('sendTribute', sendTributeSpec as never);
  queue.register('demandTribute', demandTributeSpec as never);
  queue.register('proposeCeasefire', proposeCeasefireSpec as never);
}
