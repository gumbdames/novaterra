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
 *  - One glyph per palette/menu item: all 35 units, all 67 buildings, the
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
import { getVariantKinds, variantBaseOf, variantTierOf, type VariantUnitKind } from '../sim/variants';
import type { BuildingKind } from '../sim/city';
import type { PolicyId } from '../sim/city';
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
// Units — 97 glyphs, one per UnitKind (silhouette reads the domain at a
// glance: person / tracked hull / aircraft / ship hull). The 28 Phase 8
// Mk II/Mk III variants reuse their base glyph + a tier chevron
// (provisional — the UI workstream owns the final variant art).
// ---------------------------------------------------------------------------

/** The 68 hand-drawn base-kind glyphs. Base kinds are `UnitKind` minus
 *  the `VariantUnitKind`s, so tsc still enforces full base coverage. */
const BASE_UNIT_ICONS: Record<Exclude<UnitKind, VariantUnitKind>, string> = {
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
  // Fun-audit D1 (2026-10-02): doctrine signature units reuse their
  // base glyph + a single chevron (the Mk II variant precedent) — the
  // Aegis Battery is the Republic's shield, the Tempest Cannon the
  // Kestrel's long gun.
  aegisBattery:
    '<path d="M12 21v-7"/><path d="M12 14 6 5"/><path d="M12 14l6-9"/><path d="M8 21h8"/>' +
    '<path d="M14.5 5l5.5 5.5-5.5 5.5"/>',
  tempestCannon:
    '<circle cx="9" cy="15" r="4"/><path d="M11.8 12.2 20 4.5"/><path d="M9 15 5 21"/><path d="M3 21h9"/>' +
    '<path d="M14.5 5l5.5 5.5-5.5 5.5"/>',
  hauler:
    '<rect x="2" y="10" width="11" height="7" rx="1"/><path d="M13 12h3.5L20 15.5V17h-7"/>' +
    '<circle cx="6.5" cy="19" r="1.8"/><circle cx="16" cy="19" r="1.8"/>',
  // Phase 3 SIM workstream (2026-09-30): provisional glyphs for the two
  // new logistics trucks — added only to keep `Record<UnitKind, string>`
  // compiling (tsc-enforced). The UI workstream owns the final art.
  supplyTruck:
    '<rect x="2" y="8" width="12" height="9" rx="1"/><path d="M5 11v3.5M8 11v3.5M11 11v3.5"/>' +
    '<path d="M14 11h3.5L21 14.5V17h-7"/>' +
    '<circle cx="6.5" cy="19" r="1.8"/><circle cx="16.5" cy="19" r="1.8"/>',
  fuelTruck:
    '<ellipse cx="8" cy="12.5" rx="6" ry="4"/><path d="M8 8.5V6"/>' +
    '<path d="M14 11h3.5L21 14.5V17h-7"/>' +
    '<circle cx="6.5" cy="19" r="1.8"/><circle cx="16.5" cy="19" r="1.8"/>',
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
  // Grand-expansion Phase 5 — aircraft expansion (workstream B,
  // 2026-09-30): 16 aircraft glyphs. Silhouette reads the role at a
  // glance: bomb dots = strike, radar arcs = patrol/recon, drop =
  // tanker, boxes = cargo, window rows = airliners.
  strategicBomber:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 9 2.5 16l5-.5"/>' +
    '<path d="M12 9l9.5 7-5-.5"/><circle cx="7" cy="19" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="17" cy="19" r="1.4" fill="currentColor" stroke="none"/>',
  maritimePatrol:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 8.5 3.5 15l4-.5"/>' +
    '<path d="M12 8.5l8.5 6.5-4-.5"/><path d="M5 19.5a8 8 0 0 0 14 0"/>',
  reconUAV:
    '<path d="M12 4v16"/><path d="M12 9l-7 5 3.5-.5"/><path d="M12 9l7 5-3.5-.5"/>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  armedUAV:
    '<path d="M12 4v16"/><path d="M12 9l-7 5 3.5-.5"/><path d="M12 9l7 5-3.5-.5"/>' +
    '<circle cx="17.5" cy="17" r="1.6" fill="currentColor" stroke="none"/>',
  reconPlane:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 8.5 3.5 15l4-.5"/>' +
    '<path d="M12 8.5l8.5 6.5-4-.5"/><path d="M2 5h4M2 8.5h4M18 5h4M18 8.5h4"/>',
  gunship:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 8.5 3.5 15l4-.5"/>' +
    '<path d="M12 8.5l8.5 6.5-4-.5"/><path d="M9 17v4M12 17v4M15 17v4"/>',
  tanker:
    '<path d="M12 2.5c.8 5 .8 12 0 17"/><path d="M12 8.5 3.5 15l4-.5"/>' +
    '<path d="M12 8.5l8.5 6.5-4-.5"/><path d="M12 19.5c-1.6 1.2-1.6 2.5 0 2.5s1.6-1.3 0-2.5Z"/>',
  militaryCargo:
    '<path d="M12 3v18"/><path d="M6 10h12v7H6Z"/><path d="M6 10 3.5 13M18 10l2.5 3"/>',
  trainer:
    '<path d="M12 4v16"/><path d="M12 10l-6 4.5L9.5 14"/><path d="M12 10l6 4.5-3.5-.5"/>',
  navalFighter:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 8.5 3.5 15l4-.5"/>' +
    '<path d="M12 8.5l8.5 6.5-4-.5"/><path d="M3 21.5h18"/>',
  airliner:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 9 3.5 15.5l4-.5"/>' +
    '<path d="M12 9l8.5 6.5-4-.5"/><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="13" r="1" fill="currentColor" stroke="none"/>',
  jumboAirliner:
    '<path d="M12 2.5c.8 5 .8 12 0 19"/><path d="M12 9 2.5 16l5-.5"/>' +
    '<path d="M12 9l9.5 7-5-.5"/><circle cx="10.5" cy="8" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="13.5" cy="8" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="10.5" cy="11.5" r="1" fill="currentColor" stroke="none"/>' +
    '<circle cx="13.5" cy="11.5" r="1" fill="currentColor" stroke="none"/>',
  regionalJet:
    '<path d="M12 3v18"/><path d="M12 9l-7.5 5.5 4-.5"/><path d="M12 9l7.5 5.5-4-.5"/>' +
    '<path d="M2.5 4.5h3M18.5 4.5h3"/>',
  cargoPlane:
    '<path d="M12 3v18"/><path d="M6 10h12v7H6Z"/><rect x="9.5" y="12" width="5" height="3"/>',
  passengerHeli:
    '<ellipse cx="12" cy="14.5" rx="4" ry="2.8"/><path d="M3 8.5h18"/><path d="M12 8.5v3.5"/>' +
    '<circle cx="12" cy="14.5" r="1.2" fill="currentColor" stroke="none"/>',
  seaplane:
    '<path d="M12 3v15"/><path d="M12 8.5 4 14l4-.5"/><path d="M12 8.5l8 5.5-4-.5"/>' +
    '<path d="M7 20.5h10"/>',
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
  // Phase 4 SIM workstream (2026-09-30): provisional glyphs for the five
  // civilian transports — added only to keep `Record<UnitKind, string>`
  // compiling (tsc-enforced). The UI workstream owns the final art.
  passengerTrain:
    '<rect x="3" y="7" width="18" height="8" rx="2"/>' +
    '<path d="M3 12h18"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/>',
  freightTrain:
    '<rect x="2" y="8" width="8" height="7"/><rect x="11" y="8" width="11" height="7"/>' +
    '<circle cx="6" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/>',
  bus:
    '<rect x="3" y="5" width="18" height="12" rx="2"/>' +
    '<path d="M3 11h18"/><circle cx="7" cy="19" r="1.6"/><circle cx="17" cy="19" r="1.6"/>',
  tram:
    '<rect x="4" y="8" width="16" height="9" rx="2"/>' +
    '<path d="M12 8V3"/><path d="M7 3h10"/>',
  ferry:
    '<path d="M3 15h18l-2.5 5h-13Z"/><rect x="7" y="10" width="10" height="5"/>' +
    '<path d="M9 10V7h6v3"/>',
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30): glyphs for the 15 new sea kinds, in the established
  // hand-drawn stroke style.
  coastalSub:
    '<path d="M3 14.5c0-2.6 3.8-4.4 9-4.4s9 1.8 9 4.4-3.8 4.4-9 4.4-9-1.8-9-4.4Z"/>' +
    '<rect x="10.5" y="6.5" width="3" height="3.6"/>',
  missileSub:
    '<path d="M2.5 14.5c0-3 4.2-5 9.5-5s9.5 2 9.5 5-4.2 5-9.5 5-9.5-2-9.5-5Z"/>' +
    '<rect x="9" y="5.5" width="6" height="4"/>' +
    '<path d="M9 5.5V3.5M12 5.5V3.5M15 5.5V3.5"/>',
  corvette:
    '<path d="M3.5 14.5h17l-2 4.5h-13Z"/><rect x="10" y="10.5" width="4" height="4"/>' +
    '<path d="M17.5 14.5 20 12"/>',
  cruiser:
    '<path d="M2.5 14.5h19l-2.5 5h-14Z"/><rect x="5" y="11" width="3.5" height="3.5"/>' +
    '<path d="M5 12.8H2.5"/><rect x="15.5" y="11" width="3.5" height="3.5"/>' +
    '<path d="M19 12.8h2.5"/><path d="M12 14.5V6"/>',
  battleship:
    '<path d="M2 15h20l-2.5 5H4.5Z"/><rect x="4.5" y="11.5" width="3.5" height="3.5"/>' +
    '<path d="M4.5 13.2H2"/><rect x="16" y="11.5" width="3.5" height="3.5"/>' +
    '<path d="M19.5 13.2H22"/><rect x="10.5" y="10.5" width="3" height="4.5"/>' +
    '<path d="M12 10.5V5"/>',
  heavyDestroyer:
    '<path d="M2.5 14.5h19l-2.5 5h-14Z"/><rect x="4.5" y="11" width="4" height="3.5"/>' +
    '<path d="M4.5 12.8H2"/><rect x="15.5" y="11" width="4" height="3.5"/>' +
    '<path d="M19.5 12.8H22"/><path d="M12 14.5V7"/>',
  cargoFreighter:
    '<path d="M2.5 15.5h19l-2.5 5h-14Z"/><rect x="5" y="11.5" width="4" height="4"/>' +
    '<rect x="9.5" y="11.5" width="4" height="4"/><rect x="14" y="11.5" width="4" height="4"/>',
  fuelTanker:
    '<path d="M2.5 15h19l-2.5 5h-14Z"/>' +
    '<ellipse cx="12" cy="11.5" rx="6" ry="3"/>' +
    '<path d="M17 8.8V6h2v2.8"/>',
  // Civilian sea trade (Half A, 2026-10-01): the civilian fuel barge —
  // a hull with a fuel droplet (vs the military fuelTanker's tank
  // ellipse): the civilian fuel hauler.
  fuelBarge:
    '<path d="M2.5 15.5h19l-2.5 5h-14Z"/>' +
    '<path d="M12 4.5c2 2.8 3.5 5 3.5 7a3.5 3.5 0 0 1-7 0c0-2 1.5-4.2 3.5-7Z"/>',
  ammoShip:
    '<path d="M2.5 15h19l-2.5 5h-14Z"/><rect x="6" y="11" width="3.5" height="4"/>' +
    '<rect x="10" y="8.5" width="3.5" height="6.5"/><rect x="14" y="11" width="3.5" height="4"/>',
  repairShip:
    '<path d="M2.5 15h19l-2.5 5h-14Z"/><rect x="6" y="11" width="5" height="4"/>' +
    '<path d="M15 15V8l5-4"/><path d="M20 4v3"/>',
  minelayer:
    '<circle cx="12" cy="11" r="2.4"/>' +
    '<path d="M12 5.8v2.8M6.8 11h2.8M14.4 11h2.8M8.3 7.3l2 2M15.7 7.3l-2 2"/>' +
    '<path d="M3 17h18l-2.5 4h-13Z"/>',
  navalMine:
    '<circle cx="12" cy="13" r="3.4"/>' +
    '<path d="M12 6.4V9.6M5.4 13h3.2M15.4 13h3.2M7.3 8.3l2.3 2.3M16.7 8.3l-2.3 2.3"/>' +
    '<path d="M7.3 17.7l2.3-2.3M16.7 17.7l-2.3-2.3"/>',
  coastGuardCutter:
    '<path d="M4 14.5h16l-2 4.5h-12Z"/><path d="M4.5 16.5h15"/>' +
    '<rect x="10.5" y="10" width="3.5" height="4.5"/><path d="M12.2 10V6"/>',
  cruiseLiner:
    '<path d="M2 15h20l-2 5H4Z"/><rect x="5" y="11.5" width="14" height="3.5"/>' +
    '<rect x="7" y="8" width="10" height="3.5"/><path d="M9 8V5h6v3"/>',
  yacht:
    '<path d="M3.5 15.5h17l-2 4h-13Z"/><path d="M12 15.5V5l7 10.5Z"/>' +
    '<rect x="10.5" y="12" width="3" height="3.5"/>',
  // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
  // provisional glyphs for the two intel units — added only to keep
  // `Record<UnitKind, string>` compiling (tsc-enforced). The UI
  // workstream owns the final art.
  spy:
    '<circle cx="12" cy="8" r="3.2"/>' +
    '<path d="M5 21c0-4 3-6.5 7-6.5s7 2.5 7 6.5"/>' +
    '<path d="M4 4l3 3M20 4l-3 3"/>',
  reconTeam:
    '<circle cx="12" cy="12" r="8"/>' +
    '<circle cx="12" cy="12" r="3.5"/>' +
    '<path d="M12 4v3.5M12 16.5V20M4 12h3.5M16.5 12H20"/>',
  // Fun-audit Tier 4 (E1, 2026-10-02): the envoy — a car silhouette
  // with a pennant flag (diplomatic mission).
  envoySUV:
    '<path d="M3 16l2-6h9l3 3h4v3"/>' +
    '<circle cx="7.5" cy="18.5" r="1.8"/><circle cx="16.5" cy="18.5" r="1.8"/>' +
    '<path d="M18 10V4h5l-2 2.5L23 9h-5"/>',
  // Fun-audit Tier 4 (E2, 2026-10-02): the luminary — a person with a
  // gold-ring halo (the "someone remarkable" guest).
  luminary:
    '<circle cx="12" cy="8" r="3"/>' +
    '<path d="M6 20c0-4 2.5-6 6-6s6 2 6 6"/>' +
    '<circle cx="12" cy="12" r="9" stroke-dasharray="3 2"/>',
  // Fun-audit Tier 4 (E2, 2026-10-02): the drill instructor — a person
  // with chevrons (the retired war hero, now teaching).
  drillInstructor:
    '<circle cx="12" cy="7" r="3"/>' +
    '<path d="M6 20c0-4 2.5-6 6-6s6 2 6 6"/>' +
    '<path d="M8 13l4 3 4-3"/>',
  // Fun-audit Tier 4 (E3, 2026-10-02): the Combine freighter — a cargo
  // hull with containers (a merchant, never a warship).
  combineFreighter:
    '<path d="M3 15h18l-2 5H5z"/>' +
    '<path d="M3 15V9h18v6"/>' +
    '<path d="M7 9V5h10v4"/>',
};

// ---------------------------------------------------------------------------
// Grand-expansion Phase 8 — tech-level variants (workstream D,
// 2026-09-30). PROVISIONAL glyphs for the 28 Mk II/Mk III variants: each
// reuses the base kind's glyph with a tier chevron appended (single ">"
// for Mk II, double ">>" for Mk III) — generated from the sim's
// `getVariantKinds()` (single source of truth) only to keep `UNIT_ICONS`
// complete. The UI workstream owns the final art.
// ---------------------------------------------------------------------------
const VARIANT_MK2_CHEVRON = '<path d="M14.5 5l5.5 5.5-5.5 5.5"/>';
const VARIANT_MK3_CHEVRON =
  '<path d="M11.5 5l5.5 5.5-5.5 5.5"/>' + '<path d="M16.5 5l5.5 5.5-5.5 5.5"/>';
const VARIANT_ICONS: Record<VariantUnitKind, string> = Object.fromEntries(
  getVariantKinds().map((v) => [
    v,
    BASE_UNIT_ICONS[variantBaseOf(v) as Exclude<UnitKind, VariantUnitKind>] +
      (variantTierOf(v) === 3 ? VARIANT_MK3_CHEVRON : VARIANT_MK2_CHEVRON),
  ]),
) as Record<VariantUnitKind, string>;

/** Every UnitKind resolves here exactly once (tsc enforces both halves). */
const UNIT_ICONS: Record<UnitKind, string> = { ...BASE_UNIT_ICONS, ...VARIANT_ICONS };

// ---------------------------------------------------------------------------
// Buildings — one glyph per BuildingKind (71 entries after the Phase 6
// naval expansion; the airport workstream's 16 new airport kinds land
// with their icons in that workstream — tsc enforces full coverage when
// the tree is integrated).
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
  // Workstream Z (2026-09-30): the education ladder. Kindergarten reads
  // as a small house with a playground ball (distinct from the school's
  // flag); college reads as a domed hall (distinct from the
  // university's columns).
  kindergarten:
    '<path d="M4 11 12 4l8 7"/><rect x="6" y="11" width="12" height="9"/>' +
    '<path d="M10 20v-4.5h4V20"/><circle cx="18.2" cy="5.2" r="2.3"/>',
  college:
    '<rect x="5" y="11" width="14" height="9"/><path d="M5 11a7 7 0 0 1 14 0"/>' +
    '<path d="M10.5 20v-4h3v4"/><path d="M12 4V2.5"/>',
  // Workstream W (2026-09-30): the civic amenities. Library reads as an
  // open book (distinct from the school's flag and the college's dome);
  // park reads as a tree beside a bench.
  library:
    '<path d="M3.5 6.5c2.8-1.4 5.9-1.4 8.5 0 2.6-1.4 5.7-1.4 8.5 0v11.5' +
    'c-2.8-1.4-5.9-1.4-8.5 0-2.6-1.4-5.7-1.4-8.5 0z"/><path d="M12 6.5v11.5"/>',
  park:
    '<circle cx="9.5" cy="8" r="4.8"/><path d="M9.5 12.8V19"/>' +
    '<path d="M13 16h7"/><path d="M13.8 16v3.5M19.2 16v3.5"/>',
  // Workstream P (ambient city life, 2026-09-30): civic parking. The
  // lot reads as an open pad with painted stall dividers (distinct
  // from everything else); the garage reads as stacked decks with a
  // ramp (the diagonal sets it apart from the lot).
  parkingLot:
    '<rect x="4" y="5" width="16" height="15"/>' +
    '<path d="M4 12.5h16"/><path d="M8 12.5v7.5M12 12.5v7.5M16 12.5v7.5"/>',
  parkingGarage:
    '<rect x="4" y="4" width="16" height="17"/>' +
    '<path d="M4 10.5h16M4 17h16"/><path d="M6 17 18 10.5"/>',
  // Phase 4 SIM workstream (2026-09-30): provisional glyphs for the five
  // transport hubs — added only to keep `Record<BuildingKind, string>`
  // compiling (tsc-enforced). The UI workstream owns the final art.
  railStation:
    '<rect x="3" y="10" width="18" height="8"/>' +
    '<path d="M3 10l4-6h10l4 6"/><path d="M12 4v6"/>',
  busDepot:
    '<rect x="3" y="6" width="18" height="11" rx="1"/>' +
    '<path d="M3 12h18"/><path d="M8 6v11M16 6v11"/>',
  ferryTerminal:
    '<path d="M3 17h18"/><rect x="6" y="9" width="12" height="8"/>' +
    '<path d="M6 13h12"/>',
  marina:
    '<path d="M2 18c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0"/>' +
    '<path d="M12 16V6"/><path d="M12 6l6 4"/>',
  marinaLarge:
    '<path d="M2 18c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0"/>' +
    '<path d="M7 16V5"/><path d="M7 5l5 3.5"/><path d="M15 16v-8"/><circle cx="15" cy="6" r="2"/>',
  // Phase 4 tiered transit (2026-09-30): provisional glyphs for the
  // seven stops/stations — added only to keep
  // `Record<BuildingKind, string>` compiling (tsc-enforced). The UI
  // workstream owns the final art.
  busStop:
    '<rect x="4" y="4" width="16" height="8" rx="1"/>' +
    '<path d="M8 4v8M16 4v8"/><path d="M4 16h16"/>',
  taxiStand:
    '<rect x="5" y="8" width="14" height="7" rx="2"/>' +
    '<path d="M9 8V5h6v3"/><circle cx="8.5" cy="17.5" r="1.6"/><circle cx="15.5" cy="17.5" r="1.6"/>',
  tramStop:
    '<rect x="5" y="9" width="14" height="7" rx="1"/>' +
    '<path d="M12 9V4"/><path d="M8 4h8"/>',
  ferryPier:
    '<path d="M3 8h18"/><path d="M5 8v8M10 8v8M15 8v8M20 8v8"/>' +
    '<path d="M2 19c2 1.5 4 1.5 6 0s4-1.5 6 0 4 1.5 6 0"/>',
  neighborhoodStation:
    '<rect x="3" y="8" width="18" height="10"/>' +
    '<path d="M3 8l3-4h12l3 4"/><path d="M9 18v-4h6v4"/>',
  centralStation:
    '<rect x="2" y="9" width="20" height="10"/>' +
    '<path d="M2 9l5-6h10l5 6"/><circle cx="12" cy="14" r="2.5"/>',
  airportInterchange:
    '<path d="M12 3l3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/>' +
    '<path d="M4 21h16"/>',
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
  // Grand-expansion Phase 2: the 13 utility buildings.
  // Coal plant: turbine hall + twin banded chimneys.
  coalPlant:
    '<path d="M3 21v-8h11v8"/><path d="M14 21V8l1.8-4.5h2.4L20 8v13"/>' +
    '<path d="M5.5 21V9l1.6-4h2.2L11 9v12"/><path d="M15.2 6h3.6M6.6 6.5h3.2"/>',
  // Gas plant: horizontal tanks + a short stack.
  gasPlant:
    '<rect x="3" y="11" width="10" height="5" rx="2.5"/><rect x="3" y="16.5" width="10" height="4.5" rx="2.2"/>' +
    '<path d="M16 8h3v13"/><path d="M16 8c.6 4-.6 8-2 11"/>',
  // Wind farm: three turbines (tower + 3-blade rotor).
  windFarm:
    '<path d="M6 21v-9M18 21v-9"/><path d="M6 12 3.5 8M6 12l2.5-4M6 12v-4.5"/>' +
    '<path d="M18 12l-2.5-4M18 12l2.5-4M18 12V7.5"/><path d="M12 21v-6"/>' +
    '<path d="M12 15l-2-3.2M12 15l2-3.2M12 15v-3.6"/>',
  // Hydro dam: dam wall + spillway gates + gatehouse towers.
  hydroDam:
    '<path d="M3 8h18v13H3Z"/><path d="M3 8c6 2.5 12 2.5 18 0v3c-6 2.5-12 2.5-18 0Z"/>' +
    '<path d="M7 8V4.5h2.5V8M14.5 8V4.5H17V8"/><path d="M9 13.5v4M15 13.5v4"/>',
  // Geothermal plant: steam vents + pipe manifold.
  geothermalPlant:
    '<path d="M6 21V12l1.2-3h3.6L12 12v9"/><path d="M13 21v-7l1-2.5h3L18 14v7"/>' +
    '<path d="M3 21h18"/><path d="M8 5.5c-1-1.5 1-2.5 0-4M11 5.5c-1-1.5 1-2.5 0-4"/>',
  // Fusion plant: domed hall with a tokamak torus inside.
  fusionPlant:
    '<path d="M4 21v-6a8 8 0 0 1 16 0v6"/><ellipse cx="12" cy="13.5" rx="4.5" ry="1.8"/>' +
    '<path d="M12 8.5V5.5"/><circle cx="12" cy="13.5" r="1" fill="currentColor" stroke="none"/>',
  // Water well: A-frame derrick + pump house.
  waterWell:
    '<path d="M8 21 11 6h2l3 15"/><path d="M9.2 16h5.6M10 11.5h4"/>' +
    '<path d="M11 6V3.5"/><rect x="14.5" y="15" width="6" height="6"/>',
  // Water tower: tank on four legs.
  waterTower:
    '<ellipse cx="12" cy="8" rx="6.5" ry="2.6"/><path d="M5.5 8v5.5c0 1.4 2.9 2.6 6.5 2.6s6.5-1.2 6.5-2.6V8"/>' +
    '<path d="M8 16.5 6.5 21M16 16.5l1.5 4.5M10.5 16.8 10 21M13.5 16.8l.5 4.2"/>',
  // Water treatment: clarifier basins + control hut.
  waterTreatment:
    '<ellipse cx="8" cy="14" rx="5" ry="2.2"/><path d="M3 14v4c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-4"/>' +
    '<ellipse cx="17" cy="15.5" rx="4" ry="1.8"/><path d="M13 15.5v3.4c0 1 1.8 1.8 4 1.8s4-.8 4-1.8v-3.4"/>' +
    '<rect x="10.5" y="4" width="4" height="4"/>',
  // Reservoir: wide low basin ring with water.
  reservoir:
    '<ellipse cx="12" cy="10" rx="9" ry="3.4"/><path d="M3 10v7c0 1.9 4 3.4 9 3.4s9-1.5 9-3.4v-7"/>' +
    '<ellipse cx="12" cy="10" rx="6.5" ry="2.2"/>',
  // Power substation: transformer boxes + busbar gantry.
  powerSubstation:
    '<rect x="4" y="14" width="4.5" height="7"/><rect x="9.5" y="14" width="4.5" height="7"/>' +
    '<path d="M5 14v-3M7.5 14v-3M11.5 14v-3"/><path d="M4 8.5h12"/>' +
    '<path d="M16 21V9M20 21V9M16 9h4"/>',
  // Pumping station: pump house with large pipes running out.
  pumpingStation:
    '<rect x="4" y="9" width="9" height="12"/><path d="M13 12h4a3 3 0 0 1 3 3v6"/>' +
    '<path d="M13 16.5h3.2a2.2 2.2 0 0 1 2.2 2.2V21"/><path d="M6.5 9V5.5h4V9"/>',
  // Battery station: cabinet racks + inverter container.
  batteryStation:
    '<rect x="3" y="6" width="7" height="15" rx="1"/><path d="M3 11h7M3 16h7"/>' +
    '<rect x="12" y="10" width="9" height="11" rx="1"/><path d="M12 15h9"/>' +
    '<path d="M5 8.5h3M14.5 12.5h4"/>',
  // Phase 3 (grand expansion, 2026-09-30): the logistics roster. Oil
  // well = derrick (distinct from the refinery's tanks); oil rig =
  // derrick on a platform over waves; munitions factory = factory with
  // a shell; missile plant = factory with a missile; missile silo =
  // silo with a missile tip; ordnance depot = crates; fuel depot =
  // fuel drum. Each stays distinct from the existing glyphs.
  oilWell:
    '<path d="M10 3h4l3 18h-10Z"/><path d="M7 8h10M6 13h12M12 3v18"/>' +
    '<path d="M4 21h16"/>',
  oilRig:
    '<path d="M10 2h4l2.5 12h-9Z"/><path d="M4 14h16v3H4Z"/>' +
    '<path d="M3 20c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"/>',
  munitionsFactory:
    '<path d="M3 21V10l5 3.5V10l5 3.5V10l5 3.5V21Z"/>' +
    '<path d="M6 21v-4M18 21v-4"/><ellipse cx="12" cy="8" rx="2.5" ry="1.2"/>' +
    '<path d="M12 6.8V3"/>',
  missilePlant:
    '<path d="M3 21V10l5 3.5V10l5 3.5V10l5 3.5V21Z"/>' +
    '<path d="M12 3c1.8 1.5 1.8 5 0 7-1.8-2-1.8-5.5 0-7Z"/><path d="M12 10v3"/>',
  missileSilo:
    '<rect x="8" y="8" width="8" height="13"/><path d="M8 8c0-4 8-4 8 0"/>' +
    '<path d="M12 8V4"/><path d="M5 21h14"/>',
  ordnanceDepot:
    '<rect x="3" y="12" width="8" height="8"/><rect x="13" y="12" width="8" height="8"/>' +
    '<path d="M3 12l4-4h6l4 4M7 4h10v4"/>',
  fuelDepot:
    '<rect x="7" y="5" width="10" height="15" rx="4"/>' +
    '<path d="M7 10h10M7 14.5h10"/><circle cx="12" cy="7.5" r="0.9"/>',
  // Grand-expansion Phase 6 — naval expansion (workstream C,
  // 2026-09-30): glyphs for the four ports, in the established
  // hand-drawn stroke style (quay line + water waves).
  commercialPort:
    '<path d="M2 17h20"/>' +
    '<path d="M7 17V8"/><path d="M7 8l9-4.5"/><path d="M16 3.5V8"/>' +
    '<rect x="13.5" y="8" width="5" height="3.5"/>' +
    '<path d="M3 20.5c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>',
  containerPort:
    '<path d="M2 17h20"/>' +
    '<rect x="3.5" y="13" width="5" height="4"/><rect x="9" y="13" width="5" height="4"/>' +
    '<rect x="3.5" y="9" width="5" height="4"/>' +
    '<path d="M17 17V6l5-3"/>' +
    '<path d="M3 20.5c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>',
  fishingHarbor:
    '<path d="M2 17h20"/>' +
    '<path d="M5 17v-4.5M11 17v-4.5M5 14.5h13"/>' +
    '<path d="M14 12.5h7l-1.2 2h-4.6Z"/>' +
    '<path d="M3 20.5c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>',
  navalBase:
    '<path d="M2 17h20"/>' +
    '<path d="M3.5 14.5h17l-2 2.5h-13Z"/>' +
    '<rect x="5" y="9" width="4" height="5.5"/><rect x="15" y="9" width="4" height="5.5"/>' +
    '<path d="M7 9V5M17 9V5"/>' +
    '<path d="M3 20.5c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>',
  // Civilian sea trade (Half A, 2026-10-01; renamed the Civilian
  // Shipyard, 2026-10-01): the commercialHarbor kind — quay + gantry
  // crane + water waves (vs the commercialPort's derrick crane).
  commercialHarbor:
    '<path d="M2 17h20"/>' +
    '<path d="M6 17V6h9"/><path d="M15 6v3"/>' +
    '<rect x="13.2" y="9" width="3.6" height="2.8"/>' +
    '<path d="M3 20.5c2-1.5 4-1.5 6 0s4 1.5 6 0 4-1.5 6 0"/>',
  // Grand-expansion Phase 5 — airports (workstream A, S5+S8,
  // 2026-09-30): glyphs for the 14 airport kinds, in the established
  // hand-drawn stroke style. Anchors read as terminal + runway; the
  // hangars as arched sheds; runways as strips with class ticks.
  civilAirport:
    '<rect x="4" y="12" width="7" height="6" rx="1"/>' +
    '<path d="M4 15h7M7.5 12v6"/>' +
    '<path d="M13 5l7 2-7 2 1.6-2Z"/>',
  militaryAirbase:
    '<rect x="4" y="12" width="7" height="6" rx="1"/>' +
    '<path d="M4 15h7"/>' +
    '<path d="M15 4l1.2 2.4L18.6 7l-2.4 1.2L15 10.6l-1.2-2.4L11.4 7l2.4-.6Z"/>',
  mixedAirport:
    '<rect x="4" y="12" width="7" height="6" rx="1"/>' +
    '<path d="M4 15h7M7.5 12v6"/>' +
    '<path d="M13 5l7 2-7 2 1.6-2Z"/>' +
    '<path d="M19 14l.8 1.6 1.6.8-1.6.8-.8 1.6-.8-1.6-1.6-.8 1.6-.8Z"/>',
  passengerTerminal:
    '<rect x="5" y="9" width="14" height="9" rx="1"/>' +
    '<path d="M5 13h14"/>' +
    '<path d="M8 9V6.5h8V9"/>' +
    '<circle cx="12" cy="15.8" r="1.2"/>',
  cargoTerminal:
    '<rect x="5" y="9" width="14" height="9" rx="1"/>' +
    '<path d="M5 13h14"/>' +
    '<rect x="9" y="5" width="6" height="4"/>' +
    '<path d="M9 15.5h6"/>',
  controlTower:
    '<path d="M9 21l1.5-9h3L15 21"/>' +
    '<rect x="7" y="4" width="10" height="5" rx="1"/>' +
    '<path d="M7 6.5h10"/>',
  hangarS:
    '<path d="M4 18v-4a8 8 0 0 1 16 0v4"/>' +
    '<path d="M4 18h16"/>',
  hangarM:
    '<path d="M3 18v-5a9 9 0 0 1 18 0v5"/>' +
    '<path d="M3 18h18"/>' +
    '<path d="M12 8v10"/>',
  hangarL:
    '<path d="M2.5 18v-5.5a9.5 9.5 0 0 1 19 0V18"/>' +
    '<path d="M2.5 18h19"/>' +
    '<path d="M8 7.5V18M16 7.5V18"/>',
  fuelFarm:
    '<rect x="4" y="10" width="7" height="8" rx="3.5"/>' +
    '<rect x="13" y="10" width="7" height="8" rx="3.5"/>' +
    '<path d="M7.5 10V7M16.5 10V7M7.5 7h9"/>',
  maintenanceHangar:
    '<path d="M4 18v-4a8 8 0 0 1 16 0v4"/>' +
    '<path d="M4 18h16"/>' +
    '<path d="M10 14.5l1.2 1.2 2.3-2.3"/>',
  runwayS:
    '<path d="M3 16.5h18"/>' +
    '<path d="M6 16.5v-2M10 16.5v-2M14 16.5v-2M18 16.5v-2"/>',
  runwayM:
    '<path d="M2.5 15v3h19v-3"/>' +
    '<path d="M6 16.5h2.5M10.75 16.5h2.5M15.5 16.5h2.5"/>',
  runwayL:
    '<path d="M2 13.5v6h20v-6"/>' +
    '<path d="M5 16.5h3M10.5 16.5h3M16 16.5h3"/>' +
    '<path d="M12 13.5V8l4 1.5-4 1.5"/>',
  // Grand-expansion intel roster (§3.8/S6, workstream 2, 2026-09-30):
  // provisional glyphs for the four intel buildings — added only to
  // keep `Record<BuildingKind, string>` compiling (tsc-enforced). The
  // UI workstream owns the final art.
  intelHQ:
    '<rect x="5" y="7" width="14" height="10" rx="1"/>' +
    '<path d="M9 7V4h6v3"/>' +
    '<circle cx="12" cy="12" r="2.4"/>' +
    '<path d="M12 9.6V5M12 18.4V14M9.6 12H5M18.4 12H14"/>',
  listeningPost:
    '<path d="M12 21v-9"/>' +
    '<path d="M12 12 7 5"/>' +
    '<path d="M5 9a5 5 0 0 1 4-4"/>' +
    '<path d="M3.5 11.5a8 8 0 0 1 5.5-6"/>' +
    '<path d="M8 21h8"/>',
  satelliteUplink:
    '<ellipse cx="12" cy="8" rx="6" ry="2.5"/>' +
    '<path d="M12 10.5V21"/>' +
    '<path d="M12 10.5 6.5 6"/>' +
    '<path d="M8 21h8"/>',
  signalsStation:
    '<rect x="9" y="9" width="6" height="12"/>' +
    '<path d="M12 9V3"/>' +
    '<circle cx="12" cy="5.5" r="2.2"/>' +
    '<path d="M5 21h14"/>',
  // Grand-expansion Phase 8 (civilian deep-dive, workstream E,
  // 2026-09-30): the ten civilian buildings. Hand-drawn inline SVGs in
  // the same 24x24 stroke style; every button shows icon AND text.
  museum:
    '<path d="M4 20.5v-8.5a8 4.6 0 0 1 16 0v8.5"/>' +
    '<path d="M4 20.5h16"/>' +
    '<path d="M9.5 20.5v-5h5v5"/>',
  theater:
    '<path d="M5 3.5c2.6 0 2.6 5.2 0 9.5"/>' +
    '<path d="M19 3.5c-2.6 0-2.6 5.2 0 9.5"/>' +
    '<path d="M5 3.5h14"/>' +
    '<path d="M12 13v7.5M8.5 20.5h7"/>',
  sportsStadium:
    '<ellipse cx="12" cy="13" rx="9" ry="6"/>' +
    '<path d="M12 7v12"/>' +
    '<path d="M7.2 10.6v4.8M16.8 10.6v4.8"/>',
  botanicalGarden:
    '<path d="M12 21v-8"/>' +
    '<path d="M12 13.2c-3 0-5-2.4-5-5.4 2.6-.4 5 1.2 5 5.4Z"/>' +
    '<path d="M12 13.2c3 0 5-2.4 5-5.4-2.6-.4-5 1.2-5 5.4Z"/>' +
    '<circle cx="12" cy="6" r="1.5"/>',
  grandMarket:
    '<path d="M3 9.5h18l-1.5 4.5h-15Z"/>' +
    '<path d="M5.5 14v6.5M18.5 14v6.5"/>' +
    '<path d="M3 9.5 4.5 4.5h15L21 9.5"/>' +
    '<circle cx="12" cy="17.2" r="2"/>',
  bank:
    '<path d="M2.5 10 12 4.5 21.5 10"/>' +
    '<rect x="6.5" y="10" width="11" height="10.5"/>' +
    '<path d="M12 12.6v4.8"/>' +
    '<path d="M10.4 13.6c0-1 3.2-1 3.2.2s-3.2.8-3.2 2.2 3.2 1.4 3.2-.2"/>',
  officeTower:
    '<rect x="8" y="3" width="8" height="18"/>' +
    '<path d="M8 7.5h8M8 12h8M8 16.5h8"/>',
  clinic:
    '<path d="M4 20.5V9.5L12 4l8 5.5v11"/>' +
    '<path d="M12 10.5v5.5M9.25 13.25h5.5"/>',
  medicalCenter:
    '<path d="M4 21V7.5L8 4.5l4 3 4-3 4 3V21"/>' +
    '<path d="M4 21h16"/>' +
    '<path d="M12 10.5v5.5M9.25 13.25h5.5"/>',
  fireStation:
    '<rect x="5" y="11" width="14" height="10"/>' +
    '<path d="M5 11l7-6 7 6"/>' +
    '<path d="M12 5.5c1.6 2.2 2.6 3.6 2.6 5.3a2.6 2.6 0 0 1-5.2 0c0-1 .5-1.9 1.2-2.9"/>',
};

// ---------------------------------------------------------------------------
// Build-palette tools (road / zones / demolish).
// ---------------------------------------------------------------------------

/** The build-palette tools (road / zones / demolish / Phase 2 networks / Phase 4 rail). */
export type PaletteToolIcon =
  | 'road'
  | 'zoneR'
  | 'zoneC'
  | 'zoneI'
  // Grand-expansion Phase 5 (S5): the airport zone tool.
  | 'zoneA'
  | 'demolish'
  // Phase 2 (utilities): drag-paint network tools.
  | 'powerLine'
  | 'waterPipe'
  // Phase 4 (transport): the rail drag-paint tool.
  | 'rail';

const TOOL_ICONS: Record<PaletteToolIcon, string> = {
  road: '<path d="M9 2.5v19M15 2.5v19"/><path d="M12 5.5v3M12 10.5v3M12 15.5v3"/>',
  // Rail: two rails with sleepers (ties) — reads as a track at 24px.
  rail:
    '<path d="M8 3v18M16 3v18"/>' +
    '<path d="M8 6h8M8 10h8M8 14h8M8 18h8"/>',
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
  // Airport zone: dashed zone rect with a paper-plane glyph (the phase 5
  // icon set's civilAirport minus the runway — reads as "aviation").
  zoneA:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="2" stroke-dasharray="3.5 2.5"/>' +
    '<path d="M12 6.5l4.5 10.5-4.5-2.4L7.5 17Z"/>' +
    '<path d="M12 6.5v8.1"/>',
  demolish: '<rect x="12" y="2.5" width="9.5" height="6" rx="1.5"/><path d="M13.5 8 4.5 20.5"/>',
  // Power line: pylon with a sagging wire run.
  powerLine:
    '<path d="M7 21V7M5 10h4M5.8 13h2.4"/><path d="M17 21V7M15 10h4M15.8 13h2.4"/>' +
    '<path d="M7 7c3.5 2.5 6.5 2.5 10 0"/>',
  // Water pipe: a pipe run with a valve wheel.
  waterPipe:
    '<path d="M3 14h8a4 4 0 0 1 4-4V7"/><path d="M15 7v8"/>' +
    '<circle cx="18.5" cy="17.5" r="2.5"/><path d="M18.5 15v5M16 17.5h5"/>',
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
  | 'exit'
  // Workstream Y (2026-09-30): the three main menu tabs — Civilian,
  // Military, Management. Hand-drawn in the established style (24×24,
  // currentColor); always paired with the tab's text label.
  | 'tabCivilian'
  | 'tabMilitary'
  | 'tabManagement';

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
  // Workstream Y (2026-09-30): the three main menu tabs. Civilian reads
  // as a house (the city you build); Military as a shield (defense);
  // Management as the slider bank (rates and policies you tune).
  tabCivilian:
    '<path d="M4 11 12 4l8 7"/><rect x="6" y="11" width="12" height="9"/>' +
    '<path d="M10 20v-4.5h4V20"/>',
  tabMilitary:
    '<path d="M12 3l7 2.8v6.1c0 4.8-3.3 7.7-7 9.1-3.7-1.4-7-4.3-7-9.1V5.8Z"/>' +
    '<path d="M9.5 11.5l2 2 3.5-3.7"/>',
  tabManagement:
    '<path d="M4 7h16M4 12h16M4 17h16"/>' +
    '<circle cx="9" cy="7" r="2.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="15" cy="12" r="2.3" fill="currentColor" stroke="none"/>' +
    '<circle cx="8" cy="17" r="2.3" fill="currentColor" stroke="none"/>',
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

/**
 * Grand-expansion Phase 8 (civilian ordinances, workstream E,
 * 2026-09-30): inline SVG for a city policy (the Management tab's
 * "City ordinances" section). Same 24x24 stroke style; every row shows
 * icon AND text.
 */
const POLICY_ICONS: Record<PolicyId, string> = {
  greenInitiative:
    '<path d="M5 19C5 10 10 5 19 5c0 9-5 14-14 14Z"/>' +
    '<path d="M5 19c3-5 7-9 11-11"/>',
  transitSubsidy:
    '<rect x="4" y="5" width="16" height="11" rx="2"/>' +
    '<path d="M4 10h16"/>' +
    '<circle cx="8" cy="18.5" r="1.6"/>' +
    '<circle cx="16" cy="18.5" r="1.6"/>',
  businessIncentives:
    '<rect x="4" y="8" width="16" height="11" rx="1.5"/>' +
    '<path d="M9 8V5.5h6V8"/>' +
    '<circle cx="12" cy="13.5" r="2"/>',
  nightlife:
    '<path d="M18.5 14.5A7.5 7.5 0 1 1 9.5 5.5a6 6 0 0 0 9 9Z"/>',
  educationGrants:
    '<path d="M2.5 9.5 12 5l9.5 4.5L12 14Z"/>' +
    '<path d="M7 11.5V16c0 1.5 10 1.5 10 0v-4.5"/>' +
    '<path d="M21.5 9.5V15"/>',
};

/** Inline SVG for a city policy (the ordinances section). */
export function policyIcon(id: PolicyId): string {
  return svg(POLICY_ICONS[id]);
}

/** Inline SVG for a build-palette tool (road / zones / demolish / networks). */
export function toolIcon(tool: PaletteToolIcon): string {
  return svg(TOOL_ICONS[tool]);
}

/** Inline SVG for a main/pause menu action. */
export function menuIcon(key: MenuIconKey): string {
  return svg(MENU_ICONS[key]);
}

/**
 * View-toggle icons (Phase 4 RENDER workstream A, follow-up B).
 * Hand-drawn in the established style (24×24, currentColor); always
 * paired with the toggle's text label.
 */
export type ViewIconKey = 'grid';

const VIEW_ICONS: Record<ViewIconKey, string> = {
  // Survey grid: 3×3 lines.
  grid: '<path d="M4 9.3h16M4 14.6h16M9.3 4v16M14.6 4v16"/>',
};

/** Inline SVG for a view toggle (top bar). */
export function viewIcon(key: ViewIconKey): string {
  return svg(VIEW_ICONS[key]);
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
