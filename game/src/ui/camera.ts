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
 *  - pan: WASD/arrows, edge pan (all four screen edges), left-drag
 *    grab-pan when no placement tool is active
 *  - zoom: mouse wheel (distance 30..400)
 *  - rotate: Q/E keys, middle-mouse drag orbits (horizontal = yaw,
 *    vertical = pitch, clamped to the pitch band below); right-drag is
 *    not a camera gesture (right-click cancels placement / orders)
 *  - tilt: R/F keys adjust pitch inside the same clamped band
 *  - target clamped to the map bounds; smoothing applied by the caller
 *    (the state itself is exact — smoothing lives in the frame loop).
 *
 * Gesture ownership (the airtight rule, enforced by game.ts):
 *  - A primary-button press snapshots `pressDragKind(button,
 *    placementActive)` at press time and the gesture keeps that meaning
 *    until release: 'pan' grabs the map, 'place' belongs to the armed
 *    tool. Arming or cancelling a tool mid-gesture never flips a gesture
 *    already in flight.
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

/** Screen-edge zone (client px) that triggers edge pan. */
export const EDGE_PAN_PX = 10;

/** Radians of orbit per pixel of middle-drag: ~1250px for a full turn. */
export const ORBIT_YAW_PER_PX = 0.005;
/** Radians of pitch per pixel of middle-drag (clamped to the pitch band). */
export const ORBIT_PITCH_PER_PX = 0.005;

/** Input for the pure edge-pan direction computation. */
export interface EdgePanInput {
  /** Pointer position in client px. */
  pointerX: number;
  pointerY: number;
  /** Viewport size in client px. */
  viewWidth: number;
  viewHeight: number;
  /** Current camera yaw (radians) — pan axes are yaw-aware. */
  yaw: number;
}

/**
 * Edge-pan direction from pointer proximity to a screen edge. Returns the
 * world-space pan direction (unnormalized; `{x: 0, z: 0}` when the pointer
 * is not inside the edge zone). Screen-up pans along the camera forward
 * vector, screen-left against the camera right vector — the same axes the
 * WASD/arrows key pan uses. Pure: the controller feeds it the pointer
 * position every frame; the 10px default matches the shipped feel.
 */
export function edgePanVector(p: EdgePanInput, edgePx: number = EDGE_PAN_PX): { x: number; z: number } {
  if (
    !Number.isFinite(p.pointerX) || !Number.isFinite(p.pointerY) ||
    !Number.isFinite(p.viewWidth) || !Number.isFinite(p.viewHeight) ||
    !Number.isFinite(p.yaw) || !Number.isFinite(edgePx) || edgePx < 0
  ) {
    return { x: 0, z: 0 };
  }
  const forward = { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) };
  const right = { x: Math.cos(p.yaw), z: -Math.sin(p.yaw) };
  let fx = 0;
  let fz = 0;
  if (p.pointerX < edgePx) { fx -= right.x; fz -= right.z; }
  if (p.pointerX > p.viewWidth - edgePx) { fx += right.x; fz += right.z; }
  if (p.pointerY < edgePx) { fx += forward.x; fz += forward.z; }
  if (p.pointerY > p.viewHeight - edgePx) { fx -= forward.x; fz -= forward.z; }
  return { x: fx, z: fz };
}

/**
 * World units per screen pixel at the camera target plane, from the
 * camera distance, vertical field of view (radians) and viewport height
 * (px). The left-drag grab-pan scales pointer travel by this so the map
 * follows the pointer 1:1 at the target. Returns 0 for degenerate input
 * (the pan then no-ops instead of exploding).
 */
export function worldPerPixelAtTarget(
  distance: number,
  fovRadians: number,
  viewportHeightPx: number,
): number {
  if (
    !Number.isFinite(distance) || !Number.isFinite(fovRadians) ||
    !Number.isFinite(viewportHeightPx) ||
    distance <= 0 || fovRadians <= 0 || viewportHeightPx <= 0
  ) {
    return 0;
  }
  return (2 * distance * Math.tan(fovRadians / 2)) / viewportHeightPx;
}

/**
 * Grab-and-drag pan: convert a screen-space pointer delta (px, +x right,
 * +y down) into a world-space target pan. The map follows the pointer —
 * dragging right moves the target screen-left, dragging down moves it
 * screen-up — using the same yaw-aware axes as the key/edge pan.
 * Non-positive or non-finite scale leaves the state unchanged.
 */
export function panDragTarget(
  state: CameraState,
  dxPx: number,
  dyPx: number,
  worldPerPixel: number,
): CameraState {
  if (
    !Number.isFinite(dxPx) || !Number.isFinite(dyPx) ||
    !Number.isFinite(worldPerPixel) || worldPerPixel <= 0
  ) {
    return state;
  }
  const right = { x: Math.cos(state.yaw), z: -Math.sin(state.yaw) };
  const forward = { x: -Math.sin(state.yaw), z: -Math.cos(state.yaw) };
  return panCamera(
    state,
    -right.x * dxPx * worldPerPixel + forward.x * dyPx * worldPerPixel,
    -right.z * dxPx * worldPerPixel + forward.z * dyPx * worldPerPixel,
  );
}

/**
 * Middle-drag orbit: horizontal pointer travel yaws the camera, vertical
 * travel pitches it (grab semantics — drag right to swing the view right,
 * drag down to tilt toward top-down). Pitch stays inside the readable
 * [CAMERA_MIN_PITCH, CAMERA_MAX_PITCH] band via tiltCamera.
 */
export function orbitDrag(state: CameraState, dxPx: number, dyPx: number): CameraState {
  if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return state;
  return tiltCamera(
    rotateCamera(state, dxPx * ORBIT_YAW_PER_PX),
    dyPx * ORBIT_PITCH_PER_PX,
  );
}

/** What a primary-button press on the canvas means. */
export type PressDragKind = 'pan' | 'place' | 'select' | 'ignore';

/**
 * Decide what a canvas press means, from the press-time inputs only:
 *  - 'ignore': not the primary button — the controller owns those
 *    presses (middle = orbit/pan, right = pan / cancel / context order).
 *  - 'place': a placement tool is armed — the drag belongs to the tool
 *    (road/line/pipe drag-paint, zone rectangle, train/build
 *    place-at-release).
 *  - 'select': no tool armed — the drag box-selects units in the drawn
 *    marquee rectangle (RTS standard).
 *
 * The controller snapshots this at pointerdown and never re-evaluates
 * mid-gesture: arming or cancelling a tool while a drag is in flight
 * cannot flip the gesture's meaning.
 */
export function pressDragKind(button: number, placementActive: boolean): PressDragKind {
  if (button !== 0) return 'ignore';
  return placementActive ? 'place' : 'select';
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
 * Phase 4 hardening (2026-09-30): which camera components are non-finite.
 * A poisoned component (NaN from a bad pointer delta, Infinity from a
 * corrupt save) would otherwise wedge the camera permanently — NaN
 * propagates through every later pan/zoom and the clamp can't fix it.
 */
export interface CameraStateHealth {
  ok: boolean;
  /** Names of the non-finite components (empty when ok). */
  bad: string[];
}

/** Check every numeric camera component for NaN/Infinity. Pure. */
export function checkCameraState(state: CameraState): CameraStateHealth {
  const bad: string[] = [];
  const comps: Array<[string, number]> = [
    ['targetX', state.targetX],
    ['targetZ', state.targetZ],
    ['distance', state.distance],
    ['yaw', state.yaw],
    ['pitch', state.pitch],
  ];
  for (const [name, value] of comps) {
    if (!Number.isFinite(value)) bad.push(name);
  }
  return { ok: bad.length === 0, bad };
}

/**
 * Guard a camera state before it is applied: a healthy state passes
 * through unchanged; a poisoned one is replaced by the last known good.
 * Pure — the game controller logs loudly (tick + armed tool + bad
 * components) around the restore and remembers the new good state.
 */
export function guardCameraState(
  state: CameraState,
  lastGood: CameraState,
): { state: CameraState; restored: boolean; bad: string[] } {
  const health = checkCameraState(state);
  if (health.ok) return { state, restored: false, bad: [] };
  return { state: lastGood, restored: true, bad: health.bad };
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

/**
 * Screen shake (roadmap B13, 2026-10-02) — explosions rattle the camera.
 * Trauma 0..1 accumulates per explosion (scaled by distance from the
 * camera target) and decays; the applied offset scales with trauma² so
 * small hits barely register and big ones thump. The noise is a
 * deterministic sin/cos mix of wall-clock time — render-only, no RNG,
 * no sim impact. Pure — headless-tested.
 */

/** Trauma above this is clamped (a full barrage still reads as one). */
export const SHAKE_MAX_TRAUMA = 1;
/** Trauma decayed per second. */
export const SHAKE_DECAY_PER_SEC = 1.6;
/** Camera offset in world units at full trauma. */
export const SHAKE_FULL_OFFSET = 2.4;

/** Add explosion trauma, clamped to [0, 1]. */
export function addShakeTrauma(current: number, amount: number): number {
  return Math.min(
    SHAKE_MAX_TRAUMA,
    Math.max(0, current + amount),
  );
}

/** Decay trauma over dt seconds. */
export function decayShakeTrauma(current: number, dtSec: number): number {
  return Math.max(0, current - SHAKE_DECAY_PER_SEC * dtSec);
}

/**
 * Camera offset for the current trauma at `timeSec`. Below 0.02 trauma
 * the offset is exactly zero (lets the controller skip the re-apply).
 */
export function shakeOffset(
  trauma: number,
  timeSec: number,
): { dx: number; dy: number } {
  if (trauma < 0.02) return { dx: 0, dy: 0 };
  const s = trauma * trauma * SHAKE_FULL_OFFSET;
  return {
    dx: s * Math.sin(timeSec * 39.7) * Math.cos(timeSec * 17.3),
    dy: s * Math.sin(timeSec * 44.3 + 1.7) * Math.cos(timeSec * 23.9),
  };
}
