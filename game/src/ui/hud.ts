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
 *  - Selection panel: what is selected + contextual actions (Stop; the
 *    3-tab menu when nothing is selected — workstream Y).
 *  - Main menu tabs (bottom-left, workstream Y): Civilian (zone/network
 *    tools + the civilian build tabs), Military (the tabbed train
 *    palette, unit orders, the military build tabs, superweapons),
 *    Management (taxes, city focus, the mayor/general cabinet, the
 *    research panel).
 *  - Train palette: 5 tabs (spec §8 + Phase 4 S7 transport) for the 35 units; production-gated
 *    units show greyed with the required building named; costs show
 *    funds + materials + manpower.
 *  - Build palette: 11 tabs (spec §8 + the civic tab + Phase 2 utility
 *    tabs + the Phase 3 logistics tab + Phase 4 S7 transport) for the
 *    67 buildings, split
 *    across the Civilian and Military main tabs; unaffordable buildings
 *    grey out; navalYard's coast rule is surfaced in its tooltip.
 *  - Research panel: at a completed Research Lab (or in the Management
 *    tab when the player owns one), the 21 upgrades with funds +
 *    research cost, prerequisites and one-line effect; unavailable
 *    upgrades grey out with reasons.
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
import {
  ROAD_CLASS_ORDER,
  ROAD_CLASS_STATS,
  buildingOccupancy,
  type RoadClass,
} from '../sim/city';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { type BuildingKind } from '../sim/city';
import type { TerrainData } from '../sim/terrain';
import { getDesirabilityModel } from '../sim/desirability';
import { landValueLine } from './desirability';
import { AGE_PROGRESSION } from '../sim/ages';
import type { UpgradeId } from '../sim/upgrades';
import type { Selection } from './selection';
import type { AdvisorItem } from './advisor';
import { STRINGS, loc, fillLoc, type LocalizedString } from './strings';
import { vetXpLine } from './veterancy';
// Grand-expansion Phase 5 (S5): the airport/airline UI contract module.
import {
  AIRLINE_ROUTE_SETUP_COST,
  airlineRouteIncomeOf,
  airlineRoutesOf,
  isAirlineEndpoint,
} from './airports';
import {
  TRAIN_TABS,
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
  buildTabsForMenuTab,
  type TrainTabId,
  type BuildTabId,
  type MenuTabId,
} from './palettes';
import {
  unitIcon,
  buildingIcon,
  toolIcon,
  menuIcon,
  viewIcon,
  type PaletteToolIcon,
  type MenuIconKey,
} from './icons';
import { HUMAN_PLAYER_ID } from './session';
import { getMayor, getGeneral } from '../sim/delegation';
import { selectionDigest as paletteDigest } from './paletteDigest';
import {
  allBuildTabs,
  buildingUtilityLine,
  formatUtilityBuildCost,
  isUtilityBuildingKind,
  utilityBuildingAvailability,
  utilityBuildingName,
  utilityBuildTooltip,
  type UtilityBuildTabId,
} from './utilities';
// Phase 3 (logistics): the UI/render contract module (pure, headless-
// safe). The HUD reads fuel/ammo/cargo/stocks/toggles through these
// defensive readers and emits only command structs via HUDActions —
// the sim applies the resupply/toggle commands it validates.
import {
  ammoFracOf,
  cargoLine,
  depotStockLine,
  fuelFracOf,
  isLowSupply,
  isSupplyUnit,
  isTrackedUnit,
  nearestDepot,
  resupplyBlockReason,
  serviceTogglesOf,
} from './logistics';
// Grand-expansion Phase 5 (hangar/carrier shelter, workstream B): the
// embark / base / launch contract — the panel reads the sim through
// this module, never the records directly.
import {
  baseBlockReason,
  canBaseUI,
  canEmbarkUI,
  canLaunchUI,
  embarkBlockReason,
  embarkedAircraft,
  hangarLine,
  nearestCarrier,
  nearestHangarBuilding,
  parkedAircraft,
  shelterLine,
  wingLine,
} from './hangars';
// Grand-expansion Phase 7 (intel, 2026-09-30): the intel UI contract —
// asset counters, spy mission state, warnings, rival airports, and the
// covert-action display lines. The panel reads the sim through this
// module, never the records directly.
import {
  buildingLabel,
  hasIntelBuildings,
  infiltrateLabel,
  intelAssetLines,
  intelChipValues,
  intelWarnings,
  opTargetsOf,
  playerSpies,
  rivalAirportLine,
  rivalAirports,
  sabotageLabel,
  spyDisplayState,
  spyHeader,
  spyMissionLine,
  stealPayoffLine,
  stealPreviewTechId,
  stealTechLabel,
  trainSpyHint,
  warningLine,
} from './intel';
import { SABOTAGE_COST_OPERATIONAL, isSpyUnit } from '../sim/intel';

/** Build-palette tools the HUD can request. */
export type BuildTool =
  | 'road'
  // Phase 2 (utilities): drag-paint network tools.
  | 'powerLine'
  | 'waterPipe'
  // Phase 4 (transport): the rail drag-paint tool (linearNetworkDrag).
  | 'rail'
  | 'zoneR'
  | 'zoneC'
  | 'zoneI'
  // Grand-expansion Phase 5 (S5): the airport zone tool.
  | 'zoneA'
  | `building:${BuildingKind}`
  // Phase 2 (utilities): new sim building kinds arm with the same
  // 'building:<kind>' shape once the sim's BuildingKind union grows.
  | `building:${string}`
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
  /** Phase 2 (utilities): toggle the utility-network overlay. */
  onToggleUtilityOverlay(): void;
  /** Phase 3 (logistics): toggle the logistics overlay. */
  onToggleLogisticsOverlay(): void;
  /** Grand-expansion Phase 5 (S5+S8): toggle the airport overlay. */
  onToggleAirportOverlay(): void;
  /** Workstream W (desirability): toggle the land-value overlay. */
  onToggleDesirabilityOverlay(): void;
  /** Phase 4 RENDER workstream A (item 1): toggle the underground/x-ray view. */
  onToggleXray(): void;
  /** Phase 4 RENDER workstream A (follow-up B): toggle the terrain grid. */
  onToggleGrid(): void;
  /** Phase 3 (logistics): order a unit to resupply at a depot. */
  onResupplyUnit(unitId: number, depotId: number): void;
  /**
   * Phase 5 (hangar/carrier shelter): embark a carrier-capable
   * aircraft onto a carrier's wing. The sim validates (owner,
   * carrierCapable, free wing slot, EMBARK_RANGE).
   */
  onEmbarkAircraft(unitId: number, carrierId: number): void;
  /**
   * Phase 5 (hangar/carrier shelter): park an aircraft in a completed
   * building's hangar. The sim validates (owner, compatible free
   * slot, HANGAR_BASE_RANGE).
   */
  onBaseAircraft(unitId: number, buildingId: number): void;
  /** Phase 5 (hangar/carrier shelter): launch a parked/embarked aircraft. */
  onLaunchAircraft(unitId: number): void;
  /** Grand-expansion Phase 7 (intel): select a unit on the map (intel panel spy list). */
  onSelectUnit(unitId: number): void;
  /**
   * Grand-expansion Phase 7 (intel): order a spy to infiltrate an enemy
   * building. The sim validates (ownership, adjacency, mission state)
   * and rejects loudly in plain English — the controller toasts the
   * reason, the panel never re-checks it.
   */
  onInfiltrateBuilding(spyId: number, buildingId: number): void;
  /**
   * Grand-expansion Phase 7 (intel): order a spy to sabotage an enemy
   * building (25 operational assets; the building goes offline).
   */
  onSabotageBuilding(spyId: number, buildingId: number): void;
  /**
   * Grand-expansion Phase 7 (intel): order an embedded spy to steal
   * tech (15 surveillance assets; the sim picks the tech
   * deterministically — success grants research, failure burns the spy).
   */
  onStealTech(spyId: number, buildingId: number): void;
  /** Phase 3 (logistics): set a supply unit's field services. */
  onSetSupplyToggles(
    unitId: number,
    services: { repair: boolean; rearm: boolean; refuel: boolean },
  ): void;
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
  /** Workstream Y: set one zone's tax rate (Management tab). */
  onSetTaxRate(zone: 0 | 1 | 2 | 3, rate: number): void;
  /** Airlines (Phase 5, S5): arm the two-click airline-route gesture. */
  onAirlineNewRoute(): void;
  /** Airlines (Phase 5, S5): cancel an airline route by its route id. */
  onCancelAirlineRoute(id: number): void;
  /** Roster expansion: research an upgrade (from the research panel). */
  onResearchUpgrade(upgradeId: UpgradeId): void;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Phase 3 (logistics): a labeled horizontal bar (fuel / ammo in the
 * selection panel). The label names the value (accessibility), the fill
 * width shows the fraction. Pure DOM — the fraction is quantized in the
 * digest (uf:), never here.
 */
function supplyBar(label: string, frac: number): HTMLElement {
  const wrap = el('div', 'sel-bar');
  const fill = el('div', 'sel-bar-fill');
  fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  const text = el('span', 'sel-bar-label', label);
  wrap.append(fill, text);
  return wrap;
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
  /** Phase 2 (utilities): overlay toggle, flipped write-on-change. */
  private readonly utilOverlayBtn: HTMLButtonElement;
  /** Phase 3 (logistics): overlay toggle — built once, write-on-change. */
  private readonly logisticsOverlayBtn: HTMLButtonElement;
  /**
   * Grand-expansion Phase 5 (S5+S8): airport overlay toggle — built once,
   * write-on-change.
   */
  private readonly airportOverlayBtn: HTMLButtonElement;
  /** Workstream W (desirability): overlay toggle — built once, write-on-change. */
  private readonly desirabilityOverlayBtn: HTMLButtonElement;
  /** Phase 4 RENDER workstream A (item 1): x-ray toggle — built once, write-on-change. */
  private readonly xrayBtn: HTMLButtonElement;
  /** Phase 4 RENDER workstream A (follow-up B): grid toggle — built once, write-on-change. */
  private readonly gridBtn: HTMLButtonElement;
  private readonly advisorPanel: HTMLElement;
  private readonly advisorList: HTMLElement;
  private readonly selectionPanel: HTMLElement;
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;
  private lastText = new Map<string, string>();
  private lastAdvisorKey = '';
  /**
   * Workstream Y (3-tab menu): which main menu tab is active. The build
   * tab is remembered per main tab so flipping between Civilian and
   * Military doesn't lose your place in either palette.
   */
  private menuTab: MenuTabId = 'civilian';
  private civilianBuildTab: BuildTabId | UtilityBuildTabId = 'housing';
  private militaryBuildTab: BuildTabId | UtilityBuildTabId = 'navalAir';
  private get buildTab(): BuildTabId | UtilityBuildTabId {
    return this.menuTab === 'military' ? this.militaryBuildTab : this.civilianBuildTab;
  }
  private set buildTab(id: BuildTabId | UtilityBuildTabId) {
    if (this.menuTab === 'military') this.militaryBuildTab = id;
    else this.civilianBuildTab = id;
  }
  /** Active palette tabs (persist across the per-tick panel rebuilds). */
  private trainTab: TrainTabId = 'infantry';
  /**
   * Phase 4 (transport): the road tool's selected class (dirt/country/
   * paved/highway). Read by the controller (game.ts) when a road drag
   * starts so the emitted buildRoad order carries the class; digest-
   * covered (rc:) so the selector highlights repaint on change.
   */
  selectedRoadClass: RoadClass = 'paved';
  /**
   * Grand-expansion Phase 5 (S5): the airline tool state, controller-
   * owned. `airlineArmed` = the "New route…" two-click gesture is live;
   * `airlineFromId` = the armed first endpoint (null = still picking the
   * first airport). Digest-covered (aa:) so the armed status line
   * repaints on change. The HUD never mutates these — game.ts does.
   */
  airlineArmed = false;
  airlineFromId: number | null = null;
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
      // Grand-expansion Phase 7 (intel): the three asset counters ride
      // the same built-once/write-on-change chip path as the resources
      // (topbar branch noDigestReason — nodes are never rebuilt).
      ['intelSurveillance', s.intelSurveillance],
      ['intelOperational', s.intelOperational],
      ['intelCounterIntel', s.intelCounterIntel],
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

    // Phase 2 (utilities): overlay toggle — network runs, coverage tints
    // and diagnosis markers. Top bar is built once (write-on-change, per
    // the topbar branch's noDigestReason), so the toggle reuses that
    // pattern: it flips its own 'active' class via
    // setUtilityOverlayActive below, never rebuilt per frame.
    this.utilOverlayBtn = document.createElement('button');
    this.utilOverlayBtn.className = 'hud-util';
    this.utilOverlayBtn.title = loc(STRINGS.utilities.overlayLegend);
    this.utilOverlayBtn.innerHTML =
      toolIcon('powerLine') + toolIcon('waterPipe');
    this.utilOverlayBtn.append(document.createTextNode(loc(STRINGS.utilities.overlayToggle)));
    this.utilOverlayBtn.addEventListener('click', () => actions.onToggleUtilityOverlay());
    this.topbar.append(this.utilOverlayBtn);

    // Phase 3 (logistics): overlay toggle — reload-point coverage discs
    // and low-supply markers. Same built-once/write-on-change pattern as
    // the utilities toggle (topbar branch's noDigestReason invariant).
    this.logisticsOverlayBtn = document.createElement('button');
    this.logisticsOverlayBtn.className = 'hud-logistics';
    this.logisticsOverlayBtn.title = loc(STRINGS.logistics.overlayLegend);
    this.logisticsOverlayBtn.innerHTML = unitIcon('supplyTruck');
    this.logisticsOverlayBtn.append(
      document.createTextNode(loc(STRINGS.logistics.overlayToggle)),
    );
    this.logisticsOverlayBtn.addEventListener('click', () =>
      actions.onToggleLogisticsOverlay(),
    );
    this.topbar.append(this.logisticsOverlayBtn);

    // Grand-expansion Phase 5 (S5+S8): overlay toggle — airport-site
    // rings and airline-route arcs. Same built-once / write-on-change
    // pattern as the utilities/logistics toggles (the topbar branch's
    // noDigestReason invariant).
    this.airportOverlayBtn = document.createElement('button');
    this.airportOverlayBtn.className = 'hud-airport';
    this.airportOverlayBtn.title = loc(STRINGS.airportsOverlay.overlayLegend);
    this.airportOverlayBtn.innerHTML = buildingIcon('civilAirport');
    this.airportOverlayBtn.append(
      document.createTextNode(loc(STRINGS.airportsOverlay.overlayToggle)),
    );
    this.airportOverlayBtn.addEventListener('click', () =>
      actions.onToggleAirportOverlay(),
    );
    this.topbar.append(this.airportOverlayBtn);

    // Workstream W (desirability): overlay toggle — the residential
    // land-value tint (red low → green prime). Same built-once /
    // write-on-change pattern as the utilities/logistics toggles (the
    // topbar branch's noDigestReason invariant).
    this.desirabilityOverlayBtn = document.createElement('button');
    this.desirabilityOverlayBtn.className = 'hud-desirability';
    this.desirabilityOverlayBtn.title = loc(STRINGS.desirability.overlayLegend);
    this.desirabilityOverlayBtn.innerHTML = buildingIcon('park');
    this.desirabilityOverlayBtn.append(
      document.createTextNode(loc(STRINGS.desirability.overlayToggle)),
    );
    this.desirabilityOverlayBtn.addEventListener('click', () =>
      actions.onToggleDesirabilityOverlay(),
    );
    this.topbar.append(this.desirabilityOverlayBtn);

    // Phase 4 RENDER workstream A (item 1): x-ray toggle — ghost the
    // terrain so buried water pipes read (bright blue, no depth test).
    // Same built-once / write-on-change pattern as the other overlay
    // toggles (the topbar branch's noDigestReason invariant).
    this.xrayBtn = document.createElement('button');
    this.xrayBtn.className = 'hud-xray';
    this.xrayBtn.title = loc(STRINGS.xray.overlayLegend);
    this.xrayBtn.innerHTML = toolIcon('waterPipe');
    this.xrayBtn.append(document.createTextNode(loc(STRINGS.xray.overlayToggle)));
    this.xrayBtn.addEventListener('click', () => actions.onToggleXray());
    this.topbar.append(this.xrayBtn);

    // Phase 4 RENDER workstream A (follow-up B): terrain-grid toggle —
    // a subtle draped survey grid, hidden by default (G key works too).
    // Same built-once / write-on-change pattern as the other view
    // toggles (the topbar branch's noDigestReason invariant).
    this.gridBtn = document.createElement('button');
    this.gridBtn.className = 'hud-grid';
    this.gridBtn.title = loc(STRINGS.grid.legend);
    this.gridBtn.innerHTML = viewIcon('grid');
    this.gridBtn.append(document.createTextNode(loc(STRINGS.grid.toggle)));
    this.gridBtn.addEventListener('click', () => actions.onToggleGrid());
    this.topbar.append(this.gridBtn);

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

  /**
   * Workstream Y (3-tab menu): the main tab bar at the top of the
   * selection panel — Civilian / Military / Management, icon AND text
   * (user directive 2026-09-30). Registered in HUD_PANEL_BRANCHES as
   * 'menu-tabs' (digest label mt:).
   */
  private buildMenuTabBar(): HTMLElement {
    const bar = el('div', 'menu-tabs');
    const tabs: Array<{ id: MenuTabId; icon: MenuIconKey }> = [
      { id: 'civilian', icon: 'tabCivilian' },
      { id: 'military', icon: 'tabMilitary' },
      { id: 'management', icon: 'tabManagement' },
    ];
    for (const { id, icon } of tabs) {
      const b = document.createElement('button');
      b.className = `menu-tab${this.menuTab === id ? ' active' : ''}`;
      b.prepend(iconSpan(menuIcon(icon)));
      b.append(el('span', 'palette-label', loc(STRINGS.menuTabs[id])));
      b.setAttribute('aria-pressed', this.menuTab === id ? 'true' : 'false');
      b.addEventListener('click', () => {
        this.menuTab = id;
        // Tab switches must repaint even while paused (no tick advance).
        this.paletteDirty = true;
      });
      bar.append(b);
    }
    return bar;
  }

  /**
   * One labeled section inside the Military/Management panels
   * (panel-section/panel-row/panel-btn classes, claimed by the
   * military-panel / management-panel digest branches).
   */
  private makeSection(title: string): HTMLElement {
    const sec = el('div', 'panel-section');
    sec.append(el('div', 'panel-section-title', title));
    return sec;
  }

  /** A small labeled button for the Military/Management panels. */
  private makePanelButton(
    label: string,
    title: string,
    onClick: () => void,
    opts: { active?: boolean; disabled?: boolean } = {},
  ): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = `panel-btn${opts.active === true ? ' active' : ''}`;
    b.textContent = label;
    b.title = title;
    if (opts.disabled === true) b.disabled = true;
    b.addEventListener('click', onClick);
    return b;
  }

  /**
   * Civilian main tab: the build tools row (road / power line / water
   * pipe / zone R-C-I / demolish) plus the civilian build tabs. The
   * tools live here because they are civilian infrastructure tools.
   */
  private appendCivilianPanel(panel: HTMLElement, world: World): void {
    const p = STRINGS.palettes;
    const toolsRow = el('div', 'palette-tools');
    const makeToolButton = (
      tool: BuildTool,
      label: string,
      icon: PaletteToolIcon,
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      b.className = 'build-btn';
      b.prepend(iconSpan(toolIcon(icon)));
      b.append(el('span', 'palette-label', label));
      b.addEventListener('click', () => this.actions.onBuildTool(tool));
      return b;
    };
    toolsRow.append(makeToolButton('road', loc(p.toolRoad), 'road'));
    // Phase 4 (transport): the road tool paints the selected class — the
    // small class picker sits next to the road button (dirt/country/
    // paved/highway, per-cell cost in the title). Dragging over existing
    // lower-class roads upgrades them in place (difference pricing via
    // the sim's upgradeRoad). Registered in HUD_PANEL_BRANCHES as
    // 'tools-row' (digestLabels: rc:).
    const classRow = el('div', 'palette-class-row');
    const classNames: Record<RoadClass, LocalizedString> = {
      dirt: p.roadClassDirt,
      country: p.roadClassCountry,
      paved: p.roadClassPaved,
      highway: p.roadClassHighway,
    };
    for (const cls of ROAD_CLASS_ORDER) {
      const stats = ROAD_CLASS_STATS[cls];
      const cb = document.createElement('button');
      cb.className = `class-btn${this.selectedRoadClass === cls ? ' active' : ''}`;
      cb.textContent = loc(classNames[cls]);
      cb.title = fillLoc(p.roadClassCost, {
        funds: stats.costFunds,
        materials: stats.costMaterials,
      });
      cb.setAttribute('aria-pressed', this.selectedRoadClass === cls ? 'true' : 'false');
      cb.addEventListener('click', () => {
        this.selectedRoadClass = cls;
        this.paletteDirty = true;
      });
      classRow.append(cb);
    }
    toolsRow.append(classRow);
    // Phase 2 (utilities): the drag-paint network tools sit together in a
    // "Networks" group, next to the road tool they share a gesture with.
    // Phase 4 (transport): the rail tool joins them.
    const netGroup = el('div', 'palette-zones');
    netGroup.append(el('div', 'palette-section-title', loc(p.toolSectionNetworks)));
    const netTools = [
      { tool: 'powerLine', label: loc(p.toolPowerLine), icon: 'powerLine' },
      { tool: 'waterPipe', label: loc(p.toolWaterPipe), icon: 'waterPipe' },
      { tool: 'rail', label: loc(p.toolRail), icon: 'rail' },
    ] as const;
    for (const { tool, label, icon } of netTools) {
      netGroup.append(makeToolButton(tool, label, icon));
    }
    toolsRow.append(netGroup);
    // Workstream Z: the three zone tools are grouped under a small
    // "Zoning" section header so their purpose is obvious at a glance.
    const zoneGroup = el('div', 'palette-zones');
    zoneGroup.append(el('div', 'palette-section-title', loc(p.toolSectionZoning)));
    const zoneTools = [
      { tool: 'zoneR', label: loc(p.toolZoneR), icon: 'zoneR' },
      { tool: 'zoneC', label: loc(p.toolZoneC), icon: 'zoneC' },
      { tool: 'zoneI', label: loc(p.toolZoneI), icon: 'zoneI' },
      // Grand-expansion Phase 5 (S5): the airport zone tool rides the
      // same drag pipeline as the other zones.
      { tool: 'zoneA', label: loc(p.toolZoneA), icon: 'zoneA' },
    ] as const;
    for (const { tool, label, icon } of zoneTools) {
      zoneGroup.append(makeToolButton(tool, label, icon));
    }
    toolsRow.append(zoneGroup);
    toolsRow.append(makeToolButton('demolish', loc(p.toolDemolish), 'demolish'));
    panel.append(toolsRow);
    const tabs = buildTabsForMenuTab(allBuildTabs(), 'civilian');
    this.appendBuildPanel(panel, world, tabs);
    // Grand-expansion Phase 5 (S5): the airline panel — the player's
    // routes plus the two-click "New route…" gesture. Registered in
    // HUD_PANEL_BRANCHES as 'airline-panel' (digestLabels: al:, aa:).
    panel.append(this.airlinePanelEl(world));
  }

  /**
   * Civilian → Airlines (Phase 5, S5). Lists each of the player's airline
   * routes (endpoint names + the exact income the sim pays, from
   * ui/airports.ts) with a cancel button, and the "New route…" button
   * that arms the controller's two-click gesture. While armed, a status
   * line says what the next click must hit — nothing fails silently.
   */
  private airlinePanelEl(world: World): HTMLElement {
    const m = STRINGS.menuTabs;
    const sec = this.makeSection(loc(m.airlineTitle));
    const routes = airlineRoutesOf(world, HUMAN_PLAYER_ID);
    const byId = new Map<number, string>();
    for (const b of world.city.buildings) byId.set(b.id, buildingName(b.kind));
    if (routes.length === 0) {
      sec.append(el('div', 'panel-status', loc(m.airlineEmpty)));
    }
    for (const r of routes) {
      const row = el('div', 'panel-row');
      const income = airlineRouteIncomeOf(world, r).toFixed(1);
      row.append(
        el(
          'span',
          'panel-label',
          `${byId.get(r.from) ?? '—'} ↔ ${byId.get(r.to) ?? '—'} · +${income} funds/s`,
        ),
      );
      row.append(
        this.makePanelButton(
          loc(m.cancelAirlineRoute),
          `Cancel airline route ${r.id}`,
          () => this.actions.onCancelAirlineRoute(r.id),
        ),
      );
      sec.append(row);
    }
    if (this.airlineArmed) {
      sec.append(
        el(
          'div',
          'panel-status',
          this.airlineFromId === null
            ? loc(m.airlinePickFirst)
            : loc(m.airlineRouteArmed),
        ),
      );
    }
    const endpoints = world.city.buildings.filter(
      (b) => b.owner === HUMAN_PLAYER_ID && isAirlineEndpoint(b),
    );
    sec.append(
      this.makePanelButton(
        loc(m.newAirlineRoute),
        endpoints.length >= 2
          ? `New airline route (${AIRLINE_ROUTE_SETUP_COST} funds setup)`
          : loc(m.airlineNeedsTwo),
        () => this.actions.onAirlineNewRoute(),
        { disabled: endpoints.length < 2, active: this.airlineArmed },
      ),
    );
    return sec;
  }

  /**
   * Military main tab: unit orders help, the tabbed train palette, the
   * military build tabs, and the superweapons (moved here from the old
   * Phase 3 "Command" panel — nothing lost, just rehomed).
   */
  private appendMilitaryPanel(panel: HTMLElement, world: World): void {
    const m = STRINGS.menuTabs;
    // Unit orders: the existing commands. Attack/move are right-click
    // map gestures (game.ts issueContextOrder); Stop is the selection
    // panel button / the S key. No per-unit "defend" command exists in
    // the sim — the orders block says what the game actually has.
    const orders = this.makeSection(loc(m.ordersTitle));
    const orderRow = el('div', 'panel-row');
    orderRow.append(el('div', 'order-hint', `⚔ ${loc(m.attackHint)}`));
    orderRow.append(el('div', 'order-hint', `➤ ${loc(m.moveHint)}`));
    orderRow.append(el('div', 'order-hint', `■ ${loc(m.stopHint)}`));
    orders.append(orderRow);
    panel.append(orders);

    this.appendTrainPanel(panel, world);
    const tabs = buildTabsForMenuTab(allBuildTabs(), 'military');
    this.appendBuildPanel(panel, world, tabs);

    const sw = this.makeSection(loc(m.superTitle));
    const swRow = el('div', 'panel-row');
    swRow.append(
      this.makePanelButton(loc(m.fireAegis), loc(m.aegisTitle), () =>
        this.actions.onFireAegis(),
      ),
    );
    swRow.append(
      this.makePanelButton(loc(m.stormTarget), loc(m.stormTitle), () =>
        this.actions.onStormTarget(),
      ),
    );
    sw.append(swRow);
    panel.append(sw);
  }

  /**
   * Management main tab: taxes, city focus, the mayor/general cabinet,
   * and the research panel (when the player owns a completed lab). The
   * old Phase 3 "Command" panel's specialization/mayor/general controls
   * live here now; taxes are new UI over the existing setTaxRate command
   * (orders.ts already had the HUD-tax builder waiting for a home).
   */
  private appendManagementPanel(panel: HTMLElement, world: World): void {
    const m = STRINGS.menuTabs;
    panel.append(this.taxSectionEl(world));
    panel.append(this.focusSectionEl(world));
    panel.append(this.cabinetSectionEl(world));
    // Grand-expansion Phase 7 (intel): the intel panel — asset
    // counters, spies + covert actions, warnings, rival airports.
    panel.append(this.intelSectionEl(world));
    if (playerHasCompletedLab(world, HUMAN_PLAYER_ID)) {
      this.appendResearchPanel(panel, world);
    }
  }

  /**
   * Management → Intelligence: the intel panel (grand-expansion Phase
   * 7). Asset counters + accrual rates, the spies (mission state,
   * timers, covert-action buttons), active warnings with countdowns,
   * and the rival airports (discovered/undiscovered).
   *
   * Named *El (not append/build/update-prefixed) per the ui/AGENTS.md
   * AD11 rule — it is covered by the management-panel digest branch,
   * not a branch of its own. All DOM classes are the shared panel
   * classes that branch already claims; every rendered value is
   * digested by the ia:/ir:/is:/iw:/ig: segments.
   *
   * The panel never validates: every covert-action button fires its
   * order and the sim rejects loudly in plain English (game.ts toasts
   * the reason) — no dead buttons, no silent no-ops.
   */
  private intelSectionEl(world: World): HTMLElement {
    const s = STRINGS.intel;
    const sec = this.makeSection(loc(s.panelTitle));

    // Asset counters + accrual rates.
    for (const line of intelAssetLines(world, HUMAN_PLAYER_ID)) {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', line));
      sec.append(row);
    }
    if (!hasIntelBuildings(world, HUMAN_PLAYER_ID)) {
      sec.append(el('div', 'panel-status', loc(s.noIntelBuildings)));
    }

    // Spies + covert actions.
    {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', loc(s.spiesTitle)));
      sec.append(row);
    }
    const spies = playerSpies(world, HUMAN_PLAYER_ID);
    if (spies.length === 0) {
      sec.append(el('div', 'panel-status', loc(s.noSpies)));
    }
    for (const spy of spies) {
      const row = el('div', 'panel-row');
      row.append(
        el('span', 'panel-label', `${spyHeader(spy)} — ${spyMissionLine(world, spy)}`),
      );
      row.append(
        this.makePanelButton(loc(s.selectSpy), loc(s.selectSpyTitle), () =>
          this.actions.onSelectUnit(spy.id),
        ),
      );
      sec.append(row);
      // Covert actions against enemy buildings in reach.
      const targets = opTargetsOf(world, spy);
      if (targets.length === 0) {
        sec.append(el('div', 'panel-status', loc(s.noTargets)));
      }
      for (const target of targets) {
        const trow = el('div', 'panel-row');
        trow.append(el('span', 'panel-label', buildingLabel(target)));
        trow.append(
          this.makePanelButton(loc(s.infiltrateVerb), loc(s.infiltrateTitle), () =>
            this.actions.onInfiltrateBuilding(spy.id, target.id),
          ),
        );
        trow.append(
          this.makePanelButton(
            sabotageLabel(),
            fillLoc(s.sabotageTitle, { cost: SABOTAGE_COST_OPERATIONAL }),
            () => this.actions.onSabotageBuilding(spy.id, target.id),
          ),
        );
        sec.append(trow);
      }
      // Tech steal: offered when the spy is embedded in an enemy
      // building (the sim's stealTech requires the embedding — the
      // "Embedded … ready to steal tech" line says so).
      const state = spyDisplayState(world, spy);
      if (state.kind === 'embedded') {
        const victimOwner = world.city.buildings.find(
          (b) => b.id === state.targetId,
        )?.owner;
        const techId =
          victimOwner === undefined
            ? null
            : stealPreviewTechId(world, HUMAN_PLAYER_ID, victimOwner);
        const srow = el('div', 'panel-row');
        srow.append(
          el(
            'span',
            'panel-label',
            techId !== null
              ? fillLoc(s.stealPreview, { tech: upgradeName(techId as UpgradeId) })
              : loc(s.stealNothingLeft),
          ),
        );
        srow.append(
          this.makePanelButton(
            stealTechLabel(),
            `${loc(s.stealTechTitle)} ${stealPayoffLine()}`,
            () => this.actions.onStealTech(spy.id, state.targetId),
          ),
        );
        sec.append(srow);
      }
    }
    sec.append(
      el('div', 'panel-status', `${loc(s.actionsHint)} ${stealPayoffLine()}`),
    );
    sec.append(el('div', 'panel-status', trainSpyHint()));

    // Active warnings (no gotcha UX: countdown + what happens next).
    {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', loc(s.warningsTitle)));
      sec.append(row);
    }
    const warnings = intelWarnings(world, HUMAN_PLAYER_ID);
    if (warnings.length === 0) {
      sec.append(el('div', 'panel-status', loc(s.noWarnings)));
    }
    for (const w of warnings) {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', warningLine(w)));
      sec.append(row);
    }

    // Rival airports (discovered / undiscovered).
    {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', loc(s.airportsTitle)));
      sec.append(row);
    }
    const airports = rivalAirports(world, HUMAN_PLAYER_ID);
    if (airports.length === 0) {
      sec.append(el('div', 'panel-status', loc(s.noAirports)));
    }
    for (const a of airports) {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', rivalAirportLine(a)));
      sec.append(row);
    }
    return sec;
  }

  /** Management → Taxes: per-zone rate steppers over setTaxRate. */
  private taxSectionEl(world: World): HTMLElement {
    const m = STRINGS.menuTabs;
    const sec = this.makeSection(loc(m.taxesTitle));
    const player = getPlayer(world.city, HUMAN_PLAYER_ID);
    const mayor = getMayor(world, HUMAN_PLAYER_ID);
    const rates: [number, number, number, number] = [
      player?.taxRates[0] ?? 0,
      player?.taxRates[1] ?? 0,
      player?.taxRates[2] ?? 0,
      // Grand-expansion Phase 5 (S5): the airport-zone tax rate.
      player?.taxRates[3] ?? 0,
    ];
    if (mayor !== undefined) {
      // A mayor resets the rates to its policy every economy tick, so
      // manual steppers would be futile — say so instead of a dead UI.
      sec.append(
        el(
          'div',
          'panel-status',
          fillLoc(m.mayorSetsRates, { policy: mayor.policy }),
        ),
      );
    }
    for (const zone of [0, 1, 2, 3] as const) {
      const row = el('div', 'panel-row');
      const nameEntry = m.taxZoneNames[zone];
      row.append(el('span', 'panel-label', nameEntry !== undefined ? loc(nameEntry) : `zone ${zone}`));
      const rate = el('span', 'tax-rate', `${Math.round(rates[zone] * 100)}%`);
      const minus = this.makePanelButton(
        '−',
        `Lower the ${nameEntry !== undefined ? loc(nameEntry) : zone} tax rate`,
        () => this.actions.onSetTaxRate(zone, Math.max(0, rates[zone] - 0.05)),
        { disabled: mayor !== undefined },
      );
      const plus = this.makePanelButton(
        '+',
        `Raise the ${nameEntry !== undefined ? loc(nameEntry) : zone} tax rate`,
        () => this.actions.onSetTaxRate(zone, Math.min(1, rates[zone] + 0.05)),
        { disabled: mayor !== undefined },
      );
      row.append(minus, rate, plus);
      sec.append(row);
    }
    return sec;
  }

  /** Management → City focus: the specialization buttons + current. */
  private focusSectionEl(world: World): HTMLElement {
    const m = STRINGS.menuTabs;
    const sec = this.makeSection(loc(m.focusTitle));
    const row = el('div', 'panel-row');
    const current = getPlayer(world.city, HUMAN_PLAYER_ID)?.specialization ?? 'balanced';
    for (const spec of ['balanced', 'industrial', 'commercial', 'residential']) {
      row.append(
        this.makePanelButton(
          spec,
          spec === current ? `Current focus: ${spec}` : `Set city focus to ${spec}`,
          () => this.actions.onSetSpecialization(spec),
          { active: spec === current },
        ),
      );
    }
    sec.append(row);
    return sec;
  }

  /**
   * Management → Cabinet: the existing chain-of-command status
   * (sim/delegation.ts) — the mayor and the general the player
   * appointed, with their policies/stance — plus the same
   * appoint/dismiss controls the old Command panel had. No new
   * minigame: this surfaces existing sim state.
   */
  private cabinetSectionEl(world: World): HTMLElement {
    const m = STRINGS.menuTabs;
    const sec = this.makeSection(loc(m.cabinetTitle));

    // Mayor.
    const mayor = getMayor(world, HUMAN_PLAYER_ID);
    const mayorRow = el('div', 'panel-row');
    mayorRow.append(
      el(
        'div',
        'panel-status',
        mayor !== undefined
          ? `Mayor · ${mayor.policy} · builds ${mayor.buildPolicy}`
          : loc(m.noMayor),
      ),
    );
    sec.append(mayorRow);
    const mayorBtns = el('div', 'panel-row');
    for (const policy of ['balanced', 'growth', 'revenue']) {
      mayorBtns.append(
        this.makePanelButton(
          policy,
          `Appoint a mayor with the ${policy} tax policy`,
          () => this.actions.onAssignMayor(policy),
          { active: mayor?.policy === policy },
        ),
      );
    }
    if (mayor !== undefined) {
      mayorBtns.append(
        this.makePanelButton(loc(m.dismissVerb), 'Dismiss the mayor', () =>
          this.actions.onDismissMayor(),
        ),
      );
    }
    sec.append(mayorBtns);
    // Mayor build policy (what the mayor auto-builds).
    const buildRow = el('div', 'panel-row');
    buildRow.append(el('span', 'panel-label', loc(m.mayorBuildsLabel)));
    for (const bp of ['housing', 'industry', 'balanced']) {
      buildRow.append(
        this.makePanelButton(
          bp,
          `The mayor auto-builds: ${bp}`,
          () => this.actions.onSetMayorBuildPolicy(bp),
          { active: mayor?.buildPolicy === bp, disabled: mayor === undefined },
        ),
      );
    }
    sec.append(buildRow);

    // General.
    const general = getGeneral(world, HUMAN_PLAYER_ID);
    const genRow = el('div', 'panel-row');
    genRow.append(
      el(
        'div',
        'panel-status',
        general !== undefined
          ? `General · ${general.stance} · ${general.unitIds.length} units`
          : loc(m.noGeneral),
      ),
    );
    sec.append(genRow);
    const genBtns = el('div', 'panel-row');
    for (const stance of ['aggressive', 'defensive', 'hold']) {
      genBtns.append(
        this.makePanelButton(
          stance,
          general !== undefined
            ? `Set the general's stance to ${stance}`
            : `Appoint a general over the selected units (${stance})`,
          () =>
            general !== undefined
              ? this.actions.onSetGeneralStance(stance)
              : this.actions.onAssignGeneral(stance),
          { active: general?.stance === stance },
        ),
      );
    }
    if (general !== undefined) {
      genBtns.append(
        this.makePanelButton(loc(m.dismissVerb), 'Dismiss the general', () =>
          this.actions.onDismissGeneral(),
        ),
      );
    }
    sec.append(genBtns);

    return sec;
  }

  /** Refresh all panels from the world. Cheap: DOM writes only on change. */
  update(
    world: World,
    selection: Selection,
    advisor: AdvisorItem[],
    paused: boolean,
    speed: number,
    // Workstream W (desirability): the terrain the derived model needs.
    // Optional — without it the land-value line shows nothing (pre-sim /
    // headless), and the digest carries the constant 'bv:x' segment.
    terrain?: TerrainData,
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
      // Grand-expansion Phase 7 (intel): the asset counters, same
      // write-on-change path as the resources (floored like fmt).
      const [surv, ops, ci] = intelChipValues(world, HUMAN_PLAYER_ID);
      this.setText('intelSurveillance', surv, this.resEls.get('intelSurveillance'));
      this.setText('intelOperational', ops, this.resEls.get('intelOperational'));
      this.setText('intelCounterIntel', ci, this.resEls.get('intelCounterIntel'));
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
    this.updateSelection(world, selection, terrain);
  }

  /**
   * Phase 2 (utilities): flip the overlay toggle's active state
   * (write-on-change — the button is never rebuilt).
   */
  setUtilityOverlayActive(active: boolean): void {
    this.utilOverlayBtn.classList.toggle('active', active);
  }

  /**
   * Phase 3 (logistics): flip the overlay toggle's active state
   * (write-on-change — the button is never rebuilt).
   */
  setLogisticsOverlayActive(active: boolean): void {
    this.logisticsOverlayBtn.classList.toggle('active', active);
  }

  /**
   * Grand-expansion Phase 5 (S5+S8): flip the airport overlay toggle's
   * active state (write-on-change — the button is never rebuilt).
   */
  setAirportOverlayActive(active: boolean): void {
    this.airportOverlayBtn.classList.toggle('active', active);
  }

  /**
   * Workstream W (desirability): flip the overlay toggle's active state
   * (write-on-change — the button is never rebuilt).
   */
  setDesirabilityOverlayActive(active: boolean): void {
    this.desirabilityOverlayBtn.classList.toggle('active', active);
  }

  /**
   * Phase 4 RENDER workstream A (item 1): flip the x-ray toggle's active
   * state (write-on-change — the button is never rebuilt).
   */
  setXrayActive(active: boolean): void {
    this.xrayBtn.classList.toggle('active', active);
  }

  /**
   * Phase 4 RENDER workstream A (follow-up B): flip the grid toggle's
   * active state (write-on-change — the button is never rebuilt).
   */
  setGridActive(active: boolean): void {
    this.gridBtn.classList.toggle('active', active);
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
  private selectionDigest(world: World, selection: Selection, terrain?: TerrainData): string {
    return paletteDigest(
      world,
      selection,
      this.trainTab,
      this.buildTab,
      terrain,
      this.menuTab,
      // Phase 4 (transport): the road-class picker highlight is a rendered
      // value, so the rebuild key covers it (paletteDirty also forces a
      // rebuild, but the digest is the key — the 2026-09-30 click bug
      // rule).
      this.selectedRoadClass,
      // Grand-expansion Phase 5 (S5): the airline panel's armed status
      // line is rendered content — undefined when the tool is disarmed.
      this.airlineArmed ? this.airlineFromId : undefined,
    );
  }

  private updateSelection(world: World, selection: Selection, terrain?: TerrainData): void {
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
    const key = this.selectionDigest(world, selection, terrain);
    const dirty = this.paletteDirty;
    this.paletteDirty = false;
    if (!dirty && panel.dataset['key'] === key) {
      return;
    }
    panel.dataset['key'] = key;
    panel.textContent = '';

    // Workstream Y (3-tab menu): the main tab bar heads the panel in
    // every state; the content below is the active tab when nothing is
    // selected, or the contextual unit/building branch when something is.
    panel.append(this.buildMenuTabBar());

    if (selection.unitIds.length === 0 && selection.buildingId === null) {
      panel.append(el('div', 'sel-empty', sel.noSelection));
      if (this.menuTab === 'civilian') {
        this.appendCivilianPanel(panel, world);
      } else if (this.menuTab === 'military') {
        this.appendMilitaryPanel(panel, world);
      } else {
        this.appendManagementPanel(panel, world);
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
        // Veterancy (Phase 1): rank + chevrons + XP progress, e.g.
        // "Veteran ▲▲ · 320/500 XP". Reuses the 'sel-unit' class — no new
        // DOM class, no digest-registry change needed for markup.
        panel.append(el('div', 'sel-unit', vetXpLine(u)));
        // Grand-expansion Phase 7 (intel): a selected owned spy shows
        // its mission state ("Infiltrating Power Plant · 12s left",
        // "Exposed — visible to all enemies · 24s left"). Reuses the
        // 'sel-unit' class — no new DOM class; the iu: digest segment
        // covers the rendered value (AD11).
        if (u.owner === HUMAN_PLAYER_ID && isSpyUnit(u)) {
          panel.append(el('div', 'sel-unit', spyMissionLine(world, u)));
        }
        // Phase 3 (logistics): fuel/ammo bars for tracked units, the
        // cargo line + field-service toggles for supply units, and the
        // Resupply button. New DOM classes ('sel-bar', 'sel-bar-fill',
        // 'sel-toggle') are registered in HUD_PANEL_BRANCHES and every
        // value digested by the uf:/us: segments (AD11) — the panel
        // rebuilds exactly when a bar or toggle would render
        // differently.
        if (def !== undefined && isTrackedUnit(def)) {
          const lg = STRINGS.logistics;
          panel.append(supplyBar(`${loc(lg.fuelLabel)} ${Math.round(fuelFracOf(def, u) * 100)}%`, fuelFracOf(def, u)));
          panel.append(supplyBar(`${loc(lg.ammoLabel)} ${Math.round(ammoFracOf(def, u) * 100)}%`, ammoFracOf(def, u)));
          if (isLowSupply(def, u)) {
            panel.append(el('div', 'sel-unit', `⚠ ${loc(lg.lowSupplyWarning)}`));
          }
        }
        if (def !== undefined && isSupplyUnit(def) && u.owner === HUMAN_PLAYER_ID) {
          const lg = STRINGS.logistics;
          panel.append(el('div', 'sel-unit', cargoLine(u)));
          const svc = serviceTogglesOf(u);
          const toggleRow = el('div', 'sel-toggle-row');
          const toggles = [
            { key: 'repair' as const, label: loc(lg.repairToggle) },
            { key: 'rearm' as const, label: loc(lg.rearmToggle) },
            { key: 'refuel' as const, label: loc(lg.refuelToggle) },
          ];
          for (const t of toggles) {
            const b = document.createElement('button');
            b.className = `sel-toggle${svc[t.key] ? ' active' : ''}`;
            b.textContent = t.label;
            b.setAttribute('aria-pressed', svc[t.key] ? 'true' : 'false');
            b.addEventListener('click', () => {
              const next = { ...svc, [t.key]: !svc[t.key] };
              this.actions.onSetSupplyToggles(u.id, next);
            });
            toggleRow.append(b);
          }
          panel.append(toggleRow);
          // Resupply: the UI proposes the depot (nearest with available
          // stock); the sim validates and rejects loudly when nothing can
          // serve the unit. The disabled reason names the blocker — never
          // a dead button, never a silent no-op.
          const depot = nearestDepot(world, u);
          const block = resupplyBlockReason(world, u, depot);
          const rs = document.createElement('button');
          rs.className = 'sel-action';
          rs.textContent = loc(lg.resupplyVerb);
          if (block === null && depot !== null) {
            rs.addEventListener('click', () => this.actions.onResupplyUnit(u.id, depot.id));
          } else {
            rs.disabled = true;
            rs.title = block ?? loc(lg.noDepotReason);
          }
          panel.append(rs);
        }
        // Grand-expansion Phase 5 (hangar/carrier shelter): the shelter
        // line + Embark / Park / Launch buttons for aircraft, and the
        // wing manifest for carriers. Sheltered aircraft are invisible on
        // the map (render skips them), so the carrier/hangar panels list
        // their sheltered aircraft with Launch buttons — otherwise a
        // parked aircraft could never be launched from the UI. Every
        // value is digest-covered by the ue: / ew: segments (AD11).
        if (u.owner === HUMAN_PLAYER_ID) {
          const sheltered = shelterLine(world, u);
          if (sheltered !== '') {
            panel.append(el('div', 'sel-unit', sheltered));
            const launch = document.createElement('button');
            launch.className = 'sel-action';
            launch.textContent = loc(sel.launchVerb);
            launch.addEventListener('click', () => this.actions.onLaunchAircraft(u.id));
            panel.append(launch);
          } else if (canEmbarkUI(u)) {
            // Embark: the UI proposes the nearest friendly carrier in
            // range; the sim validates. Disabled with the reason named —
            // never a dead button.
            const carrier = nearestCarrier(world, u);
            const eblock =
              carrier !== null ? embarkBlockReason(world, u, carrier) : 'No carrier in range';
            const eb = document.createElement('button');
            eb.className = 'sel-action';
            eb.textContent = loc(sel.embarkVerb);
            if (eblock === null && carrier !== null) {
              eb.addEventListener('click', () =>
                this.actions.onEmbarkAircraft(u.id, carrier.id),
              );
            } else {
              eb.disabled = true;
              eb.title = eblock ?? 'No carrier in range';
            }
            panel.append(eb);
          }
          if (canBaseUI(u)) {
            // Park in hangar: the UI proposes the nearest friendly
            // building with a free compatible slot in range.
            const hangar = nearestHangarBuilding(world, u);
            const bblock =
              hangar !== null ? baseBlockReason(world, u, hangar) : 'No hangar in range';
            const bb = document.createElement('button');
            bb.className = 'sel-action';
            bb.textContent = loc(sel.baseVerb);
            if (bblock === null && hangar !== null) {
              bb.addEventListener('click', () =>
                this.actions.onBaseAircraft(u.id, hangar.id),
              );
            } else {
              bb.disabled = true;
              bb.title = bblock ?? 'No hangar in range';
            }
            panel.append(bb);
          }
          // Carrier wing manifest: carriers train EMPTY (the wing fills
          // only through embark orders), so the panel lists the embarked
          // aircraft with per-aircraft Launch buttons.
          const wing = wingLine(world, u);
          if (wing !== '') {
            panel.append(el('div', 'sel-unit', wing));
            for (const w of embarkedAircraft(world, u.id)) {
              const wdef = UNIT_DEFS[w.kind as UnitKind];
              const row = el('div', 'sel-unit', `✈ ${wdef?.name ?? w.kind}`);
              panel.append(row);
              const wl = document.createElement('button');
              wl.className = 'sel-action';
              wl.textContent = loc(sel.launchVerb);
              wl.addEventListener('click', () => this.actions.onLaunchAircraft(w.id));
              panel.append(wl);
            }
          }
        }
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
      // Crew training level (economy.ts levels thriving buildings 1→3).
      panel.append(el('div', 'sel-unit', fillLoc(sel.levelLine, { level: b.level })));
      // Phase 2 (utilities): power/water diagnosis for the selected
      // building — reuses the 'sel-unit' class so no new DOM class is
      // introduced; digest-covered by the bu: segment.
      panel.append(el('div', 'sel-unit', buildingUtilityLine(b)));
      // Phase 3 (logistics): the depot stock line for storage buildings
      // ("Ammo 42/150 · Fuel 200/250"); empty string (no div) otherwise.
      // Digest-covered by the bq: segment (AD11).
      const stock = depotStockLine(b);
      if (stock !== '') panel.append(el('div', 'sel-unit', stock));
      // Workstream W (desirability): the land-value line for residential
      // buildings ("Land: Nice (64) · tax ×1.3") — reuses the 'sel-unit'
      // class so no new DOM class is introduced; digest-covered by the
      // bv: segment (AD11). The derived model is cached on structural
      // change, so this is free per frame.
      const desirModel =
        terrain !== undefined ? getDesirabilityModel(terrain, world) : undefined;
      const landLine = landValueLine(desirModel, b);
      if (landLine !== null) panel.append(el('div', 'sel-unit', landLine));
      // Phase 4 (transport): the occupancy line ("Residents 12/50 ·
      // Workers 8/20") from the sim's buildingOccupancy() — reuses the
      // 'sel-unit' class so no new DOM class is introduced;
      // digest-covered by the bo: segment (AD11). Hidden for buildings
      // with neither residents nor workers (military/utility).
      const occ = buildingOccupancy(world, b.id);
      if (occ !== null && (occ.residentCap > 0 || occ.workerCap > 0)) {
        panel.append(
          el(
            'div',
            'sel-unit',
            fillLoc(sel.occupancyLine, {
              residents: occ.residents,
              residentCap: occ.residentCap,
              workers: occ.workers,
              workerCap: occ.workerCap,
            }),
          ),
        );
      }
      // Grand-expansion Phase 5 (hangar/carrier shelter): the hangar
      // occupancy line + parked-aircraft manifest with per-aircraft
      // Launch buttons. Parked aircraft are invisible on the map (render
      // skips sheltered units), so this is the only way to launch them.
      // Reuses 'sel-unit' / 'sel-action' — no new DOM class; the bh:
      // segment digests the parked aircraft ids (AD11).
      const hl = hangarLine(b);
      if (hl !== '' && b.owner === HUMAN_PLAYER_ID) {
        panel.append(el('div', 'sel-unit', hl));
        for (const p of parkedAircraft(world, b.id)) {
          const pdef = UNIT_DEFS[p.kind as UnitKind];
          panel.append(el('div', 'sel-unit', `✈ ${pdef?.name ?? p.kind}`));
          const pl = document.createElement('button');
          pl.className = 'sel-action';
          pl.textContent = loc(sel.launchVerb);
          pl.addEventListener('click', () => this.actions.onLaunchAircraft(p.id));
          panel.append(pl);
        }
      }
      // A completed Research Lab opens the research panel (spec §8).
      if (b.kind === 'lab' && b.owner === HUMAN_PLAYER_ID && b.progress >= 1) {
        this.appendResearchPanel(panel, world);
      }
    }
  }

  /** Tabbed train palette: 5 tabs for the 66 units (spec §8 + Phase 4 S7 transport). */
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

  /**
   * Build palette: the tab bar + grid for the given build tabs (the
   * caller picks the Civilian or Military subset — workstream Y), plus
   * the Cancel-placement button. The tools row lives in
   * appendCivilianPanel; the tab state is remembered per main tab.
   */
  private appendBuildPanel(
    panel: HTMLElement,
    world: World,
    tabs: ReadonlyArray<{
      id: BuildTabId | UtilityBuildTabId;
      kinds: readonly string[];
    }>,
  ): void {
    const p = STRINGS.palettes;
    const wrap = el('div', 'build-panel');
    wrap.append(el('div', 'hud-panel-title', loc(p.buildTitle)));
    wrap.append(this.buildTabBar(tabs, STRINGS.buildingTabs, this.buildTab, (id) => {
      this.buildTab = id as BuildTabId | UtilityBuildTabId;
    }));
    const grid = el('div', 'palette-grid');
    const tab = tabs.find((t) => t.id === this.buildTab) ?? tabs[0]!;
    for (const kind of tab.kinds) {
      // Phase 2 (utilities): the new kinds live in ui/utilities.ts until
      // the sim registers them in BUILDING_DEFS — same visible greyed-out
      // rule, honest "not yet available" reason instead of silent failure.
      const isUtility = isUtilityBuildingKind(kind);
      const avail = isUtility
        ? utilityBuildingAvailability(world, HUMAN_PLAYER_ID, kind)
        : buildingAvailability(world, HUMAN_PLAYER_ID, kind as BuildingKind);
      const b = document.createElement('button');
      b.className = `build-btn${avail.ok ? '' : ' locked'}`;
      b.disabled = !avail.ok;
      b.prepend(iconSpan(buildingIcon(kind as BuildingKind)));
      b.append(el('div', 'palette-name', isUtility ? utilityBuildingName(kind) : buildingName(kind as BuildingKind)));
      b.append(
        el('div', 'palette-cost', isUtility ? formatUtilityBuildCost(kind) : formatBuildCost(kind as BuildingKind)),
      );
      const tip = isUtility
        ? utilityBuildTooltip(world, HUMAN_PLAYER_ID, kind)
        : buildTooltip(kind as BuildingKind);
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
   * Research panel: the 21 upgrades in Military/Economy/Infrastructure/
   * Logistics/Intel groups (spec §8). Each row shows the localized name, funds
   * + research cost, and the one-line effect; unavailable upgrades grey
   * out with the reason. Researched upgrades get a checkmark and stay
   * listed. Shown in the Management tab whenever the player owns a
   * completed lab (spec §8), and for a selected completed lab.
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
