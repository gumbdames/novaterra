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
 * NOVATERRA — ui/paletteDigest.ts — selection-panel content digest (pure).
 *
 * Responsibilities:
 *  - Compute a cheap string digest of everything the HUD selection panel
 *    renders (see hud.ts `updateSelection`): selection identity, the
 *    active main menu tab (workstream Y: Civilian/Military/Management)
 *    and its active sub-tab (command-menu rebuild, 2026-10-01:
 *    Civilian → Tools/Build/Airlines, Military →
 *    Train/Build/Superweapons, Management →
 *    Taxes/Focus/Cabinet/Ordinances/Intelligence/Trade/Research),
 *    the active train/build tabs, per-button availability, research
 *    states, the selected unit/building vitals, the Management tab's
 *    tax/focus/cabinet values, the trade-route list, and the
 *    peaceful-objectives progress
 *    (Phase 8 peaceful, workstream B: population, treasury, rival).
 *  - hud.ts rebuilds the panel only when this digest changes. The panel
 *    must stay node-stable across frames: recreating the palette buttons
 *    every sim tick broke real clicks — pointerdown and pointerup landed
 *    on different DOM nodes, so no click event ever fired and palette
 *    tabs/items were unclickable while the sim ran.
 *
 * Pure module: safe under Node/vitest. It mirrors the render branches in
 * hud.ts `updateSelection` — if a branch renders a value, the digest must
 * include it, or a visible change would not repaint.
 *
 * AD11 UI digest contract: HUD_PANEL_BRANCHES below is the single source
 * of truth enumerating every hud.ts panel branch. hud.ts consumes the
 * digest from this module; the contract test
 * (game/tests/ui.paletteDigest.test.ts) consumes the registry. A branch
 * that renders a dynamic value must contribute a digest segment
 * (digestLabels); the test asserts each label literally appears in
 * selectionDigest() output for a representative state, and scans hud.ts
 * for panel-building methods / DOM classes that are not registered here —
 * so a new panel (or a new rendered value) without digest coverage fails
 * the suite instead of shipping a stale panel.
 */

import type { World } from '../sim/world';
import type { TerrainData } from '../sim/terrain';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import { BUILDING_DEFS, ZoneType, getPlayer, buildingOccupancy } from '../sim/city';
import {
  buildingLandValue,
  buildingTaxMultiplier,
  getDesirabilityModel,
} from '../sim/desirability';
import { getMayor, getGeneral } from '../sim/delegation';
import { policiesPanelDigest } from './policies';
import type { Selection } from './selection';
import {
  TRAIN_TABS,
  UPGRADE_GROUPS,
  unitAvailability,
  buildingAvailability,
  upgradeAvailability,
  playerHasCompletedLab,
  type MenuTabId,
} from './palettes';
import { UPGRADE_DEFS, repeatableUpgradeLevel } from '../sim/upgrades';
import { HUMAN_PLAYER_ID, AI_PLAYER_ID } from './session';
import {
  allBuildTabs,
  buildingPowerDiag,
  buildingWaterDiag,
  isUtilityBuildingKind,
  utilityBuildingAvailability,
} from './utilities';
import type { BuildingKind, RoadClass } from '../sim/city';
import {
  ammoStockOf,
  fuelStockOf,
  fuelFracOf,
  ammoFracOf,
  cargoFuelOf,
  cargoAmmoOf,
  serviceTogglesOf,
  emergencyRefuelBlockReason,
} from './logistics';
// Grand-expansion Phase 5 (hangar/carrier shelter): the parked-aircraft
// manifest on building selections reads through the ui/hangars contract.
import { parkedAircraft } from './hangars';
// Grand-expansion Phase 5 (S5): the airline panel's route list + armed
// tool state are dynamic civilian-tab content, so the digest carries
// them (al: / aa:).
import { airlineRoutesOf } from './airports';
import { airlineRouteIncome, FLOW_RESOURCES, flowRate } from '../sim/economy';
// Civilian sea trade (Half A, 2026-10-01): the sea-trade UI contract
// module — the st:/sa:/sr:/sh: digest segments for the Trade section,
// the ship detail assignment, and the harbor detail section.
// Naval-building model (2026-10-01): isShipUnderRepair drives the
// unit detail panel's "Under repair" badge (ur: segment below).
import { isShipUnderRepair } from '../sim/shipyardRepair';
import {
  isSeaTradeHarbor,
  isSeaTradeShip,
  seaRoutesOf,
} from './seatrade';
// Grand-expansion Phase 7 (intel): the intel panel's counters, spy
// states, warnings, and rival airports (ia: / ir: / is: / iw: / ig:),
// plus the selected-spy mission line (iu:).
import {
  intelAirportsDigest,
  intelAssetsDigest,
  intelRatesDigest,
  intelSpiesDigest,
  intelWarningsDigest,
  spyUnitDigest,
} from './intel';
// Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
// the peaceful-objectives section (po:) reads the sim's pure progress
// helper — no DOM, safe in the digest.
import { peacefulStatus, peacefulScore } from '../sim/peaceful';
import { avgDesirabilityOf } from './peaceful';

/**
 * Digest of the selection panel's dynamic content. Stable when nothing
 * visible changed (so the panel is not rebuilt); different whenever the
 * panel would render differently.
 *
 * `terrain` is optional: when present, the building branch covers the
 * workstream-W land-value line exactly (score + tax multiplier); without
 * it (pre-sim / headless tests) the segment is the constant 'bv:x'.
 */
export function selectionDigest(
  world: World,
  selection: Selection,
  trainTab: string,
  buildTab: string,
  terrain?: TerrainData,
  // Workstream Y (3-tab menu): which main menu tab is active. The tab
  // bar is part of the panel, so the digest must move on a tab switch
  // (paletteDirty also forces it, but the digest is the rebuild key —
  // a branch that renders a value must digest it). Optional so existing
  // callers/tests keep compiling; defaults to the pre-restructure menu.
  menuTab: MenuTabId = 'civilian',
  // Phase 4 (transport): the road tool's selected class — the tools-row
  // branch highlights the active class button, so the digest must move
  // on a class switch. Optional so existing callers/tests keep
  // compiling; defaults to the sim's buildRoad default.
  roadClass: RoadClass = 'paved',
  // Grand-expansion Phase 5 (S5): the airline tool's armed endpoint.
  // undefined = the airline tool is not armed; null = armed, still
  // picking the first airport; a number = the armed first endpoint's
  // building id. Optional so existing callers/tests keep compiling.
  airlineArmedFrom: number | null | undefined = undefined,
  // Command-menu rebuild (2026-10-01): the active sub-tab of the active
  // main tab (Civilian: tools/build/airlines; Military:
  // train/build/superweapons; Management:
  // taxes/focus/cabinet/ordinances/intel/trade/research). The sub-tab
  // bar highlights it, so the digest must move on a sub-tab switch.
  // Optional so existing callers/tests keep compiling.
  subTab: string = 'tools',
  // Civilian sea trade (Half A, 2026-10-01): the sea-route tool's armed
  // state — the airline tool's mirror (aa:). undefined = not armed;
  // null endpoints = still picking that harbor; a number = the picked
  // harbor's building id. Optional so existing callers/tests keep
  // compiling.
  seaTradeArmed: { from: number | null; to: number | null } | undefined = undefined,
  // Roadmap B11 (2026-10-02): the armed palette build tool ('building:<kind>',
  // 'road', 'powerLine', 'waterPipe', 'rail', 'zone*', 'demolish'; undefined =
  // none armed). The build cards' armed highlight + status line are rendered
  // content, so the digest must move on arm/disarm (the aa:/sa: pattern).
  // Optional so existing callers/tests keep compiling.
  buildToolArmed: string | null | undefined = undefined,
): string {
  const parts: string[] = [
    `u:${selection.unitIds.join(',')}`,
    `b:${selection.buildingId}`,
    `tt:${trainTab}`,
    `bt:${buildTab}`,
    `mt:${menuTab}`,
    // The active main tab's sub-tab (mt: already carries the main tab).
    `sb:${subTab}`,
    // The armed palette build tool ('off' when disarmed).
    `ar:${buildToolArmed ?? 'off'}`,
  ];
  if (selection.unitIds.length > 0) {
    // Unit vitals (hp%) are the only per-tick mover in this branch.
    for (const id of selection.unitIds.slice(0, 6)) {
      const u = world.units.find((x) => x.id === id);
      const def = u !== undefined ? UNIT_DEFS[u.kind as UnitKind] : undefined;
      const hp =
        u !== undefined && def !== undefined
          ? Math.max(0, Math.round((u.hp / def.hp) * 100))
          : 'x';
      parts.push(`uh:${id}:${hp}`);
      // Veterancy (Phase 1): the panel renders rank + chevrons + XP per
      // unit, so the digest must move when xp/vetLevel do.
      parts.push(`uv:${id}:${u !== undefined ? `${u.vetLevel ?? 0}:${u.xp ?? 0}` : 'x'}`);
      // Phase 3 (logistics): the panel renders fuel/ammo bars for
      // tracked units, the cargo line for supply units, and the service
      // toggles. Fuel/ammo drain continuously — quantize to 5% steps so
      // the digest doesn't move (and rebuild the panel) every tick for a
      // fractional change the bars can't show; cargo and toggles are
      // chunky by nature. Always emitted (untracked units digest 20/20).
      if (u !== undefined && def !== undefined) {
        const fuelQ = Math.round(fuelFracOf(def, u) * 20);
        const ammoQ = Math.round(ammoFracOf(def, u) * 20);
        const cargoFQ = Math.floor(cargoFuelOf(u) / 5);
        const cargoAQ = Math.floor(cargoAmmoOf(u) / 5);
        parts.push(`uf:${id}:${fuelQ}:${ammoQ}:${cargoFQ}:${cargoAQ}`);
        const svc = serviceTogglesOf(u);
        parts.push(
          `us:${id}:${svc.repair ? 1 : 0}${svc.rearm ? 1 : 0}${svc.refuel ? 1 : 0}`,
        );
      } else {
        parts.push(`uf:${id}:x`);
        parts.push(`us:${id}:x`);
      }
      // Final-review R5 (2026-10-01): the Emergency refuel button's
      // enabled state. er: = 1 exactly when the panel renders an
      // enabled button (the sim would accept the order), 0 when it
      // renders disabled with the block reason. Always emitted — it
      // covers the stranded exactness the 5%-quantized uf: fuel level
      // can't (fuel 1 vs 0) and player funds, which no segment tracks.
      parts.push(
        `er:${id}:${u !== undefined && emergencyRefuelBlockReason(world, u) === null ? 1 : 0}`,
      );
      // Grand-expansion Phase 5 (hangar/carrier shelter): the panel
      // renders the shelter line + Embark/Park/Launch buttons per
      // aircraft, and the carrier wing manifest. ue: carries the
      // aircraft's shelter state (f = free, w<id> = embarked on carrier
      // id, h<id> = parked in building id) so the panel repaints when a
      // button set would change; ew: carries the carrier's wing
      // occupancy as embarked aircraft ids (x for non-carriers, which
      // render no wing). Always emitted, like uf:/us:.
      if (u !== undefined) {
        const e = u.embarkedOn ?? 0;
        const h = u.hangarBuildingId ?? 0;
        parts.push(`ue:${id}:${e > 0 ? `w${e}` : h > 0 ? `h${h}` : 'f'}`);
        const cap = UNIT_DEFS[u.kind as UnitKind]?.wingCapacity ?? 0;
        if (cap > 0) {
          const wingIds = world.units
            .filter((x) => (x.embarkedOn ?? 0) === id && x.hp > 0)
            .map((x) => x.id)
            .sort((a, b) => a - b);
          parts.push(`ew:${id}:${wingIds.join(',')}`);
        } else {
          parts.push(`ew:${id}:x`);
        }
      } else {
        parts.push(`ue:${id}:x`);
        parts.push(`ew:${id}:x`);
      }
      // Grand-expansion Phase 7 (intel): a selected owned spy shows its
      // mission state line ("Infiltrating Power Plant · 12s left").
      // iu: carries the displayed state code (x when the panel renders
      // no intel line), always emitted like ue:/ew:.
      parts.push(spyUnitDigest(world, id, u, HUMAN_PLAYER_ID));
      // Civilian sea trade (Half A, 2026-10-01): the ship detail panel
      // renders the route assignment, the cargo hold line, and
      // per-route Assign buttons. sr: carries the assigned route id +
      // floored cargo holds (chunky by nature — the display shows
      // integers, so the digest moves exactly when a rendered number
      // would); the player's route set (the Assign button list) is
      // covered by st: in the same digest string. Always emitted
      // ('sr:<id>:x' for non-trade ships, which render no sea line).
      if (u !== undefined && isSeaTradeShip(u.kind)) {
        parts.push(
          `sr:${id}:${u.seaRouteId ?? 0}:${Math.floor(u.cargoFuel)}:${Math.floor(u.cargoMaterials ?? 0)}`,
        );
      } else {
        parts.push(`sr:${id}:x`);
      }
      // Naval-building model (2026-10-01): the panel renders the "Under
      // repair" badge for a damaged sea unit inside a same-side
      // shipyard's repair radius (sim/shipyardRepair.ts). ur: carries
      // the badge state (1 = badge rendered, 0 = not) so the panel
      // repaints exactly when the line would appear/disappear. Always
      // emitted.
      parts.push(`ur:${id}:${u !== undefined && isShipUnderRepair(world, u) ? 1 : 0}`);
    }
    if (selection.unitIds.length > 6) parts.push(`um:${selection.unitIds.length}`);
    return parts.join('|');
  }
  const b =
    selection.buildingId !== null
      ? world.city.buildings.find((x) => x.id === selection.buildingId)
      : undefined;
  if (b !== undefined) {
    // bs: kind + owner (the lab research panel is owner-gated) +
    // operational + completed. bl: crew training level 1..3 (the panel
    // renders "Level 2/3" — economy.ts levels thriving buildings).
    parts.push(
      `bs:${b.kind}:${b.owner}:${b.operational ? 1 : 0}:${b.progress >= 1 ? 1 : 0}`,
    );
    parts.push(`bl:${b.level ?? 1}`);
    // Final-review R2 (2026-10-01): the panel renders the structural HP
    // line ("HP 73%") for every selected building, so the digest must
    // move when the HP changes. Integer precision matches the display
    // exactly — the digest moves if and only if the rendered number
    // would. Always emitted.
    const bdef = BUILDING_DEFS[b.kind];
    const bwPct = Math.max(
      0,
      Math.round(((b.hp ?? bdef.hp) / (b.maxHp ?? bdef.hp)) * 100),
    );
    parts.push(`bw:${bwPct}`);
    // Phase 2 (utilities): the panel renders the power/water diagnosis
    // line for every selected building, so the digest must move when
    // either diagnosis does. Always emitted (pre-sim fallback is the
    // legacy powered/watered flags), so the branch's representative
    // state covers it.
    parts.push(`bu:${buildingPowerDiag(b)}:${buildingWaterDiag(b)}`);
    // Phase 3 (logistics): the panel renders the depot stock line
    // ("Ammo 42/150 · Fuel 200/250") for storage buildings. Integer
    // precision matches the display exactly — the digest moves if and
    // only if the rendered numbers would. Always emitted (0/0 for
    // non-depots).
    parts.push(`bq:${Math.floor(ammoStockOf(b))}:${Math.floor(fuelStockOf(b))}`);
    // Workstream W (desirability): the panel renders the land-value line
    // ("Land: Nice (64) · tax ×1.3") for residential buildings. The
    // segment carries the rendered score + tax multiplier, so the digest
    // moves if and only if the line would. Constant 'bv:x' for
    // non-residential buildings and when no terrain is available.
    const def = BUILDING_DEFS[b.kind];
    if (terrain !== undefined && def !== undefined && def.zone === ZoneType.RESIDENTIAL) {
      // Grand-expansion Phase 8 (civilian ordinances, workstream E):
      // the model is per-owner — the digest carries the BUILDING
      // owner's land values (the same map the selection panel shows).
      const model = getDesirabilityModel(terrain, world, b.owner);
      const score = Math.round(buildingLandValue(model, b));
      parts.push(`bv:${score}:${buildingTaxMultiplier(model, b)}`);
    } else {
      parts.push('bv:x');
    }
    // Phase 4 (transport): the panel renders the occupancy line
    // ("Residents 12/50 · Workers 8/20") for buildings with resident or
    // worker caps. The sim's buildingOccupancy() reads residents/workers;
    // always emitted (0/0 caps for buildings without them) so the
    // representative state covers it.
    const occ = buildingOccupancy(world, b.id);
    parts.push(
      `bo:${occ?.residents ?? 0}/${occ?.residentCap ?? 0}:${occ?.workers ?? 0}/${occ?.workerCap ?? 0}`,
    );
    // Grand-expansion Phase 5 (hangar/carrier shelter): the panel
    // renders the hangar occupancy line + parked-aircraft manifest
    // (each with a Launch button) for buildings with hangars. bh:
    // carries the parked aircraft ids (x when the building has no
    // hangars) so the panel repaints exactly when the parked set
    // changes. Always emitted.
    const slots = b.hangars;
    if (slots !== undefined && slots.length > 0) {
      const parkedIds = parkedAircraft(world, b.id).map((u) => u.id);
      parts.push(`bh:${parkedIds.join(',')}`);
    } else {
      parts.push('bh:x');
    }
    // Civilian sea trade (Half A, 2026-10-01): the trade-dock detail
    // panel renders the routes calling here (each with a Cancel
    // button) and the two ship-training buttons with the Train-palette
    // availability semantics. sh: carries the calling route ids + the
    // two kinds' availability bits ('sh:x' for non-docks and
    // non-owned docks, which render no sea section). Always emitted.
    if (isSeaTradeHarbor(b) && b.owner === HUMAN_PLAYER_ID) {
      const calling = seaRoutesOf(world, HUMAN_PLAYER_ID)
        .filter((r) => r.from === b.id || r.to === b.id)
        .map((r) => r.id)
        .sort((a, b2) => a - b2);
      const freighter = unitAvailability(world, HUMAN_PLAYER_ID, 'cargoFreighter').ok ? 1 : 0;
      const barge = unitAvailability(world, HUMAN_PLAYER_ID, 'fuelBarge').ok ? 1 : 0;
      parts.push(`sh:${calling.join(',')}:${freighter}${barge}`);
    } else {
      parts.push('sh:x');
    }
  } else {
    // No selection: the train/build palettes render the active tab's
    // buttons; only each button's availability can move per tick.
    const trainTabDef = TRAIN_TABS.find((t) => t.id === trainTab) ?? TRAIN_TABS[0]!;
    for (const kind of trainTabDef.kinds) {
      parts.push(`ta:${kind}:${unitAvailability(world, HUMAN_PLAYER_ID, kind).ok ? 1 : 0}`);
    }
    // Phase 4 (transport): the road-class selector sits in the Civilian
    // tools row (no selection, civilian tab) — the digest carries the
    // selected class so the active-button highlight repaints on change.
    if (menuTab === 'civilian') {
      parts.push(`rc:${roadClass}`);
      // Grand-expansion Phase 5 (S5): the airline panel renders the
      // player's routes (endpoints + the exact income the sim pays) and
      // the armed "New route…" status. al: moves when routes change or a
      // route's income does (terminal build-out); aa: moves when the
      // two-click gesture arms/disarms or the first endpoint is picked.
      // Both always emitted (empty al: when there are no routes) so the
      // representative state covers them.
      const routes = airlineRoutesOf(world, HUMAN_PLAYER_ID);
      parts.push(
        `al:${routes.map((r) => `${r.id}.${r.from}.${r.to}.${airlineRouteIncome(world, r).toFixed(1)}`).join(',')}`,
      );
      parts.push(
        `aa:${airlineArmedFrom === undefined ? 'off' : airlineArmedFrom === null ? 'pick' : airlineArmedFrom}`,
      );
    }
    const buildTabDef = allBuildTabs().find((t) => t.id === buildTab) ?? allBuildTabs()[0]!;
    for (const kind of buildTabDef.kinds) {
      // Phase 2 (utilities): the new kinds digest through their own
      // availability mirror until the sim registers them.
      const ok = isUtilityBuildingKind(kind)
        ? utilityBuildingAvailability(world, HUMAN_PLAYER_ID, kind).ok
        : buildingAvailability(world, HUMAN_PLAYER_ID, kind as BuildingKind).ok;
      parts.push(`ba:${kind}:${ok ? 1 : 0}`);
    }
    // Workstream Y (3-tab menu): the Management tab renders the tax
    // rates, the city-focus status, and the cabinet (mayor/general)
    // status — all dynamic values the panel shows, so the digest must
    // carry them. Emitted only when the Management content actually
    // renders (no selection: a unit/building selection replaces the tab
    // content, exactly like the palettes).
    if (menuTab === 'management') {
      const player = getPlayer(world.city, HUMAN_PLAYER_ID);
      const rates = player?.taxRates ?? [0, 0, 0];
      parts.push(`tx:${rates.map((r) => r.toFixed(2)).join(',')}`);
      parts.push(`ms:${player?.specialization ?? 'balanced'}`);
      const mayor = getMayor(world, HUMAN_PLAYER_ID);
      parts.push(`mg:m:${mayor !== undefined ? `${mayor.policy}:${mayor.buildPolicy}` : 'x'}`);
      const general = getGeneral(world, HUMAN_PLAYER_ID);
      parts.push(
        `mg:g:${general !== undefined ? `${general.stance}:${general.unitIds.length}` : 'x'}`,
      );
      // Grand-expansion Phase 7 (intel): the intel panel renders the
      // asset counters (+ accrual rates), the spies' mission states,
      // the active warnings, and the rival airports — all in the
      // Management tab, so the digest carries them only there. Always
      // emitted (counters read 0 pre-intel), so the representative
      // state covers every label.
      parts.push(intelAssetsDigest(world, HUMAN_PLAYER_ID));
      parts.push(intelRatesDigest(world, HUMAN_PLAYER_ID));
      parts.push(intelSpiesDigest(world, HUMAN_PLAYER_ID));
      parts.push(intelWarningsDigest(world, HUMAN_PLAYER_ID));
      parts.push(intelAirportsDigest(world, HUMAN_PLAYER_ID));
      // Grand-expansion Phase 8 (peaceful mode, workstream B,
      // 2026-09-30): the peaceful-objectives section renders only in
      // peaceful worlds on the Management tab — the digest carries the
      // Final-review (2026-10-01): peaceful mode is endless — the
      // panel shows the player's status only (population, treasury
      // flag). The old builder's-race victory is gone, so there is no
      // rival line and no target. 'po:x' when the section does not
      // render, so the branch's representative state (non-peaceful)
      // covers the label.
      if (world.peaceful === true) {
        const status = peacefulStatus(world, HUMAN_PLAYER_ID);
        parts.push(`po:${status.population}:${status.treasuryOk ? 1 : 0}`);
        // Roadmap B1 (2026-10-02): the peaceful city score renders in
        // the same section, so it gets its own additive segment (ps:)
        // rather than changing po:'s meaning. The desirability input
        // needs terrain — absent (headless) it reads 0, matching the
        // panel, which receives the same optional terrain.
        const score = peacefulScore(
          world,
          HUMAN_PLAYER_ID,
          avgDesirabilityOf(terrain, world, HUMAN_PLAYER_ID),
        );
        parts.push(`ps:${score.score}`);
      } else {
        parts.push('po:x');
        parts.push('ps:x');
      }
      // Grand-expansion Phase 8 (civilian ordinances, workstream E,
      // 2026-09-30): the City ordinances section renders on the
      // Management tab in all worlds — the digest carries the toggle +
      // funding states (ui/policies.ts `policiesPanelDigest`), so the
      // panel repaints exactly when a rendered row would change.
      parts.push(policiesPanelDigest(world, HUMAN_PLAYER_ID));
      // Command-menu rebuild (2026-10-01): the Management tab's Trade
      // sub-tab lists the player's trade routes. Always emitted under
      // Management (like tx:/ms:/mg:) so the representative state
      // covers the label; the panel repaints when a route appears or
      // disappears (establish/cancel orders).
      parts.push(
        `tr:${world.city.tradeRoutes
          .filter((r) => r.owner === HUMAN_PLAYER_ID)
          .map((r) => r.partner)
          .sort((a, b) => a - b)
          .join(',')}`,
      );
      // Civilian sea trade (Half A, 2026-10-01): the Trade sub-tab's
      // sea-trade section lists the player's sea routes (id.from.to.
      // policy each — the panel renders the endpoints + income line);
      // sa: carries the two-click gesture's armed state ('off' / pick
      // first / first id / first+second ids). Both always emitted under
      // Management so the representative state covers the labels.
      const seaRoutes = seaRoutesOf(world, HUMAN_PLAYER_ID);
      parts.push(
        `st:${seaRoutes.map((r) => `${r.id}.${r.from}.${r.to}.${r.policy}`).join(',')}`,
      );
      parts.push(
        `sa:${seaTradeArmed === undefined ? 'off' : `${seaTradeArmed.from ?? 'pick'}.${seaTradeArmed.to ?? 'pick'}`}`,
      );
      // Roadmap B10 (economy legibility, 2026-10-02): the Economy
      // sub-tab renders every stockpile's stock + net flow rate — the
      // digest carries the same values (floored stock, one-decimal
      // rate, FLOW_RESOURCES order) so the panel repaints exactly when
      // a rendered row would change. Always emitted under Management
      // (like tx:/ms:/mg:) so the representative state covers the
      // label.
      parts.push(
        `ec:${FLOW_RESOURCES.map(
          (r) => `${Math.floor(player?.[r] ?? 0)}:${flowRate(world, HUMAN_PLAYER_ID, r).toFixed(1)}`,
        ).join(',')}`,
      );
    }
  }
  // The research panel is listed whenever the player owns a completed
  // lab (no selection, or the lab itself selected).
  if (playerHasCompletedLab(world, HUMAN_PLAYER_ID)) {
    parts.push('lab:1');
    for (const group of UPGRADE_GROUPS) {
      for (const id of group.ids) {
        parts.push(`rs:${id}:${upgradeAvailability(world, HUMAN_PLAYER_ID, id).state}`);
        // Roadmap B9 (AD11): repeatable upgrades re-render (name + cost)
        // per level — the level joins the rebuild key as an ADDITIVE
        // segment so the panel refreshes the moment a level lands.
        if (UPGRADE_DEFS[id].repeatable === true) {
          parts.push(`rslvl:${id}:${repeatableUpgradeLevel(world, HUMAN_PLAYER_ID, id)}`);
        }
      }
    }
  }
  return parts.join('|');
}

/**
 * One hud.ts panel branch, for the AD11 UI digest contract.
 */
export interface HudPanelBranch {
  /** Stable branch id, e.g. 'train-palette'. */
  id: string;
  /**
   * hud.ts renderer: the method that builds it, or 'updateSelection'
   * for the inline selection branches, or 'constructor' for panels built
   * once at construction.
   */
  renderedIn: string;
  /**
   * DOM class literals the branch creates (el()/className arguments as
   * written in hud.ts; template-literal classes by their static prefix,
   * e.g. 'train-btn' for `train-btn${...}`). The contract test scans
   * hud.ts and fails on any panel class not claimed here — claiming a
   * new branch forces the digest question to be answered.
   */
  domClasses: string[];
  /**
   * selectionDigest() segment labels this branch contributes. The
   * contract test asserts each label literally appears in digest output
   * for a representative state where the branch renders, so a declared
   * label that the digest never emits fails loudly.
   */
  digestLabels: string[];
  /**
   * Required exactly when digestLabels is empty: why no digest segment
   * is needed (fully static, write-on-change without rebuilds, or a
   * separate change key).
   */
  noDigestReason?: string;
}

/**
 * HOW TO ADD A PANEL (AD11 UI digest contract):
 *  1. Render it in hud.ts.
 *  2. Add every dynamic value it renders to selectionDigest() above
 *     (additive: new segments only — never change an existing segment's
 *     meaning, the digest doubles as the panel's rebuild key).
 *  3. Register the branch here: id, renderedIn (hud.ts method), the
 *     domClasses it creates, and the digestLabels it contributes — or a
 *     noDigestReason when the branch is truly static / never rebuilt.
 * The contract test (game/tests/ui.paletteDigest.test.ts) enforces all
 * three: unregistered hud.ts panel methods or DOM classes fail the
 * suite, and each digestLabels entry must really appear in digest output.
 */
export const HUD_PANEL_BRANCHES: readonly HudPanelBranch[] = [
  {
    id: 'topbar',
    renderedIn: 'constructor',
    domClasses: [
      'hud',
      'hud-topbar',
      'hud-chip',
      'hud-chip-label',
      'hud-chip-value',
      // Roadmap B10: the per-chip net-rate suffix (write-on-change
      // text + pos/neg tone class, like the chip values).
      'hud-rate',
      'hud-rate-pos',
      'hud-rate-neg',
      'hud-age',
      'hud-age-btn',
      'hud-spacer',
      'hud-speed',
      'hud-pause',
      'hud-util',
      'hud-logistics',
      'hud-airport',
      'hud-desirability',
      'hud-xray',
      'hud-grid',
      'hud-menu-btn',
    ],
    digestLabels: [],
    noDigestReason:
      'Built once in the constructor; per-frame updates are write-on-change ' +
      'text/property writes (setText) — nodes are never rebuilt, so no digest ' +
      'segment is needed. The utilities-overlay toggle (hud-util, Phase 2), ' +
      'the logistics-overlay toggle (hud-logistics, Phase 3), the ' +
      'desirability-overlay toggle (hud-desirability, workstream W), the ' +
      'x-ray toggle (hud-xray, Phase 4 RENDER workstream A), and the ' +
      'terrain-grid toggle (hud-grid, Phase 4 RENDER workstream A) flip ' +
      'their own active class on click via setUtilityOverlayActive / ' +
      'setLogisticsOverlayActive / setDesirabilityOverlayActive / ' +
      'setXrayActive / setGridActive. ' +
      'The three intel asset chips (Phase 7 intel: surveillance / ' +
      'operational / counter-intel) are built once in the constructor ' +
      'like the resource chips and refreshed by the same write-on-change ' +
      'setText path in update() — they never rebuild either. ' +
      'Invariant: never rebuild topbar DOM (the click-bug pattern).',
  },
  {
    id: 'advisor',
    renderedIn: 'updateAdvisor',
    domClasses: [
      'hud-advisor',
      'hud-panel-title',
      'hud-advisor-list',
      'advisor-item info',
      'advisor-item',
      'advisor-title',
      'advisor-detail',
    ],
    digestLabels: [],
    noDigestReason:
      'Rebuilt on its own change key (severity+title+detail, fixed 2026-09-30 in ' +
      'hud.ts updateAdvisor), not the selection digest. The key covers every ' +
      'rendered value, so the panel cannot go stale.',
  },
  {
    id: 'selection-empty',
    renderedIn: 'updateSelection',
    domClasses: ['hud-selection', 'sel-empty'],
    // mt: the workstream-Y main menu tab (Civilian/Military/Management) —
    // the tab bar is part of the panel, so a tab switch must rebuild.
    digestLabels: ['u:', 'b:', 'tt:', 'bt:', 'mt:'],
  },
  {
    id: 'selection-units',
    renderedIn: 'updateSelection',
    // Command-menu rebuild (2026-10-01): the detail view — detail-back
    // (Back to the tab menu), detail-header / detail-hero (the
    // selection "dossier photo") / detail-title, one stat-block of
    // stat-row lines per unit, and one detail-actions row per unit
    // holding the sel-action buttons.
    // sel-bar / sel-bar-fill / sel-bar-label: the Phase 3 fuel/ammo
    // bars; sel-toggle / sel-toggle-row: the Repair/Rearm/Refuel buttons
    // on supply units.
    // Entity portraits (2026-10-01): detail-hero + portrait (the atlas
    // CSS-sprite overlay) are decorative — no digest segment; the panel
    // rebuilds on content changes exactly as before and hud.ts patches
    // overlays in after each build.
    domClasses: [
      'detail-back',
      'detail-header',
      'detail-hero',
      'detail-title',
      'portrait',
      'stat-block',
      'stat-row',
      'detail-actions',
      'sel-action',
      'sel-bar',
      'sel-bar-fill',
      'sel-bar-label',
      'sel-toggle-row',
      'sel-toggle',
    ],
    // uf: fuel/ammo/cargo levels (Phase 3 logistics, 5% quantization);
    // us: the unit's field-service toggles.
    // ue: the aircraft's shelter state (Phase 5 hangar/carrier shelter:
    // f = free, w<id> = embarked on carrier id, h<id> = parked in
    // building id — the Embark/Park/Launch button set follows it);
    // ew: the carrier's wing occupancy as embarked aircraft ids
    // (x for non-carriers, which render no wing).
    // iu: the selected spy's mission-state line (Phase 7 intel:
    // b<secs> = burned, i<target>:<secs> = infiltrating,
    // e<target> = embedded, d<n> = inside rival coverage, h = hidden;
    // x when the panel renders no intel line).
    // er: the Emergency refuel button's enabled state (final-review
    // R5: 1 = the sim would accept the order, 0 = disabled with the
    // named block reason; always emitted).
    // sr: the civilian sea-trade assignment (Half A: route id + floored
    // cargo holds per selected unit; 'sr:<id>:x' for non-trade ships).
    // ur: the drydock "Under repair" badge state (naval-building
    // model, 2026-10-01: 1 = badge rendered, 0 = not; always emitted).
    digestLabels: ['u:', 'uh:', 'uv:', 'um:', 'uf:', 'us:', 'ue:', 'ew:', 'iu:', 'er:', 'sr:', 'ur:'],
  },
  {
    id: 'selection-building',
    renderedIn: 'updateSelection',
    // Command-menu rebuild (2026-10-01): the detail view — detail-back
    // (Back to the tab menu), detail-header / detail-hero (the
    // selection "dossier photo") / detail-title, the stat-block of
    // stat-row lines, the hangar manifest stat-block, and the
    // detail-actions row (parked-aircraft Launch buttons + the Demolish
    // button, all 'sel-action').
    // Entity portraits (2026-10-01): detail-hero + portrait (the atlas
    // CSS-sprite overlay) are decorative — no digest segment; the panel
    // rebuilds on content changes exactly as before and hud.ts patches
    // overlays in after each build.
    domClasses: [
      'detail-back',
      'detail-header',
      'detail-hero',
      'detail-title',
      'portrait',
      'stat-block',
      'stat-row',
      'detail-actions',
      'sel-action',
    ],
    // bu: power/water diagnosis line (Phase 2 utilities; the panel renders
    // it for every selected building via buildingUtilityLine).
    // bq: depot stock line (Phase 3 logistics; "Ammo 42/150 · Fuel 200/250").
    // bv: land-value line (workstream W; "Land: Nice (64) · tax ×1.3",
    // residential buildings only — 'bv:x' otherwise).
    // bo: occupancy line (Phase 4 transport; "Residents 12/50 ·
    // Workers 8/20", from the sim's buildingOccupancy()).
    // bh: hangar occupancy as parked aircraft ids (Phase 5
    // hangar/carrier shelter; 'bh:x' when the building has no hangars).
    // bw: structural HP percent (final-review R2; the panel renders
    // "HP 73%" for every selected building — always emitted).
    // sh: the civilian sea-trade harbor section (Half A: calling route
    // ids + the two ship-training availability bits; 'sh:x' when the
    // section does not render).
    digestLabels: ['b:', 'bs:', 'bl:', 'bu:', 'bq:', 'bv:', 'bo:', 'bh:', 'bw:', 'sh:'],
  },
  {
    id: 'train-palette',
    renderedIn: 'appendTrainPanel',
    domClasses: [
      'train-panel',
      'hud-panel-title',
      'palette-tabs',
      'palette-tab',
      'palette-grid',
      'train-btn',
      'palette-thumb',
      'palette-icon',
      'portrait',
      'palette-name',
      'palette-cost',
    ],
    // Entity portraits (2026-10-01): palette-thumb + portrait (the
    // atlas CSS-sprite overlay on card thumbnails) are decorative — no
    // digest segment; hud.ts patches overlays in after each build.
    digestLabels: ['tt:', 'ta:'],
  },
  {
    id: 'build-palette',
    renderedIn: 'appendBuildPanel',
    domClasses: [
      'build-panel',
      'hud-panel-title',
      'palette-tabs',
      'palette-tab',
      'palette-grid',
      'build-btn',
      'build-btn cancel',
      'palette-thumb',
      'palette-icon',
      'portrait',
      'palette-name',
      'palette-cost',
      // Roadmap B11 (2026-10-02): the armed palette tool's card
      // highlight ('armed' suffix on build-btn) + the armed status
      // line (panel-status, also claimed by airline-panel).
      'armed',
      'panel-status',
    ],
    // Entity portraits (2026-10-01): palette-thumb + portrait (the
    // atlas CSS-sprite overlay on card thumbnails) are decorative — no
    // digest segment; hud.ts patches overlays in after each build.
    // Roadmap B11 (2026-10-02): ar: — the armed palette tool (card
    // highlight + status line are rendered content).
    digestLabels: ['bt:', 'ba:', 'ar:'],
  },
  {
    id: 'tools-row',
    renderedIn: 'appendCivilianPanel',
    domClasses: [
      'palette-tools',
      'palette-zones',
      'palette-section-title',
      'palette-label',
      'build-btn',
      // Phase 4 (transport): the road-class picker next to the road
      // button, and the rail button in the networks group.
      'palette-class-row',
      'class-btn',
      // Roadmap B11 (2026-10-02): the armed tool button's highlight
      // ('armed' suffix on build-btn) + the armed status line.
      'armed',
      'panel-status',
    ],
    // Phase 4 (transport): the class picker highlights the selected
    // road class — the only dynamic value in the tools row.
    // Roadmap B11 (2026-10-02): ar: — the armed tool (button highlight
    // + status line are rendered content).
    digestLabels: ['rc:', 'ar:'],
  },
  {
    id: 'airline-panel',
    renderedIn: 'airlinePanelEl',
    // panel-section / panel-section-title: the Airlines section wrapper;
    // panel-row / panel-label: one row per route (endpoints + income);
    // panel-btn: the per-route cancel button + the "New route…" button;
    // panel-status: the empty-routes hint and the armed-gesture status
    // line (both also claimed by military-panel's domClasses — the
    // contract only requires each class be claimed somewhere).
    domClasses: [
      'panel-section',
      'panel-section-title',
      'panel-row',
      'panel-label',
      'panel-btn',
      'panel-status',
    ],
    // al: the player's routes (id.from.to.income each); aa: the armed
    // two-click gesture state (off / pick / first-endpoint id).
    digestLabels: ['al:', 'aa:'],
  },
  {
    id: 'menu-rail',
    renderedIn: 'menuRailEl',
    // menu-shell / menu-content: the rail + content flex layout of the
    // selection panel (command-menu rebuild, 2026-10-01 — replaces the
    // old top menu-tabs bar). palette-icon / palette-label are shared
    // with the tools row (claimed there too — the contract unions them).
    domClasses: [
      'menu-shell',
      'menu-rail',
      'menu-rail-btn',
      'menu-content',
      'palette-icon',
      'palette-label',
    ],
    // mt: the active main tab — the rail highlights it, so the digest
    // must move on a tab switch. Grand-expansion Phase 8 (peaceful,
    // workstream B): the tab LIST itself follows ui/peaceful.ts
    // `menuTabsForWorld` (Military hidden in peaceful worlds) — the
    // list is fixed at tick 0 with world.peaceful, so no digest segment
    // is needed for the list itself.
    digestLabels: ['mt:'],
  },
  {
    id: 'menu-subtabs',
    renderedIn: 'subTabBarEl',
    // The sub-tab pill row inside each main tab (command-menu rebuild,
    // 2026-10-01): Civilian → Tools/Build/Airlines, Military →
    // Train/Build/Superweapons, Management →
    // Taxes/Focus/Cabinet/Ordinances/Intelligence/Trade/Research.
    domClasses: ['sub-tabs', 'sub-tab'],
    // sb: the active sub-tab of the active main tab — the pill row
    // highlights it, so the digest must move on a sub-tab switch.
    digestLabels: ['sb:'],
  },
  {
    id: 'military-panel',
    renderedIn: 'appendMilitaryPanel',
    // panel-section / panel-section-title: the Orders and Superweapons
    // section wrappers; order-hint: the static attack/move/stop help
    // lines (plain text — the old ⚔/➤/■ glyphs were removed by the
    // command-menu rebuild, 2026-10-01); sw-card / sw-body / sw-name /
    // sw-desc: the superweapon cards (icon + name + requirement +
    // fire button). The train/build palettes embedded here are
    // digest-covered by their own branches.
    // Entity portraits (2026-10-01): palette-thumb + portrait (the
    // atlas CSS-sprite overlay on the superweapon card thumbnails) are
    // decorative — no digest segment; hud.ts patches overlays in after
    // each build.
    domClasses: [
      'panel-section',
      'panel-section-title',
      'panel-row',
      'panel-label',
      'panel-btn',
      'panel-status',
      'order-hint',
      'sw-card',
      'palette-thumb',
      'portrait',
      'sw-body',
      'sw-name',
      'sw-desc',
    ],
    digestLabels: [],
    noDigestReason:
      'Static section chrome: orders hints, superweapon card labels ' +
      'and section titles never change at runtime (a click either fires ' +
      'or the sim rejects loudly). The embedded train/build palettes are ' +
      'digest-covered by the train-palette / build-palette branches.',
  },
  {
    id: 'management-panel',
    renderedIn: 'appendManagementPanel',
    // panel-*: the Taxes / City focus / Cabinet section chrome;
    // tax-rate: the per-zone rate value in the tax rows.
    domClasses: [
      'panel-section',
      'panel-section-title',
      'panel-row',
      'panel-label',
      'panel-btn',
      'panel-status',
      'tax-rate',
    ],
    // tx: the three tax rates (the tax rows render them as percents);
    // ms: the city-focus status (the active button highlights);
    // mg: the mayor/general status lines (policy/stance/unit count).
    // ia: the three intel asset counters (Phase 7 intel — the panel
    // renders floored integers); ir: their per-second accrual rates;
    // is: per-spy mission-state codes in id order; iw: the active
    // warnings (id.kind.countdown); ig: rival airport ids + display
    // types (the discovered/undiscovered list).
    // po: the peaceful-objectives section (Phase 8 peaceful, workstream
    // B — player population, treasury flag, rival population; 'po:x'
    // when the section does not render, i.e. non-peaceful worlds).
    // ps: the peaceful city score (roadmap B1, 2026-10-02 — the derived
    // score the section renders next to the status lines; 'ps:x' when
    // the section does not render).
    // oc: the City ordinances section (Phase 8 civilian, workstream E —
    // per-policy on/off + funded/unfunded, in POLICY_IDS order).
    // tr: the Trade sub-tab's route list (command-menu rebuild,
    // 2026-10-01 — the player's trade-route partners; 'tr:' empty when
    // there are no routes).
    // st: the sea-trade section's route list (Half A: id.from.to.policy
    // each); sa: the sea-route tool's armed state ('off' / 'pick.pick' /
    // first id / first+second ids).
    // ec: the Economy sub-tab's stockpile rows (roadmap B10 — floored
    // stock + one-decimal net rate per FLOW_RESOURCES entry).
    digestLabels: ['tx:', 'ms:', 'mg:', 'ia:', 'ir:', 'is:', 'iw:', 'ig:', 'po:', 'ps:', 'oc:', 'tr:', 'st:', 'sa:', 'ec:'],
  },
  {
    id: 'research-panel',
    renderedIn: 'appendResearchPanel',
    domClasses: [
      'research-panel',
      'hud-panel-title',
      'research-group',
      'research-row',
      'research-head',
      'research-name',
      'research-done',
      'palette-cost',
      'research-effect',
      'research-btn',
    ],
    digestLabels: ['lab:', 'rs:', 'rslvl:'],
  },
  {
    id: 'toast',
    renderedIn: 'toast',
    domClasses: ['hud-toast'],
    digestLabels: [],
    noDigestReason:
      'Transient one-line feedback; textContent set imperatively, never rebuilt on a digest.',
  },
];
