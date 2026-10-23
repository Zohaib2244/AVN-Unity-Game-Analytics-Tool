// Export data: the dashboard filter bar, a live count of the matching events, and the ZIP download
// (fetched directly: it is binary, the one place pages don't go through `write`).
import { useState, type ReactElement } from 'react';
import { useRead } from '@/api';
import { errorMessage } from '@/api/client';
import { gameURL } from '@/lib/games';
import { filterQuery, type ActiveFilters } from '@/lib/filters';
import { number } from '@/lib/format';
import type { Game, Health } from '@/lib/types';
import { Heading, useNotify } from '@/components/feedback';
import { Field, FormError, useSubmit } from '@/components/forms';
import { FilterBar, useFilters } from '@/components/Filters';
import { healthPath } from '@/components/Activity';
import { Ico } from '@/components/icons';

/** The filters as export query parameters: everything but the days, which go as period/date/end_date. */
export const exportFilterParams = (state: ActiveFilters): URLSearchParams => { const query = filterQuery(state); query.delete('start'); query.delete('end'); return query; };

export function ExportsPage({ game }: { game: Game }): ReactElement {
  const [state, update] = useFilters(game);
  const [basis, setBasis] = useState('server_ts');
  const { toast } = useNotify();
  const countQuery = useRead<Health>(healthPath(game, state.range, basis, exportFilterParams(state).toString()));
  const { onSubmit, busy, error } = useSubmit(async (values) => {
    const query = exportFilterParams(state);
    query.set('period', 'custom'); query.set('date', state.range.from); query.set('end_date', state.range.to); query.set('basis', values.basis || basis);
    const response = await fetch(`${gameURL(game)}/export?${query}`, { credentials: 'same-origin' });
    if (!response.ok) { const detail = (await response.json().catch(() => ({}))) as { detail?: unknown }; throw new Error(typeof detail.detail === 'string' ? detail.detail : 'Export failed. Please try again.'); }
    const download = URL.createObjectURL(await response.blob());
    const anchor = Object.assign(document.createElement('a'), { href: download, download: `${game.bundle_id}-${state.range.from}_to_${state.range.to}.zip` });
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(download), 60000);
    toast('Your export is ready. Download started.');
  });
  const count = countQuery.isError && countQuery.data === undefined ? errorMessage(countQuery.error) : countQuery.data ? `${number(countQuery.data.total)} event${countQuery.data.total === 1 ? '' : 's'} will be exported` : null;
  return (
    <>
      <Heading title="Export data" subtitle="Download the raw events as a portable package for your own analysis." />
      <FilterBar game={game} state={state} onChange={update} />
      <div className="form-layout">
        <form id="export-form" className="panel form-panel" onSubmit={onSubmit}>
          <h2>Create an export</h2><p>Uses the days and filters above, up to 366 days. We’ll package the matching events and their definitions.</p>
          <p id="export-count" className="export-count" aria-live="polite">{count ?? <span className="skeleton-line" role="status" aria-label="Counting events" />}</p>
          <Field label="Select events by" htmlFor="basis" help="All dates use UTC and both the first and last day are included. Game time can be affected by device clock settings.">
            <select id="basis" name="basis" value={basis} onChange={(event) => setBasis(event.target.value)}><option value="server_ts">Arrival time — when the server received them</option><option value="client_ts">Game time — when the client says they happened</option></select>
          </Field>
          {error ? <FormError error={error} /> : null}
          <div className="form-actions"><button className="button primary" type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Preparing…' : <><Ico name="export" size={15} /> Download export</>}</button></div>
        </form>
        <aside className="aside-card"><Ico name="file" size={25} /><h3>What’s in the ZIP</h3>
          <div className="file-preview">
            <div><Ico name="file" size={17} /><span>events.parquet<small>Typed columns, best for analysis tools</small></span></div>
            <div><Ico name="file" size={17} /><span>events.jsonl.gz<small>The same events as JSON lines</small></span></div>
            <div><Ico name="book" size={17} /><span>events.md<small>Event names and what they mean</small></span></div>
            <div><Ico name="settings" size={17} /><span>manifest.json<small>Time range, filters and export details</small></span></div>
            <div><Ico name="pulse" size={17} /><span>ANALYSIS.md<small>Guide for AI assistants (Claude, Codex…)</small></span></div>
          </div>
          <p className="small">Large exports are capped at 256 MiB before compression. Try a shorter range if you hit the limit.</p>
        </aside>
      </div>
    </>
  );
}
