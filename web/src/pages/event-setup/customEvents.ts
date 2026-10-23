// The pure part of the Add AVN Events tab: custom event editing (names, the model the dialog edits, the body
// it saves), the tiers and version choice that shape the setup files, and the unlisted-event wording.
import { number } from '@/lib/format';
import type { CustomEvent, StandardVersion, UnlistedEvent } from '@/lib/types';

export const STANDARD_TIERS: Array<[string, string, string]> = [
  ['core', 'Core', 'Levels, ads, coins, app. Always on.'],
  ['standard', 'Standard', 'Tutorials, powerups, menus, purchases, player.'],
  ['extended', 'Extended', 'Device hardware.'],
];
export const DEFAULT_TIERS = ['core', 'standard'];
export const DEFAULT_CHOICE = { version: '@latest', newer: true };
export type VersionChoice = { version: string; newer: boolean };

export const upperSnake = (value: string): string => value.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
export const noSpaces = (value: string): string => value.replace(/\s+/g, '');

/** Tiers the person chose; core is always in, and anything unknown is dropped. */
export function tiersFrom(saved: unknown): string[] {
  if (!Array.isArray(saved)) return DEFAULT_TIERS;
  return STANDARD_TIERS.map(([key]) => key).filter((key) => key === 'core' || saved.includes(key));
}

/** The query of the setup downloads and the summary: the chosen tiers, plus `custom` when a custom event is not core. */
export function standardQuery(tiers: string[], hasCustomBeyondCore: boolean): string {
  const all = [...tiers, ...(hasCustomBeyondCore ? ['custom'] : [])];
  return new URLSearchParams(all.map((tier) => ['tiers', tier])).toString();
}

/** The status address for a version choice (no choice → the newest with the defaults). */
export function statusPath(gameId: string, choice: VersionChoice): string {
  const query = choice.version ? `?${new URLSearchParams({ version: choice.version, newer: String(choice.newer) })}` : '';
  return `/v1/games/${encodeURIComponent(gameId)}/standard${query}`;
}

/** The version the filter shows as selected: '@latest' is the newest version that has players. */
export function selectedVersion(versions: StandardVersion[], choice: VersionChoice): string {
  const latest = versions.find((item) => item.players)?.version;
  return choice.version === '@latest' ? (latest ?? '') : choice.version;
}

/** What a choice from the version filter saves: picking the newest version follows the newest from then on. */
export function versionAfterPick(versions: StandardVersion[], picked: string): string {
  const latest = versions.find((item) => item.players)?.version;
  return picked && picked === latest ? '@latest' : picked;
}

export const versionLabel = (item: StandardVersion, ago: string): string => `${item.version} · ${number(item.players)} player${item.players === 1 ? '' : 's'} · last seen ${ago}`;

/** The first three versions an unlisted event was seen in, then how many more. */
export function versionsNote(versions: string[]): string {
  const more = versions.length > 3 ? ` +${versions.length - 3}` : '';
  return versions.length ? `${versions.slice(0, 3).join(', ')}${more}` : '';
}

export type EditorParam = { key: string; type: string; required: boolean; note: string; values: string };
export type EditorState = { name: string; trigger: string; params: EditorParam[] };
export type EditorModel = { name: string; purpose: string; states: EditorState[] };

export const blankParam = (): EditorParam => ({ key: '', type: 'string', required: false, note: '', values: '' });
export const blankState = (): EditorState => ({ name: '', trigger: '', params: [] });

/** The editor's model of an event already in the standard (values as the text box shows them). */
export function editorModel(event: CustomEvent | null): EditorModel {
  if (!event) return { name: '', purpose: '', states: [blankState()] };
  return {
    name: event.name,
    purpose: event.purpose,
    states: event.states.map((state) => ({ ...state, params: state.params.map((param) => ({ ...param, values: param.values.join(', ') })) })),
  };
}

/** A new event started from what a game sent: its names and parameters, nothing written yet. */
export function prefillModel(prefill: UnlistedEvent): EditorModel {
  return {
    name: prefill.name,
    purpose: '',
    states: prefill.states.length
      ? prefill.states.map((state) => ({ name: state.name, trigger: '', params: state.params.map((param) => ({ key: param.key, type: param.type, required: param.required, note: '', values: '' })) }))
      : [blankState()],
  };
}

/** The model → the body the server stores. Values are split on commas. */
export function customBody(model: EditorModel): { purpose: string; states: Array<{ name: string; trigger: string; params: Array<{ key: string; type: string; required: boolean; note: string; values: string[] }> }> } {
  return {
    purpose: model.purpose.trim(),
    states: model.states.map((state) => ({
      name: state.name,
      trigger: state.trigger.trim(),
      params: state.params.map((param) => ({ key: param.key, type: param.type, required: param.required, note: param.note.trim(), values: param.values.split(',').map((value) => value.trim()).filter(Boolean) })),
    })),
  };
}
