// Rule R8.4: ad blockers (EasyList, uBlock) hide elements whose class or id looks like an ad, so a
// panel named `.ad-widgets` silently disappears for anyone running one. Ad pages use `money-` names.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ADLIKE = /^(ads?|adv|advert\w*|sponsor\w*|adsense|adunit|adbox|adslot|adbanner)([-_]|$)|[-_](ads?|advert)$/i;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|css)$/.test(name) && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Class and id names from className="…", className={`…`}, id="…" and CSS selectors. */
function names(path: string, text: string): string[] {
  if (path.endsWith('.css')) {
    const selectors = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{[^{}]*\}/g, '{}');
    return [...selectors.matchAll(/[.#](-?[A-Za-z_][\w-]*)/g)].map((match) => match[1]!);
  }
  const out: string[] = [];
  for (const match of text.matchAll(/(?:className|id)=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ');
    out.push(...value.split(/\s+/).filter(Boolean));
  }
  return out;
}

describe('ad blockers', () => {
  it('no class or id name looks like an ad', () => {
    const root = join(__dirname, '..');
    const bad = files(root).flatMap((path) => names(path, readFileSync(path, 'utf8')).filter((name) => ADLIKE.test(name)).map((name) => `${path.slice(root.length + 1)}: ${name}`));
    expect([...new Set(bad)]).toEqual([]);
  });
});
