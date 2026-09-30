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
 * NOVATERRA — ui/menus.ts — main menu, pause overlay, settings.
 *
 * Responsibilities:
 *  - Main menu: title, tagline, Skirmish (with rival-difficulty picker),
 *    Missions (disabled — Phase 2), Settings, version footer.
 *  - Pause overlay: resume, settings, exit-to-menu. Opened from the HUD or
 *    the Space key; pausing the sim is the game controller's job.
 *  - Settings panel: graphics quality (Low/Medium/High — pixel-ratio cap
 *    + entity detail switch, applied by the game controller), controls
 *    reference, accessibility, audio. Persisted to localStorage.
 *
 * All screens are plain DOM. Copy comes from ui/strings.ts.
 *
 * DOM module: only constructed inside boot()/startGame(), never imported
 * by headless tests.
 */

import { GAME_TAGLINE, GAME_TITLE } from '../config';
import type { AIDifficulty } from '../sim/ai';
import { MAP_PRESETS } from '../sim/terrain';
import { STRINGS } from './strings';
import { difficultyIcon, mapIcon, menuIcon } from './icons';
import {
  loadAudioSettings,
  saveAudioSettings,
  type AudioSettings,
} from '../audio/engine';
import {
  loadMuseFrequency,
  saveMuseFrequency,
  type MuseFrequency,
} from '../muse/controller';
import { getLiveKey, setLiveKey } from '../muse/live';

/** Graphics quality levels. */
export type QualityLevel = 'low' | 'medium' | 'high';

/** Persisted player settings (localStorage, never leaves the browser). */
export interface Settings {
  quality: QualityLevel;
  /** Phase 3: colorblind-friendly team colors. */
  colorblind: boolean;
  /** Phase 3: UI scale multiplier (0.8 .. 1.5). */
  uiScale: number;
}

const SETTINGS_KEY = 'novaterra.settings.v1';

const DEFAULT_SETTINGS: Settings = { quality: 'high', colorblind: false, uiScale: 1 };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const quality = parsed.quality === 'low' || parsed.quality === 'medium' || parsed.quality === 'high'
        ? parsed.quality
        : DEFAULT_SETTINGS.quality;
      const colorblind = typeof parsed.colorblind === 'boolean' ? parsed.colorblind : false;
      const uiScale = typeof parsed.uiScale === 'number' && parsed.uiScale >= 0.8 && parsed.uiScale <= 1.5
        ? parsed.uiScale
        : 1;
      return { quality, colorblind, uiScale };
    }
  } catch {
    // Corrupt or unavailable storage — fall through to defaults.
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode etc.) — settings just don't persist.
  }
}

/** Callbacks the menus delegate to the application. */
export interface MenuActions {
  /** Start a skirmish against the chosen AI difficulty on the chosen map. */
  onStartSkirmish(difficulty: AIDifficulty, mapPreset: string): void;
  /** Resume the paused game. */
  onResume(): void;
  /** Leave the game and return to the main menu. */
  onExitToMenu(): void;
  /** Graphics quality changed. */
  onQualityChange(quality: QualityLevel): void;
  /** Phase 3: colorblind-friendly team colors toggled. Optional. */
  onColorblindChange?: (v: boolean) => void;
  /** Phase 3: UI scale changed. Optional. */
  onUiScaleChange?: (v: number) => void;
  /** Audio settings changed (live-apply when a game is running). Optional. */
  onAudioChange?: (patch: Partial<AudioSettings>) => void;
  /** Open the save-game slot picker (pause menu). Optional. */
  onSaveGame?: () => void;
  /** Open the load-game slot picker (main menu). Optional. */
  onShowLoadGame?: () => void;
  /** Open the campaign mission select (main menu). Optional. */
  onShowMissions?: () => void;
  /**
   * Muse chattiness changed in settings (live-apply when a game is
   * running). Optional.
   */
  onMuseFrequencyChange?: (f: MuseFrequency) => void;
  /**
   * Exit-to-menu confirmation: true = save first, false = discard.
   * When present, the pause menu asks before calling onExitToMenu.
   * When absent, onExitToMenu is called directly.
   */
  onConfirmExit?: (saveFirst: boolean) => void;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function menuButton(
  label: string,
  onClick: () => void,
  disabled = false,
  iconMarkup?: string,
): HTMLButtonElement {
  const b = document.createElement('button');
  if (iconMarkup !== undefined) {
    // Decorative glyph next to the text label (icons AND text): the label
    // stays the accessible name.
    const ic = document.createElement('span');
    ic.className = 'menu-icon';
    ic.innerHTML = iconMarkup;
    ic.setAttribute('aria-hidden', 'true');
    b.append(ic);
  }
  const labelEl = document.createElement('span');
  labelEl.className = 'menu-label';
  labelEl.textContent = label;
  b.append(labelEl);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * The main menu overlay. `show()`/`hide()` control visibility; the
 * difficulty picker appears inline when Skirmish is pressed.
 */
export class MainMenu {
  private readonly root: HTMLElement;
  private readonly actions: MenuActions;
  private menuEl: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: MenuActions) {
    this.root = root;
    this.actions = actions;
  }

  show(): void {
    this.hide();
    const s = STRINGS.menu;
    const menu = el('div', 'menu-overlay');
    menu.id = 'menu';
    menu.append(el('h1', '', GAME_TITLE));
    menu.append(el('p', 'tagline', GAME_TAGLINE));

    const buttons = el('div', 'buttons');
    const skirmish = menuButton(s.skirmish, () => this.showSkirmishSetup(buttons), false, menuIcon('skirmish'));
    const loadGame = menuButton(s.loadGame, () => this.actions.onShowLoadGame?.(), false, menuIcon('load'));
    const missions = menuButton(s.missions, () => this.actions.onShowMissions?.(), false, menuIcon('missions'));
    const settings = menuButton(s.settings, () => new SettingsPanel(this.root, {
      onQualityChange: (q) => this.actions.onQualityChange(q),
      onAudioChange: this.actions.onAudioChange,
      onMuseFrequencyChange: this.actions.onMuseFrequencyChange,
      onColorblindChange: this.actions.onColorblindChange,
      onUiScaleChange: this.actions.onUiScaleChange,
      onClose: () => this.show(),
    }).show(), false, menuIcon('settings'));
    buttons.append(skirmish, loadGame, missions, settings);
    menu.append(buttons);
    menu.append(el('div', 'version', s.version));
    this.root.append(menu);
    this.menuEl = menu;
  }

  /**
   * Skirmish setup: pick a map, then a rival difficulty. The selected map
   * is highlighted; clicking a difficulty starts the game immediately
   * with the selected map.
   */
  private showSkirmishSetup(buttons: HTMLElement): void {
    const s = STRINGS.menu;
    buttons.textContent = '';
    let selectedMap = MAP_PRESETS[0]!.name;

    buttons.append(el('div', 'difficulty-title', s.chooseMap));
    const mapRow = el('div', 'map-row');
    const mapButtons: HTMLButtonElement[] = [];
    for (const preset of MAP_PRESETS) {
      const b = menuButton(
        `${preset.name} — ${Math.round(preset.waterTargetFraction * 100)}% water`,
        () => {
          selectedMap = preset.name;
          for (const mb of mapButtons) {
            mb.classList.toggle('selected', mb.dataset['map'] === selectedMap);
          }
        },
        false,
        mapIcon(preset.waterTargetFraction),
      );
      b.dataset['map'] = preset.name;
      b.title = preset.blurb;
      b.classList.add('map-btn');
      if (preset.name === selectedMap) b.classList.add('selected');
      mapButtons.push(b);
      mapRow.append(b);
    }
    buttons.append(mapRow);

    buttons.append(el('div', 'difficulty-title', s.chooseDifficulty));
    const options: Array<[AIDifficulty, string]> = [
      ['cadet', s.difficultyCadet],
      ['citizen', s.difficultyCitizen],
      ['commander', s.difficultyCommander],
      ['general', s.difficultyGeneral],
      ['marshal', s.difficultyMarshal],
    ];
    for (const [difficulty, label] of options) {
      buttons.append(
        menuButton(label, () => this.actions.onStartSkirmish(difficulty, selectedMap), false, difficultyIcon(difficulty)),
      );
    }
    buttons.append(menuButton(s.back, () => this.show(), false, menuIcon('back')));
  }

  hide(): void {
    this.menuEl?.remove();
    this.menuEl = null;
  }
}

/**
 * Pause overlay: resume / settings / exit to menu. The game controller
 * owns the paused flag; this is purely the panel.
 */
export class PauseMenu {
  private readonly root: HTMLElement;
  private readonly actions: MenuActions;
  private el: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: MenuActions) {
    this.root = root;
    this.actions = actions;
  }

  show(): void {
    this.hide();
    const s = STRINGS.pause;
    const overlay = el('div', 'pause-overlay');
    const panel = el('div', 'pause-panel');
    panel.append(el('h2', '', s.title));
    panel.append(menuButton(s.resume, () => this.actions.onResume(), false, menuIcon('resume')));
    panel.append(
      menuButton(s.settings, () =>
        new SettingsPanel(this.root, {
          onQualityChange: (q) => this.actions.onQualityChange(q),
          onAudioChange: this.actions.onAudioChange,
          onMuseFrequencyChange: this.actions.onMuseFrequencyChange,
          onColorblindChange: this.actions.onColorblindChange,
          onUiScaleChange: this.actions.onUiScaleChange,
          onClose: () => this.show(),
        }).show(),
        false,
        menuIcon('settings'),
      ),
    );
    if (this.actions.onSaveGame) {
      const onSaveGame = this.actions.onSaveGame;
      panel.append(menuButton(s.saveGame, () => onSaveGame(), false, menuIcon('save')));
    }
    panel.append(menuButton(s.exitToMenu, () => this.confirmExit(), false, menuIcon('exit')));
    overlay.append(panel);
    this.root.append(overlay);
    this.el = overlay;
  }

  /** Exit confirm: save-and-exit / exit-without-saving / cancel. */
  private confirmExit(): void {
    const confirm = this.actions.onConfirmExit;
    if (!confirm) {
      this.actions.onExitToMenu();
      return;
    }
    const s = STRINGS.save;
    const overlay = el('div', 'confirm-overlay');
    const panel = el('div', 'confirm-panel');
    panel.append(el('h2', '', s.exitConfirmTitle));
    panel.append(el('p', '', s.exitConfirmDetail));
    panel.append(menuButton(s.saveAndExit, () => {
      overlay.remove();
      confirm(true);
    }, false, menuIcon('save')));
    panel.append(menuButton(s.exitWithoutSaving, () => {
      overlay.remove();
      confirm(false);
    }, false, menuIcon('exit')));
    panel.append(menuButton(s.cancel, () => overlay.remove()));
    overlay.append(panel);
    this.root.append(overlay);
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  get visible(): boolean {
    return this.el !== null;
  }
}

/** Settings panel: quality select + audio controls + controls reference. */
export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly onQualityChange: (q: QualityLevel) => void;
  private readonly onAudioChange: ((patch: Partial<AudioSettings>) => void) | undefined;
  private readonly onMuseFrequencyChange: ((f: MuseFrequency) => void) | undefined;
  private readonly onColorblindChange: ((v: boolean) => void) | undefined;
  private readonly onUiScaleChange: ((v: number) => void) | undefined;
  private readonly onClose: () => void;
  private el: HTMLElement | null = null;

  constructor(
    root: HTMLElement,
    opts: {
      onQualityChange: (q: QualityLevel) => void;
      onAudioChange?: (patch: Partial<AudioSettings>) => void;
      onMuseFrequencyChange?: (f: MuseFrequency) => void;
      onColorblindChange?: (v: boolean) => void;
      onUiScaleChange?: (v: number) => void;
      onClose: () => void;
    },
  ) {
    this.root = root;
    this.onQualityChange = opts.onQualityChange;
    this.onAudioChange = opts.onAudioChange;
    this.onMuseFrequencyChange = opts.onMuseFrequencyChange;
    this.onColorblindChange = opts.onColorblindChange;
    this.onUiScaleChange = opts.onUiScaleChange;
    this.onClose = opts.onClose;
  }

  show(): void {
    this.hide();
    const s = STRINGS.settings;
    const overlay = el('div', 'settings-overlay');
    const panel = el('div', 'settings-panel');
    panel.append(el('h2', '', s.title));

    const settings = loadSettings();
    const label = el('label', 'settings-row', `${s.quality}: `);
    const select = document.createElement('select');
    for (const [value, text] of [
      ['low', s.qualityLow],
      ['medium', s.qualityMedium],
      ['high', s.qualityHigh],
    ] as Array<[QualityLevel, string]>) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      opt.selected = settings.quality === value;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      const q = select.value as QualityLevel;
      saveSettings({ ...loadSettings(), quality: q });
      this.onQualityChange(q);
    });
    label.append(select);
    panel.append(label);

    // --- Phase 3: accessibility ---
    panel.append(el('h3', '', 'Accessibility'));
    const cbRow = el('label', 'settings-row', 'Colorblind-friendly team colors: ');
    const cbBox = document.createElement('input');
    cbBox.type = 'checkbox';
    cbBox.checked = settings.colorblind;
    cbBox.addEventListener('change', () => {
      saveSettings({ ...loadSettings(), colorblind: cbBox.checked });
      this.onColorblindChange?.(cbBox.checked);
    });
    cbRow.append(cbBox);
    panel.append(cbRow);
    const scaleRow = el('label', 'settings-row', 'UI scale: ');
    const scaleInput = document.createElement('input');
    scaleInput.type = 'range';
    scaleInput.min = '80';
    scaleInput.max = '150';
    scaleInput.value = String(Math.round(settings.uiScale * 100));
    scaleInput.addEventListener('input', () => {
      const v = Number(scaleInput.value) / 100;
      saveSettings({ ...loadSettings(), uiScale: v });
      this.onUiScaleChange?.(v);
    });
    scaleRow.append(scaleInput);
    panel.append(scaleRow);

    // --- Audio ---
    panel.append(el('h3', '', s.audioTitle));
    const audio = loadAudioSettings();
    const applyAudio = (patch: Partial<AudioSettings>): void => {
      const next = { ...loadAudioSettings(), ...patch };
      saveAudioSettings(next);
      this.onAudioChange?.(patch);
    };
    const sliderRow = (
      labelText: string,
      value: number,
      onInput: (v: number) => void,
    ): HTMLElement => {
      const row = el('label', 'settings-row', `${labelText}: `);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.value = String(Math.round(value * 100));
      input.addEventListener('input', () => onInput(Number(input.value) / 100));
      row.append(input);
      return row;
    };
    panel.append(sliderRow(s.masterVolume, audio.master, (v) => applyAudio({ master: v })));
    panel.append(sliderRow(s.musicVolume, audio.music, (v) => applyAudio({ music: v })));
    panel.append(sliderRow(s.sfxVolume, audio.sfx, (v) => applyAudio({ sfx: v })));
    const muteRow = el('label', 'settings-row', `${s.mute}: `);
    const muteBox = document.createElement('input');
    muteBox.type = 'checkbox';
    muteBox.checked = audio.muted;
    muteBox.addEventListener('change', () => applyAudio({ muted: muteBox.checked }));
    muteRow.append(muteBox);
    panel.append(muteRow);

    // --- Muse ---
    panel.append(el('h3', '', s.museTitle));
    const museFreqLabel = el('label', 'settings-row', `${s.museFrequency}: `);
    const museFreq = document.createElement('select');
    const freqOptions: Array<[MuseFrequency, string]> = [
      ['off', s.museOff],
      ['quiet', s.museQuiet],
      ['normal', s.museNormal],
      ['chatty', s.museChatty],
    ];
    const currentFreq = loadMuseFrequency();
    for (const [value, text] of freqOptions) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = text;
      opt.selected = currentFreq === value;
      museFreq.append(opt);
    }
    museFreq.addEventListener('change', () => {
      const f = museFreq.value as MuseFrequency;
      saveMuseFrequency(f);
      this.onMuseFrequencyChange?.(f);
    });
    museFreqLabel.append(museFreq);
    panel.append(museFreqLabel);

    panel.append(el('h3', '', s.liveMuseTitle));
    panel.append(el('p', 'settings-note', s.liveMuseNote));
    const liveKeyLabel = el('label', 'settings-row', `${s.liveKeyLabel}: `);
    const liveKey = document.createElement('input');
    liveKey.type = 'password';
    liveKey.placeholder = s.liveKeyPlaceholder;
    liveKey.autocomplete = 'off';
    liveKey.value = getLiveKey();
    liveKey.addEventListener('change', () => setLiveKey(liveKey.value.trim()));
    liveKeyLabel.append(liveKey);
    panel.append(liveKeyLabel);
    const liveEnableLabel = el('label', 'settings-row', '');
    const liveEnable = document.createElement('input');
    liveEnable.type = 'checkbox';
    liveEnable.disabled = true; // not wired yet in 0.1 Alpha
    liveEnable.title = s.liveMuseTitle;
    liveEnableLabel.append(liveEnable, document.createTextNode(` ${s.liveEnableLabel}`));
    panel.append(liveEnableLabel);

    panel.append(el('h3', '', s.keysTitle));
    const keys = el('div', 'settings-keys');
    for (const [key, action] of STRINGS.help.keys) {
      const row = el('div', 'settings-key-row');
      row.append(el('span', 'settings-key', key));
      row.append(el('span', 'settings-key-action', action));
      keys.append(row);
    }
    panel.append(keys);
    panel.append(menuButton(s.close, () => this.onClose()));
    overlay.append(panel);
    this.root.append(overlay);
    this.el = overlay;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}
