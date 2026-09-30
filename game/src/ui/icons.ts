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
 * NOVATERRA — ui/icons.ts — inline SVG icon set for menus and palettes.
 *
 * Responsibilities:
 *  - One glyph per palette/menu item: all 28 units, all 28 buildings, the
 *    5 build tools, map presets (by water fraction), AI difficulties
 *    (rank chevrons), and the main/pause menu actions.
 *  - Icons are returned as SVG markup strings (24×24 viewBox, stroke =
 *    `currentColor`), so callers drop them into any DOM element with
 *    `innerHTML`; CSS sizes them. Map glyphs use small fixed land/water
 *    fills on purpose — they read as terrain, not line art.
 *
 * Approach decision (2026-09-30, user directive: menus must show icons AND
 * text):
 *  - CHOSEN: hand-made inline SVGs. Zero download bloat (a few KB in the
 *    bundle, no network), crisp at any button size, available the moment
 *    the menu renders (before game assets load), no licensing to vet, and
 *    one coherent style. Bold silhouettes stay legible at 32–48px where
 *    tiny 3D renders turn to mud. `Record<UnitKind, …>` /
 *    `Record<BuildingKind, …>` make missing icons a compile error, and a
 *    new unit/building is one ~1-line glyph in the tables below.
 *  - REJECTED: build-time rendered thumbnails from the GLB/procedural
 *    models. Would need a headless-render pipeline in the build (56 framed
 *    shots, per-model camera rig), ~150–400KB of PNGs that must download
 *    before the menu can show icons, and async loading complexity — for
 *    icons that are *less* legible at button size than silhouettes.
 *  - REJECTED: a CC0 icon set. No single CC0 set covers this roster
 *    (MLRS, desalination plant, storm array, …) in one consistent style;
 *    vetting 56 per-file licenses is more work than drawing a coherent
 *    set, with a worse style fit.
 *
 * Accessibility: every glyph carries `aria-hidden="true"` — the icon is
 * decorative and the button's text label (or tooltip) is the accessible
 * name. Callers must keep the text label next to the icon (icons AND
 * text, per the directive), never icon-only.
 *
 * Pure module: no DOM, no three.js. Safe under Node/vitest.
 */

import type { UnitKind } from '../sim/units';
import type { BuildingKind } from '../sim/city';
import type { AIDifficulty } from '../sim/ai';

/**
 * 24×24 line-art wrapper. `currentColor` lets the button's CSS (including
 * the locked/disabled dimming) drive the icon color for free.
 */
function svg(body: string, strokeWidth = 2): string {
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true" focusable="false">${body}</svg>`
  );
}

// ---------------------------------------------------------------------------
// Units — 28 glyphs, one per UnitKind (silhouette reads the domain at a
// glance: person / tracked hull / aircraft / ship hull).
// ---------------------------------------------------------------------------

/** Every UnitKind must appear here exactly once (tsc enforces it). */
const UNIT_ICONS: Record<UnitKind, string> = {
  engineer:
    '<path d="M5 12a7 7 0 0 1 14 0"/><path d="M3 12h18"/><path d="M12 5v4"/>',
  rifles:
    '<path d="M5 19 14 10"/><path d="M19 19 10 10"/><path d="M14 10l4-6"/><path d="M10 10l-4-6"/>',
  sniperTeam:
    '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>' +
    '<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>',
  combatMedic:
    '<circle cx="12" cy="12" r="9"/><path d="M12 8.5v7M8.5 12h7"/>',
  tank:
    '<rect x="3" y="12" width="13" height="5" rx="1.5"/><path d="M8.5 12V9H14v3"/>' +
    '<path d="M14 10.5h7"/><circle cx="6.5" cy="19.5" r="1.6"/><circle cx="12.5" cy="19.5" r="1.6"/>',
  apc:
    '<rect x="3" y="10" width="14" height="7" rx="1.5"/><path d="M17 12.5h4v4.5h-4"/>' +
    '<circle cx="7" cy="19.5" r="1.6"/><circle cx="12" cy="19.5" r="1.6"/><circle cx="17" cy="19.5" r="1.6"/>',
  tankDestroyer:
    '<path d="M3 17v-5h13v5"/><path d="M16 14.5h6"/><path d="M7 12l2-4h6l2 4"/>' +
    '<circle cx="6.5" cy="19.5" r="1.5"/><circle cx="12.5" cy="19.5" r="1.5"/>',
  artillery:
    '<circle cx="9" cy="15" r="4"/><path d="M11.8 12.2 20 4.5"/><path d="M9 15 5 21"/><path d="M3 21h9"/>',
  mlrs:
    '<rect x="2" y="15" width="10" height="3.5" rx="1"/><rect x="13" y="6" width="8" height="9" rx="1"/>' +
    '<circle cx="5.5" cy="20" r="1.5"/><circle cx="10" cy="20" r="1.5"/>',
  aa:
    '<path d="M12 21v-7"/><path d="M12 14 6 5"/><path d="M12 14l6-9"/><path d="M8 21h8"/>',
  hauler:
    '<rect x="2" y="10" width="11" height="7" rx="1"/><path d="M13 12h3.5L20 15.5V17h-7"/>' +
    '<circle cx="6.5" cy="19" r="1.8"/><circle cx="16" cy="19" r="1.8"/>',
  hq:
    '<rect x="2" y="12" width="12" height="6" rx="1"/><path d="M14 13.5h4l2 2.5v2h-6"/>' +
    '<path d="M8 12V5"/><path d="M8 5.5h4.5L11 7l1.5 1.5H8"/>' +
    '<circle cx="6" cy="20" r="1.6"/><circle cx="12" cy="20" r="1.6"/>',
  spectre: '<path d="M12 4l8 16-8-3.5L4 20Z"/><path d="M12 4v9"/>',
  fighter:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 8.5 3.5 15l4-.5"/>' +
    '<path d="M12 8.5l8.5 6.5-4-.5"/><path d="M9.5 20.5 8 22M14.5 20.5 16 22"/>',
  fighterBomber:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 8.5 3.5 15l4-.5"/>' +
    '<path d="M12 8.5l8.5 6.5-4-.5"/>' +
    '<circle cx="18.5" cy="18" r="1.6" fill="currentColor" stroke="none"/>',
  attackHeli:
    '<ellipse cx="12" cy="14.5" rx="4" ry="2.8"/><path d="M3 8.5h18"/><path d="M12 8.5v3.5"/>' +
    '<path d="M16 14.5h5.5"/><path d="M21.5 12v5"/>',
  drone:
    '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/><circle cx="12" cy="12" r="2.2"/>' +
    '<circle cx="5" cy="5" r="1.7"/><circle cx="19" cy="5" r="1.7"/>' +
    '<circle cx="5" cy="19" r="1.7"/><circle cx="19" cy="19" r="1.7"/>',
  awacs:
    '<path d="M2.5 16h19"/><path d="M12 16v-1.5"/><ellipse cx="12" cy="12.5" rx="3.8" ry="1.9"/>' +
    '<path d="M19 16l1.5-4"/>',
  transport:
    '<path d="M12 3v18"/><path d="M3.5 11.5h17"/><path d="M8.5 21l3.5-2.5L15.5 21"/>',
  patrolBoat:
    '<path d="M3 13.5h18l-2.5 5h-13Z"/><rect x="10" y="9.5" width="5" height="4"/>' +
    '<path d="M12.5 9.5V5.5"/>',
  missileBoat:
    '<path d="M3 14.5h18l-2.5 5h-13Z"/><rect x="8" y="10.5" width="8" height="4" rx="1"/>' +
    '<path d="M10 10.5 8.5 6M14 10.5l1.5-4.5"/>',
  frigate:
    '<path d="M2.5 14h19l-2.5 5h-14Z"/><rect x="9" y="10" width="6" height="4"/>' +
    '<path d="M12 10V4.5"/><path d="M5.5 14 3 11.5"/>',
  submarine:
    '<path d="M2.5 14c0-3 4.2-5 9.5-5s9.5 2 9.5 5-4.2 5-9.5 5-9.5-2-9.5-5Z"/>' +
    '<rect x="10" y="5" width="4" height="4"/><path d="M12 5V3"/>',
  destroyer:
    '<path d="M2.5 14h19l-2.5 5h-14Z"/><rect x="5" y="10.5" width="4" height="3.5"/>' +
    '<path d="M5 12H2.5"/><rect x="15" y="10.5" width="4" height="3.5"/><path d="M19 12h2.5"/>' +
    '<path d="M12 14V6"/>',
  carrier:
    '<path d="M2.5 11.5h19"/><path d="M4.5 11.5 6.5 18h11l2-6.5"/>' +
    '<rect x="15.5" y="6.5" width="3.5" height="5"/>',
  commandShip:
    '<path d="M2.5 14.5h19l-2.5 5h-14Z"/><rect x="8" y="8" width="8" height="6.5"/>' +
    '<path d="M10 8V4.5M14 8V4.5"/>',
  transportShip:
    '<path d="M2.5 15h19l-2.5 5h-14Z"/><rect x="5.5" y="10" width="4.5" height="5"/>' +
    '<rect x="11" y="10" width="4.5" height="5"/><rect x="8" y="6.5" width="4.5" height="3.5"/>',
  fishingBoat:
    '<path d="M3 14.5h18l-2.5 5h-13Z"/><rect x="12.5" y="10" width="4" height="4.5"/>' +
    '<path d="M14.5 10 20 4"/><path d="M20 4v3.5"/>',
};

// ---------------------------------------------------------------------------
// Buildings — 28 glyphs, one per BuildingKind.
// ---------------------------------------------------------------------------

/** Every BuildingKind must appear here exactly once (tsc enforces it). */
const BUILDING_ICONS: Record<BuildingKind, string> = {
  house:
    '<path d="M4 11 12 4l8 7"/><rect x="6" y="11" width="12" height="9"/><path d="M10 20v-4.5h4V20"/>',
  apartment:
    '<rect x="6" y="3" width="12" height="18" rx="1"/>' +
    '<path d="M9.5 7h1.5M13 7h1.5M9.5 11h1.5M13 11h1.5M9.5 15h1.5M13 15h1.5"/>' +
    '<path d="M10.5 21v-2.5h3V21"/>',
  school:
    '<rect x="5" y="10" width="14" height="10"/><path d="M12 10V4"/>' +
    '<path d="M12 4.5h5.5L16 6.5l1.5 2H12"/><path d="M9 20v-4h6v4"/>',
  shop:
    '<path d="M4 9.5 6 5h12l2 4.5"/><path d="M4 9.5h16"/>' +
    '<rect x="5" y="9.5" width="14" height="10.5"/><path d="M10 20v-5h4v5"/>',
  market:
    '<path d="M3.5 9.5h17l-1.5 4h-14Z"/><path d="M6 13.5V20M18 13.5V20"/>' +
    '<path d="M4 9.5 5.5 5h13L20 9.5"/>',
  lab:
    '<path d="M10 3h4"/><path d="M11 3v5.2L5.2 19a1.2 1.2 0 0 0 1.1 1.7h11.4a1.2 1.2 0 0 0 1.1-1.7L13 8.2V3"/>' +
    '<circle cx="11" cy="15" r="1.1"/><circle cx="13.6" cy="17.2" r="1.1"/>',
  mediaCenter:
    '<path d="M12 21v-9"/><path d="M8.5 21 12 12l3.5 9"/>' +
    '<circle cx="12" cy="9.5" r="1.6" fill="currentColor" stroke="none"/>' +
    '<path d="M7.5 5.5a6.5 6.5 0 0 1 9 0M5 3a10 10 0 0 1 14 0"/>',
  hospital: '<rect x="5" y="6.5" width="14" height="14"/><path d="M12 10v7M8.5 13.5h7"/>',
  university:
    '<path d="M3 9.5 12 4l9 5.5"/><path d="M6 9.5V19M10 9.5V19M14 9.5V19M18 9.5V19"/>' +
    '<path d="M4 20.5h16"/>',
  factory:
    '<path d="M3 21v-9.5L9 15V9.5l6 5.5V9.5l6 5.5V21Z"/><path d="M17 12V4.5h3V13"/>',
  farm:
    '<path d="M4 20v-9.5L12 4l8 6.5V20"/><path d="M4 10.5h16"/>' +
    '<path d="M9.5 20v-5.5h5V20"/><path d="M16.5 8.5h4V20"/>',
  quarry: '<path d="M4 5.5h16"/><path d="M6.5 10.5h11"/><path d="M9 15.5h6"/><path d="M11 20.5h2"/>',
  oilRefinery:
    '<rect x="9.5" y="4" width="5" height="17" rx="1"/><path d="M9.5 9H4.5V21M14.5 13h5V21"/>' +
    '<path d="M12 4V2.5"/>',
  recyclingCenter: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 3.5V8h-4.5"/>',
  barracks:
    '<rect x="4" y="10" width="16" height="10"/><path d="M4 10l8-6 8 6"/>' +
    '<path d="M12 12.6l.59 1.59 1.69.07-1.33 1.05.46 1.63-1.41-.83-1.41.83.46-1.63-1.33-1.05 1.69-.07Z" fill="currentColor" stroke="none"/>',
  // Phase 1 (veterancy): academy hall with a rank chevron above the roof
  // (barracks keeps the star — the chevron reads "school for veterans").
  militaryAcademy:
    '<rect x="4" y="11" width="16" height="9"/><path d="M4 11l8-6 8 6"/>' +
    '<path d="M8.5 7.5 12 4.8l3.5 2.7"/>',
  warFactory:
    '<path d="M3 21v-9.5L9 15V9.5l6 5.5V9.5l6 5.5V21Z"/><circle cx="12" cy="16.5" r="2.6"/>' +
    '<path d="M12 12.5v-1.8M12 20.5v-1.4M8 16.5H6.2M17.8 16.5H16M9.2 13.7l-1.3-1.3M16.1 20.6l-1.3-1.3M14.8 13.7l1.3-1.3M7.9 20.6l1.3-1.3"/>',
  powerPlant:
    '<path d="M9 4h6"/><path d="M9 4c.5 5.5-1 11-3.5 17h13C16 15 14.5 9.5 15 4"/>' +
    '<path d="M8 12.5h8"/>',
  solarFarm:
    '<g transform="rotate(-12 11 15)"><rect x="4" y="11" width="14" height="8" rx="1"/>' +
    '<path d="M4 15h14M9 11v8M14 11v8"/></g>' +
    '<circle cx="18.5" cy="5.5" r="2.4"/><path d="M18.5 1v1.4M18.5 8.6V10M14 5.5h1.4M21.6 5.5H23"/>',
  nuclearPlant:
    '<circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/>' +
    '<ellipse cx="12" cy="12" rx="8" ry="3.1"/>' +
    '<ellipse cx="12" cy="12" rx="8" ry="3.1" transform="rotate(60 12 12)"/>' +
    '<ellipse cx="12" cy="12" rx="8" ry="3.1" transform="rotate(120 12 12)"/>',
  waterPump:
    '<path d="M5 21V9h10"/><path d="M15 9v3.5"/>' +
    '<path d="M12 13.5c2 2.6 3.4 4.3 3.4 6a3.4 3.4 0 0 1-6.8 0c0-1.7 1.4-3.4 3.4-6Z"/>',
  desalination:
    '<path d="M12 3.5c2.2 2.9 3.8 4.8 3.8 6.8a3.8 3.8 0 0 1-7.6 0c0-2 1.6-3.9 3.8-6.8Z"/>' +
    '<path d="M4 18.5c2-1.6 4-1.6 6 0s4 1.6 6 0 3-1.4 4-.8"/>',
  shipyard:
    '<path d="M5 21V6M19 21V6M5 6h14"/><path d="M12 6v4.5"/>' +
    '<rect x="10.5" y="12.5" width="3" height="2.5"/>',
  navalYard:
    '<circle cx="12" cy="5" r="2"/><path d="M12 7v14"/><path d="M12 11H7M12 11h5"/>' +
    '<path d="M4.5 13a7.5 7.5 0 0 0 15 0"/>',
  airfield:
    '<path d="M8 3 5 21M16 3l3 21"/><path d="M12 6.5v2.5M12 11.5v2.5M12 16.5v2.5"/>',
  radarStation:
    '<path d="M4 13.5a9.5 9.5 0 0 1 13-8.5"/><path d="M4 13.5h9.5"/>' +
    '<path d="M8.5 13.5V21"/><path d="M5.5 21h6"/><path d="M16.5 7.5a4.5 4.5 0 0 1 3 2.5"/>',
  monument:
    '<path d="M10 4h4l1.2 14H8.8Z"/><path d="M12 4V2"/><path d="M7.5 21h9"/><path d="M8.5 18h7"/>',
  aegisControl:
    '<path d="M12 3l7 2.8v6.1c0 4.8-3.3 7.7-7 9.1-3.7-1.4-7-4.3-7-9.1V5.8Z"/>' +
    '<path d="M9 11.8l2.2 2.2 4-4.2"/>',
  stormArray:
    '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10Z"/>' +
    '<path d="M13 12.5 10 17.5h2.6L11.4 21" fill="currentColor" stroke="none"/>',
};

// ---------------------------------------------------------------------------
// Build-palette tools (road / zones / demolish).
// ---------------------------------------------------------------------------

/** The five non-building tools in the build palette's tool row. */
export type PaletteToolIcon = 'road' | 'zoneR' | 'zoneC' | 'zoneI' | 'demolish';

const TOOL_ICONS: Record<PaletteToolIcon, string> = {
  road: '<path d="M9 2.5v19M15 2.5v19"/><path d="M12 5.5v3M12 10.5v3M12 15.5v3"/>',
  zoneR:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3.5 2.5"/>' +
    '<path d="M8.5 13 12 10l3.5 3"/><path d="M9.8 12.3v3.2h4.4v-3.2"/>',
  zoneC:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3.5 2.5"/>' +
    '<path d="M7 8.5h10l-1.2 5H8.2Z"/><circle cx="9.5" cy="17" r="1.4"/><circle cx="14.5" cy="17" r="1.4"/>',
  zoneI:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3.5 2.5"/>' +
    '<circle cx="12" cy="12" r="2.6"/>' +
    '<path d="M12 6.8v2M12 15.2v2M6.8 12h2M15.2 12h2M8.3 8.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 8.3l-1.4 1.4M9.7 14.3l-1.4 1.4"/>',
  demolish: '<rect x="12" y="2.5" width="9.5" height="6" rx="1.5"/><path d="M13.5 8 4.5 20.5"/>',
};

// ---------------------------------------------------------------------------
// Main / pause menu actions.
// ---------------------------------------------------------------------------

export type MenuIconKey =
  | 'skirmish'
  | 'load'
  | 'missions'
  | 'settings'
  | 'back'
  | 'resume'
  | 'save'
  | 'exit';

const MENU_ICONS: Record<MenuIconKey, string> = {
  skirmish:
    '<path d="M6 18 17 7"/><path d="M18 18 7 7"/><path d="M14.5 4.5h5M4.5 4.5h5"/>',
  load: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h5.6l2 2.4h7.4A1.5 1.5 0 0 1 21 9.9V18a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18Z"/>',
  missions: '<path d="M6 21.5V4"/><path d="M6 4.5h11.5l-2.8 3.8 2.8 3.7H6"/>',
  settings:
    '<path d="M4 7h16M4 12h16M4 17h16"/>' +
    '<circle cx="9" cy="7" r="2.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="15" cy="12" r="2.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="8" cy="17" r="2.3" fill="currentColor" stroke="none"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  resume: '<path d="M8 5.5v13l11-6.5Z"/>',
  save:
    '<rect x="5" y="3.5" width="14" height="17" rx="1.5"/><path d="M9 3.5V9h6V3.5"/>' +
    '<path d="M9 20.5v-6h6v6"/>',
  exit:
    '<path d="M14 4.5H6v15h8"/><path d="M11 12h10"/><path d="M17.5 8.5 21 12l-3.5 3.5"/>',
};

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/** Inline SVG for a unit kind (palette train buttons). */
export function unitIcon(kind: UnitKind): string {
  return svg(UNIT_ICONS[kind]);
}

/** Inline SVG for a building kind (palette build buttons). */
export function buildingIcon(kind: BuildingKind): string {
  return svg(BUILDING_ICONS[kind]);
}

/** Inline SVG for a build-palette tool (road / zones / demolish). */
export function toolIcon(tool: PaletteToolIcon): string {
  return svg(TOOL_ICONS[tool]);
}

/** Inline SVG for a main/pause menu action. */
export function menuIcon(key: MenuIconKey): string {
  return svg(MENU_ICONS[key]);
}

/**
 * Inline SVG for a map preset, chosen by water fraction. Five glyphs:
 * pond (<8% water), river (<16%), lakes (<26%), coast (<38%), isles
 * (everything wetter). Fixed land/water fills — these read as terrain.
 */
export function mapIcon(waterFraction: number): string {
  const frame = '<rect x="4" y="4" width="16" height="16" rx="1"/>';
  if (waterFraction < 0.08) {
    return svg(`${frame}<circle cx="15" cy="15" r="3.6" fill="#4a90d9" stroke="none"/>`);
  }
  if (waterFraction < 0.16) {
    return svg(
      `${frame}<path d="M11.5 4c-2.5 4 2.5 6 0 8.5S9 17 11.5 20" ` +
        'stroke="#4a90d9" stroke-width="4" fill="none"/>',
    );
  }
  if (waterFraction < 0.26) {
    return svg(
      `${frame}<circle cx="9" cy="10" r="2.6" fill="#4a90d9" stroke="none"/>` +
        '<circle cx="15" cy="15" r="3.2" fill="#4a90d9" stroke="none"/>',
    );
  }
  if (waterFraction < 0.38) {
    return svg(`${frame}<path d="M4 20V12.5L11.5 20Z" fill="#4a90d9" stroke="none"/>`);
  }
  return svg(
    '<rect x="4" y="4" width="16" height="16" rx="1" fill="#2f6fd0"/>' +
      '<circle cx="9" cy="9.5" r="2.4" fill="#57a05a" stroke="none"/>' +
      '<circle cx="15" cy="13.5" r="3" fill="#57a05a" stroke="none"/>' +
      '<circle cx="9.5" cy="16" r="1.7" fill="#57a05a" stroke="none"/>',
  );
}

const DIFFICULTY_ORDER: readonly AIDifficulty[] = [
  'cadet',
  'citizen',
  'commander',
  'general',
  'marshal',
];

/**
 * Inline SVG for an AI difficulty: five rank chevrons, filled up to the
 * difficulty's level (cadet = 1 … marshal = 5).
 */
export function difficultyIcon(difficulty: AIDifficulty): string {
  const level = DIFFICULTY_ORDER.indexOf(difficulty) + 1;
  let chevrons = '';
  for (let i = 0; i < 5; i++) {
    const x = (3.4 + i * 3.7).toFixed(1);
    chevrons +=
      i < level
        ? `<path d="M${x} 7l3 5-3 5V7Z" fill="currentColor" stroke="none"/>`
        : `<path d="M${x} 7l3 5-3 5"/>`;
  }
  return svg(chevrons, 1.8);
}
