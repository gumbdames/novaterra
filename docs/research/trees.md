<!---
  NOVATERRA — Copyright (C) 2026 Gumb Dames

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as published
  by the Free Software Foundation, version 3 of the License.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU Affero General Public License for more details.
-->

# Better trees for the nature scatter — research (2026-09-30)

> **Status:** CONCLUDED — implemented 2026-09-30 (0.1 Alpha).
> **Winner:** procedural tree geometry (smooth lathe trunks, layered
> foliage cards, no cones/blobs) textured with Quaternius's hand-painted
> CC0 bark/leaf textures — see `game/src/render/natureTrees.ts`.
> **Owner:** workstream C.

## The complaint (user directive 2026-09-30)

The nature-scatter trees "still look too square/pointy (crude cones/blobs)
and seem to lack proper texture." Standing art direction: realistic/detailed,
explicitly NOT blocky/Minecraft/voxel.

What shipped before: 6 Kenney Nature Kit GLBs (`tree_oak`, `tree_cone`,
`tree_pineTallA`, `tree_blocks`, `tree_detailed`, `tree_plateau`) —
50–402 tris each, **vertex-colored, zero textures**, flat-shaded cones and
blob clusters. The complaint is accurate: that is exactly what the kit is.

## Candidates evaluated

### (a1) Kenney Nature Kit "detailed" variants — REJECTED

Already in the repo (329 files surveyed). The whole kit is vertex-colored
flat-shaded low-poly from 2020; even `tree_detailed` (402 tris) is a
faceted blob. No textures exist for these models anywhere upstream. Picking
different files from the same kit cannot fix either half of the complaint.

### (a2) Quaternius Stylized Nature MegaKit (2026) — DEFERRED (best models on paper)

- https://quaternius.itch.io/stylized-nature-megakit — 116 models (40 trees),
  **all textured**, CC0 1.0 Universal, FBX/OBJ/**glTF** formats, "Ghibli-inspired"
  look, updated 2026-09-16. Rated 5.0/5 (80 ratings).
- Would have been the ideal (a) pick: same artist as the game's tanks/infantry,
  real textures, modern sculpts.
- **Blocked on download:** the itch.io "name your own price" purchase flow
  tarpits automated download — the page and CSRF form load fine, but POSTs to
  `/purchase` (price=0) either return `{"errors":["Please select a valid
  payment method"]}` or hang until timeout (30–60s, repeated). No direct file
  URL is exposed without completing that flow. Not a CAPTCHA, not Drive —
  just bot mitigation. No account exists to do it manually.
- **To unblock later:** the user (or a browser session) downloads
  `Stylized Nature MegaKit[Standard].zip` (99 MB, free) and drops it where an
  agent can read it; the glTF sources convert trivially and the texture set
  would supersede the five files below.

### (a3) Quaternius "Textured LowPoly Trees" 2020 pack (models) — REJECTED (unreachable)

- https://quaternius.itch.io/textured-lowpoly-trees — 45 textured tree models
  (FBX/OBJ/Blend) + 18 textures, CC0. Same itch.io download friction as (a2);
  OGA hosts only the *textures* without login, the model files need an OGA
  account. The 2020 models are "animal crossing" style — arguably not better
  than good procedural work anyway.

### (a4) Poly Pizza tree models — REJECTED (account wall)

Downloads need a free API key (per the real-models.md survey); no key
available to this workstream. Browsing is free but that doesn't ship models.

### (a5) OpenGameArt tree models — REJECTED (login + license roulette)

Model files need an OGA login; per-file license roulette (CC0/CC-BY/GPL
mixed) makes auditing a pack expensive. (OGA *texture* files, however,
download anonymously — see the winner.)

### (a6) Poly Haven 3D trees — REJECTED (incoherent + overweight)

CC0, GLB, direct CDN download — the pipeline would be easy. But the trees are
photoreal scans at 20k–60k tris: 10× over the per-model tri budget and a
completely different art language from the game's stylized cast. Rejected on
coherence and perf.

### (b) Pure procedural trees + generated textures — REJECTED as specified

Zero download bytes, perfectly deterministic, full art control — but
hand-generating bark/leaf textures from scratch (canvas noise) risks the same
"flat" read the user is complaining about. The texture half of the complaint
needs a real artist's hand.

### WINNER: (b+) procedural smooth geometry + Quaternius CC0 hand-painted textures

The textures from the (a3) pack *are* reachable: OpenGameArt serves each
texture file anonymously (verified 200s, 2026-09-30), every file page carries
the CC0 badge ("License(s): CC0", author quaternius, pack "LowPoly Textured
Trees", also published CC0 on the author's itch.io page). Five files:

| File | Use | Size | OGA source |
|---|---|---|---|
| `tree_bark.jpg` | broadleaf/conifer trunks | 768², 241 KB | opengameart.org/content/lowpoly-textured-trees-treebarkjpg |
| `birch_bark.png` | birch trunks | 768², 207 KB | (same pack) |
| `tree_leaves.png` | broadleaf canopy cards | 512² RGBA, 129 KB | (same pack) |
| `birch_leaves_green.png` | birch canopy cards | 512² RGBA, 126 KB | opengameart.org/node/160779 |
| `pine_leaves.png` | conifer tier cards | 512² RGBA, 125 KB | (same pack) |

Total ≈ 0.83 MB — and the six Kenney tree GLBs stay in the repo only as a
silent fallback (see below), so the net startup change is small.

Why this beats every (a): the geometry is built for the complaint — smooth
`LatheGeometry` trunks with root flare and taper (bark texture does the
close-up work), canopies of layered alpha-cut leaf cards over a dark inner
core (no cones, no blobs), conifers as drooping needle-frond tiers. All
species share the game's existing Quaternius hand-painted look, so the trees
sit *with* the tanks and infantry instead of fighting them. Determinism is
structural: `mulberry32` with fixed per-species seeds, no `Math.random`
anywhere — identical bytes on every platform. Tri budget ≈ 250–350/tree,
instanced exactly like today.

## What shipped (2026-09-30)

- `game/src/render/natureTrees.ts` — pure deterministic builders
  (`buildNatureTreeGeometry(kind)`, seeded) + `loadNatureTreeModels()`
  (loads the 5 textures with a bounded timeout, builds 6 `LoadedModel`s).
- `game/src/ui/game.ts` — loads tree models concurrently with the GLB batch
  inside the existing ~20 s startup budget; overlays them onto the model map
  (same prop keys, so `render/nature.ts` is untouched and the scatter stays
  bit-identical: same seeds → same cells, species, transforms).
- Fallback: the 6 Kenney tree GLBs remain in `MODEL_PATHS`; if texture
  loading fails the map keeps the old models and the game looks exactly like
  yesterday. Nothing can regress to *no* trees.
- 6 species replace the 6 old slots (keys renamed for honesty):
  `propTreeOak`, `propTreeBirch`, `propTreePineTall`, `propTreePine`,
  `propTreeOldOak`, `propTreePoplar`.
- Assets: `game/public/models/quaternius-nature/textures/` (5 files) +
  `LICENSE-CC0.txt` (evidence: author, CC0, pack + per-file OGA URLs,
  download date). `THIRD_PARTY_NOTICES.md` + `MANIFEST.md` updated.
- Budget: startup ≈ 4.62 MB GLB + 0.83 MB textures ≈ **5.45 MB** < 8 MB.
  In-scene: ~300 nature props worst case × ~0.3k tris ≈ 90k tris, one
  InstancedMesh per (species × part) — 6 species × 3 parts = 18 draw calls,
  all static. 60 fps holds (see §Perf below).
- **R3 re-measurement (2026-10-01):** the 5.45 MB above was raw bytes
  with no gzip credit. Byte-measured on a fresh build, the boot payload
  transfers **4.11 MiB (51.3% of the 8 MiB gate)** — 0.46 MiB gzipped
  text + 2.80 MiB boot GLBs (33 keys) + 0.79 MiB tree textures + 0.06 MiB
  external colormaps; 5.30 MiB raw-everything. Pinned by
  `game/tests/render.boot-budget.test.ts`; methodology in
  `docs/research/perf-r3.md`.

## Perf reasoning (why 60 fps holds)

- Trees are static `InstancedMesh`es built once per game (no per-frame CPU).
- Per-tree tri counts (measured from the builders): oak 364, birch 300,
  pineTall 198, pine 186, oldOak 428, poplar 332. Worst realistic
  map: ~8% of ~4096 scatter cells ≈ 330 props, ~55% trees ≈ 180 trees ×
  ~330 avg ≈ **60k tris**, 18 draw calls. The pre-change scatter was
  ~30–60k tris over 11 draw calls — same order, trivially inside the
  renderer's millions-of-tris headroom (the whole GLB library is 350k tris;
  the 60 fps budget test in `tests/perf.budgets.test.ts` is sim-side and
  untouched — nature is render-only, zero sim impact).
- Alpha-cut leaf cards: `alphaTest` (no transparent sorting, no overdraw
  spiral), `DoubleSide`, one shared material per texture — no per-instance
  state.
- Textures: 5 files, 0.83 MB total, GPU-resident once, shared across all
  instances. No per-frame uploads.

## Dead ends (this workstream)

- itch.io automated download of the MegaKit / 2020 tree pack: purchase-flow
  POSTs hang or demand a payment method (documented above). Did not retry
  more than a handful of times; documented as the unblock path instead.
- Google Drive: not attempted — user declined a Drive access request
  (standing rule, never ask again).
- Poly Pizza API key: not pursued — needs an account the workstream doesn't have.
- Re-texturing the Kenney trees: they have no UVs suitable for bark/leaf
  mapping (vertex-colored blobs); rejected in favor of geometry built for
  the textures.
