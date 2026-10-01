/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This file is part of NOVATERRA. NOVATERRA is free software: you can
 * redistribute it and/or modify it under the terms of the GNU Affero General
 * Public License as published by the Free Software Foundation, either version
 * 3 of the License, or (at your option) any later version.
 *
 * NOVATERRA is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — game/scripts/ts-resolve-hooks.mjs — 0.1 Alpha.
 *
 * ESM loader hooks for Node build scripts that import the game's
 * TypeScript sources directly. Two jobs:
 *
 *   1. Resolve extensionless relative imports (`./terrain` -> `./terrain.ts`)
 *      the way Vite/vitest do, since Node ESM requires explicit extensions.
 *   2. Leave `.ts` files to Node 24's built-in type stripping (the whole
 *      game/src tree uses only erasable syntax — no enums, namespaces,
 *      or parameter properties — so no transform is needed).
 *
 * Usage: `node --import 'data:text/javascript,import { register } from
 * "node:module"; register("./scripts/ts-resolve-hooks.mjs")' scripts/<tool>.mts`
 * (see render-portraits.mts for the canonical invocation).
 *
 * Determinism note: resolution order is fixed (exact file, then `.ts`,
 * then `/index.ts`); no filesystem iteration order leaks in.
 */

import { existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

function tryFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

export async function resolve(specifier, context, nextResolve) {
  // Only rewrite relative specifiers; bare imports (three, node:*) pass through.
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const base = path.resolve(path.dirname(parentPath), specifier);
    // 1. Exact path as written (covers explicit `.ts` / `.mjs` / `.js`).
    // 2. Extensionless -> `.ts` (game sources).
    // 3. Directory -> `index.ts`.
    const candidates = [base, `${base}.ts`, path.join(base, 'index.ts')];
    for (const c of candidates) {
      const hit = tryFile(c);
      if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
