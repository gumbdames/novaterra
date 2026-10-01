<!---
NOVATERRA — Copyright (C) 2026 Gumb Dames
SPDX-License-Identifier: AGPL-3.0-or-later
-->

# Sea logistics — Half B: military naval logistics

Workstream: military naval supply (fuelTanker / ammoShip). Half A (civilian
harbors / trade routes) is the parallel worker's scope and lives in
`docs/research/sea-logistics.md` if they created it — this file is the
Half-B record only. Do not create `commercialHarbor` or sea-route commands
here.

## 1. Audit (2026-10-01, before any changes)

### 1.1 The roster, as shipped

| Kind | Domain | Cargo def | `tankerRefuelRadius` | Can load? | Can unload? |
|---|---|---|---|---|---|
| `fuelTanker` (sea, military, industry, no production gate) | sea | `cargoFuelCapacity: 400` | — (absent) | **No** | **No** |
| `ammoShip` (sea, military, industry, needs `shipyard`) | sea | `cargoAmmoCapacity: 80` | — (absent) | **No** | **No** |
| `transportShipMk3` "Depot Ship" (sea, CIVILIAN, ascendance) | sea | 200 fuel / 60 ammo | — (absent) | **No** | **No** |
| `tanker` (air, military) | air | `cargoFuelCapacity: 200` | 40 | Yes (fuel only) | Yes (fuel → air units) |
| `supplyTruck` (land) | land | 100 fuel / 40 ammo | — | **No** | **No** |
| `fuelTruck` (land) | land | 220 fuel | — | **No** | **No** |
| `hauler` (land) | land | 40 fuel / 20 ammo | — | **No** | **No** |

Holds spawn EMPTY (`spawnUnit`, units.ts) under the resupply-workstream rule
"cargo is loaded at depots, never conjured" — but the loading path exists
for exactly one unit in the whole roster.

### 1.2 Load: the single gated leg

The ONLY cargo-load code in the sim is `serveDepotUnit` (economy.ts ~896),
inside the depot refill aura:

```ts
if ((def.tankerRefuelRadius ?? 0) > 0) {
  // load cargoFuel from d.fuelStock ...
}
```

Only the air `tanker` carries `tankerRefuelRadius`, so only it ever loads.
The sea `fuelTanker`'s 400-fuel hold is dead weight: it can never fill.

There is NO cargo-ammo load leg anywhere in the sim — `cargoAmmo` is written
only by `spawnUnit` (0) and never again. The `ammoShip`'s 80-shell hold, the
`supplyTruck`'s 40, the `hauler`'s 20, and the depot ship's 60 are all
unfillable by any mechanism.

There is NO materials cargo at all: no `cargoMaterialsCapacity` on the def,
no `cargoMaterials` on `UnitRecord`.

### 1.3 Unload: air-only, fuel-only

`runTankerRefuel` (economy.ts ~927) is the only cargo-discharge pass:

- Suppliers = units with `tankerRefuelRadius > 0` (the air tanker only).
- Recipients = `def.domain === 'air'` hard filter — sea units are excluded
  by construction.
- Fuel only. No ammo-discharge pass exists.

So a sea fuelTanker can neither give nor receive through any aura.

### 1.4 The `resupply` command and sea units

`resupply` (commands.ts) DOES work for sea domain: it reserves depot stock
for the unit's OWN tank/magazine and routes the unit to the depot's
footprint center, requiring the center to be on water for sea units. It
never touches cargo holds. Sea-going reload points: `navalYard`
(`reloadPoint`, but zero stocks — no `fuelStorage`/`ammoStorage`, no
production) and `navalBase` (`reloadPoint`, `fuelStorage: 300`,
`ammoStorage: 100`).

### 1.5 The navalBase's stocks are unfillable today

- Fuel: `runProduction`'s forward-cache pull keys on `b.kind === 'fuelDepot'`
  ONLY (economy.ts ~653). `navalBase` / `commercialPort` / `fuelFarm` /
  `railStation` / `busDepot` all carry `fuelStorage` with def comments saying
  the supply-truck chain stocks them — that chain ("Supply trucks shuttle
  producer→depot in a later workstream", city.ts ~1880) never landed.
- Ammo: `ammoStock` fills only via `ammoProduction` (munitionsFactory 2/s,
  missilePlant 5/s). `missileSilo` (400), `ordnanceDepot` (150), `navalBase`
  (100) have storage but no production and no inbound path.

Net: the navalBase is a reload point with permanently empty shelves.

### 1.6 `setSupplyToggles`: validated, displayed, never consumed

`setSupplyToggles` accepts ANY unit whose def has cargo capacity — sea
tankers included — and the selection panel already renders the three
toggles for them (`isSupplyUnit` is def-driven). But NO sim system reads
`supplyServices`: the repair/rearm/refuel toggles are currently decorative.
(The AI sets them on land trucks; nothing acts on them.)

### 1.7 AI usage: zero

`ai.ts` contains no reference to `fuelTanker` or `ammoShip` — the AI never
trains, loads, or uses them. (In practice only Marshal could: it alone
builds `shipyard`/`navalYard` virtually and advances to the industry age
both units are gated on.)

### 1.8 UI state

- The selection panel already shows `cargoLine` ("Cargo: X fuel · Y ammo")
  and the service toggles for any supply unit, sea tankers included — but
  the line always reads 0 because the holds can never fill.
- There are no load/unload order buttons (no such commands exist).

### 1.9 Snapshot / digest

`cargoFuel` / `cargoAmmo` are snapshotted (`?? 0`, AD9, stays v8) and
digested. No materials fields exist anywhere.

### 1.10 What the docs already promise

`docs/GAME_MECHANICS.md` describes the Fuel Tanker as "a floating fuel depot
for the Phase 3 naval logistics chain" and the Ammo Ship as "a floating
munitions store" — the mechanics were never implemented. Half B makes the
docs true.

## 2. Design (as implemented)

### 2.1 Def changes (units.ts)

- `UnitDef.cargoMaterialsCapacity?: number` — new hold type (docs §3.2
  roster: fuel / ammo / materials).
- `UnitRecord.cargoMaterials: number` — spawn 0, AD9 `?? 0` (no snapshot
  bump, stays v8 — the cargoFuel/cargoAmmo precedent).
- `fuelTanker`: `tankerRefuelRadius: 30` (sea supply radius), 
...[truncated 10442 chars]