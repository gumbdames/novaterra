# Mk II / Mk III variant tradeoffs (M15)

**Date:** 2026-10-01 · **Scope:** final-review R5 M15 · **Status:** shipped on `review/r6-polish`

## 1. The decision

The user's explicit decision: Mk II and Mk III are **genuine tactical tradeoffs, not stat ladders**. The Phase 8 workstream D implementation (2026-09-30) shipped every tier as a strict upgrade (more hp, more damage, more speed, more sight — only the price went up), which made the base kind and the Mk II obsolete the moment the next tier unlocked. That is a ladder, not a choice.

The redesign rule, enforced by regression tests (`game/tests/sim.variants.test.ts`, "variant tradeoffs (M15: no stat ladders)"):

- **Every Mk II/III regresses on >= 1 combat stat vs its base** (hp, speed, damage, range, sight, cooldown, minRange, fuel burn).
- **Every Mk II/III improves on >= 1 stat vs its base** (never a strict downgrade).
- **Every Mk III regresses AND improves vs its Mk II** (the ladder stays broken at the top).
- **A pin table locks the defining tradeoff stat of all 28 variants** (see §2) — the number that makes the role what it is.

The base kind therefore stays situationally right: it is usually the cheapest, often the fastest or the most economical, and sometimes the only ammo-free or sensor-sane pick.

Cost scaling is unchanged (Mk II ~x1.6, Mk III ~x2.5 funds/materials; manpower never decreases) — tech costs more even when it trades off. Gating is unchanged: Mk II minAge is one age above the base (floored at industry), Mk III one age above Mk II; the base's `requiredBuilding` still gates the line.

## 2. The 28 roles

Format: **Variant** — better at → *worse at*.

### Land

| Variant | Role | Better at | Worse at |
|---|---|---|---|
| Assault Tank Mk II | breakthrough brawler | +damage, +hp, +vsMedium | slower (8 vs 10), blinder (24 vs 26), thirstier |
| Railgun Tank Mk III | long-range sniper | +range (23), +damage | slowest of the line (7), slower-firing (60 ticks), near-blind (22) — needs spotters |
| Siege Artillery Mk II | outranges everything | +range (56), +damage | thinner armor, bigger dead zone (16 vs 12) — needs an escort screen |
| Rocket Artillery Mk III | alpha strike | +damage (150) at 60 range | glass cannon (120 hp), slower reload (120), 20-cell dead zone |
| AA Gun Platform Mk II | static air umbrella | +damage, +range (32), +vsAir (2.6) | slow to reposition (8), shorter sensors (30) |
| Missile AA Mk III | best air kill | +damage, +range (38), +vsAir (3.2) | fragile (180 hp), 6-cell dead zone overhead, ammo logistics (12 missiles) |
| IFV Mk II | fights instead of runs | real gun (30 dmg) | slower (10 vs 12) — a worse battle-taxi |
| Command APC Mk III | scout / command post | fastest hull (14), huge sensors (36) | pea-shooter gun (12 dmg) — sees everything, kills nothing |
| Heavy Hauler Mk II | bulk logistics | DOUBLE cargo (80/40), tougher | slow (7 vs 9) — fewer trips per hour |
| Express Hauler Mk III | fast logistics | fastest supply wheels (12) | fragile (140 hp), thirsty (0.15/s), less cargo than Mk II (60/30) |

### Air

| Variant | Role | Better at | Worse at |
|---|---|---|---|
| Interceptor Mk II | air-superiority duelist | fastest (31), best vsAir (2.2), huge sensors (46) | weaker gun vs ground (28 dmg, gutted multipliers), shorter legs |
| Multirole Mk III | heavy hitter | +damage (45), +vsAir (2.4), tough (230 hp) | slower (24 vs 31) — interceptors eat it |
| Strike Bomber Mk II | bunker buster | alpha (160 dmg), 2.0 vsHeavy | slow (24), thinner (180 hp), blinder (28) — needs escorts |
| Stealth Bomber Mk III | deep strike | fast (33), great sensors (40) | fragile (160 hp), weak vs lights (0.5) |
| Tank Hunter Mk II | armor shredder | +damage (90), 2.0 vsHeavy, +range | slower (26), blinder (26) |
| Hunter-Killer Mk III | killer-scout | fastest rotor (35), scout sensors (38), faster gun | fragile (130 hp), thirsty (0.55/s) — cannot loiter |
| Siege Gunship Mk II | flying artillery | +damage (130), +range (24), toughest hull (360) | ponderous (18), 4-cell dead zone, slower gun |
| Rapid Gunship Mk III | responsive CAS | fast (28), 45-tick gun | thinner (240 hp), shorter reach (18), thirsty |

### Sea

| Variant | Role | Better at | Worse at |
|---|---|---|---|
| AA Destroyer Mk II | fleet air shield | +damage, +range, +sight, 2.6 vsAir | slower (10), weak vs capitals (0.7 vsHeavy) |
| Missile Destroyer Mk III | capital killer | +damage (70) at 32 range, 1.4 vsHeavy | thin hull (520 hp), ammo logistics (20 missiles) |
| ASW Frigate Mk II | sub hunter | 2.0 vsMedium (subs are medium armor), 38 sight | weaker guns (26 dmg), slower (12) |
| Fast Frigate Mk III | fast interceptor | fastest surface combatant (17), real gun (40) | fragile (360 hp), weak vs heavies (0.6), thirsty |
| Hunter-Killer Mk II | boat hunter | fast (13), better sensors (32), harder punch | thinner hull (260 hp), weaker vs heavies |
| Missile Sub Mk III | capital sniper | +damage (140) at 36 range, 2.4 vsHeavy, 24 torpedoes | slow (9), slower gun (90 ticks) |
| Strike Boat Mk II | heavy punch | +damage (100), 1.8 vsHeavy, 12 missiles | slower (16 vs 20), thinner (160 hp) |
| Fast Attack Mk III | hit and run | fastest strike craft (24), +range, better sensors | fragile (150 hp), short magazine (8), thirsty |
| Heavy Transport Mk II | survivable hauler | tough (520 hp), deep fuel tank | slow (8 vs 9) |
| Depot Ship Mk III | **mobile sea depot** | 200 fuel / 60 ammo cargo — the def-driven supply system treats it as a supply unit automatically | expensive, unarmed, civilian-grade sensors (20 sight — worse than the base's 22), needs a protection screen |

## 3. The AI's situational pick (`chooseVariant`)

With ladders gone, "highest tier" is no longer the right default — the old `preferHighestVariant` (highest unlocked + affordable) was replaced by `chooseVariant` in `game/src/sim/variants.ts`:

1. **Candidates:** the variant line at or above the input tier, filtered to unlocked-for-the-owner (`isVariantUnlocked`) AND affordable right now (stockpile minus the per-think ledger reservations). Nothing qualifies → the input kind unchanged.
2. **Rich** (`funds >= VARIANT_RICH_FUNDS`, 8000 — well above any single unit's price but reachable by a developed economy): take the **top** affordable tier. When money is no object, take the sharpest tool.
3. **Otherwise:** take the best **combatValue/cost** — the situational pick:
   - combat kinds: `combatValueOf = hp x (damage / cooldownTicks) x (1 + range / 50)`
   - logistics kinds (damage 0): `hp x speed x (1 + cargo / 100)`
   - `trainCostOf = trainFunds + trainMaterials`

The formula is deliberately coarse — it only ranks tiers of the *same* variant line, where the numbers are close by design. Worked example (tank line): base 690/460 = 1.500, Mk II 1112/740 = 1.503, Mk III 1448/1210 = 1.196 — a cash-strapped AI buys the assault tank, a rich AI the railgun, and the base stays competitive on pure value. Hauler line: the base hauler wins on logistics value/cost (16.5 vs 14.4 vs 8.0), so a poor AI buys cheap trucks.

Called once per train in `thinkProduction` (`ai.ts`) — a substitution, not a rewrite: the counter/base-mix logic above it is untouched, and the `spawn` helper re-checks affordability through the ledger before issuing. Pure, deterministic, no RNG — and it never downgrades below the input tier (an explicit Mk II request stays Mk II+).

## 4. What changed mechanically

- `game/src/sim/units.ts`: all 28 Mk II/III defs rewritten with role names ("Assault Tank Mk II", "Depot Ship Mk III", … — the names themselves now teach the tradeoff).
- `game/src/sim/variants.ts`: `preferHighestVariant` → `chooseVariant` (+ `combatValueOf`, `trainCostOf`, `valuePerCost`, `VARIANT_RICH_FUNDS` exports).
- `game/src/sim/ai.ts`: `thinkProduction` calls `chooseVariant` (comment updated).
- `game/src/ui/strings.ts`: the 28 localized unit names updated to the role names (English-only via `loc()`, as always).
- Tests: `game/tests/sim.variants.test.ts` — the old stat-ladder pins ("hp/damage/speed improve tier over tier", "sight never regresses", "hauler cargo grows each tier") were replaced by the tradeoff contract + the 28-variant pin table + the `chooseVariant` suite (rich → top tier, poor → value/cost, ledger, never-downgrade, determinism). The AI substitution test still passes unchanged: a resource-rich citizen AI at industry age trains tankMk2.

## 5. Deliberate non-changes

- **No new art:** variants still share the base kind's model (§AD12, zero new `MODEL_PATHS` keys).
- **No snapshot/digest change:** variant defs are plain `UNIT_DEFS` data; kind ids were already snapshotted.
- **MinAge ladder unchanged** (Mk II one age above base floored at industry, Mk III one above Mk II) — the tech *progression* is still a ladder; only the *stats* stopped being one.
- **Historical docs untouched:** `docs/research/phase8-civilian-peaceful.md` §D describes the original ladder design as shipped on 2026-09-30; this document records the 2026-10-01 redesign.
