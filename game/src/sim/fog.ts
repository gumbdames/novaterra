/**
 * NOVATERRA — sim/fog.ts — player fog of war (fun-audit C3, 2026-10-02).
 *
 * The player no longer sees the whole map by default. Each owner gets an
 * `explored` cell grid (unexplored = black shroud, explored-but-unseen =
 * dimmed, currently visible = clear). Visibility reuses the sim's own
 * sight model (`getSightDiscs` in sim/ai.ts — the same discs that gate
 * `getVisibleEnemies`/`getVisibleEnemyBuildings`), so the render shroud,
 * the minimap, entity hiding, and the threat meter all agree with what
 * the AI itself can perceive. No omniscience anywhere.
 *
 * Determinism: explored is monotonic (bits only ever turn on) and the
 * update is pure arithmetic over sim state — no RNG, no banned
 * transcendentals (sqrt only). Explored is display memory: it is
 * snapshotted (save/load keeps the shroud) but NOT digested — nothing
 * in the sim reads it, so it cannot affect behavior (the economyFlows
 * precedent, sim/world.ts).
 *
 * Update cadence: every 30 ticks (the AI think cadence), plus once on
 * the first system invocation so a fresh session never opens on a
 * black map. The render side recomputes current visibility at the same
 * cadence and caches it — views stay stable between updates.
 */

import type { World } from './world';
import type { SimSystem } from './tick';
import { getSightDiscs } from './ai';

/** World units per fog cell. 512-unit map / 8 = 64x64 grid. */
export const FOG_CELL = 8;
/** Fog grid dimension (cells per side). */
export const FOG_GRID = 64;
/** Fog refresh cadence, in ticks (matches the AI think cadence). */
export const FOG_UPDATE_EVERY_TICKS = 30;

/**
 * Per-owner explored memory. Plain data — snapshotted; legacy snapshots
 * decode to a fresh (unexplored) state, no version bump (AD9).
 */
export interface FogState {
  /** World units per cell (FOG_CELL). Stored so a future cell-size change stays decodable. */
  cell: number;
  /** owner id -> row-major FOG_GRID*FOG_GRID flags (0/1). */
  explored: Record<number, number[]>;
}

/** Fresh fog state: nothing explored yet. */
export function createFogState(): FogState {
  return { cell: FOG_CELL, explored: {} };
}

/**
 * The world's fog state. Lazily creates it for hand-built worlds
 * (createWorld always sets it); creation follows the deterministic read
 * order so replays stay identical.
 */
export function getFogState(world: World): FogState {
  let f = world.fog;
  if (!f) {
    f = createFogState();
    world.fog = f;
  }
  return f;
}

/** Clamp a grid coordinate into [0, FOG_GRID). */
function clampCell(c: number): number {
  return c < 0 ? 0 : c >= FOG_GRID ? FOG_GRID - 1 : c;
}

/** Cell index for a world position. */
export function fogCellIndex(x: number, z: number): number {
  const col = clampCell(Math.floor((x + 256) / FOG_CELL));
  const row = clampCell(Math.floor((z + 256) / FOG_CELL));
  return row * FOG_GRID + col;
}

/**
 * Current visibility grid for one owner: 1 where the owner's sight
 * discs (units + building surveillance coverage) reach the cell center.
 * Pure and deterministic — the render side calls this at fog cadence.
 */
export function computeVisibleCells(world: World, owner: number): Uint8Array {
  const out = new Uint8Array(FOG_GRID * FOG_GRID);
  const discs = getSightDiscs(world, owner);
  if (discs === null) return out;
  const mark = (x: number, z: number, r2: number): void => {
    // sqrt is not a banned transcendental (B27 bans hypot/sin/cos/.../pow).
    const r = Math.sqrt(r2);
    const c0 = clampCell(Math.floor((x - r + 256) / FOG_CELL));
    const c1 = clampCell(Math.floor((x + r + 256) / FOG_CELL));
    const r0 = clampCell(Math.floor((z - r + 256) / FOG_CELL));
    const r1 = clampCell(Math.floor((z + r + 256) / FOG_CELL));
    for (let row = r0; row <= r1; row++) {
      const cz = (row + 0.5) * FOG_CELL - 256;
      const dz = cz - z;
      for (let col = c0; col <= c1; col++) {
        const cx = (col + 0.5) * FOG_CELL - 256;
        const dx = cx - x;
        if (dx * dx + dz * dz <= r2) out[row * FOG_GRID + col] = 1;
      }
    }
  };
  for (const d of discs.ownRadii) mark(d.x, d.z, d.r2);
  for (const c of discs.coverage) mark(c.x, c.z, c.radius * c.radius);
  return out;
}

/**
 * Fold current visibility into explored memory, for every player.
 * Monotonic: bits only turn on. Called by the fog system.
 */
export function updateFog(world: World): void {
  const fog = getFogState(world);
  for (const p of world.city.players) {
    const owner = p.id;
    let exp = fog.explored[owner];
    if (!exp) {
      exp = new Array<number>(FOG_GRID * FOG_GRID).fill(0);
      fog.explored[owner] = exp;
    }
    const vis = computeVisibleCells(world, owner);
    for (let i = 0; i < vis.length; i++) {
      if (vis[i] === 1) exp[i] = 1;
    }
  }
}

/** Has this owner ever seen the cell containing (x, z)? */
export function isExplored(world: World, owner: number, x: number, z: number): boolean {
  const exp = getFogState(world).explored[owner];
  if (!exp) return false;
  return (exp[fogCellIndex(x, z)] ?? 0) === 1;
}

/**
 * The fog system: refresh explored memory every FOG_UPDATE_EVERY_TICKS
 * ticks, plus once on the first invocation (priming) so a fresh session
 * opens with its starting base already explored.
 */
export function createFogSystem(): SimSystem {
  let primed = false;
  return (world: World): void => {
    if (!primed || world.tick % FOG_UPDATE_EVERY_TICKS === 0) {
      updateFog(world);
      primed = true;
    }
  };
}
