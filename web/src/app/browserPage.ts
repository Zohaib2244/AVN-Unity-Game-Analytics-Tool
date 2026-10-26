// Navigation memory stays in this browser and is separate for each account and workspace.
import { useEffect } from 'react';
import { isSection } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';

const keyFor = (workspace: string | null, identity: string) => `avn-last-page-${encodeURIComponent(identity)}-${workspace ?? ''}`;

function allowed(href: unknown, gameIds: string[]): href is string {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return false;
  const path = href.split(/[?#]/)[0]!;
  if (['/status', '/settings', '/team', '/workspaces'].includes(path)) return true;
  const parts = path.split('/');
  return parts[1] === 'games' && gameIds.includes(parts[2] ?? '') && (parts.length === 3 || (parts.length === 4 && isSection(parts[3]!)));
}

export function lastBrowserPage(workspace: string | null, identity: string, gameIds: string[]): string | null {
  const saved = storeGet(keyFor(workspace, identity));
  return allowed(saved, gameIds) ? saved : null;
}

/** Remember a destination for Home's Continue link. Home and explicit links never redirect. */
export function useBrowserPage(href: string, workspace: string | null, identity: string, gameIds: string[]): void {
  const key = keyFor(workspace, identity);
  useEffect(() => {
    if (allowed(href, gameIds)) storeSet(key, href);
  }, [href, key, gameIds]);
}
