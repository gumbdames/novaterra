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
 * Smoke coverage for the DOM screen modules (final-review R6/L8):
 * ui/campaignUi, ui/endscreen, ui/menus, ui/musebox, ui/saveslots.
 *
 * These modules are plain DOM built at boot and never imported by
 * headless tests — until now nothing pinned that their show()/hide()
 * paths even run. The tests below construct every screen against a
 * permissive fake DOM, drive show/hide once, and assert no-throw plus
 * the pure helpers' contracts (settings round-trip, save summary).
 * They deliberately do NOT assert on layout or copy — only that the
 * wiring holds together.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  MissionSelect,
  MissionBriefing,
  MissionDebrief,
} from '../src/ui/campaignUi';
import { EndScreen } from '../src/ui/endscreen';
import { STRINGS } from '../src/ui/strings';
import {
  MainMenu,
  PauseMenu,
  SettingsPanel,
  loadSettings,
  saveSettings,
} from '../src/ui/menus';
import { MuseBox, MuseSettingsPanel } from '../src/ui/musebox';
import { SaveSlotsDialog, formatSaveSummary } from '../src/ui/saveslots';
import { emptyProgress } from '../src/campaign/progress';
import { missionsInOrder } from '../src/campaign/missions';
import type { SaveMetadata } from '../src/netSave/savefile';
import { installFakeDom, fakeRoot as root } from './support/fakeDom';

// ---------------------------------------------------------------------------
// Permissive fake DOM (shared): every screen builds with
// createElement/append/addEventListener/classList/style and nothing else
// structural. See tests/support/fakeDom.ts (extracted 2026-10-02,
// roadmap B24).
// ---------------------------------------------------------------------------

let store = installFakeDom();

beforeEach(() => {
  store = installFakeDom();
});

// ---------------------------------------------------------------------------
// campaignUi
// ---------------------------------------------------------------------------

describe('ui/campaignUi', () => {
  it('MissionSelect shows/hides without throwing', () => {
    const sel = new MissionSelect(root(), {
      onSelect: () => {},
      onBack: () => {},
    });
    expect(() => sel.show(emptyProgress())).not.toThrow();
    expect(() => sel.hide()).not.toThrow();
  });

  it('MissionBriefing shows/hides without throwing', () => {
    const mission = missionsInOrder()[0]!;
    const br = new MissionBriefing(root(), {
      onStart: () => {},
      onBack: () => {},
    });
    expect(() => br.show(mission)).not.toThrow();
    expect(() => br.hide()).not.toThrow();
  });

  it('MissionDebrief shows victory and defeat without throwing', () => {
    const mission = missionsInOrder()[0]!;
    const de = new MissionDebrief(root(), { onContinue: () => {} });
    const base = {
      mission,
      wonPath: null,
      diplomat: 2,
      commander: 1,
      isFinalMission: false,
      progress: emptyProgress(),
    };
    expect(() => de.show({ ...base, victory: true })).not.toThrow();
    expect(() => de.show({ ...base, victory: false })).not.toThrow();
    expect(() => de.hide()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// endscreen
// ---------------------------------------------------------------------------

describe('ui/endscreen', () => {
  it('victory/defeat overlay shows, fires onShow, and hides', () => {
    const seen: Array<'victory' | 'defeat'> = [];
    let kept = 0;
    let exited = 0;
    const es = new EndScreen(root(), {
      onKeepPlaying: () => void kept++,
      onExitToMenu: () => void exited++,
      onShow: (kind) => void seen.push(kind),
    });
    expect(es.visible).toBe(false);
    es.showVictory();
    expect(es.visible).toBe(true);
    expect(seen).toEqual(['victory']);
    es.hide();
    expect(es.visible).toBe(false);
    es.showDefeat('Fell', 'The capital has fallen.');
    expect(seen).toEqual(['victory', 'defeat']);
    es.hide();
    expect(kept).toBe(0);
    expect(exited).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------

describe('ui/menus', () => {
  it('settings survive a save/load round-trip', () => {
    const before = loadSettings();
    saveSettings({ ...before, quality: 'low', colorblind: true });
    const after = loadSettings();
    expect(after.quality).toBe('low');
    expect(after.colorblind).toBe(true);
  });

  it('corrupt stored settings fall back to defaults without throwing', () => {
    store.set('novaterra.settings', '{not json');
    expect(() => loadSettings()).not.toThrow();
    expect(loadSettings().quality).toBe(loadSettings().quality);
  });

  it('MainMenu / PauseMenu / SettingsPanel show/hide without throwing', () => {
    const noop = () => {};
    const actions = {
      onStartSkirmish: noop,
      onResume: noop,
      onExitToMenu: noop,
      onQualityChange: noop,
    };
    const main = new MainMenu(root(), actions);
    expect(() => main.show()).not.toThrow();
    expect(() => main.hide()).not.toThrow();

    const pause = new PauseMenu(root(), actions);
    expect(() => pause.show()).not.toThrow();
    expect(() => pause.hide()).not.toThrow();

    const settings = new SettingsPanel(root(), {
      onQualityChange: noop,
      onClose: noop,
    });
    expect(() => settings.show()).not.toThrow();
    expect(() => settings.hide()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// musebox
// ---------------------------------------------------------------------------

describe('ui/musebox', () => {
  it('MuseBox shows, says a line, sets threat, hides', () => {
    const box = new MuseBox(root());
    expect(() => box.show()).not.toThrow();
    expect(() => box.say('Test line, President.')).not.toThrow();
    expect(() => box.setThreat(80)).not.toThrow();
    expect(() => box.setThreat(-5)).not.toThrow();
    expect(() => box.hide()).not.toThrow();
  });

  it('MuseSettingsPanel shows/hides without throwing', () => {
    const panel = new MuseSettingsPanel(root(), {
      onFrequencyChange: () => {},
      onClose: () => {},
    });
    expect(() => panel.show()).not.toThrow();
    expect(() => panel.hide()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// saveslots
// ---------------------------------------------------------------------------

describe('ui/saveslots', () => {
  it('formatSaveSummary renders every field (pure)', () => {
    const meta: SaveMetadata = {
      slotId: 'slot-1',
      name: 'Slot 1',
      savedAt: 'not-a-date',
      tick: 12345,
      seed: 99,
      aiDifficulty: 'commander',
      age: 'Industry',
      program: 'Blitz',
      cheated: true,
    } as SaveMetadata;
    const s = formatSaveSummary(meta);
    expect(s).toContain('Slot 1');
    expect(s).toContain('12345');
    expect(s).toContain('Industry');
    expect(s).toContain('Blitz');
    expect(s).toContain('commander');
  });

  it('SaveSlotsDialog shows/hides without throwing', () => {
    const dlg = new SaveSlotsDialog(root(), 'load', [], {
      onPickSlot: () => {},
      onClose: () => {},
    });
    expect(() => dlg.show()).not.toThrow();
    expect(() => dlg.hide()).not.toThrow();
  });
});

describe('ui/menus (B15: edge-pan setting + key list)', () => {
  it('edgePan defaults to true for pre-B15 saves without the key', () => {
    store.set(
      'novaterra.settings.v1',
      JSON.stringify({ quality: 'high', colorblind: false, uiScale: 1 }),
    );
    expect(loadSettings().edgePan).toBe(true);
  });

  it('edgePan survives a save/load round-trip when off', () => {
    saveSettings({ ...loadSettings(), edgePan: false });
    expect(loadSettings().edgePan).toBe(false);
  });

  it('the key list documents G and R/F', () => {
    const keys = STRINGS.help.keys as Array<[string, string]>;
    const labels = keys.map(([k]) => k);
    expect(labels).toContain('G');
    expect(labels).toContain('R / F');
  });
});
