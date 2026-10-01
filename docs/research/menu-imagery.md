# Menu imagery: 96px 2.5D entity portraits (0.1 Alpha)

**Date:** 2026-10-01 · **Scope:** `main` · **Author:** portrait-atlas worker (Worker A)

Renders every unit (96) and building (99) kind to a 96px 2.5D portrait at
build time, packs them into a single sprite atlas
(`game/public/img/entity-atlas.png` + `.json`), and serves them to the
command sidebar's card grid and entity detail panel
(`game/src/ui/entityPortraits.ts`, Worker B).

## 1. Why not reuse the ui-icons decision?

`docs/research/ui-icons.md` (2026-09-30) **rejected** build-time 3D
thumbnails — correctly, for its surface: 30–34px palette buttons, where a
bold SVG silhouette beats a 3D render for legibility, and where ~150–400KB
of PNGs "must load before menus render".

The 2026-10-01 command-menu rebuild changed the surface: a slim icon rail
with a **card grid** (icon + name + cost per card) and a click-any-entity
**detail panel** with a 96px hero portrait. At 96px a shaded 3D portrait of
the actual in-game model is far more informative than a silhouette, and the
atlas is **lazy-loaded at menu time** — it costs zero boot-budget bytes
(`public/img/` is not in the boot set; see `render.boot-budget.test.ts`).
The ui-icons rejection still stands for the 30px buttons; portraits serve
the new 96px surfaces.

## 2. Rendering approach: CPU rasterizer over the game's own geometry

**Chosen.** `game/scripts/portrait-atlas.ts` implements a small,
deterministic software renderer (2× supersampled z-buffer, 3/4 perspective
at azimuth 45° / elevation 26°, Lambert + hemisphere + camera fill + fake
env-for-metals, ACES-Hill tone map, sRGB, transparent background). It does
**not** reimplement the art pipeline — `game/scripts/portrait-models.ts`
feeds it the game's own processed geometry:

- GLB: three.js GLTFLoader (Node) → `normalizeModel` → `extractModelGeometry`
  → `applySurfaceTreatment`, exactly mirroring `render/entities.ts`
  (`loadOneModel`); composite buildings assemble their GLB pieces with the
  same footprint offsets as `modelSourceFor`.
- Procedural: the real `buildProceduralModel(kind)` builders (deterministic —
  no `Math.random` anywhere in the procedural tree).
- Props: the same `EntityRenderer.propSpecsFor` switch the game uses
  (antenna, turret, crates, runway strips, …), so a portrait never misses a
  part the game shows.

Tech variants (28 kinds) share their base kind's tile via `variantArtBase`,
exactly like `modelSourceFor` — pixel-identical art, one tile.

### 2.1 Dead ends (tried, rejected, with reasons)

- **`gl` (headless-gl) npm package** — three.js r186 requires **WebGL2**;
  headless-gl only implements WebGL1, has no Node 24 prebuilds, and its
  node-gyp fallback cannot download headers in this environment. Dead.
- **WebGL1 shims / software GL** — same WebGL2 requirement. Dead.
- **Headless Chromium via shell** — no system Chromium installed here;
  driving a browser from a build script is heavy and fragile compared to a
  600-line deterministic rasterizer. Rejected.
- **Screenshot-the-game approach** — requires booting the full game
  headless; same Chromium problem, plus non-deterministic framing. Rejected.

### 2.2 Node texture loading (the two gotchas)

GLTFLoader under Node needed two shims, both contained in
`installNodeTextureHook()` (`game/scripts/portrait-models.ts`):

1. `globalThis.self = globalThis` — GLTFLoader reads `self.URL`; also
   `globalThis.createImageBitmap = undefined` is asserted so the parser
   takes the `TextureLoader` path (Node 24 has no `createImageBitmap`).
   Embedded `bufferView` images arrive as `blob:` URLs; Node's
   `Blob.arrayBuffer()` is async, so a `Blob` subclass stashes the
   constructor parts synchronously and a `URL.createObjectURL` wrapper maps
   each object URL back to its bytes (revoked after use, mirroring the
   browser). External `Textures/*.png` URIs resolve against
   `game/public/models/`. Decoded with `pngjs` (devDependency); GLTFLoader's
   `flipY = false` assignment is honored so sampling matches the game.
   - Real bug caught by this: 12 styloo plane models embed a 256×256
     palette PNG; the first implementation dropped blob URLs, so planes
     rendered flat white instead of their red/green/blue livery. Fixed and
     covered by the zero-texture-error assertion path in tests.

## 3. Determinism

No RNG, no wall-clock, no timestamps anywhere: fixed camera rig, sorted
kind order, fixed 16-column grid, zlib level 9, PNG with no ancillary
chunks (no tEXt/iCCP/pHYs). `tests/render.portraitAtlas.test.ts` builds
the full atlas twice in-process and asserts byte-identical PNG + manifest,
and that the committed artifacts match a fresh build — the atlas is
committed to the repo, so reproducibility is a test, not an aspiration.

## 4. Atlas encoding: paletted PNG under the 400KB budget

The source textures (Kenney colormaps, procedural surfaces) carry fine
painted grain that is invisible at 96px but cost ~840KB as RGBA PNG.
`encodePngPaletted()` applies a deterministic global median-cut to 256
entries (index 0 reserved for transparent; per-entry alpha via tRNS),
bringing the atlas to **189KB** with no visible change at thumbnail size
(verified by upscaled tile inspection: no banding, clean edges).
`PORTRAIT_ATLAS_BUDGET_BYTES` (400KB) is asserted by
`tests/render.portraitAtlas.test.ts`.

## 5. Manifest contract

`game/public/img/entity-atlas.json`:

```json
{ "version": 1, "image": "entity-atlas.png", "tile": 96,
  "atlasWidth": 1536, "atlasHeight": 1056,
  "sprites": { "<kind>": { "x": 0, "y": 0, "w": 96, "h": 96 } } }
```

195 entries (every unit + building kind; variants point at their base
kind's tile), keys sorted. This is the contract `src/ui/entityPortraits.ts`
parses (Worker B, committed `af2ec4d`); the test suite runs the real
`parseAtlasManifest` against the committed file.

## 6. Results (2026-10-01)

- 195 kinds → 167 tiles (16-col grid, 1536×1056), atlas **189KB** ≤ 400KB.
- `npm run portraits` regenerates both files in ~7s; per-kind camera
  overrides live in `game/scripts/portrait-overrides.json` (empty — the
  auto-fit framing was judged good on full-atlas visual review).
- Boot budget unaffected: 4.11/8 MiB (atlas is lazy, not in the boot set).
- Gate: `npx vitest run` green, `npx tsc --noEmit` clean, `npm run build`
  clean (license stamps intact).
