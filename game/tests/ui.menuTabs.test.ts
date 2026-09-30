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
 * NOVATERRA — main menu tab reachability tests (workstream Y, 2026-09-30).
 *
 * The 3-tab restructure (Civilian / Military / Management) must not
 * orphan anything: every build tab, every build tool, the train
 * palette, the research panel, the superweapons, the delegation
 * controls, and every HUDActions callback must have a home under the
 * new menu. These tests pin that inventory at the data level (the tab
 * mapping covers every build tab exactly once) and at the source level
 * (hud.ts wires each control under its new tab).
 */
import { describe, expect, it } from 'vitest';
// node builtins (ambient declarations in i18n-shim.d.ts — tsconfig has
// `types: []` and @types/node is not a dependency).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSession } from '../src/ui/session';
import { selectionDigest } from '../src/ui/paletteDigest';
import { createSelection } from '../src/ui/selection';
import {
  TRAIN_TABS,
  BUILD_TABS,
  BUILD_TAB_MENU_TABS,
  buildTabsForMenuTab,
  type MenuTabId,
} from '../src/ui/palettes';
import { allBuildTabs } from '../src/ui/utilities';

const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUD_SRC = readFileSync(join(GAME_DIR, 'src/ui/hud.ts'), 'utf8');

/** The body of one HUD class method (up to the next method). */
function methodBody(name: string): string {
  const start = HUD_SRC.indexOf(`private ${name}(`);
  expect(start, `hud.ts has no method ${name}`).toBeGreaterThan(-1);
  const next = HUD_SRC.indexOf('\n  private ', start + 1);
  return HUD_SRC.slice(start, next === -1 ? undefined : next);
}

describe('menu-tab build-tab mapping', () => {
  it('assigns every build tab to exactly one main tab (no orphans)', () => {
    const tabIds = allBuildTabs().map((t) => t.id);
    expect(tabIds).toHaveLength(BUILD_TABS.length);
    for (const id of tabIds) {
      expect(
        BUILD_TAB_MENU_TABS[id],
        `build tab '${id}' has no main-tab home`,
      ).toMatch(/^(civilian|military)$/);
    }
    const civilian = buildTabsForMenuTab(allBuildTabs(), 'civilian');
    const military = buildTabsForMenuTab(allBuildTabs(), 'military');
    const covered = [...civilian, ...military].map((t) => t.id).sort();
    expect(covered).toEqual([...tabIds].sort());
    // Disjoint: no tab renders twice.
    expect(new Set(covered).size).toBe(tabIds.length);
  });

  it('keeps BUILD_TABS order inside each main tab', () => {
    const civilian = buildTabsForMenuTab(allBuildTabs(), 'civilian').map((t) => t.id);
    expect(civilian[0]).toBe('housing');
    const military = buildTabsForMenuTab(allBuildTabs(), 'military').map((t) => t.id);
    expect(military).toContain('navalAir');
    expect(military).toContain('special');
    expect(military).toContain('logistics');
  });

  it('the train palette still covers every unit kind', () => {
    const kinds = TRAIN_TABS.flatMap((t) => t.kinds);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.length).toBeGreaterThan(0);
  });
});

describe('every pre-existing control has a home under the 3-tab menu', () => {
  it('the Civilian tab owns every build tool', () => {
    const body = methodBody('appendCivilianPanel');
    for (const tool of [
      'road',
      'powerLine',
      'waterPipe',
      'zoneR',
      'zoneC',
      'zoneI',
      'demolish',
    ] as const) {
      expect(body, `build tool '${tool}' missing from the Civilian tab`).toContain(
        `'${tool}'`,
      );
    }
  });

  it('the Military tab owns the train palette, unit orders, military build tabs and superweapons', () => {
    const body = methodBody('appendMilitaryPanel');
    expect(body).toContain('appendTrainPanel(');
    expect(body).toContain(`'military'`);
    // Unit orders: the existing commands (attack/move are right-click
    // map gestures; Stop is the S key / selection button).
    for (const hint of ['attackHint', 'moveHint', 'stopHint']) {
      expect(body, `orders hint '${hint}' missing from the Military tab`).toContain(hint);
    }
    // Superweapons (rehomed from the old Command panel).
    expect(body).toContain('onFireAegis');
    expect(body).toContain('onStormTarget');
  });

  it('the Management tab owns taxes, city focus, the cabinet and research', () => {
    const mgmt = methodBody('appendManagementPanel');
    expect(mgmt).toContain('taxSectionEl(');
    expect(mgmt).toContain('focusSectionEl(');
    expect(mgmt).toContain('cabinetSectionEl(');
    expect(mgmt).toContain('appendResearchPanel(');

    const taxes = methodBody('taxSectionEl');
    expect(taxes).toContain('onSetTaxRate');
    const focus = methodBody('focusSectionEl');
    expect(focus).toContain('onSetSpecialization');
    const cabinet = methodBody('cabinetSectionEl');
    for (const action of [
      'onAssignMayor',
      'onDismissMayor',
      'onSetMayorBuildPolicy',
      'onAssignGeneral',
      'onDismissGeneral',
      'onSetGeneralStance',
    ]) {
      expect(cabinet, `cabinet action '${action}' missing from the Management tab`).toContain(
        action,
      );
    }
  });

  it('every HUDActions callback is still wired to a menu surface', () => {
    const ifaceStart = HUD_SRC.indexOf('export interface HUDActions {');
    const ifaceEnd = HUD_SRC.indexOf('\n}', ifaceStart);
    const iface = HUD_SRC.slice(ifaceStart, ifaceEnd);
    const actions = [...iface.matchAll(/^\s{2}(on[A-Za-z0-9_]+)\(/gm)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(10);
    // Trade routes never had a menu surface (the old Command panel had
    // no trade buttons either) — everything else must be reachable.
    const unsurfaced: string[] = ['onEstablishTradeRoute', 'onCancelTradeRoute'];
    for (const action of actions) {
      if (unsurfaced.includes(action)) continue;
      const wired =
        HUD_SRC.includes(`this.actions.${action}(`) ||
        HUD_SRC.includes(`actions.${action}(`);
      expect(wired, `HUDActions.${action} has no menu surface`).toBe(true);
    }
  });

  it('the old Command panel is fully dissolved (no stale wiring)', () => {
    expect(HUD_SRC).not.toContain('buildPhase3Panel');
    expect(HUD_SRC).not.toContain('hud-phase3');
    expect(HUD_SRC).not.toContain('phase3Panel');
  });

  it('the menu tab bar renders Civilian / Military / Management with icons', () => {
    const body = methodBody('buildMenuTabBar');
    for (const tab of ['civilian', 'military', 'management'] as const) {
      expect(body, `menu tab '${tab}' missing from the tab bar`).toContain(`'${tab}'`);
    }
    for (const icon of ['tabCivilian', 'tabMilitary', 'tabManagement'] as const) {
      expect(body, `menu tab icon '${icon}' missing`).toContain(icon);
    }
  });
});

describe('menu-tab digest coverage', () => {
  it('the digest always carries the active main tab', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    for (const tab of ['civilian', 'military', 'management'] as const) {
      const d = selectionDigest(world, createSelection(), 'infantry', 'housing', undefined, tab as MenuTabId);
      expect(d).toContain(`mt:${tab}`);
    }
  });

  it('the Management tab digest covers taxes, focus and cabinet', () => {
    const session = createSession({ seed: 4242 });
    const d = selectionDigest(
      session.world,
      createSelection(),
      'infantry',
      'housing',
      undefined,
      'management',
    );
    expect(d).toContain('tx:');
    expect(d).toContain('ms:');
    expect(d).toContain('mg:');
  });
});
