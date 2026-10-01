/*!
 * NOVATERRA — Copyright (C) 2026 Gumb Dames
 *
 * This file is part of NOVATERRA. NOVATERRA is free software: you can
 * redistribute it and/or modify it under the terms of the GNU Affero General
 * Public License as published by the Free Software Foundation, either version
 * 3 of the License, or (at your option) any later version.
 *
 * NOVATERRA is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

/** Minimal ambient types for the pngjs devDependency (no bundled types). */
declare module 'pngjs' {
  export class PNG {
    width: number;
    height: number;
    /** Raw RGBA bytes (a Node Buffer at runtime — a Uint8Array). */
    data: Uint8Array;
    static sync: {
      read(buffer: Uint8Array): PNG;
    };
  }
}
