// Where it breaks: the plain logic behind the Performance page (pure, so it is tested without a browser).
import { countryName } from '@/lib/format';
import type { PerformanceDimension, PerformanceFinding, PerformanceReport, PerformanceRow } from '@/lib/types';

type Available = Extract<PerformanceReport, { available: true }>;

export const DIMENSION_ORDER: PerformanceDimension[] = ['country', 'device_tier', 'ram_band', 'os_version', 'device_model'];
export const SHORT_LABELS: Record<PerformanceDimension, string> = { country: 'Country', device_tier: 'Tier', ram_band: 'RAM', os_version: 'OS', device_model: 'Model' };

/** The dimensions that have at least one named group, in a fixed order; a dimension the game sends nothing for is left out. */
export const usable = (report: Available): PerformanceDimension[] => DIMENSION_ORDER.filter((name) => report.dimensions[name]?.available);

/** The dimensions the game sends nothing for, said once: "Tier, RAM". */
export const missing = (report: Available): string[] => DIMENSION_ORDER.filter((name) => !report.dimensions[name]?.available).map((name) => report.dimensions[name]?.label ?? name);

/** A table only keeps a measure's column when some group has data for it. */
export const hasExits = (rows: PerformanceRow[]): boolean => rows.some((row) => row.exit_total > 0);
export const hasAds = (rows: PerformanceRow[]): boolean => rows.some((row) => row.ad_total > 0);

/** Which measures a row is flagged for. */
export const flagged = (row: PerformanceRow, measure: 'bad_exits' | 'ad_failures'): boolean => row.flags.some((flag) => flag.measure === measure);

/** The dimension to open on: the one with the biggest finding, else the first with data. */
export function firstDimension(report: Available): PerformanceDimension {
  const ok = usable(report);
  const top = report.findings.find((finding) => ok.includes(finding.dimension));
  return top?.dimension ?? ok[0] ?? 'country';
}

/** One finding as a title: `Device tier · low`. */
export const findingTitle = (finding: Pick<PerformanceFinding, 'label' | 'value'>): string => `${finding.label} · ${finding.value}`;

export type FindingGroup = { key: string; dimension: PerformanceDimension; label: string; value: string; players: number; sentences: string[]; same_as: string[] };

/** One entry per group, worst first, with a sentence per measure it is worse on, up to `limit` groups. */
export function topFindings(findings: PerformanceFinding[], limit = 5): FindingGroup[] {
  const groups = new Map<string, FindingGroup>();
  for (const finding of findings) {
    const key = `${finding.dimension}:${finding.value}`;
    const found = groups.get(key);
    if (found) {
      found.sentences.push(finding.words);
      for (const other of finding.same_as) if (!found.same_as.includes(other)) found.same_as.push(other);
    }
    else if (groups.size < limit) groups.set(key, { key, dimension: finding.dimension, label: finding.label, value: finding.value, players: finding.players, sentences: [finding.words], same_as: [...finding.same_as] });
  }
  return [...groups.values()];
}

/** Every group that is red somewhere (a low-end phone counts once per way of cutting players up): what the table shows in red. */
export const flaggedGroups = (report: Available): number => DIMENSION_ORDER.reduce((sum, name) => sum + (report.dimensions[name]?.rows.filter((row) => row.flags.length).length ?? 0), 0);

/** A group's name for people: a country code becomes its name, everything else is as sent. */
export const valueName = (dimension: PerformanceDimension, value: string): string => (dimension === 'country' && /^[A-Z]{2}$/.test(value) ? `${countryName(value) || value} (${value})` : value);

/** Too few launches or ads to judge a group: its numbers are shown faint. */
export const few = (total: number, minSample: number): boolean => total > 0 && total < minSample;
