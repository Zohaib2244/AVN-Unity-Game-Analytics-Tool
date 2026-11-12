// Saved player groups and install sources use the same chips as the Players page.
import { useRef, useState, type ReactElement } from 'react';
import { Popover, Segmented } from '@avn/ui';
import { useRead } from '@/api';
import { gameURL } from '@/lib/games';
import type { Game } from '@/lib/types';
import { chipWords, groupSummary, type Chip, type ChipSelection, type SavedChipGroup } from '@/pages/players/chips';
import { LoadError } from './feedback';
import { OptionList } from './OptionList';
import { Ico } from './icons';

type SourceOptions = Record<'campaign' | 'media_source', Array<{ value: string; players: number }>>;
export function PlayerGroupPicker({ game, value, onChange }: { game: Pick<Game, 'id'>; value?: ChipSelection; onChange: (value: ChipSelection | undefined) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'groups' | 'campaign' | 'media_source' | 'install'>('groups');
  const [picked, setPicked] = useState<string[]>([]);
  const anchor = useRef<HTMLButtonElement>(null);
  const groups = useRead<SavedChipGroup[]>(open ? `${gameURL(game)}/insights/group-library?kind=players` : null);
  const sources = useRead<SourceOptions>(open && (tab === 'campaign' || tab === 'media_source') ? `${gameURL(game)}/insights/player-chip-options` : null);
  const choose = (next?: ChipSelection) => { onChange(next); setOpen(false); };
  const chooseInstall = (install: 'paid' | 'organic' | 'none') => {
    const chips: Chip[] = [{ kind: 'install_type', value: install }];
    choose({ name: chipWords(chips[0]!).join(' '), chips });
  };
  return <>
    <button type="button" className="btn group-picker-open" aria-label="Player group" ref={anchor} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}><Ico name="users" size={14} /> Players</button>
    <Popover position="fixed" anchor={anchor} open={open} onClose={() => setOpen(false)} width={360} className="player-group-picker">
      <div className="pop-scroll">
        <Segmented label="Players by" value={tab} onChange={(next) => { setTab(next); setPicked([]); }} options={[{ value: 'groups', label: 'Saved' }, { value: 'campaign', label: 'Campaign' }, { value: 'media_source', label: 'Source' }, { value: 'install', label: 'Install' }]} />
        <button type="button" className="grp-picker-item" aria-pressed={!value} onClick={() => choose()}>All players</button>
        {tab === 'groups' ? groups.isError ? <LoadError error={groups.error} onRetry={() => void groups.refetch()} /> : groups.data ? groups.data.length ? <OptionList options={groups.data.map((group) => ({ value: group.id, label: group.name, hint: groupSummary(group.definition.chips) }))} selected={groups.data.filter((group) => JSON.stringify(group.definition.chips) === JSON.stringify(value?.chips)).map((group) => group.id)} searchLabel="Find saved player groups" single onChange={(ids) => { const group = groups.data!.find((item) => item.id === ids[0]); if (group) choose({ name: group.name, chips: group.definition.chips }); }} /> : <p className="help">No saved player groups. Create one on Players.</p> : <p role="status" className="help">Reading saved groups…</p> : null}
        {tab === 'install' ? <div>{(['paid', 'organic', 'none'] as const).map((install) => <button key={install} type="button" className="grp-picker-item" onClick={() => chooseInstall(install)}>{install === 'paid' ? 'Paid installs' : install === 'organic' ? 'Organic installs' : 'No install record'}</button>)}</div> : null}
        {tab === 'campaign' || tab === 'media_source' ? sources.isError ? <LoadError error={sources.error} onRetry={() => void sources.refetch()} /> : sources.data ? <OptionList options={(sources.data[tab] ?? []).map((item) => ({ value: item.value, label: item.value }))} selected={picked} onChange={setPicked} searchLabel={tab === 'campaign' ? 'Find campaigns' : 'Find media sources'} /> : <p role="status" className="help">Reading install sources…</p> : null}
      </div>
      {tab === 'campaign' || tab === 'media_source' ? <div className="pop-foot"><span className="small muted">Any selected value</span><button type="button" className="btn primary" disabled={!picked.length} onClick={() => { const chips: Chip[] = [{ kind: tab, values: picked }]; choose({ name: chipWords(chips[0]!).join(' '), chips }); }}>Apply</button></div> : null}
    </Popover>
  </>;
}
