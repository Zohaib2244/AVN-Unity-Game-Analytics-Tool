// Game settings → Data by version: what each app version sent, and deleting the events of builds
// nobody needs any more. Permanent, so it asks for the bundle ID (feedback.md "Undo vs confirm");
// the server deletes in the background and this panel watches until it is done.
import { useEffect, useState, type ReactElement } from 'react';
import { Link } from '@tanstack/react-router';
import { ConfirmDelete } from '@avn/ui';
import { useRead, write } from '@/api';
import { gamePath, gameURL } from '@/lib/games';
import { number } from '@/lib/format';
import type { Game } from '@/lib/types';
import { compareVersions, isReleaseVersion } from '@/lib/versions';
import { QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';

interface VersionRow { app_version: string; events: number; players: number; first_seen: string | null; last_seen: string | null }
interface Versions { versions: VersionRow[]; deleting: string[] }

const day = (value: string | null): string => (value ? new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

/** Newest numbered release first, then versions that aren't x.y.z. */
export function newestFirst(rows: VersionRow[]): VersionRow[] {
  return [...rows].sort((a, b) => Number(isReleaseVersion(b.app_version)) - Number(isReleaseVersion(a.app_version)) || compareVersions(b.app_version, a.app_version));
}

export function VersionDataPanel({ game, bundleId }: { game: Game; bundleId: string }): ReactElement {
  const { toast, toastError } = useNotify();
  const path = `${gameURL(game)}/versions`;
  const [watching, setWatching] = useState(false);
  const query = useRead<Versions>(path, { refetchInterval: watching ? 3000 : false });
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const deleting = query.data?.deleting ?? [];
  const finished = watching && !!query.data && !deleting.length;
  useEffect(() => { if (finished) { setWatching(false); toast('Old version events deleted.'); } }, [finished, toast]);

  const rows = newestFirst(query.data?.versions ?? []);
  const newest = rows.find((row) => isReleaseVersion(row.app_version))?.app_version;
  const picked = rows.filter((row) => chosen.has(row.app_version));
  const total = picked.reduce((sum, row) => sum + row.events, 0);
  const toggle = (version: string, on: boolean) => { const next = new Set(chosen); if (on) next.add(version); else next.delete(version); setChosen(next); };
  const remove = async () => {
    setBusy(true);
    try {
      await write(`${path}/delete`, { method: 'POST', body: JSON.stringify({ versions: [...chosen], confirm: bundleId }) });
      setConfirming(false); setChosen(new Set()); setWatching(true);
      await query.refetch();
    } catch (error) { toastError(error); }
    finally { setBusy(false); }
  };

  return (
    <section className="panel section-spacing" id="version-data">
      <div className="panel-header"><div><h2>Data by version</h2><p>Delete what old builds sent once you no longer need it. This is permanent: <Link to={gamePath(game, 'exports')}>export</Link> first if you might want it later.</p></div></div>
      <div className="panel-body">
        {deleting.length ? <p className="version-deleting"><Ico name="clock" size={15} /> Deleting events from {deleting.join(', ')}. Collection keeps running; this updates when it is done.</p> : null}
        <QueryRegion query={query} path={path} skeleton={<Skeleton rows={4} columns={5} />} note={false}>{() => rows.length ? (
          <>
            <div className="table-wrap"><table className="compact-table">
              <thead><tr><th><span className="sr-only">Choose</span></th><th>Version</th><th className="num">Players</th><th className="num">Events</th><th>First seen</th><th>Last seen</th></tr></thead>
              <tbody>{rows.map((row) => (
                <tr key={row.app_version}>
                  <td><input type="checkbox" aria-label={`Choose ${row.app_version}`} checked={chosen.has(row.app_version)} disabled={!!deleting.length} onChange={(event) => toggle(row.app_version, event.target.checked)} /></td>
                  <td>{row.app_version}{row.app_version === newest ? <> <span className="pill good">newest</span></> : null}{isReleaseVersion(row.app_version) ? null : <> <span className="opt-flag">not x.y.z</span></>}</td>
                  <td className="num">{number(row.players)}</td><td className="num">{number(row.events)}</td>
                  <td>{day(row.first_seen)}</td><td>{day(row.last_seen)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <div className="form-actions version-actions">
              <span className="small muted">{picked.length ? `${picked.length} ${picked.length === 1 ? 'version' : 'versions'} · ${number(total)} events` : 'Tick the versions to delete'}</span>
              <button type="button" className="button danger" disabled={!picked.length || !!deleting.length} onClick={() => setConfirming(true)}><Ico name="trash" size={14} /> Delete events…</button>
            </div>
          </>
        ) : <p className="help">No events with an app version yet.</p>}</QueryRegion>
      </div>
      <ConfirmDelete open={confirming} onClose={() => { if (!busy) setConfirming(false); }} onConfirm={() => void remove()} name={bundleId} busy={busy}
        title={`Delete events from ${picked.length === 1 ? `version ${picked[0]?.app_version}` : `${picked.length} versions`}?`} confirmLabel="Delete events"
        consequences={[
          `${number(total)} events from ${picked.map((row) => row.app_version).join(', ')} are erased for good. They are not moved anywhere and cannot be recovered.`,
          ...(newest && chosen.has(newest) ? [`${newest} is the newest version: players on it are probably still sending events.`] : []),
          'Dashboards for these versions go empty; prepared answers are rebuilt. Collection keeps running.',
        ]} />
    </section>
  );
}
