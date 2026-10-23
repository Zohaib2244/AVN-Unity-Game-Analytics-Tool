import { describe, expect, it } from 'vitest';
import { duration, number, percent } from '@/lib/format';
import type { LevelRow, LevelTransition } from '@/lib/types';
import { DRILL_PAGE, cleanNavigation, clampPage, dropChange, dropChangeLabel, dropText, lastDidDetails, lastDidLabel, levelCurve, levelDrillGroup, levelDrop, levelHighlights, levelsNote, pageCount, pageSizeOf, pickReleases, releaseChoices, sortLevels } from './levelMath';

const transition = (over: Partial<LevelTransition> = {}): LevelTransition => ({
  available: true, next_level: 2, drop_percent: 20, total_drop: 10, net_change: 0, left: 0, finished_stopped: 0, kept_going: 0, unknown_progress: 0, ...over,
});
const row = (level: number, over: Partial<LevelRow> = {}): LevelRow => ({
  level, started: 100, completed: 50, completion: 50, tries_per_player: 1, fails: 0, restarts: 0, median_seconds: 60, low_sample: false, transition: transition(), ...over,
});

describe('level navigation memory', () => {
  it('keeps valid saved sort, rows and scope, and falls back to the defaults for anything else', () => {
    expect(cleanNavigation({ sort: 'drop', pageSize: '100', scope: 'first_session' })).toEqual({ sort: 'drop', pageSize: '100', scope: 'first_session' });
    expect(cleanNavigation({ sort: 'nope', pageSize: '10', scope: 'everyone' })).toEqual({ sort: 'level', pageSize: '50', scope: 'all' });
    expect(cleanNavigation(null)).toEqual({ sort: 'level', pageSize: '50', scope: 'all' });
  });
  it('words the note for each scope and keeps the old sentence', () => {
    expect(levelsNote('all')).toBe('Counted from level start, complete, fail and restart events. Click a level to see the players behind it.');
    expect(levelsNote('first_session')).toBe('New players only, within their first session. A drop is a first session that ended on the level. Click a level to see the players behind it.');
  });
});

describe('which group a level opens on', () => {
  it('opens the bigger of the two drops, else who carried on', () => {
    expect(levelDrillGroup(row(1, { transition: transition({ left: 5, finished_stopped: 2, kept_going: 9 }) }))).toBe('left');
    expect(levelDrillGroup(row(1, { transition: transition({ left: 2, finished_stopped: 5 }) }))).toBe('finished_stopped');
    expect(levelDrillGroup(row(1, { transition: transition({ left: 0, finished_stopped: 0, kept_going: 3 }) }))).toBe('kept_going');
    expect(levelDrillGroup(row(1, { transition: transition({ left: 0, finished_stopped: 0, kept_going: 0 }) }))).toBe('left');
  });
  it('ties and missing transitions open on "left"', () => {
    expect(levelDrillGroup(row(1, { transition: transition({ left: 4, finished_stopped: 4 }) }))).toBe('left');
    expect(levelDrillGroup(row(1, { transition: null }))).toBe('left');
    expect(levelDrillGroup(undefined)).toBe('left');
  });
});

describe('what they did last', () => {
  it('shows the label, or a dash when there is none', () => {
    expect(lastDidLabel({ last_action: 'Pressed back' })).toBe('Pressed back');
    expect(lastDidLabel({ last_action: null })).toBe('—');
  });
  it('builds the popover from the last event, when it came and what came next', () => {
    const details = lastDidDetails({ last_action: 'Pressed back', next_action: 'Opened shop', last_event: { text: 'level_fail', gap: 30, after: 'level_start', after_level: 45 } }, 3);
    expect(details.title).toBe('Pressed back');
    expect(details.lines).toEqual([
      { label: 'Last event in that session', body: 'level_fail', mono: true, before: `${duration(30)} after level_start` },
      { label: 'When', body: `${duration(45)} after their last event on level 3` },
      { label: 'Right after level 3', body: 'Opened shop' },
    ]);
  });
  it('leaves out the "right after" line when it repeats the last action, and says when the event was the last on the level', () => {
    const details = lastDidDetails({ last_action: 'Quit', next_action: 'Quit', last_event: { text: 'level_fail', gap: null, after: null, after_level: null } }, 7);
    expect(details.lines.map((line) => line.label)).toEqual(['Last event in that session', 'When']);
    expect(details.lines[1]!.body).toBe('It was their last event on level 7');
    expect(details.lines[0]!.before).toBeUndefined();
  });
  it('falls back to Unknown with no events', () => {
    expect(lastDidDetails({ last_action: null, next_action: null, last_event: null }, 3)).toEqual({ title: 'Unknown', lines: [] });
  });
  it('loads the players of a level 50 at a time', () => {
    expect(DRILL_PAGE).toBe(50);
  });
});

describe('sorting the level table', () => {
  const levels = [
    row(1, { completion: 80, tries_per_player: 1.2, median_seconds: 30, transition: transition({ drop_percent: 10 }) }),
    row(2, { completion: 40, tries_per_player: 2.5, median_seconds: 90, transition: transition({ drop_percent: 60 }) }),
    row(3, { completion: null, tries_per_player: null, median_seconds: null, transition: null }),
    row(4, { completion: 55, tries_per_player: 1.8, median_seconds: 120, transition: transition({ drop_percent: 35 }) }),
  ];
  const order = (sort: Parameters<typeof sortLevels>[1]) => sortLevels(levels, sort).map((item) => item.level);
  it('keeps level order for "level"', () => expect(order('level')).toEqual([1, 2, 3, 4]));
  it('sorts by the largest drop first, levels without a drop last', () => expect(order('drop')).toEqual([2, 4, 1, 3]));
  it('sorts by the lowest completion first, unknown last', () => expect(order('completion')).toEqual([2, 4, 1, 3]));
  it('sorts by the most tries per player first', () => expect(order('tries')).toEqual([2, 4, 1, 3]));
  it('sorts by the slowest median first', () => expect(order('time')).toEqual([4, 2, 1, 3]));
  it('does not change the list it was given', () => {
    const before = levels.map((item) => item.level);
    sortLevels(levels, 'drop');
    expect(levels.map((item) => item.level)).toEqual(before);
  });
});

describe('paging the level table', () => {
  it('counts pages, and "all" is one page', () => {
    expect(pageSizeOf('25', 51)).toBe(25);
    expect(pageCount('25', 51)).toBe(3);
    expect(pageCount('50', 0)).toBe(1);
    expect(pageSizeOf('all', 0)).toBe(1);
    expect(pageCount('all', 300)).toBe(1);
  });
  it('clamps the page to the last one that exists', () => {
    expect(clampPage(5, '25', 51)).toBe(2);
    expect(clampPage(1, '100', 10)).toBe(0);
    expect(clampPage(0, '25', 0)).toBe(0);
  });
});

describe('the key numbers above the table', () => {
  it('ranks the largest drop, hardest and slowest level, leaving out small samples', () => {
    const levels = [
      row(1, { transition: transition({ drop_percent: 90 }), low_sample: true, completion: 5, median_seconds: 500 }),
      row(2, { transition: transition({ drop_percent: 40 }), completion: 30, median_seconds: 200 }),
      row(3, { transition: transition({ available: false, drop_percent: null }), completion: 70, median_seconds: null }),
      row(4, { transition: transition({ drop_percent: 55 }), completion: 60, median_seconds: 100 }),
    ];
    const { largestDrop, hardest, slowest } = levelHighlights(levels);
    expect(largestDrop?.level).toBe(4);
    expect(hardest?.level).toBe(2);
    expect(slowest?.level).toBe(1);
  });
  it('is empty when nothing qualifies', () => {
    expect(levelHighlights([row(1, { low_sample: true, transition: null, median_seconds: null })])).toEqual({ largestDrop: undefined, hardest: undefined, slowest: undefined });
  });
});

describe('the drop that counts for the picture', () => {
  it('ignores small samples and levels with no next level', () => {
    expect(levelDrop(row(1, { transition: transition({ drop_percent: 30 }) }))).toBe(30);
    expect(levelDrop(row(1, { transition: transition({ drop_percent: 30 }), low_sample: true }))).toBeNull();
    expect(levelDrop(row(1, { transition: transition({ available: false }) }))).toBeNull();
    expect(levelDrop(row(1, { transition: null }))).toBeNull();
  });
});

describe('players remaining by level', () => {
  const rows = [
    row(1, { started: 100, transition: transition({ drop_percent: 50 }) }),
    row(2, { started: 50, transition: transition({ drop_percent: 80 }) }),
    row(3, { started: 10, transition: null }),
  ];
  it('needs at least two levels with starters', () => {
    expect(levelCurve([row(1, { started: 10 })])).toBeNull();
    expect(levelCurve([row(1, { started: 10 }), row(2, { started: null as unknown as number })])).toBeNull();
  });
  it('marks the two steepest drops and says so in the sentence', () => {
    const curve = levelCurve(rows)!;
    expect(curve.steepest).toEqual([2, 1]);
    expect(curve.summary).toBe(`Players remaining by level, from ${number(100)} at level 1 to ${number(10)} at level 3. Steepest drops after level 2 and 1.`);
    expect(curve.points.filter((point) => point.big).map((point) => point.flag)).toEqual(['L1 −50%', 'L2 −80%']);
  });
  it('places the line from the peak at the left to the last level, and closes the area on the baseline', () => {
    const curve = levelCurve(rows)!;
    expect(curve.line.startsWith('M40.0 18.0 L')).toBe(true);
    expect(curve.line).toContain('L788.0 ');
    expect(curve.area).toBe(`${curve.line} L788 166 L40 166Z`);
    expect(curve.ticks).toEqual([{ value: 0, y: 166 }, { value: 50, y: 92 }, { value: 100, y: 18 }]);
  });
  it('shades the heat strip by the drop, with no next level as the lightest cell', () => {
    const heat = levelCurve(rows)!.heat;
    expect(heat.map((cell) => cell.bucket)).toEqual([4, 6, 0]);
    expect(heat[2]!.title).toBe('Level 3: no next level yet');
    expect(heat[0]!.title).toBe(`Level 1: ${percent(50)} did not start the next`);
  });
  it('leaves a small sample out of the steepest drops', () => {
    const curve = levelCurve([row(1, { started: 100, low_sample: true, transition: transition({ drop_percent: 90 }) }), row(2, { started: 40, transition: transition({ drop_percent: 20 }) }), row(3, { started: 30, transition: null })])!;
    expect(curve.steepest).toEqual([2]);
  });
});

describe('comparing releases', () => {
  it('lists the releases newest first, numbers in order', () => {
    expect(releaseChoices(['1.9', '1.10', '1.2'])).toEqual(['1.10', '1.9', '1.2']);
  });
  it('compares the second newest (A) with the newest (B) unless the remembered ones are still there', () => {
    const choices = ['1.10', '1.9', '1.2'];
    expect(pickReleases(choices, {})).toEqual({ a: '1.9', b: '1.10' });
    expect(pickReleases(choices, { releaseA: '1.2', releaseB: 'gone' })).toEqual({ a: '1.2', b: '1.10' });
    expect(pickReleases(['1.4'], {})).toBeNull();
  });
  it('shows the drop with its count, a dash when there is no next level', () => {
    expect(dropText(undefined)).toBe('—');
    expect(dropText(row(1, { transition: transition({ drop_percent: null }) }))).toBe('—');
    expect(dropText(row(1, { transition: transition({ drop_percent: 40, total_drop: 12 }) }))).toBe(`${percent(40)} · ${number(12)}`);
    expect(dropText(row(1, { low_sample: true, transition: transition({ drop_percent: 40, total_drop: 12 }) }))).toBe(`${percent(40)} · ${number(12)} · small sample`);
  });
  it('works out the change in points, one decimal, only when both sides have a drop', () => {
    expect(dropChange(row(1, { transition: transition({ drop_percent: 40 }) }), row(1, { transition: transition({ drop_percent: 31.5 }) }))).toBe(-8.5);
    expect(dropChange(row(1, { transition: transition({ drop_percent: 40 }) }), undefined)).toBeNull();
    expect(dropChange(row(1, { transition: null }), row(1, { transition: transition({ drop_percent: 5 }) }))).toBeNull();
  });
  it('words the change with a sign, the direction and the sample', () => {
    expect(dropChangeLabel(null, false)).toEqual({ tone: 'muted', text: 'Not comparable' });
    expect(dropChangeLabel(5, false)).toEqual({ tone: 'loss', text: '↑ +5 pp · more drop' });
    expect(dropChangeLabel(-3.5, false)).toEqual({ tone: 'gain', text: '↓ −3.5 pp · less drop' });
    expect(dropChangeLabel(0, false)).toEqual({ tone: 'muted', text: '0 pp · unchanged' });
    expect(dropChangeLabel(5, true)).toEqual({ tone: 'muted', text: '↑ +5 pp · more drop · small sample' });
  });
});
