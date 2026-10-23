// API keys of a game: the list, "Create key" (label → one-time key dialog), copy the full key, delete.
import { useState, type ReactElement } from 'react';
import { useRead, write } from '@/api';
import { useSession } from '@/app/session';
import { gameURL } from '@/lib/games';
import { displayDate } from '@/lib/format';
import { copyText } from '@/lib/store';
import type { ApiKey, Game } from '@/lib/types';
import { ConfirmDialog, DialogShell, Heading, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Field, FormError, useSubmit } from '@/components/forms';
import { Ico } from '@/components/icons';
import { ShowKeyDialog, type ShownKey } from '@/components/ShowKeyDialog';

function CreateKeyDialog({ game, open, onClose, onCreated }: { game: Game; open: boolean; onClose: () => void; onCreated: (key: ApiKey) => void }): ReactElement {
  const { onSubmit, busy, error } = useSubmit(async (values) => { onCreated(await write<ApiKey>(`${gameURL(game)}/keys`, { method: 'POST', body: JSON.stringify(values) })); });
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }} title="Create a collection key">
      <p>Give it a label so you can recognize the release or environment.</p>
      <form id="key-form" onSubmit={onSubmit}>
        <Field label="Key label" htmlFor="key-label"><input id="key-label" name="label" placeholder="e.g. Android production" required maxLength={128} autoFocus /></Field>
        {error ? <FormError error={error} /> : null}
        <div className="modal-actions"><button type="button" className="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Working…' : 'Create key'}</button></div>
      </form>
    </DialogShell>
  );
}

export function KeysPage({ game }: { game: Game }): ReactElement {
  const { canManageGames } = useSession();
  const { toast } = useNotify();
  const path = `${gameURL(game)}/keys`;
  const query = useRead<ApiKey[]>(path);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<ShownKey | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);
  const copy = async (key: string) => { toast((await copyText(key)) ? 'Full key copied.' : 'Copy failed — your browser blocked clipboard access.'); };
  return (
    <>
      <Heading title="API keys" subtitle="A connection for every release. Everyone on the team can copy them; admins and leads manage them." actions={canManageGames ? <button type="button" className="button primary" onClick={() => setCreating(true)}><Ico name="plus" size={15} /> Create key</button> : undefined} />
      <QueryRegion query={query} path={path} skeleton={<Skeleton rows={3} columns={5} />}>{(keys) => (
        <section className="panel">
          <div className="panel-header"><h2>Collection keys <span className="count">{keys.length}</span></h2><span className="small muted">Copy a key any time. Keys made before this update can’t be copied</span></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Label</th><th>Key prefix</th><th>Created</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>{keys.map((key) => (
              <tr key={key.id}>
                <td>{key.label}</td>
                <td><code>{key.prefix}…</code> {key.api_key ? <button type="button" className="icon-button copy-prefix" aria-label="Copy full key" title="Copy full key" onClick={() => void copy(key.api_key!)}><Ico name="copy" size={14} /></button> : <button type="button" className="icon-button copy-prefix" disabled aria-label="Full key unavailable" title="Created before full keys were kept — create a new key to copy it"><Ico name="copy" size={14} /></button>}</td>
                <td className="small muted">{displayDate(key.created_at)}</td>
                <td><span className={`pill ${key.revoked_at ? '' : 'good'}`}>{key.revoked_at ? 'Revoked' : 'Active'}</span></td>
                <td>{canManageGames ? <button type="button" className="button danger table-action" onClick={() => setDeleting(key)}>Delete</button> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}</QueryRegion>
      <p className="help section-spacing">These keys identify your game builds. Never use your admin credentials in a game client.</p>
      <CreateKeyDialog game={game} open={creating} onClose={() => setCreating(false)} onCreated={(key) => { setCreating(false); setShown({ key: key.api_key || '', title: 'Your new key is ready.', next: location.pathname + location.search }); }} />
      <ShowKeyDialog shown={shown} onClose={() => setShown(null)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} title="Delete this key?" message="Game builds using this key will no longer be able to send events. Existing collected data stays safe — events belong to the game, not the key. This can’t be undone." label="Delete key" danger
        onConfirm={async () => { await write(`${gameURL(game)}/keys/${deleting!.id}`, { method: 'DELETE' }); toast('Key deleted.'); }} />
    </>
  );
}
