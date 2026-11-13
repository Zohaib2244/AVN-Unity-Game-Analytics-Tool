// The level table's answer strip (LevelAnswer) and its "Chart" dialog: the four levels worth a look (a click scrolls to that level's row)
// and players remaining by level. Kept out of the page because it is read now and then, not every visit.
import type { ReactElement } from 'react';
import { motion } from 'motion/react';
import { DialogShell } from '@avn/ui';
import { Ico, type IcoName } from '@/components/icons';
import { duration, number, percent, shareText } from '@/lib/format';
import { rise } from '@/lib/motion';
import type { LevelRow } from '@/lib/types';
import { LevelViz } from './LevelViz';
import { heatOf } from './levelDisplay';
import { levelHighlights } from './levelMath';

/**
 * The answer above the level table, in words: the level that loses the most players and the other levels worth
 * a look. Each one scrolls to its row.
 */
export function LevelAnswer({ levels, minimum, excludeReturners, onJump }: { levels: LevelRow[]; minimum: number; excludeReturners: boolean; onJump: (level: number) => void }): ReactElement {
  const { largestDrop, failQuit, hardest, slowest } = levelHighlights(levels);
  const drop = largestDrop?.transition;
  const others: Array<{ key: string; label: string; row: LevelRow | undefined; value: string }> = [
    { key: 'quit', label: 'Most quit after failing', row: failQuit, value: failQuit?.transition?.fail_drop_percent == null ? '' : shareText(failQuit.transition.failed_left, failQuit.transition.fail_drop_percent) },
    { key: 'hard', label: 'Fewest finish', row: hardest, value: hardest ? shareText(hardest.completed, hardest.completion ?? 0) : '' },
    { key: 'slow', label: 'Slowest', row: slowest, value: slowest ? duration(slowest.median_seconds) : '' },
  ].filter((item) => item.row);
  return (
    <div className="sumstrip levels-answer">
      {largestDrop && drop ? (
        <p>
          <button type="button" className="answer-level" onClick={() => onJump(largestDrop.level)}>Level {largestDrop.level}</button> loses the most players: <strong>{percent(drop.drop_percent ?? 0)}</strong> of the {number(largestDrop.started)} who started it ({number(drop.total_drop)}) never started level {drop.next_level}{excludeReturners ? ' and did not come back' : ''}.
        </p>
      ) : <p className="muted">No level has the {number(minimum)} players needed to name a worst one yet.</p>}
      <span className="answer-others">
        {others.map((item) => <button key={item.key} type="button" className="answer-chip" onClick={() => onJump(item.row!.level)}><span>{item.label}</span><b>Level {item.row!.level}</b><em>{item.value}</em></button>)}
      </span>
    </div>
  );
}

type Spot = { key: string; icon: IcoName; label: string; row: LevelRow | undefined; value: string; hot: boolean };

export function LevelSummary({ open, onClose, levels, minimum, dropFlag, quitFlag, firstSession, excludeReturners, onJump, onOpen }: {
  open: boolean; onClose: () => void; levels: LevelRow[]; minimum: number; dropFlag: number; quitFlag: number; firstSession: boolean; excludeReturners: boolean;
  onJump: (level: number) => void; onOpen: (level: number) => void;
}): ReactElement {
  const { largestDrop, failQuit, hardest, slowest } = levelHighlights(levels);
  const drop = largestDrop?.transition?.drop_percent ?? null; const quit = failQuit?.transition?.fail_drop_percent ?? null;
  const spots: Spot[] = [
    { key: 'drop', icon: 'trend', label: 'Biggest drop', row: largestDrop, value: drop == null ? '' : shareText(largestDrop?.transition?.total_drop ?? 0, drop), hot: heatOf(drop, dropFlag).over },
    { key: 'quit', icon: 'exit', label: 'Most quit', row: failQuit, value: quit == null ? '' : shareText(failQuit?.transition?.failed_left ?? 0, quit), hot: heatOf(quit, quitFlag).over },
    { key: 'hard', icon: 'alert', label: 'Hardest', row: hardest, value: hardest ? `${shareText(hardest.completed, hardest.completion ?? 0)} finish` : '', hot: false },
    { key: 'slow', icon: 'clock', label: 'Slowest', row: slowest, value: slowest ? duration(slowest.median_seconds) : '', hot: false },
  ];
  const first = levels[0]; const last = levels[levels.length - 1];
  const go = (level: number) => { onClose(); onJump(level); };
  return (
    <DialogShell open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Players remaining by level">
      <div className="levels-summary">
        <p className="summary-range">{first && last ? `${number(levels.length)} levels · ${first.level} to ${last.level}${firstSession ? ' · new players, first session' : ''}${excludeReturners ? ' · stops with no return observed' : ''}` : 'No levels yet'}</p>
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
