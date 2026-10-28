// Applying what NutBot proposes: each kind writes into the place its page already reads (the Players rule
// bar, the funnel draft, the saved highlight rules, the level table's settings) and says how to undo it.
import { write } from '@/api';
import { filterState, saveFilters } from '@/lib/filters';
import { gamePath, gameURL } from '@/lib/games';
import { storeGet, storePush, storeSet } from '@/lib/store';
import type { Game, NutBotProposal } from '@/lib/types';
import { groupDraftKey, groupRunKey } from '../levels/groupModel';
import { restoreSavedGroup, type SavedGroupItem } from '../levels/groupLibraryModel';
import { cleanNavigation, navigationKey } from '../levels/levelMath';
import { viewKey } from '../levels/levelPaths';

export const APPLY_KEY = 'avn-nutbot-apply';
export type ApplyMode = 'ask' | 'auto';
export const applyMode = (): ApplyMode => (storeGet<string>(APPLY_KEY) === 'auto' ? 'auto' : 'ask');

/** A stable name for a proposal, so a reloaded chat knows which cards were applied. */
export const proposalKey = (proposal: NutBotProposal): string => `${proposal.kind}:${proposal.title}:${JSON.stringify(proposal.payload)}`;

export type Applied = { path: string; undo: () => Promise<void> };

const KINDS: Record<NutBotProposal['kind'], string> = { players: 'players', funnel: 'funnels', highlight: 'players', levels: 'levels', groups: 'levels', report: 'overview' };

/** A report is kept, not shown on a page: saving it never opens a page and "Applies itself" never saves one. */
export const savesReport = (proposal: NutBotProposal): boolean => proposal.kind === 'report';
export const proposalPage = (proposal: NutBotProposal): string => KINDS[proposal.kind];

const restore = (key: string, before: unknown): void => storePush(key, before ?? null);

function setDates(game: Game, payload: { start?: string; end?: string }): () => void {
  const before = filterState(game);
  if (payload.start && payload.end) saveFilters(game, { ...before, range: { preset: 'custom', from: payload.start, to: payload.end } });
  return () => saveFilters(game, before);
}

/** Applies one proposal for `game`. The caller navigates to `path` and offers the undo. `chatId` ties a saved report to its chat. */
export async function applyProposal(game: Game, proposal: NutBotProposal, chatId?: string | null): Promise<Applied> {
  const payload = proposal.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const path = gamePath(game, proposalPage(proposal));
  switch (proposal.kind) {
    case 'report': {
      const base = `/v1/games/${encodeURIComponent(game.id)}/nutbot/reports`;
      const saved = await write<{ id: string }>(base, { method: 'POST', body: JSON.stringify({ title: payload.title, body: payload.body, headline: payload.headline || undefined, chat_id: chatId || undefined }) });
      return { path, undo: async () => { await write(`${base}/${encodeURIComponent(saved.id)}`, { method: 'DELETE' }); } };
    }
    case 'players': {
      const key = `avn-players-view-${game.id}`;
      const before = storeGet<Record<string, unknown>>(key);
      const undoDates = setDates(game, payload);
      storePush(key, { fold: {}, ...(before || {}), sort: payload.sort || 'last_seen', order: payload.order || 'desc', conditions: payload.conditions || [], metrics: payload.metrics || [] });
      return { path, undo: async () => { restore(key, before); undoDates(); } };
    }
    case 'funnel': {
      const key = `avn-funnel-draft-${game.id}`;
      const before = storeGet<Record<string, unknown>>(key);
      const undoDates = setDates(game, payload);
      if (payload.show_journeys) storePush(`avn-pending-journeys-${game.id}`, 1);
      storePush(key, { id: null, name: proposal.title, steps: (payload.steps || []).map((step: Record<string, string>) => ({ event: step.event, param: step.param || '', op: step.op || 'eq', value: step.value || '', label: step.label || '' })), scope: payload.scope || 'player', window_hours: payload.window_hours || null });
      return { path, undo: async () => { restore(key, before); undoDates(); } };
    }
    case 'highlight': {
      const base = `/v1/games/${encodeURIComponent(game.id)}/insights/highlights`;
      const saved = await write<{ id: string }>(base, { method: 'POST', body: JSON.stringify({ name: payload.name, color: payload.color, conditions: payload.conditions }) });
      return { path: gamePath(game, 'players'), undo: async () => { await write(`${base}/${encodeURIComponent(saved.id)}`, { method: 'DELETE' }); } };
    }
    case 'groups': {
      const item = payload.item as { name: string; kind: SavedGroupItem['kind']; definition: SavedGroupItem['definition'] };
      const library = `${gameURL(game)}/insights/group-library`;
      const saved = payload.save ? await write<{ id: string }>(library, { method: 'POST', body: JSON.stringify(item) }) : null;
      const restored = restoreSavedGroup({ id: saved?.id ?? '', name: item.name, kind: item.kind, definition: item.definition, updated_at: '' });
      const draftKey = groupDraftKey(game.id); const runKey = groupRunKey(game.id);
      const before = { draft: storeGet(draftKey), run: storeGet(runKey), filters: storeGet(`${runKey}-filters`), view: storeGet(viewKey(game)) };
      storeSet(viewKey(game), 'groups');
      storeSet(draftKey, restored.draft);
      storeSet(`${runKey}-filters`, restored.filters);
      storePush(runKey, item.kind === 'check' ? restored.draft : before.run);
      return {
        path,
        undo: async () => {
          storeSet(viewKey(game), before.view); storeSet(draftKey, before.draft); storeSet(`${runKey}-filters`, before.filters); storePush(runKey, before.run);
          if (saved) await write(`${library}/${encodeURIComponent(saved.id)}`, { method: 'DELETE' });
        },
      };
    }
    case 'levels': {
      const key = navigationKey(game);
      const before = storeGet<Record<string, unknown>>(key);
      const undoDates = setDates(game, payload);
      storePush(key, { ...cleanNavigation(before), sort: payload.sort || 'level', scope: payload.scope || 'all' });
      return { path, undo: async () => { restore(key, before); undoDates(); } };
    }
  }
}
