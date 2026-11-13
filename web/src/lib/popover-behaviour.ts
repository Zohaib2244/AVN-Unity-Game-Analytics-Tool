// What every popover (the shared `.pop` of @avn/ui) does, once, for the whole app:
//  - scrolling over it never moves the page behind it (R4.3), unless the popover itself can still scroll that way;
//  - when the page scrolls its trigger out of view the popover closes instead of hanging at the edge (R4.2).
export function installPopoverBehaviour(): () => void {
  const onWheel = (event: WheelEvent) => {
    const target = event.target as HTMLElement | null;
    const pop = target?.closest?.('.pop');
    if (!pop) return;
    for (let el: HTMLElement | null = target; el && pop.contains(el); el = el.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) return;
    }
    event.preventDefault();
  };
  let frame = 0;
  const onScroll = (event: Event) => {
    if ((event.target as HTMLElement | null)?.closest?.('.pop')) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const pop = document.querySelector('.pop');
      if (!pop) return;
      const box = pop.getBoundingClientRect();
      // On a phone the popover is a bottom sheet and stays where it is.
      if (getComputedStyle(pop).bottom === '0px' && window.innerWidth <= 700) return;
      // The trigger is the button that opened it: when that is under the top bar or off the screen, the popover goes too.
      const anchor = document.querySelector('[aria-haspopup][aria-expanded="true"]')?.getBoundingClientRect();
      const away = anchor ? anchor.top < 52 || anchor.top > window.innerHeight - 24 : false;
      if (away || box.top < 48 || box.bottom > window.innerHeight + 1) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
  };
  // A popover that would open below the bottom of the window brings its trigger up instead (the shared one has no flip).
  const keepInView = (pop: Element) => {
    requestAnimationFrame(() => {
      const box = pop.getBoundingClientRect();
      const overflow = box.bottom - (window.innerHeight - 8);
      if (overflow <= 0 || getComputedStyle(pop).bottom === '0px') return;
      const anchor = document.querySelector('[aria-haspopup][aria-expanded="true"]')?.getBoundingClientRect();
      const room = anchor ? Math.max(0, anchor.top - 72) : overflow;
      window.scrollBy({ top: Math.min(overflow + 8, room), behavior: 'instant' });
    });
  };
  const watcher = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => { if (node instanceof Element) { const pop = node.matches('.pop') ? node : node.querySelector('.pop'); if (pop) keepInView(pop); } });
  });
  watcher.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('scroll', onScroll, true);
  return () => { watcher.disconnect(); document.removeEventListener('wheel', onWheel); document.removeEventListener('scroll', onScroll, true); cancelAnimationFrame(frame); };
}
