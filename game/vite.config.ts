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

// NOVATERRA — Vite 8 build config.
//
// - `base` is the GitHub Pages project-site path:
//   https://gumbdames.github.io/novaterra/.
// - `vite build` emits plain static assets into game/dist (deployed as-is).
// - The vitest `test` section keeps one config file for build + test.
import { defineConfig } from 'vitest/config';
import { execSync } from 'node:child_process';

/**
 * Build identifier stamped into the client (2026-10-05): short git SHA +
 * UTC timestamp, e.g. "76e5e48-20261005T143022". Shown in the menu
 * footer and Settings so "which build are you on" is answerable —
 * stale browser tabs keep old JS in memory indefinitely, and without
 * this there was no way to tell. UI-only: never touches the sim.
 */
function buildId(): string {
  let sha = 'unknown';
  try {
    sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Not a git checkout (or git missing) — timestamp alone still orders builds.
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `${sha}-${stamp}`;
}

export default defineConfig({
  base: '/novaterra/',
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Keep chunks predictable for the static Pages host.
    chunkSizeWarningLimit: 1500,
  },
  test: {
    // Headless sim/unit tests run in Node — no DOM, no GPU.
    // (The boot module is import-safe under Node by design; see main.ts.)
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
