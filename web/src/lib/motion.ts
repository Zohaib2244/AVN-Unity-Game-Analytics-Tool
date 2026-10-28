// Shared motion: one spring and one ease so everything moves alike. Opacity and transform only, once, and
// <MotionConfig reducedMotion="user"> (app/App.tsx) turns transforms off for people who ask for less motion.
import type { Transition } from 'motion/react';

export const SPRING: Transition = { type: 'spring', stiffness: 460, damping: 34, mass: 0.8 };
export const SOFT: Transition = { type: 'spring', stiffness: 260, damping: 30 };
export const EASE: Transition = { duration: 0.2, ease: [0.2, 0.8, 0.2, 1] };
/** A chip, tag or row that arrives and leaves. */
export const POP = { initial: { opacity: 0, scale: 0.86 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.86 }, transition: SPRING } as const;
/** Content that swaps in place (a tab's list, a view): a short fade with a 4 px settle. */
export const SWAP = { initial: { opacity: 0, y: 4 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0 }, transition: { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] } } as const;
/** Blocks that rise in one after another (50 ms apart, as in the motion rules). */
export const rise = (index: number) => ({ initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { ...EASE, duration: 0.28, delay: Math.min(index, 8) * 0.05 } }) as const;
