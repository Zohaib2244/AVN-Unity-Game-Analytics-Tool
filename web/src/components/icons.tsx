// The line icons the pages used before the port (so page markup keeps its icon names); the shell's
// navigation uses @avn/ui's own `Icon` set.
import type { ReactElement, SVGProps } from 'react';

const PATHS: Record<string, string> = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  game: '<path d="M7 8h10c3 0 4 3 4 7s-2 5-4 2l-1-1H8l-1 1c-2 3-4 2-4-2s1-7 4-7Z"/><path d="M8 10v5m-2.5-2.5h5m5-1h.01m2 2h.01"/>',
  key: '<circle cx="8" cy="9" r="5"/><path d="m12 12 9 9m-5-5 3-3m-1 5 3-3"/>',
  export: '<path d="M12 3v12m-4-4 4 4 4-4M4 15v5h16v-5"/>',
  book: '<path d="M12 6c-3-3-7-3-10-2v15c4-1 7-1 10 2 3-3 6-3 10-2V4c-3-1-7-1-10 2Z"/><path d="M12 6v15"/>',
  pulse: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3" fill="currentColor" stroke="none"/><circle cx="15" cy="17" r="3" fill="currentColor" stroke="none"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01m4-11h6m-6 11h6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 11 3 3 5-6"/>',
  logout: '<path d="M10 4H4v16h6m5-12 4 4-4 4m-7-4h13"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v13h5"/>',
  file: '<path d="M14 2H4v20h16V8Z"/><path d="M14 2v6h6M8 13h8m-8 4h5"/>',
  refresh: '<path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  funnel: '<path d="M3 4h18l-7 8v6l-4 2v-8Z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.6 3 5.2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16Z"/><path d="m13 7 4 4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  sparkle: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8Z"/><path d="M19 16v4m-2-2h4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 4v3"/>',
};
export type IcoName = keyof typeof PATHS;

export function Ico({ name, size = 18, ...rest }: { name: IcoName; size?: number } & SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}
      dangerouslySetInnerHTML={{ __html: PATHS[name] || PATHS.grid! }} />
  );
}
