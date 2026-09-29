# Game Mechanics — novaterra

> Player-facing mechanics reference. Written alongside implementation in
> Phase 1 — kept **clear, short and simple** per the design brief.
> Last updated: 2026-09-29 (Phase 3: delegation, superweapons, advanced economy, accessibility).

## Building your city

- **Roads** connect everything. Buildings must touch a road to work.
  Roads cost 5 Funds + 2 Materials per tile.
- **Zones** decide what goes where. Paint residential, commercial, or
  industrial zones (1 Fund per tile), then place matching buildings on
  them. Power plants and water pumps fit anywhere.
- **Buildings** take time to construct and cost upkeep every second.
  Demolishing is free but you get nothing back — plan before you place.

## The eight resources

- **Funds** — spent on everything; earned from shops and taxes.
- **Materials** — building material; produced by factories.
- **Fuel** — burned by factories and power plants; buy it or run short.
- **Food** — grown by farms; your people eat it every second.
- **Research** — produced by labs; unlocks progress later.
- **Goods** — made by factories, bought by shops and turned into
  funds. No goods, no shop income.
- **Influence** — produced by Media Centers. Spent to advance ages;
  more influence means faster progress.
- **Manpower** — grows with your population. Training soldiers and
  ships spends it — a big army needs a big city behind it.

## Power and water

Each power plant supplies 25 power, each water pump 25 water. Buildings
draw from the shared pool — if demand exceeds supply, the oldest
buildings get served first. A building without power produces at 25%;
without water, another 25%. Keep headroom as you grow.

## Upkeep and taxes

Every building charges upkeep. If funds run dry, your newest buildings
shut down first. Taxes are your main income: set a rate per zone
(0–100%), collected every minute. Higher taxes mean more money but
slower growth — low taxes grow your city faster.

## The market

Trade materials, fuel, food, or research for funds at fixed prices.
Buying costs 20% extra, selling pays 20% less — so only trade when you
need to, not for profit. (Goods, influence, and manpower can't be traded.)

## Growth

A healthy city grows on its own: new buildings appear in zoned areas
every few seconds, as long as people are fed and you can afford them.
If food runs out, growth stops until farms catch up.

## Ages: Foundation → Connectivity → Industry → Information → Ascendance

Your nation develops through five ages. You start in the **Foundation**
age. Each age advance costs resources and asks you to pick one
**National Program** — a permanent choice:

- **Connectivity** (3,000 Funds + 1,200 Materials):
  - **Fiber Grid** (economy): +25% income from taxes.
  - **Signals Grid** (intel): your units see 8 units farther.
  - Unlocks **fighters** (fast air units).
- **Industry** (6,000 Funds + 2,500 Materials + 100 Influence):
  - **Heavy Industry**: factories make +50% materials and goods, but
    all upkeep costs +25%.
  - **Green Tech**: buildings use 30% less power and water, and Media
    Centers make +50% influence.
  - Unlocks **ships** (see Navy below).
- **Information** (12,000 Funds + 5,000 Materials + 250 Influence):
  - **Cyber Command**: spectres deal +50% damage, military units see
    +4 farther.
  - **Global Media**: Media Centers make +100% influence.
- **Ascendance** (25,000 Funds + 10,000 Materials + 500 Influence):
  - **Arsenal Program**: military units cost 30% less manpower and
    deal +25% damage.
  - **Prosperity Program**: +50% tax income and +50% goods output.

Choose carefully: you can't switch programs later. Each age builds on
the last — a rich, well-powered city advances fastest.

## Your army

Pick a unit from the panel at the bottom-left, then click open ground
to train it there. Every unit is strongest against something and weak
against something else:

- **Engineer** — builds everything. Protect yours.
- **Rifles** — cheap infantry, good against other infantry.
- **Tank** — tough all-rounder, eats infantry for breakfast.
- **Artillery** — very long range, shreds tanks; fragile up close.
- **AA** — the only ground unit that can hit aircraft.
- **Spectre** — fast stealthy raider, hunts tanks and artillery.
- **Drone** — cheap flying scout, sees far.
- **Fighter** — fast air superiority (needs the Connectivity age).
- **Transport / Hauler / Mobile HQ** — support: carry, supply, and a
  moving command post that makes nearby units fight better.

The rule of thumb: **tanks beat infantry, artillery beats tanks, AA
beats anything that flies**. Scout first, then build the counter.

## Navy

Water is not just scenery. Build a **Shipyard**, reach the Industry age,
and rule the seas:

- **Patrol Boat** — fast scout, good against light ships.
- **Destroyer** — heavy warship; shreds ships and aircraft alike.
- **Transport Ship** — unarmed, carries your plans across the water.

Ships can only be placed on water and can only fight on water — they
can't attack land targets, and tanks can't shoot back at them. On
water-heavy maps, the navy decides the game.

## Maps

Eight battlefields, from nearly all land to mostly ocean:

- **Meridian Plains** (5% water) — classic land war.
- **Riverlands** (12%), **Lake Country** (20%), **Coastline** (30%).
- **Archipelago** (40%), **Shattered Isles** (50%).
- **Inland Sea** (55%), **Ocean World** (60% water) — bring a navy.

Pick your map on the skirmish setup screen. More water means more naval
play and trickier land routes.

## The enemy

In skirmish you face the **Classic AI** at one of five levels:

- **Cadet** — learns the ropes with you. Small armies, simple attacks.
- **Citizen** — a fair fight. Builds counters and presses advantages.
- **Commander** — ruthless. Big armies, smart targeting, no mercy.
- **General** — combined arms. Uses land, air, and sea together.
- **Marshal** — total war. The smartest, toughest fair fight.

The AI never cheats: it sees only what its own units see, and gives
the same orders a human player would. Destroy every enemy unit and
building to win the **conquest victory** screen — but if you lose all
of your own units and buildings first, the **defeat** screen ends your
run. (If both sides fall on the same tick, defeat takes precedence:
you must survive your victory to claim it.)

## The campaign: "The First Term"

From the main menu, **Missions** starts the 8-mission story campaign.
Each mission has a briefing, one or more ways to win, and scripted
events (raids, warnings, milestones). **Every mission can be completed
peacefully** — look for the 🕊 path on the briefing screen.

- Mission 1 is a tutorial with no enemy: learn to select, move, build,
  and grow.
- Later missions add food pressure, border raids, naval warfare, age
  races, two-front wars, an influence contest, and a final confrontation
  with Marshal Dain.
- Winning bloodlessly (no kills, no losses) earns **Diplomat** points;
  destroying enemies earns **Commander** points. After the final
  mission, your tally decides the ending: **The Peacemaker** or
  **The Commander** (ties go to the Peacemaker).
- Progress saves automatically between missions.

## Muse — your chief of staff

**Muse** watches your game and comments on it: buildings finished,
ages advanced, enemies spotted, battles starting. They also run the
**threat meter** (bottom-right): the enemy's share of total military
power, from safe to danger.

Muse is charming, never annoying: how often they speak is your call —
**Off / Quiet / Normal / Chatty** in Settings. Quiet means milestones
only. In campaign missions Muse also delivers the story's scripted
messages.

## Muse Commander — the rival driven by your API key

Pick **Muse — your API key drives the rival** as the skirmish difficulty
and the enemy commander is powered by your own Muse API key. Once per
minute (30 s / 60 s / 2 min in Settings) the game sends a compact,
fog-filtered battle summary to the Anthropic API; Muse answers with
orders like `build: tank`, `attack: 120, 80`, or `defend`, which the
game executes as ordinary commands — the same ones you and the Classic
AI use.

Fairness is structural, not promised:

- **Muse never touches the game directly.** Every decision becomes a
  normal validated command; illegal or unaffordable orders are rejected
  exactly as yours would be.
- **No fog cheating.** The summary contains the rival's full state but
  only the enemy units and buildings its own units can actually see —
  the same sight rule the Classic AI plays by.
- **The network never blocks the game.** Calls happen off the sim tick;
  while Muse "thinks" (badge, top-right) the game runs on normally.
- **Offline fallback is seamless.** No key, timeout, rate limit, or API
  error simply means "no orders this round" — a Classic
  Commander-level brain plays the rival at full strength the whole
  time, so the game is never broken.

Your key lives only in your browser (`localStorage`) and is sent only
to `api.anthropic.com`; API usage is billed to your Anthropic account.
Test the connection from Settings before you play.

## Phase 3: Chain of command

**Mayors** (opt-in): appoint a mayor to automate your tax policy. Three
policies: **Balanced** (15% all zones), **Growth** (low taxes to attract
people), **Revenue** (high taxes for maximum income). Your mayor also
builds for you: pick a build focus — **Housing** (homes and apartments),
**Industry** (factories and farms), or **Balanced** (whatever the city
needs most) — and the mayor places one building every 10 seconds,
zoning new blocks when the city runs out of room. Dismiss anytime
to take back manual control. No mayor = no automation (the default).

**Generals** (opt-in): select units, then appoint a general to command
them. Three stances: **Aggressive** (hunts visible enemies),
**Defensive** (engages near your base, radius 45), **Hold** (stays put,
never chases). The general reassesses every 2 seconds using only what
your units can see — no fog cheating. Dismiss to resume direct control.

## Phase 3: Superweapons (Ascendance age)

**Aegis Control** (5,000 funds + 2,000 materials, 120s build): fire the
**Aegis** shield — blocks ALL damage to your units for 60 seconds.
10-minute cooldown. A glowing energy dome covers your city while the
shield holds. The Marshal AI builds and uses it fairly.

**Storm Array** (6,000 funds + 2,500 materials, 150s build): fire the
**Storm Engine** — 8 lightning strikes over ~8 seconds at your target
point (±3 scatter, 120 damage, radius 10). Storm clouds gather, lightning
flashes, and each strike kicks up a fireball. 10-minute cooldown. Aegis
shields block storm damage too.

## Phase 3: Advanced economy

**City specialization**: focus your city — **Industrial** (+25% factory
output, −10% other zones), **Commercial** (+25% shops), **Residential**
(+25% homes), or **Balanced** (no bonus, no penalty). Utility buildings
are unaffected.

**Trade routes**: establish routes with other players (500 funds setup).
Each active route pays 3 funds/sec — but only while both you and your
partner have working commercial buildings. Cancel anytime.
