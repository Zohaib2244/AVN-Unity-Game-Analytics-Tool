// The pure parts of the Players page: what a rule says, what a metric column is called and shows, which
// rules are complete enough to send, and the order the server returns players in (mirrored here so the
// list on screen always agrees with its sort header, even while a newer answer is loading).
import { operatorLabel } from '@/lib/filters';
import { analysisDate, number, type Timezone } from '@/lib/format';
import type { EventRule, PlayerMetric, PlayerRow, PlayerRulesBody } from '@/lib/types';

export const AGG_LABELS: Record<NonNullable<EventRule['agg']>, string> = { count: 'How many times', max: 'Highest value', min: 'Lowest value', sum: 'Total of', first: 'First time', last: 'Last time' };
export const BASE_SORTS: Array<[string, string]> = [['last_seen', 'Last active'], ['first_seen', 'First seen'], ['events', 'Events'], ['sessions', 'Sessions'], ['session_length', 'Session length'], ['playtime', 'Total playtime'], ['version', 'App version']];
export const PAGE_SIZE = 50;

/** "level_start · level ≥ 12" or just the event. */
export const ruleSubject = (rule: EventRule): string => `${rule.event}${rule.param ? ` · ${rule.param}${rule.op === 'exists' ? '' : ` ${operatorLabel(rule.op)} ${rule.value}`}` : ''}`;

export function metricLabel(metric: EventRule): string {
  if (metric.label) return metric.label;
  const agg = metric.agg || 'count';
  if (agg === 'max' || agg === 'min' || agg === 'sum') return `${{ max: 'Highest', min: 'Lowest', sum: 'Total' }[agg]} ${metric.of || metric.param || '?'} · ${metric.event}`;
  return `${{ count: 'Times', first: 'First time', last: 'Last time' }[agg]}: ${ruleSubject(metric)}`;
}

export const metricValue = (metric: EventRule, value: number | string | null | undefined, timezone: Timezone = 'local'): string =>
  value == null ? '—' : metric.agg === 'first' || metric.agg === 'last' ? analysisDate(String(value), timezone) : number(Number(value));

/** The rules with an event, normalised (no parameter → no test; "any value" → no value), private `_` keys dropped. */
export function usableRules<T extends EventRule>(list: T[]): T[] {
  return list.filter((rule) => rule.event).map(({ event, param, op, value, ...rest }) => ({
    event, param: param || '', op: param ? op || 'eq' : 'eq', value: param && op !== 'exists' ? value || '' : '',
    ...Object.fromEntries(Object.entries(rest).filter(([key]) => !key.startsWith('_'))),
  }) as T);
}

/** What the server is asked: every usable condition and metric with their defaults filled in. */
export const rulesBody = (view: { conditions: EventRule[]; metrics: EventRule[] }): PlayerRulesBody => ({
  conditions: usableRules(view.conditions).map((rule) => ({ ...rule, does: rule.does || 'did', min_times: rule.min_times || 1 })),
  metrics: usableRules(view.metrics).map((rule) => ({ ...rule, agg: rule.agg || 'count' })),
});

export const sortOptions = (metrics: PlayerMetric[]): Array<[string, string]> => [...BASE_SORTS, ...metrics.map((metric, position): [string, string] => [`metric${position}`, metricLabel(metric)])];

/** The sort the server knows; anything else (a column that was removed) falls back to last active. */
export const validSort = (sort: string, metrics: PlayerMetric[]): string => (sortOptions(metrics).some(([key]) => key === sort) ? sort : 'last_seen');

const metricIndex = (sort: string): number => Number(sort.replace('metric', ''));
export const isTimeSort = (sort: string, metrics: PlayerMetric[]): boolean => ['last_seen', 'first_seen', 'version'].includes(sort) || /first|last/.test(metrics[metricIndex(sort)]?.agg || '');

export function orderLabel(sort: string, order: 'asc' | 'desc', metrics: PlayerMetric[]): string {
  if (sort === 'session_length' || sort === 'playtime') return order === 'desc' ? 'Longest first' : 'Shortest first';
  const time = isTimeSort(sort, metrics);
  return order === 'desc' ? (time ? 'Newest first' : 'Highest first') : time ? 'Oldest first' : 'Lowest first';
}

/** A version as numbers so 1.10 sorts after 1.9 (the server's version_key). */
export const versionKey = (version: string | null | undefined): number[] => (version || '').split(/[.\-+ ]/).map((part) => Number.parseInt(part, 10)).map((part) => (Number.isFinite(part) ? part : 0));

const sortValue = (row: PlayerRow, sort: string): number | string | null => {
  switch (sort) {
    case 'last_seen': return row.last_seen;
    case 'first_seen': return row.first_seen;
    case 'events': return row.events;
    case 'sessions': return row.sessions;
    case 'session_length': return row.avg_session_seconds;
    case 'playtime': return row.total_play_seconds;
    case 'version': return row.app_version;
    default: return sort.startsWith('metric') ? row.metrics?.[metricIndex(sort)] ?? null : row.last_seen;
  }
};
const compareValues = (a: number | string, b: number | string, sort: string): number => {
  if (sort === 'version') { const [x, y] = [versionKey(String(a)), versionKey(String(b))]; for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

/** The server's order: empty values last, then the key, then last active (newest first), then the ID. */
export function playerComparator(sort: string, order: 'asc' | 'desc'): (a: PlayerRow, b: PlayerRow) => number {
  const direction = order === 'asc' ? 1 : -1;
  return (a, b) => {
    const [x, y] = [sortValue(a, sort), sortValue(b, sort)];
    if (x == null || y == null) return x == null && y == null ? tieBreak(a, b) : x == null ? 1 : -1;
    return compareValues(x, y, sort) * direction || tieBreak(a, b);
  };
}
const tieBreak = (a: PlayerRow, b: PlayerRow): number => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : a.player < b.player ? -1 : a.player > b.player ? 1 : 0);
