import '@testing-library/jest-dom/vitest';

// jsdom has no matchMedia; the motion helpers and theme code ask for it.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false }) as MediaQueryList;
}

// Node 22+ ships an experimental global localStorage that is undefined without --localstorage-file,
// and it shadows jsdom's. Use an in-memory Storage so the code under test sees a working localStorage.
{
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => (values.has(key) ? values.get(key)! : null),
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}
