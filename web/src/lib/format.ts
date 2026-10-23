// Numbers, dates and words shared by every page.

export const number = (value: number | null | undefined): string => new Intl.NumberFormat().format(value || 0);
export const percent = (value: number | string): string => `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
export const displayDate = (value: string | null | undefined): string => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'No events yet');
export const fileSize = (value: number): string => (value >= 1073741824 ? `${(value / 1073741824).toFixed(1)} GB` : value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((value || 0) / 1024))} KB`);
export const platformLabel = (platform: string): string => ({ android: 'Android', ios: 'iOS' } as Record<string, string>)[platform] || platform;
export const plural = (count: number, word: string, many = `${word}s`): string => `${number(count)} ${count === 1 ? word : many}`;

export const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Local time';
export const localTimezoneOffset = (): number => -new Date().getTimezoneOffset();

/* ─── Days (YYYY-MM-DD, local calendar) ─── */
export function today(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
export const addDays = (value: string, days: number): string => { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);
export const monthStart = (value: string): string => `${value.slice(0, 8)}01`;
export const monthEnd = (value: string): string => { const date = new Date(`${value}T00:00:00Z`); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10); };
export const shiftMonth = (value: string, months: number): string => { const date = new Date(`${value}T00:00:00Z`); return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)).toISOString().slice(0, 10); };
export const prettyDay = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
export const shortDay = (value: string): string => new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dayToDate = (value: string): Date => { const [y, m, d] = value.split('-').map(Number); return new Date(y!, (m ?? 1) - 1, d ?? 1); };
export const dateToDay = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/* ─── Time of day, durations ─── */
export type Timezone = 'local' | 'utc';
const timeZoneOptions = (timezone: Timezone) => (timezone === 'utc' ? { timeZone: 'UTC' } : {});
export const clock = (value: string, timezone: Timezone = 'local'): string => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', ...timeZoneOptions(timezone) });
export const analysisDate = (value: string | null | undefined, timezone: Timezone = 'local'): string => (value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', ...timeZoneOptions(timezone) }) : 'No events yet');
export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const value = Math.round(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, '0')}s`;
  if (value < 86400) return `${Math.floor(value / 3600)}h ${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(value / 86400)}d ${Math.floor((value % 86400) / 3600)}h`;
}
export const relativeTime = (ms: number): string => { const s = Math.round((Date.now() - ms) / 1000); return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`; };
export const agoText = (value: string | null | undefined): string => (value ? relativeTime(Date.parse(value)) : 'never');

/* ─── Countries: show names, not two-letter codes ─── */
const COUNTRY_SPECIAL: Record<string, string> = { XX: 'Unknown country', T1: 'Tor network', unknown: 'Unknown country' };
const COUNTRY_NAMES = (() => { try { return new Intl.DisplayNames(['en'], { type: 'region' }); } catch { return null; } })();
export function countryName(code: string | null | undefined): string {
  if (!code) return '';
  if (COUNTRY_SPECIAL[code]) return COUNTRY_SPECIAL[code]!;
  try { return COUNTRY_NAMES?.of(String(code).toUpperCase()) || code; } catch { return code; }
}
export const countryText = (code: string | null | undefined): string => (code && countryName(code) !== code ? `${countryName(code)} (${code})` : code || '—');
export const dimensionText = (dimension: string, value: string): string => (dimension === 'country' ? countryText(value) : value);

export const shortId = (id: string): string => (id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);
export const propertyLabel = (key: string): string => key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
