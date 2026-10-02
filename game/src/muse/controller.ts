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
 * NOVATERRA — muse/controller.ts — the offline Muse AI director
 * (Phase 2).
 *
 * Responsibilities:
 *  - `MuseController`: watches the world (~1 poll/sec from the game
 *    loop) and turns *observed* state changes into persona events:
 *    buildings completed, units trained/lost, ages advanced, programs
 *    chosen, enemies spotted, combat starting, funds running low,
 *    taunts when the threat meter swings hard.
 *  - Frequency setting (`off` | `quiet` | `normal` | `chatty`):
 *    quiet = milestones only; normal adds completions; chatty adds
 *    taunts and trick narration. Throttled so Muse charms instead of
 *    spamming: at most one line per `MIN_SAY_GAP_MS`, major events
 *    (victory/defeat/age) always go through.
 *  - `notify(text)`: campaign scripted messages and live-Muse advice
 *    enter through here — always shown (they are authored content).
 *  - Threat meter: `threat` getter, recomputed each poll; the UI reads
 *    it for the meter widget.
 *
 * UI-layer only: it reads the sim and calls `say`, never mutates the
 * sim. Deterministic line choice via personaLine(event, tick). No DOM —
 * safe under Node/vitest.
 */

import type { World } from '../sim/world';
import { getPlayer, BUILDING_DEFS } from '../sim/city';
import { UNIT_DEFS } from '../sim/units';
import { getAgeState } from '../sim/ages';
import { personaLine, type PersonaEvent } from './persona';
import { computeThreat, militaryValue, narrateTrick } from './director';

export type MuseFrequency = 'off' | 'quiet' | 'normal' | 'chatty';

export const MUSE_FREQUENCY_KEY = 'novaterra.muse.frequency';

export function loadMuseFrequency(): MuseFrequency {
  try {
    const v = localStorage.getItem(MUSE_FREQUENCY_KEY);
    if (v === 'off' || v === 'quiet' || v === 'normal' || v === 'chatty') return v;
  } catch {
    // Storage unavailable — fall through to the default.
  }
  return 'normal';
}

export function saveMuseFrequency(f: MuseFrequency): void {
  try {
    localStorage.setItem(MUSE_FREQUENCY_KEY, f);
  } catch {
    // Private mode etc. — the setting just doesn't persist.
  }
}

/** Minimum ms between persona lines (major events bypass it). */
const MIN_SAY_GAP_MS = 9000;
/** Taunts at most this often, and only in chatty mode. */
const TAUNT_GAP_MS = 60000;

/**
 * Fun-audit A2 (2026-10-02): display-name resolvers for the completion
 * and loss events. Unknown kinds fall back to the old literals so the
 * sentence shape never breaks.
 */
function buildingDisplayName(kind: string | undefined): string {
  if (kind === undefined) return 'building';
  return BUILDING_DEFS[kind as keyof typeof BUILDING_DEFS]?.name ?? 'building';
}

function unitDisplayName(kind: string | undefined): string {
  if (kind === undefined) return 'unit';
  return UNIT_DEFS[kind as keyof typeof UNIT_DEFS]?.name ?? 'unit';
}

interface MuseSnapshot {
  buildingCount: number;
  unitCount: number;
  age: string;
  program: string;
  funds: number;
  enemyUnitCount: number;
  anyFighting: boolean;
  kills: number;
  losses: number;
  /** Deterministic military value (fun-audit A4: war-core tracking). */
  military: number;
}

function snapshot(world: World, playerId: number, aiId: number): MuseSnapshot {
  let buildingCount = 0;
  for (const b of world.city.buildings) if (b.owner === playerId) buildingCount += 1;
  let unitCount = 0;
  let enemyUnitCount = 0;
  let anyFighting = false;
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    if (u.owner === playerId) {
      unitCount += 1;
      if (u.targetId !== 0) anyFighting = true;
    } else if (u.owner === aiId) {
      enemyUnitCount += 1;
      if (u.targetId !== 0) anyFighting = true;
    }
  }
  const player = getPlayer(world.city, playerId);
  return {
    buildingCount,
    unitCount,
    age: getAgeState(world, playerId).age,
    program: getAgeState(world, playerId).program ?? '',
    funds: player?.funds ?? 0,
    enemyUnitCount,
    anyFighting,
    kills: 0,
    losses: 0,
    // Fun-audit A4 (2026-10-02): the war-core crossing watches the
    // player's military value, not unit counts — a demoralized remnant
    // still counts as a remnant.
    military: militaryValue(world, playerId),
  };
}

export interface MuseControllerOpts {
  frequency: MuseFrequency;
  /** Render a line (the UI wires this to the Muse box). */
  say: (text: string) => void;
  /** Throttle source; defaults to Date.now (injectable for tests). */
  nowMs?: () => number;
}

export class MuseController {
  private frequency: MuseFrequency;
  private readonly say: (text: string) => void;
  private readonly nowMs: () => number;
  private prev: MuseSnapshot | null = null;
  private lastSayAt = 0;
  private lastTauntAt = 0;
  private saidHello = false;
  private lowFundsWarned = false;
  private combatAnnounced = false;
  private enemySpottedAnnounced = false;
  private trickAnnounced = false;
  /** Cumulative counters the controller owns (mirrors the campaign run). */
  private kills = 0;
  private losses = 0;
  /**
   * Fun-audit B3 (2026-10-02): read access for the end-of-game
   * statistics — the overlay reports what the persona tracked.
   */
  get killCount(): number {
    return this.kills;
  }
  get lossCount(): number {
    return this.losses;
  }
  private readonly knownIds = new Map<number, { owner: number; kind: string }>();
  /**
   * Fun-audit A2 (2026-10-02): building identities for the
   * buildingComplete event — the persona templates already interpolate
   * `{event.building}`, but the controller used to pass the literal
   * 'building'. Now the newest completed building's display name goes
   * through (BUILDING_DEFS names, e.g. 'House', 'Barracks').
   */
  private readonly knownBuildingIds = new Map<number, string>();
  private threatValue = 50;

  constructor(opts: MuseControllerOpts) {
    this.frequency = opts.frequency;
    this.say = opts.say;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  setFrequency(f: MuseFrequency): void {
    this.frequency = f;
  }

  /** Current threat meter 0..100 (AI's share of military value). */
  get threat(): number {
    return this.threatValue;
  }

  /**
   * Authored content (campaign messages, live-Muse advice): always
   * shown, bypassing frequency and throttle.
   */
  notify(text: string): void {
    if (this.frequency === 'off') return;
    this.say(text);
    this.lastSayAt = this.nowMs();
  }

  /** Poll the world; call ~1×/sec from the game loop. */
  update(world: World, playerId: number, aiId: number, missionName?: string): void {
    const now = this.nowMs();
    this.threatValue = computeThreat(world, playerId, aiId);
    const cur = snapshot(world, playerId, aiId);

    // Track kills/losses by unit-id disappearance (same technique as
    // the campaign director; UI-owned, never sim state).
    const seen = new Set<number>();
    // Fun-audit A2 (2026-10-02): collect this poll's new arrivals so
    // the completion/loss events can name them (display names from
    // the sim defs — 'Main Battle Tank', not 'unit').
    const newUnitKinds: string[] = [];
    const lostUnitKinds: string[] = [];
    for (const u of world.units) {
      seen.add(u.id);
      if (!this.knownIds.has(u.id)) {
        this.knownIds.set(u.id, { owner: u.owner, kind: u.kind });
        if (u.owner === playerId && u.hp > 0) newUnitKinds.push(u.kind);
      }
    }
    for (const [id, rec] of this.knownIds) {
      if (!seen.has(id)) {
        if (rec.owner === aiId) this.kills += 1;
        else if (rec.owner === playerId) {
          this.losses += 1;
          lostUnitKinds.push(rec.kind);
        }
        this.knownIds.delete(id);
      }
    }
    cur.kills = this.kills;
    cur.losses = this.losses;

    // Fun-audit A2 (2026-10-02): same identity tracking for buildings.
    const newBuildingKinds: string[] = [];
    const liveBuildingIds = new Set<number>();
    for (const b of world.city.buildings) {
      liveBuildingIds.add(b.id);
      if (b.owner !== playerId) continue;
      if (!this.knownBuildingIds.has(b.id)) {
        this.knownBuildingIds.set(b.id, b.kind);
        newBuildingKinds.push(b.kind);
      }
    }
    // Buildings removed from the world (destroyed/demolished) leave the
    // identity map so a rebuilt same-id building reads as new.
    for (const id of [...this.knownBuildingIds.keys()]) {
      if (!liveBuildingIds.has(id)) this.knownBuildingIds.delete(id);
    }

    if (!this.saidHello) {
      this.saidHello = true;
      this.prev = cur;
      this.emit({ kind: 'gameStart', missionName }, world.tick, true);
      return;
    }

    const prev = this.prev ?? cur;
    const events: Array<{ event: PersonaEvent; major: boolean }> = [];

    if (cur.age !== prev.age) {
      events.push({ event: { kind: 'ageAdvanced', age: cur.age }, major: true });
    }
    if (cur.program !== prev.program && cur.program !== '') {
      events.push({ event: { kind: 'programChosen', program: cur.program }, major: true });
    }
    // Fun-audit A4 (2026-10-02): the war core crossing — the player's
    // military value collapsing under 25% of what it once was. Major:
    // it always lands, even in quiet mode, because the defeat screen
    // follows this beat in the game loop.
    if (prev !== null && prev.military >= 0.25 && cur.military < 0.25) {
      events.push({ event: { kind: 'warCoreFallen' }, major: true });
    }
    if (cur.buildingCount > prev.buildingCount) {
      // Fun-audit A2 (2026-10-02): name the newest building instead of
      // the literal 'building' — the persona template interpolates it.
      const kind = newBuildingKinds[newBuildingKinds.length - 1];
      events.push({
        event: { kind: 'buildingComplete', building: buildingDisplayName(kind) },
        major: false,
      });
    }
    if (cur.unitCount > prev.unitCount) {
      const kind = newUnitKinds[newUnitKinds.length - 1];
      events.push({
        event: { kind: 'unitTrained', unit: unitDisplayName(kind) },
        major: false,
      });
    }
    if (cur.losses > prev.losses) {
      const kind = lostUnitKinds[lostUnitKinds.length - 1];
      events.push({
        event: { kind: 'unitLost', unit: unitDisplayName(kind) },
        major: false,
      });
    }
    if (cur.kills > prev.kills && this.frequency === 'chatty') {
      events.push({ event: { kind: 'enemyDown' }, major: false });
    }
    if (cur.enemyUnitCount > 0 && !this.enemySpottedAnnounced && prev.enemyUnitCount === 0) {
      this.enemySpottedAnnounced = true;
      events.push({ event: { kind: 'enemySpotted' }, major: false });
    }
    if (cur.anyFighting && !this.combatAnnounced) {
      this.combatAnnounced = true;
      events.push({ event: { kind: 'combatStarted' }, major: false });
    } else if (!cur.anyFighting) {
      this.combatAnnounced = false;
    }
    if (cur.funds < 200 && !this.lowFundsWarned) {
      this.lowFundsWarned = true;
      events.push({ event: { kind: 'lowFunds' }, major: false });
    } else if (cur.funds >= 500) {
      this.lowFundsWarned = false;
    }

    // Fair dirty-trick narration (chatty only): when 3+ enemy units are
    // observed closing on the player's base, Muse calls out the maneuver.
    // This reads only visible unit positions — never AI intent — and the
    // trick itself is always ordinary movement/combat on the command path.
    // One callout per approach: resets once the pressure lifts.
    if (this.frequency === 'chatty') {
      const trick = observeTrick(world, playerId, aiId);
      // One callout per approach: the flag is set when the line is
      // spoken (see the emit loop) and cleared once pressure lifts.
      if (trick !== null && !this.trickAnnounced) {
        events.push({ event: { kind: 'trick', description: trick }, major: false });
      } else if (trick === null) {
        this.trickAnnounced = false;
      }
    } else {
      this.trickAnnounced = false;
    }

    // Taunt when the threat meter swings hard (chatty only, throttled).
    if (this.frequency === 'chatty' && now - this.lastTauntAt > TAUNT_GAP_MS) {
      const context =
        this.threatValue >= 75 ? 'losing' : this.threatValue <= 25 ? 'winning' : null;
      if (context !== null) {
        this.lastTauntAt = now;
        events.push({ event: { kind: 'taunt', context }, major: false });
      }
    }

    // Emit: majors always; minors only when frequent enough and the
    // throttle allows. One line per poll at most — keep Muse charming.
    // The trick flag is set only when the line is actually spoken, so a
    // queued trick isn't lost when another event takes the poll's slot.
    for (const { event, major } of events) {
      const allowed =
        this.frequency !== 'off' &&
        (major || this.frequency === 'normal' || this.frequency === 'chatty') &&
        (major || now - this.lastSayAt >= MIN_SAY_GAP_MS);
      if (allowed) {
        if (event.kind === 'trick') this.trickAnnounced = true;
        this.emit(event, world.tick, major);
        break;
      }
    }

    this.prev = cur;
  }

  private emit(event: PersonaEvent, tick: number, major: boolean): void {
    if (this.frequency === 'off') return;
    // Quiet mode: milestones only.
    if (this.frequency === 'quiet' && !major) return;
    this.say(personaLine(event, tick));
    this.lastSayAt = this.nowMs();
  }
}

/**
 * Observe a potential dirty trick from visible unit positions only:
 * 3+ enemy units within 150 world units of the player's base read as a
 * converging force. Returns a concrete description ("5 hostiles closing
 * on your base from the north") or null. Never reads AI internal state.
 */
function observeTrick(world: World, playerId: number, aiId: number): string | null {
  let bx = 0;
  let bz = 0;
  let bn = 0;
  for (const b of world.city.buildings) {
    if (b.owner !== playerId) continue;
    bx += b.cx;
    bz += b.cz;
    bn += 1;
  }
  if (bn === 0) {
    for (const u of world.units) {
      if (u.owner !== playerId || u.hp <= 0) continue;
      bx += u.x;
      bz += u.z;
      bn += 1;
    }
  }
  if (bn === 0) return null;
  bx /= bn;
  bz /= bn;

  let n = 0;
  let ex = 0;
  let ez = 0;
  for (const u of world.units) {
    if (u.owner !== aiId || u.hp <= 0) continue;
    const dx = u.x - bx;
    const dz = u.z - bz;
    if (dx * dx + dz * dz <= 150 * 150) {
      n += 1;
      ex += u.x;
      ez += u.z;
    }
  }
  if (n < 3) return null;
  ex = ex / n - bx;
  ez = ez / n - bz;
  const direction =
    Math.abs(ex) > Math.abs(ez) ? (ex > 0 ? 'east' : 'west') : ez > 0 ? 'south' : 'north';
  const kind = n >= 6 ? 'pincer' : 'raid';
  return narrateTrick(kind, `${n} hostiles closing on your base from the ${direction}`);
}
