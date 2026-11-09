import { describe, expect, it } from 'vitest';
import type { Game, WorkspaceItem } from '@/lib/types';
import { connectOptions, scopeText } from './AgentAccess';


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

describe('connectOptions', () => {
  const key = { endpoint: 'https://data.example.org/mcp', secret: 'avn_mcp_abc', link: null as string | null };
  it('sends the key in the Authorization header for the agents that can', () => {
    const [claude, codex, json] = connectOptions(key);
    expect(claude!.text).toBe('claude mcp add --transport http avn-analytics https://data.example.org/mcp --header "Authorization: Bearer avn_mcp_abc"');
    expect(codex!.text).toContain('url = "https://data.example.org/mcp"');
    expect(codex!.text).toContain('Authorization = "Bearer avn_mcp_abc"');
    expect(JSON.parse(json!.text).mcpServers['avn-analytics'].headers.Authorization).toBe('Bearer avn_mcp_abc');
  });
  it('offers the link only when the key allows it', () => {
    expect(connectOptions(key)[3]!.text).toBe('');
    expect(connectOptions(key)[3]!.where).toMatch(/allow the link/);
    expect(connectOptions({ ...key, link: 'https://data.example.org/mcp/avn_mcp_abc' })[3]!.text).toBe('https://data.example.org/mcp/avn_mcp_abc');
  });
});
