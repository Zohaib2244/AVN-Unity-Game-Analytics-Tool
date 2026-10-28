// Event setup: three tabs, open any of them in any order. Add AVN Events (the standard's setup files), Fill
// Dictionary (the import flow), Mappings (which events stand for the moments the dashboards use). The tab is
// remembered per game, and the address can name it (#install, #fill, #mappings) or a mapping (?event=, ?concept=).
import { useState, type KeyboardEvent, type ReactElement } from 'react';
import { Link, useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { useRead } from '@/api';
import { gameURL, gamePath } from '@/lib/games';
import { number } from '@/lib/format';
import { storeSet, storeGet } from '@/lib/store';
import type { Game, MappingsData } from '@/lib/types';
import { Heading } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { ImportFlow } from './dictionary/ImportFlow';
import { AddEvents } from './event-setup/AddEvents';
import { Mappings } from './event-setup/Mappings';

type SetupKey = 'install' | 'fill' | 'mappings';
const SETUP_TABS: Array<[SetupKey, string, 'export' | 'edit' | 'link']> = [
  ['install', 'Add AVN Events', 'export'],
  ['fill', 'Fill Dictionary', 'edit'],
  ['mappings', 'Mappings', 'link'],
];
const isSetupKey = (value: unknown): value is SetupKey => SETUP_TABS.some(([key]) => key === value);
const MAPPING_ADDRESS = ['event', 'concept', 'version'];

export function EventSetupPage({ game }: { game: Game }): ReactElement {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;
  const hash = useRouterState({ select: (state) => state.location.hash }).replace(/^#/, '');
  const storeKey = `avn-setup-tab-${game.id}`;
  const [active, setActive] = useState<SetupKey>(() => {
    if (isSetupKey(hash)) return hash;
    if (MAPPING_ADDRESS.some((name) => name in search)) return 'mappings';
    const remembered = storeGet<unknown>(storeKey);
    return isSetupKey(remembered) ? remembered : 'install';
  });

  const version = search.version ?? '';
  const mappings = useRead<MappingsData>(`${gameURL(game)}/mappings?${new URLSearchParams({ version })}`);

  const show = (key: SetupKey) => {
    setActive(key);
    storeSet(storeKey, key);
    void navigate({ to: gamePath(game, 'event-setup'), search, hash: key, replace: true });
  };
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const keys = SETUP_TABS.map(([key]) => key);
    const next = keys[(keys.indexOf(active) + step + keys.length) % keys.length]!;
    show(next);
    document.getElementById(`tab-${next}`)?.focus();
  };
  const onVersion = (next: string) => {
    void navigate({ to: gamePath(game, 'event-setup'), search: { ...search, version: next || undefined }, hash: 'mappings', replace: true });
  };

  const missing = mappings.data ? mappings.data.concepts.filter((item) => item.status === 'missing').length : 0;

  return (
    <>
      <Heading title="Event setup" actions={<div className="heading-actions"><Link className="button" to={gamePath(game, 'dictionary')}><Ico name="book" size={15} /> Event dictionary</Link></div>} />
      <div className="setup-tabs" role="tablist" aria-label="Event setup" onKeyDown={onTabKey}>
        {SETUP_TABS.map(([key, title, symbol]) => (
          <button key={key} type="button" className="setup-tab" role="tab" id={`tab-${key}`} aria-controls={`panel-${key}`}
            aria-selected={active === key} tabIndex={active === key ? 0 : -1} onClick={() => show(key)}>
            <Ico name={symbol} size={16} /><span>{title}</span>
            {key === 'mappings' && mappings.data ? <span className={`pill ${missing ? 'bad' : 'good'}`} id="mappings-status">{missing ? `${number(missing)} not found` : 'All covered'}</span> : null}
          </button>
        ))}
      </div>
      <section className="setup-panel panel" role="tabpanel" id="panel-install" aria-labelledby="tab-install" hidden={active !== 'install'}>
        <div className="panel-body"><AddEvents game={game} /></div>
      </section>
      <section className="setup-panel panel" role="tabpanel" id="panel-fill" aria-labelledby="tab-fill" hidden={active !== 'fill'}>
        <div className="panel-body"><ImportFlow game={game} /></div>
      </section>
      <section className="setup-panel" role="tabpanel" id="panel-mappings" aria-labelledby="tab-mappings" hidden={active !== 'mappings'}>
        <Mappings game={game} query={mappings} version={version} event={search.event ?? ''} concept={search.concept ?? ''} onVersion={onVersion} />
      </section>
    </>
  );
}
