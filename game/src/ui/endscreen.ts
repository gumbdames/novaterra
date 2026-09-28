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
 * NOVATERRA — ui/endscreen.ts — victory / defeat overlay (step 11).
 *
 * Responsibilities:
 *  - `EndScreen`: full-screen overlay with a victory or defeat message,
 *    "Keep playing" (dismiss) and "Exit to menu" buttons.
 *  - Triggered by the `win` / `lose` cheat console commands in 0.1
 *    Alpha. A future conquest system (Phase 1 exit criteria) will call
 *    the same `showVictory()` / `showDefeat()` — the overlay is the hook.
 *
 * Pure DOM. Copy comes from ui/strings.ts.
 */

import { STRINGS } from './strings';

export interface EndScreenActions {
  /** Dismiss the overlay and keep playing. */
  onKeepPlaying(): void;
  /** Leave the game and return to the main menu. */
  onExitToMenu(): void;
}

export class EndScreen {
  private readonly root: HTMLElement;
  private readonly actions: EndScreenActions;
  private el: HTMLElement | null = null;

  constructor(root: HTMLElement, actions: EndScreenActions) {
    this.root = root;
    this.actions = actions;
  }

  get visible(): boolean {
    return this.el !== null;
  }

  showVictory(): void {
    this.show('victory');
  }

  showDefeat(): void {
    this.show('defeat');
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }

  private show(kind: 'victory' | 'defeat'): void {
    this.hide();
    const s = STRINGS.end;
    const overlay = document.createElement('div');
    overlay.className = `end-screen end-${kind}`;
    const panel = document.createElement('div');
    panel.className = 'end-panel';

    const title = document.createElement('h2');
    title.textContent = kind === 'victory' ? s.victoryTitle : s.defeatTitle;
    panel.append(title);

    const detail = document.createElement('p');
    detail.textContent = kind === 'victory' ? s.victoryDetail : s.defeatDetail;
    panel.append(detail);

    const keep = document.createElement('button');
    keep.textContent = s.keepPlaying;
    keep.addEventListener('click', () => {
      this.hide();
      this.actions.onKeepPlaying();
    });
    const exit = document.createElement('button');
    exit.textContent = s.exitToMenu;
    exit.addEventListener('click', () => {
      this.hide();
      this.actions.onExitToMenu();
    });
    panel.append(keep, exit);
    overlay.append(panel);
    this.root.append(overlay);
    this.el = overlay;
  }
}
