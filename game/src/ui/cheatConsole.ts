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
 * NOVATERRA — ui/cheatConsole.ts — the cheat console (Phase 1, step 11).
 *
 * Responsibilities:
 *  - `parseCheatCommand(input)`: pure, testable mapping from a typed line
 *    to a `CheatAction`. Case-insensitive, whitespace-tolerant.
 *  - `CheatConsole`: DOM overlay (toggle with backtick). Input line,
 *    scrollback output, command history (Up/Down). Emits parsed actions
 *    to the game controller via `onCheat`; the controller executes them
 *    (sim cheats go through the command queue with `issuer: 'cheat'`).
 *
 * The console never touches sim state directly — same rule as all UI.
 * Copy comes from ui/strings.ts.
 */

import { STRINGS } from './strings';

/** Actions the console can produce. Sim-affecting ones are marked. */
export type CheatAction =
  | { kind: 'grant' } // prosperity now — sim command
  | { kind: 'instantBuild' } // fast build — sim command
  | { kind: 'reveal' } // no fog of war in 0.1 Alpha — UI no-op + message
  | { kind: 'win' } // victory overlay (UI)
  | { kind: 'lose' } // defeat overlay (UI)
  | { kind: 'help' } // list commands (UI)
  | { kind: 'unknown'; input: string };

/**
 * Parse one console line. Pure: no DOM, no sim. Returns the action the
 * controller should execute.
 */
export function parseCheatCommand(input: string): CheatAction {
  const line = input.trim().toLowerCase().replace(/\s+/g, ' ');
  switch (line) {
    case 'prosperity now':
      return { kind: 'grant' };
    case 'fast build':
    case 'fastbuild':
      return { kind: 'instantBuild' };
    case 'reveal':
    case 'fow off':
      return { kind: 'reveal' };
    case 'win':
      return { kind: 'win' };
    case 'lose':
      return { kind: 'lose' };
    case 'help':
    case '?':
      return { kind: 'help' };
    case '':
      return { kind: 'unknown', input: '' };
    default:
      return { kind: 'unknown', input: input.trim() };
  }
}

/** One-line help text for the console (also used by the `help` action). */
export function cheatHelpText(): string {
  const s = STRINGS.cheats;
  return [s.helpGrant, s.helpBuild, s.helpReveal, s.helpWin, s.helpLose].join('\n');
}

export interface CheatConsoleActions {
  /** A parsed cheat action to execute. */
  onCheat(action: CheatAction): void;
}

/**
 * The console overlay. `toggle()` shows/hides; typing + Enter emits the
 * parsed action. History survives across toggles within one game.
 */
export class CheatConsole {
  private readonly root: HTMLElement;
  private readonly actions: CheatConsoleActions;
  private overlay: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private output: HTMLElement | null = null;
  private readonly history: string[] = [];
  private historyIndex = -1;

  constructor(root: HTMLElement, actions: CheatConsoleActions) {
    this.root = root;
    this.actions = actions;
  }

  get visible(): boolean {
    return this.overlay !== null;
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    if (this.visible) return;
    const s = STRINGS.cheats;
    const overlay = document.createElement('div');
    overlay.className = 'cheat-console';

    const output = document.createElement('div');
    output.className = 'cheat-output';
    overlay.append(output);
    this.output = output;

    const input = document.createElement('input');
    input.className = 'cheat-input';
    input.type = 'text';
    input.placeholder = s.placeholder;
    input.setAttribute('aria-label', s.placeholder);
    input.addEventListener('keydown', (e) => this.onKey(e));
    overlay.append(input);
    this.input = input;

    this.root.append(overlay);
    this.overlay = overlay;
    this.print(s.welcome);
    input.focus();
  }

  hide(): void {
    this.overlay?.remove();
    this.overlay = null;
    this.input = null;
    this.output = null;
    this.historyIndex = -1;
  }

  /** Append a line to the scrollback. */
  print(line: string): void {
    if (!this.output) return;
    const div = document.createElement('div');
    div.className = 'cheat-line';
    div.textContent = line;
    this.output.append(div);
    this.output.scrollTop = this.output.scrollHeight;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.input) return;
    if (e.key === 'Enter') {
      const line = this.input.value;
      this.input.value = '';
      if (line.trim().length === 0) return;
      this.history.push(line);
      this.historyIndex = this.history.length;
      this.print(`> ${line}`);
      this.actions.onCheat(parseCheatCommand(line));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (this.history.length === 0) return;
      this.historyIndex = Math.max(0, this.historyIndex - 1);
      this.input.value = this.history[this.historyIndex] ?? '';
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (this.history.length === 0) return;
      this.historyIndex = Math.min(this.history.length, this.historyIndex + 1);
      this.input.value = this.historyIndex < this.history.length
        ? (this.history[this.historyIndex] ?? '')
        : '';
    } else if (e.key === 'Escape' || e.key === '`') {
      e.preventDefault();
      this.hide();
    }
    // Stop the game from seeing console keystrokes (Space = pause etc.).
    e.stopPropagation();
  }
}
