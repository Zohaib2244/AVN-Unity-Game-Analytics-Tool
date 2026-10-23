import { describe, expect, it } from 'vitest';
import { addDays, countryText, daysBetween, duration, fileSize, monthEnd, number, relativeTime, shiftMonth } from './format';

describe('format', () => {
  it('relative time reads like a person', () => {
    const now = Date.now();
    expect(relativeTime(now - 10000)).toBe('just now');
    expect(relativeTime(now - 5 * 60000)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3600000)).toBe('3 h ago');
    expect(relativeTime(now - 2 * 86400000)).toBe('2 d ago');
  });
  it('days arithmetic is calendar-safe', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(shiftMonth('2026-01-31', 1)).toBe('2026-02-01');
  });
  it('sizes, durations and countries', () => {
    expect(fileSize(1500)).toBe('1 KB');
    expect(fileSize(2.5 * 1048576)).toBe('2.5 MB');
    expect(duration(59)).toBe('59s');
    expect(duration(61)).toBe('1m 01s');
    expect(duration(3700)).toBe('1h 01m');
    expect(duration(null)).toBe('—');
    expect(number(1234567)).toBe('1,234,567');
    expect(countryText('XX')).toBe('Unknown country (XX)');
    expect(countryText(null)).toBe('—');
  });
});
