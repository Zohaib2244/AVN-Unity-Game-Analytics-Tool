// Analytics processing (admins only, on the Settings page): start or stop the analytics worker, and see
// what it is doing. Game events are collected either way. The status polls every few seconds while the
// page is visible; React rewrites the text in place (focus stays put) and the poll pauses while a change
// is saved.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { queryClient, readKey, useRead, write } from '@/api';
import { agoText, displayDate, number } from '@/lib/format';
import type { ProcessingStatus } from '@/lib/types';
import { QueryRegion, Skeleton, Spinner, useNotify } from '@/components/feedback';
import { PROCESSING_POLL_MS, PROCESSING_STATES, PROCESSING_URL, processingFacts, processingWaiting } from './processing.ts';

export function ProcessingPanel(): ReactElement {
  const { toastError } = useNotify();
  const [saving, setSaving] = useState(false);
  const [ack, setAck] = useState('');
  const toggle = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const query = useRead<ProcessingStatus>(PROCESSING_URL, { refetchInterval: saving ? false : PROCESSING_POLL_MS });

  // The button is disabled while saving, which drops focus; give it back once the answer is shown.
  useEffect(() => { if (!saving && refocus.current) { refocus.current = false; toggle.current?.focus(); } }, [saving]);

  const change = async (status: ProcessingStatus) => {
    if (saving) return;
    const desired = status.desired === 'running' ? 'stopped' : 'running';
    refocus.current = document.activeElement === toggle.current;
    setSaving(true); setAck('');
    try {
      const next = await write<ProcessingStatus>(PROCESSING_URL, { method: 'PUT', body: JSON.stringify({ desired }) });
      queryClient.setQueryData(readKey(PROCESSING_URL), next);
      setAck(desired === 'running' ? 'Start requested.' : 'Stop requested. Events are still collected.');
    } catch (problem) { toastError(problem); }
    finally { setSaving(false); }
  };

  return (
    <section className="panel section-spacing" id="processing-panel">
      <QueryRegion query={query} path={PROCESSING_URL} skeleton={<Skeleton rows={5} columns={2} />} note={false}>{(status) => {
        const [kind, label, explain] = PROCESSING_STATES[status.state] || ['', status.state, ''];
        const worker = status.worker;
        const running = status.desired === 'running';
        return (
          <>
            <div className="panel-header"><div><h2>Analytics processing</h2><p>Prepares the dashboards’ answers in the background, for every game.</p></div><span className={`pill ${kind}`}>{label}</span></div>
            <div className="panel-body">
              <p className="help">{explain}</p>
              <ul className="status-list">
                <li><span>Requested</span><strong>{running ? 'Run' : 'Stop'} · by {status.changed_by} · {displayDate(status.changed_at)}</strong></li>
                <li><span>Worker</span><strong>{!worker ? 'Never seen' : status.state === 'unavailable' ? `Last seen ${agoText(worker.heartbeat_at)}` : `Seen ${Math.round(worker.heartbeat_age_seconds || 0)} s ago`}</strong></li>
                <li><span>Working on</span><strong>{worker && worker.job && status.state !== 'unavailable' ? `${worker.game || 'A game'} · ${worker.job}` : 'Nothing'}</strong></li>
                <li><span>Waiting</span><strong>{processingWaiting(status)}</strong></li>
                <li><span>Last update</span><strong>{status.last_success_at ? displayDate(status.last_success_at) : 'Not yet'}</strong></li>
              </ul>
              <p className="error" role="alert" hidden={!status.error}>{status.errors.map((item) => `${item.game || 'A game'} · ${displayDate(item.at)}: ${item.message}`).join(' · ')}</p>
              <div className="form-actions">
                <button ref={toggle} type="button" className={`button${running ? '' : ' primary'}`} disabled={saving} aria-busy={saving || undefined} onClick={() => void change(status)}>{saving ? <Spinner label="Saving…" /> : running ? 'Stop processing' : 'Start processing'}</button>
                <span className="small muted" role="status">{ack}</span>
              </div>
              <details className="section-spacing"><summary className="small">Each game</summary>
                <ul className="status-list">
                  {status.games.length ? status.games.map((game) => <li key={game.name}><span>{game.name}</span><strong>{processingFacts(game)}{game.views ? ` · ${number(game.views)} prepared answer${game.views === 1 ? '' : 's'}` : ''}</strong></li>) : <li><span>No games yet</span></li>}
                </ul>
              </details>
              <p className="help">Game events are always collected, whether processing runs or not. Stopping is safe at any time: work resumes where it left off.</p>
            </div>
          </>
        );
      }}</QueryRegion>
    </section>
  );
}
