# Roster Expansion — NOVATERRA 0.1 Alpha content design

> Design-lead spec for the massive content expansion: ~28 units, ~28
> buildings, 12 upgrades. Setting: **modern-human Earth 2026** — no sci-fi,
> no aliens, no space, no orbital (design bible §C2).
>
> Sources: `docs/research/game-design.md` (cited as "bible §X"),
> `game/src/sim/units.ts`, `game/src/sim/city.ts`, `game/src/sim/ages.ts`,
> `game/src/sim/economy.ts`, `game/src/sim/ai.ts`.
> Status: DESIGN ONLY — no code. Implementation is a separate phase step
> (repo AGENTS.md step gate applies: tests + docs + commit per step).

## Contents

1. [Design principles](#1-design-principles)
2. [Units — full roster (28)](#2-units--full-roster-28)
3. [Buildings — full roster (28)](#3-buildings--full-roster-28)
4. [Upgrades / techs (12)](#4-upgrades--techs-12)
5. [New mechanics required (shippable set)](#5-new-mechanics-required-shippable-set)
6. [Age gating](#6-age-gating)
7. [AI notes](#7-ai-notes)
8. [UI palette grouping (Hebrew-first)](#8-ui-palette-grouping-hebrew-first)
9. [Save/load & snapshot versioning](#9-saveload--snapshot-versioning)
10. [Performance budget](#10-performance-budget)
11. [Rejected ideas (cut with rationale)](#11-rejected-ideas-cut-with-rationale)
12. [Implementation order (proposed)](#12-implementation-order-proposed)

---

## 1. Design principles

1. **Every combat unit has a clear counter** (bible §A4: "no strategy that
   cannot be somehow countered"). Each unit entry states *what it counters*
   and *what counters it*.
2. **Positive framing** (bible §A3): ages and upgrades add capabilities or
   bonuses; nothing in this roster locks another player out of a unit line.
   Doctrine asymmetry (Republic vs Kestrel, bible §C11) is a *layer on top*,
   not a roster split — one shared roster at launch (bible open question 3,
   decided: shared roster + doctrine overlays).
3. **Balanced high, paced by clocks** (bible pillar 3): the roster favors
   decisive combined-arms play. Static defenses are deliberately thin —
   superweapons remain the endgame pacers (bible §A2).
4. **Every resource earns its place** (bible pillar 6): every new building's
   input/output uses existing `ResourceKey`s (funds, materials, fuel, food,
   research, goods, influence, manpower). No new resources.
5. **Abilities few and automatable** (bible §A2: the RA3 lesson). Auras are
   passive; the two new support mechanics (heal aura, harvest) need zero
   micromanagement.
6. **Shippable over exhaustive**: anything that can't be balanced cleanly
   with existing sim systems is cut (§11), not scaffolded.

### Key balance anchors (from existing code)

DPS = `damage / cooldownTicks × 30`. Reference values: tank 30 dps,
rifles 13.5 dps, artillery 28.5 dps, fighter ~34 dps. New units are tuned
against these, not against each other in a vacuum.

### The training-cost gap (must-fix)

**Finding:** `spawnUnit` (`units.ts`) deducts **only manpower**. Training
costs no funds or materials today — a 14-unit roster can already be
mass-produced for free once manpower flows. With 28 units this becomes a
balance hole. **This spec introduces `trainFunds` / `trainMaterials` on
`UnitDef`** (static fields, snapshot-safe): `spawnUnit` validates
affordability at enqueue AND apply (per `sim/AGENTS.md` command
conventions) and deducts on apply. All 28 units get costs below. AI
affordability is checked the same way (its `spawn()` helper already
checks manpower; extend to funds/materials).

---

## 2. Units — full roster (28)

14 existing (kept, stats unchanged, training costs added) + 14 new.

Stat-block key: `hp / speed / armor / dmg / range / minRange / cd /
targets / vsL / vsM / vsH / vsAir / sight / minAge / manpower /
train(funds+materials) / requiredBuilding`.

### 2.1 Land — existing (8)

| Unit | hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| engineer | 80 | 6 | light | 5 | 10 | 0 | 30 | ground | 1.0/0.6/0.4 | 1.0 | 18 | foundation | 0 | 50f |
| rifles | 110 | 9 | light | 9 | 15 | 0 | 20 | ground | 1.0/0.55/0.3 | 1.0 | 22 | foundation | 2 | 60f |
| tank | 500 | 10 | heavy | 50 | 19 | 0 | 50 | ground | 1.3/1.0/0.9 | 1.0 | 26 | foundation | 5 | 400f+60m |
| artillery | 160 | 6 | medium | 95 | 48 | 12 | 100 | ground | 1.0/1.4/1.6 | 1.0 | 30 | foundation | 4 | 450f+80m |
| aa | 200 | 10 | medium | 40 | 28 | 0 | 25 | air | 0.3/0.3/0.3 | 2.2 | 34 | foundation | 4 | 350f+60m |
| hauler | 160 | 9 | medium | 0 | 0 | 0 | 30 | none | — | — | 16 | foundation | 0 | 120f+20m |
| spectre | 130 | 12 | light | 75 | 10 | 0 | 45 | ground | 1.0/1.6/1.3 | 1.0 | 24 | foundation | 3 | 300f+20m |
| hq | 400 | 7 | heavy | 12 | 13 | 0 | 30 | ground | 1.0/0.7/0.5 | 1.0 | 28 | foundation | 2 | 600f+100m |

*Existing counter relationships (from `units.ts` header, preserved):*
tank → rifles · artillery → tank (at range; rifles walk inside minRange 12) ·
aa → all air · fighter → drone/transport · spectre → soft mediums
(artillery, aa, mlrs) · destroyer → sea/air.

### 2.2 Land — new (5)

**apc** — Armored Personnel Carrier. Fast battlefield taxi / infantry
shredder. *Counters:* rifles, sniperTeam, drone (light autocannon).
*Countered by:* tank, tankDestroyer, artillery, attackHeli.

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 320 | 12 | medium | 14 | 16 | 0 | 25 | ground | 1.3/0.8/0.5 | 1.0 | 24 | connectivity | 4 | 250f+40m | warFactory |

*Balance:* 16.8 dps vs light — kills rifles (110 hp) in ~7s of sustained
fire, but a tank (30 dps, vsLight 1.3) kills it in ~8s while the apc's
0.5 vsHeavy barely scratches back. Fast enough (12) to chase infantry,
too fragile to duel armor. Rationale: gives mechanized play a middle
step between rifles and tanks; speed is its identity.

**tankDestroyer** — Glass-cannon anti-armor (assault gun). *Counters:*
tank, apc, hq, carrier-class sea targets n/a (ground only). *Countered
by:* rifles/sniperTeam (close in), artillery, mlrs, attackHeli.

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 380 | 9 | medium | 70 | 24 | 0 | 60 | ground | 0.6/1.2/1.8 | 1.0 | 26 | industry | 5 | 500f+90m | warFactory |

*Balance:* 35 dps × 1.8 vsHeavy = 63 effective dps vs tanks — a
three-TD ambush deletes a tank (500 hp) in ~8s, but TDs die to rifles
(13.5 dps × 1.0 vsMedium… rifles vsMedium 0.55 → ~7.4 dps each; 4 rifles
≈ 30 dps vs 380 hp ≈ 13s — TD must be screened). Outranges the tank
(24 vs 19): the counter is positional, per bible §A4. Rationale: the
designated tank answer that isn't artillery; keeps heavy-armor masses
honest without invalidating tanks (tanks still beat infantry, which
beat TDs — the triangle closes).

**mlrs** — Rocket artillery. Counter-battery / infantry-shredder with a
long reload. *Counters:* massed infantry, artillery (counter-battery:
outranges 48? no — 40 < 48; see note), static clusters. *Countered by:*
fighters, attackHeli, spectre, tanks inside minRange.

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 180 | 7 | medium | 140 | 40 | 14 | 160 | ground | 1.6/1.2/1.2 | 1.0 | 28 | industry | 5 | 600f+120m | warFactory |

*Balance:* 26 dps nominal but delivered in 140-damage salvos every
~5.3s — overkill vs single rifles, devastating vs clumps. Deliberately
*shorter* range than tube artillery (40 vs 48) so artillery keeps the
siege niche and mlrs keeps the shock niche; the minRange 14 dead zone
is shared. Rationale: distinct from artillery by damage *profile*, not
just numbers (bible §A2: every unit a unique purpose).

**sniperTeam** — Long-range infantry precision. *Counters:* rifles,
spectre, combatMedic. *Countered by:* artillery, mlrs, tanks, fighterBomber,
drones (spots it; cannot be hit back — targets ground only).

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 90 | 8 | light | 45 | 30 | 0 | 70 | ground | 1.6/0.8/0.4 | 1.0 | 36 | connectivity | 3 | 200f+20m | barracks |

*Balance:* 19 dps, but 45×1.6 = 72 per shot vs light — two-shots rifles
and one-shots spectres (130 hp? no — 130 > 72; two shots). Range 30
outranges rifles (15) and matches its sight 36 (sees first, shoots
first — the fantasy). 90 hp means any splash/vehicle touch kills it.
Note: cannot hit air; drones counter *it* by spotting, fighters kill it.
Rationale: the infantry-line's skill unit; rewards positioning, dies to
a stiff breeze.

**combatMedic** — Support: passive heal aura, unarmed. *Counters:*
nothing (force multiplier). *Countered by:* everything — priority
target; snipers and spectres hunt it.

| hp | spd | arm | dmg | rng | tgt | sight | age | mp | train | req | aura |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 9 | light | 0 | 0 | none | 20 | connectivity | 2 | 150f+10m | barracks | heal 12 radius, +2 hp/s friendly land |

*Balance:* 2 hp/s undoes ~15% of a rifles' incoming dps — meaningful
over a minute-long engagement, irrelevant under focus fire. New
mechanic (heal aura) reuses the HQ-aura pattern. Requires the Field
Medicine upgrade to matter late (§4.8). Rationale: the "few,
automatable abilities" rule (bible §A2) — zero micro, pure positioning.

### 2.3 Air — existing (3)

| Unit | hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| fighter | 170 | 26 | light | 32 | 24 | 0 | 28 | both | 1.0/0.7/0.5 | 1.6 | 40 | connectivity | 3 | 800f+120m |
| transport | 240 | 22 | medium | 0 | 0 | 0 | 30 | none | — | — | 20 | foundation | 2 | 500f+80m |
| drone | 55 | 20 | light | 9 | 13 | 0 | 22 | both | 0.9/0.5/0.3 | 1.0 | 26 | foundation | 0 | 80f+10m |

### 2.4 Air — new (3)

**attackHeli** — Anti-armor helicopter. *Counters:* tank, artillery,
mlrs, apc. *Countered by:* aa, fighter, destroyer (vsAir 1.8), frigate.

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 150 | 30 | light | 60 | 22 | 0 | 55 | ground | 0.9/1.1/1.5 | 1.0 | 30 | connectivity | 4 | 700f+100m | airfield |

*Balance:* 33 dps × 1.5 vsHeavy ≈ 49 vs tanks — a tank dies in ~10s;
but one aa (40 dmg × 2.2 vsAir = 88/shot, 25-tick cd ≈ 106 dps) kills
the heli in under 2s. The bible's hard-counter discipline: helis
*demand* SEAD (spectre/fighterBomber first) or they evaporate.
Rationale: the mobile answer to armor blobs that artillery can't reach.

**fighterBomber** — Strike aircraft: heavy ground attack, long rearm.
*Counters:* heavy armor concentrations, high-value soft targets.
*Countered by:* aa, fighter, destroyer. (No maritime strike: `targets:
ground` — submarines are the navy's problem, answered by frigates.)

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 200 | 28 | medium | 120 | 20 | 0 | 90 | ground | 0.8/1.0/1.6 | 1.0 | 32 | industry | 4 | 1000f+150m | airfield |

*Balance:* 40 dps nominal, 64 effective vs heavy — a strike run
(2 passes) cripples a tank. The 90-tick cooldown *is* the rearm cycle:
it cannot loiter like the heli. Rationale: distinct from fighter
(air superiority) and heli (persistent CAS) — the alpha-strike tool.

**awacs** — Unarmed sensor platform. *Counters:* nothing directly —
counters *fog-of-war play* (extends the AI/human sight network).
*Countered by:* fighter (its nightmare), aa if it strays low.

| hp | spd | arm | dmg | tgt | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|
| 180 | 24 | light | 0 | none | 65 | information | 3 | 900f+120m | airfield |

*Balance:* sight 65 ≈ 2.5× a tank's — one awacs on station replaces a
screen of scouts, but it's a 900-fund balloon: losing it blinds you.
No aura (keep it simple — its own sight is the mechanic; AI
`getVisibleEnemies` already iterates own units, so it plugs in free).
Rationale: bible §C5 Signals Grid fantasy made flesh; rewards the
information-age player without adding micro.

### 2.5 Sea — existing (3)

| Unit | hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| patrolBoat | 220 | 14 | light | 18 | 20 | 0 | 25 | sea | 1.2/0.8/0.5 | 0.8 | 30 | industry | 3 | 250f+60m |
| destroyer | 600 | 11 | heavy | 45 | 26 | 0 | 40 | seaAir | 1.3/1.1/1.0 | 1.8 | 34 | industry | 6 | 1500f+400m |
| transportShip | 350 | 9 | medium | 0 | 0 | 0 | 30 | none | — | — | 22 | industry | 2 | 400f+100m |

### 2.6 Sea — new (6)

**submarine** — Torpedo strike vs capital ships. *Counters:*
destroyer, carrier, commandShip (vsHeavy 2.0 torpedoes). *Countered by:*
frigate (ASW), destroyer (vsMedium 1.1 works), fighterBomber n/a at sea
— by air: fighter strafing is weak; primary answers are frigate screens
and missileBoats swarming.

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 300 | 10 | medium | 90 | 30 | 0 | 80 | sea | 0.8/1.5/2.0 | 1.0 | 26 | industry | 6 | 1200f+300m | navalYard |

*Balance:* 34 dps × 2.0 vsHeavy = 68 vs a destroyer's 600 hp (~9s);
outranges the destroyer (30 vs 26) — the sub dictates the engagement
*unless* a frigate (vsMedium 1.6) is screening. No stealth mechanic:
range + alpha *is* its stealth (it kills before it's seen — sight 26 <
range 30, so it fires from outside its own detection only with
off-board spotting; honest and shippable). Rationale: bible §C5 lists
submarines at Green Transition; the capital-ship predator the navy
needs.

**frigate** — ASW/AA escort. *Counters:* submarine (vsMedium 1.6),
missileBoat, aircraft (vsAir 1.2, screening). *Countered by:*
destroyer (gun duel), fighterBomber.

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 420 | 13 | medium | 30 | 24 | 0 | 35 | seaAir | 1.2/1.6/0.8 | 1.2 | 32 | industry | 5 | 900f+220m | navalYard |

*Balance:* 26 dps × 1.6 vsMedium ≈ 41 vs subs — two frigates kill a sub
(300 hp) in ~4s. Loses a straight gunfight to a destroyer (45×1.0=45
dps vs 420 hp ≈ 9.4s vs frigate's 30×0.8=24 dps vs 600 hp = 25s) — it is
an *escort*, not a line ship. Rationale: makes subs answerable without
nerfing them; the "screen your capitals" gameplay.

**missileBoat** — Cheap fast missile swarm. *Counters:* destroyer,
carrier, commandShip, transportShip (vsHeavy 1.5). *Countered by:*
patrolBoat (cheap swarm answer), frigate, fighter.

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 180 | 18 | light | 70 | 22 | 0 | 70 | sea | 1.0/1.1/1.5 | 1.0 | 28 | connectivity | 4 | 500f+120m | shipyard |

*Balance:* 30 dps × 1.5 vsHeavy = 45 — three boats focus a destroyer
down in ~4.5s, but each boat dies to a destroyer salvo pair (45×1.3 vs
light = 58.5/shot). Speed 18 (fastest sea unit) is the defense.
Rationale: the "balanced high" swarm unit (bible §A2) — cheap, scary in
packs, dies in droves; gives Connectivity-age players a navy before
navalYard.

**commandShip** — Floating HQ: naval command aura. *Counters:* nothing
directly (force multiplier). *Countered by:* submarine, missileBoat
(high-value target).

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req | aura |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 700 | 9 | heavy | 20 | 18 | 0 | 40 | sea | 1.0/1.0/1.0 | 1.0 | 40 | information | 6 | 2000f+500m | navalYard | +25% dmg, radius 24, friendly sea |

*Balance:* mirrors the land HQ aura (radius 20 → 24 at sea for the
longer engagement ranges). 700 hp + heavy armor makes it a siege
project, not a pickoff. Rationale: fleet actions need the same command
gameplay as land battles; one aura type per domain, no new UI.

**carrier** — Air-defense capital / fleet anchor. *Counters:* enemy
aircraft over water (vsAir 2.0, range 30), patrolBoats. *Countered by:*
submarine, missileBoat (the classic carrier-killers).

| hp | spd | arm | dmg | rng | min | cd | tgt | vsL/M/H | vsAir | sight | age | mp | train | req |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 900 | 8 | heavy | 40 | 30 | 0 | 45 | seaAir | 1.2/1.0/0.9 | 2.0 | 36 | information | 10 | 3500f+1000m | navalYard |

*Balance:* the most expensive unit in the game — a statement piece.
27 dps × 2.0 vsAir = 54 vs aircraft: it *is* the no-fly zone. But 900
hp melts to subs (90×2.0=180/shot) in ~5 unanswered seconds — carriers
*require* frigate screens, which is the intended combined-arms lesson.
No launched-aircraft mechanic (cut per §11 — needs a whole
carrier-air-wing system). Rationale: bible §C11 lists the carrier;
implemented as the fleet air-defense anchor rather than a drone
spawner, which keeps it shippable.

**fishingBoat** — Economic sea unit: passive food harvest. *Counters:*
n/a (economy). *Countered by:* everything — raiding fishing boats is
valid economic warfare.

| hp | spd | arm | dmg | tgt | sight | age | mp | train | req | harvest |
|---|---|---|---|---|---|---|---|---|---|---|
| 120 | 12 | light | 0 | none | 18 | foundation | 0 | 150f+30m | shipyard | +0.6 food/s while alive |

*Balance:* 0.6 food/s ≈ one-fifth of a farm (3.0/s) for ~1/3 the farm's
funds cost — efficient *if* you can protect it, which on a 45%-water
map (bible §C9 Inland Sea) is a real question. New mechanic
(`harvestPerSec` on UnitDef, collected in the economy tick for living
units) — trivial to implement, zero micro. Rationale: gives water maps
an economic identity beyond "where the navy fights" and creates
raid-worthy targets (bible §C9: navy rewarding on coastal maps).

### 2.7 Counter matrix (quick reference)

| Unit | Beats | Loses to |
|---|---|---|
| rifles | sniperTeam (mass), spectre (mass), medic | tank, apc, artillery, mlrs, fighterBomber |
| tank | rifles, apc, sniperTeam | artillery, tankDestroyer, mlrs, attackHeli |
| apc | rifles, sniperTeam, drone | tank, tankDestroyer, artillery, attackHeli |
| tankDestroyer | tank, apc, hq | rifles, artillery, mlrs, attackHeli |
| artillery | tank, apc, tankDestroyer (range) | rifles/spectre (inside minRange), fighterBomber, attackHeli |
| mlrs | infantry masses, artillery parks | fighter, attackHeli, spectre, tank (inside minRange) |
| aa | all aircraft | tank, artillery, spectre, sniperTeam |
| sniperTeam | rifles, spectre, medic | artillery, mlrs, tank, fighterBomber |
| spectre | artillery, aa, mlrs, hq | rifles, sniperTeam, tank |
| combatMedic | — (heals) | everything (focus it) |
| fighter | drone, transport, awacs, attackHeli | aa, destroyer, frigate, fighter |
| fighterBomber | armor, soft high-value | aa, fighter, destroyer |
| attackHeli | tank, artillery, mlrs | aa, fighter, destroyer |
| awacs/drone | — (intel) | fighter, aa |
| patrolBoat | missileBoat, transportShip | destroyer, frigate, fighterBomber |
| missileBoat | destroyer, carrier, commandShip | patrolBoat, frigate, fighter |
| frigate | submarine, missileBoat, (screens air) | destroyer, fighterBomber |
| submarine | destroyer, carrier, commandShip | frigate, missileBoat (swarm) |
| destroyer | patrolBoat, frigate, aircraft | submarine, missileBoat, fighterBomber |
| carrier | aircraft over sea, patrolBoat | submarine, missileBoat |
| commandShip | — (aura) | submarine, missileBoat |
| engineer/hauler/transport/fishingBoat | — (utility) | everything (escort them) |

Every row has at least one counter in both directions. No hard
invincibility: even the carrier dies to a 500-fund missileBoat pack
with no screen.

---

## 3. Buildings — full roster (28)

12 existing (kept) + 16 new. All inputs/outputs use existing
`ResourceKey`s. Rates are per sim-second (economy tick convention).

### 3.1 Existing (12) — unchanged

house, apartment, shop, lab, factory, farm, powerPlant, waterPump,
mediaCenter, shipyard, aegisControl, stormArray (stats in `city.ts`).

*Role clarifications (new, no stat changes):*
- **shipyard** becomes the *basic* naval production building: unlocks
  patrolBoat, transportShip, fishingBoat, missileBoat
  (`requiredBuilding: 'shipyard'` on those UnitDefs).
- **lab** becomes the research site for all upgrades (§4).

### 3.2 New (16)

| Building | Zone | Foot | Cost (f+m) | Build | Upkeep | Power/Water | In → Out | Tax | Age | Role |
|---|---|---|---|---|---|---|---|---|---|---|
| barracks | industrial | 3×3 | 700+250 | 40s | 1.0 | 4 / 2 | → manpower 0.8/s | 4.0 | foundation | Unlocks spectre, sniperTeam, combatMedic; infantry manpower engine |
| warFactory | industrial | 4×3 | 1100+450 | 60s | 1.8 | 6 / 3 | → materials 0.5/s | 6.0 | foundation | Unlocks tank, apc, tankDestroyer, artillery, mlrs, aa |
| airfield | utility | 5×4 | 1500+600 | 75s | 2.0 | 5 / 2 | — | 5.0 | connectivity | Unlocks fighter, fighterBomber, attackHeli, awacs, transport |
| navalYard | utility† | 5×4 | 1800+700 | 80s | 2.2 | 6 / 3 | — | 5.0 | industry | Unlocks destroyer, frigate, submarine, carrier, commandShip |
| radarStation | utility | 2×2 | 600+200 | 30s | 0.8 | 3 / 1 | → research 0.5/s | 3.0 | connectivity | Signals-intel flavor; prereq for Advanced Avionics, Cruise Missiles |
| quarry | industrial | 3×3 | 350+100 | 25s | 0.7 | 2 / 1 | → materials 2.0/s | 3.0 | foundation | Raw-materials base of the production chain |
| oilRefinery | industrial | 4×3 | 900+350 | 50s | 1.4 | 4 / 3 | materials 0.3 → fuel 1.5/s | 6.0 | connectivity | Fuel production (petrochemical processing of materials) |
| recyclingCenter | industrial | 3×3 | 500+180 | 35s | 0.9 | 3 / 2 | goods 0.5 → materials 1.0/s | 4.0 | connectivity | Circular chain: goods back into materials (bible §C4) |
| market | commercial | 3×3 | 600+200 | 30s | 1.0 | 3 / 2 | food 0.5 + goods 0.5 → funds 2.5/s | 10.0 | connectivity | Food-surplus sink; trade hub; prereq for Free Trade Policy |
| solarFarm | utility | 4×3 | 700+250 | 35s | 0.5 | supply 15 / 1 | — | 2.0 | connectivity | Clean power, no fuel (bible §A1: green-vs-fossil tradeoff) |
| nuclearPlant | utility | 4×4 | 2500+1000 | 100s | 2.5 | supply 60 / 6 | fuel 0.5 → (power) | 8.0 | industry | Dense late-game power; fuel-sipping vs powerPlant's 1.0/s |
| desalination | utility | 3×3 | 800+300 | 40s | 1.0 | 6 / supply 40 | — | 2.0 | industry | Coastal water for big cities (pairs with nuclearPlant) |
| hospital | commercial | 3×3 | 800+280 | 40s | 1.2 | 4 / 3 | → manpower 0.4/s | 5.0 | connectivity | Population-services → manpower; prereq for Field Medicine |
| university | commercial | 4×3 | 1400+500 | 60s | 1.8 | 5 / 3 | → research 1.0/s | 8.0 | connectivity | 2.5× a lab; the research engine (bible §C5) |
| school | residential | 2×2 | 250+80 | 20s | 0.4 | 2 / 1 | → research 0.25/s | 2.0 | foundation | Cheap early research ramp; gives residential zones a non-house option |
| monument | utility | 3×3 | 3000+1200 | 90s | 2.0 | 4 / 2 | → influence 1.0/s | 6.0 | information | Prestige / wonder-lite; ties to the Ascendance victory (bible §C6) |

† **navalYard placement rule (new):** at least one footprint cell must be
orthogonally adjacent to a water cell (coastal construction). Validated in
`validatePlacement` alongside the road-adjacency rule. This is the only new
placement constraint in the spec — it makes coastline valuable (bible §C9:
"port cities shine").

*Balance rationale (per building, 1–2 lines):*
- **barracks/warFactory/airfield/navalYard:** the four production
  buildings are the *military tech tree made physical* — you can't field
  armor without an industrial base, which is the AoE-style commitment
  (bible §A3). Costs are set so one production building ≈ 2–3 units'
  worth of funds: meaningful but not prohibitive.
- **quarry:** 2.0 materials/s at 350f puts raw extraction below factory
  output (2.5/s at 550f + fuel) — quarries are the *cheap, dumb* path,
  factories the efficient one. Chain: quarry → factory → goods →
  recycling → quarry (bible pillar 6: interplay, not isolation).
- **oilRefinery:** fuel's only producers were imports/market; the
  refinery closes the loop domestically. 1.5 fuel/s feeds one powerPlant
  (1.0/s) with headroom — the intended pairing.
- **recyclingCenter:** converts the late-game goods glut back into
  materials — a sink for the exact resource that otherwise inflates
  (bible §A3: inflation is a bug).
- **market:** the food-surplus sink the economy currently lacks (food has
  no spend path except population). 2.5 funds/s at a 1.0 upkeep keeps it
  honest; the 10.0 taxBase makes it the commercial anchor.
- **solarFarm vs powerPlant:** 15 free power for 700f vs 25 fuel-burning
  power for 900f — the bible §A1 fossil-vs-green tradeoff, implemented
  almost literally. Solar wins on opex, loses on density.
- **nuclearPlant:** 60 power at industry age for players who've outgrown
  powerPlant spam; the fuel 0.5/s input keeps refineries relevant
  late-game.
- **desalination:** water's answer to the power curve — 40 supply lets a
  big city run on two buildings instead of pump-spam.
- **hospital/university/school:** services that *do something real* in
  the current sim (manpower/research output) rather than waiting on a
  happiness system that doesn't exist yet.
- **monument:** influence 1.0/s at information age feeds the influence
  victory/economy exactly when ascendance costs (250–500 influence)
  start biting.

### 3.3 Zone distribution after expansion

| Zone | Buildings |
|---|---|
| residential | house, apartment, school |
| commercial | shop, lab, mediaCenter, market, hospital, university |
| industrial | factory, farm, barracks, warFactory, quarry, oilRefinery, recyclingCenter |
| utility | powerPlant, waterPump, shipyard, aegisControl, stormArray, airfield, navalYard, radarStation, solarFarm, nuclearPlant, desalination, monument |

Residential stays housing-led (population is its product); commercial
becomes the services/research belt; industrial the production chain.
No zone is empty, none exceeds 7 — palette-manageable (§8).

---

## 4. Upgrades / techs (12)

**System:** new `researchUpgrade` command, researched at the **lab**
(single research site keeps the UI to one panel; university *boosts*
research income rather than being a second site). Cost is paid in funds
+ research stockpile. Each upgrade: id, name, exact effect, cost,
prerequisite (building and/or age and/or other upgrade).

Per-player researched sets live in new world state (§9). Effects apply
at the existing computation points (combat `damageMultiplier`,
`spawnUnit` cost check, economy `runProduction`, unit `sight`).

*Military line (researched at lab; production-building prereqs):*

1. **apRounds** — AP Rounds. Effect: +40% `vsHeavy` multiplier for tank,
   tankDestroyer, apc (0.9→1.26, 1.8→2.52, 0.5→0.7). Cost: 800 funds +
   60 research. Prereq: warFactory, age ≥ industry.
2. **compositeArmor** — Composite Armor. Effect: +30% max hp for tank,
   tankDestroyer, apc, artillery, mlrs (applied at spawn; existing units
   keep current hp — no retroactive heal). Cost: 1000 funds + 80
   research. Prereq: warFactory, age ≥ industry.
3. **engineTuning** — Engine Tuning. Effect: +25% speed for tank, apc,
   tankDestroyer, artillery, mlrs, aa (10→12.5 etc.). Cost: 600 funds +
   40 research. Prereq: age ≥ connectivity. (The cheap early military
   tech — rewards the player who scouts mech play first.)
4. **advancedAvionics** — Advanced Avionics. Effect: +25% sight and +20%
   `vsAir` for fighter, fighterBomber, attackHeli; awacs +15 sight
   (65→80). Cost: 1200 funds + 120 research. Prereq: airfield +
   radarStation, age ≥ information.
5. **sonarSuite** — Sonar Suite. Effect: frigate/destroyer +30% vsMedium
   (ASW), all sea units +8 sight. Cost: 900 funds + 80 research.
   Prereq: navalYard, age ≥ industry.
6. **cruiseMissiles** — Cruise Missiles. Effect: mlrs +10 range (40→50),
   artillery +8 range (48→56). Cost: 1500 funds + 150 research.
   Prereq: radarStation, age ≥ information. (Range is the most
   dangerous stat in the game — hence the highest military cost and a
   late gate.)
7. **droneOptics** — Drone Optics. Effect: drone +15 sight (26→41),
   spectre +10 sight (24→34). Cost: 500 funds + 50 research. Prereq:
   age ≥ connectivity. (Cheap intel for the skirmish-opener player.)
8. **fieldMedicine** — Field Medicine. Effect: combatMedic heal 2→4 hp/s;
   rifles, sniperTeam, spectre +20 max hp at spawn. Cost: 700 funds +
   60 research. Prereq: hospital + barracks, age ≥ connectivity.

*Economy/building line:*

9. **precisionManufacturing** — Precision Manufacturing. Effect: factory
   output +25% (materials 2.5→3.125/s, goods 1.5→1.875/s). Cost: 1200
   funds + 100 research. Prereq: age ≥ industry. (Stacks
   multiplicatively with Heavy Industry's 1.5× — the boom path.)
10. **smartGrid** — Smart Grid. Effect: powerPlant supply 25→35,
    solarFarm 15→20, nuclearPlant 60→75. Cost: 1000 funds + 100
    research. Prereq: age ≥ industry.
11. **verticalFarming** — Vertical Farming. Effect: farm food 3.0→4.5/s,
    water demand 4→3. Cost: 900 funds + 80 research. Prereq:
    age ≥ industry. (Food independence for dense cities; pairs with
    desalination.)
12. **freeTrade** — Free Trade Policy. Effect: market funds output
    2.5→3.75/s, trade-route income 3→4.5/s, shop funds 1.8→2.25/s.
    Cost: 1500 funds + 200 research. Prereq: market, age ≥ information.
    (The commerce victory-lap tech; gated behind the market so it
    can't be rushed without a real commercial base.)

*Upgrade-design rules (locked):* every upgrade changes a *capability
number*, never a flat +5% filler (bible §C5: "every tech node must
unlock a capability"). No upgrade exceeds two prerequisites. Military
and economy lines cost from the same research stockpile — the AoE2
tension (guns vs butter vs age-up) is preserved (bible §A3).

---

## 5. New mechanics required (shippable set)

Everything in §§2–4 is implementable with the UnitDef/BuildingDef
field shapes plus these **seven** small, well-bounded extensions. Each
lists the exact code touchpoints. Nothing here needs a new system
*class* — all extend existing ones.

1. **Training costs** — `UnitDef.trainFunds`, `UnitDef.trainMaterials`
   (default 0). `spawnUnit` validate: affordability (enqueue + apply);
   apply: deduct. UI train panel: grey out unaffordable kinds. AI
   `spawn()` helper: check funds/materials like manpower.
2. **Production gating** — `UnitDef.requiredBuilding?: BuildingKind`
   (optional, default none). `spawnUnit` validate: owner must own ≥1
   *completed* (`progress >= 1`) building of that kind. Basic units
   (engineer, rifles, hauler, drone, transport, patrolBoat,
   transportShip, fishingBoat) have **no** requirement — starting
   forces and early game are unaffected. AI: virtual construction —
   the AI pays the building's full funds/materials cost, waits
   `buildSeconds`, then unlocks (exact precedent: AI superweapon
   facilities in `ai.ts`, "pays the facility's full cost upfront").
3. **Coastal placement** — navalYard requires ≥1 footprint cell
   orthogonally adjacent to water. One new check in
   `validatePlacement`.
4. **Heal aura** — `UnitDef.healRadius?`, `UnitDef.healPerSec?`
   (combatMedic: 12, 2). Applied in the combat system tick to friendly
   land units in radius (same iteration pattern as the HQ damage aura).
5. **Naval command aura** — commandShip reuses the HQ-aura code path
   with `UnitDef.auraRadius?`, `UnitDef.auraBonus?` (HQ keeps 20/0.25;
   commandShip 24/0.25, sea domain). Generalize `HQ_AURA_*` constants
   into optional def fields with the current values as defaults.
6. **Passive harvest** — `UnitDef.harvest?: Partial<Record<ResourceKey,
   number>>` per sim-second (fishingBoat: `{ food: 0.6 }`). Collected in
   the economy tick for living units (after `runProduction`).
7. **Upgrade research** — `world.upgrades: Record<number /* playerId */,
   string[]>`; `researchUpgrade` command (validate: lab completed,
   prereqs, affordability; apply: deduct, append id). Effect hooks:
   combat `damageMultiplier` (apRounds), spawn stats (compositeArmor,
   engineTuning, fieldMedicine hp), `sight` reads (droneOptics,
   advancedAvionics, sonarSuite), range reads (cruiseMissiles),
   economy `runProduction` (precisionManufacturing, smartGrid,
   verticalFarming, freeTrade), heal tick (fieldMedicine).

Explicitly **not** required: building HP/weapons (cut §11), carrier
air wings (cut §11), stealth (sub identity via range/alpha instead),
unit-carried resources, fuel consumption by vehicles.

---

## 6. Age gating

| Age | New units | New buildings | New upgrades |
|---|---|---|---|
| **foundation** | fishingBoat | barracks, warFactory, quarry, school | — |
| **connectivity** | apc, sniperTeam, combatMedic, attackHeli, missileBoat | airfield, radarStation, oilRefinery, recyclingCenter, market, solarFarm, hospital, university | engineTuning, droneOptics, fieldMedicine |
| **industry** | tankDestroyer, mlrs, fighterBomber, submarine, frigate | navalYard, nuclearPlant, desalination | apRounds, compositeArmor, sonarSuite, precisionManufacturing, smartGrid, verticalFarming |
| **information** | awacs, commandShip, carrier | monument | advancedAvionics, cruiseMissiles, freeTrade |
| **ascendance** | — | — | — |

*Curve rationale:* foundation = infantry + basic vehicles + raw
materials (the existing game, plus production buildings). Connectivity
= mobility + intel (apc, snipers, helis, radar, airfield) — the
"see farther, move faster" age. Industry = heavy metal (TD, mlrs,
subs, navy yard, nuclear) — the combined-arms age. Information =
force multipliers (awacs, carrier, command ship, precision upgrades) —
the "fight smarter" age. Ascendance stays the superweapon/wonder age
(no new roster — the clock units already live there; bible §C5).

Existing units keep their ages; new `requiredBuilding` gates apply on
top of `minAge` (both must be satisfied).

---

## 7. AI notes

The Classic AI (`ai.ts`) gets the new roster through its existing
decision points — no architecture change, just extended tables.
Difficulty philosophy unchanged (bible §A5: decision quality first).

### 7.1 Production building unlocks (all levels)

AI virtual-constructs production buildings in this priority order as
funds allow: barracks → warFactory → airfield → shipyard (shipyard is
a real building the AI may also place later; virtual first) →
navalYard → radarStation. It pays full cost and waits the build time
(abstract ticks), mirroring the existing superweapon virtual
construction. Until unlocked, those kinds are skipped in composition
(the same fallback pattern as the current fighter→aa fallback).

### 7.2 Composition targets (share of cap, citizen+)

Base mix (no intel): 30% rifles, 20% tank, 10% artillery, 10% aa,
10% apc, 10% flex (sniperTeam/spectre), 10% air/sea per map.

Per-match personality (seeded, `ai.ts`): each AI draws playstyle
parameters from its own `ai-<owner>` RNG stream at setup — same seed
plays identically, different seeds play differently at the same
difficulty. The counter table above is NOT jittered (difficulty keeps
its meaning); what varies is the base-mix (±30% per-kind share jitter),
attack-order cadence (every think vs every other think by aggression),
forward-base timing/direction, scout waypoint rotation, and the
economy-upgrade order (§7.4). Cadet's personality is inert.

Commander/general/marshal adjust with counters:

| Sees (visible enemies) | Builds (priority) |
|---|---|
| enemy air (fighters, helis, bombers) | aa up to air+1, then fighters |
| enemy heavy (tank, TD mass) | tankDestroyer, artillery |
| enemy light mass (rifles) | apc, mlrs, artillery |
| enemy artillery/mlrs | spectre, sniperTeam, fighterBomber |
| enemy subs | frigate ×2 per sub |
| enemy destroyer/carrier | submarine, missileBoat pack (3+) |
| enemy navy (any) on water maps | frigate screen before capitals |
| nothing visible | scout (drone → awacs at information) |

### 7.3 New-unit behaviors (basic level)

- **combatMedic:** attach to the largest friendly land group (move to
  group centroid every think tick); never ordered to attack.
- **awacs:** like the commander's scout logic — cycle waypoints at
  standoff distance (120 units from base), never over enemy clusters.
- **fishingBoat:** marshal/general only; park 3–5 near owned coastline
  with a patrolBoat escort each. (Cadet/citizen skip the fishing
  economy — decision-quality ladder: greed is a high-level trait.)
- **commandShip/carrier:** keep at 60% of fleet's max range behind the
  screen; retreat when hp < 40% (marshal only — retreat logic is a
  level-4+ trait per bible §C7).
- **missileBoat:** built in packs of 3+, ordered as a group (existing
  `moveGroup`/`attackUnit`).
- **mlrs/artillery:** hold at max range; the existing "don't pull
  fighting units" rule already protects them.

### 7.4 Upgrades (commander+)

Research priority when research stockpile allows: apRounds →
compositeArmor → engineTuning (if fielding ≥4 vehicles) → sonarSuite
(if enemy subs ever seen) → advancedAvionics (if fielding ≥3
aircraft) → the economy line (precisionManufacturing, smartGrid,
verticalFarming, cruiseMissiles, freeTrade) in per-match personality
order — the combat/support head above keeps this priority in every
match; only the economy tail is shuffled per seed. Citizen and below research only engineTuning/droneOptics
(cheap). Cadet researches nothing (never counters, never techs —
consistent with its current "no decisions" profile).

### 7.5 Caps

Roster grew 14→28; caps should grow ~40%: cadet 4→6, citizen 10→14,
commander 18→26, general 26→34, marshal 36→48. Starting forces (2
engineers + 4 rifles) still fit cadet's cap of 6 — the step-12 cap
invariant holds.

---

## 8. UI palette grouping (Hebrew-first)

English names in this spec; Hebrew strings land in `ui/strings.ts`
when implemented (the UI is Hebrew-first per user instruction; the
game's audience reads Hebrew).

### Train palette — 4 tabs

| Tab (EN / HE) | Units |
|---|---|
| Infantry / חי״ר | engineer, rifles, sniperTeam, spectre, combatMedic, hauler |
| Armor / שריון | tank, apc, tankDestroyer, artillery, mlrs, aa, hq |
| Air Force / חיל אוויר | fighter, fighterBomber, attackHeli, drone, awacs, transport |
| Navy / חיל ים | patrolBoat, missileBoat, frigate, submarine, destroyer, carrier, commandShip, transportShip, fishingBoat |

Locked kinds show with their requirement ("needs War Factory" /
"needs Industry age") — same pattern as the current fighter
age-lock display (`hud.ts` train panel).

### Build palette — 7 tabs

| Tab (EN / HE) | Buildings |
|---|---|
| Housing / מגורים | house, apartment, school |
| Commerce / מסחר | shop, market, lab, mediaCenter, hospital, university |
| Industry / תעשייה | factory, farm, quarry, oilRefinery, recyclingCenter, barracks, warFactory |
| Utilities / תשתיות | powerPlant, solarFarm, nuclearPlant, waterPump, desalination |
| Naval & Air / ימי ואווירי | shipyard, navalYard, airfield, radarStation |
| Special / מיוחד | monument, aegisControl, stormArray |

*Note:* production buildings sit under Industry and naval/air under
their own tab, so no separate Military tab is needed — the palette is
6 tabs. Tab counts stay ≤9 entries; each tab fits one screen without
scrolling at 1080p.

### Upgrade panel

One new panel: **Research / מחקר**, opened from the lab (and listed in
the HUD). 12 entries grouped Military / Economy, each showing cost,
prereq, and one-line effect. Researched items get a checkmark —
permanent for the match.

---

## 9. Save/load & snapshot versioning

- **New kinds are plain strings** (`UNIT_KINDS`, `BuildingKind`): adding
  14+16 kinds is snapshot-safe, no version bump (established pattern).
- **New static def fields** (`trainFunds`, `requiredBuilding`,
  `healRadius`, `harvest`, …): not in snapshots — safe.
- **New world state** `world.upgrades` (per-player researched ids):
  **bump `SNAPSHOT_VERSION` 5→6**. `decode`: missing/older `upgrades`
  field defaults to `{}` (no upgrades researched) — old saves load,
  they just haven't researched anything. `digestWorld` must include
  upgrades (determinism check).
- **No new `UnitRecord`/`BuildingRecord` fields** — auras and harvest
  read from defs; researched effects are player-level. Unit records
  stay byte-identical in shape.
- AI `builtCounts` already keyed by kind string — new kinds flow
  through; encode/decode unchanged.

---

## 10. Performance budget

Roster size is *data*, not entities — 28 kinds cost nothing at runtime
beyond def table lookups. The risks are the two aura mechanics and
sight inflation (repo AGENTS.md §2: 60fps, thousands of entities):

- **Heal/damage auras:** reuse the HQ-aura iteration (friendly units
  within radius). Bound it: medics/commandShips are few by design
  (cost + cap pressure); iterate units once per tick per aura source —
  O(sources × units), fine under ~10 sources. If profiling shows
  otherwise, move aura application to the spatial hash (`spatial.ts`).
- **Sight 65–80 (awacs):** `getVisibleEnemies` is O(own × enemy);
  awacs adds one row. Fine. The *render* culling should use the same
  sight values, not a separate constant — note for the render step.
- **Fishing boats:** ≤ dozens; harvest is O(n) in the economy tick
  (1 Hz). Negligible.
- **Upgrade effect hooks** are pure multiplications at existing
  computation points — zero per-frame cost.

Record profiling numbers in this doc's successor (implementation step)
per repo AGENTS.md §2.

---

## 11. Rejected ideas (cut with rationale)

| Idea | Why cut |
|---|---|
| SAM site (static AA emplacement) | Buildings can't attack in the current sim — needs building-HP + building-weapons systems. Mobile AA + destroyer/frigate cover the role; static air defense is a Phase-3 fortification pass. |
| Walls / gate / watchtower / bunker | Same: no building HP/combat. Also *design*: bible §A2 favors offense + superweapon pacers; static defense lines risk turtling endgames. |
| Landing craft | Redundant with transportShip (amphibious lift already exists). |
| Cargo plane, tanker ship | Redundant with transport / abstract fuel economy. No new mechanic to justify them. |
| Construction vehicle | Redundant with engineer. |
| Supply truck | No resupply/rearm mechanic exists; hauler covers logistics flavor. |
| Spy / infiltrator | spectre covers sabotage; true espionage (steal research, intel) needs an intel system that doesn't exist. Noted as Phase-3. |
| Carrier air wings (launched aircraft) | Needs a carrier-embark system (docking, launch cycles, wing caps) — a feature, not a unit. Carrier ships as fleet air-defense anchor instead. |
| Police station, fire station | Need a coverage/happiness/services mechanic — doesn't exist. Services that *do* exist (hospital, school, university) made the cut via real outputs. |
| Bank, office tower, hotel | Redundant with shop/market commercial funds engine; bank needs an interest mechanic to be distinct. |
| Warehouse | Needs storage-cap mechanics to be meaningful; otherwise factory-lite. |
| Wind turbines | Solar farm covers the renewable niche; two green power buildings is one too many. |
| Lumber mill | Quarry covers raw materials; two extractors is one too many. |
| Embassy | Mechanically thin (influence already from mediaCenter/monument); Free Trade prereq moved to market. |
| Stealth for submarines | No detection/stealth system; sub identity via range-30 torpedoes + alpha instead — honest and shippable. |
| New resources (oil, steel, etc.) | Bible pillar 6: every resource must earn its place. The 8 existing keys cover all new buildings' inputs/outputs. |
| Kestrel-unique units (Tempest Cannon etc.) | Bible §C11 signature units are *doctrine-layer* work (post-launch asymmetry), not roster work. The shared roster stands. |

---

## 12. Implementation order (proposed)

Each is a repo-AGENTS.md step-gated step (tests + docs + commit):

1. **Training costs** (`trainFunds`/`trainMaterials`, spawnUnit
   deduct) — balance-critical, touches every unit.
2. **Unit defs + kinds** (14 new UnitDefs, counter matrix tests).
3. **Production gating** (`requiredBuilding`, coastal rule, AI virtual
   construction).
4. **Building defs + kinds** (16 new, economy tests, zone tables).
5. **Auras & harvest** (heal aura, command-ship aura generalization,
   fishing harvest).
6. **Upgrades** (`world.upgrades`, `researchUpgrade`, 12 defs, hooks,
   snapshot v6).
7. **AI tables** (composition, counters, upgrade priorities, caps).
8. **UI palettes** (tabs, Hebrew strings, lab research panel).

---

*End of spec. Balance numbers are design values — the implementation
steps own playtest tuning, but any change to a number here must update
this doc in the same commit (repo AGENTS.md §1: a doc that lags reality
is a bug).*
