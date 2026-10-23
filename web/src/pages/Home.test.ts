import { describe, expect, it } from 'vitest';
import { gameGroups } from '@/lib/games';
import type { Game } from '@/lib/types';
import { homeList, initialHomeFilter } from './Home';

const game = (over: Partial<Game>): Game => ({ id: over.bundle_id || 'g', name: 'Game', bundle_id: 'com.x', platform: 'android', created_at: '2024-01-01T00:00:00Z', ...over });
const all = gameGroups([
  game({ name: 'Alpha', bundle_id: 'com.a', events: 10, last_event: '2024-03-01T00:00:00Z', created_at: '2024-01-01T00:00:00Z', notes: 'Store link pending' }),
  game({ name: 'Beta', bundle_id: 'com.b', events: 300, last_event: '2024-02-01T00:00:00Z', created_at: '2024-02-01T00:00:00Z' }),
  game({ name: 'Charlie', bundle_id: 'com.c', events: 50, last_event: null, created_at: '2024-03-01T00:00:00Z', archived_at: '2024-03-02T00:00:00Z' }),
]);
const names = (groups: ReturnType<typeof homeList>) => groups.map((group) => group.name);

describe('homeList', () => {
  it('shows active games by default and archived or all on request', () => {
    expect(names(homeList(all, { query: '', filter: 'active', sort: 'recent' }))).toEqual(['Alpha', 'Beta']);
    expect(names(homeList(all, { query: '', filter: 'archived', sort: 'recent' }))).toEqual(['Charlie']);
    expect(names(homeList(all, { query: '', filter: 'all', sort: 'name' }))).toEqual(['Alpha', 'Beta', 'Charlie']);
  });

  it('searches name, bundle ID and notes, case-insensitively', () => {
    expect(names(homeList(all, { query: 'COM.B', filter: 'all', sort: 'name' }))).toEqual(['Beta']);
    expect(names(homeList(all, { query: 'store link', filter: 'all', sort: 'name' }))).toEqual(['Alpha']);
    expect(names(homeList(all, { query: 'zzz', filter: 'all', sort: 'name' }))).toEqual([]);
  });

  it('sorts by latest activity, name, events or newest', () => {
    expect(names(homeList(all, { query: '', filter: 'all', sort: 'recent' }))).toEqual(['Alpha', 'Beta', 'Charlie']);
    expect(names(homeList(all, { query: '', filter: 'all', sort: 'events' }))).toEqual(['Beta', 'Charlie', 'Alpha']);
    expect(names(homeList(all, { query: '', filter: 'all', sort: 'newest' }))).toEqual(['Charlie', 'Beta', 'Alpha']);
  });

  it('opens on All when every game is archived', () => {
    expect(initialHomeFilter(all)).toBe('active');
    expect(initialHomeFilter(gameGroups([game({ archived_at: '2024-01-02T00:00:00Z' })]))).toBe('all');
    expect(initialHomeFilter([])).toBe('active');
  });
});
