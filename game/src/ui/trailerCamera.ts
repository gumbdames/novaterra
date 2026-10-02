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
 * NOVATERRA — ui/trailerCamera.ts — scripted trailer camera paths
 * (trailer workstream, 2026-10-01).
 *
 * Responsibilities:
 *  - Pure, headless-safe camera choreography for the trailer director
 *    (`ui/trailerDirector.ts`): camera poses (position + look-at + fov),
 *    shots as eased interpolations between anchor-relative poses, and
 *    `poseAtTick()` resolving the pose for any world tick.
 *  - Anchors ('town', 'harbor', 'freighter', 'army', 'stormTarget',
 *    'mapCenter') are resolved by the director from live world state —
 *    this module never touches the sim, so moving subjects (a sailing
 *    freighter, a marching army) can be tracked deterministically: the
 *    pose is a pure function of (tick, anchors).
 *  - Easing: 'linear' for constant-speed orbits/sweeps, 'smooth'
 *    (smoothstep) for gentle shot starts/ends, 'inOut' (cubic) for
 *    dramatic push-ins.
 *
 * The DOM seam (`ui/trailerMode.ts`) applies a resolved pose to the
 * three.js camera; the RTS orbit state in `ui/camera.ts` is untouched —
 * the trailer camera is a separate cinematic controller, not a player
 * camera.
 */

/** A 3D point in world units. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Full cinematic camera pose: position + look-at target + fov (degrees). */
export interface CamPose {
  pos: Vec3;
  look: Vec3;
  fov: number;
}

/**
 * Anchor names the trailer director resolves from live world state each
 * tick. 'freighter' falls back to 'harbor' and 'army' to 'town' when the
 * subject does not exist yet — the director guarantees every anchor
 * always resolves to a real position.
 */
export type TrailerAnchorName =
  | 'town'
  | 'harbor'
  | 'freighter'
  | 'army'
  | 'stormTarget'
  | 'mapCenter';

/** Resolved anchor positions (ground-level y; shots add their own height). */
export type TrailerAnchors = Record<TrailerAnchorName, Vec3>;

/** A camera pose builder: pure function of the resolved anchors. */
export type PoseFn = (a: TrailerAnchors) => CamPose;

/** Easing curves for shot interpolation. */
export type TrailerEase = 'linear' | 'smooth' | 'inOut';

/**
 * One camera shot: an eased interpolation from one anchor-relative pose
 * to another over [startTick, endTick). Shots must tile the trailer
 * without gaps; `poseAtTick` clamps out-of-range ticks to the nearest
 * shot edge.
 */
export interface TrailerShot {
  startTick: number;
  endTick: number;
  from: PoseFn;
  to: PoseFn;
  ease: TrailerEase;
}

/**
 * Build a pose at a fixed offset from an anchor: the camera sits at
 * anchor + (dx, dy, dz) and looks at anchor + (0, lookDy, 0). Every
 * trailer shot composes from this — orbits are two anchored poses at
 * different angles with 'linear' easing, push-ins are two anchored
 * poses at different radii with 'inOut'.
 */
export function anchoredPose(
  anchor: TrailerAnchorName,
  offset: { dx: number; dy: number; dz: number },
  lookDy: number,
  fov: number,
): PoseFn {
  return (a: TrailerAnchors): CamPose => {
    const p = a[anchor];
    return {
      pos: { x: p.x + offset.dx, y: p.y + offset.dy, z: p.z + offset.dz },
      look: { x: p.x, y: p.y + lookDy, z: p.z },
      fov,
    };
  };
}

/** Ease a 0..1 shot parameter. Pure; clamped for safety. */
export function easeFactor(ease: TrailerEase, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (ease) {
    case 'linear':
      return x;
    case 'smooth':
      return x * x * (3 - 2 * x);
    case 'inOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
  }
}

/** Linear interpolation between two numbers. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate every pose component. Pure. */
export function lerpPose(from: CamPose, to: CamPose, t: number): CamPose {
  return {
    pos: {
      x: lerp(from.pos.x, to.pos.x, t),
      y: lerp(from.pos.y, to.pos.y, t),
      z: lerp(from.pos.z, to.pos.z, t),
    },
    look: {
      x: lerp(from.look.x, to.look.x, t),
      y: lerp(from.look.y, to.look.y, t),
      z: lerp(from.look.z, to.look.z, t),
    },
    fov: lerp(from.fov, to.fov, t),
  };
}

/**
 * Resolve the camera pose for a world tick. Finds the shot covering
 * `tick`, eases its local parameter, and interpolates. Ticks before
 * the first shot hold its opening pose; ticks past the last shot hold
 * its closing pose (the trailer's end card plays over a held frame).
 * Pure — the same (tick, anchors) always yields the same pose.
 */
export function poseAtTick(
  shots: TrailerShot[],
  tick: number,
  anchors: TrailerAnchors,
): CamPose {
  const first = shots[0];
  // B27: no `!` — an empty shot list throws, same as before.
  if (first === undefined) {
    throw new Error('poseAtTick: no shots defined');
  }
  if (tick <= first.startTick) return first.from(anchors);
  // B27: no `!` — the empty check above guarantees a last shot; unreachable.
  const last = shots[shots.length - 1];
  if (last === undefined) {
    throw new Error('poseAtTick: no shots defined');
  }
  if (tick >= last.endTick) return last.to(anchors);
  for (const shot of shots) {
    if (tick >= shot.startTick && tick < shot.endTick) {
      const span = shot.endTick - shot.startTick;
      const t = span > 0 ? (tick - shot.startTick) / span : 0;
      return lerpPose(shot.from(anchors), shot.to(anchors), easeFactor(shot.ease, t));
    }
  }
  // Gap between shots (should not happen — shots tile): hold the last
  // shot that already ended.
  let held = first;
  for (const shot of shots) {
    if (shot.startTick <= tick) held = shot;
  }
  return held.to(anchors);
}

/**
 * Sanity-check a shot list: sorted, non-overlapping, gapless, positive
 * spans. Returns human-readable problems (empty = clean). Used by the
 * trailer's unit tests to pin the shipped shot schedule.
 */
export function validateShots(shots: TrailerShot[]): string[] {
  const problems: string[] = [];
  for (let i = 0; i < shots.length; i += 1) {
    // B27: no `!` — the loop bound keeps i in range; unreachable.
    const s = shots[i];
    if (s === undefined) continue;
    if (s.endTick <= s.startTick) {
      problems.push(`shot ${i}: endTick ${s.endTick} <= startTick ${s.startTick}`);
    }
    if (i > 0) {
      // B27: no `!` — i > 0 keeps i - 1 in range; unreachable.
      const prev = shots[i - 1];
      if (prev === undefined) continue;
      if (s.startTick < prev.endTick) {
        problems.push(`shot ${i}: overlaps previous shot (${s.startTick} < ${prev.endTick})`);
      } else if (s.startTick > prev.endTick) {
        problems.push(`shot ${i}: gap after previous shot (${prev.endTick}..${s.startTick})`);
      }
    }
  }
  return problems;
}
