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
 * NOVATERRA — render/ambientTime.ts — the shared ambient-animation clock
 * (living nature, 0.1 Alpha).
 *
 * Every decorative motion in the game — tree sway, water flow, bird wing
 * flap — reads this ONE uniform. It is driven by SIM ticks, not wall
 * clock, so ambient motion pauses exactly when the game pauses (the same
 * rule workstream P's pedestrians follow: poses are pure functions of the
 * tick). Deterministic: same tick ⇒ same uniform ⇒ same shader pose on
 * every machine.
 *
 * Backend note: the game renders through three.js r186 `WebGPURenderer`
 * on both paths (native WebGPU, or the same class with `forceWebGL` for
 * the WebGL2 fallback — see render/renderer.ts), whose material pipeline
 * is node-based. Assigning TSL nodes (`positionNode`, `colorNode`) onto
 * classic `three` materials works because `WebGPURenderer` converts
 * materials with `fromMaterial`, which copies every own property —
 * including a dynamically assigned node — onto the node material. That
 * makes one TSL injection correct on both backends, where the legacy
 * `onBeforeCompile` GLSL hook would silently apply to neither (it is a
 * WebGLRenderer-only API and the game never constructs one).
 *
 * Perf: one float uniform write per frame, zero CPU per vertex/instance.
 * Import-safe under Node/vitest: `three/tsl` touches no DOM at import.
 */

import { uniform } from 'three/tsl';

import { TICK_MS } from '../sim/tick';

/**
 * The ambient clock, in seconds of sim time. Shared by every swaying /
 * flowing / flapping material — one update per frame fans out to all of
 * them with no per-material bookkeeping.
 */
export const ambientTimeSeconds = uniform(0);

/** Seconds of sim time for a tick count (30 ticks = 1 second). Pure. */
export function ambientSecondsForTick(tick: number): number {
  return (tick * TICK_MS) / 1000;
}

/**
 * Advance the ambient clock. Called once per frame from the render sync
 * (`EntityRenderer.sync`); when the game is paused the tick — and so the
 * wind, the water, and the birds — stands still.
 */
export function setAmbientTimeSeconds(t: number): void {
  ambientTimeSeconds.value = t;
}
