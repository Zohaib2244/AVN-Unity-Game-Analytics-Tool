// The Player tab's first half: what this player has done, at a glance. Ads seen by type, levels cleared and how
// fast, coins and powerups, sessions and habits, counted by the server from the AVN events standard over everything
// the player ever sent (not the date range above). A section the game sends no events for says so.
import { Share } from '@/components/Share';
import type { ReactElement } from 'react';
import { useRead } from '@/api';
import { QueryRegion, Skeleton } from '@/components/feedback';
import { duration, number, plural } from '@/lib/format';
import { gameURL } from '@/lib/games';
import type { Game, PlayerSummaryData, SummaryAdFormat } from '@/lib/types';

const AD_COLORS: Record<string, string> = { Interstitial: 'var(--accent)', Rewarded: 'var(--ok)', AppOpen: 'var(--warn)' };
const adColor = (format: string): string => AD_COLORS[format] ?? 'var(--info)';
const adName = (format: string): string => (format === 'AppOpen' ? 'App open' : format);
/** "free_coins" → "Free coins". */
export const plain = (text: string): string => { const spaced = text.replace(/_/g, ' '); return spaced.charAt(0).toUpperCase() + spaced.slice(1); };
const dayText = (value: string): string => new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dash = (value: number | null | undefined, format: (n: number) => string = number): string => (value == null ? '—' : format(value));
const seconds = (value: number | null | undefined): string => dash(value, duration);
const usd = (value: number, digits = 3): string => `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const whenText = (value: string): string => new Date(value).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

const COST_WORDS: Record<string, string> = {
  organic: 'Organic install: no cost.', no_record: 'No install record, so no cost.', updated: 'Updated from an older build, not a new install, so no cost.',
  no_cost: 'The cost service has no cost for this campaign that day.', off: 'Cost isn’t connected.', no_app_id: 'Cost needs this game’s app ID.', not_allowed: 'Cost isn’t available for this game yet.', failed: 'Couldn’t reach the cost service.',
};

/** What the player earned, day by day, against what they cost. */
function ValueCard({ data }: { data: PlayerSummaryData }): ReactElement | null {
  const money = data.money; const cost = data.cost;
  if (!money) return null;
  const days = money.per_day.slice(-30);
  const most = Math.max(0.000001, ...days.map(([, value]) => value));
  const share = cost?.state === 'ok' ? cost.paid_back_share ?? 0 : null;
  const where = data.install?.campaign ? data.install.campaign : data.install?.attributed ? plain(String(data.install.media_source ?? 'organic')) : 'no install record';
  return (
    <section className="ps-card ps-value">
      <h3>Earned and cost <small>{where}{cost?.install_day ? ` · installed ${dayText(cost.install_day)}` : ''}</small></h3>
      <div className="ps-value-top">
        <div><span>Ad revenue</span><b>{usd(money.total)}</b></div>
        <div><span>Cost to acquire</span><b>{cost?.state === 'ok' ? usd(cost.cost ?? 0, 2) : '—'}</b></div>
        <div><span>Paid back</span><b className={share != null && share >= 1 ? 'good' : undefined}>{share != null && cost?.cost ? <Share part={money.total} whole={cost.cost} percent={share * 100} unit="usd" /> : '—'}</b></div>
      </div>
      {share != null ? <div className="ps-payback" role="img" aria-label={`Paid back ${Math.round(share * 100)}% of the cost`}><i style={{ width: `${Math.max(1, Math.min(1, share) * 100)}%` }} /></div> : null}
      <p className="ps-note">{cost?.state === 'ok' ? `${cost.paid_back_day != null ? `Paid back the cost on day ${cost.paid_back_day} after install.` : 'Hasn’t paid back the cost yet.'} Cost is the campaign’s cost per install on the install day.` : COST_WORDS[cost?.state ?? 'off'] ?? ''}</p>
      {days.length ? (
        <>
          <h4>Earned per day <small>{days.length < money.per_day.length ? `last ${days.length} days with revenue` : ''}</small></h4>
          <svg viewBox="0 0 300 44" className="ps-days ps-earned" preserveAspectRatio="none" role="img" aria-label="Ad revenue per day">
            {days.map(([day, value], index) => { const width = Math.min(292 / days.length, 22); const height = Math.max(1.5, (value / most) * 38); return <rect key={day} x={4 + index * width} y={42 - height} width={Math.max(1, width - 2)} height={height} rx="1"><title>{`${dayText(day)}: ${usd(value)}`}</title></rect>; })}
          </svg>
        </>
      ) : <p className="ps-empty">No ad revenue from this player yet.</p>}
    </section>
  );
}

/** How many levels the player clears for each ad shown, e.g. "1 per 6.7 levels"; null when either is zero. */
export const levelsPerAd = (cleared: number, shown: number): string | null => (cleared > 0 && shown > 0 ? `1 per ${(cleared / shown).toFixed(1)} levels` : null);
/** Share of the levels cleared that took no fail, restart or second start. */
export const firstTryShare = (firstTry: number, cleared: number): string => (cleared > 0 ? `${firstTry.toLocaleString()} · ${Math.round((100 * firstTry) / cleared)}%` : '—');

function Bars({ rows, tone }: { rows: Array<[string, number]>; tone?: string }): ReactElement {
  const most = Math.max(1, ...rows.map(([, value]) => value));
  return (
    <div className="ps-bars">
      {rows.map(([label, value]) => (
        <div className="ps-bar" key={label}><span title={label}>{plain(label)}</span><i style={{ width: `${Math.max(4, (100 * value) / most)}%`, ...(tone ? { background: tone } : null) }} /><b>{number(value)}</b></div>
      ))}
    </div>
  );
}

function Spark({ points }: { points: Array<[number, number]> }): ReactElement | null {
  if (points.length < 2) return null;
  const xs = points.map(([x]) => x); const ys = points.map(([, y]) => y);
  const x0 = Math.min(...xs); const x1 = Math.max(...xs); const y0 = Math.min(...ys); const y1 = Math.max(...ys);
  const x = (value: number) => 4 + ((value - x0) / Math.max(1, x1 - x0)) * 292;
  const y = (value: number) => 46 - ((value - y0) / Math.max(1, y1 - y0)) * 40;
  const line = points.map(([px, py], index) => `${index ? 'L' : 'M'}${x(px).toFixed(1)} ${y(py).toFixed(1)}`).join('');
  return <svg viewBox="0 0 300 50" className="ps-spark" preserveAspectRatio="none" role="img" aria-label={`Balance from ${number(y0)} to ${number(y1)}`}><path d={`${line}L${x(x1)} 50L${x(x0)} 50Z`} className="ps-spark-fill" /><path d={line} className="ps-spark-line" vectorEffect="non-scaling-stroke" /></svg>;
}

function Pace({ pace }: { pace: Array<[number, number]> }): ReactElement | null {
  if (pace.length < 2) return null;
  const sorted = pace.map(([, value]) => value).sort((a, b) => a - b);
  const cap = sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]!;
  const width = 292 / pace.length;
  return (
    <>
      <svg viewBox="0 0 300 64" className="ps-pace" preserveAspectRatio="none" role="img" aria-label="Time to clear each level">
        {pace.map(([level, time], index) => { const height = Math.max(1.5, Math.min(1, time / cap) * 56); return <rect key={level} x={4 + index * width} y={60 - height} width={Math.max(1, width - 1)} height={height} className={time > cap ? 'slow' : undefined}><title>{`Level ${level}: ${duration(time)}`}</title></rect>; })}
      </svg>
      <p className="ps-note">Time to clear, level {pace[0]![0]} to {pace[pace.length - 1]![0]}. Taller is slower; the bright bars took far longer than this player’s usual.</p>
    </>
  );
}

function Stats({ items }: { items: Array<[string, string]> }): ReactElement {
  return <div className="ps-stats">{items.map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div>;
}

function AdsCard({ data }: { data: PlayerSummaryData }): ReactElement {
  const { ads } = data;
  const formats = Object.entries(ads.formats).sort((a, b) => b[1].shown - a[1].shown);
  const placements: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  formats.forEach(([, entry]) => {
    Object.entries(entry.placements).forEach(([name, count]) => { placements[name] = (placements[name] ?? 0) + count; });
    Object.entries(entry.reasons).forEach(([name, count]) => { reasons[name] = (reasons[name] ?? 0) + count; });
  });
  const rewarded: SummaryAdFormat | undefined = ads.formats.Rewarded;
  return (
    <section className="ps-card">
      <h3>Ads seen <small>{number(ads.shown)} shown · {number(ads.failed)} failed to show</small></h3>
      {formats.length ? (
        <>
          <div className="ps-seg" aria-hidden="true">{formats.map(([format, entry]) => <i key={format} style={{ flex: Math.max(1, entry.shown), background: adColor(format) }} />)}</div>
          <table className="ps-table"><thead><tr><th>Type</th><th>Shown</th><th>Closed</th><th>Failed</th><th>Earned</th></tr></thead><tbody>
            {formats.map(([format, entry]) => <tr key={format}><td><span className="ps-dot" style={{ background: adColor(format) }} />{adName(format)}</td><td>{number(entry.shown)}</td><td>{number(entry.closed)}</td><td>{number(entry.failed + (entry.load_failed ?? 0))}</td><td>{usd(entry.revenue ?? 0)}</td></tr>)}
          </tbody></table>
          <p className="ps-note">
            {rewarded?.shown ? `Rewarded: ${number(rewarded.rewarded)} of ${number(rewarded.shown)} watched to the reward (${Math.round((100 * rewarded.rewarded) / rewarded.shown)}%). ` : ''}
            {ads.average_seconds_on_screen != null ? `Ads stay on screen ${duration(ads.average_seconds_on_screen)} on average.` : ''}
          </p>
          {Object.keys(placements).length ? <><h4>Where they appear</h4><Bars rows={Object.entries(placements).sort((a, b) => b[1] - a[1]).slice(0, 5)} /></> : null}
          {Object.keys(reasons).length ? <><h4>Why ads failed</h4><Bars rows={Object.entries(reasons).sort((a, b) => b[1] - a[1])} tone="var(--bad)" /></> : null}
          {ads.networks && Object.keys(ads.networks).length ? (
            <><h4>Who paid</h4><table className="ps-table"><thead><tr><th>Network</th><th>Ads</th><th>Earned</th></tr></thead><tbody>{Object.entries(ads.networks).slice(0, 5).map(([name, item]) => <tr key={name}><td>{name}</td><td>{number(item.shown)}</td><td>{usd(item.revenue)}</td></tr>)}</tbody></table></>
          ) : null}
          {ads.failures?.length ? (
            <>
              <h4>Failed ads <small>{(ads.failures_total ?? 0) > ads.failures.length ? `newest ${ads.failures.length} of ${number(ads.failures_total ?? 0)}` : 'newest first'}</small></h4>
              <ul className="ps-fails">{ads.failures.map((item, index) => <li key={`${item.at}-${index}`}><time dateTime={item.at}>{whenText(item.at)}</time><span>{adName(item.format)} {item.kind === 'load' ? 'didn’t load' : 'not shown'}{item.level != null ? ` · level ${item.level}` : ''}{item.placement ? ` · ${plain(String(item.placement))}` : ''}</span><b title={item.reason}>{item.reason}</b></li>)}</ul>
            </>
          ) : null}
        </>
      ) : <p className="ps-empty">No ads shown to this player.</p>}
    </section>
  );
}

function LevelsCard({ data }: { data: PlayerSummaryData }): ReactElement {
  const { levels } = data;
  return (
    <section className="ps-card">
      <h3>Levels <small>{plural(levels.clears, 'clear')} · {plural(levels.fails, 'fail')}</small></h3>
      {levels.highest == null ? <p className="ps-empty">No level events from this player.</p> : (
        <>
          <Stats items={[
            ['First-try clears', firstTryShare(levels.first_try_clears, levels.cleared)], ['Average moves', dash(levels.average_moves)],
            ['Fastest', seconds(levels.fastest_seconds)], ['Slowest', seconds(levels.slowest_seconds)],
            ['Restarts', number(levels.restarts)], ['Revives', number(levels.revives)], ['Quit mid-level', number(levels.left)],
          ]} />
          <h4>Pace</h4>
          <Pace pace={levels.pace} />
          {levels.hardest.length ? (
            <>
              <h4>Hardest levels for this player</h4>
              <ul className="ps-hard">{levels.hardest.map((entry) => <li key={entry.level}><span>Level {entry.level}</span><span>{entry.bad_attempts} bad attempt{entry.bad_attempts === 1 ? '' : 's'} · {entry.cleared ? 'cleared' : 'not cleared'}</span></li>)}</ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}

function WalletCard({ data }: { data: PlayerSummaryData }): ReactElement {
  const { economy, powerups } = data;
  const currencies = Object.entries(economy.balances);
  const owned = Object.entries(economy.inventory);
  const names = [...new Set([...owned.map(([name]) => name), ...Object.keys(powerups.used), ...powerups.obtained.map((entry) => entry.powerup)])];
  const got = (name: string, source: string): number => powerups.obtained.filter((entry) => entry.powerup === name && entry.source === source).reduce((sum, entry) => sum + entry.count, 0);
  const earned = Object.entries(economy.earned).slice(0, 4); const spent = Object.entries(economy.spent).slice(0, 4);
  const history = economy.balance_history.map(([time, value]) => [Date.parse(time), value] as [number, number]);
  const flags: Array<[string, string]> = [['has_purchased', 'Has purchased'], ['sub_active', 'Subscription'], ['ads_removed', 'Ads removed']];
  const empty = !currencies.length && !owned.length && !earned.length && !spent.length && !names.length;
  return (
    <section className="ps-card">
      <h3>Wallet and powerups <small>powerups owned come from the game's own snapshot</small></h3>
      {empty ? <p className="ps-empty">No economy or powerup events from this player.</p> : (
        <>
          {currencies.map(([name, value]) => <p className="ps-big" key={name}>{number(value)}<small>{plain(name)}</small></p>)}
          <Spark points={history} />
          {owned.length ? <><h4>Powerups owned</h4><div className="ps-pills">{owned.map(([name, value]) => <span key={name} className={value ? 'ps-pill' : 'ps-pill off'}>{plain(name)}<b>{number(value)}</b></span>)}</div></> : null}
          {names.length ? (
            <>
              <h4>Used and gained</h4>
              <table className="ps-table"><thead><tr><th>Powerup</th><th>Used</th><th>Bought</th><th>From ads</th></tr></thead><tbody>
                {names.map((name) => <tr key={name}><td>{plain(name)}</td><td>{number(powerups.used[name] ?? 0)}</td><td>{number(got(name, 'Coins'))}</td><td>{number(got(name, 'RewardedAd'))}</td></tr>)}
              </tbody></table>
            </>
          ) : null}
          {earned.length ? <><h4>Earned</h4><Bars rows={earned} tone="var(--ok)" /></> : null}
          {spent.length ? <><h4>Spent on</h4><Bars rows={spent} tone="var(--info)" /></> : null}
          <h4>Purchases</h4>
          <div className="ps-pills">
            {flags.filter(([key]) => key in economy.flags).map(([key, label]) => <span className="ps-pill" key={key}>{label}<b>{economy.flags[key] ? 'Yes' : 'No'}</b></span>)}
            <span className="ps-pill">Shop taps<b>{number(data.shop_taps)}</b></span>
          </div>
        </>
      )}
    </section>
  );
}

function HabitsCard({ data }: { data: PlayerSummaryData }): ReactElement {
  const { sessions } = data;
  const days = sessions.per_day; const most = Math.max(1, ...days.map(([, count]) => count));
  const background = Object.entries(data.background).sort((a, b) => b[1] - a[1]);
  const screens = Object.entries(data.screens).slice(0, 5);
  return (
    <section className="ps-card">
      <h3>Sessions and habits</h3>
      {days.length ? (
        <>
          <h4>Sessions per day <small>last {days.length} active day{days.length === 1 ? '' : 's'}</small></h4>
          <svg viewBox="0 0 300 40" className="ps-days" preserveAspectRatio="none" role="img" aria-label="Sessions per active day">
            {days.map(([day, count], index) => { const width = Math.min(292 / days.length, 22); const height = Math.max(2, (count / most) * 34); return <rect key={day} x={4 + index * width} y={38 - height} width={Math.max(1, width - 2)} height={height} rx="1"><title>{`${day}: ${count}`}</title></rect>; })}
          </svg>
        </>
      ) : null}
      {background.length ? <><h4>Why the app went to the background</h4><Bars rows={background} /></> : null}
      {data.levels_ended_by_kill ? <p className="ps-note">{number(data.levels_ended_by_kill)} level{data.levels_ended_by_kill === 1 ? '' : 's'} ended by the app being killed.</p> : null}
      {screens.length ? <><h4>Screens opened</h4><Bars rows={screens} /></> : null}
      {data.tutorials.shown ? <p className="ps-note">Tutorials: {number(data.tutorials.completed)} of {number(data.tutorials.shown)} finished.</p> : null}
    </section>
  );
}

/** The summary itself; the fetching is in `PlayerSummary`. */
export function PlayerSummaryView({ data }: { data: PlayerSummaryData }): ReactElement {
  const { levels, ads, economy, sessions } = data;
  const coins = Object.values(economy.balances)[0];
  const tiles: Array<[string, string, string]> = [
    ['Levels cleared', number(levels.cleared), levels.highest != null ? `highest ${number(levels.highest)}` : ''],
    ['Average clear time', seconds(levels.average_seconds), levels.median_seconds != null ? `median ${duration(levels.median_seconds)}` : ''],
    ['Ads seen', number(ads.shown), levelsPerAd(levels.cleared, ads.shown) ?? ''],
    ['Coins', dash(coins), economy.save_level != null ? `save at level ${number(economy.save_level)}` : 'latest snapshot'],
    ['Sessions', number(sessions.count), sessions.active_days ? `${(sessions.count / sessions.active_days).toFixed(1)} per active day` : ''],
    ['Active days', number(sessions.active_days), data.first_seen && data.last_seen ? `${dayText(data.first_seen)} to ${dayText(data.last_seen)}` : ''],
  ];
  return (
    <div className="ps">
      {data.partial ? <p className="ps-warn" role="status">This player has more events than one summary reads; the numbers cover the latest {number(data.events_counted)}.</p> : null}
      <p className="ps-scope">All time<small> · not limited to the days chosen above</small></p>
      <div className="ps-tiles">{tiles.map(([label, value, note]) => <div className="ps-tile" key={label}><span>{label}</span><b>{value}</b>{note ? <small>{note}</small> : null}</div>)}</div>
      <div className="ps-grid">
        <div className="ps-col"><ValueCard data={data} /><LevelsCard data={data} /><HabitsCard data={data} /></div>
        <div className="ps-col"><AdsCard data={data} /><WalletCard data={data} /></div>
      </div>
    </div>
  );
}

export function PlayerSummary({ game, player }: { game: Game; player: string }): ReactElement {
  const path = `${gameURL(game)}/insights/player-summary?${new URLSearchParams({ player })}`;
  const query = useRead<PlayerSummaryData>(path);
  return <QueryRegion query={query} path={path} skeleton={<Skeleton kind="stats" />}>{(data) => <PlayerSummaryView data={data} />}</QueryRegion>;
}
