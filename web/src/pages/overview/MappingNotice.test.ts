import { describe, expect, it } from 'vitest';
import { mappingIssueText, mappingNoticeShown, mappingSignature, type MappingIssue, type MappingStatus } from './MappingNotice';

const missing: MappingIssue = { kind: 'missing', concept: 'level_started', label: 'Level started', used_by: ['Levels', 'Retention'] };
const silent: MappingIssue = { kind: 'silent', concept: 'level_completed', label: 'Level completed', used_by: ['Levels'], event: 'stage_clear' };

describe('mappingIssueText', () => {
  it('says what a missing concept blocks', () => {
    expect(mappingIssueText(missing)).toBe('Level started is not mapped to any of your events, so Levels, Retention cannot read it.');
  });
  it('says which rule matches nothing', () => {
    expect(mappingIssueText(silent)).toBe('stage_clear is mapped to Level completed, but no event your game sent matches that rule.');
  });
});

describe('mappingSignature', () => {
  it('is the same whatever the order of the issues', () => {
    expect(mappingSignature({ issues: [silent, missing] })).toBe(mappingSignature({ issues: [missing, silent] }));
    expect(mappingSignature({ issues: [missing, silent] })).toBe('missing:level_started:|silent:level_completed:stage_clear');
  });
});

describe('mappingNoticeShown', () => {
  const status: MappingStatus = { ok: false, has_events: true, issues: [missing] };
  it('shows while there are issues that were not dismissed', () => {
    expect(mappingNoticeShown(status, null)).toBe(true);
    expect(mappingNoticeShown(status, 'something else')).toBe(true);
  });
  it('stays dismissed until the problems change', () => {
    expect(mappingNoticeShown(status, mappingSignature(status))).toBe(false);
    expect(mappingNoticeShown({ ...status, issues: [missing, silent] }, mappingSignature(status))).toBe(true);
  });
  it('is silent without events or issues', () => {
    expect(mappingNoticeShown({ ok: true, has_events: true, issues: [] }, null)).toBe(false);
    expect(mappingNoticeShown({ ok: false, has_events: false, issues: [missing] }, null)).toBe(false);
    expect(mappingNoticeShown(undefined, null)).toBe(false);
  });
});
