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
 * NOVATERRA — ui/intel.ts — the intel UI contract module (pure).
 *
 * Grand-expansion Phase 7 (intel): the UI/render boundary for the sim's
 * intel asset economy, spy missions, detection, and covert operations
 * (`sim/intel.ts`). The intel panel (hud.ts `intelSectionEl`, reachable
 * from the Management tab) and the selected-spy line read the sim only
 * through this module — never the records directly.
 *
 * What it mirrors (single source of truth stays in the sim):
 *  - Asset counters + accrual rates: mirrors `runIntelAccrual` exactly
 *    (completed + operational + unsabotaged buildings with
 *    `BuildingDef.intelOutput`, in placement order; signalsIntel ×1.5
 *    on surveillance, counterIntel ×1.25 on counter-intel). The rates
 *    are the per-second values the sim accrues (dt = 1 sim-second).
 *  - Spy display state: one precedence chain (burned > infiltrating >
 *    embedded > detected-by-rival > hidden) shared by the panel line,
 *    the warning list, and the `iu:` digest segment — the digest and
 *    the render can never disagree because both derive from
 *    `spyDisplayState`.
 *  - Warnings: burned spies (the `spottedUntil` timer), spies inside a
 *    rival's detection coverage (the pure `isDetected` geometry),
 *    sabotaged player buildings (the `sabotagedUntil` timer), and
 *    mixed-airport discovery (the warning → grace → reveal lifecycle
 *    from sim workstream 3 — `discoveryStateOf` in ui/airports.ts).
 *    Every warning carries a countdown (or null for an ongoing
 *    condition) and a what-happens-next line — no gotcha UX: the
 *    player always sees what's happening and what comes next.
 *  - Rival airports: the Phase 7 mixed-use display rule
 *    (`airportDisplayType` in ui/airports.ts) — a mixed site reads as
 *    civilian until the sim's discovery record for this viewer is
 *    `revealed`, so `discovered` is true exactly when the viewer would
 *    act on the true type.
 *
 * The covert-op commands are NOT validated here: the order builders in
 * ui/orders.ts (`buildInfiltrateOrder` / `buildSabotageOrder` /
 * `buildStealTechOrder`) shape the exact payloads `registerIntelCommands`
 * validates (`{ unitId, buildingId, owner }` — the task's `spyId` is the
 * spy's unit id), and the sim rejects loudly in plain English. The panel
 * wraps those rejections (game.ts toasts them); it never re-implements
 * the validation.
 *
 * Pure module: no DOM, no three.js, no wall clock. Safe under
 * Node/vitest. Deterministic: same state ⇒ same lines, same digest.
 * Reads every sim field defensively (empty pre-sim → empty view), never
 * writes sim state.
 */

import type { World } from '../sim/world';
import {
  BUILDING_DEFS,
  getPlayer,
  type BuildingKind,
  type BuildingRecord,
  type IntelAssets,
} from '../sim/city';
import {
  COUNTER_INTEL_ASSET_MULT,
  INTEL_ADJACENCY,
  SABOTAGE_COST_OPERATIONAL,
  STEAL_COST_SURVEILLANCE,
  STEAL_RESEARCH_GRANT,
  SIGNALS_INTEL_SURVEILLANCE_MULT,
  AIRPORT_DISCOVERY_GRACE_TICKS,
  buildingCenterWorld,
  getIntelAssets,
  isDetected,
  isSabotaged,
  isSpyUnit,
  pickStealableTech,
} from '../sim/intel';
import { TICK_HZ } from '../sim/tick';
import { UNIT_DEFS, type UnitRecord } from '../sim/units';
import { hasUpgrade } from '../sim/upgrades';
import { airportDisplayType, discoveryStateOf, isAirportAnchor } from './airports';
import { STRINGS, fillLoc, loc } from './strings';

// ---------------------------------------------------------------------------
// Asset counters + accrual rates
// ---------------------------------------------------------------------------

/** The player's intel asset counters (undefined-safe for hand-built states). */
export function intelAssetsOf(world: World, owner: number): IntelAssets {
  return getIntelAssets(world, owner);
}

/**
 * Per-second asset accrual for `owner`, mirroring `runIntelAccrual`
 * (sim/intel.ts) exactly: completed + operational + unsabotaged
 * buildings with `BuildingDef.intelOutput`, in placement (id) order,
 * with the signalsIntel / counterIntel upgrade multipliers.
 */
export function intelAccrualRatesOf(world: World, owner: number): IntelAssets {
  const rates: IntelAssets = { surveillance: 0, operational: 0, counterIntel: 0 };
  const survMult = hasUpgrade(world, owner, 'signalsIntel')
    ? SIGNALS_INTEL_SURVEILLANCE_MULT
    : 1;
  const counterMult = hasUpgrade(world, owner, 'counterIntel')
    ? COUNTER_INTEL_ASSET_MULT
    : 1;
  for (const b of world.city.buildings) {
    if (b.owner !== owner) continue;
    const output = BUILDING_DEFS[b.kind]?.intelOutput;
    if (output === undefined) continue;
    if (b.progress < 1 || !b.operational) continue;
    if (isSabotaged(b, world.tick)) continue;
    rates.surveillance += (output.surveillance ?? 0) * survMult;
    rates.operational += output.operational ?? 0;
    rates.counterIntel += (output.counterIntel ?? 0) * counterMult;
  }
  return rates;
}

/** True when the player owns at least one completed intel building. */
export function hasIntelBuildings(world: World, owner: number): boolean {
  return world.city.buildings.some(
    (b) =>
      b.owner === owner &&
      b.progress >= 1 &&
      BUILDING_DEFS[b.kind]?.intelOutput !== undefined,
  );
}

/** One asset's panel line: "Surveillance 12 (+0.5/s)". */
function assetLine(label: string, amount: number, rate: number): string {
  const s = STRINGS.intel;
  return `${label} ${Math.floor(amount)} (+${rate.toFixed(1)}${loc(s.perSecond)})`;
}

/** The three asset counter lines the panel renders (topbar chips use the same values). */
export function intelAssetLines(world: World, owner: number): string[] {
  const s = STRINGS.intel;
  const assets = intelAssetsOf(world, owner);
  const rates = intelAccrualRatesOf(world, owner);
  return [
    assetLine(loc(s.surveillance), assets.surveillance, rates.surveillance),
    assetLine(loc(s.operational), assets.operational, rates.operational),
    assetLine(loc(s.counterIntel), assets.counterIntel, rates.counterIntel),
  ];
}

/** Topbar chip values (floored, like the other resource chips). */
export function intelChipValues(world: World, owner: number): [string, string, string] {
  const assets = intelAssetsOf(world, owner);
  return [
    Math.floor(assets.surveillance).toString(),
    Math.floor(assets.operational).toString(),
    Math.floor(assets.counterIntel).toString(),
  ];
}

// ---------------------------------------------------------------------------
// Spies + mission state
// ---------------------------------------------------------------------------

/** The player's living spies, in id order. */
export function playerSpies(world: World, owner: number): UnitRecord[] {
  return world.units.filter((u) => u.owner === owner && u.hp > 0 && isSpyUnit(u));
}

/**
 * One spy's display state. Precedence is burned > infiltrating >
 * embedded > detected-by-rival > hidden — the most urgent visible fact
 * wins, and the panel line, the warning list, and the digest all derive
 * from this one function so they can never disagree.
 */
export type SpyDisplayState =
  | { kind: 'burned'; secondsLeft: number }
  | { kind: 'infiltrating'; targetId: number; targetLabel: string; secondsLeft: number }
  | { kind: 'embedded'; targetId: number; targetLabel: string }
  | { kind: 'detected'; byCount: number }
  | { kind: 'hidden' };

/** Short English label for a building ("Power Plant"); "?" when it's gone. */
export function buildingLabel(b: BuildingRecord | undefined): string {
  if (b === undefined) return '?';
  return BUILDING_DEFS[b.kind]?.name ?? b.kind;
}

/** Whole seconds left on a tick timer (ceil — the player sees it hit 0 at the end). */
function secondsLeft(endsAtTick: number, tick: number): number {
  return Math.max(0, Math.ceil((endsAtTick - tick) / TICK_HZ));
}

export function spyDisplayState(world: World, u: UnitRecord): SpyDisplayState {
  const tick = world.tick;
  const spottedUntil = u.spottedUntil ?? 0;
  if (spottedUntil > tick) {
    return { kind: 'burned', secondsLeft: secondsLeft(spottedUntil, tick) };
  }
  const endsAt = u.missionEndsAt ?? 0;
  if (endsAt > tick) {
    const target = world.city.buildings.find((b) => b.id === (u.missionTargetId ?? 0));
    return {
      kind: 'infiltrating',
      targetId: u.missionTargetId ?? 0,
      targetLabel: buildingLabel(target),
      secondsLeft: secondsLeft(endsAt, tick),
    };
  }
  const embeddedId = u.embeddedIn ?? 0;
  if (embeddedId > 0) {
    const target = world.city.buildings.find((b) => b.id === embeddedId);
    return { kind: 'embedded', targetId: embeddedId, targetLabel: buildingLabel(target) };
  }
  // Not burned, no mission, not embedded: visible to a rival only
  // inside their detection coverage (the sim's pure isDetected
  // geometry — listening posts / signals stations).
  let byCount = 0;
  for (const p of world.city.players) {
    if (p.id === u.owner) continue;
    if (isDetected(u, p.id, world)) byCount += 1;
  }
  return byCount > 0 ? { kind: 'detected', byCount } : { kind: 'hidden' };
}

/** The selected-spy panel line ("Infiltrating Power Plant · 12s left"). */
export function spyMissionLine(world: World, u: UnitRecord): string {
  const s = STRINGS.intel;
  const state = spyDisplayState(world, u);
  switch (state.kind) {
    case 'burned':
      return fillLoc(s.spyExposed, { seconds: state.secondsLeft });
    case 'infiltrating':
      return fillLoc(s.spyInfiltrating, {
        target: state.targetLabel,
        seconds: state.secondsLeft,
      });
    case 'embedded':
      return fillLoc(s.spyEmbedded, { target: state.targetLabel });
    case 'detected':
      return loc(s.spyDetected);
    case 'hidden':
      return loc(s.spyHidden);
  }
}

/** "Spy 12 · at (x, z)" — the per-spy row header. */
export function spyHeader(u: UnitRecord): string {
  const s = STRINGS.intel;
  return fillLoc(s.spyHeader, {
    id: u.id,
    x: Math.round(u.x),
    z: Math.round(u.z),
  });
}

// ---------------------------------------------------------------------------
// Warnings (discovery + sabotage) — no gotcha UX
// ---------------------------------------------------------------------------

/**
 * One active intel warning. `secondsLeft` is null for an ongoing
 * condition (no timer); `whatNext` always says what happens next or how
 * to resolve it — the player must never be surprised.
 */
export interface IntelWarning {
  /** Stable id: `burned-<spyId>` / `coverage-<spyId>` / `sabotage-<buildingId>` / `discovery-<buildingId>`. */
  id: string;
  kind: 'exposure' | 'detection-risk' | 'sabotage' | 'discovery';
  title: string;
  detail: string;
  secondsLeft: number | null;
  whatNext: string;
}

/**
 * Mixed-airport discovery warnings for `owner` (the discovering side).
 * One warning per rival mixed airport whose sim record for this viewer
 * is `suspected` — the warning the plan requires BEFORE consequences:
 * "suspicious military activity", with the grace-period countdown and
 * what happens when it ends. Revealed airports need no warning (the
 * rival-airports list already shows them as confirmed). Id order.
 *
 * Sim workstream 3 owns the timers (`runAirportDiscovery`); this
 * renders them — the panel's read seam for the discovery UX.
 */
export function discoveryWarnings(world: World, owner: number): IntelWarning[] {
  const s = STRINGS.intel;
  const warnings: IntelWarning[] = [];
  const tick = world.tick;
  for (const b of world.city.buildings) {
    if (b.owner === owner) continue;
    if (BUILDING_DEFS[b.kind]?.airportType !== 'mixed') continue;
    const rec = discoveryStateOf(b, owner);
    if (rec === undefined || rec.state !== 'suspected') continue;
    const revealAt = rec.warnedTick + AIRPORT_DISCOVERY_GRACE_TICKS;
    warnings.push({
      id: `discovery-${b.id}`,
      kind: 'discovery',
      title: fillLoc(s.discoveryWarnTitle, { name: buildingLabel(b) }),
      detail: fillLoc(s.discoveryWarnDetail, {
        seconds: secondsLeft(revealAt, tick),
      }),
      secondsLeft: secondsLeft(revealAt, tick),
      whatNext: loc(s.discoveryWarnNext),
    });
  }
  return warnings;
}

/**
 * Active warnings for `owner`, in id order: burned spies (the
 * `spottedUntil` timer), spies inside rival detection coverage (the
 * pure `isDetected` geometry — no timer, an ongoing condition),
 * sabotaged player buildings (the `sabotagedUntil` timer), and
 * suspected mixed airports (the discovery warning → grace → reveal
 * lifecycle).
 */
export function intelWarnings(world: World, owner: number): IntelWarning[] {
  const s = STRINGS.intel;
  const warnings: IntelWarning[] = [];
  for (const u of playerSpies(world, owner)) {
    const state = spyDisplayState(world, u);
    if (state.kind === 'burned') {
      warnings.push({
        id: `burned-${u.id}`,
        kind: 'exposure',
        title: fillLoc(s.warnExposedTitle, { id: u.id }),
        detail: fillLoc(s.warnExposedDetail, { seconds: state.secondsLeft }),
        secondsLeft: state.secondsLeft,
        whatNext: loc(s.warnExposedNext),
      });
    } else if (state.kind === 'detected') {
      warnings.push({
        id: `coverage-${u.id}`,
        kind: 'detection-risk',
        title: fillLoc(s.warnCoverageTitle, { id: u.id }),
        detail: loc(s.warnCoverageDetail),
        secondsLeft: null,
        whatNext: loc(s.warnCoverageNext),
      });
    }
  }
  const tick = world.tick;
  for (const b of world.city.buildings) {
    if (b.owner !== owner) continue;
    if (!isSabotaged(b, tick)) continue;
    warnings.push({
      id: `sabotage-${b.id}`,
      kind: 'sabotage',
      title: fillLoc(s.warnSabotageTitle, { building: buildingLabel(b) }),
      detail: fillLoc(s.warnSabotageDetail, {
        seconds: secondsLeft(b.sabotagedUntil ?? 0, tick),
      }),
      secondsLeft: secondsLeft(b.sabotagedUntil ?? 0, tick),
      whatNext: loc(s.warnSabotageNext),
    });
  }
  // Grand-expansion Phase 7 (S6 intel, workstream 3): discovery
  // warnings — the discovering side is warned BEFORE the reveal.
  warnings.push(...discoveryWarnings(world, owner));
  return warnings;
}

/** One warning's panel line: title + detail + what-happens-next. */
export function warningLine(w: IntelWarning): string {
  const s = STRINGS.intel;
  const countdown =
    w.secondsLeft === null
      ? ''
      : ` ${fillLoc(s.secondsLeftSuffix, { seconds: w.secondsLeft })}`;
  return `${w.title} — ${w.detail}${countdown}. ${w.whatNext}`;
}

// ---------------------------------------------------------------------------
// Rival airports (discovered / undiscovered)
// ---------------------------------------------------------------------------

/** One rival airport anchor as the intel picture sees it. */
export interface RivalAirportInfo {
  id: number;
  kind: BuildingKind;
  name: string;
  ownerName: string;
  display: 'civilian' | 'military' | 'mixed';
  /**
   * True when the viewer may act on the true type: always for
   * civilian/military anchors, and for mixed anchors only once the
   * sim's discovery record for this viewer is `revealed` (the
   * warning → grace → reveal lifecycle in sim/intel.ts).
   */
  discovered: boolean;
  /**
   * The sim's discovery record state for this viewer ('suspected' /
   * 'revealed'), or undefined for non-mixed anchors and mixed anchors
   * nobody has observed twice. Lets the panel distinguish "under
   * review" (warning active) from "confirmed".
   */
  discoveryState: 'suspected' | 'revealed' | undefined;
}

/** Rival airport anchors, in id order, with their discovered/undiscovered flag. */
export function rivalAirports(world: World, viewerOwner: number): RivalAirportInfo[] {
  const out: RivalAirportInfo[] = [];
  for (const b of world.city.buildings) {
    if (b.owner === viewerOwner || !isAirportAnchor(b)) continue;
    const display = airportDisplayType(b, viewerOwner);
    if (display === undefined) continue;
    const trueType = BUILDING_DEFS[b.kind]?.airportType;
    const ownerName = getPlayer(world.city, b.owner)?.name ?? `player ${b.owner}`;
    const rec = discoveryStateOf(b, viewerOwner);
    out.push({
      id: b.id,
      kind: b.kind,
      name: BUILDING_DEFS[b.kind]?.name ?? b.kind,
      ownerName,
      display,
      discovered: trueType !== 'mixed' || rec?.state === 'revealed',
      discoveryState: trueType === 'mixed' ? rec?.state : undefined,
    });
  }
  return out;
}

/** One rival airport's panel line. */
export function rivalAirportLine(a: RivalAirportInfo): string {
  const s = STRINGS.intel;
  const readAs =
    a.display === 'military'
      ? loc(s.airportMilitary)
      : a.display === 'mixed'
        ? loc(s.airportMixed)
        : loc(s.airportCivilian);
  const flag =
    a.discoveryState === 'revealed'
      ? loc(s.discoveryRevealedFlag)
      : a.discovered
        ? loc(s.airportDiscovered)
        : loc(s.airportUndiscovered);
  return fillLoc(s.airportLine, {
    name: a.name,
    owner: a.ownerName,
    readAs,
    flag,
  });
}

// ---------------------------------------------------------------------------
// Covert-action targets
// ---------------------------------------------------------------------------

/**
 * Enemy completed buildings within `INTEL_ADJACENCY` of the spy — the
 * infiltrate/sabotage candidates the sim would accept on proximity
 * (the sim still validates ownership/mission/assets at enqueue and
 * apply; the UI never re-implements that). Id order.
 */
export function opTargetsOf(world: World, spy: UnitRecord): BuildingRecord[] {
  const out: BuildingRecord[] = [];
  const r2 = INTEL_ADJACENCY * INTEL_ADJACENCY;
  for (const b of world.city.buildings) {
    if (b.owner === spy.owner || b.progress < 1) continue;
    const c = buildingCenterWorld(b);
    const dx = c.x - spy.x;
    const dz = c.z - spy.z;
    if (dx * dx + dz * dz <= r2) out.push(b);
  }
  return out;
}

/**
 * The tech a steal would target right now (the sim's deterministic
 * pick — lexicographically lowest upgrade the victim has and the thief
 * lacks), or null when there is nothing left to steal. Displayed as a
 * preview; the sim re-picks at apply time.
 */
export function stealPreviewTechId(
  world: World,
  thiefOwner: number,
  victimOwner: number,
): string | null {
  return pickStealableTech(world, thiefOwner, victimOwner);
}

// ---------------------------------------------------------------------------
// Static action copy (costs from the sim constants — never hand-copied)
// ---------------------------------------------------------------------------

/** Button label for an infiltrate order. */
export function infiltrateLabel(): string {
  return loc(STRINGS.intel.infiltrateVerb);
}

/** Button label for a sabotage order ("Sabotage · 25"). */
export function sabotageLabel(): string {
  return fillLoc(STRINGS.intel.sabotageVerb, { cost: SABOTAGE_COST_OPERATIONAL });
}

/** Button label for a tech-steal order ("Steal tech · 15"). */
export function stealTechLabel(): string {
  return fillLoc(STRINGS.intel.stealTechVerb, { cost: STEAL_COST_SURVEILLANCE });
}

/** The tech-steal payoff line ("Success grants 40 research"). */
export function stealPayoffLine(): string {
  return fillLoc(STRINGS.intel.stealPayoff, { research: STEAL_RESEARCH_GRANT });
}

/** How to train a spy ("Train spies at the Intel HQ — 400 funds · 40 materials"). */
export function trainSpyHint(): string {
  const def = UNIT_DEFS.spy;
  const hqName = BUILDING_DEFS.intelHQ?.name ?? 'intelHQ';
  return fillLoc(STRINGS.intel.trainSpyHint, {
    funds: def?.trainFunds ?? 0,
    materials: def?.trainMaterials ?? 0,
    building: hqName,
  });
}

// ---------------------------------------------------------------------------
// Digest segments (AD11 — the intel panel's rebuild key)
// ---------------------------------------------------------------------------

/** `ia:` — floored asset counters (matches the rendered integer counters). */
export function intelAssetsDigest(world: World, owner: number): string {
  const a = intelAssetsOf(world, owner);
  return `ia:${Math.floor(a.surveillance)}:${Math.floor(a.operational)}:${Math.floor(a.counterIntel)}`;
}

/** `ir:` — accrual rates to 2 decimals (matches the rendered "+x.xx/s"). */
export function intelRatesDigest(world: World, owner: number): string {
  const r = intelAccrualRatesOf(world, owner);
  return `ir:${r.surveillance.toFixed(2)}:${r.operational.toFixed(2)}:${r.counterIntel.toFixed(2)}`;
}

/**
 * One spy's digest code. Burned `b<secs>`, infiltrating
 * `i<targetId>:<secs>`, embedded `e<targetId>`, inside rival coverage
 * `d<count>`, hidden `h` — always the displayed state
 * (`spyDisplayState`), so the digest moves exactly when the rendered
 * line would. Countdowns are whole seconds (the panel renders seconds),
 * so the panel rebuilds at most once per second per active timer —
 * never per tick.
 */
export function spyStateCode(world: World, u: UnitRecord): string {
  const state = spyDisplayState(world, u);
  switch (state.kind) {
    case 'burned':
      return `b${state.secondsLeft}`;
    case 'infiltrating':
      return `i${state.targetId}:${state.secondsLeft}`;
    case 'embedded':
      return `e${state.targetId}`;
    case 'detected':
      return `d${state.byCount}`;
    case 'hidden':
      return 'h';
  }
}

/** `is:` — per-spy state codes in id order (`is:` with no spies). */
export function intelSpiesDigest(world: World, owner: number): string {
  const codes = playerSpies(world, owner).map((u) => `${u.id}:${spyStateCode(world, u)}`);
  return `is:${codes.join(',')}`;
}

/** `iw:` — warning ids + kinds + countdowns in id order (`iw:` with none). */
export function intelWarningsDigest(world: World, owner: number): string {
  const codes = intelWarnings(world, owner).map(
    (w) => `${w.id}.${w.kind}.${w.secondsLeft === null ? 'x' : w.secondsLeft}`,
  );
  return `iw:${codes.join(',')}`;
}

/** `ig:` — rival airport ids + display types in id order (`ig:` with none). */
export function intelAirportsDigest(world: World, owner: number): string {
  const codes = rivalAirports(world, owner).map((a) => `${a.id}.${a.display}`);
  return `ig:${codes.join(',')}`;
}

/**
 * `iu:` — the selected unit's intel line, for the unit branch of the
 * selection digest. `iu:<id>:x` when the panel renders no intel line
 * (not an owned spy); otherwise the spy's state code. Always emitted,
 * like `ue:`/`ew:`.
 */
export function spyUnitDigest(
  world: World,
  id: number,
  u: UnitRecord | undefined,
  viewerOwner: number,
): string {
  const code =
    u !== undefined && u.owner === viewerOwner && isSpyUnit(u)
      ? spyStateCode(world, u)
      : 'x';
  return `iu:${id}:${code}`;
}
