// Ads: what ads earn, whether they show, and which ones players leave on (ads.py on the server).
// Summary first: four key numbers, then revenue (split twice) beside "Needs a look", then delivery
// from wanted to shown, rewarded placements and the creatives players leave on. Every panel loads on
// its own, so one slow or failed read never blanks the rest.
import { Share } from '@/components/Share';
import type { ReactElement } from 'react';
import { Segmented, Tag } from '@avn/ui';
import { useRead } from '@/api';
import { number } from '@/lib/format';
import { filterQuery } from '@/lib/filters';
import { gameURL } from '@/lib/games';
import { useStored } from '@/lib/store';
import type { AdCreatives, AdDelivery, AdPlacements, AdRevenue, Game } from '@/lib/types';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading, Metric, QueryRegion, Skeleton } from '@/components/feedback';
import { InstallSourcePicker, installParams, useInstallSource } from '@/components/InstallSource';
import { Ico } from '@/components/icons';
import { DoraScene } from '@/components/flavour';
import { GROUPS, THEN_BY, deliveryRows, looks, money, revenueSentence, share, words, type AdGroup } from './ads/model';

type View = { group: AdGroup; then: '' | AdGroup };

export function AdsPage({ game }: { game: Game }): ReactElement {
  const [filters, setFilters] = useFilters(game);
  const [install, setInstall] = useInstallSource(game);
  const [view, setView] = useStored<View>(`avn-ads-view-${game.id}`, { group: 'format', then: '' });
  const query = filterQuery(filters);
  for (const [key, value] of installParams(install)) query.append(key, value);
  const base = `${gameURL(game)}/insights/ads`;
  const revenuePath = `${base}/revenue?${query}&group_by=${view.group}${view.then && view.then !== view.group ? `&then_by=${view.then}` : ''}`;
  const totalsPath = `${base}/revenue?${query}&group_by=network`;
  const deliveryPath = `${base}/delivery?${query}`;
  const placementsPath = `${base}/placements?${query}`;
  const creativesPath = `${base}/creatives?${query}`;
  const revenue = useRead<AdRevenue>(revenuePath);
  const networks = useRead<AdRevenue>(totalsPath);
  const delivery = useRead<AdDelivery>(deliveryPath);
  const placements = useRead<AdPlacements>(placementsPath);
  const creatives = useRead<AdCreatives>(creativesPath);
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });

  return (
    <>
      <Heading title="Ads" subtitle="What ads earn, whether they show, and which ones players leave on." />
      <FilterBar game={game} state={filters} onChange={setFilters}>
        <InstallSourcePicker game={game} filters={filters} value={install} onChange={setInstall} />
      </FilterBar>
      <QueryRegion query={networks} path={totalsPath} skeleton={<Skeleton kind="stats" />}>
        {(totals) => (totals.available ? <KeyNumbers totals={totals} placements={placements.data} /> : <div className="empty-scene"><DoraScene /><p>{totals.note ?? 'No ad events in these days.'}</p></div>)}
      </QueryRegion>
      {networks.data?.available === false ? null : (
        <>
          <div className="split ads-split">
            <section className="panel" id="ads-revenue">
              <div className="panel-header ads-revenue-head">
                <div><h2>Revenue</h2>{revenue.data?.available ? <p>{revenueSentence(revenue.data)}</p> : null}</div>
                <div className="quiet-actions">
                  <Segmented<AdGroup> label="Split revenue by" value={view.group} onChange={(group) => setView({ ...view, group, then: view.then === group ? '' : view.then })} options={GROUPS.map((item) => ({ ...item }))} />
                  <label className="inline-field then-by"><span>then by</span><select aria-label="Then split by" value={view.then} onChange={(event) => setView({ ...view, then: event.target.value as View['then'] })}>{THEN_BY.filter((item) => item.value !== view.group).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
                </div>
              </div>
              <QueryRegion query={revenue} path={revenuePath} skeleton={<Skeleton rows={5} columns={7} />}>
                {(data) => <RevenueTable data={data} />}
              </QueryRegion>
            </section>
            <section className="panel">
              <div className="panel-header"><h2>Needs a look</h2></div>
              {delivery.data && networks.data ? <Looks items={looks(delivery.data, networks.data, revenue.data, creatives.data)} onOpen={jump} /> : <Skeleton rows={3} columns={2} />}
            </section>
          </div>
          <section className="panel section-spacing" id="ads-delivery">
            <div className="panel-header"><div><h2 title="Where each format loses ads on the way to the screen.">From wanted to shown</h2></div></div>
            <QueryRegion query={delivery} path={deliveryPath} skeleton={<Skeleton rows={4} columns={8} />}>
              {(data) => <Delivery data={data} />}
            </QueryRegion>
          </section>
          <div className="settings-cols ads-pair section-spacing">
            <section className="panel">
              <div className="panel-header"><div><h2 title="Which offers players take, and what each earns.">Rewarded placements</h2></div></div>
              <QueryRegion query={placements} path={placementsPath} skeleton={<Skeleton rows={4} columns={4} />}>
                {(data) => <Rewarded data={data} />}
              </QueryRegion>
            </section>
            <section className="panel" id="ads-creatives">
              <div className="panel-header"><div><h2 title="Creatives after which the player played no more levels that session.">Ads players leave on</h2></div></div>
              <QueryRegion query={creatives} path={creativesPath} skeleton={<Skeleton rows={4} columns={5} />}>
                {(data) => <Creatives data={data} />}
              </QueryRegion>
            </section>
          </div>
        </>
      )}
    </>
  );
}

function KeyNumbers({ totals, placements }: { totals: AdRevenue; placements: AdPlacements | undefined }): ReactElement {
  const pacing = placements?.serving.pacing;
  const served = placements?.serving.groups ?? [];
  const wanted = served.reduce((sum, row) => sum + row.wanted, 0);
  const shown = served.reduce((sum, row) => sum + row.shown, 0);
  const notReady = served.reduce((sum, row) => sum + (row.failed_by.NotReady ?? 0), 0);
  return (
    <div className="kpis">
      <Metric label="Ad revenue" value={money(totals.total_revenue)} note={`${money(totals.revenue_per_active_player)} per player`} />
      <Metric label="Per player per day" value={money(totals.arpdau)} note={`${number(totals.active_players)} active players`} />
      <Metric label="Ads per session" value={pacing?.ads_shown_per_session != null ? pacing.ads_shown_per_session.toFixed(1) : '—'} note={pacing?.median_seconds_between_interstitials != null ? `${Math.round(pacing.median_seconds_between_interstitials)} s between interstitials` : 'interstitial gap not known'} />
      <Metric label="Shown of wanted" value={wanted ? <Share part={shown} whole={wanted} unit="ads" /> : '—'} note={wanted ? `${number(notReady)} lost: no ad ready` : 'the game sends no ad requests'} />
    </div>
  );
}

function Looks({ items, onOpen }: { items: ReturnType<typeof looks>; onOpen: (id: string) => void }): ReactElement {
  if (!items.length) return <div className="empty-scene"><DoraScene /><p>Nothing needs a look: ads load, show and report revenue as usual.</p></div>;
  return (
    <>
      {items.slice(0, 5).map((item) => (
        <div key={`${item.tag}-${item.title}`} className="look">
          <Tag kind={item.kind}>{item.tag}</Tag>
          <div><b>{item.title}</b><span className="s">{item.note}</span></div>
          <button type="button" className="btn sm ghost" aria-label={`Go to the table for: ${item.title}`} title="Go to the table" onClick={() => onOpen(`ads-${item.target}`)}><Ico name="arrow" size={14} /></button>
        </div>
      ))}
    </>
  );
}

function ShareBar({ value }: { value: number | null }): ReactElement {
  return <span className="share-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(value ? 2 : 0, (value ?? 0) * 100))}%` }} /></span>;
}

function RevenueTable({ data }: { data: AdRevenue }): ReactElement {
  if (!data.available) return <p className="help panel-body">{data.note}</p>;
  const thens = (data.then_values ?? []).slice(0, 4);
  const label = GROUPS.find((item) => item.value === data.group_by)?.label ?? 'Group';
  const banner = data.group_by === 'format' && data.banner.revenue ? data.banner : null;
  return (
    <>
      <div className="table-wrap">
        <table className="compact-table ads-table">
          <thead>
            <tr><th>{label}</th><th className="num">Shown</th><th className="num">Revenue</th><th>Share</th><th className="num" title="Revenue per 1,000 shown">eCPM</th><th className="num">Players</th><th className="num" title="Revenue per player who saw one">Per player</th>{thens.map((value) => <th key={value} className="num" title={`eCPM of ${words(value)} within each row`}>eCPM · {words(value)}</th>)}</tr>
          </thead>
          <tbody>
            {data.groups.map((row) => (
              <tr key={String(row.value)}>
                <td>{data.group_by === 'day' || data.group_by === 'ad_unit' ? <span className="mono">{row.value ?? '—'}</span> : words(row.value)}</td>
                <td className="num">{number(row.impressions)}</td>
                <td className="num">{money(row.revenue)}</td>
                <td><ShareBar value={row.share_of_full_screen_revenue} /></td>
                <td className="num">{money(row.ecpm)}</td>
                <td className="num">{number(row.players)}</td>
                <td className="num">{row.players ? money(row.revenue / row.players) : '—'}</td>
                {thens.map((value) => <td key={value} className="num">{row.split?.[value] ? money(row.split[value]!.ecpm) : <span className="muted">—</span>}</td>)}
              </tr>
            ))}
            {banner ? <tr><td>Banner</td><td className="num">{number(banner.impressions)}</td><td className="num">{money(banner.revenue)}</td><td><ShareBar value={null} /></td><td className="num">{money(banner.ecpm)}</td><td className="num muted">—</td><td className="num muted">—</td>{thens.map((value) => <td key={value} className="num muted">—</td>)}</tr> : null}
          </tbody>
        </table>
      </div>
      <p className="foot-note">{data.share_of_shows_with_revenue != null && data.share_of_shows_with_revenue < 0.98 ? `${share(1 - data.share_of_shows_with_revenue)} of shown ads never reported revenue, so totals run that much low. ` : ''}Share is of full-screen revenue; banners are counted apart, from the level results.</p>
    </>
  );
}

function Delivery({ data }: { data: AdDelivery }): ReactElement {
  if (!data.available) return <p className="help panel-body">This game sends no ad requests or ad health snapshots in these days.</p>;
  const rows = deliveryRows(data);
  const errors = [...data.load_failures.map((item) => ({ format: item.format, error: item.error, count: item.loads, players: 0 })), ...(data.health.last_load_errors ?? []).map((item) => ({ format: item.format, error: item.error, count: item.snapshots, players: item.players }))].slice(0, 5);
  return (
    <>
      <div className="table-wrap">
        <table className="compact-table ads-table">
          <thead><tr><th>Format</th><th className="num" title="Loads that worked, of loads that finished">Loads that worked</th><th className="num" title="Median time from asking the network to an ad ready">Load time</th><th className="num" title="Times the game tried to show one">Wanted</th><th className="num" title="Held back by the game's own rules: cooldown, level gate">Held by your rules</th><th className="num">No ad ready</th><th className="num">Shown</th><th>Shown of wanted</th></tr></thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.format}>
                <td>{words(row.format)}</td>
                <td className={`num${row.loadsWorked != null && row.loadsWorked < 0.6 ? ' hot' : ''}`}>{row.loadsWorked != null && row.loadsOk != null ? <Share part={row.loadsOk} whole={row.loadsTried} percent={row.loadsWorked * 100} unit="ads" /> : share(row.loadsWorked)}</td>
                <td className="num">{row.loadMedianMs ? `${(row.loadMedianMs / 1000).toFixed(1)} s` : <span className="muted" title="This build's ad plugin doesn't report load times">—</span>}</td>
                <td className="num">{row.wanted != null ? number(row.wanted) : <span className="muted">—</span>}</td>
                <td className="num">{row.heldByRules != null ? number(row.heldByRules) : <span className="muted">—</span>}</td>
                <td className={`num${row.noAdReady && row.wanted && row.noAdReady / row.wanted >= 0.1 ? ' hot' : ''}`}>{row.noAdReady != null ? number(row.noAdReady) : <span className="muted">—</span>}</td>
                <td className="num">{row.shown != null ? number(row.shown) : <span className="muted">—</span>}</td>
                <td>{row.shownOfWanted != null ? <span className="bar-cell"><ShareBar value={row.shownOfWanted} /><span className="num">{share(row.shownOfWanted)}</span></span> : <span className="muted">{row.format === 'Banner' ? 'always on' : '—'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errors.length ? (
        <div className="panel-body ads-errors">
          <span className="eyebrow">Most common load errors</span>
          <ul>{errors.map((item) => <li key={`${item.format}-${item.error}`}><span>{words(item.format)}</span><code>{item.error}</code><span className="num muted">{number(item.count)}{item.players ? ` · ${number(item.players)} players` : ''}</span></li>)}</ul>
        </div>
      ) : null}
      {data.load_times_sent ? null : <p className="foot-note">Load times appear once a build with the newer ad plugin (Loaded events with LOAD_MS) is out.</p>}
    </>
  );
}

function Rewarded({ data }: { data: AdPlacements }): ReactElement {
  const money_by = new Map((data.revenue.groups ?? []).map((row) => [row.value ?? '', row]));
  const rows = (data.serving.groups ?? []).filter((row) => row.reward_given_share != null);
  if (!rows.length) return <p className="help panel-body">No rewarded ad was shown in these days, or the game doesn't say when one gives its reward.</p>;
  return (
    <div className="table-wrap">
      <table className="compact-table ads-table">
        <thead><tr><th>Placement</th><th className="num">Wanted</th><th className="num">Shown</th><th className="num" title="Of the ads closed, the share that gave the reward">Reward given</th><th className="num">Revenue</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.value)}><td>{words(row.value)}</td><td className="num">{number(row.wanted)}</td><td className="num">{number(row.shown)}</td><td className="num">{row.reward_given_share != null ? <Share part={Math.round(row.shown * row.reward_given_share)} whole={row.shown} percent={row.reward_given_share * 100} unit="ads" /> : '—'}</td><td className="num">{money(money_by.get(row.value ?? '')?.revenue ?? null)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Creatives({ data }: { data: AdCreatives }): ReactElement {
  if (!data.available) return <p className="help panel-body">{data.note}</p>;
  const usual = data.usual_share ?? 0;
  const rows = (data.rows ?? []).slice(0, 10);
  return (
    <>
      {rows.length ? (
        <div className="table-wrap">
          <table className="compact-table ads-table">
            <thead><tr><th>Creative</th><th>Network</th><th className="num">Shown</th><th className="num" title="Shows after which the player played no more levels that session">Left after it</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.creative}><td className="mono">{row.creative}</td><td>{row.network ?? '—'}</td><td className="num">{number(row.shown)}</td><td className={`num${row.left_share != null && row.left_share - usual >= 0.15 ? ' hot' : ''}`}>{row.left_share != null ? <Share part={row.left_after} whole={row.shown} percent={row.left_share * 100} unit="ads" /> : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="help panel-body">No creative was shown {data.minimum_shows} times or more yet, so none can be judged.</p>}
      <p className="foot-note">Usually {share(usual)} of shows end the session · {number(data.creatives_judged ?? 0)} of {number(data.creatives ?? 0)} creatives shown {data.minimum_shows}+ times are judged · players whose last events never arrived count as having left, so compare with the usual share.</p>
    </>
  );
}
