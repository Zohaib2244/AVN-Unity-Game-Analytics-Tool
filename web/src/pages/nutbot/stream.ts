// The answer being streamed: one newline-delimited JSON event at a time folded into the message the
// panel shows (pure, so tests can replay a stream), plus the server's stored messages in the same shape.
import type { NutBotAction, NutBotEvent, NutBotProposal, NutBotStoredAssistant, NutBotStoredMessage, NutBotTool, NutBotUsage } from '@/lib/types';

/** How each tool reads in the call chip. */
export const TOOL_LABELS: Record<string, string> = {
  get_context: 'Looking at the game',
  list_events: 'Listing events',
  get_overview: 'Reading the overview',
  run_funnel: 'Running a funnel',
  get_journeys: 'Following players',
  list_journey_players: 'Finding the players',
  get_player_story: "Reading a player's story",
  find_players: 'Searching players',
  get_level_progress: 'Checking the levels',
  get_player_events: "Counting a player's events",
  get_player_levels: "Reading a player's levels",
  compare_player: 'Comparing a player with others',
  get_level_detail: 'Looking into a level',
  get_exits: 'Finding where players stop',
  propose_players_view: 'Building a players view',
  propose_funnel: 'Building a funnel',
  propose_highlight: 'Building a highlight',
  propose_level_view: 'Setting up the levels view',
  explain_conditions: 'Explaining a rule',
  compare_player_groups: 'Comparing player groups',
  list_saved_groups: 'Reading the saved groups',
  propose_player_groups: 'Building a group comparison',
  compare_cohorts: 'Comparing two groups',
  get_behaviour: 'Looking for behaviour patterns',
  save_funnel: 'Saving a funnel',
  set_event_label: 'Updating the event dictionary',
  show_in_dashboard: 'Preparing a view',
};
export const toolLabel = (name: string): string => TOOL_LABELS[name] || (name ? name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Working');

export type Answer = {
  role: 'assistant';
  /** The server's row id once stored; absent while streaming. */
  id?: number;
  text: string;
  tools: NutBotTool[];
  actions: NutBotAction[];
  proposals: NutBotProposal[];
  notices: string[];
  scope?: string;
  usage?: NutBotUsage;
  context?: { used: number | null; size: number | null };
  seconds?: number;
  error?: string;
  resumed?: boolean;
  harness?: string;
  model?: string;
};

export const emptyAnswer = (scope?: string): Answer => ({ role: 'assistant', text: '', tools: [], actions: [], proposals: [], notices: [], scope });

/** Folds one event into the answer. Returns the chat the server put the message in, when the event says. */
export function applyEvent(answer: Answer, event: NutBotEvent, now = Date.now()): { chatId: string; title: string } | null {
  switch (event.type) {
    case 'chat': return { chatId: event.id, title: event.title };
    case 'text': answer.text += event.text; break;
    case 'tool': answer.tools.push({ id: event.id, name: event.name, label: toolLabel(event.name), done: false, status: 'running', started: now }); break;
    case 'tool_result': {
      const tool = (event.id && answer.tools.find((item) => item.id === event.id && !item.done)) || answer.tools.find((item) => !item.done);
      if (tool) { tool.done = true; tool.status = event.ok === false ? 'error' : 'done'; tool.ms = tool.started ? now - tool.started : undefined; }
      break;
    }
    case 'context': answer.context = { used: event.used, size: event.size }; break;
    case 'notice': answer.notices.push(event.text); break;
    case 'action': answer.actions.push(event); break;
    case 'proposal': answer.proposals.push(event); break;
    case 'usage': answer.usage = event; break;
    case 'error': answer.error = event.message; break;
    case 'done': answer.seconds = event.seconds; answer.resumed = event.resumed; break;
    default: break;
  }
  return null;
}

/** Marks every tool still running as finished (the stream ended or was stopped). */
export function settle(answer: Answer, stopped: boolean, now = Date.now()): void {
  for (const tool of answer.tools) {
    if (tool.done) continue;
    tool.done = true; tool.status = stopped ? 'error' : 'done'; tool.ms = tool.started ? now - tool.started : undefined;
  }
}

/** A stored assistant row as the panel's answer shape. */
export function fromStored(row: NutBotStoredAssistant): Answer {
  return {
    role: 'assistant',
    id: row.id,
    text: row.text,
    tools: row.tools.map((tool, index) => ({ id: `s${row.id}-${index}`, name: tool.tool, label: tool.denied ? `Refused: ${tool.tool}` : toolLabel(tool.tool), done: true, status: tool.denied || tool.ok === false ? 'error' : 'done', ms: tool.ms })),
    actions: row.actions.filter((item): item is NutBotAction => item.type === 'action'),
    proposals: row.actions.filter((item): item is NutBotProposal => item.type === 'proposal'),
    notices: [],
    scope: row.scope || undefined,
    usage: { type: 'usage', ...row.usage },
    context: row.context,
    seconds: row.seconds ?? undefined,
    error: row.error || undefined,
    harness: row.harness,
    model: row.model,
  };
}

export type ChatMessage = { role: 'user'; text: string; id?: number } | Answer;

export const fromStoredMessages = (rows: NutBotStoredMessage[]): ChatMessage[] => rows.map((row) => (row.role === 'user' ? { role: 'user', text: row.text, id: row.id } : fromStored(row)));

/** How full the agent's context window is, 0–1, when the answer reported it. */
export const contextShare = (answer: Answer | undefined): number | null => (answer?.context?.used != null && answer.context.size ? Math.min(1, answer.context.used / answer.context.size) : null);
