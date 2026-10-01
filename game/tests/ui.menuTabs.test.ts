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
 * NOVATERRA — main menu tab reachability tests (command-menu rebuild,
 * 2026-10-01; was workstream Y's 3-tab menu, 2026-09-30).
 *
 * The rebuilt command menu (slim icon rail: Civilian / Military /
 * Management, each with sub-tabs) must not orphan anything: every
 * build tab, every build tool, the train palette, the research panel,
 * the superweapons, the delegation controls, the trade-route commands,
 * and every HUDActions callback must have a home under the new menu.
 * These tests pin that inventory at the data level (the tab mapping
 * covers every build tab exactly once) and at the source level
 * (hud.ts wires each control under its new tab and sub-tab).
 */
import { describe, expect, it } from 'vitest';
// node builtins (ambient declarations in i18n-shim.d.ts — tsconfig has
// `types: []` and @types/node is not a dependency).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { menuTabsForWorld } from '../src/ui/peaceful';
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

describe('every pre-existing control has a home under the rebuilt menu', () => {
  it('the Civilian tab owns Tools / Build / Airlines sub-tabs', () => {
    const body = methodBody('appendCivilianPanel');
    for (const sub of ['tools', 'build', 'airlines']) {
      expect(body, `civilian sub-tab '${sub}' missing`).toContain(`'${sub}'`);
    }
    // The Tools sub-tab owns every build tool.
    const tools = methodBody('civilianToolsEl');
    for (const tool of [
      'road',
      'powerLine',
      'waterPipe',
      'zoneR',
      'zoneC',
      'zoneI',
      'demolish',
    ] as const) {
      expect(tools, `build tool '${tool}' missing from the Civilian Tools sub-tab`).toContain(
        `'${tool}'`,
      );
    }
    // The Build sub-tab owns the civilian build tabs; Airlines owns the
    // airline panel.
    expect(body).toContain(`buildTabsForMenuTab(allBuildTabs(), 'civilian')`);
    expect(body).toContain('airlinePanelEl(');
  });

  it('the Military tab owns Train / Build / Superweapons sub-tabs', () => {
    const body = methodBody('appendMilitaryPanel');
    for (const sub of ['train', 'build', 'superweapons']) {
      expect(body, `military sub-tab '${sub}' missing`).toContain(`'${sub}'`);
    }
    // Train owns the train palette plus the unit-orders help.
    expect(body).toContain('appendTrainPanel(');
    const orders = methodBody('militaryOrdersEl');
    for (const hint of ['attackHint', 'moveHint', 'stopHint']) {
      expect(orders, `orders hint '${hint}' missing from the Military Train sub-tab`).toContain(hint);
    }
    // Build owns the military build tabs.
    expect(body).toContain(`buildTabsForMenuTab(allBuildTabs(), 'military')`);
    // Superweapons (rehomed from the old Command panel) own the fire
    // buttons.
    const sw = methodBody('superweaponsEl');
    expect(sw).toContain('onFireAegis');
    expect(sw).toContain('onStormTarget');
  });

  it('the Management tab owns Taxes / Economy / Focus / Cabinet / Ordinances / Intel / Trade / Research sub-tabs', () => {
    const mgmt = methodBody('appendManagementPanel');
    for (const sub of ['taxes', 'economy', 'focus', 'cabinet', 'ordinances', 'intel', 'trade', 'research']) {
      expect(mgmt, `management sub-tab '${sub}' missing`).toContain(`'${sub}'`);
    }
    expect(mgmt).toContain('taxSectionEl(');
    expect(mgmt).toContain('economySectionEl(');
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

  it('the Management Trade sub-tab surfaces the trade-route commands', () => {
    const trade = methodBody('tradeSectionEl');
    expect(trade).toContain('onEstablishTradeRoute');
    expect(trade).toContain('onCancelTradeRoute');
    expect(trade).toContain('tradeEmpty');
  });

  it('every HUDActions callback is still wired to a menu surface', () => {
    const ifaceStart = HUD_SRC.indexOf('export interface HUDActions {');
    const ifaceEnd = HUD_SRC.indexOf('\n}', ifaceStart);
    const iface = HUD_SRC.slice(ifaceStart, ifaceEnd);
    const actions = [...iface.matchAll(/^\s{2}(on[A-Za-z0-9_]+)\(/gm)].map((m) => m[1]!);
    expect(actions.length).toBeGreaterThan(10);
    // The command-menu rebuild (2026-10-01) gave the trade-route
    // commands their menu surface (tradeSectionEl) — nothing is
    // orphaned anymore.
    for (const action of actions) {
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

  it('the icon rail renders Civilian / Military / Management with icons', () => {
    const body = methodBody('menuRailEl');
    // The rail iterates `menuTabsForWorld` (ui/peaceful.ts): a
    // standard world shows all three tabs, a peaceful world hides
    // Military. Check the helper directly (headless-testable) rather
    // than grepping the method for the literal tab ids.
    expect(menuTabsForWorld(false)).toEqual(['civilian', 'military', 'management']);
    expect(menuTabsForWorld(true)).toEqual(['civilian', 'management']);
    expect(body, 'rail must iterate menuTabsForWorld').toContain('menuTabsForWorld');
    for (const icon of ['tabCivilian', 'tabMilitary', 'tabManagement'] as const) {
      expect(body, `menu rail icon '${icon}' missing`).toContain(icon);
    }
    expect(body).toContain('menu-rail-btn');
  });

  it('the sub-tab pill row highlights the active sub-tab', () => {
    const body = methodBody('subTabBarEl');
    expect(body).toContain('sub-tabs');
    expect(body).toContain('sub-tab');
    expect(body).toContain('active');
  });

  it('the detail view has a Back button, header, stat blocks and action rows', () => {
    const back = methodBody('detailBackEl');
    expect(back).toContain('onDeselect');
    const sel = methodBody('updateSelection');
    expect(sel).toContain('this.detailBackEl()');
    expect(sel).toContain('this.detailHeaderEl(');
    for (const cls of ['stat-block', 'stat-row', 'detail-actions']) {
      expect(sel, `detail class '${cls}' missing from the selection view`).toContain(`'${cls}'`);
    }
    const header = methodBody('detailHeaderEl');
    expect(header).toContain(`'detail-header'`);
    // The building detail view arms the demolish tool.
    expect(sel).toContain('demolishVerb');
    // game.ts owns the selection: Back clears it like Esc / empty-ground
    // click do.
    const gameSrc = readFileSync(join(GAME_DIR, 'src/ui/game.ts'), 'utf8');
    expect(gameSrc).toContain('onDeselect');
    expect(gameSrc).toContain('clearSelection()');
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

  it('the digest always carries the active sub-tab', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const sel = createSelection();
    const civ = selectionDigest(world, sel, 'infantry', 'housing', undefined, 'civilian', 'paved', undefined, 'build');
    expect(civ).toContain('sb:build');
    const mil = selectionDigest(world, sel, 'infantry', 'housing', undefined, 'military', 'paved', undefined, 'superweapons');
    expect(mil).toContain('sb:superweapons');
    const mgmt = selectionDigest(world, sel, 'infantry', 'housing', undefined, 'management', 'paved', undefined, 'trade');
    expect(mgmt).toContain('sb:trade');
  });

  it('the Management tab digest covers taxes, focus, cabinet and trade routes', () => {
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
    expect(d).toContain('tr:');
  });
});
