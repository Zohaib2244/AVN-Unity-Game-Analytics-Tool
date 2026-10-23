// Flavour moments (AVN Family): isometric block piles for empty states, Dora asleep when nothing needs a look,
// the mini PC on the server page, and the boot screen once a day. Fills use classes, never inline styles (CSP).
const isoBlocks = () => {
  const spots = [[0, 2, 0], [1, 2, 0], [2, 2, 0], [0.5, 1, 1], [1.5, 1, 1], [1, 0, 2]];
  const blocks = spots.map(([cx, cy, level], index) => {
    const x = 30 + cx * 20, y = 38 - level * 10, top = index === spots.length - 1;
    return `<g class="${top ? 'top' : ''}"><polygon class="t" points="${x},${y - 5} ${x + 10},${y} ${x},${y + 5} ${x - 10},${y}"/><polygon class="l" points="${x - 10},${y} ${x},${y + 5} ${x},${y + 15} ${x - 10},${y + 10}"/><polygon class="r" points="${x},${y + 5} ${x + 10},${y} ${x + 10},${y + 10} ${x},${y + 15}"/></g>`;
  }).join('');
  return `<svg class="iso" viewBox="10 10 80 50" aria-hidden="true">${blocks}</svg>`;
};

// Dora, the black cat with amber eyes, asleep on the monitor: nothing needs you.
const doraScene = () => {
  const px = (x, y, w, h, cls) => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
  return `<svg class="scene" viewBox="0 0 40 26" shape-rendering="crispEdges" role="img" aria-label="Dora the black cat asleep on a monitor">
    ${px(8, 14, 24, 10, 'sc-frame')}${px(9, 15, 22, 8, 'sc-screen')}${px(17, 24, 6, 1, 'sc-frame')}${px(14, 25, 12, 1, 'sc-frame')}
    <g class="breathe">${px(11, 8, 18, 6, 'sc-cat')}${px(11, 5, 3, 3, 'sc-cat')}${px(26, 5, 3, 3, 'sc-cat')}${px(12, 6, 1, 1, 'sc-ear')}${px(27, 6, 1, 1, 'sc-ear')}${px(14, 9, 3, 1, 'sc-eye')}${px(23, 9, 3, 1, 'sc-eye')}${px(8, 11, 4, 2, 'sc-cat')}</g>
    ${px(31, 5, 2, 1, 'sc-z zz')}${px(33, 3, 2, 1, 'sc-z zz zz2')}${px(12, 18, 1, 1, 'sc-ok blink')}</svg>`;
};

const miniPC = () => {
  const vents = Array.from({length: 7}, (_, index) => `<rect class="sc-line" x="${9 + index * 3}" y="8" width="2" height="1"/><rect class="sc-line" x="${9 + index * 3}" y="11" width="2" height="1"/>`).join('');
  return `<svg class="srv-art" viewBox="0 0 40 22" shape-rendering="crispEdges" role="img" aria-label="Pixel drawing of the mini PC server, power light on"><rect class="sc-frame" x="4" y="3" width="32" height="15"/><rect class="sc-screen" x="5" y="4" width="30" height="13"/>${vents}<rect class="sc-ok blink" x="8" y="14" width="1" height="1"/><rect class="sc-line" x="25" y="14" width="7" height="1"/><rect class="sc-frame" x="6" y="18" width="4" height="1"/><rect class="sc-frame" x="30" y="18" width="4" height="1"/></svg>`;
};

const starfield = () => {
  let seed = 7;
  const next = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const stars = Array.from({length: 46}, () => `<rect class="d${Math.floor(next() * 5)}" x="${Math.round(next() * 200)}" y="${Math.round(next() * 120)}" width="1" height="1" opacity="${(0.3 + next() * 0.6).toFixed(2)}"/>`).join('');
  return `<svg class="stars" viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice" shape-rendering="crispEdges" aria-hidden="true">${stars}</svg>`;
};

// The boot screen: the icon builds, the name types in, once a day, never with reduced motion.
function bootScreen() {
  const day = new Date().toISOString().slice(0, 10);
  let seen = null; try { seen = localStorage.getItem('avn-boot-day'); } catch { /* storage unavailable */ }
  if (seen === day || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try { localStorage.setItem('avn-boot-day', day); } catch { /* storage unavailable */ }
  const overlay = document.createElement('div');
  overlay.className = 'boot-ov'; overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `${starfield()}<div class="boot-in"><img class="boot-mark" src="/assets/icons/avn-analytics.svg" alt="" width="84" height="84"><div class="boot-t">AVN Analytics</div><div class="boot-s">Your games, your data</div></div>`;
  document.body.append(overlay);
  setTimeout(() => overlay.remove(), 1750);
}
