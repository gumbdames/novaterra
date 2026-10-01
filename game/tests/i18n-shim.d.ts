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
 * Ambient declarations for the node builtins used by the test suite
 * (ui.i18n.test.ts, render.boot-budget.test.ts, ...). tsconfig sets
 * `types: []` and @types/node is not a dependency, so only the APIs
 * the tests use are declared here.
 */

/** Minimal stand-in for the Buffer values the tests pass around. */
interface TestBuffer {
  length: number;
  toString(encoding?: string): string;
}

declare module 'node:fs' {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): TestBuffer;
  export function statSync(path: string): { isDirectory(): boolean; size: number };
  export function existsSync(path: string): boolean;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}
declare module 'node:zlib' {
  export function gzipSync(buf: TestBuffer, options?: { level?: number }): TestBuffer;
}
