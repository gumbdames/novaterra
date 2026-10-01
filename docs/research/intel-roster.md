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
| Spy | 400 funds + 40 mats | hp 60, speed 10, sight 30, unarmed | Information age + completed intelHQ | **stealth** (spy + spectre are the two stealthed units in the 96-unit roster — R1 final-review 2026-10-01, user decision) |
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

Plus the stockpile: counter-intel *assets* (not just the upgrade)
sharpen sabotage spot checks (+0.002 burn chance per asset, capped at
+0.30 over the 0.35 base) and blunt tech steals (−0.001 success per
asset, capped at −0.15, stacking with the upgrade's −0.15). A
signalsStation's 0.2/s reaches the caps after ~12 minutes — sustained
investment, not a rush buy. "They're stockpiling counter-intel" is a
sentence with meaning: your spies get caught more.

**Detection has an off switch.** A sabotaged or unpowered detector is
blind (`detectionRadiusAt` skips it — the same "completed and working"
gate as accrual). Sabotage the listening post, *then* walk the spy in:
that's the intended raid loop, and the test suite pins it.

**"Embedded" means inside.** `stealTech` requires the spy to be
adjacent to its post, not just flagged embedded — a spy that walked
home cannot steal remotely.

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
(including "spy + spectre are the two stealthed units" — R1
final-review, user decision 2026-10-01), the intelHQ-trains-
spy gate (rejects without a completed intelHQ, with the building's
name in the reason), accrual math over 100 sim-seconds, sabotage
suspends accrual and recovers, upgrade multipliers, detection
pure-geometry (inside/outside/overlap/+25/victim-vs-attacker owner
asymmetry), sabotage duration 45 → 22.5 s, v8 snapshot round-trip of
`intel` + `sabotagedUntil` (incl. legacy states decoding to zero,
AD9 — matches PLAN §11's "No bump" list), digest determinism and
digest coverage of accrual.

`game/tests/sim.intel.test.ts` — 36 tests: the covert-op commands
(validation, costs, mission flow, RNG branches on pinned seeds),
combat/AI/effectiveSight hooks, save/load round-trip, digest
coverage, plus 6 hardening tests from the 2026-09-30 audit (detection
gates, spot/steal chance math + caps, stealTech proximity,
getIntelAssets robustness).

## 6. Audit hardening (2026-09-30)

Post-commit audit of the 9fd8de3 roster + mechanics found and fixed:
- `detectionRadiusAt` ignored sabotage/power: a dark listening post
  still detected spies. Now skips sabotaged and non-operational
  buildings (same gate as accrual).
- `counterIntel` assets were a dead currency (accrued, never spent).
  They now defend passively: `sabotageSpotChance` / `stealSuccessChance`
  (extracted pure helpers) scale with the victim's stockpile, capped.
- `stealTech` let an embedded spy steal from across the map. Now
  requires adjacency to its post.
- `runIntelAccrual` docstring claimed intel buildings "still report
  when the lights are out" — false (code gates on `operational`).
  Doc now matches code.
- `getIntelAssets` claimed undefined-safety but would throw on a
  player record without `intel`. Now truly `?.`-safe.
- `tests/sim.intel.test.ts` had 11 strict-null tsc errors
  (`npm run typecheck` was red). Fixed; typecheck green.

Known gap (not fixed — AI workstream's domain): the AI never builds
intel buildings or runs spy missions; it only defends (its
`getVisibleEnemies` respects `isDetected`). In AI games the intel
roster is currently player-only.

## 7. Recon value + mixed-airport discovery (workstream 3, 2026-09-30)

The recon half of S6, on top of the defs above: what surveillance
buildings and recon units are worth on the map, and how a mixed
airport stops being a secret. Two deliverables.

### 7.1 The building sight term (recon value)

`buildingSightCoverage(world, owner)` (sim/intel.ts) is the third leg
of `getVisibleEnemies` (ai.ts), after unit sight and the Signals Grid
bonus. It runs at AI think cadence — never per-tick in combat
(PLAN §4 S6): combat's `acquireTarget` still consults unit sight only,
so a radar contact the AI "knows about" has to be engaged by a unit
that can reach it. The term is inert for Classic AI owners today (they
own no physical buildings) but is wired per the S6 hook spec and
tested directly.

Two flavors, by design:

- **SIGINT** (`detectionRadius`, already on the defs): listeningPost 60,
  signalsStation 45, +counterIntel bonus. Sees EVERYTHING inside,
  including spies — consistent with the `isDetected` gate, which keys
  off the same radius.
- **Conventional radar** (new `BuildingDef.radarRadius`, set to 90 on
  radarStation only): sees non-stealthed enemies only. The deliberate
  asymmetry: if cheap Connectivity-age radar could see spies, the
  Information-age counter-spy game would be obsolete before it exists.
  The counter-spy monopoly stays with SIGINT.

satelliteUplink gets no geometric term — it already flows through
`intelSightBonus` → `effectiveSight` (+12 to every unit's sight). A
second, overlapping mechanism would double-count the same fantasy.

The gate mirrors accrual (hardened in §6): a building contributes only
when completed + operational + unsabotaged. A dark or sabotaged post is
blind — the counterplay is on the map, and it's consistent: the same
outage that stops intel accrual stops detection (§6) stops coverage.

### 7.2 The recon units (no separate term)

reconTeam, reconUAV, reconPlane carry `UnitDef.recon: true` (exactly
these three) and contribute through the EXISTING unit-sight path in
`getVisibleEnemies` — their high platform sight (44 for the team) is
the recon value. No separate building-style term, no double counting.

### 7.3 Mixed-airport discovery: observation, warning, grace, reveal

Discovery is observation-based, not purchased. Three sources, any one
suffices on a given tick:

1. An embedded, unburned spy of the viewer (`embeddedIn === airport.id`;
   burned spies report nothing — their reports are tainted).
2. SIGINT coverage: the viewer's `detectionRadiusAt` covers the airport
   center.
3. Recon overflight: a living recon unit whose sight (platform sight +
   `intelSightBonus`) covers the airport center.

Rejected: spending surveillance assets to reveal airports. Assets gate
sabotage/steal (operations); discovery is observation. Buying a reveal
with no map presence would be exactly the "gotcha" the plan forbids.

Lifecycle, per viewer, on `BuildingRecord.discovery`
(`AirportDiscoveryState[]`, AD9 additive — older saves decode to
undefined, no snapshot bump, stays v8):

- First observed tick → `suspected` record (warnedTick = now). **This
  is THE WARNING** ("suspicious military activity at [airport]"), shown
  in the intel panel with a countdown. The display still reads
  civilian — the warning is not the reveal.
- After exactly `AIRPORT_DISCOVERY_GRACE_TICKS = 1800` (60 sim-seconds;
  same order as infiltration 20 s / sabotage 45 s) → `revealed`. The
  display flips to the true type (`mixed`) for that viewer, and the
  discovering side's AI may treat the site as a military target later.

Decisions, with rationale:

- **Suspicion latches** (no decay, no re-observation during grace).
  The grace period is the analysis window, not a second observation
  gate: once the photos exist, analysis is inevitable. Decay would make
  the warning a bluff; the plan demands the warning precede the
  consequence, always.
- **No RNG.** Pure geometry + fixed timers; the `intel-<owner>` streams
  stay reserved for action rolls (steal/sabotage). Discovery has no
  dice — a player who sees the warning knows exactly when the reveal
  lands.
- **The owner never discovers their own airport** (skipped explicitly).
- **Runs every tick** via `createIntelSystem`, not think-gated: AI
  perception and the human's intel picture read the same shared state.
  Cheap — early return when no mixed anchors exist.

### 7.4 The UI seam (what the panel owns)

Workstream 3 owns sim state + timers + the display-rule flip; the
intel panel (separate workstream) owns presentation. The seam:

- `discoveryStateOf(b, viewer)` (ui/airports.ts) — the panel's read
  into the sim record.
- `airportDisplayType` (ui/airports.ts) — honors the reveal: `mixed`
  only when the viewer's record is `revealed`; `suspected` still reads
  `civilian`.
- `discoveryWarnings(world, owner)` (ui/intel.ts) — one warning per
  suspected rival airport, with the grace countdown in sim-seconds and
  a what-happens-next line, wired into `intelWarnings`.
- `rivalAirports` (ui/intel.ts) — `discovered` reads the sim state
  (`revealed`), not the old `trueType !== 'mixed'` heuristic; a new
  `discoveryState` field lets the panel distinguish "under review"
  from "confirmed".
- Strings in the ui/strings.ts `intel` section (English-only via
  `loc()`/`fillLoc()`): `discoveryWarnTitle` ("Suspicious military
  activity at {name}"), the countdown detail, the next-step line, and
  the `CONFIRMED — military-capable` flag.

### 7.5 Tests

`game/tests/sim.intel-sight.test.ts` — 22 tests, all deterministic
(discovery is geometry + fixed timers, zero RNG): the SIGINT/radar
flavors and their blind spots, the completed/operational/unsabotaged
gate (three blind-building cases), the satelliteUplink hook pin,
recon sight on the unit path, the think-cadence-only combat pin
(radar-known but un-acquirable), the full warning → 1800-tick →
reveal lifecycle, the latch (observer leaves, reveal still lands), no
false discoveries (out-of-range recon; civilian/military anchors
never), the three observation sources, burned-spy exclusion,
owner exclusion, viewer-sorted idempotent records, the UI seam
(warning countdown 60 s → empty after reveal; rival list flips
civilian/UNVERIFIED → mixed/CONFIRMED), save/load round-trip of both
states, digest coverage (discovery changes the digest) and
seed-stability, and the def-level pin (mixed reads civilian until
discovered).
