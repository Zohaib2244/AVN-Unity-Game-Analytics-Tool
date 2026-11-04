// Occurrence of X, and Drop by X: per level, how many starters met an ad, a powerup or a fail reason,
// and whether the ones who did left more than the ones who didn't. Choices are remembered per game.
import { useState, type ReactElement } from 'react';
import { useRead } from '@/api';
import { LoadError, Skeleton } from '@/components/feedback';
import type { ActiveFilters } from '@/lib/filters';
import { number, percent } from '@/lib/format';
import { useStored } from '@/lib/store';
import type { Game, LevelFeatureRow, LevelFeatures as Features } from '@/lib/types';
import {
  BASES, DEFAULT_FEATURE_PREFS, MIN_SIDE, SPLITS, SUBJECTS, chosenValue, cleanFeaturePrefs, dropLevels, dropSummary, kindOf, occurrence, rowsWith, topValues, valueLabel,
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

export function LevelFeatures({ game, filters, scope, excludeReturners, onOpen }: { game: Game; filters: ActiveFilters; scope: LevelScope; excludeReturners: boolean; onOpen: (level: number) => void }): ReactElement {
  const [stored, setStored] = useStored<FeaturePrefs>(prefsKey(game), DEFAULT_FEATURE_PREFS);
  const prefs = cleanFeaturePrefs(stored);
  const change = (patch: Partial<FeaturePrefs>) => setStored({ ...prefs, ...patch });
  const query = useRead<Features>(featuresPath(game, filters, scope, excludeReturners));
  const kind = kindOf(prefs.subject, prefs.split);
  const values = query.data?.kinds[kind];
  const value = chosenValue(values, prefs.value);
  const subject = prefs.subject === 'ads' ? `ads · by ${SPLITS[prefs.split].toLowerCase()}` : SUBJECTS[prefs.subject].toLowerCase();

  let body: ReactElement;
  if (!query.data) body = query.isError ? <LoadError error={query.error} onRetry={() => void query.refetch()} /> : <Skeleton kind="table" rows={6} columns={6} />;
  else if (!values?.length) body = <p className="help">No {SUBJECTS[prefs.subject].toLowerCase()} were recorded on any level for these dates and filters. Ads need <code>AD_ANALYSIS</code> Show events, powerups <code>POWERUP_ANALYSIS</code> Used events and fail reasons a <code>FAIL_REASON</code> on Failed.</p>;
  else if (prefs.mode === 'occurrence') body = <Occurrence rows={query.data.levels} kind={kind} values={topValues(values)} more={Math.max(0, values.length - 6)} onOpen={onOpen} />;
  else body = <Drop rows={rowsWith(query.data.levels, kind, value)} kind={kind} value={value} basis={prefs.basis} subject={prefs.subject} split={prefs.split} onOpen={onOpen} />;

  return (
    <section className="panel level-features">
      <div className="panel-header">
        <div><h2>{MODES[prefs.mode]} · {subject}{prefs.mode === 'drop' && excludeReturners ? ' · no return observed' : ''}</h2><p>{prefs.mode === 'occurrence' ? 'Share of each level’s starters who met it, with how often per player in small type.' : 'Do players who ran into this leave more often than players who didn’t?'}</p></div>
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
          {prefs.mode === 'drop' ? <div className="inline-field"><span>Count a player as gone when they</span><Choice<DropBasis> label="Gone means" value={prefs.basis} options={BASES} onChange={(basis) => change({ basis })} /></div> : null}
        </div>
        {body}
        {query.data && values?.length ? (
          <p className="help">{prefs.mode === 'drop'
            ? `Only levels with at least ${MIN_SIDE} players on each side count towards the sentence at the top; smaller levels are greyed. This shows what happens together, not what caused it: ads and powerups often show up on the harder levels. ${excludeReturners ? 'Players who came back by the end date are not counted as gone. ' : ''}`
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

/** "saw an Interstitial ad", "used Bomb": what the players on one side did, in words. */
function metPhrase(subject: 'ads' | 'powerups' | 'fails', split: 'format' | 'placement', value: string): string {
  const label = valueLabel(value);
  if (subject === 'powerups') return `used ${label}`;
  if (subject === 'fails') return `failed with “${label}”`;
  return split === 'placement' ? `saw an ad at “${label}”` : `saw ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} ad`;
}
const GONE: Record<'next' | 'session', string> = { next: 'stopped playing for good', session: 'ended that session' };

function Drop({ rows, kind, value, basis, subject, split, onOpen }: { rows: LevelFeatureRow[]; kind: ReturnType<typeof kindOf>; value: string; basis: DropBasis; subject: 'ads' | 'powerups' | 'fails'; split: 'format' | 'placement'; onOpen: (level: number) => void }): ReactElement {
  const [order, setOrder] = useState<'level' | 'gap'>('level');
  if (!rows.length) return <p className="help">{valueLabel(value)} did not happen on any level in these dates and filters.</p>;
  const phrase = metPhrase(subject, split, value);
  const summary = dropSummary(rows, kind, value, basis);
  const levels = dropLevels(rows, kind, value, basis);
  const shown = order === 'gap' ? [...levels].sort((a, b) => (b.gap ?? -999) - (a.gap ?? -999)) : levels;
  const strongest = Math.max(10, ...levels.filter((item) => item.reliable).map((item) => Math.abs(item.gap ?? 0)));
  return (
    <div className="drop-view">
      <div className="drop-verdict" role="status">
        {summary.levels && summary.withRate != null && summary.withoutRate != null && summary.gap != null ? (
          <>
            <p className="drop-sentence">Players who <strong>{phrase}</strong> {GONE[basis]} <strong>{pct(summary.withRate)}</strong> of the time, against <strong>{pct(summary.withoutRate)}</strong> for players who didn’t. {Math.abs(summary.gap) < 1 ? 'That is about the same.' : <span className={summary.gap > 0 ? 'loss' : 'gain'}>That is {points(Math.abs(summary.gap)).replace('+', '')} {summary.gap > 0 ? 'more' : 'fewer'}.</span>}</p>
            <p className="help">Counted over {number(summary.levels)} level{summary.levels === 1 ? '' : 's'} with enough players on both sides ({number(summary.met)} who did, {number(summary.notMet)} who didn’t).</p>
            {summary.higher.length ? <div className="drop-standout"><span>Leave more after this at</span>{summary.higher.map((item) => <button key={item.level} type="button" className="last-action" onClick={() => onOpen(item.level)}>Level {item.level}<span className="drop-chip-note loss">{pct(item.withRate)} vs {pct(item.withoutRate)}</span></button>)}</div> : null}
            {summary.lower.length ? <div className="drop-standout"><span>Leave less at</span>{summary.lower.map((item) => <button key={item.level} type="button" className="last-action" onClick={() => onOpen(item.level)}>Level {item.level}<span className="drop-chip-note gain">{pct(item.withRate)} vs {pct(item.withoutRate)}</span></button>)}</div> : null}
          </>
        ) : <p className="drop-sentence">Not enough players on both sides yet to say. Levels need at least {MIN_SIDE} who did and {MIN_SIDE} who didn’t.</p>}
      </div>
      <div className="drop-order"><span>Order</span><div className="segmented" role="group" aria-label="Order levels by"><button type="button" aria-pressed={order === 'level'} onClick={() => setOrder('level')}>By level</button><button type="button" aria-pressed={order === 'gap'} onClick={() => setOrder('gap')}>Biggest gap first</button></div></div>
      <div className="level-scroll" tabIndex={0} role="region" aria-label="Drop by level">
        <table className="compact-table drop-table">
          <thead><tr><th>Level</th><th className="num" title="Players who started the level">Started</th><th className="num">Who {phrase}</th><th className="num" title={`Of those who ${phrase}, the share who ${GONE[basis]}`}>Of them, {GONE[basis]}</th><th className="num" title={`Of those who didn’t, the share who ${GONE[basis]}`}>Of the rest, {GONE[basis]}</th><th>Gap</th></tr></thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.level} className={item.reliable ? undefined : 'drop-faint'}>
                <td><button type="button" className="text-link level-jump-link" onClick={() => onOpen(item.level)}>{item.level}</button></td>
                <td className="num">{number(item.started)}</td>
                <td className="num">{number(item.met)} <small className="muted">{item.started ? `${Math.round((100 * item.met) / item.started)}%` : ''}</small></td>
                <td className="num">{pct(item.withRate)}</td>
                <td className="num">{pct(item.withoutRate)}</td>
                <td>{item.gap == null ? <span className="muted">—</span> : (
                  <span className="drop-gap" title={item.reliable ? undefined : `Too few players to trust: ${number(item.met)} did, ${number(item.started - item.met)} didn’t`}>
                    <span className="drop-gap-bar" aria-hidden="true"><i className={item.gap > 0 ? 'loss' : 'gain'} style={{ width: `${Math.min(50, (50 * Math.abs(item.gap)) / strongest)}%` }} /></span>
                    <span className={tone(item.gap, !item.reliable)}>{points(item.gap)}</span>{item.reliable ? null : <small className="muted"> few players</small>}
                  </span>
                )}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
