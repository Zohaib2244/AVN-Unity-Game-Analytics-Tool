// The player's operating system and time zone read the way the old Player information did (insights.js).
import { describe, expect, it } from 'vitest';
import { playerOperatingSystem, playerTimezone, snapshotLabel, snapshotRows, snapshotValue } from './DeviceInfo';

describe('playerOperatingSystem', () => {
  it('reads Android with its API level and build', () => {
    expect(playerOperatingSystem('Android OS 13 / API-33 (TQ3A.230901.001)', 'android')).toEqual({ name: 'Android', version: '13 · API 33', build: 'TQ3A.230901.001' });
  });

  it('reads iOS and macOS versions with their build', () => {
    expect(playerOperatingSystem('iPhone OS 17.2 (21C62)', 'ios')).toEqual({ name: 'iOS', version: '17.2', build: '21C62' });
    expect(playerOperatingSystem('Mac OS X 14.1', 'mac')).toEqual({ name: 'macOS', version: '14.1', build: '' });
  });

  it('falls back to the platform name and the raw value', () => {
    expect(playerOperatingSystem('Something 1.0', 'android')).toEqual({ name: 'Android', version: 'Something 1.0', build: '' });
    expect(playerOperatingSystem(undefined, undefined)).toEqual({ name: '—', version: '', build: '' });
  });
});

describe('playerTimezone', () => {
  it('shows the offset in hours and minutes, with a true minus sign', () => {
    expect(playerTimezone(330)).toBe('UTC+05:30');
    expect(playerTimezone(-210)).toBe('UTC−03:30');
    expect(playerTimezone(0)).toBe('UTC+00:00');
  });

  it('keeps a value it cannot read as a number, and is empty when there is none', () => {
    expect(playerTimezone('Europe/London')).toBe('Europe/London');
    expect(playerTimezone(undefined)).toBe('');
  });
});

describe('game snapshots', () => {
  it('names the standard keys and tidies the rest', () => {
    expect(snapshotLabel('TIER')).toBe('Game tier');
    expect(snapshotLabel('BALANCE_COINS')).toBe('Coins balance');
    expect(snapshotLabel('POWERUP_AUTO_SHOOT')).toBe('Auto shoot owned');
    expect(snapshotLabel('SOMETHING_ELSE')).toBe('Something else');
  });

  it('reads flags as yes or no and memory in MB', () => {
    expect(snapshotValue('ADS_REMOVED', 0)).toBe('No');
    expect(snapshotValue('HAS_PURCHASED', '1')).toBe('Yes');
    expect(snapshotValue('RAM_MB', 3712)).toBe(`${(3712).toLocaleString()} MB`);
    expect(snapshotValue('TIER', 'Mid')).toBe('Mid');
    expect(snapshotValue('TIER', null)).toBe('');
  });

  it('lists the standard keys in their documented order, then balances, powerups and the rest', () => {
    const rows = snapshotRows({ at: '2026-10-04T09:00:00Z', values: { EXTRA: 'x', POWERUP_BOMB: 2, BALANCE_COINS: 340, HIGHEST_LEVEL: 11 } });
    expect(rows.map(([label]) => label)).toEqual(['Highest level', 'Coins balance', 'Bomb owned', 'Extra']);
    expect(snapshotRows(undefined)).toEqual([]);
  });
});
