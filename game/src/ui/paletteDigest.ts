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
 *    active train/build tabs, per-button availability, research states,
 *    and the selected unit/building vitals.
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
import { BUILDING_DEFS, ZoneType } from '../sim/city';
import {
  buildingLandValue,
  buildingTaxMultiplier,
  getDesirabilityModel,
} from '../sim/desirability';
import type { Selection } from './selection';
import {
  TRAIN_TABS,
  UPGRADE_GROUPS,
  unitAvailability,
  buildingAvailability,
  upgradeAvailability,
  playerHasCompletedLab,
} from './palettes';
import { HUMAN_PLAYER_ID } from './session';
import {
  allBuildTabs,
  buildingPowerDiag,
  buildingWaterDiag,
  isUtilityBuildingKind,
  utilityBuildingAvailability,
} from './utilities';
import type { BuildingKind } from '../sim/city';
import {
  ammoStockOf,
  fuelStockOf,
  fuelFracOf,
  ammoFracOf,
  cargoFuelOf,
  cargoAmmoOf,
  serviceTogglesOf,
} from './logistics';

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
): string {
  const parts: string[] = [
    `u:${selection.unitIds.join(',')}`,
    `b:${selection.buildingId}`,
    `tt:${trainTab}`,
    `bt:${buildTab}`,
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
      const model = getDesirabilityModel(terrain, world);
      const score = Math.round(buildingLandValue(model, b));
      parts.push(`bv:${score}:${buildingTaxMultiplier(model, b)}`);
    } else {
      parts.push('bv:x');
    }
  } else {
    // No selection: the train/build palettes render the active tab's
    // buttons; only each button's availability can move per tick.
    const trainTabDef = TRAIN_TABS.find((t) => t.id === trainTab) ?? TRAIN_TABS[0]!;
    for (const kind of trainTabDef.kinds) {
      parts.push(`ta:${kind}:${unitAvailability(world, HUMAN_PLAYER_ID, kind).ok ? 1 : 0}`);
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
  }
  // The research panel is listed whenever the player owns a completed
  // lab (no selection, or the lab itself selected).
  if (playerHasCompletedLab(world, HUMAN_PLAYER_ID)) {
    parts.push('lab:1');
    for (const group of UPGRADE_GROUPS) {
      for (const id of group.ids) {
        parts.push(`rs:${id}:${upgradeAvailability(world, HUMAN_PLAYER_ID, id).state}`);
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
      'hud-age',
      'hud-age-btn',
      'hud-spacer',
      'hud-speed',
      'hud-pause',
      'hud-util',
      'hud-logistics',
      'hud-desirability',
      'hud-menu-btn',
    ],
    digestLabels: [],
    noDigestReason:
      'Built once in the constructor; per-frame updates are write-on-change ' +
      'text/property writes (setText) — nodes are never rebuilt, so no digest ' +
      'segment is needed. The utilities-overlay toggle (hud-util, Phase 2), ' +
      'the logistics-overlay toggle (hud-logistics, Phase 3), and the ' +
      'desirability-overlay toggle (hud-desirability, workstream W) flip ' +
      'their own active class on click via setUtilityOverlayActive / ' +
      'setLogisticsOverlayActive / setDesirabilityOverlayActive. ' +
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
    digestLabels: ['u:', 'b:', 'tt:', 'bt:'],
  },
  {
    id: 'selection-units',
    renderedIn: 'updateSelection',
    // sel-bar / sel-bar-fill / sel-bar-label: the Phase 3 fuel/ammo
    // bars; sel-toggle / sel-toggle-row: the Repair/Rearm/Refuel buttons
    // on supply units.
    domClasses: ['sel-title', 'sel-unit', 'sel-action', 'sel-bar', 'sel-bar-fill', 'sel-bar-label', 'sel-toggle-row', 'sel-toggle'],
    // uf: fuel/ammo/cargo levels (Phase 3 logistics, 5% quantization);
    // us: the unit's field-service toggles.
    digestLabels: ['u:', 'uh:', 'uv:', 'um:', 'uf:', 'us:'],
  },
  {
    id: 'selection-building',
    renderedIn: 'updateSelection',
    domClasses: ['sel-title', 'sel-unit'],
    // bu: power/water diagnosis line (Phase 2 utilities; the panel renders
    // it for every selected building via buildingUtilityLine).
    // bq: depot stock line (Phase 3 logistics; "Ammo 42/150 · Fuel 200/250").
    // bv: land-value line (workstream W; "Land: Nice (64) · tax ×1.3",
    // residential buildings only — 'bv:x' otherwise).
    digestLabels: ['b:', 'bs:', 'bl:', 'bu:', 'bq:', 'bv:'],
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
      'palette-icon',
      'palette-name',
      'palette-cost',
    ],
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
      'palette-icon',
      'palette-name',
      'palette-cost',
    ],
    digestLabels: ['bt:', 'ba:'],
  },
  {
    id: 'tools-row',
    renderedIn: 'appendBuildPanel',
    domClasses: [
      'palette-tools',
      'palette-zones',
      'palette-section-title',
      'palette-label',
      'build-btn',
    ],
    digestLabels: [],
    noDigestReason:
      'Static tool buttons (road/zones/demolish) and the static "Zoning" ' +
      'section header: labels and icons never change at runtime.',
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
    digestLabels: ['lab:', 'rs:'],
  },
  {
    id: 'phase3-panel',
    renderedIn: 'buildPhase3Panel',
    domClasses: [
      'hud-phase3',
      'hud-panel-title',
      'hud-phase3-row',
      'hud-label',
      'hud-btn',
      'hud-btn small',
    ],
    digestLabels: [],
    noDigestReason:
      'Built once in the constructor; every button is static (labels never change, no dynamic values).',
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
