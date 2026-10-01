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
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tests/render.boot-budget.test.ts — final-review R3 (M11):
 * the 8 MiB boot gate, measured in BYTES, not model keys.
 *
 * The old gate pinned the 33-key boot set (see render.lazyModels.test.ts)
 * but never measured what those keys cost on the wire. This test sums
 * the actual transferred bytes of the boot payload:
 *
 *   transferred = gzip(html + js + css + GLTFLoader chunk)
 *               + raw(boot GLB files, deduplicated by file)
 *               + raw(external textures the boot GLBs reference)
 *               + raw(nature-tree textures, fetched at game start)
 *
 * Raw-vs-gzip choice (documented, 2026-10-01): GitHub Pages serves
 * `Content-Encoding: gzip` for text assets (html/js/css) to browsers
 * that send Accept-Encoding, so the gzipped size is the honest
 * transferred figure for those. GLB/jpg/png are already-compressed
 * binary — Pages serves them raw (gzip would shave ~1-3% at best), and
 * the Cache API stores the raw bytes. gzip is Node zlib level 6, a
 * proxy for Pages' own gzip — the gate's headroom (~49%) dwarfs any
 * level-to-level variance.
 *
 * What's in / out:
 *  - IN: dist/index.html, the script/stylesheet it references, the
 *    GLTFLoader chunk (dynamically imported by render/models.ts at the
 *    first loadModels call — i.e. during the boot model fetch), the
 *    pinned 33-key boot GLB set (deduplicated: rifleman.glb serves 3
 *    keys over one URL via cachedFetch), external `uri` textures inside
 *    those GLBs (Kenney colormap.png files), and the 5 nature-tree
 *    textures (loadNatureTreeModels runs at game start, ui/game.ts).
 *  - OUT: sourcemaps (never fetched without devtools), the bench
 *    runner chunk (`?bench=1` only, main.ts), all lazy models.
 *
 * Requires a build: run `npm run build` in game/ first (CI builds
 * before vitest). A missing dist/ fails loudly, not silently.
 *
 * Measured 2026-10-01: transferred ≈ 4.11 MiB (51.3% of 8 MiB);
 * raw (no gzip credit) ≈ 5.30 MiB (66.2%) — the prior 5.22 MiB / 65.3%
 * figure was this raw measurement. FAILS the suite above 8 MiB.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { bootModelKeys } from '../src/render/lazyModels';
import { MODEL_PATHS } from '../src/render/models';
import { NATURE_TREE_TEXTURE_PATHS } from '../src/render/natureTrees';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(GAME_DIR, 'dist');
const MIB = 1024 * 1024;
/** The 8 MiB startup-download budget (docs/grand-expansion/PLAN.md §10). */
const BOOT_BUDGET_BYTES = 8 * MIB;

function gzipBytes(p: string): number {
  return gzipSync(readFileSync(p), { level: 6 }).length;
}

/** ASCII `"uri":"<path>"` references inside a GLB's JSON chunk. */
function externalTextureUris(glbPath: string): string[] {
  const buf = readFileSync(glbPath);
  const text = buf.toString('latin1');
  const out: string[] = [];
  const re = /"uri"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const uri = m[1]!;
    // Embedded data URIs and absolute URLs are not extra downloads.
    if (uri.startsWith('data:') || /^[a-z]+:\/\//i.test(uri)) continue;
    out.push(uri);
  }
  return out;
}

interface BootPayload {
  lines: string[];
  transferred: number;
  raw: number;
}

function measureBootPayload(): BootPayload {
  const htmlPath = path.join(DIST, 'index.html');
  if (!existsSync(htmlPath)) {
    throw new Error(
      'boot budget: game/dist/index.html not found — run `npm run build` in game/ first, then re-run vitest.',
    );
  }
  const lines: string[] = [];
  let textGzip = 0;
  let textRaw = 0;
  let binRaw = 0;

  const html = readFileSync(htmlPath, 'utf8');
  const htmlGz = gzipBytes(htmlPath);
  textGzip += htmlGz;
  textRaw += statSync(htmlPath).size;
  lines.push(`index.html: ${htmlGz} B gzip`);

  // Script/stylesheet referenced by the boot HTML (same-origin refs).
  const refs = [...html.matchAll(/(?:src|href)="\/novaterra\/([^"]+)"/g)].map((m) => m[1]!);
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs) {
    const p = path.join(DIST, ref);
    expect(existsSync(p), `boot asset missing from dist: ${ref}`).toBe(true);
    const gz = gzipBytes(p);
    textGzip += gz;
    textRaw += statSync(p).size;
    lines.push(`${ref}: ${gz} B gzip`);
  }

  // GLTFLoader chunk: dynamically imported by render/models.ts at the
  // first loadModels() call — the boot model fetch — so it is boot
  // payload. (The bench runner chunk, ?bench=1 only, is excluded.)
  const chunks = readdirSync(path.join(DIST, 'assets'));
  const loaderChunk = chunks.find((c) => /^GLTFLoader-[^.]+\.js$/.test(c));
  expect(loaderChunk, 'GLTFLoader chunk not found in dist/assets').toBeDefined();
  const loaderGz = gzipBytes(path.join(DIST, 'assets', loaderChunk!));
  textGzip += loaderGz;
  textRaw += statSync(path.join(DIST, 'assets', loaderChunk!)).size;
  lines.push(`assets/${loaderChunk} (dynamic import at boot model load): ${loaderGz} B gzip`);

  // The pinned 33-key boot GLB set, deduplicated by file (cachedFetch
  // keys the Cache API by URL — one file downloads once).
  const bootFiles = new Map<string, string>(); // file -> first key
  for (const key of bootModelKeys()) {
    const spec = MODEL_PATHS[key];
    expect(spec, `boot key has no MODEL_PATHS entry: ${key}`).toBeDefined();
    const p = spec!.path;
    if (!bootFiles.has(p)) bootFiles.set(p, key);
  }
  let glbBytes = 0;
  const seenBin = new Set<string>();
  const addBinary = (rel: string): void => {
    const p = path.join(DIST, 'models', rel);
    expect(existsSync(p), `boot binary missing from dist: models/${rel}`).toBe(true);
    if (seenBin.has(p)) return;
    seenBin.add(p);
    const size = statSync(p).size;
    binRaw += size;
    glbBytes += size;
  };
  for (const file of bootFiles.keys()) {
    addBinary(file);
    // External textures the GLB references (Kenney colormap.png) are
    // fetched by GLTFLoader at parse time — boot downloads too.
    const dir = file.slice(0, file.lastIndexOf('/') + 1);
    for (const uri of externalTextureUris(path.join(DIST, 'models', file))) {
      addBinary(dir + uri);
    }
  }
  lines.push(
    `boot GLBs: ${bootFiles.size} unique files for ${bootModelKeys().length} keys: ${glbBytes} B raw`,
  );

  // Nature-tree textures: loadNatureTreeModels() runs at game start.
  let treeBytes = 0;
  for (const rel of Object.values(NATURE_TREE_TEXTURE_PATHS)) {
    const p = path.join(DIST, 'models', rel);
    expect(existsSync(p), `tree texture missing from dist: models/${rel}`).toBe(true);
    if (seenBin.has(p)) continue;
    seenBin.add(p);
    const size = statSync(p).size;
    binRaw += size;
    treeBytes += size;
  }
  lines.push(`nature-tree textures: ${treeBytes} B raw`);

  const transferred = textGzip + binRaw;
  lines.push(
    `TOTAL transferred: ${transferred} B = ${(transferred / MIB).toFixed(2)} MiB ` +
      `(gzip text ${textGzip} B + raw binary ${binRaw} B; raw-everything would be ${textRaw + binRaw} B)`,
  );
  return { lines, transferred, raw: textRaw + binRaw };
}

describe('boot budget (R3 M11)', () => {
  it('transferred boot payload stays within the 8 MiB budget', () => {
    const { lines, transferred, raw } = measureBootPayload();
    console.log(['[boot-budget]', ...lines].join('\n  '));
    expect(
      transferred,
      `boot payload ${(transferred / MIB).toFixed(2)} MiB (raw ${(
        raw / MIB
      ).toFixed(2)} MiB) exceeds the 8 MiB budget:\n  ${lines.join('\n  ')}`,
    ).toBeLessThanOrEqual(BOOT_BUDGET_BYTES);
  });
});
