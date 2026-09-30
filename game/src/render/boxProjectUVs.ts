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
 * Box-projection UVs for BufferGeometry lacking TEXCOORD_0 (0.1 Alpha).
 *
 * Procedural gap models (`proceduralModels.ts`) and normalized GLB geometry
 * often carry no UVs; this module generates them by projecting each vertex
 * onto the plane of its dominant normal axis — the standard box/cube
 * projection:
 *
 * - |nx| dominant → uv = (z, y)
 * - |ny| dominant → uv = (x, z)
 * - |nz| dominant → uv = (x, y)
 *
 * UVs are emitted in TILE units (worldCoord / worldScale), so a
 * `worldScale` of 2 means one texture tile per 2 world units — texel density
 * stays consistent across models of any size when the same worldScale is
 * used. Pair with `RepeatWrapping` (which the surface textures use).
 *
 * Pure and deterministic: same geometry + worldScale → identical UVs on
 * every platform. A missing or non-finite normal falls back to the XZ
 * (up-facing) projection, so the output never contains NaNs.
 */
import * as THREE from 'three';

/**
 * Compute box-projection UVs and write them into the geometry's `uv`
 * attribute (overwriting any existing one). Returns the new attribute.
 *
 * @param geometry   Must carry a `position` attribute; `normal` is optional.
 * @param worldScale World units per texture tile; must be finite and > 0.
 */
export function boxProjectUVs(
  geometry: THREE.BufferGeometry,
  worldScale = 2,
): THREE.BufferAttribute {
  if (!Number.isFinite(worldScale) || worldScale <= 0) {
    throw new Error(`boxProjectUVs: worldScale must be finite and > 0 (got ${worldScale})`);
  }
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) {
    throw new Error('boxProjectUVs: geometry has no position attribute');
  }
  const nor = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    let nx = 0;
    let ny = 1;
    let nz = 0;
    if (nor) {
      const qx = nor.getX(i);
      const qy = nor.getY(i);
      const qz = nor.getZ(i);
      // Non-finite normals (broken geometry) fall back to up-facing.
      if (Number.isFinite(qx) && Number.isFinite(qy) && Number.isFinite(qz)) {
        nx = qx;
        ny = qy;
        nz = qz;
      }
    }
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let u: number;
    let v: number;
    if (ax >= ay && ax >= az) {
      u = z;
      v = y;
    } else if (ay >= az) {
      u = x;
      v = z;
    } else {
      u = x;
      v = y;
    }
    uv[2 * i] = u / worldScale;
    uv[2 * i + 1] = v / worldScale;
  }
  const attr = new THREE.BufferAttribute(uv, 2);
  geometry.setAttribute('uv', attr);
  return attr;
}

/**
 * Box-project UVs only when the geometry has no usable `uv` attribute yet.
 * Convenience for the integration pass over mixed GLB/procedural geometry.
 */
export function ensureBoxUVs(
  geometry: THREE.BufferGeometry,
  worldScale = 2,
): THREE.BufferAttribute | null {
  if (geometry.getAttribute('uv')) return null;
  return boxProjectUVs(geometry, worldScale);
}
