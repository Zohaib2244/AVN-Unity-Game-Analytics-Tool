// NutBot: the assistant panel on game pages. It talks to the server, which runs a local AI agent over
// the Agent Client Protocol with this app's tools; answers stream back as newline-delimited JSON (see
// avn_analytics/nutbot.py) and are kept in the server's own chat record, which this panel lists and reopens.
// The shell owns the launcher, Ctrl+J and "Ask NutBot" (src/app/nutbot.tsx); this draws the panel.
// The conversation lives here, mounted once in the shell: the panel is drawn at the side, or inside an
// open player viewer's slot, and moving between them keeps the messages, the stream and the typed draft.
// History, reports and settings are header views; the composer stays visible under every one of them.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { NutBotPanel, useAppContainer, type AnswerBlock, type NbMessage, type SlashCommand } from '@avn/ui';
import { queryClient, read, readKey, useRead, write } from '@/api';
import { useCurrentGame } from '@/app/GameSection';
import { useNutBot } from '@/app/nutbot';
import { useSession } from '@/app/session';
import { useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { filterState, saveFilters, type FilterState } from '@/lib/filters';
import { agoText, number, platformLabel } from '@/lib/format';
import { gamePath } from '@/lib/games';
import { storeGet, storeRemove, storeSet } from '@/lib/store';
import type { Game, NutBotAction, NutBotChatRead, NutBotChatRow, NutBotEvent, NutBotInfo, NutBotLimits, NutBotPrefs, NutBotProposal, NutBotReportRow, NutBotStoredTool } from '@/lib/types';
import { buildContext, contextChips, panelChips, scopeLine, suggestionsFor, type PageContext } from './context';
import { Markdown } from './markdown';
import { effortLevels, pickEffort, pickModel } from './models';
import { APPLY_KEY, applyMode, applyProposal, proposalKey, savesReport, type Applied, type ApplyMode } from './proposals';
import { applyEvent, contextShare, emptyAnswer, fromStoredMessages, settle, type Answer, type ChatMessage } from './stream';

const PREFS_KEY = 'avn-nutbot-prefs';
const HEAVY_CONTEXT = 0.6; // past this share of the agent's context window, suggest a new chat
const currentKey = (game: Pick<Game, 'id'>) => `avn-nutbot-current-${game.id}`;
const nbPrefs = (): NutBotPrefs => storeGet<NutBotPrefs>(PREFS_KEY) || {};
const chatsPath = (game: Pick<Game, 'id'>) => `/v1/games/${encodeURIComponent(game.id)}/nutbot/chats`;

/** The face: a small robot that blinks when idle and looks around while thinking. */
export function NbFace({ state }: { state: 'idle' | 'thinking' }): ReactElement {
  return (
    <span className={`nb-face ${state}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" width="30" height="30">
        <rect x="3" y="5" width="26" height="22" rx="6" className="nb-head" />
        <rect x="9" y="12" width="4" height="6" rx="1.5" className="nb-eye nb-eye-l" />
        <rect x="19" y="12" width="4" height="6" rx="1.5" className="nb-eye nb-eye-r" />
        <path d="M11 22h10" className="nb-mouth" />
        <path d="M16 5V2" className="nb-antenna" />
        <circle cx="16" cy="2" r="1.4" className="nb-tip" />
      </svg>
    </span>
  );
}

/** Whether this person may use NutBot for the game's workspace (admins always; others by the workspace setting). */
export const nbAllowed = (me: { is_admin: boolean; workspaces: Array<{ id: string; nutbot?: boolean }> }, game: Pick<Game, 'workspace_id'>, workspace: string | null): boolean =>
  Boolean(me.is_admin || me.workspaces.find((item) => item.id === (game.workspace_id || workspace))?.nutbot);

/** "63% of the week used, resets in 2 d" for one allowance window. */
export function windowText(window: { name: string; used_percent: number | null; resets_at: string | null }): string {
  if (window.used_percent == null) return `${window.name}: unknown`;
  const resets = window.resets_at ? `, resets ${agoText(window.resets_at).replace(' ago', '').replace('just now', 'soon')}${/\d/.test(agoText(window.resets_at)) ? ' from now' : ''}` : '';
  return `${window.name}: ${Math.round(window.used_percent)}% used${resets}`;
}

type TraceState = { open: boolean; tools?: NutBotStoredTool[]; loading?: boolean };
type View = 'chat' | 'chats' | 'reports' | 'settings';

/** The @avn/ui message for one answer. The answer being streamed shows its text as it arrives. */
type ProposalControls = { applied: ReadonlySet<string>; apply: (proposal: NutBotProposal) => void; undo: (proposal: NutBotProposal) => void; saveReport?: (answer: Answer) => void };

function toPanelMessage(message: ChatMessage, streaming: boolean, onOpen: (action: NutBotAction) => void, onLink: (path: string) => void, trace: { state?: TraceState; toggle?: () => void }, proposals: ProposalControls, note?: ReactNode): NbMessage {
  if (message.role === 'user') return { role: 'user', text: message.text };
  const tools = message.tools.map((tool) => ({ name: tool.label, args: tool.name, status: tool.status ?? (tool.done ? 'done' as const : 'running' as const), ms: tool.ms }));
  const body: ReactNode[] = [];
  if (message.notices.length) body.push(<p key="notice" className="nb-notice">{message.notices.join(' ')}</p>);
  if (message.text) body.push(<div key="text" className="nb-md"><Markdown source={message.text} onOpen={onLink} /></div>);
  if (message.error) body.push(<p key="error" className="nb-error" role="alert">{message.error}</p>);
  if (message.actions.length) body.push(<div key="actions" className="nb-actions">{message.actions.map((action, index) => <button key={index} type="button" className="btn sm nb-action" onClick={() => onOpen(action)}><Ico name="arrow" size={13} /> {action.title}</button>)}</div>);
  if (!streaming) {
    // Under an answer: what to do with it, never tokens or cost (the Settings view has the allowance limits).
    const links: ReactNode[] = [];
    if (message.resumed === false && message.id == null) links.push(<span key="rebuilt">Rebuilt from the saved chat</span>);
    if (proposals.saveReport && message.id != null && message.text) links.push(<button key="save" type="button" className="nb-link" onClick={() => proposals.saveReport!(message)}>Save as report</button>);
    if (trace.toggle) links.push(<button key="trace" type="button" className="nb-link" onClick={trace.toggle}>{trace.state?.open ? 'Hide trace' : 'Trace'}</button>);
    if (note) links.push(<span key="note">{note}</span>);
    if (links.length) body.push(<div key="meta" className="nb-meta">{links.flatMap((link, index) => (index ? [<span key={`dot${index}`} aria-hidden="true"> · </span>, link] : [link]))}</div>);
    if (trace.state?.open) {
      body.push(
        <div key="trace" className="nb-trace">
          {trace.state.loading ? <p className="small muted">Loading the trace…</p> : (trace.state.tools || []).length ? (trace.state.tools || []).map((tool, index) => (
            <details key={index}>
              <summary>{tool.denied ? 'Refused' : tool.ok === false ? 'Failed' : 'Done'} · {tool.tool}{tool.ms != null ? ` · ${tool.ms} ms` : ''}</summary>
              {tool.input ? <pre>{tool.input}</pre> : null}
              {tool.output ? <pre>{tool.output}</pre> : null}
            </details>
          )) : <p className="small muted">No tool calls in this answer.</p>}
        </div>,
      );
    }
  }
  return {
    role: 'bot', tools,
    // While the answer streams the trace stays open ("Working…") until the first words arrive.
    done: !streaming || message.text !== '' || !tools.length,
    text: body.length ? <>{body}</> : undefined,
    blocks: message.proposals.length ? message.proposals.map((proposal): AnswerBlock => {
      const preview = (
        <div className="nb-proposal">
          {proposal.why ? <p className="small">{proposal.why}</p> : null}
          {proposal.plain.length ? <ul className="small">{proposal.plain.map((line, index) => <li key={index}>{line}</li>)}</ul> : null}
        </div>
      );
      return proposals.applied.has(proposalKey(proposal))
        ? { type: 'custom', title: proposal.title, node: <p className="small muted">{savesReport(proposal) ? 'Saved to Reports.' : 'Applied.'} <button type="button" className="nb-link" onClick={() => proposals.undo(proposal)}>Undo</button></p> }
        : { type: 'proposal', title: proposal.title, preview, confirmLabel: savesReport(proposal) ? 'Save' : 'Apply', onConfirm: () => proposals.apply(proposal) };
    }) : undefined,
    scope: message.scope && !streaming && message.text ? message.scope : undefined,
    thought: !streaming ? message.seconds : undefined,
  };
}

/** The top of a header view: its name and the way back to the conversation. */
function ViewHead({ title, onBack }: { title: string; onBack: () => void }): ReactElement {
  return (
    <div className="nb-view-head">
      <h3>{title}</h3>
      <button type="button" className="btn sm" onClick={onBack}>Back to chat</button>
    </div>
  );
}

export function NutBotHost(): ReactElement | null {
  const { me, workspace } = useSession();
  const { game, section } = useCurrentGame();
  const nutbot = useNutBot();
  const navigate = useNavigate();
  const { toast } = useNotify();
  const appEl = useAppContainer();
  const search = useSearch({ strict: false }) as { player?: string };
  const href = useRouterState({ select: (state) => state.location.href });
  const allowed = game ? nbAllowed(me, game, workspace) : false;
  const infoQuery = useRead<NutBotInfo>('/v1/nutbot', { enabled: Boolean(game && allowed) });
  const info = infoQuery.data ?? null;

  const [, bump] = useReducer((n: number) => n + 1, 0);
  const messagesRef = useRef<ChatMessage[]>([]);
  const controller = useRef<AbortController | null>(null);
  const [chatId, setChatIdState] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const [harness, setHarness] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [filters, setFilters] = useState<FilterState | null>(null);
  const [view, setView] = useState<View>('chat');
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [traces, setTraces] = useState<Record<number, TraceState>>({});
  const [mode, setModeState] = useState<ApplyMode>(applyMode);
  const appliedRef = useRef(new Map<string, Applied>());
  const { open, setOpen, setUsable, pending, takePending, slot } = nutbot;
  // Inside a player viewer the page behind it is inert: applying a card must not navigate away from it.
  const embedded = slot != null;
  const embeddedRef = useRef(embedded);
  embeddedRef.current = embedded;
  // The latest values for handlers that outlive a render (the Escape listener, a card applied after a stream).
  const viewRef = useRef(view);
  viewRef.current = view;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  // A pinned headline on the Overview opens its report here.
  useEffect(() => {
    if (!open || !game) return;
    const wanted = storeGet<{ game: string; report: string }>('avn-nutbot-open-report');
    if (!wanted) return;
    storeRemove('avn-nutbot-open-report');
    if (wanted.game === game.id) { setView('reports'); setOpenReport(wanted.report); }
  }, [open, game]);

  // Availability: a game page, this person may use it, and the server has it switched on.
  const usable = Boolean(game && allowed && info?.enabled);
  useEffect(() => { setUsable(usable); }, [usable, setUsable]);
  useEffect(() => { if (!usable && open) setOpen(false); }, [usable, open, setOpen]);

  // Chats are kept per game on the server; the open one is remembered here. Switching game closes the panel.
  const gameId = game?.id ?? null;
  const setChatId = useCallback((id: string | null) => {
    setChatIdState(id);
    if (game) { if (id) storeSet(currentKey(game), id); else storeRemove(currentKey(game)); }
  }, [game]);
  useEffect(() => {
    controller.current?.abort();
    messagesRef.current = [];
    setChatIdState(game ? storeGet<string>(currentKey(game)) : null);
    setTraces({}); setBusy(false); setOpen(false); setView('chat'); setDraft(''); bump();
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  const chatPath = game && chatId ? `${chatsPath(game)}/${encodeURIComponent(chatId)}` : null;
  const chatQuery = useRead<NutBotChatRead>(chatPath, { enabled: Boolean(chatPath && usable) });
  const listQuery = useRead<{ chats: NutBotChatRow[] }>(game ? chatsPath(game) : null, { enabled: Boolean(game && usable && open) });
  const chats = listQuery.data?.chats ?? [];
  // The stored messages replace the local copy whenever a chat (re)loads and nothing is streaming.
  useEffect(() => {
    if (busy) return;
    if (chatQuery.data && chatQuery.data.chat.id === chatId) { messagesRef.current = fromStoredMessages(chatQuery.data.messages); bump(); }
    else if (chatQuery.isError && chatId) { setChatId(null); messagesRef.current = []; bump(); }
  }, [chatQuery.data, chatQuery.isError, chatId, busy, setChatId]);

  // The harness (assistant) and model: the chat's own, then the remembered choice, then the server default.
  // Only models the agent reported are offered; a remembered one it no longer offers falls back.
  const available = useMemo(() => (info?.harnesses || []).filter((item) => item.available), [info]);
  const current = useMemo(() => info?.harnesses.find((h) => h.id === harness) ?? null, [info, harness]);
  useEffect(() => {
    if (!info) return;
    const prefs = nbPrefs();
    const chosen = [chatQuery.data?.chat.harness, prefs.harness, info.default, available[0]?.id].find((id) => available.some((item) => item.id === id)) || available[0]?.id || '';
    setHarness(chosen);
    const item = info.harnesses.find((h) => h.id === chosen) ?? null;
    setModel(pickModel(item, chatQuery.data?.chat.harness === chosen && chatQuery.data.chat.model ? chatQuery.data.chat.model : (prefs.models || {})[chosen]));
  }, [info, available, gameId, open, chatQuery.data]);
  const models = useMemo(() => (current?.models?.length ? current.models : ['']), [current]);
  const levels = useMemo(() => effortLevels(current, model), [current, model]);
  useEffect(() => { setEffort((previous) => pickEffort(levels, previous || (nbPrefs().efforts || {})[harness])); }, [levels, harness]);
  const chooseHarness = (id: string) => { setHarness(id); setEffort(''); setModel(pickModel(info?.harnesses.find((h) => h.id === id) ?? null, (nbPrefs().models || {})[id])); };

  // The page's filters live in localStorage; re-read them when the panel opens, the address changes and while open.
  const readFilters = useCallback(() => { const next = game ? filterState(game) : null; setFilters((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next)); }, [game]);
  useEffect(() => { readFilters(); }, [readFilters, href, open]);
  useEffect(() => { if (!open) return; const timer = setInterval(readFilters, 1500); return () => clearInterval(timer); }, [open, readFilters]);
  const page: PageContext = useMemo(() => ({ game, section, filters, player: search.player || null }), [game, section, filters, search.player]);
  const chips = useMemo(() => contextChips(page), [page]);
  const toggleContext = (id: string) => setOff((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // At the side, drawers slide left to sit beside the panel; the composer gets focus when it opens.
  useEffect(() => {
    if (!appEl) return;
    appEl.classList.toggle('nb-open', open && !embedded);
    return () => appEl.classList.remove('nb-open');
  }, [appEl, open, embedded]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => appEl?.querySelector<HTMLTextAreaElement>('.nb .nb-in textarea')?.focus(), 50);
    // Escape: a menu in the composer first (it marks the event), then a header view, then the panel.
    // Inside a player viewer the viewer owns Escape; its dialog has already handled the key.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || embeddedRef.current || !(event.target as Element | null)?.closest?.('.nb')) return;
      event.preventDefault();
      if (viewRef.current !== 'chat') setView('chat'); else close();
    };
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(timer); document.removeEventListener('keydown', onKey); };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { setOpen(false); document.querySelector<HTMLButtonElement>('.nb-launcher')?.focus(); };

  const openAction = useCallback((action: NutBotAction) => {
    if (!game || action.game_id !== game.id) { toast('That belongs to another game.'); return; }
    if (action.start && action.end) saveFilters(game, { ...filterState(game), range: { preset: 'custom', from: action.start, to: action.end } });
    if (action.page === 'funnels' && action.funnel?.steps?.length) {
      storeSet(`avn-funnel-draft-${game.id}`, { id: null, name: '', steps: action.funnel.steps.map((step) => ({ event: step.event, param: step.param || '', op: step.op || 'eq', value: step.value || '', label: step.label || '' })), scope: action.funnel.scope || 'player', window_hours: action.funnel.window_hours || null });
      if (action.show_journeys) storeSet(`avn-pending-journeys-${game.id}`, 1);
    }
    void navigate({ to: gamePath(game, action.page), search: action.page === 'players' && action.player ? { player: action.player } : {} });
  }, [game, navigate, toast]);
  const undoProposal = useCallback(async (proposal: NutBotProposal) => {
    const key = proposalKey(proposal); const done = appliedRef.current.get(key);
    if (!done) return;
    appliedRef.current.delete(key); bump();
    try { await done.undo(); } catch (error) { toast((error as Error).message || 'Could not undo that.', undefined, 'error'); }
  }, [toast]);
  const applyOne = useCallback(async (proposal: NutBotProposal, quiet = false) => {
    if (!game || proposal.game_id !== game.id) { toast('That belongs to another game.'); return; }
    const key = proposalKey(proposal);
    if (appliedRef.current.has(key)) return;
    try {
      const done = await applyProposal(game, proposal, chatIdRef.current);
      appliedRef.current.set(key, done); bump();
      // A report opens no page, and inside a player viewer the viewer stays: the page is there after Close.
      if (!quiet && !savesReport(proposal) && !embeddedRef.current) void navigate({ to: done.path });
      toast(savesReport(proposal) ? 'Saved to Reports' : `Applied: ${proposal.title}`, { label: 'Undo', run: () => undoProposal(proposal) }, 'info');
    } catch (error) { toast((error as Error).message || (savesReport(proposal) ? 'Could not save the report.' : 'Could not apply that.'), undefined, 'error'); }
  }, [game, navigate, toast, undoProposal]);
  const setMode = (next: ApplyMode) => { setModeState(next); storeSet(APPLY_KEY, next); };
  const openLink = useCallback((path: string) => { void navigate({ to: path }); }, [navigate]);

  const refreshChats = useCallback(() => {
    if (!game) return;
    void queryClient.invalidateQueries({ queryKey: readKey(chatsPath(game)) });
    if (chatPath) void queryClient.invalidateQueries({ queryKey: readKey(chatPath) });
  }, [game, chatPath]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (busy || !text || !game) return;
    setView('chat');
    const prefs = nbPrefs();
    const messages = messagesRef.current;
    messages.push({ role: 'user', text });
    // The context is taken now: browsing to another player later doesn't change this question or its scope line.
    const asked: PageContext = { ...page, filters: filterState(game) };
    const answer: Answer = emptyAnswer(scopeLine(contextChips(asked), off));
    messages.push(answer);
    setBusy(true); bump();
    const abort = new AbortController(); controller.current = abort;
    storeSet(PREFS_KEY, { ...prefs, harness, models: { ...(prefs.models || {}), [harness]: model }, efforts: { ...(prefs.efforts || {}), [harness]: effort } });
    const started = Date.now();
    let newChat: string | null = null;
    try {
      const response = await fetch(`/v1/games/${encodeURIComponent(game.id)}/nutbot/chat`, {
        method: 'POST', credentials: 'same-origin', signal: abort.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, harness, model: model || undefined, effort: effort || undefined, chat_id: chatId || undefined, context: buildContext(asked, off) }),
      });
      if (!response.ok || !response.body) { const error = (await response.json().catch(() => ({}))) as { detail?: unknown }; throw new Error(typeof error.detail === 'string' ? error.detail : 'NutBot could not answer.'); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event: NutBotEvent; try { event = JSON.parse(line) as NutBotEvent; } catch { continue; }
          const chat = applyEvent(answer, event);
          if (chat && chat.chatId !== chatId) { newChat = chat.chatId; setChatId(chat.chatId); chatIdRef.current = chat.chatId; }
          bump();
        }
      }
    } catch (error) {
      answer.error = (error as Error).name === 'AbortError' ? 'Stopped.' : (error as Error).message;
    } finally {
      settle(answer, abort.signal.aborted);
      answer.seconds = answer.seconds || Math.round((Date.now() - started) / 100) / 10;
      controller.current = null; setBusy(false); bump();
      if (newChat || chatId) refreshChats();
      // "Applies itself" covers what NutBot builds for the pages; a report is only ever saved by pressing Save.
      if (applyMode() === 'auto' && !abort.signal.aborted) for (const proposal of answer.proposals) if (!savesReport(proposal)) await applyOne(proposal);
    }
  }, [busy, game, harness, model, effort, page, off, chatId, setChatId, refreshChats, applyOne]);

  // Questions asked from the command palette arrive through the context.
  useEffect(() => {
    if (!pending || !usable || busy) return;
    const text = takePending();
    if (text) void send(text);
  }, [pending, usable, busy, takePending, send]);

  const newChat = () => { if (busy) return; messagesRef.current = []; setChatId(null); setTraces({}); setView('chat'); bump(); };
  const openChat = (id: string) => { if (busy) return; messagesRef.current = []; setTraces({}); setChatId(id); setView('chat'); bump(); };
  const stop = () => controller.current?.abort();
  const renameChat = async () => {
    if (!game || !renaming) return;
    const { id, title } = renaming; setRenaming(null);
    if (!title.trim()) return;
    try { await write(`${chatsPath(game)}/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) }); refreshChats(); }
    catch (error) { toast((error as Error).message || 'Could not rename the chat.', undefined, 'error'); }
  };
  const deleteChat = async (chat: NutBotChatRow) => {
    if (!game) return;
    try {
      await write(`${chatsPath(game)}/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
      if (chat.id === chatId) { messagesRef.current = []; setChatId(null); bump(); }
      refreshChats();
      toast('Chat deleted', { label: 'Undo', run: async () => { await write(`${chatsPath(game)}/${encodeURIComponent(chat.id)}/restore`, { method: 'POST' }); refreshChats(); } }, 'info');
    } catch (error) { toast((error as Error).message || 'Could not delete the chat.', undefined, 'error'); }
  };
  const toggleTrace = async (messageId: number) => {
    const state = traces[messageId];
    if (state?.open) { setTraces((t) => ({ ...t, [messageId]: { ...state, open: false } })); return; }
    if (state?.tools) { setTraces((t) => ({ ...t, [messageId]: { ...state, open: true } })); return; }
    if (!chatPath) return;
    setTraces((t) => ({ ...t, [messageId]: { open: true, loading: true } }));
    try {
      const trace = await read<NutBotChatRead>(`${chatPath}/trace`);
      const row = trace.messages.find((item) => item.id === messageId);
      setTraces((t) => ({ ...t, [messageId]: { open: true, tools: row && row.role === 'assistant' ? row.tools : [] } }));
    } catch (error) {
      setTraces((t) => ({ ...t, [messageId]: { open: false } }));
      toast((error as Error).message || 'Could not load the trace.', undefined, 'error');
    }
  };

  const reportsPath = game ? `/v1/games/${encodeURIComponent(game.id)}/nutbot/reports` : null;
  const reportsQuery = useRead<{ reports: NutBotReportRow[] }>(reportsPath, { enabled: Boolean(usable && open && view === 'reports') });
  const reportQuery = useRead<NutBotReportRow>(reportsPath && openReport ? `${reportsPath}/${encodeURIComponent(openReport)}` : null, { enabled: Boolean(usable && openReport) });
  const reports = reportsQuery.data?.reports ?? [];
  const saveReport = useCallback(async (answer: Answer) => {
    if (!reportsPath) return;
    const title = (chatQuery.data?.chat.title || answer.text.split('\n')[0] || 'NutBot report').replace(/[#*_`]/g, '').trim().slice(0, 80) || 'NutBot report';
    try {
      const saved = await write<NutBotReportRow>(reportsPath, { method: 'POST', body: JSON.stringify({ title, body: answer.text, chat_id: chatId || undefined }) });
      toast('Saved to Reports', { label: 'Undo', run: async () => { await write(`${reportsPath}/${encodeURIComponent(saved.id)}`, { method: 'DELETE' }); } }, 'info');
    } catch (error) { toast((error as Error).message || 'Could not save the report.', undefined, 'error'); }
  }, [reportsPath, chatQuery.data, chatId, toast]);
  const changeReport = async (report: NutBotReportRow, change: { pinned?: boolean; title?: string }) => {
    if (!reportsPath) return;
    try { await write(`${reportsPath}/${encodeURIComponent(report.id)}`, { method: 'PATCH', body: JSON.stringify(change) }); }
    catch (error) { toast((error as Error).message || 'Could not change the report.', undefined, 'error'); }
  };
  const deleteReport = async (report: NutBotReportRow) => {
    if (!reportsPath) return;
    try {
      await write(`${reportsPath}/${encodeURIComponent(report.id)}`, { method: 'DELETE' });
      if (openReport === report.id) setOpenReport(null);
      toast('Report deleted', { label: 'Undo', run: async () => { await write(`${reportsPath}/${encodeURIComponent(report.id)}/restore`, { method: 'POST' }); } }, 'info');
    } catch (error) { toast((error as Error).message || 'Could not delete the report.', undefined, 'error'); }
  };
  const commands = useMemo<SlashCommand[]>(() => (info?.skills || []).map((skill) => ({ name: `/${skill.name}`, description: skill.args ? `${skill.summary} · ${skill.args}` : skill.summary })), [info]);

  const limitsQuery = useRead<NutBotLimits>('/v1/nutbot/limits', { enabled: usable && open && view === 'settings' });

  if (!game || !usable) return null;
  const all = messagesRef.current;
  const lastAnswer = [...all].reverse().find((item): item is Answer => item.role === 'assistant');
  const share = contextShare(lastAnswer);
  const heavy = !busy && share != null && share >= HEAVY_CONTEXT
    ? <>Context {Math.round(share * 100)}% full · <button type="button" className="nb-link" onClick={newChat}>New chat</button> answers faster</>
    : undefined;
  const messages = all.map((message, index) => toPanelMessage(message, busy && index === all.length - 1, openAction, openLink,
    message.role === 'assistant' && message.id != null && me.is_admin ? { state: traces[message.id], toggle: () => void toggleTrace(message.id!) } : {},
    { applied: new Set(appliedRef.current.keys()), apply: (proposal) => void applyOne(proposal), undo: (proposal) => void undoProposal(proposal), saveReport: (answer) => void saveReport(answer) },
    message === lastAnswer ? heavy : undefined));
  const toggleView = (next: View) => setView(view === next ? 'chat' : next);
  const back = () => setView('chat');
  // Without a working assistant the settings view explains the setup and is what the panel shows.
  const shown: View = available.length ? view : 'settings';
  const headerButton = (id: View, label: string, icon: 'clock' | 'file' | 'settings') => (
    <button type="button" className="icon-btn" aria-label={label} title={label} aria-pressed={shown === id} onClick={() => toggleView(id)}><Ico name={icon} size={16} /></button>
  );

  const settingsView = (
    <div className="nb-pane" role="region" aria-label="NutBot settings">
      <ViewHead title="Settings" onBack={back} />
      {available.length ? (
        <>
          <label className="nb-field">Assistant
            <select className="nb-harness" value={harness} onChange={(event) => chooseHarness(event.target.value)} disabled={busy}>
              {(info?.harnesses || []).map((item) => <option key={item.id} value={item.id} disabled={!item.available} title={item.reason || ''}>{item.label}{item.available ? '' : ' (not set up)'}</option>)}
            </select></label>
          <label className="nb-field">Model
            <select className="nb-model" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
              {models.map((item) => <option key={item} value={item}>{item || 'The agent’s default'}</option>)}
            </select></label>
          {levels.length ? (
            <label className="nb-field">Effort
              <select className="nb-effort" value={effort} onChange={(event) => setEffort(event.target.value)} disabled={busy}>
                <option value="">Default</option>
                {levels.map((level) => <option key={level.value} value={level.value}>{level.name}</option>)}
              </select></label>
          ) : null}
          <div className="nb-field">
            <span id="nb-apply-label">Cards NutBot builds for the pages</span>
            <div className="segmented" role="group" aria-labelledby="nb-apply-label">
              <button type="button" aria-pressed={mode === 'ask'} onClick={() => setMode('ask')}>Ask first</button>
              <button type="button" aria-pressed={mode === 'auto'} onClick={() => setMode('auto')}>Apply straight away</button>
            </div>
          </div>
          {share != null ? (
            <p className={`nb-context${share >= HEAVY_CONTEXT ? ' heavy' : ''}`}>
              <span className="nb-bar" aria-hidden="true"><span style={{ width: `${Math.round(share * 100)}%` }} /></span>
              This chat’s context: {Math.round(share * 100)}% full
            </p>
          ) : null}
          <div className="nb-usage" role="region" aria-label="Allowance limits">
            <h4>Allowance limits</h4>
            {Object.entries(limitsQuery.data?.agents ?? {}).map(([id, agent]) => {
              const label = info?.harnesses.find((h) => h.id === id)?.label || id;
              if (agent.error || !agent.windows.length) return <p key={id} className="small muted">{label}: allowance unknown{agent.error ? ` (${agent.error})` : ''}.</p>;
              return agent.windows.map((window) => {
                const warn = window.used_percent != null && window.used_percent >= (limitsQuery.data?.warn_percent ?? 80);
                return (
                  <p key={`${id}-${window.name}`} className={`nb-window${warn ? ' warn' : ''}`}>
                    <span className="nb-bar" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.round(window.used_percent ?? 0))}%` }} /></span>
                    {label} · {windowText(window)}{warn ? ' · nearly used up' : ''}
                  </p>
                );
              });
            })}
            {limitsQuery.isLoading ? <p className="small muted">Checking the agents' allowances…</p> : null}
            {limitsQuery.isError ? <p className="small muted" role="alert">Could not check the allowance limits. <button type="button" className="btn sm" onClick={() => void limitsQuery.refetch()}>Retry</button></p> : null}
            {limitsQuery.isSuccess && !Object.keys(limitsQuery.data?.agents ?? {}).length ? <p className="small muted">No allowance limits are available.</p> : null}
          </div>
        </>
      ) : (
        <div className="nb-setup-help">
          <h4>NutBot isn’t set up on this server yet</h4>
          <p>An admin needs to connect an assistant (Claude, Codex or OpenCode). The steps are in the README under “NutBot”.</p>
          {(info?.harnesses || []).map((item) => <p key={item.id} className="small muted"><strong>{item.label}:</strong> {item.reason}</p>)}
        </div>
      )}
    </div>
  );

  const chatsView = (
    <div className="nb-pane" role="region" aria-label="Chat history">
      <ViewHead title="Chats" onBack={back} />
      {listQuery.isLoading ? <p className="small muted">Loading your chats…</p> : chats.length ? chats.map((chat) => (
        <div key={chat.id} className={`nb-chat-row${chat.id === chatId ? ' current' : ''}`}>
          {renaming?.id === chat.id ? (
            <form className="nb-rename" onSubmit={(event) => { event.preventDefault(); void renameChat(); }}>
              <input value={renaming.title} maxLength={80} autoFocus onChange={(event) => setRenaming({ id: chat.id, title: event.target.value })} onBlur={() => void renameChat()} aria-label="Chat title" />
            </form>
          ) : (
            <button type="button" className="nb-chat-open" onClick={() => openChat(chat.id)} disabled={busy} aria-current={chat.id === chatId ? 'true' : undefined}>
              <span className="nb-chat-title">{chat.title || 'Untitled chat'}</span>
              <span className="small muted">{agoText(chat.updated_at)} · {number(chat.messages)} messages · {chat.harness}</span>
            </button>
          )}
          <button type="button" className="btn sm icon" title="Rename" aria-label={`Rename ${chat.title || 'chat'}`} onClick={() => setRenaming({ id: chat.id, title: chat.title })}><Ico name="edit" size={13} /></button>
          <button type="button" className="btn sm icon" title="Delete" aria-label={`Delete ${chat.title || 'chat'}`} onClick={() => void deleteChat(chat)}><Ico name="close" size={13} /></button>
        </div>
      )) : <p className="small muted">No chats yet for this game.</p>}
    </div>
  );

  const reportsView = (
    <div className="nb-pane nb-reports" role="region" aria-label="Saved reports">
      <ViewHead title="Reports" onBack={back} />
      {reportsQuery.isLoading ? <p className="small muted">Loading the reports…</p> : reports.length ? reports.map((report) => (
        <div key={report.id} className={`nb-report${report.id === openReport ? ' current' : ''}`}>
          <div className="nb-chat-row">
            <button type="button" className="nb-chat-open" onClick={() => setOpenReport(report.id === openReport ? null : report.id)} aria-expanded={report.id === openReport}>
              <span className="nb-chat-title">{report.pinned ? '📌 ' : ''}{report.title}</span>
              <span className="small muted">{agoText(report.updated_at)} · {report.email}{report.headline ? ` · ${report.headline.title}: ${report.headline.value}` : ''}</span>
            </button>
            <button type="button" className="btn sm" aria-pressed={report.pinned} title={report.headline ? 'Show its headline on the Overview' : 'Reports with a headline can be pinned to the Overview'} disabled={!report.headline} onClick={() => void changeReport(report, { pinned: !report.pinned })}>{report.pinned ? 'Unpin' : 'Pin'}</button>
            <button type="button" className="btn sm icon" title="Delete" aria-label={`Delete ${report.title}`} onClick={() => void deleteReport(report)}><Ico name="close" size={13} /></button>
          </div>
          {report.id === openReport ? <div className="nb-report-body nb-md">{reportQuery.data?.id === report.id ? <Markdown source={reportQuery.data.body || ''} onOpen={openLink} /> : <p className="small muted">Loading…</p>}</div> : null}
        </div>
      )) : <p className="small muted">No saved reports.</p>}
    </div>
  );

  const panel = (
    <NutBotPanel
      open={open} onClose={close} messages={messages} busy={busy} onSend={(text, picked) => void send(picked?.command ? `${picked.command.name} ${text}`.trim() : text)} commands={commands} onStop={stop} onNew={newChat}
      context={panelChips(chips, off)} onToggleContext={toggleContext} suggestions={suggestionsFor(section)}
      subtitle={`${game.name} · ${platformLabel(game.platform)}${chatQuery.data?.chat.title && chatQuery.data.chat.id === chatId ? ` · ${chatQuery.data.chat.title}` : ''}`} face={<NbFace state={busy ? 'thinking' : 'idle'} />}
      actions={<>{headerButton('chats', 'Chat history', 'clock')}{headerButton('reports', 'Reports', 'file')}{headerButton('settings', 'Settings', 'settings')}</>}
      view={shown === 'chats' ? chatsView : shown === 'reports' ? reportsView : shown === 'settings' ? settingsView : undefined}
      embedded={embedded} draft={draft} onDraftChange={setDraft}
    />
  );
  // One conversation, drawn in one place: inside the open player viewer, or as the side panel.
  if (slot) return createPortal(panel, slot);
  return <div className="nb-dock" hidden={!open}>{panel}</div>;
}
