// "Install source": keep only players from one campaign or media source, or players with no install
// record. Sent as campaign= / source= / no_install_record= (segments.py on the server), so it is offered
// only on pages whose reads honour it. Remembered per game in this browser.
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { Popover, SingleSelect } from '@avn/ui';
import { useRead } from '@/api';
import { filterQuery, type ActiveFilters } from '@/lib/filters';
import { gameURL } from '@/lib/games';
import { useStored } from '@/lib/store';
import type { AcquisitionReport, Game } from '@/lib/types';
import { Ico } from './icons';

export type InstallChoice = { kind: 'all' } | { kind: 'campaign' | 'source'; value: string } | { kind: 'none' };
const ALL: InstallChoice = { kind: 'all' };
const NO_RECORD = 'No install record';
const ORGANIC = 'Organic';

export const installKey = (game: Pick<Game, 'id'>): string => `avn-install-source-${game.id}`;

function clean(value: unknown): InstallChoice {
  const choice = value as Partial<{ kind: string; value: string }> | null;
  if (choice?.kind === 'none') return { kind: 'none' };
  if ((choice?.kind === 'campaign' || choice?.kind === 'source') && typeof choice.value === 'string' && choice.value) return { kind: choice.kind, value: choice.value };
  return ALL;
}

/** The query words for a choice, to add after filterQuery. */
export function installParams(choice: InstallChoice): Array<[string, string]> {
  if (choice.kind === 'none') return [['no_install_record', 'true']];
  if (choice.kind === 'campaign') return [['campaign', choice.value]];
  if (choice.kind === 'source') return [['source', choice.value]];
  return [];
}
export const installText = (choice: InstallChoice): string => (choice.kind === 'all' ? 'All installs' : choice.kind === 'none' ? NO_RECORD : choice.value);

export function useInstallSource(game: Pick<Game, 'id'>): [InstallChoice, (next: InstallChoice) => void] {
  const [stored, setStored] = useStored<unknown>(installKey(game), ALL);
  return [clean(stored), setStored];
}

/** The picker: campaigns and media sources this game's players came from in the chosen days. */
export function InstallSourcePicker({ game, filters, value, onChange }: { game: Game; filters: ActiveFilters; value: InstallChoice; onChange: (next: InstallChoice) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // The acquisition read ignores tz_offset: install days are UTC days.
  const base = `${gameURL(game)}/insights/acquisition?${filterQuery(filters)}`;
  const campaigns = useRead<AcquisitionReport>(open ? `${base}&group_by=campaign` : null);
  const sources = useRead<AcquisitionReport>(open ? `${base}&group_by=media_source` : null);
  const options = useMemo(() => {
    const named = (report: AcquisitionReport | undefined) => (report?.rows ?? []).filter((row) => row.paid && row.installs);
    return [
      { value: 'all', label: 'All installs' },
      ...named(campaigns.data).map((row) => ({ value: `campaign:${row.value}`, label: row.value, hint: `campaign · ${row.installs}` })),
      ...named(sources.data).map((row) => ({ value: `source:${row.value}`, label: row.value, hint: `source · ${row.installs}` })),
      { value: 'source:organic', label: ORGANIC },
      { value: 'none', label: NO_RECORD, hint: 'attribution never arrived' },
    ];
  }, [campaigns.data, sources.data]);
  const current = value.kind === 'all' ? 'all' : value.kind === 'none' ? 'none' : `${value.kind}:${value.value}`;
  const choose = (key: string) => {
    setOpen(false);
    if (key === 'all') onChange(ALL);
    else if (key === 'none') onChange({ kind: 'none' });
    else { const [kind, ...rest] = key.split(':'); onChange({ kind: kind as 'campaign' | 'source', value: rest.join(':') }); }
  };
  return (
    <>
      <button ref={button} type="button" className={`btn install-source${value.kind === 'all' ? '' : ' on'}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>
        <Ico name="users" size={14} /> {value.kind === 'all' ? 'Install source' : installText(value)} <Ico name="chevron" size={12} />
      </button>
      <Popover position="fixed" open={open} onClose={() => setOpen(false)} anchor={button} width={300}>
        {campaigns.isLoading || sources.isLoading ? <p className="small muted pop-note">Reading install sources…</p> : null}
        <SingleSelect options={options} value={current} onChange={choose} />
      </Popover>
    </>
  );
}
