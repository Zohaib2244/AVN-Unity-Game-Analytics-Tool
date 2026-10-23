import { describe, expect, it } from 'vitest';
import { customBody, editorModel, prefillModel, selectedVersion, standardQuery, statusPath, tiersFrom, upperSnake, versionAfterPick, versionsNote } from './customEvents';
import type { CustomEvent, StandardVersion } from '@/lib/types';

describe('upperSnake', () => {
  it('makes an event name UPPER_SNAKE as the editor types it', () => {
    expect(upperSnake('shop item')).toBe('SHOP_ITEM');
    expect(upperSnake('level-2 ok!')).toBe('LEVEL2_OK');
  });
});

describe('tiersFrom', () => {
  it('uses core and standard when nothing is remembered, and always keeps core', () => {
    expect(tiersFrom(null)).toEqual(['core', 'standard']);
    expect(tiersFrom(['extended'])).toEqual(['core', 'extended']);
    expect(tiersFrom(['standard', 'unknown'])).toEqual(['core', 'standard']);
  });
});

describe('standardQuery', () => {
  it('adds the custom tier only when a custom event is not core', () => {
    expect(standardQuery(['core', 'standard'], false)).toBe('tiers=core&tiers=standard');
    expect(standardQuery(['core'], true)).toBe('tiers=core&tiers=custom');
  });
});

describe('statusPath and versions', () => {
  it('asks for the version and newer flag when a version is chosen', () => {
    expect(statusPath('g1', { version: '@latest', newer: true })).toBe('/v1/games/g1/standard?version=%40latest&newer=true');
    expect(statusPath('g1', { version: '', newer: false })).toBe('/v1/games/g1/standard');
  });
  const versions: StandardVersion[] = [
    { version: '1.5.0', players: 0, last_seen: '' },
    { version: '1.4.2', players: 12, last_seen: '' },
  ];
  it('shows the newest version with players as selected for @latest', () => {
    expect(selectedVersion(versions, { version: '@latest', newer: true })).toBe('1.4.2');
    expect(selectedVersion(versions, { version: '1.5.0', newer: false })).toBe('1.5.0');
  });
  it('follows the newest when the newest is picked', () => {
    expect(versionAfterPick(versions, '1.4.2')).toBe('@latest');
    expect(versionAfterPick(versions, '1.5.0')).toBe('1.5.0');
    expect(versionAfterPick(versions, '')).toBe('');
  });
  it('names the first three versions and counts the rest', () => {
    expect(versionsNote(['1', '2'])).toBe('1, 2');
    expect(versionsNote(['1', '2', '3', '4', '5'])).toBe('1, 2, 3 +2');
    expect(versionsNote([])).toBe('');
  });
});

describe('editor model and body', () => {
  const event: CustomEvent = {
    name: 'SHOP', purpose: 'The player opens the shop', tier: 'custom',
    states: [{ name: 'Opened', trigger: 'Shop shown', params: [{ key: 'SOURCE', type: 'string', required: true, note: 'where', values: ['home', 'level'] }] }],
  };
  it('shows allowed values comma separated and turns them back into a list', () => {
    const model = editorModel(event);
    expect(model.states[0]!.params[0]!.values).toBe('home, level');
    const body = customBody(model);
    expect(body.states[0]!.params[0]!.values).toEqual(['home', 'level']);
    expect(body.purpose).toBe('The player opens the shop');
  });
  it('starts a new event with one blank state', () => {
    expect(editorModel(null).states).toHaveLength(1);
  });
  it('drops empty values and trims the trigger and note', () => {
    const model = editorModel(null);
    model.states[0]!.trigger = '  shown  ';
    model.states[0]!.params = [{ key: 'K', type: 'int', required: false, note: ' n ', values: ' a, , b ,' }];
    const body = customBody(model);
    expect(body.states[0]!.trigger).toBe('shown');
    expect(body.states[0]!.params[0]).toEqual({ key: 'K', type: 'int', required: false, note: 'n', values: ['a', 'b'] });
  });
  it('starts from what a game sent', () => {
    const model = prefillModel({ name: 'LEVEL_SKIP', events: 3, last_seen: '', versions: [], valid_name: true, states: [{ name: 'Skipped', params: [{ key: 'LEVEL', type: 'int', required: true }] }] });
    expect(model.name).toBe('LEVEL_SKIP');
    expect(model.states[0]!.params[0]).toEqual({ key: 'LEVEL', type: 'int', required: true, note: '', values: '' });
    expect(prefillModel({ name: 'X', events: 1, last_seen: '', versions: [], valid_name: true, states: [] }).states).toHaveLength(1);
  });
});
