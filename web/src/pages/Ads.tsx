// Ads: what ads earn, whether they show, and which ones players leave on (ads.py on the server).
// Summary first: four key numbers, then the shared ad widgets (states per format, revenue, failures; the
// same ones a player's summary uses), then rewarded placements and the creatives players leave on.
// Every panel loads on its own, so one slow or failed read never blanks the rest.
import { Share } from '@/components/Share';
import type { ReactElement } from 'react';
import { useRead } from '@/api';
import { number } from '@/lib/format';
import { filterQuery } from '@/lib/filters';
import { gameURL } from '@/lib/games';
import type { AdCreatives, AdPlacements, AdRevenue, AdStates, Game } from '@/lib/types';
import { AdWidgets, adPath, type AdScope } from '@/components/AdWidgets';
import { FilterBar, useFilters } from '@/components/Filters';
import { Heading, Metric, QueryRegion, Skeleton } from '@/components/feedback';
import { InstallSourcePicker, installParams, useInstallSource } from '@/components/InstallSource';
import { DoraScene } from '@/components/flavour';
import { money, share, words } from './ads/model';

export function AdsPage({ game }: { game: Game }): ReactElement {
  const [filters, setFilters] = useFilters(game);
  const [install, setInstall] = useInstallSource(game);
  const query = filterQuery(filters);
  for (const [key, value] of installParams(install)) query.append(key, value);
  const scope: AdScope = { game, query };
  const base = `${gameURL(game)}/insights/ads`;
  const totalsPath = `${base}/revenue?${query}&group_by=network`;
  const placementsPath = `${base}/placements?${query}`;
  const creativesPath = `${base}/creatives?${query}`;
  const networks = useRead<AdRevenue>(totalsPath);
  const states = useRead<AdStates>(adPath(scope, 'states'));
  const placements = useRead<AdPlacements>(placementsPath);
  const creatives = useRead<AdCreatives>(creativesPath);

  return (
    <>
      <Heading title="Ads" subtitle="What ads earn, whether they show, and which ones players leave on." />
      <FilterBar game={game} state={filters} onChange={setFilters}>
        <InstallSourcePicker game={game} filters={filters} value={install} onChange={setInstall} />
      </FilterBar>
      <QueryRegion query={networks} path={totalsPath} skeleton={<Skeleton kind="stats" />}>
        {(totals) => (totals.available ? <KeyNumbers totals={totals} states={states.data} /> : <div className="empty-scene"><DoraScene /><p>{totals.note ?? 'No ad events in these days.'}</p></div>)}
      </QueryRegion>
      {networks.data?.available === false ? null : (
        <>
          <AdWidgets scope={scope} />
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

function KeyNumbers({ totals, states }: { totals: AdRevenue; states: AdStates | undefined }): ReactElement {
  const total = states?.available ? states.total : null;
  const players = totals.active_players;
  return (
    <div className="kpis">
      <Metric label="Ad revenue" value={money(totals.total_revenue)} note={total ? `${number(total.players)} players saw ads` : ''} />
      <Metric label="Revenue per player" value={money(totals.revenue_per_active_player)} note={`of ${number(players)} active players`} />
      <Metric label="Ads per player" value={total && players ? (total.shown / players).toFixed(1) : '—'} note={total ? `${number(total.shown)} shown ÷ ${number(players)} players` : ''} />
      <Metric label="Shown of asked" value={total?.asked ? <Share part={total.shown} whole={total.asked} unit="ads" /> : '—'} note={total?.asked ? `of ${number(total.asked)} times the game asked` : 'the game sends no ad requests'} />
    </div>
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
