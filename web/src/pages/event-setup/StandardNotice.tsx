// The one notice the standard has: a game whose newest events follow an older version than the workspace's
// standard. Quiet and dismissable; dismissing is remembered per game until the versions change.
import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { useRead } from '@/api';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { Game, GameStandard } from '@/lib/types';
import { Ico } from '@/components/icons';

const dismissKey = (game: Pick<Game, 'id'>) => `avn-standard-dismissed-${game.id}`;
export const standardSignature = (status: GameStandard): string => `${status.game_version}->${status.workspace_version}`;
export const standardNoticeShown = (status: GameStandard | undefined, dismissed: string | null): boolean => Boolean(status?.outdated && dismissed !== standardSignature(status));

export function StandardNotice({ game, link = true }: { game: Pick<Game, 'id'>; link?: boolean }): ReactElement | null {
  const status = useRead<GameStandard>(`${gameURL(game)}/standard`);
  const [dismissed, setDismissed] = useState<string | null>(() => storeGet<string>(dismissKey(game)));
  if (!status.data || !standardNoticeShown(status.data, dismissed)) return null;
  const signature = standardSignature(status.data);
  const dismiss = () => { storeSet(dismissKey(game), signature); setDismissed(signature); };
  return (
    <div className="notice-banner" role="status" id="standard-notice">
      <Ico name="flag" size={18} />
      <div><strong>Update standard.</strong> This game sends AVN events standard v{status.data.game_version}; the workspace uses v{status.data.workspace_version}. Everything keeps working; give the new setup files to your game’s agent when you next update it.</div>
      {link ? <Link className="button" to={gamePath(game, 'event-setup')} hash="install">Update standard</Link> : null}
      <button type="button" className="button" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
