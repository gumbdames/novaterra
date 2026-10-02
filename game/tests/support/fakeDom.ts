/**
 * NOVATERRA — tests/support/fakeDom.ts — shared headless DOM (0.1 Alpha).
 *
 * The ui/ layer builds with `document.createElement` / append /
 * addEventListener / classList / style and nothing else structural, so
 * these tests pin behavior headless with a permissive fake DOM
 * (extracted from tests/ui.screens.test.ts, which pioneered the pattern).
 * Fake elements are `Record<string, unknown>` cast to `HTMLElement` at
 * the call site; listeners are dispatchable via the returned store.
 */
import { vi } from 'vitest';

/** Minimal Set-backed classList. */
export function fakeClassList(): {
  add(...c: string[]): void;
  remove(...c: string[]): void;
  toggle(c: string, force?: boolean): boolean;
  contains(c: string): boolean;
} {
  const set = new Set<string>();
  return {
    add: (...c: string[]) => void c.forEach((x) => set.add(x)),
    remove: (...c: string[]) => void c.forEach((x) => set.delete(x)),
    toggle: (c: string, force?: boolean) => {
      const on = force ?? !set.has(c);
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    contains: (c: string) => set.has(c),
  };
}

/** Permissive 2D canvas context (construction paths only): every method is
 *  a no-op, property writes are absorbed, and image-data reads get an
 *  empty-but-shaped object. */
function fake2dContext(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined; // never thenable
        return (..._args: unknown[]) => ({
          data: new Uint8ClampedArray(0),
          width: 0,
          height: 0,
        });
      },
      set: () => true,
    },
  ) as Record<string, unknown>;
}

/** A permissive fake element with dispatchable listeners. */
export function fakeElement(): Record<string, unknown> {  const listeners = new Map<string, Array<() => void>>();
  const el: Record<string, unknown> = {
    className: '',
    textContent: '',
    innerHTML: '',
    title: '',
    disabled: false,
    value: '',
    checked: false,
    style: {},
    dataset: {},
    children: [] as unknown[],
    classList: fakeClassList(),
    append: (...kids: unknown[]) => void (el.children as unknown[]).push(...kids),
    prepend: (...kids: unknown[]) =>
      void (el.children as unknown[]).unshift(...kids),
    appendChild: (kid: unknown) => {
      (el.children as unknown[]).push(kid);
      return kid;
    },
    remove: () => {},
    addEventListener: (type: string, fn: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(fn);
      listeners.set(type, arr);
    },
    removeEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    setAttribute: () => {},
    getAttribute: () => null,
    click: () => void listeners.get('click')?.forEach((fn) => fn()),
    focus: () => {},
    // Canvas: the minimap widget needs getContext('2d') at construction.
    getContext: () => fake2dContext(),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  };
  return el;
}

/**
 * Stub document / localStorage / window for headless ui/ tests.
 * Returns the backing localStorage store (cleared on install).
 */
export function installFakeDom(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('document', {
    createElement: (_tag: string) => fakeElement(),
    createTextNode: (text: string) => {
      const n = fakeElement();
      n.textContent = text;
      return n;
    },
    documentElement: { classList: fakeClassList() },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void) => 1 as unknown as number,
    clearTimeout: () => {},
  });
  return store;
}

/** A fresh fake root element for UI classes under test. */
export function fakeRoot(): HTMLElement {
  return fakeElement() as unknown as HTMLElement;
}
