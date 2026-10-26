// Switch game from any page: one popover opened by the sidebar's game card, the breadcrumb and the phone title.
// Picking a game keeps the section you are on (Levels stays Levels) and the platform you are looking at when the
// other game has it. The list is also in the command palette (Ctrl K) with the same behaviour.
import type { ReactElement, RefObject } from 'react';
import { Popover } from '@avn/ui';
import { Ico } from '@/components/icons';
import { gameGroups, iconURL, initials, sameGame, withIcon } from '@/lib/games';
import { platformLabel } from '@/lib/format';
import type { Game } from '@/lib/types';

/** The version of a game to open: the one on the platform being looked at, else the first live one. */
export function variantFor(group: { variants: Game[]; primary: Game }, platform: string | undefined): Game {
  return group.variants.find((item) => item.platform === platform && !item.archived_at) ?? group.variants.find((item) => item.platform === platform) ?? group.primary;
}

export function GameSwitcher({ open, onClose, anchor, games, current, onPick, onAll, onRegister }: {
  open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; games: Game[]; current: Game | null;
  onPick: (game: Game) => void; onAll: () => void; onRegister?: () => void;
}): ReactElement {
  const groups = gameGroups(games);
  return (
    <Popover position="fixed" open={open} onClose={onClose} anchor={anchor} width={300} className="game-pop">
      <div className="pop-scroll" role="listbox" aria-label="Switch game">
        <div className="pop-grp"><span className="eyebrow">Switch game</span></div>
        {groups.map((group) => {
          const target = variantFor(group, current?.platform);
          const here = !!current && sameGame(group.primary, current);
          const mark = withIcon(group.variants);
          return (
            <button key={group.primary.id} type="button" role="option" aria-selected={here} className={`opt game-opt${here ? ' on' : ''}`} onClick={() => { onClose(); if (!here) onPick(target); }}>
              <span className="g-ic">{mark ? <img src={iconURL(mark)} alt="" width={26} height={26} /> : initials(group.name)}</span>
              <span className="ot">{group.name}<small>{group.variants.map((item) => platformLabel(item.platform)).join(' · ')}{group.archived ? ' · paused' : ''}</small></span>
              {here ? <span className="tick"><Ico name="check" size={15} /></span> : null}
            </button>
          );
        })}
        <div className="pop-grp game-pop-foot">
          <button type="button" className="opt" onClick={() => { onClose(); onAll(); }}><span className="ot">All games</span></button>
          {onRegister ? <button type="button" className="opt" onClick={() => { onClose(); onRegister(); }}><span className="ot">Register a game</span></button> : null}
        </div>
      </div>
    </Popover>
  );
}
