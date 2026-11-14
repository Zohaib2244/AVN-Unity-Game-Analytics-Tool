// The ad widgets, one set for the Ads page (the whole game) and a player's summary (one player):
// Ad states per format, Revenue with a "By" switch, revenue per day, and Failures and blocks, whose
// rows open that failure's own page in place of the list. Same columns, same words, same behaviour on both.
import { useMemo, useRef, useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { Popover, SingleSelect } from '@avn/ui';
import { useRead } from '@/api';
import { Ico } from '@/components/icons';
import { QueryRegion, Skeleton } from '@/components/feedback';
import { DayBars } from '@/components/DayBars';
import { Share } from '@/components/Share';
import { addDays, analysisDate, countryName, number } from '@/lib/format';
import { gamePath, gameURL } from '@/lib/games';
import { useStored } from '@/lib/store';
import type { AdCount, AdFailureDetail, AdFailureKind, AdFailureRow, AdFailures, AdRevenue, AdStates, Game } from '@/lib/types';
import { GROUPS, money, words, type AdGroup } from '@/pages/ads/model';

export type AdScope = { game: Game; query: URLSearchParams; player?: string };
type Focus = { format: string; kind: AdFailureKind; reason: string } | null;
type Narrow = { format: string; kind: string };

const KIND_WORDS: Record<AdFailureKind, string> = { load_failed: 'Load failed', show_failed: 'Show failed', blocked: 'Blocked' };
const KIND_TONE: Record<AdFailureKind, string> = { load_failed: 'warn', show_failed: 'bad', blocked: 'muted' };
const NO_REASON = '(no reason sent)';

export const adPath = (scope: AdScope, what: string, extra = ''): string =>
  `${gameURL(scope.game)}/insights/ads/${what}?${scope.query}${scope.player ? `&player=${encodeURIComponent(scope.player)}` : ''}${extra}`;

/** A "Label: value" button that opens the shared single-choice list. */
function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const current = options.find((item) => item.value === value)?.label ?? value;
  return (
    <>
      <button ref={button} type="button" className="select" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}><span>{label}: {current}</span><Ico name="chevron" size={12} /></button>
      <Popover position="fixed" open={open} onClose={() => setOpen(false)} anchor={button} width={220}>
        <SingleSelect options={options} value={value} onChange={(next) => { setOpen(false); onChange(next); }} />
      </Popover>
    </>
  );
}

const MUTED = <span className="muted">—</span>;

/* ─── Ad states ─── */

export function AdStatesPanel({ scope, onNarrow }: { scope: AdScope; onNarrow: (narrow: Narrow) => void }): ReactElement {
  const url = adPath(scope, 'states');
  const states = useRead<AdStates>(url);
  const who = scope.player ? 'This player only' : 'Every format the game sends';
  return (
    <section className="panel money-states">
      <div className="panel-header"><div><h2 title="Each count is how many times the game sent that state. Failed and blocked counts open the list of reasons.">Ad states</h2></div><span className="muted small">{who}</span></div>
      <QueryRegion query={states} path={url} skeleton={<Skeleton rows={4} columns={8} />}>
        {(data) => (data.available ? (
          <div className="table-wrap">
            <table className="compact-table money-table">
              <thead><tr><th>Format</th><th className="num" title="An ad was ready">Loaded</th><th className="num" title="No ad came back from the network">Load failed</th><th className="num" title="The game wanted to show one">Asked</th><th className="num" title="The game’s own rules held it back">Blocked</th><th className="num" title="It could not be shown">Show failed</th><th className="num" title="The player saw it and closed it">Shown</th><th className="num">Revenue</th></tr></thead>
              <tbody>
                {data.formats.map((row) => {
                  const banner = row.format === 'Banner';
                  const count = (value: number, kind: AdFailureKind): ReactElement => (value ? <button type="button" className="count-link" onClick={() => onNarrow({ format: row.format, kind })}>{number(value)}</button> : <span className="muted">0</span>);
                  return (
                    <tr key={row.format}>
                      <td><b>{words(row.format)}</b></td>
                      <td className="num">{number(row.loaded)}</td>
                      <td className={`num${row.load_failed ? ' warn-text' : ''}`}>{count(row.load_failed, 'load_failed')}</td>
                      <td className="num">{banner ? <span className="muted" title="Banners are always on">always on</span> : number(row.asked)}</td>
                      <td className="num">{banner ? MUTED : count(row.blocked, 'blocked')}</td>
                      <td className={`num${row.show_failed ? ' bad-text' : ''}`}>{banner ? MUTED : count(row.show_failed, 'show_failed')}</td>
                      <td className="num">{banner ? MUTED : <Share part={row.shown} whole={row.asked} unit="ads" />}</td>
                      <td className="num">{banner ? <span className="muted" title="Banner money is counted from the level results">level results</span> : <b>{money(row.revenue)}</b>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="help panel-body">{data.note ?? 'No ad events in these days.'}</p>)}
      </QueryRegion>
    </section>
  );
}

/* ─── Revenue (a ranked list with one "By" switch) and per day ─── */

export function AdRevenuePanel({ scope }: { scope: AdScope }): ReactElement {
  const [by, setBy] = useStored<AdGroup>(`avn-ad-revenue-by-${scope.player ? 'player' : 'game'}`, scope.player ? 'network' : 'format');
  const url = adPath(scope, 'revenue', `&group_by=${by}`);
  const revenue = useRead<AdRevenue>(url);
  const options = GROUPS.filter((item) => item.value !== 'day').map((item) => ({ value: item.value as AdGroup, label: item.label }));
  return (
    <section className="panel money-revenue">
      <div className="panel-header"><div><h2>Revenue</h2></div><Pick<AdGroup> label="By" value={by} options={options} onChange={setBy} /></div>
      <QueryRegion query={revenue} path={url} skeleton={<Skeleton rows={4} columns={4} />}>
        {(data) => {
          if (!data.available) return <p className="help panel-body">{data.note ?? 'No ad revenue in these days.'}</p>;
          const top = Math.max(...data.groups.map((row) => row.revenue), 0.000001);
          const total = data.groups.reduce((sum, row) => sum + row.revenue, 0);
          return (
            <div className="panel-body rank-list">
              {data.groups.map((row) => (
                <div key={String(row.value)} className="rank-row">
                  <span className="rank-name">{by === 'ad_unit' ? <span className="mono">{row.value ?? '—'}</span> : words(row.value)}</span>
                  <span className="rank-track" aria-hidden="true"><i style={{ width: `${Math.max(2, (100 * row.revenue) / top)}%` }} /></span>
                  <Share part={row.revenue} whole={total} unit="usd" />
                  <span className="rank-extra muted" title={`${number(row.impressions)} paid ads`}>{number(row.players)} {row.players === 1 ? 'player' : 'players'}</span>
                </div>
              ))}
              {by === 'format' && data.banner.revenue ? <div className="rank-row"><span className="rank-name">Banner</span><span className="rank-track" aria-hidden="true" /><span className="share"><span className="share-n">{money(data.banner.revenue)}</span><span className="share-p muted" title="Banner money is counted from the level results, so it has no share">—</span></span><span className="rank-extra muted">level results</span></div> : null}
            </div>
          );
        }}
      </QueryRegion>
    </section>
  );
}

export function AdDailyPanel({ scope }: { scope: AdScope }): ReactElement {
  const url = adPath(scope, 'revenue', '&group_by=day');
  const revenue = useRead<AdRevenue>(url);
  return (
    <section className="panel money-daily">
      <div className="panel-header"><div><h2>Revenue per day</h2></div></div>
      <QueryRegion query={revenue} path={url} skeleton={<Skeleton rows={3} columns={2} />}>
        {(data) => {
          const days = data.available ? data.groups : [];
          if (!days.length) return <p className="help panel-body">No paid ads in these days.</p>;
          return <div className="panel-body"><DayBars points={days.map((row) => ({ day: String(row.value), value: row.revenue }))} label="Revenue per day" show={money} /></div>;
        }}
      </QueryRegion>
    </section>
  );
}

/* ─── Failures and blocks: the list, or one failure's page ─── */

type SortKey = 'format' | 'kind' | 'reason' | 'times' | 'players' | 'last_seen';
const KINDS = [{ value: '', label: 'All' }, { value: 'load_failed', label: 'Load failed' }, { value: 'show_failed', label: 'Show failed' }, { value: 'blocked', label: 'Blocked' }];

function sortRows(rows: AdFailureRow[], key: SortKey, desc: boolean): AdFailureRow[] {
  const sign = desc ? -1 : 1;
  return [...rows].sort((a, b) => {
    const [x, y] = [a[key], b[key]];
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sign || b.times - a.times;
  });
}

function When({ detail }: { detail: AdFailureDetail }): ReactElement {
  const points = useMemo(() => {
    const seen = new Map(detail.when.points.map((item) => [item.at, item.times]));
    const keys: string[] = [];
    if (detail.when.unit === 'day') {
      for (let day = detail.first_seen.slice(0, 10); day <= detail.last_seen.slice(0, 10) && keys.length < 400; day = addDays(day, 1)) keys.push(day);
    } else {
      for (let at = Date.parse(`${detail.first_seen.slice(0, 13)}:00:00Z`); at <= Date.parse(detail.last_seen) && keys.length < 400; at += 3600_000) keys.push(new Date(at).toISOString().slice(0, 13));
    }
    return keys.map((key) => ({ at: key, times: seen.get(key) ?? 0 }));
  }, [detail]);
  const top = Math.max(...points.map((item) => item.times), 1);
  return (
    <div>
      <div className="mini-bars warn" role="img" aria-label={`Times by ${detail.when.unit}, most ${top}`}>
        {points.map((item) => <span key={item.at} className="mini-bar" title={`${item.at.replace('T', ' ')} · ${number(item.times)}`}><i style={{ height: `${item.times ? Math.max(4, (100 * item.times) / top) : 0}%` }} /></span>)}
      </div>
      <p className="small muted">{analysisDate(detail.first_seen)} to {analysisDate(detail.last_seen)}, by {detail.when.unit}</p>
    </div>
  );
}

function Counts({ title, rows, total, name }: { title: string; rows: AdCount[]; total: number; name?: (value: string | null) => ReactElement | string }): ReactElement | null {
  const shown = rows.filter((row) => row.value != null && row.value !== '');
  if (!shown.length) return null;
  const top = Math.max(...shown.map((row) => row.times), 1);
  return (
    <div className="detail-block">
      <span className="eyebrow">{title}</span>
      <div className="rank-list">
        {shown.map((row) => (
          <div key={row.value} className="rank-row">
            <span className="rank-name">{name ? name(row.value) : row.value}</span>
            <span className="rank-track" aria-hidden="true"><i style={{ width: `${Math.max(3, (100 * row.times) / top)}%` }} /></span>
            <Share part={row.times} whole={total} unit="events" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** "ca-app-pub-…/123" is an AdMob unit; any other id comes through AppLovin MAX. The failed load names the unit, not the network. */
const unitName = (unit: string | null): ReactElement | string => {
  if (!unit) return 'Not named';
  return unit.startsWith('ca-app-pub') ? <span title={unit}>AdMob · <span className="mono">…{unit.slice(-6)}</span></span> : <span title={unit}>MAX · <span className="mono">{unit.slice(0, 8)}…</span></span>;
};

function FailurePage({ scope, rows, at, onBack, onGo }: { scope: AdScope; rows: AdFailureRow[]; at: number; onBack: () => void; onGo: (index: number) => void }): ReactElement {
  const row = rows[at]!;
  const url = adPath(scope, 'failure', `&format=${encodeURIComponent(row.format)}&kind=${row.kind}&reason=${encodeURIComponent(row.reason)}`);
  const detail = useRead<AdFailureDetail>(url);
  const players = gamePath(scope.game, 'players');
  return (
    <section className="panel money-failure">
      <div className="panel-header failure-head">
        <button type="button" className="btn sm" onClick={onBack}><Ico name="arrow" size={13} /> All failures</button>
        <h2><span className={`dot tone-${KIND_TONE[row.kind]}`} aria-hidden="true" /> {words(row.format)} · {KIND_WORDS[row.kind]}</h2>
        <span className="quiet-actions"><span className="muted small">{at + 1} of {rows.length}</span><button type="button" className="btn sm" onClick={() => onGo((at + 1) % rows.length)}>Next</button></span>
      </div>
      <QueryRegion query={detail} path={url} skeleton={<Skeleton rows={6} columns={4} />}>
        {(data) => {
          if (!data.available) return <p className="help panel-body">{data.note ?? 'That failure did not happen in these days.'}</p>;
          const baseline = data.late_baseline;
          const offline = data.late_share != null && data.late_share >= 0.6 && baseline != null && data.late_share - baseline >= 0.3;
          return (
            <div className="panel-body failure-body">
              <code className="failure-reason">{data.reason}</code>
              <div className="detail-stats">
                <div><span className="eyebrow">Times</span><b>{number(data.times)}</b></div>
                {scope.player ? null : <div><span className="eyebrow">Players</span><b>{number(data.players)}</b></div>}
                <div><span className="eyebrow" title="From asking the network to the failure">Load waited</span><b>{data.load_seconds != null ? `${data.load_seconds} s` : '—'}</b></div>
                <div><span className="eyebrow" title={`Reached the server more than ${data.late_after_seconds / 60} minutes after it happened`}>Arrived late</span><b><Share part={data.late} whole={data.times} percent={data.late_share == null ? null : 100 * data.late_share} unit="events" /></b></div>
                <div><span className="eyebrow">Last seen</span><b className="small">{analysisDate(data.last_seen)}</b></div>
              </div>
              {offline ? <p className="failure-reading"><b>Reading:</b> {Math.round(100 * (data.late_share ?? 0))}% of these reached the server minutes late, against {Math.round(100 * (baseline ?? 0))}% of all ad events. That fits a phone without internet, not an ad-network problem.</p> : null}
              <div className="detail-grid">
                <div className="detail-block"><span className="eyebrow">When</span><When detail={data} /></div>
                <Counts title="Ad unit" rows={data.ad_units} total={data.times} name={unitName} />
                <Counts title="Countries" rows={data.countries} total={data.times} name={(value) => countryName(value)} />
                {scope.player ? null : <Counts title="Players hit most" rows={data.top_players} total={data.times} name={(value) => <Link to={players} search={{ player: value ?? '' }} className="mono">{(value ?? '').slice(0, 8)}…</Link>} />}
                <Counts title="App versions" rows={data.versions} total={data.times} />
                <Counts title="Placements" rows={data.placements} total={data.times} name={(value) => words(value)} />
                <div className="detail-block">
                  <span className="eyebrow">Levels</span>
                  <p>{data.level_low == null ? 'No level sent' : data.level_low === data.level_high ? `Level ${data.level_low}` : `Level ${data.level_low} to ${data.level_high}, median ${data.level_median}`}</p>
                </div>
              </div>
              <span className="eyebrow">Latest</span>
              <div className="table-wrap">
                <table className="compact-table">
                  <thead><tr><th>When</th><th>Player</th><th>Country</th><th className="num">Level</th><th>Version</th><th className="num">Reached the server</th></tr></thead>
                  <tbody>
                    {data.latest.map((item) => (
                      <tr key={`${item.client_ts}-${item.player}`}>
                        <td>{analysisDate(item.client_ts)}</td>
                        <td><Link to={players} search={{ player: item.player }} className="mono">{item.player.slice(0, 8)}…</Link></td>
                        <td>{item.country ? countryName(item.country) : MUTED}</td>
                        <td className="num">{item.level ?? '—'}</td>
                        <td>{item.app_version ?? MUTED}</td>
                        <td className="num">{item.sent_after_seconds != null && item.sent_after_seconds > data.late_after_seconds ? <span className="warn-text">{item.sent_after_seconds >= 3600 ? `${Math.round(item.sent_after_seconds / 3600)} h later` : `${Math.round(item.sent_after_seconds / 60)} min later`}</span> : 'on time'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        }}
      </QueryRegion>
    </section>
  );
}

export function AdFailuresPanel({ scope, narrow, onNarrow }: { scope: AdScope; narrow: Narrow; onNarrow: (narrow: Narrow) => void }): ReactElement {
  const url = adPath(scope, 'failures');
  const failures = useRead<AdFailures>(url);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'times', desc: true });
  const [find, setFind] = useState('');
  const [focus, setFocus] = useState<Focus>(null);
  const all = failures.data?.rows ?? [];
  const formats = [...new Set(all.map((row) => row.format))];
  const shown = sortRows(all.filter((row) => (!narrow.format || row.format === narrow.format) && (!narrow.kind || row.kind === narrow.kind) && row.reason.toLowerCase().includes(find.trim().toLowerCase())), sort.key, sort.desc);
  const at = focus ? shown.findIndex((row) => row.format === focus.format && row.kind === focus.kind && row.reason === focus.reason) : -1;
  if (focus && at >= 0) return <FailurePage scope={scope} rows={shown} at={at} onBack={() => setFocus(null)} onGo={(index) => { const next = shown[index]!; setFocus({ format: next.format, kind: next.kind, reason: next.reason }); }} />;
  const head = (key: SortKey, label: string, num = false): ReactElement => (
    <th className={`${num ? 'num ' : ''}sortable${sort.key === key ? ' sorted' : ''}`} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" onClick={() => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: num }))}>{label}<span className="sort-arrow">{sort.key === key ? (sort.desc ? '▼' : '▲') : ''}</span></button>
    </th>
  );
  return (
    <section className="panel money-failures" id="money-failures">
      <div className="panel-header">
        <div className="title-count"><h2>Failures and blocks</h2><span className="count">{all.length}</span></div>
        <span className="quiet-actions">
          <Pick<string> label="Format" value={narrow.format} options={[{ value: '', label: 'All' }, ...formats.map((item) => ({ value: item, label: words(item) }))]} onChange={(format) => onNarrow({ ...narrow, format })} />
          <Pick<string> label="Kind" value={narrow.kind} options={KINDS} onChange={(kind) => onNarrow({ ...narrow, kind })} />
          <label className="search"><Ico name="search" size={14} /><input type="search" aria-label="Search reasons" placeholder="Search reasons…" value={find} onChange={(event) => setFind(event.target.value)} /></label>
        </span>
      </div>
      <QueryRegion query={failures} path={url} skeleton={<Skeleton rows={6} columns={6} />}>
        {() => (shown.length ? (
          <div className="table-wrap">
            <table className="compact-table failures-table">
              <thead><tr>{head('format', 'Format')}{head('kind', 'Kind')}{head('reason', 'Reason')}{head('times', 'Times', true)}{scope.player ? null : head('players', 'Players', true)}{head('last_seen', 'Last seen', true)}</tr></thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={`${row.format}-${row.kind}-${row.reason}`} className="click" tabIndex={0} onClick={() => setFocus({ format: row.format, kind: row.kind, reason: row.reason })} onKeyDown={(event) => { if (event.key === 'Enter') setFocus({ format: row.format, kind: row.kind, reason: row.reason }); }}>
                    <td>{words(row.format)}</td>
                    <td><span className="kind"><span className={`dot tone-${KIND_TONE[row.kind]}`} aria-hidden="true" />{KIND_WORDS[row.kind]}</span></td>
                    <td className="reason mono" title={row.reason}>{row.reason === NO_REASON ? <span className="muted">{row.reason}</span> : row.reason}</td>
                    <td className="num">{number(row.times)}</td>
                    {scope.player ? null : <td className="num">{number(row.players)}</td>}
                    <td className="num muted">{analysisDate(row.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="help panel-body">{all.length ? 'No failure matches.' : 'No failures or blocks in these days.'}</p>)}
      </QueryRegion>
    </section>
  );
}

/** The whole set: states, revenue beside revenue per day, and failures. The states table narrows the failures list. */
export function AdWidgets({ scope }: { scope: AdScope }): ReactElement {
  const [narrow, setNarrow] = useState<Narrow>({ format: '', kind: '' });
  const toFailures = (next: Narrow) => { setNarrow(next); document.getElementById('money-failures')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };
  return (
    <div className="money-widgets">
      <AdStatesPanel scope={scope} onNarrow={toFailures} />
      <div className="split money-split">
        <AdRevenuePanel scope={scope} />
        <AdDailyPanel scope={scope} />
      </div>
      <AdFailuresPanel scope={scope} narrow={narrow} onNarrow={setNarrow} />
    </div>
  );
}
