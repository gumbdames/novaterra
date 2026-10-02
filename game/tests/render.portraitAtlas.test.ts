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
 * NOVATERRA — game/tests/render.portraitAtlas.test.ts — 0.1 Alpha.
 *
 * Tests for the build-time entity portrait atlas pipeline
 * (game/scripts/portrait-atlas.ts + portrait-models.ts, driven by
 * `npm run portraits`).
 *
 * Two halves:
 *  1. Committed artifacts (fast): game/public/img/entity-atlas.png/.json
 *     exist, the manifest covers every unit + building kind, every tile is
 *     in-bounds and non-blank, the PNG is within the 400KB budget, and the
 *     real UI parser (src/ui/entityPortraits.ts) accepts the manifest.
 *  2. Determinism (slower, ~15s): two full in-process atlas builds from the
 *     game's own model pipeline produce byte-identical PNG + manifest —
 *     the atlas is committed to the repo, so it must be reproducible.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { PNG } from 'pngjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  buildAtlas,
  manifestJson,
  renderPortrait,
  sha256Hex,
  PORTRAIT_TILE,
} from '../scripts/portrait-atlas';
import {
  allPortraitKinds,
  artKindFor,
  installNodeTextureHook,
  loadPortraitModels,
  piecesForKind,
  portraitModelKeys,
} from '../scripts/portrait-models';
import { parseAtlasManifest } from '../src/ui/entityPortraits';

const ATLAS_PNG_PATH = new URL('../public/img/entity-atlas.png', import.meta.url);
const ATLAS_JSON_PATH = new URL('../public/img/entity-atlas.json', import.meta.url);
const OVERRIDES_PATH = new URL('../scripts/portrait-overrides.json', import.meta.url);

/** The atlas must never silently eat the boot budget: hard cap in bytes. */
const PORTRAIT_ATLAS_BUDGET_BYTES = 400 * 1024;

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(ATLAS_JSON_PATH, 'utf8')) as Record<string, unknown>;
}

describe('portrait atlas: committed artifacts', () => {
  it('manifest covers every unit + building kind', () => {
    const kinds = allPortraitKinds();
    // Fun-audit D1 (2026-10-02): 99 units + 100 buildings.
    expect(kinds.length).toBe(199); // 99 units + 100 buildings
    const manifest = readManifest();
    const sprites = manifest['sprites'] as Record<string, { x: number; y: number; w: number; h: number }>;
    expect(Object.keys(sprites).sort()).toEqual([...kinds].sort());
  });

  it('the real UI parser accepts the committed manifest', () => {
    const parsed = parseAtlasManifest(readManifest());
    expect(parsed).not.toBeNull();
    expect(parsed!.tile).toBe(PORTRAIT_TILE);
    expect(parsed!.atlasWidth).toBe(16 * PORTRAIT_TILE);
    // Every kind the UI can look up resolves to a sprite.
    for (const kind of allPortraitKinds()) {
      expect(parsed!.sprites[kind]).toBeDefined();
    }
  });

  it('every manifest tile is in-bounds, 96px, and non-blank', () => {
    const manifest = readManifest();
    const sprites = manifest['sprites'] as Record<string, { x: number; y: number; w: number; h: number }>;
    const atlasWidth = manifest['atlasWidth'] as number;
    const atlasHeight = manifest['atlasHeight'] as number;
    const png = PNG.sync.read(readFileSync(ATLAS_PNG_PATH));
    expect(png.width).toBe(atlasWidth);
    expect(png.height).toBe(atlasHeight);
    // Tile origins are unique per art kind (variants share their base tile).
    const seen = new Set<string>();
    for (const [kind, s] of Object.entries(sprites)) {
      expect(s.w).toBe(PORTRAIT_TILE);
      expect(s.h).toBe(PORTRAIT_TILE);
      expect(s.x % PORTRAIT_TILE).toBe(0);
      expect(s.y % PORTRAIT_TILE).toBe(0);
      expect(s.x + s.w).toBeLessThanOrEqual(atlasWidth);
      expect(s.y + s.h).toBeLessThanOrEqual(atlasHeight);
      const key = `${s.x},${s.y}`;
      if (!seen.has(key)) {
        seen.add(key);
        // First kind on this tile: it must actually show the model.
        let opaque = 0;
        for (let y = 0; y < PORTRAIT_TILE; y++) {
          for (let x = 0; x < PORTRAIT_TILE; x++) {
            if (png.data[((s.y + y) * png.width + (s.x + x)) * 4 + 3]! > 128) opaque++;
          }
        }
        expect(opaque, `blank portrait tile for ${kind}`).toBeGreaterThan(300);
      }
    }
  });

  it('atlas PNG is within the 400KB budget', () => {
    const bytes = statSync(ATLAS_PNG_PATH).size;
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(PORTRAIT_ATLAS_BUDGET_BYTES);
  });
});

describe('portrait atlas: overrides file', () => {
  it('portrait-overrides.json is valid JSON with known kinds and sane values', () => {
    const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8')) as Record<string, unknown>;
    const kinds = new Set(allPortraitKinds());
    for (const [kind, o] of Object.entries(overrides)) {
      if (kind.startsWith('_')) continue; // _comment etc.
      expect(kinds.has(kind), `override for unknown kind ${kind}`).toBe(true);
      const ov = o as { distance?: unknown; angle?: unknown; yOffset?: unknown };
      if (ov.distance !== undefined) {
        expect(typeof ov.distance).toBe('number');
        expect(ov.distance as number).toBeGreaterThan(0.2);
        expect(ov.distance as number).toBeLessThan(5);
      }
      if (ov.angle !== undefined) {
        expect(typeof ov.angle).toBe('number');
        expect(ov.angle as number).toBeGreaterThanOrEqual(0);
        expect(ov.angle as number).toBeLessThan(360);
      }
      if (ov.yOffset !== undefined) expect(typeof ov.yOffset).toBe('number');
    }
  });
});

describe('portrait atlas: determinism', () => {
  it(
    'two full in-process builds produce byte-identical PNG + manifest',
    async () => {
      (globalThis as Record<string, unknown>)['createImageBitmap'] = undefined;
      installNodeTextureHook();
      const loader = new GLTFLoader();
      const loaded = await loadPortraitModels(loader, portraitModelKeys());
      const kinds = allPortraitKinds();
      const build = (): { png: Uint8Array; manifest: string } => {
        const renders = new Map<string, Uint8Array>();
        for (const kind of kinds) {
          const artKind = artKindFor(kind);
          if (!renders.has(artKind)) {
            renders.set(artKind, renderPortrait(piecesForKind(kind, loaded)));
          }
        }
        const { png, width, height, tiles } = buildAtlas(renders);
        return { png, manifest: manifestJson(tiles, kinds, artKindFor, width, height) };
      };
      const first = build();
      const second = build();
      expect(sha256Hex(second.png)).toBe(sha256Hex(first.png));
      expect(second.manifest).toBe(first.manifest);
      // And the committed artifacts match a fresh build (the atlas in the
      // repo is exactly what the pipeline produces — no hand edits).
      expect(sha256Hex(first.png)).toBe(sha256Hex(readFileSync(ATLAS_PNG_PATH)));
      expect(first.manifest).toBe(readFileSync(ATLAS_JSON_PATH, 'utf8'));
    },
    180000,
  );
});
