// Small things remembered in this browser (filters per game, folded panels, theme).
import { useCallback, useState } from 'react';

export function storeGet<T = unknown>(key: string): T | null {
  try { const raw = localStorage.getItem(key); return raw == null ? null : (JSON.parse(raw) as T); } catch { return null; }
}
export function storeSet(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
export function storeRemove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

/** useState backed by localStorage (JSON). */
export function useStored<T>(key: string, initial: T): [T, (value: T | ((previous: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => { const saved = storeGet<T>(key); return saved == null ? initial : saved; });
  const set = useCallback((next: T | ((previous: T) => T)) => {
    setValue((previous) => { const resolved = typeof next === 'function' ? (next as (p: T) => T)(previous) : next; storeSet(key, resolved); return resolved; });
  }, [key]);
  return [value, set];
}

/** Downloads rows as a CSV file. */
export function downloadCSV(name: string, rows: Array<Array<string | number | null | undefined>>): void {
  const csv = rows.map((row) => row.map((cell) => (/[",\n]/.test(String(cell ?? '')) ? `"${String(cell).replace(/"/g, '""')}"` : String(cell ?? ''))).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const anchor = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/** Copies text, telling the caller whether the browser allowed it. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
