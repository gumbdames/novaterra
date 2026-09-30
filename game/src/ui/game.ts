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
 *  - Input: left-click select, left-drag grab-pan (no tool armed),
 *    right-click context orders (move / attack), S stop, Space pause,
 *    Esc deselect/cancel, WASD+arrows / edge pan, wheel zoom,
 *    Q/E rotate, middle-drag orbit (yaw + pitch).
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
  BUILDING_DEFS,
  cellCenterWorld,
  cellCoords,
  CELL_WORLD_SIZE,
  CITY_GRID_CELLS,
  getPlayer,
  inBounds,
  MAP_HALF_SIZE,
  type BuildingKind,
  type RoadClass,
  type TransitMode,
} from '../sim/city';
import type { AIDifficulty } from '../sim/ai';
import { CommandRejectedError } from '../sim/commands';
import type { TerrainData } from '../sim/terrain';
import { buildTerrainView, type TerrainView } from '../render/terrain';
import { EntityRenderer } from '../render/entities';
import {
  registerAmbientTransitProvider,
  unregisterAmbientTransitProvider,
} from '../render/cityLife';
import {
  createBusProvider,
  createFerryProvider,
  createTramProvider,
  transitRouteKey,
  transitRoutePoints,
  transitVehicleCount,
  type AmbientVehicleProvider,
  type TransitProviderOptions,
  type TransitProviderType,
  type TransitRouteStop,
} from '../render/transitProviders';
// Grand-expansion Phase 5 (S5+S8): ambient airliners.
import {
  airlinerCount,
  airlinerRouteKey,
  createAirlinerProvider,
} from '../render/airlineProviders';
import {
  createCargoShipProvider,
  cargoShipRouteKey,
  cargoShipRoutePoints,
  cargoShipVehicleCount,
  type AmbientCargoShipProvider,
  type CargoRouteStop,
  type CargoShipProviderOptions,
} from '../render/cargoShipProviders';
import { createRenderer, applyEnvironmentLighting } from '../render/renderer';
import { buildNatureView, type NatureView } from '../render/nature';
import { loadNatureTreeModels } from '../render/natureTrees';
import {
  disposeModels,
  MODEL_PATHS,
  type LoadedModel,
} from '../render/models';
import {
  collectKindKeys,
  LazyModelStore,
  TREE_MODEL_KEYS,
} from '../render/lazyModels';
import { createSession, getSkirmishOutcome, HUMAN_PLAYER_ID, AI_PLAYER_ID, type GameSession } from './session';
// Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
// the peaceful end-screen outcome helper (pure, headless-tested).
import { peacefulOutcome, peacefulEndCopy } from './peaceful';
import {
  applyCameraState,
  createCameraState,
  edgePanVector,
  guardCameraState,
  orbitDrag,
  panCamera,
  panDragTarget,
  pressDragKind,
  rotateCamera,
  tiltCamera,
  worldPerPixelAtTarget,
  zoomCamera,
  type CameraState,
  type PressDragKind,
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
  buildDismissGeneralOrder,
  buildDismissMayorOrder,
  buildEstablishTradeRouteOrder,
  buildFireAegisOrder,
  buildFireStormOrder,
  buildMoveOrder,
  buildEmbarkOrder,
  buildBaseOrder,
  buildLaunchOrder,
  // Grand-expansion Phase 7 (intel): the covert-op orders.
  buildInfiltrateOrder,
  buildSabotageOrder,
  buildStealTechOrder,
  buildSetMayorBuildPolicyOrder,
  buildSetGeneralStanceOrder,
  buildSetSpecializationOrder,
  buildSetPolicyOrder,
  buildSetTaxRateOrder,
  buildStopOrders,
  buildZoneOrder,
  buildResearchUpgradeOrder,
  buildResupplyOrder,
  buildSupplyTogglesOrder,
  buildUpgradeRoadOrder,
  // Grand-expansion Phase 5 (S5): the airline orders.
  buildCancelAirlineRouteOrder,
  partitionRoadCells,
  type OrderIntent,
} from './orders';
import { evaluateAdvisor, type AdvisorItem } from './advisor';
import { HUD, type BuildTool } from './hud';
import {
  resolveBuildToolClick,
  resolveTrainClick,
  // Grand-expansion Phase 5 (S5): the airline two-click gesture.
  resolveAirlineClick,
  type PlacementResolution,
  type AirlineClickResolution,
} from './placement';
import { classifyPointerUp } from './pointer';
import { networkToolHint } from './utilities';
import {
  LinearNetworkDrag,
  networkKindForTool,
  resolveNetworkToolClick,
} from './linearNetworkDrag';
import { PauseMenu, loadSettings, type QualityLevel } from './menus';
import { STRINGS, loc } from './strings';
import { trainPlacementToast } from './palettes';
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
  /**
   * Peaceful skirmish (grand-expansion Phase 8, workstream B,
   * 2026-09-30): forwarded to `SessionOptions.peaceful` — no military,
   * the rival plays peacefully, and the peaceful victory owns the
   * outcome. Defaults to false.
   */
  peaceful?: boolean;
}

/** Placement modes entered from the HUD train/build panels. */
type PlacementMode =
  | { kind: 'train'; unitKind: UnitKind }
  | { kind: 'build'; tool: BuildTool }
  | { kind: 'storm' }
  | null;

const ADVISOR_REFRESH_MS = 2000;
// Edge-pan zone width lives in ui/camera.ts (EDGE_PAN_PX) next to the pure
// edgePanVector the frame loop feeds — single source of truth.
const KEY_PAN_SPEED = 260;
/** Game camera vertical field of view (degrees) — shared by the camera
 *  setup and the drag-pan pixel scale. */
const GAME_FOV_DEG = 55;
/** Autosave cadence: 5 game-minutes at 30 ticks/sec. */
const AUTOSAVE_TICKS = 30 * 60 * 5;
const CLICK_TOLERANCE = 4; // world units for click-pick

// ---------------------------------------------------------------------------
// Frame-loop seam (camera/input-freeze hardening, 2026-09-30).
//
// The animation-loop callback used to be one inline closure: ANY
// exception in a single frame (a new building's view creation, a HUD
// digest update, …) propagated out of the three.js callback and the
// loop never rescheduled — freezing the camera AND all input at once
// with no visible error. Two pieces fix that:
//
// - `runGameFrame` holds the per-frame body as a standalone exported
//   function over an explicit dependency interface, so the
//   loop-error-boundary regression test can drive real frames
//   headlessly (place buildings via the command queue, advance
//   frames, assert the world keeps ticking).
// - `guardGameFrame` is the error boundary around it: a frame's
//   exception is logged LOUDLY — sim tick + armed tool for repro —
//   the player gets one throttled toast, and the loop survives.
//   This must never mask sim bugs silently: every caught error goes
//   to console.error with its full stack.
// ---------------------------------------------------------------------------

/** Everything one game frame needs — the seam ui.gameLoop.test.ts drives. */
export interface GameFrameDeps {
  session: GameSession;
  paused: boolean;
  speed: number;
  selection: Selection;
  advisorItems: AdvisorItem[];
  updateCamera(dtSec: number): void;
  maybeAutosave(): void;
  maybeShowConquestOutcome(): void;
  refreshAdvisor(world: World): void;
  pruneSelection(): void;
  syncEntities(world: World): void;
  /**
   * Phase 4 (transport): keep the ambient transit providers (bus/tram/
   * ferry) — and the Phase 6 cargo-ship provider — in sync with the
   * player's networks. Runs before syncEntities so the crowd sees the
   * current providers.
   */
  syncTransitProviders(world: World): void;
  setSelectedEntities(unitIds: number[]): void;
  updateEntitySelectionRings(world: World): void;
  updateHud(
    world: World,
    selection: Selection,
    advisorItems: AdvisorItem[],
    paused: boolean,
    speed: number,
    terrain: TerrainData,
  ): void;
  pollAudioEvents(world: World, nowMs: number): void;
  pollCampaign(world: World, nowMs: number): void;
  renderFrame(): void;
  getLastAdvisorRefresh(): number;
  setLastAdvisorRefresh(nowMs: number): void;
}

/**
 * One frame of the render/sim loop (extracted from
 * `GameController.start()`). Pure orchestration over `deps` — no DOM,
 * no three.js at this level (those live behind the dep closures), so
 * headless tests can run real frames against a real session.
 */
export function runGameFrame(deps: GameFrameDeps, nowMs: number, frameMs: number): void {
  const dtSec = frameMs / 1000;
  deps.updateCamera(dtSec);
  const world = deps.session.world;
  if (!deps.paused) {
    deps.session.driver.step(world, frameMs * deps.speed);
    deps.maybeAutosave();
    deps.maybeShowConquestOutcome();
  }
  if (nowMs - deps.getLastAdvisorRefresh() > ADVISOR_REFRESH_MS) {
    deps.setLastAdvisorRefresh(nowMs);
    deps.refreshAdvisor(world);
  }
  deps.pruneSelection();
  // Phase 4 (transport): refresh ambient transit providers before the
  // entity sync so the crowd renders this frame's registrations.
  deps.syncTransitProviders(world);
  deps.syncEntities(world);
  deps.setSelectedEntities(deps.selection.unitIds);
  deps.updateEntitySelectionRings(world);
  deps.updateHud(world, deps.selection, deps.advisorItems, deps.paused, deps.speed, deps.session.terrain);
  deps.pollAudioEvents(world, nowMs);
  deps.pollCampaign(world, nowMs);
  deps.renderFrame();
}

/** Repro context captured when a frame throws. */
export interface FrameErrorContext {
  /** Sim tick at the throw — anchors the report to a replay/snapshot. */
  tick: number;
  /** What the player had armed (tool id, 'train', 'storm', or null). */
  armedTool: string | null;
}

/**
 * Loop error boundary: runs one frame's work; on exception logs
 * loudly (tick + armed tool, full error) and lets the loop continue.
 * The `onFrameError` callback is for player-visible feedback (the
 * controller throttles it to one toast per few seconds so a
 * per-frame throw can't spam the HUD).
 */
export function guardGameFrame(
  work: () => void,
  ctx: FrameErrorContext,
  onFrameError: (message: string) => void,
): void {
  try {
    work();
  } catch (err) {
    // Loud by design — a swallowed frame error would hide sim/render
    // bugs. Tick + armed tool give the reporter (and us) a repro.
    console.error(
      `[novaterra] game-loop frame threw at tick ${ctx.tick} ` +
        `(armedTool=${ctx.armedTool ?? 'none'}) — the loop survives; please report this.`,
      err,
    );
    onFrameError('A frame glitched, but the game kept running.');
  }
}

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
    // Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
    // the skirmish setup's peaceful toggle (main.ts) reaches the sim
    // here. Restored saves carry the snapshot's own flag.
    peaceful: opts.peaceful,
  });
  // A loaded game resumes exactly where it was saved — including its
  // cheated marker, which is honest metadata, not sim state.
  if (opts.saveData) session.cheated = opts.saveData.metadata.cheated;
  const saveStore = await createSaveStore();

  // Defensive: never stack a second game canvas over a stale one. A previous
  // controller always removes its canvas in dispose(), but if one somehow
  // survived (or a second startGame raced the first), the stale canvas would
  // paint over — or swallow pointer input meant for — the live game. Only
  // tagged game canvases are cleared: the menu's untagged backdrop canvas is
  // hidden (not removed) by the caller and must survive for the return trip.
  container
    .querySelectorAll('canvas[data-novaterra="game"]')
    .forEach((stale) => stale.remove());
  const canvas = document.createElement('canvas');
  canvas.dataset.novaterra = 'game';
  container.appendChild(canvas);
  // Hang-proof init: a wedged GPU channel falls back to WebGL2 instead of
  // hanging startGame() forever on a blank screen (render/renderer.ts).
  const renderer = await createRenderer(canvas);
  renderer.setSize(window.innerWidth, window.innerHeight);
  applyQuality(renderer, opts.quality);

  const { scene, terrainView } = buildGameScene(session);
  // Procedural environment map so metalness/roughness on entity
  // materials shade correctly (render/renderer.ts); subtle fill only,
  // the sun/hemi lights stay the key light.
  applyEnvironmentLighting(scene);
  const camera = new THREE.PerspectiveCamera(
    GAME_FOV_DEG,
    window.innerWidth / window.innerHeight,
    0.5,
    4000,
  );
  const entities = await loadEntityModels(session, scene, terrainView);
  // Camera for instanced health-bar billboarding (Phase 0 draw-call
  // ceiling: `instanced: true` is set on the EntityRenderer above).
  entities.renderer.setCamera(camera);
  // Phase 4 RENDER workstream A (item 1): the x-ray view borrows the
  // terrain + water materials (late-bound — the TerrainView is built
  // before the renderer).
  entities.renderer.setXrayMaterials(
    terrainView.terrainMaterial,
    terrainView.water.material as THREE.Material,
  );

  const controller = new GameController(
    container,
    canvas,
    renderer,
    scene,
    camera,
    entities.renderer,
    session,
    opts,
    saveStore,
    { modelMap: entities.modelMap, nature: entities.nature },
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
function buildGameScene(session: GameSession): { scene: THREE.Scene; terrainView: TerrainView } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87a8c8);
  scene.fog = new THREE.Fog(0x87a8c8, 380, 1400);

  scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x3a4a3a, 1.1));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.0);
  sun.position.set(120, 180, 60);
  scene.add(sun);

  const view = buildTerrainView(session.terrain);
  scene.add(view.group);
  return { scene, terrainView: view };
}

/** Overall startup budget for ALL model loads (~20s): boot must never hang. */
const MODEL_LOAD_ALL_TIMEOUT_MS = 20000;

/**
 * Load the CC0 entity models (bounded by MODEL_LOAD_ALL_TIMEOUT_MS —
 * whatever finished in time is used; the rest fall back), overlay the
 * procedural textured trees (same bound; the Kenney tree GLBs stay as
 * the silent fallback and are fetched only if the textured trees fail),
 * construct the EntityRenderer with the resulting map, and build the
 * deterministic render-only nature scatter for the session terrain.
 *
 * Boot loads only the lazy boot set (foundation-age kinds + nature
 * props — `render/lazyModels.ts`); every other key loads on first use
 * through the store's self-triggering map, with the Cache API keeping
 * fetched keys available offline. An empty model map is fully
 * supported: entities resolve GLB → procedural → placeholder and the
 * game stays playable.
 */
async function loadEntityModels(
  session: GameSession,
  scene: THREE.Scene,
  terrainView: TerrainView,
): Promise<{ renderer: EntityRenderer; modelMap: Map<string, LoadedModel>; nature: NatureView | null }> {
  const timeout = new Promise<null>((resolve) => {
    setTimeout(() => resolve(null), MODEL_LOAD_ALL_TIMEOUT_MS);
  });
  const loadAll = (async () => {
    const store = new LazyModelStore(MODEL_PATHS);
    // Kinds already present in the world (loaded save games, campaign
    // missions with pre-placed forces): request their keys up front so
    // their views resolve on the first sync instead of flashing the
    // fallback. Fresh games only have engineers/rifles (boot keys).
    const presentKinds = new Set<string>();
    for (const u of session.world.units) presentKinds.add(u.kind);
    for (const b of session.world.city.buildings) presentKinds.add(b.kind);
    const [boot, , trees] = await Promise.all([
      store.loadBootSet(),
      store.requestMany(collectKindKeys(presentKinds)),
      // Textured trees replace the Kenney tree GLBs in the map below.
      // A texture failure throws → caught here → the tree GLBs are
      // fetched as the fallback before the scatter is built.
      loadNatureTreeModels().catch((err: unknown) => {
        console.warn('[game] textured tree models unavailable (Kenney GLB fallback in use):', err);
        return null;
      }),
    ]);
    if (trees === null) {
      await store.requestMany(TREE_MODEL_KEYS);
    } else {
      for (const [key, model] of trees) store.adopt(key, model);
    }
    return { store, boot };
  })();
  const result = await Promise.race([loadAll, timeout]);
  // On timeout the in-flight loads keep settling into the abandoned
  // store (harmless); the game starts with an empty map and keys stream
  // in on first use — same graceful degradation as before.
  const store = result?.store ?? new LazyModelStore(MODEL_PATHS);
  const modelMap = store.map;
  const boot = result?.boot ?? null;
  if (boot === null) {
    console.warn('[game] model loading exceeded the startup budget; using fallbacks');
  } else if (boot.failed.length > 0) {
    console.warn('[game] models failed to load (fallbacks in use):', boot.failed.join(', '));
  }
  const renderer = new EntityRenderer(scene, modelMap, {
    waterLevel: session.terrain.waterLevel,
    // Living nature: the renderer bobs the TerrainView's water plane
    // with the ambient swell (caller-owned; never disposed by it).
    waterMesh: terrainView.water,
    // Entity views ride on the terrain (units/buildings/roads/rings/FX);
    // without this every entity would sit at y=0 and bury itself in
    // hillsides (terrain height ranges −10…+30).
    terrain: session.terrain,
    // Per-kind instanced entity views (Phase 0 draw-call ceiling):
    // model bodies, team stripes/pennants, and health bars render from
    // shared InstancedMesh pools — draw calls scale with distinct kinds,
    // never with entity count.
    instanced: true,
  });
  // Deterministic render-only nature scatter (built once from initial
  // state; decorative only, never affects the sim).
  const nature = buildNatureView({
    terrain: session.terrain,
    models: modelMap,
    isOccupied: buildNatureOccupancy(session.world),
    seed: session.seed,
  });
  if (nature !== null) scene.add(nature.group);
  return { renderer, modelMap, nature };
}

/**
 * Occupancy callback for nature scatter: building footprints, road
 * cells, and starting unit positions reject decorative props. Built
 * once at startup from initial state (render-only decoration).
 */
function buildNatureOccupancy(world: World): (x: number, z: number) => boolean {
  const cells = new Set<string>();
  for (const b of world.city.buildings) {
    const def = BUILDING_DEFS[b.kind as BuildingKind];
    for (let dx = 0; dx < def.footprintW; dx++) {
      for (let dz = 0; dz < def.footprintH; dz++) {
        cells.add(`${b.cx + dx},${b.cz + dz}`);
      }
    }
  }
  for (const c of world.city.roads) {
    const { cx, cz } = cellCoords(c.cell);
    cells.add(`${cx},${cz}`);
  }
  for (const u of world.units) {
    cells.add(
      `${Math.round(u.x / CELL_WORLD_SIZE)},${Math.round(u.z / CELL_WORLD_SIZE)}`,
    );
  }
  return (x, z) =>
    cells.has(`${Math.round(x / CELL_WORLD_SIZE)},${Math.round(z / CELL_WORLD_SIZE)}`);
}

/** Ownership extras for the game controller: caller-owned assets the
 * renderer borrows (model map) and scene decorations (nature) that
 * must be torn down in dispose(). */
export interface GameControllerExtras {
  /** Loaded CC0 models (borrowed by the EntityRenderer, not disposed). */
  modelMap?: Map<string, LoadedModel>;
  /** Nature scatter view (removed + released in dispose()). */
  nature?: NatureView | null;
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
  /**
   * Phase 4 hardening (item 7): the last camera state that passed the
   * NaN guard. A poisoned state is never applied and never remembered —
   * the camera restores this instead of wedging permanently.
   */
  private lastGoodCameraState: CameraState = createCameraState();
  private selection: Selection = clearSelection();
  private placement: PlacementMode = null;
  private paused = false;
  private speed = 1;
  /** Phase 2 (utilities): utility-network overlay visibility. */
  private utilityOverlayVisible = false;
  /** Phase 3 (logistics): logistics-overlay visibility. */
  private logisticsOverlayVisible = false;
  /** Grand-expansion Phase 5 (S5+S8): airport-site overlay visibility. */
  private airportOverlayVisible = false;
  /** Workstream W (desirability): land-value overlay visibility. */
  private desirabilityOverlayVisible = false;
  /** Phase 4 RENDER workstream A (item 1): x-ray view visibility. */
  private xrayVisible = false;
  /** True when x-ray is on because the water-pipe tool armed it. */
  private xrayAutoEnabled = false;
  /** Phase 4 RENDER workstream A (follow-up B): terrain grid visibility. */
  private gridVisible = false;
  private advisorItems: AdvisorItem[] = [];
  private lastAdvisorRefresh = 0;
  private readonly keys = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private dragStart: { x: number; y: number } | null = null;
  /**
   * What the in-flight primary-button gesture means, snapshotted at
   * pointerdown via pressDragKind() and never re-evaluated mid-gesture:
   * 'pan' grab-pans the map (no tool was armed), 'place' belongs to the
   * armed placement tool. Arming or cancelling a tool while a drag is in
   * flight cannot flip the gesture's meaning. Null when no primary drag
   * is in flight.
   */
  private leftDragKind: PressDragKind | null = null;
  /** Last pointer position of the in-flight pan drag (for move deltas). */
  private panLast: { x: number; y: number } | null = null;
  /** Last pointer position of the in-flight middle-drag orbit. */
  private orbitLast: { x: number; y: number } | null = null;
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
  /** In-progress linear-network drag (road tool today; power lines/pipes/rail later). */
  private networkDrag: LinearNetworkDrag | null = null;
  /**
   * Phase 4 (transport): the registered ambient transit providers, one
   * per type. Created once per route change (player actions) — never
   * per frame — and disposed on replace/teardown. The mutable `count`
   * follows population every frame (cheap; no geometry churn).
   */
  private transitProviders = new Map<TransitProviderType, AmbientVehicleProvider>();
  private lastTransitRouteKey = '';
  /**
   * Grand-expansion Phase 6 (workstream C): the ambient cargo-ship
   * provider. Lifecycle mirrors the Phase 4 transit providers —
   * rebuilt only when the civilian-port key moves (player actions),
   * `count` refreshed every frame from population (cheap, no geometry
   * churn). Kept separate from the transitProviders map because its
   * route/key/count helpers have a different shape (ports, not stops).
   */
  private cargoShipProvider: AmbientCargoShipProvider | null = null;
  private lastCargoRouteKey = '';
  /**
   * Grand-expansion Phase 5 (S5+S8): the ambient airliner provider.
   * Lifecycle mirrors the cargo-ship provider — rebuilt only when the
   * airline-endpoint key moves (player actions), `count` refreshed
   * every frame from population (cheap, no geometry churn).
   */
  private airlinerProvider: AmbientVehicleProvider | null = null;
  private lastAirlineRouteKey = '';
  private zoneDragStart: { cx: number; cz: number } | null = null;
  private disposed = false;
  /** `?inputdebug=1` — verbose pointer-event console logging for diagnosis. */
  private readonly inputDebug: boolean =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('inputdebug') === '1';
  private removeListeners: Array<() => void> = [];
  // ---- step 11: saves + cheat console ----
  private readonly saveStore: SaveStore;
  private readonly cheatConsole: CheatConsole;
  private readonly endScreen: EndScreen;
  private slotsDialog: SaveSlotsDialog | null = null;
  /** Tick of the last autosave (sim-time based, every 5 game minutes). */
  private lastAutosaveTick = 0;
  /** True once the conquest victory screen has been shown (one-shot). */
  private victoryShown = false;
  /** True once the conquest defeat screen has been shown (one-shot). */
  private defeatShown = false;
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
  /**
   * Loaded CC0 entity models for this session. Caller-owned: the
   * renderer borrows the map's shared geometry/materials and never
   * disposes it — this controller releases it in dispose(). Empty
   * (all loads failed) is fully supported.
   */
  private readonly modelMap: Map<string, LoadedModel>;
  /** Nature scatter view (released in dispose()). */
  private readonly natureView: NatureView | null;

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
    extras: GameControllerExtras = {},
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
    this.modelMap = extras.modelMap ?? new Map();
    this.natureView = extras.nature ?? null;
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
        // Grand-expansion Phase 5 (S5): arming a palette tool disarms
        // the airline gesture (one armed gesture at a time).
        this.disarmAirlineTool();
        this.hud.toast(trainPlacementToast(kind));
      },
      onBuildTool: (tool) => {
        this.placement = { kind: 'build', tool };
        // Grand-expansion Phase 5 (S5): arming a palette tool disarms
        // the airline gesture (one armed gesture at a time).
        this.disarmAirlineTool();
        // Phase 2 (utilities): network tools say what they paint.
        this.hud.toast(
          tool === 'powerLine' || tool === 'waterPipe'
            ? `${loc(STRINGS.palettes.buildToast)} ${networkToolHint()}`
            : loc(STRINGS.palettes.buildToast),
        );
        // Phase 4 RENDER workstream A (item 1): the x-ray view follows
        // the water-pipe tool so buried pipes are visible while painting.
        if (tool === 'waterPipe') {
          if (!this.xrayVisible) {
            this.xrayAutoEnabled = true;
            this.setXray(true);
          }
        } else {
          this.clearXrayAuto();
        }
      },
      onCancelPlacement: () => {
        this.placement = null;
        // Phase 4 RENDER workstream A (item 1): the pipe tool's
        // auto-enabled x-ray turns back off (never a manual toggle).
        this.clearXrayAuto();
      },
      onResearchUpgrade: (id) => this.enqueue(buildResearchUpgradeOrder(HUMAN_PLAYER_ID, id)),
      onAdvanceAge: (program) => this.issueAdvanceAge(program),
      // Phase 2 (utilities): the utility-network overlay toggle.
      onToggleUtilityOverlay: () => {
        this.utilityOverlayVisible = !this.utilityOverlayVisible;
        this.entities.setUtilityOverlayVisible(this.utilityOverlayVisible);
        this.hud.setUtilityOverlayActive(this.utilityOverlayVisible);
      },
      // Phase 3 (logistics): the logistics overlay toggle.
      onToggleLogisticsOverlay: () => {
        this.logisticsOverlayVisible = !this.logisticsOverlayVisible;
        this.entities.setLogisticsOverlayVisible(this.logisticsOverlayVisible);
        this.hud.setLogisticsOverlayActive(this.logisticsOverlayVisible);
      },
      // Grand-expansion Phase 5 (S5+S8): the airport overlay toggle —
      // airport-site rings + airline-route arcs.
      onToggleAirportOverlay: () => {
        this.airportOverlayVisible = !this.airportOverlayVisible;
        this.entities.setAirportOverlayVisible(this.airportOverlayVisible);
        this.hud.setAirportOverlayActive(this.airportOverlayVisible);
      },
      // Workstream W (desirability): the land-value overlay toggle.
      onToggleDesirabilityOverlay: () => {
        this.desirabilityOverlayVisible = !this.desirabilityOverlayVisible;
        this.entities.setDesirabilityOverlayVisible(this.desirabilityOverlayVisible);
        this.hud.setDesirabilityOverlayActive(this.desirabilityOverlayVisible);
      },
      // Phase 4 RENDER workstream A (item 1): the underground/x-ray view.
      onToggleXray: () => {
        this.xrayAutoEnabled = false; // the user took over explicitly
        this.setXray(!this.xrayVisible);
      },
      // Phase 4 RENDER workstream A (follow-up B): the terrain grid.
      onToggleGrid: () => {
        this.setGrid(!this.gridVisible);
      },
      // Phase 3 (logistics): resupply + field-service toggles. The sim's
      // registerLogisticsCommands is wired at boot (ui/session.ts), so
      // these validate for real; a rejection still throws
      // CommandRejectedError and the player gets a loud toast — never a
      // silent no-op.
      onResupplyUnit: (unitId, depotId) =>
        this.enqueue(buildResupplyOrder(unitId, depotId, HUMAN_PLAYER_ID)),
      onSetSupplyToggles: (unitId, services) =>
        this.enqueue(buildSupplyTogglesOrder(unitId, HUMAN_PLAYER_ID, services)),
      // Grand-expansion Phase 5 (hangar/carrier shelter, workstream B):
      // the embark / base / launch orders. The sim validates each at
      // enqueue AND apply time; a rejection throws CommandRejectedError
      // and the player gets a loud toast — never a silent no-op.
      onEmbarkAircraft: (unitId, carrierId) =>
        this.enqueue(buildEmbarkOrder(unitId, carrierId, HUMAN_PLAYER_ID)),
      onBaseAircraft: (unitId, buildingId) =>
        this.enqueue(buildBaseOrder(unitId, buildingId, HUMAN_PLAYER_ID)),
      onLaunchAircraft: (unitId) => this.enqueue(buildLaunchOrder(unitId, HUMAN_PLAYER_ID)),
      // Grand-expansion Phase 7 (intel): selecting a spy from the intel
      // panel, and the covert-op orders. The sim validates each at
      // enqueue AND apply time; a rejection throws CommandRejectedError
      // and the player gets a loud toast — never a silent no-op.
      onSelectUnit: (unitId) => {
        this.selection = selectUnits([unitId]);
      },
      onInfiltrateBuilding: (spyId, buildingId) =>
        this.enqueue(buildInfiltrateOrder(HUMAN_PLAYER_ID, spyId, buildingId)),
      onSabotageBuilding: (spyId, buildingId) =>
        this.enqueue(buildSabotageOrder(HUMAN_PLAYER_ID, spyId, buildingId)),
      onStealTech: (spyId, buildingId) =>
        this.enqueue(buildStealTechOrder(HUMAN_PLAYER_ID, spyId, buildingId)),
      // Phase 3: superweapons, specialization, trade, delegation.
      onFireAegis: () => this.issueOrder(buildFireAegisOrder(HUMAN_PLAYER_ID)),
      onStormTarget: () => {
        this.placement = { kind: 'storm' };
        this.hud.toast('Storm targeting: left-click the map. Right-click cancels.');
      },
      onSetSpecialization: (spec) =>
        this.issueOrder(buildSetSpecializationOrder(HUMAN_PLAYER_ID, spec)),
      // Grand-expansion Phase 8 (civilian ordinances, workstream E):
      // the Management tab's City ordinances toggles → setPolicy orders.
      onSetPolicy: (policy, on) =>
        this.issueOrder(buildSetPolicyOrder(HUMAN_PLAYER_ID, policy, on)),
      onEstablishTradeRoute: (partner) =>
        this.issueOrder(buildEstablishTradeRouteOrder(HUMAN_PLAYER_ID, partner)),
      onCancelTradeRoute: (partner) =>
        this.issueOrder(buildCancelTradeRouteOrder(HUMAN_PLAYER_ID, partner)),
      onAssignMayor: (policy) =>
        this.issueOrder(buildAssignMayorOrder(HUMAN_PLAYER_ID, policy)),
      onDismissMayor: () => this.issueOrder(buildDismissMayorOrder(HUMAN_PLAYER_ID)),
      onSetMayorBuildPolicy: (buildPolicy) =>
        this.issueOrder(buildSetMayorBuildPolicyOrder(HUMAN_PLAYER_ID, buildPolicy)),
      onAssignGeneral: (stance) => this.issueAssignGeneral(stance),
      onDismissGeneral: () => this.issueOrder(buildDismissGeneralOrder(HUMAN_PLAYER_ID)),
      onSetGeneralStance: (stance) =>
        this.issueOrder(buildSetGeneralStanceOrder(HUMAN_PLAYER_ID, stance)),
      // Workstream Y (3-tab menu): taxes live in the Management tab.
      onSetTaxRate: (zone, rate) =>
        this.issueOrder(buildSetTaxRateOrder(HUMAN_PLAYER_ID, zone, rate)),
      // Grand-expansion Phase 5 (S5): the airline two-click gesture.
      onAirlineNewRoute: () => this.armAirlineTool(),
      onCancelAirlineRoute: (id) =>
        this.enqueue(buildCancelAirlineRouteOrder(HUMAN_PLAYER_ID, id)),
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
    // Throttle the frame-error toast: a throw that repeats every frame
    // must not spam the HUD (the console still gets every occurrence).
    let lastFrameErrorToast = 0;
    this.renderer.setAnimationLoop(() => {
      if (this.disposed) return;
      const now = performance.now();
      const frameMs = Math.min(now - last, 250);
      last = now;
      // Loop error boundary (camera/input-freeze hardening): a single
      // frame's exception is logged loudly but never kills the loop.
      const placement = this.placement;
      guardGameFrame(
        () => runGameFrame(this.frameDeps(), now, frameMs),
        {
          tick: this.session.world.tick,
          armedTool:
            placement?.kind === 'build'
              ? placement.tool
              : (placement?.kind ?? null),
        },
        () => {
          if (now - lastFrameErrorToast > 5000) {
            lastFrameErrorToast = now;
            this.hud.toast('A frame glitched, but the game kept running.');
          }
        },
      );
    });
  }

  /**
   * The frame loop's dependency seam (see `runGameFrame`): bound
   * closures over this controller's collaborators.
   */
  private frameDeps(): GameFrameDeps {
    return {
      session: this.session,
      paused: this.paused,
      speed: this.speed,
      selection: this.selection,
      advisorItems: this.advisorItems,
      updateCamera: (dtSec) => this.updateCamera(dtSec),
      maybeAutosave: () => this.maybeAutosave(),
      maybeShowConquestOutcome: () => this.maybeShowConquestOutcome(),
      refreshAdvisor: (world) => this.refreshAdvisor(world),
      pruneSelection: () => this.pruneSelection(),
      syncEntities: (world) => this.entities.sync(world),
      syncTransitProviders: (world) => this.syncTransitProviders(world),
      setSelectedEntities: (unitIds) => this.entities.setSelected(unitIds),
      updateEntitySelectionRings: (world) =>
        this.entities.updateSelectionRings(EntityRenderer.unitMap(world)),
      updateHud: (world, selection, advisorItems, paused, speed, terrain) =>
        this.hud.update(world, selection, advisorItems, paused, speed, terrain),
      pollAudioEvents: (world, nowMs) => this.pollAudioEvents(world, nowMs),
      pollCampaign: (world, nowMs) => this.pollCampaign(world, nowMs),
      renderFrame: () => this.renderer.render(this.scene, this.camera),
      getLastAdvisorRefresh: () => this.lastAdvisorRefresh,
      setLastAdvisorRefresh: (nowMs) => {
        this.lastAdvisorRefresh = nowMs;
      },
    };
  }

  /**
   * Phase 4 (transport): keep the ambient transit providers in sync with
   * the player's transit networks. The route key moves only on player
   * actions (build/demolish/disconnect a stop) — then the providers are
   * rebuilt and the old geometry disposed; population flows through the
   * mutable `count` every frame instead, so geometry is never churned by
   * ordinary growth. Grand-expansion Phase 6 (workstream C) folds the
   * ambient cargo-ship provider into the same method — same contract,
   * different route (completed civilian ports) and key. Called from the
   * frame loop before `syncEntities` so the crowd renders this frame's
   * registrations.
   */
  private syncTransitProviders(world: World): void {
    const owner = HUMAN_PLAYER_ID;
    const key = transitRouteKey(world, owner);
    if (key !== this.lastTransitRouteKey) {
      this.lastTransitRouteKey = key;
      this.rebuildTransitProvider('bus', 'bus', createBusProvider, world, owner);
      this.rebuildTransitProvider('tram', 'tram', createTramProvider, world, owner);
      this.rebuildTransitProvider('ferry', 'boat', createFerryProvider, world, owner);
    }
    const pop = getPlayer(world.city, owner)?.population ?? 0;
    for (const [type, provider] of this.transitProviders) {
      provider.count = transitVehicleCount(type, provider.stops.length, pop);
    }
    // Grand-expansion Phase 6 (workstream C): ambient cargo ships ride
    // the player's completed civilian ports. Same contract as above —
    // rebuild on route change, `count` from population every frame.
    const cargoKey = cargoShipRouteKey(world, owner);
    if (cargoKey !== this.lastCargoRouteKey) {
      this.lastCargoRouteKey = cargoKey;
      if (this.cargoShipProvider !== null) {
        unregisterAmbientTransitProvider('cargoShip');
        this.cargoShipProvider.dispose();
        this.cargoShipProvider = null;
      }
      const stops = cargoShipRoutePoints(world, owner);
      // Fewer than two civilian ports is not a shipping lane — the
      // crowd renders nothing until the player builds a real network
      // (the Phase 4 transit precedent).
      if (stops.length >= 2) {
        const provider = createCargoShipProvider(stops, { population: pop });
        this.cargoShipProvider = provider;
        registerAmbientTransitProvider('cargoShip', provider);
      }
    }
    if (this.cargoShipProvider !== null) {
      this.cargoShipProvider.count = cargoShipVehicleCount(
        this.cargoShipProvider.stops.length,
        pop,
      );
    }
    // Grand-expansion Phase 5 (S5+S8): ambient airliners ride the
    // player's completed civil/mixed airports. Same contract as above —
    // rebuild on route change, `count` from population every frame. The
    // provider itself gates to null (nothing registered) when the player
    // has no completed civil airport.
    const airlineKey = airlinerRouteKey(world, owner);
    if (airlineKey !== this.lastAirlineRouteKey) {
      this.lastAirlineRouteKey = airlineKey;
      if (this.airlinerProvider !== null) {
        unregisterAmbientTransitProvider('airliner');
        this.airlinerProvider.dispose();
        this.airlinerProvider = null;
      }
      const provider = createAirlinerProvider(world, owner);
      if (provider !== null) {
        this.airlinerProvider = provider;
        registerAmbientTransitProvider('airliner', provider);
      }
    }
    if (this.airlinerProvider !== null) {
      this.airlinerProvider.count = airlinerCount(world, owner);
    }
  }

  private rebuildTransitProvider(
    type: TransitProviderType,
    mode: TransitMode,
    create: (
      stops: readonly TransitRouteStop[],
      opts?: TransitProviderOptions,
    ) => AmbientVehicleProvider,
    world: World,
    owner: number,
  ): void {
    const old = this.transitProviders.get(type);
    if (old !== undefined) {
      unregisterAmbientTransitProvider(type);
      old.dispose();
      this.transitProviders.delete(type);
    }
    const stops = transitRoutePoints(world, owner, mode);
    // Fewer than two operational stops is not a route — the crowd
    // renders nothing until the player builds a real network.
    if (stops.length < 2) return;
    const provider = create(stops, {
      population: getPlayer(world.city, owner)?.population ?? 0,
    });
    this.transitProviders.set(type, provider);
    registerAmbientTransitProvider(type, provider);
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
    // Phase 4 (transport): release the ambient transit providers (their
    // geometry/material are provider-owned — the crowd never disposes
    // them — so the game does it here, once per session).
    for (const [type, provider] of this.transitProviders) {
      unregisterAmbientTransitProvider(type);
      provider.dispose();
    }
    this.transitProviders.clear();
    // Grand-expansion Phase 6 (workstream C): the cargo-ship provider
    // has the same provider-owned lifecycle — release it here too.
    if (this.cargoShipProvider !== null) {
      unregisterAmbientTransitProvider('cargoShip');
      this.cargoShipProvider.dispose();
      this.cargoShipProvider = null;
    }
    // Grand-expansion Phase 5 (S5+S8): the airliner provider has the
    // same provider-owned lifecycle — release it here too.
    if (this.airlinerProvider !== null) {
      unregisterAmbientTransitProvider('airliner');
      this.airlinerProvider.dispose();
      this.airlinerProvider = null;
    }
    // Shared model assets (caller-owned): released once here, never
    // per view. The renderer only borrowed them.
    disposeModels(this.modelMap);
    if (this.natureView !== null) {
      this.scene.remove(this.natureView.group);
      // Releases ONLY instance attributes; shared prop geo/mat stay
      // with the models map (disposed above).
      this.natureView.dispose();
    }
    this.dragRect?.remove();
    // NOTE: scene.environment is the process-shared procedural texture
    // from applyEnvironmentLighting — never disposed per game.
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
   * Conquest outcome: when a skirmish has a rival and one side loses every
   * unit and building, show the end screen once. Sandbox games (no rival)
   * have no win/lose condition by design. Campaign missions use their own
   * director-driven outcome — this only fires for plain skirmishes.
   *
   * Defeat takes precedence on mutual elimination (see getSkirmishOutcome):
   * the player must survive their victory to claim it.
   *
   * Grand-expansion Phase 8 (peaceful mode, workstream B, 2026-09-30):
   * peaceful worlds take the builder's path instead — the peaceful
   * victory owns the outcome (`peacefulOutcome` in ui/peaceful.ts): the
   * player wins by reaching 8,000 housed residents with a non-negative
   * treasury, and the RIVAL can win first (an AI city that hits the
   * target first is the peaceful defeat). A same-tick tie goes to the
   * player. Both use the existing end-screen overlay with peaceful copy.
   */
  private maybeShowConquestOutcome(): void {
    if (this.disposed || this.victoryShown || this.defeatShown) return;
    if (!this.session.hasRival) return;
    if (this.session.world.peaceful === true) {
      const outcome = peacefulOutcome(
        this.session.world,
        HUMAN_PLAYER_ID,
        AI_PLAYER_ID,
      );
      if (outcome !== null) {
        const copy = peacefulEndCopy(
          this.session.world,
          outcome === 'victory' ? HUMAN_PLAYER_ID : AI_PLAYER_ID,
          outcome,
        );
        if (outcome === 'victory') {
          this.victoryShown = true;
          this.endScreen.showVictory(copy.title, copy.detail);
        } else {
          this.defeatShown = true;
          this.endScreen.showDefeat(copy.title, copy.detail);
        }
      }
      return;
    }
    const outcome = getSkirmishOutcome(this.session.world);
    if (outcome === 'victory') {
      this.victoryShown = true;
      this.endScreen.showVictory();
    } else if (outcome === 'defeat') {
      this.defeatShown = true;
      this.endScreen.showDefeat();
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
    this.enqueue(
      buildAdvanceAgeOrder(HUMAN_PLAYER_ID, program, this.session.world.ages.age),
    );
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
    // Grand-expansion Phase 5 (S5): the armed airline tool counts as a
    // placement mode for the sky-click hint (the click meant to pick an
    // airport — say so instead of swallowing it).
    const placing =
      this.placement?.kind === 'train' ||
      this.placement?.kind === 'build' ||
      this.hud.airlineArmed;
    if (!point) {
      // Clicking the sky selects nothing (silent), but in a placement mode
      // the click meant to place something — say so instead of swallowing it.
      if (placing) {
        this.placeResolution({
          kind: 'hint',
          message:
            this.placement?.kind === 'train'
              ? STRINGS.orders.trainFailed
              : STRINGS.orders.buildFailed,
        });
      }
      return;
    }

    // Placement modes consume the click first.
    if (this.placement?.kind === 'train') {
      this.placeResolution(resolveTrainClick(this.placement.unitKind, HUMAN_PLAYER_ID, point));
      return;
    }
    // Grand-expansion Phase 5 (S5): the airline two-click gesture is not
    // a palette placement mode — it consumes the click while armed.
    if (this.hud.airlineArmed) {
      this.handleAirlineClick(point.x, point.z);
      return;
    }
    if (this.placement?.kind === 'build') {
      this.handleBuildClick(point.x, point.z);
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
    if (this.placement?.kind !== 'build') return;
    const cell = this.worldToCell(x, z);
    // The resolver maps every case to an order or a hint — a click in
    // build mode never fails silently (off-grid, zone tool, …).
    this.placeResolution(resolveBuildToolClick(this.placement.tool, HUMAN_PLAYER_ID, cell));
  }

  /**
   * Grand-expansion Phase 5 (S5): arm the airline route tool. The gesture
   * is two clicks on the player's completed civil/mixed airports (see
   * resolveAirlineClick in ui/placement.ts). Arming cancels any palette
   * placement tool; the armed state lives on the HUD (public fields,
   * digest-covered aa:) so the panel's status line repaints.
   */
  private armAirlineTool(): void {
    this.placement = null;
    this.networkDrag = null;
    this.hud.airlineArmed = true;
    this.hud.airlineFromId = null;
    this.hud.toast(loc(STRINGS.menuTabs.airlinePickFirst));
    this.audio.playSfx('select');
  }

  /** Grand-expansion Phase 5 (S5): disarm the airline route tool. */
  private disarmAirlineTool(): void {
    this.hud.airlineArmed = false;
    this.hud.airlineFromId = null;
  }

  /**
   * Grand-expansion Phase 5 (S5): one click of the airline two-click
   * gesture. The resolver arms the first endpoint, emits the
   * establishAirlineRoute order on the second valid click, or toasts a
   * hint — the click never fails silently.
   */
  private handleAirlineClick(x: number, z: number): void {
    const picked = this.buildingAt(x, z);
    const target =
      picked === null
        ? null
        : (this.session.world.city.buildings.find((b) => b.id === picked.id) ?? null);
    const res: AirlineClickResolution = resolveAirlineClick(
      HUMAN_PLAYER_ID,
      this.hud.airlineFromId,
      target,
    );
    if (res.kind === 'arm') {
      this.hud.airlineFromId = res.id;
      this.hud.toast(loc(STRINGS.menuTabs.airlineRouteArmed));
      this.audio.playSfx('select');
    } else if (res.kind === 'order') {
      this.enqueue(res.intent);
      this.audio.playSfx('place');
      this.disarmAirlineTool();
    } else if (res.kind === 'disarm') {
      this.disarmAirlineTool();
      this.hud.toast('Airline route cancelled.');
    } else {
      this.hud.toast(res.message);
      this.audio.playSfx('error');
    }
  }

  /**
   * Cancel the armed placement tool AND abort any in-flight placement
   * gesture (network drag-paint, drag rectangle) so a cancelled tool can
   * never emit an order when the pointer is released. Camera gestures
   * (pan / orbit) are untouched — cancelling a tool is not cancelling
   * the camera.
   */
  private cancelPlacement(): void {
    this.placement = null;
    this.networkDrag = null;
    // Grand-expansion Phase 5 (S5): cancelling a tool also disarms the
    // airline gesture — a stale armed endpoint can never emit an order.
    this.disarmAirlineTool();
    // Phase 4 RENDER workstream A (item 1): the pipe tool's
    // auto-enabled x-ray turns back off (never a manual toggle).
    this.clearXrayAuto();
    if (this.dragRect) {
      this.dragRect.remove();
      this.dragRect = null;
    }
    this.hud.toast('Cancelled.');
  }

  /**
   * Phase 4 RENDER workstream A (item 1): single x-ray state writer
   * (renderer + HUD toggle stay in sync).
   */
  private setXray(visible: boolean): void {
    this.xrayVisible = visible;
    this.entities.setXrayVisible(visible);
    this.hud.setXrayActive(visible);
  }

  /**
   * Phase 4 RENDER workstream A (item 1): turn x-ray off only when the
   * water-pipe tool auto-enabled it — a manual user toggle is never
   * fought.
   */
  private clearXrayAuto(): void {
    if (this.xrayAutoEnabled) {
      this.xrayAutoEnabled = false;
      this.setXray(false);
    }
  }

  /**
   * Phase 4 RENDER workstream A (follow-up B): single grid state writer
   * (renderer + HUD toggle stay in sync).
   */
  private setGrid(visible: boolean): void {
    this.gridVisible = visible;
    this.entities.setGridVisible(visible);
    this.hud.setGridActive(visible);
  }

  /**
   * Carry out a placement resolution: enqueue the order, or toast the
   * hint with an error cue. Nothing fails silently.
   */
  private placeResolution(resolution: PlacementResolution): void {
    if (resolution.kind === 'order') {
      this.enqueue(resolution.intent);
      this.audio.playSfx('place');
    } else {
      this.hud.toast(resolution.message);
      this.audio.playSfx('error');
    }
  }

  private handleZoneDrag(x0: number, z0: number, x1: number, z1: number): void {
    if (this.placement?.kind !== 'build') return;
    const tool = this.placement.tool;
    // Grand-expansion Phase 5 (S5): zoneA paints the airport zone (3).
    const zone = tool === 'zoneR' ? 0 : tool === 'zoneC' ? 1 : tool === 'zoneI' ? 2 : tool === 'zoneA' ? 3 : null;
    if (zone === null) return;
    const a = this.worldToCell(x0, z0);
    const b = this.worldToCell(x1, z1);
    if (!a || !b) return;
    this.enqueue(buildZoneOrder(
      HUMAN_PLAYER_ID,
      zone as 0 | 1 | 2 | 3,
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
      if (this.inputDebug) {
        console.debug('[input] pointerdown', {
          button: e.button,
          x: e.clientX,
          y: e.clientY,
          placement: this.placement?.kind ?? null,
        });
      }
      if (e.button === 0) {
        this.dragStart = { x: e.clientX, y: e.clientY };
        // Gesture ownership is snapshotted at press time and never changes
        // mid-gesture (ui/camera.ts pressDragKind): with no placement tool
        // armed the drag grab-pans the map; with a tool armed the drag
        // belongs to the tool (network drag-paint / zone rect /
        // place-at-release). Arming or cancelling a tool while the button
        // is held cannot flip the gesture.
        this.leftDragKind = pressDragKind(e.button, this.placement !== null);
        this.panLast = { x: e.clientX, y: e.clientY };
        // Linear-network tools (road today): a press starts a drag-paint
        // gesture that accumulates cells until pointerup; a plain click
        // releases with zero cells and falls through to the click resolver.
        const netKind =
          this.placement?.kind === 'build'
            ? networkKindForTool(this.placement.tool)
            : null;
        this.networkDrag =
          netKind === null
            ? null
            : new LinearNetworkDrag({
                kind: netKind,
                owner: HUMAN_PLAYER_ID,
                gridWidth: CITY_GRID_CELLS,
                // Phase 4 (transport): the road tool paints the HUD's
                // selected class (the drag stamps it at press time).
                roadClass: this.hud.selectedRoadClass,
              });
      } else if (e.button === 1) {
        // Middle-drag orbits the camera (yaw + pitch); preventDefault here
        // and on mousedown stops the browser's middle-click autoscroll.
        e.preventDefault();
        this.orbitLast = { x: e.clientX, y: e.clientY };
      } else if (e.button === 2) {
        // Right-click cancels placement, else issues a context order.
        // Cancelling also aborts an in-flight placement gesture so a
        // cancelled tool can never emit an order on pointerup.
        if (this.placement) {
          this.cancelPlacement();
        } else {
          const ndc = this.toNDC(e);
          const p = this.groundPoint(ndc.x, ndc.y);
          if (p) this.issueContextOrder(p.x, p.z);
        }
      }
    });
    // Suppress middle-click autoscroll on the canvas (the pointerdown
    // preventDefault above covers most browsers; this covers the rest).
    on(this.canvas, 'mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    on(this.canvas, 'pointermove', (e) => {
      // Middle-drag orbit: horizontal travel yaws, vertical travel pitches.
      if (this.orbitLast && e.buttons & 4) {
        const dx = e.clientX - this.orbitLast.x;
        const dy = e.clientY - this.orbitLast.y;
        this.orbitLast = { x: e.clientX, y: e.clientY };
        if (dx !== 0 || dy !== 0) {
          this.cameraState = orbitDrag(this.cameraState, dx, dy);
          this.applyCameraStateGuarded();
        }
      }
      if (this.dragStart && e.buttons & 1) {
        if (this.leftDragKind === 'pan') {
          // No tool armed: grab-pan the map. Screen travel becomes
          // world-space target travel (yaw-aware), scaled so the map
          // follows the pointer 1:1 at the target plane.
          const last = this.panLast ?? this.dragStart;
          const dx = e.clientX - last.x;
          const dy = e.clientY - last.y;
          this.panLast = { x: e.clientX, y: e.clientY };
          if (dx !== 0 || dy !== 0) {
            const wpp = worldPerPixelAtTarget(
              this.cameraState.distance,
              (GAME_FOV_DEG * Math.PI) / 180,
              this.canvas.clientHeight || window.innerHeight,
            );
            this.cameraState = panDragTarget(this.cameraState, dx, dy, wpp);
            this.applyCameraStateGuarded();
          }
        } else if (this.leftDragKind === 'place') {
          const dx = e.clientX - this.dragStart.x;
          const dy = e.clientY - this.dragStart.y;
          // No selection rectangle while linear-network drag-painting: the
          // gesture belongs to the network tool, not to box-select.
          if (Math.hypot(dx, dy) > 6 && !this.dragRect && !this.networkDrag) {
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
      }
      // Linear-network drag: accumulate cells while painting with the tool
      // (gap-filled so fast drags don't leave holes).
      if (this.networkDrag?.isActive && e.buttons & 1) {
        const ndc = this.toNDC(e);
        const p = this.groundPoint(ndc.x, ndc.y);
        const cell = p ? this.worldToCell(p.x, p.z) : null;
        if (cell) this.networkDrag.addCell(cell);
      }
    });
    // Edge pan needs the pointer even over HUD panels: the canvas never
    // sees pointermove while the pointer is above the top bar / selection
    // panel (they are pointer-events:auto siblings), which used to starve
    // the top/bottom edge zones. Tracked on window instead.
    on(window, 'pointermove', (e) => {
      this.mouseClient = { x: e.clientX, y: e.clientY };
    });
    // A parked pointer outside the window must not keep edge-panning:
    // leaving the document clears the tracked position (mouseout with no
    // relatedTarget fires on document when the pointer exits the window).
    const docMouseOut = (e: MouseEvent): void => {
      if (!e.relatedTarget) this.mouseClient = null;
    };
    document.addEventListener('mouseout', docMouseOut);
    this.removeListeners.push(() => document.removeEventListener('mouseout', docMouseOut));
    // A cancelled gesture (touch interruption, pointer capture loss) must
    // release exactly like a pointerup with no button pressed: without
    // this, dragStart/leftDragKind/orbitLast could linger until the next
    // press. (Next press re-snapshots everything, so this is defense in
    // depth rather than a freeze fix.)
    on(window, 'pointercancel', () => {
      this.dragStart = null;
      this.leftDragKind = null;
      this.panLast = null;
      this.orbitLast = null;
      this.networkDrag = null;
      if (this.dragRect) {
        this.dragRect.remove();
        this.dragRect = null;
      }
    });
    on(window, 'pointerup', (e) => {
      // Middle-drag ends here: it never selects or places.
      if (e.button === 1) {
        this.orbitLast = null;
        return;
      }
      const start = this.dragStart;
      this.dragStart = null;
      // The gesture's meaning was snapshotted at pointerdown; consume it.
      const kind = this.leftDragKind;
      this.leftDragKind = null;
      this.panLast = null;
      // Click-vs-drag is anchored on the press (pointer/pointer.ts): a press
      // that started on the canvas counts as a click even when the release
      // target isn't the canvas (synthetic events, sub-pixel HUD-edge drift).
      const gesture = classifyPointerUp({
        dragStart: start,
        upX: e.clientX,
        upY: e.clientY,
        button: e.button,
        targetIsCanvas: e.target === this.canvas,
      });
      if (this.inputDebug) {
        console.debug('[input] pointerup', {
          gesture,
          button: e.button,
          x: e.clientX,
          y: e.clientY,
          targetIsCanvas: e.target === this.canvas,
          leftDragKind: kind,
          hadNetworkDrag: this.networkDrag !== null,
          hadDragRect: this.dragRect !== null,
        });
      }
      if (kind === 'pan') {
        // Grab-pan gesture: the drag already moved the map; a clean click
        // still selects (resolved against the current placement, if any).
        // It never places, never box-selects.
        if (gesture === 'click') {
          const ndc = this.toNDC(e);
          this.handleLeftClick(ndc.x, ndc.y, e.shiftKey);
        }
        return;
      }
      // Linear-network drag-paint finishes here, before the box-select path:
      // a network gesture must never silently become a unit selection.
      if (this.networkDrag) {
        const outcome = this.networkDrag.finish(gesture);
        this.networkDrag = null;
        this.dragRect?.remove();
        this.dragRect = null;
        if (outcome.action === 'order') {
          // Phase 4 (transport): a road drag may cover both fresh cells
          // (buildRoad) and existing lower-class road cells (upgradeRoad —
          // in-place, difference pricing). The sim rejects a mixed batch
          // whole, so partition first; skipped cells (already at or
          // above the selected class) are silently dropped.
          const intent = outcome.intent;
          if (intent.kind === 'buildRoad' && intent.payload !== undefined) {
            const cells = intent.payload['cells'] as number[];
            const cls = intent.payload['cls'] as RoadClass;
            const owner = intent.payload['owner'] as number;
            const { build, upgrade } = partitionRoadCells(
              this.session.world.city.roads,
              cells,
              cls,
            );
            if (build.length > 0) {
              this.enqueue({ kind: 'buildRoad', payload: { owner, cells: build, cls } });
            }
            if (upgrade.length > 0) {
              this.enqueue(buildUpgradeRoadOrder(owner, upgrade, cls));
            }
            if (build.length + upgrade.length > 0) this.audio.playSfx('place');
          } else {
            this.enqueue(intent);
            this.audio.playSfx('place');
          }
        } else if (outcome.action === 'click') {
          // Plain click with the network tool: resolve the single clicked
          // cell (or explain why nothing was placed).
          const ndc = this.toNDC(e);
          const p = this.groundPoint(ndc.x, ndc.y);
          const cell = p ? this.worldToCell(p.x, p.z) : null;
          this.placeResolution(
            resolveNetworkToolClick(outcome.kind, outcome.owner, cell, outcome.roadClass),
          );
        }
        return;
      }
      if (this.dragRect) {
        // Box select (or zone drag) from the screen rect.
        const rect = this.dragRect.getBoundingClientRect();
        this.dragRect.remove();
        this.dragRect = null;
        if (start) this.handleDragRect(rect, e.shiftKey);
        return;
      }
      if (gesture === 'click') {
        const ndc = this.toNDC(e);
        this.handleLeftClick(ndc.x, ndc.y, e.shiftKey);
      }
    });
    on(this.canvas, 'contextmenu', (e) => e.preventDefault());
    on(this.canvas, 'wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this.cameraState = zoomCamera(this.cameraState, factor);
      this.applyCameraStateGuarded();
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
        else if (this.placement) this.cancelPlacement();
        else this.selection = clearSelection();
        return;
      }
      if (k === 's' && !e.repeat) {
        this.issueStop();
        return;
      }
      // Phase 4 RENDER workstream A (follow-up B): G toggles the
      // terrain grid (the top-bar "Grid" button does the same).
      if (k === 'g' && !e.repeat) {
        this.setGrid(!this.gridVisible);
        return;
      }
      this.keys.add(k);
    });
    on(window, 'keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    on(window, 'blur', () => {
      this.keys.clear();
      // A parked pointer position must not keep edge-panning while the
      // window is not focused.
      this.mouseClient = null;
    });

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
      (this.placement.tool === 'zoneR' || this.placement.tool === 'zoneC' || this.placement.tool === 'zoneI' ||
        // Grand-expansion Phase 5 (S5): the airport zone tool.
        this.placement.tool === 'zoneA')
    ) {
      this.handleZoneDrag(pa.x, pa.z, pb.x, pb.z);
      return;
    }
    // Train/building placement: a drag places at the release point instead
    // of silently becoming a box-select — the armed tool owns the gesture.
    // (Road drags are consumed earlier by the road-drag-paint path.)
    if (this.placement?.kind === 'train') {
      this.placeResolution(resolveTrainClick(this.placement.unitKind, HUMAN_PLAYER_ID, pb));
      return;
    }
    if (this.placement?.kind === 'build') {
      this.handleBuildClick(pb.x, pb.z);
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
  /**
   * Phase 4 hardening (item 7): the ONLY way the controller applies the
   * camera state. Every component is checked for NaN/Infinity before the
   * three.js camera moves: a poisoned state logs loudly (tick + armed
   * tool + bad components — the same repro context as guardGameFrame)
   * and the last known good is applied instead. A healthy state becomes
   * the new last-known-good. Call sites must never call
   * `applyCameraState` directly.
   */
  private applyCameraStateGuarded(): void {
    const { state, restored, bad } = guardCameraState(
      this.cameraState,
      this.lastGoodCameraState,
    );
    if (restored) {
      console.error(
        `[novaterra] camera state poisoned at tick ${this.session.world.tick} ` +
          `(armedTool=${this.armedToolName() ?? 'none'}): non-finite ` +
          `components [${bad.join(', ')}] — restored last known good`,
      );
      this.cameraState = state;
    } else {
      this.lastGoodCameraState = state;
    }
    applyCameraState(this.camera, this.cameraState);
  }

  /** What the player has armed (tool id, 'train', or null) — repro context. */
  private armedToolName(): string | null {
    const placement = this.placement;
    return placement?.kind === 'build' ? placement.tool : (placement?.kind ?? null);
  }

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
    // Edge pan: pointer near a screen edge pans that way. The vector is
    // the pure edgePanVector (ui/camera.ts) — same yaw-aware axes as the
    // key pan. mouseClient is tracked on window (not just the canvas) so
    // HUD panels overlapping an edge cannot starve the edge zone.
    if (this.mouseClient) {
      const v = edgePanVector({
        pointerX: this.mouseClient.x,
        pointerY: this.mouseClient.y,
        viewWidth: window.innerWidth,
        viewHeight: window.innerHeight,
        yaw,
      });
      fx += v.x;
      fz += v.z;
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
    this.applyCameraStateGuarded();
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
