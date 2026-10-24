// Coming back to the level list from a level's page: the list is drawn again from scratch, so the place the person
// was at (how far down, which page of levels) is kept here and put back once the rows exist. Without it the page
// opens at the top and the level they just looked at is out of sight. Only used for that one trip: leaving the
// levels section, or any later visit, starts at the top as usual.
type Spot = { y: number; page: number };
const spots = new Map<string, Spot>();
const away = new Set<string>();

/** The list was at `spot` when a click happened inside it (the click may open a level). */
export const rememberSpot = (game: string, spot: Spot): void => { spots.set(game, spot); };
/** A level's page is open for this game, so the next list that appears is a return. */
export const leftForLevel = (game: string): void => { away.add(game); };
/** Where the list was before a level was opened, or null when this list is not a return from one. */
export const returnSpot = (game: string): Spot | null => (away.has(game) ? spots.get(game) ?? null : null);
export const forgetSpot = (game: string): void => { spots.delete(game); away.delete(game); };

/** Scrolls to `y` once the page is tall enough to reach it (rows arrive after the first paint), or as far as it gets. */
export function scrollBackTo(y: number, frames = 40): () => void {
  let tries = 0; let frame = 0;
  const go = () => {
    const room = document.documentElement.scrollHeight - window.innerHeight;
    if (room >= y - 2 || tries++ >= frames) { window.scrollTo({ top: Math.max(0, Math.min(y, room)), behavior: 'instant' as ScrollBehavior }); return; }
    frame = requestAnimationFrame(go);
  };
  go();
  return () => cancelAnimationFrame(frame);
}
