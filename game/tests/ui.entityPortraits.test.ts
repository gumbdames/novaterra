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
 * NOVATERRA — tests/ui.entityPortraits.test.ts — entity portraits
 * (2026-10-01).
 *
 * Covers the atlas consumer contract (ui/entityPortraits.ts):
 *  - parseAtlasManifest: valid manifests parse (with tile/image
 *    defaults); anything malformed is null (pure glyph mode, never a
 *    throw).
 *  - Registry: hasPortrait / portraitStyle / portraitsReady /
 *    atlasImageUrl before and after install; unknown kinds stay false.
 *  - portraitStyle sprite math: background-position/size scale the
 *    atlas so the sprite rect fills the requested box.
 *  - ensurePortraitsLoaded: injected-fetch success installs the
 *    manifest; 404 / rejection / bad JSON / missing document all
 *    resolve false (never reject) and leave the registry empty.
 *  - applyPortraits (fake DOM — the suite is headless): appends one
 *    overlay per portrait-bearing thumbnail, skips kinds without a
 *    sprite and hosts that already have an overlay; no-op before the
 *    manifest is installed.
 *  - Manifest-missing resilience: the whole UI contract degrades to
 *    glyph mode with zero atlas.
 *  - Digest neutrality (AD11): selectionDigest() output never mentions
 *    portraits — they are decorative and must not move the rebuild
 *    key.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPortraits,
  atlasImageUrl,
  clearPortraitRegistry,
  ensurePortraitsLoaded,
  hasPortrait,
  loadManifestData,
  parseAtlasManifest,
  portraitStyle,
  portraitsReady,
  CARD_PORTRAIT_BOX_PX,
  DETAIL_HERO_BOX_PX,
  type PortraitHost,
  type PortraitScope,
  type PortraitStyle,
} from '../src/ui/entityPortraits';
import { TRAIN_TABS } from '../src/ui/palettes';
import { allBuildTabs } from '../src/ui/utilities';
import { createSession } from '../src/ui/session';
import { selectionDigest } from '../src/ui/paletteDigest';
import { createSelection } from '../src/ui/selection';

const SAMPLE_MANIFEST = {
  image: 'entity-atlas.png',
  tile: 96,
  atlasWidth: 192,
  atlasHeight: 96,
  sprites: {
    rifleman: { x: 0, y: 0 },
    tank: { x: 96, y: 0, w: 96, h: 96 },
  },
};
const SAMPLE_IMAGE_URL = 'https://example.test/novaterra/img/entity-atlas.png';

afterEach(() => {
  clearPortraitRegistry();
});

describe('parseAtlasManifest', () => {
  it('parses a valid manifest, defaulting w/h to tile', () => {
    const m = parseAtlasManifest(SAMPLE_MANIFEST);
    expect(m).not.toBeNull();
    expect(m!.tile).toBe(96);
    expect(m!.image).toBe('entity-atlas.png');
    expect(m!.sprites['rifleman']).toEqual({ x: 0, y: 0, w: 96, h: 96 });
    expect(m!.sprites['tank']).toEqual({ x: 96, y: 0, w: 96, h: 96 });
  });

  it('defaults a missing image name to entity-atlas.png', () => {
    const { image: _image, ...rest } = SAMPLE_MANIFEST;
    void _image;
    const m = parseAtlasManifest(rest);
    expect(m!.image).toBe('entity-atlas.png');
  });

  it('rejects malformed manifests (null, never throws)', () => {
    expect(parseAtlasManifest(null)).toBeNull();
    expect(parseAtlasManifest('nope')).toBeNull();
    expect(parseAtlasManifest({})).toBeNull();
    expect(parseAtlasManifest({ ...SAMPLE_MANIFEST, sprites: null })).toBeNull();
    expect(parseAtlasManifest({ ...SAMPLE_MANIFEST, tile: 0 })).toBeNull();
    expect(parseAtlasManifest({ ...SAMPLE_MANIFEST, atlasWidth: -5 })).toBeNull();
    expect(
      parseAtlasManifest({
        ...SAMPLE_MANIFEST,
        sprites: { rifleman: { x: 0 } },
      }),
    ).toBeNull();
    // Sprite hanging off the atlas edge.
    expect(
      parseAtlasManifest({
        ...SAMPLE_MANIFEST,
        sprites: { rifleman: { x: 100, y: 0, w: 96, h: 96 } },
      }),
    ).toBeNull();
  });
});

describe('portrait registry', () => {
  it('starts empty: no portraits, not ready, no image URL', () => {
    expect(portraitsReady()).toBe(false);
    expect(hasPortrait('rifleman')).toBe(false);
    expect(atlasImageUrl()).toBeNull();
    expect(portraitStyle('rifleman', 30)).toBeNull();
  });

  it('installs via loadManifestData; unknown kinds stay false', () => {
    expect(loadManifestData(SAMPLE_MANIFEST, SAMPLE_IMAGE_URL)).toBe(true);
    expect(portraitsReady()).toBe(true);
    expect(hasPortrait('rifleman')).toBe(true);
    expect(hasPortrait('tank')).toBe(true);
    expect(hasPortrait('fighter')).toBe(false);
    expect(atlasImageUrl()).toBe(SAMPLE_IMAGE_URL);
  });

  it('loadManifestData rejects bad JSON without installing', () => {
    expect(loadManifestData({ nope: true }, SAMPLE_IMAGE_URL)).toBe(false);
    expect(portraitsReady()).toBe(false);
  });
});

describe('portraitStyle sprite math', () => {
  it('scales the atlas so the sprite rect fills the box', () => {
    loadManifestData(SAMPLE_MANIFEST, SAMPLE_IMAGE_URL);
    // Sprite b at (96,0), 96px tile, 48px box → 0.5× scale.
    const s = portraitStyle('tank', 48)!;
    expect(s.backgroundImage).toBe(`url("${SAMPLE_IMAGE_URL}")`);
    expect(s.backgroundPosition).toBe('-48px 0px');
    expect(s.backgroundSize).toBe('96px 48px');
    expect(s.backgroundRepeat).toBe('no-repeat');
    // The origin sprite at full hero scale.
    const hero = portraitStyle('rifleman', DETAIL_HERO_BOX_PX)!;
    expect(hero.backgroundPosition).toBe('0px 0px');
    expect(hero.backgroundSize).toBe('192px 96px');
    // Default box = the card thumbnail.
    const def = portraitStyle('rifleman')!;
    expect(def.backgroundSize).toBe(
      `${(192 * CARD_PORTRAIT_BOX_PX) / 96}px ${(96 * CARD_PORTRAIT_BOX_PX) / 96}px`,
    );
  });

  it('returns null for unknown kinds and bad box sizes', () => {
    loadManifestData(SAMPLE_MANIFEST, SAMPLE_IMAGE_URL);
    expect(portraitStyle('fighter', 48)).toBeNull();
    expect(portraitStyle('tank', 0)).toBeNull();
    expect(portraitStyle('tank', -3)).toBeNull();
  });
});

describe('ensurePortraitsLoaded', () => {
  const realDocument = (globalThis as Record<string, unknown>)['document'];
  afterEach(() => {
    (globalThis as Record<string, unknown>)['document'] = realDocument;
  });

  function stubDocument(): void {
    (globalThis as Record<string, unknown>)['document'] = {
      baseURI: 'https://example.test/novaterra/',
    };
  }

  function okFetch(json: unknown): typeof fetch {
    return (async () => ({
      ok: true,
      json: async () => json,
    })) as unknown as typeof fetch;
  }

  it('installs the manifest on success and resolves true', async () => {
    stubDocument();
    const ok = await ensurePortraitsLoaded(okFetch(SAMPLE_MANIFEST));
    expect(ok).toBe(true);
    expect(portraitsReady()).toBe(true);
    expect(hasPortrait('tank')).toBe(true);
    // The image URL resolves against the manifest URL.
    expect(atlasImageUrl()).toBe('https://example.test/novaterra/img/entity-atlas.png');
  });

  it('resolves false (never rejects) when the manifest 404s', async () => {
    stubDocument();
    const notFound = (async () => ({ ok: false })) as unknown as typeof fetch;
    await expect(ensurePortraitsLoaded(notFound)).resolves.toBe(false);
    expect(portraitsReady()).toBe(false);
    expect(hasPortrait('rifleman')).toBe(false);
  });

  it('resolves false when the fetch rejects or the JSON is bad', async () => {
    stubDocument();
    const failing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(ensurePortraitsLoaded(failing)).resolves.toBe(false);
    clearPortraitRegistry();
    const badJson = (async () => ({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    })) as unknown as typeof fetch;
    await expect(ensurePortraitsLoaded(badJson)).resolves.toBe(false);
    expect(portraitsReady()).toBe(false);
  });

  it('resolves false with no document (headless)', async () => {
    delete (globalThis as Record<string, unknown>)['document'];
    await expect(ensurePortraitsLoaded(okFetch(SAMPLE_MANIFEST))).resolves.toBe(false);
    expect(portraitsReady()).toBe(false);
  });

  it('is single-flight: a second call reuses the first promise', async () => {
    stubDocument();
    let calls = 0;
    const counting = (async () => {
      calls++;
      return { ok: true, json: async () => SAMPLE_MANIFEST };
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([
      ensurePortraitsLoaded(counting),
      ensurePortraitsLoaded(counting),
    ]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyPortraits with fake DOM (the suite is headless).
// ---------------------------------------------------------------------------

class FakeOverlay implements PortraitHost {
  cls = '';
  ariaHidden = false;
  style: Record<string, string> = {};
  getAttribute(_name: string): string | null {
    return null;
  }
  querySelector(_selectors: string): unknown {
    return null;
  }
  appendChild(child: Node): Node {
    return child;
  }
}

class FakeThumb implements PortraitHost {
  children: FakeOverlay[] = [];
  constructor(private readonly attrs: Record<string, string>) {}
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  querySelector(selectors: string): unknown {
    if (selectors === ':scope > .portrait') {
      return this.children.find((c) => c.cls === 'portrait') ?? null;
    }
    return null;
  }
  appendChild(child: Node): Node {
    this.children.push(child as unknown as FakeOverlay);
    return child;
  }
}

class FakeScope implements PortraitScope {
  constructor(private readonly thumbs: FakeThumb[]) {}
  querySelectorAll(_selectors: string): { length: number; [index: number]: PortraitHost } {
    return this.thumbs;
  }
}

function makeFactory(made: FakeOverlay[]): (style: PortraitStyle) => PortraitHost | null {
  return (style: PortraitStyle): PortraitHost | null => {
    const o = new FakeOverlay();
    o.cls = 'portrait';
    o.ariaHidden = true;
    Object.assign(o.style, style);
    made.push(o);
    return o;
  };
}

function thumb(kind: string, boxPx: number): FakeThumb {
  return new FakeThumb({ 'data-portrait-kind': kind, 'data-portrait-box': String(boxPx) });
}

describe('applyPortraits', () => {
  it('is a no-op before the manifest is installed', () => {
    const made: FakeOverlay[] = [];
    const scope = new FakeScope([thumb('rifleman', 30)]);
    expect(applyPortraits(scope, makeFactory(made))).toBe(0);
    expect(made).toHaveLength(0);
  });

  it('overlays portrait kinds, skips glyph-only kinds', () => {
    loadManifestData(SAMPLE_MANIFEST, SAMPLE_IMAGE_URL);
    const made: FakeOverlay[] = [];
    const rifle = thumb('rifleman', 30);
    const tank = thumb('tank', 96);
    const fighter = thumb('fighter', 30); // no sprite → glyph stays
    const scope = new FakeScope([rifle, tank, fighter]);
    expect(applyPortraits(scope, makeFactory(made))).toBe(2);
    expect(rifle.children).toHaveLength(1);
    expect(tank.children).toHaveLength(1);
    expect(fighter.children).toHaveLength(0);
    const rifleOverlay = rifle.children[0]!;
    expect(rifleOverlay.cls).toBe('portrait');
    expect(rifleOverlay.ariaHidden).toBe(true);
    expect(rifleOverlay.style['backgroundImage']).toBe(`url("${SAMPLE_IMAGE_URL}")`);
    expect(rifleOverlay.style['backgroundPosition']).toBe('0px 0px');
    // 30px box on a 96px tile → 0.3125× scale.
    expect(rifleOverlay.style['backgroundSize']).toBe('60px 30px');
  });

  it('is idempotent: hosts that already have an overlay are skipped', () => {
    loadManifestData(SAMPLE_MANIFEST, SAMPLE_IMAGE_URL);
    const made: FakeOverlay[] = [];
    const rifle = thumb('rifleman', 30);
    const scope = new FakeScope([rifle]);
    expect(applyPortraits(scope, makeFactory(made))).toBe(1);
    expect(applyPortraits(scope, makeFactory(made))).toBe(0);
    expect(rifle.children).toHaveLength(1);
  });
});

describe('manifest-missing resilience (pure glyph mode)', () => {
  it('the whole contract degrades to glyphs with zero atlas', () => {
    // No manifest installed (afterEach cleared it): every consumer
    // path says "no portrait" and the UI keeps the SVG glyphs.
    expect(portraitsReady()).toBe(false);
    for (const kind of ['rifleman', 'tank', 'barracks', 'lab']) {
      expect(hasPortrait(kind)).toBe(false);
      expect(portraitStyle(kind, 30)).toBeNull();
    }
    const made: FakeOverlay[] = [];
    const scope = new FakeScope([thumb('rifleman', 30), thumb('barracks', 30)]);
    expect(applyPortraits(scope, makeFactory(made))).toBe(0);
  });
});

describe('digest neutrality (AD11)', () => {
  it('selectionDigest output never mentions portraits', () => {
    const session = createSession({ seed: 4242 });
    const digest = selectionDigest(session.world, createSelection(), 'infantry', 'housing');
    expect(digest).not.toContain('portrait');
  });
});

describe('atlas pipeline contract (Worker A)', () => {
  const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestPath = join(GAME_DIR, 'public', 'img', 'entity-atlas.json');
  const atlasPresent = existsSync(manifestPath);

  it.skipIf(!atlasPresent)(
    'the generated atlas covers every kind the command menu renders',
    () => {
      // Pins the Worker A contract end-to-end: if a regeneration drops
      // a kind, the suite fails loudly instead of the card silently
      // falling back to its glyph. Skipped when the generated atlas is
      // absent — the UI contract is pure glyph mode then (see the
      // resilience suite above), so this must not fail on a checkout
      // without the generated files.
      const json: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(loadManifestData(json, 'https://example.test/img/entity-atlas.png')).toBe(true);
      const kinds = new Set<string>();
      for (const t of TRAIN_TABS) for (const k of t.kinds) kinds.add(k);
      for (const t of allBuildTabs()) for (const k of t.kinds) kinds.add(k as string);
      kinds.add('aegisControl');
      kinds.add('stormArray');
      const missing = [...kinds].filter((k) => !hasPortrait(k));
      expect(missing).toEqual([]);
      // The hero path scales the same sprites — spot-check one.
      expect(portraitStyle('barracks', DETAIL_HERO_BOX_PX)).not.toBeNull();
    },
  );
});
