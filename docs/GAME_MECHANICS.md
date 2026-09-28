# Game Mechanics — novaterra

> Player-facing mechanics reference. Written alongside implementation in
> Phase 1 — kept **clear, short and simple** per the design brief.
> Last updated: 2026-09-28 (ages: Foundation → Connectivity).

## Building your city

- **Roads** connect everything. Buildings must touch a road to work.
  Roads cost 5 Funds + 2 Materials per tile.
- **Zones** decide what goes where. Paint residential, commercial, or
  industrial zones (1 Fund per tile), then place matching buildings on
  them. Power plants and water pumps fit anywhere.
- **Buildings** take time to construct and cost upkeep every second.
  Demolishing is free but you get nothing back — plan before you place.

## The five resources

- **Funds** — spent on everything; earned from shops and taxes.
- **Materials** — building material; produced by factories.
- **Fuel** — burned by factories and power plants; buy it or run short.
- **Food** — grown by farms; your people eat it every second.
- **Research** — produced by labs; unlocks progress later.

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

Trade any resource for funds at fixed prices. Buying costs 20% extra,
selling pays 20% less — so only trade when you need to, not for profit.

## Growth

A healthy city grows on its own: new buildings appear in zoned areas
every few seconds, as long as people are fed and you can afford them.
If food runs out, growth stops until farms catch up.

## Ages: Foundation → Connectivity

Your nation develops through ages. You start in the **Foundation** age.
When you're ready (and can afford it), advance to **Connectivity** by
picking one **National Program** — a permanent choice:

- **Fiber Grid** (economy): +25% income from taxes. Pick this to get rich.
- **Signals Grid** (intel): your units see 8 units farther. Pick this to
  out-scout and out-maneuver the enemy.

Advancing costs 3,000 Funds + 1,200 Materials — spend it wisely, because
that army you're not building leaves you exposed. Connectivity also
unlocks **fighters** (fast air units). Choose carefully: you can't switch
programs later.

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

## The enemy

In skirmish you face the **Classic AI** at one of three levels:

- **Cadet** — learns the ropes with you. Small armies, simple attacks.
- **Citizen** — a fair fight. Builds counters and presses advantages.
- **Commander** — ruthless. Big armies, smart targeting, no mercy.

(In 0.1 Alpha there is no victory screen yet — the fight is the game.
Wiping out the enemy base is its own reward.)
