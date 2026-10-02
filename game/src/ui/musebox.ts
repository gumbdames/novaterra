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
 * NOVATERRA — ui/musebox.ts — the Muse persona widget (Phase 2).
 *
 * Responsibilities:
 *  - `MuseBox`: the chief-of-staff portrait + speech bubble in the HUD
 *    corner, with the threat meter (0..100, AI's share of military
 *    value). `say(text)` shows a line; messages fade after a few
 *    seconds. `setThreat(n)` updates the meter. Hidden entirely when
 *    the frequency is `off`.
 *  - `MuseSettingsPanel`: frequency selector (off/quiet/normal/chatty)
 *    and the Live Muse section — the honest "hopefully coming" note
 *    plus the disabled enable checkbox for 0.1 Alpha. (No API-key
 *    field — removed entirely per the 2026-09-29 user directive.)
 *
 * Pure DOM. The `MuseController` (muse/controller.ts) decides what to
 * say; this only renders.
 */

import {
  loadMuseFrequency,
  saveMuseFrequency,
  type MuseFrequency,
} from '../muse/controller';
import { isLiveEnabled } from '../muse/live';
import { STRINGS, loc } from './strings';

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** How long a Muse line stays on screen (ms). */
const MESSAGE_TTL_MS = 12000;

export class MuseBox {
  private readonly root: HTMLElement;
  private box: HTMLElement | null = null;
  private messageEl: HTMLElement | null = null;
  private threatFill: HTMLElement | null = null;
  private threatLabel: HTMLElement | null = null;
  private hideTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** Build the widget. No-op when frequency is off (call `dispose` then). */
  show(): void {
    this.hide();
    const box = el('div', 'muse-box');
    const portrait = el('div', 'muse-portrait', '🕴️');
    portrait.title = 'Muse — your chief of staff';
    box.append(portrait);
    const body = el('div', 'muse-body');
    const name = el('div', 'muse-name', 'MUSE');
    body.append(name);
    const message = el('div', 'muse-message muse-idle', 'Standing by, President.');
    body.append(message);
    const meter = el('div', 'muse-threat');
    meter.append(el('span', 'muse-threat-caption', 'Threat'));
    const bar = el('div', 'muse-threat-bar');
    const fill = el('div', 'muse-threat-fill');
    bar.append(fill);
    meter.append(bar);
    const threatLabel = el('span', 'muse-threat-value', '—');
    meter.append(threatLabel);
    body.append(meter);
    box.append(body);
    this.root.append(box);
    this.box = box;
    this.messageEl = message;
    this.threatFill = fill;
    this.threatLabel = threatLabel;
  }

  /** Show a line; it fades back to idle after MESSAGE_TTL_MS. */
  say(text: string): void {
    if (this.messageEl === null) return;
    this.messageEl.textContent = text;
    this.messageEl.classList.remove('muse-idle');
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this.messageEl !== null) {
        this.messageEl.textContent = loc(STRINGS.musebox.standingBy);
        this.messageEl.classList.add('muse-idle');
      }
      this.hideTimer = null;
    }, MESSAGE_TTL_MS);
  }

  /** Threat meter 0..100. */
  setThreat(threat: number): void {
    const t = Math.max(0, Math.min(100, Math.round(threat)));
    if (this.threatFill !== null) this.threatFill.style.width = `${t}%`;
    if (this.threatLabel !== null) {
      this.threatLabel.textContent =
        t >= 75
          ? `${t}% — ${loc(STRINGS.musebox.threatDanger)}`
          : t >= 50
            ? `${t}% — ${loc(STRINGS.musebox.threatWary)}`
            : t >= 25
              ? `${t}% — ${loc(STRINGS.musebox.threatCalm)}`
              : `${t}% — ${loc(STRINGS.musebox.threatSafe)}`;
    }
    if (this.threatFill !== null) {
      this.threatFill.classList.toggle('high', t >= 75);
      this.threatFill.classList.toggle('low', t < 25);
    }
  }

  hide(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.box?.remove();
    this.box = null;
    this.messageEl = null;
    this.threatFill = null;
    this.threatLabel = null;
  }
}

export interface MuseSettingsActions {
  /** Frequency changed (live-apply to the running controller). */
  onFrequencyChange(f: MuseFrequency): void;
  onClose(): void;
}

const FREQUENCY_LABELS: Array<{ value: MuseFrequency; label: string }> = [
  { value: 'off', label: loc(STRINGS.musebox.frequencyOff) },
  { value: 'quiet', label: loc(STRINGS.musebox.frequencyQuiet) },
  { value: 'normal', label: loc(STRINGS.musebox.frequencyNormal) },
  { value: 'chatty', label: loc(STRINGS.musebox.frequencyChatty) },
];

export class MuseSettingsPanel {
  private readonly root: HTMLElement;
  private readonly actions: MuseSettingsActions;
  private el: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: MuseSettingsActions) {
    this.root = root;
    this.actions = actions;
  }

  show(): void {
    this.hide();
    const overlay = el('div', 'menu-overlay muse-settings');
    overlay.append(el('h1', '', 'Muse'));
    overlay.append(el('p', 'tagline', loc(STRINGS.musebox.settingsTagline)));

    const current = loadMuseFrequency();
    const freqRow = el('div', 'setting-row');
    freqRow.append(el('span', 'setting-label', loc(STRINGS.musebox.chattiness)));
    const select = document.createElement('select');
    for (const { value, label } of FREQUENCY_LABELS) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      opt.selected = value === current;
      select.append(opt);
    }
    select.addEventListener('change', () => {
      const f = select.value as MuseFrequency;
      saveMuseFrequency(f);
      this.actions.onFrequencyChange(f);
    });
    freqRow.append(select);
    overlay.append(freqRow);

    // Live Muse (0.1 Alpha: scaffolding — hopefully coming).
    overlay.append(el('h2', '', 'Live Muse (hopefully coming)'));
    overlay.append(el('p', 'setting-note',
      'Point Muse at a live language model for strategic advice. ' +
      'The live model is advisory only — it can never drive the game. ' +
      'Live integration is not wired yet in 0.1 Alpha; the offline Muse covers you meanwhile.'));
    // No API-key field (user directive 2026-09-29, rip-out 2026-10-01):
    // there is no key flow, no endpoint, and no third-party AI API
    // surface in 0.1 Alpha.
    const enableRow = el('div', 'setting-row');
    const enableLabel = document.createElement('label');
    const enableBox = document.createElement('input');
    enableBox.type = 'checkbox';
    enableBox.checked = isLiveEnabled();
    enableBox.disabled = true; // not wired yet in 0.1 Alpha
    enableBox.title = loc(STRINGS.musebox.liveMuseTitle);
    enableLabel.append(enableBox, document.createTextNode(loc(STRINGS.musebox.enableLiveMuse)));
    enableRow.append(enableLabel);
    overlay.append(enableRow);

    const row = el('div', 'buttons');
    const back = document.createElement('button');
    back.textContent = loc(STRINGS.musebox.back);
    back.addEventListener('click', () => this.actions.onClose());
    row.append(back);
    overlay.append(row);

    this.root.append(overlay);
    this.el = overlay;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}
