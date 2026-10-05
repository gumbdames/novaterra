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
 * NOVATERRA — tests/ui.reactor.test.ts — the reactor-upgrade UI
 * contract (2026-10-05, Bug C).
 *
 * Covers:
 *  - `reactorUpgradeBlockReason`: null exactly when the sim would
 *    accept the order; the named blocker otherwise (kind / still
 *    building / upgrade in flight / maxed / cannot afford), mirroring
 *    the sim's `upgradeBuilding` validate order;
 *  - `canAffordReactorUpgrade`: the funds/materials gate on its own;
 *  - the `br:` digest segment: `br:<reactors>:<inFlight>:<affordable>`
 *    for nuclear plants (`br:x` otherwise), moving exactly when the
 *    Add Reactor button state would change (reactor count, upgrade
 *    start, affordability flip).
 *
 * Headless-safe: no DOM, no three.js.
 */

import { describe, expect, it } from 'vitest';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { selectionDigest } from '../src/ui/paletteDigest';
import {
  canAffordReactorUpgrade,
  reactorUpgradeBlockReason,
} from '../src/ui/reactor';
import {
  NUCLEAR_MAX_REACTORS,
  NUCLEAR_UPGRADE_COST_FUNDS,
  NUCLEAR_UPGRADE_COST_MATERIALS,
  getPlayer,
  type BuildingRecord,
} from '../src/sim/city';
import type { World } from '../src/sim/world';

let nextId = 8000;

/** A completed, operational building owned by the human player. */
function building(world: World, kind: string, overrides: Partial<BuildingRecord> = {}): BuildingRecord {
  const b: BuildingRecord = {
    id: nextId++,
    kind: kind as BuildingRecord['kind'],
    owner: HUMAN_PLAYER_ID,
    cx: 10,
    cz: 10,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
    ...overrides,
  };
  world.city.buildings.push(b);
  return b;
}

/** Give the human player deep pockets (or empty ones). */
function setFunds(world: World, funds: number, materials: number): void {
  const player = getPlayer(world.city, HUMAN_PLAYER_ID);
  if (!player) throw new Error('no human player');
  player.funds = funds;
  player.materials = materials;
}

function rich(world: World): void {
  setFunds(world, NUCLEAR_UPGRADE_COST_FUNDS * 10, NUCLEAR_UPGRADE_COST_MATERIALS * 10);
}

describe('reactorUpgradeBlockReason', () => {
  it('returns null when the sim would accept the order', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant');
    expect(reactorUpgradeBlockReason(world, b)).toBeNull();
  });

  it('blocks non-nuclear buildings', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    expect(reactorUpgradeBlockReason(world, building(world, 'house'))).toBe('not a nuclear plant');
  });

  it('blocks plants still under construction', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant', { progress: 0.5 });
    expect(reactorUpgradeBlockReason(world, b)).toBe('still under construction');
  });

  it('blocks while an upgrade is already in flight', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant', { upgradeProgress: 0 });
    expect(reactorUpgradeBlockReason(world, b)).toBe('upgrade already in progress');
  });

  it('blocks at max reactors', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant', { reactors: NUCLEAR_MAX_REACTORS });
    expect(reactorUpgradeBlockReason(world, b)).toContain(`maximum of ${NUCLEAR_MAX_REACTORS}`);
  });

  it('blocks when unaffordable, in the same order as the sim validate', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    // Broke on funds only: still blocked.
    setFunds(world, 0, NUCLEAR_UPGRADE_COST_MATERIALS * 10);
    const b = building(world, 'nuclearPlant');
    expect(reactorUpgradeBlockReason(world, b)).toContain(
      `needs ${NUCLEAR_UPGRADE_COST_FUNDS} funds`,
    );
    // Broke on materials only: still blocked.
    setFunds(world, NUCLEAR_UPGRADE_COST_FUNDS * 10, 0);
    expect(reactorUpgradeBlockReason(world, b)).not.toBeNull();
    // Exactly affordable: not blocked.
    setFunds(world, NUCLEAR_UPGRADE_COST_FUNDS, NUCLEAR_UPGRADE_COST_MATERIALS);
    expect(reactorUpgradeBlockReason(world, b)).toBeNull();
  });
});

describe('canAffordReactorUpgrade', () => {
  it('mirrors the panel funds/materials check', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    expect(canAffordReactorUpgrade(world, HUMAN_PLAYER_ID)).toBe(true);
    setFunds(world, 0, NUCLEAR_UPGRADE_COST_MATERIALS * 10);
    expect(canAffordReactorUpgrade(world, HUMAN_PLAYER_ID)).toBe(false);
    setFunds(world, NUCLEAR_UPGRADE_COST_FUNDS, NUCLEAR_UPGRADE_COST_MATERIALS);
    expect(canAffordReactorUpgrade(world, HUMAN_PLAYER_ID)).toBe(true);
    expect(canAffordReactorUpgrade(world, 99)).toBe(false);
  });
});

describe('selectionDigest br: segment', () => {
  function digestFor(world: World, b: BuildingRecord): string {
    return selectionDigest(world, { unitIds: [], buildingId: b.id }, 'infantry', 'housing');
  }

  it('carries reactors, in-flight flag, and affordability for nuclear plants', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant', { reactors: 1 });
    expect(digestFor(world, b)).toContain('br:1:0:1');
  });

  it('moves when the reactor count changes', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant', { reactors: 1 });
    const before = digestFor(world, b);
    b.reactors = 2;
    const after = digestFor(world, b);
    expect(after).not.toBe(before);
    expect(after).toContain('br:2:0:1');
  });

  it('moves when an upgrade starts', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant');
    const before = digestFor(world, b);
    expect(before).toContain('br:1:0:1');
    b.upgradeProgress = 0;
    const after = digestFor(world, b);
    expect(after).not.toBe(before);
    expect(after).toContain('br:1:1:1');
  });

  it('moves when affordability flips', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'nuclearPlant');
    const before = digestFor(world, b);
    expect(before).toContain('br:1:0:1');
    setFunds(world, 0, 0);
    const after = digestFor(world, b);
    expect(after).not.toBe(before);
    expect(after).toContain('br:1:0:0');
  });

  it('is br:x for non-nuclear plants', () => {
    const session = createSession({ seed: 20261005 });
    const world = session.world;
    rich(world);
    const b = building(world, 'house');
    expect(digestFor(world, b)).toContain('br:x');
  });
});
