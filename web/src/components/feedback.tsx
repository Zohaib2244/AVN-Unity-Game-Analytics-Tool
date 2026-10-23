// Loading, errors, empty states, confirmations and toasts, the way avn-ux describes them
// (feedback.md): a skeleton that says what is happening after two seconds, every error with a next step,
// reversible actions undo from the toast and permanent ones ask for the name.
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Button, ConfirmDelete, Definition, DialogShell, useToast, type ToastKind } from '@avn/ui';
import { errorMessage, errorStatus, isAbort, read, slowLoadMessage, usualWait } from '@/api';
import { Ico } from './icons';
import { IsoBlocks } from './flavour';

/* ─── Skeletons ─── */
export function Skeleton({ kind = 'table', rows = 5, columns = 5 }: { kind?: 'table' | 'stats' | 'chart'; rows?: number; columns?: number }): ReactElement {
  const line = (key: number) => <span key={key} className="skeleton-line" />;
  const content = kind === 'stats'
    ? <div className="skeleton-stats">{Array.from({ length: 3 }, (_, i) => <div key={i}>{[0, 1, 2].map(line)}</div>)}</div>
    : kind === 'chart'
      ? <div className="skeleton-chart">{Array.from({ length: 12 }, (_, i) => line(i))}</div>
      : <div className="skeleton-rows">{Array.from({ length: rows }, (_, r) => <div key={r} className="skeleton-row">{Array.from({ length: columns }, (_, c) => line(c))}</div>)}</div>;
  return <div className="loading-placeholder" role="status" aria-label="Loading data" aria-busy="true"><div aria-hidden="true">{content}</div></div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }): ReactElement {
  return <span className="inline-loading" role="status"><span className="loading-spinner" aria-hidden="true" />{label}</span>;
}

/**
 * Past a couple of seconds the placeholder says what is happening and counts up, so a long first load
 * doesn't look stuck. `path` names the request so the usual wait can be quoted and paused processing noticed.
 */
export function LoadingNote({ path, began }: { path?: string | null; began: number }): ReactElement | null {
  const [seconds, setSeconds] = useState(() => Math.floor((Date.now() - began) / 1000));
  const [processing, setProcessing] = useState('');
  const asked = useRef(false);
  useEffect(() => { const timer = setInterval(() => setSeconds(Math.floor((Date.now() - began) / 1000)), 1000); return () => clearInterval(timer); }, [began]);
  useEffect(() => {
    if (seconds < 2 || !path || asked.current) return;
    asked.current = true;
    const gamePath = path.match(/^(\/v1\/games\/[^/]+)\/insights\//)?.[1];
    if (gamePath) read<{ paused?: boolean }>(`${gamePath}/insights/processing`).then((state) => { if (state.paused) setProcessing('Background processing is paused. Calculating from collected events…'); }).catch(() => {});
  }, [seconds, path]);
  const message = processing || slowLoadMessage(seconds, path ? usualWait(path) : null);
  if (!message) return null;
  return <p className="loading-note"><Spinner label="" /><span role="status">{message}</span><span className="loading-elapsed" aria-hidden="true">{seconds} s</span></p>;
}

/* ─── Errors ─── */
export function LoadError({ error, onRetry }: { error: unknown; onRetry?: () => void }): ReactElement | null {
  if (isAbort(error)) return null;
  const status = errorStatus(error);
  const message = errorMessage(error, 'Couldn’t load this data. Please try again.');
  const reload = status === 401;
  return (
    <div className="load-error" role="alert">
      <div><Ico name="pulse" size={18} /><p>{message}</p></div>
      {status === 403 ? null : <button type="button" className="button" onClick={() => (reload ? location.reload() : onRetry?.())}><Ico name="refresh" size={14} /> {reload ? 'Reload page' : 'Try again'}</button>}
    </div>
  );
}

/**
 * One region of a page that waits for a query: the skeleton (with the slow-load note) on first load, the
 * error with Retry, otherwise the content, with a quiet "Updating…" line while a newer answer loads.
 */
export function QueryRegion<T>({ query, path, skeleton, children, note = true }: { query: UseQueryResult<T>; path?: string | null; skeleton?: ReactNode; children: (data: T) => ReactNode; note?: boolean }): ReactElement {
  const began = useRef(Date.now());
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (query.data !== undefined || query.isError) { setSlow(false); return; }
    began.current = Date.now();
    const timer = setTimeout(() => setSlow(true), 150);
    return () => clearTimeout(timer);
  }, [query.data, query.isError, query.fetchStatus]);
  if (query.data === undefined) {
    if (query.isError) return <LoadError error={query.error} onRetry={() => query.refetch()} />;
    if (!slow) return <div aria-busy="true" />;
    return <div aria-busy="true">{note ? <LoadingNote path={path} began={began.current} /> : null}{skeleton ?? <Skeleton />}</div>;
  }
  return (
    <div aria-busy={query.isFetching || undefined}>
      {query.isFetching ? <div className="refresh-status"><Spinner label="Updating… Showing previous results." /></div> : null}
      {query.isError ? <LoadError error={query.error} onRetry={() => query.refetch()} /> : null}
      {children(query.data)}
    </div>
  );
}

/* ─── Empty states ─── */
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }): ReactElement {
  return <div className="empty"><IsoBlocks /><h3>{title}</h3>{children ? <p>{children}</p> : null}{action}</div>;
}

export function Heading({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }): ReactElement {
  return <div className="page-heading"><div><h1>{title}</h1>{subtitle ? <p>{subtitle}</p> : null}</div>{actions}</div>;
}

/* ─── Toasts: the old call shape on top of @avn/ui's ToastProvider ─── */
const SUCCESS_WORDS = /\b(copied|saved|added|removed|deleted|created|updated|done|ready|started|hid|restored|renamed|moved|downloaded|imported|applied|cleared|revoked|turned)\b/i;
export type ToastAction = { label: string; run: () => void };
export type NotifyKind = 'status' | 'error' | 'info' | 'warn';
export function useNotify() {
  const api = useToast();
  const notify = useCallback((message: string, action: ToastAction | null = null, kind: NotifyKind = 'status', detail = ''): number => {
    const tone: ToastKind = kind === 'error' ? 'bad' : kind === 'warn' ? 'warn' : kind === 'info' ? 'info' : SUCCESS_WORDS.test(message) ? 'ok' : 'info';
    return api.toast({ kind: tone, title: message, message: detail || undefined, action: action ? { label: action.label, onClick: action.run } : undefined });
  }, [api]);
  const toastError = useCallback((error: unknown) => { if (!isAbort(error)) notify(errorMessage(error, 'The action failed. Please try again.'), null, 'error'); }, [notify]);
  return { toast: notify, toastError, dismiss: api.dismiss };
}

/* ─── Confirmations: reversible actions undo from a toast; these ask first ─── */
export function ConfirmDialog({ open, onClose, title, message, label, danger, onConfirm }: { open: boolean; onClose: () => void; title: string; message: ReactNode; label: string; danger?: boolean; onConfirm: () => Promise<void> | void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setBusy(false); setError(''); } }, [open]);
  const confirm = async () => {
    setBusy(true); setError('');
    try { await onConfirm(); onClose(); }
    catch (caught) { setError(errorMessage(caught)); setBusy(false); }
  };
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }} title={title}>
      <p>{message}</p>
      {error ? <div className="error" role="alert">{error}</div> : null}
      <div className="modal-actions"><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} loadingLabel="Working…" onClick={confirm}>{label}</Button></div>
    </DialogShell>
  );
}
export { ConfirmDelete, DialogShell };

/* ─── Definitions: dotted labels that explain how a number is counted ─── */
export const DEFINITIONS: Record<string, [string, string]> = {
  Players: ['Distinct players in the range. A player is their user_id, or their device_id when there is none.', 'Editor and development data left out unless you include it'],
  Sessions: ['A session starts when the game opens, or when it comes back after 30 or more minutes away.', 'From the SDK'],
  Events: ['Every event the server stored for these days and filters.', ''],
  'Daily active': ['Players with at least one event on the last day of the range.', ''],
  Stickiness: ['Average daily players divided by monthly players. Higher means people come back more often.', ''],
  'Levels seen': ['Distinct levels with at least one start event in the range.', ''],
  'Largest total drop': ['The level the most players stop at before starting the next one.', 'A level with a small sample is not ranked'],
  'Hardest level': ['The level with the lowest share of starters who finish it.', ''],
  'Slowest level': ['The level with the longest median time from start to finish.', ''],
  Started: ['Players who did the first step.', ''],
  Completed: ['Players who reached the last step, in order.', ''],
  Conversion: ['Completed divided by started.', ''],
  'Time to complete': ['The middle time from the first step to the last: half the players were faster.', ''],
  'Events today': ['Events received since midnight, local time.', ''],
  'Events collected': ['Every event stored for this workspace. Nothing is counted twice.', ''],
  'Players today': ['Distinct player IDs with an event today, local time, editor data left out.', ''],
};
/** A label with a definition becomes a focusable dotted term; one without stays plain text. */
export function DefinedLabel({ label }: { label: string }): ReactElement {
  const definition = DEFINITIONS[label];
  if (!definition) return <>{label}</>;
  return <Definition term={label} source={definition[1] || undefined}>{definition[0]}</Definition>;
}

/** A key number card: the label is defined when there is a definition for it. */
export function Metric({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }): ReactElement {
  return <div className="kpi"><div className="eyebrow"><DefinedLabel label={label} /></div><div className="k-v">{value}</div>{note ? <div className="k-c">{note}</div> : null}</div>;
}
