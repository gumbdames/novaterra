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
import { createRngBank } from './rng';
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
 * Fun-audit Tier 4 (E1, 2026-10-02): the Envoy at the Gates. The
 * envoy's verdict — what the AI rival decided about the ceasefire the
 * envoy carries to the player's gates.
 */
export type EnvoyOfferVerdict = 'accepted' | 'declined';
/** What the envoy carries: always a ceasefire offer in 0.1 Alpha. */
export interface EnvoyOffer {
  kind: 'ceasefire';
  verdict: EnvoyOfferVerdict;
  /** The player the envoy visits (the offer's recipient). */
  owner: number;
  /** The AI rival the envoy speaks for. */
  aiOwner: number;
}
/** Where the envoy is in its ceremony. */
export type EnvoyVisitState = 'inbound' | 'waiting' | 'departing';
/**
 * How the envoy's ceremony ended (set when it leaves 'waiting' or is
 * recalled — the UI poll narrates the transition).
 */
export type EnvoyResolution = 'accepted' | 'declined' | 'timedOut' | 'recalled';
/**
 * The live envoy visit. Plain data — snapshotted + digested (the
 * envoy gates ceasefire timing, so it is behavior-affecting).
 */
export interface EnvoyStatus {
  state: EnvoyVisitState;
  offer: EnvoyOffer;
  /** The envoy SUV's unit id. */
  unitId: number;
  /** Tick the 60-second answer window closes (0 unless waiting). */
  deadlineTick: number;
  /** Where the envoy parks, in world units (outside the capital). */
  parkX: number;
  parkZ: number;
  /** The map-edge point it entered (and will leave) through. */
  exitX: number;
  exitZ: number;
  /** Tick the inbound drive started (stuck-pathing watchdog). */
  inboundSinceTick: number;
  /** Tick the departing drive must finish by (drive-off watchdog). */
  departByTick: number;
  /** How the ceremony ended (null while it is still live). */
  resolution: EnvoyResolution | null;
  /**
   * The dove release is flagged here by resolveEnvoyOffer but EMITTED
   * by the envoy system (after its tick-start clear): commands apply
   * before systems in runTick, so a command-pushed ceremony event
   * would be wiped the same tick and the render would never see it.
   */
  dovesPending: boolean;
}
/**
 * A ceasefire verdict that has been decided but not yet dispatched —
 * the envoy system (sim/envoy.ts) picks this up on the next tick and
 * spawns the envoy. The indirection keeps the import graph acyclic
 * (envoy.ts value-imports this module, never the reverse).
 */
export interface PendingEnvoyDispatch {
  offer: EnvoyOffer;
}

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
  /**
   * Fun-audit Tier 4 (E1, 2026-10-02): the live envoy visit, or null.
   * The 5-minute ceasefire clock starts when the envoy reaches the
   * player's HQ and the player answers — not when the AI accepts.
   */
  envoy: EnvoyStatus | null;
  /**
   * Fun-audit Tier 4 (E1, 2026-10-02): a decided-but-undispatched
   * envoy offer. The envoy system spawns it on the next tick.
   */
  pendingEnvoyDispatch: PendingEnvoyDispatch | null;
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
    // Fun-audit Tier 4 (E1, 2026-10-02): no envoy on a fresh world.
    envoy: null,
    pendingEnvoyDispatch: null,
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
    // Fun-audit Tier 4 (E1, 2026-10-02): pre-envoy snapshots decode to
    // no envoy (AD9 neutral default, no version bump). The decode is
    // defensive: anything outside the state/verdict unions, or a
    // non-finite unit id / deadline, falls back to null rather than
    // crashing the load.
    envoy: decodeEnvoyStatus(d['envoy']),
    pendingEnvoyDispatch: decodePendingEnvoyDispatch(d['pendingEnvoyDispatch']),
  };
}

/** Defensive decode of one envoy offer (null when malformed). */
function decodeEnvoyOffer(data: unknown): EnvoyOffer | null {
  if (typeof data !== 'object' || data === null) return null;
  const o = data as Record<string, unknown>;
  const verdict = o['verdict'];
  const owner = o['owner'];
  const aiOwner = o['aiOwner'];
  if (verdict !== 'accepted' && verdict !== 'declined') return null;
  if (typeof owner !== 'number' || !Number.isInteger(owner)) return null;
  if (typeof aiOwner !== 'number' || !Number.isInteger(aiOwner)) return null;
  return { kind: 'ceasefire', verdict, owner, aiOwner };
}

/** Defensive decode of the live envoy visit (null when malformed). */
function decodeEnvoyStatus(data: unknown): EnvoyStatus | null {
  if (typeof data !== 'object' || data === null) return null;
  const e = data as Record<string, unknown>;
  const state = e['state'];
  if (state !== 'inbound' && state !== 'waiting' && state !== 'departing') return null;
  const offer = decodeEnvoyOffer(e['offer']);
  if (offer === null) return null;
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const unitId = num(e['unitId']);
  const deadlineTick = num(e['deadlineTick']);
  const parkX = num(e['parkX']);
  const parkZ = num(e['parkZ']);
  if (unitId === null || deadlineTick === null || parkX === null || parkZ === null) return null;
  return {
    state,
    offer,
    unitId: Math.floor(unitId),
    deadlineTick: Math.floor(deadlineTick),
    parkX,
    parkZ,
    exitX: typeof e['exitX'] === 'number' && Number.isFinite(e['exitX']) ? (e['exitX'] as number) : 0,
    exitZ: typeof e['exitZ'] === 'number' && Number.isFinite(e['exitZ']) ? (e['exitZ'] as number) : 0,
    inboundSinceTick:
      typeof e['inboundSinceTick'] === 'number' && Number.isFinite(e['inboundSinceTick'])
        ? Math.floor(e['inboundSinceTick'] as number)
        : 0,
    departByTick:
      typeof e['departByTick'] === 'number' && Number.isFinite(e['departByTick'])
        ? Math.floor(e['departByTick'] as number)
        : 0,
    resolution:
      e['resolution'] === 'accepted' ||
      e['resolution'] === 'declined' ||
      e['resolution'] === 'timedOut' ||
      e['resolution'] === 'recalled'
        ? (e['resolution'] as EnvoyStatus['resolution'])
        : null,
    // Fun-audit Tier 4 (E1): pre-doves snapshots decode to no pending
    // ceremony (AD9 neutral default, no version bump).
    dovesPending: e['dovesPending'] === true,
  };
}

/** Defensive decode of a pending envoy dispatch (null when malformed). */
function decodePendingEnvoyDispatch(data: unknown): PendingEnvoyDispatch | null {
  if (typeof data !== 'object' || data === null) return null;
  const offer = decodeEnvoyOffer((data as Record<string, unknown>)['offer']);
  return offer === null ? null : { offer };
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
/**
 * Fun-audit C2b (influence triage, 2026-10-02): influence costs for
 * the two hostile diplomatic moves — the ask spends political capital
 * whether the AI accepts or not, so influence is a real decision axis
 * (ages 3+ already spend it at 100/250/500).
 */
export const DEMAND_TRIBUTE_INFLUENCE_COST = 20;
export const CEASEFIRE_INFLUENCE_COST = 40;
/**
 * Fun-audit Tier 4 (E1, 2026-10-02): a single tribute of at least this
 * many funds, sent while at war, can summon an envoy carrying a
 * ceasefire offer — if the seeded disposition check clears. The
 * player-reachable on-demand path to the envoy ceremony.
 */
export const ENVOY_TRIBUTE_THRESHOLD = 2000;

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

/**
 * Fun-audit Tier 4 (E2, 2026-10-02): exported for the luminary cards —
 * some cards (the Defector's public trial) move disposition against a
 * rival the player may never have negotiated with before.
 */
export function ensureDiplomacyParties(world: World, owner: number, aiOwner: number): void {
  ensureParties(world, owner, aiOwner);
}

/**
 * Fun-audit Tier 4 (E1, 2026-10-02): true while an envoy visit is live
 * or one is decided-but-undispatched. Used to keep proposals and
 * envoy ceremonies from overlapping.
 */
export function envoyActive(world: World): boolean {
  const d = world.diplomacy;
  return d.envoy !== null || d.pendingEnvoyDispatch !== null;
}

/**
 * Fun-audit Tier 4 (E1, 2026-10-02): the proud difficulties
 * (commander+) deliver a ceasefire refusal in person — the envoy
 * drives out to say no, and Muse warns the front is about to heat up.
 */
function isProudDifficulty(difficulty: AIDifficulty): boolean {
  return (DIFFICULTY_PRIDE[difficulty] ?? 0) >= 20;
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
    // Fun-audit Tier 4 (E1, 2026-10-02): a large tribute while at war
    // can summon an envoy carrying a ceasefire offer — the
    // player-reachable on-demand path to the ceremony. The seeded
    // disposition check (drawn on the 'envoy' stream, so replays stay
    // identical) means warm relations earn the audience; cold ones do
    // not. One envoy at a time — never while one is already at the
    // gates or a ceasefire holds.
    if (
      amount >= ENVOY_TRIBUTE_THRESHOLD &&
      world.peaceful !== true &&
      !ceasefireActive(world) &&
      !envoyActive(world) &&
      isAIOwner(world, aiOwner)
    ) {
      const bank = createRngBank(world.seed, world.rng);
      if (bank.next('envoy') < d.disposition / 100) {
        d.pendingEnvoyDispatch = {
          offer: { kind: 'ceasefire', verdict: 'accepted', owner, aiOwner },
        };
      }
    }
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
    // Fun-audit C2b (influence triage, 2026-10-02): making a demand
    // spends political capital — influence becomes a real decision
    // axis (monuments become diplomatically meaningful overnight).
    const player = getPlayer(world.city, parties.owner);
    if (player && player.influence < DEMAND_TRIBUTE_INFLUENCE_COST) {
      return `demandTribute: player ${parties.owner} has ${Math.floor(player.influence)} influence, needs ${DEMAND_TRIBUTE_INFLUENCE_COST}`;
    }
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const owner = cmd.payload['owner'] as number;
    const aiOwner = cmd.payload['targetOwner'] as number;
    const amount = cmd.payload['amount'] as number;
    ensureParties(world, owner, aiOwner);
    const d = world.diplomacy;
    // The ask itself spends the influence — accepted or refused.
    const player = getPlayer(world.city, owner);
    if (player) player.influence = Math.max(0, player.influence - DEMAND_TRIBUTE_INFLUENCE_COST);
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
    // Fun-audit Tier 4 (E1, 2026-10-02): one envoy at a time — a new
    // proposal waits until the current ceremony resolves.
    if (envoyActive(world)) {
      return 'proposeCeasefire: an envoy is already at your gates (answer them first)';
    }
    // Fun-audit C2b (influence triage, 2026-10-02): suing for peace
    // spends political capital, like the demand above.
    const player = getPlayer(world.city, parties.owner);
    if (player && player.influence < CEASEFIRE_INFLUENCE_COST) {
      return `proposeCeasefire: player ${parties.owner} has ${Math.floor(player.influence)} influence, needs ${CEASEFIRE_INFLUENCE_COST}`;
    }
    return null;
  },
  apply(cmd: { payload: Record<string, unknown> }, world: World): unknown {
    const owner = cmd.payload['owner'] as number;
    const aiOwner = cmd.payload['targetOwner'] as number;
    ensureParties(world, owner, aiOwner);
    const d = world.diplomacy;
    // The ask itself spends the influence — accepted or declined.
    const player = getPlayer(world.city, owner);
    if (player) player.influence = Math.max(0, player.influence - CEASEFIRE_INFLUENCE_COST);
    const ai = readAIStanding(world, aiOwner);
    const accepted = ai !== null && ceasefireAccepted(d.disposition, ai);
    if (accepted) {
      // Fun-audit Tier 4 (E1, 2026-10-02): the 5-minute clock no longer
      // starts here — it starts when the envoy reaches the player's HQ
      // and the player answers. Dispatch the envoy carrying the
      // accepted offer; `answerEnvoy` starts the clock.
      d.pendingEnvoyDispatch = {
        offer: { kind: 'ceasefire', verdict: 'accepted', owner, aiOwner },
      };
      d.disposition = Math.min(100, d.disposition + SNUB_DISPOSITION_LOSS);
      d.lastCeasefireAsk = 'accepted';
    } else {
      d.disposition = Math.max(0, d.disposition - SNUB_DISPOSITION_LOSS);
      d.lastCeasefireAsk = 'declined';
      // Fun-audit Tier 4 (E1, 2026-10-02): a proud AI's refusal is
      // delivered in person — the envoy drives out to say no, and
      // Muse warns the front is about to heat up.
      if (ai !== null && isProudDifficulty(ai.difficulty)) {
        d.pendingEnvoyDispatch = {
          offer: { kind: 'ceasefire', verdict: 'declined', owner, aiOwner },
        };
      }
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
