<!---
  NOVATERRA — Copyright (C) 2026 Gumb Dames

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as published
  by the Free Software Foundation, version 3 of the License.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU Affero General Public License for more details.

  You should have received a copy of the GNU Affero General Public License
  along with this program. If not, see <https://www.gnu.org/licenses/>.
-->

# Phase 5 Workstream E — Art/models for the air & naval roster (0.1 Alpha)

> **Status:** Pass 1 complete (2026-09-30) — audit of the §3.5/3.6/3.7
> rosters against the 942 vendored CC0 GLBs, with CC0 proposals for the
> gaps. **Nothing downloaded yet.** Pass 2 (wiring) waits for the
> coordinator's final key list from sibling workers A (airport
> buildings), B (aircraft), C (naval/ports).
>
> **Owner:** workstream E (art/models). **Scope:** model sourcing only —
> no sim or gameplay logic; render-layer wiring only in Pass 2.

## Prior art this audit builds on

- `docs/research/real-models.md` §7.2 already proved Kenney ships **no
  military and no aircraft kits** (`military-kit`, `war-kit`, `air-kit`,
  `aircraft-kit`, `helicopter-kit`, `plane-kit` all 404). Re-verified
  2026-09-30 against the vendored library — still true.
- The established gap pattern is **procedural builders** in
  `game/src/render/proceduralModels.ts` (37+ kinds: fighter, destroyer,
  submarine, carrier, attackHeli, transport, drone…), textured via the
  `surfaceTextures.ts` / `surfaceMaterials.ts` pipeline. The user bar is
  "proper 3D models + textures" — procedural is accepted practice here,
  not a compromise.
- Lazy pipeline: `render/lazyModels.ts` — new keys are lazy by default;
  the 8 MiB boot gate (currently ~4.56 MiB GLB + ~0.83 MiB tree
  textures) must not move. No new key goes in `bootModelKeys()`.
  *(R3, 2026-10-01: those figures were raw bytes; byte-measured boot
  payload transfers 4.11 MiB — 51.3% of the gate. See
  `docs/research/perf-r3.md`.)*

## Audit: §3.5/3.6/3.7 keys vs. the vendored library

"Free" below means not referenced by `MODEL_PATHS`
(`game/src/render/models.ts`), checked 2026-09-30 against all 942 GLBs.

### §3.5 — Airports + airline

| Key | Verdict | Candidate |
|---|---|---|
| `civilAirport` / `militaryAirbase` / `mixedAirport` | GAP (no airport GLB anywhere) | Composite building (hangar + terminal + tower pieces, the `airfield` precedent) or procedural |
| `passengerTerminal` | COVERED | `kenney-commercial/building-c/e/h/j/l/m` or `building-skyscraper-a..e` (all free) |
| `cargoTerminal` | COVERED | `kenney-industrial/building-a/b/c/d/f/g/l/m/n/o/p/q/r/s/t` (free) |
| `controlTower` | GAP (no tower in any pack) | **Procedural** (shaft + glass cab) — simple, reads well |
| `hangarS` | COVERED | `kenney-space/hangar_smallB` (smallA used by `airfieldHangar2`) |
| `hangarM` | COVERED | `kenney-space/hangar_roundA` (roundB / roundGlass free too) |
| `hangarL` | COVERED | `kenney-space/hangar_largeB` (largeA used by `airfieldHangar`) |
| `fuelFarm` | COVERED | `kenney-industrial/detail-tank-large` + `detail-tank` composite (the `oilRefinery` precedent) |
| `maintenanceHangar` | COVERED | `kenney-space/hangar_roundGlass` or `hangar_smallB` |
| `runway` (per class) | GAP (no runway GLB; `buildRunwayStrip` is a procedural attach prop) | **Procedural** runway builder (strip + class markings) |
| `airliner` | GAP | CC0 proposal §1 below |
| `jumboAirliner` | GAP | CC0 proposal §1 below (largest variant) |
| `regionalJet` | GAP | CC0 proposal §1 below |
| `cargoPlane` | GAP (partial: `kenney-space/craft_cargoB` is free but sci-fi) | CC0 proposal §1 below preferred over `craft_cargoB` |
| `passengerHeli` | GAP | **Procedural** (precedent: `transport`, `attackHeli` are procedural) |
| `seaplane` | GAP | CC0 proposal §1 below if pack has a float variant, else procedural |

### §3.6 — Naval expansion

| Key | Verdict | Candidate |
|---|---|---|
| `coastalSub` | GAP | **Procedural** (precedent: `submarine` procedural) |
| `missileSub` | GAP | **Procedural** (scaled variant of the coastalSub builder) |
| `corvette` | GAP | **Procedural** |
| `cruiser` | GAP | **Procedural** |
| `battleship` | GAP | **Procedural hero** (no CC0 warship pack exists — see §2) |
| `heavyDestroyer` | GAP | **Procedural** (variant of the `destroyer` builder) |
| `cargoFreighter` | COVERED | `kenney-watercraft/ship-cargo-c` (a/b used by `transportShip`/`commandShip`) |
| `fuelTanker` | GAP (partial) | Composite: `kenney-watercraft/ship-large` hull + `kenney-industrial/detail-tank` pieces |
| `ammoShip` | GAP (partial) | Composite: `kenney-watercraft/ship-small` hull + crate pieces (`kenney-factory/box-*`) |
| `repairShip` | GAP (partial) | `kenney-watercraft/boat-tow-a/b` (workboat/tug look) or `ship-small` + crane |
| `minelayer` | GAP (partial) | `kenney-watercraft/boat-tow-a/b` hull + procedural mine rails |
| `navalMine` | COVERED | `kenney-watercraft/buoy` / `buoy-flag` (+ procedural spike attach prop) |
| `coastGuardCutter` | COVERED | `kenney-watercraft/boat-tug-a/b/c` |
| `cruiseLiner` | COVERED | `kenney-watercraft/ship-ocean-liner` (+ `ship-ocean-liner-small` spare) |
| `yacht` | COVERED | `kenney-watercraft/boat-speed-b/c/e/f/g/h/i/j`, `boat-sail-a/b`, `boat-house-a/b/c/d` |
| `commercialPort` / `containerPort` | COVERED | Composite: `cargo-container-a/b/c`, `cargo-pile-a/b`, `kenney-factory/crane` (the `shipyard` precedent) |
| `fishingHarbor` | COVERED | Composite: `boat-row-large/small`, `kenney-nature/canoe` (fishing-small used by `fishingBoat`) |
| `navalBase` | GAP (partial) | Composite from shipyard pieces (`shipyardCrane`, `navalYardHall`) + piers; no dedicated military-port GLB |

(`carrier` keeps its existing procedural hull — Phase 6 makes it the
empty hull; no new art needed. `marina` was done in Phase 4.)

### §3.7 — Aircraft expansion

| Key | Verdict | Candidate |
|---|---|---|
| `strategicBomber` | GAP | CC0 proposal §1 below (if pack has a bomber type), else procedural |
| `maritimePatrol` | GAP | CC0 proposal §1 below |
| `reconUAV` | GAP (partial: `drone` is a procedural quadcopter) | CC0 proposal §1 below (small fixed-wing variant) or procedural |
| `armedUAV` | GAP | Same as `reconUAV` |
| `reconPlane` | GAP | CC0 proposal §1 below |
| `gunship` | GAP | **Procedural** (heavy CAS jet; precedent: `fighterBomber` procedural) |
| `tanker` | GAP | CC0 proposal §1 below, else procedural |
| `militaryCargo` | GAP (partial: `craft_cargoB` sci-fi) | CC0 proposal §1 below preferred |
| `trainer` | GAP | CC0 proposal §1 below, or §3 fallback |
| `navalFighter` | GAP | **Procedural** (carrier-capable; precedent: `fighter` procedural) |

Existing `fighter` / `fighterBomber` / `attackHeli` / `drone` /
`awacs` / `transport` keep their current art (procedural except awacs).

## CC0 proposals (not downloaded — Pass 2)

### Proposal 1 — styloo "Tiny Plane Asset Pack" (primary, aircraft)

- Source: https://styloo.itch.io/plane
- License: **CC0 1.0 Universal.** Evidence ready for
  `THIRD_PARTY_NOTICES.md`: (a) the pack is listed in itch.io's
  CC0-tagged asset browse
  (https://itch.io/game-assets/assets-cc0/tag-vehicles); (b) it was
  independently license-verified and shipped (all 15 variants) by the
  ECGaming project, whose `THIRD_PARTY_NOTICES.md` records "Tiny Plane
  Asset Pack by styloo … CC0 1.0 Universal"
  (https://github.com/georgefejer91/ecgaming/blob/HEAD/THIRD_PARTY_NOTICES.md).
  Pass 2 must still confirm a CC0 statement inside the downloaded zip
  before vendoring.
- Contents: **15 FBX variants**, different plane types and colors
  (author's description; exact type list unknown until download — Pass 2
  inventories it).
- Covers: `airliner`, `jumboAirliner`, `regionalJet`, `cargoPlane`,
  `militaryCargo`, `trainer`, `tanker`, `maritimePatrol`, `reconPlane`,
  `reconUAV`, `armedUAV`, `strategicBomber` (subject to the inventory —
  whatever types are missing fall back to procedural).
- Pipeline fit: FBX → GLB via **Blender headless** (the documented
  fallback converter in `quaternius/CONVERSION.md`; `obj2gltf` is
  OBJ-only). New directory `game/public/models/styloo-planes/` +
  `CONVERSION.md` + MANIFEST.md rows + THIRD_PARTY_NOTICES.md entry,
  following the exact Quaternius pattern.
- Determinism bonus: 15 color/type variants give natural **seeded
  variant selection** (e.g. per-owner airline liveries via the
  `buildingVariantSeed`-style seeded pick) at zero extra download cost.

### Proposal 2 — mfep "Low-Poly Biplane" (trainer fallback)

- Source: https://opengameart.org/content/low-poly-biplane — CC0 1.0
  (stated on the OGA page). Only if the styloo pack has no trainer-suitable
  type.

### Proposal 3 — alpaqagames "Low poly cartoon plane" (airliner fallback)

- Source: https://opengameart.org/content/low-poly-cartoon-plane —
  CC0 1.0 (stated on the OGA page). Only if the styloo pack has no
  airliner-suitable type.

### Proposal 4 — warships, subs, helicopters, control tower: procedural (no CC0 source exists)

Web research 2026-09-30 found **no CC0 warship/submarine pack**
(Kenney: none; KayKit: none — GitHub org `KayKit-Game-Assets` is
characters/cities/dungeons/medieval only; Quaternius: none outside the
Drive-hosted Ultimate packs, which the user declined; the Unity Asset
Store "Low Poly Military Warship Collection" packs are paid, not CC0;
Sketchfab/poly.pizza warships are per-model mixed licenses — the repo's
own research already ruled those venues out for bundling). Same for
helicopters and control towers.

Recommendation: **procedural hero builders** in
`render/proceduralModels.ts` with the `surfaceMaterials.ts` treatment
(camo/navy/gunmetal/hullGray), following the existing `submarine`,
`destroyer`, `frigate`, `carrier`, `attackHeli`, `transport` builders.
This is the established pattern for exactly these categories, it is
deterministic by construction, zero download weight, and the user's
"proper 3D models + textures" bar is met by the surface-texture
pipeline. PLAN.md Phase 6 budgets "hero CC0 for
carrier/battleship/airliner-grade hulls" — the airliner half is solved
by Proposal 1; the warship half stays procedural.

## Pass 2 plan (after the coordinator's final key list)

1. Vendor approved CC0 sources (download → Blender-headless FBX→GLB →
   `game/public/models/styloo-planes/` + `CONVERSION.md` + MANIFEST.md +
   THIRD_PARTY_NOTICES.md, Quaternius pattern). Verify the CC0 statement
   inside the zip first.
2. Build procedural gap models for the warship/sub/heli/tower/runway
   keys (`PROCEDURAL_KINDS` + `buildProceduralModel` switch +
   `MODEL_SOURCES` in `render/entities.ts`).
3. Wire GLB keys through `MODEL_PATHS` (`models.ts`) with measured
   `scale`/`rotY`/`yOffset` (the `normalizeModel` convention), surface
   treatments in `KEY_TREATMENTS` (`entitySurfaces.ts`).
4. **All new keys lazy** — none in `bootModelKeys()`; the 8 MiB startup
   gate must not move (measure boot weight in the Pass 2 report).
5. Gate: model-mapping completeness tests (every new def key resolves
   GLB/procedural, never placeholder), a boot-set-unchanged test, `npx
   tsc --noEmit`, `npm run build` clean. Commit locally `(0.1 Alpha)`,
   no push.

## Pass 2 status (2026-09-30) — DONE, committed locally

All 49 keys mapped. Final mapping:

| Keys | Source | Notes |
|---|---|---|
| 13 aircraft (jumboAirliner … armedUAV) | styloo "Tiny Plane Asset Pack" (CC0) GLBs, `game/public/models/styloo-planes/`, one MODEL_PATHS key per kind | Per-kind fit-to-hull scale; nose at authored −X ⇒ `rotY: π/2` for all 13. Colors are the pack's embedded palette texture (baseColorTexture) — treatments are palette-preserving (no `map`). |
| 9 heroes (coastalSub, missileSub, corvette, cruiser, battleship, heavyDestroyer, navalFighter, gunship, passengerHeli) | procedural builders in `proceduralModels.ts` | smat()-tagged, ≥3 parts, waterline-keel for the 6 ships. |
| 9 logistics ships | GLB composites from existing CC0 pieces | e.g. fuelTanker = ship-large hull + 2× industrialTank; ammoShip = ship-small + 4× deckCrate; 16 new MODEL_PATHS piece keys. |
| 4 ports | GLB composites | commercialPort / containerPort / fishingHarbor / navalBase (cranes + containers + boats). |
| 3 attach props | procedural (seaplaneFloats, mineRails, navalMineSpikes) | via `extraPropSpecs` + `propFor`. |

- License: CC0 verified via itch.io asset-license metadata ("Creative Commons Zero v1.0 Universal"); the zip itself contains no license file (noted in THIRD_PARTY_NOTICES.md + CONVERSION.md, with ECGaming mirror cross-evidence).
- Boot weight: 33-key boot set (+2: deckRowboat + harborCanoe — the foundation-age fishingHarbor's composite pieces, ~32 KB; pinned by test). All other 47 keys lazy; styloo adds ~6.3 MiB lazy, 0 at boot.
- Tests: mapping-depth suite (every 49 keys → real GLB piece / existing builder), 9 hero builders in the procedural-gaps suite (waterline-keel bounds), boot-set inclusion/exclusion test, KEY_TREATMENTS 94/94 coverage. Full suite (1790 tests) + tsc green.
- Visual verification (2026-09-30, Blender 4.2 Cycles): all 13 composites rendered and inspected. Findings applied: deckRowboat scale 1.0→0.7 (was dwarfing the canoes); confirmed tank/crate/crane/container pieces sit on decks (not floating/clipping); navalMine buoy clean (spikes are the procedural prop, not in the GLB render).
- **Phase 6 note for the coordinator:** no CC0 warship source was found — the 6 warships + 3 naval aircraft are procedural hero builds. Recommend amending the PLAN.md Phase 6 "hero CC0 warship" budget line to procedural (zero download weight).

## Open questions for the coordinator

1. ~~Final key names from workers A/B/C (my audit assumes the PLAN §3.5–3.7 names; renames just re-map the table).~~ Resolved — the 49 keys as mapped above.
2. ~~`strategicBomber` / `cargoPlane` / `tanker`: prefer styloo-pack variants even if the silhouette is "tiny plane" style, or procedural hero builds? (Default: styloo first, procedural for any missing type.)~~ Resolved — styloo (coordinator decision 1).
3. ~~`fuelTanker` / `ammoShip` / `repairShip` / `minelayer`: composite kitbash from existing CC0 hulls (my recommendation — zero new bytes) vs. procedural hulls. Composite keeps the kit look consistent.~~ Resolved — kitbash composites (coordinator decision 3).
4. Confirm the Phase 6 "hero CC0 warship" budget line in PLAN.md should be amended to procedural (no CC0 source found), or kept open.
