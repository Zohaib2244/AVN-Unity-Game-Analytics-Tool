// Event dictionary: every event the game sends with how often and what it means, then the import flow that
// fills the dictionary from the game's code.
import type { ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import type { Game } from '@/lib/types';
import { gamePath } from '@/lib/games';
import { Heading } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { EventsList } from './dictionary/EventsList';
import { ImportFlow } from './dictionary/ImportFlow';

export function DictionaryPage({ game }: { game: Game }): ReactElement {
  return (
    <>
      <Heading
        title="Event dictionary"
        subtitle="Describe what each of your events means."
        actions={<div className="heading-actions"><Link className="button" to={gamePath(game, 'event-setup')}><Ico name="link" size={15} /> Event setup</Link></div>}
      />
      <EventsList game={game} />
      <section className="panel section-spacing"><div className="panel-body"><ImportFlow game={game} /></div></section>
    </>
  );
}
