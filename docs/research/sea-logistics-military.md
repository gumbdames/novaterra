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
> NOTE (2026-10-01, naval-building model): §2 above was left unfinished
> mid-sentence when the naval-split workstream (see the naval-building
> model: civilian shipyards build/repair civilian ships, civilian docks
> handle shipping; military shipyards build/repair military ships,
> military docks/bases handle shipping) took over this file's subject
> matter. §2.1's def changes all landed as described; what follows (§3)
> is the audit + the split-era rules, which supersede any §2 draft text
> where they overlap.

## 3. Naval-building model audit + rules (2026-10-01)

### 3.1 The exact load/unload rule

`computeCargoTransfer` (`game/src/sim/commands.ts`, shared by the
`loadCargo` / `unloadCargo` commands) admits a transfer iff ALL hold:

1. The unit's def has cargo capacity (a supply unit).
2. The building's def has `reloadPoint: true` (data-driven — the code
   names no kinds).
3. **Same side**: `!!unitDef.military === !!buildingDef.military`
   (the civilian/military split — see §3.2).
4. The building's footprint center is on water (the naval gate — this is
   what makes both commands sea-only; land trucks can never use them).
5. The unit is inside `LOGISTICS_RADIUS` of the building.
6. Something actually transfers (partial transfers are fine; the
   rejection is loud only when nothing can move).

Rejections are loud, in this order: not-a-supply-unit → not a naval
supply point → **side mismatch** → not on water → out of range →
nothing to transfer. Peaceful worlds reject like `attackBuilding`.

The depot aura (`serveDepotUnit`, `game/src/sim/economy.ts`) mirrors the
rule for its cargo-loading legs: **sea** units load cargo holds only at
same-side depots (silent skip on mismatch — the aura never errors).
Land and air depots keep the legacy side-blind behavior (Phase 3
predates the split; civilian haulers load at military fuelDepots by
design). The aura's own-tank/own-magazine refill legs are intentionally
side-blind too — a ship refueling its own engines at any friendly port
is the standing "friendly port" abstraction, not cargo logistics.
Ship-to-ship discharge (`runMobileSupply`) is likewise side-blind
within one owner: underway replenishment at sea is not dock shipping.

### 3.2 The hole the audit found (and closed)

Before the split, the military `fuelTanker`/`ammoShip` could
`loadCargo`/`unloadCargo` at the civilian `commercialPort` and
`commercialHarbor` (both `reloadPoint: true`, water-centered, with fuel
stocks) — and civilian `fuelBarge`/`cargoFreighter` hulls could draw
military stocks the same way, through both the commands and the aura's
cargo legs. The side-match gate (§3.1, rule 3) closes it in both paths.
`game/tests/sim.sea-logistics-military.test.ts` pins the rejection both
directions, the aura's no-cross-loading both directions, and that
same-side civilian transfers still work.

### 3.3 Load-point roster (data, 2026-10-01)

- Military: `navalYard` (reloadPoint, production + logistics combined),
  `navalBase` (reloadPoint, the docks — pure logistics).
- Civilian: `commercialHarbor` (reloadPoint — the civilian shipyard keeps
  its load point for now), `commercialPort` (reloadPoint — the civilian
  docks).
- NOT load points: the military `shipyard` (dry — see §3.5),
  `containerPort`, `fishingHarbor` (no `reloadPoint`).

### 3.4 What each military building does (no-blur rule)

- `shipyard` — "Naval Shipyard" (renamed from "Shipyard"; key
  unchanged, old saves load). Builds AND repairs military
  light/support craft (missile boats, corvettes, ammo ships, repair
  ships, minelayers). Dry: no stocks, not a cargo point.
- `navalYard` — "Naval Yard". Builds AND repairs the heavy combatants
  (destroyers, frigates, submarines, carriers). Also a cargo load point
  (the military mirror of the civilian harbor's old combined role).
- `navalBase` — "Naval Base". The military shipping interface: the
  docks where transports load/unload fuel, ammo, and materials for
  forward operations. Builds nothing, repairs nothing.

Repair itself is `game/src/sim/shipyardRepair.ts` (final, untouched by
this workstream): damaged sea units inside a same-side production
shipyard's radius regain 3 hp/s. The unit detail panel shows the
"Under repair" badge exactly when `isShipUnderRepair` says so
(`game/src/ui/hud.ts`), covered by the always-emitted `ur:` digest
segment (`game/src/ui/paletteDigest.ts`, registered in
`HUD_PANEL_BRANCHES`).

### 3.5 Judgment call: the shipyard stays dry

The audit considered giving the `shipyard` a `reloadPoint` (it sits on
the coast; a player might expect to load there). Decision: NO.

- `navalYard` already plays the combined production+logistics role, so
  no capability is missing — the light/heavy distinction the rename
  sharpens would erode if the light yard also loaded cargo.
- The recorded deliberate decision (commands.ts, citing this doc's
  earlier §3.5-era note) was that the shipyard is a dry production
  building with no stocks; reversing it would be new behavior, not a
  bug fix.
- The documented primary forward interface is the `navalBase`.

### 3.6 AI wiring (marshal)

`thinkNavalSupply` (`game/src/sim/ai.ts`, marshal-only, coastal-only):

- The navalBase joined the marshal's `CONSTRUCTION_PRIORITY` right
  after the navalYard (coastal-gated like the yards — the docks follow
  the yards that build the fleet). The `thinkVirtualDepot` call in
  `thinkNavalSupply` is the top-up for thinks where the slot is free
  (the land-depot pattern from `thinkLogistics`).
- A completed virtual navalBase credits `VIRTUAL_FUEL_PER_THINK` /
  `VIRTUAL_AMMO_PER_THINK` each think — the forward-base flavor: the
  fleet's cache is filled at the docks. The land abstract-resupply
  draws first each think (documented order); the tail fills from the
  remainder, then `runMobileSupply` discharges for real at sea.
- All deterministic, no RNG, through the standard virtual-construction
  path. Verified safe: `hasProductionBuilding`'s virtual path checks
  the exact kind only (no `countsAs`), so the navalBase unlocks no
  production gate.

Soak test (`sim.sea-logistics-military.test.ts`): a mature marshal
(priority queue worked down to the navalBase, construction just
finishing) → base completes → credit lands → a fuelTanker is trained
and its hold fills from the credit → with the AI frozen, the tanker
discharges into a fuel-starved patrol boat via `runMobileSupply`
(the freeze isolates the discharge leg from the abstract resupply).
