// Player groups as chips (player_chips.py on the server): what each kind of condition is called, the
// sentence a chip reads as, and which ones the "Add" menu offers under which heading. Every chip in a
// group must hold; a chip with several values means "any of them".

import { OP_WORDS, valuelessOp } from '@/lib/conditions';
import type { EventRule } from '@/lib/types';

export type SavedChipGroup = { id: string; name: string; kind: 'players'; definition: { chips: Chip[] }; updated_at: string };
export type ChipSelection = { name: string; chips: Chip[] };
export type GroupCounts = { all: number; counts: Record<string, number> };

export type ChipKind =
  | 'campaign' | 'media_source' | 'install_type' | 'installed'
  | 'ad_format' | 'ad_network' | 'ad_creative' | 'ad_failed' | 'earned'
  | 'paid_back' | 'cost'
  | 'highest_level' | 'stopped_on'
  | 'days_active' | 'sessions' | 'last_seen'
  | 'event';

export type Chip = {
  kind: ChipKind;
  values?: string[];
  value?: 'paid' | 'organic' | 'none';
  min?: number | null; max?: number | null;
  from?: string; to?: string;
  level?: number;
  within_days?: number | null; more_than_days?: number | null;
  event?: string; param?: string; never?: boolean; op?: string; rule_value?: string;
};

/** Kinds whose editor is a list of values to tick, with where the values come from. */
export const VALUE_KINDS: Partial<Record<ChipKind, 'campaign' | 'media_source' | 'ad_format' | 'ad_network' | 'ad_creative'>> = {
  campaign: 'campaign', media_source: 'media_source', ad_format: 'ad_format', ad_network: 'ad_network', ad_creative: 'ad_creative',
};
/** Kinds whose editor is "at least / at most / between" two numbers, with the unit they are in. */
export const RANGE_KINDS: Partial<Record<ChipKind, '$' | '%' | ''>> = { earned: '$', cost: '$', paid_back: '%', highest_level: '', days_active: '', sessions: '' };

export const MENU: Array<{ heading: string; items: Array<{ kind: ChipKind; label: string; never?: boolean }> }> = [
  { heading: 'Where they came from', items: [{ kind: 'campaign', label: 'Campaign' }, { kind: 'media_source', label: 'Media source' }, { kind: 'installed', label: 'Installed on' }, { kind: 'install_type', label: 'Paid or organic' }] },
  { heading: 'Ads', items: [{ kind: 'ad_format', label: 'Saw a format' }, { kind: 'ad_network', label: 'Saw a network' }, { kind: 'ad_creative', label: 'Saw a creative' }, { kind: 'ad_failed', label: 'Had an ad fail' }, { kind: 'earned', label: 'Earned from ads' }] },
  { heading: 'Money', items: [{ kind: 'paid_back', label: 'Paid back their cost' }, { kind: 'cost', label: 'Cost to acquire' }] },
  { heading: 'Progress', items: [{ kind: 'highest_level', label: 'Highest level' }, { kind: 'stopped_on', label: 'Stopped on a level' }] },
  { heading: 'Activity', items: [{ kind: 'days_active', label: 'Days active' }, { kind: 'sessions', label: 'Sessions' }, { kind: 'last_seen', label: 'Last seen' }] },
  { heading: 'Anything else', items: [{ kind: 'event', label: 'Did an event…' }, { kind: 'event', label: 'Never did an event…', never: true }] },
];

/** A new chip of this kind, filled in with a sensible start. */
export function blankChip(kind: ChipKind, never = false): Chip {
  if (VALUE_KINDS[kind]) return { kind, values: [] };
  switch (kind) {
    case 'install_type': return { kind, value: 'paid' };
    case 'installed': return { kind, from: '', to: '' };
    case 'ad_failed': return { kind, values: [] };
    case 'earned': return { kind, min: 0.5, max: null };
    case 'paid_back': return { kind, min: 100, max: null };
    case 'cost': return { kind, min: null, max: 0.5 };
    case 'highest_level': return { kind, min: 10, max: null };
    case 'stopped_on': return { kind, level: 1 };
    case 'days_active': return { kind, min: 2, max: null };
    case 'sessions': return { kind, min: 3, max: null };
    case 'last_seen': return { kind, within_days: 7, more_than_days: null };
    case 'event': return { kind, event: '', never };
    default: return { kind };
  }
}

const orList = (values: string[] | undefined, words?: (value: string) => string): string => {
  const shown = (values ?? []).map((value) => (words ? words(value) : value));
  if (shown.length <= 2) return shown.join(' or ');
  return `${shown.slice(0, 2).join(', ')} or ${shown.length - 2} more`;
};
const money = (value: number): string => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plainNumber = (value: number): string => value.toLocaleString();
const FORMAT_WORDS: Record<string, string> = { AppOpen: 'app open', Interstitial: 'interstitial', Rewarded: 'rewarded', Banner: 'banner' };

function rangeText(chip: Chip, show: (value: number) => string): string {
  const low = chip.min ?? null; const high = chip.max ?? null;
  if (low != null && high != null) return low === high ? show(low) : `${show(low)} to ${show(high)}`;
  if (low != null) return `at least ${show(low)}`;
  if (high != null) return `at most ${show(high)}`;
  return '…';
}

/** What the chip says, split into its quiet verb and its value: ["came from", "D7 WW or HIT33"]. */
export function chipWords(chip: Chip): [string, string] {
  switch (chip.kind) {
    case 'campaign': return ['came from', orList(chip.values) || '…'];
    case 'media_source': return ['came through', orList(chip.values) || '…'];
    case 'install_type': return ['installed', chip.value === 'organic' ? 'organically' : chip.value === 'none' ? 'with no install record' : 'from a paid campaign'];
    case 'installed': return ['installed', chip.from && chip.to ? `${chip.from} to ${chip.to}` : chip.from ? `on or after ${chip.from}` : chip.to ? `on or before ${chip.to}` : '…'];
    case 'ad_format': return ['saw', chip.values?.length ? `a ${orList(chip.values, (value) => FORMAT_WORDS[value] ?? value)} ad` : '…'];
    case 'ad_network': return ['saw an ad from', orList(chip.values) || '…'];
    case 'ad_creative': return ['saw creative', orList(chip.values) || '…'];
    case 'ad_failed': return ['had', chip.values?.length ? `a ${orList(chip.values, (value) => FORMAT_WORDS[value] ?? value)} ad fail` : 'an ad fail'];
    case 'earned': return ['earned', rangeText(chip, money)];
    case 'paid_back': return ['paid back', `${rangeText(chip, (value) => `${plainNumber(value)}%`)} of their cost`];
    case 'cost': return ['cost', rangeText(chip, money)];
    case 'highest_level': return ['reached level', rangeText(chip, plainNumber)];
    case 'stopped_on': return ['stopped on level', chip.level != null ? plainNumber(chip.level) : '…'];
    case 'days_active': return ['played on', `${rangeText(chip, plainNumber)} days`];
    case 'sessions': return ['played', `${rangeText(chip, plainNumber)} sessions`];
    case 'last_seen': return chip.more_than_days != null ? ['not seen for', `${plainNumber(chip.more_than_days)}+ days`] : ['seen in the last', `${plainNumber(chip.within_days ?? 0)} days`];
    case 'event': {
      const name = chip.event || '…';
      const test = chip.param ? chip.op ? ` with ${chip.param} ${OP_WORDS[chip.op] ?? chip.op}${valuelessOp(chip.op) ? '' : ` ${chip.rule_value ?? ''}`}` : ` with ${chip.param} ${orList(chip.values)}` : '';
      const times = !chip.never && (chip.min ?? 1) > 1 ? ` at least ${plainNumber(chip.min!)} times` : '';
      return [chip.never ? 'never did' : 'did', `${name}${test}${times}`];
    }
    default: return ['', ''];
  }
}

/** Whether the chip says enough to be sent (an empty value list or a blank event is not). */
export function chipReady(chip: Chip): boolean {
  if (VALUE_KINDS[chip.kind]) return !!chip.values?.length;
  if (RANGE_KINDS[chip.kind] != null) return chip.min != null || chip.max != null;
  if (chip.kind === 'installed') return !!(chip.from || chip.to);
  if (chip.kind === 'stopped_on') return chip.level != null;
  if (chip.kind === 'last_seen') return chip.within_days != null || chip.more_than_days != null;
  if (chip.kind === 'event') return !!chip.event && (!chip.param || (chip.op ? valuelessOp(chip.op) || chip.rule_value !== undefined : !!chip.values?.length));
  return true;
}

/** What the server is sent: the ready chips, without empty fields. */
export function groupParam(chips: Chip[]): string {
  const ready = chips.filter(chipReady).map((chip) => Object.fromEntries(Object.entries(chip).filter(([, value]) => value !== null && value !== '' && value !== undefined && !(Array.isArray(value) && !value.length))));
  return ready.length ? JSON.stringify(ready) : '';
}

/** A one-line summary of a saved group for the side list. */
export const groupSummary = (chips: Chip[]): string => chips.map((chip) => chipWords(chip).join(' ')).join(' · ');

/** "See these players" from Ads or Acquisition arrives as campaign= / source= / install=: turn it into chips. */
export function chipsFromSearch(search: Record<string, string | undefined>): Chip[] {
  if (search.campaign) return [{ kind: 'campaign', values: [search.campaign] }];
  if (search.source) return [{ kind: 'media_source', values: [search.source] }];
  if (search.install === 'paid' || search.install === 'organic' || search.install === 'none') return [{ kind: 'install_type', value: search.install }];
  return [];
}

/** Preserve the shared rule vocabulary, occurrence threshold, and negative rules during migration. */
export function legacyChips(rules: EventRule[]): Chip[] {
  return rules.filter((rule) => rule.event).map((rule) => ({
    kind: 'event', event: rule.event, param: rule.param || undefined, op: rule.op || 'eq',
    rule_value: rule.value ?? '', never: rule.does === 'didnt', min: rule.min_times || 1,
  }));
}

/** Adapt legacy multi-value equality chips without changing membership when an editor opens. */
export function chipRule(chip: Chip): EventRule {
  return { event: chip.event ?? '', param: chip.param ?? '', op: chip.op ?? 'eq', value: chip.rule_value ?? chip.values?.[0] ?? '' };
}
export function withChipRule(chip: Chip, patch: Partial<EventRule>): Chip {
  const rule = { ...chipRule(chip), ...patch };
  // An untouched multi-value condition keeps every value. An explicit edit replaces its test.
  return { ...chip, event: rule.event, param: rule.param, op: rule.op, rule_value: rule.value, values: undefined };
}
