// At risk: the plain logic behind the page (pure, so it is tested without a browser).
import type { ChurnPlayer, ChurnState } from '@/lib/types';

export const STATES: Array<{ value: ChurnState; label: string }> = [
  { value: 'slipping', label: 'Slipping' },
  { value: 'gone', label: 'Gone' },
  { value: 'any', label: 'Both' },
];

/** "every day", "every 2 days", "every 1.5 days". */
export const habit = (gap: number): string => (gap <= 1 ? 'every day' : `every ${Number.isInteger(gap) ? gap : gap.toFixed(1)} days`);

/** "today", "1 day ago", "9 days ago". */
export const ago = (days: number): string => (days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`);

export const stateWord = (state: ChurnPlayer['state']): string => (state === 'slipping' ? 'Slipping' : 'Gone');

/** The Players page address search for the whole group. */
export const groupSearch = (state: ChurnState): { chip: string } => ({ chip: JSON.stringify({ kind: 'churn_risk', value: state }) });

/** What the early-behaviour line under a player says: "Skipped “Tutorial · Completed” on day one". */
export const skipped = (player: Pick<ChurnPlayer, 'missing'>): string | null => (player.missing ? `Skipped “${player.missing}” on day one` : null);

/** The one sentence about what early behaviour goes with staying, for the foot of the list: shown once, not on every row. */
export const earlyWords = (fact: { human: string; with_rate: number; without_rate: number }): string => `“${fact.human}” on day one: ${Math.round(fact.with_rate * 100)}% of players who had it came back on day 7, ${Math.round(fact.without_rate * 100)}% of the rest.`;
