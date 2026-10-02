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
 * NOVATERRA — audio/events.ts — sim→audio event differ (0.1 Alpha).
 *
 * The sim never emits audio events directly (that would couple the
 * deterministic core to the UI layer). Instead the game loop snapshots
 * the observable audio-relevant state once per poll and this pure
 * module diffs it against the previous snapshot: deaths (with world
 * positions, for positional SFX), destroyed buildings, newly trained
 * units, finished research, embedded spies, and damage taken since the
 * last poll (feeds both the under-attack warning and the war-mood
 * tracker's damage-based trigger).
 *
 * Pure logic, fully unit-tested in tests/audio.events.test.ts.
 * UI-layer only: never imported by sim code, never affects determinism.
 */

/** One living unit as the audio poll sees it. */
export interface AudioUnitState {
  x: number;
  z: number;
  /** Sim owner id. */
  owner: number;
  hp: number;
  /** True when the unit is an embedded spy (intel op complete). */
  embedded: boolean;
  /** True when the unit currently holds a live target (in combat). */
  inCombat: boolean;
}

/** One standing building as the audio poll sees it. */
export interface AudioBuildingState {
  x: number;
  z: number;
  /** Sim owner id. */
  owner: number;
  hp: number;
  /**
   * Roadmap B11 (2026-10-02): construction progress 0..1 — the differ
   * watches the 0..1 → 1 transition to fire the buildComplete cue.
   * Optional so older snapshots keep compiling; missing = 1 (already
   * standing — a pre-B11 snapshot never fires a false completion).
   */
  progress?: number;
}

/** One poll's audio-relevant world snapshot. */
export interface AudioWorldSnapshot {
  /** Living units by unit id. */
  units: Map<number, AudioUnitState>;
  /** Standing buildings by building id. */
  buildings: Map<number, AudioBuildingState>;
  /** Number of upgrades the human player has researched. */
  researchedCount: number;
  /**
   * Fun-audit A3 (2026-10-02): the researched upgrade ids (world.upgrades
   * order). The differ used to count only — now it also reports WHICH
   * upgrade finished so the completion toast can name it.
   */
  researchedIds: string[];
  /** Number of embedded spies owned by the human player. */
  embeddedSpies: number;
}

/** A death/destruction with its world position (positional SFX). */
export interface AudioDeathEvent {
  x: number;
  z: number;
  /** True when the lost asset belonged to the human player. */
  friendly: boolean;
}

/** What changed since the previous poll. */
export interface AudioPollEvents {
  /** Units that died (positions from the last poll that saw them). */
  deaths: AudioDeathEvent[];
  /** Buildings destroyed (positions from the last poll). */
  destroyed: AudioDeathEvent[];
  /**
   * Buildings whose construction completed since the last poll —
   * roadmap B11 (2026-10-02): `prev.progress < 1 → now.progress >= 1`
   * transitions on standing buildings (positions from the last poll).
   */
  buildsComplete: AudioDeathEvent[];
  /** Human-player units that appeared (trained). */
  trained: number;
  /**
   * Fun-audit B5 (2026-10-02): world positions of friendly units trained
   * since the last poll (capped) — the event-ping system marks where
   * reinforcements arrive, closing the "silent training" gap.
   */
  trainedPositions: Array<{ x: number; z: number }>;
  /** True when the human player finished researching an upgrade. */
  researchDone: boolean;
  /**
   * Fun-audit A3 (2026-10-02): ids of upgrades finished since the last
   * poll (world.upgrades order) — the toast names the first.
   */
  newResearchIds: string[];
  /** Human-player units/buildings that lost hp since the last poll. */
  damageEvents: number;
  /**
   * Fun-audit B5 (2026-10-02): world positions of friendly damage since
   * the last poll (capped) — the event-ping system needs a location for
   * the under-attack marker, and the old code only counted.
   */
  damagePositions: Array<{ x: number; z: number }>;
  /** Human-player combat units right now (war-mood input). */
  combatUnits: number;
  /** True when a new spy embedded since the last poll. */
  intelOpComplete: boolean;
}

/**
 * Diffs consecutive `AudioWorldSnapshot`s into `AudioPollEvents`.
 * The first snapshot only records baselines (no events on game start).
 */
export class AudioEventTracker {
  private prevUnits: Map<number, AudioUnitState> | null = null;
  private prevBuildings: Map<number, AudioBuildingState> | null = null;
  private prevResearched = 0;
  private prevResearchedIds: string[] = [];
  private prevEmbedded = 0;

  /**
   * @param playerId the human player id (`HUMAN_PLAYER_ID` from
   *   ui/session.ts) — "friendly" is relative to this owner.
   */
  constructor(private readonly playerId: number) {}

  /** Diff `snap` against the previous poll. Pure; no DOM, no Web Audio. */
  observe(snap: AudioWorldSnapshot): AudioPollEvents {
    const deaths: AudioDeathEvent[] = [];
    const destroyed: AudioDeathEvent[] = [];
    const buildsComplete: AudioDeathEvent[] = [];
    let damageEvents = 0;
    const damagePositions: Array<{ x: number; z: number }> = [];
    let combatUnits = 0;
    let trained = 0;
    const trainedPositions: Array<{ x: number; z: number }> = [];
    let researchDone = false;
    const newResearchIds: string[] = [];
    let intelOpComplete = false;

    if (this.prevUnits === null || this.prevBuildings === null) {
      // First poll: record baselines only.
      this.prevUnits = snap.units;
      this.prevBuildings = snap.buildings;
      this.prevResearched = snap.researchedCount;
      this.prevResearchedIds = snap.researchedIds;
      this.prevEmbedded = snap.embeddedSpies;
      return { deaths, destroyed, buildsComplete, trained, trainedPositions, researchDone, newResearchIds, damageEvents, damagePositions, combatUnits, intelOpComplete };
    }

    for (const [id, st] of this.prevUnits) {
      const now = snap.units.get(id);
      if (now === undefined) {
        deaths.push({ x: st.x, z: st.z, friendly: st.owner === this.playerId });
      } else if (st.owner === this.playerId && now.hp < st.hp) {
        damageEvents++;
        // Fun-audit B5: keep the location for the under-attack ping.
        if (damagePositions.length < 8) damagePositions.push({ x: now.x, z: now.z });
      }
    }
    for (const [id, st] of this.prevBuildings) {
      const now = snap.buildings.get(id);
      if (now === undefined) {
        destroyed.push({ x: st.x, z: st.z, friendly: st.owner === this.playerId });
      } else {
        // Roadmap B11 (2026-10-02): a construction-completion event is
        // a standing building crossing progress 1. A building that
        // already stood at 1 (the pre-B11 world where progress was not
        // tracked) never fires: prevProgress defaults to 1 in that
        // case, so only 0..1 → 1 transitions register.
        const prevProgress = st.progress ?? 1;
        const nowProgress = now.progress ?? 1;
        if (prevProgress < 1 && nowProgress >= 1) {
          buildsComplete.push({ x: st.x, z: st.z, friendly: st.owner === this.playerId });
        } else if (st.owner === this.playerId && now.hp < st.hp) {
          damageEvents++;
          if (damagePositions.length < 8) damagePositions.push({ x: now.x, z: now.z });
        }
      }
    }
    for (const [id, st] of snap.units) {
      if (this.prevUnits.has(id)) continue;
      // A brand-new unit owned by the human player trained (or spawned);
      // the game loop caps the cue to one per poll.
      if (st.owner === this.playerId) {
        trained++;
        // Fun-audit B5: mark where reinforcements arrive.
        if (trainedPositions.length < 4) trainedPositions.push({ x: st.x, z: st.z });
      }
      void id;
    }
    for (const st of snap.units.values()) {
      if (st.owner === this.playerId && st.inCombat) combatUnits++;
    }
    researchDone = snap.researchedCount > this.prevResearched;
    // Fun-audit A3: which upgrades are new (order-stable — world.upgrades
    // appends). Missing ids (older snapshots) degrade to the boolean.
    const prevIdSet = new Set(this.prevResearchedIds);
    for (const id of snap.researchedIds) {
      if (!prevIdSet.has(id)) newResearchIds.push(id);
    }
    intelOpComplete = snap.embeddedSpies > this.prevEmbedded;

    this.prevUnits = snap.units;
    this.prevBuildings = snap.buildings;
    this.prevResearched = snap.researchedCount;
    this.prevResearchedIds = snap.researchedIds;
    this.prevEmbedded = snap.embeddedSpies;
    return { deaths, destroyed, buildsComplete, trained, trainedPositions, researchDone, newResearchIds, damageEvents, damagePositions, combatUnits, intelOpComplete };
  }
}

/**
 * Build a snapshot from the live world (ui/game.ts call site). Reads
 * the world's real field names (units/city.buildings/upgrades) —
 * `World` here is the sim's World interface, taken structurally so the
 * audio module never imports the sim. Building positions are converted
 * from cell coords to world coords (the panner needs world space);
 * the caller passes the converter (`cellCenterWorld` from sim/city.ts)
 * so this module stays sim-import-free and headless-testable.
 */
export function snapshotForAudio(world: {
  units: Array<{ id: number; owner: number; hp: number; x: number; z: number; targetId: number; embeddedIn?: number }>;
  city: { buildings: Array<{ id: number; owner: number; hp?: number; cx: number; cz: number; progress?: number }> };
  upgrades: Record<number, string[]>;
}, playerId: number, cellToWorld: (c: number) => number): AudioWorldSnapshot {
  const units = new Map<number, AudioUnitState>();
  for (const u of world.units) {
    if (u.hp > 0) {
      units.set(u.id, {
        x: u.x,
        z: u.z,
        owner: u.owner,
        hp: u.hp,
        embedded: (u.embeddedIn ?? 0) !== 0,
        inCombat: u.targetId !== 0,
      });
    }
  }
  const buildings = new Map<number, AudioBuildingState>();
  for (const b of world.city.buildings) {
    // `hp` is optional on legacy records (pre-R2) — those are always
    // treated as standing so they never diff as destroyed.
    const hp = b.hp ?? Number.MAX_SAFE_INTEGER;
    if (hp > 0) {
      buildings.set(b.id, {
        x: cellToWorld(b.cx),
        z: cellToWorld(b.cz),
        owner: b.owner,
        hp,
        // Roadmap B11 (2026-10-02): progress feeds the buildComplete
        // transition detector. Missing = 1 = already standing.
        progress: b.progress ?? 1,
      });
    }
  }
  const researched = world.upgrades[playerId];
  const researchedCount = researched !== undefined ? researched.length : 0;
  // Fun-audit A3: carry the ids so the differ can name the completion.
  const researchedIds = researched !== undefined ? [...researched] : [];
  let embeddedSpies = 0;
  for (const u of units.values()) {
    if (u.owner === playerId && u.embedded) embeddedSpies++;
  }
  return { units, buildings, researchedCount, researchedIds, embeddedSpies };
}
