// The setup checklist (each step Verified only by a check against real data, never by hand) and the
// "Sections at a glance" tiles. Both read the same facts: saved funnels, the dictionary and the team.
import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { StatusMark, Tag, type StatusKind } from '@avn/ui';
import { useRead } from '@/api';
import { useSession } from '@/app/session';
import { number } from '@/lib/format';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { Game, OverviewSummary } from '@/lib/types';
import { useNotify } from '@/components/feedback';
import { Ico, type IcoName } from '@/components/icons';

type DictionaryEntry = { description?: string | null };
export type Facts = { funnels: unknown[] | null; dictionary: Record<string, DictionaryEntry> | null; team: unknown[] | null };

const settled = (query: { isSuccess: boolean; isError: boolean }) => query.isSuccess || query.isError;

/** The three reads behind the checklist and tiles; `null` until all have answered (a failed one stays null). */
export function useFacts(game: Pick<Game, 'id'>): Facts | null {
  const { me } = useSession();
  const funnels = useRead<unknown[]>(`${gameURL(game)}/insights/funnels`);
  const dictionary = useRead<Record<string, DictionaryEntry>>(`${gameURL(game)}/dictionary`);
  const team = useRead<unknown[]>(me.can_manage_team ? '/v1/team' : null);
  if (!settled(funnels) || !settled(dictionary) || (me.can_manage_team && !settled(team))) return null;
  return { funnels: funnels.data ?? null, dictionary: dictionary.data ?? null, team: team.data ?? null };
}

export const describedCount = (dictionary: Facts['dictionary']): number => (dictionary ? Object.values(dictionary).filter((item) => (item?.description || '').trim()).length : 0);

export type SetupStep = { id: string; title: string; note: string; state: 'ok' | 'done' | 'wait' | 'todo'; href: string; action: string };

export function setupSteps(game: Game, data: OverviewSummary, facts: Facts | null, canManageTeam: boolean): SetupStep[] {
  const described = describedCount(facts?.dictionary ?? null);
  const shown = (data.top_events || []).slice(0, 10);
  const undescribed = shown.filter((row) => !(facts?.dictionary?.[row.name]?.description || '').trim()).length;
  const versions = (data.breakdowns?.app_version || []).length;
  const events = game.events || data.events;
  return [
    { id: 'sdk', title: 'Add the SDK to your game', note: events ? `${number(game.events || data.events)} events received` : 'Waiting for the first event', state: events ? 'ok' : 'wait', href: gamePath(game, 'event-setup'), action: 'Event setup' },
    { id: 'key', title: 'Use an API key', note: game.events ? 'Events are arriving with a key' : 'Create one and put it in the game', state: game.events ? 'ok' : 'todo', href: gamePath(game, 'keys'), action: 'API keys' },
    { id: 'dictionary', title: 'Describe your events', note: facts?.dictionary ? `${number(described)} described${shown.length ? ` · ${undescribed ? `${undescribed} of the top ${shown.length} still without` : 'every top event has one'}` : ''}` : 'Checking…', state: !facts?.dictionary ? 'wait' : shown.length && !undescribed ? 'ok' : described ? 'done' : 'todo', href: gamePath(game, 'dictionary'), action: 'Dictionary' },
    { id: 'funnel', title: 'Save your first funnel', note: facts?.funnels ? (facts.funnels.length ? `${facts.funnels.length} saved` : 'Funnels show where players stop') : 'Checking…', state: !facts?.funnels ? 'wait' : facts.funnels.length ? 'ok' : 'todo', href: gamePath(game, 'funnels'), action: 'Funnels' },
    { id: 'release', title: 'See a new release', note: versions > 1 ? `${versions} versions seen` : 'Compare releases once a second version sends events', state: versions > 1 ? 'ok' : 'todo', href: gamePath(game, 'levels'), action: 'Levels' },
    ...(canManageTeam ? [{ id: 'team', title: 'Invite your team', note: facts?.team ? (facts.team.length > 1 ? `${facts.team.length} people` : 'Only you so far') : 'Checking…', state: (!facts?.team ? 'wait' : facts.team.length > 1 ? 'ok' : 'todo') as SetupStep['state'], href: '/team', action: 'Team' }] : []),
  ];
}

const TAGS: Record<SetupStep['state'], [StatusKind, string]> = { ok: ['ok', 'Verified'], done: ['done', 'Done · to confirm'], wait: ['info', 'Waiting'], todo: ['plain', 'To do'] };

/** Setup is a quiet nudge: closed by default, and it can be dismissed for good. Gone once every step is verified. */
export function SetupChecklist({ game, data, facts }: { game: Game; data: OverviewSummary; facts: Facts | null }): ReactElement | null {
  const { me } = useSession();
  const { toast } = useNotify();
  const setupKey = `avn-setup-open-${game.id}`;
  const dismissKey = `avn-setup-dismissed-${game.id}`;
  const [open, setOpen] = useState(() => storeGet(setupKey) === true);
  const [dismissed, setDismissed] = useState(() => storeGet(dismissKey) === true);
  if (!facts) return null;
  const steps = setupSteps(game, data, facts, me.can_manage_team);
  const verified = steps.filter((step) => step.state === 'ok').length;
  if (verified === steps.length || dismissed) return null;
  const toggle = () => { setOpen(!open); storeSet(setupKey, !open); };
  const dismiss = () => {
    storeSet(dismissKey, true); setDismissed(true);
    toast('Setup suggestions hidden for this game', { label: 'Undo', run: () => { storeSet(dismissKey, false); setDismissed(false); } }, 'info');
  };
  return (
    <section className={`panel setup${open ? '' : ' closed'}`}>
      <div className="panel-header">
        <div><h2>Set up {game.name}</h2><p>{verified} of {steps.length} verified</p></div>
        <div className="quiet-actions">
          <span className="sbar" aria-hidden="true">{steps.map((step) => <i key={step.id} className={step.state} />)}</span>
          <button type="button" className="btn sm ghost" aria-expanded={open} onClick={toggle}>{open ? 'Hide steps' : 'Show steps'}</button>
          <button type="button" className="btn sm ghost" aria-label="Dismiss setup suggestions" title="Dismiss" onClick={dismiss}><Ico name="close" size={14} /></button>
        </div>
      </div>
      <div className={`collapse${open ? '' : ' shut'}`}>
        <div>
          {steps.map((step) => {
            const [kind, word] = TAGS[step.state];
            return (
              <div key={step.id} className="srow">
                <StatusMark state={step.state} burst />
                <span><b>{step.title}</b><span className="s">{step.note}</span></span>
                <span className="ra"><Tag kind={kind}>{word}</Tag><Link className="btn sm" to={step.href}>{step.action}</Link></span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Sections at a glance: one tile per area with its own headline, each opening that page. */
export function SectionTiles({ game, data, facts }: { game: Game; data: OverviewSummary; facts: Facts | null }): ReactElement {
  const tile = (section: string, symbol: IcoName, title: string, value: string, note: string) => (
    <Link key={section} className="tile" to={gamePath(game, section)}>
      <span className="th"><Ico name={symbol} size={16} />{title}</span><span className="tv">{value}</span><span className="ts2">{note}</span>
      <span className="go">Open {title.toLowerCase()} <Ico name="arrow" size={13} /></span>
    </Link>
  );
  const top = (data.top_events || [])[0];
  const described = facts?.dictionary ? describedCount(facts.dictionary) : null;
  return (
    <>
      <div className="strip-h"><span className="eyebrow">Sections at a glance</span></div>
      <div className="tiles">
        {tile('funnels', 'funnel', 'Funnels', facts?.funnels ? number(facts.funnels.length) : '—', facts?.funnels?.length ? `saved funnel${facts.funnels.length === 1 ? '' : 's'}` : 'Where players stop, step by step')}
        {tile('levels', 'game', 'Levels', '→', 'Where players stop, level by level')}
        {tile('players', 'users', 'Players', number(data.players), `${number(data.new_players)} new in this range`)}
        {tile('dictionary', 'book', 'Event dictionary', top ? top.name : '—', top ? `most sent · ${number(top.events)} events${described != null ? ` · ${number(described)} described` : ''}` : 'Describe what your events mean')}
      </div>
    </>
  );
}
