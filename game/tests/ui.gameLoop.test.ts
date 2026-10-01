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
 * Tests for the game-loop seam in ui/game.ts (camera/input-freeze
 * hardening, 2026-09-30).
 *
 * Background: the animation-loop callback used to be one inline
 * closure — ANY exception in a single frame (a new building's view
 * creation in entities.sync, a HUD digest update, …) propagated out
 * of the three.js callback and the loop never rescheduled, freezing
 * the camera AND all input at once with no visible error. Two pieces
 * prevent a recurrence:
 *
 * - `guardGameFrame` (the error boundary): a frame's exception is
 *   logged loudly (sim tick + armed tool for repro), the
 *   player-visible callback fires, and the exception never escapes.
 * - `runGameFrame` (the extracted per-frame body): driven headlessly
 *   here against a REAL session + REAL EntityRenderer — buildings are
 *   placed via the command queue (the placement-complete path), then
 *   frames advance and the test asserts the world keeps ticking and
 *   the new buildings get views.
 *
 * Headless (node env): `document` is stubbed for the health-bar canvas
 * texture, exactly like tests/render.entities.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

import {
  runGameFrame,
  guardGameFrame,
  type GameFrameDeps,
} from '../src/ui/game';
import { EntityRenderer } from '../src/render/entities';
import { createSession, HUMAN_PLAYER_ID } from '../src/ui/session';
import { getPlayer, type BuildingKind } from '../src/sim/city';
import { buildPlaceBuildingOrder, buildZoneOrder, buildAdvanceAgeOrder } from '../src/ui/orders';
import { clearSelection } from '../src/ui/selection';
import type { World } from '../src/sim/world';

// ---------------------------------------------------------------------------
// Minimal DOM stub (health-bar CanvasTexture only).
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: (_tag: string) => ({
      width: 1,
      height: 1,
      getContext: () => ({ fillStyle: '', fillRect: () => {} }),
    }),
    documentElement: { classList: { contains: () => false } },
  });
});

// ---------------------------------------------------------------------------
// guardGameFrame: the error boundary.
// ---------------------------------------------------------------------------

describe('guardGameFrame', () => {
  it('runs the work and stays silent on success', () => {
    const onFrameError = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let ran = false;
      guardGameFrame(
        () => {
          ran = true;
        },
        { tick: 42, armedTool: 'zoneR' },
        onFrameError,
      );
      expect(ran).toBe(true);
      expect(onFrameError).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('swallows a throwing frame, reports loudly with tick + armed tool', () => {
    const onFrameError = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const boom = new Error('sync exploded');
      expect(() =>
        guardGameFrame(
          () => {
            throw boom;
          },
          { tick: 1234, armedTool: 'building:house' },
          onFrameError,
        ),
      ).not.toThrow();
      expect(onFrameError).toHaveBeenCalledTimes(1);
      expect(typeof onFrameError.mock.calls[0]![0]).toBe('string');
      // Loud, with repro context: tick and armed tool in the log line.
      expect(errSpy).toHaveBeenCalledTimes(1);
      const logged = String(errSpy.mock.calls[0]![0]);
      expect(logged).toContain('1234');
      expect(logged).toContain('building:house');
      // The original error is attached, never masked.
      expect(errSpy.mock.calls[0]![1]).toBe(boom);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('the loop survives: frames after a throwing frame still run', () => {
    const onFrameError = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let frames = 0;
      let failNext = true;
      for (let i = 0; i < 5; i++) {
        guardGameFrame(
          () => {
            frames++;
            if (failNext) {
              failNext = false;
              throw new Error('one bad frame');
            }
          },
          { tick: i, armedTool: null },
          onFrameError,
        );
      }
      // All five frames ran — the one bad frame did not kill the loop.
      expect(frames).toBe(5);
      expect(onFrameError).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// runGameFrame: real frames over a real session (placement-complete path).
// ---------------------------------------------------------------------------

/** Headless frame deps: real session + real EntityRenderer, stub HUD. */
function makeDeps(world: World, entities: EntityRenderer): {
  deps: GameFrameDeps;
  hooks: { hudUpdates: number; renders: number };
} {
  const hooks = { hudUpdates: 0, renders: 0 };
  let lastAdvisorRefresh = 0;
  const deps: GameFrameDeps = {
    session: undefined as never, // filled below
    paused: false,
    speed: 1,
    selection: clearSelection(),
    advisorItems: [],
    updateCamera: () => {},
    maybeAutosave: () => {},
    maybeShowConquestOutcome: () => {},
    refreshAdvisor: () => {},
    pruneSelection: () => {},
    syncEntities: (w) => entities.sync(w),
    // Phase 4 (transport): the frame loop refreshes the ambient transit
    // providers before the entity sync (stubbed here — the real
    // controller owns the providers).
    syncTransitProviders: () => {},
    // Roadmap B11 (2026-10-02): the placement ghost overlay.
    updatePlacementGhost: () => {},
    setSelectedEntities: (ids) => entities.setSelected(ids),
    updateEntitySelectionRings: (w) =>
      entities.updateSelectionRings(EntityRenderer.unitMap(w)),
    updateHud: () => {
      hooks.hudUpdates++;
    },
    pollAudioEvents: () => {},
    pollCampaign: () => {},
    updateAudioListener: () => {},
    renderFrame: () => {
      hooks.renders++;
    },
    getLastAdvisorRefresh: () => lastAdvisorRefresh,
    setLastAdvisorRefresh: (t) => {
      lastAdvisorRefresh = t;
    },
  };
  return { deps, hooks };
}

describe('runGameFrame over a live session', () => {
  it('places buildings via the command queue and advances frames without throwing', () => {
    const session = createSession({ seed: 4242 });
    const world = session.world;
    // Generous stocks: the test exercises the render path, not the economy.
    const player = getPlayer(world.city, HUMAN_PLAYER_ID)!;
    player.funds = 1_000_000;
    player.materials = 1_000_000;
    player.influence = 1_000_000;

    const scene = new THREE.Scene();
    const entities = new EntityRenderer(scene);
    const { deps, hooks } = makeDeps(world, entities);
    deps.session = session;

    // Paint the zones the buildings need, then place a spread of
    // buildings through the real command queue — including transport
    // hubs (their procedural models are new in Phase 4). The zone
    // orders must be applied (one driver step) before the placements
    // validate against them — same as the live game.
    session.enqueuePlayerIntent(buildZoneOrder(HUMAN_PLAYER_ID, 0, 10, 10, 30, 30));
    session.enqueuePlayerIntent(buildZoneOrder(HUMAN_PLAYER_ID, 1, 40, 10, 70, 30));
    session.enqueuePlayerIntent(buildZoneOrder(HUMAN_PLAYER_ID, 2, 80, 60, 110, 90));
    // Transport hubs need the industry age (foundation → connectivity →
    // industry); advance through the real command queue like the HUD
    // age button does.
    session.enqueuePlayerIntent(buildAdvanceAgeOrder(HUMAN_PLAYER_ID, 'fiberGrid'));
    session.driver.step(world, 100);
    session.enqueuePlayerIntent(buildAdvanceAgeOrder(HUMAN_PLAYER_ID, 'heavyIndustry'));
    session.driver.step(world, 100);
    session.enqueuePlayerIntent(buildPlaceBuildingOrder('house', HUMAN_PLAYER_ID, 15, 15));
    session.enqueuePlayerIntent(buildPlaceBuildingOrder('apartment', HUMAN_PLAYER_ID, 20, 20));
    session.enqueuePlayerIntent(buildPlaceBuildingOrder('railStation', HUMAN_PLAYER_ID, 45, 15));
    session.enqueuePlayerIntent(buildPlaceBuildingOrder('busStop', HUMAN_PLAYER_ID, 50, 20));
    session.enqueuePlayerIntent(buildPlaceBuildingOrder('centralStation', HUMAN_PLAYER_ID, 60, 15));
    session.enqueuePlayerIntent(buildPlaceBuildingOrder('busDepot', HUMAN_PLAYER_ID, 85, 65));

    const tickBefore = world.tick;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Advance real frames through the error boundary, like start()
      // does: a frame that throws must not take the loop down.
      for (let i = 0; i < 12; i++) {
        guardGameFrame(
          () => runGameFrame(deps, i * 16.7, 16.7),
          { tick: world.tick, armedTool: 'building:house' },
          () => {},
        );
      }
    } finally {
      errSpy.mockRestore();
    }

    // The world kept ticking through every frame.
    expect(world.tick).toBeGreaterThan(tickBefore);
    // The placements landed (under construction or complete).
    const kinds = new Set(world.city.buildings.map((b) => b.kind));
    const wanted: BuildingKind[] = ['house', 'apartment', 'railStation', 'busStop', 'centralStation', 'busDepot'];
    for (const kind of wanted) {
      expect(kinds.has(kind), `expected a placed ${kind}`).toBe(true);
    }
    // Every frame reached the HUD and the renderer.
    expect(hooks.hudUpdates).toBe(12);
    expect(hooks.renders).toBe(12);
  });

  it('a throwing entity sync does not stop later frames (loop survives)', () => {
    const session = createSession({ seed: 777 });
    const world = session.world;
    const scene = new THREE.Scene();
    const entities = new EntityRenderer(scene);
    const { deps } = makeDeps(world, entities);
    deps.session = session;

    const tickBefore = world.tick;
    let failSync = true;
    const realSync = deps.syncEntities;
    deps.syncEntities = (w) => {
      if (failSync) {
        failSync = false;
        throw new Error('entities.sync exploded mid-frame');
      }
      realSync(w);
    };

    const onFrameError = vi.fn();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i++) {
        guardGameFrame(
          () => runGameFrame(deps, i * 16.7, 16.7),
          { tick: world.tick, armedTool: null },
          onFrameError,
        );
      }
      // One frame errored loudly…
      expect(onFrameError).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
      // …and the loop kept going: the sim tick advanced past the bad frame.
      expect(world.tick).toBeGreaterThan(tickBefore);
    } finally {
      errSpy.mockRestore();
    }
  });
});
