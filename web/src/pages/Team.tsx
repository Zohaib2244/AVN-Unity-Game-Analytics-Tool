// Team management (admin): who can use the workspace and what they can do there, admins, recent
// activity; and the workspaces list (create, rename, delete, who may use NutBot).
import { useState, type ReactElement, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { confirmsName } from '@avn/ui';
import { useRead, write } from '@/api';
import { useSession } from '@/app/session';
import { displayDate, number, platformLabel } from '@/lib/format';
import type { AuditEntry, Game, TeamPerson, WorkspaceItem } from '@/lib/types';
import { ConfirmDialog, DialogShell, Heading, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { FormError, useSubmit, type Values } from '@/components/forms';
import { Ico } from '@/components/icons';

const ACTION_LABELS: Record<string, string> = {
  'game.register': 'Registered a game', 'game.update': 'Edited a game', 'game.delete': 'Deleted a game',
  'icon.set': 'Changed a game icon', 'icon.clear': 'Removed a game icon',
  'key.create': 'Created an API key', 'key.delete': 'Deleted an API key',
  'dictionary.set': 'Edited the event dictionary', 'dictionary.delete': 'Removed a dictionary entry',
  'export.download': 'Exported data', 'user.add': 'Added a person', 'user.role': 'Changed a role',
  'user.remove': 'Removed a person', 'workspace.create': 'Created a workspace', 'workspace.rename': 'Renamed a workspace', 'workspace.delete': 'Deleted a workspace', 'game.move': 'Moved a game', 'environment.fix': 'Re-counted a build’s environment', 'environment.unfix': 'Undid an environment re-count', 'access.set': 'Changed a person’s games', 'access.game': 'Changed who sees a game', 'analytics.start': 'Started analytics processing', 'analytics.stop': 'Stopped analytics processing',
};
const gameLabel = (game: Game): string => `${game.name} · ${platformLabel(game.platform)}`;
const personName = (person: Pick<TeamPerson, 'name' | 'email'>): string => person.name || person.email.split('@')[0]!;
const seen = (value: string | null | undefined): string => (value ? displayDate(value) : 'Never');
const checkedGames = (form: HTMLFormElement): string[] => [...form.querySelectorAll<HTMLInputElement>('input[name="game"]:checked')].map((input) => input.value);

function AdminOnly({ title, message }: { title: string; message: string }): ReactElement {
  return <><Heading title={title} subtitle={message} /><Link className="button" to="/">Back to games</Link></>;
}

/** A dialog holding one form: the submit button shows it is working, errors land in the form's alert line. */
function FormDialog({ open, onClose, title, submit, label, danger, children }: { open: boolean; onClose: () => void; title: string; submit: (values: Values, form: HTMLFormElement) => Promise<void>; label: string; danger?: boolean; children: ReactNode }): ReactElement {
  const { onSubmit, busy, error } = useSubmit(submit);
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }} title={title}>
      <form onSubmit={onSubmit}>
        {children}
        <FormError error={error} />
        <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button className={`button ${danger ? 'danger' : 'primary'}`} type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Working…' : label}</button></div>
      </form>
    </DialogShell>
  );
}

function GameBoxes({ games, chosen }: { games: Game[]; chosen: string[] }): ReactElement {
  if (!games.length) return <p className="help">No games in this workspace yet.</p>;
  return <div className="check-list">{games.map((game) => <label key={game.id} className="check-row"><input type="checkbox" name="game" value={game.id} defaultChecked={chosen.includes(game.id)} /> {gameLabel(game)}</label>)}</div>;
}

/* ─── Team ─── */
type TeamDialog = { kind: 'add' } | { kind: 'games'; person: TeamPerson } | { kind: 'remove'; person: TeamPerson } | null;

export function TeamPage(): ReactElement {
  const session = useSession();
  const { me, overview, workspace: here, workspaceName } = session;
  const { toast, toastError } = useNotify();
  const [dialog, setDialog] = useState<TeamDialog>(null);
  const [role, setRole] = useState('member');
  const people = useRead<TeamPerson[]>(me.can_manage_team ? '/v1/team' : null);
  const activity = useRead<AuditEntry[]>(me.can_manage_team ? '/v1/audit' : null);
  if (!me.can_manage_team) return <AdminOnly title="Team" message="Only the admin can manage the team." />;

  const games = overview.games;
  const names = Object.fromEntries(games.map((game) => [game.id, gameLabel(game)]));
  const reload = async (message?: string) => { await session.refresh(); if (message) toast(message); };
  const patch = (email: string, body: unknown) => write(`/v1/team/${encodeURIComponent(email)}`, { method: 'PATCH', body: JSON.stringify(body) });
  const close = () => { setDialog(null); setRole('member'); };
  const changeRole = async (email: string, value: string) => {
    try { await patch(email, { workspace_id: here, role: value }); await reload('Role updated.'); }
    catch (error) { toastError(error); await reload(); }
  };
  const demote = async (email: string) => {
    try { await patch(email, { admin: false }); await reload('Admin rights removed. They keep any workspace roles they have.'); } catch (error) { toastError(error); }
  };

  return (
    <>
      <Heading title="Team" subtitle={`Who can use ${workspaceName}, and what they can do there. People who sign in without being listed see a “no access” page.`} actions={<button type="button" className="button primary" id="add-person" onClick={() => setDialog({ kind: 'add' })}><Ico name="plus" size={15} /> Add person</button>} />
      <QueryRegion query={people} path="/v1/team" skeleton={<Skeleton rows={4} columns={5} />}>{(list) => {
        const members = list.filter((person) => here && person.memberships[here]);
        const admins = list.filter((person) => person.admin);
        return (
          <>
            <section className="panel">
              <div className="panel-header"><h2>{workspaceName} <span className="count">{members.length}</span></h2><p className="small muted">Team lead: manages the workspace’s games and who sees them · Member: works with the games they’re given</p></div>
              {members.length ? (
                <div className="table-wrap"><table><thead><tr><th>Person</th><th>Role</th><th>Games</th><th>Last seen</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
                  {members.map((person) => {
                    const membership = here ? person.memberships[here] : undefined;
                    const count = person.game_ids.filter((id) => names[id]).length;
                    return (
                      <tr key={person.email} data-email={person.email}>
                        <td>{personName(person)}<p className="small muted">{person.email}</p></td>
                        <td><select aria-label={`Role of ${person.email}`} value={membership === 'lead' ? 'lead' : 'member'} onChange={(event) => void changeRole(person.email, event.target.value)}><option value="member">Member</option><option value="lead">Team lead</option></select></td>
                        <td>{membership === 'member' ? <button type="button" className="link-button" onClick={() => setDialog({ kind: 'games', person })}>{count ? `${count} game${count === 1 ? '' : 's'}` : 'None yet'} · choose</button> : <span className="muted">All games</span>}</td>
                        <td className="small muted">{seen(person.last_seen_at)}</td>
                        <td><button type="button" className="button danger table-action" onClick={() => setDialog({ kind: 'remove', person })}>Remove</button></td>
                      </tr>
                    );
                  })}
                </tbody></table></div>
              ) : <p className="help panel-body">Nobody yet. Add the people who work on these games.</p>}
            </section>
            <section className="panel section-spacing">
              <div className="panel-header"><div><h2>Admins <span className="count">{admins.length}</span></h2><p>See and manage every workspace, plus workspaces and people</p></div></div>
              <div className="table-wrap"><table><tbody>
                {admins.map((person) => <tr key={person.email} data-admin={person.email}><td>{personName(person)}<p className="small muted">{person.email}</p></td><td className="small muted">{seen(person.last_seen_at)}</td><td>{person.email === me.email ? <span className="muted small">You</span> : <button type="button" className="button danger table-action" onClick={() => void demote(person.email)}>Remove admin</button>}</td></tr>)}
              </tbody></table></div>
            </section>
          </>
        );
      }}</QueryRegion>
      <QueryRegion query={activity} path="/v1/audit" skeleton={<Skeleton rows={6} columns={4} />}>{(items) => (
        <section className="panel section-spacing">
          <div className="panel-header"><div><h2>Recent activity</h2><p>The last {items.length} changes across every workspace</p></div></div>
          {items.length ? (
            <div className="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
              {items.map((item, index) => <tr key={`${item.at}-${index}`}><td className="small muted">{displayDate(item.at)}</td><td className="small">{item.actor}</td><td>{ACTION_LABELS[item.action] || item.action}</td><td className="small muted">{item.game_id && names[item.game_id] ? `${names[item.game_id]} · ` : ''}{item.detail}</td></tr>)}
            </tbody></table></div>
          ) : <p className="help panel-body">Nothing yet.</p>}
        </section>
      )}</QueryRegion>

      <FormDialog open={dialog?.kind === 'add'} onClose={close} title={`Add a person to ${workspaceName}`} label="Add person" submit={async (values, form) => {
        await write('/v1/team', { method: 'POST', body: JSON.stringify({ email: values.email, name: values.name, role: values.role, workspace_id: here, game_ids: values.role === 'member' ? checkedGames(form) : [] }) });
        close(); await reload('Person added.');
      }}>
        <p>They sign in through Cloudflare, so also allow their email there. This list decides what they can do.</p>
        <div className="field"><label htmlFor="person-email">Email</label><input id="person-email" name="email" type="email" required placeholder="name@example.com" autoComplete="off" /></div>
        <div className="field"><label htmlFor="person-name">Name (optional)</label><input id="person-name" name="name" maxLength={80} /></div>
        <div className="field"><label htmlFor="person-role">Role</label><select id="person-role" name="role" value={role} onChange={(event) => setRole(event.target.value)}><option value="member">Member: works with the games they’re given</option><option value="lead">Team lead: manages this workspace’s games and who sees them</option><option value="admin">Admin: everything, in every workspace</option></select></div>
        <div className="field" id="person-games" hidden={role !== 'member'}><label>Games they can see</label><GameBoxes games={games} chosen={[]} /></div>
      </FormDialog>

      {dialog?.kind === 'games' ? (
        <FormDialog open onClose={close} title={`Games for ${dialog.person.name || dialog.person.email}`} label="Save" submit={async (_values, form) => {
          await patch(dialog.person.email, { workspace_id: here, game_ids: checkedGames(form) });
          close(); await reload('Access updated.');
        }}>
          <p>{dialog.person.email} can open only the games ticked here.</p>
          <GameBoxes games={games} chosen={dialog.person.game_ids} />
        </FormDialog>
      ) : null}

      {dialog?.kind === 'remove' ? (
        <ConfirmDialog open onClose={close} title={`Remove ${dialog.person.name || dialog.person.email} from ${workspaceName}?`} label="Remove" danger
          message={`They lose access to this workspace immediately${Object.keys(dialog.person.memberships).length > 1 ? ' and keep their other workspaces' : ', and will see a “no access” page if they have no other workspace'}.`}
          onConfirm={async () => { await write(`/v1/team/${encodeURIComponent(dialog.person.email)}?workspace_id=${encodeURIComponent(here ?? '')}`, { method: 'DELETE' }); await reload('Person removed.'); }} />
      ) : null}
    </>
  );
}

/* ─── Workspaces ─── */
type WorkspaceDialog = { kind: 'new' } | { kind: 'rename'; item: WorkspaceItem } | { kind: 'delete'; item: WorkspaceItem } | null;
const NUTBOT_OPTIONS: Array<[string, string]> = [['admins', 'Admins only'], ['leads', 'Admins + leads'], ['everyone', 'Everyone in it']];

export function WorkspacesPage(): ReactElement {
  const session = useSession();
  const { me, workspace: current, chooseWorkspace } = session;
  const navigate = useNavigate();
  const { toast, toastError } = useNotify();
  const [dialog, setDialog] = useState<WorkspaceDialog>(null);
  const [what, setWhat] = useState('move');
  const [typed, setTyped] = useState('');
  const list = useRead<WorkspaceItem[]>(me.can_manage_team ? '/v1/workspaces' : null);
  if (!me.can_manage_team) return <AdminOnly title="Workspaces" message="Only the admin can manage workspaces." />;

  const reload = async (message?: string) => { await session.refresh(); if (message) toast(message); };
  const close = () => { setDialog(null); setWhat('move'); setTyped(''); };
  const changeNutbot = async (item: WorkspaceItem, access: string) => {
    try {
      await write(`/v1/workspaces/${item.id}/nutbot`, { method: 'PATCH', body: JSON.stringify({ access }) });
      await session.refresh();
      toast(`NutBot: ${(NUTBOT_OPTIONS.find(([value]) => value === access)?.[1] ?? access).toLowerCase()} in ${item.name}.`);
    } catch (error) { toastError(error); await reload(); }
  };
  const askDelete = (item: WorkspaceItem, all: WorkspaceItem[]) => {
    if (!all.some((entry) => entry.id !== item.id)) { toast('There must always be at least one workspace.'); return; }
    setDialog({ kind: 'delete', item });
  };

  return (
    <>
      <Heading title="Workspaces" subtitle="A workspace is a separate set of games and people, such as work and personal projects." actions={<button type="button" className="button primary" id="new-workspace" onClick={() => setDialog({ kind: 'new' })}><Ico name="plus" size={15} /> New workspace</button>} />
      <QueryRegion query={list} path="/v1/workspaces" skeleton={<Skeleton rows={3} columns={5} />}>{(items) => (
        <>
          <section className="panel"><div className="table-wrap"><table><thead><tr><th>Name</th><th className="num">Games</th><th className="num">People</th><th>NutBot</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
            {items.map((item) => (
              <tr key={item.id} data-id={item.id}>
                <td>{item.name}{item.id === current ? <> <span className="pill good">Current</span></> : null}</td>
                <td className="num">{number(item.games)}</td>
                <td className="num">{number(item.members)}</td>
                <td><select aria-label={`Who can use NutBot in ${item.name}`} value={item.nutbot_access} onChange={(event) => void changeNutbot(item, event.target.value)}>{NUTBOT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
                <td className="row-actions">
                  <button type="button" className="button small-button" onClick={() => { chooseWorkspace(item.id); void navigate({ to: '/' }); }}>Open</button>{' '}
                  <button type="button" className="button small-button" onClick={() => setDialog({ kind: 'rename', item })}>Rename</button>{' '}
                  <button type="button" className="button small-button danger-text" onClick={() => askDelete(item, items)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody></table></div></section>
          <p className="help section-spacing">Admins see every workspace. Everyone else sees only the workspaces they’ve been added to, and an admin can move a game between workspaces from its settings. The NutBot column sets who may chat with NutBot in that workspace; others see it locked.</p>

          {dialog?.kind === 'delete' ? (() => {
            const { item } = dialog;
            const others = items.filter((entry) => entry.id !== item.id);
            return (
              <FormDialog open onClose={close} title={`Delete ${item.name}?`} label="Delete workspace" danger submit={async (values) => {
                const query = new URLSearchParams({ confirm: values.confirm ?? '' });
                if (item.games) { if (values.what === 'move') query.set('move_to', values.target ?? ''); else query.set('delete_games', 'true'); }
                await write(`/v1/workspaces/${item.id}?${query}`, { method: 'DELETE' });
                close();
                if (current === item.id) chooseWorkspace((values.what === 'move' ? values.target : null) || others[0]?.id || null);
                await reload('Workspace deleted.');
              }}>
                <p>This removes the workspace and takes its {number(item.members)} {item.members === 1 ? 'person' : 'people'} out of it.</p>
                {item.games ? (
                  <div className="field">
                    <label className="check-row"><input type="radio" name="what" value="move" checked={what === 'move'} onChange={() => setWhat('move')} /> Move its {number(item.games)} game{item.games === 1 ? '' : 's'} to another workspace</label>
                    <select name="target" aria-label="Move games to" defaultValue={others[0]?.id}>{others.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
                    <label className="check-row"><input type="radio" name="what" value="delete" checked={what === 'delete'} onChange={() => setWhat('delete')} /> Delete its games too (their data goes to the server’s <code>data/deleted</code> folder, not erased)</label>
                  </div>
                ) : null}
                <div className="field"><label htmlFor="ws-confirm">Type <code>{item.name}</code> to confirm</label><input id="ws-confirm" name="confirm" autoComplete="off" required value={typed} onChange={(event) => setTyped(event.target.value)} aria-describedby="ws-confirm-help" /></div>
                <p id="ws-confirm-help" className="small muted" hidden={confirmsName(typed, item.name)}>The Delete button unlocks once the name matches.</p>
              </FormDialog>
            );
          })() : null}
        </>
      )}</QueryRegion>

      <FormDialog open={dialog?.kind === 'new'} onClose={close} title="New workspace" label="Create" submit={async (values) => {
        await write('/v1/workspaces', { method: 'POST', body: JSON.stringify({ name: values.name }) });
        close(); await reload('Workspace created.');
      }}>
        <div className="field"><label htmlFor="ws-name">Name</label><input id="ws-name" name="name" required maxLength={60} placeholder="e.g. Personal projects" /></div>
      </FormDialog>

      {dialog?.kind === 'rename' ? (
        <FormDialog open onClose={close} title="Rename workspace" label="Save" submit={async (values) => {
          await write(`/v1/workspaces/${dialog.item.id}`, { method: 'PATCH', body: JSON.stringify({ name: values.name }) });
          close(); await reload('Workspace renamed.');
        }}>
          <div className="field"><label htmlFor="ws-name">Name</label><input id="ws-name" name="name" required maxLength={60} defaultValue={dialog.item.name} /></div>
        </FormDialog>
      ) : null}
    </>
  );
}
