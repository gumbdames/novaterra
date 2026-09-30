/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 */

/**
 * NOVATERRA — docs/grand-expansion/content-inventory.md
 *
 * Catalog of the CURRENT roster read from the code (`main` as of
 * 2026-09-30): all 28 units (`UNIT_DEFS` in game/src/sim/units.ts), all 28
 * buildings (`BUILDING_DEFS` in game/src/sim/city.ts), all 12 upgrades
 * (`UPGRADE_DEFS` in game/src/sim/upgrades.ts), each with a one-line role.
 * Ages: foundation → connectivity → industry → information → ascendance
 * (game/src/sim/ages.ts).
 *
 * Then a GAP ANALYSIS against the grand-expansion pillars (utilities,
 * transport variety, airports/airline, naval expansion, aircraft expansion,
 * logistics chain buildings, intel): concrete entity kinds still missing
 * per pillar — lists of things to build, not vague "more ships".
 *
 * Sources read: game/src/sim/units.ts, game/src/sim/city.ts,
 * game/src/sim/upgrades.ts, game/src/sim/economy.ts, game/src/ui/palettes.ts.
 */

// ===========================================================================
// 1. CURRENT UNITS — 28 (game/src/sim/units.ts UNIT_DEFS)
// ===========================================================================
//
// ---- Infantry tab (6) ----
// engineer      — basic builder infantry; cheap, weak, no weapon role.
// rifles        — basic combat infantry; the line troop (cadet AI's only unit).
// sniperTeam    — long-range precision infantry (range 30, sight 36, anti-light).
// combatMedic   — heals friendly land units (radius 12, 2 HP/s; 4 with Field Medicine).
// hauler        — civilian cargo truck; unarmed ground transport.
// spectre       — fast light strike craft; anti-medium/heavy skirmisher.
//
// ---- Armor tab (7) ----
// tank          — main battle tank (500 HP heavy); general-purpose armor.
// apc           — armored personnel carrier; fast medium armor.
// tankDestroyer — anti-heavy specialist (×1.8 vs heavy armor).
// artillery     — long-range siege gun (range 48, min range 12).
// mlrs          — rocket artillery; huge area damage, very slow reload.
// aa            — mobile anti-air (targets air only, ×2.2 vs air).
// hq            — mobile headquarters; command aura +25% damage (radius 20).
//
// ---- Air tab (6) ----
// fighter       — air-superiority fighter (×1.6 vs air).
// fighterBomber — strike aircraft; heavy anti-ground (×1.6 vs heavy).
// attackHeli    — fast attack helicopter; anti-armor.
// drone         — cheap light scout/attacker (sight 26).
// awacs         — airborne early warning; huge sight (65), no weapon.
// transport     — air transport helicopter; unarmed.
//
// ---- Navy tab (9) ----
// patrolBoat    — light sea patrol; basic naval unit.
// missileBoat   — fast sea-strike boat (anti-heavy ×1.5).
// frigate       — anti-submarine escort (anti-medium ×1.6, hits sea+air).
// submarine     — stealth capital-killer (anti-heavy ×2.0).
// destroyer     — heavy multirole warship (sea+air).
// carrier       — capital ship (900 HP); strong AA screen.
// commandShip   — naval command aura +25% sea attackers (radius 24).
// transportShip — sea transport; unarmed.
// fishingBoat   — civilian fishing boat; passively harvests +0.6 food/s.
//
// Production gates: basic units (engineer, rifles, hauler, drone, transport,
// patrolBoat, transportShip, fishingBoat, hq) need no production building;
// barracks → spectre, sniperTeam, combatMedic; warFactory → tank, apc,
// tankDestroyer, artillery, mlrs, aa; airfield → fighter, fighterBomber,
// attackHeli, awacs; shipyard → missileBoat; navalYard → frigate, submarine,
// destroyer, carrier, commandShip.

// ===========================================================================
// 2. CURRENT BUILDINGS — 28 (game/src/sim/city.ts BUILDING_DEFS)
// ===========================================================================
// Rates are per sim-second. Supply/demand: power and water are allocated
// per-player by id order with NO network requirement (roads are optional
// since 2026-09-30).
//
// ---- Housing tab (3) ----
// house         — home; population 6, small tax base.
// apartment     — apartment block; population 30.
// school        — school; small research output (0.25/s).
//
// ---- Commerce tab (6) ----
// shop          — shop; funds income, consumes goods.
// market        — market; funds income + high tax base, consumes food/goods.
// lab           — research lab; research output, REQUIRED for all upgrades.
// mediaCenter   — media center; influence output.
// hospital      — hospital; manpower output, required for Field Medicine.
// university    — university; research output 1.0/s.
//
// ---- Industry tab (7) ----
// factory       — factory; materials + goods output, consumes fuel.
// farm          — farm; food output.
// quarry        — quarry; materials output.
// oilRefinery   — refinery; FUEL output (1.5/s), consumes materials.
// recyclingCenter — recycling; materials output, consumes goods.
// barracks      — barracks; manpower output, trains infantry units.
// warFactory    — war factory; trains armor units.
//
// ---- Utilities tab (5) ----
// powerPlant    — power plant; power supply 25, consumes fuel.
// solarFarm     — solar farm; power supply 15, no fuel.
// nuclearPlant  — nuclear plant; power supply 60, consumes fuel.
// waterPump     — water pump; water supply 25.
// desalination  — desalination; water supply 40.
//
// ---- Naval & Air tab (4) ----
// shipyard      — shipyard; trains basic sea units.
// navalYard     — naval yard; coastal placement, trains advanced navy.
// airfield      — airfield; trains aircraft.
// radarStation  — radar station; research output, sight/intel flavor.
//
// ---- Special tab (3) ----
// monument      — monument; expensive prestige building.
// aegisControl  — Aegis control; defensive superweapon (ascendance age).
// stormArray    — storm array; offensive superweapon (ascendance age).

// ===========================================================================
// 3. CURRENT UPGRADES — 12 (game/src/sim/upgrades.ts UPGRADE_DEFS)
// ===========================================================================
//
// ---- Military (8) ----
// apRounds             — armor-piercing rounds; +damage vs armored targets.
// compositeArmor       — composite armor; +survivability for vehicles.
// engineTuning         — tuned engines; +vehicle speed.
// advancedAvionics     — advanced avionics; aircraft sight/range/damage.
// sonarSuite           — sonar suite; submarine detection (requires navalYard).
// cruiseMissiles       — cruise missiles; +weapon range.
// droneOptics          — drone optics; +sight.
// fieldMedicine        — field medicine; better healing + spawn HP.
//
// ---- Economy (4) ----
// precisionManufacturing — precision manufacturing; materials efficiency.
// smartGrid            — smart grid; power-supply boost per plant.
// verticalFarming      — vertical farming; food/water efficiency.
// freeTrade            — free trade policy; market/trade bonus.

// ===========================================================================
// 4. GAP ANALYSIS vs. THE EXPANSION PILLARS
// ===========================================================================
//
// PILLAR 1 — UTILITIES (plants + lines/pipes across tech levels)
//   Have: one generic powerPlant, one solarFarm, one nuclearPlant, one
//   waterPump, one desalination; allocation is abstract (no network).
//   Missing (concrete):
//   - Plant versions per tech level: coal plant, gas plant, oil plant,
//     wind farm (turbines vendored in kenney-industrial, unused), hydro dam,
//     geothermal plant, fusion plant (late age).
//   - Power network: power lines (poles + wires vendored in kenney-roads,
//     unused), substations, transformers — with actual topology instead of
//     abstract id-ordered allocation.
//   - Water network: water pipes, pumping stations, water towers, reservoirs.
//   - Zone-level hookup: buildings/zones connecting to the grid (the sim
//     currently needs no hookup at all).
//   - Per-plant fuel chains: coal/gas/oil as distinct fuels, not one
//     generic 'fuel'.
//
// PILLAR 2 — TRANSPORT VARIETY
//   Have: one road class (purely optional ribbon), hauler truck (no cargo
//   mechanic), transport heli, transportShip.
//   Missing (concrete):
//   - Road classes: dirt road, asphalt road, highway (signs vendored in
//     kenney-roads, unused), bridges (vendored, unused), tunnels.
//   - Rail: rail tracks, freight train, passenger train, rail stations,
//     rail bridges.
//   - Urban transit: tram lines + trams, bus routes + buses, bus depots.
//   - Water transit: ferries, ferry terminals, marinas (leisure docks).
//   - Traffic: the sim keeps `areRoadsConnected` for future traffic —
//     currently no traffic exists; roads are decorative.
//
// PILLAR 3 — AIRPORTS + AIRLINE
//   Have: one military airfield (production building), military aircraft.
//   Missing (concrete):
//   - Airport zones: civilian airport, military airbase, mixed-use airport
//     as placeable zones/buildings distinct from the military airfield.
//   - Airport buildings: passenger terminal, cargo terminal, control tower,
//     hangars per aircraft type, runways, fuel farm, maintenance hangar.
//   - Civilian aircraft: airliner (narrow-body), jumbo airliner, regional
//     jet, cargo plane, passenger helicopter, seaplane.
//   - Airline management: routes, ticket income, airline panel UI, cargo
//     contracts — no UI or sim system exists for this today.
//
// PILLAR 4 — NAVAL EXPANSION
//   Have: patrolBoat, missileBoat, frigate, submarine, destroyer, carrier,
//   commandShip, transportShip, fishingBoat; shipyard + navalYard.
//   Missing (concrete):
//   - Submarine variants: small coastal sub, large missile sub (the brief
//     explicitly asks for subs small + large).
//   - More surface combatants: corvette, cruiser, battleship-grade heavy,
//     second destroyer class with a different role.
//   - Carrier air wing: carriers are currently just gun platforms — no
//     embarked aircraft, no launch/recovery, no carrier-capable aircraft
//     restriction. Needs: carrier air wing mechanics + carrier-capable
//     aircraft kinds.
//   - Logistics ships: cargo freighter, fuel tanker, ammunition ship,
//     repair ship, minelayer + naval mines.
//   - Civilian sea: coast-guard cutter, marina yachts, cruise liner,
//     ocean liner (vendored in kenney-watercraft, unused).
//   - Ports: civilian harbor, container port, fishing harbor, naval base
//     (distinct from the navalYard production building).
//
// PILLAR 5 — AIRCRAFT EXPANSION
//   Have: fighter, fighterBomber, attackHeli, drone, awacs, transport.
//   Missing (concrete):
//   - Strategic bomber (long-range heavy strike).
//   - Sub hunter / maritime patrol aircraft (anti-submarine from the air —
//     pairs with the sonarSuite upgrade).
//   - UAV family: recon UAV, armed UAV (distinct from the generic drone).
//   - Intel/recon plane (photo-recon, signals).
//   - Gunship (heavy close air support).
//   - Tanker (air-to-air refueling), military cargo plane, trainer aircraft.
//   - Carrier-capable variants (naval fighter) for the carrier air wing.
//
// PILLAR 6 — LOGISTICS CHAIN (missile/fuel: production → transport → reload)
//   Have: oilRefinery (fuel 1.5/s), factory/powerPlant/nuclearPlant consume
//   generic fuel; hauler is a truck with no cargo mechanic.
//   Missing (concrete):
//   - Fuel chain buildings: oil well / oil rig (crude extraction), fuel
//     depot (storage), gas station network — crude vs refined fuel as
//     distinct resources.
//   - Missile/ordnance chain: munitions factory, missile plant, missile
//     silo, ordnance depot.
//   - Supply units with a real role: supply truck (ammo/fuel delivery),
//     fuel truck, cargo truck — the hauler needs a logistics mechanic, not
//     just a model.
//   - Reload mechanics: missile units (mlrs, missileBoat, submarine,
//     bombers) currently fire forever — no ammo, no reload, no resupply.
//   - Exemptions per the brief: nuclear subs/carriers run without fuel
//     logistics.
//
// PILLAR 7 — INTEL
//   Have: radarStation (research output), awacs (sight 65), sniperTeam
//   (sight 36), sonarSuite/droneOptics/advancedAvionics upgrades.
//   Missing (concrete):
//   - Intel buildings: intelligence HQ, listening post, satellite uplink,
//     signals-intercept station.
//   - Spy units: spy/saboteur (infiltration, sabotage), recon team — no
//     covert unit exists.
//   - Recon systems: recon satellite (ties to the space-kit dish assets),
//     recon flights as a mechanic (not just sight stats).
//   - Counter-intel: counter-intel agency, camouflage/deception.
//   - Intel panel UI: no UI surface shows intel state; perception today is
//     `getVisibleEnemies()` sight checks with no fog-of-war layer for the
//     player.
//
// CROSS-PILLAR GAPS (needed by several pillars at once)
//   - Veterancy: no veterancy system exists for any unit.
//   - Peaceful mode: no no-military mode UI or sim support (campaign has
//     peaceful mission paths, but skirmish has no peaceful mode).
//   - Civilian economy depth: no passengers, no tourism, no civilian
//     shipping contracts — the civilian side is houses + shops + one
//     fishing boat.
//   - Tech-level versions: entities exist in one version each; the brief
//     asks for versions/tech levels of everything (T1/T2/T3 plants, unit
//     marks, building tiers).
//
// What the gaps imply for the plan: utilities + transport + logistics are
// the three pillars that need NEW SIM SYSTEMS (networks with topology,
// cargo/passenger movement, ammo/fuel reload) — they are not roster
// additions. Airports/airline, naval, aircraft, intel are mostly roster +
// a few mechanics (carrier air wing, airline routes, spies). The render/UI
// audit covers what each new entity costs and how it surfaces.
