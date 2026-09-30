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
 */

import type { World } from '../sim/world';
import { UNIT_DEFS, type UnitKind } from '../sim/units';
import type { Selection } from './selection';
import {
  TRAIN_TABS,
  BUILD_TABS,
  UPGRADE_GROUPS,
  unitAvailability,
  buildingAvailability,
  upgradeAvailability,
  playerHasCompletedLab,
} from './palettes';
import { HUMAN_PLAYER_ID } from './session';

/**
 * Digest of the selection panel's dynamic content. Stable when nothing
 * visible changed (so the panel is not rebuilt); different whenever the
 * panel would render differently.
 */
export function selectionDigest(
  world: World,
  selection: Selection,
  trainTab: string,
  buildTab: string,
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
    }
    if (selection.unitIds.length > 6) parts.push(`um:${selection.unitIds.length}`);
    return parts.join('|');
  }
  const b =
    selection.buildingId !== null
      ? world.city.buildings.find((x) => x.id === selection.buildingId)
      : undefined;
  if (b !== undefined) {
    parts.push(`bs:${b.kind}:${b.operational ? 1 : 0}:${b.progress >= 1 ? 1 : 0}`);
  } else {
    // No selection: the train/build palettes render the active tab's
    // buttons; only each button's availability can move per tick.
    const trainTabDef = TRAIN_TABS.find((t) => t.id === trainTab) ?? TRAIN_TABS[0]!;
    for (const kind of trainTabDef.kinds) {
      parts.push(`ta:${kind}:${unitAvailability(world, HUMAN_PLAYER_ID, kind).ok ? 1 : 0}`);
    }
    const buildTabDef = BUILD_TABS.find((t) => t.id === buildTab) ?? BUILD_TABS[0]!;
    for (const kind of buildTabDef.kinds) {
      parts.push(`ba:${kind}:${buildingAvailability(world, HUMAN_PLAYER_ID, kind).ok ? 1 : 0}`);
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
