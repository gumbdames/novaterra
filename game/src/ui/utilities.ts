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
 * NOVATERRA — ui/utilities.ts — Phase 2 utility-network UI/render contract
 * (pure, headless-safe).
 *
 * Responsibilities:
 *  - The single choke point between the UI/render layers and the Phase 2
 *    sim workstream: every expected sim field is named here, read
 *    defensively, and documented, so the UI renders a sane "pre-sim"
 *    state (and flips live the moment the sim commits — no UI code
 *    changes needed beyond merging the new kinds into the sim-side
 *    `BuildingKind` union, `BUILDING_DEFS`, `BUILDING_ICONS`, and
 *    `STRINGS.buildingNames`).
 *  - UI-side data for the 13 new utility buildings: names, icons (via
 *    ui/icons.ts), build-tab groupings, and palette availability.
 *  - Pure view builders for the utility overlay (render/utilityOverlay.ts
 *    consumes `utilityOverlayData(world)` — the superweapon-FX precedent:
 *    sim publishes records, UI/render reads per frame, never sim state
 *    in the UI).
 *
 * SIM CONTRACT (Phase 2 sim workstream — VERIFIED 2026-09-30 against the
 * sim's committed code; names match exactly):
 *  - `city.powerLines: number[]` / `city.pipes: number[]` — sorted cell
 *    sets, same discipline as `city.roads`.
 *  - Commands `buildPowerLine` / `buildPipe` (payload `{ owner, cells }`).
 *  - `building.powerDiag` / `building.waterDiag`: the sim's
 *    `UtilityDiag` ('ok' | 'shortage' | 'disconnected'), set every
 *    economy tick (stranded plants read 'disconnected' on their supply
 *    utility — the overlay's stranded marker mirrors this exactly).
 *  - Fouled water sources: the sim computes them per tick into the
 *    transient `UtilityModel.fouledSources` (building ids) but does NOT
 *    persist them on the building record — see `buildingFouledSource`.
 *  - `daylightFactor(tick)` exists in sim/utilityNetworks.ts (pure,
 *    0..1) — see the NIGHT LAMPS note below.
 *
 * MERGE STATUS (2026-09-30): the sim has landed. `BuildingKind` and
 * `BUILDING_DEFS` carry the 13 kinds, so the defensive branches in
 * `utilityBuildingAvailability` / `formatUtilityBuildCost` now take the
 * standard path (they stay as guards, never as behavior). The UI-side
 * `UTILITY_BUILD_TABS` remains separate from palettes.ts `BUILD_TABS`
 * deliberately: the new kinds have no sim-side tab assignment yet, and
 * `allBuildTabs()` merges them at render time.
 */

import type { World } from '../sim/world';
import {
  BUILDING_DEFS,
  type BuildingKind,
  type BuildingRecord,
  type UtilityDiag,
} from '../sim/city';
import { isUnitAvailableForAge } from '../sim/ages';
import { getPlayer } from '../sim/city';
import {
  STRINGS,
  loc,
  fillLoc,
  type LocalizedString,
} from './strings';
import { BUILD_TABS, type BuildTab, type BuildTabId } from './palettes';
import type { Availability } from './palettes';

// ---------------------------------------------------------------------------
// Roster: the 12 new Phase 2 utility buildings (names from the plan §3.1).
// ---------------------------------------------------------------------------

/** The 12 new utility building kinds the Phase 2 sim adds. */
export const UTILITY_BUILDING_KINDS = [
  'coalPlant',
  'gasPlant',
  'windFarm',
  'hydroDam',
  'geothermalPlant',
  'fusionPlant',
  'waterWell',
  'waterTower',
  'waterTreatment',
  'reservoir',
  'powerSubstation',
  'pumpingStation',
  'batteryStation',
] as const;

/** Phase 2 utility building kinds (pre-sim: a plain string union). */
export type UtilityBuildingKind = (typeof UTILITY_BUILDING_KINDS)[number];

/** True for any of the 13 Phase 2 utility building kinds. */
export function isUtilityBuildingKind(kind: string): kind is UtilityBuildingKind {
  return (UTILITY_BUILDING_KINDS as readonly string[]).includes(kind);
}

/** English-only display names for the 13 new buildings (LocalizedString). */
export const UTILITY_BUILDING_NAMES: Record<UtilityBuildingKind, LocalizedString> = {
  coalPlant: { en: 'Coal Plant' },
  gasPlant: { en: 'Gas Plant' },
  windFarm: { en: 'Wind Farm' },
  hydroDam: { en: 'Hydro Dam' },
  geothermalPlant: { en: 'Geothermal Plant' },
  fusionPlant: { en: 'Fusion Plant' },
  waterWell: { en: 'Water Well' },
  waterTower: { en: 'Water Tower' },
  waterTreatment: { en: 'Water Treatment' },
  reservoir: { en: 'Reservoir' },
  powerSubstation: { en: 'Power Substation' },
  pumpingStation: { en: 'Pumping Station' },
  batteryStation: { en: 'Battery Station' },
};

/** Localized name for a utility building kind; falls back to the kind id. */
export function utilityBuildingName(kind: string): string {
  const entry = (UTILITY_BUILDING_NAMES as Record<string, LocalizedString | undefined>)[kind];
  return entry !== undefined ? loc(entry) : kind;
}

// ---------------------------------------------------------------------------
// Build tabs for the new kinds. Grand-expansion Phase 2 (2026-09-30): the
// two utility tabs merged into palettes.ts `BUILD_TABS` (the pinned
// "every building kind exactly once" test covers BUILD_TABS against the
// sim's BUILDING_DEFS), so these are derived views of the same data —
// never a second copy of the kind lists.
// ---------------------------------------------------------------------------

export type UtilityBuildTabId = 'power' | 'waterNet';

export interface UtilityBuildTab {
  id: UtilityBuildTabId;
  kinds: readonly UtilityBuildingKind[];
}

/**
 * The two Phase 2 utility tabs, derived from the canonical `BUILD_TABS`
 * (same objects, filtered) so the roster can never drift between the two.
 */
export const UTILITY_BUILD_TABS: readonly UtilityBuildTab[] = (
  BUILD_TABS as readonly BuildTab[]
)
  .filter((t) => t.id === 'power' || t.id === 'waterNet')
  .map((t) => ({
    id: t.id as UtilityBuildTabId,
    kinds: t.kinds as readonly UtilityBuildingKind[],
  }));

/** Every build tab the palette renders. */
export function allBuildTabs(): ReadonlyArray<{
  id: BuildTabId | UtilityBuildTabId;
  kinds: readonly string[];
}> {
  return BUILD_TABS;
}

// ---------------------------------------------------------------------------
// Diagnosis: powerDiag / waterDiag ('ok' | 'shortage' | 'disconnected').
// ---------------------------------------------------------------------------
// The sim (sim/city.ts) owns the `UtilityDiag` type and sets the fields on
// every building each economy tick. The readers below stay defensive
// (unknown values fall back to the legacy `powered` / `watered` flags) so
// the UI never shows a blank diagnosis.

const UTILITY_DIAG_VALUES: readonly UtilityDiag[] = ['ok', 'shortage', 'disconnected'];

/**
 * The Phase 2 per-building sim fields. Read defensively (unknown values
 * fall back to the legacy flags): the UI must never show a blank
 * diagnosis even if a future sim change renames a field.
 */
interface UtilitySimFields {
  powerDiag?: unknown;
  waterDiag?: unknown;
  /** Expected Phase 2 sim field for fouled water sources (verify). */
  fouledSource?: unknown;
}

function simFields(b: BuildingRecord): UtilitySimFields {
  return b as unknown as UtilitySimFields;
}

function asDiag(value: unknown): UtilityDiag | undefined {
  return typeof value === 'string' &&
    (UTILITY_DIAG_VALUES as readonly string[]).includes(value)
    ? (value as UtilityDiag)
    : undefined;
}

/**
 * A building's power diagnosis. Falls back to the legacy `powered` flag
 * pre-sim (powered ⇒ 'ok', unpowered ⇒ 'disconnected') — the most
 * truthful read available before the flood-fill network lands.
 */
export function buildingPowerDiag(b: BuildingRecord): UtilityDiag {
  return asDiag(simFields(b).powerDiag) ?? (b.powered ? 'ok' : 'disconnected');
}

/** A building's water diagnosis (same fallback rule via `watered`). */
export function buildingWaterDiag(b: BuildingRecord): UtilityDiag {
  return asDiag(simFields(b).waterDiag) ?? (b.watered ? 'ok' : 'disconnected');
}

/**
 * Cheap numeric fingerprint of a building's utility diagnosis inputs
 * (final-review R3 L7, 2026-10-01): the exact strings
 * `buildingPowerDiag`/`buildingWaterDiag` would return, hashed without
 * the per-call export overhead — for render-layer memo keys
 * (`utilityIndicatorsFor`). Same inputs ⇒ same fingerprint; the
 * fallback rule is replicated exactly, so a fingerprint match means
 * the diagnosis pair is unchanged.
 */
export function buildingDiagFingerprint(b: BuildingRecord): number {
  const f = simFields(b);
  const pd = asDiag(f.powerDiag) ?? (b.powered ? 'ok' : 'disconnected');
  const wd = asDiag(f.waterDiag) ?? (b.watered ? 'ok' : 'disconnected');
  let h = 0x811c9dc5;
  for (let i = 0; i < pd.length; i++) {
    h ^= pd.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= 0xff;
  h = Math.imul(h, 0x01000193);
  for (let i = 0; i < wd.length; i++) {
    h ^= wd.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * True when the sim flags this building's water source as fouled.
 *
 * VERIFIED 2026-09-30 against sim/utilityNetworks.ts: the sim computes
 * fouled sources per tick but does NOT persist them on the building
 * record (they live in the transient UtilityModel). This hook stays so the
 * purple fouled-source markers light up the moment the sim exposes a
 * per-building fouled flag — until then it reads false (honest: no
 * marker, never a wrong marker). Recommended sim follow-up: set
 * `fouledSource: true` on fouled buildings in the economy pass.
 */
export function buildingFouledSource(b: BuildingRecord): boolean {
  return simFields(b).fouledSource === true;
}

// ---------------------------------------------------------------------------
// Producers + stranded plants.
// ---------------------------------------------------------------------------

/**
 * Power producers: every building kind whose def supplies power. Derived
 * from BUILDING_DEFS (not a hardcoded list) so sim rebalances carry over.
 */
export const POWER_PRODUCER_KINDS: ReadonlySet<string> = new Set(
  (Object.keys(BUILDING_DEFS) as BuildingKind[]).filter(
    (k) => BUILDING_DEFS[k].powerSupply > 0,
  ),
);

/** Water producers: every building kind whose def supplies water. */
export const WATER_PRODUCER_KINDS: ReadonlySet<string> = new Set(
  (Object.keys(BUILDING_DEFS) as BuildingKind[]).filter(
    (k) => BUILDING_DEFS[k].waterSupply > 0,
  ),
);

/**
 * A stranded plant: a power/water producer disconnected from its network.
 * Mirrors the sim's own stranded rule (economy.ts: online plant, diag
 * 'disconnected' on its supply utility) — derived from the diag fields, no
 * extra sim state needed.
 */
export function isStrandedPlant(b: BuildingRecord): boolean {
  const def = BUILDING_DEFS[b.kind as BuildingKind];
  if (def === undefined) return false;
  if (def.powerSupply > 0) return buildingPowerDiag(b) === 'disconnected';
  if (def.waterSupply > 0) return buildingWaterDiag(b) === 'disconnected';
  return false;
}

// ---------------------------------------------------------------------------
// Network cell sets (defensive reads of the Phase 2 sim fields).
// ---------------------------------------------------------------------------

interface UtilityCityFields {
  powerLines?: unknown;
  pipes?: unknown;
}

function cityFields(world: World): UtilityCityFields {
  return world.city as unknown as UtilityCityFields;
}

function asCellSet(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out.push(v);
  }
  return out;
}

/**
 * The sim's `city.powerLines` cell set (empty pre-sim). The sim keeps it
 * sorted; callers treat it as a set regardless of order.
 */
export function cityPowerLines(world: World): number[] {
  return asCellSet(cityFields(world).powerLines);
}

/** The sim's `city.pipes` cell set (empty pre-sim). */
export function cityPipes(world: World): number[] {
  return asCellSet(cityFields(world).pipes);
}

// ---------------------------------------------------------------------------
// Palette availability for the new kinds (pre-sim defensive branch).
// ---------------------------------------------------------------------------

/** Localized "not yet available" reason (shown until the sim lands). */
export function utilityNotYetAvailableReason(): string {
  return loc(STRINGS.utilities.notYetAvailable);
}

/**
 * Availability for a Phase 2 utility building. Once the sim registers
 * the kind in `BUILDING_DEFS`, this runs the standard palette mirror
 * (age gate → affordability) automatically; until then the entry shows
 * greyed with a loud reason instead of failing silently or inventing
 * costs.
 */
export function utilityBuildingAvailability(
  world: World,
  owner: number,
  kind: UtilityBuildingKind,
): Availability {
  const def = (BUILDING_DEFS as Record<string, (typeof BUILDING_DEFS)[keyof typeof BUILDING_DEFS] | undefined>)[kind];
  if (def === undefined) {
    return { ok: false, reason: utilityNotYetAvailableReason() };
  }
  const p = STRINGS.palettes;
  if (!isUnitAvailableForAge(world, owner, def.minAge)) { // per-side ages: the viewer's own age
    return {
      ok: false,
      reason: fillLoc(p.requiresAge, { age: loc(STRINGS.ageNames[def.minAge]) }),
    };
  }
  const player = getPlayer(world.city, owner);
  if (
    player !== undefined &&
    (player.funds < def.costFunds || player.materials < def.costMaterials)
  ) {
    return { ok: false, reason: loc(p.cannotAfford) };
  }
  return { ok: true, reason: '' };
}

/**
 * Localized cost line for a Phase 2 utility building: real costs once
 * the sim registers the def, an em dash until then (never invented).
 */
export function formatUtilityBuildCost(kind: UtilityBuildingKind): string {
  const def = (BUILDING_DEFS as Record<string, (typeof BUILDING_DEFS)[keyof typeof BUILDING_DEFS] | undefined>)[kind];
  if (def === undefined) return '—';
  const p = STRINGS.palettes;
  const parts: string[] = [];
  if (def.costFunds > 0) parts.push(`${def.costFunds} ${loc(p.resFunds)}`);
  if (def.costMaterials > 0) parts.push(`${def.costMaterials} ${loc(p.resMaterials)}`);
  return parts.join(' · ');
}

/** Multi-line build-button tooltip for a Phase 2 utility building. */
export function utilityBuildTooltip(
  world: World,
  owner: number,
  kind: UtilityBuildingKind,
): string {
  const lines = [formatUtilityBuildCost(kind)];
  const av = utilityBuildingAvailability(world, owner, kind);
  if (!av.ok) lines.push(av.reason);
  return lines.filter((l) => l.length > 0).join('\n');
}

// ---------------------------------------------------------------------------
// Utility overlay view data (pure view of sim records — render reads this
// per frame; no sim state ever lives in the UI).
// ---------------------------------------------------------------------------

/** One overlay marker: a diag icon floating above a building. */
export interface UtilityMarker {
  /** World position (building footprint center). */
  x: number;
  z: number;
  /**
   * Marker kind: red = disconnected, amber = shortage, flag = stranded
   * plant, drop = fouled water source.
   */
  kind: 'disconnected' | 'shortage' | 'stranded' | 'fouled';
  /** The building's kind (lets the render layer lift the marker above it). */
  buildingKind: string;
}

/** Everything the utility overlay renders, derived from sim records. */
export interface UtilityOverlayData {
  /** Power-line cells (tinted per network by the render layer). */
  powerLineCells: number[];
  /** Water-pipe cells. */
  pipeCells: number[];
  /** Diag markers above buildings. */
  markers: UtilityMarker[];
  /** Zone cells with power fully served (subtle tint). */
  servedPowerCells: number[];
  /** Zone cells with water fully served (subtle tint). */
  servedWaterCells: number[];
  /** Fouled water-source cells (warning tint). */
  fouledCells: number[];
}

/**
 * Derive the overlay view from the world. "Zone served": a zoned cell is
 * served for a utility when every building on it reports 'ok' for that
 * utility; a cell with no buildings is unserved (never tinted). Marker
 * priority per building: disconnected (red) > shortage (amber); a
 * disconnected producer additionally flags as stranded (flag icon).
 *
 * `cellToWorld(cell)` maps a city cell index to its world center (supplied
 * by the caller so this module stays decoupled from sim grid math);
 * `footprintOf(b)` lists a building's footprint cell indices the same way.
 */
export function utilityOverlayData(
  world: World,
  cellToWorld: (cell: number) => { x: number; z: number },
  footprintOf: (b: BuildingRecord) => number[],
): UtilityOverlayData {
  const markers: UtilityMarker[] = [];
  const servedPower = new Set<number>();
  const servedWater = new Set<number>();
  const fouled = new Set<number>();
  // Per-cell worst diag, then tint cells where everything is 'ok'.
  const powerWorst = new Map<number, UtilityDiag>();
  const waterWorst = new Map<number, UtilityDiag>();
  const rank: Record<UtilityDiag, number> = { ok: 0, shortage: 1, disconnected: 2 };
  /** World center of a footprint cell list (average of cell centers). */
  const footprintCenter = (cells: number[]): { x: number; z: number } => {
    let x = 0;
    let z = 0;
    for (const cell of cells) {
      const w = cellToWorld(cell);
      x += w.x;
      z += w.z;
    }
    return { x: x / cells.length, z: z / cells.length };
  };
  for (const b of world.city.buildings) {
    if (b.progress < 1) continue;
    const pd = buildingPowerDiag(b);
    const wd = buildingWaterDiag(b);
    const cells = footprintOf(b);
    if (cells.length === 0) continue;
    for (const cell of cells) {
      const pw = powerWorst.get(cell);
      if (pw === undefined || rank[pd] > rank[pw]) powerWorst.set(cell, pd);
      const ww = waterWorst.get(cell);
      if (ww === undefined || rank[wd] > rank[ww]) waterWorst.set(cell, wd);
    }
    // One marker per building: the worse of the two diags wins, anchored
    // at the footprint's world center.
    const worst = rank[pd] >= rank[wd] ? pd : wd;
    if (worst !== 'ok') {
      const center = footprintCenter(cells);
      markers.push({ x: center.x, z: center.z, kind: worst, buildingKind: b.kind });
    }
    if (isStrandedPlant(b)) {
      const center = footprintCenter(cells);
      markers.push({ x: center.x, z: center.z, kind: 'stranded', buildingKind: b.kind });
    }
    if (buildingFouledSource(b)) {
      for (const cell of cells) fouled.add(cell);
      const center = footprintCenter(cells);
      markers.push({ x: center.x, z: center.z, kind: 'fouled', buildingKind: b.kind });
    }
  }
  // Only zoned cells get the "served" tint — zones are the plan's
  // zone-level hookup unit (plan §1: a hooked-up zone serves every
  // building in it).
  const zoned = new Set<number>();
  for (const z of world.city.zones) zoned.add(z.cell);
  for (const cell of zoned) {
    if (powerWorst.get(cell) === 'ok') servedPower.add(cell);
    if (waterWorst.get(cell) === 'ok') servedWater.add(cell);
  }
  return {
    powerLineCells: cityPowerLines(world),
    pipeCells: cityPipes(world),
    markers,
    servedPowerCells: [...servedPower].sort((a, b) => a - b),
    servedWaterCells: [...servedWater].sort((a, b) => a - b),
    fouledCells: [...fouled].sort((a, b) => a - b),
  };
}

/**
 * Selection-panel utility line for one building, e.g. "Power: OK ·
 * Water: Shortage". Icons come from the overlay markers; the text line
 * carries the diag names from STRINGS.utilities.
 */
export function buildingUtilityLine(b: BuildingRecord): string {
  const u = STRINGS.utilities;
  const pd = buildingPowerDiag(b);
  const wd = buildingWaterDiag(b);
  const diagName = (d: UtilityDiag): string =>
    d === 'ok' ? loc(u.diagOk) : d === 'shortage' ? loc(u.diagShortage) : loc(u.diagDisconnected);
  return `${loc(u.powerLabel)}: ${diagName(pd)} · ${loc(u.waterLabel)}: ${diagName(wd)}`;
}

/** Player-facing hint for the two new drag tools (click-vs-drag). */
export function networkToolHint(): string {
  return loc(STRINGS.utilities.dragHint);
}

// ---------------------------------------------------------------------------
// NIGHT LAMPS — deferred (documented, not built).
// ---------------------------------------------------------------------------
//
// The brief asked for night lamps driven by the sim's `daylightFactor(tick)`
// "if cheap". It is not cheap: the game has NO day/night cycle today —
// lighting is a static sun + hemisphere in ui/game.ts `buildGameScene`, and
// the sim has no tick-of-day. Wiring lamps would need a full lighting rig
// (sun dimming/travel, sky tint, lamp emissive windows keyed per building)
// plus the sim's day-length design — a Phase 2 sim/render feature in its
// own right, not a cheap add-on. Deferred: the contract expects a pure
// `daylightFactor(tick): number` (0 = deep night, 1 = full day) from the
// sim when the day/night phase lands; the lamp pass will consume it then.
//
// (No code here — this note is the record so nobody re-litigates it.)
