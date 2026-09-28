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

// postbuild: stamp a short AGPL-3.0-only notice at the top of every emitted
// JS chunk, so the license travels with the built game even though the
// bundler strips source comments. Runs automatically via `npm run build`
// (the `postbuild` npm lifecycle hook). CSS/HTML already keep their `/*!`
// and `<!--` headers through the build.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BANNER =
  '/*! NOVATERRA — Copyright (C) 2026 Gumb Dames. ' +
  'Licensed under the GNU Affero General Public License v3.0 only. ' +
  'See https://www.gnu.org/licenses/agpl-3.0.html */\n';

const dir = new URL('../dist/assets/', import.meta.url);
let stamped = 0;
for (const file of readdirSync(dir)) {
  if (!file.endsWith('.js')) continue;
  const path = join(dir.pathname, file);
  const code = readFileSync(path, 'utf8');
  if (code.startsWith('/*! NOVATERRA')) continue; // idempotent
  writeFileSync(path, BANNER + code);
  stamped++;
}
console.log(`stamp-license: stamped ${stamped} JS chunk(s)`);
