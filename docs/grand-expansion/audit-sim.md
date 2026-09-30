# Simulation architecture audit — grand-expansion grounding

Version: 0.1 Alpha. Audit date: 2026-09-30. `main` branch.

This document maps each planned expansion system onto the current sim.
"Hooks" names the exact functions/types to touch. "Changes" lists what
breaks or must be extended. "Determinism pitfalls" calls out the
contract risks (see `game/src/sim/AGENTS.md` § Determinism contract).
Complexity: S (days) / M (a week) / L (several weeks) / XL (a month+).

New systems covered:

1. [Utility networks](#1-utility-networks) (power lines/pipes,
   zone-level servicing, multiple plant types across tech levels)
2. [Logistics](#2-logistics) (fuel + missile supply chains; nuclear
   exemption)
3. [Unit veterancy](#3-unit-veterancy)
4. [New units/buildings across tech levels](#4-new-unitsbuildings-across-tech-levels)
5. [Hangar-gated aircraft production](#5-hangar-gated-aircraft-production)
6. [Carriers with assigned air wings](#6-carriers-with-assigned-air-wings)
7. [Airport/port types](#7-airportport-types) (civilian / military / mixed)
8. [Intel, spies, recon](#8-intel-spies-recon)
9. [Transport variety](#9-transport-variety) (road classes, rail,
   trams/buses/ferries, marinas)
10. [Airport zones](#10-airport-zones)
11. [Peaceful no-military mode](#11-peaceful-no-military-mode)
12. [Snapshot/digest migration strategy](#12-snapshotdigest-migration-strategy)
13. [Top 5 architectural risks](#13-top-5-architectural-risks)

---

## 1. Utility networks

Today's model is a **global capacity pool** per player, computed in
`economy.ts` → `allocateUtilities(world, city)`: every completed, funded
plant/pump contributes `powerSupply`/`waterSupply` (`BuildingDef` in
`city.ts`), demanders are served in **building-id order**, and missing
service only penalizes output (`UTILITY_PENALTY = 0.25`, applied in
`runProduction`). Plants supply *without* any connection (user directive
2026-09-30 removed the road requirement entirely; `isRoadAdjacent` was
deleted). The expansion wants per-plant→zone connectivity (power lines,
pipes), multiple plant kinds across tech levels, and zone-level
servicing instead of a global pool.

### Hooks

- `city.ts`: `BuildingDef` (supply/demand fields), `validatePlacement`,
  `BuildingRecord` (gets a `powered`/`watered` flag pair already —
  keep the names).
- `economy.ts`: `allocateUtilities` (replace the pool math),
  `runGrowth`/`growthDesirability` (reads `powerHeadroom`/`waterHeadroom`),
  `runLevels` (growth of operational buildings).
- `pathfinding.ts`: `areRoadsConnected` analog — line/pipe connectivity
  is a BFS over a cell set; the road-BFS in `city.ts` is the pattern.
- `ai.ts`: `thinkConstruction` (construction priority per difficulty),
  `canTrain` callers, virtual buildings (`AIPlayerState.virtualBuildings`).

### Changes

1. **Data model — network links.** Add a `utilities: UtilityNetwork[]`
   (or per-player `networks`) on `CityState`: each link is a set of cell
   indices (same sorted-array discipline as `roads`) connecting a plant
   to serviced cells. Plants serve only demanders reachable through
   lines/pipes. Deterministic ordering: compute per-player, plant-id
   order, flood BFS from plants in id order, demader allocation in
   building-id order (keep today's tiebreaks).
2. **Zone-level servicing.** Today demand is per building. For zone-level
   service, aggregate demand per (player, zone rect or zone paint cell)
   and mark service on zone cells; then buildings inherit
   `powered`/`watered` from their footprint cells. `runGrowth` already
   takes headroom arrays — its signature stays.
3. **Plant types across tech levels.** `BuildingDef.minAge` (`city.ts`,
   validated in `placeBuilding` spec via `isBuildingAgeMet`) already
   gates placement by age — new plant kinds (`coalPlant`,
   `gasPlant`, `windFarm`, `geothermalPlant`, `hydroPlant`, …) slot in
   as defs with different `powerSupply`/cost/`minAge`. No structural
   change; the AGENTS.md note "Balance numbers are Phase 1 engineering
   choices — tune them, keep tests green" applies.
4. **The pool vs. connectivity cutover.** This is the breaking decision:
   either (a) keep the global pool as fallback when no lines are built
   (gradual — recommended for playable continuity), or (b) hard-require
   connectivity (breaks every existing balance test + the AI until it
   learns to lay lines — a full XL).
5. **Commands.** `buildPowerLine`/`buildPipe` command kinds (new
   `CommandSpec`s in `city.ts` `makeSpecs`, registered in
   `registerCityCommands`), following the `buildRoad` precedent
   (cell arrays ≤512, cost per cell `ROAD_COST_FUNDS` analog,
   `sortedInsert` into the sorted cell set). Demolish already handles
   roads cell-wise — extend to lines/pipes.

### Determinism pitfalls

- Flood/BFS order must be id-ordered and tie-break stable: same as
  `areRoadsConnected`'s 4-neighbor order. No `Set` iteration for sim
  logic unless iteration order is sorted.
- Line cells on `CityState` must keep the `roads`-style sorted
  invariant; `canonicalizeWorld` must include them in sorted order.
- Plants that are unfunded (`funded` set in `allocateUtilities`) must
  drop out of the network before the flood — funding is computed first,
  keep that ordering.

### Complexity: **XL**

The def additions are S; the connectivity model + zone-level servicing
+ migration + AI line-building + render overlay plumbing make it XL.

---

## 2. Logistics

There is **no logistics system today**. Relevant facts:

- `fuel` is a generic stockpile: produced by `oilRefinery`
  (`output: { fuel: 1.5 }`), consumed by `factory` and `powerPlant`
  inputs, tradable on the market. There are no unit-level fuel or ammo
  mechanics — units fight forever once trained.
- `nuclearPlant` consumes `fuel: 0.5`/s like a fossil plant today
  (there is no uranium/nuclear-fuel distinction).
- Missile-style weapons don't exist as a resource: `mlrs` and
  `missileBoat` fire on `cooldownTicks` with unlimited ammo.

The expansion wants: fuel + missile supply chains (production →
specialization → transport → reload), with nuclear-powered units
exempt.

### Hooks

- `units.ts`: `UnitDef` (new optional fields), `UnitRecord` (new per-unit
  state), `spawnUnit` (initial stocking), `registerUnitCommands` (validate
  only — trains cost, no ammo).
- `combat.ts`: `createCombatSystem` (firing gate), `damageMultiplier`
  (no change — multipliers stay, but out-of-ammo units must not fire).
- `economy.ts`: `runProduction` (fuel chain: refinery → depot),
  `allocateUtilities` (powered state for the new building kinds).
- `city.ts`: `BuildingDef`/`BuildingKind` (fuelDepot, missileSilo or
  munitions factory, possibly `uraniumMine`), `validatePlacement`.
- `movement.ts`/`pathfinding.ts`: transport units carrying supplies
  (hauler is unarmed transport; supply trucks are a pattern away).

### Changes

1. **Def-level flags.** Add to `UnitDef`: optional `fuelCapacity` +
   `fuelPerSecond` (burn rate while moving/fighting), optional
   `ammoCapacity` + `ammoPerShot` (missile weapons), `fuelType:
   'fossil' | 'nuclear' | 'none'`. Nuclear exemption = `fuelType:
   'nuclear'` units skip the burn check entirely.
2. **Record-level state.** Add to `UnitRecord`: `fuel: number`,
   `ammo: number` (snapshotted, digested). Initialize in `spawnUnit`
   (full on spawn — matches the existing "existing units are never
   retroactively changed" convention for upgrades).
3. **Combat gating.** In `createCombatSystem`, before `fireWeapon`:
   units with `ammoPerShot > 0` and `ammo < ammoPerShot` cannot fire
   (they hold like unarmed units — `damage <= 0` precedent). Firing
   deducts ammo. Fuel burn happens in `createMovementSystem` (moving
   units burn; fuel 0 → `state = 'failed'` with
   `failReason = 'out of fuel'`, never silent — see `failUnitOrder`).
4. **Supply chain buildings.** `fuelDepot` (stores/distributes fuel),
   `munitionsFactory` (produces `ammo` resource — a new `ResourceKey`…
   but `ResourceKey` is an 8-resource const enum baked into
   `getStock`/`addStock` switches, `def.input`/`def.output` typing, the
   market, and the digest. Adding `ammo` as a ResourceKey touches all
   of those; cleaner: keep ammo off the global stockpile and model it
   as depot inventory on the `BuildingRecord` (see point 6). Missiles
   could stay a unit-local resource replenished at depots.
5. **Reload command + transport.** New command `resupply`
   (`unitId` + depot building id): validate adjacency/in-range,
   transfer fuel/ammo at depot stock cost. Supply trucks: extend
   `hauler`'s pattern — a `supplyTruck` unit whose `harvest`-like
   aura refills nearby friendly units (see `runHarvest` precedent:
   per-sim-second stockpile writes; here per-unit writes). **Transport
   of supplies by road/rail** is the XL part (see §9).
6. **Specialization.** The expansion's "production → specialization"
   maps to a building-level upgrade or a second building kind:
   `munitionsFactory` + research upgrades in `upgrades.ts` raising
   ammo capacity / reload rate (new `effective*` hooks, same pattern as
   `effectiveRange`).

### Determinism pitfalls

- Ammo/fuel are floats: burn/fill math must be order-stable (id order
  for aura refills, like `runHarvest` iterates `world.units` in array
  order).
- No partial-order shenanigans: reload happens at tick boundaries via
  commands; depots' inventories are plain numbers in building records.
- The Aegis check in `fireWeapon` already reads
  `world.superweapons` directly to avoid an import cycle — logistics
  hooks in combat must respect the same import-cycle discipline
  (`combat.ts` cannot import the economy module; keep hooks as plain
  data lookups).

### Complexity: **L** for unit-local fuel/ammo + depots + resupply
command; **XL** if supplies must physically travel on road/rail
networks (depends on §9).

---

## 3. Unit veterancy

No veterancy exists. Per-unit mutable stats today: `hp`, `cooldownLeft`,
`speed` (set once at spawn via `effectiveSpeed`), target/order state.
Bonuses come from defs + upgrades (`effective*` hooks) and auras
(`damageMultiplier`).

### Hooks

- `units.ts`: `UnitRecord` (new `xp` / `vetLevel` fields), `UnitDef`
  (optional vet thresholds), `spawnUnit`.
- `combat.ts`: `createCombatSystem` (award XP on kills — in id order),
  `damageMultiplier` (apply vet bonus — currently reads def +
  upgrades + auras; vet level multiplies in the same place), `killUnit`
  (XP credit; careful: killer id needed at death time).
- `digest.ts`: `canonicalizeWorld` unit encoding.
- `snapshot.ts`: `copyUnit`.

### Changes

1. **Record.** Add `xp: number`, `vetLevel: 0|1|2|3` to `UnitRecord`;
   `killUnit` credits XP to the killer before removal (killer id is
   known in `fireWeapon`'s caller — thread it through, or credit at
   the point `dead.push(target)` is decided, where both attacker and
   target are in scope).
2. **Effects.** Vet multipliers: e.g. level → +10% damage, +10% max HP
   per level (tune). Apply damage bonus in `damageMultiplier` (one
   line, same place auras apply), HP bonus via `effectiveMaxHp`-style
   computation at damage/heal time — note today's `effectiveMaxHp` is
   applied only at **spawn**; vet HP must apply to *living* units, so
   `applyHealAuras`'s cap and the combat loop need a
   `vetAdjustedMaxHp(unit)` helper. Keep it pure and id-ordered.
3. **XP economy.** Kills award XP in id order (combat already iterates
   `[...world.units].sort((a,b) => a.id - b.id)`). No RNG — flat awards
   per kill, maybe scaled by victim `hp` (deterministic).

### Determinism pitfalls

- XP crediting must happen in the same deterministic order as kills
  are processed; multi-kill ticks are fine as long as iteration order
  is fixed (it is).
- `vetLevel` thresholds: pure function of `xp` — compute on award,
  store the level (don't recompute per query, or keep both consistent).
- Digest must include `xp` and `vetLevel`; snapshot copies them.

### Complexity: **S–M** (self-contained; the fiddly part is the
vet-HP-vs-spawn-HP distinction).

---

## 4. New units/buildings across tech levels

This is the best-supported expansion path — the roster was already
expanded once (28/28/12, `main` `6ba3414`) using exactly these hooks.

### Hooks

- `units.ts`: `UNIT_KINDS` (const tuple — `unitIcon` in
  `ui/icons.ts` is `Record<UnitKind, string>`, so a new kind is a
  **compile error** until the icon exists — good guardrail),
  `UNIT_DEFS` entries, `registerUnitCommands` (spawn validation).
- `city.ts`: `BuildingKind`, `BUILDING_DEFS`, `placeBuilding` spec
  (age gating via `isBuildingAgeMet`), `BUILDING_DEF_LIST` (growth
  candidates — only cheap residential/commercial/industrial kinds;
  new kinds opt in deliberately).
- `ages.ts`: `Age` (5 ages exist; new tech *levels within* ages or a
  6th age both work — `AGE_ORDER` + `isUnitAvailableForAge` /
  `isBuildingAgeMet` do the gating).
- `upgrades.ts`: `researchUpgrade` prereqs (`minAge`, building
  prerequisites via `hasProductionBuilding`).
- `ai.ts`: `thinkProduction` (`BASE_MIX`, counters), `thinkConstruction`
  (`CONSTRUCTION_PRIORITY`), `thinkResearch`, `canTrain` (skips locked
  kinds — new kinds are skipped automatically until added to mixes).
- `ui/palettes.ts`: `TRAIN_TABS`/`BUILD_TABS` groupings,
  `unitAvailability`/`buildingAvailability` (mirrors sim validation).
- `render/models.ts` `MODEL_PATHS` / `proceduralModels.ts`
  `PROCEDURAL_KINDS` (render side, not sim).

### Changes

1. Defs only for the sim core: add `UnitDef`/`BuildingDef` rows with
   `minAge`, `requiredBuilding`, costs. Spawn/placement validation
   already enforces age + production-building + manpower + training
   cost — no command changes needed.
2. If "tech levels" means **versions of the same unit** (e.g. Tank Mk
   I/II/III): prefer distinct `UnitKind` entries sharing art over a
   per-unit tech-level field — the existing `minAge` + `requiredBuilding`
   gates already express "better version unlocks later". A
   per-unit `techLevel` on the record would need digest/snapshot
   coverage for little gain.
3. AI: new combat units must be added to `thinkProduction`'s counter
   table (spec §7.2 in ai.ts docs) and `BASE_MIX`, or the AI will
   never build them (`canTrain` returns true but nothing selects the
   kind). New production buildings go in `CONSTRUCTION_PRIORITY` per
   difficulty (or the AI can't unlock the units behind them).
4. `BUILDING_DEF_LIST` decides what `tryAutoDevelop` (growth) builds —
   add economy buildings here only if the auto-growth should place them.

### Determinism pitfalls

- None new: defs are static data; the existing gates are deterministic.
- Watch the UI `paletteDigest.ts` mirror: new kinds must appear in the
  digest's availability coverage or buttons won't refresh (see
  `ui/AGENTS.md`).

### Complexity: **S** per batch of kinds (defs + AI mixes + palettes +
tests); **M** for a full tech-level pass with AI tuning.

---

## 5. Hangar-gated aircraft production

Today: air units (`fighter`, `fighterBomber`, `attackHeli`, `awacs`)
require `requiredBuilding: 'airfield'` — a binary gate checked in
`registerUnitCommands` validate via `hasProductionBuilding` (real or
AI-virtual). The expansion wants **hangars**: per-aircraft-type capacity
at the airfield (e.g. an airfield supports N aircraft of specific types).

### Hooks

- `city.ts`: `BuildingDef` (airfield def), `BuildingRecord` (per-building
  hangar state — new optional field, e.g. `hangars: Record<string,number>`
  or a fixed slot array), `hasProductionBuilding`.
- `units.ts`: `registerUnitCommands` validate (spawn gate), `UnitDef`
  (new `hangarClass` / `hangarSlots` fields).
- `ai.ts`: `thinkProduction` (AI must count hangar usage), virtual
  buildings (virtual airfields need virtual hangar capacity).

### Changes

1. **Building record extension.** Add optional `hangarCapacity` /
   `hangarUsed: Record<UnitKind, number>` to `BuildingRecord` (plain
   data; snapshot `copyBuilding`, digest building encoding). "Optional"
   keeps old saves loadable (see §12).
2. **Spawn validation.** In `registerUnitCommands` validate: after the
   existing `hasProductionBuilding` check, find the owner's completed
   airfields **in id order**, check free hangar slots of the unit's
   class; the apply step reserves the slot on a specific building id
   (deterministic: lowest-id airfield with room). On unit death
   (`killUnit`), release the slot. This creates a building↔unit
   reference — keep it as `unit.hangarBuildingId: number` on
   `UnitRecord` (0 = none), snapshotted + digested.
3. **Civilian vs military hangars** (§7 interacts): hangar classes
   gate which kinds each airfield services — def-level data on the
   airfield kind.
4. **AI.** `canTrain` must become hangar-aware (currently only
   age + production-building). AI virtual airfields get virtual
   capacity (extend `AIPlayerState.virtualBuildings` entries or add a
   `virtualHangars` record). `thinkProduction` should prefer filling
   existing hangars before building new airfields.

### Determinism pitfalls

- Slot reservation order (lowest building id first) must be identical
  at validate and apply — validate must be a pure preview of apply's
  choice, or a race between two same-tick spawns diverges.
- `killUnit` releases the slot: death processing is already id-ordered.
- Old saves: buildings without `hangars` decode to a default
  (e.g. legacy airfield = 4 generic slots) — must be documented and
  pinned by test.

### Complexity: **M** (record fields + validate/apply pairing + AI
awareness + release-on-death).

---

## 6. Carriers with assigned air wings

Today `carrier` is just a big sea unit (`UNIT_DEFS.carrier`,
`requiredBuilding: 'navalYard'`, `minAge: 'information'`). The expansion
wants carriers to **come empty** and embark only carrier-capable
aircraft as an assigned wing.

### Hooks

- `units.ts`: `UnitDef` (new `carrierCapable?: boolean`,
  `wingSlots` on carrier), `UnitRecord` (new `embarkedOn: number`,
  `wing: number[]` — pick one representation), `spawnUnit`,
  `registerUnitCommands` (carrier spawns empty; aircraft spawn
  assignment).
- `movement.ts`: embarked aircraft don't move independently
  (`orderMoveTo` must refuse/redirect for embarked units;
  `createMovementSystem` skips them — they ride the carrier's x/z).
- `combat.ts`: `acquireTarget`/`canTarget` (embarked aircraft can't be
  targeted or fire; the carrier is the target), `killUnit` (carrier
  death → wing disposition: destroyed with it, or launched? — design
  decision, must be explicit).
- `pathfinding.ts`: `requestPath`/`requestField` (embarked units hold
  no requests).

### Changes

1. **Def flags.** `carrierCapable` on aircraft defs (a subset —
   e.g. not AWACS/transports); `wingCapacity` on the carrier def.
2. **Record linkage.** `UnitRecord.embarkedOn: number` (carrier unit
   id, 0 = not embarked). Carrier keeps no list (single source of
   truth on the aircraft side — avoids dual-write divergence).
   Digest + snapshot cover the field.
3. **Commands.** `embarkAircraft` (unitId + carrierId): validate same
   owner, carrier-capable kind, carrier has free slot, both alive and
   (design choice) within X world units; apply sets `embarkedOn`.
   `launchAircraft` clears it. Carrier spawn: no change needed (already
   spawns empty — wings are assigned post-spawn, which matches "carriers
   come empty").
4. **Movement/combat integration.** In `createMovementSystem`, skip
   position updates for `embarkedOn !== 0` units (position = carrier's,
   computed at read time or synced per tick — syncing per tick writes
   floats derived from the carrier; do it in the movement system in id
   order). In combat, `acquireTarget` skips embarked units; `canTarget`
   unchanged (carrier itself is targetable). `killUnit` on a carrier:
   decide wing fate (destroy with carrier = simplest and deterministic).
5. **AI.** `thinkProduction`/`thinkNaval*`: build carrier-capable
   aircraft only when a carrier with free slots exists; embark via
   command; treat the wing as part of naval composition.

### Determinism pitfalls

- Position sync for embarked units: if synced per tick, the sync must
  run before combat target acquisition (system order: movement before
  combat already holds — put the sync inside `createMovementSystem`).
- `embarkedOn` references a unit id — ids are never reused, so stale
  references after carrier death are safe *if* `killUnit` clears them.

### Complexity: **M** (linkage + commands + movement/combat guards +
AI usage).

---

## 7. Airport/port types (civilian / military / mixed)

Today: one `airfield` (military production), one `navalYard` (military
production), one `shipyard` (required by `missileBoat`). No civilian
aviation or shipping; no civilian airlines/cargo.

### Hooks

- `city.ts`: `BuildingKind`, `BUILDING_DEFS`, `validatePlacement`
  (coastal rule precedent: `navalYard` requires coast adjacency —
  ports need the same), `BuildingRecord`.
- `units.ts`: `UnitDef`/`UNIT_KINDS` (civilian aircraft: airliner, cargo
  plane; civilian ships: cargo ship, ferry — see §9).
- `economy.ts`: `runProduction`/`runTradeRoutes` (civilian airports/
  ports generate funds/trade income — the `market` def precedent:
  `output: { funds: 2.5 }` with food/goods inputs).
- `ages.ts`/`upgrades.ts`: gating (`minAge`, research prereqs).
- `ai.ts`: construction priorities, `canTrain` for civilian units.

### Changes

1. **Building kinds.** Add `civilAirport`, `militaryAirbase` (or
   re-type `airfield`), `mixedAirport`, and port analogs
   (`commercialPort`, `navalBase`, `mixedPort`, `marina` — §9).
   `BuildingDef.zone`: ports stay `UTILITY_ZONE` + coastal rule
   (`isCoastal` check in `validatePlacement`, mirroring `navalYard`).
   Type is a def-level property (`airportType:
   'civilian'|'military'|'mixed'`) — no new zone type needed.
2. **Unit gating.** Civilian aircraft require a civilian/mixed airport
   (`requiredBuilding` currently takes ONE kind — extend to
   `requiredBuildings?: BuildingKind[]` (any-of), or keep one kind per
   unit and make mixed airports satisfy both via a def-level
   `countsAs: BuildingKind[]` list. The `countsAs` approach keeps
   `hasProductionBuilding(world, owner, kind)` signature stable:
   check `b.kind === kind || def.countsAs?.includes(kind)`.
3. **Economy.** Civilian airports/ports: `output: { funds }` scaled by
   serviced routes (static rate is fine for Phase 1, like `market`);
   mixed types produce less of each. Civilian airlines as units:
   unarmed `air` domain units with a `harvest: { funds }`-style income
   (`runHarvest` precedent — `fishingBoat` already earns food this way).
4. **Peaceful mode** (§11) uses the civilian types while military
   production is disabled — the gating above makes this a config flag,
   not a fork.

### Determinism pitfalls

- `countsAs` resolution must be a pure def lookup, identical in
  validate and apply.
- Civilian income via `runHarvest` is already deterministic (array
  order); keep new harvest defs there.

### Complexity: **M** (kinds + any-of gating + economy outputs + AI
priorities). Civilian airline *routing* (schedules between airports)
would push it to L — keep static income first.

---

## 8. Intel, spies, recon

Partial precedent exists — this is an extension, not greenfield:

- `getSightBonus(world)` (`ages.ts`): Signals Grid +8 sight (intel
  program choice).
- `effectiveSight` (`upgrades.ts`): Drone Optics, Advanced Avionics,
  Sonar Suite stack on def sight.
- `getVisibleEnemies(world, owner)` (`ai.ts`): the **only** fair
  perception path — filters enemies by each own unit's sight. Any fog/
  intel mechanic must flow through here or the AI fairness invariant
  breaks.
- `awacs` (sight 65), `radarStation` (building), recon-ish `drone`
  (sight 26) exist as units/buildings.

The expansion wants: intel tech, spies, recon systems.

### Hooks

- `ai.ts`: `getVisibleEnemies` (the perception chokepoint),
  `effectiveSight` callers.
- `units.ts`: `UnitDef` (spy unit: `domain: 'land'`, `targets:
  'none'`, stealth flags), `UnitRecord` (new `detected`/`stealthed`
  state), `spawnUnit`.
- `combat.ts`: `acquireTarget` (stealthed units not auto-acquired
  unless detected), `canTarget` (spies unarmed anyway).
- `city.ts`: buildings (`listeningPost`, `intelAgency` — economy/
  sight outputs).
- `ages.ts`/`upgrades.ts`: intel tech (`minAge`, upgrade-gated sight/
  detection — `effectiveSight` already takes `(world, owner, def)`).

### Changes

1. **Stealth model.** Add `UnitDef.stealth?: boolean` (spies, recon
   drones) and `UnitRecord.detectedBy: number[]`… simpler: spies are
   invisible to `getVisibleEnemies` and `acquireTarget` unless within
   `detectionRadius` of an enemy detector (counter-intel units,
   radar stations, AWACS — def-level `detectorRadius`). Detection is a
   per-tick pure function of positions (no stored state → no snapshot
   impact): compute in the getters. **This keeps the digest unchanged
   for stealth** — a strong simplicity win.
2. **Spy actions.** Commands: `infiltrateBuilding` (spy → enemy
   building: validate adjacency, effect = reveal area / steal research
   / sabotage). Effects write plain data (research stockpile transfer
   via `addStock`; sabotage sets `operational = false` for N ticks —
   needs a `sabotagedUntil` tick on `BuildingRecord`, or reuse
   `progress < 1` semantics… cleaner to add the field).
3. **Recon.** Recon drones/`awacs` already extend sight via
   `effectiveSight`; add a `reconPulse` command or building-based
   periodic reveal: simplest deterministic version — a `radarStation`
   grants its owner visibility of all units within radius R through
   `getVisibleEnemies` (add a building-sight term: iterate owner's
   completed radar/listening buildings, radius check). This is O(own
   buildings × enemy units) per AI think — fine at think cadence, but
   do NOT put it in the per-tick combat loop.
4. **Intel tech.** New upgrades in `upgrades.ts` (`signalsIntel`,
   `counterIntel`): hooks into `effectiveSight`, detection radius,
   sabotage resistance. The `researchUpgrade` command needs no change
   (prereqs are data).

### Determinism pitfalls

- Detection as a pure function of positions: same tick, same result —
  no stored RNG, no stream draws in the perception path (AI draws
  nothing during thinks already — keep it that way).
- `getVisibleEnemies` is O(own × enemy); adding buildings × enemies
  keeps the shape. Never call it per unit per tick in combat.
- Sabotage timers (`sabotagedUntil` tick) are plain numbers —
  snapshot/digest covered like `cooldownLeft`.

### Complexity: **M** for stealth + detection + radar sight; **L**
with spy actions + sabotage + AI spy usage.

---

## 9. Transport variety

Today:

- Roads are a single class: `buildRoad` paints cells at
  `ROAD_COST_FUNDS`/`ROAD_COST_MATERIALS` per cell; `pathfinding.ts`
  `cellMoveCost` applies `ROAD_COST_FACTOR = 0.5` on any road cell.
  Roads are **optional** (no building requires them; `areRoadsConnected`
  is kept "for later traffic/service systems").
- Movement domains: `land` (A* + flow fields), `sea` (`findSeaPath`
  over `seaComponents`), `air` (straight-line, no pathfinding).
  `validateDestination` gates per domain; `moveGroup` splits ground/
  air/sea with separate slot assignment (`assignGroupSlots`,
  `assignSeaSlots`, `assignAirSlots`).
- `hauler` (land) and `transport`/`transportShip` exist but carry
  nothing — there is no cargo/embark model for ground units.

The expansion wants: road classes, rail, trams/buses/ferries, marinas.

### Hooks

- `city.ts`: `roads: number[]` (single sorted set), `buildRoad` spec,
  `ROAD_COST_*` constants.
- `pathfinding.ts`: `cellMoveCost` (road factor), `passabilityMask`,
  `ROAD_COST_FACTOR`.
- `movement.ts`: `validateDestination`, `createMovementSystem`,
  `orderMoveTo`.
- `units.ts`: `UnitDef`/`UnitKind` (bus, tram, ferry, train units),
  `UnitRecord` (passenger/cargo linkage — see §6 pattern).
- `economy.ts`: `runProduction` (transit income — civilian transport
  earns like `market`).

### Changes

1. **Road classes.** Replace `roads: number[]` with
   `roads: Array<{ cell: number; cls: RoadClass }>` (sorted by cell —
   keep the sorted invariant; `sortedHas` becomes a binary search on
   `.cell`). `RoadClass = 'dirt' | 'street' | 'avenue' | 'highway'`
   with per-class cost and `cellMoveCost` factor (extend
   `ROAD_COST_FACTOR` to a per-class table). `buildRoad` takes a
   `class` payload. **This changes the digest encoding of roads**
   (see §12) and `zoneAt`-style lookups. S–M in isolation.
2. **Rail.** Rails are a second network (like §1's lines): `rails:
   number[]` sorted set + `buildRail` command. Pathfinding: trains are
   a new movement constraint — simplest deterministic model is
   **waypoint-on-rails**: train units path only along rail cells
   (BFS over the rail set between stations, reusing the
   `areRoadsConnected` pattern). Do NOT try to fit trains into the
   flow-field flood — rail movement is 1-D along the graph; a small
   dedicated rail router is cleaner than bending A*.
3. **Trams/buses.** Buses = road-class-gated land units (require
   `street`+ class cells — validate in `orderMoveTo`? No: simpler is
   cost-factor only, like roads today). Trams = rail units confined to
   city rail. Both earn civilian income: `harvest: { funds }` while
   moving on their network (extend `runHarvest` with a "on-network"
   check — pure function of position).
4. **Ferries.** Sea-domain civilian units (`ferry`) running between
   `marina`/`commercialPort` buildings: `findSeaPath` already routes
   sea units; the new part is the **schedule** (A→B→A loop). Schedules
   are command-issued `moveUnit` pairs or a `setFerryRoute` command
   storing `route: { a: {x,z}, b: {x,z} }` on the unit record; the
   movement system advances the loop. Plain data, deterministic.
5. **Marinas.** `BuildingKind.marina`: coastal `UTILITY_ZONE` building
   (validate via `isCoastal`, the `navalYard` precedent), enables ferry
   spawn (`requiredBuilding: 'marina'`), small funds output.

### Determinism pitfalls

- Road-class change touches the digest's `roads=` encoding — old saves
  migrate (default class for legacy cells).
- Rail BFS must be deterministic (sorted adjacency, id-ordered).
- Ferry schedules: store waypoints as plain coords; loop advancement
  in the movement system in unit-id order.

### Complexity: **L** for road classes + rail + trams/buses/ferries as
designed above. (Physical cargo movement for §2 logistics on top of
this network is the XL.)

---

## 10. Airport zones

Today zones are three ints (`ZoneType`: residential/commercial/
industrial) painted per cell (`paintZone`, ≤4096 cells/command,
`ZONE_COST_FUNDS_PER_CELL`). Buildings match zones in
`validatePlacement` (`def.zone !== UTILITY_ZONE` requires exact zone
match); `UTILITY_ZONE` buildings (`airfield`, `navalYard`, `radarStation`,
power/water plants) skip zoning entirely and place "anywhere on land".

The expansion wants airports as zones (with hangars per aircraft type).

### Hooks

- `city.ts`: `ZoneType`, `paintZone` spec, `validatePlacement`,
  `zoneAt`, `tryAutoDevelop` (growth samples zones).
- `economy.ts`: `runTaxes` (`player.taxRates[def.zone]` — indexed by
  the 3 zone ints; `taxRates: [number, number, number]`).
- `digest.ts`: `zones=${...}` encoding.

### Changes

1. **New zone type.** Add `ZoneType.AIRPORT = 3` (and later `PORT =
   4` if ports become zones). `paintZone` validation (`zone must be 0,
   1 or 2`) extends; `PlayerState.taxRates` becomes a 4-tuple
   (snapshot `copyPlayer` + digest encoding change — see §12).
2. **Placement.** Airport buildings (`civilAirport`, hangars) require
   `ZoneType.AIRPORT` in `validatePlacement` — same shape as the
   existing zone-match rule. The airfield-as-zone replaces today's
   "utility anywhere" placement for aviation buildings (design decision;
   keep `airfield` on UTILITY_ZONE for backward compat or migrate it).
3. **Hangars per aircraft type in zones.** Zone-level hangar capacity:
   each airport-zoned cell (or the zone rect) contributes hangar slots
   by aircraft class; `hasProductionBuilding`-style gate becomes
   zone-aware. Simplest: keep hangars on the **building** (§5) and let
   the zone be the placement prerequisite — don't put capacity on
   cells.
4. **Growth.** `tryAutoDevelop`/`affordableDefForZone` iterate
   `BUILDING_DEF_LIST` per zone — airport zones don't auto-develop
   (no defs listed for the airport zone), which is correct: airports
   are player-placed infrastructure.

### Determinism pitfalls

- `taxRates` tuple length change: old saves decode 3 rates → pad the
  4th with `DEFAULT_TAX_RATE` (decode-time default, tested).
- Zone ints in the digest: `zones=` encoding already writes the int —
  no format change, just a new valid value.

### Complexity: **S–M** (mostly data + validation; the hangar capacity
lives in §5).

---

## 11. Peaceful no-military mode

Today the game is always conquest-framed: `session.ts`
`checkSkirmishVictory` (rival has no units/buildings) /
`checkSkirmishDefeat` (player has none) via `getSkirmishOutcome` with a
30-tick grace period; campaign supports `'none'` AI difficulty (no AI
rival at all — the precedent for "no opponent" sessions).

### Hooks

- `ui/session.ts`: `createSession` (`aiDifficulty`, `hasAIRival`),
  `checkSkirmishVictory`/`checkSkirmishDefeat`/`getSkirmishOutcome`,
  `SessionOptions`.
- `units.ts`: `registerUnitCommands` validate (military gate).
- `city.ts`: `placeBuilding` spec (military production buildings).
- `upgrades.ts`: `registerUpgradeCommands` (military upgrades).
- `ai.ts`: whole module (no rival in peaceful mode — nothing to change
  if no AI player is added; `world.ai.players` empty is already handled
  — `getVisibleEnemies` with no AI owner is simply never called).

### Changes

1. **Session flag.** Add `peaceful: boolean` to `SessionOptions`:
   no AI rival is added (`hasAIRival = false` — the `'none'` precedent),
   and victory/defeat checks are bypassed (sandbox, like current
   no-rival skirmishes: `getSkirmishOutcome` returns null when there is
   no rival — verify this is already the behavior; if not, gate it on
   the flag).
2. **Military lockout.** In `registerUnitCommands` validate: when
   `world.peaceful` (new boolean on `World` — snapshotted, digested,
   defaults false), reject `spawnUnit` for kinds with `damage > 0` or
   `targets !== 'none'`… more precisely, reject kinds flagged
   `military: true` on the def (civilian units: engineer, hauler,
   transport, fishingBoat, combatMedic?, civilian airliners/ferries
   from §7/§9). Same gate in `placeBuilding` for military production
   buildings (`barracks`, `warFactory`, `navalYard`, military
   airfields, aegis/storm) and in `researchUpgrade` for military
   upgrades (or leave research open — design call; the sim gate is one
   predicate either way).
3. **Win condition for peaceful mode.** Conquest victory is meaningless
   without a rival — peaceful mode needs its own goals (population,
   influence, or scenario objectives via the campaign director). This
   is UI/campaign work, not sim: the sim just needs the mode flag and
   the lockout.
4. **AI.** None — no rival exists. (A "peaceful AI trader" rival is a
   later feature, not this mode.)

### Determinism pitfalls

- `world.peaceful` is set at session creation (tick 0, before any
  command) — never toggled mid-game, or in-flight military units would
  need disposition rules.
- The flag must be in the digest (a peaceful and a military world with
  identical entities must digest differently) and the snapshot.

### Complexity: **S** (flag + validate gates + session wiring). The
peaceful-mode *objectives* are separate UI/campaign scope.

---

## 12. Snapshot/digest migration strategy

Current state (`snapshot.ts`):

- `SNAPSHOT_VERSION = 6`, `OLDEST_SUPPORTED_SNAPSHOT_VERSION = 5`.
- v5 snapshots still load: `upgrades` defaults to `{}` ("v5 snapshots
  still load with empty upgrades").
- **The established precedent is decode-time defaults WITHOUT a version
  bump** when the addition is (a) new optional state with a neutral
  default that reproduces old behavior exactly:
  - AI personality joined `AIState` with no bump — `decodeAIState`
    defaults a missing personality to `NEUTRAL_PERSONALITY` (the
    step-7 precedent, cited in the v6 comment block).
  - Delegation/superweapons/ages: `restoreSnapshot` defensively
    `init*()`s when the section is missing.
- A bump (v5→v6) was used only when the new state had **no neutral
  default** that old code could ignore — per-player upgrades changed
  what old saves *mean* (an old save's empty upgrades would silently
  differ from a fresh v6 game only in digest, so they bumped and kept
  v5 loadable with `{}`).

**Strategy for the expansion** (follow the precedent):

1. **Prefer additive optional fields with neutral defaults, no bump.**
   New `UnitRecord` fields (`xp`, `vetLevel`, `fuel`, `ammo`,
   `embarkedOn`, `hangarBuildingId`, ferry `route`): decode missing →
   `0`/`undefined`. New `BuildingRecord` fields (`hangars`,
   `sabotagedUntil`): decode missing → sensible default (legacy
   airfield = N generic slots — **document the exact default and pin
   it in a test**). New `World` flags (`peaceful`): missing → false.
   New `CityState` sections (`utilityNetworks`, `rails`, road classes):
   missing → empty.
2. **Digest must cover every new field that affects future sim
   behavior.** The digest is the desync detector: if two worlds differ
   only in `ammo`, their digests must differ. Follow the existing
   patterns — sorted owners, id-ordered arrays, `canonicalNumber` for
   floats, `pers=-` style missing markers. **Digest additions do not
   require a snapshot bump** (the digest is not versioned), but they
   DO change `digestWorld` output for identical scripts — the AGENTS.md
   rule applies: "if `digestWorld` output changes for the same script,
   something in the sim changed — investigate, don't update the test
   blindly." When adding fields, update the canonical-encoding tests
   deliberately with a comment naming the new field.
3. **Bump the version (v6→v7) only when** an old save would load into a
   *different game* without the implementer noticing — e.g. the
   road-class change (legacy `roads: number[]` vs new
   `roads: {cell, cls}[]` is a **shape change**, not an additive field;
   decode must map old cells → default class). Keep
   `OLDEST_SUPPORTED_SNAPSHOT_VERSION` policy: support N and N−1
   (today 6 and 5); when bumping to 7, decide whether v5 support drops
   (today's code rejects anything that isn't 6 or 5 — the same
   if-chain extends naturally).
4. **Shape changes need explicit migration functions**, not silent
   defaults: `migrateRoadsV6ToV7(cells: number[]): RoadCell[]`,
   `migrateTaxRates([r0,r1,r2]): [r0,r1,r2,DEFAULT]` for the 4th zone.
   Put them next to the existing `decode*` functions
   (`decodeAgeState`, `decodeAIState`, `decodeDelegationState` are the
   pattern) and unit-test the migration separately from the sim.
5. **RNG streams:** new systems get **new named streams**
   (`'logistics'`, `'intel'`, …) via `rngBank(world).next('name')` —
   never reuse `'city'`/`'combat'` for new draws, and never draw during
   AI thinks (the ai.ts invariant: "think functions draw nothing" —
   personality is derived once at `addAIPlayer`). Stream state is
   already snapshotted verbatim (`copyRng`) and digested (sorted names),
   so new streams are free.
6. **Round-trip invariant is the gate:** `digest(restore(take(w))) ===
   digest(w)` must hold for every new field — the existing
   save/load integrity tests are the template; add round-trip cases
   for each new record field.

---

## 13. Top 5 architectural risks

**R1. The utility-connectivity cutover breaks the AI and every balance
test.** `allocateUtilities` is the heart of the economy tick and the AI
has no concept of lines/pipes — its virtual buildings
(`AIPlayerState.virtualBuildings`) bypass placement entirely, so a
hard connectivity requirement silently starves the AI while the human
wires networks. Mitigation: keep the global pool as the fallback
(§1 change #4, option a), teach the AI line-building as its own phase,
and gate the hard requirement behind a game option — never the default
until the AI copes. This is the single biggest scope risk in the
expansion.

**R2. Import cycles as systems interleave.** The codebase already works
around real cycles: `city.ts` cannot import `ages.ts` (mirrors
`AGE_ORDER_LOCAL` with a comment); `combat.ts` cannot import
`superweapons.ts` (reads `world.superweapons` directly with a comment);
`placeBuilding` reads `world.ages` directly. Logistics (§2) wants
combat→economy and economy→combat hooks; intel (§8) wants
combat→perception hooks. Each new cross-module read must either live
behind a `world.*` direct access with a documented reason, or the
shared types must move to a leaf module. An unreviewed import will
compile (ESM cycles often "work") and then produce `undefined` defs at
module-init time in one bundler but not another — the failure mode is
silent and engine-dependent. Mitigation: keep the "data on `World`,
logic in the owning module, direct reads with comments" discipline;
add a lint/test asserting the known cycle pairs stay cycle-free.

**R3. Digest drift from new state fields.** Every new record field must
be added to `canonicalizeWorld`, or same-seed replays desync silently
(the digest is the only desync detector). The failure mode is
*invisible*: the game plays fine, but save/load integrity and replay
verification rot. The AGENTS.md rule ("investigate, don't update the
test blindly") is the defense, plus a mechanical checklist per change:
snapshot copy → decode default → digest encoding → round-trip test.
Highest-risk fields: per-unit `ammo`/`fuel` (floats — use
`canonicalNumber`), hangar slot reservations (building↔unit references),
road classes (encoding shape change).

**R4. AI capability cliff.** The Classic AI is a carefully tuned
composition machine (`thinkProduction` counters, `BASE_MIX`,
`CONSTRUCTION_PRIORITY`, `canTrain` gating, naval probing). Every new
system the AI doesn't understand is a system the human exploits for
free: hangars (§5) it doesn't fill, carriers (§6) it sails empty,
logistics (§2) it doesn't feed, intel (§8) it doesn't see through.
`canTrain` auto-skips locked kinds, so new units are *safe* (AI ignores
them) but also *dead content* for single-player until each think
function learns them. Mitigation: every new unit/building ships with
its AI mix/priority entry in the same change (the roster-expansion
precedent), and AI-vs-AI soak tests measure that the AI actually uses
new systems before they're declared done.

**R5. validate-vs-apply divergence in reservation systems.** Hangar
slots (§5), carrier wing slots (§6), depot inventory (§2), and utility
network capacity (§1) are all **reservation** mechanics: validate
previews availability, apply commits it. If validate picks "lowest-id
airfield with room" but apply re-derives it after an earlier same-tick
command consumed the slot, the two disagree — and the queue's answer is
a loud `stale command` rejection (deterministic, but the UX is a
mysterious failure). Worse: if apply *doesn't* re-validate the same
predicate, two same-tick commands can double-book. Mitigation: the
existing pattern already handles this — validate at enqueue AND at
apply with the *identical* pure function (`hasProductionBuilding` is
the model), and write the reservation in apply only. For slots, make
the choice function (`findHangarSlot(world, owner, class)`) shared and
unit-tested for validate≡apply agreement under same-tick contention.

---

## Appendix: hook-point index (one line per system)

| # | System | Primary hooks |
|---|--------|---------------|
| 1 | Utility networks | `economy.ts: allocateUtilities`; `city.ts: BuildingDef/BuildingRecord/validatePlacement`; new `buildPowerLine`/`buildPipe` specs; `ai.ts: thinkConstruction` |
| 2 | Logistics | `units.ts: UnitDef/UnitRecord/spawnUnit`; `combat.ts: createCombatSystem` (ammo gate); `movement.ts` (fuel burn); new `resupply` command; `economy.ts: runProduction` (depots) |
| 3 | Veterancy | `units.ts: UnitRecord (xp/vetLevel)`; `combat.ts: damageMultiplier` + kill crediting; `digest.ts` unit encoding |
| 4 | New units/buildings | `units.ts: UNIT_DEFS`; `city.ts: BUILDING_DEFS`; `ages.ts: minAge`; `ai.ts: BASE_MIX/CONSTRUCTION_PRIORITY/thinkResearch`; `ui/palettes.ts` |
| 5 | Hangar gating | `city.ts: BuildingRecord (hangar slots)`; `units.ts: registerUnitCommands` validate/apply; `units.ts: UnitRecord.hangarBuildingId`; `combat.ts: killUnit` (release) |
| 6 | Carrier wings | `units.ts: UnitDef.carrierCapable/UnitRecord.embarkedOn`; new `embarkAircraft`/`launchAircraft`; `movement.ts` (ride carrier); `combat.ts: acquireTarget` (skip embarked) |
| 7 | Airport/port types | `city.ts: BuildingKind/BuildingDef.countsAs/isCoastal`; `units.ts: requiredBuildings` any-of; `economy.ts: runHarvest` (civilian income) |
| 8 | Intel/spies/recon | `ai.ts: getVisibleEnemies` (perception chokepoint); `units.ts: UnitDef.stealth/detectorRadius`; `combat.ts: acquireTarget`; `upgrades.ts: effectiveSight` |
| 9 | Transport variety | `city.ts: roads` → road classes; `pathfinding.ts: cellMoveCost`; new rail network + router; `units.ts` (bus/tram/ferry/train); `economy.ts: runHarvest` (transit income) |
| 10 | Airport zones | `city.ts: ZoneType.AIRPORT/paintZone/validatePlacement`; `PlayerState.taxRates` 4-tuple; `digest.ts` zones encoding |
| 11 | Peaceful mode | `ui/session.ts: SessionOptions/createSession/getSkirmishOutcome`; `World.peaceful`; validate gates in `units.ts`/`city.ts`/`upgrades.ts` |
| 12 | Migration | `snapshot.ts: decode*` defaults (step-7 precedent); digest additions per field; `digest(restore(take(w))) === digest(w)` gate; new named RNG streams |

*End of audit.*
