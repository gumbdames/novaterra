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
import type { AIDifficulty, OpponentMode } from '../sim/ai';
import { MAP_PRESETS } from '../sim/terrain';
import type { SkirmishVictoryKind } from '../sim/world';
import { SKIRMISH_VICTORY_KINDS } from '../sim/world';
import { DOCTRINES, DOCTRINE_IDS, type DoctrineId } from '../sim/doctrine';
import { STRINGS, loc } from './strings';
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

/** Graphics quality levels. */
export type QualityLevel = 'low' | 'medium' | 'high';

/** Persisted player settings (localStorage, never leaves the browser). */
export interface Settings {
  quality: QualityLevel;
  /** Phase 3: colorblind-friendly team colors. */
  colorblind: boolean;
  /** Phase 3: UI scale multiplier (0.8 .. 1.5). */
  uiScale: number;
  /** Roadmap B15: edge pan on/off (default on). */
  edgePan: boolean;
}

const SETTINGS_KEY = 'novaterra.settings.v1';

const DEFAULT_SETTINGS: Settings = { quality: 'high', colorblind: false, uiScale: 1, edgePan: true };

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
      // Roadmap B15: absent in pre-B15 saves → default on (existing
      // players keep the behavior they know).
      const edgePan = typeof parsed.edgePan === 'boolean' ? parsed.edgePan : true;
      return { quality, colorblind, uiScale, edgePan };
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
  /**
   * Start a skirmish against the chosen AI difficulty on the chosen map.
   * `peaceful` (grand-expansion Phase 8, workstream B, 2026-09-30) starts
   * a peaceful skirmish: no military, the rival builds peacefully, and
   * there is no victory condition (endless, 2026-10-01). `victoryKind`
   * (roadmap B2, 2026-10-02) picks the victory condition for war
   * skirmishes; it is ignored when `peaceful` is true.
   */
  onStartSkirmish(
    difficulty: AIDifficulty,
    mapPreset: string,
    peaceful: boolean,
    victoryKind: SkirmishVictoryKind,
    doctrine: DoctrineId,
    opponentMode?: OpponentMode,
  ): void;
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
  /** Roadmap B15: edge pan toggled. Optional. */
  onEdgePanChange?: (v: boolean) => void;
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
    const menu = el('div', 'menu-overlay main-menu-hero');
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
      onEdgePanChange: this.actions.onEdgePanChange,
      onClose: () => this.show(),
    }).show(), false, menuIcon('settings'));
    buttons.append(skirmish, loadGame, missions, settings);
    menu.append(buttons);
    menu.append(el('div', 'version', s.version));
    this.root.append(menu);
    this.menuEl = menu;
  }

  /**
   * Skirmish setup: pick a map, choose peaceful mode, then a rival
   * difficulty. The selected map is highlighted; clicking a difficulty
   * starts the game immediately with the selected map and the peaceful
   * toggle's value.
   */
  private showSkirmishSetup(buttons: HTMLElement): void {
    const s = STRINGS.menu;
    buttons.textContent = '';
    // B27: no `!` — MAP_PRESETS is non-empty; unreachable.
    const firstPreset = MAP_PRESETS[0];
    if (firstPreset === undefined) throw new Error('menus: MAP_PRESETS is empty');
    let selectedMap = firstPreset.name;

    buttons.append(el('div', 'difficulty-title', s.chooseMap));

    // Dynamic map preview card
    const previewContainer = el('div', 'map-preview-card');
    const previewImg = document.createElement('img');
    previewImg.className = 'map-preview-img';
    previewImg.alt = 'Map preview';
    previewImg.src = 'img/art/skirmish/map-1.jpg';
    const previewCaption = el('div', 'map-preview-caption', `${firstPreset.name} — ${firstPreset.blurb}`);
    previewContainer.append(previewImg, previewCaption);
    buttons.append(previewContainer);

    const mapRow = el('div', 'map-row');
    const mapButtons: HTMLButtonElement[] = [];
    for (let i = 0; i < MAP_PRESETS.length; i++) {
      const preset = MAP_PRESETS[i];
      if (!preset) continue;
      const mapNum = i + 1;
      const b = menuButton(
        `${preset.name} — ${Math.round(preset.waterTargetFraction * 100)}% water`,
        () => {
          selectedMap = preset.name;
          for (const mb of mapButtons) {
            mb.classList.toggle('selected', mb.dataset['map'] === selectedMap);
          }
          previewImg.src = `img/art/skirmish/map-${mapNum}.jpg`;
          previewCaption.textContent = `${preset.name} — ${preset.blurb}`;
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

    // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
    // the peaceful toggle. One line explains what it means — no
    // military, rivals build peacefully, win by growing your city.
    // Reuses the settings rows' classes (no new CSS needed).
    const p = STRINGS.peaceful;
    let peacefulMode = false;
    const peacefulRow = el('label', 'settings-row', '');
    const peacefulBox = document.createElement('input');
    peacefulBox.type = 'checkbox';
    peacefulBox.setAttribute('aria-label', loc(p.setupToggle));
    peacefulBox.addEventListener('change', () => {
      peacefulMode = peacefulBox.checked;
      // Roadmap B2: no victory condition in peaceful mode (endless) —
      // the picker is hidden while peaceful is on.
      victorySection.style.display = peacefulMode ? 'none' : '';
    });
    peacefulRow.append(
      peacefulBox,
      document.createTextNode(` ${loc(p.setupToggle)}`),
    );
    buttons.append(peacefulRow);
    buttons.append(el('div', 'settings-note', loc(p.setupExplanation)));

    // Roadmap B2 (2026-10-02): the victory-condition picker. A row of
    // selectable buttons like the map row; the selected kind is
    // highlighted. Hidden while peaceful mode is on (endless — no
    // victory at all). Reuses the map row's classes (no new CSS).
    buttons.append(el('div', 'difficulty-title', s.chooseVictory));
    const victorySection = el('div', 'victory-section');
    const victoryBlurb: Record<SkirmishVictoryKind, string> = {
      conquest: s.victoryConquestBlurb,
      economic: s.victoryEconomicBlurb,
      population: s.victoryPopulationBlurb,
      monument: s.victoryMonumentBlurb,
    };
    const victoryName: Record<SkirmishVictoryKind, string> = {
      conquest: s.victoryConquest,
      economic: s.victoryEconomic,
      population: s.victoryPopulation,
      monument: s.victoryMonument,
    };
    let selectedVictory: SkirmishVictoryKind = 'conquest';
    const victoryButtons: HTMLButtonElement[] = [];
    const victoryRow = el('div', 'map-row');
    for (const kind of SKIRMISH_VICTORY_KINDS) {
      const b = menuButton(victoryName[kind], () => {
        selectedVictory = kind;
        for (const vb of victoryButtons) {
          vb.classList.toggle('selected', vb.dataset['victory'] === selectedVictory);
        }
      }, false);
      b.dataset['victory'] = kind;
      b.title = victoryBlurb[kind];
      b.classList.add('map-btn');
      if (kind === selectedVictory) b.classList.add('selected');
      victoryButtons.push(b);
      victoryRow.append(b);
    }
    victorySection.append(victoryRow);
    victorySection.append(el('div', 'settings-note', s.victoryNote));
    buttons.append(victorySection);

    // Fun-audit D1 (2026-10-02): the doctrine picker. A row of
    // selectable buttons like the victory row; the selected doctrine
    // is highlighted and its blurb shows below. Reuses the map row's
    // classes (no new CSS).
    buttons.append(el('div', 'difficulty-title', s.chooseDoctrine));
    let selectedDoctrine: DoctrineId = 'republic';
    const doctrineButtons: HTMLButtonElement[] = [];
    const doctrineRow = el('div', 'map-row');
    for (const id of DOCTRINE_IDS) {
      const b = menuButton(DOCTRINES[id].name, () => {
        selectedDoctrine = id;
        for (const db of doctrineButtons) {
          db.classList.toggle('selected', db.dataset['doctrine'] === selectedDoctrine);
        }
        doctrineNote.textContent = DOCTRINES[id].blurb;
      }, false);
      b.dataset['doctrine'] = id;
      b.title = DOCTRINES[id].blurb;
      b.classList.add('map-btn');
      if (id === selectedDoctrine) b.classList.add('selected');
      doctrineButtons.push(b);
      doctrineRow.append(b);
    }
    buttons.append(doctrineRow);
    const doctrineNote = el('div', 'settings-note', DOCTRINES[selectedDoctrine].blurb);
    buttons.append(doctrineNote);

    // Mode 1 (Classic AI) vs Mode 2 (Muse Engine) opponent selection
    buttons.append(el('div', 'difficulty-title', s.chooseOpponentMode));
    let selectedOpponentMode: OpponentMode = 'classic';
    const opponentModeButtons: HTMLButtonElement[] = [];
    const opponentModeRow = el('div', 'map-row');
    const opponentModes: Array<{ mode: OpponentMode; label: string; blurb: string }> = [
      { mode: 'classic', label: s.opponentModeClassic, blurb: s.opponentModeClassicBlurb },
      { mode: 'muse', label: s.opponentModeMuse, blurb: s.opponentModeMuseBlurb },
    ];
    for (const opt of opponentModes) {
      const b = menuButton(opt.label, () => {
        selectedOpponentMode = opt.mode;
        for (const omb of opponentModeButtons) {
          omb.classList.toggle('selected', omb.dataset['mode'] === selectedOpponentMode);
        }
        opponentModeNote.textContent = opt.blurb;
      }, false);
      b.dataset['mode'] = opt.mode;
      b.title = opt.blurb;
      b.classList.add('map-btn');
      if (opt.mode === selectedOpponentMode) b.classList.add('selected');
      opponentModeButtons.push(b);
      opponentModeRow.append(b);
    }
    buttons.append(opponentModeRow);
    const opponentModeNote = el('div', 'settings-note', s.opponentModeClassicBlurb);
    buttons.append(opponentModeNote);

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
        menuButton(
          label,
          () => this.actions.onStartSkirmish(
            difficulty,
            selectedMap,
            peacefulMode,
            selectedVictory,
            selectedDoctrine,
            selectedOpponentMode,
          ),
          false,
          difficultyIcon(difficulty),
        ),
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
          onEdgePanChange: this.actions.onEdgePanChange,
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
  private readonly onEdgePanChange: ((v: boolean) => void) | undefined;
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
      onEdgePanChange?: (v: boolean) => void;
      onClose: () => void;
    },
  ) {
    this.root = root;
    this.onQualityChange = opts.onQualityChange;
    this.onAudioChange = opts.onAudioChange;
    this.onMuseFrequencyChange = opts.onMuseFrequencyChange;
    this.onColorblindChange = opts.onColorblindChange;
    this.onUiScaleChange = opts.onUiScaleChange;
    this.onEdgePanChange = opts.onEdgePanChange;
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

    // --- Roadmap B15: camera ---
    panel.append(el('h3', '', 'Camera'));
    const edgeRow = el('label', 'settings-row', 'Edge pan (mouse at screen edge): ');
    const edgeBox = document.createElement('input');
    edgeBox.type = 'checkbox';
    edgeBox.checked = settings.edgePan;
    edgeBox.addEventListener('change', () => {
      saveSettings({ ...loadSettings(), edgePan: edgeBox.checked });
      this.onEdgePanChange?.(edgeBox.checked);
    });
    edgeRow.append(edgeBox);
    panel.append(edgeRow);

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
    // No API-key field (user directive 2026-09-29, rip-out 2026-10-01):
    // Live Muse is an offline placeholder until the integration is
    // wired — there is no key flow, no endpoint, and no third-party
    // AI API surface in 0.1 Alpha.
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
