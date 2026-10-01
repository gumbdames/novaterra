/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * AI fairness tests (roadmap A2 + A6, 2026-10-01).
 *
 * A2: `getVisibleEnemyBuildings` was a maphack — it returned ALL
 * completed enemy buildings with zero sight filtering. Now it's gated
 * on real detection (sight discs), and `getKnownEnemyBuildings`
 * latches seen buildings (the AI doesn't forget when the scout leaves).
 *
 * A6: the counter table was blind to Mk II/III variants — `isCounterHeavy`
 * / `isCounterArty` now match the variant base kind.
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { placeBuilding, buildingCenterWorld } from '../src/sim/city';
import { spawnUnit } from '../src/sim/units';
import {
  addAIPlayer,
  getVisibleEnemyBuildings,
  getKnownEnemyBuildings,
  isCounterHeavy,
  isCounterArty,
} from '../src/sim/ai';

describe('A2: no maphack on enemy buildings', () => {
  it('returns empty when the AI has no sight on the building', () => {
    const world = createWorld(20261001);
    // Enemy building far from the AI's base.
    const b = placeBuilding(world.city, { kind: 'lab', owner: 0, cx: 10, cz: 10, facing: 0 });
    b.progress = 1;
    b.operational = true;
    // AI player with units far away (sight won't reach).
    addAIPlayer(world, 1, 'commander', 200, 200);
    spawnUnit(world, 'rifles', 1, 200, 200);
    const visible = getVisibleEnemyBuildings(world, 1);
    // The maphack is gone: the AI doesn't see the lab.
    expect(visible).toEqual([]);
  });

  it('sees the building when an AI unit is in range', () => {
    const world = createWorld(20261001);
    const b = placeBuilding(world.city, { kind: 'lab', owner: 0, cx: 10, cz: 10, facing: 0 });
    b.progress = 1;
    b.operational = true;
    addAIPlayer(world, 1, 'commander', 0, 0);
    // Spawn a scout right next to the building.
    const c = buildingCenterWorld(b);
    spawnUnit(world, 'reconTeam', 1, c.x + 5, c.z + 5);
    const visible = getVisibleEnemyBuildings(world, 1);
    expect(visible.map((x) => x.id)).toContain(b.id);
  });

  it('latches seen buildings in the intel picture', () => {
    const world = createWorld(20261001);
    const b = placeBuilding(world.city, { kind: 'lab', owner: 0, cx: 10, cz: 10, facing: 0 });
    b.progress = 1;
    b.operational = true;
    addAIPlayer(world, 1, 'commander', 0, 0);
    const ai = world.ai.players[0]!;
    const c = buildingCenterWorld(b);
    const scout = spawnUnit(world, 'reconTeam', 1, c.x + 5, c.z + 5);
    // Seen: latched.
    const known1 = getKnownEnemyBuildings(world, ai);
    expect(known1.map((x) => x.id)).toContain(b.id);
    expect(ai.seenBuildingIds).toContain(b.id);
    // Scout leaves (teleport far away): the AI remembers.
    scout.x = 500;
    scout.z = 500;
    expect(getVisibleEnemyBuildings(world, 1).map((x) => x.id)).not.toContain(b.id);
    expect(getKnownEnemyBuildings(world, ai).map((x) => x.id)).toContain(b.id);
  });

  it('forgets destroyed buildings', () => {
    const world = createWorld(20261001);
    const b = placeBuilding(world.city, { kind: 'lab', owner: 0, cx: 10, cz: 10, facing: 0 });
    b.progress = 1;
    b.operational = true;
    addAIPlayer(world, 1, 'commander', 0, 0);
    const ai = world.ai.players[0]!;
    const c = buildingCenterWorld(b);
    spawnUnit(world, 'reconTeam', 1, c.x + 5, c.z + 5);
    getKnownEnemyBuildings(world, ai);
    expect(ai.seenBuildingIds).toContain(b.id);
    // Building destroyed (removed from city).
    world.city.buildings = world.city.buildings.filter((x) => x.id !== b.id);
    const known = getKnownEnemyBuildings(world, ai);
    expect(known.map((x) => x.id)).not.toContain(b.id);
  });
});

describe('A6: variant-aware counters', () => {
  it('matches base tanks and their Mk variants', () => {
    expect(isCounterHeavy('tank')).toBe(true);
    expect(isCounterHeavy('tankMk2')).toBe(true);
    expect(isCounterHeavy('tankMk3')).toBe(true);
    expect(isCounterHeavy('tankDestroyer')).toBe(true);
    expect(isCounterHeavy('rifles')).toBe(false);
    expect(isCounterHeavy('artillery')).toBe(false);
  });

  it('matches base artillery and its variants', () => {
    expect(isCounterArty('artillery')).toBe(true);
    expect(isCounterArty('mlrs')).toBe(true);
    expect(isCounterArty('tank')).toBe(false);
    expect(isCounterArty('rifles')).toBe(false);
  });
});
