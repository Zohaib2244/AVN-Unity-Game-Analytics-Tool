// "Occurrence of X" and "Drop by X" on the Levels page: pure helpers over /insights/levels/features.
import type { LevelFeatureKind, LevelFeatureRow, LevelThing } from '@/lib/types';

export type FeatureMode = 'occurrence' | 'drop';
export type FeatureSubject = 'ads' | 'powerups' | 'fails';
export type AdSplit = 'format' | 'placement';
/** What counts as leaving: never starting the next level, leaving the session, or both side by side. */
export type DropBasis = 'next' | 'session' | 'both';

export type FeaturePrefs = { mode: FeatureMode; subject: FeatureSubject; split: AdSplit; basis: DropBasis; value: string };
export const DEFAULT_FEATURE_PREFS: FeaturePrefs = { mode: 'occurrence', subject: 'ads', split: 'format', basis: 'both', value: '' };

export const SUBJECTS: Record<FeatureSubject, string> = { ads: 'Ads', powerups: 'Powerups', fails: 'Fail reasons' };
export const SPLITS: Record<AdSplit, string> = { format: 'Format', placement: 'Placement' };
export const BASES: Record<DropBasis, string> = { next: 'Never started the next level', session: 'Left the session', both: 'Both' };

const SUBJECTS_LIST = Object.keys(SUBJECTS) as FeatureSubject[];
const BASES_LIST = Object.keys(BASES) as DropBasis[];
export function cleanFeaturePrefs(raw: Partial<FeaturePrefs> | null | undefined): FeaturePrefs {
  const value = raw ?? {};
  return {
    mode: value.mode === 'drop' ? 'drop' : 'occurrence',
    subject: SUBJECTS_LIST.includes(value.subject as FeatureSubject) ? value.subject as FeatureSubject : 'ads',
    split: value.split === 'placement' ? 'placement' : 'format',
    basis: BASES_LIST.includes(value.basis as DropBasis) ? value.basis as DropBasis : 'both',
    value: typeof value.value === 'string' ? value.value : '',
  };
}

export const kindOf = (subject: FeatureSubject, split: AdSplit): LevelFeatureKind =>
  subject === 'ads' ? (split === 'placement' ? 'ad_placement' : 'ads') : subject === 'powerups' ? 'powerups' : 'fails';

/** "level_complete_x2" -> "Level complete x2"; names that are already words stay as they are. */
export const valueLabel = (value: string): string => (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(value) ? `${value[0]!.toUpperCase()}${value.slice(1).replace(/_/g, ' ')}` : value);

/** The values to show as columns: the commonest first, at most `limit`. */
export const topValues = (values: string[] | undefined, limit = 6): string[] => (values ?? []).slice(0, limit);

const share = (part: number, whole: number): number | null => (whole > 0 ? (100 * part) / whole : null);

/** How many of the level's starters met this, and how often per player who did. */
export function occurrence(row: LevelFeatureRow, kind: LevelFeatureKind, value: string): { players: number; share: number | null; perPlayer: number | null } {
  const thing = row.things[kind]?.[value];
  if (!thing) return { players: 0, share: row.started ? 0 : null, perPlayer: null };
  return { players: thing.players, share: share(thing.players, row.started), perPlayer: thing.players ? thing.times / thing.players : null };
}

export type DropSide = { with: number | null; without: number | null; difference: number | null };
/** Drop among players who met this against players who didn't, in percentage points. */
export function dropSide(row: LevelFeatureRow, thing: LevelThing | undefined, basis: 'next' | 'session'): DropSide {
  const total = basis === 'next' ? row.dropped : row.left_session;
  const mine = !thing ? 0 : basis === 'next' ? thing.dropped : thing.left_session;
  const players = thing?.players ?? 0;
  const withThing = share(mine, players);
  const without = share(total - mine, row.started - players);
  return { with: withThing, without, difference: withThing != null && without != null ? withThing - without : null };
}

export type DropCells = { starters: number; thing: LevelThing | undefined; overall: Record<'next' | 'session', number | null>; sides: Record<'next' | 'session', DropSide>; rightAfter: { count: number; ofDrops: number | null } };
export function dropCells(row: LevelFeatureRow, kind: LevelFeatureKind, value: string): DropCells {
  const thing = row.things[kind]?.[value];
  return {
    starters: row.started,
    thing,
    overall: { next: row.drop_available ? share(row.dropped, row.started) : null, session: share(row.left_session, row.started) },
    sides: { next: dropSide(row, thing, 'next'), session: dropSide(row, thing, 'session') },
    rightAfter: { count: thing?.right_after ?? 0, ofDrops: row.dropped > 0 && thing ? share(thing.right_after, row.dropped) : null },
  };
}

/** The level rows that have anything to show for this kind (levels where it never happened are left out of Drop by). */
export const rowsWith = (rows: LevelFeatureRow[], kind: LevelFeatureKind, value: string | null): LevelFeatureRow[] =>
  rows.filter((row) => (value == null ? Object.keys(row.things[kind] ?? {}).length > 0 : Boolean(row.things[kind]?.[value])));

/** Which value Drop by shows: the chosen one when it exists, else the commonest. */
export const chosenValue = (values: string[] | undefined, wanted: string): string => ((values ?? []).includes(wanted) ? wanted : (values ?? [])[0] ?? '');
