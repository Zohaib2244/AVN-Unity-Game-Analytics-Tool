// The pure part of the dictionary import: the default options, how the server's reasons and flags read,
// list parsing, merging remembered options over the defaults, reading the prepare form, and which texts
// of a preview start ticked.
import type { ImportChange, ImportFlag, ImportOptions, ImportPreview } from '@/lib/types';

export const IMPORT_DEFAULTS: ImportOptions = {
  mode: 'fill_blanks', fields: ['description', 'params'],
  scope: { events: 'undocumented', names: [], prefixes: [], seen_within_days: null, include_not_yet_received: true, include_hidden: false },
  style: { language: 'English', tone: 'concise', max_description_chars: 200, game_context: '', param_values: false },
  code: { include_paths: [], exclude_paths: [], call_patterns: [] },
  min_confidence: 'inferred', require_source: true, status: 'draft', max_overwrites: 25, near_duplicates: 'warn', type_conflicts: 'flag',
};
export const IMPORT_REASONS: Record<string, string> = {
  no_proposal: 'Nothing proposed', unknown_confidence: 'The agent was not sure', low_confidence: 'Below the confidence you asked for',
  no_source: 'No source given', already_described: 'Already has text (kept)', written_by_a_person: 'Written by a person (kept)',
  unchanged: 'Same as now', field_not_allowed: 'Not part of this import', too_long: 'Longer than the limit',
  too_many_params: 'Too many parameters', near_duplicate: 'Name looks like an existing event', sdk_event: 'Built-in event',
  hidden: 'Hidden event', not_yet_received: 'Not received yet', not_seen_recently: 'Not sent recently', not_listed: 'Not in your list',
  already_documented: 'Already documented',
};
const IMPORT_FLAGS: Record<string, (flag: ImportFlag) => string> = {
  near_duplicate: (flag) => `Similar to ${(flag.similar || []).join(', ')}`,
  type_conflict: (flag) => `${(flag.field || '').replace('param:', '')} is sent as ${(flag.types || []).join(' and ')}`,
  type_mismatch: (flag) => `${(flag.field || '').replace('param:', '')}: code says ${flag.code}, data says ${(flag.observed || []).join('/')}`,
  changed_since_template: () => 'Changed since this file was prepared',
};
export const flagText = (flag: ImportFlag): string => (IMPORT_FLAGS[flag.flag] || (() => flag.flag))(flag);

/** Lines or commas → trimmed, non-empty items. */
export const importList = (value: unknown): string[] => String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
export const importField = (field: string): string => (field === 'description' ? 'description' : field.replace('param:', 'parameter '));
/** Remembered options over the defaults: nested objects merge one level deep, unknown keys are ignored. */
export function importMerge(base: ImportOptions, saved: unknown): ImportOptions {
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const [key, value] of Object.entries((saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object') Object.assign(out[key] as object, value);
    else if (key in out) out[key] = value;
  }
  return out as unknown as ImportOptions;
}

/** The coverage preset the options stand for: 'missing', 'all', or '' when they are custom. */
export const coverageChoice = (o: Pick<ImportOptions, 'mode' | 'scope'>): 'missing' | 'all' | '' => (o.scope.events === 'undocumented' && o.mode === 'fill_blanks' ? 'missing' : o.scope.events === 'all' && o.mode === 'overwrite_all' ? 'all' : '');

/** The prepare form's values → options. */
export function readOptions(data: FormData): ImportOptions {
  const get = (name: string) => data.get(name);
  const fields = [get('field-description') ? 'description' : null, get('field-params') ? 'params' : null].filter((item): item is string => Boolean(item));
  const listed = importList(get('names'));
  return {
    mode: String(get('mode') || 'fill_blanks'), fields: fields.length ? fields : ['description', 'params'],
    scope: { events: String(get('events') || 'undocumented'), names: listed.filter((item) => !item.endsWith('*')), prefixes: listed.filter((item) => item.endsWith('*') && item.length > 1).map((item) => item.slice(0, -1)),
      seen_within_days: get('seen_within_days') ? Number(get('seen_within_days')) : null, include_not_yet_received: Boolean(get('include_not_yet_received')), include_hidden: Boolean(get('include_hidden')) },
    style: { language: String(get('language') || 'English').trim() || 'English', tone: String(get('tone') || 'concise'), max_description_chars: Number(get('max_description_chars')) || 200, game_context: String(get('game_context') || '').trim(), param_values: Boolean(get('param_values')) },
    code: { include_paths: importList(get('include_paths')), exclude_paths: importList(get('exclude_paths')), call_patterns: importList(get('call_patterns')) },
    min_confidence: String(get('min_confidence') || 'inferred'), require_source: Boolean(get('require_source')), status: String(get('status') || 'draft'),
    max_overwrites: Math.max(0, Number(get('max_overwrites')) || 0), near_duplicates: String(get('near_duplicates') || 'warn'), type_conflicts: get('type_conflicts') ? 'flag' : 'ignore',
  };
}

export const textKey = (change: Pick<ImportChange, 'name' | 'field'>): string => `${change.name}/${change.field}`;
export const allChanges = (preview: ImportPreview | null): ImportChange[] => (preview ? preview.events.flatMap((entry) => entry.changes) : []);
/** Everything is ticked, except names that only differ from an existing event by case or punctuation. */
export function defaultSelection(preview: ImportPreview): Set<string> {
  const selected = new Set<string>();
  preview.events.forEach((entry) => { if (!entry.flags.some((flag) => flag.flag === 'near_duplicate')) entry.changes.forEach((change) => selected.add(textKey(change))); });
  return selected;
}
/** True when the server's re-read differs from what was shown (the dictionary changed meanwhile). */
export function previewDrifted(shown: ImportChange[], check: ImportChange[], keys: Set<string>): boolean {
  const byKey = new Map(shown.map((change) => [textKey(change), change]));
  return check.length !== keys.size || check.some((change) => { const was = byKey.get(textKey(change)); return !was || was.before !== change.before || was.after !== change.after; });
}
