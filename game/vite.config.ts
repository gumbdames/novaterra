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

export default defineConfig({
  base: '/novaterra/',
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
