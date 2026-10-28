// Settings → Events standard: the workspace's AVN events standard is one Markdown file. Upload a new version
// whenever it changes (no commit or deploy), download the setup files, or go back to the built-in one.
import { useRef, useState, type ReactElement } from 'react';
import { errorMessage, useRead, write } from '@/api';
import type { WorkspaceStandard } from '@/lib/types';
import { ConfirmDialog, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { downloadSetup, standardSource, standardURL } from '@/pages/event-setup/AddEvents';

export function StandardPanel({ workspace, canManage }: { workspace: string; canManage: boolean }): ReactElement {
  const { toast, toastError } = useNotify();
  const path = standardURL(workspace);
  const query = useRead<WorkspaceStandard>(path);
  const input = useRef<HTMLInputElement>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');

  const upload = async () => {
    const file = input.current?.files?.[0]; if (!file) return;
    setError('');
    try {
      const saved = await write<WorkspaceStandard>(path, { method: 'PUT', body: file, headers: { 'Content-Type': 'text/markdown' } });
      toast(`Standard version ${saved.version} uploaded.`);
    } catch (problem) { setError(errorMessage(problem)); }
    finally { if (input.current) input.current.value = ''; }
  };
  const download = async () => { try { await downloadSetup(workspace); } catch (problem) { toastError(problem); } };

  return (
    <section className="panel section-spacing" id="standard-panel">
      <div className="panel-header"><div><h2>Events standard</h2><p>The <code>.md</code> file games follow, handed out with the setup prompt on Event setup. Upload a new version whenever it changes.</p></div><Ico name="book" size={17} /></div>
      <div className="panel-body">
        <QueryRegion query={query} path={path} skeleton={<Skeleton rows={2} columns={2} />} note={false}>{(standard) => (
          <>
            <ul className="status-list">
              <li><span>In use</span><strong>{standardSource(standard)}</strong></li>
              <li><span>Events</span><strong>{standard.events.length}</strong></li>
            </ul>
            <div className="error" role="alert">{error}</div>
            <div className="sdk-actions">
              {canManage ? <><label className="button primary" htmlFor="standard-file"><Ico name="export" size={15} /> Upload .md</label><input ref={input} id="standard-file" type="file" accept=".md,text/markdown,text/plain" hidden onChange={() => void upload()} /></> : null}
              <button type="button" className="button" onClick={() => void download()}><Ico name="export" size={15} /> Download setup files</button>
              {canManage && standard.source === 'uploaded' ? <button type="button" className="button" onClick={() => setResetting(true)}>Use built-in (v{standard.builtin_version})</button> : null}
            </div>
            {canManage ? <p className="help section-spacing">The first line names the version, like <code># AVN events standard — version 5</code>; each event is a <code># EVENT_NAME</code> heading with <code>### State</code> headings under it.</p> : null}
          </>
        )}</QueryRegion>
      </div>
      <ConfirmDialog open={resetting} onClose={() => setResetting(false)} title="Go back to the built-in standard?" label="Use built-in"
        message="The uploaded file is removed from this workspace. Download the setup files first if you want to keep a copy."
        onConfirm={async () => { await write(path, { method: 'DELETE' }); toast('Using the built-in standard.'); }} />
    </section>
  );
}
