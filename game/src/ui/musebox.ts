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
 *    the frequency is `off`. (Frequency + Live Muse settings live in the
 *    main Settings panel — `ui/menus.ts`.)
 *
 * Pure DOM. The `MuseController` (muse/controller.ts) decides what to
 * say; this only renders.
 */

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
        this.messageEl.textContent = 'Standing by, President.';
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
        t >= 75 ? `${t}% — danger` : t >= 50 ? `${t}% — wary` : t >= 25 ? `${t}% — calm` : `${t}% — safe`;
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

