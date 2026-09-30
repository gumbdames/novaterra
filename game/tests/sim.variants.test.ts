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
 *    manpower never decreases.
 *  - Gating: `isVariantUnlocked` mirrors the spawnUnit validator
 *    exactly — locked without the age or the production building,
 *    unlocked with both (a data-driven matrix over representative
 *    variants); the peaceful lockout rejects military variants and
 *    still trains the civilian hauler/transportShip variants.
 *  - `preferHighestVariant`: highest unlocked + affordable tier wins;
 *    the per-think ledger reservations count; deterministic.
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
import { AGE_ORDER, type Age } from '../src/sim/ages';
import {
  getVariantKinds,
  isVariant,
  variantBaseOf,
  variantArtBase,
  variantTierOf,
  variantLine,
  isVariantUnlocked,
  preferHighestVariant,
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

describe('variant stat progression', () => {
  it('hp, damage and speed improve tier over tier for every variant', () => {
    for (const base of VARIANT_BASES) {
      const [b, mk2, mk3] = lineDefs(base);
      expect(mk2.hp).toBeGreaterThan(b.hp);
      expect(mk3.hp).toBeGreaterThan(mk2.hp);
      // Combat kinds hit harder each tier (hauler/transportShip deal no damage — the exception).
      if (b.damage > 0) {
        expect(mk2.damage).toBeGreaterThan(b.damage);
        expect(mk3.damage).toBeGreaterThan(mk2.damage);
      } else {
        expect(mk2.damage).toBe(0);
        expect(mk3.damage).toBe(0);
      }
      expect(mk2.speed).toBeGreaterThanOrEqual(b.speed);
      expect(mk3.speed).toBeGreaterThanOrEqual(mk2.speed);
    }
  });

  it('sight never regresses across tiers', () => {
    for (const base of VARIANT_BASES) {
      const [b, mk2, mk3] = lineDefs(base);
      expect(mk2.sight).toBeGreaterThanOrEqual(b.sight);
      expect(mk3.sight).toBeGreaterThanOrEqual(mk2.sight);
    }
  });

  it('hauler cargo holds grow each tier (the civilian payoff)', () => {
    const [b, mk2, mk3] = lineDefs('hauler');
    expect(mk2.cargoFuelCapacity).toBeGreaterThan(b.cargoFuelCapacity ?? 0);
    expect(mk3.cargoFuelCapacity).toBeGreaterThan(mk2.cargoFuelCapacity ?? 0);
    expect(mk2.cargoAmmoCapacity).toBeGreaterThan(b.cargoAmmoCapacity ?? 0);
    expect(mk3.cargoAmmoCapacity).toBeGreaterThan(mk2.cargoAmmoCapacity ?? 0);
  });

  it('transportShip variants gain legs each tier (fuel capacity — the troopship payoff)', () => {
    const [b, mk2, mk3] = lineDefs('transportShip');
    expect(mk2.fuelCapacity).toBeGreaterThan(b.fuelCapacity ?? 0);
    expect(mk3.fuelCapacity).toBeGreaterThan(mk2.fuelCapacity ?? 0);
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
      ctx.world.ages.age = prevAge(def.minAge);
      if (requiredBuilding) {
        completeBuilding(ctx.world, requiredBuilding as BuildingKind, 0);
      }
      expect(isVariantUnlocked(ctx.world, 0, variant)).toBe(false);
      const tooEarly = rejectionReason(ctx, 'spawnUnit', { kind: variant, owner: 0, x, z });
      expect(tooEarly).toMatch(/age/i);

      // Right age but no production building: still shut (when one is required).
      const ctx2 = setup();
      ctx2.world.ages.age = def.minAge;
      const p2 = spawnPointFor(ctx2, variant);
      if (requiredBuilding) {
        expect(isVariantUnlocked(ctx2.world, 0, variant)).toBe(false);
        const noBuilding = rejectionReason(ctx2, 'spawnUnit', { kind: variant, owner: 0, x: p2.x, z: p2.z });
        expect(noBuilding).toMatch(/war factory|airfield|naval yard|shipyard|barracks|production/i);
      }

      // Both satisfied: unlocked, and the command enqueues cleanly.
      const ctx3 = setup();
      ctx3.world.ages.age = def.minAge;
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

describe('preferHighestVariant', () => {
  function unlockedCtx(): Ctx {
    const ctx = setup();
    ctx.world.ages.age = 'ascendance';
    completeBuilding(ctx.world, 'warFactory', 0);
    completeBuilding(ctx.world, 'airfield', 0);
    completeBuilding(ctx.world, 'navalYard', 0);
    return ctx;
  }

  it('returns the base kind unchanged when nothing higher is unlocked', () => {
    const ctx = setup(); // foundation, no buildings
    expect(preferHighestVariant(ctx.world, 0, 'tank')).toBe('tank');
  });

  it('returns the input kind unchanged for kinds without variants', () => {
    const ctx = unlockedCtx();
    expect(preferHighestVariant(ctx.world, 0, 'rifles')).toBe('rifles');
    expect(preferHighestVariant(ctx.world, 0, 'infantry' as UnitKind)).toBe('infantry');
  });

  it('prefers Mk III when unlocked and affordable', () => {
    const ctx = unlockedCtx();
    expect(preferHighestVariant(ctx.world, 0, 'tank')).toBe('tankMk3');
  });

  it('falls back to Mk II when Mk III is age-locked', () => {
    const ctx = unlockedCtx();
    ctx.world.ages.age = 'industry'; // tankMk2 yes, tankMk3 (information) no
    expect(preferHighestVariant(ctx.world, 0, 'tank')).toBe('tankMk2');
  });

  it('falls back when the higher tier is unaffordable', () => {
    const ctx = unlockedCtx();
    const p = ctx.world.city.players[0]!;
    // Enough for Mk II (640/100) but not Mk III (1000/150).
    p.funds = 700;
    p.materials = 120;
    p.manpower = 10000;
    expect(preferHighestVariant(ctx.world, 0, 'tank')).toBe('tankMk2');
    // Not even Mk II affordable → the base kind.
    p.funds = 500;
    expect(preferHighestVariant(ctx.world, 0, 'tank')).toBe('tank');
  });

  it('the per-think ledger reservations count against affordability', () => {
    const ctx = unlockedCtx();
    const p = ctx.world.city.players[0]!;
    p.funds = 1200;
    p.materials = 200;
    p.manpower = 10000;
    expect(preferHighestVariant(ctx.world, 0, 'tank')).toBe('tankMk3');
    // 500 funds already reserved this think → Mk III (1000) no longer fits,
    // but Mk II (640) still does.
    expect(preferHighestVariant(ctx.world, 0, 'tank', { funds: 500, materials: 0, manpower: 0 })).toBe(
      'tankMk2',
    );
  });

  it('never downgrades below the input tier', () => {
    const ctx = unlockedCtx();
    // Asking for Mk II directly keeps at least Mk II (here Mk III wins).
    expect(preferHighestVariant(ctx.world, 0, 'tankMk2')).toBe('tankMk3');
    // With Mk III age-locked, an explicit Mk II request stays Mk II.
    ctx.world.ages.age = 'industry';
    expect(preferHighestVariant(ctx.world, 0, 'tankMk2')).toBe('tankMk2');
  });

  it('is deterministic: same state ⇒ same answer', () => {
    const a = unlockedCtx();
    const b = unlockedCtx();
    expect(preferHighestVariant(a.world, 0, 'fighter')).toBe(preferHighestVariant(b.world, 0, 'fighter'));
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
    world.ages.age = 'industry'; // tankMk2 unlocked; tankMk3 (information) not
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
    ctx.world.ages.age = 'ascendance';
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
    ctx.world.ages.age = 'information';
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
      ctx.world.ages.age = 'information';
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
