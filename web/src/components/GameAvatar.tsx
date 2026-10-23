import type { ReactElement } from 'react';
import { iconURL, initials, withIcon } from '@/lib/games';
import type { Game } from '@/lib/types';

/** The game's icon when one was uploaded (for any of its platform versions), otherwise its initials. */
export function GameAvatar({ name, games, className = '', size = 42 }: { name: string; games: Game[]; className?: string; size?: number }): ReactElement {
  const iconGame = withIcon(games);
  return (
    <span className={`game-avatar ${iconGame ? 'has-icon' : ''} ${className}`}>
      {iconGame ? <img src={iconURL(iconGame)} alt="" loading="lazy" width={size} height={size} /> : initials(name)}
    </span>
  );
}
