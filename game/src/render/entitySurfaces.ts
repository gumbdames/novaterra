/**
 * @fileoverview Per-model surface treatments (0.1 Alpha).
 *
 * The game's entity library mixes three material families:
 *
 * - Kenney colormap kits (ships, vehicles, commercial/industrial buildings):
 *   one shared `colormap` atlas diffuse, perfectly flat otherwise.
 * - Quaternius GLBs (infantry, tanks, barn, silo): named materials, authored
 *   flat colors, and — critically — no UV coordinates at all.
 * - Space-kit GLBs (aircraft, hangars, radar, rocks, bushes): UVs present but
 *   no textures; `metalness = 1` on a scene with no environment map, so they
 *   shade almost black.
 * - Procedural builders (`proceduralModels.ts`): flat `MeshStandardMaterial`s
 *   from the local `pmat()` helper.
 *
 * This module is where those families get their surfaces. A per-key treatment
 * table (`KEY_TREATMENTS`, covering every key in `MODEL_PATHS`) describes what
 * each model should wear: which shared procedural textures to layer on, and
 * what roughness/metalness/env response the materials should have. Treatments
 * are applied once at model-load time (`applySurfaceTreatment`, called from
 * `models.ts loadModels`), never per-view, so the hot path pays nothing.
 *
 * Procedural builders use the `surfaceMaterial()` helper: same texture
 * library, flat-shaded so the low-poly geometry keeps its crisp facets, and
 * tagged in `userData.surfaceCategory` so tests can prove no builder part was
 * left on a bare flat material. Pure emissive accents (beacons, nav lights,
 * deck markings) keep plain materials — glow doesn't need grain.
 *
 * Team-color contract (render AGENTS.md): treatments never tint toward
 * blue/red/orange, emissive stays ~0 on model materials, and team
 * stripe/pennant materials are never listed in this table.
 *
 * License: GNU Affero General Public License v3.0 — see LICENSE.
 */
import * as THREE from 'three';
import {
  SURFACE_MATERIALS,
} from './surfaceMaterials';
import type { SurfaceCategory } from './surfaceTextures';
import {
  surfaceTexture,
  surfaceRoughnessTexture,
} from './surfaceTextures';
import { ensureBoxUVs } from './boxProjectUVs';

/** Treatment for one GLB material: which surfaces to layer and how it should shade. */
export interface MaterialTreatment {
  /** Diffuse/albedo texture category (multiplies the authored map/color). */
  map?: SurfaceCategory;
  /** Roughness-map category (multiplies the roughness scalar). */
  roughnessMap?: SurfaceCategory;
  /** sRGB hex tint applied to the material color (default: keep authored). */
  color?: number;
  /**
   * Linear-space RGB tint applied to the material color, for treatments that
   * must hit an exact authored shade through a textured surface. Each channel
   * is target-linear / surface-linear.
   */
  colorLinear?: [number, number, number];
  metalness?: number;
  roughness?: number;
  envMapIntensity?: number;
}

/** One table row: what the GLB materials of a MODEL_PATHS key become. */
export interface KeyTreatment {
  /** Default treatment applied to every standard material of the model. */
  default: MaterialTreatment;
  /** Name-based overrides, first match wins (e.g. Quaternius `Shirt`). */
  byName?: ReadonlyArray<{ pattern: RegExp; treatment: MaterialTreatment }>;
  /**
   * When set, every geometry of the model gets box-projected UVs at this
   * world-space tile size BEFORE textures are layered (Quaternius ships no
   * UVs; without this every texture lookup lands on (0,0)).
   */
  uvWorldScale?: number;
}

// ---------------------------------------------------------------------------
// Shared building blocks (module-private).
// ---------------------------------------------------------------------------

const T = {
  /** Kenney vehicles: painted bodywork. */
  vehiclePaint: {
    roughnessMap: 'paintedMetal',
    metalness: 0.3,
    roughness: 1.0,
    envMapIntensity: 0.8,
  } satisfies MaterialTreatment,
  /** Kenney ships: weathered hull plates. */
  hull: {
    roughnessMap: 'hullGray',
    metalness: 0.25,
    roughness: 1.0,
    envMapIntensity: 0.8,
  } satisfies MaterialTreatment,
  /** Commercial/civic blocks: concrete. */
  concreteBld: {
    roughnessMap: 'concrete',
    metalness: 0.05,
    roughness: 1.0,
    envMapIntensity: 0.5,
  } satisfies MaterialTreatment,
  /** Suburban brick. */
  brickBld: {
    roughnessMap: 'brickRed',
    metalness: 0.02,
    roughness: 1.0,
    envMapIntensity: 0.4,
  } satisfies MaterialTreatment,
  /** Warehouses/hangars: corrugated metal. */
  corrugated: {
    roughnessMap: 'paintedMetal',
    metalness: 0.35,
    roughness: 1.0,
    envMapIntensity: 0.8,
  } satisfies MaterialTreatment,
  /** Industrial tanks: riveted metal. */
  tankMetal: {
    roughnessMap: 'paintedMetal',
    metalness: 0.45,
    roughness: 1.0,
    envMapIntensity: 0.9,
  } satisfies MaterialTreatment,
  /** Cranes: painted yellow steel. */
  craneYellow: {
    roughnessMap: 'paintedMetal',
    metalness: 0.3,
    roughness: 1.0,
    envMapIntensity: 0.8,
  } satisfies MaterialTreatment,
  /** Heavy machinery: dark gunmetal. */
  machineDark: {
    roughnessMap: 'gunmetal',
    metalness: 0.55,
    roughness: 1.0,
    envMapIntensity: 0.9,
  } satisfies MaterialTreatment,
} as const;

/**
 * Kenney `colormap-specular` materials: the atlas holds a window band, not
 * specular data — treat as glass so they catch the sun and the env map.
 */
const SPECULAR_GLASS: KeyTreatment['byName'] = [
  {
    pattern: /specular/i,
    treatment: {
      roughnessMap: 'glassBlue',
      metalness: 0.3,
      roughness: 0.5,
      envMapIntensity: 1.2,
    },
  },
];

/** Solar PV cells (`colormap-specular`): low roughness + env for the glint. */
const SOLAR: KeyTreatment = {
  default: {
    roughnessMap: 'paintedMetal',
    metalness: 0.4,
    roughness: 1.0,
    envMapIntensity: 0.9,
  },
  byName: [
    {
      pattern: /specular/i,
      treatment: {
        roughnessMap: 'glassBlue',
        metalness: 0.7,
        roughness: 0.22,
        envMapIntensity: 1.6,
      },
    },
  ],
};

/** Space-kit aircraft/buildings: UVs exist, textures don't; de-black the metal. */
const SPACE_HULL: KeyTreatment = {
  default: {
    map: 'paintedMetal',
    roughnessMap: 'paintedMetal',
    metalness: 0.4,
    roughness: 0.7,
    envMapIntensity: 0.9,
  },
  byName: [
    {
      // dark panel material → darker gunmetal for contrast with `metal`
      pattern: /^dark$/,
      treatment: {
        map: 'gunmetal',
        roughnessMap: 'gunmetal',
        metalness: 0.6,
        roughness: 0.7,
        envMapIntensity: 1.0,
      },
    },
    // metalRed is the authored orange accent — keep its color, tame the metal
  ],
};

/** Quaternius infantry: canvas-weave uniforms over the authored colors. */
const INFANTRY_FABRIC: KeyTreatment = {
  uvWorldScale: 1.2,
  default: { metalness: 0, roughness: 0.75, envMapIntensity: 0.4 },
  byName: [
    {
      pattern: /^(Shirt2?|Pants)$/,
      treatment: {
        map: 'canvasFabric',
        roughnessMap: 'canvasFabric',
        metalness: 0,
        roughness: 0.9,
        envMapIntensity: 0.4,
      },
    },
  ],
};

/** Sniper team: the authored uniform is light gray; remap to camo. */
const SNIPER_CAMO: KeyTreatment = {
  uvWorldScale: 1.2,
  default: { metalness: 0, roughness: 0.75, envMapIntensity: 0.4 },
  byName: [
    {
      pattern: /^(Shirt|Pants)$/,
      treatment: {
        map: 'camoGreen',
        roughnessMap: 'camoGreen',
        color: 0xffffff,
        metalness: 0,
        roughness: 0.9,
        envMapIntensity: 0.4,
      },
    },
  ],
};

/** Quaternius tank (desert tan): hull camo, gunmetal details, rubber wheels. */
const TANK_DESERT: KeyTreatment = {
  uvWorldScale: 2,
  default: { metalness: 0.1, roughness: 0.9, envMapIntensity: 0.5 },
  byName: [
    {
      pattern: /^Main_Details$/,
      treatment: {
        map: 'gunmetal',
        roughnessMap: 'gunmetal',
        color: 0xffffff,
        metalness: 0.7,
        roughness: 0.8,
        envMapIntensity: 0.9,
      },
    },
    {
      pattern: /^Main(_Dark|_Light)?$/,
      treatment: {
        map: 'camoDesert',
        roughnessMap: 'camoDesert',
        color: 0xffffff,
        metalness: 0.25,
        roughness: 0.9,
        envMapIntensity: 0.6,
      },
    },
    {
      pattern: /^Wheels$/,
      treatment: {
        map: 'tireRubber',
        roughnessMap: 'tireRubber',
        color: 0xffffff,
        metalness: 0,
        roughness: 1.0,
        envMapIntensity: 0.4,
      },
    },
  ],
};

/** Quaternius tank destroyer (olive green): same part split, green camo hull. */
const TANK_GREEN: KeyTreatment = {
  ...TANK_DESERT,
  byName: (TANK_DESERT.byName ?? []).map((rule) =>
    rule.pattern.source === '^Main(_Dark|_Light)?$'
      ? {
          ...rule,
          treatment: {
            ...rule.treatment,
            map: 'camoGreen' as SurfaceCategory,
            roughnessMap: 'camoGreen' as SurfaceCategory,
          },
        }
      : rule,
  ),
};

/**
 * Quaternius barn: wood planks under the authored red. woodPlank's linear
 * mid-tone is ~ (0.304, 0.163, 0.080); the barn's DarkRed is linear
 * (0.202, 0.0425, 0.0321), so the tint below lands the average plank on the
 * authored red while the grain keeps its variation.
 */
const BARN_RED_TINT: [number, number, number] = [0.664, 0.261, 0.401];

const BARN: KeyTreatment = {
  uvWorldScale: 2.5,
  default: { metalness: 0, roughness: 0.85, envMapIntensity: 0.4 },
  byName: [
    {
      pattern: /^(DarkRed|LightRed)$/,
      treatment: {
        map: 'woodPlank',
        roughnessMap: 'woodPlank',
        colorLinear: BARN_RED_TINT,
        metalness: 0,
        roughness: 0.9,
        envMapIntensity: 0.4,
      },
    },
  ],
};

/** Quaternius silo: galvanized bands over the authored red/white. */
const SILO: KeyTreatment = {
  uvWorldScale: 2.5,
  default: {
    map: 'hullGray',
    roughnessMap: 'hullGray',
    metalness: 0.4,
    roughness: 0.9,
    envMapIntensity: 0.8,
  },
};

/** Nature props: keep the authored colors, fix only the dead-flat shading. */
const NATURE_MINIMAL: KeyTreatment = {
  default: { metalness: 0, roughness: 0.9, envMapIntensity: 0.4 },
};
const NATURE_BUSH: KeyTreatment = {
  default: { metalness: 0, roughness: 1.0, envMapIntensity: 0.3 },
};
const NATURE_ROCK: KeyTreatment = {
  default: {
    roughnessMap: 'concrete',
    metalness: 0,
    roughness: 1.0,
    envMapIntensity: 0.4,
  },
};

// ---------------------------------------------------------------------------
// styloo "Tiny Plane Asset Pack" (workstream E, pass 2, 2026-09-30).
// The GLBs embed the pack's palette texture as baseColorTexture — these
// treatments deliberately set NO `map` (the authored liveries survive)
// and only add painted-metal roughness variation + sane PBR values.
// ---------------------------------------------------------------------------
const STYLOO_CIVIL: KeyTreatment = {
  default: {
    roughnessMap: 'paintedMetal',
    metalness: 0.3,
    roughness: 1.0,
    envMapIntensity: 0.8,
  },
};
const STYLOO_MIL: KeyTreatment = {
  default: {
    roughnessMap: 'gunmetal',
    metalness: 0.15,
    roughness: 1.0,
    envMapIntensity: 0.5,
  },
};

// ---------------------------------------------------------------------------
// The table: one row per MODEL_PATHS key (94 total).
// ---------------------------------------------------------------------------

export const KEY_TREATMENTS: Record<string, KeyTreatment> = {
  // ---- infantry (Quaternius) ----
  engineer: INFANTRY_FABRIC,
  rifles: INFANTRY_FABRIC,
  sniperTeam: SNIPER_CAMO,
  combatMedic: INFANTRY_FABRIC,
  tank: TANK_DESERT,
  tankDestroyer: TANK_GREEN,

  // ---- vehicles (Kenney colormap) ----
  hauler: { default: T.vehiclePaint },
  hq: { default: T.vehiclePaint },

  // ---- aircraft (space kit) ----
  spectre: SPACE_HULL,
  awacs: SPACE_HULL,

  // ---- ships (Kenney colormap) ----
  patrolBoat: { default: T.hull },
  missileBoat: { default: T.hull },
  fishingBoat: { default: T.hull },
  transportShip: { default: T.hull },
  commandShip: { default: T.hull },

  // ---- suburban ----
  house: { default: T.brickBld },
  school: { default: T.brickBld },
  // Workstream Z (2026-09-30): the education ladder wears the school's
  // brick treatment (Kenney suburban houses, colormap texture).
  kindergarten: { default: T.brickBld },
  college: { default: T.brickBld },

  // ---- commercial / civic ----
  apartment: { default: T.concreteBld },
  shop: { default: T.concreteBld },
  lab: { default: T.concreteBld },
  hospital: { default: T.concreteBld },
  university: { default: T.concreteBld },
  market: { default: T.concreteBld },
  aegisMain: { default: T.concreteBld },

  // ---- industrial ----
  factory: { default: T.corrugated, byName: SPECULAR_GLASS },
  barracks: { default: T.concreteBld, byName: SPECULAR_GLASS },
  // Phase 1 (veterancy): the academy hall wears the barracks treatment.
  militaryAcademy: { default: T.concreteBld, byName: SPECULAR_GLASS },
  warFactoryMain: { default: T.corrugated, byName: SPECULAR_GLASS },
  recyclingCenter: { default: T.corrugated, byName: SPECULAR_GLASS },
  navalYardHall: { default: T.corrugated, byName: SPECULAR_GLASS },
  nuclearPlantMain: { default: T.concreteBld, byName: SPECULAR_GLASS },
  desalinationHall: { default: T.concreteBld, byName: SPECULAR_GLASS },
  powerPlantMain: { default: T.concreteBld, byName: SPECULAR_GLASS },
  powerPlantChimney: { default: T.concreteBld },
  industrialStack: { default: T.concreteBld },
  waterPump: { default: T.tankMetal },
  oilRefineryTank: { default: T.tankMetal },
  industrialTank: { default: T.tankMetal },
  shipyardCrane: { default: T.craneYellow },
  navalYardCrane: { default: T.craneYellow },
  shipyardMachine: { default: T.machineDark },
  solarFarmA: SOLAR,
  solarFarmB: SOLAR,

  // ---- farm (Quaternius) ----
  farmBarn: BARN,
  farmSilo: SILO,

  // ---- space-kit structures ----
  airfieldHangar: SPACE_HULL,
  airfieldHangar2: SPACE_HULL,
  radarStation: SPACE_HULL,

  // ---- nature props ----
  propTreeOak: NATURE_MINIMAL,
  propTreeBirch: NATURE_MINIMAL,
  propTreePineTall: NATURE_MINIMAL,
  propTreePine: NATURE_MINIMAL,
  propTreeOldOak: NATURE_MINIMAL,
  propTreePoplar: NATURE_MINIMAL,
  propRockLarge: NATURE_ROCK,
  propRockTall: NATURE_ROCK,
  propRockSmall: NATURE_ROCK,
  propBushDetailed: NATURE_BUSH,
  propBushLarge: NATURE_BUSH,

  // ---- civilians (Quaternius, Phase 4 RENDER workstream A item 4) ----
  // Lazy-only pedestrian variants: same fabric treatment as the
  // infantry (matte cloth, no metal). The crowd bakes their colors to
  // vertex colors (render/people.ts); this row keeps the coverage
  // contract (every MODEL_PATHS key needs a treatment).
  personCasualMan: INFANTRY_FABRIC,
  personCasualWoman: INFANTRY_FABRIC,
  personWorker: INFANTRY_FABRIC,
  personWomanTwo: INFANTRY_FABRIC,

  // ---- styloo aircraft (workstream E, pass 2, 2026-09-30) ----
  // Palette-preserving: the authored liveries survive (see STYLOO_*).
  stylooJumbo: STYLOO_CIVIL,
  stylooAirliner: STYLOO_CIVIL,
  stylooRegional: STYLOO_CIVIL,
  stylooPatrol: STYLOO_MIL,
  stylooRecon: STYLOO_MIL,
  stylooSeaplane: STYLOO_CIVIL,
  stylooCargo: STYLOO_CIVIL,
  stylooMilCargo: STYLOO_MIL,
  stylooTanker: STYLOO_MIL,
  stylooTrainer: STYLOO_CIVIL,
  stylooReconUAV: STYLOO_MIL,
  stylooBomber: STYLOO_MIL,
  stylooArmedUAV: STYLOO_MIL,

  // ---- logistics-ship + port kitbash pieces (workstream E, pass 2) ----
  // Kenney hulls: weathered hull plates under the authored colors.
  cargoFreighterShip: { default: T.hull },
  coastGuardCutterBoat: { default: T.hull },
  cruiseLinerShip: { default: T.hull },
  yachtBoat: { default: T.hull },
  mineBuoy: { default: T.hull },
  fuelTankerHull: { default: T.hull },
  ammoShipHull: { default: T.hull },
  repairShipHull: { default: T.hull },
  minelayerHull: { default: T.hull },
  deckCrate: { default: T.hull },
  repairCrane: { default: T.hull },
  deckRowboat: { default: T.hull },
  harborCanoe: { default: T.hull },
  cargoContainerA: { default: T.hull },
  cargoContainerB: { default: T.hull },
  cargoContainerC: { default: T.hull },
};

// ---------------------------------------------------------------------------
// Application.
// ---------------------------------------------------------------------------

function applyMaterialTreatment(
  material: THREE.MeshStandardMaterial,
  treatment: MaterialTreatment,
): void {
  if (treatment.map !== undefined) {
    material.map = surfaceTexture(treatment.map);
  }
  if (treatment.roughnessMap !== undefined) {
    material.roughnessMap = surfaceRoughnessTexture(treatment.roughnessMap);
  }
  if (treatment.color !== undefined) material.color.setHex(treatment.color);
  if (treatment.colorLinear !== undefined) {
    material.color.setRGB(
      treatment.colorLinear[0],
      treatment.colorLinear[1],
      treatment.colorLinear[2],
    );
  }
  if (treatment.metalness !== undefined) material.metalness = treatment.metalness;
  if (treatment.roughness !== undefined) material.roughness = treatment.roughness;
  if (treatment.envMapIntensity !== undefined) {
    material.envMapIntensity = treatment.envMapIntensity;
  }
}

/**
 * Apply a model's surface treatment once, at load time. Mutates the
 * per-load material clones in place (the caller owns them) and assigns
 * shared texture instances — no per-model texture memory.
 *
 * Unknown keys are left completely untouched: a table gap must stay visible
 * (flat authored materials) rather than silently "fixed" with a wrong guess.
 */
export function applySurfaceTreatment(
  key: string,
  geometries: THREE.BufferGeometry[],
  materials: THREE.Material[],
): void {
  const treatment = KEY_TREATMENTS[key];
  if (!treatment) return;
  if (treatment.uvWorldScale !== undefined) {
    for (const geometry of geometries) {
      ensureBoxUVs(geometry, treatment.uvWorldScale);
    }
  }
  for (const material of materials) {
    if (!(material instanceof THREE.MeshStandardMaterial)) continue;
    const override = treatment.byName?.find((rule) =>
      rule.pattern.test(material.name ?? ''),
    )?.treatment;
    applyMaterialTreatment(material, override ?? treatment.default);
  }
}

/**
 * Surface-backed material for procedural builders: clones the shared
 * flat-shaded-capable surface material, applies the requested tint, and tags
 * it in `userData.surfaceCategory` (team-stripe convention) so tests can
 * audit that every non-emissive builder part wears a surface.
 *
 * Unlike the old `pmat()` helper this shares its diffuse/roughness textures
 * across all call sites — one clone per call, zero new texture memory.
 */
export function surfaceMaterial(
  category: SurfaceCategory,
  opts: {
    color?: number;
    emissive?: number;
    emissiveIntensity?: number;
    flatShading?: boolean;
  } = {},
): THREE.MeshStandardMaterial {
  const material = SURFACE_MATERIALS[category].clone();
  if (opts.color !== undefined) material.color.setHex(opts.color);
  if (opts.emissive !== undefined) {
    material.emissive.setHex(opts.emissive);
    material.emissiveIntensity = opts.emissiveIntensity ?? 1;
  }
  if (opts.flatShading !== undefined) material.flatShading = opts.flatShading;
  material.userData.surfaceCategory = category;
  return material;
}
