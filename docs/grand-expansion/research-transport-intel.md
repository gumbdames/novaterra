# Research: Airport/Airline/Transport Mechanics & Espionage/Intel Systems

Deep research for the NOVATERRA grand expansion (airport zones, civilian airline, naval aviation, multi-modal transport, intelligence system). Researched 2026-09-30.

**Standing-rule note:** This document is a formal research citation file (the one permitted exception to the no-commercial-titles rule). Game titles appear here ONLY as cited sources with URLs. The shipped game and all other docs must continue to describe mechanics in NOVATERRA's own neutral terms.

---

## 1. Mechanics survey with concrete examples

### 1.1 Airport & airline management games

**Airport CEO (Apoapsis Studios)** — the closest reference for "grow a small airfield into a huge airport":
- **Tiered progression:** start with General Aviation (small stands + small runway), then unlock small commercial, medium, large, international. Each tier needs bigger runways, stands, terminals, baggage systems, staff. Progression is gated by *buildings you construct*, not just time.
- **Modular building:** terminals are laid out room-by-room (check-in, security, gates, shops), runways/taxiways placed freely, ATC tower, fuel depots, vehicle depots. Deep customization.
- **Economy:** airline contracts, landing fees, fuel contracts (buy fuel, sell to airlines), ticket/passenger spending, staff wages. Multiple revenue streams.
- **Key failure (placebo mechanics):** a widely-endorsed Steam review documents that many decisions don't actually matter — a huge airport runs fine with zero baggage system, fines are negligible, staff quality barely moves the needle. Once the economy snowballs, money stops being a constraint. ("This is not a management game... the whole city is my parking lot.")
- **Key success (first-plane moment):** reviewers consistently say the best moment is laying the first runway on a blank canvas and watching the first planes land/take off. The *creative act + visible payoff* loop is the core fun.

**Airline Manager (Trophy Games, mobile/browser)** — the "run your own airline" side:
- Fleet purchase (400+ real aircraft models), route planning between airports, seat-class configuration and ticket pricing, maintenance scheduling, fuel/CO2 market timing (buy fuel cheap, burn later), staff management, marketing campaigns, alliances.
- Success = route economics: match aircraft type/range to routes, load factor, fuel price timing. The fun is optimization of a few visible numbers (profit per route), the tedium risk is repeating the same setup 200 times.

**Cities: Skylines — Airports DLC** — the closest reference for "airports as painted zones":
- Airports are painted *areas* (like districts) containing modular buildings: terminals, concourses, gates, hangars, cargo terminals, runways, taxiways. Area levels 1–3 unlock more modules.
- **Key failure (decorative modules):** critics found most modules purely decorative — even the ATC tower is not functionally required. Three visual styles are functionally identical. Area levels up by total visitor count, which happens just by waiting.
- Lesson: zone/area mechanics fail when (a) pieces are decorative, (b) leveling is time-based, (c) styles are cosmetic-only.

**OpenTTD (transport tycoon)** — the cautionary tale for aircraft in a hybrid:
- Airports are the *shallow* subsystem: build airport (4 size classes), build aircraft, assign orders. Planes are overpowered money-makers with almost no management depth. The one interesting mechanic: **aircraft class vs airport class** — big planes have a crash chance landing at small airports, so you must match plane class to airport class deliberately. A hidden rule that punishes mismatches (an AI-agent postmortem documents losing three expensive aircraft to this invisible rule).
- Transport payment formula: income = cargo amount × distance × speed bonus × perishability. Perishable cargo (passengers, mail) pays for *speed*; bulk cargo pays for *capacity*.

### 1.2 Carrier & naval-aviation mechanics

**Supreme Commander (Gas Powered Games)** — carriers as *air staging platforms*:
- Carriers do not build planes; they are offensive forward bases. Aircraft built elsewhere land on carriers to **refuel and repair** (fuel is a real resource: running out doesn't crash planes but cripples speed).
- The *Atlantis* experimental: a submersible carrier that sneaks underwater (radar/sonar-shielded) to an enemy base, surfaces, and launches a surprise air strike. Stealth + carriers = memorable gameplay.
- Design takeaway: separate *production* (air factories/airfields) from *projection* (carriers as mobile refuel/rearm/repair bases). Fuel/range logistics make carriers strategically necessary on large maps rather than cosmetic.

**Noobs in Combat (Roblox-style turn-based strategy)** — "empty carrier + assigned air wing":
- Carrier comes pre-equipped with one dive bomber and can hold two more aircraft. Planes land by moving onto the carrier's tile; the carrier auto-resupplies damaged/unloaded aircraft each turn.
- Carrier has no attacks, is very slow, and is a high-value defenseless target — *escorts are mandatory* (destroyers, cruisers). Extra planes and replacements cost extra, making the carrier an economic commitment, not just a hull.
- Takeaway: "carrier arrives empty-ish, you fill its slots" is proven and legible; vulnerability forces combined-arms play.

**Naval warfare sims (War in the Pacific / community wisdom)** — *carry-capable vs carrier-trained*:
- Two separate properties: the **aircraft** being physically able to operate from a carrier, vs the **pilots** being trained for carrier ops (reduces operational losses on takeoff/landing). Training takes ~90 days of a unit sitting on a carrier. Air wings use role ratios (~3/7 fighters, 2/7 dive bombers, 2/7 torpedo bombers on large carriers; small carriers skew fighter-heavy).
- Takeaway: a small pilot-training/veterancy layer on top of the "carrier-capable" flag adds depth without new UI — it maps cleanly onto NOVATERRA's planned unit veterancy.

**Carrier Command: Gaea Mission (Bohemia)** — carrier as mothership + amphibious RTS:
- The carrier is a mobile arms depot carrying amphibious tanks and aircraft; units are commanded from a map or directly. Key mechanics: unit vision/ effectiveness *decreases with distance from the carrier*, and the game dilates time while the carrier travels between islands so the player is never idle.
- Amphibious assaults on islands that become mines/factories/defenses. Takeaway: carriers as the player's *forward operating base* with a distance-decay on unit effectiveness is an elegant way to make "station infantry on carriers, deploy via dinghies/helicopters" tactically meaningful.

### 1.3 Transport variety: road/rail classes, trams, ferries, marinas

**OpenTTD + community NewGRF sets (Timberwolf's Roads, U&RaTT, Iron Horse)** — what road/rail *classes* actually change:
- **Speed limits per road class:** dirt road → country road → asphalt → highway, each with a higher vehicle speed cap. Roads are convertible/upgradable. This makes road class a real economic decision: pay more now for faster trips (which matters because payment rewards speed for perishables).
- **Track classes (Iron Horse):** standard / electric / high-speed / narrow-gauge, each with different speed caps and compatible vehicle sets. Electrification is an infrastructure investment that unlocks better trains.
- **Trams (Generic Tram Set, forum wisdom):** trams almost always beat buses in-game because of the **capacity-vs-speed triangle** — a slow 150-passenger tram on a 10-tile route out-earns a fast 40-passenger bus. Players pick trams for high-volume urban corridors, buses for thin routes. The tradeoff is *legible*: capacity ↑, speed ↓, needs rails on streets.
- **Loading speed by role (2cc TrainSet):** intercity (slow load, fast), commuter (medium), metro (fast load, slow) — dwell time as a design knob.

**Transport Fever 3 (Urban Games)** — what made multi-modal transport *interesting* rather than cosmetic:
- Towns grow or shrink based on transport quality: reliable, uncrowded service → growth; overcrowded/unreliable → passengers switch to private cars, factories shutter if unprofitable.
- New eras bring new vehicles *and* new expectations (emissions rules can obsolete old vehicles).
- Takeaway: transport is interesting when it feeds a **demand loop** (town growth, industry survival), not when vehicles are stat cards.

**Pocket Gamer's Transport Tycoon review** — the fun/tedium line: "a hectic jigsaw of things that can, and will, go wrong" is the fun; the tedium is the 10-click setup per bus (buy bus → build stops → place on road → orders menu → waypoints → go). Lesson: automate the routine (default routes, clone-with-orders), keep the puzzle.

### 1.4 Espionage / intel / recon systems

**Hearts of Iron IV: La Résistance (Paradox)** — the fullest "tech + spies + recon" system in a strategy game:
- Build an intelligence agency (upgradable branches: e.g. cryptography), recruit named operatives with traits (nationality matters — a French spy works better in France), level them up, risk capture/wounding/death.
- **Networks, not missions:** spies first *infiltrate* to build network strength in a region over time; only then can operations (sabotage, intel theft, collaborator-building) run. Networks decay if neglected.
- **Intel has combat effects:** cryptography advantage reveals enemy forces/industry; radar + recon planes add intel; intel translates into planning/combat bonuses.
- **Consequences:** captured spies slowly leak *your* intel to the enemy; enemy counter-intelligence can catch them; resistance cells in occupied territory are a parallel use of the system.
- Reviews: "didn't require much micromanagement," "fun addition," but some players found it a minor DLC if ignored — it works as an optional layer that rewards investment.
- A community rebalance mod documents the design math: infiltration ~120 days, follow-on ops ~45 days, agents gain XP even from quiet network maintenance, overlapping radar/recon boosts intel.

**Rock Paper Shotgun's "Excellent Espionage" (design proposal)** — the sharpest critique of why spy missions usually fail:
- Problem: missions are resolved as single dice rolls, and because the target only learns about them *after* they happen ("bolt from the blue"), designers neuter them into irrelevance.
- Proposal: spies gather **intelligence assets** (cards in themed categories) over time; missions *spend* assets; the defender spends **counter-intelligence assets** to block them in a visible back-and-forth. This converts espionage from a dice roll into **tense resource management** with readable stakes. Spies level up to produce specific asset types (specialization). Cards tell stories (a Double Agent steals the asset it blocks *and* reveals the attacker's identity).
- This maps almost 1:1 onto NOVATERRA's planned "tech + spies + recon" — and it's deterministic-friendly: asset accumulation and spending are counters, no RNG needed.

**Civilization series (Firaxis)** — the fun-vs-annoying spectrum:
- Civ IV: espionage points spent globally → "wasteful war of attrition," cheap to counter, minimal impact unless you devote everything to it. *Avoid.*
- Civ VI: spies are built units with promotions, sent to specific cities for specific missions (steal tech, steal great works, sabotage). Fun moments: stealing a great work, ransoming captured spies, promotions. Annoying: fiddly UI, spies "level up really fast and die constantly," counter-agents feel too lethal (CivFanatics). Passive intel also accrues via embassies/trade routes/religion — intel as a *byproduct of contact*, not only of spies.
- Takeaway: named/promotable spies with specific missions = fun; global point pools and hyper-lethal counters = tedium/attrition.

**Phantom Doctrine (CreativeForge)** — intel with *consequences*:
- The corkboard: intel arrives as clue fragments you pin and link to unlock locations/missions. Intel *analysis* is itself gameplay.
- **Discovery risk:** enemy agents hunt your HQ; if your location is discovered you must relocate the entire base (major setback) or face ambush. Aggressive spy activity raises your heat. This makes espionage a risk/reward thermostat, not free actions.
- Directly relevant to the "mixed airport discovered by enemy intel → earlier strikes" design goal.

**Recon units in tactical games (Advance Wars)**:
- The Recon is the classic cheap/fast/high-vision unit: highest vision range, fast on roads, weak in combat. Essential under fog of war; early-game also useful for grabbing territory. Its value is *pure information* — players build it because vision wins fights, not because it fights.
- Takeaway: recon units work when vision is genuinely scarce and valuable (real fog of war), and they stay relevant if they have a secondary early-game job (fast territory grab).

**Carrier Command vision decay** (again, §1.2): unit effectiveness decreasing with distance from the carrier is a *logistics-of-information* mechanic — relevant to recon range design.

### 1.5 Mixed civilian/military assets & intel-driven targeting

**No direct commercial-game precedent found.** No surveyed game implements "a civilian airport/port with a hidden military section that enemy intel can expose, changing its targeting priority." Closest mechanics:
- **Disguise & detectors (Command & Conquer series):** spies disguise as enemy units; stealth tanks cloak; submarines submerge. Countered by *detector* units/structures (attack dogs sniff spies, destroyers/sonar pulse find subs, base defenses see cloaked tanks). Stealth breaks when attacking. This is the classic *hidden-asset vs detection-capability* arms race — the direct ancestor of any "hidden military section" mechanic.
- **Phantom Doctrine HQ discovery** (§1.4): hidden base → discovered → forced relocation/ambush. The *discovery event* is the consequence engine.
- **DomiNations decoys / wargame decoy counters:** fake units that draw enemy attention — the inverse (making military things look civilian is the same information game in reverse).
- **SIGNAL (academic wargame, Sandia/Berkeley):** players explicitly signal civilian vs military infrastructure builds; opponents react to the *signals*. Shows the concept is legible to players even in abstract form.
- Design implication: the "mixed airport" mechanic is *novel* — no proven template, but the C&C detector/stealth arms race + Phantom Doctrine discovery-consequence give the two halves (hiding/detection, discovery/consequence).

---

## 2. FUN vs TEDIOUS analysis

### What consistently produced FUN

1. **The first-plane moment** (Airport CEO reviews): build runway → first landing. Creative act + immediate visible payoff. *Lesson: every transport/airport investment should have a visible "it works!" moment.*
2. **The jigsaw puzzle of connections** (OpenTTD/Transport Tycoon reviews): fitting road/rail/air/sea together around terrain and towns. *Lesson: keep the network-building puzzle; automate the per-vehicle clicking.*
3. **Capacity/speed/cost triangles with legible tradeoffs** (OpenTTD trams vs buses; road classes; track classes): players enjoy *choosing* the right tool for a corridor. *Lesson: 2–3 knobs per transport type, each visibly changing outcomes.*
4. **Intel as resource management with readable stakes** (RPS Excellent Espionage proposal; HOI4 networks): accumulating assets, choosing when to spend, visible counter-play. *Lesson: intel should be a stock you manage, not a dice roll.*
5. **Spy fantasy moments** (Civ VI: stealing a great work, ransoming a spy; Phantom Doctrine: linking corkboard clues): named agents, specific missions, stories. *Lesson: a few characterful agents beat a global point pool.*
6. **Surprise projection** (Supreme Commander Atlantis; Noobs in Combat carrier strikes): carriers enabling strikes the enemy couldn't see coming. *Lesson: carriers are fun as *enablers of surprise*, which is exactly what intel/counter-intel should contest.*
7. **Demand feedback loops** (Transport Fever: towns grow/shrink with service quality): transport visibly changes the world. *Lesson: civilian transport must move population/goods numbers the player can see.*

### What consistently produced TEDIUM (avoid)

1. **Placebo mechanics** (Airport CEO Steam critique): decisions that don't move any number (decorative hangars/ATC in Skylines Airports; unenforced fines). *Every purchasable thing must change a visible number or unlock a visible capability.*
2. **Leveling by waiting** (Skylines Airports areas level on visitor count over time). *Gate progression on constructed capabilities, never on accumulated time.*
3. **Per-vehicle/per-staff micro** (Pocket Gamer's 10-step bus; maintenance scheduling spam). *Automate routine: default behaviors, clone-with-orders, depot-level auto-repair; player decides routes and fleet mix, not each vehicle's checklist.*
4. **Espionage as global point attrition** (Civ IV): everyone accrues, everyone counters, nothing happens. *Intel must be positional (networks in places, assets for missions) not a global pool.*
5. **Hyper-lethal counters** (Civ VI counter-spies killing leveled spies constantly; CivFanatics). *Counter-intel should degrade/block, not routinely execute — death should be rare and memorable.*
6. **Bolt-from-the-blue punishments** (RPS critique): intel events the player couldn't see coming or respond to. *Every intel consequence needs a warning state and a counter-play window (raise alert, relocate, counter-intel surge).*
7. **Invisible rules** (OpenTTD big-planes-crash-at-small-airports): a punishing rule the UI never states. *If plane class must match airport class, show it in the build UI before purchase.*
8. **Fiddly spy UI** (Civ VI complaints): sending each spy to each city through nested menus. *One intel screen: operatives assigned to theaters/networks, missions on deterministic timers.*

---

## 3. Adopt / avoid recommendations for NOVATERRA

NOVATERRA constraints to design against: deterministic fixed-timestep sim (no hidden RNG in mechanics — use seeded streams only), browser UI (must stay legible at a glance), English-only strings, version 0.1 Alpha, RTS-city-builder hybrid (both build-phase and combat-phase players).

### ADOPT

**A1. Airport zones with capability-gated tiers (not time-gated).**
Paint an airport zone; tier = the *modules built inside it* (runway class → stands → hangars → fuel depot → terminal/cargo). Each tier visibly unlocks: bigger runway class accepts bigger plane classes (the OpenTTD plane-class/airport-class rule, but *shown in the UI*); each hangar built for aircraft type X unlocks building type X at that airport. Never level-by-waiting (Skylines Airports failure). This directly implements design goals (1) and (2). *Why it fits:* deterministic (construction state is sim state), legible (zone panel lists "accepts: small/medium"), and every module changes a number or unlocks a capability (anti-placebo).

**A2. Carriers as empty hulls + assigned air wings + forward staging (Supreme Commander + Noobs in Combat model).**
Carrier built empty; player assigns carrier-capable aircraft built at airfields (land on carrier → embark). Carrier provides refuel/rearm/repair in the field and extends effective range — on a large map this makes carriers *necessary*, not decorative. Infantry embark → deploy via dinghy/helicopter at shorelines (Carrier Command's forward-operating-base idea). Carriers are defenseless-ish and slow → escorts mandatory → combined-arms fleet play. Pilot carrier-training as a veterancy overlay (WITP's carry-capable vs carrier-trained distinction) maps onto the planned veterancy system with zero new UI. *Why it fits:* all state (embarked wing, fuel, damage) is deterministic; the "fill the slots" interaction is proven legible; it makes naval play about projection and surprise — the fun half of naval aviation.

**A3. Intel as a deterministic asset economy (RPS "Excellent Espionage" + HOI4 networks).**
Three intel currencies per theater/region: *surveillance assets* (from recon units, radar stations, AWACS-type aircraft, spies in place), *operational assets* (spent on missions: sabotage, steal tech, expose hidden military section), *counter-intel assets* (spent to block enemy missions and degrade their networks). Spies are named, promotable units assigned to regions; they *build networks over time* (HOI4 infiltration, deterministic progress bars), not instant dice rolls. Recon units feed the surveillance stock — this makes recon planes/drones valuable even in peacetime. *Why it fits:* counters and timers are exactly what a deterministic sim does well; no RNG needed; it gives peacetime gameplay (the "excellent civilian side / peaceful mode" goal) real teeth — intel races are the peaceful-mode conflict.

**A4. Mixed-use discovery as a warned, counterable event (Phantom Doctrine + C&C detectors).**
A mixed airport/port shows as civilian to enemies until their surveillance stock against that region passes a threshold (reduced by your counter-intel, camouflage tech, physical separation of the military section). On discovery: *warning + grace period* ("enemy recon activity detected near North Airport — military section suspected"), during which the player can relocate assets, surge counter-intel, or accept the risk. Only after the grace period does the site become a valid priority target for enemy AI strikes. *Why it fits:* avoids bolt-from-the-blue (tedium #6); creates the intended risk/reward for mixed use (cheaper/shared infrastructure vs exposure); novel mechanic with proven halves.

**A5. Transport classes as a 3-knob triangle (OpenTTD road/track classes + tram lesson).**
Road types: dirt/country (cheap, slow) → paved → highway (expensive, fast) — speed cap per class, upgradeable in place. Rail: standard → electric → high-speed, each unlocking faster/larger trains (infrastructure investment gates vehicle quality — Iron Horse model). Trams: slow, huge capacity, cheap street-running — the urban workhorse. Ferries: connect "boat stations" (cheap, small) rather than full ports — point-to-point water crossing. Marinas: civilian boat storage/services scaling by size/tech. Every class changes exactly: speed cap, capacity, cost. Civilian transport feeds visible town-growth/industry numbers (Transport Fever demand loop) — buses/trams/ferries moving population that grows zones. *Why it fits:* 3 knobs stay UI-legible; the demand loop gives the civilian economy a reason to exist in a war game; ferries-as-cheap-crossings avoid the "must build a full port" trap.

### AVOID

**X1. Decorative modules and time-based leveling.** (Skylines Airports, Airport CEO placebo critique.) If a hangar/ATC/marina piece doesn't change a number or unlock a capability, don't ship it.
**X2. Per-vehicle micro-management.** (Pocket Gamer bus setup.) Ship "clone with orders," default civilian routes (town A ↔ town B shuttle), depot-level auto-maintenance. Player manages *routes and fleet mix*.
**X3. Global espionage point pools and instant spy dice-rolls.** (Civ IV attrition, RPS bolt-from-the-blue.) Intel must be positional, asset-based, and telegraphed.
**X4. Hyper-lethal counter-intel.** (Civ VI.) Counters degrade networks and block missions; spy death is rare, costly, and memorable — never routine.
**X5. Hidden punishing rules.** (OpenTTD plane-class crash rule.) Any class-matching requirement (plane↔runway, ship↔port size, train↔track) must be visible in the build/purchase UI *before* the player commits.

---

## 4. Sources (full URLs)

**Airports / airline management**
- https://play.google.com/pc-store/games/details?id=dk.xombat.airlinemanager4 (Airline Manager 2026 — fleet, routes, maintenance, fuel/CO2 markets, staff)
- https://airportceo.fandom.com/wiki/General_Aviation (Airport CEO wiki — GA progression: stands → runway → ATC → fuel contracts)
- https://steamcommunity.com/app/673610/reviews/?l=portuguese&browsefilter=toprated (Airport CEO top review — placebo-mechanics critique)
- https://store.steampowered.com/app/673610/CEO/ (Airport CEO — modular terminals, staff roles, contracts)
- https://www.gamesfreezer.co.uk/2019/12/airport-ceo-rapid-review-early-access.html (Airport CEO review — first-plane moment; weak tutorial)
- https://www.pcgamer.com/the-new-cities-skylines-expansion-is-all-about-big-modular-airports/ (Cities: Skylines Airports announcement — modular airport areas)
- http://www.megabearsfan.net/post/2022/03/16/Cities-Skylines-Airports-DLC-game-review.aspx (Airports DLC review — decorative modules, level-by-waiting critique)
- https://ladiesgamers.com/cities-skylines-airports-dlc-review/img_6893/ (Airports DLC review — area tool, modular growth small airfield → hub)
- https://steamcommunity.com/app/255710/discussions/0/3371531264824255788/ (Airports DLC vs Sunset Harbor discussion — restrictive, clunky)
- https://en.wikipedia.org/wiki/OpenTTD (OpenTTD — payment formula: quantity × speed × perishability; path signals)
- https://news.ycombinator.com/item?id=32698851 (OpenTTD mechanics discussion — planes overpowered; station ratings)
- https://github.com/deepsaia/nttd/blob/HEAD/agent_network_design.md (OpenTTD AI postmortem — big planes crash at small airports: the hidden class rule)
- https://www.pocketgamer.com/transport-tycoon/review/ (Transport Tycoon review — jigsaw fun vs 10-step bus tedium)
- https://www.resetera.com/threads/transport-fever-3-ot-planes-trains-and-autoerotic-systemization.1645231/ (Transport Fever 3 — demand loops, town growth, reputation)

**Carriers / naval aviation**
- https://supcom.fandom.com/wiki/Aircraft_carrier (Supreme Commander — carriers as air staging/refuel platforms)
- https://supcom.fandom.com/wiki/Fuel (Supreme Commander — fuel as range logistics; carriers replenish instantly)
- https://www.gamespot.com/articles/supreme-commander-walkthrough/1100-6166295/ (SupCom walkthrough — Atlantis submersible carrier surprise strikes)
- https://noobsincombat.fandom.com/wiki/Aircraft_Carrier (Noobs in Combat — empty-ish carrier, land-to-embark, per-turn resupply, defenseless → escorts)
- https://nws-online.proboards.com/thread/3931/tips-group-compositions-bases-carriers (Naval warfare sims — air group composition ratios; carrier doctrine)
- https://forums.matrixgames.com/download/file.php?id=1247684&sid=51a62669577679595eaa4e03a3891ce0 (Air War guide — "carrier trained" vs "carry capable" pilots; ~90-day training)
- https://www.pcgamer.com/carrier-command-gaea-mission-preview/ (Carrier Command — mothership carrier, vision decays with distance, amphibious assaults)
- https://www.pcgamesn.com/task-force-admiral/kickstarter-ww2-strategy-game (Task Force Admiral — recon/spotting-first carrier warfare)
- https://www.gamingonlinux.com/2018/07/naval-rts-victory-at-sea-pacific-to-have-over-120-types-of-ships-and-planes/ (Victory At Sea — amphibious assaults, scout planes, supply lines)

**Transport variety**
- https://www.tt-forums.net/viewtopic.php?style=1&t=76695&start=20 (OpenTTD forums — trams beat buses via capacity; tram design philosophy)
- https://wiki.openttd.org/en/Community/NewGRF/Generic%20Tram%20Set (Generic Tram Set — tram stats: slow, high capacity)
- http://en.namu.wiki/w/OpenTTD/NewGRF (NewGRF survey — Iron Horse track classes; U&RaTT speed-limited road classes)
- https://www.tt-forums.net/viewtopic.php?t=84591 (U&RaTT — road/tram/rail types with speed limits)
- https://wiki.openttd.org/en/Community/NewGRF/2cc%20TrainSet (2cc TrainSet — loading speed by role: intercity/commuter/metro)

**Espionage / intel / recon**
- https://www.rockpapershotgun.com/strategy-game-espionage (RPS "Excellent Espionage" — critique of dice-roll spy missions; intel-asset economy proposal)
- https://www.pcgamer.com/hearts-of-iron-4-la-resistance-preview/ (HOI4 La Résistance preview — named operatives, networks, cryptography branch, captured spies leak intel)
- https://www.pcgamer.com/hearts-of-iron-4-la-resistance-will-let-you-build-a-spy-network-next-month/ (HOI4 agencies, counter-intel, recon units, collaborators)
- https://www.gamingonlinux.com/2020/02/hearts-of-iron-ivs-espionage-themed-expansion-la-rsistance-is-a-fun-addition-to-a-hard-fought-war/comment_id=175520 (HOI4 review — low-micromanagement espionage layer)
- https://steamcommunity.com/sharedfiles/filedetails/?id=2387530567 (HOI4 "The Agency" mod — infiltration timers, network strength, quiet-network XP)
- https://gamefaqs.gamespot.com/pc/919352-sid-meiers-civilization-iv/reviews/116602 (Civ IV review — espionage as wasteful attrition)
- https://gamefaqs.gamespot.com/pc/190280-sid-meiers-civilization-vi/reviews/163382 (Civ VI review — spy fantasy fun vs fiddly UI)
- http://www.megabearsfan.net/post/2016/11/02/Civilization-VI-game-review.aspx (Civ VI — passive intel via embassies/trade/religion; spies as investment)
- https://forums.civfanatics.com/threads/spies.532211/page-4 (CivFanatics — spies level too fast, die constantly, counters too lethal)
- https://www.gamespot.com/reviews/phantom-doctrine-review-tactical-espionage-action/1900-6416958/ (Phantom Doctrine — corkboard intel analysis; HQ discovery → forced relocation)
- https://www.rockpapershotgun.com/phantom-doctrine-preview (Phantom Doctrine preview — tracking enemy agents, undercover infiltration)
- https://www.pocketgamer.com/invisible-inc/steam-tip-invisible-inc-turns-infiltration-into-a-sneaky-turn-based-tactics-game/ (Invisible Inc. — fog of war, positioning spies for vision)
- https://advancewars.fandom.com/wiki/Recon (Advance Wars — Recon unit: cheap, fast, highest vision; value is pure information)
- https://www.warsworldnews.com/wp/aw/unit-aw/recon/ (Advance Wars recon strategy — early territory grab + FoW vision points)

**Mixed / hidden assets & detection**
- https://CnC.Fandom.com/wiki/Stealth (Command & Conquer — disguise/cloak/submerge vs detectors: dogs, destroyers, sonar; stealth breaks on attack)
- https://dominations.fandom.com/wiki/Decoy (DomiNations — decoy tactic draws defenders; the inverse information game)
- https://www.weforum.org/stories/emerging-technologies/nuclear-conflict-researchers-want-you-to-play-this-game/ (SIGNAL wargame — signaling civilian vs military infrastructure builds)

**Design theory (fun vs tedium)**
- https://en.wikipedia.org/wiki/Micromanagement_(gameplay) (micromanagement — "micromanagement hell"; TBS economic micro as design defect)
- https://github.com/kcjonson/worldsim/blob/HEAD/docs/research/competitive-analysis.md (genre analysis — staggered completion times, interconnected progression, micro-overload solutions)
- https://github.com/mippi-the-dork/crafting-play/blob/HEAD/src/site/notes/Game%20Design/Genre%20Dissection/Game%20Genres/Simulation.md (simulation genre — micro-management fatigue; emergent problem-solving as the fun core)
