// NutBot: the assistant panel on game pages. It talks to the server, which runs a local AI agent CLI
// with this app's tools; answers stream back as newline-delimited JSON (see avn_analytics/nutbot.py).
// The shell owns the launcher, Ctrl+J and "Ask NutBot" (src/app/nutbot.tsx); this draws the panel.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate, useRouterState, useSearch } from '@tanstack/react-router';
import { NutBotPanel, useAppContainer, type NbMessage } from '@avn/ui';
import { useRead } from '@/api';
import { useCurrentGame } from '@/app/GameSection';
import { useNutBot } from '@/app/nutbot';
import { useSession } from '@/app/session';
import { useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { filterState, saveFilters, type FilterState } from '@/lib/filters';
import { number, platformLabel } from '@/lib/format';
import { gamePath } from '@/lib/games';
import { storeGet, storeSet } from '@/lib/store';
import type { Game, NutBotAction, NutBotConversation, NutBotEvent, NutBotInfo, NutBotPrefs, NutBotStoredMessage } from '@/lib/types';
import { buildContext, contextChips, panelChips, scopeLine, suggestionsFor, type PageContext } from './context';
import { Markdown } from './markdown';

const NUTBOT_KEEP = 60; // messages remembered per game in this browser
const PREFS_KEY = 'avn-nutbot-prefs';
const nbKey = (game: Pick<Game, 'id'>) => `avn-nutbot-${game.id}`;
const nbPrefs = (): NutBotPrefs => storeGet<NutBotPrefs>(PREFS_KEY) || {};
const emptyConvo = (): NutBotConversation => ({ session: null, harness: null, messages: [] });
function nbLoad(game: Pick<Game, 'id'>): NutBotConversation {
  const saved = storeGet<NutBotConversation>(nbKey(game));
  return saved && Array.isArray(saved.messages) ? saved : emptyConvo();
}
function nbSave(game: Pick<Game, 'id'>, convo: NutBotConversation): void {
  storeSet(nbKey(game), { session: convo.session, harness: convo.harness, messages: convo.messages.slice(-NUTBOT_KEEP) });
}

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

/** The @avn/ui message for one remembered message. The answer being streamed shows its text as it arrives. */
function toPanelMessage(message: NutBotStoredMessage, streaming: boolean, onOpen: (action: NutBotAction) => void, onLink: (path: string) => void): NbMessage {
  if (message.role === 'user') return { role: 'user', text: message.text };
  const tools = message.tools.map((tool) => ({ name: tool.label, args: tool.name, status: tool.status ?? (tool.done ? 'done' as const : 'running' as const), ms: tool.ms }));
  const body: ReactNode[] = [];
  if (message.text) body.push(<div key="text" className="nb-md"><Markdown source={message.text} onOpen={onLink} /></div>);
    if (message.error) body.push(<p key="error" className="nb-error" role="alert">{message.error}</p>);
  if (message.actions.length) body.push(<div key="actions" className="nb-actions">{message.actions.map((action, index) => <button key={index} type="button" className="btn sm nb-action" onClick={() => onOpen(action)}><Ico name="arrow" size={13} /> {action.title}</button>)}</div>);
  if (message.usage && !streaming) body.push(<div key="meta" className="nb-meta">{message.usage.output_tokens != null ? `${number(message.usage.output_tokens)} tokens out` : ''}{message.seconds ? ` · ${message.seconds}s` : ''}</div>);
  return {
    role: 'bot', tools,
    // While the answer streams the trace stays open ("Working…") until the first words arrive.
    done: !streaming || message.text !== '' || !tools.length,
    text: body.length ? <>{body}</> : undefined,
    scope: message.scope && !streaming && message.text ? message.scope : undefined,
    thought: !streaming ? message.seconds : undefined,
  };
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

  const convoRef = useRef<NutBotConversation>(emptyConvo());
  const controller = useRef<AbortController | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [busy, setBusy] = useState(false);
  const [off, setOff] = useState<Set<string>>(() => new Set());
  const [harness, setHarness] = useState('');
  const [model, setModel] = useState('');
  const [filters, setFilters] = useState<FilterState | null>(null);
  const { open, setOpen, setUsable, pending, takePending } = nutbot;

  // Availability: a game page, this person may use it, and the server has it switched on.
  const usable = Boolean(game && allowed && info?.enabled);
  useEffect(() => { setUsable(usable); }, [usable, setUsable]);
  useEffect(() => { if (!usable && open) setOpen(false); }, [usable, open, setOpen]);

  // Conversations are kept per game; switching game closes the panel and loads that game's chat.
  const gameId = game?.id ?? null;
  useEffect(() => {
    controller.current?.abort();
    convoRef.current = game ? nbLoad(game) : emptyConvo();
    setBusy(false); setOpen(false); bump();
  }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The harness (assistant) and model: the chat's own, then the remembered choice, then the server default.
  const available = useMemo(() => (info?.harnesses || []).filter((item) => item.available), [info]);
  useEffect(() => {
    if (!info) return;
    const prefs = nbPrefs();
    const chosen = [convoRef.current.harness, prefs.harness, info.default, available[0]?.id].find((id) => available.some((item) => item.id === id)) || available[0]?.id || '';
    setHarness(chosen);
    setModel((prefs.models || {})[chosen] || '');
  }, [info, available, gameId, open]);
  const models = useMemo(() => { const item = info?.harnesses.find((h) => h.id === harness); return item?.models?.length ? item.models : ['']; }, [info, harness]);
  const chooseHarness = (id: string) => { setHarness(id); setModel((nbPrefs().models || {})[id] || ''); };

  // The page's filters live in localStorage; re-read them when the panel opens, the address changes and while open.
  const readFilters = useCallback(() => { const next = game ? filterState(game) : null; setFilters((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next)); }, [game]);
  useEffect(() => { readFilters(); }, [readFilters, href, open]);
  useEffect(() => { if (!open) return; const timer = setInterval(readFilters, 1500); return () => clearInterval(timer); }, [open, readFilters]);
  const page: PageContext = useMemo(() => ({ game, section, filters, player: search.player || null }), [game, section, filters, search.player]);
  const chips = useMemo(() => contextChips(page), [page]);
  const toggleContext = (id: string) => setOff((previous) => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  // Drawers slide left to sit beside the panel; the composer gets focus when it opens.
  useEffect(() => {
    if (!appEl) return;
    appEl.classList.toggle('nb-open', open);
    return () => appEl.classList.remove('nb-open');
  }, [appEl, open]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => appEl?.querySelector<HTMLTextAreaElement>('.nb .nb-in textarea')?.focus(), 50);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && (event.target as Element | null)?.closest?.('.nb, .nb-extra')) { event.preventDefault(); close(); } };
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
  const openLink = useCallback((path: string) => { void navigate({ to: path }); }, [navigate]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (busy || !text || !game) return;
    const convo = convoRef.current;
    const prefs = nbPrefs();
    if (convo.harness && convo.harness !== harness) convo.session = null; // another assistant can't continue that chat
    convo.harness = harness;
    convo.messages.push({ role: 'user', text });
    const answer: Extract<NutBotStoredMessage, { role: 'assistant' }> = { role: 'assistant', text: '', tools: [], actions: [], scope: scopeLine(contextChips({ ...page, filters: filterState(game) }), off) };
    convo.messages.push(answer);
    setBusy(true); bump();
    const abort = new AbortController(); controller.current = abort;
    storeSet(PREFS_KEY, { ...prefs, harness, models: { ...(prefs.models || {}), [harness]: model } });
    const started = Date.now();
    try {
      const response = await fetch(`/v1/games/${encodeURIComponent(game.id)}/nutbot/chat`, {
        method: 'POST', credentials: 'same-origin', signal: abort.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, harness, model: model || undefined, session_id: convo.session || undefined, context: buildContext({ ...page, filters: filterState(game) }, off) }),
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
          if (event.type === 'session') convo.session = event.id;
          else if (event.type === 'text') answer.text += event.text;
          else if (event.type === 'tool') answer.tools.push({ name: event.name, label: event.label, done: false, status: 'running', started: Date.now() });
          else if (event.type === 'tool_result') { const running = answer.tools.find((tool) => !tool.done); if (running) { running.done = true; running.status = event.ok === false ? 'error' : 'done'; running.ms = running.started ? Date.now() - running.started : undefined; } }
          else if (event.type === 'action') answer.actions.push(event);
          else if (event.type === 'usage') answer.usage = event;
          else if (event.type === 'error') answer.error = event.message;
          else if (event.type === 'done') answer.seconds = event.seconds;
          bump();
        }
      }
    } catch (error) {
      answer.error = (error as Error).name === 'AbortError' ? 'Stopped.' : (error as Error).message;
    } finally {
      answer.tools.forEach((tool) => { if (!tool.done) { tool.done = true; tool.status = abort.signal.aborted ? 'error' : 'done'; tool.ms = tool.started ? Date.now() - tool.started : undefined; } });
      answer.seconds = answer.seconds || Math.round((Date.now() - started) / 100) / 10;
      controller.current = null; setBusy(false);
      nbSave(game, convo); bump();
    }
  }, [busy, game, harness, model, page, off]);

  // Questions asked from the command palette arrive through the context.
  useEffect(() => {
    if (!pending || !usable || busy) return;
    const text = takePending();
    if (text) void send(text);
  }, [pending, usable, busy, takePending, send]);

  const newChat = () => { if (busy) return; convoRef.current = emptyConvo(); if (game) nbSave(game, convoRef.current); bump(); };
  const stop = () => controller.current?.abort();

  if (!game || !usable) return null;
  const messages = convoRef.current.messages.map((message, index, all) => toPanelMessage(message, busy && index === all.length - 1, openAction, openLink));
  return (
    <>
      <NutBotPanel
        open={open} onClose={close} messages={messages} busy={busy} onSend={(text) => void send(text)} onStop={stop} onNew={newChat}
        context={panelChips(chips, off)} onToggleContext={toggleContext} suggestions={suggestionsFor(section)}
        subtitle={`${game.name} · ${platformLabel(game.platform)}`} face={<NbFace state={busy ? 'thinking' : 'idle'} />}
      />
      {open ? (
        <div className="nb-extra" role="group" aria-label="NutBot settings">
          {available.length ? (
            <>
              <label className="nb-field">Assistant
                <select className="nb-harness" value={harness} onChange={(event) => chooseHarness(event.target.value)}>
                  {(info?.harnesses || []).map((item) => <option key={item.id} value={item.id} disabled={!item.available} title={item.reason || ''}>{item.label}{item.available ? '' : ' (not set up)'}</option>)}
                </select></label>
              <label className="nb-field">Model
                <select className="nb-model" value={model} onChange={(event) => setModel(event.target.value)}>
                  {models.map((item) => <option key={item} value={item}>{item || 'default'}</option>)}
                </select></label>
            </>
          ) : (
            <div className="nb-setup-help">
              <h3>NutBot isn’t set up on this server yet</h3>
              <p>An admin needs to connect an assistant (Claude, OpenCode or Codex). The steps are in the README under “NutBot”.</p>
              {(info?.harnesses || []).map((item) => <p key={item.id} className="small muted"><strong>{item.label}:</strong> {item.reason}</p>)}
            </div>
          )}
          <p className="nb-foot small muted">NutBot can read this game’s data. It asks before saving anything. Answers can be wrong: check the numbers that matter.</p>
        </div>
      ) : null}
    </>
  );
}
