# Third-Party Notices — novaterra

NOVATERRA itself is licensed **AGPL-3.0-only** (see [LICENSE](LICENSE),
Copyright (C) 2026 Gumb Dames). The project bundles the following third-party
packages; each remains under its own license, which applies to that package only.

## three.js — MIT License
- Version used: 0.186.1
- Copyright (c) 2010-2026 three.js authors
- https://github.com/mrdoob/three.js

## @types/three — MIT License
- Version used: 0.186.0
- https://github.com/DefinitelyTyped/DefinitelyTyped

## TypeScript — Apache License 2.0
- Version used: 7.0.2
- Copyright (c) Microsoft Corporation
- https://github.com/microsoft/TypeScript

## Vite — MIT License
- Version used: 8.3.1
- Copyright (c) 2019-present VoidZero Inc. & Vite Contributors
- https://github.com/vitejs/vite

## Vitest — MIT License
- Version used: 3.2.7
- Copyright (c) 2021-present Vitest Contributors
- https://github.com/vitest-dev/vitest

Full license texts: MIT — https://opensource.org/licenses/MIT ;
Apache-2.0 — https://www.apache.org/licenses/LICENSE-2.0

## Game audio assets (shipped in game/public/audio/)

Both tracks by Kevin MacLeod (https://incompetech.com), licensed
**CC BY 4.0** (https://creativecommons.org/licenses/by/4.0/) — free for
commercial use including games, with attribution (this notice and the
Sound section of docs/HOW_TO_PLAY.md).

- `peace.mp3` — "Meditation Impromptu 01" by Kevin MacLeod.
  Source: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Meditation%20Impromptu%2001.mp3
  License: CC BY 4.0. Re-encoded to 96 kbps with 2 s baked fades.
- `war.mp3` — "Volatile Reaction" by Kevin MacLeod.
  Source: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Volatile%20Reaction.mp3
  License: CC BY 4.0. Re-encoded to 128 kbps with 2 s baked fades.

All sound effects are synthesized procedurally at runtime with the Web Audio
API (game/src/audio/sfx.ts) — no third-party samples.

## 3D model assets (shipped in game/public/models/ — 36 files, ~4.0 MiB)

Entity and nature-prop art. All files below are **CC0 1.0 Universal**
(public domain — no attribution legally required; credited here anyway).
The runtime mapping (which GLB backs which entity, scale/yaw/waterline
corrections) lives in `game/src/render/models.ts` (`MODEL_PATHS`); a few
shipped files are spares not currently referenced by the mapping.

### Kenney assets — CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)
- Author: Kenney (https://kenney.nl), https://kenney.nl/assets
- 28 files, unmodified apart from format-consistent naming, grouped by
  source directory (the directory name reflects the Kenney pack family
  each model came from):

| File | Source group |
|---|---|
| `kenney-car/truck.glb` | kenney-car |
| `kenney-car/truck-flat.glb` | kenney-car |
| `kenney-commercial/building-a.glb` | kenney-commercial |
| `kenney-commercial/building-c.glb` | kenney-commercial (spare) |
| `kenney-commercial/building-e.glb` | kenney-commercial (spare) |
| `kenney-commercial/building-g.glb` | kenney-commercial |
| `kenney-commercial/building-i.glb` | kenney-commercial |
| `kenney-commercial/building-k.glb` | kenney-commercial |
| `kenney-factory/crane.glb` | kenney-factory |
| `kenney-factory/machine.glb` | kenney-factory |
| `kenney-industrial/building-e.glb` | kenney-industrial |
| `kenney-industrial/chimney-large.glb` | kenney-industrial |
| `kenney-industrial/water-tower.glb` | kenney-industrial |
| `kenney-nature/plant_bushDetailed.glb` | kenney-nature |
| `kenney-nature/plant_bushLarge.glb` | kenney-nature |
| `kenney-nature/rock_largeA.glb` | kenney-nature |
| `kenney-nature/rock_smallH.glb` | kenney-nature |
| `kenney-nature/rock_tallA.glb` | kenney-nature |
| `kenney-nature/tree_blocks.glb` | kenney-nature |
| `kenney-nature/tree_cone.glb` | kenney-nature |
| `kenney-nature/tree_detailed.glb` | kenney-nature |
| `kenney-nature/tree_oak.glb` | kenney-nature |
| `kenney-nature/tree_pineTallA.glb` | kenney-nature |
| `kenney-nature/tree_plateau.glb` | kenney-nature |
| `kenney-space/craft_racer.glb` | kenney-space |
| `kenney-suburban/building-type-f.glb` | kenney-suburban |
| `kenney-watercraft/boat-speed-a.glb` | kenney-watercraft |
| `kenney-watercraft/ship-cargo-a.glb` | kenney-watercraft |

### Quaternius assets — CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/)
- Author: Quaternius (https://quaternius.com)
- 8 files. Quaternius ships OBJ; these were converted OBJ → GLB with
  `obj2gltf` 3.2.0 (Cesium GS, Apache-2.0) with default options — geometry
  and materials are unchanged, only the container format differs:
  - `quaternius/engineer.glb`
  - `quaternius/farm-barn.glb`
  - `quaternius/farm-silo.glb`
  - `quaternius/rifleman.glb`
  - `quaternius/tank-1.glb` (spare — `tank-2.glb` is the in-game MBT)
  - `quaternius/tank-2.glb`
  - `quaternius/tank-3.glb` (spare)
  - `quaternius/tank-4.glb` (spare)

No model includes rigging, animation, or scripting. Textures: the Kenney
(non-nature) GLBs reference their pack's shared color atlas via a relative
URI (`Textures/colormap.png`, resolved against each GLB's URL — the PNGs
shipped alongside the GLBs in each `kenney-*/Textures/` directory are
required at runtime); the Kenney nature props and all Quaternius models
are vertex-colored / flat PBR materials with no textures. Each Kenney
pack directory also ships its upstream `License.txt` (CC0).
