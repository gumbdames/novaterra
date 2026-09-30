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
 * NOVATERRA — render/entities.ts — unit / building / road meshes.
 *
 * Responsibilities:
 *  - A read-only view of the sim's units, buildings, and roads: `sync()`
 *    diffs the world against live three.js objects, creating meshes for
 *    new ids, moving the rest, and disposing removed ones. Never touches
 *    sim state.
 *  - 0.1 Alpha art: real CC0 models (GLB via `render/models.ts`) for most
 *    entities, detailed procedural models (`render/proceduralModels.ts`)
 *    for the 8 gap kinds, and the old smooth placeholder silhouettes as
 *    the final fallback — resolution order per entity is GLB →
 *    procedural → placeholder, so the game is never blank.
 *  - Sharing: geometry AND materials are shared across all views of the
 *    same kind (GLB assets arrive merged per material from the loader;
 *    procedural models are built once per kind and cached). Per-view
 *    objects own only their health-bar sprites, team pennant material,
 *    and (while constructing) cloned fade materials. Shared assets are
 *    never disposed per view.
 *  - Selection rings for the player's current selection.
 *  - Veterancy chevrons (Phase 1): a `ChevronOverlay` (`render/chevrons.ts`)
 *    with three instanced meshes (one per vetLevel 1..3) reading
 *    `world.units` directly — at most 3 draw calls, independent of the
 *    unit-body render path.
 *  - Zone-tint ground decals (Workstream Z): a `ZoneOverlay`
 *    (`render/zoneOverlay.ts`) reading `world.city.zones` directly —
 *    one merged translucent mesh (1 draw call), rebuilt only when the
 *    zone digest changes.
 *  - Ambient city life (Workstream P): a `PavingOverlay`
 *    (`render/cityLife.ts`) that auto-paves painted zones with a
 *    concrete decal (1 draw call), plus an `AmbientCrowd` of instanced
 *    pedestrians and cars whose density scales with city population —
 *    poses are pure functions of (seed, index, tick), never sim state.
 *  - Superweapon FX: the Aegis energy dome and Storm Engine strikes,
 *    driven by the sim's deterministic `world.superweapons.fx` records
 *    (animation phase derives from `world.tick`, never wall clock).
 *
 * Budgets: one Group per unit (model + team stripe + pennant + health
 * bars); buildings one group each; roads two meshes (ribbon + dashes).
 * No per-frame allocations on the hot path (`sync` only touches views
 * whose membership or construction state changed).
 *
 * Render-side only: three.js here, never in sim/. See render/AGENTS.md.
 */

import * as THREE from 'three';
import type { World } from '../sim/world';
import type { UnitRecord } from '../sim/units';
import { UNIT_DEFS, isSheltered, type UnitKind } from '../sim/units';
import {
  BUILDING_DEFS,
  cellCenterWorld,
  CELL_WORLD_SIZE,
  cellCoords,
  CITY_GRID_CELLS,
  footprintCells,
  type BuildingKind,
  type BuildingRecord,
  type ZoneType,
  UTILITY_ZONE,
} from '../sim/city';
import { STORM_FX_TICKS, type WeaponFx } from '../sim/superweapons';
import type { LoadedModel } from './models';
import { EntityInstancer, type InstancedPiece } from './entityInstancing';
import {
  buildHqAntenna,
  buildInfantryGear,
  buildProceduralModel,
  buildRadarDishProp,
  buildAwacsDome,
  buildShipMast,
  buildRunwayStrip,
  // Grand-expansion Phase 5 (S5+S8): the airport-anchor tower prop.
  buildControlTower,
  buildCoolingTower,
  buildHospitalCross,
  // Grand-expansion Phase 5 — air/naval expansion (workstream E, pass 2):
  // the kitbash attach props.
  buildSeaplaneFloats,
  buildMineRails,
  buildNavalMineSpikes,
  // Grand-expansion Phase 6 — intel roster (workstream 5, art): the
  // SIGINT mast prop for signalsStation.
  buildSignalMast,
} from './proceduralModels';
import {
  buildRoadGeometry,
  buildRoadMarkings,
  ROAD_ASPHALT_COLOR,
  ROAD_DASH_COLOR,
} from './roads';
import { surfaceRoughnessTexture } from './surfaceTextures';
import { ChevronOverlay } from './chevrons';
import { ZoneOverlay } from './zoneOverlay';
import { AmbientCrowd, PavingOverlay } from './cityLife';
import { XrayView } from './xrayView';
import { BirdFlocks } from './birds';
import { ambientSecondsForTick, setAmbientTimeSeconds } from './ambientTime';
import { waterBobY } from './terrain';
import {
  BUILDING_VARIANT_BASE,
  sizeTierScale,
  variantExtraFor,
  variantExtraPoolKey,
  variantExtraTop,
} from './buildingVariants';
import { GridView } from './gridView';
// Phase 2 (utilities): the always-on network runs + the toggleable
// diagnostic overlay. ui/utilities.ts is a pure contract module (no DOM,
// no three.js) — safe to import from the render layer.
import { NetworkOverlay } from './networks';
import { UtilityOverlay } from './utilityOverlay';
import { UtilityIndicators } from './utilityIndicators';
import { DesirabilityOverlay } from './desirabilityOverlay';
import { desirabilityOverlayData } from '../ui/desirability';
// Phase 3 (logistics): the toggleable reload-coverage / low-supply
// overlay. ui/logistics.ts is a pure contract module (no DOM, no
// three.js) — safe to import from the render layer.
import { LogisticsOverlay } from './logisticsOverlay';
import { logisticsOverlayData } from '../ui/logistics';
// Grand-expansion Phase 5 (S5+S8): the airport overlay.
import { AirportOverlay } from './airportOverlay';
import { airportOverlayData } from '../ui/airports';
import { HUMAN_PLAYER_ID } from '../ui/session';
import {
  cityPowerLines,
  cityPipes,
  utilityOverlayData,
} from '../ui/utilities';
import {
  groundYAt,
  unitHoverY,
  BUILDING_GROUND_EPSILON,
  SELECTION_RING_OFFSET,
  type HeightDomain,
} from './terrainHeight';
import { heightAt, type TerrainData } from '../sim/terrain';

/** Radius of the Aegis energy dome (world units). */
export const AEGIS_DOME_RADIUS = 55;

/** A live superweapon effect view. Keyed by fx identity. */
interface SuperweaponFxView {
  group: THREE.Group;
  /** For storm strikes: the tick the fx record expires (drives phase). */
  untilTick: number;
  kind: 'storm' | 'aegis';
}

// ---------------------------------------------------------------------------
// Model resolution: GLB → procedural → placeholder (never blank)
// ---------------------------------------------------------------------------

/** One piece of a (possibly composite) GLB model view. */
export interface ModelPiece {
  /** Key into the loaded-models map (`MODEL_PATHS` key). */
  key: string;
  /** Offset of the piece within the entity's footprint, world units. */
  dx: number;
  dy: number;
  dz: number;
}

const piece = (key: string, dx = 0, dy = 0, dz = 0): ModelPiece => ({ key, dx, dy, dz });

/** Where an entity kind's visuals come from. */
export type ModelSource =
  | { type: 'glb'; pieces: readonly ModelPiece[] }
  | { type: 'procedural' }
  | { type: 'placeholder' };

/**
 * Entity kind → model source. Composite buildings assemble several GLB
 * pieces (offsets relative to the footprint center); every 1:1 kind has
 * a single piece keyed by its own name.
 */const MODEL_SOURCES: Record<string, ModelSource> = {
  // ---- units ----
  engineer: { type: 'glb', pieces: [piece('engineer')] },
  rifles: { type: 'glb', pieces: [piece('rifles')] },
  tank: { type: 'glb', pieces: [piece('tank')] },
  hauler: { type: 'glb', pieces: [piece('hauler')] },
  // Grand-expansion Phase 3 (logistics): the supply trucks.
  supplyTruck: { type: 'procedural' },
  fuelTruck: { type: 'procedural' },
  spectre: { type: 'glb', pieces: [piece('spectre')] },
  hq: { type: 'glb', pieces: [piece('hq')] },
  patrolBoat: { type: 'glb', pieces: [piece('patrolBoat')] },
  transportShip: { type: 'glb', pieces: [piece('transportShip')] },
  artillery: { type: 'procedural' },
  aa: { type: 'procedural' },
  fighter: { type: 'procedural' },
  transport: { type: 'procedural' },
  drone: { type: 'procedural' },
  destroyer: { type: 'procedural' },
  // ---- buildings ----
  house: { type: 'glb', pieces: [piece('house')] },
  apartment: { type: 'glb', pieces: [piece('apartment')] },
  shop: { type: 'glb', pieces: [piece('shop')] },
  lab: { type: 'glb', pieces: [piece('lab')] },
  factory: { type: 'glb', pieces: [piece('factory')] },
  farm: {
    type: 'glb',
    pieces: [piece('farmBarn', -0.75, 0, -0.3), piece('farmSilo', 1.95, 0, 1.1)],
  },
  powerPlant: {
    type: 'glb',
    pieces: [piece('powerPlantMain', -0.8, 0, -0.5), piece('powerPlantChimney', 1.6, 0, 1.4)],
  },
  waterPump: { type: 'glb', pieces: [piece('waterPump')] },
  shipyard: {
    type: 'glb',
    pieces: [piece('shipyardCrane', -2.2, 0, 0), piece('shipyardMachine', 2.3, 0, 0.8)],
  },
  mediaCenter: { type: 'procedural' },
  // aegisControl: GLB main block + procedural radar dish prop (attached
  // in attachModelExtras).
  aegisControl: { type: 'glb', pieces: [piece('aegisMain', 0, 0, -1.0)] },
  stormArray: { type: 'procedural' },
  // ---- NOVATERRA roster-expansion units ----
  sniperTeam: { type: 'glb', pieces: [piece('sniperTeam')] },
  combatMedic: { type: 'glb', pieces: [piece('combatMedic')] },
  apc: { type: 'procedural' },
  tankDestroyer: { type: 'glb', pieces: [piece('tankDestroyer')] },
  mlrs: { type: 'procedural' },
  fighterBomber: { type: 'procedural' },
  attackHeli: { type: 'procedural' },
  awacs: { type: 'glb', pieces: [piece('awacs')] },
  missileBoat: { type: 'glb', pieces: [piece('missileBoat')] },
  frigate: { type: 'procedural' },
  submarine: { type: 'procedural' },
  carrier: { type: 'procedural' },
  commandShip: { type: 'glb', pieces: [piece('commandShip')] },
  fishingBoat: { type: 'glb', pieces: [piece('fishingBoat')] },
  // Grand-expansion Phase 4 (transport, S7 — sim workstream): source
  // entries so modelSourceFor never returns placeholder for the new
  // kinds. The procedural BUILDERS are the render workstream's Phase 4
  // follow-up (buildProceduralModel returns undefined until then and
  // the resolution chain falls back to placeholders — never blank).
  passengerTrain: { type: 'procedural' },
  freightTrain: { type: 'procedural' },
  bus: { type: 'procedural' },
  tram: { type: 'procedural' },
  ferry: { type: 'procedural' },
  // Grand-expansion Phase 5 — air/naval expansion (workstream E, pass 2,
  // 2026-09-30): the styloo "Tiny Plane Asset Pack" (CC0) GLBs — one
  // MODEL_PATHS key per kind (per-kind fit-to-hull scale), all lazy.
  // gunship and navalFighter stay procedural hero builders (below).
  strategicBomber: { type: 'glb', pieces: [piece('stylooBomber')] },
  maritimePatrol: { type: 'glb', pieces: [piece('stylooPatrol')] },
  reconUAV: { type: 'glb', pieces: [piece('stylooReconUAV')] },
  armedUAV: { type: 'glb', pieces: [piece('stylooArmedUAV')] },
  reconPlane: { type: 'glb', pieces: [piece('stylooRecon')] },
  tanker: { type: 'glb', pieces: [piece('stylooTanker')] },
  militaryCargo: { type: 'glb', pieces: [piece('stylooMilCargo')] },
  trainer: { type: 'glb', pieces: [piece('stylooTrainer')] },
  airliner: { type: 'glb', pieces: [piece('stylooAirliner')] },
  // Grand-expansion Phase 5 — airports (workstream A, S5+S8,
  // 2026-09-30): source entries for the 14 airport kinds. Anchors reuse
  // the airfield's GLB hangar pieces (one key each, loaded once) with
  // runway-strip + control-tower props attached via extraPropSpecs;
  // the per-class hangars reuse the same two hangar pieces at different
  // sizes; the fuel farm reuses the refinery tank pieces; terminals,
  // tower and runway modules are procedural (buildProceduralModel).
  civilAirport: {
    type: 'glb',
    pieces: [piece('airfieldHangar', -2.6, 0, -2.2), piece('airfieldHangar2', 2.6, 0, -2.4)],
  },
  militaryAirbase: {
    type: 'glb',
    pieces: [piece('airfieldHangar', -2.4, 0, -1.6), piece('airfieldHangar', 2.4, 0, -1.8)],
  },
  mixedAirport: {
    type: 'glb',
    pieces: [piece('airfieldHangar', -2.6, 0, -2.2), piece('airfieldHangar2', 2.6, 0, -2.4)],
  },
  passengerTerminal: { type: 'procedural' },
  cargoTerminal: { type: 'procedural' },
  controlTower: { type: 'procedural' },
  hangarS: { type: 'glb', pieces: [piece('airfieldHangar2')] },
  hangarM: { type: 'glb', pieces: [piece('airfieldHangar')] },
  hangarL: {
    type: 'glb',
    pieces: [piece('airfieldHangar'), piece('airfieldHangar2', 3.4, 0, 0.6)],
  },
  fuelFarm: {
    type: 'glb',
    pieces: [piece('oilRefineryTank', -1.6, 0, -0.8), piece('industrialTank', 1.6, 0, 0.8)],
  },
  maintenanceHangar: {
    type: 'glb',
    pieces: [piece('airfieldHangar2', -1.8, 0, 0), piece('airfieldHangar2', 1.8, 0, 0.4)],
  },
  runwayS: { type: 'procedural' },
  runwayM: { type: 'procedural' },
  runwayL: { type: 'procedural' },
  jumboAirliner: { type: 'glb', pieces: [piece('stylooJumbo')] },
  regionalJet: { type: 'glb', pieces: [piece('stylooRegional')] },
  cargoPlane: { type: 'glb', pieces: [piece('stylooCargo')] },
  // Grand-expansion Phase 5 — air/naval expansion (workstream E, pass 2):
  // the 3 procedural hero aircraft (buildProceduralModel).
  gunship: { type: 'procedural' },
  navalFighter: { type: 'procedural' },
  passengerHeli: { type: 'procedural' },
  // The seaplane is the styloo GLB + the procedural twin-floats prop
  // (attached via extraPropSpecs below).
  seaplane: { type: 'glb', pieces: [piece('stylooSeaplane')] },
  // Grand-expansion Phase 6 — naval expansion (workstream C + E pass 2):
  // the 6 procedural hero warships (buildProceduralModel) and the 9
  // logistics ships as CC0 kitbash composites (all pieces lazy).
  coastalSub: { type: 'procedural' },
  missileSub: { type: 'procedural' },
  corvette: { type: 'procedural' },
  cruiser: { type: 'procedural' },
  battleship: { type: 'procedural' },
  heavyDestroyer: { type: 'procedural' },
  cargoFreighter: { type: 'glb', pieces: [piece('cargoFreighterShip')] },
  // Deck tanks ride the tanker's open deck fore + aft of the
  // amidships superstructure.
  fuelTanker: {
    type: 'glb',
    pieces: [
      piece('fuelTankerHull'),
      piece('industrialTank', 0, 0.7, -2.0),
      piece('industrialTank', 0, 0.7, 2.2),
    ],
  },
  // Deck crates fore + aft of the amidships superstructure.
  ammoShip: {
    type: 'glb',
    pieces: [
      piece('ammoShipHull'),
      piece('deckCrate', -0.55, 0.7, -1.5),
      piece('deckCrate', 0.55, 0.7, -1.5),
      piece('deckCrate', -0.55, 0.7, 1.5),
      piece('deckCrate', 0.55, 0.7, 1.5),
    ],
  },
  // Deck crane on the aft working deck (bow at +z).
  repairShip: {
    type: 'glb',
    pieces: [piece('repairShipHull'), piece('repairCrane', 0, 1.2, -1.5)],
  },
  // Mine rails ride as a procedural prop (extraPropSpecs below).
  minelayer: { type: 'glb', pieces: [piece('minelayerHull')] },
  // Contact spikes ride as a procedural prop (extraPropSpecs below).
  navalMine: { type: 'glb', pieces: [piece('mineBuoy')] },
  coastGuardCutter: { type: 'glb', pieces: [piece('coastGuardCutterBoat')] },
  cruiseLiner: { type: 'glb', pieces: [piece('cruiseLinerShip')] },
  yacht: { type: 'glb', pieces: [piece('yachtBoat')] },
  // Grand-expansion Phase 6 — ports (workstream E, pass 2): composite
  // kitbashes from existing CC0 pieces (all lazy).
  // commercialPort 8×6 world: harbor crane + 2 container stacks.
  commercialPort: {
    type: 'glb',
    pieces: [
      piece('shipyardCrane', 0, 0, -1),
      piece('cargoContainerA', -2.7, 0, 0.9),
      piece('cargoContainerA', 2.7, 0, 0.9),
    ],
  },
  // containerPort 10×8 world: crane + 5 containers (one stacked pair).
  containerPort: {
    type: 'glb',
    pieces: [
      piece('shipyardCrane', 0, 0, -2),
      piece('cargoContainerB', 2.8, 0, -1.5),
      piece('cargoContainerB', 2.8, 0, 1.5),
      piece('cargoContainerB', 2.8, 1.65, -1.5),
      piece('cargoContainerC', -2.8, 0, -1.5),
      piece('cargoContainerC', -2.8, 0, 1.5),
    ],
  },
  // fishingHarbor 6×4 world: rowboat + 2 canoes.
  fishingHarbor: {
    type: 'glb',
    pieces: [
      piece('deckRowboat', 0, 0, 0.5),
      piece('harborCanoe', -1.7, 0, -0.9),
      piece('harborCanoe', 1.7, 0, -0.9),
    ],
  },
  // navalBase 10×8 world: gantry crane + hall + containers.
  navalBase: {
    type: 'glb',
    pieces: [
      piece('navalYardCrane', -3, 0, -1),
      piece('navalYardHall', 2.2, 0, 0.8),
      piece('cargoContainerB', -0.5, 0, 2.6),
      piece('cargoContainerC', 3.2, 0, -2.2),
    ],
  },
  // Grand-expansion Phase 6 — intel roster (workstream 5, art): the
  // §3.8 keys, mapped ahead of the sim defs so modelSourceFor resolves
  // the moment they arrive. All lazy (never boot — see bootModelKeys).
  // spy: a lone civilian figure (quaternius-civilians). The unit's
  // team stripe + pennant keep the nondescript figure selectable.
  spy: { type: 'glb', pieces: [piece('spy')] },
  // reconTeam: a scout SUV (kenney-car).
  reconTeam: { type: 'glb', pieces: [piece('reconTeam')] },
  // intelHQ 6×6 world: office block; the hqAntenna attach prop rides
  // the roof (extraPropSpecs below).
  intelHQ: { type: 'glb', pieces: [piece('intelHQMain')] },
  // listeningPost 4×4 world: low hut + the space-kit dish roof-mounted
  // (roof ≈3.3 at this scale).
  listeningPost: {
    type: 'glb',
    pieces: [
      piece('listeningPostHut'),
      piece('listeningPostDish', 0.3, 3.3, 0),
    ],
  },
  // satelliteUplink 6×6 world: one big ground dish (1:1, the
  // radarStation precedent — different dish silhouette).
  satelliteUplink: { type: 'glb', pieces: [piece('satelliteUplink')] },
  // signalsStation 4×4 world: equipment shed; the procedural signalMast
  // prop is ground-planted beside it and rises through the shed roof
  // near its edge (extraPropSpecs below) — reads as a roof-mounted
  // installation while staying inside the footprint.
  signalsStation: { type: 'glb', pieces: [piece('signalsStationHut')] },
  // ---- NOVATERRA roster-expansion buildings ----
  barracks: { type: 'glb', pieces: [piece('barracks')] },
  // Phase 1 (veterancy): the military academy hall.
  militaryAcademy: { type: 'glb', pieces: [piece('militaryAcademy')] },
  warFactory: {
    type: 'glb',
    pieces: [piece('warFactoryMain', -1, 0, 0.5), piece('industrialStack', 2.5, 0, -1)],
  },
  airfield: {
    type: 'glb',
    pieces: [piece('airfieldHangar', -2.2, 0, -1.5), piece('airfieldHangar2', 2.8, 0, -1.8)],
  },
  navalYard: {
    type: 'glb',
    pieces: [piece('navalYardCrane', -2.5, 0, -1), piece('navalYardHall', 2.5, 0, 1)],
  },
  radarStation: { type: 'glb', pieces: [piece('radarStation')] },
  quarry: { type: 'procedural' },
  oilRefinery: {
    type: 'glb',
    pieces: [
      piece('oilRefineryTank', -1.8, 0, -1),
      piece('industrialTank', 1.5, 0, 1.2),
      piece('industrialStack', 2.8, 0, -1.5),
    ],
  },
  recyclingCenter: { type: 'glb', pieces: [piece('recyclingCenter')] },
  market: { type: 'glb', pieces: [piece('market')] },
  solarFarm: {
    type: 'glb',
    pieces: [piece('solarFarmA', -1.8, 0, 0), piece('solarFarmB', 1.8, 0, 0)],
  },
  nuclearPlant: { type: 'glb', pieces: [piece('nuclearPlantMain', -1.5, 0, -1)] },
  desalination: {
    type: 'glb',
    pieces: [piece('industrialTank', -1.2, 0, -1), piece('desalinationHall', 1.2, 0, 1)],
  },
  hospital: { type: 'glb', pieces: [piece('hospital')] },
  university: { type: 'glb', pieces: [piece('university')] },
  school: { type: 'glb', pieces: [piece('school')] },
  // Workstream Z (2026-09-30): the education ladder.
  kindergarten: { type: 'glb', pieces: [piece('kindergarten')] },
  college: { type: 'glb', pieces: [piece('college')] },
  // Workstream W (2026-09-30): the civic amenities — procedural-first
  // (AD12: zero boot-download growth).
  library: { type: 'procedural' },
  park: { type: 'procedural' },
  // Workstream P (ambient city life): civic parking.
  parkingLot: { type: 'procedural' },
  parkingGarage: { type: 'procedural' },
  // Grand-expansion Phase 4 (transport, S7 — sim workstream): same
  // arrangement as the transport units above — source entries now,
  // real procedural builders in the render workstream's Phase 4 pass.
  railStation: { type: 'procedural' },
  busDepot: { type: 'procedural' },
  ferryTerminal: { type: 'procedural' },
  marina: { type: 'procedural' },
  marinaLarge: { type: 'procedural' },
  // Phase 4 tiered transit (2026-09-30 — sim workstream): same
  // arrangement as the transport hubs above — source entries now,
  // real procedural builders in the render workstream's Phase 4 pass.
  busStop: { type: 'procedural' },
  taxiStand: { type: 'procedural' },
  tramStop: { type: 'procedural' },
  ferryPier: { type: 'procedural' },
  neighborhoodStation: { type: 'procedural' },
  centralStation: { type: 'procedural' },
  airportInterchange: { type: 'procedural' },
  monument: { type: 'procedural' },
  // Grand-expansion Phase 2 (utilities, 2026-09-30): the 12 new utility
  // buildings — procedural-first (AD12: zero boot-download growth).
  // NOT in game/src/render/models.ts MODEL_PATHS (no GLB weight added).
  coalPlant: { type: 'procedural' },
  gasPlant: { type: 'procedural' },
  windFarm: { type: 'procedural' },
  hydroDam: { type: 'procedural' },
  geothermalPlant: { type: 'procedural' },
  fusionPlant: { type: 'procedural' },
  waterWell: { type: 'procedural' },
  waterTower: { type: 'procedural' },
  waterTreatment: { type: 'procedural' },
  reservoir: { type: 'procedural' },
  powerSubstation: { type: 'procedural' },
  pumpingStation: { type: 'procedural' },
  batteryStation: { type: 'procedural' },
  // Grand-expansion Phase 3 (logistics): gap models in proceduralModels.ts.
  oilWell: { type: 'procedural' },
  oilRig: { type: 'procedural' },
  munitionsFactory: { type: 'procedural' },
  missilePlant: { type: 'procedural' },
  missileSilo: { type: 'procedural' },
  ordnanceDepot: { type: 'procedural' },
  fuelDepot: { type: 'procedural' },
};

/**
 * Resolve an entity kind to its model source. Unknown kinds fall back
 * to the placeholder builders — the game never renders a blank entity.
 * Exported for the mapping-completeness test (every UnitKind and
 * BuildingKind must resolve to `glb` or `procedural`).
 */
export function modelSourceFor(kind: string): ModelSource {
  return MODEL_SOURCES[kind] ?? { type: 'placeholder' };
}

/** A kind's resolved visual pieces (shared by the legacy and instanced view paths). */
export interface ResolvedVisual {
  pieces: Array<{
    pool: string;
    model: LoadedModel;
    dx: number;
    dy: number;
    dz: number;
  }>;
  top: number;
  /**
   * Phase 4 (transport): uniform building size-tier scale (0.88/1.0/
   * 1.14). The legacy path sets group.scale; the instanced path composes
   * it into each piece's offset matrix. 1 for units (no size tiers).
   */
  scale: number;
}

/**
 * True when a kind's visual resolution is degraded: the kind wants GLB
 * pieces but one or more are missing from the loaded map (lazy load
 * still in flight, or the fetch failed). Degraded views render fallback
 * art (procedural gap model or placeholder) and are upgraded in place by
 * `maybeUpgradeUnitView` / `maybeUpgradeBuildingView` once the pieces
 * arrive — a view created during the load window must not keep fallback
 * art forever. Kinds whose source is procedural/placeholder can never be
 * degraded (nothing to wait for). Pure and headless-safe.
 */
export function isDegradedResolution(kind: string, resolved: ResolvedVisual | null): boolean {
  const source = modelSourceFor(kind);
  if (source.type !== 'glb') return false;
  if (resolved === null) return true;
  let glbPieces = 0;
  for (const p of resolved.pieces) {
    // Phase 4 (transport): the generic variant-extra props are not GLB
    // pieces (they are procedural, like prop: pieces).
    if (!p.pool.startsWith('procedural:') && !p.pool.startsWith('prop:') && !p.pool.startsWith('variantExtra:')) glbPieces++;
  }
  return glbPieces < source.pieces.length;
}

// ---------------------------------------------------------------------------
// Sizing conventions (also the scale provenance for MODEL_PATHS)
// ---------------------------------------------------------------------------

/**
 * Team colors: human blue, rival red (default) or orange (colorblind).
 * Blue/orange is safe for the most common color-vision deficiencies
 * (deuteranopia/protanopia); the HTML `colorblind` class toggles it.
 */
function teamColors(): readonly [string, string] {
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('colorblind')) {
    return ['#3aa0ff', '#ffaa00'] as const; // blue vs orange
  }
  return ['#3aa0ff', '#ff5544'] as const; // blue vs red
}

/** Hull colors per unit kind family (placeholder tint only). */
function hullColorFor(kind: string): number {
  switch (kind) {
    case 'tank':
      return 0x5a6b7d;
    case 'artillery':
      return 0x6b5a4a;
    case 'aa':
      return 0x4a6b5a;
    case 'hq':
      return 0x7d7d8a;
    case 'spectre':
      return 0x3a3a44;
    case 'fighter':
    case 'drone':
    case 'transport':
      return 0x8a94a6;
    case 'sniperTeam':
      return 0x5c6247;
    case 'combatMedic':
      return 0xd8d8d8;
    case 'apc':
      return 0x5a6b4a;
    case 'tankDestroyer':
      return 0x4a5a6b;
    case 'mlrs':
      return 0x6b5a4a;
    case 'fighterBomber':
      return 0x7a8a9a;
    case 'attackHeli':
      return 0x4a6b5a;
    case 'awacs':
      return 0x9aa2ad;
    case 'missileBoat':
      return 0x5a6b7d;
    case 'frigate':
    case 'carrier':
      return 0x6e7885;
    case 'submarine':
      return 0x3a4048;
    case 'commandShip':
      return 0x7d8a9a;
    case 'fishingBoat':
      return 0x8a7d6b;
    default:
      return 0x6b7d8a;
  }
}

/**
 * Approximate hull footprint per kind (x = width, z = length, y = height).
 * Drives model fit-to-footprint scales (see models.ts), selection-ring
 * sizing, and health-bar heights. Exported: the scale analysis and the
 * mapping test treat this as the footprint convention.
 */
export function hullSizeFor(kind: string): { x: number; y: number; z: number } {
  switch (kind) {
    case 'engineer':
    case 'rifles':
      return { x: 1.4, y: 1.8, z: 1.4 };
    case 'tank':
      return { x: 3.2, y: 1.4, z: 4.6 };
    case 'artillery':
      return { x: 3.0, y: 1.6, z: 5.2 };
    case 'aa':
      return { x: 3.0, y: 2.2, z: 4.4 };
    case 'hq':
      return { x: 4.2, y: 2.4, z: 5.4 };
    case 'hauler':
      return { x: 3.4, y: 2.0, z: 5.6 };
    case 'spectre':
      return { x: 4.5, y: 1.2, z: 5.5 };
    case 'fighter':
      return { x: 6.4, y: 0.9, z: 4.2 };
    case 'transport':
      return { x: 7.2, y: 1.6, z: 5.6 };
    case 'drone':
      return { x: 2.4, y: 0.6, z: 2.4 };
    case 'patrolBoat':
      return { x: 3.2, y: 2.0, z: 8.0 };
    case 'destroyer':
      return { x: 5.0, y: 3.5, z: 17.0 };
    case 'transportShip':
      return { x: 6.5, y: 4.0, z: 19.0 };
    // NOVATERRA roster-expansion units
    case 'sniperTeam':
    case 'combatMedic':
      return { x: 1.4, y: 1.8, z: 1.4 };
    case 'apc':
      return { x: 3.0, y: 2.2, z: 4.6 };
    case 'tankDestroyer':
      return { x: 3.2, y: 1.5, z: 4.8 };
    case 'mlrs':
      return { x: 3.0, y: 2.4, z: 5.0 };
    case 'fighterBomber':
      return { x: 7.0, y: 1.2, z: 5.0 };
    case 'attackHeli':
      return { x: 6.5, y: 1.8, z: 5.5 };
    case 'awacs':
      return { x: 8.0, y: 2.5, z: 7.0 };
    case 'missileBoat':
      return { x: 3.0, y: 1.8, z: 7.5 };
    case 'frigate':
      return { x: 4.5, y: 3.5, z: 14.0 };
    case 'submarine':
      return { x: 4.0, y: 3.0, z: 13.0 };
    case 'carrier':
      return { x: 9.0, y: 4.5, z: 22.0 };
    case 'commandShip':
      return { x: 6.0, y: 4.0, z: 16.0 };
    case 'fishingBoat':
      return { x: 2.4, y: 1.6, z: 5.0 };
    // Grand-expansion Phase 5 — air/naval expansion (workstream E, pass 2,
    // 2026-09-30): the 13 styloo aircraft.
    case 'jumboAirliner':
      return { x: 13, y: 4, z: 12 };
    case 'airliner':
      return { x: 10, y: 3, z: 9 };
    case 'regionalJet':
      return { x: 6.5, y: 2, z: 6 };
    case 'maritimePatrol':
      return { x: 7, y: 2.5, z: 7.5 };
    case 'reconPlane':
      return { x: 5, y: 1.8, z: 5.5 };
    case 'seaplane':
      return { x: 5.5, y: 2.2, z: 6 };
    case 'cargoPlane':
      return { x: 7, y: 2.5, z: 7.5 };
    case 'militaryCargo':
      return { x: 7.5, y: 2.8, z: 8 };
    case 'tanker':
      return { x: 8, y: 3, z: 8.5 };
    case 'trainer':
      return { x: 4.5, y: 1.8, z: 5 };
    case 'reconUAV':
      return { x: 3.5, y: 1.2, z: 4 };
    case 'strategicBomber':
      return { x: 11, y: 3, z: 10 };
    case 'armedUAV':
      return { x: 3.5, y: 1.2, z: 4 };
    // The 3 procedural hero aircraft.
    case 'navalFighter':
      return { x: 7, y: 1.5, z: 6 };
    case 'gunship':
      return { x: 7, y: 2, z: 6 };
    case 'passengerHeli':
      return { x: 6.5, y: 2.2, z: 6 };
    // Grand-expansion Phase 6 — naval expansion (workstream E, pass 2):
    // the 6 hero warships + 9 logistics ships.
    case 'coastalSub':
      return { x: 3, y: 2.5, z: 12 };
    case 'missileSub':
      return { x: 4, y: 3.5, z: 20 };
    case 'corvette':
      return { x: 4, y: 3, z: 13 };
    case 'cruiser':
      return { x: 6, y: 4.5, z: 22 };
    case 'battleship':
      return { x: 8, y: 6, z: 30 };
    case 'heavyDestroyer':
      return { x: 5.5, y: 4, z: 20 };
    case 'cargoFreighter':
      return { x: 6.5, y: 4, z: 19 };
    case 'fuelTanker':
      return { x: 7, y: 5, z: 20 };
    case 'ammoShip':
      return { x: 6, y: 4.5, z: 18 };
    case 'repairShip':
      return { x: 4.5, y: 3.5, z: 10 };
    case 'minelayer':
      return { x: 4.5, y: 3.5, z: 10 };
    case 'navalMine':
      return { x: 1.2, y: 1.2, z: 1.2 };
    case 'coastGuardCutter':
      return { x: 3, y: 2.2, z: 7 };
    case 'cruiseLiner':
      return { x: 8, y: 6, z: 24 };
    case 'yacht':
      return { x: 2.6, y: 1.8, z: 6.5 };
    // Grand-expansion Phase 6 — intel roster (workstream 5, art). The
    // §3.8 sim defs do not exist yet; these sizes pin the footprint
    // convention the MODEL_PATHS scales above were measured against,
    // plus selection-ring sizing when the defs arrive.
    case 'spy':
      return { x: 1.4, y: 1.8, z: 1.4 };
    case 'reconTeam':
      return { x: 3.0, y: 1.8, z: 4.6 };
    case 'intelHQ':
      return { x: 6, y: 6.5, z: 6 };
    case 'listeningPost':
      return { x: 4, y: 4.5, z: 4 };
    case 'satelliteUplink':
      return { x: 6, y: 5.5, z: 6 };
    case 'signalsStation':
      return { x: 4, y: 7, z: 4 };
    default:
      return { x: 1.6, y: 2.2, z: 1.6 }; // infantry-ish
  }
}

/**
 * Smooth placeholder hull for a unit kind: capsule/cylinder/cone
 * composites, sized to the hull box. Air units get a fuselage + nose
 * cone; armored land units get a rounded hull + turret + barrel;
 * infantry-ish units get a single upright capsule. Group origin is at
 * the hull's vertical center.
 *
 * Fallback only (used when neither GLB nor procedural model is
 * available); never the primary art path.
 */
function createHullMesh(
  kind: string,
  domain: string,
  size: { x: number; y: number; z: number },
  mat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const add = (mesh: THREE.Mesh, y = 0): void => {
    mesh.position.y = y;
    g.add(mesh);
  };
  if (domain === 'air') {
    // Fuselage along X with a nose cone.
    const fus = new THREE.Mesh(
      new THREE.CapsuleGeometry(size.y / 2, size.x - size.y, 6, 16),
      mat,
    );
    fus.rotation.z = Math.PI / 2;
    add(fus);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(size.y / 2, size.x * 0.45, 16), mat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = size.x / 2 + size.x * 0.2;
    g.add(nose);
    return g;
  }
  switch (kind) {
    case 'tank':
    case 'artillery':
    case 'aa':
    case 'hq':
    case 'hauler': {
      // Rounded armored hull along Z + turret ring + barrel.
      const hullLen = size.z - size.y;
      const hull = new THREE.Mesh(
        new THREE.CapsuleGeometry(size.y / 2, Math.max(hullLen, 0.5), 6, 16),
        mat,
      );
      hull.rotation.x = Math.PI / 2;
      hull.scale.x = size.x / size.y;
      add(hull);
      const turret = new THREE.Mesh(
        new THREE.CylinderGeometry(size.y * 0.32, size.y * 0.38, size.y * 0.5, 16),
        mat,
      );
      add(turret, size.y * 0.55);
      if (kind === 'tank' || kind === 'artillery') {
        const barrel = new THREE.Mesh(
          new THREE.CylinderGeometry(size.y * 0.09, size.y * 0.11, size.z * 0.55, 10),
          mat,
        );
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, size.y * 0.6, size.z * 0.45);
        g.add(barrel);
      }
      return g;
    }
    default: {
      // Infantry-ish: upright capsule.
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(size.x / 2, Math.max(size.y - size.x, 0.4), 6, 12),
        mat,
      );
      add(body);
      return g;
    }
  }
}

/** Building box height per kind. Exported: scale provenance for models.ts. */
export function buildingHeightFor(kind: BuildingKind): number {
  switch (kind) {
    case 'house':
      return 3;
    case 'apartment':
      return 9;
    case 'shop':
      return 4;
    case 'lab':
      return 7;
    case 'factory':
      return 6;
    case 'farm':
      return 2;
    case 'powerPlant':
      return 10;
    case 'waterPump':
      return 4;
    case 'mediaCenter':
      return 14;
    case 'shipyard':
      return 6;
    case 'aegisControl':
      return 8;
    case 'stormArray':
      return 8;
    // NOVATERRA roster-expansion buildings
    case 'barracks':
      return 5;
    // Phase 1 (veterancy): the academy hall is a low 3×3 block.
    case 'militaryAcademy':
      return 4;
    case 'warFactory':
      return 7;
    case 'airfield':
      return 6;
    case 'navalYard':
      return 7;
    case 'radarStation':
      return 6;
    case 'quarry':
      return 3;
    case 'oilRefinery':
      return 8;
    case 'recyclingCenter':
      return 5;
    case 'market':
      return 5;
    case 'solarFarm':
      return 3;
    case 'nuclearPlant':
      return 12;
    case 'desalination':
      return 5;
    case 'hospital':
      return 8;
    case 'university':
      return 9;
    case 'school':
      return 4;
    case 'monument':
      return 10;
    // Grand-expansion Phase 2 (utilities): heights for the 12 new kinds.
    // These case labels are outside the current BuildingKind union — legal
    // (unreachable-but-valid string cases) until the sim's BuildingKind
    // grows them, at which point they take effect with no code change.
    case 'coalPlant':
      return 9;
    case 'gasPlant':
      return 4;
    case 'windFarm':
      return 9;
    case 'hydroDam':
      return 8;
    case 'geothermalPlant':
      return 4;
    case 'fusionPlant':
      return 5;
    case 'waterWell':
      return 7;
    case 'waterTower':
      return 11;
    case 'waterTreatment':
      return 3;
    case 'reservoir':
      return 4;
    case 'powerSubstation':
      return 6;
    case 'pumpingStation':
      return 4;
    case 'batteryStation':
      return 3;
    // Grand-expansion Phase 3 (logistics): model heights for the 7 kinds.
    case 'oilWell':
      return 10;
    case 'oilRig':
      return 9;
    case 'munitionsFactory':
      return 6;
    case 'missilePlant':
      return 9;
    case 'missileSilo':
      return 9;
    case 'ordnanceDepot':
      return 3;
    case 'fuelDepot':
      return 4;
    default:
      return 4;
  }
}

/** Building tint by zone: residential warm, commercial cyan, industrial amber, utility gray. */
function buildingColorFor(zone: ZoneType | typeof UTILITY_ZONE): number {
  switch (zone) {
    case 0:
      return 0xd8b48a;
    case 1:
      return 0x8ad0d8;
    case 2:
      return 0xd8c48a;
    default:
      return 0x9aa0a8;
  }
}

/** One live unit's meshes. */
interface UnitView {
  group: THREE.Group;
  id: number;
  /** Legacy path only: null in instanced mode (meshes live in pools). */
  hull: THREE.Group | null;
  /** Legacy path only: null in instanced mode (bars are instanced). */
  barBg: THREE.Sprite | null;
  /** Legacy path only: null in instanced mode (bars are instanced). */
  barFg: THREE.Sprite | null;
  /**
   * Group-relative lift of the hull: the terrain/water Y itself lives on
   * `group.position.y` (see `unitGroundY`), so this is the hover gap
   * only (land sit-on-terrain epsilon, spectre hover, air hover; 0 for
   * sea — the waterline is the group origin).
   */
  baseY: number;
  /** Top of the model (stripe/pennant/bar anchor), world units above baseY. */
  modelTop: number;
  /** Yaw in instanced mode (the legacy path stores it on hull.rotation.y). */
  yaw: number;
  /** True when this view's meshes live in the instancer's pools. */
  instanced: boolean;
  /** Legacy path only: team stripe mesh (repositioned on model upgrade). */
  stripe: THREE.Mesh | null;
  /** Legacy path only: pennant mesh (repositioned on model upgrade). */
  pennant: THREE.Mesh | null;
  /**
   * True when the view was built while some of the kind's GLB pieces were
   * still loading (or failed): it renders fallback art and `sync` upgrades
   * it in place once the pieces arrive.
   */
  degraded: boolean;
  /**
   * Per-view disposables ONLY: health-bar + pennant materials. Shared
   * geometry/materials (model, stripe, placeholder templates) are never
   * disposed per view.
   */
  owned: Array<THREE.BufferGeometry | THREE.Material>;
}

/** One live building's mesh group. */
interface BuildingView {
  group: THREE.Group;
  id: number;
  kind: BuildingKind;
  owner: number;
  /**
   * Phase 4 (transport): the sim's per-building visual variant (0..3)
   * and size tier (1..3), threaded from the BuildingRecord at creation.
   * Re-resolution (lazy-load upgrades, construction conversion) reuses
   * these so the view never changes its look mid-life.
   */
  variant: number;
  sizeTier: 1 | 2 | 3;
  /** Meshes whose materials swap between shared and construction clones. */
  modelMeshes: THREE.Mesh[];
  /** Shared materials parallel to modelMeshes (restored on completion). */
  sharedMaterials: THREE.Material[];
  /** True while the view's materials are per-view construction clones. */
  constructing: boolean;
  /** True when this view's meshes live in the instancer's pools. */
  instanced: boolean;
  /** Per-view disposables: pennant material + active construction clones. */
  owned: THREE.Material[];
  /** Top of the model, for the pennant anchor. */
  modelTop: number;
  /**
   * True when the view was built while some of the kind's GLB pieces were
   * still loading (or failed): it renders fallback art and `sync` upgrades
   * it in place once the pieces arrive.
   */
  degraded: boolean;
}

/** Options for the EntityRenderer constructor. */
export interface EntityRendererOptions {
  /** Water level: sea-unit hulls float here (default 0). */
  waterLevel?: number;
  /**
   * Per-kind instanced rendering (Phase 0 workstream 1): model bodies,
   * team stripes/pennants and health bars render as per-kind
   * InstancedMesh pools instead of one Group per view. Default false
   * (legacy per-view Groups — used by headless tests).
   */
  instanced?: boolean;
  /**
   * The sim's terrain. When provided, every ground-anchored view rides
   * on it: units (per frame — they move), buildings (at creation),
   * roads (draped per corner), selection rings, and superweapon FX.
   * Without it the renderer keeps the legacy flat-y=0 placement (used
   * by headless tests that don't build a terrain).
   */
  terrain?: TerrainData;
  /**
   * The TerrainView's water plane (caller-owned, built in `ui/game.ts` —
   * the renderer only bobs it and never disposes it). When provided,
   * `sync` breathes it with the living-nature swell; without it the
   * water keeps the static level (headless tests).
   */
  waterMesh?: THREE.Object3D;
}

/**
 * Owns all entity meshes for a game scene. Call `sync(world)` every frame
 * (or when the sim ticks) and `setSelected(ids)` when selection changes.
 *
 * @param scene the three.js scene to populate.
 * @param models loaded GLB models (MODEL_PATHS keys). The map is
 *   caller-owned: the renderer never disposes it (call `disposeModels`
 *   from `render/models.ts` when the game tears down). An empty map is
 *   fully supported — every entity falls back to procedural, then
 *   placeholder, art and the game stays playable.
 * @param opts.waterLevel sea-unit float level (default 0).
 * @param opts.terrain when provided, entity views ride on the terrain
 *   (see `EntityRendererOptions.terrain`); without it they sit at y=0.
 */
export class EntityRenderer {
  private readonly scene: THREE.Scene;
  private readonly models: Map<string, LoadedModel>;
  private readonly waterLevel: number;
  private readonly terrain: TerrainData | null;
  /**
   * Per-kind instanced view pools (`opts.instanced`). Null in the legacy
   * per-view-Group mode (default; used by headless tests).
   */
  private readonly instancer: EntityInstancer | null;
  /** Camera for instanced health-bar billboarding (set via setCamera). */
  private camera: THREE.Camera | null = null;
  private readonly unitGroup = new THREE.Group();
  private readonly buildingGroup = new THREE.Group();
  private readonly fxGroup = new THREE.Group();
  private readonly units = new Map<number, UnitView>();
  private readonly buildings = new Map<number, BuildingView>();
  private roadMesh: THREE.Mesh | null = null;
  private roadDashMesh: THREE.Mesh | null = null;
  private roadDigest = -1;
  private readonly selectionRings = new Map<number, THREE.Mesh>();
  private readonly ringGeo = new THREE.RingGeometry(2.2, 2.8, 24);
  private readonly ringMat = new THREE.MeshBasicMaterial({
    color: 0x57c8ff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly barTexture: THREE.CanvasTexture;
  /**
   * Veterancy chevron overlay (render/chevrons.ts): three instanced
   * meshes reading world.units directly — independent of the unit-body
   * render path (legacy or Phase 0 instanced).
   */
  private readonly chevrons: ChevronOverlay;
  // Workstream Z: zone-tint ground decals (visible by default).
  private readonly zoneOverlay: ZoneOverlay;
  // Workstream P (ambient city life): auto-paved zone decals +
  // instanced ambient pedestrians/cars (render-side only, always on).
  private readonly pavingOverlay: PavingOverlay;
  private readonly ambientCrowd: AmbientCrowd;
  // Living nature (0.1 Alpha): decorative bird flyovers (render-side
  // only, always on). Tree sway and water flow live in the materials
  // themselves (render/ambientTime.ts clock); this only drives poses.
  private readonly birds: BirdFlocks;
  /**
   * The TerrainView's water plane for the living-nature swell
   * (caller-owned; the renderer bobs it, never disposes it).
   */
  private readonly waterMesh: THREE.Object3D | null;
  /**
   * Phase 2 (utilities): the always-on network runs (poles/pipes —
   * visible whenever built, like roads) and the toggleable diagnostic
   * overlay (coverage tints + diag markers, off by default).
   */
  private readonly networkOverlay: NetworkOverlay;
  /**
   * Phase 4 RENDER workstream A (item 1): underground/x-ray view — ghosts
   * the terrain + water and lights up the water-pipe network. Materials
   * are late-bound via `setXrayMaterials`.
   */
  private readonly xrayView: XrayView;
  /**
   * Phase 4 RENDER workstream A (follow-up B): the terrain grid overlay
   * — one draped LineSegments, hidden by default.
   */
  private readonly gridView: GridView;
  private readonly utilityOverlay: UtilityOverlay;
  /**
   * Phase 4 RENDER workstream A (item 5): per-building utility
   * indicators (bolt = power trouble, drop = water trouble) — always
   * on, 0 draw calls when the city is fully supplied.
   */
  private readonly utilityIndicators: UtilityIndicators;
  private utilityOverlayVisible = false;
  /**
   * Phase 3 (logistics): the toggleable reload-coverage / low-supply
   * overlay (off by default, like the utility overlay).
   */
  private readonly logisticsOverlay: LogisticsOverlay;
  private logisticsOverlayVisible = false;
  // Grand-expansion Phase 5 (S5+S8): airport-site rings + airline-route arcs.
  private readonly airportOverlay: AirportOverlay;
  private airportOverlayVisible = false;
  /** Workstream W: the toggleable residential-desirability overlay. */
  private readonly desirabilityOverlay: DesirabilityOverlay;
  private desirabilityOverlayVisible = false;
  /** Live superweapon FX views, keyed by fx identity. */
  private readonly superweaponFx = new Map<string, SuperweaponFxView>();
  // ---- shared model assets (one copy per kind, never disposed per view) ----
  /** Procedural gap models, built once per kind. */
  private readonly proceduralCache = new Map<string, LoadedModel>();
  /** Procedural attach props (infantry gear, HQ antenna, radar dish). */
  private readonly propCache = new Map<string, LoadedModel>();
  /** Placeholder unit templates (GLB/procedural fallback), per kind+domain. */
  private readonly placeholderUnitTemplates = new Map<string, THREE.Group>();
  /** Placeholder building templates, per kind. */
  private readonly placeholderBuildingTemplates = new Map<string, THREE.Group>();
  /** Model top (max y) per kind, measured once from the built group. */
  private readonly modelTops = new Map<string, number>();
  /** Team stripe geometry per unit kind (shared across views). */
  private readonly stripeGeos = new Map<string, THREE.BufferGeometry>();
  /** Team stripe material per resolved team color (usually 2 entries). */
  private readonly stripeMats = new Map<string, THREE.Material>();
  /** Team pennant geometry (shared); the material is per view (tinted). */
  private readonly pennantGeo = new THREE.SphereGeometry(0.16, 8, 6);
  // ---- shared road assets ----
  private readonly roadAsphaltMat = new THREE.MeshStandardMaterial({
    color: ROAD_ASPHALT_COLOR,
    roughness: 0.95,
    // Fine aggregate grain over the ribbon (roads.ts emits world-scale
    // UVs for it); the yellow dashes stay flat.
    roughnessMap: surfaceRoughnessTexture('tireRubber'),
  });
  private readonly roadDashMat = new THREE.MeshStandardMaterial({
    color: ROAD_DASH_COLOR,
    roughness: 0.8,
  });
  // Shared superweapon FX assets (created once, reused per view).
  private readonly aegisDomeGeo = new THREE.SphereGeometry(
    AEGIS_DOME_RADIUS, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2,
  );
  private readonly aegisDomeMat = new THREE.MeshBasicMaterial({
    color: 0x40c8ff,
    transparent: true,
    opacity: 0.18,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly aegisWireMat = new THREE.MeshBasicMaterial({
    color: 0x80e0ff,
    wireframe: true,
    transparent: true,
    opacity: 0.12,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly stormCloudGeo = new THREE.SphereGeometry(14, 18, 14);
  private readonly stormCloudMat = new THREE.MeshBasicMaterial({
    color: 0x23232e,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  private readonly boltGeo = new THREE.CylinderGeometry(0.7, 1.6, 44, 6);
  private readonly boltMat = new THREE.MeshBasicMaterial({
    color: 0xfff6c0,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  private readonly flashGeo = new THREE.SphereGeometry(9, 16, 12);
  private readonly flashMat = new THREE.MeshBasicMaterial({
    color: 0xffd76a,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  constructor(
    scene: THREE.Scene,
    models: Map<string, LoadedModel> = new Map(),
    opts: EntityRendererOptions = {},
  ) {
    this.scene = scene;
    this.models = models;
    this.waterLevel = opts.waterLevel ?? 0;
    this.terrain = opts.terrain ?? null;
    this.instancer = opts.instanced ? new EntityInstancer(scene) : null;
    this.unitGroup.name = 'units';
    this.buildingGroup.name = 'buildings';
    this.fxGroup.name = 'fx';
    scene.add(this.unitGroup, this.buildingGroup, this.fxGroup);
    // 1x1 white texture for health-bar sprites.
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    const ctx = c.getContext('2d');
    if (ctx === null) throw new Error('entities: 2d canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1, 1);
    this.barTexture = new THREE.CanvasTexture(c);
    this.chevrons = new ChevronOverlay(scene);
    this.zoneOverlay = new ZoneOverlay(scene);
    // Workstream P (ambient city life): paving is a sibling of the zone
    // decals (same digest cadence); the crowd reads zones/roads/seed.
    this.pavingOverlay = new PavingOverlay(scene);
    // The crowd borrows the caller-owned models map so the civilian
    // pedestrian GLBs can lazy-load through it (render/people.ts);
    // without the map it keeps the capsule fallback.
    this.ambientCrowd = new AmbientCrowd(scene, models);
    // Living nature: bird flyovers (their own instanced meshes; tree
    // sway + water flow are material-level, driven by the ambient
    // clock in syncLivingNature below).
    this.birds = new BirdFlocks(scene);
    this.waterMesh = opts.waterMesh ?? null;
    // Phase 2 (utilities): network runs render always; the diagnostic
    // overlay starts hidden (top-bar toggle flips it).
    this.networkOverlay = new NetworkOverlay(scene);
    // Phase 4 RENDER workstream A (item 1): the underground/x-ray view.
    // Terrain/water materials are late-bound via setXrayMaterials (the
    // TerrainView is built before this renderer exists).
    this.xrayView = new XrayView((on) => this.networkOverlay.setXray(on));
    this.utilityOverlay = new UtilityOverlay(scene);
    this.utilityIndicators = new UtilityIndicators(scene);
    // Phase 4 RENDER workstream A (follow-up B): the terrain grid —
    // built once (terrain never changes), draped via heightAt, hidden
    // by default (top-bar "Grid" button / G key).
    this.gridView = new GridView(
      scene,
      this.terrain !== null
        ? (x, z) => heightAt(this.terrain as TerrainData, x, z)
        : undefined,
    );
    this.logisticsOverlay = new LogisticsOverlay(scene);
    this.desirabilityOverlay = new DesirabilityOverlay(scene);
    // Grand-expansion Phase 5 (S5+S8).
    this.airportOverlay = new AirportOverlay(scene);
  }

  /** Create/update/remove meshes to match the world. Render-side only. */
  sync(world: World): void {
    this.instancer?.beginFrame();
    this.syncUnits(world);
    this.syncBuildings(world);
    this.syncRoads(world);
    this.syncZoneOverlay(world);
    this.syncCityLife(world);
    this.syncLivingNature(world);
    this.syncNetworks(world);
    this.syncUtilityOverlay(world);
    // Phase 4 RENDER workstream A (item 5): per-building utility
    // indicators — always on, 0 draw calls when fully supplied.
    this.syncUtilityIndicators(world);
    this.syncLogisticsOverlay(world);
    this.syncDesirabilityOverlay(world);
    // Grand-expansion Phase 5 (S5+S8).
    this.syncAirportOverlay(world);
    this.syncSuperweaponFx(world);
    this.syncChevrons(world);
    this.instancer?.endFrame(this.camera ?? undefined);
  }

  /**
   * Camera used to billboard instanced health bars (`opts.instanced`
   * mode). Optional — without it bars face +z (headless tests).
   */
  setCamera(camera: THREE.Camera | null): void {
    this.camera = camera;
  }

  /**
   * Ground Y for a unit: terrain height for land and air (aircraft use
   * the ground *beneath* them — the hover gap is group-relative), the
   * water level for sea. Recomputed every frame from `heightAt`, so
   * moving units ride hills and valleys (deterministic: `heightAt` is a
   * pure function of terrain).
   */
  private unitGroundY(u: UnitRecord): number {
    return groundYAt(this.terrain, this.waterLevel, u.domain as HeightDomain, u.x, u.z);
  }

  /**
   * Height sampler for the road builders, or undefined (flat roads) when
   * the renderer has no terrain.
   */
  private roadHeightSampler(): ((x: number, z: number) => number) | undefined {
    const t = this.terrain;
    if (t === null) return undefined;
    return (x: number, z: number): number => heightAt(t, x, z);
  }

  /** Update which units show selection rings. */
  setSelected(ids: Iterable<number>): void {
    const wanted = new Set(ids);
    for (const [id, ring] of this.selectionRings) {
      if (!wanted.has(id)) {
        this.fxGroup.remove(ring);
        this.selectionRings.delete(id);
      }
    }
    for (const id of wanted) {
      if (this.selectionRings.has(id)) continue;
      const ring = new THREE.Mesh(this.ringGeo, this.ringMat);
      ring.rotation.x = -Math.PI / 2;
      // Correct per-unit height lands on the next updateSelectionRings
      // pass; this just keeps the ring off the exact ground plane.
      ring.position.y = SELECTION_RING_OFFSET;
      this.fxGroup.add(ring);
      this.selectionRings.set(id, ring);
    }
  }

  /** Move selection rings onto their units each frame. */
  updateSelectionRings(units: Map<number, UnitRecord>): void {
    for (const [id, ring] of this.selectionRings) {
      const u = units.get(id);
      if (!u) continue;
      // Rings ride on the ground under the unit (terrain for land/air,
      // water level for sea) so they never sink into a hillside.
      ring.position.set(u.x, this.unitGroundY(u) + SELECTION_RING_OFFSET, u.z);
      const s = hullSizeFor(u.kind);
      const scale = Math.max(s.x, s.z) / 4;
      ring.scale.set(scale, scale, 1);
    }
  }

  /**
   * Veterancy chevron overlay (Phase 1): rebuild the per-level instance
   * lists from `world.units` every frame. Independent of the unit-body
   * path — it reads the sim records directly, so veterans get chevrons
   * whether their bodies render instanced or legacy.
   */
  private syncChevrons(world: World): void {
    // Sheltered units (parked in a hangar / embarked on a carrier) have
    // no body view to anchor chevrons to — filter them out too.
    const visible = world.units.filter((u) => !isSheltered(u));
    this.chevrons.sync(
      visible,
      this.terrain,
      this.waterLevel,
      (kind) => this.modelTopForKind(kind),
      this.camera,
    );
  }

  /**
   * Workstream Z: zone-tint ground decals. Reads `world.city.zones`
   * directly (zoning was previously invisible on the map); the overlay
   * rebuilds only when the zone digest changes (node-stable).
   */
  private syncZoneOverlay(world: World): void {
    const t = this.terrain;
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    this.zoneOverlay.sync(world.city.zones, heightFn);
  }

  /**
   * Workstream P (ambient city life): auto-paved zone decals and the
   * ambient crowd. Both are render-side only — they read the world and
   * never write it. Synced every frame like the other overlays.
   */
  private syncCityLife(world: World): void {
    const t = this.terrain;
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    this.pavingOverlay.sync(world.city.zones, heightFn);
    this.ambientCrowd.sync(world, heightFn);
  }

  /**
   * Living nature (0.1 Alpha): the decorative ambient clock + bird
   * flyovers + water swell. Everything is a pure function of
   * `world.tick` — the same pause rule as the workstream-P crowd:
   * frozen tick ⇒ still air, still water, frozen birds. Render-side
   * only; nothing here touches sim state.
   */
  private syncLivingNature(world: World): void {
    const tickSec = ambientSecondsForTick(world.tick);
    setAmbientTimeSeconds(tickSec);
    if (this.waterMesh !== null) {
      this.waterMesh.position.y = waterBobY(this.waterLevel, tickSec);
    }
    const mapHalf = this.terrain !== null ? this.terrain.size / 2 : 256;
    this.birds.sync(world.tick, mapHalf);
  }

  /**
   * Phase 2 (utilities): the always-on network runs. Reads the sim's
   * `city.powerLines` / `city.pipes` defensively (empty pre-sim) — the
   * overlay rebuilds only when the cell digests change.
   */
  private syncNetworks(world: World): void {
    const t = this.terrain;
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    this.networkOverlay.sync(
      cityPowerLines(world),
      cityPipes(world),
      CELL_WORLD_SIZE,
      heightFn,
    );
  }

  /**
   * Phase 2 (utilities): the toggleable diagnostic overlay. Skipped
   * entirely while hidden (the digest would no-op anyway, but the
   * billboard pass is worth skipping).
   */
  private syncUtilityOverlay(world: World): void {
    if (!this.utilityOverlayVisible) return;
    const t = this.terrain;
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    const data = utilityOverlayData(
      world,
      (cell) => {
        const { cx, cz } = cellCoords(cell);
        return { x: cellCenterWorld(cx), z: cellCenterWorld(cz) };
      },
      (b) => {
        const def = BUILDING_DEFS[b.kind as BuildingKind];
        return def !== undefined
          ? footprintCells(b.cx, b.cz, def.footprintW, def.footprintH)
          : [b.cz * CITY_GRID_CELLS + b.cx];
      },
    );
    this.utilityOverlay.sync(data, {
      cellSize: CELL_WORLD_SIZE,
      heightFn,
      camera: this.camera ?? undefined,
      buildingTop: (kind) => this.modelTopForKind(kind),
    });
  }

  /**
   * Phase 4 RENDER workstream A (item 5): per-building utility
   * indicators. Unlike the toggleable diagnosis overlay above, these
   * are ALWAYS on — a lightning bolt over buildings whose power
   * diagnosis is not ok, a water drop over buildings whose water
   * diagnosis is not ok. 0 draw calls when fully supplied (the class
   * keeps its meshes hidden until the first bad diagnosis).
   */
  private syncUtilityIndicators(world: World): void {
    const t = this.terrain;
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    this.utilityIndicators.sync(world.city.buildings, {
      heightFn,
      camera: this.camera ?? undefined,
      buildingTop: (kind) => this.modelTopForKind(kind),
    });
  }

  /**
   * Phase 3 (logistics): sync the reload-coverage / low-supply overlay.
   * Skipped entirely while hidden (like the utility overlay — the digest
   * pass is worth skipping).
   */
  private syncLogisticsOverlay(world: World): void {
    if (!this.logisticsOverlayVisible) return;
    const t = this.terrain;
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    this.logisticsOverlay.sync(logisticsOverlayData(world), { heightFn });
  }

  /**
   * Workstream W: residential-desirability ground tint. Skipped entirely
   * while hidden; the sim model is cached on structural change so the
   * common frame path is a key compare (see
   * `desirabilityOverlayData` / `DesirabilityOverlay.sync`).
   */
  private syncDesirabilityOverlay(world: World): void {
    if (!this.desirabilityOverlayVisible) return;
    const t = this.terrain;
    const data = desirabilityOverlayData(t, world);
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    this.desirabilityOverlay.sync(data, { heightAt: heightFn });
  }

  /**
   * Phase 2 (utilities): toggle the diagnostic overlay (the network runs
   * stay always-on). Called by the controller from the top-bar button.
   */
  setUtilityOverlayVisible(visible: boolean): void {
    this.utilityOverlayVisible = visible;
    this.utilityOverlay.setVisible(visible);
  }

  /**
   * Phase 3 (logistics): toggle the reload-coverage / low-supply overlay.
   * Called by the controller from the top-bar button.
   */
  setLogisticsOverlayVisible(visible: boolean): void {
    this.logisticsOverlayVisible = visible;
    this.logisticsOverlay.setVisible(visible);
  }

  // -------------------------------------------------------------------------
  // Grand-expansion Phase 5 (S5+S8): airport overlay
  // -------------------------------------------------------------------------

  private syncAirportOverlay(world: World): void {
    if (!this.airportOverlayVisible) return;
    const t = this.terrain;
    const heightFn =
      t === null ? undefined : (x: number, z: number): number => heightAt(t, x, z);
    this.airportOverlay.sync(airportOverlayData(world, HUMAN_PLAYER_ID), { heightFn });
  }

  /**
   * Toggle the airport-site / airline-route overlay. Called by the
   * controller from the top-bar button.
   */
  setAirportOverlayVisible(visible: boolean): void {
    this.airportOverlayVisible = visible;
    this.airportOverlay.setVisible(visible);
  }

  /**
   * Workstream W (desirability): toggle the residential-desirability
   * ("Land value") overlay. Called by the controller from the top-bar
   * button; the overlay rebuilds only on model-cache-key change.
   */
  setDesirabilityOverlayVisible(visible: boolean): void {
    this.desirabilityOverlayVisible = visible;
    this.desirabilityOverlay.setVisible(visible);
  }

  /**
   * Phase 4 RENDER workstream A (item 1): late-bind the terrain + water
   * materials the x-ray view ghosts. Called by the controller after
   * construction (the TerrainView is built first).
   */
  setXrayMaterials(terrain: THREE.Material, water: THREE.Material): void {
    this.xrayView.setTerrainMaterials(terrain, water);
  }

  /**
   * Phase 4 RENDER workstream A (item 1): toggle the underground/x-ray
   * view. Called by the controller from the top-bar button; game.ts also
   * auto-enables it while the water-pipe tool is armed.
   */
  setXrayVisible(visible: boolean): void {
    this.xrayView.setVisible(visible);
  }

  /** Phase 4 RENDER workstream A (item 1): x-ray state (HUD/digest). */
  isXrayVisible(): boolean {
    return this.xrayView.visible;
  }

  /**
   * Phase 4 RENDER workstream A (follow-up B): toggle the terrain grid
   * overlay (top-bar "Grid" button / G key; hidden by default).
   */
  setGridVisible(visible: boolean): void {
    this.gridView.setVisible(visible);
  }

  /** Phase 4 RENDER workstream A (follow-up B): grid state. */
  isGridVisible(): boolean {
    return this.gridView.visible;
  }

  /**
   * Model top for chevron anchoring: the measured per-kind top when a
   * view has been built for the kind, else the placeholder hull height
   * (same fallback the legacy view builder uses).
   */
  private modelTopForKind(kind: string): number {
    return this.modelTops.get(kind) ?? hullSizeFor(kind).y;
  }

  /**
   * Superweapon FX, driven by the sim's deterministic `world.superweapons.fx`
   * records. Animation phase derives from `world.tick` (never wall clock),
   * so the visuals track the sim's timing exactly.
   */
  private syncSuperweaponFx(world: World): void {
    const seen = new Set<string>();
    for (const fx of world.superweapons.fx) {
      const key = `${fx.kind}:${fx.x.toFixed(1)}:${fx.z.toFixed(1)}:${fx.untilTick}`;
      seen.add(key);
      let view = this.superweaponFx.get(key);
      if (!view) {
        view = fx.kind === 'aegis' ? this.createAegisView(fx) : this.createStormView(fx);
        this.fxGroup.add(view.group);
        this.superweaponFx.set(key, view);
      }
      this.animateSuperweaponFx(view, world.tick);
    }
    for (const [key, view] of this.superweaponFx) {
      if (!seen.has(key)) {
        this.fxGroup.remove(view.group);
        if (view.kind === 'storm') {
          // Storm views own cloned materials; release them.
          view.group.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh) (mesh.material as THREE.Material).dispose();
          });
        }
        this.superweaponFx.delete(key);
      }
    }
  }

  /** Translucent energy dome + wireframe shimmer over the shielded city. */
  private createAegisView(fx: WeaponFx): SuperweaponFxView {
    const group = new THREE.Group();
    const dome = new THREE.Mesh(this.aegisDomeGeo, this.aegisDomeMat);
    const wire = new THREE.Mesh(this.aegisDomeGeo, this.aegisWireMat);
    wire.scale.setScalar(1.01);
    group.add(dome, wire);
    // The dome base sits on the terrain under the shielded city.
    group.position.set(
      fx.x,
      groundYAt(this.terrain, this.waterLevel, 'land', fx.x, fx.z),
      fx.z,
    );
    return { group, untilTick: fx.untilTick, kind: 'aegis' };
  }

  /** Storm cloud + lightning bolt + impact flash for one strike. */
  private createStormView(fx: WeaponFx): SuperweaponFxView {
    const group = new THREE.Group();
    const cloud = new THREE.Mesh(this.stormCloudGeo, this.stormCloudMat.clone());
    cloud.scale.set(1.4, 0.45, 1.4);
    cloud.position.y = 38;
    const bolt = new THREE.Mesh(this.boltGeo, this.boltMat.clone());
    bolt.position.y = 20;
    const flash = new THREE.Mesh(this.flashGeo, this.flashMat.clone());
    flash.position.y = 2;
    group.add(cloud, bolt, flash);
    // Strike effects anchor on the terrain (cloud/bolt/flash stay
    // group-relative, so they keep their designed proportions).
    group.position.set(
      fx.x,
      groundYAt(this.terrain, this.waterLevel, 'land', fx.x, fx.z),
      fx.z,
    );
    group.userData['cloud'] = cloud;
    group.userData['bolt'] = bolt;
    group.userData['flash'] = flash;
    return { group, untilTick: fx.untilTick, kind: 'storm' };
  }

  /** Advance one FX view's deterministic animation from the sim tick. */
  private animateSuperweaponFx(view: SuperweaponFxView, tick: number): void {
    if (view.kind === 'aegis') {
      // Gentle energy shimmer; pulse period ~2 sim-seconds.
      const pulse = 0.5 + 0.5 * Math.sin(tick * 0.105);
      this.aegisDomeMat.opacity = 0.14 + 0.08 * pulse;
      this.aegisWireMat.opacity = 0.08 + 0.08 * pulse;
      return;
    }
    // Storm strike: 0 = just spawned, 1 = expiring.
    const phase = 1 - Math.max(0, view.untilTick - tick) / STORM_FX_TICKS;
    const cloud = view.group.userData['cloud'] as THREE.Mesh;
    const bolt = view.group.userData['bolt'] as THREE.Mesh;
    const flash = view.group.userData['flash'] as THREE.Mesh;
    const cloudMat = cloud.material as THREE.MeshBasicMaterial;
    const boltMat = bolt.material as THREE.MeshBasicMaterial;
    const flashMat = flash.material as THREE.MeshBasicMaterial;
    if (phase < 0.25) {
      // Cloud gathers.
      const s = phase / 0.25;
      cloud.scale.set(1.4 * s, 0.45 * s, 1.4 * s);
      cloudMat.opacity = 0.88 * s;
      boltMat.opacity = 0;
      flashMat.opacity = 0;
    } else if (phase < 0.45) {
      // Lightning strike + impact flash.
      const s = (phase - 0.25) / 0.2;
      cloud.scale.set(1.4, 0.45, 1.4);
      cloudMat.opacity = 0.88;
      boltMat.opacity = 0.95;
      bolt.scale.set(1, s, 1);
      flashMat.opacity = 0.7 * s;
      flash.scale.setScalar(0.5 + s);
    } else {
      // Dissipate.
      const s = (phase - 0.45) / 0.55;
      cloudMat.opacity = 0.88 * (1 - s);
      boltMat.opacity = 0.95 * (1 - s * 2 > 0 ? 1 - s * 2 : 0);
      flashMat.opacity = 0.7 * (1 - s);
      flash.scale.setScalar(1.5 + s * 2);
    }
  }

  dispose(): void {
    this.scene.remove(this.unitGroup, this.buildingGroup, this.fxGroup);
    for (const v of this.units.values()) this.disposeUnitView(v);
    this.units.clear();
    for (const v of this.buildings.values()) this.disposeBuildingView(v);
    this.buildings.clear();
    this.selectionRings.clear();
    this.superweaponFx.clear();
    this.instancer?.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.barTexture.dispose();
    this.chevrons.dispose();
    this.zoneOverlay.dispose();
    // Workstream P (ambient city life).
    this.pavingOverlay.dispose();
    this.ambientCrowd.dispose();
    // Living nature.
    this.birds.dispose();
    this.networkOverlay.dispose();
    this.utilityOverlay.dispose();
    this.utilityIndicators.dispose();
    this.logisticsOverlay.dispose();
    this.desirabilityOverlay.dispose();
    // Grand-expansion Phase 5 (S5+S8).
    this.airportOverlay.dispose();
    this.gridView.dispose();
    // Shared per-kind assets (never per-view): release once here.
    for (const m of this.proceduralCache.values()) {
      for (const g of m.geometries) g.dispose();
      for (const mat of m.materials) mat.dispose();
    }
    this.proceduralCache.clear();
    for (const m of this.propCache.values()) {
      for (const g of m.geometries) g.dispose();
      for (const mat of m.materials) mat.dispose();
    }
    this.propCache.clear();
    for (const t of this.placeholderUnitTemplates.values()) disposeGroup(t);
    this.placeholderUnitTemplates.clear();
    for (const t of this.placeholderBuildingTemplates.values()) disposeGroup(t);
    this.placeholderBuildingTemplates.clear();
    for (const g of this.stripeGeos.values()) g.dispose();
    this.stripeGeos.clear();
    for (const m of this.stripeMats.values()) m.dispose();
    this.stripeMats.clear();
    this.pennantGeo.dispose();
    this.roadAsphaltMat.dispose();
    this.roadDashMat.dispose();
    this.aegisDomeGeo.dispose();
    this.aegisDomeMat.dispose();
    this.aegisWireMat.dispose();
    this.stormCloudGeo.dispose();
    this.stormCloudMat.dispose();
    this.boltGeo.dispose();
    this.boltMat.dispose();
    this.flashGeo.dispose();
    this.flashMat.dispose();
    this.disposeRoadMesh();
    // NOTE: this.models is caller-owned — the caller disposes it with
    // disposeModels() from render/models.ts after teardown.
  }

  /** Release the road meshes (geometries; materials are shared). */
  private disposeRoadMesh(): void {
    if (this.roadMesh) {
      this.buildingGroup.remove(this.roadMesh);
      this.roadMesh.geometry.dispose();
      this.roadMesh = null;
    }
    if (this.roadDashMesh) {
      this.buildingGroup.remove(this.roadDashMesh);
      this.roadDashMesh.geometry.dispose();
      this.roadDashMesh = null;
    }
  }

  // ---- model resolution ----

  /**
   * Procedural gap model for a kind, built once and cached. Returns
   * undefined for non-gap kinds (caller falls through to placeholders).
   */
  private proceduralFor(kind: string): LoadedModel | undefined {
    let m = this.proceduralCache.get(kind);
    if (m === undefined) {
      const built = buildProceduralModel(kind);
      if (built === undefined) return undefined;
      this.proceduralCache.set(kind, built);
      m = built;
    }
    return m;
  }

  /**
   * Procedural attach prop, built once per key: 'gear:rifles',
   * 'gear:engineer', 'gear:sniper', 'gear:medic', 'hqAntenna',
   * 'radarDish', 'awacsDome', 'shipMast', 'runwayStrip',
   * 'coolingTower', 'hospitalCross', 'seaplaneFloats', 'mineRails',
   * 'navalMineSpikes', 'signalMast'.
   */
  private propFor(key: string): LoadedModel {
    let m = this.propCache.get(key);
    if (m === undefined) {
      if (key === 'gear:rifles' || key === 'gear:engineer' || key === 'gear:sniper' || key === 'gear:medic') {
        m = buildInfantryGear(key.slice('gear:'.length) as 'rifles' | 'engineer' | 'sniper' | 'medic');
      } else if (key === 'hqAntenna') {
        m = buildHqAntenna();
        // Grand-expansion Phase 6 — intel roster (workstream 5, art):
        // the tall SIGINT mast for signalsStation.
      } else if (key === 'signalMast') {
        m = buildSignalMast();
      } else if (key === 'awacsDome') {
        m = buildAwacsDome();
      } else if (key === 'shipMast') {
        m = buildShipMast();
      } else if (key === 'runwayStrip') {
        m = buildRunwayStrip();
        // Grand-expansion Phase 5 (S5+S8): the procedural control tower
        // rides the airport anchors as an attached prop.
      } else if (key === 'controlTower') {
        m = buildControlTower();
      } else if (key === 'coolingTower') {
        m = buildCoolingTower();
      } else if (key === 'hospitalCross') {
        m = buildHospitalCross();
        // Grand-expansion Phase 5 — air/naval expansion (workstream E,
        // pass 2): the kitbash attach props.
      } else if (key === 'seaplaneFloats') {
        m = buildSeaplaneFloats();
      } else if (key === 'mineRails') {
        m = buildMineRails();
      } else if (key === 'navalMineSpikes') {
        m = buildNavalMineSpikes();
      } else {
        m = buildRadarDishProp();
      }
      this.propCache.set(key, m);
    }
    return m;
  }

  /** Add the meshes of a LoadedModel-like to a group (shared geo/mat). */
  private static addModelMeshes(group: THREE.Group, model: LoadedModel): void {
    for (let i = 0; i < model.geometries.length; i++) {
      const geo = model.geometries[i];
      const mat = model.materials[i] ?? model.materials[0];
      if (geo === undefined || mat === undefined) continue;
      group.add(new THREE.Mesh(geo, mat));
    }
  }

  /**
   * Public read of the attach-prop specs for a kind (tests, debug
   * tooling). The private static stays the single source of truth for
   * placement; this is just a window into it.
   */
  static propSpecsFor(
    kind: string,
  ): Array<{ prop: string; dx: number; dy: number; dz: number }> {
    return EntityRenderer.extraPropSpecs(kind);
  }

  /**
   * Per-kind extras that make GLB models read correctly in game:
   * infantry gear (rifle / hard-hat / sniper rifle / medic kit), the HQ
   * command antenna, the aegisControl radar dish, the AWACS rotodome,
   * the command-ship comms mast, the airfield runway strip, the nuclear
   * cooling tower, the hospital cross, and the airport anchors' runway
   * strip + procedural control tower (grand-expansion Phase 5, S5+S8).
   * The intel roster (grand-expansion Phase 6, workstream 5) reuses the
   * hqAntenna on the intelHQ roof and adds the signalMast for
   * signalsStation. Declared as data so both the
   * legacy per-view path (`attachModelExtras`) and the instanced path
   * (`resolveVisualPieces`) place them identically.
   */
  private static extraPropSpecs(
    kind: string,
  ): Array<{ prop: string; dx: number; dy: number; dz: number }> {
    if (
      kind === 'rifles' ||
      kind === 'engineer' ||
      kind === 'sniperTeam' ||
      kind === 'combatMedic'
    ) {
      const gearKey =
        kind === 'sniperTeam' ? 'sniper' : kind === 'combatMedic' ? 'medic' : kind;
      return [{ prop: `gear:${gearKey}`, dx: 0, dy: 0, dz: 0 }];
    }
    switch (kind) {
      case 'hq':
        // On the flatbed toward the rear (-z; the model faces +z).
        return [{ prop: 'hqAntenna', dx: 0, dy: 1.5, dz: -1.2 }];
      case 'aegisControl':
        // Beside the main block, clear of its footprint.
        return [{ prop: 'radarDish', dx: 1.5, dy: 0, dz: 1.8 }];
      case 'awacs':
        // On the fuselage crown (fuselage top ≈2.3 at this scale).
        return [{ prop: 'awacsDome', dx: 0, dy: 1.9, dz: -0.3 }];
      case 'commandShip':
        // On the deck aft of the superstructure.
        return [{ prop: 'shipMast', dx: 0, dy: 2.2, dz: 1.0 }];
      case 'airfield':
        // Runway along x beside the hangars.
        return [{ prop: 'runwayStrip', dx: 0, dy: 0.02, dz: 2.2 }];
      // Grand-expansion Phase 5 (S5+S8): the airport anchors read as
      // airports via the same runway-strip prop plus a procedural
      // control tower at the apron's edge.
      case 'civilAirport':
        return [
          { prop: 'runwayStrip', dx: 0, dy: 0.02, dz: 3.4 },
          { prop: 'controlTower', dx: 3.2, dy: 0, dz: -0.5 },
        ];
      case 'militaryAirbase':
        return [
          { prop: 'runwayStrip', dx: 0, dy: 0.02, dz: 3.4 },
          { prop: 'controlTower', dx: -3.2, dy: 0, dz: -0.5 },
        ];
      case 'mixedAirport':
        return [
          { prop: 'runwayStrip', dx: 0, dy: 0.02, dz: 3.4 },
          { prop: 'controlTower', dx: 3.2, dy: 0, dz: -0.5 },
        ];
      case 'nuclearPlant':
        // Beside the reactor hall, clear of its footprint.
        return [{ prop: 'coolingTower', dx: 2.2, dy: 0, dz: 1.8 }];
      case 'hospital':
        // Roof sign (roof ≈8.0 at this scale).
        return [{ prop: 'hospitalCross', dx: 0, dy: 8.0, dz: 0 }];
      // Grand-expansion Phase 5 — air/naval expansion (workstream E,
      // pass 2, 2026-09-30): the attach props for the kitbash kinds.
      case 'seaplane':
        // Twin floats tuck under the fuselage (planesty at scale 0.724).
        return [{ prop: 'seaplaneFloats', dx: 0, dy: 0.55, dz: 0 }];
      case 'minelayer':
        // Mine rails on the stern deck (bow at +z; stern at -z).
        return [{ prop: 'mineRails', dx: 0, dy: 1.4, dz: -1.5 }];
      case 'navalMine':
        // Contact spikes on the buoy crown.
        return [{ prop: 'navalMineSpikes', dx: 0, dy: 0, dz: 0 }];
      // Grand-expansion Phase 6 — intel roster (workstream 5, art).
      case 'intelHQ':
        // The command antenna rides the office-block roof
        // (roof ≈6.5 at this scale; the 'hq' precedent).
        return [{ prop: 'hqAntenna', dx: 0, dy: 6.6, dz: -0.5 }];
      case 'signalsStation':
        // The SIGINT mast is ground-planted at the shed's edge and rises
        // through the roof — reads as a roof-mounted installation.
        return [{ prop: 'signalMast', dx: 1.7, dy: 0, dz: 0.5 }];
      default:
        return [];
    }
  }

  /**
   * Attach per-kind extras to a legacy per-view group. Shared
   * geometry/materials; one `Mesh` per view (a Mesh can only have one
   * parent).
   */
  private attachModelExtras(group: THREE.Group, kind: string): void {
    for (const e of EntityRenderer.extraPropSpecs(kind)) {
      const sub = new THREE.Group();
      EntityRenderer.addModelMeshes(sub, this.propFor(e.prop));
      sub.position.set(e.dx, e.dy, e.dz);
      group.add(sub);
    }
  }

  /**
   * Resolve a kind to its visual pieces (GLB → procedural → null for
   * placeholder): one pool key + entity-local offset per piece. The
   * legacy path (`createModelGroup`) and the instanced path share this
   * resolution, so both place pieces identically.
   */
  private resolveVisualPieces(
    kind: string,
    // Phase 4 (transport): the sim's per-building visual variant (0..3)
    // and size tier (1..3). Units always resolve the defaults.
    variant: number = BUILDING_VARIANT_BASE,
    sizeTier: 1 | 2 | 3 = 2,
  ): ResolvedVisual | null {
    const source = modelSourceFor(kind);
    const pieces: Array<{
      pool: string;
      model: LoadedModel;
      dx: number;
      dy: number;
      dz: number;
    }> = [];
    if (source.type === 'glb') {
      for (const p of source.pieces) {
        const model = this.models.get(p.key);
        // Missing piece: show the rest (a geometry-less model can never
        // contribute an instance, so it is skipped like the legacy path
        // skipped childless piece groups).
        if (model === undefined || model.geometries.length === 0) continue;
        pieces.push({ pool: p.key, model, dx: p.dx, dy: p.dy, dz: p.dz });
      }
      if (pieces.length === 0) {
        // No GLB pieces loaded (missing/failed): try the procedural gap
        // model for this kind before giving up (GLB → procedural →
        // placeholder), so e.g. a failed tank-1 download still renders
        // a tankDestroyer rather than a capsule.
        const fallback = this.proceduralFor(kind);
        if (fallback === undefined) return null;
        pieces.push({
          pool: `procedural:${kind}`,
          model: fallback,
          dx: 0,
          dy: 0,
          dz: 0,
        });
      }
    } else if (source.type === 'procedural') {
      const model = this.proceduralFor(kind);
      if (model === undefined) return null;
      pieces.push({
        pool: `procedural:${kind}`,
        model,
        dx: 0,
        dy: 0,
        dz: 0,
      });
    } else {
      return null;
    }
    for (const e of EntityRenderer.extraPropSpecs(kind)) {
      pieces.push({
        pool: `prop:${e.prop}`,
        model: this.propFor(e.prop),
        dx: e.dx,
        dy: e.dy,
        dz: e.dz,
      });
    }
    // Phase 4 (transport): variant 1..3 gets a generic rooftop prop at
    // the base model's top — distinct silhouettes through the lazy
    // pipeline (the variantExtra pools are never boot keys). Variant 0
    // is the base look. The base top is measured (and cached per kind)
    // BEFORE the extra is pushed, so `modelTops` stays variant-free.
    const scale = sizeTierScale(sizeTier);
    const baseTop = this.modelTopForPieces(kind, pieces);
    let top = baseTop;
    const extra = variantExtraFor(variant);
    if (extra !== undefined) {
      pieces.push({
        pool: variantExtraPoolKey(variant),
        model: extra,
        dx: 0,
        dy: baseTop,
        dz: 0,
      });
      top = baseTop + variantExtraTop(variant);
    }
    return { pieces, top, scale };
  }

  /**
   * Build the visual model group for a kind: GLB pieces (shared) →
   * procedural gap model (shared, cached) → null (caller uses the
   * placeholder template). The group's base sits at y=0 and it faces
   * +z; geometry and materials are shared across all views of the kind.
   */
  private createModelGroup(
    kind: string,
    variant: number = BUILDING_VARIANT_BASE,
    sizeTier: 1 | 2 | 3 = 2,
  ): { group: THREE.Group; top: number; scale: number } | null {
    const resolved = this.resolveVisualPieces(kind, variant, sizeTier);
    if (resolved === null) return null;
    const group = new THREE.Group();
    for (const p of resolved.pieces) {
      const pieceGroup = new THREE.Group();
      EntityRenderer.addModelMeshes(pieceGroup, p.model);
      pieceGroup.position.set(p.dx, p.dy, p.dz);
      group.add(pieceGroup);
    }
    // Phase 4 (transport): the size-tier scale applies to the whole
    // group (footprint included — a size-3 building reads bigger).
    group.scale.setScalar(resolved.scale);
    return { group, top: resolved.top * resolved.scale, scale: resolved.scale };
  }

  /**
   * Top (max y) of a kind's resolved pieces, measured once and cached.
   * Measured from the same piece layout the legacy group builder uses,
   * so stripe/pennant/bar anchors match between the two paths.
   */
  private modelTopForPieces(
    kind: string,
    pieces: Array<{ model: LoadedModel; dx: number; dy: number; dz: number }>,
  ): number {
    let top = this.modelTops.get(kind);
    if (top === undefined) {
      const group = new THREE.Group();
      for (const p of pieces) {
        const pieceGroup = new THREE.Group();
        EntityRenderer.addModelMeshes(pieceGroup, p.model);
        pieceGroup.position.set(p.dx, p.dy, p.dz);
        group.add(pieceGroup);
      }
      const box = new THREE.Box3().setFromObject(group);
      top = box.isEmpty() ? 1 : box.max.y;
      this.modelTops.set(kind, top);
    }
    return top;
  }

  /**
   * Placeholder unit template (fallback art), built once per kind+domain
   * and CLONED per view — clone() shares geometry/material, so per-view
   * disposal never touches the shared assets. The template is shifted so
   * its base sits at y=0 like the real models.
   */
  private placeholderUnitTemplate(kind: string, domain: string): THREE.Group {
    const key = `${kind}:${domain}`;
    let t = this.placeholderUnitTemplates.get(key);
    if (t === undefined) {
      const size = hullSizeFor(kind);
      const mat = new THREE.MeshStandardMaterial({
        color: hullColorFor(kind),
        roughness: 0.55,
        metalness: 0.35,
      });
      const inner = createHullMesh(kind, domain, size, mat);
      inner.position.y = size.y / 2; // centered origin → base at y=0
      t = new THREE.Group();
      t.add(inner);
      this.placeholderUnitTemplates.set(key, t);
    }
    return t;
  }

  /** Placeholder building template (fallback art), per kind. */
  private placeholderBuildingTemplate(kind: BuildingKind): THREE.Group {
    let t = this.placeholderBuildingTemplates.get(kind);
    if (t === undefined) {
      const def = BUILDING_DEFS[kind];
      const w = def.footprintW * CELL_WORLD_SIZE;
      const d = def.footprintH * CELL_WORLD_SIZE;
      const h = buildingHeightFor(kind);
      const mat = new THREE.MeshStandardMaterial({
        color: buildingColorFor(def.zone),
        roughness: 0.8,
        metalness: 0.1,
      });
      t = createBuildingMesh(kind, w, h, d, mat);
      this.placeholderBuildingTemplates.set(kind, t);
    }
    return t;
  }

  /** Team stripe geometry for a unit kind, shared across views. */
  private stripeGeoFor(kind: string): THREE.BufferGeometry {
    let g = this.stripeGeos.get(kind);
    if (g === undefined) {
      const size = hullSizeFor(kind);
      g = new THREE.CylinderGeometry(size.x * 0.32, size.x * 0.32, 0.22, 20);
      this.stripeGeos.set(kind, g);
    }
    return g;
  }

  /** Team stripe material per resolved team color (shared across views). */
  private stripeMatFor(team: string): THREE.Material {
    let m = this.stripeMats.get(team);
    if (m === undefined) {
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(team),
        emissive: new THREE.Color(team),
        emissiveIntensity: 0.7,
      });
      this.stripeMats.set(team, m);
    }
    return m;
  }

  /**
   * Team pennant: a small glowing marker floating above the model so
   * ownership reads at a glance even though models keep their authored
   * colors. Geometry is shared; the material is per view (tinted) and
   * caller-owned for disposal.
   */
  private createPennant(team: string): { mesh: THREE.Mesh; material: THREE.Material } {
    const material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(team),
      emissive: new THREE.Color(team),
      emissiveIntensity: 1.2,
    });
    const mesh = new THREE.Mesh(this.pennantGeo, material);
    return { mesh, material };
  }

  // ---- units ----

  private syncUnits(world: World): void {
    const seen = new Set<number>();
    for (const u of world.units) {
      if (u.hp <= 0) continue;
      // Sheltered units (parked in a hangar / embarked on a carrier)
      // have no map presence: skipping them here keeps them out of the
      // `seen` set, so the dispose sweep below releases their views.
      if (isSheltered(u)) continue;
      seen.add(u.id);
      let view = this.units.get(u.id);
      if (!view) {
        view = this.createUnitView(u);
        this.units.set(u.id, view);
        this.unitGroup.add(view.group);
      }
      this.updateUnitView(view, u);
      // Lazy-load upgrade: a view built while its kind's GLB was still
      // arriving renders fallback art until the pieces land, then swaps
      // to the real model in place (render-side only).
      if (view.degraded) this.maybeUpgradeUnitView(view, u);
    }
    for (const [id, view] of this.units) {
      if (!seen.has(id)) {
        this.unitGroup.remove(view.group);
        this.disposeUnitView(view);
        this.units.delete(id);
      }
    }
  }

  private createUnitView(u: UnitRecord): UnitView {
    const group = new THREE.Group();
    const size = hullSizeFor(u.kind);
    const team = teamColors()[u.owner] ?? '#aaaaaa';
    const owned: Array<THREE.BufferGeometry | THREE.Material> = [];
    const baseY = unitHoverY(u.domain as HeightDomain, u.kind);
    // Resolve once: both view paths (and the degraded flag below) share
    // the resolution, so legacy and instanced views place pieces
    // identically.
    const resolved = this.resolveVisualPieces(u.kind);
    const degraded = isDegradedResolution(u.kind, resolved);

    // Instanced path: model body, stripe, pennant, and health bars all
    // live in per-kind InstancedMesh pools (see entityInstancing.ts); the
    // group stays empty so scene-graph invariants still hold. Kinds with
    // no resolvable model (placeholder fallback) keep the legacy path.
    // The resolution is shared with the legacy branch below (and the
    // degraded flag), so both paths place pieces identically.
    const instancer = this.instancer;
    if (instancer !== null && resolved !== null) {
      const groundY = this.unitGroundY(u);
      group.position.set(u.x, groundY, u.z);
      const view: UnitView = {
        group,
        id: u.id,
        hull: null,
        barBg: null,
        barFg: null,
        baseY,
        modelTop: resolved.top,
        yaw: 0,
        instanced: false,
        stripe: null,
        pennant: null,
        degraded,
        owned,
      };
      this.addUnitInstance(view, u, resolved);
      return view;
    }

    // Hull: real model (GLB → procedural) or the shared placeholder
    // template. The hull group's base sits at y=0; baseY lifts it for
    // air hover and the land sit-on-terrain epsilon, while the group
    // itself rides the terrain (land/air) or the water level (sea).
    const hull = new THREE.Group();
    const built = this.createModelGroup(u.kind);
    let modelTop: number;
    if (built !== null) {
      hull.add(built.group);
      modelTop = built.top;
    } else {
      hull.add(this.placeholderUnitTemplate(u.kind, u.domain).clone());
      modelTop = size.y;
    }
    hull.position.y = baseY;
    group.add(hull);

    // Team stripe: thin emissive disc above the model (shared geo/mat).
    const stripe = new THREE.Mesh(this.stripeGeoFor(u.kind), this.stripeMatFor(team));
    stripe.position.y = baseY + modelTop + 0.15;
    group.add(stripe);

    // Team pennant: tiny glowing marker above the stripe (per-view tint).
    const pennant = this.createPennant(team);
    pennant.mesh.position.y = baseY + modelTop + 0.55;
    group.add(pennant.mesh);
    owned.push(pennant.material);

    const barBg = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.barTexture, color: 0x1a1a1a, depthTest: false }),
    );
    const barFg = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.barTexture, color: 0x4ade80, depthTest: false }),
    );
    barBg.center.set(0, 0.5);
    barFg.center.set(0, 0.5);
    barBg.scale.set(4, 0.5, 1);
    barFg.scale.set(4, 0.5, 1);
    barBg.renderOrder = 10;
    barFg.renderOrder = 11;
    group.add(barBg, barFg);
    owned.push(barBg.material, barFg.material);

    // The group rides the terrain (recomputed per frame in
    // updateUnitView as the unit moves); stripe, pennant, and health
    // bars stay group-relative, so they ride along for free.
    group.position.set(u.x, this.unitGroundY(u), u.z);
    return {
      group, id: u.id, hull, barBg, barFg, baseY, modelTop, yaw: 0,
      instanced: false, stripe, pennant: pennant.mesh, degraded, owned,
    };
  }

  /**
   * Allocate a unit's instance slots from a resolution. Shared by view
   * creation and the lazy-load upgrade path (`maybeUpgradeUnitView`).
   */
  private addUnitInstance(view: UnitView, u: UnitRecord, resolved: ResolvedVisual): void {
    const instancer = this.instancer as EntityInstancer;
    const team = teamColors()[u.owner] ?? '#aaaaaa';
    const size = hullSizeFor(u.kind);
    const pieces: InstancedPiece[] = resolved.pieces.map((p) => {
      instancer.definePool(p.pool, p.model);
      return {
        pool: p.pool,
        offset: new THREE.Matrix4().makeTranslation(p.dx, p.dy, p.dz),
      };
    });
    instancer.addEntity(u.id, pieces, {
      stripe: true,
      stripeScale: size.x * 0.32,
      team,
    });
    instancer.writeTransform(u.id, {
      x: u.x,
      y: this.unitGroundY(u),
      z: u.z,
      yaw: view.yaw,
      baseY: view.baseY,
      modelTop: resolved.top,
      hpFrac: 1,
      showBar: false,
    });
    view.modelTop = resolved.top;
    view.instanced = true;
  }

  /**
   * Rebuild a legacy unit view's hull from the current resolution
   * (lazy-load upgrade path). Only shared assets are touched — the old
   * hull's children are placeholder clones or shared model groups, never
   * per-view disposables — so no disposal is needed. Stripe, pennant, and
   * health bars are re-anchored to the new model top (bars also move every
   * frame in `updateUnitView`).
   */
  private rebuildUnitHull(view: UnitView, u: UnitRecord): void {
    const hull = view.hull as THREE.Group;
    hull.clear();
    const built = this.createModelGroup(u.kind);
    if (built !== null) {
      hull.add(built.group);
      view.modelTop = built.top;
    } else {
      hull.add(this.placeholderUnitTemplate(u.kind, u.domain).clone());
      view.modelTop = hullSizeFor(u.kind).y;
    }
    const anchorY = view.baseY + view.modelTop;
    if (view.stripe !== null) view.stripe.position.y = anchorY + 0.15;
    if (view.pennant !== null) view.pennant.position.y = anchorY + 0.55;
  }

  /**
   * Lazy-load upgrade for a unit view built while its kind's GLB pieces
   * were still arriving: re-resolve, and if the kind is now whole, swap
   * the fallback art for the real model in place. Render-side only —
   * no sim state is touched. Degraded views that are still waiting keep
   * their fallback art and are re-checked next frame (a failed fetch
   * never resolves, so they simply stay degraded).
   */
  private maybeUpgradeUnitView(view: UnitView, u: UnitRecord): void {
    // The model top is cached per kind: drop it so the fresh resolution
    // measures the real pieces, not the fallback art.
    this.modelTops.delete(u.kind);
    const resolved = this.resolveVisualPieces(u.kind);
    if (isDegradedResolution(u.kind, resolved) || resolved === null) return;
    const instancer = this.instancer;
    if (instancer !== null) {
      if (view.instanced) instancer.removeEntity(u.id);
      this.addUnitInstance(view, u, resolved);
    } else {
      this.rebuildUnitHull(view, u);
    }
    view.degraded = false;
  }

  private updateUnitView(view: UnitView, u: UnitRecord): void {
    const instancer = this.instancer;
    if (instancer !== null && view.instanced) {
      const dx = u.destX - u.x;
      const dz = u.destZ - u.z;
      if (dx * dx + dz * dz > 0.5) {
        view.yaw = Math.atan2(dx, dz);
      }
      const def = UNIT_DEFS[u.kind as UnitKind];
      const frac = def ? Math.max(0, Math.min(1, u.hp / def.hp)) : 1;
      instancer.writeTransform(u.id, {
        x: u.x,
        y: this.unitGroundY(u),
        z: u.z,
        yaw: view.yaw,
        baseY: view.baseY,
        modelTop: view.modelTop,
        hpFrac: frac,
        showBar: frac < 1,
      });
      return;
    }
    const hull = view.hull as THREE.Group;
    view.group.position.set(u.x, this.unitGroundY(u), u.z);
    // Face the order destination when it has one; cheap orientation cue.
    // Models face +z at rotation 0 (rotY baked at load), matching the
    // placeholder convention.
    const dx = u.destX - u.x;
    const dz = u.destZ - u.z;
    if (dx * dx + dz * dz > 0.5) {
      hull.rotation.y = Math.atan2(dx, dz);
    }
    const def = UNIT_DEFS[u.kind as UnitKind];
    const frac = def ? Math.max(0, Math.min(1, u.hp / def.hp)) : 1;
    const barY = view.baseY + view.modelTop + 1.1;
    const barBg = view.barBg as THREE.Sprite;
    const barFg = view.barFg as THREE.Sprite;
    barBg.position.set(-2, barY, 0);
    barFg.position.set(-2, barY, 0);
    barFg.scale.set(4 * frac, 0.5, 1);
    (barFg.material as THREE.SpriteMaterial).color.setHex(
      frac > 0.5 ? 0x4ade80 : frac > 0.25 ? 0xfacc15 : 0xef4444,
    );
    const showBar = frac < 1;
    barBg.visible = showBar;
    barFg.visible = showBar;
  }

  /**
   * Release per-view objects only: health-bar + pennant materials.
   * Shared geometry/materials (models, stripes, templates) are owned by
   * the renderer and released once in dispose().
   */
  private disposeUnitView(view: UnitView): void {
    if (view.instanced) {
      this.instancer?.removeEntity(view.id);
    }
    for (const o of view.owned) o.dispose();
    view.owned.length = 0;
  }

  // ---- buildings ----

  private syncBuildings(world: World): void {
    const seen = new Set<number>();
    for (const b of world.city.buildings) {
      seen.add(b.id);
      let view = this.buildings.get(b.id);
      if (!view) {
        view = this.createBuildingView(b);
        this.buildingGroup.add(view.group);
        this.buildings.set(b.id, view);
      }
      this.updateBuildingConstruction(view, b.progress);
      // Lazy-load upgrade: a view built while its kind's GLB was still
      // arriving renders fallback art until the pieces land, then swaps
      // to the real model in place (render-side only).
      if (view.degraded) this.maybeUpgradeBuildingView(view, b);
    }
    for (const [id, view] of this.buildings) {
      if (!seen.has(id)) {
        this.buildingGroup.remove(view.group);
        this.disposeBuildingView(view);
        this.buildings.delete(id);
      }
    }
  }

  private createBuildingView(b: BuildingRecord): BuildingView {
    const kind = b.kind as BuildingKind;
    const def = BUILDING_DEFS[kind];
    const team = teamColors()[b.owner] ?? '#aaaaaa';
    const group = new THREE.Group();
    const modelMeshes: THREE.Mesh[] = [];
    const sharedMaterials: THREE.Material[] = [];
    const owned: THREE.Material[] = [];

    const w = def.footprintW * CELL_WORLD_SIZE;
    const d = def.footprintH * CELL_WORLD_SIZE;
    const bx = cellCenterWorld(b.cx) + (w - CELL_WORLD_SIZE) / 2;
    const bz = cellCenterWorld(b.cz) + (d - CELL_WORLD_SIZE) / 2;
    // The foundation sits on the terrain at the footprint center
    // (buildings never move, so this is computed once at creation).
    const gy =
      groundYAt(this.terrain, this.waterLevel, 'land', bx, bz) +
      BUILDING_GROUND_EPSILON;

    // The resolution is shared by both view paths (and the degraded
    // flag below), so legacy and instanced views place pieces identically.
    // Phase 4 (transport): the sim's per-building variant/sizeTier
    // (pure hash at placement — no RNG draws) thread through every
    // re-resolution below via the view fields.
    const variant = b.variant ?? BUILDING_VARIANT_BASE;
    const sizeTier = b.sizeTier ?? 2;
    const resolved = this.resolveVisualPieces(kind, variant, sizeTier);
    const degraded = isDegradedResolution(kind, resolved);

    // Instanced path: completed buildings render from per-kind pools.
    // Buildings under construction keep the legacy per-view fade path
    // (per-instance transparency is not a thing); they convert to
    // instanced slots on completion in updateBuildingConstruction.
    const instancer = this.instancer;
    if (instancer !== null && b.progress >= 1 && resolved !== null) {
      group.position.set(bx, gy, bz);
      const view: BuildingView = {
        group,
        id: b.id,
        kind,
        owner: b.owner,
        variant,
        sizeTier,
        modelMeshes: [],
        sharedMaterials: [],
        constructing: false,
        instanced: false,
        owned,
        modelTop: resolved.top,
        degraded,
      };
      this.addBuildingInstance(view, resolved);
      return view;
    }

    const built = this.createModelGroup(kind, variant, sizeTier);
    let modelTop: number;
    if (built !== null) {
      group.add(built.group);
      modelTop = built.top;
    } else {
      // Phase 4 (transport): the placeholder still honors the size tier
      // so an unmapped kind reads at the right scale.
      const tierScale = sizeTierScale(sizeTier);
      const clone = this.placeholderBuildingTemplate(kind).clone();
      clone.scale.setScalar(tierScale);
      group.add(clone);
      modelTop = buildingHeightFor(kind) * tierScale;
    }
    // Meshes whose materials participate in the construction fade.
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) {
        modelMeshes.push(mesh);
        sharedMaterials.push(mesh.material as THREE.Material);
      }
    });

    // Team pennant above the roof (per-view tint; never faded).
    const pennant = this.createPennant(team);
    pennant.mesh.position.y = modelTop + 0.6;
    group.add(pennant.mesh);
    owned.push(pennant.material);

    // The foundation sits on the terrain at the footprint center
    // (buildings never move, so this is computed once at creation).
    group.position.set(bx, gy, bz);
    const view: BuildingView = {
      group,
      id: b.id,
      kind,
      owner: b.owner,
      variant,
      sizeTier,
      modelMeshes,
      sharedMaterials,
      constructing: false,
      instanced: false,
      owned,
      modelTop,
      degraded,
    };
    // A building placed mid-construction starts faded.
    this.updateBuildingConstruction(view, b.progress);
    return view;
  }

  /**
   * Allocate a completed building's instance slots from a resolution.
   * Shared by view creation, the construction-completion conversion
   * (`convertBuildingToInstanced`), and the lazy-load upgrade path
   * (`maybeUpgradeBuildingView`). The view's group position is the
   * write anchor.
   */
  private addBuildingInstance(view: BuildingView, resolved: ResolvedVisual): void {
    const instancer = this.instancer as EntityInstancer;
    const team = teamColors()[view.owner] ?? '#aaaaaa';
    // Phase 4 (transport): the size-tier scale composes into each
    // piece's offset (translation + uniform scale about the entity
    // origin) — the instancer has no per-entity scale channel.
    const s = resolved.scale;
    const identQ = new THREE.Quaternion();
    const unitS = new THREE.Vector3(s, s, s);
    const pieces: InstancedPiece[] = resolved.pieces.map((p) => {
      instancer.definePool(p.pool, p.model);
      return {
        pool: p.pool,
        offset: new THREE.Matrix4().compose(
          new THREE.Vector3(p.dx * s, p.dy * s, p.dz * s),
          identQ,
          unitS,
        ),
      };
    });
    instancer.addEntity(view.id, pieces, {
      stripe: false,
      stripeScale: 0,
      team,
    });
    const scaledTop = resolved.top * s;
    instancer.writeTransform(view.id, {
      x: view.group.position.x,
      y: view.group.position.y,
      z: view.group.position.z,
      yaw: 0,
      baseY: 0,
      modelTop: scaledTop,
      hpFrac: 1,
      showBar: false,
    });
    view.modelMeshes.length = 0;
    view.sharedMaterials.length = 0;
    view.modelTop = scaledTop;
    view.constructing = false;
    view.instanced = true;
  }

  /**
   * Drop a legacy building view's per-view model assets (construction
   * material clones + pennant material) and empty its group. Shared
   * geometry and materials are caller-owned and never disposed here.
   */
  private clearLegacyBuildingModel(view: BuildingView): void {
    for (const m of view.owned) m.dispose();
    view.owned.length = 0;
    view.group.clear();
    view.modelMeshes.length = 0;
    view.sharedMaterials.length = 0;
  }

  /**
   * Rebuild a legacy building view's model group from the current
   * resolution (lazy-load upgrade path), preserving the construction
   * fade: the fade is torn down with the old model and re-applied from
   * the live progress below.
   */
  private rebuildLegacyBuildingModel(view: BuildingView, b: BuildingRecord): void {
    this.clearLegacyBuildingModel(view);
    // Phase 4 (transport): re-resolution reuses the view's variant/
    // sizeTier so the look never changes mid-life.
    const built = this.createModelGroup(view.kind, view.variant, view.sizeTier);
    if (built !== null) {
      view.group.add(built.group);
      view.modelTop = built.top;
    } else {
      const clone = this.placeholderBuildingTemplate(view.kind).clone();
      const tierScale = sizeTierScale(view.sizeTier);
      clone.scale.setScalar(tierScale);
      view.group.add(clone);
      view.modelTop = buildingHeightFor(view.kind) * tierScale;
    }
    view.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !Array.isArray(mesh.material)) {
        view.modelMeshes.push(mesh);
        view.sharedMaterials.push(mesh.material as THREE.Material);
      }
    });
    const team = teamColors()[b.owner] ?? '#aaaaaa';
    const pennant = this.createPennant(team);
    pennant.mesh.position.y = view.modelTop + 0.6;
    view.group.add(pennant.mesh);
    view.owned.push(pennant.material);
    // Force the construction fade to re-apply from the live progress.
    view.constructing = false;
    this.updateBuildingConstruction(view, b.progress);
  }

  /**
   * Lazy-load upgrade for a building view built while its kind's GLB
   * pieces were still arriving: re-resolve, and if the kind is now whole,
   * swap the fallback art for the real model in place. Completed
   * buildings go to instance slots; buildings still under construction
   * keep the legacy fade path (per-instance transparency is not a thing)
   * and convert on completion as usual. Render-side only.
   */
  private maybeUpgradeBuildingView(view: BuildingView, b: BuildingRecord): void {
    // The model top is cached per kind: drop it so the fresh resolution
    // measures the real pieces, not the fallback art.
    this.modelTops.delete(view.kind);
    // Phase 4 (transport): the view keeps its variant/sizeTier.
    const resolved = this.resolveVisualPieces(view.kind, view.variant, view.sizeTier);
    if (isDegradedResolution(view.kind, resolved) || resolved === null) return;
    if (this.instancer !== null && b.progress >= 1) {
      if (view.instanced) this.instancer.removeEntity(view.id);
      else this.clearLegacyBuildingModel(view);
      this.addBuildingInstance(view, resolved);
    } else {
      this.rebuildLegacyBuildingModel(view, b);
    }
    view.degraded = false;
  }

  /**
   * Construction fade with shared materials: while a building is under
   * construction its meshes use per-view material CLONES (transparent);
   * on completion the view swaps back to the shared materials and the
   * clones are released. No cross-talk between views — two buildings of
   * the same kind never share a faded material.
   *
   * In instanced mode a building that finishes construction converts to
   * instanced slots (per-instance transparency is not a thing, so the
   * fade itself stays on the legacy path).
   */
  private updateBuildingConstruction(view: BuildingView, progress: number): void {
    if (this.instancer !== null && !view.instanced && progress >= 1) {
      this.convertBuildingToInstanced(view);
      return;
    }
    if (view.instanced) return;
    const wantConstructing = progress < 1;
    if (wantConstructing === view.constructing) return;
    view.constructing = wantConstructing;
    if (wantConstructing) {
      for (let i = 0; i < view.modelMeshes.length; i++) {
        const mesh = view.modelMeshes[i] as THREE.Mesh;
        const shared = view.sharedMaterials[i] as THREE.Material;
        const clone = shared.clone();
        clone.transparent = true;
        clone.opacity = 0.55;
        mesh.material = clone;
        view.owned.push(clone);
      }
    } else {
      for (let i = 0; i < view.modelMeshes.length; i++) {
        const mesh = view.modelMeshes[i] as THREE.Mesh;
        (mesh.material as THREE.Material).dispose(); // the construction clone
        mesh.material = view.sharedMaterials[i] as THREE.Material;
      }
      // Rebuild owned without the disposed clones: keep only materials
      // still attached to a live object (the pennant material). Shared
      // materials never enter `owned`, so this keeps exactly the pennant.
      const live = new Set<THREE.Material>();
      view.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && !Array.isArray(mesh.material)) live.add(mesh.material as THREE.Material);
      });
      view.owned = view.owned.filter((m) => live.has(m as THREE.Material));
    }
  }

  /**
   * Move a finished building from the legacy per-view construction path
   * into the instancer's pools: release the per-view clones + pennant,
   * drop the legacy meshes, and allocate instance slots at the view's
   * current position. A kind with no resolvable model stays legacy
   * (placeholder fallback).
   */
  private convertBuildingToInstanced(view: BuildingView): void {
    const instancer = this.instancer;
    if (instancer === null || view.instanced) return;
    // Phase 4 (transport): the view keeps its variant/sizeTier.
    const resolved = this.resolveVisualPieces(view.kind, view.variant, view.sizeTier);
    if (resolved === null) return;
    this.clearLegacyBuildingModel(view);
    this.addBuildingInstance(view, resolved);
  }

  /** Release per-view objects: pennant + any construction clones. */
  private disposeBuildingView(view: BuildingView): void {
    if (view.instanced) {
      this.instancer?.removeEntity(view.id);
    }
    for (const m of view.owned) m.dispose();
    view.owned.length = 0;
  }

  // ---- roads ----

  private syncRoads(world: World): void {
    const roads = world.city.roads;
    // Digest, not just the count: replacing road cells with the same count
    // must still refresh the mesh. Phase 4 (S7): digest cell AND class —
    // an upgrade re-renders (the render workstream owns class visuals).
    let digest = 2166136261;
    for (const r of roads) {
      digest ^= r.cell as number;
      digest = Math.imul(digest, 16777619);
      for (let i = 0; i < r.cls.length; i++) {
        digest ^= r.cls.charCodeAt(i);
        digest = Math.imul(digest, 16777619);
      }
    }
    if (digest === this.roadDigest) return;
    this.roadDigest = digest;
    this.disposeRoadMesh();
    if (roads.length === 0) return;
    // Connected ribbon quads (one draw call) + center dashes (one more).
    // The ribbon drapes over the terrain (per-corner height sampling) so
    // roads ride hillsides instead of clipping through them.
    const cells: Array<{ x: number; z: number }> = [];
    for (const r of roads) {
      const { cx, cz } = cellCoords(r.cell);
      cells.push({ x: cellCenterWorld(cx), z: cellCenterWorld(cz) });
    }
    const heightFn = this.roadHeightSampler();
    const ribbon = buildRoadGeometry(cells, CELL_WORLD_SIZE, heightFn);
    this.roadMesh = new THREE.Mesh(ribbon, this.roadAsphaltMat);
    this.buildingGroup.add(this.roadMesh);
    const dashes = buildRoadMarkings(cells, CELL_WORLD_SIZE, heightFn);
    if ((dashes.getAttribute('position') as THREE.BufferAttribute).count > 0) {
      this.roadDashMesh = new THREE.Mesh(dashes, this.roadDashMat);
      this.buildingGroup.add(this.roadDashMesh);
    } else {
      dashes.dispose();
    }
  }

  /**
   * Test/bench hook: the instancer when `opts.instanced` is set, null in
   * legacy mode. Exposes entityCount / poolStats / debugMatrices for
   * mechanism tests without breaking the renderer's encapsulation.
   */
  get debugInstancer(): EntityInstancer | null {
    return this.instancer;
  }

  /** Unit records by id (for selection-ring updates). */
  static unitMap(world: World): Map<number, UnitRecord> {
    const map = new Map<number, UnitRecord>();
    for (const u of world.units) map.set(u.id, u);
    return map;
  }
}

/** Dispose every geometry/material in a group (shared-template teardown). */
function disposeGroup(root: THREE.Group): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
  });
}

/**
 * Smooth placeholder building: cylinder/cone/sphere composites per kind,
 * sized to the footprint. Group origin at ground level. Fallback art —
 * readable and rounded, not final.
 */
function createBuildingMesh(
  kind: BuildingKind,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
): THREE.Group {
  const g = new THREE.Group();
  const r = Math.min(w, d) / 2;
  const add = (mesh: THREE.Mesh, y: number): void => {
    mesh.position.y = y;
    g.add(mesh);
  };
  const body = (geo: THREE.BufferGeometry, y: number): void =>
    add(new THREE.Mesh(geo, mat), y);
  switch (kind) {
    case 'house':
    case 'apartment':
    case 'shop':
      // Round tower + cone roof.
      body(new THREE.CylinderGeometry(r * 0.92, r, h * 0.72, 20), h * 0.36);
      body(new THREE.ConeGeometry(r * 0.98, h * 0.34, 20), h * 0.72 + h * 0.17);
      break;
    case 'factory':
      // Wide hall + two stacks.
      body(new THREE.CylinderGeometry(r * 0.95, r, h * 0.55, 20), h * 0.275);
      body(new THREE.CylinderGeometry(r * 0.16, r * 0.2, h * 0.7, 12), h * 0.35);
      break;
    case 'farm':
      // Low dome greenhouse.
      body(new THREE.SphereGeometry(r * 0.95, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), 0);
      break;
    case 'powerPlant':
      // Tapered cooling tower.
      body(new THREE.CylinderGeometry(r * 0.62, r * 0.9, h, 20), h / 2);
      break;
    case 'waterPump':
      // Tank sphere on a drum base.
      body(new THREE.CylinderGeometry(r * 0.55, r * 0.6, h * 0.4, 16), h * 0.2);
      body(new THREE.SphereGeometry(r * 0.55, 18, 14), h * 0.4 + r * 0.5);
      break;
    case 'lab':
      // Drum + glass dome.
      body(new THREE.CylinderGeometry(r * 0.85, r * 0.9, h * 0.6, 20), h * 0.3);
      body(
        new THREE.SphereGeometry(r * 0.6, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        h * 0.6,
      );
      break;
    default:
      body(new THREE.CylinderGeometry(r * 0.9, r, h, 16), h / 2);
      break;
  }
  return g;
}
