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
 * NOVATERRA — ui/demoDirector.ts — the living-menu demo director
 * (workstream X, 2026-09-30).
 *
 * Responsibilities:
 *  - Build a DISPOSABLE demo world: `createDemoSession()` wraps the
 *    canonical `createSession()` (sandbox, no AI rival — the director is
 *    the sole author of the movie) and grants an opening stockpile.
 *    The stockpile is UI-owned setup, the campaign `startingResources`
 *    precedent: a real player earns their funds, a mission/demonstration
 *    opens with a designed stockpile. Every subsequent change goes
 *    through the real command queue — no sim special-casing anywhere.
 *  - `DemoDirector` issues orders the way a player would, at human-like
 *    pacing: paint zones, build roads, place buildings, drag power
 *    lines/pipes, train units, run resupplies, advance the ages, and
 *    finish with a storm strike. The movie is paced against the menu
 *    camera's orbit (angle a = tick * 0.0011 rad/tick → one orbit =
 *    2π/0.0011 ≈ 5,712 ticks): orbit 0 founds the town, each later
 *    orbit adds a visible wave (neighborhood, Connectivity age, air
 *    power, Industry age, transit, Information age, military buildup,
 *    Ascendance age), and the storm finale lands on orbit 9 — the full
 *    movie runs ~59,400 ticks (~10.4 orbits) before the menu restarts
 *    it. Each chapter fires at a fixed world tick and enqueues through
 *    the SAME queue the UI uses, with `issuer: 'demo'` —
 *    validate-at-enqueue AND validate-at-apply both run, exactly as
 *    for player orders.
 *  - Rejections are never swallowed: an enqueue failure is recorded in
 *    `failures` and logged loudly (the menu loop keeps running), and
 *    the test suite asserts `failures` stays empty for the whole movie.
 *
 * Determinism (non-negotiable):
 *  - Same `DEMO_SEED` → same movie. Chapters fire on `world.tick`
 *    only — never on frame count or wall clock — so a slow frame only
 *    delays the movie, never reorders it.
 *  - The director's own randomness comes from a dedicated `demo`
 *    stream on a director-owned `createRngBank(DEMO_SEED)` — it is NOT
 *    the world's bank, so `world.rng` never gains a `demo` stream and
 *    real-game snapshots/digests are untouched (pinned by test).
 *  - No `Math.random`, no `Date.now`, no DOM, no three.js — headless
 *    safe, fully covered by `tests/ui.demoDirector.test.ts`.
 *
 * Disposability guarantee:
 *  - The demo session is created only by the menu boot path
 *    (`game/src/main.ts`). `startGame()` (ui/game.ts) ALWAYS builds its
 *    own world via `createSession()` — it cannot receive the demo
 *    session, so entering a game discards the demo completely. The
 *    menu nulls its demo reference on game start. Pinned by test:
 *    a fresh session after a demo run digests identically to a
 *    pristine one, with default starting stocks (no stockpile leak).
 *
 * Cost (measured in Node on this VM's class of machine, 2026-09-30 —
 * pinned by the cost test in tests/ui.demoDirector.test.ts):
 *  - Session creation (terrain + world + starting forces): ~50 ms,
 *    one-time, dominated by terrain gen (the static backdrop already
 *    paid the same cost every boot).
 *  - Sim: the full 60,001-tick movie runs in ~10 s (~0.17 ms/tick);
 *    the menu steps at most 6 ticks/frame behind an 8 ms wall-clock
 *    cap, so the demo can never stall menu rendering.
 *  - Render: entity count stays modest (~68 scripted buildings plus
 *    auto-developed zone growth, ~35 units at the finale); the
 *    per-kind instanced renderer draws O(kinds), not O(entities).
 */

import { createRngBank, type RngBank } from '../sim/rng';
import type { TerrainData } from '../sim/terrain';
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
import { createSession, HUMAN_PLAYER_ID, type GameSession } from './session';
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
  buildResupplyOrder,
  type OrderIntent,
} from './orders';

/** Fixed seed: the menu plays the same movie on every boot. */
export const DEMO_SEED = 0xde407;
/** Town site: a SITE_SIZE×SITE_SIZE all-land rect near the human corner. */
export const DEMO_SITE_SIZE = 44;
/** Command issuer stamped on every director order (cf. 'player', 'ai-setup'). */
export const DEMO_ISSUER = 'demo';
/** The demo world is built on this map preset (canonical terrain seed). */
export const DEMO_MAP_PRESET = 'Meridian Plains';
/** Owner the director builds for (the human slot, like a player). */
export const DEMO_OWNER = HUMAN_PLAYER_ID;

/**
 * Opening stockpile for the demo player. UI-owned setup, granted once
 * before tick 0 — the campaign `startingResources` precedent. It funds
 * the scripted arc: ~111,000 funds / ~43,000 materials of buildings,
 * units, zones, roads and conductors, four age advances (46,000 funds /
 * 18,700 materials / 850 influence), and ~2000 sim-seconds of building
 * upkeep on a city that grows to ~75 scripted buildings. Everything
 * after setup flows through validated commands and the live economy.
 */
export const DEMO_OPENING_STOCKPILE = {
  funds: 220000,
  materials: 60000,
  fuel: 6000,
  food: 4000,
  research: 0,
  goods: 2000,
  influence: 2000,
  manpower: 300,
} as const;

/**
 * Create the disposable demo world. Sandbox (no AI rival — the director
 * is the sole author), deterministic in DEMO_SEED.
 */
export function createDemoSession(): GameSession {
  const session = createSession({
    seed: DEMO_SEED,
    mapPreset: DEMO_MAP_PRESET,
    sandbox: true,
  });
  // Campaign-style opening grant: assignment (not addition) keeps this
  // module the single source of truth for the demo's opening stocks.
  const player = session.world.city.players[DEMO_OWNER];
  if (player === undefined) {
    throw new Error('createDemoSession: demo player missing from fresh session');
  }
  for (const [key, value] of Object.entries(DEMO_OPENING_STOCKPILE)) {
    (player as unknown as Record<string, number>)[key] = value;
  }
  return session;
}

/** One enqueued director command (the determinism-test record). */
export interface DemoCommandRecord {
  /** World tick at fire time. */
  tick: number;
  /** Command kind, e.g. 'placeBuilding'. */
  kind: string;
}

/** A loud enqueue failure (never silent — surfaced to tests and console). */
export interface DemoFailure {
  tick: number;
  chapter: string;
  kind: string;
  reason: string;
}

/**
 * Nearest all-land W×H cell rectangle on a deterministic outward spiral
 * from (startCx, startCz). Pure search over static terrain — the same
 * rect for the same seed, every run.
 */
export function findLandRect(
  t: TerrainData,
  startCx: number,
  startCz: number,
  w: number,
  h: number,
): { cx: number; cz: number } | null {
  for (let r = 0; r <= 120; r += 2) {
    for (let a = 0; a < 16; a += 1) {
      const cx = startCx + Math.round(Math.cos((a / 16) * 2 * Math.PI) * r);
      const cz = startCz + Math.round(Math.sin((a / 16) * 2 * Math.PI) * r);
      // Stay inside the city grid (the terrain is bigger than the sim's
      // 256×256 city — an out-of-range rect passes the water check but
      // fails placement/paint validation).
      if (cx < 0 || cz < 0 || cx + w > CITY_GRID_CELLS || cz + h > CITY_GRID_CELLS) continue;
      let ok = true;
      for (let dz = 0; dz < h && ok; dz += 1) {
        for (let dx = 0; dx < w && ok; dx += 1) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  return null;
}

/**
 * Nearest land cell to a world point, deterministic spiral. Used for
 * unit waypoints and spawn points (land units reject water spawns).
 */
export function findLandPoint(
  t: TerrainData,
  x: number,
  z: number,
): { x: number; z: number } {
  for (let r = 0; r <= 160; r += 4) {
    for (let a = 0; a < 8; a += 1) {
      const px = x + Math.cos((a / 8) * 2 * Math.PI) * r;
      const pz = z + Math.sin((a / 8) * 2 * Math.PI) * r;
      if (Math.abs(px) > MAP_HALF_SIZE - 8 || Math.abs(pz) > MAP_HALF_SIZE - 8) continue;
      const cx = Math.floor((px + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
      const cz = Math.floor((pz + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
      if (!cellIsWater(t, cx, cz)) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/**
 * 8-connected walk of cell indices from (cx0, cz0) to (cx1, cz1).
 * Deterministic; used for roads, power lines and pipes.
 */
export function walkCells(
  cx0: number,
  cz0: number,
  cx1: number,
  cz1: number,
): number[] {
  const cells: number[] = [];
  let cx = cx0;
  let cz = cz0;
  for (let i = 0; i < 600; i += 1) {
    cells.push(cellIndex(cx, cz));
    if (cx === cx1 && cz === cz1) break;
    if (cx < cx1) cx += 1;
    else if (cx > cx1) cx -= 1;
    if (cz < cz1) cz += 1;
    else if (cz > cz1) cz -= 1;
  }
  return cells;
}

/** World coords of a cell's center. */
export function cellWorld(cx: number, cz: number): { x: number; z: number } {
  return {
    x: (cx + 0.5) * CELL_WORLD_SIZE - MAP_HALF_SIZE,
    z: (cz + 0.5) * CELL_WORLD_SIZE - MAP_HALF_SIZE,
  };
}

interface Chapter {
  /** World tick at which the chapter fires. */
  tick: number;
  /** Short name for failure reports and the command log. */
  name: string;
  run(d: DemoDirector): void;
}

/**
 * The demo director: a scripted, tick-gated "player" for the menu
 * backdrop. Owns no sim state — it observes the world and issues
 * commands through the queue, exactly like the campaign director.
 */
export class DemoDirector {
  readonly session: GameSession;
  /** Director-owned RNG (`demo` stream): never touches `world.rng`. */
  readonly rng: RngBank;
  /** Every command the director successfully enqueued, in fire order. */
  readonly commandLog: DemoCommandRecord[] = [];
  /** Loud enqueue failures (the test suite requires this to stay empty). */
  readonly failures: DemoFailure[] = [];
  /** Camera focus in world coords (town early, storm target at the finale). */
  focus: { x: number; z: number };
  /** True once the movie has played out (the menu restarts the demo). */
  done = false;

  private readonly chapters: Chapter[] = [];
  private fired = 0;
  /** Town site: 44×44 all-land cells near the human corner. */
  private readonly site: { cx: number; cz: number };
  /** Storm-strike target (empty land away from the town). */
  private readonly stormTarget: { x: number; z: number };
  /** First fresh unit id seen before a training chapter (id tracking). */
  private rifleMark = 0;
  private truckMark = 0;
  private tankMark = 0;
  private droneMark = 0;
  private fighterMark = 0;
  private busMark = 0;
  private artilleryMark = 0;
  private mlrsMark = 0;
  private fuelTruckMark = 0;

  constructor(session: GameSession) {
    this.session = session;
    this.rng = createRngBank(DEMO_SEED);
    // Human corner (-180, 180) → cell (38, 218).
    const site = findLandRect(session.terrain, 38, 218, DEMO_SITE_SIZE, DEMO_SITE_SIZE);
    if (site === null) {
      throw new Error(`DemoDirector: no ${DEMO_SITE_SIZE}x${DEMO_SITE_SIZE} land rect near the human corner`);
    }
    this.site = site;
    const town = cellWorld(site.cx + DEMO_SITE_SIZE / 2, site.cz + DEMO_SITE_SIZE / 2);
    this.focus = { x: town.x, z: town.z };
    this.stormTarget = findLandPoint(session.terrain, town.x + 170, town.z - 120);
    this.buildChapters();
  }

  /** Demo town center in world coords (camera anchor for the menu). */
  get townCenter(): { x: number; z: number } {
    return cellWorld(this.site.cx + DEMO_SITE_SIZE / 2, this.site.cz + DEMO_SITE_SIZE / 2);
  }

  /** Chapters not yet fired (the 10-orbit test pins this above zero). */
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
        // the menu loop — record it loudly and continue the movie.
        const reason = e instanceof Error ? e.message : String(e);
        this.failures.push({ tick: world.tick, chapter: chapter.name, kind: 'chapter', reason });
        console.error(`[demo] chapter '${chapter.name}' failed: ${reason}`);
      }
    }
  }

  /** Enqueue one director order; rejections are recorded loudly, never swallowed. */
  issue(chapter: string, intent: OrderIntent): void {
    const world = this.session.world;
    const cmd: NewCommand = { ...intent, issuer: DEMO_ISSUER };
    try {
      this.session.queue.enqueue(world, cmd);
      this.commandLog.push({ tick: world.tick, kind: cmd.kind });
    } catch (e) {
      const reason = e instanceof CommandRejectedError ? e.message : String(e);
      this.failures.push({ tick: world.tick, chapter, kind: cmd.kind, reason });
      console.error(`[demo] chapter '${chapter}' order '${cmd.kind}' rejected: ${reason}`);
    }
  }

  // ------------------------------------------------------------------
  // Site planning (deterministic; runs at chapter fire time against the
  // live world, so auto-developed buildings and earlier chapters are
  // always accounted for).
  // ------------------------------------------------------------------

  /**
   * First valid footprint for `kind` in a row-major scan of the given
   * cell rect, validated by the REAL placement validator. `reserved`
   * holds footprints this chapter already claimed (same-tick commands
   * apply in seq order, so the world can't see them yet — without this
   * two buildings in one chapter could claim the same cells and the
   * second would fail loudly at apply time). Returns null when nothing
   * fits (the chapter then records a loud failure).
   */
  planBuilding(
    kind: BuildingKind,
    x0: number,
    z0: number,
    w: number,
    h: number,
    reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [],
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
            // Skip only this position, not the whole row: a reservation
            // at dx=0 must not poison every other dx in the same row.
            continue dxLoop;
          }
        }
        const reason = validatePlacement(terrain, world.city, {
          kind,
          owner: DEMO_OWNER,
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
   * enqueue the placement. `reserved` accumulates this chapter's claims
   * (see planBuilding). Returns false when no spot fit.
   */
  placeClaimed(
    chapter: string,
    kind: BuildingKind,
    x0: number,
    z0: number,
    w: number,
    h: number,
    reserved: Array<{ cx: number; cz: number; w: number; h: number }>,
  ): boolean {
    const def = BUILDING_DEFS[kind];
    let spot = this.planBuilding(kind, x0, z0, w, h, reserved);
    if (!spot) {
      // Quarter full (organic growth got there first) — fall back to a
      // whole-site search. Zone-locked kinds still land on matching
      // zoning (the validator enforces it); utility kinds go anywhere.
      const s = this.site;
      spot = this.planBuilding(kind, s.cx, s.cz, DEMO_SITE_SIZE, DEMO_SITE_SIZE, reserved);
    }
    if (!spot) {
      this.fail(chapter, 'placeBuilding', `no valid ${kind} spot`);
      return false;
    }
    reserved.push({ cx: spot.cx, cz: spot.cz, w: def.footprintW, h: def.footprintH });
    this.issue(chapter, buildPlaceBuildingOrder(kind, DEMO_OWNER, spot.cx, spot.cz));
    return true;
  }

  /**
   * The script. Chapter ticks are fixed; build-time pads are generous.
   *
   * The menu camera orbits with angle a = tick * 0.0011 rad/tick, so one
   * full orbit takes 2π/0.0011 ≈ 5,712 ticks (~190 sim-seconds). The
   * movie is paced so every orbit shows visible progress: founding on
   * orbit 0, a neighborhood wave on orbit 1, the Connectivity age on
   * orbit 2, air power + industry prelude on orbit 3, the Industry age
   * on orbit 4, transit + freight on orbit 5, the Information age on
   * orbit 6, a military buildup on orbit 7, the Ascendance age on
   * orbit 8, and the storm finale on orbit 9 — the loop restarts after
   * ~10.4 orbits (~59,400 ticks). Nothing is front-loaded: each age
   * unlocks the buildings and units of the orbits that follow it.
   */
  private buildChapters(): void {
    const s = this.site;
    const add = (tick: number, name: string, run: (d: DemoDirector) => void): void => {
      this.chapters.push({ tick, name, run });
    };
    // Town quarters inside the 44×44 site (search rects for the planner).
    // The industrial zone spans the whole southern half: the late-movie
    // industrial waves need big contiguous footprints and the organic
    // auto-growth fills zoned land for the entire movie.
    const RES = { x: s.cx, z: s.cz, w: 20, h: 14 }; // residential, NW
    const COM = { x: s.cx + 20, z: s.cz, w: 24, h: 12 }; // commercial, NE (wide: late big footprints)
    const CIV = { x: s.cx + 20, z: s.cz + 12, w: 16, h: 6 }; // civic band (unzoned)
    const IND = { x: s.cx, z: s.cz + 20, w: 44, h: 24 }; // industrial, whole south
    const UTL = { x: s.cx, z: s.cz + 20, w: 20, h: 16 }; // utilities, SW preference

    /** Claim `kind` inside a quarter rect and enqueue the placement. */
    const place = (
      d: DemoDirector,
      chapter: string,
      kind: BuildingKind,
      q: { x: number; z: number; w: number; h: number },
      reserved: Array<{ cx: number; cz: number; w: number; h: number }>,
    ): void => {
      d.placeClaimed(chapter, kind, q.x, q.z, q.w, q.h, reserved);
    };

    /** Train a unit and remember the id mark for later move orders. */
    const trainMarked = (
      d: DemoDirector,
      chapter: string,
      setMark: (id: number) => void,
      kind: string,
      x: number,
      z: number,
    ): void => {
      setMark(d.session.world.nextId);
      d.issue(chapter, buildTrainOrder(kind, DEMO_OWNER, x, z));
    };

    // -- Orbit 0: founding ------------------------------------------------
    add(30, 'zones', (d) => {
      // The whole site, zoned once: auto-development then grows the
      // town organically for the rest of the movie.
      d.issue('zones', buildZoneOrder(DEMO_OWNER, ZoneType.RESIDENTIAL, RES.x, RES.z, RES.x + RES.w - 1, RES.z + RES.h - 1));
      d.issue('zones', buildZoneOrder(DEMO_OWNER, ZoneType.COMMERCIAL, COM.x, COM.z, COM.x + COM.w - 1, COM.z + COM.h - 1));
      d.issue('zones', buildZoneOrder(DEMO_OWNER, ZoneType.INDUSTRIAL, IND.x, IND.z, IND.x + IND.w - 1, IND.z + IND.h - 1));
    });

    add(150, 'roads', (d) => {
      // A main street past the residential block, a second past industry.
      // The cross street skips the main street's cells: same-tick
      // commands apply in seq order, so it can't see them yet, and its
      // apply-time re-validation would reject the shared intersection.
      const mainCells = walkCells(s.cx, s.cz + 15, s.cx + DEMO_SITE_SIZE - 1, s.cz + 15);
      const mainSet = new Set(mainCells);
      const main = mainCells.filter((c) => !buildingAtCell(d.session.world.city, c));
      if (main.length > 0) d.issue('roads', buildRoadOrder(DEMO_OWNER, main));
      const cross = walkCells(s.cx + 15, s.cz, s.cx + 15, s.cz + DEMO_SITE_SIZE - 1)
        .filter((c) => !mainSet.has(c) && !buildingAtCell(d.session.world.city, c));
      if (cross.length > 0) d.issue('roads', buildRoadOrder(DEMO_OWNER, cross));
    });

    add(300, 'first-buildings', (d) => {
      // Two houses, a shop, a factory — the planner finds valid spots
      // (reservations keep same-chapter claims from colliding).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'first-buildings', 'house', RES, reserved);
      place(d, 'first-buildings', 'house', RES, reserved);
      place(d, 'first-buildings', 'shop', COM, reserved);
      place(d, 'first-buildings', 'factory', IND, reserved);
    });

    add(450, 'utilities', (d) => {
      // Foundation-age plant + pump (utility zone: no zoning needed).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'utilities', 'powerPlant', UTL, reserved);
      place(d, 'utilities', 'waterPump', UTL, reserved);
    });

    add(600, 'conductors', (d) => {
      // Hook the plants to the town: power line + water pipe runs.
      const world = d.session.world;
      const plant = world.city.buildings.find((b) => b.kind === 'powerPlant' && b.owner === DEMO_OWNER);
      const pump = world.city.buildings.find((b) => b.kind === 'waterPump' && b.owner === DEMO_OWNER);
      if (plant) {
        const line = walkCells(plant.cx, plant.cz, s.cx + 24, s.cz + 10)
          .filter((c) => !buildingAtCell(world.city, c));
        if (line.length > 0) d.issue('conductors', buildPowerLineOrder(DEMO_OWNER, line));
      } else {
        d.fail('conductors', 'buildPowerLine', 'powerPlant not placed yet');
      }
      if (pump) {
        const pipe = walkCells(pump.cx, pump.cz, s.cx + 24, s.cz + 10)
          .filter((c) => !buildingAtCell(world.city, c));
        if (pipe.length > 0) d.issue('conductors', buildWaterPipeOrder(DEMO_OWNER, pipe));
      } else {
        d.fail('conductors', 'buildPipe', 'waterPump not placed yet');
      }
    });

    add(750, 'production', (d) => {
      // Barracks + war factory in the industrial quarter (40s/60s builds).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'production', 'barracks', IND, reserved);
      place(d, 'production', 'warFactory', IND, reserved);
    });

    add(900, 'depot', (d) => {
      // Foundation-age fuel depot (utility zone): the resupply anchor.
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'depot', 'fuelDepot', UTL, reserved);
    });

    add(2010, 'train-rifles', (d) => {
      // Barracks (placed 750 + 40s build) is complete; train a rifle pair.
      const at = cellWorld(s.cx + 8, s.cz + 28);
      trainMarked(d, 'train-rifles', (id) => { d.rifleMark = id; }, 'rifles', at.x, at.z);
      d.issue('train-rifles', buildTrainOrder('rifles', DEMO_OWNER, at.x + 6, at.z));
    });

    add(2160, 'train-truck', (d) => {
      // Fuel depot (placed 900 + 40s build) is complete; the supply
      // truck needs no production building.
      const at = cellWorld(s.cx + 24, s.cz + 28);
      trainMarked(d, 'train-truck', (id) => { d.truckMark = id; }, 'supplyTruck', at.x, at.z);
    });

    add(2220, 'muster', (d) => {
      // March the rifles to a muster point outside town.
      const rifles = d.session.world.units.filter(
        (u) => u.owner === DEMO_OWNER && u.kind === 'rifles' && u.id >= d.rifleMark,
      );
      if (rifles.length === 0) {
        d.fail('muster', 'moveGroup', 'rifles not found');
        return;
      }
      const town = d.townCenter;
      const muster = findLandPoint(d.session.terrain, town.x - 60, town.z + 40);
      d.issue('muster', buildMoveOrder(rifles.map((u) => u.id), DEMO_OWNER, muster.x, muster.z));
    });

    add(2310, 'patrol', (d) => {
      // Send the supply truck on a long patrol to burn fuel (the demo
      // stream picks one of four routes — same seed, same route).
      const truck = d.session.world.units.find(
        (u) => u.owner === DEMO_OWNER && u.kind === 'supplyTruck' && u.id >= d.truckMark,
      );
      if (!truck) {
        d.fail('patrol', 'moveUnit', 'supplyTruck not found');
        return;
      }
      const town = d.townCenter;
      const routes = [
        { x: town.x + 200, z: town.z - 60 },
        { x: town.x - 140, z: town.z - 160 },
        { x: town.x + 120, z: town.z + 180 },
        { x: town.x - 200, z: town.z + 60 },
      ];
      const route = routes[d.rng.intBelow('demo', routes.length)]!;
      const dest = findLandPoint(d.session.terrain, route.x, route.z);
      d.issue('patrol', buildMoveOrder([truck.id], DEMO_OWNER, dest.x, dest.z));
    });

    add(2610, 'train-tank', (d) => {
      // War factory (placed 750 + 60s build) is complete.
      const at = cellWorld(s.cx + 8, s.cz + 28);
      trainMarked(d, 'train-tank', (id) => { d.tankMark = id; }, 'tank', at.x, at.z);
    });

    add(2670, 'tank-muster', (d) => {
      const tank = d.session.world.units.find(
        (u) => u.owner === DEMO_OWNER && u.kind === 'tank' && u.id >= d.tankMark,
      );
      if (!tank) {
        d.fail('tank-muster', 'moveUnit', 'tank not found');
        return;
      }
      const town = d.townCenter;
      const muster = findLandPoint(d.session.terrain, town.x - 60, town.z + 40);
      d.issue('tank-muster', buildMoveOrder([tank.id], DEMO_OWNER, muster.x, muster.z));
    });

    add(4500, 'resupply', (d) => {
      // The truck has burned fuel on patrol; the depot has pulled the
      // owner's fuel forward. Route it in for a real resupply.
      const world = d.session.world;
      const truck = world.units.find((u) => u.owner === DEMO_OWNER && u.kind === 'supplyTruck');
      const depot = world.city.buildings.find(
        (b) => b.owner === DEMO_OWNER && b.kind === 'fuelDepot' && b.progress >= 1,
      );
      if (!truck) {
        d.fail('resupply', 'resupply', 'supplyTruck not found');
        return;
      }
      if (!depot) {
        d.fail('resupply', 'resupply', 'completed fuelDepot not found');
        return;
      }
      d.issue('resupply', buildResupplyOrder(truck.id, depot.id, DEMO_OWNER));
    });

    // -- Orbit 1: the neighborhood wave ---------------------------------
    add(6300, 'homes', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'homes', 'apartment', RES, reserved);
      place(d, 'homes', 'apartment', RES, reserved);
      place(d, 'homes', 'house', RES, reserved);
      place(d, 'homes', 'house', RES, reserved);
      place(d, 'homes', 'house', RES, reserved);
    });

    add(6900, 'civic', (d) => {
      // Education + leisure in the civic band (utility zone buildings).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'civic', 'school', CIV, reserved);
      place(d, 'civic', 'kindergarten', CIV, reserved);
      place(d, 'civic', 'library', CIV, reserved);
      place(d, 'civic', 'park', CIV, reserved);
    });

    add(7500, 'shops2', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'shops2', 'shop', COM, reserved);
      place(d, 'shops2', 'shop', COM, reserved);
      place(d, 'shops2', 'lab', COM, reserved);
    });

    add(8100, 'parking', (d) => {
      // Parking near the shops: a light desirability play.
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'parking', 'parkingLot', COM, reserved);
      place(d, 'parking', 'parkingGarage', COM, reserved);
    });

    add(8700, 'engineers', (d) => {
      // Foundation-age support units (no production building needed).
      const at = cellWorld(s.cx + 8, s.cz + 28);
      trainMarked(d, 'engineers', (id) => { d.droneMark = id; }, 'drone', at.x, at.z);
      d.issue('engineers', buildTrainOrder('engineer', DEMO_OWNER, at.x + 6, at.z));
      d.issue('engineers', buildTrainOrder('engineer', DEMO_OWNER, at.x + 12, at.z));
      d.issue('engineers', buildTrainOrder('hauler', DEMO_OWNER, at.x + 18, at.z));
    });

    add(9300, 'scout', (d) => {
      // Send the drone up for a recon sweep over the outskirts.
      const drone = d.session.world.units.find(
        (u) => u.owner === DEMO_OWNER && u.kind === 'drone' && u.id >= d.droneMark,
      );
      if (!drone) {
        d.fail('scout', 'moveUnit', 'drone not found');
        return;
      }
      const town = d.townCenter;
      // Sweep east of town (in-bounds; clamped to land — raw corner
      // coords can leave the map and the move validator rejects those).
      const dest = findLandPoint(d.session.terrain, town.x + 80, town.z - 40);
      d.issue('scout', buildMoveOrder([drone.id], DEMO_OWNER, dest.x, dest.z));
    });

    add(9900, 'roads2', (d) => {
      // A second street through the utility quarter and a southern one.
      // Skip cells already paved, built on, or water — the road validator
      // rejects all three, so filter first and the command always lands.
      const world = d.session.world;
      const t = d.session.terrain;
      const paved = new Set(world.city.roads.map((r) => r.cell));
      const ok = (c: number): boolean => {
        if (paved.has(c)) return false;
        if (buildingAtCell(world.city, c)) return false;
        const { cx, cz } = cellCoords(c);
        return !cellIsWater(t, cx, cz);
      };
      const east = walkCells(s.cx, s.cz + 24, s.cx + DEMO_SITE_SIZE - 1, s.cz + 24).filter(ok);
      if (east.length > 0) d.issue('roads2', buildRoadOrder(DEMO_OWNER, east));
      // The south street skips the east street's cells: same-tick commands
      // apply in seq order, so it can't see them yet, and its apply-time
      // re-validation would reject the shared intersection (the 'roads'
      // chapter's mainSet precedent).
      const eastSet = new Set(east);
      const south = walkCells(s.cx + 24, s.cz + 16, s.cx + 24, s.cz + DEMO_SITE_SIZE - 1)
        .filter((c) => ok(c) && !eastSet.has(c));
      if (south.length > 0) d.issue('roads2', buildRoadOrder(DEMO_OWNER, south));
    });

    add(10500, 'conductors2', (d) => {
      // Extend the grids to the growing civic quarter. Filter cells that
      // already carry this network (the validator rejects duplicates)
      // and cells with buildings.
      const world = d.session.world;
      const lines = new Set(world.city.powerLines);
      const pipes = new Set(world.city.pipes);
      const lineOk = (c: number): boolean => !lines.has(c) && !buildingAtCell(world.city, c);
      const pipeOk = (c: number): boolean => !pipes.has(c) && !buildingAtCell(world.city, c);
      const plant = world.city.buildings.find((b) => b.kind === 'powerPlant' && b.owner === DEMO_OWNER);
      const pump = world.city.buildings.find((b) => b.kind === 'waterPump' && b.owner === DEMO_OWNER);
      if (plant) {
        const line = walkCells(plant.cx, plant.cz, s.cx + 24, s.cz + 15).filter(lineOk);
        if (line.length > 0) d.issue('conductors2', buildPowerLineOrder(DEMO_OWNER, line));
      } else {
        d.fail('conductors2', 'buildPowerLine', 'powerPlant not placed yet');
      }
      if (pump) {
        const pipe = walkCells(pump.cx, pump.cz, s.cx + 24, s.cz + 15).filter(pipeOk);
        if (pipe.length > 0) d.issue('conductors2', buildWaterPipeOrder(DEMO_OWNER, pipe));
      } else {
        d.fail('conductors2', 'buildPipe', 'waterPump not placed yet');
      }
    });

    add(11100, 'farms', (d) => {
      // Feed the growing population (foundation-age, industrial zone).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'farms', 'farm', IND, reserved);
      place(d, 'farms', 'farm', IND, reserved);
    });

    // -- Orbit 2: the Connectivity age ----------------------------------
    add(12000, 'age-connectivity', (d) => {
      d.issue('age-connectivity', buildAdvanceAgeOrder(DEMO_OWNER, 'fiberGrid'));
    });

    add(12600, 'solar', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'solar', 'solarFarm', UTL, reserved);
      place(d, 'solar', 'windFarm', UTL, reserved);
    });

    add(13200, 'water2', (d) => {
      // A second pump + pumping station (the water tower needs the
      // gridStorage upgrade, which the demo never researches).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'water2', 'waterPump', UTL, reserved);
      place(d, 'water2', 'pumpingStation', UTL, reserved);
    });

    add(13800, 'civic2', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'civic2', 'hospital', COM, reserved);
      place(d, 'civic2', 'university', CIV, reserved);
    });

    add(14400, 'transit-hub', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'transit-hub', 'busDepot', IND, reserved);
    });

    add(15000, 'airfield', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'airfield', 'airfield', IND, reserved);
    });

    add(15600, 'market', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'market', 'market', COM, reserved);
      place(d, 'market', 'shop', COM, reserved);
    });

    add(16200, 'grid', (d) => {
      // Substations for the eastern grid (the battery station needs the
      // gridStorage upgrade, which the demo never researches).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'grid', 'powerSubstation', CIV, reserved);
      place(d, 'grid', 'powerSubstation', CIV, reserved);
    });

    add(16800, 'conductors3', (d) => {
      // Hook the new plants into the eastern grid (duplicate-filtered
      // like conductors2).
      const world = d.session.world;
      const lines = new Set(world.city.powerLines);
      const pipes = new Set(world.city.pipes);
      const lineOk = (c: number): boolean => !lines.has(c) && !buildingAtCell(world.city, c);
      const pipeOk = (c: number): boolean => !pipes.has(c) && !buildingAtCell(world.city, c);
      const solar = world.city.buildings.find((b) => b.kind === 'solarFarm' && b.owner === DEMO_OWNER);
      const pump = world.city.buildings.find((b) => b.kind === 'waterPump' && b.owner === DEMO_OWNER);
      if (solar) {
        const line = walkCells(solar.cx, solar.cz, s.cx + 28, s.cz + 22).filter(lineOk);
        if (line.length > 0) d.issue('conductors3', buildPowerLineOrder(DEMO_OWNER, line));
      } else {
        d.fail('conductors3', 'buildPowerLine', 'solarFarm not placed yet');
      }
      if (pump) {
        const pipe = walkCells(pump.cx, pump.cz, s.cx + 28, s.cz + 22).filter(pipeOk);
        if (pipe.length > 0) d.issue('conductors3', buildWaterPipeOrder(DEMO_OWNER, pipe));
      } else {
        d.fail('conductors3', 'buildPipe', 'waterPump not placed yet');
      }
    });

    // -- Orbit 3: air power + industry prelude ---------------------------
    add(17400, 'fighters', (d) => {
      // Airfield (placed 15000 + 75s build) is complete.
      const at = cellWorld(s.cx + 8, s.cz + 4);
      trainMarked(d, 'fighters', (id) => { d.fighterMark = id; }, 'fighter', at.x, at.z);
      d.issue('fighters', buildTrainOrder('drone', DEMO_OWNER, at.x + 6, at.z));
      d.issue('fighters', buildTrainOrder('drone', DEMO_OWNER, at.x + 12, at.z));
    });

    add(18000, 'academy', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'academy', 'militaryAcademy', IND, reserved);
    });

    add(18600, 'heavies', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 28);
      trainMarked(d, 'heavies', (id) => { d.artilleryMark = id; }, 'artillery', at.x, at.z);
      d.issue('heavies', buildTrainOrder('apc', DEMO_OWNER, at.x + 6, at.z));
    });

    add(19200, 'resources', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'resources', 'oilWell', UTL, reserved);
      place(d, 'resources', 'quarry', IND, reserved);
    });

    add(19800, 'media', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'media', 'mediaCenter', COM, reserved);
    });

    add(20400, 'recycling', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'recycling', 'recyclingCenter', IND, reserved);
    });

    add(21000, 'college', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'college', 'college', CIV, reserved);
    });

    add(21600, 'specops', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('specops', buildTrainOrder('spectre', DEMO_OWNER, at.x, at.z));
      d.issue('specops', buildTrainOrder('sniperTeam', DEMO_OWNER, at.x + 6, at.z));
      d.issue('specops', buildTrainOrder('combatMedic', DEMO_OWNER, at.x + 12, at.z));
    });

    add(22200, 'flyover', (d) => {
      // A victory flyover past the town.
      const fighter = d.session.world.units.find(
        (u) => u.owner === DEMO_OWNER && u.kind === 'fighter' && u.id >= d.fighterMark,
      );
      if (!fighter) {
        d.fail('flyover', 'moveUnit', 'fighter not found');
        return;
      }
      const town = d.townCenter;
      d.issue('flyover', buildMoveOrder([fighter.id], DEMO_OWNER, town.x + 220, town.z - 40));
    });

    // -- Orbit 4: the Industry age ---------------------------------------
    add(24000, 'age-industry', (d) => {
      d.issue('age-industry', buildAdvanceAgeOrder(DEMO_OWNER, 'heavyIndustry'));
    });

    add(24600, 'nuclear', (d) => {
      // Industry-age nuclear plant (coal/gas need the combustionTech
      // upgrade, which the demo never researches).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'nuclear', 'nuclearPlant', UTL, reserved);
    });

    add(25200, 'desal', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'desal', 'desalination', UTL, reserved);
    });

    add(25800, 'treatment', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'treatment', 'waterTreatment', UTL, reserved);
    });

    add(26400, 'rail', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'rail', 'railStation', COM, reserved);
    });

    add(27000, 'depots', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'depots', 'ordnanceDepot', UTL, reserved);
      place(d, 'depots', 'missileSilo', UTL, reserved);
    });

    add(27600, 'refinery', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'refinery', 'oilRefinery', IND, reserved);
    });

    add(28200, 'munitions', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'munitions', 'munitionsFactory', IND, reserved);
    });

    // -- Orbit 5: transit + freight --------------------------------------
    add(30000, 'buses', (d) => {
      // Bus depot (placed 14400 + 35s build) is complete.
      const at = cellWorld(s.cx + 8, s.cz + 4);
      trainMarked(d, 'buses', (id) => { d.busMark = id; }, 'bus', at.x, at.z);
      d.issue('buses', buildTrainOrder('tram', DEMO_OWNER, at.x + 6, at.z));
    });

    add(30600, 'freight', (d) => {
      // Rail station (placed 26400 + 45s build) is complete.
      const at = cellWorld(s.cx + 24, s.cz + 4);
      d.issue('freight', buildTrainOrder('freightTrain', DEMO_OWNER, at.x, at.z));
    });

    add(31200, 'central', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'central', 'centralStation', COM, reserved);
    });

    add(31800, 'stops', (d) => {
      // Small transit stops along the civic band (utility zone).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'stops', 'neighborhoodStation', COM, reserved);
      place(d, 'stops', 'tramStop', CIV, reserved);
      place(d, 'stops', 'taxiStand', CIV, reserved);
      place(d, 'stops', 'busStop', CIV, reserved);
    });

    add(32400, 'transit-run', (d) => {
      // The bus leaves on its route around the outskirts.
      const bus = d.session.world.units.find(
        (u) => u.owner === DEMO_OWNER && u.kind === 'bus' && u.id >= d.busMark,
      );
      if (!bus) {
        d.fail('transit-run', 'moveUnit', 'bus not found');
        return;
      }
      const town = d.townCenter;
      const dest = findLandPoint(d.session.terrain, town.x + 180, town.z + 120);
      d.issue('transit-run', buildMoveOrder([bus.id], DEMO_OWNER, dest.x, dest.z));
    });

    add(33000, 'industry2', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'industry2', 'factory', IND, reserved);
      place(d, 'industry2', 'factory', IND, reserved);
    });

    // -- Orbit 6: the Information age ------------------------------------
    add(36000, 'age-information', (d) => {
      d.issue('age-information', buildAdvanceAgeOrder(DEMO_OWNER, 'cyberCommand'));
    });

    add(36300, 'interchange', (d) => {
      // Right after the Information age unlocks it — the commercial zone
      // fragments fast, so claim the 4×4 footprint early.
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'interchange', 'airportInterchange', COM, reserved);
    });

    add(36600, 'monument', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'monument', 'monument', CIV, reserved);
    });

    add(37200, 'geothermal', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'geothermal', 'geothermalPlant', UTL, reserved);
    });

    add(37500, 'fuel3', (d) => {
      // More fuel production — the air force and armor burn it fast.
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'fuel3', 'oilWell', UTL, reserved);
    });

    add(38400, 'strike-air', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 4);
      d.issue('strike-air', buildTrainOrder('fighterBomber', DEMO_OWNER, at.x, at.z));
      d.issue('strike-air', buildTrainOrder('attackHeli', DEMO_OWNER, at.x + 6, at.z));
    });

    add(39000, 'missiles', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'missiles', 'missilePlant', IND, reserved);
    });

    add(39600, 'airdef', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('airdef', buildTrainOrder('aa', DEMO_OWNER, at.x, at.z));
    });

    // -- Orbit 7: the buildup --------------------------------------------
    add(42000, 'armor', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 28);
      trainMarked(d, 'armor', (id) => { d.mlrsMark = id; }, 'mlrs', at.x, at.z);
      d.issue('armor', buildTrainOrder('tankDestroyer', DEMO_OWNER, at.x + 6, at.z));
    });

    add(42600, 'hq', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('hq', buildTrainOrder('hq', DEMO_OWNER, at.x, at.z));
    });

    add(43200, 'garrison', (d) => {
      // Fresh academy graduates (Regular on spawn with a completed
      // Military Academy — placed 18000 + 30s build).
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('garrison', buildTrainOrder('rifles', DEMO_OWNER, at.x, at.z));
      d.issue('garrison', buildTrainOrder('rifles', DEMO_OWNER, at.x + 6, at.z));
    });

    add(43800, 'fuel2', (d) => {
      const at = cellWorld(s.cx + 24, s.cz + 28);
      trainMarked(d, 'fuel2', (id) => { d.fuelTruckMark = id; }, 'fuelTruck', at.x, at.z);
    });

    add(44100, 'fuel-patrol', (d) => {
      // Run the second fuel truck so it burns fuel — the resupply
      // validator rejects units that are already full.
      const truck = d.session.world.units.find(
        (u) => u.owner === DEMO_OWNER && u.kind === 'fuelTruck' && u.id >= d.fuelTruckMark,
      );
      if (!truck) {
        d.fail('fuel-patrol', 'moveUnit', 'fuelTruck not found');
        return;
      }
      const town = d.townCenter;
      // Clamp to a valid in-bounds land point (raw offsets can leave the map).
      const dest = findLandPoint(d.session.terrain, town.x - 40, town.z + 30);
      d.issue('fuel-patrol', buildMoveOrder([truck.id], DEMO_OWNER, dest.x, dest.z));
    });

    add(44700, 'resupply2', (d) => {
      // Top up the second fuel truck at the depot.
      const world = d.session.world;
      const truck = world.units.find(
        (u) => u.owner === DEMO_OWNER && u.kind === 'fuelTruck' && u.id >= d.fuelTruckMark,
      );
      const depot = world.city.buildings.find(
        (b) => b.owner === DEMO_OWNER && b.kind === 'fuelDepot' && b.progress >= 1,
      );
      if (!truck) {
        d.fail('resupply2', 'resupply', 'fuelTruck not found');
        return;
      }
      if (!depot) {
        d.fail('resupply2', 'resupply', 'completed fuelDepot not found');
        return;
      }
      d.issue('resupply2', buildResupplyOrder(truck.id, depot.id, DEMO_OWNER));
    });

    add(45000, 'ordnance2', (d) => {
      // Stockpile ammo for the finale (the reservoir needs the
      // gridStorage upgrade, which the demo never researches).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'ordnance2', 'ordnanceDepot', UTL, reserved);
    });

    // -- Orbit 8: the Ascendance age --------------------------------------
    add(48000, 'age-ascendance', (d) => {
      d.issue('age-ascendance', buildAdvanceAgeOrder(DEMO_OWNER, 'arsenalProgram'));
    });

    add(48600, 'storm-array', (d) => {
      // Ascendance-age superweapon facility (4×4, 150s build) — the
      // planner searches the whole site for a spot.
      const array = d.planBuilding('stormArray', s.cx, s.cz, DEMO_SITE_SIZE, DEMO_SITE_SIZE);
      if (array) d.issue('storm-array', buildPlaceBuildingOrder('stormArray', DEMO_OWNER, array.cx, array.cz));
      else d.fail('storm-array', 'placeBuilding', 'no valid stormArray spot');
    });

    add(49200, 'aegis', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'aegis', 'aegisControl', UTL, reserved);
    });

    add(49800, 'nuclear2', (d) => {
      // A second nuclear plant for the war machine (fusion needs the
      // fusionResearch upgrade, which the demo never researches).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'nuclear2', 'nuclearPlant', UTL, reserved);
    });

    add(50400, 'radar', (d) => {
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      place(d, 'radar', 'radarStation', CIV, reserved);
    });

    add(51000, 'elite', (d) => {
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('elite', buildTrainOrder('rifles', DEMO_OWNER, at.x, at.z));
      d.issue('elite', buildTrainOrder('rifles', DEMO_OWNER, at.x + 6, at.z));
    });

    // -- Orbit 9: the finale ----------------------------------------------
    add(54000, 'staging', (d) => {
      // Stage the heavy armor near the storm target for the finale.
      const world = d.session.world;
      const ids: number[] = [];
      for (const [kind, mark] of [
        ['tank', d.tankMark],
        ['artillery', d.artilleryMark],
        ['mlrs', d.mlrsMark],
      ] as const) {
        const u = world.units.find((x) => x.owner === DEMO_OWNER && x.kind === kind && x.id >= mark);
        if (u) ids.push(u.id);
      }
      if (ids.length === 0) {
        d.fail('staging', 'moveGroup', 'no staged units found');
        return;
      }
      const dest = findLandPoint(d.session.terrain, d.stormTarget.x - 40, d.stormTarget.z + 30);
      d.issue('staging', buildMoveOrder(ids, DEMO_OWNER, dest.x, dest.z));
    });

    add(55200, 'storm-strike', (d) => {
      // The finale: a storm strike on empty land, far from the town.
      // Storm Array (placed 48600 + 150s build) is complete. The camera
      // swings to the target for the show.
      d.focus = { x: d.stormTarget.x, z: d.stormTarget.z };
      d.issue('storm-strike', buildFireStormOrder(DEMO_OWNER, d.stormTarget.x, d.stormTarget.z));
    });

    add(57000, 'parade', (d) => {
      // The city celebrates: a fresh rifle pair musters in town.
      const at = cellWorld(s.cx + 8, s.cz + 28);
      d.issue('parade', buildTrainOrder('rifles', DEMO_OWNER, at.x, at.z));
      d.issue('parade', buildTrainOrder('rifles', DEMO_OWNER, at.x + 6, at.z));
    });

    add(59400, 'finale', (d) => {
      // Hold the shot, then signal the menu to restart the movie.
      d.done = true;
    });
  }

  /** Record a loud planner failure (no valid spot, missing prerequisite). */
  fail(chapter: string, kind: string, reason: string): void {
    this.failures.push({ tick: this.session.world.tick, chapter, kind, reason });
    console.error(`[demo] chapter '${chapter}' could not issue '${kind}': ${reason}`);
  }
}

/** One menu frame of demo simulation: bounded tick budget, then direct. */
export interface DemoFrameBudget {
  /** Max sim ticks per frame (the movie plays faster with more). */
  ticksPerFrame: number;
  /** Wall-clock cap per frame in ms (the demo never stalls the menu). */
  msPerFrame: number;
}

/** Default frame budget: 6 ticks/frame behind an 8 ms cap. */
export const DEMO_FRAME_BUDGET: DemoFrameBudget = {
  ticksPerFrame: 6,
  msPerFrame: 8,
};

/**
 * Advance the demo world by its frame budget and run the director.
 * Pure w.r.t. wall clock for the SIM (fixed ticks); the budget only
 * decides how many ticks run this frame. Deterministic per tick.
 */
export function stepDemo(director: DemoDirector, budget: DemoFrameBudget = DEMO_FRAME_BUDGET): void {
  const start = Date.now();
  const session = director.session;
  for (let i = 0; i < budget.ticksPerFrame; i += 1) {
    session.tick();
    director.update();
    if (Date.now() - start >= budget.msPerFrame) break;
  }
}
