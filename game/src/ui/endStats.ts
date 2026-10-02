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
 * NOVATERRA — ui/endStats.ts — end-of-game statistics (fun-audit B3,
 * 2026-10-02).
 *
 * The game asks for a long session and used to report back one
 * sentence — Juul's "juice as reward for effort." The pure builder
 * `endGameStatsOf` reads sim state defensively (every read `?? 0` /
 * optional-chained) and never writes sim state; the overlay
 * (ui/endscreen.ts) renders the lines. Kill/loss counts come from the
 * MuseController (the UI-side tracker), passed in by the caller —
 * this module never reaches into the controller.
 *
 * Copy lives in STRINGS.endStats (English-only, like the rest).
 */

import { getPlayer } from '../sim/city';
import { getAgeState } from '../sim/ages';
import { TICK_HZ } from '../sim/tick';
import type { World } from '../sim/world';
import { STRINGS, loc, fillLoc } from './strings';
import { formatCount } from './peaceful';

/** One game's record, for the victory/defeat overlay. */
export interface EndGameStats {
  /** Duration in sim ticks. */
  durationTicks: number;
  /** Enemy units destroyed (MuseController's kill count). */
  kills: number;
  /** Own units lost (MuseController's loss count). */
  losses: number;
  /** Completed buildings raised by the player. */
  buildingsRaised: number;
  /** Lifetime peak housed population (sim-tracked). */
  peakPopulation: number;
  /** Localized age name reached (e.g. "Industry"). */
  ageName: string;
}

/** mm:ss from sim ticks (30 Hz). */
export function formatDuration(ticks: number): string {
  const totalSeconds = Math.max(0, Math.floor(ticks / TICK_HZ));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The end-of-game record for this world. Pure; never throws on partial
 * worlds. `owner` is the side the stats describe (the human in
 * skirmish).
 */
export function endGameStatsOf(world: World, owner: number, kills: number, losses: number): EndGameStats {
  const player = getPlayer(world.city, owner);
  let buildingsRaised = 0;
  for (const b of world.city.buildings ?? []) {
    if (b.owner === owner && (b.progress ?? 0) >= 1) buildingsRaised += 1;
  }
  const age = getAgeState(world, owner).age as string;
  const ageNames = STRINGS.ageNames as Record<string, { en: string } | undefined>;
  const ageEntry = ageNames[age] ?? ageNames['foundation'] ?? { en: age };
  return {
    durationTicks: world.tick ?? 0,
    kills: Math.max(0, Math.floor(kills)),
    losses: Math.max(0, Math.floor(losses)),
    buildingsRaised,
    peakPopulation: Math.max(0, Math.floor(player?.peakPopulation ?? player?.population ?? 0)),
    ageName: loc(ageEntry),
  };
}

/**
 * The stat block lines, in display order: "27 enemy units destroyed ·
 * 11 lost · 41:23 · peak population 1,204 · 38 buildings raised ·
 * reached the Industry age". One string per line — the overlay joins
 * them.
 */
export function endStatsLines(stats: EndGameStats): string[] {
  const s = STRINGS.endStats;
  return [
    fillLoc(s.kills, { n: formatCount(stats.kills) }),
    fillLoc(s.losses, { n: formatCount(stats.losses) }),
    fillLoc(s.duration, { t: formatDuration(stats.durationTicks) }),
    fillLoc(s.buildings, { n: formatCount(stats.buildingsRaised) }),
    fillLoc(s.peakPopulation, { n: formatCount(stats.peakPopulation) }),
    fillLoc(s.age, { age: stats.ageName }),
  ];
}
