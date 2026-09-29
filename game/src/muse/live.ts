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
 * NOVATERRA — muse/live.ts — Live Muse link (player's own Meta API key).
 *
 * Two jobs:
 *
 * 1. **Advisory link (persona flavor).** `MuseDigest` + `buildDigest(...)`
 *    and the `MUSE: advise: <text>` directive protocol. Advisory lines
 *    become persona flavor text; the live model can never drive the game
 *    through this path.
 * 2. **Muse Commander (rival AI).** When the player picks the "Muse"
 *    difficulty, a compact battle digest (`muse/digest.ts`) is POSTed to
 *    Meta's Model API (api.meta.ai/v1) once per cadence interval. The
 *    model answers with `MUSE:` directive lines (`build`, `construct`,
 *    `attack`, `defend`, `advance-age`, `advise`); `directivesToCommands`
 *    turns them into ordinary validated game commands through the
 *    `CommandQueue`. Muse never mutates sim state directly, and the
 *    digest is fog-of-war filtered (see `muse/digest.ts`).
 *
 * Meta's Model API accepts the Messages-style request format at the
 * same base URL; auth is a Bearer token. Key storage:
 * localStorage `novaterra.muse.liveKey` only. The key is never committed,
 * never logged, and never appears in error messages — it is sent only as
 * the `Authorization: Bearer` header to api.meta.ai.
 *
 * All failures (no key, timeout, 401/429/5xx, network error, malformed
 * output) throw `LiveMuseError`; callers fall back to the offline
 * Classic AI seamlessly.
 */

import type { World } from '../sim/world';
import type { CommandQueue, NewCommand } from '../sim/commands';
import { CommandRejectedError } from '../sim/commands';
import { getPlayer, cellCoords, BUILDING_DEFS, type BuildingKind } from '../sim/city';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { AGE_PROGRESSION } from '../sim/ages';
import { worldToCell } from '../sim/pathfinding';
import { computeThreat, militaryValue } from './director';
import type { CommanderDigest } from './digest';

const LIVE_KEY_STORAGE = 'novaterra.muse.liveKey';
const LIVE_ENABLED_STORAGE = 'novaterra.muse.liveEnabled';
const LIVE_MODEL_STORAGE = 'novaterra.muse.liveModel';
const LIVE_CADENCE_STORAGE = 'novaterra.muse.liveCadenceSec';

/** Default model for the Muse Commander rival. */
export const DEFAULT_LIVE_MODEL = 'muse-spark-1.3';
/** Models offered in Settings. Meta Muse Spark models served by Meta's Model API. */
export const LIVE_MODEL_OPTIONS = ['muse-spark-1.3', 'muse-spark-1.1'] as const;
/** Default API cadence: one call per 60 game-seconds. */
export const DEFAULT_LIVE_CADENCE_SEC = 60;
/** Cadence choices offered in Settings (game-seconds). */
export const LIVE_CADENCE_OPTIONS = [30, 60, 120] as const;
/** Meta Model API request timeout. */
export const LIVE_REQUEST_TIMEOUT_MS = 30000;

/** Strategic digest sent to the live model (advisory path). JSON-safe. */
export interface MuseDigest {
  game: 'novaterra';
  tick: number;
  age: string;
  funds: number;
  population: number;
  food: number;
  influence: number;
  manpower: number;
  buildings: number;
  units: number;
  enemyUnits: number;
  myMilitary: number;
  enemyMilitary: number;
  threat: number;
  mission: string | null;
  objectives: string[];
}

export function buildDigest(
  world: World,
  playerId: number,
  aiId: number,
  missionId: string | null,
  objectives: string[],
): MuseDigest {
  const player = getPlayer(world.city, playerId);
  let buildings = 0;
  for (const b of world.city.buildings) if (b.owner === playerId) buildings += 1;
  let units = 0;
  let enemyUnits = 0;
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    if (u.owner === playerId) units += 1;
    else if (u.owner === aiId) enemyUnits += 1;
  }
  return {
    game: 'novaterra',
    tick: world.tick,
    age: world.ages.age,
    funds: Math.floor(player?.funds ?? 0),
    population: Math.floor(player?.population ?? 0),
    food: Math.floor(player?.food ?? 0),
    influence: Math.floor(player?.influence ?? 0),
    manpower: Math.floor(player?.manpower ?? 0),
    buildings,
    units,
    enemyUnits,
    myMilitary: Math.round(militaryValue(world, playerId)),
    enemyMilitary: Math.round(militaryValue(world, aiId)),
    threat: computeThreat(world, playerId, aiId),
    mission: missionId,
    objectives,
  };
}

/** Advisory directives the protocol accepts (backward compatible). */
export type LiveDirective = { kind: 'advise'; text: string };

/**
 * Full commander directive protocol. One directive per response line:
 *   MUSE: build: tank            — train a unit (build/train are aliases)
 *   MUSE: train: rifles x4       — train 4 units (count 1–10)
 *   MUSE: construct: house       — construct a building near the base
 *   MUSE: attack: 120, 80        — order combat units to map position
 *   MUSE: defend                 — pull combat units back to the base
 *   MUSE: advance-age[: program] — advance to the next age
 *   MUSE: advise: <text>         — flavor text (advisory path)
 * Unknown or malformed lines are ignored — never thrown.
 */
export type CommanderDirective =
  | { kind: 'advise'; text: string }
  | { kind: 'build'; unitKind: string; count: number }
  | { kind: 'construct'; buildingKind: string }
  | { kind: 'attack'; x: number; z: number }
  | { kind: 'defend' }
  | { kind: 'advanceAge'; program: string | null };

const ADVISE_RE = /^MUSE:\s*advise\s*:\s*(.+)$/i;
const BUILD_RE = /^MUSE:\s*(?:build|train)\s*:\s*([a-zA-Z][a-zA-Z0-9]*)\s*(?:x\s*(\d{1,2}))?\s*$/i;
const CONSTRUCT_RE = /^MUSE:\s*construct\s*:\s*([a-zA-Z][a-zA-Z0-9]*)\s*$/i;
const ATTACK_RE = /^MUSE:\s*attack\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/i;
const DEFEND_RE = /^MUSE:\s*defend\s*$/i;
const ADVANCE_AGE_RE = /^MUSE:\s*advance-?age\s*(?::\s*([a-zA-Z][a-zA-Z0-9]*))?\s*$/i;

/** Max response lines parsed per round (bounds a chatty model). */
export const MAX_DIRECTIVES_PER_ROUND = 12;

/**
 * Canonical case-insensitive lookups: the model's output casing is
 * free-form (`patrolBoat`, `PatrolBoat`, `PATROLBOAT`), but the def keys
 * are canonical (`patrolBoat`, `signalsGrid`). Blind lowercasing would
 * break camelCase keys — resolve through these indexes instead.
 */
const UNIT_KIND_INDEX = new Map<string, string>(
  Object.keys(UNIT_DEFS).map((k) => [k.toLowerCase(), k]),
);
const BUILDING_KIND_INDEX = new Map<string, string>(
  Object.keys(BUILDING_DEFS).map((k) => [k.toLowerCase(), k]),
);
const PROGRAM_INDEX = new Map<string, string>();
for (const age of Object.values(AGE_PROGRESSION)) {
  for (const p of age.programs) PROGRAM_INDEX.set(p.toLowerCase(), p);
}

/**
 * Parse the model's response into directives. Malformed lines, unknown
 * verbs, and unknown unit/building kinds are silently skipped — a bad
 * model response can never break the game. `advise` lines keep working
 * exactly as before (backward compatible with the advisory protocol).
 */
export function parseDirectives(responseText: string): CommanderDirective[] {
  const out: CommanderDirective[] = [];
  for (const rawLine of responseText.split('\n')) {
    if (out.length >= MAX_DIRECTIVES_PER_ROUND) break;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let m: RegExpExecArray | null;
    if ((m = ADVISE_RE.exec(line))) {
      const text = m[1]!.trim();
      if (text.length > 0 && text.length <= 280) out.push({ kind: 'advise', text });
      continue;
    }
    if ((m = BUILD_RE.exec(line))) {
      const unitKind = UNIT_KIND_INDEX.get(m[1]!.toLowerCase());
      if (!unitKind) continue;
      const count = m[2] ? Math.min(Math.max(parseInt(m[2], 10), 1), 10) : 1;
      out.push({ kind: 'build', unitKind, count });
      continue;
    }
    if ((m = CONSTRUCT_RE.exec(line))) {
      const buildingKind = BUILDING_KIND_INDEX.get(m[1]!.toLowerCase());
      if (!buildingKind) continue;
      out.push({ kind: 'construct', buildingKind });
      continue;
    }
    if ((m = ATTACK_RE.exec(line))) {
      const x = parseFloat(m[1]!);
      const z = parseFloat(m[2]!);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      out.push({ kind: 'attack', x, z });
      continue;
    }
    if (DEFEND_RE.test(line)) {
      out.push({ kind: 'defend' });
      continue;
    }
    if ((m = ADVANCE_AGE_RE.exec(line))) {
      // No program: default. Unknown program: skip the directive.
      const program = m[1] ? (PROGRAM_INDEX.get(m[1].toLowerCase()) ?? null) : null;
      if (m[1] && program === null) continue;
      out.push({ kind: 'advanceAge', program });
      continue;
    }
    // Unknown / malformed line: ignore, never throw.
  }
  return out;
}

/** Context needed to turn directives into game commands. */
export interface DirectiveContext {
  world: World;
  queue: CommandQueue;
  /** Owner id the Muse rival commands. */
  owner: number;
  /** Rival base position (world units). */
  baseX: number;
  baseZ: number;
}

/**
 * Turn parsed directives into ordinary validated game commands through
 * the queue — the same path every player and the Classic AI use.
 * Loud `CommandRejectedError`s (unaffordable, invalid, illegal) are
 * swallowed per directive so one bad idea never blocks the rest.
 * Non-rejection errors are rethrown: they indicate bugs, not bad Muse
 * output. This function never mutates `world` directly.
 */
export function directivesToCommands(directives: CommanderDirective[], ctx: DirectiveContext): void {
  const { world, queue, owner, baseX, baseZ } = ctx;
  for (const d of directives) {
    try {
      switch (d.kind) {
        case 'advise':
          // Flavor text only — the caller may surface it via a say() callback.
          break;
        case 'build':
          applyBuild(world, queue, owner, baseX, baseZ, d.unitKind, d.count);
          break;
        case 'construct':
          applyConstruct(world, queue, owner, baseX, baseZ, d.buildingKind);
          break;
        case 'attack':
          applyMoveArmy(world, queue, owner, d.x, d.z);
          break;
        case 'defend':
          applyMoveArmy(world, queue, owner, baseX, baseZ);
          break;
        case 'advanceAge':
          applyAdvanceAge(world, queue, owner, d.program);
          break;
      }
    } catch (e) {
      if (!(e instanceof CommandRejectedError)) throw e;
    }
  }
}

function enqueue(queue: CommandQueue, world: World, cmd: NewCommand): void {
  queue.enqueue(world, cmd);
}

/** Train `count` units near the base (deterministic offsets, no RNG). */
function applyBuild(
  world: World,
  queue: CommandQueue,
  owner: number,
  baseX: number,
  baseZ: number,
  unitKind: string,
  count: number,
): void {
  if (!(UNIT_DEFS[unitKind as UnitKind])) return;
  const n = Math.min(Math.max(Math.floor(count), 1), 10);
  for (let i = 0; i < n; i++) {
    const x = baseX + ((i % 3) - 1) * 4;
    const z = baseZ + ((Math.floor(i / 3) % 3) - 1) * 4;
    enqueue(queue, world, {
      kind: 'spawnUnit',
      issuer: 'muse-commander',
      payload: { kind: unitKind, owner, x, z },
    });
  }
}

/**
 * Construct a building near the base. Tries a small spiral of candidate
 * cells; the command's own validation (zones, roads, footprint, terrain)
 * decides, so invalid spots are loud rejections and we try the next.
 */
function applyConstruct(
  world: World,
  queue: CommandQueue,
  owner: number,
  baseX: number,
  baseZ: number,
  buildingKind: string,
): void {
  if (!(BUILDING_DEFS[buildingKind as BuildingKind])) return;
  const baseCell = worldToCell(baseX, baseZ);
  const base = cellCoords(baseCell);
  const spiral: Array<[number, number]> = [
    [0, 0], [3, 0], [-3, 0], [0, 3], [0, -3],
    [5, 2], [-5, 2], [5, -2], [-5, -2], [7, 0], [0, 7],
  ];
  for (const [dx, dz] of spiral) {
    try {
      enqueue(queue, world, {
        kind: 'placeBuilding',
        issuer: 'muse-commander',
        payload: { kind: buildingKind, owner, cx: base.cx + dx, cz: base.cz + dz },
      });
      return; // accepted — one building per directive
    } catch (e) {
      if (!(e instanceof CommandRejectedError)) throw e;
      // Invalid spot — try the next candidate.
    }
  }
}

/**
 * Order every combat unit (damage > 0) toward (x, z) via individual
 * `moveUnit` commands so per-domain reachability is handled per unit:
 * a boat that cannot reach a land target is skipped while land units
 * still move. Coordinates are clamped to the map.
 */
function applyMoveArmy(
  world: World,
  queue: CommandQueue,
  owner: number,
  x: number,
  z: number,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const tx = Math.min(Math.max(x, -250), 250);
  const tz = Math.min(Math.max(z, -250), 250);
  for (const u of world.units) {
    if (u.owner !== owner || u.hp <= 0) continue;
    if (UNIT_DEFS[u.kind as UnitKind].damage <= 0) continue;
    try {
      enqueue(queue, world, {
        kind: 'moveUnit',
        issuer: 'muse-commander',
        payload: { unitId: u.id, owner, x: tx, z: tz },
      });
    } catch (e) {
      if (!(e instanceof CommandRejectedError)) throw e;
    }
  }
}

/** Advance to the next age with the named (or default) national program. */
function applyAdvanceAge(
  world: World,
  queue: CommandQueue,
  owner: number,
  program: string | null,
): void {
  const prog = AGE_PROGRESSION[world.ages.age];
  if (!prog || !prog.next || prog.programs.length === 0) return;
  const chosen = program ?? prog.programs[0]!;
  if (!prog.programs.includes(chosen)) return;
  enqueue(queue, world, {
    kind: 'advanceAge',
    issuer: 'muse-commander',
    payload: { owner, program: chosen },
  });
}

// ---------------------------------------------------------------------------
// Settings storage (localStorage only — never committed, never logged).
// ---------------------------------------------------------------------------

export function getLiveKey(): string {
  try {
    return localStorage.getItem(LIVE_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setLiveKey(key: string): void {
  try {
    if (key.length === 0) localStorage.removeItem(LIVE_KEY_STORAGE);
    else localStorage.setItem(LIVE_KEY_STORAGE, key);
  } catch {
    // Storage unavailable — live mode simply won't persist.
  }
}

export function isLiveEnabled(): boolean {
  try {
    return localStorage.getItem(LIVE_ENABLED_STORAGE) === '1' && getLiveKey().length > 0;
  } catch {
    return false;
  }
}

export function setLiveEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LIVE_ENABLED_STORAGE, enabled ? '1' : '0');
  } catch {
    // Ignore.
  }
}

export function getLiveModel(): string {
  try {
    const m = localStorage.getItem(LIVE_MODEL_STORAGE);
    if (m && (LIVE_MODEL_OPTIONS as readonly string[]).includes(m)) return m;
  } catch {
    // Ignore.
  }
  return DEFAULT_LIVE_MODEL;
}

export function setLiveModel(model: string): void {
  try {
    if ((LIVE_MODEL_OPTIONS as readonly string[]).includes(model)) {
      localStorage.setItem(LIVE_MODEL_STORAGE, model);
    }
  } catch {
    // Ignore.
  }
}

export function getLiveCadenceSec(): number {
  try {
    const n = parseInt(localStorage.getItem(LIVE_CADENCE_STORAGE) ?? '', 10);
    if ((LIVE_CADENCE_OPTIONS as readonly number[]).includes(n)) return n;
  } catch {
    // Ignore.
  }
  return DEFAULT_LIVE_CADENCE_SEC;
}

export function setLiveCadenceSec(sec: number): void {
  try {
    if ((LIVE_CADENCE_OPTIONS as readonly number[]).includes(sec)) {
      localStorage.setItem(LIVE_CADENCE_STORAGE, String(sec));
    }
  } catch {
    // Ignore.
  }
}

// ---------------------------------------------------------------------------
// Meta Model API client (api.meta.ai/v1).
// ---------------------------------------------------------------------------

/** Machine-readable failure reason for the live Muse link. */
export type LiveMuseErrorCode =
  | 'invalid_key'
  | 'rate_limited'
  | 'request_failed'
  | 'malformed'
  | 'timeout'
  | 'network'
  | 'no_key';

/** Sanitized error for the live Muse link: never contains the API key. */
export class LiveMuseError extends Error {
  readonly code: LiveMuseErrorCode;
  constructor(message: string, code: LiveMuseErrorCode) {
    super(message);
    this.name = 'LiveMuseError';
    this.code = code;
  }
}

const META_MODEL_API_URL = 'https://api.meta.ai/v1/messages';

/** System prompt: the model may answer ONLY with MUSE: directive lines. */
export const COMMANDER_SYSTEM_PROMPT =
  'You are Meta Muse, commanding the rival army in NOVATERRA, a real-time ' +
  'strategy game. You command the red army against a human player. Each ' +
  'round you receive a JSON battle digest. You see ONLY what is in the ' +
  'digest — never assume hidden enemy information.\n\n' +
  'Respond with ONLY directive lines, one per line, in this exact format:\n' +
  'MUSE: build: <unit> [x<count>]   — train units near your base ' +
  '(units: engineer, rifles, tank, artillery, aa, hauler, spectre, hq, fighter, transport, drone; count 1-10)\n' +
  'MUSE: construct: <building>      — construct a building near your base ' +
  '(buildings: house, apartment, shop, office, factory, farm, well, solarPanel, warehouse, depot, barracks)\n' +
  'MUSE: attack: <x>,<z>            — order all combat units to the map position (map units, -250 to 250)\n' +
  'MUSE: defend                     — pull combat units back to your base\n' +
  'MUSE: advance-age[: <program>]   — advance to the next age when affordable\n' +
  'MUSE: advise: <text>             — short flavor text (shown to the player, max 280 chars)\n\n' +
  'Rules: at most 6 directives per response; coordinates are map units in [-250, 250]; ' +
  'no other text, no explanations, no markdown.';

const ADVISE_SYSTEM_PROMPT =
  'You are Meta Muse, a charming strategic advisor in the game NOVATERRA. ' +
  'You receive a JSON digest of the player\'s game. ' +
  'Respond with ONLY lines in this exact format:\n' +
  'MUSE: advise: <short strategic tip or flavor text, max 280 chars>\n' +
  'No other text, no explanations, no markdown.';

interface MetaTextBlock {
  type: string;
  text?: string;
}

interface MetaApiResponse {
  content?: MetaTextBlock[];
}

/**
 * POST to Meta's Model API and return the concatenated text. The API key
 * is sent ONLY as the `Authorization: Bearer` header and never appears in
 * errors or logs. Throws LiveMuseError on any failure. Note: whether
 * api.meta.ai accepts direct browser (CORS) calls is unverified — a
 * browser-blocked request surfaces as a network error, and the game
 * falls back to the Classic AI.
 */
async function callMetaModelApi(opts: {
  key: string;
  model: string;
  system: string;
  userContent: string;
  maxTokens: number;
  timeoutMs?: number;
}): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? LIVE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(META_MODEL_API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: [{ role: 'user', content: opts.userContent }],
      }),
      signal: controller.signal,
    });
    if (res.status === 401) {
      throw new LiveMuseError('Live Muse: invalid Meta API key (401). Check your key in Settings.', 'invalid_key');
    }
    if (res.status === 429) {
      throw new LiveMuseError('Live Muse: rate limited (429). Backing off — Classic AI covers the game.', 'rate_limited');
    }
    if (!res.ok) {
      throw new LiveMuseError(`Live Muse: request failed (${res.status}). Classic AI covers the game.`, 'request_failed');
    }
    let data: MetaApiResponse;
    try {
      data = (await res.json()) as MetaApiResponse;
    } catch {
      throw new LiveMuseError('Live Muse: malformed API response. Classic AI covers the game.', 'malformed');
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
    return text;
  } catch (e) {
    if (e instanceof LiveMuseError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new LiveMuseError('Live Muse: request timed out. Classic AI covers the game.', 'timeout');
    }
    throw new LiveMuseError('Live Muse: network error. Classic AI covers the game.', 'network');
  } finally {
    clearTimeout(timeout);
  }
}

export interface LiveMuseClient {
  /** Advisory flavor lines for the persona. Throws LiveMuseError on any failure. */
  advise(digest: MuseDigest): Promise<string[]>;
  /** Commander directives for the rival. Throws LiveMuseError on any failure. */
  command(digest: CommanderDigest, opts?: { timeoutMs?: number }): Promise<CommanderDirective[]>;
}

/**
 * Create the live client. Constructing the client does not network —
 * calls happen per method invocation so each round uses the current
 * settings (key, model, cadence).
 */
export function createLiveMuseClient(): LiveMuseClient {
  return {
    async advise(digest: MuseDigest): Promise<string[]> {
      const key = getLiveKey();
      if (key.length === 0) throw new LiveMuseError('Live Muse: no API key set.', 'no_key');
      const text = await callMetaModelApi({
        key,
        model: getLiveModel(),
        system: ADVISE_SYSTEM_PROMPT,
        userContent: JSON.stringify(digest),
        maxTokens: 256,
      });
      return parseDirectives(text)
        .filter((d) => d.kind === 'advise')
        .map((d) => (d as { text: string }).text);
    },

    async command(digest: CommanderDigest, opts?: { timeoutMs?: number }): Promise<CommanderDirective[]> {
      const key = getLiveKey();
      if (key.length === 0) throw new LiveMuseError('Live Muse: no API key set.', 'no_key');
      const text = await callMetaModelApi({
        key,
        model: getLiveModel(),
        system: COMMANDER_SYSTEM_PROMPT,
        userContent: JSON.stringify(digest),
        maxTokens: 512,
        timeoutMs: opts?.timeoutMs,
      });
      return parseDirectives(text);
    },
  };
}

/**
 * Test the connection: a minimal request that expects a tiny advise
 * reply. Used by the Settings "Test connection" button. Never throws;
 * returns a human-readable result (the key is never in the message).
 */
export async function testLiveConnection(): Promise<{ ok: boolean; message: string }> {
  const key = getLiveKey();
  if (key.length === 0) return { ok: false, message: 'No API key set.' };
  try {
    const text = await callMetaModelApi({
      key,
      model: getLiveModel(),
      system: 'Reply with exactly this line and nothing else:\nMUSE: advise: ok',
      userContent: 'ping',
      maxTokens: 32,
      timeoutMs: 15000,
    });
    const directives = parseDirectives(text);
    if (directives.some((d) => d.kind === 'advise')) {
      return { ok: true, message: 'Connected — Muse is ready.' };
    }
    return { ok: false, message: 'Unexpected response from the API.' };
  } catch (e) {
    return { ok: false, message: e instanceof LiveMuseError ? e.message : 'Connection failed.' };
  }
}
