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
// node builtins (ambient declarations in i18n-shim.d.ts — tsconfig has
// `types: []` and @types/node is not a dependency).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { selectionDigest, HUD_PANEL_BRANCHES } from '../src/ui/paletteDigest';
import { createSelection, selectUnits } from '../src/ui/selection';
import { getPlayer, type BuildingRecord } from '../src/sim/city';
import { UPGRADE_GROUPS } from '../src/ui/palettes';

const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HUD_SRC = readFileSync(join(GAME_DIR, 'src/ui/hud.ts'), 'utf8');

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
    expect(selected).toContain(`bs:lab:${HUMAN_PLAYER_ID}:1:1`);
    lab.operational = false;
    const offline = selectionDigest(world, sel, 'infantry', 'housing');
    expect(offline).not.toBe(selected);
    expect(offline).toContain(`bs:lab:${HUMAN_PLAYER_ID}:0:1`);
  });

  it('covers the selected building owner (the lab research panel is owner-gated)', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const lab = giveCompletedLab(session);
    const sel = { unitIds: [], buildingId: lab.id };
    const owned = selectionDigest(world, sel, 'infantry', 'housing');
    expect(owned).toContain(`bs:lab:${HUMAN_PLAYER_ID}:1:1`);
    // An ownership flip (capture, scenario script, debug) toggles the
    // research panel for the selected lab — the digest must move so the
    // panel repaints instead of going stale.
    lab.owner = 2;
    const enemy = selectionDigest(world, sel, 'infantry', 'housing');
    expect(enemy).not.toBe(owned);
    expect(enemy).toContain('bs:lab:2:1:1');
  });

  it('tracks veterancy: xp and vetLevel move the digest', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const unit = world.units.find((u) => u.owner === HUMAN_PLAYER_ID)!;
    const sel = selectUnits([unit.id]);
    const base = selectionDigest(world, sel, 'infantry', 'housing');
    expect(base).toContain(`uv:${unit.id}:0:0`);
    // XP gain (no threshold crossed) repaints the XP progress line.
    unit.xp = 120;
    const xpGain = selectionDigest(world, sel, 'infantry', 'housing');
    expect(xpGain).not.toBe(base);
    expect(xpGain).toContain(`uv:${unit.id}:0:120`);
    // Level-up repaints the rank name and chevrons.
    unit.xp = 320;
    unit.vetLevel = 2;
    const leveled = selectionDigest(world, sel, 'infantry', 'housing');
    expect(leveled).not.toBe(xpGain);
    expect(leveled).toContain(`uv:${unit.id}:2:320`);
  });

  it('tracks the selected building crew level', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    const lab = giveCompletedLab(session);
    const sel = { unitIds: [], buildingId: lab.id };
    const base = selectionDigest(world, sel, 'infantry', 'housing');
    expect(base).toContain('bl:1');
    // A thriving building levels up (economy.ts): the "Level 2/3" line
    // must repaint, not go stale.
    lab.level = 2;
    const leveled = selectionDigest(world, sel, 'infantry', 'housing');
    expect(leveled).not.toBe(base);
    expect(leveled).toContain('bl:2');
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

describe('AD11 digest contract', () => {
  /**
   * Representative digest states, keyed by branch id: a state in which
   * that branch actually renders, so the label-presence check below is
   * meaningful (a label that never appears in ANY state is dead).
   */
  function digestForBranch(branchId: string): string {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    switch (branchId) {
      case 'selection-units': {
        // A real veteran plus unknown ids: the overflow segment appears,
        // and the veterancy segment carries real xp/vetLevel (a stale
        // panel that dropped the uv: segment fails the suite).
        const veteran = world.units.find((u) => u.owner === HUMAN_PLAYER_ID)!;
        veteran.xp = 320;
        veteran.vetLevel = 2;
        return selectionDigest(
          world,
          selectUnits([veteran.id, 90002, 90003, 90004, 90005, 90006, 90007, 90008]),
          'infantry',
          'housing',
        );
      }
      case 'selection-building': {
        const lab = giveCompletedLab(session);
        return selectionDigest(world, { unitIds: [], buildingId: lab.id }, 'infantry', 'housing');
      }
      case 'research-panel':
        giveCompletedLab(session);
        return selectionDigest(world, NO_SEL, 'infantry', 'housing');
      default:
        return selectionDigest(world, NO_SEL, 'infantry', 'housing');
    }
  }

  it('every branch is either digest-covered or documents why it needs no digest', () => {
    const ids = new Set<string>();
    for (const branch of HUD_PANEL_BRANCHES) {
      expect(branch.id.length, 'branch id').toBeGreaterThan(0);
      expect(ids.has(branch.id), `duplicate branch id ${branch.id}`).toBe(false);
      ids.add(branch.id);
      // Exactly one of digestLabels / noDigestReason must be set.
      const hasLabels = branch.digestLabels.length > 0;
      const hasReason = (branch.noDigestReason ?? '').length > 0;
      expect(hasLabels !== hasReason, `${branch.id}: set digestLabels or noDigestReason, not both/neither`).toBe(
        true,
      );
      if (!hasLabels) continue;
      // Declared coverage must be REAL: every label literally appears in
      // digest output for a state where the branch renders. A branch that
      // renders a value the digest ignores fails here instead of shipping
      // a stale panel (the click bug's cousin).
      const segs = digestForBranch(branch.id).split('|');
      for (const label of branch.digestLabels) {
        expect(
          segs.some((s) => s.startsWith(label)),
          `${branch.id}: digest never emits a '${label}' segment — register the rendered value in selectionDigest()`,
        ).toBe(true);
      }
    }
  });

  it('every hud.ts panel-building method is registered in HUD_PANEL_BRANCHES', () => {
    const methods = new Set<string>();
    for (const m of HUD_SRC.matchAll(/^\s*(?:private\s+)?\b((?:append|build|update)[A-Za-z0-9_$]*)\s*\(/gm)) {
      methods.add(m[1]!);
    }
    // Helpers that build no branch of their own.
    const NON_BRANCH_METHODS = new Set(['update', 'buildTabBar']);
    const registered = new Set(HUD_PANEL_BRANCHES.map((b) => b.renderedIn));
    const unregistered = [...methods].filter((m) => !registered.has(m) && !NON_BRANCH_METHODS.has(m));
    expect(
      unregistered,
      `new hud.ts panel method(s) without digest coverage: ${unregistered.join(', ')}. ` +
        'Register the branch in HUD_PANEL_BRANCHES (game/src/ui/paletteDigest.ts) and add ' +
        'every value it renders to selectionDigest().',
    ).toEqual([]);
  });

  it('every hud.ts panel DOM class is claimed by a registered branch', () => {
    const found = new Set<string>();
    const take = (raw: string | undefined): void => {
      if (raw === undefined) return;
      const cls = raw.split('${')[0]!.trim();
      if (cls.length > 0) found.add(cls);
    };
    for (const m of HUD_SRC.matchAll(/\bel\(\s*'(?:div|span)'\s*,\s*(?:`([^`]*?)`|'([^']*?)')/g)) {
      take(m[1] ?? m[2]);
    }
    for (const m of HUD_SRC.matchAll(/\.className\s*=\s*(?:`([^`]*?)`|'([^']*?)')/g)) {
      take(m[1] ?? m[2]);
    }
    const claimed = new Set<string>();
    for (const branch of HUD_PANEL_BRANCHES) {
      for (const cls of branch.domClasses) claimed.add(cls);
    }
    const unclaimed = [...found].filter((c) => !claimed.has(c));
    expect(
      unclaimed,
      `new hud.ts DOM class(es) without a registered digest branch: ${unclaimed.join(', ')}. ` +
        'Claim them in HUD_PANEL_BRANCHES (game/src/ui/paletteDigest.ts); if the new markup ' +
        'renders a dynamic value, add a digest segment for it too.',
    ).toEqual([]);
    // Reverse direction: a claimed class that no longer exists in hud.ts
    // is stale registry — fail instead of drifting.
    const stale = [...claimed].filter((c) => !HUD_SRC.includes(c));
    expect(stale, `stale HUD_PANEL_BRANCHES.domClasses entries: ${stale.join(', ')}`).toEqual([]);
  });
});
