// A panel that folds down to its header, with a one-line note beside it while folded. Remembered per game.
import { useState, type ReactElement, type ReactNode } from 'react';
import { storeGet, storeSet } from '@/lib/store';
import { Ico } from './icons';

export function useCollapsed(game: { id: string }, name: string): [boolean, (collapsed: boolean) => void] {
  const key = `avn-collapsed-${game.id}`;
  const [collapsed, setCollapsed] = useState<boolean>(() => Boolean((storeGet<Record<string, boolean>>(key) || {})[name]));
  const set = (value: boolean) => { setCollapsed(value); storeSet(key, { ...(storeGet<Record<string, boolean>>(key) || {}), [name]: value }); };
  return [collapsed, set];
}

/** `header` is the panel's header content (title and subtitle); `note` shows beside it while folded. */
export function CollapsiblePanel({ game, name, header, note, actions, children, className = '', id }: { game: { id: string }; name: string; header: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }): ReactElement {
  const [collapsed, setCollapsed] = useCollapsed(game, name);
  return (
    <section className={`panel ${collapsed ? 'collapsed' : ''} ${className}`} id={id}>
      <div className="panel-header">
        <button type="button" className="icon-button collapse-toggle" aria-expanded={!collapsed} title={collapsed ? 'Expand' : 'Collapse'} aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed(!collapsed)}><Ico name="chevron" size={16} /></button>
        {header}
        {actions}
        <span className="collapse-note muted">{collapsed ? note : null}</span>
      </div>
      {children}
    </section>
  );
}
