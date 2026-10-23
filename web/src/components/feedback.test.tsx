import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DEFINITIONS, DefinedLabel, LoadError } from './feedback';
import { ApiError } from '@/api/client';

describe('definitions', () => {
  it('every key-number label the pages draw says how it is counted', () => {
    for (const label of ['Players', 'Sessions', 'Daily active', 'Stickiness', 'Levels seen', 'Conversion']) expect(DEFINITIONS[label]![0].length).toBeGreaterThan(20);
  });
  it('a label with a definition becomes a focusable dotted term; one without stays plain text', () => {
    render(<><DefinedLabel label="Players" /><DefinedLabel label="Something else" /></>);
    expect(screen.getByText('Players')).toHaveClass('def');
    expect(screen.getByText('Players')).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('Something else').closest('.def')).toBeNull();
  });
});

describe('LoadError', () => {
  it('offers a retry, a reload for an expired session, and nothing for a forbidden read', () => {
    const { rerender } = render(<LoadError error={new ApiError('Boom', 500)} onRetry={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('Try again');
    rerender(<LoadError error={new ApiError('Expired', 401)} />);
    expect(screen.getByRole('button')).toHaveTextContent('Reload page');
    rerender(<LoadError error={new ApiError('No', 403)} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
