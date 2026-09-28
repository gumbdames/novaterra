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
 * NOVATERRA — camera controller tests (Phase 1, step 9).
 *
 * The camera state transitions are pure functions: pan/zoom/rotate/tilt
 * and clamping to the map bounds. The three.js seam (`applyCameraState`)
 * is not tested here (needs a GPU/DOM).
 */
import { describe, expect, it } from 'vitest';
import {
  CAMERA_MAX_DISTANCE,
  CAMERA_MAX_PITCH,
  CAMERA_MIN_DISTANCE,
  CAMERA_MIN_PITCH,
  clampCameraState,
  createCameraState,
  panCamera,
  rotateCamera,
  tiltCamera,
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
