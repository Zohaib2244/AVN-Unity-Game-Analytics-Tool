import { describe, expect, it } from 'vitest';
import { gameGroups } from './games';
import type { Game } from './types';

const game = (over: Partial<Game>): Game => ({ id: over.id || over.bundle_id || 'g', name: 'Tiny Adventures', bundle_id: 'com.studio.tiny', platform: 'android', created_at: '2024-01-01T00:00:00Z', ...over });

describe('gameGroups', () => {
  it('groups the Android and iOS versions by name (case and spaces ignored), Android first', () => {
    const groups = gameGroups([
      game({ id: 'ios', platform: 'ios', name: 'tiny adventures ', events: 50 }),
      game({ id: 'and', platform: 'android', events: 10 }),
      game({ id: 'other', name: 'Other', bundle_id: 'com.other' }),
    ]);
    expect(groups.map((group) => group.name)).toEqual(['Tiny Adventures', 'Other']);
    expect(groups[0]!.variants.map((item) => item.id)).toEqual(['and', 'ios']);
    expect(groups[0]!.events).toBe(60);
  });

  it('sums DAU, takes the latest event and the earliest registration, and the first notes', () => {
    const [group] = gameGroups([
      game({ id: 'a', dau_today: 3, dau_yesterday: 1, last_event: '2024-03-01T00:00:00Z', created_at: '2024-02-01T00:00:00Z' }),
      game({ id: 'b', platform: 'ios', dau_today: 4, dau_yesterday: 2, last_event: '2024-03-05T00:00:00Z', created_at: '2024-01-15T00:00:00Z', notes: 'Soft launch' }),
    ]);
    expect(group!.dau_today).toBe(7);
    expect(group!.dau_yesterday).toBe(3);
    expect(group!.last_event).toBe('2024-03-05T00:00:00Z');
    expect(group!.created_at).toBe('2024-01-15T00:00:00Z');
    expect(group!.notes).toBe('Soft launch');
  });

  it('is archived only when every variant is, and the primary is the live one with most events', () => {
    const [mixed] = gameGroups([
      game({ id: 'a', events: 500, archived_at: '2024-03-01T00:00:00Z' }),
      game({ id: 'b', platform: 'ios', events: 5 }),
    ]);
    expect(mixed!.archived).toBe(false);
    expect(mixed!.primary.id).toBe('b');
    const [all] = gameGroups([
      game({ id: 'a', events: 500, archived_at: '2024-03-01T00:00:00Z' }),
      game({ id: 'b', platform: 'ios', events: 5, archived_at: '2024-03-02T00:00:00Z' }),
    ]);
    expect(all!.archived).toBe(true);
    expect(all!.primary.id).toBe('a');
    expect(all!.last_event).toBeNull();
  });
});
