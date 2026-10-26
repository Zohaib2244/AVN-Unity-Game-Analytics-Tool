// Headlines pinned from NutBot's reports: one small figure each, opening the report in NutBot.
import type { ReactElement } from 'react';
import { useRead } from '@/api';
import { useNutBot } from '@/app/nutbot';
import { useSession } from '@/app/session';
import { Metric } from '@/components/feedback';
import { gameURL } from '@/lib/games';
import { storeSet } from '@/lib/store';
import type { Game, NutBotReportRow } from '@/lib/types';
import { nbAllowed } from '../nutbot/NutBot';

export const OPEN_REPORT_KEY = 'avn-nutbot-open-report';

export function PinnedReports({ game }: { game: Game }): ReactElement | null {
  const { me, workspace } = useSession();
  const nutbot = useNutBot();
  const allowed = nbAllowed(me, game, workspace);
  const query = useRead<{ reports: NutBotReportRow[] }>(`${gameURL(game)}/nutbot/reports?pinned=true`, { enabled: allowed });
  const pinned = (query.data?.reports ?? []).filter((report) => report.headline);
  if (!allowed || !pinned.length) return null;
  return (
    <>
      <div className="strip-h"><span className="eyebrow">Pinned from NutBot</span></div>
      <div className="kpis">
        {pinned.slice(0, 4).map((report) => (
          <button key={report.id} type="button" className="kpi-button" onClick={() => { storeSet(OPEN_REPORT_KEY, { game: game.id, report: report.id }); nutbot.setOpen(true); }} title="Open the report in NutBot">
            <Metric label={report.headline!.title} value={report.headline!.value} note={report.headline!.sub || report.title} />
          </button>
        ))}
      </div>
    </>
  );
}
