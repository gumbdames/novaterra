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
 * NOVATERRA — ui/luminaryCard.ts — the luminary decision card (imperative).
 *
 * Fun-audit Tier 4 (E2, 2026-10-02): the presidential decision card pinned
 * top-center while a luminary awaits an audience. Built once
 * (constructor), refreshed write-on-change (`update`) — the
 * envoyBanner.ts pattern: nodes are never rebuilt per frame, so no
 * AD11 digest segment is needed (the branch is registered in
 * HUD_PANEL_BRANCHES with a noDigestReason).
 *
 * The view comes from the pure contract (`luminaryCardView` in
 * ui/luminaries.ts); this widget only renders. Choice buttons call back
 * into game.ts, which enqueues the `resolveLuminary` command — the
 * widget never touches the sim.
 */
import { STRINGS, loc, fillLoc } from './strings';
import type { LuminaryCardView } from './luminaries';

/** Tiny DOM helper (same shape as envoyBanner.ts's local `el`). */
function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** mm:ss for the decision countdown. */
function mmss(secs: number): string {
  const s = Math.max(0, secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class LuminaryCard {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly choicesEl: HTMLElement;
  private lastKey = '';

  constructor(parent: HTMLElement, onChoose: (choiceId: string) => void) {
    const root = el('div', 'luminary-card');
    root.style.display = 'none';
    this.titleEl = el('div', 'luminary-card-title', '');
    root.append(this.titleEl);
    this.subEl = el('div', 'luminary-card-sub', '');
    root.append(this.subEl);
    this.choicesEl = el('div', 'luminary-card-choices');
    root.append(this.choicesEl);
    parent.append(root);
    this.root = root;
    // Choice buttons are rebuilt only when the card id changes (the
    // view key covers it); the click handler closes over the choice id.
    this.onChoose = onChoose;
  }

  private readonly onChoose: (choiceId: string) => void;

  /**
   * Refresh the card. Null hides it. The key is card + the whole
   * seconds left, so the countdown repaints ~1 Hz, not 30 Hz.
   */
  update(view: LuminaryCardView | null): void {
    if (view === null) {
      if (this.lastKey !== '') {
        this.lastKey = '';
        this.root.style.display = 'none';
      }
      return;
    }
    const s = STRINGS.luminaries;
    const time = mmss(view.secondsLeft);
    const key = `${view.cardId}|${time}`;
    if (key === this.lastKey) return;
    const cardChanged = !this.lastKey.startsWith(`${view.cardId}|`);
    this.lastKey = key;
    this.root.style.display = '';
    const titleKey = `title_${view.cardId}` as keyof typeof s;
    const flavorKey = `flavor_${view.cardId}` as keyof typeof s;
    this.titleEl.textContent = loc(s[titleKey] ?? s.title_cartographer);
    this.subEl.textContent = fillLoc(s.decidePrompt, { time });
    const flavor = s[flavorKey];
    if (flavor) {
      this.subEl.title = loc(flavor);
    }
    if (cardChanged) {
      this.choicesEl.replaceChildren();
      for (const choiceId of view.choices) {
        const labelKey = `${view.cardId}_${choiceId}_label` as keyof typeof s;
        const hintKey = `${view.cardId}_${choiceId}_hint` as keyof typeof s;
        const btn = document.createElement('button');
        btn.className = 'luminary-card-btn';
        if (choiceId === view.defaultChoiceId) btn.classList.add('luminary-card-default');
        const label = el('span', 'luminary-card-btn-label', loc(s[labelKey] ?? s.cartographer_chart_label));
        const hint = el('span', 'luminary-card-btn-hint', loc(s[hintKey] ?? s.cartographer_chart_hint));
        btn.append(label, hint);
        btn.addEventListener('click', () => this.onChoose(choiceId));
        this.choicesEl.append(btn);
      }
    }
  }
}
