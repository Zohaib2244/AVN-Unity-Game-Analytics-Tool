// "Summary" of the level table, in a dialog: the four levels worth a look (a click scrolls to that level's row)
// and players remaining by level. Kept out of the page because it is read now and then, not every visit.
import type { ReactElement } from 'react';
import { motion } from 'motion/react';
import { DialogShell } from '@avn/ui';
import { Ico, type IcoName } from '@/components/icons';
import { duration, number, percent } from '@/lib/format';
import { rise } from '@/lib/motion';
import type { LevelRow } from '@/lib/types';
import { LevelViz } from './LevelViz';
import { heatOf } from './levelDisplay';
import { levelHighlights } from './levelMath';

type Spot = { key: string; icon: IcoName; label: string; row: LevelRow | undefined; value: string; hot: boolean };

export function LevelSummary({ open, onClose, levels, minimum, dropFlag, quitFlag, firstSession, onJump, onOpen }: {
  open: boolean; onClose: () => void; levels: LevelRow[]; minimum: number; dropFlag: number; quitFlag: number; firstSession: boolean;
  onJump: (level: number) => void; onOpen: (level: number) => void;
}): ReactElement {
  const { largestDrop, failQuit, hardest, slowest } = levelHighlights(levels);
  const drop = largestDrop?.transition?.drop_percent ?? null; const quit = failQuit?.transition?.fail_drop_percent ?? null;
  const spots: Spot[] = [
    { key: 'drop', icon: 'trend', label: 'Biggest drop', row: largestDrop, value: drop == null ? '' : percent(drop), hot: heatOf(drop, dropFlag).over },
    { key: 'quit', icon: 'exit', label: 'Most quit', row: failQuit, value: quit == null ? '' : percent(quit), hot: heatOf(quit, quitFlag).over },
    { key: 'hard', icon: 'alert', label: 'Hardest', row: hardest, value: hardest ? `${percent(hardest.completion ?? 0)} finish` : '', hot: false },
    { key: 'slow', icon: 'clock', label: 'Slowest', row: slowest, value: slowest ? duration(slowest.median_seconds) : '', hot: false },
  ];
  const first = levels[0]; const last = levels[levels.length - 1];
  const go = (level: number) => { onClose(); onJump(level); };
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Levels summary">
      <div className="levels-summary">
        <p className="summary-range">{first && last ? `${number(levels.length)} levels · ${first.level} to ${last.level}${firstSession ? ' · new players, first session' : ''}` : 'No levels yet'}</p>
        <div className="summary-spots">
          {spots.map((spot, index) => (
            <motion.button key={spot.key} type="button" className="summary-spot" disabled={!spot.row} onClick={() => spot.row && go(spot.row.level)} {...rise(index)} whileTap={{ scale: 0.97 }}>
              <small><Ico name={spot.icon} size={13} />{spot.label}</small>
              {spot.row ? <><b>Level {spot.row.level}</b><em className={spot.hot ? 'hot' : ''}>{spot.value}</em></> : <span className="muted">needs {number(minimum)}+ players</span>}
            </motion.button>
          ))}
        </div>
        <LevelViz levels={levels} dropFlag={dropFlag} onOpen={(level) => { onClose(); onOpen(level); }} />
        <p className="foot-note"><Ico name="flag" size={12} /> Amber dots are levels over your {dropFlag}% drop flag · click a card to find its row, a point to open the level.</p>
      </div>
    </DialogShell>
  );
}
