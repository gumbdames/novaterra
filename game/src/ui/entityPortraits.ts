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
 * NOVATERRA — ui/entityPortraits.ts — entity portraits from the sprite
 * atlas (consumer side).
 *
 * Responsibilities:
 *  - The consumer contract for the atlas pipeline (Worker A owns
 *    `game/public/img/entity-atlas.png` + `entity-atlas.json`):
 *    `hasPortrait(kind)` / `portraitStyle(kind, boxPx)`. The contract is
 *    data-driven: kinds with no atlas sprite report false and the UI
 *    keeps the hand-drawn SVG glyph from ui/icons.ts — no card is ever
 *    blank, and a missing/unreachable manifest degrades to pure glyph
 *    mode (the "manifest-missing resilience" the suite pins).
 *  - Manifest format (agreed with the atlas pipeline — do not change
 *    unilaterally; both workers note contract changes):
 *      {
 *        "image": "entity-atlas.png",   // PNG path, relative to the manifest URL
 *        "tile": 96,                    // default sprite tile size, px
 *        "atlasWidth": 1536,            // full atlas size, px
 *        "atlasHeight": 768,
 *        "sprites": { "<kind>": { "x": 0, "y": 0, "w": 96, "h": 96 } }
 *      }
 *    Per-sprite `w`/`h` are optional and default to `tile`; sprites are
 *    square tiles by convention (non-square sprites are fit-by-width
 *    and centered).
 *  - `applyPortraits(scope, makeOverlay)`: walks `[data-portrait-kind]`
 *    thumbnail hosts and appends one absolutely-positioned `.portrait`
 *    overlay per kind that has a sprite. Plain CSS sprites
 *    (`background-image` + `background-position` + `background-size`) —
 *    zero per-frame cost, no canvas work. The glyph stays underneath as
 *    the fallback and shows through until the PNG paints; the thumbnail
 *    box size is reserved up front by CSS, so there is never a layout
 *    shift.
 *
 * Loading strategy (measured, 2026-10-01): the atlas is LAZY — the
 * manifest JSON is fetched on first command-menu paint and the PNG
 * downloads once via the inline `background-image` on the first
 * portrait overlay (one URL, browser-cached). Nothing portrait-related
 * is referenced from index.html, the bundle, or a `<link rel=preload>`,
 * so the 8 MiB byte-measured boot gate
 * (tests/render.boot-budget.test.ts, currently ~4.11/8 MiB) gains zero
 * bytes. A preload would be justified only if the atlas shipped inside
 * the boot set — it does not.
 *
 * Digest contract (AD11): portraits are purely decorative. They add no
 * digest segment and never change digest output — the selection panel
 * rebuilds on content changes exactly as before, and hud.ts patches
 * overlays in after each build via `applyPortraits` without touching
 * the digest key. The `portrait` / `palette-thumb` / `detail-hero`
 * classes are claimed in HUD_PANEL_BRANCHES (paletteDigest.ts) with
 * this no-digest rationale.
 *
 * Accessibility: portrait overlays are `aria-hidden` — the button/card
 * text label stays the accessible name (the same pattern as the SVG
 * glyphs in ui/icons.ts).
 *
 * Headless-safe: no DOM access at module scope. `ensurePortraitsLoaded`
 * no-ops without `document`; `applyPortraits` works against a minimal
 * structural interface so the headless suite can drive it with fakes.
 */

export interface AtlasSprite {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasManifest {
  /** PNG file name, resolved relative to the manifest URL. */
  image: string;
  /** Default sprite tile size in px (per-sprite w/h fall back to this). */
  tile: number;
  /** Full atlas dimensions in px (needed for background-size math). */
  atlasWidth: number;
  atlasHeight: number;
  sprites: Record<string, AtlasSprite>;
}

/** Inline CSS for one portrait overlay (a CSS sprite cutout). */
export interface PortraitStyle {
  backgroundImage: string;
  backgroundPosition: string;
  backgroundSize: string;
  backgroundRepeat: 'no-repeat';
}

/** Default thumbnail box size (px) — the command-menu card icon cell. */
export const CARD_PORTRAIT_BOX_PX = 30;
/** Superweapon card icon cell (px). */
export const SW_CARD_PORTRAIT_BOX_PX = 34;
/** Selection detail "dossier photo" hero box (px). */
export const DETAIL_HERO_BOX_PX = 96;

const MANIFEST_REL_URL = 'img/entity-atlas.json';
const DEFAULT_IMAGE = 'entity-atlas.png';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Parse + validate an atlas manifest (pure — safe under Node/vitest).
 * Returns null for anything malformed: the UI then runs in pure glyph
 * mode instead of throwing.
 */
export function parseAtlasManifest(json: unknown): AtlasManifest | null {
  if (!isRecord(json)) return null;
  const spritesRaw = json['sprites'];
  if (!isRecord(spritesRaw)) return null;
  const tile = json['tile'];
  const atlasWidth = json['atlasWidth'];
  const atlasHeight = json['atlasHeight'];
  if (!isFiniteNumber(tile) || tile <= 0) return null;
  if (!isFiniteNumber(atlasWidth) || atlasWidth <= 0) return null;
  if (!isFiniteNumber(atlasHeight) || atlasHeight <= 0) return null;
  const image = json['image'];
  const sprites: Record<string, AtlasSprite> = {};
  for (const [kind, s] of Object.entries(spritesRaw)) {
    if (!isRecord(s)) return null;
    const x = s['x'];
    const y = s['y'];
    const w = s['w'] ?? tile;
    const h = s['h'] ?? tile;
    if (!isFiniteNumber(x) || x < 0) return null;
    if (!isFiniteNumber(y) || y < 0) return null;
    if (!isFiniteNumber(w) || w <= 0) return null;
    if (!isFiniteNumber(h) || h <= 0) return null;
    if (x + w > atlasWidth || y + h > atlasHeight) return null;
    sprites[kind] = { x, y, w, h };
  }
  return {
    image: typeof image === 'string' && image.length > 0 ? image : DEFAULT_IMAGE,
    tile,
    atlasWidth,
    atlasHeight,
    sprites,
  };
}

// ---------------------------------------------------------------------------
// Registry (populated once, lazily, by ensurePortraitsLoaded).
// ---------------------------------------------------------------------------

let manifest: AtlasManifest | null = null;
let imageUrl: string | null = null;
let loadPromise: Promise<boolean> | null = null;

/** Install a parsed manifest (used by ensurePortraitsLoaded and tests). */
export function loadManifestData(json: unknown, resolvedImageUrl: string): boolean {
  const parsed = parseAtlasManifest(json);
  if (parsed === null) return false;
  manifest = parsed;
  imageUrl = resolvedImageUrl;
  return true;
}

/** True once a manifest has been installed (atlas geometry known). */
export function portraitsReady(): boolean {
  return manifest !== null;
}

/** True when the atlas carries a sprite for this entity kind. */
export function hasPortrait(kind: string): boolean {
  return manifest !== null && manifest.sprites[kind] !== undefined;
}

/** The resolved atlas PNG URL (null until a manifest is installed). */
export function atlasImageUrl(): string | null {
  return imageUrl;
}

/** Test-only: drop the installed manifest and the in-flight load. */
export function clearPortraitRegistry(): void {
  manifest = null;
  imageUrl = null;
  loadPromise = null;
}

function fmtPx(v: number): string {
  // Two decimals max — keeps inline styles short and deterministic.
  const r = Math.round(v * 100) / 100;
  return `${r}px`;
}

/**
 * The inline CSS sprite cutout for a kind at a given display box size.
 * Scales the whole atlas so the sprite rect fills the (square) box;
 * non-square sprites are fit by width and centered. Returns null when
 * the kind has no sprite (caller keeps the glyph).
 *
 * `boxPx` defaults to the card thumbnail size so the agreed
 * one-argument `portraitStyle(kind)` call shape keeps working; pass
 * DETAIL_HERO_BOX_PX for the selection detail hero (the "bigger crop
 * via CSS scaling" — same sprite, larger box).
 */
export function portraitStyle(kind: string, boxPx: number = CARD_PORTRAIT_BOX_PX): PortraitStyle | null {
  const m = manifest;
  const url = imageUrl;
  if (m === null || url === null) return null;
  const s = m.sprites[kind];
  if (s === undefined) return null;
  if (!isFiniteNumber(boxPx) || boxPx <= 0) return null;
  const scale = boxPx / s.w;
  const dw = m.atlasWidth * scale;
  const dh = m.atlasHeight * scale;
  // Center the sprite rect in the box (exact fit for square tiles).
  const px = -(s.x * scale) + (boxPx - s.w * scale) / 2;
  const py = -(s.y * scale) + (boxPx - s.h * scale) / 2;
  return {
    backgroundImage: `url("${url}")`,
    backgroundPosition: `${fmtPx(px)} ${fmtPx(py)}`,
    backgroundSize: `${fmtPx(dw)} ${fmtPx(dh)}`,
    backgroundRepeat: 'no-repeat',
  };
}

/**
 * One-shot lazy load of the atlas manifest (fire-and-forget from the
 * HUD: glyphs render until this resolves). Resolves true when the
 * manifest installed cleanly, false on ANY failure — missing file,
 * HTTP error, bad JSON, no document — so the UI silently stays in
 * glyph mode. Never rejects.
 */
export function ensurePortraitsLoaded(fetchImpl?: typeof fetch): Promise<boolean> {
  if (loadPromise !== null) return loadPromise;
  loadPromise = (async (): Promise<boolean> => {
    try {
      if (typeof document === 'undefined') return false;
      const impl = fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
      if (impl === undefined) return false;
      const manifestUrl = new URL(MANIFEST_REL_URL, document.baseURI);
      const res = await impl(manifestUrl.toString());
      if (!res.ok) return false;
      const json: unknown = await res.json();
      // The manifest may name its own image file; honor it.
      const parsed = parseAtlasManifest(json);
      if (parsed === null) return false;
      const image = new URL(parsed.image, manifestUrl.toString()).toString();
      return loadManifestData(json, image);
    } catch {
      return false;
    }
  })();
  return loadPromise;
}

// ---------------------------------------------------------------------------
// DOM application.
// ---------------------------------------------------------------------------

/**
 * Minimal structural DOM surface applyPortraits needs, declared with
 * method shorthand (bivariant parameters) so real DOM nodes satisfy
 * these interfaces. The headless suite drives them with fakes (hud.ts
 * is DOM-only and never imported by vitest).
 */
export interface PortraitHost {
  getAttribute(name: string): string | null;
  querySelector(selectors: string): unknown;
  appendChild(child: unknown): unknown;
}

export interface PortraitScope {
  querySelectorAll(selectors: string): { length: number; [index: number]: PortraitHost };
}

export type PortraitOverlayFactory = (style: PortraitStyle) => PortraitHost | null;

/**
 * Walk `[data-portrait-kind]` thumbnail hosts under `scope` and append
 * one `.portrait` overlay per kind that has an atlas sprite. Idempotent
 * (hosts that already have an overlay are skipped) and a no-op until a
 * manifest is installed. Returns the number of overlays appended.
 */
export function applyPortraits(scope: PortraitScope, makeOverlay: PortraitOverlayFactory): number {
  if (!portraitsReady()) return 0;
  const thumbs = scope.querySelectorAll('[data-portrait-kind]');
  let applied = 0;
  for (let i = 0; i < thumbs.length; i++) {
    const thumb = thumbs[i];
    if (thumb === undefined) continue;
    if (thumb.querySelector(':scope > .portrait') !== null) continue;
    const kind = thumb.getAttribute('data-portrait-kind');
    if (kind === null) continue;
    const boxAttr = thumb.getAttribute('data-portrait-box');
    const boxPx = boxAttr === null ? CARD_PORTRAIT_BOX_PX : Number(boxAttr);
    const style = portraitStyle(kind, boxPx);
    if (style === null) continue;
    const overlay = makeOverlay(style);
    if (overlay === null) continue;
    thumb.appendChild(overlay);
    applied++;
  }
  return applied;
}
