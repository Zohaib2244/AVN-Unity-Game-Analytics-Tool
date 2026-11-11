// The Ads page's plain logic: words for formats and groupings, the "Needs a look" items, and the
// numbers that join the delivery reads (serving + health + load times) into one row per format.
import type { AdCreatives, AdDelivery, AdRevenue } from '@/lib/types';

export const GROUPS = [
  { value: 'format', label: 'Format' }, { value: 'network', label: 'Network' }, { value: 'placement', label: 'Placement' },
  { value: 'ad_unit', label: 'Ad unit' }, { value: 'country', label: 'Country' }, { value: 'app_version', label: 'Version' }, { value: 'day', label: 'Day' },
] as const;
export type AdGroup = (typeof GROUPS)[number]['value'];
export const THEN_BY: Array<{ value: '' | AdGroup; label: string }> = [{ value: '', label: 'Nothing' }, { value: 'format', label: 'Format' }, { value: 'network', label: 'Network' }, { value: 'placement', label: 'Placement' }, { value: 'country', label: 'Country' }];

const FORMAT_WORDS: Record<string, string> = { AppOpen: 'App open', Interstitial: 'Interstitial', Rewarded: 'Rewarded', Banner: 'Banner', Mrec: 'Medium rectangle' };
/** "AppOpen" → "App open"; "level_complete_x2" → "Level complete x2". */
export function words(value: string | null | undefined): string {
  if (value == null || value === '') return 'Not named';
  if (FORMAT_WORDS[value]) return FORMAT_WORDS[value]!;
  const spaced = value.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export const money = (value: number | null | undefined, digits = 2): string => (value == null ? '—' : `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`);
export const share = (value: number | null | undefined): string => (value == null ? '—' : `${(value * 100).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);

export type DeliveryRow = {
  format: string; loadsWorked: number | null; loadMedianMs: number | null; wanted: number | null; heldByRules: number | null;
  noAdReady: number | null; shown: number | null; shownOfWanted: number | null; topError: string | null;
};

/** One row per format: what the game asked for and lost, whether loads worked and how long they took. */
export function deliveryRows(data: AdDelivery): DeliveryRow[] {
  const served = new Map((data.serving.groups ?? []).map((row) => [row.value ?? '', row]));
  const healthy = new Map((data.health.groups ?? []).map((row) => [row.value ?? '', row]));
  const formats = [...new Set([...served.keys(), ...healthy.keys()])].filter((name) => name && name !== 'Mrec');
  const errors = data.health.last_load_errors ?? [];
  return formats.map((format) => {
    const serve = served.get(format); const health = healthy.get(format);
    const notReady = serve ? (serve.failed_by.NotReady ?? 0) : null;
    return {
      format, loadsWorked: health?.load_success_rate ?? null, loadMedianMs: data.load_times[format]?.median_ms ?? null,
      wanted: serve?.wanted ?? null, heldByRules: serve?.blocked ?? null, noAdReady: notReady, shown: serve?.shown ?? (format === 'Banner' ? health?.impressions ?? null : null),
      shownOfWanted: serve?.shown_share ?? null, topError: errors.find((item) => item.format === format)?.error ?? null,
    };
  }).sort((a, b) => (b.wanted ?? -1) - (a.wanted ?? -1));
}

export type Look = { kind: 'bad' | 'warn'; tag: string; title: string; note: string; target: 'delivery' | 'revenue' | 'creatives' };

/** What deserves a look, worst first: formats that fail to load, ads lost for want of one ready,
 *  a network paying far below the others, revenue reports missing, creatives players leave on. */
export function looks(delivery: AdDelivery | undefined, networks: AdRevenue | undefined, revenue: AdRevenue | undefined, creatives: AdCreatives | undefined): Look[] {
  const found: Look[] = [];
  for (const row of delivery ? deliveryRows(delivery) : []) {
    if (row.loadsWorked != null && row.loadsWorked < 0.6) found.push({ kind: 'bad', tag: 'Loading', title: `${words(row.format)} fails to load ${share(1 - row.loadsWorked)} of the time`, note: row.topError ? `Mostly “${row.topError.replace(/^.*?:\s*/, '').slice(0, 70)}”` : 'See the load errors under Delivery', target: 'delivery' });
    if (row.noAdReady && row.wanted && row.noAdReady / row.wanted >= 0.1) found.push({ kind: 'warn', tag: 'Lost', title: `${row.noAdReady.toLocaleString()} ${words(row.format).toLowerCase()} ads had none ready`, note: `${share(row.noAdReady / row.wanted)} of the times the game wanted one`, target: 'delivery' });
  }
  const paying = (networks?.groups ?? []).filter((row) => row.impressions >= 200 && row.ecpm != null);
  if (paying.length >= 3) {
    const sorted = paying.map((row) => row.ecpm!).sort((a, b) => a - b);
    const middle = sorted[Math.floor(sorted.length / 2)]!;
    for (const row of paying) if (row.ecpm! < middle / 3) found.push({ kind: 'warn', tag: 'Network', title: `${row.value ?? 'A network'} pays ${money(row.ecpm)} per 1,000`, note: `${row.impressions.toLocaleString()} shown · the usual is ${money(middle)}`, target: 'revenue' });
  }
  if (revenue?.share_of_shows_with_revenue != null && revenue.share_of_shows_with_revenue < 0.85) found.push({ kind: 'warn', tag: 'Data', title: `${share(1 - revenue.share_of_shows_with_revenue)} of shown ads never reported revenue`, note: 'Revenue here runs low by about that much', target: 'revenue' });
  const usual = creatives?.usual_share;
  const worst = (creatives?.rows ?? []).filter((row) => usual != null && row.left_share != null && row.left_share - usual >= 0.15);
  if (worst.length) found.push({ kind: 'warn', tag: 'Creative', title: `${worst.length} creative${worst.length === 1 ? '' : 's'} players often leave on`, note: `${worst[0]!.creative} · ${share(worst[0]!.left_share)} left after it, usually ${share(usual)}`, target: 'creatives' });
  return found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'bad' ? -1 : 1));
}

/** The plain-words line above the revenue table. */
export function revenueSentence(data: AdRevenue): string {
  const top = data.groups[0];
  if (!top || !data.full_screen.revenue) return '';
  const second = data.groups.find((row) => row !== top && row.ecpm != null && top.ecpm != null && row.ecpm > top.ecpm * 1.5);
  const what = data.group_by === 'day' ? null : words(top.value);
  const lead = what ? `${what} earns ${share(top.share_of_full_screen_revenue)} of full-screen revenue.` : '';
  return `${lead}${second ? ` ${words(second.value)} pays ${money(second.ecpm)} per 1,000 shown, more per view.` : ''}`.trim();
}
