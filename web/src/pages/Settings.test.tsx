import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Appearance } from './Settings';

afterEach(() => { cleanup(); document.documentElement.removeAttribute('data-palette'); document.documentElement.removeAttribute('data-theme'); });

describe('Appearance', () => {
  it('sets data-palette on <html> and presses the chosen swatch', async () => {
    const user = userEvent.setup();
    render(<Appearance />);
    expect(screen.getByRole('button', { name: 'nutmeg' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'slate' }));
    expect(document.documentElement.getAttribute('data-palette')).toBe('slate');
    expect(screen.getByRole('button', { name: 'slate' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'nutmeg' })).toHaveAttribute('aria-pressed', 'false');
    // nutmeg is the default: choosing it clears the attribute.
    await user.click(screen.getByRole('button', { name: 'nutmeg' }));
    expect(document.documentElement.hasAttribute('data-palette')).toBe(false);
  });

  it('switches the theme', async () => {
    const user = userEvent.setup();
    render(<Appearance />);
    await user.click(screen.getByRole('button', { name: 'light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(screen.getByRole('button', { name: 'light' })).toHaveAttribute('aria-pressed', 'true');
  });
});
