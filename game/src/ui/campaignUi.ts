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
 * NOVATERRA — ui/campaignUi.ts — campaign screens (Phase 2).
 *
 * Responsibilities:
 *  - `MissionSelect`: the 8-mission list with locked/unlocked/completed
 *    states. Pure DOM; the caller supplies the progress and callbacks.
 *  - `MissionBriefing`: mission title, briefing paragraphs, victory
 *    paths with their objectives, Start/Cancel.
 *  - `MissionDebrief`: victory/defeat overlay with the mission's
 *    debrief copy, the diplomat/commander points earned, and — after
 *    the final mission — the campaign ending ("The Peacemaker" or
 *    "The Commander").
 *  - `MissionPanel`: the in-HUD objective tracker. `update(progress)`
 *    re-renders path/objective states from
 *    `missionProgress(run, mission, world)`; completed objectives get a
 *    checkmark, the active path is highlighted.
 *
 * Pure DOM + campaign data. Never touches the sim.
 */

import {
  missionsInOrder,
  type MissionDef,
  type MissionPath,
} from '../campaign/missions';
import {
  isMissionUnlocked,
  campaignEnding,
  ENDING_COPY,
  type CampaignProgress,
} from '../campaign/progress';
import type { ObjectiveProgress } from '../campaign/objectives';
import { STRINGS, loc } from './strings';
import { type EndGameStats, endStatsLines } from './endStats';

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

// ---------------------------------------------------------------------------
// Mission select
// ---------------------------------------------------------------------------

export interface MissionSelectActions {
  onSelect(mission: MissionDef): void;
  onBack(): void;
}

export class MissionSelect {
  private readonly root: HTMLElement;
  private readonly actions: MissionSelectActions;
  private el: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: MissionSelectActions) {
    this.root = root;
    this.actions = actions;
  }

  show(progress: CampaignProgress): void {
    this.hide();
    const overlay = el('div', 'menu-overlay mission-select');
    overlay.append(el('h1', '', 'The First Term'));
    overlay.append(el('p', 'tagline', 'Eight missions. One presidency. How will history remember you?'));

    const list = el('div', 'mission-list');
    for (const mission of missionsInOrder()) {
      const unlocked = isMissionUnlocked(progress, mission);
      const done = progress.completed.includes(mission.id);
      const item = el('div', `mission-item${unlocked ? '' : ' locked'}${done ? ' done' : ''}`);
      const head = el('div', 'mission-head');
      head.append(el('span', 'mission-order', `Mission ${mission.order}`));
      head.append(el('span', 'mission-name', mission.name));
      head.append(el('span', 'mission-state', done ? '✓ Complete' : unlocked ? '' : '🔒 Locked'));
      item.append(head);
      item.append(el('p', 'mission-blurb', mission.briefing[0] ?? ''));
      if (unlocked) {
        item.append(button(done ? 'Replay' : 'Briefing', () => this.actions.onSelect(mission)));
      }
      list.append(item);
    }
    overlay.append(list);

    const foot = el('div', 'mission-foot');
    foot.append(el('span', '', `Diplomat ${progress.diplomat} · Commander ${progress.commander}`));
    foot.append(button('Back', () => this.actions.onBack()));
    overlay.append(foot);

    this.root.append(overlay);
    this.el = overlay;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}

// ---------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------

export interface MissionBriefingActions {
  onStart(mission: MissionDef): void;
  onBack(): void;
}

export class MissionBriefing {
  private readonly root: HTMLElement;
  private readonly actions: MissionBriefingActions;
  private el: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: MissionBriefingActions) {
    this.root = root;
    this.actions = actions;
  }

  show(mission: MissionDef): void {
    this.hide();
    const overlay = el('div', 'menu-overlay mission-briefing');
    overlay.append(el('p', 'mission-kicker', `Mission ${mission.order} of 8`));
    overlay.append(el('h1', '', mission.name));
    for (const para of mission.briefing) {
      overlay.append(el('p', 'briefing-text', para));
    }

    const mapContainer = el('div', 'briefing-map-card');
    const mapImg = document.createElement('img');
    mapImg.src = `img/art/briefings/mission-${mission.order}.jpg`;
    mapImg.alt = `${mission.name} tactical overview`;
    mapImg.className = 'briefing-map-img';
    mapImg.onerror = () => { mapContainer.style.display = 'none'; };
    mapContainer.append(mapImg);
    overlay.append(mapContainer);

    const paths = el('div', 'mission-paths');
    for (const path of mission.paths) {
      const card = el('div', `path-card${path.peaceful ? ' peaceful' : ''}`);
      card.append(el('h3', '', `${path.peaceful ? '🕊 ' : '⚔ '}${path.name}`));
      const ul = el('ul', '') as HTMLUListElement;
      for (const o of path.objectives) {
        const li = document.createElement('li');
        li.textContent = o.label;
        ul.append(li);
      }
      card.append(ul);
      paths.append(card);
    }
    overlay.append(paths);

    const meta = el('p', 'briefing-meta',
      `Map: ${mission.mapPreset} · Rival: ${mission.aiDifficulty === 'none' ? 'none' : mission.aiDifficulty}`);
    overlay.append(meta);

    const row = el('div', 'buttons');
    row.append(button('Back', () => this.actions.onBack()));
    row.append(button('Start Mission', () => this.actions.onStart(mission)));
    overlay.append(row);

    this.root.append(overlay);
    this.el = overlay;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}

// ---------------------------------------------------------------------------
// Debrief
// ---------------------------------------------------------------------------

export interface DebriefResult {
  mission: MissionDef;
  victory: boolean;
  wonPath: MissionPath | null;
  diplomat: number;
  commander: number;
  isFinalMission: boolean;
  progress: CampaignProgress;
  /**
   * Fun-audit B3 (2026-10-02): the session record — the same stat
   * surface as the skirmish end screen (C6 art is reused for campaign
   * endings; the stats ride along the same way).
   */
  stats?: EndGameStats;
}

export interface MissionDebriefActions {
  onContinue(): void;
}

export class MissionDebrief {
  private readonly root: HTMLElement;
  private readonly actions: MissionDebriefActions;
  private el: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: MissionDebriefActions) {
    this.root = root;
    this.actions = actions;
  }

  show(result: DebriefResult): void {
    this.hide();
    const overlay = el('div', `end-screen end-${result.victory ? 'victory' : 'defeat'}`);
    const panel = el('div', 'end-panel');

    const title = el('h2', '', result.victory ? 'Mission Complete' : 'Mission Failed');
    panel.append(title);
    const detail = el('p', '', result.victory ? result.mission.debriefWin : result.mission.debriefLose);
    panel.append(detail);

    if (result.victory && result.wonPath) {
      panel.append(el('p', 'debrief-path',
        `Completed via: ${result.wonPath.peaceful ? '🕊 ' : '⚔ '}${result.wonPath.name}`));
      panel.append(el('p', 'debrief-score',
        `+${result.diplomat} Diplomat · +${result.commander} Commander`));
    }

    if (result.victory && result.isFinalMission) {
      const ending = campaignEnding(result.progress);
      const copy = ENDING_COPY[ending];
      panel.append(el('h2', 'campaign-ending-title', copy.title));
      panel.append(el('p', 'campaign-ending-text', copy.text));
      panel.append(el('p', 'debrief-score',
        `Final tally — Diplomat ${result.progress.diplomat} · Commander ${result.progress.commander}`));
    }

    // Fun-audit B3 (2026-10-02): the session record, same surface as
    // the skirmish end screen.
    if (result.stats !== undefined) {
      panel.append(el('h3', 'end-stats-title', loc(STRINGS.endStats.title)));
      const statsList = el('ul', 'end-stats');
      for (const line of endStatsLines(result.stats)) {
        statsList.append(el('li', '', line));
      }
      panel.append(statsList);
    }

    const row = el('div', 'buttons');
    row.append(button(result.victory && result.isFinalMission ? 'Finish' : 'Continue',
      () => this.actions.onContinue()));
    panel.append(row);

    overlay.append(panel);
    this.root.append(overlay);
    this.el = overlay;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}

// ---------------------------------------------------------------------------
// In-HUD objective tracker
// ---------------------------------------------------------------------------

export interface PathProgress {
  path: MissionPath;
  complete: boolean;
  objectives: ObjectiveProgress[];
}

/**
 * Compact objectives panel pinned to the HUD. Call `update` with fresh
 * `missionProgress(...)` output whenever the UI refreshes (1–2×/sec is
 * plenty — objectives change slowly).
 */
export class MissionPanel {
  private readonly root: HTMLElement;
  private el: HTMLElement | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  show(): void {
    this.hide();
    const panel = el('div', 'mission-panel');
    this.root.append(panel);
    this.el = panel;
  }

  update(mission: MissionDef, progress: PathProgress[]): void {
    if (this.el === null) return;
    this.el.replaceChildren();
    this.el.append(el('h4', '', mission.name));
    for (const p of progress) {
      const pathEl = el('div', `mission-path${p.complete ? ' done' : ''}`);
      pathEl.append(el('div', 'path-name',
        `${p.complete ? '✓ ' : ''}${p.path.peaceful ? '🕊 ' : '⚔ '}${p.path.name}`));
      const ul = el('ul', '') as HTMLUListElement;
      p.path.objectives.forEach((o, i) => {
        const state = p.objectives[i];
        const li = document.createElement('li');
        li.className = state?.complete === true ? 'done' : '';
        li.textContent = `${state?.complete === true ? '✓ ' : '· '}${o.label}` +
          (state && !state.complete ? ` — ${state.progress}` : '');
        ul.append(li);
      });
      pathEl.append(ul);
      this.el.append(pathEl);
    }
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}
