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
 * NOVATERRA — ui/hud.ts — heads-up display (DOM overlay).
 *
 * Responsibilities:
 *  - Top bar: Funds, Materials, Food, Fuel, Population, age + National
 *    Program, advance-age button when affordable, game speed (pause/1×/2×/4×),
 *    menu button.
 *  - Advisor panel: worst problems first (from ui/advisor.ts), or the
 *    all-clear line when nothing is wrong.
 *  - Selection panel: what is selected + contextual actions (Stop; Train
 *    for unit production; Build palette for construction).
 *  - Toasts: one-line feedback for rejected orders and confirmations.
 *  - `update()` is called every frame but only touches the DOM when a
 *    displayed value actually changed (cheap text updates otherwise).
 *
 * The HUD never mutates sim state — every button calls back into the game
 * controller, which issues commands through the queue. Copy comes from
 * ui/strings.ts.
 *
 * DOM module: only constructed inside boot()/startGame(), never imported
 * by headless tests.
 */

import type { World } from '../sim/world';
import { getPlayer } from '../sim/city';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { BUILDING_DEFS, BuildingKind } from '../sim/city';
import { AGE_PROGRESSION } from '../sim/ages';
import type { Selection } from './selection';
import type { AdvisorItem } from './advisor';
import { STRINGS } from './strings';
import { HUMAN_PLAYER_ID } from './session';

/** Build-palette tools the HUD can request. */
export type BuildTool =
  | 'road'
  | 'zoneR'
  | 'zoneC'
  | 'zoneI'
  | `building:${BuildingKind}`
  | 'demolish';

/** Actions the HUD delegates to the game controller. */
export interface HUDActions {
  onPauseToggle(): void;
  onSpeedChange(speed: number): void;
  onOpenMenu(): void;
  onStopSelection(): void;
  /** Train panel: enter unit-placement mode for this kind. */
  onTrainUnit(kind: UnitKind): void;
  /** Build palette: enter construction mode with this tool. */
  onBuildTool(tool: BuildTool): void;
  /** Cancel any placement/construction mode. */
  onCancelPlacement(): void;
  onAdvanceAge(program: string): void;
}

/** Trainable unit kinds in display order. */
const TRAIN_ORDER: UnitKind[] = [
  'engineer',
  'rifles',
  'tank',
  'artillery',
  'aa',
  'hauler',
  'spectre',
  'hq',
  'drone',
  'transport',
  'fighter',
];

/** Build-palette entries in display order. */
const BUILD_TOOLS: Array<{ tool: BuildTool; label: string }> = [
  { tool: 'road', label: 'Road' },
  { tool: 'zoneR', label: 'Homes' },
  { tool: 'zoneC', label: 'Shops' },
  { tool: 'zoneI', label: 'Industry' },
  { tool: 'building:powerPlant', label: 'Power' },
  { tool: 'building:waterPump', label: 'Water' },
  { tool: 'building:house', label: 'House' },
  { tool: 'building:factory', label: 'Factory' },
  { tool: 'building:farm', label: 'Farm' },
  { tool: 'demolish', label: 'Demolish' },
];

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fmt(n: number): string {
  if (Math.abs(n) >= 10000) return `${(n / 1000).toFixed(1)}k`;
  return Math.floor(n).toString();
}

/**
 * The in-game HUD. Construct once per game; call `update()` every frame.
 */
export class HUD {
  private readonly root: HTMLElement;
  private readonly actions: HUDActions;
  private readonly topbar: HTMLElement;
  private readonly resEls = new Map<string, HTMLElement>();
  private readonly ageEl: HTMLElement;
  private readonly ageBtn: HTMLButtonElement;
  private currentAge: string = 'foundation';
  private readonly pauseBtn: HTMLButtonElement;
  private readonly speedBtns: HTMLButtonElement[] = [];
  private readonly advisorPanel: HTMLElement;
  private readonly advisorList: HTMLElement;
  private readonly selectionPanel: HTMLElement;
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;
  private lastText = new Map<string, string>();
  private lastAdvisorKey = '';

  constructor(root: HTMLElement, actions: HUDActions) {
    this.root = root;
    this.actions = actions;
    const s = STRINGS.hud;

    const hud = el('div', 'hud');
    hud.id = 'hud';

    // ---- top bar ----
    this.topbar = el('div', 'hud-topbar');
    for (const [key, label] of [
      ['funds', s.funds],
      ['materials', s.materials],
      ['food', s.food],
      ['fuel', s.fuel],
      ['goods', s.goods],
      ['influence', s.influence],
      ['manpower', s.manpower],
      ['population', s.population],
    ] as Array<[string, string]>) {
      const chip = el('div', 'hud-chip');
      chip.append(el('span', 'hud-chip-label', label));
      const value = el('span', 'hud-chip-value', '0');
      chip.append(value);
      this.topbar.append(chip);
      this.resEls.set(key, value);
    }
    this.ageEl = el('div', 'hud-age', '');
    this.topbar.append(this.ageEl);
    this.ageBtn = document.createElement('button');
    this.ageBtn.className = 'hud-age-btn';
    this.ageBtn.textContent = s.advanceAge;
    this.ageBtn.addEventListener('click', () => this.onAgeButton());
    this.topbar.append(this.ageBtn);

    const spacer = el('div', 'hud-spacer');
    this.topbar.append(spacer);

    for (const [speed, label] of [
      [1, s.speed1],
      [2, s.speed2],
      [4, s.speed4],
    ] as Array<[number, string]>) {
      const b = document.createElement('button');
      b.className = 'hud-speed';
      b.textContent = label;
      b.addEventListener('click', () => actions.onSpeedChange(speed));
      this.topbar.append(b);
      this.speedBtns.push(b);
    }
    this.pauseBtn = document.createElement('button');
    this.pauseBtn.className = 'hud-pause';
    this.pauseBtn.textContent = s.pause;
    this.pauseBtn.addEventListener('click', () => actions.onPauseToggle());
    this.topbar.append(this.pauseBtn);

    const menuBtn = document.createElement('button');
    menuBtn.className = 'hud-menu-btn';
    menuBtn.textContent = s.menu;
    menuBtn.addEventListener('click', () => actions.onOpenMenu());
    this.topbar.append(menuBtn);
    hud.append(this.topbar);

    // ---- advisor ----
    this.advisorPanel = el('div', 'hud-advisor');
    this.advisorPanel.append(el('div', 'hud-panel-title', STRINGS.advisor.title));
    this.advisorList = el('div', 'hud-advisor-list');
    this.advisorPanel.append(this.advisorList);
    hud.append(this.advisorPanel);

    // ---- selection ----
    this.selectionPanel = el('div', 'hud-selection');
    hud.append(this.selectionPanel);

    // ---- toast ----
    this.toastEl = el('div', 'hud-toast');
    this.toastEl.id = 'hud-toast';
    hud.append(this.toastEl);

    root.append(hud);
  }

  /** Refresh all panels from the world. Cheap: DOM writes only on change. */
  update(
    world: World,
    selection: Selection,
    advisor: AdvisorItem[],
    paused: boolean,
    speed: number,
  ): void {
    const player = getPlayer(world.city, HUMAN_PLAYER_ID);
    if (player) {
      this.setText('funds', fmt(player.funds), this.resEls.get('funds'));
      this.setText('materials', fmt(player.materials), this.resEls.get('materials'));
      this.setText('food', fmt(player.food), this.resEls.get('food'));
      this.setText('fuel', fmt(player.fuel), this.resEls.get('fuel'));
      this.setText('goods', fmt(player.goods), this.resEls.get('goods'));
      this.setText('influence', fmt(player.influence), this.resEls.get('influence'));
      this.setText('manpower', fmt(player.manpower), this.resEls.get('manpower'));
      this.setText('population', fmt(player.population), this.resEls.get('population'));
    }
    const s = STRINGS.hud;
    // Age display names and program names.
    const ageNames: Record<string, string> = {
      foundation: s.ageFoundation,
      connectivity: s.ageConnectivity,
      industry: s.ageIndustry,
      information: s.ageInformation,
      ascendance: s.ageAscendance,
    };
    const programNames: Record<string, string> = {
      fiberGrid: s.programFiber,
      signalsGrid: s.programSignals,
      heavyIndustry: s.programHeavyIndustry,
      greenTech: s.programGreenTech,
      cyberCommand: s.programCyberCommand,
      globalMedia: s.programGlobalMedia,
      arsenalProgram: s.programArsenal,
      prosperityProgram: s.programProsperity,
    };
    const ageName =
      world.ages.age === 'foundation'
        ? s.ageFoundation
        : `${ageNames[world.ages.age]} · ${programNames[world.ages.program ?? ''] ?? ''}`;
    this.setText('age', ageName, this.ageEl);
    this.currentAge = world.ages.age;

    // Advance-age button: visible when a next age exists; shows cost and programs.
    const prog = AGE_PROGRESSION[world.ages.age];
    if (prog.next && player) {
      const cost = prog.cost;
      const affordable = Object.entries(cost).every(([res, amt]) => {
        const have = (player as unknown as Record<string, number>)[res] ?? 0;
        return have >= amt;
      });
      const costStr = Object.entries(cost).map(([res, amt]) => `${amt} ${res}`).join(' + ');
      const progStr = prog.programs.map(p => programNames[p] ?? p).join(' or ');
      this.ageBtn.style.display = '';
      this.ageBtn.disabled = !affordable;
      this.ageBtn.title = affordable
        ? `${progStr}. Permanent choice. Cost: ${costStr}.`
        : `Needs ${costStr}.`;
    } else {
      this.ageBtn.style.display = 'none';
    }

    this.pauseBtn.textContent = paused ? s.resume : s.pause;
    this.pauseBtn.classList.toggle('active', paused);
    const speeds = [1, 2, 4];
    this.speedBtns.forEach((b, i) => b.classList.toggle('active', !paused && speed === speeds[i]));

    this.updateAdvisor(advisor);
    this.updateSelection(world, selection);
  }

  /** Show the two National Program choices (called by the age button). */
  private onAgeButton(): void {
    const s = STRINGS.hud;
    const prog = AGE_PROGRESSION[this.currentAge as keyof typeof AGE_PROGRESSION];
    if (!prog || !prog.next) return;
    const programNames: Record<string, string> = {
      fiberGrid: s.programFiber,
      signalsGrid: s.programSignals,
      heavyIndustry: s.programHeavyIndustry,
      greenTech: s.programGreenTech,
      cyberCommand: s.programCyberCommand,
      globalMedia: s.programGlobalMedia,
      arsenalProgram: s.programArsenal,
      prosperityProgram: s.programProsperity,
    };
    const p1 = prog.programs[0] ?? '';
    const p2 = prog.programs[1] ?? '';
    const chooseFirst = window.confirm(
      `${s.advanceAge} to ${prog.next}: OK = ${programNames[p1] ?? p1}, Cancel = ${programNames[p2] ?? p2}. This choice is permanent.`,
    );
    this.actions.onAdvanceAge(chooseFirst ? p1 : p2);
  }

  private updateAdvisor(items: AdvisorItem[]): void {
    const key = items.map((i) => `${i.severity}:${i.title}`).join('|');
    if (key === this.lastAdvisorKey) return;
    this.lastAdvisorKey = key;
    this.advisorList.textContent = '';
    if (items.length === 0) {
      this.advisorList.append(el('div', 'advisor-item info', STRINGS.advisor.allClear));
      return;
    }
    for (const item of items.slice(0, 4)) {
      const div = el('div', `advisor-item ${item.severity}`);
      div.append(el('div', 'advisor-title', item.title));
      div.append(el('div', 'advisor-detail', item.detail));
      this.advisorList.append(div);
    }
  }

  private updateSelection(world: World, selection: Selection): void {
    const panel = this.selectionPanel;
    const sel = STRINGS.selection;
    // Rebuild only when the selection identity changes.
    const key = `u:${selection.unitIds.join(',')}|b:${selection.buildingId}`;
    if (panel.dataset['key'] === key && panel.dataset['tick'] === String(world.tick)) return;
    panel.dataset['key'] = key;
    panel.dataset['tick'] = String(world.tick);
    panel.textContent = '';

    if (selection.unitIds.length === 0 && selection.buildingId === null) {
      panel.append(el('div', 'sel-empty', sel.noSelection));
      this.appendTrainPanel(panel, world);
      this.appendBuildPanel(panel);
      return;
    }

    if (selection.unitIds.length > 0) {
      const units = selection.unitIds
        .map((id) => world.units.find((u) => u.id === id))
        .filter((u) => u !== undefined);
      panel.append(el('div', 'sel-title', sel.unitsSelected(units.length)));
      for (const u of units.slice(0, 6)) {
        const def = UNIT_DEFS[u.kind as UnitKind];
        const hpFrac = def ? Math.max(0, Math.round((u.hp / def.hp) * 100)) : 0;
        panel.append(el('div', 'sel-unit', `${def?.name ?? u.kind} · ${hpFrac}%`));
      }
      if (units.length > 6) panel.append(el('div', 'sel-unit', `… +${units.length - 6} more`));
      const stopBtn = document.createElement('button');
      stopBtn.className = 'sel-action';
      stopBtn.textContent = sel.stop;
      stopBtn.addEventListener('click', () => this.actions.onStopSelection());
      panel.append(stopBtn);
      return;
    }

    const b = world.city.buildings.find((x) => x.id === selection.buildingId);
    if (b) {
      const def = BUILDING_DEFS[b.kind];
      panel.append(el('div', 'sel-title', def?.name ?? b.kind));
      panel.append(
        el('div', 'sel-unit', b.operational ? 'Operational' : 'Not operational'),
      );
    }
  }

  private appendTrainPanel(panel: HTMLElement, world: World): void {
    const wrap = el('div', 'train-panel');
    wrap.append(el('div', 'hud-panel-title', STRINGS.selection.train));
    const inConnectivity = world.ages.age === 'connectivity';
    for (const kind of TRAIN_ORDER) {
      const def = UNIT_DEFS[kind];
      if (def.minAge === 'connectivity' && !inConnectivity) continue;
      const b = document.createElement('button');
      b.className = 'train-btn';
      b.textContent = def.name;
      b.title = `Click, then click the map to place. ${def.hp} HP.`;
      b.addEventListener('click', () => this.actions.onTrainUnit(kind));
      wrap.append(b);
    }
    panel.append(wrap);
  }

  private appendBuildPanel(panel: HTMLElement): void {
    const wrap = el('div', 'build-panel');
    wrap.append(el('div', 'hud-panel-title', STRINGS.selection.build));
    for (const { tool, label } of BUILD_TOOLS) {
      const b = document.createElement('button');
      b.className = 'build-btn';
      b.textContent = label;
      b.addEventListener('click', () => this.actions.onBuildTool(tool));
      wrap.append(b);
    }
    const cancel = document.createElement('button');
    cancel.className = 'build-btn cancel';
    cancel.textContent = 'Cancel (Esc)';
    cancel.addEventListener('click', () => this.actions.onCancelPlacement());
    wrap.append(cancel);
    panel.append(wrap);
  }

  /** One-line transient feedback. */
  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }

  private setText(key: string, text: string, target: HTMLElement | undefined): void {
    if (!target || this.lastText.get(key) === text) return;
    this.lastText.set(key, text);
    target.textContent = text;
  }

  dispose(): void {
    window.clearTimeout(this.toastTimer);
    document.getElementById('hud')?.remove();
  }
}
