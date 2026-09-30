# Phase 8 — Civilian roster & peaceful mode: design decisions (sim core)

Workstream A, 2026-09-30. This note records the judgment calls behind the
peaceful-mode sim foundation: the military predicate, the per-kind
classification, the victory numbers, the disasters audit, and the
sandbox-vs-peaceful split. Sibling contracts (do not rename):
`world.peaceful`, `SessionOptions.peaceful`, def flag `military?: boolean`,
`checkPeacefulVictory(world, owner)`, `peacefulObjectiveProgress(world, owner)`.

## 1. The military predicate

Peaceful mode is a *data-driven lockout*, not a mode flag with special-case
logic scattered through the sim. Each def (unit, building, upgrade) carries an
optional `military?: boolean` flag; in a peaceful world (`world.peaceful`),
the command layer rejects military defs LOUDLY at validate (enqueue) with a
`CommandRejectedError` that the HUD surfaces as a toast. Nothing fails
silently. The flag is set at tick 0 from `SessionOptions.peaceful` and is
never toggled mid-game, so enqueue-time validation is definitive — no
apply-time re-check is needed.

Lockout points (all in `game/src/sim`):
- `units.ts` — `spawnUnit` validate (military defs); `deployMine` validate
  (defense in depth — the minelayer is military-locked anyway).
- `city.ts` — `placeBuilding` validate.
- `upgrades.ts` — `researchUpgrade` validate.
- `intel.ts` — `infiltrateBuilding` / `sabotage` / `stealTech` validates
  (covert ops are hostile acts; the whole intel roster is military for
  peaceful purposes).
- `superweapons.ts` — `constructSuperweaponFacility`, `fireStorm`,
  `fireAegis` validates. This one matters: the Marshal AI builds
  superweapon facilities *virtually* (never through `placeBuilding`), so
  the `placeBuilding` lockout alone would not stop a peaceful-world Marshal
  from reaching Ascendance and firing a Storm. The `fireStorm` gate is also
  the backstop for the meltdowns finding below.

The AI's `issue` wrapper already swallows `CommandRejectedError` — the AI
keeps playing peacefully without stalling or crashing. Teaching the AI to
play a *good* peaceful game (economy-only production choices, no wasted
thinks) is the AI workstream's job, not the sim core's.

## 2. Per-kind classification

Principle: a def is military when its *purpose* is war — combat units,
military production, military logistics, superweapons, the intel roster.
Unarmed recon is the deliberate exception (civilian). Everything else is
civilian, including dual-use logistics and the civilian airport/port
pieces. Counts (pinned in `tests/sim.peaceful.test.ts`):

- **Units: 96 — 71 military / 25 civilian** (28 Mk II/III variants: 24
  military + 4 civilian hauler/transportShip).
- **Buildings: 99 — 21 military / 78 civilian** (10 Phase 8 civilian
  additions, all civilian).
- **Upgrades: 21 — 11 military / 10 civilian.**

### Judgment calls (the non-obvious ones)

**Civilian:**
- `engineer` — the game's builder; the 5-damage sidearm is flavor, not a
  weapon system.
- `transport`, `transportShip` — unarmed, no production-building
  requirement; logistics, not war.
- `hauler` — civilian logistics (and the peaceful starting-forces swap
  for rifles).
- `cargoFreighter` — def comment: "civilian sea income".
- `reconUAV`, `reconPlane` — damage 0, `recon: true`; the recon-only
  exception. (Unreachable in practice — both require the airfield, which
  is military-locked — but classified by purpose, not reachability.)
- Civilian airport pieces (`civilAirport`, terminals, control tower,
  hangars, fuel farm, maintenance hangar, runways) and civilian ports
  (`commercialPort`, `containerPort`, `fishingHarbor`) — the civilian
  airline economy must keep working in peaceful games.

**Military:**
- `supplyTruck`, `fuelTruck` — the field-resupply chain exists to service
  military units; without an army it has no purpose.
- `fuelTanker` — def comment: "naval supply ship (Phase 3 logistics on
  water)".
- `shipyard` — verified by grep: it gates only `missileBoat`, `ammoShip`,
  `repairShip`, `minelayer` (all military). The civilian sea units need no
  production building, so nothing civilian is stranded by the lockout.
- `mixedAirport` — hosts combat aircraft.
- `drone` (the scout drone) — damage 9, `targets: 'both'`; armed, so
  military despite the recon role.
- `combatMedic`, `spy`, `reconTeam`, `trainer`, `tanker`, `militaryCargo`,
  `awacs`, `coastGuardCutter` (armed), `minelayer`, `repairShip`,
  `ammoShip` — all military by the purpose rule.
- Upgrades: `apRounds`, `compositeArmor`, `engineTuning` (the six vehicle
  kinds in `ENGINE_TUNING_KINDS` are all military), `advancedAvionics`,
  `sonarSuite`, `cruiseMissiles`, `droneOptics` (drone + spectre sight
  line), `fieldMedicine` (barracks-gated, buffs combat troops),
  `advancedLogistics` ("the military-logistics upgrade": depot/ammo
  capacity for the resupply chain), `signalsIntel`, `counterIntel` (the
  whole intel roster is hostile apparatus for peaceful-mode purposes).

## 3. Victory numbers

**Win = reach 8,000 housed residents with a non-negative treasury.**

Why 8,000: an apartment block houses 30 on a 3×3 footprint, so 8,000 ≈
267 apartments ≈ 2,400 city-grid cells — under 4% of the 256×256 grid. A
genuinely large, thriving city, not a quick milestone: reachable by a
focused builder in a long game without paving the map. Trivially small
targets (1–2k) would fire on any decent start and teach nothing; the
population is the binding constraint.

The treasury floor (funds ≥ 0) is a cheap honesty guard, not a real
hurdle: every funds spend path in the sim is affordability-gated
(validate-at-enqueue + the upkeep funding cap), so the treasury cannot
go negative in normal play. If it ever does (cheats, future debt
mechanics), the victory rightly withholds.

No "influence" system exists in 0.1 Alpha — none was invented. PLAN §3.9's
"population / influence / scenario goals" is satisfied by population now;
influence and scenario goals stay UI/campaign work.

No defeat path: with every military def locked out, conquest is
unreachable, so peaceful games can only be won, never lost. The conquest
checks (`checkSkirmishVictory` / `checkSkirmishDefeat` /
`getSkirmishOutcome` in `ui/session.ts`) return false/null for peaceful
worlds, and `game.ts`'s `maybeShowConquestOutcome` early-returns — the
two victory systems never race.

## 4. Disasters audit

There is no general disaster system in 0.1 Alpha (no earthquakes, plagues,
famines, droughts, wildfires — grep confirms; the only hits are algorithm
comments). The one catastrophe mechanic is the **nuclear meltdown**, and it
triggers ONLY on attack damage to nuclear plants; the only current attack
path is the Storm Engine superweapon strike (`attackMeltdownRoll` in
`superweapons.ts`, seeded hash — user correction 2026-09-30: meltdowns
are attack-triggered only, never random).

In peaceful mode both superweapon buildings (`stormArray`,
`aegisControl`) are military-locked at `placeBuilding`, the Marshal AI's
virtual-construction path is locked at `constructSuperweaponFacility`,
and both fire commands are locked at validate. **Meltdowns are therefore
impossible in peaceful mode by construction** — no disaster handling is
needed for the mode.

## 5. Sandbox vs peaceful (not the same thing)

- **Sandbox** (`SessionOptions.sandbox`): no AI rival at all, no victory
  condition. The living menu demo uses it.
- **Peaceful** (`SessionOptions.peaceful`): the Classic AI rival EXISTS
  and plays — it just plays peacefully (its military orders are rejected
  and swallowed). Conquest is bypassed; the peaceful victory applies.

This overrides PLAN §3.9's "no AI rival" line — per the task, peaceful
keeps the rival.

## 6. Snapshot / digest migration

`world.peaceful` is snapshotted faithfully and restored with `?? false` —
legacy snapshots (which predate the field) decode to false: no old save
was peaceful, so the neutral default reproduces the old behavior exactly.
No version bump (stays v8) — the AD9 additive-field precedent from the
Phase 7 intel work.

The digest covers the flag (`|peaceful=0/1|` in the world prefix) because
it is behavior-affecting (command lockout + victory routing). Verified:
no golden digest values exist in the test suite (all digest tests compare
run-vs-run), so the prefix change is safe.

## 7. Starting forces

Peaceful sessions must not spawn rifles (military-locked): the opening
force swaps the 4 rifles for 4 haulers (same count — the AI's
production-cap headroom math is unchanged). Haulers cost 120 funds + 20
materials each; the 4000/1500 starting stocks absorb them.

## 8. Out of scope (recorded)

- Tech levels (Mk II/III variants) from PLAN §3.9 — ~~a later workstream~~
  delivered by workstream D, 2026-09-30 (see §D below; this line is
  flipped, not deleted, so the history reads).
- The peaceful victory UI panel and end screen — the sibling UI workstream.
- AI peaceful-play quality (economy-only choices) — the AI workstream.
- `ui/palettes.ts` still hand-groups upgrades (military 8 / economy 4 /
  infrastructure 6 / logistics 1 / intel 2); the UI workstream may switch
  those groups to the new `military` def flags.

---

# Workstream E — Civilian deep-dive: 10 buildings + 5 city ordinances (2026-09-30)

The civilian roster from 89 to 99 buildings and a new Management-tab
"City ordinances" section: five city-wide policy toggles with REAL upkeep
costs and REAL effects on existing systems. No new sim currencies, no
placebo mechanics — every building does something through an existing
system (funds/manpower/research/influence output, tax base, jobs,
amenity rows), and every ordinance is paid for.

## E.1 The ten buildings

| Building | Zone | Age | Cost (funds/mat) | Upkeep | Output | Amenity row |
|---|---|---|---|---|---|---|
| Museum | utility | connectivity | 700/250 | 0.9 | research 0.15 | +5/12 (cultural) |
| Theater | utility | connectivity | 900/300 | 1.2 | funds 0.8 | +5/12 (cultural) |
| Sports Stadium | utility | industry | 2200/900 | 2.5 | funds 1.5 | +7/17 |
| Botanical Garden | utility | foundation | 600/200 | 0.5 | influence 0.1 | +6/16 |
| Grand Market | commercial | industry | 1500/600 | 2.2 | funds 5.0 (in: food 1, goods 1) | — |
| Bank | commercial | connectivity | 500/180 | 0.8 | funds 1.2 | — |
| Office Tower | commercial | industry | 1200/450 | 1.8 | funds 2.0 | — |
| Clinic | commercial | foundation | 300/100 | 0.5 | manpower 0.2 | — |
| Medical Center | commercial | industry | 2000/800 | 3.0 | manpower 1.0 | — |
| Fire Station | utility | foundation | 350/120 | 0.4 | — (pure amenity) | +3/10 (convenience) |

Design reasoning:
- **Grand Market** is the market's 2× big brother: exactly twice the
  funds output (2.5 → 5.0) and inputs (food/goods 0.5 → 1.0), industry
  age, 4×4. The "versions of everything" family for commerce.
- **Bank → Office Tower** fill the commercial finance/employment tier
  the roster lacked (jobs 10 → 40).
- **Clinic → Hospital → Medical Center** is the health ladder the user
  asked for: manpower output scales 0.2 → 0.4 → 1.0, foundation →
  connectivity → industry. Hospitals heal through manpower — no new
  currency.
- **Museum** joins the education research set (`EDUCATION_RESEARCH_KINDS`
  = kindergarten/school/college/university/library/museum). The lab and
  radarStation are deliberately excluded — research from *culture* gets
  the ordinance bonus, research from *labs* does not (labs are already
  the strongest research source).
- **Fire Station** is the first pure-amenity building: no output, just
  the +3/10 safety row. Placed at the convenience tier (+3, like
  parking) — reassuring, not beloved.

All ten carry `military: false` explicitly (the workstream-A contract —
civilian, peaceful-buildable). Pinned in `tests/sim.civilian.test.ts`.

## E.2 The five ordinances

| Ordinance | Upkeep (funds/s) | Effects (all apply only while FUNDED) |
|---|---|---|
| Green Initiative | 0.6 | +2 on park/botanical-garden amenity rows; pollution penalty ×0.8 |
| Transit Subsidy | 0.5 | +2 on all 7 transit-stop amenity rows; ridership income ×1.25; migration pull ×1.15 (capped 2) |
| Business Incentives | 0.8 | commercial-zone funds output ×1.15 |
| Nightlife Ordinance | 0.3 | commercial-zone funds output ×1.10; −3 desirability within 8 cells of commercial buildings |
| Education Grants | 0.4 | education growth bonus doubled (0.05→0.10/school, cap 0.25→0.50); education research output ×1.25 |

Balance reasoning (why these numbers):
- Upkeeps are priced against building upkeeps of the same era: the
  Green Initiative (0.6) costs about as much as a park's bigger brother;
  Business Incentives (0.8) is the priciest because ×1.15 on ALL
  commercial funds compounds across a mature downtown.
- Business ×1.15 and Nightlife ×1.10 stack multiplicatively (×1.265)
  — deliberate: running both is the "downtown at full roar" play, at a
  combined 1.1 funds/s plus the nightlife desirability price.
- The nightlife −3/8 is the ordinance's *cost made visible*: the same
  commercial buildings that earn more become bad neighbors. Players
  zone around it.
- Transit Subsidy is the cheapest *payoff* ordinance: ×1.25 ridership
  only pays when the player actually built transit — it rewards the
  network, not the toggle.
- Education Grants doubles the growth bonus AND ×1.25 research, but the
  growth bonus only counts kindergartens/schools (not the whole ladder)
  — the player still has to build the foundation.

The funding rule (the building-upkeep precedent): policies fund AFTER
buildings in the economy tick's upkeep pass, in `POLICY_IDS` order, from
whatever affordable funds remain. An unfunded policy is charged nothing
and its effects do NOT apply that tick. All effects read
`policyFunded(world, owner, id)` — never the raw toggle. The `setPolicy`
command's validate requires a 60-second upkeep runway to turn a policy
ON (loud rejection when broke); turning OFF is always free.
`fundedPolicies` is derived per-tick state — never snapshotted, never
digested (the desirability-model precedent).

## E.3 The desirability model goes per-owner

`getDesirabilityModel(t, world, owner)` now takes the owner: the green,
transit, and nightlife ordinances reshape each owner's map differently.
The cache key carries the epoch, the completed-building ids, the owner,
AND the owner's funded policy ids — a funding flip rebuilds the model.
All call sites pass the viewing player (the render overlay passes the
human player). One cycle was introduced and fixed the same day:
`ui/desirability.ts` briefly imported `ui/session` for the human-player
constant, which created a module-eval cycle (ui → session → sim/ai →
sim/city mid-evaluation); the owner is now a parameter instead.

New amenity rows: museum/theater +5/12, botanical garden +6/16, fire
station +3/10, sports stadium +7/17. The stadium number is a sibling
coordination: the transit-stops suite pins the central station as the
biggest non-waterfront row (+8/18), so the stadium sits one step below
at +7/17 — still the biggest CIVIC building. The fire station's +3 ties
the parking lot's bonus, so it joins the parking test's exclusion set
(the small-transit-stops precedent) rather than the strict
below-everything comparison.

## E.4 The AI seam

`setPolicy` is a plain `CommandSpec` (payload `{ owner, policy,
on: 0|1 }`) with loud plain-English validation — the AI workstream's
clean seam, documented in city.ts. The AI issues it exactly like
`setSpecialization`. Ordinances are civilian city management: never
locked out in peaceful games.

## E.5 Art decision (no new model keys — AD12)

All ten buildings map onto existing GLB keys (verified against
`MODEL_PATHS`): museum→university, theater→college, grandMarket→2×
market (offset ±2), bank→shop, officeTower→apartment, clinic→lab,
medicalCenter→hospital; sportsStadium/botanicalGarden/fireStation→
`procedural` (the Phase-4-hub precedent: a placeholder until the render
pass gives them real models). Zero new boot-download weight.

## E.6 Snapshot / digest

- Snapshot: `policies` copies verbatim (`?? {}` for legacy saves — no
  version bump, stays v8, the AD9 additive-field precedent);
  `fundedPolicies` resets to `[]` (re-derived on the next tick).
- Digest: `|pol<owner>=<active ids in POLICY_IDS order>;` — toggles are
  behavior-affecting (they change funding, desirability, production,
  migration) so they are covered; `fundedPolicies` is not (pure function
  of covered inputs). UI digest: `oc:` + 5 × 2-char states
  (`po:` was already claimed by workstream B's peaceful-objectives
  section — ordinances are "city ordinances", hence `oc:`).

## E.7 Open handoff (not workstream E's to close)

The ten buildings live in defs, icons, strings, render, sim, and tests —
but NOT in `BUILD_TABS` (`ui/palettes.ts` is sibling-owned and was not
touched). Until the palettes-owning workstream adds the ten kinds to
their tabs, the buildings are unplaceable from the UI and
`tests/sim.parking.test.ts`'s 89→99 palette-membership assertion fails
on the new kinds (flagged in the test with a NOTE). The natural homes:
museum/theater/sportsStadium/botanicalGarden/fireStation → the civic
tab; grandMarket/bank/officeTower/clinic/medicalCenter → the commerce
tab.

**Resolved 2026-09-30 (integration gate):** the 10 kinds were added to
`BUILD_TABS` (5 civic + 5 commerce), `tests/sim.parking.test.ts` and
`tests/ui.palettes.test.ts` grouping expectations updated — the full
suite is green.

---

# Workstream D — Tech-level variants: Mk II / Mk III across 14 unit lines (2026-09-30)

PLAN §3.9's "tech levels" line, delivered as a pure sim-side roster pass.
No validation code was added: every variant is gated by the EXISTING
`spawnUnit` validator (peaceful/military predicate → minAge → requiredBuilding),
so the whole feature is 28 defs + one pure helper module + render/AI/UI
seams.

## D.1 Roster (14 bases × 2 tiers = 28)

| Base | Mk II (base+1, floored at industry) | Mk III (Mk II+1) | Keeps base's requiredBuilding |
|---|---|---|---|
| tank | tankMk2 | tankMk3 | warFactory |
| artillery | artilleryMk2 | artilleryMk3 | warFactory |
| aa | aaMk2 | aaMk3 | warFactory |
| apc | apcMk2 | apcMk3 | warFactory |
| hauler | haulerMk2 | haulerMk3 | — (civilian tech path) |
| fighter | fighterMk2 | fighterMk3 | airfield |
| fighterBomber | fighterBomberMk2 | fighterBomberMk3 | airfield |
| attackHeli | attackHeliMk2 | attackHeliMk3 | airfield |
| gunship | gunshipMk2 | gunshipMk3 | airfield |
| destroyer | destroyerMk2 | destroyerMk3 | navalYard |
| frigate | frigateMk2 | frigateMk3 | navalYard |
| submarine | submarineMk2 | submarineMk3 | navalYard |
| missileBoat | missileBoatMk2 | missileBoatMk3 | shipyard |
| transportShip | transportShipMk2 | transportShipMk3 | — (civilian tech path) |

Excluded deliberately: infantry, intel units, support trucks (role, not
power, units), and the capitals (already endgame). Base ages run
foundation (tanks, artillery, AA, APCs, haulers) → connectivity
(fighters, attack helis, missile boats) → industry (jets, gunships,
warships, transport ships); Mk II unlocks one age above the base,
floored at industry (so foundation-base lines jump straight to
industry — no variant before the industrial military complex), Mk III
one age above Mk II. The top of each line lands in information or
ascendance, the game's last age.

## D.2 Stat progression (real upgrades, not reskins)

- Mk II ≈ hp×1.3, damage×1.25, speed×1.1, fuel×1.2, cost×1.6, manpower+1.
- Mk III ≈ hp×1.6, damage×1.5, speed×1.2, fuel×1.4, cost×2.5, manpower+2.
- Role bumps: aa/fighter anti-air damage; artillery/submarine range;
  larger ammo magazines (fighters, gunships, missile boats); hauler
  cargo 40/20 → 70/35 → 100/50 (fuel/ammo); transportShip (a troopship,
  no cargo fields) fuel-legs 120 → 144 → 168.

## D.3 Peaceful mode

24 of the 28 variants carry `military: true` (workstream A's lockout
applies unchanged — 71 military units total now: 47 base + 24 variant).
The 4 civilian variants (haulerMk2/3, transportShipMk2/3) are the
peaceful-mode tech path: a builder can still research upward.

## D.4 Code seams

- `game/src/sim/units.ts`: `UnitDef.variantOf?: UnitKind` +
  `variantTier?: number`; 96 defs (31 land / 30 air / 35 sea).
- `game/src/sim/variants.ts` (new, pure, DOM/three-free): `getVariantKinds()`
  (LAZY getter, not a module-eval const — the units→city→world→ai import
  cycle makes any `Object.keys(UNIT_DEFS)` at eval time crash; the
  pathfinding.ts `gridCells()` precedent), `isVariant`, `variantBaseOf`,
  `variantArtBase` (the §AD12 render seam), `variantTierOf`,
  `variantLine`, `isVariantUnlocked` (pure mirror of the spawnUnit
  validator), `preferHighestVariant` (highest unlocked + affordable tier;
  deterministic; never downgrades).
- `game/src/render/entities.ts`: `modelSourceFor` / `hullSizeFor` /
  `proceduralFor` resolve through `variantArtBase` — zero new
  `MODEL_PATHS` keys (§AD12, the §10 art budget).
- `game/src/sim/ai.ts`: `thinkProduction` substitutes
  `preferHighestVariant(world, owner, chooseUnitKind(…), thinkLedger(ai))` —
  the AI trains the best tier it has unlocked and can afford; citizens in
  peaceful games train the civilian variants.
- `game/src/ui/icons.ts`: provisional glyphs (base glyph + `>` / `>>`
  chevron, the Phase 3 provisional-glyph precedent) keep the
  tsc-enforced `Record<UnitKind, string>` complete; the UI workstream
  owns final art, TRAIN_TABS placement, and `STRINGS.unitNames` entries.
  **Resolved 2026-09-30 (integration gate):** all 28 variants placed in
  TRAIN_TABS next to their base kinds, all 28 `STRINGS.unitNames`
  entries added ("<base> Mk II/III").

## D.5 Tests

`game/tests/sim.variants.test.ts` — 44 tests: roster shape, helper
consistency, domain/targets no-drift, stat progression, cost scaling,
cargo/fuel-leg growth, the 15-variant gating matrix (locked below
minAge / locked without building / unlocked with both), the 24/4
military/civilian split, `preferHighestVariant` (unlock, affordability,
ledger reservations, never-downgrade, determinism), AI integration
(citizen AI with a warFactory in industry trains `tankMk2`, never base
`tank`), peaceful lockout (24 military variants rejected, 4 civilian
trainable), snapshot round-trip, digest determinism, and the §AD12 art
contract (modelSourceFor deep-equals base; hullSizeFor equals base; zero
new MODEL_PATHS keys).

## D.6 Dead ends / gotchas (for the next workstream)

- **Eager `VARIANT_KINDS` const crashed at import time** (`Cannot convert
  undefined or null to object` at `Object.keys(UNIT_DEFS)`): first
  reached through the ai.ts → variants.ts edge while `units.ts` was
  still partially evaluated. Fix: lazy getter + cached (this bit workstream
  D; the sibling workstream A's `PEACEFUL_DISTRICTS` in ai.ts had the
  identical disease via `ZoneType` and was lazified the same way).
- `missileBoat`'s building is `shipyard`, not `navalYard` — check the def,
  not the pattern.
- `transportShip` is a troopship: it has `fuelCapacity` but NO cargo
  fields, so its tech line grows fuel-legs, not cargo.
- The initial military-variant count was 26, wrongly including the
  hauler/transportShip variants; the correct split is 24 military / 4
  civilian (71 military of 96 total).

## C. Peaceful AI (workstream C, 2026-09-30)

The Classic AI's peaceful branch (`game/src/sim/ai.ts`, `thinkPeaceful`).
The military AI's build/combat/intel/superweapons branches early-return
on `world.peaceful === true`; the peaceful AI is a separate
construction brain with no new AI state fields, no RNG, and no
snapshot/digest changes (determinism contract intact).

### C.1 Military lockout

`canTrain` returns false for any def with `military: true` in a
peaceful world (units). Buildings are gated at the `placeBuilding`
command layer (workstream A). The armed scout `drone` is military
(gated); the civilian `reconUAV`/`reconPlane` need a military-locked
airfield, so in practice the peaceful AI has no scouts — and needs
none (no combat, no forward base, no think branch requires vision).

`createAISystem(queue, terrain?)` takes an optional terrain handle;
the peaceful dispatch calls `thinkPeaceful(world, queue, ai, terrain)`.
The single non-test caller (`ui/session.ts:381`) was updated to pass
the session terrain.

### C.2 Strategy (measured, not designed)

The peaceful AI is an infrastructure provider; organic growth
(workstream Z, city-global, builds on the AI's painted zones and
spends the same treasury) is the city builder. The AI keeps its own
spend lean so the shared 4000-fund starting treasury survives until
the income engine comes online (~t=90):

1. **Zoning** — paints three compact districts (residential 8×8,
   commercial 6×6, industrial 8×8) via the `paintZone` command,
   ledger-guarded. Zones apply on the next tick; the AI verifies a
   district is actually painted before siting on it.
2. **Utilities** — waterPump + powerPlant first (foundation age;
   the only foundation power/water).
3. **Income engine** — two factories (3.0 goods/s supports up to 6
   shops). Organic builds shops on the commercial district; the AI
   builds no shops itself.
4. **Early housing** — houses when funds ≥ 500 (guarantees population
   growth even if organic builds slowly).
5. **Civic/amenities** — schools, markets, etc. only when rich
   (funds ≥ 2000).

Economy numbers (from defs): powerPlant 900f/350m, waterPump
350f/120m, factory 550f/220m (goods 1.5/s), shop 220f/70m (funds
1.8/s, needs goods 0.5/s), farm 300f/80m (food 3.0/s), house 120f
(6 pop), apartment 450f/160m (30 pop). Starting stocks: 4000 funds /
1500 materials / 500 food.

### C.3 Dead ends (for the next workstream)

- **Age-gate blind spot**: `windFarm`/`market` have `minAge`
  requirements; the placement pre-check didn't cover the command's
  age gate, so orders were rejected at enqueue (silently swallowed).
  Fix: `peacefulKindAvailable()` filters on age/`requiredBuilding`/
  `requiredUpgrade`.
- **Upkeep death spiral**: if funds hit exactly 0, nothing is
  funded, no income is earned, and the city stalls permanently.
  The AI cannot reserve against organic growth's spend — it must
  keep its own footprint lean and get income online fast.
- **Goods starvation**: 4 shops (2.0 goods/s) on 1 factory
  (1.5/s) starves the 4th shop. Two factories are the minimum
  once organic shops arrive.
- **District overlap**: `findLandRect` terrain shifts (±10 search)
  can push districts onto each other; each district now avoids the
  earlier ones, and siting verifies the zone is painted.

### C.4 Tests

- `game/tests/sim.ai-peaceful.test.ts` (5 tests): `canTrain` gates
  military units in peaceful worlds (civilian allowed, unchanged in
  war worlds); peaceful dispatch issues zero military orders and
  zero rejections over 600 ticks; builds a civilian city (no
  military buildings); zoning smoke; no-terrain fallback runs
  research/ages without crashing and places nothing.
- `game/tests/sim.ai-peaceful-soak.test.ts` (3 tests): marshal-vs-
  marshal 3600-tick (120s) soak. Asserts both cities grow population
  from zero (≥ 5, measured 6–18 across seeds 7/8/9), non-negative
  treasury, zero military buildings, zero AI-issuer rejections;
  same-seed → identical digest; mid-soak save/load digest-stable.
  The 8000-resident victory is a ~15-minute game; the soak verifies
  the AI builds a working city, not the full victory.
