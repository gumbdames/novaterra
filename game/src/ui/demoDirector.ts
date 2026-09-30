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
 *    lines/pipes, train units, run a resupply, advance the ages, and
 *    finish with a storm strike. Each chapter fires at a fixed world
 *    tick and enqueues through the SAME queue the UI uses, with
 *    `issuer: 'demo'` — validate-at-enqueue AND validate-at-apply both
 *    run, exactly as for player orders.
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
 *  - Sim: the full 13,001-tick movie runs in ~200 ms (~0.015 ms/tick);
 *    the menu steps at most 6 ticks/frame behind an 8 ms wall-clock
 *    cap, so the demo can never stall menu rendering.
 *  - Render: entity count stays tiny (26 buildings, 10 units at the
 *    finale); the per-kind instanced renderer draws O(kinds), not
 *    O(entities).
 */

import { createRngBank, type RngBank } from '../sim/rng';
import type { TerrainData } from '../sim/terrain';
import {
  BUILDING_DEFS,
  CELL_WORLD_SIZE,
  MAP_HALF_SIZE,
  ZoneType,
  buildingAtCell,
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
/** Command issuer stamped on every director order (cf. 'player', 'ai-setup'). */
export const DEMO_ISSUER = 'demo';
/** The demo world is built on this map preset (canonical terrain seed). */
export const DEMO_MAP_PRESET = 'Meridian Plains';
/** Owner the director builds for (the human slot, like a player). */
export const DEMO_OWNER = HUMAN_PLAYER_ID;

/**
 * Opening stockpile for the demo player. UI-owned setup, granted once
 * before tick 0 — the campaign `startingResources` precedent. It funds
 * the scripted arc (four age advances + the Storm Array alone cost
 * 52,000 funds / 21,200 materials / 850 influence); everything after
 * setup flows through validated commands and the live economy.
 */
export const DEMO_OPENING_STOCKPILE = {
  funds: 65000,
  materials: 26000,
  fuel: 3000,
  food: 2000,
  research: 0,
  goods: 500,
  influence: 1200,
  manpower: 200,
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
  /** Town site: 24×24 all-land cells near the human corner. */
  private readonly site: { cx: number; cz: number };
  /** Storm-strike target (empty land away from the town). */
  private readonly stormTarget: { x: number; z: number };
  /** First fresh unit id seen before a training chapter (id tracking). */
  private rifleMark = 0;
  private truckMark = 0;
  private tankMark = 0;

  constructor(session: GameSession) {
    this.session = session;
    this.rng = createRngBank(DEMO_SEED);
    // Human corner (-180, 180) → cell (38, 218).
    const site = findLandRect(session.terrain, 38, 218, 24, 24);
    if (site === null) {
      throw new Error('DemoDirector: no 24x24 land rect near the human corner');
    }
    this.site = site;
    const town = cellWorld(site.cx + 12, site.cz + 12);
    this.focus = { x: town.x, z: town.z };
    this.stormTarget = findLandPoint(session.terrain, town.x + 170, town.z - 120);
    this.buildChapters();
  }

  /** Demo town center in world coords (camera anchor for the menu). */
  get townCenter(): { x: number; z: number } {
    return cellWorld(this.site.cx + 12, this.site.cz + 12);
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
    outer: for (let dz = 0; dz <= h - def.footprintH; dz += 1) {
      for (let dx = 0; dx <= w - def.footprintW; dx += 1) {
        const cx = x0 + dx;
        const cz = z0 + dz;
        for (const r of reserved) {
          if (cx < r.cx + r.w && r.cx < cx + def.footprintW && cz < r.cz + r.h && r.cz < cz + def.footprintH) {
            continue outer;
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
    const spot = this.planBuilding(kind, x0, z0, w, h, reserved);
    if (!spot) {
      this.fail(chapter, 'placeBuilding', `no valid ${kind} spot`);
      return false;
    }
    reserved.push({ cx: spot.cx, cz: spot.cz, w: def.footprintW, h: def.footprintH });
    this.issue(chapter, buildPlaceBuildingOrder(kind, DEMO_OWNER, spot.cx, spot.cz));
    return true;
  }

  /** The script. Chapter ticks are fixed; build-time pads are generous. */
  private buildChapters(): void {
    const s = this.site;
    const add = (tick: number, name: string, run: (d: DemoDirector) => void): void => {
      this.chapters.push({ tick, name, run });
    };

    // -- Act 1: the town ------------------------------------------------
    add(30, 'zones', (d) => {
      // Residential / commercial / industrial blocks inside the land rect.
      d.issue('zones', buildZoneOrder(DEMO_OWNER, ZoneType.RESIDENTIAL, s.cx, s.cz, s.cx + 11, s.cz + 9));
      d.issue('zones', buildZoneOrder(DEMO_OWNER, ZoneType.COMMERCIAL, s.cx + 12, s.cz, s.cx + 19, s.cz + 7));
      d.issue('zones', buildZoneOrder(DEMO_OWNER, ZoneType.INDUSTRIAL, s.cx, s.cz + 10, s.cx + 11, s.cz + 19));
    });

    add(150, 'roads', (d) => {
      // A main street past the residential block, a second past industry.
      // The cross street skips the main street's cells: same-tick
      // commands apply in seq order, so it can't see them yet, and its
      // apply-time re-validation would reject the shared intersection.
      const mainCells = walkCells(s.cx, s.cz + 11, s.cx + 19, s.cz + 11);
      const mainSet = new Set(mainCells);
      const main = mainCells.filter((c) => !buildingAtCell(d.session.world.city, c));
      if (main.length > 0) d.issue('roads', buildRoadOrder(DEMO_OWNER, main));
      const cross = walkCells(s.cx + 6, s.cz, s.cx + 6, s.cz + 19)
        .filter((c) => !mainSet.has(c) && !buildingAtCell(d.session.world.city, c));
      if (cross.length > 0) d.issue('roads', buildRoadOrder(DEMO_OWNER, cross));
    });

    add(300, 'first-buildings', (d) => {
      // Two houses, a shop, a factory — the planner finds valid spots
      // (reservations keep same-chapter claims from colliding).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      d.placeClaimed('first-buildings', 'house', s.cx, s.cz, 12, 10, reserved);
      d.placeClaimed('first-buildings', 'house', s.cx, s.cz, 12, 10, reserved);
      d.placeClaimed('first-buildings', 'shop', s.cx + 12, s.cz, 8, 8, reserved);
      d.placeClaimed('first-buildings', 'factory', s.cx, s.cz + 10, 12, 10, reserved);
    });

    // -- Act 2: utilities ------------------------------------------------
    add(450, 'utilities', (d) => {
      // Foundation-age plant + pump (utility zone: no zoning needed).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      d.placeClaimed('utilities', 'powerPlant', s.cx + 13, s.cz + 9, 11, 15, reserved);
      d.placeClaimed('utilities', 'waterPump', s.cx + 13, s.cz + 9, 11, 15, reserved);
    });

    add(600, 'conductors', (d) => {
      // Hook the plants to the town: power line + water pipe runs.
      const world = d.session.world;
      const plant = world.city.buildings.find((b) => b.kind === 'powerPlant' && b.owner === DEMO_OWNER);
      const pump = world.city.buildings.find((b) => b.kind === 'waterPump' && b.owner === DEMO_OWNER);
      if (plant) {
        const line = walkCells(plant.cx, plant.cz, s.cx + 18, s.cz + 8)
          .filter((c) => !buildingAtCell(world.city, c));
        if (line.length > 0) d.issue('conductors', buildPowerLineOrder(DEMO_OWNER, line));
      } else {
        d.fail('conductors', 'buildPowerLine', 'powerPlant not placed yet');
      }
      if (pump) {
        const pipe = walkCells(pump.cx, pump.cz, s.cx + 18, s.cz + 8)
          .filter((c) => !buildingAtCell(world.city, c));
        if (pipe.length > 0) d.issue('conductors', buildWaterPipeOrder(DEMO_OWNER, pipe));
      } else {
        d.fail('conductors', 'buildPipe', 'waterPump not placed yet');
      }
    });

    // -- Act 3: military + logistics ------------------------------------
    add(750, 'production', (d) => {
      // Barracks + war factory in the industrial block (40s/60s builds).
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      d.placeClaimed('production', 'barracks', s.cx, s.cz + 10, 12, 10, reserved);
      d.placeClaimed('production', 'warFactory', s.cx, s.cz + 10, 12, 10, reserved);
    });

    add(900, 'depot', (d) => {
      // Foundation-age fuel depot (utility zone): the resupply anchor.
      const reserved: Array<{ cx: number; cz: number; w: number; h: number }> = [];
      d.placeClaimed('depot', 'fuelDepot', s.cx + 13, s.cz + 9, 11, 15, reserved);
    });

    add(2010, 'train-rifles', (d) => {
      // Barracks (placed 750 + 40s build) is complete; train a rifle pair.
      d.rifleMark = d.session.world.nextId;
      const at = cellWorld(s.cx + 6, s.cz + 20);
      d.issue('train-rifles', buildTrainOrder('rifles', DEMO_OWNER, at.x, at.z));
      d.issue('train-rifles', buildTrainOrder('rifles', DEMO_OWNER, at.x + 6, at.z));
    });

    add(2160, 'train-truck', (d) => {
      // Fuel depot (placed 900 + 40s build) is complete; the supply
      // truck needs no production building.
      d.truckMark = d.session.world.nextId;
      const at = cellWorld(s.cx + 16, s.cz + 20);
      d.issue('train-truck', buildTrainOrder('supplyTruck', DEMO_OWNER, at.x, at.z));
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
      d.tankMark = d.session.world.nextId;
      const at = cellWorld(s.cx + 6, s.cz + 20);
      d.issue('train-tank', buildTrainOrder('tank', DEMO_OWNER, at.x, at.z));
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

    // -- Act 4: the ages, then the storm --------------------------------
    add(4800, 'age-connectivity', (d) => {
      d.issue('age-connectivity', buildAdvanceAgeOrder(DEMO_OWNER, 'fiberGrid'));
    });
    add(5400, 'age-industry', (d) => {
      d.issue('age-industry', buildAdvanceAgeOrder(DEMO_OWNER, 'heavyIndustry'));
    });
    add(6000, 'age-information', (d) => {
      d.issue('age-information', buildAdvanceAgeOrder(DEMO_OWNER, 'cyberCommand'));
    });
    add(6600, 'age-ascendance', (d) => {
      d.issue('age-ascendance', buildAdvanceAgeOrder(DEMO_OWNER, 'arsenalProgram'));
    });

    add(6900, 'storm-array', (d) => {
      // Ascendance-age superweapon facility (4×4, 150s build).
      const array = d.planBuilding('stormArray', s.cx, s.cz, 24, 24);
      if (array) d.issue('storm-array', buildPlaceBuildingOrder('stormArray', DEMO_OWNER, array.cx, array.cz));
      else d.fail('storm-array', 'placeBuilding', 'no valid stormArray spot');
    });

    add(11520, 'storm-strike', (d) => {
      // The finale: a storm strike on empty land, far from the town.
      // The camera swings to the target for the show.
      d.focus = { x: d.stormTarget.x, z: d.stormTarget.z };
      d.issue('storm-strike', buildFireStormOrder(DEMO_OWNER, d.stormTarget.x, d.stormTarget.z));
    });

    add(12100, 'finale', (d) => {
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
