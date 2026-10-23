// Register game: a short form (prefilled from the "+ iOS" links), an icon picker with a live preview,
// then the one-time "your key is ready" dialog.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { write } from '@/api';
import { useSession } from '@/app/session';
import type { Game } from '@/lib/types';
import { Heading, useNotify } from '@/components/feedback';
import { Field, FormError, useSubmit } from '@/components/forms';
import { Ico } from '@/components/icons';
import { ShowKeyDialog, type ShownKey } from '@/components/ShowKeyDialog';
import { iconPreview, uploadIcon } from './gameIcon';

type CreatedGame = Game & { key: { api_key: string } };

export function NewGamePage(): ReactElement {
  const prefill = useSearch({ strict: false }) as Record<string, string | undefined>;
  const { workspace, refresh } = useSession();
  const { toast, toastError } = useNotify();
  const iconInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [shown, setShown] = useState<ShownKey | null>(null);
  const [registered, setRegistered] = useState(false);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const pickIcon = async () => {
    const file = iconInput.current?.files?.[0];
    try { setPreview(file ? await iconPreview(file) : null); }
    catch (error) { if (iconInput.current) iconInput.current.value = ''; setPreview(null); toastError(error); }
  };
  const { onSubmit, busy, error } = useSubmit(async (values) => {
    const { icon: _icon, ...body } = values;
    const game = await write<CreatedGame>('/v1/games', { method: 'POST', body: JSON.stringify({ ...body, workspace_id: workspace }) });
    const file = iconInput.current?.files?.[0];
    if (file) {
      try { await uploadIcon([game], file); }
      catch (caught) { toast(`The game was created, but its icon wasn’t saved: ${(caught as Error).message}`); }
    }
    await refresh();
    setRegistered(true);
    setShown({ key: game.key.api_key, title: 'Your game is ready.', next: `/games/${game.id}` });
  });

  return (
    <>
      <Link className="back-link" to="/">← Back to games</Link>
      <Heading title="Make room for your next game." subtitle="A few details, and you’re ready to start collecting." />
      <div className="form-layout">
        <form id="register-form" className="panel form-panel" onSubmit={onSubmit}>
          <h2>Game details</h2><p>Give your project a recognizable name.</p>
          <Field label="Game name" htmlFor="game-name" help="Use the same name for the Android and iOS versions: they appear as one game with a platform switch."><input id="game-name" name="name" placeholder="e.g. Tiny Adventures" required maxLength={128} autoFocus defaultValue={prefill.name || ''} /></Field>
          <Field label="Bundle ID" htmlFor="bundle-id" help="The application identifier from your game’s project settings."><input id="bundle-id" name="bundle_id" defaultValue={prefill.bundle_id || ''} placeholder="com.yourstudio.yourgame" pattern="[A-Za-z0-9_\-]+(\.[A-Za-z0-9_\-]+)+" required maxLength={255} /></Field>
          <Field label="Platform" htmlFor="platform" help="Register each platform separately to keep its events isolated. The platform can’t be changed later."><select id="platform" name="platform" defaultValue={prefill.platform === 'ios' ? 'ios' : 'android'}><option value="android">Android</option><option value="ios">iOS</option></select></Field>
          <Field label="Icon (optional)" htmlFor="game-icon" help="Shown next to the game everywhere. Any image works; it is cropped to a square. You can change it later in Game settings.">
            <div className="icon-picker"><span className={`game-avatar icon-preview${preview ? ' has-icon' : ''}`} id="icon-preview">{preview ? <img src={preview} alt="" width={42} height={42} /> : '?'}</span><input ref={iconInput} id="game-icon" name="icon" type="file" accept="image/*" onChange={() => void pickIcon()} /></div>
          </Field>
          <Field label="Notes (optional)" htmlFor="notes"><textarea id="notes" name="notes" maxLength={2000} placeholder="Store links, release status, anything worth remembering" /></Field>
          {error ? <FormError error={error} /> : null}
          <div className="form-actions"><Link to="/" className="button">Cancel</Link><button className="button primary" type="submit" disabled={busy || registered} aria-busy={busy || undefined}>{registered ? 'Game registered' : busy ? 'Working…' : <>Register game <Ico name="arrow" size={14} /></>}</button></div>
        </form>
        <aside className="aside-card"><Ico name="game" size={25} /><h3>A space of its own</h3><p>Every game gets a separate event database and its own collection keys.</p><ul><li>Duplicates are handled automatically</li><li>Keys can be rotated at any time</li><li>Your raw data stays on your server</li></ul><p className="small">After registration, copy your new API key. It’s shown only once.</p></aside>
      </div>
      <ShowKeyDialog shown={shown} onClose={() => setShown(null)} />
    </>
  );
}
