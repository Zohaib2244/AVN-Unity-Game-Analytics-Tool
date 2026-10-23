// A <details> that remembers whether it is open, per name, in one localStorage entry per `storageKey`
// (the old `mountDisclosures`): an event's panel remembers its own folds, a player's story its own.
import { useEffect, useState, type ReactElement, type ReactNode, type SyntheticEvent } from 'react';
import { storeGet, storeSet } from '@/lib/store';

type Remembered = Record<string, boolean>;

/** The remembered open state of `name` under `storageKey`, or `fallback` when it was never toggled. */
export function rememberedOpen(storageKey: string, name: string, fallback: boolean): boolean {
  const saved = storeGet<Remembered>(storageKey) || {};
  return Object.hasOwn(saved, name) ? Boolean(saved[name]) : fallback;
}

export function rememberOpen(storageKey: string, name: string, open: boolean): void {
  const saved = storeGet<Remembered>(storageKey) || {};
  if (saved[name] !== open) storeSet(storageKey, { ...saved, [name]: open });
}

export function RememberedDetails({ storageKey, name, summary, children, defaultOpen = false, className }: { storageKey: string; name: string; summary: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }): ReactElement {
  const [open, setOpen] = useState(() => rememberedOpen(storageKey, name, defaultOpen));
  // Another key (another event, another player) has its own memory: re-read it instead of carrying this one over.
  useEffect(() => { setOpen(rememberedOpen(storageKey, name, defaultOpen)); }, [storageKey, name, defaultOpen]);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    const next = event.currentTarget.open;
    setOpen(next);
    rememberOpen(storageKey, name, next);
  };
  return (
    <details className={className} data-disclosure={name} open={open} onToggle={onToggle}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
