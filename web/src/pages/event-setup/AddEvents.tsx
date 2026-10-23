// Add AVN Events: pick the tiers, download the setup files (or copy the prompt) for the AI agent the developer
// runs in the game's code, see what the game sends that the standard does not have, and manage custom events.
// Only an admin changes the standard; everyone sees the list.
import { useEffect, useState, type ReactElement } from 'react';
import { write, useRead, errorMessage } from '@/api';
import { agoText, number } from '@/lib/format';
import { copyText, storeGet, storeSet } from '@/lib/store';
import type { CustomEvent, Game, StandardStatus, StandardSummary } from '@/lib/types';
import { ConfirmDialog, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { SdkDownloadButton } from '@/pages/settings/SdkPanel';
import { SetupFlow } from '@/pages/dictionary/ImportFlow';
import { useSession } from '@/app/session';
import { CustomEventDialog, type EditorTarget } from './CustomEventDialog';
import { DEFAULT_CHOICE, STANDARD_TIERS, statusPath, selectedVersion, standardQuery, tiersFrom, versionAfterPick, versionLabel, versionsNote, type VersionChoice } from './customEvents';

const CUSTOM_URL = '/v1/events-standard/custom';
type Pending =
  | { kind: 'tier'; name: string; tier: 'core' | 'custom' }
  | { kind: 'delete'; name: string }
  | { kind: 'older'; count: number }
  | null;

export function AddEvents({ game }: { game: Game }): ReactElement {
  const { me } = useSession();
  const { toast, toastError } = useNotify();
  const storeKey = 'avn-standard-tiers';
  const choiceKey = `avn-standard-version-${game.id}`;
  const [tiers, setTiers] = useState<string[]>(() => tiersFrom(storeGet(storeKey)));
  const [choice, setChoice] = useState<VersionChoice>(() => storeGet<VersionChoice>(choiceKey) || DEFAULT_CHOICE);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [busyName, setBusyName] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const custom = useRead<CustomEvent[]>(CUSTOM_URL);
  const status = useRead<StandardStatus>(statusPath(game.id, choice));
  const hasCustomBeyondCore = (custom.data ?? []).some((item) => item.tier !== 'core');
  const query = standardQuery(tiers, hasCustomBeyondCore);
  const summary = useRead<StandardSummary>(`/v1/events-standard?${query}`);

  const choose = (next: VersionChoice) => { setChoice(next); storeSet(choiceKey, next); };
  // A remembered version the game no longer has: fall back to the newest one.
  useEffect(() => {
    if (status.isError && !(choice.version === DEFAULT_CHOICE.version && choice.newer)) choose(DEFAULT_CHOICE);
  }, [status.isError]);

  const toggleTier = (key: string, on: boolean) => {
    const next = STANDARD_TIERS.map(([k]) => k).filter((k) => (k === key ? on : tiers.includes(k)) || k === 'core');
    setTiers(next); storeSet(storeKey, next);
  };

  const download = async () => {
    setDownloading(true); setDownloadError('');
    try {
      // The one fetch the page makes: a binary download, as the rules allow.
      const response = await fetch(`/v1/events-standard/download?${query}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const problem = await response.json().catch(() => ({})) as { detail?: unknown };
        throw new Error(typeof problem.detail === 'string' ? problem.detail : 'Download failed. Please try again.');
      }
      const href = URL.createObjectURL(await response.blob());
      const anchor = Object.assign(document.createElement('a'), { href, download: 'avn-events-setup.zip' });
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
    } catch (problem) { setDownloadError(errorMessage(problem)); }
    finally { setDownloading(false); }
  };

  const copyPrompt = async (prompt: string) => toast((await copyText(prompt)) ? 'Prompt copied.' : 'Open "Show the prompt" and copy it by hand.');

  const act = async (name: string, run: () => Promise<unknown>, done: string) => {
    setBusyName(name);
    try { await run(); toast(done); }
    catch (problem) { toastError(problem); }
    finally { setBusyName(''); }
  };

  const sent = status.data?.sent;
  const info = status.data;
  const canEdit = me.can_manage_team;

  return (
    <>
      <div className="import-choices standard-tiers" role="group" aria-label="Which events">
        {STANDARD_TIERS.map(([key, title, text]) => (
          <label className="import-choice" key={key}>
            <input type="checkbox" name="tier" value={key} checked={tiers.includes(key)} disabled={key === 'core'} onChange={(e) => toggleTier(key, e.target.checked)} />
            <span><strong>{title}</strong><small>{text}</small></span>
          </label>
        ))}
      </div>

      {info && info.versions.length > 1 ? (
        <div id="version-filter" className="version-filter">
          <VersionFilter status={info} choice={choice} onChoose={choose} />
        </div>
      ) : null}

      {info && (info.unlisted.length || info.ignored.length || info.older_only.length) ? (
        <div id="unlisted-events" className="custom-events unlisted-events">
          {info.unlisted.length ? (
            <div className="custom-head"><h3><Ico name="pulse" size={16} /> Sent, not in the standard <span className="count">{number(info.total_unlisted)}</span>{info.unlisted.length < info.total_unlisted ? <> <span className="small muted">showing {number(info.unlisted.length)}</span></> : null}</h3></div>
          ) : null}
          {info.unlisted.length ? (
            <ul className="custom-list">
              {info.unlisted.map((item) => (
                <li key={item.name}>
                  <code>{item.name}</code>
                  <span className="small muted">{number(item.events)} event{item.events === 1 ? '' : 's'} · last seen {agoText(item.last_seen)}{item.versions.length ? ` · ${versionsNote(item.versions)}` : ''}</span>
                  {item.valid_name ? null : <span className="pill" title="Event names in the standard are UPPER_SNAKE">Name not UPPER_SNAKE</span>}
                  <span className="custom-actions">
                    {item.valid_name && canEdit ? <button type="button" className="button" onClick={() => setEditor({ prefill: item })}><Ico name="plus" size={14} /> Add to standard</button> : null}
                    <button type="button" className="button" disabled={busyName === item.name} onClick={() => void act(item.name, () => write(`/v1/games/${encodeURIComponent(game.id)}/standard/ignored/${encodeURIComponent(item.name)}`, { method: 'PUT' }), `${item.name} ignored for this game.`)}>Ignore</button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {info.older_only.length ? (
            <p className="older-note small muted">
              {number(info.older_only.length)} more event{info.older_only.length === 1 ? ' is' : 's are'} only sent by older versions.{' '}
              {canEdit ? <button type="button" className="button" onClick={() => setPending({ kind: 'older', count: info.older_only.length })}>Ignore {info.older_only.length === 1 ? 'it' : 'them'}</button> : null}
            </p>
          ) : null}
          {info.ignored.length ? (
            <details className="mapping-how"><summary>Ignored ({number(info.ignored.length)})</summary>
              <ul className="custom-list">
                {info.ignored.map((item) => (
                  <li key={item.name}>
                    <code>{item.name}</code><span className="small muted">{number(item.events)} events</span>
                    <span className="custom-actions"><button type="button" className="button" disabled={busyName === item.name} onClick={() => void act(item.name, () => write(`/v1/games/${encodeURIComponent(game.id)}/standard/ignored/${encodeURIComponent(item.name)}`, { method: 'DELETE' }), `${item.name} restored.`)}>Restore</button></span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      <div id="custom-events" className="custom-events">
        <CustomList list={custom.data ?? []} sent={sent} canEdit={canEdit} onEdit={(item) => setEditor({ existing: item })} onTier={(name, tier) => setPending({ kind: 'tier', name, tier })} onDelete={(name) => setPending({ kind: 'delete', name })} onAdd={() => setEditor({})} />
      </div>
      {editor ? <CustomEventDialog target={editor} onClose={() => setEditor(null)} /> : null}
      {pending ? <PendingConfirm pending={pending} game={game} choice={choice} onClose={() => setPending(null)} act={act} /> : null}

      <div className="error" role="alert">{downloadError}</div>
      <div className="import-actions setup-actions">
        <button type="button" className="button primary" disabled={downloading} onClick={() => void download()}><Ico name="export" size={15} /> Download setup files</button>
        <button type="button" className="button" onClick={() => void copyPrompt(summary.data?.prompt ?? '')} disabled={!summary.data}><Ico name="copy" size={15} /> Copy prompt</button>
        <SdkDownloadButton />
      </div>
      <SetupFlow items={[['export', 'Unzip in your game'], ['sparkle', <>Run <code>AGENT_PROMPT.md</code> in your AI agent</>], ['pulse', 'Send a test build']]} />

      <div id="standard-summary">
        <QueryRegion query={summary} path={`/v1/events-standard?${query}`} skeleton={<Skeleton kind="table" rows={3} columns={3} />}>
          {(result) => (
            <>
              <details className="import-prompt standard-events"><summary>Show the {number(result.events.length)} events</summary>
                <div className="table-wrap"><table className="import-table">
                  <thead><tr><th>Event</th><th>Tier</th><th>States</th><th className="num">Sent by this game</th></tr></thead>
                  <tbody>{result.events.map((item) => (
                    <tr key={item.name}>
                      <td><code>{item.name}</code></td><td>{item.tier}</td>
                      <td>{item.states.map((state) => <span key={state}><code>{state}</code> </span>)}</td>
                      <td className="num">{sent?.[item.name] ? number(sent[item.name]!.events) : <span className="muted">—</span>}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </details>
              <details className="import-prompt"><summary>Show the prompt</summary><textarea readOnly rows={12} aria-label="Agent prompt" id="standard-prompt" value={result.prompt} /></details>
            </>
          )}
        </QueryRegion>
      </div>
    </>
  );
}

function VersionFilter({ status, choice, onChoose }: { status: StandardStatus; choice: VersionChoice; onChoose: (next: VersionChoice) => void }): ReactElement {
  const selected = selectedVersion(status.versions, choice);
  return (
    <>
      <div className="inline-field">
        <label htmlFor="version-filter-select">Events sent by</label>
        <select id="version-filter-select" value={selected} onChange={(e) => onChoose({ version: versionAfterPick(status.versions, e.target.value), newer: choice.newer })}>
          <option value="">All versions</option>
          {status.versions.map((item) => <option key={item.version} value={item.version}>{versionLabel(item, agoText(item.last_seen))}</option>)}
        </select>
      </div>
      <label className="check-row">
        <input type="checkbox" id="version-filter-newer" checked={choice.newer} disabled={!selected} onChange={(e) => onChoose({ ...choice, newer: e.target.checked })} /> and newer versions
      </label>
    </>
  );
}

function CustomList({ list, sent, canEdit, onEdit, onTier, onDelete, onAdd }: {
  list: CustomEvent[]; sent: StandardStatus['sent'] | undefined; canEdit: boolean;
  onEdit: (item: CustomEvent) => void; onTier: (name: string, tier: 'core' | 'custom') => void; onDelete: (name: string) => void; onAdd: () => void;
}): ReactElement {
  return (
    <>
      <div className="custom-head">
        <h3><Ico name="sparkle" size={16} /> Custom events {list.length ? <span className="count">{number(list.length)}</span> : null}</h3>
        {canEdit ? <button type="button" className="button" onClick={onAdd}><Ico name="plus" size={14} /> Add event</button> : null}
      </div>
      {list.length ? (
        <ul className="custom-list">
          {list.map((item) => (
            <li key={item.name}>
              <code>{item.name}</code>
              <span className="small muted">{number(item.states.length)} state{item.states.length === 1 ? '' : 's'} · {item.states.map((state) => state.name).join(', ')}</span>
              {item.tier === 'core' ? <span className="pill" title="Always in the setup files">Core</span> : null}
              {sent ? (sent[item.name] ? <span className="pill good">Sent · {number(sent[item.name]!.events)}</span> : <span className="pill">Not sent yet</span>) : null}
              {canEdit ? (
                <span className="custom-actions">
                  <button type="button" className="button" onClick={() => onTier(item.name, item.tier === 'core' ? 'custom' : 'core')}>{item.tier === 'core' ? 'Demote to custom' : 'Promote to core'}</button>
                  <button type="button" className="icon-button" aria-label={`Edit ${item.name}`} title="Edit" onClick={() => onEdit(item)}><Ico name="edit" size={14} /></button>
                  <button type="button" className="icon-button" aria-label={`Delete ${item.name}`} title="Delete" onClick={() => onDelete(item.name)}><Ico name="close" size={14} /></button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : <p className="muted small">None yet.</p>}
    </>
  );
}

/** The confirm dialog for a pending tier change, deletion or ignore-older. Each one saves, then says so. */
function PendingConfirm({ pending, game, choice, onClose, act }: {
  pending: NonNullable<Pending>; game: Game; choice: VersionChoice; onClose: () => void;
  act: (name: string, run: () => Promise<unknown>, done: string) => Promise<void>;
}): ReactElement {
  const { toast } = useNotify();
  if (pending.kind === 'tier') {
    const { name, tier } = pending;
    const promote = tier === 'core';
    return (
      <ConfirmDialog open onClose={onClose} label={promote ? 'Promote' : 'Demote'} title={promote ? `Promote ${name} to core?` : `Demote ${name} to custom?`}
        message={promote ? 'Core events are in every setup download, even when custom events are left out. Games should send it from now on.' : 'It stays in the standard, but only comes with the setup files when custom events are included.'}
        onConfirm={() => act(name, () => write(`${CUSTOM_URL}/${encodeURIComponent(name)}/tier`, { method: 'PUT', body: JSON.stringify({ tier }) }), promote ? `${name} is now a core event.` : `${name} is a custom event again.`)} />
    );
  }
  if (pending.kind === 'delete') {
    const { name } = pending;
    return (
      <ConfirmDialog open onClose={onClose} label="Delete event" title={`Delete ${name}?`}
        message="It leaves the standard and the setup downloads. Games already using it keep sending it, and the events stay in your data."
        onConfirm={() => act(name, () => write(`${CUSTOM_URL}/${encodeURIComponent(name)}`, { method: 'DELETE' }), `${name} deleted.`)} />
    );
  }
  const { count } = pending;
  return (
    <ConfirmDialog open onClose={onClose} label="Ignore" title={`Ignore ${number(count)} event${count === 1 ? '' : 's'} from older versions?`}
      message="They are hidden for this game in every version. Restore any of them from the Ignored list."
      onConfirm={async () => {
        const result = await write<{ ignored: number }>(`/v1/games/${encodeURIComponent(game.id)}/standard/ignore-older`, { method: 'POST', body: JSON.stringify(choice) });
        toast(`${number(result.ignored)} event${result.ignored === 1 ? '' : 's'} ignored for this game.`);
      }} />
  );
}
