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
 * NOVATERRA — v9 snapshot pathfinding tests (roadmap B25, 2026-10-02).
 *
 * v9 drops flow-field internals from the snapshot: the mid-flood build's
 * 6×65k arrays (~1.5MB of a typical save) slim to a {fieldId, destCell,
 * unitIds} pending build, and each live field's 65k direction grid slims
 * to {id, destCell}. These tests pin:
 *  - the serialized v9 snapshot carries no 65k arrays (the size win),
 *  - restore re-queues the pending build at the FRONT of fieldQueue and
 *    restores field identities with empty direction grids,
 *  - rebuildFlowFields fills working direction grids (destination cell
 *    marked, neighbors routable),
 *  - restore is deterministic (two restores digest identically),
 *  - legacy v8 snapshots (full internals) still decode verbatim.
 */
import { describe, expect, it } from 'vitest';

import { createWorld } from '../src/sim/world';
import {
  SNAPSHOT_VERSION,
  isSnapshotPathfindingV9,
  restoreSnapshot,
  takeSnapshot,
} from '../src/sim/snapshot';
import type { Snapshot } from '../src/sim/snapshot';
import {
  FIELD_DESTINATION,
  beginFieldBuild,
  landComponents,
  passabilityMask,
  rebuildFlowFields,
} from '../src/sim/pathfinding';
import { CITY_GRID_CELLS } from '../src/sim/city';
import { generateTerrain, MERIDIAN_PLAINS, type TerrainData } from '../src/sim/terrain';
import { digestWorld } from '../src/sim/digest';
import {
  SaveQuotaExceededError,
  estimateSaveBytes,
  formatBytes,
  isQuotaError,
} from '../src/netSave/store';

const CELLS = CITY_GRID_CELLS * CITY_GRID_CELLS; // 65536

let cachedTerrain: TerrainData | null = null;
function terrain(): TerrainData {
  if (!cachedTerrain) cachedTerrain = generateTerrain(MERIDIAN_PLAINS.seed);
  return cachedTerrain;
}

/** A passable land cell near the map center (deterministic). */
function landCell(t: TerrainData): number {
  const mask = passabilityMask(t);
  const c = Math.floor(CITY_GRID_CELLS / 2);
  for (let r = 0; r < CITY_GRID_CELLS; r++) {
    for (const [cx, cz] of [
      [c + r, c],
      [c - r, c],
      [c, c + r],
      [c, c - r],
    ] as Array<[number, number]>) {
      if (cx < 0 || cz < 0 || cx >= CITY_GRID_CELLS || cz >= CITY_GRID_CELLS) continue;
      if (mask[cz * CITY_GRID_CELLS + cx] !== 0) return cz * CITY_GRID_CELLS + cx;
    }
  }
  throw new Error('test: no land cell found');
}

/** A world with one live flow field and one mid-flood build in flight. */
function worldWithFields() {
  const t = terrain();
  const world = createWorld(97531);
  const dest = landCell(t);
  const mask = passabilityMask(t);
  const comps = landComponents(t);
  // A finished field (as the chunked coordinator would leave it).
  world.pathfinding.fields.push({
    id: 11,
    destCell: dest,
    dirs: new Array<number>(CELLS).fill(FIELD_DESTINATION),
  });
  world.pathfinding.nextFieldId = 12;
  // A mid-flood build (the 6×65k arrays that used to bloat saves).
  world.pathfinding.activeBuild = beginFieldBuild(
    12,
    dest,
    [1, 2],
    [dest],
    mask,
    [],
    comps,
    true,
  );
  return { world, terrain: t, dest };
}

describe('v9 snapshot drops flow-field internals (B25)', () => {
  it('writes version 9 with the slim pathfinding shape', () => {
    const { world } = worldWithFields();
    const snap = takeSnapshot(world);
    expect(snap.version).toBe(9);
    expect(SNAPSHOT_VERSION).toBe(9);
    expect(isSnapshotPathfindingV9(snap.pathfinding)).toBe(true);
  });

  it('the serialized snapshot carries no 65k arrays', () => {
    const { world } = worldWithFields();
    const json = JSON.stringify(takeSnapshot(world));
    // The old shape embedded dist/waitMark/closed/dirs verbatim.
    expect(json).not.toContain('"dist"');
    expect(json).not.toContain('"dirs"');
    expect(json).not.toContain('"waitMark"');
    // Sanity: the fixture world really did have the big arrays.
    expect(world.pathfinding.fields[0]?.dirs.length).toBe(CELLS);
    // And the slim form is tiny.
    expect(json.length).toBeLessThan(200_000);
  });

  it('the pending build keeps its identity (field id, dest, units)', () => {
    const { world } = worldWithFields();
    const snap = takeSnapshot(world);
    const pf = snap.pathfinding;
    if (!isSnapshotPathfindingV9(pf)) throw new Error('expected v9 shape');
    expect(pf.pendingBuild).toEqual({ fieldId: 12, destCell: expect.any(Number), unitIds: [1, 2] });
    expect(pf.fields).toEqual([{ id: 11, destCell: expect.any(Number) }]);
    expect(pf.nextFieldId).toBe(12);
  });
});

describe('v9 restore + rebuildFlowFields', () => {
  it('re-queues the pending build at the front; fields restore as identities', () => {
    const { world } = worldWithFields();
    const restored = restoreSnapshot(takeSnapshot(world));
    const pf = restored.pathfinding;
    expect(pf.activeBuild).toBeNull();
    // The pending build resumes first — its units are already stamped
    // with field id 12 and waiting.
    expect(pf.fieldQueue.length).toBe(1);
    expect(pf.fieldQueue[0]?.fieldId).toBe(12);
    expect(pf.fieldQueue[0]?.unitIds).toEqual([1, 2]);
    // Field identities survive; direction grids await the rebuild.
    expect(pf.fields.length).toBe(1);
    expect(pf.fields[0]?.id).toBe(11);
    expect(pf.fields[0]?.dirs).toEqual([]);
    expect(pf.nextFieldId).toBe(12);
  });

  it('rebuildFlowFields fills working direction grids', () => {
    const { world, terrain: t, dest } = worldWithFields();
    const restored = restoreSnapshot(takeSnapshot(world));
    rebuildFlowFields(restored, t);
    const field = restored.pathfinding.fields[0];
    expect(field?.dirs.length).toBe(CELLS);
    expect(field?.dirs[dest]).toBe(FIELD_DESTINATION);
    // A neighboring land cell routes toward the destination (0–7), not
    // "unreachable" (8) — the field steers.
    const dcx = dest % CITY_GRID_CELLS;
    const dcz = Math.floor(dest / CITY_GRID_CELLS);
    const mask = passabilityMask(t);
    let checked = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
      const nx = dcx + dx;
      const nz = dcz + dz;
      if (nx < 0 || nz < 0 || nx >= CITY_GRID_CELLS || nz >= CITY_GRID_CELLS) continue;
      if (mask[nz * CITY_GRID_CELLS + nx] === 0) continue;
      const dir = field?.dirs[nz * CITY_GRID_CELLS + nx] as number;
      expect(dir).toBeGreaterThanOrEqual(0);
      expect(dir).toBeLessThanOrEqual(7);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('restore is deterministic: two restores digest identically', () => {
    const { world, terrain: t } = worldWithFields();
    const snap = takeSnapshot(world);
    const a = restoreSnapshot(JSON.parse(JSON.stringify(snap)) as Snapshot);
    const b = restoreSnapshot(JSON.parse(JSON.stringify(snap)) as Snapshot);
    rebuildFlowFields(a, t);
    rebuildFlowFields(b, t);
    expect(digestWorld(a)).toBe(digestWorld(b));
  });

  it('a second rebuild is a no-op (idempotent)', () => {
    const { world, terrain: t } = worldWithFields();
    const restored = restoreSnapshot(takeSnapshot(world));
    rebuildFlowFields(restored, t);
    const before = digestWorld(restored);
    rebuildFlowFields(restored, t);
    expect(digestWorld(restored)).toBe(before);
  });
});

describe('legacy v8 snapshots still decode verbatim', () => {
  it('full field internals survive the old path untouched', () => {
    const { world } = worldWithFields();
    const snap = takeSnapshot(world);
    // Forge the v8 shape: full PathfindingState, version 8.
    const v8 = {
      ...snap,
      version: 8,
      pathfinding: {
        queue: [],
        fieldQueue: [],
        activeBuild: null,
        fields: [{ id: 11, destCell: 4242, dirs: new Array<number>(CELLS).fill(3) }],
        nextFieldId: 12,
      },
    } as unknown as Snapshot;
    const restored = restoreSnapshot(v8);
    expect(restored.pathfinding.fields[0]?.dirs.length).toBe(CELLS);
    expect(restored.pathfinding.fields[0]?.dirs[0]).toBe(3);
    expect(restored.pathfinding.activeBuild).toBeNull();
  });
});

describe('quota-exceeded plumbing (B25 cheap half)', () => {
  it('isQuotaError recognizes quota failures by name', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ name: 'QUOTA_EXCEEDED_ERR' })).toBe(true);
    expect(isQuotaError(new Error('disk full'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
  });

  it('SaveQuotaExceededError carries the attempted byte size', () => {
    const err = new SaveQuotaExceededError(4_200_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SaveQuotaExceededError');
    expect(err.bytes).toBe(4_200_000);
    expect(err.message).toContain('4200000');
  });

  it('estimateSaveBytes / formatBytes sanity', () => {
    expect(estimateSaveBytes({ a: 1 })).toBeGreaterThan(0);
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(2_600_000)).toBe('2.5 MB');
    expect(formatBytes(-1)).toBe('unknown size');
  });
});
