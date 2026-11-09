import { describe, expect, it } from 'vitest';
import type { Game, WorkspaceItem } from '@/lib/types';
import { render, screen } from '@testing-library/react';
import { StepText, connectGuides, maskSecret, scopeText } from './AgentAccess';


const workspaces = [{ id: 'w1', name: 'Work', games: 3, members: 1, nutbot_access: 'leads' }, { id: 'w2', name: 'Other', games: 1, members: 1, nutbot_access: 'leads' }] as WorkspaceItem[];
const game = (id: string, name: string, workspace_id: string) => ({ id, name, workspace_id, platform: 'android', bundle_id: id, created_at: '' }) as Game;
const games = [game('g1', 'Disc Smash', 'w1'), game('g2', 'Zombie Rush', 'w1'), game('g3', 'Sand Smash', 'w1'), game('g4', 'Soccer Kick', 'w2')];

describe('scopeText', () => {
  it('names whole workspaces and single games in plain words', () => {
    expect(scopeText({ workspace_ids: ['w1'], game_ids: [] }, workspaces, games)).toBe('All of Work');
    expect(scopeText({ workspace_ids: [], game_ids: ['g1'] }, workspaces, games)).toBe('Disc Smash · Android');
    expect(scopeText({ workspace_ids: [], game_ids: ['g1', 'g2', 'g4'] }, workspaces, games)).toBe('3 games');
  });
  it('does not list a game twice when its whole workspace is already in', () => {
    expect(scopeText({ workspace_ids: ['w1'], game_ids: ['g1', 'g4'] }, workspaces, games)).toBe('All of Work + Soccer Kick · Android');
  });
  it('copes with things that were deleted', () => {
    expect(scopeText({ workspace_ids: ['gone'], game_ids: ['gone'] }, workspaces, games)).toBe('All of a removed workspace');
    expect(scopeText({ workspace_ids: [], game_ids: [] }, workspaces, games)).toBe('Nothing');
  });
});

describe('connectGuides', () => {
  const secret = 'avn_mcp_abcdefghijklmnopqrstuvwxyz';
  const key = { endpoint: 'https://data.example.org/mcp', secret, link: null as string | null };
  const fields = (guide: ReturnType<typeof connectGuides>[number]) => Object.fromEntries(guide.steps.flatMap((step) => step.fields ?? []).map((field) => [field.label, field]));

  it('offers only the Claude app and ChatGPT', () => {
    expect(connectGuides(key).map((guide) => guide.label)).toEqual(['Claude app', 'ChatGPT']);
  });

  it('gives the Claude app the URL and the key as separate fields, the key in a header', () => {
    const [claude] = connectGuides(key);
    const given = fields(claude!);
    expect(given['Remote MCP server URL']!.value).toBe('https://data.example.org/mcp');
    expect(given['Header name']!.value).toBe('Authorization');
    expect(given['Header value']).toEqual({ label: 'Header value', value: `Bearer ${secret}`, secret: true });
    expect(given['Name']!.value).toBe('AVN Analytics');
    expect(claude!.needsLink).toBe(false);
    expect(claude!.steps.some((step) => step.text.includes('No sign-in'))).toBe(true);
  });

  it('asks for the link before giving ChatGPT any steps to paste', () => {
    expect(connectGuides(key)[1]!.needsLink).toBe(true);
    const chatgpt = connectGuides({ ...key, link: `https://data.example.org/mcp/${secret}` })[1]!;
    expect(chatgpt.needsLink).toBe(false);
    expect(fields(chatgpt)['Server URL']).toEqual({ label: 'Server URL', value: `https://data.example.org/mcp/${secret}`, secret: true });
    expect(chatgpt.steps.some((step) => step.text.includes('No authentication'))).toBe(true);
  });
});

describe('maskSecret', () => {
  const secret = 'avn_mcp_WzIj8C8LNO93VeamIWOjVObnGTfk';
  it('shows only the start and end of the key wherever it sits', () => {
    expect(maskSecret(`Bearer ${secret}`, secret)).toBe('Bearer avn_mcp_WzIj…GTfk');
    expect(maskSecret(`https://x.org/mcp/${secret}`, secret)).toBe('https://x.org/mcp/avn_mcp_WzIj…GTfk');
    expect(maskSecret('Authorization', secret)).toBe('Authorization');
  });
});

describe('StepText', () => {
  it('puts the app’s own labels in bold and keeps the rest as text', () => {
    render(<StepText text="Under **Authentication**, choose **No sign-in**." />);
    expect(screen.getByText('Authentication').tagName).toBe('STRONG');
    expect(screen.getByText('No sign-in').tagName).toBe('STRONG');
    expect(screen.getByText(/Under/).textContent).toBe('Under Authentication, choose No sign-in.');
  });
});
