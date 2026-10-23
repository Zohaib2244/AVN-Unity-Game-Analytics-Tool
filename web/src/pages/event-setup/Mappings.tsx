// Mappings: which events stand for the moments the dashboards use (level started, completed, failed, …). Each
// moment shows its sources, the add form, the suggestions the server found, and the rules it cannot place.
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { write } from '@/api';
import { gameURL, gamePath } from '@/lib/games';
import { number } from '@/lib/format';
import { conceptName } from '@/lib/concepts';
import type { Game, MappingConcept, MappingRule, MappingSource, MappingsData } from '@/lib/types';
import { ConfirmDialog, QueryRegion, Skeleton, useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { MappingForm, type FormState } from './MappingForm';
import { ruleText, sameRule } from './rules';

export const levelsText = (levels: MappingSource['levels']): string => (levels ? `levels ${number(levels.min)}–${number(levels.max)}` : '');

export function Mappings({ game, query, version, event, concept, onVersion }: {
  game: Game; query: UseQueryResult<MappingsData>; version: string; event: string; concept: string; onVersion: (version: string) => void;
}): ReactElement {
  return (
    <QueryRegion query={query} path={`${gameURL(game)}/mappings`} skeleton={<><Skeleton kind="stats" /><Skeleton kind="table" /></>}>
      {(data) => <MappingsBody game={game} data={data} version={version} event={event} concept={concept} onVersion={onVersion} />}
    </QueryRegion>
  );
}

function MappingsBody({ game, data, version, event, concept, onVersion }: {
  game: Game; data: MappingsData; version: string; event: string; concept: string; onVersion: (version: string) => void;
}): ReactElement {
  const { toast } = useNotify();
  const [forms, setForms] = useState<Record<string, FormState>>({});
  const [removing, setRemoving] = useState<{ name: string; rule: MappingRule } | null>(null);
  const opened = useRef(false);
  const rulesOf = (name: string): MappingRule[] => data.definitions[name] ?? [];
  const save = (name: string, rules: MappingRule[]) => write(`${gameURL(game)}/dictionary/${encodeURIComponent(name)}/mappings`, { method: 'PUT', body: JSON.stringify({ canonical: rules }) });

  /** A fresh form: the chosen event if the address named one, otherwise the event that suggests it. */
  const openForm = (key: string, suggested: { event: string; rule: MappingRule } | null = null) => {
    setForms((current) => {
      const previous = current[key];
      const candidate = data.events.find((item) => item.suggestions.some((rule) => rule.action === key));
      const start: FormState = {
        event: previous?.event || event || candidate?.name || data.events[0]?.name || '',
        param: '', op: 'eq', value: '', number_param: '', app_version: version,
      };
      if (suggested) Object.assign(start, { ...suggested.rule, event: suggested.event });
      else {
        const guess = data.events.find((item) => item.name === start.event)?.suggestions.find((rule) => rule.action === key);
        if (guess) Object.assign(start, { param: guess.param, op: guess.op, value: guess.value, number_param: guess.number_param, app_version: guess.app_version });
      }
      return { ...current, [key]: start };
    });
  };

  // An address that names a moment opens its form once the data is here.
  useEffect(() => {
    if (opened.current || !concept || !data.concepts.some((item) => item.key === concept)) return;
    opened.current = true;
    openForm(concept);
  }, [concept, data]);

  const chosen = data.events.find((item) => item.name === event);
  const concepts = data.concepts;
  const mapped = concepts.filter((item) => item.status === 'mapped').length;
  const auto = concepts.filter((item) => item.status === 'auto').length;
  const covered = mapped + auto;
  const versions = [...new Set([...data.versions, version].filter(Boolean))];
  const suggestions = data.events.flatMap((item) => item.suggestions.filter((rule) => !rulesOf(item.name).some((existing) => sameRule(existing, rule))).map((rule) => ({ event: item.name, rule })));

  const removeButton = (name: string, rule: MappingRule) => (
    <button type="button" className="icon-button" aria-label={`Remove mapping of ${name}`} title="Remove mapping" onClick={() => setRemoving({ name, rule })}><Ico name="close" size={14} /></button>
  );

  const sourceLine = (item: MappingConcept, source: MappingSource) => (
    <li key={`${source.event}-${source.via}`} className="mapping-source">
      <Link className="row-title" to={gamePath(game, 'dictionary')} search={{ event: source.event }}><code>{source.event}</code></Link>
      {source.via === 'mapped' ? <span className="small muted">{ruleText(source.rule)}</span> : null}
      <span className="small muted">{number(source.events)} events · {number(source.players)} players{item.needs && levelsText(source.levels) ? ` · ${levelsText(source.levels)}` : ''}</span>
      {item.needs && !source.levels ? <span className="pill bad">No level number</span> : null}
      {source.via === 'mapped' ? removeButton(source.event, source.rule) : null}
    </li>
  );

  const row = (item: MappingConcept) => {
    const status = item.status === 'mapped' ? <span className="pill good">Mapped</span> : item.status === 'auto' ? <span className="pill good">Auto</span> : <span className="pill bad">Not found</span>;
    return (
      <div className="mapping-row" key={item.key} data-concept={item.key}>
        <div className="mapping-name"><strong title={`Used by ${item.used_by.join(', ')}`}>{item.label}</strong>{status}</div>
        <ul className="mapping-sources">
          {item.sources.map((source) => sourceLine(item, source))}
          {item.silent_rules.map((silent) => (
            <li key={`${silent.event}-silent`} className="mapping-source">
              <code>{silent.event}</code><span className="small muted">{ruleText(silent.rule)}</span><span className="pill">No matches</span>{removeButton(silent.event, silent.rule)}
            </li>
          ))}
        </ul>
        <button type="button" className="button" onClick={() => openForm(item.key)}><Ico name="plus" size={14} /> Add</button>
        {forms[item.key] ? (
          <div className="mapping-form-slot">
            <MappingForm
              game={game} data={data} concept={item} state={forms[item.key]!} rules={rulesOf(forms[item.key]!.event)}
              onChange={(next) => setForms((current) => ({ ...current, [item.key]: next }))}
              onClose={() => setForms((current) => { const next = { ...current }; delete next[item.key]; return next; })}
              onSaved={() => setForms((current) => { const next = { ...current }; delete next[item.key]; return next; })}
              save={save}
            />
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="mapping-bar">
        <div className="mapping-progress">
          <span><strong>{number(covered)} of {number(concepts.length)}</strong> moments covered</span>
          <progress className="mapping-meter" max={concepts.length} value={covered} aria-label="Moments covered" />
        </div>
        <div className="inline-field">
          <label htmlFor="mapping-version">App version</label>
          <select id="mapping-version" value={version} onChange={(e) => { setForms({}); onVersion(e.target.value); }}>
            <option value="">All versions</option>
            {versions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>
      </div>
      {data.conflicts.length ? (
        <div className="notice-banner" role="alert">
          <Ico name="pulse" size={18} />
          <div><strong>Overlapping mappings.</strong> {data.conflicts.map((item) => `${item.event}: ${number(item.events)} events count as more than one level action`).join('; ')}. Add a condition such as <code>STATE = Completed</code>, or remove the broad rule.</div>
        </div>
      ) : null}
      {chosen ? (
        <section className="panel section-spacing mapping-ask"><div className="panel-body">
          <p>What does <code>{chosen.name}</code> stand for?{rulesOf(chosen.name).length ? <span className="muted small"> Already: {rulesOf(chosen.name).map((rule) => conceptName(rule.action)).join(', ')}.</span> : null}</p>
          <div className="quiet-actions">{concepts.map((item) => <button key={item.key} type="button" className="button" onClick={() => openForm(item.key)}>{item.label}</button>)}</div>
        </div></section>
      ) : null}
      <section className="panel mapping-list">{concepts.map(row)}</section>
      {suggestions.length ? (
        <section className="panel section-spacing">
          <div className="panel-header"><div><h2><Ico name="sparkle" size={16} /> Suggested <span className="count">{number(suggestions.length)}</span></h2></div></div>
          <div className="panel-body mapping-suggestions">
            {suggestions.map((item) => (
              <div key={`${item.event}-${item.rule.action}-${item.rule.param}`}>
                <code>{item.event}</code><span>{conceptName(item.rule.action)} · {ruleText(item.rule)}</span>
                <button type="button" className="button" onClick={() => openForm(item.rule.action, item)}>Review</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {data.other.length ? (
        <details className="mapping-how"><summary>Other mappings ({number(data.other.length)})</summary>
          <table className="compact-table"><tbody>
            {data.other.map((item) => (
              <tr key={`${item.event}-${item.rule.action}-${item.rule.param}`}>
                <td><code>{item.event}</code></td>
                <td><code>{item.rule.action}</code> <span className="small muted">{ruleText(item.rule)}</span></td>
                <td className="num">{removeButton(item.event, item.rule)}</td>
              </tr>
            ))}
          </tbody></table>
        </details>
      ) : null}
      <details className="mapping-how"><summary>Standard event format</summary>
        <div><p>Send one event per moment: <code>level_started</code>, <code>level_completed</code>, <code>level_failed</code> or <code>level_restarted</code>, with <code>{'{"level": 3}'}</code>. Also recognised: <code>LEVEL_ANALYSIS</code> with <code>{'{"Started": 3}'}</code>, <code>{'{"action": "started", "level": 3}'}</code> and <code>{'{"STATE": "Started", "NUMBER": 3}'}</code>.</p></div>
      </details>
      {removing ? (
        <ConfirmDialog open onClose={() => setRemoving(null)} label="Remove mapping"
          title={`Stop treating ${removing.name} as ${conceptName(removing.rule.action).toLowerCase()}?`}
          message="Only the mapping is removed. The event, its description and the stored data stay as they are."
          onConfirm={async () => {
            await save(removing.name, rulesOf(removing.name).filter((item) => !sameRule(item, removing.rule)));
            toast('Mapping removed.');
          }} />
      ) : null}
    </>
  );
}
