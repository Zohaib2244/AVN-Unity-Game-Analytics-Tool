// Who stays: the plain logic behind the page (pure, so it is tested without a browser).
import type { SeparatorFinding, SeparatorOutcome } from '@/lib/types';

export const OUTCOMES: Array<{ value: SeparatorOutcome; label: string; day: number }> = [
  { value: 'day_1', label: 'Day 1', day: 1 },
  { value: 'day_3', label: 'Day 3', day: 3 },
  { value: 'day_7', label: 'Day 7', day: 7 },
  { value: 'pays', label: 'Pays', day: 7 },
];
export const WINDOW_LABELS: Record<number, string> = { 1: 'First day', 2: 'First 2 days', 3: 'First 3 days' };

/** The first-days windows that make sense for an outcome: you cannot compare more days of play than days before the outcome. */
export function windowsFor(outcome: SeparatorOutcome): number[] {
  const day = OUTCOMES.find((item) => item.value === outcome)?.day ?? 7;
  return outcome === 'pays' ? [1, 2, 3] : [1, 2, 3].filter((days) => days <= day);
}

/** Keep the chosen window when the new outcome allows it, else the nearest allowed one. */
export const windowFor = (outcome: SeparatorOutcome, window: number): number => {
  const allowed = windowsFor(outcome);
  return allowed.includes(window) ? window : allowed[allowed.length - 1]!;
};

/** The Players page address search for a finding's chip, when it has one. */
export const chipSearch = (finding: SeparatorFinding): { chip: string } | null => (finding.chip ? { chip: JSON.stringify(finding.chip) } : null);

/** What the two sides are measured by, for column headings: "Came back on day 7". */
export const outcomeNoun = (outcome: SeparatorOutcome): string => (outcome === 'pays' ? 'Paid' : `Came back on day ${outcome.slice(4)}`);
