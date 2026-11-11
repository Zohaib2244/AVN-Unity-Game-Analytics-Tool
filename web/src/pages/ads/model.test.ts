import { describe, expect, it } from 'vitest';
import type { AdCreatives, AdDelivery, AdRevenue } from '@/lib/types';
import { deliveryRows, looks, words } from './model';

const delivery: AdDelivery = {
  available: true,
  serving: { available: true, groups: [
    { value: 'Interstitial', wanted: 1000, shown: 700, shown_share: 0.7, blocked: 100, blocked_by: { Cooldown: 100 }, failed: 200, failed_by: { NotReady: 200 }, closed: 650, with_revenue: 600, reward_given_share: null, average_seconds_on_screen: 30 },
    { value: 'AppOpen', wanted: 50, shown: 50, shown_share: 1, blocked: 0, blocked_by: {}, failed: 0, failed_by: {}, closed: 50, with_revenue: 50, reward_given_share: null, average_seconds_on_screen: 10 },
  ] },
  health: { available: true, groups: [
    { value: 'Interstitial', players: 10, loaded: 90, load_failed: 10, load_success_rate: 0.9, not_ready: 0, show_calls: 0, show_calls_failed: 0, impressions: 0 },
    { value: 'AppOpen', players: 10, loaded: 35, load_failed: 65, load_success_rate: 0.35, not_ready: 0, show_calls: 0, show_calls_failed: 0, impressions: 0 },
    { value: 'Banner', players: 10, loaded: 80, load_failed: 20, load_success_rate: 0.8, not_ready: 0, show_calls: 0, show_calls_failed: 0, impressions: 5000 },
  ], last_load_errors: [{ error: 'App-open slot 0 load failed: No ads meet eCPM floor', format: 'AppOpen', snapshots: 3, players: 2 }] },
  load_times: { Interstitial: { loads: 5, median_ms: 1800, p90_ms: 4000 } }, load_times_sent: true, load_failures: [],
};
const revenue = (groups: Array<[string, number, number]>): AdRevenue => ({
  available: true, full_screen: { impressions: 1, revenue: 1, ecpm: 1, players_paid_for: 1 }, banner: { impressions: 0, revenue: 0, ecpm: null },
  total_revenue: 1, active_players: 1, revenue_per_active_player: 1, arpdau: 1, ads_shown: 100, ads_shown_with_revenue_reported: 80, share_of_shows_with_revenue: 0.8,
  group_by: 'network', groups: groups.map(([value, impressions, ecpm]) => ({ value, impressions, revenue: (impressions * ecpm) / 1000, ecpm, players: 1, share_of_full_screen_revenue: null })),
});

describe('Ads page model', () => {
  it('names formats and placements in words', () => {
    expect(words('AppOpen')).toBe('App open');
    expect(words('level_complete_x2')).toBe('Level complete x2');
    expect(words(null)).toBe('Not named');
  });

  it('joins serving, health and load times into one row per format, banners shown by impressions', () => {
    const rows = deliveryRows(delivery);
    expect(rows.map((row) => row.format)).toEqual(['Interstitial', 'AppOpen', 'Banner']);
    expect(rows[0]).toMatchObject({ loadsWorked: 0.9, loadMedianMs: 1800, wanted: 1000, heldByRules: 100, noAdReady: 200, shownOfWanted: 0.7 });
    expect(rows[2]).toMatchObject({ format: 'Banner', wanted: null, shown: 5000, loadMedianMs: null });
  });

  it('puts failing loads first, then lost ads, cheap networks, missing revenue and creatives', () => {
    const creatives: AdCreatives = { available: true, usual_share: 0.1, rows: [{ creative: 'c1', network: 'Unity Ads', format: 'Interstitial', shown: 50, players: 40, left_after: 20, left_share: 0.4 }] };
    const found = looks(delivery, revenue([['AppLovin', 500, 30], ['Unity', 500, 24], ['Pangle', 800, 3.8]]), revenue([]), creatives);
    expect(found.map((item) => item.tag)).toEqual(['Loading', 'Lost', 'Network', 'Data', 'Creative']);
    expect(found[0]!.title).toBe('App open fails to load 65.0% of the time');
    expect(found[0]!.note).toContain('No ads meet eCPM floor');
    expect(found[2]!.title).toContain('Pangle');
  });
});
