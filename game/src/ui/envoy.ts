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
 * NOVATERRA — ui/envoy.ts — the envoy UI contract module (pure).
 *
 * Fun-audit Tier 4 (E1, 2026-10-02): the UI/render boundary for the
 * envoy ceremony (`sim/envoy.ts`, state on `world.diplomacy`). The
 * envoy banner (hud.ts) and the game.ts narration poll read the sim
 * only through this module — never the records directly.
 *
 * What it mirrors (single source of truth stays in the sim):
 *  - Banner visibility + copy key: inbound / waiting on an accepted
 *    ceasefire offer / waiting on a refusal / departing. The refusal
 *    reads as its own phase (verdict 'declined') so the banner can say
 *    "a refusal" instead of "an offer".
 *  - The answer countdown: whole seconds left of `deadlineTick`
 *    (null unless waiting) — the banner repaints on the second
 *    boundary, not every frame.
 *  - The diplomacy-section status line (one row; the banner is the
 *    primary UI).
 *
 * Defensive: every read tolerates hand-built worlds (missing or
 * malformed envoy state ⇒ null / hidden), so the contract test can
 * feed minimal fixtures.
 */
import type { World } from '../sim/world';
import { envoyActive } from '../sim/diplomacy';

/** The banner's display phase (the sim's state + the offer's verdict). */
export type EnvoyBannerPhase = 'inbound' | 'waiting' | 'refusalWaiting' | 'departing';

/** Everything the banner needs for one repaint. */
export interface EnvoyBannerView {
  phase: EnvoyBannerPhase;
  /** Whole seconds left on the answer window (null unless waiting). */
  secondsLeft: number | null;
  /** The envoy SUV's unit id (for the map ping). */
  unitId: number;
}

/**
 * The banner view for the human player, or null when no envoy visit
 * concerns them. Pure: no DOM, no sim mutation.
 */
export function envoyBannerView(world: World, owner: number): EnvoyBannerView | null {
  const d = world?.diplomacy;
  const envoy = d?.envoy ?? null;
  if (envoy === null || !envoyActive(world)) return null;
  if (envoy.offer.owner !== owner) return null;
  const state = envoy.state;
  if (state !== 'inbound' && state !== 'waiting' && state !== 'departing') return null;
  const phase: EnvoyBannerPhase =
    state === 'waiting' && envoy.offer.verdict === 'declined' ? 'refusalWaiting' : state;
  const secondsLeft =
    state === 'waiting' && envoy.deadlineTick > world.tick
      ? Math.ceil((envoy.deadlineTick - world.tick) / 30)
      : null;
  return { phase, secondsLeft, unitId: envoy.unitId };
}
