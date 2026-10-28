// Which model and effort the settings show: only what the agent reported for the signed-in account
// (the server leaves out hidden models), never a remembered choice that is no longer offered.
import type { NutBotEffort, NutBotHarness } from '@/lib/types';

/** The wanted model when the agent offers it, else the listed default, else the agent's own (''). */
export function pickModel(harness: NutBotHarness | null, wanted: string | null | undefined): string {
  const models = harness?.models ?? [];
  if (!models.length) return '';
  if (wanted && models.includes(wanted)) return wanted;
  if (harness?.default_model && models.includes(harness.default_model)) return harness.default_model;
  return models[0]!;
}

/** The effort levels the model offers ('' = the default model); the agent's own "default" row is the empty choice. */
export function effortLevels(harness: NutBotHarness | null, model: string): NutBotEffort[] {
  const key = model || harness?.default_model || '';
  return (harness?.efforts?.[key] ?? []).filter((level) => level.value !== 'default');
}

/** The wanted effort when the model offers it, else '' (leave the agent's default). */
export const pickEffort = (levels: NutBotEffort[], wanted: string | null | undefined): string =>
  wanted && levels.some((level) => level.value === wanted) ? wanted : '';
