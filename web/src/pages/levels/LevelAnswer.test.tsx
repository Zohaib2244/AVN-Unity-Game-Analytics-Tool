import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LevelOutlier } from '@/lib/types';
import { LevelAnswer } from './LevelSummary';

const outlier = (level: number, value: number): LevelOutlier => ({
  level, attempts: 400, players: 120, fail_rate: value, stop_share: 0.05,
  reasons: [{ metric: 'fail_rate', count: 300, value, expected: 0.1, excess: value - 0.1, words: `${Math.round(value * 100)}% of finished tries fail; levels around it about 10%`, short: 'fail' }],
});

describe('LevelAnswer: levels harder than nearby', () => {
  it('names the most surprising level with its count first and jumps to it', () => {
    const onJump = vi.fn();
    render(<LevelAnswer levels={[]} minimum={20} excludeReturners={false} outliers={[outlier(7, 0.45), outlier(19, 0.3)]} onJump={onJump} />);
    const chip = screen.getByRole('button', { name: /Fails far more than nearby/ });
    expect(chip.textContent).toContain('Level 7');
    expect(chip.textContent).toContain('300 · 45.0%');
    expect(chip.textContent).not.toContain('Level 19');
    expect(chip.getAttribute('title')).toContain('45% of finished tries fail; levels around it about 10% (failed tries)');
    fireEvent.click(chip);
    expect(onJump).toHaveBeenCalledWith(7);
  });
  it('shows nothing without outliers', () => {
    render(<LevelAnswer levels={[]} minimum={20} excludeReturners={false} onJump={() => undefined} />);
    expect(screen.queryByRole('button', { name: /far more than nearby/ })).toBeNull();
  });
});
