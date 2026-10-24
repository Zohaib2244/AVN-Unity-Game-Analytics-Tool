import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = (name: string) => readFileSync(resolve(process.cwd(), 'src/styles', name), 'utf8');

describe('text on an accent fill', () => {
  it('uses the accent ink, not the accent text colour (which is the same hue as the fill)', () => {
    expect(css('legacy.css')).toMatch(/--badge-text:\s*var\(--accent-ink\)/);
  });
  it('keeps the level view segments as raised chips', () => {
    expect(css('app.css')).toMatch(/\.level-drill \.segmented button\[aria-pressed="true"\][^}]*background:\s*var\(--raise\)/);
  });
});
