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
 * NOVATERRA — camera controller tests (Phase 1, step 9; workstream V).
 *
 * The camera state transitions are pure functions: pan/zoom/rotate/tilt
 * and clamping to the map bounds. Workstream V adds the gesture mapping
 * layer, also pure: edge-pan direction (all four screen edges),
 * left-drag grab-pan (screen px -> world, yaw-aware), middle-drag orbit
 * (yaw + clamped pitch), the drag pixel scale, and the press-time
 * pan-vs-placement disambiguation rule. The three.js seam
 * (`applyCameraState`) is not tested here (needs a GPU/DOM).
 */
import { describe, expect, it } from 'vitest';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MAX_PITCH,
  CAMERA_MIN_DISTANCE,
  CAMERA_MIN_PITCH,
  checkCameraState,
  clampCameraState,
  createCameraState,
  EDGE_PAN_PX,
  edgePanVector,
  guardCameraState,
  ORBIT_PITCH_PER_PX,
  ORBIT_YAW_PER_PX,
  orbitDrag,
  panCamera,
  panDragTarget,
  pressDragKind,
  rotateCamera,
  tiltCamera,
  worldPerPixelAtTarget,
  zoomCamera,
} from '../src/ui/camera';
import { MAP_HALF_SIZE } from '../src/sim/city';

describe('camera state', () => {
  it('starts centered at a readable RTS angle', () => {
    const s = createCameraState();
    expect(s.targetX).toBe(0);
    expect(s.targetZ).toBe(0);
    expect(s.distance).toBeGreaterThanOrEqual(CAMERA_MIN_DISTANCE);
    expect(s.distance).toBeLessThanOrEqual(CAMERA_MAX_DISTANCE);
    expect(s.pitch).toBeGreaterThanOrEqual(CAMERA_MIN_PITCH);
    expect(s.pitch).toBeLessThanOrEqual(CAMERA_MAX_PITCH);
  });

  it('pans the target and clamps to the map bounds', () => {
    const s = createCameraState();
    const panned = panCamera(s, 10, -20);
    expect(panned.targetX).toBe(10);
    expect(panned.targetZ).toBe(-20);

    const far = panCamera(s, 100000, 100000);
    expect(far.targetX).toBeLessThanOrEqual(MAP_HALF_SIZE);
    expect(far.targetZ).toBeLessThanOrEqual(MAP_HALF_SIZE);
    expect(far.targetX).toBeGreaterThanOrEqual(-MAP_HALF_SIZE);
  });

  it('does not mutate the input state', () => {
    const s = createCameraState();
    panCamera(s, 50, 50);
    expect(s.targetX).toBe(0);
    expect(s.targetZ).toBe(0);
  });

  it('zooms multiplicatively within min/max distance', () => {
    const s = createCameraState();
    const in1 = zoomCamera(s, 0.5);
    expect(in1.distance).toBe(s.distance * 0.5);
    const out = zoomCamera(s, 2);
    expect(out.distance).toBe(s.distance * 2);

    expect(zoomCamera(s, 0.00001).distance).toBe(CAMERA_MIN_DISTANCE);
    expect(zoomCamera(s, 100000).distance).toBe(CAMERA_MAX_DISTANCE);
  });

  it('ignores non-positive or non-finite zoom factors', () => {
    const s = createCameraState();
    expect(zoomCamera(s, 0)).toBe(s);
    expect(zoomCamera(s, -2)).toBe(s);
    expect(zoomCamera(s, NaN)).toBe(s);
  });

  it('rotates yaw and wraps at 2π', () => {
    const s = createCameraState();
    const r = rotateCamera(s, Math.PI);
    expect(r.yaw).toBeCloseTo(Math.PI, 10);
    const wrapped = rotateCamera(r, Math.PI);
    expect(wrapped.yaw).toBeCloseTo(0, 10);
    const negative = rotateCamera(s, -Math.PI / 2);
    expect(negative.yaw).toBeCloseTo((3 * Math.PI) / 2, 10);
  });

  it('tilts within the readable band', () => {
    const s = createCameraState();
    expect(tiltCamera(s, 10).pitch).toBe(CAMERA_MAX_PITCH);
    expect(tiltCamera(s, -10).pitch).toBe(CAMERA_MIN_PITCH);
    const mid = tiltCamera(s, 0.1);
    expect(mid.pitch).toBeGreaterThan(s.pitch);
  });

  it('clampCameraState normalizes everything at once', () => {
    const clamped = clampCameraState({
      targetX: 99999,
      targetZ: -99999,
      distance: 1,
      yaw: -Math.PI,
      pitch: 99,
    });
    expect(clamped.targetX).toBeLessThanOrEqual(MAP_HALF_SIZE);
    expect(clamped.targetZ).toBeGreaterThanOrEqual(-MAP_HALF_SIZE);
    expect(clamped.distance).toBe(CAMERA_MIN_DISTANCE);
    expect(clamped.yaw).toBeGreaterThanOrEqual(0);
    expect(clamped.yaw).toBeLessThan(2 * Math.PI);
    expect(clamped.pitch).toBe(CAMERA_MAX_PITCH);
  });
});

describe('edge pan vector (workstream V)', () => {
  const view = { viewWidth: 1280, viewHeight: 800, yaw: 0 };

  it('pans all four screen edges at yaw 0', () => {
    // yaw 0: forward = (0,-1) [screen up], right = (1,0) [screen right].
    expect(edgePanVector({ ...view, pointerX: 640, pointerY: 5 })).toEqual({ x: 0, z: -1 });
    expect(edgePanVector({ ...view, pointerX: 640, pointerY: 795 })).toEqual({ x: 0, z: 1 });
    expect(edgePanVector({ ...view, pointerX: 5, pointerY: 400 })).toEqual({ x: -1, z: 0 });
    expect(edgePanVector({ ...view, pointerX: 1275, pointerY: 400 })).toEqual({ x: 1, z: 0 });
  });

  it('combines at corners and stays idle in the middle', () => {
    expect(edgePanVector({ ...view, pointerX: 5, pointerY: 5 })).toEqual({ x: -1, z: -1 });
    expect(edgePanVector({ ...view, pointerX: 640, pointerY: 400 })).toEqual({ x: 0, z: 0 });
    // Just outside the zone: strict inequality, like the shipped behavior.
    expect(edgePanVector({ ...view, pointerX: EDGE_PAN_PX, pointerY: 400 })).toEqual({ x: 0, z: 0 });
    expect(edgePanVector({ ...view, pointerX: 640, pointerY: 800 - EDGE_PAN_PX })).toEqual({ x: 0, z: 0 });
  });

  it('rotates the pan axes with yaw', () => {
    // yaw PI/2: forward = (-1,0), right = (0,-1).
    const v = { viewWidth: 1280, viewHeight: 800, yaw: Math.PI / 2 };
    const top = edgePanVector({ ...v, pointerX: 640, pointerY: 5 });
    expect(top.x).toBeCloseTo(-1, 10);
    expect(top.z).toBeCloseTo(0, 10);
    const left = edgePanVector({ ...v, pointerX: 5, pointerY: 400 });
    expect(left.x).toBeCloseTo(0, 10);
    expect(left.z).toBeCloseTo(1, 10);
  });

  it('returns zero for non-finite input', () => {
    expect(edgePanVector({ ...view, pointerX: NaN, pointerY: 5 })).toEqual({ x: 0, z: 0 });
    expect(edgePanVector({ ...view, pointerX: 5, pointerY: 5, yaw: Infinity })).toEqual({ x: 0, z: 0 });
  });
});

describe('drag pixel scale (workstream V)', () => {
  it('matches the perspective projection at the target', () => {
    // distance 150, fov 55deg, 800px viewport:
    // 2 * 150 * tan(55deg/2) / 800 ~= 0.1952 world units per px.
    const wpp = worldPerPixelAtTarget(150, (55 * Math.PI) / 180, 800);
    expect(wpp).toBeCloseTo(0.1952, 4);
    // Closer zoom = finer control; taller viewport = finer control.
    expect(worldPerPixelAtTarget(75, (55 * Math.PI) / 180, 800)).toBeCloseTo(wpp / 2, 10);
  });

  it('returns 0 for degenerate input instead of exploding', () => {
    expect(worldPerPixelAtTarget(0, 1, 800)).toBe(0);
    expect(worldPerPixelAtTarget(150, 1, 0)).toBe(0);
    expect(worldPerPixelAtTarget(NaN, 1, 800)).toBe(0);
    expect(worldPerPixelAtTarget(150, -1, 800)).toBe(0);
  });
});

describe('left-drag grab pan (workstream V)', () => {
  it('moves the map with the pointer at yaw 0', () => {
    const s = createCameraState();
    // Drag right: map follows right, target moves screen-left (-X).
    const r = panDragTarget(s, 100, 0, 0.5);
    expect(r.targetX).toBeCloseTo(-50, 10);
    expect(r.targetZ).toBeCloseTo(0, 10);
    // Drag down: map follows down, target moves screen-up (-Z at yaw 0).
    const d = panDragTarget(s, 0, 100, 0.5);
    expect(d.targetX).toBeCloseTo(0, 10);
    expect(d.targetZ).toBeCloseTo(-50, 10);
  });

  it('stays yaw-aware when rotated', () => {
    // yaw PI/2: screen-right is -Z, so dragging right moves target +Z.
    const s = { ...createCameraState(), yaw: Math.PI / 2 };
    const r = panDragTarget(s, 100, 0, 0.5);
    expect(r.targetX).toBeCloseTo(0, 10);
    expect(r.targetZ).toBeCloseTo(50, 10);
  });

  it('clamps to the map bounds and ignores bad scale', () => {
    const s = createCameraState();
    const far = panDragTarget(s, 100000, 0, 1);
    expect(far.targetX).toBe(-(MAP_HALF_SIZE - 4));
    expect(panDragTarget(s, 100, 0, 0)).toBe(s);
    expect(panDragTarget(s, 100, 0, -1)).toBe(s);
    expect(panDragTarget(s, NaN, 0, 0.5)).toBe(s);
    expect(panDragTarget(s, 0, 0, 0.5)).toEqual(s);
  });

  it('does not mutate the input state', () => {
    const s = createCameraState();
    panDragTarget(s, 100, 100, 0.5);
    expect(s.targetX).toBe(0);
    expect(s.targetZ).toBe(0);
  });
});

describe('middle-drag orbit (workstream V)', () => {
  it('maps horizontal drag to yaw and vertical drag to pitch', () => {
    const s = createCameraState();
    const o = orbitDrag(s, 200, 100);
    expect(o.yaw).toBeCloseTo(200 * ORBIT_YAW_PER_PX, 10);
    // pitch 0.9 + 100 * 0.005 = 1.4 -> clamped to CAMERA_MAX_PITCH.
    expect(o.pitch).toBe(CAMERA_MAX_PITCH);
    const up = orbitDrag(s, 0, -20);
    expect(up.yaw).toBeCloseTo(0, 10);
    expect(up.pitch).toBeCloseTo(0.9 - 20 * ORBIT_PITCH_PER_PX, 10);
  });

  it('clamps pitch to the readable band', () => {
    const s = createCameraState();
    expect(orbitDrag(s, 0, 100000).pitch).toBe(CAMERA_MAX_PITCH);
    expect(orbitDrag(s, 0, -100000).pitch).toBe(CAMERA_MIN_PITCH);
  });

  it('wraps yaw and ignores non-finite input', () => {
    const s = createCameraState();
    const wrapped = orbitDrag(s, -200, 0);
    expect(wrapped.yaw).toBeCloseTo(2 * Math.PI - 200 * ORBIT_YAW_PER_PX, 10);
    expect(orbitDrag(s, NaN, 0)).toBe(s);
    expect(orbitDrag(s, 0, Infinity)).toBe(s);
  });
});

describe('press-time drag disambiguation (workstream V)', () => {
  it('selects when no tool is armed, places when one is', () => {
    expect(pressDragKind(0, false)).toBe('select');
    expect(pressDragKind(0, true)).toBe('place');
  });

  it('ignores non-primary buttons (middle = orbit, right = cancel/order)', () => {
    expect(pressDragKind(1, false)).toBe('ignore');
    expect(pressDragKind(1, true)).toBe('ignore');
    expect(pressDragKind(2, false)).toBe('ignore');
    expect(pressDragKind(2, true)).toBe('ignore');
  });
});

describe('NaN camera-state guard (Phase 4 item 7)', () => {
  it('a healthy state passes through unchanged and is not a restore', () => {
    const good = createCameraState();
    const lastGood = { ...good, targetX: 10 };
    const res = guardCameraState(good, lastGood);
    expect(res.restored).toBe(false);
    expect(res.bad).toEqual([]);
    expect(res.state).toBe(good);
  });

  it('a NaN component is restored to the last known good', () => {
    const lastGood = createCameraState();
    const poisoned = { ...lastGood, targetX: NaN };
    const res = guardCameraState(poisoned, lastGood);
    expect(res.restored).toBe(true);
    expect(res.state).toBe(lastGood);
    expect(res.bad).toEqual(['targetX']);
  });

  it('Infinity is caught too, and every bad component is named', () => {
    const lastGood = createCameraState();
    const poisoned = { ...lastGood, distance: Infinity, yaw: NaN, pitch: -Infinity };
    const res = guardCameraState(poisoned, lastGood);
    expect(res.restored).toBe(true);
    expect(res.bad).toEqual(['distance', 'yaw', 'pitch']);
  });

  it('checkCameraState names exactly the non-finite components', () => {
    const s = createCameraState();
    expect(checkCameraState(s)).toEqual({ ok: true, bad: [] });
    expect(checkCameraState({ ...s, targetZ: NaN, pitch: Infinity })).toEqual({
      ok: false,
      bad: ['targetZ', 'pitch'],
    });
  });

  it('the guard never returns a poisoned state (the camera cannot wedge)', () => {
    const lastGood = createCameraState();
    for (const bad of [
      { ...lastGood, targetX: NaN },
      { ...lastGood, targetZ: NaN },
      { ...lastGood, distance: NaN },
      { ...lastGood, yaw: NaN },
      { ...lastGood, pitch: NaN },
    ]) {
      const res = guardCameraState(bad, lastGood);
      expect(checkCameraState(res.state).ok).toBe(true);
    }
  });
});
