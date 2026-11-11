// Game settings (avn-ux pages.md "Settings"), in order of how often you need them: the game and how to connect it
// first, who can see it, then the settings you change rarely, each one line until opened (data collection, then
// housekeeping), and the Danger zone last. Archiving is reversible (at once, Undo in the toast); deleting asks for
// the bundle ID.
import { useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ConfirmDelete } from '@avn/ui';
import { errorStatus, useRead, write } from '@/api';
import { useSession } from '@/app/session';
import { gamePath, gameURL } from '@/lib/games';
import { displayDate, fileSize, number, platformLabel } from '@/lib/format';
import { copyText } from '@/lib/store';
import type { AccessPerson, EnvironmentFix, EnvironmentFixes, EnvironmentSeen, Game, GameDetail } from '@/lib/types';
import { Activity } from '@/components/Activity';
import { ConfirmDialog, DialogShell, Heading, LoadError, Metric, QueryRegion, Skeleton, useNotify, type ToastAction } from '@/components/feedback';
import { Field, FormError, useSubmit } from '@/components/forms';
import { CopyButton } from '@/components/CopyButton';
import { GameAvatar } from '@/components/GameAvatar';
import { Ico } from '@/components/icons';
import { removeIcon, uploadIcon } from './gameIcon';
import { Disclosure, useDisclosures, type Disclosures } from './player/Disclosure';
import { VersionDataPanel } from './VersionData';

const WRONG = ['development', 'test', 'debug'];

/* ─── Delete: permanent, so it asks for the bundle ID (feedback.md "Undo vs confirm") ─── */
export function DeleteGameDialog({ game, open, onClose, onConfirm, busy }: { game: Pick<GameDetail, 'name' | 'bundle_id' | 'keys_total' | 'events'>; open: boolean; onClose: () => void; onConfirm: () => void; busy?: boolean }): ReactElement {
  return (
    <ConfirmDelete open={open} onClose={onClose} onConfirm={onConfirm} name={game.bundle_id} title={`Delete ${game.name}?`} confirmLabel="Delete game" busy={busy}
      consequences={[
        `The game and its ${number(game.keys_total)} API key${game.keys_total === 1 ? '' : 's'}. Shipped builds using them will stop sending data.`,
        `${number(game.events)} events will be moved to data/deleted on the server, where they can be recovered manually.`,
        'If you only want to pause collection, archive the game instead.',
      ]} />
  );
}

/* ─── Edit name, bundle ID and notes ─── */
function EditGameDialog({ game, open, onClose, onSave }: { game: GameDetail; open: boolean; onClose: () => void; onSave: (values: Record<string, string>) => Promise<void> }): ReactElement {
  const { onSubmit, busy, error } = useSubmit(async (values) => { await onSave(values); onClose(); });
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }} title="Edit game">
      <form id="edit-form" onSubmit={onSubmit}>
        <p>Changes apply immediately. Existing events and keys are kept.</p>
        <Field label="Game name" htmlFor="edit-name"><input id="edit-name" name="name" defaultValue={game.name} required maxLength={128} /></Field>
        <Field label="Bundle ID" htmlFor="edit-bundle"><input id="edit-bundle" name="bundle_id" defaultValue={game.bundle_id} pattern="[A-Za-z0-9_\-]+(\.[A-Za-z0-9_\-]+)+" required maxLength={255} /></Field>
        <Field label="Platform" htmlFor="edit-platform" help="The platform is fixed so events never mix. Register the other platform as its own game."><input id="edit-platform" value={platformLabel(game.platform)} disabled readOnly /></Field>
        <Field label="Notes" htmlFor="edit-notes"><textarea id="edit-notes" name="notes" maxLength={2000} placeholder="Store links, release status, anything worth remembering" defaultValue={game.notes || ''} /></Field>
        {error ? <FormError error={error} /> : null}
        <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Working…' : <>Save changes <Ico name="check" size={14} /></>}</button></div>
      </form>
    </DialogShell>
  );
}

/* ─── "Who can see this game": tick the members who may open it (admins and leads always can) ─── */
function AccessPanel({ game }: { game: Game }): ReactElement {
  const { toast, toastError } = useNotify();
  const path = `${gameURL(game)}/access`;
  const query = useRead<AccessPerson[]>(path);
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  return (
    <section className="panel section-spacing" id="access-panel">
      <div className="panel-header"><div><h2>Who can see this game</h2><p>Admins and team leads always see every game. Choose which members can open this one.</p></div></div>
      <div className="panel-body" id="access-list">
        <QueryRegion query={query} path={path} skeleton={<Skeleton rows={3} columns={2} />} note={false}>{(people) => {
          const members = people.filter((person) => person.role === 'member');
          const everyone = people.filter((person) => person.role !== 'member');
          const selected = chosen ?? new Set(members.filter((person) => person.has_access).map((person) => person.email));
          const save = async () => {
            setSaving(true);
            try { await write(path, { method: 'PUT', body: JSON.stringify({ emails: [...selected] }) }); setChosen(null); toast('Access updated.'); }
            catch (error) { toastError(error); }
            finally { setSaving(false); }
          };
          return (
            <>
              {members.length ? (
                <>
                  <div className="check-list">{members.map((person) => (
                    <label key={person.email} className="check-row"><input type="checkbox" value={person.email} checked={selected.has(person.email)} onChange={(event) => { const next = new Set(selected); if (event.target.checked) next.add(person.email); else next.delete(person.email); setChosen(next); }} /> {person.name || person.email.split('@')[0]} <span className="muted small">{person.email}</span></label>
                  ))}</div>
                  <div className="form-actions"><button className="button primary" type="button" id="save-access" disabled={saving} aria-busy={saving || undefined} onClick={() => void save()}>{saving ? 'Working…' : 'Save access'}</button></div>
                </>
              ) : <p className="help">There are no members yet. The admin can add people on the Team page.</p>}
              {everyone.length ? <p className="small muted section-spacing">Always have access: {everyone.map((person) => person.name || person.email).join(', ')}</p> : null}
            </>
          );
        }}</QueryRegion>
      </div>
    </section>
  );
}

/* ─── What each build reported as its environment, with "count it as production" fixes ─── */
function EnvironmentPanel({ game, manage }: { game: Game; manage: boolean }): ReactElement {
  const { toast, toastError } = useNotify();
  const path = `${gameURL(game)}/environment-fixes`;
  const query = useRead<EnvironmentFixes>(path);
  const [recount, setRecount] = useState<EnvironmentSeen | null>(null);
  const undoFix = async (id: string, message: string) => {
    try { await write(`${path}/${encodeURIComponent(id)}`, { method: 'DELETE' }); toast(message); }
    catch (error) { toastError(error); }
  };
  return (
    <section className="panel section-spacing" id="environment-panel">
      <div className="panel-header"><div><h2>Environment</h2><p>Each build reports whether it is production, development or editor. A published build that was left in development mode is hidden by “Hide editor &amp; development data”. Re-count it here: the stored events are never changed, and you can undo it.</p></div></div>
      <div className="panel-body" id="environment-list">
        <QueryRegion query={query} path={path} skeleton={<Skeleton rows={3} columns={3} />} note={false}>{(data) => {
          if (!data.seen.length) return <p className="help">No events yet. Builds appear here once they send data.</p>;
          const fixes = new Map(data.fixes.map((fix) => [fix.id, fix]));
          return (
            <>
              <div className="table-wrap"><table className="compact-table">
                <thead><tr><th>Reported as</th><th>Version</th><th>Build</th><th className="num">Players</th><th className="num">Events</th><th>Counted as</th>{manage ? <th><span className="sr-only">Actions</span></th> : null}</tr></thead>
                <tbody>{data.seen.map((row, index) => {
                  const fix = row.fix ? fixes.get(row.fix) : undefined;
                  const action = !manage ? null : fix ? <button type="button" className="button" onClick={() => void undoFix(fix.id, 'Back to as reported.')}>Undo</button> : WRONG.includes(row.environment) && row.app_version ? <button type="button" className="button" onClick={() => setRecount(row)}>Count as production…</button> : null;
                  return (
                    <tr key={index}>
                      <td><span className={`pill ${WRONG.includes(row.environment) || row.environment === 'editor' ? '' : 'good'}`}>{row.environment}</span></td>
                      <td>{row.app_version || '—'}</td><td>{row.build || '—'}</td>
                      <td className="num">{number(row.players)}</td><td className="num">{number(row.events)}</td>
                      <td>{fix ? <><span className="pill good">{fix.to_environment}</span> <span className="small muted">corrected</span></> : <span className="small muted">as reported</span>}</td>
                      {manage ? <td className="num">{action}</td> : null}
                    </tr>
                  );
                })}</tbody>
              </table></div>
              {data.fixes.length ? null : <p className="help">Nothing is corrected. If real players show up as development, use “Count as production” on their build.</p>}
            </>
          );
        }}</QueryRegion>
      </div>
      <ConfirmDialog open={!!recount} onClose={() => setRecount(null)} title={`Count version ${recount?.app_version} as production?`} label="Count as production"
        message={recount ? `${number(recount.players)} ${recount.players === 1 ? 'player' : 'players'} and ${number(recount.events)} events from this build${recount.build ? ` (build ${recount.build})` : ''} reported ${recount.environment}. They will be counted as production everywhere in the dashboard (overview, players, funnels, levels, filters and export filters), including events that arrive later from this build. Only do this if the build is really published. The stored events are not changed and you can undo it from this table.` : ''}
        onConfirm={async () => {
          const row = recount!;
          const fix = await write<Partial<EnvironmentFix> | null>(path, { method: 'POST', body: JSON.stringify({ from_environment: row.environment, to_environment: 'production', app_version: row.app_version, build: row.build || null }) });
          const undo: ToastAction | null = fix?.id ? { label: 'Undo', run: () => void undoFix(fix.id!, 'Back to as reported.') } : null;
          toast(`Version ${row.app_version} now counts as production.`, undo);
        }} />
    </section>
  );
}

/* ─── The page ─── */
/** A settings section that stays one line (its name and what it is set to) until opened; its contents load when opened. */
function Fold({ name, title, summary, disclosures, children }: { name: string; title: string; summary: string; disclosures: Disclosures; children: ReactNode }): ReactElement {
  const open = disclosures.isOpen(name, false);
  return (
    <Disclosure name={name} disclosures={disclosures} className="settings-fold" summaryClassName="settings-fold-head" summary={<><strong>{title}</strong><span className="muted">{summary}</span></>}>
      <div className="settings-fold-body">{open ? children : null}</div>
    </Disclosure>
  );
}

export function GameSettingsPage({ game }: { game: Game }): ReactElement {
  const { me, overview, workspace, workspaceName, canManageGames: manage, variantsOf, refresh, chooseWorkspace } = useSession();
  const navigate = useNavigate();
  const { toast, toastError } = useNotify();
  const path = gameURL(game);
  const query = useRead<GameDetail>(path);
  const iconInput = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [target, setTarget] = useState(() => me.workspaces.find((item) => item.id !== workspace)?.id || '');
  const variants = variantsOf(game);
  const folds = useDisclosures(`avn-settings-folds-${game.id}`);

  const update = async (changes: Record<string, unknown>, message: string, undo: ToastAction | null = null) => {
    await write(path, { method: 'PATCH', body: JSON.stringify(changes) });
    await refresh();
    toast(message, undo);
  };
  const archive = async () => {
    try { await update({ archived: true }, 'Game archived. Collection is paused.', { label: 'Undo', run: () => update({ archived: false }, 'Game restored. Collection has resumed.').catch(toastError) }); }
    catch (error) { toastError(error); }
  };
  const restore = async () => { try { await update({ archived: false }, 'Game restored. Collection has resumed.'); } catch (error) { toastError(error); } };
  const changeIcon = async () => {
    const file = iconInput.current?.files?.[0]; if (!file) return;
    try { await uploadIcon(variants.length ? variants : [game], file); await refresh(); toast('Icon updated.'); }
    catch (error) { toastError(error); }
    finally { if (iconInput.current) iconInput.current.value = ''; }
  };
  const dropIcon = async () => {
    try { await removeIcon(variants); await refresh(); toast('Icon removed.'); }
    catch (error) { toastError(error); }
  };
  const copyId = async () => { toast((await copyText(game.id)) ? 'Copied.' : 'Select the text and copy it manually.'); };
  const remove = async () => {
    setDeleteBusy(true);
    try {
      await write(`${path}?${new URLSearchParams({ confirm: game.bundle_id })}`, { method: 'DELETE' });
      setDeleting(false);
      await navigate({ to: '/' });
      await refresh();
    } catch (error) { toastError(error); }
    finally { setDeleteBusy(false); }
  };
  const targetName = me.workspaces.find((item) => item.id === target)?.name || '';

  if (query.isError && query.data === undefined) {
    return <>{errorStatus(query.error) === 404 ? <Heading title="Game not found" subtitle="This game is not in your workspace." /> : <Heading title="Game settings" subtitle="The settings couldn’t load." />}<LoadError error={query.error} onRetry={() => query.refetch()} /><Link className="button" to="/">Back to games</Link></>;
  }
  return (
    <QueryRegion query={query} path={path} skeleton={<Skeleton kind="stats" />}>{(detail) => {
      const archived = Boolean(detail.archived_at);
      const thresholds = detail.analytics_thresholds;
      return (
        <>
          <Heading title="Game settings" subtitle={`${detail.bundle_id} · ${platformLabel(detail.platform)}`} actions={
            <div className="heading-actions">{manage ? <button type="button" className="button" onClick={() => setEditing(true)}><Ico name="settings" size={15} /> Edit</button> : null}<Link className="button" to={gamePath(game, 'exports')}><Ico name="export" size={15} /> Export data</Link></div>
          } />
          {archived ? <div className="archived-banner"><Ico name="lock" size={18} /><div><strong>Archived {displayDate(detail.archived_at)}.</strong> Collection is paused: the server refuses new events, and the Unity SDK keeps them queued on players’ devices until you restore the game.</div>{manage ? <button type="button" className="button" onClick={() => void restore()}>Restore game</button> : null}</div> : null}
          <section className="kpis">
            <Metric label="Events collected" value={number(detail.events)} note={`${number(detail.event_names)} distinct event names`} />
            <Metric label="Events today" value={number(detail.today)} note="Received today · UTC" />
            <Metric label="API keys" value={`${detail.keys_active} active`} note={`${detail.keys_total} created in total`} />
            <Metric label="Storage" value={fileSize(detail.storage_bytes)} note="Event database on disk" />
          </section>
          <div className="section-grid section-spacing">
            <section className="panel">
              <div className="panel-header"><h2>Game</h2></div>
              <div className="panel-body">
                <div className="game-identity">
                  <GameAvatar name={detail.name} games={variants} className="icon-large" />
                  <div className="game-identity-text">
                    <strong>{detail.name}</strong>
                    <code>{detail.bundle_id}</code>
                    <span>{platformLabel(detail.platform)} · {archived ? <span className="pill bad">Archived · collection paused</span> : <span className="pill good">{detail.last_event ? 'Active' : 'Ready for events'}</span>}</span>
                    {manage ? (
                      <div className="icon-actions">
                        <label className="button small-button" htmlFor="icon-file"><Ico name="upload" size={13} /> {detail.icon_updated_at ? 'Change icon' : 'Upload icon'}</label>
                        <input ref={iconInput} id="icon-file" type="file" accept="image/*" hidden onChange={() => void changeIcon()} />
                        {variants.some((item) => item.icon_updated_at) ? <button type="button" className="button small-button danger-text" id="icon-remove" onClick={() => void dropIcon()}>Remove icon</button> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
                <ul className="status-list">
                  <li><span>Latest event</span><strong>{displayDate(detail.last_event)}</strong></li>
                  <li><span>First event</span><strong>{displayDate(detail.first_event)}</strong></li>
                  <li><span>Registered</span><strong>{displayDate(detail.created_at)}</strong></li>
                  <li><span>Event definitions</span><strong>{number(detail.definitions)}</strong></li>
                  <li><span>Game ID</span><span className="copy-row"><code>{detail.id}</code><button type="button" className="icon-button" aria-label="Copy game ID" onClick={() => void copyId()}><Ico name="copy" size={14} /></button></span></li>
                  <li className="notes-row"><span>Notes</span>{detail.notes ? <p>{detail.notes}</p> : <span className="muted">No notes yet</span>}</li>
                </ul>
                <div className="section-spacing"><Link className="button" to={gamePath(game, 'dictionary')}><Ico name="book" size={15} /> Event dictionary</Link></div>
              </div>
            </section>
            <aside className="aside-card connect-card">
              <Ico name="pulse" size={25} />
              <h3>Connect your game</h3>
              <p>Send batches to this address with one of the game’s API keys in the <code>X-API-Key</code> header.</p>
              <div className="connection"><code>POST {overview.ingest_url}</code><CopyButton text={overview.ingest_url} label="Copy collection address" done="Address copied." /></div>
              <Link className="button" to={gamePath(game, 'keys')}><Ico name="key" size={15} /> Manage API keys <span className="muted">({detail.keys_active} active)</span></Link>
              {/* Only worth saying while the address is still a local one. */}
              {/^https:\/\/(?!localhost|127\.)/.test(overview.ingest_url) ? null : <p className="small muted">Set <code>AVN_PUBLIC_INGEST_URL</code> on the server to show your public address here.</p>}
            </aside>
          </div>
          {manage ? <AccessPanel game={game} /> : null}
          <h2 className="settings-group">Data collection</h2>
          <Fold name="activity" title="Event activity" disclosures={folds} summary={`${number(detail.today)} received today · ${number(detail.events)} in total`}><div id="activity"><Activity game={game} /></div></Fold>
          <Fold name="confidence" title="Analysis confidence" disclosures={folds} summary={`Levels need ${number(thresholds.levels_min_players)} players, funnels ${number(thresholds.funnels_min_players)}${thresholds.levels_override != null || thresholds.funnels_override != null ? ' · customised' : ' · workspace defaults'}`}><ThresholdsPanel game={game} thresholds={thresholds} manage={manage} /></Fold>
          <Fold name="environment" title="Environment" disclosures={folds} summary="Re-count a build that reported the wrong environment"><EnvironmentPanel game={game} manage={manage} /></Fold>
          {(me.is_admin && me.workspaces.length > 1) || manage ? <h2 className="settings-group">Housekeeping</h2> : null}
          {me.is_admin && me.workspaces.length > 1 ? (
            <Fold name="workspace" title="Workspace" disclosures={folds} summary={`In ${workspaceName}${variants.length > 1 ? ' · moves with its other platform' : ''}`}>
              <p className="help">Members’ per-game access is cleared when the game moves.</p>
              <div className="icon-actions">
                <select id="move-target" aria-label="Move to workspace" value={target} onChange={(event) => setTarget(event.target.value)}>{me.workspaces.filter((item) => item.id !== workspace).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
                <button className="button" type="button" id="move-game" onClick={() => setMoving(true)}>Move game…</button>
              </div>
            </Fold>
          ) : null}
          {manage ? <Fold name="versions" title="Data by version" disclosures={folds} summary="Delete what old builds sent"><VersionDataPanel game={game} bundleId={detail.bundle_id} /></Fold> : null}
          {manage ? (
            <section className="panel section-spacing danger-zone">
              <div className="panel-header"><div><h2>Danger zone</h2><p>Changes here affect live data collection.</p></div></div>
              <div className="panel-body">
                <div className="danger-row"><div><strong>{archived ? 'Restore this game' : 'Archive this game'}</strong><p>{archived ? 'Start accepting events again. Queued events on devices will be delivered.' : 'Pause collection without deleting anything. You can restore it at any time.'}</p></div><button type="button" className="button" onClick={() => void (archived ? restore() : archive())}>{archived ? 'Restore game' : 'Archive game'}</button></div>
                <div className="danger-row"><div><strong>Delete this game</strong><p>Removes the game and all of its API keys. Its event database is moved to the server’s <code>data/deleted</code> folder, not erased.</p></div><button type="button" className="button danger" onClick={() => setDeleting(true)}>Delete game</button></div>
              </div>
            </section>
          ) : null}
          <EditGameDialog game={detail} open={editing} onClose={() => setEditing(false)} onSave={(values) => update(values, 'Game updated.')} />
          <ConfirmDialog open={moving} onClose={() => setMoving(false)} title={`Move ${detail.name} to ${targetName}?`} label="Move game"
            message={`${variants.length > 1 ? 'Both platform versions move. ' : ''}Events, keys, funnels and the dictionary go with it, and collection keeps working. Members of ${workspaceName} lose their access to it, and you can grant it again in ${targetName}.`}
            onConfirm={async () => {
              await write(`${path}/move`, { method: 'POST', body: JSON.stringify({ workspace_id: target }) });
              chooseWorkspace(target); toast('Game moved.');
              await refresh();
              await navigate({ to: gamePath(game, 'settings') });
            }} />
          <DeleteGameDialog game={detail} open={deleting} onClose={() => { if (!deleteBusy) setDeleting(false); }} onConfirm={() => void remove()} busy={deleteBusy} />
        </>
      );
    }}</QueryRegion>
  );
}

/* ─── Analysis confidence: per-game overrides of the workspace thresholds ─── */
function ThresholdsPanel({ game, thresholds, manage }: { game: Game; thresholds: GameDetail['analytics_thresholds']; manage: boolean }): ReactElement {
  const { refresh } = useSession();
  const { toast } = useNotify();
  const { onSubmit, busy, error } = useSubmit(async (values) => {
    const payload = Object.fromEntries(Object.entries({ ...values, retention_min_users: thresholds.retention_override == null ? '' : String(thresholds.retention_override) }).map(([key, value]) => [key, value === '' ? null : Number(value)]));
    await write(`${gameURL(game)}/analytics-thresholds`, { method: 'PATCH', body: JSON.stringify(payload) });
    await refresh();
    toast('Game confidence thresholds saved.');
  });
  return (
    <section className="panel section-spacing">
      <div className="panel-header"><div><h2>Analysis confidence</h2><p>Small samples stay visible with a warning. Leave a field blank to inherit the workspace default.</p></div></div>
      <form className="panel-body" id="game-threshold-form" onSubmit={onSubmit}>
        <div className="threshold-grid">
          <Field label="Level minimum players" htmlFor="game-levels-min" help={`Effective: ${number(thresholds.levels_min_players)}`}><input id="game-levels-min" name="levels_min_players" type="number" min={1} max={1000000} defaultValue={thresholds.levels_override ?? ''} placeholder={String(thresholds.levels_min_players)} disabled={!manage} /></Field>
          <Field label="Funnel minimum players" htmlFor="game-funnels-min" help={`Effective: ${number(thresholds.funnels_min_players)}`}><input id="game-funnels-min" name="funnels_min_players" type="number" min={1} max={1000000} defaultValue={thresholds.funnels_override ?? ''} placeholder={String(thresholds.funnels_min_players)} disabled={!manage} /></Field>
        </div>
        {error ? <FormError error={error} /> : null}
        {manage ? <button className="button primary" type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Working…' : 'Save game overrides'}</button> : <p className="help">Only an admin or team lead can change these values.</p>}
      </form>
    </section>
  );
}
