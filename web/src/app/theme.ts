// Theme, palette and density live on <html> (set before first paint by public/theme.js, same keys as before).
import { useSyncExternalStore } from 'react';

type AvnTheme = {
  theme(): 'dark' | 'light'; palette(): string; density(): 'roomy' | 'compact';
  setTheme(value: string): void; setPalette(value: string): void; setDensity(value: string): void;
};
declare global { interface Window { avnTheme?: AvnTheme } }

export const PALETTES = ['nutmeg', 'slate', 'moss', 'hibiscus', 'white', 'chiral', 'dora'] as const;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
const root = () => document.documentElement;

function fallback(): AvnTheme {
  return {
    theme: () => (root().getAttribute('data-theme') === 'light' ? 'light' : 'dark'),
    palette: () => root().getAttribute('data-palette') || 'nutmeg',
    density: () => (root().getAttribute('data-density') === 'compact' ? 'compact' : 'roomy'),
    setTheme: (value) => root().setAttribute('data-theme', value),
    setPalette: (value) => (value === 'nutmeg' ? root().removeAttribute('data-palette') : root().setAttribute('data-palette', value)),
    setDensity: (value) => root().setAttribute('data-density', value),
  };
}
const api = (): AvnTheme => window.avnTheme ?? fallback();

export const themeStore = {
  theme: () => api().theme(),
  palette: () => api().palette(),
  density: () => api().density(),
  setTheme(value: 'dark' | 'light') { api().setTheme(value); emit(); },
  toggleTheme() { themeStore.setTheme(api().theme() === 'light' ? 'dark' : 'light'); },
  setPalette(value: string) { api().setPalette(value); emit(); },
  setDensity(value: 'roomy' | 'compact') { api().setDensity(value); emit(); },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

const snapshot = () => `${themeStore.theme()}|${themeStore.palette()}|${themeStore.density()}`;
export function useTheme() {
  const value = useSyncExternalStore(themeStore.subscribe, snapshot, snapshot);
  const [theme, palette, density] = value.split('|') as ['dark' | 'light', string, 'roomy' | 'compact'];
  return { theme, palette, density, setTheme: themeStore.setTheme, toggleTheme: themeStore.toggleTheme, setPalette: themeStore.setPalette, setDensity: themeStore.setDensity };
}

export const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
