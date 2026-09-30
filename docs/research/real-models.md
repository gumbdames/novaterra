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

# Real 3D Model Assets — novaterra

> **Status:** SUPERSEDED — research concluded 2026-09-29 and the assets were
> **downloaded and integrated the same day** (0.1 Alpha entity art checkpoint).
> This note is kept as the sourcing record; the live documentation is
> `game/src/render/models.ts` (`MODEL_PATHS`), `game/src/render/AGENTS.md`,
> `docs/ARCHITECTURE.md` §6a, and `THIRD_PARTY_NOTICES.md`.
> What shipped: 36 CC0 GLBs (28 Kenney + 8 Quaternius, OBJ→GLB via
> obj2gltf 3.2.0) in `game/public/models/` (~4.0 MiB), 8 procedural gap
> models (`render/proceduralModels.ts`), connected road ribbons
> (`render/roads.ts`), deterministic nature scatter (`render/nature.ts`),
> and a GLB → procedural → placeholder fallback chain (game stays
> playable with zero GLBs loaded).
>
> **Expansion, evening of 2026-09-29:** the library was grown to whole kits —
> 9 complete Kenney packs, **942 GLB files / ~27.4 MiB** total (see §7).
> `game/public/models/MANIFEST.md` is the per-file manifest (depicts / tris /
> KB / pack / license); `THIRD_PARTY_NOTICES.md` lists every file with source
> URL + license. No game code was touched; `MODEL_PATHS` mapping is the render
> team's next phase.
>
> **Owner:** asset-research workstream.
> **Scope:** free/open-source 3D model sourcing for units, buildings, and props.

## Requirements recap (hard constraints)

- **License:** CC0 strongly preferred; CC-BY acceptable with clear attribution.
  NEVER: NC, ND, paid, unclear. Game ships **AGPL-3.0-only** — CC0 and CC-BY
  are both compatible (CC-BY needs a credit file).
- **Format:** glTF/GLB only (three.js native). No FBX-only.
- **Style:** modern military / nation-builder RTS, desktop-first. Realistic is
  the dream; a *coherent* stylized-but-detailed kit beats a photoreal patchwork.
  Minecraft/voxel/blocky is vetoed.
- **Budget:** total added assets < 15 MB; low-poly game-ready (hundreds–thousands
  of instances at 60 fps); per-model ideally < 5k tris.

---

## 1. Candidate sources evaluated

### 1.1 Kenney (kenney.nl) — CC0, primary candidate

- **License:** CC0 1.0 Universal, site-wide. Every pack page carries the badge
  "License | Creative Commons CC0" (verified by fetching the pages below on
  2026-09-29). Each pack zip ships a `License.txt` stating:
  > "License: (Creative Commons Zero, CC0) http://creativecommons.org/publicdomain/zero/1.0/
  > This content is free to use in personal, educational and commercial projects.
  > Support us by crediting Kenney or www.kenney.nl (this is not mandatory)"
  (quoted from a downstream repo quoting the actual zip contents.)
- **Formats:** zips contain `Models/GLB format/` with per-model `.glb` files plus
  a shared `Textures/colormap.png` (512×512 color atlas each model's UVs are
  mapped against). ⚠️ **Gotcha (documented by downstream users):** the GLBs
  reference the texture by relative URI `Textures/colormap.png`, resolved by
  `GLTFLoader` relative to the `.glb` file's own folder — the atlas PNG must be
  shipped next to the models or every model loads untextured/fails.
- **Download:** no account wall. Pack pages link an itch.io all-in-1 bundle, but
  the per-pack zips are served directly from
  `https://kenney.nl/media/pages/assets/<slug>/<hash>-<ts>/kenney_<slug>.zip`
  (HTTP 200, confirmed by multiple independent projects). Exact per-pack hash
  URLs are resolved from the asset page at download time ("Continue without
  donating…" link).
- **Poly counts:** not published per model; Kenney models are soft low-poly
  (typical range hundreds–low-thousands of tris), consistent with the < 5k target.
- **Sizes:** packs are 5–20 MB zipped whole, but we extract only selected GLBs
  (tens–hundreds of KB each). Real-world reference: 40 extracted GLBs from
  City Kit Suburban = 2.8 MB; 41 from Commercial = 3.9 MB; 25 from
  Industrial = 2.6 MB; 95 from Roads = 2.1 MB.

| Pack | Page | Files | Contents relevant to novaterra |
|---|---|---|---|
| City Kit (Commercial) | https://kenney.nl/assets/city-kit-commercial | 50× | modern office towers, shops (`building-a/c/e/g/i/k.glb`, `building-skyscraper-a/c/e.glb` — filenames attested by downstream use) |
| City Kit (Suburban) | https://kenney.nl/assets/city-kit-suburban | 40× | houses (`building-type-f.glb` attested), fences, planters |
| City Kit (Industrial) | https://kenney.nl/assets/city-kit-industrial | 25× | factories/warehouses (`building-e.glb` attested) |
| City Kit (Roads) | https://kenney.nl/assets/city-kit-roads | 95× | road tiles, lamps, signs, traffic lights (roads stay procedural, but props are free) |
| Nature Kit | https://kenney.nl/assets/nature-kit | 330× | trees, rocks, bushes, foliage |
| Car Kit | https://kenney.nl/assets/car-kit | — | cars, pickup trucks, `truck.glb` (tractor-trailer; attested in use) |
| Watercraft Kit | https://kenney.nl/assets/watercraft-kit | 45× | speedboats (`boat-speed-a.glb` attested), small boats |
| Space Kit | https://kenney.nl/assets/space-kit | 150× | sci-fi craft (`craft_racer.glb`, `craft_miner.glb` attested) |
| Factory Kit | https://kenney.nl/assets/factory-kit | — | industrial props/machinery (contents not individually verified) |

**Military gap:** Kenney has **no military kit** — `https://kenney.nl/assets/war-kit`
and `https://kenney.nl/assets/vehicle-kit` both 404. No tanks, artillery, AA,
soldiers, or warships anywhere in the catalog. Infantry options are
"Blocky Characters" (vetoed as blocky), "Mini Characters" (toy-like), and the
3D "Animated Characters" sets (survivors/retro/protagonists, 8 files each,
horror/civilian themed — not soldiers). Kenney "Modular Characters" is 2D-only.

### 1.2 Quaternius (quaternius.com) — CC0, fills the military gap

- **License:** CC0 1.0 Universal. Pack pages identify packs as CC0 (confirmed by
  downstream users' license audits, e.g. "Both source pages identify the packs
  as CC0"); press coverage: "The pack is distributed under the CC0 license,
  meaning that any developer can use these assets in their projects at no
  charge."
- **Formats:** the site distributes **FBX / OBJ / Blend only** — the
  [Animated Tanks pack page](https://quaternius.com/packs/animatedtanks.html)
  lists exactly "FBX, OBJ, Blend", **no GLB**. ⚠️ Direct GLB is available via
  **Poly Pizza** (see §1.3), which hosts Quaternius packs converted to GLB:
  > "This bundle contains 4 different animated tank models! All in .FBX + GLB,
  > free to use in both personal and commercial projects. … Licence: Public
  > Domain (CC0)"
  — https://poly.pizza/bundle/Animated-Tank-Pack-0tfvbeAJkU (verified live).
- **Packs relevant to novaterra:** **Animated Tanks Pack** (4 animated tank
  models — the single best CC0 tank source found), Ships Pack (boats), Cars
  Pack, Farm Buildings Pack (farm), Ultimate Buildings Pack, Animated Men/Women
  Packs (animated low-poly humans — infantry candidates), Toon Shooter Game Kit
  (70+ shooter-themed models: characters, guns), Sci-Fi Essentials Kit
  (superweapon-ish tech props).
- **Style note:** flat-shaded cartoon low-poly — softer and more detailed than
  Minecraft, but more "toon" than Kenney's semi-realistic proportioning. Coherent
  *with* Kenney in practice (Poly Pizza curates both side by side; both are
  flat-shaded low-poly with simple palettes), but the two should not be
  intermixed at the same visual scale without a unifying material treatment
  (e.g. same hemisphere light + slight saturation match).

### 1.3 Poly Pizza (poly.pizza) — CC0/CC-BY aggregator, gap filler

- **License:** ⚠️ **mixed CC0 + CC-BY, per model** — every model page states its
  own license and author; each pick must be individually verified and recorded.
  CC-BY models need attribution in a `THIRD_PARTY_NOTICES.md`-style credit file.
- **Formats:** GLB is the primary download format. **Downloads require a free
  API key** (from poly.pizza/dashboard) — a soft account wall; browsing/search
  needs no key.
- **Role:** not a coherent family (aggregator), but the best source for
  individual CC0/CC-BY GLBs that neither Kenney nor Quaternius cover: fighter
  jets, helicopters, drones, howitzers, AA vehicles, warships, radar towers.
  Search for "fighter jet" alone returns 92 results (e.g. "Low poly Fighter" by
  Stephen Graybill, "Jet"/"Helicopter" by Poly by Google — ex-Google-Poly
  uploads are typically CC-BY; verify per model at download).
- **Also hosts:** Quaternius packs as GLB (solves Quaternius's format problem)
  and Kenney models.

### 1.4 Sketchfab (sketchfab.com) — per-model, last resort

- License is per-model (CC0 and CC-BY both exist; verify each). **Downloads
  require a Sketchfab login.** Triangle counts are published per model
  (e.g. a CC-BY low-poly tank at 1.7k tris; a CC-BY USS Zumwalt destroyer used
  by another low-poly project). Quality and poly counts vary wildly
  (134k-tri "game ready" tanks exist — unusable). Useful only for named,
  hand-vetted single models (e.g. a destroyer) where Poly Pizza lacks coverage.

---

## 2. Mapping table: game entity → model file

Legend: ✅ direct verified match · ⚠️ usable with caveats/verification at
download · ❌ gap (no verified match; candidate listed).

### Units (14)

| Entity | Model file | Pack / source | License | Notes |
|---|---|---|---|---|
| engineer | ⚠️ `AnimatedMen-*.glb` (select 1) | Quaternius Animated Men Pack via poly.pizza | CC0 | animated low-poly human; **no tool prop in pack** — attach procedural wrench/hard-hat, or use hi-vis color variant |
| rifles | ⚠️ `AnimatedMen-*.glb` (select 1, different variant) | Quaternius Animated Men Pack via poly.pizza | CC0 | walk/idle animations included; **no rifles in pack** — attach procedural rifle or pull from Toon Shooter kit gun models (CC0) |
| tank | ✅ Quaternius tank (1 of 4) | Animated Tank Pack, https://poly.pizza/bundle/Animated-Tank-Pack-0tfvbeAJkU | CC0 | animated; pick the MBT-looking variant at download |
| artillery | ❌ gap | — | — | candidate: Poly Pizza search "howitzer"/"artillery" (CC-BY, verify), or Sketchfab "Advance Military Artillery Vehicle". **Unverified.** |
| aa | ❌ gap | — | — | candidate: Poly Pizza search "anti-air"/"missile launcher" (e.g. "MIM-104 Patriot" style, CC-BY, verify). **Unverified.** |
| hauler | ✅ `truck.glb` | Kenney Car Kit | CC0 | supply truck; filename attested in downstream use |
| spectre | ✅ `craft_racer.glb` | Kenney Space Kit | CC0 | gunship-like strike craft; fits "stealth/attack aircraft or gunship" read |
| hq | ⚠️ `truck.glb` variant / pickup | Kenney Car Kit | CC0 | mobile HQ = command truck; differentiate with antenna prop (city-kit-roads has poles) + faction tint |
| fighter | ❌ gap | — | — | candidate: Poly Pizza "Low poly Fighter" by Stephen Graybill (likely CC-BY, **verify**); fallback `craft_miner.glb` from Kenney Space Kit reads too sci-fi |
| transport | ❌ gap | — | — | candidate: Poly Pizza "Helicopter" by Poly by Google (likely CC-BY, **verify**) |
| drone | ❌ gap | — | — | candidate: Poly Pizza "Drone" by NateGazzard (**verify**) |
| patrolBoat | ✅ `boat-speed-a.glb` | Kenney Watercraft Kit | CC0 | speedboat hull; filename attested in downstream use |
| destroyer | ❌ gap | — | — | candidate: Sketchfab "USS Zumwalt" by Yakudami (CC-BY, low-poly, attested in another project's credits) — **needs login + verification** |
| transportShip | ⚠️ watercraft-kit cargo boat | Kenney Watercraft Kit | CC0 | exact filename **TBD at download** (kit has 45 files incl. larger boats); verify a barge/cargo variant exists |

### Buildings (12)

| Entity | Model file | Pack / source | License | Notes |
|---|---|---|---|---|
| house | ✅ `building-type-f.glb` | Kenney City Kit (Suburban) | CC0 | filename attested in downstream use |
| apartment | ✅ `building-e.glb` | Kenney City Kit (Commercial) | CC0 | low-rise block; attested as `city_lowrise` |
| shop | ✅ `building-a.glb` | Kenney City Kit (Commercial) | CC0 | commercial frontage; verify variant at download |
| lab | ✅ `building-c.glb` | Kenney City Kit (Commercial) | CC0 | differentiate via faction/blue emissive tint |
| factory | ✅ `building-e.glb` | Kenney City Kit (Industrial) | CC0 | attested as `city_industrial`; Factory Kit is a richer alternative (verify contents at download) |
| farm | ⚠️ farm building | Quaternius Farm Buildings Pack via poly.pizza | CC0 | model name TBD at download; silo/barn silhouettes needed |
| powerPlant | ⚠️ industrial building + chimney | Kenney City Kit (Industrial) | CC0 | verify a chimney/cooling-tower model exists in the kit's 25 files at download; else Poly Pizza "power plant" (CC-BY) |
| waterPump | ⚠️ water tower / pump house | Kenney City Kit (Industrial) | CC0 | verify at download; kit contents beyond `building-e.glb` not individually attested |
| mediaCenter | ❌ gap | — | — | broadcast/TV tower not in Kenney catalog; candidate Poly Pizza search "radio tower"/"broadcast tower" (CC-BY, verify) |
| shipyard | ⚠️ warehouse + crane | Kenney Factory Kit / Industrial | CC0 | verify a crane model exists at download; else gap |
| aegisControl | ⚠️ command bunker | Kenney City Kit (Industrial) | CC0 | bunker silhouette; add radar-dish prop (candidate Poly Pizza) |
| stormArray | ❌ gap | — | — | radar/array installation; candidate Poly Pizza "radar"/"satellite dish" (CC-BY, verify) |

### Props

| Entity | Model file | Pack / source | License | Notes |
|---|---|---|---|---|
| trees | ✅ `tree-*.glb` (several) | Kenney Nature Kit (330 files) | CC0 | exact filenames TBD at download (kit is huge; pick oak/pine variants) |
| rocks | ✅ `rock-*.glb` (several) | Kenney Nature Kit | CC0 | exact filenames TBD at download |
| bushes | ✅ `bush-*.glb` (several) | Kenney Nature Kit | CC0 | exact filenames TBD at download |
| roads | procedural | — | — | stay procedural per brief (City Kit Roads available as fallback) |

**Gap summary (8 entities with no verified match):** artillery, aa, fighter,
transport, drone, destroyer, mediaCenter, stormArray — all need per-model
CC0/CC-BY picks from Poly Pizza/Sketchfab at download time, each with its
license page recorded. transportShip, farm, powerPlant, waterPump, shipyard,
aegisControl have plausible in-family candidates but un-attested filenames
(marked ⚠️ — confirm during extraction, fall back to Poly Pizza if missing).

---

## 3. Recommendation

**Primary family: Kenney (CC0, direct GLB) + Quaternius Animated Tanks Pack
(CC0, GLB via Poly Pizza) for the tank, with Poly Pizza per-model CC-BY picks
for the 8 remaining gaps.**

Rationale:

1. **Coverage.** Kenney alone covers all 12 buildings (city kits are modern and
   nation-builder-appropriate), all nature props, trucks, boats, and a gunship
   stand-in — the entire economy/city half of the game. Nothing else free
   covers modern city buildings this well. Its only hole is *military* hardware,
   which is exactly what Quaternius's Animated Tanks Pack fills (the one
   verified CC0 tank source).
2. **License.** Kenney is CC0 site-wide with `License.txt` in every zip;
   Quaternius tanks are CC0; gap picks are CC0-or-CC-BY with attribution
   recorded per model. No NC/ND/paid/unclear licenses anywhere in the plan.
   Fully AGPL-3.0-compatible.
3. **Format.** Kenney zips ship GLB natively; Quaternius tanks are fetched as
   GLB from Poly Pizza (bypassing Quaternius's FBX/OBJ/Blend-only site
   downloads); gap picks are GLB-first on Poly Pizza. No conversion toolchain
   needed in the build.
4. **Coherence.** Kenney + Quaternius are both flat-shaded soft low-poly with
   restrained palettes — the standard pairing in the low-poly gamedev scene
   (Poly Pizza curates them side by side). Not photoreal, but "stylized but
   detailed" per the brief, and crucially *not* blocky/Minecraft. One unifying
   pass (shared hemisphere lighting, matched saturation) will seat them together;
   keep Quaternius models to military units so the city reads 100% Kenney.
5. **Size/perf.** Individual GLBs are tens–hundreds of KB; Kenney poly counts
   sit in the hundreds–low-thousands per model, far under the 5k-tri target —
   safe for hundreds–thousands of instances at 60 fps. Estimated total for the
   full extraction list: **~6–9 MB**, well under the 15 MB budget (see §4).

Why not the alternatives: a realistic family (Poly Haven/Sketchfab) fails on
coherence (patchwork of artists), poly counts (10k–100k+ tris), login walls,
and per-model license roulette; a single-artist Sketchfab military collection
fails on completeness (no city buildings) and verifiability at this budget.

---

## 4. Download plan (research only — do not execute yet)

> EXECUTED 2026-09-29 (0.1 Alpha): the plan below was carried out —
> Kenney GLBs downloaded as listed, Quaternius OBJs converted with
> obj2gltf 3.2.0, integrated via `MODEL_PATHS`. Kept as the sourcing
> record.

### Step 1 — Kenney packs (no account; resolve exact zip URLs from pack pages)

| # | Pack | Page | Extract (GLB + shared atlas) | Est. size |
|---|---|---|---|---|
| 1 | City Kit (Commercial) | https://kenney.nl/assets/city-kit-commercial | `building-a/c/e/g/i/k.glb`, `building-skyscraper-a/c/e.glb`, `Textures/colormap.png` | ~1.0 MB |
| 2 | City Kit (Suburban) | https://kenney.nl/assets/city-kit-suburban | `building-type-f.glb`, `Textures/colormap.png` | ~0.2 MB |
| 3 | City Kit (Industrial) | https://kenney.nl/assets/city-kit-industrial | `building-e.glb` + chimney/water-tower candidates (verify), `Textures/colormap.png` | ~0.5 MB |
| 4 | Factory Kit | https://kenney.nl/assets/factory-kit | crane/machinery candidates (verify), `Textures/colormap.png` | ~0.5 MB |
| 5 | Nature Kit | https://kenney.nl/assets/nature-kit | ~6 `tree-*.glb`, ~3 `rock-*.glb`, ~3 `bush-*.glb`, `Textures/colormap.png` | ~1.0 MB || 6 | Car Kit | https://kenney.nl/assets/car-kit | `truck.glb` (+1 variant for hq), `Textures/colormap.png` | ~0.3 MB |
| 7 | Watercraft Kit | https://kenney.nl/assets/watercraft-kit | `boat-speed-a.glb` + cargo-boat candidate (verify), `Textures/colormap.png` | ~0.4 MB |
| 8 | Space Kit | https://kenney.nl/assets/space-kit | `craft_racer.glb`, `Textures/colormap.png` | ~0.3 MB |

> **Note (2026-09-30):** the tree evaluation in this doc is superseded by
> `docs/research/trees.md` — the Kenney nature trees picked here were
> judged too crude (cones/blobs, no textures) and replaced at game start
> by procedural textured trees (`game/src/render/natureTrees.ts`) using
> 5 CC0 Quaternius textures. The Kenney tree GLBs stay in the mapping
> only as a silent fallback. Rocks/bushes still use the Kenney GLBs.

Direct zip URL pattern (resolve the current hash per pack from its page at
download time):
`https://kenney.nl/media/pages/assets/<slug>/<hash>-<timestamp>/kenney_<slug>.zip`
(e.g. the Roads pack resolved to
`https://kenney.nl/media/pages/assets/city-kit-roads/74288c9459-1787042796/kenney_city-kit-roads.zip`).
⚠️ Bundle each pack's `Textures/colormap.png` alongside its GLBs or models
fail to load (see §1.1 gotcha).

### Step 2 — Quaternius tanks via Poly Pizza (free API key required)

- Bundle: https://poly.pizza/bundle/Animated-Tank-Pack-0tfvbeAJkU (CC0, GLB)
- Extract 1 tank GLB for `tank` (~0.3–0.5 MB est.); optionally a second variant
  as the `artillery` stand-in if no better match is found.
- Also via Poly Pizza (CC0, verify each model page): 1–2 Animated Men models
  for `engineer`/`rifles`, 1 farm building for `farm`, 1 gun model from the
  Toon Shooter kit as a rifle prop. (~1 MB est.)

### Step 3 — Gap picks via Poly Pizza / Sketchfab (verify license per model, record author + URL)

Search terms and leading candidates (all **unverified** — confirm license,
GLB availability, and tri count before use):

| Entity | Search | Leading candidate |
|---|---|---|
| artillery | poly.pizza "howitzer" | — |
| aa | poly.pizza "anti-air missile launcher" | — |
| fighter | poly.pizza "fighter jet" | "Low poly Fighter" by Stephen Graybill (likely CC-BY) |
| transport | poly.pizza "helicopter" | "Helicopter" by Poly by Google (likely CC-BY) |
| drone | poly.pizza "drone" | "Drone" by NateGazzard |
| destroyer | sketchfab "destroyer warship low poly" | "USS Zumwalt" by Yakudami (CC-BY, attested in another project's credits; needs Sketchfab login) |
| mediaCenter | poly.pizza "radio tower" | — |
| stormArray | poly.pizza "radar dish" | — |

Est. ~1–2 MB for 8 models.

### Size total

Kenney selection ~3.7 MB + Quaternius/Poly Pizza CC0 ~1.5 MB + gap picks ~2 MB
≈ **~6–9 MB total**, comfortably under the 15 MB budget. Keep a
`THIRD_PARTY_NOTICES.md` recording every file's source URL, author, and license
(CC-BY attributions live there; CC0 recorded as courtesy).

---

## 5. Dead ends (rejected and why)

- **Kenney "War Kit" / "Vehicle Kit"** — do not exist (`/assets/war-kit` and
  `/assets/vehicle-kit` both 404). Kenney has no military vehicles at all.
- **Kenney Modular Characters** — 2D sprite pack, not 3D. Unusable.
- **Kenney Blocky Characters / Mini Characters** — blocky/toy-like; conflicts
  with the user's explicit veto of blocky/Minecraft/voxel style.
- **Kenney Animated Characters (Survivors/Retro/Protagonists)** — 3D and CC0,
  but only 8 files each and horror/civilian themed; no soldiers.
- **Mixamo** — FBX-only (no GLB), requires Adobe account, and its license bars
  redistributing the raw character/animation files — incompatible with shipping
  in an AGPL repo.
- **OpenGameArt** — license roulette per file (CC0/CC-BY/GPL mixed), formats
  unpredictable (many FBX/Blend-only). Audit cost exceeds value given Kenney +
  Quaternius coverage.
- **KayKit (kaylousberg.itch.io)** — CC0 and good quality, but medieval/racing/
  dungeon focused; no modern military or modern-city coverage.
- **Realistic single-family (Poly Haven models, photoreal Sketchfab)** —
  rejected on coherence (multi-artist patchwork), poly counts (tens–hundreds of
  k tris vs the 5k target), and zero military-vehicle coverage at CC0.
- **Quaternius direct download as primary** — site serves FBX/OBJ/Blend only;
  fails the GLB-only constraint without a Blender conversion step. Resolved via
  Poly Pizza's GLB conversions (CC0 preserved).
- **Sketchfab as primary family** — login wall on downloads, per-model license
  vetting, wildly inconsistent poly counts and art styles. Kept only as
  last-resort gap filler (destroyer).

---

## 6. Open questions for the download step

1. Exact GLB filenames in Kenney Nature/Industrial/Factory/Watercraft kits
   (only partially attested) — confirm during zip extraction; fall back to
   Poly Pizza CC-BY if a candidate (chimney, crane, cargo boat) is missing.
2. Which of the 4 Quaternius tank variants reads best as the MBT — eyeball at
   download; keep one spare variant as artillery stand-in if needed.
3. All 8 gap models (§2) need per-model license + tri-count verification.
4. Poly Pizza downloads need a free API key — obtain before the download step.
5. Attribution file: draft `THIRD_PARTY_NOTICES.md` listing every bundled file
   with source URL, author, license (CC-BY entries are mandatory credits).

---

## 7. Whole-kit library expansion (2026-09-29, evening)

**Goal:** grow the 36-file curated set into a whole-kit library the design /
render teams can map the expanded roster (~26–30 units, ~26–30 buildings)
onto, without touching game code or `MODEL_PATHS`.

### 7.1 License re-verification (primary sources, 2026-09-29)

- **Kenney:** every pack page on kenney.nl carries the license badge linking
  to `https://creativecommons.org/publicdomain/zero/1.0/` with the text
  "Creative Commons CC0" (verified in page HTML, e.g. car-kit page:
  `creativecommons.org/publicdomain/zero/1.0/' target='_blank'>Creative
  Commons CC0</a>`). Each pack zip ships an upstream `License.txt` (CC0),
  kept in every `game/public/models/<pack>/` directory.
- **Quaternius:** pack pages on quaternius.com state "CC0 License" (verified
  on the Ultimate Animated Character Pack and Toon Shooter Game Kit pages).
  No new Quaternius files were added in this expansion (see §7.5).

### 7.2 Kenney catalog survey (2026-09-29)

Checked for military/aircraft kits that would close the military gap:
`military-kit`, `war-kit`, `air-kit`, `aircraft-kit`, `helicopter-kit`,
`plane-kit` → **all 404**. Kenney still ships **no military and no aircraft**
kits. `train-kit` and `racing-kit` exist (HTTP 200) but were rejected as
out of scope (no trains/race cars on the likely roster).

### 7.3 Packs downloaded whole (9 Kenney kits)

Whole-kit zips were resolved per pack from the asset page at download time
(`https://kenney.nl/media/pages/assets/<slug>/<hash>-<ts>/kenney_<slug>[_<ver>].zip`;
note the watercraft kit uses the legacy name `kenney_watercraft-pack.zip`)
and extracted **GLB-only** (+ `License.txt` + the pack's
`Textures/colormap.png` where the GLBs reference it) into the existing
per-pack directories — no game code touched, previously shipped files
overwritten in place with byte-identical upstream content.

| Pack dir | Upstream pack | GLBs | Notable for the roster |
|---|---|---|---|
| `kenney-car/` | Car Kit | 50 | ambulance, firetruck, police, taxi, van, garbage-truck, tractors, delivery trucks, sedans/SUVs, karts, wheels, crash debris |
| `kenney-commercial/` | City Kit (Commercial) | 41 | 14 mid-rise blocks, 5 skyscrapers, awnings/parasols/overhangs, 14 low-detail background blocks |
| `kenney-suburban/` | City Kit (Suburban) | 40 | 21 house types, driveways, fences, paths, planters |
| `kenney-industrial/` | City Kit (Industrial) | 37 | 20 factory/warehouse shells, chimneys, storage tanks, shipping containers, **solar panels, wind turbines**, water tower |
| `kenney-roads/` *(new)* | City Kit (Roads) | 95 | road tiles (straights/curves/junctions/bridges), street lamps, power-line poles + wires, construction barriers/cones/fences, dumpster |
| `kenney-nature/` | Nature Kit | 329 | trees (oak/pine/palm/cactus/birch…), rocks, cliffs, plants, flowers, mushrooms, bridges, campfires, fences, canoe |
| `kenney-watercraft/` | Watercraft Kit | 46 | speedboats, sailboats, rowboats, tugboats, tow boats, houseboats, **cargo ships, ocean liners**, buoys, cargo containers/piles, ramps |
| `kenney-space/` | Space Kit | 153 | spacecraft, hangars, monorail, rocket parts, corridors, platforms, **satelliteDish ×3 (radar-dish candidates)**, **turret_single/turret_double (AA/sentry candidates)**, rover, weapon_gun/weapon_rifle props, astronauts |
| `kenney-factory/` | Factory Kit | 143 | conveyors, pipes, machines, cranes, catwalks, hoppers, robot arms, screens, structural frames, gears, pistons, doors |

Totals: **942 GLB files, ~27.4 MiB** (906 new; +~23.4 MiB added — under the
40 MB expansion budget). Triangle counts: hundreds–low-thousands per model
(max 11.4k, the Quaternius tank-4 already documented); 350k tris across the
whole library (only roster-mapped models load at runtime).

### 7.4 Zip layout notes / conversions

- **No conversion was needed for Kenney this time.** Newer kits
  (car/commercial/suburban/industrial/roads/watercraft/factory) ship
  `Models/GLB format/*.glb` + `Models/GLB format/Textures/colormap.png`;
  the 2020-era kits (nature, space) ship `Models/GLTF format/*.glb` and are
  vertex-colored with no textures.
- **Texture gotcha (confirmed again):** GLBs in the textured packs reference
  `Textures/colormap.png` relative to the GLB's own URL — each pack dir ships
  its own copy under `<pack>/Textures/colormap.png` (PNG magic verified).
  Nature/space/Quaternius models have no external images (vertex-colored /
  flat PBR).
- Validation: every GLB checked for `glTF` magic bytes, version 2, parseable
  JSON chunk, non-empty meshes — **942/942 pass, 0 corrupt**, tri counts
  recorded in `game/public/models/MANIFEST.md`.

### 7.5 Quaternius expansion — BLOCKED (download denied)

Plan was to add whole packs for infantry variants + military props:
- **Ultimate Animated Character Pack** (40 animated characters, men + women —
  infantry variants): CC0 verified on
  https://quaternius.com/packs/ultimatedanimatedcharacter.html ;
  Drive folder `https://drive.google.com/drive/folders/1sNi1AfenfPRrvRt5yfaj5QMMd6KKcUJ5`
- **Toon Shooter Game Kit** (70+ shooter models — guns, barricades, military
  props): CC0 verified on https://quaternius.com/packs/toonshootergamekit.html ;
  Drive folder `https://drive.google.com/drive/folders/1-BDs_EIyd6uiF2XuoyiZEcqnMQIJrE0C`

The Google Drive folder download (via `gdown`) failed with a proxy error and
the retry was **explicitly declined by the user** — per policy it was not
retried or worked around. The 8 existing Quaternius files remain as-is.
**To unblock:** the user can approve a fresh Drive download attempt, or drop
the pack zips (OBJ or FBX) somewhere the agent can read; conversion is the
proven `obj2gltf@3.2.0` one-liner documented in
`game/public/models/quaternius/CONVERSION.md` (extend that file's mapping
table when new files land).

### 7.6 Remaining gaps (no CC0 whole-kit source — render team: procedural gap models)

After the whole-kit expansion, these likely roster items still have **no**
CC0 model in the library (Kenney has no military/aircraft kits, §7.2):
- **Submarine** (watercraft kit has no submersible; closest: `ship-small-ghost`)
- **SAM site / AA missile launcher** (space kit `turret_single`/`turret_double`
  are gun turrets — usable as *sentry-gun* stand-ins, not missile AA)
- **Fighter jet / bomber** (space kit `craft_*` are sci-fi; no real aircraft)
- **Helicopter (transport/gunship)** — no CC0 source in either family
- **Drone/UAV** — no CC0 source in either family
- **Artillery / howitzer** — no CC0 source (Quaternius tanks are MBTs)
- **Destroyer/warship** — watercraft kit tops out at cargo ships/liners; no warship
- **Broadcast/media tower** — closest: space kit `satelliteDish_*` (dishes, not towers)
- **Bus** (car kit has none; Quaternius Public Transport Pack would cover it —
  same blocked-download path as §7.5)

Partially closed by this expansion: **stormArray (radar)** → space kit
`satelliteDish`/`satelliteDish_detailed`/`satelliteDish_large` are credible
radar-dish models; **airbase hangar** → space kit `hangar_*`; **power**
variants → industrial `solar-panel-*`/`windmill*`; **emergency services** →
car kit ambulance/firetruck/police.

Per-model CC0/CC-BY gap picks (Poly Pizza, Sketchfab) remain a possible
follow-up per the original §2 table, but were out of scope for this
whole-kit task.
