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
 * NOVATERRA — ui/trailerDirector.ts — the scripted gameplay-trailer
 * director (trailer workstream, 2026-10-01).
 *
 * Responsibilities:
 *  - Build the trailer world: `createTrailerSession()` wraps the
 *    canonical `createSession()` — NOT sandbox: a real cadet-difficulty
 *    Classic AI rival plays (it never attacks, so the scripted movie is
 *    safe, and the finale stages a REAL battle against its fielded
 *    rifles plus a REAL storm strike). A designed opening stockpile is
 *    granted once before tick 0 (the campaign `startingResources`
 *    precedent — every later change flows through the real command
 *    queue, no sim special-casing anywhere).
 *  - `TrailerDirector` plays a ~7,400-tick (~4 minute) cinematic movie
 *    through the REAL command queue (`issuer: 'trailer'`): found a
 *    city → industrialize → raise an army → information age →
 *    civilian harbors + sea trade routes + freighters → airline route
 *    → storm array → march on the AI base → real battle → storm
 *    strike finale. Chapters fire on `world.tick` only — never on
 *    frame count or wall clock.
 *  - Title-card schedule (`TRAILER_TITLE_CARDS`): BUILD / COMMAND /
 *    OUTTHINK / TRADE / ENDURE (+ opening/closing NOVATERRA cards),
 *    rendered by `ui/trailerMode.ts` as in-game HUD overlays.
 *  - Camera-shot schedule (`TRAILER_SHOTS`): scripted cinematic shots
 *    (swoops, low harbor passes, freighter tracking, army tracking,
 *    battle wides, storm pull-back) resolved by `ui/trailerCamera.ts`
 *    against anchors the director computes from live world state.
 *
 * Determinism (non-negotiable):
 *  - Same `TRAILER_SEED` → same trailer. Chapters fire on `world.tick`
 *    only; the director's own randomness comes from a dedicated
 *    `trailer` stream on a director-owned `createRngBank(TRAILER_SEED)`
 *    — `world.rng` never gains a `trailer` stream.
 *  - No `Math.random`, no `Date.now`, no DOM, no three.js — headless
 *    safe, fully covered by `tests/ui.trailer.test.ts`.
 *
 * Relationship to `ui/demoDirector.ts`: the demo is the living menu's
 * slow-burn backdrop (sandbox, no rival, ~10 camera orbits, ~59k
 * ticks). The trailer is a separate, denser, battle-bearing movie with
 * its own camera choreography and title cards — a separate file, but it
 * reuses the demo's pure geometry helpers (`findLandRect`,
 * `findLandPoint`, `walkCells`, `cellWorld`) rather than copying them.
 */

import { createRngBank, type RngBank } from '../sim/rng';
import type { TerrainData } from '../sim/terrain';
import { isWater } from '../sim/terrain';
import {
  BUILDING_DEFS,
  CELL_WORLD_SIZE,
  CITY_GRID_CELLS,
  MAP_HALF_SIZE,
  ZoneType,
  buildingAtCell,
  cellCoords,
  cellIndex,
  cellIsWater,
  validatePlacement,
  type BuildingKind,
} from '../sim/city';
import type { NewCommand } from '../sim/commands';
import { CommandRejectedError } from '../sim/commands';
import {
  createSession,
  HUMAN_PLAYER_ID,
  AI_PLAYER_ID,
  type GameSession,
} from './session';
import {
  findLandRect,
  findLandPoint,
  walkCells,
  cellWorld,
} from './demoDirector';
import {
  buildAdvanceAgeOrder,
  buildFireStormOrder,
  buildMoveOrder,
  buildPlaceBuildingOrder,
  buildPowerLineOrder,
  buildRoadOrder,
  buildWaterPipeOrder,
  buildTrainOrder,
  buildZoneOrder,
  buildEstablishSeaRouteOrder,
  buildAssignSeaRouteOrder,
  buildEstablishAirlineRouteOrder,
  buildAttackOrders,
  type OrderIntent,
} from './orders';
import {
  anchoredPose,
  type TrailerShot,
  type TrailerAnchors,
  type Vec3,
} from './trailerCamera';

/** Fixed seed: the trailer plays identically on every shoot. */
export const TRAILER_SEED = 0x7a11e4;
/** Town site: a SITE_SIZE×SITE_SIZE all-land rect near the human corner. */
export const TRAILER_SITE_SIZE = 44;
/** Command issuer stamped on every director order (cf. 'player', 'demo'). */
export const TRAILER_ISSUER = 'trailer';
/** The trailer world is built on this map preset (canonical terrain seed). */
export const TRAILER_MAP_PRESET = 'Meridian Plains';
/** Owner the director builds for (the human slot, like a player). */
export const TRAILER_OWNER = HUMAN_PLAYER_ID;
/** Classic AI difficulty: cadet never attacks, so the script is safe. */
export const TRAILER_AI_DIFFICULTY = 'cadet' as const;
/** World tick at which the movie ends (the recorder stops here). */
export const TRAILER_END_TICK = 7400;
/** Unit kinds that march on the AI base in the finale. */
export const TRAILER_COMBAT_KINDS = [
  'rifles',
  'tank',
  'artillery',
  'apc',
  'tankDestroyer',
  'mlrs',
] as const;

/**
 * Opening stockpile for the trailer player. UI-owned setup, granted
 * once before tick 0 (the campaign `startingResources` precedent). It
 * funds the scripted arc: ~40 buildings, ~25 units, four age advances,
 * trade/airline/sea route setups, and ~250 sim-seconds of upkeep.
 */
export const TRAILER_OPENING_STOCKPILE = {
  funds: 900000,
  materials: 260000,
  fuel: 16000,
  food: 12000,
  research: 0,
  goods: 10000,
  influence: 8000,
  manpower: 2000,
} as const;

/**
 * Create the trailer world. A real skirmish (cadet rival) — the
 * director scripts the human side; the AI plays itself deterministically
 * and supplies the finale's battle. `seed` overrides the default only
 * for `&trailerseed=` re-shoots; the default path stays seed-pinned.
 */
export function createTrailerSession(seed: number = TRAILER_SEED): GameSession {
  const session = createSession({
    seed,
    mapPreset: TRAILER_MAP_PRESET,
    aiDifficulty: TRAILER_AI_DIFFICULTY,
  });
  const player = session.world.city.players[TRAILER_OWNER];
  if (player === undefined) {
    throw new Error('createTrailerSession: trailer player missing from fresh session');
  }
  for (const [key, value] of Object.entries(TRAILER_OPENING_STOCKPILE)) {
    (player as unknown as Record<string, number>)[key] = value;
  }
  return session;
}

/** One enqueued director command (the determinism-test record). */
export interface TrailerCommandRecord {
  /** World tick at fire time. */
  tick: number;
  /** Command kind, e.g. 'placeBuilding'. */
  kind: string;
}

/** A loud enqueue failure (never silent — surfaced to tests and console). */
export interface TrailerFailure {
  tick: number;
  chapter: string;
  kind: string;
  reason: string;
}

/**
 * Nearest water point to a world point, deterministic spiral. Used for
 * sea-unit spawn points (sea units reject land spawns).
 */
export function findWaterPoint(
  t: TerrainData,
  x: number,
  z: number,
): { x: number; z: number } {
  for (let r = 0; r <= 160; r += 4) {
    for (let a = 0; a < 8; a += 1) {
      const px = x + Math.cos((a / 8) * 2 * Math.PI) * r;
      const pz = z + Math.sin((a / 8) * 2 * Math.PI) * r;
      if (Math.abs(px) > MAP_HALF_SIZE - 8 || Math.abs(pz) > MAP_HALF_SIZE - 8) continue;
      if (isWater(t, px, pz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/**
 * Nearest all-land W×H cell rectangle with a water-adjacent edge
 * (coastline), on a deterministic outward spiral from (startCx,
 * startCz). Harbors and every other `portType` def require coastline in
 * `validatePlacement` — this is the planner's coastal search.
 */
export function findCoastRect(
  t: TerrainData,
  startCx: number,
  startCz: number,
  w: number,
  h: number,
): { cx: number; cz: number } | null {
  for (let r = 0; r <= 200; r += 2) {
    for (let a = 0; a < 16; a += 1) {
      const cx = startCx + Math.round(Math.cos((a / 16) * 2 * Math.PI) * r);
      const cz = startCz + Math.round(Math.sin((a / 16) * 2 * Math.PI) * r);
      if (cx < 0 || cz < 0 || cx + w > CITY_GRID_CELLS || cz + h > CITY_GRID_CELLS) continue;
      let ok = true;
      for (let dz = 0; dz < h && ok; dz += 1) {
        for (let dx = 0; dx < w && ok; dx += 1) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (!ok) continue;
      // Coastline: at least one water cell on the rect's border ring.
      let coast = false;
      for (let dz = -1; dz <= h && !coast; dz += 1) {
        for (let dx = -1; dx <= w && !coast; dx += 1) {
          if (dx >= 0 && dx < w && dz >= 0 && dz < h) continue;
          const ax = cx + dx;
          const az = cz + dz;
          if (ax < 0 || az < 0 || ax >= CITY_GRID_CELLS || az >= CITY_GRID_CELLS) continue;
          if (cellIsWater(t, ax, az)) coast = true;
        }
      }
      if (coast) return { cx, cz };
    }
  }
  return null;
}

/** One title-card overlay: text shown over [startTick, endTick). */
export interface TrailerTitleCard {
  startTick: number;
  endTick: number;
  title: string;
  sub: string;
}

/**
 * The title-card schedule. BUILD / COMMAND / OUTTHINK / TRADE / ENDURE
 * plus opening and closing NOVATERRA cards — rendered by
 * `ui/trailerMode.ts` as styled in-game HUD overlays with fade in/out.
 * All copy is English (the game's shipped language).
 */
export const TRAILER_TITLE_CARDS: TrailerTitleCard[] = [
  { startTick: 0, endTick: 270, title: 'NOVATERRA', sub: '0.1 ALPHA' },
  { startTick: 300, endTick: 1040, title: 'BUILD', sub: 'Raise a city from empty land' },
  { startTick: 1060, endTick: 1560, title: 'COMMAND', sub: 'Muster an army and take the field' },
  { startTick: 1580, endTick: 2040, title: 'OUTTHINK', sub: 'Research, intel and air power' },
  { startTick: 3240, endTick: 4200, title: 'TRADE', sub: 'Rule the sea lanes and the skies' },
  { startTick: 5600, endTick: 6600, title: 'ENDURE', sub: 'Break the enemy — then call the storm' },
  { startTick: 7000, endTick: TRAILER_END_TICK, title: 'NOVATERRA', sub: 'Every frame real gameplay — 0.1 Alpha' },
];

/**
 * The camera-shot schedule: scripted cinematic shots tiling the whole
 * trailer (swoops, low harbor passes, freighter/army tracking, battle
 * wides, storm pull-back). Poses are anchor-relative (`anchoredPose`) —
 * the DOM seam resolves anchors per tick via `cameraAnchors()`.
 */
export const TRAILER_SHOTS: TrailerShot[] = [
  // Opening: slow high sweep over the empty town site.
  {
    startTick: 0, endTick: 320, ease: 'linear',
    from: anchoredPose('town', { dx: -200, dy: 200, dz: 200 }, 0, 55),
    to: anchoredPose('town', { dx: 200, dy: 200, dz: 200 }, 0, 55),
  },
  // Descending sweep onto the construction.
  {
    startTick: 320, endTick: 900, ease: 'smooth',
    from: anchoredPose('town', { dx: 140, dy: 150, dz: 140 }, 0, 55),
    to: anchoredPose('town', { dx: 70, dy: 45, dz: 70 }, 4, 50),
  },
  // Low pass along the main street.
  {
    startTick: 900, endTick: 1500, ease: 'linear',
    from: anchoredPose('town', { dx: -110, dy: 24, dz: 50 }, 6, 60),
    to: anchoredPose('town', { dx: 110, dy: 24, dz: -30 }, 6, 60),
  },
  // Rising wide reveal of the industrializing town.
  {
    startTick: 1500, endTick: 2100, ease: 'smooth',
    from: anchoredPose('town', { dx: 90, dy: 40, dz: 90 }, 4, 55),
    to: anchoredPose('town', { dx: -190, dy: 140, dz: -190 }, 0, 55),
  },
  // Swoop from the town to the harbor coast.
  {
    startTick: 2100, endTick: 2700, ease: 'inOut',
    from: anchoredPose('town', { dx: -150, dy: 120, dz: -150 }, 0, 55),
    to: anchoredPose('harbor', { dx: 80, dy: 30, dz: 60 }, 4, 55),
  },
  // Low harbor pass.
  {
    startTick: 2700, endTick: 3300, ease: 'linear',
    from: anchoredPose('harbor', { dx: -90, dy: 26, dz: 40 }, 4, 58),
    to: anchoredPose('harbor', { dx: 90, dy: 26, dz: -40 }, 4, 58),
  },
  // Tracking shot: follow the first freighter on its route.
  {
    startTick: 3300, endTick: 3900, ease: 'linear',
    from: anchoredPose('freighter', { dx: -50, dy: 32, dz: 60 }, 2, 50),
    to: anchoredPose('freighter', { dx: 50, dy: 32, dz: -60 }, 2, 50),
  },
  // Wide city orbital (airline + information-age skyline).
  {
    startTick: 3900, endTick: 4500, ease: 'linear',
    from: anchoredPose('town', { dx: 170, dy: 100, dz: 0 }, 0, 52),
    to: anchoredPose('town', { dx: -170, dy: 100, dz: 0 }, 0, 52),
  },
  // Slow push-in on the city center.
  {
    startTick: 4500, endTick: 5100, ease: 'inOut',
    from: anchoredPose('town', { dx: 0, dy: 110, dz: 200 }, 0, 55),
    to: anchoredPose('town', { dx: 0, dy: 50, dz: 95 }, 4, 48),
  },
  // Tracking shot: follow the army marching to the staging point.
  {
    startTick: 5100, endTick: 5700, ease: 'linear',
    from: anchoredPose('army', { dx: -70, dy: 45, dz: 90 }, 2, 50),
    to: anchoredPose('army', { dx: 70, dy: 45, dz: -90 }, 2, 50),
  },
  // Battle wide.
  {
    startTick: 5700, endTick: 6400, ease: 'linear',
    from: anchoredPose('army', { dx: -140, dy: 80, dz: 100 }, 0, 55),
    to: anchoredPose('army', { dx: 140, dy: 80, dz: -100 }, 0, 55),
  },
  // Storm finale: wide on the strike zone.
  {
    startTick: 6400, endTick: 7000, ease: 'linear',
    from: anchoredPose('stormTarget', { dx: -220, dy: 130, dz: 160 }, 0, 55),
    to: anchoredPose('stormTarget', { dx: 220, dy: 130, dz: -160 }, 0, 55),
  },
  // Closing pull-back under the end card.
  {
    startTick: 7000, endTick: TRAILER_END_TICK, ease: 'smooth',
    from: anchoredPose('stormTarget', { dx: 0, dy: 150, dz: 260 }, 0, 55),
    to: anchoredPose('stormTarget', { dx: 0, dy: 200, dz: 340 }, 0, 55),
  },
];

interface Chapter {
  /** World tick at which the chapter fires. */
  tick: number;
  /** Short name for failure reports and the command log. */
  name: string;
  run(d: TrailerDirector): void;
}

type ReservedRect = Array<{ cx: number; cz: number; w: number; h: number }>;

/**
 * The trailer director: a scripted, tick-gated "player" for the
 * gameplay trailer. Owns no sim state — it observes the world and
 * issues commands through the queue, exactly like the demo director.
 */
export class TrailerDirector {
  readonly session: GameSession;
  /** Director-owned RNG (`trailer` stream): never touches `world.rng`. */
  readonly rng: RngBank;
  /** Every command the director successfully enqueued, in fire order. */
  readonly commandLog: TrailerCommandRecord[] = [];
  /** Loud enqueue failures (the test suite requires this to stay empty). */
  readonly failures: TrailerFailure[] = [];
  /** Storm-strike target (the AI base centroid at fire time). */
  stormTarget: { x: number; z: number };
  /** True once the movie has played out (the recorder stops). */
  done = false;

  private readonly chapters: Chapter[] = [];
  private fired = 0;
  /** Town site: 44×44 all-land cells near the human corner. */
  private readonly site: { cx: number; cz: number };
  /** Coastal site for the civilian harbors (set at construction). */
  private readonly coastSite: { cx: number; cz: number } | null;
  /** Second coastal site, for the shipyards (docks take the first). */
  private readonly yardSite: { cx: number; cz: number } | null;
  /** Airport district field, zoned by the 'airport-zone' chapter. */
  private airportField: { cx: number; cz: number } | null = null;
  /** Muster point for the field army (world coords). */
  private readonly musterPoint: { x: number; z: number };

  constructor(session: GameSession) {
    this.session = session;
    // The director's RNG derives from the session seed (a `&trailerseed=`
    // re-shoot gets its own deterministic stream, same as the world).
    this.rng = createRngBank(session.seed);
    // Human corner (-180, 180) → cell (38, 218).
    const site = findLandRect(session.terrain, 38, 218, TRAILER_SITE_SIZE, TRAILER_SITE_SIZE);
    if (site === null) {
      throw new Error(
        `TrailerDirector: no ${TRAILER_SITE_SIZE}x${TRAILER_SITE_SIZE} land rect near the human corner`,
      );
    }
    this.site = site;
    const town = cellWorld(site.cx + TRAILER_SITE_SIZE / 2, site.cz + TRAILER_SITE_SIZE / 2);
    this.coastSite = findCoastRect(session.terrain, site.cx + 22, site.cz + 22, 14, 10);
    // The shipyards get their own coastal frontage — one rect can't fit
    // four coastal footprints. Start the spiral on the far side so the
    // two rects don't coincide.
    this.yardSite = findCoastRect(session.terrain, site.cx - 40, site.cz - 10, 14, 10);
    this.musterPoint = findLandPoint(session.terrain, town.x - 60, town.z + 40);
    this.stormTarget = this.aiCentroid();
    this.buildChapters();
  }

  /** Trailer town center in world coords (camera anchor). */
  get townCenter(): { x: number; z: number } {
    return cellWorld(this.site.cx + TRAILER_SITE_SIZE / 2, this.site.cz + TRAILER_SITE_SIZE / 2);
  }

  /** Chapters not yet fired. */
  get pendingChapters(): number {
    return this.chapters.length - this.fired;
  }

  /** Fire every chapter whose tick has arrived. Never throws. */
  update(): void {
    const world = this.session.world;
    while (this.fired < this.chapters.length && this.chapters[this.fired]!.tick <= world.tick) {
      const chapter = this.chapters[this.fired]!;
      this.fired += 1;
      try {
        chapter.run(this);
      } catch (e) {
        // Chapters only throw on unexpected bugs (enqueue rejections
        // are caught inside `issue`). A throwing chapter must never kill
        // the trailer loop — record it loudly and continue the movie.
        const reason = e instanceof Error ? e.message : String(e);
        this.failures.push({ tick: world.tick, chapter: chapter.name, kind: 'chapter', reason });
        console.error(`[trailer] chapter '${chapter.name}' failed: ${reason}`);
      }
    }
  }

  /** Enqueue one director order; rejections are recorded loudly, never swallowed. */
  issue(chapter: string, intent: OrderIntent): void {
    const world = this.session.world;
    const cmd: NewCommand = { ...intent, issuer: TRAILER_ISSUER };
    try {
      this.session.queue.enqueue(world, cmd);
      this.commandLog.push({ tick: world.tick, kind: cmd.kind });
    } catch (e) {
      const reason = e instanceof CommandRejectedError ? e.message : String(e);
      this.failures.push({ tick: world.tick, chapter, kind: cmd.kind, reason });
      console.error(`[trailer] chapter '${chapter}' order '${cmd.kind}' rejected: ${reason}`);
    }
  }

  /** Record a loud planner failure (no valid spot, missing prerequisite). */
  fail(chapter: string, kind: string, reason: string): void {
    this.failures.push({ tick: this.session.world.tick, chapter, kind, reason });
    console.error(`[trailer] chapter '${chapter}' could not issue '${kind}': ${reason}`);
  }

  /**
   * Centroid of the AI rival's live units (its base estimate). The cadet
   * AI never attacks, so its rifles sit near its corner — the battle
   * staging point and the storm target derive from this. Pure world
   * state ⇒ deterministic.
   */
  aiCentroid(): { x: number; z: number } {
    const foes = this.session.world.units.filter((u) => u.owner === AI_PLAYER_ID);
    if (foes.length === 0) {
      return findLandPoint(this.session.terrain, 180, -180);
    }
    let x = 0;
    let z = 0;
    for (const u of foes) {
      x += u.x;
      z += u.z;
    }
    return { x: x / foes.length, z: z / foes.length };
  }

  /**
   * Camera anchors resolved from live world state (per tick). Every
   * anchor always resolves — subjects that do not exist yet fall back
   * to a sensible parent ('freighter' → 'harbor', 'army' → 'town').
   */
  cameraAnchors(): TrailerAnchors {
    const world = this.session.world;
    const town = this.townCenter;
    const toVec = (p: { x: number; z: number }): Vec3 => ({ x: p.x, y: 0, z: p.z });
    let harbor = toVec(town);
    if (this.coastSite !== null) {
      const hw = cellWorld(this.coastSite.cx + 7, this.coastSite.cz + 5);
      harbor = toVec(hw);
    }
    const freighter = world.units.find(
      (u) => u.owner === TRAILER_OWNER && u.kind === 'cargoFreighter',
    );
    const armyUnits = world.units.filter(
      (u) => u.owner === TRAILER_OWNER && (TRAILER_COMBAT_KINDS as readonly string[]).includes(u.kind),
    );
    let army = toVec(town);
    if (armyUnits.length > 0) {
      let x = 0;
      let z = 0;
      for (const u of armyUnits) {
        x += u.x;
        z += u.z;
      }
      army = { x: x / armyUnits.length, y: 0, z: z / armyUnits.length };
    }
    return {
      town: toVec(town),
      harbor,
      freighter: freighter !== undefined ? { x: freighter.x, y: 0, z: freighter.z } : harbor,
      army,
      stormTarget: toVec(this.stormTarget),
      mapCenter: { x: 0, y: 0, z: 0 },
    };
  }

  // ------------------------------------------------------------------
  // Site planning (deterministic; runs at chapter fire time against the
  // live world, so auto-developed buildings and earlier chapters are
  // always accounted for). Mirrors the demo director's planner — the
  // trailer's script (coastal harbors, AI battle) diverges enough to
  // warrant its own class, but the placement math is the same validated
  // search.
  // ------------------------------------------------------------------

  /**
   * First valid footprint for `kind` in a row-major scan of the given
   * cell rect, validated by the REAL placement validator. `reserved`
   * holds footprints this chapter already claimed (same-tick commands
   * apply in seq order, so the world can't see them yet). Returns null
   * when nothing fits.
   */
  planBuilding(
    kind: BuildingKind,
    x0: number,
    z0: number,
    w: number,
    h: number,
    reserved: ReservedRect = [],
  ): { cx: number; cz: number } | null {
    const def = BUILDING_DEFS[kind];
    const world = this.session.world;
    const terrain = this.session.terrain;
    for (let dz = 0; dz <= h - def.footprintH; dz += 1) {
      dxLoop: for (let dx = 0; dx <= w - def.footprintW; dx += 1) {
        const cx = x0 + dx;
        const cz = z0 + dz;
        for (const r of reserved) {
          if (cx < r.cx + r.w && r.cx < cx + def.footprintW && cz < r.cz + r.h && r.cz < cz + def.footprintH) {
            continue dxLoop;
          }
        }
        const reason = validatePlacement(terrain, world.city, {
          kind,
          owner: TRAILER_OWNER,
          cx,
          cz,
          facing: 0,
        });
        if (reason === null) return { cx, cz };
      }
    }
    return null;
  }

  /**
   * Claim a validated footprint for `kind` at a planner-chosen spot and
   * enqueue the placement. Falls back to a whole-site search when the
   * quarter is full (organic zone growth got there first).
   */
  placeClaimed(
    chapter: string,
    kind: BuildingKind,
    x0: number,
    z0: number,
    w: number,
    h: number,
    reserved: ReservedRect,
  ): boolean {
    const def = BUILDING_DEFS[kind];
    let spot = this.planBuilding(kind, x0, z0, w, h, reserved);
    if (!spot) {
      const s = this.site;
      spot = this.planBuilding(kind, s.cx, s.cz, TRAILER_SITE_SIZE, TRAILER_SITE_SIZE, reserved);
    }
    if (!spot) {
      this.fail(chapter, 'placeBuilding', `no valid ${kind} spot`);
      return false;
    }
    reserved.push({ cx: spot.cx, cz: spot.cz, w: def.footprintW, h: def.footprintH });
    this.issue(chapter, buildPlaceBuildingOrder(kind, TRAILER_OWNER, spot.cx, spot.cz));
    return true;
  }

  /**
   * The script. A ~7,400-tick (~4 minute) cinematic: a dense,
   * battle-bearing cut of the city-building arc. Chapter ticks are
   * fixed; build-time pads are generous (a 150s Storm Array placed at
   * 2120 completes at 6620, well before the 6800 strike).
   *
   * Ages advance fast — the trailer is a time-lapse: foundation →
   * connectivity (620) → industry (1100) → information (1580) →
   * ascendance (2060), each unlocking the wave that follows it.
   */
  private buildChapters(): void {
    const s = this.site;
    const add = (tick: number, name: string, run: (d: TrailerDirector) => void): void => {
      this.chapters.push({ tick, name, run });
    };
    const RES = { x: s.cx, z: s.cz, w: 20, h: 14 };
    const COM = { x: s.cx + 20, z: s.cz, w: 24, h: 12 };
    const CIV = { x: s.cx + 20, z: s.cz + 12, w: 16, h: 6 };
    const IND = { x: s.cx, z: s.cz + 20, w: 44, h: 24 };
    const UTL = { x: s.cx, z: s.cz + 20, w: 20, h: 16 };

    /** Claim `kind` inside a quarter rect and enqueue the placement. */
    const place = (
      d: TrailerDirector,
      chapter: string,
      kind: BuildingKind,
      q: { x: number; z: number; w: number; h: number },
      reserved: ReservedRect,
    ): void => {
      d.placeClaimed(chapter, kind, q.x, q.z, q.w, q.h, reserved);
    };

    // -- BUILD ----------------------------------------------------------
    add(90, 'zones', (d) => {
      d.issue('zones', buildZoneOrder(TRAILER_OWNER, ZoneType.RESIDENTIAL, RES.x, RES.z, RES.x + RES.w - 1, RES.z + RES.h - 1));
      d.issue('zones', buildZoneOrder(TRAILER_OWNER, ZoneType.COMMERCIAL, COM.x, COM.z, COM.x + COM.w - 1, COM.z + COM.h - 1));
      d.issue('zones', buildZoneOrder(TRAILER_OWNER, ZoneType.INDUSTRIAL, IND.x, IND.z, IND.x + IND.w - 1, IND.z + IND.h - 1));
    });

    add(200, 'roads', (d) => {
      const mainCells = walkCells(s.cx, s.cz + 15, s.cx + TRAILER_SITE_SIZE - 1, s.cz + 15);
      const mainSet = new Set(mainCells);
      const main = mainCells.filter((c) => !buildingAtCell(d.session.world.city, c));
      if (main.length > 0) d.issue('roads', buildRoadOrder(TRAILER_OWNER, main));
      const cross = walkCells(s.cx + 15, s.cz, s.cx + 15, s.cz + TRAILER_SITE_SIZE - 1)
        .filter((c) => !mainSet.has(c) && !buildingAtCell(d.session.world.city, c));
      if (cross.length > 0) d.issue('roads', buildRoadOrder(TRAILER_OWNER, cross));
    });

    add(320, 'founding', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'founding', 'house', RES, reserved);
      place(d, 'founding', 'house', RES, reserved);
      place(d, 'founding', 'house', RES, reserved);
      place(d, 'founding', 'shop', COM, reserved);
      place(d, 'founding', 'shop', COM, reserved);
      place(d, 'founding', 'factory', IND, reserved);
      place(d, 'founding', 'factory', IND, reserved);
    });

    add(430, 'utilities', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'utilities', 'powerPlant', UTL, reserved);
      place(d, 'utilities', 'waterPump', UTL, reserved);
    });

    add(540, 'conductors', (d) => {
      const world = d.session.world;
      const plant = world.city.buildings.find((b) => b.kind === 'powerPlant' && b.owner === TRAILER_OWNER);
      const pump = world.city.buildings.find((b) => b.kind === 'waterPump' && b.owner === TRAILER_OWNER);
      if (plant) {
        const line = walkCells(plant.cx, plant.cz, s.cx + 24, s.cz + 10)
          .filter((c) => !buildingAtCell(world.city, c));
        if (line.length > 0) d.issue('conductors', buildPowerLineOrder(TRAILER_OWNER, line));
      } else {
        d.fail('conductors', 'buildPowerLine', 'powerPlant not placed yet');
      }
      if (pump) {
        const pipe = walkCells(pump.cx, pump.cz, s.cx + 24, s.cz + 10)
          .filter((c) => !buildingAtCell(world.city, c));
        if (pipe.length > 0) d.issue('conductors', buildWaterPipeOrder(TRAILER_OWNER, pipe));
      } else {
        d.fail('conductors', 'buildPipe', 'waterPump not placed yet');
      }
    });

    add(620, 'age-connectivity', (d) => {
      d.issue('age-connectivity', buildAdvanceAgeOrder(TRAILER_OWNER, 'fiberGrid'));
    });

    add(740, 'downtown', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'downtown', 'market', COM, reserved);
      place(d, 'downtown', 'school', CIV, reserved);
      place(d, 'downtown', 'park', CIV, reserved);
      place(d, 'downtown', 'farm', IND, reserved);
      place(d, 'downtown', 'farm', IND, reserved);
    });

    add(860, 'power-air', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'power-air', 'solarFarm', UTL, reserved);
      place(d, 'power-air', 'airfield', IND, reserved);
      place(d, 'power-air', 'busDepot', IND, reserved);
    });

    add(980, 'civ-support', (d) => {
      // The supply truck needs no production building.
      const at = cellWorld(s.cx + 24, s.cz + 28);
      d.issue('civ-support', buildTrainOrder('supplyTruck', TRAILER_OWNER, at.x, at.z));
    });

    // -- COMMAND --------------------------------------------------------
    add(1100, 'age-industry', (d) => {
      d.issue('age-industry', buildAdvanceAgeOrder(TRAILER_OWNER, 'heavyIndustry'));
    });

    add(1160, 'war-factories', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'war-factories', 'barracks', IND, reserved);
      place(d, 'war-factories', 'warFactory', IND, reserved);
      place(d, 'war-factories', 'fuelDepot', UTL, reserved);
    });

    add(1280, 'war-economy', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'war-economy', 'oilWell', UTL, reserved);
      place(d, 'war-economy', 'oilRefinery', IND, reserved);
    });

    add(1320, 'airport-zone', (d) => {
      // The airport district's AIRPORT zone, east of town. Painted a
      // chapter ahead of the buildings — zone orders land on the tick,
      // and placement validates against the painted zone.
      const t = d.session.terrain;
      const field = findLandRect(t, s.cx + TRAILER_SITE_SIZE + 6, s.cz + 6, 18, 12);
      if (field === null) {
        d.fail('airport-zone', 'paintZone', 'no land for the airport district');
        return;
      }
      d.airportField = field;
      d.issue('airport-zone', buildZoneOrder(
        TRAILER_OWNER, ZoneType.AIRPORT, field.cx, field.cz, field.cx + 17, field.cz + 11,
      ));
    });

    add(1400, 'airports', (d) => {
      // Two Civil Airports (civilian airportType — the only kind airline
      // routes anchor at; the Airport Interchange has no airportType).
      // 90s builds → complete 4100, ahead of the 4160 airline chapter.
      const field = d.airportField;
      if (field === null) {
        d.fail('airports', 'placeBuilding', 'no airport district zoned');
        return;
      }
      const reserved: ReservedRect = [];
      d.placeClaimed('airports', 'civilAirport', field.cx, field.cz, 18, 12, reserved);
      d.placeClaimed('airports', 'civilAirport', field.cx, field.cz, 18, 12, reserved);
    });

    add(1940, 'industry2', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'industry2', 'factory', IND, reserved);
      place(d, 'industry2', 'factory', IND, reserved);
      place(d, 'industry2', 'quarry', IND, reserved);
      place(d, 'industry2', 'munitionsFactory', IND, reserved);
    });

    add(2000, 'transit', (d) => {
      // Bus depot (placed 860 + 35s build) is complete.
      const at = cellWorld(s.cx + 8, s.cz + 4);
      d.issue('transit', buildTrainOrder('bus', TRAILER_OWNER, at.x, at.z));
      d.issue('transit', buildTrainOrder('tram', TRAILER_OWNER, at.x + 6, at.z));
    });

    add(2420, 'rifles', (d) => {
      // Barracks (placed 1160 + 40s build) is complete.
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('rifles', buildTrainOrder('rifles', TRAILER_OWNER, at.x, at.z));
      d.issue('rifles', buildTrainOrder('rifles', TRAILER_OWNER, at.x + 6, at.z));
      d.issue('rifles', buildTrainOrder('rifles', TRAILER_OWNER, at.x + 12, at.z));
      d.issue('rifles', buildTrainOrder('rifles', TRAILER_OWNER, at.x + 18, at.z));
    });

    add(3020, 'armor', (d) => {
      // War factory (placed 1160 + 60s build) is complete.
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('armor', buildTrainOrder('tank', TRAILER_OWNER, at.x, at.z));
      d.issue('armor', buildTrainOrder('artillery', TRAILER_OWNER, at.x + 6, at.z));
      d.issue('armor', buildTrainOrder('apc', TRAILER_OWNER, at.x + 12, at.z));
    });

    add(3080, 'muster', (d) => {
      // March the field army to the muster point outside town (the
      // skirmish's own starting rifles join the parade — same seed,
      // same troops).
      const world = d.session.world;
      const ids = world.units
        .filter((u) => u.owner === TRAILER_OWNER && (TRAILER_COMBAT_KINDS as readonly string[]).includes(u.kind))
        .map((u) => u.id);
      if (ids.length === 0) {
        d.fail('muster', 'moveGroup', 'no combat units found');
        return;
      }
      d.issue('muster', buildMoveOrder(ids, TRAILER_OWNER, d.musterPoint.x, d.musterPoint.z));
      // The supply truck runs a patrol to burn fuel (logistics flavor).
      const truck = world.units.find((u) => u.owner === TRAILER_OWNER && u.kind === 'supplyTruck');
      if (truck) {
        const town = d.townCenter;
        const dest = findLandPoint(d.session.terrain, town.x + 200, town.z - 60);
        d.issue('muster', buildMoveOrder([truck.id], TRAILER_OWNER, dest.x, dest.z));
      }
    });

    // -- OUTTHINK -------------------------------------------------------
    add(1580, 'age-information', (d) => {
      d.issue('age-information', buildAdvanceAgeOrder(TRAILER_OWNER, 'cyberCommand'));
    });

    add(1640, 'outthink-build', (d) => {
      const reserved: ReservedRect = [];
      place(d, 'outthink-build', 'airportInterchange', COM, reserved);
      place(d, 'outthink-build', 'university', CIV, reserved);
      place(d, 'outthink-build', 'lab', COM, reserved);
      place(d, 'outthink-build', 'radarStation', CIV, reserved);
      place(d, 'outthink-build', 'intelHQ', UTL, reserved);
    });

    add(1760, 'air-wing', (d) => {
      // Drones need no production building; fighters wait for the
      // airfield (placed 860 + 75s build → complete 3110).
      const at = cellWorld(s.cx + 8, s.cz + 4);
      d.issue('air-wing', buildTrainOrder('drone', TRAILER_OWNER, at.x, at.z));
      d.issue('air-wing', buildTrainOrder('drone', TRAILER_OWNER, at.x + 6, at.z));
    });

    add(3200, 'fighters', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 4);
      d.issue('fighters', buildTrainOrder('fighter', TRAILER_OWNER, at.x, at.z));
      d.issue('fighters', buildTrainOrder('fighter', TRAILER_OWNER, at.x + 6, at.z));
    });

    add(3400, 'spy', (d) => {
      // Intel HQ (placed 1640 + 55s build) is complete.
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('spy', buildTrainOrder('spy', TRAILER_OWNER, at.x, at.z));
    });

    // -- TRADE ----------------------------------------------------------
    add(1700, 'harbors', (d) => {
      // Two Commercial Docks (the trade-dock interface sea routes anchor
      // at) plus one civilian shipyard (builds both freighters — the
      // freighter's requiredBuilding gate needs the real shipyard kind;
      // a dock's countsAs:['shipyard'] doesn't cover it). Each gets its
      // own coastal frontage. 45s/50s builds → complete by 3200, ahead of
      // the 3260 sea-route chapter. (The shipyard is NOT a trade dock —
      // it builds ships, it doesn't trade.)
      if (d.coastSite === null || d.yardSite === null) {
        d.fail('harbors', 'placeBuilding', 'no coastal site found');
        return;
      }
      const reserved: ReservedRect = [];
      const c = d.coastSite;
      d.placeClaimed('harbors', 'commercialPort', c.cx, c.cz, 14, 10, reserved);
      d.placeClaimed('harbors', 'commercialPort', c.cx, c.cz, 14, 10, reserved);
      const y = d.yardSite;
      d.placeClaimed('harbors', 'commercialHarbor', y.cx, y.cz, 14, 10, reserved);
    });

    add(3260, 'searoute', (d) => {
      const docks = d.session.world.city.buildings.filter(
        (b) => b.owner === TRAILER_OWNER && b.kind === 'commercialPort' && b.progress >= 1,
      );
      if (docks.length < 2) {
        d.fail('searoute', 'establishSeaRoute', `only ${docks.length} completed trade docks`);
        return;
      }
      d.issue('searoute', buildEstablishSeaRouteOrder(TRAILER_OWNER, docks[0]!.id, docks[1]!.id, 'funds'));
    });

    add(3320, 'freighters', (d) => {
      // Cargo freighters spawn in open water beside the shipyard (sea
      // units reject land spawns; the yard must be complete). One yard
      // builds both freighters.
      const t = d.session.terrain;
      const harbors = d.session.world.city.buildings.filter(
        (b) => b.owner === TRAILER_OWNER && b.kind === 'commercialHarbor' && b.progress >= 1,
      );
      if (harbors.length < 1) {
        d.fail('freighters', 'spawnUnit', 'no completed shipyard');
        return;
      }
      const hw = cellWorld(harbors[0]!.cx + 2, harbors[0]!.cz + 1);
      for (let i = 0; i < 2; i += 1) {
        const spawn = findWaterPoint(t, hw.x + i * 10, hw.z);
        d.issue('freighters', buildTrainOrder('cargoFreighter', TRAILER_OWNER, spawn.x, spawn.z));
      }
    });

    add(3440, 'assign', (d) => {
      const world = d.session.world;
      const route = world.city.seaRoutes.find((r) => r.owner === TRAILER_OWNER);
      if (!route) {
        d.fail('assign', 'assignSeaRoute', 'no sea route found');
        return;
      }
      const ships = world.units.filter(
        (u) => u.owner === TRAILER_OWNER && u.kind === 'cargoFreighter',
      );
      if (ships.length === 0) {
        d.fail('assign', 'assignSeaRoute', 'no freighters found');
        return;
      }
      for (const ship of ships) {
        d.issue('assign', buildAssignSeaRouteOrder(TRAILER_OWNER, ship.id, route.id));
      }
    });

    add(4160, 'airline', (d) => {
      // Both Civil Airports (placed 1400 + 90s build) are complete.
      // Airline routes anchor at civil/mixed airports only.
      const world = d.session.world;
      const airports = world.city.buildings.filter(
        (b) => b.owner === TRAILER_OWNER && b.kind === 'civilAirport' && b.progress >= 1,
      );
      if (airports.length < 2) {
        d.fail('airline', 'establishAirlineRoute', `only ${airports.length} completed airports`);
        return;
      }
      d.issue('airline', buildEstablishAirlineRouteOrder(TRAILER_OWNER, airports[0]!.id, airports[1]!.id));
    });

    // -- ENDURE ---------------------------------------------------------
    add(2060, 'age-ascendance', (d) => {
      d.issue('age-ascendance', buildAdvanceAgeOrder(TRAILER_OWNER, 'arsenalProgram'));
    });

    add(2120, 'storm-array', (d) => {
      // The 150s Storm Array completes at 6620, ahead of the 6800
      // strike; the Aegis Control (120s) at 5720.
      const reserved: ReservedRect = [];
      const array = d.planBuilding('stormArray', s.cx, s.cz, TRAILER_SITE_SIZE, TRAILER_SITE_SIZE, reserved);
      if (array) {
        reserved.push({ cx: array.cx, cz: array.cz, w: 4, h: 4 });
        d.issue('storm-array', buildPlaceBuildingOrder('stormArray', TRAILER_OWNER, array.cx, array.cz));
      } else {
        d.fail('storm-array', 'placeBuilding', 'no valid stormArray spot');
      }
      place(d, 'storm-array', 'aegisControl', UTL, reserved);
    });

    add(4400, 'forward-base', (d) => {
      // March the field army to a staging point near the AI base. The
      // cadet AI never attacks, so the staging is unopposed — the
      // battle starts on the director's order at 6200.
      const world = d.session.world;
      const ids = world.units
        .filter((u) => u.owner === TRAILER_OWNER && (TRAILER_COMBAT_KINDS as readonly string[]).includes(u.kind))
        .map((u) => u.id);
      if (ids.length === 0) {
        d.fail('forward-base', 'moveGroup', 'no combat units found');
        return;
      }
      const foe = d.aiCentroid();
      const town = d.townCenter;
      // Stage ~130 units out from the AI centroid, on the town side.
      const dx = town.x - foe.x;
      const dz = town.z - foe.z;
      const len = Math.hypot(dx, dz) || 1;
      const staging = findLandPoint(
        d.session.terrain,
        foe.x + (dx / len) * 130,
        foe.z + (dz / len) * 130,
      );
      d.issue('forward-base', buildMoveOrder(ids, TRAILER_OWNER, staging.x, staging.z));
    });

    add(5900, 'elite', (d) => {
      // Late-war reinforcements (industry-age armor, ascendance air).
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('elite', buildTrainOrder('tankDestroyer', TRAILER_OWNER, at.x, at.z));
      d.issue('elite', buildTrainOrder('mlrs', TRAILER_OWNER, at.x + 6, at.z));
      d.issue('elite', buildTrainOrder('fighterBomber', TRAILER_OWNER, at.x + 12, at.z));
      d.issue('elite', buildTrainOrder('rifles', TRAILER_OWNER, at.x + 18, at.z));
      d.issue('elite', buildTrainOrder('rifles', TRAILER_OWNER, at.x + 24, at.z));
    });

    add(6200, 'assault', (d) => {
      // The battle: real attack orders against the AI's fielded rifles.
      // The cadet AI never attacks first, so this is the war's opening
      // shot — every attacker paths into range and opens fire for real.
      const world = d.session.world;
      const attackers = world.units.filter(
        (u) => u.owner === TRAILER_OWNER && (TRAILER_COMBAT_KINDS as readonly string[]).includes(u.kind),
      );
      const targets = world.units.filter((u) => u.owner === AI_PLAYER_ID && (u.hp ?? 1) > 0);
      if (attackers.length === 0) {
        d.fail('assault', 'attackUnit', 'no attackers found');
        return;
      }
      if (targets.length === 0) {
        d.fail('assault', 'attackUnit', 'no AI targets found');
        return;
      }
      attackers.forEach((attacker, i) => {
        const target = targets[i % targets.length]!;
        for (const intent of buildAttackOrders([attacker.id], TRAILER_OWNER, target.id)) {
          d.issue('assault', intent);
        }
      });
    });

    add(6800, 'storm-strike', (d) => {
      // The finale: a storm strike on the AI base. Storm Array (placed
      // 2120 + 150s build) is complete. The camera swings wide for it.
      d.stormTarget = d.aiCentroid();
      d.issue('storm-strike', buildFireStormOrder(TRAILER_OWNER, d.stormTarget.x, d.stormTarget.z));
    });

    add(TRAILER_END_TICK, 'finale', (d) => {
      // Hold the closing shot, then signal the recorder to stop.
      d.done = true;
    });

    // Chapters are authored grouped by beat (BUILD/COMMAND/…) but the
    // fire loop consumes them in array order — sort by tick so a later
    // beat's early chapter can't stall an earlier beat's late one.
    this.chapters.sort((a, b) => a.tick - b.tick);
  }
}
