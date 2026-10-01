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

/**
 * Minimal ambient declarations for the node builtins used by the build-time
 * portrait scripts (game/scripts/). Follows the same convention as
 * game/tests/i18n-shim.d.ts: tsconfig sets `types: []` and @types/node is
 * deliberately not a dependency, so only the APIs the scripts use are
 * declared here. These merge with the test shim's `node:fs` / `node:path` /
 * `node:url` declarations (ambient module declarations combine), adding only
 * the members the tests don't need.
 */

/** The Buffer value the scripts use (a Uint8Array at runtime). */
declare const Buffer: {
  from(arrayBuffer: ArrayBufferLike, byteOffset?: number, byteLength?: number): Uint8Array;
};

declare module 'node:path' {
  /** Path segment separator ('/' on POSIX, '\\' on Windows). */
  export const sep: string;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): URL;
}

declare module 'node:zlib' {
  export function deflateSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: Uint8Array): { digest(encoding: 'hex'): string };
  };
}
