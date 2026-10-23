// Uploading and removing a game's icon (the old `uploadIcon` / `removeIcon`): the icon applies to every
// platform version of the game, so the caller passes the variants it knows about.
import { write } from '@/api';
import { gameURL, iconFromFile } from '@/lib/games';
import type { Game } from '@/lib/types';

export async function uploadIcon(games: Array<Pick<Game, 'id'>>, file: File): Promise<void> {
  const blob = await iconFromFile(file);
  for (const item of games) await write(`${gameURL(item)}/icon`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/png' } });
}

export async function removeIcon(games: Array<Pick<Game, 'id' | 'icon_updated_at'>>): Promise<void> {
  for (const item of games) if (item.icon_updated_at) await write(`${gameURL(item)}/icon`, { method: 'DELETE' });
}

/** A preview URL for the picked image, cropped the way it will be uploaded. */
export async function iconPreview(file: File): Promise<string> {
  return URL.createObjectURL(await iconFromFile(file));
}
