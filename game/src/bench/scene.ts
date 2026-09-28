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
 * NOVATERRA — benchmark scene (Phase 1, step 2).
 *
 * Builds a scene resembling the game's planned look: large ground plane
 * with grid, gradient sky, hemisphere + directional lighting, and two
 * InstancedMeshes (buildings + units) whose instance transforms come from
 * the deterministic layout module. Runs in the browser only — the module
 * is import-safe under Node (no DOM access at import time) but
 * buildBenchScene() needs a real document.
 *
 * Perf notes: one draw call per entity type (the instancing strategy from
 * docs/research/tech-stack.md §3). Instanced meshes are NOT frustum-culled
 * so the sweep measures full throughput with no popping mid-orbit; the
 * real game will cull per chunk (ARCHITECTURE.md §6).
 */
import * as THREE from 'three';

import {
  BENCH_GROUND_SIZE,
  layoutBuildings,
  layoutUnits,
  type InstanceTransform,
} from './layout';

export interface BenchSceneHandle {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Place the camera on its slow orbit (radians). */
  setOrbitAngle(rad: number): void;
  /** Release all GPU resources (called between sweep points). */
  dispose(): void;
}

/** Turn layout transforms into one InstancedMesh over a unit box. */
function makeInstanced(
  items: InstanceTransform[],
  shadows: boolean,
): THREE.InstancedMesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    roughness: 0.85,
    metalness: 0.05,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  items.forEach((it, i) => {
    e.set(0, it.rotY, 0);
    q.setFromEuler(e);
    pos.set(it.x, it.y, it.z);
    scl.set(it.sx, it.sy, it.sz);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
    const [r, g, b] = it.color;
    col.setRGB(r, g, b);
    mesh.setColorAt(i, col);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) {
    mesh.instanceColor.needsUpdate = true;
  }

  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  // All-or-nothing culling would pop mid-orbit; measure full throughput.
  mesh.frustumCulled = false;
  return mesh;
}

/** Gradient sky baked to a canvas texture (same recipe as the scaffold). */
function makeSkyTexture(): THREE.CanvasTexture {
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4;
  skyCanvas.height = 256;
  const ctx = skyCanvas.getContext('2d');
  if (ctx === null) {
    throw new Error('bench scene: 2d canvas context unavailable');
  }
  const gradient = ctx.createLinearGradient(0, 0, 0, 256);
  gradient.addColorStop(0.0, '#0b1e3a'); // zenith
  gradient.addColorStop(0.55, '#274b73'); // horizon glow
  gradient.addColorStop(0.62, '#d8a35f'); // sunset band
  gradient.addColorStop(1.0, '#1a2230'); // below horizon
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 4, 256);
  const skyTexture = new THREE.CanvasTexture(skyCanvas);
  skyTexture.colorSpace = THREE.SRGBColorSpace;
  return skyTexture;
}

export function buildBenchScene(
  buildingCount: number,
  unitCount: number,
  shadows: boolean,
): BenchSceneHandle {
  const scene = new THREE.Scene();
  const disposables: Array<{ dispose(): void }> = [];

  const skyTexture = makeSkyTexture();
  disposables.push(skyTexture);
  scene.background = skyTexture;
  scene.fog = new THREE.Fog(0x1a2230, 150, 700);

  // Lighting: hemisphere for sky bounce + one directional "sun".
  scene.add(new THREE.HemisphereLight(0x9db8dd, 0x1c2420, 0.9));
  const sun = new THREE.DirectionalLight(0xffe0b3, 1.6);
  sun.position.set(140, 200, 80);
  if (shadows) {
    // 2048² directional shadow map — the locked default tier
    // (ARCHITECTURE.md §6). Disable with ?shadows=0 for A/B runs.
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = BENCH_GROUND_SIZE / 2;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 600;
    sun.shadow.bias = -0.0005;
  }
  scene.add(sun);
  scene.add(sun.target);

  // Ground: dark plane + grid.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(BENCH_GROUND_SIZE, BENCH_GROUND_SIZE),
    new THREE.MeshStandardMaterial({ color: 0x11161d, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = shadows;
  scene.add(ground);

  const grid = new THREE.GridHelper(
    BENCH_GROUND_SIZE,
    60,
    0x57c8ff,
    0x223448,
  );
  grid.position.y = 0.02;
  const gridMaterial = grid.material as THREE.Material;
  gridMaterial.transparent = true;
  gridMaterial.opacity = 0.35;
  scene.add(grid);

  // The two instanced entity types.
  const buildings = makeInstanced(layoutBuildings(buildingCount), shadows);
  const units = makeInstanced(layoutUnits(unitCount), shadows);
  scene.add(buildings);
  scene.add(units);

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    2000,
  );

  const setOrbitAngle = (rad: number): void => {
    const radius = 150;
    camera.position.set(
      Math.sin(rad) * radius,
      70,
      Math.cos(rad) * radius,
    );
    camera.lookAt(0, 10, 0);
  };
  setOrbitAngle(0);

  const dispose = (): void => {
    scene.traverse((obj) => {
      if (obj instanceof THREE.InstancedMesh) {
        // Releases instance attributes as well as geometry/material.
        obj.dispose();
      } else if (
        obj instanceof THREE.Mesh ||
        obj instanceof THREE.LineSegments
      ) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) {
          material.forEach((mm) => mm.dispose());
        } else {
          material.dispose();
        }
      }
    });
    disposables.forEach((d) => d.dispose());
    scene.clear();
  };

  return { scene, camera, setOrbitAngle, dispose };
}
