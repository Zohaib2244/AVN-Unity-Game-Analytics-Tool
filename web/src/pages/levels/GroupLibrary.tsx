import { useState, type ReactElement } from 'react';
import { Button } from '@avn/ui';
import { errorMessage, useRead, write } from '@/api';
import { DialogShell, LoadError, Skeleton, useNotify } from '@/components/feedback';
import { Field } from '@/components/forms';
import { savedDefinition, type SaveGroupIntent, type SavedGroupItem } from './groupLibrary';

export function GroupLibrary({ path, intent, onCloseSave, onSaved, onNew, onUse, onEdit, busy }: {
  path: string; intent: SaveGroupIntent | null; onCloseSave: () => void; onSaved: (item: SavedGroupItem) => void;
  onNew: (kind: SavedGroupItem['kind']) => void; onUse: (item: SavedGroupItem) => void; onEdit: (item: SavedGroupItem) => void; busy: boolean;
}): ReactElement {
  const query = useRead<SavedGroupItem[]>(path);
  const { toast, toastError } = useNotify();
  const [pending, setPending] = useState<string | null>(null);
  const remove = async (item: SavedGroupItem) => {
    setPending(item.id);
    try {
      await write(`${path}/${item.id}`, { method: 'DELETE' });
      toast(`Removed ${item.name}.`, { label: 'Undo', run: () => { void write(`${path}/${item.id}/restore`, { method: 'POST' }).catch(toastError); } });
    } catch (error) { toastError(error); } finally { setPending(null); }
  };
  return <section className="panel group-library" aria-label="Saved player comparisons">
    <div className="panel-header"><h2>My checks</h2><Button variant="primary" onClick={() => onNew('check')}>New check</Button></div>
    {query.isError ? <LoadError error={query.error} onRetry={() => void query.refetch()} /> : !query.data ? <Skeleton rows={2} columns={2} /> : <div className="panel-body">
      {(['check', 'groups'] as const).map((kind) => <div className="group-library-section" key={kind}>
        <div className="group-library-heading"><h3>{kind === 'check' ? 'Shortcuts' : 'Saved groups'}</h3>{kind === 'groups' ? <Button size="sm" onClick={() => onNew('groups')}>New group</Button> : null}</div>
        {query.data.filter((item) => item.kind === kind).length ? <ul className="group-library-list">{query.data.filter((item) => item.kind === kind).map((item) => <li key={item.id} aria-label={item.name}>
          <div><strong>{item.name}</strong><small>{item.definition.range_preset === 'custom' ? `${item.definition.start} → ${item.definition.end}` : ({ today: 'Today', yesterday: 'Yesterday', month: 'This month', lastmonth: 'Last month' }[item.definition.range_preset] || `Last ${item.definition.range_preset} days`)} · {item.definition.window_hours} h observation</small></div>
          <div className="group-library-actions"><Button size="sm" disabled={busy || !!pending} onClick={() => onUse(item)}>{kind === 'check' ? 'Run' : 'Use'}</Button><Button size="sm" disabled={busy || !!pending} onClick={() => onEdit(item)}>Edit</Button><Button size="sm" variant="ghost" disabled={!!pending} onClick={() => void remove(item)}>Remove</Button></div>
        </li>)}</ul> : <p className="muted small">{kind === 'check' ? 'No saved checks yet.' : 'No saved groups yet.'}</p>}
      </div>)}
    </div>}
    {intent ? <SaveGroupDialog key={`${intent.kind}:${intent.item?.id || 'new'}`} path={path} intent={intent} onClose={onCloseSave} onSaved={(item) => { onSaved(item); toast(intent.kind === 'check' ? 'Shortcut saved.' : 'Groups saved.'); }} /> : null}
  </section>;
}

function SaveGroupDialog({ path, intent, onClose, onSaved }: { path: string; intent: SaveGroupIntent; onClose: () => void; onSaved: (item: SavedGroupItem) => void }): ReactElement {
  const [name, setName] = useState(intent.item?.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = intent.kind === 'check' ? 'Save shortcut' : 'Save groups';
  return <DialogShell open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={title}>
    <form className="group-save-form" onSubmit={(event) => { event.preventDefault(); if (!name.trim()) { setError('Enter a name.'); return; } setBusy(true); setError(''); void write<SavedGroupItem>(`${path}${intent.item ? `/${intent.item.id}` : ''}`, { method: intent.item ? 'PUT' : 'POST', body: JSON.stringify({ name: name.trim(), kind: intent.kind, definition: savedDefinition(intent.draft, intent.filters, intent.kind) }) }).then(onSaved).catch((error: unknown) => setError(errorMessage(error))).finally(() => setBusy(false)); }}>
      <Field label="Name" htmlFor="group-save-name"><input id="group-save-name" autoFocus maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Field>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="group-step-actions"><Button type="button" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" loading={busy}>Save</Button></div>
    </form>
  </DialogShell>;
}
