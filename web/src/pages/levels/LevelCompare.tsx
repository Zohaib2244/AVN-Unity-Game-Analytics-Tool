// Compare releases: two app versions side by side, level by level (start, finish, drop, and how the drop
// changed), plus the views saved on this device (filters, sorting, players and the chosen releases).
import { Fragment, useState, type ReactElement } from 'react';
import { useRead } from '@/api';
import { ConfirmDialog, DialogShell, LoadError, Spinner, useNotify } from '@/components/feedback';
import { useSubmit } from '@/components/forms';
import type { Facets, ActiveFilters } from '@/lib/filters';
import { number } from '@/lib/format';
import { storeGet, storeSet } from '@/lib/store';
import type { Game, LevelsResult } from '@/lib/types';
import { dropChange, dropChangeLabel, dropText, pickReleases, releaseChoices, type LevelNavigation, type ReleasePrefs, type SavedLevelView } from './levelMath';
import { activeViewKey, releaseFacetsPath, releasePath, releasesKey, savedViewsKey } from './levelPaths';

type Props = {
  game: Game;
  filters: ActiveFilters;
  nav: LevelNavigation;
  prefs: ReleasePrefs;
  onPrefs: (next: ReleasePrefs) => void;
  /** Apply a saved view: its filters, table settings and chosen releases. */
  onRestore: (view: SavedLevelView) => void;
  /** Open the level table at this level (the level links in the comparison). */
  onJump: (level: number) => void;
};

export function LevelCompare({ game, filters, nav, prefs, onPrefs, onRestore, onJump }: Props): ReactElement {
  const { toast } = useNotify();
  const facets = useRead<Facets>(releaseFacetsPath(game, filters));
  const choices = releaseChoices((facets.data?.app_version ?? []).map((item) => item.value));
  const pair = pickReleases(choices, prefs);
  const comparing = pair !== null && pair.a !== pair.b;
  const first = useRead<LevelsResult>(comparing ? releasePath(game, filters, pair.a) : null, { keepPrevious: false });
  const second = useRead<LevelsResult>(comparing ? releasePath(game, filters, pair.b) : null, { keepPrevious: false });

  // Saved views: this browser only.
  const [views, setViews] = useState<Record<string, SavedLevelView>>(() => storeGet<Record<string, SavedLevelView>>(savedViewsKey(game)) ?? {});
  const [active, setActive] = useState<string>(() => storeGet<string>(activeViewKey(game)) ?? '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const chooseView = (name: string) => {
    setActive(name); storeSet(activeViewKey(game), name);
    const view = views[name];
    if (view) onRestore(view);
  };
  const saveForm = useSubmit(async (values) => {
    const name = values.name?.trim() ?? '';
    if (!name) throw new Error('Enter a name for this view.');
    const next = { ...views, [name]: { filters: structuredClone(filters), tools: { ...prefs }, sort: nav.sort, pageSize: nav.pageSize, scope: nav.scope } };
    storeSet(savedViewsKey(game), next); storeSet(activeViewKey(game), name);
    setViews(next); setActive(name); setSaving(false);
    toast('Level view saved.');
  });
  const deleteView = () => {
    const next = { ...views }; delete next[active];
    storeSet(savedViewsKey(game), next); storeSet(activeViewKey(game), '');
    setViews(next); setActive('');
  };

  const pickRelease = (key: 'releaseA' | 'releaseB', value: string) => {
    const next = { ...prefs, [key]: value };
    onPrefs(next);
    storeSet(releasesKey(game), next);
  };
  const refresh = () => { void facets.refetch(); void first.refetch(); void second.refetch(); };

  let result: ReactElement;
  if (!facets.data) {
    result = facets.isError ? <LoadError error={facets.error} onRetry={() => void facets.refetch()} /> : <div aria-live="polite"><Spinner label="Comparing releases…" /></div>;
  } else if (!pair) {
    result = <p className="help">Choose dates containing at least two releases to compare.</p>;
  } else if (!comparing) {
    result = <p className="help">Choose two different releases.</p>;
  } else if (!first.data || !second.data) {
    result = first.isError || second.isError
      ? <LoadError error={first.error ?? second.error} onRetry={() => { void first.refetch(); void second.refetch(); }} />
      : <div aria-live="polite"><Spinner label="Comparing releases…" /></div>;
  } else {
    const maps = [first.data, second.data].map((data) => new Map(data.levels.map((row) => [row.level, row] as const)));
    const numbers = [...new Set([...first.data.levels, ...second.data.levels].map((row) => row.level))].sort((x, y) => x - y);
    result = numbers.length ? (
      <>
        <div className="level-scroll comparison-scroll" tabIndex={0} role="region" aria-label="Release comparison">
          <table className="compact-table comparison-table">
            <thead>
              <tr><th rowSpan={2}>Level</th><th colSpan={3}>{pair.a}</th><th colSpan={3}>{pair.b}</th><th rowSpan={2}>Drop change · B vs A</th></tr>
              <tr><th>Start</th><th>Finish</th><th>Drop</th><th>Start</th><th>Finish</th><th>Drop</th></tr>
            </thead>
            <tbody>
              {numbers.map((level) => {
                const before = maps[0]!.get(level); const after = maps[1]!.get(level);
                const label = dropChangeLabel(dropChange(before, after), !!(before?.low_sample || after?.low_sample));
                return (
                  <tr key={level}>
                    <td><button type="button" className="text-link level-jump-link" onClick={() => onJump(level)}>{level}</button></td>
                    {[before, after].map((row, index) => (
                      <Fragment key={index}>
                        <td>{row ? number(row.started) : '—'}</td>
                        <td>{row ? number(row.completed) : '—'}</td>
                        <td>{dropText(row)}</td>
                      </Fragment>
                    ))}
                    <td><span className={label.tone}>{label.text}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="help">pp = percentage points. Missing next-level data is not treated as zero drop. Small samples are marked; these comparisons describe observed behavior, not proof a release caused a change.</p>
      </>
    ) : <p className="help">No level events for these releases and filters.</p>;
  }

  return (
    <section className="panel level-explore">
      <div className="panel-header"><div><h2>Compare releases</h2><p>Start, finish and drop of two app versions, level by level.</p></div></div>
      <details className="level-saved-options">
        <summary>Saved views on this device</summary>
        <div className="level-saved-views">
          <label className="inline-field">Saved view
            <select aria-label="Saved level view" value={active} onChange={(event) => chooseView(event.target.value)}>
              <option value="">Choose a saved view…</option>
              {Object.keys(views).map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
          <button type="button" className="button small-button" onClick={() => setSaving(true)}>Save current view</button>
          <button type="button" className="button small-button" disabled={!active} onClick={() => setDeleting(true)}>Delete view</button>
        </div>
      </details>
      <div id="release-comparison" className="panel-body">
        <div className="level-analysis-controls">
          <label>Release A
            <select value={pair?.a ?? ''} onChange={(event) => pickRelease('releaseA', event.target.value)}>
              {choices.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label>Release B
            <select value={pair?.b ?? ''} onChange={(event) => pickRelease('releaseB', event.target.value)}>
              {choices.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <button type="button" className="button" onClick={refresh}>Compare</button>
        </div>
        <p className="help">Same dates and other filters for both releases. These selectors replace the app-version filter here only. Players are grouped by the version at each level’s start, then followed across updates until the end date. Samples may overlap when players replay after updating.</p>
        <div aria-live="polite">{result}</div>
      </div>

      <DialogShell open={saving} onOpenChange={(open) => { if (!open) setSaving(false); }} title="Save level view">
        <form onSubmit={saveForm.onSubmit}>
          <p>Remember these filters, sorting, players and chosen releases in this browser.</p>
          <label htmlFor="level-view-name">Name</label>
          <input id="level-view-name" name="name" maxLength={80} required placeholder="Latest release · highest drops" />
          {saveForm.error ? <div className="error" role="alert">{saveForm.error}</div> : null}
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setSaving(false)}>Cancel</button>
            <button type="submit" className="button primary" disabled={saveForm.busy}>Save view</button>
          </div>
        </form>
      </DialogShell>
      <ConfirmDialog open={deleting} onClose={() => setDeleting(false)} title={`Delete “${active}”?`} message="This removes the saved view from this browser. Your event data is not affected." label="Delete view" onConfirm={deleteView} />
    </section>
  );
}

