import { describe, expect, it } from 'vitest';
import { standardNoticeShown, standardSignature } from './StandardNotice';
import { standardSource } from './AddEvents';

describe('the Update standard notice', () => {
  const old = { game_version: 4, workspace_version: 5, outdated: true };
  it('shows for an outdated game until that pair of versions is dismissed', () => {
    expect(standardNoticeShown(old, null)).toBe(true);
    expect(standardNoticeShown(old, standardSignature(old))).toBe(false);
    expect(standardNoticeShown({ ...old, workspace_version: 6 }, standardSignature(old))).toBe(true);
    expect(standardNoticeShown({ ...old, outdated: false }, null)).toBe(false);
  });
});

describe('standardSource', () => {
  it('says where the standard comes from', () => {
    expect(standardSource({ version: 5, source: 'builtin', uploaded_at: null, uploaded_by: null })).toBe('Version 5 · built in');
    expect(standardSource({ version: 6, source: 'uploaded', uploaded_at: null, uploaded_by: 'zo' })).toMatch(/^Version 6 · uploaded by zo/);
  });
});
