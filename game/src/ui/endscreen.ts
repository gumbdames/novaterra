/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3.0 of the License.
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
 *  - Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
 *    `showVictory(title?, detail?)` / `showDefeat(title?, detail?)` take
 *    optional copy overrides so the peaceful end screens can say what
 *    actually happened (the defaults stay the conquest/cheat copy —
 *    existing callers pass nothing and see no change).
 *  - Exploration bet C6 (2026-10-02): illustrated endscreens. Six
 *    AI-generated illustrations (4 victory kinds + 2 defeat kinds) live
 *    in `game/public/img/endscreens/` and are lazy-loaded — the image
 *    URL is first touched when an end screen shows, so the 3.4 MB of
 *    art never enters the boot payload (see the 8 MiB gate in
 *    tests/render.boot-budget.test.ts). Art direction (user directive
 *    2026-10-02): photorealistic contemporary Earth — a modern coastal
 *    city and harbor, realistic present-day military hardware,
 *    believable city lights, natural sky. NOT sci-fi: no floating
 *    airships, no glowing mega-spires, no alien skies. No text is
 *    baked into any image — all copy stays in ui/strings.ts (English
 *    and English only).
 *
 * Pure DOM. Copy comes from ui/strings.ts.
 */

import { STRINGS } from './strings';

/**
 * The six end-screen illustrations (exploration bet C6, 2026-10-02):
 * one per victory kind (conquest/economic/population/monument) and one
 * per defeat kind (annihilation = wiped out; race = lost the race to a
 * rival). Campaign endings reuse these for now — no separate
 * campaign-ending art.
 */
export type EndArt =
  | 'victory-conquest'
  | 'victory-economic'
  | 'victory-population'
  | 'victory-monument'
  | 'defeat-annihilation'
  | 'defeat-race';

/** All six art keys, in a fixed order (tests + docs). */
export const END_ARTS: readonly EndArt[] = [
  'victory-conquest',
  'victory-economic',
  'victory-population',
  'victory-monument',
  'defeat-annihilation',
  'defeat-race',
];

/**
 * Relative URL of an end-screen illustration. Relative (not absolute)
 * so it resolves under the vite `base` (`/novaterra/`) — the same
 * pattern as the entity-atlas manifest in ui/entityPortraits.ts.
 * The file is fetched only when an end screen shows (lazy).
 */
export function endArtUrl(art: EndArt): string {
  return `img/endscreens/${art}.jpg`;
}

/**
 * Default art for a show call that names no art: conquest for victory
 * (the classic default copy), annihilation for defeat.
 */
export function defaultEndArt(kind: 'victory' | 'defeat'): EndArt {
  return kind === 'victory' ? 'victory-conquest' : 'defeat-annihilation';
}

export interface EndScreenActions {
  /** Dismiss the overlay and keep playing. */
  onKeepPlaying(): void;
  /** Leave the game and return to the main menu. */
  onExitToMenu(): void;
  /**
   * Fired when the overlay becomes visible (victory or defeat).
   * The game controller uses it to play the victory/defeat stinger
   * (final-review R5, 2026-10-01) and to start the cinematic camera
   * drift (exploration bet C6, 2026-10-02).
   */
  onShow?(kind: 'victory' | 'defeat'): void;
  /**
   * Fired when the overlay is dismissed (exploration bet C6,
   * 2026-10-02). The game controller uses it to stop the camera drift
   * and restore the player's camera.
   */
  onHide?(): void;
}

export class EndScreen {
  private readonly root: HTMLElement;
  private readonly actions: EndScreenActions;
  private el: HTMLElement | null = null;
  private art: EndArt | null = null;

  constructor(root: HTMLElement, actions: EndScreenActions) {
    this.root = root;
    this.actions = actions;
  }

  get visible(): boolean {
    return this.el !== null;
  }

  /** The art currently displayed (null when hidden) — for tests. */
  get currentArt(): EndArt | null {
    return this.art;
  }

  showVictory(title?: string, detail?: string, art?: EndArt): void {
    this.show('victory', title, detail, art ?? defaultEndArt('victory'));
  }

  showDefeat(title?: string, detail?: string, art?: EndArt): void {
    this.show('defeat', title, detail, art ?? defaultEndArt('defeat'));
  }

  hide(): void {
    if (this.el === null) return;
    this.el.remove();
    this.el = null;
    this.art = null;
    this.actions.onHide?.();
  }

  private show(
    kind: 'victory' | 'defeat',
    title: string | undefined,
    detail: string | undefined,
    art: EndArt,
  ): void {
    this.hide();
    this.actions.onShow?.(kind);
    const s = STRINGS.end;
    const overlay = document.createElement('div');
    overlay.className = `end-screen end-${kind}`;
    // Exploration bet C6: the illustration, lazy-loaded — the browser
    // fetches the URL only now, at show time, never at boot. A dark
    // gradient over the art keeps the copy readable while the
    // battlefield tableau stays visible behind the semi-transparent
    // panel.
    overlay.style.backgroundImage =
      `linear-gradient(rgba(4, 8, 14, 0.55), rgba(4, 8, 14, 0.55)), url("${endArtUrl(art)}")`;
    overlay.style.backgroundSize = 'cover';
    overlay.style.backgroundPosition = 'center';
    // Warm the cache for the sibling art so a second end screen (e.g.
    // defeat after victory in a long session) paints instantly.
    if (typeof Image !== 'undefined') {
      const sibling =
        kind === 'victory' ? defaultEndArt('defeat') : defaultEndArt('victory');
      const preload = new Image();
      preload.src = endArtUrl(sibling);
    }
    const panel = document.createElement('div');
    panel.className = 'end-panel';

    const titleEl = document.createElement('h2');
    titleEl.textContent =
      title ?? (kind === 'victory' ? s.victoryTitle : s.defeatTitle);
    panel.append(titleEl);

    const detailEl = document.createElement('p');
    detailEl.textContent =
      detail ?? (kind === 'victory' ? s.victoryDetail : s.defeatDetail);
    panel.append(detailEl);

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
    this.art = art;
  }
}
