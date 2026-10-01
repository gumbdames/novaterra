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
 * NOVATERRA — save/load round-trip tests (Phase 1, step 11).
 *
 * A saved session restored via `createSession({ snapshot })` must
 * resume exactly: same digest, same tick, same units, same resources,
 * same AI state, same ages, same RNG streams. The restored session must
 * NOT re-seed starting forces or re-add the AI player. Continuing to
 * tick both the original and the restored session must keep them in
 * lockstep (deterministic resume).
 */
import { describe, expect, it } from 'vitest';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import {
  createSaveFile,
  saveMapPreset,
  type SaveFile,
} from '../src/net_save/savefile';
import { buildMoveOrder } from '../src/ui/orders';
import { getMission } from '../src/campaign/missions';
import { getMapPreset, isWater } from '../src/sim/terrain';
import { cellCenterWorld, cellIsWater } from '../src/sim/city';
import { findUnit, spawnUnit } from '../src/sim/units';
import { completeBuilding } from './sim.roster-fixtures';

const SAVED_AT = '2026-09-29T12:00:00.000Z';

function playedSession() {
  const session = createSession({ seed: 2026, aiDifficulty: 'citizen' });
  // Play a little: move a unit, run the sim so economy/AI advance.
  const unit = session.world.units.find((u) => u.owner === HUMAN_PLAYER_ID)!;
  session.enqueuePlayerIntent(buildMoveOrder([unit.id], HUMAN_PLAYER_ID, unit.x + 20, unit.z + 20));
  for (let i = 0; i < 300; i++) session.tick();
  return session;
}

function saveAndRevive(session: ReturnType<typeof createSession>): SaveFile {
  const file = createSaveFile(session, 'slot-1', 'Slot 1', SAVED_AT);
  // Simulate persistence: the file crosses a JSON boundary.
  return JSON.parse(JSON.stringify(file)) as SaveFile;
}

describe('save/load round trip', () => {
  it('restores the exact world state', () => {
    const original = playedSession();
    const file = saveAndRevive(original);
    const restored = createSession({
      seed: file.metadata.seed,
      aiDifficulty: file.metadata.aiDifficulty,
      snapshot: file.snapshot,
    });

    expect(restored.world.tick).toBe(original.world.tick);
    expect(restored.digest()).toBe(original.digest());
    expect(restored.world.units).toEqual(original.world.units);
    expect(restored.world.city.players).toEqual(original.world.city.players);
    expect(restored.world.city.buildings).toEqual(original.world.city.buildings);
    expect(restored.world.ages).toEqual(original.world.ages);
    expect(restored.world.ai).toEqual(original.world.ai);
    expect(restored.world.rng).toEqual(original.world.rng);
  });

  it('does not re-seed starting forces or the AI player on restore', () => {
    const original = playedSession();
    const file = saveAndRevive(original);
    const restored = createSession({
      seed: file.metadata.seed,
      aiDifficulty: file.metadata.aiDifficulty,
      snapshot: file.snapshot,
    });
    // Same unit count — no duplicated armies.
    expect(restored.world.units.length).toBe(original.world.units.length);
    // The AI player record comes from the snapshot, exactly once.
    expect(restored.world.ai.players.length).toBe(original.world.ai.players.length);
    expect(restored.world.ai.players.length).toBeGreaterThan(0);
  });

  it('stays in lockstep with the original when both keep ticking', () => {
    const original = playedSession();
    const file = saveAndRevive(original);
    const restored = createSession({
      seed: file.metadata.seed,
      aiDifficulty: file.metadata.aiDifficulty,
      snapshot: file.snapshot,
    });
    for (let i = 0; i < 600; i++) {
      original.tick();
      restored.tick();
    }
    expect(restored.digest()).toBe(original.digest());
  });

  it('restores the cheated flag onto the session', () => {
    const original = playedSession();
    original.cheated = true;
    const file = saveAndRevive(original);
    expect(file.metadata.cheated).toBe(true);
    // startGame applies this; the session factory leaves it false by
    // default and the caller stamps it from metadata.
    const restored = createSession({
      seed: file.metadata.seed,
      aiDifficulty: file.metadata.aiDifficulty,
      snapshot: file.snapshot,
    });
    expect(restored.cheated).toBe(false);
    restored.cheated = file.metadata.cheated;
    expect(restored.cheated).toBe(true);
  });

  it('restores the exact map for a non-default preset (R1-C/C4)', () => {
    const original = createSession({
      seed: 31337,
      aiDifficulty: 'citizen',
      mapPreset: 'Ocean World',
    });
    for (let i = 0; i < 60; i++) original.tick();
    const file = saveAndRevive(original);
    expect(file.metadata.mapPreset).toBe('Ocean World');
    // The load path (main.ts) regenerates terrain from the saved name.
    const restored = createSession({
      seed: file.metadata.seed,
      aiDifficulty: file.metadata.aiDifficulty,
      mapPreset: saveMapPreset(file),
      snapshot: file.snapshot,
    });
    const preset = getMapPreset('Ocean World');
    expect(restored.mapPreset).toBe('Ocean World');
    expect(restored.terrain.name).toBe('Ocean World');
    expect(restored.terrain.seed).toBe(preset.seed >>> 0);
    expect(restored.world.tick).toBe(original.world.tick);
  });

  it('restores the campaign mission map on load (R1-C/C4)', () => {
    const mission = getMission('crossing-the-water')!;
    const original = createSession({ seed: 4242, campaignMission: mission });
    for (let i = 0; i < 60; i++) original.tick();
    const file = saveAndRevive(original);
    expect(file.metadata.campaignMissionId).toBe('crossing-the-water');
    expect(file.metadata.mapPreset).toBe('Archipelago');
    // The load path resolves the mission id for the map fallback, then
    // restores through the saved preset name.
    const savedMission = file.metadata.campaignMissionId
      ? getMission(file.metadata.campaignMissionId)
      : undefined;
    const restored = createSession({
      seed: file.metadata.seed,
      aiDifficulty: file.metadata.aiDifficulty,
      mapPreset: saveMapPreset(file, savedMission?.mapPreset),
      snapshot: file.snapshot,
    });
    expect(restored.terrain.name).toBe('Archipelago');
    expect(restored.terrain.seed).toBe(getMapPreset('Archipelago').seed >>> 0);
    expect(restored.campaignMissionId).toBeNull();
    expect(restored.world.tick).toBe(original.world.tick);
  });

  it('releases in-flight resupply reservations on load (R1-C/M2)', () => {
    const session = createSession({ seed: 777, aiDifficulty: 'citizen' });
    const t = session.terrain;
    // A land cell for the depot (land unit => land depot).
    let cx = 0;
    let cz = 0;
    outer: for (let r = 0; r < 80; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          if (!cellIsWater(t, -90 + dx, 90 + dz)) {
            cx = -90 + dx;
            cz = 90 + dz;
            break outer;
          }
        }
      }
    }
    completeBuilding(session.world, 'ordnanceDepot', HUMAN_PLAYER_ID, cx, cz);
    const depot =
      session.world.city.buildings[session.world.city.buildings.length - 1]!;
    depot.ammoStock = 100;
    depot.fuelStock = 0;
    // An ammo-dry MLRS parked well outside the depot's refill aura so the
    // reservation is still in flight (not fulfilled) when we save.
    let sx = cellCenterWorld(cx) + 80;
    let sz = cellCenterWorld(cz);
    if (isWater(t, sx, sz)) {
      sx = cellCenterWorld(cx) - 80;
    }
    const u = spawnUnit(session.world, 'mlrs', HUMAN_PLAYER_ID, sx, sz);
    u.ammo = 0;
    session.queue.enqueue(session.world, {
      kind: 'resupply',
      issuer: 'player',
      payload: { unitId: u.id, depotId: depot.id, owner: HUMAN_PLAYER_ID },
    });
    session.tick();
    const liveUnit = findUnit(session.world, u.id)!;
    expect(liveUnit.resupplyDepotId).toBe(depot.id);
    expect(depot.reservedAmmo).toBeGreaterThan(0);
    // The resupply apply self-scheduled its 60 s resupplyTimeout.
    expect(session.queue.pendingCount()).toBeGreaterThan(0);

    const file = saveAndRevive(session);
    const restored = createSession({
      seed: file.metadata.seed,
      aiDifficulty: file.metadata.aiDifficulty,
      mapPreset: saveMapPreset(file),
      snapshot: file.snapshot,
    });
    const rUnit = findUnit(restored.world, u.id)!;
    const rDepot = restored.world.city.buildings.find(
      (b) => b.id === depot.id,
    )!;
    // The reservation is released — no leaked claim on the depot — and
    // the pending queue (incl. the resupplyTimeout) is deliberately
    // dropped: the restored session always starts with an empty queue.
    expect(rUnit.resupplyDepotId).toBe(0);
    expect(rUnit.resupplyReservedAmmo ?? 0).toBe(0);
    expect(rDepot.reservedAmmo ?? 0).toBe(0);
    expect(rDepot.reservedFuel ?? 0).toBe(0);
    expect(restored.queue.pendingCount()).toBe(0);
  });
});
