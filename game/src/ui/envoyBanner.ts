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
 * NOVATERRA — ui/envoyBanner.ts — the envoy banner widget (imperative).
 *
 * Fun-audit Tier 4 (E1, 2026-10-02): the diplomatic card pinned
 * top-center while an envoy visits the player's gates. Built once
 * (constructor), refreshed write-on-change (`update`) — the
 * victoryHud.ts pattern: nodes are never rebuilt per frame, so no
 * AD11 digest segment is needed (the branch is registered in
 * HUD_PANEL_BRANCHES with a noDigestReason).
 *
 * The view comes from the pure contract (`envoyBannerView` in
 * ui/envoy.ts); this widget only renders. Answer buttons call back
 * into game.ts, which enqueues the `answerEnvoy` command — the
 * widget never touches the sim.
 */
import { STRINGS, loc, fillLoc } from './strings';
import type { EnvoyBannerView } from './envoy';

/** Tiny DOM helper (same shape as hud.ts/victoryHud.ts's local `el`). */
function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** mm:ss for the answer countdown. */
function mmss(secs: number): string {
  const s = Math.max(0, secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class EnvoyBanner {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly buttonsEl: HTMLElement;
  private readonly acceptBtn: HTMLButtonElement;
  private readonly declineBtn: HTMLButtonElement;
  private lastKey = '';

  constructor(parent: HTMLElement, onAnswer: (accept: boolean) => void) {
    const s = STRINGS.envoy;
    const root = el('div', 'envoy-banner');
    root.style.display = 'none';
    this.titleEl = el('div', 'envoy-banner-title', '');
    root.append(this.titleEl);
    this.subEl = el('div', 'envoy-banner-sub', '');
    root.append(this.subEl);
    this.buttonsEl = el('div', 'envoy-banner-buttons');
    this.acceptBtn = document.createElement('button');
    this.acceptBtn.className = 'envoy-banner-btn envoy-banner-accept';
    this.acceptBtn.textContent = loc(s.acceptButton);
    this.acceptBtn.addEventListener('click', () => onAnswer(true));
    this.declineBtn = document.createElement('button');
    this.declineBtn.className = 'envoy-banner-btn envoy-banner-decline';
    this.declineBtn.textContent = loc(s.declineButton);
    this.declineBtn.addEventListener('click', () => onAnswer(false));
    this.buttonsEl.append(this.acceptBtn, this.declineBtn);
    root.append(this.buttonsEl);
    parent.append(root);
    this.root = root;
  }

  /**
   * Refresh the banner. Null hides it. The key is phase + the whole
   * seconds left, so the countdown repaints ~1 Hz, not 30 Hz.
   */
  update(view: EnvoyBannerView | null): void {
    if (view === null) {
      if (this.lastKey !== '') {
        this.lastKey = '';
        this.root.style.display = 'none';
      }
      return;
    }
    const s = STRINGS.envoy;
    const time = view.secondsLeft === null ? '' : mmss(view.secondsLeft);
    const key = `${view.phase}|${time}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.root.style.display = '';
    const showButtons = view.phase === 'waiting';
    this.buttonsEl.style.display = showButtons ? '' : 'none';
    switch (view.phase) {
      case 'inbound':
        this.titleEl.textContent = loc(s.bannerInbound);
        this.subEl.textContent = loc(s.bannerInboundSub);
        break;
      case 'waiting':
        this.titleEl.textContent = loc(s.bannerWaitingCeasefire);
        this.subEl.textContent = fillLoc(s.bannerWaitingCeasefireSub, { time });
        break;
      case 'refusalWaiting':
        this.titleEl.textContent = loc(s.bannerWaitingRefusal);
        this.subEl.textContent = loc(s.bannerWaitingRefusalSub);
        break;
      case 'departing':
        this.titleEl.textContent = loc(s.bannerDeparting);
        this.subEl.textContent = '';
        break;
    }
  }
}
