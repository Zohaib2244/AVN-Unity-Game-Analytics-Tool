// Acquisition: where players came from, what they cost and what they earned (acquisition_report.py).
// A plain-words answer, the sources table (installs both ways, came back, earned per install, cost per
// install, return against the goal), then the cohorts of one campaign: by install day (table + return
// curves with the goals) or by calendar day (revenue against cost). Goals are set here, for the game
// and per campaign. The date range picks install days.
import { Fragment, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Popover, Segmented } from '@avn/ui';
import { useRead, write } from '@/api';
import { addDays, number, plural, shortDay, today } from '@/lib/format';
import { filterQuery, type ActiveFilters } from '@/lib/filters';
import { gamePath, gameURL } from '@/lib/games';
import { useStored } from '@/lib/store';
import type { AcquisitionCohorts, AcquisitionReport, AcquisitionRow, CohortDay, CostSettings, Game, ReturnGoal, ReturnGoals } from '@/lib/types';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading, Metric, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { rangeText, resolveRange } from '@/components/DateRange';
import { Share } from '@/components/Share';
import { DoraScene } from '@/components/flavour';
import { Ico } from '@/components/icons';
import { ALL_PAID, FEW, splitTracked, RETENTION_DAYS, TABLE_DAYS, VALUE_DAYS, answer, cleanGoals, costWords, goalOn, judgedGoal, money, pct, pct1, tone } from './acquisition/model';

const GROUPS = [{ value: 'campaign', label: 'Campaign' }, { value: 'media_source', label: 'Media source' }, { value: 'channel', label: 'Channel' }] as const;
type Group = (typeof GROUPS)[number]['value'];

export function AcquisitionPage({ game }: { game: Game }): ReactElement {
  const [filters, setFilters] = useFilters(game);
  const [group, setGroup] = useStored<Group>(`avn-acquisition-group-${game.id}`, 'campaign');
  const [cohort, setCohort] = useStored<string>(`avn-acquisition-cohort-${game.id}`, ALL_PAID);
  const query = filterQuery(filters);
  const reportPath = `${gameURL(game)}/insights/acquisition?${query}&group_by=${group}`;
  const report = useRead<AcquisitionReport>(reportPath);
  const settings = useRead<CostSettings>(`${gameURL(game)}/cost-settings`);
  // The date range is the install days: pick one day, or shift-click to extend it to a run of days.
  const pickDays = (from: string, to: string) => setFilters((state) => ({ ...state, range: { preset: 'custom', from: from <= to ? from : to, to: from <= to ? to : from } }));
  const goalsFor = (name: string): ReturnGoal[] => { const goals = report.data?.goals; return goals ? (goals.campaigns[name]?.length ? goals.campaigns[name]! : goals.game) : []; };
  return (
    <>
      <Heading title="Acquisition" subtitle="Where players came from, what they cost and what they earned. The days pick install days." />
      <FilterBar game={game} state={filters} onChange={setFilters} />
      <QueryRegion query={report} path={reportPath} skeleton={<Skeleton kind="stats" />}>
        {(data) => (!data.available ? <div className="empty-scene"><DoraScene /><p>{data.note}</p></div> : (
          <>
            <CostNotice game={game} data={data} settings={settings.data} />
            <p className="answer-line">{filters.range.preset === 'custom' ? <b>Installed {rangeText(filters.range)}: </b> : null}{answer(data, goalsFor)}</p>
            <KeyNumbers data={data} />
            <InstallDayPicker game={game} filters={filters} onPick={pickDays} onAll={() => setFilters((state) => ({ ...state, range: resolveRange('30') }))} />

            <section className="panel">
              <div className="panel-header">
                <div><h2 title="Earned is ad revenue per install, added up from the install day. Return is that against the cost of an install.">Sources</h2></div>
                <Segmented<Group> label="Group installs by" value={group} onChange={setGroup} options={GROUPS.map((item) => ({ ...item }))} />
              </div>
              <SourcesTable data={data} goalsFor={goalsFor} selected={group === 'campaign' ? cohort : null} onPick={group === 'campaign' ? setCohort : undefined} />
            </section>
          </>
        ))}
      </QueryRegion>
      {report.data?.available ? <CohortPanel game={game} filters={query} cohort={cohort} onCohort={setCohort} settings={settings.data} onDay={(day) => pickDays(day, day)} /> : null}
    </>
  );
}

function CostNotice({ game, data, settings }: { game: Game; data: AcquisitionReport; settings: CostSettings | undefined }): ReactElement | null {
  const words = costWords(data.cost);
  const [typed, setTyped] = useState('');
  const { toast, toastError } = useNotify();
  const save = async () => {
    try { await write(`${gameURL(game)}/cost-settings`, { method: 'PUT', body: JSON.stringify({ app_id: typed.trim() }) }); toast('App ID saved. Cost is fetched next.'); }
    catch (error) { toastError(error); }
  };
  const [build, setBuild] = useState('');
  const saveBuild = async () => {
    try { await write(`${gameURL(game)}/cost-settings`, { method: 'PUT', body: JSON.stringify({ first_sdk_version: build.trim() }) }); toast('First build with AVN saved.'); }
    catch (error) { toastError(error); }
  };
  const askBuild = (data.cost.state === 'ok' || data.cost.state === 'failed') && !data.first_sdk_version;
  const notes = [
    words ? <span key="cost" className={words.kind === 'warn' ? 'warn-text' : undefined}>{words.text}</span> : null,
    data.updated_players_left_out ? <span key="upd">{number(data.updated_players_left_out)} players who updated into this build rather than installed it are left out.</span> : null,
    data.cost.not_final_from ? <span key="lag">Cost-service installs from {shortDay(data.cost.not_final_from)} on may still grow.</span> : null,
  ].filter(Boolean);
  if (!notes.length && data.cost.state !== 'no_app_id' && !askBuild) return null;
  return (
    <div className="analysis-context acquisition-notes">
      <span>{notes.reduce<ReactElement[]>((all, item, index) => (index ? [...all, <span key={`s${index}`}> · </span>, item!] : [item!]), [])}</span>
      {data.cost.state === 'no_app_id' || data.cost.state === 'not_allowed' ? (
        <span className="app-id-field">
          <input aria-label="AppsFlyer app ID" placeholder={settings?.default_app_id || 'id123456789'} value={typed} onChange={(event) => setTyped(event.target.value)} />
          <button type="button" className="btn sm" disabled={!typed.trim()} onClick={() => void save()}>Save app ID</button>
        </span>
      ) : null}
      {askBuild ? (
        <span className="app-id-field">
          <span>Installs on older builds can’t appear here. First build with AVN:</span>
          <input aria-label="First app version with AVN" placeholder="0.0.9" value={build} onChange={(event) => setBuild(event.target.value)} />
          <button type="button" className="btn sm" disabled={!build.trim()} onClick={() => void saveBuild()}>Save</button>
        </span>
      ) : null}
    </div>
  );
}

const faint = (players: number | undefined): string => (players != null && players < FEW ? ' few' : '');

function SourcesTable({ data, goalsFor, selected, onPick }: { data: AcquisitionReport; goalsFor: (name: string) => ReturnGoal[]; selected: string | null; onPick?: (name: string) => void }): ReactElement {
  const hasCost = data.cost.state === 'ok' || data.cost.state === 'failed';
  const rows = [...(data.rows.some((row) => row.paid) ? [data.all_paid] : []), ...data.rows];
  const label = GROUPS.find((item) => item.value === data.group_by)?.label ?? 'Source';
  // A day nobody has reached yet (a young game) has no column: it would say “—” on every row.
  const comeBack = RETENTION_DAYS.filter((day) => rows.some((row) => row.retention[`day_${day}`]?.players));
  const earnedDays = TABLE_DAYS.filter((day) => rows.some((row) => row.value_per_install[`day_${day}`]?.players));
  return (
    <>
      <div className="table-wrap">
        <table className="compact-table acq-table">
          <thead>
            <tr><th rowSpan={2}>{label}</th><th rowSpan={2} className="num" title="Players who opened the game for the first time here; after the slash, the installs the cost service counted on a build that sends AVN events (every install until the first build with AVN is set)">Installs</th>{comeBack.length ? <th colSpan={comeBack.length} className="grp">Came back on day</th> : null}{earnedDays.length ? <th colSpan={earnedDays.length} className="grp">Earned per install by day</th> : null}{hasCost ? <><th rowSpan={2} className="num">Cost per install</th><th rowSpan={2} className="num" title="Earned per install ÷ cost per install, on the latest day with a goal">Return</th></> : null}</tr>
            <tr>{comeBack.map((day) => <th key={`r${day}`} className="num">{day}</th>)}{earnedDays.map((day) => <th key={`v${day}`} className="num">{day}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => <SourceRow key={row.value} row={row} comeBack={comeBack} earnedDays={earnedDays} hasCost={hasCost} goals={goalsFor(row.value)} total={row === data.all_paid} selected={selected === row.value} onPick={onPick && (row.paid !== false) ? () => onPick(row.value) : undefined} />)}
          </tbody>
        </table>
      </div>
      <p className="foot-note">A day counts only players who have had that many days · faint numbers rest on fewer than {FEW} players{onPick ? ' · pick a campaign to see its cohorts below' : ''}.</p>
    </>
  );
}

function SourceRow({ row, comeBack, earnedDays, hasCost, goals, total, selected, onPick }: { row: AcquisitionRow; comeBack: number[]; earnedDays: number[]; hasCost: boolean; goals: ReturnGoal[]; total: boolean; selected: boolean; onPick?: () => void }): ReactElement {
  const judged = judgedGoal(row, goals);
  return (
    <tr className={`${onPick ? 'click' : ''}${selected ? ' picked' : ''}${total ? ' total-row' : ''}`} onClick={onPick} tabIndex={onPick ? 0 : undefined} onKeyDown={(event) => { if (onPick && event.key === 'Enter') onPick(); }} aria-selected={onPick ? selected : undefined}>
      <td><b>{row.value}</b></td>
      <td className="num">{number(row.installs)}{(row.sdk_installs ?? row.service_installs) ? <span className="muted" title={row.sdk_installs != null ? 'Installs on a build that sends AVN events' : 'Every install the cost service counted'}> / {number(row.sdk_installs ?? row.service_installs ?? 0)}</span> : null}</td>
      {comeBack.map((day) => { const item = row.retention[`day_${day}`]; return <td key={`r${day}`} className={`num${faint(item?.players)}`}>{item?.players && item.rate != null ? <Share part={Math.round(item.rate * item.players)} whole={item.players} percent={item.rate * 100} unit="installs" /> : <span className="muted">—</span>}</td>; })}
      {earnedDays.map((day) => { const item = row.value_per_install[`day_${day}`]; return <td key={`v${day}`} className={`num${faint(item?.players)}`}>{item?.players ? money(item.per_player, 3) : <span className="muted">—</span>}</td>; })}
      {hasCost ? (
        <>
          <td className="num">{row.cost_per_install != null ? money(row.cost_per_install) : <span className="muted">{row.paid === false ? '—' : row.cost === 0 ? 'cost 0' : 'no cost'}</span>}</td>
          <td className="num">{judged ? <span className={`ret ${tone(judged.value, judged.goal)}`} title={`Day ${judged.goal.day} goal: ${judged.goal.percent}%`}>{pct(judged.value)} <small>d{judged.goal.day}</small></span> : <span className="muted">{goals.length ? '—' : 'set a goal'}</span>}</td>
        </>
      ) : null}
    </tr>
  );
}

/* ─── Cohorts of one campaign ─── */

function CohortPanel({ game, filters, cohort, onCohort, settings, onDay }: { game: Game; filters: URLSearchParams; cohort: string; onCohort: (name: string) => void; settings: CostSettings | undefined; onDay: (day: string) => void }): ReactElement {
  const [mode, setMode] = useStored<'install' | 'calendar'>(`avn-acquisition-mode-${game.id}`, 'install');
  const navigate = useNavigate();
  const path = `${gameURL(game)}/insights/acquisition/cohorts?${filters}${cohort && cohort !== ALL_PAID ? `&cohort=${encodeURIComponent(cohort)}` : ''}`;
  const data = useRead<AcquisitionCohorts>(path);
  const seePlayers = () => void navigate({ to: gamePath(game, 'players'), search: cohort === ALL_PAID ? { install: 'paid' } : { campaign: cohort } });
  return (
    <section className="panel section-spacing" id="acquisition-cohorts">
      <div className="panel-header">
        <div>
          <h2 title={mode === 'install' ? 'Each install day: what it cost and how much of that its players have earned back.' : 'Revenue these players made each day, against what was spent that day.'}>Cohorts</h2>
        </div>
        <div className="quiet-actions">
          <label className="inline-field"><span className="sr-only">Campaign</span><select aria-label="Campaign" value={cohort} onChange={(event) => onCohort(event.target.value)}>{[ALL_PAID, ...(data.data?.campaigns ?? [])].map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <Segmented<'install' | 'calendar'> label="Cohorts by" value={mode} onChange={setMode} options={[{ value: 'install', label: 'By install day' }, { value: 'calendar', label: 'By calendar day' }]} />
          {data.data && settings ? <GoalEditor game={game} campaign={cohort} goals={settings.goals} current={data.data.goals} own={data.data.has_own_goals} /> : null}
          <button type="button" className="btn primary" onClick={seePlayers}><Ico name="users" size={14} /> See these players</button>
        </div>
      </div>
      <QueryRegion query={data} path={path} skeleton={<Skeleton kind="chart" />}>
        {(result) => (!result.available ? <p className="help panel-body">{result.note}</p> : mode === 'install' ? <InstallDays data={result} onDay={onDay} /> : <CalendarDays data={result} />)}
      </QueryRegion>
    </section>
  );
}

function InstallDays({ data, onDay }: { data: AcquisitionCohorts; onDay: (day: string) => void }): ReactElement {
  const hasCost = data.cost.state === 'ok' || data.cost.state === 'failed';
  if (!data.days.length) return <p className="help panel-body">No installs from {data.campaign} in these days.</p>;
  // Days before the first player was seen here (the build didn't send AVN events yet) fold into one line.
  const { before, tracked } = splitTracked(data.days);
  return (
    <>
      <RetentionHeat days={tracked} onDay={onDay} />
      {hasCost && tracked.length ? <ReturnCurves days={tracked} goals={data.goals} /> : null}
      <div className="table-wrap">
        <table className="compact-table acq-table cohort-table">
          <thead>
            <tr><th rowSpan={2}>Install day</th>{hasCost ? <><th rowSpan={2} className="num">Cost</th><th rowSpan={2} className="num" title="Installs the cost service counted">Installs (service)</th><th rowSpan={2} className="num">Cost per install</th></> : null}<th rowSpan={2} className="num" title="Players who opened the game here, against the cost-service count">Seen here</th><th colSpan={VALUE_DAYS.length} className="grp">{hasCost ? 'Return by day since install' : 'Earned per install by day since install'}</th></tr>
            <tr>{VALUE_DAYS.map((day) => { const goal = goalOn(data.goals, day); return <th key={day} className="num ret-col">{day}{goal ? <small className="goal-mark" title={`Goal: ${goal.percent}% by day ${day}`}>goal {goal.percent}%</small> : null}</th>; })}</tr>
          </thead>
          <tbody>
            {[...tracked].reverse().map((row) => <CohortRow key={row.day} row={row} goals={data.goals} hasCost={hasCost} onDay={onDay} />)}
            {before.length ? <BeforeRow days={before} hasCost={hasCost} /> : null}
          </tbody>
        </table>
      </div>
      <p className="foot-note">On a goal day, green cells reach the goal and red ones don’t yet · faint numbers rest on fewer than {FEW} players · days marked * may still gain installs at the cost service · return is earned per player seen here ÷ cost per install.</p>
    </>
  );
}

/** One line for the days before any player was seen here: their cost and installs, nothing to return yet. */
function BeforeRow({ days, hasCost }: { days: CohortDay[]; hasCost: boolean }): ReactElement {
  const cost = days.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  const installs = days.reduce((sum, row) => sum + (row.service_installs ?? 0), 0);
  const span = days.length === 1 ? shortDay(days[0]!.day) : `${shortDay(days[0]!.day)} to ${shortDay(days[days.length - 1]!.day)}`;
  return (
    <tr className="before-row">
      <td title="No player was seen here on these days: the builds people installed did not send AVN events yet">{span} <span className="muted">· {plural(days.length, 'day')} before AVN events</span></td>
      {hasCost ? <><td className="num">{money(cost)}</td><td className="num">{installs ? number(installs) : <span className="muted">—</span>}</td><td className="num">{installs ? money(cost / installs) : <span className="muted">—</span>}</td></> : null}
      <td className="num muted">0</td>
      <td className="muted" colSpan={VALUE_DAYS.length} />
    </tr>
  );
}

function CohortRow({ row, goals, hasCost, onDay }: { row: CohortDay; goals: ReturnGoal[]; hasCost: boolean; onDay: (day: string) => void }): ReactElement {
  return (
    <tr className="click" tabIndex={0} title="Show only players who installed on this day" onClick={() => onDay(row.day)} onKeyDown={(event) => { if (event.key === 'Enter') onDay(row.day); }}>
      <td>{shortDay(row.day)}{row.final ? null : <span className="muted" title="The cost service may still add installs for this day"> *</span>}</td>
      {hasCost ? <><td className="num">{money(row.cost)}</td><td className="num">{row.service_installs ? number(row.service_installs) : <span className="muted">—</span>}</td><td className="num">{money(row.cost_per_install)}</td></> : null}
      <td className="num">{number(row.installs)}{row.seen_share != null ? <span className="muted" title={row.sdk_installs != null ? `Players seen here ÷ the ${number(row.sdk_installs)} installs on a build that sends AVN events (${number(row.service_installs ?? 0)} installs in all)` : 'Players seen here ÷ every install the cost service counted'}> · {pct(row.seen_share)}</span> : null}</td>
      {VALUE_DAYS.map((day) => {
        const item = row.value_per_install[`day_${day}`];
        if (!item?.players) return <td key={day} className="num muted ret-col">·</td>;
        const value = hasCost ? row.return[`day_${day}`] : item.per_player;
        const shade = hasCost ? tone(value, goalOn(goals, day)) : 'none';
        return <td key={day} className={`num ret-col ret-cell ${shade}${faint(item.players)}`}>{hasCost ? pct(value) : money(value, 3)}</td>;
      })}
    </tr>
  );
}

/** Return by day since install: one faint line per install day, the players-weighted average bold,
 *  and each goal as a target mark. Days are evenly spaced (0, 1, 3, 7, 14, 30). */
function ReturnCurves({ days, goals }: { days: CohortDay[]; goals: ReturnGoal[] }): ReactElement | null {
  const width = 1100; const height = 230; const left = 48; const right = 40; const top = 14; const bottom = 26;
  const lines = days.map((row) => VALUE_DAYS.map((day) => ({ day, value: row.value_per_install[`day_${day}`]?.players ? row.return[`day_${day}`] : null, players: row.value_per_install[`day_${day}`]?.players ?? 0 })));
  const average = VALUE_DAYS.map((day, index) => {
    const known = lines.map((line) => line[index]!).filter((point) => point.value != null && point.players);
    const weight = known.reduce((sum, point) => sum + point.players, 0);
    return { day, value: weight ? known.reduce((sum, point) => sum + point.value! * point.players, 0) / weight : null };
  });
  const peak = Math.max(1, ...lines.flat().map((point) => point.value ?? 0), ...goals.map((goal) => goal.percent / 100));
  const x = (index: number) => left + (index * (width - left - right)) / (VALUE_DAYS.length - 1);
  const y = (value: number) => top + (1 - value / peak) * (height - top - bottom);
  const path = (points: Array<{ value?: number | null }>) => points.map((point, index) => (point.value == null ? null : `${x(index).toFixed(1)},${y(point.value).toFixed(1)}`)).filter(Boolean).join(' ');
  const ticks = [0, peak / 2, peak];
  if (!average.some((point) => point.value != null)) return null;
  return (
    <div className="panel-body return-curves">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Return by day since install for each install day, with the goals">
        {ticks.map((tick) => <g key={tick}><line className="chart-grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} /><text className="chart-axis" x={left - 6} y={y(tick) + 4} textAnchor="end">{pct(tick)}</text></g>)}
        <line className="break-even" x1={left} x2={width - right} y1={y(1)} y2={y(1)} />
        {lines.map((line, index) => <polyline key={days[index]!.day} className="cohort-line" points={path(line)} />)}
        <polyline className="cohort-average" points={path(average)} />
        {goals.map((goal) => { const index = VALUE_DAYS.indexOf(goal.day as (typeof VALUE_DAYS)[number]); return index < 0 ? null : <g key={goal.day} className="goal-target"><circle cx={x(index)} cy={y(goal.percent / 100)} r={6} /><text x={x(index) + 9} y={y(goal.percent / 100) - 8}>goal {goal.percent}%</text></g>; })}
        {VALUE_DAYS.map((day, index) => <text key={day} className="chart-axis" x={x(index)} y={height - 6} textAnchor="middle">day {day}</text>)}
      </svg>
      <p className="small muted">Bold: all these install days together · faint: each install day · dashed: 100%, the cost paid back.</p>
    </div>
  );
}

function CalendarDays({ data }: { data: AcquisitionCohorts }): ReactElement {
  const rows = data.by_calendar_day;
  if (!rows.length) return <p className="help panel-body">No revenue or cost in these days.</p>;
  const peak = Math.max(0.01, ...rows.map((row) => Math.max(row.revenue, row.cost ?? 0)));
  const totalRevenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const totalCost = rows.reduce((sum, row) => sum + (row.cost ?? 0), 0);
  return (
    <>
      <div className="panel-body calendar-bars" role="img" aria-label="Revenue and cost per calendar day">
        {rows.map((row) => (
          <div key={row.day} className="cal-day" title={`${shortDay(row.day)}: earned ${money(row.revenue)}${row.cost != null ? `, spent ${money(row.cost)}` : ''}`}>
            <span className="cal-cost" style={{ height: `${((row.cost ?? 0) / peak) * 100}%` }} />
            <span className="cal-revenue" style={{ height: `${(row.revenue / peak) * 100}%` }} />
            <small>{shortDay(row.day)}</small>
          </div>
        ))}
      </div>
      <p className="foot-note"><span className="key revenue" /> earned by these players that day ({money(totalRevenue)} in all) · <span className="key cost" /> spent that day ({money(totalCost)}) · earnings keep coming in for days after each install, so a young campaign looks worse here than by install day.</p>
    </>
  );
}

/* ─── Goals ─── */

function GoalEditor({ game, campaign, goals, current, own }: { game: Game; campaign: string; goals: ReturnGoals; current: ReturnGoal[]; own: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const forCampaign = campaign !== ALL_PAID;
  const [scope, setScope] = useState<'game' | 'campaign'>(own && forCampaign ? 'campaign' : 'game');
  const [rows, setRows] = useState<Array<{ day: string; percent: string }>>([]);
  const { toast, toastError } = useNotify();
  const openWith = (next: 'game' | 'campaign') => { setScope(next); const list = next === 'campaign' ? goals.campaigns[campaign] ?? goals.game : goals.game; setRows(list.length ? list.map((goal) => ({ day: String(goal.day), percent: String(goal.percent) })) : [{ day: '7', percent: '75' }]); };
  const summary = useMemo(() => (current.length ? current.map((goal) => `d${goal.day} ${goal.percent}%`).join(' · ') : 'No goal'), [current]);
  const save = async (clear = false) => {
    const list = clear ? [] : cleanGoals(rows);
    const next: ReturnGoals = scope === 'campaign' ? { ...goals, campaigns: { ...goals.campaigns, [campaign]: list } } : { ...goals, game: list };
    if (scope === 'campaign' && !list.length) delete next.campaigns[campaign];
    try { await write(`${gameURL(game)}/cost-settings`, { method: 'PUT', body: JSON.stringify({ goals: next }) }); toast(scope === 'campaign' ? `Goals saved for ${campaign}.` : 'Goals saved for this game.'); setOpen(false); }
    catch (error) { toastError(error); }
  };
  return (
    <>
      <button ref={button} type="button" className="btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => { if (!open) openWith(scope); setOpen(!open); }} title="Return goals: by day N, ad revenue should cover this share of the cost">
        <Ico name="flag" size={14} /> {summary}{own ? <small className="muted"> · own</small> : null}
      </button>
      <Popover position="fixed" open={open} onClose={() => setOpen(false)} anchor={button} width={320} className="goal-pop">
        <div className="pop-scroll goal-editor">
          {forCampaign ? <Segmented<'game' | 'campaign'> label="Goals for" value={scope} onChange={openWith} options={[{ value: 'game', label: 'This game' }, { value: 'campaign', label: 'This campaign' }]} /> : null}
          <p className="small muted">{scope === 'campaign' ? `${campaign} uses these instead of the game’s.` : 'Every campaign without its own goals uses these.'}</p>
          {rows.map((row, index) => (
            <div key={index} className="goal-row">
              <label>By day<input type="number" min={0} max={90} value={row.day} onChange={(event) => setRows(rows.map((item, at) => (at === index ? { ...item, day: event.target.value } : item)))} /></label>
              <label>return<input type="number" min={1} max={1000} value={row.percent} onChange={(event) => setRows(rows.map((item, at) => (at === index ? { ...item, percent: event.target.value } : item)))} /><span>%</span></label>
              <button type="button" className="icon-btn" aria-label="Remove this goal" onClick={() => setRows(rows.filter((_, at) => at !== index))}><Ico name="close" size={13} /></button>
            </div>
          ))}
          {rows.length < 6 ? <button type="button" className="filter-clear" onClick={() => setRows([...rows, { day: '', percent: '' }])}>+ Add a day</button> : null}
          
        </div>
        <div className="pop-foot">
          {scope === 'campaign' && own ? <button type="button" className="filter-clear" onClick={() => void save(true)}>Use the game’s goals</button> : <span />}
          <button type="button" className="btn primary" onClick={() => void save()}>Save goals</button>
        </div>
      </Popover>
    </>
  );
}

/* ─── Headline numbers and the install-day picker ─── */

function KeyNumbers({ data }: { data: AcquisitionReport }): ReactElement {
  const paid = data.all_paid;
  const organic = data.rows.find((row) => row.value === 'Organic')?.installs ?? 0;
  const back = (day: number): ReactElement | string => { const item = paid?.retention[`day_${day}`]; return item?.players && item.rate != null ? <Share part={Math.round(item.rate * item.players)} whole={item.players} percent={item.rate * 100} unit="installs" /> : '—'; };
  const earned = paid?.value_per_install.day_7?.players ? paid.value_per_install.day_7 : null;
  return (
    <div className="kpis">
      <Metric label="Installs" value={number(data.installs)} note={`${number(paid?.installs ?? 0)} paid · ${number(organic)} organic`} />
      <Metric label="Paid came back day 1" value={back(1)} note="of the paid installs that had a day 1" />
      <Metric label="Paid came back day 7" value={back(7)} note="of the paid installs that had a day 7" />
      <Metric label="Paid earned by day 7" value={earned ? money(earned.per_player, 3) : '—'} note="ad revenue per paid install" />
    </div>
  );
}

/** Installs per day for the last 30 days: click a day to see only the players who installed on it, shift-click to extend. */
function InstallDayPicker({ game, filters, onPick, onAll }: { game: Game; filters: ActiveFilters; onPick: (from: string, to: string) => void; onAll: () => void }): ReactElement | null {
  const anchor = useRef<string | null>(null);
  const wide: ActiveFilters = { ...filters, range: { preset: 'custom', from: addDays(today(), -29), to: today() } };
  const path = `${gameURL(game)}/insights/acquisition/cohorts?${filterQuery(wide)}`;
  const cohorts = useRead<AcquisitionCohorts>(path);
  const days = cohorts.data?.available ? cohorts.data.days : [];
  if (days.length < 2) return null;
  const top = Math.max(...days.map((row) => row.installs), 1);
  const chosen = (day: string) => day >= filters.range.from && day <= filters.range.to;
  const narrowed = filters.range.preset === 'custom' || filters.range.from > addDays(today(), -29) || filters.range.to < today();
  return (
    <section className="panel install-days">
      <div className="panel-header">
        <div><h2 title="The page shows players who first opened the game on the chosen days. Click a day for only that day, shift-click to extend to a run of days.">Install days</h2></div>
        <span className="quiet-actions"><span className="muted small">Paid installs per day</span>{narrowed ? <button type="button" className="btn sm" onClick={onAll}>All last 30 days</button> : null}</span>
      </div>
      <div className="panel-body">
        <div className="day-bars" role="group" aria-label="Pick install days">
          {days.map((row) => (
            <button key={row.day} type="button" className={`day-bar${chosen(row.day) ? ' on' : ''}`} aria-pressed={chosen(row.day)} title={`${shortDay(row.day)} · ${number(row.installs)} paid installs`}
              onClick={(event) => { if (event.shiftKey && anchor.current) onPick(anchor.current, row.day); else { anchor.current = row.day; onPick(row.day, row.day); } }}>
              <i style={{ height: `${Math.max(6, (100 * row.installs) / top)}%` }} /><span>{row.day.slice(8)}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Who came back, for each install day: one row per day, one cell per day since install (Day 1, 3, 7) shaded by the share
 *  that returned, with how many. A day nobody has reached yet has no column. Click a day to see only its installs. */
function RetentionHeat({ days, onDay }: { days: CohortDay[]; onDay: (day: string) => void }): ReactElement | null {
  const columns = RETENTION_DAYS.filter((day) => days.some((row) => row.retention?.[`day_${day}`]?.players));
  if (!columns.length) return null;
  return (
    <div className="retention-heat panel-body" style={{ '--cols': columns.length } as CSSProperties} role="table" aria-label="Who came back, by install day">
      <span className="rh-head" role="columnheader">Install day</span>
      {columns.map((day) => <span key={day} className="rh-head" role="columnheader">Day {day}</span>)}
      {[...days].reverse().map((row) => (
        <Fragment key={row.day}>
          <button type="button" className="rh-day" role="rowheader" title="Show only players who installed on this day" onClick={() => onDay(row.day)}>{shortDay(row.day)} <span className="muted">{number(row.installs)}</span></button>
          {columns.map((day) => {
            const item = row.retention?.[`day_${day}`];
            if (!item?.players || item.rate == null) return <span key={day} className="rh-cell none" role="cell" title={`Day ${day} has not happened yet for this day's installs`}>·</span>;
            const back = Math.round(item.rate * item.players);
            return (
              <button key={day} type="button" role="cell" className={`rh-cell${item.players < FEW ? ' few' : ''}`} style={{ '--h': Math.min(1, item.rate * 2.2) } as CSSProperties}
                title={`${number(back)} of ${number(item.players)} installs came back on day ${day} · click for this day's players`} onClick={() => onDay(row.day)}>
                <span className="rh-n">{number(back)}</span><b>{pct1(item.rate)}</b>
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
