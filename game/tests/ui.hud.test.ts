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
 * NOVATERRA — ui/hud.ts tests (roadmap B24).
 *
 * hud.ts was the highest-value untested surface: the top bar, the
 * advisor panel, and the selection panel. The HUD is DOM-heavy, so these
 * tests use the shared headless fake DOM (tests/support/fakeDom.ts —
 * the pattern tests/ui.screens.test.ts pioneered) and pin:
 *  - construction builds the full chrome (topbar chips, advisor panel)
 *    without throwing,
 *  - update() writes the player's live stockpiles into the topbar chips,
 *  - the advisor panel renders worst-first items and the all-clear line,
 *    and never double-renders on an unchanged list (the 2026-09-30
 *    click-bug class: DOM churn under a stable digest),
 *  - toasts pump through update() and the pause button calls through to
 *    the controller action.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HUD, type HUDActions } from '../src/ui/hud';
import { STRINGS } from '../src/ui/strings';
import { createSelection } from '../src/ui/selection';
import type { AdvisorItem } from '../src/ui/advisor';
import { createWorld } from '../src/sim/world';
import { getPlayer } from '../src/sim/city';
import { installFakeDom, fakeRoot } from './support/fakeDom';

/** Every HUDActions callback as a recording no-op. */
function stubActions(): HUDActions & { calls: string[] } {
  const calls: string[] = [];
  const rec = (name: string) => () => void calls.push(name);
  const actions = {
    onPauseToggle: rec('onPauseToggle'),
    onSpeedChange: rec('onSpeedChange'),
    onOpenMenu: rec('onOpenMenu'),
    onStopSelection: rec('onStopSelection'),
    onDeselect: rec('onDeselect'),
    onTrainUnit: rec('onTrainUnit'),
    onBuildTool: rec('onBuildTool'),
    onCancelPlacement: rec('onCancelPlacement'),
    onAdvanceAge: rec('onAdvanceAge'),
    onToggleUtilityOverlay: rec('onToggleUtilityOverlay'),
    onToggleLogisticsOverlay: rec('onToggleLogisticsOverlay'),
    onToggleAirportOverlay: rec('onToggleAirportOverlay'),
    onToggleDesirabilityOverlay: rec('onToggleDesirabilityOverlay'),
    onToggleXray: rec('onToggleXray'),
    onToggleGrid: rec('onToggleGrid'),
    onMinimapJump: rec('onMinimapJump'),
    onResupplyUnit: rec('onResupplyUnit'),
    onEmergencyRefuel: rec('onEmergencyRefuel'),
    onEmbarkAircraft: rec('onEmbarkAircraft'),
    onBaseAircraft: rec('onBaseAircraft'),
    onLaunchAircraft: rec('onLaunchAircraft'),
    onSelectUnit: rec('onSelectUnit'),
    onInfiltrateBuilding: rec('onInfiltrateBuilding'),
    onSabotageBuilding: rec('onSabotageBuilding'),
    onStealTech: rec('onStealTech'),
    onResearchUpgrade: rec('onResearchUpgrade'),
    onSetTaxRate: rec('onSetTaxRate'),
    onSetPolicy: rec('onSetPolicy'),
    onAssignMayor: rec('onAssignMayor'),
    onDismissMayor: rec('onDismissMayor'),
    onSetMayorBuildPolicy: rec('onSetMayorBuildPolicy'),
    onAssignGeneral: rec('onAssignGeneral'),
    onDismissGeneral: rec('onDismissGeneral'),
    onSetGeneralStance: rec('onSetGeneralStance'),
    onSetSpecialization: rec('onSetSpecialization'),
    onEstablishTradeRoute: rec('onEstablishTradeRoute'),
    onCancelTradeRoute: rec('onCancelTradeRoute'),
    onSeaTradeNewRoute: rec('onSeaTradeNewRoute'),
    onCancelSeaRoute: rec('onCancelSeaRoute'),
    onAssignSeaRoute: rec('onAssignSeaRoute'),
    onSeaTradePolicy: rec('onSeaTradePolicy'),
    onLoadCargo: rec('onLoadCargo'),
    onUnloadCargo: rec('onUnloadCargo'),
    onAirlineNewRoute: rec('onAirlineNewRoute'),
    onCancelAirlineRoute: rec('onCancelAirlineRoute'),
    onFireAegis: rec('onFireAegis'),
    onStormTarget: rec('onStormTarget'),
    onSendTribute: rec('onSendTribute'),
    onDemandTribute: rec('onDemandTribute'),
    onProposeCeasefire: rec('onProposeCeasefire'),
    onSetSupplyToggles: rec('onSetSupplyToggles'),
  } as unknown as HUDActions;
  return Object.assign(actions, { calls });
}

beforeEach(() => {
  installFakeDom();
});

/** Walk a fake-DOM subtree, collecting every node. */
function allNodes(root: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    const el = node as Record<string, unknown>;
    if (!el || typeof el !== 'object') return;
    out.push(el);
    for (const kid of (el.children as unknown[]) ?? []) visit(kid);
  };
  visit(root);
  return out;
}

function textOf(nodes: Array<Record<string, unknown>>): string[] {
  return nodes.map((n) => String(n.textContent ?? ''));
}

describe('ui/hud top bar', () => {
  it('constructs the full chrome without throwing', () => {
    const root = fakeRoot();
    expect(() => new HUD(root, stubActions())).not.toThrow();
    const nodes = allNodes(root);
    // One chip per resource label plus the age readout.
    expect(textOf(nodes)).toContain(STRINGS.hud.funds);
    expect(textOf(nodes)).toContain(STRINGS.hud.population);
  });

  it('writes the player stockpiles into the topbar chips on update', () => {
    const root = fakeRoot();
    const hud = new HUD(root, stubActions());
    const world = createWorld(4242);
    const player = getPlayer(world.city, 0)!;
    player.funds = 123456;
    player.population = 987;
    hud.update(world, createSelection(), [], false, 1);
    const texts = textOf(allNodes(root));
    // fmt(): ≥10000 renders as "123.5k".
    expect(texts).toContain('123.5k');
    expect(texts).toContain('987');
  });

  it('refreshes a chip when the stockpile changes (write-on-change)', () => {
    const root = fakeRoot();
    const hud = new HUD(root, stubActions());
    const world = createWorld(4242);
    const player = getPlayer(world.city, 0)!;
    player.funds = 5000;
    hud.update(world, createSelection(), [], false, 1);
    player.funds = 6000;
    hud.update(world, createSelection(), [], false, 1);
    expect(textOf(allNodes(root))).toContain('6000');
    expect(textOf(allNodes(root))).not.toContain('5000');
  });
});

describe('ui/hud advisor panel', () => {
  function advisorItems(): AdvisorItem[] {
    return [
      { severity: 'warning', title: 'Fuel low', detail: 'Refinery unpowered' },
      { severity: 'critical', title: 'City starving', detail: 'Food at zero' },
    ];
  }

  it('renders the all-clear line when there are no advisor items', () => {
    const root = fakeRoot();
    const hud = new HUD(root, stubActions());
    hud.update(createWorld(4242), createSelection(), [], false, 1);
    expect(textOf(allNodes(root))).toContain(STRINGS.advisor.allClear);
  });

  it('renders item titles and details with severity classes', () => {
    const root = fakeRoot();
    const hud = new HUD(root, stubActions());
    hud.update(createWorld(4242), createSelection(), advisorItems(), false, 1);
    const nodes = allNodes(root);
    const texts = textOf(nodes);
    expect(texts).toContain('Fuel low');
    expect(texts).toContain('Refinery unpowered');
    const severities = nodes
      .filter((n) => String(n.className ?? '').startsWith('advisor-item '))
      .map((n) => String(n.className));
    expect(severities).toContain('advisor-item warning');
    expect(severities).toContain('advisor-item critical');
  });

  it('does not re-render the list when the items are unchanged', () => {
    const root = fakeRoot();
    const hud = new HUD(root, stubActions());
    const world = createWorld(4242);
    const items = advisorItems();
    hud.update(world, createSelection(), items, false, 1);
    const before = allNodes(root).filter((n) =>
      String(n.className ?? '').startsWith('advisor-item '),
    ).length;
    hud.update(world, createSelection(), items, false, 1);
    const after = allNodes(root).filter((n) =>
      String(n.className ?? '').startsWith('advisor-item '),
    ).length;
    expect(after).toBe(before);
    expect(after).toBe(2);
  });
});

describe('ui/hud toasts and buttons', () => {
  it('pumps a queued toast into the toast element on update', () => {
    const root = fakeRoot();
    const hud = new HUD(root, stubActions());
    hud.toast('Game paused');
    hud.update(createWorld(4242), createSelection(), [], false, 1);
    expect(textOf(allNodes(root))).toContain('Game paused');
  });

  it('the pause button calls through to onPauseToggle', () => {
    const root = fakeRoot();
    const actions = stubActions();
    new HUD(root, actions);
    const buttons = allNodes(root).filter(
      (n) => String(n.textContent ?? '').length > 0,
    );
    // The pause button carries the pause label; click every button that
    // looks like it and assert exactly one pause-toggle call fired.
    let pauseButtons = 0;
    for (const b of allNodes(root)) {
      const text = String(b.textContent ?? '');
      if (text === STRINGS.hud.pause || text === STRINGS.hud.resume) {
        (b.click as () => void)();
        pauseButtons++;
      }
    }
    expect(pauseButtons).toBeGreaterThan(0);
    expect(actions.calls.filter((c) => c === 'onPauseToggle')).toHaveLength(pauseButtons);
    expect(buttons.length).toBeGreaterThan(0);
  });
});
