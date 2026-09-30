# AGENTS.md — src/sim

Deterministic fixed-timestep simulation lives here: plain-data world state,
tick driver, commands, systems, pathfinding, spatial index, digest, serialize.
No DOM, no three.js, no Web Audio — the sim must run headless in Node for
tests and the perf harness. See docs/ARCHITECTURE.md §1–§5.

## Module map

- `rng.ts` — mulberry32 + named streams via `createRngBank` / `rngBank`.
- `world.ts` — the `World` store; owns `city: CityState` (imports
  `initCity` from `city.ts`).
- `tick.ts` — 30 Hz accumulator driver, fixed system registration order.
- `commands.ts` — tick-aligned queue, `{ validate, apply }` specs,
  validate-at-enqueue-AND-apply, loud rejections.
- `city.ts` — city grid, roads, zones, buildings, players, placement
  validation, growth. Registers `buildRoad`, `paintZone`,
  `placeBuilding`, `demolish`, `setTaxRate`. Imports `World` type-only —
  this is what breaks the `world.ts` ⇄ `city.ts` cycle (`city.ts` takes
  `createRngBank` directly from `rng.ts` instead of `rngBank` from
  `world.ts`).
- `economy.ts` — the 1 Hz economy system (`createEconomySystem`),
  fixed-rate market (`marketTrade`), tax collection. Pure w.r.t.
  rendering.
- `digest.ts` — FNV-1a canonical encoding, including full city state.
- `snapshot.ts` — versioned snapshots (v6: per-player researched upgrades;
  v5 snapshots still load with empty upgrades).
- `terrain.ts` — seeded mapgen (not snapshotted); `spatial.ts` — hash grid.
- `units.ts` — `UnitRecord` store (stable ids, owner/kind/speed/state),
  `spawnUnit` command. The 28-unit roster (13 land: engineer, rifles,
  tank, artillery, aa, hauler, spectre, hq, sniperTeam, combatMedic, apc,
  tankDestroyer, mlrs; 6 air: fighter, transport, drone, fighterBomber,
  attackHeli, awacs; 9 sea: patrolBoat, transportShip, fishingBoat,
  missileBoat, destroyer, frigate, submarine, carrier, commandShip) with
  combat stats (`UnitDef`: hp, speed, armor, damage, range,
  minRange, targets, vsArmor/vsAir multipliers, sight). Training costs
  (`trainFunds`/`trainMaterials`) are deducted at spawn; gated units
  require a completed production building (`requiredBuilding`) — basic
  units (engineer, rifles, hauler, drone, transport, patrolBoat,
  transportShip, fishingBoat) have no requirement. Movement state
  (`path`, `fieldId`, `destX/Z`, `arriveX/Z`) and combat state (`domain`,
  `hp`, `cooldownLeft`, `targetId`, `chasing`) live here too, plus
  veterancy state (`xp`, `vetLevel` — see `veterancy.ts`).
- `combat.ts` — deterministic combat resolution: `canTarget` (domain
  checks), `damageMultiplier` (armor counters, vsAir, command auras,
  upgrade hooks), nearest-target acquisition with stable-id tiebreaks
  (upgrade-aware weapon range), weapon firing with
  cooldowns, opportunistic fire, explicit `attackUnit` chase orders, death
  cleanup. Command auras: HQ (+25%, radius 20, all attacker domains) and
  Command Ship (+25%, radius 24, sea attackers only) — definition-driven,
  never stacking. Combat Medics heal friendly living land units in
  radius 12 at 2 HP/s (4 HP/s with Field Medicine). No RNG — fully deterministic.
  Veterancy (Phase 1): `damageMultiplier` and `fireWeapon` apply the
  attacker's level bonuses (+10% damage/sight per level, −10% reload per
  level min 1 tick); kills credit XP in id order before `killUnit`
  removal; Elite units regenerate 2 hp/s; the medic heal cap is the
  veterancy-adjusted max HP.
- `ai.ts` — Classic AI, five difficulties (cadet/citizen/commander/general/
  marshal). Seeded per-match personalities (same seed ⇒ identical play;
  different seeds ⇒ different playstyles at the same tier), fair (only
  sees enemies via `getVisibleEnemies()`,
  never reads enemy positions directly; water is found by probe spawns, never
  maphack). Issues standard commands (`spawnUnit`, `moveUnit`, `moveGroup`,
  `attackUnit`, `researchUpgrade`) through the queue — rejections are
  swallowed, never crash the tick. Think cadence: 240/120/60/45/30 ticks.
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
  income is what funds AI research); upkeep is waived — the AI's abstract
  economy has no tax loop to pay it from. Upgrade research (commander+,
  spec §7.4): AP Rounds → Composite Armor → Engine Tuning (4+ vehicles) →
  Sonar Suite (subs seen) → Advanced Avionics (3+ aircraft) → the economy
  line in per-match personality order, one per think, age/building/
  affordability pre-validated. Naval:
  commander+ probes for water by trial (32-point ring, 2/think); general+
  works a coastal find (fishing fleet, patrol-boat screen, missile-boat
  packs); landlocked maps conclude after the ring is exhausted. Cadet
  trains only rifles and builds/researches/counters/attacks nothing.
  Marshal advances ages (Heavy Industry → Cyber Command → Arsenal) and fires
  superweapons at visible clusters / raises the Aegis when hurting. State
  (`AIPlayerState`: owner, difficulty, base, nextThinkTick, forwardBase,
  scoutIndex, builtCounts, superweapons, virtualBuildings, navalStatus,
  navalProbeIndex, navalWater, seenSubmarine, personality) is plain data —
  snapshotted (v6, no bump: missing personalities decode to the neutral
  personality, the step-7 precedent) and digested (personality included).
  `getVisibleEnemies` adds the Signals Grid sight bonus.
  **Cap invariant:** the cap counts ALL of the AI's units, so starting
  forces must leave headroom — `ui/session.ts` gives cadet 2 starters
  (cap 6), everyone else 6 (caps 14/26/34/48).
- `ages.ts` — Ages (Foundation → Connectivity) + National Program choice
  (Step 8). `AgeState` (`age`, `program`) lives on `World.ages`, plain
  data — snapshotted (v6) and digested. `advanceAge` command validates:
  current age is Foundation, program is fiberGrid/signalsGrid, and the
  player can afford the cost (3000 funds + 1200 materials). The choice is
  permanent. Effects: Fiber Grid ×1.25 tax income (`getTaxMultiplier`,
  applied in `economy.ts` `runTaxes`); Signals Grid +8 sight
  (`getSightBonus`, applied in `ai.ts` `getVisibleEnemies`). `UnitDef`
  carries `minAge`; fighter requires Connectivity (gated in `spawnUnit`
  validation).
- `upgrades.ts` — the 12 researchable upgrades (roster expansion, Phase 4).
  `UpgradeDef`: cost (funds + research), `minAge`, building prerequisites
  (Advanced Avionics needs airfield AND radarStation). `researchUpgrade`
  command: completed lab required; age/prereq/affordability/duplicates
  validated at enqueue and apply; deducts funds/research and appends the
  upgrade id to `world.upgrades[owner]` (plain data — snapshotted v6 and
  digested, owner-sorted/id-sorted). Effect hooks consumed across the sim:
  `effectiveSight` (AI sight, Drone Optics, Sonar Suite, Advanced
  Avionics), `effectiveRange` (Cruise Missiles), `effectiveSpeed`
  (Engine Tuning), `effectiveHealPerSec` (Field Medicine),
  `effectivePowerSupply` (Smart Grid), `effectiveWaterDemand` (Vertical
  Farming); inline multipliers in `combat.ts` (AP Rounds, Advanced
  Avionics, Sonar Suite), `units.ts` spawn HP (Field Medicine), and
  `economy.ts` (Precision Manufacturing, Vertical Farming, Free Trade).
  Not registered in `ui/session.ts` — UI wires `registerUpgradeCommands`.
- `veterancy.ts` — unit veterancy (grand-expansion Phase 1, pure: no
  imports from combat/city, so no cycles). `UnitRecord.xp` grows on
  kills (`xpForKillValue = trainFunds + trainMaterials`), `vetLevel`
  derives from cumulative thresholds (200/500/1000 → Regular/Veteran/
  Elite). `awardKillXp` credits the killer in combat's id-order pass;
  a maxed killer's award splits among friendly living non-maxed units
  within 40 (id order, floor shares, remainder to lowest ids; lost with
  no allies). Bonuses: damage/sight ×(1+0.10L), cooldown ×(1−0.10L)
  min 1 tick, maxHp ×(1+0.15·max(0,L−1)), Elite +2 hp/s regen.
  `spawnUnit` graduates armed units to Regular with a completed
  Military Academy (unarmed units exempt). Death erases everything.
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

## City/economy conventions
- All rates in `BUILDING_DEFS` are **per sim-second**; the economy system
  advances them once per 30 ticks (`ECONOMY_TICKS`).
- Utility allocation is id-ordered and per-player; every completed
  plant/pump contributes supply (no road requirement since 2026-09-30 —
  user directive: roads are optional).
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
  filters by sight range from the AI's own units. The AI issues the same
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
