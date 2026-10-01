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
 * NOVATERRA — game/scripts/render-portraits.mjs — 0.1 Alpha.
 *
 * CLI: build the entity portrait atlas.
 *
 *   npm run portraits
 *   node scripts/render-portraits.mjs [--out-dir <dir>]
 *
 * Renders every unit + building kind (96 + 99) to a 96px 2.5D portrait
 * and writes:
 *   game/public/img/entity-atlas.png   — the sprite atlas (96px grid)
 *   game/public/img/entity-atlas.json  — the manifest (Worker B's
 *                                        ui/entityPortraits.ts consumes it)
 *
 * The atlas is committed to the repo (deterministic output — see
 * portrait-atlas.ts) and copied to dist/ by the build; the UI loads it
 * lazily at menu time, so it costs ZERO boot-budget bytes.
 *
 * Node module loading: the game sources are TypeScript using
 * extensionless relative imports (Vite convention). This script runs on
 * plain Node 24, so it registers scripts/ts-resolve-hooks.mjs (maps
 * `./x` → `./x.ts`) and relies on Node's built-in type stripping (the
 * game tree uses only erasable syntax). All game imports are dynamic
 * and happen AFTER the hook registration.
 *
 * Fails LOUD (non-zero exit) when any kind cannot be composed — a
 * broken model must never ship as a silent atlas gap.
 */

import { register } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register('./ts-resolve-hooks.mjs', import.meta.url);

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.dirname(SCRIPTS_DIR);

const args = process.argv.slice(2);
let outDir = path.join(GAME_DIR, 'public', 'img');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir' && args[i + 1]) {
    outDir = path.resolve(args[i + 1]);
    i++;
  }
}

const [
  { buildAtlas, manifestJson, renderPortrait, PORTRAIT_TILE, sha256Hex },
  models,
] = await Promise.all([
  import('./portrait-atlas.ts'),
  import('./portrait-models.ts'),
]);

const {
  installNodeTextureHook,
  loadPortraitModels,
  piecesForKind,
  allPortraitKinds,
  artKindFor,
  portraitModelKeys,
} = models;

// GLTFLoader picks ImageBitmapLoader when createImageBitmap exists; it
// does not under Node, so the TextureLoader patch below is the path
// taken. (Defensive: keep it undefined even if a future Node adds it.)
globalThis.createImageBitmap = undefined;
installNodeTextureHook();
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');

// --- per-kind overrides (kind → { distance, angle, yOffset }) ---
const overridesPath = path.join(SCRIPTS_DIR, 'portrait-overrides.json');
let overrides = {};
try {
  overrides = JSON.parse(readFileSync(overridesPath, 'utf8'));
} catch (err) {
  console.error(`portrait-overrides.json unreadable: ${err}`);
  process.exit(1);
}

// --- load the GLB keys the atlas needs ---
const keys = portraitModelKeys();
console.log(`loading ${keys.length} model keys…`);
const loader = new GLTFLoader();
const loaded = await loadPortraitModels(loader, keys, (done, total, key) => {
  if (done % 20 === 0 || done === total) console.log(`  ${done}/${total} ${key}`);
});

// --- render one portrait per ART kind (variants share the base tile) ---
const kinds = allPortraitKinds();
console.log(`rendering ${kinds.length} kinds…`);
const renders = new Map();
let done = 0;
for (const kind of kinds) {
  const artKind = artKindFor(kind);
  let px = renders.get(artKind);
  if (!px) {
    const pieces = piecesForKind(kind, loaded);
    px = renderPortrait(pieces, overrides[artKind] ?? overrides[kind]);
    renders.set(artKind, px);
  }
  done++;
  if (done % 40 === 0 || done === kinds.length) console.log(`  ${done}/${kinds.length}`);
}

// --- pack + write ---
const { png, width, height, tiles } = buildAtlas(renders);
const manifestText = manifestJson(tiles, kinds, artKindFor, width, height);

mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'entity-atlas.png'), png);
writeFileSync(path.join(outDir, 'entity-atlas.json'), manifestText);

const kb = (png.length / 1024).toFixed(1);
console.log(`wrote ${path.join(outDir, 'entity-atlas.png')} (${kb} KB, sha256 ${sha256Hex(png).slice(0, 12)}…)`);
console.log(`wrote ${path.join(outDir, 'entity-atlas.json')} (${kinds.length} entries, ${renders.size} tiles)`);
