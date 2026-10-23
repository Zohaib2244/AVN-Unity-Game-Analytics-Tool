// Settings (avn-ux "settings" pattern): sections of labelled fields. Appearance is saved in this browser;
// the workspace confidence defaults and analytics processing are saved on the server.
import { useCallback, type ReactElement } from 'react';
import { write } from '@/api';
import { useSession } from '@/app/session';
import { PALETTES, useTheme } from '@/app/theme';
import { localTimezone } from '@/lib/format';
import type { AnalyticsThresholds } from '@/lib/types';
import { Heading, useNotify } from '@/components/feedback';
import { FormError, useSubmit, type Values } from '@/components/forms';
import { Ico } from '@/components/icons';
import { SdkPanel } from './settings/SdkPanel';
import { ProcessingPanel } from './settings/Processing.tsx';

/** Theme and palette buttons; the choice lives on <html> and is saved in this browser only. */
export function Appearance(): ReactElement {
  const { theme, palette, setTheme, setPalette } = useTheme();
  return (
    <section className="panel section-spacing">
      <div className="panel-header"><h2>Appearance</h2><Ico name="settings" size={17} /></div>
      <div className="panel-body">
        <p className="eyebrow">Theme</p>
        <div className="seg-row range-modes" id="theme-modes">
          {(['dark', 'light'] as const).map((mode) => <button key={mode} type="button" data-theme-mode={mode} aria-pressed={theme === mode} onClick={() => setTheme(mode)}>{mode}</button>)}
        </div>
        <p className="eyebrow">Palette</p>
        <div className="palette-grid" id="palette-grid">
          {PALETTES.map((id) => <button key={id} type="button" className="palette-btn" data-palette-id={id} aria-pressed={palette === id} onClick={() => setPalette(id)}><span className="palette-swatch" data-swatch={id}><i /><i /><i /></span>{id}</button>)}
        </div>
        <p className="help section-spacing">Saved in this browser only.</p>
      </div>
    </section>
  );
}

function ThresholdsForm({ thresholds, canManage, workspace }: { thresholds: AnalyticsThresholds; canManage: boolean; workspace: string | null }): ReactElement {
  const session = useSession();
  const { toast } = useNotify();
  const submit = useCallback(async (values: Values) => {
    const payload = Object.fromEntries(Object.entries({ ...values, retention_min_users: String(thresholds.retention_min_users) }).map(([key, value]) => [key, Number(value)]));
    await write(`/v1/workspaces/${encodeURIComponent(workspace ?? '')}/analytics-thresholds`, { method: 'PATCH', body: JSON.stringify(payload) });
    await session.refresh();
    toast('Workspace confidence defaults saved.');
  }, [thresholds.retention_min_users, workspace, session, toast]);
  const { onSubmit, busy, error } = useSubmit(submit);
  return (
    <section className="panel section-spacing">
      <div className="panel-header"><div><h2>Analysis confidence defaults</h2><p>Used for every game unless that game has an override.</p></div></div>
      <form className="panel-body" id="workspace-threshold-form" onSubmit={onSubmit}>
        <div className="threshold-grid">
          <div className="field"><label htmlFor="workspace-levels-min">Level minimum players</label><input id="workspace-levels-min" name="levels_min_players" type="number" min={1} max={1000000} defaultValue={thresholds.levels_min_players} disabled={!canManage} /></div>
          <div className="field"><label htmlFor="workspace-funnels-min">Funnel minimum players</label><input id="workspace-funnels-min" name="funnels_min_players" type="number" min={1} max={1000000} defaultValue={thresholds.funnels_min_players} disabled={!canManage} /></div>
        </div>
        <FormError error={error} />
        {canManage ? <button className="button primary" type="submit" disabled={busy} aria-busy={busy || undefined}>{busy ? 'Working…' : 'Save workspace defaults'}</button> : <p className="help">Only the workspace admin can change these defaults.</p>}
      </form>
    </section>
  );
}

export function SettingsPage(): ReactElement {
  const { me, overview, workspace } = useSession();
  const thresholds = overview.analytics_thresholds;
  return (
    <>
      <Heading title="Settings" subtitle="Appearance and workspace details." />
      <div className="section-grid">
        <div>
          <SdkPanel />
          <Appearance />
          <ThresholdsForm key={`${thresholds.levels_min_players}-${thresholds.funnels_min_players}`} thresholds={thresholds} canManage={me.can_manage_team} workspace={workspace} />
          {me.can_manage_team ? <ProcessingPanel /> : null}
          <section className="panel section-spacing">
            <div className="panel-header"><h2>Workspace</h2><Ico name="server" size={17} /></div>
            <div className="panel-body">
              <ul className="status-list">
                <li><span>Application</span><strong>AVN Analytics</strong></li>
                <li><span>Local timezone</span><strong>{localTimezone}</strong></li>
                <li><span>Export contents</span><strong>Parquet · JSONL.gz · dictionary · AI guide</strong></li>
                <li><span>Collection address</span><code>{overview.ingest_url}</code></li>
              </ul>
              <p className="help section-spacing">Storage location and limits are set in the server's .env file.</p>
            </div>
          </section>
        </div>
        <aside className="aside-card"><Ico name="shield" size={25} /><h3>Protect this workspace</h3><p>This dashboard has no sign-in of its own. Put it behind your own access control, such as Cloudflare Access, a VPN or a private network, and never expose it directly.</p></aside>
      </div>
    </>
  );
}
