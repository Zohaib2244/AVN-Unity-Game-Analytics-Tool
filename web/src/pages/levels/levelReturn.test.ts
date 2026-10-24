import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetSpot, leftForLevel, rememberSpot, returnSpot, scrollBackTo } from './levelReturn';

afterEach(() => { forgetSpot('g'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('coming back to the level list', () => {
  it('only returns a place after a level was opened', () => {
    rememberSpot('g', { y: 640, page: 2 });
    expect(returnSpot('g')).toBeNull();
    leftForLevel('g');
    expect(returnSpot('g')).toEqual({ y: 640, page: 2 });
  });
  it('is per game and forgotten once used', () => {
    rememberSpot('g', { y: 10, page: 0 }); leftForLevel('g');
    expect(returnSpot('other')).toBeNull();
    forgetSpot('g');
    expect(returnSpot('g')).toBeNull();
  });
  it('scrolls once the page is tall enough, and as far as it gets when it never is', () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo); vi.stubGlobal('innerHeight', 800);
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 2000 });
    scrollBackTo(900);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: 'instant' });
    scrollTo.mockClear();
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: 1000 });
    scrollBackTo(900, 0);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 200, behavior: 'instant' });
  });
});
