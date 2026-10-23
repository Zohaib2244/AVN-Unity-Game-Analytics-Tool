// The "your key is ready" dialog (the old `showKey`): shows a freshly created collection key once,
// with Copy and a Done link to where the person goes next.
import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { DialogShell } from '@avn/ui';
import { copyText } from '@/lib/store';
import { useNotify } from './feedback';
import { Ico } from './icons';

export type ShownKey = { key: string; title: string; next: string };

export function ShowKeyDialog({ shown, onClose }: { shown: ShownKey | null; onClose: () => void }): ReactElement {
  const { toast } = useNotify();
  const copy = async () => { toast((await copyText(shown?.key || '')) ? 'Key copied to clipboard.' : 'Select the key above and copy it manually.'); };
  return (
    <DialogShell open={!!shown} onOpenChange={(open) => { if (!open) onClose(); }} title={shown?.title || ''}>
      <p>Copy this collection key now. For your security, the full key won’t be shown again.</p>
      <code className="key-display">{shown?.key}</code>
      <p className="small">Keep this with your game’s connection settings. You can generate a replacement key at any time.</p>
      <div className="modal-actions">
        <button type="button" className="button" onClick={() => void copy()}><Ico name="copy" size={14} /> Copy key</button>
        <Link className="button primary" to={shown?.next || '/'} onClick={onClose}>Done <Ico name="check" size={14} /></Link>
      </div>
    </DialogShell>
  );
}
