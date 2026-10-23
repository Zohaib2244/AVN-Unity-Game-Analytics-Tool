// Game-first navigation helpers: a game's address, its platform variants and the grouped games list.
import type { Game, Me, WorkspaceMembership } from './types';

export const gameURL = (game: Pick<Game, 'id'>): string => `/v1/games/${encodeURIComponent(game.id)}`;
export const gamePath = (game: Pick<Game, 'id'>, section = 'overview'): string => `/games/${encodeURIComponent(game.id)}${section === 'overview' ? '' : `/${section}`}`;
export const iconURL = (game: Pick<Game, 'id' | 'icon_updated_at'>): string => `${gameURL(game)}/icon?v=${encodeURIComponent(game.icon_updated_at ?? '')}`;

export const PLATFORM_ORDER = ['android', 'ios'];
export const byPlatform = (a: Game, b: Game): number => (PLATFORM_ORDER.indexOf(a.platform) + 1 || 9) - (PLATFORM_ORDER.indexOf(b.platform) + 1 || 9);
export const sameGame = (a: Pick<Game, 'name'>, b: Pick<Game, 'name'>): boolean => a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
/** The Android and iOS versions of a game, in platform order. */
export const variantsOf = (games: Game[], game: Pick<Game, 'name'>): Game[] => games.filter((item) => sameGame(item, game)).sort(byPlatform);
export const withIcon = (games: Game[]): Game | undefined => games.find((item) => item?.icon_updated_at);
export const initials = (name: string): string => name.slice(0, 2).toUpperCase();

export type GameGroup = {
  name: string; variants: Game[]; primary: Game; events: number; dau_today: number; dau_yesterday: number;
  last_event: string | null; archived: boolean; created_at: string; notes: string;
};
export function gameGroups(games: Game[]): GameGroup[] {
  const groups: Array<{ variants: Game[] }> = [];
  for (const game of games) {
    const group = groups.find((item) => sameGame(item.variants[0]!, game));
    if (group) group.variants.push(game); else groups.push({ variants: [game] });
  }
  return groups.map((group) => {
    const variants = group.variants.sort(byPlatform);
    const live = variants.filter((item) => !item.archived_at);
    return {
      name: variants[0]!.name, variants,
      primary: [...(live.length ? live : variants)].sort((a, b) => (b.events || 0) - (a.events || 0))[0]!,
      events: variants.reduce((sum, item) => sum + (item.events || 0), 0),
      dau_today: variants.reduce((sum, item) => sum + (item.dau_today || 0), 0),
      dau_yesterday: variants.reduce((sum, item) => sum + (item.dau_yesterday || 0), 0),
      last_event: variants.map((item) => item.last_event || '').sort().pop() || null,
      archived: !live.length,
      created_at: variants.map((item) => item.created_at).sort()[0]!,
      notes: variants.find((item) => item.notes)?.notes || '',
    };
  });
}

export const ROLE_LABELS: Record<string, string> = { admin: 'Admin', lead: 'Team lead', member: 'Member' };
export const workspaceRole = (me: Me, workspace: string | null): string => (me.is_admin ? 'admin' : me.workspaces.find((item) => item.id === workspace)?.role || 'member');
export const canManage = (me: Me, workspace: string | null): boolean => me.is_admin || workspaceRole(me, workspace) === 'lead';
export const workspaceName = (workspaces: WorkspaceMembership[], workspace: string | null): string => workspaces.find((item) => item.id === workspace)?.name || '';

/** Sidebar sections of a game, in order; the icon names are from @avn/ui. */
export const GAME_SECTIONS = [
  ['overview', 'grid', 'Overview'], ['funnels', 'funnel', 'Funnels'], ['levels', 'pad', 'Levels'], ['players', 'users', 'Players'],
  ['exports', 'down', 'Exports'], ['dictionary', 'book', 'Event dictionary'], ['event-setup', 'link', 'Event setup'],
  ['keys', 'key', 'API keys'], ['settings', 'sliders', 'Game settings'],
] as const;
export type Section = (typeof GAME_SECTIONS)[number][0];
export const SECTION_TITLES: Record<string, string> = Object.fromEntries(GAME_SECTIONS.map(([key, , label]) => [key, label]));
export const isSection = (value: string): value is Section => GAME_SECTIONS.some(([key]) => key === value);

/** Old addresses: Retention moved into Levels, Mappings into Event setup. */
export const MOVED_SECTIONS: Record<string, Section> = { retention: 'levels', mappings: 'event-setup' };
/** Old workspace-level pages that now live inside a game (?game=…). */
export const LEGACY_PAGES = ['/keys', '/exports', '/dictionary', '/funnels', '/players'];

/** Turns any picked image into a 256×256 PNG (centre-cropped square) before upload. */
export async function iconFromFile(file: File | null | undefined): Promise<Blob> {
  if (!file || !file.type.startsWith('image/')) throw new Error('Choose an image file (PNG, JPEG, WebP or GIF).');
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That image couldn’t be read. Try a PNG or JPEG.'); }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 256, 256);
  bitmap.close?.();
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Couldn’t prepare the image.'))), 'image/png'));
}
