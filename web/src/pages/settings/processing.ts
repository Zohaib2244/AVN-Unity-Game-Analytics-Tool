// Analytics processing (admins only, on the Settings page): the words for each worker state and the
// sentences that say what is waiting and what each game's facts are doing. Pure; the panel is Processing.tsx.
import { number } from '@/lib/format';
import type { ProcessingGame, ProcessingStatus } from '@/lib/types';

export const PROCESSING_URL = '/v1/admin/analytics-worker';
export const PROCESSING_POLL_MS = 5000;

/** state → [pill kind, word, sentence]. Every state has a word and a sentence, never colour alone. */
export const PROCESSING_STATES: Record<string, [string, string, string]> = {
  running: ['good', 'Running', 'Answers are prepared in the background and kept fresh.'],
  catching_up: ['', 'Catching up', 'Working through events and changes that arrived since it last caught up.'],
  starting: ['', 'Starting', 'Start was requested; waiting for the worker to pick it up.'],
  stopping: ['', 'Stopping', 'Stop was requested; the worker stops after the step it is on.'],
  stopped: ['bad', 'Stopped', 'Events are still collected. Dashboards work things out when opened, which takes longer, and nothing is prepared in advance.'],
  unavailable: ['bad', 'Unavailable', 'The worker is not running or has stopped reporting. Events are still collected and dashboards still work, more slowly. Check the worker container.'],
};

export function processingWaiting(status: Pick<ProcessingStatus, 'pending'>): string {
  const pending = status.pending || {};
  const parts: string[] = [];
  if (pending.facts_remaining) parts.push(`${number(pending.facts_remaining)} older events to copy or check`);
  if (pending.views_waiting) parts.push(`${number(pending.views_waiting)} answers to bring up to date`);
  if (pending.lag_seconds) parts.push(`oldest prepared answer ${Math.round(pending.lag_seconds)} s old`);
  return parts.length ? parts.join(' · ') : 'Nothing';
}

const PHASES: Record<string, string> = { backfill: 'Copying older events', coverage: 'Checking every event is copied', values: 'Checking copied values' };

export function processingFacts(game: Pick<ProcessingGame, 'facts'>): string {
  const facts = game.facts;
  if (facts.ready) return 'Ready';
  const share = facts.total ? ` · ${Math.min(99, Math.floor((100 * (facts.done || 0)) / facts.total))}% of this step` : '';
  return `${PHASES[facts.phase || ''] || facts.phase}${share}`;
}
