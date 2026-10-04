import { describe, it, expect } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createCommandQueue, registerCoreCommands } from '../src/sim/commands';
import { registerMovementCommands } from '../src/sim/movement';
import { registerUnitCommands, spawnUnit } from '../src/sim/units';
import { registerCombatCommands, createCombatSystem } from '../src/sim/combat';
import { generateTerrain } from '../src/sim/terrain';
import { buildAttackMoveOrder } from '../src/ui/orders';

describe('attackMove command', () => {
  it('registers and executes attackMove command', () => {
    const world = createWorld(123);
    const terrain = generateTerrain(123);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerMovementCommands(queue, terrain);
    registerCombatCommands(queue, terrain);

    const friendly = spawnUnit(world, 'tank', 0, 10, 10);

    const intent = buildAttackMoveOrder(0, [friendly.id], 50, 50);
    queue.enqueue(world, { ...intent, issuer: 'player' });
    queue.applyDue(world, world.tick);

    expect(friendly.attackMoving).toBe(true);
    expect(friendly.attackMoveDestX).toBe(50);
    expect(friendly.attackMoveDestZ).toBe(50);
    expect(friendly.destX).toBe(50);
    expect(friendly.destZ).toBe(50);
  });

  it('engages hostiles along the way and halts for combat', () => {
    const world = createWorld(456);
    const terrain = generateTerrain(456);
    const queue = createCommandQueue();
    registerCoreCommands(queue);
    registerUnitCommands(queue, terrain);
    registerMovementCommands(queue, terrain);
    registerCombatCommands(queue, terrain);

    const friendly = spawnUnit(world, 'tank', 0, 10, 10);
    const enemy = spawnUnit(world, 'tank', 1, 20, 10); // inside weapon range

    const intent = buildAttackMoveOrder(0, [friendly.id], 80, 10);
    queue.enqueue(world, { ...intent, issuer: 'player' });
    queue.applyDue(world, world.tick);

    const combatSystem = createCombatSystem(terrain);

    // Run combat tick: friendly should detect enemy and start firing/chasing
    combatSystem(world, 33.3);

    expect(friendly.targetId).toBe(enemy.id);
    expect(friendly.chasing).toBe(true);
  });
});
