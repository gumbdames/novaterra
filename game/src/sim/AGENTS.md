# AGENTS.md — src/sim

Deterministic fixed-timestep simulation lives here: plain-data world state,
tick driver, commands, systems, pathfinding, spatial index, digest, serialize.
No DOM, no three.js, no Web Audio — the sim must run headless in Node for
tests and the perf harness. See docs/ARCHITECTURE.md §1–§5.

## Module map

- `rng.ts` — mulberry32 + named streams via `createRngBank` / `rngBank`.
- `world.ts` — the `World` store; owns `city: CityState` (imports
  `initCity` from `city.ts`). Grand-expansion Phase 8 (peaceful mode,
  workstream A, 2026-09-30): `World.peaceful: boolean` — tick-0,
  never toggled mid-game, defaults false; snapshotted and digested.
  Roadmap B2 (2026-10-02): `World.victoryKind: SkirmishVictoryKind`
  ('conquest' | 'economic' | 'population' | 'monument') — tick-0,
  never toggled mid-game, defaults 'conquest'; snapshotted (legacy
  decodes 'conquest', no version bump) and digested. The kind type
  lives here so sim code never imports from ui/ (ui/session.ts owns
  the checks and re-exports it).
- `peaceful.ts` — (grand-expansion Phase 8, workstream A, 2026-09-30;
  endless revision, final-review 2026-10-01; roadmap B1 score,
  2026-10-02) the peaceful-mode status as a sim-side pure check:
  `peacefulStatus(world, owner)` (housed population + treasury health).
  Peaceful mode is ENDLESS — there is no victory condition (the old
  8,000-resident builder's-race victory was removed); the UI shows the
  status as information, never as progress toward a goal, and no end
  screen ever fires. B1 adds the derived city score
  `peacefulScore(world, owner, avgDesirability)` — population × (1 +
  treasury + employment + desirability + ridership) — plus
  `PEACEFUL_MILESTONES` / `milestonesReached`. Score and milestones are
  pure derivations; milestone toasts and the localStorage high score
  are UI-side (ui/peaceful.ts), so the sim stays stateless and
  replay/save compatible. Pure module: no DOM, no three.js, no wall
  clock, no RNG; value-imports only city.ts (`getPlayer`,
  `BUILDING_DEFS`). A peaceful game can only be played, never
  won or lost — conquest is unreachable when every military def is
  locked out (the conquest checks are bypassed in ui/session.ts).
- `tick.ts` — 30 Hz accumulator driver, fixed system registration order.
- `commands.ts` — tick-aligned queue, `{ validate, apply }` specs,
  validate-at-enqueue-AND-apply, loud rejections. Value-imports `city.ts`
  (`BUILDING_DEFS`, `cellCenterWorld` — deferred use inside command bodies
  only); the reverse edge is forbidden, see `city.ts` below.
- `city.ts` — city grid, roads, zones, buildings, players, placement
  validation, growth. Registers `buildRoad`, `paintZone`,
  `placeBuilding`, `demolish`, `setTaxRate`. Grand-expansion Phase 8
  (peaceful mode, workstream A, 2026-09-30): `BuildingDef.military?:
  boolean` — true on the 21 war-apparatus buildings (the full 100-kind
  classification is pinned in tests/sim.peaceful.test.ts);
  `placeBuilding` validate rejects military defs loudly in peaceful
  worlds. Judgment calls in docs/research/phase8-civilian-peaceful.md:
  shipyard is military (it gates only military sea units) while
  mixedAirport is military (hosts combat aircraft); the civilian
  airport pieces and civilian ports stay buildable. Imports `World`
  type-only —
  this is what breaks the `world.ts` ⇄ `city.ts` cycle (`city.ts` takes
  `createRngBank` directly from `rng.ts` instead of `rngBank` from
  `world.ts`). Additionally `city.ts` must NEVER take a static value
  import of `commands.ts`: the city→commands→movement→pathfinding chain
  evaluates pathfinding while city is still initializing, so
  `GRID_CELLS` comes out NaN under the SSR transform (caught 2026-09-30
  by sim.ai-soak). Demolish's resupply-reservation release is inlined in
  city.ts for exactly this reason — it mirrors `releaseDepotReservations`
  in commands.ts, keep the two in sync.
  Final-review R2 (2026-10-01): buildings are destructible —
  `BuildingDef.hp` (required, the HP scale comment documents the
  150–1000 tiers) and `BuildingRecord.hp`/`maxHp` (optional, AD9 —
  `?? def.hp` everywhere); `placeBuilding` spawns at full HP.
  `destroyBuilding(world, b)` is the single destruction path (resupply
  release + hangar-link cleanup + demolish the structure) — the
  `demolish` command, combat kills, and the storm strike all funnel
  through it; `buildingCenterWorld(b)` is the sim's canonical
  footprint-center helper. No `commands.ts` value import was needed:
  combat.ts and superweapons.ts call it as callers, keeping the
  city→commands edge absent.
- `superweapons.ts` — the Storm Engine strike and the Aegis shield:
  `constructSuperweaponFacility` (Marshal-AI virtual construction),
  `fireStorm`, `fireAegis`. Final-review R2 (2026-10-01): the storm
  strike now deals flat `STORM_DAMAGE` (200) to every enemy building in
  the blast radius through `damageBuilding` (the one attack path — the
  nuclear attack-meltdown roll lives there, so a strike on a nuclear
  plant still rolls exactly as before); an active Aegis holds. Grand-expansion Phase 8 (peaceful mode,
  workstream A, 2026-09-30): all three validates reject loudly in
  peaceful worlds — the fire gates are defense in depth on top of the
  `placeBuilding` lockout (the Marshal's virtual path never touches
  `placeBuilding`), and the `fireStorm` gate is what keeps "meltdowns
  are impossible in peaceful mode" true (the storm strike is the only
  attack path and the only meltdown trigger).
- `economy.ts` — the 1 Hz economy system (`createEconomySystem`),
  fixed-rate market (`marketTrade`), tax collection. Pure w.r.t.
  rendering. Market PRICE data lives in the leaf module `market.ts`
  (below) — economy.ts re-exports it unchanged. Phase 4: `runTransportEarnings` (on-network civilian
  transports pay `transitEarnings`), `runRidershipIncome` (completed,
  operational transit stops pay `ridershipIncome`), `recomputeOccupancy`
  (per-building residents/workers; runs after construction + utility
  allocation, before the population recount which sums residents —
  `generateManpower` stays last of the population chain). Roadmap B10
  (economy legibility, 2026-10-02): `runEconomyTick` boundary-diffs the
  eight stockpiles across the tick and smooths the per-second deltas
  (EWMA, ~10s memory) into `world.economyFlows` (owner -> resource ->
  rate), read via `flowRate(world, owner, res)` (`FLOW_RESOURCES`). The
  table is derived display data — NOT snapshotted, NOT digested, never
  read by the sim — so save/load simply restarts the averages at 0.
- `market.ts` — (R1 final-review, 2026-10-01) the fixed-rate market
  price list (`MarketResource`, `MARKET_PRICES`, `MARKET_SPREAD`,
  `marketBuyCost`, `marketSellValue`). A LEAF module: no sim imports,
  pure data + pure functions — it exists so non-economy consumers
  (ai.ts's virtual economy) can price materials without importing
  economy.ts, which reads city.ts at module scope (SPEC_ZONE over
  ZoneType); an ai→economy value import completes the
  ai→economy→city→world→ai evaluation cycle that breaks module init.
  economy.ts re-exports everything here; its public API is unchanged.
- `seaTrade.ts` — (civilian sea trade, Half A, 2026-10-01) the sea-trade
  LEAF module: `SEA_ROUTE_SETUP_COST`, the voyage-income formula
  (`seaVoyageIncome`: 40 + 0.25×distance), `MATERIALS_EXPORT_PRICE`,
  the route-ship predicate (`isSeaTradeShip`), and the port-call
  mechanic (`runSeaTradePortCall`). Imports values only from city.ts,
  units.ts, desirability.ts, and routeLifecycle.ts — never economy.ts
  or movement.ts — so
  the movement tick and the AI can consume it without opening a
  movement→economy→city or ai→economy→city→world→ai evaluation cycle
  (economy.ts re-exports `SEA_ROUTE_SETUP_COST`; its public API is
  unchanged — the market.ts precedent). Roadmap B22 (2026-10-02): the
  port-call cargo legs run the shared `cargoTransferAmount` kernel from
  routeLifecycle.ts (which value-imports only from city.ts — the leaf
  stays a leaf).
- `routeLifecycle.ts` — (roadmap B22, 2026-10-02) the shared
  endpoint-route abstraction: `EndpointRoute` (`{id, owner, from, to,
  establishedTick}`) + per-kind `RouteKindHooks` specializing the
  establish / cancel / dead-sweep lifecycle and the kind-specific
  endpoint rule. Airlines and sea trade are both implemented through
  it (one hooks object each) — a third route kind (rail freight?) only
  needs a record type + hooks. Type-only imports (`./city`, `./world`);
  the player lookup is injected via `hooks.getPlayer`, so the module
  opens no value edges and stays out of every module cycle. Also home
  to `cargoTransferAmount`, the shared cargo-transfer kernel used by
  the load/unload commands, the AI virtual loads (commands.ts), and
  the sea port calls (seaTrade.ts): "up to need from available, capped
  both sides, never negative".
- `shipyardRepair.ts` — (naval-building model, 2026-10-01) drydock repair:
  damaged same-side sea units within `SHIPYARD_REPAIR_RADIUS` (14) of an
  operational production shipyard (`commercialHarbor` civilian,
  `shipyard`/`navalYard` military) regain `SHIPYARD_REPAIR_PER_SEC` (3)
  hp/s, capped at the veterancy-adjusted max. Docks never repair —
  production vs. logistics stays unblurred. Called from the combat system
  right after the heal auras; `isShipUnderRepair` is the UI read path.
  Position-derived, no new fields ⇒ no snapshot/digest changes. Leaf:
  value-imports city/units/veterancy only.
- `utilityNetworks.ts` — (grand-expansion Phase 2) the derived utility
  topology: integer-BFS flood fill over conductors (roads ∪ power
  lines/pipes ∪ substation/pumping-station footprints) per player per
  utility. Plants touching the conductor graph seed networks; zone
  regions conduct via underground pipes when any region cell is served.
  Pure functions: `daylightFactor` (240 s day), `windFactor` (seeded),
  `attackMeltdownRoll` (seeded hash — meltdowns are attack-triggered
  ONLY, user correction 2026-09-30; no random trigger), `isMeltedDown`.
  `getUtilityModel` caches on
  (utilityEpoch, online sets, foulers, treatments); storage stocks are
  keyed by plant set so charge survives rebuilds. DERIVED DATA ONLY —
  never snapshotted.
- `desirability.ts` — (workstream W, 2026-09-30) the derived residential
  desirability model: per-residential-cell 0–100 from elevation
  (+0..10), water proximity (+0..15), pollution (−0..25), and the amenity
  table (library/park/school/kindergarten/college/university +5 each ≤12
  cells, museum/theater +5/12 (workstream E), botanical garden +6 ≤16,
  sports stadium +7 ≤17, fire station +3 ≤10 (workstream E), parking lot
  +3 ≤8 / parking garage +4 ≤10 (workstream P — convenience scores below
  the cultural types), `waterfrontAmenity` +10 ≤15 — the Phase 4 marina
  hook — all capped +20). (Workstream E, 2026-09-30) the model is now
  PER-OWNER: `getDesirabilityModel(t, world, owner)` — the green
  (+2 park/garden rows, pollution ×0.8), transit (+2 stop rows), and
  nightlife (−3 ≤8 of commercial) ordinances reshape each owner's map
  differently; the cache key carries the owner's funded policy ids, so a
  funding flip rebuilds the model. Land-value tiers (low ×0.8 / modest
  ×1.0 / nice ×1.3 / prime ×1.7) feed the residential tax multiplier in
  `economy.ts` `runTaxes`; `migrationPullFor` (peaks ×1.594 at d=0.72,
  fades through prime; ×1.15 under the Transit Subsidy, capped 2)
  scales the residential growth roll in `city.ts` `tryAutoDevelop`.
  `getDesirabilityModel` caches on (utilityEpoch, residential zone cells,
  amenity/pollution/nightlife source cells, owner, funded policies) —
  A4 (2026-10-01): narrow invalidation, so plain house completions are
  cache hits, not 22ms rebuilds. DERIVED DATA ONLY — never snapshotted, never in
  the digest. NOTE the intentional value-import cycle city.ts ⇄
  desirability.ts: desirability reads `BUILDING_DEFS`/`footprintCells`
  from city (runtime use only, never at module-eval time), mirroring the
  world⇄city precedent — safe because neither side touches the other's
  exports during module evaluation. The FORBIDDEN cycle remains
  city→commands→movement→pathfinding (the NaN-GRID_CELLS SSR trap,
  2026-09-30); do not add new city→commands edges.
- `digest.ts` — FNV-1a canonical encoding, including full city state.
  Grand-expansion Phase 8 (peaceful mode, workstream A, 2026-09-30):
  the world prefix encodes `|peaceful=0/1|` (behavior-affecting ⇒
  digest-covered); `?? false` keeps pre-flag fixture worlds digesting
  identically. Final-review R2 (2026-10-01): building lines carry
  `hp,maxHp` and unit lines carry `buildingTargetId` — both are
  behavior-affecting ⇒ digest-covered (PLAN §11); `?? def.hp` / `?? 0`
  keep legacy-decoded worlds digesting stably. Final-review R6/L1
  (2026-10-01): digest-gap closure — `city.nextAirlineRouteId` (drives
  the next route's id), the activeBuild Dijkstra heap internals
  (`heapCells/heapPris/heapTies` + sparse `closed`/`waitMark` index
  lists — they decide the next pop), and `delegation.mayors[].buildPolicy`
  (sim write-only today, still snapshotted ⇒ digested) are all encoded;
  pinned by the sensitivity tests in `tests/sim.digest.test.ts`.
- `snapshot.ts` — versioned snapshots (v8: hangar slots on buildings
  + `hangarBuildingId`/`embarkedOn` on units; v7: road classes as
  `RoadCell[]` (v6 `number[]` migrates to `paved`), the rail layer,
  ferry routes on units; v6/v7 still load, v5 with empty upgrades).
  Grand-expansion Phase 8 (peaceful mode, workstream A, 2026-09-30):
  `peaceful` is PURELY ADDITIVE — stays v8, no bump; legacy snapshots
  decode to `false` (the AD9 neutral-default precedent). Final-review
  R2 (2026-10-01): `BuildingRecord.hp`/`maxHp` and
  `UnitRecord.buildingTargetId` are PURELY ADDITIVE on top of v8 —
  legacy snapshots decode hp to the def's full HP and
  buildingTargetId to 0 (no siege in progress), no version bump (AD9).
  Final-review R6 (2026-10-01): malformed-but-readable snapshots throw
  `CorruptSaveError` (not a raw TypeError) — the load-game UI catches it
  for the graceful "save is broken" path back to the menu.
- `terrain.ts` — seeded mapgen (not snapshotted); `spatial.ts` — hash grid.
- `units.ts` — `UnitRecord` store (stable ids, owner/kind/speed/state),
  `spawnUnit` command. Final-review R2 (2026-10-01):
  `UnitRecord.buildingTargetId?: number` (0/undefined = no siege target —
  the siege-target linkage for `attackBuilding`; separate id space from
  `targetId`, and `chasing` covers both). `movement.ts` `orderMoveTo` /
  `stopUnit` clear it (a move supersedes a siege); the `attackUnit`
  apply path clears it too. Grand-expansion Phase 8 (peaceful mode,
  workstream A, 2026-09-30): `UnitDef.military?: boolean` — true on the
  71 war-apparatus kinds (the full 97-kind classification is pinned in
  tests/sim.peaceful.test.ts); `spawnUnit` and `deployMine` validates
  reject military defs loudly in peaceful worlds. Judgment calls are
  recorded in docs/research/phase8-civilian-peaceful.md: engineer,
  hauler, transport/transportShip, cargoFreighter, fuelBarge,
  reconUAV/reconPlane
  (damage 0, the recon exception) are civilian; supplyTruck/fuelTruck/
  fuelTanker, the armed scout `drone` (damage 9, targets both), and the
  whole intel roster are military. The 97-unit roster (31 land:
  engineer, rifles, tank, artillery, aa, hauler, supplyTruck, fuelTruck,
  spectre, hq, sniperTeam, combatMedic, apc, tankDestroyer, mlrs,
  passengerTrain, freightTrain, bus, tram, spy, reconTeam + 10 Mk II/III
  variants: tankMk2/Mk3, artilleryMk2/Mk3, aaMk2/Mk3, apcMk2/Mk3,
  haulerMk2/Mk3; 30 air: fighter, transport, drone, fighterBomber,
  attackHeli, awacs, strategicBomber, maritimePatrol, reconUAV,
  armedUAV, reconPlane, gunship, tanker, militaryCargo, trainer,
  navalFighter, airliner, jumboAirliner, regionalJet, cargoPlane,
  passengerHeli, seaplane + 8 Mk II/III variants: fighterMk2/Mk3,
  fighterBomberMk2/Mk3, attackHeliMk2/Mk3, gunshipMk2/Mk3; 36 sea:
  patrolBoat, destroyer, transportShip, missileBoat, frigate, submarine,
  carrier, commandShip, fishingBoat, ferry, coastalSub, missileSub,
  corvette, cruiser, battleship, heavyDestroyer, cargoFreighter,
  fuelBarge, fuelTanker, ammoShip, repairShip, minelayer, navalMine,
  coastGuardCutter, cruiseLiner, yacht + 10 Mk II/III variants:
  destroyerMk2/Mk3, frigateMk2/Mk3, submarineMk2/Mk3,
  missileBoatMk2/Mk3, transportShipMk2/Mk3 — the civilian fuelBarge
  joined the sea roster with sea-logistics, 2026-10-01) with
  combat stats (`UnitDef`: hp, speed, armor, damage, range,
  minRange, targets, vsArmor/vsAir multipliers, sight). Training costs
  (`trainFunds`/`trainMaterials`) are deducted at spawn; gated units
  require a completed production building (`requiredBuilding`) — basic
  units (engineer, rifles, hauler, drone, transport, patrolBoat,
  transportShip, fishingBoat) have no requirement. Movement state
  (`path`, `fieldId`, `destX/Z`, `arriveX/Z`) and combat state (`domain`,
  `hp`, `cooldownLeft`, `targetId`, `chasing`) live here too, plus
  veterancy state (`xp`, `vetLevel` — see `veterancy.ts`).
- `variants.ts` — tech-level variants, pure (DOM/three-free), Phase 8
  workstream D (2026-09-30): 28 Mk II/Mk III defs across 14 unit lines
  (gated by the EXISTING `spawnUnit` validator — Mk II minAge is one
  age above the base floored at industry, Mk III one age above Mk II; no new validation code).
  `getVariantKinds()` is a LAZY cached getter, never a module-eval const
  — the units→city→world→ai import cycle makes any
  `Object.keys(UNIT_DEFS)` at eval time crash (the pathfinding.ts
  `gridCells()` precedent; ai.ts's `peacefulDistricts()` was lazified
  for the identical reason). `isVariant`, `variantBaseOf`,
  `variantArtBase` (the §AD12 render seam — variants resolve to the
  base kind's `MODEL_SOURCES` entry, zero new `MODEL_PATHS` keys),
  `variantTierOf`, `variantLine`, `isVariantUnlocked` (pure mirror of the
  spawnUnit validator: peaceful/military → minAge → requiredBuilding),
  `chooseVariant` (the AI's situational substitution — M15 tradeoff
  redesign, 2026-10-01: rich owners, `funds >= VARIANT_RICH_FUNDS`
  (8000), take the top affordable tier; everyone else takes the best
  `combatValueOf`/cost — `hp × (damage/cooldown) × (1 + range/50)` for
  combat kinds, `hp × speed × (1 + cargo/100)` for logistics — pure,
  deterministic, never downgrades below the input tier). The AI
  (`ai.ts` `thinkProduction`) substitutes it for `chooseUnitKind`'s
  result. 24 variants are `military: true`
  (peaceful lockout); the 4 civilian variants (haulerMk2/3,
  transportShipMk2/3) are the peaceful tech path. TRADEOFFS, not a
  stat ladder (M15, 2026-10-01): every variant regresses on ≥1 combat
  stat vs its base and improves on ≥1 — the base stays situationally
  right (e.g. assault tank hits harder but is slower than the base
  tank; missile AA outranges everything but has a dead zone and an
  ammo tail; the depot ship feeds fleets but is blind and unarmed).
  Full design table: docs/research/mk-variants.md. Judgment calls are
  recorded in docs/research/phase8-civilian-peaceful.md §D.
- `combat.ts` — deterministic combat resolution: `canTarget` (domain
  checks), `damageMultiplier` (armor counters, vsAir, command auras,
  upgrade hooks), nearest-target acquisition with stable-id tiebreaks
  (upgrade-aware weapon range) on a per-tick dense grid (R1
  final-review H1, 2026-10-01: O(n) rebuild per tick, O(nearby) per
  query — results are exactly the legacy full scan's; R3 final-review,
  2026-10-01: cell 64→16 plus nearest-cell-first exact pruning, so a
  2000-unit dense engagement sweeps in ~17ms instead of 100ms+;
  mass-kill target cleanup is batched — `killUnit` records dead ids
  and `flushDeadTargetRefs` clears attackers' stale `targetId`/`chasing`
  in one O(units) sweep at the end of the combat / superweapon systems,
  so a 500-kill storm tick costs ~4.5ms instead of ~53ms), weapon firing with
  cooldowns, opportunistic fire, explicit `attackUnit` chase orders, death
  cleanup. Roadmap B3 (2026-10-02): while a ceasefire holds, the
  combat loop skips cross-pair opportunistic acquisition (the front
  freezes — neither side gets free kills), and `attackUnit` /
  `attackBuilding` orders against the AI rival break the ceasefire
  (betrayal). Command auras: HQ (+25%, radius 20, all attacker domains) and
  Command Ship (+25%, radius 24, sea attackers only) — definition-driven,
  never stacking. Combat Medics heal friendly living land units in
  radius 12 at 2 HP/s (4 HP/s with Field Medicine). No RNG — fully deterministic.
  Veterancy (Phase 1): `damageMultiplier` and `fireWeapon` apply the
  attacker's level bonuses (+10% damage/sight per level, −10% reload per
  level min 1 tick); kills credit XP in id order before `killUnit`
  removal; Elite units regenerate 2 hp/s; the medic heal cap is the
  veterancy-adjusted max HP. Final-review R2 (2026-10-01): explicit
  `attackBuilding` siege orders — buildings are destructible, sieges
  never auto-fire (explicit order only), and sieging units path to a
  passable stand cell beside the footprint (`siegeStandCell`, nearest
  ring cell, deterministic) rather than the building center.
  `createCombatSystem` / `registerCombatCommands` take an optional
  terrain for the stand-cell scan (headless tests may omit it and get
  the legacy center behavior).
- `ai.ts` — Classic AI, five difficulties (cadet/citizen/commander/general/
  marshal). Seeded per-match personalities (same seed ⇒ identical play;
  different seeds ⇒ different playstyles at the same tier), fair (only
  sees enemies via `getVisibleEnemies()` for units and
  `getVisibleEnemyBuildings()` for buildings — both sight-gated, never
  reads enemy positions directly; `getKnownEnemyBuildings()` latches
  seen buildings into the AI's intel picture (A2, 2026-10-01); water is
  found by probe spawns, never maphack). Counter table is variant-aware
  (`isCounterHeavy`/`isCounterArty` match `variantBaseOf`, A6,
  2026-10-01). Issues standard commands (`spawnUnit`, `moveUnit`, `moveGroup`,
  `attackUnit`, `attackBuilding`, `researchUpgrade`) through the queue — rejections are
  swallowed, never crash the tick. Think cadence: 240/120/60/45/30 ticks.
  Siege doctrine (final-review R2-B, 2026-10-01): when no enemy units
  are visible for N consecutive thinks (N: citizen 3, commander/general
  2, marshal 1; cadet never sieges), the AI escalates from whack-a-mole
  to a siege — it picks the highest-value known enemy building
  (`siegeTargetValue`: military 100 > lab 90 > intel 85 > power/water 70
  > storage 60 > depots 55 > civilian 10; citizen targets the nearest
  building instead), keeps a difficulty-scaled home guard back
  (50/40/30/20%), recalls far-flung stragglers once at campaign start,
  and orders the whole siege force onto the sticky target via
  `attackBuilding` (re-issue deduped on `buildingTargetId`+`chasing`;
  a destroyed building clears the order per tick). Siege state
  (`siegeQuietThinks`, `siegeTargetBuildingId`) is snapshotted and
  digest-covered.
  Army caps: 6/14/26/34/48 (`AI_MAX_UNITS`, exported). Personality
  (`AIPersonality`, plain data): drawn once at `addAIPlayer` from the
  named `ai-<owner>` RNG stream (per-owner streams never shift each other;
  zero draws during thinks) — aggression 0..1 (attack orders every think
  vs every other think), expansionEagerness 0..1 (forward-base threshold
  6..10 + fallback expansion direction), ±30% jitter on base-mix shares
  (the counter table is NOT jittered), a per-match order for the
  economy-line upgrades (the combat/support research head keeps the spec
  §7.4 priority), and a scout waypoint rotation start. Cadet's personality
  is inert (still rifles-only, never attacks). Difficulty meaning is
  untouched: cadence, caps, counters, prereqs, and cadet's passivity are
  exactly as designed — personality varies HOW, not how well. Composition: counters
  first (spec §7.2 — AA up to air+1 then fighters vs air; ×2 frigates per
  sub; submarines/missile-boat packs vs capitals; tank destroyers then
  artillery vs heavy masses; APC/MLRS/artillery vs light masses; spectres/
  snipers/fighter-bombers vs artillery parks; frigate screen vs any navy),
  then base-mix shares of the cap; locked kinds are skipped via `canTrain`
  so the AI never stalls ordering units it cannot receive (the old
  "stuck at 6" failure). Production buildings are virtually constructed in
  priority order (citizen: barracks → warFactory; commander/general: + lab;
  marshal: + airfield, radarStation, shipyard, navalYard when coastal): the
  full cost is paid upfront and the building unlocks after the real build
  time (the Phase 3 superweapon-facility precedent); `hasProductionBuilding`
  (city.ts) covers real + virtual buildings for units and upgrade prereqs.
  Completed virtual buildings yield their def.output (the lab's research
  income is what funds AI research) AND their def.harvest (R1
  final-review C2, 2026-10-01: the marshal's civilAirport landing fees
  are harvest, not output), plus a modest virtual tax stipend scaled by
  difficulty (taxBasePerSec × DEFAULT_TAX_RATE × per-difficulty factor —
  the AI owns no physical buildings, so every economy.ts funds path is
  closed to it) and a materials leg that buys materials on the fixed
  market rate (the industry age's 2500-material cost is unreachable on
  the warFactory trickle alone); upkeep is waived — the AI's abstract
  economy has no tax loop to pay it from. Peaceful AI holds no virtual
  buildings, so the stipend is a no-op for it. Intel play (grand-expansion
  Phase 7, S6 intel, workstream 3, 2026-09-30): commander+ virtually
  constructs intel buildings (listeningPost → intelHQ → signalsStation;
  marshal adds satelliteUplink) via `thinkIntelConstruction` — gated on
  a completed production base, 2× cost funds buffer, and age; the build
  queue is parallel (one per kind) and completed kinds join
  `virtualBuildings.completed`. `creditVirtualIntel` (1 Hz) accrues
  intel assets from virtual intel buildings, mirroring `runIntelAccrual`
  upgrade multipliers. Spy doctrine (`thinkIntelSpies`): marshal trains
  to quota (commander 1, general 2, marshal 3; cadet/citizen none),
  directs free spies to the highest-value visible enemy building
  (`intelTargetValue`: intel 100 > airports 80 > production 70 > depots
  65 > power/water 60), infiltrates on adjacency, then steals tech
  (intel first, 15 surveillance) or sabotages (disruption second, 25
  operational, high-value unsabotaged hosts). Counter-intel surge latches
  when a rival spy is spotted. Intel research (signalsIntel/counterIntel)
  runs in `thinkIntelResearch`, separate from the personality-ordered
  economy line. Per-think spend ledger (`ThinkLedger`, WeakMap by AI):
  every fund/intel-asset spend is reserved before enqueue, so a think's
  command batch never goes stale at apply (stale commands throw by
  design). Covers research+production+spy+age+superweapon-facility
  double-spends (R1 final-review H2: the facility command deducts at
  apply, so its cost is reserved before issue — an unreserved
  same-think spend could otherwise push it stale and crash runTick);
  intel
  asset costs (sabotage 25 operational, steal 15 surveillance) and
  per-think sabotage/steal target sets prevent cross-spy races.
  `stealTech` apply is idempotent (fizzles if the tech was researched
  between enqueue and apply). Upgrade research (commander+,
  spec §7.4): AP Rounds → Composite Armor → Engine Tuning (4+ vehicles) →
  Sonar Suite (subs seen) → Advanced Avionics (3+ aircraft) → the economy
  line in per-match personality order, one per think, age/building/
  affordability pre-validated. Naval:
  commander+ probes for water by trial (32-point ring, 2/think); general+
  works a coastal find (fishing fleet, patrol-boat screen, missile-boat
  packs); landlocked maps conclude after the ring is exhausted. Cadet
  trains only rifles and builds/researches/counters/attacks nothing.
  Marshal advances ages and fires
  superweapons at visible clusters / raises the Aegis when hurting.
  Roadmap B6 (2026-10-02): commander and general advance ages too
  (`thinkMilitaryAges`, Heavy Industry → Cyber Command → Arsenal) —
  below marshal ~40% of the roster was unreachable behind age gates;
  the lower difficulties still advance later (smaller virtual-tax
  stipends), keeping the curve honest. State
  (`AIPlayerState`: owner, difficulty, base, nextThinkTick, forwardBase,
  scoutIndex, builtCounts, superweapons, virtualBuildings, navalStatus,
  navalProbeIndex, navalWater, seenSubmarine, personality) is plain data —
  snapshotted (v6, no bump: missing personalities decode to the neutral
  personality, the step-7 precedent) and digested (personality included).
  `getVisibleEnemies` adds the Signals Grid sight bonus, the effectiveSight
  upgrade hook, veterancy sight, and — grand-expansion Phase 7 (S6 intel,
  workstream 3, 2026-09-30) — the building sight term from
  `buildingSightCoverage` (sim/intel.ts): completed, operational,
  unsabotaged listeningPost/signalsStation SIGINT coverage and
  radarStation radar. The building term runs at AI think cadence only;
  combat's `acquireTarget` never consults it, so a radar contact the AI
  "knows about" still has to be engaged by a unit that can reach it.
  Transport (grand-expansion Phase 4): `thinkCivilianTransport` is a
  documented no-op (civilian buses/trams/trains/ferries have no combat
  role; the civilian trader rival is deferred) and `thinkRoadClasses`
  is a documented no-op (pathfinding reads the per-class move cost
  directly, and the AI never lays or upgrades roads — both pinned by
  digest-unchanged tests).
  Utility networks (grand-expansion Phase 2, §AD2): `thinkConstruction`
  runs the `thinkUtilityConnections` sub-phase, a documented no-op in
  0.1 Alpha — the AI owns no physical buildings (all virtual, no
  footprint), so no AI plant can be stranded and virtual buildings stay
  on the global pool fallback. The hook's comment records the exact
  contract for wiring it to the sim's network diagnostics if the AI ever
  gains physical buildings (think cadence only, `ai-<owner>` stream
  draws only, orders through the queue).
  Air/naval (grand-expansion Phase 5/6, workstream D): `canTrain` is
  hangar-aware — infrastructure aircraft (a `requiredBuilding` AND a
  `hangarClass`) train only while the AI holds a free virtual hangar
  slot (completed virtual airfields yield their
  `defaultHangarSlots`; class-exact-then-generic greedy fit, embarked
  aircraft excluded, zero RNG). Field-operated micro-UAVs (no
  `requiredBuilding`, e.g. the scout drone) are exempt — gating them
  would ground the commander's approved early scouting behind an
  airfield it never builds. Carriers spawn EMPTY
  (`UNIT_DEFS.carrier.wingCapacity`, no embarked aircraft);
  `thinkCarrierWings` acquires one carrier once the escort screen
  exists (2 escorts), trains carrier-capable aircraft into the wing,
  and converges idle carrier-capable aircraft onto the carrier via
  `embarkAircraft`/`moveTo`; `isEmptyWingCarrier` is enforced in BOTH
  attack loops so an empty-wing carrier never chases. The attack loops
  also skip sheltered aircraft and idle carrier-capable aircraft that
  are converging on a carrier (`isConvergingOnCarrier`) — 2b embarks
  them in the same think and the embark applies first, so a same-think
  `attackUnit` for the same aircraft would go stale at apply and throw
  (final-review R5, 2026-10-01). Wing composition
  (final-review R5 H3, 2026-10-01): `pickWingAircraftKind` picks the
  next wing slot armed-first (damage > 0 kinds before unarmed) with at
  most ONE recon spotter per wing (embarked + converging aircraft
  count), null when composition-blocked — the AI no longer fills wings
  with recon-only aircraft. `thinkAirlineRoutes`
  and `thinkNavalMines` are documented no-ops (airline income flows
  through the def.harvest credit; minelaying needs a player-driven
  field doctrine first) — pinned by digest-unchanged tests. Marshal
  builds `civilAirport` (connectivity+, its landing-fee harvest credits
  through the virtual economy). Exported kind sets: `SUB_KINDS`,
  `CAPITAL_KINDS`, `ESCORT_KINDS` (used by the counter table, upkeep,
  and the carrier screen).
  **Cap invariant:** the cap counts ALL of the AI's units, so starting
  forces must leave headroom — `ui/session.ts` gives cadet 2 starters
  (cap 6), everyone else 6 (caps 14/26/34/48).
  Peaceful mode (grand-expansion Phase 8, workstream C, 2026-09-30):
  `canTrain` returns false for `military: true` defs in peaceful
  worlds (buildings gated at `placeBuilding`); `thinkIntel` and
  `thinkSuperweapons` early-return on `world.peaceful === true`; the
  peaceful dispatch runs `thinkPeaceful(world, queue, ai, terrain)` —
  a construction brain with NO new AI state fields, NO RNG, and NO
  snapshot/digest changes. Strategy: the AI is an infrastructure
  provider (paint compact residential/commercial/industrial districts
  → waterPump + powerPlant → two factories for the goods supply →
  houses at funds ≥ 500 → civic/amenities when rich at 2000);
  organic growth (workstream Z) builds shops/houses/farms on the
  districts and shares the treasury, so the AI keeps its own spend
  lean to survive until the income engine comes online (~t=90).
  The armed scout `drone` is military (gated); the peaceful AI has
  no scouts and needs none. `createAISystem(queue, terrain?)` takes
  the optional terrain; `ui/session.ts:381` passes it.
- `ages.ts` — Ages (Foundation → Ascendance) + National Program choice
  (Step 8). **Per-side ages (roadmap A1, 2026-10-01):** `World.ages` is a
  per-owner map (`PerSideAges = Record<number, AgeState>`), NOT one shared
  state — every side advances and pays independently; the age race is
  real (the old global age was a free-rider exploit: whoever paid,
  everyone benefited). `getAgeState(world, owner)` is the lazy-creating
  accessor (missing owner = Foundation); read-only paths (digest,
  snapshot encode) read `world.ages` directly and never create entries.
  Every effect function takes the owner (`getTaxMultiplier(world,
  owner)`, `getSightBonus(world, owner)`, …). `advanceAge` validates and
  applies against the issuing owner's state; the `fromAge` idempotency
  (Phase 9 soak 6.1) compares against the SAME owner's age — two different
  owners advancing on one tick is normal play, not a duplicate.
  `city.ts` reads the owner's age inline (`world.ages[owner]?.age ??
  'foundation'`) and must NEVER value-import ages.ts (ages.ts imports
  `getPlayer` from city.ts — an import would cycle).
  `economy.ts` resolves program multipliers per BUILDING inside the loops
  (`runProduction`, `runTaxes`) — a rival's Heavy Industry never boosts
  your factories. Snapshot: `encodeAgeState` writes the per-owner map;
  `decodeAgeState(data, owners)` restores it — legacy world-global
  snapshots assign their one age state to every current owner (AD9
  additive, stays v8). Digest: per-owner `|ages=<owner>:<age>,<prog>|`
  segments, owner-sorted. `advanceAge` command validates:
  current age is Foundation, program is fiberGrid/signalsGrid, and the
  player can afford the cost (3000 funds + 1200 materials). The choice is
  permanent. Effects: Fiber Grid ×1.25 tax income, stacked with the
  Prosperity Program ×1.5 (`getTaxMultiplierFull`, applied in
  `economy.ts` `runTaxes` — final-review R1 C7, 2026-10-01: runTaxes
  previously used the fiber-only `getTaxMultiplier`, silently dropping
  Prosperity's advertised +50%); Signals Grid +8 sight
  (`getSightBonus`, applied in `ai.ts` `getVisibleEnemies`). `UnitDef`
  carries `minAge`; fighter requires Connectivity (gated in `spawnUnit`
  validation).
- `upgrades.ts` — the 22 researchable upgrades (roster expansion's 12 +
  Phase 2's utility ladder 6 + Phase 3's advancedLogistics + the intel
  roster's signalsIntel/counterIntel + roadmap B9's repeatable
  advancedResearch). Grand-expansion Phase 8 (peaceful
  mode, workstream A, 2026-09-30): `UpgradeDef.military?: boolean` —
  true on the 11 war upgrades (combat lines, fieldMedicine,
  advancedLogistics, signalsIntel/counterIntel; the full classification
  is pinned in tests/sim.peaceful.test.ts); `researchUpgrade` validate
  rejects military defs loudly in peaceful worlds.
  `UpgradeDef`: cost (funds + research), `minAge`, building prerequisites
  (Advanced Avionics needs airfield AND radarStation). `researchUpgrade`
  command: completed lab required; age/prereq/affordability/duplicates
  validated at enqueue and apply; deducts funds/research and appends the
  upgrade id to `world.upgrades[owner]` (plain data — snapshotted v6 and
  digested, owner-sorted/id-sorted). Roadmap B9 (2026-10-02):
  `advancedResearch` is the first REPEATABLE upgrade (the endgame
  research sink): `UpgradeDef.repeatable`, levels on
  `world.upgradeLevels` (owner -> id -> level, snapshotted AD9 without
  a version bump and digest-covered as `|upglvl=|`), priced per level
  by `upgradeResearchCost` (200×level research, zero funds — the single
  price authority for the sim command, the AI ledger, and the UI
  mirror), effect `advancedResearchFactoryMult` (+2% factory output per
  level, additive, applied in economy.ts beside Precision
  Manufacturing). The command skips the duplicate rejection for
  repeatable defs; `hasUpgrade` never covers them. The AI takes it
  fixed-last (excluded from the personality research shuffle,
  re-appended after the economy tail by `researchOrderFor`) once the
  one-shots are done. Effect hooks consumed across the sim:
  `effectiveSight` (AI sight, Drone Optics, Sonar Suite, Advanced
  Avionics), `effectiveRange` (Cruise Missiles), `effectiveSpeed`
  (Engine Tuning), `effectiveHealPerSec` (Field Medicine),
  `effectivePowerSupply` (Smart Grid), `effectiveWaterDemand` (Vertical
  Farming); inline multipliers in `combat.ts` (AP Rounds, Advanced
  Avionics, Sonar Suite), `units.ts` spawn HP (Field Medicine), and
  `economy.ts` (Precision Manufacturing, Vertical Farming, Free Trade).
  Not registered in `ui/session.ts` — UI wires `registerUpgradeCommands`.
- `intel.ts` — (grand-expansion intel roster §3.8/S6, workstream 2 defs +
  sim-core mechanics, 2026-09-30) the intel asset economy, detection,
  and covert operations. Owns: `runIntelAccrual` (deterministic
  per-player asset accrual from `BuildingDef.intelOutput` — completed +
  operational + unsabotaged buildings, placement order, upgrade
  multipliers; wired into the economy tick, dt = 1 sim-second),
  `isDetected(unit, viewerOwner, world)` + `detectionRadiusAt(world,
  owner, x, z)` (the stealth contract: pure position geometry plus the
  unit's `spottedUntil` burn timer — the geometry itself needs zero
  snapshot/digest cost; detectors must be completed + operational +
  unsabotaged, so sabotaging a listening post blinds it),
  `sabotageDurationSec` (counterIntel resistance), `sabotageSpotChance`
  / `stealSuccessChance` (pure roll-chance helpers — the victim's
  stockpiled counter-intel assets sharpen spot checks and blunt steals,
  capped), and `intelSightBonus` (satelliteUplink + signalsIntel —
  the S6 `effectiveSight` hook input). The sim-core half adds the asset
  plumbing (`addIntelAsset` / `spendIntelAsset` — the roster seam),
  spy mission state on `UnitRecord` (`missionEndsAt`,
  `missionTargetId`, `embeddedIn`, `infiltrationProgress`,
  `spottedUntil`; advanced by `createIntelSystem()` every tick), the
  `infiltrateBuilding` / `sabotage` / `stealTech` commands
  (`registerIntelCommands` — adjacency-validated, asset costs,
  deterministic tech pick, research grant via the `addStock`
  precedent; grand-expansion Phase 8, workstream A, 2026-09-30: all
  three validates reject loudly in peaceful worlds — covert ops are
  hostile acts), and the stochastic action rolls (steal success on the
  thief's `intel-<owner>` stream, sabotage spot checks on the victim's;
  failures/spot-checks burn the spy). Consumed by: `acquireTarget`
  (combat.ts skips undetected stealth), `getVisibleEnemies` (ai.ts —
  the AI perceives only what its side detects), `effectiveSight`
  (upgrades.ts += intelSightBonus). Player state shape
  `world.city.players[o].intel` and `BuildingRecord.sabotagedUntil`
  live in `city.ts` (exact contract names). Import discipline (R2):
  value-imports city/units, type-only commands/world/tick; the
  upgrades→intel edge is one-directional (upgrades.ts implements
  `intelSightBonus` next to its only consumer; intel.ts re-exports it
  so the §3.8 contract keeps working — a units→upgrades→intel→units
  value cycle is deliberately avoided); economy.ts imports intel.ts for
  accrual + the sabotage offline gate, so intel.ts must never import
  economy.ts by value (the steal research grant inlines the
  `addStock(player, 'research', n)` mutation instead).
  Workstream 3 (2026-09-30) adds the recon half: `BuildingDef.radarRadius`
  (city.ts — radarStation 90; conventional radar, non-stealthed only),
  `UnitDef.recon` (units.ts — reconTeam, reconUAV, reconPlane),
  `buildingSightCoverage(world, owner)` (the building sight term consumed
  by `getVisibleEnemies` at AI think cadence — SIGINT sees everything
  incl. spies, radar sees non-stealthed only, both gated on completed +
  operational + unsabotaged; satelliteUplink keeps flowing through the
  `intelSightBonus`→`effectiveSight` hook, no geometric term), and the
  mixed-airport discovery lifecycle (`isMixedAirportAnchor`,
  `airportObservedBy` — three observation sources: embedded unburned
  spy, SIGINT coverage, recon overflight — `runAirportDiscovery`,
  `AIRPORT_DISCOVERY_GRACE_TICKS = 1800`): the first observed tick
  creates a `suspected` record on `BuildingRecord.discovery` (THE
  WARNING), which flips to `revealed` after exactly 1800 ticks —
  suspicion latches, no decay, no RNG. Runs every tick via
  `createIntelSystem`. Digest- and snapshot-covered (AD9 additive, stays
  v8). The UI seam lives in ui/airports.ts (`discoveryStateOf`,
  `airportDisplayType`) and ui/intel.ts (`discoveryWarnings`, the rival
  airports list with real discovery state).
- `diplomacy.ts` — minimal two-player diplomacy (roadmap B3,
  2026-10-02). Owns `DiplomacyState` (on `World`: disposition 0..100,
  `ceasefireUntilTick`, tribute totals, last AI answers; one tracked
  pair — a second pair is rejected loudly) and the three commands
  `sendTribute` / `demandTribute` / `proposeCeasefire`
  (`registerDiplomacyCommands`, wired in ui/session.ts). AI verdicts
  (`demandAccepted` / `ceasefireAccepted`) are pure functions of
  disposition, treasury, difficulty pride, and seeded personality
  aggression — no RNG, so replays can't diverge. Ceasefire effects:
  `attacksThisThink` (ai.ts) issues no new attack/siege orders,
  the combat loop skips cross-pair opportunistic acquisition, and
  attackUnit/attackBuilding orders against the AI rival break it
  (betrayal, −15 disposition). Demand/ceasefire reject loudly in
  peaceful worlds; tribute works everywhere. Snapshot-covered (AD9
  additive, stays v8) and digest-covered (`|diplomacy=…|`).
- `veterancy.ts` — unit veterancy (grand-expansion Phase 1, pure: no
  imports from combat/city, so no cycles). `UnitRecord.xp` grows on
  kills (`xpForKillValue = trainFunds + trainMaterials`), `vetLevel`
  derives from cumulative thresholds (300/800/1600 → Regular/Veteran/
  Elite; roadmap B5, 2026-10-02 — softened from 200/500/1000). `awardKillXp` credits the killer in combat's id-order pass;
  a maxed killer's award splits among friendly living non-maxed units
  within 40 (id order, floor shares, remainder to lowest ids; lost with
  no allies). Bonuses: damage/sight ×(1+0.10L), cooldown ×(1−0.10L)
  min 1 tick, maxHp ×(1+0.15·max(0,L−1)), Elite +2 hp/s regen.
  `spawnUnit` graduates armed units to Regular with a completed
  Military Academy (unarmed units exempt). Death erases everything.
  Final-review R2 (2026-10-01): building siege — `attackBuilding`
  orders an explicit siege (validate rejects sheltered/units-that-cant-
  hit-buildings/own-buildings loudly, incl. a peaceful-world reject as
  defense in depth); the combat loop validates the building per tick,
  chases its footprint center when out of range (same reposition rules
  as `attackUnit`), and fires `fireWeaponAtBuilding` in range —
  Aegis check, ammo burn, raw weapon damage scaled only by the
  attacker's veterancy and supply state (buildings have no armor
  class: no armor counters, no auras, no upgrade hooks). `damageBuilding`
  is the one attack-damage path (unit shots + storm strike): it owns
  the nuclear attack-meltdown roll (pure hash of seed/id/tick —
  idempotent per tick, advancedNuclear quadruples the denominator) and
  calls `destroyBuilding` (city.ts) at hp ≤ 0. No XP for structures
  (`awardKillXp` needs a `UnitDef`); buildings never auto-acquire —
  opportunistic fire stays unit-vs-unit (`acquireTarget` is
  unit-only), so `canTargetBuilding` (armed + targets ground/both) is
  consulted only for explicit orders and right-click/UI/AI gates.
- `pathfinding.ts` — deterministic 8-direction A* (octile heuristic,
  corner-cut prevention, water blocking, roads ×0.5) + chunked Dijkstra
  flow fields with early exit + the time-sliced coordinator
  (`PATHS_PER_TICK=3` A*, `FIELD_POPS_PER_TICK=600`). Sea units use a
  separate water-only A* (`findSeaPath`) over sea components — no land
  fallback, cross-component water fails fast with 'no path'.
- `movement.ts` — the pathfinding + movement systems (registered in that
  order), `moveUnit` / `moveGroup` / `stopUnit` commands, waypoint and
  field following, arrival slowdown, formation slots, spatial-hash
  separation.
- `cheats.ts` — cheat command specs (step 11): `cheatGrantResources`
  (`prosperity now`) and `cheatInstantBuild` (`fast build`). Ordinary
  tick-aligned command specs, `issuer: 'cheat'` enforced at validate;
  deterministic fixed effects, no RNG. The `cheated` metadata flag is
  UI-owned (ui/session.ts), never sim state.

## Hangars & carrier wings (grand-expansion Phase 5, workstream B)

The aircraft-shelter system spans five modules; `city.ts` owns the
canonical hangar data model and every other module reads it:

- **Data model (`city.ts`):** `HangarClass` (`'light'|'medium'|'heavy'`),
  `HangarSlot { cls; occupant }` (`occupant` 0 = free; `cls` may be
  `'generic'` on legacy airfields), `LEGACY_AIRFIELD_HANGAR_SLOTS = 6`,
  `defaultHangarSlots(kind)` (airfield → 6 generic; hangarS/M/L →
  typed per-class; else undefined = "never had hangars", AD9),
  `findBuildingHangarSlot`. `placeBuilding` sets `hangars`; `demolish`
  releases parked aircraft inline — mirroring the resupply-release
  loop — because `city.ts` must NEVER value-import `commands.ts`
  (the NaN-GRID_CELLS SSR trap; the two release paths must stay in
  sync manually).
- **Defs + commands (`units.ts`):** `hangarClass` on every air def;
  `carrierCapable` on exactly four kinds (navalFighter, trainer,
  armedUAV, reconUAV); `wingCapacity: 8` on the carrier (trains
  EMPTY — the user requirement). `embarkAircraft {unitId, carrierId,
  owner}`, `baseAircraft {unitId, buildingId, owner}`,
  `launchAircraft {unitId, owner}` — validate≡apply with the slot
  reserved atomically at apply (a stale validate throws
  `CommandRejectedError`, never silently drops). `EMBARK_RANGE = 48`,
  `HANGAR_BASE_RANGE = 64`; helpers `isSheltered(u)`,
  `wingOccupancy(world, carrierId)`, `findHangarSlot(world,
  {kind,id}, cls)` (PLAN §4 S4). Buildings are in cell coords, units
  in world coords — range checks go through `cellCenterWorld`.
- **Movement (`movement.ts`):** `syncEmbarkedPositions(world)` runs
  FIRST in the movement system (id order — out-of-id-order embarks
  stay deterministic); sheltered units skip displacement;
  `validateOwnedUnit` rejects sheltered units loudly.
- **Combat (`combat.ts`):** `acquireTarget` + the combat loop skip
  sheltered candidates; `attackUnit` validate rejects sheltered
  targets; `killUnit` releases the hangar slot and recursively
  destroys a carrier's wing (id order, no XP — ordnance lost with
  the ship).
- **Logistics (`economy.ts`):** supply units load their cargo holds at
  depots inside `serveDepotUnit` (def-driven — any def with cargo
  capacity; the depot aura is the load side);
  `runMobileSupply(world)` runs after `runSupplyAura` (sea-logistics
  2026-10-01, renamed from `runTankerRefuel`): id-ordered supply ships
  (any def with `tankerRefuelRadius` — air `tanker` 40, sea
  `fuelTanker`/`ammoShip` 30) discharge fuel to friendly fossil units
  of their own domain in radius (neediest first) and ammo to friendly
  magazines of their own domain; nuclear units are never refueled
  (data-driven exemption — the user directive). Refuel/rearm supply
  toggles are honored per ship.
- **AI (`ai.ts`):** `BASE_MIX` gains gunship 0.04 + strategicBomber
  0.03 (rifles/tank trimmed, sum 1.0); `thinkCarrierWings` issues
  `embarkAircraft` for carrier-capable aircraft near friendly
  carriers.
- **Persistence:** the v8 snapshot (workstream D) covers
  `hangarBuildingId` / `embarkedOn` / `hangars`. Take is faithful (a
  building without hangars snapshots as absent — the legacy default is
  NEVER invented on save); restore of pre-v8 snapshots decodes hangars
  via `defaultHangarSlots` (legacy airfields → 6 generic, AD9). The
  digest covers the shelter fields (AD11).

## City/economy conventions
- All rates in `BUILDING_DEFS` are **per sim-second**; the economy system
  advances them once per 30 ticks (`ECONOMY_TICKS`).
- Utility allocation is per-player, per-network (Phase 2): plants that
  touch the conductor graph seed flood-fill networks
  (`utilityNetworks.ts`); buildings draw in (BFS distance, building id)
  order. Stranded plants feed the AD2 pool fallback (id order) for
  unreached buildings. Cross-utility hooks read the previous tick's
  flags, with a 1-tick bootstrap (new buildings start assumed-served).
- Growth draws only from the `'city'` RNG stream.
- Balance numbers in `BUILDING_DEFS` / `MARKET_PRICES` are Phase 1
  engineering choices — tune them, but keep the tests' reference-city
  invariants (net-positive materials/food, tax differential) green.

## Movement/pathfinding conventions
- **System order: pathfinding BEFORE movement** every tick. Movement
  consumes freshly completed paths/fields the same tick they land.
- **A* is for single units; flow fields for groups.** A* caps at
  `ASTAR_MAX_EXPANDED` (1000) and falls back to a chunked field; the
  field flood is reverse Dijkstra (charge cost of *entering* the popped
  cell) with early exit at a one-cell margin around waiting units.
- **Directions are derived, not stored during the flood:** each reached
  cell points along argmin(forward step cost + neighbor dist), ties to
  the lowest direction index, with the corner-cut rule. Never point at
  raw neighbor dist alone — road/diagonal costs make that suboptimal.
- **Groups arrive on formation slots** (`slotOffset`: concentric square
  rings, 2.5 apart, no trig) — one unit per slot, never stacked.
  `arriveX/Z` is the unit's own slot; `destX/Z` the ordered point.
- **Separation never fights arrival:** only `moving` units are in the
  separation hash (parked units are invisible to it), and a unit inside
  `SLOW_RADIUS` of its slot ignores pushes. Separation radius (6) >
  slot spacing (2.5) would otherwise deadlock arrival.
- **Loud failures:** unreachable destinations fail at the coordinator
  (`no path`, `unreachable by flow field`) with the unit unmoved — never
  silent, never partial.

## Combat/AI conventions

- **Combat is deterministic and RNG-free.** Target acquisition is nearest
  in range with stable-id tiebreaks. Damage uses armor/domain multipliers
  and the HQ aura (+25% damage within 20 units) — no dice rolls.
- **Explicit vs opportunistic targeting:** `attackUnit` sets `targetId` +
  `chasing = true` (the unit pursues out-of-range targets). The combat
  system may set `targetId` opportunistically for in-range fire without
  setting `chasing`. Tests distinguishing "AI ordered an attack" must
  check `chasing`, not just `targetId`.
- **AI fairness is structural.** The AI never reads enemy positions
  directly — all perception flows through `getVisibleEnemies()`, which
  filters by sight range from the AI's own units PLUS the building
  surveillance term (grand-expansion Phase 7, S6 intel workstream 3,
  2026-09-30: listeningPost/signalsStation SIGINT sees everything
  including spies; radarStation radar sees non-stealthed only; both
  gated on completed + operational + unsabotaged). The AI issues the same
  commands a human would; it never mutates world state directly (except
  its own `world.ai` record).
- **AI respects command validation.** Before issuing `attackUnit`, the AI
  checks `canTarget()` — a rejected command throws `CommandRejectedError`,
  which would break determinism if unhandled. The AI only orders units
  whose weapons can engage the target's domain.
- **AI state is sim state.** `world.ai` is plain JSON-safe data, covered
  by snapshots (v6) and the canonical digest. Deterministic replay and
  save/resume tests must include AI players.

## Determinism contract (non-negotiable)

Same seed + same commands ⇒ identical state, on the same machine/engine.
Everything in this directory serves that:

- **No wall clock, no `Math.random`.** Time enters only through
  `tick.step(world, frameMs)`; randomness only through `rng.ts`. Grep for
  `Math.random`, `Date.now`, `performance.now` before committing — the only
  allowed hits are comments.
- **Fixed system order.** Systems run in registration order every tick
  (`tick.ts`). Never reorder at runtime, never branch order on state.
- **Deterministic iteration.** Iterate `world.entities` (spawn order) or
  explicitly sorted structures. Never iterate a `Map`/`Set` for sim logic
  unless you built it deterministically and can prove the order.
- **Tick-aligned input.** Commands apply at tick starts via
  `commands.ts`, sorted by (tick, issuer, seq). Nothing reads UI/AI state
  mid-tick.
- **Floats are fine, dust is not.** IEEE-754 doubles are deterministic in
  one engine; transcendental use is documented per call site. The
  accumulator epsilon in `tick.ts` exists because float subtraction dust
  (~1e-13/tick) can lose whole ticks — see D9 in ARCHITECTURE.md.
- **RNG streams are named and independent.** `rngBank(world).next('combat')`
  never shifts `'economy'`. Stream state lives in `world.rng` — part of
  every snapshot and digest.
- **`world.time` is derived** (`tick / TICK_HZ`), never accumulated.

## Module conventions

- State is interfaces + factory functions; no methods on state, nothing
  unserializable. If it can't survive `JSON.parse(JSON.stringify(x))`, it
  doesn't belong in the world.
- Snapshots are taken at tick boundaries. The driver's accumulator is
  wall-clock-derived and intentionally excluded.
- Rejections are loud: `CommandRejectedError` / `SnapshotVersionError`
  carry reasons. Never silently skip, coerce, or default.
- New command kinds register a `{ validate, apply }` spec in `commands.ts`.
  Validate at enqueue AND at apply (state may have changed); stale commands
  throw, deterministically.
- Digest changes are significant: if `digestWorld` output changes for the
  same script, something in the sim changed — investigate, don't update
  the test blindly.
