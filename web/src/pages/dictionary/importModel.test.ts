import { describe, expect, it } from 'vitest';
import { IMPORT_DEFAULTS, coverageChoice, defaultSelection, importField, importList, importMerge, previewDrifted, readOptions, textKey } from './importModel';
import type { ImportPreview } from '@/lib/types';

describe('importList', () => {
  it('splits on lines and commas, trims and drops blanks', () => {
    expect(importList('a, b\n c \n\n,d')).toEqual(['a', 'b', 'c', 'd']);
    expect(importList(null)).toEqual([]);
    expect(importList(undefined)).toEqual([]);
  });
});

describe('importField', () => {
  it('names the field for a person', () => {
    expect(importField('description')).toBe('description');
    expect(importField('param:level')).toBe('parameter level');
  });
});

describe('importMerge', () => {
  it('lays remembered options over the defaults one level deep and leaves the defaults alone', () => {
    const merged = importMerge(IMPORT_DEFAULTS, { mode: 'overwrite_all', scope: { events: 'all' }, style: { language: 'German' }, unknown: 1 });
    expect(merged.mode).toBe('overwrite_all');
    expect(merged.scope).toEqual({ ...IMPORT_DEFAULTS.scope, events: 'all' });
    expect(merged.style.language).toBe('German');
    expect(merged.style.tone).toBe('concise');
    expect('unknown' in merged).toBe(false);
    expect(IMPORT_DEFAULTS.scope.events).toBe('undocumented');
  });
  it('replaces arrays whole and ignores nothing saved', () => {
    expect(importMerge(IMPORT_DEFAULTS, { fields: ['params'] }).fields).toEqual(['params']);
    expect(importMerge(IMPORT_DEFAULTS, null)).toEqual(IMPORT_DEFAULTS);
  });
});

describe('coverageChoice', () => {
  it('recognises the two presets', () => {
    expect(coverageChoice(IMPORT_DEFAULTS)).toBe('missing');
    expect(coverageChoice({ mode: 'overwrite_all', scope: { ...IMPORT_DEFAULTS.scope, events: 'all' } })).toBe('all');
    expect(coverageChoice({ mode: 'overwrite_all', scope: { ...IMPORT_DEFAULTS.scope, events: 'listed' } })).toBe('');
  });
});

describe('readOptions', () => {
  it('turns the form into options, splitting listed names from prefixes', () => {
    const data = new FormData();
    data.set('mode', 'fill_blanks'); data.set('field-params', 'on'); data.set('events', 'listed'); data.set('names', 'LEVEL_*\nSHOP\n*');
    data.set('language', ' '); data.set('tone', 'detailed'); data.set('max_overwrites', '-3'); data.set('type_conflicts', 'on');
    const options = readOptions(data);
    expect(options.fields).toEqual(['params']);
    expect(options.scope.names).toEqual(['SHOP']);
    expect(options.scope.prefixes).toEqual(['LEVEL_']);
    expect(options.style.language).toBe('English');
    expect(options.max_overwrites).toBe(0);
    expect(options.type_conflicts).toBe('flag');
    expect(options.scope.seen_within_days).toBeNull();
  });
});

const preview = (): ImportPreview => ({
  events: [
    { name: 'SHOP', changes: [{ name: 'SHOP', field: 'description', before: '', after: 'Opens the shop', kind: 'fill' }], rejected: [], skipped: [], flags: [] },
    { name: 'shop', changes: [{ name: 'shop', field: 'description', before: '', after: 'dup', kind: 'fill' }], rejected: [], skipped: [], flags: [{ flag: 'near_duplicate', similar: ['SHOP'] }] },
  ],
  options: IMPORT_DEFAULTS, unresolved: [], not_found_in_code: [], summary: { skipped: 0, flags: 1 },
});

describe('defaultSelection', () => {
  it('ticks everything but near duplicates', () => {
    expect([...defaultSelection(preview())]).toEqual(['SHOP/description']);
  });
});

describe('previewDrifted', () => {
  it('notices a text that changed or went away since the review', () => {
    const shown = preview().events.flatMap((entry) => entry.changes);
    const keys = new Set([textKey(shown[0]!)]);
    expect(previewDrifted(shown, [shown[0]!], keys)).toBe(false);
    expect(previewDrifted(shown, [{ ...shown[0]!, after: 'Other' }], keys)).toBe(true);
    expect(previewDrifted(shown, [], keys)).toBe(true);
  });
});
