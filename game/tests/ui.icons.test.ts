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
 * NOVATERRA — icon set tests (ui/icons.ts).
 *
 * Coverage: every unit kind and every building kind has a glyph (the
 * `Record<UnitKind,…>` / `Record<BuildingKind,…>` types enforce this at
 * compile time; these tests pin it at runtime too), every glyph is a
 * well-formed decorative SVG (aria-hidden, no scripts, no text — icons
 * are always paired with a text label), map/difficulty buckets behave,
 * and no two units (or buildings) accidentally share a glyph.
 */
import { describe, expect, it } from 'vitest';

import { UNIT_KINDS, type UnitKind } from '../src/sim/units';
import { BuildingKind } from '../src/sim/city';
import type { AIDifficulty } from '../src/sim/ai';
import {
  buildingIcon,
  difficultyIcon,
  mapIcon,
  menuIcon,
  toolIcon,
  unitIcon,
  type MenuIconKey,
  type PaletteToolIcon,
} from '../src/ui/icons';

const HEBREW = /[\u0590-\u05FF]/;

/** Structural check for one icon string. */
function expectValidIcon(markup: string): void {
  expect(markup.startsWith('<svg')).toBe(true);
  expect(markup.endsWith('</svg>')).toBe(true);
  expect(markup).toContain('viewBox="0 0 24 24"');
  // Decorative: screen readers use the button's text label instead.
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).not.toContain('<script');
  expect(markup).not.toContain('http');
  // English-only: icons carry no text at all, let alone Hebrew.
  expect(HEBREW.test(markup)).toBe(false);
  // Rough tag balance: every opened non-void element is closed.
  for (const tag of ['svg', 'path', 'circle', 'rect', 'ellipse', 'g']) {
    const opens = (markup.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const selfClosed = (markup.match(new RegExp(`<${tag}[^>]*\\/>`, 'g')) ?? []).length;
    const closes = (markup.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    expect(opens - selfClosed).toBe(closes);
  }
}

describe('unit icons', () => {
  it('covers all 28 unit kinds', () => {
    expect(UNIT_KINDS).toHaveLength(28);
    for (const kind of UNIT_KINDS) {
      expectValidIcon(unitIcon(kind as UnitKind));
    }
  });

  it('gives every unit a distinct glyph', () => {
    const glyphs = new Set(UNIT_KINDS.map((k) => unitIcon(k as UnitKind)));
    expect(glyphs.size).toBe(28);
  });
});

describe('building icons', () => {
  it('covers all 31 building kinds (28 + Phase 1 militaryAcademy + Workstream Z education pair)', () => {
    const kinds = Object.values(BuildingKind);
    expect(kinds).toHaveLength(31);
    for (const kind of kinds) {
      expectValidIcon(buildingIcon(kind as (typeof kinds)[number]));
    }
  });

  it('gives every building a distinct glyph', () => {
    const kinds = Object.values(BuildingKind);
    const glyphs = new Set(kinds.map((k) => buildingIcon(k)));
    expect(glyphs.size).toBe(31);
  });
});

describe('tool icons', () => {
  it('covers the five build-palette tools', () => {
    const tools: PaletteToolIcon[] = ['road', 'zoneR', 'zoneC', 'zoneI', 'demolish'];
    for (const tool of tools) {
      expectValidIcon(toolIcon(tool));
    }
  });
});

describe('menu icons', () => {
  it('covers the main/pause menu actions', () => {
    const keys: MenuIconKey[] = [
      'skirmish',
      'load',
      'missions',
      'settings',
      'back',
      'resume',
      'save',
      'exit',
    ];
    for (const key of keys) {
      expectValidIcon(menuIcon(key));
    }
  });
});

describe('map icons', () => {
  it('buckets the 8 presets into 5 distinct terrain glyphs', () => {
    // MAP_PRESETS water fractions: 0.05 / 0.12 / 0.20 / 0.30 / 0.40 /
    // 0.50 / 0.55 / 0.60 → pond / river / lakes / coast / isles.
    const fractions = [0.05, 0.12, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6];
    const glyphs = fractions.map((f) => mapIcon(f));
    for (const g of glyphs) expectValidIcon(g);
    expect(new Set(glyphs).size).toBe(5);
    expect(mapIcon(0.05)).not.toBe(mapIcon(0.6));
  });
});

describe('difficulty icons', () => {
  it('fills one chevron per rank, cadet = 1 … marshal = 5', () => {
    const difficulties: AIDifficulty[] = [
      'cadet',
      'citizen',
      'commander',
      'general',
      'marshal',
    ];
    difficulties.forEach((d, i) => {
      const markup = difficultyIcon(d);
      expectValidIcon(markup);
      const filled = (markup.match(/fill="currentColor"/g) ?? []).length;
      expect(filled).toBe(i + 1);
    });
  });
});
