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
 * NOVATERRA — muse/live.ts — optional Live Muse advisory link (0.1 Alpha).
 *
 * Honest status: Live Muse is "hopefully coming" and is OFFLINE ONLY in
 * 0.1 Alpha. There is no API-key flow (removed entirely per the
 * 2026-09-29 user directive), no endpoint, and no networking — zero
 * third-party AI API surface. The game's five Classic AI rivals and the
 * offline Muse persona are the only advisors that ship.
 *
 * Responsibilities of what remains:
 *  - `buildDigest(...)`: pure JSON-safe digest builder (kept for the
 *    future protocol and for tests).
 *  - `parseDirectives(text)`: strict parser for the advisory protocol.
 *  - `createLiveMuseClient()`: the advise-only client. It throws
 *    `LiveMuseError` on every call in 0.1 Alpha so callers fall back
 *    to the offline persona — constructing it never networks.
 *  - `isLiveEnabled()`: the persisted live-mode flag (drives the
 *    disabled "hopefully coming" checkbox only; the checkbox is never
 *    interactive in 0.1 Alpha, so there is no setter).
 */

import type { World } from '../sim/world';
import { getPlayer } from '../sim/city';
import { computeThreat, militaryValue } from './director';

const LIVE_ENABLED_STORAGE = 'novaterra.muse.liveEnabled';

/** Strategic digest sent to the live model. JSON-safe. */
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

/** Advisory directives the protocol accepts. */
export type LiveDirective = { kind: 'advise'; text: string };

const DIRECTIVE_RE = /^MUSE:\s*advise\s*:\s*(.+)$/im;

/**
 * Parse the model's response. Only `MUSE: advise: <text>` lines are
 * honored; anything else (orders, commands, JSON blobs) is ignored, so
 * a live model can never drive the game.
 */
export function parseDirectives(responseText: string): LiveDirective[] {
  const out: LiveDirective[] = [];
  for (const line of responseText.split('\n')) {
    const m = DIRECTIVE_RE.exec(line.trim());
    if (m) {
      const text = m[1]!.trim();
      if (text.length > 0 && text.length <= 280) out.push({ kind: 'advise', text });
    }
  }
  return out;
}

export function isLiveEnabled(): boolean {
  try {
    return localStorage.getItem(LIVE_ENABLED_STORAGE) === '1';
  } catch {
    return false;
  }
}

export class LiveMuseError extends Error {}

export interface LiveMuseClient {
  /** Returns advisory text lines. Throws LiveMuseError on any failure. */
  advise(digest: MuseDigest): Promise<string[]>;
}

/**
 * Create the live client. Endpoint is intentionally unset in 0.1 Alpha
 * (hopefully coming) — constructing the client does not network.
 */
export function createLiveMuseClient(): LiveMuseClient {
  return {
    async advise(digest: MuseDigest): Promise<string[]> {
      void digest;
      // 0.1 Alpha: no endpoint wired. The settings panel marks this
      // hopefully coming; offline Muse covers the game meanwhile.
      throw new LiveMuseError('Live Muse is hopefully coming — offline Muse is advising instead.');
    },
  };
}
