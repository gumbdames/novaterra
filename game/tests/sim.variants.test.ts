/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3 of the License.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tech-level variant tests (grand-expansion Phase 8,
 * workstream D, 2026-09-30).
 *
 * Covers the Mk II / Mk III unit variants in `sim/units.ts` and the
 * helpers in `sim/variants.ts`:
 *
 *  - Roster shape: exactly 28 variants (14 bases × 2 tiers); every
 *    variant def carries `variantOf` + `variantTier`; every base has
 *    exactly one Mk II and one Mk III; `variantLine` groups correctly.
 *  - Stat progression (data-driven over the variant table): variants
 *    are real upgrades — hp/damage/speed improve tier over tier, never
 *    a placebo reskin.
 *  - Cost scaling: Mk II ≈ ×1.6 funds/materials, Mk III ≈ ×2.5, and
 *    manpower never decreases (tech costs more, even when it trades off).
 *  - Tradeoffs (M15, 2026-10-01): Mk II/III are NOT stat ladders — every
 *    variant regresses on ≥1 combat stat vs its base AND improves on
 *    ≥1, so the base stays situationally right; a pin table locks the
 *    defining tradeoff stat of each of the 28 variants.
 *  - Gating: `isVariantUnlocked` mirrors the spawnUnit validator
 *    exactly — locked without the age or the production building,
 *    unlocked with both (a data-driven matrix over representative
 *    variants); the peaceful lockout rejects military variants and
 *    still trains the civilian hauler/transportShip variants.
 *  - `chooseVariant`: rich owners (funds ≥ VARIANT_RICH_FUNDS) take the
 *    top affordable tier; everyone else takes the best combatValue/cost
 *    among unlocked + affordable tiers — the situational pick; the
 *    per-think ledger reservations count; deterministic.
 *  - AI substitution: a citizen AI with warFactory + industry age
 *    actually trains tankMk2 (the "no AI capability cliff" rule).
 *  - Save/load: variant records round-trip through snapshots; same
 *    seed + commands ⇒ identical digest.
 *
 * Headless (no DOM/three.js). Deterministic: no wall clock, no Math.random.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  CommandRejectedError,
  createCommandQueue,
  type CommandQueue,
  type NewCommand,
} from '../src/sim/commands';
import { registerUnitCommands, UNIT_DEFS, type UnitDef, type UnitKind } from '../src/sim/units';
import {
  cellCenterWorld,
  cellIsWater,
  CITY_GRID_CELLS,
  type BuildingKind,
} from '../src/sim/city';
import { AGE_ORDER, type Age , getAgeState } from '../src/sim/ages';
import {
  getVariantKinds,
  isVariant,
  variantBaseOf,
  variantArtBase,
  variantTierOf,
  variantLine,
  isVariantUnlocked,
  chooseVariant,
  combatValueOf,
  valuePerCost,
  VARIANT_RICH_FUNDS,
  type VariantUnitKind,
} from '../src/sim/variants';
import { takeSnapshot, restoreSnapshot } from '../src/sim/snapshot';
import { digestWorld } from '../src/sim/digest';
import {
  generateTerrain,
  MERIDIAN_PLAINS,
  type TerrainData,
} from '../src/sim/terrain';
import {
  grantAllTrainingResources,
  completeBuilding,
} from './sim.roster-fixtures';
import { createTickDriver, TICK_MS } from '../src/sim/tick';
import { registerCoreCommands } from '../src/sim/commands';
import {
  createPathfindingSystem,
  createMovementSystem,
  registerMovementCommands,
} from '../src/sim/movement';
import { createCombatSystem, registerCombatCommands } from '../src/sim/combat';
import { addAIPlayer, createAISystem, AI_THINK_TICKS } from '../src/sim/ai';
import { isWater } from '../src/sim/terrain';
// The §AD12 art-sharing contract (render layer): imported AFTER the sim
// modules above, so the sim graph is fully evaluated before
// render/entities pulls it in (the units→city→world→ai import cycle is
// only safe in that order — see sim/variants.ts `getVariantKinds`).
import { modelSourceFor, hullSizeFor } from '../src/render/entities';
import { MODEL_PATHS } from '../src/render/models';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let cachedTerrain: TerrainData | null = null;
function getTerrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

interface Ctx {
  terrain: TerrainData;
  world: World;
  queue: CommandQueue;
}

/** A war (non-peaceful) world with unit commands registered. */
function setup(seed = 20260930): Ctx {
  const terrain = getTerrain();
  const world = createWorld(seed);
  const queue = createCommandQueue();
  registerUnitCommands(queue, terrain);
  grantAllTrainingResources(world);
  return { terrain, world, queue };
}

function enq(ctx: Ctx, kind: string, payload: Record<string, unknown>): void {
  const cmd: NewCommand = { kind, payload, issuer: 'player' };
  ctx.queue.enqueue(ctx.world, cmd);
}

/** The rejection message for a command, or null when it enqueues cleanly. */
function rejectionReason(
  ctx: Ctx,
  kind: string,
  payload: Record<string, unknown>,
): string | null {
  try {
    enq(ctx, kind, payload);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(CommandRejectedError);
    return (e as CommandRejectedError).message;
  }
}

/** Find an all-land rect (for spawn points). */
function findLandRect(t: TerrainData, w: number, h: number): { cx: number; cz: number } {
  for (let cz = 0; cz + h <= CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx + w <= CITY_GRID_CELLS; cx++) {
      let ok = true;
      for (let dz = 0; dz < h && ok; dz++) {
        for (let dx = 0; dx < w && ok; dx++) {
          if (cellIsWater(t, cx + dx, cz + dz)) ok = false;
        }
      }
      if (ok) return { cx, cz };
    }
  }
  throw new Error(`no ${w}x${h} land rect`);
}

/** Find one water cell (for sea-unit spawn points). */
function findWaterCell(t: TerrainData): { cx: number; cz: number } {
  for (let cz = 0; cz < CITY_GRID_CELLS; cz++) {
    for (let cx = 0; cx < CITY_GRID_CELLS; cx++) {
      if (cellIsWater(t, cx, cz)) return { cx, cz };
    }
  }
  throw new Error('no water cell');
}

/**
 * A spawn point matching the variant's domain: sea kinds need water,
 * everything else spawns on land. (spawnUnit validates the terrain
 * before most other gates, so a wrong-domain point masks the gate
 * under test.)
 */
function spawnPointFor(ctx: Ctx, variant: UnitKind): { x: number; z: number } {
  if (UNIT_DEFS[variant].domain === 'sea') {
    const { cx, cz } = findWaterCell(ctx.terrain);
    return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
  }
  const { cx, cz } = findLandRect(ctx.terrain, 4, 4);
  return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
}

/** The 14 base kinds that have Mk II / Mk III variants. */
const VARIANT_BASES: UnitKind[] = [
  'tank',
  'artillery',
  'aa',
  'apc',
  'hauler',
  'fighter',
  'fighterBomber',
  'attackHeli',
  'gunship',
  'destroyer',
  'frigate',
  'submarine',
  'missileBoat',
  'transportShip',
];

/** The three defs of a variant line, loud when the line is incomplete. */
function lineDefs(base: UnitKind): [UnitDef, UnitDef, UnitDef] {
  const [b, mk2, mk3] = variantLine(base).map((k) => UNIT_DEFS[k]);
  if (!b || !mk2 || !mk3) throw new Error(`variant line incomplete for ${base}`);
  return [b, mk2, mk3];
}

/** The 24 military variant kinds (the 4 civilian ones are the hauler + transportShip lines). */
const MILITARY_VARIANTS: VariantUnitKind[] = getVariantKinds().filter(
  (k) => UNIT_DEFS[k].military === true,
);

// ---------------------------------------------------------------------------
// Roster shape
// ---------------------------------------------------------------------------

describe('variant roster shape', () => {
  it('has exactly 28 variants: 14 bases × 2 tiers', () => {
    expect(getVariantKinds()).toHaveLength(28);
    expect(MILITARY_VARIANTS).toHaveLength(24);
    // The 4 civilian variants are the peaceful-mode tech path.
    expect(getVariantKinds().filter((k) => UNIT_DEFS[k].military !== true).sort()).toEqual([
      'haulerMk2',
      'haulerMk3',
      'transportShipMk2',
      'transportShipMk3',
    ]);
  });

  it('every variant def carries variantOf + variantTier, pointing at a base kind', () => {
    for (const v of getVariantKinds()) {
      const def = UNIT_DEFS[v];
      expect(def.variantOf).toBeDefined();
      expect([2, 3]).toContain(def.variantTier);
      // The base is a real base kind (not itself a variant).
      expect(isVariant(def.variantOf!)).toBe(false);
      expect(UNIT_DEFS[def.variantOf!]).toBeDefined();
    }
  });

  it('every base has exactly one Mk II and one Mk III', () => {
    for (const base of VARIANT_BASES) {
      const line = variantLine(base);
      expect(line).toHaveLength(3);
      const [l0, l1, l2] = line;
      if (!l0 || !l1 || !l2) throw new Error(`variant line incomplete for ${base}`);
      expect(l0).toBe(base);
      expect(variantTierOf(l1)).toBe(2);
      expect(variantTierOf(l2)).toBe(3);
      expect(variantBaseOf(l1)).toBe(base);
      expect(variantBaseOf(l2)).toBe(base);
    }
  });

  it('helper consistency: isVariant / variantBaseOf / variantTierOf / variantArtBase', () => {
    for (const k of Object.keys(UNIT_DEFS) as UnitKind[]) {
      expect(isVariant(k)).toBe(getVariantKinds().includes(k as VariantUnitKind));
      expect(variantTierOf(k)).toBe(isVariant(k) ? UNIT_DEFS[k].variantTier : 1);
      // Art sharing: a variant renders with its base kind's art.
      expect(variantArtBase(k)).toBe(isVariant(k) ? variantBaseOf(k) : k);
    }
    // Unknown kinds pass through unchanged (the render fallback's contract).
    expect(variantBaseOf('definitely-not-a-kind' as UnitKind)).toBe('definitely-not-a-kind');
  });

  it('variant defs keep the base domain and role (no domain drift)', () => {
    for (const v of getVariantKinds()) {
      const def = UNIT_DEFS[v];
      const base = UNIT_DEFS[variantBaseOf(v)];
      expect(def.domain).toBe(base.domain);
      expect(def.targets).toBe(base.targets);
    }
  });
});

// ---------------------------------------------------------------------------
// Stat progression — variants must be real upgrades, never placebo reskins
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tradeoffs (M15, 2026-10-01) — Mk II/III are genuine tactical choices,
// NOT stat ladders: every variant is better at something and worse at
// something, so the base kind stays situationally right. The full
// design table lives in docs/research/mk-variants.md.
// ---------------------------------------------------------------------------

describe('variant tradeoffs (M15: no stat ladders)', () => {
  /** Stats where a LOWER number is a regression. */
  const WORSE_IS_LOWER: (keyof UnitDef)[] = ['hp', 'speed', 'damage', 'range', 'sight'];
  /** Stats where a HIGHER number is a regression. */
  const WORSE_IS_HIGHER: (keyof UnitDef)[] = ['cooldownTicks', 'minRange', 'fuelPerSecond'];

  function num(def: UnitDef, key: keyof UnitDef): number {
    return (def[key] as number | undefined) ?? 0;
  }

  /** Stats on which `variant` is strictly worse than `base`. */
  function regressions(variant: UnitDef, base: UnitDef): string[] {
    const out: string[] = [];
    for (const k of WORSE_IS_LOWER) if (num(variant, k) < num(base, k)) out.push(k);
    for (const k of WORSE_IS_HIGHER) if (num(variant, k) > num(base, k)) out.push(k);
    return out;
  }

  /** Stats on which `variant` is strictly better than `base`. */
  function improvements(variant: UnitDef, base: UnitDef): string[] {
    const out: string[] = [];
    for (const k of WORSE_IS_LOWER) if (num(variant, k) > num(base, k)) out.push(k);
    for (const k of WORSE_IS_HIGHER) if (num(variant, k) < num(base, k)) out.push(k);
    // vs-multipliers and cargo/ammo capacity count as improvements too.
    for (const k of ['vsLight', 'vsMedium', 'vsHeavy', 'vsAir', 'cargoFuelCapacity', 'cargoAmmoCapacity', 'ammoCapacity'] as (keyof UnitDef)[]) {
      if (num(variant, k) > num(base, k)) out.push(k);
    }
    return out;
  }

  it('every variant regresses on ≥1 combat stat vs its base (no strict upgrades)', () => {
    for (const v of getVariantKinds()) {
      const def = UNIT_DEFS[v];
      const base = UNIT_DEFS[variantBaseOf(v)];
      expect(
        regressions(def, base),
        `${v} must trade something off vs ${variantBaseOf(v)}`,
      ).not.toHaveLength(0);
    }
  });

  it('every variant improves on ≥1 stat vs its base (no strict downgrades)', () => {
    for (const v of getVariantKinds()) {
      const def = UNIT_DEFS[v];
      const base = UNIT_DEFS[variantBaseOf(v)];
      expect(
        improvements(def, base),
        `${v} must be better at something than ${variantBaseOf(v)}`,
      ).not.toHaveLength(0);
    }
  });

  it('every Mk III differs from its Mk II on ≥1 stat (no reskins)', () => {
    for (const base of VARIANT_BASES) {
      const [, mk2, mk3] = lineDefs(base);
      const all = [...WORSE_IS_LOWER, ...WORSE_IS_HIGHER];
      const diffs = all.filter((k) => num(mk3, k) !== num(mk2, k));
      expect(diffs, `${base} Mk III must differ from Mk II`).not.toHaveLength(0);
    }
  });

  it('every Mk III also trades off vs its Mk II (the ladder stays broken at the top)', () => {
    for (const base of VARIANT_BASES) {
      const [, mk2, mk3] = lineDefs(base);
      // BOTH directions: the Mk III is worse at something AND better
      // at something than the Mk II — never a strict upgrade.
      expect(regressions(mk3, mk2), `${base} Mk III must regress vs Mk II`).not.toHaveLength(0);
      expect(regressions(mk2, mk3), `${base} Mk III must improve vs Mk II`).not.toHaveLength(0);
    }
  });

  // The defining tradeoff stat of each variant, pinned: the number
  // that makes the role what it is (docs/research/mk-variants.md §2).
  it('pins the defining tradeoff stat of all 28 variants', () => {
    const pins: [VariantUnitKind, keyof UnitDef, number][] = [
      ['tankMk2', 'speed', 8],
      ['tankMk3', 'speed', 7],
      ['tankMk3', 'range', 23],
      ['artilleryMk2', 'minRange', 16],
      ['artilleryMk2', 'range', 56],
      ['artilleryMk3', 'hp', 120],
      ['artilleryMk3', 'damage', 150],
      ['aaMk2', 'speed', 8],
      ['aaMk2', 'vsAir', 2.6],
      ['aaMk3', 'minRange', 6],
      ['aaMk3', 'ammoCapacity', 12],
      ['apcMk2', 'damage', 30],
      ['apcMk2', 'speed', 10],
      ['apcMk3', 'sight', 36],
      ['apcMk3', 'damage', 12],
      ['haulerMk2', 'speed', 7],
      ['haulerMk2', 'cargoFuelCapacity', 80],
      ['haulerMk3', 'speed', 12],
      ['haulerMk3', 'fuelPerSecond', 0.15],
      ['fighterMk2', 'speed', 31],
      ['fighterMk2', 'damage', 28],
      ['fighterMk3', 'speed', 24],
      ['fighterMk3', 'damage', 45],
      ['fighterBomberMk2', 'damage', 160],
      ['fighterBomberMk2', 'speed', 24],
      ['fighterBomberMk3', 'speed', 33],
      ['fighterBomberMk3', 'hp', 160],
      ['attackHeliMk2', 'vsHeavy', 2.0],
      ['attackHeliMk2', 'speed', 26],
      ['attackHeliMk3', 'speed', 35],
      ['attackHeliMk3', 'hp', 130],
      ['gunshipMk2', 'speed', 18],
      ['gunshipMk2', 'minRange', 4],
      ['gunshipMk3', 'cooldownTicks', 45],
      ['gunshipMk3', 'range', 18],
      ['destroyerMk2', 'vsAir', 2.6],
      ['destroyerMk2', 'vsHeavy', 0.7],
      ['destroyerMk3', 'range', 32],
      ['destroyerMk3', 'ammoCapacity', 20],
      ['frigateMk2', 'vsMedium', 2.0],
      ['frigateMk2', 'damage', 26],
      ['frigateMk3', 'speed', 17],
      ['frigateMk3', 'hp', 360],
      ['submarineMk2', 'speed', 13],
      ['submarineMk2', 'hp', 260],
      ['submarineMk3', 'damage', 140],
      ['submarineMk3', 'range', 36],
      ['submarineMk3', 'speed', 9],
      ['missileBoatMk2', 'damage', 100],
      ['missileBoatMk2', 'speed', 16],
      ['missileBoatMk3', 'speed', 24],
      ['missileBoatMk3', 'ammoCapacity', 8],
      ['transportShipMk2', 'hp', 520],
      ['transportShipMk2', 'speed', 8],
      ['transportShipMk3', 'cargoFuelCapacity', 200],
      ['transportShipMk3', 'cargoAmmoCapacity', 60],
      ['transportShipMk3', 'sight', 20],
    ];
    for (const [kind, key, expected] of pins) {
      expect((UNIT_DEFS[kind][key] as number | undefined) ?? 0, `${kind}.${key}`).toBe(expected);
    }
  });

  it('transportShipMk3 is a supply unit (the mobile sea depot role)', () => {
    const def = UNIT_DEFS['transportShipMk3'];
    expect((def.cargoFuelCapacity ?? 0) + (def.cargoAmmoCapacity ?? 0)).toBeGreaterThan(0);
    // …and the Mk II is NOT (it is the survivable hauler).
    expect(UNIT_DEFS['transportShipMk2'].cargoFuelCapacity ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cost scaling
// ---------------------------------------------------------------------------

describe('variant cost scaling', () => {
  it('Mk II costs ≈×1.6 and Mk III ≈×2.5 the base funds/materials', () => {
    for (const base of VARIANT_BASES) {
      const [b, mk2, mk3] = lineDefs(base);
      expect(mk2.trainFunds).toBeGreaterThanOrEqual(Math.floor(b.trainFunds * 1.5));
      expect(mk2.trainMaterials).toBeGreaterThanOrEqual(Math.floor(b.trainMaterials * 1.5));
      expect(mk3.trainFunds).toBeGreaterThanOrEqual(Math.floor(b.trainFunds * 2.4));
      expect(mk3.trainMaterials).toBeGreaterThanOrEqual(Math.floor(b.trainMaterials * 2.4));
    }
  });

  it('manpower cost never decreases across tiers', () => {
    for (const base of VARIANT_BASES) {
      const [b, mk2, mk3] = lineDefs(base);
      expect(mk2.manpowerCost).toBeGreaterThanOrEqual(b.manpowerCost);
      expect(mk3.manpowerCost).toBeGreaterThanOrEqual(mk2.manpowerCost);
    }
  });
});

// ---------------------------------------------------------------------------
// Gating — isVariantUnlocked mirrors the spawnUnit validator exactly
// ---------------------------------------------------------------------------

describe('variant gating', () => {
  /** One age step below a given age (foundation has no predecessor). */
  function prevAge(age: Age): Age {
    const i = AGE_ORDER.indexOf(age);
    return AGE_ORDER[Math.max(0, i - 1)] as Age;
  }

  it.each([
    ['tankMk2', 'warFactory'],
    ['tankMk3', 'warFactory'],
    ['artilleryMk3', 'warFactory'],
    ['fighterMk2', 'airfield'],
    ['fighterBomberMk3', 'airfield'],
    ['attackHeliMk2', 'airfield'],
    ['gunshipMk3', 'airfield'],
    ['destroyerMk2', 'navalYard'],
    ['frigateMk3', 'navalYard'],
    ['submarineMk2', 'navalYard'],
    ['missileBoatMk3', 'shipyard'],
    ['haulerMk2', undefined],
    ['haulerMk3', undefined],
    ['transportShipMk2', undefined],
    ['transportShipMk3', undefined],
  ] as Array<[VariantUnitKind, string | undefined]>)(
    '%s: locked below minAge, locked without %s, unlocked with both',
    (variant, requiredBuilding) => {
      const def = UNIT_DEFS[variant];
      const ctx = setup();
      const { x, z } = spawnPointFor(ctx, variant);

      // Below minAge: the gate is shut even with the building present.
      getAgeState(ctx.world, 0).age = prevAge(def.minAge);
      if (requiredBuilding) {
        completeBuilding(ctx.world, requiredBuilding as BuildingKind, 0);
      }
      expect(isVariantUnlocked(ctx.world, 0, variant)).toBe(false);
      const tooEarly = rejectionReason(ctx, 'spawnUnit', { kind: variant, owner: 0, x, z });
      expect(tooEarly).toMatch(/age/i);

      // Right age but no production building: still shut (when one is required).
      const ctx2 = setup();
      getAgeState(ctx2.world, 0).age = def.minAge;
      const p2 = spawnPointFor(ctx2, variant);
      if (requiredBuilding) {
        expect(isVariantUnlocked(ctx2.world, 0, variant)).toBe(false);
        const noBuilding = rejectionReason(ctx2, 'spawnUnit', { kind: variant, owner: 0, x: p2.x, z: p2.z });
        expect(noBuilding).toMatch(/war factory|airfield|naval yard|shipyard|barracks|production/i);
      }

      // Both satisfied: unlocked, and the command enqueues cleanly.
      const ctx3 = setup();
      getAgeState(ctx3.world, 0).age = def.minAge;
      if (requiredBuilding) {
        completeBuilding(ctx3.world, requiredBuilding as BuildingKind, 0);
      }
      expect(isVariantUnlocked(ctx3.world, 0, variant)).toBe(true);
      const p3 = spawnPointFor(ctx3, variant);
      expect(rejectionReason(ctx3, 'spawnUnit', { kind: variant, owner: 0, x: p3.x, z: p3.z })).toBeNull();
    },
  );

  it('isVariantUnlocked stays valid for base kinds (trainable = unlocked)', () => {
    const ctx = setup();
    // tank at foundation with a warFactory is trainable.
    completeBuilding(ctx.world, 'warFactory', 0);
    expect(isVariantUnlocked(ctx.world, 0, 'tank')).toBe(true);
    // …but not without its production building.
    const ctx2 = setup();
    expect(isVariantUnlocked(ctx2.world, 0, 'tank')).toBe(false);
  });

  it('Mk III needs a later age than Mk II of the same line', () => {
    for (const base of VARIANT_BASES) {
      const [, mk2, mk3] = lineDefs(base);
      expect(AGE_ORDER.indexOf(mk3.minAge)).toBeGreaterThan(AGE_ORDER.indexOf(mk2.minAge));
      expect(AGE_ORDER.indexOf(mk2.minAge)).toBeGreaterThanOrEqual(AGE_ORDER.indexOf(UNIT_DEFS[base].minAge));
    }
  });
});

// ---------------------------------------------------------------------------
// preferHighestVariant — the AI's substitution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// chooseVariant — the AI's situational substitution (M15)
// ---------------------------------------------------------------------------

describe('chooseVariant', () => {
  function unlockedCtx(): Ctx {
    const ctx = setup();
    getAgeState(ctx.world, 0).age = 'ascendance';
    completeBuilding(ctx.world, 'warFactory', 0);
    completeBuilding(ctx.world, 'airfield', 0);
    completeBuilding(ctx.world, 'navalYard', 0);
    return ctx;
  }

  it('returns the base kind unchanged when nothing higher is unlocked', () => {
    const ctx = setup(); // foundation, no buildings
    expect(chooseVariant(ctx.world, 0, 'tank')).toBe('tank');
  });

  it('returns the input kind unchanged for kinds without variants', () => {
    const ctx = unlockedCtx();
    expect(chooseVariant(ctx.world, 0, 'rifles')).toBe('rifles');
    expect(chooseVariant(ctx.world, 0, 'infantry' as UnitKind)).toBe('infantry');
  });

  it('rich owners take the top affordable tier', () => {
    const ctx = unlockedCtx();
    const p = ctx.world.city.players[0]!;
    p.funds = VARIANT_RICH_FUNDS + 5000;
    p.materials = 10000;
    p.manpower = 10000;
    expect(chooseVariant(ctx.world, 0, 'tank')).toBe('tankMk3');
    expect(chooseVariant(ctx.world, 0, 'hauler')).toBe('haulerMk3');
  });

  it('poor owners take the best value/cost — not always the top tier', () => {
    const ctx = unlockedCtx();
    const p = ctx.world.city.players[0]!;
    // Tight but workable treasury: below VARIANT_RICH_FUNDS.
    p.funds = 4000;
    p.materials = 1500;
    p.manpower = 10000;
    // tank line: tankMk2 has the best combatValue/cost (assault gun is
    // cheap for what it brings; the railgun is overpriced per point).
    expect(chooseVariant(ctx.world, 0, 'tank')).toBe('tankMk2');
    // hauler line: the base hauler wins on logistics value per cost —
    // the AI buys cheap trucks when money is tight.
    expect(chooseVariant(ctx.world, 0, 'hauler')).toBe('hauler');
  });

  it('combatValueOf / valuePerCost rank the tank line Mk II > base > Mk III', () => {
    expect(valuePerCost('tankMk2')).toBeGreaterThan(valuePerCost('tank'));
    expect(valuePerCost('tank')).toBeGreaterThan(valuePerCost('tankMk3'));
    expect(combatValueOf('tankMk3')).toBeGreaterThan(combatValueOf('tankMk2'));
  });

  it('falls back when the higher tier is unaffordable', () => {
    const ctx = unlockedCtx();
    const p = ctx.world.city.players[0]!;
    // Enough for the base tank (400/60) but not the Mk II (640/100).
    p.funds = 500;
    p.materials = 80;
    p.manpower = 10000;
    expect(chooseVariant(ctx.world, 0, 'tank')).toBe('tank');
    // Mk II affordable (640/100) but not Mk III (1050/160).
    p.funds = 700;
    p.materials = 120;
    expect(chooseVariant(ctx.world, 0, 'tank')).toBe('tankMk2');
  });

  it('the per-think ledger reservations count against affordability', () => {
    const ctx = unlockedCtx();
    const p = ctx.world.city.players[0]!;
    p.funds = 1200;
    p.materials = 200;
    p.manpower = 10000;
    expect(chooseVariant(ctx.world, 0, 'tank')).toBe('tankMk2');
    // 700 funds already reserved this think → Mk II (640) no longer
    // fits, only the base tank does.
    expect(chooseVariant(ctx.world, 0, 'tank', { funds: 700, materials: 0, manpower: 0 })).toBe('tank');
  });

  it('never downgrades below the input tier', () => {
    const ctx = unlockedCtx();
    const p = ctx.world.city.players[0]!;
    p.funds = VARIANT_RICH_FUNDS + 5000;
    p.materials = 10000;
    p.manpower = 10000;
    // Asking for Mk II directly keeps at least Mk II (here Mk III wins).
    expect(chooseVariant(ctx.world, 0, 'tankMk2')).toBe('tankMk3');
    // With Mk III age-locked, an explicit Mk II request stays Mk II.
    getAgeState(ctx.world, 0).age = 'industry';
    expect(chooseVariant(ctx.world, 0, 'tankMk2')).toBe('tankMk2');
  });

  it('is deterministic: same state ⇒ same answer', () => {
    const a = unlockedCtx();
    const b = unlockedCtx();
    expect(chooseVariant(a.world, 0, 'fighter')).toBe(chooseVariant(b.world, 0, 'fighter'));
  });
});

// ---------------------------------------------------------------------------
// AI substitution — the Classic AI actually trains the variants
// ---------------------------------------------------------------------------

describe('AI variant substitution', () => {
  it('a citizen AI with warFactory + industry age trains tankMk2 (not plain tanks)', () => {
    const terrain = getTerrain();
    const world = createWorld(20260930);
    grantAllTrainingResources(world);
    for (const p of world.city.players) {
      completeBuilding(world, 'barracks', p.id);
      completeBuilding(world, 'warFactory', p.id);
    }
    getAgeState(world, 1).age = 'industry'; // tankMk2 unlocked for the citizen AI (owner 1); tankMk3 (information) not
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerMovementCommands(queue, terrain);
    registerCombatCommands(queue);
    const driver = createTickDriver({
      queue,
      systems: [
        createPathfindingSystem(terrain),
        createMovementSystem(terrain),
        createCombatSystem(),
        createAISystem(queue),
      ],
    });
    // AI base on the nearest land to (-100, -100).
    let bx = -100;
    let bz = -100;
    outer: for (let r = 0; r < 60; r += 2) {
      for (let dz = -r; dz <= r; dz += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!isWater(terrain, bx + dx, bz + dz)) {
            bx += dx;
            bz += dz;
            break outer;
          }
        }
      }
    }
    addAIPlayer(world, 1, 'citizen', bx, bz);
    // Citizen thinks every 120 ticks and trains one unit per think; give it
    // 12 thinks (its army mix includes tanks, and Mk II is unlocked).
    for (let i = 0; i < AI_THINK_TICKS.citizen * 12 + 2; i++) driver.step(world, TICK_MS);
    const ai = world.ai.players[0]!;
    expect(ai.builtCounts['tankMk2'] ?? 0).toBeGreaterThan(0);
    expect(ai.builtCounts['tank'] ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Peaceful mode — military variants locked out, civilian variants trainable
// ---------------------------------------------------------------------------

describe('variant peaceful lockout', () => {
  function peacefulCtx(): Ctx {
    const ctx = setup();
    ctx.world.peaceful = true;
    getAgeState(ctx.world, 0).age = 'ascendance';
    completeBuilding(ctx.world, 'warFactory', 0);
    completeBuilding(ctx.world, 'airfield', 0);
    completeBuilding(ctx.world, 'navalYard', 0);
    return ctx;
  }

  it('rejects all 24 military variants loudly in a peaceful world', () => {
    const ctx = peacefulCtx();
    for (const v of MILITARY_VARIANTS) {
      const { x, z } = spawnPointFor(ctx, v);
      const reason = rejectionReason(ctx, 'spawnUnit', { kind: v, owner: 0, x, z });
      expect(reason).toMatch(/peaceful mode/);
      expect(isVariantUnlocked(ctx.world, 0, v)).toBe(false);
    }
  });

  it('still trains the civilian variants in a peaceful world (the tech path)', () => {
    const ctx = peacefulCtx();
    for (const v of ['haulerMk2', 'haulerMk3', 'transportShipMk2', 'transportShipMk3'] as const) {
      const { x, z } = spawnPointFor(ctx, v);
      expect(rejectionReason(ctx, 'spawnUnit', { kind: v, owner: 0, x, z })).toBeNull();
      expect(isVariantUnlocked(ctx.world, 0, v)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Save/load + digest determinism
// ---------------------------------------------------------------------------

describe('variant persistence', () => {
  it('variant records round-trip through snapshot/restore', () => {
    const ctx = setup();
    getAgeState(ctx.world, 0).age = 'information';
    completeBuilding(ctx.world, 'warFactory', 0);
    const { cx, cz } = findLandRect(ctx.terrain, 4, 4);
    const x = cellCenterWorld(cx);
    const z = cellCenterWorld(cz);
    enq(ctx, 'spawnUnit', { kind: 'tankMk2', owner: 0, x, z });
    enq(ctx, 'spawnUnit', { kind: 'haulerMk3', owner: 0, x: x + 8, z });
    // Apply the queued commands at the current tick.
    ctx.queue.applyDue(ctx.world, ctx.world.tick);
    const restored = restoreSnapshot(takeSnapshot(ctx.world));
    const kinds = restored.units.map((u) => u.kind).sort();
    expect(kinds).toEqual(['haulerMk3', 'tankMk2']);
    // Variant def stats ride along (hp comes from the def, not the record).
    const tank = restored.units.find((u) => u.kind === 'tankMk2')!;
    expect(tank.hp).toBe(UNIT_DEFS['tankMk2'].hp);
  });

  it('same seed + same variant commands ⇒ identical digest', () => {
    const script = (seed: number): number => {
      const ctx = setup(seed);
      getAgeState(ctx.world, 0).age = 'information';
      completeBuilding(ctx.world, 'warFactory', 0);
      const { cx, cz } = findLandRect(ctx.terrain, 4, 4);
      const x = cellCenterWorld(cx);
      const z = cellCenterWorld(cz);
      enq(ctx, 'spawnUnit', { kind: 'tankMk2', owner: 0, x, z });
      enq(ctx, 'spawnUnit', { kind: 'tankMk3', owner: 0, x: x + 8, z });
      ctx.queue.applyDue(ctx.world, ctx.world.tick);
      return digestWorld(ctx.world);
    };
    expect(script(777)).toBe(script(777));
  });
});

// ---------------------------------------------------------------------------
// Art sharing (§AD12) — variants resolve to the base kind's art entry:
// zero new MODEL_PATHS keys, and the base hull footprint for selection
// rings / stripe scaling.
// ---------------------------------------------------------------------------

describe('variant art sharing (§AD12)', () => {
  it('modelSourceFor(variant) deep-equals modelSourceFor(base)', () => {
    for (const v of getVariantKinds()) {
      const base = variantBaseOf(v);
      expect(modelSourceFor(v)).toEqual(modelSourceFor(base));
      // …and it is a real source, never the placeholder.
      expect(['glb', 'procedural']).toContain(modelSourceFor(v).type);
    }
  });

  it('hullSizeFor(variant) equals hullSizeFor(base) (selection-ring sizing)', () => {
    for (const v of getVariantKinds()) {
      expect(hullSizeFor(v)).toEqual(hullSizeFor(variantBaseOf(v)));
    }
  });

  it('MODEL_PATHS gains zero variant keys (the §10 art budget)', () => {
    for (const key of Object.keys(MODEL_PATHS)) {
      expect(getVariantKinds()).not.toContain(key);
    }
    expect(getVariantKinds()).toHaveLength(28);
  });
});
