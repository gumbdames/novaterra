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
 *  - Selection panel: what is selected + contextual actions (Stop; tabbed
 *    Train/Build palettes when nothing is selected).
 *  - Train palette: 4 tabs (spec §8) for the 28 units; production-gated
 *    units show greyed with the required building named; costs show
 *    funds + materials + manpower.
 *  - Build palette: tool row (road/zones/demolish) + 6 tabs (spec §8) for
 *    the 28 buildings; unaffordable buildings grey out; navalYard's coast
 *    rule is surfaced in its tooltip.
 *  - Research panel: at a completed Research Lab (or listed in the HUD
 *    when the player owns one), the 12 upgrades with funds + research
 *    cost, prerequisites and one-line effect; unavailable upgrades grey
 *    out with reasons.
 *  - Toasts: one-line feedback for rejected orders and confirmations.
 *  - `update()` is called every frame but only touches the DOM when a
 *    displayed value actually changed (cheap text updates otherwise).
 *
 * The HUD never mutates sim state — every button calls back into the game
 * controller, which issues commands through the queue. Copy comes from
 * ui/strings.ts (English-only, see docs/I18N.md); availability mirrors
 * ui/palettes.ts.
 *
 * DOM module: only constructed inside boot()/startGame(), never imported
 * by headless tests.
 */

import type { World } from '../sim/world';
import { getPlayer } from '../sim/city';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { type BuildingKind } from '../sim/city';
import { AGE_PROGRESSION } from '../sim/ages';
import type { UpgradeId } from '../sim/upgrades';
import type { Selection } from './selection';
import type { AdvisorItem } from './advisor';
import { STRINGS, loc, type LocalizedString } from './strings';
import {
  TRAIN_TABS,
  BUILD_TABS,
  UPGRADE_GROUPS,
  unitName,
  buildingName,
  upgradeName,
  upgradeEffect,
  unitAvailability,
  buildingAvailability,
  upgradeAvailability,
  playerHasCompletedLab,
  formatTrainCost,
  formatBuildCost,
  formatResearchCost,
  trainTooltip,
  buildTooltip,
  type TrainTabId,
  type BuildTabId,
} from './palettes';
import {
  unitIcon,
  buildingIcon,
  toolIcon,
  type PaletteToolIcon,
} from './icons';
import { HUMAN_PLAYER_ID } from './session';
import { selectionDigest as paletteDigest } from './paletteDigest';

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
  /** Phase 3: fire the Aegis shield. */
  onFireAegis(): void;
  /** Phase 3: enter Storm targeting mode (click map). */
  onStormTarget(): void;
  /** Phase 3: set city specialization. */
  onSetSpecialization(spec: string): void;
  /** Phase 3: establish a trade route. */
  onEstablishTradeRoute(partner: number): void;
  /** Phase 3: cancel a trade route. */
  onCancelTradeRoute(partner: number): void;
  /** Phase 3: appoint a mayor. */
  onAssignMayor(policy: string): void;
  /** Phase 3: dismiss the mayor. */
  onDismissMayor(): void;
  /** Polish: set the mayor's build policy. */
  onSetMayorBuildPolicy(buildPolicy: string): void;
  /** Phase 3: appoint a general over selected units. */
  onAssignGeneral(stance: string): void;
  /** Phase 3: dismiss the general. */
  onDismissGeneral(): void;
  /** Phase 3: change general stance. */
  onSetGeneralStance(stance: string): void;
  /** Roster expansion: research an upgrade (from the research panel). */
  onResearchUpgrade(upgradeId: UpgradeId): void;
}

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
 * Decorative icon span for palette buttons (glyph from ui/icons.ts).
 * Always paired with the button's text label — the icon is aria-hidden
 * and the label stays the accessible name.
 */
function iconSpan(markup: string): HTMLElement {
  const s = el('span', 'palette-icon');
  s.innerHTML = markup;
  s.setAttribute('aria-hidden', 'true');
  return s;
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
  private readonly phase3Panel: HTMLElement;
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;
  private lastText = new Map<string, string>();
  private lastAdvisorKey = '';
  /** Active palette tabs (persist across the per-tick panel rebuilds). */
  private trainTab: TrainTabId = 'infantry';
  private buildTab: BuildTabId = 'housing';
  /**
   * Set by tab switches / research clicks so the selection panel rebuilds
   * even when the sim tick hasn't advanced (e.g. while paused).
   */
  private paletteDirty = false;

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

    // ---- Phase 3: command, superweapons, city ----
    this.phase3Panel = el('div', 'hud-phase3');
    this.buildPhase3Panel();
    hud.append(this.phase3Panel);

    // ---- toast ----
    this.toastEl = el('div', 'hud-toast');
    this.toastEl.id = 'hud-toast';
    hud.append(this.toastEl);

    root.append(hud);
  }

  /** Phase 3 panel: superweapons, specialization, trade, delegation. */
  private buildPhase3Panel(): void {
    const panel = this.phase3Panel;
    panel.append(el('div', 'hud-panel-title', 'Command'));

    // Superweapons.
    const swRow = el('div', 'hud-phase3-row');
    const aegisBtn = document.createElement('button');
    aegisBtn.className = 'hud-btn';
    aegisBtn.textContent = 'Fire Aegis';
    aegisBtn.title = 'Raise the Aegis shield (Ascendance + Aegis Control)';
    aegisBtn.addEventListener('click', () => this.actions.onFireAegis());
    swRow.append(aegisBtn);
    const stormBtn = document.createElement('button');
    stormBtn.className = 'hud-btn';
    stormBtn.textContent = 'Storm Target';
    stormBtn.title = 'Enter Storm targeting mode, then click the map (Ascendance + Storm Array)';
    stormBtn.addEventListener('click', () => this.actions.onStormTarget());
    swRow.append(stormBtn);
    panel.append(swRow);

    // Specialization.
    const specRow = el('div', 'hud-phase3-row');
    specRow.append(el('span', 'hud-label', 'Focus:'));
    for (const spec of ['balanced', 'industrial', 'commercial', 'residential']) {
      const b = document.createElement('button');
      b.className = 'hud-btn small';
      b.textContent = spec;
      b.addEventListener('click', () => this.actions.onSetSpecialization(spec));
      specRow.append(b);
    }
    panel.append(specRow);

    // Delegation: mayor.
    const mayorRow = el('div', 'hud-phase3-row');
    mayorRow.append(el('span', 'hud-label', 'Mayor:'));
    for (const policy of ['balanced', 'growth', 'revenue']) {
      const b = document.createElement('button');
      b.className = 'hud-btn small';
      b.textContent = policy;
      b.addEventListener('click', () => this.actions.onAssignMayor(policy));
      mayorRow.append(b);
    }
    const disMayor = document.createElement('button');
    disMayor.className = 'hud-btn small';
    disMayor.textContent = 'Dismiss';
    disMayor.addEventListener('click', () => this.actions.onDismissMayor());
    mayorRow.append(disMayor);
    panel.append(mayorRow);

    // Delegation: mayor build policy (what the mayor auto-builds).
    const buildRow = el('div', 'hud-phase3-row');
    buildRow.append(el('span', 'hud-label', 'Mayor builds:'));
    for (const bp of ['housing', 'industry', 'balanced']) {
      const b = document.createElement('button');
      b.className = 'hud-btn small';
      b.textContent = bp;
      b.addEventListener('click', () => this.actions.onSetMayorBuildPolicy(bp));
      buildRow.append(b);
    }
    panel.append(buildRow);

    // Delegation: general.
    const genRow = el('div', 'hud-phase3-row');
    genRow.append(el('span', 'hud-label', 'General:'));
    for (const stance of ['aggressive', 'defensive', 'hold']) {
      const b = document.createElement('button');
      b.className = 'hud-btn small';
      b.textContent = stance;
      b.addEventListener('click', () => this.actions.onAssignGeneral(stance));
      genRow.append(b);
    }
    const disGen = document.createElement('button');
    disGen.className = 'hud-btn small';
    disGen.textContent = 'Dismiss';
    disGen.addEventListener('click', () => this.actions.onDismissGeneral());
    genRow.append(disGen);
    panel.append(genRow);
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
    // Keyed on severity + title + detail (AD11 digest contract): the panel
    // renders item.detail, so the rebuild key must cover it — otherwise a
    // detail change under identical severity+title leaves a stale panel
    // (same bug class as the 2026-09-30 click bug).
    const key = items.map((i) => `${i.severity}:${i.title}:${i.detail}`).join('|');
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

  /**
   * Content digest for the selection panel — see ui/paletteDigest.ts
   * (pure, headless-tested). `updateSelection` rebuilds only when the
   * digest changes, so button nodes stay stable across frames (a click
   * needs pointerdown + pointerup on the same node) while
   * costs/availability still refresh the moment they actually change.
   */
  private selectionDigest(world: World, selection: Selection): string {
    return paletteDigest(world, selection, this.trainTab, this.buildTab);
  }

  private updateSelection(world: World, selection: Selection): void {
    const panel = this.selectionPanel;
    const sel = STRINGS.selection;
    // Rebuild only when the rendered content actually changes. The panel
    // must stay node-stable across frames: recreating the palette buttons
    // every sim tick broke real clicks — pointerdown and pointerup landed
    // on different nodes, so no click event ever fired and palette tabs /
    // items were unclickable while the sim ran. The digest covers
    // everything the panel renders (selection identity, active tabs,
    // per-button availability, research states, unit/building vitals);
    // a palette interaction that must repaint immediately (tab switch,
    // research click while paused) still sets paletteDirty.
    const key = this.selectionDigest(world, selection);
    const dirty = this.paletteDirty;
    this.paletteDirty = false;
    if (!dirty && panel.dataset['key'] === key) {
      return;
    }
    panel.dataset['key'] = key;
    panel.textContent = '';

    if (selection.unitIds.length === 0 && selection.buildingId === null) {
      panel.append(el('div', 'sel-empty', sel.noSelection));
      this.appendTrainPanel(panel, world);
      this.appendBuildPanel(panel, world);
      // The research panel is also listed in the HUD whenever the player
      // owns a completed lab (spec §8), not only when the lab is selected.
      if (playerHasCompletedLab(world, HUMAN_PLAYER_ID)) {
        this.appendResearchPanel(panel, world);
      }
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
      panel.append(el('div', 'sel-title', buildingName(b.kind)));
      panel.append(
        el('div', 'sel-unit', b.operational ? 'Operational' : 'Not operational'),
      );
      // A completed Research Lab opens the research panel (spec §8).
      if (b.kind === 'lab' && b.owner === HUMAN_PLAYER_ID && b.progress >= 1) {
        this.appendResearchPanel(panel, world);
      }
    }
  }

  /** Tabbed train palette: 4 tabs for the 28 units (spec §8). */
  private appendTrainPanel(panel: HTMLElement, world: World): void {
    const wrap = el('div', 'train-panel');
    wrap.append(el('div', 'hud-panel-title', loc(STRINGS.palettes.trainTitle)));
    wrap.append(this.buildTabBar(TRAIN_TABS, STRINGS.unitTabs, this.trainTab, (id) => {
      this.trainTab = id as TrainTabId;
    }));
    const grid = el('div', 'palette-grid');
    const tab = TRAIN_TABS.find((t) => t.id === this.trainTab) ?? TRAIN_TABS[0]!;
    for (const kind of tab.kinds) {
      // Locked units stay visible but greyed, with the blocker named —
      // the same rule as spawn validation (age → building → cost).
      const av = unitAvailability(world, HUMAN_PLAYER_ID, kind);
      const b = document.createElement('button');
      b.className = `train-btn${av.ok ? '' : ' locked'}`;
      b.disabled = !av.ok;
      b.prepend(iconSpan(unitIcon(kind)));
      b.append(el('div', 'palette-name', unitName(kind)));
      b.append(el('div', 'palette-cost', formatTrainCost(kind)));
      b.title = trainTooltip(world, HUMAN_PLAYER_ID, kind);
      b.addEventListener('click', () => this.actions.onTrainUnit(kind));
      grid.append(b);
    }
    wrap.append(grid);
    panel.append(wrap);
  }

  /** Tabbed build palette: tool row + 6 tabs for the 28 buildings (spec §8). */
  private appendBuildPanel(panel: HTMLElement, world: World): void {
    const p = STRINGS.palettes;
    const wrap = el('div', 'build-panel');
    wrap.append(el('div', 'hud-panel-title', loc(p.buildTitle)));
    // Tools are not buildings: road, zones and demolish sit above the tabs.
    const toolsRow = el('div', 'palette-tools');
    const tools: Array<{ tool: BuildTool; label: string; icon: PaletteToolIcon }> = [
      { tool: 'road', label: loc(p.toolRoad), icon: 'road' },
      { tool: 'zoneR', label: loc(p.toolZoneR), icon: 'zoneR' },
      { tool: 'zoneC', label: loc(p.toolZoneC), icon: 'zoneC' },
      { tool: 'zoneI', label: loc(p.toolZoneI), icon: 'zoneI' },
      { tool: 'demolish', label: loc(p.toolDemolish), icon: 'demolish' },
    ];
    for (const { tool, label, icon } of tools) {
      const b = document.createElement('button');
      b.className = 'build-btn';
      b.prepend(iconSpan(toolIcon(icon)));
      b.append(el('span', 'palette-label', label));
      b.addEventListener('click', () => this.actions.onBuildTool(tool));
      toolsRow.append(b);
    }
    wrap.append(toolsRow);
    wrap.append(this.buildTabBar(BUILD_TABS, STRINGS.buildingTabs, this.buildTab, (id) => {
      this.buildTab = id as BuildTabId;
    }));
    const grid = el('div', 'palette-grid');
    const tab = BUILD_TABS.find((t) => t.id === this.buildTab) ?? BUILD_TABS[0]!;
    for (const kind of tab.kinds) {
      // Unavailable buildings grey out with a tooltip reason (age gate,
      // then affordability). The navalYard coast rule rides in the
      // tooltip since it is placement-time, not palette-time.
      const avail = buildingAvailability(world, HUMAN_PLAYER_ID, kind);
      const b = document.createElement('button');
      b.className = `build-btn${avail.ok ? '' : ' locked'}`;
      b.disabled = !avail.ok;
      b.prepend(iconSpan(buildingIcon(kind)));
      b.append(el('div', 'palette-name', buildingName(kind)));
      b.append(el('div', 'palette-cost', formatBuildCost(kind)));
      const tip = buildTooltip(kind);
      b.title = avail.reason !== '' ? `${tip}\n${avail.reason}` : tip;
      b.addEventListener('click', () => this.actions.onBuildTool(`building:${kind}`));
      grid.append(b);
    }
    wrap.append(grid);
    const cancel = document.createElement('button');
    cancel.className = 'build-btn cancel';
    cancel.textContent = loc(p.cancelPlacement);
    cancel.addEventListener('click', () => this.actions.onCancelPlacement());
    wrap.append(cancel);
    panel.append(wrap);
  }

  /**
   * Research panel: the 12 upgrades in Military/Economy groups (spec §8).
   * Each row shows the localized name, funds + research cost, and the
   * one-line effect; unavailable upgrades grey out with the reason.
   * Researched upgrades get a checkmark and stay listed.
   */
  private appendResearchPanel(panel: HTMLElement, world: World): void {
    const p = STRINGS.palettes;
    const wrap = el('div', 'research-panel');
    wrap.append(el('div', 'hud-panel-title', loc(p.researchTitle)));
    for (const group of UPGRADE_GROUPS) {
      const groupName = STRINGS.upgradeGroups[group.id];
      wrap.append(el('div', 'research-group', groupName !== undefined ? loc(groupName) : group.id));
      for (const id of group.ids) {
        const st = upgradeAvailability(world, HUMAN_PLAYER_ID, id);
        const row = el('div', `research-row${st.state === 'ready' ? '' : ' locked'}`);
        const head = el('div', 'research-head');
        const nameEl = el('span', 'research-name', upgradeName(id));
        head.append(nameEl);
        if (st.state === 'researched') {
          head.append(el('span', 'research-done', loc(p.researchedTag)));
        }
        head.append(el('span', 'palette-cost', formatResearchCost(id)));
        row.append(head);
        row.append(el('div', 'research-effect', upgradeEffect(id)));
        const btn = document.createElement('button');
        btn.className = 'research-btn';
        btn.textContent = loc(p.researchVerb);
        btn.disabled = st.state !== 'ready';
        btn.title = st.state === 'ready' ? upgradeEffect(id) : st.reason;
        btn.addEventListener('click', () => {
          this.actions.onResearchUpgrade(id);
          // Refresh even while paused: the click's effect (or the loud
          // rejection toast) should be visible immediately.
          this.paletteDirty = true;
        });
        row.append(btn);
        wrap.append(row);
      }
    }
    panel.append(wrap);
  }

  /** Shared tab bar: localized tab names, active tab highlighted. */
  private buildTabBar(
    tabs: readonly { id: string }[],
    names: Record<string, LocalizedString>,
    active: string,
    onSelect: (id: string) => void,
  ): HTMLElement {
    const bar = el('div', 'palette-tabs');
    for (const tab of tabs) {
      const b = document.createElement('button');
      b.className = `palette-tab${tab.id === active ? ' active' : ''}`;
      const entry = names[tab.id];
      b.textContent = entry !== undefined ? loc(entry) : tab.id;
      b.addEventListener('click', () => {
        onSelect(tab.id);
        // Tab switches must repaint even while paused (no tick advance).
        this.paletteDirty = true;
      });
      bar.append(b);
    }
    return bar;
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
