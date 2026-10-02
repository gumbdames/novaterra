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
  BUILDING_DEFS,
  buildingOccupancy,
  type BuildingRecord,
  type RoadClass,
} from '../sim/city';
import { UNIT_DEFS, producibleKinds, trainTicksFor, type UnitKind } from '../sim/units';
import { type BuildingKind } from '../sim/city';
import type { TerrainData } from '../sim/terrain';
import { getDesirabilityModel } from '../sim/desirability';
import { landValueLine } from './desirability';
import { AGE_PROGRESSION, getAgeState } from '../sim/ages';
import {
  FLOW_RESOURCES,
  flowRate,
  type FlowResource,
} from '../sim/economy';
import type { UpgradeId } from '../sim/upgrades';
import type { Selection } from './selection';
import type { AdvisorItem } from './advisor';
import { STRINGS, loc, fillLoc, type LocalizedString } from './strings';
import { vetXpLine } from './veterancy';
// Naval-building model (2026-10-01): the drydock-repair read path for
// the unit detail panel's "Under repair" badge (sim/shipyardRepair.ts
// is a leaf — value-imports city/units/veterancy only — so the UI may
// import it; the repair itself stays sim-side).
import { isShipUnderRepair } from '../sim/shipyardRepair';
// Grand-expansion Phase 5 (S5): the airport/airline UI contract module.
import {
  AIRLINE_ROUTE_SETUP_COST,
  airlineRouteIncomeOf,
  airlineRoutesOf,
  isAirlineEndpoint,
} from './airports';
// Civilian sea trade (Half A, 2026-10-01): the sea-trade UI contract
// module.
import {
  SEA_ROUTE_SETUP_COST,
  SEA_ROUTE_POLICIES,
  isSeaTradeHarbor,
  isSeaTradeShip,
  seaRouteIncomeOf,
  seaRouteOfUnit,
  seaRoutesOf,
  seaTradeCargoLine,
  seaTradeShipKinds,
} from './seatrade';
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
  formatFlowRate,
  formatResearchCost,
  formatResearchCostFor,
  upgradeDisplayName,
  trainTooltip,
  trainAtBuildingAvailability,
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
  policyIcon,
  type PaletteToolIcon,
  type MenuIconKey,
} from './icons';
import {
  policyRows,
  policyStatusLine,
  policyUpkeepLine,
} from './policies';
import { HUMAN_PLAYER_ID } from './session';
import { ToastQueue } from './toastQueue';
// Entity portraits (2026-10-01): the atlas consumer contract —
// hasPortrait / portraitStyle for the card thumbnails and the detail
// hero, plus the lazy manifest load (boot-budget-neutral) and the
// idempotent applyPortraits DOM patch.
import {
  applyPortraits,
  ensurePortraitsLoaded,
  CARD_PORTRAIT_BOX_PX,
  SW_CARD_PORTRAIT_BOX_PX,
  DETAIL_HERO_BOX_PX,
  type PortraitStyle,
} from './entityPortraits';
// Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
// the peaceful UI contract (tab visibility, objectives lines).
import { menuTabsForWorld, menuTabColorClass, peacefulStatusLines, peacefulScoreLines, loadPeacefulBest } from './peaceful';
import { getMayor, getGeneral } from '../sim/delegation';
import { selectionDigest as paletteDigest } from './paletteDigest';
// Roadmap B12 (minimap): the tactical overview canvas.
import { Minimap, type MinimapView } from './minimap';
import { VictoryHud } from './victoryHud';
import { EnvoyBanner } from './envoyBanner';
import { envoyBannerView } from './envoy';
import { LuminaryCard } from './luminaryCard';
import { luminaryCardView } from './luminaries';
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
  cargoAmmoOf,
  cargoBlockReason,
  cargoFuelOf,
  cargoMaterialsOf,
  depotStockLine,
  emergencyRefuelBlockReason,
  fuelFracOf,
  isLowSupply,
  isSupplyUnit,
  isTrackedUnit,
  nearestDepot,
  nearestNavalDepot,
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
import {
  ceasefireActive,
  ceasefireTicksLeft,
  DEMAND_TRIBUTE_INFLUENCE_COST,
  CEASEFIRE_INFLUENCE_COST,
} from '../sim/diplomacy';

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
  /**
   * Command-menu rebuild (2026-10-01): the detail view's Back button —
   * returns to the tab menu. Same as Esc / clicking empty ground
   * (game.ts owns the selection).
   */
  onDeselect(): void;
  /** Train panel: enter unit-placement mode for this kind. */
  onTrainUnit(kind: UnitKind): void;
  /**
   * Fun-audit C1 (production queues, 2026-10-02): queue one military
   * unit at a specific production building. The sim validates and
   * rejects loudly (never a dead button).
   */
  onTrainUnitAtBuilding(kind: UnitKind, buildingId: number): void;
  /** Fun-audit C1: cancel one queued unit (full refund). */
  onCancelTrain(buildingId: number, index: number): void;
  /** Fun-audit C1: pause / resume a building's training queue. */
  onSetTrainPaused(buildingId: number, paused: boolean): void;
  /** Fun-audit C1: arm the rally-point tool for a building. */
  onSetRallyTool(buildingId: number): void;
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
  /**
   * Roadmap B12 (minimap): jump the camera target to a world-space point
   * the player clicked/dragged on the minimap.
   */
  onMinimapJump(x: number, z: number): void;
  /** Phase 3 (logistics): order a unit to resupply at a depot. */
  onResupplyUnit(unitId: number, depotId: number): void;
  /**
   * Final-review R5 (2026-10-01): emergency-refuel a stranded
   * fossil-fuel aircraft (empty tank). The sim validates and rejects
   * loudly when the aircraft isn't stranded or funds are short.
   */
  onEmergencyRefuel(unitId: number): void;
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
  /**
   * Roadmap B3 (2026-10-02): gift funds to the AI rival (warms
   * disposition). The sim validates (funds, parties) and rejects
   * loudly in plain English — the controller toasts the reason.
   */
  onSendTribute(amount: number): void;
  /**
   * Roadmap B3 (2026-10-02): demand funds from the AI rival. The sim
   * resolves accept/refuse deterministically from disposition,
   * treasury, difficulty pride, and personality aggression. Rejected
   * loudly in peaceful worlds.
   */
  onDemandTribute(amount: number): void;
  /**
   * Roadmap B3 (2026-10-02): ask the AI rival for a 5-minute
   * ceasefire. The sim resolves accept/decline; rejected loudly in
   * peaceful worlds and while one is already active.
   */
  onProposeCeasefire(): void;
  /**
   * Fun-audit Tier 4 (E1, 2026-10-02): answer the waiting envoy
   * (accept/decline). The sim resolves the offer and rejects loudly
   * when no envoy waits.
   */
  onAnswerEnvoy(accept: boolean): void;
  /**
   * Fun-audit Tier 4 (E2, 2026-10-02): resolve the waiting luminary's
   * card with one of its choices. The sim applies the effect and
   * rejects loudly when no luminary awaits.
   */
  onResolveLuminary(choiceId: string): void;
  /** Phase 3 (logistics): set a supply unit's field services. */
  onSetSupplyToggles(
    unitId: number,
    services: { repair: boolean; rearm: boolean; refuel: boolean },
  ): void;
  /**
   * Sea-logistics Half B (2026-10-01): load / unload a supply unit's
   * cargo holds at a naval supply point. The sim validates and rejects
   * loudly.
   */
  onLoadCargo(unitId: number, buildingId: number): void;
  onUnloadCargo(unitId: number, buildingId: number): void;
  /** Phase 3: fire the Aegis shield. */
  onFireAegis(): void;
  /** Phase 3: enter Storm targeting mode (click map). */
  onStormTarget(): void;
  /** Phase 3: set city specialization. */
  onSetSpecialization(spec: string): void;
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
  /**
   * Grand-expansion Phase 8 (civilian ordinances, workstream E):
   * toggle a city-wide policy (Management tab's City ordinances
   * section). `on` is 0 (off) or 1 (on).
   */
  onSetPolicy(policy: string, on: 0 | 1): void;
  /** Airlines (Phase 5, S5): arm the two-click airline-route gesture. */
  onAirlineNewRoute(): void;
  /** Airlines (Phase 5, S5): cancel an airline route by its route id. */
  onCancelAirlineRoute(id: number): void;
  /** Civilian sea trade (Half A): arm the two-click sea-route gesture. */
  onSeaTradeNewRoute(): void;
  /** Civilian sea trade (Half A): cancel a sea route by its route id. */
  onCancelSeaRoute(id: number): void;
  /**
   * Civilian sea trade (Half A; naval-building model, 2026-10-01):
   * establish the armed dock pair with the picked cargo policy.
   */
  onSeaTradePolicy(policy: string): void;
  /**
   * Civilian sea trade (Half A): assign a ship to a sea route
   * (routeId 0 = unassign).
   */
  onAssignSeaRoute(unitId: number, routeId: number): void;
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
  /** Roadmap B10: per-chip net-rate spans (stockpiles only). */
  private readonly rateEls = new Map<string, HTMLElement>();
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
  /**
   * Fun-audit B4 (2026-10-02): the rival-watch strip widget (built
   * once in the constructor; refreshed via updateVictoryHud).
   */
  private readonly victoryHud: VictoryHud;
  /**
   * Fun-audit Tier 4 (E1, 2026-10-02): the envoy banner — the
   * diplomatic card pinned top-center while an envoy visits. Built
   * once, refreshed write-on-change (see ui/envoyBanner.ts); the
   * AD11 branch is registered in HUD_PANEL_BRANCHES with a
   * noDigestReason.
   */
  private readonly envoyBanner: EnvoyBanner;
  /**
   * Fun-audit Tier 4 (E2, 2026-10-02): the luminary decision card —
   * the presidential card pinned top-center while a luminary awaits
   * an audience. Built once, refreshed write-on-change (see
   * ui/luminaryCard.ts); the AD11 branch is registered in
   * HUD_PANEL_BRANCHES with a noDigestReason.
   */
  private readonly luminaryCard: LuminaryCard;
  /**
   * Roadmap B12 (minimap): the tactical overview widget, built once in
   * the constructor. Null only when the DOM is unavailable (headless).
   */
  private readonly minimap: Minimap | null;
  /** Final-review R5 (2026-10-01): sequential toast queue — a burst of
   * feedback shows each message in turn instead of overwriting. */
  private readonly toastQueue = new ToastQueue();
  private lastToastShown: string | null = null;
  private lastText = new Map<string, string>();
  private lastAdvisorKey: string | null = null;
  /**
   * Workstream Y (3-tab menu): which main menu tab is active. The build
   * tab is remembered per main tab so flipping between Civilian and
   * Military doesn't lose your place in either palette.
   */
  private menuTab: MenuTabId = 'civilian';
  /**
   * Command-menu rebuild (2026-10-01): the active sub-tab per main tab,
   * remembered like the build tabs so flipping between main tabs never
   * loses your place. Civilian → Tools / Build / Airlines; Military →
   * Train / Build / Superweapons; Management → Taxes / City focus /
   * Cabinet / Ordinances / Intelligence / Trade / Research.
   */
  private civilianSub: 'tools' | 'build' | 'airlines' = 'tools';
  private militarySub: 'train' | 'build' | 'superweapons' = 'train';
  private managementSub:
    | 'taxes'
    | 'economy'
    | 'focus'
    | 'cabinet'
    | 'ordinances'
    | 'intel'
    | 'diplomacy'
    | 'trade'
    | 'research' = 'taxes';
  /** The active main tab's sub-tab — the digest's sb: segment. */
  private get activeSubTab(): string {
    if (this.menuTab === 'military') return this.militarySub;
    if (this.menuTab === 'management') return this.managementSub;
    return this.civilianSub;
  }
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
   * Civilian sea trade (Half A, 2026-10-01): the sea-route tool state,
   * controller-owned (the airline tool's mirror). `seaTradeArmed` = the
   * "New sea route…" two-click gesture is live; `seaTradeFromId` = the
   * armed first dock (null = still picking the first); `seaTradeToId`
   * = the armed second dock (null until the second click — the panel
   * then shows the cargo-policy picker). Digest-covered (sa:) so the
   * armed status line repaints on change. The HUD never mutates these
   * — game.ts does.
   */
  seaTradeArmed = false;
  seaTradeFromId: number | null = null;
  seaTradeToId: number | null = null;
  /**
   * Roadmap B11 (2026-10-02): the armed palette build tool,
   * controller-owned (`'building:<kind>'`, `'road'`, `'powerLine'`,
   * `'waterPipe'`, `'rail'`, `'zoneR' | 'zoneC' | 'zoneI' | 'zoneA'`,
   * `'demolish'`; null = none armed). The HUD never mutates it —
   * game.ts sets it in onBuildTool and clears it on cancel/disarm.
   * Digest-covered (ar:) so the armed card highlight + status line
   * repaint on arm/disarm.
   */
  buildToolArmed: BuildTool | null = null;
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
      // Roadmap B10 (economy legibility): stockpiles get a net-rate
      // suffix (e.g. "+2.3/s"), written on change like the value —
      // still no topbar DOM rebuilds, per the branch invariant.
      if ((FLOW_RESOURCES as readonly string[]).includes(key)) {
        const rate = el('span', 'hud-rate', '');
        chip.append(rate);
        this.rateEls.set(key, rate);
      }
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

    // Fun-audit B4 (2026-10-02): the rival-watch strip — persistent
    // objective + victory-race telemetry. Built once, refreshed
    // write-on-change (see ui/victoryHud.ts); the AD11 branch is
    // registered in HUD_PANEL_BRANCHES with a noDigestReason.
    // AD11: the widget's DOM classes ('victory-hud',
    // 'victory-hud-objective', 'victory-hud-race', 'victory-hud-row',
    // 'victory-hud-mine', 'victory-hud-rival', 'victory-hud-label',
    // 'victory-hud-bar', 'victory-hud-fill', 'victory-hud-value') are
    // built in ui/victoryHud.ts — named here so the contract test's
    // stale-class check sees them (the minimap precedent).
    this.victoryHud = new VictoryHud(hud);

    // Fun-audit Tier 4 (E1, 2026-10-02): the envoy banner — pinned
    // top-center, shown only while an envoy visits the player's
    // gates. AD11: the widget's DOM classes ('envoy-banner',
    // 'envoy-banner-title', 'envoy-banner-sub', 'envoy-banner-buttons',
    // 'envoy-banner-btn', 'envoy-banner-accept', 'envoy-banner-decline')
    // are built in ui/envoyBanner.ts — named here so the contract
    // test's stale-class check sees them (the minimap precedent).
    this.envoyBanner = new EnvoyBanner(hud, (accept) => actions.onAnswerEnvoy(accept));

    // Fun-audit Tier 4 (E2, 2026-10-02): the luminary decision card —
    // pinned top-center, shown only while a luminary awaits the
    // player's decision. AD11: the widget's DOM classes
    // ('luminary-card', 'luminary-card-title', 'luminary-card-sub',
    // 'luminary-card-choices', 'luminary-card-btn',
    // 'luminary-card-btn-label', 'luminary-card-btn-hint',
    // 'luminary-card-default') are built in ui/luminaryCard.ts — named
    // here so the contract test's stale-class check sees them (the
    // minimap precedent).
    this.luminaryCard = new LuminaryCard(hud, (choiceId) => actions.onResolveLuminary(choiceId));

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

    // Roadmap B12 (minimap): the tactical overview canvas lives in the
    // bottom-right of the HUD root. Clicks/drags jump the camera via the
    // onMinimapJump action; repaints are throttled inside the widget.
    // AD11: the widget's DOM classes ('hud-minimap', 'hud-minimap-canvas')
    // are claimed by the 'minimap' branch in HUD_PANEL_BRANCHES — the
    // names live in ui/minimap.ts, referenced here so the contract test's
    // stale-class check sees them.
    this.minimap = new Minimap(hud, (x, z) => actions.onMinimapJump(x, z));

    root.append(hud);

    // Entity portraits (2026-10-01): kick off the lazy atlas load with
    // the first menu paint — never at boot, so the 8 MiB boot budget is
    // untouched. Glyphs render until the manifest + PNG arrive; then
    // refreshPortraits() patches the overlays in without a digest
    // rebuild (portraits are decorative — digest-neutral by design).
    // Never rejects (ensurePortraitsLoaded resolves false on any
    // failure → pure glyph mode).
    void ensurePortraitsLoaded().then((ok) => {
      if (ok) this.refreshPortraits();
    });
  }

  /**
   * Command-menu rebuild (2026-10-01): the slim icon rail on the left
   * edge of the selection panel — Civilian (house) / Military (shield) /
   * Management (sliders), icon AND text (user directive 2026-09-30),
   * with a clear active state (highlight + label). Replaces the old top
   * `menu-tabs` bar; the panel is now a rail + content flex row (see
   * `updateSelection`). Registered in HUD_PANEL_BRANCHES as 'menu-rail'
   * (digest label mt:).
   *
   * Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
   * peaceful worlds hide the Military tab entirely (the tab list comes
   * from the pure `menuTabsForWorld` helper so it is headless-testable).
   */
  private menuRailEl(world: World): HTMLElement {
    const rail = el('div', 'menu-rail');
    const icons: Record<MenuTabId, MenuIconKey> = {
      civilian: 'tabCivilian',
      military: 'tabMilitary',
      management: 'tabManagement',
    };
    for (const id of menuTabsForWorld(world.peaceful === true)) {
      const b = document.createElement('button');
      b.className = `menu-rail-btn${this.menuTab === id ? ' active' : ''}`;
      // Roadmap B18: per-tab color identity (class names claimed by the
      // menu-rail digest branch for the AD11 stale check:
      // 'tab-civilian', 'tab-military', 'tab-management').
      b.classList.add(menuTabColorClass(id));
      b.prepend(iconSpan(menuIcon(icons[id])));
      b.append(el('span', 'palette-label', loc(STRINGS.menuTabs[id])));
      b.setAttribute('aria-pressed', this.menuTab === id ? 'true' : 'false');
      b.addEventListener('click', () => {
        this.menuTab = id;
        // Tab switches must repaint even while paused (no tick advance).
        this.paletteDirty = true;
      });
      rail.append(b);
    }
    return rail;
  }

  /**
   * Command-menu rebuild (2026-10-01): the sub-tab pill row inside one
   * main tab. Named *El (not build*-prefixed) per the ui/AGENTS.md AD11
   * rule — it is covered by the 'menu-subtabs' digest branch (sb:
   * segment), not a branch of its own. The pill row highlights the
   * active sub-tab; clicks remember the choice per main tab.
   */
  private subTabBarEl(
    subs: ReadonlyArray<{ id: string; label: string }>,
    active: string,
    onSelect: (id: string) => void,
  ): HTMLElement {
    const bar = el('div', 'sub-tabs');
    bar.setAttribute('role', 'tablist');
    for (const sub of subs) {
      const b = document.createElement('button');
      b.className = `sub-tab${sub.id === active ? ' active' : ''}`;
      b.textContent = sub.label;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', sub.id === active ? 'true' : 'false');
      b.addEventListener('click', () => {
        onSelect(sub.id);
        // Sub-tab switches must repaint even while paused (no tick
        // advance) — same rule as main-tab switches.
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
   * Command-menu rebuild (2026-10-01): the detail view's Back button —
   * returns to the tab menu. Same as Esc / clicking empty ground
   * (game.ts owns the selection; see HUDActions.onDeselect).
   */
  private detailBackEl(): HTMLElement {
    const back = document.createElement('button');
    back.className = 'detail-back';
    back.textContent = `← ${loc(STRINGS.selection.backToMenu)}`;
    back.addEventListener('click', () => this.actions.onDeselect());
    return back;
  }

  /**
   * Entity portraits (2026-10-01): a fixed-size thumbnail box for a
   * command-menu card — the SVG glyph (aria-hidden, as before) plus a
   * `data-portrait-kind` / `data-portrait-box` hook. refreshPortraits()
   * appends the atlas `.portrait` overlay once the manifest is in; until
   * then (or when the kind has no atlas sprite) the glyph is the whole
   * art — no card ever renders blank. Named *El per the ui/AGENTS.md
   * AD11 rule; the 'palette-thumb' class is claimed by the card's digest
   * branch (decorative — no digest segment).
   */
  private portraitThumbEl(kind: string, glyph: string, boxPx: number): HTMLElement {
    const thumb = el('span', 'palette-thumb');
    thumb.dataset['portraitKind'] = kind;
    thumb.dataset['portraitBox'] = String(boxPx);
    thumb.append(iconSpan(glyph));
    return thumb;
  }

  /**
   * Entity portraits (2026-10-01): patch atlas overlays into every
   * thumbnail host in the selection panel. Idempotent and cheap, and
   * digest-neutral — the digest key is untouched, so no rebuild loop.
   * Called after every panel build and once when the lazy atlas load
   * resolves.
   */
  private refreshPortraits(): void {
    applyPortraits(this.selectionPanel, (style: PortraitStyle): HTMLElement => {
      const s = el('span', 'portrait');
      s.setAttribute('aria-hidden', 'true');
      s.style.backgroundImage = style.backgroundImage;
      s.style.backgroundPosition = style.backgroundPosition;
      s.style.backgroundSize = style.backgroundSize;
      s.style.backgroundRepeat = style.backgroundRepeat;
      return s;
    });
  }

  /**
   * Command-menu rebuild (2026-10-01): the detail header — the
   * selected unit/building's icon plus its name.
   *
   * Entity portraits (2026-10-01): when a kind is given, the icon
   * becomes a large "dossier photo" hero — a fixed 96px box holding
   * the glyph (the fallback) with the atlas portrait overlaid via
   * refreshPortraits(). The title stays the accessible name; the hero
   * art is aria-hidden through the glyph/overlay spans.
   */
  private detailHeaderEl(icon: string, title: string, kind?: string): HTMLElement {
    const h = el('div', 'detail-header');
    if (kind !== undefined && icon !== '') {
      const hero = el('div', 'detail-hero');
      hero.dataset['portraitKind'] = kind;
      hero.dataset['portraitBox'] = String(DETAIL_HERO_BOX_PX);
      hero.append(iconSpan(icon));
      h.prepend(hero);
    } else if (icon !== '') {
      h.prepend(iconSpan(icon));
    }
    h.append(el('div', 'detail-title', title));
    return h;
  }

  /**
   * Civilian main tab: three sub-tabs (command-menu rebuild, 2026-10-01)
   * — Tools (road / power line / water pipe / rail / zones / demolish),
   * Build (the 9 civilian build tabs as pills + the card grid), and
   * Airlines (routes + the two-click "New route…" gesture).
   *
   * Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
   * peaceful worlds hide the Military tab, so this tab carries the
   * one-line note saying so. Static text — no digest segment needed
   * (the military tab's own absence is implied by mt: + world.peaceful,
   * which never toggles mid-game).
   */
  private appendCivilianPanel(panel: HTMLElement, world: World): void {
    const m = STRINGS.menuTabs;
    if (world.peaceful === true) {
      panel.append(
        el('div', 'panel-status', loc(STRINGS.peaceful.militaryHiddenNote)),
      );
    }
    panel.append(
      this.subTabBarEl(
        [
          { id: 'tools', label: loc(m.subTools) },
          { id: 'build', label: loc(m.subBuild) },
          { id: 'airlines', label: loc(m.subAirlines) },
        ],
        this.civilianSub,
        (id) => {
          this.civilianSub = id as 'tools' | 'build' | 'airlines';
        },
      ),
    );
    if (this.civilianSub === 'build') {
      const tabs = buildTabsForMenuTab(allBuildTabs(), 'civilian');
      this.appendBuildPanel(panel, world, tabs);
    } else if (this.civilianSub === 'airlines') {
      // Grand-expansion Phase 5 (S5): the airline panel — the player's
      // routes plus the two-click "New route…" gesture. Registered in
      // HUD_PANEL_BRANCHES as 'airline-panel' (digestLabels: al:, aa:).
      panel.append(this.airlinePanelEl(world));
    } else {
      panel.append(this.civilianToolsEl(world));
    }
  }

  /**
   * Civilian → Tools: the build tools row (road + class picker, power
   * line / water pipe / rail networks, zone R-C-I-A, demolish). Moved
   * out of appendCivilianPanel by the command-menu rebuild (2026-10-01);
   * the tools live here because they are civilian infrastructure tools.
   *
   * Named *El (not append*-prefixed) per the ui/AGENTS.md AD11 rule —
   * covered by the 'tools-row' digest branch (rc: segment), not a
   * branch of its own. All DOM classes are the ones that branch
   * already claims.
   */
  private civilianToolsEl(world: World): HTMLElement {
    const p = STRINGS.palettes;
    const toolsRow = el('div', 'palette-tools');
    // Roadmap B11 (2026-10-02): the armed tool's persistent status line
    // (the airline/sea-trade armed-line pattern) — the building tools'
    // line lives in appendBuildPanel; this one covers road, networks,
    // zones, and demolish.
    if (this.buildToolArmed !== null && !this.buildToolArmed.startsWith('building:')) {
      const line = this.armedBuildToolLine();
      if (line !== null) toolsRow.append(el('div', 'panel-status', line));
    }
    const makeToolButton = (
      tool: BuildTool,
      label: string,
      icon: PaletteToolIcon,
    ): HTMLButtonElement => {
      const b = document.createElement('button');
      // Roadmap B11 (2026-10-02): the armed tool button stays
      // highlighted while its gesture is live (same 'armed' class as
      // the build cards; digest-covered ar:).
      b.className = `build-btn${this.buildToolArmed === tool ? ' armed' : ''}`;
      b.prepend(iconSpan(toolIcon(icon)));
      b.append(el('span', 'palette-label', label));
      b.addEventListener('click', () => this.actions.onBuildTool(tool));
      return b;
    };
    toolsRow.append(this.civilianToolsSection(
      loc(p.toolSectionRoads),
      (group) => {
        group.append(makeToolButton('road', loc(p.toolRoad), 'road'));
        // Phase 4 (transport): the road tool paints the selected class —
        // the small class picker sits with the road button
        // (dirt/country/paved/highway, per-cell cost in the title).
        // Dragging over existing lower-class roads upgrades them in
        // place (difference pricing via the sim's upgradeRoad).
        // Registered in HUD_PANEL_BRANCHES as 'tools-row'
        // (digestLabels: rc:).
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
        group.append(classRow);
      },
    ));
    // Phase 2 (utilities): the drag-paint network tools sit together in
    // a "Networks" group, next to the road tool they share a gesture
    // with. Phase 4 (transport): the rail tool joins them.
    toolsRow.append(this.civilianToolsSection(
      loc(p.toolSectionNetworks),
      (group) => {
        const netTools = [
          { tool: 'powerLine', label: loc(p.toolPowerLine), icon: 'powerLine' },
          { tool: 'waterPipe', label: loc(p.toolWaterPipe), icon: 'waterPipe' },
          { tool: 'rail', label: loc(p.toolRail), icon: 'rail' },
        ] as const;
        for (const { tool, label, icon } of netTools) {
          group.append(makeToolButton(tool, label, icon));
        }
      },
    ));
    // Workstream Z: the zone tools are grouped under a small "Zoning"
    // section header so their purpose is obvious at a glance.
    toolsRow.append(this.civilianToolsSection(
      loc(p.toolSectionZoning),
      (group) => {
        const zoneTools = [
          { tool: 'zoneR', label: loc(p.toolZoneR), icon: 'zoneR' },
          { tool: 'zoneC', label: loc(p.toolZoneC), icon: 'zoneC' },
          { tool: 'zoneI', label: loc(p.toolZoneI), icon: 'zoneI' },
          // Grand-expansion Phase 5 (S5): the airport zone tool rides
          // the same drag pipeline as the other zones.
          { tool: 'zoneA', label: loc(p.toolZoneA), icon: 'zoneA' },
        ] as const;
        for (const { tool, label, icon } of zoneTools) {
          group.append(makeToolButton(tool, label, icon));
        }
      },
    ));
    toolsRow.append(this.civilianToolsSection(
      loc(p.toolSectionDemolish),
      (group) => {
        group.append(makeToolButton('demolish', loc(p.toolDemolish), 'demolish'));
      },
    ));
    return toolsRow;
  }

  /**
   * One labeled tool group inside Civilian → Tools (command-menu
   * rebuild, 2026-10-01): the Roads / Networks / Zoning / Demolish
   * sections share the same wrapper. The name carries no append/build/
   * update prefix, so the AD11 method scan skips it; all DOM classes
   * are the ones the 'tools-row' branch already claims.
   */
  private civilianToolsSection(
    title: string,
    fill: (group: HTMLElement) => void,
  ): HTMLElement {
    const group = el('div', 'palette-zones');
    group.append(el('div', 'palette-section-title', title));
    fill(group);
    return group;
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
   * Military main tab: three sub-tabs (command-menu rebuild, 2026-10-01)
   * — Train (unit orders + the 6-tab train palette), Build (the 4
   * military build tabs as pills + the card grid), Superweapons
   * (Aegis/Storm as cards).
   */
  private appendMilitaryPanel(panel: HTMLElement, world: World): void {
    const m = STRINGS.menuTabs;
    panel.append(
      this.subTabBarEl(
        [
          { id: 'train', label: loc(m.subTrain) },
          { id: 'build', label: loc(m.subBuild) },
          { id: 'superweapons', label: loc(m.subSuperweapons) },
        ],
        this.militarySub,
        (id) => {
          this.militarySub = id as 'train' | 'build' | 'superweapons';
        },
      ),
    );
    if (this.militarySub === 'build') {
      const tabs = buildTabsForMenuTab(allBuildTabs(), 'military');
      this.appendBuildPanel(panel, world, tabs);
    } else if (this.militarySub === 'superweapons') {
      panel.append(this.superweaponsEl());
    } else {
      panel.append(this.militaryOrdersEl());
      this.appendTrainPanel(panel, world);
    }
  }

  /**
   * Military → Train: the unit-orders help strip. Attack/move are
   * right-click map gestures (game.ts issueContextOrder); Stop is the
   * selection panel button / the S key. No per-unit "defend" command
   * exists in the sim — the strip says what the game actually has.
   * (Command-menu rebuild, 2026-10-01: the old ⚔/➤/■ glyphs are gone —
   * plain labeled rows, no emoji in UI.)
   *
   * Named *El per the ui/AGENTS.md AD11 rule — covered by the
   * 'military-panel' digest branch (static help text, no digest
   * segment), not a branch of its own.
   */
  private militaryOrdersEl(): HTMLElement {
    const m = STRINGS.menuTabs;
    const orders = this.makeSection(loc(m.ordersTitle));
    for (const hint of [m.attackHint, m.moveHint, m.stopHint]) {
      orders.append(el('div', 'order-hint', loc(hint)));
    }
    return orders;
  }

  /**
   * Military → Superweapons: Aegis and Storm as cards — icon, name, the
   * requirement line, and the fire button. (Moved here from the old
   * Phase 3 "Command" panel; the command protocol is unchanged.)
   *
   * Named *El per the ui/AGENTS.md AD11 rule — covered by the
   * 'military-panel' digest branch (static labels; a click either fires
   * or the sim rejects loudly), not a branch of its own. New DOM
   * classes (sw-card/sw-body/sw-name/sw-desc) are claimed by that
   * branch.
   */
  private superweaponsEl(): HTMLElement {
    const m = STRINGS.menuTabs;
    const sec = this.makeSection(loc(m.superTitle));
    const cards = [
      {
        kind: 'aegisControl' as const,
        desc: loc(m.aegisTitle),
        verb: loc(m.fireAegis),
        title: loc(m.aegisTitle),
        onClick: () => this.actions.onFireAegis(),
      },
      {
        kind: 'stormArray' as const,
        desc: loc(m.stormTitle),
        verb: loc(m.stormTarget),
        title: loc(m.stormTitle),
        onClick: () => this.actions.onStormTarget(),
      },
    ];
    for (const c of cards) {
      const card = el('div', 'sw-card');
      card.prepend(this.portraitThumbEl(c.kind, buildingIcon(c.kind), SW_CARD_PORTRAIT_BOX_PX));
      const body = el('div', 'sw-body');
      body.append(el('div', 'sw-name', buildingName(c.kind)));
      body.append(el('div', 'sw-desc', c.desc));
      card.append(body);
      card.append(this.makePanelButton(c.verb, c.title, c.onClick));
      sec.append(card);
    }
    return sec;
  }

  /**
   * Management main tab: seven sub-tabs (command-menu rebuild,
   * 2026-10-01) — Taxes, City focus, Cabinet (mayor/general), City
   * ordinances, Intelligence, Trade, and Research (when the player owns
   * a completed lab; otherwise the sub-tab explains what unlocks it).
   * The old Phase 3 "Command" panel's specialization/mayor/general
   * controls live here; taxes are UI over the existing setTaxRate
   * command (orders.ts already had the HUD-tax builder waiting).
   *
   * Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
   * peaceful games head the tab with the peaceful-objectives section —
   * the victory condition is the tab's most important content.
   */
  private appendManagementPanel(panel: HTMLElement, world: World, terrain?: TerrainData): void {
    const m = STRINGS.menuTabs;
    if (world.peaceful === true) {
      panel.append(this.peacefulObjectivesEl(world, terrain));
    }
    const subs = [
      { id: 'taxes', label: loc(m.subTaxes) },
      { id: 'economy', label: loc(m.subEconomy) },
      { id: 'focus', label: loc(m.subFocus) },
      { id: 'cabinet', label: loc(m.subCabinet) },
      { id: 'ordinances', label: loc(m.subOrdinances) },
      { id: 'intel', label: loc(m.subIntel) },
      { id: 'diplomacy', label: loc(m.subDiplomacy) },
      { id: 'trade', label: loc(m.subTrade) },
      { id: 'research', label: loc(m.subResearch) },
    ];
    panel.append(
      this.subTabBarEl(subs, this.managementSub, (id) => {
        this.managementSub = id as typeof this.managementSub;
      }),
    );
    switch (this.managementSub) {
      case 'economy':
        panel.append(this.economySectionEl(world));
        break;
      case 'focus':
        panel.append(this.focusSectionEl(world));
        break;
      case 'cabinet':
        panel.append(this.cabinetSectionEl(world));
        break;
      case 'ordinances':
        // Grand-expansion Phase 8 (civilian ordinances, workstream E):
        // the City ordinances section — five city-wide policy toggles
        // with real upkeep (ordinances are civilian city management;
        // peaceful games keep them too).
        panel.append(this.policySectionEl(world));
        break;
      case 'intel':
        // Grand-expansion Phase 7 (intel): the intel panel — asset
        // counters, spies + covert actions, warnings, rival airports.
        panel.append(this.intelSectionEl(world));
        break;
      case 'diplomacy':
        // Roadmap B3 (2026-10-02): the diplomacy panel — disposition
        // readout, tribute / demand / ceasefire actions, AI answers.
        panel.append(this.diplomacySectionEl(world));
        break;
      case 'trade':
        // Fun-audit C2c (land-trade deletion, 2026-10-02): the
        // player-to-player land trade routes are gone — the Trade
        // sub-tab now holds only the dock-to-dock sea routes (Half A,
        // 2026-10-01; naval-building model, 2026-10-01).
        panel.append(this.seaTradeSectionEl(world));
        break;
      case 'research':
        if (playerHasCompletedLab(world, HUMAN_PLAYER_ID)) {
          this.appendResearchPanel(panel, world);
        } else {
          panel.append(el('div', 'panel-status', loc(m.researchNeedsLab)));
        }
        break;
      case 'taxes':
      default:
        panel.append(this.taxSectionEl(world));
        break;
    }
  }

  /**
   * Management → Trade: the civilian sea-trade section (Half A,
   * 2026-10-01; naval-building model, 2026-10-01) — the player's
   * dock-to-dock sea routes with their cargo policies, the "New sea
   * route…" two-click gesture, and the policy picker that appears
   * once both docks are picked. Named
   * *El (not append/build/update-prefixed) per the ui/AGENTS.md AD11
   * rule — it is covered by the management-panel digest branch (st:/
   * sa: segments), not a branch of its own. All DOM classes are the
   * shared panel classes that branch already claims.
   */
  private seaTradeSectionEl(world: World): HTMLElement {
    const m = STRINGS.menuTabs;
    const sec = this.makeSection(loc(m.seaTradeTitle));
    const routes = seaRoutesOf(world, HUMAN_PLAYER_ID);
    if (routes.length === 0 && !this.seaTradeArmed) {
      sec.append(el('div', 'panel-status', loc(m.seaTradeEmpty)));
    }
    for (const r of routes) {
      const row = el('div', 'panel-row');
      row.append(
        el(
          'span',
          'panel-label',
          `${this.seaHarborName(world, r.from)} ↔ ${this.seaHarborName(world, r.to)} · ${seaRouteIncomeOf(world, r)}`,
        ),
      );
      row.append(
        this.makePanelButton(loc(m.seaTradeCancel), loc(m.seaTradeCancel), () =>
          this.actions.onCancelSeaRoute(r.id),
        ),
      );
      sec.append(row);
    }
    // The armed two-click gesture: still picking docks, or picking the
    // cargo policy for a completed pair.
    if (this.seaTradeArmed) {
      if (this.seaTradeFromId === null) {
        sec.append(el('div', 'panel-status', loc(m.seaTradePickFirst)));
      } else if (this.seaTradeToId === null) {
        sec.append(
          el('div', 'panel-status', `${this.seaHarborName(world, this.seaTradeFromId)} — ${loc(m.seaTradeRouteArmed)}`),
        );
      } else {
        sec.append(
          el(
            'div',
            'panel-status',
            `${this.seaHarborName(world, this.seaTradeFromId)} ↔ ${this.seaHarborName(world, this.seaTradeToId)} — ${loc(m.seaTradePickPolicy)}`,
          ),
        );
        for (const p of SEA_ROUTE_POLICIES) {
          const desc =
            p === 'funds'
              ? loc(m.seaTradePolicyFundsDesc)
              : p === 'fuel'
                ? loc(m.seaTradePolicyFuelDesc)
                : loc(m.seaTradePolicyMaterialsDesc);
          sec.append(
            this.makePanelButton(
              p === 'funds'
                ? loc(m.seaTradePolicyFunds)
                : p === 'fuel'
                  ? loc(m.seaTradePolicyFuel)
                  : loc(m.seaTradePolicyMaterials),
              desc,
              () => this.actions.onSeaTradePolicy(p),
            ),
          );
        }
      }
    } else {
      const harbors = this.seaHarborEndpoints(world);
      sec.append(
        this.makePanelButton(
          loc(m.seaTradeNewRoute),
          loc(m.seaTradeNeedsTwo),
          () => this.actions.onSeaTradeNewRoute(),
          { disabled: harbors.length < 2 },
        ),
      );
    }
    return sec;
  }

  /** Display name for a sea-trade dock: kind name + building id. */
  private seaHarborName(world: World, id: number): string {
    const b = world.city.buildings.find((x) => x.id === id);
    if (b === undefined) return `Harbor ${id}`;
    return `${buildingName(b.kind)} ${id}`;
  }

  /**
   * The player's sea-trade endpoints: completed, owned civilian ports.
   * Mirrors the sim's establishSeaRoute validation (progress >= 1, own
   * building, civilian portType) — the "New sea route…" button disables
   * below two so the armed gesture can never click into a rejected
   * order.
   */
  private seaHarborEndpoints(world: World): BuildingRecord[] {
    return world.city.buildings.filter(
      (b) =>
        b.owner === HUMAN_PLAYER_ID &&
        b.progress >= 1 &&
        isSeaTradeHarbor(b),
    );
  }

  /**
   * Management → Peaceful status (grand-expansion Phase 8, workstream
   * B; endless revision 2026-10-01). Renders only in peaceful worlds:
   * the city's live status — housed population and treasury health.
   * There is no victory condition, no target, no rival race; this is
   * information, not progress toward a goal.
   *
   * Named *El (not append/build/update-prefixed) per the ui/AGENTS.md
   * AD11 rule — it is covered by the management-panel digest branch
   * (po: + ps: segments), not a branch of its own. All DOM classes are the
   * shared panel classes that branch already claims.
   */
  private peacefulObjectivesEl(world: World, terrain?: TerrainData): HTMLElement {
    const lines = peacefulStatusLines(world, HUMAN_PLAYER_ID);
    const scoreLines = peacefulScoreLines(
      world,
      HUMAN_PLAYER_ID,
      terrain,
      loadPeacefulBest(),
    );
    const sec = this.makeSection(loc(STRINGS.peaceful.statusTitle));
    {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', lines.populationLine));
      sec.append(row);
    }
    {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', lines.treasuryLine));
      sec.append(row);
    }
    {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', scoreLines.scoreLine));
      sec.append(row);
    }
    {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', scoreLines.bestLine));
      sec.append(row);
    }
    return sec;
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
    // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
    // covert ops are hostile acts — the sim rejects them loudly, so the
    // UI must not offer them either. One note replaces the whole action
    // set; the spy display lines stay (informational).
    const peaceful = world.peaceful === true;
    if (peaceful) {
      sec.append(
        el('div', 'panel-status', loc(STRINGS.peaceful.covertOpsDisabled)),
      );
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
      // Covert actions against enemy buildings in reach. Skipped in
      // peaceful games (see the note above) — the sim would reject
      // them loudly, so offering the buttons would be a lie. The
      // no-targets hint is skipped too: in peaceful mode the note above
      // already explains why there is nothing to do.
      const targets = peaceful ? [] : opTargetsOf(world, spy);
      if (targets.length === 0 && !peaceful) {
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
      // "Embedded … ready to steal tech" line says so). Not offered in
      // peaceful games (hostile act — see the note above).
      const state = spyDisplayState(world, spy);
      if (state.kind === 'embedded' && !peaceful) {
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

  /**
   * Roadmap B3 (2026-10-02): Management → Diplomacy — the
   * disposition readout, tribute / demand / ceasefire actions, and the
   * AI's last answers. The panel never re-implements sim checks: the
   * sim validates every order and rejects loudly (game.ts toasts it).
   */
  private diplomacySectionEl(world: World): HTMLElement {
    const s = STRINGS.diplomacy;
    const sec = this.makeSection(loc(s.panelTitle));
    const d = world.diplomacy;

    // Disposition readout.
    const mood =
      d.disposition >= 75
        ? loc(s.dispositionWarm)
        : d.disposition >= 50
          ? loc(s.dispositionNeutral)
          : d.disposition >= 25
            ? loc(s.dispositionCold)
            : loc(s.dispositionHostile);
    sec.append(
      el(
        'div',
        'panel-row',
        fillLoc(s.dispositionLine, { mood, value: Math.round(d.disposition) }),
      ),
    );

    // Ceasefire status.
    if (ceasefireActive(world)) {
      const secs = Math.ceil(ceasefireTicksLeft(world) / 30);
      const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      sec.append(el('div', 'panel-row', fillLoc(s.ceasefireActive, { time })));
    } else {
      sec.append(el('div', 'panel-status', loc(s.ceasefireNone)));
    }

    // Fun-audit Tier 4 (E1, 2026-10-02): the envoy status line — the
    // banner is the primary UI, this row keeps the Management tab
    // honest. Digest-covered (the `di:` segment carries envoy state).
    const envoyView = envoyBannerView(world, HUMAN_PLAYER_ID);
    if (envoyView !== null) {
      const secs = envoyView.secondsLeft ?? 0;
      const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const line =
        envoyView.phase === 'inbound'
          ? loc(s.envoyInbound)
          : envoyView.phase === 'refusalWaiting'
            ? loc(s.envoyWaitingRefusal)
            : envoyView.phase === 'departing'
              ? loc(s.envoyDeparting)
              : fillLoc(s.envoyWaitingCeasefire, { time });
      sec.append(el('div', 'panel-row', line));
    }

    // Last AI answers.
    if (d.lastDemand === 'accepted') {
      sec.append(
        el(
          'div',
          'panel-row',
          fillLoc(s.demandAccepted, { amount: Math.floor(d.lastDemandAmount) }),
        ),
      );
    } else if (d.lastDemand === 'refused') {
      sec.append(el('div', 'panel-row', loc(s.demandRefused)));
    }
    if (d.lastCeasefireAsk === 'accepted') {
      sec.append(el('div', 'panel-row', loc(s.ceasefireAccepted)));
    } else if (d.lastCeasefireAsk === 'declined') {
      sec.append(el('div', 'panel-row', loc(s.ceasefireDeclined)));
    } else if (d.lastCeasefireAsk === 'broken') {
      sec.append(el('div', 'panel-row', loc(s.ceasefireBroken)));
    }

    // Send tribute.
    sec.append(el('div', 'panel-row', loc(s.tributeTitle)));
    sec.append(el('div', 'panel-status', loc(s.tributeHint)));
    {
      const row = el('div', 'panel-row');
      for (const amount of [500, 2000, 10000]) {
        row.append(
          this.makePanelButton(
            fillLoc(s.amountButtonTitle, { verb: loc(s.sendVerb), amount }),
            fillLoc(s.amountButtonTitle, { verb: loc(s.sendVerb), amount }),
            () => this.actions.onSendTribute(amount),
          ),
        );
      }
      sec.append(row);
    }

    // Demand tribute (war only — the sim rejects loudly in peaceful).
    if (world.peaceful !== true) {
      sec.append(el('div', 'panel-row', loc(s.demandTitle)));
      sec.append(el('div', 'panel-status', loc(s.demandHint)));
      // Fun-audit C2b (influence triage, 2026-10-02): demands cost
      // influence — the cost is shown and the buttons disable (with a
      // reason) when the player is short. Never a dead button.
      const influence = getPlayer(world.city, HUMAN_PLAYER_ID)?.influence ?? 0;
      const demandShort = influence < DEMAND_TRIBUTE_INFLUENCE_COST;
      sec.append(
        el(
          'div',
          'panel-status',
          fillLoc(s.demandCostHint, {
            cost: DEMAND_TRIBUTE_INFLUENCE_COST,
            have: Math.floor(influence),
          }),
        ),
      );
      {
        const row = el('div', 'panel-row');
        for (const amount of [500, 2000, 10000]) {
          row.append(
            this.makePanelButton(
              fillLoc(s.amountButtonTitle, { verb: loc(s.demandVerb), amount }),
              demandShort
                ? loc(s.notEnoughInfluence)
                : fillLoc(s.amountButtonTitle, { verb: loc(s.demandVerb), amount }),
              () => this.actions.onDemandTribute(amount),
              { disabled: demandShort },
            ),
          );
        }
        sec.append(row);
      }

      // Ceasefire.
      sec.append(el('div', 'panel-row', loc(s.ceasefireTitle)));
      sec.append(el('div', 'panel-status', loc(s.ceasefireHint)));
      sec.append(
        el(
          'div',
          'panel-status',
          fillLoc(s.ceasefireCostHint, {
            cost: CEASEFIRE_INFLUENCE_COST,
            have: Math.floor(influence),
          }),
        ),
      );
      if (!ceasefireActive(world)) {
        const ceasefireShort = influence < CEASEFIRE_INFLUENCE_COST;
        const row = el('div', 'panel-row');
        row.append(
          this.makePanelButton(
            loc(s.ceasefireButton),
            ceasefireShort ? loc(s.notEnoughInfluence) : loc(s.ceasefireButton),
            () => this.actions.onProposeCeasefire(),
            { disabled: ceasefireShort },
          ),
        );
        sec.append(row);
      }
    }

    // Lifetime totals.
    sec.append(
      el(
        'div',
        'panel-status',
        fillLoc(s.totalsLine, {
          sent: Math.floor(d.totalTributeSent),
          received: Math.floor(d.totalTributeReceived),
        }),
      ),
    );
    return sec;
  }

  /**
   * Management → Economy (roadmap B10, 2026-10-02): the stockpile
   * overview — every stockpile with its stock and net flow rate, so a
   * player starving for fuel can see the drain at a glance. Renders
   * through the shared `flowRate` getter and `formatFlowRate` mirror;
   * digest-covered (`ec:` segment, AD11).
   */
  private economySectionEl(world: World): HTMLElement {
    const m = STRINGS.menuTabs;
    const s = STRINGS.hud;
    const sec = this.makeSection(loc(m.economyTitle));
    const player = getPlayer(world.city, HUMAN_PLAYER_ID);
    const labels: Record<FlowResource, string> = {
      funds: s.funds,
      materials: s.materials,
      food: s.food,
      fuel: s.fuel,
      goods: s.goods,
      research: s.research,
      manpower: s.manpower,
      influence: s.influence,
    };
    for (const res of FLOW_RESOURCES) {
      const row = el('div', 'panel-row');
      row.append(el('span', 'panel-label', labels[res]));
      const rateText = formatFlowRate(flowRate(world, HUMAN_PLAYER_ID, res));
      const stock = player !== undefined ? player[res] : 0;
      row.append(
        el('span', 'panel-status', rateText === '' ? fmt(stock) : `${fmt(stock)} (${rateText})`),
      );
      sec.append(row);
    }
    sec.append(el('div', 'panel-status', loc(m.economyHint)));
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
   * Management → City ordinances (grand-expansion Phase 8, civilian
   * ordinances, workstream E): the five city-wide policy toggles — name,
   * icon, upkeep cost, one-line effect, and live funded/unfunded status
   * — with an On/Off toggle per policy. Rows read through
   * ui/policies.ts (the contract module), never the sim records
   * directly; toggles emit `setPolicy` orders and the sim's
   * plain-English rejection strings toast loudly on failure.
   *
   * Named *El (not append/build/update-prefixed) per the ui/AGENTS.md
   * AD11 rule — it is covered by the management-panel digest branch
   * (oc: segment), not a branch of its own. All DOM classes are the
   * shared panel classes that branch already claims (panel-row,
   * panel-label, panel-btn, panel-status).
   */
  private policySectionEl(world: World): HTMLElement {
    const sec = this.makeSection(loc(STRINGS.policies.title));
    sec.append(el('div', 'panel-status', loc(STRINGS.policies.subtitle)));
    for (const prow of policyRows(world, HUMAN_PLAYER_ID)) {
      const row = el('div', 'panel-row');
      const label = el('span', 'panel-label');
      // Icon + text (user directive 2026-09-30: never icon-only).
      label.innerHTML =
        `${policyIcon(prow.id)}<span>${prow.name} · ${policyUpkeepLine(prow.upkeep)}</span>`;
      const toggle = document.createElement('button');
      toggle.className = `panel-btn${prow.on ? ' active' : ''}`;
      toggle.title = prow.on ? `Turn off ${prow.name}` : `Turn on ${prow.name}`;
      toggle.innerHTML =
        `${policyIcon(prow.id)}<span>${prow.on ? 'On' : 'Off'}</span>`;
      toggle.addEventListener('click', () =>
        this.actions.onSetPolicy(prow.id, prow.on ? 0 : 1),
      );
      row.append(label, toggle);
      sec.append(row);
      const detail = el('div', 'panel-status', prow.effect);
      sec.append(detail);
      const status = policyStatusLine(prow);
      if (status !== '') sec.append(el('div', 'panel-status', status));
    }
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
    // Toasts pump first — feedback like "Game paused" must show even
    // while the sim is paused.
    this.pumpToasts();
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
      // Roadmap B10: net-rate suffixes on the stockpile chips (same
      // write-on-change path as the values).
      for (const res of FLOW_RESOURCES) {
        this.setRate(
          `rate:${res}`,
          flowRate(world, HUMAN_PLAYER_ID, res),
          this.rateEls.get(res),
        );
      }
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
    // Per-side ages (2026-10-01, roadmap A1): the HUD shows the HUMAN
    // player's own age and programs — rivals advance independently.
    const myAge = getAgeState(world, HUMAN_PLAYER_ID);
    const ageName =
      myAge.age === 'foundation'
        ? s.ageFoundation
        : `${ageNames[myAge.age]} · ${programNames[myAge.program ?? ''] ?? ''}`;
    this.setText('age', ageName, this.ageEl);
    this.currentAge = myAge.age;

    // Advance-age button: visible when a next age exists; shows cost and programs.
    const prog = AGE_PROGRESSION[myAge.age];
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
      // Command-menu rebuild (2026-10-01): the active sub-tab of the
      // active main tab — the pill row highlights it (sb: segment).
      this.activeSubTab,
      // Civilian sea trade (Half A, 2026-10-01): the sea-route tool's
      // armed state — undefined when disarmed (the sa: segment reads
      // 'off' then).
      this.seaTradeArmed
        ? { from: this.seaTradeFromId, to: this.seaTradeToId }
        : undefined,
      // Roadmap B11 (2026-10-02): the armed palette build tool —
      // undefined when disarmed (the ar: segment reads 'off' then).
      this.buildToolArmed ?? undefined,
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

    // Command-menu rebuild (2026-10-01): the panel is a slim icon rail
    // on the left edge plus the content column. The rail is present in
    // every state; the content is the active tab when nothing is
    // selected, or the contextual unit/building detail view when
    // something is.
    // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
    // the Military tab is hidden in peaceful worlds — a remembered
    // 'military' selection can never point at it, so render Civilian
    // instead (the stored state is left alone; the button is simply
    // gone). The digest's mt: segment still keys on the stored tab.
    // Roadmap B18 (2026-10-02): the shell carries the effective tab's
    // color-identity class (tab-civilian/military/management) so the
    // sub-tabs and palette tabs inside inherit the tab accent.
    const menuTab =
      world.peaceful === true && this.menuTab === 'military'
        ? 'civilian'
        : this.menuTab;
    const shell = el('div', 'menu-shell');
    // Roadmap B18: the shell carries the effective tab's color-identity
    // class so sub-tabs and palette tabs inside inherit the tab accent.
    shell.classList.add(menuTabColorClass(menuTab));
    shell.append(this.menuRailEl(world));
    const content = el('div', 'menu-content');
    shell.append(content);
    panel.append(shell);

    if (selection.unitIds.length === 0 && selection.buildingId === null) {
      content.append(el('div', 'sel-empty', sel.noSelection));
      if (menuTab === 'civilian') {
        this.appendCivilianPanel(content, world);
      } else if (menuTab === 'military') {
        this.appendMilitaryPanel(content, world);
      } else {
        this.appendManagementPanel(content, world, terrain);
      }
      // Entity portraits (2026-10-01): patch atlas overlays into the
      // freshly built card thumbnails (no-op until the lazy load
      // resolves; digest-neutral).
      this.refreshPortraits();
      return;
    }

    if (selection.unitIds.length > 0) {
      const units = selection.unitIds
        .map((id) => world.units.find((u) => u.id === id))
        .filter((u) => u !== undefined);
      // Command-menu rebuild (2026-10-01): the detail view — Back to
      // the tab menu, the header (icon + name), then one stat block and
      // one action row per unit. All values keep their digest segments
      // (u:/uh:/uv:/um:/uf:/us:/ue:/ew:/iu:/er:); the new detail classes
      // are claimed by the 'selection-units' digest branch.
      panel.append(this.detailBackEl());
      const firstKind = units[0]?.kind as UnitKind | undefined;
      panel.append(
        this.detailHeaderEl(
          firstKind !== undefined ? unitIcon(firstKind) : '',
          sel.unitsSelected(units.length),
          firstKind,
        ),
      );
      for (const u of units.slice(0, 6)) {
        const def = UNIT_DEFS[u.kind as UnitKind];
        const hpFrac = def ? Math.max(0, Math.round((u.hp / def.hp) * 100)) : 0;
        const stats = el('div', 'stat-block');
        const actions = el('div', 'detail-actions');
        stats.append(el('div', 'stat-row', `${def?.name ?? u.kind} · ${hpFrac}%`));
        // Veterancy (Phase 1): rank + chevrons + XP progress, e.g.
        // "Veteran ▲▲ · 320/800 XP". Uses the 'stat-row' class — the
        // detail-view stat line (command-menu rebuild, 2026-10-01).
        stats.append(el('div', 'stat-row', vetXpLine(u)));
        // Naval-building model (2026-10-01): the drydock badge — the
        // unit is damaged and sitting inside a same-side shipyard's
        // repair radius (sim/shipyardRepair.ts). Uses the 'stat-row'
        // class; the ur: digest segment covers the rendered value
        // (AD11).
        if (isShipUnderRepair(world, u)) {
          stats.append(el('div', 'stat-row', loc(sel.underRepair)));
        }
        // Fun-audit C2a (engineer triage, 2026-10-02): the engineer's
        // job line — static kind copy, covered by the `u:` selection
        // segment (AD11), uses the 'stat-row' class.
        if (u.kind === 'engineer') {
          stats.append(el('div', 'stat-row', loc(sel.engineerAura)));
        }
        // Grand-expansion Phase 7 (intel): a selected owned spy shows
        // its mission state ("Infiltrating Power Plant · 12s left",
        // "Exposed — visible to all enemies · 24s left"). Uses the
        // 'stat-row' class; the iu: digest segment covers the rendered
        // value (AD11).
        if (u.owner === HUMAN_PLAYER_ID && isSpyUnit(u)) {
          stats.append(el('div', 'stat-row', spyMissionLine(world, u)));
        }
        // Phase 3 (logistics): fuel/ammo bars for tracked units, the
        // cargo line + field-service toggles for supply units, and the
        // Resupply button. Bars use the 'sel-bar' classes (registered in
        // HUD_PANEL_BRANCHES); every value is digested by the uf:/us:
        // segments (AD11) — the panel rebuilds exactly when a bar or
        // toggle would render differently.
        if (def !== undefined && isTrackedUnit(def)) {
          const lg = STRINGS.logistics;
          stats.append(supplyBar(`${loc(lg.fuelLabel)} ${Math.round(fuelFracOf(def, u) * 100)}%`, fuelFracOf(def, u)));
          stats.append(supplyBar(`${loc(lg.ammoLabel)} ${Math.round(ammoFracOf(def, u) * 100)}%`, ammoFracOf(def, u)));
          if (isLowSupply(def, u)) {
            // Command-menu rebuild (2026-10-01): the warning glyph is
            // gone (no emoji/symbols in UI) — the warning text says it.
            stats.append(el('div', 'stat-row', loc(lg.lowSupplyWarning)));
          }
          // Final-review R5 (2026-10-01): Emergency refuel — the
          // stranded-aircraft affordance. A fossil-fuel aircraft with an
          // empty tank can't fly to a depot, so this button airdrops a
          // fuel bladder (+30% fuel, costs funds) through the sim's
          // `emergencyRefuel` command. Disabled with the named blocker
          // — never a dead button. The er: digest segment rebuilds the
          // panel when availability changes (see paletteDigest.ts).
          if (u.owner === HUMAN_PLAYER_ID && u.domain === 'air' && def.fuelType === 'fossil') {
            const erBlock = emergencyRefuelBlockReason(world, u);
            const er = document.createElement('button');
            er.className = 'sel-action';
            er.textContent = loc(lg.emergencyRefuelVerb);
            if (erBlock === null) {
              er.addEventListener('click', () => this.actions.onEmergencyRefuel(u.id));
            } else {
              er.disabled = true;
              er.title = erBlock;
            }
            actions.append(er);
          }
        }
        if (def !== undefined && isSupplyUnit(def) && u.owner === HUMAN_PLAYER_ID) {
          const lg = STRINGS.logistics;
          // Sea-logistics Half B (2026-10-01): cargo holds as bars —
          // one per hold the def has ("Cargo fuel 120/400"), replacing
          // the old text cargo line.
          const fuelHoldCap = def.cargoFuelCapacity ?? 0;
          if (fuelHoldCap > 0) {
            stats.append(
              supplyBar(
                `${loc(lg.cargoLabel)} ${loc(lg.fuelLabel).toLowerCase()} ${Math.floor(cargoFuelOf(u))}/${fuelHoldCap}`,
                cargoFuelOf(u) / fuelHoldCap,
              ),
            );
          }
          const ammoHoldCap = def.cargoAmmoCapacity ?? 0;
          if (ammoHoldCap > 0) {
            stats.append(
              supplyBar(
                `${loc(lg.cargoLabel)} ${loc(lg.ammoLabel).toLowerCase()} ${Math.floor(cargoAmmoOf(u))}/${ammoHoldCap}`,
                cargoAmmoOf(u) / ammoHoldCap,
              ),
            );
          }
          const matHoldCap = def.cargoMaterialsCapacity ?? 0;
          if (matHoldCap > 0) {
            stats.append(
              supplyBar(
                `${loc(lg.cargoLabel)} ${loc(lg.materialsLabel).toLowerCase()} ${Math.floor(cargoMaterialsOf(u))}/${matHoldCap}`,
                cargoMaterialsOf(u) / matHoldCap,
              ),
            );
          }
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
          actions.append(toggleRow);
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
          actions.append(rs);
          // Sea-logistics Half B (2026-10-01): Load / Unload cargo. The
          // UI proposes the nearest naval supply point (reload point on
          // water); the sim validates range, stocks, and headroom and
          // rejects loudly. The disabled reason names the blocker —
          // never a dead button, never a silent no-op.
          const navalDepot = nearestNavalDepot(world, terrain, u);
          for (const mode of ['load', 'unload'] as const) {
            const cblock = cargoBlockReason(world, terrain, u, navalDepot, mode);
            const cb = document.createElement('button');
            cb.className = 'sel-action';
            cb.textContent = loc(mode === 'load' ? lg.loadCargoVerb : lg.unloadCargoVerb);
            if (cblock === null && navalDepot !== null) {
              const depId = navalDepot.id;
              cb.addEventListener('click', () =>
                mode === 'load'
                  ? this.actions.onLoadCargo(u.id, depId)
                  : this.actions.onUnloadCargo(u.id, depId),
              );
            } else {
              cb.disabled = true;
              cb.title = cblock ?? loc(lg.noNavalDepotReason);
            }
            actions.append(cb);
          }
        }
        // Civilian sea trade (Half A, 2026-10-01): the sea-route
        // assignment for civilian cargo vessels — the route line (or
        // the unassigned prompt), the cargo hold line, and per-route
        // Assign / Unassign buttons. The sim validates every assignment
        // loudly, so the buttons always act. Uses the shared stat-row /
        // sel-action classes; digest-covered by the sr: segment (AD11).
        if (u.owner === HUMAN_PLAYER_ID && def !== undefined && isSeaTradeShip(u.kind)) {
          const stm = STRINGS.menuTabs;
          stats.append(el('div', 'stat-row', seaTradeCargoLine(u)));
          const route = seaRouteOfUnit(world, u);
          if (route !== undefined) {
            stats.append(
              el(
                'div',
                'stat-row',
                fillLoc(stm.seaTradeShipRoute, {
                  from: this.seaHarborName(world, route.from),
                  to: this.seaHarborName(world, route.to),
                  policy: route.policy,
                }),
              ),
            );
            const ub = document.createElement('button');
            ub.className = 'sel-action';
            ub.textContent = loc(stm.seaTradeUnassign);
            ub.addEventListener('click', () =>
              this.actions.onAssignSeaRoute(u.id, 0),
            );
            actions.append(ub);
          } else {
            const unassignedRoutes = seaRoutesOf(world, HUMAN_PLAYER_ID);
            if (unassignedRoutes.length === 0) {
              stats.append(el('div', 'stat-row', loc(stm.seaTradeNoRoutesForShip)));
            } else {
              stats.append(el('div', 'stat-row', loc(stm.seaTradeShipNoRoute)));
              for (const r of unassignedRoutes) {
                const ab = document.createElement('button');
                ab.className = 'sel-action';
                ab.textContent = `${loc(stm.seaTradeAssign)}: ${this.seaHarborName(world, r.from)} ↔ ${this.seaHarborName(world, r.to)} (${r.policy})`;
                ab.addEventListener('click', () =>
                  this.actions.onAssignSeaRoute(u.id, r.id),
                );
                actions.append(ab);
              }
            }
          }
        }
        // Grand-expansion Phase 5 (hangar/carrier shelter): the shelter
        // line + Embark / Park / Launch buttons for aircraft, and the
        // wing manifest for carriers. Sheltered aircraft are invisible on
        // the map (render skips them), so the carrier/hangar panels list
        // their sheltered aircraft with Launch buttons — otherwise a
        // parked aircraft could never be launched from the UI. Every
        // value is digest-covered by the ue: / ew: segments (AD11).
        // Stat lines use 'stat-row', buttons live in the per-unit
        // 'detail-actions' row (command-menu rebuild, 2026-10-01).
        if (u.owner === HUMAN_PLAYER_ID) {
          const sheltered = shelterLine(world, u);
          if (sheltered !== '') {
            stats.append(el('div', 'stat-row', sheltered));
            const launch = document.createElement('button');
            launch.className = 'sel-action';
            launch.textContent = loc(sel.launchVerb);
            launch.addEventListener('click', () => this.actions.onLaunchAircraft(u.id));
            actions.append(launch);
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
            actions.append(eb);
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
            actions.append(bb);
          }
          // Carrier wing manifest: carriers train EMPTY (the wing fills
          // only through embark orders), so the panel lists the embarked
          // aircraft with per-aircraft Launch buttons.
          const wing = wingLine(world, u);
          if (wing !== '') {
            stats.append(el('div', 'stat-row', wing));
            for (const w of embarkedAircraft(world, u.id)) {
              const wdef = UNIT_DEFS[w.kind as UnitKind];
              // Command-menu rebuild (2026-10-01): the ✈ glyph is gone
              // (no emoji/symbols in UI) — the row is the aircraft name.
              const row = el('div', 'stat-row', wdef?.name ?? w.kind);
              stats.append(row);
              const wl = document.createElement('button');
              wl.className = 'sel-action';
              wl.textContent = loc(sel.launchVerb);
              wl.addEventListener('click', () => this.actions.onLaunchAircraft(w.id));
              actions.append(wl);
            }
          }
        }
        panel.append(stats);
        if (actions.hasChildNodes()) panel.append(actions);
      }
      if (units.length > 6) {
        const more = el('div', 'stat-block');
        more.append(el('div', 'stat-row', `… +${units.length - 6} more`));
        panel.append(more);
      }
      const stopRow = el('div', 'detail-actions');
      const stopBtn = document.createElement('button');
      stopBtn.className = 'sel-action';
      stopBtn.textContent = sel.stop;
      stopBtn.addEventListener('click', () => this.actions.onStopSelection());
      stopRow.append(stopBtn);
      panel.append(stopRow);
      // Entity portraits (2026-10-01): the detail hero's atlas overlay.
      this.refreshPortraits();
      return;
    }

    const b = world.city.buildings.find((x) => x.id === selection.buildingId);
    if (b) {
      // Command-menu rebuild (2026-10-01): the detail view — Back to
      // the tab menu, the header (icon + name), the stat block, and the
      // action row (Demolish arms the demolish tool). All values keep
      // their digest segments (b:/bs:/bl:/bu:/bq:/bv:/bo:/bh:/bw:); the
      // new detail classes are claimed by the 'selection-building'
      // digest branch.
      panel.append(this.detailBackEl());
      panel.append(this.detailHeaderEl(buildingIcon(b.kind), buildingName(b.kind), b.kind));
      const stats = el('div', 'stat-block');
      stats.append(
        el('div', 'stat-row', b.operational ? loc(sel.operational) : loc(sel.notOperational)),
      );
      // Final-review R2 (2026-10-01): structural HP — buildings are
      // destructible now (C3), so the selection panel shows how much
      // damage the building has taken. Uses the 'stat-row' class (the
      // detail-view stat line); digest-covered by the bw: segment (AD11).
      // Always shown: an enemy army can siege any building, finished or
      // not.
      const bdef = BUILDING_DEFS[b.kind];
      const hpPct = Math.max(
        0,
        Math.round(((b.hp ?? bdef.hp) / (b.maxHp ?? bdef.hp)) * 100),
      );
      stats.append(el('div', 'stat-row', fillLoc(sel.hpLine, { hp: hpPct })));
      // Crew training level (economy.ts levels thriving buildings 1→3).
      stats.append(el('div', 'stat-row', fillLoc(sel.levelLine, { level: b.level })));
      // Phase 2 (utilities): power/water diagnosis for the selected
      // building — uses the 'stat-row' class; digest-covered by the bu:
      // segment.
      stats.append(el('div', 'stat-row', buildingUtilityLine(b)));
      // Phase 3 (logistics): the depot stock line for storage buildings
      // ("Ammo 42/150 · Fuel 200/250"); empty string (no div) otherwise.
      // Digest-covered by the bq: segment (AD11).
      const stock = depotStockLine(b);
      if (stock !== '') stats.append(el('div', 'stat-row', stock));
      // Workstream W (desirability): the land-value line for residential
      // buildings ("Land: Nice (64) · tax ×1.3") — uses the 'stat-row'
      // class; digest-covered by the bv: segment (AD11). The derived
      // model is per-owner and cached on structural change, so this is
      // free per frame. The model is the BUILDING owner's — the land
      // value a building taxes on is shaped by its owner's own
      // ordinances.
      const desirModel =
        terrain !== undefined ? getDesirabilityModel(terrain, world, b.owner) : undefined;
      const landLine = landValueLine(desirModel, b);
      if (landLine !== null) stats.append(el('div', 'stat-row', landLine));
      // Phase 4 (transport): the occupancy line ("Residents 12/50 ·
      // Workers 8/20") from the sim's buildingOccupancy() — uses the
      // 'stat-row' class; digest-covered by the bo: segment (AD11).
      // Hidden for buildings with neither residents nor workers
      // (military/utility).
      const occ = buildingOccupancy(world, b.id);
      if (occ !== null && (occ.residentCap > 0 || occ.workerCap > 0)) {
        stats.append(
          el(
            'div',
            'stat-row',
            fillLoc(sel.occupancyLine, {
              residents: occ.residents,
              residentCap: occ.residentCap,
              workers: occ.workers,
              workerCap: occ.workerCap,
            }),
          ),
        );
      }
      panel.append(stats);
      // The detail action row: parked-aircraft Launch buttons plus the
      // Demolish button (owned buildings only).
      const actions = el('div', 'detail-actions');
      // Grand-expansion Phase 5 (hangar/carrier shelter): the hangar
      // occupancy line + parked-aircraft manifest with per-aircraft
      // Launch buttons. Parked aircraft are invisible on the map (render
      // skips sheltered units), so this is the only way to launch them.
      // Stat rows use 'stat-row'; the bh: segment digests the parked
      // aircraft ids (AD11).
      const hl = hangarLine(b);
      if (hl !== '' && b.owner === HUMAN_PLAYER_ID) {
        const hangarBlock = el('div', 'stat-block');
        hangarBlock.append(el('div', 'stat-row', hl));
        for (const p of parkedAircraft(world, b.id)) {
          const pdef = UNIT_DEFS[p.kind as UnitKind];
          // Command-menu rebuild (2026-10-01): the ✈ glyph is gone (no
          // emoji/symbols in UI) — the row is the aircraft name.
          hangarBlock.append(el('div', 'stat-row', pdef?.name ?? p.kind));
          const pl = document.createElement('button');
          pl.className = 'sel-action';
          pl.textContent = loc(sel.launchVerb);
          pl.addEventListener('click', () => this.actions.onLaunchAircraft(p.id));
          actions.append(pl);
        }
        panel.append(hangarBlock);
      }
      // Civilian sea trade (Half A, 2026-10-01; naval-building
      // model, 2026-10-01): trade docks show the routes calling here
      // (per-route cancel) plus the ship-training buttons — the
      // peaceful-mode training path, since the Military tab (and its
      // Train palette) is hidden in peaceful worlds. Owned docks only
      // (the actions spend the player's funds). Uses the shared
      // stat-row / detail-actions / sel-action classes;
      // digest-covered by the sh: segment (AD11).
      if (isSeaTradeHarbor(b) && b.owner === HUMAN_PLAYER_ID) {
        const stm = STRINGS.menuTabs;
        const seaBlock = el('div', 'stat-block');
        seaBlock.append(el('div', 'stat-row', loc(stm.seaTradeHarborRoutes)));
        const calling = seaRoutesOf(world, HUMAN_PLAYER_ID).filter(
          (r) => r.from === b.id || r.to === b.id,
        );
        if (calling.length === 0) {
          seaBlock.append(el('div', 'stat-row', loc(stm.seaTradeNoHarborRoutes)));
        }
        for (const r of calling) {
          const rrow = el('div', 'detail-actions');
          rrow.append(
            el(
              'span',
              'stat-row',
              `${this.seaHarborName(world, r.from)} ↔ ${this.seaHarborName(world, r.to)} · ${seaRouteIncomeOf(world, r)}`,
            ),
          );
          const cb = document.createElement('button');
          cb.className = 'sel-action';
          cb.textContent = loc(stm.seaTradeCancel);
          cb.title = loc(stm.seaTradeCancel);
          cb.addEventListener('click', () => this.actions.onCancelSeaRoute(r.id));
          rrow.append(cb);
          seaBlock.append(rrow);
        }
        seaBlock.append(el('div', 'stat-row', loc(stm.seaTradeTrainShips)));
        const seaActions = el('div', 'detail-actions');
        // Cargo freighter first, fuel barge second (the
        // seaTradeShipKinds order); each button names the availability
        // blocker when locked, like the Train palette.
        for (const kind of seaTradeShipKinds()) {
          const av = unitAvailability(world, HUMAN_PLAYER_ID, kind);
          const tb = document.createElement('button');
          tb.className = 'sel-action';
          tb.textContent = `${unitName(kind)} · ${formatTrainCost(kind)}`;
          tb.title = trainTooltip(world, HUMAN_PLAYER_ID, kind);
          tb.disabled = !av.ok;
          tb.addEventListener('click', () => this.actions.onTrainUnit(kind));
          seaActions.append(tb);
        }
        seaBlock.append(seaActions);
        panel.append(seaBlock);
      }
      // Command-menu rebuild (2026-10-01): the Demolish button arms the
      // demolish tool for the selected building (the existing
      // onBuildTool('demolish') — the sim's demolish command validates,
      // and the HUD already surfaces it in Civilian → Tools). Owned
      // buildings only.
      if (b.owner === HUMAN_PLAYER_ID) {
        // Fun-audit C1 (production queues, 2026-10-02): the training
        // section — train buttons, the visible queue (progress +
        // per-entry cancel with full refund), pause/resume, and the
        // rally-point tool. Owned production buildings only.
        const tq = this.trainQueueSectionEl(world, b);
        if (tq !== null) panel.append(tq);
        const dem = document.createElement('button');
        dem.className = 'sel-action';
        dem.textContent = loc(sel.demolishVerb);
        dem.title = loc(sel.demolishTitle);
        dem.addEventListener('click', () => this.actions.onBuildTool('demolish'));
        actions.append(dem);
      }
      if (actions.hasChildNodes()) panel.append(actions);
      // A completed Research Lab opens the research panel (spec §8).
      if (b.kind === 'lab' && b.owner === HUMAN_PLAYER_ID && b.progress >= 1) {
        this.appendResearchPanel(panel, world);
      }
    }
    // Entity portraits (2026-10-01): the detail hero's atlas overlay.
    this.refreshPortraits();
  }

  /**
   * Fun-audit C1 (production queues, 2026-10-02): the selected
   * building's training section. Renders only for owned, completed
   * buildings that can produce at least one military kind:
   *  - train buttons (name + train time; locked ones name the blocker
   *    via trainAtBuildingAvailability — never a dead button);
   *  - the queue: each entry shows name + progress %, with a Cancel
   *    button (full refund);
   *  - pause / resume for the whole queue;
   *  - the rally-point tool + the rally status line.
   * Null for every other selection (the panel shows no train UI).
   * Digest-covered by the `tq:` segment (AD11).
   */
  private trainQueueSectionEl(world: World, b: BuildingRecord): HTMLElement | null {
    if (b.owner !== HUMAN_PLAYER_ID || b.progress < 1) return null;
    const kinds = producibleKinds(b.kind);
    if (kinds.length === 0) return null;
    const tq = STRINGS.trainQueue;
    const block = el('div', 'stat-block');
    block.append(el('div', 'stat-row', loc(tq.sectionTitle)));
    const trainRow = el('div', 'detail-actions');
    for (const kind of kinds) {
      const av = trainAtBuildingAvailability(world, HUMAN_PLAYER_ID, b.id, kind);
      const def = UNIT_DEFS[kind];
      const secs = def.trainSeconds ?? 8;
      const tb = document.createElement('button');
      tb.className = 'sel-action';
      tb.textContent = `${unitName(kind)} · ${fillLoc(tq.trainTime, { secs })}`;
      tb.title = trainTooltip(world, HUMAN_PLAYER_ID, kind);
      tb.disabled = !av.ok;
      tb.addEventListener('click', () => this.actions.onTrainUnitAtBuilding(kind, b.id));
      trainRow.append(tb);
    }
    block.append(trainRow);
    const q = b.trainQueue ?? [];
    if (q.length === 0) {
      block.append(el('div', 'stat-row', loc(tq.queueEmpty)));
    }
    q.forEach((entry, i) => {
      const total = trainTicksFor(entry.kind);
      const pct = Math.max(0, Math.min(100, Math.round((1 - entry.ticksLeft / total) * 100)));
      const row = el('div', 'detail-actions');
      row.append(el('span', 'stat-row', `${unitName(entry.kind)} · ${pct}%`));
      const bar = el('div', 'queue-bar');
      const fill = el('div', 'queue-fill');
      fill.style.width = `${pct}%`;
      bar.append(fill);
      row.append(bar);
      const cb = document.createElement('button');
      cb.className = 'sel-action';
      cb.textContent = loc(tq.cancelVerb);
      cb.title = loc(tq.cancelTitle);
      cb.addEventListener('click', () => this.actions.onCancelTrain(b.id, i));
      row.append(cb);
      block.append(row);
    });
    const ctrlRow = el('div', 'detail-actions');
    const pb = document.createElement('button');
    pb.className = 'sel-action';
    pb.textContent = loc(b.trainPaused === true ? tq.resumeVerb : tq.pauseVerb);
    pb.addEventListener('click', () => this.actions.onSetTrainPaused(b.id, !(b.trainPaused === true)));
    ctrlRow.append(pb);
    const rb = document.createElement('button');
    rb.className = 'sel-action';
    rb.textContent = loc(tq.setRallyVerb);
    rb.title = loc(tq.setRallyTitle);
    rb.addEventListener('click', () => this.actions.onSetRallyTool(b.id));
    ctrlRow.append(rb);
    block.append(ctrlRow);
    block.append(
      el(
        'div',
        'stat-row',
        b.rallyX !== undefined && b.rallyZ !== undefined ? loc(tq.rallySet) : loc(tq.rallyUnset),
      ),
    );
    return block;
  }

  /** Tabbed train palette: 6 tabs for the 96 units (spec §8 + Phase 4 S7 transport). */
  private appendTrainPanel(panel: HTMLElement, world: World): void {    const wrap = el('div', 'train-panel');
    wrap.append(el('div', 'hud-panel-title', loc(STRINGS.palettes.trainTitle)));
    wrap.append(this.buildTabBar(TRAIN_TABS, STRINGS.unitTabs, this.trainTab, (id) => {
      this.trainTab = id as TrainTabId;
    }));
    const grid = el('div', 'palette-grid');
    // B27: no `!` — TRAIN_TABS is a non-empty literal; unreachable.
    const trainFallback = TRAIN_TABS[0];
    if (trainFallback === undefined) throw new Error('hud: TRAIN_TABS is empty');
    const tab = TRAIN_TABS.find((t) => t.id === this.trainTab) ?? trainFallback;
    for (const kind of tab.kinds) {
      // Locked units stay visible but greyed, with the blocker named —
      // the same rule as spawn validation (age → building → cost).
      const av = unitAvailability(world, HUMAN_PLAYER_ID, kind);
      const b = document.createElement('button');
      b.className = `train-btn${av.ok ? '' : ' locked'}`;
      b.disabled = !av.ok;
      b.prepend(this.portraitThumbEl(kind, unitIcon(kind), CARD_PORTRAIT_BOX_PX));
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
   * Roadmap B11 (2026-10-02): the armed palette tool's status line —
   * the build-tool mirror of the airline/sea-trade armed lines. null
   * when no palette tool is armed. Digest-covered (ar:) so it appears
   * and clears with the arm/disarm.
   */
  private armedBuildToolLine(): string | null {
    const tool = this.buildToolArmed;
    if (tool === null) return null;
    const p = STRINGS.palettes;
    if (tool.startsWith('building:')) {
      const kind = tool.slice('building:'.length);
      const name = isUtilityBuildingKind(kind)
        ? utilityBuildingName(kind)
        : buildingName(kind as BuildingKind);
      return fillLoc(p.placingLine, { name });
    }
    const labelFor: Partial<Record<BuildTool, LocalizedString>> = {
      road: p.toolRoad,
      powerLine: p.toolPowerLine,
      waterPipe: p.toolWaterPipe,
      rail: p.toolRail,
      zoneR: p.toolZoneR,
      zoneC: p.toolZoneC,
      zoneI: p.toolZoneI,
      zoneA: p.toolZoneA,
      demolish: p.toolDemolish,
    };
    const ls = labelFor[tool];
    if (ls === undefined) return null;
    return fillLoc(p.toolArmedLine, { name: loc(ls) });
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
    // Roadmap B11 (2026-10-02): the armed building tool's persistent
    // status line (the tools-row tools' line lives in civilianToolsEl).
    if (this.buildToolArmed !== null && this.buildToolArmed.startsWith('building:')) {
      const line = this.armedBuildToolLine();
      if (line !== null) wrap.append(el('div', 'panel-status', line));
    }
    const grid = el('div', 'palette-grid');
    // B27: no `!` — the build tab list is non-empty; unreachable.
    const buildFallback = tabs[0];
    if (buildFallback === undefined) throw new Error('hud: build tab list is empty');
    const tab = tabs.find((t) => t.id === this.buildTab) ?? buildFallback;
    for (const kind of tab.kinds) {
      // Phase 2 (utilities): the new kinds live in ui/utilities.ts until
      // the sim registers them in BUILDING_DEFS — same visible greyed-out
      // rule, honest "not yet available" reason instead of silent failure.
      const isUtility = isUtilityBuildingKind(kind);
      const avail = isUtility
        ? utilityBuildingAvailability(world, HUMAN_PLAYER_ID, kind)
        : buildingAvailability(world, HUMAN_PLAYER_ID, kind as BuildingKind);
      const b = document.createElement('button');
      // Roadmap B11 (2026-10-02): the armed palette tool's card stays
      // highlighted while armed (the airline/sea-trade indicator
      // pattern) — the digest's ar: segment repaints it on arm/disarm.
      b.className = `build-btn${avail.ok ? '' : ' locked'}${this.buildToolArmed === `building:${kind}` ? ' armed' : ''}`;
      b.disabled = !avail.ok;
      b.prepend(this.portraitThumbEl(kind, buildingIcon(kind as BuildingKind), CARD_PORTRAIT_BOX_PX));
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
        const nameEl = el('span', 'research-name', upgradeDisplayName(world, HUMAN_PLAYER_ID, id));
        head.append(nameEl);
        if (st.state === 'researched') {
          head.append(el('span', 'research-done', loc(p.researchedTag)));
        }
        // Roadmap B9: level-scaled cost for repeatable upgrades (the
        // static def cost would show the wrong price past level 1).
        head.append(el('span', 'palette-cost', formatResearchCostFor(world, HUMAN_PLAYER_ID, id)));
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

  /** One-line transient feedback — queued, shown in turn. */
  toast(message: string): void {
    this.toastQueue.push(message);
  }

  /**
   * Roadmap B12 (minimap): repaint the tactical overview. The controller
   * calls this every frame from its updateHud closure; the widget itself
   * throttles repaints to 5 Hz and caches the terrain relief. The view
   * carries the camera target, yaw, and the ground extent the camera
   * currently sees (world units at the target plane).
   */
  updateMinimap(
    world: World,
    terrain: TerrainData | undefined,
    view: MinimapView,
    /** Fun-audit C3 (2026-10-02): visibility grid — the minimap honors the shroud. */
    fogCells?: Uint8Array | null,
  ): void {
    this.minimap?.render(world, terrain, view, fogCells ?? null);
  }

  /**
   * Fun-audit B4 (2026-10-02): refresh the rival-watch strip. The
   * caller (game.ts) owns the visibility gate — rivaled, non-peaceful,
   * non-campaign skirmishes only.
   */
  updateVictoryHud(world: World, visible: boolean): void {
    this.victoryHud.update(world, visible);
  }

  /**
   * Fun-audit Tier 4 (E1, 2026-10-02): refresh the envoy banner. The
   * banner shows only for the human player's own visits (the contract
   * module gates on owner) — called every frame from game.ts's
   * updateHud, write-on-change inside.
   */
  updateEnvoyBanner(world: World): void {
    this.envoyBanner.update(envoyBannerView(world, HUMAN_PLAYER_ID));
  }

  /**
   * Fun-audit Tier 4 (E2, 2026-10-02): refresh the luminary decision
   * card. The card shows only for the human player's own pending
   * decision (the contract module gates on owner) — called every frame
   * from game.ts's updateHud, write-on-change inside.
   */
  updateLuminaryCard(world: World): void {
    this.luminaryCard.update(luminaryCardView(world, HUMAN_PLAYER_ID));
  }

  /** Pump the toast queue (called from update(), every frame). */
  private pumpToasts(): void {    const msg = this.toastQueue.poll();
    if (msg === this.lastToastShown) return;
    this.lastToastShown = msg;
    if (msg === null) {
      this.toastEl.classList.remove('show');
    } else {
      this.toastEl.textContent = msg;
      this.toastEl.classList.add('show');
    }
  }

  private setText(key: string, text: string, target: HTMLElement | undefined): void {
    if (!target || this.lastText.get(key) === text) return;
    this.lastText.set(key, text);
    target.textContent = text;
  }

  /**
   * Roadmap B10: write a chip's net-rate suffix (text + pos/neg class),
   * write-on-change like setText — the topbar DOM is never rebuilt.
   */
  private setRate(key: string, rate: number, target: HTMLElement | undefined): void {
    if (!target) return;
    const text = formatFlowRate(rate);
    const tone = rate >= 0.05 ? 'hud-rate-pos' : rate <= -0.05 ? 'hud-rate-neg' : '';
    const memo = `${tone}|${text}`;
    if (this.lastText.get(key) === memo) return;
    this.lastText.set(key, memo);
    target.className = tone === '' ? 'hud-rate' : `hud-rate ${tone}`;
    target.textContent = text;
  }

  dispose(): void {
    document.getElementById('hud')?.remove();
  }
}
