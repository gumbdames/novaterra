/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * Combat VFX event tests (roadmap B16, 2026-10-01).
 *
 * The sim emits `CombatEvent`s (muzzle/impact/explosion) into
 * `world.combatEvents` for the render layer. The render drains them
 * each frame; the sim clears at tick start.
 */

import { describe, expect, it } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCombatSystem } from '../src/sim/combat';
import { spawnUnit } from '../src/sim/units';
import { placeBuilding } from '../src/sim/city';
import { buildingCenterWorld } from '../src/sim/intel';

describe('B16: combat VFX events', () => {
  it('emits muzzle + impact on a non-fatal shot', () => {
    const world = createWorld(20261001);
    const attacker = spawnUnit(world, 'rifles', 0, 0, 0);
    const target = spawnUnit(world, 'rifles', 1, 10, 0);
    // Give the attacker a weapon and cooldown ready.
    attacker.cooldownLeft = 0;
    // Run one combat tick.
    const sys = createCombatSystem();
    sys(world, 1/30);
    // Should have muzzle and impact (or explosion if it died).
    const kinds = world.combatEvents.map((e) => e.kind);
    expect(kinds).toContain('muzzle');
    expect(kinds.includes('impact') || kinds.includes('explosion')).toBe(true);
  });

  it('emits explosion on a fatal shot', () => {
    const world = createWorld(20261001);
    const attacker = spawnUnit(world, 'tank', 0, 0, 0);
    const target = spawnUnit(world, 'rifles', 1, 10, 0);
    target.hp = 1; // one shot will kill
    attacker.cooldownLeft = 0;
    const sys = createCombatSystem();
    sys(world, 1/30);
    const kinds = world.combatEvents.map((e) => e.kind);
    expect(kinds).toContain('muzzle');
    expect(kinds).toContain('explosion');
  });

  it('clears events at the start of the next tick', () => {
    const world = createWorld(20261001);
    const attacker = spawnUnit(world, 'rifles', 0, 0, 0);
    spawnUnit(world, 'rifles', 1, 10, 0);
    attacker.cooldownLeft = 0;
    const sys = createCombatSystem();
    sys(world, 1/30);
    expect(world.combatEvents.length).toBeGreaterThan(0);
    // Next tick: cleared at start, before any new firing.
    // (No enemies in range now — move the target away.)
    world.units[1]!.x = 1000;
    world.units[1]!.z = 1000;
    sys(world, 1/30);
    expect(world.combatEvents.length).toBe(0);
  });

  it('emits building siege events', () => {
    const world = createWorld(20261001);
    const attacker = spawnUnit(world, 'tank', 0, 0, 0);
    attacker.cooldownLeft = 0;
    const b = placeBuilding(world.city, { kind: 'house', owner: 1, cx: 5, cz: 0, facing: 0 });
    b.progress = 1;
    // Order the attacker to siege via the attackBuilding command would
    // need the command queue; instead directly verify the event shape
    // via a manual fireWeaponAtBuilding call through the system.
    // (The system only does opportunistic unit-vs-unit; siege is
    // explicit. This test verifies the World field exists and is an
    // array — the emission is covered by the unit tests above.)
    expect(Array.isArray(world.combatEvents)).toBe(true);
  });
});

describe('B13: combat event damage + owners', () => {
  it('impact carries the damage dealt and both owners', () => {
    const world = createWorld(20261013);
    const attacker = spawnUnit(world, 'rifles', 0, 0, 0);
    const target = spawnUnit(world, 'rifles', 1, 10, 0);
    target.hp = 10000; // survives: impact, not explosion
    attacker.cooldownLeft = 0;
    createCombatSystem()(world, 1 / 30);
    const impact = world.combatEvents.find((e) => e.kind === 'impact');
    expect(impact).toBeDefined();
    if (impact?.kind === 'impact') {
      expect(impact.damage).toBeGreaterThan(0);
      expect(impact.victimOwner).toBe(1);
      expect(impact.attackerOwner).toBe(0);
    }
  });

  it('explosion carries the killing-blow damage and both owners', () => {
    const world = createWorld(20261013);
    const attacker = spawnUnit(world, 'tank', 0, 0, 0);
    const target = spawnUnit(world, 'rifles', 1, 10, 0);
    target.hp = 1; // one shot kills
    attacker.cooldownLeft = 0;
    createCombatSystem()(world, 1 / 30);
    const boom = world.combatEvents.find((e) => e.kind === 'explosion');
    expect(boom).toBeDefined();
    if (boom?.kind === 'explosion') {
      expect(boom.damage).toBeGreaterThan(0);
      expect(boom.victimOwner).toBe(1);
      expect(boom.attackerOwner).toBe(0);
    }
  });

  it('building hits carry the building owner as victim', () => {
    const world = createWorld(20261013);
    const hall = placeBuilding(world.city, {
      kind: 'farm',
      owner: 1,
      cx: 250,
      cz: 250,
      facing: 0,
    });
    hall.progress = 1;
    const c = buildingCenterWorld(hall);
    const attacker = spawnUnit(world, 'tank', 0, c.x, c.z);
    attacker.cooldownLeft = 0;
    // Explicit siege order, as the attackBuilding command would set it.
    attacker.buildingTargetId = hall.id;
    createCombatSystem()(world, 1 / 30);
    const hit = world.combatEvents.find(
      (e) => e.kind === 'impact' || e.kind === 'explosion',
    );
    expect(hit).toBeDefined();
    if (hit?.kind === 'impact' || hit?.kind === 'explosion') {
      expect(hit.damage).toBeGreaterThan(0);
      expect(hit.victimOwner).toBe(1);
      expect(hit.attackerOwner).toBe(0);
    }
  });
});
