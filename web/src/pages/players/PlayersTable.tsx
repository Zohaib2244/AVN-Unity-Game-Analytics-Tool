// The player list: a TanStack table with a sticky header, sortable columns (the server sorts; the page
// shown is ordered by the same comparator so the header and the rows always agree), one row per player
// that opens in the drawer on click or Enter.
import { useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type RowData } from '@tanstack/react-table';
import { TEST_ENVIRONMENTS } from '@/lib/filters';
import { analysisDate, countryName, duration, number, platformLabel, type Timezone } from '@/lib/format';
import { CopyButton } from '@/components/CopyButton';
import { gamePath } from '@/lib/games';
import type { Game, PlayerMetric, PlayerRow } from '@/lib/types';
import { metricLabel, metricValue, playerComparator } from './rules';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> { className?: string; sortable?: boolean }
}

const column = createColumnHelper<PlayerRow>();
/** The first characters are what you recognise a player by; the whole ID is one click away (copy) or in the tooltip. */
const startOfId = (id: string): string => (id.length > 10 ? `${id.slice(0, 8)}…` : id);
/** "3 Nov, 5:14 pm" in the reader's own format: the year is in the tooltip, as these are recent. */
const recent = (value: string, timezone: Timezone): string => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timezone === 'utc' ? { timeZone: 'UTC' } : {}) });
const plainClick = (event: MouseEvent): boolean => event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

export function PlayersTable({ game, rows, metrics, sort, order, timezone, shown, onSort, onOpen }: {
  game: Game; rows: PlayerRow[]; metrics: PlayerMetric[]; sort: string; order: 'asc' | 'desc'; timezone: Timezone; shown: ReadonlySet<string>;
  onSort: (key: string) => void; onOpen: (player: string, index: number) => void;
}): ReactElement {
  const data = useMemo(() => [...rows].sort(playerComparator(sort, order)), [rows, sort, order]);
  // The page passes a new onOpen on every render. Columns built from it would be new every render too, and the
  // table would remount all its rows (a flicker) each time the drawer opens or closes; so read it through a ref.
  const open = useRef(onOpen);
  open.current = onOpen;
  const varies = useMemo(() => ({ id: new Set(rows.map((row) => !!row.has_user_id)).size > 1, platform: new Set(rows.map((row) => row.platform || '')).size > 1, version: new Set(rows.map((row) => row.app_version || '')).size > 1 }), [rows]);
  const shows = useMemo(() => ({ campaign: rows.some((row) => row.value?.campaign), earned: rows.some((row) => (row.value?.earned ?? 0) > 0), paidBack: rows.some((row) => row.value?.paid_back != null) }), [rows]);
  const columns = useMemo(() => [
    column.accessor('player', { id: 'player', header: () => <span title="A player is their user_id when the game sends one, otherwise the device’s install ID">Player</span>, meta: { sortable: true }, cell: ({ row }) => (
      <>
        <span className="player-id">
          <Link to={gamePath(game, 'players')} search={{ player: row.original.player }} className="row-title" title={row.original.player} onClick={(event: MouseEvent) => { if (plainClick(event)) open.current(row.original.player, row.index); }}><span className="mono">{startOfId(row.original.player)}</span></Link>
          <CopyButton text={row.original.player} label="Copy player ID" done="Player ID copied." />
        </span>
        {(() => {
          // Only what differs between the rows shown is worth a second line; the same words on every row are noise.
          const parts = [varies.id ? (row.original.has_user_id ? 'User ID' : 'Install ID') : '', varies.platform ? platformLabel(row.original.platform || '—') : '', varies.version ? row.original.app_version || '' : ''].filter(Boolean);
          const test = TEST_ENVIRONMENTS.includes(row.original.environment || '');
          return parts.length || test ? <p className="small muted">{parts.join(' · ')}{test ? <span className="pill"> {row.original.environment}</span> : null}</p> : null;
        })()}
      </>
    ) }),
    ...(shows.campaign ? [column.display({ id: 'campaign', header: 'Campaign', meta: { className: 'small', sortable: true }, cell: ({ row }) => row.original.value?.campaign ?? <span className="muted">—</span> })] : []),
    column.display({ id: 'level', header: () => <span title="The highest level they reached">Level</span>, meta: { className: 'num', sortable: true }, cell: ({ row }) => (row.original.highest_level != null ? number(row.original.highest_level) : '—') }),
    ...(shows.earned ? [column.display({ id: 'earned', header: () => <span title="Ad revenue from this player so far, banners included">Earned</span>, meta: { className: 'num', sortable: true }, cell: ({ row }) => (row.original.value ? `$${row.original.value.earned.toFixed(3)}` : '—') })] : []),
    ...(shows.paidBack ? [column.display({ id: 'paid_back', header: () => <span title="Earned ÷ what their campaign paid per install on their install day">Paid back</span>, meta: { className: 'num', sortable: true }, cell: ({ row }) => { const share = row.original.value?.paid_back; return share == null ? <span className="muted">—</span> : <span className={share >= 1 ? 'good-text' : undefined}>{Math.round(share * 100)}%</span>; } })] : []),
    column.accessor('total_play_seconds', { id: 'playtime', header: 'Playtime', meta: { className: 'num', sortable: true }, cell: ({ getValue }) => duration(getValue()) }),
    column.accessor('sessions', { id: 'sessions', header: 'Sessions', meta: { className: 'num', sortable: true }, cell: ({ getValue }) => number(getValue()) }),
    column.accessor('events', { id: 'events', header: 'Events', meta: { className: 'num', sortable: true }, cell: ({ getValue }) => number(getValue()) }),
    column.accessor('last_seen', { id: 'last_seen', header: 'Last active', meta: { className: 'small muted after-num', sortable: true }, cell: ({ getValue }) => <span title={analysisDate(getValue(), timezone)}>{recent(getValue(), timezone)}</span> }),
    column.accessor('first_seen', { id: 'first_seen', header: 'First seen', meta: { className: 'small muted after-num', sortable: true }, cell: ({ getValue }) => <span title={analysisDate(getValue(), timezone)}>{recent(getValue(), timezone)}</span> }),
    column.accessor('app_version', { id: 'version', header: 'App version', meta: { className: 'small', sortable: true }, cell: ({ getValue }) => getValue() || '—' }),
    column.accessor('avg_session_seconds', { id: 'session_length', header: 'Avg session', meta: { className: 'num', sortable: true }, cell: ({ getValue }) => (getValue() != null ? duration(getValue()) : '—') }),
    ...metrics.map((metric, position) => column.display({ id: `metric${position}`, header: metricLabel(metric), meta: { className: 'num custom-col', sortable: true }, cell: ({ row }) => metricValue(metric, row.original.metrics[position], timezone) })),
    column.accessor('country', { id: 'country', header: 'Country', meta: { className: 'small', sortable: true }, cell: ({ getValue }) => (getValue() ? <abbr className="cc" title={countryName(getValue())}>{getValue()}</abbr> : '—') }),
  ].filter((item) => item.id === 'player' || String(item.id).startsWith('metric') || shown.has(String(item.id))), [game, metrics, timezone, varies, shows, shown]);
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel(), manualSorting: true, state: { sorting: [{ id: sort, desc: order === 'desc' }] } });
  const onRowKey = (event: KeyboardEvent<HTMLTableRowElement>, player: string, index: number) => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); onOpen(player, index); } };
  return (
    <div className="table-wrap players-table">
      <table>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const meta = header.column.columnDef.meta || {};
                const sorted = header.column.getIsSorted();
                const headClass = (meta.className || '').split(' ').filter((name) => name === 'num' || name === 'custom-col' || name === 'after-num').join(' ');
                if (!meta.sortable) return <th key={header.id} className={headClass}>{flexRender(header.column.columnDef.header, header.getContext())}</th>;
                return (
                  <th key={header.id} className={`${headClass} sortable ${sorted ? 'sorted' : ''}`} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => onSort(header.column.id)}>{flexRender(header.column.columnDef.header, header.getContext())}<span className="sort-arrow">{sorted ? (sorted === 'asc' ? '▲' : '▼') : ''}</span></button>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.original.player} tabIndex={0} className="player-row" onKeyDown={(event) => onRowKey(event, row.original.player, row.index)}>
              {row.getVisibleCells().map((cell) => <td key={cell.id} className={cell.column.columnDef.meta?.className}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
