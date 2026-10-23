// Mapping health: the notice on the overview that says when a level moment the dashboards depend on has
// no event behind it, or a mapping rule matches nothing. Dismissing it is remembered per game until the
// problems change.
import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { useRead } from '@/api';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { Game } from '@/lib/types';
import { Ico } from '@/components/icons';

export type MappingIssue = { kind: 'missing' | 'silent'; concept: string; label: string; used_by: string[]; event?: string };
export type MappingStatus = { ok: boolean; has_events: boolean; issues: MappingIssue[] };

export const mappingIssueText = (issue: MappingIssue): string => (issue.kind === 'missing'
  ? `${issue.label} is not mapped to any of your events, so ${issue.used_by.join(', ')} cannot read it.`
  : `${issue.event} is mapped to ${issue.label}, but no event your game sent matches that rule.`);

export const mappingSignature = (status: Pick<MappingStatus, 'issues'>): string => status.issues.map((issue) => `${issue.kind}:${issue.concept}:${issue.event || ''}`).sort().join('|');

const dismissKey = (game: Pick<Game, 'id'>) => `avn-mapping-dismissed-${game.id}`;

/** Whether the notice should show: there are events, there are issues, and this set of issues was not dismissed. */
export const mappingNoticeShown = (status: MappingStatus | undefined, dismissed: string | null): boolean => Boolean(status && status.has_events && status.issues.length && dismissed !== mappingSignature(status));

export function MappingNotice({ game }: { game: Pick<Game, 'id'> }): ReactElement | null {
  const status = useRead<MappingStatus>(`${gameURL(game)}/mappings/status`);
  const [dismissed, setDismissed] = useState<string | null>(() => storeGet<string>(dismissKey(game)));
  // No notice is better than a wrong one: a failed read shows nothing.
  if (!status.data || !mappingNoticeShown(status.data, dismissed)) return null;
  const issues = status.data.issues;
  const first = mappingIssueText(issues[0]!);
  const more = issues.length > 1 ? ` And ${issues.length - 1} more.` : '';
  const signature = mappingSignature(status.data);
  const dismiss = () => { storeSet(dismissKey(game), signature); setDismissed(signature); };
  return (
    <div className="notice-banner" role="status">
      <Ico name="pulse" size={18} />
      <div><strong>Mappings need attention.</strong> {first}{more} <span className="muted">If your game has no levels, you can dismiss this.</span></div>
      <Link className="button" to={gamePath(game, 'event-setup')} hash="mappings">Open event setup</Link>
      <button type="button" className="button" onClick={dismiss}>Dismiss</button>
    </div>
  );
}
