// Flavour moments (AVN Family): isometric block piles for empty states, Dora asleep when nothing needs a
// look, the mini PC on the server page, and the boot screen once a day. Fills use classes, never inline styles.
import { BrandMark } from './BrandMark';
import { useEffect, useState, type ReactElement } from 'react';
import { reducedMotion } from '@/app/theme';

export function IsoBlocks(): ReactElement {
  const spots: Array<[number, number, number]> = [[0, 2, 0], [1, 2, 0], [2, 2, 0], [0.5, 1, 1], [1.5, 1, 1], [1, 0, 2]];
  return (
    <svg className="iso" viewBox="10 10 80 50" aria-hidden="true">
      {spots.map(([cx, cy, level], index) => {
        const x = 30 + cx * 20, y = 38 - level * 10 + cy * 0;
        return (
          <g key={index} className={index === spots.length - 1 ? 'top' : ''}>
            <polygon className="t" points={`${x},${y - 5} ${x + 10},${y} ${x},${y + 5} ${x - 10},${y}`} />
            <polygon className="l" points={`${x - 10},${y} ${x},${y + 5} ${x},${y + 15} ${x - 10},${y + 10}`} />
            <polygon className="r" points={`${x},${y + 5} ${x + 10},${y} ${x + 10},${y + 10} ${x},${y + 15}`} />
          </g>
        );
      })}
    </svg>
  );
}

const Px = ({ x, y, w, h, cls }: { x: number; y: number; w: number; h: number; cls: string }) => <rect className={cls} x={x} y={y} width={w} height={h} />;

/** Dora, the black cat with amber eyes, asleep on the monitor: nothing needs you. */
export function DoraScene(): ReactElement {
  return (
    <svg className="scene" viewBox="0 0 40 26" shapeRendering="crispEdges" role="img" aria-label="Dora the black cat asleep on a monitor">
      <Px x={8} y={14} w={24} h={10} cls="sc-frame" /><Px x={9} y={15} w={22} h={8} cls="sc-screen" /><Px x={17} y={24} w={6} h={1} cls="sc-frame" /><Px x={14} y={25} w={12} h={1} cls="sc-frame" />
      <g className="breathe">
        <Px x={11} y={8} w={18} h={6} cls="sc-cat" /><Px x={11} y={5} w={3} h={3} cls="sc-cat" /><Px x={26} y={5} w={3} h={3} cls="sc-cat" /><Px x={12} y={6} w={1} h={1} cls="sc-ear" /><Px x={27} y={6} w={1} h={1} cls="sc-ear" />
        <Px x={14} y={9} w={3} h={1} cls="sc-eye" /><Px x={23} y={9} w={3} h={1} cls="sc-eye" /><Px x={8} y={11} w={4} h={2} cls="sc-cat" />
      </g>
      <Px x={31} y={5} w={2} h={1} cls="sc-z zz" /><Px x={33} y={3} w={2} h={1} cls="sc-z zz zz2" /><Px x={12} y={18} w={1} h={1} cls="sc-ok blink" />
    </svg>
  );
}

export function MiniPC(): ReactElement {
  return (
    <svg className="srv-art" viewBox="0 0 40 22" shapeRendering="crispEdges" role="img" aria-label="Pixel drawing of the mini PC server, power light on">
      <rect className="sc-frame" x={4} y={3} width={32} height={15} /><rect className="sc-screen" x={5} y={4} width={30} height={13} />
      {Array.from({ length: 7 }, (_, index) => (
        <g key={index}><rect className="sc-line" x={9 + index * 3} y={8} width={2} height={1} /><rect className="sc-line" x={9 + index * 3} y={11} width={2} height={1} /></g>
      ))}
      <rect className="sc-ok blink" x={8} y={14} width={1} height={1} /><rect className="sc-line" x={25} y={14} width={7} height={1} />
      <rect className="sc-frame" x={6} y={18} width={4} height={1} /><rect className="sc-frame" x={30} y={18} width={4} height={1} />
    </svg>
  );
}

function Starfield(): ReactElement {
  let seed = 7;
  const next = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const stars = Array.from({ length: 46 }, (_, index) => ({ key: index, cls: `d${Math.floor(next() * 5)}`, x: Math.round(next() * 200), y: Math.round(next() * 120), opacity: (0.3 + next() * 0.6).toFixed(2) }));
  return (
    <svg className="stars" viewBox="0 0 200 120" preserveAspectRatio="xMidYMid slice" shapeRendering="crispEdges" aria-hidden="true">
      {stars.map((star) => <rect key={star.key} className={star.cls} x={star.x} y={star.y} width={1} height={1} opacity={star.opacity} />)}
    </svg>
  );
}

/** The boot screen: the icon builds, the name types in, once a day, never with reduced motion. */
export function BootScreen(): ReactElement | null {
  const [show, setShow] = useState(() => {
    const day = new Date().toISOString().slice(0, 10);
    let seen: string | null = null; try { seen = localStorage.getItem('avn-boot-day'); } catch { /* storage unavailable */ }
    if (seen === day || reducedMotion()) return false;
    try { localStorage.setItem('avn-boot-day', day); } catch { /* storage unavailable */ }
    return true;
  });
  useEffect(() => { if (!show) return; const timer = setTimeout(() => setShow(false), 1750); return () => clearTimeout(timer); }, [show]);
  if (!show) return null;
  return (
    <div className="boot-ov" aria-hidden="true">
      <Starfield />
      <div className="boot-in"><BrandMark className="boot-mark" size={84} /><div className="boot-t">AVN Analytics</div><div className="boot-s">Your games, your data</div></div>
    </div>
  );
}

/** The quiet night: a block horizon, ten stars that twinkle out of step, one slow comet. For a range with no events. */
export function NightScene(): ReactElement {
  const blocks: Array<[number, number, number, number]> = [[0, 19, 6, 5], [6, 17, 5, 7], [11, 20, 7, 4], [18, 18, 4, 6], [22, 21, 8, 3], [30, 16, 5, 8], [35, 19, 6, 5], [41, 21, 3, 3], [6, 15, 1, 2], [30, 14, 1, 2]];
  const stars: Array<[number, number, number]> = [[3, 3, 0], [9, 7, 4], [14, 2, 1], [19, 10, 5], [23, 5, 2], [28, 1, 6], [32, 8, 3], [36, 4, 7], [40, 11, 1], [42, 6, 4]];
  return (
    <svg className="scene night" viewBox="0 0 44 24" shapeRendering="crispEdges" role="img" aria-label="A dark horizon under a starry sky with one slow comet">
      {blocks.map(([x, y, w, h], index) => <Px key={index} x={x} y={y} w={w} h={h} cls="sc-frame" />)}
      <Px x={0} y={23} w={44} h={1} cls="sc-line" />
      {stars.map(([x, y, d], index) => <rect key={index} className="st" x={x} y={y} width={1} height={1} style={{ ['--d' as string]: d }} />)}
      <rect className="cm" x={2} y={2} width={2} height={1} />
    </svg>
  );
}
