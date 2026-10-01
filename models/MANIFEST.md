<!---
  NOVATERRA — Copyright (C) 2026 Gumb Dames

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU Affero General Public License as published
  by the Free Software Foundation, version 3 of the License.
-->

# 3D Model Library — MANIFEST

**Generated:** 2026-09-29 · **Files:** 957 GLB · **Total size:** 33.7 MiB · **Total triangles:** 588,300
(styloo-planes section added 2026-09-30: 15 files, 6.3 MiB, 237,992 tris)

Every file below lives under `game/public/models/` (served at
`<BASE_URL>/models/<path>`). All models are **CC0 1.0 Universal**
(public domain — no attribution legally required). License evidence:
Kenney packs carry the CC0 badge on each kenney.nl asset page and ship
`License.txt` in every pack directory; Quaternius packs are marked
"CC0 License" on each quaternius.com pack page (see
`quaternius/CONVERSION.md` + `quaternius/LICENSE-CC0.txt`).

Texture note: Kenney packs whose GLBs reference the shared color atlas
(`Textures/colormap.png`, resolved relative to each GLB's URL) ship the
PNG in `<pack>/Textures/` — it is required at runtime. Kenney nature,
Kenney space, and all Quaternius models are vertex-colored / flat PBR
materials with no textures.

`depicts` is derived from the upstream filename (Kenney filenames are
descriptive); `scale`/`rotY`/`yOffset` mapping for the final roster is
the render team's job (`game/src/render/models.ts` `MODEL_PATHS`).

## kenney-car/ — Kenney Car Kit

Source: https://kenney.nl/assets/car-kit · License: CC0 1.0 Universal
(50 files, 5497 KiB, 65,235 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-car/ambulance.glb` | Ambulance (emergency medical vehicle) | 2,804 | 228 KiB |
| `kenney-car/box.glb` | Cargo box prop | 124 | 14 KiB |
| `kenney-car/cone-flat.glb` | Traffic cone (flat) | 172 | 16 KiB |
| `kenney-car/cone.glb` | Traffic cone | 172 | 16 KiB |
| `kenney-car/debris-bolt.glb` | Crash debris: bolt | 36 | 5 KiB |
| `kenney-car/debris-bumper.glb` | Crash debris: bumper | 116 | 11 KiB |
| `kenney-car/debris-door-window.glb` | Crash debris: door window | 74 | 7 KiB |
| `kenney-car/debris-door.glb` | Crash debris: door | 68 | 7 KiB |
| `kenney-car/debris-drivetrain-axle.glb` | Crash debris: drivetrain axle | 200 | 18 KiB |
| `kenney-car/debris-drivetrain.glb` | Crash debris: drivetrain | 412 | 36 KiB |
| `kenney-car/debris-nut.glb` | Crash debris: nut | 40 | 5 KiB |
| `kenney-car/debris-plate-a.glb` | Crash debris: plate a | 40 | 5 KiB |
| `kenney-car/debris-plate-b.glb` | Crash debris: plate b | 44 | 5 KiB |
| `kenney-car/debris-plate-small-a.glb` | Crash debris: plate small a | 28 | 4 KiB |
| `kenney-car/debris-plate-small-b.glb` | Crash debris: plate small b | 44 | 5 KiB |
| `kenney-car/debris-spoiler-a.glb` | Crash debris: spoiler a | 48 | 5 KiB |
| `kenney-car/debris-spoiler-b.glb` | Crash debris: spoiler b | 88 | 8 KiB |
| `kenney-car/debris-tire.glb` | Crash debris: tire | 288 | 26 KiB |
| `kenney-car/delivery-flat.glb` | Flatbed delivery truck | 2,574 | 209 KiB |
| `kenney-car/delivery.glb` | Delivery truck | 2,476 | 235 KiB |
| `kenney-car/firetruck.glb` | Fire truck (emergency) | 2,767 | 227 KiB |
| `kenney-car/garbage-truck.glb` | Garbage truck | 3,124 | 262 KiB |
| `kenney-car/hatchback-sports.glb` | Sports hatchback | 2,088 | 193 KiB |
| `kenney-car/kart-oobi.glb` | Go-kart racer | 2,884 | 246 KiB |
| `kenney-car/kart-oodi.glb` | Go-kart racer | 2,726 | 226 KiB |
| `kenney-car/kart-ooli.glb` | Go-kart racer | 2,706 | 228 KiB |
| `kenney-car/kart-oopi.glb` | Go-kart racer | 2,726 | 231 KiB |
| `kenney-car/kart-oozi.glb` | Go-kart racer | 2,726 | 235 KiB |
| `kenney-car/police.glb` | Police car (emergency) | 2,304 | 191 KiB |
| `kenney-car/race-future.glb` | Futuristic race car | 2,068 | 169 KiB |
| `kenney-car/race.glb` | Race car | 1,952 | 163 KiB |
| `kenney-car/sedan-sports.glb` | Sports sedan | 2,088 | 174 KiB |
| `kenney-car/sedan.glb` | Sedan car | 2,032 | 168 KiB |
| `kenney-car/suv-luxury.glb` | Luxury SUV | 2,086 | 172 KiB |
| `kenney-car/suv.glb` | SUV | 2,474 | 203 KiB |
| `kenney-car/taxi.glb` | Taxi car | 2,072 | 171 KiB |
| `kenney-car/tractor-police.glb` | Police tractor (emergency) | 2,278 | 192 KiB |
| `kenney-car/tractor-shovel.glb` | Tractor with front shovel | 2,646 | 217 KiB |
| `kenney-car/tractor.glb` | Farm tractor | 2,044 | 172 KiB |
| `kenney-car/truck-flat.glb` | Flatbed truck | 2,488 | 203 KiB |
| `kenney-car/truck.glb` | Box truck | 2,082 | 172 KiB |
| `kenney-car/van.glb` | Van | 2,082 | 172 KiB |
| `kenney-car/wheel-dark.glb` | Wheel: dark | 332 | 28 KiB |
| `kenney-car/wheel-default.glb` | Wheel: default | 332 | 26 KiB |
| `kenney-car/wheel-racing.glb` | Wheel: racing | 332 | 28 KiB |
| `kenney-car/wheel-tractor-back.glb` | Wheel: tractor back | 428 | 36 KiB |
| `kenney-car/wheel-tractor-dark-back.glb` | Wheel: tractor dark back | 428 | 36 KiB |
| `kenney-car/wheel-tractor-dark-front.glb` | Wheel: tractor dark front | 332 | 28 KiB |
| `kenney-car/wheel-tractor-front.glb` | Wheel: tractor front | 332 | 28 KiB |
| `kenney-car/wheel-truck.glb` | Wheel: truck | 428 | 34 KiB |

## kenney-commercial/ — Kenney City Kit (Commercial)

Source: https://kenney.nl/assets/city-kit-commercial · License: CC0 1.0 Universal
(41 files, 3652 KiB, 44,682 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-commercial/building-a.glb` | Commercial building A (mid-rise block) | 1,252 | 106 KiB |
| `kenney-commercial/building-b.glb` | Commercial building B (mid-rise block) | 1,276 | 104 KiB |
| `kenney-commercial/building-c.glb` | Commercial building C (mid-rise block) | 1,195 | 100 KiB |
| `kenney-commercial/building-d.glb` | Commercial building D (mid-rise block) | 1,100 | 93 KiB |
| `kenney-commercial/building-e.glb` | Commercial building E (mid-rise block) | 1,509 | 125 KiB |
| `kenney-commercial/building-f.glb` | Commercial building F (mid-rise block) | 1,794 | 145 KiB |
| `kenney-commercial/building-g.glb` | Commercial building G (mid-rise block) | 2,006 | 162 KiB |
| `kenney-commercial/building-h.glb` | Commercial building H (mid-rise block) | 1,512 | 124 KiB |
| `kenney-commercial/building-i.glb` | Commercial building I (mid-rise block) | 2,544 | 205 KiB |
| `kenney-commercial/building-j.glb` | Commercial building J (mid-rise block) | 5,246 | 430 KiB |
| `kenney-commercial/building-k.glb` | Commercial building K (mid-rise block) | 2,960 | 241 KiB |
| `kenney-commercial/building-l.glb` | Commercial building L (mid-rise block) | 3,512 | 284 KiB |
| `kenney-commercial/building-m.glb` | Commercial building M (mid-rise block) | 3,740 | 294 KiB |
| `kenney-commercial/building-n.glb` | Commercial building N (mid-rise block) | 4,350 | 333 KiB |
| `kenney-commercial/building-skyscraper-a.glb` | Skyscraper A (tall office tower) | 1,292 | 109 KiB |
| `kenney-commercial/building-skyscraper-b.glb` | Skyscraper B (tall office tower) | 1,592 | 135 KiB |
| `kenney-commercial/building-skyscraper-c.glb` | Skyscraper C (tall office tower) | 1,704 | 146 KiB |
| `kenney-commercial/building-skyscraper-d.glb` | Skyscraper D (tall office tower) | 1,892 | 163 KiB |
| `kenney-commercial/building-skyscraper-e.glb` | Skyscraper E (tall office tower) | 1,156 | 99 KiB |
| `kenney-commercial/detail-awning-wide.glb` | Awning shopfront detail (wide) | 40 | 5 KiB |
| `kenney-commercial/detail-awning.glb` | Awning shopfront detail | 40 | 5 KiB |
| `kenney-commercial/detail-overhang-wide.glb` | Overhang shopfront detail (wide) | 64 | 7 KiB |
| `kenney-commercial/detail-overhang.glb` | Overhang shopfront detail | 64 | 7 KiB |
| `kenney-commercial/detail-parasol-a.glb` | Parasol / umbrella detail | 96 | 10 KiB |
| `kenney-commercial/detail-parasol-b.glb` | Parasol / umbrella detail | 120 | 12 KiB |
| `kenney-commercial/low-detail-building-a.glb` | Low-detail commercial block (background/LOD): building a | 188 | 14 KiB |
| `kenney-commercial/low-detail-building-b.glb` | Low-detail commercial block (background/LOD): building b | 200 | 16 KiB |
| `kenney-commercial/low-detail-building-c.glb` | Low-detail commercial block (background/LOD): building c | 142 | 12 KiB |
| `kenney-commercial/low-detail-building-d.glb` | Low-detail commercial block (background/LOD): building d | 106 | 9 KiB |
| `kenney-commercial/low-detail-building-e.glb` | Low-detail commercial block (background/LOD): building e | 96 | 8 KiB |
| `kenney-commercial/low-detail-building-f.glb` | Low-detail commercial block (background/LOD): building f | 88 | 7 KiB |
| `kenney-commercial/low-detail-building-g.glb` | Low-detail commercial block (background/LOD): building g | 200 | 16 KiB |
| `kenney-commercial/low-detail-building-h.glb` | Low-detail commercial block (background/LOD): building h | 378 | 26 KiB |
| `kenney-commercial/low-detail-building-i.glb` | Low-detail commercial block (background/LOD): building i | 152 | 11 KiB |
| `kenney-commercial/low-detail-building-j.glb` | Low-detail commercial block (background/LOD): building j | 188 | 16 KiB |
| `kenney-commercial/low-detail-building-k.glb` | Low-detail commercial block (background/LOD): building k | 86 | 7 KiB |
| `kenney-commercial/low-detail-building-l.glb` | Low-detail commercial block (background/LOD): building l | 150 | 12 KiB |
| `kenney-commercial/low-detail-building-m.glb` | Low-detail commercial block (background/LOD): building m | 188 | 15 KiB |
| `kenney-commercial/low-detail-building-n.glb` | Low-detail commercial block (background/LOD): building n | 62 | 6 KiB |
| `kenney-commercial/low-detail-building-wide-a.glb` | Low-detail commercial block (background/LOD): building wide a | 156 | 12 KiB |
| `kenney-commercial/low-detail-building-wide-b.glb` | Low-detail commercial block (background/LOD): building wide b | 246 | 18 KiB |

## kenney-factory/ — Kenney Factory Kit

Source: https://kenney.nl/assets/factory-kit · License: CC0 1.0 Universal
(143 files, 3013 KiB, 31,113 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-factory/arrow-basic-rounded.glb` | Arrow marker: basic rounded | 40 | 5 KiB |
| `kenney-factory/arrow-basic.glb` | Arrow marker: basic | 20 | 4 KiB |
| `kenney-factory/arrow-rounded.glb` | Arrow marker: rounded | 44 | 5 KiB |
| `kenney-factory/arrow.glb` | arrow | 24 | 4 KiB |
| `kenney-factory/box-large.glb` | Crate: large | 70 | 7 KiB |
| `kenney-factory/box-long.glb` | Crate: long | 70 | 7 KiB |
| `kenney-factory/box-small.glb` | Crate: small | 70 | 7 KiB |
| `kenney-factory/box-wide.glb` | Crate: wide | 70 | 7 KiB |
| `kenney-factory/button-floor-round-small.glb` | Floor button: round small | 92 | 14 KiB |
| `kenney-factory/button-floor-round.glb` | Floor button: round | 92 | 14 KiB |
| `kenney-factory/button-floor-square-small.glb` | Floor button: square small | 102 | 16 KiB |
| `kenney-factory/button-floor-square.glb` | Floor button: square | 102 | 16 KiB |
| `kenney-factory/catwalk-corner.glb` | Catwalk: corner | 486 | 48 KiB |
| `kenney-factory/catwalk-cross.glb` | Catwalk: cross | 196 | 21 KiB |
| `kenney-factory/catwalk-junction.glb` | Catwalk: junction | 290 | 30 KiB |
| `kenney-factory/catwalk-stairs-loop.glb` | Catwalk: stairs loop | 328 | 32 KiB |
| `kenney-factory/catwalk-stairs.glb` | Catwalk: stairs | 668 | 65 KiB |
| `kenney-factory/catwalk-straight.glb` | Catwalk: straight | 328 | 33 KiB |
| `kenney-factory/cog-a.glb` | Gear/cog: a | 160 | 13 KiB |
| `kenney-factory/cog-b.glb` | Gear/cog: b | 192 | 16 KiB |
| `kenney-factory/cog-c.glb` | Gear/cog: c | 160 | 13 KiB |
| `kenney-factory/cog-d.glb` | Gear/cog: d | 160 | 13 KiB |
| `kenney-factory/cog-e.glb` | Gear/cog: e | 224 | 19 KiB |
| `kenney-factory/cone.glb` | cone | 66 | 7 KiB |
| `kenney-factory/conveyor-bars-fence-slope.glb` | Conveyor belt: bars fence slope | 296 | 29 KiB |
| `kenney-factory/conveyor-bars-fence.glb` | Conveyor belt: bars fence | 296 | 29 KiB |
| `kenney-factory/conveyor-bars-high-slope.glb` | Conveyor belt: bars high slope | 204 | 20 KiB |
| `kenney-factory/conveyor-bars-high.glb` | Conveyor belt: bars high | 204 | 20 KiB |
| `kenney-factory/conveyor-bars-sides.glb` | Conveyor belt: bars sides | 272 | 21 KiB |
| `kenney-factory/conveyor-bars-stripe-fence-slope.glb` | Conveyor belt: bars stripe fence slope | 472 | 44 KiB |
| `kenney-factory/conveyor-bars-stripe-fence.glb` | Conveyor belt: bars stripe fence | 472 | 44 KiB |
| `kenney-factory/conveyor-bars-stripe-high-slope.glb` | Conveyor belt: bars stripe high slope | 380 | 36 KiB |
| `kenney-factory/conveyor-bars-stripe-high.glb` | Conveyor belt: bars stripe high | 380 | 36 KiB |
| `kenney-factory/conveyor-bars-stripe-side.glb` | Conveyor belt: bars stripe side | 400 | 33 KiB |
| `kenney-factory/conveyor-bars-stripe.glb` | Conveyor belt: bars stripe | 368 | 30 KiB |
| `kenney-factory/conveyor-bars.glb` | Conveyor belt: bars | 240 | 18 KiB |
| `kenney-factory/conveyor-corner.glb` | Conveyor belt: corner | 234 | 22 KiB |
| `kenney-factory/conveyor-cross.glb` | Conveyor belt: cross | 44 | 6 KiB |
| `kenney-factory/conveyor-junction-t.glb` | Conveyor belt: junction t | 120 | 12 KiB |
| `kenney-factory/conveyor-long-part-end.glb` | Conveyor belt: long part end | 152 | 13 KiB |
| `kenney-factory/conveyor-long-part-middle.glb` | Conveyor belt: long part middle | 44 | 5 KiB |
| `kenney-factory/conveyor-long-sides-part-end.glb` | Conveyor belt: long sides part end | 184 | 17 KiB |
| `kenney-factory/conveyor-long-sides-part-middle.glb` | Conveyor belt: long sides part middle | 76 | 8 KiB |
| `kenney-factory/conveyor-long-sides.glb` | Conveyor belt: long sides | 228 | 22 KiB |
| `kenney-factory/conveyor-long-stripe-sides-part-end.glb` | Conveyor belt: long stripe sides part end | 216 | 22 KiB |
| `kenney-factory/conveyor-long-stripe-sides-part-middle.glb` | Conveyor belt: long stripe sides part middle | 92 | 10 KiB |
| `kenney-factory/conveyor-long-stripe-sides.glb` | Conveyor belt: long stripe sides | 276 | 26 KiB |
| `kenney-factory/conveyor-long-stripe.glb` | Conveyor belt: long stripe | 244 | 23 KiB |
| `kenney-factory/conveyor-long.glb` | Conveyor belt: long | 196 | 18 KiB |
| `kenney-factory/conveyor-sides-cross.glb` | Conveyor belt: sides cross | 44 | 6 KiB |
| `kenney-factory/conveyor-sides-junction-t.glb` | Conveyor belt: sides junction t | 136 | 13 KiB |
| `kenney-factory/conveyor-sides.glb` | Conveyor belt: sides | 228 | 22 KiB |
| `kenney-factory/conveyor-stripe-corner.glb` | Conveyor belt: stripe corner | 258 | 23 KiB |
| `kenney-factory/conveyor-stripe-cross.glb` | Conveyor belt: stripe cross | 172 | 17 KiB |
| `kenney-factory/conveyor-stripe-junction-t.glb` | Conveyor belt: stripe junction t | 207 | 20 KiB |
| `kenney-factory/conveyor-stripe-part-end.glb` | Conveyor belt: stripe part end | 184 | 16 KiB |
| `kenney-factory/conveyor-stripe-part-middle.glb` | Conveyor belt: stripe part middle | 60 | 7 KiB |
| `kenney-factory/conveyor-stripe-sides-cross.glb` | Conveyor belt: stripe sides cross | 172 | 17 KiB |
| `kenney-factory/conveyor-stripe-sides-junction-t.glb` | Conveyor belt: stripe sides junction t | 223 | 22 KiB |
| `kenney-factory/conveyor-stripe-sides.glb` | Conveyor belt: stripe sides | 276 | 26 KiB |
| `kenney-factory/conveyor-stripe.glb` | Conveyor belt: stripe | 244 | 23 KiB |
| `kenney-factory/conveyor.glb` | conveyor | 196 | 18 KiB |
| `kenney-factory/crane-lift.glb` | Crane: lift | 304 | 31 KiB |
| `kenney-factory/crane-magnet.glb` | Crane: magnet | 172 | 17 KiB |
| `kenney-factory/crane.glb` | crane | 564 | 52 KiB |
| `kenney-factory/door-wide-closed.glb` | Door: wide closed | 22 | 3 KiB |
| `kenney-factory/door-wide-half.glb` | Door: wide half | 20 | 3 KiB |
| `kenney-factory/door-wide-open.glb` | Door: wide open | 16 | 3 KiB |
| `kenney-factory/door.glb` | door | 156 | 19 KiB |
| `kenney-factory/floor-large.glb` | Floor plate: large | 2 | 2 KiB |
| `kenney-factory/floor.glb` | Conveyor belt: floor | 2 | 2 KiB |
| `kenney-factory/hopper-high-round.glb` | Hopper: high round | 176 | 16 KiB |
| `kenney-factory/hopper-high-square.glb` | Hopper: high square | 120 | 11 KiB |
| `kenney-factory/hopper-round.glb` | Hopper: round | 144 | 13 KiB |
| `kenney-factory/hopper-square.glb` | Hopper: square | 104 | 10 KiB |
| `kenney-factory/indicator-special-area.glb` | Floor indicator: special area | 18 | 3 KiB |
| `kenney-factory/indicator-special-arrow.glb` | Floor indicator: special arrow | 15 | 2 KiB |
| `kenney-factory/indicator-special-cross.glb` | Floor indicator: special cross | 22 | 3 KiB |
| `kenney-factory/indicator-special-lines.glb` | Floor indicator: special lines | 16 | 3 KiB |
| `kenney-factory/lever-double.glb` | Lever: double | 118 | 18 KiB |
| `kenney-factory/lever-single.glb` | Lever: single | 102 | 17 KiB |
| `kenney-factory/machine-bed.glb` | Machine: bed | 568 | 51 KiB |
| `kenney-factory/machine-connection-hole.glb` | Machine: connection hole | 294 | 27 KiB |
| `kenney-factory/machine-connection-pipe.glb` | Machine: connection pipe | 342 | 31 KiB |
| `kenney-factory/machine-fortified.glb` | Machine: fortified | 320 | 29 KiB |
| `kenney-factory/machine-window-bar.glb` | Machine: window bar | 444 | 40 KiB |
| `kenney-factory/machine-window.glb` | Machine: window | 428 | 38 KiB |
| `kenney-factory/machine.glb` | machine | 268 | 25 KiB |
| `kenney-factory/oopi.glb` | Oopi character figure (Kenney mascot) | 938 | 78 KiB |
| `kenney-factory/pipe-glass-large-bend.glb` | Pipe: glass large bend | 448 | 44 KiB |
| `kenney-factory/pipe-glass-large-bump.glb` | Pipe: glass large bump | 256 | 25 KiB |
| `kenney-factory/pipe-glass-large-cross.glb` | Pipe: glass large cross | 384 | 33 KiB |
| `kenney-factory/pipe-glass-large-curve.glb` | Pipe: glass large curve | 288 | 27 KiB |
| `kenney-factory/pipe-glass-large-junction.glb` | Pipe: glass large junction | 276 | 25 KiB |
| `kenney-factory/pipe-glass-large-long.glb` | Pipe: glass large long | 160 | 15 KiB |
| `kenney-factory/pipe-glass-large-side.glb` | Pipe: glass large side | 276 | 24 KiB |
| `kenney-factory/pipe-glass-large-valve.glb` | Pipe: glass large valve | 416 | 39 KiB |
| `kenney-factory/pipe-glass-large.glb` | Pipe: glass large | 160 | 15 KiB |
| `kenney-factory/pipe-large-bend.glb` | Pipe: large bend | 448 | 43 KiB |
| `kenney-factory/pipe-large-bump.glb` | Pipe: large bump | 296 | 27 KiB |
| `kenney-factory/pipe-large-cross.glb` | Pipe: large cross | 472 | 41 KiB |
| `kenney-factory/pipe-large-curve.glb` | Pipe: large curve | 332 | 31 KiB |
| `kenney-factory/pipe-large-junction.glb` | Pipe: large junction | 412 | 35 KiB |
| `kenney-factory/pipe-large-long.glb` | Pipe: large long | 292 | 27 KiB |
| `kenney-factory/pipe-large-side.glb` | Pipe: large side | 364 | 32 KiB |
| `kenney-factory/pipe-large-valve.glb` | Pipe: large valve | 456 | 42 KiB |
| `kenney-factory/pipe-large.glb` | Pipe: large | 248 | 23 KiB |
| `kenney-factory/piston-round.glb` | Piston: round | 276 | 37 KiB |
| `kenney-factory/piston-square.glb` | Piston: square | 180 | 29 KiB |
| `kenney-factory/piston-thin-round.glb` | Piston: thin round | 276 | 37 KiB |
| `kenney-factory/piston-thin-square.glb` | Piston: thin square | 180 | 29 KiB |
| `kenney-factory/robot-arm-a.glb` | Robot arm: a | 472 | 49 KiB |
| `kenney-factory/robot-arm-b.glb` | Robot arm: b | 420 | 43 KiB |
| `kenney-factory/scanner-high.glb` | Scanner: high | 240 | 21 KiB |
| `kenney-factory/scanner-low.glb` | Scanner: low | 240 | 22 KiB |
| `kenney-factory/screen-flat.glb` | Screen/monitor: flat | 120 | 11 KiB |
| `kenney-factory/screen-hanging-small.glb` | Screen/monitor: hanging small | 86 | 9 KiB |
| `kenney-factory/screen-hanging-wide.glb` | Screen/monitor: hanging wide | 96 | 10 KiB |
| `kenney-factory/screen-panel-flat.glb` | Screen/monitor: panel flat | 138 | 13 KiB |
| `kenney-factory/screen-panel-small.glb` | Screen/monitor: panel small | 144 | 14 KiB |
| `kenney-factory/screen-panel-wide.glb` | Screen/monitor: panel wide | 162 | 16 KiB |
| `kenney-factory/screen-small.glb` | Screen/monitor: small | 126 | 12 KiB |
| `kenney-factory/screen-wide.glb` | Screen/monitor: wide | 144 | 14 KiB |
| `kenney-factory/structure-corner-inner.glb` | Structural frame: corner inner | 50 | 6 KiB |
| `kenney-factory/structure-corner-outer.glb` | Structural frame: corner outer | 50 | 6 KiB |
| `kenney-factory/structure-doorway-wide.glb` | Structural frame: doorway wide | 46 | 5 KiB |
| `kenney-factory/structure-doorway.glb` | Structural frame: doorway | 60 | 6 KiB |
| `kenney-factory/structure-high.glb` | Structural frame: high | 268 | 25 KiB |
| `kenney-factory/structure-medium.glb` | Structural frame: medium | 268 | 25 KiB |
| `kenney-factory/structure-short.glb` | Structural frame: short | 268 | 25 KiB |
| `kenney-factory/structure-tall.glb` | Structural frame: tall | 268 | 25 KiB |
| `kenney-factory/structure-wall.glb` | Structural frame: wall | 26 | 4 KiB |
| `kenney-factory/structure-window-wide.glb` | Structural frame: window wide | 274 | 23 KiB |
| `kenney-factory/structure-window.glb` | Structural frame: window | 226 | 19 KiB |
| `kenney-factory/structure-yellow-high.glb` | Structural frame: yellow high | 392 | 36 KiB |
| `kenney-factory/structure-yellow-medium.glb` | Structural frame: yellow medium | 392 | 36 KiB |
| `kenney-factory/structure-yellow-short.glb` | Structural frame: yellow short | 268 | 25 KiB |
| `kenney-factory/structure-yellow-tall.glb` | Structural frame: yellow tall | 392 | 36 KiB |
| `kenney-factory/top-large-checkerboard.glb` | Table top: large checkerboard | 8 | 2 KiB |
| `kenney-factory/top-large.glb` | Table top: large | 2 | 2 KiB |
| `kenney-factory/top.glb` | top | 2 | 2 KiB |
| `kenney-factory/warning-orange.glb` | Warning sign: orange | 154 | 16 KiB |
| `kenney-factory/warning-traffic.glb` | Warning sign: traffic | 176 | 18 KiB |

## kenney-industrial/ — Kenney City Kit (Industrial)

Source: https://kenney.nl/assets/city-kit-industrial · License: CC0 1.0 Universal
(37 files, 3066 KiB, 35,390 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-industrial/building-a.glb` | Industrial building A (factory/warehouse) | 2,046 | 173 KiB |
| `kenney-industrial/building-b.glb` | Industrial building B (factory/warehouse) | 2,422 | 207 KiB |
| `kenney-industrial/building-c.glb` | Industrial building C (factory/warehouse) | 1,928 | 172 KiB |
| `kenney-industrial/building-d.glb` | Industrial building D (factory/warehouse) | 1,158 | 98 KiB |
| `kenney-industrial/building-e.glb` | Industrial building E (factory/warehouse) | 1,484 | 126 KiB |
| `kenney-industrial/building-f.glb` | Industrial building F (factory/warehouse) | 1,552 | 132 KiB |
| `kenney-industrial/building-g.glb` | Industrial building G (factory/warehouse) | 1,242 | 104 KiB |
| `kenney-industrial/building-h.glb` | Industrial building H (factory/warehouse) | 698 | 62 KiB |
| `kenney-industrial/building-i.glb` | Industrial building I (factory/warehouse) | 798 | 72 KiB |
| `kenney-industrial/building-j.glb` | Industrial building J (factory/warehouse) | 886 | 79 KiB |
| `kenney-industrial/building-k.glb` | Industrial building K (factory/warehouse) | 702 | 64 KiB |
| `kenney-industrial/building-l.glb` | Industrial building L (factory/warehouse) | 1,896 | 159 KiB |
| `kenney-industrial/building-m.glb` | Industrial building M (factory/warehouse) | 1,694 | 136 KiB |
| `kenney-industrial/building-n.glb` | Industrial building N (factory/warehouse) | 1,262 | 107 KiB |
| `kenney-industrial/building-o.glb` | Industrial building O (factory/warehouse) | 868 | 75 KiB |
| `kenney-industrial/building-p.glb` | Industrial building P (factory/warehouse) | 1,162 | 101 KiB |
| `kenney-industrial/building-q.glb` | Industrial building Q (factory/warehouse) | 2,062 | 177 KiB |
| `kenney-industrial/building-r.glb` | Industrial building R (factory/warehouse) | 1,912 | 169 KiB |
| `kenney-industrial/building-s.glb` | Industrial building S (factory/warehouse) | 876 | 79 KiB |
| `kenney-industrial/building-t.glb` | Industrial building T (factory/warehouse) | 1,586 | 137 KiB |
| `kenney-industrial/chimney-basic.glb` | Factory chimney (basic) | 88 | 9 KiB |
| `kenney-industrial/chimney-large.glb` | Factory chimney (large) | 218 | 20 KiB |
| `kenney-industrial/chimney-medium.glb` | Factory chimney (medium) | 160 | 15 KiB |
| `kenney-industrial/chimney-small.glb` | Factory chimney (small) | 124 | 10 KiB |
| `kenney-industrial/detail-tank-large.glb` | Industrial storage tank (large) | 566 | 46 KiB |
| `kenney-industrial/detail-tank.glb` | Industrial storage tank | 310 | 31 KiB |
| `kenney-industrial/shipping-container-a.glb` | Shipping container A | 402 | 36 KiB |
| `kenney-industrial/shipping-container-b.glb` | Shipping container B | 402 | 36 KiB |
| `kenney-industrial/shipping-container-c.glb` | Shipping container C | 402 | 36 KiB |
| `kenney-industrial/solar-panel-flat.glb` | Solar panel (flat) | 164 | 14 KiB |
| `kenney-industrial/solar-panel-landscape-group.glb` | Solar panel (landscape group) | 976 | 80 KiB |
| `kenney-industrial/solar-panel-landscape.glb` | Solar panel (landscape) | 244 | 21 KiB |
| `kenney-industrial/solar-panel-portrait-group.glb` | Solar panel (portrait group) | 976 | 80 KiB |
| `kenney-industrial/solar-panel-portrait.glb` | Solar panel (portrait) | 244 | 21 KiB |
| `kenney-industrial/water-tower.glb` | Water tower | 968 | 92 KiB |
| `kenney-industrial/windmill-low.glb` | Wind turbine (low) | 456 | 45 KiB |
| `kenney-industrial/windmill.glb` | Wind turbine | 456 | 45 KiB |

## kenney-nature/ — Kenney Nature Kit

Source: https://kenney.nl/assets/nature-kit · License: CC0 1.0 Universal
(329 files, 2963 KiB, 36,311 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-nature/bed.glb` | Garden/flower bed | 268 | 19 KiB |
| `kenney-nature/bed_floor.glb` | Garden/flower bed (floor) | 124 | 10 KiB |
| `kenney-nature/bridge_center_stone.glb` | Bridge: center stone | 52 | 5 KiB |
| `kenney-nature/bridge_center_stoneRound.glb` | Bridge: center stoneRound | 52 | 5 KiB |
| `kenney-nature/bridge_center_wood.glb` | Bridge: center wood | 52 | 5 KiB |
| `kenney-nature/bridge_center_woodRound.glb` | Bridge: center woodRound | 60 | 6 KiB |
| `kenney-nature/bridge_side_stone.glb` | Bridge: side stone | 152 | 11 KiB |
| `kenney-nature/bridge_side_stoneRound.glb` | Bridge: side stoneRound | 198 | 13 KiB |
| `kenney-nature/bridge_side_wood.glb` | Bridge: side wood | 136 | 10 KiB |
| `kenney-nature/bridge_side_woodRound.glb` | Bridge: side woodRound | 190 | 13 KiB |
| `kenney-nature/bridge_stone.glb` | Bridge: stone | 252 | 17 KiB |
| `kenney-nature/bridge_stoneNarrow.glb` | Bridge: stoneNarrow | 252 | 17 KiB |
| `kenney-nature/bridge_stoneRound.glb` | Bridge: stoneRound | 360 | 22 KiB |
| `kenney-nature/bridge_stoneRoundNarrow.glb` | Bridge: stoneRoundNarrow | 360 | 22 KiB |
| `kenney-nature/bridge_wood.glb` | Bridge: wood | 220 | 15 KiB |
| `kenney-nature/bridge_woodNarrow.glb` | Bridge: woodNarrow | 220 | 15 KiB |
| `kenney-nature/bridge_woodRound.glb` | Bridge: woodRound | 336 | 21 KiB |
| `kenney-nature/bridge_woodRoundNarrow.glb` | Bridge: woodRoundNarrow | 336 | 21 KiB |
| `kenney-nature/cactus_short.glb` | Cactus (short) | 116 | 9 KiB |
| `kenney-nature/cactus_tall.glb` | Cactus (tall) | 122 | 9 KiB |
| `kenney-nature/campfire_bricks.glb` | Campfire (bricks) | 120 | 10 KiB |
| `kenney-nature/campfire_logs.glb` | Campfire (logs) | 112 | 9 KiB |
| `kenney-nature/campfire_planks.glb` | Campfire (planks) | 108 | 8 KiB |
| `kenney-nature/campfire_stones.glb` | Campfire (stones) | 264 | 17 KiB |
| `kenney-nature/canoe.glb` | Canoe | 200 | 15 KiB |
| `kenney-nature/canoe_paddle.glb` | Canoe paddle | 32 | 4 KiB |
| `kenney-nature/cliff_blockCave_rock.glb` | Cliff block: blockCave rock | 56 | 5 KiB |
| `kenney-nature/cliff_blockCave_stone.glb` | Cliff block: blockCave stone | 56 | 5 KiB |
| `kenney-nature/cliff_blockDiagonal_rock.glb` | Cliff block: blockDiagonal rock | 8 | 3 KiB |
| `kenney-nature/cliff_blockDiagonal_stone.glb` | Cliff block: blockDiagonal stone | 8 | 3 KiB |
| `kenney-nature/cliff_blockHalf_rock.glb` | Cliff block: blockHalf rock | 12 | 3 KiB |
| `kenney-nature/cliff_blockHalf_stone.glb` | Cliff block: blockHalf stone | 12 | 3 KiB |
| `kenney-nature/cliff_blockQuarter_rock.glb` | Cliff block: blockQuarter rock | 12 | 3 KiB |
| `kenney-nature/cliff_blockQuarter_stone.glb` | Cliff block: blockQuarter stone | 12 | 3 KiB |
| `kenney-nature/cliff_blockSlopeHalfWalls_rock.glb` | Cliff block: blockSlopeHalfWalls rock | 106 | 9 KiB |
| `kenney-nature/cliff_blockSlopeHalfWalls_stone.glb` | Cliff block: blockSlopeHalfWalls stone | 106 | 9 KiB |
| `kenney-nature/cliff_blockSlopeWalls_rock.glb` | Cliff block: blockSlopeWalls rock | 106 | 9 KiB |
| `kenney-nature/cliff_blockSlopeWalls_stone.glb` | Cliff block: blockSlopeWalls stone | 106 | 9 KiB |
| `kenney-nature/cliff_blockSlope_rock.glb` | Cliff block: blockSlope rock | 70 | 7 KiB |
| `kenney-nature/cliff_blockSlope_stone.glb` | Cliff block: blockSlope stone | 70 | 7 KiB |
| `kenney-nature/cliff_block_rock.glb` | Cliff block: block rock | 12 | 3 KiB |
| `kenney-nature/cliff_block_stone.glb` | Cliff block: block stone | 12 | 3 KiB |
| `kenney-nature/cliff_cave_rock.glb` | Cliff block: cave rock | 64 | 5 KiB |
| `kenney-nature/cliff_cave_stone.glb` | Cliff block: cave stone | 64 | 5 KiB |
| `kenney-nature/cliff_cornerInnerLarge_rock.glb` | Cliff block: cornerInnerLarge rock | 44 | 4 KiB |
| `kenney-nature/cliff_cornerInnerLarge_stone.glb` | Cliff block: cornerInnerLarge stone | 44 | 4 KiB |
| `kenney-nature/cliff_cornerInnerTop_rock.glb` | Cliff block: cornerInnerTop rock | 89 | 7 KiB |
| `kenney-nature/cliff_cornerInnerTop_stone.glb` | Cliff block: cornerInnerTop stone | 89 | 7 KiB |
| `kenney-nature/cliff_cornerInner_rock.glb` | Cliff block: cornerInner rock | 56 | 5 KiB |
| `kenney-nature/cliff_cornerInner_stone.glb` | Cliff block: cornerInner stone | 112 | 8 KiB |
| `kenney-nature/cliff_cornerLarge_rock.glb` | Cliff block: cornerLarge rock | 12 | 2 KiB |
| `kenney-nature/cliff_cornerLarge_stone.glb` | Cliff block: cornerLarge stone | 24 | 3 KiB |
| `kenney-nature/cliff_cornerTop_rock.glb` | Cliff block: cornerTop rock | 16 | 3 KiB |
| `kenney-nature/cliff_cornerTop_stone.glb` | Cliff block: cornerTop stone | 16 | 3 KiB |
| `kenney-nature/cliff_corner_rock.glb` | Cliff block: corner rock | 12 | 2 KiB |
| `kenney-nature/cliff_corner_stone.glb` | Cliff block: corner stone | 12 | 2 KiB |
| `kenney-nature/cliff_diagonal_rock.glb` | Cliff block: diagonal rock | 44 | 4 KiB |
| `kenney-nature/cliff_diagonal_stone.glb` | Cliff block: diagonal stone | 44 | 4 KiB |
| `kenney-nature/cliff_halfCornerInner_rock.glb` | Cliff block: halfCornerInner rock | 89 | 8 KiB |
| `kenney-nature/cliff_halfCornerInner_stone.glb` | Cliff block: halfCornerInner stone | 89 | 8 KiB |
| `kenney-nature/cliff_halfCorner_rock.glb` | Cliff block: halfCorner rock | 16 | 3 KiB |
| `kenney-nature/cliff_halfCorner_stone.glb` | Cliff block: halfCorner stone | 16 | 3 KiB |
| `kenney-nature/cliff_half_rock.glb` | Cliff block: half rock | 53 | 5 KiB |
| `kenney-nature/cliff_half_stone.glb` | Cliff block: half stone | 53 | 5 KiB |
| `kenney-nature/cliff_large_rock.glb` | Cliff block: large rock | 32 | 3 KiB |
| `kenney-nature/cliff_large_stone.glb` | Cliff block: large stone | 32 | 3 KiB |
| `kenney-nature/cliff_rock.glb` | Cliff block: rock | 32 | 3 KiB |
| `kenney-nature/cliff_stepsCornerInner_rock.glb` | Cliff block: stepsCornerInner rock | 213 | 15 KiB |
| `kenney-nature/cliff_stepsCornerInner_stone.glb` | Cliff block: stepsCornerInner stone | 213 | 15 KiB |
| `kenney-nature/cliff_stepsCorner_rock.glb` | Cliff block: stepsCorner rock | 245 | 17 KiB |
| `kenney-nature/cliff_stepsCorner_stone.glb` | Cliff block: stepsCorner stone | 245 | 17 KiB |
| `kenney-nature/cliff_steps_rock.glb` | Cliff block: steps rock | 219 | 16 KiB |
| `kenney-nature/cliff_steps_stone.glb` | Cliff block: steps stone | 219 | 16 KiB |
| `kenney-nature/cliff_stone.glb` | Cliff block: stone | 32 | 3 KiB |
| `kenney-nature/cliff_topDiagonal_rock.glb` | Cliff block: topDiagonal rock | 66 | 6 KiB |
| `kenney-nature/cliff_topDiagonal_stone.glb` | Cliff block: topDiagonal stone | 132 | 10 KiB |
| `kenney-nature/cliff_top_rock.glb` | Cliff block: top rock | 53 | 5 KiB |
| `kenney-nature/cliff_top_stone.glb` | Cliff block: top stone | 53 | 5 KiB |
| `kenney-nature/cliff_waterfallTop_rock.glb` | Cliff block: waterfallTop rock | 60 | 7 KiB |
| `kenney-nature/cliff_waterfallTop_stone.glb` | Cliff block: waterfallTop stone | 60 | 7 KiB |
| `kenney-nature/cliff_waterfall_rock.glb` | Cliff block: waterfall rock | 34 | 4 KiB |
| `kenney-nature/cliff_waterfall_stone.glb` | Cliff block: waterfall stone | 68 | 6 KiB |
| `kenney-nature/crop_carrot.glb` | crop carrot | 148 | 12 KiB |
| `kenney-nature/crop_melon.glb` | crop melon | 236 | 13 KiB |
| `kenney-nature/crop_pumpkin.glb` | crop pumpkin | 120 | 11 KiB |
| `kenney-nature/crop_turnip.glb` | crop turnip | 168 | 14 KiB |
| `kenney-nature/crops_bambooStageA.glb` | crops bambooStageA | 276 | 22 KiB |
| `kenney-nature/crops_bambooStageB.glb` | crops bambooStageB | 564 | 39 KiB |
| `kenney-nature/crops_cornStageA.glb` | crops cornStageA | 100 | 9 KiB |
| `kenney-nature/crops_cornStageB.glb` | crops cornStageB | 116 | 10 KiB |
| `kenney-nature/crops_cornStageC.glb` | crops cornStageC | 148 | 12 KiB |
| `kenney-nature/crops_cornStageD.glb` | crops cornStageD | 300 | 29 KiB |
| `kenney-nature/crops_dirtDoubleRow.glb` | crops dirtDoubleRow | 88 | 7 KiB |
| `kenney-nature/crops_dirtDoubleRowCorner.glb` | crops dirtDoubleRowCorner | 50 | 5 KiB |
| `kenney-nature/crops_dirtDoubleRowEnd.glb` | crops dirtDoubleRowEnd | 64 | 6 KiB |
| `kenney-nature/crops_dirtRow.glb` | crops dirtRow | 44 | 5 KiB |
| `kenney-nature/crops_dirtRowCorner.glb` | crops dirtRowCorner | 19 | 3 KiB |
| `kenney-nature/crops_dirtRowEnd.glb` | crops dirtRowEnd | 32 | 4 KiB |
| `kenney-nature/crops_dirtSingle.glb` | crops dirtSingle | 32 | 4 KiB |
| `kenney-nature/crops_leafsStageA.glb` | crops leafsStageA | 76 | 7 KiB |
| `kenney-nature/crops_leafsStageB.glb` | crops leafsStageB | 84 | 8 KiB |
| `kenney-nature/crops_wheatStageA.glb` | crops wheatStageA | 720 | 55 KiB |
| `kenney-nature/crops_wheatStageB.glb` | crops wheatStageB | 360 | 29 KiB |
| `kenney-nature/fence_bend.glb` | Wooden fence: fence bend | 240 | 16 KiB |
| `kenney-nature/fence_bendCenter.glb` | Wooden fence: fence bendCenter | 298 | 20 KiB |
| `kenney-nature/fence_corner.glb` | Wooden fence: fence corner | 116 | 8 KiB |
| `kenney-nature/fence_gate.glb` | Wooden fence: fence gate | 524 | 27 KiB |
| `kenney-nature/fence_planks.glb` | Wooden fence: fence planks | 96 | 8 KiB |
| `kenney-nature/fence_planksDouble.glb` | Wooden fence: fence planksDouble | 152 | 11 KiB |
| `kenney-nature/fence_simple.glb` | Wooden fence: fence simple | 64 | 6 KiB |
| `kenney-nature/fence_simpleCenter.glb` | Wooden fence: fence simpleCenter | 116 | 8 KiB |
| `kenney-nature/fence_simpleDiagonal.glb` | Wooden fence: fence simpleDiagonal | 80 | 7 KiB |
| `kenney-nature/fence_simpleDiagonalCenter.glb` | Wooden fence: fence simpleDiagonalCenter | 148 | 11 KiB |
| `kenney-nature/fence_simpleHigh.glb` | Wooden fence: fence simpleHigh | 44 | 4 KiB |
| `kenney-nature/fence_simpleLow.glb` | Wooden fence: fence simpleLow | 44 | 4 KiB |
| `kenney-nature/flower_purpleA.glb` | Flowers: purpleA | 76 | 7 KiB |
| `kenney-nature/flower_purpleB.glb` | Flowers: purpleB | 98 | 8 KiB |
| `kenney-nature/flower_purpleC.glb` | Flowers: purpleC | 78 | 7 KiB |
| `kenney-nature/flower_redA.glb` | Flowers: redA | 76 | 7 KiB |
| `kenney-nature/flower_redB.glb` | Flowers: redB | 98 | 8 KiB |
| `kenney-nature/flower_redC.glb` | Flowers: redC | 78 | 7 KiB |
| `kenney-nature/flower_yellowA.glb` | Flowers: yellowA | 76 | 7 KiB |
| `kenney-nature/flower_yellowB.glb` | Flowers: yellowB | 154 | 11 KiB |
| `kenney-nature/flower_yellowC.glb` | Flowers: yellowC | 78 | 7 KiB |
| `kenney-nature/grass.glb` | grass | 132 | 11 KiB |
| `kenney-nature/grass_large.glb` | Grass tuft: large | 224 | 18 KiB |
| `kenney-nature/grass_leafs.glb` | Grass tuft: leafs | 36 | 4 KiB |
| `kenney-nature/grass_leafsLarge.glb` | Grass tuft: leafsLarge | 144 | 14 KiB |
| `kenney-nature/ground_grass.glb` | ground grass | 2 | 2 KiB |
| `kenney-nature/ground_pathBend.glb` | ground pathBend | 32 | 4 KiB |
| `kenney-nature/ground_pathBendBank.glb` | ground pathBendBank | 38 | 4 KiB |
| `kenney-nature/ground_pathCorner.glb` | ground pathCorner | 22 | 3 KiB |
| `kenney-nature/ground_pathCornerSmall.glb` | ground pathCornerSmall | 24 | 4 KiB |
| `kenney-nature/ground_pathCross.glb` | ground pathCross | 74 | 6 KiB |
| `kenney-nature/ground_pathEnd.glb` | ground pathEnd | 52 | 5 KiB |
| `kenney-nature/ground_pathEndClosed.glb` | ground pathEndClosed | 68 | 6 KiB |
| `kenney-nature/ground_pathOpen.glb` | ground pathOpen | 8 | 2 KiB |
| `kenney-nature/ground_pathRocks.glb` | ground pathRocks | 102 | 8 KiB |
| `kenney-nature/ground_pathSide.glb` | ground pathSide | 34 | 4 KiB |
| `kenney-nature/ground_pathSideOpen.glb` | ground pathSideOpen | 40 | 4 KiB |
| `kenney-nature/ground_pathSplit.glb` | ground pathSplit | 68 | 6 KiB |
| `kenney-nature/ground_pathStraight.glb` | ground pathStraight | 62 | 5 KiB |
| `kenney-nature/ground_pathTile.glb` | ground pathTile | 86 | 6 KiB |
| `kenney-nature/ground_riverBend.glb` | ground riverBend | 54 | 6 KiB |
| `kenney-nature/ground_riverBendBank.glb` | ground riverBendBank | 54 | 6 KiB |
| `kenney-nature/ground_riverCorner.glb` | ground riverCorner | 40 | 5 KiB |
| `kenney-nature/ground_riverCornerSmall.glb` | ground riverCornerSmall | 26 | 4 KiB |
| `kenney-nature/ground_riverCross.glb` | ground riverCross | 82 | 7 KiB |
| `kenney-nature/ground_riverEnd.glb` | ground riverEnd | 52 | 5 KiB |
| `kenney-nature/ground_riverEndClosed.glb` | ground riverEndClosed | 84 | 7 KiB |
| `kenney-nature/ground_riverOpen.glb` | ground riverOpen | 8 | 2 KiB |
| `kenney-nature/ground_riverRocks.glb` | ground riverRocks | 102 | 9 KiB |
| `kenney-nature/ground_riverSide.glb` | ground riverSide | 34 | 4 KiB |
| `kenney-nature/ground_riverSideOpen.glb` | ground riverSideOpen | 44 | 5 KiB |
| `kenney-nature/ground_riverSplit.glb` | ground riverSplit | 72 | 7 KiB |
| `kenney-nature/ground_riverStraight.glb` | ground riverStraight | 62 | 6 KiB |
| `kenney-nature/ground_riverTile.glb` | ground riverTile | 128 | 9 KiB |
| `kenney-nature/hanging_moss.glb` | hanging moss | 52 | 5 KiB |
| `kenney-nature/lily_large.glb` | lily large | 86 | 8 KiB |
| `kenney-nature/lily_small.glb` | lily small | 52 | 6 KiB |
| `kenney-nature/log.glb` | Fallen log | 200 | 14 KiB |
| `kenney-nature/log_large.glb` | Fallen log | 96 | 8 KiB |
| `kenney-nature/log_stack.glb` | Fallen log | 184 | 11 KiB |
| `kenney-nature/log_stackLarge.glb` | Fallen log | 310 | 17 KiB |
| `kenney-nature/mushroom_red.glb` | Mushroom (red) | 48 | 6 KiB |
| `kenney-nature/mushroom_redGroup.glb` | Mushroom (redGroup) | 144 | 15 KiB |
| `kenney-nature/mushroom_redTall.glb` | Mushroom (redTall) | 48 | 6 KiB |
| `kenney-nature/mushroom_tan.glb` | Mushroom (tan) | 48 | 6 KiB |
| `kenney-nature/mushroom_tanGroup.glb` | Mushroom (tanGroup) | 144 | 15 KiB |
| `kenney-nature/mushroom_tanTall.glb` | Mushroom (tanTall) | 48 | 6 KiB |
| `kenney-nature/path_stone.glb` | path stone | 136 | 12 KiB |
| `kenney-nature/path_stoneCircle.glb` | path stoneCircle | 164 | 13 KiB |
| `kenney-nature/path_stoneCorner.glb` | path stoneCorner | 112 | 11 KiB |
| `kenney-nature/path_stoneEnd.glb` | path stoneEnd | 92 | 9 KiB |
| `kenney-nature/path_wood.glb` | path wood | 60 | 6 KiB |
| `kenney-nature/path_woodCorner.glb` | path woodCorner | 60 | 6 KiB |
| `kenney-nature/path_woodEnd.glb` | path woodEnd | 36 | 5 KiB |
| `kenney-nature/plant_bush.glb` | Plant: bush | 32 | 4 KiB |
| `kenney-nature/plant_bushDetailed.glb` | Plant: bushDetailed | 104 | 10 KiB |
| `kenney-nature/plant_bushLarge.glb` | Plant: bushLarge | 60 | 6 KiB |
| `kenney-nature/plant_bushLargeTriangle.glb` | Plant: bushLargeTriangle | 39 | 4 KiB |
| `kenney-nature/plant_bushSmall.glb` | Plant: bushSmall | 16 | 3 KiB |
| `kenney-nature/plant_bushTriangle.glb` | Plant: bushTriangle | 30 | 4 KiB |
| `kenney-nature/plant_flatShort.glb` | Plant: flatShort | 44 | 4 KiB |
| `kenney-nature/plant_flatTall.glb` | Plant: flatTall | 32 | 3 KiB |
| `kenney-nature/platform_beach.glb` | platform beach | 192 | 13 KiB |
| `kenney-nature/platform_grass.glb` | platform grass | 186 | 12 KiB |
| `kenney-nature/platform_stone.glb` | platform stone | 192 | 13 KiB |
| `kenney-nature/pot_large.glb` | pot large | 68 | 6 KiB |
| `kenney-nature/pot_small.glb` | pot small | 72 | 7 KiB |
| `kenney-nature/rock_largeA.glb` | Rock: largeA | 80 | 7 KiB |
| `kenney-nature/rock_largeB.glb` | Rock: largeB | 85 | 8 KiB |
| `kenney-nature/rock_largeC.glb` | Rock: largeC | 72 | 7 KiB |
| `kenney-nature/rock_largeD.glb` | Rock: largeD | 80 | 8 KiB |
| `kenney-nature/rock_largeE.glb` | Rock: largeE | 64 | 6 KiB |
| `kenney-nature/rock_largeF.glb` | Rock: largeF | 73 | 7 KiB |
| `kenney-nature/rock_smallA.glb` | Rock: smallA | 16 | 3 KiB |
| `kenney-nature/rock_smallB.glb` | Rock: smallB | 24 | 3 KiB |
| `kenney-nature/rock_smallC.glb` | Rock: smallC | 16 | 3 KiB |
| `kenney-nature/rock_smallD.glb` | Rock: smallD | 32 | 4 KiB |
| `kenney-nature/rock_smallE.glb` | Rock: smallE | 64 | 6 KiB |
| `kenney-nature/rock_smallF.glb` | Rock: smallF | 60 | 6 KiB |
| `kenney-nature/rock_smallFlatA.glb` | Rock: smallFlatA | 20 | 3 KiB |
| `kenney-nature/rock_smallFlatB.glb` | Rock: smallFlatB | 16 | 3 KiB |
| `kenney-nature/rock_smallFlatC.glb` | Rock: smallFlatC | 40 | 4 KiB |
| `kenney-nature/rock_smallG.glb` | Rock: smallG | 32 | 4 KiB |
| `kenney-nature/rock_smallH.glb` | Rock: smallH | 60 | 6 KiB |
| `kenney-nature/rock_smallI.glb` | Rock: smallI | 44 | 5 KiB |
| `kenney-nature/rock_smallTopA.glb` | Rock: smallTopA | 52 | 5 KiB |
| `kenney-nature/rock_smallTopB.glb` | Rock: smallTopB | 76 | 7 KiB |
| `kenney-nature/rock_tallA.glb` | Rock: tallA | 136 | 12 KiB |
| `kenney-nature/rock_tallB.glb` | Rock: tallB | 172 | 14 KiB |
| `kenney-nature/rock_tallC.glb` | Rock: tallC | 37 | 5 KiB |
| `kenney-nature/rock_tallD.glb` | Rock: tallD | 38 | 5 KiB |
| `kenney-nature/rock_tallE.glb` | Rock: tallE | 38 | 5 KiB |
| `kenney-nature/rock_tallF.glb` | Rock: tallF | 46 | 5 KiB |
| `kenney-nature/rock_tallG.glb` | Rock: tallG | 62 | 7 KiB |
| `kenney-nature/rock_tallH.glb` | Rock: tallH | 78 | 8 KiB |
| `kenney-nature/rock_tallI.glb` | Rock: tallI | 44 | 5 KiB |
| `kenney-nature/rock_tallJ.glb` | Rock: tallJ | 42 | 5 KiB |
| `kenney-nature/sign.glb` | Wooden sign | 44 | 5 KiB |
| `kenney-nature/statue_block.glb` | statue block | 140 | 11 KiB |
| `kenney-nature/statue_column.glb` | statue column | 122 | 10 KiB |
| `kenney-nature/statue_columnDamaged.glb` | statue columnDamaged | 108 | 9 KiB |
| `kenney-nature/statue_head.glb` | statue head | 196 | 14 KiB |
| `kenney-nature/statue_obelisk.glb` | statue obelisk | 38 | 4 KiB |
| `kenney-nature/statue_ring.glb` | statue ring | 76 | 6 KiB |
| `kenney-nature/stone_largeA.glb` | Stone: largeA | 80 | 7 KiB |
| `kenney-nature/stone_largeB.glb` | Stone: largeB | 85 | 8 KiB |
| `kenney-nature/stone_largeC.glb` | Stone: largeC | 72 | 6 KiB |
| `kenney-nature/stone_largeD.glb` | Stone: largeD | 80 | 7 KiB |
| `kenney-nature/stone_largeE.glb` | Stone: largeE | 64 | 6 KiB |
| `kenney-nature/stone_largeF.glb` | Stone: largeF | 73 | 7 KiB |
| `kenney-nature/stone_smallA.glb` | Stone: smallA | 16 | 3 KiB |
| `kenney-nature/stone_smallB.glb` | Stone: smallB | 24 | 3 KiB |
| `kenney-nature/stone_smallC.glb` | Stone: smallC | 16 | 3 KiB |
| `kenney-nature/stone_smallD.glb` | Stone: smallD | 32 | 4 KiB |
| `kenney-nature/stone_smallE.glb` | Stone: smallE | 64 | 5 KiB |
| `kenney-nature/stone_smallF.glb` | Stone: smallF | 60 | 5 KiB |
| `kenney-nature/stone_smallFlatA.glb` | Stone: smallFlatA | 20 | 3 KiB |
| `kenney-nature/stone_smallFlatB.glb` | Stone: smallFlatB | 16 | 3 KiB |
| `kenney-nature/stone_smallFlatC.glb` | Stone: smallFlatC | 40 | 4 KiB |
| `kenney-nature/stone_smallG.glb` | Stone: smallG | 32 | 4 KiB |
| `kenney-nature/stone_smallH.glb` | Stone: smallH | 60 | 6 KiB |
| `kenney-nature/stone_smallI.glb` | Stone: smallI | 44 | 5 KiB |
| `kenney-nature/stone_smallTopA.glb` | Stone: smallTopA | 52 | 5 KiB |
| `kenney-nature/stone_smallTopB.glb` | Stone: smallTopB | 76 | 6 KiB |
| `kenney-nature/stone_tallA.glb` | Stone: tallA | 136 | 11 KiB |
| `kenney-nature/stone_tallB.glb` | Stone: tallB | 172 | 13 KiB |
| `kenney-nature/stone_tallC.glb` | Stone: tallC | 37 | 5 KiB |
| `kenney-nature/stone_tallD.glb` | Stone: tallD | 38 | 5 KiB |
| `kenney-nature/stone_tallE.glb` | Stone: tallE | 38 | 5 KiB |
| `kenney-nature/stone_tallF.glb` | Stone: tallF | 46 | 5 KiB |
| `kenney-nature/stone_tallG.glb` | Stone: tallG | 62 | 6 KiB |
| `kenney-nature/stone_tallH.glb` | Stone: tallH | 78 | 7 KiB |
| `kenney-nature/stone_tallI.glb` | Stone: tallI | 44 | 5 KiB |
| `kenney-nature/stone_tallJ.glb` | Stone: tallJ | 42 | 5 KiB |
| `kenney-nature/stump_old.glb` | Tree stump | 120 | 9 KiB |
| `kenney-nature/stump_oldTall.glb` | Tree stump | 120 | 9 KiB |
| `kenney-nature/stump_round.glb` | Tree stump | 56 | 6 KiB |
| `kenney-nature/stump_roundDetailed.glb` | Tree stump | 96 | 8 KiB |
| `kenney-nature/stump_square.glb` | Tree stump | 44 | 4 KiB |
| `kenney-nature/stump_squareDetailed.glb` | Tree stump | 84 | 7 KiB |
| `kenney-nature/stump_squareDetailedWide.glb` | Tree stump | 84 | 7 KiB |
| `kenney-nature/tent_detailedClosed.glb` | tent detailedClosed | 228 | 15 KiB |
| `kenney-nature/tent_detailedOpen.glb` | tent detailedOpen | 232 | 15 KiB |
| `kenney-nature/tent_smallClosed.glb` | tent smallClosed | 220 | 13 KiB |
| `kenney-nature/tent_smallOpen.glb` | tent smallOpen | 224 | 13 KiB |
| `kenney-nature/tree_blocks.glb` | Tree: blocks | 132 | 10 KiB |
| `kenney-nature/tree_blocks_dark.glb` | Tree: blocks dark | 132 | 10 KiB |
| `kenney-nature/tree_blocks_fall.glb` | Tree: blocks fall | 264 | 18 KiB |
| `kenney-nature/tree_cone.glb` | Tree: cone | 132 | 11 KiB |
| `kenney-nature/tree_cone_dark.glb` | Tree: cone dark | 264 | 19 KiB |
| `kenney-nature/tree_cone_fall.glb` | Tree: cone fall | 132 | 11 KiB |
| `kenney-nature/tree_default.glb` | Tree: default | 114 | 9 KiB |
| `kenney-nature/tree_default_dark.glb` | Tree: default dark | 114 | 9 KiB |
| `kenney-nature/tree_default_fall.glb` | Tree: default fall | 228 | 17 KiB |
| `kenney-nature/tree_detailed.glb` | Tree: detailed | 402 | 31 KiB |
| `kenney-nature/tree_detailed_dark.glb` | Tree: detailed dark | 402 | 31 KiB |
| `kenney-nature/tree_detailed_fall.glb` | Tree: detailed fall | 402 | 31 KiB |
| `kenney-nature/tree_fat.glb` | Tree: fat | 50 | 5 KiB |
| `kenney-nature/tree_fat_darkh.glb` | Tree: fat darkh | 50 | 5 KiB |
| `kenney-nature/tree_fat_fall.glb` | Tree: fat fall | 50 | 5 KiB |
| `kenney-nature/tree_oak.glb` | Tree: oak | 196 | 14 KiB |
| `kenney-nature/tree_oak_dark.glb` | Tree: oak dark | 196 | 14 KiB |
| `kenney-nature/tree_oak_fall.glb` | Tree: oak fall | 196 | 14 KiB |
| `kenney-nature/tree_palm.glb` | Tree: palm | 186 | 13 KiB |
| `kenney-nature/tree_palmBend.glb` | Tree: palmBend | 200 | 14 KiB |
| `kenney-nature/tree_palmDetailedShort.glb` | Tree: palmDetailedShort | 336 | 28 KiB |
| `kenney-nature/tree_palmDetailedTall.glb` | Tree: palmDetailedTall | 336 | 28 KiB |
| `kenney-nature/tree_palmShort.glb` | Tree: palmShort | 190 | 15 KiB |
| `kenney-nature/tree_palmTall.glb` | Tree: palmTall | 190 | 15 KiB |
| `kenney-nature/tree_pineDefaultA.glb` | Tree: pineDefaultA | 230 | 17 KiB |
| `kenney-nature/tree_pineDefaultB.glb` | Tree: pineDefaultB | 246 | 18 KiB |
| `kenney-nature/tree_pineGroundA.glb` | Tree: pineGroundA | 82 | 7 KiB |
| `kenney-nature/tree_pineGroundB.glb` | Tree: pineGroundB | 82 | 7 KiB |
| `kenney-nature/tree_pineRoundA.glb` | Tree: pineRoundA | 204 | 14 KiB |
| `kenney-nature/tree_pineRoundB.glb` | Tree: pineRoundB | 262 | 18 KiB |
| `kenney-nature/tree_pineRoundC.glb` | Tree: pineRoundC | 206 | 15 KiB |
| `kenney-nature/tree_pineRoundD.glb` | Tree: pineRoundD | 170 | 13 KiB |
| `kenney-nature/tree_pineRoundE.glb` | Tree: pineRoundE | 198 | 15 KiB |
| `kenney-nature/tree_pineRoundF.glb` | Tree: pineRoundF | 214 | 16 KiB |
| `kenney-nature/tree_pineSmallA.glb` | Tree: pineSmallA | 164 | 13 KiB |
| `kenney-nature/tree_pineSmallB.glb` | Tree: pineSmallB | 86 | 8 KiB |
| `kenney-nature/tree_pineSmallC.glb` | Tree: pineSmallC | 54 | 5 KiB |
| `kenney-nature/tree_pineSmallD.glb` | Tree: pineSmallD | 54 | 5 KiB |
| `kenney-nature/tree_pineTallA.glb` | Tree: pineTallA | 78 | 7 KiB |
| `kenney-nature/tree_pineTallA_detailed.glb` | Tree: pineTallA detailed | 134 | 10 KiB |
| `kenney-nature/tree_pineTallB.glb` | Tree: pineTallB | 78 | 7 KiB |
| `kenney-nature/tree_pineTallB_detailed.glb` | Tree: pineTallB detailed | 166 | 12 KiB |
| `kenney-nature/tree_pineTallC.glb` | Tree: pineTallC | 98 | 8 KiB |
| `kenney-nature/tree_pineTallC_detailed.glb` | Tree: pineTallC detailed | 154 | 11 KiB |
| `kenney-nature/tree_pineTallD.glb` | Tree: pineTallD | 98 | 8 KiB |
| `kenney-nature/tree_pineTallD_detailed.glb` | Tree: pineTallD detailed | 170 | 12 KiB |
| `kenney-nature/tree_plateau.glb` | Tree: plateau | 215 | 16 KiB |
| `kenney-nature/tree_plateau_dark.glb` | Tree: plateau dark | 215 | 16 KiB |
| `kenney-nature/tree_plateau_fall.glb` | Tree: plateau fall | 215 | 16 KiB |
| `kenney-nature/tree_simple.glb` | Tree: simple | 62 | 6 KiB |
| `kenney-nature/tree_simple_dark.glb` | Tree: simple dark | 62 | 6 KiB |
| `kenney-nature/tree_simple_fall.glb` | Tree: simple fall | 62 | 6 KiB |
| `kenney-nature/tree_small.glb` | Tree: small | 62 | 6 KiB |
| `kenney-nature/tree_small_dark.glb` | Tree: small dark | 124 | 11 KiB |
| `kenney-nature/tree_small_fall.glb` | Tree: small fall | 62 | 6 KiB |
| `kenney-nature/tree_tall.glb` | Tree: tall | 72 | 7 KiB |
| `kenney-nature/tree_tall_dark.glb` | Tree: tall dark | 72 | 7 KiB |
| `kenney-nature/tree_tall_fall.glb` | Tree: tall fall | 144 | 12 KiB |
| `kenney-nature/tree_thin.glb` | Tree: thin | 228 | 17 KiB |
| `kenney-nature/tree_thin_dark.glb` | Tree: thin dark | 456 | 32 KiB |
| `kenney-nature/tree_thin_fall.glb` | Tree: thin fall | 228 | 17 KiB |

## kenney-roads/ — Kenney City Kit (Roads)

Source: https://kenney.nl/assets/city-kit-roads · License: CC0 1.0 Universal
(95 files, 1533 KiB, 17,146 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-roads/bridge-pillar-wide.glb` | Bridge pillar (wide) | 38 | 5 KiB |
| `kenney-roads/bridge-pillar.glb` | Bridge pillar | 38 | 5 KiB |
| `kenney-roads/construction-barrier.glb` | Construction prop: barrier | 60 | 7 KiB |
| `kenney-roads/construction-cone.glb` | Construction prop: cone | 66 | 7 KiB |
| `kenney-roads/construction-fence.glb` | Construction prop: fence | 136 | 15 KiB |
| `kenney-roads/construction-light.glb` | Construction prop: light | 144 | 15 KiB |
| `kenney-roads/dumpster.glb` | Dumpster | 234 | 24 KiB |
| `kenney-roads/electricity-pole-single.glb` | Power-line prop: pole single | 176 | 19 KiB |
| `kenney-roads/electricity-pole-wide.glb` | Power-line prop: pole wide | 544 | 55 KiB |
| `kenney-roads/electricity-pole.glb` | Power-line prop: pole | 416 | 43 KiB |
| `kenney-roads/electricity-side-single.glb` | Power-line prop: side single | 176 | 19 KiB |
| `kenney-roads/electricity-side-wide.glb` | Power-line prop: side wide | 544 | 55 KiB |
| `kenney-roads/electricity-side.glb` | Power-line prop: side | 416 | 43 KiB |
| `kenney-roads/electricity-wires-wide.glb` | Power-line prop: wires wide | 200 | 22 KiB |
| `kenney-roads/electricity-wires.glb` | Power-line prop: wires | 72 | 9 KiB |
| `kenney-roads/light-curved-cross.glb` | Street lamp (curved cross) | 270 | 24 KiB |
| `kenney-roads/light-curved-double.glb` | Street lamp (curved double) | 152 | 14 KiB |
| `kenney-roads/light-curved.glb` | Street lamp (curved) | 92 | 9 KiB |
| `kenney-roads/light-square-cross.glb` | Street lamp (square cross) | 134 | 13 KiB |
| `kenney-roads/light-square-double.glb` | Street lamp (square double) | 88 | 9 KiB |
| `kenney-roads/light-square.glb` | Street lamp (square) | 60 | 7 KiB |
| `kenney-roads/road-bend-barrier.glb` | Road tile: bend barrier | 128 | 12 KiB |
| `kenney-roads/road-bend-sidewalk.glb` | Road tile: bend sidewalk | 220 | 17 KiB |
| `kenney-roads/road-bend-square-barrier.glb` | Road tile: bend square barrier | 48 | 6 KiB |
| `kenney-roads/road-bend-square.glb` | Road tile: bend square | 60 | 6 KiB |
| `kenney-roads/road-bend.glb` | Road tile: bend | 260 | 20 KiB |
| `kenney-roads/road-bridge.glb` | Road tile: bridge | 240 | 24 KiB |
| `kenney-roads/road-crossing.glb` | Road tile: crossing | 104 | 8 KiB |
| `kenney-roads/road-crossroad-barrier.glb` | Road tile: crossroad barrier | 112 | 11 KiB |
| `kenney-roads/road-crossroad-line.glb` | Road tile: crossroad line | 108 | 9 KiB |
| `kenney-roads/road-crossroad-path.glb` | Road tile: crossroad path | 276 | 18 KiB |
| `kenney-roads/road-crossroad.glb` | Road tile: crossroad | 116 | 10 KiB |
| `kenney-roads/road-curve-barrier.glb` | Road tile: curve barrier | 200 | 18 KiB |
| `kenney-roads/road-curve-intersection-barrier.glb` | Road tile: curve intersection barrier | 166 | 15 KiB |
| `kenney-roads/road-curve-intersection.glb` | Road tile: curve intersection | 298 | 22 KiB |
| `kenney-roads/road-curve-pavement.glb` | Road tile: curve pavement | 220 | 17 KiB |
| `kenney-roads/road-curve.glb` | Road tile: curve | 308 | 23 KiB |
| `kenney-roads/road-driveway-double-barrier.glb` | Road tile: driveway double barrier | 72 | 8 KiB |
| `kenney-roads/road-driveway-double.glb` | Road tile: driveway double | 72 | 7 KiB |
| `kenney-roads/road-driveway-single-barrier.glb` | Road tile: driveway single barrier | 48 | 6 KiB |
| `kenney-roads/road-driveway-single.glb` | Road tile: driveway single | 60 | 6 KiB |
| `kenney-roads/road-end-barrier.glb` | Road tile: end barrier | 28 | 4 KiB |
| `kenney-roads/road-end-round-barrier.glb` | Road tile: end round barrier | 160 | 16 KiB |
| `kenney-roads/road-end-round.glb` | Road tile: end round | 218 | 17 KiB |
| `kenney-roads/road-end.glb` | Road tile: end | 42 | 5 KiB |
| `kenney-roads/road-intersection-barrier.glb` | Road tile: intersection barrier | 68 | 7 KiB |
| `kenney-roads/road-intersection-line.glb` | Road tile: intersection line | 76 | 7 KiB |
| `kenney-roads/road-intersection-path.glb` | Road tile: intersection path | 204 | 13 KiB |
| `kenney-roads/road-intersection.glb` | Road tile: intersection | 84 | 8 KiB |
| `kenney-roads/road-roundabout-barrier.glb` | Road tile: roundabout barrier | 754 | 60 KiB |
| `kenney-roads/road-roundabout.glb` | Road tile: roundabout | 1,636 | 103 KiB |
| `kenney-roads/road-side-barrier.glb` | Road tile: side barrier | 24 | 4 KiB |
| `kenney-roads/road-side-entry-barrier.glb` | Road tile: side entry barrier | 232 | 20 KiB |
| `kenney-roads/road-side-entry.glb` | Road tile: side entry | 306 | 24 KiB |
| `kenney-roads/road-side-exit-barrier.glb` | Road tile: side exit barrier | 232 | 20 KiB |
| `kenney-roads/road-side-exit.glb` | Road tile: side exit | 306 | 24 KiB |
| `kenney-roads/road-side.glb` | Road tile: side | 44 | 5 KiB |
| `kenney-roads/road-sign-empty-hanging.glb` | Road tile: sign empty hanging | 112 | 12 KiB |
| `kenney-roads/road-sign-empty.glb` | Road tile: sign empty | 42 | 6 KiB |
| `kenney-roads/road-sign-object-stop.glb` | Road tile: sign object stop | 62 | 6 KiB |
| `kenney-roads/road-sign-object-street.glb` | Road tile: sign object street | 56 | 6 KiB |
| `kenney-roads/road-sign-object-warning.glb` | Road tile: sign object warning | 62 | 7 KiB |
| `kenney-roads/road-sign-stop.glb` | Road tile: sign stop | 104 | 10 KiB |
| `kenney-roads/road-sign-street.glb` | Road tile: sign street | 154 | 16 KiB |
| `kenney-roads/road-sign-warning.glb` | Road tile: sign warning | 104 | 11 KiB |
| `kenney-roads/road-slant-barrier.glb` | Road tile: slant barrier | 24 | 4 KiB |
| `kenney-roads/road-slant-curve-barrier.glb` | Road tile: slant curve barrier | 420 | 38 KiB |
| `kenney-roads/road-slant-curve.glb` | Road tile: slant curve | 544 | 47 KiB |
| `kenney-roads/road-slant-flat-curve.glb` | Road tile: slant flat curve | 648 | 55 KiB |
| `kenney-roads/road-slant-flat-high.glb` | Road tile: slant flat high | 44 | 5 KiB |
| `kenney-roads/road-slant-flat.glb` | Road tile: slant flat | 44 | 5 KiB |
| `kenney-roads/road-slant-high-barrier.glb` | Road tile: slant high barrier | 24 | 4 KiB |
| `kenney-roads/road-slant-high.glb` | Road tile: slant high | 44 | 5 KiB |
| `kenney-roads/road-slant.glb` | Road tile: slant | 44 | 5 KiB |
| `kenney-roads/road-split-barrier.glb` | Road tile: split barrier | 512 | 40 KiB |
| `kenney-roads/road-split.glb` | Road tile: split | 862 | 59 KiB |
| `kenney-roads/road-square-barrier.glb` | Road tile: square barrier | 32 | 4 KiB |
| `kenney-roads/road-square.glb` | Road tile: square | 36 | 4 KiB |
| `kenney-roads/road-straight-barrier-end.glb` | Road tile: straight barrier end | 16 | 4 KiB |
| `kenney-roads/road-straight-barrier-half.glb` | Road tile: straight barrier half | 24 | 4 KiB |
| `kenney-roads/road-straight-barrier.glb` | Road tile: straight barrier | 24 | 4 KiB |
| `kenney-roads/road-straight-half.glb` | Road tile: straight half | 44 | 5 KiB |
| `kenney-roads/road-straight.glb` | Road tile: straight | 44 | 5 KiB |
| `kenney-roads/sign-highway-detailed.glb` | sign highway detailed | 256 | 23 KiB |
| `kenney-roads/sign-highway-wide.glb` | sign highway wide | 144 | 14 KiB |
| `kenney-roads/sign-highway.glb` | sign highway | 180 | 17 KiB |
| `kenney-roads/tile-high.glb` | tile high | 12 | 3 KiB |
| `kenney-roads/tile-low.glb` | tile low | 12 | 3 KiB |
| `kenney-roads/tile-slant.glb` | tile slant | 12 | 3 KiB |
| `kenney-roads/tile-slantHigh.glb` | tile slantHigh | 12 | 3 KiB |
| `kenney-roads/traffic-light-hanging.glb` | traffic light hanging | 230 | 22 KiB |
| `kenney-roads/traffic-light-object-hanging.glb` | traffic light object hanging | 114 | 11 KiB |
| `kenney-roads/traffic-light-object-horizontal.glb` | traffic light object horizontal | 118 | 11 KiB |
| `kenney-roads/traffic-light-object-vertical.glb` | traffic light object vertical | 132 | 12 KiB |
| `kenney-roads/traffic-light.glb` | traffic light | 212 | 20 KiB |

## kenney-space/ — Kenney Space Kit

Source: https://kenney.nl/assets/space-kit · License: CC0 1.0 Universal
(153 files, 1968 KiB, 28,015 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-space/alien.glb` | Alien creature | 292 | 27 KiB |
| `kenney-space/astronautA.glb` | Astronaut figure A | 296 | 27 KiB |
| `kenney-space/astronautB.glb` | Astronaut figure B | 314 | 27 KiB |
| `kenney-space/barrel.glb` | Barrel | 56 | 5 KiB |
| `kenney-space/barrels.glb` | Barrels | 268 | 20 KiB |
| `kenney-space/barrels_rail.glb` | Barrel (on rail) | 428 | 30 KiB |
| `kenney-space/bones.glb` | Bones prop | 168 | 14 KiB |
| `kenney-space/chimney.glb` | Chimney | 140 | 9 KiB |
| `kenney-space/chimney_detailed.glb` | Chimney (detailed) | 332 | 19 KiB |
| `kenney-space/corridor.glb` | corridor | 84 | 7 KiB |
| `kenney-space/corridor_corner.glb` | Corridor module: corner | 110 | 8 KiB |
| `kenney-space/corridor_cornerRound.glb` | Corridor module: cornerRound | 414 | 25 KiB |
| `kenney-space/corridor_cornerRoundWindow.glb` | Corridor module: cornerRoundWindow | 484 | 30 KiB |
| `kenney-space/corridor_cross.glb` | Corridor module: cross | 172 | 12 KiB |
| `kenney-space/corridor_detailed.glb` | Corridor module: detailed | 164 | 11 KiB |
| `kenney-space/corridor_end.glb` | Corridor module: end | 120 | 9 KiB |
| `kenney-space/corridor_open.glb` | Corridor module: open | 170 | 11 KiB |
| `kenney-space/corridor_roof.glb` | Corridor module: roof | 44 | 4 KiB |
| `kenney-space/corridor_split.glb` | Corridor module: split | 128 | 10 KiB |
| `kenney-space/corridor_wall.glb` | Corridor module: wall | 36 | 4 KiB |
| `kenney-space/corridor_wallCorner.glb` | Corridor module: wallCorner | 256 | 17 KiB |
| `kenney-space/corridor_window.glb` | Corridor module: window | 190 | 13 KiB |
| `kenney-space/corridor_windowClosed.glb` | Corridor module: windowClosed | 214 | 14 KiB |
| `kenney-space/craft_cargoA.glb` | Spacecraft: cargoA | 264 | 19 KiB |
| `kenney-space/craft_cargoB.glb` | Spacecraft: cargoB | 380 | 26 KiB |
| `kenney-space/craft_miner.glb` | Spacecraft: miner | 384 | 26 KiB |
| `kenney-space/craft_racer.glb` | Spacecraft: racer | 280 | 19 KiB |
| `kenney-space/craft_speederA.glb` | Spacecraft: speederA | 280 | 20 KiB |
| `kenney-space/craft_speederB.glb` | Spacecraft: speederB | 270 | 19 KiB |
| `kenney-space/craft_speederC.glb` | Spacecraft: speederC | 292 | 20 KiB |
| `kenney-space/craft_speederD.glb` | Spacecraft: speederD | 322 | 22 KiB |
| `kenney-space/crater.glb` | Crater | 60 | 6 KiB |
| `kenney-space/craterLarge.glb` | Crater (large) | 60 | 6 KiB |
| `kenney-space/desk_chair.glb` | Desk furniture: chair | 88 | 8 KiB |
| `kenney-space/desk_chairArms.glb` | Desk furniture: chairArms | 128 | 10 KiB |
| `kenney-space/desk_chairStool.glb` | Desk furniture: chairStool | 76 | 7 KiB |
| `kenney-space/desk_computer.glb` | Desk furniture: computer | 88 | 7 KiB |
| `kenney-space/desk_computerCorner.glb` | Desk furniture: computerCorner | 126 | 9 KiB |
| `kenney-space/desk_computerScreen.glb` | Desk furniture: computerScreen | 108 | 8 KiB |
| `kenney-space/gate_complex.glb` | Gate (complex) | 460 | 29 KiB |
| `kenney-space/gate_simple.glb` | Gate (simple) | 212 | 15 KiB |
| `kenney-space/hangar_largeA.glb` | Hangar (largeA) | 412 | 25 KiB |
| `kenney-space/hangar_largeB.glb` | Hangar (largeB) | 360 | 23 KiB |
| `kenney-space/hangar_roundA.glb` | Hangar (roundA) | 166 | 12 KiB |
| `kenney-space/hangar_roundB.glb` | Hangar (roundB) | 166 | 12 KiB |
| `kenney-space/hangar_roundGlass.glb` | Hangar (roundGlass) | 113 | 10 KiB |
| `kenney-space/hangar_smallA.glb` | Hangar (smallA) | 280 | 18 KiB |
| `kenney-space/hangar_smallB.glb` | Hangar (smallB) | 284 | 19 KiB |
| `kenney-space/machine_barrel.glb` | Machine: barrel | 338 | 23 KiB |
| `kenney-space/machine_barrelLarge.glb` | Machine: barrelLarge | 192 | 14 KiB |
| `kenney-space/machine_generator.glb` | Machine: generator | 406 | 27 KiB |
| `kenney-space/machine_generatorLarge.glb` | Machine: generatorLarge | 126 | 10 KiB |
| `kenney-space/machine_wireless.glb` | Machine: wireless | 174 | 13 KiB |
| `kenney-space/machine_wirelessCable.glb` | Machine: wirelessCable | 282 | 20 KiB |
| `kenney-space/meteor.glb` | Meteor | 68 | 6 KiB |
| `kenney-space/meteor_detailed.glb` | Meteor (detailed) | 196 | 14 KiB |
| `kenney-space/meteor_half.glb` | Meteor (half) | 44 | 5 KiB |
| `kenney-space/monorail_trackCornerLarge.glb` | Monorail: trackCornerLarge | 204 | 14 KiB |
| `kenney-space/monorail_trackCornerSmall.glb` | Monorail: trackCornerSmall | 408 | 26 KiB |
| `kenney-space/monorail_trackSlope.glb` | Monorail: trackSlope | 28 | 4 KiB |
| `kenney-space/monorail_trackStraight.glb` | Monorail: trackStraight | 28 | 4 KiB |
| `kenney-space/monorail_trackSupport.glb` | Monorail: trackSupport | 176 | 12 KiB |
| `kenney-space/monorail_trackSupportCorner.glb` | Monorail: trackSupportCorner | 164 | 11 KiB |
| `kenney-space/monorail_trainBox.glb` | Monorail: trainBox | 100 | 8 KiB |
| `kenney-space/monorail_trainCargo.glb` | Monorail: trainCargo | 816 | 50 KiB |
| `kenney-space/monorail_trainEnd.glb` | Monorail: trainEnd | 190 | 13 KiB |
| `kenney-space/monorail_trainFlat.glb` | Monorail: trainFlat | 84 | 7 KiB |
| `kenney-space/monorail_trainFront.glb` | Monorail: trainFront | 242 | 17 KiB |
| `kenney-space/monorail_trainPassenger.glb` | Monorail: trainPassenger | 164 | 12 KiB |
| `kenney-space/pipe_corner.glb` | Pipe module: corner | 84 | 7 KiB |
| `kenney-space/pipe_cornerDiagonal.glb` | Pipe module: cornerDiagonal | 48 | 5 KiB |
| `kenney-space/pipe_cornerRound.glb` | Pipe module: cornerRound | 352 | 22 KiB |
| `kenney-space/pipe_cornerRoundLarge.glb` | Pipe module: cornerRoundLarge | 356 | 23 KiB |
| `kenney-space/pipe_cross.glb` | Pipe module: cross | 200 | 13 KiB |
| `kenney-space/pipe_end.glb` | Pipe module: end | 82 | 7 KiB |
| `kenney-space/pipe_entrance.glb` | Pipe module: entrance | 126 | 9 KiB |
| `kenney-space/pipe_open.glb` | Pipe module: open | 104 | 7 KiB |
| `kenney-space/pipe_rampLarge.glb` | Pipe module: rampLarge | 160 | 11 KiB |
| `kenney-space/pipe_rampSmall.glb` | Pipe module: rampSmall | 160 | 11 KiB |
| `kenney-space/pipe_ring.glb` | Pipe module: ring | 144 | 10 KiB |
| `kenney-space/pipe_ringHigh.glb` | Pipe module: ringHigh | 190 | 14 KiB |
| `kenney-space/pipe_ringHighEnd.glb` | Pipe module: ringHighEnd | 186 | 14 KiB |
| `kenney-space/pipe_ringSupport.glb` | Pipe module: ringSupport | 104 | 8 KiB |
| `kenney-space/pipe_split.glb` | Pipe module: split | 142 | 10 KiB |
| `kenney-space/pipe_straight.glb` | Pipe module: straight | 80 | 6 KiB |
| `kenney-space/pipe_supportHigh.glb` | Pipe module: supportHigh | 40 | 5 KiB |
| `kenney-space/pipe_supportLow.glb` | Pipe module: supportLow | 40 | 5 KiB |
| `kenney-space/platform_center.glb` | Platform module: center | 4 | 2 KiB |
| `kenney-space/platform_corner.glb` | Platform module: corner | 84 | 7 KiB |
| `kenney-space/platform_cornerOpen.glb` | Platform module: cornerOpen | 50 | 5 KiB |
| `kenney-space/platform_cornerRound.glb` | Platform module: cornerRound | 356 | 19 KiB |
| `kenney-space/platform_end.glb` | Platform module: end | 64 | 6 KiB |
| `kenney-space/platform_high.glb` | Platform module: high | 236 | 16 KiB |
| `kenney-space/platform_large.glb` | Platform module: large | 76 | 6 KiB |
| `kenney-space/platform_long.glb` | Platform module: long | 76 | 6 KiB |
| `kenney-space/platform_low.glb` | Platform module: low | 156 | 11 KiB |
| `kenney-space/platform_side.glb` | Platform module: side | 30 | 5 KiB |
| `kenney-space/platform_small.glb` | Platform module: small | 76 | 6 KiB |
| `kenney-space/platform_smallDiagonal.glb` | Platform module: smallDiagonal | 72 | 6 KiB |
| `kenney-space/platform_straight.glb` | Platform module: straight | 56 | 6 KiB |
| `kenney-space/rail.glb` | Rail track: rail | 76 | 6 KiB |
| `kenney-space/rail_corner.glb` | Rail track: rail corner | 130 | 10 KiB |
| `kenney-space/rail_end.glb` | Rail track: rail end | 46 | 5 KiB |
| `kenney-space/rail_middle.glb` | Rail track: rail middle | 46 | 5 KiB |
| `kenney-space/rock.glb` | Rock: rock | 172 | 13 KiB |
| `kenney-space/rock_crystals.glb` | Rock: rock crystals | 364 | 25 KiB |
| `kenney-space/rock_crystalsLargeA.glb` | Rock: rock crystalsLargeA | 384 | 26 KiB |
| `kenney-space/rock_crystalsLargeB.glb` | Rock: rock crystalsLargeB | 380 | 25 KiB |
| `kenney-space/rock_largeA.glb` | Rock: rock largeA | 176 | 13 KiB |
| `kenney-space/rock_largeB.glb` | Rock: rock largeB | 172 | 13 KiB |
| `kenney-space/rocket_baseA.glb` | Rocket part: baseA | 300 | 21 KiB |
| `kenney-space/rocket_baseB.glb` | Rocket part: baseB | 284 | 20 KiB |
| `kenney-space/rocket_finsA.glb` | Rocket part: finsA | 192 | 13 KiB |
| `kenney-space/rocket_finsB.glb` | Rocket part: finsB | 249 | 16 KiB |
| `kenney-space/rocket_fuelA.glb` | Rocket part: fuelA | 94 | 7 KiB |
| `kenney-space/rocket_fuelB.glb` | Rocket part: fuelB | 130 | 8 KiB |
| `kenney-space/rocket_sidesA.glb` | Rocket part: sidesA | 222 | 14 KiB |
| `kenney-space/rocket_sidesB.glb` | Rocket part: sidesB | 206 | 13 KiB |
| `kenney-space/rocket_topA.glb` | Rocket part: topA | 50 | 6 KiB |
| `kenney-space/rocket_topB.glb` | Rocket part: topB | 82 | 8 KiB |
| `kenney-space/rocks_smallA.glb` | Rock: rocks smallA | 60 | 6 KiB |
| `kenney-space/rocks_smallB.glb` | Rock: rocks smallB | 48 | 5 KiB |
| `kenney-space/rover.glb` | Rover vehicle | 172 | 13 KiB |
| `kenney-space/satelliteDish.glb` | Satellite / radar dish | 274 | 19 KiB |
| `kenney-space/satelliteDish_detailed.glb` | Satellite / radar dish (detailed) | 390 | 25 KiB |
| `kenney-space/satelliteDish_large.glb` | Satellite / radar dish (large) | 186 | 14 KiB |
| `kenney-space/stairs.glb` | Stairs | 208 | 14 KiB |
| `kenney-space/stairs_corner.glb` | Stairs (corner) | 306 | 19 KiB |
| `kenney-space/stairs_short.glb` | Stairs (short) | 136 | 10 KiB |
| `kenney-space/structure.glb` | Structure module: structure | 168 | 11 KiB |
| `kenney-space/structure_closed.glb` | Structure module: structure closed | 264 | 15 KiB |
| `kenney-space/structure_detailed.glb` | Structure module: structure detailed | 232 | 14 KiB |
| `kenney-space/structure_diagonal.glb` | Structure module: structure diagonal | 344 | 19 KiB |
| `kenney-space/supports_high.glb` | Support structure (high) | 312 | 20 KiB |
| `kenney-space/supports_low.glb` | Support structure (low) | 184 | 14 KiB |
| `kenney-space/terrain.glb` | terrain | 2 | 2 KiB |
| `kenney-space/terrain_ramp.glb` | Terrain module: ramp | 4 | 2 KiB |
| `kenney-space/terrain_rampLarge.glb` | Terrain module: rampLarge | 4 | 2 KiB |
| `kenney-space/terrain_rampLarge_detailed.glb` | Terrain module: rampLarge detailed | 12 | 3 KiB |
| `kenney-space/terrain_roadCorner.glb` | Terrain module: roadCorner | 98 | 5 KiB |
| `kenney-space/terrain_roadCross.glb` | Terrain module: roadCross | 50 | 4 KiB |
| `kenney-space/terrain_roadEnd.glb` | Terrain module: roadEnd | 58 | 4 KiB |
| `kenney-space/terrain_roadSplit.glb` | Terrain module: roadSplit | 162 | 7 KiB |
| `kenney-space/terrain_roadStraight.glb` | Terrain module: roadStraight | 10 | 2 KiB |
| `kenney-space/terrain_side.glb` | Terrain module: side | 2 | 2 KiB |
| `kenney-space/terrain_sideCliff.glb` | Terrain module: sideCliff | 12 | 3 KiB |
| `kenney-space/terrain_sideCorner.glb` | Terrain module: sideCorner | 12 | 3 KiB |
| `kenney-space/terrain_sideCornerInner.glb` | Terrain module: sideCornerInner | 10 | 2 KiB |
| `kenney-space/terrain_sideEnd.glb` | Terrain module: sideEnd | 9 | 3 KiB |
| `kenney-space/turret_double.glb` | Defense turret (double) | 876 | 49 KiB |
| `kenney-space/turret_single.glb` | Defense turret (single) | 576 | 38 KiB |
| `kenney-space/weapon_gun.glb` | Weapon prop: gun | 70 | 7 KiB |
| `kenney-space/weapon_rifle.glb` | Weapon prop: rifle | 106 | 9 KiB |

## kenney-suburban/ — Kenney City Kit (Suburban)

Source: https://kenney.nl/assets/city-kit-suburban · License: CC0 1.0 Universal
(40 files, 2549 KiB, 30,035 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-suburban/building-type-a.glb` | Suburban house, type A | 1,174 | 96 KiB |
| `kenney-suburban/building-type-b.glb` | Suburban house, type B | 1,748 | 143 KiB |
| `kenney-suburban/building-type-c.glb` | Suburban house, type C | 1,196 | 97 KiB |
| `kenney-suburban/building-type-d.glb` | Suburban house, type D | 1,757 | 144 KiB |
| `kenney-suburban/building-type-e.glb` | Suburban house, type E | 1,731 | 142 KiB |
| `kenney-suburban/building-type-f.glb` | Suburban house, type F | 1,616 | 135 KiB |
| `kenney-suburban/building-type-g.glb` | Suburban house, type G | 1,067 | 91 KiB |
| `kenney-suburban/building-type-h.glb` | Suburban house, type H | 770 | 64 KiB |
| `kenney-suburban/building-type-i.glb` | Suburban house, type I | 800 | 68 KiB |
| `kenney-suburban/building-type-j.glb` | Suburban house, type J | 1,210 | 97 KiB |
| `kenney-suburban/building-type-k.glb` | Suburban house, type K | 1,024 | 87 KiB |
| `kenney-suburban/building-type-l.glb` | Suburban house, type L | 1,310 | 107 KiB |
| `kenney-suburban/building-type-m.glb` | Suburban house, type M | 1,112 | 95 KiB |
| `kenney-suburban/building-type-n.glb` | Suburban house, type N | 1,612 | 136 KiB |
| `kenney-suburban/building-type-o.glb` | Suburban house, type O | 1,326 | 112 KiB |
| `kenney-suburban/building-type-p.glb` | Suburban house, type P | 1,282 | 107 KiB |
| `kenney-suburban/building-type-q.glb` | Suburban house, type Q | 1,140 | 96 KiB |
| `kenney-suburban/building-type-r.glb` | Suburban house, type R | 1,030 | 86 KiB |
| `kenney-suburban/building-type-s.glb` | Suburban house, type S | 1,212 | 101 KiB |
| `kenney-suburban/building-type-t.glb` | Suburban house, type T | 2,062 | 164 KiB |
| `kenney-suburban/building-type-u.glb` | Suburban house, type U | 1,332 | 115 KiB |
| `kenney-suburban/driveway-long.glb` | Driveway (long) | 12 | 3 KiB |
| `kenney-suburban/driveway-short.glb` | Driveway (short) | 12 | 3 KiB |
| `kenney-suburban/fence-1x2.glb` | Garden fence (1x2) | 156 | 16 KiB |
| `kenney-suburban/fence-1x3.glb` | Garden fence (1x3) | 204 | 21 KiB |
| `kenney-suburban/fence-1x4.glb` | Garden fence (1x4) | 252 | 25 KiB |
| `kenney-suburban/fence-2x2.glb` | Garden fence (2x2) | 236 | 23 KiB |
| `kenney-suburban/fence-2x3.glb` | Garden fence (2x3) | 284 | 28 KiB |
| `kenney-suburban/fence-3x2.glb` | Garden fence (3x2) | 316 | 31 KiB |
| `kenney-suburban/fence-3x3.glb` | Garden fence (3x3) | 364 | 35 KiB |
| `kenney-suburban/fence-low.glb` | Garden fence (low) | 180 | 18 KiB |
| `kenney-suburban/fence.glb` | Garden fence () | 88 | 9 KiB |
| `kenney-suburban/path-long.glb` | Garden path (long) | 12 | 3 KiB |
| `kenney-suburban/path-short.glb` | Garden path (short) | 12 | 3 KiB |
| `kenney-suburban/path-stones-long.glb` | Garden path (stones long) | 48 | 7 KiB |
| `kenney-suburban/path-stones-messy.glb` | Garden path (stones messy) | 36 | 5 KiB |
| `kenney-suburban/path-stones-short.glb` | Garden path (stones short) | 24 | 4 KiB |
| `kenney-suburban/planter.glb` | Planter box | 204 | 20 KiB |
| `kenney-suburban/tree-large.glb` | Garden tree (large) | 42 | 6 KiB |
| `kenney-suburban/tree-small.glb` | Garden tree (small) | 42 | 6 KiB |

## kenney-watercraft/ — Kenney Watercraft Kit

Source: https://kenney.nl/assets/watercraft-kit · License: CC0 1.0 Universal
(46 files, 1902 KiB, 21,534 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `kenney-watercraft/arrow-standing.glb` | Direction arrow marker (standing) | 40 | 5 KiB |
| `kenney-watercraft/arrow.glb` | Direction arrow marker | 62 | 7 KiB |
| `kenney-watercraft/boat-fan.glb` | Boat fan (small boat) | 310 | 30 KiB |
| `kenney-watercraft/boat-fishing-small.glb` | Boat fishing small (small boat) | 237 | 22 KiB |
| `kenney-watercraft/boat-house-a.glb` | Houseboat A | 408 | 38 KiB |
| `kenney-watercraft/boat-house-b.glb` | Houseboat B | 380 | 35 KiB |
| `kenney-watercraft/boat-house-c.glb` | Houseboat C | 452 | 40 KiB |
| `kenney-watercraft/boat-house-d.glb` | Houseboat D | 550 | 48 KiB |
| `kenney-watercraft/boat-row-large.glb` | Rowboat (large) | 174 | 16 KiB |
| `kenney-watercraft/boat-row-small.glb` | Rowboat (small) | 168 | 17 KiB |
| `kenney-watercraft/boat-sail-a.glb` | Sailboat A | 386 | 34 KiB |
| `kenney-watercraft/boat-sail-b.glb` | Sailboat B | 426 | 37 KiB |
| `kenney-watercraft/boat-speed-a.glb` | Speedboat A | 156 | 16 KiB |
| `kenney-watercraft/boat-speed-b.glb` | Speedboat B | 148 | 15 KiB |
| `kenney-watercraft/boat-speed-c.glb` | Speedboat C | 154 | 16 KiB |
| `kenney-watercraft/boat-speed-d.glb` | Speedboat D | 250 | 23 KiB |
| `kenney-watercraft/boat-speed-e.glb` | Speedboat E | 265 | 25 KiB |
| `kenney-watercraft/boat-speed-f.glb` | Speedboat F | 234 | 22 KiB |
| `kenney-watercraft/boat-speed-g.glb` | Speedboat G | 136 | 14 KiB |
| `kenney-watercraft/boat-speed-h.glb` | Speedboat H | 180 | 19 KiB |
| `kenney-watercraft/boat-speed-i.glb` | Speedboat I | 136 | 15 KiB |
| `kenney-watercraft/boat-speed-j.glb` | Speedboat J | 178 | 20 KiB |
| `kenney-watercraft/boat-tow-a.glb` | Tow boat A | 576 | 50 KiB |
| `kenney-watercraft/boat-tow-b.glb` | Tow boat B | 588 | 50 KiB |
| `kenney-watercraft/boat-tug-a.glb` | Tugboat A | 471 | 40 KiB |
| `kenney-watercraft/boat-tug-b.glb` | Tugboat B | 371 | 33 KiB |
| `kenney-watercraft/boat-tug-c.glb` | Tugboat C | 197 | 18 KiB |
| `kenney-watercraft/buoy-flag.glb` | Buoy (with flag) | 218 | 21 KiB |
| `kenney-watercraft/buoy.glb` | Buoy | 118 | 12 KiB |
| `kenney-watercraft/cargo-container-a.glb` | Cargo container A | 160 | 16 KiB |
| `kenney-watercraft/cargo-container-b.glb` | Cargo container B | 160 | 16 KiB |
| `kenney-watercraft/cargo-container-c.glb` | Cargo container C | 160 | 16 KiB |
| `kenney-watercraft/cargo-pile-a.glb` | Cargo pile A | 176 | 18 KiB |
| `kenney-watercraft/cargo-pile-b.glb` | Cargo pile B | 352 | 34 KiB |
| `kenney-watercraft/gate-finish.glb` | Regatta gate (finish) | 104 | 9 KiB |
| `kenney-watercraft/gate.glb` | Regatta gate | 104 | 10 KiB |
| `kenney-watercraft/ramp-wide.glb` | Boat ramp (wide) | 128 | 14 KiB |
| `kenney-watercraft/ramp.glb` | Boat ramp | 128 | 14 KiB |
| `kenney-watercraft/ship-cargo-a.glb` | Cargo ship A | 1,060 | 96 KiB |
| `kenney-watercraft/ship-cargo-b.glb` | Cargo ship B | 850 | 78 KiB |
| `kenney-watercraft/ship-cargo-c.glb` | Cargo ship C | 362 | 31 KiB |
| `kenney-watercraft/ship-large.glb` | Large ship | 1,849 | 152 KiB |
| `kenney-watercraft/ship-ocean-liner-small.glb` | Ocean liner (small) | 1,750 | 142 KiB |
| `kenney-watercraft/ship-ocean-liner.glb` | Ocean liner | 2,796 | 223 KiB |
| `kenney-watercraft/ship-small-ghost.glb` | Small ship (ghost/abandoned variant) | 1,703 | 152 KiB |
| `kenney-watercraft/ship-small.glb` | Small ship | 1,723 | 142 KiB |

## quaternius/ — Quaternius (Animated Tanks / Men / Farm Buildings packs)

Source: https://quaternius.com/ · License: CC0 1.0 Universal
(8 files, 1865 KiB, 40,847 tris)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `quaternius/engineer.glb` | Human male, work shirt — engineer infantry | 1,844 | 113 KiB |
| `quaternius/farm-barn.glb` | Big barn (farm building) | 4,220 | 183 KiB |
| `quaternius/farm-silo.glb` | Silo (farm building) | 1,592 | 68 KiB |
| `quaternius/rifleman.glb` | Human male, long sleeves — rifleman infantry | 1,961 | 115 KiB |
| `quaternius/tank-1.glb` | Battle tank, variant 1 (animated-tank pack) | 6,064 | 267 KiB |
| `quaternius/tank-2.glb` | Battle tank, variant 2 — in-game MBT | 7,220 | 320 KiB |
| `quaternius/tank-3.glb` | Battle tank, variant 3 | 6,544 | 293 KiB |
| `quaternius/tank-4.glb` | Battle tank, variant 4 (largest) | 11,402 | 506 KiB |

## styloo-planes/ — styloo "Tiny Plane Asset Pack"

Source: https://styloo.itch.io/plane · License: CC0 1.0 Universal
(15 files, 6454 KiB, 237,992 tris — converted 2026-09-30 FBX → GLB with
Blender 4.2.17 headless; see `styloo-planes/CONVERSION.md`. CC0 is stated
in the itch.io page's asset-license metadata; the zip ships no license
file. The GLBs embed the pack's `ImphenziaPalette01-256-Gradient.png`
palette texture — part of the same CC0 pack.)

| File | Depicts | Tris | Size |
|---|---|---|---|
| `styloo-planes/planehuge.glb` | Large swept-wing airliner | 20,916 | 771 KiB |
| `styloo-planes/planesty.glb` | Small stylized prop plane, livery 1 | 16,108 | 408 KiB |
| `styloo-planes/planesty_001.glb` | Small stylized prop plane, livery 2 | 18,472 | 464 KiB |
| `styloo-planes/planesty_002.glb` | Small stylized prop plane, livery 3 | 16,108 | 415 KiB |
| `styloo-planes/planesty_003.glb` | Small stylized prop plane, livery 4 | 16,108 | 416 KiB |
| `styloo-planes/planeazer.glb` | Red high-wing prop plane, livery 1 | 17,580 | 457 KiB |
| `styloo-planes/planeazer_001.glb` | Red high-wing prop plane, livery 2 | 17,580 | 454 KiB |
| `styloo-planes/planeazer_002.glb` | Red high-wing prop plane, livery 3 | 17,580 | 458 KiB |
| `styloo-planes/plancestylized.glb` | WWII-fighter-style prop plane, livery 1 | 16,704 | 461 KiB |
| `styloo-planes/plancestylized_001.glb` | WWII-fighter-style prop plane, livery 2 (spare, unmapped) | 16,704 | 461 KiB |
| `styloo-planes/planeanimal.glb` | Dark-gray stealth flying wing, livery 1 | 6,716 | 158 KiB |
| `styloo-planes/planeanimal_001.glb` | Dark-gray stealth flying wing, livery 2 | 9,696 | 229 KiB |
| `styloo-planes/planehelice.glb` | Stylized helicopter (spare, unmapped) | 13,904 | 352 KiB |
| `styloo-planes/planehelice_001.glb` | Stylized helicopter, variant (spare, unmapped) | 17,232 | 432 KiB |
| `styloo-planes/planestylized_001.glb` | Spare prop-plane livery (unmapped — filename as shipped) | 16,704 | 461 KiB |

## quaternius-nature/textures/ — Quaternius "Textured LowPoly Trees" textures (manually added 2026-09-30, not part of the generated GLB inventory above)

Source: https://opengameart.org/content/lowpoly-textured-trees · License: CC0 1.0 Universal
(5 files, ~0.83 MiB — textures for the procedural nature-scatter trees, `game/src/render/natureTrees.ts`;
license evidence: `quaternius-nature/LICENSE-CC0.txt`, THIRD_PARTY_NOTICES.md)

| File | Depicts | Size |
|---|---|---|
| `quaternius-nature/textures/tree_bark.jpg` | Hand-painted bark, vertical fissures (oak/pine trunks) | 241 KiB |
| `quaternius-nature/textures/birch_bark.png` | White birch bark with lenticels | 207 KiB |
| `quaternius-nature/textures/tree_leaves.png` | Leaf-cluster sprite, alpha (broadleaf canopies) | 129 KiB |
| `quaternius-nature/textures/birch_leaves_green.png` | Leaf-cluster sprite, alpha (birch canopy) | 126 KiB |
| `quaternius-nature/textures/pine_leaves.png` | Needle frond, alpha (conifer tiers) | 125 KiB |
