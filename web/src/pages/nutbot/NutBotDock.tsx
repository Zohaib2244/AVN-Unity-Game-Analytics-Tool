import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';

/** Move the entire surface together, retaining it until the closing slide finishes. */
export function NutBotDock({ open, className, children }: { open: boolean; className: string; children: ReactNode }): ReactElement {
  return <AnimatePresence>{open ? <SlidingDock key="nutbot" className={className}>{children}</SlidingDock> : null}</AnimatePresence>;
}

function SlidingDock({ className, children }: { className: string; children: ReactNode }): ReactElement {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const dock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { dock.current?.toggleAttribute('inert', !present); }, [present]);
  return (
    <motion.div
      className={className}
      ref={dock}
      aria-hidden={present ? undefined : true}
      initial={reducedMotion ? false : { x: 'calc(100% + 48px)' }}
      animate={{ x: 0 }}
      exit={{ x: 'calc(100% + 48px)' }}
      transition={{ type: 'tween', duration: reducedMotion ? 0 : 0.28, ease: [0.4, 0, 0.2, 1] }}
    >{children}</motion.div>
  );
}
