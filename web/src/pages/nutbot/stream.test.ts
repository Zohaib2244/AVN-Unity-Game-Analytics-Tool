import { applyEvent, contextShare, emptyAnswer, fromStoredMessages, settle, toolLabel } from './stream';
import type { NutBotEvent } from '@/lib/types';

describe('streamed answer', () => {
  it('folds the events of one answer into the message, matching tool results by id', () => {
    const answer = emptyAnswer('Same filters as the page');
    const events: NutBotEvent[] = [
      { type: 'chat', id: 'c1', title: 'hi', harness: 'claude' },
      { type: 'notice', text: 'Claude has used 91% of its week allowance.' },
      { type: 'tool', id: 't1', name: 'get_context' },
      { type: 'tool', id: 't2', name: 'run_funnel' },
      { type: 'tool_result', id: 't1', ok: true },
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'tool_result', id: 't2', ok: false },
      { type: 'context', used: 1234, size: 200000 },
      { type: 'action', action: 'open', page: 'funnels', title: 'Open it', game_id: 'g' },
      { type: 'proposal', kind: 'levels', title: 'Worst first', why: '', game_id: 'g', payload: { sort: 'drop' }, plain: ['Sorted by drop'] },
      { type: 'usage', input_tokens: 10, output_tokens: 5 },
      { type: 'done', seconds: 2.5, resumed: true },
    ];
    const chat = events.map((event) => applyEvent(answer, event, 1000)).find(Boolean);
    expect(chat).toEqual({ chatId: 'c1', title: 'hi' });
    expect(answer.text).toBe('Hello world');
    expect(answer.tools.map((tool) => [tool.name, tool.label, tool.status])).toEqual([
      ['get_context', 'Looking at the game', 'done'],
      ['run_funnel', 'Running a funnel', 'error'],
    ]);
    expect(answer.notices).toHaveLength(1);
    expect(answer.actions[0]!.page).toBe('funnels');
    expect(answer.proposals.map((item) => item.kind)).toEqual(['levels']);
    expect(answer.usage?.output_tokens).toBe(5);
    expect(answer.seconds).toBe(2.5);
    expect(answer.resumed).toBe(true);
    expect(contextShare(answer)).toBeCloseTo(0.00617, 4);
  });

  it('settles tools still running when the stream stops', () => {
    const answer = emptyAnswer();
    applyEvent(answer, { type: 'tool', id: 't1', name: 'find_players' }, 100);
    settle(answer, true, 600);
    expect(answer.tools[0]).toMatchObject({ done: true, status: 'error', ms: 500 });
  });

  it('reads stored messages back in the same shape, marking refused tools', () => {
    const messages = fromStoredMessages([
      { id: 1, role: 'user', text: 'hi' },
      { id: 2, role: 'assistant', text: 'Hello', tools: [{ tool: 'get_context', ok: true, ms: 40 }, { tool: 'Bash', denied: true }], actions: [], scope: '', error: '', seconds: 1.2, harness: 'claude', model: 'sonnet', usage: { input_tokens: 1, output_tokens: 2, cache_read_tokens: null, cache_write_tokens: null, cost_usd: null }, context: { used: 10, size: 100 }, created_at: '2026-10-25T00:00:00Z' },
    ]);
    expect(messages[0]).toEqual({ role: 'user', text: 'hi', id: 1 });
    const answer = messages[1]!;
    if (answer.role !== 'assistant') throw new Error('expected an answer');
    expect(answer.tools.map((tool) => [tool.label, tool.status])).toEqual([['Looking at the game', 'done'], ['Refused: Bash', 'error']]);
    expect(answer.usage?.output_tokens).toBe(2);
    expect(contextShare(answer)).toBe(0.1);
    expect(toolLabel('get_exits')).toBe('Finding where players stop');
    expect(toolLabel('some_new_tool')).toBe('Some new tool');
  });
});
