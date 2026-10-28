import { describe, expect, it } from 'vitest';
import { newestFirst } from './VersionData';

const row = (app_version: string) => ({ app_version, events: 1, players: 1, first_seen: null, last_seen: null });

describe('newestFirst', () => {
  it('puts the newest x.y.z first and odd versions last', () => {
    expect(newestFirst(['0.0.9', '2.3', '0.1.0', '0.0.10'].map(row)).map((r) => r.app_version)).toEqual(['0.1.0', '0.0.10', '0.0.9', '2.3']);
  });
});
