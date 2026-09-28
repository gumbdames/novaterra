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
 *    reference. Persisted to localStorage.
 *
 * All screens are plain DOM. Copy comes from ui/strings.ts.
 *
 * DOM module: only constructed inside boot()/startGame(), never imported
 * by headless tests.
 */

import { GAME_TAGLINE, GAME_TITLE } from '../config';
import type { AIDifficulty } from '../sim/ai';
import { STRINGS } from './strings';

/** Graphics quality levels. */
export type QualityLevel = 'low' | 'medium' | 'high';

/** Persisted player settings (localStorage, never leaves the browser). */
export interface Settings {
  quality: QualityLevel;
}

const SETTINGS_KEY = 'novaterra.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      if (parsed.quality === 'low' || parsed.quality === 'medium' || parsed.quality === 'high') {
        return { quality: parsed.quality };
      }
    }
  } catch {
    // Corrupt or unavailable storage — fall through to defaults.
  }
  return { quality: 'high' };
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
  /** Start a skirmish against the chosen AI difficulty. */
  onStartSkirmish(difficulty: AIDifficulty): void;
  /** Resume the paused game. */
  onResume(): void;
  /** Leave the game and return to the main menu. */
  onExitToMenu(): void;
  /** Graphics quality changed. */
  onQualityChange(quality: QualityLevel): void;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function menuButton(label: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
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
    const skirmish = menuButton(s.skirmish, () => this.showDifficulty(buttons));
    const missions = menuButton(s.missions, () => undefined, true);
    missions.title = s.missionsLocked;
    const settings = menuButton(s.settings, () => new SettingsPanel(this.root, {
      onQualityChange: (q) => this.actions.onQualityChange(q),
      onClose: () => this.show(),
    }).show());
    buttons.append(skirmish, missions, settings);
    menu.append(buttons);
    menu.append(el('div', 'version', s.version));
    this.root.append(menu);
    this.menuEl = menu;
  }

  private showDifficulty(buttons: HTMLElement): void {
    const s = STRINGS.menu;
    buttons.textContent = '';
    buttons.append(el('div', 'difficulty-title', s.chooseDifficulty));
    const options: Array<[AIDifficulty, string]> = [
      ['cadet', s.difficultyCadet],
      ['citizen', s.difficultyCitizen],
      ['commander', s.difficultyCommander],
    ];
    for (const [difficulty, label] of options) {
      buttons.append(menuButton(label, () => this.actions.onStartSkirmish(difficulty)));
    }
    buttons.append(menuButton(s.back, () => this.show()));
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
    panel.append(menuButton(s.resume, () => this.actions.onResume()));
    panel.append(
      menuButton(s.settings, () =>
        new SettingsPanel(this.root, {
          onQualityChange: (q) => this.actions.onQualityChange(q),
          onClose: () => this.show(),
        }).show(),
      ),
    );
    panel.append(menuButton(s.exitToMenu, () => this.actions.onExitToMenu()));
    overlay.append(panel);
    this.root.append(overlay);
    this.el = overlay;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  get visible(): boolean {
    return this.el !== null;
  }
}

/** Settings panel: quality select + controls reference. */
export class SettingsPanel {
  private readonly root: HTMLElement;
  private readonly onQualityChange: (q: QualityLevel) => void;
  private readonly onClose: () => void;
  private el: HTMLElement | null = null;

  constructor(
    root: HTMLElement,
    opts: { onQualityChange: (q: QualityLevel) => void; onClose: () => void },
  ) {
    this.root = root;
    this.onQualityChange = opts.onQualityChange;
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
      saveSettings({ quality: q });
      this.onQualityChange(q);
    });
    label.append(select);
    panel.append(label);

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
