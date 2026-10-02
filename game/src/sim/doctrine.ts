/**
 * NOVATERRA — sim/doctrine.ts — Republic / Kestrel doctrine asymmetry
 * (fun-audit D1, 2026-10-02).
 *
 * The design doc's C11 exists on paper: one shared base roster, with an
 * asymmetric doctrine layered on (AoE2 "positive asymmetry" — the full
 * shared tech tree stays, the strategic choice of *who to be* is real).
 *
 * Republic (balanced, defensive, tech-forward): better sensors
 * (+sight), stronger/cheaper engineers (faster build/repair aura),
 * signature Aegis Battery (theater missile defense — intercepts Storm
 * Engine strikes).
 *
 * Kestrel Directorate (aggressive armor/artillery): tougher and
 * harder-hitting armor/artillery, weaker air defense (AA vsAir
 * penalty), signature Tempest Cannon (very-long-range artillery that
 * outranges everything).
 *
 * Doctrine is per-owner sim state (`world.doctrines`, AD9:
 * snapshotted + digested, defaults to 'republic'). The stat overlays
 * hook into the existing `effective*` seams (upgrades.ts,
 * combat.ts) — the base defs never change, so the shared roster stays
 * readable and the AI (which reads through the same seams) plays its
 * doctrine automatically.
 *
 * No DOM, no three.js, no RNG — headless-safe. Deterministic: all
 * overlays are pure functions of (world, owner, def).
 */

import type { World } from './world';
import type { UnitKind } from './units';

/** The two doctrines. 'republic' is the narrative default. */
export type DoctrineId = 'republic' | 'kestrel';

export const DOCTRINE_IDS: readonly DoctrineId[] = ['republic', 'kestrel'];

/** Unit kinds whose stats the Kestrel armor/artillery overlays touch. */
export const KESTREL_ARMOR_KINDS: readonly string[] = [
  'tank',
  'tankMk2',
  'tankMk3',
  'artillery',
  'artilleryMk2',
  'artilleryMk3',
  'tempestCannon',
];

/** Unit kinds whose vsAir the Kestrel AA penalty touches. */
export const KESTREL_AA_KINDS: readonly string[] = ['aa', 'aaMk2', 'aaMk3'];

export interface DoctrineDef {
  id: DoctrineId;
  /** Display name for the menu. */
  name: string;
  /** One-line menu blurb. */
  blurb: string;
  /** Sight multiplier for all units (Republic sensors). */
  sightMult: number;
  /** Engineer training-cost multiplier (Republic cheaper). */
  engineerCostMult: number;
  /** Engineer aura construction-speed multiplier (Republic faster). */
  engineerConstructMult: number;
  /** Engineer aura repair-rate multiplier (Republic faster). */
  engineerRepairMult: number;
  /** Damage multiplier for armor/artillery kinds (Kestrel). */
  armorDamageMult: number;
  /** Max-HP multiplier for armor/artillery kinds (Kestrel). */
  armorHpMult: number;
  /** vsAir multiplier for AA kinds (Kestrel weaker air defense). */
  aaVsAirMult: number;
  /** Doctrine-exclusive signature unit. */
  signatureUnit: UnitKind;
}

export const DOCTRINES: Record<DoctrineId, DoctrineDef> = {
  republic: {
    id: 'republic',
    name: 'Republic',
    blurb: 'Balanced, defensive, tech-forward: better sensors, superior engineers, and the Aegis Battery missile shield.',
    sightMult: 1.2,
    engineerCostMult: 0.8,
    engineerConstructMult: 3,
    engineerRepairMult: 2,
    armorDamageMult: 1,
    armorHpMult: 1,
    aaVsAirMult: 1,
    signatureUnit: 'aegisBattery',
  },
  kestrel: {
    id: 'kestrel',
    name: 'Kestrel Directorate',
    blurb: 'Aggressive armor and artillery: heavier tanks, longer guns, weaker air defense. The Tempest Cannon outranges everything.',
    sightMult: 1,
    engineerCostMult: 1,
    engineerConstructMult: 2,
    engineerRepairMult: 1,
    armorDamageMult: 1.15,
    armorHpMult: 1.25,
    aaVsAirMult: 0.7,
    signatureUnit: 'tempestCannon',
  },
};

/** The doctrine playing an owner. Unset owners default to 'republic'. */
export function getDoctrine(world: World, owner: number): DoctrineId {
  return world.doctrines[owner] ?? 'republic';
}

/** Set an owner's doctrine (session setup; tick-0, never mid-game). */
export function setDoctrine(world: World, owner: number, id: DoctrineId): void {
  world.doctrines[owner] = id;
}

/** True when the unit kind is in the Kestrel armor/artillery family. */
export function isKestrelArmorKind(kind: string): boolean {
  return (KESTREL_ARMOR_KINDS as readonly string[]).includes(kind);
}

/** True when the unit kind is in the Kestrel-weakened AA family. */
export function isKestrelAaKind(kind: string): boolean {
  return (KESTREL_AA_KINDS as readonly string[]).includes(kind);
}

/**
 * Doctrine-gated National Program variants (fun-audit D1): the same
 * program choice, tuned by doctrine. Each doctrine sharpens its
 * thematic programs — the strategic layer plays differently per side.
 */
export function doctrineSightBonus(world: World, owner: number, base: number): number {
  // Republic sensor affinity: Signals Grid sees further.
  if (getDoctrine(world, owner) === 'republic') return base * 1.5;
  return base;
}

export function doctrineTaxMultiplier(world: World, owner: number, base: number): number {
  // Republic civic tech: Fiber Grid taxes better.
  if (getDoctrine(world, owner) === 'republic') return base * 1.08;
  return base;
}

export function doctrineFactoryOutput(world: World, owner: number, base: number): number {
  // Kestrel war industry: Heavy Industry outputs more.
  if (getDoctrine(world, owner) === 'kestrel') return base * (1.75 / 1.5);
  return base;
}

export function doctrineUpkeepMultiplier(world: World, owner: number, base: number): number {
  // ...at the cost of hungrier upkeep.
  if (getDoctrine(world, owner) === 'kestrel') return base * (1.35 / 1.25);
  return base;
}

export function doctrineUtilityDemand(world: World, owner: number, base: number): number {
  // Republic efficiency: Green Tech sips less.
  if (getDoctrine(world, owner) === 'republic') return base * (0.65 / 0.7);
  return base;
}

export function doctrineSpectreDamage(world: World, owner: number, base: number): number {
  // Kestrel black ops: Cyber Command hits harder.
  if (getDoctrine(world, owner) === 'kestrel') return base * (1.75 / 1.5);
  return base;
}

export function doctrineInfluenceMult(world: World, owner: number, base: number): number {
  // Republic soft power: Global Media carries further.
  if (getDoctrine(world, owner) === 'republic') return base * 1.125;
  return base;
}

export function doctrineArsenalDamage(world: World, owner: number, base: number): number {
  // Kestrel arsenal doctrine: the Arsenal Program's damage edge grows.
  if (getDoctrine(world, owner) === 'kestrel') return base * (1.4 / 1.25);
  return base;
}

export function doctrineManpowerCost(world: World, owner: number, base: number): number {
  // ...and its manpower discount deepens.
  if (getDoctrine(world, owner) === 'kestrel') return base * (0.65 / 0.7);
  return base;
}

/** Type guard for untrusted doctrine ids (menu / save data). */
export function isDoctrineId(value: unknown): value is DoctrineId {
  return value === 'republic' || value === 'kestrel';
}

/**
 * Training-cost multiplier for a unit kind under an owner's doctrine.
 * Only the Republic engineer discount exists today (×0.8) — the seam
 * is here so future doctrine cost tweaks don't touch the validators.
 * Costs are rounded by the caller (Math.round — exact, deterministic).
 */
export function doctrineTrainCostMult(world: World, owner: number, kind: string): number {
  if (kind === 'engineer' && getDoctrine(world, owner) === 'republic') {
    return DOCTRINES.republic.engineerCostMult;
  }
  return 1;
}
