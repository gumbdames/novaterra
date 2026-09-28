# Game Design — novaterra

> Living game-design research + synthesis. Updated continuously as findings
> evolve; sources cited inline; dead ends recorded at the bottom.
> Workstream: GAME DESIGN (Phase 0). Status: RESEARCH COMPLETE — proposal
> drafted in Parts B–C; 5 open questions pending (see table).
> Last updated: 2026-09-28 (all of A1–A6 researched; pillars + full proposal drafted).

## Contents

- **Part A — Research** (per-source findings, steal-vs-avoid verdicts)
  - A1. City-builder economies (SimCity / Cities: Skylines lineage)
  - A2. RTS combat & skirmish (Red Alert lineage)
  - A3. Ages & tech trees (Age of Empires lineage)
  - A4. Mission design & skirmish maps
  - A5. Difficulty scaling & cheat-code conventions
  - A6. Chain-of-command / delegation UX
- **Part B — Design pillars** (synthesis for OUR game)
- **Part C — Proposal**
  - C1. Name options
  - C2. Backstory
  - C3. Core loop
  - C4. Resource model
  - C5. Ages & tech progression
  - C6. Win/lose conditions
  - C7. Difficulty (5 levels) × Modes (classic AI vs "Muse persona" AI)
  - C8. Campaign: 8 missions
  - C9. Skirmish: 8 maps
  - C10. Chain of command (mayors, generals, cabinet)
  - C11. Unit rosters (civil + military, land/sea/air, special ops, entrepreneurs)
  - C12. Phase-1 MVP cut (ruthless)
- **Open questions & recommendations**
- **Research log & dead ends**

---

## PART A — RESEARCH

### A1. City-builder economies (SimCity / Cities: Skylines lineage)

_Status: researched 2026-09-28._

**What makes it fun (evidence):**
- **Persistent, nameable citizens with real homes and jobs.** Cities: Skylines citizens have a specific name, family, permanent residence and assigned job; you can follow one through their day. SimCity 2013's sims grabbed "the first open job / first empty house" each day — players noticed and it felt fake and killed trust in the sim. (Escapist; Steam forum)
- **Road-building as a core pleasure + emergent traffic puzzles.** C:S traffic follows 7 simple rules; congestion emerges from the player's own road network, and fixing it with a longer on-ramp or a one-way street is "hypnotic". (RPS; CityMonitor)
- **District policies / local laws.** Painting district boundaries and enacting local laws (lower office taxes, ban high-rises) makes the player "feel more like a mayor, decreeing how money sloshes around". (PCGamesN)
- **Milestones pace by population, not playtime.** C:S unlocks denser zones, bigger roads and services when the city grows — the game paces itself by what the city has become. SlimCity's GDD echoes this: the session loop is "lay a road, paint a zone, connect power/water, unpause, watch" while **demand (RCI bars) decides fill, not the player's placement** — the player reads the city back through infoview lenses, a stats panel, and an advisor that surfaces the worst problems first. (Steam CS2 discussion; SlimCity GDD)
- **Visible causality of externalities.** Pollution radius, dead bodies piling up from missing crematoriums, intake downstream of sewage outflow — problems have visible, traceable causes. (GeekDad; MDPI sustainability study)
- **Real tradeoffs in the budget.** Early-game: cheap fossil power vs expensive renewables; coal is easier but pollutes; going green too early bankrupts you. (MDPI)

**Steal:**
1. Persistent citizens (home + job + name) — even a cheap version buys enormous believability.
2. Zoning via painted districts with per-district policies/tax levers.
3. Milestones/unlocks gated on population & development, not timers.
4. An advisor that surfaces the worst problems first — sessions must never become "hunt the map for what's wrong".
5. Infoview lenses (land value, pollution, traffic, coverage).
6. Demand-driven growth: the player enables, the sim decides.

**Avoid:**
1. SimCity 2013's non-persistent agents (breaks player trust permanently).
2. Tiny maps (4 km² killed SimCity 2013) and forced always-online — our maps must be BIG (matches our brief).
3. Pure slider-fiddling budgets that reduce to "find the equilibrium and never touch it" — C:S1's economy was criticized as shallow and easy to cheese. Our economy needs production chains (raw → processed → goods → trade) so there's always something to optimize.
4. C:S2 launch lesson: an economy sim with real bugs ships as "the game's broken" — unit-test the economy tick from day one.

Sources: PCGamesN (C:S vs SimCity review); RPS ("Why road-building in Cities: Skylines is a pleasure", interview w/ Colossal Order); GeekDad C:S review; Steam CS2 economy discussion; SlimCity GDD (GitHub rbenzing/slimcitygame); Escapist (SimCity vs C:S); HN SimCity 10-year retrospective; Ferrovial blog (SimCity 30 years — Will Wright's Forrester/Urban Dynamics roots); MDPI sustainability study of C:S.

### A2. RTS combat & skirmish (Red Alert lineage)

_Status: researched 2026-09-28._

**What makes it fun (evidence):**
- **Asymmetric factions with mirrored readability.** RA2: Allies = balanced/subversive (tech superiority, air power, navy, garrisonable structures), Soviets = powerhouse (Rhino hordes, Tesla coils, Apocalypse tanks), inverted on sea (Allies dominate water in RA1; RA3: Empire powerhouse at sea). Countries inside each side add one signature unit each (British snipers, French Grand Cannon, US paratroopers, Iraq Desolator). (Eurogamer RA2 review; Tropedia; GameSpot RA2 preview)
- **"Balanced high": favor destructive units.** Eurogamer's RA2 review nails it: the game is balanced in favor of *more* destruction, which produces faster, bloodier battles — and crucially, **superweapons prevent drawn-out endgames**: long charge (up to ~10 min), global warning + countdown + revealed location when built → "a mad rush as all players gang up on the owner". The game ends one way or another. (Eurogamer; C&C wiki Superweapon)
- **Low-friction economy.** Ore miners harvest instantly; the economy exists to *accelerate the path to army clashes*, not to be a second job. (crafting-play genre notes)
- **Special ops as spice, not core.** Tanya/SEALs (one-person demolition), spies (infiltrate for intel/sabotage), Crazy Ivan, Terror drones — small numbers of high-skill units that create stories. (RA2 guides; Tropedia "National Weapon")

**Steal:**
1. Faction asymmetry along 2–3 clear identities (not 9 micro-factions at launch).
2. Superweapons as pacers/clocks: expensive, long charge, global warning, location revealed — they force the ending and punish turtling.
3. Country-style signature units: one memorable unique unit per side/faction.
4. Garrisonable civilian structures (RA2 staple) — doubles as city/war crossover.
5. Low-friction base economy: harvesters, not spreadsheets.

**Avoid:**
1. RA3's failure mode: every unit with a manually-activated special ability → "micromanagement demanding to the point of being frustrating". Abilities must be few, impactful, or automatable. (Eurogamer RA3 review)
2. Skirmish AI that only scales by cheating. Two schools: (a) CoH2 ladder — Easy fewer resources, Hard/Expert more resources + full maphack; (b) **ZH Reforged philosophy (preferred): no level cheats at all — difficulty changes what the AI is *allowed to decide***: reaction delay, whether it counters what you field, whether it masses before attacking, whether it retreats damaged units. "Making Easy easier means giving it worse decisions, never less money." We adopt (b) as the base, with small optional economic handicaps disclosed to the player. (CoH2.org; ZH Reforged CHANGELOG)
3. RA1's trap: one side inevitably wins on water maps (Allied cruisers) — sea balance must be designed per map type.

Sources: Eurogamer RA2 review; Eurogamer RA3 review (p.2); GameSpot RA2 preview & RA3 Soviet interview; C&C wiki (Superweapon, Iron Curtain); Tropedia RA series; crafting-play strategy genre notes; CoH2.org AI threads; ZH Reforged CHANGELOG; cnc3d_source design-skirmish.md (classic AI internals: build lists, rebuild handicaps).

### A3. Ages & tech trees (Age of Empires lineage)

_Status: researched 2026-09-28._

**What makes it fun (evidence):**
- **Age-ups as commitment with a real cost.** AoE2's tension: "constantly assess priorities and allocate scarce resources between creating new units, upgrading existing units, and researching to upgrade to the next Age. Too much emphasis on researching technology and moving through the Ages without creating military can leave a nation defenseless… putting resources into a large population at the expense of progress can lead to defeat." The decision *is* the game. (AoE wiki)
- **Tech often beats mass.** University/Blacksmith upgrades "often more important than simply having a larger army"; reaching Castle Age before your opponent "can win the game before the Imperial Age is even reached". (Vectree; AoE2 guide)
- **Age-up as a *choice*, not a button.** AoE4 advances via building one of two Landmarks (military/economic/defensive/religious) — like Age of Mythology's minor gods. But World's Edge themselves admitted "many of those choices are a bit too clear cut" and patched less-used landmarks to be viable. Lesson: choices must be genuinely competitive, or players ignore half the design. (RPS; Newsledge; Gamerant)
- **Positive framing.** AoE4 forum wisdom: every civ gets the full generic tech tree with *bonuses* layered on top — players think "I can do these couple of things *better*" instead of "I *can't* do this". (AoE forums)
- **Resource design rules.** The earn→spend→earn loop must be satisfying at every stage; *the gap between earning and spending is where decisions live*. Each currency is a decision axis; apply the depth test — does this currency create interplay with others, or exist in isolation? Exchange rates (market/trade) create interplay. Inflation (late-game stockpile of useless gold) is a design failure: the resource stopped creating decisions. (mattstruble game-design reference)
- **Labor as a resource.** 0 A.D.: female citizens gather food faster + aura-buff nearby workers; citizen-soldiers are dual economy/combat. Worker specialization and placement *is* the economy game. (0 A.D. research)

**Steal:**
1. 4–5 ages gating units/buildings/techs, with age-up cost creating the core tension (army now vs tech later).
2. Landmark-style age-up *choice* (2–3 options per age), but balance them so all are viable — playtest pick rates.
3. Full base tech tree + positive asymmetric bonuses (never "you can't build X").
4. Multiple resources with real interplay: trade/market exchange, production chains (raw → refined → goods).
5. Tech upgrades that rival army size in impact (Blacksmith-style military upgrades).

**Avoid:**
1. "Clear-cut" choices — dead branches waste art, code, and player attention.
2. Inflation: every resource must create decisions at all game stages; if late-game money piles up uselessly, add sinks (prestige projects, superweapons, trade).
3. AoE4's old building-cost-repair gotchas — keep costs legible.

Sources: AoE fandom wiki (AoE2 tech); Vectree AoE2 guide; GameFAQs AoE2:DE review; ageofempires.com learn-to-play; Newsledge (AoE4 landmarks); RPS (landmark improvements); Gamerant (landmarks guide); AoE forums ("full tech tree is good"); mattstruble game-design references (balance-and-competition); 0 A.D. mechanics research; rts-game-godot GDD (AoE2-style resources + age progression).

### A4. Mission design & skirmish maps

_Status: researched 2026-09-28._

**What makes it fun (evidence):**
- **RA2 formula:** 2 campaigns × 12 missions + a short "Boot Camp" tutorial campaign. "The mission objectives vary a lot from mission to mission, and whilst they are all generally along the lines of 'kill everything' the methods by which you do this vary" — e.g. using the Eiffel Tower as a giant Tesla coil; commanding scattered troop groups on multiple fronts. Every unit serves a unique purpose with rock-paper-scissors counters, "no strategy that cannot be somehow countered". (Eurogamer RA2 review; C&C wiki; StrategyWiki)
- **The SC2 gimmick debate is the key lesson.** Fans split: many call SC2's campaign one of the best ever for its variety; others hate that "every single mission has some silly gimmick" and just want "to dismantle a giant map-sized enemy base piece by piece". The counter-argument: "if all you did was max 200/200 on every map and steamroll the AI, it would get old quickly." Design rule: **alternate gimmick/constraint missions with classic base-vs-base missions; never gimmick every mission**; put the constraint *inside* the mission's fantasy, not on top of it. (NeoGAF)
- **Warcraft's innovation:** missions that "reduced or eliminated the ability to create more units" and varied objectives beyond crushing enemies — the template every RTS followed. (Inverse)
- **Skirmish map anatomy (from modern open RTS docs):** starting resources clustered near each base + *contested expansion sites* in the middle; a central route + flanking routes; rocks/cliffs as meaningful obstacles; decoration must never imply blocked terrain where movement is allowed. Maps as data (maps.json), victory variants (Conquest / Regicide / Wonder-with-countdown). (zvory rts-0 balance; 3d_astra plans; rts-game-godot GDD + map_generation)
- **Scale reference:** SupCom 5×5 km = 256×256 game units; our maps should be bigger than RA2's postage stamps (cf. A1: SimCity 2013's 4 km² killed it). (SupCom map guide)

**Steal:**
1. Boot Camp-style tutorial missions before the campaign proper.
2. Objective variety: defend-the-point, multi-front command, covert ops with limited forces, superweapon races, wonder-style countdown defenses.
3. Skirmish: resource clusters near spawns + contested expansions; center + flanks; 2–4 player slots; Conquest/Regicide/Wonder victory options.
4. Maps as data files (hand-authored first, procedural later).

**Avoid:**
1. Gimmick fatigue — cap the ratio (~1 in 3 missions max with a hard constraint).
2. "Tacked-on SP": skirmish maps + FMVs do not make a campaign; missions need bespoke objectives and scripted beats (nma-fallout thread).

Sources: Eurogamer RA2 review; C&C wiki (RA2); StrategyWiki (RA2); GameFAQs Allied campaign guide (mission anatomy); Revora forums (RA2 campaign map list); NeoGAF (SC2 campaign debate); Inverse (Warcraft anniversary); nma-fallout (crappy-SP-campaign origin thread); zvory rts-0 balance doc; 3d_astra RTS plans v1/v2; rts-game-godot GDD/map_generation/guide; SupCom map guide (mirrors.pdp-11.net).

### A5. Difficulty scaling & cheat-code conventions

_Status: researched 2026-09-28._

**Difficulty — three schools (evidence):**
1. **Handicap ladder (classic):** AoM Retold — Extreme +25%, Legendary +50% handicap on gather/build/attack/HP; handicaps can be negative and are listed on the scoreboard (transparent). AoE2 DE — difficulty steps change build order, aggression and economy; community pain point: difficulty *spikes* between steps (Moderate→Hard) feel unfair; gaps too wide kill fun. (AoE wiki; Steam forums)
2. **Decision-quality ladder (modern best practice):** ZH Reforged — "Every level plays by your rules. No level gets extra money… What changes is what the computer is *allowed to decide*: how often it looks at the map, how long it takes to react, whether it counters what you field, whether it masses before attacking, whether it pulls damaged units out." Easy = late reactions, no counters, trickles units in; Hard = no reaction delay, builds counters, masses, retreats losers. "Making Easy easier means giving it worse decisions, never less money." (ZH Reforged CHANGELOG)
3. **AI Director (dynamic pacing):** L4D — monitors performance, adjusts spawn intensity and pacing; if players turtle, it summons a horde to force movement; "procedural narrative". God Hand — visible difficulty meter: rises on dodges/attacks, falls on hits; harder = better rewards. RE4 — invisible scaling. Key design rule: **if discovery would feel like a betrayal, make the adjustment transparent** (rubber-band, don't deceive). (Wikipedia DDA; byteclub DDA entry; NeoGAF)
- **Legibility principle:** "An AI that plays perfectly is not fun; an AI that plays *legibly* is" — bank resources, respond to what the player deployed, push when ahead, defend when behind, vary reaction delay with difficulty. (gen-ai-experiments genres reference)
- **Bruce Shelley (AoE):** "non-cheating AI" was on the must-have list; "design by playing. Play every day, make adjustments." (year12project research quoting Shelley)

**Cheat conventions (evidence):** typed phrases in chat box (Enter, type, Enter); categories —
- resources: `show me the money` (10k minerals+gas), `whats mine is mine` (500), `greed is good` (AoE)
- god mode: `power overwhelming`, `whosyour daddy`
- build speed: `operation cwal` (can't wait any longer), `warpten`
- map/vision: `black sheep wall`, `iseedeadpeople`
- upgrades/tech: `something for nothing`, `medieval man`, `sharpandshiny`
- cap removal: `food for thought`, `pointbreak`
- win/lose: `there is no cow level` (instant win), `game over man` (instant loss)
- joke unit: `how do you turn this on` (Cobra car — became a 20-year meme)
Cheats are **single-player only**, flag/mark the session, and **disable achievements/score submission** (AoE DE, SC Remastered). (24-7gamer; FictionHorizon; TL.net; Escapist)

**Our 5-level difficulty model (recommendation):** adopt the decision-quality ladder as the base (reaction delay, look frequency, counter-building, massing, retreat logic, expansion greed, superweapon usage), with **small, transparent, disclosed economic handicaps** only at the extremes (level 1: AI at 80% gather; level 5: 120% + faster reactions), all shown on the lobby/scoreboard. No hidden maphack below level 4; level 5 may use limited intel "instincts" (disclosed). Add a God-Hand-style visible "threat meter" for mode 2's adaptive director.

Sources: AoE wiki (Artificial intelligence); Steam AoE forums (difficulty threads ×3); ZH Reforged CHANGELOG; gen-ai-experiments genres.md; Wikipedia (dynamic game difficulty balancing); byteclub DDA entry; code198x difficulty-design; NeoGAF (RE4/Max Payne/God Hand thread); GameFAQs L4D Q&A; 24-7gamer (cheat codes history); FictionHorizon; TL.net; Escapist forums; Strikingly Brood War cheat list.

### A6. Chain-of-command / delegation UX

_Status: researched 2026-09-28._

**What works (evidence):**
- **Distant Worlds is the gold standard.** Per-function automation sliders:
  "automate any-or-all empire functions independently (automate 99% + pilot
  one ship, or run 90% manually + automate only taxation)". Tiers of
  delegation (fleet AI vs individual ship AI precedence, per fleet); queue an
  attack on a target and walk away confident it will be handled; seize and
  return control of anything at any time with low friction. "It's easy to
  dismiss automation as the 'game playing itself', but it's more like training
  a bureaucracy… When it works, that's a success *of your guiding hand*."
  (aeon research notes; RPS DW2 review; Steam DW2 discussion; GalCiv forums)
- **Automatic by default, manual override on top.** Stellaris pops
  auto-assign to jobs by priority; "a casual player never touches it and the
  planet still runs… automatic allocation by default, manual override for
  people who want to optimise." The min-maxer gets a dial the casual never
  learns exists. Caveat: automation only earns its place if the underlying
  decision is *contested* — if there's always one right answer, the toggle is
  a confirmation dialog, not a decision. (eventide ideas notes)
- **Characterful appointees.** CK2's vassals have opinions, memories, grudges
  — "every character has an opinion of every other character… very realistic
  motivations" — which makes delegation *dramatic*. Civulator's "Governor
  Mode" (player builds, AI fights) and visible unit-AI leveling show
  delegation can be a feature, not a crutch. (keithsayer CK2 review;
  civulator notes)

**What fails (evidence):**
- **Stellaris sector automation** is "a bit of a mess": the AI upgrades
  buildings "with no sense, and replace[s] sensible buildings with stuff that
  doesn't make any sense", ignores unemployment, builds in the wrong sector.
  Lesson: delegated AI needs **guardrails** — build orders per designation,
  budgets, and above all **legibility** (it must narrate/constrain what it
  will do). (Steam Stellaris forums; RPGCodex dev diary)
- **Nobunaga's Ambition: Awakening** made delegation *mandatory* (only the
  capital region directly manageable) — "I want to play a game, not have the
  game play itself for me." Delegation must be **opt-in, per function, and
  reversible**. (RPGCodex review)
- CK2's feudal drama (rebellions, claim wars) is a poor fit for a modern
  presidential fantasy — keep appointees as bureaucrats with competence
  stats, not rival dynasts.

**Steal:** per-function automation sliders; seize-back-anytime; intent
narration before irreversible AI actions; appointees with visible competence
stats and situation reports; default-sane automation with manual override.
**Avoid:** mandatory delegation; inscrutable AI building (Stellaris);
rebellion drama.

Sources: aeon hybrid-agency research; RPS DW2 review; Steam DW2 "What it does
right"; GalCiv/DW forums; Bay12 DW thread; SpaceSector DW preview; Stardock
DW review; Stellaris Steam automation thread; RPGCodex (Stellaris dev diary
followup; Nobunaga's Ambition Awakening review); eventide ideas (Stellaris
pops); civulator notes (Governor Mode, tech-tree bloat); keithsayer CK2
review; khessar-grand-strategy (character engine).

---

---

## PART B — DESIGN PILLARS

Synthesized from the research above. These are the non-negotiable design truths
for our game; every mechanic in Part C must serve at least one of them.

1. **One fantasy: you are the President.** Not a mayor, not a general — the head
   of state of a young nation in 2026. City-building, economy, technology and
   war are all instruments of the same job. (A1-districts, A2-factions, A3-ages
   all hang off this one identity.)
2. **The player enables; the sim decides.** Demand drives growth (RCI-style),
   citizens have persistent homes and jobs, firms live or die on real causes.
   The player's job is to create conditions and read the city back through
   lenses and an advisor that surfaces the worst problems first. (A1)
3. **Balanced high, paced by clocks.** Combat favors the spectacular; stalemates
   are broken by superweapons-as-clocks (expensive, long charge, global warning,
   revealed location) and wonder-style countdown victories. No 3-hour turtling
   endgames. (A2)
4. **Ages are choices with costs.** Each age-up is a landmark-style decision
   (pick 1 of 2–3 national programs), every option viable, every tech framed as
   "you can do X *better*" — never "you can't do Y". Tech competes with army
   size for the same scarce resources. (A3)
5. **Delegation is optional, granular, and legible.** Distant Worlds, not
   Nobunaga's Awakening: per-function automation sliders (construction,
   services, recruitment, defense…), seize control back at any time, mayors and
   generals as appointed bureaucrats with competence stats — not rebellious
   vassals. Automation must never be mandatory and must be visibly competent.
   (A6)
6. **Every resource earns its place.** Each currency is a decision axis with
   real interplay (production chains, markets, exchange); inflation is a bug
   (a stockpiled-useless resource gets a new sink); labor is a resource too.
   (A3, A1)
7. **War is optional; the game is complete without it.** Builder mode is a full
   game with its own victory (prosperity), not a demo of the war game. Maps are
   big enough to play peacefully even with war enabled. (brief + A4)
8. **Legible AI, disclosed handicaps.** Difficulty scales decision quality
   first (reaction time, scouting, counter-building, massing, retreats), small
   transparent economic handicaps only at the extremes, shown in the lobby.
   Mode 2's adaptive director is *transparent* about adapting (visible threat
   meter) — never secret rubber-banding that feels like betrayal. (A5)
9. **Long-form, respectful of time.** Save/exit/resume and pause from the first
   playable build; sessions are meant to last hours across days; nothing
   requires reflexes that a pause can't replace. (brief + AGENTS.md §3)

## PART C — PROPOSAL

### C1. Name options

The game needed a name (repo: `novaterra`). Criteria: modern,
presidential, ownable, works in a URL. Five options were considered —
**selected 2026-09-28: NOVATERRA**:

1. **NOVATERRA** — "new land". Short, ownable, URL-friendly
   (`novaterra.game`). Tagline: *"Build the nation. Defend the future."*
2. **PAX NOVA** — "new peace". Captures builder-vs-warrior duality; the
   campaign's end state is literally a *pax*. Slightly Latin-heavy.
3. **THE MERIDIAN REPUBLIC** — evocative, presidential; "Meridian" gives map
   and faction naming for free (Meridian Plains, Meridian Guard). Longer.
4. **COMMONWEALTH 2026** — grounded, modern, instantly communicates the
   setting; weaker as a brand.
5. **HALCYON** — a golden-age promise; mysterious and premium, but says less
   about what the game *is*.

**Recommendation: NOVATERRA.** It is short, unique in the genre, and the
fiction writes itself (citizens = "Novaterrans", the capital = "Nova Meridia",
the enemy = "the Kestrel Directorate"). All subsequent sections use it.

### C2. Backstory (draft)

**Setting — locked 2026-09-28 (user decision):** an alternate Earth, modern
2026 — our planet's look, technology, and society, but fictional continents,
countries, and maps (keeps clear of real-world politics). All human: no
outer space, no aliens, no fantasy races. The game is fixed in 2026; the
ages (Foundation → Connectivity → …) are *development stages* of your
nation, not calendar years.

**The setting is 2026. The place is Novaterra. You are its first President.**

Ten years ago the old Federation fractured — the Fracture of 2024 left a dozen
coastal city-states bankrupt, blacked out, and blockaded by warlords and
privateers. In the winter of 2025 they did something desperate: they voted
themselves into a new republic and elected *you*, an outsider engineer-mayor
who kept the lights on in Port Meridia when nobody else could.

**Why building:** Novaterra is a blank ledger — ruined ports, empty grids,
angry citizens, and a treasury of promises. Your mandate: make the republic
*work* — power, water, jobs, homes — city by city, until the lights stay on
from the northern highlands to the southern straits.

**Why (optional) war:** Across the strait, the **Kestrel Directorate** —
a petro-state junta that grew rich selling fuel to both sides of the Fracture —
has decided a united Novaterra is bad for business. Its "private security
fleets" are already seizing fishing grounds. The Directorate will not invade on
day one; it will *pressure*: blockades, sabotage, proxy raids, and finally open
war if you let it get that far. **You can play the entire game without ever
firing a shot** — out-build, out-trade and out-tech them into irrelevance —
but if you want the war, the war will come to you.

**The arc:** from keeping one city's lights on (Mission 1) to a republic of
many cities choosing its future: a golden age of prosperity, or the forge that
ends the Directorate (Mission 8, two endings). Your cabinet, your mayors and
your generals are the people who make it real — appoint them well.

### C3. Core loop

The minute-to-minute loop (the "SlimCity sentence", A1):

> **Survey → zone/build → connect utilities → unpause → watch → read the city
> back (lenses + advisor) → fix the worst problem → expand or advance.**

The hour-to-hour loop:

1. **Grow** a city: roads, districts, power/water, services; demand fills it in.
2. **Fund** the republic: taxes, trade, extraction, entrepreneurs' firms.
3. **Advance** an age: pick a National Program (landmark choice), unlock new
   tools of prosperity — or war.
4. **Expand**: found or liberate the next city; appoint its mayor; set its
   mandate (industrial heartland, breadbasket, fortress, resort…).
5. **Deter or defeat** the Directorate: diplomacy, blockades, special ops,
   or open war across land, sea and air.
6. **Win** on your terms: prosperity, conquest, or the wonder-countdown.

Session shape: 20–40 minute "episodes" (a mission, a city founded, a war
campaign) inside campaigns that run for many hours; save/exit/resume is
first-class (Pillar 9).

### C4. Resource model

Designed against A3's rules: every resource must create decisions at every
stage; exchange creates interplay; inflation is treated as a bug.

**Stockpiles (national):**

| Resource | How you get it (many paths) | What it's for |
|---|---|---|
| **Funds (₦)** | district taxes, trade exports, tourism, state firms, foreign investment, war reparations | everything costs funds to *build*; the universal lubricant |
| **Materials** | quarries, timber mills, imports, recycling plants, battlefield salvage | construction (buildings, walls, ships) |
| **Fuel** | oil wells, refineries, offshore rigs, biofuel plants, imports | vehicles, ships, aircraft, power plants |
| **Goods** | factories (materials+fuel → goods), entrepreneurs' firms, imports | citizen happiness, commercial tax base, export income |
| **Food** | farms, fisheries, imports, vertical farms (late) | feeds population; shortages stall growth |
| **Research** | universities, labs, tech parks, espionage (steal), entrepreneur startups | tech tree + age progression |
| **Manpower** | population + barracks/recruitment policy | military units (a soft cap, not just funds) |
| **Influence** | diplomacy, media, culture exports, wonders | trade deals, deterring the Directorate, peaceful victory |

**Flows (utilities, not stockpiled):** Power (grid balance per city),
Water (per city), Bandwidth (late-game; gates digital economy).
Shortages cause brownouts/rationing with visible causes (Pillar 2).

**Labor:** workers are assigned to districts/firms; entrepreneurs are special
agents that found firms (shops, factories, startups) which generate goods,
jobs and taxes — the private sector as a semi-autonomous economic engine you
nudge with policy, not micro with orders.

**Sinks vs inflation (A3):** late-game funds sink into National Projects,
superweapons, prestige wonders, foreign aid (influence), and unit upkeep that
scales with army size. The market lets any stockpile convert to funds at a
sliding rate (interplay, not isolation).

**Cheat (per brief):** the console/chat phrase **`prosperity now`** grants
+100,000 funds, +10,000 of each stockpile, instant research — the "show me the
money" slot. It flags the session (no achievements/score, per A5 conventions),
works in single-player only, and is documented in HOW_TO_PLAY.md as the
official "super duper easy mode".

### C5. Ages & tech progression

Five ages, near-future, each gated by building a **National Program** landmark
— a real building on the map with a real choice (A3: pick 1 of 2, both viable,
framed positively). Age-up costs funds + research + a construction effort, so
it competes with army-building for the same resources (the AoE2 tension, A3).

| # | Age | Years | National Program choice (pick 1) | Unlocks (civil / military) |
|---|---|---|---|---|
| 1 | **Foundation** | 2026 | — (start here) | roads, zoning, power/water, infantry, patrol boats |
| 2 | **Connectivity** | 2027–29 | **Fiber Grid** (economy: +bandwidth, digital firms) *or* **Orbital Uplink** (intel: satellites, recon) | universities, trade port, fighters, destroyers |
| 3 | **Green Transition** | 2030–33 | **Fusion Pilot** (clean power abundance) *or* **Agri Arcologies** (food independence + growth) | vertical farms, recycling, special ops, submarines |
| 4 | **Autonomy** | 2034–37 | **Drone Works** (autonomous logistics + drone swarms) *or* **Civic AI** (automation boosts, smarter mayors) | carriers, bombers, missile artillery, smart defenses |
| 5 | **Ascendance** | 2038+ | **Skyhook** (orbital economy, prestige) *or* **Aegis Shield** (theater missile defense) | superweapons, wonder victory, elite units |

Tech tree shape: a **full shared base tree** (nobody is locked out of anything,
A3 "full tech tree is good") + **doctrine bonuses** layered on top
(see C11). Every tech node must unlock a capability, not a +5% filler
(Civulator lesson, A6). Roughly 40–60 nodes total at launch.

### C6. Win/lose conditions

- **Skirmish:** selectable victory — **Conquest** (destroy all enemy HQs +
  production), **Capital** (hold the enemy capital for 5 minutes), or
  **Ascendance** (complete the Skyhook/Monument wonder and survive the
  10-minute countdown, RA2-superweapon pacing per A2). Lose: your last HQ falls
  (war on), or in builder mode there is no lose — only a prosperity score.
- **Campaign:** per-mission objectives (C8); campaign lose = mission failed
  (retry from briefing; progress within a mission is never auto-saved over).
- **Builder (war disabled):** victory = **Golden Age**: reach prosperity
  thresholds (population, happiness, treasury, influence) across N cities. No
  lose state — the score is the game (A1: "no winners or losers" is a valid
  SimCity tradition; we give it an explicit win anyway).
- **Defeat dignity:** losing triggers a debrief ("The Directorate holds the
  straits…") with stats and one-click rematch — never a dead-end screen.

### C7. Difficulty (5 levels) × Modes (classic AI vs "Muse persona" AI)

**The five levels** (names + mechanics). Base = decision-quality ladder
(A5: ZH Reforged), with small *disclosed* handicaps at the extremes:

| # | Name | AI decision quality | Disclosed handicap |
|---|---|---|---|
| 1 | **Cadet** | reacts in ~8s, never counters, trickles units, no expansions, no superweapons | AI gathers at 80% |
| 2 | **Citizen** | reacts in ~4s, simple counters, small waves, 1 expansion | none |
| 3 | **Commander** | reacts in ~1.5s, builds counters, masses before attacking, expands greedily | none (the "fair" level) |
| 4 | **Marshal** | ~0.5s reactions, coordinated multi-prong attacks, retreats losers, uses superweapons | none |
| 5 | **Legend** | Marshal + strategic memory + dirty tricks (see Mode 2) | AI gathers at 115% (shown in lobby) |

No hidden maphack below level 4; at 4–5 the AI gets "recon instincts"
(periodically reveals a random player region for 10s) — disclosed in the
lobby tooltip.

**Mode 1 — Classic AI.** Scripted build orders + utility-based tactics; plays
to win within its level's decision budget; no cross-match memory. This is the
"honest opponent" (Bruce Shelley: non-cheating AI, A5).

**Mode 2 — "Muse persona" AI director.** A live Muse opponent is infeasible in
an offline browser game (no server, no model in the loop) — so Mode 2 is a
**personality-driven adaptive AI director** that plays *as* me: same decision
engine as Classic, plus:

1. **Strategic memory within the match.** Tracks the player's habits
   (rushes air? turtles? neglects navy?) and shifts its composition to exploit
   them — e.g. mass AA after your third bomber wing. It *learns the player*,
   not just the game state.
2. **Adaptive pacing (AI-Director style, A5).** A visible **Threat Meter**
   rises when the player is crushing it (faster tech, multi-prong pressure)
   and eases when the player is struggling (slower waves, "mercy" gaps) —
   transparent, God-Hand-style, never secret rubber-banding (Pillar 8).
3. **Dirty tricks at Marshal/Legend.** Feint attacks on one front while the
   real force lands behind your lines; decoy construction (fake superweapon
   to draw your strike force); superweapon bluffs; targeted economic
   harassment (raids your *weakest* resource chain, not random buildings).
4. **Voice: commentary & taunts in my register.** Event-triggered lines,
   written in my voice — dry, direct, a little playful — delivered as
   presidential communiqués, never modal popups:
   - on first bomber built: *"Bombers. Bold. My AA crews just got their
     funding approved."*
   - on losing a city: *"You took Port Meridia. Enjoy the traffic."*
   - on superweapon started: *"That glow on the horizon? That's your
     countdown. Mine's already ticking."*
   - on player struggling (Threat Meter low): *"Rough quarter, Madam
     President. My generals suggest you build more walls. I suggest you
     build more friends."*
   Lines are data (localizable), ~150 at launch, cooldown-gated so they never
   spam. **This is the soul of Mode 2**: Classic AI plays the board; the Muse
   persona plays *you*, and tells you so.

Mechanical summary of Mode 2 vs Mode 1: same units, same rules; Mode 2 adds
cross-match-style adaptation *within* the match, director pacing with a
visible meter, high-level dirty tricks, and the voice layer. It is strictly
harder at equal level *because it adapts* — a level-3 Muse persona should
feel like a level-4 Classic opponent who read your playbook.

**Recommendation:** ship Mode 1 first (MVP), Mode 2 in Phase 2 — the director
needs the Classic AI as its substrate, and the voice lines are content work,
not engine work.

### C7a. Live Muse link (online option — confirmed by user 2026-09-28)

Offline-first is sacred: the persona director above is always available and
the game never *requires* a connection. But when online, the player may
optionally **connect their own Muse** (settings screen: paste your own API
key, stored in `localStorage` only — it never leaves the browser except to
the API endpoint itself; needs a CORS-capable endpoint, to be verified at
build time).

How it works: Muse acts as **strategic commander, not tick driver**. Every
30–60 s (plus an on-demand "Request counsel" button) the game sends a compact
digest — resources, force composition, map control, threat meter, recent
events (a few KB of JSON, never raw per-entity state) — and receives:
(a) strategic directives (build priorities, tech path, attack/defense timing,
dirty-trick suggestions), (b) commentary/taunts in the Muse voice. Local
systems execute everything tactically; **the model never blocks the sim tick
and never mutates sim state directly**. Difficulty scales digest detail and
consultation frequency, layered over the same decision-quality ladder. No key,
offline, or API error → silent fallback to the persona director. Cost and
latency are the player's own (their key, their bill); a small "LIVE" indicator
shows when the link is active.

### C8. Campaign: 8 missions

One continuous arc: **"The First Term"**. Missions alternate gimmick/constraint
missions with classic base-vs-base (A4: never gimmick every mission). New units
trickle in RA2-style; each mission introduces ≤3 new tools. Par times are
guides, not gates. Every mission ships with a **peaceful variant** where the
war beats are replaced by prosperity objectives (Pillar 7).

0. **Boot Camp: "Civics 101"** (tutorial, optional) — camera, select, build a
   road, zone a district, connect power. 10 minutes. Skippable.
1. **"First Light"** — Found Nova Meridia. Objectives: power + water the
   capital, reach 5,000 citizens, survive the winter storm (scripted).
   *Teaches: the core loop (C3).*
2. **"The Breadbasket"** — Food crisis. Objectives: found a second city in the
   farmlands, appoint its first mayor, establish a trade route.
   *Teaches: expansion, mayors, trade.*
3. **"Blackout"** — The grid collapses during a heatwave; the Directorate
   "offers" fuel at extortion prices. Objectives: restore power 3 ways (any),
   refuse or accept the deal (choice matters in M5).
   *Teaches: utilities, decisions with consequences.*
4. **"Open Harbor"** — Entrepreneurs & tourism. Objectives: build the trade
   port, attract 10 firms, host the Meridian Expo (wonder-lite countdown
   defense against saboteurs, not armies). *Teaches: private sector, events.*
5. **"The Kestrel Gambit"** — First blood. Directorate privateers raid the
   straits. Objectives: build a navy from nothing, defend 3 convoys, then a
   limited strike on the raider base (special ops debut: infiltrator + SEALs).
   *Teaches: sea war, special ops.* Peaceful variant: break the blockade with
   diplomacy + influence.
6. **"Across the Water"** — Combined arms. Objectives: land an expeditionary
   force on Kestrel-held Isla Soraya, build a forward city under fire, take
   the airfield. *Teaches: air/sea/land integration, forward basing.*
7. **"Iron Tempest"** — The superweapon race. The Directorate is building the
   **Storm Engine** (weather superweapon). Objectives: race your own Aegis
   program *or* destroy theirs before the countdown — your call, both paths
   scripted. *Teaches: clocks, hard choices.* (A2 superweapon pacing.)
8. **"Pax Novaterra"** — Finale, two endings. **War path:** coordinated
   offensive on the Directorate capital with everything you've built.
   **Peace path:** Golden Age — out-prosper them into irrelevance (influence
   victory). Both end with the same debrief question: *what kind of president
   were you?* Stats, score, New Game+ hooks.

Difficulty ramp: M1–2 tutorialized, M3–4 systems depth, M5–6 war school,
M7–8 everything at once. Scripted events are telegraphed (advisor warnings),
never gotchas.

### C9. Skirmish: 8 maps

All maps are **big** (Pillar 7: playable peacefully even with war on; A1's
SimCity-2013 lesson). Sizes in abstract tiles for now (sim workstream to fix
the world-unit scale); water % = share of map covered by water. Every map:
starting resource clusters near each spawn + contested expansion sites
(A4 anatomy), 2–4 player slots, all 3 victory types enabled.

| # | Name | Size | Water | Players | Character |
|---|---|---|---|---|---|
| 1 | **Meridian Plains** | Medium (512×512 world units, 256×256 heightfield cells) | 5% | 2 | Learning map. Open land, one river, generous starts. |
| 2 | **Twin Rivers** | Medium | 15% | 2 | Two rivers, bridge chokepoints; land war with flanks. |
| 3 | **The Shattered Coast** | Large | 30% | 2–3 | Long coastline; navy optional but rewarding; port cities shine. |
| 4 | **Rustbelt Delta** | Large | 25% | 3 | Swampy, resource-rich center; fight over the delta or boom around it. |
| 5 | **The Inland Sea** | Large | 45% | 2–4 | Huge central sea; whoever rules the waves rules the map. |
| 6 | **Archipelago of Sorrows** | Large | 60% | 2–4 | Islands; navy + air mandatory; landings win wars. |
| 7 | **Highland Frontier** | Large | 10% | 2–3 | Mountain passes and valleys; chokepoint chess, artillery country. |
| 8 | **The Grand Expanse** | XLarge | 20% | 4 | The everything map: plains, coast, hills, 4 corners. FFA diplomacy. |

Maps ship as **data files** (hand-authored v1; procedural variants later, A4).
Water variance is the headline feature: 5% → 60% across the set, so naval
investment is a real strategic choice per map.

### C10. Chain of command (mayors, generals, cabinet)

Pillar 5: delegation is **optional, granular, legible** (Distant Worlds model,
A6). Nothing is ever mandatory-automated (Nobunaga's Awakening anti-pattern).

**The hierarchy:**

- **You — the President.** Direct control of anything, anytime. Pause the
  world and micro a single house or squad if you want.
- **The Cabinet (5 ministers).** Appointed characters with competence stats
  and a policy stance each:
  - *Treasury* — tax policy, trade deals, budget balance
  - *Infrastructure* — construction priorities, utilities
  - *Interior* — happiness, services, policing
  - *Research* — tech priorities
  - *Defense* — recruitment, doctrine
  Ministers grant **global modifiers** and unlock **policy cards**
  (e.g. Treasury: "Export Subsidies"; Interior: "Community Policing"). You can
  run a ministry manually (set every slider yourself) or let the minister's AI
  execute within bounds you set ("keep taxes between 8–12%").
- **Mayors (one per city).** Appointed, with **Competence** (how well their AI
  executes) and **Ambition** (flavor; high ambition + low oversight = they
  rezone your historic district into condos — legible, reversible, and your
  fault for not checking the reports). Per-city **delegation sliders**:
  Construction (Manual / Approve-plans / Full AI), Services, Zoning, Tax
  levers. Mayors file **situation reports** ("Housing shortage in District 3;
  recommend rezoning — approve?") — one click to approve, or take over.
- **Generals (theater commands).** Northern / Southern / Eastern / Western
  Command + Naval + Air Command as the map demands. Each general has a staff
  (operations, logistics, intel officers — small stat bonuses). Per-command
  **delegation**: Stance (Aggressive / Balanced / Defensive / Hold),
  Recruitment (manual/AI), and **objective assignment**: draw an arrow on the
  map ("take that ridge") and the general's AI plans the operation; you can
  still grab any battalion mid-battle.
- **The golden rule:** any delegated order can be **seized back instantly**
  with no penalty, and the AI **narrates its intent** before acting on
  anything irreversible ("Mayor Chen will demolish 4 homes for the highway —
  confirm?"). Automation that surprises you is a bug (A6: Stellaris lesson).

**Why this is fun, not "the game playing itself":** delegation is *training
your bureaucracy* (DW2 community wisdom, A6). A well-run republic with good
appointees feels like *your* achievement; a badly-run one is legibly your
fault. And the first city is always hands-on — you only delegate what you've
already mastered.

### C11. Unit rosters (draft)

One shared base roster for the Republic; the **Kestrel Directorate** uses the
same chassis with an asymmetric **doctrine** layered on (A2/A3: asymmetry with
readability, positive framing). Republic doctrine: *balanced, defensive,
tech-forward* (better sensors, engineers, point defense). Kestrel doctrine:
*aggressive armor/artillery* (heavier tanks, longer-range artillery, weaker
air defense). Signature units per side (A2 "national weapon" pattern).

**Civil — land:** Engineer crew (build/repair), Surveyor drone team,
Hauler truck (logistics), Transit bus, Police cruiser, Fire engine, Ambulance,
**Entrepreneur** (founds firms; the private-sector engine), Construction rig.
**Civil — sea:** Container ship, Ferry, Fishing trawler, Survey vessel,
Icebreaker (map-dependent).
**Civil — air:** Airliner, Cargo plane, Medevac helicopter, Survey/delivery
drones.
**Military — land:** Rifles (infantry), Marines (amphibious), Mechanized
infantry (IFV), Main battle tank, Artillery, Mobile AA, Combat engineers,
**Special ops:** *Spectre* (Tanya-slot: one-person demolition/sabotage),
SEAL team (amphibious raids), Infiltrator (spy-slot: intel, sabotage, steal
research), Mobile HQ (command aura).
**Military — sea:** Patrol boat, Destroyer (AA + shore bombardment),
**Carrier** (air wing), Submarine (stealth strike), Landing ship (amphibious).
**Military — air:** Multirole fighter, Bomber, Attack helicopter, Heavy
transport, AWACS (sensor aura), Drone swarm (cheap, expendable).
**Signature units:** Republic — *Aegis Battery* (theater missile defense,
doubles as superweapon counter); Kestrel — *Tempest Cannon* (very-long-range
artillery). **Superweapons:** Republic *Aegis Shield* (defensive) /
*Skyhook Strike* (orbital); Kestrel *Storm Engine* (weather) — all follow the
A2 clock rules (long charge, global warning, revealed location).

Roster discipline (A2): every unit has a clear counter; no unit without a
purpose; special abilities few and automatable (RA3 lesson).

### C12. Phase-1 MVP cut (ruthless)

What ships first must be **genuinely fun**, not a tech demo. The MVP is:
**one big skirmish map, Classic AI (levels 1–3), land + air war, core
city-building, save/load/pause, cheat code** — the complete core loop (C3)
with nothing else.

**IN:**
- Terrain + one large hand-authored map (Meridian Plains), 2 players
- City building: roads, 3 zone types (residential/commercial/industrial),
  power + water, 6–8 buildings, district policies (basic)
- Economy: Funds + Materials + Fuel + Food + Research (5 of the 8; Goods,
  Influence, Manpower deferred), market exchange, taxes
- Units: 8 land (engineer, rifles, tank, artillery, AA, hauler, special-ops
  *Spectre*, mobile HQ) + 3 air (fighter, transport, drone); no navy yet
- Combat with counters; Classic AI levels 1–3 (decision ladder only)
- Ages: Foundation → Connectivity (2 of 5), 1 National Program choice
- Win/lose: Conquest only; defeat debrief + rematch
- Save/exit/resume, pause, speed controls, cheat `prosperity now`
- HUD, camera, selection, orders; adaptive music + SFX v1; advisor ("worst
  problems first")

**OUT (explicitly deferred, not cut):** navy + 7 maps (Phase 1.5), campaign
(Phase 2), Muse persona AI (Phase 2), chain-of-command UI — manual control
only, but the *data model* reserves mayor/general slots (Phase 3), 3 more
ages, entrepreneurs-as-agents (firms simplified to buildings), superweapons
(Aegis/Storm Engine arrive with the campaign), mobile/touch (only if
playtests show it's fun — brief's own condition).

**Why this cut is fun:** it contains the entire fantasy loop — found a city,
grow it, tech up, build an army, beat a legible AI — in 30–60 minute
sessions. Everything deferred *extends* this loop rather than completing it.

## Open questions & recommendations

| # | Question | Recommendation | Owner/Status |
|---|---|---|---|
| 1 | Mode 2 "play against Muse". | **Confirmed 2026-09-28:** persona director as the offline default **plus** an optional "Live Muse link" when online (user connects their own API key in settings; key in `localStorage` only; strategic-commander protocol that never blocks the tick; silent fallback to persona when offline). See C7 + C7a. | Resolved |
| 2 | Game name. | **NOVATERRA** (see C1 for the shortlist + rationale). | Resolved 2026-09-28: NOVATERRA confirmed; repo renamed to `novaterra` |
| 3 | Faction count at launch: 1 shared roster + 2 doctrines, or fully asymmetric rosters? | 1 shared roster + 2 doctrine overlays at launch (balance cost); full asymmetry post-launch. | Design decision, recorded |
| 4 | Mobile/touch scope. | Per brief: only if playtests show it's genuinely fun. Desktop-first; reassess after MVP playtests. | Deferred to post-MVP |
| 5 | Citizen simulation depth: full agents vs statistical cohorts? | Recommend cohorts + sampled visible agents (perf); sim-architecture workstream to decide. | → sim-architecture.md |

## Research log & dead ends

- 2026-09-28: workstream kickoff; A1–A6 researched with cited sources; Parts
  B–C drafted (pillars, name shortlist, backstory, loop, resources, ages,
  win/lose, difficulty×modes, campaign, maps, chain of command, rosters, MVP).
- **Dead end — live Muse opponent:** rejected (offline browser game cannot host
  a model in the loop; would need server infra + latency + cost). Replaced by
  the Mode-2 adaptive AI director design (C7).
- **Dead end — full per-citizen agent sim at city scale:** noted as perf risk;
  recommendation is cohorts + sampled agents. Final call belongs to the
  sim-architecture workstream.
- **Dead end — CK-style rebellious vassals:** rejected. Mayors/generals are
  appointed bureaucrats with competence stats; drama comes from competence
  failures, not rebellion plots. Keeps the fantasy presidential, not feudal.
- **Dead end — mandatory delegation:** rejected per Nobunaga's Awakening
  lesson (A6). All automation is opt-in per function.
- **Dead end — RA3-style per-unit active abilities:** rejected. Abilities must
  be few, impactful, or automatable (A2).
- **Dead end — gimmick-every-mission campaign:** rejected per the SC2 debate
  (A4). Cap: ≤1 in 3 missions with hard constraints.
