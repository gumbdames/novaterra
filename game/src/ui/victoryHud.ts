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
 * NOVATERRA — ui/victoryHud.ts — the "rival watch" strip (0.1 Alpha).
 *
 * Fun-audit B4 (2026-10-02): the victory kind is picked at setup and
 * never shown again; race victories are invisible races; conquest's
 * actual condition is uncommunicated. This one strip fixes the
 * "unclear goals" finding across all victory kinds: a persistent
 * objective line plus your progress toward the picked victory AND the
 * rival's — the rival's as intel-flavored "~" estimates (the UI never
 * claims certainty about the enemy's books).
 *
 * The `ui/utilities.ts` / `ui/logistics.ts` precedent: pure,
 * headless-safe builders (`victoryProgressOf`) that read sim state
 * defensively (every read `?? 0` / optional-chained — a world without
 * the fields yields zeros, never a crash) and never write sim state;
 * plus a thin DOM widget (`VictoryHud`) built once and refreshed
 * write-on-change (AD11: no digest segment — nodes are never rebuilt).
 *
 * Sim surface used (read-only):
 * - `world.victoryKind` / `world.peaceful` (sim/world.ts).
 * - `getPlayer(world.city, owner).funds/.population` (sim/city.ts).
 * - `ECONOMIC_VICTORY_FUNDS` / `POPULATION_VICTORY_POP` (ui/session.ts —
 *   the canonical victory thresholds, single source of truth).
 * - `peacefulStatus(world, owner).population` (sim/peaceful.ts).
 * - `militaryValue(world, owner)` (muse/director.ts — deterministic).
 * - BuildingRecord `kind`/`owner`/`progress` for the monument scan.
 */

import { getPlayer } from '../sim/city';
import { peacefulStatus } from '../sim/peaceful';
import type { SkirmishVictoryKind, World } from '../sim/world';
import { militaryValue } from '../muse/director';
import { ECONOMIC_VICTORY_FUNDS, POPULATION_VICTORY_POP, HUMAN_PLAYER_ID, AI_PLAYER_ID } from './session';
import { formatCount } from './peaceful';
import { STRINGS, loc, fillLoc } from './strings';

/** Tiny DOM helper (same shape as hud.ts/musebox.ts's local `el`). */
function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** One frame's victory-race readout. All strings player-facing. */
export interface VictoryProgress {
  kind: SkirmishVictoryKind;
  /** The persistent objective line ("Objective: ..."). */
  objective: string;
  /** Short race label ("Funds", "Population", "Monument", "Forces"). */
  raceLabel: string;
  /** Your line, e.g. "12,400 / 100,000". */
  mine: string;
  /** The rival's line, intel-flavored: "~8,100 / 100,000". */
  rival: string;
  /** 0..1 progress fractions (drive the two bars). */
  mineFrac: number;
  rivalFrac: number;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * The victory-race readout for this world. Null in peaceful worlds
 * (endless — no race) and when the kind is unknown. Pure; never throws
 * on partial worlds.
 */
export function victoryProgressOf(world: World): VictoryProgress | null {
  if (world.peaceful === true) return null;
  const kind: SkirmishVictoryKind = world.victoryKind ?? 'conquest';
  const s = STRINGS.victoryHud;
  const objective = loc(STRINGS.objectives[kind]);

  switch (kind) {
    case 'economic': {
      const mine = getPlayer(world.city, HUMAN_PLAYER_ID)?.funds ?? 0;
      const theirs = getPlayer(world.city, AI_PLAYER_ID)?.funds ?? 0;
      return {
        kind,
        objective,
        raceLabel: loc(s.raceFunds),
        mine: fillLoc(s.progressFunds, {
          have: formatCount(Math.max(0, Math.floor(mine))),
          need: formatCount(ECONOMIC_VICTORY_FUNDS),
        }),
        rival: fillLoc(s.progressFundsRival, {
          have: formatCount(Math.max(0, Math.floor(theirs))),
          need: formatCount(ECONOMIC_VICTORY_FUNDS),
        }),
        mineFrac: clamp01(mine / ECONOMIC_VICTORY_FUNDS),
        rivalFrac: clamp01(theirs / ECONOMIC_VICTORY_FUNDS),
      };
    }
    case 'population': {
      const mine = peacefulStatus(world, HUMAN_PLAYER_ID).population;
      const theirs = peacefulStatus(world, AI_PLAYER_ID).population;
      return {
        kind,
        objective,
        raceLabel: loc(s.racePopulation),
        mine: fillLoc(s.progressPopulation, {
          have: formatCount(Math.max(0, Math.floor(mine))),
          need: formatCount(POPULATION_VICTORY_POP),
        }),
        rival: fillLoc(s.progressPopulationRival, {
          have: formatCount(Math.max(0, Math.floor(theirs))),
          need: formatCount(POPULATION_VICTORY_POP),
        }),
        mineFrac: clamp01(mine / POPULATION_VICTORY_POP),
        rivalFrac: clamp01(theirs / POPULATION_VICTORY_POP),
      };
    }
    case 'monument': {
      const progressOf = (owner: number): number => {
        let best = 0;
        for (const b of world.city.buildings) {
          if (b.owner !== owner || b.kind !== 'monument') continue;
          best = Math.max(best, b.progress ?? 0);
        }
        return best;
      };
      const mine = progressOf(HUMAN_PLAYER_ID);
      const theirs = progressOf(AI_PLAYER_ID);
      const line = (frac: number): string =>
        frac >= 1 ? loc(s.monumentComplete) : frac <= 0 ? loc(s.monumentNotStarted) : `${Math.floor(frac * 100)}%`;
      return {
        kind,
        objective,
        raceLabel: loc(s.raceMonument),
        mine: line(mine),
        rival: theirs <= 0 ? loc(s.monumentRivalUnknown) : `~${line(theirs)}`,
        mineFrac: clamp01(mine),
        rivalFrac: clamp01(theirs),
      };
    }
    case 'conquest':
    default: {
      // Conquest has no finish line to be "x% toward" — the race IS the
      // balance of forces. The bars show each side's share of combined
      // military value; the lines count fielded units (intel "~" for
      // the rival, as everywhere else).
      const countUnits = (owner: number): number => {
        let n = 0;
        for (const u of world.units) if (u.owner === owner && u.hp > 0) n++;
        return n;
      };
      const mineVal = militaryValue(world, HUMAN_PLAYER_ID);
      const rivalVal = militaryValue(world, AI_PLAYER_ID);
      const total = mineVal + rivalVal;
      const mineUnits = countUnits(HUMAN_PLAYER_ID);
      const rivalUnits = countUnits(AI_PLAYER_ID);
      return {
        kind,
        objective,
        raceLabel: loc(s.raceForces),
        mine: fillLoc(s.progressForces, { n: formatCount(mineUnits) }),
        rival: fillLoc(s.progressForcesRival, { n: formatCount(rivalUnits) }),
        mineFrac: total > 0 ? mineVal / total : 0.5,
        rivalFrac: total > 0 ? rivalVal / total : 0.5,
      };
    }
  }
}

/**
 * The rival-watch strip widget. Built once (constructor), refreshed
 * write-on-change (`update`) — per the topbar branch pattern, nodes
 * are never rebuilt so no AD11 digest segment is needed.
 */
export class VictoryHud {
  private readonly root: HTMLElement;
  private readonly objectiveEl: HTMLElement;
  private readonly raceEl: HTMLElement;
  private readonly mineLabel: HTMLElement;
  private readonly mineBar: HTMLElement;
  private readonly mineValue: HTMLElement;
  private readonly rivalLabel: HTMLElement;
  private readonly rivalBar: HTMLElement;
  private readonly rivalValue: HTMLElement;
  private lastKey = '';

  constructor(parent: HTMLElement) {
    const s = STRINGS.victoryHud;
    const root = el('div', 'victory-hud');
    this.objectiveEl = el('div', 'victory-hud-objective', '');
    root.append(this.objectiveEl);
    this.raceEl = el('div', 'victory-hud-race', '');
    root.append(this.raceEl);
    const mkRow = (cls: string, label: string): { label: HTMLElement; bar: HTMLElement; value: HTMLElement } => {
      const row = el('div', `victory-hud-row ${cls}`);
      const lab = el('span', 'victory-hud-label', label);
      const bar = el('div', 'victory-hud-bar');
      const fill = el('div', 'victory-hud-fill');
      bar.append(fill);
      const val = el('span', 'victory-hud-value', '');
      row.append(lab, bar, val);
      root.append(row);
      return { label: lab, bar: fill, value: val };
    };
    const mine = mkRow('victory-hud-mine', loc(s.youLabel));
    this.mineLabel = mine.label;
    this.mineBar = mine.bar;
    this.mineValue = mine.value;
    const rival = mkRow('victory-hud-rival', loc(s.rivalLabel));
    this.rivalLabel = rival.label;
    this.rivalBar = rival.bar;
    this.rivalValue = rival.value;
    parent.append(root);
    this.root = root;
  }

  /**
   * Refresh the strip. Hidden unless the game is a rivaled,
   * non-peaceful, non-campaign skirmish — the caller (game.ts) owns
   * that gate; the pure builder additionally returns null for
   * peaceful worlds.
   */
  update(world: World, visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
    if (!visible) {
      this.lastKey = '';
      return;
    }
    const p = victoryProgressOf(world);
    if (p === null) {
      this.root.style.display = 'none';
      this.lastKey = '';
      return;
    }
    const key = [p.kind, p.mine, p.rival].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.objectiveEl.textContent = p.objective;
    this.raceEl.textContent = p.raceLabel;
    this.mineValue.textContent = p.mine;
    this.rivalValue.textContent = p.rival;
    this.mineBar.style.width = `${Math.round(p.mineFrac * 100)}%`;
    this.rivalBar.style.width = `${Math.round(p.rivalFrac * 100)}%`;
  }
}
