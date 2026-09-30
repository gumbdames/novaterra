# Phase 9 Workstream A — Long AI-vs-AI Soak Metrics (0.1 Alpha)

Date: 2026-09-30. Harness: `game/tests/sim.phase9-longsoak.test.ts`
(vitest, full production stack mirroring `ui/session.ts` wiring).
Repo status at write time: uncommitted; all 6 tests green (33s wall).

## Method

- Map: Meridian Plains preset seed, 512×512.
- Bases: headline + spot-check games use `(-180, 80)` / `(-80, 80)` — both
  probed at 100% land over an 80×80-unit box, 100 units apart, west of the
  river so the AI's forward-base expansion stays on dry land (see §6.2).
- AI: full seeded personalities (`ai-<owner>` stream); both owners think on
  the production tick pipeline; owner 1's first think staggered by half a
  think cadence to avoid the `advanceAge` apply race (see §6.1).
- Training resources: `grantAllTrainingResources` (fuel/ammo/upgrades/influence)
  so the AI can field its full roster — same as the existing soak tests.
- Tick caps: marshal 30,000 · commander/general 20,000 · peaceful 30,000.
- Metrics are sampling-only (unit/building id Sets; peaks for
  embarked/hangar; depot stock peak+final; upgrades; intel op counts;
  veterancy levels; funds/pop sanity). No per-tick aggregation.

## Results per game

All games ran to the tick cap; none reached a natural conclusion
(elimination or conquest) within the cap.

### Headline: marshal-vs-marshal, standard, 30k ticks (3 seeds)

| seed | ticks | winner (kills) | o0 trained / kills / live | o1 trained / kills / live | final age |
|---|---|---|---|---|---|
| 20260930 | 30000 | owner 1 (37–28) | 85 / 28 / 48 | 33 / 37 / 5 | connectivity |
| 424242 | 30000 | owner 1 (24–12) | 29 / 12 / 5 | 60 / 24 / 48 | connectivity |
| 777001 | 30000 | owner 1 (26–5) | 36 / 5 / 10 | 54 / 26 / 49 | connectivity |

Compositions (seed 20260930): o0 = rifles 47, tank 7, fuelTruck 6,
fishingBoat 4, combatMedic 3, spectre 3. o1 = rifles 22, fishingBoat 4,
fuelTruck 3, apc 3, drone 1. Seed 777001 o0 fielded a navy
(missileBoat 3, corvette 2); o1 fielded aa 3. Veterans: up to 41 per game,
max veterancy level 3 (Elite-equivalent) reached in all marshal games.
Both marshals built 9 virtual buildings and researched 1–2 upgrades
(`droneOptics`, `engineTuning`).

### Peaceful: marshal-vs-marshal, peaceful mode, 30k ticks (3 seeds)

All three seeds: **draw, permanent economic stall.** Final state per owner:
pop 6–18, funds 0, 10–11 physical buildings, ALL non-operational, 0 units
trained, 0 kills. The AI spends its 4000 starting funds on ~10 buildings,
upkeep drains the treasury to zero, `economy.ts` marks everything
non-operational, and `runTaxes` skips non-operational buildings — zero
income forever (see §6.3). Note the peaceful AI builds real physical
buildings (legacy power 2, well/pump 2 per game); the standard AI builds
zero physical buildings (virtual-only economy).

### Spot-check: commander-vs-commander, 20k ticks (2 seeds)

| seed | winner (kills) | o0 trained / kills / live | o1 trained / kills / live |
|---|---|---|---|
| 31337 | owner 1 (40–13) | 41 / 13 / 1 | 39 / 40 / 26 |
| 271828 | owner 0 (28–21) | 47 / 28 / 26 | 29 / 21 / 1 |

Roster included tanks, artillery, aa, spectres. Stuck at foundation age
(no age advancement at commander level in these games).

### Spot-check: general-vs-general, 20k ticks (2 seeds)

| seed | winner (kills) | o0 trained / kills / live | o1 trained / kills / live |
|---|---|---|---|
| 161803 | owner 0 (51–7) | 41 / 51 / 34 | 56 / 7 / 5 |
| 141421 | owner 0 (35–3) | 37 / 35 / 34 | 40 / 3 / 5 |

Mostly rifles + fishingBoat + spectre compositions. Foundation age.

### Determinism

- Mid-game save/load (snapshot at 5k of 20k ticks, restore, run on):
  `digestWorld` identical before/after — PASS.
- Same seed run twice end-to-end: identical final digest — PASS.

## Headline-system usage metrics (aggregate over 7 standard games)

Totals: 627 units trained, 330 kills, median per-kind trained count 3.

| Headline system | Observed usage |
|---|---|
| Carrier / embarked wings | **0** — no carrier ever built; `maxEmbarked` 0 in all games |
| Hangar aircraft fills | **0** — `maxHangarParked` 0; no fighter-class unit ever trained |
| Ammo depot stocks | 0 → 0 in all games (nothing stockpiled, nothing drawn) |
| Fuel depot stocks | ~13,390 peak **and** final — credited by the training grant but **never drawn down** (flat line; fuel burn path never exercised by the AI) |
| Spy missions (infiltrate/sabotage/steal) | **0 / 0 / 0** in all 14 owner-games |
| Civilian airline routes | **0** — `thinkAirlineRoutes` is a documented no-op |
| Road / rail construction | **0** — AI never builds roads or rails |
| Utility plants (all 13 rungs) | **0** — AI never builds power/water plants |
| Research upgrades | `droneOptics`, `engineTuning` (marshal only; commander/general researched nothing) |
| Veterancy | max level 3 reached; up to 41 veterans in a single game |
| Intel buildings | listeningPost + radarStation built (virtual); intelHQ never |
| Ages | marshals reached connectivity; commander/general stuck at foundation; **industry never reached** (AI has 0 influence income) |

## Dead / dominant roster

**DOMINANT units** (trained in every one of the 14 owner-games):
`drone, fishingBoat, fuelTruck, rifles`.

**DEAD units** (82 — never trained in any game): engineer, hauler, hq,
fighter, transport, patrolBoat, destroyer, transportShip, tankDestroyer,
mlrs, fighterBomber, attackHeli, awacs, strategicBomber, maritimePatrol,
reconUAV, armedUAV, reconPlane, gunship, tanker, militaryCargo, trainer,
navalFighter, airliner, jumboAirliner, regionalJet, cargoPlane,
passengerHeli, seaplane, frigate, submarine, carrier, commandShip,
passengerTrain, freightTrain, bus, tram, ferry, coastalSub, missileSub,
cruiser, battleship, heavyDestroyer, cargoFreighter, fuelTanker, ammoShip,
repairShip, minelayer, navalMine, coastGuardCutter, cruiseLiner, yacht,
spy, reconTeam, tankMk2, tankMk3, artilleryMk2, artilleryMk3, aaMk2,
aaMk3, apcMk2, apcMk3, haulerMk2, haulerMk3, fighterMk2, fighterMk3,
fighterBomberMk2, fighterBomberMk3, attackHeliMk2, attackHeliMk3,
gunshipMk2, gunshipMk3, destroyerMk2, destroyerMk3, frigateMk2,
frigateMk3, submarineMk2, submarineMk3, missileBoatMk2, missileBoatMk3,
transportShipMk2, transportShipMk3.

Notable: **no air unit of any kind** was ever trained (all fighters,
bombers, helis, transports, airliners dead); navy limited to
`fishingBoat / missileBoat / corvette`; **all Mk2/Mk3 variants dead**
(the AI never advances far enough to unlock them); `spy`/`reconTeam`
never trained despite intel buildings being built.

Virtual buildings used (≥1 owner-game): airfield, barracks, civilAirport,
fuelDepot, lab, listeningPost, radarStation, shipyard, warFactory.
**DEAD virtual buildings:** navalYard, intelHQ, ordnanceDepot,
missileSilo, supplyDepot.

## Crashes and pathologies found (report — not fixed; separate workstreams)

### 6.1 `advanceAge` apply-time race (real sim bug)

Two AIs thinking on the same tick both enqueue the world-global
`advanceAge`; the first applies, the second goes stale at apply time and
`applyDue` throws `CommandRejectedError`, crashing the whole tick.
`issue()` only swallows enqueue-time rejections, so this path is
unprotected. Harness workaround: stagger owner 1's first think by half
a think cadence. **Also affects human-vs-AI games** (the human can
advance on the same tick the AI does).

### 6.2 Forward base placed in water (real AI bug)

`thinkCommander` (used by commander, general, marshal) places the
forward base halfway toward the nearest visible enemy with **no water
check**. During development one marshal put its forward base in the
river; every subsequent land-unit spawn was rejected at
`validateSpawnUnit`, permanently capping that AI at 9 units while its
`builtCounts` kept incrementing on the failed attempts (it counts the
attempt, not the success — itself a bug). Final base positions were
chosen west of the river to keep the expansion zone on dry land.

### 6.3 Peaceful AI economy death spiral (real balance bug)

Peaceful AI spends its 4000 starting funds on ~10 buildings; upkeep
drains the treasury to 0; `economy.ts` sets all buildings
non-operational; `runTaxes` skips non-operational buildings; income is
0 forever. All three peaceful games stalled by ~tick 3000 at pop 6–18
with 0 funds and never recovered.

### 6.4 Cold war without contact (AI limitation, known)

At 220+ units of base separation with no scout contact, marshal-vs-marshal
is a pure cold war (0 kills, identical 48-unit mirror armies). Wars only
start when patrols make contact; the headline 100-unit separation was
chosen so contact happens.

### 6.5 Industry age unreachable for the AI

No AI reached industry in any game (0 influence income). Marshals stall
at connectivity; commander/general at foundation. All Mk2/Mk3 units,
navalYard, missileSilo, and supplyDepot are dead roster largely for
this reason.

### 6.6 Fuel logistics never exercised

The AI's fuel depot stock (~13.4k from the training grant) is a flat
line — credited once, never drawn down. Fuel burn by the AI's (mostly
ground) forces never registers; combined with §6.5's dead air roster,
the entire fuel-logistics chain is untested by AI play.

## Limitations and follow-ups

- 30k ticks ≈ 8.3 game-hours at the 1s tick; a true "natural conclusion"
  (elimination) never occurred — the loser keeps retraining from virtual
  buildings and the winner never presses the attack to annihilation.
  Longer caps or conquest-objective pressure would be needed to measure
  end-game.
- All games on one map preset (Meridian Plains); water-heavy presets
  would shift the navy/air balance.
- The peaceful death spiral (§6.3) makes peaceful-mode long soaks
  uninformative until fixed.
- Suggested: fix §6.1–6.3, then re-run; add an industry-grant config to
  exercise the Mk2/Mk3 and missile-silo roster.
