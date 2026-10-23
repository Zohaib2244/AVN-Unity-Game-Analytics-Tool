// One level: its numbers, the links to the levels either side, and the players behind it (LevelDrill).
import type { ReactElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { QueryRegion, Skeleton } from '@/components/feedback';
import type { ActiveFilters } from '@/lib/filters';
import { duration, number, percent } from '@/lib/format';
import { gamePath } from '@/lib/games';
import type { Game, LevelsResult } from '@/lib/types';
import { LevelDrill } from './LevelDrill';
import type { LevelScope } from './levelMath';
import type { DrillState } from './levelPaths';

type Props = {
  game: Game;
  filters: ActiveFilters;
  scope: LevelScope;
  level: number;
  query: UseQueryResult<LevelsResult>;
  path: string;
  memory: Map<number, DrillState>;
};

export function LevelPage({ game, filters, scope, level, query, path, memory }: Props): ReactElement {
  const list = gamePath(game, 'levels');
  return (
    <QueryRegion query={query} path={path} skeleton={<Skeleton kind="table" rows={8} columns={7} />}>
      {(data) => {
        const row = data.levels.find((item) => item.level === level);
        if (!row) {
          return (
            <section className="panel">
              <div className="panel-body">
                <Link to={list} search={{}} className="back-link">← All levels</Link>
                <p className="help">Nobody started level {level} in the selected days and filters.</p>
              </div>
            </section>
          );
        }
        const numbers = data.levels.map((item) => item.level).sort((a, b) => a - b);
        const at = numbers.indexOf(level);
        const before = numbers[at - 1]; const after = numbers[at + 1];
        const drop = row.transition;
        const step = (target: number | undefined, label: string) => (target == null ? null : <Link to={list} search={{ level: String(target) }} className="button small-button">{label}</Link>);
        return (
          <section className="panel level-page">
            <div className="panel-header">
              <div>
                <Link to={list} search={{}} className="back-link">← All levels</Link>
                <h2>Level {row.level}</h2>
                <div className="level-page-summary">
                  <span><strong>{number(row.started)}</strong> started</span>
                  <span><strong>{number(row.completed)}</strong> finished{row.completion != null ? ` · ${percent(row.completion)}` : ''}</span>
                  {drop?.available ? <span><strong>{percent(drop.drop_percent ?? 0)}</strong> dropped · {number(drop.total_drop)} did not start level {drop.next_level}</span> : <span className="muted">drop: not enough data</span>}
                  <span><strong>{row.tries_per_player ?? '—'}</strong> tries / player</span>
                  <span>median <strong>{duration(row.median_seconds)}</strong></span>
                </div>
              </div>
              <div className="quiet-actions">{step(before, `← Level ${before}`)}{step(after, `Level ${after} →`)}</div>
            </div>
            <div className="panel-body">
              <div className="level-page-split">
                <LevelDrill key={level} game={game} filters={filters} scope={scope} level={level} row={row} memory={memory} />
              </div>
            </div>
          </section>
        );
      }}
    </QueryRegion>
  );
}
