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
 * NOVATERRA — ui/menuScene.ts — shared menu/backdrop scene base
 * (trailer workstream, 2026-10-01; extracted from main.ts).
 *
 * Responsibilities:
 *  - Build the menu scene base: gradient sky, fog, lights, environment
 *    lighting — no terrain. The living menu demo, the static fallback,
 *    and the trailer mode each attach their own terrain view; entity
 *    views ride on it via EntityRenderer's `terrain` option.
 *  - One shared builder so the menu and the trailer render the same
 *    sky/lighting (the trailer must look like the game).
 *
 * DOM + three.js; never imported by headless tests.
 */

import * as THREE from 'three';
import { applyEnvironmentLighting } from '../render/renderer';

/**
 * Menu scene base: gradient sky, fog, lights, environment lighting —
 * no terrain. Callers attach their own terrain view.
 */
export function buildMenuScene(): THREE.Scene {
  const scene = new THREE.Scene();

  // Gradient sky baked to a canvas texture (cheap, no shader yet).
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = 4;
  skyCanvas.height = 256;
  const ctx = skyCanvas.getContext('2d');
  if (ctx === null) {
    throw new Error('menu scene: 2d canvas context unavailable');
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
  scene.background = skyTexture;
  scene.fog = new THREE.Fog(0x1a2230, 320, 1150);

  // Lighting: hemisphere for sky bounce + one directional "sun" (the key
  // light), plus the shared procedural environment map so PBR metals on
  // entity views shade correctly (see render/renderer.ts).
  scene.add(new THREE.HemisphereLight(0x9db8dd, 0x1c2420, 0.9));
  const sun = new THREE.DirectionalLight(0xffe0b3, 1.6);
  sun.position.set(80, 120, 40);
  scene.add(sun);
  applyEnvironmentLighting(scene);

  return scene;
}
