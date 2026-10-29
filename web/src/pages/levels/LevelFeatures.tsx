// Occurrence of X, and Drop by X: per level, how many starters met an ad, a powerup or a fail reason,
// and whether the ones who did left more than the ones who didn't. Choices are remembered per game.
import { Fragment, type ReactElement } from 'react';
import { useRead } from '@/api';
import { LoadError, Skeleton } from '@/components/feedback';
import type { ActiveFilters } from '@/lib/filters';
import { number, percent } from '@/lib/format';
import { useStored } from '@/lib/store';
import type { Game, LevelFeatureRow, LevelFeatures as Features } from '@/lib/types';
import {
  BASES, DEFAULT_FEATURE_PREFS, SPLITS, SUBJECTS, chosenValue, cleanFeaturePrefs, dropCells, kindOf, occurrence, rowsWith, topValues, valueLabel,
  type AdSplit, type DropBasis, type FeatureMode, type FeaturePrefs, type FeatureSubject,
} from './featureMath';
import { featuresPath } from './levelPaths';
import type { LevelScope } from './levelMath';

const prefsKey = (game: Pick<Game, 'id'>): string => `avn-levels-features-${game.id}`;
const MODES: Record<FeatureMode, string> = { occurrence: 'Occurrence', drop: 'Drop by' };
const pct = (value: number | null): string => (value == null ? '—' : percent(Math.round(value * 10) / 10));
const points = (value: number | null): string => (value == null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(Math.round(value * 10) / 10)} pts`);
// Small samples are muted, never red or green (as in Compare releases).
const tone = (value: number | null, small: boolean): string => (value == null || small || Math.abs(value) < 1 ? 'muted' : value > 0 ? 'loss' : 'gain');

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Record<T, string>; onChange: (next: T) => void }): ReactElement {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {(Object.entries(options) as Array<[T, string]>).map(([key, text]) => <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}>{text}</button>)}
    </div>
  );
}

export function LevelFeatures({ game, filters, scope, onOpen }: { game: Game; filters: ActiveFilters; scope: LevelScope; onOpen: (level: number) => void }): ReactElement {
  const [stored, setStored] = useStored<FeaturePrefs>(prefsKey(game), DEFAULT_FEATURE_PREFS);
  const prefs = cleanFeaturePrefs(stored);
  const change = (patch: Partial<FeaturePrefs>) => setStored({ ...prefs, ...patch });
  const query = useRead<Features>(featuresPath(game, filters, scope));
  const kind = kindOf(prefs.subject, prefs.split);
  const values = query.data?.kinds[kind];
  const value = chosenValue(values, prefs.value);
  const subject = prefs.subject === 'ads' ? `ads · by ${SPLITS[prefs.split].toLowerCase()}` : SUBJECTS[prefs.subject].toLowerCase();

  let body: ReactElement;
  if (!query.data) body = query.isError ? <LoadError error={query.error} onRetry={() => void query.refetch()} /> : <Skeleton kind="table" rows={6} columns={6} />;
  else if (!values?.length) body = <p className="help">No {SUBJECTS[prefs.subject].toLowerCase()} were recorded on any level for these dates and filters. Ads need <code>AD_ANALYSIS</code> Show events, powerups <code>POWERUP_ANALYSIS</code> Used events and fail reasons a <code>FAIL_REASON</code> on Failed.</p>;
  else if (prefs.mode === 'occurrence') body = <Occurrence rows={query.data.levels} kind={kind} values={topValues(values)} more={Math.max(0, values.length - 6)} onOpen={onOpen} />;
  else body = <Drop rows={rowsWith(query.data.levels, kind, value)} kind={kind} value={value} basis={prefs.basis} onOpen={onOpen} />;

  return (
    <section className="panel level-features">
      <div className="panel-header">
        <div><h2>{MODES[prefs.mode]} · {subject}</h2><p>{prefs.mode === 'occurrence' ? 'Share of each level’s starters who met it, with how often per player in small type.' : 'Whether players who met it leave more than players who didn’t.'}</p></div>
      </div>
      <div className="panel-body">
        <div className="level-analysis-controls feature-controls">
          <Choice<FeatureMode> label="Show" value={prefs.mode} options={MODES} onChange={(mode) => change({ mode })} />
          <Choice<FeatureSubject> label="Of" value={prefs.subject} options={SUBJECTS} onChange={(next) => change({ subject: next, value: '' })} />
          {prefs.subject === 'ads' ? <Choice<AdSplit> label="Split ads by" value={prefs.split} options={SPLITS} onChange={(split) => change({ split, value: '' })} /> : null}
          {prefs.mode === 'drop' && values?.length ? (
            <label className="inline-field">{prefs.subject === 'ads' ? SPLITS[prefs.split] : prefs.subject === 'powerups' ? 'Powerup' : 'Reason'}
              <select value={value} onChange={(event) => change({ value: event.target.value })}>{values.map((item) => <option key={item} value={item}>{valueLabel(item)}</option>)}</select>
            </label>
          ) : null}
          {prefs.mode === 'drop' ? <Choice<DropBasis> label="Left means" value={prefs.basis} options={BASES} onChange={(basis) => change({ basis })} /> : null}
        </div>
        {body}
        {query.data && values?.length ? (
          <p className="help">{prefs.mode === 'drop'
            ? 'Never started the next level = dropped by the end date. Left the session = no next level started in that session, even if they came back later. “Left right after” means it was the last thing they did. pts = percentage points. Ads between levels count for the level just played. Small samples are marked.'
            : 'Counts are the level’s starters in these dates and filters. An ad or powerup belongs to the level it names, or to the level just played when it names none. Small samples are marked.'}</p>
        ) : null}
      </div>
    </section>
  );
}

function LevelCell({ row, onOpen }: { row: LevelFeatureRow; onOpen: (level: number) => void }): ReactElement {
  return <td><button type="button" className="text-link level-jump-link" onClick={() => onOpen(row.level)}>{row.level}</button>{row.low_sample ? <> <span className="level-sample-marker" title={`Small sample: ${number(row.started)} starters`}>small</span></> : null}</td>;
}

function Occurrence({ rows, kind, values, more, onOpen }: { rows: LevelFeatureRow[]; kind: ReturnType<typeof kindOf>; values: string[]; more: number; onOpen: (level: number) => void }): ReactElement {
  return (
    <>
      <div className="level-scroll" tabIndex={0} role="region" aria-label="Occurrence by level">
        <table className="compact-table">
          <thead><tr><th>Level</th><th>Starters</th>{values.map((value) => <th key={value}>{valueLabel(value)}</th>)}</tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.level}>
                <LevelCell row={row} onOpen={onOpen} />
                <td>{number(row.started)}</td>
                {values.map((value) => {
                  const cell = occurrence(row, kind, value);
                  return <td key={value} title={cell.players ? `${number(cell.players)} players` : undefined}>{cell.players ? <>{pct(cell.share)} <small className="muted">{cell.perPlayer != null ? `×${(Math.round(cell.perPlayer * 10) / 10).toString()}` : ''}</small></> : <span className="muted">—</span>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more ? <p className="help">{number(more)} more not shown; pick one under Drop by.</p> : null}
    </>
  );
}

function Drop({ rows, kind, value, basis, onOpen }: { rows: LevelFeatureRow[]; kind: ReturnType<typeof kindOf>; value: string; basis: DropBasis; onOpen: (level: number) => void }): ReactElement {
  const bases = basis === 'both' ? (['next', 'session'] as const) : ([basis] as const);
  const names = { next: 'Never started next', session: 'Left the session' } as const;
  if (!rows.length) return <p className="help">{valueLabel(value)} did not happen on any level in these dates and filters.</p>;
  return (
    <div className="level-scroll" tabIndex={0} role="region" aria-label="Drop by level">
      <table className="compact-table">
        <thead>
          <tr><th rowSpan={2}>Level</th><th rowSpan={2}>Starters</th><th rowSpan={2}>Met {valueLabel(value)}</th>{bases.map((item) => <th key={item} colSpan={item === 'next' ? 5 : 4}>{names[item]}</th>)}</tr>
          <tr>{bases.map((item) => <Fragment key={item}><th>Overall</th><th>Met it</th><th>Didn’t</th><th>Difference</th>{item === 'next' ? <th>Left right after</th> : null}</Fragment>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cells = dropCells(row, kind, value);
            return (
              <tr key={row.level}>
                <LevelCell row={row} onOpen={onOpen} />
                <td>{number(row.started)}</td>
                <td>{number(cells.thing?.players ?? 0)}</td>
                {bases.map((item) => (
                  <Fragment key={item}>
                    <td>{pct(cells.overall[item])}</td>
                    <td>{pct(cells.sides[item].with)}</td>
                    <td>{pct(cells.sides[item].without)}</td>
                    <td><span className={tone(cells.sides[item].difference, row.low_sample || (cells.thing?.players ?? 0) < 10)}>{points(cells.sides[item].difference)}</span></td>
                    {item === 'next' ? <td>{number(cells.rightAfter.count)}{cells.rightAfter.ofDrops != null ? <> <small className="muted">{pct(cells.rightAfter.ofDrops)} of drops</small></> : null}</td> : null}
                  </Fragment>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
