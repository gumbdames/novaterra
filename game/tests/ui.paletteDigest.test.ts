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
 * NOVATERRA — selection-panel digest tests (ui/paletteDigest.ts).
 *
 * Regression coverage for the broken-click bug: the HUD selection panel
 * used to rebuild every sim tick, recreating every palette button several
 * times a second. A real click (pointerdown + pointerup on the same DOM
 * node) then almost never completed while the sim ran, so palette tabs
 * and items were unclickable — "the defaults stay selected" and nothing
 * could be placed. The fix rebuilds only when the panel's content digest
 * changes; these tests pin that invariant: ticks that change nothing
 * visible must keep the digest stable (node-stable buttons), while every
 * visible change — tab switch, selection, availability flip, research —
 * must change it (the panel still repaints when it should).
 */
import { describe, expect, it } from 'vitest';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { selectionDigest } from '../src/ui/paletteDigest';
import { createSelection, selectUnits } from '../src/ui/selection';
import { getPlayer, type BuildingRecord } from '../src/sim/city';
import { UPGRADE_GROUPS } from '../src/ui/palettes';

const NO_SEL = createSelection();

/** Scratch completed lab for the player (test-world setup only). */
function giveCompletedLab(session: ReturnType<typeof createSession>): BuildingRecord {
  const lab: BuildingRecord = {
    id: 9001,
    kind: 'lab',
    owner: HUMAN_PLAYER_ID,
    cx: 10,
    cz: 10,
    facing: 0,
    progress: 1,
    level: 1,
    operational: true,
    powered: true,
    watered: true,
  };
  session.world.city.buildings.push(lab);
  return lab;
}

describe('selectionDigest', () => {
  it('is stable across ticks that change nothing visible', () => {
    const session = createSession({ seed: 4242 });
    const before = selectionDigest(session.world, NO_SEL, 'infantry', 'housing');
    for (let i = 0; i < 30; i++) session.tick();
    expect(selectionDigest(session.world, NO_SEL, 'infantry', 'housing')).toBe(before);
  });

  it('changes when the active train or build tab changes', () => {
    const session = createSession({ seed: 4242 });
    const base = selectionDigest(session.world, NO_SEL, 'infantry', 'housing');
    expect(selectionDigest(session.world, NO_SEL, 'armor', 'housing')).not.toBe(base);
    expect(selectionDigest(session.world, NO_SEL, 'infantry', 'commerce')).not.toBe(base);
  });

  it('changes when the selection changes', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const base = selectionDigest(world, NO_SEL, 'infantry', 'housing');
    const unit = world.units.find((u) => u.owner === HUMAN_PLAYER_ID)!;
    expect(selectionDigest(world, selectUnits([unit.id]), 'infantry', 'housing')).not.toBe(base);
  });

  it('tracks selected-unit hp but stays stable on a damageless tick', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const unit = world.units.find((u) => u.owner === HUMAN_PLAYER_ID)!;
    const sel = selectUnits([unit.id]);
    const base = selectionDigest(world, sel, 'infantry', 'housing');
    session.tick();
    expect(selectionDigest(world, sel, 'infantry', 'housing')).toBe(base);
    unit.hp = Math.max(1, unit.hp * 0.8);
    expect(selectionDigest(world, sel, 'infantry', 'housing')).not.toBe(base);
  });

  it('changes when a building selection appears and when it goes offline', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const lab = giveCompletedLab(session);
    const base = selectionDigest(world, NO_SEL, 'infantry', 'housing');
    const sel = { unitIds: [], buildingId: lab.id };
    const selected = selectionDigest(world, sel, 'infantry', 'housing');
    expect(selected).not.toBe(base);
    expect(selected).toContain('bs:lab:1:1');
    lab.operational = false;
    const offline = selectionDigest(world, sel, 'infantry', 'housing');
    expect(offline).not.toBe(selected);
    expect(offline).toContain('bs:lab:0:1');
  });

  it('changes when button availability flips (funds drained)', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const before = selectionDigest(world, NO_SEL, 'infantry', 'housing');
    const player = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    player.funds = 0;
    player.materials = 0;
    expect(selectionDigest(world, NO_SEL, 'infantry', 'housing')).not.toBe(before);
  });

  it('lists the research panel for a completed lab and tracks research state', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const before = selectionDigest(world, NO_SEL, 'infantry', 'housing');
    expect(before).not.toContain('lab:1');
    giveCompletedLab(session);
    const withLab = selectionDigest(world, NO_SEL, 'infantry', 'housing');
    expect(withLab).not.toBe(before);
    expect(withLab).toContain('lab:1');
    // Researching an upgrade flips its row state (ready/locked -> researched).
    const id = UPGRADE_GROUPS[0]!.ids[0]!;
    world.upgrades[HUMAN_PLAYER_ID] = [id];
    const researched = selectionDigest(world, NO_SEL, 'infantry', 'housing');
    expect(researched).not.toBe(withLab);
    expect(researched).toContain(`rs:${id}:researched`);
  });
});
