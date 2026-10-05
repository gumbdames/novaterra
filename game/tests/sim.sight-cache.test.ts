/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This file is part of NOVATERRA. NOVATERRA is free software: you can
 * redistribute it and/or modify it under the terms of the GNU Affero General
 * Public License as published by the Free Software Foundation, either version
 * 3 of the License, or (at your option) any later version.
 *
 * NOVATERRA is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * NOVATERRA — tests/sim.sight-cache.test.ts — final-review R3 L7:
 * the `intelSightBonus` building-term cache stays correct.
 *
 * The cache (upgrades.ts, keyed per world, validated by the buildings
 * array identity + an explicit version) must return the same values
 * the old full scan returned, across every mutation path:
 *  - direct fixture pushes (array identity/length validation),
 *  - demolishBuilding (the bump in city.ts — also covers
 *    destroyBuilding, the combat/storm path),
 *  - construction completion inside runEconomyTick (the bump in
 *    runConstruction, economy.ts),
 *  - direct `b.progress` writes (the documented contract: fixtures
 *    must call `bumpSightBonusCache` themselves),
 *  - the signalsIntel upgrade term composes with the cached term
 *    (it is deliberately uncached — hasUpgrade scans a tiny list).
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import type { World } from '../src/sim/world';
import {
  bumpSightBonusCache,
  buildingCenterWorld,
  demolishBuilding,
  placeBuilding,
  type BuildingRecord,
} from '../src/sim/city';
import { effectiveSight, intelSightBonus, SIGNALS_INTEL_SIGHT_BONUS } from '../src/sim/upgrades';
import { UNIT_DEFS, spawnUnit, type UnitKind } from '../src/sim/units';
import { setDoctrine } from '../src/sim/doctrine';
import { addIntelAsset, isSabotaged, registerIntelCommands } from '../src/sim/intel';
import { createCommandQueue } from '../src/sim/commands';
import { completeBuilding } from './sim.roster-fixtures';
import { runEconomyTick } from '../src/sim/economy';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';

let cachedTerrain: TerrainData | null = null;
function terrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

const UPLINK_BONUS = 12; // BUILDING_DEFS.satelliteUplink.sightBonus

describe('intelSightBonus cache (R3 L7)', () => {
  it('starts at 0 and is idempotent', () => {
    const world = createWorld(1);
    expect(intelSightBonus(world, 0)).toBe(0);
    expect(intelSightBonus(world, 0)).toBe(0);
    expect(intelSightBonus(world, 1)).toBe(0);
  });

  it('sees a completed satelliteUplink pushed by a fixture', () => {
    const world = createWorld(2);
    expect(intelSightBonus(world, 0)).toBe(0); // populate the cache
    completeBuilding(world, 'satelliteUplink', 0, 10, 10);
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS);
    // Other owners are unaffected; repeated reads are stable.
    expect(intelSightBonus(world, 1)).toBe(0);
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS);
  });

  it('demolishBuilding invalidates the cache', () => {
    const world = createWorld(3);
    completeBuilding(world, 'satelliteUplink', 0, 10, 10);
    const b = world.city.buildings[world.city.buildings.length - 1]!;
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS);
    expect(demolishBuilding(world.city, b.id)).toBe(true);
    expect(intelSightBonus(world, 0)).toBe(0);
  });

  it('construction completion inside runEconomyTick invalidates the cache', () => {
    const world = createWorld(4);
    const t = terrain();
    // Real placement path: progress starts at 0.
    const b = placeBuilding(world.city, {
      kind: 'satelliteUplink',
      owner: 0,
      cx: 20,
      cz: 20,
      facing: 0,
    });
    expect(b.progress).toBe(0);
    expect(intelSightBonus(world, 0)).toBe(0); // populate the cache
    // Fast-forward construction without waiting out buildSeconds:
    // one tick from 0.999 crosses to 1 through runConstruction.
    b.progress = 0.999;
    world.tick = 30;
    runEconomyTick(world, t);
    expect(b.progress).toBe(1);
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS);
  });

  it('direct progress writes need an explicit bump (documented contract)', () => {
    const world = createWorld(5);
    const b = placeBuilding(world.city, {
      kind: 'satelliteUplink',
      owner: 0,
      cx: 20,
      cz: 20,
      facing: 0,
    });
    expect(intelSightBonus(world, 0)).toBe(0); // populate the cache
    b.progress = 1; // direct write, bypassing runConstruction
    bumpSightBonusCache(world.city);
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS);
  });

  it('the signalsIntel upgrade term composes with the cached building term', () => {
    const world = createWorld(6);
    completeBuilding(world, 'satelliteUplink', 0, 10, 10);
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS); // populate
    world.upgrades[0] = ['signalsIntel'];
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS + SIGNALS_INTEL_SIGHT_BONUS);
    // The upgrade term is per-owner.
    expect(intelSightBonus(world, 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bug A (2026-10-05): sabotaged buildings grant no sight bonus
// ---------------------------------------------------------------------------

describe('intelSightBonus sabotage (Bug A)', () => {
  function uplinkWorld(seed: number): { world: World; b: BuildingRecord } {
    const world = createWorld(seed);
    completeBuilding(world, 'satelliteUplink', 0, 10, 10);
    const b = world.city.buildings[world.city.buildings.length - 1];
    if (!b) throw new Error('completeBuilding placed no building');
    return { world, b };
  }

  it('a sabotaged satelliteUplink contributes no bonus', () => {
    const { world, b } = uplinkWorld(11);
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS); // populate the cache
    b.sabotagedUntil = world.tick + 1000;
    bumpSightBonusCache(world.city); // the sabotage apply does this
    expect(intelSightBonus(world, 0)).toBe(0);
  });

  it('effectiveSight drops by the uplink bonus while sabotaged', () => {
    const { world, b } = uplinkWorld(12);
    setDoctrine(world, 0, 'kestrel'); // base sight (Republic multiplies by 1.2)
    const def = UNIT_DEFS['rifles' as UnitKind];
    const base = effectiveSight(world, 0, def);
    b.sabotagedUntil = world.tick + 1000;
    bumpSightBonusCache(world.city);
    expect(effectiveSight(world, 0, def)).toBe(base - UPLINK_BONUS);
  });

  it('same-tick sabotage after a cache hit needs the apply bump', () => {
    const { world, b } = uplinkWorld(13);
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS); // populate at this tick
    // Sabotage within the SAME tick: without the bump the cache stays
    // stale (this pins why the sabotage apply bumps explicitly)…
    b.sabotagedUntil = world.tick + 1000;
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS);
    // …and with the bump it is fresh immediately, no tick wait.
    bumpSightBonusCache(world.city);
    expect(intelSightBonus(world, 0)).toBe(0);
  });

  it('the bonus returns when the sabotage expires — tick-validated, no bump needed', () => {
    const { world, b } = uplinkWorld(14);
    b.sabotagedUntil = world.tick + 10;
    bumpSightBonusCache(world.city);
    expect(intelSightBonus(world, 0)).toBe(0);
    // Expiry is silent (no bump fires). The next tick recomputes
    // anyway — the entry is tick-validated.
    world.tick += 11;
    expect(intelSightBonus(world, 0)).toBe(UPLINK_BONUS);
  });

  it('end to end: the real sabotage apply drops the bonus the same tick', () => {
    const world = createWorld(15);
    completeBuilding(world, 'satelliteUplink', 1, 20, 20);
    const target = world.city.buildings[world.city.buildings.length - 1];
    if (!target) throw new Error('completeBuilding placed no building');
    expect(intelSightBonus(world, 1)).toBe(UPLINK_BONUS); // populate the cache
    const queue = createCommandQueue();
    registerIntelCommands(queue);
    // A spy of owner 0 standing on the uplink, with assets to burn.
    const c = buildingCenterWorld(target);
    const spy = spawnUnit(world, 'spy', 0, c.x, c.z);
    addIntelAsset(world, 0, 'operational', 100);
    queue.enqueue(world, {
      issuer: 'player',
      kind: 'sabotage',
      payload: { unitId: spy.id, buildingId: target.id, owner: 0 },
    });
    queue.applyDue(world, world.tick);
    expect(isSabotaged(target, world.tick)).toBe(true);
    // The apply bumped the cache: no stale +12, same tick.
    expect(intelSightBonus(world, 1)).toBe(0);
  });
});
