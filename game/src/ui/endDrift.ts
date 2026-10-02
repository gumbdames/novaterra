/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, version 3.0 of the License.
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
 * NOVATERRA — ui/endDrift.ts — victory/defeat end-screen camera drift
 * (exploration bet C6, 2026-10-02).
 *
 * Responsibilities:
 *  - While the end screen is up, the camera performs a slow cinematic
 *    auto-orbit around the battlefield it was looking at when the game
 *    ended (the overlay is semi-transparent, so the drift reads as a
 *    victory/defeat tableau). Player control is restored exactly on
 *    dismiss — the pre-show camera state is saved and re-applied.
 *
 * Pure and headless-safe: the state is (startYaw, elapsedSec) and the
 * yaw curve reuses `easeFactor` from ui/trailerCamera.ts (the same
 * easing primitives as the trailer's scripted camera). The game
 * controller (ui/game.ts) owns the state, advances it with frame dt,
 * and writes the resulting yaw back into its CameraState. Nothing here
 * touches three.js or the DOM.
 */

import { easeFactor } from './trailerCamera';

/** Slow orbit rate: one full revolution takes ~80 seconds. */
export const END_DRIFT_YAW_PER_SEC = (2 * Math.PI) / 80;

/** Rotation ramps from 0 to full rate over the first seconds (ease-in). */
export const END_DRIFT_EASE_SEC = 4;

/** Opaque drift state. */
export interface EndDrift {
  /** Camera yaw (radians) at the moment the end screen appeared. */
  readonly startYaw: number;
  /** Seconds of drift accumulated since (frame dt, not sim ticks). */
  readonly elapsedSec: number;
}

/** Begin a drift from the camera's current yaw. */
export function startEndDrift(startYaw: number): EndDrift {
  return { startYaw, elapsedSec: 0 };
}

/** Advance the drift by a frame's dt. Returns the new state. */
export function advanceEndDrift(d: EndDrift, dtSec: number): EndDrift {
  if (!(dtSec > 0)) return d;
  return { startYaw: d.startYaw, elapsedSec: d.elapsedSec + dtSec };
}

/**
 * The drifted yaw for a state: the orbit eases in over END_DRIFT_EASE_SEC
 * (via the shared smoothstep), then rotates at END_DRIFT_YAW_PER_SEC.
 * Pure — the same state always yields the same yaw.
 */
export function endDriftYaw(d: EndDrift): number {
  const eased = easeFactor('smooth', d.elapsedSec / END_DRIFT_EASE_SEC);
  return d.startYaw + END_DRIFT_YAW_PER_SEC * d.elapsedSec * eased;
}
