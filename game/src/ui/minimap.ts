/**
 * Minimap (roadmap B12) — a 176px 2D-canvas tactical overview in the
 * bottom-right of the HUD: terrain relief, every own unit/building as a
 * team-colored dot, the camera viewport box, and click/drag-to-jump.
 *
 * Fog-of-war honesty: rival dots come from the sim's own sight model
 * (`getVisibleEnemies` / `getVisibleEnemyBuildings`) — the minimap sees
 * exactly what the viewing side's units can see, never a maphack.
 * Stealthed assets (spies) stay hidden unless detected, per the intel
 * contract.
 *
 * Rendering budget: the terrain relief is painted ONCE into an offscreen
 * layer (terrain never changes mid-game); each repaint blits that layer
 * and draws only the dots + viewport box. Repaints are throttled to
 * 5 Hz — dots don't need frame-rate freshness.
 *
 * The pure helpers (worldToMinimap, minimapToWorld, terrainMinimapColor,
 * teamDotColor, collectMinimapDots) are DOM-free and headless-testable;
 * the Minimap class below is browser-only (constructed by the HUD).
 */

import type { World } from '../sim/world';
import { heightAt, type TerrainData } from '../sim/terrain';
import { getVisibleEnemies, getVisibleEnemyBuildings } from '../sim/ai';
import { FOG_GRID } from '../sim/fog';
import { buildingCenterWorld } from '../sim/intel';
import { HUMAN_PLAYER_ID } from './session';
import { STRINGS, loc } from './strings';

/** Canvas edge length in CSS pixels. */
export const MINIMAP_SIZE_PX = 176;
/** Terrain relief samples per side for the cached static layer. */
export const MINIMAP_TERRAIN_SAMPLES = 128;
/** Minimum ms between repaints (5 Hz). */
export const MINIMAP_RENDER_INTERVAL_MS = 200;

/** What the controller passes each repaint: where the camera looks and how much ground it sees. */
export interface MinimapView {
  /** World-space camera target. */
  targetX: number;
  targetZ: number;
  /** Camera orbit angle, radians (drives the viewport box rotation). */
  yaw: number;
  /** Ground extent visible at the target plane, in world units. */
  viewW: number;
  viewH: number;
}

/** One entity dot on the minimap. */
export interface MinimapDot {
  /** Sim record id — lets the fog filter match sight-model results. */
  id: number;
  x: number;
  z: number;
  owner: number;
  building: boolean;
}

/**
 * World (x, z) in [-worldSize/2, +worldSize/2] → minimap pixel [0, sizePx].
 * Canvas y grows downward, matching +z (south).
 */
export function worldToMinimap(
  x: number,
  z: number,
  sizePx: number,
  worldSize: number,
): { px: number; py: number } {
  const half = worldSize / 2;
  return {
    px: ((x + half) / worldSize) * sizePx,
    py: ((z + half) / worldSize) * sizePx,
  };
}

/** Inverse of worldToMinimap: minimap pixel → world (x, z). */
export function minimapToWorld(
  px: number,
  py: number,
  sizePx: number,
  worldSize: number,
): { x: number; z: number } {
  const half = worldSize / 2;
  return {
    x: (px / sizePx) * worldSize - half,
    z: (py / sizePx) * worldSize - half,
  };
}

function lerpByte(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * Terrain relief color as [r, g, b]: blue water (deeper = darker),
 * green lowlands → tan hills → gray peaks. Pure — the relief palette in
 * one place so the module and its tests agree.
 */
export function terrainMinimapColor(
  height: number,
  waterLevel: number,
): [number, number, number] {
  if (height < waterLevel) {
    const depth = Math.min(1, (waterLevel - height) / 12);
    // #2a6db5 shallows → #0d2c55 deeps
    return [
      lerpByte(42, 13, depth),
      lerpByte(109, 44, depth),
      lerpByte(181, 85, depth),
    ];
  }
  const t = Math.min(1, Math.max(0, height) / 40);
  if (t < 0.5) {
    // #3d7a3d lowland green → #9a8a4a dry hills
    const k = t / 0.5;
    return [
      lerpByte(61, 154, k),
      lerpByte(122, 138, k),
      lerpByte(61, 74, k),
    ];
  }
  // #9a8a4a → #8c8c8c rock
  const k = (t - 0.5) / 0.5;
  return [
    lerpByte(154, 140, k),
    lerpByte(138, 140, k),
    lerpByte(74, 140, k),
  ];
}

/**
 * Team dot color. Mirrors the render layer's teamColors() palette
 * (human blue, rival red — orange in colorblind mode); the flag is a
 * parameter so the mapping stays headless-testable instead of reading
 * the DOM class directly.
 */
export function teamDotColor(owner: number, colorblind: boolean): string {
  // HUMAN_PLAYER_ID is 0 (ui/session.ts); the minimap's viewing side is
  // always the human player.
  if (owner === 0) return '#3aa0ff';
  return colorblind ? '#ffaa00' : '#ff5544';
}

/**
 * Every dot the minimap may draw: all of the viewing side's own units
 * and buildings (completed or still rising), plus rival units/buildings
 * the viewing side's sight model currently reveals. Pure over
 * (world, owner).
 */
export function collectMinimapDots(world: World, owner: number): MinimapDot[] {
  const dots: MinimapDot[] = [];
  for (const u of world.units) {
    if (u.hp <= 0) continue;
    dots.push({ id: u.id, x: u.x, z: u.z, owner: u.owner, building: false });
  }
  for (const b of world.city.buildings) {
    const c = buildingCenterWorld(b);
    dots.push({ id: b.id, x: c.x, z: c.z, owner: b.owner, building: true });
  }
  const seenUnits = new Set(getVisibleEnemies(world, owner).map((u) => u.id));
  const seenBuildings = new Set(
    getVisibleEnemyBuildings(world, owner).map((b) => b.id),
  );
  return dots.filter((d) => {
    if (d.owner === owner) return true;
    return d.building ? seenBuildings.has(d.id) : seenUnits.has(d.id);
  });
}

/**
 * The live minimap widget: owns its canvas, caches the static terrain
 * relief, throttles repaints to 5 Hz, and turns pointer drags into
 * camera jumps via the `onJump` callback. Browser-only.
 */
export class Minimap {
  /** Outer container appended to the HUD root (class `hud-minimap`). */
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly onJump: (x: number, z: number) => void;
  private readonly sizePx: number;
  /** Cached static terrain relief; rebuilt only when the terrain identity changes. */
  private terrainLayer: HTMLCanvasElement | null = null;
  private terrainIdentity: TerrainData | null = null;
  /** World size of the cached terrain (drives click mapping). */
  private worldSize = 0;
  private lastRender = 0;
  private dragging = false;

  constructor(
    parent: HTMLElement,
    onJump: (x: number, z: number) => void,
    sizePx = MINIMAP_SIZE_PX,
  ) {
    this.onJump = onJump;
    this.sizePx = sizePx;
    const wrap = document.createElement('div');
    wrap.className = 'hud-minimap';
    wrap.title = loc(STRINGS.hud.minimapTitle);
    const canvas = document.createElement('canvas');
    canvas.width = sizePx;
    canvas.height = sizePx;
    canvas.className = 'hud-minimap-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('minimap: 2D canvas context unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
    this.element = wrap;
    wrap.append(canvas);
    parent.append(wrap);

    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.jumpFromEvent(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) this.jumpFromEvent(e);
    });
    const stop = () => {
      this.dragging = false;
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
  }

  /** Repaint (throttled to 5 Hz). Safe to call every frame. */
  render(
    world: World,
    terrain: TerrainData | undefined,
    view: MinimapView,
    /**
     * Fun-audit C3 (2026-10-02): current visibility grid for the human
     * owner (from `computeVisibleCells`, refreshed at fog cadence by
     * the controller). Unexplored cells draw black, explored-but-unseen
     * dim — the minimap honors the same shroud as the main view.
     */
    fogCells?: Uint8Array | null,
  ): void {
    const now =
      typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this.lastRender < MINIMAP_RENDER_INTERVAL_MS) return;
    this.lastRender = now;
    if (!terrain) return;
    if (this.terrainIdentity !== terrain) {
      this.terrainLayer = this.paintTerrainLayer(terrain);
      this.terrainIdentity = terrain;
      this.worldSize = terrain.size;
    }
    const { ctx, sizePx } = this;
    ctx.clearRect(0, 0, sizePx, sizePx);
    if (this.terrainLayer) ctx.drawImage(this.terrainLayer, 0, 0);

    // Fun-audit C3: fog shroud over the terrain layer, under the dots.
    this.paintFogShroud(world, fogCells ?? null);

    const worldSize = terrain.size;
    const colorblind = document.documentElement.classList.contains('colorblind');
    for (const d of collectMinimapDots(world, HUMAN_PLAYER_ID)) {
      const { px, py } = worldToMinimap(d.x, d.z, sizePx, worldSize);
      const s = d.building ? 3 : 2;
      ctx.fillStyle = teamDotColor(d.owner, colorblind);
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
    }

    // Camera viewport box, rotated by the camera yaw. The camera sits at
    // (target + sin(yaw)·h, target + cos(yaw)·h) looking at the target, so
    // the screen-right axis in world (x, z) is (cos yaw, −sin yaw); on the
    // y-down canvas that is a clockwise rotation of −yaw.
    const { px: cx, py: cy } = worldToMinimap(view.targetX, view.targetZ, sizePx, worldSize);
    const wPx = (view.viewW / worldSize) * sizePx;
    const hPx = (view.viewH / worldSize) * sizePx;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-view.yaw);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-wPx / 2, -hPx / 2, wPx, hPx);
    ctx.restore();
  }

  /**
   * Fun-audit C3 (2026-10-02): paint the fog shroud onto the minimap
   * canvas. Unexplored cells go near-black, explored-but-unseen get a
   * dim veil; currently visible cells are untouched. No fog data (or a
   * null grid) means no shroud — the trailer and pre-fog saves render
   * exactly as before.
   */
  private paintFogShroud(world: World, fogCells: Uint8Array | null): void {
    const explored = world.fog?.explored[HUMAN_PLAYER_ID];
    if (!explored) return;
    const { ctx, sizePx } = this;
    const cellPx = sizePx / FOG_GRID;
    const n = FOG_GRID * FOG_GRID;
    for (let i = 0; i < n; i++) {
      const style = minimapFogCellStyle(
        (explored[i] ?? 0) === 1,
        fogCells !== null && (fogCells[i] ?? 0) === 1,
      );
      if (style === null) continue;
      const col = i % FOG_GRID;
      const row = Math.floor(i / FOG_GRID);
      ctx.fillStyle = style;
      ctx.fillRect(col * cellPx, row * cellPx, cellPx + 0.5, cellPx + 0.5);
    }
  }

  /** Paint the static terrain relief into an offscreen canvas. */
  private paintTerrainLayer(terrain: TerrainData): HTMLCanvasElement {
    const n = MINIMAP_TERRAIN_SAMPLES;
    const layer = document.createElement('canvas');
    layer.width = n;
    layer.height = n;
    const lctx = layer.getContext('2d');
    if (!lctx) throw new Error('minimap: 2D canvas context unavailable');
    const img = lctx.createImageData(n, n);
    const half = terrain.size / 2;
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        const x = ((px + 0.5) / n) * terrain.size - half;
        const z = ((py + 0.5) / n) * terrain.size - half;
        const [r, g, b] = terrainMinimapColor(
          heightAt(terrain, x, z),
          terrain.waterLevel,
        );
        const i = (py * n + px) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    lctx.putImageData(img, 0, 0);
    // Upscale the low-res relief to the display size (smooth).
    const out = document.createElement('canvas');
    out.width = this.sizePx;
    out.height = this.sizePx;
    const octx = out.getContext('2d');
    if (!octx) throw new Error('minimap: 2D canvas context unavailable');
    octx.imageSmoothingEnabled = true;
    octx.drawImage(layer, 0, 0, this.sizePx, this.sizePx);
    return out;
  }

  /** Convert a pointer event on the canvas into a world-space camera jump. */
  private jumpFromEvent(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    // worldSize comes from the cached terrain; fall back to the standard
    // 512-cell map (2 world units per cell) before the first render.
    const worldSize = this.worldSize > 0 ? this.worldSize : 1024;
    const { x, z } = minimapToWorld(px, py, this.sizePx, worldSize);
    this.onJump(x, z);
  }

  dispose(): void {
    this.element.remove();
  }
}

/**
 * Fun-audit C3 (2026-10-02): minimap shroud styling — the single source
 * of truth for how fog reads on the tactical overview. Unexplored goes
 * near-black, explored-but-unseen gets a dim veil, visible cells are
 * untouched (null = paint nothing).
 */
export function minimapFogCellStyle(
  explored: boolean,
  visible: boolean,
): string | null {
  if (visible) return null;
  return explored ? 'rgba(4,6,14,0.55)' : 'rgba(2,2,8,0.92)';
}
