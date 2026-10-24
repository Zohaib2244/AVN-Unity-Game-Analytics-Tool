import { describe, expect, it } from 'vitest';
import type { Game } from '@/lib/types';
import { variantFor } from './GameSwitcher';

const game = (id: string, platform: string, archived = false) => ({ id, platform, name: 'Zombie Rush', archived_at: archived ? '2026-10-01' : null }) as unknown as Game;

describe('variantFor', () => {
  const android = game('a', 'android'); const ios = game('i', 'ios');
  it('opens the platform being looked at when the other game has it', () => {
    expect(variantFor({ variants: [android, ios], primary: android }, 'ios')).toBe(ios);
    expect(variantFor({ variants: [android, ios], primary: android }, 'android')).toBe(android);
  });
  it('falls back to the main version when that platform is missing', () => {
    expect(variantFor({ variants: [android], primary: android }, 'ios')).toBe(android);
    expect(variantFor({ variants: [android], primary: android }, undefined)).toBe(android);
  });
  it('prefers a live version over a paused one on the same platform', () => {
    const paused = game('p', 'android', true);
    expect(variantFor({ variants: [paused, android], primary: android }, 'android')).toBe(android);
  });
});
