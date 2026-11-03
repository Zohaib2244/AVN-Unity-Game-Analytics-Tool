// The player list: a TanStack table with a sticky header, sortable columns (the server sorts; the page
// shown is ordered by the same comparator so the header and the rows always agree), one row per player
// that opens in the drawer on click or Enter.
import { useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type RowData } from '@tanstack/react-table';
import { TEST_ENVIRONMENTS } from '@/lib/filters';
import { analysisDate, countryName, duration, number, platformLabel, shortId, type Timezone } from '@/lib/format';
import { gamePath } from '@/lib/games';
import { eventLabel } from '@/pages/player/eventLayout';
import type { Game, PlayerMetric, PlayerRow } from '@/lib/types';
import { metricLabel, metricValue, playerComparator } from './rules';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> { className?: string; sortable?: boolean }
}

const column = createColumnHelper<PlayerRow>();
/** "3 Nov, 5:14 pm" in the reader's own format: the year is in the tooltip, as these are recent. */
const recent = (value: string, timezone: Timezone): string => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timezone === 'utc' ? { timeZone: 'UTC' } : {}) });
const plainClick = (event: MouseEvent): boolean => event.button === 0 && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);

export function PlayersTable({ game, rows, metrics, sort, order, timezone, onSort, onOpen }: {
  game: Game; rows: PlayerRow[]; metrics: PlayerMetric[]; sort: string; order: 'asc' | 'desc'; timezone: Timezone;
  onSort: (key: string) => void; onOpen: (player: string, index: number) => void;
}): ReactElement {
  const data = useMemo(() => [...rows].sort(playerComparator(sort, order)), [rows, sort, order]);
  // The page passes a new onOpen on every render. Columns built from it would be new every render too, and the
  // table would remount all its rows (a flicker) each time the drawer opens or closes; so read it through a ref.
  const open = useRef(onOpen);
  open.current = onOpen;
  const columns = useMemo(() => [
    column.accessor('player', { id: 'player', header: 'Player', enableSorting: false, cell: ({ row }) => (
      <>
        <Link to={gamePath(game, 'players')} search={{ player: row.original.player }} className="row-title" onClick={(event: MouseEvent) => { if (plainClick(event)) open.current(row.original.player, row.index); }}><span className="mono">{shortId(row.original.player)}</span></Link>
        <p className="small muted">{row.original.has_user_id ? 'User ID' : 'Install ID'} · {platformLabel(row.original.platform || '—')}{row.original.app_version ? ` · ${row.original.app_version}` : ''}{TEST_ENVIRONMENTS.includes(row.original.environment || '') ? <span className="pill"> {row.original.environment}</span> : null}</p>
      </>
    ) }),
    column.accessor('events', { id: 'events', header: 'Events', meta: { className: 'num', sortable: true }, cell: ({ getValue }) => number(getValue()) }),
    column.accessor('sessions', { id: 'sessions', header: 'Sessions', meta: { className: 'num', sortable: true }, cell: ({ getValue }) => number(getValue()) }),
    column.display({ id: 'level', header: 'Level', enableSorting: false, meta: { className: 'num' }, cell: ({ row }) => (row.original.highest_level != null ? number(row.original.highest_level) : '—') }),
    column.accessor('total_play_seconds', { id: 'playtime', header: 'Playtime', meta: { className: 'num', sortable: true }, cell: ({ getValue }) => duration(getValue()) }),
    column.accessor('last_seen', { id: 'last_seen', header: 'Last active', meta: { className: 'small muted', sortable: true }, cell: ({ getValue }) => <span title={analysisDate(getValue(), timezone)}>{recent(getValue(), timezone)}</span> }),
    column.display({ id: 'last_event', header: 'Last event', enableSorting: false, meta: { className: 'last-event' }, cell: ({ row }) => {
      const last = row.original.last_event;
      if (!last) return '—';
      return <span className="mono" title={last.name}><b>{eventLabel(last.name)}</b>{last.state ? ` · ${last.state}` : ''}{last.level != null ? ` · L${last.level}` : ''}</span>;
    } }),
    ...metrics.map((metric, position) => column.display({ id: `metric${position}`, header: metricLabel(metric), meta: { className: 'num metric', sortable: true }, cell: ({ row }) => metricValue(metric, row.original.metrics[position], timezone) })),
    column.accessor('country', { id: 'country', header: 'Country', enableSorting: false, meta: { className: 'small' }, cell: ({ getValue }) => (getValue() ? <abbr className="cc" title={countryName(getValue())}>{getValue()}</abbr> : '—') }),
  ], [game, metrics, timezone]);
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
                if (!meta.sortable) return <th key={header.id} className={meta.className}>{flexRender(header.column.columnDef.header, header.getContext())}</th>;
                return (
                  <th key={header.id} className={`${meta.className || ''} sortable ${sorted ? 'sorted' : ''}`} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : 'none'}>
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
