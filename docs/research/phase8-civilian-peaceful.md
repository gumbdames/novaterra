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

- **Units: 68 — 47 military / 21 civilian.**
- **Buildings: 89 — 21 military / 68 civilian.**
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

- Tech levels (Mk II/III variants) from PLAN §3.9 — a later workstream.
- The peaceful victory UI panel and end screen — the sibling UI workstream.
- AI peaceful-play quality (economy-only choices) — the AI workstream.
- `ui/palettes.ts` still hand-groups upgrades (military 8 / economy 4 /
  infrastructure 6 / logistics 1 / intel 2); the UI workstream may switch
  those groups to the new `military` def flags.
