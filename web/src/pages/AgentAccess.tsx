// Agent access (admin): read-only keys that let an AI agent look at the games' data over MCP.
// A list of keys (what each can read, when it was last used, on or off), "Create key", and per key
// "Connect" (copy-paste setup for each agent) and "Edit" (scope, link, on/off, new key text, delete).
import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { useRead, write } from '@/api';
import { useSession } from '@/app/session';
import { displayDate, number, platformLabel } from '@/lib/format';
import type { Game, McpKey, McpKeyList, WorkspaceItem } from '@/lib/types';
import { ConfirmDialog, DialogShell, Heading, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { CopyButton } from '@/components/CopyButton';
import { FormError, useSubmit } from '@/components/forms';
import { Ico } from '@/components/icons';

const gameLabel = (game: Game): string => `${game.name} · ${platformLabel(game.platform)}`;

/** What a key can read, in a few words: whole workspaces first, then single games. */
export function scopeText(key: Pick<McpKey, 'workspace_ids' | 'game_ids'>, workspaces: WorkspaceItem[], games: Game[]): string {
  const names = new Map(workspaces.map((item) => [item.id, item.name]));
  const whole = new Set(key.workspace_ids);
  const parts = key.workspace_ids.map((id) => `All of ${names.get(id) ?? 'a removed workspace'}`);
  const single = key.game_ids.map((id) => games.find((game) => game.id === id)).filter((game): game is Game => !!game && !whole.has(game.workspace_id ?? ''));
  if (single.length) parts.push(single.length <= 2 ? single.map(gameLabel).join(', ') : `${single.length} games`);
  return parts.join(' + ') || 'Nothing';
}

export type ConnectOption = { id: string; label: string; where: string; text: string };

/** The copy-paste setup for each kind of agent. The key goes in the Authorization header; the link form is only for apps that take a link. */
export function connectOptions(key: Pick<McpKey, 'endpoint' | 'secret' | 'link'>): ConnectOption[] {
  const header = `Bearer ${key.secret}`;
  return [
    { id: 'claude-code', label: 'Claude Code', where: 'Run this in a terminal.', text: `claude mcp add --transport http avn-analytics ${key.endpoint} --header "Authorization: ${header}"` },
    { id: 'codex', label: 'Codex', where: 'Add this to ~/.codex/config.toml.', text: `[mcp_servers.avn-analytics]\nurl = "${key.endpoint}"\nhttp_headers = { Authorization = "${header}" }` },
    { id: 'json', label: 'Cursor and others', where: 'Add this to the app’s MCP settings (Cursor: ~/.cursor/mcp.json).', text: JSON.stringify({ mcpServers: { 'avn-analytics': { url: key.endpoint, headers: { Authorization: header } } } }, null, 2) },
    { id: 'link', label: 'Claude app', where: key.link ? 'Add a custom connector and paste this address as its URL.' : 'This app only takes a link. Edit the key and allow the link, then come back here.', text: key.link ?? '' },
  ];
}

type Dialog = { kind: 'create' } | { kind: 'edit'; key: McpKey } | { kind: 'connect'; key: McpKey } | { kind: 'regenerate'; key: McpKey } | { kind: 'delete'; key: McpKey } | null;

/** Pick workspaces (all their games, present and future) and/or single games. */
function ScopePicker({ workspaces, games, chosenWorkspaces, chosenGames, onWorkspaces, onGames }: { workspaces: WorkspaceItem[]; games: Game[]; chosenWorkspaces: string[]; chosenGames: string[]; onWorkspaces: (ids: string[]) => void; onGames: (ids: string[]) => void }): ReactElement {
  const flip = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((item) => item !== id));
  return (
    <div className="scope-picker">
      {workspaces.map((workspace) => {
        const whole = chosenWorkspaces.includes(workspace.id);
        const inside = games.filter((game) => game.workspace_id === workspace.id);
        return (
          <fieldset key={workspace.id} className="scope-group">
            <legend>{workspace.name}</legend>
            <label className="check-row"><input type="checkbox" checked={whole} onChange={(event) => onWorkspaces(flip(chosenWorkspaces, workspace.id, event.target.checked))} /> All games in {workspace.name}, including ones added later</label>
            {whole ? null : inside.length ? (
              <div className="check-list">{inside.map((game) => <label key={game.id} className="check-row"><input type="checkbox" checked={chosenGames.includes(game.id)} onChange={(event) => onGames(flip(chosenGames, game.id, event.target.checked))} /> {gameLabel(game)}</label>)}</div>
            ) : <p className="help">No games here yet.</p>}
          </fieldset>
        );
      })}
    </div>
  );
}

function KeyDialog({ existing, workspaces, games, onClose, onSaved, onDanger }: { existing: McpKey | null; workspaces: WorkspaceItem[]; games: Game[]; onClose: () => void; onSaved: (key: McpKey, created: boolean) => void; onDanger: (kind: 'regenerate' | 'delete', key: McpKey) => void }): ReactElement {
  const [chosenWorkspaces, setWorkspaces] = useState<string[]>(existing?.workspace_ids ?? []);
  const [chosenGames, setGames] = useState<string[]>(existing?.game_ids ?? []);
  const { onSubmit, busy, error } = useSubmit(async (values) => {
    if (!chosenWorkspaces.length && !chosenGames.length) throw new Error('Choose at least one workspace or game for this key to read.');
    const body = { name: values.name, workspace_ids: chosenWorkspaces, game_ids: chosenGames, url_access: values.url_access === 'on', ...(existing ? { enabled: values.enabled === 'on' } : {}) };
    const saved = existing
      ? await write<McpKey>(`/v1/mcp-keys/${existing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
      : await write<McpKey>('/v1/mcp-keys', { method: 'POST', body: JSON.stringify(body) });
    onSaved(saved, !existing);
  });
  return (
    <DialogShell open onOpenChange={(next) => { if (!next && !busy) onClose(); }} title={existing ? `Edit “${existing.name}”` : 'Create a key'} className="agent-dialog">
      <form id="mcp-key-form" onSubmit={onSubmit}>
        <div className="field"><label htmlFor="mcp-key-name">Name</label><input id="mcp-key-name" name="name" required maxLength={80} defaultValue={existing?.name} placeholder="e.g. Maya’s Claude" autoFocus={!existing} autoComplete="off" /><p>Who or what it is for, so you can tell the keys apart.</p></div>
        <div className="field"><label>What it can read</label><ScopePicker workspaces={workspaces} games={games} chosenWorkspaces={chosenWorkspaces} chosenGames={chosenGames} onWorkspaces={setWorkspaces} onGames={setGames} /></div>
        <label className="check-row"><input type="checkbox" name="url_access" defaultChecked={existing?.url_access} /> Also allow the key inside a link, for apps that only take a link (the key then appears in server logs)</label>
        {existing ? <label className="check-row"><input type="checkbox" name="enabled" defaultChecked={existing.enabled} /> Key is on (switch it off to stop it working without deleting it)</label> : null}
        <FormError error={error} />
        <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Working…' : existing ? 'Save' : 'Create key'}</button></div>
      </form>
      {existing ? (
        <div className="danger-zone">
          <p className="eyebrow">Danger zone</p>
          <div className="danger-row"><span>Make a new key text. Everyone using the old one stops working.</span><button type="button" className="button danger table-action" onClick={() => onDanger('regenerate', existing)}>New key text</button></div>
          <div className="danger-row"><span>Delete this key for good.</span><button type="button" className="button danger table-action" onClick={() => onDanger('delete', existing)}>Delete</button></div>
        </div>
      ) : null}
    </DialogShell>
  );
}

function ConnectDialog({ keyItem, scope, onClose }: { keyItem: McpKey; scope: string; onClose: () => void }): ReactElement {
  const options = connectOptions(keyItem);
  const [choice, setChoice] = useState(options[0]!.id);
  const option = options.find((item) => item.id === choice)!;
  return (
    <DialogShell open onOpenChange={(next) => { if (!next) onClose(); }} title={`Connect “${keyItem.name}”`} className="agent-dialog">
      <p>This key can only read: <strong>{scope}</strong>. It can’t change anything. Pick the agent, copy the text and paste it where it says.</p>
      <div className="seg-row range-modes" role="group" aria-label="Agent">
        {options.map((item) => <button key={item.id} type="button" aria-pressed={choice === item.id} onClick={() => setChoice(item.id)}>{item.label}</button>)}
      </div>
      <p className="small">{option.where}</p>
      {option.text ? (
        <div className="snippet"><pre tabIndex={0}>{option.text}</pre><CopyButton text={option.text} label={`Copy the ${option.label} setup`} done="Copied" /></div>
      ) : null}
      <div className="modal-actions"><button type="button" className="button primary" onClick={onClose}>Done</button></div>
    </DialogShell>
  );
}

export function AgentAccessPage(): ReactElement {
  const { me } = useSession();
  const { toast } = useNotify();
  const [dialog, setDialog] = useState<Dialog>(null);
  const keys = useRead<McpKeyList>(me.can_manage_team ? '/v1/mcp-keys' : null);
  const workspaces = useRead<WorkspaceItem[]>(me.can_manage_team ? '/v1/workspaces' : null);
  const games = useRead<Game[]>(me.can_manage_team ? '/v1/games' : null);
  if (!me.can_manage_team) return <><Heading title="Agent access" subtitle="Only the admin can manage agent keys." /><Link className="button" to="/">Back to games</Link></>;
  const close = () => setDialog(null);
  const workspaceList = workspaces.data ?? [];
  const gameList = games.data ?? [];
  const scope = (key: McpKey) => scopeText(key, workspaceList, gameList);
  return (
    <>
      <Heading title="Agent access" subtitle="Read-only keys that let an AI agent (Claude Code, Codex, the Claude app…) look at your games’ data. Whoever has a key can read what it allows. If one leaks, switch it off or make a new key text." actions={<button type="button" className="button primary" id="create-mcp-key" onClick={() => setDialog({ kind: 'create' })} disabled={!workspaces.data || !games.data}><Ico name="plus" size={15} /> Create key</button>} />
      <QueryRegion query={keys} path="/v1/mcp-keys" skeleton={<Skeleton rows={3} columns={5} />}>{(list) => (
        <section className="panel">
          <div className="panel-header"><h2>Keys <span className="count">{list.keys.length}</span></h2>{list.enabled ? null : <span className="pill warn">Agent access is switched off on this server</span>}</div>
          {list.keys.length ? (
            <div className="table-wrap"><table className="keys-table">
              <thead><tr><th>Name</th><th>Can read</th><th>Last used</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{list.keys.map((key) => (
                <tr key={key.id} data-key={key.name}>
                  <td>{key.name}<p className="small muted">Made {displayDate(key.created_at)}</p></td>
                  <td data-label="Can read">{scope(key)}{key.workspace_ids.length ? <p className="small muted">{number(key.games)} game{key.games === 1 ? '' : 's'} now</p> : null}</td>
                  <td data-label="Last used">{key.last_used_at ? <>{displayDate(key.last_used_at)}<p className="small muted">{number(key.calls)} call{key.calls === 1 ? '' : 's'}</p></> : <span className="muted">Never</span>}</td>
                  <td data-label="Status"><span className={`pill ${key.enabled ? 'good' : ''}`}>{key.enabled ? 'On' : 'Off'}</span></td>
                  <td className="row-actions"><button type="button" className="button table-action" onClick={() => setDialog({ kind: 'connect', key })}>Connect</button> <button type="button" className="button table-action" onClick={() => setDialog({ kind: 'edit', key })}>Edit</button></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="help panel-body">No keys yet. Create one to let an agent read a game’s data.</p>}
        </section>
      )}</QueryRegion>

      {dialog?.kind === 'create' || dialog?.kind === 'edit' ? (
        <KeyDialog key={dialog.kind === 'edit' ? dialog.key.id : 'new'} existing={dialog.kind === 'edit' ? dialog.key : null} workspaces={workspaceList} games={gameList} onClose={close}
          onSaved={(saved, created) => { if (created) setDialog({ kind: 'connect', key: saved }); else { close(); toast('Key saved.'); } }}
          onDanger={(kind, key) => setDialog({ kind, key })} />
      ) : null}
      {dialog?.kind === 'connect' ? <ConnectDialog keyItem={dialog.key} scope={scope(dialog.key)} onClose={close} /> : null}
      {dialog?.kind === 'regenerate' ? (
        <ConfirmDialog open onClose={() => setDialog((current) => (current?.kind === 'regenerate' ? null : current))} title={`Make a new key text for “${dialog.key.name}”?`} label="Make new key text" danger
          message="The old text stops working at once, for everyone who has it. You’ll get the new text to share."
          onConfirm={async () => { const fresh = await write<McpKey>(`/v1/mcp-keys/${dialog.key.id}/regenerate`, { method: 'POST' }); setDialog({ kind: 'connect', key: fresh }); }} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog open onClose={close} title={`Delete “${dialog.key.name}”?`} label="Delete key" danger
          message="Anyone using this key stops being able to read your data. Your data isn’t touched. This can’t be undone."
          onConfirm={async () => { await write(`/v1/mcp-keys/${dialog.key.id}`, { method: 'DELETE' }); toast('Key deleted.'); }} />
      ) : null}
    </>
  );
}
