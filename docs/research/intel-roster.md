# Intel roster — defs design record (workstream 2, 2026-09-30)

> The def-side half of the grand-expansion intel phase (§3.8 / §4 S6,
> `docs/grand-expansion/PLAN.md` Phase 7). Workstream 2 owns the
> **defs only** (buildings, units, upgrades, the `sim/intel.ts` contract
> surface); the sim-core workstream owns the mechanics
> (`infiltrateBuilding` / `sabotage` commands, the `acquireTarget` +
> `getVisibleEnemies` hooks, economy-tick wiring of `runIntelAccrual`).
>
> Status: LANDED — the def-side half shipped in the same checkout as
> the sim-core workstream's mechanics half (both live in
> `game/src/sim/intel.ts`, whose header documents the two halves with
> attribution). The covert-op commands (`infiltrateBuilding` /
> `sabotage` / `stealTech`) exist and are registered in
> `ui/session.ts`; the intel panel UI is still the UI workstream's.
> Version: 0.1 Alpha.

## 1. The roster (what landed)

**Buildings** (`UTILITY_ZONE`, all placed like ordinary buildings):

| Building | Cost (funds/mats) | Build | Age | Generates |
|---|---|---|---|---|
| Listening Post | 500 / 150 | 30 s | Connectivity | 0.25 surveillance/s |
| Signals Station | 900 / 300 | 45 s | Information | 0.20 counterIntel/s |
| Intelligence HQ | 1400 / 450 | 55 s | Information | 0.10 surveillance/s + 0.20 operational/s |
| Satellite Uplink | 2500 / 900 | 90 s | Ascendance | 0.60 surveillance/s |

**Units:**

| Unit | Cost | Stats | Gate | Notes |
|---|---|---|---|---|
| Spy | 400 funds + 40 mats | hp 60, speed 10, sight 30, unarmed | Information age + completed intelHQ | **stealth** (the only stealthed unit in the 68-unit roster) |
| Recon Team | 150 funds + 15 mats | hp 100, speed 14, sight 44, dmg 8/rng 12 | Connectivity age + barracks | overt recon — always visible, like everything else |

**Upgrades** (researched at the lab):

| Upgrade | Cost | Requires | Effect |
|---|---|---|---|
| Signals Intelligence | 1000 funds + 100 research | listeningPost | surveillance income ×1.5; all units +4 sight |
| Counter-Intelligence | 900 funds + 90 research | signalsStation | counterIntel income ×1.25; +25 detection radius; sabotage lasts half as long |

## 2. Balance rationale (the decisions, in plain terms)

**A spy is a real investment, never a cheap nuisance.** 400 funds + 40
materials to train, on top of the intelHQ itself (1400/450, 55 seconds
of construction, Information age). A player who rushes a spy before
their economy is running has spent the price of a small army to learn
where your tanks are. That price is the anti-spam mechanism — there is
no artificial cooldown because the economy already says no.

**The recon team is the honest alternative.** At 150/15 from the
barracks (Connectivity age), anyone can buy good eyes — they just have
to accept being seen. This matters for the peaceful/no-military mode
later (Phase 8): recon is intel without weapons, and it stays useful
even if you never build a spy.

**Three assets, three jobs.** *Surveillance* is the passive stream —
you get it by building the §3.8 buildings and it pays for
recon-adjacent benefits. *Operational* is the spy currency — it funds
the missions the core workstream will add (infiltrate, steal tech via
`addStock`, sabotage). *Counter-intel* is defense. The split keeps one
spender (operational) and one defender (counter-intel) so players can
read the economy at a glance: "they're building signals stations" is a
sentence with meaning.

**Sabotage hurts for 45 seconds but never one-shots an economy.** 45
sim-seconds of a building offline is a real disruption — a factory that
stops refining for most of a minute changes a battle — but it cannot
delete your stockpiles or your buildings. The number is deliberately
not scaled by anything the attacker can buy: sabotage is a tempo tool,
not a win condition. (PLAN §13: no hyper-lethal counter-intel, and by
symmetry, no hyper-lethal intel either.)

**Counter-intel is the visible answer.** Three mechanisms, all readable
without a manual:
1. The signalsStation's detection radius (45 world units) catches
   spies the way a listening post does — defense you can place on the
   map and see working.
2. `counterIntel` researched shortens sabotage 45 → 22.5 s — the
   defender *sees* their building come back online twice as fast.
3. +25 detection radius widens the whole net.

No secret dice, no hidden kill-chance: detection is pure position
geometry (a spy inside a radius is seen, outside is not), accrual is
flat per-second. A player who loses to spies can point at the map and
say exactly why.

**The uplink is the late-game reason to care.** Surveillance 0.6/s is
~2.4× the listening post, but it costs 2500/900 and 90 seconds at
Ascendance age — it is a victory-lap building, not a rush target. Its
+12 sight bonus also feeds the S6 `effectiveSight` hook, so it does
double duty for armies that fight in the open.

**Asset counters are integers in spirit, floats in practice.**
`0.25/s × 1.5 = 0.375` — accrual is float, but the PLAN §13 design rule
holds: flat per-second, no randomness, per-player (no global pools).

## 3. Interface contract (what the core workstream built on it)

Player state: `world.city.players[o].intel = { surveillance,
operational, counterIntel }` (exact contract shape, zeros at
`createPlayer`). Building state: `BuildingRecord.sabotagedUntil`
(tick-space; the `sabotage` command converts `sabotageDurationSec`
sim-seconds to ticks when it lands). Pure helpers in
`sim/intel.ts`: `runIntelAccrual(world, dtSec)` (wired into the
economy tick), `isDetected(unit, viewerOwner, world)`,
`detectionRadiusAt(world, owner, x, z)`,
`sabotageDurationSec(world, victimOwner)`, `intelSightBonus(world,
owner)` (moved to `upgrades.ts`, re-exported — the `effectiveSight`
hook consumes it), `isSabotaged`, `getIntelAssets`.

The operations half (sim-core workstream, same file): `infiltrateBuilding`
(a spy adjacent to an enemy building infiltrates over 600 ticks / 20
sim-seconds, then is *embedded*), `sabotage` (25 operational assets —
the target building goes offline for 45 sim-seconds, 22.5 with the
victim's counterIntel), `stealTech` (15 surveillance — an embedded
spy steals a tech for +40 research). Spot checks can burn the spy
(`spottedUntil` — visible to everyone for 900 ticks). Mission
outcomes draw from named `intel-<owner>` RNG streams (thief rolls on
the thief's stream, spot checks on the victim's) — deterministic per
world seed, no `Math.random()`.

## 4. What is deliberately NOT here (PLAN §13)

- No dice rolls in the asset/detection core: accrual is flat
  per-second, detection geometry is pure, sabotage duration is a
  fixed number with a fixed counter-intel multiplier. (Mission
  *outcomes* — steal success, spot checks — do roll, on seeded
  named streams: the sim-core workstream's explicit decision,
  documented in `sim/intel.ts`'s header.)
- No global pools: assets are per-player counters.
- No counter-intel that kills: counter-intel shortens sabotage and
  widens detection — it never destroys units by itself.
- No intel panel UI (the UI workstream's); the research-panel group
  and palette tabs render the defs, nothing more.
- No art: 7 real CC0 model keys mapped by the art workstream
  (`spy`, `reconTeam`, `intelHQMain`, `listeningPostHut/Dish`,
  `satelliteUplink`, `signalsStationHut` — see
  `docs/research/phase6-intel-art.md`); the 6 provisional SVG glyphs
  in `ui/icons.ts` remain until the UI workstream draws the final
  art. The 8 MiB boot gate is untouched (render falls back to
  placeholder for unmapped kinds).

## 5. Tests

`game/tests/sim.intel-roster.test.ts` — 21 tests: def validity
(including "the spy is the ONLY stealthed unit"), the intelHQ-trains-
spy gate (rejects without a completed intelHQ, with the building's
name in the reason), accrual math over 100 sim-seconds, sabotage
suspends accrual and recovers, upgrade multipliers, detection
pure-geometry (inside/outside/overlap/+25/victim-vs-attacker owner
asymmetry), sabotage duration 45 → 22.5 s, v8 snapshot round-trip of
`intel` + `sabotagedUntil` (incl. legacy states decoding to zero,
AD9 — matches PLAN §11's "No bump" list), digest determinism and
digest coverage of accrual.
