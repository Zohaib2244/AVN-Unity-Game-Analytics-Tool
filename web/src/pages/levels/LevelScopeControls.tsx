import type { ReactElement } from 'react';
import { Ico } from '@/components/icons';
import { LEVEL_SCOPES, type LevelNavigation, type LevelScope } from './levelMath';

/** Visible wherever the Levels scope or drop counts apply, including a level's player list. */
export function LevelScopeControls({ nav, onChange }: {
  nav: LevelNavigation; onChange: (patch: Partial<LevelNavigation>) => void;
}): ReactElement {
  return (
    <div className="quiet-actions level-scope-controls">
      <div className="segmented" role="group" aria-label="Which players">
        {(Object.entries(LEVEL_SCOPES) as Array<[LevelScope, string]>).map(([key, label]) => (
          <button key={key} type="button" aria-pressed={nav.scope === key} onClick={() => onChange({ scope: key })}><Ico name={key === 'all' ? 'users' : 'user-plus'} size={14} />{label}</button>
        ))}
      </div>
      <label className="inline-field level-return-option" title="Exclude players with a later session after an interruption on this level, by the end date. Starter counts stay the same; Came back later stays available.">
        <input type="checkbox" className="cb-in" checked={nav.excludeReturners} onChange={(event) => onChange({ excludeReturners: event.target.checked })} />
        <span>Exclude players who came back</span>
      </label>
    </div>
  );
}
