import type { Page } from '@playwright/test';
export { test, expect } from '@playwright/test';

// Synthetic responses keep the browser regression independent of stored games and dates.
export async function installPlayerFixture(page: Page, options: { levelCount?: number } = {}): Promise<void> {
  const at = '2026-10-24T10:00:00Z';
  const game = { id: 'viewer-game', name: 'Viewer test', bundle_id: 'com.example.viewer', platform: 'android', created_at: at, workspace_id: 'test' };
  const players = ['player-one', 'player-two'].map((player) => ({ player, events: 40, sessions: 1, avg_session_seconds: 780, total_play_seconds: 780, first_seen: at, last_seen: at, platform: 'android', app_version: '1.4.2', country: 'GB', environment: 'production', has_user_id: false, metrics: [] }));
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/insights/group-library')) { await route.fulfill({ json: [] }); return; }
    let json: unknown = {};
    if (path === '/v1/me') json = { is_admin: true, can_manage_team: true, workspaces: [{ id: 'test', name: 'Test', role: 'admin' }], email: '', name: 'Test admin', source: 'local' };
    else if (path === '/v1/nutbot') json = { enabled: false, harnesses: [] };
    else if (path === '/v1/overview') json = { games: [game], events: 80, today: 80, dau_today: 2, anonymous_today: 0, active_keys: 1, analytics_thresholds: { levels_min_players: 1, funnels_min_players: 1, retention_min_users: 1 } };
    else if (path.endsWith('/facets')) json = { latest_app_version: '1.4.2', app_version: [{ value: '1.4.2', players: 2 }] };
    else if (path.endsWith('/catalog')) json = { events: [] };
    else if (path.endsWith('/players') && !path.includes('/levels/')) json = { total: 2, players };
    else if (path.endsWith('/levels')) json = { levels: Array.from({ length: options.levelCount ?? 1 }, (_, index) => ({ level: options.levelCount ? index + 1 : 12, started: 2, completed: 0, completion: 0, tries_per_player: 1, fails: 2, restarts: 0, median_seconds: 30, low_sample: false, transition: { available: true, next_level: options.levelCount ? index + 2 : 13, drop_percent: 100, total_drop: 2, left: 2, finished_stopped: 0, kept_going: 0, unknown_progress: 0, net_change: -2 } })), context: { anonymous_events: 0, minimum_players: 1 } };
    else if (path.endsWith('/levels/players')) json = { level: 12, group: 'left', total: 2, offset: 0, counts: { left: 2, finished_stopped: 0, kept_going: 0 }, last_actions: [], players: players.map((p) => ({ player: p.player, tries: 1, fails: 1, completed: false, exit_at: at, exit_event: 'level_fail', last_action: 'Level failed', next_action: 'Menu', last_event: null, session_seconds: 780, last_seen: at, came_back: false, app_version: '1.4.2' })) };
    else if (path.endsWith('/story')) json = { sessions: 1, events: 40, first_seen: at, last_seen: at, total_play_seconds: 780, average_session_seconds: 780, highest_level: 12, info: { device_id: url.searchParams.get('player'), platform: 'android', app_version: '1.4.2', properties: { device_model: 'Pixel 8' } } };
    else if (path.endsWith('/journey')) json = { snapshot: 40, truncated: false, events: Array.from({ length: 40 }, (_, index) => ({ event_id: `event-${index}`, name: index % 2 ? 'level_fail' : 'level_start', client_ts: new Date(Date.parse(at) + index * 20000).toISOString(), session_id: 'session-one', level: 12, params: { level: 12, reason: 'out_of_moves', score: 1200 } })) };
    await route.fulfill({ json });
  });
}
