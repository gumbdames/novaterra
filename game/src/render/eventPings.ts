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
 * NOVATERRA — render/eventPings.ts — off-screen event pings (0.1 Alpha).
 *
 * Fun-audit B5 (2026-10-02): the player hears something happened but
 * can't see WHERE — the "silent training" and "where am I being hit"
 * gaps. A minimal pooled marker system fed from the audio-poll events
 * the game already computes (`AudioPollEvents` carries world positions):
 *
 * - under attack → red ping at the damage position (`damagePositions`);
 * - building complete → soft green ping, friendly only (`buildsComplete`);
 * - unit trained → subtle white ping at the new unit (`trainedPositions`).
 *
 * Markers that fall off-screen clamp to the screen edge so the player
 * gets a direction, not just a disappearance. Per-class throttle (one
 * ping per class per few seconds) keeps late-game wars from becoming
 * fireworks. This also resolves A5 (the stale "selection ping carries
 * the location" comment in game.ts is deleted with this change).
 *
 * The render/AGENTS.md pattern: pure, Node-testable logic
 * (`PingDirector` — throttle + pool slots + expiry; `projectPing` —
 * world→screen math with an injectable projector) plus a thin DOM
 * shell (`EventPings`). No three.js at module scope — the projector
 * is injected by the caller (game.ts) so this module stays import-safe
 * under Node. All timing is caller-injected `nowMs` (UI layer, may be
 * wall clock — pings are cosmetic, never sim).
 */

import * as THREE from 'three';

/** Ping classes — one throttle bucket each. */
export type EventPingKind = 'attack' | 'build' | 'trained';

/** Milliseconds between pings of the same class. */
export const PING_THROTTLE_MS = 3000;
/** How long a ping stays on screen. */
export const PING_TTL_MS = 2200;
/** Pool size — exhaustion drops (never allocates). */
export const PING_POOL_SIZE = 12;

/** A placed ping: world position + birth time. */
export interface PlacedPing {
  kind: EventPingKind;
  x: number;
  z: number;
  bornAt: number;
}

/**
 * Pure ping state machine: per-class throttling, a fixed pool of
 * slots, TTL expiry. No DOM, no three.js — fully headless-testable.
 * The clock is injected (UI wall clock in production).
 */
export class PingDirector {
  private readonly slots: Array<PlacedPing | null>;
  private readonly lastAt = new Map<EventPingKind, number>();
  private readonly nowMs: () => number;

  constructor(poolSize: number = PING_POOL_SIZE, nowMs: () => number = () => performance.now()) {
    this.slots = new Array<PlacedPing | null>(poolSize).fill(null);
    this.nowMs = nowMs;
  }

  /**
   * Request a ping. Returns the placed ping, or null when throttled
   * (same class pinged within PING_THROTTLE_MS) or the pool is full.
   */
  request(kind: EventPingKind, x: number, z: number): PlacedPing | null {
    const now = this.nowMs();
    const last = this.lastAt.get(kind);
    if (last !== undefined && now - last < PING_THROTTLE_MS) return null;
    const slot = this.slots.find((s) => s === null);
    if (slot === undefined) return null;
    const ping: PlacedPing = { kind, x, z, bornAt: now };
    this.slots[this.slots.indexOf(slot)] = ping;
    this.lastAt.set(kind, now);
    return ping;
  }

  /** Live pings (expired ones are released). */
  active(): PlacedPing[] {
    const now = this.nowMs();
    const out: PlacedPing[] = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s: PlacedPing | null | undefined = this.slots[i];
      if (s === null || s === undefined) continue;
      if (now - s.bornAt >= PING_TTL_MS) {
        this.slots[i] = null;
        continue;
      }
      out.push(s);
    }
    return out;
  }
}

/**
 * World → screen projection for one ping. `project` maps world (x, y, z)
 * to NDC (nx, ny) plus a behind-camera flag — injected so the math is
 * testable without three.js. Off-screen pings clamp to the screen edge
 * (with a margin) and report `onScreen: false` so the shell can render
 * the edge style.
 */
export function projectPing(
  x: number,
  z: number,
  project: (x: number, y: number, z: number) => { nx: number; ny: number; behind: boolean },
  width: number,
  height: number,
): { sx: number; sy: number; onScreen: boolean } {
  const { nx, ny, behind } = project(x, 2, z);
  const onScreen = !behind && Math.abs(nx) <= 1 && Math.abs(ny) <= 1;
  // Clamp to the edge with a small margin — the marker becomes a
  // direction indicator instead of vanishing.
  const m = 0.92;
  const cx = Math.max(-m, Math.min(m, nx));
  const cy = Math.max(-m, Math.min(m, ny));
  return {
    sx: (cx * 0.5 + 0.5) * width,
    sy: (-cy * 0.5 + 0.5) * height,
    onScreen,
  };
}

/**
 * The three.js projector for `projectPing`: NDC via Vector3.project,
 * behind-camera detected in view space (camera looks down −z).
 */
export function threeProjector(
  camera: THREE.PerspectiveCamera,
): (x: number, y: number, z: number) => { nx: number; ny: number; behind: boolean } {
  const v = new THREE.Vector3();
  const view = new THREE.Vector3();
  return (x, y, z) => {
    v.set(x, y, z);
    view.copy(v).applyMatrix4(camera.matrixWorldInverse);
    const behind = view.z >= 0;
    v.project(camera);
    return { nx: behind ? -v.x : v.x, ny: behind ? -v.y : v.y, behind };
  };
}

/**
 * The DOM shell: a pool of pulsing marker divs, positioned every frame
 * from the director's live pings. Browser-only (constructed by game.ts).
 */
export class EventPings {
  private readonly director: PingDirector;
  private readonly pool: HTMLElement[] = [];
  private readonly project: (x: number, y: number, z: number) => { nx: number; ny: number; behind: boolean };

  constructor(
    parent: HTMLElement,
    project: (x: number, y: number, z: number) => { nx: number; ny: number; behind: boolean },
    director: PingDirector = new PingDirector(),
  ) {
    this.project = project;
    this.director = director;
    for (let i = 0; i < PING_POOL_SIZE; i++) {
      const d = document.createElement('div');
      d.className = 'event-ping';
      d.style.display = 'none';
      parent.append(d);
      this.pool.push(d);
    }
  }

  /** Request a ping (throttled per class by the director). */
  ping(kind: EventPingKind, x: number, z: number): void {
    this.director.request(kind, x, z);
  }

  /** Reposition live markers; call every frame. */
  update(width: number, height: number): void {
    const live = this.director.active();
    // Map live pings to pool divs in order; hide the rest.
    let i = 0;
    for (const p of live) {
      const d = this.pool[i++];
      if (d === undefined) break;
      const { sx, sy, onScreen } = projectPing(p.x, p.z, this.project, width, height);
      d.className = `event-ping event-ping-${p.kind}${onScreen ? '' : ' event-ping-edge'}`;
      d.style.display = '';
      d.style.left = `${sx.toFixed(1)}px`;
      d.style.top = `${sy.toFixed(1)}px`;
    }
    for (; i < this.pool.length; i++) {
      const d = this.pool[i];
      if (d !== undefined) d.style.display = 'none';
    }
  }

  dispose(): void {
    for (const d of this.pool) d.remove();
    this.pool.length = 0;
  }
}
