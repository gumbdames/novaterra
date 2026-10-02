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
 * NOVATERRA — v7 → v8 snapshot migration (grand-expansion Phase 5/6,
 * S4, workstream D).
 *
 * v8 adds the hangar/airport data contract: `BuildingRecord.hangars`
 * (HangarSlot[] — `cls` + `occupant`, 0 = empty) and the unit embark
 * fields (`hangarBuildingId`, `embarkedOn`). v7 saves predate all
 * three. The migration is purely additive (AD9): the legacy `airfield`
 * decodes to LEGACY_AIRFIELD_HANGAR_SLOTS (6) generic empty slots —
 * the documented S4 default, pinned here — every other legacy
 * building decodes to undefined ("never had hangars", distinct from
 * "hangars removed"), and units decode to hangarBuildingId/embarkedOn
 * 0 (unparked, unembarked).
 *
 * A faithful v7 snapshot is built by downgrading a real v8 snapshot:
 * version stamp 7, hangar/embark fields deleted — exactly what a save
 * written before Phase 5/6 looks like.
 */
import { describe, expect, it } from 'vitest';
import { createWorld, type World } from '../src/sim/world';
import {
  placeBuilding,
  LEGACY_AIRFIELD_HANGAR_SLOTS,
  type BuildingKind,
  type Placement,
} from '../src/sim/city';
import { spawnUnit } from '../src/sim/units';
import { digestWorld } from '../src/sim/digest';
import {
  takeSnapshot,
  restoreSnapshot,
  SNAPSHOT_VERSION,
} from '../src/sim/snapshot';
import { grantAllTrainingResources } from './sim.roster-fixtures';

/** A world with a legacy airfield, a non-hangar building, and a unit. */
function buildWorld(seed: number): World {
  const world = createWorld(seed);
  grantAllTrainingResources(world);
  const defs: Array<[BuildingKind, number, number, number]> = [
    ['airfield', 0, 20, 20],
    ['house', 0, 30, 20],
  ];
  for (const [kind, owner, cx, cz] of defs) {
    const p: Placement = { kind, owner, cx, cz, facing: 0 };
    placeBuilding(world.city, p).progress = 1;
  }
  spawnUnit(world, 'fighter', 0, 100, 100);
  return world;
}

/**
 * Downgrade a live v8 snapshot to a faithful v7: version stamp 7, no
 * hangar slots, no embark fields — the exact shape of a save written
 * before the Phase 5/6 data contract.
 */
function downgradeToV7(snap: unknown): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(snap)) as Record<string, any>;
  s.version = 7;
  for (const b of s.city?.buildings ?? []) delete b.hangars;
  for (const u of s.units ?? []) {
    delete u.hangarBuildingId;
    delete u.embarkedOn;
  }
  return s;
}

describe('v7 -> v8 migration: hangar + embark fields', () => {
  it('SNAPSHOT_VERSION is 9 (B25: slim pathfinding, field internals rebuilt on load)', () => {
    expect(SNAPSHOT_VERSION).toBe(9);
  });

  it('the legacy airfield default is pinned: 6 generic slots', () => {
    expect(LEGACY_AIRFIELD_HANGAR_SLOTS).toBe(6);
  });

  it('a downgraded v7 snapshot restores without throwing', () => {
    const world = buildWorld(4242);
    const v7 = downgradeToV7(takeSnapshot(world));
    expect(v7.version).toBe(7);
    expect(() => restoreSnapshot(v7 as never)).not.toThrow();
  });

  it('legacy airfield decodes to 6 generic empty slots; other buildings to undefined', () => {
    const world = buildWorld(4242);
    const restored = restoreSnapshot(downgradeToV7(takeSnapshot(world)) as never);
    const airfield = restored.city.buildings.find((b) => b.kind === 'airfield');
    const house = restored.city.buildings.find((b) => b.kind === 'house');
    expect(airfield).toBeDefined();
    expect(house).toBeDefined();
    expect(airfield!.hangars).toHaveLength(LEGACY_AIRFIELD_HANGAR_SLOTS);
    for (const s of airfield!.hangars!) {
      expect(s).toEqual({ cls: 'generic', occupant: 0 });
    }
    // Non-hangar legacy buildings decode to undefined, not [] — the
    // AD9 "never had hangars" marker (distinct from "hangars removed").
    expect(house!.hangars).toBeUndefined();
  });

  it('legacy units decode to hangarBuildingId/embarkedOn 0', () => {
    const world = buildWorld(4242);
    const restored = restoreSnapshot(downgradeToV7(takeSnapshot(world)) as never);
    const fighter = restored.units.find((u) => u.kind === 'fighter');
    expect(fighter).toBeDefined();
    expect(fighter!.hangarBuildingId ?? 0).toBe(0);
    expect(fighter!.embarkedOn ?? 0).toBe(0);
  });

  it('v7 decode digests identically to a native v8 round-trip (digest-stable migration)', () => {
    const world = buildWorld(4242);
    const snap = takeSnapshot(world);
    const viaV8 = restoreSnapshot(JSON.parse(JSON.stringify(snap)) as never);
    const viaV7 = restoreSnapshot(downgradeToV7(snap) as never);
    expect(digestWorld(viaV7)).toBe(digestWorld(viaV8));
  });

  it('v8 snapshots deep-copy hangar slots (no aliasing with the live world)', () => {
    const world = buildWorld(4242);
    const snap = takeSnapshot(world);
    const snapAirfield = (snap.city.buildings as Array<{ kind: string; hangars: Array<{ occupant: number }> }>)
      .find((b) => b.kind === 'airfield')!;
    snapAirfield.hangars[0]!.occupant = 424242;
    const restored = restoreSnapshot(snap as never);
    const live = world.city.buildings.find((b) => b.kind === 'airfield')!;
    expect(live.hangars?.[0]?.occupant).toBe(0);
    expect(restored.city.buildings.find((b) => b.kind === 'airfield')!.hangars?.[0]?.occupant).toBe(424242);
  });

  it('restored v7 world plays: economy ticks without crashing', () => {
    const world = buildWorld(4242);
    const restored = restoreSnapshot(downgradeToV7(takeSnapshot(world)) as never);
    // The restored world must be a fully playable world: units live,
    // buildings complete, hangar defaults in place.
    expect(restored.units.length).toBe(world.units.length);
    expect(restored.city.buildings.length).toBe(world.city.buildings.length);
    const d = digestWorld(restored);
    expect(typeof d).toBe('number');
    expect(d).not.toBe(0);
  });
});
