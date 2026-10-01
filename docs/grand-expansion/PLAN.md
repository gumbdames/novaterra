/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 */

/**
 * NOVATERRA — docs/grand-expansion/PLAN.md
 *
 * Master phased implementation plan for the grand expansion (utilities,
 * transport, airports/airline, naval, aircraft, logistics, intel,
 * veterancy, peaceful mode, tech levels). Version 0.1 Alpha.
 *
 * Grounding: RESEARCH.md (synthesis), research-utilities.md,
 * research-logistics-veterancy.md, research-transport-intel.md,
 * audit-sim.md (11 systems mapped to exact hooks), audit-render-ui.md,
 * content-inventory.md (28/28/12 roster + per-pillar gaps).
 * Every hook name below was verified against the source (2026-09-30);
 * nothing is invented.
 *
 * Rules of the road (repo AGENTS.md): the step gate applies to every
 * phase step — own tests green, full build green, regression of prior
 * steps re-run, docs updated, committed on main (always deployable).
 * Deterministic fixed-timestep sim; no Math.random; English-only UI
 * with the {en} localization indirection kept.
 */

# Grand Expansion — Master Plan

## 0. How to read this plan

- **Pillars** (§1) are the user's brief, turned into concrete rosters
  (§3) and systems (§4).
- **Phases** (§9) are independently deployable: each ends with `main`
  green, tests green, and a shippable build. Nothing merges untested.
- **Budgets** (§10) are hard: startup download ≤8 MiB, 60 fps on a
  mid-range laptop. Two binding constraints gate the roster growth:
  the draw-call ceiling and the download budget — both decided in
  Phase 0 before new keys are added.
- **Non-goals** (§13) are explicit: things the research says to avoid
  are listed so no one re-litigates them mid-implementation.

## 1. Scope — the pillars

1. **Utilities.** Power/water production across tech levels, buildable
   power lines and water pipes, zone-level hookup (a hooked-up zone
   serves every building in it), storage, map-edge import/export.
2. **Logistics.** Missile/fuel chains: production → specialization →
   transport → reload. Nuclear subs/carriers exempt.
3. **Veterancy (military).** Per-unit XP, tiers, visible chevrons,
   death erases. Civilian equivalent = building-level progression
   (experienced crews, leveled infrastructure) — NOT per-worker XP.
4. **Transport variety.** Road classes, rail, trams/buses/ferries,
   marinas. Civilian transport feeds a visible town-growth loop.
5. **Airports + airline.** Airport zones with capability-gated tiers,
   hangars per aircraft type, civilian/military/mixed airports,
   airline routes and cargo.
6. **Naval expansion.** Sub variants, more surface combatants,
   carriers as empty hulls with assigned air wings, logistics ships,
   civilian sea, port types.
7. **Aircraft expansion.** Strategic bomber, maritime patrol, UAV
   family, recon, gunship, tanker, carrier-capable variants.
8. **Intel.** Tech + named spies + recon feeding a deterministic
   asset economy; mixed-use discovery as a warned, counterable event.
9. **Peaceful mode.** No-military skirmish with civilian objectives.
10. **Tech levels.** Versions of everything (plant ladder, unit marks,
    building tiers) via research and ages.

## 2. Architecture decisions (the big calls — decided, not open)

**AD1. Utility connectivity = integer flood fill over conductor tiles**
(`economy.ts` `allocateUtilities` replacement). Roads conduct power
and water automatically; power lines and water pipes are drag-painted
long-hop links. Recompute on build/destroy only. Per-network supply
sums; consumers draw in fixed order (network id, distance from source,
entity id — fully ordered, no ties); demand counts only reached
buildings. Diagnosis split: `disconnected` vs `shortage` icons;
stranded generators flag themselves. No agent-based flow, ever.

**AD2. The global pool stays as fallback during the cutover.** A hard
connectivity requirement silently starves the AI (its virtual
buildings bypass placement) and breaks every balance test. The
flood-fill network is authoritative when lines exist; until the AI
learns line-building, unreached buildings fall back to the pool.
A hard-requirement game option comes later, never as the default.

**AD3. One abstract supply resource per carrier** (not a global
`ammo` stockpile). Supply trucks/ships hold generic supply points
(one float); per-weapon supply costs paid per shot; per-service
toggles (repair/rearm/refuel). Depot inventories live on
`BuildingRecord`. Automate the last mile: depots auto-load, vehicles
auto-shuttle, field units draw in radius. Out-of-supply degrades
(shared evenly), never hard-stops.

**AD4. Veterancy = per-unit `xp` + `vetLevel` on `UnitRecord`;**
crew-flavored bonuses (reload speed, sight, small damage efficiency;
auto-regen at max tier); XP weighted by target cost; maxed-unit XP
overflows to nearby allies; death erases. Civilian progression lives
on buildings (crew training levels, infrastructure tiers).

**AD5. Carriers = empty hulls + `embarkedOn` linkage.** Aircraft side
holds the reference (single source of truth); carrier keeps no list.
Embarked units skip movement/combat; carrier death destroys the wing
(simplest, deterministic). Only carrier-capable kinds embark.

**AD6. Hangars gate aircraft production.** `BuildingRecord` gets
optional hangar slot state; `registerUnitCommands` validate/apply
share one pure `findHangarSlot(world, owner, class)` (lowest-id
building with room) — validate≡apply agreement under same-tick
contention is unit-tested. `killUnit` releases the slot.

**AD7. Airport zones = new `ZoneType.AIRPORT = 3`.** Tier = modules
built inside (runway class → stands → hangars → fuel depot →
terminal/cargo). Runway class visibly gates plane class in the build
UI. `PlayerState.taxRates` becomes a 4-tuple (decode-time default —
see §11). Hangar capacity stays on buildings (§AD6), not on cells.

**AD8. Intel = deterministic asset economy per region**
(surveillance / operational / counter-intel). Spies are named
promotable units building networks over deterministic timers;
detection is a pure function of positions (no stored state, no
snapshot/digest impact); all perception flows through
`getVisibleEnemies()`.

**AD9. Snapshots: additive optional fields with neutral decode
defaults, no version bump.** v6→v7 ONLY for shape changes (road
classes: `roads: number[]` → `{cell, cls}[]`; tax-rate 4-tuple).
Digest covers every new behavior-affecting field; the gate is
`digest(restore(take(w))) === digest(w)`. New RNG streams are named
(`'logistics'`, `'intel'`, …); thinks draw nothing.

**AD10. One generic linear-network gesture pipeline.** Power lines,
pipes, and rail share the road tool's drag pattern (pointerdown →
accumulate cells → one order on pointerup) with the network kind as a
parameter — no copy-pasting `roadDragCells` three times.

**AD11. UI digest contract.** Every new panel digests its rendered
values in `ui/paletteDigest.ts` (the 2026-09-30 click-bug lesson).
A test asserts every hud panel branch is digest-covered.

**AD12. Roster growth is art-budgeted.** Tech-level variants share
one `MODEL_PATHS` key (Mk II reuses the Mk I GLB); infrastructure is
procedural-first; the vendored spares pool is mined before new
sourcing (`kenney-roads/` poles/wires/signs/bridges,
`kenney-watercraft/` cargo ships, `kenney-industrial/`
turbines/tanks). New CC0 only for hero entities with the full
license-evidence workflow.

## 3. Concrete rosters per pillar

Naming is English-only; icons + text labels always (icons.ts
compile-enforced). Balance numbers are Phase-1 engineering choices —
tune them, keep tests green.

### 3.1 Utilities (buildings; all new unless noted)

Power plants — `coalPlant` (cheap, strong, polluting), `gasPlant`
(mid), `windFarm` (weak, clean, intermittent on a seeded cycle),
`hydroDam` (terrain-gated: river/coast adjacency), `geothermalPlant`
(late, steady), `fusionPlant` (ascendance research, ultimate).
Existing `powerPlant` (oil burner), `solarFarm` (day-only), and
`nuclearPlant` (mighty, expensive, needs a water hookup — meltdowns only
when attacked, never at random; user correction 2026-09-30) stay.

Water — `waterWell` (cheap, low output), `waterPump` (exists),
`desalination` (exists; seawater-adjacent, needs power, 2× output),
`waterTower` (storage buffer), `waterTreatment` (system capacity +
scrubs one fouled source, needs power, no pipe adjacency required),
`reservoir` (large storage).

Network — `powerLine` (drag tool), `powerSubstation` (step-down onto
road grid), `waterPipe` (drag tool), `pumpingStation`, `batteryStation`
(power storage).

Unlock ladder (research via lab, `upgrades.ts`): wind/solar baseline →
`combustionTech` (coal/gas) → `advancedNuclear` → `fusionResearch`;
`groundwaterSurvey` (wells), `desalinationTech`, `gridStorage`
(batteries/towers). Cross-utility hooks: desalination and treatment
need power; nuclear needs water.

### 3.2 Logistics (buildings + units)

Buildings — `oilWell`/`oilRig` (crude extraction),
`munitionsFactory` (ammo/supply-point production),
`missilePlant` (specialization: heavy ordnance), `missileSilo`
(storage), `ordnanceDepot` (forward staging), `fuelDepot` (storage).
Upgrades: `advancedLogistics` (capacity/reload).

Units — `supplyTruck` (generic supply points, per-service toggles),
`fuelTruck`, `cargoTruck` (the `hauler` gains a real cargo role).
Ammo consumers get `ammoCapacity`/`ammoPerShot` (mlrs, missileBoat,
submarine, strategicBomber); mechanized units get
`fuelCapacity`/`fuelPerSecond`; `fuelType: 'nuclear'` on the
missile-sub and carrier (exempt). New command: `resupply`
(unit + depot); proximity refill aura like `runHarvest`.

### 3.3 Veterancy

No new units. New building: `militaryAcademy` (new units start at
Veteran; station max-tier veterans as trainers to accelerate a
garrison's XP). Record fields: `xp`, `vetLevel` (0–3). Tiers:
Trained → Hardened → Veteran → Elite; effects per level: −8% cooldown,
+8% sight, +10% damage efficiency; Elite: +1 HP/s auto-regen and
overflow XP sharing to nearby allies. Chevrons on the unit view.
Death erases. Civilian building progression: `crewTraining` levels on
production buildings (productivity +, flavorful tradeoff), depot/port
infrastructure tiers (capacity, loading speed, service radius).

### 3.4 Transport variety

Road classes (data, not entities): `dirt` → `country` → `paved` →
`highway` — per-class cost and speed cap in `cellMoveCost`,
upgradeable in place; `bridges`/`tunnels` as later tools.
Rail: `rails` network layer + `buildRail` order; `railStation`;
`passengerTrain`, `freightTrain`; track classes
standard → electric → high-speed gate train quality.
Urban transit: `bus`, `tram` (slow, huge capacity, street-running),
`busDepot`. Water: `ferry` + `ferryTerminal` (cheap crossings),
`marina` (civilian docks, coastal). Civilian income via
`runHarvest`-style "on-network" earnings feeding the zone-growth
demand loop.

### 3.5 Airports + airline

Zone: `ZoneType.AIRPORT`. Buildings: `civilAirport`, `militaryAirbase`
(existing `airfield` stays as the military production building),
`mixedAirport`, `passengerTerminal`, `cargoTerminal`, `controlTower`,
`hangarS`/`hangarM`/`hangarL` (per aircraft class — §AD6),
`fuelFarm`, `maintenanceHangar`, `runway` modules per class.
Civilian aircraft: `airliner`, `jumboAirliner`, `regionalJet`,
`cargoPlane`, `passengerHeli`, `seaplane`. Airline management:
routes between civil airports with static ticket/cargo income first
(the `market` precedent); schedules and pricing later only if the
static game proves fun.

### 3.6 Naval expansion

Units — `coastalSub` (small), `missileSub` (large, nuclear-exempt),
`corvette`, `cruiser`, `battleship` (heavy), `heavyDestroyer`
(second destroyer class, different role), `cargoFreighter`,
`fuelTanker`, `ammoShip`, `repairShip`, `minelayer` (+ deployable
`navalMine`), `coastGuardCutter`, `cruiseLiner`, `yacht`.
Carrier: existing `carrier` becomes the empty hull; wing via §AD5.
Buildings — `commercialPort`, `containerPort`, `fishingHarbor`,
`navalBase` (military port distinct from the `navalYard` production
building), `marina` (also §3.4). Existing `shipyard`/`navalYard` stay.

### 3.7 Aircraft expansion

`strategicBomber` (long-range heavy strike), `maritimePatrol`
(anti-sub from the air, pairs with `sonarSuite`), `reconUAV`,
`armedUAV`, `reconPlane` (photo/signals), `gunship` (heavy close air
support), `tanker` (extends range — feeds the logistics range game),
`militaryCargo`, `trainer`, `navalFighter` (carrier-capable).
Existing fighter/fighterBomber/attackHeli/drone/awacs/transport stay.

### 3.8 Intel

Buildings — `intelHQ`, `listeningPost`, `satelliteUplink`,
`signalsStation` (economy/sight/detection outputs). Units — `spy`
(stealth, infiltrate/sabotage/steal), `reconTeam`. Upgrades —
`signalsIntel`, `counterIntel` (detection radius, sabotage
resistance). `BuildingRecord.sabotagedUntil` tick (plain number,
snapshotted/digested). New Intel panel UI (digested per §AD11).

### 3.9 Peaceful mode + tech levels

**Status (workstreams A + B + C + D + E, 2026-09-30):** DONE — workstream A (sim
core) merged: `world.peaceful` (tick 0, never toggled; snapshotted,
digested, defaults false) + `SessionOptions.peaceful`; the def-level
`military?: boolean` predicate on all 96 units / 99 buildings / 21
upgrades (classification pinned in `tests/sim.peaceful.test.ts`); loud
lockout in `spawnUnit` / `placeBuilding` / `researchUpgrade` / the
three covert-op validates / `constructSuperweaponFacility` /
`fireStorm` / `fireAegis`; conquest checks bypassed;
`peacefulStatus` (population + treasury health — peaceful mode is
endless since 2026-10-01, no victory condition; 28+ sim tests,
1976/1976 green at merge). The AI
rival KEEPS PLAYING in peaceful games
(rejected military orders are swallowed) — this overrides the old "no
AI rival" line. Workstream B (UI panel) complete: skirmish-setup
peaceful toggle → `main.ts` → `GameOptions.peaceful` →
`SessionOptions.peaceful`; hidden Military tab; Management tab's live
objectives section (population / treasury / rival); peaceful
victory/defeat end screens via `EndScreen` copy overrides — the rival
winning the race first IS a peaceful defeat (same-tick ties go to the
player; this overrides the sim-side "never lost" note, which the
workstream A owner should reconcile); palette availability lockout
with "Not available in peaceful mode" reasons; covert-op buttons
replaced by a note; `po:` digest segment; 23 UI tests
(`tests/ui.peaceful.test.ts`), all green. Workstream C (peaceful AI)
complete: `canTrain` gates military defs in peaceful worlds;
`thinkIntel`/`thinkSuperweapons` early-return; `thinkPeaceful` builds
a civilian city (compact districts → waterPump+powerPlant → two
factories → houses at funds ≥ 500 → civic when rich at 2000), zero
military orders, zero rejections; no new AI state, no RNG, no
snapshot/digest changes; `createAISystem(queue, terrain?)` —
`ui/session.ts:381` passes the session terrain. 5 unit tests
(`tests/sim.ai-peaceful.test.ts`) + 3 soak tests
(`tests/sim.ai-peaceful-soak.test.ts`: marshal-vs-marshal 3600-tick
soak, both cities grow 6–18 pop, zero military, zero rejections,
same-seed digest-identical, save/load stable). The armed scout
`drone` is military (gated); the peaceful AI has no scouts and needs
none. Workstream E (civilian
deep-dive) complete: 10 new civilian buildings (museum, theater,
sports stadium, botanical garden, grand market, bank, office tower,
clinic, medicalCenter, fire station — all `military: false`, 99
building defs) + 5 city ordinances (green/transit/business/nightlife/
education — real upkeep, funded after buildings in POLICY_IDS order,
per-owner desirability model); `setPolicy` command seam for the AI
workstream; `oc:` UI digest segment; no new render model keys (AD12).
Workstream D (tech levels) complete: 28 Mk II/Mk III variant defs across
14 unit lines (tanks, artillery, AA, APCs, haulers / fighters,
fighter-bombers, attack helis, gunships / destroyers, frigates,
submarines, missile boats, transport ships) — gated by the existing
spawnUnit validator (minAge one/two ages above base, same
requiredBuilding); `game/src/sim/variants.ts` pure helpers
(`isVariantUnlocked`, `preferHighestVariant` — the AI trains the best
tier it has unlocked and can afford; 24 military variants lock out in
peaceful mode, the 4 civilian hauler/transportShip variants are the
peaceful tech path); §AD12 art sharing (zero new MODEL_PATHS keys);
44 tests in `game/tests/sim.variants.test.ts`, all green.
Remaining: the UI workstream's TRAIN_TABS /
`STRINGS.unitNames` integration for the 28 variants, and the palettes
workstream's BUILD_TABS integration for the 10 new buildings
(open handoffs — see docs/research/phase8-civilian-peaceful.md §§D.4, E.7).

Peaceful: `world.peaceful` flag (tick 0, never toggled mid-game;
snapshotted, digested, defaults false) + `SessionOptions.peaceful`;
military lockout in `registerUnitCommands`/`placeBuilding`/
`researchUpgrade` via a def-level `military: boolean` predicate;
the AI rival stays and plays peacefully (its military orders are
rejected at the command layer and swallowed); victory
checks bypassed; peaceful objectives = population / influence /
scenario goals (UI/campaign work, not sim).
Tech levels: Mk II/III variants as distinct `UnitKind`s sharing art
(§AD12) gated by `minAge` + `requiredBuilding`; plant ladder §3.1;
building tiers via upgrades (`upgrades.ts` patterns).

## 4. New sim systems — data, commands, hooks

### S1. Utility networks
- Data: per-player conductor cell sets (roads + powerLine cells +
  pipe cells; sorted-array discipline like `roads`), flood-fill
  network ids per zone cell (derived, recomputed on structural
  change), per-network supply/stock integers.
- Commands: `buildPowerLine`/`buildPipe` (`CommandSpec`s, cell arrays
  ≤512, per-cell cost, `sortedInsert`), demolish extended cell-wise.
- Hooks: `economy.ts: allocateUtilities` (rewritten per AD1/AD2),
  `city.ts: BuildingDef/BuildingRecord/validatePlacement`
  (`powered`/`watered` flags already exist — keep names),
  `economy.ts: runGrowth/growthDesirability` (unchanged signature),
  `ai.ts: thinkConstruction` (AI line-building phase).
- Determinism: integer BFS in id order; `canonicalizeWorld` includes
  line/pipe cells sorted; unfunded plants drop out before the flood.

### S2. Logistics
- Data: `UnitDef`: optional `fuelCapacity`, `fuelPerSecond`,
  `ammoCapacity`, `ammoPerShot`, `fuelType: 'fossil'|'nuclear'|'none'`;
  `UnitRecord`: `fuel`, `ammo` (snapshotted, digested via
  `canonicalNumber`); depot inventories on `BuildingRecord`.
- Commands: `resupply` (unit + depot); supply aura auto-refill in
  `runHarvest` order.
- Hooks: `combat.ts: createCombatSystem` (ammo gate before
  `fireWeapon` — out of ammo holds like an unarmed unit);
  `movement.ts` (fuel burn; fuel 0 → loud `failUnitOrder`, never
  silent); `economy.ts: runProduction` (depot/refinery chains);
  `units.ts: spawnUnit` (full tanks on spawn).
- Import discipline: logistics hooks in combat read plain world data
  only (the `world.superweapons` precedent) — no combat→economy import.

### S3. Veterancy
- Data: `UnitRecord.xp`, `vetLevel` (decode default 0; digest-covered).
- Hooks: `combat.ts: killUnit` (credit killer before removal, id
  order), `damageMultiplier` (level bonus), `applyHealAuras` cap +
  a new pure `vetAdjustedMaxHp(unit)` helper (vet HP applies to
  *living* units — `effectiveMaxHp` is spawn-only today).
- `militaryAcademy` building: `spawnUnit` reads stationed trainers.

### S4. Hangars + carriers
- Data: `BuildingRecord.hangars` (optional; legacy airfield decodes to
  N generic slots — **document the exact default, pin in test**);
  `UnitRecord.hangarBuildingId`, `UnitRecord.embarkedOn` (0 = none;
  digest-covered); def flags `hangarClass`, `carrierCapable`,
  `wingCapacity`.
- Commands: `embarkAircraft`/`launchAircraft` (same owner,
  carrier-capable, free slot, in-range); hangar reservation inside
  `registerUnitCommands` via shared `findHangarSlot`.
- Hooks: `movement.ts` (skip embarked units; sync position = carrier's
  in id order, before combat); `combat.ts: acquireTarget` (skip
  embarked); `killUnit` (release hangar slot; destroy wing with
  carrier).

### S5. Airport/port types
- Data: `BuildingDef.airportType/portType:
  'civilian'|'military'|'mixed'`; `countsAs: BuildingKind[]` so mixed
  sites satisfy any-of production gates without changing
  `hasProductionBuilding(world, owner, kind)`'s signature.
- Civilian income via `runHarvest` (`fishingBoat` precedent).

### S6. Intel
- Data: per-region asset counters on player state (surveillance /
  operational / counter-intel; plain numbers, digested); spy network
  progress (deterministic timers); `sabotagedUntil` on buildings.
- Commands: `infiltrateBuilding`, `sabotage` (adjacency-validated;
  research transfer via `addStock`).
- Hooks: `ai.ts: getVisibleEnemies` (radar/listening-post building
  sight term — think cadence only, never per-tick combat);
  `combat.ts: acquireTarget` (stealthed unless detected);
  `upgrades.ts: effectiveSight` (intel tech).
- Detection: pure function of positions — zero snapshot/digest cost.
- Status (2026-09-30): sim core DONE — `sim/intel.ts` (accrual, the
  stealth contract, `infiltrateBuilding`/`sabotage`/`stealTech`,
  `intel-<owner>` RNG streams), the `acquireTarget` +
  `getVisibleEnemies` + `effectiveSight` hooks, the sabotage offline
  gate in `economy.ts`, `createIntelSystem` + `registerIntelCommands`
  wired in `ui/session.ts`, 30 tests in `tests/sim.intel.test.ts`.
  Roster defs (spy/reconTeam, 4 intel buildings, signalsIntel/
  counterIntel) in place. Art mappings DONE (Phase 6 workstream 5):
  all 6 kinds → vendored CC0 (`spy` = civilian-man lookalike,
  `reconTeam` = suv, `intelHQ` = office block + hqAntenna, `listeningPost`
  = hut + roof dish, `satelliteUplink` = detailed dish, `signalsStation` =
  shed + new procedural signalMast), all lazy, ~0.58 MiB, 0 boot impact.
  Remaining for the phase: mixed-use discovery (warning + grace
  period) and AI intel play (spends operational on sabotage, steals
  tech). The intel panel UI is DONE (2026-09-30, 0.1 Alpha):
  `game/src/ui/intel.ts` contract module + the Intelligence panel in
  the Management tab + the three covert-op order builders with the
  sim's exact payloads, 29 tests in `tests/ui.intel.test.ts` and
  `docs/HOW_TO_PLAY.md` player docs.

### S7. Transport networks
- Data: `roads` → `RoadCell[]` `{cell, cls}` sorted by cell
  (**shape change — v6→v7 migration**); `rails: number[]` sorted set +
  dedicated 1-D rail router (BFS over the rail set between stations —
  do NOT bend the flow-field A*); ferry `route: {a, b}` on unit
  records (loop advanced in the movement system, id order).
- `cellMoveCost` becomes a per-class table; `buildRoad` takes a class
  payload; `buildRail` mirrors `buildRoad`.
- Civilian earnings: `runHarvest` with an on-network check (pure
  function of position).

### S8. Airport zones
- `ZoneType.AIRPORT = 3`; `paintZone` validation extended;
  `validatePlacement` requires airport zone for airport buildings;
  `tryAutoDevelop` never auto-builds on airport zones (player-placed
  infrastructure only). Tax-rate 4-tuple decode default.

### S9. Peaceful mode
- `world.peaceful` + `SessionOptions.peaceful`; validate gates;
  victory/defeat bypass. No AI work (no rival).

## 5. UI/UX plan

- **Palettes:** new tabs as rosters grow (split naval/air; add
  logistics/intel tabs) — the 6-tab BUILD grouping will not survive
  60+ buildings unchanged. Entries stay data-only; availability
  grey-out follows defs automatically.
- **New panels (all digest-covered per §AD11):** utility overlay
  (coverage + disconnected/shortage icons + night-lamp feedback),
  logistics overlay (depot stocks, supply ranges), airline management,
  intel panel (operatives, networks, assets), veterancy display
  (chevrons + XP bar), peaceful objectives panel. Follow the
  research-panel precedent (`hud.ts` appendResearch pattern).
- **New tools:** power-line, pipe, rail drag tools via the generic
  gesture pipeline (§AD10); airport zone paint tool; all with
  icon+text buttons.
- **Class rules are shown before purchase:** plane↔runway class,
  ship↔port size, train↔track class — visible in build UI, never
  hidden (research: hidden punishing rules are a documented fun-killer).
- **Overlays** are render views of sim data (the superweapon-FX
  precedent: sim-published records → per-frame read-only views),
  never sim state in the UI.
- **Strings:** English-only via `ui/strings.ts` `{en}` indirection;
  icons for every new kind (compile-enforced).

## 6. AI integration (per phase, no cliff)

Rule: every new unit/building ships with its AI mix/priority entry in
the same change (the roster-expansion precedent). `canTrain`
auto-skips locked kinds, so new content is *safe* but *dead* until
each think function learns it — AI-vs-AI soak tests must show the AI
actually using new systems before a phase is declared done.

- **Veterancy:** no AI changes needed (XP accrues from combat the AI
  already does); later: AI protects Elite units (retreat threshold).
- **Utilities:** AI builds lines/pipes to connect stranded plants
  (new `thinkConstruction` sub-phase); virtual buildings get virtual
  connectivity (or stay on the pool fallback — §AD2).
- **Logistics:** AI builds depots near fronts, trains supply trucks
  per combat-unit ratio, retreats ammo-dry missile units.
- **Hangars/carriers:** `canTrain` becomes hangar-aware; virtual
  airfields get virtual capacity; AI fills carrier wings before
  sailing (never sails empty into combat).
- **Intel:** AI assigns spies to regions, spends operational assets on
  sabotage vs. the human's plants, surges counter-intel when warned.
- **Transport/airline/peaceful:** civilian AI trader rival is a later
  feature; peaceful mode has no rival (nothing to change).
- Soak metric per phase: AI-vs-AI games at marshal level must show
  non-zero usage of the phase's headline system (hangar fills,
  embarked wings, depot stocks drawn, spy networks active).

## 7. Tech progression

Five ages stay (foundation → connectivity → industry → information →
ascendance); new content gates via `minAge` (verified:
`isUnitAvailableForAge`, `isBuildingAgeMet`). A 6th age is allowed
but not required — prefer depth within ages first. Research
(`upgrades.ts`, lab-gated) carries the plant ladder, logistics,
intel, and carrier-ops unlocks (§3.1, §3.8). Tech-level variants
(Mk II/III) share art and gate on age + production building — the
existing gates already express "better version unlocks later"; no
per-unit tech-level record field.

## 8. Peaceful mode

`world.peaceful` (§4 S9). Skirmish setup gains a Peaceful toggle; the
setup screen already scrolls (2026-09-30 fix). Military production
buildings/units/upgrades are rejected with human-readable reasons
(the `placement.ts` resolver pattern — nothing fails silently).
Peaceful objectives (population, influence, scenario goals) are
UI/campaign work. Intel races and airline/economic competition give
peaceful mode its conflict (RESEARCH.md §1).

## 9. Phases (independently deployable)

Each phase: **Goal → Contents → Deployable when → Tests → Budget
delta → AI work.** Step gate (§0) applies to every step inside.

### Phase 0 — Binding-constraint decisions (no new entities)
- **Goal:** de-risk the two budget ceilings and the gesture pipeline
  BEFORE any roster growth.
- **Contents:** (a) benchmark entity views (`?bench=1`); decide:
  instancing path for entity views vs. visible-entity caps vs. far-
  field impostors — prototype, measure, record in
  docs/research/tech-stack.md; (b) decide the download mechanism:
  per-tab/per-age lazy loading and/or gltf-transform optimize
  (meshopt) — record the choice; (c) generalize the linear-network
  gesture pipeline (§AD10); (d) add the panel-digest coverage test
  (§AD11).
- **Deployable when:** decisions recorded, prototype measured, tests
  green. No player-visible change required (pipeline refactor only).
- **Tests:** existing suite + new digest-coverage test + gesture-
  pipeline unit tests.
- **Budget delta:** 0 keys.
- **AI work:** none.
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** All four contents
  delivered and measured:
  - (a) Draw-call ceiling → **per-kind instancing** (rejected: view
    caps, far-field impostors). Measured headless driving the real
    `EntityRenderer` + real GLBs: legacy ≈ 6 draws/view linear (562
    draws at 100 views, 2.8× over budget) vs instanced flat 80–84
    draws at 25–400 views, triangles unchanged. One `InstancedMesh`
    per (model pool key × material) + one instanced layer each for
    team stripes, pennants, health bars. Opt-in
    `EntityRenderer { instanced: true }`; construction keeps the
    legacy fade, converts on completion. Recorded in
    docs/research/tech-stack.md §3.
  - (b) Download budget → **lazy per-key loading** (rejected:
    meshopt — optimistic 50% still left ~3.2 MiB > 2.5 MiB headroom).
    58 keys = 4.62 MiB; boot set pinned at 28 keys ≈ 2.60 MiB, so
    startup ≈ 3.46 MiB of the 8 MiB gate; 30 keys (~2.02 MiB)
    deferred to first use, Cache-API offline support, and views
    created mid-load upgrade in place when the GLB arrives
    (`isDegradedResolution` + `maybeUpgradeUnitView` /
    `maybeUpgradeBuildingView`). Recorded in
    docs/research/lazy-models.md.
  - (c) AD10: generic linear-network gesture pipeline
    (`game/src/ui/linearNetworkDrag.ts`; road tool rewired, with
    8-connected gap-filling the old road code lacked).
  - (d) AD11: `HUD_PANEL_BRANCHES` registry + digest coverage test
    (3 structural tripwires; also fixed a real gap — building
    digest omitted owner — and the same stale-panel bug class in
    the advisor panel).
- **Budget delta:** 0 keys. Zero new units/buildings — enforced.

### Phase 1 — Veterancy + military academy (S–M)
- **Goal:** first player-visible expansion win; exercises the
  snapshot/digest/checklist machinery the later phases need.
- **Contents:** `UnitRecord.xp/vetLevel`, kill crediting,
  `vetAdjustedMaxHp`, chevron views, `militaryAcademy` building,
  civilian building-level progression (crew training levels,
  depot/port tiers).
- **Deployable when:** units visibly gain chevrons in combat; death
  erases; academy produces Veteran units; digest round-trips.
- **Tests:** XP award order, level thresholds, overflow sharing,
  kill-releases, academy gating, save/load round-trip with vet
  fields, AI-vs-AI soak (XP accrues, no crashes).
- **Budget delta:** +1 building key (~80 KB).
- **AI work:** none required (later: Elite retreat threshold).
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** Shipped on `main`
  (`5611673`, `8c59f03`, `ba5db2a`) and live on GitHub Pages. Workstream Z
  (zone overlay, education ladder, zone-tool clarity) landed alongside it
  (`55dab62`). Full suite 1011/1011 green at sign-off. Delivered in `game/src/sim/`:
  - New pure module `veterancy.ts`: `VET_MAX_LEVEL = 3`, thresholds
    200/500/1000, ranks Recruit/Regular/Veteran/Elite,
    `xpForKillValue = trainFunds + trainMaterials`, `awardKillXp`
    (id-ordered, deterministic overflow: floor shares by id, remainder
    to lowest ids, lost with no allies), and the bonus helpers
    (damage ×(1+0.10L), sight ×(1+0.10L), cooldown ×(1−0.10L) min 1
    tick, maxHp ×(1+0.15·max(0,L−1)), Elite +2 hp/s regen).
  - `units.ts`: `UnitRecord.xp/vetLevel`; `spawnUnit` graduates armed
    units to Regular (200 XP) with a completed Military Academy.
  - `combat.ts`: kill crediting before `killUnit` removal (id order
    kept), vet damage/cooldown in `damageMultiplier`/`fireWeapon`,
    vet-aware heal cap, Elite regen.
  - `ai.ts`: `getVisibleEnemies` multiplies the unit's own sight by the
    vet bonus (Signals Grid bonus stays flat).
  - `city.ts`: `militaryAcademy` building def (Industrial 3×3,
    600/200, 30s, upkeep 0.8, power 2, water 1, requires completed
    barracks, foundation) + new optional `BuildingDef.requiredBuilding`
    enforced in `placeBuilding` validation and auto-growth.
  - `snapshot.ts`/`digest.ts`: vet fields covered; legacy v6 decodes to
    0 (no version bump, stays v6).
  - Civilian pillar: no new fields — buildings already level 1→3 at
    +25% output/level (`economy.ts` `runLevels`/`levelMult`); documented
    in `docs/GAME_MECHANICS.md`.
  - Tests: `game/tests/sim.veterancy.test.ts` (29 tests: thresholds,
    kill awards, id-order crediting, overflow splits, death erases,
    academy gating, snapshot/digest round-trips, determinism). Full
    suite: sim lane green; `sim.roster-expansion` building count
    updated 28→29.
  - Note: the "academy produces Veteran units" line above meant
    "promoted above Recruit" loosely — the locked rule is Regular
    (200 XP / level 1), per the coordinator's numbers.

### Workstream Z — Zone overlay + education + zone-tool clarity (2026-09-30, 0.1 Alpha)
- **Goal:** make zoning visible on the map, give education its own
  ladder and tab, and make the zone tools self-explanatory.
- **Contents:**
  - **Zone overlay (render only):** translucent green/blue/orange
    ground decals per zone type (0.28 opacity, classic colors), draped
    on the terrain per corner via `heightAt` (+0.05 offset, under the
    road ribbons), one merged mesh (1 draw call), rebuilt only when the
    FNV zone digest changes. Owned by `EntityRenderer`
    (`game/src/render/zoneOverlay.ts`); visible by default.
  - **Education ladder:** new `kindergarten` (150/50, 12s, research
    0.1/s) and `college` (400/120, 30s, research 0.5/s) buildings;
    `school` moved RESIDENTIAL→UTILITY_ZONE (research stays 0.25/s),
    `university` moved COMMERCIAL→UTILITY_ZONE (research stays 1.0/s);
    the hospital is untouched. New **Civic** build tab holds the four
    (hospital stays in Commerce). Each completed kindergarten/school
    gives its owner +0.05 residential growth desirability, additive,
    capped at +0.25 (`educationGrowthBonus` in `city.ts`).
  - **Zone tools obvious:** palette labels are now "Zone: Homes" /
    "Zone: Shops" / "Zone: Industry", grouped under a static "Zoning"
    section header in the tools row.
- **Budget delta:** +2 building keys (~240 KB measured: kindergarten
  142 KB + college 97 KB; both foundation-age, in the boot set — 61
  keys / 4.56 MiB total, boot set 31 keys ≈ 2.77 MiB).
- **Tests:** `render.zoneOverlay` (digest/geometry/overlay, 13),
  `sim.education` (ladder/bonus/cap/zone moves/seeded growth-pulse
  integration, 11), `ui.zoning` (labels/header, 2); pinned counts
  updated (31 buildings, 61 MODEL_PATHS keys, 31 boot keys, civic tab
  grouping). Player docs: education section in
  `docs/GAME_MECHANICS.md`.

### Phase 2 — Utility networks (XL)
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** Shipped on `main`
  (`75e9c28`, `355fd0c`, `4c266d7`, `721363d`) and live on GitHub Pages.
  Full suite 1148/1148 green at sign-off.
- **Goal:** flood-fill connectivity, lines/pipes, plant ladder,
  storage, zone servicing, map-edge trade.
- **Contents:** S1 (§4) + §3.1 roster + utility overlay UI +
  disconnected/shortage icons + research ladder for plants.
- **Deployable when:** a player can power a far zone via lines OR
  roads; brownouts are local and diagnosable; AI connects its own
  stranded plants (or stays on the pool fallback per §AD2 —
  explicitly tested either way).
- **Tests:** flood-fill determinism (order independence), per-network
  allocation, stranded-generator flagging, storage smoothing,
  meltdown seeded reproducibility, save/load with network state,
  legacy saves load (decode defaults).
- **Budget delta:** ~12 building keys (~1 MB) + 2 drag tools.
- **AI work:** `thinkConstruction` line-building; virtual-building
  connectivity handling.
  - **AI verdict (2026-09-30, 0.1 Alpha — AD2 fallback holds):** the
    Classic AI owns no physical buildings (all production buildings
    are virtual, no footprint), so a stranded plant cannot arise for
    it and there is no line order to issue. `thinkUtilityConnections`
    (ai.ts) is the documented no-op hook for a future
    physical-builder; virtual buildings stay on the global pool
    fallback per §AD2. Pinned by
    `game/tests/sim.ai-utilities.test.ts` (pool-fallback regression,
    owner-blind allocation, no-RNG sub-phase, determinism, save/load)
    and `game/tests/sim.ai-soak.test.ts` (AI-vs-AI long-run soak;
    network-mixed scenarios as real tests since 2026-09-30: stranded
    line-connection, disconnected-vs-shortage diagnosis, bounded
    map-edge export, storage-stock save/load reset). The sim
    workstream's network model
    (`utilityNetworks.ts`, uncommitted 2026-09-30) confirms the design:
    `UtilitySideModel.unreached` buildings are served by the legacy
    pool allocator verbatim; the extension hook names
    `getUtilityModel` / `plantNetwork` / `unreached` (verified against
    source, re-verify before wiring).
  - **Sim verdict (2026-09-30, 0.1 Alpha):** the network model is
    implemented and green: `utilityNetworks.ts` (integer-BFS flood
    fill, per-player/per-utility), `economy.ts allocateUtilities`
    rewritten (per-network allocation, storage, map-edge auto-sell,
    AD2 pool fallback), 13 plant kinds + 6 research upgrades,
    `buildPowerLine`/`buildPipe` commands, hydro-dam coastal rule,
    fouling/treatment, meltdowns, solar/wind. 43 new tests green
    (`sim.utility-networks`, `sim.utility-plants`); flood fill runs
    8.5 ms/economy-tick at 600 buildings. Two implementation
    refinements: (1) a `consider` first-candidate bug meant nothing
    was ever marked reached — caught by tests, fixed; (2) new
    buildings start `powered`/`watered` = true (1-tick bootstrap) so
    the cross-utility hooks (nuclear needs water, desalination needs
    power) can prime on a fresh grid; (3) user correction 2026-09-30,
    landed alongside Phase 3: meltdowns are ATTACK-TRIGGERED ONLY — the
    per-tick seeded random trigger was removed. A Storm Engine strike on
    a nuclear plant rolls a seeded 1/20 (1/80 with Advanced Nuclear); a
    hit takes the plant offline for 180 s (`meltdownUntilTick`,
    snapshot/digest-safe). When unit-vs-building combat lands, it must
    call `attackMeltdownRoll` from its building-damage path too.
  - **Render/UI verdict (2026-09-30, 0.1 Alpha):** shipped and verified
    against the landed sim contract — 13 procedural building models
    (`render/proceduralModels.ts`), Power/Water build tabs
    (`BUILD_TABS`, 9 tabs / 44 buildings), drag-paint power-line /
    water-pipe tools (`linearNetworkDrag.ts`, `orders.ts`
    `buildPowerLineOrder`/`buildWaterPipeOrder`), palette entries with
    icons (`icons.ts` `buildingIcon`), selection-panel power/water
    diagnosis lines (`bu:` digest segment), always-on line/pipe meshes
    (`render/networks.ts`), and the toggle-able diagnosis overlay
    (served/fouled tints + disconnected/shortage/stranded/fouled
    markers, `render/utilityOverlay.ts`). The 6 research upgrades sit
    in a new Infrastructure research group. Verified in-game in real
    Chromium (menu → skirmish → Power/Water tabs render with costs,
    tools row + Utilities toggle present, 0 JS errors). Deferred:
    per-building fouled-source flags (the sim tracks fouled sources
    per tick in the transient `UtilityModel.fouledSources` but exposes
    no per-building flag — purple markers stay dark until the sim
    exposes one; recommended sim follow-up) and night lamps (no
    day/night cycle in the game — wiring `daylightFactor(tick)` needs
    a full lighting-rig change).
  - **Coordinator verification (2026-09-30, 0.1 Alpha):** Phase 2
    complete. Full suite **1148/1148 green** (79 files), `tsc`
    clean, `npm run build` clean with license stamps. Coordinator
    fixes on top of the three workstreams: (1) `sim.roster-expansion`
    count pins updated for the deliberate roster growth (31 → 44
    buildings, 12 → 18 upgrades); (2) a demand-zero flag gap in the
    rewritten allocator (funded demand-zero buildings in no network
    never had `powered`/`watered` set — previously only the 1-tick
    bootstrap made it true; now set explicitly per the legacy
    semantics); (3) the 4 skipped network-mixed AI-soak scenarios
    implemented as real tests against the landed sim API. Perf:
    flood fill 8.5 ms/economy-tick at 600 buildings (sim workstream),
    pool baseline 3.17 ms. Commits: `75e9c28` (AI), `355fd0c`
    (sim), `4c266d7` (render/UI) + coordinator verification —
    all local, not pushed.

### Phase 3 — Logistics chains (L; XL only if physical road/rail freight)
- **Status: COMPLETE (2026-09-30, 0.1 Alpha)** — 4 logistics workstreams
  + M + delegation/superweapons/accessibility all landed and green:
  `29db01a` (sim core: fuel/ammo defs, burn, ammo gate, degradation),
  `8b44d54` (production/depots/refill aura), `dd5e1ee`+`f6ac0dc`
  (resupply command + logistics AI), `a564c24` (render/UI: overlay,
  palettes, HUD, truck models), `e1a401c` (M: attack-triggered
  meltdowns). Gate: full suite 1283/1286 (3 perf-budget p95 failures
  proven environmental — Phase 2 baseline 5/5, current HEAD 5/5 ×2,
  failures move between runs), tsc clean, build clean + license stamps.
  Queued follow-ups (separate briefs, not Phase 3 scope): V (camera
  controls), P (ambient city life). X (menu demo director) LANDED
  2026-09-30 (0.1 Alpha) — see "Workstream X — Living menu demo" below.
  Y (3-tab menu)
  LANDED 2026-09-30 (0.1 Alpha): bottom-left menu is Civilian /
  Military / Management tabs — Civilian owns the tools row + the 7
  civilian build tabs, Military owns the train palette + orders hints +
  the 3 military build tabs + superweapons, Management owns tax
  steppers (new UI over the existing setTaxRate order) + city focus +
  cabinet status + research; every pre-existing control kept a home
  (pinned by game/tests/ui.menuTabs.test.ts), digest gained mt:/tx:/ms:/
  mg: segments, full suite green, tsc/build clean. Final-review R5 feel
  (2026-10-01, 0.1 Alpha): `emergencyRefuel` command + selection-panel
  button for stranded fossil-fuel aircraft (150 funds, +30% tank,
  AD6 validate≡apply, `er:` digest segment), duplicate-coalescing toast
  queue, the Storm tool firing at the drag-release point, and the
  Marshal AI firing its Storm at the largest visible enemy cluster
  instead of the all-visible centroid.
  Sea-logistics Half A — civilian sea trade (2026-10-01,
  0.1 Alpha, merged to main; naval-building model, 2026-10-01): the
  **Civilian Shipyard** (the old Commercial Harbor, renamed —
  non-military, coastal, peaceful-legal; builds AND repairs civilian
  ships: cargoFreighter, the new fuel barge; reloads ships, stores
  300 fuel) and the civilian **trade docks** (Commercial Docks,
  Container Port, Fishing Harbor — `tradeDock: true`), **sea-trade
  routes** mirroring the airline system (`sim/seaTrade.ts` leaf module
  — avoids the ai→economy→city→world→ai eval cycle;
  `establishSeaRoute` / `cancelSeaRoute`, own-docks-only routes — the
  no-blur rule rejects shipyard endpoints loudly; pre-flag shipyard
  routes grandfathered, funds / materials / fuel policies), physical
  resource hauling (fuel + materials loaded at the origin dock,
  sold/unloaded at the destination), AI funds-policy routes (peaceful
  AI builds one shipyard + two docks and establishes a funds route on
  its own), atlas regenerated to 197 kinds (byte-deterministic,
  <400 KB),
  AI soak test green; snapshot stays v8 (AD9 additive fields).
  Sea-logistics Half B — military naval logistics (2026-10-01,
  0.1 Alpha, merged to main): the naval supply chain the docs
  had promised — def-driven cargo loading (fuelTanker 400+200 and
  ammoShip 80+100 materials holds; land trucks through the same leg),
  `runMobileSupply` same-domain discharge honoring refuel/rearm
  toggles with the nuclear exemption, navalBase forward fuel pull +
  200-materials cache, `loadCargo`/`unloadCargo` (AD6 validate≡apply,
  peaceful-mode rejection), marshal `thinkNavalSupply` (1 fuelTanker /
  6 sea combat units, virtual-stock loading, fleet rally), 32 new
  tests; snapshot stays v8 (AD9 additive fields).
  W (desirability/land value/migration, library + park) LANDED
  2026-09-30 (0.1 Alpha): derived per-residential-cell 0–100 model
  (elevation/water/pollution/amenities), land-value tax tiers
  (low ×0.8 → prime ×1.7, residential only), migration pull (peaks
  ×1.594 at top of "nice"), Land value overlay toggle + selection-panel
  line, 55 new tests green, full suite 1341 green, snapshot stays v6.
- **Goal:** ammo/fuel as a tempo constraint; supply trucks, depots,
  missile/fuel chains; nuclear exemption.
- **Contents:** S2 (§4) + §3.2 roster + logistics overlay + resupply
  command + per-service toggles.
- **Deployable when:** missile units run dry and must resupply;
  interdiction (killing supply trucks) visibly degrades offensives;
  nuclear sub/carrier ignore fuel.
- **Tests:** ammo gating, fuel burn order-stability, depot
  inventories, out-of-supply degradation (no hard stops),
  validate≡apply for resupply, round-trip.
- **Budget delta:** ~6 buildings + 3 units (~9 keys).
- **AI work:** depot placement, supply-truck ratios, ammo-dry
  retreats. Soak: AI draws depot stocks.

### Workstream X — Living menu demo (0.1 Alpha)
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** The main menu background
  is a living world: a seeded sandbox session plays itself behind the
  menu through the REAL command queue — no sim special-casing. New
  `game/src/ui/demoDirector.ts`: `createDemoSession()` (canonical
  `createSession()` + designed opening stockpile, campaign
  `startingResources` precedent) and `DemoDirector`, a tick-gated
  scripted "player" (`issuer: 'demo'`) playing a ~59,400-tick movie
  (~10.4 camera orbits at 0.0011 rad/tick) on a 44×44-cell town site:
  zones → roads → houses/shops/factories → power/water plants +
  power-line/pipe runs → barracks/warFactory/fuelDepot →
  rifles/trucks/tanks/drones/fighters + resupply runs → four age
  advances (connectivity → industry → information → ascendance) →
  transit/rail/airport → Storm Array → storm strike on empty land →
  `done`, and the menu restarts the movie. 128 commands, zero failures,
  solvent on all resources; the suite pins the movie still playing at
  tick 57,120 (ten orbits).
  Same `DEMO_SEED` (0xde407) → same movie every boot (chapters fire on
  `world.tick` only; director RNG is a director-owned bank — `world.rng`
  untouched). `main.ts` renders it with the production pipeline
  (terrain view + instanced `EntityRenderer` + zone/paving/ambient-crowd
  overlays + environment lighting), ≤6 ticks/frame behind an 8 ms cap,
  tick-deterministic cinematic camera that swings to the storm target
  for the finale; model keys stream in after first paint (boot set +
  stormArray), static terrain fallback if the demo fails. Entering a
  game discards the demo completely (`startGame` always builds its own
  session — pinned by test: fresh post-demo session digest-identical to
  pristine). Latent bug fixed alongside: `sim/pathfinding.ts` computed
  `GRID_CELLS` at module scope from `CITY_GRID_CELLS`, which reads NaN
  inside the city → world → pathfinding → city import cycle whenever
  pathfinding is first reached through city (the demo tripped it — first
  move order died `RangeError: Invalid array length`); now a lazy
  `gridCells()`. Gate: 8 tests
  (`game/tests/ui.demoDirector.test.ts`: determinism, full-arc effects,
  zero failures, ten-orbit sustain, RNG isolation, discard guarantee,
  real-game sessions
  untouched, cost), full suite green, tsc clean, build clean +
  license stamps. Cost: session creation ~50 ms, full 60,001-tick movie
  ~10 s in Node (~0.17 ms/tick).
- **Goal:** the menu feels alive and shows off real game systems.
- **Deployable when:** the menu plays the same movie every boot, never
  stalls rendering, and real games are provably unaffected.

### Phase 4 — Transport variety (L)
- **Goal:** road classes, rail, trams/buses/ferries, marinas; civilian
  transport feeds town growth.
- **Contents:** S7 (§4) + §3.4 roster; **v6→v7 snapshot migration**
  for road classes (explicit `migrateRoadsV6ToV7`, unit-tested
  separately from the sim).
- **Deployable when:** upgrading a road visibly speeds trips; trains
  run station-to-station; ferries loop; trams grow zones; legacy saves
  migrate (roads → default class).
- **Tests:** migration unit tests, rail router determinism, ferry
  loop advancement, class speed caps, digest shape change handled
  deliberately (AGENTS.md: investigate, don't update blindly).
- **Budget delta:** ~5 units + 5 buildings (~10 keys) — lazy loading
  from Phase 0 should be live by here.
- **AI work:** AI uses road classes for its own growth; later: AI
  civilian routes.
- **Desirability hook (do not forget):** Phase 3's desirability system
  counts `waterfrontAmenity` building flags within radius for the
  water-proximity/land-value driver. When the `marina` building kind
  lands here, set `waterfrontAmenity: true` on its def — no
  desirability code changes needed; marinas then raise nearby land
  value automatically (user request 2026-09-30: marinas and beaches
  must raise desirability; beaches/shoreline are already covered by
  the water-proximity driver).
- **Ambient city-life hook (workstream P, already in place):**
  `render/cityLife.ts` sizes ambient bus/tram/ferry counts from city
  population (`ambientTransitDensity`) and renders one instanced layer
  per type registered via `registerAmbientTransitProvider(type,
  provider)`. This phase's job: build the provider(s) — provider-owned
  geometry/material, a pure `poseAt(index, tick)` over the phase's own
  route data (tram lines, bus routes, ferry loops), and `count: 0`
  until the player's network exists (no routes ⇒ no vehicles, never a
  crash). Provider geometry should be instancing-friendly; the crowd
  never disposes provider-owned assets.
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** All nine Phase 4 finish
  items delivered: the rail drag tool (linearNetworkDrag `rail` kind,
  `buildRailOrder`, HUD button + icon, click resolution), the road-class
  selector (dirt/country/paved/highway picker with per-cell cost, the
  class remembered across tabs, `partitionRoadCells` splitting drags
  into build + in-place upgrade orders), ambient transit providers
  (buses/trams/ferries as `AmbientVehicleProvider`s over the player's
  placeable stops — closed-loop routes, dwell pauses, population-scaled
  counts, `count: 0` with no route), building variants + size tiers
  (variants 0..3 with procedural rooftop props, tiers 1..3 scale, through
  the lazy pipeline — no variant key in the boot set), the occupancy
  line in the selection panel (`buildingOccupancy()` via the AD11
  digest), the marina desirability test (+10 waterfront amenity through
  the Phase 3 hook, zero desirability-code changes), the NaN camera
  guard (pure `guardCameraState` + loud restore in the controller), the
  AI/soak (civilian transport and road classes pinned as documented
  no-ops, transport-mixed AI-vs-AI soak green), and this docs sweep.

### Phase 5 — Airports + airline (M–L)
- **Goal:** airport zones, capability-gated tiers, hangars, civilian
  airline income, mixed-use airports.
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** All five workstreams
  shipped on `main` (commits `3865c51`/`84d011e`/`3bc8146`/`8ba8caa`/
  `781cb2a` + art pass 2): **A — airports + airline:** `ZoneType.AIRPORT`
  with its own tax-rate slot (4-tuple decodes legacy 3-tuples),
  player-placed-only airport development, 14 airport buildings
  (civil/military/mixed anchors, passenger/cargo terminals, control
  tower, hangarS/M/L, fuel farm, maintenance hangar, runwayS/M/L),
  `airportType` + `countsAs` designations (mixed reads civilian to
  rivals), `establishAirlineRoute`/`cancelAirlineRoute` with paying
  routes, airline panel + airport overlay, ambient `airliner` provider
  (1/2000 pop, cap 8, circuits over civil airports) — 50 tests.
  **B — aircraft + hangars/carriers:** 16 new aircraft (roster now 66:
  19 land / 22 air / 25 sea), S4 hangar system (ground hangars +
  carrier wings, embark/base/launch, validate≡apply, kill-releases-slot,
  wing dies with carrier), tanker refuel aura; **carriers train EMPTY
  and only carrier-capable kinds may embark** (sim + UI enforced) — 32
  tests. **C — naval + ports:** 15 naval units (incl. nuclear-exempt
  missile sub), 4 coastal ports, deployable naval mines, `runHarvest`
  civilian sea income, ambient `cargoShip` provider — 40 tests.
  **D — AI + snapshot:** v7→v8 migration (hangar fields, v5+ still
  load), hangar-aware `canTrain`, carrier wing-filling + escorts, civil
  airports, 3600-tick AI-vs-AI soak — 34 tests. **E — art:** all 49 new
  keys mapped (CC0 styloo plane pack + procedural heroes + kitbashes),
  lazy-loaded, boot set unchanged. Full suite 1775+/1775 green, tsc +
  build clean. Deployable criteria met: runway class gates plane class
  pre-purchase; mixed airports show civilian until discovered (intel
  hook documented for Phase 7).
- **Contents:** S4 (hangars) + S5 + S8 (§4) + §3.5 roster + airline
  panel + airport overlay.
- **Deployable when:** first-plane moment works (build runway →
  plane lands); runway class visibly gates plane class pre-purchase;
  mixed airport shows civilian until discovered.
- **Tests:** hangar validate≡apply under contention, kill-releases
  slot, zone placement rules, tax-rate 4-tuple decode, airline income
  determinism.
- **Budget delta:** ~9 buildings + ~14 aircraft (~23 keys) — the
  phase that forces the Phase-0 download decision to be real.
- **AI work:** hangar-aware `canTrain`; AI builds civil airports and
  runs routes (static income).
- **Ambient city-life hook:** register an `airliner` provider with
  `registerAmbientTransitProvider('airliner', …)` — ambient airliners
  sized by `ambientTransitDensity(pop).airliner` (1 per 2000 people,
  cap 8). `poseAt` should fly circuit patterns over/near the player's
  civil airports; `count: 0` until at least one civil airport is
  completed. Same contract as Phase 4's providers: provider-owned
  assets, pure pose function, no sim coupling.

### Phase 6 — Naval expansion + carrier wings (M)
- **Goal:** sub variants, surface combatants, logistics ships,
  civilian sea, ports; carriers as empty hulls with air wings.
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** Shipped together with
  Phase 5 (merged scope): the shared S4 embark machinery
  (`embarkAircraft`/`launchAircraft`, carrier-capable kinds — Naval
  Fighter, Trainer, Armed UAV, Recon UAV — wing capacity 8,
  empty-at-training carriers, carrier-death wing disposition), the
  15-kind naval block (66-unit roster: 19 land + 22 air + 25 sea —
  coastal sub, nuclear missile sub that never burns fuel, corvette,
  heavy destroyer, cruiser, battleship, cargo freighter, fuel tanker,
  ammo ship, repair ship, minelayer + deployable-only naval mine,
  coast guard cutter, cruise liner, yacht), the 4 ports (commercial,
  container, fishing, naval base) with coastal placement, harvest
  income, and shipyard/navalYard `countsAs` gates, the ambient
  `'cargoShip'` provider (decorative container ships between civilian
  ports, render-only), and the AI (`thinkCarrierWings` fills wings
  before sailing, `thinkCarrierEscorts` keeps 2 escorts per carrier).
  Remaining: minesweeping (later).
- **Contents:** §4 S4 (embark) + §3.6 + §3.7 (carrier-capable kinds,
  maritime patrol, tanker) + naval mines.
- **Deployable when:** carrier sails empty, embarks a wing, projects
  air power at range; escorts matter; mines threaten straits.
- **Tests:** embark/launch commands, embarked-unit combat/movement
  guards, carrier-death wing disposition, mine trigger determinism.
- **Budget delta:** ~14 units + 5 buildings (~19 keys; warship/sub/
  helicopter hulls are procedural heroes via `proceduralModels.ts` +
  `surfaceMaterials.ts` — the "hero CC0" line is amended: no licensable
  CC0 warship source exists (verified 2026-09-30 in
  `docs/research/phase5-air-naval-art.md`), while the airliner-grade
  hulls came from the CC0 styloo Tiny Plane pack).
- **AI work:** AI fills wings before sailing; builds escorts;
  minesweeping (later).
- **Ambient city-life hook (naval):** DONE (workstream C, 2026-09-30)
  — the `'cargoShip'` transit type extends the `AmbientTransitType`
  union in `render/cityLife.ts`; `render/cargoShipProviders.ts` sails
  decorative container ships between the player's completed civilian
  ports (90-tick loading dwell, 1 per 800 residents, cap 10), wired
  into `ui/game.ts` `syncTransitProviders` with the same rebuild/
  dispose lifecycle as the Phase 4 providers. No sim coupling (no
  unit records — the render-only rule holds), digest-pinned in
  `tests/render.cargoShip.test.ts`.

### Phase 7 — Intel + spies + recon (M; L with full actions)
- **Goal:** deterministic asset economy, named spies, recon value,
  mixed-use discovery with warning + grace period.
- **Contents:** S6 (§4) + §3.8 roster + intel panel UI.
- **Deployable when:** spies build networks over visible timers;
  sabotage/steal spend assets; discovery warns before consequences;
  counter-intel blocks visibly.
- **Tests:** asset accrual/spend determinism, detection pure-function
  property tests, sabotage timers, grace-period behavior, no digest
  impact from stealth.
- **Budget delta:** ~4 buildings + 2 units (~6 keys).
- **AI work:** AI assigns spies, spends operational assets, surges
  counter-intel on warning. **Prototype the mixed-use discovery UX
  early in this phase** (RESEARCH.md open question #1).
- **Status: COMPLETE (2026-09-30, 0.1 Alpha)** — workstream 2
  (intel roster defs) landed: 4 intel buildings + 2 units (spy,
  reconTeam) + 2 upgrades (signalsIntel, counterIntel), the
  `sim/intel.ts` contract surface (`runIntelAccrual`, `isDetected`,
  `detectionRadiusAt`, `sabotageDurationSec`, `intelSightBonus`),
  `world.city.players[o].intel` + `BuildingRecord.sabotagedUntil`
  (v8, no bump — AD9), digest coverage, palette/strings/icons
  wiring, 21 tests in `tests/sim.intel-roster.test.ts`. The
  sim-core workstream's mechanics ALSO landed in the same checkout
  (same file, header documents both halves): `infiltrateBuilding` /
  `sabotage` / `stealTech` commands, `acquireTarget` +
  `getVisibleEnemies` + `effectiveSight` hooks, economy-tick wiring
  (`createIntelSystem`, `registerIntelCommands` in `ui/session.ts`).
  Balance rationale: `docs/research/intel-roster.md`. Workstream 4
  (the intel panel UI) landed (2026-09-30, 0.1 Alpha): new
  `game/src/ui/intel.ts` contract module (asset counters + accrual
  rates mirroring the sim, spy display states, warnings with
  countdowns + what-happens-next, rival airports discovered /
  UNVERIFIED, op targets, steal preview, `ia:` / `ir:` / `is:` /
  `iw:` / `ig:` / `iu:` digest segments), the **Intelligence** panel
  in the Management tab (HUD asset counters + `intelSectionEl`),
  `buildInfiltrateOrder` / `buildSabotageOrder` / `buildStealTechOrder`
  with the sim's exact `{ unitId, buildingId, owner }` payloads,
  29 tests in `tests/ui.intel.test.ts` + payload + digest tests in
  `ui.orders` / `ui.paletteDigest`, and `docs/HOW_TO_PLAY.md` player
  docs. Workstream 3 (recon value + mixed-use discovery) landed
  (2026-09-30, 0.1 Alpha): `BuildingDef.radarRadius` (radarStation 90,
  non-stealthed only), `UnitDef.recon` (reconTeam/reconUAV/reconPlane),
  `buildingSightCoverage` wired into `getVisibleEnemies` at AI think
  cadence (SIGINT sees everything incl. spies; radar never sees spies;
  satelliteUplink keeps the `effectiveSight` hook), and the
  mixed-airport discovery lifecycle — observation (embedded unburned
  spy / SIGINT coverage / recon overflight) → `suspected` warning with
  a 60-second countdown → `revealed` after exactly 1800 ticks
  (suspicion latches, zero RNG, `BuildingRecord.discovery` AD9 —
  digest + snapshot covered, stays v8); the UI seam
  (`discoveryStateOf` / `airportDisplayType` / `discoveryWarnings` /
  real-state rival airports), 22 tests in
  `tests/sim.intel-sight.test.ts`. Workstream 3b (AI intel play) landed
  (2026-09-30, 0.1 Alpha): the Classic AI runs the full intel doctrine
  (`game/src/sim/ai.ts` — virtual intel construction, spy training to
  quota + target-value-directed infiltration/steal/sabotage,
  counter-intel surge, intel research, per-think spend ledger so the
  command batch never goes stale at apply), 30 tests in
  `tests/sim.ai-intel.test.ts` + a 3600-tick marshal-vs-marshal soak in
  `tests/sim.ai-intel-soak.test.ts` (8 infiltrations, 8 steals,
  4 sabotages, digest-stable across save/load).
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).**

### Phase 8 — Tech-level roster pass + peaceful mode (M + S)
**Status:** COMPLETE 2026-09-30 — all five workstreams landed and the
integration gate is green (full suite 2100/2100, tsc clean).
- Workstream A (peaceful-mode sim core): def-level `military`
  predicate, command-layer lockout (spawnUnit/deployMine/placeBuilding/
  researchUpgrade/covert ops/superweapons), `world.peaceful` (tick-0,
  immutable, snapshot v8, digest), `peacefulStatus` (population +
  treasury health — endless since 2026-10-01, no victory condition),
  conquest bypass, 28+ sim tests.
- Workstream B (peaceful UI): skirmish-setup peaceful toggle, hidden
  Military tab (the Civilian tab carries the note), Management tab's
  live status section (no target, no rival — endless), palette
  lockout with reasons, `po:` digest segment, 23+ UI tests.
- Workstream C (peaceful AI): the rival keeps playing — `thinkPeaceful`
  (3 compact districts, infrastructure-first) issues zero military
  orders and never even forms them (`canTrain` gate + peaceful
  dispatch; thinkIntel/thinkSuperweapons early-return); 3600-tick
  marshal-vs-marshal soak: both cities grow, digest-stable.
- Workstream D (tech levels): 28 Mk II/Mk III variant defs (96 unit
  defs: 31 land / 30 air / 35 sea), pure `sim/variants.ts` helpers, AI
  trains the best unlocked+affordable tier, §AD12 art sharing (zero
  new MODEL_PATHS keys), 44 tests; TRAIN_TABS + `STRINGS.unitNames`
  integrated (variants sit next to their base kinds).
- Workstream E (civilian deep-dive): 99 building defs (10 new
  civilian: museum/theater/stadium/botanical garden/grand market/bank/
  office tower/clinic/medicalCenter/fire station), five funded
  ordinances (green/transit/business/nightlife/education) via
  `setPolicy`, per-owner desirability, BUILD_TABS integrated (5 civic
  + 5 commerce), `oc:` digest segment, `|pol…=` sim digest, 62 tests.
- **Goal:** Mk II/III variants across the roster (art-shared,
  §AD12); peaceful skirmish mode.
- **Contents:** §3.9; variant defs gated by age/building; peaceful
  toggle + lockout + objectives panel.
- **Deployable when:** late-age armies look and feel advanced;
  peaceful mode plays start-to-finish with civilian objectives and
  no military options.
- **Tests:** variant gating, art-sharing (no new keys), peaceful
  lockout rejections, peaceful save/load (`world.peaceful`
  round-trip), victory-check bypass.
- **Budget delta:** ~0 keys (art-shared by design).
- **AI work:** peaceful-play behavior — DONE (workstream C, 2026-09-30:
  `thinkPeaceful`; zero military orders formed, let alone rejected).

### Phase 9 — Soak, balance, polish
- **Status: COMPLETE (2026-09-30, 0.1 Alpha).** Dedicated final pass.
  Long AI-vs-AI soaks to game conclusion (marshal/commander/general,
  standard + peaceful, multiple seeds) with headline-usage metrics
  (`game/tests/sim.phase9-longsoak.test.ts`, report
  `docs/research/phase9-soak-metrics.md`). Found and fixed: an
  `advanceAge` same-tick race that crashed the tick (human-vs-AI too),
  commander forward bases placed in water, and the peaceful-AI death
  spiral (treasury floor, fouling-avoidant siting, paced fuel).
  Balance: dead roster 82 → 73; marshal builds mediaCenter (industry
  unlock); commander mix gains reconTeam/hq. Polish: oversized
  airport terminals scaled to footprints, runway strips filled to
  plots, stale comments and a peaceful-mode intel-panel contradiction
  fixed. Save/load digests stay stable.
- **Final-review remediation (2026-10-01, 0.1 Alpha):** a 10-team review
  of the shipped game found 9 critical bugs (peaceful-lockout bypass,
  AI zero-funds income, unwinnable wars — buildings had no HP, map
  preset not saved, misplaced utility indicators, leftover API-key UI,
  dead Prosperity tax bonus, 357 dead rail lines, tutorial teaching a
  nonexistent drag-select) plus the M/H/L items; all remediated:
  peaceful gates at the command layer, AI virtual economy, destructible
  buildings + AI siege doctrine + reachable conquest (endings work),
  endless peaceful mode (no victory condition — it never finishes),
  per-instance utility indicator billboards, API-key UI ripped out,
  rails wired and rendered, tutorial fixed, spectre stealth flag,
  combat targeting grid + exact pruning + kill batching, `intelSightBonus`
  ~1000x via version-counter cache, worst-case stress budget test,
  GitHub Actions CI, byte-measured 8 MiB boot gate (4.11 MiB
  transferred), corrupt-save recovery, tab-hidden auto-pause,
  save-hitch guard, UI screen tests, colorblind live-refresh, full
  docs + public-code refresh (ARCHITECTURE rewrite, REVERSALS,
  TESTING, CONTRIBUTING, `.nvmrc` 22), camelCase file renames,
  audio feel pass (7 cues, war-mood hysteresis, ambient city bed,
  menu music, positional SFX), Mk II/III as tactical tradeoffs,
  carrier wings armed-first, blob shadows + ACES, toast queue, storm
  largest-cluster targeting, attack/embark race fix, emergency refuel. Budgets: startup 4.11 MiB
  transferred (byte-measured 2026-10-01, final-review R3: 0.46 MiB
  gzipped JS+CSS+HTML+GLTFLoader + 2.80 MiB pinned 33-key boot GLB set
  + 0.79 MiB tree textures + 0.06 MiB external colormaps; 5.30 MiB raw)
  vs the 8 MiB gate — 51.3% spent. The boot-budget test
  (`game/tests/render.boot-budget.test.ts`) pins this in bytes and
  fails the suite if it ever exceeds 8 MiB.
  AI-vs-AI headline-system usage metrics per phase (§6); balance pass
on plant ladder and supply costs; visual review per asset batch;
player-docs (HOW_TO_PLAY, GAME_MECHANICS) updated per phase as
mechanics land — a doc that lags reality is a bug.

## 10. Budget accounting

**Download (startup, ≤8 MiB gate).** Today ~5.45 MiB (4.62 GLB +
0.83 tree textures); ~30 average keys of headroom. Planned new keys:
~1 (P1) + ~12 (P2) + ~9 (P3) + ~10 (P4) + ~23 (P5) + ~19 (P6) +
~6 (P7) + ~0 (P8) ≈ **~80 keys ≈ ~6.4 MiB** — does NOT fit
all-at-boot. The Phase-0 download decision (lazy per-tab/per-age
loading and/or meshopt optimize) must be implemented no later than
Phase 4, before the airport/naval waves land. Procedural-first
infrastructure and art-shared variants are already assumed in the
counts above.

> **Final-review R3 (2026-10-01):** the "Today ~5.45 MiB" above was raw
> bytes with no gzip credit. Byte-measured on a fresh build, the boot
> payload transfers **4.11 MiB (51.3% of the 8 MiB gate)** — 0.46 MiB
> gzipped text (HTML/JS/CSS/GLTFLoader) + 3.65 MiB raw binary (2.80 MiB
> boot GLBs, 0.79 MiB tree textures, 0.06 MiB external colormaps);
> 5.30 MiB raw-everything (66.2%). Pinned by
> `game/tests/render.boot-budget.test.ts`; full methodology in
> `docs/research/perf-r3.md`.

**Draw calls (≤100–200 at 60 fps).** ~2–8 per entity view today; no
entity instancing path. Phase 0 decides the mechanism; entity-count
growth in Phases 4–6 must stay under the chosen ceiling or the
instancing path must land first. This is the binding constraint —
it can make the expansion's core promise unshippable, so it is
decided before the roster grows, not after.

**Sim tick.** Flood fill and allocation run on structural change
only; detection is a pure function; asset counters are integers.
Per-tick costs stay O(entities) with small constants — the existing
30 Hz fixed timestep is not threatened by any phase's design.

**Tests.** 852 green at plan time; every phase adds its own suites
and re-runs prior phases' smoke tests (step gate). Digest additions
are deliberate per field (AGENTS.md rule).

## 11. Snapshot/digest migration plan

- **No bump:** veterancy fields, fuel/ammo, sabotagedUntil, ferry
  routes, intel asset counters, `world.peaceful`, utility network cell
  sets, `BuildingRecord.hp`/`maxHp`, `UnitRecord.buildingTargetId`
  (final-review R2, 2026-10-01 — buildings destructible: legacy
  records decode to the def's full HP, siege linkage to 0) — all decode
  to neutral defaults (step-7 AI-personality precedent). **Exception:** `embarkedOn`, `hangarBuildingId`, and
  hangar slots shipped as **v8** (Phase 5 workstream D, 2026-09-30) —
  PURELY ADDITIVE (no shape migration; v7 decodes hangars to
  `defaultHangarSlots(kind)`, embark fields to 0), bumped so the
  hangar/airport data contract has a versioned home. v5/v6/v7 still
  load.
- **Bump v6→v7:** road classes (shape change `number[]` →
  `{cell, cls}[]`, `migrateRoadsV6ToV7`) and the tax-rate 4-tuple
  (`migrateTaxRates` pads the 4th rate). When bumping, decide whether
  v5 support drops (today: 6 and 5 load; the if-chain extends).
- **Digest:** every new behavior-affecting field is encoded
  (sorted owners, id-ordered arrays, `canonicalNumber` for floats) —
  incl. building `hp`/`maxHp` and the unit `buildingTargetId` siege
  linkage (final-review R2, 2026-10-01).
  Digest changes are investigated, never blindly updated.
- **RNG:** new named streams per system; stream state already
  snapshotted/digested verbatim.

## 12. Risks (top 5, with mitigations)

**R1. Utility cutover breaks AI/balance (scope risk).** Mitigation:
pool fallback (§AD2), AI line-building as its own phase, hard
requirement gated behind a game option — never default until the AI
copes.

**R2. Import cycles as systems interleave.** Logistics wants
combat↔economy hooks; intel wants combat→perception. Mitigation:
"data on `World`, logic in the owning module, direct reads with
comments" (existing discipline); add a test asserting the known
cycle pairs stay cycle-free.

**R3. Digest drift.** Every new field must reach `canonicalizeWorld`
or same-seed replays desync silently. Mitigation: mechanical
checklist per change (snapshot copy → decode default → digest
encoding → round-trip test); floats via `canonicalNumber`.

**R4. AI capability cliff.** New systems the AI doesn't use are free
human exploits. Mitigation: AI entries ship in the same change;
AI-vs-AI soak measures headline-system usage before "done".

**R5. Validate-vs-apply divergence in reservations.** Hangar slots,
wing slots, depot inventory, network capacity. Mitigation: validate
at enqueue AND apply with the *identical* pure function; the slot-
choice function is shared and unit-tested under same-tick
contention.

## 13. Non-goals (explicit — do not build)

- Agent-based power/water flow; per-building mandatory wiring.
- Per-plant funding sliders; plant aging/degradation timers.
- Proportional brownouts; hidden pressure/utility mechanics.
- Civilian fuel-logistics chains (civilian utilities never depend on
  delivered fuel).
- Itemized per-shell/per-missile physical inventory on the field.
- Manual load/unload; per-convoy driving; any logistics step that
  requires per-truck handling.
- Hard failure states from empty supply (dead-instant units).
- Compounding multiplicative supply penalties.
- Global espionage point pools; instant dice-roll spy missions;
  hyper-lethal counter-intel; bolt-from-the-blue intel punishments.
- Decorative airport/modules that change no number or capability;
  time-based (level-by-waiting) progression.
- Per-vehicle/per-staff micromanagement; per-worker civilian XP.
- Placebo mechanics of any kind (RESEARCH.md §2).
- Generated/AI-made 3D models (license provenance unverifiable).
- New commercial game-title references anywhere outside
  docs/grand-expansion/research-*.md citations.
- Force-pushes or history rewrites, ever.

## 14. Phase 1 recommendation (honest)

**Do Phase 0 first, then Phase 1 = Veterancy.** The brief lists
utilities first, but the engineering order is:

1. **Phase 0** decides the two ceilings (draw calls, download) and
   builds the shared gesture pipeline — all cheap, all blocking
   everything behind them. Skipping this is how the roster becomes
   unshippable.
2. **Phase 1 (Veterancy)** is the right first *playable* phase: S–M
   complexity, self-contained (no cross-system hooks), zero
   architectural risk (additive fields, no snapshot bump), high
   player visibility (chevrons, Elite auto-regen, academy choice),
   and it exercises the digest/snapshot/AI-soak machinery that the
   XL phases will lean on.
3. **Phase 2 (Utilities)** follows as the first big system, with the
   pool fallback (§AD2) keeping the game playable throughout the
   cutover.

The riskiest unknowns to attack early regardless of order:
mixed-use discovery UX (prototype before systems — no precedent
exists), the draw-call decision (Phase 0), and the download
mechanism (real before Phase 5).

*End of plan.*
