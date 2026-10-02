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
 * UI-side production-queue tests (fun-audit C1, 2026-10-02).
 *
 * The sim queue core is pinned in sim.trainQueues.test.ts. Pinned here:
 *  - the four order builders emit the right intent kinds + payloads
 *    (trainUnit / cancelTrainUnit / setTrainPaused / setRallyPoint);
 *  - trainAtBuildingAvailability mirrors the sim validator: ok at a
 *    completed producer, not ok when the queue is full, not ok without
 *    a producer, locked when the unit is unavailable;
 *  - the palette digest always emits a `tq:` segment for a selected
 *    building ('tq:x' for non-production buildings) and moves when the
 *    queue / pause / rally state changes.
 */

import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  buildTrainUnitOrder,
  buildCancelTrainOrder,
  buildSetTrainPausedOrder,
  buildSetRallyPointOrder,
} from '../src/ui/orders';
import {
  MAX_TRAIN_QUEUE,
  trainTicksFor,
  type UnitKind,
} from '../src/sim/units';
import { trainAtBuildingAvailability } from '../src/ui/palettes';
import { selectionDigest } from '../src/ui/paletteDigest';
import { selectBuilding } from '../src/ui/selection';
import { HUMAN_PLAYER_ID } from '../src/ui/session';
import {
  completeBuilding,
  grantAllTrainingResources,
} from './sim.roster-fixtures';

function makeQueueWorld(): World {
  const world = createWorld(4242);
  grantAllTrainingResources(world);
  completeBuilding(world, 'barracks', HUMAN_PLAYER_ID);
  return world;
}

describe('train-queue order builders', () => {
  it('buildTrainUnitOrder carries kind, owner and buildingId', () => {
    const o = buildTrainUnitOrder('rifles' as UnitKind, HUMAN_PLAYER_ID, 12);
    expect(o.kind).toBe('trainUnit');
    expect(o.payload).toMatchObject({ kind: 'rifles', owner: HUMAN_PLAYER_ID, buildingId: 12 });
  });

  it('buildCancelTrainOrder carries owner, buildingId and index', () => {
    const o = buildCancelTrainOrder(HUMAN_PLAYER_ID, 12, 1);
    expect(o.kind).toBe('cancelTrainUnit');
    expect(o.payload).toMatchObject({ owner: HUMAN_PLAYER_ID, buildingId: 12, index: 1 });
  });

  it('buildSetTrainPausedOrder carries the paused flag', () => {
    const o = buildSetTrainPausedOrder(HUMAN_PLAYER_ID, 12, true);
    expect(o.kind).toBe('setTrainPaused');
    expect(o.payload).toMatchObject({ owner: HUMAN_PLAYER_ID, buildingId: 12, paused: true });
  });

  it('buildSetRallyPointOrder carries the rally coordinates', () => {
    const o = buildSetRallyPointOrder(HUMAN_PLAYER_ID, 12, 30, 34);
    expect(o.kind).toBe('setRallyPoint');
    expect(o.payload).toMatchObject({ owner: HUMAN_PLAYER_ID, buildingId: 12, x: 30, z: 34 });
  });
});

describe('trainAtBuildingAvailability', () => {
  it('ok at a completed barracks for a barracks-produced unit', () => {
    const world = makeQueueWorld();
    const b = world.city.buildings[0]!;
    expect(trainAtBuildingAvailability(world, HUMAN_PLAYER_ID, b.id, 'rifles' as UnitKind).ok).toBe(true);
  });

  it('not ok at the wrong producer (rifles cannot train at an airfield)', () => {
    const world = makeQueueWorld();
    completeBuilding(world, 'airfield', HUMAN_PLAYER_ID, 40, 40);
    const airfield = world.city.buildings.find((x) => x.kind === 'airfield')!;
    expect(
      trainAtBuildingAvailability(world, HUMAN_PLAYER_ID, airfield.id, 'rifles' as UnitKind).ok,
    ).toBe(false);
  });

  it('not ok when the queue is full', () => {
    const world = makeQueueWorld();
    const b = world.city.buildings[0]!;
    b.trainQueue = Array.from({ length: MAX_TRAIN_QUEUE }, () => ({
      kind: 'rifles' as UnitKind,
      ticksLeft: trainTicksFor('rifles' as UnitKind),
    }));
    const av = trainAtBuildingAvailability(world, HUMAN_PLAYER_ID, b.id, 'rifles' as UnitKind);
    expect(av.ok).toBe(false);
    expect(av.reason.length).toBeGreaterThan(0);
  });

  it('not ok for an unknown building id', () => {
    const world = makeQueueWorld();
    const av = trainAtBuildingAvailability(world, HUMAN_PLAYER_ID, 9999, 'rifles' as UnitKind);
    expect(av.ok).toBe(false);
  });

  it('locked when the unit itself is unavailable (unaffordable)', () => {
    const world = makeQueueWorld();
    const b = world.city.buildings[0]!;
    const p = world.city.players.find((x) => x.id === HUMAN_PLAYER_ID)!;
    p.funds = 0;
    p.materials = 0;
    const av = trainAtBuildingAvailability(world, HUMAN_PLAYER_ID, b.id, 'tank' as UnitKind);
    expect(av.ok).toBe(false);
  });
});

describe('train-queue digest segment', () => {
  it("emits 'tq:x' for a non-production building", () => {
    const world = makeQueueWorld();
    completeBuilding(world, 'house', HUMAN_PLAYER_ID, 60, 60);
    const house = world.city.buildings.find((x) => x.kind === 'house')!;
    const d = selectionDigest(world, selectBuilding(house.id), 'all', 'housing');
    expect(d).toContain('tq:x');
  });

  it('emits queue, pause and rally state for a production building', () => {
    const world = makeQueueWorld();
    const b = world.city.buildings[0]!;
    const sel = selectBuilding(b.id);
    const empty = selectionDigest(world, sel, 'all', 'housing');
    expect(empty).toContain('tq:');
    expect(empty).not.toContain('tq:x');

    // Queue one unit: the digest must move.
    b.trainQueue = [{ kind: 'rifles' as UnitKind, ticksLeft: trainTicksFor('rifles' as UnitKind) }];
    const queued = selectionDigest(world, sel, 'all', 'housing');
    expect(queued).not.toBe(empty);
    expect(queued).toContain('rifles');

    // Pause toggles the segment.
    b.trainPaused = true;
    const paused = selectionDigest(world, sel, 'all', 'housing');
    expect(paused).not.toBe(queued);

    // Rally point toggles the segment.
    b.trainPaused = undefined;
    b.rallyX = 20;
    b.rallyZ = 22;
    const rallied = selectionDigest(world, sel, 'all', 'housing');
    expect(rallied).not.toBe(queued);
    expect(rallied).toContain('20,22');
  });
});
