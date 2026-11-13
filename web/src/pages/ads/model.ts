// The Ads page's plain logic: words for formats and groupings, and how money and shares are written.

export const GROUPS = [
  { value: 'format', label: 'Format' }, { value: 'network', label: 'Network' }, { value: 'placement', label: 'Placement' },
  { value: 'ad_unit', label: 'Ad unit' }, { value: 'country', label: 'Country' }, { value: 'app_version', label: 'Version' }, { value: 'day', label: 'Day' },
] as const;
export type AdGroup = (typeof GROUPS)[number]['value'];

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
