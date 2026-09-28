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
 * NOVATERRA — ui/camera.ts — RTS camera controller.
 *
 * Responsibilities:
 *  - Own the camera state (orbit target + distance + yaw + pitch) as plain
 *    data. All state transitions (`panCamera`, `zoomCamera`, `rotateCamera`)
 *    are pure functions — unit-tested, no three.js involved.
 *  - `applyCameraState` is the single three.js seam: it points a
 *    PerspectiveCamera at the state. Render-side only.
 *
 * Controls (wired by ui/game.ts):
 *  - pan: WASD/arrows, edge pan, middle-mouse drag
 *  - zoom: mouse wheel (distance 30..400)
 *  - rotate: Q/E keys, right-mouse drag (yaw); pitch fixed at a readable
 *    RTS angle with slight wheel-independent tilt limits
 *  - target clamped to the map bounds; smoothing applied by the caller
 *    (the state itself is exact — smoothing lives in the frame loop).
 *
 * The pure half is safe under Node/vitest; only `applyCameraState` needs
 * three.js (imported type-only, so the module still imports headless).
 */

import type { PerspectiveCamera } from 'three';
import { MAP_HALF_SIZE } from '../sim/city';

/** Orbit-style RTS camera state. Plain data. */
export interface CameraState {
  /** Ground point the camera looks at (world units). */
  targetX: number;
  targetZ: number;
  /** Distance from target to camera. */
  distance: number;
  /** Orbit angle around the target, radians. 0 = looking from +Z. */
  yaw: number;
  /** Tilt above the horizon, radians. PI/2 = straight down. */
  pitch: number;
}

export const CAMERA_MIN_DISTANCE = 30;
export const CAMERA_MAX_DISTANCE = 400;
export const CAMERA_MIN_PITCH = 0.35;
export const CAMERA_MAX_PITCH = 1.25;
const TWO_PI = Math.PI * 2;

/** Fresh camera: centered on the map at a classic RTS angle. */
export function createCameraState(): CameraState {
  return { targetX: 0, targetZ: 0, distance: 150, yaw: 0, pitch: 0.9 };
}

/** Pan the target by (dx, dz) in world space, clamped to the map. */
export function panCamera(state: CameraState, dx: number, dz: number): CameraState {
  return clampCameraState({
    ...state,
    targetX: state.targetX + dx,
    targetZ: state.targetZ + dz,
  });
}

/** Zoom by a multiplicative factor (<1 zooms in). Clamped to min/max. */
export function zoomCamera(state: CameraState, factor: number): CameraState {
  if (!Number.isFinite(factor) || factor <= 0) return state;
  return {
    ...state,
    distance: Math.min(
      CAMERA_MAX_DISTANCE,
      Math.max(CAMERA_MIN_DISTANCE, state.distance * factor),
    ),
  };
}

/** Rotate the orbit angle by dYaw radians (wraps at 2π). */
export function rotateCamera(state: CameraState, dYaw: number): CameraState {
  if (!Number.isFinite(dYaw)) return state;
  let yaw = (state.yaw + dYaw) % TWO_PI;
  if (yaw < 0) yaw += TWO_PI;
  return { ...state, yaw };
}

/** Tilt the camera; clamped to a readable band (never horizon, never top-down). */
export function tiltCamera(state: CameraState, dPitch: number): CameraState {
  if (!Number.isFinite(dPitch)) return state;
  return {
    ...state,
    pitch: Math.min(CAMERA_MAX_PITCH, Math.max(CAMERA_MIN_PITCH, state.pitch + dPitch)),
  };
}

/** Clamp target inside the map and pitch/distance into range. */
export function clampCameraState(state: CameraState): CameraState {
  const bound = MAP_HALF_SIZE - 4;
  let yaw = state.yaw % TWO_PI;
  if (yaw < 0) yaw += TWO_PI;
  return {
    targetX: Math.min(bound, Math.max(-bound, state.targetX)),
    targetZ: Math.min(bound, Math.max(-bound, state.targetZ)),
    distance: Math.min(CAMERA_MAX_DISTANCE, Math.max(CAMERA_MIN_DISTANCE, state.distance)),
    yaw,
    pitch: Math.min(CAMERA_MAX_PITCH, Math.max(CAMERA_MIN_PITCH, state.pitch)),
  };
}

/**
 * Point a three.js camera at the state. The camera sits `distance` away
 * from the target along the yaw/pitch orbit and looks at the target.
 * Render-side only — never touches the sim.
 */
export function applyCameraState(cam: PerspectiveCamera, state: CameraState): void {
  const s = clampCameraState(state);
  const horizontal = Math.cos(s.pitch) * s.distance;
  cam.position.set(
    s.targetX + Math.sin(s.yaw) * horizontal,
    Math.sin(s.pitch) * s.distance,
    s.targetZ + Math.cos(s.yaw) * horizontal,
  );
  cam.lookAt(s.targetX, 0, s.targetZ);
}
