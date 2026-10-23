// The "Player info" view: identity, device, app and location from the player's profile, and an optional
// Wikipedia lookup of the device model (sent only when the button is pressed).
import { useEffect, useState, type ReactElement } from 'react';
import { read } from '@/api';
import { useNotify } from '@/components/feedback';
import { Ico } from '@/components/icons';
import { analysisDate, countryText, platformLabel, propertyLabel, type Timezone } from '@/lib/format';
import { gameURL } from '@/lib/games';
import type { DeviceSpecs, Game, PlayerStory } from '@/lib/types';

export function playerOperatingSystem(raw: unknown, platform: string | null | undefined): { name: string; version: string; build: string } {
  const value = String(raw || '').trim();
  let match = value.match(/^Android(?: OS)?\s+([^ /]+)(?:\s*\/\s*API-(\d+))?(?:\s*\((.*)\))?$/i);
  if (match) return { name: 'Android', version: [match[1], match[2] && `API ${match[2]}`].filter(Boolean).join(' · '), build: match[3] || '' };
  match = value.match(/^(?:iPhone OS|iOS)\s+([^\s(]+)(?:\s*\((.*)\))?$/i);
  if (match) return { name: 'iOS', version: match[1]!, build: match[2] || '' };
  match = value.match(/^Mac OS X\s+([^\s(]+)(?:\s*\((.*)\))?$/i);
  if (match) return { name: 'macOS', version: match[1]!, build: match[2] || '' };
  return { name: platformLabel(platform || '') || '—', version: value, build: '' };
}

export const playerTimezone = (value: unknown): string => {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return value == null ? '' : String(value);
  const sign = minutes < 0 ? '−' : '+';
  return `UTC${sign}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
};

const CATALOG_LABELS: Record<string, string> = { manufacturer: 'Manufacturer', type: 'Device type', released: 'Released', os: 'Original OS', chipset: 'Chipset', cpu: 'CPU', gpu: 'GPU', ram: 'RAM options', storage: 'Storage options', expandable_storage: 'Expandable storage', display: 'Display', battery: 'Battery', dimensions: 'Dimensions', weight: 'Weight', network: 'Network' };

export function DeviceCatalog({ details, loading }: { details: DeviceSpecs | null; loading?: boolean }): ReactElement | null {
  if (loading) return <div className="device-catalog loading">Looking up this model on Wikipedia…</div>;
  if (!details) return null;
  const rows = Object.entries(CATALOG_LABELS).filter(([key]) => details.specs?.[key]);
  return (
    <section className="device-catalog">
      <div className="device-catalog-head"><div><h3>{details.matched_device || details.requested_model}</h3><p>{details.note || ''}</p></div><a className="text-link" href={details.source_url} target="_blank" rel="noopener noreferrer">Wikipedia source <Ico name="arrow" size={12} /></a></div>
      <dl>{rows.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{details.specs![key]}</dd></div>)}</dl>
    </section>
  );
}

type InfoRow = [label: string, value: unknown, mono?: boolean];
/** A group of label/value rows; empty values are left out and an empty group is not shown. */
function Group({ title, rows }: { title: string; rows: InfoRow[] }): ReactElement | null {
  const shown = rows.filter(([, value]) => value != null && value !== '');
  return shown.length ? <section><h3>{title}</h3><dl>{shown.map(([label, value, mono]) => <div key={label}><dt>{label}</dt><dd className={mono ? 'mono' : ''}>{String(value)}</dd></div>)}</dl></section> : null;
}

export function PlayerInformation({ game, player, data, timezone }: { game: Game; player: string; data: PlayerStory; timezone: Timezone }): ReactElement {
  const { toastError } = useNotify();
  const [fetched, setFetched] = useState<DeviceSpecs | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'failed'>('idle');
  useEffect(() => { setFetched(null); setState('idle'); }, [player]);
  const info = data.info || {};
  const profile = info.properties || {};
  const os = playerOperatingSystem(profile.os_version, info.platform);
  const screen = profile.screen_width != null && profile.screen_height != null ? `${profile.screen_width} × ${profile.screen_height}` : '';
  const known = new Set(['seq', 'environment', 'session_number', 'device_model', 'device_type', 'os_version', 'language', 'timezone_offset_minutes', 'screen_width', 'screen_height']);
  const updated = info.updated_at ? `Latest information · ${analysisDate(info.updated_at, timezone)}` : 'No profile information collected';
  const fetchDevice = async () => {
    setState('loading');
    try {
      const device = await read<DeviceSpecs>(`${gameURL(game)}/insights/device-specs?${new URLSearchParams({ player })}`);
      setFetched(device); setState('done');
    } catch (error) { toastError(error); setState('failed'); }
  };
  return (
    <section className="panel player-information">
      <div className="panel-header">
        <div><h2>Player information</h2><p>{updated} · location is IP-derived country{profile.device_model ? ' · lookup sends the device model to Wikipedia only when pressed' : ''}</p></div>
        {profile.device_model ? <button type="button" className="button small-button" disabled={state === 'loading' || state === 'done'} onClick={fetchDevice}>{state === 'idle' ? <><Ico name="search" size={14} /> Fetch device info</> : state === 'loading' ? 'Fetching…' : state === 'done' ? 'Device info fetched' : 'Try device lookup again'}</button> : null}
      </div>
      <div className="player-information-grid">
        <Group title="Identity" rows={[['User ID', info.user_id, true], ['Install ID', info.device_id, true]]} />
        <Group title="Device" rows={[['Model', profile.device_model], ['Type', profile.device_type], ['Operating system', os.name], ['OS version', os.version], ['OS build', os.build, true], ['Screen', screen]]} />
        <Group title="App & location" rows={[['Location', info.country ? countryText(info.country) : ''], ['Language', profile.language], ['Player time zone', playerTimezone(profile.timezone_offset_minutes)], ['Platform', platformLabel(info.platform || '')], ['App version', info.app_version], ['Build', info.build], ['Environment', info.environment], ['Latest session', profile.session_number]]} />
        <Group title="Other collected properties" rows={Object.entries(profile).filter(([key]) => !known.has(key)).map(([key, value]) => [propertyLabel(key), value] as InfoRow)} />
      </div>
      <div id="device-specs-result"><DeviceCatalog details={fetched} loading={state === 'loading'} /></div>
    </section>
  );
}
