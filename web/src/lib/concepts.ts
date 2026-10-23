// The level moments the dashboards understand (the "concepts" an event can be mapped to) and their names.
export const CONCEPT_NAMES: Record<string, string> = { session_start: 'Session start', level_started: 'Level started', level_completed: 'Level completed', level_failed: 'Level failed', level_restarted: 'Level restarted' };
export const conceptName = (key: string): string => CONCEPT_NAMES[key] || String(key).replace(/_/g, ' ');
