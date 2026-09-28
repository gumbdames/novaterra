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
import { createSaveFile, type SaveFile } from '../src/net_save/savefile';
import { buildMoveOrder } from '../src/ui/orders';

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
});
