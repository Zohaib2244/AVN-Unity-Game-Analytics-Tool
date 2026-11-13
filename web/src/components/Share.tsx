// A percentage always shows what it is a share of: the count (players, sessions, events) or the money first,
// muted, then the percentage in the number face, so a column of shares still lines up. The tooltip says it whole.
// One component for the whole site (rules.md R2.4): never a bare percentage.
import type { ReactElement } from 'react';
import { number, percentFixed } from '@/lib/format';

export type ShareUnit = 'players' | 'sessions' | 'events' | 'installs' | 'launches' | 'ads' | 'returns' | 'usd';

const SINGULAR: Record<ShareUnit, string> = { players: 'player', sessions: 'session', events: 'event', installs: 'install', launches: 'launch', ads: 'ad', returns: 'return', usd: '' };
const money = (value: number): string => `$${value.toLocaleString(undefined, { minimumFractionDigits: value < 100 ? 2 : 0, maximumFractionDigits: value < 100 ? 2 : 0 })}`;
const amount = (value: number, unit: ShareUnit): string => (unit === 'usd' ? money(value) : number(value));
const noun = (value: number, unit: ShareUnit): string => (unit === 'usd' ? '' : ` ${value === 1 ? SINGULAR[unit] : unit}`);

/** `part` of `whole` as a share; `percent` when the share is worked out elsewhere (it wins over part ÷ whole). */
export function Share({ part, whole, percent, unit = 'players', label, className }: { part: number; whole?: number | null; percent?: number | null; unit?: ShareUnit; /** Shown in place of the count, e.g. a duration. */ label?: string; className?: string }): ReactElement {
  const share = percent ?? (whole ? (100 * part) / whole : null);
  const title = label ? label : whole != null ? `${amount(part, unit)} of ${amount(whole, unit)}${noun(whole, unit)}` : `${amount(part, unit)}${noun(part, unit)}`;
  return (
    <span className={`share${className ? ` ${className}` : ''}`} title={share == null ? title : `${title} · ${percentFixed(share)}`}>
      <span className="share-n">{label ?? amount(part, unit)}</span>
      <span className="share-p">{share == null ? '—' : percentFixed(share)}</span>
    </span>
  );
}
