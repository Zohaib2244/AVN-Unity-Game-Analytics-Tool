import { render, screen, fireEvent } from '@testing-library/react';
import { Markdown } from './markdown';

describe('nbMarkdown → React', () => {
  it('renders bold, italics and inline code without putting text in as HTML', () => {
    const { container } = render(<Markdown source={'Level **12** is *slow*: `level_complete` <b>x</b>'} />);
    expect(container.querySelector('strong')?.textContent).toBe('12');
    expect(container.querySelector('em')?.textContent).toBe('slow');
    expect(container.querySelector('code')?.textContent).toBe('level_complete');
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
  });
  it('renders headings, bullet and numbered lists, fenced code and tables', () => {
    const source = '## Findings\n- first\n- second\n1. one\n2) two\n```\nraw < code\n```\n| Level | Players |\n|---|---|\n| 1 | 120 |\n| 2 | 80 |\nA paragraph\nthat continues';
    const { container } = render(<Markdown source={source} />);
    expect(container.querySelector('h4')?.textContent).toBe('Findings');
    expect([...container.querySelectorAll('ul li')].map((li) => li.textContent)).toEqual(['first', 'second']);
    expect([...container.querySelectorAll('ol li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect(container.querySelector('pre code')?.textContent).toBe('raw < code');
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Level', 'Players']);
    expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(container.querySelector('p')?.textContent).toBe('A paragraph that continues');
  });
  it('links to internal pages through the router callback and opens other links in a new tab', () => {
    const onOpen = vi.fn();
    render(<Markdown source={'See [level 12](/games/g1/levels) and [the docs](https://example.com/x) and [nope](javascript:alert(1))'} onOpen={onOpen} />);
    const internal = screen.getByRole('link', { name: 'level 12' });
    expect(internal).toHaveAttribute('href', '/games/g1/levels');
    fireEvent.click(internal);
    expect(onOpen).toHaveBeenCalledWith('/games/g1/levels');
    const external = screen.getByRole('link', { name: 'the docs' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noreferrer');
    expect(screen.queryByRole('link', { name: 'nope' })).toBeNull();
    expect(screen.getByText(/nope/)).toBeInTheDocument();
  });
});
