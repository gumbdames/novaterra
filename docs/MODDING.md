# MODDING.md — NOVATERRA 0.1 Alpha

> Honesty first: in 0.1 Alpha, **modding = fork the repo and edit
> TypeScript**. There is no mod loader, no Steam Workshop integration,
> no asset-pack drop-in. NOVATERRA's roster is data-driven, which makes
> the fork-and-edit path unusually clean — this guide shows how.

NOVATERRA's roster is **data-driven**: units, buildings, and upgrades are
plain TypeScript records. Adding a new unit (or building, or upgrade) is a
recipe, not an engine change — no new systems to wire, just data in the
right tables. This guide walks through adding one unit end-to-end.

> Scope: 0.1 Alpha supports **data mods** (roster additions, stat tweaks,
> cost/age gating). New sim *mechanics* (a new damage type, a new order
> kind) need code changes in `game/src/sim/` and are out of scope here.

## The three tables

| Table | File | What it holds |
|---|---|---|
| `UNIT_DEFS` | `game/src/sim/units.ts` | All 103 unit kinds: stats, costs, gating |
| `BUILDING_DEFS` | `game/src/sim/city.ts` | All 100 building kinds: costs, footprint, effects |
| `UPGRADE_DEFS` | `game/src/sim/upgrades.ts` | All 22 upgrades: costs, prerequisites |

Each is a `Record<Kind, Def>` — one entry per kind, keyed by the kind id.

## Recipe: add a unit

### 1. Add the kind id

`UnitKind` is a string union in `game/src/sim/units.ts`. Add your id
(e.g. `'railgunTank'`) in alphabetical order with the others.

### 2. Write the def

Add an entry to `UNIT_DEFS` keyed by your id. The required fields:

```ts
railgunTank: {
  kind: 'railgunTank',
  name: 'Railgun Tank',
  domain: 'land',            // 'land' | 'sea' | 'air'
  hp: 420,
  speed: 9,                  // world units per second
  armor: 'heavy',             // 'none' | 'light' | 'medium' | 'heavy'
  damage: 90,                // per shot; 0 = unarmed
  range: 26,                 // weapon range, world units
  minRange: 6,               // dead zone (artillery-style); 0 for most
  cooldownTicks: 90,         // 30 ticks = 1 sim-second
  targets: 'ground',          // 'ground' | 'sea' | 'air' | 'seaAir' | 'both'
  vsLight: 1.0, vsMedium: 1.2, vsHeavy: 1.5, vsAir: 0,
  sight: 30,
  minAge: 'information',      // 'foundation' | 'connectivity' | 'industry' | 'information' | 'ascendance'
  manpowerCost: 2,
  trainFunds: 900,
  trainMaterials: 120,
  requiredBuilding: 'warFactory',  // must be completed to train; omit for always-available
},
```

Optional logistics fields (grand-expansion Phase 3): `fuelCapacity` +
`fuelPerSecond` (vehicles that burn fuel), `ammoCapacity` + `ammoPerShot`
(missile weapons). Omit both for infantry-style units.

### 3. Name it for the UI

Add `{ en: 'Railgun Tank' }` to `unitNames` in `game/src/ui/strings.ts`
(the roster-expansion section — see `docs/I18N.md`). The game is
English-only in 0.1 Alpha, but every player-facing string goes through
`loc()` so a future locale picks it up.

### 4. Give it a model

In `game/src/render/entities.ts`, add your kind to `MODEL_SOURCES`:

- **CC0 GLB**: add the file under `game/public/models/` and map the kind
  to `{ type: 'glb', key: 'railgunTank' }` in `MODEL_PATHS`
  (`game/src/render/models.ts`).
- **Procedural**: map to `{ type: 'procedural' }` and add a builder in
  `game/src/render/proceduralModels.ts` (register in `PROCEDURAL_KINDS`
  and the `buildProceduralModel` switch).

If you do neither, the kind falls back to the placeholder box — the game
still runs, it just looks grey.

### 5. Put it in a build tab

`game/src/ui/palettes.ts` holds `TRAIN_TABS` (which units appear under
which tab). Add your kind to the right tab's list, in the order you want
it displayed.

### 6. Test it

```bash
cd game
npx tsc --noEmit                       # the def must satisfy UnitDef
npx vitest run tests/sim.units.test.ts # roster-integrity tests cover every UNIT_DEFS entry
```

The roster-integrity tests assert (among other things) that every
`UnitKind` has a def, every def's kind key matches, every unit has a
`unitNames` entry, and every kind resolves a model source. If you missed
a step, a test tells you which one.

## Recipe: add a building

Same shape, in `BUILDING_DEFS` (`game/src/sim/city.ts`):

```ts
railgunPlant: {
  kind: 'railgunPlant',
  name: 'Railgun Plant',
  // footprint in cells, costs, zone, minAge, effects…
},
```

Then: `buildingNames` in `strings.ts`, a model source in
`entities.ts`, a slot in `BUILD_TABS` (`palettes.ts`), and
`tests/sim.city.test.ts` for the integrity checks.

## Recipe: add an upgrade

In `UPGRADE_DEFS` (`game/src/sim/upgrades.ts`):

```ts
railgunCoils: {
  id: 'railgunCoils',
  name: 'Railgun Coils',
  costFunds: 1200,
  costResearch: 120,
  requiredBuildings: ['warFactory'],
  minAge: 'information',
  military: true,
},
```

Then: `upgrades` names+effects in `strings.ts`, and implement the effect
— upgrades are the one table where data alone isn't enough: add the hook
where the stat is consumed (e.g. `sim/combat.ts` for a damage bonus),
gated on `hasUpgrade(player, 'railgunCoils')`.

## Determinism contract

The sim is deterministic (see `docs/ARCHITECTURE.md`): same seed + same
orders = same outcome, bit-for-bit. Your mod must preserve it:

- **No `Math.random()`** in sim code — use the seeded PRNG (`world.rng`).
- **No wall-clock reads** (`Date.now()`, `performance.now()`) in sim code.
- **No iteration over unordered collections** where order affects the
  outcome — sort first, or use the sim's deterministic helpers.

Render-side code (`game/src/render/`) is free of these constraints —
decoration may use any source of randomness, but poses should stay pure
functions of `(seed, index, tick)` so pause/seek/rebuild are exact.

## Checklist before you share a mod

1. `npx tsc --noEmit` clean.
2. `npx vitest run` green (the roster-integrity tests catch most
   missing steps).
3. `npm run build` clean.
4. No third-party assets without a compatible license — record every
   added file in `THIRD_PARTY_NOTICES.md`.
5. English-only player-facing text, through `loc()` (see `docs/I18N.md`).
