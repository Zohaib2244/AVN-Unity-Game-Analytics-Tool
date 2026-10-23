// `<details>` sections that remember whether they were open (the old `mountDisclosures`): one localStorage
// key per timeline (`avn-raw-disclosures-<game>-<player>`), one entry per section name.
import { useCallback, useEffect, useState, type DetailsHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import { storeGet, storeSet } from '@/lib/store';

export type Disclosures = { isOpen: (name: string, fallback: boolean) => boolean; set: (name: string, open: boolean) => void };

export function useDisclosures(storageKey: string): Disclosures {
  const [state, setState] = useState<Record<string, boolean>>(() => storeGet<Record<string, boolean>>(storageKey) || {});
  useEffect(() => { setState(storeGet<Record<string, boolean>>(storageKey) || {}); }, [storageKey]);
  const set = useCallback((name: string, open: boolean) => setState((previous) => {
    if (previous[name] === open) return previous;
    const next = { ...(storeGet<Record<string, boolean>>(storageKey) || {}), ...previous, [name]: open };
    storeSet(storageKey, next);
    return next;
  }), [storageKey]);
  const isOpen = useCallback((name: string, fallback: boolean) => (Object.hasOwn(state, name) ? state[name]! : fallback), [state]);
  return { isOpen, set };
}

/** A remembered `<details>`: `defaultOpen` applies until the person toggles it. */
export function Disclosure({ name, disclosures, defaultOpen = false, summary, className, summaryClassName, children, ...rest }: { name: string; disclosures: Disclosures; defaultOpen?: boolean; summary: ReactNode; className?: string; summaryClassName?: string; children: ReactNode } & Omit<DetailsHTMLAttributes<HTMLDetailsElement>, 'open' | 'onToggle'>): ReactElement {
  const open = disclosures.isOpen(name, defaultOpen);
  return (
    <details className={className} data-disclosure={name} open={open} onToggle={(event) => { const next = event.currentTarget.open; if (next !== open) disclosures.set(name, next); }} {...rest}>
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}
