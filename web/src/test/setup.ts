import '@testing-library/jest-dom/vitest';

// jsdom does not yet provide the browser's combined cancellation signal.
if (!AbortSignal.any) {
  AbortSignal.any = (signals: AbortSignal[]) => {
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const abort = (signal: AbortSignal) => {
      controller.abort(signal.reason);
      for (const [source, listener] of listeners) source.removeEventListener('abort', listener);
    };
    for (const signal of signals) {
      if (signal.aborted) { abort(signal); break; }
      const listener = () => abort(signal);
      listeners.set(signal, listener);
      signal.addEventListener('abort', listener, { once: true });
    }
    return controller.signal;
  };
}

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
