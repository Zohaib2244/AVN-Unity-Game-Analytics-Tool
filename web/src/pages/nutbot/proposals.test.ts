import { applyMode, applyProposal, decisionFor, loadDecisions, proposalKey, proposalPage, rememberDecision, savesReport } from './proposals';
import type { Game, NutBotProposal } from '@/lib/types';

const game = { id: 'g1', name: 'Test', platform: 'android' } as unknown as Game;
const proposal = (kind: NutBotProposal['kind'], payload: Record<string, unknown>): NutBotProposal => ({ type: 'proposal', kind, title: 'T', why: '', game_id: 'g1', payload, plain: [] });

describe('NutBot proposals', () => {
  beforeEach(() => localStorage.clear());

  it('writes rules into the Players view and puts the old one back on undo', async () => {
    localStorage.setItem('avn-players-view-g1', JSON.stringify({ sort: 'events', order: 'asc', conditions: [], metrics: [], fold: { a: true } }));
    const pushed: string[] = [];
    const listener = (event: Event) => pushed.push((event as CustomEvent<string>).detail);
    window.addEventListener('avn-store-pushed', listener);
    const done = await applyProposal(game, proposal('players', { sort: 'metric0', order: 'desc', conditions: [{ event: 'x' }], metrics: [{ event: 'x', agg: 'count' }] }));
    const view = JSON.parse(localStorage.getItem('avn-players-view-g1')!);
    expect(view).toMatchObject({ sort: 'metric0', conditions: [{ event: 'x' }], fold: { a: true } });
    expect(pushed).toContain('avn-players-view-g1');
    await done.undo();
    expect(JSON.parse(localStorage.getItem('avn-players-view-g1')!)).toMatchObject({ sort: 'events', order: 'asc' });
    window.removeEventListener('avn-store-pushed', listener);
  });

  it('sets the level table and names a stable key and page per kind', async () => {
    await applyProposal(game, proposal('levels', { sort: 'drop', scope: 'first_session' }));
    expect(JSON.parse(localStorage.getItem('avn-level-nav-g1')!)).toMatchObject({ sort: 'drop', scope: 'first_session', pageSize: '50' });
    expect(proposalPage(proposal('highlight', {}))).toBe('players');
    expect(proposalKey(proposal('levels', { a: 1 }))).toBe('levels:T:{"a":1}');
  });

  it('opens a player-group comparison and can save it to the library', async () => {
    const definition = { start: '2026-10-01', end: '2026-10-05', filters: { environments: [], app_versions: ['1.2'], builds: [], countries: [], platforms: [], exclude_environments: [] }, timezone_offset_minutes: 0, entry_level: 1, exclude_players: [], exclude_events: [], behavior: { kind: 'level_duration', level: 1, event: null, parameter: '', window_minutes: 10, comparison: 'number', split: 90, value: '' }, outcome: { kind: 'level', level: 3, event: null, window_hours: 24 }, window_hours: 24, range_preset: 'custom', version_mode: 'custom', timezone: 'utc', hide_test: true };
    const done = await applyProposal(game, proposal('groups', { item: { name: 'Fast', kind: 'check', definition }, save: false }));
    const run = JSON.parse(localStorage.getItem('avn-player-groups-run-g1')!);
    expect(run).toMatchObject({ kind: 'level_duration', level: '1', split: '90', outcomeLevel: '3' });
    expect(done.search).toEqual({ view: 'groups' });
    await done.undo();
    expect(JSON.parse(localStorage.getItem('avn-player-groups-run-g1')!)).toBeNull();
  });

  it('applies itself only when chosen', () => {
    expect(applyMode()).toBe('ask');
    localStorage.setItem('avn-nutbot-apply', JSON.stringify('auto'));
    expect(applyMode()).toBe('auto');
  });

  it('saves a report only when applied, tied to its chat, and Undo deletes it', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'r1' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }));
    const card = proposal('report', { title: 'Exits', body: 'Level 3.', headline: { title: 'Top exit', value: 'Level 3' } });
    expect(savesReport(card)).toBe(true);
    expect(savesReport(proposal('funnel', {}))).toBe(false);
    const done = await applyProposal(game, card, 'c1');
    expect(calls[0]).toMatchObject({ url: '/v1/games/g1/nutbot/reports', init: { method: 'POST' } });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ title: 'Exits', body: 'Level 3.', headline: { title: 'Top exit', value: 'Level 3' }, chat_id: 'c1' });
    await done.undo();
    expect(calls.at(-1)).toMatchObject({ url: '/v1/games/g1/nutbot/reports/r1', init: { method: 'DELETE' } });
    vi.unstubAllGlobals();
  });

  it('remembers a decision per game and chat, and forgets it on undo', () => {
    const card = proposal('levels', { sort: 'drop' });
    rememberDecision('g1', 'c1', card, 'declined');
    expect(decisionFor(loadDecisions('g1'), 'c1', card)).toBe('declined');
    expect(decisionFor(loadDecisions('g1'), 'c2', card)).toBeUndefined();
    expect(decisionFor(loadDecisions('g2'), 'c1', card)).toBeUndefined();
    expect(decisionFor(loadDecisions('g1'), 'c1', proposal('levels', { sort: 'level' }))).toBeUndefined();
    rememberDecision('g1', 'c1', card);
    expect(decisionFor(loadDecisions('g1'), 'c1', card)).toBeUndefined();
  });

  it('keeps only the newest decisions', () => {
    for (let index = 0; index < 305; index++) rememberDecision('g1', 'c1', proposal('levels', { index }), 'declined');
    const decisions = loadDecisions('g1');
    expect(Object.keys(decisions)).toHaveLength(300);
    expect(decisionFor(decisions, 'c1', proposal('levels', { index: 0 }))).toBeUndefined();
    expect(decisionFor(decisions, 'c1', proposal('levels', { index: 304 }))).toBe('declined');
  });
});
