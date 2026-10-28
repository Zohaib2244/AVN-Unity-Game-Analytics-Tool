// Add AVN Events: the workspace's events standard (one Markdown file) and the prompt that sets it up in a game.
// Download the setup files or copy the prompt for the AI agent the developer runs in the game's code. Nothing here
// checks the game against the standard: the Dictionary shows what it sends and Mappings what the dashboards read.
import { useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { errorMessage, useRead } from '@/api';
import { useSession } from '@/app/session';
import { displayDate, number } from '@/lib/format';
import { copyText } from '@/lib/store';
import type { Game, WorkspaceStandard } from '@/lib/types';
import { QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { SdkDownloadButton } from '@/pages/settings/SdkPanel';
import { SetupFlow } from '@/pages/dictionary/ImportFlow';
import { StandardNotice } from './StandardNotice';

export const standardURL = (workspace: string): string => `/v1/workspaces/${encodeURIComponent(workspace)}/standard`;

/** One-line description of where the standard comes from. */
export const standardSource = (standard: Pick<WorkspaceStandard, 'version' | 'source' | 'uploaded_at' | 'uploaded_by'>): string => (standard.source === 'uploaded'
  ? `Version ${standard.version ?? '?'} · uploaded${standard.uploaded_by ? ` by ${standard.uploaded_by}` : ''} ${displayDate(standard.uploaded_at)}`
  : `Version ${standard.version ?? '?'} · built in`);

/** Downloads the setup ZIP: the one fetch the page makes, a binary download as the rules allow. */
export async function downloadSetup(workspace: string): Promise<void> {
  const response = await fetch(`${standardURL(workspace)}/download`, { credentials: 'same-origin' });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as { detail?: unknown };
    throw new Error(typeof problem.detail === 'string' ? problem.detail : 'Download failed. Please try again.');
  }
  const href = URL.createObjectURL(await response.blob());
  const anchor = Object.assign(document.createElement('a'), { href, download: 'avn-events-setup.zip' });
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60000);
}

export function AddEvents({ game }: { game: Game }): ReactElement {
  const { workspace: open } = useSession();
  const { toast } = useNotify();
  const workspace = game.workspace_id || open || '';
  const path = standardURL(workspace);
  const query = useRead<WorkspaceStandard>(workspace ? path : null);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const download = async () => {
    setDownloading(true); setDownloadError('');
    try { await downloadSetup(workspace); }
    catch (problem) { setDownloadError(errorMessage(problem)); }
    finally { setDownloading(false); }
  };
  const copyPrompt = async (prompt: string) => toast((await copyText(prompt)) ? 'Prompt copied.' : 'Open "Show the prompt" and copy it by hand.');

  return (
    <>
      <StandardNotice game={game} link={false} />
      <QueryRegion query={query} path={path} skeleton={<Skeleton kind="table" rows={3} columns={2} />}>{(standard) => (
        <>
          <p className="standard-line"><Ico name="book" size={16} /> <strong>AVN events standard</strong> <span className="muted">{standardSource(standard)} · <Link to="/settings" hash="standard-panel">change in Settings</Link></span></p>
          <div className="error" role="alert">{downloadError}</div>
          <div className="import-actions setup-actions">
            <button type="button" className="button primary" disabled={downloading} onClick={() => void download()}><Ico name="export" size={15} /> Download setup files</button>
            <button type="button" className="button" onClick={() => void copyPrompt(standard.prompt)}><Ico name="copy" size={15} /> Copy prompt</button>
            <SdkDownloadButton />
          </div>
          <SetupFlow items={[['export', 'Unzip in your game'], ['sparkle', <>Run <code>AGENT_PROMPT.md</code> in your AI agent</>], ['pulse', 'Send a test build']]} />
          <p className="help">A game that sends <code>LEVEL_ANALYSIS</code> gets its level mappings by itself; check them under Mappings.</p>
          <details className="import-prompt standard-events"><summary>Show the {number(standard.events.length)} events</summary>
            <div className="table-wrap"><table className="import-table">
              <thead><tr><th>Event</th><th>States</th></tr></thead>
              <tbody>{standard.events.map((item) => (
                <tr key={item.name}><td><code>{item.name}</code></td><td>{item.states.map((state) => <span key={state}><code>{state}</code> </span>)}</td></tr>
              ))}</tbody>
            </table></div>
          </details>
          <details className="import-prompt"><summary>Show the prompt</summary><textarea readOnly rows={12} aria-label="Agent prompt" id="standard-prompt" value={standard.prompt} /></details>
        </>
      )}</QueryRegion>
    </>
  );
}
