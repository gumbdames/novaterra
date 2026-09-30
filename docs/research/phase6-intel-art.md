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

# Phase 6 Workstream 5 — Art/models for the intel roster (0.1 Alpha)

> **Status:** Pass 1 complete (2026-09-30) — audit of the 6 intel keys
> against the vendored CC0 library, with a mapping proposal per key.
> **Nothing downloaded, nothing vendored yet.** Pass 2 (wiring) below.
>
> **Owner:** workstream 5 (intel art). **Scope:** model sourcing only —
> no sim or gameplay logic; the intel sim defs (§3.8) do not exist yet
> in `game/src/sim/` — this workstream lands the art mappings ahead so
> `modelSourceFor` resolves the moment the sim keys arrive.
> Render-layer wiring only in Pass 2.

## Prior art this audit builds on

- `docs/research/phase5-air-naval-art.md` — the two-pass audit process,
  the CC0-only rule, and the "vendored composite first, procedural hero
  where no CC0 fit" gap pattern.
- The Quaternius civilian pedestrians (`quaternius-civilians/`, 4 baked
  static GLBs, ~1.05 MB lazy, license-manifested in
  `THIRD_PARTY_NOTICES.md`) — the Phase 4 ambient crowd.
- Attach props: `buildHqAntenna` (the `hq` unit's roof antenna),
  `buildRadarDishProp` (aegisControl's yard dish) — the reuse pattern
  for antenna read.
- Lazy pipeline: `render/lazyModels.ts` — new keys are lazy by default;
  the 8 MiB boot gate (pinned 33-key boot set,
  `tests/render.lazyModels.test.ts`) must not move. No new key goes in
  `bootModelKeys()`.

## Pass 1 — Audit: the 6 intel keys vs. the vendored library

"Free" below means not referenced by `MODEL_PATHS`
(`game/src/render/models.ts`), checked 2026-09-30. All candidate
files are already vendored CC0 (Kenney / Quaternius — see
`THIRD_PARTY_NOTICES.md`), so **zero new bytes need vendoring**.
Authored sizes were measured headlessly with three.js GLTFLoader
(Node): `W x H x D` in authored units, `(size on disk)`.

| Key | Kind | Verdict | Candidate |
|---|---|---|---|
| `spy` | unit | COVERED (reuse) | `quaternius-civilians/civilian-man.glb` (1.43×4.84×0.82, 127 KB) — new MODEL_PATHS key `spy` → same file (the rifleman.glb-keyed-3× precedent). A spy that looks like an ordinary civilian is the correct read; the unit's team stripe + pennant keep it selectable. The plain man is the most nondescript of the four pedestrians (worker reads as a laborer; the two women are more distinctive). |
| `reconTeam` | unit | COVERED (vendored fit) | `kenney-car/suv.glb` (1.50×1.30×2.70, 203 KB) — a scout SUV reads as a recon team at game zoom and stays visually distinct from the ambient pedestrian crowd. Rejected alternative: a 3-figure civilian composite — confusable with ambient walkers and fiddly at this zoom. |
| `intelHQ` | building | COVERED (composite + prop) | `kenney-commercial/building-h.glb` (0.88×1.29×1.01, 124 KB) office block, height-fit to 6.5 world units (scale 5.03) + the existing `hqAntenna` attach prop on the roof at dy 6.6 (the `hq` precedent). — REVISED from building-e: the sim defs landed mid-workstream (`sim/city.ts` 2026-09-30) with intelHQ at **3×3** (not the assumed 4×4); building-e footprint-fit would give a squat 3.3-tall block, while building-h height-fit reads as a proper HQ tower. Skyscraper variants are free but read as needles at 3×3; building-j is free but 430 KB — too heavy for a lazy key. |
| `listeningPost` | building | COVERED (composite) | `kenney-commercial/building-c.glb` (0.88×0.89×1.09, 100 KB) low hut (scale 3.67) + `kenney-space/satelliteDish.glb` (0.69×0.62×0.57, 19 KB, scale 1.8) **roof-mounted** at (0.3, 3.3, 0) — the rooftop-SIGINT read. — REVISED from dish-beside-hut: the sim footprint is **2×2** (4 world units), too tight for a beside-placement; the roof mount keeps the composite inside the footprint. |
| `satelliteUplink` | building | COVERED (1:1) | `kenney-space/satelliteDish_detailed.glb` (0.70×0.62×0.70, 25 KB, scale 8.57) — a big ground dish reads instantly as an uplink. 1:1 like `radarStation` (which uses the `satelliteDish_large` silhouette, so the two stay visually distinct). Sim footprint **3×3**. |
| `signalsStation` | building | COVERED (composite + new prop) | `kenney-commercial/building-e.glb` (1.64×0.89×1.01, 125 KB) low equipment shed (scale 2.44 — the station's identity is the mast, not the hut) + a NEW procedural attach prop `signalMast` (tall lattice SIGINT mast: crossbar arrays, dishes, red beacon — the `hqAntenna` family, scaled up to ~7 world units so it reads at game zoom) at dx 1.7, dz 0.5. — REVISED from building-h: the sim footprint is **2×2**; the taller building-h is better spent as the intelHQ block, and a low shed + dominant mast is the correct "signals station" read. Rejected: `machine_wireless.glb` (0.75×0.60×0.50, 13 KB) — a small equipment box whose silhouette cannot be verified headlessly; it would not read as a "station" from the camera. Rejected: reusing `hqAntenna` for the mast — it would make signalsStation look like intelHQ's rooftop antenna moved to the ground. |

### Dead ends

- New CC0 downloads: not needed — every key maps to already-vendored
  CC0. Nothing added to `THIRD_PARTY_NOTICES.md`.
- Procedural hero builders for the buildings: unnecessary — the space
  kit has exactly the dish/antenna vocabulary the intel buildings need
  (the same kit `radarStation` already draws from).
- `machine_wireless` / `machine_wirelessCable` as the signalsStation
  hero piece: rejected (see table) — too small, unverifiable silhouette.

## Pass 2 — Mapping (wiring)

Wired 2026-09-30. Scales are the uniform fit-to-footprint scale measured
headlessly against the sibling sim workstream's defs (`sim/city.ts`:
intelHQ 3×3, listeningPost 2×2, satelliteUplink 3×3, signalsStation 2×2;
`sim/units.ts`: spy 1.4×1.4/1.8, reconTeam 3.0×4.6/1.8). All seven
MODEL_PATHS keys are lazy — none in `bootModelKeys()` (pinned by the
exclusion test added in `tests/render.lazyModels.test.ts`).

| Key | MODEL_SOURCES pieces | New MODEL_PATHS keys (file, scale) | Lazy bytes |
|---|---|---|---|
| `spy` | 1:1 `spy` | `spy` (quaternius-civilians/civilian-man.glb, 0.37) | 0 (shares the file with the lazy `personCasualMan` key) |
| `reconTeam` | 1:1 `reconTeam`, rotY π | `reconTeam` (kenney-car/suv.glb, 1.385) | 203 KB |
| `intelHQ` | `intelHQMain` + `hqAntenna` attach prop at dy 6.6 (roof ≈6.5) | `intelHQMain` (kenney-commercial/building-h.glb, 5.03) | 124 KB |
| `listeningPost` | `listeningPostHut` + `listeningPostDish` roof-mounted at (0.3, 3.3, 0) | `listeningPostHut` (kenney-commercial/building-c.glb, 3.67), `listeningPostDish` (kenney-space/satelliteDish.glb, 1.8) | 100 + 19 KB |
| `satelliteUplink` | 1:1 `satelliteUplink` | `satelliteUplink` (kenney-space/satelliteDish_detailed.glb, 8.57) | 25 KB |
| `signalsStation` | `signalsStationHut` + NEW procedural `signalMast` attach prop at (1.7, 0, 0.5) | `signalsStationHut` (kenney-commercial/building-e.glb, 2.44) | 125 KB |

- New procedural builder: `buildSignalMast()` in
  `game/src/render/proceduralModels.ts` (concrete footing, tapered
  lattice legs, braces, 3 crossbar arrays, 2 dishes, red beacon;
  smat/pmat-tagged, bounds-pinned by test, ~7 world units tall).
- `hullSizeFor` pins: spy 1.4×1.8×1.4, reconTeam 3.0×1.8×4.6,
  intelHQ 6×6.5×6, listeningPost 4×4.5×4, satelliteUplink 6×5.5×6,
  signalsStation 4×7×4.
- `KEY_TREATMENTS` (`entitySurfaces.ts`) covers all 7 new keys: spy →
  INFANTRY_FABRIC, reconTeam → vehiclePaint, the three office huts →
  concreteBld, both dishes → SPACE_HULL.
- Total added lazy weight: **~597 KB (0.58 MiB)**. Boot set impact: **0**
  (still the pinned 33 keys).
- The intel sim defs landed with ages: spy/reconTeam (information /
  connectivity), intelHQ (information), listeningPost (connectivity),
  satelliteUplink (ascendance), signalsStation (information) — none
  foundation-age, so the 33-key boot set stays pinned. The sibling's
  sim-core workstream owns the defs; this workstream only mapped art
  ahead so `modelSourceFor` resolves when the keys arrive.

- Boot set impact: 0 new keys (all lazy; pinned by the exclusion test
  in `tests/render.lazyModels.test.ts`).
- The intel sim defs (§3.8) are NOT foundation-age — none of the
  intel buildings reads as a game-start structure, and keeping them
  later-age keeps the 33-key boot set pinned.
