import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('draws the tile, frame and glyph as classes, so the theme colours them (no fixed colours in the markup)', () => {
    const { container } = render(<BrandMark size={24} className="boot-mark" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveClass('brand-mark', 'boot-mark');
    expect(svg.getAttribute('width')).toBe('24');
    for (const part of ['.bm-tile', '.bm-frame', '.bm-glyph']) expect(svg.querySelector(part)).not.toBeNull();
    expect(svg.innerHTML).not.toMatch(/fill="#/);
  });
});
