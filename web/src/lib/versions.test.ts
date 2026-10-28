import { describe, expect, it } from 'vitest';
import { compareVersions, isReleaseVersion, sortVersions } from './versions';

describe('versions', () => {
  it('knows a release number from a stray one', () => {
    expect(['0.0.1', '0.1.0', '12.3.4'].every(isReleaseVersion)).toBe(true);
    expect(['2.3', '1.2.3.4', 'beta', '1.0.0-rc1', ''].some(isReleaseVersion)).toBe(false);
  });
  it('orders 0.0.1 … 0.0.9, 0.0.10, 0.1.0, 0.1.2, 0.2.0 by number, not text', () => {
    const shuffled = ['0.2.0', '0.0.10', '0.1.2', '0.0.9', '0.1.0', '0.0.2', '0.0.1'];
    expect(sortVersions(shuffled)).toEqual(['0.0.1', '0.0.2', '0.0.9', '0.0.10', '0.1.0', '0.1.2', '0.2.0']);
  });
  it('puts versions that are not x.y.z after the numbered ones', () => {
    expect(sortVersions(['2.3', '0.1.0', 'dev', '0.0.9'])).toEqual(['0.0.9', '0.1.0', '2.3', 'dev']);
    expect(compareVersions('1.2', '1.2.0')).not.toBe(NaN);
  });
});
