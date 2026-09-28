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
 * NOVATERRA — ui/game.ts — the game controller (0.1 Alpha playable loop).
 *
 * Responsibilities:
 *  - Own one skirmish session: renderer, daylight scene (terrain + water +
 *    lights), camera controller, entity renderer, HUD, pause menu, advisor
 *    refresh, and the fixed-timestep loop (`driver.step` + render).
 *  - Input: left-click select, drag box-select, right-click context orders
 *    (move / attack), S stop, Space pause, Esc deselect/cancel, WASD+arrows
 *    / edge / middle-drag pan, wheel zoom, Q/E / right-drag rotate.
 *  - Placement modes: train-unit (click map), road (drag cells), zone
 *    (drag rect), building (click cell), demolish (click cell).
 *  - Every player intent becomes a sim command via ui/orders.ts builders
 *    and is enqueued with `issuer: 'player'`. Rejections toast loudly.
 *    The controller NEVER mutates world state directly.
 *
 * The sim stays deterministic and UI-independent: pause = don't step, speed
 * = scale the frame delta (catch-up cap still applies inside the driver).
 *
 * DOM + three.js module: constructed from main.ts, never imported by
 * headless tests.
 */

import * as THREE from 'three';
import type { World } from '../sim/world';
import type { UnitKind, UnitRecord } from '../sim/units';
import { UNIT_DEFS } from '../sim/units';
import { canTarget } from '../sim/combat';
import {
  cellCenterWorld,
  CELL_WORLD_SIZE,
  CITY_GRID_CELLS,
  inBounds,
  MAP_HALF_SIZE,
} from '../sim/city';
import type { AIDifficulty } from '../sim/ai';
import { CommandRejectedError } from '../sim/commands';
import { buildTerrainView } from '../render/terrain';
import { EntityRenderer } from '../render/entities';
import { createSession, HUMAN_PLAYER_ID, type GameSession } from './session';
import {
  applyCameraState,
  createCameraState,
  panCamera,
  rotateCamera,
  tiltCamera,
  zoomCamera,
  type CameraState,
} from './camera';
import {
  boxSelectUnits,
  clearSelection,
  nearestUnit,
  pruneSelection,
  selectBuilding,
  selectUnits,
  toggleUnit,
  type Selection,
} from './selection';
import {
  buildAdvanceAgeOrder,
  buildAssignGeneralOrder,
  buildAssignMayorOrder,
  buildAttackOrders,
  buildCancelTradeRouteOrder,
  buildDemolishOrder,
  buildDismissGeneralOrder,
  buildDismissMayorOrder,
  buildEstablishTradeRouteOrder,
  buildFireAegisOrder,
  buildFireStormOrder,
  buildMoveOrder,
  buildPlaceBuildingOrder,
  buildRoadOrder,
  buildSetGeneralStanceOrder,
  buildSetSpecializationOrder,
  buildStopOrders,
  buildTrainOrder,
  buildZoneOrder,
  type OrderIntent,
} from './orders';
import { evaluateAdvisor, type AdvisorItem } from './advisor';
import { HUD, type BuildTool } from './hud';
import { PauseMenu, loadSettings, type QualityLevel } from './menus';
import { STRINGS } from './strings';
import { AudioEngine } from '../audio/engine';
import { CheatConsole, cheatHelpText, type CheatAction } from './cheatconsole';
import { EndScreen } from './endscreen';
import { SaveSlotsDialog } from './saveslots';
import type { SaveFile, SaveSlotId } from '../net_save/savefile';
import { AUTOSAVE_SLOT, createSaveFile } from '../net_save/savefile';
import { createSaveStore, type SaveStore } from '../net_save/store';
import type { MissionDef, MissionPath } from '../campaign/missions';
import {
  createMissionRun,
  updateMissionRun,
  missionProgress,
  MISSION_HUMAN_ID,
  MISSION_AI_ID,
  type MissionRunState,
} from '../campaign/director';
import { scoreMission, type CampaignProgress } from '../campaign/progress';
import { MuseController, loadMuseFrequency } from '../muse/controller';
import { MuseBox } from './musebox';
import { MissionPanel, MissionDebrief } from './campaignui';

/** Result of a finished campaign mission, handed to the app for scoring. */
export interface MissionEndResult {
  mission: MissionDef;
  victory: boolean;
  wonPath: MissionPath | null;
  kills: number;
  unitsLost: number;
}

/** Campaign wiring for one game: the mission plus its end callback. */
export interface CampaignGameOptions {
  mission: MissionDef;
  /**
   * Called exactly once when the mission ends. Records the result into
   * the campaign progress and returns the updated progress (for the
   * debrief screen). The app saves it asynchronously.
   */
  onMissionEnd(result: MissionEndResult): CampaignProgress;
}

export interface GameOptions {
  seed: number;
  aiDifficulty: AIDifficulty;
  /** Map preset name (see MAP_PRESETS); defaults to 'Meridian Plains'. */
  mapPreset?: string;
  quality: QualityLevel;
  onExitToMenu: () => void;
  /** Resume from a saved game instead of starting fresh. */
  saveData?: SaveFile;
  /** Campaign mission mode (Phase 2). When set, the mission drives setup. */
  campaign?: CampaignGameOptions;
}

/** Placement modes entered from the HUD train/build panels. */
type PlacementMode =
  | { kind: 'train'; unitKind: UnitKind }
  | { kind: 'build'; tool: BuildTool }
  | { kind: 'storm' }
  | null;

const ADVISOR_REFRESH_MS = 2000;
const EDGE_PAN_PX = 10;
const EDGE_PAN_SPEED = 220; // world units/sec
const KEY_PAN_SPEED = 260;
/** Autosave cadence: 5 game-minutes at 30 ticks/sec. */
const AUTOSAVE_TICKS = 30 * 60 * 5;
const CLICK_TOLERANCE = 4; // world units for click-pick

/**
 * Create and start a game. Async because the WebGPU renderer needs init.
 * The returned controller owns the loop; call `dispose()` to tear down.
 */
export async function startGame(
  container: HTMLElement,
  opts: GameOptions,
): Promise<GameController> {
  const session = createSession({
    seed: opts.seed,
    aiDifficulty: opts.aiDifficulty,
    mapPreset: opts.mapPreset,
    snapshot: opts.saveData?.snapshot,
    campaignMission: opts.campaign?.mission,
  });
  // A loaded game resumes exactly where it was saved — including its
  // cheated marker, which is honest metadata, not sim state.
  if (opts.saveData) session.cheated = opts.saveData.metadata.cheated;
  const saveStore = await createSaveStore();

  const { WebGPURenderer } = await import('three/webgpu');
  const canvas = document.createElement('canvas');
  container.appendChild(canvas);
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setSize(window.innerWidth, window.innerHeight);
  applyQuality(renderer, opts.quality);

  const scene = buildGameScene(session);
  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.5,
    4000,
  );
  const entities = new EntityRenderer(scene);

  const controller = new GameController(
    container,
    canvas,
    renderer,
    scene,
    camera,
    entities,
    session,
    opts,
    saveStore,
  );
  controller.start();
  return controller;
}

/** Pixel-ratio cap per quality level (first adaptive-quality step). */
function applyQuality(
  renderer: { setPixelRatio(n: number): void },
  quality: QualityLevel,
): void {
  const cap = quality === 'low' ? 1 : quality === 'medium' ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
}

/** Daylight skirmish scene: sky, fog, lights, real terrain + water. */
function buildGameScene(session: GameSession): THREE.Scene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a8c8);
  scene.fog = new THREE.Fog(0x87a8c8, 380, 1400);

  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x3a4a3a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
  sun.position.set(120, 180, 60);
  scene.add(sun);

  const view = buildTerrainView(session.terrain);
  scene.add(view.group);
  return scene;
}

class GameController {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: {
    setAnimationLoop(cb: ((time: number) => void) | null): void;
    render(s: THREE.Scene, c: THREE.Camera): void;
    setSize(w: number, h: number): void;
    setPixelRatio(n: number): void;
    dispose(): void;
  };
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly entities: EntityRenderer;
  private readonly session: GameSession;
  private readonly opts: GameOptions;
  private readonly hud: HUD;
  private readonly pauseMenu: PauseMenu;
  private readonly audio: AudioEngine;
  private unbindUiClicks: (() => void) | null = null;
  private cameraState: CameraState = createCameraState();
  private selection: Selection = clearSelection();
  private placement: PlacementMode = null;
  private paused = false;
  private speed = 1;
  private advisorItems: AdvisorItem[] = [];
  private lastAdvisorRefresh = 0;
  private readonly keys = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragStart: { x: number; y: number } | null = null;
  /** Combat/building polling state for SFX + adaptive music. */
  private lastMusicUpdate = 0;
  private lastShotSfx = 0;
  private prevPlayerUnitCount = -1;
  private prevPlayerBuildingCount = -1;
  private prevTotalBuildingCount = -1;
  private prevAdvisorTop: string | null = null;
  private dragRect: HTMLElement | null = null;
  /** Last known pointer position in client px (for edge pan). */
  private mouseClient: { x: number; y: number } | null = null;
  private roadDragCells: number[] | null = null;
  private zoneDragStart: { cx: number; cz: number } | null = null;
  private disposed = false;
  private removeListeners: Array<() => void> = [];
  // ---- step 11: saves + cheat console ----
  private readonly saveStore: SaveStore;
  private readonly cheatConsole: CheatConsole;
  private readonly endScreen: EndScreen;
  private slotsDialog: SaveSlotsDialog | null = null;
  /** Tick of the last autosave (sim-time based, every 5 game minutes). */
  private lastAutosaveTick = 0;
  // ---- Phase 2: campaign + Muse ----
  /** Mission run state (UI-owned). Null in skirmish. */
  private readonly missionRun: MissionRunState | null;
  private readonly muse: MuseController | null;
  private readonly museBox: MuseBox | null;
  private readonly missionPanel: MissionPanel | null;
  private readonly missionDebrief: MissionDebrief | null;
  private lastMissionPoll = 0;
  private lastMusePoll = 0;
  private lastObjectivePanelRefresh = 0;
  /** Set once the mission's victory/defeat has been reported. */
  private missionEnded = false;

  constructor(
    container: HTMLElement,
    canvas: HTMLCanvasElement,
    renderer: GameController['renderer'],
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    entities: EntityRenderer,
    session: GameSession,
    opts: GameOptions,
    saveStore: SaveStore,
  ) {
    this.container = container;
    this.canvas = canvas;
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.entities = entities;
    this.session = session;
    this.opts = opts;
    this.saveStore = saveStore;
    this.lastAutosaveTick = session.world.tick;

    // Phase 3: apply persisted accessibility settings.
    const saved = loadSettings();
    this.setColorblind(saved.colorblind);
    this.setUiScale(saved.uiScale);

    this.hud = new HUD(container, {
      onPauseToggle: () => this.togglePause(),
      onSpeedChange: (speed) => {
        this.speed = speed;
        if (this.paused && speed > 0) this.setPaused(false);
      },
      onOpenMenu: () => this.setPaused(true, true),
      onStopSelection: () => this.issueStop(),
      onTrainUnit: (kind) => {
        this.placement = { kind: 'train', unitKind: kind };
        this.hud.toast(`Place ${UNIT_DEFS[kind].name}: left-click the map. Right-click cancels.`);
      },
      onBuildTool: (tool) => {
        this.placement = { kind: 'build', tool };
        this.hud.toast('Construction: drag or click on the map. Right-click cancels.');
      },
      onCancelPlacement: () => {
        this.placement = null;
      },
      onAdvanceAge: (program) => this.issueAdvanceAge(program),
      // Phase 3: superweapons, specialization, trade, delegation.
      onFireAegis: () => this.issueOrder(buildFireAegisOrder(HUMAN_PLAYER_ID)),
      onStormTarget: () => {
        this.placement = { kind: 'storm' };
        this.hud.toast('Storm targeting: left-click the map. Right-click cancels.');
      },
      onSetSpecialization: (spec) =>
        this.issueOrder(buildSetSpecializationOrder(HUMAN_PLAYER_ID, spec)),
      onEstablishTradeRoute: (partner) =>
        this.issueOrder(buildEstablishTradeRouteOrder(HUMAN_PLAYER_ID, partner)),
      onCancelTradeRoute: (partner) =>
        this.issueOrder(buildCancelTradeRouteOrder(HUMAN_PLAYER_ID, partner)),
      onAssignMayor: (policy) =>
        this.issueOrder(buildAssignMayorOrder(HUMAN_PLAYER_ID, policy)),
      onDismissMayor: () => this.issueOrder(buildDismissMayorOrder(HUMAN_PLAYER_ID)),
      onAssignGeneral: (stance) => this.issueAssignGeneral(stance),
      onDismissGeneral: () => this.issueOrder(buildDismissGeneralOrder(HUMAN_PLAYER_ID)),
      onSetGeneralStance: (stance) =>
        this.issueOrder(buildSetGeneralStanceOrder(HUMAN_PLAYER_ID, stance)),
    });
    this.pauseMenu = new PauseMenu(container, {
      onStartSkirmish: () => undefined,
      onResume: () => this.setPaused(false),
      onExitToMenu: () => this.exitToMenu(),
      onQualityChange: (q) => applyQuality(this.renderer, q),
      onAudioChange: (patch) => this.audio.updateSettings(patch),
      onMuseFrequencyChange: (f) => this.setMuseFrequency(f),
      onColorblindChange: (v) => this.setColorblind(v),
      onUiScaleChange: (v) => this.setUiScale(v),
      onSaveGame: () => this.openSaveDialog(),
      onConfirmExit: (saveFirst) => void this.confirmExit(saveFirst),
    });
    this.cheatConsole = new CheatConsole(container, {
      onCheat: (action) => this.executeCheat(action),
    });
    this.endScreen = new EndScreen(container, {
      onKeepPlaying: () => undefined,
      onExitToMenu: () => this.exitToMenu(),
    });

    // Phase 2: campaign mission + Muse persona. The mission run is
    // UI-owned (like session.cheated): it observes the sim and issues
    // commands through the queue, never mutating sim state directly.
    // Muse is always on in campaign missions; in skirmish it follows the
    // saved frequency setting (off = no widget at all).
    const campaignOpts = opts.campaign;
    const museFrequency = loadMuseFrequency();
    if (campaignOpts !== undefined) {
      this.missionRun = createMissionRun(campaignOpts.mission, session.world);
      this.muse = new MuseController({
        frequency: museFrequency === 'off' ? 'normal' : museFrequency,
        say: (text) => this.museBox?.say(text),
      });
      this.museBox = new MuseBox(container);
      this.museBox.show();
      this.missionPanel = new MissionPanel(container);
      this.missionPanel.show();
      this.missionDebrief = new MissionDebrief(container, {
        onContinue: () => this.exitToMenu(),
      });
    } else {
      this.missionRun = null;
      this.muse =
        museFrequency === 'off'
          ? null
          : new MuseController({
              frequency: museFrequency,
              say: (text) => this.museBox?.say(text),
            });
      this.museBox = this.muse !== null ? new MuseBox(container) : null;
      this.museBox?.show();
      this.missionPanel = null;
      this.missionDebrief = null;
    }

    // Audio: created here, unlocked on the first user gesture (autoplay
    // policy). UI clicks anywhere in the game container play the click cue.
    this.audio = new AudioEngine();
    this.unbindUiClicks = this.audio.bindUiClicks(container);
    const unlockOnce = (): void => {
      this.audio.unlock();
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    };
    window.addEventListener('pointerdown', unlockOnce);
    window.addEventListener('keydown', unlockOnce);
    this.removeListeners.push(() => {
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    });

    this.bindInput();
    this.refreshAdvisor(session.world);
  }

  /** Begin the render/sim loop. */
  start(): void {
    let last = performance.now();
    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return;
      const now = performance.now();
      const frameMs = Math.min(now - last, 250);
      last = now;
      const dtSec = frameMs / 1000;

      this.updateCamera(dtSec);
      if (!this.paused) {
        this.session.driver.step(this.session.world, frameMs * this.speed);
        this.maybeAutosave();
      }
      if (now - this.lastAdvisorRefresh > ADVISOR_REFRESH_MS) {
        this.lastAdvisorRefresh = now;
        this.refreshAdvisor(this.session.world);
      }

      const world = this.session.world;
      this.pruneSelection();
      this.entities.sync(world);
      this.entities.setSelected(this.selection.unitIds);
      this.entities.updateSelectionRings(EntityRenderer.unitMap(world));
      this.hud.update(world, this.selection, this.advisorItems, this.paused, this.speed);
      this.pollAudioEvents(world, now);
      this.pollCampaign(world, now);
      this.renderer.render(this.scene, this.camera);
    });
  }

  /**
   * Poll sim state for audio events (UI-layer only; never mutates the sim):
   * adaptive music mood ~2×/sec, death/explosion/building-complete cues,
   * throttled distant weapon-fire while anyone is fighting.
   */
  private pollAudioEvents(world: World, nowMs: number): void {
    // Adaptive music.
    if (nowMs - this.lastMusicUpdate > 500) {
      this.lastMusicUpdate = nowMs;
      this.audio.updateMusic(world, HUMAN_PLAYER_ID);
    }

    let playerUnits = 0;
    let playerBuildings = 0;
    let totalBuildings = 0;
    let anyFighting = false;
    const liveIds = new Set<number>();
    for (const u of world.units) if (u.hp > 0) liveIds.add(u.id);
    for (const u of world.units) {
      if (u.hp <= 0) continue;
      if (u.owner === HUMAN_PLAYER_ID) {
        playerUnits++;
        if (u.targetId !== 0 && liveIds.has(u.targetId)) anyFighting = true;
      }
    }
    for (const b of world.city.buildings) {
      totalBuildings++;
      if (b.owner === HUMAN_PLAYER_ID) playerBuildings++;
    }

    // First poll just records baselines (no cues on game start).
    if (this.prevPlayerUnitCount === -1) {
      this.prevPlayerUnitCount = playerUnits;
      this.prevPlayerBuildingCount = playerBuildings;
      this.prevTotalBuildingCount = totalBuildings;
      return;
    }
    if (playerUnits < this.prevPlayerUnitCount) this.audio.playSfx('unitDown');
    if (playerBuildings > this.prevPlayerBuildingCount) this.audio.playSfx('buildComplete');
    if (totalBuildings < this.prevTotalBuildingCount) this.audio.playSfx('explosion');
    this.prevPlayerUnitCount = playerUnits;
    this.prevPlayerBuildingCount = playerBuildings;
    this.prevTotalBuildingCount = totalBuildings;

    // Distant battle ambience: throttled shots while fighting.
    if (anyFighting && nowMs - this.lastShotSfx > 450) {
      this.lastShotSfx = nowMs;
      this.audio.playSfx('shot');
    }
  }

  setQuality(q: QualityLevel): void {
    applyQuality(this.renderer, q);
  }

  /**
   * Phase 2: campaign director + Muse persona polling (UI-layer only).
   * The mission director ticks ~2×/sec; Muse polls ~1×/sec. Neither
   * ever mutates sim state directly — the director issues commands
   * through the queue, Muse only reads.
   */
  private pollCampaign(world: World, nowMs: number): void {
    const campaignOpts = this.opts.campaign;
    const run = this.missionRun;

    // Muse persona (campaign and skirmish alike, unless silenced).
    if (this.muse !== null && nowMs - this.lastMusePoll > 1000) {
      this.lastMusePoll = nowMs;
      this.muse.update(
        world,
        MISSION_HUMAN_ID,
        MISSION_AI_ID,
        campaignOpts?.mission.name,
      );
      this.museBox?.setThreat(this.muse.threat);
    }

    if (run === null || campaignOpts === undefined || this.missionEnded) return;

    // Objective tracker refresh ~1×/sec.
    if (this.missionPanel !== null && nowMs - this.lastObjectivePanelRefresh > 1000) {
      this.lastObjectivePanelRefresh = nowMs;
      this.missionPanel.update(
        campaignOpts.mission,
        missionProgress(run, campaignOpts.mission, world),
      );
    }

    // Director ~2×/sec.
    if (nowMs - this.lastMissionPoll <= 500) return;
    this.lastMissionPoll = nowMs;
    const directives = updateMissionRun(
      run,
      campaignOpts.mission,
      world,
      this.session.queue,
      this.session.terrain,
    );
    for (const d of directives) {
      switch (d.kind) {
        case 'message':
          // Campaign scripted messages go through Muse (authored content
          // bypasses the chattiness throttle).
          if (this.muse !== null) this.muse.notify(d.text);
          else this.hud.toast(d.text);
          break;
        case 'objectiveComplete':
          break; // panel checkmarks cover this; no extra noise.
        case 'victory':
        case 'defeat': {
          this.missionEnded = true;
          const victory = d.kind === 'victory';
          const result = {
            mission: campaignOpts.mission,
            victory,
            wonPath: victory && d.kind === 'victory' ? d.path : null,
            kills: run.kills,
            unitsLost: run.unitsLost,
          };
          const progress = campaignOpts.onMissionEnd(result);
          const score =
            victory && result.wonPath !== null
              ? scoreMission(run.kills, run.unitsLost)
              : { diplomat: 0, commander: 0 };
          this.missionDebrief?.show({
            mission: campaignOpts.mission,
            victory,
            wonPath: result.wonPath,
            diplomat: score.diplomat,
            commander: score.commander,
            isFinalMission: campaignOpts.mission.order === 8,
            progress,
          });
          if (this.muse !== null) {
            this.muse.notify(
              victory ? 'Mission complete, President. Superb work.' : 'Mission failed. We will get them next time.',
            );
          }
          break;
        }
      }
    }
  }

  /** Live-apply a Muse frequency change from the settings panel. */
  setMuseFrequency(f: Parameters<MuseController['setFrequency']>[0]): void {
    this.muse?.setFrequency(f);
    if (f === 'off') this.museBox?.hide();
    else this.museBox?.show();
  }

  /** Phase 3: apply colorblind-friendly team colors (CSS class on root). */
  setColorblind(v: boolean): void {
    document.documentElement.classList.toggle('colorblind', v);
  }

  /** Phase 3: apply UI scale (CSS variable on root). */
  setUiScale(v: number): void {
    document.documentElement.style.setProperty('--ui-scale', String(v));
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    for (const off of this.removeListeners) off();
    this.removeListeners = [];
    this.hud.dispose();
    this.pauseMenu.hide();
    this.cheatConsole.hide();
    this.endScreen.hide();
    this.museBox?.hide();
    this.missionPanel?.hide();
    this.missionDebrief?.hide();
    this.slotsDialog?.hide();
    this.slotsDialog = null;
    this.unbindUiClicks?.();
    this.unbindUiClicks = null;
    this.audio.dispose();
    this.entities.dispose();
    this.dragRect?.remove();
    this.renderer.dispose();
    this.canvas.remove();
  }

  // ---- pause / speed ----

  private setPaused(paused: boolean, showMenu = false): void {
    this.paused = paused;
    // Pause = suspend the AudioContext (zero CPU, everything freezes).
    if (paused) this.audio.suspend();
    else this.audio.resume();
    if (paused && showMenu) this.pauseMenu.show();
    else if (!paused) this.pauseMenu.hide();
  }

  private togglePause(): void {
    if (this.pauseMenu.visible) {
      this.setPaused(false);
    } else {
      this.setPaused(!this.paused, !this.paused ? false : true);
      if (this.paused) this.pauseMenu.show();
    }
  }

  private exitToMenu(): void {
    this.dispose();
    this.opts.onExitToMenu();
  }

  // ---- step 11: cheats ----

  /** Execute one parsed cheat-console action. */
  private executeCheat(action: CheatAction): void {
    const s = STRINGS.cheats;
    const world = this.session.world;
    const markCheated = (): void => {
      this.session.cheated = true;
    };
    switch (action.kind) {
      case 'help':
        this.cheatConsole.print(cheatHelpText());
        return;
      case 'unknown':
        this.cheatConsole.print(s.unknownCommand);
        return;
      case 'reveal':
        markCheated();
        this.cheatConsole.print(s.revealMsg);
        return;
      case 'win':
        markCheated();
        this.endScreen.showVictory();
        this.cheatConsole.print(STRINGS.end.victoryTitle);
        return;
      case 'lose':
        markCheated();
        this.endScreen.showDefeat();
        this.cheatConsole.print(STRINGS.end.defeatTitle);
        return;
      case 'grant':
      case 'instantBuild': {
        const kind = action.kind === 'grant' ? 'cheatGrantResources' : 'cheatInstantBuild';
        try {
          this.session.queue.enqueue(world, {
            kind,
            issuer: 'cheat',
            payload: { owner: HUMAN_PLAYER_ID },
          });
        } catch (e) {
          const reason = e instanceof CommandRejectedError ? e.reason : String(e);
          this.cheatConsole.print(`${s.failedMsg} ${reason}`);
          this.hud.toast(s.failedMsg);
          return;
        }
        markCheated();
        this.cheatConsole.print(action.kind === 'grant' ? s.grantedMsg : s.buildMsg);
        return;
      }
    }
  }

  // ---- step 11: saves ----

  /** Open the save-game slot picker (from the pause menu). */
  private async openSaveDialog(): Promise<void> {
    const saves = await this.saveStore.list();
    this.slotsDialog?.hide();
    this.slotsDialog = new SaveSlotsDialog(this.container, 'save', saves, {
      onPickSlot: (slotId) => void this.saveGame(slotId),
      onClose: () => undefined,
    });
    this.slotsDialog.show();
  }

  /** Write the current session to a slot. Toasts success/failure. */
  private async saveGame(slotId: SaveSlotId): Promise<boolean> {
    const s = STRINGS.save;
    const name = slotId === AUTOSAVE_SLOT ? 'Autosave' : `Slot ${slotId.replace('slot-', '')}`;
    const file = createSaveFile(this.session, slotId, name, new Date().toISOString());
    const ok = await this.saveStore.write(slotId, file);
    if (ok) {
      if (slotId !== AUTOSAVE_SLOT) this.hud.toast(s.gameSaved);
    } else {
      this.hud.toast(s.saveFailed);
    }
    if (this.saveStore.backend === 'memory' && slotId !== AUTOSAVE_SLOT) {
      this.hud.toast(s.memoryBackendHint);
    }
    return ok;
  }

  /** Autosave when 5 game-minutes have passed since the last one. */
  private maybeAutosave(): void {
    if (this.disposed) return;
    if (this.session.world.tick - this.lastAutosaveTick >= AUTOSAVE_TICKS) {
      this.lastAutosaveTick = this.session.world.tick;
      // Fire-and-forget: saveGame never throws; failure just toasts.
      void this.saveGame(AUTOSAVE_SLOT);
    }
  }

  /**
   * Exit-to-menu confirmation from the pause menu.
   * saveFirst=true writes the autosave slot before leaving.
   */
  private async confirmExit(saveFirst: boolean): Promise<void> {
    if (saveFirst) {
      const ok = await this.saveGame(AUTOSAVE_SLOT);
      if (!ok) return; // stay in game; the failure toast is already shown
    }
    this.exitToMenu();
  }

  // ---- orders ----

  /** Enqueue player commands; rejections toast loudly, never silent. */
  private enqueue(intent: OrderIntent): void {
    try {
      this.session.enqueuePlayerIntent(intent);
    } catch (e) {
      const reason = e instanceof CommandRejectedError ? e.reason : String(e);
      this.hud.toast(reason);
      this.audio.playSfx('error');
    }
  }

  private issueStop(): void {
    for (const cmd of buildStopOrders(this.selection.unitIds, HUMAN_PLAYER_ID)) {
      this.enqueue(cmd);
    }
  }

  private issueAdvanceAge(program: string): void {
    this.enqueue(buildAdvanceAgeOrder(HUMAN_PLAYER_ID, program));
    this.hud.toast(STRINGS.orders.ageAdvanced);
    this.audio.playSfx('ageFanfare');
  }

  /** Phase 3: issue a simple order (fire, specialization, trade, mayor). */
  private issueOrder(intent: OrderIntent): void {
    this.enqueue(intent);
  }

  /** Phase 3: appoint a general over the currently selected units. */
  private issueAssignGeneral(stance: string): void {
    const ids = this.selection.unitIds;
    if (ids.length === 0) {
      this.hud.toast('Select units first, then appoint a general.');
      return;
    }
    this.enqueue(buildAssignGeneralOrder(HUMAN_PLAYER_ID, ids, stance));
    this.hud.toast(`General appointed (${stance}).`);
  }

  /** Right-click: attack an enemy unit, or move to open ground. */
  private issueContextOrder(worldX: number, worldZ: number): void {
    const world = this.session.world;
    const own = new Map<number, UnitRecord>();
    for (const u of world.units) {
      if (u.owner === HUMAN_PLAYER_ID && u.hp > 0) own.set(u.id, u);
    }
    const ownIds = this.selection.unitIds.filter((id) => own.has(id));
    if (ownIds.length === 0) return;
    const clicked = nearestUnit(world.units, worldX, worldZ, CLICK_TOLERANCE);
    if (clicked && clicked.owner !== HUMAN_PLAYER_ID) {
      // canTarget gate (same rule the AI follows): only order attackers
      // whose weapons can actually hit the target's domain.
      const attackers = ownIds.filter((id) => {
        const u = own.get(id)!;
        return canTarget(UNIT_DEFS[u.kind as UnitKind], clicked as UnitRecord);
      });
      if (attackers.length === 0) {
        this.hud.toast(STRINGS.orders.cannotTarget);
        return;
      }
      for (const cmd of buildAttackOrders(attackers, HUMAN_PLAYER_ID, clicked.id)) {
        this.enqueue(cmd);
      }
      this.audio.playSfx('attackOrder');
      return;
    }
    this.enqueue(buildMoveOrder(ownIds, HUMAN_PLAYER_ID, worldX, worldZ));
    this.audio.playSfx('moveOrder');
  }

  // ---- selection ----

  private pruneSelection(): void {
    const liveUnits = new Set<number>();
    for (const u of this.session.world.units) if (u.hp > 0) liveUnits.add(u.id);
    const liveBuildings = new Set<number>(this.session.world.city.buildings.map((b) => b.id));
    this.selection = pruneSelection(this.selection, liveUnits, liveBuildings);
  }

  private handleLeftClick(ndcX: number, ndcY: number, shift: boolean): void {
    const world = this.session.world;
    const point = this.groundPoint(ndcX, ndcY);
    if (!point) return;

    // Placement modes consume the click first.
    if (this.placement?.kind === 'train') {
      this.enqueue(buildTrainOrder(this.placement.unitKind, HUMAN_PLAYER_ID, point.x, point.z));
      this.audio.playSfx('place');
      return;
    }
    if (this.placement?.kind === 'build') {
      this.handleBuildClick(point.x, point.z);
      this.audio.playSfx('place');
      return;
    }
    if (this.placement?.kind === 'storm') {
      this.enqueue(buildFireStormOrder(HUMAN_PLAYER_ID, point.x, point.z));
      this.audio.playSfx('place');
      this.placement = null;
      this.hud.toast('Storm Engine firing.');
      return;
    }

    const clicked = nearestUnit(world.units, point.x, point.z, CLICK_TOLERANCE);
    if (!clicked) {
      // Clicked open ground: maybe a building.
      const building = this.buildingAt(point.x, point.z);
      if (building && !shift) {
        this.selection = selectBuilding(building.id);
        this.audio.playSfx('select');
      } else if (!shift) {
        this.selection = clearSelection();
      }
      return;
    }
    if (shift) {
      this.selection = toggleUnit(this.selection, clicked.id);
    } else {
      this.selection = selectUnits([clicked.id]);
    }
    this.audio.playSfx('select');
  }

  private buildingAt(x: number, z: number): { id: number } | null {
    for (const b of this.session.world.city.buildings) {
      const x0 = cellCenterWorld(b.cx) - CELL_WORLD_SIZE / 2;
      const x1 = cellCenterWorld(b.cx) + CELL_WORLD_SIZE / 2;
      const z0 = cellCenterWorld(b.cz) - CELL_WORLD_SIZE / 2;
      const z1 = cellCenterWorld(b.cz) + CELL_WORLD_SIZE / 2;
      if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return { id: b.id };
    }
    return null;
  }

  // ---- build tools ----

  private worldToCell(x: number, z: number): { cx: number; cz: number } | null {
    const cx = Math.floor((x + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
    const cz = Math.floor((z + MAP_HALF_SIZE) / CELL_WORLD_SIZE);
    if (!inBounds(cx, cz)) return null;
    return { cx, cz };
  }

  private handleBuildClick(x: number, z: number): void {
    const cell = this.worldToCell(x, z);
    if (!cell || this.placement?.kind !== 'build') return;
    const tool = this.placement.tool;
    if (tool === 'road') {
      this.enqueue(buildRoadOrder(HUMAN_PLAYER_ID, [cell.cz * CITY_GRID_CELLS + cell.cx]));
    } else if (tool === 'demolish') {
      this.enqueue(buildDemolishOrder(HUMAN_PLAYER_ID, cell.cx, cell.cz));
    } else if (tool.startsWith('building:')) {
      const kind = tool.slice('building:'.length);
      this.enqueue(buildPlaceBuildingOrder(kind, HUMAN_PLAYER_ID, cell.cx, cell.cz));
    }
    // Zones are drag-only; a click does nothing (hint via toast once).
  }

  private handleZoneDrag(x0: number, z0: number, x1: number, z1: number): void {
    if (this.placement?.kind !== 'build') return;
    const tool = this.placement.tool;
    const zone = tool === 'zoneR' ? 0 : tool === 'zoneC' ? 1 : tool === 'zoneI' ? 2 : null;
    if (zone === null) return;
    const a = this.worldToCell(x0, z0);
    const b = this.worldToCell(x1, z1);
    if (!a || !b) return;
    this.enqueue(buildZoneOrder(
      HUMAN_PLAYER_ID,
      zone as 0 | 1 | 2,
      Math.min(a.cx, b.cx),
      Math.min(a.cz, b.cz),
      Math.max(a.cx, b.cx),
      Math.max(a.cz, b.cz),
    ));
  }

  // ---- input ----

  private groundPoint(ndcX: number, ndcY: number): { x: number; z: number } | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const out = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this.groundPlane, out);
    if (!hit) return null;
    return { x: out.x, z: out.z };
  }

  private toNDC(e: PointerEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
      y: -(((e.clientY - rect.top) / rect.height) * 2 - 1),
    };
  }

  private bindInput(): void {
    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLCanvasElement,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, fn as EventListener, opts);
      this.removeListeners.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    // --- mouse ---
    on(this.canvas, 'pointerdown', (e) => {
      if (e.button === 0) {
        this.dragStart = { x: e.clientX, y: e.clientY };
      } else if (e.button === 2) {
        // Right-click cancels placement, else issues a context order.
        if (this.placement) {
          this.placement = null;
          this.hud.toast('Cancelled.');
        } else {
          const ndc = this.toNDC(e);
          const p = this.groundPoint(ndc.x, ndc.y);
          if (p) this.issueContextOrder(p.x, p.z);
        }
      }
    });
    on(this.canvas, 'pointermove', (e) => {
      this.mouseClient = { x: e.clientX, y: e.clientY };
      if (this.dragStart && e.buttons === 1) {
        const dx = e.clientX - this.dragStart.x;
        const dy = e.clientY - this.dragStart.y;
        if (Math.hypot(dx, dy) > 6 && !this.dragRect) {
          this.dragRect = document.createElement('div');
          this.dragRect.className = 'select-rect';
          this.container.appendChild(this.dragRect);
        }
        if (this.dragRect) {
          const left = Math.min(e.clientX, this.dragStart.x);
          const top = Math.min(e.clientY, this.dragStart.y);
          this.dragRect.style.left = `${left}px`;
          this.dragRect.style.top = `${top}px`;
          this.dragRect.style.width = `${Math.abs(dx)}px`;
          this.dragRect.style.height = `${Math.abs(dy)}px`;
        }
      }
      // Road drag: accumulate cells while painting with the road tool.
      if (this.roadDragCells && e.buttons === 1) {
        const ndc = this.toNDC(e);
        const p = this.groundPoint(ndc.x, ndc.y);
        const cell = p ? this.worldToCell(p.x, p.z) : null;
        if (cell) {
          const idx = cell.cz * CITY_GRID_CELLS + cell.cx;
          if (!this.roadDragCells.includes(idx)) this.roadDragCells.push(idx);
        }
      }
    });
    on(window, 'pointerup', (e) => {
      const start = this.dragStart;
      this.dragStart = null;
      if (this.dragRect) {
        // Box select (or zone drag) from the screen rect.
        const rect = this.dragRect.getBoundingClientRect();
        this.dragRect.remove();
        this.dragRect = null;
        if (start) this.handleDragRect(rect, e.shiftKey);
        return;
      }
      if (start && e.button === 0 && e.target === this.canvas) {
        const ndc = this.toNDC(e);
        // Road tool starts a drag-paint on pointerdown.
        if (this.placement?.kind === 'build' && this.placement.tool === 'road') {
          const p = this.groundPoint(ndc.x, ndc.y);
          const cell = p ? this.worldToCell(p.x, p.z) : null;
          if (cell) {
            this.enqueue(buildRoadOrder(HUMAN_PLAYER_ID, [cell.cz * CITY_GRID_CELLS + cell.cx]));
          }
          return;
        }
        this.handleLeftClick(ndc.x, ndc.y, e.shiftKey);
      }
      // Finish road drag-paint.
      if (this.roadDragCells) {
        const cells = this.roadDragCells;
        this.roadDragCells = null;
        if (cells.length > 0) {
          this.enqueue(buildRoadOrder(HUMAN_PLAYER_ID, cells));
        }
      }
    });
    on(this.canvas, 'contextmenu', (e) => e.preventDefault());
    on(this.canvas, 'wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.cameraState = zoomCamera(this.cameraState, factor);
      applyCameraState(this.camera, this.cameraState);
    }, { passive: false });

    // --- keyboard ---
    on(window, 'keydown', (e) => {
      const k = e.key.toLowerCase();
      if (k === '`' && !e.repeat) {
        e.preventDefault();
        this.cheatConsole.toggle();
        return;
      }
      if (k === ' ') {
        e.preventDefault();
        this.togglePause();
        return;
      }
      if (k === 'escape') {
        if (this.pauseMenu.visible) this.setPaused(false);
        else if (this.placement) {
          this.placement = null;
          this.hud.toast('Cancelled.');
        } else this.selection = clearSelection();
        return;
      }
      if (k === 's' && !e.repeat) {
        this.issueStop();
        return;
      }
      this.keys.add(k);
    });
    on(window, 'keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    on(window, 'blur', () => this.keys.clear());

    // --- resize ---
    on(window, 'resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /** Convert a finished screen drag-rect into a world action. */
  private handleDragRect(rect: DOMRect, shift: boolean): void {
    const canvasRect = this.canvas.getBoundingClientRect();
    const toNDC = (px: number, py: number): { x: number; y: number } => ({
      x: ((px - canvasRect.left) / canvasRect.width) * 2 - 1,
      y: -(((py - canvasRect.top) / canvasRect.height) * 2 - 1),
    });
    const a = toNDC(rect.left, rect.top);
    const b = toNDC(rect.right, rect.bottom);
    const pa = this.groundPoint(a.x, a.y);
    const pb = this.groundPoint(b.x, b.y);
    if (!pa || !pb) return;

    // Zone tools: the drag paints a zone rectangle.
    if (
      this.placement?.kind === 'build' &&
      (this.placement.tool === 'zoneR' || this.placement.tool === 'zoneC' || this.placement.tool === 'zoneI')
    ) {
      this.handleZoneDrag(pa.x, pa.z, pb.x, pb.z);
      return;
    }
    // Otherwise: box-select the player's living units.
    const ids = boxSelectUnits(this.session.world.units, pa.x, pa.z, pb.x, pb.z, HUMAN_PLAYER_ID);
    if (shift) {
      const merged = new Set([...this.selection.unitIds, ...ids]);
      this.selection = selectUnits([...merged]);
    } else {
      this.selection = selectUnits(ids);
    }
  }

  /** Per-frame camera update: keys, edge pan, then apply. */
  private updateCamera(dtSec: number): void {
    let dx = 0;
    let dz = 0;
    const k = this.keys;
    // Screen-aligned pan: yaw rotates the pan axes.
    const yaw = this.cameraState.yaw;
    const forward = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    let fx = 0;
    let fz = 0;
    if (k.has('w') || k.has('arrowup')) { fx += forward.x; fz += forward.z; }
    if (k.has('arrowdown')) { fx -= forward.x; fz -= forward.z; }
    if (k.has('a') || k.has('arrowleft')) { fx -= right.x; fz -= right.z; }
    if (k.has('d') || k.has('arrowright')) { fx += right.x; fz += right.z; }
    // Edge pan: pointer near a screen edge pans that way.
    if (this.mouseClient) {
      const { x, y } = this.mouseClient;
      if (x < EDGE_PAN_PX) { fx -= right.x; fz -= right.z; }
      if (x > window.innerWidth - EDGE_PAN_PX) { fx += right.x; fz += right.z; }
      if (y < EDGE_PAN_PX) { fx += forward.x; fz += forward.z; }
      if (y > window.innerHeight - EDGE_PAN_PX) { fx -= forward.x; fz -= forward.z; }
    }
    if (k.has('q')) this.cameraState = rotateCamera(this.cameraState, 1.6 * dtSec);
    if (k.has('e')) this.cameraState = rotateCamera(this.cameraState, -1.6 * dtSec);
    // Wheel-independent tilt: r/f adjust pitch.
    if (k.has('r')) this.cameraState = tiltCamera(this.cameraState, 0.8 * dtSec);
    if (k.has('f')) this.cameraState = tiltCamera(this.cameraState, -0.8 * dtSec);
    if (fx !== 0 || fz !== 0) {
      const len = Math.hypot(fx, fz);
      dx += (fx / len) * KEY_PAN_SPEED * dtSec * (this.cameraState.distance / 150);
      dz += (fz / len) * KEY_PAN_SPEED * dtSec * (this.cameraState.distance / 150);
    }
    if (dx !== 0 || dz !== 0) this.cameraState = panCamera(this.cameraState, dx, dz);
    applyCameraState(this.camera, this.cameraState);
  }

  private refreshAdvisor(world: World): void {
    this.advisorItems = evaluateAdvisor(world, HUMAN_PLAYER_ID);
    // Ping when the top (worst) problem changes to something new.
    const top = this.advisorItems.length > 0 ? this.advisorItems[0]?.title ?? null : null;
    if (top !== null && top !== this.prevAdvisorTop) {
      // Don't ping on the very first evaluation (game start).
      if (this.prevAdvisorTop !== null) this.audio.playSfx('advisorPing');
    }
    this.prevAdvisorTop = top;
  }
}

/** Re-export for the boot module. */
export type { GameSession };
