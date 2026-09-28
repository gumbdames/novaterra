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
 * NOVATERRA — ui/saveslots.ts — save/load slot picker dialog (step 11).
 *
 * Responsibilities:
 *  - `SaveSlotsDialog`: modal listing the autosave + 3 manual slots with
 *    their metadata (name, date, tick, age, difficulty, cheated marker)
 *    or "Empty". In `save` mode clicking a slot picks it; in `load`
 *    mode clicking an occupied slot loads it. Empty slots are disabled
 *    in load mode.
 *  - `formatSaveSummary(meta)`: one-line human summary, pure and
 *    testable (no DOM).
 *
 * Pure DOM + pure formatting. Copy comes from ui/strings.ts.
 */

import type { SaveMetadata, SaveSlotId } from '../net_save/savefile';
import { SAVE_SLOT_IDS } from '../net_save/savefile';
import { STRINGS } from './strings';

export type SaveSlotsMode = 'save' | 'load';

export interface SaveSlotsActions {
  /** A slot was picked. In load mode the slot is always occupied. */
  onPickSlot(slotId: SaveSlotId): void;
  /** Dialog dismissed without picking. */
  onClose(): void;
}

/** One-line summary of a save for the slot list. Pure. */
export function formatSaveSummary(meta: SaveMetadata): string {
  const s = STRINGS.save;
  const date = new Date(meta.savedAt);
  const dateStr = Number.isNaN(date.getTime()) ? meta.savedAt : date.toLocaleString();
  const age = meta.program ? `${meta.age} (${meta.program})` : meta.age;
  const cheated = meta.cheated ? ` · ${s.cheatedTag}` : '';
  return s.slotSummary
    .replace('{name}', meta.name)
    .replace('{date}', dateStr)
    .replace('{tick}', String(meta.tick))
    .replace('{age}', age)
    .replace('{difficulty}', meta.aiDifficulty)
    .replace('{cheated}', cheated);
}

export class SaveSlotsDialog {
  private readonly root: HTMLElement;
  private readonly mode: SaveSlotsMode;
  private readonly saves: SaveMetadata[];
  private readonly actions: SaveSlotsActions;
  private el: HTMLElement | null = null;

  constructor(
    root: HTMLElement,
    mode: SaveSlotsMode,
    saves: SaveMetadata[],
    actions: SaveSlotsActions,
  ) {
    this.root = root;
    this.mode = mode;
    this.saves = saves;
    this.actions = actions;
  }

  show(): void {
    this.hide();
    const s = STRINGS.save;
    const overlay = document.createElement('div');
    overlay.className = 'saveslots-overlay';
    const panel = document.createElement('div');
    panel.className = 'saveslots-panel';
    panel.append(Object.assign(document.createElement('h2'), {
      textContent: this.mode === 'save' ? s.saveTitle : s.loadTitle,
    }));

    const bySlot = new Map<SaveSlotId, SaveMetadata>();
    for (const m of this.saves) bySlot.set(m.slotId, m);

    for (const slotId of SAVE_SLOT_IDS) {
      const meta = bySlot.get(slotId);
      const btn = document.createElement('button');
      btn.className = 'saveslot';
      if (meta) {
        btn.textContent = formatSaveSummary(meta);
        btn.addEventListener('click', () => {
          this.hide();
          this.actions.onPickSlot(slotId);
        });
      } else {
        btn.textContent = s.slotEmpty;
        btn.disabled = this.mode === 'load';
        if (this.mode === 'save') {
          btn.addEventListener('click', () => {
            this.hide();
            this.actions.onPickSlot(slotId);
          });
        }
      }
      panel.append(btn);
    }

    const close = document.createElement('button');
    close.textContent = s.cancel;
    close.addEventListener('click', () => {
      this.hide();
      this.actions.onClose();
    });
    panel.append(close);
    overlay.append(panel);
    this.root.append(overlay);
    this.el = overlay;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}
